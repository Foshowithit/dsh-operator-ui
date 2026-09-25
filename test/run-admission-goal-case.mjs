#!/usr/bin/env node
// Single-row child runner for the GOAL-LEVEL admission rows — the reads that
// live BELOW discoverRun() and can therefore never be reached by the
// discoverRun-level boundary in test/run-admission-harness.test.mjs:
//
//   * the stray-run diagnostic (lib/goal.js findConversationRun), reached only
//     from _run()'s discovered-none branch;
//   * the terminal-state poll (lib/goal.js pollRun), reached only after an
//     adoption exists;
//   * the dispatch-token detail read (lib/goal.js fetchRunDetail via
//     discoverRun's dispatchedRunId branch), whose typed outcome decides what
//     the none-branch refusal is allowed to claim.
//
// Eight rows drive those paths today (see fixtures/run-admission/records.json
// -> goalLevel.rows): seven refusals plus ONE CONTROL, `goal-poll-run-not-terminal`,
// which serves a readable non-terminal record on every poll so that the terminal
// window can only close by reaching its deadline. This runner is generic over the
// row name; it contains no per-row knowledge and no verdict. One row
// (`goal-list-body-unreadable`) reaches a FOURTH path — the discovery loop's own
// list read, INSIDE discoverRun — and lives here rather than at the admission-level
// boundary because its content is a VERDICT (UNKNOWN), and a verdict only exists on
// the goal path; the admission-level rows assert refusal NAMES. Its fixture entry
// records that, and the reason is repeated here because the row name does not.
//
// ONE FAULT MECHANISM, TWO SURFACES (see `faultRead` below). A fault that begins
// after N post-dispatch reads can be a TRANSPORT failure (the read never
// completes at all), a non-2xx answer, or a 2xx answer whose BODY the reader
// cannot use. The third is the same defect class on both the list and the detail
// surface, so it is spelled the same way on both (`thenBody`, with `thenStatus`
// defaulting to 200) and served by one helper. It cannot be a per-scenario MODE:
// it has to fire on the Nth read of a surface that already answered correctly on
// earlier reads, so the body has to change mid-run.
//
// `storefaults`' `listMode` in test/verify-poll-outcomes.test.mjs is the other
// surface of this same concept against a DIFFERENT reader (lib/verify.js), and it
// is the right shape there: a discovery-deadline row needs the fault to apply
// from the FIRST read of the list, which a mode expresses and a sequencing knob
// cannot. Neither knob can express the other's case, and neither duplicates the
// other — do not "unify" them into one.
//
// BOTH SURFACES ARE NOW IN USE, and the detail surface's usage arrived WITH the
// ruling rather than ahead of it. `goal-poll-run-not-a-record` is the row that
// needs it: the terminal poll's success predicate is PARSE-level, so a 200 whose
// body is `{ok:true}` still counts as a successful read and the window can end in
// run-timeout for a record we never obtained. It was held back while its expected
// code was open, because a row whose expectation is a guess is not evidence. The
// ruling closed that by pointing at the DETAIL READER IN THE SAME FILE:
// `fetchRunDetail` already classifies this exact body as INVALID — its comment
// names `{ok:true}` — and INVALID maps to `evidence-invalid`, a member of
// OUTCOME_UNKNOWN_CODES, so the verdict is UNKNOWN. The mechanism is on both
// surfaces because it is ONE mechanism; the two usages now differ only in which
// surface carries the fault.
//
// ONE SUB-QUESTION IS STILL OPEN, and it is `boundary`'s to rule rather than this
// file's: on a non-record 200, does the poll stop at the FIRST INVALID read, or
// keep polling for a real record and classify at the deadline? The row is
// deliberately INVARIANT under both answers — every poll read is a non-record, so
// there is never a record read to weigh and either variant classifies it
// evidence-invalid — which is why the row could land before the answer did.
//
// test/run-admission-harness.test.mjs spawns one process PER ROW with its own
// DSH_HOME, exactly as test/conversation.test.mjs spawns
// test/conversation-case.mjs. The reason is not style: lib/tasks.js memoizes its
// hydrate-from-disk pass in module state (let hydratePromise = null) and
// lib/goal.js holds a module-level in-flight guard (let inflight = null), so two
// goal rows in one process would share a task cache and a single runGoal()
// promise. Row isolation is only real across a process boundary.
//
// Usage: node test/run-admission-goal-case.mjs <rowName> <dshHome>
//
// Protocol: the result is ONE JSON line on stdout, and it is the LAST line the
// process ever writes — the parent JSON.parses that line. All diagnostics go to
// stderr. Expected outcomes exit 0; only a harness-level fault exits non-zero.
//
// THE DISCIPLINE IS UNCHANGED FROM THE PARENT FILE: this runner supplies the
// bytes the boundary would have read and the OUTCOME of each read. It supplies
// no verdict. The row's expected refusal lives in the parent test, never here.
//
// WHY THE FAULT IS KEYED ON THE DISPATCH POST, NOT ON A READ COUNTER
// tasks.js hydration, the reconciliation pass inside getTask, and the
// pre-dispatch snapshot all consume list reads before the dispatch happens, so a
// counter-armed fault would depend on how many reads those internal paths
// happen to make — not a stable contract. The dispatch POST is a STRUCTURAL
// marker: "reads before this always answer; then exactly N post-dispatch reads
// answer; then the fault." That makes the outage a property of the fixture, not
// of machine timing or internal call counts.

