import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDispatchRunObserver, readDispatchBinding } from '../lib/dispatch-status.js';
import { createAdapterTools } from '../lib/rcos-archon-adapter.js';

const dispatch = 'sd-20261003T103718Z-589bb3';
const run = '5600cb15bbcbbd9d94697e7760874ac7';
const internal = '11111111111141118111111111111111';
const caller = 'session-general-123';
const seat = 'ad34b519-9c58-4023-a6cc-45a4db5fecb3';
const binding = {
  dispatch_id: dispatch, caller_session_id: caller, seat_session_id: seat,
  run_id: run, archon_conversation_id: internal, workflow_name: 'rcos-ir-invoice-test',
  child_nodes: [{ id: 'run-approved-workflow', workflow: 'chow-build-standard' }],
};
const exec = (name, args) => ({ name, arguments: args, agent: { session: { id: seat } } });
const result = (operation, data) => ({ isError: false, value: { ok: true, operation, exit_code: 0, detail: 'fixture', data_json: JSON.stringify(data) } });
const audit = (patch = {}) => ({
  run_id: dispatch, caller_session_id: caller, caller_preset: 'general-idea',
  seat: 'workflow-manager', seat_session_id: seat, stage: 'complete',
  receipt_accepted: true, authority_basis: 'no-parent-root',
  archon: { run_id: run }, archon_binding: binding, ...patch,
});
const newSeat = (parent = caller) => ({ agent: { session: { id: 'new-wm-seat', header: {
  origin: 'subagent', delegationDepth: 1, agentPreset: 'workflow-manager', parentSession: parent,
} } } });

test('dispatch captures canonical compile/run identities and ignores prose, failed results, and other seats', () => {
  const observer = createDispatchRunObserver({ dispatchId: dispatch, callerSessionId: caller, seatSessionId: seat });
  const ir = { nodes: [{ id: 'run-approved-workflow', execution_class: 'workflow', ref: { workflow: 'chow-build-standard' } }] };
  observer.observe(exec('rcos_compile_ir', { name: 'invoice-test', ir_json: JSON.stringify(ir) }), result('rcos_compile_ir', { workflow_name: 'rcos-ir-invoice-test' }));
  const launch = exec('archon_workflow_run', { workflow_name: 'rcos-ir-invoice-test' });
  const accepted = result('archon_workflow_run', { run_id: run, conversation_id: internal, workflow_name: 'rcos-ir-invoice-test' });
  observer.observe(launch, { isError: false, content: [{ type: 'text', text: accepted.value.data_json }] });
  observer.observe(launch, { ...accepted, isError: true });
  observer.observe({ ...launch, agent: { session: { id: 'other-seat' } } }, accepted);
  observer.observe(launch, result('archon_workflow_run', { run_id: run, conversation_id: internal, workflow_name: 'uncompiled-workflow' }));
  assert.equal(observer.get(run), undefined);
  observer.observe(launch, accepted);
  assert.deepEqual(observer.get(run), binding);
  accepted.value.data_json = '{}';
  assert.deepEqual(observer.get(run), binding, 'audit identity must survive result mutation');
});

