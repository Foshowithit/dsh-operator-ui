// lib/capability-dispatch.js — the AUTHORIZED capability-dispatch route (RCOS).
//
// WHY THIS MODULE EXISTS (measured on Dell Archon :3090, 2026-10-08):
//
//   POST /api/workflows/{name}/run {message, conversationId}
//     → {"accepted":true,"status":"queued-conversation"} and it DOES create a
//       run, BUT it STRIPS ALL DOUBLE-QUOTES from the message. A capability
//       workflow that reads its structured inputs from $ARGUMENTS receives
//       `{probes:[{name:x,file:/tmp/a}]}` instead of valid JSON and its bash
//       prelude dies at `json.load` (exit 2). `inputs:{...}` is ignored;
//       `arguments:{...}` is ignored. The HTTP run route cannot carry JSON.
//
//   archon workflow run <name> "<json>" --no-worktree --detach  (Dell CLI)
//     → prints `Run id: <32-hex>` IMMEDIATELY and PRESERVES the JSON message
//       verbatim. Proven end-to-end: `audio-offline-verify-v1` returned
//       validation-report.ok=true with capability_id/status_completed/
//       adapter_exit_zero/output_hashed all true, run completed.
//
// So the authorized route is the CLI, invoked over the plugin's EXISTING safe
// SSH channel (the same `spawn('ssh', ...)` pattern lib/run-artifacts.js uses):
// the command contains only our shipped source; request values travel on
// stdin; nothing is shell-interpolated. Dell stays the sole writer.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export const DISPATCH_SSH_TIMEOUT_MS = 60000;
const RUN_ID_RE = /^[a-f0-9]{32}$/i;
const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SSH_TARGET_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/;

export function validSshTarget(target) {
  return typeof target === 'string' && SSH_TARGET_RE.test(target);
}
export function validWorkflowName(name) {
  return typeof name === 'string' && WORKFLOW_NAME_RE.test(name);
}
export function validRunId(id) {
  return typeof id === 'string' && RUN_ID_RE.test(id);
}

// The remote program (the Dell-side dispatcher) travels as base64 of our
// shipped source, exactly like lib/run-artifacts.js. The run request is written
// to stdin as one JSON document; the remote reads it, runs the CLI, and prints
// a single JSON result line.
async function remoteCommand() {
  const source = await readFile(new URL('./capability-dispatch-remote.py', import.meta.url));
  return "python3 -c 'import base64;exec(base64.b64decode(\"" + source.toString('base64') + "\"))'";
}

// Exposed for unit tests: the exact argv ssh receives. The command is our
// shipped source only; the request NEVER appears on the command line.
export async function sshArgvFor(target) {
  return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, await remoteCommand()];
}

export function parseRunId(stdout) {
  const m = String(stdout || '').match(/Run id:\s*([a-f0-9]{32})/i);
  if (m) return m[1];
  // The remote helper may answer a JSON envelope instead of raw CLI output.
  try {
    const obj = JSON.parse(String(stdout || '').trim().split('\n').pop());
    if (obj && validRunId(obj.runId)) return obj.runId;
  } catch { /* not JSON — fall through */ }
  return null;
}

/**
 * Dispatch a capability workflow through the authorized Dell CLI route.
 * @returns {Promise<{ok:boolean, runId:string|null, workflow:string, argsSha256:string, raw?:string, stderr?:string, error?:string, code?:string}>}
 */
export async function dispatchCapability({ target, workflow, args, spawnImpl = spawn, timeoutMs = DISPATCH_SSH_TIMEOUT_MS } = {}) {
  if (!validSshTarget(target)) return { ok: false, runId: null, workflow, code: 'dispatch-target-invalid', error: 'no valid user@host SSH target is configured (artifacts.sshTarget)' };
  if (!validWorkflowName(workflow)) return { ok: false, runId: null, workflow, code: 'dispatch-workflow-invalid', error: 'workflow name is not a bounded identifier' };
  // args must be a JSON-serialisable value; it is transported as JSON text and
  // handed to the CLI as ONE argv element by the remote helper (no shell).
  let argsText;
  try {
    argsText = typeof args === 'string' ? args : JSON.stringify(args);
    if (typeof argsText !== 'string' || argsText.length === 0) throw new Error('empty');
    JSON.parse(argsText); // the CLI contract requires valid JSON in $ARGUMENTS
  } catch {
    return { ok: false, runId: null, workflow, code: 'dispatch-args-invalid', error: 'capability arguments are not valid JSON text' };
  }

  const remote = await remoteCommand();
  const request = JSON.stringify({ workflow, args: argsText });

  return await new Promise((resolve) => {
    const child = spawnImpl('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, remote], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', settled = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish({ ok: false, runId: null, workflow, code: 'dispatch-timeout', error: 'Dell capability dispatch timed out' }); }, timeoutMs);
    child.stdout.on('data', (c) => { out = (out + c).slice(-200000); });
    child.stderr.on('data', (c) => { err = (err + c).slice(-8000); });
    child.on('error', (e) => finish({ ok: false, runId: null, workflow, code: 'dispatch-spawn-failed', error: String((e && e.message) || e) }));
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish({ ok: false, runId: null, workflow, code: 'dispatch-remote-failed', error: 'Dell dispatch helper exited non-zero', stderr: err.slice(-600) });
      const runId = parseRunId(out);
      if (!runId) return finish({ ok: false, runId: null, workflow, code: 'dispatch-no-run-id', error: 'Dell CLI did not return a run id', raw: out.slice(-600), stderr: err.slice(-600) });
      finish({ ok: true, runId, workflow, raw: out.slice(-600) });
    });
    child.stdin.end(request);
  });
}