const rowName = process.argv[2];
const dshHome = process.argv[3];
if (!rowName || !dshHome) {
  console.error('usage: run-admission-goal-case.mjs <rowName> <dshHome>');
  process.exit(2);
}
process.env.DSH_HOME = dshHome;

const { readFileSync } = await import('node:fs');
const { writeFile, mkdir } = await import('node:fs/promises');
const { join, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(readFileSync(join(HERE, 'fixtures', 'run-admission', 'records.json'), 'utf8'));
const G = FIXTURES.goalLevel;
const row = G.rows.find((r) => r.name === rowName);
if (!row) {
  console.error('unknown goal row: ' + rowName);
  process.exit(2);
}

// The orchestrator this row talks to. A synthetic host: no port is bound, so
// this child cannot collide with anything else in the suite.
const ORCHESTRATOR = 'http://harness-' + row.name + '.test';
process.env.DSH_OPERATOR_UI_ARCHON = ORCHESTRATOR;
process.env.DSH_OPERATOR_UI_AUTHORITY_PRESET = G.authorityPreset;

// The routing registry is a FILE the goal path reads (config.registry.path), so
// the row's frozen registry is materialized into this row's own DSH_HOME. It is
// the same object the fixture froze; nothing about the route is decided here.
await mkdir(dshHome, { recursive: true });
const registryPath = join(dshHome, 'registry.json');
await writeFile(registryPath, JSON.stringify(G.registry, null, 2));
process.env.DSH_OPERATOR_UI_REGISTRY = registryPath;

const WF = G.registry.capabilities[0].workflow;
const CODEBASE = G.association.expectedCodebaseId;

// ---------------------------------------------------------------------------
// The controlled read boundary. One scenario per child, so no host keying is
// needed — every read this process makes belongs to this row.
// ---------------------------------------------------------------------------

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// ONE fault mechanism, TWO surfaces (see the header). `thenBody` is the shared
// part — a 2xx answer whose BODY the reader cannot use — and it takes precedence
// on both surfaces. Everything else is the surface's OWN default, passed in
// rather than guessed, so neither surface's long-standing fault can be silently
// replaced by the other's: the list read stops completing at all, and the detail
// read answers a non-2xx. No row that predates this helper changes behaviour.
function faultRead(spec, defaultFault) {
  if (spec.thenBody !== undefined) return jsonRes(spec.thenBody, spec.thenStatus || 200);
  return defaultFault();
}

let dispatched = false;
let postDispatchListOk = 0;
let postDispatchDetailOk = 0;

const listOkReads = Number.isFinite(row.list.afterDispatchOkReads) ? row.list.afterDispatchOkReads : Infinity;
const detailOkReads = Number.isFinite(row.detail.afterDispatchOkReads) ? row.detail.afterDispatchOkReads : Infinity;

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));

  // The T1 binding verification primitive: existence + live project binding.
  const convMatch = u.pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (convMatch) {
    const id = decodeURIComponent(convMatch[1]);
    return jsonRes({ platform_conversation_id: id, codebase_id: CODEBASE, cwd: null });
  }

  // The dispatch POST. This is the structural marker the faults are keyed on.
  if (u.pathname === '/api/workflows/' + WF + '/run') {
    dispatched = true;
    const body = { accepted: row.dispatch.accepted !== false, status: row.dispatch.status || 'started' };
    if (row.dispatch.runId) body.runId = row.dispatch.runId;
    return jsonRes(body);
  }

  // The run list: discovery polling, the pre-dispatch snapshot, and the stray
  // diagnostic all read it. Only the post-dispatch reads are faulted.
  if (u.pathname === '/api/workflows/runs') {
    if (dispatched) {
      postDispatchListOk += 1;
      if (postDispatchListOk > listOkReads) {
        // Default fault: a transport failure, not a 500 — the read does not
        // complete at all. findConversationRun reports this as 'unavailable'.
        return faultRead(row.list, () => { throw new Error('harness: post-dispatch run list read failed'); });
      }
    }
    return jsonRes({ runs: row.list.runs || [] });
  }

  // The run detail: the adoption read and the terminal-state poll.
  const m = u.pathname.match(/^\/api\/workflows\/runs\/(.+)$/);
  if (m) {
    if (dispatched) {
      postDispatchDetailOk += 1;
      if (postDispatchDetailOk > detailOkReads) {
        // Default fault: a non-2xx answer. `thenBody` overrides it with a 2xx
        // body the reader cannot use — the same shape as the list surface's.
        return faultRead(row.detail, () => jsonRes({ error: 'orchestrator exploded' }, row.detail.thenStatus || 500));
      }
    }
    return jsonRes({ run: row.detail.run || null, events: [] });
  }

  throw new Error('harness: unexpected path ' + u.pathname);
};

