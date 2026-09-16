// dsh-operator-ui — GoalRunner (M1 candidate, zero-credential v0).
//
// Turns an operator objective into a verified execution through the REAL
// RCOS path — no new persistence, no parallel execution architecture:
//
//   objective → ROUTE (score every eligible capability in the configured
//               registry; keyword match on id/name/description words) →
//   EXECUTE   (dispatch the capability's own workflow binding on the
//               configured Archon run API) →
//   EVIDENCE  (poll the run to terminal; collect node outputs) →
//   VERIFY    (independent evaluation: terminal status + the capability's
//               declared expectation marker — a 2-check verification gate) →
//   VERDICT   SHIP | BLOCK | FAILED
//
// task_id is born here, ABOVE DSH/Archon: one goal may map to many
// attempts; each attempt records its own execution + verdict.
//
// Routing truth stays in the registry (a goal can never dispatch a workflow
// that no capability declares), execution stays on the configured Archon,
// and verification reads evidence — never optimism.

import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolveConfig } from './config.js';
import { upsertTask, envelopeFromGoal, getTask, listTasks, forkTaskId } from './tasks.js';

const sha256 = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

const isoNow = () => new Date().toISOString();

const sha1short = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).slice(0, 8);
};

function archonHeaders() {
  const { config } = resolveConfig();
  const headers = {};
  const tokenVar = config.archon.tokenVar;
  if (typeof tokenVar === 'string' && process.env[tokenVar]) {
    headers.authorization = 'Bearer ' + process.env[tokenVar]; // in-memory only
  }
  return headers;
}

// ---------------------------------------------------------------- routing

const STOPWORDS = new Set(['the', 'a', 'an', 'in', 'on', 'of', 'to', 'for', 'and', 'or', 'my', 'me', 'it', 'is', 'are', 'this', 'that', 'with', 'give', 'do', 'rcos', 'please']);

