#!/usr/bin/env node
// #62 — an Archon OUTAGE must not be scored as a capability failure.
//
// THE DEFECT CLASS, ONE MODULE OVER
// The goal path now seals an unreadable run as verdict UNKNOWN, never FAILED
// (lib/goal.js OUTCOME_UNKNOWN_CODES -> the single catch). But two read-models
// downstream still treated UNKNOWN as a verdict about the WORK:
//
//   * lib/history.js `outcomeOf` gates on `attempts.some(a => a.runId)`, so an
//     UNKNOWN refusal that DID adopt a run before a later read failed was counted
//     as a USE with `objectivesMissed += 1`, fed `recentMissed`, and could flip
//     `needsReevaluation` — degrading the capability's operating history AND its
//     routing confidence, on evidence that says only "we could not read the run".
//     Served by /plugins/operator-ui/rcos?op=history and rendered on the
//     Intelligence card.
//   * lib/activity.js `projectActivity` sent FAILED/BLOCK to `needsAttention` and
//     everything else non-PENDING to `recent`, so an UNKNOWN outage was filed as
//     benign history instead of an item to inspect. (Latent: no host route imports
//     it — the only importer found is test/activity.test.mjs — but the rule is the
//     same rule, so it is fixed in the same pass.)
//
// THE RULE, ONE SENTENCE
// A code meaning "we could not read / could not trust what we read" must never be
// scored as a verdict about the work. The use is still RECORDED — "we could not
// establish the outcome" is itself worth keeping — it just must not be scored.
//
// DETERMINISM
// The Archon read is pinned to an outage, so `listTasks()` serves the seeded
// envelopes from the volatile cache and no projection can add or alter a record
// behind an assertion. No port, no sibling process. Each case uses its OWN
// capability id, because `capabilityHistory()` scans every durable goal and a
// shared id would let one case's records bleed into another's counts.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = await mkdtemp(join(tmpdir(), 'opui-unknown-scoring-'));
process.env.DSH_HOME = HOME;

const { capabilityHistory, historyLines } = await import('../lib/history.js');
const { projectActivity } = await import('../lib/activity.js');
const { upsertTask } = await import('../lib/tasks.js');
const { OUTCOME_UNKNOWN_CODES } = await import('../lib/goal.js');

globalThis.fetch = async () => { throw new Error('pinned Archon outage (unknown-outage-scoring)'); };

after(async () => { await rm(HOME, { recursive: true, force: true }); });

const AT = '2026-09-25T10:00:00.000Z';

// One durable goal envelope, shaped the way the goal path writes one. The
// UNKNOWN shape is not invented here: it is what lib/goal.js produces for a run
// that was adopted and then could not be read (verdict UNKNOWN + the outage code
// + an adopted attempt.runId), and the harness row `goal-poll-run-unavailable`
// asserts exactly that shape. The first test additionally checks the code is an
// outcome-unknown code by the RUNTIME's own rule, so the fixture cannot drift
// into pinning something the product no longer produces.
const goal = ({ taskId, capId, verdict, failureCodes = [], runId, at = AT, satisfied = null }) => ({
  taskId,
  tasksVersion: 2,
  kind: 'goal',
  objective: 'count the running totals',
  status: 'closed',
  createdAt: at,
  endedAt: at,
  route: { selected: { id: capId, version: '1.0.0', workflow: 'wf-' + capId }, considered: [], reason: 'fixture' },
  attempts: [{
    attempt: 1,
    workflow: 'wf-' + capId,
    runId,
    status: verdict === 'SHIP' ? 'completed' : 'running',
    outputs: [],
    startedAt: at,
    endedAt: at,
  }],
  checks: [],
  failureCodes,
  verdict,
  execution: { completed: verdict === 'SHIP', status: verdict === 'SHIP' ? 'completed' : 'running', runId },
  capabilityValidation: satisfied === null ? null : { pass: satisfied },
  objectiveEvaluation: satisfied === null ? null : { status: satisfied ? 'SATISFIED' : 'NOT_SATISFIED', pass: satisfied },
});

const capOf = async (capId) => (await capabilityHistory()).capabilities[capId] || null;

// ------------------------------------------------- SITE 1: lib/history.js

test('history: an UNKNOWN outage that adopted a run is recorded as an observation, never as a missed objective', async () => {
  const capId = 'cap-unknown-outage';
  const code = 'archon-unavailable';
  assert.ok(OUTCOME_UNKNOWN_CODES.has(code),
    'the fixture must be an outcome-unknown code by the runtime rule, or this test pins nothing');
  await upsertTask(goal({ taskId: 'task-unknown-outage', capId, verdict: 'UNKNOWN', failureCodes: [code], runId: 'run-unknown-1' }));

  const h = await capOf(capId);
  assert.ok(h, 'the capability must appear at all — the use is recorded, not dropped');
  // RED BEFORE THE FIX: `uses` was 1 and `objectivesMissed` was 1, and there was
  // no `outcomesUnknown` at all — the outage sat in the quality column.
  assert.equal(h.uses, 1, 'we could not establish the outcome, but the capability WAS used');
  assert.equal(h.objectivesMissed, 0,
    'an outage is not a missed objective — counting it tells the operator a capability underperformed when the truth is we could not read the run');
  assert.equal(h.objectivesSatisfied, 0);
  assert.equal(h.outcomesUnknown, 1, 'the unknown outcome is recorded as its own observation');
  assert.equal(h.needsReevaluation, false, 'a single unknown observation is not decay');
  assert.equal(h.recent.length, 1, 'the observation is kept in the recent record');
  assert.equal(h.recent[0].outcomeUnknown, true, 'and it is marked as an unknown outcome there');
});

