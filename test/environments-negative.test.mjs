// P3A environment-model negatives — the PARENT half.
//
// The child proves the response; this file proves what actually reached the
// orchestrator (codebase registrations, conversation creations, dispatches) and
// what the run records themselves claim. Each case runs in its OWN child process
// with a fresh DSH_HOME and its own environment declarations, because the plugin
// reads config per call but caches task envelopes in module state — restart
// semantics only prove anything across real process boundaries.
//
// What is under test is the environment model introduced in P3A:
//   * a workspace is bound to the environment that created it (mismatch refuses)
//   * a declared-but-unimplemented adapter refuses to dispatch
//   * an environment scoped to other owners refuses selection, by id and by default
//   * execution identity is established by the execution path, so a run claiming a
//     provider no environment declares blocks instead of shipping
//   * the read-only environment surface exposes names and presence, never secrets
//
// The mock archon carries the claim arm (/api/_mock/claim-next-dispatch) because a
// provider claim has to be established by the execution path — a test cannot assert
// what a real run record says without a real run record saying it.
//
// Two refusal shapes, and these tests keep them apart:
//   * POST /workspace throws, so a refusal reaches the caller as a transport error
//     carrying `code` (409/403/501/400)
//   * POST /goal records a verdict, so a refusal answers 200 with a FAILED goal whose
//     failureCodes name it and whose task envelope persists — the same 200 shape a
//     shipped goal has, because "accepted and refused" is a product outcome, not a
//     malformed request

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, mkdir, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = 13779;
const BASE = 'http://127.0.0.1:' + PORT;

// The same single-capability registry the other E2E files use: one objective that
// routes deterministically to one workflow, so a dispatch is unambiguous.
const REGISTRY = {
  capabilities: [
    {
      id: 'verify-echo',
      objective: 'verify echo running total seed values',
      workflow: 'verify-echo-v1',
      tags: ['verify', 'echo', 'running', 'total', 'seed', 'values'],
      requires: ['shell:execute'],
      verification: { terminalStatus: 'completed', expectOutput: 'rcos-verify-seed:rcos-verify-echo-v1' },
      objectiveEvaluation: { kind: 'output-contains', value: 'rcos-verify-seed:rcos-verify-echo-v1' },
    },
    {
      // P6D: the bridge-declaring capability. Same workflow as verify-echo (so
      // the mock's run record and seeded output are identical); the bridge field
      // names the WORKER environment this goal's receipt must account for.
      id: 'verify-bridge',
      objective: 'verify bridge receipt claim',
      workflow: 'verify-echo-v1',
      tags: ['verify', 'bridge', 'receipt', 'claim'],
      requires: ['shell:execute'],
      verification: { terminalStatus: 'completed', expectOutput: 'rcos-verify-seed:rcos-verify-echo-v1' },
      objectiveEvaluation: { kind: 'output-contains', value: 'rcos-verify-seed:rcos-verify-echo-v1' },
      bridge: { environmentId: 'env-sandbox' },
    },
  ],
};

const SENTINEL = 'e2e-secret-sentinel-8c41f0';
const TOKEN_VAR = 'DSH_E2E_REMOTE_TOKEN';
// A NAME the child never sets: the solari token leg refuses before client
// construction on any machine, regardless of what the host exports.
const TOKEN_SOLARI = 'DSH_E2E_SOLARI_TOKEN';

const archonHttp = (providerId, extra = {}) => ({
  kind: 'custom-remote',
  providerId,
  adapter: { kind: 'archon-http', transport: { baseUrl: BASE, timeoutMs: 5000, ...(extra.transport || {}) } },
  ...extra,
});

