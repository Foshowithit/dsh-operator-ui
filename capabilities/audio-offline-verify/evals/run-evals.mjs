#!/usr/bin/env node
'use strict';
// Eval runner for audio-offline-verify (container-sounds).
//
// Runs adapter/run.js against evals/cases.json, judges the gates declared in
// evals/expectations.json against the observation the adapter wrote, and
// records a run receipt with a real UUID run id. Evidence files land in
// eval/records/ (gitignored run workspace); the receipt itself is sanitized
// (home paths -> '~') so it can be committed without leaking machine paths.
//
// Usage:
//   node evals/run-evals.mjs                  positive run (verdict must be PASS)
//   node evals/run-evals.mjs --negative-control
//     applies expectations.negative_control.mutate to the input; the run MUST
//     then FAIL with the named gates failing. Exit 0 means the falsification
//     behaved as required; exit 1 means it did not.
//
// Exit codes: 0 = expectation met (PASS in positive mode, falsified in
// negative-control mode), 1 = expectation not met, 4 = could not run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const evalsDir = path.dirname(fileURLToPath(import.meta.url));
const capDir = path.resolve(evalsDir, '..');
const repoRoot = path.resolve(capDir, '..', '..');

const args = process.argv.slice(2);
const negativeControl = args.includes('--negative-control');
const runIdArgIdx = args.indexOf('--run-id');
const runId = runIdArgIdx !== -1 ? args[runIdArgIdx + 1] : crypto.randomUUID();

const cases = JSON.parse(fs.readFileSync(path.join(evalsDir, 'cases.json'), 'utf8'));
const expectations = JSON.parse(fs.readFileSync(path.join(evalsDir, 'expectations.json'), 'utf8'));
const adapterPath = path.join(capDir, 'adapter', 'run.js');
const checkerPath = path.join(capDir, 'adapter', 'av_check.py');

const startedAt = new Date().toISOString();

// ---- tool resolution (the ported checker resolves via env/PATH; make the
// resolution explicit and part of the receipt instead of ambient luck) ----
function resolveTool(name, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const cand = path.join(dir, name);
    try {
      fs.accessSync(cand, fs.constants.X_OK);
      return cand;
    } catch { /* keep looking */ }
  }
  const fallback = path.join(os.homedir(), 'homebrew', 'bin', name);
  if (fs.existsSync(fallback)) return fallback;
  return null;
}
const ffprobe = resolveTool('ffprobe', 'AV_CHECK_FFPROBE');
const ffmpeg = resolveTool('ffmpeg', 'AV_CHECK_FFMPEG');
const python3 = resolveTool('python3', 'AV_CHECK_PYTHON');
if (!ffprobe || !ffmpeg) {
  console.error('could not resolve ffprobe/ffmpeg (set AV_CHECK_FFPROBE / AV_CHECK_FFMPEG)');
  process.exit(4);
}

// ---- run workspace: eval/records/ is gitignored in this repo ----
const runDir = path.join(repoRoot, 'eval', 'records', 'audio-offline-verify-' + runId);
const evidenceDir = path.join(runDir, 'evidence');
fs.mkdirSync(evidenceDir, { recursive: true });

// ---- input document: cases.json paths are evals-relative; the adapter wants
// paths it can resolve from any cwd ----
const probes = cases.probes.map((p) => ({
  ...p,
  file: path.resolve(evalsDir, p.file)
}));
if (negativeControl) {
  const nc = expectations.negative_control;
  const target = probes.find((p) => p.name === nc.mutate.probe);
  if (!target) {
    console.error('negative control names unknown probe: ' + nc.mutate.probe);
    process.exit(4);
  }
  Object.assign(target, nc.mutate.set);
}
const inputPath = path.join(runDir, 'input.json');
const outputPath = path.join(runDir, 'observation.json');
fs.writeFileSync(inputPath, JSON.stringify({ probes }, null, 2) + '\n');

