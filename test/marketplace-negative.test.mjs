// P4 marketplace negatives — the PARENT half.
//
// Two mock archons, one per verdict:
//   * PLAIN  (MOCK_MARKETPLACE unset) — the UNMODIFIED v0.10.1 contract. This
//     is the unsupported-installation world: no openapi.json, no marketplace
//     routes, and the plugin must degrade honestly while /archon stays alive.
//   * MARKET (MOCK_MARKETPLACE=1) — adds the /api/marketplace/* namespace and
//     an openapi.json advertising it, with a seed entry per refusal shape.
//
// Every behavioral case runs in a child process (test/marketplace-case.mjs)
// booting the real plugin with a real config file; the parent pins the child's
// per-probe assertions AND independently proves the orchestrator-write
// counters never move across a whole child run.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT_PLAIN = 13792;
const PORT_MARKET = 13793;
const BASE_PLAIN = 'http://127.0.0.1:' + PORT_PLAIN;
const BASE_MARKET = 'http://127.0.0.1:' + PORT_MARKET;

const TOKENS = {
  root: 'e2e-mkt-root-4f19ab',
  alice: 'e2e-mkt-alice-9d72c3',
  bob: 'e2e-mkt-bob-1a55e8',
};
const TOKEN_VARS = {
  root: 'MKT_ROOT_TOKEN',
  alice: 'MKT_ALICE_TOKEN',
  bob: 'MKT_BOB_TOKEN',
};

// The registry the market cases run against: the seed capability plus one
// whose workflow name a marketplace entry deliberately shadows.
const REGISTRY = {
  capabilities: [
    { id: 'verify-echo', workflow: 'verify-echo-v1' },
    { id: 'market-registry-shadow', workflow: 'market-registry-shadow' },
  ],
};

const requiredConfig = () => ({
  auth: {
    mode: 'required',
    loopback: 'allow',
    principals: [
      { id: 'svc-root', tokenVar: TOKEN_VARS.root, ownerIds: ['alice', 'bob'] },
      { id: 'svc-alice', tokenVar: TOKEN_VARS.alice, ownerIds: ['alice'], environmentIds: ['env-local'] },
      { id: 'svc-bob', tokenVar: TOKEN_VARS.bob, ownerIds: ['bob'] },
    ],
  },
  environments: {
    defaultId: 'env-local',
    list: [
      {
        environmentId: 'env-remote',
        kind: 'custom-remote',
        providerId: 'archon-remote',
        adapter: { kind: 'archon-http', transport: { baseUrl: BASE_MARKET, timeoutMs: 5000 } },
      },
    ],
  },
});

// The guided-creation world adds a workspaces root AND a second environment
// declared on an adapter this build does not implement — the honest-501 world.
const guidedConfig = () => {
  const c = { ...requiredConfig(), registry: { path: registryPath }, marketplace: { workflowsDir }, workspaces: { root: dirs.guidedRoot } };
  c.environments = {
    ...c.environments,
    list: [...c.environments.list, { environmentId: 'env-broken', kind: 'custom-remote', providerId: 'archon-broken', adapter: { kind: 'solari-sandbox' } }],
  };
  return c;
};

// ----------------------------------------------------------------- harness

let tmpRoot;
let registryPath;
let workflowsDir;
let plainProc;
let marketProc;
const dirs = {};

const newDir = async (name) => {
  const p = join(tmpRoot, name);
  await mkdir(p, { recursive: true });
  return realpath(p);
};

async function spawnMock(port, market) {
  const proc = spawn(process.execPath, [join(ROOT, 'scripts', 'mock-archon.mjs'), String(port)], {
    stdio: 'ignore',
    env: { ...process.env, ...(market ? { MOCK_MARKETPLACE: '1' } : {}) },
  });
  const base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      if ((await fetch(base + '/api/health')).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('mock archon failed to start on :' + port);
    await new Promise((r) => setTimeout(r, 100));
  }
  return proc;
}

async function mockCalls(base) {
  const b = await (await fetch(base + '/api/_mock/calls')).json();
  return { createPosts: b.createPosts, dispatchPosts: b.dispatchPosts, codebasePosts: b.codebasePosts, setProjectPosts: b.setProjectPosts };
}
const ZERO = { createPosts: 0, dispatchPosts: 0, codebasePosts: 0, setProjectPosts: 0 };