// Per-case environment declarations, written by the child into its own
// $DSH_HOME/operator-ui.config.json before the plugin is imported.
const CONFIGS = {
  'environments-route': {
    environments: {
      defaultId: 'env-remote',
      list: [
        // Reserved id: env-local is synthesized, never declared.
        archonHttp('impostor', { environmentId: 'env-local', kind: 'custom-remote' }),
        archonHttp('archon-remote', { environmentId: 'env-remote', label: 'Remote', transport: { tokenVar: TOKEN_VAR } }),
        // Declared, inspectable, and not executable by this build.
        { environmentId: 'env-sandbox', kind: 'solari-cloud', providerId: 'solari-dev', adapter: { kind: 'solari-sandbox', transport: {} } },
        // tokenVar is a secret VALUE, not an env-var name — the entry must drop.
        archonHttp('archon-rogue', { environmentId: 'env-rogue', transport: { tokenVar: 'sk-live-abc123' } }),
      ],
    },
  },
  'env-mismatch': {
    environments: {
      list: [archonHttp('archon-remote', { environmentId: 'env-remote' }), { environmentId: 'env-sandbox', kind: 'solari-cloud', providerId: 'solari-dev', adapter: { kind: 'solari-sandbox', transport: {} } }],
    },
  },
  // P6A rename: the solari adapter IS implemented now (execution-worker role);
  // the boundary this case proves is the orchestrator seam, not the adapter seam.
  'solari-boundary': {
    environments: {
      list: [
        { environmentId: 'env-sandbox', kind: 'solari-cloud', providerId: 'solari-dev', adapter: { kind: 'solari-sandbox', transport: { tokenVar: TOKEN_SOLARI } } },
        archonHttp('archon-remote', { environmentId: 'env-remote' }),
        // Both refusals apply; authorization is the earlier gate.
        archonHttp('archon-mixed', { environmentId: 'env-mixed', workspaceScope: { owners: ['someone-else'] } }),
      ],
    },
  },
  // The /solari route case shares the same declaration shape.
  'solari-route': {
    environments: {
      list: [
        { environmentId: 'env-sandbox', kind: 'solari-cloud', providerId: 'solari-dev', adapter: { kind: 'solari-sandbox', transport: { tokenVar: TOKEN_SOLARI, envAllowlist: ['DSH_E2E_ALLOWED_ONE', 'DSH_E2E_ALLOWED_MISSING'] } } },
        archonHttp('archon-remote', { environmentId: 'env-remote' }),
      ],
    },
  },
  'owner-scope': {
    environments: {
      defaultId: 'env-scoped',
      list: [archonHttp('archon-scoped', { environmentId: 'env-scoped', workspaceScope: { owners: ['scoped-owner'] } })],
    },
  },
  'provider-claims': {
    environments: {
      list: [archonHttp('archon-remote', { environmentId: 'env-remote' })],
    },
  },
  // P6D: the declared WORKER environment for the bridge goal. The goal itself
  // dispatches on Local (the synthesized default); env-sandbox is declared here
  // so the worker leg can resolve the capability's bridge.environmentId.
  'bridge-goal': {
    environments: {
      list: [
        { environmentId: 'env-sandbox', kind: 'solari-cloud', providerId: 'solari-dev', adapter: { kind: 'solari-sandbox', transport: { tokenVar: TOKEN_SOLARI } } },
      ],
    },
  },
};

let tmpRoot;
let registryPath;
let mockProc;
let wsRoot;
let wsDir;
let wsDir2;
const claimDirs = [];

const newHome = async (name) => {
  const dir = join(tmpRoot, 'home-' + name);
  await mkdir(dir, { recursive: true });
  return dir;
};

const newDir = async (name) => {
  const p = join(wsRoot, name);
  await mkdir(p, { recursive: true });
  return realpath(p);
};

const mockCalls = async () => {
  const b = await (await fetch(BASE + '/api/_mock/calls')).json();
  return {
    createPosts: b.createPosts,
    dispatchPosts: b.dispatchPosts,
    codebasePosts: b.codebasePosts,
    setProjectPosts: b.setProjectPosts,
  };
};

const delta = (before_, after_) => ({
  createPosts: after_.createPosts - before_.createPosts,
  dispatchPosts: after_.dispatchPosts - before_.dispatchPosts,
  codebasePosts: after_.codebasePosts - before_.codebasePosts,
  setProjectPosts: after_.setProjectPosts - before_.setProjectPosts,
});

const mockRuns = async () => (await (await fetch(BASE + '/api/workflows/runs?limit=100')).json()).runs;