// ---------------------------------------------------------------------------
// Seed the durable task envelope through the REAL writer, then drive the REAL
// goal path. No test-only persistence, no re-implemented admission rule.
// ---------------------------------------------------------------------------

const { upsertTask } = await import('../lib/tasks.js');
const { runGoal } = await import('../lib/goal.js');

const association = { ...G.association, archonConversationId: row.conversationId };

await upsertTask({
  taskId: row.taskId,
  tasksVersion: 2,
  kind: 'goal',
  objective: G.objective,
  createdAt: '2026-09-23T11:00:00.000Z',
  attempts: [],
  checks: [],
  failureCodes: [],
  verdict: 'PENDING',
  status: 'running',
  conversation: association,
});

function goalReport(goal) {
  const attempts = Array.isArray(goal.attempts) ? goal.attempts : [];
  const last = attempts.length ? attempts[attempts.length - 1] : null;
  return {
    verdict: goal.verdict || null,
    failureCodes: goal.failureCodes || [],
    error: goal.error || null,
    attemptFailureCode: (last && last.failureCode) || null,
    attemptError: (last && last.error) || null,
    runId: (last && last.runId) || null,
    adoptionMode: (last && last.adoption && last.adoption.mode) || null,
    discovery: (last && last.discovery) || null,
    conversationId: goal.conversationId || null,
    workflow: (goal.route && goal.route.selected && goal.route.selected.workflow) || null,
    attempts: attempts.length,
    dispatchAccepted: !!(last && last.dispatch && last.dispatch.accepted),
  };
}

let result;
try {
  const goal = await runGoal({ objective: G.objective, retryOf: row.taskId, approved: true });
  result = { ok: true, ...goalReport(goal), reads: { postDispatchListOk, postDispatchDetailOk, dispatched } };
} catch (e) {
  // A throw here is a harness-level fault (the goal path is expected to resolve
  // with a FAILED verdict, not to throw): report it so the parent can fail
  // loudly rather than read a missing field as a refusal.
  result = { ok: false, error: { code: e.code || null, message: String((e && e.message) || e) }, reads: { postDispatchListOk, postDispatchDetailOk, dispatched } };
  process.exitCode = 1;
}

console.log(JSON.stringify(result));