// ---- run the adapter ----
const env = {
  ...process.env,
  RCOS_INPUT: inputPath,
  RCOS_OUTPUT: outputPath,
  RCOS_EVIDENCE_DIR: evidenceDir,
  RCOS_HOME: repoRoot,
  AV_CHECK_FFPROBE: ffprobe,
  AV_CHECK_FFMPEG: ffmpeg
};
const adapterRun = spawnSync(process.execPath, [adapterPath], { env, encoding: 'utf8' });
const adapterExit = typeof adapterRun.status === 'number' ? adapterRun.status : null;
if (adapterExit !== 0 || !fs.existsSync(outputPath)) {
  console.error('adapter did not produce an observation (exit ' + String(adapterExit) + ')');
  if (adapterRun.stderr) console.error(adapterRun.stderr.trim().slice(0, 2000));
  process.exit(4);
}
const O = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

// ---- helpers ----
function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function probe(name) { return O.probes.find((p) => p.name === name) || null; }
function near(a, b, tol) { return typeof a === 'number' && Math.abs(a - b) <= tol; }
function containerProblems(p, want, label) {
  const problems = [];
  const o = p.observed;
  if (want.duration !== undefined && o.container_duration_s !== want.duration) problems.push(label + ' duration ' + o.container_duration_s + ' (want ' + want.duration + ')');
  if (want.w !== undefined && o.video_width !== want.w) problems.push(label + ' width ' + o.video_width + ' (want ' + want.w + ')');
  if (want.h !== undefined && o.video_height !== want.h) problems.push(label + ' height ' + o.video_height + ' (want ' + want.h + ')');
  if (want.audio !== undefined && o.audio_codec !== want.audio) problems.push(label + ' audio codec ' + o.audio_codec + ' (want ' + want.audio + ')');
  if (want.rate !== undefined && o.audio_sample_rate !== want.rate) problems.push(label + ' sample rate ' + o.audio_sample_rate + ' (want ' + want.rate + ')');
  if (want.ch !== undefined && o.audio_channels !== want.ch) problems.push(label + ' channels ' + o.audio_channels + ' (want ' + want.ch + ')');
  return problems;
}
const F = expectations.container_facts;
const TOL = expectations.pins.rms_tolerance_db;

