/** Read-only continuation authority from the existing host dispatch audit.
 * Run identities come from canonical tools/result values, never chat text.
 */
import { open } from 'node:fs/promises';
import { join } from 'node:path';

const DISPATCH_RE = /^sd-\d{8}T\d{6}Z-[a-f0-9]{6}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const WORKFLOW_RE = /^rcos-ir-[a-z0-9][a-z0-9-]{0,55}$/;
const NODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const MAX_AUDIT_BYTES = 8 * 1024 * 1024;
const ACTIVE_STATUSES = ['running', 'queued', 'pending'];

function canonicalOutcome(data, launchOnly = false) {
  if (ACTIVE_STATUSES.includes(data.status)) return { status: data.status, verdicts: ['pending'] };
  // Launch receipts prove identity and activity, never terminal acceptance.
  if (launchOnly) return undefined;
  const decision = typeof data.effective_decision === 'string' ? data.effective_decision.toLowerCase() : undefined;
  const status = data.status === 'completed' && ['ship', 'fix', 'blocked'].includes(decision) ? decision : 'blocked';
  return { status, verdicts: status === 'ship' ? ['ship', 'fix', 'blocked'] : status === 'fix' ? ['fix', 'blocked'] : ['blocked'] };
}

function normalizeBinding(value) {
  const identityFields = ['dispatch_id', 'caller_session_id', 'seat_session_id', 'run_id', 'archon_conversation_id', 'workflow_name'];
  if (!value || identityFields.some(key => typeof value[key] !== 'string')
      || !DISPATCH_RE.test(value.dispatch_id) || !SESSION_RE.test(value.caller_session_id)
      || !SESSION_RE.test(value.seat_session_id) || !RUN_RE.test(value.run_id)
      || !RUN_RE.test(value.archon_conversation_id) || !WORKFLOW_RE.test(value.workflow_name)) {
    throw new Error('host run binding is missing or invalid');
  }
  if (!Array.isArray(value.child_nodes) || value.child_nodes.length < 1 || value.child_nodes.length > 64
      || value.child_nodes.some(node => !node || typeof node.id !== 'string' || !NODE_RE.test(node.id) || typeof node.workflow !== 'string'
        || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(node.workflow))
      || new Set(value.child_nodes.map(node => node.id)).size !== value.child_nodes.length) {
    throw new Error('host run binding needs its exact child workflow nodes');
  }
  return Object.freeze({
    dispatch_id: value.dispatch_id, caller_session_id: value.caller_session_id,
    seat_session_id: value.seat_session_id, run_id: value.run_id,
    archon_conversation_id: value.archon_conversation_id, workflow_name: value.workflow_name,
    child_nodes: Object.freeze(value.child_nodes.map(node => Object.freeze({ id: node.id, workflow: node.workflow }))),
  });
}

