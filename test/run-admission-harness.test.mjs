// Deterministic run-admission harness (S2-R / OP-4R admission gate).
//
// WHY THIS FILE EXISTS
// The gate that decides whether an executed run's evidence proves it belongs
// to a specific dispatch is protected today by cases 9b–9m of
// test/conversation.test.mjs. Those cases are TIMING-SENSITIVE: they arm a
// live mock Archon with delays/drops and then race the child's pre-dispatch
// snapshot. Under full-suite load an availability leg can fire before the
// identity leg, so the run is still refused but a DIFFERENT leg names it —
// observed as case 9i expecting /user-message/ and getting
// 'run detail not retrievable'. A flaky negative test is not evidence.
//
// THE FIX, IN ONE SENTENCE
// Fixtures control the external RECORDS; nothing controls the VERDICT.
//
// WHAT THIS FILE DOES NOT DO
// It does not re-implement task-truth, admission, or the promotion rules. It
// drives the REAL lib/goal.js discoverRun() — the production admission caller —
// and the REAL lib/task-truth.js verifyParentLinkage() it consumes, through a
// controlled read boundary. The only thing this file supplies is the bytes the
// boundary would have read, and the outcome of the read itself.
//
// THE SEAM (smallest injectable one that fits the existing pattern)
// test/op4r-reconcile.test.mjs already stubs the read boundary at
// globalThis.fetch with a per-call log (`stubArchon`). This file reuses that
// pattern and nothing more: a fetch stub that answers the two production URLs
// (`/api/workflows/runs?…` and `/api/workflows/runs/<id>`) from frozen JSON.
// No production module is edited, and no production module is re-implemented.
//
// DETERMINISM UNDER CONCURRENCY (the whole point)
//  1. Records are frozen JSON on disk, not live reads — the same bytes are
//     returned on every poll, so which leg fires cannot depend on machine load.
//  2. Read OUTCOMES are explicit fixture fields (`{ "fault": "SERVER_ERROR" }`
//     etc.), not timing. An outage is an outage on the first poll and on the
//     twentieth.
//  3. Each matrix row gets its OWN synthetic orchestrator host
//     (http://harness-<row>.test), so rows run CONCURRENTLY in one process
//     with one stub, with no shared mutable boundary state and no port.
//  4. No port is bound at all, so this file cannot collide with
//     test/conversation.test.mjs (which binds an OS-assigned ephemeral port)
//     or anything else in the suite.
//  5. The GOAL-LEVEL rows — the reads BELOW discoverRun, which this boundary
//     cannot reach — run in a CHILD PROCESS each, with their own DSH_HOME,
//     because lib/tasks.js memoizes its hydrate pass in module state and
//     lib/goal.js holds a module-level in-flight guard. See the section at the
//     end of this file.
//
// CURRENT STATE: ONE KNOWN GATE GAP, and eight rows whose PASS has not been
// observed yet. Both facts are named rather than folded into a count.
//
// ONE DEFECT CLASS, THREE WITNESSES HERE, AND THE TREE HAS MOVED UNDER ALL OF
// THEM. The class is: a 2xx whose body cannot be USED is not a read. It has
// instances on three reads in lib/goal.js alone — discoverRun's list read (now
// contract-level, `Array.isArray(lb.runs)`), `findConversationRun` (was weak, now
// fixed) and `pollRun` (still PARSE-level) — and at least one outside it, in
// lib/verify.js's detail poll. A further instance in lib/tasks.js is filed
// separately and is not described here, because this file has not read it. TWO
// MORE FILES CARRY INSTANCES, found and read by another teammate rather than by
// this file: lib/teach.js (three parse-level success tests with three DIFFERENT
// consequences — one reports an outage as an absence, one blames the capability,
// and one is SILENT, emptying the pre-dispatch exclusion set so a run that
// predates the dispatch can be adopted) and lib/acquire.js (the list poll). They
// are NAMED here rather than described, for the same reason as lib/tasks.js, and
// they are named at all so that a reader does not take this census as complete.
// The tree has changed twice since these rows were written, so each witness below
// is described by WHAT IT PINS rather than by what it last observed — the
// expectations did not move, the code did.
//
// NOTE ON THE FOURTH READ IN lib/goal.js: the pre-dispatch snapshot also writes
// `(lb && lb.runs) || []`, and it is deliberately NOT counted as an instance. It
// sits inside a try/catch and is documented as a discovery aid only, so a
// non-array body there is swallowed or iterated harmlessly and nothing is
// claimed from it. Fixing it would be noise; leaving it is the right call.
//
// THE KNOWN GATE GAP — `goal-poll-run-not-a-record` (goal-level; expected code
// `evidence-invalid`, verdict UNKNOWN, and today it refuses `run-timeout` /
// FAILED). `pollRun` (lib/goal.js) has a PARSE-level success predicate, so a 200
// whose body is `{ok:true}` counts as a successful read, no status is ever
// obtained, and the window closes as "the run did not reach a terminal state" —
// a claim about the WORK for a record we never read. The expected code is not a
// guess: `fetchRunDetail`, the DETAIL READER IN THE SAME FILE, already classifies
// that exact body as INVALID, and its comment names it — "This subsumes the
// proxy/health-envelope case: {ok:true} and {status:'completed'} carry no id and
// are INVALID here rather than FOUND with a fabricated id". INVALID maps to
// `evidence-invalid`, a member of OUTCOME_UNKNOWN_CODES, so the verdict is
// UNKNOWN. The poll is the only one of the two readers of this endpoint that has
// not adopted the classification its sibling already applies to the same bytes.
// NOTE FOR THE FIX: pollRun's vocabulary is `terminal | timeout | unavailable`
// and it does NOT consume READ_REJECTION_REASON, so this is not only a stricter
// predicate — the poll needs an INVALID outcome and the caller needs a branch
// mapping it to a throw carrying `evidence-invalid`. The file's OWN KNOWN
// RESIDUAL block states the same asymmetry and gates the change on enumerating
// the flip set; that enumeration is EMPTY, because no existing row serves a
// non-record body to pollRun.
//
// THE FORMER STRAY-READ GAP — `goal-stray-list-body-unreadable` — IS CLOSED IN
// THE TREE, and this is the SECOND time a row in this file has gone green with no
// change to this file. It was: `findConversationRun` typed its read by HTTP
// status and by whether the body PARSED, but not by whether the body was a run
// list — `const runs = (lb && lb.runs) || []` collapsed "no runs key" and "an
// empty runs array" into one value, so a 200 whose body was `{error:'…'}` returned
// 'none', which the function's OWN doc-comment calls "an ANSWERED absence" and
// which that same comment promised could not happen. The caller records
// `strayDiagnostic` ONLY on the 'unavailable' branch, so the false 'none' recorded
// NOTHING and fell through to "dispatch accepted but no run appeared": an
// authoritative absence claim about a list we could not read, licensing the retry
// that can double-run a live workflow. The landed fix mirrors discoverRun's
// contract-level predicate — `if (!lb || !Array.isArray(lb.runs)) return
// { status: 'unavailable', … }` — which is the shape this file's report proposed,
// and it leaves a json() throw and `{"runs": []}` exactly as they were, so only
// the shape case moved. THE ROW DID NOT CHANGE: it asserts the correct end state
// (`run-not-found`, FAILED, and a `strayDiagnostic` that is now present), so it
// needed no edit to go green, and reverting the fix turns it red again.
//
// That is a CODE-LEVEL verification, not an observed run. The sandbox that runs
// node is fail-closed, so this row is listed under UNOBSERVED rather than claimed
// green: reading the code tells us it SHOULD pass, only a run tells us it does.
//
// Both gaps were found by reading lib/goal.js's own readers rather than by a
// commission. lib/goal.js is `boundary`'s; this file supplies the witness and the
// expectation, not the fix. The closed one was filed as a task and fixed; the
// live one is filed and reported.
//
// THE FORMER GAP — `goal-poll-run-unavailable` (goal-level; expected verdict
// UNKNOWN) — IS CLOSED IN THE TREE, and it was closed by a better mechanism than
// the one this file predicted. It was: the pollRun-unavailable throw carried
// `code: 'archon-unavailable'` but no verdict, so the catch's `|| 'FAILED'`
// sealed FAILED while the message in the SAME statement said "run outcome
// unknown" — the message and the verdict contradicting each other, with the
// verdict being the one that persists. The landed fix is CODE-KEYED rather than
// per-throw: `OUTCOME_UNKNOWN_CODES = new Set(['archon-unavailable',
// 'evidence-invalid'])`, and the catch at the END of the goal path derives
// `has(code) ? 'UNKNOWN' : 'FAILED'`. The poll throw raises 'archon-unavailable',
// which is in that set, so the row's expectation is satisfied BY CONSTRUCTION and
// it needs no change here.
//
// That is a CODE-LEVEL verification, not an observed run, and the difference is
// the whole reason this block exists. The sandbox that runs node was fail-closed
// when the fix landed, so the row is listed under UNOBSERVED below rather than
// claimed green. Reading the code tells us the row SHOULD pass; only a run can
// tell us it does.
//
// The #51 dependency that made the gap live is kept in the row rather than
// deleted with the gap. Both success counters gate on a PARSED body, so a
// 200-with-unreadable-body terminal poll reaches the throw at all; reverting #51
// would make the row UNREACHABLE rather than red, which is a failure mode this
// file cannot see and a reader must therefore be told about.
//
// UNOBSERVED — `no-expected-workspace`, `goal-stray-list-body-unreadable`,
// `goal-list-body-unreadable`, `goal-poll-run-not-a-record`,
// `goal-poll-run-unavailable`, `goal-poll-run-not-terminal`, `goal-detail-invalid`,
// `goal-detail-unavailable`: written or re-expected while the sandbox that runs
// node was fail-closed, so their pass has never been seen. The sections where
// they live say so in place. Four of the eight are not refusal findings and are
// named rather than counted: `goal-poll-run-not-a-record` is the known GAP above
// (red, by design), `goal-stray-list-body-unreadable` and
// `goal-list-body-unreadable` are GREEN REGRESSION PINS — one pins the
// `findConversationRun` shape gate that has since landed, the other pins #51 —
// and `goal-poll-run-not-terminal` is a POSITIVE CONTROL: the one row that must
// keep passing when the poll's success predicate is tightened for #64.
//
// Everything else in the ADMISSION MATRIX passed at the last execution that was
// possible: the 2 positive controls that existed then and all 16 refusal rows.
// That sentence deliberately does NOT extend to the goal-level section, whose
// observation history this file will not restate loosely: those rows were written
// and re-expected across a window in which the sandbox that runs node was
// fail-closed, and the ONE goal-level row whose pass predates that window is
// `goal-find-conversation-unavailable` — which is exactly why it is the only goal
// row the UNOBSERVED list above does not name. Eight rows are NEW or re-expected
// since that run (named UNOBSERVED above), so neither "all green" nor the old
// counts carry over to the next run. The file is now 19 admission rows (3
// positive controls + 16 refusal rows) and 8 goal-level rows.
//
// This file spent its life with deliberate red rows, and they were the point: a
// harness that cannot fail is not evidence. They went green one by one as the
// gate changed, each with no change to this file, and the last one
// (`wrong-workspace`) needed the workspace leg plus a carrier for the expected
// path. What follows is the record of what each red row was FOR, because those
// rows are now regression pins rather than findings — reverting any of the
// underlying gate changes turns its row red again, which is the only thing that
// makes the green meaningful. There IS one live finding again —
// `goal-poll-run-not-a-record`, named at the top — alongside a second that has
// already gone green the way the rest of this file's red rows did: both were
// found by
// reading the readers rather than by a commission, so they are recorded as GAPS
// and expectations, with the fix belonging to lib/goal.js's owner. The control for
// the PREVIOUS fix is still here, so a fix that over-corrects that one has a row
// that says so.
//
// WHAT EACH FORMERLY-RED ROW PINS
//   * `direct-wrong-user-message` / `direct-wrong-project` — the direct-exact
//     path must gate on its APPLICABLE linkage legs. A run on OUR OWN
//     conversation with a foreign codebase_id, or with a different user_message,
//     was ADOPTED while the linkage evidence was computed and then discarded.
//     Applicability is now decided from the data (`applicable` on each leg, a
//     non-verdict omits `pass`), not from a hardcoded leg list. The positive
//     control is the load-bearing proof this did not break the fully-associated
//     path.
//   * `temporal/dispatch — pre-dispatch` — a provably-linked run excluded ONLY
//     because it predates the dispatch must be RECORDED (`discovery.excluded`)
//     and named on the refusal, not collapsed into the same name as "no run ever
//     appeared". The two situations need different names: one of them licenses a
//     redispatch.
//   * `workspace — wrong-workspace` — the last defect standing. A fully-linked
//     run from a FOREIGN workspace on the same project was ADOPTED. Diagnosing it
//     showed TWO gaps, not one: no leg compared `working_path`, AND nothing
//     carried an EXPECTED path to compare against (`discoverRun` takes no
//     workspace argument; the association carried no path). Both halves are in
//     place — a `working-path` leg whose applicability is decided from
//     `association.expectedWorkspacePath`, and the fixture now supplies that
//     expectation. Its PAIR is `no-expected-workspace` (see below).
//   * `goal-detail-invalid` / `goal-detail-unavailable` — the two goal-level
//     rows for the reads BELOW discovery. When discovery answered 'none', the
//     caller used to name the refusal `run-not-found` no matter WHY nothing was
//     adopted: a run whose detail read was UNAVAILABLE or INVALID was reported
//     as an ABSENCE, and an absence licenses a redispatch of a workflow that may
//     be alive. The refusal is now DERIVED from the typed rejection, and it
//     carries `verdict: 'UNKNOWN'` — an unreadable record is not a verdict about
//     the work, so it must not be sealed FAILED (which would blame the
//     capability for our own inability to read).
//   * `goal-poll-run-unavailable` — the terminal-state poll. A run that was
//     ADOPTED and then could not be read must refuse with verdict UNKNOWN,
//     because the prose in the same statement already said the outcome was
//     unknown while the catch sealed FAILED. The pin is now CODE-KEYED
//     (`OUTCOME_UNKNOWN_CODES`), so it holds for every throw that raises an
//     outcome-unknown code, not merely this one.
//   * `goal-poll-run-not-terminal` — the CONTROL that bounds that fix from the
//     other side, and the only row here that is not a former defect. A readable,
//     well-formed, NON-TERMINAL record must still count as a successful read:
//     "the run never finished" is an answer about the run, so it refuses as
//     run-timeout with verdict FAILED, never as an outage with UNKNOWN. Without
//     this row a tightened poll predicate could turn every unfinished run into an
//     unreadable one, and every assertion in this file would still pass.
//
// THE DISTINCTNESS ASSERTION is what makes those green rows more than smoke
// tests, and it is the reason this file was commissioned. Every refusal must
// name its OWN axis: two rows on different axes refused under the same name is a
// failure, because a refusal that cannot say which check fired is not a verdict.
// That property is what the timing-sensitive cases it replaced could not state.
// The admission rows that existed at the last execution that was possible were
// all observed passing: the 2 positive controls that existed then, all 16 refusal
// rows, the invariant checks, the row-name/leg-identity check and the boundary
// self-check. The third positive control (`no-expected-workspace`, which asserts
// the `working-path` leg is INAPPLICABLE rather than passed) and the 7 goal-level
// rows at the end of this file have NOT been observed — see the header. Their
// expectations are derived from the contracts in lib/task-truth.js and
// lib/goal.js, so each one fails loudly rather than passing quietly if the tree
// does not do what those contracts say.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(readFileSync(join(HERE, 'fixtures', 'run-admission', 'records.json'), 'utf8'));