// ---- gates (claim by claim; prose mirrors the source eval's gate language) ----
const checks = {
  checker_revision_pinned() {
    const problems = [];
    if (O.checker.sha256 !== expectations.pins.checker_sha256) {
      problems.push('checker sha256 ' + O.checker.sha256 + ' is not the ported revision pinned in expectations.json (' + expectations.pins.checker_sha256.slice(0, 16) + '…)');
    }
    const observedPath = O.checker.path;
    const expectedRel = 'capabilities/audio-offline-verify/adapter/av_check.py';
    if (observedPath !== expectedRel && observedPath !== checkerPath) {
      problems.push('observation names checker at ' + observedPath + ', not ' + expectedRel);
    }
    return {
      ok: problems.length === 0,
      detail: problems.length ? problems.join(' | ')
        : 'observation.checker.sha256 matches the ported checker (' + expectations.pins.checker_sha256.slice(0, 16) + '…, upstream lineage ' + expectations.pins.upstream_checker_sha256.slice(0, 16) + '…)'
    };
  },

  fixture_identity_pinned() {
    const problems = [];
    for (const [name, pin] of Object.entries(expectations.pins.fixtures)) {
      const p = path.join(evalsDir, 'fixtures', name);
      if (!fs.existsSync(p)) { problems.push(name + ' missing from evals/fixtures'); continue; }
      const bytes = fs.statSync(p).size;
      const sha = sha256File(p);
      if (sha !== pin.sha256) problems.push(name + ' sha256 ' + sha.slice(0, 16) + '… != pinned ' + pin.sha256.slice(0, 16) + '…');
      if (bytes !== pin.bytes) problems.push(name + ' bytes ' + bytes + ' != pinned ' + pin.bytes);
    }
    return {
      ok: problems.length === 0,
      detail: problems.length ? problems.join(' | ')
        : Object.keys(expectations.pins.fixtures).length + ' fixtures match their pinned sha256 + bytes'
    };
  },

  evidence_recorded() {
    const problems = [];
    for (const p of O.probes) {
      for (const suffix of ['.stdout.txt', '.stderr.txt', '.argv.json']) {
        const f = path.join(evidenceDir, 'probe-' + p.name + suffix);
        if (!fs.existsSync(f)) problems.push('missing evidence file for ' + p.name + ': ' + path.basename(f));
      }
      const stdoutFile = path.join(evidenceDir, 'probe-' + p.name + '.stdout.txt');
      if (fs.existsSync(stdoutFile) && fs.readFileSync(stdoutFile, 'utf8') !== p.stdout) {
        problems.push(p.name + ': recorded stdout does not match the evidence copy');
      }
    }
    if (!fs.existsSync(path.join(evidenceDir, 'checker.sha256'))) problems.push('missing checker.sha256 evidence');
    return {
      ok: problems.length === 0,
      detail: problems.length ? problems.join(' | ')
        : 'raw stdout/stderr/argv per probe + checker.sha256 recorded beside the observation'
    };
  },

  voiced_passes() {
    const problems = [];
    for (const [name, want] of [['chalk2_voiced', F.chalk2], ['chalk1_voiced', F.chalk1]]) {
      const p = probe(name);
      if (!p) { problems.push('probe ' + name + ' missing'); continue; }
      if (p.exit_status !== 0) problems.push(name + ': exit ' + p.exit_status + ' (want 0)');
      if (p.outcome !== 'passed') problems.push(name + ': outcome ' + p.outcome);
      if (p.observed.pass_marker !== true) problems.push(name + ': the checker did not print AV_CHECK_PASS');
      if (p.observed.fail_lines.length > 0) problems.push(name + ': fail lines ' + JSON.stringify(p.observed.fail_lines));
      if (!p.argv.includes('--audio-must-sound')) problems.push(name + ': must-sound was not passed, so the pass is not the evaluated claim');
      if (typeof p.observed.rms_dbfs !== 'number') problems.push(name + ': RMS not a number (' + p.observed.rms_token + ') — a must-sound pass needs a reading');
      else if (!near(p.observed.rms_dbfs, want.rms, TOL)) problems.push(name + ': RMS ' + p.observed.rms_dbfs + ' vs pinned ' + want.rms + ' (tolerance ' + TOL + ' dB)');
      else if (p.observed.rms_dbfs < -60) problems.push(name + ': RMS ' + p.observed.rms_dbfs + ' is below the -60 floor yet passed');
      problems.push(...containerProblems(p, want, name));
    }
    return {
      ok: problems.length === 0,
      detail: problems.length ? problems.join(' | ')
        : 'chalk-eval2 ' + F.chalk2.rms + ' dBFS / chalk-eval1 ' + F.chalk1.rms + ' dBFS, both must-sound, both AV_CHECK_PASS'
    };
  },

  envelope_gate_bites() {
    const p = probe('chalk2_wrong_envelope');
    const paired = probe('chalk2_voiced');
    if (!p || !paired) return { ok: false, detail: 'probe chalk2_wrong_envelope or chalk2_voiced missing' };
    const problems = [];
    if (p.exit_status !== 3) problems.push('exit ' + p.exit_status + ' (want 3)');
    if (p.observed.pass_marker === true) problems.push('the checker reported PASS outside the envelope');
    if (p.observed.fail_lines.length !== 1) problems.push('fail lines ' + JSON.stringify(p.observed.fail_lines) + ' (want exactly one)');
    else if (!/^DURATION 3\.000 outside \[3\.5, 4\.5\]$/.test(p.observed.fail_lines[0])) {
      problems.push('fail line is not the authored envelope rejection: ' + JSON.stringify(p.observed.fail_lines[0]));
    }
    if (p.observed.container_duration_s !== F.chalk2.duration) problems.push('the file under test is not the 3.000s chalk mux');
    if (paired.exit_status !== 0) problems.push('the same file did not pass in its authoring envelope, so the catch is not attributable to the envelope');
    if (p.file !== paired.file) problems.push('the two probes did not read the same file');
    return {
      ok: problems.length === 0,
      detail: problems.length ? problems.join(' | ')
        : 'exit 3 on ' + p.observed.fail_lines[0] + '; the identical bytes exit 0 inside the envelope'
    };
  },

  silence_reported_not_asserted() {
    const p = probe('face_silent_report');
    if (!p) return { ok: false, detail: 'probe face_silent_report missing' };
    const problems = [];
    if (p.exit_status !== 0) problems.push('exit ' + p.exit_status + ' (want 0: report-only is a pass)');
    if (p.observed.pass_marker !== true) problems.push('the checker did not print AV_CHECK_PASS');
    if (p.observed.fail_lines.length > 0) problems.push('fail lines ' + JSON.stringify(p.observed.fail_lines));
    if (p.argv.includes('--audio-must-sound')) problems.push('must-sound was passed, so this probe does not exercise report-only');
    if (p.observed.rms_token !== '-inf') problems.push('rms token ' + JSON.stringify(p.observed.rms_token) + ' (want the string -inf)');
    if (p.observed.rms_dbfs !== null) problems.push('rms_dbfs ' + p.observed.rms_dbfs + ' (want null: -inf is not a number)');
    if (!/^audio RMS -inf dBFS$/m.test(p.stdout)) problems.push('the checker did not report the RMS it measured');
    problems.push(...containerProblems(p, F.face, 'face'));
    return {
      ok: problems.length === 0,
      detail: problems.length ? problems.join(' | ')
        : 'exit 0 on a silent file with RMS -inf reported and not asserted (must-sound absent from argv)'
    };
  },

  mute_caught() {
    const p = probe('face_silent_must_sound');
    const paired = probe('face_silent_report');
    if (!p || !paired) return { ok: false, detail: 'probe face_silent_must_sound or face_silent_report missing' };
    const problems = [];
    if (p.exit_status !== 3) problems.push('exit ' + p.exit_status + ' (want 3)');
    if (p.observed.pass_marker === true) problems.push('the checker reported PASS on a silent track with must-sound on');
    if (!p.argv.includes('--audio-must-sound')) problems.push('must-sound was not passed');
    if (p.observed.fail_lines.length !== 1) problems.push('fail lines ' + JSON.stringify(p.observed.fail_lines) + ' (want exactly one)');
    else if (!/^MUST_SOUND but RMS (None|-inf) dBFS below -60 floor \(silent track\)$/.test(p.observed.fail_lines[0])) {
      problems.push('fail line is not the floor rejection: ' + JSON.stringify(p.observed.fail_lines[0]));
    }
    if (p.observed.rms_token !== '-inf') problems.push('rms token ' + JSON.stringify(p.observed.rms_token) + ' (the run must record the reading it rejected)');
    if (paired.exit_status !== 0) problems.push('the report-only twin did not pass, so this is not the same-file assertion flip');
    if (p.file !== paired.file) problems.push('the two probes did not read the same file');
    return {
      ok: problems.length === 0,
      detail: problems.length ? problems.join(' | ')
        : 'exit 3 with "' + p.observed.fail_lines[0] + '" while the identical bytes exit 0 report-only: the assertion, not the file, caught it'
    };
  },

  absence_asserted_not_assumed() {
    const p = probe('dispatch_absent_expect_none');
    const q = probe('dispatch_absent_must_sound');
    if (!p || !q) return { ok: false, detail: 'probe dispatch_absent_expect_none or dispatch_absent_must_sound missing' };
    const problems = [];
    if (p.exit_status !== 0) problems.push('expect-none: exit ' + p.exit_status + ' (want 0)');
    if (p.observed.pass_marker !== true) problems.push('expect-none: the checker did not print AV_CHECK_PASS');
    if (p.observed.fail_lines.length > 0) problems.push('expect-none: fail lines ' + JSON.stringify(p.observed.fail_lines));
    const op = p.argv.indexOf('--expect-audio');
    if (op === -1 || p.argv[op + 1] !== 'none') problems.push('expect-none: --expect-audio none was not passed');
    if (p.observed.audio_codec !== null) problems.push('expect-none: audio codec ' + p.observed.audio_codec + ' (want null: no audio stream)');
    if (/^audio RMS /m.test(p.stdout)) problems.push('expect-none: an RMS line was printed for a file with no audio stream');
    problems.push(...containerProblems(p, F.dispatch, 'dispatch'));

    if (q.exit_status !== 3) problems.push('must-sound: exit ' + q.exit_status + ' (want 3)');
    if (q.observed.pass_marker === true) problems.push('must-sound: the checker reported PASS');
    if (q.observed.fail_lines.length !== 1) problems.push('must-sound: fail lines ' + JSON.stringify(q.observed.fail_lines) + ' (want exactly one)');
    else if (q.observed.fail_lines[0] !== 'MUST_SOUND but no audio stream') {
      problems.push('must-sound: fail line is not the missing-stream rejection: ' + q.observed.fail_lines[0]);
    }
    if (q.argv.includes('--expect-audio')) problems.push('must-sound: the historical attack passed no --expect-audio, so this probe no longer reproduces it');
    return {
      ok: problems.length === 0,
      detail: problems.length ? problems.join(' | ')
        : 'declared absence passes (no audio stream, no RMS line); claimed sound from the same bytes fails "MUST_SOUND but no audio stream"'
    };
  }
};

