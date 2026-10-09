/**
 * Pre-restart proof for seat-dispatch v0.
 *
 * Three things are proven here, all of them against the REAL harness packages
 * that the plugin will load at runtime (so a passing run is evidence, not an
 * echo of my own assumptions):
 *   1. every peer the plugin imports resolves from the plugin's own directory;
 *   2. the real defineTool / value-schema DSL accepts both tool schemas, and
 *      the parameter JSON schema it derives still names exactly the receipt
 *      fields the dispatcher enforces;
 *   3. the receipt round-trips (schema -> args -> validated canonical -> JSON
 *      -> re-validated canonical) while the refusable shapes stay refused.
 *
 * It does NOT prove the live General -> dispatch_seat -> fresh-root seat path:
 * that requires the authorized restart.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { defineTool, validateArgs } from '@deepseek-ai/dsh-tools';
import * as receipt from '../lib/receipt.js';
import {
  Config,
  apply,
  DISPATCH_OUTPUT,
  RECEIPT_TOOL_OUTPUT,
  buildRoutingDecision,
  buildReceiptTool,
  buildValue,
  dispatchParameters,
  renderDispatch,
  inject,
  name,
} from '../lib/index.js';

const require = createRequire(import.meta.url);

/** The receipt a truthful seat returns for a clean, proven run. */
const CANONICAL = {
  verdict: 'ship',
  summary: 'Built seat-dispatch v0 and proved the receipt contract round-trips.',
  artifacts: ['/home/chow/.dsh/profiles/web/node_modules/dsh-seat-dispatch/lib/index.js'],
  evidence: ['node --test test/receipt-roundtrip.test.mjs -> all pass'],
  blockers: [],
  archon_run_id: '20260912-abc123',
  archon_status: 'ship',
  archon_artifact_dir: '/home/chow/.archon/workspaces/default/.archon/artifacts/runs/20260912-abc123',
  lane: 'deepseek-direct/deepseek-flash',
  next: 'none',
};

test('the seat receives its configured route while transcript lane drift stays visible', async () => {
  const auditDir = await mkdtemp(join(tmpdir(), 'dsh-seat-lane-guidance-'));
  try {
    const registered = new Map();
    const seatTools = new Map();
    const events = [];
    const caller = {
      options: { provider: 'caller-provider', model: 'caller-model', reasoningEffort: 'xhigh' },
      session: {
        id: 'session-general-lane-guidance', header: { agentPreset: 'general-idea' },
        snapshotEvents: () => [{ type: 'turn/start', seq: 0, data: { turn: 1 } }],
      },
    };
    let envelope;
    let submitted;
    const ctx = {
      tools: { register: tool => registered.set(tool.name, tool) },
      agentPresets: { mount: async () => {}, composedPreset: () => 'general-idea' },
      agents: { create: async ({ sessionId, agentOptions, setup }) => {
        assert.deepEqual(agentOptions, caller.options, 'guidance must not change route inheritance');
        const agent = {
          options: { provider: 'configured-provider', model: 'configured-model' },
          session: { id: sessionId, snapshotEvents: () => events },
          whenIdle: async () => {},
          followup: message => {
            envelope = message.content[0].text;
            events.push({ type: 'turn/start', data: { turn: 1 } });
            events.push({ type: 'assistant/message', data: { message: { source: { kind: 'model', provider: 'actual-provider', model: 'actual-model' } } } });
            submitted = seatTools.get(receipt.RECEIPT_TOOL_NAME).execute({
              ...CANONICAL, verdict: 'blocked', blockers: ['The required executable capability is unavailable.'],
              archon_run_id: 'none', archon_status: 'none', archon_artifact_dir: 'none',
              lane: 'configured-provider/configured-model',
            }, { agent });
            events.push({ type: 'turn/end', data: { turn: 1, reason: 'completed' } });
          },
        };
        await setup({ on: () => {}, tools: { register: tool => seatTools.set(tool.name, tool) } });
        return { agent, dispose: async () => {} };
      } },
    };
    apply(ctx, new Config({ auditDir, seats: ['workflow-manager'], callerPreset: 'general-idea', timeoutMs: 1000 }));
    const execution = { agent: caller };
    const route = await registered.get('record_routing_decision').execute({ intent: 'procedural_handoff', reason: 'Inspect capability eligibility.' }, execution);
    const value = await registered.get('dispatch_seat').execute({
      routing_decision_id: route.decision.decision_id, seat: 'workflow-manager',
      objective: 'Inspect capability eligibility.', done_when: 'Report the result.',
      lane_expectation: 'expected-provider/expected-model',
    }, execution);
    assert.equal((await submitted).accepted, true);
    assert.match(envelope, /seat configured lane: configured-provider\/configured-model/);
    assert.match(envelope, /exact provider and model IDs/);
    assert.match(envelope, /transcript.*authoritative/i);
    assert.doesNotMatch(envelope, /seat configured lane: expected-provider/);
    assert.equal(value.lane.declared, 'configured-provider/configured-model');
    assert.equal(value.lane.observed, 'actual-provider/actual-model');
    assert.equal(value.lane.mismatch, true, 'configured guidance cannot overwrite an observed lane change');
    assert.ok(value.warnings.some(warning => warning.includes('lane mismatch')));
  } finally { await rm(auditDir, { recursive: true, force: true }); }
});