// Spawn the case child and parse the LAST stdout line as its JSON result.
async function runCase(caseName, home, arg, timeoutMs = 120000) {
  const args = [join(ROOT, 'test', 'environments-case.mjs'), caseName, home];
  if (arg !== undefined) args.push(JSON.stringify(arg));
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_OPERATOR_UI_ARCHON: BASE,
      DSH_OPERATOR_UI_REGISTRY: registryPath,
      DSH_OPERATOR_UI_AUTHORITY_PRESET: 'AUTO_WITHIN_POLICY',
      DSH_HOME: home,
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
  assert.equal(code, 0, 'case ' + caseName + ' exited ' + code + '\nstderr: ' + err);
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

const caseArg = (name, extra) => ({
  config: CONFIGS[name],
  mockBase: BASE,
  wsDir,
  wsDir2,
  wsName: basename(wsDir),
  ...extra,
});

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'p3a-environments-'));
  registryPath = join(tmpRoot, 'registry.json');
  await writeFile(registryPath, JSON.stringify(REGISTRY, null, 2));

  // Real paths: the plugin records the path it was handed and the mock resolves it
  // too — resolving both here removes any symlinked-prefix ambiguity.
  wsRoot = join(tmpRoot, 'ws');
  wsDir = await newDir('ws-alpha');
  wsDir2 = await newDir('ws-beta');
  for (let i = 1; i <= 5; i += 1) claimDirs.push(await newDir('ws-claim-' + i));

  // Refuse to run against a stale mock on our port: leftover counters and a
  // leftover claim arm would corrupt the deltas and the run records.
  let stale = false;
  try {
    stale = (await fetch(BASE + '/api/health')).ok;
  } catch {}
  if (stale) throw new Error('a mock archon is already listening on 127.0.0.1:' + PORT + ' — kill it first');

  mockProc = spawn(process.execPath, [join(ROOT, 'scripts', 'mock-archon.mjs'), String(PORT)], { stdio: 'ignore' });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      if ((await fetch(BASE + '/api/health')).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('mock archon failed to start on :' + PORT);
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  if (mockProc) mockProc.kill('SIGKILL');
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the cases

test('environment surface: declares what is configured, names tokens without exposing them', async () => {
  const home = await newHome('surface');
  const before_ = await mockCalls();
  const r = await runCase('environments-route', home, caseArg('environments-route', { tokenVar: TOKEN_VAR, tokenValue: SENTINEL }));
  const d = delta(before_, await mockCalls());

  assert.equal(r.ok, true, JSON.stringify(r));

  // Read-only: the surface cannot be written through.
  assert.equal(r.postStatus, 405, 'POST /environments must be refused');
  assert.equal(r.postError, 'GET only');
  assert.equal(r.postHasCode, false, 'the 405 body carries no error code');

  // What is listed is what was declared: Local always first, the two well-formed
  // entries next, and the two malformed ones dropped rather than fatal.
  assert.equal(r.listStatus, 200);
  assert.equal(r.contract, 1, 'the environment contract is versioned');
  assert.deepEqual(r.ids, ['env-local', 'env-remote', 'env-sandbox'], 'env-local is synthesized; the reserved-id and raw-secret entries are dropped');
  assert.equal(r.defaultId, 'env-remote');
  assert.equal(r.localKind, 'local');
  assert.equal(r.localSource, 'synthesized-from-archon-config');
  assert.deepEqual(r.localOrchestrator, { id: 'archon', adapter: 'archon-http' }, 'Archon is the orchestrator, never an environment identity');
  assert.equal(r.remoteProviderId, 'archon-remote', 'the receipt names who executes, it does not infer it');
  assert.equal(r.remoteAdapter.kind, 'archon-http');
  assert.equal(r.remoteAdapter.implemented, true);
  assert.equal(r.remoteAdapter.tokenVar, TOKEN_VAR, 'a token is a NAME on this surface');
  assert.equal(r.remoteAdapter.tokenConfigured, true, 'presence is a boolean');
  assert.equal(r.remoteAdapter.baseUrl, BASE);
  assert.deepEqual(r.remoteScope, { owners: null }, 'no scope declared means any owner');
  assert.deepEqual(r.remoteOrchestrator, { id: 'archon', adapter: 'archon-http' });

  // The two ways a secret could have leaked, both read off the raw response text.
  assert.equal(r.textHasSentinel, false, 'the resolved token VALUE must never appear on the surface');
  assert.equal(r.textHasRawSecret, false, 'a tokenVar that is a secret value must be dropped, not echoed');
  assert.equal(r.textHasDroppedProvider, false, 'a dropped entry contributes nothing at all');

  assert.deepEqual(d, { createPosts: 0, dispatchPosts: 0, codebasePosts: 0, setProjectPosts: 0 }, 'reading the environment surface touches no orchestrator state');
});

test('environment mismatch: a bound workspace refuses another environment, identity before adapter', async () => {
  const home = await newHome('mismatch');
  const before_ = await mockCalls();
  const r = await runCase('env-mismatch', home, caseArg('env-mismatch'));
  const d = delta(before_, await mockCalls());

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.boundEnvironmentId, 'env-local', 'a workspace created with no environment named is bound to Local');

  // The workspace binding is the authority on which environment executes it. On the
  // goal path the refusal is a receipted verdict: 200, FAILED, and the code that says
  // why — the envelope persists so the refusal is auditable.
  assert.equal(r.wrongImpl, '200:FAILED:workspace-environment-mismatch', 'naming another environment for a bound workspace must be refused');
  // Identity precedes the adapter: the target here has no adapter in this build,
  // yet the refusal still names the binding, not the missing adapter.
  assert.equal(r.wrongUnimpl, '200:FAILED:workspace-environment-mismatch', 'the binding is checked before the adapter, so the code is not environment-adapter-missing');
  assert.equal(r.unimplEnvironment, null, 'a refused environment leaves no execution identity in the receipt');

  // Control: the same workspace executes normally when the binding decides.
  assert.equal(r.control, '200:SHIP:', 'the bound workspace must still execute');
  assert.equal(r.controlVerdict, 'SHIP', 'the control run ships');
  assert.equal(r.controlEnvironmentId, 'env-local');
  assert.equal(r.controlEstablishedBy, 'adopted-run', 'the identity is established by the execution path');
  assert.equal(r.controlIdentityEnvironment, 'env-local');

  // The store path enforces the same binding, and the orchestrator learns the path
  // before the refusal — so the codebase POST is the price of the refusal.
  assert.equal(r.rebound, '409:workspace-environment-mismatch', 'the same path cannot be re-bound to a second environment');

  assert.deepEqual(d, { createPosts: 1, dispatchPosts: 1, codebasePosts: 2, setProjectPosts: 0 }, 'exactly one dispatch; its project binding rode the create body, and both refusals stayed off the orchestrator');
});

