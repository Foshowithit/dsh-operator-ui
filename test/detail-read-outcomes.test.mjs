#!/usr/bin/env node
// Read-outcome contract test (RC-read-outcomes): `node --test test/detail-read-outcomes.test.mjs`
//
// WHY THIS FILE EXISTS. The defect was that the client collapsed every
// run-detail read failure to `null`, so an AUTHORITATIVE ABSENCE could not be
// told apart from a FAILED READ. lib/goal.js now returns a TYPED outcome
// (NOT_FOUND | UNAVAILABLE | INVALID | FOUND) with a bounded retry. A test that
// only asserted "we did not adopt" would pass against the old code too, so this
// file asserts the things the old code could not produce:
//
//   * `outcome` — three distinguishable results, not one null.
//   * `attempts` — the ONLY observable proving 404/410 are authoritative and do
//     not consume the retry budget, while 500/429/timeout are retried to the
//     bound (see RETRY_BUDGET for why terminal modes assert "below the budget"
//     rather than an exact 1).
//   * `readError` — WHICH branch was taken, so a mode that lands on the right
//     outcome via the wrong leg still goes red.
//
// Every mode is armed on a real mock child (scripts/mock-archon.mjs) over real
// HTTP. Nothing is stubbed: this is the wire-level half of the evidence that
// test/run-admission-harness.test.mjs (portless, in-process) deliberately does
// not cover. The mock's own read counter is cross-checked against the client's
// attempt count, so bounded retry is observed from BOTH ends.
//
// The expectations below are claims about lib/goal.js's current branches, not a
// spec it must satisfy. If a branch moves, they go red on purpose.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_ID = 'run-mock-001';
const WORKFLOW = 'verify-echo-v1';

// Isolate the plugin's own config resolution from any real ~/.dsh on the box.
const HOME = await mkdtemp(join(tmpdir(), 'opui-detail-outcomes-'));
process.env.DSH_HOME = HOME;

const { discoverRun, fetchRunDetail } = await import('../lib/goal.js');

// ---- mock lifecycle (house pattern: probe a free port, retry the lost race) --
async function freePort() {
  const srv = createServer();
  await new Promise((res, rej) => { srv.once('error', rej); srv.listen(0, '127.0.0.1', res); });
  const { port } = srv.address();
  await new Promise((res) => srv.close(res));
  return port;
}

