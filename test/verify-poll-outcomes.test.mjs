// lib/verify.js poll-site collapse fix + its positive controls.
//
// WHY THIS FILE EXISTS
// The two poll sites in probeB() used to collapse an Archon OUTAGE into a
// statement about the work: a discovery deadline with no readable list became
// "no new run appeared" (dispatch-failed), and an evidence deadline where every
// poll answered 500 became "the run never reached a terminal state"
// (run-timeout). Same outage, two verdicts depending on whether the failure
// arrived thrown or returned. This file pins the distinction:
//   * a deadline reached with ZERO successful reads  -> archon-unavailable
//   * a deadline reached having READ the run         -> run-timeout (unchanged)
//   * a 200 whose body cannot be READ — unparseable, OR parseable but not a run
//     list — is not a successful read, so it counts toward "zero". This is the
//     two-event trap (#48): the counter is gated on the reader's RESOLVED state
//     (lib/verify.js readRunList), never on the HTTP status. Both shapes are
//     pinned below, because "the body parsed" and "the body is a run list" are
//     different questions and only the second one is a read: `garbage` fails the
//     parse, `no-runs` passes the parse and fails the shape.
// and it carries the positive controls that keep the distinction honest: a
// readable-but-non-terminal run still reads run-timeout (a genuine timeout WITH
// successful reads is NOT an outage), and the admission store's ENOENT branch
// (no tasks.json at all) still reads ABSENT — a fresh install is not an outage,
// and only a store that EXISTS but cannot be read is admission-store-unreadable.
//
// Determinism: a local stub Archon on an ephemeral port (never the shared mock
// on 13777), faulted per scenario, so this file is immune to concurrent load.
// The stub is reached only if the config FILE is the config in force, so
// runVerify() asserts that no env override shadows it (see the guard there) —
// the one environmental cause that would red this file through no fault of the
// fix. The assertions are the invariant, not the implementation.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------- stub Archon
//
// One server, three surfaces: the catalog/health the status probe reads, the
// run list the discovery poll reads, and the run detail the evidence poll
// reads. Every fault is armed per test through `state`; nothing here is timing.
const state = {
  dispatchMode: 'no-id',          // 'no-id' (acceptance) | 'with-id' (mints a run)
  listMode: 'ok',                 // 'ok' | 'fail' | 'garbage' | 'no-runs'
  materializeOnDispatch: false,   // run appears in the list only AFTER the POST
  dispatched: false,
  detailMode: 'completed',        // 'fail' | 'running' | 'completed'
};

const SEED_OUT = 'rcos-verify-seed:rcos-verify-echo-v1';

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (b, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  const p = url.pathname;

  if (p === '/api/workflows' && req.method === 'GET') return json({ workflows: [{ name: 'verify-echo-v1' }] });
  if (p === '/api/health' && req.method === 'GET') return json({ version: 'stub-0.0.1' });
  if (p === '/api/workflows/runs' && req.method === 'GET') {
    if (state.listMode === 'fail') return json({ error: 'archon down' }, 500);
    // #48: a 200 whose BODY cannot be read. Two shapes, because they fail at
    // different points in the reader — a body that is not JSON at all (the parse
    // throws) and valid JSON that is not a run list (the parse succeeds, the
    // SHAPE does not). Both are reads we did not complete; neither is an
    // authoritative absence, which is `{"runs": []}` below.
    if (state.listMode === 'garbage') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('<html>not json at all</html>'); }
    if (state.listMode === 'no-runs') return json({ error: 'unexpected shape' });
    const has = state.materializeOnDispatch && state.dispatched;
    return json({ runs: has ? [{ id: 'run-stub-1', workflow_name: 'verify-echo-v1', status: 'running' }] : [] });
  }
  const dispatch = p.match(/^\/api\/workflows\/([^/]+)\/run$/);
  if (dispatch && req.method === 'POST') {
    state.dispatched = true;
    if (state.dispatchMode === 'with-id') return json({ run: { id: 'run-stub-1', status: 'running' } });
    return json({ accepted: true, status: 'started' });
  }
  const detail = p.match(/^\/api\/workflows\/runs\/([^/]+)$/);
  if (detail && req.method === 'GET') {
    if (state.detailMode === 'fail') return json({ error: 'archon down' }, 500);
    if (state.detailMode === 'running') return json({ run: { id: 'run-stub-1', status: 'running' } });
    return json({ run: { id: 'run-stub-1', status: 'completed', output: SEED_OUT } });
  }
  res.writeHead(404); res.end('not found');
});

