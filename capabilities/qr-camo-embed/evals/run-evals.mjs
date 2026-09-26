#!/usr/bin/env node
'use strict';
// Eval runner for qr-camo-embed (grounding).
//
// Port of eval qr-camo-embed-grounding-v1: runs adapter/run.js against
// evals/cases.json, judges the 14 gates declared in evals/expectations.json
// against the observation the adapter wrote AND the evidence the run left
// behind, and records a run receipt with a real UUID run id. Gate logic and
// pin values are carried over from the upstream gates/check.js; the paths are
// worktree-relative (no absolute machine paths in committed bytes).
//
// Where a gate needs pixels it re-measures them through the pinned helpers in
// evals/helpers/ (measure_blend.py, stress_ladder.py, decode_controls.py),
// spawned through the same interpreter the cases recorded.
//
// Usage:
//   node evals/run-evals.mjs                  positive run (verdict must be PASS)
//   node evals/run-evals.mjs --negative-control
//     applies expectations.negative_control.mutate to the request; the run MUST
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
const helpersDir = path.join(evalsDir, 'helpers');
const fixturesDir = path.join(evalsDir, 'fixtures');

const args = process.argv.slice(2);
const negativeControl = args.includes('--negative-control');
const runIdArgIdx = args.indexOf('--run-id');
const runId = runIdArgIdx !== -1 ? args[runIdArgIdx + 1] : crypto.randomUUID();

const casesSpec = JSON.parse(fs.readFileSync(path.join(evalsDir, 'cases.json'), 'utf8'));
const expectations = JSON.parse(fs.readFileSync(path.join(evalsDir, 'expectations.json'), 'utf8'));
const PIN = expectations.pins;
const STDOUT = expectations.stdout;
const adapterPath = path.join(capDir, 'adapter', 'run.js');
const scriptPath = path.join(capDir, 'adapter', 'make_header_v2.py');
const contractPath = path.join(capDir, 'contract.json');

const startedAt = new Date().toISOString();

// ---- interpreter resolution: same order the adapter documents ----
function resolveInterpreter() {
  const candidates = [];
  if (process.env.RCOS_QR_PYTHON) candidates.push(process.env.RCOS_QR_PYTHON);
  candidates.push(path.join(repoRoot, '.venv-qr312', 'bin', 'python'));
  candidates.push(path.join(repoRoot, 'evidence', 'qr-venv', 'bin', 'python'));
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* keep looking */ }
  }
  return null;
}
const pythonBin = resolveInterpreter();
if (!pythonBin) {
  console.error('no usable interpreter: set RCOS_QR_PYTHON or provide .venv-qr312/bin/python at the repo root');
  process.exit(4);
}

// ---- run workspace: eval/records/ is gitignored in this repo ----
const runDir = path.join(repoRoot, 'eval', 'records', 'qr-camo-embed-' + runId);
const workDir = path.join(runDir, 'work');
const evidenceDir = path.join(runDir, 'evidence');
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(evidenceDir, { recursive: true });

// ---- the capability request: cases.json sources are evals-relative ----
const requestCases = casesSpec.cases.map((c) => ({
  ...c,
  source: path.resolve(evalsDir, c.source)
}));
if (negativeControl) {
  const nc = expectations.negative_control;
  const target = requestCases.find((c) => c.name === nc.mutate.case);
  if (!target) {
    console.error('negative control names unknown case: ' + nc.mutate.case);
    process.exit(4);
  }
  Object.assign(target, nc.mutate.set);
}
const inputPath = path.join(runDir, 'input.json');
const outputPath = path.join(runDir, 'observation.json');
fs.writeFileSync(inputPath, JSON.stringify({ cases: requestCases }, null, 2) + '\n');

