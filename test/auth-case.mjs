// P3B inbound-authentication negatives — the CHILD half.
//
// Same protocol as environments-case.mjs: boots the REAL plugin surface
// (lib/index.js apply(ctx)) over a real HTTP listener on an ephemeral port and
// drives it with real requests. The auth posture under test is declared the way
// a deployment declares it — a real operator-ui.config.json in this case's own
// $DSH_HOME, written BEFORE the plugin is imported. Nothing mocks lib/auth.js.
//
// The credential model: every principal declares a tokenVar (an env-var NAME).
// The parent process sets the VALUES as real environment variables and passes
// them through spawn env, so verification exercises process.env reads exactly
// as production does. AUTH_UNSET_TOKEN is deliberately never set, so the
// svc-unset principal is inspectable but cannot authenticate — the case asserts
// that absence is reported as presence(false), never as a fallback credential.
//
// Refusal shapes kept apart, same discipline as P3A:
//   * authentication and authorization failures happen at the route boundary or
//     before any store write / orchestrator contact, so they are TRANSPORT
//     refusals — 401/403 with a stable `code`.
//   * the parent proves the zero-side-effect claim with mock-archon call deltas;
//     this file only has to make the requests and report what came back.

import { createServer } from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const caseName = process.argv[2];
const dshHome = process.argv[3];
const arg = process.argv[4] ? JSON.parse(process.argv[4]) : {};

process.env.DSH_HOME = dshHome;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ROUTE = '/plugins/operator-ui';
const BROWSER_OP = '/plugins/operator-ui/browser/op';
const OBJECTIVE = 'verify echo running total seed values';

// The declaration file is written BEFORE the plugin is imported — the same path
// a restarted deployment takes, not an in-memory injection.
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

// Exact routes first, then the longest matching prefix — the host's own rule.
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

