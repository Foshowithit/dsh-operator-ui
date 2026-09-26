#!/usr/bin/env node
// Self-contained eval runner for the filmstrip-verify capability.
//
// It runs the shipped adapter (../adapter/run.cjs) against the pinned fixtures in
// cases.json and checks the expectations declared there. No kernel, no network,
// no fixtures beyond what ships beside this file. Exit 0 = every declared gate
// held; exit 1 = at least one gate did not.
//
// The expectation language is deliberately small: exact scalars, exact null,
// exact booleans (a leg's pass flag), inclusive bounds (min/max) with strict ends
// (lt/gt), and set equality for failing_legs. A gate asserts what the capability
// CLAIMS (e.g. "this fixture fails the no-slideshow proxy on its share arm"),
// never a hash of one machine's output.
//
// Negative control: `run-eval.js --negative` runs ONE case with its input
// perturbed (a fixture swapped) while the expectations stay the unperturbed
// case's. The required outcome is that the eval FAILS (non-zero exit). An eval
// suite that cannot fail proves nothing, so the negative run is part of the
// evidence, not a curiosity.
//
// Usage:
//   node run-eval.js [--negative] [--artifacts <dir>]

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, copyFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8'));

const argv = process.argv.slice(2);
const NEGATIVE = argv.includes('--negative');
const artIdx = argv.indexOf('--artifacts');
const ARTIFACTS = artIdx >= 0 ? argv[artIdx + 1] : null;

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

let failures = 0;
let checks = 0;
function ok(line) { checks++; console.log('  ok    ' + line); }
function fail(line, detail) { checks++; failures++; console.log('  FAIL  ' + line + (detail ? '  —  ' + detail : '')); }

function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = [...a].map(String).sort();
  const sb = [...b].map(String).sort();
  return sa.every((v, i) => v === sb[i]);
}

function cmpValue(observed, expected) {
  if (expected === null) return { pass: observed === null, detail: 'expected null, observed ' + JSON.stringify(observed) };
  if (typeof expected === 'boolean' || typeof expected === 'string') {
    return { pass: observed === expected, detail: 'expected ' + JSON.stringify(expected) + ', observed ' + JSON.stringify(observed) };
  }
  if (typeof expected === 'object') {
    if (typeof observed !== 'number' || !Number.isFinite(observed)) {
      return { pass: false, detail: 'expected a number against bounds ' + JSON.stringify(expected) + ', observed ' + JSON.stringify(observed) };
    }
    const parts = [];
    if ('min' in expected && observed < expected.min) parts.push(observed + ' < min ' + expected.min);
    if ('max' in expected && observed > expected.max) parts.push(observed + ' > max ' + expected.max);
    if ('lt' in expected && !(observed < expected.lt)) parts.push(observed + ' not < ' + expected.lt);
    if ('gt' in expected && !(observed > expected.gt)) parts.push(observed + ' not > ' + expected.gt);
    return { pass: parts.length === 0, detail: parts.join('; ') || 'observed ' + observed + ' within ' + JSON.stringify(expected) };
  }
  return { pass: observed === expected, detail: 'expected ' + JSON.stringify(expected) + ', observed ' + JSON.stringify(observed) };
}

// The flat probe view the gates read: the same facts the adapter's observation
// carries (legs included), nothing recomputed here.
function viewOf(probe) {
  const o = probe.observed || {};
  const legs = probe.legs || {};
  return {
    outcome: probe.outcome,
    exit_status: probe.exit_status,
    failing_legs: o.failing_legs || [],
    pass_marker: o.pass_marker,
    frames_extracted: o.frames_extracted,
    mean_volume_db: o.mean_volume_db,
    hold_share: o.hold_share,
    longest_hold_s: o.longest_hold_s,
    has_audio: o.has_audio,
    leg_six_frames: legs['six-frames'] ? legs['six-frames'].pass : undefined,
    leg_audio_bed: legs['audio-bed'] ? legs['audio-bed'].pass : undefined,
    leg_no_slideshow: legs['no-slideshow'] ? legs['no-slideshow'].pass : undefined
  };
}

function checkGate(gate, probesByName) {
  const probe = probesByName.get(gate.probe);
  if (!probe) { fail(gate.id, 'probe not found: ' + gate.probe); return; }
  const view = viewOf(probe);
  for (const [key, expected] of Object.entries(gate.assert || {})) {
    const observed = key === 'failing_legs' ? view.failing_legs : view[key];
    const res = key === 'failing_legs'
      ? { pass: sameSet(observed, expected), detail: 'expected set ' + JSON.stringify(expected) + ', observed ' + JSON.stringify(observed) }
      : cmpValue(observed, expected);
    if (res.pass) ok(gate.id + ': ' + key + ' ' + res.detail);
    else fail(gate.id + ': ' + key, res.detail);
  }
  if (Array.isArray(gate.assertFailingLegsExcludes)) {
    for (const id of gate.assertFailingLegsExcludes) {
      if (view.failing_legs.includes(id)) fail(gate.id + ': failing_legs must exclude ' + id, 'observed ' + JSON.stringify(view.failing_legs));
      else ok(gate.id + ': failing_legs excludes ' + id);
    }
  }
}

