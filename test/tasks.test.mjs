import test from 'node:test';
import assert from 'node:assert/strict';
import { envelopeFromRun, envelopeFromGoal } from '../lib/tasks.js';

test('reconstructs task identity and objective from authoritative Archon run', () => {
  const e = envelopeFromRun({ id: 'r1', conversation_id: 'rcos-task-deadbeef', workflow_name: 'wf', user_message: 'task task-deadbeef: Count words', status: 'completed', started_at: 123 });
  assert.equal(e.taskId, 'task-deadbeef');
  assert.equal(e.objective, 'Count words');
  assert.equal(e.attempts[0].runId, 'r1');
  assert.equal(e.reconstructedFrom, 'archon');
});

test('non-RCOS run is never promoted into an RCOS task', () => {
  assert.equal(envelopeFromRun({ id: 'r2', conversation_id: 'other', status: 'completed' }), null);
});

test('goal API keeps verdict string while scoped detail upgrades only on objective satisfaction', () => {
  const base = { taskId: 'task-deadbeef', objective: 'x', verdict: 'SHIP', startedAt: 'x', attempts: [], failureCodes: [], capabilityValidation: { pass: true } };
  const capabilityOnly = envelopeFromGoal(base);
  assert.equal(capabilityOnly.verdict, 'SHIP');
  assert.equal(capabilityOnly.verdictDetail.scope, 'capability-validation');
  const objectiveSatisfied = envelopeFromGoal({ ...base, objectiveEvaluation: { status: 'SATISFIED', pass: true } });
  assert.equal(objectiveSatisfied.verdict, 'SHIP');
  assert.equal(objectiveSatisfied.verdictDetail.scope, 'objective-evaluation');
});