// `token` is the bearer VALUE (not the var name) or null for no header at all;
// `rawAuthorization` overrides the whole header when a malformed shape is the
// thing under test.
async function call(method, path, body, { token, rawAuthorization } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (rawAuthorization !== undefined) headers.authorization = rawAuthorization;
  else if (token !== undefined && token !== null) headers.authorization = 'Bearer ' + token;
  const res = await fetch(base + ROUTE + path, {
    method,
    headers,
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

function assertRoutes() {
  const paths = routes.map((r) => r.path);
  const missing = [ROUTE, BROWSER_OP].filter((p) => !paths.includes(p));
  return missing.length
    ? { ok: false, error: 'plugin registered no route at ' + missing.join(', '), registered: paths }
    : null;
}

// Every route the plugin registered under the prefix, for the sweep case: a
// caller with no credential must meet 401 on ALL of them, including paths that
// would otherwise answer 404 or 405 — the boundary runs before dispatch.
function prefixedRoutes() {
  const prefix = routes.find((r) => r.kind === 'prefix' && r.path === ROUTE);
  const subs = [
    '/git', '/files', '/archon', '/rcos', '/verify', '/goal', '/workspace',
    '/environments', '/conversation', '/teach', '/acquire', '/flowrouter',
    '/federation', '/f1', '/no-such-subpath',
  ];
  return { prefix, subs };
}

const cases = {};

// ---------------------------------------------------------------------------
// The authenticated posture surface: what GET /environments reports about auth
// (mode, posture, principal presence) — and the two ways a secret must never
// reach the wire.
cases['auth-surface'] = async () => {
  const noAuth = await call('GET', '/environments');
  const list = await call('GET', '/environments', undefined, { token: arg.tokens.alice });
  const body = list.json || {};
  const auth = body.auth || {};

  return {
    ok: true,
    // The chokepoint answers BEFORE dispatch: even the posture route refuses an
    // unauthenticated caller with the stable transport refusal.
    noAuthStatus: noAuth.status,
    noAuthCode: noAuth.json && noAuth.json.code,
    listStatus: list.status,
    contract: auth.contract,
    mode: auth.mode,
    loopback: auth.loopback,
    principalCount: Array.isArray(auth.principals) ? auth.principals.length : null,
    byId: Object.fromEntries((auth.principals || []).map((p) => [p.id, p])),
    rootTokenConfigured: (auth.principals || []).find((p) => p.id === 'svc-root')?.tokenConfigured ?? null,
    unsetTokenConfigured: (auth.principals || []).find((p) => p.id === 'svc-unset')?.tokenConfigured ?? null,
    goneRevoked: (auth.principals || []).find((p) => p.id === 'svc-gone')?.revoked ?? null,
    rootOwners: (auth.principals || []).find((p) => p.id === 'svc-root')?.owners ?? null,
    aliceEnvironments: (auth.principals || []).find((p) => p.id === 'svc-alice')?.environments ?? null,
    // The raw response text — what actually crossed the wire. TokenVar NAMES are
    // configuration identity; the VALUES must never appear anywhere.
    textHasAliceSecret: list.text.includes(arg.tokens.alice),
    textHasRootSecret: list.text.includes(arg.tokens.root),
    textHasBobSecret: list.text.includes(arg.tokens.bob),
    textHasGoneSecret: list.text.includes(arg.tokens.gone),
  };
};

// ---------------------------------------------------------------------------
// The four credential refusals in required mode: missing, malformed, invalid,
// revoked. Every one must be a 401 with its own stable code, and — the parent
// proves this with call deltas — none may leave a single mark on the
// orchestrator.
cases['required-refusals'] = async () => {
  const missing = await call('POST', '/goal', { objective: OBJECTIVE });
  const wrongScheme = await call('POST', '/goal', { objective: OBJECTIVE }, { rawAuthorization: 'Basic ' + arg.tokens.alice });
  const bareWord = await call('POST', '/goal', { objective: OBJECTIVE }, { rawAuthorization: 'Bearer' });
  const emptyValue = await call('POST', '/goal', { objective: OBJECTIVE }, { rawAuthorization: 'Bearer    ' });
  const invalid = await call('POST', '/goal', { objective: OBJECTIVE }, { token: 'not-a-real-credential' });
  const revoked = await call('POST', '/goal', { objective: OBJECTIVE }, { token: arg.tokens.gone });
  // The unset-tokenVar principal contributes no verifiable credential: a token
  // matching nothing at all is invalid — no oracle distinguishes "wrong" from
  // "that principal cannot authenticate right now".
  const absentCredential = await call('GET', '/workspace', undefined, { token: 'matching-nothing' });

  // A read route answers the same refusal: authentication is not per-method.
  const readMissing = await call('GET', '/goal');
  const readInvalid = await call('GET', '/goal', undefined, { token: 'nope' });

  // The exact route that bypasses the prefix chokepoint enforces the same gate.
  const browserOp = await call('POST', BROWSER_OP, { op: 'noop' });

  // The boundary runs BEFORE dispatch: an unknown subpath is 401 unauthorized,
  // not 404 — and with a valid credential the same path is 404.
  const unknownUnauth = await call('GET', '/no-such-subpath');
  const unknownAuthed = await call('GET', '/no-such-subpath', undefined, { token: arg.tokens.alice });

  return {
    ok: true,
    missing: tag(missing),
    wrongScheme: tag(wrongScheme),
    bareWord: tag(bareWord),
    emptyValue: tag(emptyValue),
    invalid: tag(invalid),
    revoked: tag(revoked),
    revokedError: revoked.json && revoked.json.error,
    absentCredential: tag(absentCredential),
    readMissing: tag(readMissing),
    readInvalid: tag(readInvalid),
    browserOp: tag(browserOp),
    unknownUnauth: tag(unknownUnauth),
    unknownAuthed: tag(unknownAuthed),
  };
};

// ---------------------------------------------------------------------------
// The full route sweep with no credential: every prefixed route (including the
// 404 subpath) and ALL FOUR exact routes that bypass the prefix chokepoint
// answer 401 authentication-required.
cases['unauth-route-sweep'] = async () => {
  const { prefix, subs } = prefixedRoutes();
  const results = {};
  for (const sub of subs) {
    const r = await call('GET', sub);
    results[sub] = r.status + ':' + codeOf(r);
  }
  const op = await call('POST', BROWSER_OP, { op: 'noop' });
  // The three exact routes besides /op: same boundary, same refusal — proven
  // here WITHOUT a credential (the stream gate must fire before its 200).
  const browserStream = await call('GET', '/browser/stream');
  const browserStatus = await call('GET', '/browser/status');
  const gitStatus = await call('GET', '/status');
  const control = await call('GET', '/environments', undefined, { token: arg.tokens.alice });
  return {
    ok: true,
    prefixRegistered: !!prefix,
    results,
    browserOp: tag(op),
    browserStream: tag(browserStream),
    browserStatus: tag(browserStatus),
    gitStatus: tag(gitStatus),
    controlStatus: control.status,
  };
};

// ---------------------------------------------------------------------------
// Setup leg (required mode): the three workspaces and three shipped tasks every
// later case reads. svc-root holds both owners and no environment restriction,
// so it can provision the cross-environment records; the single-owner
// principals then exercise the boundaries around their own records.
cases['required-setup'] = async () => {
  const mk = async (path, dir, ownerToken, owner, environmentId) => {
    const r = await call('POST', '/workspace', { path: dir, ...(owner ? { owner } : {}), ...(environmentId ? { environmentId } : {}) }, { token: ownerToken });
    if (!(r.json && r.json.workspace)) return { error: 'workspace create failed: ' + r.status + ' ' + r.text.slice(0, 200) };
    return r.json.workspace;
  };
  const aliceLocal = await mk('alice-local', arg.dirs.aliceLocal, arg.tokens.alice);
  // svc-root names alice AND selects env-remote explicitly: the workspace's
  // STORED environment is the truth later legs authorize reads against.
  const aliceRemote = await mk('alice-remote', arg.dirs.aliceRemote, arg.tokens.root, 'alice', 'env-remote');
  const bobLocal = await mk('bob-local', arg.dirs.bobLocal, arg.tokens.bob);
  if (aliceLocal.error || aliceRemote.error || bobLocal.error) {
    return { ok: false, error: aliceLocal.error || aliceRemote.error || bobLocal.error };
  }

  const run = async (ws, ownerToken, owner) => {
    const r = await call('POST', '/goal', { objective: OBJECTIVE, workspaceId: ws.workspaceId, ...(owner ? { owner } : {}) }, { token: ownerToken });
    return { tag: r.status + ':' + (goalOf(r) ? goalOf(r).verdict + ':' + ((goalOf(r).failureCodes || [])[0] || '') : codeOf(r)), taskId: goalOf(r) && goalOf(r).taskId };
  };
  const aliceTask = await run(aliceLocal, arg.tokens.alice);
  const aliceRemoteTask = await run(aliceRemote, arg.tokens.root, 'alice');
  const bobTask = await run(bobLocal, arg.tokens.bob);

  return {
    ok: true,
    aliceLocalId: aliceLocal.workspaceId,
    aliceLocalOwner: aliceLocal.owner,
    aliceLocalEnvironment: aliceLocal.environmentId,
    aliceRemoteId: aliceRemote.workspaceId,
    aliceRemoteEnvironment: aliceRemote.environmentId,
    bobLocalId: bobLocal.workspaceId,
    bobLocalOwner: bobLocal.owner,
    aliceTask,
    aliceRemoteTask,
    bobTask,
  };
};

// ---------------------------------------------------------------------------
// Owner impersonation: a caller-supplied owner field can never become
// authority. svc-alice naming bob is refused on write, read, and goal paths;
// omitting the field resolves to her own single owner.
cases['owner-impersonation'] = async () => {
  const wsAsBob = await call('POST', '/workspace', { path: arg.dirs.impersonate, owner: 'bob' }, { token: arg.tokens.alice });
  const goalAsBob = await call('POST', '/goal', { objective: OBJECTIVE, owner: 'bob' }, { token: arg.tokens.alice });
  const listAsBob = await call('GET', '/workspace?owner=bob', undefined, { token: arg.tokens.alice });
  const resolveAsBob = await call('GET', '/workspace?id=' + arg.aliceRemoteId + '&owner=bob', undefined, { token: arg.tokens.alice });
  const retryAsBob = await call('POST', '/goal', { objective: OBJECTIVE, owner: 'bob', retryOf: arg.bobTaskId }, { token: arg.tokens.alice });

  // Control: the same principal, no owner named — her single owner is applied.
  const implied = await call('POST', '/workspace', { path: arg.dirs.impersonate }, { token: arg.tokens.alice });

  return {
    ok: true,
    wsAsBob: tag(wsAsBob),
    goalAsBob: tag(goalAsBob),
    listAsBob: tag(listAsBob),
    resolveAsBob: tag(resolveAsBob),
    resolveAsBobError: resolveAsBob.json && resolveAsBob.json.error,
    retryAsBob: tag(retryAsBob),
    implied: tag(implied),
    impliedOwner: implied.json && implied.json.workspace && implied.json.workspace.owner,
  };
};

// ---------------------------------------------------------------------------
// Environment impersonation: svc-alice is scoped to env-local. The stored
// environment of a record she owns in env-remote is refused on read, and a
// creation naming env-remote is refused before the store makes anything.
cases['environment-impersonation'] = async () => {
  const readRemote = await call('GET', '/workspace?id=' + arg.aliceRemoteId, undefined, { token: arg.tokens.alice });
  const createRemote = await call('POST', '/workspace', { path: arg.dirs.impersonate, environmentId: 'env-remote' }, { token: arg.tokens.alice });
  const control = await call('GET', '/workspace?id=' + arg.aliceLocalId, undefined, { token: arg.tokens.alice });

  return {
    ok: true,
    readRemote: tag(readRemote),
    readRemoteError: readRemote.json && readRemote.json.error,
    createRemote: tag(createRemote),
    control: control.status + ':' + codeOf(control),
    controlEnvironment: control.json && control.json.workspace && control.json.workspace.environmentId,
  };
};

// ---------------------------------------------------------------------------
// Cross-workspace access: svc-bob against alice's records. Every path — goal
// read, goal list, retry, fork, conversation inspect/verify, teach, acquire —
// authorizes against the RECORD's stored owner.
cases['cross-workspace'] = async () => {
  const goalRead = await call('GET', '/goal?id=' + arg.aliceTaskId, undefined, { token: arg.tokens.bob });
  const goalList = await call('GET', '/goal', undefined, { token: arg.tokens.bob });
  const retry = await call('POST', '/goal', { objective: OBJECTIVE, retryOf: arg.aliceTaskId }, { token: arg.tokens.bob });
  const fork = await call('POST', '/goal', { objective: OBJECTIVE, forkOf: arg.aliceTaskId }, { token: arg.tokens.bob });
  const convInspect = await call('GET', '/conversation?taskId=' + arg.aliceTaskId, undefined, { token: arg.tokens.bob });
  const convVerify = await call('POST', '/conversation', { op: 'verify', taskId: arg.aliceTaskId }, { token: arg.tokens.bob });
  const teachTask = await call('POST', '/teach', { sourceTaskId: arg.aliceTaskId }, { token: arg.tokens.bob });
  const acquireTask = await call('POST', '/acquire', { sourceTaskId: arg.aliceTaskId }, { token: arg.tokens.bob });
  const workspaceResolve = await call('GET', '/workspace?id=' + arg.aliceLocalId + '&owner=bob', undefined, { token: arg.tokens.bob });

  const listIds = ((goalList.json && goalList.json.goals) || []).map((g) => g.taskId);

  // Control: bob's own task is fully reachable by bob.
  const ownRead = await call('GET', '/goal?id=' + arg.bobTaskId, undefined, { token: arg.tokens.bob });

  return {
    ok: true,
    goalRead: tag(goalRead),
    goalReadError: goalRead.json && goalRead.json.error,
    goalReadProbe: (function () {
      const g = goalRead.json && goalRead.json.goal;
      if (!g) return null;
      return { taskId: g.taskId, owner: g.owner === undefined ? null : g.owner, hasWorkspace: !!g.workspace, workspaceOwner: (g.workspace && g.workspace.owner) || null };
    })(),
    listProbe: listIds,
    goalListExcludesAlice: !listIds.includes(arg.aliceTaskId),
    goalListIncludesBob: listIds.includes(arg.bobTaskId),
    retry: tag(retry),
    fork: tag(fork),
    convInspect: tag(convInspect),
    convVerify: tag(convVerify),
    teachTask: tag(teachTask),
    acquireTask: tag(acquireTask),
    workspaceResolve: tag(workspaceResolve),
    workspaceResolveError: workspaceResolve.json && workspaceResolve.json.error,
    ownRead: ownRead.status + ':' + codeOf(ownRead),
  };
};

// ---------------------------------------------------------------------------
// Unattributed authority: svc-root holds TWO owners, so an omitted owner field
// is ambiguous and refused rather than picked — and a required-mode goal with
// no workspace anchor is refused because its receipt could never be attributed.
cases['unattributed'] = async () => {
  const wsNoOwner = await call('POST', '/workspace', { path: arg.dirs.unattrib }, { token: arg.tokens.root });
  const goalNoOwner = await call('POST', '/goal', { objective: OBJECTIVE }, { token: arg.tokens.root });
  const goalNoWorkspace = await call('POST', '/goal', { objective: OBJECTIVE, owner: 'alice' }, { token: arg.tokens.root });

  // Control: naming ONE of its owners un-ambiguates the request. The refused
  // no-owner attempt bound nothing, so the same fresh path is still free.
  const named = await call('POST', '/workspace', { path: arg.dirs.unattrib, owner: 'bob' }, { token: arg.tokens.root });

  return {
    ok: true,
    wsNoOwner: tag(wsNoOwner),
    goalNoOwner: tag(goalNoOwner),
    goalNoWorkspace: tag(goalNoWorkspace),
    named: tag(named),
    namedOwner: named.json && named.json.workspace && named.json.workspace.owner,
  };
};

// ---------------------------------------------------------------------------
// Owner-scoped resource lists: teaching records carry no owner, so required
// mode fail-closes them (empty for every principal, never the whole store).
cases['required-lists'] = async () => {
  const teach = await call('GET', '/teach', undefined, { token: arg.tokens.alice });
  const acquire = await call('GET', '/acquire', undefined, { token: arg.tokens.alice });
  const goals = await call('GET', '/goal', undefined, { token: arg.tokens.alice });
  const goalIds = ((goals.json && goals.json.goals) || []).map((g) => g.taskId);
  const own = new Set([arg.aliceTaskId, arg.aliceRemoteTaskId].filter(Boolean));
  return {
    ok: true,
    teachStatus: teach.status,
    teachCount: (teach.json && teach.json.teaching || []).length,
    acquireCount: (acquire.json && acquire.json.teaching || []).length,
    goalCount: goalIds.length,
    goalListOnlyOwn: goalIds.every((id) => own.has(id)),
  };
};

// ---------------------------------------------------------------------------
// Dev posture preservation: with NO auth block, the pre-P3B path is byte for
// byte unchanged — the owner field passes through, a stray Authorization header
// changes nothing, and the auth projection reports the dev posture.
cases['dev-preserved'] = async () => {
  const mallory = await call('POST', '/workspace', { path: arg.dirs.impersonate, owner: 'mallory' });
  const strayHeader = await call('GET', '/environments', undefined, { token: 'irrelevant-in-dev' });
  const goal = await call('POST', '/goal', { objective: OBJECTIVE, owner: 'mallory', workspaceId: mallory.json && mallory.json.workspace && mallory.json.workspace.workspaceId });
  const g = goalOf(goal);
  return {
    ok: true,
    mallory: tag(mallory),
    malloryOwner: mallory.json && mallory.json.workspace && mallory.json.workspace.owner,
    strayHeaderStatus: strayHeader.status,
    strayAuthMode: strayHeader.json && strayHeader.json.auth && strayHeader.json.auth.mode,
    strayPrincipalCount: strayHeader.json && strayHeader.json.auth && (strayHeader.json.auth.principals || []).length,
    goal: g ? goal.status + ':' + g.verdict + ':' + ((g.failureCodes || [])[0] || '') : tag(goal),
    // Envelopes record ownership through the task's recorded workspace anchor
    // (durable truth from the store row); there is no separate owner field.
    goalOwner: (g && g.workspace && g.workspace.owner) || (g && g.owner) || null,
  };
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
