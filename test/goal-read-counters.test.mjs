#!/usr/bin/env node
// #51: lib/goal.js's two successful-read counters must be gated on a PARSED
// BODY, not on "the transport answered".
//
// WHY THIS FILE EXISTS
// Both counters incremented on `res.ok` BEFORE the body was read:
//   * discoverRun's list poll  — `successfulListReads += 1; const lb = await lr.json();`
//   * pollRun's terminal poll   — `successfulReads += 1; const body = await res.json();`
// The `=== 0` guards downstream exist to say "every read failed, so this is an
// OUTAGE, not an answer". Counting a 200 before its body parses leaves those
// guards unfired when every read is a 200 we cannot read, so the deadline
// fall-through reports ABSENCE (`status: 'none'` -> the caller's `run-not-found`
// -> nextAction RETRY, which can double-run a live workflow) or a TIMEOUT
// ("the run never finished") for a run we never managed to read. Both are
// claims about a record we did not obtain.
//
// WHAT MAKES THIS EVIDENCE RATHER THAN ASSERTION
// The two fault bodies are the ones the fix must treat identically: valid JSON
// whose `runs` is absent, and a body that is not JSON at all. Against the
// pre-fix tree BOTH go red — the counter moves, so the deadline reports
// `none`/`timeout` instead of the outage. The over-correction control is the
// load-bearing half: `{"runs": []}` is an AUTHORITATIVE ABSENCE and must keep
// yielding `none` -> `run-not-found` -> RETRY. A fix that turns a parsed empty
// list into an outage has traded a false absence for a false outage.
//
// Determinism: no port is bound and no sibling process is spawned. The read
// boundary is a stub on globalThis.fetch with a closed router (an un-fixtured
// path throws rather than falling through to the network), and the fault is
// keyed on the DISPATCH POST — a structural marker, never a read count or a
// timer, so the same bytes come back on every poll. The only wall-clock cost is
// the module's own windows (discovery 10 s, terminal poll 30 s), which are not
// injectable and are therefore paid rather than faked.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = await mkdtemp(join(tmpdir(), 'opui-goal-counters-'));
process.env.DSH_HOME = HOME;

const OBJECTIVE = 'verify echo running total seed values';
const WF = 'verify-echo-v1';
const CODEBASE = 'dc92aa5a4a569d452a2fa65a2a0e2053';
const CONV = 'web-goal-counter-0001';
const DB = 'db-goal-counter-1';
const BASE = 'http://goal-counter.test';

// The product resolves both of these from config; setting them before the lib
// modules are imported is the same seam test/run-admission-goal-case.mjs uses.
process.env.DSH_OPERATOR_UI_ARCHON = BASE;
process.env.DSH_OPERATOR_UI_AUTHORITY_PRESET = 'AUTO_WITHIN_POLICY';

const REGISTRY = {
  registry_version: 'v1',
  capabilities: [{
    id: 'verify-echo',
    name: 'Verify echo',
    description: 'Deterministic seeded echo verification for running totals',
    version: '1.0.0',
    status: 'active',
    workflow: WF,
    tags: ['verify', 'echo', 'running', 'total', 'seed', 'values'],
    requires: ['shell:execute'],
    verification: { terminalStatus: 'completed', expectOutput: 'rcos-verify-seed:rcos-verify-echo-v1' },
    objectiveEvaluation: { kind: 'output-contains', value: 'rcos-verify-seed:rcos-verify-echo-v1' },
  }],
};
const registryPath = join(HOME, 'registry.json');
await writeFile(registryPath, JSON.stringify(REGISTRY, null, 2) + '\n');
process.env.DSH_OPERATOR_UI_REGISTRY = registryPath;

const HERE = dirname(fileURLToPath(import.meta.url));
const { runGoal, discoverRun, OUTCOME_UNKNOWN_CODES } = await import('../lib/goal.js');
const { upsertTask } = await import('../lib/tasks.js');

after(async () => { await rm(HOME, { recursive: true, force: true }); });