test('solari boundary: an execution-worker-only environment refuses orchestrator dispatch', async () => {
  const home = await newHome('adapter');
  const before_ = await mockCalls();
  const r = await runCase('solari-boundary', home, caseArg('solari-boundary'));
  const d = delta(before_, await mockCalls());

  assert.equal(r.ok, true, JSON.stringify(r));

  // Implemented at the execution seam and inspectable. What is NOT deployed is
  // the orchestrator protocol inside the environment — a live-integration gate
  // (P6C), not something this build can fake.
  assert.equal(r.localPresent, true);
  assert.equal(r.sandboxImplemented, true, 'the solari-sandbox adapter is implemented (execution-worker role)');
  assert.equal(r.sandboxReason, null, 'no adapter gap remains — the refusal must name the orchestrator, not the adapter');
  assert.equal(r.remoteImplemented, true, 'an implemented adapter in the same config still reports implemented');

  // The goal path is the verdict shape (200 + FAILED); the workspace path is the
  // transport shape, because createWorkspace throws before any goal exists.
  assert.equal(r.goal, '200:FAILED:solari-orchestrator-not-deployed', 'dispatching into an execution-worker-only environment refuses at the protocol seam');
  assert.equal(r.goalEnvironment, null, 'the refusal leaves no execution identity in the receipt');
  assert.equal(r.workspace, '501:solari-orchestrator-not-deployed', 'a workspace must not be created where no orchestrator is deployed');

  // Unauthorized AND protocol-less: the earlier gate answers.
  assert.equal(r.mixed, '200:FAILED:environment-unauthorized', 'authorization is checked before the protocol seam');
  // Unknown id: the caller asked for something that does not exist.
  assert.equal(r.unknown, '200:FAILED:environment-not-found');

  assert.deepEqual(d, { createPosts: 0, dispatchPosts: 0, codebasePosts: 0, setProjectPosts: 0 }, 'not one refusal may reach the orchestrator');
});

