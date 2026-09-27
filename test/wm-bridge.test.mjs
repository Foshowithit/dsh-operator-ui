import test from 'node:test';
import assert from 'node:assert/strict';
import { wmReceiptBridge } from '../lib/wm-bridge.js';

const exec = { name: 'dispatch_seat', callId: 'call-1' };
const value = { dispatch: { run_id: 'sd-1', seat: 'wm' }, stage: 'complete', receipt: { verdict: 'ship' } };
const content = [{ type: 'text', text: 'original dispatcher summary' }];
const result = { isError: false, value, content };

test('preserves tool prose and canonical value, adds call-bound receipt for native replay', async () => {
  const out = await wmReceiptBridge(exec, result, async () => ({ kind: 'accept', additionalContexts: [] }));
  assert.equal(out.kind, 'accept');
  assert.deepEqual(out.content[0], content[0]);
  assert.deepEqual(JSON.parse(out.content[1].text), { operatorWm: { version: 1, callId: 'call-1', toolName: 'dispatch_seat', value } });
  assert.deepEqual(out.additionalContexts, []);
  assert.equal(result.content.length, 1);
  assert.equal(out.value, undefined);
});

test('downstream block or replacement stays authoritative and receives no original receipt', async () => {
  for (const decision of [{ kind: 'block', feedback: [{ type: 'text', text: 'denied' }] }, { kind: 'accept', content: [] }, { kind: 'accept', value: {} }]) {
    assert.equal(await wmReceiptBridge(exec, result, async () => decision), decision);
  }
});

test('errors, other tools, missing identity, malformed or oversized values pass through', async () => {
  const decision = { kind: 'accept' };
  const rows = [
    [{ name: 'other', callId: 'call-1' }, result],
    [{ name: 'dispatch_seat' }, result],
    [exec, { ...result, isError: true }],
    [exec, { ...result, value: null }],
    [exec, { ...result, value: { ...value, detail: 'x'.repeat(200000) } }],
  ];
  for (const [e, r] of rows) assert.equal(await wmReceiptBridge(e, r, async () => decision), decision);
});

test('next rejection propagates rather than bypassing a downstream gate', async () => {
  await assert.rejects(wmReceiptBridge(exec, result, async () => { throw new Error('gate failed'); }), /gate failed/);
});
