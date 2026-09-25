import { randomUUID } from 'node:crypto';

const TASK_ID_RE = /^task-([a-f0-9]{8})$/;
const CONVERSATION_ID_RE = /^rcos-task-([a-f0-9]{8})$/;

export function admitTask(objective, uuid = randomUUID()) {
  const text = String(objective || '').trim();
  if (!text) throw new Error('objective required');
  const short = String(uuid).toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 8);
  if (short.length !== 8) throw new Error('uuid must contain at least 8 hex characters');
  const taskId = 'task-' + short;
  return { taskId, objective: text, conversationId: taskConversationId(taskId) };
}

export function taskConversationId(taskId) {
  const m = String(taskId || '').toLowerCase().match(TASK_ID_RE);
  if (!m) throw new Error('invalid task id');
  return 'rcos-task-' + m[1];
}

export function projectTaskFromRun(run) {
  const m = String(run && run.conversation_id || '').toLowerCase().match(CONVERSATION_ID_RE);
  if (!m) return null;
  const status = run && run.status ? String(run.status) : null;
  return {
    taskId: 'task-' + m[1],
    runId: run && run.id ? String(run.id) : null,
    workflow: run && run.workflow_name ? String(run.workflow_name) : null,
    execution: { status, completed: status === 'completed', failed: status === 'failed' },
  };
}

const notEvaluated = (reason) => ({ status: 'NOT_EVALUATED', pass: false, reason, checks: [] });

// ---------------------------------------------------------- evidence contract
// v1: evaluator text and the hashed detail were composed from the RAW run
// detail body, which carries `run.user_message` — the dispatched objective
// echoed back verbatim. A token-presence evaluator could then be satisfied by
// the REQUEST repeating itself rather than by execution (the objective-echo
// hazard). v2 evaluates independent execution evidence only: the request echo
// is stripped from the detail before it is hashed and judged, so
// `evidenceSha256` changes deliberately for v2 records. A bundle with no
// `contract` field is a v1 original: it is read verbatim and never
// recomputed or rewritten.
export const EVIDENCE_CONTRACT_VERSION = 2;

// Fields named like the dispatched-request echo. Only these are removed —
// `output` / `node_output` event data is execution evidence and is kept.
const REQUEST_ECHO_FIELDS = ['user_message'];

export function excludeRequestEcho(detailText) {
  const raw = String(detailText == null ? '' : detailText);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return raw;
  const clone = { ...body };
  // The polled detail is whichever body the run endpoint returned: the wrapper
  // `{ run, events }` or the bare run object. Strip the echo at the top level
  // as well as inside `run`, so neither shape can smuggle the request through.
  for (const f of REQUEST_ECHO_FIELDS) delete clone[f];
  if (clone.run && typeof clone.run === 'object' && !Array.isArray(clone.run)) {
    clone.run = { ...clone.run };
    for (const f of REQUEST_ECHO_FIELDS) delete clone.run[f];
  }
  if (Array.isArray(clone.events)) {
    clone.events = clone.events.map((e) => {
      if (!e || typeof e !== 'object' || Array.isArray(e)) return e;
      const ev = { ...e };
      for (const f of REQUEST_ECHO_FIELDS) delete ev[f];
      if (ev.data && typeof ev.data === 'object' && !Array.isArray(ev.data)) {
        ev.data = { ...ev.data };
        for (const f of REQUEST_ECHO_FIELDS) delete ev.data[f];
      }
      return ev;
    });
  }
  return JSON.stringify(clone);
}

// `output-lines` declarations are evidence tokens: a declaration may name a
// stable prefix such as `Path:` while still needing a token boundary. Plain
// `String#includes` lets `row=6 total=118` pass against `row=6 total=1180`,
// which can turn a near miss into a false objective satisfaction. Keep the
// matching line-local and reject word-character continuations on either side.
function hasEvidenceToken(text, token) {
  if (!token) return false;
  for (const line of text.split(/\r?\n/)) {
    let from = 0;
    for (;;) {
      const at = line.indexOf(token, from);
      if (at < 0) break;
      const before = at > 0 ? line[at - 1] : '';
      const afterAt = at + token.length;
      const after = afterAt < line.length ? line[afterAt] : '';
      const beforeIsWord = before !== '' && /[A-Za-z0-9_]/.test(before);
      const afterIsWord = after !== '' && /[A-Za-z0-9_]/.test(after);
      if (!beforeIsWord && !afterIsWord) return true;
      from = at + Math.max(token.length, 1);
    }
  }
  return false;
}

export function evaluateObjective({ executionCompleted, capabilityValidation, evaluator, evidenceText }) {
  if (!executionCompleted) return notEvaluated('execution did not complete');
  if (!capabilityValidation || capabilityValidation.pass !== true) return notEvaluated('capability validation did not pass');
  if (!evaluator || typeof evaluator !== 'object') return notEvaluated('no objective evaluator declared');
  const text = String(evidenceText || '');
  if (evaluator.kind === 'output-lines') {
    const required = Array.isArray(evaluator.required) ? evaluator.required.map(String) : [];
    if (!required.length) return notEvaluated('output-lines evaluator has no required tokens');
    const checks = required.map((token) => ({ id: 'contains:' + token, pass: hasEvidenceToken(text, token), expected: token }));
    const pass = checks.every((c) => c.pass);
    return { status: pass ? 'SATISFIED' : 'NOT_SATISFIED', pass, reason: pass ? 'all required evidence lines are present' : 'required evidence lines are missing', checks };
  }
  if (evaluator.kind === 'output-contains') {
    const expected = String(evaluator.value || '');
    if (!expected) return notEvaluated('output-contains evaluator has no value');
    const pass = text.includes(expected);
    return { status: pass ? 'SATISFIED' : 'NOT_SATISFIED', pass, reason: pass ? 'required objective evidence is present' : 'required objective evidence is absent', checks: [{ id: 'contains:' + expected, pass, expected }] };
  }
  return notEvaluated('unsupported objective evaluator kind: ' + String(evaluator.kind || 'missing'));
}