test('solari route: readiness is a pure read and every run refusal is free', async () => {
  const home = await newHome('solari-route');
  const before_ = await mockCalls();
  const r = await runCase('solari-route', home, caseArg('solari-route'));
  const d = delta(before_, await mockCalls());

  assert.equal(r.ok, true, JSON.stringify(r));

  assert.equal(r.status, '200:null', 'status is a plain readiness read');
  assert.equal(r.statusEnvironmentId, 'env-sandbox');
  assert.equal(r.readiness.role, 'execution-worker', 'the adapter owns the execution-worker role only');
  assert.equal(r.readiness.liveCertified, false, 'nothing claims live certification — that is the P6B gate');
  assert.equal(typeof r.readiness.sdkPresent, 'boolean', 'SDK presence is reported as a fact, never asserted');
  assert.equal(r.readiness.tokenConfigured, false, 'the test token var is never set; readiness reports presence booleans only');
  assert.equal(r.readiness.tokenVar, 'DSH_E2E_SOLARI_TOKEN');
  assert.equal(r.readiness.documentedBaseUrl, 'https://api.getsolari.com');
  assert.equal(r.readiness.carriesCredential, false, 'readiness carries presence booleans, never a credential value or field');
  assert.equal(r.defaultOp, '200:null', 'GET without op defaults to status');

  // The refusal ladder, cheapest first. Over-cap refusing with NO token set
  // (while the plain run refuses 409 token-missing) proves budget refusals are
  // free and ordered before readiness.
  assert.equal(r.runNoReason, '400:solari-reason-required');
  assert.equal(r.runShell, '400:solari-capability-unsupported', 'a raw shell string is refused, naming the documented argv form');
  assert.equal(r.runEnvValues, '400:solari-env-values-forbidden', 'inline env values are refused outright');
  assert.equal(r.readiness.envAllowlistConfigured, true, 'readiness reports that an allowlist is configured');
  assert.equal(r.readiness.envAllowlistCount, 2, 'readiness reports the allowlist shape — names stay server-side');
  assert.equal(r.runEnvNotAllowed, '400:solari-env-not-allowed', 'an undeclared name refuses even though the variable EXISTS in the server process');
  assert.equal(r.runEnvPrivileged, '403:solari-env-privileged', 'the credential var\'s own name is privileged and never forwardable');
  assert.equal(r.runOverCap, '403:solari-budget-over-cap', 'over-cap budget refuses before readiness — no token needed to be refused');
  assert.equal(r.runCustomTpl, '400:solari-capability-unsupported', 'custom templates sit behind the documented paid-plan gate');
  assert.equal(r.runNoToken, '409:solari-token-missing', 'the token refusal is the last free one — nothing was ever constructed');
  assert.equal(r.wrongAdapter, '400:solari-adapter-mismatch', 'the route serves solari-sandbox adapters only');
  assert.equal(r.killUnknown, '409:solari-sandbox-unknown');
  assert.equal(r.badOp, '400:solari-op-unsupported');
  assert.equal(r.noEnv, '400:environment-id-required');

  assert.deepEqual(d, { createPosts: 0, dispatchPosts: 0, codebasePosts: 0, setProjectPosts: 0 }, 'no leg of this route may touch the orchestrator');
});

