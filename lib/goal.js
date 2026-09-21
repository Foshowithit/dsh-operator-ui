// dsh-operator-ui — GoalRunner v1.
//
// objective -> ROUTE -> AUTHORITY -> EXECUTE -> EVIDENCE -> CAPABILITY
// VALIDATION -> OBJECTIVE EVALUATION -> VERDICT.
//
// Three truths stay separate:
//   execution completed != capability validated != objective satisfied.
// SHIP is earned only when all three are supported by evidence.
// Executed task identity is durable through an explicit, persisted
// conversation association (lib/conversation.js): the dispatch conversation id
// is what Archon returned when the conversation was provisioned — never
// derived from the task id, and re-verified immediately before every dispatch.
//
// The operator layer sits on top of the three truths and never blurs them:
// the trust ladder names the truth each rung vouches for, and a Next Action
// suggests the single operator move that unblocks the goal (it never
// auto-executes).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolveConfig } from './config.js';
import { requiresOf, decisionFor } from './authority.js';
import { upsertTask, envelopeFromGoal, getTask, peekTask, listTasks, forkTaskId } from './tasks.js';
import { admitTask, evaluateObjective, buildClaim } from './task-truth.js';
import { requireDispatchableConversation, associatedConversationId } from './conversation.js';

const sha256 = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const isoNow = () => new Date().toISOString();

function archonHeaders() {
  const { config } = resolveConfig();
  const headers = {};
  const tokenVar = config.archon.tokenVar;
  if (typeof tokenVar === 'string' && process.env[tokenVar]) headers.authorization = 'Bearer ' + process.env[tokenVar];
  return headers;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'in', 'on', 'of', 'to', 'for', 'and', 'or', 'my', 'me', 'it', 'is', 'are', 'this', 'that', 'with', 'give', 'do', 'rcos', 'please']);

