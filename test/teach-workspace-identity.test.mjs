// The teaching eval must not blame the candidate for an unverified workspace.
//
// WHY THIS FILE EXISTS
// lib/teach.js plants its held-out fixture at `teaching.workspaceDir` and then
// reads the run's evidence. Nothing checked that the run EXECUTED there.
// Measured against a real Archon 0.4.1 (D3, 2026-09-26): the web adapter gives
// every dispatched run its own git worktree, and a codebase cannot be registered
// at all unless it is a git repo — so no configuration makes a web-dispatched run
// execute at the codebase's `default_cwd`. The fixture was invisible to the
// candidate, all three cases observed zeros, and `_teach` sealed
//   verdict REFUSED, "Candidate succeeded 0/3 evaluations"
// — a false statement about a candidate that was never tested. This is the same
// defect class the read-outcome work removed elsewhere: the recorded verdict was
// not the thing that happened.
//
// This file pins the rule AND its asymmetry:
//   - a PRESENT working_path that DIFFERS  -> UNKNOWN / workspace-mismatch,
//     nextAction.kind === 'configure', NO `.outage`, and the eval STOPS at case 1
//   - a PRESENT working_path that MATCHES  -> the eval proceeds and can reach
//     CANDIDATE (the check must not fire on a legitimate run)
//   - an ABSENT working_path               -> UNVERIFIED, behaviour unchanged
//
// The matching-path case is the important control: without it, a check that
// refused EVERYTHING would pass this file. The stub therefore reads the fixture
// the eval just wrote and reports the counts a real in-place orchestrator would,
// so "CANDIDATE" is earned rather than asserted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = {
  workingPath: undefined, // undefined = the run reports no working_path at all
  dispatches: 0,
  detailReads: 0,
  runSeq: 0,
  currentRunId: null,
  lastWorkflow: null,
  wsDir: null,
};

// What a real in-place orchestrator's bash node would print for the fixture the
// eval just wrote. `wc -l/-w/-c` semantics, computed from the file itself.
async function evidenceForFixture() {
  const body = await readFile(join(state.wsDir, 'README.txt'), 'utf8');
  const lines = (body.match(/\n/g) || []).length;
  const words = body.split(/\s+/).filter(Boolean).length;
  const bytes = Buffer.byteLength(body);
  return 'TOTAL Lines: ' + lines + ' Words: ' + words + ' Bytes: ' + bytes + '\nlearned-workspace-word-count:done';
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (b, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  const p = url.pathname;

  const dispatch = p.match(/^\/api\/workflows\/([^/]+)\/run$/);
  if (dispatch && req.method === 'POST') {
    state.dispatches += 1;
    state.lastWorkflow = decodeURIComponent(dispatch[1]);
    // A REAL Archon mints a fresh run id per dispatch. A stub that reuses one
    // id is invisible to the first case and then permanently invisible to the
    // second — the discovery snapshot (`preIds`) would already contain it.
    state.currentRunId = 'run-wsc-' + (++state.runSeq);
    return json({ accepted: true, status: 'started' });
  }
  if (p === '/api/workflows/runs' && req.method === 'GET') {
    if (!state.currentRunId) return json({ runs: [] });
    const row = { id: state.currentRunId, workflow_name: state.lastWorkflow, status: 'completed' };
    if (state.workingPath !== undefined) row.working_path = state.workingPath;
    return json({ runs: [row] });
  }
  const detail = p.match(/^\/api\/workflows\/runs\/([^/]+)$/);
  if (detail && req.method === 'GET') {
    state.detailReads += 1;
    const row = { id: detail[1], status: 'completed' };
    if (state.workingPath !== undefined) row.working_path = state.workingPath;
    const node_output = await evidenceForFixture();
    return json({ run: row, events: [{ id: 'e1', data: { node_output } }] });
  }
  if (p === '/api/workflows') return json({ workflows: [] });
  res.writeHead(404); res.end('not found');
});