// ---------------------------------------------------------------- the boundary

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// A 200 whose body is NOT a run list: valid JSON, `runs` absent. The fix's
// `Array.isArray(lb.runs)` check is what must refuse this.
const notAListRes = () => jsonRes({ not_runs: true });

// A 200 whose body cannot be parsed at all: `lr.json()` throws. A DIFFERENT
// branch of the same rule (the try/catch, not the shape check) that must land
// on the same outcome.
const unparseableRes = () => ({
  ok: true,
  status: 200,
  json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
  text: async () => '<html>not json</html>',
});

const dispatchRes = (runId) => jsonRes({ accepted: true, status: 'started', ...(runId ? { runId } : {}) });

// The one scenario per case. `list` answers every list read; `listAfterDispatch`
// takes over once the dispatch POST has been observed, so the pre-dispatch
// snapshot and the task load stay healthy and only the discovery poll is
// faulted. `detailAfterDispatch(ordinal)` does the same for the detail read, so
// a case can serve ONE good adoption read and then fail every poll.
function goalRouter(scenario = {}) {
  let dispatched = false;
  let detailReads = 0;
  return (u) => {
    const p = u.pathname;

    // The T1 binding primitive: existence + live project binding.
    const conv = p.match(/^\/api\/conversations\/([^/]+)$/);
    if (conv) return jsonRes({ platform_conversation_id: decodeURIComponent(conv[1]), codebase_id: CODEBASE, cwd: null });

    if (p === '/api/workflows/' + WF + '/run') {
      dispatched = true;
      return dispatchRes(scenario.dispatchRunId || null);
    }

    if (p === '/api/workflows/runs') {
      if (dispatched && scenario.listAfterDispatch) return scenario.listAfterDispatch();
      if (scenario.list) return scenario.list();
      return jsonRes({ runs: scenario.runs || [] });
    }

    const run = p.match(/^\/api\/workflows\/runs\/(.+)$/);
    if (run) {
      detailReads += 1;
      if (dispatched && scenario.detailAfterDispatch) return scenario.detailAfterDispatch(detailReads);
      return jsonRes({ run: scenario.run || null, events: [] });
    }

    // Closed boundary: an un-fixtured path is a hard error, never a live read.
    throw new Error('goal-read-counters: unexpected path ' + p);
  };
}

let installed = null;
function installStub(router) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => router(new URL(String(url)), opts);
  installed = { restore: () => { globalThis.fetch = real; } };
}
function restoreStub() {
  if (installed) { installed.restore(); installed = null; }
}

const association = {
  provisioningState: 'associated',
  archonConversationId: CONV,
  dbId: DB,
  projectName: 'p1x-csv-fixture',
  expectedCodebaseId: CODEBASE,
  boundAt: '2026-09-23T11:00:00.000Z',
  verifiedAt: '2026-09-23T11:00:00.000Z',
  verifiedCodebaseId: CODEBASE,
};

let taskSeq = 0;
// Drive the REAL goal path for one frozen scenario. Each case gets its own task
// id, so the durable store and the module's task cache never carry one case's
// envelope into another's.
async function runGoalCase(scenario) {
  taskSeq += 1;
  const taskId = 'task-goal-counter-' + taskSeq;
  installStub(goalRouter(scenario));
  try {
    await upsertTask({
      taskId,
      tasksVersion: 2,
      kind: 'goal',
      objective: OBJECTIVE,
      createdAt: '2026-09-23T11:00:00.000Z',
      attempts: [],
      checks: [],
      failureCodes: [],
      verdict: 'PENDING',
      status: 'running',
      conversation: association,
    });
    return await runGoal({ objective: OBJECTIVE, retryOf: taskId, approved: true });
  } finally {
    restoreStub();
  }
}

const transport = () => ({ environmentId: 'env-goal-counter', baseUrl: BASE, timeoutMs: 1000, headers: () => ({}) });

const describe = (g) => JSON.stringify({
  verdict: g.verdict,
  failureCodes: g.failureCodes,
  nextAction: g.nextAction && g.nextAction.kind,
  error: g.error,
  discovery: g.attempts && g.attempts.length ? g.attempts[g.attempts.length - 1].discovery : null,
});

