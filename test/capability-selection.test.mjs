import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCapability, SELECTION_SCHEMA } from '../lib/capability-selection.js';

const fact = (state, ...reasons) => ({ state, reasons });
const registry = (records = [{}]) => ({
  registry_version: 'v1',
  capabilities: records.map((record) => ({ id: 'cap-a', version: '1.0.0', status: 'promoted', workflow: 'wf-a', dependencies: [], ...record })),
});
const readyObservations = (capability = {}) => ({
  schema: 'operator-capability-observations/1',
  runtime: { compatible: fact('yes', 'runtime compatible') },
  workflowCatalog: { state: 'available', names: ['wf-a'], reasons: [] },
  capabilities: [{
    id: 'cap-a', version: '1.0.0', installed: fact('yes', 'installed'),
    verified: fact('yes', 'independently verified'), dependencies: [], authority: fact('yes', 'authorized in this context'),
    ...capability,
  }],
});
const select = (over = {}, observations = readyObservations(), records = [{}]) => selectCapability({
  registry: registry(records),
  observations,
  selection: { id: 'cap-a', version: '1.0.0', ...over },
});

test('selection schema is frozen', () => {
  assert.equal(SELECTION_SCHEMA, 'operator-capability-selection/1');
});

test('ready capability resolves to its exact archon-workflow binding', () => {
  const result = select();
  assert.equal(result.ok, true);
  assert.equal(result.schema, SELECTION_SCHEMA);
  assert.deepEqual(result.selection, { id: 'cap-a', version: '1.0.0', sourceDigest: null });
  assert.deepEqual(result.binding, { kind: 'archon-workflow', workflowName: 'wf-a' });
});

test('missing selection fails closed without a binding or alternate', () => {
  for (const selection of [undefined, null, {}, { id: 'cap-a' }, { version: '1.0.0' }, { id: '', version: '1.0.0' }]) {
    const result = selectCapability({ registry: registry(), observations: readyObservations(), selection });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'selection-required');
    assert.equal(result.binding ?? null, null);
    assert.equal(result.alternate ?? null, null);
  }
});

test('unknown id or version never resolves — no lexical fallback', () => {
  for (const selection of [
    { id: 'cap-b', version: '1.0.0' },
    { id: 'cap-a', version: '2.0.0' },
    { id: 'cap', version: '1.0.0' },
    { id: 'CAP-A', version: '1.0.0' },
  ]) {
    const result = selectCapability({ registry: registry(), observations: readyObservations(), selection });
    assert.equal(result.ok, false, JSON.stringify(selection));
    assert.equal(result.code, 'unknown-capability');
    assert.equal(result.binding ?? null, null);
  }
});

test('a changed registry unresolves a prior selection', () => {
  const before = select();
  assert.equal(before.ok, true);
  const after = selectCapability({
    registry: registry([{ id: 'cap-other', version: '1.0.0' }]),
    observations: readyObservations(),
    selection: { id: 'cap-a', version: '1.0.0' },
  });
  assert.equal(after.ok, false);
  assert.equal(after.code, 'unknown-capability');
});

test('a digest mismatch is stale identity, not a silent rebind', () => {
  const pinned = selectCapability({
    registry: registry([{ sourceDigest: 'sha256:abc' }]),
    observations: readyObservations({ sourceDigest: 'sha256:abc' }),
    selection: { id: 'cap-a', version: '1.0.0', sourceDigest: 'sha256:def' },
  });
  assert.equal(pinned.ok, false);
  assert.equal(pinned.code, 'stale-identity');
  const match = selectCapability({
    registry: registry([{ sourceDigest: 'sha256:abc' }]),
    observations: readyObservations({ sourceDigest: 'sha256:abc' }),
    selection: { id: 'cap-a', version: '1.0.0', sourceDigest: 'sha256:abc' },
  });
  assert.equal(match.ok, true);
  assert.equal(match.selection.sourceDigest, 'sha256:abc');
});

test('a null-workflow record has no binding to select', () => {
  const result = select({}, readyObservations(), [{ status: 'candidate', workflow: null }]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'absent-binding');
});

test('unexecutable and ineligible records refuse with entry reasons', () => {
  const dep = select({}, readyObservations(), [{ dependencies: [{ name: 'ffmpeg' }] }]);
  assert.equal(dep.ok, false);
  assert.equal(dep.code, 'not-executable');
  assert.ok(dep.reasons.join(' ').length > 0);
  const cand = select({}, readyObservations(), [{ status: 'candidate' }]);
  assert.equal(cand.ok, false);
  assert.equal(cand.code, 'not-eligible');
  const denied = selectCapability({
    registry: registry(),
    observations: readyObservations({ authority: fact('no', 'scope denied by policy') }),
    selection: { id: 'cap-a', version: '1.0.0' },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'not-eligible');
  assert.ok(denied.reasons.join(' ').length > 0);
  for (const r of [dep, cand, denied]) {
    assert.equal(r.binding ?? null, null);
    assert.equal(r.alternate ?? null, null);
  }
});

test('duplicate submits are deterministic and dispatch nothing', () => {
  const first = select();
  const second = select();
  assert.deepEqual(second, first);
  assert.equal(typeof first.dispatch, 'undefined');
  const refusal = selectCapability({ registry: registry(), observations: readyObservations(), selection: { id: 'nope', version: '0.0.0' } });
  assert.deepEqual(selectCapability({ registry: registry(), observations: readyObservations(), selection: { id: 'nope', version: '0.0.0' } }), refusal);
});

test('malformed inputs fail closed', () => {
  const evil = { id: 'cap-a', version: '1.0.0' };
  Object.defineProperty(evil, 'extra', { enumerable: true, get: () => 1 });
  const result = selectCapability({ registry: registry(), observations: readyObservations(), selection: evil });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'selection-required');
});