test('owner scope: a scoped environment refuses outsiders by id and by default, and still serves its owner', async () => {
  const home = await newHome('scope');
  const before_ = await mockCalls();
  const r = await runCase('owner-scope', home, caseArg('owner-scope'));
  const d = delta(before_, await mockCalls());

  assert.equal(r.ok, true, JSON.stringify(r));

  assert.equal(r.byId, '200:FAILED:environment-unauthorized', 'naming an environment scoped to other owners must be refused');
  // The stronger leg: the caller never named it — the configured default did.
  assert.equal(r.byDefault, '200:FAILED:environment-unauthorized', 'the default environment\'s scope is enforced, not bypassed');
  assert.equal(r.byDefaultEnvironment, null, 'a refused default leaves no execution identity in the receipt');

  assert.equal(r.defaultId, 'env-scoped', 'the scope is visible on the surface, and it is the configured default');
  assert.deepEqual(r.scopedScope, { owners: ['scoped-owner'] });
  assert.equal(r.scopedKind, 'custom-remote');
  assert.equal(r.scopedProviderId, 'archon-scoped');

  // The same scope answers on the workspace path, where a refusal is a transport
  // error: an unqualified creation takes the configured default, and the default is
  // scoped to someone else.
  assert.equal(r.unqualified, '403:environment-unauthorized', 'the default\'s scope is enforced on the workspace path too');

  // Local stays operational: the product path does not become unusable because a
  // scoped environment is the default.
  assert.equal(r.control, '200:SHIP:', 'a Local workspace must still execute');
  assert.equal(r.controlVerdict, 'SHIP');
  assert.equal(r.controlEnvironmentId, 'env-local');

  // A scope is a scope, not a wall: the named owner may select it.
  assert.equal(r.allowed, '200:', 'the scoped owner may create a workspace in it');
  assert.equal(r.allowedEnvironmentId, 'env-scoped', 'and the workspace records that binding');

  assert.deepEqual(d, { createPosts: 1, dispatchPosts: 1, codebasePosts: 2, setProjectPosts: 0 }, 'the refusals cost nothing; the two allowed creations cost one codebase each, and one dispatch bound its project at creation');
});