// ------------------------------------------------ Site 1: discoverRun's counter

test('discoverRun: a 200 whose body is not a run list is UNAVAILABLE, never an absence', async () => {
  installStub(goalRouter({ list: notAListRes }));
  try {
    const result = await discoverRun({
      workflowName: WF,
      preIds: new Set(),
      conversationId: CONV,
      association: null,
      dispatchedMessage: 'task probe: ' + OBJECTIVE,
      transport: transport(),
    });
    // RED BEFORE THE FIX: the counter moved on `lr.ok`, so the deadline guard
    // never fired and this returned `none` — an ABSENCE claim about a list we
    // never read, which is what prescribes the retry.
    assert.equal(result.status, 'unavailable',
      'an unreadable list body must be an OUTAGE, got status ' + result.status + ' — ' + JSON.stringify(result));
    assert.notEqual(result.status, 'none', 'a list we could not read is not an answered absence');
    assert.equal(result.adoption, null);
    assert.match(String(result.reason || ''), /never returned a successful read/);
  } finally { restoreStub(); }
});

test('discoverRun: a 200 whose body is not JSON at all is UNAVAILABLE too', async () => {
  installStub(goalRouter({ list: unparseableRes }));
  try {
    const result = await discoverRun({
      workflowName: WF,
      preIds: new Set(),
      conversationId: CONV,
      association: null,
      dispatchedMessage: 'task probe: ' + OBJECTIVE,
      transport: transport(),
    });
    // The OTHER branch of the same rule: here `lr.json()` throws, so the
    // shape check is never reached. Both must land on the outage.
    assert.equal(result.status, 'unavailable',
      'an unparseable list body must be an OUTAGE, got status ' + result.status + ' — ' + JSON.stringify(result));
    assert.equal(result.adoption, null);
  } finally { restoreStub(); }
});

// ------------------------------------------- Site 1: the caller's refusal name

test('goal: an unreadable run list refuses as archon-unavailable, and NEVER as a retryable run-not-found', async () => {
  const goal = await runGoalCase({ listAfterDispatch: notAListRes });
  const codes = goal.failureCodes || [];

  assert.ok(codes.includes('archon-unavailable'),
    'the caller must name the outage, got ' + JSON.stringify(codes) + ' — ' + describe(goal));
  assert.ok(!codes.includes('run-not-found'),
    'an unreadable list must never be reported as an absence — that is the retry that can double-run a live workflow — ' + describe(goal));
  // The verdict is derived from the refusal CODE at the single catch site: a code
  // meaning "we could not read it" seals UNKNOWN. FAILED would blame the
  // capability for our own inability to read, and this is the same code the
  // terminal-poll outage raises — one code, one verdict.
  assert.equal(goal.verdict, 'UNKNOWN',
    'a discovery outage must seal UNKNOWN, never FAILED — ' + describe(goal));
  // The whole point: absence prescribes a retry, an outage must not.
  assert.notEqual(goal.nextAction && goal.nextAction.kind, 'retry',
    'an outage must never suggest a retry — ' + describe(goal));
});

test('goal: an unparseable run list refuses as archon-unavailable too', async () => {
  const goal = await runGoalCase({ listAfterDispatch: unparseableRes });
  const codes = goal.failureCodes || [];
  assert.ok(codes.includes('archon-unavailable'),
    'the unparseable branch must reach the same refusal, got ' + JSON.stringify(codes) + ' — ' + describe(goal));
  assert.ok(!codes.includes('run-not-found'), 'never an absence — ' + describe(goal));
  assert.notEqual(goal.nextAction && goal.nextAction.kind, 'retry', 'never a retry — ' + describe(goal));
  assert.equal(goal.verdict, 'UNKNOWN',
    'the unparseable branch reaches the same outage and the same verdict — ' + describe(goal));
});

// ------------------------------------------------ the over-correction control

