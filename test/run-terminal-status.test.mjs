#!/usr/bin/env node
// #67 — ONE terminal-status rule for the family.
//
// THE DEFECT CLASS, ONE QUESTION OVER
// Every read site in this codebase is built on "a record we cannot classify is
// not a run we know finished". That sentence is true for a FALSY status and was
// false for an UNRECOGNISED one. `lib/goal.js` and `lib/verify.js` classified by
// a DENY-list — `st && st !== 'running' && st !== 'queued' && st !== 'pending'`
// — so a MISSING status kept polling (fail-safe) while any truthy status the
// reader did not recognise was read as FINISHED (fail-open). 'in_progress',
// 'Running', 'succeeded': all terminal to that test. The run's partial evidence
// was then validated and a verdict sealed on a run that might still be live.
//
// THE ASYMMETRY THAT DECIDES IT
// A new IN-FLIGHT status mis-read as terminal is SILENT: we evaluate partial
// evidence, seal FAILED/BLOCK, and nothing in the output says we guessed. A new
// TERMINAL status mis-read as in-flight is LOUD: the poll reaches its named
// window and refuses with "evidence insufficient, level not claimed". A loud
// non-claim beats a silent false verdict, so the rule is an ALLOW-LIST.
//
// WHAT THIS FILE PINS
//   * the predicate itself, in both directions (recognised / unrecognised),
//     including case-normalisation, which is where the five readers disagreed
//     most concretely ('RUNNING' was terminal in two of them);
//   * the MEMBERSHIP as a table, so adding or removing a status is a deliberate
//     two-line edit rather than a silent behaviour change;
//   * that `pollRun` CLASSIFIES THROUGH the shared predicate rather than
//     re-implementing a comparison — a predicate unit test alone would stay
//     green while the poll kept its own inline literal;
//   * REVERT-FALSIFICATION: the old deny-list is expressed literally and
//     asserted to DISAGREE on the unrecognised case and to AGREE on every status
//     Archon emits today. The second half is the empty flip set stated as an
//     assertion — the reason this landing moves no existing row.
//
// ADOPTION STATUS — 3 readers adopted, 6 still raw, and the raw list is what was
// READ, not a proof of completeness (see the census table in lib/run-status.js).
// Corrected four times: twice when a reader landed after this prose was written
// (lib/verify.js, then lib/acquire.js — this file had claimed acquire.js was
// still raw, citing a line that had moved), once when an entire file was found
// never to have been opened (lib/flowrouter.js, whose 4-member allow-list is a
// copy of acquire.js's old one), and once when another agent's reading turned up
// a ninth file (lib/client.js). The rule has ONE home (`lib/run-status.js`).
// Adopted: `lib/goal.js` (pollRun), `lib/verify.js` (the evidence poll),
// `lib/acquire.js` (the run-list poll). Still raw: `lib/teach.js`
// (`['completed','failed'].includes(run.status)` — the INVERSE direction: a
// terminal status it does not list is polled to the window and then sealed as a
// candidate failure), `lib/activity.js` (its own TERMINAL set, where an
// unrecognised status is dropped from the feed entirely), `lib/goal.js`'s
// `trustLadder` (a SECOND definition inside an already-adopted file),
// `lib/flowrouter.js`'s run-list poll, `lib/tasks.js`'s `envelopeFromRun` (an
// in-flight list deciding 'running' vs 'closed', so an unrecognised status reads
// as CLOSED), and `lib/client.js`'s `deriveLadder` — which CANNOT adopt this
// module at all, because it is served as a DSH ModuleLoader bundle with no ESM
// imports; see the note in lib/run-status.js for its disposition. The count is
// per DEFINITION, not per file: goal.js carries two, so a file-keyed count would
// report goal.js as done while one of its two readers still asks the old
// question. The structural test below is TABLE-DRIVEN over the adopted readers,
// so the next half is one row here rather than a new test — and a reader that
// re-implements a comparison cannot hide behind a green predicate test. The
// per-site goal-level case (a goal row serving an unrecognised status, which
// must end in run-timeout rather than a verdict) belongs in the run-admission
// harness, alongside `goal-poll-run-not-terminal`.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// `lib/run-status.js` imports nothing, so no config resolution happens here —
// but the tmpdir keeps this file in the same shape as the other goal.js-tier
// tests, so adding a reader import later cannot silently read the operator's
// own home.
const HOME = await mkdtemp(join(tmpdir(), 'opui-run-status-'));
process.env.DSH_HOME = HOME;
after(async () => { await rm(HOME, { recursive: true, force: true }); });