function sha256Buf(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256File(p) { return sha256Buf(fs.readFileSync(p)); }

// The run's own identity record: which eval revision, which fixtures, which
// request bytes were consumed. artifact_identity_pinned judges against it.
const runInputPath = path.join(runDir, 'run-input.json');
fs.writeFileSync(runInputPath, JSON.stringify({
  schema: 'qr-camo-embed-run-input/1',
  eval_id: 'qr-camo-embed-grounding-v1',
  eval_variant: 'port',
  capability_id: 'qr-camo-embed',
  cases_sha256: sha256File(path.join(evalsDir, 'cases.json')),
  expectations_sha256: sha256File(path.join(evalsDir, 'expectations.json')),
  fixtures: Object.entries(expectations.fixtures).map(([name, pin]) => ({ name, sha256: pin.sha256, bytes: pin.bytes })),
  capability_input: { path: 'input.json', sha256: sha256File(inputPath) }
}, null, 2) + '\n');

// ---- run the adapter ----
const env = {
  ...process.env,
  RCOS_INPUT: inputPath,
  RCOS_OUTPUT: outputPath,
  RCOS_EVIDENCE_DIR: evidenceDir,
  RCOS_HOME: repoRoot,
  RCOS_INVOCATION_WORK_DIR: workDir,
  RCOS_QR_PYTHON: pythonBin
};
const adapterRun = spawnSync(process.execPath, [adapterPath], { env, encoding: 'utf8', timeout: 600000 });
const adapterExit = typeof adapterRun.status === 'number' ? adapterRun.status : null;
if (adapterExit !== 0 || !fs.existsSync(outputPath)) {
  console.error('adapter did not produce an observation (exit ' + String(adapterExit) + ')');
  if (adapterRun.stderr) console.error(adapterRun.stderr.trim().slice(0, 2000));
  process.exit(4);
}
const O = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

// ---- helpers ----
function realOr(p) { try { return fs.realpathSync(p); } catch { return p; } }
function homePath(rel) {
  if (typeof rel !== 'string' || rel === '') return null;
  return path.isAbsolute(rel) ? rel : path.join(repoRoot, rel.replace(/^[/\\]+/, ''));
}
function fixturePath(name) { return path.join(fixturesDir, name); }
function helperPath(name) { return path.join(helpersDir, name); }
function caseOf(name) {
  const c = (Array.isArray(O.cases) ? O.cases : []).find((x) => x && x.name === name);
  if (!c) throw new Error('the observation has no case ' + name);
  return c;
}
function srcOf(c) {
  const p = c && c.source && typeof c.source.path === 'string' ? c.source.path : null;
  if (!p) return null;
  if (fs.existsSync(p)) return p;
  const f = fixturePath(path.basename(p));
  return fs.existsSync(f) ? f : p;
}
// The work copy of a produced file, verified against the record's own hash.
function producedPath(c, name) {
  const rel = 'case-' + c.name + '/' + name;
  const f = (Array.isArray(c.out_files) ? c.out_files : []).find((x) => x && x.path === rel);
  if (!f) throw new Error('case ' + c.name + ' recorded no output ' + name);
  const p = path.join(workDir, rel);
  if (!fs.existsSync(p)) throw new Error('the work copy of ' + rel + ' is gone');
  if (sha256File(p) !== f.sha256) throw new Error('the work copy of ' + rel + ' is not the bytes the case recorded');
  return p;
}
// Placement coordinates from a case's own stdout; the script lays 11 px per
// module (its MODULE constant), so the quiet-zone box is modules*11.
function placementOf(c) {
  const pm = /placed at \((\d+),(\d+)\)/.exec(c.stdout || '');
  const qm = /(\d+)x(\d+) modules/.exec(c.stdout || '');
  if (!pm || !qm) throw new Error('case ' + c.name + ': stdout carries no placement line');
  return { x: parseInt(pm[1], 10), y: parseInt(pm[2], 10), qs: parseInt(qm[1], 10) * 11 };
}
function runPy(argv, timeoutMs, cwd) {
  const res = spawnSync(pythonBin, argv, { encoding: 'utf8', timeout: timeoutMs || 120000, cwd: cwd || undefined });
  if (res.error && res.error.code !== 'ETIMEDOUT') throw new Error('could not start ' + pythonBin + ': ' + res.error.message);
  return res;
}
function runLadder(pngPath, url) {
  const res = runPy([helperPath('stress_ladder.py'), pngPath, url], 150000);
  if (res.status !== 0) throw new Error('stress_ladder.py exited ' + res.status + ': ' + String(res.stderr || '').slice(0, 300));
  return JSON.parse(res.stdout);
}
function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a); const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEq(a[k], b[k]));
  }
  return false;
}
const ok = (detail) => ({ ok: true, detail });
const no = (detail) => ({ ok: false, detail });
function done(problems, passDetail) {
  return problems.length === 0 ? ok(passDetail) : no(problems.join(' | '));
}

// ---- observation vs its own evidence (mirrors the upstream preflight) ----
function caseEvidenceProblems(c) {
  const problems = [];
  const base = path.join(evidenceDir, 'case-' + c.name);
  const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  if (readIf(base + '.stdout.txt') !== c.stdout) problems.push(c.name + ': recorded stdout does not match the evidence copy');
  if (readIf(base + '.stderr.txt') !== c.stderr) problems.push(c.name + ': recorded stderr does not match the evidence copy');
  const argvPath = base + '.argv.json';
  if (!fs.existsSync(argvPath)) problems.push(c.name + ': no argv.json in the invocation evidence');
  else {
    let a = null;
    try { a = JSON.parse(fs.readFileSync(argvPath, 'utf8')); } catch { problems.push(c.name + ': argv.json is not valid JSON'); }
    if (a) {
      if (!deepEq(a.argv, c.argv)) problems.push(c.name + ': argv.json disagrees with the recorded argv');
      if (a.exit_status !== c.exit_status) problems.push(c.name + ': argv.json exit_status disagrees with the record');
      if ((a.signal || null) !== (c.signal || null)) problems.push(c.name + ': argv.json signal disagrees with the record');
      if (a.duration_ms !== c.duration_ms) problems.push(c.name + ': argv.json duration disagrees with the record');
      if (realOr(String(a.cwd)) !== realOr(path.join(workDir, 'case-' + c.name))) problems.push(c.name + ': argv.json cwd is not the case scratch dir');
      if (realOr(String(a.interpreter)) !== realOr(String(c.interpreter_path))) problems.push(c.name + ': argv.json interpreter is not the one the case recorded');
      if (Array.isArray(c.argv) && c.argv[1] !== c.url) problems.push(c.name + ': the recorded URL is not the one on the command line');
    }
  }
  for (const f of (Array.isArray(c.out_files) ? c.out_files : [])) {
    if (!f || !f.png) continue;
    const copy = path.join(evidenceDir, 'case-' + c.name + '.' + String(f.path).split('/').pop());
    if (!fs.existsSync(copy)) { problems.push(c.name + ': no evidence copy of ' + f.path); continue; }
    if (sha256File(copy) !== f.sha256) problems.push(c.name + ': the evidence copy of ' + f.path + ' is not the bytes recorded');
  }
  const src = srcOf(c);
  if (!src || !fs.existsSync(src)) problems.push(c.name + ': the source the case read is gone');
  else if (sha256File(src) !== c.source.sha256) problems.push(c.name + ': the source on disk is not the bytes the case recorded');
  return problems;
}
const EVIDENCE = [];
if (O.schema !== 'qr-camo-embed-observation/1') {
  EVIDENCE.push('the observation schema is ' + JSON.stringify(O.schema) + ", not 'qr-camo-embed-observation/1'");
} else {
  if (!O.frozen || typeof O.frozen !== 'object' || !O.frozen.script || !O.frozen.interpreter) EVIDENCE.push('the observation records no frozen script/interpreter identity');
  if (!fs.existsSync(path.join(evidenceDir, 'frozen.sha256'))) EVIDENCE.push('the run wrote no frozen.sha256 into the invocation evidence');
  if (!fs.existsSync(path.join(evidenceDir, 'deps.json'))) EVIDENCE.push('the run wrote no deps.json into the invocation evidence');
  for (const c of (Array.isArray(O.cases) ? O.cases : [])) {
    if (!c || typeof c.name !== 'string') { EVIDENCE.push('the observation carries a caseless record'); continue; }
    EVIDENCE.push(...caseEvidenceProblems(c));
  }
}