test('provider claims: a run claiming an undeclared provider blocks instead of shipping', async () => {
  const home = await newHome('claims');
  const before_ = await mockCalls();
  const claims = [
    { label: 'no-claim', provider: null, dir: claimDirs[0] },
    { label: 'declared', provider: 'archon-local', dir: claimDirs[1] },
    { label: 'empty', provider: '', dir: claimDirs[2] },
    { label: 'other-environment', provider: 'archon-remote', dir: claimDirs[3] },
    { label: 'unknown-provider', provider: 'aws-lambda', dir: claimDirs[4] },
  ];
  const r = await runCase('provider-claims', home, caseArg('provider-claims', { claims }));
  const d = delta(before_, await mockCalls());

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.legs.length, 5);
  const byLabel = {};
  for (const leg of r.legs) byLabel[leg.label] = leg;

  // Every leg executed in Local, under the identity the execution path established.
  for (const leg of r.legs) {
    assert.equal(leg.status, 200, leg.label + ' must answer 200 — enforcement is a verdict, not a transport error');
    assert.equal(leg.environmentId, 'env-local', leg.label + ' executed in Local');
    assert.equal(leg.providerDeclared, 'archon-local', leg.label + ' recorded the declared provider');
    assert.equal(leg.establishedBy, 'adopted-run', leg.label + ' identity established by the execution path');
    assert.equal(leg.checkCount, 1, leg.label + ' carries exactly one execution-provider-claim check');
    assert.equal(leg.hasLabel, false, leg.label + ' receipt records identity, not a display label');
    assert.equal(leg.hasTransport, false, leg.label + ' receipt records identity, not transport details');
    assert.match(String(leg.identitySha256), /^sha256:[0-9a-f]{64}$/, leg.label + ' identity hash is a prefixed sha256');
    assert.equal(leg.executionStatus, 'completed', leg.label + ' the run itself completed');
  }

  // Silence is not a claim: nothing asserted, nothing violated.
  assert.equal(byLabel['no-claim'].verdict, 'SHIP');
  assert.equal(byLabel['no-claim'].providerClaim.status, 'not-claimed');
  assert.equal(byLabel['no-claim'].providerClaim.ok, true);
  assert.equal(byLabel['no-claim'].checkPass, true);

  // A run that claims exactly what its environment declared is accounted for.
  assert.equal(byLabel['declared'].verdict, 'SHIP');
  assert.equal(byLabel['declared'].providerClaim.status, 'matches');
  assert.equal(byLabel['declared'].providerClaim.ok, true);
  assert.equal(byLabel['declared'].checkPass, true);

  // An empty claim is normalised away, never read as a provider named ''.
  assert.equal(byLabel['empty'].verdict, 'SHIP');
  assert.equal(byLabel['empty'].providerClaim.status, 'not-claimed');
  assert.equal(byLabel['empty'].providerClaim.ok, true);

  // Another environment's provider is a mismatch: blocked, not failed.
  assert.equal(byLabel['other-environment'].verdict, 'BLOCK', 'a claim the bound environment cannot account for must block');
  assert.ok(byLabel['other-environment'].failureCodes.includes('execution-provider-mismatch'), 'the failure code names the mismatch');
  assert.equal(byLabel['other-environment'].providerClaim.status, 'mismatch');
  assert.equal(byLabel['other-environment'].providerClaim.ok, false);
  assert.equal(byLabel['other-environment'].providerClaim.declared, 'archon-local');
  assert.equal(byLabel['other-environment'].providerClaim.claimed, 'archon-remote');
  assert.equal(byLabel['other-environment'].checkPass, false, 'the receipt records the failed check, not just the verdict');

  // A provider no configured environment declares is unsupported.
  assert.equal(byLabel['unknown-provider'].verdict, 'BLOCK');
  assert.ok(byLabel['unknown-provider'].failureCodes.includes('execution-provider-unsupported'), 'an undeclared provider is unsupported, not a mismatch');
  assert.equal(byLabel['unknown-provider'].providerClaim.status, 'unsupported');
  assert.equal(byLabel['unknown-provider'].checkPass, false);

  // The hash is a witness of the tuple, not decoration. Recomputed from the receipt's
  // own fields it must reproduce the recorded value — and substituting the claim must
  // change it, or the "witness" is not witnessing the claim at all.
  const recompute = (leg, claim) =>
    'sha256:' +
    createHash('sha256')
      .update(JSON.stringify([
        leg.environmentId, leg.orchestratorId, leg.orchestratorAdapter, leg.providerDeclared,
        leg.establishedBy, leg.runId, leg.workflowName, leg.conversationId, leg.codebaseId,
        leg.workingPath, claim,
      ]))
      .digest('hex');

  for (const leg of r.legs) {
    assert.equal(recompute(leg, leg.providerClaim.claimed), leg.identitySha256, leg.label + ': the recorded hash must be the hash of the recorded tuple');
  }
  assert.notEqual(
    recompute(byLabel['declared'], 'archon-remote'),
    byLabel['declared'].identitySha256,
    'the claim must be load-bearing in the witnessed tuple, not a field beside it',
  );

  // Two-sided: the claim was on the RUN RECORD the plugin adopted, not only in the
  // receipt it wrote. The orchestrator is where the claim came from, so the raw
  // armed value is what the record must carry — normalisation happens in the
  // receipt, never in the record.
  const runs = await mockRuns();
  for (const leg of r.legs) {
    const run = runs.find((x) => x.id === leg.runId);
    assert.ok(run, leg.label + ': no run record for ' + leg.runId);
    const armed = claims.find((c) => c.label === leg.label).provider;
    const recorded = run.execution_provider === undefined ? null : run.execution_provider;
    assert.equal(recorded, armed, leg.label + ': the run record must carry the claim the receipt judged');
  }

  assert.deepEqual(d, { createPosts: 5, dispatchPosts: 5, codebasePosts: 5, setProjectPosts: 0 }, 'five executions, five workspaces, five bindings at creation — nothing extra');
});

