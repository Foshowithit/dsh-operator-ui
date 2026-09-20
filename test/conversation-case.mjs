#!/usr/bin/env node
// Single-case child runner for the S2-R conversation-lifecycle tests.
// test/conversation.test.mjs spawns one process PER CASE with its own
// DSH_HOME: the lib caches task envelopes in module state, so restart and
// idempotence semantics only mean anything across real process boundaries.
//
// Usage: node test/conversation-case.mjs <case> <dshHome> [jsonArg]
//
// Protocol: the result is ONE JSON line on stdout, and it is the LAST line
// the process ever writes — the parent JSON.parses that line. All
// diagnostics go to stderr. Expected-catch cases exit 0 with
// { ok: true, error: { code } }; an unexpected throw exits 1.

const caseName = process.argv[2];
const dshHome = process.argv[3];
const arg = process.argv[4] ? JSON.parse(process.argv[4]) : {};
process.env.DSH_HOME = dshHome;

const { upsertTask, getTask } = await import('../lib/tasks.js');
const { provisionConversation, associatedConversationId } = await import('../lib/conversation.js');
const { runGoal } = await import('../lib/goal.js');

const OBJECTIVE = 'verify echo running total seed values';
const PROJECT = 'p1x-csv-fixture';
const P1_ID = 'dc92aa5a4a569d452a2fa65a2a0e2053';

// Cases whose coded throw IS the expected result (the child reports the
// code and exits 0; any other case throwing exits 1).
const EXPECTED_CATCH = new Set(['intent-orphan']);

async function seedEnvelope(taskId, conversation) {
  await upsertTask({
    taskId,
    tasksVersion: 2,
    kind: 'goal',
    objective: OBJECTIVE,
    createdAt: new Date().toISOString(),
    attempts: [],
    checks: [],
    failureCodes: [],
    verdict: 'PENDING',
    status: 'running',
    ...(conversation ? { conversation } : {}),
  });
}

// Provision against the configured Archon (DSH_OPERATOR_UI_ARCHON env).
async function provision(taskId) {
  return provisionConversation({ taskId, projectName: PROJECT, expectedCodebaseId: P1_ID });
}

function goalReport(goal) {
  const last = goal.attempts && goal.attempts.length ? goal.attempts[goal.attempts.length - 1] : null;
  return {
    verdict: goal.verdict || null,
    failureCodes: goal.failureCodes || [],
    error: goal.error || null,
    runId: (last && last.runId) || null,
    conversationId: goal.conversationId || null,
    workflow: (goal.route && goal.route.selected && goal.route.selected.workflow) || null,
    attempts: goal.attempts ? goal.attempts.length : 0,
  };
}

