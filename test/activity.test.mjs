import test from 'node:test';
import assert from 'node:assert/strict';
import { projectActivity } from '../lib/activity.js';

test('projects running Archon work without inventing a second task authority', () => {
  const out = projectActivity({
    runs: [
      { id: 'run-1', conversation_id: 'rcos-task-deadbeef', workflow_name: 'wf', user_message: 'Analyze README', status: 'running', started_at: 100 },
      { id: 'run-2', conversation_id: 'other', workflow_name: 'wf2', status: 'completed', started_at: 90 },
    ],
    goals: [],
    now: 1000,
  });
  assert.equal(out.counts.running, 1);
  assert.equal(out.running[0].taskId, 'task-deadbeef');
  assert.equal(out.running[0].runId, 'run-1');
});

test('BLOCK and FAILED goals become needs-attention with explicit reason', () => {
  const out = projectActivity({
    goals: [
      { taskId: 'task-12345678', objective: 'Make quote', verdict: 'BLOCK', failureCodes: ['objective-not-satisfied'], endedAt: '2026-09-16T01:00:00.000Z' },
      { taskId: 'task-87654321', objective: 'Bad route', verdict: 'FAILED', failureCodes: ['no-route'], endedAt: '2026-09-16T01:01:00.000Z' },
    ],
    now: Date.parse('2026-09-16T01:02:00.000Z'),
  });
  assert.equal(out.counts.needsAttention, 2);
  assert.deepEqual(new Set(out.needsAttention.map((x) => x.reason)), new Set(['objective-not-satisfied', 'no-route']));
});

test('goal-owned execution is correlated and not duplicated in recent', () => {
  const out = projectActivity({
    runs: [{ id: 'run-ship', conversation_id: 'rcos-task-aaaaaaaa', workflow_name: 'wf', user_message: 'Count words', status: 'completed', started_at: 100, receipt: { decision: 'ship' } }],
    goals: [{ taskId: 'task-aaaaaaaa', objective: 'Count words', verdict: 'SHIP', attempts: [{ runId: 'run-ship' }], endedAt: '2026-09-16T01:00:00.000Z' }],
    now: Date.parse('2026-09-16T01:01:00.000Z'),
  });
  assert.equal(out.recent.length, 1);
  assert.equal(out.recent[0].kind, 'goal');
  assert.equal(out.recent[0].verdict, 'SHIP');
});

test('failed orphan execution and invalid verification both require attention', () => {
  const out = projectActivity({
    runs: [{ id: 'run-fail', conversation_id: 'other', workflow_name: 'wf', status: 'failed', started_at: 100 }],
    goals: [],
    receipt: { state: 'TAMPERED', reasons: ['seal mismatch'] },
    now: 1000,
  });
  assert.equal(out.counts.needsAttention, 2);
  assert.equal(out.needsAttention.some((x) => x.kind === 'execution'), true);
  assert.equal(out.needsAttention.some((x) => x.kind === 'system-verification' && x.reason === 'seal mismatch'), true);
});