// ---- gates (ids and claims carried over from the upstream gates/check.js) ----
const checks = {};

checks.ship_frame_reproduced = () => {
  const problems = [];
  const c = caseOf('ship_bearing_frame');
  if (c.outcome !== 'embedded' || c.exit_status !== 0 || c.signal !== null) problems.push('the ship case did not embed cleanly (outcome ' + c.outcome + ', exit ' + c.exit_status + ', signal ' + c.signal + ')');
  if (c.stderr !== '') problems.push('the ship case wrote to stderr: ' + JSON.stringify(c.stderr.slice(0, 200)));
  if (c.stdout !== STDOUT.ship) problems.push('the ship case stdout is not the pinned 4 lines: ' + JSON.stringify(c.stdout));
  if (!c.source || c.source.sha256 !== expectations.fixtures['bearing-camo-src.png'].sha256) problems.push('the ship case did not read the pinned bearing cover');
  const paths = (Array.isArray(c.out_files) ? c.out_files : []).map((f) => f.path);
  if (!deepEq(paths, ['case-ship_bearing_frame/camo-qr-header.png'])) problems.push('the ship case left ' + JSON.stringify(paths) + ' behind, not exactly one camo-qr-header.png');
  try {
    const out = producedPath(c, 'camo-qr-header.png');
    const got = sha256File(out);
    if (got !== PIN.oracle_ship_sha256) problems.push('the ship case wrote ' + got.slice(0, 12) + '…, not the oracle bytes the eval-6 run shipped (' + PIN.oracle_ship_sha256.slice(0, 12) + '…)');
    const oracle = fixturePath('oracle-ship-header.png');
    if (!fs.existsSync(oracle)) problems.push('the package has no oracle fixture to compare against');
    else if (sha256File(oracle) !== got) problems.push("the package's oracle fixture is not the bytes the ship case wrote");
    const f = (c.out_files || []).find((x) => x.path === 'case-ship_bearing_frame/camo-qr-header.png');
    if (f && f.png && (f.png.width !== PIN.output_geometry.width || f.png.height !== PIN.output_geometry.height)) {
      problems.push('the output is ' + f.png.width + 'x' + f.png.height + ', not ' + PIN.output_geometry.width + 'x' + PIN.output_geometry.height);
    }
  } catch (e) { problems.push(e.message); }
  return done(problems, 'the ship case embedded exit 0 with the pinned placement/gain/ALL-SCANS stdout, read the pinned bearing cover, wrote exactly camo-qr-header.png (1500x500), and its bytes are the oracle fixture the eval-6 run shipped (' + PIN.oracle_ship_sha256.slice(0, 12) + '…)');
};

checks.pale_cover_reproduced = () => {
  const problems = [];
  const c = caseOf('pale_cover');
  if (c.outcome !== 'embedded' || c.exit_status !== 0 || c.signal !== null) problems.push('the pale case did not embed cleanly (outcome ' + c.outcome + ', exit ' + c.exit_status + ', signal ' + c.signal + ')');
  if (c.stderr !== '') problems.push('the pale case wrote to stderr: ' + JSON.stringify(c.stderr.slice(0, 200)));
  if (c.stdout !== STDOUT.pale) problems.push('the pale case stdout is not the pinned 4 lines: ' + JSON.stringify(c.stdout));
  if (!c.source || c.source.sha256 !== expectations.fixtures['pale-camo-src.png'].sha256) problems.push('the pale case did not read the pinned pale cover');
  const paths = (Array.isArray(c.out_files) ? c.out_files : []).map((f) => f.path);
  if (!deepEq(paths, ['case-pale_cover/camo-qr-header.png'])) problems.push('the pale case left ' + JSON.stringify(paths) + ' behind, not exactly one camo-qr-header.png');
  try {
    const out = producedPath(c, 'camo-qr-header.png');
    const got = sha256File(out);
    if (got !== PIN.oracle_pale_sha256) problems.push('the pale case wrote ' + got.slice(0, 12) + '…, not the pinned pale oracle bytes (' + PIN.oracle_pale_sha256.slice(0, 12) + '…)');
    const oracle = fixturePath('oracle-pale-header.png');
    if (!fs.existsSync(oracle)) problems.push('the package has no pale oracle fixture to compare against');
    else if (sha256File(oracle) !== got) problems.push("the package's pale oracle fixture is not the bytes the pale case wrote");
  } catch (e) { problems.push(e.message); }
  return done(problems, 'the pale case embedded exit 0 with the pinned (905,20)/score 32.2/gain-0.68 stdout, read the pinned pale cover, and its bytes reproduce the pale oracle fixture byte for byte (' + PIN.oracle_pale_sha256.slice(0, 12) + '…)');
};