test('goal: a PARSED, EMPTY run list is still an authoritative absence — run-not-found, retry preserved', async () => {
  const goal = await runGoalCase({ runs: [] });
  const codes = goal.failureCodes || [];

  // This is the guard against over-correcting: `{"runs": []}` is Archon
  // ANSWERING that no run exists. If the fix turns this into `unavailable`, it
  // has traded a false absence for a false outage.
  assert.ok(codes.includes('run-not-found'),
    'an answered empty list must stay run-not-found, got ' + JSON.stringify(codes) + ' — ' + describe(goal));
  assert.ok(!codes.includes('archon-unavailable'),
    'an answered empty list is not an outage — ' + describe(goal));
  assert.equal(goal.nextAction && goal.nextAction.kind, 'retry',
    'an answered absence still prescribes the retry — ' + describe(goal));
  // The other half of the table: `run-not-found` is a verdict about the WORK
  // (every read that could answer DID answer), so it seals FAILED, not UNKNOWN.
  // Pinned here so a future relaxation of OUTCOME_UNKNOWN_CODES to "everything
  // that is not a success" goes red.
  assert.equal(goal.verdict, 'FAILED',
    'an answered absence is a verdict about the work, not an unknown outcome — ' + describe(goal));
});

// --------------------------------------------------- Site 2: pollRun's counter

test('goal: a 200 whose terminal-poll body cannot be read is an outage, never "the run never finished"', async () => {
  // The dispatch names its run, so adoption is a single FOUND read and the
  // poll begins immediately. Read 1 is a good record; every later read is a 200
  // with an unreadable body.
  const goal = await runGoalCase({
    dispatchRunId: 'run-goal-counter-1',
    detailAfterDispatch: (n) => (n === 1
      ? jsonRes({ run: { id: 'run-goal-counter-1', conversation_id: CONV, codebase_id: CODEBASE, working_path: null, workflow_name: WF, user_message: 'task probe: ' + OBJECTIVE, status: 'running' }, events: [] })
      : unparseableRes()),
  });
  const codes = goal.failureCodes || [];

  // RED BEFORE THE FIX: the counter moved on the 200, so the deadline reported
  // `timeout` — "the run never reached a terminal state" — a claim about a
  // record we never managed to read.
  assert.ok(codes.includes('archon-unavailable'),
    'every poll being unreadable is an OUTAGE, got ' + JSON.stringify(codes) + ' — ' + describe(goal));
  assert.ok(!codes.includes('run-timeout'),
    'a run we never read must never be reported as one that never finished — ' + describe(goal));
  assert.notEqual(goal.nextAction && goal.nextAction.kind, 'retry',
    'an outage must never suggest a retry — ' + describe(goal));
  // The terminal-poll outage raises the SAME code as the discovery outage, so the
  // single catch must seal the SAME verdict. This is the throw whose message said
  // "run outcome unknown" while the verdict said FAILED; the harness row
  // `goal-poll-run-unavailable` asserts this value, and it is pinned here at the
  // outcome level too.
  assert.equal(goal.verdict, 'UNKNOWN',
    'the terminal-poll outage must seal UNKNOWN, never FAILED — ' + describe(goal));
});

// ============================== the refusal-code table guard (#42 ruling) =====
//
// The catch derives the verdict from the CODE and DEFAULTS TO FAILED for anything
// not in OUTCOME_UNKNOWN_CODES. That default is the right runtime behaviour (an
// unknown code must never license a retry), but it means a NEW read-failure code
// would silently become FAILED — the mirror of "an unenumerated code silently
// becomes do-not-retry" that flowfaults' scan exists to prevent. This is the guard
// against that: every code lib/goal.js can seal a goal with is classified below,
// and a code the source raises that is neither listed nor covered by a listed
// family FAILS this test.
//
// It lives in this file because this file is the goal.js read-outcome ->
// refusal regression net; the harness's GOAL_MATRIX pins four codes by OUTCOME,
// and this pins the COMPLETENESS of the classification.
const INTENDED_VERDICT = {
  // "we could not read / could not trust what we read" -> UNKNOWN
  'archon-unavailable': 'UNKNOWN',
  'evidence-invalid': 'UNKNOWN',
  // a verdict about the WORK -> FAILED (never UNKNOWN: each one is an answer)
  'run-not-found': 'FAILED',
  'run-timeout': 'FAILED',
  'run-ambiguous': 'FAILED',
  'workflow-name-mismatch': 'FAILED',
  'no-route': 'FAILED',
  'registry-not-configured': 'FAILED',
  'objective-required': 'FAILED',
  // raised by lib/conversation.js through provisionConversation, inside the same
  // try — not conversation-prefixed, which is why it is listed rather than
  // covered by a family.
  'task-not-found': 'FAILED',
  // Raised BEFORE the try (the retry/fork parent lookup), so these propagate as a
  // rejection and no envelope is sealed at all. Listed because this table
  // enumerates every code the module can throw: if the lookup ever moves inside
  // the try, its verdict must not change silently.
  'retry-parent-not-found': 'FAILED',
  'fork-parent-not-found': 'FAILED',
};
// Families whose members are all verdicts about the work. Listed as prefixes so a
// new member of a family does not have to be enumerated here — but a new FAMILY
// does, and that is the failure this guard exists to produce.
const FAILED_FAMILIES = ['conversation-', 'workspace-', 'environment-', 'solari-'];

