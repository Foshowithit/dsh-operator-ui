// dsh-operator-ui — identity recovery + read-model reconciliation.
//
// OP-4R Phase C-R (GPT work order, 2026-09-21), Mac-side only. Three rules,
// in force everywhere in this module:
//
// 1. Reconstruction CONSUMES the durable, verified task→attempt→run
//    association established at adoption (T1, stored on the attempt as
//    `adoption`). Ownership is NEVER inferred from a child run's parent id:
//    a parent conversation can produce more than one child run over time, so
//    parent linkage alone must never select an attempt. Legacy
//    `rcos-task-<8hex>` identity remains handled by the existing projection
//    (lib/task-truth.js projectTaskFromRun) for the historical records that
//    genuinely use it — unchanged here.
// 2. Evidence absent or inconsistent → an explicit `unresolved` identity
//    state. Never a guessed association, never run-not-found, never FAILED,
//    never permission to redispatch.
// 3. Historical observations are immutable. Reconciliation may APPEND an
//    entry to `task.reconciliation` identifying a failed child run, but it
//    never rewrites the old observation (verdict, failureCodes, error,
//    trust, nextAction, recorded attempt fields) and never projects
//    objective satisfaction that never occurred.
//
// This module is pure identity logic: every Archon read is performed by the
// caller (lib/tasks.js, at the read boundary) and passed in.

import { verifyParentLinkage, runWorkflowName } from './task-truth.js';

// Validate a STORED adoption against independently retrieved run detail.
// The stored association on the envelope lives in `task.conversation`
// (S2-R block: archonConversationId / dbId / expectedCodebaseId). Every
// mismatch names the leg that failed; missing evidence fails closed.
export function validateStoredAssociation({ detail, adoption, association }) {
  const fail = (reason, evidence) => ({ pass: false, reason, evidence: evidence || null });
  if (!adoption || !adoption.runId) return fail('no verified association stored on the attempt');
  if (!detail) return fail('run detail unavailable for the stored run id');
  if (detail.id !== adoption.runId) {
    return fail('child-run-id mismatch: retrieved run ' + detail.id + ' is not the stored adopted run ' + adoption.runId);
  }
  if (runWorkflowName(detail) !== adoption.workflow) {
    return fail('workflow mismatch: run ' + detail.id + ' is ' + (runWorkflowName(detail) || 'unknown') + ', association expects ' + adoption.workflow);
  }
  const check = verifyParentLinkage(detail, association, adoption.workflow, adoption.userMessage);
  if (!check.pass) {
    const legs = check.evidence.filter((e) => !e.pass).map((e) => e.id).join(', ');
    return fail('parent-link verification failed on legs: ' + legs, check.evidence);
  }
  return { pass: true, reason: null, evidence: check.evidence };
}

const attemptWithAdoption = (task) => {
  const attempts = (task && Array.isArray(task.attempts)) ? task.attempts : [];
  return attempts.filter((a) => a && a.adoption && a.adoption.runId).pop() || null;
};

// Restart path for an ADOPTED run: `detail` was fetched BY THE STORED RUN ID
// ONLY (the caller's job), then validated here. On success the identity is
// `reconciled`, the attempt's still-null status is filled from the verified
// run (execution truth the crashed process never got to record — recorded
// beside a statusObserved note, never over an existing value), and an
// append-only reconciliation entry is added. On any mismatch the identity is
// `unresolved` and the envelope is returned untouched except for the
// identity block itself.
export function reconcileAdoptedRun(task, { detail, checkedAt }) {
  const adopted = attemptWithAdoption(task);
  const base = { checkedAt: checkedAt || null };
  if (!adopted) {
    return { identity: { ...base, state: 'unresolved', reason: 'no adopted attempt carries a verified association' }, task, appended: false };
  }
  const adoption = adopted.adoption;
  const verdict = validateStoredAssociation({ detail, adoption, association: (task && task.conversation) || null });
  if (!verdict.pass) {
    return {
      identity: { ...base, state: 'unresolved', runId: adoption.runId, reason: verdict.reason, evidence: verdict.evidence },
      task,
      appended: false,
    };
  }
  // Verified: fill only what the crashed process never recorded. Existing
  // attempt values are history and stay exactly as written.
  if (adopted.status == null && detail.status) {
    adopted.status = detail.status;
    adopted.statusObserved = { from: 'reconciliation', at: base.checkedAt, note: 'status recovered from the verified adopted run after restart' };
  }
  if (adopted.childConversationId == null && detail.conversation_id) adopted.childConversationId = detail.conversation_id;
  const entry = {
    kind: 'child-run-association-verified',
    runId: adoption.runId,
    childConversationId: detail.conversation_id || null,
    statusObserved: detail.status || null,
    evidence: verdict.evidence,
    checkedAt: base.checkedAt,
    note: 'stored T1 association re-validated against independently retrieved run detail',
  };
  task.reconciliation = [...((task && task.reconciliation) || []), entry];
  return {
    identity: { ...base, state: 'reconciled', runId: adoption.runId, childConversationId: detail.conversation_id || null, statusObserved: detail.status || null },
    task,
    appended: true,
  };
}

