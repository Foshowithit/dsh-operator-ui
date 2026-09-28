import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCapabilityView } from '../lib/capability-view.js';

const fact = (state, ...reasons) => ({ state, reasons });
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
const registry = (records = [{}]) => ({
  registry_version: 'v1',
  capabilities: records.map((record) => ({ id: 'cap-a', version: '1.0.0', status: 'promoted', workflow: 'wf-a', dependencies: [], ...record })),
});
const project = (records, observations = readyObservations()) => projectCapabilityView({ registry: registry(records), observations });

test('missing registry and unsupported registry schema return named errors and no entries', () => {
  for (const input of [undefined, null, {}, { registry_version: 'v2', capabilities: [] }, { registry_version: 'v1' }]) {
    const result = projectCapabilityView({ registry: input });
    assert.deepEqual(result.entries, []);
    assert.ok(result.errors.length > 0);
    assert.equal(result.schema, 'operator-capability-view/1');
  }
});

test('a null-workflow candidate is present but not executable or eligible', () => {
  const result = project([{ status: 'candidate', workflow: null }]);
  assert.equal(result.entries[0].present.state, 'yes');
  assert.equal(result.entries[0].binding, null);
  assert.equal(result.entries[0].executable.state, 'no');
  assert.equal(result.entries[0].eligible.state, 'no');
});

test('historical evals and provenance do not establish verification, install, or execution', () => {
  const result = projectCapabilityView({ registry: registry([{ evals: [{ verdict: 'ship' }], provenance: { evalSet: [{ pass: true }], measurerSha256: 'abc' }, workflow: null }]) });
  assert.equal(result.entries[0].verified.state, 'unknown');
  assert.equal(result.entries[0].installed.state, 'unknown');
  assert.equal(result.entries[0].executable.state, 'no');
  assert.equal(result.entries[0].eligible.state, 'no');
});

test('every declared dependency needs an explicit same-named observation', () => {
  const result = project([{ dependencies: [{ name: 'ffmpeg' }] }], readyObservations({ dependencies: [] }));
  assert.equal(result.entries[0].executable.state, 'unknown');
  assert.match(result.entries[0].executable.reasons.join(' '), /dependenc/i);
  const no = project([{ dependencies: [{ name: 'ffmpeg' }] }], readyObservations({ dependencies: [{ name: 'ffmpeg', fact: fact('no', 'missing') }] }));
  assert.equal(no.entries[0].executable.state, 'no');
});

test('a missing or malformed dependency declaration is unknown, not an empty list', () => {
  const missing = registry([{}]); delete missing.capabilities[0].dependencies;
  assert.equal(projectCapabilityView({ registry: missing, observations: readyObservations() }).entries[0].executable.state, 'unknown');
  const malformed = project([{ dependencies: 'ffmpeg' }]);
  assert.equal(malformed.entries[0].executable.state, 'unknown');
});

test('dependency declaration items have only a name field', () => {
  const result = project([{ dependencies: [{ name: 'ffmpeg', available: true }] }]);
  assert.equal(result.entries[0].executable.state, 'unknown');
});

test('requires permission scopes are not machine dependencies', () => {
  const result = project([{ requires: ['filesystem:read', 'shell:execute'] }]);
  assert.equal(result.entries[0].executable.state, 'yes');
});

test('wrong observed version or digest lends no capability facts', () => {
  const version = project([{ sourceDigest: 'sha256:abc' }], readyObservations({ version: '2.0.0', sourceDigest: 'sha256:abc' }));
  assert.equal(version.entries[0].installed.state, 'unknown');
  assert.equal(version.entries[0].verified.state, 'unknown');
  assert.equal(version.entries[0].executable.state, 'unknown');
  const digest = project([{ sourceDigest: 'sha256:abc' }], readyObservations({ sourceDigest: 'sha256:def' }));
  assert.equal(digest.entries[0].verified.state, 'unknown');
  const missing = project([{ sourceDigest: 'sha256:abc' }], readyObservations());
  assert.equal(missing.entries[0].installed.state, 'unknown');
});

