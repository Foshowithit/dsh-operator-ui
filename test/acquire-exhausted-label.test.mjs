// The exhausted infra-attempt bound prescribes an action DERIVED from the
// recorded read outcome, not a hardcoded one.
//
// WHY THIS FILE EXISTS
// lib/acquire.js's exhausted branch used to hardcode
//   label: 'Inspect Archon availability'
// for ALL three unreadable-run outcomes. For UNAVAILABLE that is right — the
// read could not be completed. For ABSENT (Archon ANSWERED and named no such
// run) and MALFORMED (a record came back unusable) the evidence has already
// CLEARED availability, so the label was a false statement about the
// installation — and it is the text the operator clicks. Same defect class as
// the read sites: the recorded outcome is truthful, but the prescribed action
// contradicted it.
//
// This test proves DERIVATION, not a restatement: a three-ABSENT streak and a
// three-UNAVAILABLE streak must end with DIFFERENT labels. A test that asserted
// only one outcome's label would pass against the old hardcoded string.
//
// The streak is the bound's own count (consecutiveInfraOutages): 2 seeded
// outage envelopes + 1 live outage = attempt 3 = INFRA_ATTEMPT_LIMIT, so the
// envelope is exhausted and the action is the exhausted inspect.
//
// Deterministic: a local stub on an ephemeral port (never the shared mock on
// 13777); each source task is independent, so streaks never bleed together.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = {
  modelCalls: 0,
  listMode: 'ok',      // 'ok' | 'fail'
  listHasRun: false,
  detailMode: 'ok',    // 'ok' | 'invalid'
  lastWorkflow: null,
};

function modelReply() {
  state.modelCalls += 1;
  const name = 'exhausted-probe-r' + state.modelCalls + '-v0-1-0';
  const yaml = [
    'name: ' + name,
    'description: exhausted-label probe',
    'nodes:',
    '  - id: n1',
    '    bash: echo RESULT probe=ok; echo learned-' + name + ':done',
  ].join('\n');
  const text = '```yaml\n' + yaml + '\n```\n\n```json\n{"description":"exhausted-label probe","tags":["probe","label"]}\n```';
  return { output: [{ type: 'message', content: [{ text }] }], usage: { output_tokens: 10 } };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (b, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  const p = url.pathname;

  if (p === '/responses' && req.method === 'POST') return json(modelReply());
  const dispatch = p.match(/^\/api\/workflows\/([^/]+)\/run$/);
  if (dispatch && req.method === 'POST') {
    state.lastWorkflow = decodeURIComponent(dispatch[1]);
    return json({ accepted: true, status: 'started' });
  }
  if (p === '/api/workflows/runs' && req.method === 'GET') {
    if (state.listMode === 'fail') return json({ error: 'archon down' }, 500);
    return json({ runs: state.listHasRun ? [{ id: 'run-x', workflow_name: state.lastWorkflow, status: 'completed' }] : [] });
  }
  const detail = p.match(/^\/api\/workflows\/runs\/([^/]+)$/);
  if (detail && req.method === 'GET') {
    if (state.detailMode === 'invalid') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"run": '); }
    return json({ run: { id: 'run-x', status: 'completed' }, events: [] });
  }
  if (p === '/api/workflows') return json({ workflows: [] });
  res.writeHead(404); res.end('not found');
});

let PORT = null;
let home = null;
let acquireCapability = null;
let upsertTask = null;

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); // runtime port-0 binding
  PORT = server.address().port;

  home = await mkdtemp(join(tmpdir(), 'opui-acq-label-'));
  process.env.DSH_HOME = home;
  process.env.ACQ_TEST_KEY = 'stub-key';
  await mkdir(join(home, 'operator-ui'), { recursive: true });
  const wfDir = join(home, 'wf');
  const wsDir = join(home, 'ws');
  await mkdir(wfDir, { recursive: true });
  await mkdir(wsDir, { recursive: true });
  await writeFile(join(home, 'registry.json'), JSON.stringify({ capabilities: [] }, null, 2) + '\n');
  await writeFile(join(home, 'operator-ui.config.json'), JSON.stringify({
    archon: { baseUrl: 'http://127.0.0.1:' + PORT, timeoutMs: 500 },
    registry: { path: join(home, 'registry.json') },
    teaching: { workflowsDir: wfDir, workspaceDir: wsDir },
    acquisition: {
      mode: 'endpoint',
      endpoint: 'http://127.0.0.1:' + PORT,
      model: 'stub',
      apiKeyEnv: 'ACQ_TEST_KEY',
      budget: { maxRevisions: 1 },
    },
  }, null, 2) + '\n');

  ({ acquireCapability } = await import('../lib/acquire.js'));
  ({ upsertTask } = await import('../lib/tasks.js'));
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  if (home) await rm(home, { recursive: true, force: true });
});

// A fresh source goal with its own id, so each streak is independent.
async function seedSource(srcId) {
  await upsertTask({
    taskId: srcId, tasksVersion: 1, kind: 'goal', status: 'closed',
    objective: 'count words in every .txt file in the workspace',
    createdAt: '2025-12-01T00:00:00.000Z', endedAt: null,
    objectiveEvaluation: { kind: 'output-contains', value: 'RESULT' },
  });
}