test('fresh WM checks the existing run after restart using only its originating chat audit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dispatch-status-'));
  try {
    await writeFile(join(dir, 'seat-dispatch.jsonl'), JSON.stringify(audit()) + '\n');
    const calls = [];
    const tools = createAdapterTools({ sshTarget: 'chow@example', workflowAllowlist: ['chow-build-standard'], auditDir: dir,
      callRemote: async (operation, payload) => {
        calls.push({ operation, payload });
        return { ok: true, exit_code: 0, data: { run_id: run, status: 'completed', effective_decision: 'ship' } };
      },
    });
    const followup = tools.find(tool => tool.name === 'archon_dispatch_status');
    assert.ok(followup, 'a fresh seat needs a dispatch-bound read operation');
    const value = await followup.execute({ dispatch_id: dispatch, run_id: 'model-invented', conversation_id: 'other' }, newSeat());
    assert.equal(value.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].operation, 'archon_run_status');
    assert.equal(calls[0].payload.run_id, run);
    assert.equal(calls[0].payload.conversation_id, seat);
    assert.equal(calls[0].payload.archon_conversation_id, internal);
    assert.equal(calls[0].payload.workflow_name, 'rcos-ir-invoice-test');
    assert.deepEqual(calls[0].payload.child_nodes, [{ id: 'run-approved-workflow', workflow: 'chow-build-standard' }]);
    assert.deepEqual(calls[0].payload.workflow_allowlist, ['chow-build-standard', 'rcos-ir-invoice-test']);
    await assert.rejects(followup.execute({ dispatch_id: dispatch }, newSeat('unrelated-chat')), /originating chat/);
    await assert.rejects(followup.execute({ dispatch_id: dispatch }, { agent: { session: { id: caller } } }), /dispatched Workflow Manager/);
    assert.equal(calls.length, 1, 'refused identities must not reach SSH or launch anything');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('follow-up refuses ambiguous, missing, mismatched, and no-longer-approved run bindings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dispatch-refusals-'));
  try {
    const cases = [
      [[], /not found/],
      [[audit(), audit()], /ambiguous/],
      [[audit({ archon_binding: undefined })], /binding.*not recorded/],
      [[audit({ archon: { run_id: '22222222222242228222222222222222' } })], /does not match/],
      [[audit({ archon_binding: { ...binding, seat_session_id: 'other-seat' } })], /does not match/],
      [[audit({ archon_binding: { ...binding, child_nodes: [] } })], /child workflow/],
      [[audit({ seat_session_id: undefined, archon_binding: { ...binding, seat_session_id: undefined } })], /binding.*invalid/],
      [[audit({ archon_binding: { ...binding, child_nodes: [{ workflow: 'chow-build-standard' }] } })], /child workflow/],
      [[audit({ archon_binding: { ...binding, child_nodes: [{ id: 'run-approved-workflow', workflow: 'unreviewed' }] } })], /approved/],
    ];
    for (const [records, error] of cases) {
      await writeFile(join(dir, 'seat-dispatch.jsonl'), records.map(row => JSON.stringify(row)).join('\n') + '\n');
      await assert.rejects(readDispatchBinding({ auditDir: dir, dispatchId: dispatch, exec: newSeat(), workflowAllowlist: ['chow-build-standard'] }), error);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('repeated follow-up preserves the original binding across another closed seat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-dispatch-chain-'));
  const followupDispatch = 'sd-20261003T104420Z-8a61c9';
  const followupSeat = 'new-wm-seat';
  try {
    await writeFile(join(dir, 'seat-dispatch.jsonl'), JSON.stringify(audit()) + '\n');
    const tools = createAdapterTools({ sshTarget: 'chow@example', workflowAllowlist: ['chow-build-standard'], auditDir: dir,
      callRemote: async () => ({ ok: true, exit_code: 0, data: { run_id: run, status: 'running', effective_decision: 'pending' } }),
    });
    const tool = tools.find(tool => tool.name === 'archon_dispatch_status');
    const value = await tool.execute({ dispatch_id: dispatch }, newSeat());
    const observer = createDispatchRunObserver({ dispatchId: followupDispatch, callerSessionId: caller, seatSessionId: followupSeat });
    observer.observe({ ...newSeat(), name: tool.name, arguments: { dispatch_id: dispatch } }, { isError: false, value });
    assert.deepEqual(observer.get(run), binding);
    const followupAudit = audit({ run_id: followupDispatch, seat_session_id: followupSeat, archon_binding: observer.get(run) });
    await writeFile(join(dir, 'seat-dispatch.jsonl'), [audit(), followupAudit].map(row => JSON.stringify(row)).join('\n') + '\n');
    assert.deepEqual(await readDispatchBinding({ auditDir: dir, dispatchId: followupDispatch, exec: newSeat(), workflowAllowlist: ['chow-build-standard'] }), binding);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a blocked follow-up cannot discard or replace the run identity it successfully read', () => {
  const observer = createDispatchRunObserver({ dispatchId: dispatch, callerSessionId: caller, seatSessionId: seat });
  assert.deepEqual(observer.receiptRunViolations('none'), [], 'a refusal before any run exists can still report none');
  observer.observe(exec('archon_dispatch_status', { dispatch_id: dispatch }), result('archon_run_status', {
    run_id: run, requested_dispatch_id: dispatch, dispatch_binding: binding,
    status: 'completed', effective_decision: 'blocked',
  }));
  assert.match(observer.receiptRunViolations('none').join(' '), /must preserve.*5600cb15/);
  assert.match(observer.receiptRunViolations('22222222222242228222222222222222').join(' '), /must preserve/);
  assert.deepEqual(observer.receiptRunViolations(run), [], 'the corrected receipt remains admissible');
  assert.deepEqual(observer.get(run), binding, 'receipt refusals must not consume the captured authority');
});