test('duplicate registry IDs omit every collision; duplicate observation identity is unknown', () => {
  const dup = project([{ id: 'cap-a' }, { id: 'cap-a', version: '2.0.0' }]);
  assert.equal(dup.entries.length, 0);
  assert.ok(dup.errors.some((error) => error.code === 'duplicate-registry-id'));
  const obs = readyObservations(); obs.capabilities.push(structuredClone(obs.capabilities[0]));
  const duplicateObservation = project([{}], obs);
  assert.equal(duplicateObservation.entries[0].installed.state, 'unknown');
  assert.ok(duplicateObservation.errors.some((error) => error.code === 'duplicate-observation-identity'));
});

test('missing authority prevents eligibility while retaining executable fact', () => {
  const observations = readyObservations();
  delete observations.capabilities[0].authority;
  const result = project([{}], observations);
  assert.equal(result.entries[0].executable.state, 'yes');
  assert.equal(result.entries[0].eligible.state, 'unknown');
});

test('fully evidenced promoted capability is eligible as a display fact', () => {
  const result = project([{}]);
  assert.equal(result.entries[0].executable.state, 'yes');
  assert.equal(result.entries[0].eligible.state, 'yes');
});

test('candidate, retired, and seed records remain ineligible despite affirmative observations', () => {
  for (const record of [{ status: 'candidate' }, { status: 'retired' }, { seed: true }]) {
    const result = project([record]);
    assert.equal(result.entries[0].eligible.state, 'no');
  }
});

test('malformed seed markers omit the entry instead of silently allowing eligibility', () => {
  const result = project([{ seed: 'true' }]);
  assert.equal(result.entries.length, 0);
  assert.ok(result.errors.some((error) => error.code === 'invalid-registry-entry'));
});

test('unknown and unavailable catalog/runtime states do not claim executable', () => {
  const unknownCatalog = readyObservations(); unknownCatalog.workflowCatalog.state = 'unknown';
  assert.equal(project([{}], unknownCatalog).entries[0].executable.state, 'unknown');
  const unavailable = readyObservations(); unavailable.workflowCatalog.state = 'unavailable';
  assert.equal(project([{}], unavailable).entries[0].executable.state, 'no');
  const unknownRuntime = readyObservations(); unknownRuntime.runtime.compatible = fact('unknown', 'not checked');
  assert.equal(project([{}], unknownRuntime).entries[0].executable.state, 'unknown');
  const incompatible = readyObservations(); incompatible.runtime.compatible = fact('no', 'unsupported runtime');
  assert.equal(project([{}], incompatible).entries[0].executable.state, 'no');
});

test('workflow binding is never inferred from ID, kind, tags, adapter, or description', () => {
  const result = project([{ workflow: '', kind: 'workflow', id: 'wf-a', tags: ['wf-a'], adapter: 'wf-a', description: 'wf-a' }]);
  assert.equal(result.entries[0].binding, null);
  assert.equal(result.entries[0].executable.state, 'no');
});

test('padded workflow binding is preserved exactly and does not match a trimmed catalog name', () => {
  const result = project([{ workflow: ' wf-a ' }]);
  assert.deepEqual(result.entries[0].binding, { kind: 'archon-workflow', workflowName: ' wf-a ' });
  assert.equal(result.entries[0].executable.state, 'no');
});

test('an overlong explicit workflow binding is rejected instead of truncated', () => {
  const result = project([{ workflow: 'w'.repeat(181) }]);
  assert.equal(result.entries.length, 0);
  assert.ok(result.errors.some((error) => error.code === 'invalid-registry-entry'));
});

test('identity and digest comparisons preserve exact source values', () => {
  const input = registry([{ id: ' cap-a ', version: '1.0.0', sourceDigest: ' sha256:abc ' }]);
  const result = projectCapabilityView({ registry: input, observations: readyObservations({ id: ' cap-a ', version: '1.0.0', sourceDigest: 'sha256:abc' }) });
  assert.equal(result.entries[0].id, ' cap-a ');
  assert.equal(result.entries[0].sourceDigest, ' sha256:abc ');
  assert.equal(result.entries[0].installed.state, 'unknown');
});