test('native dispatcher refuses false SHIP, accepts its corrected BLOCKED receipt, and records both attempts', async () => {
  const auditDir = await mkdtemp(join(tmpdir(), 'dsh-receipt-verdict-'));
  try {
    const registered = new Map();
    const seatTools = new Map();
    const events = [];
    let observeResult;
    let correction;
    let disposed = 0;
    const runId = '5600cb15bbcbbd9d94697e7760874ac7';
    const caller = { options: { provider: 'fixture', model: 'fixture-model' }, session: {
      id: 'session-general-verdict-test', header: { agentPreset: 'general-idea' },
      snapshotEvents: () => [{ type: 'turn/start', seq: 0, data: { turn: 1 } }],
    } };
    let seatAgent;
    const ctx = {
      tools: { register: tool => registered.set(tool.name, tool) },
      agentPresets: { mount: async () => {}, composedPreset: () => 'general-idea' },
      agents: { create: async ({ sessionId, setup }) => {
        seatAgent = {
          session: { id: sessionId, snapshotEvents: () => events },
          whenIdle: async () => {},
          followup: () => {
            events.push({ type: 'turn/start', data: { turn: 1 } });
            const observe = (name, arguments_, operation, data) => observeResult(
              { name, arguments: arguments_, agent: seatAgent },
              { isError: false, value: { ok: true, operation, exit_code: 0, data_json: JSON.stringify(data) } },
            );
            observe('rcos_compile_ir', { name: 'verdict-test', ir_json: JSON.stringify({ nodes: [{ id: 'qa', execution_class: 'workflow', ref: { workflow: 'chow-qa-verify-v1' } }] }) }, 'rcos_compile_ir', { workflow_name: 'rcos-ir-verdict-test' });
            observe('archon_workflow_run', { workflow_name: 'rcos-ir-verdict-test' }, 'archon_workflow_run', { run_id: runId, conversation_id: '11111111111141118111111111111111', workflow_name: 'rcos-ir-verdict-test', status: 'running' });
            observe('archon_run_status', { run_id: runId }, 'archon_run_status', { run_id: runId, status: 'completed', effective_decision: 'blocked', eval: { decision: 'ship' } });
            correction = (async () => {
              const receiptTool = seatTools.get(receipt.RECEIPT_TOOL_NAME);
              const forged = { ...CANONICAL, archon_run_id: runId };
              const refused = await receiptTool.execute(forged, { agent: seatAgent });
              assert.equal(refused.accepted, false, 'raw wrapper SHIP cannot override canonical BLOCKED');
              assert.match(refused.violations.join(' '), /canonical.*blocked/i);
              const accepted = await receiptTool.execute({ ...forged, verdict: 'blocked', archon_status: 'blocked', blockers: ['Verified capability rejected the missing input.'] }, { agent: seatAgent });
              assert.equal(accepted.accepted, true, 'a refused receipt must leave its one-shot slot open');
              events.push({ type: 'turn/end', data: { turn: 1, reason: 'completed' } });
            })();
          },
        };
        await setup({ on: (event, handler) => { if (event === 'tools/result') observeResult = handler; }, tools: { register: tool => seatTools.set(tool.name, tool) } });
        return { agent: seatAgent, dispose: async () => { disposed += 1; } };
      } },
    };
    apply(ctx, new Config({ auditDir, seats: ['workflow-manager'], callerPreset: 'general-idea', timeoutMs: 1000 }));
    const execution = { agent: caller };
    const route = await registered.get('record_routing_decision').execute({ intent: 'procedural_handoff', reason: 'Verify the capability result.' }, execution);
    const value = await registered.get('dispatch_seat').execute({ routing_decision_id: route.decision.decision_id, seat: 'workflow-manager', objective: 'Verify the capability result.', done_when: 'The verified verdict is reported.' }, execution);
    await correction;
    assert.equal(value.verdict, 'blocked');
    assert.equal(value.stage, 'complete');
    assert.equal(value.dispatch.receipt_accepted, true);
    assert.equal(value.dispatch.receipt_attempts, 2);
    assert.equal(value.dispatch.receipt_refusals, 1);
    assert.equal(value.dispatch.receipts_seen, 1);
    assert.equal(disposed, 1);
    const saved = JSON.parse((await readFile(join(auditDir, 'seat-dispatch.jsonl'), 'utf8')).trim());
    assert.equal(saved.verdict, 'blocked');
    assert.equal(saved.receipt_refusals, 1);
    assert.equal(saved.archon_binding.run_id, runId);
  } finally { await rm(auditDir, { recursive: true, force: true }); }
});

/** One dispatch state fixture; every field buildValue reads must be present. */
function stateFixture(overrides) {
  return {
    runId: 'sd-20260912T000000Z-abcdef',
    seat: 'workflow-manager',
    stage: 'complete',
    detail: 'the seat answered with verdict "ship" on 1 turn(s).',
    warnings: [],
    routeDecision: {
      decision_id: 'route-20260929-fixed',
      intent: 'procedural_handoff',
      reason: 'the caller has no mutation tools',
      caller_session_id: 'session-2a549177',
      caller_turn_index: 2,
      caller_turn_start_event_index: 7,
      dispatch_run_id: 'sd-20260929T000000Z-abcdef',
      recorded: true,
    },
    receipt: receipt.normalizeReceipt(CANONICAL),
    receiptAccepted: true,
    attempts: 1,
    refusals: 0,
    receiptsSeen: 1,
    turns: { started: 1, ended: 1, openTurn: false, lastReason: 'completed' },
    seatSessionId: '11111111-2222-3333-4444-555555555555',
    seatLane: 'deepseek-direct/deepseek-flash',
    laneMismatch: false,
    laneObserved: 'deepseek-direct/deepseek-flash',
    callerSessionId: 'session-2a549177',
    callerPreset: 'general-idea',
    presetSource: 'scope',
    callerDepth: 0,
    callerLaneExpectation: 'none',
    auditLog: '/home/chow/.dsh/runs/seat-dispatch/seat-dispatch.jsonl',
    auditError: 'none',
    startedAt: Date.now(),
    ...overrides,
  };
}