checks.stress_ladder_holds = () => {
  const problems = [];
  const c = caseOf('ship_bearing_frame');
  try {
    const out = producedPath(c, 'camo-qr-header.png');
    const r = runLadder(out, c.url);
    if (r.url !== c.url) problems.push('the ladder decoded ' + JSON.stringify(r.url) + ', not the case URL');
    if (r.all_pass !== true) problems.push('the stress ladder did not pass every leg: ' + JSON.stringify(r.legs));
  } catch (e) { problems.push(e.message); }
  return done(problems, 'the pinned ladder helper (zxing-only, on decoded arrays, mirroring the script\'s own stress_pass) decodes the ship output as its case URL and every leg passes — disk, PNG round-trip, half-size, jpeg q78, jpeg q85');
};

checks.variant_url_decodes = () => {
  const problems = [];
  const c = caseOf('variant_short_url');
  if (c.outcome !== 'embedded' || c.exit_status !== 0) problems.push('the variant case did not embed cleanly (outcome ' + c.outcome + ', exit ' + c.exit_status + ')');
  if (c.stdout !== STDOUT.variant) problems.push('the variant case stdout is not the pinned 4 lines: ' + JSON.stringify(c.stdout));
  try {
    const out = producedPath(c, 'camo-qr-header.png');
    const got = sha256File(out);
    if (got !== PIN.variant_out_sha256) problems.push('the variant case wrote ' + got.slice(0, 12) + '…, not the bytes the prove run pinned (' + PIN.variant_out_sha256.slice(0, 12) + '…)');
    if (got === PIN.oracle_ship_sha256) problems.push('the variant bytes equal the ship oracle — the URL did not reach the payload');
    const r = runLadder(out, c.url);
    if (r.url !== c.url) problems.push('the ladder decoded ' + JSON.stringify(r.url) + ', not the variant URL');
    if (r.all_pass !== true) problems.push('the stress ladder did not pass every leg on the variant: ' + JSON.stringify(r.legs));
  } catch (e) { problems.push(e.message); }
  return done(problems, 'the variant case reproduced its pinned bytes (different from the ship oracle — the URL is in the payload), kept the pinned placement, and decodes as its variant URL with every ladder leg passing');
};

checks.payload_overflow_bites = () => {
  const problems = [];
  const c = caseOf('overflow_hog_url');
  if (c.exit_status !== 1 || c.outcome !== 'refused') problems.push('the overflow case did not exit 1/refused (exit ' + c.exit_status + ', outcome ' + c.outcome + ')');
  if (c.signal !== null) problems.push('the overflow case died on a signal: ' + c.signal);
  if (c.stdout !== STDOUT.overflow_stdout) problems.push('the overflow stdout is ' + JSON.stringify(c.stdout) + ', not the pinned version line alone');
  if (c.stderr !== STDOUT.overflow_stderr) problems.push('the overflow stderr is ' + JSON.stringify(c.stderr) + ', not the exact payload-too-long refusal');
  if ((Array.isArray(c.out_files) ? c.out_files.length : -1) !== 0) problems.push('the refusal left ' + JSON.stringify((c.out_files || []).map((f) => f.path)) + ' behind');
  return done(problems, 'the 45x45 payload refuses with exit 1, the exact "payload too long" stderr line, the version line as its only stdout, and no file left behind — the documented refusal path is real');
};

checks.dark_cover_halo_lifts = () => {
  const problems = [];
  try {
    const ship = caseOf('ship_bearing_frame');
    const dark = caseOf('dark_cover');
    if (dark.stdout !== STDOUT.dark) problems.push('the dark case stdout is not the pinned 4 lines: ' + JSON.stringify(dark.stdout));
    const shipOut = producedPath(ship, 'camo-qr-header.png');
    const darkOut = producedPath(dark, 'camo-qr-header.png');
    const sp = placementOf(ship);
    const dp = placementOf(dark);
    const mShip = JSON.parse(runPy([helperPath('measure_blend.py'), String(srcOf(ship)), shipOut, String(sp.x), String(sp.y), String(sp.qs)]).stdout);
    const mDark = JSON.parse(runPy([helperPath('measure_blend.py'), String(srcOf(dark)), darkOut, String(dp.x), String(dp.y), String(dp.qs)]).stdout);
    if (!(mShip.ring44_delta < 0)) problems.push('the ship embedding should darken its ring (measured ' + mShip.ring44_delta + ')');
    if (!(mDark.ring44_delta > 0)) problems.push('the dark cover embedding should lift its ring (measured ' + mDark.ring44_delta + ')');
    const lift = Math.round((mDark.ring44_delta - mShip.ring44_delta) * 100) / 100;
    if (!(lift >= expectations.measured.dark.ring44_delta_split_vs_ship_min)) problems.push('the dark-vs-ship ring contrast split is ' + lift + ', below the 50-unit pin (prove run measured 78.18)');
    const lo = expectations.measured.dark.ring44_out_range[0];
    const hi = expectations.measured.dark.ring44_out_range[1];
    if (!(mDark.ring44_out >= lo && mDark.ring44_out <= hi)) problems.push('the dark embedding ring luma ' + mDark.ring44_out + ' is outside [' + lo + ',' + hi + '] (prove run measured 90.09) — too dark to scan or too washed to hide');
    if (!(mDark.ring44_canvas < mShip.ring44_canvas)) problems.push('the dark canvas ring (' + mDark.ring44_canvas + ') should sit below the ship canvas ring (' + mShip.ring44_canvas + ') — this is the halo, measured');
  } catch (e) { problems.push(e.message); }
  return done(problems, 'measured on the real pixels: the ship embedding darkens its ring while the dark-cover embedding lifts it, the contrast split clears the 50-unit pin (prove run 78.18), the dark ring lands inside the scannable band, and the dark canvas sits far below the ship canvas');
};