test('history control: a run that genuinely failed still counts as a missed objective', async () => {
  const capId = 'cap-real-failure';
  await upsertTask(goal({ taskId: 'task-real-failure', capId, verdict: 'FAILED', failureCodes: ['run-failed'], runId: 'run-failed-1' }));

  const h = await capOf(capId);
  assert.equal(h.uses, 1);
  assert.equal(h.objectivesMissed, 1,
    'a real failure must keep counting — excluding UNKNOWN must not stop counting FAILED');
  assert.equal(h.outcomesUnknown, 0);
});

test('history decay: an outage can neither add a miss nor help reach the window', async () => {
  const capId = 'cap-decay-window';
  // 5 recent records: 2 established misses + 3 unknown observations.
  await upsertTask(goal({ taskId: 'task-decay-miss-1', capId, verdict: 'FAILED', failureCodes: ['run-failed'], runId: 'r1', at: '2026-09-25T10:00:01.000Z' }));
  await upsertTask(goal({ taskId: 'task-decay-miss-2', capId, verdict: 'FAILED', failureCodes: ['run-failed'], runId: 'r2', at: '2026-09-25T10:00:02.000Z' }));
  for (const i of [1, 2, 3]) {
    await upsertTask(goal({ taskId: 'task-decay-unknown-' + i, capId, verdict: 'UNKNOWN', failureCodes: ['archon-unavailable'], runId: 'ru' + i, at: '2026-09-25T10:00:1' + i + '.000Z' }));
  }

  const h = await capOf(capId);
  assert.equal(h.recent.length, 5, 'all five records are kept in the recent window');
  // RED BEFORE THE FIX: the window held all 5 records, every one of them had
  // `objectiveSatisfied === false` (the 3 unknowns carry no objectiveEvaluation),
  // so `recentMissed` was 5 of 5 and `needsReevaluation` was TRUE. The three
  // outages had supplied BOTH the misses and the window size — a capability with
  // 2 real data points was reported as decaying on 5.
  assert.equal(h.recentEstablished, 2, 'only established outcomes count toward the window');
  assert.equal(h.recentMissed, 2);
  assert.equal(h.needsReevaluation, false,
    'with only 2 established outcomes the window is not met, and the unknowns must not supply the third — otherwise an Archon outage tips a capability into "needs re-evaluation"');
  assert.equal(h.decayReason, null);
});

test('historyLines: the card line names the unknown outcome instead of letting the reader infer a miss', async () => {
  const capId = 'cap-card-line';
  // No SHIP record on purpose: a SHIP sets `lastVerifiedAt` and the "last
  // verified Nm ago" suffix is wall-clock — the line under test must be
  // deterministic, and "never SHIP-verified" pins it.
  await upsertTask(goal({ taskId: 'task-card-failed', capId, verdict: 'FAILED', failureCodes: ['run-failed'], runId: 'rc1', at: '2026-09-25T11:00:01.000Z' }));
  await upsertTask(goal({ taskId: 'task-card-unknown', capId, verdict: 'UNKNOWN', failureCodes: ['archon-unavailable'], runId: 'rc2', at: '2026-09-25T11:00:02.000Z' }));

  const h = await capOf(capId);
  const line = historyLines(h);
  // RED BEFORE THE FIX: the line read "2 uses · 0 objectives satisfied · …" —
  // 2 uses against 0 satisfied reads as TWO missed objectives, when only one
  // was established as missed and the other was an outage we could not read.
  assert.equal(line, '2 uses \u00b7 0 objectives satisfied \u00b7 1 outcome unknown \u00b7 never SHIP-verified');

  // Positive control: a capability with no unknown observation keeps the exact
  // line it produced before this change (the clause is not emitted at all).
  const cleanId = 'cap-card-clean';
  await upsertTask(goal({ taskId: 'task-card-clean', capId: cleanId, verdict: 'FAILED', failureCodes: ['run-failed'], runId: 'rc3' }));
  assert.equal(historyLines(await capOf(cleanId)), '1 use \u00b7 0 objectives satisfied \u00b7 never SHIP-verified',
    'the unknown clause must not appear for a capability that has no unknown outcomes');
});

// ------------------------------------------------ SITE 2: lib/activity.js

test('activity: an UNKNOWN outage needs attention with its own reason, not a place among recent work', async () => {
  const out = projectActivity({
    goals: [
      { taskId: 'task-act-unknown', objective: 'outage goal', verdict: 'UNKNOWN', failureCodes: ['archon-unavailable'], endedAt: AT },
      { taskId: 'task-act-failed', objective: 'failed goal', verdict: 'FAILED', failureCodes: ['run-failed'], endedAt: AT },
      { taskId: 'task-act-ship', objective: 'shipped goal', verdict: 'SHIP', attempts: [{ runId: 'r-ship' }], endedAt: AT },
    ],
    now: Date.parse(AT),
  });

  // RED BEFORE THE FIX: the UNKNOWN goal landed in `recent` and needsAttention
  // held only the FAILED one.
  const unknownItem = out.needsAttention.find((x) => x.taskId === 'task-act-unknown');
  assert.ok(unknownItem, 'an outage the operator must inspect is not benign history');
  assert.equal(unknownItem.verdict, 'UNKNOWN', 'and it is not relabelled as a failure');
  assert.equal(unknownItem.reason, 'archon-unavailable',
    'its reason names the OUTAGE, never a capability failure');
  assert.equal(out.recent.some((x) => x.taskId === 'task-act-unknown'), false,
    'an unread run must not sit in the same list as completed work');
  assert.equal(out.recent.some((x) => x.taskId === 'task-act-ship'), true, 'a SHIP stays recent');
  assert.equal(out.needsAttention.some((x) => x.taskId === 'task-act-failed'), true, 'a FAILED still needs attention');
});