// Historical path for envelopes recorded BEFORE T1 (attempts carry no
// `adoption`): the persisted association block (task.conversation) is the
// ONLY selector, applied to candidate runs retrieved by the caller. A
// candidate is admitted only on a FULL five-leg verification — workflow,
// parent db id, parent platform id, project, and the exact dispatched
// message — so a second child of the same parent can only create an
// ambiguity, never a silent swap. Exactly one verified candidate → an
// append-only `child-run-identified` entry; more → an explicit ambiguity;
// zero (with a successful read) → unresolved with no claim made.
//
// `expectedMessage` must be composed by the caller exactly as dispatch
// composed it ('task <taskId>: <objective>') — never read back from a run.
// `fetchDetail` may be async; a candidate whose detail cannot be read is
// simply not verified — a read failure never manufactures attribution.
export async function identifyHistoricalRun(task, { runs, fetchDetail, expectedMessage, checkedAt }) {
  const base = { checkedAt: checkedAt || null };
  const association = (task && task.conversation) || null;
  const attempts = (task && Array.isArray(task.attempts)) ? task.attempts : [];
  const knownRunIds = new Set(attempts.map((a) => a && a.runId).filter(Boolean));
  if (!association || !association.dbId) {
    return { identity: { ...base, state: 'unresolved', reason: 'no persisted association block to identify from' }, task, appended: false };
  }
  if (!attempts.length) {
    return { identity: { ...base, state: 'unresolved', reason: 'no attempts recorded' }, task, appended: false };
  }
  const workflow = attempts.map((a) => a && a.workflow).find(Boolean) || null;
  if (!workflow) {
    return { identity: { ...base, state: 'unresolved', reason: 'no expected workflow recorded on any attempt' }, task, appended: false };
  }
  const candidates = (runs || []).filter((r) => r && r.id && !knownRunIds.has(r.id) && runWorkflowName(r) === workflow);
  const verified = [];
  for (const candidate of candidates) {
    let detail = null;
    try {
      detail = fetchDetail ? await fetchDetail(candidate.id) : candidate;
    } catch {
      detail = null;
    }
    const check = verifyParentLinkage(detail, association, workflow, expectedMessage);
    if (check.pass) verified.push({ detail, evidence: check.evidence });
  }
  if (verified.length === 1) {
    const { detail, evidence } = verified[0];
    const entry = {
      kind: 'child-run-identified',
      runId: detail.id,
      childConversationId: detail.conversation_id || null,
      statusObserved: detail.status || null,
      evidence,
      checkedAt: base.checkedAt,
      note: 'historical association identified a child run; the original observation (FAILED / run-not-found) is preserved verbatim above and unchanged',
    };
    task.reconciliation = [...((task && task.reconciliation) || []), entry];
    return {
      identity: { ...base, state: 'identified', runId: detail.id, childConversationId: detail.conversation_id || null, statusObserved: detail.status || null },
      task,
      appended: true,
    };
  }
  if (verified.length > 1) {
    const entry = {
      kind: 'identification-ambiguous',
      candidates: verified.map((v) => v.detail.id),
      checkedAt: base.checkedAt,
      note: 'more than one run verifies against the historical association — no attribution is made',
    };
    task.reconciliation = [...((task && task.reconciliation) || []), entry];
    return {
      identity: { ...base, state: 'unresolved', reason: 'ambiguous: ' + verified.length + ' runs independently verify against the persisted association (' + entry.candidates.join(', ') + ')' },
      task,
      appended: true,
    };
  }
  return { identity: { ...base, state: 'unresolved', reason: 'no verified association: no run in a successful read satisfies the persisted association' }, task, appended: false };
}