checks.pale_cover_signature = () => {
  const problems = [];
  try {
    const c = caseOf('pale_cover');
    const out = producedPath(c, 'camo-qr-header.png');
    const p = placementOf(c);
    const r = runLadder(out, c.url);
    if (r.url !== c.url || r.all_pass !== true) problems.push('the pale output does not survive the stress ladder as its URL: ' + JSON.stringify(r));
    const m = JSON.parse(runPy([helperPath('measure_blend.py'), String(srcOf(c)), out, String(p.x), String(p.y), String(p.qs)]).stdout);
    if (!(m.ring44_delta >= expectations.measured.pale.ring44_delta_min)) problems.push('the pale embedding ring lift is ' + m.ring44_delta + ', below the 5-unit pin (prove run measured 15.77) — a pale cover must push the ring UP, not down');
    const lo = expectations.measured.pale.ring44_out_range[0];
    const hi = expectations.measured.pale.ring44_out_range[1];
    if (!(m.ring44_out >= lo && m.ring44_out <= hi)) problems.push('the pale embedding ring luma ' + m.ring44_out + ' is outside [' + lo + ',' + hi + '] (prove run measured 108.8)');
    if (!(Math.abs(m.box_delta) <= expectations.measured.pale.box_delta_abs_max)) problems.push('the pale box delta ' + m.box_delta + ' exceeds 10 (prove run measured 2.51) — the patch would read as a sticker');
  } catch (e) { problems.push(e.message); }
  return done(problems, 'the pale cover output survives the full stress ladder and its geometry holds the measured signature: ring lifted (+15.77 at prove), ring luma near the pale canvas, box delta 2.51 — the muse SHIP verdict is sealed history this gate does not re-derive');
};

checks.muse_receipts_sealed = () => {
  const problems = [];
  for (const [name, verdict] of Object.entries(expectations.muse_verdicts)) {
    const pin = expectations.fixtures[name];
    const f = fixturePath(name);
    if (!fs.existsSync(f)) { problems.push('the package has no copy of ' + name); continue; }
    if (sha256File(f) !== pin.sha256) { problems.push(name + ' is not the pinned bytes'); continue; }
    if (!fs.readFileSync(f, 'utf8').includes(verdict)) problems.push(name + ' does not carry the pinned VERDICT line');
  }
  return done(problems, 'the sealed muse receipts — eval-6 SHIP and eval-5 FAIL — are the pinned bytes in the package, verdict lines intact; the historical taste ruling stands, unedited and unrerun (the upstream originals live in the source home; this port seals the bytes that travel)');
};

checks.cv2_weaker_than_zxing = () => {
  const problems = [];
  try {
    const c = caseOf('ship_bearing_frame');
    const out = producedPath(c, 'camo-qr-header.png');
    const p = placementOf(c);
    const res = runPy([helperPath('decode_controls.py'), out, String(srcOf(c)), String(p.x), String(p.y), String(p.qs), c.url], 150000);
    if (res.status !== 0) problems.push('decode_controls.py exited ' + res.status + ': ' + String(res.stderr || '').slice(0, 300));
    else {
      const legs = JSON.parse(res.stdout).legs;
      const kBoth = expectations.measured.decode_fade_legs.both_decode;
      const kZxing = expectations.measured.decode_fade_legs.zxing_only;
      const kNone = expectations.measured.decode_fade_legs.none_decode;
      if (!legs || !legs[kBoth] || !legs[kZxing] || !legs[kNone]) problems.push('decode_controls returned no ' + kBoth + '/' + kZxing + '/' + kNone + ' legs: ' + JSON.stringify(legs));
      else {
        if (legs[kBoth].zxing !== c.url || legs[kBoth].cv2 !== c.url) problems.push('at fade ' + kBoth + ' both decoders should still read the URL (zxing ' + JSON.stringify(legs[kBoth].zxing) + ', cv2 ' + JSON.stringify(legs[kBoth].cv2) + ')');
        if (legs[kZxing].zxing !== c.url) problems.push('at fade ' + kZxing + ' zxing should still decode (got ' + JSON.stringify(legs[kZxing].zxing) + ')');
        if (legs[kZxing].cv2 !== null) problems.push('at fade ' + kZxing + ' cv2 should already miss (got ' + JSON.stringify(legs[kZxing].cv2) + ') — this separation is why cv2 is never the oracle');
        if (legs[kNone].zxing !== null) problems.push('at fade ' + kNone + ' zxing should miss too (got ' + JSON.stringify(legs[kNone].zxing) + ')');
      }
    }
  } catch (e) { problems.push(e.message); }
  return done(problems, 'on identical re-serialized pixels the separation reproduces: both decoders hold at fade 0.10, at 0.15 zxing still reads while cv2 already misses, at 0.20 both miss — cv2 is strictly weaker here and stays out of the oracle seat');
};

