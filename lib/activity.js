import { projectTaskFromRun } from './task-truth.js';

const RUNNING = new Set(['running', 'queued', 'pending']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'canceled', 'blocked']);

function parseTime(value) {
  if (typeof value === 'number') return value;
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : 0;
}

function runIdsForGoal(goal) {
  return new Set((goal && Array.isArray(goal.attempts) ? goal.attempts : []).map((a) => a && a.runId).filter(Boolean));
}

export function projectActivity({ runs = [], goals = [], receipt = null, now = Date.now() } = {}) {
  const running = [];
  const needsAttention = [];
  const recent = [];
  const claimedRunIds = new Set();

  for (const goal of goals || []) {
    for (const id of runIdsForGoal(goal)) claimedRunIds.add(id);
    const verdict = String(goal && goal.verdict || '').toUpperCase();
    if (verdict === 'FAILED' || verdict === 'BLOCK') {
      needsAttention.push({
        kind: 'goal',
        taskId: goal.taskId || null,
        title: goal.objective || goal.taskId || 'Goal',
        verdict,
        reason: (goal.failureCodes && goal.failureCodes[0]) || (goal.objectiveEvaluation && goal.objectiveEvaluation.status) || 'needs-attention',
        at: goal.endedAt || goal.createdAt || goal.startedAt || null,
      });
    } else if (verdict && verdict !== 'PENDING') {
      recent.push({
        kind: 'goal',
        taskId: goal.taskId || null,
        title: goal.objective || goal.taskId || 'Goal',
        verdict,
        at: goal.endedAt || goal.createdAt || goal.startedAt || null,
      });
    }
  }

  for (const run of runs || []) {
    if (!run || !run.status) continue;
    const projected = projectTaskFromRun(run);
    if (RUNNING.has(run.status)) {
      running.push({
        kind: 'execution',
        taskId: projected ? projected.taskId : null,
        runId: run.id || null,
        title: run.user_message || run.workflow_name || 'Execution',
        workflow: run.workflow_name || null,
        status: run.status,
        startedAt: run.started_at || null,
      });
      continue;
    }
    if (TERMINAL.has(run.status) && !claimedRunIds.has(run.id)) {
      const receiptDecision = run.receipt && run.receipt.decision ? String(run.receipt.decision).toUpperCase() : null;
      const item = {
        kind: 'execution',
        taskId: projected ? projected.taskId : null,
        runId: run.id || null,
        title: run.user_message || run.workflow_name || 'Execution',
        status: run.status,
        verdict: receiptDecision,
        at: run.started_at || null,
      };
      if (run.status === 'failed' || receiptDecision === 'BLOCK' || receiptDecision === 'FAILED') needsAttention.push(item);
      else recent.push(item);
    }
  }

  if (receipt && receipt.state && receipt.state !== 'VALID') {
    const reasons = Array.isArray(receipt.reasons) && receipt.reasons.length ? receipt.reasons.map(String) : ['system verification is ' + String(receipt.state).toLowerCase()];
    needsAttention.push({
      kind: 'system-verification',
      taskId: null,
      title: 'RCOS verification',
      state: receipt.state,
      reason: reasons[0],
      reasons,
      at: null,
    });
  }

  running.sort((a, b) => parseTime(b.startedAt) - parseTime(a.startedAt));
  needsAttention.sort((a, b) => parseTime(b.at) - parseTime(a.at));
  recent.sort((a, b) => parseTime(b.at) - parseTime(a.at));

  return {
    generatedAt: new Date(now).toISOString(),
    running,
    needsAttention,
    recent: recent.slice(0, 10),
    counts: {
      running: running.length,
      needsAttention: needsAttention.length,
      recent: Math.min(recent.length, 10),
    },
  };
}
