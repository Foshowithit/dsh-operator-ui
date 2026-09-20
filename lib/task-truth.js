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