// Imported from the ONE home, not from a reader: a second definition is the
// defect, so the test must not reach for one.
const { isTerminalRunStatus, normaliseRunStatus, TERMINAL_RUN_STATUSES, IN_FLIGHT_RUN_STATUSES } = await import('../lib/run-status.js');

// The membership, as a table. Mirrors the OUTCOME_UNKNOWN_CODES guard: the
// runtime set and the intended set must agree, so a status cannot be added or
// dropped without editing this list — which is the point of writing it down.
const INTENDED_TERMINAL = ['blocked', 'canceled', 'cancelled', 'completed', 'error', 'failed'];

// The three in-flight states the old deny-list named, plus the statuses Archon
// emits today. Both groups must classify IDENTICALLY before and after, or this
// change moved a fixture row.
const IN_FLIGHT = ['running', 'queued', 'pending'];
const EMITTED_TODAY = ['completed', 'failed'];

test('the terminal set is exactly the intended membership', () => {
  assert.deepEqual([...TERMINAL_RUN_STATUSES].sort(), INTENDED_TERMINAL,
    'a terminal status was added or removed — that is a deliberate behaviour change and must be made here too');
  // Non-vacuity: the set must not be empty or universal, or the predicate below
  // proves nothing.
  assert.ok(TERMINAL_RUN_STATUSES.size > 0 && TERMINAL_RUN_STATUSES.size < 12,
    'the terminal set must be a considered list, not everything or nothing');
});

test('an UNRECOGNISED status is not terminal — the run keeps polling', () => {
  const unrecognised = ['in_progress', 'started', 'retrying', 'succeeded', 'done', 'timed_out', 'paused', 'cancel_requested', '', null, undefined];
  for (const s of unrecognised) {
    assert.equal(isTerminalRunStatus(s), false,
      JSON.stringify(s) + ' is not a status we can classify, so it is not a run we know finished');
  }
  // The sharpest one: a plausible IN-FLIGHT status. Under the old deny-list this
  // was terminal, so a live run was validated as if it had finished.
  assert.equal(isTerminalRunStatus('in_progress'), false);
});

test('the three in-flight states are not terminal — and are named separately', () => {
  for (const s of IN_FLIGHT) {
    assert.equal(IN_FLIGHT_RUN_STATUSES.has(s), true, s + ' is an in-flight state');
    assert.equal(isTerminalRunStatus(s), false, s + ' means the run is still going');
  }
  // The two sets are NOT complements, and that is the point: an unrecognised
  // status is in neither, so a reader that asks "is it finished" gets false and
  // a reader that asks "is it going" also gets false — neither is a claim.
  for (const s of IN_FLIGHT) assert.equal(TERMINAL_RUN_STATUSES.has(s), false);
  assert.equal(TERMINAL_RUN_STATUSES.has('in_progress'), false);
  assert.equal(IN_FLIGHT_RUN_STATUSES.has('in_progress'), false);
});

test('statuses Archon emits today are terminal, case-insensitively', () => {
  for (const s of EMITTED_TODAY) {
    assert.equal(isTerminalRunStatus(s), true, s + ' is a finished run');
    assert.equal(isTerminalRunStatus(s.toUpperCase()), true,
      'a status is an identifier, not prose — ' + s.toUpperCase() + ' is the same status');
    assert.equal(isTerminalRunStatus(s[0].toUpperCase() + s.slice(1)), true);
  }
  // The other direction of the same rule: case-folding must not make an
  // in-flight status terminal.
  for (const s of IN_FLIGHT) {
    assert.equal(isTerminalRunStatus(s.toUpperCase()), false,
      s.toUpperCase() + ' is still in flight — normalisation is not a promotion');
  }
});

