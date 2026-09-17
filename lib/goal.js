// dsh-operator-ui — GoalRunner v1.
//
// objective -> ROUTE -> AUTHORITY -> EXECUTE -> EVIDENCE -> CAPABILITY
// VALIDATION -> OBJECTIVE EVALUATION -> VERDICT.
//
// Three truths stay separate:
//   execution completed != capability validated != objective satisfied.
// SHIP is earned only when all three are supported by evidence.
// Executed task identity is durable through Archon's conversation_id; this
// module creates no persistence of its own.
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
import { admitTask, taskConversationId, evaluateObjective, buildClaim } from './task-truth.js';

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

async function dispatchWorkflow(workflowName, message, conversationId) {
  const { config } = resolveConfig();
  const res = await fetch(config.archon.baseUrl + '/api/workflows/' + encodeURIComponent(workflowName) + '/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...archonHeaders() },
    body: JSON.stringify({ message, conversationId }),
    signal: AbortSignal.timeout(Math.max(config.archon.timeoutMs, 10000)),
  });
  if (!res.ok) throw new Error('dispatch HTTP ' + res.status);
}

async function discoverRun(workflowName, preIds, conversationId) {
  const { config } = resolveConfig();
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const lr = await fetch(config.archon.baseUrl + '/api/workflows/runs?limit=50', { headers: archonHeaders(), signal: AbortSignal.timeout(config.archon.timeoutMs) });
      if (lr.ok) {
        const lb = await lr.json();
        const runs = (lb && lb.runs) || [];
        const exact = runs.find((r) => r && !preIds.has(r.id) && r.conversation_id === conversationId && (r.workflow_name === workflowName || (r.workflow && r.workflow.name === workflowName)));
        if (exact) return exact;
        const fallback = runs.find((r) => r && !preIds.has(r.id) && (r.workflow_name === workflowName || (r.workflow && r.workflow.name === workflowName)));
        if (fallback) return fallback;
      }
    } catch { /* keep polling */ }
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
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

export function runGoal({ objective, retryOf, forkOf, approved }) {
  if (inflight) return inflight;
  inflight = _run({ objective, retryOf, forkOf, approved }).finally(() => { inflight = null; });
  return inflight;
}

async function _run({ objective, retryOf, forkOf, approved }) {
  let taskId;
  let conversationId;
  let lineage = null;
  let priorAttempts = [];

  if (retryOf) {
    const parent = await getTask(retryOf);
    if (!parent) throw Object.assign(new Error('retry parent not found: ' + retryOf), { code: 'retry-parent-not-found' });
    taskId = parent.taskId;
    conversationId = taskConversationId(taskId);
    objective = objective || parent.objective;
    priorAttempts = Array.isArray(parent.attempts) ? parent.attempts.slice() : [];
    lineage = parent.lineage || null;
  } else if (forkOf) {
    const parent = await getTask(forkOf);
    if (!parent) throw Object.assign(new Error('fork parent not found: ' + forkOf), { code: 'fork-parent-not-found' });
    taskId = forkTaskId();
    conversationId = taskConversationId(taskId);
    objective = objective || parent.objective;
    lineage = { parentTaskId: parent.taskId, forkedFromTaskId: parent.taskId };
  } else {
    const admitted = admitTask(objective);
    taskId = admitted.taskId;
    conversationId = admitted.conversationId;
    objective = admitted.objective;
  }

  const goal = {
    taskId,
    conversationId,
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
    if (approved) goal.authority.approvedAt = isoNow();

    const attempt = { attempt: priorAttempts.length + 1, startedAt: isoNow(), workflow: route.selected.workflow, runId: null, status: null, outputs: [], verdict: null };
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

    await dispatchWorkflow(route.selected.workflow, 'task ' + taskId + ': ' + objective, conversationId);
    const discovered = await discoverRun(route.selected.workflow, preIds, conversationId);
    if (!discovered) throw Object.assign(new Error('dispatch accepted but no run appeared'), { code: 'run-not-found' });
    attempt.runId = discovered.id;

    const evidence = await pollRun(discovered.id);
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
    goal.execution = { completed: evidence.run.status === 'completed', status: evidence.run.status, runId: discovered.id };
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
    const last = goal.attempts[goal.attempts.length - 1];
    if (last && !last.endedAt) last.endedAt = isoNow();
    // Even a refusal carries its ladder + next action: Observed + the
    // operator action that unblocks it (configure / teach / refine).
    goal.trust = trustLadder(goal);
    goal.nextAction = nextAction(goal);
  }

  goal.endedAt = isoNow();
  await upsertTask(envelopeFromGoal(goal, goal.lineage));
  return goal;
}
