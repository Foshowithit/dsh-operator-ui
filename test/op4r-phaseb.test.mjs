// OP-4R Phase B — bounded DSH integration for the explicitly authorized
// fresh-run path, plus the attempt-2 read-model visibility correction.
//
// Covers, with no Archon/network side effects on the real host:
//   1. wire shape      — ordinary dispatch is byte-identical to pre-OP-4R
//                        (so the prior-failed-run guard is still hit exactly
//                        as before); only the explicit freshRun option adds
//                        a standalone `--force` token.
//   2. fail-closed     — runGoal refuses a malformed freshRun BEFORE any
//                        config/registry/approval/dispatch work, with zero
//                        network calls, and the resulting verdict never
//                        suggests a retry.
//   3. menu detection  — detectPriorRunMenu distinguishes prior-run-menu /
//                        no-menu / unreadable, time-scoped by the
//                        pre-dispatch message-id snapshot; the state word in
//                        the menu is dynamic, never the literal "failed".
//   4. nextAction      — no run created because operator action is required
//                        is a distinct outcome from run discovery failed; an
//                        ordinary retry is never advertised for the menu.
//   5. envelope        — freshRun + observation survive the attempt whitelist.
//   6. discovery       — the failed historical run 7245beda (pre-existing,
//                        in preIds) is never adopted as a new run.
//   7. store correction — the GPT-ordered attempt-2 observation script is
//                        append-only, preserves verdict/failureCode/attempt
//                        identity, and is idempotent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolate the local tasks store BEFORE any goal.js call: getDshHome() reads
// process.env per call, so a tmp home keeps runGoal's fail-closed path from
// ever touching the real ~/.dsh store. No config file exists here → resolveConfig
// falls back to defaults silently (ENOENT is not an error).
const tmpA = mkdtempSync(join(tmpdir(), 'op4r-phaseb-'));
mkdirSync(join(tmpA, 'operator-ui'), { recursive: true });
process.env.DSH_HOME = tmpA;

import { composeDispatchWire, detectPriorRunMenu, nextAction, runGoal, discoverRun } from '../lib/goal.js';
import { envelopeFromGoal } from '../lib/tasks.js';

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PLAIN = 'task task-970ff68d: Process values.csv in order and report running total after each row';
const HISTORICAL_RUN = '7245beda-c754-4862-af56-ae2e72e11d15';

// ---------------------------------------------------------------- 1. wire shape

test('wire: absent freshRun the dispatch message is byte-identical; only the explicit option adds --force', () => {
  assert.equal(composeDispatchWire(PLAIN, undefined), PLAIN);
  assert.equal(composeDispatchWire(PLAIN, null), PLAIN);
  assert.equal(composeDispatchWire(PLAIN, false), PLAIN);
  const wired = composeDispatchWire(PLAIN, { authorized: true, via: 'gpt-op4r-attempt-3' });
  assert.ok(wired.startsWith('--force '), 'fresh-run wire is a standalone --force token prefix');
  assert.equal(wired.slice('--force '.length), PLAIN, 'the plain message rides unchanged after the token');
  // The token must be whitespace-delimited: Archon's parser splits on
  // whitespace, tests restArgs.includes('--force'), then re-joins the
  // remaining tokens with single spaces — which must reproduce the plain
  // message byte-identically (run.user_message and the T1 linkage leg).
  const tokens = wired.split(/\s+/);
  assert.equal(tokens[0], '--force');
  assert.equal(tokens.slice(1).join(' '), PLAIN);
});

// --------------------------------------------------------------- 2. fail-closed

test('runGoal: malformed freshRun fails closed before config/registry/approval/dispatch — zero network, never a retry', async () => {
  const calls = [];
  globalThis.fetch = async (...a) => {
    calls.push(String(a[0]));
    throw new Error('network must not be touched on the fail-closed path');
  };
  const malformed = [
    { authorized: false, via: 'gpt-op4r' }, // not explicitly authorized
    { authorized: true, via: '   ' },        // empty authorization source
    { authorized: true },                    // missing via
    'yes',                                   // not an object at all
  ];
  for (const freshRun of malformed) {
    const goal = await runGoal({ objective: 'phase-b fail-closed probe', freshRun });
    assert.equal(goal.verdict, 'FAILED', 'refusal is a FAILED verdict');
    assert.ok(goal.failureCodes.includes('fresh-run-not-authorized'), 'got: ' + JSON.stringify(goal.failureCodes));
    assert.equal(nextAction(goal).kind, 'inspect', 'fresh-run-not-authorized lands on inspect, never retry');
    assert.equal(goal.nextAction && goal.nextAction.kind, 'inspect', 'the catch stamps inspect onto the persisted envelope too');
  }
  assert.equal(calls.length, 0, 'no fetch was issued before the refusal (config/registry/dispatch untouched)');
});

