// RC read-outcomes: an unreadable Archon read must never be reported as
// absence, as a failed execution, or as a candidate's fault.
//
// The defect under test collapsed distinguishable failure conditions into one
// value, so an Archon OUTAGE became a false statement about the work:
//   * lib/teach.js   — `catch { /* keep polling */ }` + `throw run-not-found`
//     turned a discovery outage into "dispatch accepted but no run appeared",
//     which the _teach catch then sealed as a REFUSED teaching verdict (and
//     burned the rest of the eval budget).
//   * lib/acquire.js — `catch { return null }` + `if (!entry) return NO_RUN`
//     + `try { detail } catch {}` turned an outage into "your candidate
//     failed": a consumed revision and a refusal that blamed the wrong party.
//
// Deterministic: a local stub Archon (ephemeral port, never a fixed 137xx) is
// faulted per case, so this file is immune to concurrent load. The assertions
// are the invariant, not the implementation:
//   * an outage does NOT produce run-not-found
//   * an outage does NOT increment the revision counter
//   * an outage does NOT blame the candidate, and never promotes
//   * an outage is BOUNDED across invocations — a permanent one reaches a
//     terminal, non-capability-verdict state instead of retrying forever
// A positive control (a genuine failed run) proves the attribution path is
// still live — the fix distinguishes outcomes, it does not disable judgement.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------- stub Archon
//
// One server, two surfaces: the model endpoint (/responses, endpoint-mode
// cognition) and the Archon HTTP API the two modules read. Every fault is
// armed per test through `state`; nothing here touches a real Archon.
const state = {
  listFails: false,            // GET /api/workflows/runs answers 500
  dispatchMaterializes: false, // POST …/run mints a run row
  runStatus: 'failed',         // status of a minted run row
  detailFails: false,          // GET …/runs/:id answers 500
  detailInvalid: false,        // GET …/runs/:id answers unparseable JSON
  dispatchStatus: 0,           // non-zero: POST …/run answers this HTTP status
  dispatchInvalid: false,      // POST …/run answers 200 with an UNPARSEABLE body
  detailEvents: [],            // node_output events the detail read returns
  modelCalls: 0,
  runSeq: 0,
  dynamicRuns: [],
  dispatchPosts: 0,
};

function resetState(over) {
  state.listFails = false;
  state.dispatchMaterializes = false;
  state.runStatus = 'failed';
  state.detailFails = false;
  state.detailInvalid = false;
  state.dispatchStatus = 0;
  state.dispatchInvalid = false;
  state.detailEvents = [];
  state.modelCalls = 0;
  state.runSeq = 0;
  state.dynamicRuns = [];
  state.dispatchPosts = 0;
  Object.assign(state, over || {});
}

