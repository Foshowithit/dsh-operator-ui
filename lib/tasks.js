// dsh-operator-ui — RCOS task projection/cache.
//
// IMPORTANT: this module is NOT a durable authority and writes nothing.
// Executed task identity is reconstructed from authoritative Archon runs via
// deterministic `rcos-task-<id>` conversation ids. A tiny process-local cache
// keeps richer goal/refusal data while the plugin process is alive; losing that
// cache on restart is acceptable because the plugin's iron rule is no new
// persistence. Durable execution truth remains Archon and verification truth
// remains the sealed receipt machinery.

import { randomUUID } from 'node:crypto';
import { resolveConfig } from './config.js';
import { projectTaskFromRun } from './task-truth.js';

export const TASKS_VERSION = 2;
const MAX_TASKS = 200;
const volatileTasks = new Map();

function archonHeaders() {
  const { config } = resolveConfig();
  const headers = {};
  const tokenVar = config.archon.tokenVar;
  if (typeof tokenVar === 'string' && process.env[tokenVar]) headers.authorization = 'Bearer ' + process.env[tokenVar];
  return headers;
}

async function readArchonRuns(limit = 100) {
  const { config } = resolveConfig();
  try {
    const res = await fetch(config.archon.baseUrl + '/api/workflows/runs?limit=' + Math.min(MAX_TASKS, Math.max(1, limit)), {
      headers: archonHeaders(),
      signal: AbortSignal.timeout(config.archon.timeoutMs),
    });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body && body.runs) ? body.runs : [];
  } catch {
    return [];
  }
}

function objectiveFromRun(run, taskId) {
  const msg = String(run && run.user_message || '');
  const escaped = String(taskId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = msg.match(new RegExp('^(?:task|goal)\\s+' + escaped + ':\\s*(.*)$', 'i'));
  return m ? m[1] : msg;
}

export function envelopeFromRun(run) {
  const p = projectTaskFromRun(run);
  if (!p) return null;
  const receiptDecision = run && run.receipt && run.receipt.decision ? String(run.receipt.decision).toUpperCase() : null;
  const verdict = receiptDecision || (p.execution.failed ? 'FAILED' : p.execution.completed ? 'COMPLETED' : 'PENDING');
  return {
    taskId: p.taskId,
    tasksVersion: TASKS_VERSION,
    kind: 'goal',
    objective: objectiveFromRun(run, p.taskId),
    status: ['running', 'queued', 'pending'].includes(p.execution.status) ? 'running' : 'closed',
    createdAt: run.started_at || null,
    endedAt: null,
    route: { selected: { workflow: p.workflow }, considered: [], reason: 'reconstructed from authoritative Archon run' },
    attempts: [{ attempt: 1, workflow: p.workflow, runId: p.runId, status: p.execution.status, outputs: [], startedAt: run.started_at || null, endedAt: null }],
    checks: [],
    execution: { completed: p.execution.completed, status: p.execution.status, runId: p.runId },
    capabilityValidation: receiptDecision ? { pass: receiptDecision === 'SHIP', decision: receiptDecision } : null,
    objectiveEvaluation: null,
    verdict,
    verdictDetail: {
      decision: verdict,
      scope: receiptDecision ? 'capability-validation' : 'execution',
      failureCodes: [],
      error: null,
    },
    failureCodes: [],
    error: null,
    evidence: null,
    lineage: null,
    reconstructedFrom: 'archon',
  };
}

function mergeTask(projected, cached) {
  if (!projected) return cached;
  if (!cached) return projected;
  const attempts = new Map();
  for (const a of projected.attempts || []) if (a && a.runId) attempts.set(a.runId, a);
  for (const a of cached.attempts || []) attempts.set(a && a.runId ? a.runId : 'attempt:' + String(a && a.attempt), a);
  return { ...projected, ...cached, attempts: [...attempts.values()] };
}

export async function upsertTask(task) {
  if (!task || !task.taskId) throw new Error('taskId required');
  volatileTasks.set(task.taskId, task);
  while (volatileTasks.size > MAX_TASKS) volatileTasks.delete(volatileTasks.keys().next().value);
  return task;
}

// Synchronous cache read for host routes that already expect a plain object.
// `listTasks()` hydrates this cache from Archon after restart; GoalRunner uses
// `getTask()` when it needs an authoritative async reconstruction.
export function peekTask(taskId) {
  return volatileTasks.get(taskId) || null;
}

export async function getTask(taskId) {
  const cached = volatileTasks.get(taskId) || null;
  const runs = await readArchonRuns();
  const projected = runs.map(envelopeFromRun).filter(Boolean).find((t) => t.taskId === taskId) || null;
  const merged = mergeTask(projected, cached);
  if (merged) volatileTasks.set(taskId, merged);
  return merged;
}

export async function listTasks() {
  const runs = await readArchonRuns();
  const byId = new Map();
  for (const run of runs) {
    const projected = envelopeFromRun(run);
    if (!projected) continue;
    const prior = byId.get(projected.taskId);
    if (!prior) byId.set(projected.taskId, projected);
    else prior.attempts.push(...projected.attempts);
  }
  for (const [taskId, cached] of volatileTasks) byId.set(taskId, mergeTask(byId.get(taskId) || null, cached));
  const tasks = [...byId.values()]
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, MAX_TASKS);
  for (const task of tasks) volatileTasks.set(task.taskId, task);
  return tasks;
}

export async function taskCount() { return (await listTasks()).length; }

export function forkTaskId() {
  return 'task-' + randomUUID().replace(/-/g, '').slice(0, 8);
}

export function envelopeFromGoal(goal, lineage) {
  const objectiveSatisfied = goal.objectiveEvaluation && goal.objectiveEvaluation.status === 'SATISFIED';
  const scope = objectiveSatisfied ? 'objective-evaluation' : goal.capabilityValidation ? 'capability-validation' : 'execution';
  const failureCodes = goal.failureCodes || [];
  return {
    taskId: goal.taskId,
    tasksVersion: TASKS_VERSION,
    kind: 'goal',
    objective: goal.objective,
    status: goal.verdict === 'PENDING' ? 'running' : 'closed',
    createdAt: goal.startedAt,
    endedAt: goal.endedAt || null,
    route: goal.route ? {
      selected: goal.route.selected,
      considered: (goal.route.considered || []).map((c) => ({ id: c.id, score: c.score, reasons: c.reasons })),
      reason: goal.route.reason || null,
    } : null,
    attempts: (goal.attempts || []).map((a) => ({
      attempt: a.attempt,
      workflow: a.workflow,
      runId: a.runId || null,
      status: a.status || null,
      outputs: a.outputs || [],
      startedAt: a.startedAt || null,
      endedAt: a.endedAt || null,
    })),
    checks: goal.checks || [],
    execution: goal.execution || null,
    capabilityValidation: goal.capabilityValidation || null,
    objectiveEvaluation: goal.objectiveEvaluation || null,
    claim: goal.claim || null,
    verdict: goal.verdict,
    verdictDetail: {
      decision: goal.verdict,
      scope,
      failureCodes,
      error: goal.error || null,
    },
    failureCodes,
    error: goal.error || null,
    evidence: goal.evidence || null,
    lineage: lineage || null,
    cachedBy: 'goal-runner',
  };
}