const runReceipt = (verdict, archonStatus = verdict, runId = run) => ({
  verdict, archon_status: archonStatus, archon_run_id: runId,
});
function observeFollowup(observer, status, decision) {
  observer.observe(exec('archon_dispatch_status', { dispatch_id: dispatch }), result('archon_run_status', {
    run_id: run, requested_dispatch_id: dispatch, dispatch_binding: binding,
    status, effective_decision: decision,
  }));
}
const newObserver = () => createDispatchRunObserver({ dispatchId: dispatch, callerSessionId: caller, seatSessionId: seat });

test('a canonical BLOCKED result refuses a forged SHIP receipt and remains correctable', () => {
  const observer = newObserver();
  observeFollowup(observer, 'completed', 'blocked');
  assert.match(observer.receiptViolations(runReceipt('ship')).join(' '), /canonical.*blocked/i);
  assert.match(observer.receiptViolations(runReceipt('fix', 'blocked')).join(' '), /verdict.*blocked/i);
  assert.deepEqual(observer.receiptViolations(runReceipt('blocked')), []);
  assert.deepEqual(observer.get(run), binding);
});

test('a canonical FIX cannot be upgraded to SHIP; conservative seat failures remain admissible', () => {
  const observer = newObserver();
  observeFollowup(observer, 'completed', 'FIX');
  assert.match(observer.receiptViolations(runReceipt('ship')).join(' '), /canonical.*fix/i);
  assert.deepEqual(observer.receiptViolations(runReceipt('fix')), []);
  assert.deepEqual(observer.receiptViolations(runReceipt('blocked', 'fix')), []);
  observeFollowup(observer, 'completed', 'ship');
  assert.deepEqual(observer.receiptViolations(runReceipt('ship')), []);
  assert.deepEqual(observer.receiptViolations(runReceipt('blocked', 'ship')), []);
});

test('active run status requires PENDING and the exact observed active status', () => {
  const observer = newObserver();
  for (const status of ['running', 'queued', 'pending']) {
    observeFollowup(observer, status, 'pending');
    assert.match(observer.receiptViolations(runReceipt('ship')).join(' '), /canonical|pending/i);
    assert.match(observer.receiptViolations(runReceipt('blocked', status)).join(' '), /verdict.*pending/i);
    assert.deepEqual(observer.receiptViolations(runReceipt('pending', status)), []);
  }
});