// The production admission caller and the identity predicate it consumes.
// fetchRunDetail is imported as well: it is the typed read boundary itself, and
// it is the ONLY way to observe WHICH internal guard refused a body. discoverRun
// collapses every INVALID read to the single name 'evidence-invalid', so a row
// whose name claims a specific guard cannot be checked from discoverRun's output
// alone. See the leg-identity test near the bottom.
const { discoverRun, fetchRunDetail } = await import('../lib/goal.js');
const { verifyParentLinkage } = await import('../lib/task-truth.js');

const ROWS = new Map(FIXTURES.rows.map((r) => [r.name, r]));

// ---------------------------------------------------------------------------
// The controlled read boundary.
//
// One scenario per synthetic host. Each scenario is a pure function of the
// frozen fixture: same URL in, same bytes out, every time.
// ---------------------------------------------------------------------------

const scenarios = new Map(); // host -> { list, details }

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

// A read that never completes until the caller's own AbortSignal fires. The
// signal is the REAL one discoverRun builds (AbortSignal.timeout(transport
// timeout)), so this exercises the production timeout path rather than a
// hand-rolled imitation of it. The 20 s hard stop exists only so a broken
// timeout cannot hang the suite forever.
function timeoutRes(signal) {
  return new Promise((_, reject) => {
    const abort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    const hardStop = setTimeout(abort, 20000);
    if (!signal) { clearTimeout(hardStop); return abort(); }
    if (signal.aborted) { clearTimeout(hardStop); return abort(); }
    signal.addEventListener('abort', () => { clearTimeout(hardStop); abort(); }, { once: true });
  });
}

function detailFaultResponse(fault, scenario, id, opts) {
  switch (fault) {
    case 'NOT_FOUND': return jsonRes({ error: 'not found' }, 404);
    case 'GONE': return jsonRes({ error: 'gone' }, 410);
    case 'SERVER_ERROR': return jsonRes({ error: 'orchestrator exploded' }, 500);
    case 'RATE_LIMITED': return jsonRes({ error: 'slow down' }, 429);
    // The read COMPLETES with 200, but the bytes are not a usable record.
    case 'INVALID_JSON': return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); } };
    case 'NOT_OBJECT': return jsonRes('this is a bare string, not a run object');
    // A 200 OBJECT that self-identifies as neither a run nor an error envelope.
    // Distinct from NOT_OBJECT: this one clears the typeof/Array.isArray gate and
    // is refused later, by the "carried no run id" guard.
    case 'NOT_RUN_OBJECT': return jsonRes({ ok: true });
    case 'ABSENT_BODY': return jsonRes(null);
    case 'ID_MISMATCH': {
      const row = scenario.list.find((r) => r.id === id) || {};
      return jsonRes({ run: { ...row, id: 'run-harness-imposter' } });
    }
    case 'TIMEOUT': return timeoutRes(opts && opts.signal);
    default: throw new Error('unknown fault in fixture: ' + fault);
  }
}

function installBoundary() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const scenario = scenarios.get(u.hostname);
    if (!scenario) throw new Error('run-admission harness: no fixture scenario for host ' + u.hostname);
    if (u.pathname === '/api/workflows/runs') return jsonRes({ runs: scenario.list });
    const m = u.pathname.match(/^\/api\/workflows\/runs\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const spec = scenario.details[id];
      // Default-deny: an id with no fixture entry is Archon ANSWERING absence.
      if (!spec) return jsonRes({ error: 'not found' }, 404);
      if (spec.fault) return detailFaultResponse(spec.fault, scenario, id, opts);
      return jsonRes({ run: spec.run });
    }
    throw new Error('run-admission harness: unexpected path ' + u.pathname);
  };
  return () => { globalThis.fetch = realFetch; };
}

// The association a row is judged against. A row may declare keys the shared
// fixture association does NOT record, via `associationOmit`. That exists for the
// ABSENT case, which is a different behaviour from the mismatched case: an
// association recording no expected workspace path cannot judge the workspace
// axis at all, so the leg must be NOT APPLICABLE rather than failed. Both the
// admission run and the positive-control test resolve the association through
// here, so a row can never be driven against one association and asserted
// against another. It CLONES before deleting, so the frozen association is never
// mutated (pinned by the self-check below).
const associationFor = (row) => {
  const a = { ...FIXTURES.association };
  for (const k of row.associationOmit || []) delete a[k];
  return a;
};

// Drive the REAL admission caller for one frozen row. The transport is the
// production shape (lib/environments.js localTransport) with a synthetic host
// so rows are addressable concurrently.
async function runRow(row) {
  const host = 'harness-' + row.name + '.test';
  scenarios.set(host, { list: row.list, details: row.details });
  return discoverRun({
    workflowName: row.dispatch.workflowName,
    preIds: new Set(row.preIds || []),
    conversationId: row.dispatch.conversationId,
    association: associationFor(row),
    dispatchedMessage: row.dispatch.message,
    dispatchedRunId: row.dispatch.dispatchedRunId || undefined,
    transport: { environmentId: 'env-harness', baseUrl: 'http://' + host, timeoutMs: 1000, headers: () => ({}) },
  });
}

// The reason a refusal actually NAMED. The point of the harness is that this
// must be specific to the row: a shared generic reason is the defect.
//
// Two sources, in precedence order:
//   1. the TYPED reason on a rejected candidate (lib/goal.js
//      READ_REJECTION_REASON: 'run-not-found' | 'archon-unavailable' |
//      'evidence-invalid' | 'workflow mismatch' | 'parent linkage failed: <legs>');
//   2. when nothing was rejected at all, the discovery STATUS, named the way the
//      production caller (lib/goal.js _run) names it — status 'none' becomes
//      run-not-found, 'unavailable' becomes archon-unavailable, 'ambiguous'
//      becomes an ambiguity refusal. This mirrors the caller's own mapping; it
//      is not a second opinion about the admission rules.
const STATUS_REFUSAL_NAME = {
  none: 'run-not-found',
  unavailable: 'archon-unavailable',
  ambiguous: 'ambiguous adoption',
};