// A valid candidate the static gate accepts (name format, nodes list, RESULT
// contract, expectation marker matching the name). Call N returns revision N-1
// so the loop's revision path stays exercisable and never byte-identical.
function modelReply() {
  const n = state.modelCalls;
  const name = n === 1 ? 'outage-probe-v0-1-0' : 'outage-probe-r' + (n - 1) + '-v0-1-0';
  const yaml = [
    'name: ' + name,
    'description: outage-attribution probe',
    'nodes:',
    '  - id: n1',
    '    bash: echo RESULT probe=ok; echo learned-' + name + ':done',
  ].join('\n');
  const text = '```yaml\n' + yaml + '\n```\n\n```json\n{"description":"outage-attribution probe","tags":["probe","outage"]}\n```';
  return { output: [{ type: 'message', content: [{ text }] }], usage: { output_tokens: 10 } };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (body, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const p = url.pathname;

  if (p === '/responses' && req.method === 'POST') {
    state.modelCalls += 1;
    return json(modelReply());
  }
  const dispatch = p.match(/^\/api\/workflows\/([^/]+)\/run$/);
  if (dispatch && req.method === 'POST') {
    state.dispatchPosts += 1;
    if (state.dispatchStatus) return json({ error: 'the workflow was rejected by archon' }, state.dispatchStatus);
    // 200 with a body this client cannot parse — the third condition: Archon
    // ANSWERED, so it is neither unreachable nor a refusal.
    if (state.dispatchInvalid) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"accepted": '); }
    if (state.dispatchMaterializes) {
      state.runSeq += 1;
      state.dynamicRuns.unshift({
        id: 'run-stub-' + state.runSeq,
        workflow_name: decodeURIComponent(dispatch[1]),
        status: state.runStatus,
        user_message: '',
      });
    }
    return json({ accepted: true, status: 'started' });
  }
  if (p === '/api/workflows/runs' && req.method === 'GET') {
    if (state.listFails) return json({ error: 'archon down' }, 500);
    return json({ runs: [...state.dynamicRuns] });
  }
  const detail = p.match(/^\/api\/workflows\/runs\/([^/]+)$/);
  if (detail && req.method === 'GET') {
    if (state.detailFails) return json({ error: 'archon down' }, 500);
    if (state.detailInvalid) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"run": '); }
    const id = decodeURIComponent(detail[1]);
    const row = state.dynamicRuns.find((r) => r.id === id) || { id, status: state.runStatus };
    return json({ run: row, events: state.detailEvents });
  }
  if (p === '/api/workflows') return json({ workflows: [] });
  res.writeHead(404); res.end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

// ------------------------------------------------------------------- fixture
//
// One isolated $DSH_HOME for the whole file: a config pointing every Archon /
// model read at the stub, absolute teaching paths, and a registry path (teach
// refuses NOT_CONFIGURED without one). Budgets are tightened to 1 revision so
// the positive control terminates quickly.
const home = await mkdtemp(join(tmpdir(), 'opui-outage-'));
process.env.DSH_HOME = home;
process.env.ACQ_TEST_KEY = 'stub-key';
// mkdtemp, not mkdir: both directories only need to EXIST as absolute writable
// paths, and a unique-per-run directory is exactly what this fixture wants.
// It also sidesteps an environmental fragility: under the agent sandbox a bare
// recursive mkdir was denied (CODEBUDDY_BROKER_DENY) and the same command later
// hung for 11 minutes — the fixture was unrunnable, not red. Do not read this as
// a workaround that makes the suite runnable in a sandbox: the sandbox later
// failed closed for EVERY command, including `echo`. The suite has to be run
// from an unsandboxed shell (see ~/bin/rcos-verify-frozen).
const wfDir = await mkdtemp(join(home, 'wf-'));
const wsDir = await mkdtemp(join(home, 'ws-'));
const registryPath = join(home, 'registry.json');
await writeFile(registryPath, JSON.stringify({ capabilities: [] }, null, 2) + '\n');
await writeFile(join(home, 'operator-ui.config.json'), JSON.stringify({
  archon: { baseUrl: 'http://127.0.0.1:' + PORT, timeoutMs: 500 },
  registry: { path: registryPath },
  teaching: { workflowsDir: wfDir, workspaceDir: wsDir },
  acquisition: {
    mode: 'endpoint',
    endpoint: 'http://127.0.0.1:' + PORT,
    model: 'stub',
    apiKeyEnv: 'ACQ_TEST_KEY',
    budget: { maxRevisions: 1 },
  },
}, null, 2) + '\n');

const { upsertTask } = await import('../lib/tasks.js');
const { teachRCOS, INFRA_ATTEMPT_LIMIT: TEACH_LIMIT } = await import('../lib/teach.js');
const { acquireCapability, INFRA_ATTEMPT_LIMIT: ACQ_LIMIT } = await import('../lib/acquire.js');

// A distinct source task per case keeps the derived infrastructure-attempt
// count (which is keyed by sourceTaskId) independent between tests.
const TEACH_SRC = 'task-outage-src';
const TEACH_BOUND_SRC = 'task-teach-bound-src';
const TEACH_DISTINCT_SRC = 'task-teach-distinct-src';
const ACQ_SRC = 'task-acq-src';
const ACQ_BOUND_SRC = 'task-acq-bound-src';
const ABSENT_SRC = 'task-acq-absent-src';
const FAILED_SRC = 'task-acq-failed-src';
// Single-flight (contention) sources: A is the in-flight run, B is the
// overlapping request for a DIFFERENT source, C is the same-source duplicate.
const BUSY_A_SRC = 'task-teach-busy-a';
const BUSY_B_SRC = 'task-teach-busy-b';
const BUSY_C_SRC = 'task-teach-busy-c';
// Fix A/B classification sources: a 4xx dispatch, an answered absence, and a
// source record that makes _teach throw an error it does not classify. Plus the
// THIRD unfair-run condition (#49): a dispatch response Archon answered with but
// this client could not read.
const REJECT_SRC = 'task-teach-reject';
const ABSENT_TEACH_SRC = 'task-teach-absent';
const UNCLASSIFIED_SRC = 'task-teach-unclassified';
const MALFORMED_DISPATCH_SRC = 'task-teach-dispatch-malformed';

// Seed the source envelopes the engines read. getTask() consults Archon and,
// during an outage, serves the cached record marked unavailable — which is
// exactly the path under test, so the seeds must exist in the store first.
async function seedSources() {
  for (const id of [TEACH_SRC, TEACH_BOUND_SRC, TEACH_DISTINCT_SRC, ACQ_SRC, ACQ_BOUND_SRC, ABSENT_SRC, FAILED_SRC, BUSY_A_SRC, BUSY_B_SRC, BUSY_C_SRC, REJECT_SRC, ABSENT_TEACH_SRC, MALFORMED_DISPATCH_SRC]) {
    await upsertTask({
      taskId: id, tasksVersion: 1, kind: 'goal', status: 'closed',
      objective: 'count words in every .txt file in the workspace',
      createdAt: new Date().toISOString(), endedAt: null,
      verdict: { decision: 'FAILED', failureCodes: ['no-route'] }, failureCodes: ['no-route'],
      objectiveEvaluation: { kind: 'output-contains', value: 'RESULT' },
    });
  }
}
await seedSources();

const revisionsOf = (t) => t.attempts.filter((a) => a && a.stage === 'revision').length;

// A prior invocation that ended in an infrastructure outage, as it would sit in
// the durable store. Used to prove the bound is DERIVED across invocations
// rather than reset per invocation.
const priorOutage = (taskId, sourceTaskId, createdAt) => ({
  taskId, tasksVersion: 1, kind: 'teaching', sourceTaskId,
  status: 'unavailable', verdict: 'UNKNOWN',
  outage: { outcome: 'UNAVAILABLE', reason: 'prior outage' },
  attempts: [], evaluations: [], createdAt: createdAt || new Date().toISOString(),
});

async function seedGoalSource(taskId) {
  await upsertTask({
    taskId, tasksVersion: 1, kind: 'goal', status: 'closed',
    objective: 'count words in every .txt file in the workspace',
    createdAt: new Date().toISOString(), endedAt: null,
    verdict: { decision: 'FAILED', failureCodes: ['no-route'] }, failureCodes: ['no-route'],
    objectiveEvaluation: { kind: 'output-contains', value: 'RESULT' },
  });
}

test.after(async () => {
  await new Promise((r) => server.close(r));
  // Best-effort cleanup: a failure here must not turn a behavioural suite red.
  // What was actually observed under the agent sandbox: a bare recursive mkdir
  // was denied (CODEBUDDY_BROKER_DENY) and the same command later hung for 11
  // minutes — so `rm` cannot be assumed permitted either. Deliberately NOT
  // stated as general sandbox policy: the sandbox subsequently failed closed for
  // EVERY command, `echo` included. A leaked temp dir is harmless; a false red
  // is not. In an unsandboxed shell `rm` succeeds and this catch never fires.
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

// ------------------------------------------------------------------- teach.js

test('teach: a discovery OUTAGE is not run-not-found and is not a REFUSED verdict', async () => {
  resetState({ listFails: true, dispatchMaterializes: false });
  const t = await teachRCOS({ sourceTaskId: TEACH_SRC });

  // The dispatch WAS accepted (the write leg worked) — the failure is the read.
  assert.equal(state.dispatchPosts, 1, 'the run was dispatched; the outage is on the read leg');

  // Named as an outage, its own outcome — never "dispatch accepted but no run
  // appeared", never a REFUSED learning verdict.
  assert.equal(t.verdict, 'UNKNOWN');
  assert.notEqual(t.verdict, 'REFUSED');
  assert.equal(t.status, 'unavailable');
  assert.equal(t.outage.outcome, 'UNAVAILABLE');
  assert.match(t.error, /never successfully read/);
  assert.doesNotMatch(String(t.error), /no run appeared/);
  assert.doesNotMatch(String(t.error), /run-not-found/);

  // Unknown + retryable on the first attempt, not "couldn't learn this reliably".
  assert.equal(t.nextAction.kind, 'retry');
  assert.equal(t.infraAttempts, 1);
  assert.equal(t.outage.limit, TEACH_LIMIT);
  assert.equal(t.outage.exhausted, false);
  assert.doesNotMatch(String(t.nextAction.reason), /Not added to Intelligence/);

  // The candidate was composed but never evaluated — no eval budget consumed
  // beyond the case that hit the outage, and no fabricated per-case result.
  assert.ok(t.candidate && t.candidate.capabilityId, 'the candidate was composed before evaluation');
  assert.equal(t.evaluations.length, 0);
});

test('teach: a PERMANENT outage reaches a terminal INSPECT state, never REFUSED', async () => {
  // Two prior teaching invocations for the SAME source ended in an outage: the
  // count must be carried ACROSS invocations (this invocation is the third).
  await upsertTask(priorOutage('teach-prior-a', TEACH_BOUND_SRC, '2026-01-01T00:00:01.000Z'));
  await upsertTask(priorOutage('teach-prior-b', TEACH_BOUND_SRC, '2026-01-01T00:00:02.000Z'));

  resetState({ listFails: true, dispatchMaterializes: false });
  const t = await teachRCOS({ sourceTaskId: TEACH_BOUND_SRC });

  assert.equal(t.infraAttempts, TEACH_LIMIT, 'the count is derived from prior invocations, not reset');
  assert.equal(t.outage.exhausted, true);
  // TERMINAL, and explicitly not a capability verdict.
  assert.equal(t.nextAction.kind, 'inspect');
  assert.equal(t.nextAction.label, 'Inspect Archon availability', 'an outage streak blames availability');
  assert.equal(t.verdict, 'UNKNOWN');
  assert.notEqual(t.verdict, 'REFUSED');
  assert.match(String(t.nextAction.reason), /not a capability verdict/);
  assert.match(String(t.nextAction.reason), /infrastructure attempt/);
  // Still fail-closed: nothing promotable.
  assert.notEqual(t.status, 'candidate');
});

// The DISCRIMINATOR pin. `run-timeout` ("the workflow is slow or broken") and
// `archon-unavailable` ("we could not read") are the two situations the whole
// defect class is about, and until now NOTHING in the suite asserted they stay
// apart — the old text was unprotected and so was the new text.
//
// Deliberately NOT pinning the prose: a brittle prose test gets deleted rather
// than fixed. What is pinned is that the two situations yield DISTINCT,
// non-empty reasons and DISTINCT verdicts — so they cannot collapse back into
// one string, which is the actual invariant.
//
// Note the cost: (b) drives the REAL terminal poll to its real deadline
// (TERMINAL_POLL_MS, 60s). That is intentional — the alternative is a fake
// window, which would pin the fake rather than the behaviour.
test('teach: the run-timeout reason and the archon-unavailable reason stay distinct', async () => {
  // (a) an OUTAGE: the read never succeeds.
  resetState({ listFails: true, dispatchMaterializes: false });
  const outage = await teachRCOS({ sourceTaskId: TEACH_DISTINCT_SRC });
  assert.equal(outage.outage.outcome, 'UNAVAILABLE');
  const unavailableReason = String(outage.error || '');
  assert.ok(unavailableReason.length > 0, 'the archon-unavailable reason is non-empty');
  assert.equal(outage.verdict, 'UNKNOWN', 'an outage is not a capability verdict');

  // (b) a READABLE run that never reaches a terminal state.
  resetState({ listFails: false, dispatchMaterializes: true, runStatus: 'running' });
  const timedOut = await teachRCOS({ sourceTaskId: TEACH_DISTINCT_SRC });
  const timeoutReason = String(timedOut.error || '');
  assert.ok(timeoutReason.length > 0, 'the run-timeout reason is non-empty');

  // Distinct as strings...
  assert.notEqual(timeoutReason, unavailableReason);
  // ...and distinct as verdicts: a readable run that never finishes IS evidence
  // about the candidate, an unreadable read is not.
  assert.equal(timedOut.verdict, 'REFUSED');
  assert.notEqual(timedOut.verdict, outage.verdict);
});

// The single-flight guard, and the two distinguishable conditions it must not
// collapse. The teaching scratch space is FIXED-path (hardcoded workflow name +
// the fixed README fixture), so only one run may be in flight — the guard
// STAYS. What must not happen is that a request for task B is answered with
// task A's envelope, reporting B with A's gap, candidate and verdict. That is
// the read collapse one level out, at the request boundary. And contention is
// NOT a read outage: it gets its own field, never `outage`.
test('teach: a request for a DIFFERENT source while one is in flight is a typed BUSY, never the in-flight envelope', async () => {
  resetState({ listFails: true, dispatchMaterializes: false });

  const pA = teachRCOS({ sourceTaskId: BUSY_A_SRC }); // starts, takes the outage path
  const pB = teachRCOS({ sourceTaskId: BUSY_B_SRC }); // overlaps A, different source

  const rB = await pB; // resolves immediately — B was never run
  assert.equal(rB.blocked && rB.blocked.code, 'teaching-already-in-flight');
  assert.equal(rB.sourceTaskId, BUSY_B_SRC, 'the busy outcome names the REQUESTED source');
  assert.notEqual(rB.sourceTaskId, BUSY_A_SRC, 'it is NOT the in-flight source (not A\u2019s envelope)');
  assert.equal(rB.blocked.inFlightSourceTaskId, BUSY_A_SRC, 'it names WHICH task is blocking');
  assert.equal(rB.verdict, 'UNKNOWN');
  assert.notEqual(rB.verdict, 'REFUSED');
  assert.notEqual(rB.verdict, 'CANDIDATE');
  assert.equal(rB.candidate, null, 'fail-closed: contention never yields a candidate');
  assert.equal(rB.outage, undefined, 'contention is NOT an outage — a different condition in a different field');
  assert.equal(rB.nextAction.kind, 'retry');
  assert.match(String(rB.nextAction.reason), /already running/);

  const rA = await pA; // A really ran
  assert.equal(rA.sourceTaskId, BUSY_A_SRC);
  assert.equal(rA.outage && rA.outage.outcome, 'UNAVAILABLE', 'A took the outage path');
  assert.notEqual(rA, rB, 'B did not receive A\u2019s envelope');
});

test('teach: a request for the SAME source while in flight keeps the dedup', async () => {
  resetState({ listFails: true, dispatchMaterializes: false });

  const q1 = teachRCOS({ sourceTaskId: BUSY_C_SRC });
  const q2 = teachRCOS({ sourceTaskId: BUSY_C_SRC }); // same source, overlapping

  assert.equal(q1, q2, 'the same source returns the in-flight promise, not a new busy outcome');

  const r = await q1;
  assert.equal(r.sourceTaskId, BUSY_C_SRC);
  assert.equal(r.outage && r.outage.outcome, 'UNAVAILABLE', 'the single run really ran');
  assert.equal(r.blocked, undefined, 'a same-source duplicate is not a blocked outcome');
});

// Fix A: the dispatch leg. An HTTP 4xx is Archon ANSWERING and refusing — a
// definitive answer, so it is NOT an outage (no `.outage`) and NOT a capability
// verdict. Because it is not an outage, it genuinely ENDS the streak rather
// than extending it — which is what the second half of this test proves.
test('teach: an HTTP 4xx dispatch is a definitive rejection — UNKNOWN + inspect, and it ends the outage streak', async () => {
  resetState({ listFails: false, dispatchStatus: 400 });
  const t = await teachRCOS({ sourceTaskId: REJECT_SRC });

  assert.equal(t.verdict, 'UNKNOWN');
  assert.notEqual(t.verdict, 'REFUSED', 'a rejected dispatch is not a capability failure');
  assert.equal(t.status, 'dispatch-rejected');
  assert.equal(t.blocked && t.blocked.code, 'dispatch-rejected');
  assert.equal(t.outage, undefined, 'Archon ANSWERED — this is not an outage, so it must not carry `.outage`');
  assert.equal(t.nextAction.kind, 'inspect', 'terminal, not a retry loop');
  assert.notEqual(t.verdict, 'CANDIDATE', 'fail-closed: nothing promotable');
  assert.notEqual(t.status, 'candidate');
  assert.equal(t.evaluations.length, 0, 'no case was evaluated');
  assert.match(String(t.error), /HTTP 400/, 'the operator can read what Archon actually said');

  // The streak must be UNAFFECTED by the rejection: a following outage reports
  // attempt 1, proving Fix B did not silently increment the bound.
  resetState({ listFails: true, dispatchMaterializes: false });
  const next = await teachRCOS({ sourceTaskId: REJECT_SRC });
  assert.equal(next.infraAttempts, 1, 'the rejected dispatch did not extend the outage streak');
  assert.equal(next.outage.outcome, 'UNAVAILABLE');
});

// Fix A: an ANSWERED absence. Archon answered every list read and named no such
// run — the identical condition lib/acquire.js classifies as ABSENT. It is an
// UNFAIR RUN, not a verdict about the capability.
test('teach: an ANSWERED absence (run-not-found) is an unfair run with outcome ABSENT, never REFUSED', async () => {
  resetState({ listFails: false, dispatchMaterializes: false });
  const t = await teachRCOS({ sourceTaskId: ABSENT_TEACH_SRC });

  assert.equal(t.verdict, 'UNKNOWN');
  assert.notEqual(t.verdict, 'REFUSED');
  assert.equal(t.status, 'absent');
  assert.equal(t.outage.outcome, 'ABSENT');
  assert.equal(t.outage.code, 'run-not-found');
  assert.match(String(t.error), /Archon answered and named no such run/);
  assert.notEqual(t.verdict, 'CANDIDATE', 'fail-closed: nothing promotable');
  assert.notEqual(t.status, 'candidate');
  assert.equal(t.evaluations.length, 0, 'no case was evaluated');
  assert.equal(t.nextAction.kind, 'retry', 'an absence is retryable, like acquire.js');
});

// The exhausted label must be DERIVED from the outcome, not a constant. Three
// consecutive ANSWERED absences for one source reach the bound with outcome
// ABSENT — and Archon answered every time, so telling the operator to "inspect
// Archon availability" would be a false statement about the cause. A test that
// asserts only the UNAVAILABLE label would pass against a hardcoded string and
// would not have caught the divergence.
test('teach: the exhausted label is derived — an ABSENT streak names the dispatch path, not Archon', async () => {
  const src = 'task-teach-absent-bound-src';
  await upsertTask({
    taskId: src, kind: 'goal', status: 'closed', objective: 'count words',
    createdAt: new Date().toISOString(), endedAt: null,
    verdict: { decision: 'FAILED', failureCodes: ['no-route'] }, failureCodes: ['no-route'],
  });
  resetState({ listFails: false, dispatchMaterializes: false });

  let last = null;
  for (let i = 0; i < 3; i++) last = await teachRCOS({ sourceTaskId: src });

  assert.equal(last.infraAttempts, 3);
  assert.equal(last.outage.outcome, 'ABSENT');
  assert.equal(last.outage.exhausted, true);
  assert.equal(last.nextAction.kind, 'inspect');
  assert.equal(last.nextAction.label, 'Inspect the dispatch path', 'the label names the ACTUAL cause');
  assert.notEqual(last.nextAction.label, 'Inspect Archon availability', 'Archon answered — availability is not the problem');
  assert.notEqual(last.verdict, 'REFUSED');
});

// #49: the THIRD unfair-run condition. A dispatch response Archon ANSWERED with
// but this client could not read — HTTP 200 with an unparseable body, e.g. a
// proxy serving an HTML error page with a 200. It is not an outage of the read
// leg (Archon was reachable), not a refusal (Archon did not refuse), and never a
// capability verdict. The 200 is the trap: without the `malformed` check first,
// the dispatch ladder falls through `status === null` and `>= 500 || === 429`
// straight to the else branch and calls it `dispatch-rejected`.
test('teach: an unreadable dispatch RESPONSE is MALFORMED — not an outage, not a rejection, never REFUSED', async () => {
  resetState({ listFails: false, dispatchMaterializes: false, dispatchInvalid: true });
  const t = await teachRCOS({ sourceTaskId: MALFORMED_DISPATCH_SRC });

  assert.equal(t.verdict, 'UNKNOWN');
  assert.notEqual(t.verdict, 'REFUSED', 'the candidate never ran — this is not a capability failure');
  assert.equal(t.status, 'malformed');
  assert.equal(t.outage.outcome, 'MALFORMED');
  assert.equal(t.outage.code, 'dispatch-malformed');
  // The 200 trap, asserted directly rather than described: landing in the
  // rejection bucket would name the wrong cause AND silently END the streak.
  assert.equal(t.blocked, undefined, 'Archon did not REFUSE — this is not the dispatch-rejected bucket');
  assert.equal(t.outage.exhausted, false);
  assert.equal(t.infraAttempts, 1, 'an unreadable response counts toward the infra bound');
  assert.equal(t.nextAction.kind, 'retry', 'retryable, like the other unfair runs');
  assert.notEqual(t.verdict, 'CANDIDATE', 'fail-closed: nothing promotable');
  assert.notEqual(t.status, 'candidate');
  assert.equal(t.evaluations.length, 0, 'no case was evaluated');
  assert.match(String(t.error), /could not be read/, 'the operator can read that Archon ANSWERED but unreadably');
});

// ...and it must not be folded into the OUTAGE bucket either, because the
// operator's target differs: for UNAVAILABLE they investigate whether Archon is
// up, for an unreadable dispatch response they investigate what Archon RETURNED.
// That difference is what earns MALFORMED its own label at the bound. It must not
// borrow acquire.js's 'Inspect the run record': there a run DETAIL body was
// unreadable, here the run never appeared, so that pointer would be false.
test('teach: a MALFORMED streak reaches the bound with its OWN label, not availability and not a run record', async () => {
  const src = 'task-teach-malformed-bound-src';
  await upsertTask({
    taskId: src, kind: 'goal', status: 'closed', objective: 'count words',
    createdAt: new Date().toISOString(), endedAt: null,
    verdict: { decision: 'FAILED', failureCodes: ['no-route'] }, failureCodes: ['no-route'],
  });
  resetState({ listFails: false, dispatchMaterializes: false, dispatchInvalid: true });

  let last = null;
  for (let i = 0; i < 3; i++) last = await teachRCOS({ sourceTaskId: src });

  assert.equal(last.infraAttempts, 3);
  assert.equal(last.outage.outcome, 'MALFORMED');
  assert.equal(last.outage.exhausted, true);
  assert.equal(last.nextAction.kind, 'inspect');
  assert.equal(last.nextAction.label, 'Inspect the dispatch response', 'the label names the ACTUAL unreadable object');
  assert.notEqual(last.nextAction.label, 'Inspect Archon availability', 'Archon ANSWERED — availability is not the problem');
  assert.notEqual(last.nextAction.label, 'Inspect the run record', 'no run ever appeared — that pointer would be false');
  assert.notEqual(last.verdict, 'REFUSED');
});

// Fix A: the DEFAULT branch. An error this module does not anticipate must be
// terminal (inspect) and must NEVER be readable as "the capability failed".
// Triggered with DATA, not by mutating the environment: a source record whose
// failureCodes is not an array makes _teach throw a TypeError with no code.
test('teach: an UNCLASSIFIED error is UNKNOWN + inspect, never a REFUSED capability verdict', async () => {
  await upsertTask({
    taskId: UNCLASSIFIED_SRC, kind: 'goal', status: 'closed', objective: 'x',
    createdAt: new Date().toISOString(), endedAt: null,
    verdict: { decision: 'FAILED', failureCodes: 123 }, failureCodes: 123,
  });
  resetState({ listFails: true });
  const t = await teachRCOS({ sourceTaskId: UNCLASSIFIED_SRC });

  assert.equal(t.verdict, 'UNKNOWN');
  assert.notEqual(t.verdict, 'REFUSED', 'an unanticipated error is never a capability verdict');
  assert.equal(t.status, 'unclassified');
  assert.equal(t.nextAction.kind, 'inspect', 'terminal, so it cannot loop');
  assert.match(String(t.nextAction.reason), /not a capability verdict/);
  assert.notEqual(t.verdict, 'CANDIDATE', 'fail-closed: nothing promotable');
  assert.equal(t.evaluations.length, 0, 'no case was evaluated');
});

// ----------------------------------------------------------------- acquire.js

test('acquire: a list-read OUTAGE consumes no revision and does not blame the candidate', async () => {
  resetState({ listFails: true, dispatchMaterializes: true });
  const out = await acquireCapability({ sourceTaskId: ACQ_SRC });
  const t = out.teaching;

  assert.equal(out.ok, true);
  assert.equal(state.dispatchPosts, 1, 'the run was dispatched; the outage is on the read leg');

  // Its own outcome, not a refusal and not a candidate failure.
  assert.equal(t.verdict, 'UNKNOWN');
  assert.equal(t.status, 'unavailable');
  assert.equal(t.outage.outcome, 'UNAVAILABLE');
  assert.equal(t.refusal, undefined, 'an outage is never recorded as a refusal');
  assert.equal(t.candidate, undefined, 'an outage never yields a candidate (fail closed)');

  // Revision counter untouched, no candidate-failure evaluation recorded.
  assert.equal(revisionsOf(t), 0);
  assert.equal(t.evaluations.length, 0);

  // The execute attempt names the outage and carries NO objective evaluation
  // (evaluateObjective is never run on evidence that could not be read).
  const exec = t.attempts.filter((a) => a.stage === 'execute');
  assert.equal(exec.length, 1);
  assert.equal(exec[0].outcome, 'UNAVAILABLE');
  assert.equal(exec[0].objective_eval, null);
  assert.match(String(exec[0].reason), /never successfully read/);

  assert.equal(t.nextAction.kind, 'retry');
  assert.equal(t.infraAttempts, 1);
  assert.equal(t.outage.limit, ACQ_LIMIT);
});

test('acquire: a PERMANENT outage is BOUNDED across invocations and ends terminal (never REFUSED)', async () => {
  resetState({ listFails: true, dispatchMaterializes: true });

  const first = (await acquireCapability({ sourceTaskId: ACQ_BOUND_SRC })).teaching;
  assert.equal(first.infraAttempts, 1);
  assert.equal(first.nextAction.kind, 'retry');
  assert.equal(first.outage.exhausted, false);

  const second = (await acquireCapability({ sourceTaskId: ACQ_BOUND_SRC })).teaching;
  assert.equal(second.infraAttempts, 2, 'the count survives a fresh invocation of the same source');
  assert.equal(second.nextAction.kind, 'retry');
  assert.equal(second.outage.exhausted, false);

  const third = (await acquireCapability({ sourceTaskId: ACQ_BOUND_SRC })).teaching;
  assert.equal(third.infraAttempts, ACQ_LIMIT);
  assert.equal(third.outage.exhausted, true);
  // TERMINAL and NOT a capability verdict — the candidate was never run, so it
  // cannot be judged; the honest terminal needs a human.
  assert.equal(third.nextAction.kind, 'inspect');
  assert.equal(third.verdict, 'UNKNOWN');
  assert.notEqual(third.verdict, 'REFUSED');
  assert.equal(third.refusal, undefined);
  assert.match(String(third.nextAction.reason), /not a capability verdict/);
  // Fail-closed throughout.
  assert.equal(third.candidate, undefined);
  assert.equal(revisionsOf(third), 0);
});

test('acquire: an ANSWERED absence (ABSENT) is named, not collapsed into the outage', async () => {
  resetState({ listFails: false, dispatchMaterializes: false });
  const t = (await acquireCapability({ sourceTaskId: ABSENT_SRC })).teaching;

  // Archon answered every list read and named no run: ABSENT, not UNAVAILABLE.
  assert.equal(t.outage.outcome, 'ABSENT');
  assert.equal(t.status, 'absent');
  assert.equal(t.verdict, 'UNKNOWN');
  assert.match(String(t.outage.reason), /named no such run/);
  assert.equal(t.refusal, undefined);
  assert.equal(revisionsOf(t), 0);
  assert.equal(t.evaluations.length, 0);
  assert.equal(t.candidate, undefined);
});

test('acquire: a REAL outcome ends the outage streak — the bound can reset', async () => {
  // Two outages, then an invocation that reached a real verdict (REFUSED, no
  // outage). The streak must END there, or the bound would be permanent and
  // "N infrastructure attempts" would be a false statement.
  const src = 'task-acq-reset-src';
  await seedGoalSource(src);
  await upsertTask(priorOutage('acq-reset-a', src, '2026-01-01T00:00:01.000Z'));
  await upsertTask(priorOutage('acq-reset-b', src, '2026-01-01T00:00:02.000Z'));
  await upsertTask({
    taskId: 'acq-reset-c', tasksVersion: 1, kind: 'teaching', sourceTaskId: src,
    status: 'failed', verdict: 'REFUSED', refusal: { code: 'REVISIONS_EXHAUSTED' },
    attempts: [], evaluations: [], createdAt: '2026-01-01T00:00:03.000Z',
  });

  resetState({ listFails: true, dispatchMaterializes: true });
  const t = (await acquireCapability({ sourceTaskId: src })).teaching;

  assert.equal(t.infraAttempts, 1, 'a non-outage outcome resets the streak');
  assert.equal(t.outage.exhausted, false);
  assert.equal(t.nextAction.kind, 'retry');
});

test('acquire: a genuine failed run is still attributed to the candidate (positive control)', async () => {
  resetState({ listFails: false, dispatchMaterializes: true, runStatus: 'failed' });
  const t = (await acquireCapability({ sourceTaskId: FAILED_SRC })).teaching;

  // The read succeeded and returned a real terminal run: this IS a candidate
  // failure — evaluation ran, a revision was driven, and the budget refused.
  assert.equal(t.verdict, 'REFUSED');
  assert.equal(t.refusal.code, 'REVISIONS_EXHAUSTED');
  assert.ok(t.attempts.some((a) => a.stage === 'execute' && a.objective_eval), 'objective evaluation ran on real evidence');
  assert.ok(revisionsOf(t) >= 1, 'a real failure still consumes a revision');
  assert.equal(t.evaluations.length >= 1, true);
});