test('REVERT-FALSIFICATION: the old deny-list disagrees on the unrecognised case and agrees everywhere that exists', () => {
  // The predicate as it was in pollRun (goal.js) and in the evidence poll
  // (verify.js) before this change. Deliberately NOT pinned to line numbers:
  // they moved the moment this landed, which is how the stale claim that
  // prompted this correction got written in the first place.
  const oldPredicate = (st) => !!(st && st !== 'running' && st !== 'queued' && st !== 'pending');

  // It DID read an unrecognised status as finished. This is the defect; if the
  // old formula is ever restored, this row is what goes red.
  assert.equal(oldPredicate('in_progress'), true,
    'the deny-list read an unrecognised IN-FLIGHT status as terminal — this is the defect');
  assert.equal(isTerminalRunStatus('in_progress'), false, 'and the allow-list does not');
  assert.equal(oldPredicate('Running'), true);
  assert.equal(isTerminalRunStatus('Running'), false, 'case-normalisation is part of the same fix');

  // THE EMPTY FLIP SET, asserted rather than asserted-in-prose: on every status
  // any fixture actually drives, the two rules agree — so this change cannot
  // move an existing row.
  for (const s of [...EMITTED_TODAY, ...IN_FLIGHT]) {
    assert.equal(oldPredicate(s), isTerminalRunStatus(s),
      s + ' must classify the same before and after, or a fixture row just moved');
  }
});

test('the normalisation is exported, so a reader judging a status against an expectation does not invent its own', () => {
  // The rule has two halves. A reader that normalises the LOOKUP and then
  // compares RAW still gives two answers for one record: `'COMPLETED'` stops the
  // poll correctly (this rule) and is then judged a MISMATCH against a declared
  // `'completed'` (a raw comparison), and the receipt reads "got COMPLETED".
  assert.equal(normaliseRunStatus('COMPLETED'), 'completed');
  assert.equal(normaliseRunStatus('Completed'), 'completed');
  assert.equal(normaliseRunStatus('completed'), 'completed');
  assert.equal(normaliseRunStatus(' Running '), ' running ',
    'the rule lowercases; it does not trim — an untrimmed status stays unrecognised, which is the fail-safe direction');
  assert.equal(normaliseRunStatus(null), '');
  assert.equal(normaliseRunStatus(undefined), '');
  assert.equal(normaliseRunStatus(0), '0', 'a non-string is stringified, never thrown on');

  // The helper and the predicate must agree by construction, or a consumer using
  // one and a reader using the other can disagree about the same record.
  for (const s of [...EMITTED_TODAY, ...IN_FLIGHT, 'in_progress', 'COMPLETED', 'RUNNING']) {
    assert.equal(isTerminalRunStatus(s), TERMINAL_RUN_STATUSES.has(normaliseRunStatus(s)),
      s + ': the predicate must be exactly the set test on the normalised value');
  }
});

// Every reader that has adopted the rule, with a `marker` that must be present
// so a renamed or deleted call site cannot make the negative assertions below
// pass vacuously. Adding the next half is one row here.
const ADOPTED_READERS = [
  { file: 'goal.js', marker: 'async function pollRun(runId, transport) {' },
  { file: 'verify.js', marker: 'if (isTerminalRunStatus(st)) break;' },
  { file: 'acquire.js', marker: 'if (entry && isTerminalRunStatus(entry.status)) break;' },
];

for (const { file, marker } of ADOPTED_READERS) {
  test(file + ': classifies through the shared predicate, not a re-implemented comparison', async () => {
    const src = await readFile(join(HERE, '..', 'lib', file), 'utf8');
    assert.ok(src.length > 0 && src.includes(marker),
      file + ': the call site must be found — otherwise this scan is vacuous');

    // It must get the predicate from the ONE home. A local re-definition would
    // satisfy every other assertion here while restoring the second definition
    // this change exists to remove. (A missing or broken import cannot hide
    // either: ESM resolves named imports at link time, so scripts/check.js's
    // module-graph leg fails to LOAD the module — this assertion names the cause.)
    assert.match(src, /^import \{ isTerminalRunStatus \} from '\.\/run-status\.js';$/m,
      file + ' must import the terminal-status rule from lib/run-status.js');
    assert.match(src, /isTerminalRunStatus\(/,
      file + ' must decide through the shared predicate');

    // The deny-list, verbatim. Asserting the FULL conjunction rather than a
    // single literal is deliberate: a bare `st !== 'running'` appears in both
    // files' comments describing the old rule, so it would be a false positive,
    // while the whole three-literal test only reappears if the comparison
    // itself is restored (or quoted in full, which is worth tripping over).
    assert.doesNotMatch(src, /st !== 'running' && st !== 'queued' && st !== 'pending'/,
      file + ' must not re-implement the deny-list comparison — an unrecognised status is not terminal');
  });
}