console.log('== ' + doc.eval_id + '  capability ' + doc.capability_id + (NEGATIVE ? '  [NEGATIVE CONTROL RUN]' : ''));
const runId = randomUUID();
console.log('run ' + runId);
console.log('node ' + process.versions.node + '  adapter ' + doc.adapter);

for (const [name, fx] of Object.entries(doc.fixtures)) {
  const p = join(HERE, fx.file);
  if (!existsSync(p)) { fail('fixture-identity-pinned: ' + name, 'missing ' + fx.file); continue; }
  const got = sha256(p);
  if (got === fx.sha256) ok('fixture-identity-pinned: ' + name);
  else fail('fixture-identity-pinned: ' + name, 'sha256 ' + got + ' != pinned ' + fx.sha256);
}

const negativeSpec = doc.negative_control;
const casesToRun = NEGATIVE ? doc.cases.filter((c) => c.caseId === negativeSpec.caseId) : doc.cases;

for (const c of casesToRun) {
  const caseRunId = randomUUID();
  console.log('');
  console.log('case ' + c.caseId + '  run ' + caseRunId + (NEGATIVE ? '  [input perturbed: ' + negativeSpec.perturb.type + ']' : ''));
  if (!NEGATIVE) console.log('  claim: ' + c.claim);

  const probes = c.probes.map((p) => ({ ...p }));
  if (NEGATIVE) {
    const target = probes.find((p) => p.name === negativeSpec.perturb.probe);
    if (target) { delete target.fileOverride; target.fixture = negativeSpec.perturb.fixture; }
  }
  const input = {
    probes: probes.map((p) => ({
      name: p.name,
      file: p.fileOverride ? resolve(HERE, p.fileOverride) : resolve(HERE, doc.fixtures[p.fixture].file),
      ...(p.frames ? { frames: p.frames } : {})
    }))
  };

  const work = mkdtempSync(join(tmpdir(), 'filmstrip-eval-'));
  const inputPath = join(work, 'input.json');
  const outputPath = join(work, 'observation.json');
  const evidenceDir = join(work, 'evidence');
  writeFileSync(inputPath, JSON.stringify(input, null, 2) + '\n');

  const r = spawnSync(process.execPath, [resolve(HERE, doc.adapter)], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, RCOS_INPUT: inputPath, RCOS_OUTPUT: outputPath, RCOS_EVIDENCE_DIR: evidenceDir },
    timeout: 600000
  });
  const adapterExit = r.status === null ? 124 : r.status;
  console.log('  adapter exit ' + adapterExit + (c.adapterExit !== undefined ? ' (expected ' + c.adapterExit + ')' : ''));
  if (c.adapterExit !== undefined) {
    if (adapterExit === c.adapterExit) ok('adapter-exit: ' + adapterExit);
    else fail('adapter-exit', 'exit ' + adapterExit + ' != expected ' + c.adapterExit);
  }

  let observation = null;
  try { observation = JSON.parse(readFileSync(outputPath, 'utf8')); }
  catch (e) { fail('observation-readable', String(e.message)); }

  if (observation) {
    const measurerPath = resolve(HERE, doc.measurer);
    const pinned = sha256(measurerPath);
    if (observation.measurer_sha256 === pinned) ok('measurer-sha-pinned: ' + pinned.slice(0, 16));
    else fail('measurer-sha-pinned', 'observation names ' + observation.measurer_sha256 + ', file on disk is ' + pinned);
  }

  const byName = new Map();
  for (const p of (observation && observation.probes) || []) byName.set(p.name, p);
  for (const gate of c.gates) checkGate(gate, byName);

  if (ARTIFACTS) {
    const dir = join(ARTIFACTS, doc.eval_id + '-' + caseRunId);
    mkdirSync(dir, { recursive: true });
    copyFileSync(inputPath, join(dir, 'input.json'));
    if (existsSync(outputPath)) copyFileSync(outputPath, join(dir, 'observation.json'));
    writeFileSync(join(dir, 'adapter-stdout.txt'), r.stdout || '');
    writeFileSync(join(dir, 'adapter-stderr.txt'), r.stderr || '');
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
      eval_id: doc.eval_id, case_id: c.caseId, run_id: caseRunId, adapter_exit: adapterExit,
      negative: NEGATIVE, perturb: NEGATIVE ? negativeSpec.perturb : null
    }, null, 2) + '\n');
    console.log('  artifacts -> ' + dir);
  }
}

console.log('');
if (NEGATIVE) {
  if (failures > 0) {
    console.log('NEGATIVE CONTROL CONFIRMED: ' + failures + ' gate(s) failed on the perturbed input — the eval can fail, so its passes mean something.');
    process.exit(1);
  }
  console.log('NEGATIVE CONTROL BROKEN: the perturbed input PASSED the unperturbed expectations — this eval cannot fail and proves nothing.');
  process.exit(0);
}
console.log((failures === 0 ? 'EVAL PASS' : 'EVAL FAIL') + ': ' + (checks - failures) + '/' + checks + ' gate checks held');
process.exit(failures === 0 ? 0 : 1);
