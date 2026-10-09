import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Config, apply, buildRoutingDecision } from '../lib/index.js';

const activeSession = {
  id: 'session-general-123',
  snapshotEvents: () => [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'assistant/message', seq: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, data: { turn: 1 } },
    { type: 'turn/start', seq: 3, data: { turn: 2 } },
    { type: 'assistant/tool_use', seq: 4, data: { turn: 2 } },
  ],
};

test('routing decisions represent all four model-interpreted intent classes', () => {
  const agent = { session: activeSession };
  const cases = [
    ['conversational', 'brainstorm without a task handoff'],
    ['read_only_inquiry', 'answer from research and read tools'],
    ['clarification', 'ask one question before choosing an outcome'],
    ['procedural_handoff', 'perform the requested bounded work'],
  ];
  for (const [intent, reason] of cases) {
    const decision = buildRoutingDecision(agent, intent, '  ' + reason + '  ', 'rd-fixed-' + intent);
    assert.equal(decision.intent, intent);
    assert.equal(decision.reason, reason);
    assert.equal(decision.caller_session_id, activeSession.id);
    assert.equal(decision.caller_turn_index, 2);
    assert.equal(decision.caller_turn_start_event_index, 3);
    assert.equal(decision.dispatch_run_id, 'none');
  }
});

test('General can persist nonprocedural intent decisions without creating a seat', async () => {
  const auditDir = await mkdtemp(join(tmpdir(), 'dsh-routing-decision-'));
  try {
    const registered = new Map();
    apply({ tools: { register: (tool) => registered.set(tool.name, tool) } }, new Config({
      auditDir,
      seats: ['workflow-manager'],
      callerPreset: 'general-idea',
    }));

    const routeTool = registered.get('record_routing_decision');
    assert.ok(routeTool, 'General must expose a dedicated routing-record tool');
    const result = await routeTool.execute({
      intent: 'read_only_inquiry',
      reason: 'The answer needs only the available research tools.',
    }, { agent: { session: activeSession } });

    assert.equal(result.accepted, true);
    assert.equal(result.decision.intent, 'read_only_inquiry');
    assert.equal(result.decision.caller_session_id, activeSession.id);
    assert.equal(result.decision.caller_turn_index, 2);
    assert.equal(result.decision.dispatch_run_id, 'none');
    assert.equal(registered.has('dispatch_seat'), true);

    const lines = (await readFile(join(auditDir, 'routing-decisions.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.record_type, 'routing-decision');
    assert.equal(record.decision_id, result.decision.decision_id);
    assert.equal(record.intent, 'read_only_inquiry');
    assert.equal(record.caller_session_id, activeSession.id);
    assert.equal(record.caller_turn_index, 2);
  } finally {
    await rm(auditDir, { recursive: true, force: true });
  }
});

test('a persisted nonprocedural decision cannot authorize Workflow Manager creation', async () => {
  const auditDir = await mkdtemp(join(tmpdir(), 'dsh-routing-gate-'));
  try {
    const registered = new Map();
    const ctx = { tools: { register: (tool) => registered.set(tool.name, tool) } };
    apply(ctx, new Config({
      auditDir,
      seats: ['workflow-manager'],
      callerPreset: 'general-idea',
    }));
    const exec = { agent: { session: activeSession } };
    const route = await registered.get('record_routing_decision').execute({
      intent: 'read_only_inquiry',
      reason: 'The answer needs only the available research tools.',
    }, exec);
    const value = await registered.get('dispatch_seat').execute({
      routing_decision_id: route.decision.decision_id,
      seat: 'workflow-manager',
      objective: 'Do a governed mutation.',
      done_when: 'The requested change is verified.',
    }, exec);

    assert.equal(value.stage, 'authority-route');
    assert.equal(value.routing.intent, 'read_only_inquiry');
    assert.equal(value.routing.recorded, true);
    assert.equal(value.dispatch.seat_session_id, 'none');
    assert.equal(value.dispatch.turn_started, false);
    assert.match(value.detail, /requires a procedural_handoff/);
  } finally {
    await rm(auditDir, { recursive: true, force: true });
  }
});
