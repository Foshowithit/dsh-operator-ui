import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionSourceStore } from '../lib/execution-source.js';

const ctx = (overrides = {}) => ({ workspaceId: 'w1', sessionId: 's1', callId: 'c1', toolName: 'dispatch_seat', ...overrides });
const obs = (context = ctx(), overrides = {}) => ({
  ...context, kind: 'dsh-call-snapshot', phase: 'settled', observedAt: 10,
  values: { seat: 'planner', objective: 'Review', state: 'completed', verdict: 'ship', summary: 'Done', stage: 'complete', auditLog: '/tmp/audit', auditError: null, archonRunId: 'run-1', archonStatus: 'ship' },
  reportedRun: { runId: 'dispatch-1', seatSessionId: 'seat-1' }, ...overrides,
});

test('starts explicitly unknown and preserves snapshot identity until mutation', () => {
  const store = createExecutionSourceStore();
  const a = store.getSnapshot();
  assert.deepEqual(a, { context: null, availability: 'unknown', observation: null, reason: 'no-selection' });
  assert.equal(store.getSnapshot(), a);
  const token = store.select(ctx());
  const b = store.getSnapshot();
  assert.notEqual(a, b);
  assert.equal(b.availability, 'unknown');
  assert.equal(store.getSnapshot(), b);
  assert.ok(token);
});

test('accepts only exact selected identity including workspace, session, call and tool', () => {
  const store = createExecutionSourceStore();
  const context = ctx();
  const token = store.select(context);
  assert.equal(store.accept(token, obs(context)), true);
  for (const mismatch of [
    { workspaceId: 'w2' }, { sessionId: 's2' }, { callId: 'c2' }, { toolName: 'job_list' },
  ]) assert.equal(store.accept(token, obs({ ...context, ...mismatch })), false);
  assert.equal(store.getSnapshot().observation.values.state, 'completed');
});

test('selecting again creates a fresh generation and rejects delayed results, even for same identity', () => {
  const store = createExecutionSourceStore();
  const context = ctx();
  const old = store.select(context);
  const current = store.select(context);
  assert.notEqual(old, current);
  assert.equal(store.accept(old, obs(context)), false);
  assert.equal(store.getSnapshot().observation, null);
});

test('invalid selection and select(null) clear old data', () => {
  const store = createExecutionSourceStore();
  let token = store.select(ctx());
  assert.equal(store.accept(token, obs()), true);
  token = store.select({ ...ctx(), sessionId: ' ' });
  assert.equal(token, null);
  assert.equal(store.getSnapshot().context, null);
  assert.equal(store.getSnapshot().availability, 'unknown');
  const good = store.select(ctx());
  assert.equal(store.accept(good, obs()), true);
  store.select(null);
  assert.equal(store.getSnapshot().observation, null);
});

test('validates source-specific scalar allowlists and safe job count', () => {
  const store = createExecutionSourceStore();
  const job = ctx({ toolName: 'job_list' });
  const token = store.select(job);
  assert.equal(store.accept(token, { ...job, kind: 'dsh-call-snapshot', phase: 'settled', observedAt: null, values: { state: 'snapshot', summary: '2 jobs', jobCount: 2 } }), true);
  assert.equal(store.getSnapshot().observation.values.jobCount, 2);
  for (const values of [
    { state: 'snapshot', summary: 'ok', jobCount: -1 },
    { state: 'snapshot', summary: 'ok', jobCount: Number.MAX_SAFE_INTEGER + 1 },
    { state: 'snapshot', summary: 'ok', workers: 2 },
    { state: 'snapshot', summary: 'ok', progress: 0.5 },
    { state: 'snapshot', summary: 'ok', jobCount: NaN },
    { state: 'snapshot', summary: 'ok', jobCount: {} },
  ]) assert.equal(store.accept(token, { ...job, kind: 'dsh-call-snapshot', phase: 'settled', observedAt: null, values }), false);
  assert.equal(store.accept(token, { ...job, kind: 'dsh-call-snapshot', phase: 'unavailable', observedAt: null, values: { state: 'unavailable', jobCount: 0 } }), false);
  assert.equal(store.accept(token, { ...job, kind: 'dsh-call-snapshot', phase: 'settled', observedAt: null, values: { state: 'snapshot', summary: 'missing count' } }), false);
});

test('rejects blank identity, malformed envelopes, invalid times, and non-scalar values', () => {
  const store = createExecutionSourceStore();
  const context = ctx();
  const token = store.select(context);
  for (const bad of [
    { ...obs(), workspaceId: '' }, { ...obs(), kind: 'other' }, { ...obs(), observedAt: -1 },
    { ...obs(), observedAt: 8640000000000001 }, { ...obs(), observedAt: 1.5 },
    { ...obs(), values: { ...obs().values, seat: ['planner'] } },
    { ...obs(), values: { ...obs().values, random: 'extra' } },
    { ...obs(), reportedRun: { runId: 'x' } },
    { ...obs(), reportedRun: { runId: 'none', seatSessionId: 'seat-1' } },
    { ...obs(), values: { ...obs().values, state: 'unavailable' } },
    { ...obs(), values: { ...obs().values, state: 'completed', verdict: 'ship', stage: 'error' } },
    { ...obs(), values: Object.assign(Object.create({ inherited: 'bad' }), { state: 'completed' }) },
    { ...obs(), values: Object.defineProperty({}, 'state', { enumerable: true, get: () => 'completed' }) },
    { ...obs(), values: new Date() },
  ]) assert.equal(store.accept(token, bad), false, JSON.stringify({ phase: bad.phase, values: bad.values, reportedRun: bad.reportedRun }));
});

