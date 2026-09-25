// dsh-operator-ui — ONE terminal-status rule for the family.
//
// "Which statuses mean the run is finished" — and its twin, "is this run still
// going" — was answered independently at every read site. The sites VERIFIED BY
// READING, with the direction each one chose. RUN STATUSES ONLY — the envelope
// `status` vocabulary is a separate thing that shares the field name, noted
// below:
//
//   lib/goal.js       pollRun        DENY-list  {running, queued, pending}   raw
//   lib/goal.js       trustLadder    DENY-list  {running, queued, pending}   raw
//   lib/verify.js     probeA         DENY-list  {running, queued, pending}   raw
//   lib/acquire.js    run-list       ALLOW-list [completed, failed, error, cancelled] lowercased
//   lib/flowrouter.js run-list       ALLOW-list [completed, failed, error, cancelled] lowercased
//   lib/teach.js      runWorkflow    ALLOW-list [completed, failed]          raw
//   lib/activity.js   feed           ALLOW-list [completed, failed, cancelled, canceled, blocked] raw
//   lib/tasks.js      envelopeFromRun IN-FLIGHT {running, queued, pending} -> 'running' else 'closed'
//   lib/client.js     deriveLadder   DENY-list  {running, queued, pending}   raw (see below — cannot import)
//
// lib/client.js IS A SPECIAL CASE, and it must NOT be "fixed" by importing this
// module: client.js is served as a DSH ModuleLoader bundle whose `require` is
// limited to seeded externals (react), so it has no ESM imports at all.
//
// Its local deny-list is guarded by client.js's OWN `deriveLadder`
// (client.js:2315-2316 — NOT goal.js's `trustLadder`; the two are separate
// functions and confusing them is the error this sentence exists to prevent):
// the local list runs only when the served envelope carries no numeric
// `trust.index`. DO NOT READ THAT AS "DORMANT". It is dormant only for
// envelopes goal.js SEALS — goal.js sets a numeric trust at construction and
// overwrites it on both the success and catch paths, then seals. For every
// OTHER row it is the SOLE ladder authority in the system, and that is the
// normal shape of a run this process did not create: lib/tasks.js's
// `envelopeFromRun` (the reconstruction path) builds a `kind:'goal'` envelope
// with NO `trust` and NO `nextAction` key at all, `listTasksRead` projects
// EVERY Archon run through it, and lib/index.js serves that list as `goals` at
// the /goal route. A run from another client, a wiped cache, a failed upsert,
// or a silent hydrate failure all land there.
// AND THOSE ROWS PERSIST, which makes this worse than a serving-time
// population: three call sites write a merged task back, and when there is no
// cached envelope the merged task IS the projection — lib/index.js's
// workspace-binding upsert (`upsertTask({ ...task, workspace })` over a
// `getTask` that returned the projection), lib/tasks.js's `if (recon.appended)
// await upsertTask(merged)` where `mergeTask` returns the projection itself
// when the cache is empty, and lib/reconcile.js's mutation of
// `task.reconciliation` on that same object, which is what makes `appended`
// true. So a trust-less envelope enters tasks.json and survives a restart.
// So the deny-list IS reachable, and client.js:2322 is the only rung-1
// authority those rows have — rung 2 additionally needs a `terminal-status`
// check and rung 3 an `objective-satisfaction` check, and `envelopeFromRun`
// sets `checks: []`, so only rung 1 is reachable at all.
//
// The absence of a DIVERGENCE still holds — those rows have no host ladder to
// diverge from — but "dormant" and "reachable" are different claims. The chosen
// remedy is therefore neither a hand-maintained mirror nor a mandatory field,
// but re-deriving trust/nextAction for envelopes lacking a trustworthy numeric
// trust.index. It is NOT one site in goal.js: the /goal surface serves through
// the STORE — `listTasksRead()` and `getTaskRead(id)`, both in lib/tasks.js — so
// the re-derivation has TWO async callers. It also cannot live in tasks.js by
// importing goal.js's `trustLadder`, because goal.js already imports from
// tasks.js and the reverse edge is a CYCLE; this repo has been burned by a
// link-time failure of exactly that shape (acquire.js:226-235). Two clean
// placements. BOTH close the client branch, because client.js:2316 returns any
// numeric index regardless of which module produced it — so the choice is not
// "does the client defect survive" but HOW MANY IMPLEMENTATIONS of the rule
// remain: (a) index.js's response shaping, which adds a THIRD site, since
// goal.js still computes the ladder for sealed envelopes and the client copy
// merely stops executing — and whose coverage is an ENUMERATION claim, verified
// only for handleGoal's two serving sites: if any other route, or any other
// record type rendered by the same component, reaches `deriveLadder`, then (a)
// does not cover that path and the branch is live there; or (b) a third module
// both import, with goal.js's trustLadder consuming it too, which leaves the
// rule ONCE. (b) is preferred because it REMOVES a duplicate implementation
// rather than adding a call to one — and, more decisively, because (b) and the
// form below place the ladder where the row is PRODUCED, so their coverage does
// not depend on anyone having enumerated the routes correctly. Enumeration is
// the method that has failed repeatedly in this census (see the failure modes
// above), which is the whole reason this file prefers structural placement over
// per-call-site steps. A stronger form of (b): have
// `envelopeFromRun` itself attach a numeric trust, so every reconstructed row
// carries a ladder BY CONSTRUCTION and no serving-site call is needed at all
// (structural, rather than a per-call-site step a future route can forget). It
// carries the same never-freeze rule, at the producer instead of the server:
// that projection is one of the three things written back and persisted, and a
// later `mergeTask` unioning `checks`/`attempts` onto it would leave a frozen
// rung 1 that its fields no longer justify.
// And it must backfill ON THE WAY OUT without freezing: lib/tasks.js caches back
// whatever the serving path returned, and every guard prefers a numeric index,
// so re-deriving on the returned object would make the fix happen once and then
// stick — the very stale-snapshot defect it is meant to remove.
// Recorded here because this census's first version missed client.js entirely,
// and because the next reader's instinct will be to make it import this file —
// which cannot work.
//
// client.js ALSO CARRIES A PRESENTATION-LAYER FAMILY that classifies the same
// field, in at least four FORMS, and none of them is a row in the table above:
// a literal map (`WF_DOT`, run status -> dot class, unrecognised -> 'idle'), a
// chained equality (`runObj.status === 'completed' ? ... : === 'failed'`, and
// the same shape on `attempt.status` in the composer's Execution stage), the
// `done ? '\u2713' : failed ? '\u2717' : ''` glyph suffix that reads off it, and
// TaskRow's dot ternary, which recognises 'failed'/'completed'/'running' and
// sends EVERYTHING ELSE — a cancelled run, a teaching row's 'promoted', a goal
// row's 'awaiting-approval' — to the same neutral 'idle'. (Session rows are
// classified by a different helper over a different vocabulary and domain —
// `rowStatus`, attention/running/done/blank/idle — named here only so it is not
// mistaken for one of the four forms above.)
// Named by FORM rather than by site, because a site list is the part that goes
// stale. They are recorded here so the table's SCOPE is explicit: "nine sites"
// means nine sites that CLASSIFY A RUN STATUS TO SEAL SOMETHING, and a later
// reader must not read it as "every site that touches this field". The
// distinguishing question is whether the classification SEALS a verdict. These
// do not: they pick a colour or a glyph, an unrecognised status renders neutral
// rather than as finished, and the verdict they decorate comes from elsewhere.
// A colour is not a verdict — which is also why they are not rows: counting
// them would inflate the table with sites that cannot produce this defect, and
// omitting them silently would be the omission failure again.
//
// A SECOND VOCABULARY, SAME FIELD NAME — a trap, not a reader. lib/tasks.js
// writes an ENVELOPE `status` from a different input at two producers:
// `envelopeFromGoal` (sealed envelopes) maps `awaiting-approval` /
// `goal.verdict === 'PENDING' -> 'running'` / else `'closed'`; `envelopeFromRun`
// (reconstructed rows) maps an in-flight RUN status -> `'running'` else
// `'closed'`. So the durable envelope vocabulary is {running, closed,
// awaiting-approval} and TWO of its three members appear in NEITHER set defined
// here. The field is named `status` in both vocabularies, which is the trap:
// `isTerminalRunStatus` applied to an envelope status answers a question nobody
// asked. No reader has been found that does this, and it cannot be ruled out —
// searching was unavailable in this environment — so the rule is stated rather
// than assumed: THIS MODULE CLASSIFIES RUN STATUSES ONLY.
//
// FOUR sites share the deny-list character for character (goal.js twice,
// verify.js, client.js); acquire.js and flowrouter.js share an identical
// four-member allow-list; teach.js and activity.js each have their own. Case
// handling splits the family in half: 'RUNNING' is TERMINAL to the four raw
// deny-lists and IN-FLIGHT to acquire.js and flowrouter.js, which lowercase. The
// same record gets two answers, and which one you get depends on which file
// read it.
//
// THE CONSUMER HALF is a longer list — sites asking what a terminal status
// MEANS rather than when to stop reading: goal.js's `execution.completed`,
// `validateCapability` and `deriveGoalVerdict`; verify.js's `runStatus !==
// expect.terminalStatus` and `runObj.status === 'failed'`; acquire.js's
// `run.status === 'completed'` gates; teach.js's `pass`; task-truth.js's
// `projectTaskFromRun`; and tasks.js's `envelopeFromRun` verdict chain.
// Consumers compare RAW unless noted; `normaliseRunStatus` is their shared
// answer.
//
// THIS TABLE IS A RECORD OF WHAT WAS READ, NOT A PROOF OF COMPLETENESS, and it
// deliberately carries NO TALLY of its own corrections — the tally was itself
// the defect, because a number that tracks an open-ended process goes stale on
// the next correction and then has to be corrected too. The FAILURE MODES are
// what matter, and every one of them has appeared here:
//   * a reader adopted the rule after the table was written (twice);
//   * a file was never opened at all (lib/flowrouter.js);
//   * a file was found by a different agent, reading outside this census
//     (lib/client.js);
//   * a claim about a serving PATH was carried from another agent's report
//     instead of opened — which is why "name the symbol, not the line" fixed
//     the line-number half of the problem and not this half;
//   * a sentence TRUE OF ONE POPULATION was read as true of all of them
//     (envelopes this process seals, vs every envelope served or stored).
// The last two share a shape with a silently-empty search result, which is what
// this environment does to every search: an ABSENCE that reads as a FINDING.
// So treat the table as a starting point, enumerate before relying on it, and
// name the site you actually read. The durable fix is a source scan over every
// lib/*.js that fails when a new reader appears; it is deliberately NOT written
// yet, because a pattern nobody can run is a pattern nobody can calibrate, and
// an uncalibrated guard is a false red waiting to happen.
//
// ADOPTION IS NOT TRACKED HERE. Which readers use this module is asserted in
// test/run-terminal-status.test.mjs — a list in this header goes stale the
// moment the next reader lands, and it did, twice.
//
// THE DIRECTION IS ALLOW-LIST, because only one direction is consistent with
// the rule every read site here is built on: "a record we cannot classify is
// not a run we know finished". The deny-list was fail-safe for a MISSING status
// (`st &&` kept polling when st was falsy) and FAIL-OPEN for an UNRECOGNISED
// one: any truthy status outside the three in-flight states — 'in_progress',
// 'Running', 'succeeded' — was read as FINISHED, so a live run's partial
// evidence was validated and a verdict sealed on it. That is a verdict derived
// from a status we did not understand, which is the class this effort removes.
//
// THE ASYMMETRY DECIDES IT. A new IN-FLIGHT status mis-read as terminal is
// SILENT: partial evidence is evaluated, FAILED/BLOCK is sealed on a run that
// may still be running, and nothing in the output says we guessed. A new
// TERMINAL status mis-read as in-flight is LOUD: the poll reaches its named
// window and refuses with "evidence insufficient, level not claimed" — a
// non-claim, not a false claim about the work. A loud non-claim beats a silent
// false verdict.
//
// COST, stated: a genuinely new terminal status polls to the reader's window
// and reports a timeout until it is added here. That is the conservative
// direction, and the same trade the list readers already accept with
// `{"runs": []}` — an answered-but-unrecognised shape is not read as an answer.
//
// CASE-NORMALISED because a status is an identifier, not prose: 'Running' is
// 'running'. Normalisation never PROMOTES an in-flight status (the three
// in-flight states are not in the set in any casing) — it only stops the same
// record from getting two answers.
//
// MEMBERSHIP is the deliberate part, and every member is here so that no reader
// LOSES a status it already treated as terminal: 'completed' and 'failed' are
// what Archon emits today; 'error' and 'cancelled' are acquire.js's; 'canceled'
// (the other spelling) and 'blocked' are activity.js's. The set is therefore
// the union of the five readers' existing answers, which is what makes the
// unification move NO existing fixture row: only 'completed', 'failed' and
// 'running' are ever driven through these readers, and all three classify
// identically before and after (enumerated in the #67 report; the empty flip
// set is asserted in test/run-terminal-status.test.mjs).
//
// A reader that wants a DIFFERENT answer for one of these statuses must say so
// at its own call site, in a comment — not by growing a second local set.