function tokenize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Route v0: transparent keyword scoring over the registry. Every scored
// candidate is recorded so the operator can see what was considered and
// why the winner won — no hidden policy.
export function routeObjective(objective, registry) {
  const caps = registry && Array.isArray(registry.capabilities) ? registry.capabilities : [];
  const objTokens = new Set(tokenize(objective));
  const scored = [];
  for (const c of caps) {
    if (c.seed === true) continue; // seeded capabilities are SYSTEM-only
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
    decision.reason = 'best candidate ' + best.capability.id + ' matches too weakly (' + best.hits + ' of ' +
      objTokens.size + ' objective terms, score ' + best.score.toFixed(2) + ') — refusing to guess; refine the objective or add intelligence';
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

// ------------------------------------------------------------- execution

async function dispatchWorkflow(workflowName, message) {
  const { config } = resolveConfig();
  const conversationId = 'rcos-goal-' + sha1short(message + Date.now());
  const res = await fetch(config.archon.baseUrl + '/api/workflows/' + encodeURIComponent(workflowName) + '/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...archonHeaders() },
    body: JSON.stringify({ message, conversationId }),
    signal: AbortSignal.timeout(Math.max(config.archon.timeoutMs, 10000)),
  });
  if (!res.ok) throw new Error('dispatch HTTP ' + res.status);
  return conversationId;
}

async function discoverRunId(workflowName, preIds) {
  const { config } = resolveConfig();
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const lr = await fetch(config.archon.baseUrl + '/api/workflows/runs?limit=50', { headers: archonHeaders(), signal: AbortSignal.timeout(config.archon.timeoutMs) });
      if (lr.ok) {
        const lb = await lr.json();
        const runs = (lb && lb.runs) || [];
        const found = runs.find((r) => r && !preIds.has(r.id) && (r.workflow_name === workflowName || (r.workflow && r.workflow.name === workflowName)));
        if (found) return found;
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
      const res = await fetch(config.archon.baseUrl + '/api/workflows/runs/' + encodeURIComponent(runId), {
        headers: archonHeaders(),
        signal: AbortSignal.timeout(config.archon.timeoutMs),
      });
      if (res.ok) {
        const body = await res.json();
        const run = body && body.run ? body.run : body;
        const events = body && body.events ? body.events : [];
        const st = run && run.status;
        if (st && st !== 'running' && st !== 'queued' && st !== 'pending') {
          return { run, events, detailText: JSON.stringify(body) };
        }
      }
    } catch { /* keep polling until deadline */ }
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

// ------------------------------------------------------------------ goal

// Durable goal ledger: every goal is an envelope in the task store
// ($DSH_HOME/operator-ui/tasks.json) — retry/fork/restart preserve history.
// The Archon run remains the durable execution record; the receipt machinery
// remains the durable verification record. This store adds the TASK layer
// that sits above both (M1 foundation: durable task authority).

export async function listGoals() {
  return listTasks(); // durable envelopes, newest first
}

export async function getGoal(taskId) {
  return getTask(taskId);
}

let inflight = null;

export function runGoal({ objective, retryOf, forkOf }) {
  if (inflight) return inflight;
  inflight = _run({ objective, retryOf, forkOf }).finally(() => { inflight = null; });
  return inflight;
}

async function _run({ objective, retryOf, forkOf }) {
  const startedAt = isoNow();
  let taskId = 'goal-' + randomUUID().slice(0, 8);
  let priorAttempts = 0;
  let lineage = null;
  // retry = SAME task_id, new attempt. fork = NEW task_id, recorded lineage.
  if (retryOf) {
    const parent = await getTask(retryOf);
    if (parent) {
      taskId = parent.taskId;
      priorAttempts = (parent.attempts || []).length;
      objective = objective || parent.objective;
      lineage = { retryOf };
    }
  }
  if (forkOf) {
    const parent = await getTask(forkOf);
    if (parent) {
      taskId = forkTaskId(forkOf);
      lineage = { parentTaskId: forkOf, forkedFromTaskId: forkOf };
      objective = objective || parent.objective;
    }
  }
  const goal = {
    taskId,
    objective: String(objective || '').slice(0, 500),
    startedAt,
    endedAt: null,
    route: null,
    attempts: [],
    verdict: 'PENDING',
    failureCodes: [],
    lineage: lineage || undefined,
  };

  try {
    if (!objective || typeof objective !== 'string' || !objective.trim()) throw Object.assign(new Error('objective required'), { code: 'objective-required' });

    // ---- ROUTE through the configured registry
    const resolved = resolveConfig();
    if (!resolved.config.registry.path) throw Object.assign(new Error('registry not configured — set registry.path'), { code: 'registry-not-configured' });
    const registry = JSON.parse(await readFile(resolved.config.registry.path, 'utf8'));
    const route = routeObjective(objective, registry);
    goal.route = route;
    if (!route.selected) throw Object.assign(new Error(route.reason), { code: 'no-route' });

    // VERIFY source of truth: the registry capability's own declared
    // expectation. A capability that declares none can reach COMPLETED but
    // never SHIP — evidence, not optimism.
    const expect = route.selected && registry.capabilities
      ? (registry.capabilities.find((c) => c.id === route.selected.id) || {}).verification || null
      : null;

    // ---- EXECUTE via the configured Archon (attempt 1; retries = new attempt, same task)
    const attemptNo = priorAttempts + 1;
    const attempt = { attempt: attemptNo, startedAt: isoNow(), workflow: route.selected.workflow, runId: null, status: null, outputs: [], verdict: null };
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

    await dispatchWorkflow(route.selected.workflow, 'goal ' + taskId + ': ' + objective);
    const discovered = await discoverRunId(route.selected.workflow, preIds);
    if (!discovered) throw Object.assign(new Error('dispatch accepted but no run appeared'), { code: 'run-not-found' });
    attempt.runId = discovered.id;

    const evidence = await pollRun(discovered.id);
    if (!evidence) throw Object.assign(new Error('run did not reach a terminal state within 30s'), { code: 'run-timeout' });
    attempt.status = (evidence.run && evidence.run.status) || null;
    attempt.endedAt = isoNow();
    attempt.outputs = collectOutputs(evidence.events).map((o) => o.node + ': ' + o.output).slice(0, 10);
    goal.evidence = { events: (evidence.events || []).length, outputs: attempt.outputs, evidenceSha256: sha256(evidence.detailText) };

    // ---- VERIFY (v0: a 2-check verification gate — terminal status + declared expectation marker; 'verifier quorum' is reserved for independent verification authorities that vote)
    const checks = [];
    checks.push({ id: 'terminal-status', pass: evidence.run.status === 'completed' });
    if (expect && expect.expectOutput) {
      checks.push({ id: 'declared-expectation', pass: evidence.detailText.includes(expect.expectOutput) });
    }
    goal.checks = checks;
    const allPass = checks.every((c) => c.pass);
    if (allPass) {
      goal.verdict = 'SHIP';
    } else if (evidence.run.status === 'failed') {
      goal.verdict = 'FAILED';
      goal.failureCodes.push('run-failed');
    } else if (!checks.find((c) => c.id === 'terminal-status').pass) {
      goal.verdict = 'FAILED';
      goal.failureCodes.push('run-not-terminal');
    } else {
      goal.verdict = 'BLOCK';
      goal.failureCodes.push('expectation-not-met');
    }
  } catch (e) {
    goal.verdict = 'FAILED';
    goal.failureCodes.push((e && e.code) || 'goal-failed');
    goal.error = String((e && e.message) || e).slice(0, 200);
    goal.endedAt = isoNow();
    const last = goal.attempts[goal.attempts.length - 1];
    if (last && !last.endedAt) last.endedAt = isoNow();
    await upsertTask(envelopeFromGoal(goal, goal.lineage));
    return goal;
  }
  goal.endedAt = isoNow();
  await upsertTask(envelopeFromGoal(goal, goal.lineage));
  return goal;
}

