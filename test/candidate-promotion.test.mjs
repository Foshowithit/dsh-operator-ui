// test/candidate-promotion.test.mjs — the plain-candidate promotion gate.
//
// Proves the ordered, evidence-checked decision and the operator-explicit
// promotion. The load-bearing properties:
//   - the gate MIRRORS the canonical x2-ship rule in lib/registry.js
//   - reuse count alone can NEVER promote
//   - a single-task x2 ship (same task twice) refuses — transfer, not memorization
//   - a ship eval with no run_id refuses — "no run id, no admission"
//   - promotion without an operator assertion refuses
//   - retirement is ARMED at admission (never later)
//   - the real `mac-dell-staging` registry entry, as measured on the Dell, PASSES
//
// SCHEMA-HONESTY NOTE: an earlier revision asserted legs on `verification.
// expectOutput` and `objectiveEvaluation.kind`. Those fields do not exist in the
// canonical registry (all 42 promoted capabilities lack them). Those tests were
// removed WITH the invented legs — a test for a gate that cannot fire on real
// data is itself the defect.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePromotion, promotedEntry, PROMOTION_SCHEMA, RETIREMENT_POLICY_VERSION } from '../lib/candidate-promotion.js';

// A canonical-shaped candidate: the real registry entry schema.
const goodEntry = () => ({
  id: 'cap-x', status: 'candidate', version: '0.1.0', kind: 'script',
  provenance: { builtBy: 'codex' },
  adapter: { type: 'command', entrypoint: 'capabilities/cap-x/adapter/run.js', contract: 'capabilities/cap-x/contract.json' },
  evals: [
    { task_id: 'task-a', verdict: 'ship', run_id: 'run-1', provenance: 'executed' },
    { task_id: 'task-b', verdict: 'ship', run_id: 'run-2', provenance: 'executed' },
  ],
});
const goodContract = () => ({ input: { type: 'object' }, output: { type: 'object' } });

test('a canonical x2-ship candidate passes every leg', () => {
  const d = evaluatePromotion({ entry: goodEntry(), contract: goodContract(), ledger: { records: [] } });
  assert.equal(d.promote, true, JSON.stringify(d.legs.filter((l) => !l.pass)));
  assert.equal(d.headlineCode, null);
  assert.equal(d.schema, PROMOTION_SCHEMA);
  assert.equal(d.shipCount, 2);
  assert.deepEqual(d.distinctShipTasks, ['task-a', 'task-b']);
});

test('reuse count ALONE never promotes (no ship evals → refuse)', () => {
  const ledger = { records: [{ runId: 'r1', capabilityId: 'cap-x' }, { runId: 'r2', capabilityId: 'cap-x' }] };
  const e = goodEntry(); e.evals = [];
  const d = evaluatePromotion({ entry: e, contract: goodContract(), ledger });
  assert.equal(d.promote, false);
  assert.equal(d.headlineCode, 'x2-ship-insufficient');
  assert.equal(d.reuseCount, 2);
});

test('one ship eval is not enough (x2 means two)', () => {
  const e = goodEntry(); e.evals = [e.evals[0]];
  const d = evaluatePromotion({ entry: e, contract: goodContract(), ledger: { records: [] } });
  assert.equal(d.promote, false);
  assert.equal(d.headlineCode, 'x2-ship-insufficient');
});

test('two ships on the SAME task refuse — transfer, not memorization', () => {
  const e = goodEntry();
  e.evals = [
    { task_id: 'task-a', verdict: 'ship', run_id: 'run-1', provenance: 'executed' },
    { task_id: 'task-a', verdict: 'ship', run_id: 'run-2', provenance: 'executed' },
  ];
  const d = evaluatePromotion({ entry: e, contract: goodContract(), ledger: { records: [] } });
  assert.equal(d.promote, false);
  assert.equal(d.headlineCode, 'x2-tasks-not-distinct');
});

test('a ship eval with no run_id refuses — no run id, no admission', () => {
  const e = goodEntry();
  e.evals[1].run_id = '   ';
  const d = evaluatePromotion({ entry: e, contract: goodContract(), ledger: { records: [] } });
  assert.equal(d.promote, false);
  assert.equal(d.headlineCode, 'x2-run-id-missing');
});

test('asserted-only ships still pass the canonical rule but are COUNTERED not fatal', () => {
  const e = goodEntry();
  e.evals = e.evals.map((x) => ({ ...x, provenance: 'asserted' }));
  const d = evaluatePromotion({ entry: e, contract: goodContract(), ledger: { records: [] } });
  assert.equal(d.promote, true);
  assert.equal(d.executedShipCount, 0);
});

test('the FIRST failing leg is the headline, in order', () => {
  const e = goodEntry(); e.status = 'retired';
  const d = evaluatePromotion({ entry: e, contract: goodContract(), ledger: { records: [] } });
  assert.equal(d.headlineCode, 'not-a-candidate');
});

test('no runtime binding and no workflow refuses', () => {
  const e = goodEntry(); delete e.adapter.entrypoint;
  const d = evaluatePromotion({ entry: e, contract: goodContract(), ledger: { records: [] } });
  assert.equal(d.promote, false);
  assert.ok(d.remaining.includes('runtime-unbound'));
});

test('no contract (inline or adapter path) refuses', () => {
  const e = goodEntry(); delete e.adapter.contract;
  const d = evaluatePromotion({ entry: e, contract: undefined, ledger: { records: [] } });
  assert.equal(d.promote, false);
  assert.ok(d.remaining.includes('contract-absent'));
});

