// P3A environment-model negatives — the CHILD half.
//
// Boots the REAL plugin surface (lib/index.js apply(ctx)) against a ctx stub that
// only captures what the plugin registers, serves those captured routes over a
// real HTTP listener on an ephemeral port, and drives the environment refusal
// paths with real HTTP requests.
//
// Every environment under test is declared the way a deployment declares one: a
// real operator-ui.config.json in this case's own $DSH_HOME. Nothing here reaches
// an environment through a test-only seam, and nothing mocks lib/environments.js —
// the refusals are the product's own.
//
// Protocol (same shape as workspace-case.mjs): node test/environments-case.mjs
// <case> <dshHome> [jsonArg]. One JSON line on stdout, last line wins. Exit 0
// carries the case's own verdict in `ok`; exit 1 is reserved for an unexpected
// throw outside the case.

import { createServer } from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const caseName = process.argv[2];
const dshHome = process.argv[3];
const arg = process.argv[4] ? JSON.parse(process.argv[4]) : {};

process.env.DSH_HOME = dshHome;
if (arg.tokenVar && arg.tokenValue) process.env[arg.tokenVar] = arg.tokenValue;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ROUTE = '/plugins/operator-ui';
const OWNER = 'e2e-owner';
const OBJECTIVE = 'verify echo running total seed values';

// The declaration file is written BEFORE the plugin is imported. The plugin reads
// its config fresh on every call, so this is the same path a restarted deployment
// would take — not an in-memory injection.
if (arg.config !== undefined) {
  await mkdir(dshHome, { recursive: true });
  await writeFile(join(dshHome, 'operator-ui.config.json'), JSON.stringify(arg.config, null, 2));
}

const routes = [];
const teardowns = [];
const ctx = {
  webServer: {
    register(spec) {
      routes.push(spec);
      return () => {};
    },
  },
  tools: {
    register() {
      return () => {};
    },
  },
  effect(fn) {
    const t = fn();
    if (typeof t === 'function') teardowns.push(t);
    return () => {};
  },
};

const { apply } = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href);
apply(ctx);

// Exact routes first, then the longest matching prefix — the same dispatch rule
// the plugin's own host applies.
function matchRoute(pathname) {
  let best = null;
  for (const r of routes) {
    if (r.kind === 'exact') {
      if (r.path === pathname) return r;
    } else if (r.kind === 'prefix') {
      if (pathname === r.path || pathname.startsWith(r.path + '/')) {
        if (!best || r.path.length > best.path.length) best = r;
      }
    }
  }
  return best;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = matchRoute(url.pathname);
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'no route' }));
    return;
  }
  try {
    await route.handler(req, res, url);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    }
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