const cases = {
  // Parent-side envelope seeding (e.g. pre-seeding a dangling association).
  'seed-custom': async () => {
    await seedEnvelope(arg.taskId, arg.conversation);
    return { ok: true, taskId: arg.taskId };
  },

  // Case 1: brand-new objective → provision through the supported API.
  'provision-new': async () => {
    const taskId = 'task-aaaaaaaa';
    await seedEnvelope(taskId);
    const r = await provision(taskId);
    return { ok: true, reused: r.reused, conversationId: r.conversationId, codebaseId: r.codebaseId };
  },

  // Case 2: existing valid association → reuse, no second creation.
  'provision-reuse': async () => {
    const taskId = 'task-bbbbbbbb';
    await seedEnvelope(taskId);
    const first = await provision(taskId);
    const second = await provision(taskId);
    const persisted = await getTask(taskId);
    return {
      ok: true,
      reused: second.reused,
      firstId: first.conversationId,
      conversationId: second.conversationId,
      persistedId: persisted && persisted.conversation ? persisted.conversation.archonConversationId : null,
      codebaseId: second.codebaseId,
    };
  },

  // Provision half of the two-child T1 flows (parent needs the conversation
  // id BEFORE arming decoys/strays against it).
  'provision-only': async () => {
    const taskId = arg.taskId;
    await seedEnvelope(taskId);
    const r = await provision(taskId);
    return { ok: true, conversationId: r.conversationId, codebaseId: r.codebaseId };
  },

  // Dispatch half of the two-child T1 flows: envelope + association already
  // persisted by the provision child; no seed, no provision here.
  'dispatch-only': async () => {
    const taskId = arg.taskId;
    const goal = await runGoal({ objective: OBJECTIVE, retryOf: taskId, approved: true });
    return { ok: true, ...goalReport(goal) };
  },

  // Case 3: bound + approved → dispatch exactly once, ships.
  'dispatch-happy': async () => {
    const taskId = 'task-cccccccc';
    await seedEnvelope(taskId);
    await provision(taskId);
    const goal = await runGoal({ objective: OBJECTIVE, retryOf: taskId, approved: true });
    return { ok: true, ...goalReport(goal) };
  },

  // Case 4: conversation re-bound to the wrong project → blocked pre-dispatch.
  'dispatch-wrong-project': async () => {
    const taskId = 'task-dddddddd';
    await seedEnvelope(taskId);
    await provision(taskId);
    const convId = await associatedConversationId(taskId);
    const resp = await fetch(process.env.DSH_OPERATOR_UI_ARCHON + '/api/conversations/' + convId + '/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '/setproject p2x-wrong-fixture' }),
    });
    if (!resp.ok) throw new Error('mock setproject HTTP ' + resp.status);
    const goal = await runGoal({ objective: OBJECTIVE, retryOf: taskId, approved: true });
    return { ok: true, ...goalReport(goal) };
  },

  // Case 5a: no association at all → blocked pre-dispatch.
  'dispatch-unbound-a': async () => {
    const taskId = 'task-eeeeeeee';
    await seedEnvelope(taskId);
    const goal = await runGoal({ objective: OBJECTIVE, retryOf: taskId, approved: true });
    return { ok: true, ...goalReport(goal) };
  },

  // Case 5b: association points at a conversation that no longer exists.
  // The parent pre-seeds the envelope via `seed-custom`.
  'dispatch-unbound-b': async () => {
    const goal = await runGoal({ objective: OBJECTIVE, retryOf: arg.taskId, approved: true });
    return { ok: true, ...goalReport(goal) };
  },

  // Case 6a: provision in process one.
  'restart-a': async () => {
    const taskId = 'task-ffffffff';
    await seedEnvelope(taskId);
    const r = await provision(taskId);
    return { ok: true, conversationId: r.conversationId };
  },

  // Case 6b: NEW process, same DSH_HOME — recovery must reuse the SAME
  // persisted conversation id (never mint a second one).
  'restart-b': async () => {
    const taskId = 'task-ffffffff';
    const r = await provision(taskId);
    return { ok: true, reused: r.reused, conversationId: r.conversationId };
  },

  // Case 7: creation succeeded but persistence recorded only intent —
  // re-provisioning must refuse (recoverable orphan, not a silent duplicate).
  'intent-orphan': async () => {
    const taskId = 'task-13579bd1';
    await seedEnvelope(taskId, {
      provisioningState: 'intent',
      intentAt: new Date().toISOString(),
      projectName: PROJECT,
      expectedCodebaseId: P1_ID,
    });
    await provision(taskId);
    return { ok: false, error: { code: 'no-throw' } };
  },

  // Case 8: pending objective without human approval → zero dispatches,
  // envelope parked at awaiting-approval.
  'no-approval': async () => {
    const taskId = 'task-99999999';
    await seedEnvelope(taskId);
    const goal = await runGoal({ objective: OBJECTIVE, retryOf: taskId });
    const envelope = await getTask(taskId);
    return {
      ok: true,
      verdict: goal.verdict || null,
      failureCodes: goal.failureCodes || [],
      envelopeStatus: envelope ? envelope.status : null,
      attempts: goal.attempts ? goal.attempts.length : 0,
    };
  },
};

const fn = cases[caseName];
if (!fn) {
  console.error('unknown case: ' + caseName);
  process.exit(2);
}
try {
  const result = await fn();
  console.log(JSON.stringify(result));
} catch (e) {
  if (EXPECTED_CATCH.has(caseName)) {
    console.log(JSON.stringify({ ok: true, error: { code: e.code || null, message: e.message } }));
  } else {
    console.error(e && e.stack ? e.stack : String(e));
    console.log(JSON.stringify({ ok: false, error: { code: e.code || null, message: e.message } }));
    process.exitCode = 1;
  }
}