// Two prior infra outages for this source — the first two links of a 3-streak.
async function seedTwoOutages(srcId, outcome) {
  for (let i = 1; i <= 2; i++) {
    await upsertTask({
      taskId: 'acq_seed_' + srcId + '_' + i, kind: 'teaching',
      sourceTaskId: srcId, status: String(outcome).toLowerCase(), verdict: 'UNKNOWN',
      outage: { outcome, reason: 'seed outage ' + i, attempt: i, limit: 3, exhausted: false },
      createdAt: '2026-01-0' + i + 'T00:00:00.000Z',
      startedAt: '2026-01-0' + i + 'T00:00:00.000Z',
    });
  }
}

async function runOutcome(srcId, over) {
  Object.assign(state, { modelCalls: 0, listMode: 'ok', listHasRun: false, detailMode: 'ok', lastWorkflow: null }, over);
  const out = await acquireCapability({ sourceTaskId: srcId });
  assert.equal(out.ok, true);
  return out.teaching;
}

// ---------------------------------------------------------------------------

test('a three-ABSENT streak ends with the dispatch-path action, not availability', async () => {
  const src = 'task-absent-streak';
  await seedSource(src);
  await seedTwoOutages(src, 'ABSENT');
  // live link 3 of 3: dispatch accepted, list READ, names no run -> ABSENT
  const t = await runOutcome(src, { listMode: 'ok', listHasRun: false });
  assert.equal(t.outage.outcome, 'ABSENT');
  assert.equal(t.infraAttempts, 3, 'the streak must reach the bound');
  assert.equal(t.nextAction.kind, 'inspect');
  assert.equal(t.nextAction.label, 'Inspect the dispatch path',
    'ABSENT clears availability — the label must not send the operator to Archon');
});

test('a three-UNAVAILABLE streak still ends with the availability action', async () => {
  const src = 'task-unavailable-streak';
  await seedSource(src);
  await seedTwoOutages(src, 'UNAVAILABLE');
  // live link 3 of 3: the list read never completes -> UNAVAILABLE
  const t = await runOutcome(src, { listMode: 'fail' });
  assert.equal(t.outage.outcome, 'UNAVAILABLE');
  assert.equal(t.infraAttempts, 3, 'the streak must reach the bound');
  assert.equal(t.nextAction.kind, 'inspect');
  assert.equal(t.nextAction.label, 'Inspect Archon availability');
});

test('a three-MALFORMED streak ends with the run-record action', async () => {
  const src = 'task-malformed-streak';
  await seedSource(src);
  await seedTwoOutages(src, 'MALFORMED');
  // live link 3 of 3: list names a terminal run, its detail read is unusable
  const t = await runOutcome(src, { listMode: 'ok', listHasRun: true, detailMode: 'invalid' });
  assert.equal(t.outage.outcome, 'MALFORMED');
  assert.equal(t.infraAttempts, 3, 'the streak must reach the bound');
  assert.equal(t.nextAction.kind, 'inspect');
  assert.equal(t.nextAction.label, 'Inspect the run record');
});

test('the unclassified-outcome fallback never claims a cause (source guard)', async () => {
  // The three tests above drive the REACHABLE outcomes end-to-end. This guards
  // the residual branch they cannot reach: outage() is called only for a status
  // in UNREADABLE_RUN_STATUSES, and the label map covers exactly those three, so
  // an UNCLASSIFIED outcome is unreachable through the public API — a
  // behavioural test cannot pin the fallback. A source assertion is the only way
  // to keep it from silently reverting to the causal claim this file exists to
  // remove. Two revert shapes go red: (a) drop the lookup and hardcode
  // `label: 'Inspect Archon availability'` — the match fails here AND the ABSENT
  // and MALFORMED tests above fail; (b) keep the lookup but restore the old
  // fallback string — the notEqual below fails.
  //
  // KNOWN LIMIT, recorded so a future refactor does not chase a phantom: this
  // pattern keys on the fallback being written INLINE at the use site. Extracting
  // it to a named const with identical behaviour WOULD false-red here. If you do
  // that refactor, update the pattern in the same change — this guard tests the
  // shape of one expression, not the behaviour of the module, because the
  // behaviour it guards is unreachable through the public API.
  const src = await readFile(new URL('../lib/acquire.js', import.meta.url), 'utf8');
  const m = src.match(/EXHAUSTED_INSPECT_LABEL\[outcome\]\s*\|\|\s*'([^']+)'/);
  assert.ok(m, 'the exhausted label lost its defensive fallback — an unclassified outcome would render no instruction');
  assert.notEqual(m[1], 'Inspect Archon availability',
    'the fallback must not restate the availability claim: for an unclassified outcome the data supports no cause');
  assert.match(m[1], /^Inspect\b/,
    'the fallback must still read as an operator instruction, not a bare token');
});