async function call(method, path, body) {
  const res = await fetch(base + ROUTE + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

// Mock archon admin surface, reached directly (never through the plugin): the
// claim arms are what make a run record assert a provider the environment did
// not declare.
async function mockCall(path, body) {
  const res = await fetch(arg.mockBase + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

const codeOf = (r) => (r.json && r.json.code) || null;
const tag = (r) => r.status + ':' + (codeOf(r) || '');
const goalOf = (r) => (r.json && r.json.goal) || null;
// The goal path answers 200 with a verdict: a refusal there is a receipted FAILED
// goal, not a transport error. This tag keeps the refusal's code visible.
const goalTag = (r) => {
  const g = goalOf(r);
  if (!g) return tag(r);
  return r.status + ':' + g.verdict + ':' + ((g.failureCodes && g.failureCodes[0]) || '');
};

function assertRoutes() {
  const paths = routes.map((r) => r.path);
  const missing = [ROUTE].filter((p) => !paths.includes(p));
  return missing.length ? { ok: false, error: 'plugin registered no route at ' + missing.join(', '), registered: paths } : null;
}

const cases = {};

// ---------------------------------------------------------------------------
// The read-only environment surface: what a declared environment exposes, and
// the two ways a secret must never appear on it.
cases['environments-route'] = async () => {
  const post = await call('POST', '/environments', {});
  const list = await call('GET', '/environments');
  const body = list.json || {};
  const envs = Array.isArray(body.environments) ? body.environments : [];
  const byId = (id) => envs.find((e) => e.environmentId === id) || null;
  const remote = byId('env-remote');
  const local = byId('env-local');

  return {
    ok: true,
    postStatus: post.status,
    postError: post.json && post.json.error,
    postHasCode: !!(post.json && post.json.code),
    listStatus: list.status,
    contract: body.contract,
    defaultId: body.defaultId,
    ids: envs.map((e) => e.environmentId),
    localKind: local && local.kind,
    localSource: local && local.source,
    localOrchestrator: local && local.orchestrator,
    remoteProviderId: remote && remote.providerId,
    remoteAdapter: remote && remote.adapter,
    remoteScope: remote && remote.workspaceScope,
    remoteOrchestrator: remote && remote.orchestrator,
    // The raw response text — what actually crossed the wire.
    textHasSentinel: list.text.includes(arg.tokenValue || '\u0000'),
    textHasRawSecret: list.text.includes('sk-live-abc123'),
    textHasDroppedProvider: list.text.includes('impostor'),
  };
};

// ---------------------------------------------------------------------------
// A workspace is bound to the environment that created it. Selecting a different
// environment for that workspace is a mismatch, not a re-bind — and the identity
// check runs BEFORE the adapter check, so an unimplemented target still answers
// "wrong environment" rather than "no adapter".
cases['env-mismatch'] = async () => {
  const created = await call('POST', '/workspace', { path: arg.wsDir, owner: OWNER });
  const ws = created.json && created.json.workspace;
  if (!ws) return { ok: false, error: 'workspace create failed: ' + created.status + ' ' + created.text.slice(0, 200) };

  const wrongImpl = await call('POST', '/goal', { objective: OBJECTIVE, owner: OWNER, workspaceId: ws.workspaceId, environmentId: 'env-remote' });
  const wrongUnimpl = await call('POST', '/goal', { objective: OBJECTIVE, owner: OWNER, workspaceId: ws.workspaceId, environmentId: 'env-sandbox' });
  const unimplGoal = goalOf(wrongUnimpl);

  // Control: the same workspace, no environment named — the binding decides.
  const control = await call('POST', '/goal', { objective: OBJECTIVE, owner: OWNER, workspaceId: ws.workspaceId });
  const controlGoal = goalOf(control);
  const envOfControl = controlGoal && controlGoal.executionEnvironment;

  // The same path through the store path: the orchestrator already knows this
  // path under another environment, so a second environment cannot claim it.
  const rebound = await call('POST', '/workspace', { path: arg.wsDir, owner: OWNER, environmentId: 'env-remote' });

  return {
    ok: true,
    boundEnvironmentId: ws.environmentId,
    wrongImpl: goalTag(wrongImpl),
    wrongUnimpl: goalTag(wrongUnimpl),
    // The refused goal must record no execution identity at all.
    unimplEnvironment: unimplGoal ? unimplGoal.executionEnvironment : 'missing-goal',
    control: goalTag(control),
    controlVerdict: controlGoal && controlGoal.verdict,
    controlEnvironmentId: envOfControl && envOfControl.environmentId,
    controlEstablishedBy: envOfControl && envOfControl.establishedBy,
    controlIdentityEnvironment: envOfControl && envOfControl.identity && envOfControl.identity.environmentId,
    rebound: tag(rebound),
    reboundError: rebound.json && rebound.json.error,
  };
};

// ---------------------------------------------------------------------------
// An environment this build declares but cannot execute refuses to dispatch —
// and an environment the caller is not authorized for refuses on authorization,
// never on the adapter it happens to also be missing.
cases['solari-boundary'] = async () => {
  const list = await call('GET', '/environments');
  const envs = (list.json && list.json.environments) || [];
  const byId = (id) => envs.find((e) => e.environmentId === id) || null;

  const goal = await call('POST', '/goal', { objective: OBJECTIVE, owner: OWNER, environmentId: 'env-sandbox' });
  const goalBody = goalOf(goal);

  const ws = await call('POST', '/workspace', { path: arg.wsDir, owner: OWNER, environmentId: 'env-sandbox' });
  const mixed = await call('POST', '/goal', { objective: OBJECTIVE, owner: OWNER, environmentId: 'env-mixed' });
  const unknown = await call('POST', '/goal', { objective: OBJECTIVE, owner: OWNER, environmentId: 'env-nope' });

  return {
    ok: true,
    sandboxImplemented: (byId('env-sandbox') || {}).adapter && byId('env-sandbox').adapter.implemented,
    sandboxReason: (byId('env-sandbox') || {}).adapter && byId('env-sandbox').adapter.reason,
    remoteImplemented: (byId('env-remote') || {}).adapter && byId('env-remote').adapter.implemented,
    localPresent: !!byId('env-local'),
    goal: goalTag(goal),
    goalEnvironment: goalBody ? goalBody.executionEnvironment : 'missing-goal',
    workspace: tag(ws),
    // Unauthorized AND unimplemented: authorization is the earlier gate.
    mixed: goalTag(mixed),
    unknown: goalTag(unknown),
    unknownError: unknown.json && unknown.json.error,
  };
};

// ---------------------------------------------------------------------------
// P6A: the /solari route. status is a pure readiness read; every run refusal is
// free — nothing constructs a client, imports the SDK, or touches the network.
// The token var is a NAME this child never sets, so the token leg refuses
// before any client construction on any machine.
cases['solari-route'] = async () => {
  const envQ = '&environment_id=env-sandbox';
  const s = (r) => r.status + ':' + ((r.json && r.json.code) || null);
  const status = await call('GET', '/solari?op=status' + envQ);
  const defaultOp = await call('GET', '/solari?environment_id=env-sandbox');
  const runNoReason = await call('POST', '/solari?op=run' + envQ, { argv: ['true'] });
  const runShell = await call('POST', '/solari?op=run' + envQ, { reason: 'e2e', command: 'true && echo hi' });
  const runEnvValues = await call('POST', '/solari?op=run' + envQ, { reason: 'e2e', argv: ['printenv', 'X'], env: { X: 'v' } });
  // The undeclared name EXISTS in this server process — the refusal must be
  // about the allowlist, not the variable's absence (GPT P6A ruling §1).
  process.env.DSH_E2E_UNDECLARED_PRESENT = 'present-but-forbidden-9d2f';
  const runEnvNotAllowed = await call('POST', '/solari?op=run' + envQ, { reason: 'e2e', argv: ['printenv', 'X'], envNames: ['DSH_E2E_UNDECLARED_PRESENT'] });
  delete process.env.DSH_E2E_UNDECLARED_PRESENT;
  // The token var name is privileged by identity — refused even though it is
  // also the credential var the adapter itself reads.
  const runEnvPrivileged = await call('POST', '/solari?op=run' + envQ, { reason: 'e2e', argv: ['printenv', 'X'], envNames: ['DSH_E2E_SOLARI_TOKEN'] });
  const runOverCap = await call('POST', '/solari?op=run' + envQ, { reason: 'e2e', argv: ['true'], budget: { cpu: 16 } });
  const runCustomTpl = await call('POST', '/solari?op=run' + envQ, { reason: 'e2e', argv: ['true'], budget: { template: 'gpu-big' } });
  const runNoToken = await call('POST', '/solari?op=run' + envQ, { reason: 'e2e', argv: ['true'] });
  const wrongAdapter = await call('POST', '/solari?op=run&environment_id=env-remote', { reason: 'e2e', argv: ['true'] });
  const killUnknown = await call('POST', '/solari?op=kill' + envQ, { sandbox_id: 'sbx-not-here' });
  const badOp = await call('GET', '/solari?op=search' + envQ);
  const noEnv = await call('GET', '/solari?op=status');
  const rd = (status.json && status.json.readiness) || null;
  return {
    ok: true,
    status: s(status),
    statusEnvironmentId: status.json && status.json.environmentId,
    readiness: rd ? {
      role: rd.role,
      liveCertified: rd.liveCertified,
      sdkPresent: rd.sdkPresent,
      tokenConfigured: rd.tokenConfigured,
      tokenVar: rd.tokenVar,
      documentedBaseUrl: rd.documentedBaseUrl,
      envAllowlistConfigured: !!(rd.envAllowlist && rd.envAllowlist.configured),
      envAllowlistCount: rd.envAllowlist ? rd.envAllowlist.count : null,
      carriesCredential: Object.prototype.hasOwnProperty.call(rd, 'apiKey') || Object.prototype.hasOwnProperty.call(rd, 'token'),
    } : null,
    defaultOp: s(defaultOp),
    runNoReason: s(runNoReason),
    runShell: s(runShell),
    runEnvValues: s(runEnvValues),
    runEnvNotAllowed: s(runEnvNotAllowed),
    runEnvPrivileged: s(runEnvPrivileged),
    runOverCap: s(runOverCap),
    runCustomTpl: s(runCustomTpl),
    runNoToken: s(runNoToken),
    wrongAdapter: s(wrongAdapter),
    killUnknown: s(killUnknown),
    badOp: s(badOp),
    noEnv: s(noEnv),
  };
};

// ---------------------------------------------------------------------------
// Owner scope is a scope, not a wall: a workspace-scoped environment refuses an
// outside owner whether the caller names it or reaches it as the configured
// default, and still works for the owner it names.
cases['owner-scope'] = async () => {
  const byId = await call('POST', '/goal', { objective: OBJECTIVE, owner: OWNER, environmentId: 'env-scoped' });
  const byDefault = await call('POST', '/goal', { objective: OBJECTIVE, owner: OWNER });
  const byDefaultGoal = goalOf(byDefault);

  const list = await call('GET', '/environments');
  const envs = (list.json && list.json.environments) || [];
  const scoped = envs.find((e) => e.environmentId === 'env-scoped') || null;

  // The same scope answers on the workspace path, where a refusal is a transport
  // error. This leg runs first, on a path no workspace occupies yet, so the refusal
  // can only be the environment gate — the default is scoped to another owner.
  const unqualified = await call('POST', '/workspace', { path: arg.wsDir, owner: OWNER });

  // Local stays reachable by naming it, which is what makes the scope a scope rather
  // than an outage.
  const control = await call('POST', '/workspace', { path: arg.wsDir, owner: OWNER, environmentId: 'env-local' });
  const controlWs = control.json && control.json.workspace;
  const controlGoal = controlWs
    ? await call('POST', '/goal', { objective: OBJECTIVE, owner: OWNER, workspaceId: controlWs.workspaceId })
    : { status: 0, json: null, text: '' };

  // The named owner may select it, and may create a workspace in it.
  const allowed = await call('POST', '/workspace', { path: arg.wsDir2, owner: 'scoped-owner', environmentId: 'env-scoped' });

  return {
    ok: true,
    byId: goalTag(byId),
    byDefault: goalTag(byDefault),
    byDefaultEnvironment: byDefaultGoal ? byDefaultGoal.executionEnvironment : 'missing-goal',
    defaultId: list.json && list.json.defaultId,
    scopedScope: scoped && scoped.workspaceScope,
    scopedKind: scoped && scoped.kind,
    scopedProviderId: scoped && scoped.providerId,
    unqualified: tag(unqualified),
    control: goalTag(controlGoal),
    controlVerdict: goalOf(controlGoal) && goalOf(controlGoal).verdict,
    controlEnvironmentId: goalOf(controlGoal) && goalOf(controlGoal).executionEnvironment && goalOf(controlGoal).executionEnvironment.environmentId,
    allowed: tag(allowed),
    allowedEnvironmentId: allowed.json && allowed.json.workspace && allowed.json.workspace.environmentId,
  };
};

// ---------------------------------------------------------------------------
// Execution identity is established by the execution path. A run whose record
// claims a provider this environment never declared cannot ship — it blocks, with
// the claim witnessed in the identity hash.
cases['provider-claims'] = async () => {
  const legs = [];
  for (const spec of arg.claims) {
    const created = await call('POST', '/workspace', { path: spec.dir, owner: OWNER });
    const ws = created.json && created.json.workspace;
    if (!ws) return { ok: false, error: 'workspace create failed for ' + spec.label + ': ' + created.status + ' ' + created.text.slice(0, 200) };

    // The mock answers `armed:false` for a legitimate `null` arm ("no claim asserted"),
    // so the echoed value — not that boolean — is what proves the arm took.
    const armed = await mockCall('/api/_mock/claim-next-dispatch', { provider: spec.provider });
    if (armed.status !== 200 || !armed.json || armed.json.provider !== spec.provider) {
      return { ok: false, error: 'could not arm ' + spec.label + ': ' + armed.status + ' ' + armed.text.slice(0, 200) };
    }

    const g = await call('POST', '/goal', { objective: OBJECTIVE, owner: OWNER, workspaceId: ws.workspaceId });
    const goal = goalOf(g);
    const env = goal && goal.executionEnvironment;
    const identity = env && env.identity;
    const checks = (goal && Array.isArray(goal.checks) ? goal.checks : []).filter((c) => c && c.id === 'execution-provider-claim');

    legs.push({
      label: spec.label,
      status: g.status,
      verdict: goal && goal.verdict,
      failureCodes: (goal && goal.failureCodes) || [],
      environmentId: env && env.environmentId,
      providerDeclared: identity && identity.providerDeclared,
      providerClaim: identity && identity.providerClaim,
      establishedBy: env && env.establishedBy,
      hasLabel: !!(env && Object.prototype.hasOwnProperty.call(env, 'label')),
      hasTransport: !!(env && (Object.prototype.hasOwnProperty.call(env, 'adapter') || Object.prototype.hasOwnProperty.call(env, 'baseUrl'))),
      identitySha256: identity && identity.identitySha256,
      // Every tuple field the receipt exposes, so the parent can recompute the hash
      // from the receipt alone instead of trusting it.
      orchestratorId: env && env.orchestrator && env.orchestrator.id,
      orchestratorAdapter: env && env.orchestrator && env.orchestrator.adapter,
      workflowName: identity && identity.workflowName,
      conversationId: identity && identity.conversationId,
      codebaseId: identity && identity.codebaseId,
      workingPath: identity && identity.workingPath,
      checkCount: checks.length,
      checkPass: checks.length ? checks[0].pass : null,
      checkDetail: checks.length ? checks[0].detail : null,
      executionStatus: goal && goal.execution && goal.execution.status,
      runId: env && env.runId,
    });
  }
  return { ok: true, legs };
};

let report;
try {
  const boot = assertRoutes();
  const fn = cases[caseName];
  if (boot) report = boot;
  else if (!fn) report = { ok: false, error: 'unknown case: ' + caseName };
  else report = await fn();
} catch (err) {
  report = { ok: false, error: String((err && err.stack) || err) };
}
for (const t of teardowns) {
  try {
    t();
  } catch {}
}
server.close();
process.stdout.write(JSON.stringify(report) + '\n', () => process.exit(0));