const namedReasons = (d) => [
  ...((d && d.rejected) || []).map((r) => (r && r.reason) || null),
  (d && d.reason) || null,
].filter(Boolean);

const refusalNames = (d) => {
  const named = namedReasons(d);
  if (named.length) return named;
  const byStatus = STATUS_REFUSAL_NAME[d && d.status];
  return byStatus ? [byStatus] : [];
};

const signatureOf = (d) => refusalNames(d).join(' | ') || ('status:' + d.status);

const describe = (d) => JSON.stringify({
  status: d.status,
  adoption: d.adoption ? { mode: d.adoption.mode, runId: d.adoption.runId } : null,
  candidates: d.candidates,
  named: refusalNames(d),
  rejected: ((d && d.rejected) || []).map((r) => ({ id: r.id, outcome: r.outcome || null, reason: r.reason || null, attempts: r.attempts })),
  reason: d.reason || null,
});

// ---------------------------------------------------------------------------
// THE MATRIX. The verdicts live HERE, never in the fixtures.
//
// `dimension` is the identity axis the row is testing. Two rows with different
// dimensions may not be refused under the same name — that is the whole
// assertion, and it is the one the flaky cases 9b–9m could not make.
// ---------------------------------------------------------------------------

const MATRIX = [
  // Positive controls: the harness must be able to say YES, or "it refused"
  // proves nothing.
  { row: 'known-good-direct', verdict: 'ADOPT', mode: 'direct-exact' },
  { row: 'known-good-parent', verdict: 'ADOPT', mode: 'parent-linked' },
  // The ABSENT case — the other half of the workspace-leg decision, and the
  // ONLY positive control that exercises a NON-APPLICABLE leg. Its run bytes are
  // identical to `wrong-workspace`'s (a fully-linked child at the FOREIGN path);
  // the sole difference is that its association records no expected path, so the
  // `working-path` leg is inapplicable and the run is still adopted. A row that
  // only asserted "still adopted" would be satisfied by a DELETED leg, so the
  // absent-case test below asserts the leg's SHAPE as well.
  { row: 'no-expected-workspace', verdict: 'ADOPT', mode: 'parent-linked' },

  { row: 'wrong-workflow', verdict: 'REFUSE', dimension: 'workflow', reason: /workflow mismatch/i },
  { row: 'wrong-project', verdict: 'REFUSE', dimension: 'project/codebase', reason: /codebase-id|project/i },
  { row: 'wrong-user-message', verdict: 'REFUSE', dimension: 'user-message', reason: /user-message/i },

  // The direct-exact path (run on OUR OWN bound conversation). These two rows
  // were the defect: the path was gated on workflow name ONLY — the linkage
  // evidence was computed and then thrown away, so a run on the right
  // conversation with a foreign project or a different user_message was ADOPTED.
  // Same two identity axes, reached by the other adoption mode; now gated on
  // every APPLICABLE leg, and pinned here so it cannot regress.
  { row: 'direct-wrong-user-message', verdict: 'REFUSE', dimension: 'user-message', reason: /user-message/i },
  { row: 'direct-wrong-project', verdict: 'REFUSE', dimension: 'project/codebase', reason: /codebase-id|project/i },
  { row: 'ambiguous-pair', verdict: 'REFUSE', dimension: 'ambiguous-adoption', reason: /ambiguous/i },
  { row: 'record-absent', verdict: 'REFUSE', dimension: 'run-not-found', reason: /not.?found|absent|no run/i },
  { row: 'detail-unavailable', verdict: 'REFUSE', dimension: 'evidence-unavailable', reason: /unavailable|not retrievable|unreadable|could not be read/i },
  { row: 'detail-timeout', verdict: 'REFUSE', dimension: 'evidence-unavailable', reason: /unavailable|not retrievable|unreadable|timed out|timeout/i },
  // NOT an invalid-evidence row: this detail read SUCCEEDS (the record is
  // well-formed) and the refusal comes from a LINKAGE leg — the LIST row is
  // honest and the DETAIL contradicts it. It sat on the invalid-evidence axis
  // until the leg-identity test's completeness guard flagged it, which is the
  // point of that guard: a row filed on the wrong axis is a row whose name does
  // not say what it reaches.
  { row: 'poisoned-detail', verdict: 'REFUSE', dimension: 'linkage-contradiction', reason: /parent-platform-id|poison|contradict|invalid/i },
  { row: 'poisoned-invalid-json', verdict: 'REFUSE', dimension: 'invalid-evidence', reason: /invalid|evidence/i },
  { row: 'poisoned-not-a-record', verdict: 'REFUSE', dimension: 'invalid-evidence', reason: /invalid|evidence/i },
  { row: 'poisoned-no-run-id', verdict: 'REFUSE', dimension: 'invalid-evidence', reason: /invalid|evidence/i },
  { row: 'poisoned-id-mismatch', verdict: 'REFUSE', dimension: 'invalid-evidence', reason: /id mismatch|mismatch|invalid|evidence/i },

  // The row below is why this harness was commissioned, and it is now a
  // REGRESSION PIN rather than a live finding.
  //
  // It was the last admission defect standing: a fully-linked run from a FOREIGN
  // workspace on the same project was adopted, because no leg compared
  // working_path. Diagnosing it showed TWO gaps, not one — the leg, AND a carrier
  // for the EXPECTED path, since discoverRun takes no workspace argument and the
  // association carried no path, so even a perfect leg would have had nothing to
  // compare against. Both halves landed: verifyParentLinkage grew a
  // `working-path` leg whose APPLICABILITY is decided from the association's
  // expectedWorkspacePath, and this fixture now supplies that expectation.
  //
  // Reverting either half turns this row red again — which is the whole point of
  // keeping it. The distinctness property is what makes it more than a smoke
  // test: the refusal must name `working-path` and nothing else, so a future
  // change that refuses this run on some OTHER leg fails here.
  {
    row: 'wrong-workspace',
    verdict: 'REFUSE',
    dimension: 'workspace',
    reason: /workspace|working.?path/i,
    note: 'P4 (closed) — the refusal must name the workspace axis. Before the fix this '
      + 'row was ADOPTED (status found, mode parent-linked); the gate had no leg that '
      + 'compared working_path, and no carrier for an expected path to compare it '
      + 'against. Both halves are now in place.',
  },
  {
    row: 'pre-dispatch',
    verdict: 'REFUSE',
    dimension: 'temporal/dispatch',
    // The refusal must name the TEMPORAL axis, not "no run". A provably-linked
    // run excluded only because it predates the dispatch is a different fact
    // from "nothing appeared": the first says a run is sitting on this
    // conversation, the second licenses a redispatch. The exclusion is now
    // recorded in `discovery.excluded` and named on the refusal, so the row
    // carries its own distinct name — the exclusion message — rather than the
    // generic run-not-found it used to share with `record-absent`. That sharing
    // was the distinctness defect; the assertion below is what caught it.
    reason: /temporal|pre.?dispatch|predate|before the dispatch|dispatch window|history/i,
  },
];

// Fixture faults that mean "the read did not complete" (UNAVAILABLE) versus
// "the read completed and the record is unusable" (INVALID). Used by the
// invariants test to prove an outage is never dressed up as a mismatch.
const UNREADABLE_FAULTS = new Set(['NOT_FOUND', 'GONE', 'SERVER_ERROR', 'RATE_LIMITED', 'TIMEOUT']);
const INVALID_FAULTS = new Set(['INVALID_JSON', 'NOT_OBJECT', 'NOT_RUN_OBJECT', 'ABSENT_BODY', 'ID_MISMATCH']);
// Every leg id verifyParentLinkage can emit. `working-path` is here because the
// predicate gained a sixth leg; a leg missing from this list would let the
// invariant check below silently stop covering it.
const LEG_NAMES = ['workflow-name', 'parent-conversation-id', 'parent-platform-id', 'codebase-id', 'user-message', 'working-path'];

// One process-wide boundary, installed once and torn down once. It is NOT a
// per-test hook: a boundary that is restored between tests would let a live
// read slip in, which is precisely the non-determinism this file removes.
let teardown = null;
let home = null;
// DSH_HOMEs handed to the goal-level child rows (see the section at the end).
const goalHomes = [];

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'opui-admission-harness-'));
  process.env.DSH_HOME = home;
  teardown = installBoundary();
});

after(async () => {
  if (teardown) teardown();
  if (home) await rm(home, { recursive: true, force: true });
  for (const h of goalHomes) await rm(h, { recursive: true, force: true });
});

// Each row is read ONCE and its discovery result is shared by every assertion
// below, so the wall-clock cost is paid once and no test can perturb another's
// view of the boundary.
const cache = new Map();
const discoveryFor = (rowName) => {
  if (!cache.has(rowName)) cache.set(rowName, runRow(ROWS.get(rowName)));
  return cache.get(rowName);
};

// WHICH GUARD each invalid-evidence row actually reaches.
//
// discoverRun reports EVERY INVALID read under the single name
// 'evidence-invalid' (READ_REJECTION_REASON.INVALID), so from discoverRun's own
// output the four rows below are indistinguishable. That makes the row NAME the
// only place the specific guard can be claimed — and a name that claims a guard
// the row does not reach is a lie the refusal matrix cannot catch, because every
// one of them is green either way.
//
// So the claim is asserted against the read boundary's own `readError` instead
// of being asserted in prose. `poisoned-not-object` used to be the offender: its
// name reads as "an object that is not a run", while the row reaches the
// earlier `typeof`/Array.isArray "not a record" gate. Renamed to
// `poisoned-not-a-record`, and the object-carrying-no-id shape it was being
// mistaken for is now its own row.
const INVALID_LEGS = {
  'poisoned-invalid-json': /^run detail body was not valid JSON$/,
  'poisoned-not-a-record': /^run detail body was not a record$/,
  'poisoned-no-run-id': /^run detail body carried no run id$/,
  'poisoned-id-mismatch': /^run detail id mismatch: /,
};

// Drive the REAL typed read boundary for one row's own fixture bytes, so the
// guard is observed rather than inferred.
async function readLegFor(rowName) {
  const row = ROWS.get(rowName);
  assert.ok(row, 'missing fixture ' + rowName);
  const host = 'harness-' + row.name + '.test';
  scenarios.set(host, { list: row.list, details: row.details });
  return fetchRunDetail(row.list[0].id, {
    environmentId: 'env-harness',
    baseUrl: 'http://' + host,
    timeoutMs: 1000,
    headers: () => ({}),
  });
}