test('execution bridge: a bridge-declaring goal without a loadable receipt blocks, and a control goal keeps the pre-P6D shape', async () => {
  const home = await newHome('bridge');
  const before_ = await mockCalls();
  const r = await runCase('bridge-goal', home, caseArg('bridge-goal'));
  const d = delta(before_, await mockCalls());

  assert.equal(r.ok, true, JSON.stringify(r));

  // The run itself was green — that is exactly the case the second witness
  // exists for: a completed, output-matching, objectively SATISFIED execution
  // whose bridge receipt is missing must still fail closed.
  assert.equal(r.bridgeStatus, 200, 'enforcement is a verdict, not a transport error');
  assert.equal(r.bridgeVerdict, 'BLOCK', 'a green objective never ships a bridge goal whose receipt is missing');
  assert.ok(r.bridgeFailureCodes.includes('bridge-receipt-missing'), JSON.stringify(r.bridgeFailureCodes));
  assert.equal(r.bridgeExecutionStatus, 'completed', 'the underlying run DID complete — the block is about the receipt, not the run');

  // The worker leg is stamped and names the missing receipt honestly.
  assert.equal(r.hasWorkerKey, true, 'a bridge-declaring goal records its worker leg');
  assert.equal(r.worker.establishedBy, 'bridge-receipt');
  assert.equal(r.worker.status, 'missing');
  assert.equal(r.worker.ok, false);
  assert.equal(r.worker.code, 'bridge-receipt-missing');
  assert.equal(r.worker.id, null, 'no bridge id was found in the evidence');
  assert.equal(r.worker.environmentId, 'env-sandbox', 'the capability-declared worker environment is what the goal is checked against');
  // Every field the missing branch does not assert is recorded as null — never
  // invented, never left to inference.
  assert.equal(r.worker.claimed, null);
  assert.equal(r.worker.declared, null);
  assert.equal(r.worker.identitySha256, null);
  assert.equal(r.worker.receiptSha256, null);
  assert.equal(r.worker.runExitCode, null);
  assert.equal(r.worker.cleanupOk, null);
  assert.equal(r.worker.dead, null);
  assert.equal(r.worker.posture, null);

  // The receipt carries the failed check, not just the verdict.
  assert.equal(r.bridgeCheckCount, 1, 'exactly one bridge-provider-claim check');
  assert.equal(r.bridgeCheckPass, false);

  // The dispatch leg is untouched by the worker leg: silence on the run record
  // is still not a claim.
  assert.equal(r.claimCheckCount, 1, 'exactly one execution-provider-claim check');
  assert.equal(r.claimCheckPass, true, 'the dispatch leg passes — the block comes from the worker leg alone');
  assert.deepEqual(r.failingChecks, ['bridge-provider-claim'], 'the ONLY failing check is the bridge one');

  assert.match(String(r.bridgeRunId), /\S/, 'the bridge goal still adopted its dispatch run');

  // Additivity: the same dispatch, an objective routed to the non-bridge
  // capability — receipt shape exactly as before P6D.
  assert.equal(r.controlStatus, 200);
  assert.equal(r.controlVerdict, 'SHIP', 'a goal that declares no bridge is unaffected by the bridge machinery');
  assert.deepEqual(r.controlFailureCodes, []);
  assert.equal(r.controlHasWorker, false, 'no worker key exists on a receipt that never declared a bridge');
  assert.equal(r.controlBridgeCheckCount, 0, 'no bridge-provider-claim check exists on a non-bridge goal');
  assert.deepEqual(r.controlFailingChecks, [], 'the control receipt passes every check it carries');
  assert.equal(r.controlEstablishedBy, 'adopted-run', 'the control identity comes from the dispatch leg alone');
  assert.equal(r.controlIdentityEnvironment, 'env-local');

  // One workspace, two goals: two bindings at creation, one codebase for the
  // single workspace, two dispatches, no conversation messages.
  assert.deepEqual(d, { createPosts: 2, dispatchPosts: 2, codebasePosts: 1, setProjectPosts: 0 }, 'one workspace, two goals — goals add no codebase work, and dispatch sends no conversation message');
});