async function startMock({ attempts = 6, readyTimeoutMs = 5000 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = await freePort();
    const base = 'http://127.0.0.1:' + port;
    const proc = spawn(process.execPath, [join(ROOT, 'scripts', 'mock-archon.mjs'), String(port)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    let exited = null;
    proc.on('exit', (code) => { exited = code; });
    const deadline = Date.now() + readyTimeoutMs;
    let ready = false;
    for (;;) {
      if (exited !== null) {
        lastErr = new Error('mock archon exited (' + exited + ') before binding :' + port +
          (stderr ? ': ' + stderr.trim().split('\n')[0] : ''));
        break;
      }
      try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {}
      if (Date.now() > deadline) { lastErr = new Error('mock archon never answered on :' + port); break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (ready && exited === null) return { proc, port, base };
    try { proc.kill('SIGKILL'); } catch {}
  }
  throw new Error('could not start a mock archon: ' + (lastErr ? lastErr.message : 'unknown'));
}

let MOCK = null;
const get = (p) => fetch(MOCK.base + p).then((r) => r.json());
const post = (p, body) => fetch(MOCK.base + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
}).then((r) => r.json());
const arm = (mode) => post('/api/_mock/detail-fault', { mode });
const clearFault = () => post('/api/_mock/detail-fault', { mode: 'clear' });
// The transport timeout is a MAX wait, so it must be generous by default: the
// mock answers in milliseconds, and a tight budget turns machine load into a
// spurious abort (which the client correctly reports as UNAVAILABLE). Only the
// `timeout` mode wants a short one, so it is passed explicitly.
const tp = (timeoutMs = 5000) => ({
  environmentId: 'env-detail-outcomes', baseUrl: MOCK.base, timeoutMs, headers: () => ({}),
});

// ---- the claim under test -------------------------------------------------
// arm      = the mock's armed mode (an OMITTED count arms a persistent fault,
//            so no mode needs a count juggled to survive the client's retry).
// outcome  = the typed result lib/goal.js must produce.
// readError= the exact branch message, so landing on the right outcome via the
//            wrong leg still fails.
// retryable= whether the read must EXHAUST the retry budget. This is the
//            security-relevant claim: 404/410 are authoritative and must not
//            consume the budget, while 500/429/timeout are retried to the bound.
//
// `outcome` and `readError` are asserted EXACTLY: they are derived from which
// branch ran, so they are stable regardless of machine load.
//
// `attempts` is deliberately NOT asserted as an exact 1 for terminal modes.
// A transport-level error (a socket abort under load) legitimately consumes an
// earlier attempt and is then retried — that is the client behaving correctly,
// and it is NOT the status being retried. Measured on a loaded box, a
// `{error:'not found'}` read returned `attempts: 2` with `outcome: NOT_FOUND`
// and `readError: 'explicit negative envelope'`, i.e. attempt 1 threw and
// attempt 2 took the terminal branch. Pinning `=== 1` would make this file
// flaky without weakening what it proves, so terminal modes assert `attempts`
// stayed BELOW the budget — which still goes red if a 404 is ever retried.
const RETRY_BUDGET = 3; // RUN_READ_MAX_RETRIES = 2 -> 3 attempts
const EXPECTED = {
  '404':            { outcome: 'NOT_FOUND',   retryable: false, readError: 'HTTP 404' },
  '410':            { outcome: 'NOT_FOUND',   retryable: false, readError: 'HTTP 410' },
  '500':            { outcome: 'UNAVAILABLE', retryable: true,  readError: 'HTTP 500' },
  '429':            { outcome: 'UNAVAILABLE', retryable: true,  readError: 'HTTP 429' },
  'timeout':        { outcome: 'UNAVAILABLE', retryable: true,  readError: 'run detail read failed after 3 attempts' },
  'invalid-json':   { outcome: 'INVALID',     retryable: false, readError: 'run detail body was not valid JSON' },
  // A JSON string and a JSON array are DIFFERENT branches in the client
  // (`typeof record !== 'object'` vs `Array.isArray(record)`) but share one
  // message, so both are pinned to it; see the array-leg note in the report.
  'not-object':     { outcome: 'INVALID',     retryable: false, readError: 'run detail body was not a record' },
  'array-body':     { outcome: 'INVALID',     retryable: false, readError: 'run detail body was not a record' },
  // {ok:true} carries no id, so it is refused by the `record.id !== runId`
  // guard — NOT by the typeof leg and NOT by the id-mismatch leg.
  'not-run-object': { outcome: 'INVALID',     retryable: false, readError: 'run detail body carried no run id' },
  // A real record with a swapped id is refused by the id-mismatch guard.
  'id-mismatch':    { outcome: 'INVALID',     retryable: false, readError: 'run detail id mismatch: run-someone-else != ' + RUN_ID },
  // The one shape that IS an authoritative absence despite HTTP 200.
  'absent-body':    { outcome: 'NOT_FOUND',   retryable: false, readError: 'explicit negative envelope' },
};

before(async () => {
  MOCK = await startMock();
  process.env.DSH_OPERATOR_UI_ARCHON = MOCK.base;
});

after(async () => {
  if (MOCK) { try { MOCK.proc.kill('SIGKILL'); } catch {} }
  await rm(HOME, { recursive: true, force: true });
});

test('lib/goal.js exports fetchRunDetail (the unit tier needs it)', () => {
  assert.equal(typeof fetchRunDetail, 'function',
    'export { runWorkflowName, verifyParentLinkage, fetchRunDetail } at lib/goal.js:147');
});

// ---- unit tier: all 11 modes, driven directly ------------------------------
for (const [mode, want] of Object.entries(EXPECTED)) {
  test('unit ' + mode + ' -> ' + want.outcome + (want.retryable ? ' (retried to the bound)' : ' (authoritative)'), async () => {
    await clearFault();
    await post('/api/_mock/detail-reads/reset');
    const armed = await arm(mode);
    assert.equal(armed.armed, true, 'mode ' + mode + ' must arm');
    assert.equal(armed.persistent, true,
      mode + ': an omitted count must arm a PERSISTENT fault, else the client retry heals it');

    const read = await fetchRunDetail(RUN_ID, tp(mode === 'timeout' ? 500 : 5000));

    assert.equal(read.outcome, want.outcome, mode + ': outcome');
    assert.equal(read.readError, want.readError, mode + ': readError (which branch was taken)');
    assert.equal(read.detail, null, mode + ': a non-FOUND read must carry no detail');

    if (want.retryable) {
      assert.equal(read.attempts, RETRY_BUDGET,
        mode + ': a retryable read must exhaust the budget (' + read.attempts + ' attempts)');
    } else {
      assert.ok(read.attempts >= 1 && read.attempts < RETRY_BUDGET,
        mode + ': an authoritative outcome must NOT consume the retry budget, got ' +
        read.attempts + ' attempts — ' + JSON.stringify(read));
    }

    // Cross-check from the mock's side. NOT `===`: under load an attempt can
    // die before it reaches the mock (measured: client attempts 2, mock reads 1
    // — attempt 1 was a connect abort). The mock can therefore never see MORE
    // reads than the client made, and must see at least one.
    const counters = await get('/api/_mock/detail-reads');
    assert.ok(counters.reads >= 1 && counters.reads <= read.attempts,
      mode + ': mock reads (' + counters.reads + ') must be between 1 and the client attempts (' +
      read.attempts + ') — ' + JSON.stringify(read));

    await clearFault();
  });
}

// ---- transport-level failure (no mock fault at all) ------------------------
// A read that never completes must be an OUTAGE, never an absence. The
// "connected but silent" form of that is covered deterministically by the
// mock's `timeout` mode above; this pins the "nothing is listening" form.
// (A too-tight transport timeout is NOT used here: locally the mock answers in
// under a millisecond, so a 1 ms budget races the response and is not a
// reliable way to force an abort.)
test('a refused connection is UNAVAILABLE, never an absence', async () => {
  const dead = await freePort();
  const refused = await fetchRunDetail(RUN_ID, {
    environmentId: 'env-detail-dead', baseUrl: 'http://127.0.0.1:' + dead, timeoutMs: 1000, headers: () => ({}),
  });
  assert.equal(refused.outcome, 'UNAVAILABLE', 'a refused connection must not be read as an absence');
  assert.equal(refused.attempts, 3, 'a refused connection is retryable');
  assert.equal(refused.detail, null);
});

// ---- the point of the whole work order: the outcomes are DISTINGUISHABLE ----
test('absence, outage and corrupt evidence are three distinguishable results', async () => {
  const sample = async (mode) => {
    await clearFault();
    await arm(mode);
    const read = await fetchRunDetail(RUN_ID, tp());
    await clearFault();
    return read;
  };
  const absent = await sample('404');        // Archon answered: no such run
  const outage = await sample('500');        // could not read
  const corrupt = await sample('invalid-json'); // read, but not evidence

  assert.equal(new Set([absent.outcome, outage.outcome, corrupt.outcome]).size, 3,
    'NOT_FOUND / UNAVAILABLE / INVALID must be three distinct outcomes, got: ' +
    [absent.outcome, outage.outcome, corrupt.outcome].join(', '));

  assert.notEqual(absent.readError, outage.readError,
    'an authoritative absence must not read the same as an outage');
  assert.notEqual(outage.readError, corrupt.readError);
  assert.notEqual(absent.readError, corrupt.readError);

  // The old collapse: every one of these used to be `null`, so a caller could
  // not tell "Archon says there is no such run" from "we could not ask".
  for (const r of [absent, outage, corrupt]) {
    assert.notEqual(r.outcome, 'FOUND');
    assert.equal(r.detail, null);
  }
});

// ---- integration tier: sampled modes through the real discoverRun ----------
// Asserted on the OPERATOR-VISIBLE refusal name in `rejected[]`, which is what
// a user actually sees, rather than on the raw outcome. NOTE: discoverRun does
// not return early on a non-FOUND dispatch-provided read — it records the
// rejection and falls through to the polling loop until ADOPTION_DEADLINE_MS
// (10 s, not injectable), so each case below costs ~10 s. Hence a sample of
// three, not all eleven.
const INTEGRATION = {
  '404':         { reason: 'run-not-found',      retryable: false },
  '500':         { reason: 'archon-unavailable', retryable: true },
  'absent-body': { reason: 'run-not-found',      retryable: false },
};

for (const [mode, want] of Object.entries(INTEGRATION)) {
  test('integration ' + mode + ' -> discoverRun refuses with "' + want.reason + '"', async () => {
    await clearFault();
    await arm(mode);
    // preIds covers every list row, so the polling loop performs no detail
    // reads of its own and `rejected` isolates the dispatch-token read.
    const listing = await get('/api/workflows/runs?limit=50');
    const preIds = new Set(listing.runs.map((r) => r.id));

    const result = await discoverRun({
      workflowName: WORKFLOW,
      preIds,
      conversationId: 'conv-detail-outcomes',
      association: null,
      dispatchedMessage: 'detail-read-outcomes probe',
      dispatchedRunId: RUN_ID,
      transport: tp(),
    });

    const rejected = (result.rejected || []).find((x) => x.source === 'dispatch-token');
    assert.ok(rejected, 'a dispatch-token rejection must be recorded, got: ' + JSON.stringify(result.rejected));
    assert.equal(rejected.id, RUN_ID);
    // The observed rejection is echoed on every failure below: a bare
    // "expected X got Y" would not say WHICH read outcome the client saw.
    const observed = 'observed rejection: ' + JSON.stringify(rejected) +
      ', discoverRun status: ' + JSON.stringify(result.status);
    assert.equal(rejected.reason, want.reason, 'operator-visible refusal name — ' + observed);
    if (want.retryable) {
      assert.equal(rejected.attempts, RETRY_BUDGET, 'a retryable read must exhaust the budget — ' + observed);
    } else {
      assert.ok(rejected.attempts >= 1 && rejected.attempts < RETRY_BUDGET,
        'an authoritative outcome must NOT consume the retry budget — ' + observed);
    }
    assert.notEqual(result.status, 'found', mode + ' must never adopt a run it could not read');
    assert.equal(result.adoption, null);

    await clearFault();
  });
}