// --- Positive controls ------------------------------------------------------

test('positive control: a run that legitimately belongs to the dispatch IS adopted', async () => {
  assert.equal(typeof discoverRun, 'function');
  assert.equal(typeof verifyParentLinkage, 'function');
  for (const row of MATRIX.filter((m) => m.verdict === 'ADOPT')) {
    const fixture = ROWS.get(row.row);
    assert.ok(fixture, 'missing fixture ' + row.row);
    const d = await discoveryFor(row.row);
    assert.equal(d.status, 'found', row.row + ' must be adopted, got ' + describe(d));
    assert.ok(d.adoption, row.row + ' must carry an adoption record');
    assert.equal(d.adoption.mode, row.mode, row.row + ' adoption mode — got ' + d.adoption.mode);
    assert.equal(d.adoption.verifiedFrom, 'run-detail', row.row + ' must be verified from run detail');
    assert.match(d.adoption.runId, /^run-harness-/, row.row + ' adopted a foreign run id: ' + d.adoption.runId);
    // The linkage evidence the adoption carries is the REAL predicate's output,
    // resolved through the SAME association the row was driven against. Compared
    // in full — ids, `applicable` and `pass` alike — so a re-derivation that
    // agreed on the leg names but disagreed about applicability would fail here.
    const source = fixture.details[d.adoption.runId].run;
    const check = verifyParentLinkage(source, associationFor(fixture), fixture.dispatch.workflowName, fixture.dispatch.message);
    assert.deepEqual(d.adoption.evidence, check.evidence, row.row + ' evidence must be the predicate\'s own legs, verbatim');
  }
});

// --- The ABSENT case: a premise that is not recorded is not a verdict --------
//
// `no-expected-workspace` and `wrong-workspace` carry the SAME identity bytes — a
// fully-linked child that ran at the FOREIGN path. The only difference is the
// association: `wrong-workspace` records an expected workspace path and is
// REFUSED on the `working-path` leg; `no-expected-workspace` records none and is
// ADOPTED. That pair IS the absent-case decision, so "still adopted" is only half
// the assertion — a DELETED leg would adopt too. The leg must be PRESENT and
// marked INAPPLICABLE, carrying NO `pass`, because a non-verdict that carries a
// pass/fail is a verdict about nothing.
//
// NOT YET EXECUTED: this row was written while the sandbox that runs node was
// fail-closed, so its PASS is unobserved. Its expectation is derived from
// lib/task-truth.js's leg() contract (a leg whose premise is absent is emitted
// with `applicable: false` and no `pass`), and it fails loudly if that contract
// is not what the tree does.
test('absent case: an association with no expected workspace path makes the leg INAPPLICABLE, never passed', async () => {
  const absent = ROWS.get('no-expected-workspace');
  const expected = ROWS.get('wrong-workspace');
  assert.ok(absent && expected, 'both halves of the absent-case pair must exist');

  // The pair must differ ONLY in the association, or comparing them proves
  // nothing. The run ids differ by design; every IDENTITY field must be equal.
  const identityOf = (r) => ({
    conversation_id: r.conversation_id,
    parent_conversation_id: r.parent_conversation_id,
    parent_platform_id: r.parent_platform_id,
    codebase_id: r.codebase_id,
    working_path: r.working_path,
    workflow_name: r.workflow_name,
    user_message: r.user_message,
    status: r.status,
  });
  assert.deepEqual(identityOf(absent.list[0]), identityOf(expected.list[0]),
    'the absent-case pair must carry identical identity bytes — only the association expectation may differ');

  // And the expectation must really be absent/present, respectively.
  assert.equal('expectedWorkspacePath' in associationFor(absent), false,
    'no-expected-workspace must omit expectedWorkspacePath, or it is not the absent case');
  assert.equal('expectedWorkspacePath' in associationFor(expected), true,
    'wrong-workspace must carry expectedWorkspacePath, or it is not the mismatched case');

  const d = await discoveryFor('no-expected-workspace');
  assert.equal(d.status, 'found', 'the absent case must still be ADOPTED — ' + describe(d));
  assert.ok(d.adoption, 'the absent case must carry an adoption record');

  const leg = d.adoption.evidence.find((e) => e.id === 'working-path');
  assert.ok(leg, 'the working-path leg must EXIST even when its premise is absent — a missing leg is '
    + 'indistinguishable from a check nobody ever wrote: ' + JSON.stringify(d.adoption.evidence));
  assert.equal(leg.applicable, false,
    'with no recorded expectation the leg is NOT APPLICABLE, not passed — got ' + JSON.stringify(leg));
  assert.equal('pass' in leg, false,
    'a non-applicable leg must carry NO pass — a pass here is a verdict about nothing: ' + JSON.stringify(leg));
  assert.equal(leg.got, FIXTURES.identity.foreignWorkingPath,
    'the inapplicable leg must still record what it READ: ' + JSON.stringify(leg));

  // The same bytes WITH an expectation are refused on that very leg — this is
  // what makes the pair isolate the applicability decision alone.
  const ws = await discoveryFor('wrong-workspace');
  assert.notEqual(ws.status, 'found', 'the same run bytes with an expectation must be refused — ' + describe(ws));
  const namedOnLeg = namedReasons(ws).filter((r) => String(r).includes('working-path'));
  assert.equal(namedOnLeg.length, 1,
    'the refusal must name working-path and nothing else — named: ' + JSON.stringify(namedReasons(ws)));
});

// --- The refusal matrix -----------------------------------------------------

test('refusal matrix: every row refuses AND names its own distinct reason', { concurrency: 20 }, async (t) => {
  const rows = MATRIX.filter((m) => m.verdict === 'REFUSE');
  const observed = new Map();

  await Promise.all(rows.map((m) => {
    const label = m.dimension + ' — ' + m.row;
    return t.test(label, async (inner) => {
      const d = await discoveryFor(m.row);
      observed.set(m.row, { matrix: m, discovery: d });

      inner.diagnostic('observed: ' + describe(d));
      if (m.note) inner.diagnostic(m.note);

      const why = m.note || '';

      // (1) IT MUST REFUSE. "Refused" is stricter than "not found": no
      // adoption record may exist, and the run may not be reported as found.
      assert.notEqual(d.status, 'found', m.row + ' was ADOPTED — ' + why + ' — ' + describe(d));
      assert.equal(d.adoption, null, m.row + ' left an adoption record — ' + why + ' — ' + describe(d));

      // (2) IT MUST NAME ITS OWN REASON. A refusal that cannot say which
      // identity axis failed is exactly the defect this harness exists to
      // catch, so the named reason is asserted, not just the refusal.
      const names = refusalNames(d);
      const namedOrStatus = names.join(' | ') || ('status:' + d.status);
      assert.match(namedOrStatus, m.reason,
        m.row + ' refused but did not name the ' + m.dimension + ' axis — named: ' + namedOrStatus + ' — ' + why + ' — full: ' + describe(d));

      // (3) Every rejected candidate must carry the TYPED read outcome the
      // production read boundary produces, and a bounded attempt count — an
      // untyped rejection is the generic shared reason this harness forbids.
      for (const r of d.rejected || []) {
        if (r.outcome !== undefined) {
          assert.ok(['FOUND', 'NOT_FOUND', 'UNAVAILABLE', 'INVALID'].includes(r.outcome),
            m.row + ' rejected with an unknown read outcome: ' + r.outcome);
          assert.ok(Number.isInteger(r.attempts) && r.attempts >= 1 && r.attempts <= 3,
            m.row + ' rejected with an unbounded attempt count: ' + r.attempts);
        }
      }

      // (4) The named reason must not be the generic "it refused" status when
      // a specific axis was exercised. `status:none` is Archon answering
      // absence; it is a legitimate name for run-not-found and for nothing else.
      if (m.dimension !== 'run-not-found') {
        assert.ok(names.length > 0 || d.status === 'ambiguous' || d.status === 'unavailable',
          m.row + ' was refused under the generic status ' + d.status + ' with no named reason — ' + describe(d));
      }
    }).catch(() => { /* recorded by the runner; the parent still fails */ });
  }));

  // --- (5) THE DISTINCTNESS PROPERTY, as a first-class assertion ------------
  // Two rows on DIFFERENT identity axes must not be refused under the same
  // name. This is the property the flaky cases could not state at all.
  const bySignature = new Map();
  for (const [rowName, { matrix, discovery }] of observed) {
    const sig = signatureOf(discovery);
    if (!bySignature.has(sig)) bySignature.set(sig, []);
    bySignature.get(sig).push({ rowName, dimension: matrix.dimension });
  }
  const collisions = [];
  for (const [sig, entries] of bySignature) {
    const dimensions = new Set(entries.map((e) => e.dimension));
    if (dimensions.size > 1) collisions.push({ sig, entries: entries.map((e) => e.rowName + ' [' + e.dimension + ']') });
  }
  t.diagnostic('refusal signatures:\n' + [...bySignature.entries()].map(([sig, es]) => '  ' + sig + '  <- ' + es.map((e) => e.rowName).join(', ')).join('\n'));
  assert.deepEqual(collisions, [],
    'rows on different identity axes were refused under the SAME name — a generic shared reason is a failure of this harness:\n' +
    collisions.map((c) => '  "' + c.sig + '" names ' + c.entries.join(' and ')).join('\n'));

  // Every matrix row must have been observed (guards against a silently
  // skipped row making the distinctness check vacuous).
  assert.equal(observed.size, rows.length, 'every matrix row must be observed');
});

// --- The stated invariants --------------------------------------------------