export function tokenize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export function routeObjective(objective, registry) {
  const caps = registry && Array.isArray(registry.capabilities) ? registry.capabilities : [];
  const objTokens = new Set(tokenize(objective));
  const scored = [];
  for (const c of caps) {
    if (c.seed === true) continue;
    const hay = tokenize([c.id, c.name, c.description, (c.tags || []).join(' ')].join(' '));
    let hits = 0;
    for (const t of objTokens) if (hay.includes(t)) hits++;
    const score = objTokens.size ? hits / Math.max(objTokens.size, 1) : 0;
    const reasons = [];
    if (c.workflow) reasons.push('implements workflow ' + c.workflow);
    if (score > 0) reasons.push('matched ' + hits + '/' + objTokens.size + ' objective terms');
    else reasons.push('no objective terms matched');
    if (c.status === 'retired') reasons.push('lifecycle RETIRED');
    scored.push({ capability: c, score, hits, reasons });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored.find((s) => s.capability.workflow) || null;
  const decision = {
    objective,
    considered: scored.map((s) => ({ id: s.capability.id, score: Number(s.score.toFixed(2)), reasons: s.reasons })),
    selected: null,
    reason: null,
  };
  if (!best || best.score <= 0) {
    decision.reason = 'no capability in the registry matches this objective — add intelligence first';
    return decision;
  }
  if (best.score < 0.5 || best.hits < 2) {
    decision.reason = 'best candidate ' + best.capability.id + ' matches too weakly (' + best.hits + ' of ' + objTokens.size + ' objective terms, score ' + best.score.toFixed(2) + ') — refusing to guess; refine the objective or add intelligence';
    return decision;
  }
  if (best.capability.status === 'retired') {
    decision.reason = 'best match ' + best.capability.id + ' is RETIRED — routing refused';
    return decision;
  }
  decision.selected = { id: best.capability.id, version: best.capability.version || null, workflow: best.capability.workflow, lifecycle: best.capability.status || 'unknown' };
  decision.reason = best.reasons.join('; ');
  return decision;
}

// Dispatch answers an ACCEPTANCE, not the run (OP-4, verified against the live
// adapter): the response body carries no run identity today. The body is still
// captured and hashed, and any run id / correlation token it ever does carry is
// preferred over searching recent runs — verified through the same run-detail
// path as every other adoption before it is trusted.
async function dispatchWorkflow(workflowName, message, conversationId) {
  const { config } = resolveConfig();
  const res = await fetch(config.archon.baseUrl + '/api/workflows/' + encodeURIComponent(workflowName) + '/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...archonHeaders() },
    body: JSON.stringify({ message, conversationId }),
    signal: AbortSignal.timeout(Math.max(config.archon.timeoutMs, 10000)),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error('dispatch HTTP ' + res.status);
  const token = body && (body.runId || body.run_id || body.correlationId || (body.run && body.run.id));
  return {
    accepted: !!(body && body.accepted),
    status: (body && body.status) || null,
    runId: token ? String(token) : null,
    responseSha256: body ? sha256(JSON.stringify(body)) : null,
  };
}

// Run discovery is identity-strict (T1), revised by OP-4R. Adoption has three
// modes, in preference order:
//   1. dispatch-provided — a direct run identifier / correlation token taken
//      from the dispatch response body, verified through the same run-detail
//      path as every other mode before it is trusted;
//   2. direct-exact — the run carries conversation_id EXACTLY equal to our
//      bound platform id AND the expected workflow name (the S2-R contract,
//      unchanged);
//   3. parent-linked — the server forked a CHILD conversation for the worker,
//      so run.conversation_id is an id we have never seen. The run is adopted
//      only when independently retrieved run detail proves it belongs to OUR
//      dispatch: exact workflow name, parent_conversation_id equal
//      (namespace-exact, db-id against db-id) to the persisted association,
//      parent_platform_id equal (platform-id against platform-id) to the
//      persisted association, codebase_id equal to the association's expected
//      project, and an exact user_message equal to the message dispatched.
//      Two runs that both verify fail closed as 'run-ambiguous'; a
//      workflow-name-only match is never adoption.
const ADOPTION_DEADLINE_MS = 10000;
const ADOPTION_POLL_MS = 500;
const ADOPTION_SETTLE_POLLS = 2;

export const runWorkflowName = (run) => (run && (run.workflow_name || (run.workflow && run.workflow.name))) || null;

async function fetchRunDetail(runId) {
  const { config } = resolveConfig();
  try {
    const res = await fetch(config.archon.baseUrl + '/api/workflows/runs/' + encodeURIComponent(runId), { headers: archonHeaders(), signal: AbortSignal.timeout(config.archon.timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    const run = body && body.run ? body.run : body;
    if (!run || typeof run !== 'object') return null;
    return { ...run, id: run.id || runId };
  } catch {
    return null;
  }
}

export function directExact(run, conversationId, workflowName) {
  return Boolean(run) && run.conversation_id === conversationId && runWorkflowName(run) === workflowName;
}

// Every leg is an independent check with its own recorded outcome; a missing
// association key fails closed rather than passing vacuously.
export function verifyParentLinkage(detail, association, workflowName, dispatchedMessage) {
  const evidence = [];
  const leg = (id, pass, got, reason) => evidence.push(reason ? { id, pass, got, reason } : { id, pass, got });
  if (!detail) {
    leg('workflow-name', false, null, 'run detail is null');
    leg('parent-conversation-id', false, null, 'run detail is null');
    leg('parent-platform-id', false, null, 'run detail is null');
    leg('codebase-id', false, null, 'run detail is null');
    leg('user-message', false, null, 'run detail is null');
    return { pass: false, evidence };
  }
  leg('workflow-name', runWorkflowName(detail) === workflowName, runWorkflowName(detail));
  if (!association || !association.dbId) leg('parent-conversation-id', false, null, 'association has no recorded db id');
  else leg('parent-conversation-id', detail.parent_conversation_id === association.dbId, detail.parent_conversation_id);
  if (!association || !association.archonConversationId) leg('parent-platform-id', false, null, 'association has no recorded platform id');
  else leg('parent-platform-id', detail.parent_platform_id === association.archonConversationId, detail.parent_platform_id);
  if (!association || !association.expectedCodebaseId) leg('codebase-id', false, null, 'association has no expected project id');
  else leg('codebase-id', detail.codebase_id === association.expectedCodebaseId, detail.codebase_id);
  leg('user-message', detail.user_message === dispatchedMessage, detail.user_message);
  return { pass: evidence.every((e) => e.pass), evidence };
}

export function adoptionRecord({ mode, detail, conversationId, workflowName, evidence, candidatesConsidered, discoveredAfterMs, detailText }) {
  return {
    mode,
    runId: detail.id,
    workflow: runWorkflowName(detail) || workflowName,
    boundConversationId: conversationId,
    // The child conversation id is recorded verbatim as provenance and is
    // never compared against either namespace of the durable association.
    childConversationId: detail.conversation_id || null,
    parentConversationId: detail.parent_conversation_id || null,
    parentPlatformId: detail.parent_platform_id || null,
    codebaseId: detail.codebase_id || null,
    userMessage: detail.user_message || null,
    verifiedFrom: 'run-detail',
    evidence: evidence || [],
    candidatesConsidered: candidatesConsidered || 1,
    discoveredAfterMs: discoveredAfterMs == null ? null : discoveredAfterMs,
    detailSha256: detailText ? sha256(detailText) : null,
  };
}

async function discoverRun({ workflowName, preIds, conversationId, association, dispatchedMessage, dispatchedRunId }) {
  const { config } = resolveConfig();
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const rejected = [];
  const consideredIds = new Set();
  let candidatesConsidered = 0;

  // (1) dispatch-provided identity, verified before trust.
  if (dispatchedRunId) {
    candidatesConsidered += 1;
    const detail = await fetchRunDetail(dispatchedRunId);
    if (detail && runWorkflowName(detail) === workflowName) {
      const adoption = adoptionRecord({ mode: 'dispatch-provided', detail, conversationId, workflowName, evidence: verifyParentLinkage(detail, association, workflowName, dispatchedMessage).evidence, candidatesConsidered, discoveredAfterMs: elapsed(), detailText: JSON.stringify(detail) });
      return { status: 'found', adoption, candidates: [dispatchedRunId], rejected, dispatchToken: dispatchedRunId, elapsedMs: elapsed() };
    }
    rejected.push({ id: dispatchedRunId, source: 'dispatch-token', reason: detail ? 'workflow mismatch' : 'run detail not retrievable' });
  }

  // (2)+(3) direct-exact and parent-linked candidates, polled to the deadline.
  let verified = null;
  let verifiedPolls = 0;
  for (;;) {
    try {
      const lr = await fetch(config.archon.baseUrl + '/api/workflows/runs?limit=50', { headers: archonHeaders(), signal: AbortSignal.timeout(config.archon.timeoutMs) });
      if (lr.ok) {
        const lb = await lr.json();
        const runs = (lb && lb.runs) || [];
        const fresh = runs.filter((r) => r && r.id && !preIds.has(r.id));
        const exact = fresh.find((r) => directExact(r, conversationId, workflowName));
        if (exact) {
          candidatesConsidered += 1;
          const detail = await fetchRunDetail(exact.id);
          const source = detail || exact;
          const check = verifyParentLinkage(source, association, workflowName, dispatchedMessage);
          const adoption = adoptionRecord({ mode: 'direct-exact', detail: source, conversationId, workflowName, evidence: check.evidence, candidatesConsidered, discoveredAfterMs: elapsed(), detailText: JSON.stringify(detail || exact) });
          return { status: 'found', adoption, candidates: [exact.id], rejected, dispatchToken: null, elapsedMs: elapsed() };
        }
        const matching = fresh.filter((r) => runWorkflowName(r) === workflowName);
        for (const c of matching) {
          // One examination per run: the settle polls re-list the same rows,
          // and re-counting them would inflate candidatesConsidered and
          // duplicate rejected entries.
          if (consideredIds.has(c.id)) continue;
          consideredIds.add(c.id);
          candidatesConsidered += 1;
          const detail = await fetchRunDetail(c.id);
          if (!detail) {
            rejected.push({ id: c.id, reason: 'run detail not retrievable' });
            continue;
          }
          const check = verifyParentLinkage(detail, association, workflowName, dispatchedMessage);
          if (!check.pass) {
            rejected.push({ id: c.id, reason: 'parent linkage failed: ' + check.evidence.filter((e) => !e.pass).map((e) => e.id).join(','), childConversationId: detail.conversation_id || null });
            continue;
          }
          if (verified && verified.detail.id !== detail.id) {
            // Two runs both prove they belong to this dispatch: no unique,
            // independently supported attribution means no adoption.
            return { status: 'ambiguous', adoption: null, candidates: [verified.detail.id, detail.id], rejected, dispatchToken: null, elapsedMs: elapsed() };
          }
          if (!verified) verifiedPolls = 1;
          verified = { detail, evidence: check.evidence, text: JSON.stringify(detail) };
        }
      }
    } catch { /* keep polling */ }

    if (verified) {
      if (verifiedPolls >= ADOPTION_SETTLE_POLLS) {
        const adoption = adoptionRecord({ mode: 'parent-linked', detail: verified.detail, conversationId, workflowName, evidence: verified.evidence, candidatesConsidered, discoveredAfterMs: elapsed(), detailText: verified.text });
        return { status: 'found', adoption, candidates: [verified.detail.id], rejected, dispatchToken: null, elapsedMs: elapsed() };
      }
      verifiedPolls += 1;
    }
    if (Date.now() - startedAt > ADOPTION_DEADLINE_MS) {
      return { status: 'none', adoption: null, candidates: [], rejected, dispatchToken: null, elapsedMs: elapsed() };
    }
    await new Promise((r) => setTimeout(r, ADOPTION_POLL_MS));
  }
}

// Diagnostic for the discovered-null path: if a run DID appear on our
// conversation with a different workflow, that is an identity failure worth
// naming precisely, not a generic run-not-found.
async function findConversationRun(conversationId, preIds) {
  const { config } = resolveConfig();
  try {
    const lr = await fetch(config.archon.baseUrl + '/api/workflows/runs?limit=50', { headers: archonHeaders(), signal: AbortSignal.timeout(config.archon.timeoutMs) });
    if (!lr.ok) return null;
    const lb = await lr.json();
    const runs = (lb && lb.runs) || [];
    return runs.find((r) => r && !preIds.has(r.id) && r.conversation_id === conversationId) || null;
  } catch {
    return null;
  }
}

async function pollRun(runId) {
  const { config } = resolveConfig();
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const res = await fetch(config.archon.baseUrl + '/api/workflows/runs/' + encodeURIComponent(runId), { headers: archonHeaders(), signal: AbortSignal.timeout(config.archon.timeoutMs) });
      if (res.ok) {
        const body = await res.json();
        const run = body && body.run ? body.run : body;
        const events = body && body.events ? body.events : [];
        const st = run && run.status;
        if (st && st !== 'running' && st !== 'queued' && st !== 'pending') return { run, events, detailText: JSON.stringify(body) };
      }
    } catch { /* keep polling */ }
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const collectOutputs = (events) => {
  const outs = [];
  for (const e of events || []) {
    const d = e && e.data;
    const o = d && (typeof d.node_output === 'string' ? d.node_output : (typeof d.output === 'string' ? d.output : null));
    if (o && o.trim()) outs.push({ node: e.step_name || 'node', output: o.trim() });
  }
  return outs;
};

// The v0 gate asked two questions: terminal status + the capability's declared
// expectation. A capability that declares no expectation can reach COMPLETED
// but never SHIP — evidence, not optimism.
export function validateCapability({ runStatus, expect, evidenceText }) {
  const terminalExpected = expect && expect.terminalStatus ? String(expect.terminalStatus) : 'completed';
  const checks = [{ id: 'terminal-status', pass: runStatus === terminalExpected }];
  if (expect && expect.expectOutput) checks.push({ id: 'declared-expectation', pass: String(evidenceText || '').includes(expect.expectOutput) });
  else checks.push({ id: 'declared-expectation', pass: false, reason: 'capability has no declared expectation' });
  return { pass: checks.every((c) => c.pass), checks };
}

// ------------------------------------------------- objective evaluation (M1)
//
// The third truth is OBJECTIVE SATISFACTION, and it is answered by the
// capability's own DECLARED EVALUATOR (capability.objectiveEvaluation in the
// registry — output-lines / output-contains kinds), evaluated against the
// collected evidence by lib/task-truth.js. No hidden policy, no LLM judge, no
// new dependencies: a capability that declares no evaluator yields
// NOT_EVALUATED, and a declared evaluator the evidence misses yields
// NOT_SATISFIED. Either way the verdict BLOCKs — evidence, not optimism.

// ---------------------------------------------------------- trust ladder (M1)
//
// Observed → Executed → Validated → Objective satisfied, DERIVED per goal from
// the same fields and RECONCILED with the three-truth model, never replacing
// it: each rung names the truth it vouches for (execution, capability
// validation, objective evaluation). Rungs are cumulative — a higher rung
// implies every rung below it.
//
//   Observed            the goal exists with an objective (truth: none yet)
//   Executed            an attempt reached a terminal run status on the
//                       execution adapter (truth: execution)
//   Validated           the 2-check gate passed: terminal status +
//                       capability's declared expectation (truth: capability
//                       validation)
//   Objective satisfied the 3-check gate passed: + objective satisfaction
//                       (truth: objective evaluation)
export const LADDER = ['Observed', 'Executed', 'Validated', 'Objective satisfied'];

export function trustLadder(goal) {
  const attempts = (goal && goal.attempts) || [];
  const last = attempts[attempts.length - 1] || null;
  const checks = (goal && goal.checks) || [];
  const rung = { index: 0, label: 'Observed', truth: null };
  const executed = !!(last && typeof last.status === 'string' && !['running', 'queued', 'pending'].includes(last.status));
  if (executed) {
    rung.index = 1;
    rung.label = 'Executed';
    rung.truth = 'execution';
  }
  const validated = executed && checks.some((c) => c.id === 'terminal-status' && c.pass) &&
    (!checks.some((c) => c.id === 'declared-expectation') || checks.some((c) => c.id === 'declared-expectation' && c.pass));
  if (validated) {
    rung.index = 2;
    rung.label = 'Validated';
    rung.truth = 'capability validation';
  }
  if (validated && checks.some((c) => c.id === 'objective-satisfaction' && c.pass)) {
    rung.index = 3;
    rung.label = 'Objective satisfied';
    rung.truth = 'objective evaluation';
  }
  return { rungs: LADDER, ...rung };
}

// ----------------------------------------------------------- next action (M1)
//
// Next Action is a first-class enumerated operator action DERIVED from verdict
// + failureCodes + ladder position. It SUGGESTS; it never auto-executes.
// Approval is suggested through the same channel: an awaiting-approval task
// names 'approve' with the authority reason, and the Preview surface renders
// the envelope's authority block as "RCOS plans to …".
export function nextAction(goal) {
  const verdict = goal && goal.verdict;
  const codes = new Set((goal && goal.failureCodes) || []);
  const ladder = trustLadder(goal);
  const act = (kind, label, reason) => ({ kind, label, reason, ladder: ladder.label });
  if (codes.has('awaiting-approval')) {
    const why = (goal && goal.authority && goal.authority.reason) || 'the capability needs authority the preset does not pre-authorize';
    return act('approve', 'Approve plan', why);
  }
  if (verdict === 'PENDING' || !verdict) return act('wait', 'Wait for the run', 'the goal has not reached a verdict yet');
  if (verdict === 'SHIP') {
    return codes.size
      ? act('inspect', 'Inspect checks', 'shipped with advisory codes: ' + [...codes].join(', '))
      : act('ship', 'Ship it', 'execution, capability validation, and objective evaluation all passed');
  }
  if (codes.has('objective-required')) return act('refine', 'Refine the objective', 'no objective was given — say what you want done');
  if (codes.has('registry-not-configured')) return act('configure', 'Configure the registry', 'routing needs registry truth — set registry.path');
  if (codes.has('no-route')) return act('teach', 'Acquire capability', 'no capability matches this objective — RCOS can acquire one (bounded staged evaluation; your explicit promotion)');
  if (codes.has('run-not-found')) return act('retry', 'Retry (same task)', 'dispatch was accepted but no run appeared — a retry may let discovery catch up');
  if (codes.has('run-timeout')) return act('inspect', 'Inspect the run', 'the run never reached a terminal state — look before retrying');
  if (codes.has('run-failed')) return act('retry', 'Retry (same task)', 'the execution adapter reported failure — retry preserves task identity');
  if (codes.has('expectation-not-met') || codes.has('capability-validation-failed')) return act('inspect', 'Inspect the evidence', 'the run finished but its evidence missed the capability\u2019s declared expectation');
  if (codes.has('objective-not-evaluated')) return act('configure', 'Declare an objective evaluator', 'the capability declares no objective evaluator — satisfaction cannot be evaluated until it does');
  if (codes.has('objective-not-satisfied')) return act('fork', 'Fork as new task', 'the capability ran clean but did not satisfy the objective — fork to try different intelligence');
  if (codes.has('run-not-terminal')) return act('inspect', 'Inspect the run', 'the run left no terminal status to evaluate');
  if (codes.has('conversation-not-bound')) return act('provision', 'Provision the conversation', 'no Archon conversation is associated with this task — provision one through the supported interface before dispatch');
  if (codes.has('conversation-provision-unresolved')) return act('inspect', 'Inspect provisioning', 'a provisioning intent is recorded without a conversation id — reconcile the orphan before re-provisioning');
  if (codes.has('conversation-association-dangling')) return act('inspect', 'Inspect the association', 'the associated conversation no longer exists in Archon — the association must be reconciled, never silently re-created');
  if (codes.has('conversation-bound-wrong-project')) return act('inspect', 'Inspect the project binding', 'the conversation is bound to a different project than the recorded association expects');
  if ([...codes].some((c) => c.startsWith('conversation-'))) return act('inspect', 'Inspect provisioning', 'conversation provisioning or verification failed — inspect before retrying');
  return act('inspect', 'Inspect the task', 'verdict ' + verdict + ' — open the spine before acting');
}

// The three truths collapse into exactly one verdict + failure code here —
// nothing else in the system decides SHIP/BLOCK/FAILED.
export function deriveGoalVerdict({ execution, capabilityValidation, objectiveEvaluation }) {
  if (execution && execution.status === 'failed') return { verdict: 'FAILED', failureCode: 'run-failed' };
  if (!execution || execution.completed !== true) return { verdict: 'FAILED', failureCode: 'run-not-terminal' };
  if (!capabilityValidation || capabilityValidation.pass !== true) return { verdict: 'BLOCK', failureCode: 'capability-validation-failed' };
  if (!objectiveEvaluation || objectiveEvaluation.status === 'NOT_EVALUATED') return { verdict: 'BLOCK', failureCode: 'objective-not-evaluated' };
  if (objectiveEvaluation.status !== 'SATISFIED' || objectiveEvaluation.pass !== true) return { verdict: 'BLOCK', failureCode: 'objective-not-satisfied' };
  return { verdict: 'SHIP', failureCode: null };
}

// ------------------------------------------------------------------ goal

export async function listGoals() { return listTasks(); }
// The host's GET-by-id path is synchronous. listGoals() hydrates this cache
// from Archon after restart; GoalRunner itself uses getTask() below whenever
// it requires authoritative async reconstruction for retry/fork.
export function getGoal(taskId) { return peekTask(taskId); }

let inflight = null;

export function runGoal({ objective, retryOf, forkOf, approved, authorization }) {
  if (inflight) return inflight;
  inflight = _run({ objective, retryOf, forkOf, approved, authorization }).finally(() => { inflight = null; });
  return inflight;
}

async function _run({ objective, retryOf, forkOf, approved, authorization }) {
  let taskId;
  let conversationId = null;
  let lineage = null;
  let priorAttempts = [];
  // The attempt this invocation creates. Hoisted so the catch can stamp ONLY
  // its own attempt — attempts carried in from a prior attempt are immutable
  // recorded truth and are never rewritten.
  let attempt = null;

  let carriedApprovalAt = null;
  if (retryOf) {
    const parent = await getTask(retryOf);
    if (!parent) throw Object.assign(new Error('retry parent not found: ' + retryOf), { code: 'retry-parent-not-found' });
    taskId = parent.taskId;
    // T1 (amended): a retry dispatches on the conversation explicitly and
    // durably associated with the SAME task — or fails closed in the gate
    // below when none exists. No derived id.
    conversationId = await associatedConversationId(taskId);
    objective = objective || parent.objective;
    // Prior attempts are CLONED: they are carried forward as recorded truth
    // and never mutated by this invocation. The last carried attempt is
    // backfilled (append-only) from the parent envelope's already-recorded
    // failure truth where the attempt itself did not carry it.
    priorAttempts = (Array.isArray(parent.attempts) ? parent.attempts : []).map((a) => ({ ...a }));
    const carriedLast = priorAttempts[priorAttempts.length - 1];
    if (carriedLast) {
      if (!carriedLast.failureCode && Array.isArray(parent.failureCodes) && parent.failureCodes.length) carriedLast.failureCode = parent.failureCodes[0];
      if (!carriedLast.error && parent.error) carriedLast.error = parent.error;
      if (!carriedLast.endedAt) carriedLast.endedAt = parent.endedAt || null;
    }
    carriedApprovalAt = (parent.authority && parent.authority.approvedAt) || null;
    lineage = parent.lineage || null;
  } else if (forkOf) {
    const parent = await getTask(forkOf);
    if (!parent) throw Object.assign(new Error('fork parent not found: ' + forkOf), { code: 'fork-parent-not-found' });
    taskId = forkTaskId();
    // A fork is a NEW task identity: it has no conversation association until
    // one is provisioned for it explicitly. The dispatch gate below enforces
    // that; no id is derived from the new task id.
    objective = objective || parent.objective;
    lineage = { parentTaskId: parent.taskId, forkedFromTaskId: parent.taskId };
  } else {
    const admitted = admitTask(objective);
    taskId = admitted.taskId;
    objective = admitted.objective;
  }

  const goal = {
    taskId,
    conversationId,
    // The explicit conversation association is attached to the goal after the
    // dispatch gate runs (see below); until then it is unset.
    conversation: null,
    objective: String(objective || '').slice(0, 500),
    startedAt: isoNow(),
    endedAt: null,
    route: null,
    attempts: priorAttempts,
    checks: [],
    execution: null,
    capabilityValidation: null,
    objectiveEvaluation: null,
    claim: null,
    trust: trustLadder({ attempts: [], checks: [] }),
    nextAction: nextAction({ verdict: 'PENDING', failureCodes: [] }),
    verdict: 'PENDING',
    failureCodes: [],
    lineage: lineage || undefined,
  };

  try {
    if (!objective || typeof objective !== 'string' || !objective.trim()) throw Object.assign(new Error('objective required'), { code: 'objective-required' });
    const resolved = resolveConfig();
    if (!resolved.config.registry.path) throw Object.assign(new Error('registry not configured — set registry.path'), { code: 'registry-not-configured' });
    const registry = JSON.parse(await readFile(resolved.config.registry.path, 'utf8'));
    const route = routeObjective(objective, registry);
    goal.route = route;
    if (!route.selected) throw Object.assign(new Error(route.reason), { code: 'no-route' });

    const capability = registry.capabilities.find((c) => c.id === route.selected.id) || {};
    const expect = capability.verification || null;
    const objectiveEvaluator = capability.objectiveEvaluation || null;

    // ---- AUTHORITY (permissions round): the capability declares what it
    // REQUIRES; the operator preset pre-authorizes (grants) a subset. When the
    // decision is approval, seal an awaiting-approval envelope and return
    // BEFORE dispatch — the Preview surface renders this envelope; approval
    // resumes the SAME task (retryOf + approved flag).
    const { requires, unknown } = requiresOf(capability);
    const preset = resolveConfig().config.authority.preset;
    const decision = decisionFor(preset, requires, unknown);
    goal.authority = {
      preset,
      requires,
      granted: decision.granted,
      missing: decision.missing,
      mode: decision.mode,
      reason: decision.reason,
      approvedAt: null,
    };
    if (decision.mode === 'approval' && !approved) {
      goal.verdict = 'PENDING';
      goal.failureCodes = ['awaiting-approval'];
      goal.trust = trustLadder(goal);
      goal.nextAction = nextAction(goal);
      goal.endedAt = null;
      await upsertTask(envelopeFromGoal(goal, goal.lineage));
      return goal;
    }
    if (approved) {
      // A retry resumes an ALREADY-APPROVED task: the genuine approval
      // timestamp recorded on the prior attempt is CARRIED forward, never
      // re-stamped — re-stamping would manufacture approval evidence the
      // operator never gave at this attempt's time. The retry authorization
      // itself is recorded transparently beside it.
      if (retryOf && carriedApprovalAt) {
        goal.authority.approvedAt = carriedApprovalAt;
        goal.authority.approvedFrom = 'carried-from-prior-attempt';
      } else {
        goal.authority.approvedAt = isoNow();
        goal.authority.approvedFrom = 'granted-at-this-attempt';
      }
      if (retryOf) {
        goal.authority.retryAuthorization = {
          authorizedAt: isoNow(),
          carriedApprovalAt: carriedApprovalAt || null,
          via: (authorization && authorization.source) || 'unspecified',
        };
      }
    }

    // ---- T1 CONVERSATION GATE (S2-R, amended): a dispatch may only proceed
    // on the conversation explicitly and durably associated with this task,
    // verified LIVE against Archon immediately before dispatch. The run's
    // conversation_id must exactly equal the persisted association id, and the
    // workflow name must match independently (enforced again in run
    // discovery). A workflow-name-only fallback is prohibited. Anything short
    // of a verified association fails closed BEFORE any dispatch.
    const bound = await requireDispatchableConversation({ taskId });
    conversationId = bound.conversationId;
    goal.conversationId = conversationId;
    goal.conversation = bound.association;

    // The exact message string is composed ONCE: dispatch sends it and T1
    // verification compares the run's recorded user_message against it.
    const dispatchMessage = 'task ' + taskId + ': ' + objective;
    attempt = {
      attempt: priorAttempts.length + 1,
      startedAt: isoNow(),
      workflow: route.selected.workflow,
      runId: null,
      status: null,
      outputs: [],
      verdict: null,
      failureCode: null,
      error: null,
      childConversationId: null,
      adoption: null,
      dispatch: null,
      discovery: null,
    };
    goal.attempts.push(attempt);

    const preIds = new Set();
    try {
      const cfg = resolveConfig().config;
      const lr = await fetch(cfg.archon.baseUrl + '/api/workflows/runs?limit=50', { headers: archonHeaders(), signal: AbortSignal.timeout(cfg.archon.timeoutMs) });
      if (lr.ok) {
        const lb = await lr.json();
        for (const r of (lb && lb.runs) || []) if (r && r.id) preIds.add(r.id);
      }
    } catch { /* discovery aid only */ }

    const dispatched = await dispatchWorkflow(route.selected.workflow, dispatchMessage, conversationId);
    attempt.dispatch = {
      accepted: dispatched.accepted,
      status: dispatched.status,
      runId: dispatched.runId,
      responseSha256: dispatched.responseSha256,
    };
    const discovery = await discoverRun({
      workflowName: route.selected.workflow,
      preIds,
      conversationId,
      association: bound.association,
      dispatchedMessage: dispatchMessage,
      dispatchedRunId: dispatched.runId,
    });
    if (discovery.status === 'ambiguous') {
      // Two runs independently verify as this dispatch: no unique attribution
      // means no adoption — fail closed rather than guess.
      throw Object.assign(
        new Error('run identity ambiguous — ' + discovery.candidates.length + ' runs independently verify as this dispatch: ' + discovery.candidates.join(', ')),
        { code: 'run-ambiguous' }
      );
    }
    if (discovery.status === 'none') {
      attempt.discovery = {
        candidates: discovery.candidates,
        dispatchToken: discovery.dispatchToken,
        rejected: discovery.rejected.slice(0, 5),
        elapsedMs: discovery.elapsedMs,
      };
      // Identity-precise diagnostics before the generic code: a run that
      // appeared on OUR conversation under a DIFFERENT workflow is a T1
      // identity failure, and a workflow-name match on a foreign conversation
      // is exactly the adoption the amended rule prohibits.
      const stray = await findConversationRun(conversationId, preIds);
      if (stray) {
        throw Object.assign(
          new Error('run ' + stray.id + ' appeared on conversation ' + conversationId + ' with workflow ' + (stray.workflow_name || (stray.workflow && stray.workflow.name) || 'unknown') + ', expected ' + route.selected.workflow),
          { code: 'workflow-name-mismatch' }
        );
      }
      throw Object.assign(new Error('dispatch accepted but no run appeared'), { code: 'run-not-found' });
    }
    attempt.adoption = discovery.adoption;
    attempt.childConversationId = discovery.adoption.childConversationId;
    attempt.runId = discovery.adoption.runId;

    const evidence = await pollRun(attempt.runId);
    if (!evidence) throw Object.assign(new Error('run did not reach a terminal state within 30s'), { code: 'run-timeout' });
    attempt.status = (evidence.run && evidence.run.status) || null;
    attempt.endedAt = isoNow();
    attempt.outputs = collectOutputs(evidence.events).map((o) => o.node + ': ' + o.output).slice(0, 10);
    const evidenceText = [evidence.detailText, ...attempt.outputs].join('\n');
    goal.evidence = { events: (evidence.events || []).length, outputs: attempt.outputs, evidenceSha256: sha256(evidence.detailText) };

    // ---- VERIFY (M1: the evaluation gate — terminal status + declared
    // expectation + OBJECTIVE SATISFACTION, in that order; 'verifier quorum'
    // is reserved for independent verification authorities that vote). Every
    // check records its detail inline: a BLOCK names what missed.
    goal.execution = { completed: evidence.run.status === 'completed', status: evidence.run.status, runId: attempt.runId };
    goal.capabilityValidation = validateCapability({ runStatus: evidence.run.status, expect, evidenceText });
    goal.objectiveEvaluation = evaluateObjective({
      executionCompleted: goal.execution.completed,
      capabilityValidation: goal.capabilityValidation,
      evaluator: objectiveEvaluator,
      evidenceText,
    });
    // One flat, inspectable list — the evidence drawer renders it and the
    // trust ladder reads it; objective-satisfaction is the rung-3 witness.
    goal.checks = [
      ...goal.capabilityValidation.checks,
      { id: 'objective-satisfaction', pass: goal.objectiveEvaluation.status === 'SATISFIED', detail: goal.objectiveEvaluation.reason },
      ...(goal.objectiveEvaluation.checks || []),
    ];
    goal.claim = buildClaim({
      kind: 'goal-satisfied',
      label: 'Goal satisfied',
      objectiveEvaluation: goal.objectiveEvaluation,
      capabilityValidation: goal.capabilityValidation,
      execution: goal.execution,
      observed: attempt.outputs,
      provenance: { capability: route.selected.id, version: route.selected.version, workflow: route.selected.workflow },
    });

    const verdictDecision = deriveGoalVerdict({ execution: goal.execution, capabilityValidation: goal.capabilityValidation, objectiveEvaluation: goal.objectiveEvaluation });
    goal.verdict = verdictDecision.verdict;
    if (verdictDecision.failureCode) goal.failureCodes.push(verdictDecision.failureCode);

    goal.trust = trustLadder(goal);
    goal.nextAction = nextAction(goal);
  } catch (e) {
    goal.verdict = 'FAILED';
    goal.failureCodes.push((e && e.code) || 'goal-failed');
    goal.error = String((e && e.message) || e).slice(0, 200);
    // Only OUR attempt is stamped: attempts carried in from a prior attempt are
    // immutable recorded truth. The failure this invocation hit is recorded on
    // the attempt it belongs to, beside the goal-level code.
    if (attempt && !attempt.endedAt) attempt.endedAt = isoNow();
    if (attempt) {
      attempt.failureCode = (e && e.code) || 'goal-failed';
      attempt.error = String((e && e.message) || e).slice(0, 200);
    }
    // Even a refusal carries its ladder + next action: Observed + the
    // operator action that unblocks it (configure / teach / refine).
    goal.trust = trustLadder(goal);
    goal.nextAction = nextAction(goal);
  }

  goal.endedAt = isoNow();
  await upsertTask(envelopeFromGoal(goal, goal.lineage));
  return goal;
}
