// Explicit opt-in probe against an installed DSH runtime. No model, profile,
// network, live server, or persistent session is used or changed.
// node scripts/wm-runtime-smoke.mjs /absolute/path/to/runtime/node_modules
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { wmReceiptBridge } from '../lib/wm-bridge.js';

const root = process.argv[2];
if (!root || !isAbsolute(root)) throw new Error('Supply the absolute installed DSH node_modules path.');
const installed = (path) => import(pathToFileURL(resolve(root, path)).href);
const { Context } = await installed('@deepseek-ai/cordis/lib/index.js');
const { ToolRuntime, defineTool } = await installed('@deepseek-ai/dsh-tools/lib/index.js');
const { buildValue, renderDispatch, DISPATCH_OUTPUT } = await installed('dsh-seat-dispatch/lib/index.js');
let client;
vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(def) { client = def.factory(() => ({ Component: class {} })); } } },
  setInterval() { return 0; }, clearInterval() {},
});
const receipt = { verdict: 'ship', summary: 'Synthetic contract probe.', artifacts: ['/tmp/probe.txt'], evidence: ['Synthetic test evidence.'], blockers: [], archon_run_id: 'none', archon_status: 'none', archon_artifact_dir: 'none', lane: 'synthetic/test', next: 'none' };
const value = buildValue({ stage: 'complete', receipt, detail: 'Synthetic receipt; no real work executed.', warnings: [], seatLane: 'synthetic/test', callerLaneExpectation: 'none', runId: 'sd-probe', seat: 'wm', seatSessionId: 'probe-child', callerSessionId: 'probe-parent', callerPreset: 'idea-chat', presetSource: 'fixture', callerDepth: 0, turns: { started: 1 }, startedAt: Date.now(), receiptAccepted: true, attempts: 1, refusals: 0, receiptsSeen: 1, auditLog: 'none', auditError: 'none' });
const ctx = new Context();
ctx.provide('systemPrompt', { tools() {}, section() {} });
const runtime = new ToolRuntime(ctx);
ctx.on('tools/post-execute', wmReceiptBridge);
runtime.register(defineTool({ name: 'dispatch_seat', description: 'Synthetic receipt transport probe', parameters: {}, output: { schema: DISPATCH_OUTPUT, render: renderDispatch }, execute: async () => value }));
try {
  const result = await runtime.execute({ name: 'dispatch_seat', callId: 'probe-call', arguments: {}, signal: new AbortController().signal });
  assert.equal(result.isError, false);
  assert.deepEqual(result.content[0], renderDispatch({}, value)[0]);
  assert.equal(result.content.length, 2);
  const projected = client.projectWmToolBlock({ kind: 'tool-result', callId: 'probe-call', call: { name: 'dispatch_seat', argsRaw: JSON.stringify({ seat: 'wm', objective: 'Synthetic probe' }) }, content: result.content, isError: false });
  assert.equal(projected.state, 'completed');
  assert.equal(projected.verdict, 'ship');
  assert.equal(projected.dispatchRunId, 'sd-probe');
  assert.equal(projected.artifacts[0], '/tmp/probe.txt');
  const removeGate = ctx.on('tools/post-execute', async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'Synthetic refusal' }] }));
  const blocked = await runtime.execute({ name: 'dispatch_seat', callId: 'blocked-call', arguments: {}, signal: new AbortController().signal });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.content.some((part) => part.text?.includes('operatorWm')), false);
  removeGate();
  console.log('PASS: real DSH ToolRuntime + dispatcher schema/renderer → receipt bridge → client projection; downstream block preserved. Synthetic body only; not a live WM dispatch.');
} finally {
  await ctx.fiber.dispose();
}