test('identity matching cannot collide across embedded separators', () => {
  const input = { registry_version: 'v1', capabilities: [{ id: 'a\u0000b', version: 'c', status: 'promoted', workflow: null, dependencies: [] }] };
  const observations = readyObservations({ id: 'a', version: 'b\u0000c' });
  const result = projectCapabilityView({ registry: input, observations });
  assert.equal(result.entries[0].id, 'a\u0000b');
  assert.equal(result.entries[0].verified.state, 'unknown');
});

test('entries sort by code-unit ID and inputs remain unchanged', () => {
  const input = registry([{ id: 'z', version: '1', workflow: null }, { id: 'A', version: '1', workflow: null }, { id: 'a', version: '1', workflow: null }]);
  const before = structuredClone(input);
  const result = projectCapabilityView({ registry: input });
  assert.deepEqual(result.entries.map((entry) => entry.id), ['A', 'a', 'z']);
  assert.deepEqual(input, before);
});

test('accessors are not invoked and hidden/symbol/unsupported values fail closed', () => {
  let invoked = false;
  const accessor = { id: 'cap-a', version: '1.0.0', status: 'promoted', workflow: 'wf-a', dependencies: [] };
  Object.defineProperty(accessor, 'sourceDigest', { enumerable: true, get() { invoked = true; return 'x'; } });
  const result = projectCapabilityView({ registry: { registry_version: 'v1', capabilities: [accessor] }, observations: readyObservations() });
  assert.equal(invoked, false);
  assert.equal(result.entries.length, 0);
  assert.ok(result.errors.length);
  let optionGetterInvoked = false;
  const unsafeOptions = {};
  Object.defineProperty(unsafeOptions, 'registry', { enumerable: true, get() { optionGetterInvoked = true; return registry(); } });
  assert.equal(projectCapabilityView(unsafeOptions).entries.length, 0);
  assert.equal(optionGetterInvoked, false);
  const hidden = { registry_version: 'v1', capabilities: [] };
  Object.defineProperty(hidden, 'secretish', { value: 'x' });
  assert.equal(projectCapabilityView({ registry: hidden }).entries.length, 0);
  const symbol = { registry_version: 'v1', capabilities: [] }; symbol[Symbol('x')] = 1;
  assert.equal(projectCapabilityView({ registry: symbol }).entries.length, 0);
  const invalidFact = readyObservations(); invalidFact.capabilities[0].verified = { state: 'yes', reasons: [], extra: undefined };
  assert.equal(project([{}], invalidFact).entries[0].verified.state, 'unknown');
});

test('malformed individual entries are omitted without poisoning valid siblings', () => {
  const input = { registry_version: 'v1', capabilities: [null, { id: 'ok', version: '1', status: 'candidate' }] };
  const result = projectCapabilityView({ registry: input });
  assert.deepEqual(result.entries.map((entry) => entry.id), ['ok']);
  assert.ok(result.errors.some((error) => error.code === 'invalid-registry-entry'));
});

test('an unsafe registry row is omitted while an independent valid row still projects', () => {
  let invoked = false;
  const unsafe = { id: 'bad', version: '1', status: 'promoted', dependencies: [] };
  Object.defineProperty(unsafe, 'workflow', { enumerable: true, get() { invoked = true; return 'wf-a'; } });
  const input = { registry_version: 'v1', capabilities: [unsafe, { id: 'good', version: '1', status: 'candidate', workflow: null, dependencies: [] }] };
  const result = projectCapabilityView({ registry: input });
  assert.equal(invoked, false);
  assert.deepEqual(result.entries.map((entry) => entry.id), ['good']);
});

test('an unsafe row with a readable duplicate ID suppresses the valid colliding row', () => {
  let invoked = false;
  const unsafe = { id: 'cap-a', version: '2', status: 'candidate', dependencies: [] };
  Object.defineProperty(unsafe, 'workflow', { enumerable: true, get() { invoked = true; return null; } });
  const input = { registry_version: 'v1', capabilities: [
    { id: 'cap-a', version: '1', status: 'candidate', workflow: null, dependencies: [] },
    unsafe,
  ] };
  const result = projectCapabilityView({ registry: input });
  assert.equal(invoked, false);
  assert.equal(result.entries.some((entry) => entry.id === 'cap-a'), false);
  assert.ok(result.errors.some((error) => error.code === 'duplicate-registry-id'));
});