let PORT = null;
let home = null;
let runVerification = null;
let admitExecution = null;
let resolveConfig = null;

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); // runtime port-0 binding
  PORT = server.address().port;

  home = await mkdtemp(join(tmpdir(), 'opui-verify-poll-'));
  process.env.DSH_HOME = home;
  await mkdir(join(home, 'operator-ui'), { recursive: true });
  const registryPath = join(home, 'registry.json');
  await writeFile(registryPath, JSON.stringify({
    registry_version: 'v1',
    capabilities: [{
      id: 'rcos-verify-echo', version: '1.0.0', workflow: 'verify-echo-v1',
      seed: true, status: 'seeded',
      verification: { terminalStatus: 'completed', expectOutput: SEED_OUT },
    }],
  }, null, 2) + '\n');
  await writeFile(join(home, 'operator-ui.config.json'), JSON.stringify({
    archon: { baseUrl: 'http://127.0.0.1:' + PORT, timeoutMs: 500 },
    registry: { path: registryPath, schema: 'rcos-public-v1', maxBytes: 200000 },
    teaching: { workflowsDir: join(home, 'wf'), workspaceDir: join(home, 'ws') },
  }, null, 2) + '\n');

  ({ runVerification } = await import('../lib/verify.js'));
  ({ admitExecution } = await import('../lib/admission.js'));
  ({ resolveConfig } = await import('../lib/config.js'));
});

after(async () => {
  await new Promise((r) => server.close(r));
  if (home) await rm(home, { recursive: true, force: true });
});

// Drive the REAL verification and hand back probe B.
async function runVerify(over) {
  Object.assign(state, { dispatchMode: 'no-id', listMode: 'ok', materializeOnDispatch: false, dispatched: false, detailMode: 'completed' }, over);
  // Precondition: the config file `before` wrote must be the one in force. An
  // env override WINS over the file (lib/config.js:147 for archon, :217 for
  // registry), so a shell carrying DSH_OPERATOR_UI_ARCHON or
  // DSH_OPERATOR_UI_REGISTRY points probe B's reads — and the archon/registry
  // probes feeding its preflight — somewhere other than the stub below, and
  // every probe-B row goes red for a reason that has nothing to do with the
  // fix. The receipt cannot name that cause: it projects configAuthority
  // { path, exists, configHash, errorCount } (lib/verify.js:449) and never the
  // per-key sources. So assert the source here, where the message can say what
  // to unset. Deliberately NOT in `before`: keeping the Site A rows (which never
  // call runVerification) green preserves the signature that a probe-B-wide red
  // with green Site A rows means the preflight, not the polls.
  const { sources } = resolveConfig();
  assert.equal(sources['archon.baseUrl'], 'file',
    'DSH_OPERATOR_UI_ARCHON is set in this shell and overrides the stub Archon — unset it, or this file tests the wrong endpoint (source: ' + sources['archon.baseUrl'] + ')');
  assert.equal(sources['registry.path'], 'file',
    'DSH_OPERATOR_UI_REGISTRY is set in this shell and overrides the seeded registry — unset it, or this file tests the wrong registry (source: ' + sources['registry.path'] + ')');
  const out = await runVerification({ pkgVersion: '0.0.0' });
  const receipt = out.receipt;
  const pb = receipt && receipt.probes && receipt.probes.find((x) => x.id === 'rcos-execution-path');
  const pa = receipt && receipt.probes && receipt.probes.find((x) => x.id === 'verify-machinery');
  assert.ok(pa && pa.pass, 'probe A must pass so probe B actually runs: ' + JSON.stringify(pa && pa.failureCode));
  assert.ok(pb, 'receipt must carry probe B');
  return pb;
}

// ------------------------------------------------------------------ Site B
// Discovery is a READ. A dispatch that was accepted and then could not be READ
// is an outage, never a failed dispatch.

test('Site B: a discovery deadline with ZERO successful list reads is archon-unavailable, not dispatch-failed', async () => {
  const pb = await runVerify({ dispatchMode: 'no-id', listMode: 'fail' });
  assert.equal(pb.pass, false);
  assert.equal(pb.failureCode, 'archon-unavailable',
    'an unreadable run list must never be reported as a failed dispatch — got ' + pb.failureCode);
  assert.notEqual(pb.failureCode, 'dispatch-failed');
  assert.match(pb.detail.blocker, /never successfully read/i);
});

test('Site B positive control: a READ list that names no run still reads dispatch-failed', async () => {
  const pb = await runVerify({ dispatchMode: 'no-id', listMode: 'ok' });
  assert.equal(pb.pass, false);
  assert.equal(pb.failureCode, 'dispatch-failed',
    'an answered list naming no run IS a dispatch failure — got ' + pb.failureCode);
  assert.notEqual(pb.failureCode, 'archon-unavailable');
});

test('Site B positive control: a READ list that names the new run proceeds (not a refusal)', async () => {
  const pb = await runVerify({ dispatchMode: 'no-id', listMode: 'ok', materializeOnDispatch: true, detailMode: 'completed' });
  assert.equal(pb.pass, true, 'a discoverable run must be adopted and verified — got ' + pb.failureCode);
});