checks.orientation_fix_bites = () => {
  const problems = [];
  let scratch = null;
  try {
    const prefix = fixturePath('prefix-orientation-make_header_v2.py');
    if (!fs.existsSync(prefix) || sha256File(prefix) !== PIN.prefix_fixture_sha256) throw new Error('the prefix-orientation fixture is not the pinned pre-fix script');
    const ship = caseOf('ship_bearing_frame');
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-camo-orient-'));
    fs.copyFileSync(String(srcOf(ship)), path.join(scratch, 'camo-src.png'));
    const res = runPy([prefix, 'https://archon.diy'], 200000, scratch);
    if (res.status !== 1) problems.push('the pre-fix script exited ' + res.status + ' on the landscape cover, not the documented refusal 1');
    if (String(res.stderr || '') !== STDOUT.refusal_line + '\n') problems.push('the pre-fix stderr is ' + JSON.stringify(res.stderr) + ', not the exact stress-ladder refusal');
    const so = String(res.stdout || '');
    if (!so.includes(STDOUT.prefix_sizing)) problems.push('the pre-fix stdout never sized the payload');
    if (!so.includes(STDOUT.prefix_placement)) problems.push('the pre-fix stdout does not carry its pinned landscape placement (1045,20): ' + JSON.stringify(so));
    if (so.includes(STDOUT.all_pass_line)) problems.push('the pre-fix script claimed ALL SCANS PASS — it refused at eval-4/eval-5');
    const left = fs.readdirSync(scratch).filter((n) => n !== 'camo-src.png');
    if (left.length !== 0) problems.push('the pre-fix refusal left files behind: ' + JSON.stringify(left));
  } catch (e) { problems.push(e.message); } finally {
    if (scratch) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* scratch only */ } }
  }
  return done(problems, 'the script as eval-4/eval-5 ran it (pinned prefix fixture) refuses the same landscape cover the fixed script ships on: pinned (1045,20) placement line, exact refusal stderr, no output file — the orientation fix is a demonstrated behavior change, not prose');
};

checks.determinism_repeat = () => {
  const problems = [];
  const ship = caseOf('ship_bearing_frame');
  const rep = caseOf('ship_bearing_frame_repeat');
  if (rep.stdout !== ship.stdout) problems.push('the repeat case stdout differs from the ship case: ' + JSON.stringify(rep.stdout));
  if (rep.exit_status !== ship.exit_status || rep.outcome !== ship.outcome) problems.push('the repeat case exited differently from the ship case');
  try {
    const a = sha256File(producedPath(ship, 'camo-qr-header.png'));
    const b = sha256File(producedPath(rep, 'camo-qr-header.png'));
    if (a !== b) problems.push('the repeat case wrote different bytes from the ship case');
    if (a !== PIN.oracle_ship_sha256) problems.push('both ship cases differ from the oracle bytes');
  } catch (e) { problems.push(e.message); }
  return done(problems, 'the repeat case reproduces the ship case exactly — same stdout, same exit, byte-identical output equal to the oracle — determinism as observed, on committed covers, with no randomness in the script');
};

checks.interpreter_declared = () => {
  const problems = [];
  const interp = (O.frozen && O.frozen.interpreter) || {};
  for (const k of Object.keys(PIN.deps)) {
    if (!interp.deps || interp.deps[k] !== PIN.deps[k]) problems.push('the observation records ' + k + ' ' + JSON.stringify(interp.deps ? interp.deps[k] : undefined) + ', not the pinned ' + PIN.deps[k]);
  }
  if (interp.version !== PIN.python_version) problems.push('the observation records python ' + JSON.stringify(interp.version) + ', not the pinned ' + PIN.python_version);
  const depsPath = path.join(evidenceDir, 'deps.json');
  if (!fs.existsSync(depsPath)) problems.push('the invocation evidence has no deps.json');
  else {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(depsPath, 'utf8')); } catch { problems.push('deps.json is not valid JSON'); }
    if (d) {
      for (const k of Object.keys(PIN.deps)) if (d[k] !== PIN.deps[k]) problems.push('deps.json records ' + k + ' ' + d[k] + ', not the pinned ' + PIN.deps[k]);
      if (d.python !== PIN.python_version) problems.push('deps.json records python ' + d.python + ', not the pinned ' + PIN.python_version);
    }
  }
  const recordedPath = homePath(String(interp.path || ''));
  if (!recordedPath || realOr(recordedPath) !== realOr(pythonBin)) problems.push('the recorded interpreter path ' + JSON.stringify(interp.path) + ' does not resolve to the live interpreter ' + pythonBin);
  const seen = new Set();
  for (const c of (Array.isArray(O.cases) ? O.cases : [])) {
    const r = realOr(String(c.interpreter_path));
    seen.add(r);
    if (r !== realOr(pythonBin)) problems.push(c.name + ' ran ' + c.interpreter_path + ', not the resolved interpreter');
  }
  if (seen.size !== 1) problems.push('the cases ran ' + seen.size + ' distinct interpreters');
  const probe = spawnSync(pythonBin, ['-c',
    "import json,sys,cv2,numpy,PIL;" +
    "from importlib.metadata import version as _v;" +
    "print(json.dumps({'cv2':cv2.__version__,'qrcode':_v('qrcode')," +
    "'zxingcpp':_v('zxing-cpp'),'numpy':numpy.__version__," +
    "'pillow':PIL.__version__,'python':sys.version.split()[0]}))"], { encoding: 'utf8', timeout: 60000 });
  if (probe.error || probe.status !== 0) problems.push('the live dependency probe failed: ' + String(probe.stderr || (probe.error && probe.error.message) || '').slice(0, 300));
  else {
    let live = null;
    try { live = JSON.parse(String(probe.stdout || '').trim().split('\n').pop()); } catch { problems.push('the live probe printed unparseable output'); }
    if (live) {
      for (const k of Object.keys(PIN.deps)) if (live[k] !== PIN.deps[k]) problems.push('the LIVE interpreter reports ' + k + ' ' + live[k] + ', not the pinned ' + PIN.deps[k]);
      if (live.python !== PIN.python_version) problems.push('the LIVE interpreter is python ' + JSON.stringify(live.python) + ', not the pinned ' + PIN.python_version);
    }
  }
  return done(problems, 'the interpreter is declared and re-proven: observation, deps.json and a live probe through the exact interpreter the cases ran all report the pinned library versions (cv2 4.13.0, qrcode 8.2, zxingcpp 3.1.1, numpy 2.4.6, pillow 10.4.0) and python ' + PIN.python_version + ', one interpreter across all six cases (upstream ran 3.14.7 — interpreter is environment, and the oracle bytes reproduce identically)');
};