const gates = expectations.gates.map((id) => {
  const fn = checks[id];
  if (!fn) return { id, pass: false, detail: 'gate not implemented in this runner' };
  const r = fn();
  return { id, pass: r.ok, detail: r.detail };
});
const verdict = gates.every((g) => g.pass) ? 'PASS' : 'FAIL';

// ---- negative-control judgment: the mutated run MUST fail the named gates ----
let negativeControlResult = null;
if (negativeControl) {
  const nc = expectations.negative_control;
  const named = nc.must_fail_gates.map((id) => gates.find((g) => g.id === id)).filter(Boolean);
  const allNamedFailed = named.length === nc.must_fail_gates.length && named.every((g) => !g.pass);
  const falsified = verdict === nc.must_verdict && allNamedFailed;
  negativeControlResult = {
    mutate: nc.mutate,
    must_verdict: nc.must_verdict,
    must_fail_gates: nc.must_fail_gates,
    observed_verdict: verdict,
    observed_named_gate_pass: Object.fromEntries(named.map((g) => [g.id, g.pass])),
    outcome: falsified ? 'falsified-as-required' : 'NOT-FALSIFIED (eval is too permissive or the wrong gate flipped)'
  };
}

// ---- receipt (sanitized: home directory prefix -> '~') ----
const finishedAt = new Date().toISOString();
const receipt = {
  schema: 'capability-run-receipt/1',
  capability: 'audio-offline-verify',
  runId,
  mode: negativeControl ? 'negative-control' : 'positive',
  startedAt,
  finishedAt,
  runner: {
    command: 'node capabilities/audio-offline-verify/evals/run-evals.mjs' + (negativeControl ? ' --negative-control' : ''),
    node: process.version,
    platform: process.platform + ' ' + process.arch
  },
  tools: { ffprobe, ffmpeg, python3: python3 || 'python3 (from PATH)' },
  adapter: {
    command: 'node adapter/run.js',
    exit_code: adapterExit,
    sha256: sha256File(adapterPath),
    output: (adapterRun.stdout || '').trim()
  },
  checker: {
    path: O.checker.path,
    sha256: O.checker.sha256,
    documented_exit_codes: O.checker.documented_exit_codes
  },
  probes: O.probes.map((p) => ({
    name: p.name,
    exit_status: p.exit_status,
    outcome: p.outcome,
    rms_token: p.observed.rms_token,
    fail_lines: p.observed.fail_lines,
    pass_marker: p.observed.pass_marker,
    duration_ms: p.duration_ms
  })),
  gates,
  verdict,
  caseResults: gates.map((g) => ({ caseId: g.id, runId, pass: g.pass })),
  negativeControl: negativeControlResult
};

const home = os.homedir();
const sanitized = JSON.stringify(receipt, null, 2).split(home).join('~') + '\n';
const receiptPath = path.join(evalsDir, 'runs', runId + '.json');
fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
fs.writeFileSync(receiptPath, sanitized);
fs.writeFileSync(path.join(runDir, 'receipt.json'), sanitized);

console.log('run ' + runId + ' (' + receipt.mode + ') verdict ' + verdict);
for (const g of gates) console.log('  ' + (g.pass ? 'PASS' : 'FAIL') + '  ' + g.id + ' — ' + g.detail);
if (negativeControlResult) console.log('negative control: ' + negativeControlResult.outcome);
console.log('receipt: ' + path.relative(repoRoot, receiptPath));
console.log('evidence: ' + path.relative(repoRoot, runDir));

if (negativeControl) {
  process.exit(negativeControlResult.outcome === 'falsified-as-required' ? 0 : 1);
}
process.exit(verdict === 'PASS' ? 0 : 1);