// ---------------------------------------------------- Site B, the TWO-EVENT trap
// #48. A read is ONE event or it is not a read. The counter used to be
// incremented on the HTTP STATUS, BEFORE the body was parsed, so a 200 whose
// body could not be read was counted as a successful read — and the `=== 0`
// outage guard could then never fire on the very case it exists for. The fix
// gates the increment on the reader's RESOLVED state (the parse AND the shape
// check now live inside the reader, so the two events became one), which is the
// same shape as lib/acquire.js findRun.
//
// The boundary case is the positive control above ("a READ list that names no
// run still reads dispatch-failed"): `{"runs": []}` is an ANSWERED list naming
// no run — an authoritative absence, dispatch-failed.
// These rows are the opposite: the list was never read. They cannot pass
// vacuously: before the fix both produced dispatch-failed (the parse throw
// escaped to the poll's catch; the shape check read `undefined` runs as an
// empty list), so each row is a real red→green flip.

test('#48: a 200 list read whose body is not JSON is archon-unavailable, not dispatch-failed', async () => {
  const pb = await runVerify({ dispatchMode: 'no-id', listMode: 'garbage' });
  assert.equal(pb.pass, false);
  assert.equal(pb.failureCode, 'archon-unavailable',
    'a 200 we could not parse is a read we did not complete — never a failed dispatch: got ' + pb.failureCode);
  assert.notEqual(pb.failureCode, 'dispatch-failed',
    'an unreadable read and an answered-empty read must not collapse to one code');
  assert.match(pb.detail.blocker, /never successfully read/i);
});

test('#48: a 200 list read that is valid JSON but carries no runs array is archon-unavailable, not dispatch-failed', async () => {
  const pb = await runVerify({ dispatchMode: 'no-id', listMode: 'no-runs' });
  assert.equal(pb.pass, false);
  assert.equal(pb.failureCode, 'archon-unavailable',
    'a 200 whose body is not a run list is a read we did not complete — got ' + pb.failureCode);
  assert.notEqual(pb.failureCode, 'dispatch-failed',
    'an unreadable read and an answered-empty read must not collapse to one code');
  assert.match(pb.detail.blocker, /never successfully read/i);
});

// ------------------------------------------------------------------ Site C
// A read that RETURNS 500 is as much an outage as one that THROWS: the run's
// status was never observed either way.

test('Site C: an evidence deadline where every poll returned 500 is archon-unavailable, not run-timeout', async () => {
  const pb = await runVerify({ dispatchMode: 'with-id', detailMode: 'fail' });
  assert.equal(pb.pass, false);
  assert.equal(pb.failureCode, 'archon-unavailable',
    'every poll returning 500 means the run was never read — not that it never finished: got ' + pb.failureCode);
  assert.notEqual(pb.failureCode, 'run-timeout');
  assert.match(pb.detail.blocker, /never successfully read/i);
});

test('Site C positive control: a READ run that stays non-terminal reads run-timeout (genuine timeout WITH successful reads)', async () => {
  const pb = await runVerify({ dispatchMode: 'with-id', detailMode: 'running' });
  assert.equal(pb.pass, false);
  assert.equal(pb.failureCode, 'run-timeout',
    'a readable run that never reaches terminal IS a timeout — got ' + pb.failureCode);
  assert.notEqual(pb.failureCode, 'archon-unavailable');
  assert.match(pb.detail.blocker, /did not reach a terminal state/i);
});

test('Site C positive control: a READ terminal run passes', async () => {
  const pb = await runVerify({ dispatchMode: 'with-id', detailMode: 'completed' });
  assert.equal(pb.pass, true, 'a terminal run with the seeded marker must verify — got ' + pb.failureCode);
});

// ------------------------------------------------------------------ Site A
// The stored-envelope read distinguishes an authoritative absence from an
// unreadable store: ENOENT is ABSENT (a fresh install has no stored goals),
// but a store that EXISTS and cannot be read is not an empty store.

const tasksFile = () => join(home, 'operator-ui', 'tasks.json');

test('Site A: no tasks.json at all (ENOENT) is ABSENT — admission-goal-not-found, not an outage', async () => {
  await rm(tasksFile(), { force: true });
  const out = await admitExecution({ goalTaskId: 'task-none', requires: [], description: 'd', tags: ['t'] });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'admission-goal-not-found',
    'a fresh install is not an outage — got ' + out.code);
  assert.notEqual(out.code, 'admission-store-unreadable');
});

test('Site A: a store that EXISTS but cannot be read is admission-store-unreadable, not admission-goal-not-found', async () => {
  await writeFile(tasksFile(), '{ "tasks": [ oops');
  const out = await admitExecution({ goalTaskId: 'task-none', requires: [], description: 'd', tags: ['t'] });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'admission-store-unreadable',
    'a malformed store is not an empty store — got ' + out.code);
  assert.notEqual(out.code, 'admission-goal-not-found');
});