let home = null;
let wsDir = null;
let teachRCOS = null;
let upsertTask = null;

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;

  home = await mkdtemp(join(tmpdir(), 'opui-teach-ws-'));
  process.env.DSH_HOME = home;
  await mkdir(join(home, 'operator-ui'), { recursive: true });
  const wfDir = join(home, 'wf');
  wsDir = join(home, 'ws');
  state.wsDir = wsDir;
  await mkdir(wfDir, { recursive: true });
  await mkdir(wsDir, { recursive: true });
  await writeFile(join(home, 'registry.json'), JSON.stringify({ capabilities: [] }, null, 2) + '\n');
  await writeFile(join(home, 'operator-ui.config.json'), JSON.stringify({
    archon: { baseUrl: 'http://127.0.0.1:' + PORT, timeoutMs: 4000 },
    registry: { path: join(home, 'registry.json') },
    teaching: { workflowsDir: wfDir, workspaceDir: wsDir },
  }, null, 2) + '\n');

  ({ teachRCOS } = await import('../lib/teach.js'));
  ({ upsertTask } = await import('../lib/tasks.js'));
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  if (home) await rm(home, { recursive: true, force: true });
});

async function seedGap(srcId) {
  await upsertTask({
    taskId: srcId, tasksVersion: 1, kind: 'goal', status: 'closed',
    objective: 'count lines words and bytes across every .txt file in the workspace',
    verdict: { decision: 'FAILED', failureCodes: ['no-route'] },
    failureCodes: ['no-route'],
    createdAt: '2026-02-01T00:00:00.000Z', endedAt: null,
  });
}

// ---------------------------------------------------------------------------

test('a run that executed ELSEWHERE is UNKNOWN/workspace-mismatch — never REFUSED, and the eval stops at case 1', async () => {
  await seedGap('task-ws-mismatch');
  state.workingPath = join(home, 'archon-home', 'workspaces', 'cb', 'worktrees', 'archon', 'thread-abc');
  state.dispatches = 0;
  state.detailReads = 0;
  state.runSeq = 0;
  state.currentRunId = null;
  state.lastWorkflow = null;

  const t = await teachRCOS({ sourceTaskId: 'task-ws-mismatch' });

  assert.equal(t.verdict, 'UNKNOWN', 'an untested candidate must not be REFUSED');
  assert.equal(t.status, 'workspace-mismatch');
  assert.equal(t.blocked && t.blocked.code, 'run-workspace-mismatch');
  assert.equal(t.blocked.expectedWorkspacePath, wsDir, 'the configured eval workspace is named');
  assert.equal(t.blocked.reportedWorkspacePath, state.workingPath, 'the directory the run actually used is named');
  assert.equal(t.nextAction.kind, 'configure', 'the prescribed action is a configuration action, not a retry or an inspect of Archon');
  assert.ok(!t.outage, 'a configuration mismatch must NOT extend the retryable infrastructure streak');
  assert.equal(t.evaluations.length, 0, 'the eval must abort on case 1 rather than run the remaining cases');
  assert.equal(state.dispatches, 1, 'exactly one dispatch — the remaining cases were never attempted');
  assert.ok(/not about the candidate|never actually tested/.test(t.nextAction.reason + t.error),
    'the operator-facing reason must say the evidence is not about the candidate');
});

test('CONTROL: a run that executed WHERE THE FIXTURE WAS PLANTED proceeds — the check does not fire on a legitimate run', async () => {
  await seedGap('task-ws-match');
  state.workingPath = wsDir;
  state.dispatches = 0;
  state.runSeq = 0;
  state.currentRunId = null;
  state.lastWorkflow = null;

  const t = await teachRCOS({ sourceTaskId: 'task-ws-match' });

  assert.equal(t.verdict, 'CANDIDATE',
    'a candidate that really passed all held-out cases must still become a CANDIDATE (verdict=' + t.verdict + ', status=' + t.status + ', error=' + t.error + ')');
  assert.equal(t.status, 'candidate');
  assert.equal(t.evaluations.length, 3, 'all three held-out cases ran');
  assert.ok(t.evaluations.every((e) => e.pass), 'every case passed on the evidence the run produced');
  assert.equal(state.dispatches, 3);
});

test('CONTROL: a run that reports NO working_path is UNVERIFIED, not mismatched — behaviour is unchanged', async () => {
  await seedGap('task-ws-unreported');
  state.workingPath = undefined; // the orchestrator reports no working_path
  state.dispatches = 0;
  state.runSeq = 0;
  state.currentRunId = null;
  state.lastWorkflow = null;

  const t = await teachRCOS({ sourceTaskId: 'task-ws-unreported' });

  assert.notEqual(t.status, 'workspace-mismatch',
    'an absent working_path proves nothing and must never be read as a mismatch');
  assert.equal(t.verdict, 'CANDIDATE', 'the eval proceeded exactly as before this change');
  assert.equal(state.dispatches, 3);
});