test('every harness peer resolves from the plugin directory', () => {
  for (const peer of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/schemastery']) {
    const resolved = require.resolve(peer);
    assert.ok(resolved.includes('node_modules'), peer + ' resolved to ' + resolved);
    assert.ok(!resolved.includes('dsh-seat-dispatch/node_modules'), peer + ' resolved through a private copy instead of the shared anchor: ' + resolved);
  }
  assert.equal(name, 'seat-dispatch');
  assert.deepEqual(inject, ['agents', 'agentPresets', 'tools']);
  assert.equal(typeof Config, 'function');
});
test('the default audit follows DSH_HOME instead of writing to a fixed user profile', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-home-paths'], '0.2.0-rc.2');
  assert.equal(new Config({}).auditDir, join(resolveDshHome(), 'runs', 'seat-dispatch'));
});
test('a procedural route decision is bound to the caller session and active turn', () => {
  const events = [
    { type: 'turn/start' },
    { type: 'assistant/message' },
    { type: 'turn/end' },
    { type: 'turn/start' },
    { type: 'assistant/tool_use' },
  ];
  const decision = buildRoutingDecision({
    session: { id: 'session-general-123', snapshotEvents: () => events },
  }, 'procedural_handoff', 'needs governed mutation', 'route-20260929-fixed', 'sd-20260929T000000Z-abcdef', true);
  assert.deepEqual(decision, {
    decision_id: 'route-20260929-fixed',
    intent: 'procedural_handoff',
    reason: 'needs governed mutation',
    caller_session_id: 'session-general-123',
    caller_turn_index: 2,
    caller_turn_start_event_index: 3,
    dispatch_run_id: 'sd-20260929T000000Z-abcdef',
    recorded: true,
  });
  const closed = buildRoutingDecision({
    session: { id: 'session-general-123', snapshotEvents: () => [...events, { type: 'turn/end' }] },
  }, 'read_only_inquiry', 'read-only question', 'route-20260929-closed');
  assert.equal(closed.caller_turn_index, null);
  assert.equal(closed.caller_turn_start_event_index, null);
});
test('the composition row config is accepted by the published Config schema', () => {
  const resolved = new Config({
    seats: ['workflow-manager'],
    callerPreset: 'general-idea',
    timeoutMs: 1800000,
    startupGraceMs: 60000,
    graceMs: 15000,
    drainMs: 5000,
    auditDir: '/home/chow/.dsh/runs/seat-dispatch',
  });
  assert.deepEqual([...resolved.seats], ['workflow-manager']);
  assert.equal(resolved.callerPreset, 'general-idea');
  assert.equal(resolved.timeoutMs, 1800000);
});

test('the published parameter schema names exactly the receipt fields', () => {
  const parameters = dispatchParameters(new Config({}));
  assert.deepEqual(Object.keys(parameters).sort(), [
    'constraints', 'context', 'done_when', 'lane_expectation', 'objective', 'routing_decision_id', 'seat', 'timeout_ms',
  ]);
  assert.equal(parameters.routing_decision_id.required, true);
  assert.equal(parameters.seat.required, true);
  assert.equal(parameters.objective.required, true);
  assert.equal(parameters.timeout_ms.required, undefined);
  assert.equal(parameters.seat.enum, undefined, 'a single-seat allowlist does not advertise an enum');
  const multi = dispatchParameters(new Config({ seats: ['workflow-manager', 'other-seat'] }));
  assert.deepEqual(multi.seat.enum, ['workflow-manager', 'other-seat']);
});

test('the real defineTool accepts both tool schemas', () => {
  const receiptTool = buildReceiptTool({ submit: () => ({ accepted: false, violations: [], run_id: 'sd-x' }) });
  assert.equal(receiptTool.name, receipt.RECEIPT_TOOL_NAME);
  assert.equal(typeof receiptTool.execute, 'function');
  const dispatchTool = defineTool({
    name: 'dispatch_seat',
    description: 'compiled for schema proof only',
    parameters: dispatchParameters(new Config({})),
    output: { schema: DISPATCH_OUTPUT, render: renderDispatch },
    execute: () => Promise.resolve(buildValue(stateFixture({}))),
  });
  assert.equal(dispatchTool.name, 'dispatch_seat');
  const declared = Object.keys(dispatchTool.parameters.properties).sort();
  assert.deepEqual(declared, ['constraints', 'context', 'done_when', 'lane_expectation', 'objective', 'routing_decision_id', 'seat', 'timeout_ms']);
  assert.deepEqual([...dispatchTool.parameters.required].sort(), ['done_when', 'objective', 'routing_decision_id', 'seat']);
  assert.equal(Object.keys(receiptTool.parameters.properties).sort().join(','), [...receipt.RECEIPT_KEYS].sort().join(','));
  assert.deepEqual([...receiptTool.parameters.required].sort(), [...receipt.RECEIPT_KEYS].sort());
  assert.equal(receipt.RECEIPT_KEYS.length, 10);
  assert.deepEqual(Object.keys(RECEIPT_TOOL_OUTPUT.properties).sort(), ['accepted', 'run_id', 'violations']);
});