checks.frozen_source_pinned = () => {
  const problems = [];
  const script = scriptPath;
  if (!fs.existsSync(script)) problems.push('the frozen script is not on disk at ' + path.relative(repoRoot, script));
  else if (sha256File(script) !== PIN.script_sha256) problems.push('the script on disk does not hash to the revision the run executed');
  const f = (O.frozen && O.frozen.script) || {};
  if (f.sha256 !== PIN.script_sha256) problems.push('the observation recorded script sha ' + JSON.stringify(f.sha256) + ', not the pinned revision');
  if (f.usage !== 'make_header_v2.py [url] — reads ./camo-src.png, writes ./camo-qr-header.png, cwd-relative') problems.push('the recorded script usage is ' + JSON.stringify(f.usage));
  if (!deepEq(f.documented_exit_codes, [0, 1])) problems.push('the recorded documented_exit_codes are ' + JSON.stringify(f.documented_exit_codes) + ', not [0, 1]');
  if (script && typeof f.path === 'string') {
    const recorded = homePath(f.path);
    if (!recorded || realOr(recorded) !== realOr(script)) problems.push('the recorded script path (' + f.path + ') is not the frozen script');
  }
  const frozenFile = path.join(evidenceDir, 'frozen.sha256');
  if (!fs.existsSync(frozenFile)) problems.push('the run wrote no frozen.sha256');
  else {
    const lines = fs.readFileSync(frozenFile, 'utf8').split('\n').filter((l) => l !== '');
    if (lines.length !== 2) problems.push('frozen.sha256 carries ' + lines.length + ' lines, not script + interpreter');
    const m1 = /^([0-9a-f]{64}) {2}(.*)$/.exec(lines[0] || '');
    if (!m1) problems.push('frozen.sha256 line 1 is not a sha256sum line');
    else {
      if (m1[1] !== PIN.script_sha256) problems.push('frozen.sha256 line 1 carries sha ' + m1[1].slice(0, 12) + '…, not the pinned script revision');
      if (script && realOr(m1[2]) !== realOr(script)) problems.push('frozen.sha256 line 1 names ' + m1[2] + ', not the frozen script');
    }
    const m2 = /^interpreter: (.*)$/.exec(lines[1] || '');
    if (!m2) problems.push('frozen.sha256 line 2 is not an interpreter line');
    else if (realOr(m2[1]) !== realOr(pythonBin)) problems.push('frozen.sha256 names interpreter ' + m2[1] + ', not the one reachable now');
  }
  const onDisk = [
    [adapterPath, PIN.adapter_sha256, 'the adapter'],
    [contractPath, PIN.contract_sha256, 'the contract']
  ];
  for (const [p, want, label] of onDisk) {
    if (!p || !fs.existsSync(p)) problems.push(label + ' is not on disk at ' + path.relative(repoRoot, p));
    else if (sha256File(p) !== want) problems.push(label + ' on disk does not hash to the pinned revision');
  }
  for (const [name, want] of Object.entries(PIN.helpers)) {
    const p = helperPath(name);
    if (!fs.existsSync(p)) problems.push('the helper ' + name + ' is missing in evals/helpers');
    else if (sha256File(p) !== want) problems.push('the helper ' + name + ' is not the pinned revision');
  }
  let executed = 0;
  for (const c of (Array.isArray(O.cases) ? O.cases : [])) {
    if (!Array.isArray(c.argv) || c.argv.length !== 2) { problems.push(c.name + ': argv is ' + JSON.stringify(c.argv)); continue; }
    if (script && realOr(c.argv[0]) !== realOr(script)) problems.push(c.name + ': ran ' + c.argv[0] + ', not the frozen script');
    if (c.argv[1] !== c.url) problems.push(c.name + ': argv[1] is ' + JSON.stringify(c.argv[1]) + ', not the case URL');
    executed += 1;
  }
  if (executed !== casesSpec.cases.length) problems.push('the run executed ' + executed + ' cases, not the ' + casesSpec.cases.length + ' the package declares');
  return done(problems, 'the frozen script, adapter, contract and all three measuring helpers are the pinned revisions on disk, evidence/frozen.sha256 carries the script + interpreter identity the run wrote, and all ' + executed + ' cases ran that exact script with their own URL (this runner pins everything except itself — its identity rides the commit and the receipt)');
};

