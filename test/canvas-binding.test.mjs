import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBindingSource, BINDING_SCHEMA } from '../lib/canvas-binding.js';

const sources = {
  runs: { 'run-1': { streams: { summary: 'done', count: 3, ok: true, nothing: null } } },
  artifacts: { 'art-1': 'artifact-bytes-ref' },
};
const resolve = (ref, over = {}) => resolveBindingSource({ ...sources, ...over }, ref);

test('binding schema is frozen', () => {
  assert.equal(BINDING_SCHEMA, 'operator-canvas-binding/1');
});

test('run streams and artifacts resolve without fetching', () => {
  assert.deepEqual(resolve('run:run-1/streams/summary'), { ok: true, schema: BINDING_SCHEMA, kind: 'run-stream', id: 'run-1', name: 'summary', value: 'done' });
  assert.deepEqual(resolve('run:run-1/streams/count'), { ok: true, schema: BINDING_SCHEMA, kind: 'run-stream', id: 'run-1', name: 'count', value: 3 });
  assert.deepEqual(resolve('artifact:art-1'), { ok: true, schema: BINDING_SCHEMA, kind: 'artifact', id: 'art-1', value: 'artifact-bytes-ref' });
});

test('missing entries return explicit unknowns', () => {
  for (const [ref, code] of [
    ['run:nope/streams/summary', 'unknown-run'],
    ['run:run-1/streams/nope', 'unknown-stream'],
    ['artifact:nope', 'unknown-artifact'],
  ]) {
    const r = resolve(ref);
    assert.equal(r.ok, false, ref);
    assert.equal(r.code, code);
    assert.ok(r.reason.length > 0);
    assert.equal(r.value ?? null, null);
  }
});

test('paths, URLs, call ids, and malformed refs never authorize a read', () => {
  for (const ref of [
    '/etc/passwd', '../secret', 'https://example.com/x', 'file:///tmp/x',
    'callId:abc123', 'session:s1', 'run:', 'artifact:', 'run:run-1',
    'run:run-1/streams', 'run:run-1/streams/a/b', 'blob:art-1',
    'run:run 1/streams/summary', '', 'RUN:run-1/streams/summary',
  ]) {
    const r = resolve(ref, {});
    assert.equal(r.ok, false, JSON.stringify(ref));
    assert.equal(r.value ?? null, null);
  }
  assert.equal(resolve(null).ok, false);
  assert.equal(resolve(42).ok, false);
});

test('non-scalar sources are refused, never handed to a renderer', () => {
  const r = resolve('run:run-1/streams/summary', { runs: { 'run-1': { streams: { summary: { nested: true } } } } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'non-scalar-source');
  const arr = resolve('artifact:art-1', { artifacts: { 'art-1': [1, 2] } });
  assert.equal(arr.ok, false);
  assert.equal(arr.code, 'non-scalar-source');
});

test('accessor-bearing dictionaries are malformed', () => {
  const evil = {};
  Object.defineProperty(evil, 'art-1', { enumerable: true, get: () => 'x' });
  const r = resolve('artifact:art-1', { artifacts: evil });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'malformed-sources');
});