/** Observer is synchronous: DSH does not await tools/result callbacks. */
export function createDispatchRunObserver({ dispatchId, callerSessionId, seatSessionId }) {
  const compiled = new Map();
  const runs = new Map();
  const outcomes = new Map();
  function receiptRunViolations(runId) {
    if (runs.size === 0 || runs.has(runId)) return [];
    return ['archon_run_id must preserve a run launched or successfully read in this seat: ' + [...runs.keys()].join(', ') + '; a blocked result still has that run identity'];
  }
  return {
    get: runId => runs.get(runId),
    receiptRunViolations,
    receiptViolations(attempt) {
      const runId = attempt?.archon_run_id;
      const violations = receiptRunViolations(runId);
      if (violations.length || runId === 'none') return violations;
      if (!runs.has(runId)) return ['archon_run_id must be captured from a successful canonical run tool in this seat; no such run was observed'];
      const outcome = outcomes.get(runId);
      if (!outcome) return ['read the exact Archon run status before submitting a terminal receipt; launch acceptance does not verify completion'];
      if (attempt.archon_status !== outcome.status) violations.push('archon_status must match the latest canonical status ' + outcome.status + ' for run ' + runId);
      if (!outcome.verdicts.includes(attempt.verdict)) violations.push('verdict must be ' + outcome.verdicts.join(' | ') + ' for canonical status ' + outcome.status + ' of run ' + runId);
      return violations;
    },
    observe(exec, result) {
      if (exec?.agent?.session?.id !== seatSessionId || result?.isError !== false || result.value?.ok !== true) return;
      try {
        const data = JSON.parse(result.value.data_json);
        if (exec.name === 'rcos_compile_ir' && result.value.operation === 'rcos_compile_ir') {
          const workflow = `rcos-ir-${exec.arguments.name}`;
          if (data.workflow_name !== workflow || !WORKFLOW_RE.test(workflow)) return;
          const ir = JSON.parse(exec.arguments.ir_json);
          const nodes = ir.nodes.filter(node => node?.execution_class === 'workflow' && node.ref && typeof node.ref === 'object')
            .map(node => ({ id: node.id, workflow: node.ref.workflow }));
          compiled.set(workflow, nodes);
        } else if (exec.name === 'archon_workflow_run' && result.value.operation === 'archon_workflow_run') {
          const workflow = exec.arguments.workflow_name;
          if (data.workflow_name !== workflow || !compiled.has(workflow)) return;
          const binding = normalizeBinding({
            dispatch_id: dispatchId, caller_session_id: callerSessionId, seat_session_id: seatSessionId,
            run_id: data.run_id || data.id, archon_conversation_id: data.conversation_id,
            workflow_name: workflow, child_nodes: compiled.get(workflow),
          });
          runs.set(binding.run_id, binding);
          outcomes.set(binding.run_id, canonicalOutcome(data, true));
        } else if (exec.name === 'archon_run_status' && result.value.operation === 'archon_run_status') {
          if (data.run_id !== exec.arguments.run_id || !runs.has(data.run_id)) return;
          outcomes.set(data.run_id, canonicalOutcome(data));
        } else if (exec.name === 'archon_dispatch_status' && result.value.operation === 'archon_run_status') {
          // Added by the read-only adapter after its same-chat audit check.
          const binding = normalizeBinding(data.dispatch_binding);
          if (data.requested_dispatch_id !== exec.arguments.dispatch_id
              || binding.caller_session_id !== callerSessionId || binding.run_id !== data.run_id) return;
          runs.set(binding.run_id, binding);
          outcomes.set(binding.run_id, canonicalOutcome(data));
        }
      } catch { /* Invalid or unrelated results never grant continuation authority. */ }
    },
  };
}

async function readAudit(dir) {
  const file = await open(join(dir, 'seat-dispatch.jsonl'), 'r');
  try {
    const size = (await file.stat()).size;
    const start = Math.max(0, size - MAX_AUDIT_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text.split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } finally { await file.close(); }
}

/** Only a fresh dispatched WM from the original General chat may follow up. */
export async function readDispatchBinding({ auditDir, dispatchId, exec, workflowAllowlist }) {
  if (typeof dispatchId !== 'string' || !DISPATCH_RE.test(dispatchId)) throw new Error('dispatch_id must be an exact saved seat dispatch id');
  const header = exec?.agent?.session?.header;
  if (header?.origin !== 'subagent' || header.agentPreset !== 'workflow-manager'
      || header.delegationDepth !== 1 || typeof header.parentSession !== 'string' || !SESSION_RE.test(header.parentSession)) {
    throw new Error('follow-up status requires a dispatched Workflow Manager with a trusted parent chat');
  }
  let records;
  try { records = await readAudit(auditDir); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('saved dispatch audit was not found');
    throw error;
  }
  const matches = records.filter(row => row?.run_id === dispatchId);
  if (!matches.length) throw new Error('saved dispatch was not found in the bounded host audit');
  if (matches.length !== 1) throw new Error('saved dispatch identity is ambiguous');
  const record = matches[0];
  if (record.caller_session_id !== header.parentSession) throw new Error('run follow-up is limited to its originating chat');
  if (record.stage !== 'complete' || record.receipt_accepted !== true || record.seat !== 'workflow-manager'
      || record.caller_preset !== 'general-idea' || !['no-parent-root', 'lineage-clean-root'].includes(record.authority_basis)) {
    throw new Error('saved dispatch has no accepted Workflow Manager receipt');
  }
  if (!record.archon_binding) throw new Error('host run binding was not recorded for this older dispatch; an operator must inspect the exact Dell run without resubmitting');
  const binding = normalizeBinding(record.archon_binding);
  const originals = records.filter(row => row?.run_id === binding.dispatch_id);
  const original = originals.length === 1 ? originals[0] : undefined;
  if (binding.caller_session_id !== record.caller_session_id || binding.run_id !== record.archon?.run_id
      || !original || original.caller_session_id !== binding.caller_session_id
      || original.seat_session_id !== binding.seat_session_id || original.archon?.run_id !== binding.run_id
      || JSON.stringify(normalizeBinding(original.archon_binding)) !== JSON.stringify(binding)) {
    throw new Error('host run binding does not match the saved dispatch identity');
  }
  if (binding.child_nodes.some(node => !workflowAllowlist.includes(node.workflow))) throw new Error('saved child workflow is no longer in this preset approved catalog');
  return binding;
}