test('runGoal: absent freshRun follows the ordinary path — the option never widens authority implicitly', async () => {
  // With no DSH config, resolveConfig defaults to registry.path '' → the
  // ordinary path must stop at registry-not-configured WITHOUT dispatching.
  // This proves the new option changes nothing when it is not asked for.
  const calls = [];
  globalThis.fetch = async (...a) => { calls.push(String(a[0])); throw new Error('no dispatch expected'); };
  const goal = await runGoal({ objective: 'phase-b ordinary-path probe' });
  assert.equal(goal.verdict, 'FAILED');
  assert.ok(goal.failureCodes.includes('registry-not-configured'), 'got: ' + JSON.stringify(goal.failureCodes));
  assert.equal(calls.length, 0, 'ordinary path with no freshRun issues no network before registry truth');
});

// ----------------------------------------------------------- 3. menu detection

test('detectPriorRunMenu: empty pre-dispatch snapshot refuses to claim — zero network', async () => {
  const calls = [];
  globalThis.fetch = async (...a) => { calls.push(String(a[0])); throw new Error('no'); };
  for (const preMsgIds of [new Set(), [], undefined]) {
    const obs = await detectPriorRunMenu({ conversationId: 'web-probe', preMsgIds });
    assert.equal(obs.kind, 'unreadable');
    assert.equal(obs.notProofOf, 'execution');
    assert.match(obs.reason, /snapshot|time-scoped/);
  }
  assert.equal(calls.length, 0, 'without a snapshot the detector never even reads the tail');
});

test('detectPriorRunMenu: the stale attempt-2 menu row is time-scoped out — no-menu, not a fresh hit', async () => {
  const stale = {
    id: 'm-stale-attempt2',
    role: 'assistant',
    content: 'Starting workflow: `csv-running-total-v1`\n---\nFound a prior failed run of **csv-running-total-v1** (run `' + HISTORICAL_RUN + '`).',
  };
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return jsonResponse([stale]);
  };
  const obs = await detectPriorRunMenu({ conversationId: 'web-probe', preMsgIds: new Set([stale.id]) });
  assert.equal(obs.kind, 'no-menu', 'a pre-existing row can never be read as a fresh menu');
  assert.equal(obs.freshMessages, 0);
  assert.equal(obs.notProofOf, 'execution');
  assert.ok(calls[0].includes('/api/conversations/web-probe/messages'), 'reads the conversation tail');
});

test('detectPriorRunMenu: a fresh menu with a DYNAMIC state word is prior-run-menu; user rows never match', async () => {
  const stale = { id: 'm-stale', role: 'assistant', content: 'Found a prior failed run of **w** (run `old`).' };
  const freshUser = { id: 'm-u1', role: 'user', content: 'Found a prior failed run of **w** (injected text must not match)' };
  const freshMenu = {
    id: 'm-new-menu',
    role: 'assistant',
    created_at: '2026-09-22T05:00:00.000Z',
    content: 'Starting workflow: `csv-running-total-v1`\n---\n  Found a prior stale run of **csv-running-total-v1** (run `' + HISTORICAL_RUN + '`).',
  };
  globalThis.fetch = async () => jsonResponse([stale, freshUser, freshMenu]);
  const obs = await detectPriorRunMenu({ conversationId: 'web-probe', preMsgIds: new Set([stale.id]) });
  assert.equal(obs.kind, 'prior-run-menu');
  assert.equal(obs.messageId, freshMenu.id, 'the assistant row wins, the user row is ignored');
  assert.equal(obs.createdAt, freshMenu.created_at);
  assert.match(obs.match, /^Found a prior stale run of \*\*/, 'state word is dynamic — "stale" matches, the literal "failed" is not required');
  assert.match(obs.summary, /no execution was started/);
  assert.equal(obs.notProofOf, 'execution');
  assert.equal(obs.freshMessages, 2, 'both non-pre-dispatch rows counted; only the assistant menu hit');
});

test('detectPriorRunMenu: HTTP error, non-array body, and fetch failure all read as unreadable — claim nothing', async () => {
  const pre = new Set(['pre-1']);
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  let obs = await detectPriorRunMenu({ conversationId: 'web-probe', preMsgIds: pre });
  assert.equal(obs.kind, 'unreadable');
  assert.equal(obs.reason, 'HTTP 500');

  globalThis.fetch = async () => jsonResponse({ error: 'not a list' });
  obs = await detectPriorRunMenu({ conversationId: 'web-probe', preMsgIds: pre });
  assert.equal(obs.kind, 'unreadable');
  assert.match(obs.reason, /non-array/);

  globalThis.fetch = async () => { throw new Error('socket hang up'); };
  obs = await detectPriorRunMenu({ conversationId: 'web-probe', preMsgIds: pre });
  assert.equal(obs.kind, 'unreadable');
  assert.match(obs.reason, /socket hang up/);
  assert.equal(obs.notProofOf, 'execution');
});