test('the runtime argument validator accepts a canonical receipt against the published spec', () => {
  /* validateArgs takes the same implicit parameter map the tool publishes, so
   * this is the runtime's own pre-execute check, not a paraphrase of it. */
  assert.deepEqual(validateArgs(receipt.RECEIPT_PARAMETERS, CANONICAL), []);
  const missing = validateArgs(receipt.RECEIPT_PARAMETERS, { verdict: 'ship' });
  assert.ok(missing.length > 0, 'the runtime accepted a receipt with no other fields');
  const wrongType = validateArgs(receipt.RECEIPT_PARAMETERS, { ...CANONICAL, evidence: 'because' });
  assert.ok(wrongType.length > 0, 'the runtime accepted a non-array evidence field');
  /* The parameter root is an open object by construction, so an undeclared
   * field passes the runtime validator and MUST be caught by the dispatcher:
   * this asserts the documented division of labour rather than assuming it. */
  const stray = { ...CANONICAL, stray: 1 };
  assert.deepEqual(validateArgs(receipt.RECEIPT_PARAMETERS, stray), []);
  assert.ok(receipt.validateReceipt(stray).some((violation) => violation.includes('unknown receipt field')));
});

test('a canonical receipt round-trips through validation, normalization, and JSON', () => {
  assert.deepEqual(receipt.validateReceipt(CANONICAL), []);
  const canonical = receipt.normalizeReceipt(CANONICAL);
  const wire = JSON.parse(JSON.stringify(canonical));
  assert.deepEqual(wire, CANONICAL);
  assert.deepEqual(receipt.validateReceipt(wire), []);
  const again = receipt.normalizeReceipt(wire);
  assert.deepEqual({ ...again }, { ...canonical });
  assert.ok(Object.isFrozen(canonical));
  assert.ok(Object.isFrozen(canonical.artifacts));
  assert.equal(receipt.renderReceiptText(canonical).includes('verdict ship'), true);
});

test('receipts whose support is missing stay refused', () => {
  const cases = [
    ['unknown field', { ...CANONICAL, stray: 1 }, 'unknown receipt field'],
    ['bad verdict', { ...CANONICAL, verdict: 'done' }, 'verdict:'],
    ['blocked without a blocker', { ...CANONICAL, verdict: 'blocked' }, 'blocked'],
    ['ship with a blocker', { ...CANONICAL, blockers: ['nope'] }, 'ship'],
    ['ship without evidence', { ...CANONICAL, evidence: [] }, 'evidence: verdict "ship"'],
    ['ship with blocked Archon run', { ...CANONICAL, archon_status: 'blocked' }, 'verdict "ship" contradicts Archon status "blocked"'],
    ['ship with fix Archon run', { ...CANONICAL, archon_status: 'fix' }, 'verdict "ship" contradicts Archon status "fix"'],
    ['run id with status none', { ...CANONICAL, archon_status: 'none' }, 'archon_status'],
    ['no run id with a status', { ...CANONICAL, archon_run_id: 'none' }, 'archon_status'],
    ['missing summary', (() => { const copy = { ...CANONICAL }; delete copy.summary; return copy; })(), 'summary: required'],
    ['oversize summary', { ...CANONICAL, summary: 'x'.repeat(receipt.RECEIPT_BOUNDS.summaryMax + 1) }, 'longer than'],
    ['non-array evidence', { ...CANONICAL, evidence: 'because' }, 'must be an array'],
    ['empty lane', { ...CANONICAL, lane: '   ' }, 'lane:'],
    ['not an object', null, 'must be an object'],
  ];
  for (const [label, candidate, needle] of cases) {
    const violations = receipt.validateReceipt(candidate);
    assert.ok(violations.length > 0, label + ' was accepted');
    assert.ok(violations.some((violation) => violation.includes(needle)), label + ' reported ' + JSON.stringify(violations));
  }
  assert.equal(receipt.validateReceipt({ ...CANONICAL, verdict: 'blocked', blockers: ['lane dead: no credits'], evidence: [] }).length, 0);
});

test('pending receipt preserves an active Archon run without claiming success or a blocker', () => {
  const pending = { ...CANONICAL, verdict: 'pending', archon_status: 'running', blockers: [], next: 'Poll this exact run id for a terminal EVAL.' };
  assert.deepEqual(receipt.validateReceipt(pending), []);
  const value = buildValue(stateFixture({ receipt: receipt.normalizeReceipt(pending) }));
  assert.equal(value.stage, 'complete');
  assert.equal(value.verdict, 'pending');
  assert.equal(value.ok, false);
  assert.equal(value.receipt.archon_status, 'running');
  assert.equal(value.receipt.next, pending.next);
  assert.match(renderDispatch({}, value)[0].text, /^dispatch_seat PENDING stage=complete verdict=pending/);
  for (const activeStatus of ['queued', 'pending']) {
    assert.deepEqual(receipt.validateReceipt({ ...pending, archon_status: activeStatus }), []);
    assert.ok(receipt.validateReceipt({ ...CANONICAL, archon_status: activeStatus }).some((v) => v.includes('contradicts Archon status')));
  }
  assert.ok(receipt.validateReceipt({ ...pending, archon_run_id: 'none' }).some((v) => v.includes('real Archon run id')));
  assert.ok(receipt.validateReceipt({ ...pending, blockers: ['failed gate'] }).some((v) => v.includes('cannot carry blockers')));
  assert.ok(receipt.validateReceipt({ ...pending, next: 'none' }).some((v) => v.includes('next action')));
  assert.ok(receipt.validateReceipt({ ...CANONICAL, archon_status: 'running' }).some((v) => v.includes('contradicts Archon status')));
});

