'use strict';
// Offline injected-failure tests for the runner v-next sequence.
// No live sandbox, no network, synthetic run dirs only (mkdtemp under /tmp).
// The headline case is the one the live Run #2 runner got wrong: eval returns
// exit 3 / verdict "fix" — the runner must still retrieve the receipt,
// verify it independently, classify it as a VALID receipt describing failed
// work, and clean up unconditionally.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  runEvaluation, classify, fsRetrieve, fsVerify, PHASE_ORDER, RECEIPT_SCHEMA
} from './runner-vnext.mjs';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Build a synthetic run dir: an artifact + a receipt sealing it.
function fixtureRun({ verdict, tamper = false, corruptJson = false, exitOverride = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p6b-vnext-'));
  const output = JSON.stringify({ schema: 'reuse-ledger-observation/1', probe_capability: 'fixture-cap' }) + '\n';
  fs.writeFileSync(path.join(dir, 'output.json'), output);
  const artifacts = [{ path: 'output.json', sha256: sha(output), bytes: Buffer.byteLength(output) }];
  const receipt = {
    schema: RECEIPT_SCHEMA,
    run_id: '20260922T000000Z-abcdef',
    eval_id: 'reuse-ledger-invariant-v1',
    capability_id: 'fixture-cap',
    verdict,
    verdict_basis: 'derived from gate exit codes',
    gates: [],
    invocation: null,
    eligibility: null,
    artifacts,
    created_at: '2026-09-22T00:00:00.000Z'
  };
  if (corruptJson) fs.writeFileSync(path.join(dir, 'receipt.json'), '{not json');
  else fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  if (tamper) fs.appendFileSync(path.join(dir, 'output.json'), 'tampered\n');
  const execStatus = exitOverride !== null ? exitOverride
    : verdict === 'ship' ? 0 : verdict === 'fix' ? 3 : 4;
  return { dir, execStatus };
}

function deps(dir, calls, opts = {}) {
  return {
    exec: async () => { calls.push('exec'); return { status: opts.execStatus ?? 0 }; },
    retrieve: async (...a) => { calls.push('retrieve'); return fsRetrieve(dir)(...a); },
    verify: async (...a) => { calls.push('verify'); return fsVerify()(...a); },
    cleanup: async () => { calls.push('cleanup'); return { destroyed: true }; }
  };
}

test('exit 3 / verdict fix still retrieves, verifies, classifies valid-failed, cleans up', async () => {
  const { dir, execStatus } = fixtureRun({ verdict: 'fix' });
  const calls = [];
  const rec = await runEvaluation(deps(dir, calls, { execStatus }));

  assert.deepEqual(rec.phases, PHASE_ORDER, 'phases run in the ruling order');
  assert.ok(calls.includes('retrieve'), 'retrieve ran despite non-zero exit');
  assert.ok(calls.includes('verify'), 'verify ran despite non-zero exit');
  assert.equal(calls.indexOf('verify') < calls.indexOf('cleanup'), true, 'verify before cleanup');
  assert.equal(rec.classification.kind, 'valid-receipt-failed-work');
  assert.equal(rec.classification.verdict, 'fix');
  assert.equal(rec.classification.exit, 3);
  assert.equal(rec.verification.state, 'ok');
  assert.deepEqual(rec.cleanup, { destroyed: true });
  assert.equal(rec.cleanupError, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ship receipt exit 0 classifies evaluation-passed with full sequence', async () => {
  const { dir, execStatus } = fixtureRun({ verdict: 'ship' });
  const calls = [];
  const rec = await runEvaluation(deps(dir, calls, { execStatus }));
  assert.deepEqual(rec.phases, PHASE_ORDER);
  assert.equal(rec.classification.kind, 'evaluation-passed');
  assert.equal(rec.cleanup.destroyed, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('exec THROWS: still retrieve (receipt may exist), classify missing vs found, cleanup runs', async () => {
  const { dir } = fixtureRun({ verdict: 'fix' });
  const calls = [];
  const d = deps(dir, calls);
  d.exec = async () => { calls.push('exec'); throw new Error('injected executor crash'); };
  const rec = await runEvaluation(d);
  assert.equal(rec.exec.status, null);
  assert.match(rec.exec.error, /injected executor crash/);
  assert.ok(calls.includes('retrieve'), 'retrieve runs even when exec throws');
  assert.equal(rec.classification.kind, 'valid-receipt-failed-work', 'receipt existed and verifies');
  assert.equal(rec.cleanup.destroyed, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing receipt is distinguished from valid-failed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p6b-vnext-'));
  const calls = [];
  const rec = await runEvaluation(deps(dir, calls, { execStatus: 3 }));
  assert.equal(rec.retrieved.state, 'missing');
  assert.equal(rec.classification.kind, 'receipt-missing');
  assert.equal(rec.cleanup.destroyed, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('corrupted receipt JSON is distinguished from valid-failed', async () => {
  const { dir } = fixtureRun({ verdict: 'fix', corruptJson: true });
  const calls = [];
  const rec = await runEvaluation(deps(dir, calls, { execStatus: 3 }));
  assert.equal(rec.retrieved.state, 'corrupt');
  assert.equal(rec.classification.kind, 'receipt-corrupt');
  assert.match(rec.classification.reason, /not valid JSON/);
  assert.equal(rec.cleanup.destroyed, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tampered artifact makes the receipt unverifiable, not valid-failed', async () => {
  const { dir } = fixtureRun({ verdict: 'fix', tamper: true });
  const calls = [];
  const rec = await runEvaluation(deps(dir, calls, { execStatus: 3 }));
  assert.equal(rec.retrieved.state, 'ok', 'receipt itself parsed');
  assert.equal(rec.verification.state, 'failed');
  assert.equal(rec.classification.kind, 'receipt-unverifiable');
  assert.match(rec.classification.problems.join(' '), /hash mismatch/);
  assert.equal(rec.cleanup.destroyed, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('receipt verdict disagrees with process exit -> receipt-exit-disagreement', async () => {
  const { dir } = fixtureRun({ verdict: 'ship', exitOverride: 3 });
  const calls = [];
  const rec = await runEvaluation(deps(dir, calls, { execStatus: 3 }));
  assert.equal(rec.classification.kind, 'receipt-exit-disagreement');
  assert.equal(rec.classification.expected_exit, 0);
  assert.equal(rec.cleanup.destroyed, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanup runs unconditionally and retrieve throw classifies unverifiable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p6b-vnext-'));
  const calls = [];
  const rec = await runEvaluation({
    exec: async () => { calls.push('exec'); return { status: 0 }; },
    retrieve: async () => { calls.push('retrieve'); throw new Error('injected retrieve failure'); },
    verify: async () => { calls.push('verify'); return { state: 'ok', problems: [] }; },
    cleanup: async () => { calls.push('cleanup'); return { destroyed: true }; }
  });
  assert.equal(rec.retrieved.state, 'unavailable');
  assert.equal(rec.classification.kind, 'receipt-unverifiable');
  assert.match(rec.classification.problems.join(' '), /injected retrieve failure/);
  assert.equal(rec.cleanup.destroyed, true, 'cleanup ran despite retrieve throwing');
  assert.equal(calls.includes('cleanup'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('classify() direct: blocked receipt exit 4 is valid-failed, not missing', () => {
  const exec = { status: 4, error: null };
  const retrieved = { state: 'ok', receipt: { verdict: 'blocked' } };
  const verification = { state: 'ok', problems: [] };
  const c = classify(exec, retrieved, verification);
  assert.equal(c.kind, 'valid-receipt-failed-work');
  assert.equal(c.verdict, 'blocked');
});

// The 10th case is the one the newest ruling adds: receipt present, checks.json
// absent. Partial success — the original receipt is PRESERVED, the missing
// diagnostic artifact is classified explicitly, and the run is NOT discarded.
test('receipt lists checks.json but the file is missing: preserve receipt, name the diagnostic', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p6b-vnext-'));
  const output = JSON.stringify({ schema: 'reuse-ledger-observation/1', probe_capability: 'fixture-cap' }) + '\n';
  fs.writeFileSync(path.join(dir, 'output.json'), output);
  const checksText = JSON.stringify({ schema: 'rcos-checks/1', gates: [] }) + '\n';
  const receipt = {
    schema: RECEIPT_SCHEMA,
    run_id: '20260922T000001Z-abcdef',
    eval_id: 'reuse-ledger-invariant-v1',
    capability_id: 'fixture-cap',
    verdict: 'fix',
    verdict_basis: 'derived from gate exit codes',
    gates: [],
    invocation: null,
    eligibility: null,
    artifacts: [
      { path: 'output.json', sha256: sha(output), bytes: Buffer.byteLength(output) },
      { path: 'checks.json', sha256: sha(checksText), bytes: Buffer.byteLength(checksText) }
    ],
    created_at: '2026-09-22T00:00:01.000Z'
  };
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  // checks.json is deliberately NOT written: listed by the receipt, absent on disk.
  const calls = [];
  const rec = await runEvaluation(deps(dir, calls, { execStatus: 3 }));

  assert.equal(rec.retrieved.state, 'ok', 'the original receipt is preserved');
  assert.deepEqual(rec.retrieved.diagnostics_missing, ['checks.json']);
  assert.equal(rec.verification.state, 'ok', 'missing checks.json is a diagnostic gap, not a discarded run');
  assert.deepEqual(rec.verification.diagnostics_missing, ['checks.json']);
  assert.equal(rec.classification.kind, 'valid-receipt-failed-work');
  assert.equal(rec.classification.verdict, 'fix');
  assert.deepEqual(rec.classification.diagnostics_missing, ['checks.json'], 'classification names the missing artifact');
  assert.deepEqual(rec.cleanup, { destroyed: true });
  assert.equal(rec.cleanupError, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
