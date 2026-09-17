import test from 'node:test';
import assert from 'node:assert/strict';
import { admitTask, taskConversationId, projectTaskFromRun, evaluateObjective, buildClaim } from '../lib/task-truth.js';
import { deriveGoalVerdict } from '../lib/goal.js';

test('task identity survives through Archon conversation_id', () => {
  const task = admitTask('count the words in README.txt', '00000000-0000-4000-8000-000000000123');
  assert.equal(task.taskId, 'task-00000000');
  assert.equal(task.conversationId, 'rcos-task-00000000');
  assert.equal(taskConversationId(task.taskId), task.conversationId);
});

test('only RCOS task conversation ids become task projections', () => {
  assert.equal(projectTaskFromRun({ id: 'run-1', conversation_id: 'other', status: 'completed' }), null);
  const projected = projectTaskFromRun({ id: 'run-2', conversation_id: 'rcos-task-deadbeef', status: 'completed', workflow_name: 'wf' });
  assert.equal(projected.taskId, 'task-deadbeef');
  assert.equal(projected.runId, 'run-2');
});

test('execution plus capability validation cannot imply objective satisfaction', () => {
  const result = evaluateObjective({ executionCompleted: true, capabilityValidation: { pass: true }, evaluator: null, evidenceText: 'done' });
  assert.equal(result.status, 'NOT_EVALUATED');
  assert.equal(result.pass, false);
  assert.deepEqual(deriveGoalVerdict({ execution: { completed: true, status: 'completed' }, capabilityValidation: { pass: true }, objectiveEvaluation: result }), { verdict: 'BLOCK', failureCode: 'objective-not-evaluated' });
});

test('output-lines evaluator earns SATISFIED only with every declared token', () => {
  const evaluator = { kind: 'output-lines', required: ['Path:', 'Lines:', 'Words:', 'Bytes:'] };
  const good = evaluateObjective({ executionCompleted: true, capabilityValidation: { pass: true }, evaluator, evidenceText: 'Path: /tmp/README.txt\nLines: 3\nWords: 7\nBytes: 42' });
  assert.equal(good.status, 'SATISFIED');
  assert.deepEqual(deriveGoalVerdict({ execution: { completed: true, status: 'completed' }, capabilityValidation: { pass: true }, objectiveEvaluation: good }), { verdict: 'SHIP', failureCode: null });
  const bad = evaluateObjective({ executionCompleted: true, capabilityValidation: { pass: true }, evaluator, evidenceText: 'Words: 7' });
  assert.equal(bad.status, 'NOT_SATISFIED');
});

test('claim support order is objective then capability then execution', () => {
  const claim = buildClaim({ kind: 'goal-satisfied', label: 'Goal satisfied', objectiveEvaluation: { status: 'SATISFIED', pass: true }, capabilityValidation: { pass: true }, execution: { completed: true, runId: 'run-1' } });
  assert.deepEqual(claim.supportedBy.map((x) => x.kind), ['objective-evaluation', 'capability-validation', 'execution']);
});