test('unsupported claims and lane confounds surface as warnings', () => {
  const quiet = receipt.receiptWarnings(receipt.normalizeReceipt(CANONICAL));
  assert.deepEqual(quiet, []);
  const v4flash = receipt.receiptWarnings(receipt.normalizeReceipt({ ...CANONICAL, lane: 'command-code-2/deepseek/deepseek-v4-flash' }));
  assert.equal(v4flash.some((warning) => warning.includes('V4-Flash')), true);
  const noRun = receipt.receiptWarnings(receipt.normalizeReceipt({ ...CANONICAL, archon_run_id: 'none', archon_status: 'none', archon_artifact_dir: 'none' }));
  assert.equal(noRun.some((warning) => warning.includes('no Archon run id')), true);
  const fixWithoutBlocker = receipt.receiptWarnings(receipt.normalizeReceipt({ ...CANONICAL, verdict: 'fix', evidence: ['x'] }));
  assert.equal(fixWithoutBlocker.some((warning) => warning.includes('no blocker')), true);
});

test('declared and observed lanes are compared by model id', () => {
  assert.equal(receipt.lanesConflict('deepseek-direct/deepseek-flash', 'deepseek-flash'), false);
  assert.equal(receipt.lanesConflict('provider:DeepSeek-Direct/deepseek-flash', 'deepseek-flash'), false);
  assert.equal(receipt.lanesConflict('deepseek-direct/deepseek-flash', 'command-code-2/deepseek/deepseek-v4.1-flash'), true);
  assert.equal(receipt.lanesConflict('deepseek-flash', undefined), false);
  assert.equal(receipt.lanesConflict('none', 'deepseek-flash'), true);
});

test('caller lane expectations compare the model id without their human annotation', () => {
  const observed = 'opencode-go-responses/muse-spark-1.3-contributor';
  assert.equal(receipt.laneExpectationConflicts('opencode-go-responses / muse-spark-1.3-contributor (xhigh) — the desktop default for creative work', observed), false);
  assert.equal(receipt.laneExpectationConflicts('opencode-go-responses / other-model (xhigh) — the desktop default', observed), true);
  assert.equal(receipt.laneExpectationConflicts('opencode-go-responses/other-model', observed), true);
  assert.equal(receipt.laneExpectationConflicts('creative work on the desktop', observed), false);
  assert.equal(receipt.laneExpectationConflicts('opencode-go-responses / muse-spark-1.3-contributor (xhigh)', undefined), false);
});

test('the envelope carries the task, bindings, and direct receipt submission path', () => {
  const text = receipt.renderEnvelope({
    runId: 'sd-20260912T000000Z-abcdef',
    routeDecisionId: 'rd-20260929-fixed',
    seat: 'workflow-manager',
    callerSessionId: 'session-2a549177',
    callerPreset: 'general-idea',
    seatSessionId: '11111111-2222-3333-4444-555555555555',
    delegationDepth: 1,
    laneExpectation: 'deepseek-direct/deepseek-flash',
    objective: 'Build seat-dispatch v0.',
    doneWhen: 'The receipt round-trip test passes.',
    reason: 'The caller has no mutation tools.',
    constraints: ['Do not restart dsh-web.service.'],
    context: 'Files live under /home/chow/.dsh/plugins/.',
  });
  for (const needle of [
    'sd-20260912T000000Z-abcdef',
    'rd-20260929-fixed',
    'Build seat-dispatch v0.',
    'The receipt round-trip test passes.',
    'The caller has no mutation tools.',
    'Do not restart dsh-web.service.',
    'Files live under /home/chow/.dsh/plugins/.',
    receipt.RECEIPT_TOOL_NAME,
    'archon_run_id',
    'archon_status',
    'archon_artifact_dir',
    'lane',
    'Never invent',
  ]) {
    assert.ok(text.includes(needle), 'envelope is missing ' + JSON.stringify(needle));
  }
  assert.equal(text.includes('<run_id>'), false);
  assert.equal(text.includes('seat configured lane:'), false, 'an unavailable seat route must not be invented from the caller expectation');
});

