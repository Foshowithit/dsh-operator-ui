#!/usr/bin/env node
// Self-contained eval runner for the video-forensics-receipt capability.
//
// It runs the shipped adapter (../adapter/run.cjs) against the pinned fixtures in
// cases.json and checks the expectations declared there. No kernel, no network,
// no fixtures beyond what ships beside this file. Exit 0 = every declared gate
// held; exit 1 = at least one gate did not.
//
// The expectation language is deliberately small: exact scalars, exact null, or
// inclusive bounds (min/max) with strict ends (lt/gt), and set equality for
// failing_gates. A gate asserts what the CAPABILITY claims (e.g. "this fixture
// fails loudness and nothing else"), never a hash of one machine's output.
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

// --- expectation comparison ---------------------------------------------------------------
function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = [...a].map(String).sort();
  const sb = [...b].map(String).sort();
  return sa.every((v, i) => v === sb[i]);
}

function cmpValue(observed, expected) {
  if (expected === null) return { pass: observed === null, detail: 'expected null, observed ' + JSON.stringify(observed) };
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
// carries, nothing recomputed here.
function viewOf(probe) {
  const o = probe.observed || {};
  return {
    outcome: probe.outcome,
    exit_status: probe.exit_status,
    failing_gates: o.failing_gates || [],
    pass_marker: o.pass_marker,
    lufs: o.lufs, lra: o.lra, true_peak_dbfs: o.true_peak_dbfs,
    luma: o.luma, saturation: o.saturation,
    motion_rate: o.motion_rate, hold_share: o.hold_share, longest_hold_s: o.longest_hold_s
  };
}

function checkGate(gate, probesByName) {
  if (gate.assertDistinctFailingSets) {
    const sets = gate.multiProbe.map((n) => {
      const p = probesByName.get(n);
      return p ? viewOf(p).failing_gates : null;
    });
    const serialized = sets.map((s) => JSON.stringify([...(s || [])].sort()));
    const distinct = new Set(serialized).size === serialized.length;
    if (distinct) ok(gate.id + ': failing sets differ across probes');
    else fail(gate.id + ': failing sets are not distinct', serialized.join(' vs '));
    return;
  }
  const probe = probesByName.get(gate.probe);
  if (!probe) { fail(gate.id, 'probe not found: ' + gate.probe); return; }
  const view = viewOf(probe);
  const want = gate.assert || {};
  for (const [key, expected] of Object.entries(want)) {
    const observed = key === 'failing_gates' ? view.failing_gates : view[key];
    const res = key === 'failing_gates'
      ? { pass: sameSet(observed, expected), detail: 'expected set ' + JSON.stringify(expected) + ', observed ' + JSON.stringify(observed) }
      : cmpValue(observed, expected);
    if (res.pass) ok(gate.id + ': ' + key + ' ' + res.detail);
    else fail(gate.id + ': ' + key, res.detail);
  }
  if (Array.isArray(gate.assertFailingGatesExcludes)) {
    for (const id of gate.assertFailingGatesExcludes) {
      if (view.failing_gates.includes(id)) fail(gate.id + ': failing_gates must exclude ' + id, 'observed ' + JSON.stringify(view.failing_gates));
      else ok(gate.id + ': failing_gates excludes ' + id);
    }
  }
}

// --- fixture identity ----------------------------------------------------------------------
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

// --- cases ----------------------------------------------------------------------------------
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
    if (target) target.fixture = negativeSpec.perturb.fixture;
  }
  const input = {
    probes: probes.map((p) => ({
      name: p.name,
      file: resolve(HERE, doc.fixtures[p.fixture].file),
      register: p.register
    }))
  };

  const work = mkdtempSync(join(tmpdir(), 'vfr-eval-'));
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
    if (observation.measurer && observation.measurer.sha256 === pinned) {
      ok('measurer-sha-pinned: ' + pinned.slice(0, 16));
    } else {
      fail('measurer-sha-pinned', 'observation names ' + (observation.measurer && observation.measurer.sha256) + ', file on disk is ' + pinned);
    }
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