test('accepts dispatcher-stage failure without a seat-reported verdict', () => {
  const store = createExecutionSourceStore();
  const context = ctx();
  const token = store.select(context);
  const value = obs(context, { values: { seat: 'planner', objective: 'Review', state: 'failed', summary: 'Resolve failed', stage: 'resolve', auditError: 'lookup failed' } });
  assert.equal(store.accept(token, value), true);
  assert.equal(store.getSnapshot().observation.values.stage, 'resolve');
  assert.equal(store.getSnapshot().observation.values.verdict, undefined);
  assert.equal(store.accept(token, obs(context, { values: { ...value.values, verdict: 'blocked' } })), false);
});

test('enforces phase and state consistency; reported run only accompanies settled WM result', () => {
  const store = createExecutionSourceStore();
  const context = ctx();
  const token = store.select(context);
  const withoutRun = (overrides) => { const value = obs(context, overrides); delete value.reportedRun; return value; };
  assert.equal(store.accept(token, withoutRun({ phase: 'pending', values: { seat: 'planner', objective: 'Review', state: 'awaiting-result' } })), true);
  assert.equal(store.accept(token, obs(context, { phase: 'pending', values: { state: 'completed' } })), false);
  assert.equal(store.accept(token, withoutRun({ phase: 'unavailable', values: { state: 'unavailable', summary: 'missing' } })), true);
  assert.equal(store.accept(token, obs(context, { phase: 'unavailable', values: { state: 'completed' } })), false);
  assert.equal(store.accept(token, withoutRun({ phase: 'settled', values: { state: 'unavailable', summary: 'missing' } })), false);
  assert.equal(store.accept(token, withoutRun({ phase: 'settled', values: { state: 'failed', summary: 'error' } })), true);
  assert.equal(store.accept(token, obs(context, { phase: 'settled', reportedRun: { runId: ' ', seatSessionId: 'x' } })), false);
  const jobContext = ctx({ toolName: 'job_list' });
  const jobToken = store.select(jobContext);
  assert.equal(store.accept(jobToken, { ...jobContext, kind: 'dsh-call-snapshot', phase: 'settled', observedAt: null, values: { state: 'snapshot', summary: 'none', jobCount: 0 }, reportedRun: { runId: 'x', seatSessionId: 'y' } }), false);
  assert.equal(store.accept(jobToken, { ...jobContext, kind: 'dsh-call-snapshot', phase: 'settled', observedAt: null, values: { state: 'unavailable', summary: 'missing' } }), false);
});

test('copies and freezes accepted data; listener failures do not block other listeners', () => {
  const store = createExecutionSourceStore();
  const token = store.select(ctx());
  let notified = 0;
  store.subscribe(() => { throw new Error('listener'); });
  const unsubscribe = store.subscribe(() => { notified++; });
  const input = obs();
  assert.equal(store.accept(token, input), true);
  input.values.summary = 'mutated';
  assert.equal(store.getSnapshot().observation.values.summary, 'Done');
  assert.ok(Object.isFrozen(store.getSnapshot()));
  assert.ok(Object.isFrozen(store.getSnapshot().observation.values));
  assert.equal(notified, 1);
  const stable = store.getSnapshot();
  assert.equal(store.getSnapshot(), stable);
  unsubscribe();
});

test('unsubscribe and dispose stop notifications; disposal clears data and forbids reuse', () => {
  const store = createExecutionSourceStore();
  const token = store.select(ctx());
  let count = 0;
  const off = store.subscribe(() => count++);
  off();
  assert.equal(store.accept(token, obs()), true);
  assert.equal(count, 0);
  store.dispose();
  assert.equal(store.getSnapshot().context, null);
  assert.equal(store.getSnapshot().observation, null);
  assert.equal(store.accept(token, obs()), false);
  assert.equal(store.select(ctx()), null);
});

test('reentrant selection cannot make the outer select return a newer generation', () => {
  const store = createExecutionSourceStore();
  let newer;
  let reentered = false;
  store.subscribe(() => {
    if (!reentered) { reentered = true; newer = store.select(ctx({ callId: 'c2' })); }
  });
  const outer = store.select(ctx());
  assert.equal(outer, null);
  assert.ok(newer);
  assert.equal(store.accept(outer, obs()), false);
  assert.equal(store.accept(newer, obs(ctx({ callId: 'c2' }))), true);
});

test('rejects hidden own fields across every input record without invoking accessors', () => {
  const store = createExecutionSourceStore();
  const context = ctx();
  for (const addKey of [
    (record) => Object.defineProperty(record, 'extra', { value: 'hidden' }),
    (record) => Object.defineProperty(record, Symbol('extra'), { value: 'hidden' }),
  ]) {
    const hiddenContext = ctx();
    addKey(hiddenContext);
    assert.equal(store.select(hiddenContext), null);
  }
  const token = store.select(context);
  for (const addKey of [
    (record) => Object.defineProperty(record, 'extra', { value: 'hidden' }),
    (record) => Object.defineProperty(record, Symbol('extra'), { value: 'hidden' }),
  ]) {
    const hiddenObservation = obs(context);
    addKey(hiddenObservation);
    assert.equal(store.accept(token, hiddenObservation), false);
    const hiddenValues = obs(context);
    addKey(hiddenValues.values);
    assert.equal(store.accept(token, hiddenValues), false);
    const hiddenReportedRun = obs(context);
    addKey(hiddenReportedRun.reportedRun);
    assert.equal(store.accept(token, hiddenReportedRun), false);
  }

  let called = false;
  const accessor = obs(context);
  Object.defineProperty(accessor.values, 'summary', { enumerable: true, get() { called = true; return 'unsafe'; } });
  assert.equal(store.accept(token, accessor), false);
  assert.equal(called, false);
});