test('the model-facing projection matches the declared output schema field for field', () => {
  const value = buildValue(stateFixture({}));
  assert.deepEqual(Object.keys(value).sort(), Object.keys(DISPATCH_OUTPUT.properties).sort());
  assert.deepEqual(Object.keys(value.routing).sort(), Object.keys(DISPATCH_OUTPUT.properties.routing.properties).sort());
  assert.deepEqual(Object.keys(value.lane).sort(), Object.keys(DISPATCH_OUTPUT.properties.lane.properties).sort());
  assert.deepEqual(Object.keys(value.dispatch).sort(), Object.keys(DISPATCH_OUTPUT.properties.dispatch.properties).sort());
  assert.deepEqual(Object.keys(value.receipt).sort(), Object.keys(DISPATCH_OUTPUT.properties.receipt.properties).sort());
  assert.equal(value.ok, true);
  assert.equal(value.stage, 'complete');
  assert.equal(value.verdict, 'ship');
  const rendered = renderDispatch({}, value);
  assert.equal(rendered[0].type, 'text');
  assert.ok(rendered[0].text.includes('dispatch_seat OK'));
  assert.ok(rendered[0].text.includes(CANONICAL.summary));
  assert.ok(rendered[0].text.includes('archon: status=ship'));

  const failed = buildValue(stateFixture({
    stage: 'timeout',
    detail: 'the seat did not submit a receipt within 1000 ms; it was cancelled.',
    receipt: undefined,
    receiptAccepted: false,
    attempts: 0,
    receiptsSeen: 0,
    turns: { started: 1, ended: 0, openTurn: true, lastReason: undefined },
    laneObserved: undefined,
    seatLane: 'unknown',
  }));
  assert.deepEqual(Object.keys(failed).sort(), Object.keys(DISPATCH_OUTPUT.properties).sort());
  assert.equal(failed.ok, false);
  assert.equal(failed.verdict, 'blocked');
  assert.deepEqual(failed.receipt, {});
  assert.equal(failed.lane.observed, 'unknown');
  const failedText = renderDispatch({}, failed)[0].text;
  assert.ok(failedText.includes('dispatch_seat NOT-OK stage=timeout'));
  assert.ok(failedText.includes('lane: declared=none observed=unknown'));
});

test('a missing receipt reports the seat turn error to the caller', () => {
  const value = buildValue(stateFixture({
    stage: 'receipt-missing',
    detail: 'the seat finished 1 turn(s) without submitting a receipt.',
    receipt: undefined,
    receiptAccepted: false,
    turns: {
      started: 1,
      ended: 1,
      openTurn: false,
      lastReason: { kind: 'error', error: { message: 'ENOSPC: no space left on device, write', code: 'UNKNOWN' } },
    },
  }));
  assert.equal(value.verdict, 'blocked');
  assert.match(renderDispatch({}, value)[0].text, /ENOSPC: no space left on device, write/);
});

test('the seat turn is delivered as a plugin-authored user message', () => {
  const message = createUserMessage({
    content: [{ type: 'text', text: 'envelope' }],
    source: { kind: 'plugin', plugin: name },
  });
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'plugin');
  assert.equal(message.source.plugin, 'seat-dispatch');
  assert.equal(message.content[0].text, 'envelope');
});

test('run ids are sortable, unique, and prefixed', () => {
  const first = receipt.mintRunId(new Date('2026-09-12T00:00:00.000Z'), 0.5);
  const second = receipt.mintRunId(new Date('2026-09-12T00:00:00.000Z'), 0.5);
  assert.equal(first, second);
  assert.equal(first.startsWith('sd-20260912T000000Z-'), true);
  assert.notEqual(receipt.mintRunId(), receipt.mintRunId());
});

/* The root-authority gate itself runs inside the tool's execute closure against
 * live agents, so it is proven end-to-end by the two audit rows in
 * /home/chow/.dsh/runs/seat-dispatch/seat-dispatch.jsonl (a root caller at
 * caller_depth 0 that shipped, and a delegated caller at caller_depth 1 that
 * was refused with seat_session_id "none"). These two tests lock the contract
 * that refusal must keep: its projection, its render, and its schema labels. */

test('a delegated caller is refused at the root gate before any seat exists', () => {
  const refusal = stateFixture({
    stage: 'authority-root',
    detail: 'dispatch_seat is callable only from the top-level "general-idea" seat; this caller is a delegated agent (parentSession session-410284da-d180-47b7-8ef9-de90143d82f3, origin subagent, delegationDepth 1). A delegated agent cannot dispatch seats.',
    receipt: undefined,
    receiptAccepted: false,
    attempts: 0,
    refusals: 0,
    receiptsSeen: 0,
    turns: { started: 0, ended: 0, openTurn: false, lastReason: undefined },
    seatSessionId: 'none',
    seatLane: 'unknown',
    laneObserved: undefined,
    laneMismatch: false,
    callerSessionId: 'b917eaea-1c7e-4442-83da-dc4f3ee51bcc',
    callerDepth: 1,
  });
  const value = buildValue(refusal);
  assert.deepEqual(Object.keys(value).sort(), Object.keys(DISPATCH_OUTPUT.properties).sort());
  assert.equal(value.ok, false);
  assert.equal(value.stage, 'authority-root');
  assert.equal(value.verdict, 'blocked');
  /* No seat was created and no turn ran: the refusal happens before create(). */
  assert.equal(value.dispatch.seat_session_id, 'none');
  assert.equal(value.dispatch.turn_started, false);
  assert.equal(value.dispatch.turns_observed, 0);
  assert.equal(value.dispatch.receipt_accepted, false);
  assert.equal(value.dispatch.receipts_seen, 0);
  assert.deepEqual(value.receipt, {});
  assert.equal(value.lane.declared, 'none');
  assert.equal(value.lane.observed, 'unknown');
  assert.equal(value.dispatch.caller_depth, 1);
  const text = renderDispatch({}, value)[0].text;
  assert.ok(text.includes('dispatch_seat NOT-OK stage=authority-root'), 'refusal render lost its stage: ' + text.slice(0, 200));
  assert.ok(text.includes('delegated'), 'refusal render does not explain why it was refused');
  assert.ok(DISPATCH_OUTPUT.properties.stage.description.includes('authority-root'));
  assert.ok(DISPATCH_OUTPUT.properties.stage.description.includes('authority-route'));
});