test('invariants: an unreadable record cannot establish a match, and a failed read cannot establish a mismatch', async () => {
  for (const m of MATRIX.filter((x) => x.verdict === 'REFUSE')) {
    const fixture = ROWS.get(m.row);
    const readFaults = Object.values(fixture.details).filter((d) => d && d.fault).map((d) => d.fault);
    const d = await discoveryFor(m.row);

    // (a) AN UNREADABLE RECORD CANNOT ESTABLISH A MATCH. An adoption may only
    // ever be built from a FOUND detail read. Checked structurally: the run
    // this row adopted must be a run whose fixture detail read is a record,
    // not a fault.
    if (d.adoption) {
      const spec = fixture.details[d.adoption.runId];
      assert.ok(spec && spec.run,
        m.row + ': adopted run ' + d.adoption.runId + ' came from a detail read that was NOT a record — ' + describe(d));
    }

    // (b) A FAILED READ CANNOT ESTABLISH A MISMATCH: when the detail read
    // never completed, no linkage leg may be reported as failed, because a leg
    // failure is a claim about a record we did not manage to read.
    if (readFaults.some((f) => UNREADABLE_FAULTS.has(f))) {
      const legClaims = namedReasons(d).filter((r) => LEG_NAMES.some((leg) => String(r).includes(leg)));
      assert.deepEqual(legClaims, [],
        m.row + ': an unreadable record was reported as a linkage MISMATCH (' + legClaims.join(', ') + ') — ' + describe(d));
    }

    // (c) The typed outcome must be present on every rejected candidate, and
    // it must agree with what the fixture actually served.
    for (const r of d.rejected || []) {
      if (r.outcome === undefined) continue; // a leg-failure rejection carries no read outcome
      const spec = fixture.details[r.id];
      if (!spec) { assert.equal(r.outcome, 'NOT_FOUND', m.row + ': an absent detail must read NOT_FOUND, got ' + r.outcome); continue; }
      if (spec.run) { assert.equal(r.outcome, 'FOUND', m.row + ': a served record must read FOUND, got ' + r.outcome); continue; }
      const expected = UNREADABLE_FAULTS.has(spec.fault) ? 'UNAVAILABLE' : 'INVALID';
      assert.equal(r.outcome, expected, m.row + ': fault ' + spec.fault + ' must read ' + expected + ', got ' + r.outcome);
    }
  }
});

// --- The row NAMES are falsifiable too --------------------------------------

// A row whose name claims a specific guard, but which reaches a different one,
// is green in the refusal matrix and lies in the report. This is the only test
// that can catch it, because discoverRun flattens all four to 'evidence-invalid'.
test('invalid-evidence rows reach the guard their NAME claims (observed on the read boundary, not asserted in prose)', async () => {
  for (const [rowName, expected] of Object.entries(INVALID_LEGS)) {
    const read = await readLegFor(rowName);
    assert.equal(read.outcome, 'INVALID',
      rowName + ' must read INVALID — got ' + read.outcome + ' (' + read.readError + ')');
    assert.match(String(read.readError), expected,
      rowName + ' does NOT reach the guard its name claims — the row name lies. readError: ' + read.readError);
    assert.equal(read.detail, null, rowName + ' must not carry a detail out of an INVALID read');
  }
  // Every invalid-evidence row in the matrix must appear above, so a row added
  // later cannot skip the leg check by simply not being listed.
  const covered = new Set(Object.keys(INVALID_LEGS));
  const missing = MATRIX.filter((m) => m.dimension === 'invalid-evidence' && !covered.has(m.row)).map((m) => m.row);
  assert.deepEqual(missing, [], 'invalid-evidence rows with no leg assertion: ' + missing.join(', '));
});

// --- The boundary itself is falsifiable -------------------------------------

test('harness self-check: the boundary is frozen, and it refuses to serve what it was not given', async () => {
  const fixture = ROWS.get('known-good-parent');
  // Two INDEPENDENT reads of the same frozen row must be byte-identical. This
  // is the property that replaces timing: there is nothing to race.
  const a = await runRow(fixture);
  const b = await runRow(fixture);
  assert.equal(a.status, b.status);
  assert.equal(a.adoption.mode, b.adoption.mode);
  assert.equal(a.adoption.runId, b.adoption.runId);
  assert.equal(a.adoption.detailSha256, b.adoption.detailSha256, 'a frozen record must hash identically across reads');

  // SINGLE SOURCE for the workspace expectation. JSON cannot reference another
  // key, so the "identity.workingPath is the one source" rule is enforced by
  // assertion rather than by construction: the association's expectation and the
  // identity tuple's working path must be the SAME string. If they drift, the
  // positive controls and `wrong-workspace` stop differing by exactly one axis
  // and the matrix silently loses its meaning.
  assert.equal(FIXTURES.association.expectedWorkspacePath, FIXTURES.identity.workingPath,
    'association.expectedWorkspacePath must be identity.workingPath — the fixture has drifted');
  assert.notEqual(FIXTURES.identity.foreignWorkingPath, FIXTURES.identity.workingPath,
    'the foreign path must differ from the expected one, or the workspace row tests nothing');

  // `associationFor` must DERIVE, never MUTATE: it clones before deleting. If it
  // ever deleted in place, the absent-case row would silently strip the
  // expectation out from under `wrong-workspace` and both rows would flip.
  const probe = associationFor(ROWS.get('no-expected-workspace'));
  assert.equal('expectedWorkspacePath' in probe, false, 'associationFor must honour associationOmit');
  assert.equal(FIXTURES.association.expectedWorkspacePath, FIXTURES.identity.workingPath,
    'associationFor MUTATED the frozen association — the absent case must not strip the shared expectation');

  // ONE AXIS PER NEGATIVE ROW. Each refusal row must differ from a known-good
  // run on exactly the dimension it is named for. The workspace expectation is
  // what makes this checkable for the two *-wrong-project rows: they must carry
  // the CORRECT working path, or their refusal could be named `working-path`
  // instead of `codebase-id` and the row would stop isolating its own axis.
  for (const rowName of ['wrong-project', 'direct-wrong-project']) {
    const row = ROWS.get(rowName);
    for (const r of [...(row.list || []), ...Object.values(row.details).map((d) => d.run).filter(Boolean)]) {
      assert.equal(r.working_path, FIXTURES.identity.workingPath,
        rowName + ' must carry the CORRECT working path — it exists to isolate the codebase axis, and a second '
        + 'failing axis would make its refusal name ambiguous');
    }
  }
  for (const r of [...(ROWS.get('wrong-workspace').list || [])]) {
    assert.equal(r.codebase_id, FIXTURES.association.expectedCodebaseId,
      'wrong-workspace must carry the CORRECT codebase id — it exists to isolate the workspace axis');
  }

  // The boundary is closed: an un-fixtured host is a hard error at the
  // boundary, so no assertion in this file can ever be satisfied by a live read.
  await assert.rejects(
    () => globalThis.fetch('http://not-a-fixture-host.test/api/workflows/runs?limit=50'),
    /no fixture scenario for host/,
    'an un-fixtured host must be a hard error, never a silent empty read'
  );
});

// ---------------------------------------------------------------------------
// THE GOAL-LEVEL ROWS: the reads BELOW discoverRun.
//
// discoverRun's boundary cannot reach them, so they get their own — in a CHILD
// PROCESS per row (test/run-admission-goal-case.mjs). That is not stylistic:
// lib/tasks.js memoizes its hydrate-from-disk pass in module state and
// lib/goal.js holds a module-level in-flight guard, so two goal rows in one
// process would share a task cache and a single runGoal() promise. Row
// isolation is only real across a process boundary. The pattern is the one
// test/conversation.test.mjs already uses (spawn test/conversation-case.mjs).
//
// The discipline is unchanged: the child supplies the bytes and the read
// OUTCOME (fixtures/run-admission/records.json -> goalLevel); the verdicts
// below are the harness's, and they are not in the fixture.
//
// These rows are WALL-CLOCK BOUNDED — discovery polls for 10 s before it may
// declare absence, and the terminal-state poll runs for 30 s before it may
// declare EITHER a timeout or an outage. The number of reads therefore varies
// run to run; the OUTCOME does not, and nothing below asserts a read count.
//
// FOUR OF THESE EIGHT ROWS PAY A FULL WINDOW BY CONSTRUCTION — two at 30 s and
// two at 10 s — because each of them faults a read on every attempt, so its
// window can only close by reaching the deadline: there is no early exit for any
// of them to take. The control `goal-poll-run-not-terminal` is one of the 30 s
// pair: it serves a readable, non-terminal record on every
// poll. `RUN_TERMINAL_WINDOW_MS` (lib/goal.js) is a bare
// `const`: not injectable, not read from the environment. So the 30 s is a real
// cost of this row, not a number the fixture can shrink. Making it injectable
// would be a test-only seam in `lib/`, which this harness may not add
// unilaterally; it is recorded here as a cost, and — if the suite's wall-clock
// ever becomes the binding constraint — as a PROPOSED seam rather than as a
// silent weakening of the row. The seam has ONE non-negotiable condition, and it
// is not the shape of the knob but the number of consumers: the resolved window
// must feed BOTH the deadline and the refusal prose, because the prose is
// composed from the same constant (`lib/goal.js`, which says so at its
// declaration: "Named because the refusal prose DERIVES from it"). A seam
// threaded to only one of them makes the refusal state a window it did not use.
// The control's prose pin below is where that would surface, which is why the
// condition is recorded there as well as here.
//
// THE OTHER TWO ARE THE 10 s PAIR, for the same structural reason:
// `goal-list-body-unreadable` faults EVERY post-dispatch list read,
// so discovery cannot exit early either — it must run to `ADOPTION_DEADLINE_MS`
// (10000 ms, also a bare `const`, also not injectable). `goal-stray-list-body-unreadable`
// does the same one read later and pays the same 10 s, because a discovery that
// adopts nothing always runs its window out. The second 30 s row is
// `goal-poll-run-not-a-record`: it serves a non-record body on every poll, so its
// terminal window cannot close early either. So the goal section's real
// wall-clock floor is roughly 80 s of pure waiting — 30 + 30 + 10 + 10 — before
// any test work happens, and it is the binding constraint on this file's runtime.
// Every number is recorded rather than hidden; none of them is a fixture knob.
//
// `goal-list-body-unreadable` IS A GREEN REGRESSION PIN, NOT A FINDING. The
// predicate it pins is already in the tree: the discovery counter increments only
// for a body whose `runs` is an ARRAY (`Array.isArray(lb.runs)`), so a 200 whose
// body parses but carries no run list never counts as a read, and the deadline
// then takes the OUTAGE exit rather than the ABSENCE one. #51 landed that, and
// this row is the LIST-surface counterpart of storefaults' #48 rows on the
// lib/verify.js reader — same defect class, different reader, and the same body
// shape (`{ "error": "unexpected shape" }`) so the two files name one concept
// once. Its `what` and its fixture entry say why absence would be the dangerous
// answer rather than merely the wrong one: absence prescribes a retry.
//
// SEVEN OF THESE EIGHT ROWS HAVE NOT BEEN OBSERVED TO PASS, and ONE OF THEM IS
// EXPECTED TO FAIL. The exception is `goal-find-conversation-unavailable`, the one
// goal-level row whose pass predates the fail-closed window — which is why it is
// the only goal row the UNOBSERVED list in the header does not name. The first
// pair was commissioned as
// red rows "before those fixes land" (team-lead) and was verified empirically
// with a throwaway spike BEFORE the assertions were written. The second pair was
// commissioned by `boundary` for the goal.js none-branch change (derive the
// absence code from the TYPED rejection), and the third row's expectation was
// re-derived when the poll's verdict was fixed. The three newest rows were filed
// by this harness after finding the holes itself: `goal-list-body-unreadable`
// (the child's only list fault had been a transport THROW, so discoverRun's
// contract-level list predicate had no witness), `goal-stray-list-body-unreadable`
// (the stray diagnostic had the same gap in its SHAPE form, since fixed — the row
// went green with no change to this file) and `goal-poll-run-not-a-record` (the
// poll's predicate is still parse-level, so a non-record body is counted as a read
// and the window blames the work — the live defect). All of it is written against lib
// changes that ARE in the working tree, but — stated plainly rather than implied
// — every PASS here is UNOBSERVED except the single row named above. The sandbox
// that runs node was fail-closed in
// the session that wrote them, so these rows are the first thing to re-run when
// execution is possible. They assert the exact code, the exact verdict and the
// recorded derivation, so a wrong expectation fails loudly instead of passing
// quietly.
//
// ONE ROW IS THE EXPECTED RED: `goal-poll-run-not-a-record`. Read its entry
// before reading the run: it asserts the CORRECT end state, so its failure is the
// finding rather than a stale expectation, and it must not be "fixed" by relaxing
// an assertion. The gap it exposes is named at the top of this file. Everything
// else in this section — including `goal-stray-list-body-unreadable`, which was
// the other expected red until the fix landed — is expected GREEN, so a red
// anywhere else is a different problem and should be read as one.
//
// `goal-poll-run-unavailable` WAS the live gate gap and is now a REGRESSION PIN.
// It asserted the CORRECT verdict while the pollRun-unavailable throw sealed
// FAILED — a harness that asserted today's verdict would have been blessing the
// collapse rather than exposing it. The fix landed code-keyed (see the header),
// so the row needs no change and goes green on its own; it is kept because
// reverting that derivation turns it red again.
//
// VERDICT IS PER-ROW, NOT "FAILED" FOR EVERYONE. Every row whose refusal means
// "we could not read it" refuses with verdict UNKNOWN, because an unreadable
// record is not a verdict about the work: sealing it FAILED would blame the
// capability for our own inability to read, and it is the same vocabulary
// lib/teach.js and lib/acquire.js already use. A row that asserted only "a
// verdict is present" would pass on the WRONG verdict, so the exact value is
// asserted — and the CONTROL row asserts the other side of the same boundary,
// FAILED for a run that WAS read and simply never finished.
// ---------------------------------------------------------------------------