export function buildClaim({ kind, label, objectiveEvaluation, capabilityValidation, execution, observed = [], delta = null, provenance = null }) {
  const supportedBy = [];
  if (objectiveEvaluation) supportedBy.push({ kind: 'objective-evaluation', pass: objectiveEvaluation.pass === true, status: objectiveEvaluation.status || null });
  if (capabilityValidation) supportedBy.push({ kind: 'capability-validation', pass: capabilityValidation.pass === true });
  if (execution) supportedBy.push({ kind: 'execution', pass: execution.completed === true, runId: execution.runId || null });
  return { kind: String(kind || 'claim'), label: String(label || kind || 'Claim'), supportedBy, observed: Array.isArray(observed) ? observed : [], delta, provenance };
}

// --- Identity truth (moved verbatim from lib/goal.js, OP-4R Phase C-R) -----
// Pure run-identity predicates live beside the other task-truth functions so
// the recovery path (lib/reconcile.js) can consume them without reaching into
// the GoalRunner module. Same bodies, same leg ids, same fail-closed reasons.

export const runWorkflowName = (run) => (run && (run.workflow_name || (run.workflow && run.workflow.name))) || null;

// Every leg records its OWN outcome, and every leg states whether it is even
// APPLICABLE. A leg whose premise is absent — the run records no parent (a
// DIRECT run's own conversation_id IS the bound conversation), or the
// association records no expected workspace path — is emitted with
// `applicable: false` and NO `pass`. That is deliberate: an absence that is
// not recorded is indistinguishable from a check nobody ever wrote, and a
// non-verdict must never be mistaken for a verdict.
//
// `pass` is the conjunction over APPLICABLE legs only. A missing association
// key that IS a premise for an applicable leg (dbId, archonConversationId,
// expectedCodebaseId) still fails closed rather than passing vacuously.
export function verifyParentLinkage(detail, association, workflowName, dispatchedMessage) {
  const evidence = [];
  const leg = (id, applicable, pass, got, reason) => {
    if (!applicable) evidence.push(reason ? { id, applicable: false, got, reason } : { id, applicable: false, got });
    else evidence.push(reason ? { id, applicable: true, pass, got, reason } : { id, applicable: true, pass, got });
  };
  if (!detail) {
    for (const id of ['workflow-name', 'parent-conversation-id', 'parent-platform-id', 'codebase-id', 'user-message', 'working-path']) {
      leg(id, true, false, null, 'run detail is null');
    }
    return { pass: false, evidence };
  }
  leg('workflow-name', true, runWorkflowName(detail) === workflowName, runWorkflowName(detail));

  // A parent leg is APPLICABLE only when the run records a parent. A direct run
  // carries none, so requiring the parent legs would refuse every legitimate
  // direct run — the premise, not a hardcoded leg list, decides.
  const hasParent = detail.parent_conversation_id != null || detail.parent_platform_id != null;
  if (!hasParent) leg('parent-conversation-id', false, null, detail.parent_conversation_id, 'run records no parent conversation');
  else if (!association || !association.dbId) leg('parent-conversation-id', true, false, detail.parent_conversation_id, 'association has no recorded db id');
  else leg('parent-conversation-id', true, detail.parent_conversation_id === association.dbId, detail.parent_conversation_id);

  if (!hasParent) leg('parent-platform-id', false, null, detail.parent_platform_id, 'run records no parent platform id');
  else if (!association || !association.archonConversationId) leg('parent-platform-id', true, false, detail.parent_platform_id, 'association has no recorded platform id');
  else leg('parent-platform-id', true, detail.parent_platform_id === association.archonConversationId, detail.parent_platform_id);

  if (!association || !association.expectedCodebaseId) leg('codebase-id', true, false, null, 'association has no expected project id');
  else leg('codebase-id', true, detail.codebase_id === association.expectedCodebaseId, detail.codebase_id);

  leg('user-message', true, detail.user_message === dispatchedMessage, detail.user_message);

  // Workspace identity. The expectation lives on the association (the same
  // place expectedCodebaseId lives) and is compared with strict equality on the
  // raw strings, mirroring lib/environments.js's execution-identity rule.
  //
  // LIMITATION, stated rather than implied: the product never sets a
  // conversation `cwd`, so `workspace.path` is the effective working directory
  // today. If a conversation EVER carries a cwd override, the orchestrator
  // reports the run's `working_path` as that override while `workspace.path`
  // stays the codebase default, so this leg will legitimately differ and REFUSE
  // a run that should have been adopted. That direction is chosen on purpose
  // (a loud false refusal over a silent false adoption); the correct fix would
  // be to record the conversation's effective cwd at binding time and compare
  // against THAT.
  if (!association || !association.expectedWorkspacePath) {
    leg('working-path', false, null, detail.working_path == null ? null : detail.working_path, 'association records no workspace path');
  } else {
    leg('working-path', true, detail.working_path === association.expectedWorkspacePath, detail.working_path == null ? null : detail.working_path);
  }

  return { pass: evidence.every((e) => e.applicable === false || e.pass), evidence };
}
