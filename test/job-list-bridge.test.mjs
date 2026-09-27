import test from 'node:test';
import assert from 'node:assert/strict';
import { jobListBridge } from '../lib/job-list-bridge.js';

const exec = { name: 'job_list', callId: 'call-job-list-1' };
const content = [{ type: 'text', text: 'Found 1 job.' }];
const rows = [{
  id: 'job-1',
  kind: 'build',
  label: 'Build release',
  status: 'completed',
  detail: 'Built successfully',
  startedAt: 1700000000000,
  finishedAt: 1700000001000,
}];
const result = { isError: false, value: rows, content };
const accept = async () => ({ kind: 'accept', additionalContexts: [] });

test('preserves text and attaches a versioned call-bound envelope for an empty list', async () => {
  const out = await jobListBridge(exec, { ...result, value: [] }, accept);
  assert.equal(out.kind, 'accept');
  assert.deepEqual(out.content[0], content[0]);
  assert.deepEqual(JSON.parse(out.content[1].text), {
    operatorJobList: { version: 1, callId: 'call-job-list-1', toolName: 'job_list', jobs: [] },
  });
  assert.deepEqual(out.additionalContexts, []);
});

test('copies all public snapshot fields into the envelope', async () => {
  const out = await jobListBridge(exec, result, accept);
  assert.deepEqual(JSON.parse(out.content[1].text).operatorJobList.jobs, rows);
});

test('strips private and unknown fields from snapshots', async () => {
  const privateRow = {
    ...rows[0],
    ownerSession: 'secret-session',
    reported: true,
    privateToken: 'secret-token',
  };
  const out = await jobListBridge(exec, { ...result, value: [privateRow] }, accept);
  assert.deepEqual(JSON.parse(out.content[1].text).operatorJobList.jobs, rows);
  assert.doesNotMatch(out.content[1].text, /secret-session|secret-token|ownerSession|reported/);
});

test('omits absent optional fields and rejects malformed arrays or snapshot fields', async () => {
  const minimal = { id: 'job-2', kind: 'test', label: 'Tests', status: 'running', startedAt: 1700000000000 };
  const out = await jobListBridge(exec, { ...result, value: [minimal] }, accept);
  assert.deepEqual(JSON.parse(out.content[1].text).operatorJobList.jobs, [minimal]);

  const malformedValues = [
    null,
    {},
    [null],
    [{ ...minimal, id: 4 }],
    [{ ...minimal, kind: null }],
    [{ ...minimal, label: false }],
    [{ ...minimal, status: 'queued' }],
    [{ ...minimal, startedAt: 1.5 }],
    [{ ...minimal, detail: 7 }],
    [{ ...minimal, finishedAt: 'later' }],
  ];
  for (const value of malformedValues) {
    const decision = await jobListBridge(exec, { ...result, value }, accept);
    assert.equal(decision.kind, 'accept');
    assert.equal(Object.hasOwn(decision, 'content'), false);
  }
});

test('skips an envelope larger than 96 KiB', async () => {
  const large = [{ ...rows[0], detail: 'x'.repeat(100 * 1024) }];
  const decision = await jobListBridge(exec, { ...result, value: large }, accept);
  assert.equal(decision.kind, 'accept');
  assert.equal(Object.hasOwn(decision, 'content'), false);
});

test('downstream refusal or content/value replacement remains authoritative', async () => {
  for (const decision of [
    { kind: 'block', feedback: [{ type: 'text', text: 'denied' }] },
    { kind: 'accept', content: [] },
    { kind: 'accept', value: [] },
  ]) {
    assert.equal(await jobListBridge(exec, result, async () => decision), decision);
  }
});

test('errors, other tools, missing call ids, and malformed result content pass unchanged', async () => {
  const decision = { kind: 'accept' };
  const cases = [
    [{ name: 'other', callId: exec.callId }, result],
    [{ name: 'job_list' }, result],
    [exec, { ...result, isError: true }],
    [exec, { ...result, content: null }],
  ];
  for (const [execution, toolResult] of cases) {
    assert.equal(await jobListBridge(execution, toolResult, async () => decision), decision);
  }
});

test('a downstream delegate rejection propagates', async () => {
  await assert.rejects(
    jobListBridge(exec, result, async () => { throw new Error('gate failed'); }),
    /gate failed/,
  );
});