const GOAL_MATRIX = [
  {
    row: 'goal-find-conversation-unavailable',
    dimension: 'stray-run diagnostic (findConversationRun)',
    what: 'the run list answers an empty absence during discovery, then the stray-run diagnostic read fails',
    // The authoritative discovery read SUCCEEDED and answered absence, so the
    // refusal names the absence axis. The stray read is a secondary refinement
    // (it exists to catch a run on our conversation under a DIFFERENT workflow),
    // and its failure is a gap to record — not a mismatch to claim and not a
    // licence to call the whole discovery unreadable.
    code: 'run-not-found',
    // FAILED, not UNKNOWN: every read that could answer the question DID answer.
    // The list read succeeded and named no run; only the separate refinement
    // failed, and that gap is recorded rather than promoted to a claim. An
    // unreadable STRAY read is not an unreadable RECORD — the refusal derives
    // from the primary list read, which answered.
    //
    // #51 DEPENDENCY — SATISFIED. lib/goal.js's justification for the
    // run-not-found refusal says "Reaching here means the FRESH LIST READ
    // SUCCEEDED (zero successful list reads return 'unavailable' earlier)". That
    // premise is only true when the success counter is gated on a PARSED body;
    // #51 has landed, so `successfulListReads` now increments only for a body
    // whose `runs` is an array, and this branch genuinely cannot be reached from
    // reads that never answered. Recorded rather than deleted because the
    // dependency was real until #51: a revert of that gating would silently make
    // the justification false again, and this row would still be green.
    verdict: 'FAILED',
    mustNot: ['workflow-name-mismatch', 'archon-unavailable', 'run-timeout'],
    assertExtra: (r, why) => {
      const diag = String((r.discovery && r.discovery.strayDiagnostic) || '');
      assert.match(diag, /^unavailable: /,
        'the failed stray read must be RECORDED as unavailable — without the typed diagnostic its null is read as "no stray run exists", which is the defect this row pins — '
        + why + ' — discovery: ' + JSON.stringify(r.discovery));
    },
  },
  {
    // THE FORMER STRAY-READ GAP — CLOSED IN THE TREE, AND THE ROW DID NOT
    // CHANGE TO GO GREEN. Same axis as the row above — the stray-run
    // diagnostic's read fails — and the SAME expected end state, differing in
    // exactly one thing: how the read failed. That row's stray read THROWS (a
    // transport failure, which `findConversationRun`'s catch types as
    // 'unavailable'); this one's answered 200 with a body that is not a run list,
    // which `findConversationRun` did NOT type at all:
    //   `const runs = (lb && lb.runs) || [];`   (lib/goal.js, findConversationRun)
    // collapses "no runs key" and "an empty runs array" into one value, so the
    // function returns 'none' — which its OWN doc-comment calls "an ANSWERED
    // absence". Its doc-comment also claims the opposite of what the code does:
    // "an unreadable list is 'unavailable' (we cannot name a mismatch AND we
    // cannot assert its absence)". That holds for `!lr.ok` and for a json()
    // throw, and NOT for the shape case. This is the two-event trap in its SHAPE
    // form rather than its parse form, and it is the same pattern as
    // lib/index.js's promoteCandidate — a comment asserting a contract the
    // producer does not fulfil.
    //
    // The caller then does the worst possible thing with it: the 'unavailable'
    // branch is the ONLY one that sets `strayDiagnostic`, so a false 'none'
    // records NOTHING and falls through to the run-not-found refusal
    // ("dispatch accepted but no run appeared") — an authoritative absence claim
    // about a list we could not read, with no trace that the read failed. The
    // operator sees a clean absence, and absence is what licenses the retry.
    //
    // IT WAS RED ON ONE ASSERTION, AND THE FIX LANDED WITHOUT TOUCHING THIS
    // FILE. The code and verdict asserted here are the CORRECT end state (the
    // primary list read DID answer, so the refusal stays run-not-found and the gap
    // is recorded rather than promoted) — the same values the THROW row above
    // already produces and passes — so the only thing that was missing was
    // `strayDiagnostic`, and the fix supplied it. The landed predicate mirrors
    // discoverRun's: `if (!lb || !Array.isArray(lb.runs)) return
    // { status: 'unavailable', … }`. It leaves a json() throw (still the catch)
    // and `{"runs": []}` (still 'none') exactly as they were, so only the shape
    // case moved and this row's expectation was right the first time. It is kept
    // as a pin because reverting that predicate turns it red again — and because
    // the fix exists only because the row was written first.
    //
    // NOT IN #64's FLIP SET, and that is why it is its own row: this is a LIST
    // read, so tightening the terminal poll's DETAIL predicate cannot flip it.
    row: 'goal-stray-list-body-unreadable',
    dimension: 'stray-run diagnostic (findConversationRun), the 200-body shape',
    what: 'discovery answers an empty absence, then the STRAY read answers 200 with a body that is not a run list — the gap must be recorded as an unreadable read, never silently collapsed into the answered absence that licenses a retry',
    code: 'run-not-found',
    verdict: 'FAILED',
    mustNot: ['workflow-name-mismatch', 'archon-unavailable', 'run-timeout'],
    assertExtra: (r, why) => {
      const diag = String((r.discovery && r.discovery.strayDiagnostic) || '');
      assert.match(diag, /^unavailable: /,
        'a stray read that could not be COMPLETED must be recorded as unavailable — without the typed diagnostic its null is read as "no stray run exists", which is this row\'s whole defect. A body that is not a run list is not an ANSWERED absence, and this is the assertion that says so — '
        + why + ' — discovery: ' + JSON.stringify(r.discovery));
    },
  },
  {
    row: 'goal-list-body-unreadable',
    dimension: 'discovery list read (adoption deadline, a 200 whose body is not a run list)',
    what: 'every post-dispatch list read answers 200 with valid JSON carrying no runs array, so no list read is ever COMPLETED; at the adoption deadline that is an outage, never the absence the deadline fall-through would otherwise report',
    // No list read ever completed, so we cannot say a run did not appear. The
    // deadline fall-through has two exits and only one of them is true here:
    // 'unavailable' (nothing was read) and 'none' (something was read and named
    // no run). Taking the second reports an ABSENCE — and absence is what
    // prescribes the retry that can double-run a workflow that is still alive.
    // This is the LIST-surface counterpart of storefaults' #48 rows: the same
    // defect class ("a 200 whose body is unusable is not a read") against a
    // different reader, pinned where the counter decides the branch.
    code: 'archon-unavailable',
    verdict: 'UNKNOWN',
    mustNot: ['run-not-found', 'run-timeout', 'workflow-name-mismatch', 'run-ambiguous'],
    assertExtra: (r, why) => {
      // The row means nothing unless discovery really ran to its deadline with a
      // zero counter. `attempt.discovery.unavailable` is stamped on the
      // discovery-outage branch ALONE (lib/goal.js, immediately before the
      // throw), so an `archon-unavailable` raised anywhere else in the goal path
      // satisfies the code above and still fails here — which is the whole point
      // of asserting it separately.
      assert.equal(r.discovery && r.discovery.unavailable, true,
        'the refusal must come from the DISCOVERY-OUTAGE branch — an archon-unavailable from any other path '
        + 'would satisfy the code and prove nothing about the list counter — ' + why
        + ' — discovery: ' + JSON.stringify(r.discovery));
      // The recorded reason IS the assertion: it names the counter that stayed
      // at zero, which is the mechanism this row exists to pin rather than the
      // refusal it produces.
      assert.match(String((r.discovery && r.discovery.reason) || ''), /never returned a successful read/i,
        'the recorded reason must name the counter that stayed at zero — '
        + why + ' — discovery: ' + JSON.stringify(r.discovery));
      assert.match(String(r.error || ''), /outcome unknown/i,
        'an unreadable list is an outcome we cannot claim either way — ' + why + ' — error: ' + r.error);
      // This asserts the DEFECT'S SYMPTOM is gone, and it is NOT claimed as a
      // partial-fix guard: on this path the code and the prose are produced by
      // ONE throw, so they cannot diverge, and a fix that satisfies the code
      // assertion above satisfies this one too. The anti-false-pass assertion is
      // the `discovery.unavailable` stamp at the TOP of this block, and its
      // mechanism is different — `archon-unavailable` is reachable from the poll
      // path as well, so the CODE alone does not say which branch fired and the
      // stamp does. Recorded because the stronger claim was made in review and
      // could not be constructed: storefaults asked for the construction and
      // there is none here, so the weaker true statement is the one that stays.
      assert.doesNotMatch(String(r.error || ''), /no run appeared/i,
        'an unreadable list must never be reported as "no run appeared" — the absence is exactly what was NOT '
        + 'established, and it is the answer that licenses the retry — ' + why + ' — error: ' + r.error);
    },
  },
  {
    row: 'goal-poll-run-unavailable',
    dimension: 'terminal-state poll (pollRun)',
    what: 'the run is adopted, then every terminal-state poll returns 500 — the refusal prose says the outcome is UNKNOWN, so the verdict must say UNKNOWN too, and today it says FAILED',
    // No poll read ever succeeded, so the run's OUTCOME is unknown. Claiming a
    // timeout would assert that the run was read and simply never finished —
    // a claim about a record we never managed to read.
    code: 'archon-unavailable',
    // THE FORMER GATE GAP, NOW A REGRESSION PIN. It was: the throw carries
    // `code: 'archon-unavailable'` but NO verdict, so the catch's `|| 'FAILED'`
    // sealed FAILED while the message in the SAME statement said "run outcome
    // unknown" — the message and the verdict contradicting each other, with the
    // verdict being the one that persists. The landed fix derives the verdict
    // from the CODE at the ONE catch site (`OUTCOME_UNKNOWN_CODES`), and this
    // code is a member of that set, so the row's expectation is satisfied by
    // construction and it needs no change here — the same "went green on its own
    // as the gate changed" property the rest of this file is built on. It is kept
    // as a pin because reverting that derivation turns it red again. UNOBSERVED,
    // not claimed green: the fix landed while the sandbox that runs node was
    // fail-closed.
    verdict: 'UNKNOWN',
    mustNot: ['run-timeout', 'workflow-name-mismatch', 'run-not-found'],
    assertExtra: (r, why) => {
      assert.match(String(r.error || ''), /outcome unknown/i,
        'the refusal prose must state that the outcome is unknown — this row exists to hold the PROSE and the '
        + 'VERDICT in agreement. They disagreed until the code-keyed derivation landed (the prose said unknown '
        + 'while the verdict said FAILED), and this assertion stays so a revert cannot restore that disagreement '
        + 'silently — ' + why + ' — error: ' + r.error);
      assert.match(String(r.error || ''), /could not be read/i,
        'an unreadable run must be reported as a read failure, never as a timeout — '
        + why + ' — error: ' + r.error);
    },
  },
  {
    // THE OVER-CORRECTION CONTROL FOR #64 — the only entry here that is not a
    // refusal finding. Every other row exists because the gate got something
    // WRONG; this one exists so that fixing #64 cannot get something ELSE wrong.
    //
    // #64 is the terminal poll's success predicate. Today `parsed` means "the
    // body parsed", not "the body is a run record we can consume", so a 200
    // whose body is `null` or `{ok:true}` counts as a successful read and the
    // window ends in run-timeout for a record we never obtained. The fix must
    // tighten that predicate to the CONTRACT — and the hazard of tightening is
    // over-correction, because a readable, well-formed, NON-TERMINAL record must
    // still count as a successful read: "the run never finished" is an ANSWER
    // about the run, not a failure to read it. So this row serves exactly that
    // record, on every poll, forever, and demands the timeout vocabulary.
    //
    // It is a POSITIVE CONTROL in the sense that matters here: it is the row
    // that must keep passing after the fix. If the tightened predicate requires
    // a terminal status, or treats a `running` record as unreadable, this row
    // flips to archon-unavailable / UNKNOWN and fails. That failure is the
    // signal, and it is the reason storefaults asked for this row NOW rather
    // than alongside the fix: a control written after the change can only
    // confirm it, never falsify it.
    row: 'goal-poll-run-not-terminal',
    dimension: 'CONTROL (pollRun): a readable run that never finishes is a timeout, not an outage',
    what: 'every post-dispatch detail read returns a well-formed record whose status is running, so the reads all succeed and the run never reaches a terminal state — an answer about the run, and it must refuse as run-timeout with verdict FAILED rather than as an outage',
    // FAILED, not UNKNOWN: every read answered. The poll read the run on every
    // poll and the run was still running when the window closed, so this is a
    // claim about the ATTEMPT — it was not observed to finish inside the named
    // window — and not about our ability to read it. `run-timeout` is
    // deliberately absent from OUTCOME_UNKNOWN_CODES for exactly this reason, and
    // this row is the witness that it stays absent.
    //
    // What FAILED must NOT be read as: "the work was wrong". Nothing here says
    // the capability is bad. It says an attempt that may still be alive is being
    // terminated rather than left sitting retryable, which is the conservative
    // direction. The distinction is load-bearing rather than decorative: it is
    // the difference between the operator stopping a live workflow and the
    // operator blaming a capability, and it is the same distinction that keeps an
    // unreadable record (UNKNOWN) from being sealed FAILED in the first place.
    //
    // THE STATUS THIS ROW SERVES IS DELIBERATELY IN THE INTERSECTION, and that is
    // a decision rather than a default — and it has now SURVIVED TWO CHANGES OF
    // THE DEFINITION, which is the strongest form of that claim. When this row was
    // written the readers disagreed: lib/acquire.js:221+279 used an ALLOW-LIST,
    // lowercased; lib/goal.js and lib/verify.js used a DENY-LIST
    // (`!== running/queued/pending`), raw. #67 has since moved the rule into ONE
    // home — lib/run-status.js (`TERMINAL_RUN_STATUSES` :66, `isTerminalRunStatus`
    // :80, case-normalised) — and both lib/goal.js (:29, used in pollRun) and
    // lib/verify.js (:37, used at :360) now classify through it. `running` is
    // non-terminal under EVERY definition that has been in play — allow-list,
    // deny-list, raw, normalised — so this row has never depended on the answer
    // and could not have pinned the contested set. That is the point, and it is
    // why the status must NOT be "strengthened" later: a row serving 'Running' or
    // 'succeeded' asserts one side of the question and pins the WRONG set on its
    // first run. Those rows belong to #68, written WITH the decision.
    //
    // ONE THING THE DEFINITION CHANGE DID NOT FIX, and the reason #68 also carries
    // a RED row: the rule normalises the CLASSIFICATION, but two JUDGEMENT sites
    // still compare the RAW status against a literal — `validateCapability`'s
    // `pass: runStatus === terminalExpected`, and the VERIFY site's
    // `completed: evidence.run.status === 'completed'` — so a run served as
    // 'COMPLETED' is classified terminal and then judged NOT completed.
    // Classification and judgement are two halves of one rule; this row only ever
    // depended on the first. Named by EXPRESSION rather than by line number on
    // purpose: an earlier version of this note cited the second site's line and it
    // had already drifted by the time anyone read it — the same lesson boundary's
    // KNOWN GAP block in lib/goal.js records, where one of its own references was
    // pushed down by the block's own length.
    code: 'run-timeout',
    verdict: 'FAILED',
    // `archon-unavailable` is the over-correction this row exists to catch: it
    // is what a predicate that stops counting a non-terminal record produces,
    // and it would be indistinguishable from an outage in the operator's view.
    mustNot: ['archon-unavailable', 'evidence-invalid', 'run-not-found', 'workflow-name-mismatch', 'run-ambiguous'],
    assertExtra: (r, why) => {
      // The run was ADOPTED and THEN read. Without this pair of assertions a
      // 'run-timeout' could be produced by a path that never reached the poll at
      // all — a discovery that timed out, say — and the control would prove
      // nothing about the poll's predicate. `attempt.runId` is stamped from the
      // adoption BEFORE pollRun is called (lib/goal.js), so it is present on a
      // timeout refusal and absent on a failure that never adopted.
      assert.equal(r.adoptionMode, 'dispatch-provided',
        'the control must reach the poll through a real adoption, not through a discovery failure — '
        + why + ' — got: ' + JSON.stringify(r));
      assert.equal(r.runId, 'run-goal-running',
        'the adopted run id must be carried onto the attempt before the poll — '
        + why + ' — got: ' + JSON.stringify(r));
      // The prose names the window it describes (`RUN_TERMINAL_WINDOW_MS / 1000`),
      // so this pins the refusal to the NAMED window rather than to any failure
      // that happens to be spelled "timeout".
      // The prose pin is hardcoded to the DEFAULT window ON PURPOSE: this row
      // runs the production default, so 30s is the value the deadline actually
      // used and the message is composed from the same constant. IF THE WINDOW
      // EVER BECOMES INJECTABLE and this row injects a shorter one to stop paying
      // the 30 s, this pin must be DERIVED from the same resolved value the
      // deadline uses — never re-typed. A seam that feeds the deadline but not
      // the prose leaves the refusal saying "within 30s" while the window was 1s;
      // this pin would then go red for exactly the right reason, and the tempting
      // "fix" would be to edit the 30s here, which restores the drift as a GREEN
      // test. That coupling — one resolved value, both consumers — is the
      // condition on which a seam is safe at all, and it is recorded at this line
      // because this pin is where a violation of it would surface.
      assert.match(String(r.error || ''), /did not reach a terminal state within 30s/,
        'the refusal must name the terminal window it exceeded — ' + why + ' — error: ' + r.error);
    },
  },
  {
    // THE KNOWN GATE GAP — the DETAIL-surface counterpart of the list-surface
    // counter pins, and the row that closes the pair the control
    // above opens. The control says a READABLE, well-formed, non-terminal record
    // must still count as a read. This row says the other side: a body that is
    // NOT A RECORD must not count as one either. Its sibling
    // `goal-stray-list-body-unreadable` was the same defect class on the other
    // surface and has already been fixed; this one has not.
    //
    // Today it does, because pollRun's predicate is PARSE-level — `parsed = true`
    // on any successful `res.json()` — so `{ok:true}` is counted, `run` becomes
    // `{ok:true}`, `st` is undefined, no status is ever read, and the window
    // closes as `run-timeout`: "the run did not reach a terminal state". That is
    // a claim about the WORK, sealed FAILED, for a record we never obtained —
    // the exact vocabulary error OUTCOME_UNKNOWN_CODES exists to prevent.
    //
    // THE EXPECTED CODE IS NOT A GUESS. The DETAIL READER IN THE SAME FILE
    // already classifies this exact body, and its comment names it:
    //   lib/goal.js:241-246 (fetchRunDetail) — "A record that does not name
    //   itself cannot be the run we asked for … This subsumes the
    //   proxy/health-envelope case: {ok:true} and {status:'completed'} carry no
    //   id and are INVALID here rather than FOUND with a fabricated id."
    // INVALID maps to `evidence-invalid` (READ_REJECTION_REASON), which is a
    // member of OUTCOME_UNKNOWN_CODES, so the verdict is UNKNOWN. The poll is the
    // only one of the two readers of this endpoint that has not adopted the
    // classification its sibling already applies to the same bytes.
    //
    // ONE MECHANISM NOTE, because it changes the size of the fix: pollRun's
    // vocabulary is `terminal | timeout | unavailable` and it does NOT consume
    // READ_REJECTION_REASON. So the fix is not only a stricter predicate — the
    // poll needs an INVALID outcome and the caller (lib/goal.js, the poll's
    // result branch) needs a branch mapping it to a throw carrying
    // `evidence-invalid`. Both halves are boundary's, and both are small.
    //
    // RED TODAY, and it stays red until that lands. The non-vacuity pair below
    // proves the poll was reached through a REAL adoption, so a red here cannot
    // be satisfied by a discovery failure that never polled.
    //
    // IT PAIRS WITH THE CONTROL ABOVE, AND THE PAIR IS THE CONTRACT. That row
    // serves a well-formed, non-terminal RECORD and must NOT produce
    // `evidence-invalid` — it names that code in its own `mustNot` — while this
    // row serves a NON-RECORD and must. Read together they pin the predicate from
    // both sides: a read is a read iff the body is a usable record, and neither
    // "it parsed" nor "it carried a status" decides it alone. That is why the
    // control's `mustNot` already named `evidence-invalid` before this row
    // existed — the boundary was stated, and only one half of it had a witness.
    //
    // NOT IN #64's FLIP SET, and this is why: no existing row serves a
    // non-record body to pollRun. `goal-poll-run-unavailable` serves 500s after
    // its adoption read and `goal-poll-run-not-terminal` serves a well-formed
    // record forever, so the flip set for the predicate change is EMPTY today and
    // no existing row's meaning moves when it lands. boundary's KNOWN RESIDUAL
    // names `{run:null, events: []}` as the hazard — that shape would flip — and
    // this row deliberately does not use it.
    row: 'goal-poll-run-not-a-record',
    dimension: 'terminal-state poll (pollRun), a 200 body that is not a run record',
    what: 'the run is adopted, then every terminal-state poll answers 200 with `{ok:true}` — a non-record we could not read a status from — so the refusal must be an unreadable-record refusal with verdict UNKNOWN, never "the run did not reach a terminal state" with verdict FAILED',
    code: 'evidence-invalid',
    verdict: 'UNKNOWN',
    // `run-timeout` first: it is the specific wrong answer today, and the one
    // that blames the capability for our own inability to read the record.
    mustNot: ['run-timeout', 'archon-unavailable', 'run-not-found', 'workflow-name-mismatch'],
    assertExtra: (r, why) => {
      // Same pair as the control: the run was ADOPTED and THEN polled. Without
      // it a refusal could come from a discovery that never reached the poll and
      // the row would prove nothing about the poll's predicate.
      assert.equal(r.adoptionMode, 'dispatch-provided',
        'the row must reach the poll through a real adoption, not through a discovery failure — '
        + why + ' — got: ' + JSON.stringify(r));
      assert.equal(r.runId, 'run-goal-not-record',
        'the adopted run id must be carried onto the attempt before the poll — '
        + why + ' — got: ' + JSON.stringify(r));
      assert.doesNotMatch(String(r.error || ''), /did not reach a terminal state/i,
        'a body we could not read a status from must never be reported as a run that did not finish — that '
        + 'sentence asserts the run was READ and simply never terminated — ' + why + ' — error: ' + r.error);
    },
  },
  {
    row: 'goal-detail-invalid',
    dimension: 'dispatch-token detail read (discoverRun none-branch, INVALID)',
    what: 'the dispatch names a run id whose detail read is INVALID — the body carries no run id — so a run we hold an id for DID appear and its record could not be used as evidence',
    // The typed rejection says INVALID, so the none-branch must DERIVE
    // evidence-invalid. Reporting run-not-found here would be a claim of ABSENCE
    // about a run whose id we hold: the absence is exactly what was not
    // established, and run-not-found licenses the retry that could double-run a
    // workflow that may be alive.
    code: 'evidence-invalid',
    verdict: 'UNKNOWN',
    mustNot: ['run-not-found', 'workflow-name-mismatch', 'archon-unavailable', 'run-timeout'],
    assertExtra: (r, why) => {
      assert.doesNotMatch(String(r.error || ''), /no run appeared/i,
        'an INVALID record must never be reported as "no run appeared" — a run we hold an id for DID appear — '
        + why + ' — error: ' + r.error);
      assert.match(String(r.error || ''), /could not be admitted|not usable as evidence/i,
        'the refusal must name the record it could not use as evidence — ' + why + ' — error: ' + r.error);
      // The derivation is recorded on the attempt, so a reader can see WHICH
      // typed outcome produced the code rather than trusting the prose.
      assert.equal(r.discovery && r.discovery.unreadableCode, 'evidence-invalid',
        'the attempt must record the DERIVED code — ' + why + ' — discovery: ' + JSON.stringify(r.discovery));
      assert.deepEqual(r.discovery && r.discovery.unreadableRuns, ['run-goal-invalid'],
        'the attempt must record WHICH run was unreadable — ' + why + ' — discovery: ' + JSON.stringify(r.discovery));
    },
  },
  {
    row: 'goal-detail-unavailable',
    dimension: 'dispatch-token detail read (discoverRun none-branch, UNAVAILABLE)',
    what: 'the dispatch names a run id and every post-dispatch detail read returns 500 — an outage during discovery, never an absence',
    // Same branch as the INVALID row, opposite typed outcome: an outage
    // DOMINATES a bad record, so the derived code is archon-unavailable.
    code: 'archon-unavailable',
    verdict: 'UNKNOWN',
    mustNot: ['run-not-found', 'workflow-name-mismatch', 'run-timeout'],
    assertExtra: (r, why) => {
      assert.doesNotMatch(String(r.error || ''), /no run appeared/i,
        'an unreadable record must never be reported as "no run appeared" — the absence is what could not be established — '
        + why + ' — error: ' + r.error);
      assert.match(String(r.error || ''), /could not be admitted|unreadable/i,
        'the refusal must name the read that never completed — ' + why + ' — error: ' + r.error);
      assert.equal(r.discovery && r.discovery.unreadableCode, 'archon-unavailable',
        'the attempt must record the DERIVED code — ' + why + ' — discovery: ' + JSON.stringify(r.discovery));
      assert.deepEqual(r.discovery && r.discovery.unreadableRuns, ['run-goal-detaildown'],
        'the attempt must record WHICH run was unreadable — ' + why + ' — discovery: ' + JSON.stringify(r.discovery));
    },
  },
];