test('a launched run needs a verified terminal status; ordinary polling supersedes previous proof', () => {
  const observer = newObserver();
  const ir = { nodes: [{ id: 'run-approved-workflow', execution_class: 'workflow', ref: { workflow: 'chow-build-standard' } }] };
  observer.observe(exec('rcos_compile_ir', { name: 'invoice-test', ir_json: JSON.stringify(ir) }), result('rcos_compile_ir', { workflow_name: binding.workflow_name }));
  observer.observe(exec('archon_workflow_run', { workflow_name: binding.workflow_name }), result('archon_workflow_run', {
    run_id: run, conversation_id: internal, workflow_name: binding.workflow_name, status: 'completed',
  }));
  assert.match(observer.receiptViolations(runReceipt('ship')).join(' '), /read.*status/i);
  const poll = exec('archon_run_status', { run_id: run });
  observer.observe(poll, result('archon_run_status', { run_id: run, status: 'completed', effective_decision: 'ship' }));
  assert.deepEqual(observer.receiptViolations(runReceipt('ship')), []);
  observer.observe(poll, result('archon_run_status', { run_id: run, status: 'completed', effective_decision: 'fix' }));
  assert.match(observer.receiptViolations(runReceipt('ship')).join(' '), /canonical.*fix/i);
  observer.observe(poll, result('archon_run_status', { run_id: run, status: 'completed', effective_decision: 'unknown' }));
  assert.match(observer.receiptViolations(runReceipt('ship')).join(' '), /canonical.*blocked/i);
  assert.deepEqual(observer.receiptViolations(runReceipt('blocked')), [], 'unverified terminal acceptance must be reportable as blocked');
});

test('launch proof can report an active run without pretending completion was verified', () => {
  const observer = newObserver();
  const ir = { nodes: [{ id: 'run-approved-workflow', execution_class: 'workflow', ref: { workflow: 'chow-build-standard' } }] };
  observer.observe(exec('rcos_compile_ir', { name: 'invoice-test', ir_json: JSON.stringify(ir) }), result('rcos_compile_ir', { workflow_name: binding.workflow_name }));
  observer.observe(exec('archon_workflow_run', { workflow_name: binding.workflow_name }), result('archon_workflow_run', {
    run_id: run, conversation_id: internal, workflow_name: binding.workflow_name, status: 'running',
  }));
  assert.deepEqual(observer.receiptViolations(runReceipt('pending', 'running')), []);
  assert.match(observer.receiptViolations(runReceipt('ship')).join(' '), /canonical|pending/i);
});

test('unobserved, unrelated, failed or wrong-seat results cannot authorize success', () => {
  const observer = newObserver();
  assert.deepEqual(observer.receiptViolations(runReceipt('blocked', 'none', 'none')), []);
  assert.match(observer.receiptViolations(runReceipt('ship')).join(' '), /observed|captured/i);
  const poll = exec('archon_run_status', { run_id: run });
  const good = result('archon_run_status', { run_id: run, status: 'completed', effective_decision: 'ship' });
  observer.observe(poll, good);
  assert.match(observer.receiptViolations(runReceipt('ship')).join(' '), /observed|captured/i);
  observeFollowup(observer, 'completed', 'blocked');
  observer.observe(poll, { ...good, isError: true });
  observer.observe(poll, { ...good, value: { ...good.value, ok: false } });
  observer.observe({ ...poll, agent: { session: { id: 'other-seat' } } }, good);
  observer.observe(exec('archon_run_status', { run_id: internal }), good);
  observer.observe(poll, result('archon_workflow_run', { run_id: run, status: 'completed', effective_decision: 'ship' }));
  assert.match(observer.receiptViolations(runReceipt('ship')).join(' '), /canonical.*blocked/i);
  assert.deepEqual(observer.receiptViolations(runReceipt('blocked')), []);
});

test('receipt identity cannot be discarded after canonical outcome was observed', () => {
  const observer = newObserver();
  observeFollowup(observer, 'completed', 'ship');
  assert.match(observer.receiptViolations(runReceipt('blocked', 'none', 'none')).join(' '), /must preserve/i);
  assert.match(observer.receiptViolations(runReceipt('ship', 'ship', internal)).join(' '), /must preserve/i);
  assert.match(observer.receiptViolations(runReceipt('pending', 'running')).join(' '), /canonical.*ship/i);
});