checks.artifact_identity_pinned = () => {
  const problems = [];
  const casesSha = sha256File(path.join(evalsDir, 'cases.json'));
  if (casesSha !== PIN.cases_sha256) problems.push('cases.json on disk is ' + casesSha.slice(0, 12) + '…, not the pinned revision ' + PIN.cases_sha256.slice(0, 12) + '…');
  if (!fs.existsSync(runInputPath)) problems.push('the run has no run-input.json');
  else {
    const meta = JSON.parse(fs.readFileSync(runInputPath, 'utf8'));
    if (meta.eval_id !== 'qr-camo-embed-grounding-v1') problems.push('the run is an execution of ' + JSON.stringify(meta.eval_id) + ', not this eval');
    if (meta.capability_id !== 'qr-camo-embed') problems.push('the run executed ' + JSON.stringify(meta.capability_id));
    if (meta.cases_sha256 !== PIN.cases_sha256) problems.push('the run recorded a cases.json revision that is not the pinned one');
    if (meta.expectations_sha256 !== sha256File(path.join(evalsDir, 'expectations.json'))) problems.push('the run\'s expectations.json is not the revision on disk now');
    const names = Object.keys(expectations.fixtures);
    if (!Array.isArray(meta.fixtures) || meta.fixtures.length !== names.length) problems.push('run-input.json records ' + (meta.fixtures ? meta.fixtures.length : 0) + ' fixtures, not the ' + names.length + ' the package pins');
    for (const name of names) {
      const pin = expectations.fixtures[name];
      const rec = (meta.fixtures || []).find((x) => x && x.name === name);
      if (!rec) { problems.push('run-input.json does not record fixture ' + name); continue; }
      if (rec.sha256 !== pin.sha256 || rec.bytes !== pin.bytes) problems.push('run-input.json records ' + name + ' as ' + String(rec.sha256).slice(0, 12) + '…/' + rec.bytes + ', not the pinned ' + pin.sha256.slice(0, 12) + '…/' + pin.bytes);
    }
    const ci = meta.capability_input;
    if (!ci || typeof ci.path !== 'string' || typeof ci.sha256 !== 'string') problems.push('run-input.json records no capability input');
    else if (!fs.existsSync(inputPath) || sha256File(inputPath) !== ci.sha256) problems.push("the run's capability input is not the bytes the run consumed");
  }
  for (const [name, pin] of Object.entries(expectations.fixtures)) {
    const p = fixturePath(name);
    if (!fs.existsSync(p)) { problems.push('the package has no copy of ' + name); continue; }
    const buf = fs.readFileSync(p);
    if (buf.length !== pin.bytes) problems.push("the package's copy of " + name + ' is ' + buf.length + ' bytes, not ' + pin.bytes);
    if (sha256Buf(buf) !== pin.sha256) problems.push("the package's copy of " + name + ' is not the pinned bytes');
  }
  // The run's request, against the case set cases.json pins: same names in the
  // same order, same covers (by basename), same URLs.
  const requested = requestCases.map((x) => x.name);
  const declared = casesSpec.cases.map((x) => x.name);
  if (!deepEq(requested, declared)) problems.push('the run requested ' + JSON.stringify(requested) + ', cases.json declares ' + JSON.stringify(declared));
  for (const x of requestCases) {
    const want = casesSpec.cases.find((y) => y.name === x.name);
    if (!want) { problems.push('the run requested an undeclared case ' + x.name); continue; }
    if (x.operation !== want.operation) problems.push(x.name + ': requested operation ' + JSON.stringify(x.operation) + ', declared ' + JSON.stringify(want.operation));
    if (path.basename(String(x.source)) !== path.basename(String(want.source))) problems.push(x.name + ': requested cover ' + path.basename(String(x.source)) + ', declared ' + path.basename(String(want.source)));
    if (x.url !== want.url) problems.push(x.name + ': requested URL ' + JSON.stringify(x.url) + ', declared ' + JSON.stringify(want.url));
  }
  const obsNames = (Array.isArray(O.cases) ? O.cases : []).map((c) => c.name);
  if (!deepEq(obsNames, requested)) problems.push('the observation names ' + JSON.stringify(obsNames) + ', the request asked for ' + JSON.stringify(requested));
  else if (new Set(obsNames).size !== obsNames.length) problems.push('the observation names the same case twice');
  for (const x of requestCases) {
    const oc = (Array.isArray(O.cases) ? O.cases : []).find((y) => y && y.name === x.name);
    if (!oc) continue;
    if (oc.url !== x.url) problems.push(x.name + ': the observation ran URL ' + JSON.stringify(oc.url) + ', the request asked for ' + JSON.stringify(x.url));
    if (!oc.source || path.basename(String(oc.source.path)) !== path.basename(String(x.source))) problems.push(x.name + ': the observation read a different cover than the request named');
  }
  return done(problems, "the run is an execution of this exact package revision: cases.json matches its pin, all " + Object.keys(expectations.fixtures).length + " pinned fixtures agree byte for byte between the package and run-input.json, the run's request is pinned by hash, and the request matches the declared case set");
};

// ---- dispatch ----
const gates = expectations.gates.map((id) => {
  const fn = checks[id];
  if (!fn) return { id, pass: false, detail: 'gate not implemented in this runner' };
  if (EVIDENCE.length > 0) return { id, pass: false, detail: 'the observation contradicts its own evidence: ' + EVIDENCE.join(' | ') };
  let r;
  try {
    r = fn();
  } catch (e) {
    r = no('gate could not complete: ' + e.message);
  }
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
  capability: 'qr-camo-embed',
  runId,
  mode: negativeControl ? 'negative-control' : 'positive',
  startedAt,
  finishedAt,
  runner: {
    command: 'node capabilities/qr-camo-embed/evals/run-evals.mjs' + (negativeControl ? ' --negative-control' : ''),
    node: process.version,
    platform: process.platform + ' ' + process.arch
  },
  interpreter: {
    path: pythonBin,
    version: (O.frozen.interpreter || {}).version,
    deps: (O.frozen.interpreter || {}).deps
  },
  adapter: {
    command: 'node adapter/run.js',
    exit_code: adapterExit,
    sha256: sha256File(adapterPath),
    output: (adapterRun.stdout || '').trim()
  },
  frozen: {
    script: { path: (O.frozen.script || {}).path, sha256: (O.frozen.script || {}).sha256 },
    contract_sha256: sha256File(contractPath),
    helpers: Object.fromEntries(Object.keys(PIN.helpers).map((n) => [n, sha256File(helperPath(n))]))
  },
  cases: (Array.isArray(O.cases) ? O.cases : []).map((c) => ({
    name: c.name,
    operation: c.operation,
    url: c.url,
    source_sha256: c.source ? c.source.sha256 : null,
    exit_status: c.exit_status,
    signal: c.signal,
    outcome: c.outcome,
    duration_ms: c.duration_ms,
    stdout: c.stdout,
    stderr: c.stderr,
    out_files: (Array.isArray(c.out_files) ? c.out_files : []).map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes, png: f.png }))
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