// ---------------------------------------------------------------------------
// THE SUPPORTED HTTP DECLARED-INPUT ROUTE (measured 2026-10-08).
//
// A workflow that declares `inputs: {<name>: {required: true}}` and consumes
// `$INPUTS_<UPPER_NAME>` receives the value BYTE-FOR-BYTE via:
//
//   POST /api/workflows/{name}/run
//   { message, conversationId, inputs: { <name>: "<json text>" } }
//
// Measured: the capability received
//   {"probes":[{"name":"httproute","file":"/tmp/rcos-e2e/probe.mp4",...}]}
// with quotes and spaces intact. This is the SUPPORTED production path — no SSH
// shell-out. The Dell CLI route above stays as the diagnostic/differential
// fallback for capabilities that still read $ARGUMENTS.
//
// TRANSPORT DOCTRINE CORRECTED 2026-10-08 (evidence, not inference):
//   (a) The earlier claim that `message` alone is "quote-stripped by the same
//       route" is DISPROVEN and must not be repeated. The route's own write path
//       spreads the caller's `inputs` verbatim into run metadata — measured from
//       the Dell Archon DB: run e7f0758d persists
//         metadata.inputs.probes_json = "{\"probes\":[{\"name\":\"probe\",...}]}"
//       with every double-quote intact. There is no quote transformation on the
//       message OR on inputs.
//   (b) `POST /api/workflows/{name}/run` is a CONVERSATION-MESSAGE endpoint, not
//       a run-creating one. It enqueues a turn and answers
//       {accepted:true, status:"started"|"queued-conversation"|"queued-capacity"}.
//       A run row is created only inside the workflow-dispatch path. So a
//       workflow that is not bound to a workspace, OR whose message is plain
//       prose, yields accepted:true with ZERO runs. `accepted` means "turn
//       enqueued", NEVER "run created".
//   (c) The route validates the SHAPE of supplied `inputs` (string values) and
//       answers 400 when they are malformed, but it does NOT check them against
//       the workflow's declared `inputs:` — a MISSING required input is not
//       refused (the CLI's WorkflowMissingInputsError does refuse loudly, and
//       answers "No worktree was created and no AI cost was incurred"). This is
//       defensive-depth on Archon's side; it is NOT a quoting bug.
//
// Consequence for callers: treat "accepted with no discoverable run" as the
// refusal it is — which is exactly what goal.js's discovery window already does
// (it raises a named `run-not-found` rather than a false success).

// One declared input per capability that carries the whole capability input
// document as JSON text. Kept in sync with each workflow's `inputs:` block.
const DECLARED_INPUT_NAME = { 'audio-offline-verify': 'probes_json', 'mac-dell-staging': 'args_json' };

export function declaredInputName(capabilityId) {
  return Object.prototype.hasOwnProperty.call(DECLARED_INPUT_NAME, capabilityId) ? DECLARED_INPUT_NAME[capabilityId] : null;
}

export function declaredInputsFor(capabilityId, args) {
  const name = declaredInputName(capabilityId);
  if (!name) return null;
  let text;
  try { text = typeof args === 'string' ? args : JSON.stringify(args); JSON.parse(text); } catch { return null; }
  return { name, text };
}

export async function dispatchCapabilityHttp({ transport, workflow, conversationId, inputName, inputText, message = 'rcos capability dispatch', fetchImpl = fetch } = {}) {
  if (!validWorkflowName(workflow)) return { ok: false, code: 'dispatch-workflow-invalid', error: 'workflow name is not a bounded identifier' };
  if (typeof inputName !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(inputName)) return { ok: false, code: 'dispatch-input-name-invalid', error: 'declared input name is not a bounded identifier' };
  if (typeof inputText !== 'string' || inputText.length === 0) return { ok: false, code: 'dispatch-args-invalid', error: 'declared input text is required' };
  try { JSON.parse(inputText); } catch { return { ok: false, code: 'dispatch-args-invalid', error: 'declared input text is not valid JSON' }; }
  if (!transport || typeof transport.baseUrl !== 'string') return { ok: false, code: 'dispatch-transport-invalid', error: 'no orchestrator transport configured' };
  const body = JSON.stringify({ message, conversationId, inputs: { [inputName]: inputText } });
  const res = await fetchImpl(transport.baseUrl + '/api/workflows/' + encodeURIComponent(workflow) + '/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(typeof transport.headers === 'function' ? transport.headers() : {}) },
    body,
  });
  if (!res || !res.ok) return { ok: false, code: 'dispatch-http-failed', error: 'HTTP ' + (res && res.status) };
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  const accepted = !!(parsed && parsed.accepted);
  // The route answers {accepted:true} with no run id; the run must be DISCOVERED
  // (goal.js's bound-conversation discovery does that). A false `accepted` is a
  // refusal we surface here.
  return { ok: accepted, accepted, remoteStatus: (parsed && parsed.status) || null, code: accepted ? null : 'dispatch-refused', error: accepted ? null : 'orchestrator did not accept the dispatch' };
}