// A whole-child-run invariant: no run creation, no dispatch, no project
// binding — ever. POST /api/codebases is the one counter workspace SETUP may
// legitimately move (each ensureWorkspace registers one path), so the caller
// pins it separately; the per-probe zero-write proofs live in the child.
const writeDelta = (before_, after_) => ({
  createPosts: after_.createPosts - before_.createPosts,
  dispatchPosts: after_.dispatchPosts - before_.dispatchPosts,
  codebasePosts: after_.codebasePosts - before_.codebasePosts,
  setProjectPosts: after_.setProjectPosts - before_.setProjectPosts,
});
const assertNoDispatchShapedWrites = (delta, allowedCodebases = 0) => {
  assert.equal(delta.createPosts, 0, 'run creation moved: ' + JSON.stringify(delta));
  assert.equal(delta.dispatchPosts, 0, 'dispatch moved: ' + JSON.stringify(delta));
  assert.equal(delta.setProjectPosts, 0, 'project binding moved: ' + JSON.stringify(delta));
  assert.equal(delta.codebasePosts, allowedCodebases, 'unexpected codebase registrations: ' + JSON.stringify(delta));
};

async function runCase(caseName, home, arg, archonBase, extraEnv = {}, timeoutMs = 120000) {
  const args = [join(ROOT, 'test', 'marketplace-case.mjs'), caseName, home, JSON.stringify(arg)];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_OPERATOR_UI_ARCHON: archonBase,
      [TOKEN_VARS.root]: TOKENS.root,
      [TOKEN_VARS.alice]: TOKENS.alice,
      [TOKEN_VARS.bob]: TOKENS.bob,
      ...extraEnv,
    },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    err += d;
  });
  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('case ' + caseName + ' timed out after ' + timeoutMs + 'ms\nstderr: ' + err));
    }, timeoutMs);
    child.on('exit', (c) => {
      clearTimeout(t);
      resolve(c);
    });
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
  assert.equal(code, 0, 'case ' + caseName + ' exited ' + code + '\nstderr: ' + err + '\nstdout: ' + out);
  if (process.env.MKT_DEBUG) console.log('\n[MKT_DEBUG ' + caseName + ' stdout]\n' + out + '\n[stderr]\n' + err);
  const lines = out.trim().split('\n');
  const result = JSON.parse(lines[lines.length - 1]);
  const failed = (result.checks || []).filter((c) => !c.pass);
  assert.deepEqual(failed, [], 'case ' + caseName + ' failed checks:\n' + JSON.stringify(failed, null, 2));
  return result;
}

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'p4-market-'));
  registryPath = join(tmpRoot, 'registry.json');
  await writeFile(registryPath, JSON.stringify(REGISTRY, null, 2));
  workflowsDir = await newDir('workflows');
  dirs.homePlain = await newDir('home-plain');
  dirs.homeDiscovery = await newDir('home-discovery');
  dirs.homeImport = await newDir('home-import');
  dirs.homeUnconfigured = await newDir('home-unconfigured');
  dirs.homeAuth = await newDir('home-auth');
  dirs.homeIsolation = await newDir('home-isolation');
  dirs.homeRegistry = await newDir('home-registry');
  dirs.homeGuided = await newDir('home-guided');
  dirs.guidedRoot = await newDir('guided-root');
  dirs.homeGuidedUnconfig = await newDir('home-guided-unconfig');
  dirs.homeBeginner = await newDir('home-beginner');
  dirs.beginnerRoot = await newDir('beginner-root');

  let stale = false;
  for (const base of [BASE_PLAIN, BASE_MARKET]) {
    try {
      stale = (await fetch(base + '/api/health')).ok;
    } catch {}
    if (stale) throw new Error('a mock archon is already listening at ' + base + ' — kill it first');
  }
  plainProc = await spawnMock(PORT_PLAIN, false);
  marketProc = await spawnMock(PORT_MARKET, true);

  // The world verdicts, verified from the parent before any plugin runs:
  // PLAIN exposes no openapi at all; MARKET advertises the namespace.
  const plainOpenapi = await fetch(BASE_PLAIN + '/api/openapi.json');
  assert.equal(plainOpenapi.status, 404, 'the PLAIN mock must not advertise an openapi document');
  const marketOpenapi = await (await fetch(BASE_MARKET + '/api/openapi.json')).json();
  const marketPaths = Object.keys(marketOpenapi.paths || {});
  assert.ok(marketPaths.some((p) => p.startsWith('/api/marketplace/')), 'the MARKET mock must advertise the marketplace namespace');
});