// --------------------------------------------------------------- 4. nextAction

test('nextAction: menu outcomes are operator-action or inspect — never an advertised retry', () => {
  // Fresh menu on this attempt → distinct failure code entirely.
  let a = nextAction({ verdict: 'FAILED', failureCodes: ['run-not-created-operator-action-required'], attempts: [] });
  assert.equal(a.kind, 'operator-action');
  assert.equal(a.label, 'Resolve the prior-run decision menu');

  // Historical attempt-2 observation carried into a later attempt whose own
  // observation is null (mergeTask: cached wins per attempt key) → still menu.
  a = nextAction({
    verdict: 'FAILED',
    failureCodes: ['run-not-found'],
    attempts: [
      { attempt: 2, observation: { kind: 'prior-run-menu' } },
      { attempt: 3, observation: null },
    ],
  });
  assert.equal(a.kind, 'operator-action');
  assert.match(a.reason, /ordinary retry returns the same menu/);

  // Tail unreadable → inspect, retry explicitly not advertised.
  a = nextAction({ verdict: 'FAILED', failureCodes: ['run-not-found'], attempts: [{ attempt: 2, observation: { kind: 'unreadable' } }] });
  assert.equal(a.kind, 'inspect');

  // Genuine discovery drift (readable tail, no menu) → ordinary retry stays.
  a = nextAction({ verdict: 'FAILED', failureCodes: ['run-not-found'], attempts: [{ attempt: 2, observation: { kind: 'no-menu' } }] });
  assert.equal(a.kind, 'retry');

  // Fresh-run refusal → fallback branch, inspect, never retry.
  a = nextAction({ verdict: 'FAILED', failureCodes: ['fresh-run-not-authorized'], attempts: [] });
  assert.equal(a.kind, 'inspect');
});

// --------------------------------------------------------------- 5. envelope

test('envelopeFromGoal: freshRun and observation travel on the attempt whitelist', () => {
  const goal = {
    taskId: 'task-970ff68d',
    objective: 'Process values.csv in order and report running total after each row',
    verdict: 'FAILED',
    failureCodes: ['run-not-found'],
    startedAt: '2026-09-22T04:02:17.000Z',
    endedAt: '2026-09-22T04:02:28.000Z',
    route: { selected: { id: 'csv-running-total', workflow: 'csv-running-total-v1', score: 1 }, considered: [], reason: 'exact capability match' },
    attempts: [
      { attempt: 1, workflow: 'csv-running-total-v1', runId: HISTORICAL_RUN, status: 'failed', failureCode: 'run-not-found', startedAt: '2026-09-21T00:00:00.000Z', endedAt: '2026-09-21T00:01:00.000Z', freshRun: null, observation: null },
      { attempt: 2, workflow: 'csv-running-total-v1', runId: null, failureCode: 'run-not-found', startedAt: '2026-09-22T04:02:17.913Z', endedAt: '2026-09-22T04:02:28.000Z', freshRun: null, observation: { kind: 'prior-run-menu', sqliteRowId: 33758, notProofOf: 'execution' } },
      { attempt: 3, workflow: 'csv-running-total-v1', runId: null, freshRun: { authorized: true, via: 'gpt-op4r-attempt-3', authorizedAt: '2026-09-22T06:00:00.000Z' }, observation: null },
    ],
  };
  const env = envelopeFromGoal(goal, null);
  assert.equal(env.status, 'closed');
  assert.equal(env.attempts.length, 3);
  assert.equal(env.attempts[0].freshRun, null, 'ordinary attempts stay null');
  assert.equal(env.attempts[1].observation.kind, 'prior-run-menu');
  assert.equal(env.attempts[1].observation.sqliteRowId, 33758);
  assert.equal(env.attempts[2].freshRun.via, 'gpt-op4r-attempt-3');
  assert.equal(env.attempts[2].runId, null, 'fresh-run provenance never fabricates a run id');
});

// ------------------------------------------------------------ 6. discovery

