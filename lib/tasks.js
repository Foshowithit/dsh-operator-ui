// dsh-operator-ui — durable task authority (M1 foundation).
//
// The task envelope is the RCOS-level record born ABOVE DSH/Archon:
//   task_id → objective → route decision(s) → attempts (executions) →
//   evidence → checks → verdict(s) → lineage.
//
// Storage: ONE append-safe JSON file at $DSH_HOME/operator-ui/tasks.json,
// written atomically (tmp + rename) after every state change. It is the
// second — and only other — file this plugin ever writes, beside the sealed
// receipt. Session memory is a cache of it; restarts lose nothing.
//
// Envelope rules (M0 adjudication, M1 scope upgrade):
// - Retry = SAME task_id, NEW attempt (never a new task).
// - Fork  = NEW task_id with lineage {parentTaskId, forkedFromAttempt},
//   inheriting objective/context — never rewinding workspace state.
// - Verdict scope is explicit: 'objective-evaluation' when the objective-
//   satisfaction check passed, 'capability-validation' otherwise (refusals and
//   unexecuted goals evaluate nothing). Never silently upgraded.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { resolveConfig, getDshHome } from './config.js';

export const TASKS_VERSION = 1;
const MAX_TASKS = 200;

const tasksFile = () => join(getDshHome(), 'operator-ui', 'tasks.json');

const emptyStore = () => ({ tasksVersion: TASKS_VERSION, tasks: [] });

let cache = null;        // parsed store (null = not loaded)
let loadedFrom = null;   // path it was loaded from

async function load() {
  const path = tasksFile();
  if (cache !== null && loadedFrom === path) return cache;
  let store = emptyStore();
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.tasks)) {
      store = { tasksVersion: parsed.tasksVersion || 1, tasks: parsed.tasks };
    }
  } catch { /* absent or unreadable — start empty (first-run is a valid state) */ }
  cache = store;
  loadedFrom = path;
  return store;
}

// Atomic write: tmp file + rename, so a crash never truncates task history.
async function persist(store) {
  const path = tasksFile();
  const tmp = path + '.tmp';
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
  cache = store;
}

function sortTasks(tasks) {
  tasks.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export async function upsertTask(task) {
  const store = await load();
  const i = store.tasks.findIndex((t) => t.taskId === task.taskId);
  if (i >= 0) store.tasks[i] = task;
  else store.tasks.unshift(task);
  sortTasks(store.tasks);
  while (store.tasks.length > MAX_TASKS) store.tasks.pop();
  await persist(store);
  return task;
}

export async function getTask(taskId) {
  const store = await load();
  return store.tasks.find((t) => t.taskId === taskId) || null;
}

export async function listTasks() {
  const store = await load();
  const tasks = store.tasks.slice();
  sortTasks(tasks);
  return tasks;
}

export async function taskCount() {
  return (await load()).tasks.length;
}

// --------------------------------------------------------- task operations

export function forkTaskId(parentTaskId) {
  // A fork is a NEW task lineage derived from an existing task: fresh id,
  // recorded parent — never a rename, never a workspace rewind.
  return 'task-' + Math.random().toString(36).slice(2, 10) + '-from-' + String(parentTaskId || '').replace(/[^a-z0-9]/gi, '').slice(-6);
}

// --------------------------------------------------- goal envelope mapping

// A GoalRunner run maps onto the durable envelope: the goal IS the task;
// the Archon execution IS attempt 1 (or N on retry).
export function envelopeFromGoal(goal, lineage) {
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
    objectiveEvaluation: goal.objectiveEvaluation || null,
    trust: goal.trust || null,           // derived ladder: Observed → … → Objective satisfied (+ truth named per rung)
    nextAction: goal.nextAction || null, // first-class suggested operator action (suggests; never auto-executes)
    verdict: {
      decision: goal.verdict,
      // M1: the gate now evaluates OBJECTIVE SATISFACTION (3rd check), so a
      // SHIP vouches at objective scope. A goal that never executed keeps the
      // capability-validation scope — a refusal evaluates nothing.
      scope: goal.objectiveEvaluation && goal.objectiveEvaluation.pass ? 'objective-evaluation' : 'capability-validation',
      failureCodes: goal.failureCodes || [],
      error: goal.error || null,
    },
    evidence: goal.evidence || null,
    lineage: lineage || null, // {parentTaskId, forkedFromTaskId} when forked
    sealedBy: 'goal-runner-m1',
  };
}