after(async () => {
  if (plainProc) plainProc.kill('SIGKILL');
  if (marketProc) marketProc.kill('SIGKILL');
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

// ----------------------------------------------------------------- gate tests

test('P4 discovery: unsupported install degrades honestly; /archon untouched; zero writes', async () => {
  const before_ = await mockCalls(BASE_PLAIN);
  // The install TARGET is configured — the unsupported verdict must come from
  // feature detection, not from an unconfigured-target shortcut.
  const result = await runCase('unsupported', dirs.homePlain, { config: { marketplace: { workflowsDir } }, mockBase: BASE_PLAIN }, BASE_PLAIN);
  const after_ = await mockCalls(BASE_PLAIN);
  // 1 codebase registration: the workspace setup that lets the import probe
  // reach feature detection (the workspace rung precedes it in the ladder).
  assertNoDispatchShapedWrites(writeDelta(before_, after_), 1);
  assert.equal(result.ok, true);
});

test('P4 discovery: supported install lists scoped entries; inspection shows pin/evidence without source bytes', async () => {
  const before_ = await mockCalls(BASE_MARKET);
  const result = await runCase('discovery', dirs.homeDiscovery, { config: {}, mockBase: BASE_MARKET }, BASE_MARKET);
  const after_ = await mockCalls(BASE_MARKET);
  assertNoDispatchShapedWrites(writeDelta(before_, after_), 0);
  assert.equal(result.ok, true);
});

test('P4 import: every security/content/admission refusal fails closed with zero orchestrator writes; two legal installs land', async () => {
  const before_ = await mockCalls(BASE_MARKET);
  const result = await runCase(
    'import-refusals',
    dirs.homeImport,
    {
      config: { registry: { path: registryPath }, marketplace: { workflowsDir } },
      mockBase: BASE_MARKET,
    },
    BASE_MARKET,
  );
  const after_ = await mockCalls(BASE_MARKET);
  assertNoDispatchShapedWrites(writeDelta(before_, after_), 1); // the one codebase registration is the case's own workspace setup
  assert.equal(result.ok, true);
});

test('P4 import: unconfigured target refuses first — nothing fetched, nothing written', async () => {
  const before_ = await mockCalls(BASE_MARKET);
  const result = await runCase('import-unconfigured', dirs.homeUnconfigured, { config: { registry: { path: registryPath } }, mockBase: BASE_MARKET }, BASE_MARKET);
  const after_ = await mockCalls(BASE_MARKET);
  assertNoDispatchShapedWrites(writeDelta(before_, after_), 0);
  assert.equal(result.ok, true);
});

test('P4 import: a configured-but-unreadable registry fails closed at admission with zero writes', async () => {
  const badRegistry = join(tmpRoot, 'registry-unreadable.json');
  await writeFile(badRegistry, '{ this is not json');
  const before_ = await mockCalls(BASE_MARKET);
  const result = await runCase(
    'registry-unreadable',
    dirs.homeRegistry,
    { config: { registry: { path: badRegistry }, marketplace: { workflowsDir } }, mockBase: BASE_MARKET },
    BASE_MARKET,
  );
  const after_ = await mockCalls(BASE_MARKET);
  assertNoDispatchShapedWrites(writeDelta(before_, after_), 1); // the case's own workspace setup
  assert.equal(result.ok, true);
});

test('P4 authorization: owner/workspace/environment refusals precede ALL marketplace contact; required-mode import works once authorized', async () => {
  const before_ = await mockCalls(BASE_MARKET);
  const result = await runCase(
    'auth-refusals',
    dirs.homeAuth,
    {
      config: { ...requiredConfig(), registry: { path: registryPath }, marketplace: { workflowsDir } },
      mockBase: BASE_MARKET,
      tokens: TOKENS,
    },
    BASE_MARKET,
  );
  const after_ = await mockCalls(BASE_MARKET);
  assertNoDispatchShapedWrites(writeDelta(before_, after_), 3); // alice + bob + alice-remote workspaces created by the case itself
  assert.equal(result.ok, true);
});

test('P4 promotion isolation: an import leaves registry bytes, the capability list, and teaching untouched; record states the closed door', async () => {
  const before_ = await mockCalls(BASE_MARKET);
  const result = await runCase(
    'promotion-isolation',
    dirs.homeIsolation,
    {
      config: { ...requiredConfig(), registry: { path: registryPath }, marketplace: { workflowsDir } },
      mockBase: BASE_MARKET,
      tokens: TOKENS,
      registryPath,
    },
    BASE_MARKET,
  );
  const after_ = await mockCalls(BASE_MARKET);
  assertNoDispatchShapedWrites(writeDelta(before_, after_), 1);
  assert.equal(result.ok, true);
});

// ------------------------------------------------------- P5 guided creation

test('P5 guided creation: server-minted paths under the configured root; unsafe labels, smuggled paths, impersonation, unattributed principals, and missing adapters all fail closed', async () => {
  const before_ = await mockCalls(BASE_MARKET);
  const result = await runCase(
    'workspace-guided',
    dirs.homeGuided,
    {
      config: guidedConfig(),
      mockBase: BASE_MARKET,
      tokens: TOKENS,
      guidedRoot: dirs.guidedRoot,
    },
    BASE_MARKET,
  );
  const after_ = await mockCalls(BASE_MARKET);
  assertNoDispatchShapedWrites(writeDelta(before_, after_), 2); // the two happy-path guided creates only
  assert.equal(result.ok, true);
});

test('P5 guided creation: unconfigured root refuses closed (no guessed path); the advanced path-supplied flow still works', async () => {
  const before_ = await mockCalls(BASE_MARKET);
  const result = await runCase(
    'workspace-guided-unconfigured',
    dirs.homeGuidedUnconfig,
    { config: { marketplace: { workflowsDir } }, mockBase: BASE_MARKET },
    BASE_MARKET,
  );
  const after_ = await mockCalls(BASE_MARKET);
  assertNoDispatchShapedWrites(writeDelta(before_, after_), 1); // the advanced positive control
  assert.equal(result.ok, true);
});

test('P5 beginner flow: seven gate stages from an empty store — execution honestly UNVERIFIED, admission honestly closed', async () => {
  const before_ = await mockCalls(BASE_MARKET);
  const registryBefore = await readFile(registryPath, 'utf8');
  const result = await runCase(
    'beginner-flow',
    dirs.homeBeginner,
    {
      config: { ...requiredConfig(), registry: { path: registryPath }, marketplace: { workflowsDir }, workspaces: { root: dirs.beginnerRoot } },
      mockBase: BASE_MARKET,
      tokens: TOKENS,
      registryPath,
      beginnerRoot: dirs.beginnerRoot,
    },
    BASE_MARKET,
  );
  const after_ = await mockCalls(BASE_MARKET);
  assertNoDispatchShapedWrites(writeDelta(before_, after_), 1); // the one guided provisioning create
  // the gate's shape: seven named stages, each honestly labeled
  const stages = result.stages || [];
  assert.equal(stages.length, 7);
  assert.deepEqual(
    stages.map((s) => s.stage),
    ['workspace-provisioning', 'discovery', 'inspection', 'import', 'execution-authorization', 'execution-verification', 'capability-admission'],
  );
  const unverified = stages.filter((s) => s.verdict === 'UNVERIFIED').map((s) => s.stage);
  assert.deepEqual(unverified, ['execution-verification'], 'only real-execution may be UNVERIFIED');
  for (const s of stages) {
    if (s.stage !== 'execution-verification') assert.equal(s.verdict, 'PASS', s.stage + ': ' + s.detail);
  }
  // and the parent re-asserts the registry itself never moved
  assert.equal(await readFile(registryPath, 'utf8'), registryBefore);
});