test('discoverRun: the pre-existing failed historical run is never adopted as a new run (10s deadline)', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return jsonResponse({ runs: [{ id: HISTORICAL_RUN, workflow_name: 'csv-running-total-v1', conversation_id: 'cadfdd377f089e980b2558f348196a29', status: 'failed' }] });
  };
  const res = await discoverRun({
    workflowName: 'csv-running-total-v1',
    preIds: new Set([HISTORICAL_RUN]), // attempt-3's pre-dispatch snapshot contains it
    conversationId: 'web-1789946601072-wa6vlx',
    association: { dbId: 'fc764d99-b8f0-d7ba-3426-df409ea63540', archonConversationId: 'web-1789946601072-wa6vlx', expectedCodebaseId: 'dc92aa5a-4a56-9d45-2a2f-a65a2a0e2053' },
    dispatchedMessage: PLAIN,
    dispatchedRunId: null,
  });
  assert.equal(res.status, 'none', 'historical run excluded by preIds → no run appeared, deadline reached with successful reads');
  assert.equal(res.adoption, null, 'no adoption of 7245beda');
  assert.deepEqual(res.candidates, []);
  assert.ok(calls.every((u) => u.includes('/api/workflows/runs')), 'list reads only — detail of the historical run never fetched');
});

// ------------------------------------------------------- 7. store correction

test('attempt-2 visibility correction: append-only on a stripped copy, verdict/identity preserved, idempotent', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const script = join(here, 'fixtures', 'op4r-attempt2-observation-20260922.mjs');
  assert.ok(existsSync(script), 'correction script exists at ' + script);

  // Section 4 (host-specific test data): the fixture IS the store. A declared
  // FAILED historical envelope (verdict FAILED, run-not-found, attempt-2
  // dispatch receipt, no observation yet) written into a throwaway $DSH_HOME —
  // no read of this Mac's live ~/.dsh store and no dependency on operator's
  // deployment. The assertions below declare exactly this fixture.
  const tmpB = mkdtempSync(join(tmpdir(), 'op4r-corr-'));
  mkdirSync(join(tmpB, 'operator-ui'), { recursive: true });
  const storeCopy = join(tmpB, 'operator-ui', 'tasks.json');
  const realTask = {
    taskId: 'task-970ff68d',
    tasksVersion: 2,
    kind: 'goal',
    objective: 'Process values.csv in order and report running total after each row',
    status: 'closed',
    verdict: 'FAILED',
    failureCodes: ['run-not-found'],
    nextAction: { kind: 'retry', label: 'Retry (same task)' },
    attempts: [
      { attempt: 1, workflow: 'csv-running-total-v1', runId: '7245beda-0000-4000-8000-000000000000', status: 'failed', startedAt: '2026-09-21T00:30:53.000Z', endedAt: '2026-09-21T00:31:40.000Z' },
      { attempt: 2, workflow: 'csv-running-total-v1', runId: null, status: 'refused', failureCode: 'run-not-found', dispatch: { accepted: true, at: '2026-09-21T00:30:50.780Z' } },
    ],
  };
  const doc = { tasksVersion: 2, tasks: [realTask] };
  writeFileSync(storeCopy, JSON.stringify(doc, null, 2) + '\n', 'utf8');

  const attempt1Before = JSON.stringify(realTask.attempts[0]);
  const dispatchBefore = JSON.stringify(realTask.attempts[1].dispatch);
  const failureCodesBefore = JSON.stringify(realTask.failureCodes);

  const env = { ...process.env, DSH_HOME: tmpB };
  const run1 = execFileSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.match(run1, /attempt2\.observation appended \(kind=prior-run-menu, sqliteRowId=33758\)/);
  assert.match(run1, /verdict preserved: FAILED \/ run-not-found/);

  const after = JSON.parse(readFileSync(storeCopy, 'utf8'));
  const t = (after.tasks || []).find((x) => x.taskId === 'task-970ff68d');
  assert.equal(t.verdict, 'FAILED', 'verdict untouched');
  assert.equal(JSON.stringify(t.failureCodes), failureCodesBefore, 'failureCodes untouched — historical record stays run-not-found');
  assert.equal(t.attempts.length, 2, 'no attempt invented');
  assert.equal(JSON.stringify(t.attempts[0]), attempt1Before, 'attempt-1 (historical 7245beda provenance) byte-identical');
  assert.equal(t.attempts[1].attempt, 2, 'attempt-2 identity preserved');
  assert.equal(t.attempts[1].runId, null, 'still no run — the correction never fabricates execution');
  assert.equal(JSON.stringify(t.attempts[1].dispatch), dispatchBefore, 'attempt-2 dispatch receipt untouched');
  assert.equal(t.attempts[1].observation.kind, 'prior-run-menu');
  assert.equal(t.attempts[1].observation.sqliteRowId, 33758);
  assert.equal(t.attempts[1].observation.notProofOf, 'execution');
  assert.equal(t.nextAction.kind, 'operator-action', 'read model stops advertising an ordinary retry');
  assert.ok(existsSync(storeCopy + '.bak-op4r-observation-20260922'), 'pre-write backup created');

  const bytes1 = readFileSync(storeCopy);
  const run2 = execFileSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.match(run2, /already recorded/);
  assert.ok(readFileSync(storeCopy).equals(bytes1), 'second run performs no write');
});