// The three in-flight states. Named separately from the terminal set because
// the two are not complements: an unrecognised status is NEITHER, which is the
// whole point (it keeps polling; it is not read as finished). A reader that
// needs "is this still going" must ask THIS set, never `!isTerminal(...)` —
// negation would answer `true` for an unrecognised status, which is the exact
// defect this module exists to stop.
export const IN_FLIGHT_RUN_STATUSES = new Set(['running', 'queued', 'pending']);

export const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'error', 'cancelled', 'canceled', 'blocked']);

// The normalisation, named and exported rather than inlined at each call site,
// because the rule has TWO halves and a reader that normalises the lookup while
// comparing RAW still gives two answers for one record. A reader that judges a
// status against a declared expectation must compare `normaliseRunStatus(a) ===
// normaliseRunStatus(b)`.
//
// Compare NORMALISED, never rewrite the RECORD: a run record's `status` is
// evidence and must be recorded exactly as it was read (the receipt and the
// evidence hash carry it verbatim). Normalise at the comparison, not at the
// read.
//
// `?? ''`, never `|| ''`. `||` collapses every falsy-but-PRESENT value into the
// absent case, so a status of `0` normalised to `''` — indistinguishable from
// `null`, `undefined`, or a missing field. That is the module's own defect class
// applied to itself: a present-but-unusual status reported as absent. Absence is
// exactly what `''` has to keep meaning here, because callers use it to tell
// "no status was read" from "a status was read and it is not terminal".
export const normaliseRunStatus = (st) => String(st ?? '').toLowerCase();

export const isTerminalRunStatus = (st) => TERMINAL_RUN_STATUSES.has(normaliseRunStatus(st));