// Spawn one goal-level row in its own process and parse the LAST stdout line as
// its JSON result (the protocol of test/conversation-case.mjs).
async function runGoalRow(rowName, timeoutMs) {
  const childHome = await mkdtemp(join(tmpdir(), 'opui-admission-goal-'));
  goalHomes.push(childHome);
  const child = spawn(process.execPath, [join(HERE, 'run-admission-goal-case.mjs'), rowName, childHome], {
    cwd: join(HERE, '..'),
    env: { ...process.env, DSH_HOME: childHome },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('goal row ' + rowName + ' timed out after ' + timeoutMs + 'ms\nstderr: ' + err));
    }, timeoutMs);
    child.on('exit', (c) => { clearTimeout(t); resolve(c); });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
  });
  assert.equal(code, 0, 'goal row ' + rowName + ' exited ' + code + '\nstderr: ' + err);
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

test('goal-level rows: a read that fails below discovery is never reported as an answer', { concurrency: 2 }, async (t) => {
  // The fixture and the matrix must agree in BOTH directions, and only one of
  // them fails loudly on its own. A matrix entry with no fixture row exits the
  // child non-zero ("unknown goal row") and is caught by the exit-code assert
  // below; a FIXTURE row with no matrix entry simply never runs, and the count
  // at the end still balances because it counts matrix entries. So the silent
  // direction is asserted here.
  const fixtureGoalRows = FIXTURES.goalLevel.rows.map((r) => r.name);
  const matrixGoalRows = new Set(GOAL_MATRIX.map((m) => m.row));
  assert.deepEqual(fixtureGoalRows.filter((n) => !matrixGoalRows.has(n)), [],
    'goal fixture rows with no GOAL_MATRIX entry — they would never run, and nothing else here would notice');

  const observed = [];

  await Promise.all(GOAL_MATRIX.map((m) => t.test(m.dimension + ' — ' + m.row, async (inner) => {
    const r = await runGoalRow(m.row, 90000);
    // Recorded HERE, before any assertion: "observed" means the child RAN and
    // produced a result, which is the only thing that can make a row's absence
    // a skip. A row that ran and FAILED its assertions is not a skipped row, and
    // counting it after the assertions would mislabel the one deliberately red
    // row as a skip instead of a failure.
    observed.push(m.row);
    const why = m.what;
    inner.diagnostic('observed: ' + JSON.stringify({
      verdict: r.verdict,
      failureCodes: r.failureCodes,
      error: r.error,
      runId: r.runId,
      adoptionMode: r.adoptionMode,
      discovery: r.discovery,
      reads: r.reads,
    }));
    inner.diagnostic('what: ' + why);

    assert.equal(r.ok, true, m.row + ': the goal path threw instead of resolving — ' + JSON.stringify(r.error));
    // The EXACT verdict, per row. UNKNOWN and FAILED are different claims — "we
    // could not establish the outcome" versus "the work failed" — and a row that
    // asserted only that a verdict exists would pass on either. The row's `what`
    // is carried into the message so a red row explains itself without the
    // reader having to go find the entry.
    assert.equal(r.verdict, m.verdict,
      m.row + ': must refuse with verdict ' + m.verdict + ' — ' + why + ' — got: ' + JSON.stringify(r));
    assert.notEqual(r.verdict, null, m.row + ': a refusal must carry a verdict, never null');

    // The failure code may appear at the goal level or on the attempt (the goal
    // path records it on both); either is the same refusal.
    const codes = [...(r.failureCodes || []), r.attemptFailureCode].filter(Boolean);
    for (const bad of m.mustNot) {
      assert.ok(!codes.includes(bad),
        m.row + ': the outage was dressed up as "' + bad + '" — preventing exactly this is the reason this row exists — codes: ' + JSON.stringify(codes));
    }
    assert.ok(codes.includes(m.code),
      m.row + ': must name "' + m.code + '" — named: ' + JSON.stringify(codes) + ' — ' + why);

    m.assertExtra(r, why);
  }).catch(() => { /* recorded by the runner; the parent still fails */ })));

  // Guards against a silently skipped row making the assertions vacuous. It
  // counts rows that PRODUCED A RESULT, not rows that passed — a row that ran
  // and failed must read as a failure with its own name, never as a missing row.
  assert.equal(observed.length, GOAL_MATRIX.length, 'every goal row must be observed');
});