test('goal.js: every refusal code the module can raise is classified, and UNKNOWN is exactly the read-failure codes', () => {
  // (a) ONE RULE, TWO AUTHORITIES, ONE ANSWER. The runtime set and the table must
  // agree; a code moved into one and not the other is the drift this catches.
  const intendedUnknown = Object.entries(INTENDED_VERDICT)
    .filter(([, v]) => v === 'UNKNOWN').map(([k]) => k).sort();
  assert.deepEqual([...OUTCOME_UNKNOWN_CODES].sort(), intendedUnknown,
    'OUTCOME_UNKNOWN_CODES and the intended-verdict table disagree — one of them was edited alone');

  // (b) COMPLETENESS. Every code the source raises, from the two modules whose
  // throws reach goal.js's catch.
  const libDir = join(HERE, '..', 'lib');
  const goalSrc = readFileSync(join(libDir, 'goal.js'), 'utf8');
  const convSrc = readFileSync(join(libDir, 'conversation.js'), 'utf8');
  const raised = new Set();
  for (const m of goalSrc.matchAll(/\bcode:\s*'([^']+)'/g)) raised.add(m[1]);
  for (const m of convSrc.matchAll(/convErr\(\s*'([^']+)'/g)) raised.add(m[1]);

  // The scan must be non-vacuous: if the patterns ever stop matching (a refactor
  // to a code constant, say), this test would pass while covering nothing. Pin
  // that it found codes it is known to have found.
  for (const known of ['archon-unavailable', 'run-not-found', 'run-timeout']) {
    assert.ok(raised.has(known),
      'the source scan did not find ' + known + ' — the scan pattern no longer matches the tree, so this guard is vacuous');
  }

  // The one DYNAMIC throw site: `code: unreadableCode`, whose possible values are
  // the typed rejection reasons for UNAVAILABLE and INVALID. Asserted structurally
  // so a rename cannot silently remove it from this guard's coverage.
  assert.match(goalSrc, /code:\s*unreadableCode\b/,
    'the dynamic unreadable-code throw site moved or was renamed — re-derive this guard before trusting it');
  raised.add('archon-unavailable');
  raised.add('evidence-invalid');

  const unlisted = [...raised]
    .filter((c) => !(c in INTENDED_VERDICT) && !FAILED_FAMILIES.some((p) => c.startsWith(p)))
    .sort();
  assert.deepEqual(unlisted, [],
    'goal.js can seal a goal with a code this table does not classify: ' + unlisted.join(', ') +
    ' — classify it, and put it in OUTCOME_UNKNOWN_CODES ONLY if it means "we could not read it"');

  // (c) The negative direction: a family that must NOT be UNKNOWN is asserted, so
  // a blanket "everything is UNKNOWN" edit cannot pass (a) and (b) alone.
  for (const family of FAILED_FAMILIES) {
    assert.ok(![...OUTCOME_UNKNOWN_CODES].some((c) => c.startsWith(family)),
      'no ' + family + '* code is a read failure — none may be in OUTCOME_UNKNOWN_CODES');
  }
});