test('the caller lane expectation is telemetry only and never changes the verdict', () => {
  const expected = 'command-code-2/deepseek/deepseek-v4.1-flash';
  const observed = 'deepseek-direct/deepseek-flash';
  /* The warning is emitted under exactly this predicate (lanesConflict), and it
   * is pushed into warnings -- never into authority, the stage, or the verdict. */
  assert.equal(receipt.laneExpectationConflicts(expected, observed), true);
  const drifted = stateFixture({
    callerLaneExpectation: expected,
    laneObserved: observed,
    laneMismatch: false,
    warnings: ['caller lane expectation not met: the caller expected "' + expected + '" but the seat ran on "' + observed + '" (recorded telemetry, never an authority decision)'],
  });
  const value = buildValue(drifted);
  assert.equal(value.ok, true);
  assert.equal(value.verdict, 'ship', 'a lane expectation changed the verdict');
  assert.equal(value.stage, 'complete');
  assert.equal(value.lane.caller_expectation, expected);
  assert.equal(value.lane.observed, observed);
  /* The seat's own declared lane still agrees with its transcript, so the
   * expectation drift is not a mismatch. */
  assert.equal(value.lane.mismatch, false);
  const text = renderDispatch({}, value)[0].text;
  assert.ok(text.includes('caller lane expectation not met'), 'the drift warning was dropped from the render');
  assert.ok(text.includes('never an authority decision'));
  assert.ok(DISPATCH_OUTPUT.properties.lane.properties.caller_expectation.description.includes('never changes authority or the verdict'));
  /* A matching expectation is silent, by the same predicate. */
  assert.equal(receipt.laneExpectationConflicts(observed, observed), false);
});

/* ---------------------------------------------------------------------------
 * LINEAGE REPAIR (2026-09-13): fork-parentage vs real delegation.
 *
 * The defect these tests lock: the old gate read
 *     delegated = parentSession !== undefined || origin === 'subagent' || depth > 0
 * and treated parentSession as the load-bearing record. A FORKED session inherits
 * parentSession from its fork source while carrying no origin and delegationDepth
 * 0, so every forked General was permanently refused at stage 'authority-root'
 * with "A delegated agent cannot dispatch seats" -- a false positive with a
 * permanent blast radius (audit row 71 in
 * /home/chow/.dsh/runs/seat-dispatch/seat-dispatch.jsonl).
 *
 * These tests run the REAL gate expression, extracted from lib/index.js at run
 * time, so this is the shipped decision and not a paraphrase of it. If someone
 * reinstates the parentSession disjunct, these tests fail.
 * ------------------------------------------------------------------------- */

/** The three header shapes the two mechanisms actually write, read from disk. */
const FORK_HEADER = {
  label: 'forked caller (parentSession copied from the fork source)',
  header: { id: 'session-fork0001', parentSession: 'session-84ab-parent', cwd: '/home/chow' },
};
const ROOT_HEADER = {
  label: 'true top-level caller (no parentSession at all)',
  header: { id: 'session-root0001', cwd: '/home/chow' },
};
const CHILD_HEADER = {
  label: 'stamped delegated child (origin subagent, depth > 0)',
  header: { id: 'a6b1d3a4-4ee5-401b-83f8-fa15bbbe7d1b', parentSession: '1b0fce28-1e47-406f-af8c-35512e828ca7', origin: 'subagent', delegationDepth: 2 },
};

/**
 * Evaluate the gate EXACTLY as lib/index.js runs it.
 *
 * The three statements below are lifted verbatim from the plugin source, so the
 * classification under test cannot drift from the classification that ships.
 * @returns the gate's decision for one caller shape.
 */
function runRealGate({ header, subagentDepth }) {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const NONE = 'none';
  const callerHeader = header ?? {};
  const depthOf = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);
  const callerDepth = Math.max(depthOf(callerHeader.delegationDepth), depthOf(subagentDepth));
  const callerParentSession = typeof callerHeader.parentSession === 'string' && callerHeader.parentSession.length > 0 ? callerHeader.parentSession : NONE;
  const callerOrigin = typeof callerHeader.origin === 'string' && callerHeader.origin.length > 0 ? callerHeader.origin : NONE;
  /* The shipped expression, asserted to exist verbatim before it is used. */
  const expression = "const delegated = state.callerOrigin === 'subagent' || state.callerDepth > 0;";
  assert.ok(source.includes(expression), 'the shipped gate expression changed; this test no longer proves the live gate');
  assert.ok(
    !source.includes("callerParentSession !== undefined ||"),
    'the parentSession disjunct was reinstated: a forked session would be refused again',
  );
  const delegated = callerOrigin === 'subagent' || callerDepth > 0;
  const authorityBasis = delegated
    ? 'delegated-child'
    : (callerParentSession === NONE ? 'no-parent-root' : 'lineage-clean-root');
  return { delegated, authorityBasis, callerDepth, callerParentSession, callerOrigin };
}