test('an independent eval set is OPTIONAL — absent is not a failure', () => {
  const d = evaluatePromotion({ entry: goodEntry(), contract: goodContract(), ledger: { records: [] } });
  assert.equal(d.promote, true);
  assert.equal(d.legs.some((l) => l.id === 'independent-eval-set'), false);
});

test('an empty independent eval set, when supplied, is a NAMED gap', () => {
  const d = evaluatePromotion({ entry: goodEntry(), contract: goodContract(), evalSet: [], ledger: { records: [] } });
  assert.equal(d.promote, false);
  assert.ok(d.remaining.includes('independent-evals-absent'));
});

test('promotion without an operator assertion refuses', () => {
  const e = goodEntry();
  const d = evaluatePromotion({ entry: e, contract: goodContract(), ledger: { records: [] } });
  const r = promotedEntry({ entry: e, decision: d, operatorAsserted: false, at: '2026-10-08' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'operator-assertion-required');
});

test('promotion on a failed decision refuses and NAMES the failing leg', () => {
  const e = goodEntry(); e.evals = [];
  const d = evaluatePromotion({ entry: e, contract: goodContract(), ledger: { records: [] } });
  const r = promotedEntry({ entry: e, decision: d, operatorAsserted: true, at: '2026-10-08' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'x2-ship-insufficient');
});

test('a passing promotion ARMS retirement at admission, like rcos promote', () => {
  const e = goodEntry();
  const d = evaluatePromotion({ entry: e, contract: goodContract(), ledger: { records: [] } });
  const r = promotedEntry({ entry: e, decision: d, operatorAsserted: true, at: '2026-10-08' });
  assert.equal(r.ok, true);
  assert.equal(r.entry.status, 'promoted');
  assert.deepEqual(r.entry.admitted_after, ['task-a', 'task-b']);
  assert.equal(r.entry.retirement.policy_version, RETIREMENT_POLICY_VERSION);
  assert.equal(r.entry.retirement.armed_at, '2026-10-08');
  assert.equal(r.entry.rollback.toStatus, 'candidate');
  assert.equal(r.entry.provenance.promotionEvidence.schema, PROMOTION_SCHEMA);
});

test('promotion preserves an already-armed retirement (never re-dates it)', () => {
  const e = goodEntry();
  e.retirement = { armed_at: '2026-09-01', policy_version: RETIREMENT_POLICY_VERSION, decay: { window: 5, threshold: null }, neglect: { n: 20, threshold: null } };
  const d = evaluatePromotion({ entry: e, contract: goodContract(), ledger: { records: [] } });
  assert.equal(d.promote, true);
  const r = promotedEntry({ entry: e, decision: d, operatorAsserted: true, at: '2026-10-08' });
  assert.equal(r.entry.retirement.armed_at, '2026-09-01');
});

// ---------------------------------------------------------------------------
// THE REAL ENTRY. Measured from the Dell canonical registry on 2026-10-08:
//   mac-dell-staging v0.1.0, status=candidate, workflow=mac-dell-staging-v1,
//   three executed ship evals on three distinct task ids, each with a run_id.
// If this test ever fails, the gate has drifted from the registry it gates.
// ---------------------------------------------------------------------------
const REAL_MAC_DELL_STAGING = {
  id: 'mac-dell-staging', name: 'Mac→Dell staging and reviewed publication',
  kind: 'script', version: '0.1.0', status: 'candidate', workflow: 'mac-dell-staging-v1',
  evals: [
    { task_id: 'mac-dell-staging-both-arms-control', verdict: 'ship', run_id: '20261009T000041Z-20cdc2', provenance: 'executed' },
    { task_id: 'mac-dell-staging-neg-badhash', verdict: 'ship', run_id: '20261009T000041Z-8a2794', provenance: 'executed' },
    { task_id: 'mac-dell-staging-neg-oversize', verdict: 'ship', run_id: '20261009T000041Z-5b60a5', provenance: 'executed' },
  ],
  provenance: { builtBy: 'codex-dsh-desktop-rcos', adapterEntry: 'adapter/run.js', contractPath: 'contract.json' },
  adapter: { type: 'command', entrypoint: 'capabilities/mac-dell-staging/adapter/run.js', timeout_seconds: 60, contract: 'capabilities/mac-dell-staging/contract.json' },
};

test('the REAL mac-dell-staging entry passes the canonical gate', () => {
  const d = evaluatePromotion({ entry: REAL_MAC_DELL_STAGING, ledger: { records: [] } });
  assert.equal(d.promote, true, JSON.stringify(d.legs.filter((l) => !l.pass)));
  assert.equal(d.shipCount, 3);
  assert.equal(d.executedShipCount, 3);
  assert.equal(d.distinctShipTasks.length, 3);
});

test('the REAL mac-dell-staging entry promotes with retirement armed', () => {
  const d = evaluatePromotion({ entry: REAL_MAC_DELL_STAGING, ledger: { records: [] } });
  const r = promotedEntry({ entry: REAL_MAC_DELL_STAGING, decision: d, operatorAsserted: true, at: '2026-10-08' });
  assert.equal(r.ok, true);
  assert.equal(r.entry.status, 'promoted');
  assert.equal(r.entry.retirement.armed_at, '2026-10-08');
  assert.equal(r.entry.admitted_after.length, 3);
});