test('the gate discriminates fork-parentage from real delegation on the real expression', () => {
  /* The false positive, now accepted and classified. */
  const fork = runRealGate({ header: FORK_HEADER.header });
  assert.equal(fork.delegated, false, 'a forked caller is still misread as delegated');
  assert.equal(fork.authorityBasis, 'lineage-clean-root');
  assert.equal(fork.callerParentSession, 'session-84ab-parent', 'the fork parent is still recorded for the audit trail');
  assert.equal(fork.callerOrigin, 'none');
  assert.equal(fork.callerDepth, 0);

  /* A genuine top-level session stays accepted, under its own distinct value. */
  const root = runRealGate({ header: ROOT_HEADER.header });
  assert.equal(root.delegated, false);
  assert.equal(root.authorityBasis, 'no-parent-root');
  assert.notEqual(root.authorityBasis, fork.authorityBasis, 'a fork and a true root must remain distinguishable in the audit');

  /* A stamped delegated child is STILL refused -- the root-only gate is intact. */
  const child = runRealGate({ header: CHILD_HEADER.header });
  assert.equal(child.delegated, true, 'a real delegated child would now be admitted: the gate was widened');
  assert.equal(child.authorityBasis, 'delegated-child');

  /* Depth alone still refuses, with no origin at all (the monotone floor of
   * @deepseek-ai/dsh-subagent delegationDepthOf() is preserved). */
  assert.equal(runRealGate({ header: { id: 'x', delegationDepth: 1 } }).delegated, true);
  assert.equal(runRealGate({ header: { id: 'x' }, subagentDepth: 3 }).delegated, true);
  /* And a forked session with NO delegation record is exactly the accepted case. */
  assert.equal(runRealGate({ header: { id: 'x', parentSession: 'p' } }).authorityBasis, 'lineage-clean-root');
});

test('the accepted-fork case reaches a non-authority stage and is auditable', () => {
  /* The full value for an admitted forked caller: it must NOT be authority-root. */
  const admitted = buildValue(stateFixture({
    stage: 'complete',
    callerDepth: 0,
    callerParentSession: 'session-84ab-parent',
    callerOrigin: 'none',
    authorityBasis: 'lineage-clean-root',
  }));
  assert.equal(admitted.stage, 'complete', 'a lineage-clean root fork did not reach complete');
  assert.notEqual(admitted.stage, 'authority-root');
  assert.equal(admitted.ok, true);
  assert.equal(admitted.dispatch.authority_basis, 'lineage-clean-root');
  assert.deepEqual(Object.keys(admitted.dispatch).sort(), Object.keys(DISPATCH_OUTPUT.properties.dispatch.properties).sort());

  /* And the refusal half of the same field, at the same stage as before. */
  const refused = buildValue(stateFixture({
    stage: 'authority-root',
    callerDepth: 2,
    callerParentSession: '1b0fce28-1e47-406f-af8c-35512e828ca7',
    callerOrigin: 'subagent',
    authorityBasis: 'delegated-child',
    receipt: undefined,
    receiptAccepted: false,
    attempts: 0,
    receiptsSeen: 0,
    turns: { started: 0, ended: 0, openTurn: false, lastReason: undefined },
    seatSessionId: 'none',
    seatLane: 'unknown',
    laneObserved: undefined,
  }));
  assert.equal(refused.stage, 'authority-root');
  assert.equal(refused.ok, false);
  assert.equal(refused.verdict, 'blocked');
  assert.equal(refused.dispatch.authority_basis, 'delegated-child');
  assert.equal(refused.dispatch.seat_session_id, 'none', 'a refused dispatch must still create no seat');
});

test('every audit row carries authority_basis and keeps every pre-existing field', () => {
  /* The audit record builder is lifted from the plugin source and evaluated, so
   * this asserts the SHIPPED record shape, not a model of it. */
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.ok(source.includes('authority_basis: state.authorityBasis'), 'the audit record lost its authority_basis field');
  assert.ok(source.includes("authority_basis: { type: 'string'"), 'the output schema does not declare authority_basis');
  assert.ok(source.includes('routing: state.routeDecision'), 'the audit record does not keep the typed procedural route decision');

  /* Additive-only: every field the pre-repair audit rows carried is still named
   * in the record builder. (The 78 existing rows in the live JSONL are the
   * baseline; this pins their field names against the rewritten builder.) */
  for (const field of [
    'ts:', 'run_id:', 'stage:', 'ok:', 'verdict:', 'seat:', 'caller_session_id:',
    'caller_preset:', 'preset_source:', 'caller_depth:', 'seat_session_id:',
    'from_index:', 'turns_observed:', 'turn_started:', 'last_turn_reason:',
    'duration_ms:', 'receipt_accepted:', 'receipt_attempts:', 'receipt_refusals:',
    'lane:', 'archon:', 'artifacts:', 'warnings:', 'detail:',
  ]) {
    assert.ok(source.includes(field), 'audit field ' + field + ' was renamed or dropped');
  }

  /* The three stable enum values are exactly the strings the contract names. */
  assert.equal(runRealGate({ header: FORK_HEADER.header }).authorityBasis, 'lineage-clean-root');
  assert.equal(runRealGate({ header: ROOT_HEADER.header }).authorityBasis, 'no-parent-root');
  assert.equal(runRealGate({ header: CHILD_HEADER.header }).authorityBasis, 'delegated-child');
});
