// P2 fresh-workspace E2E — the CHILD half.
//
// Boots the REAL plugin surface (lib/index.js apply(ctx)) against a ctx stub
// that only captures what the plugin registers, serves those captured routes
// over a real HTTP listener on an ephemeral port, and drives the product path
// with real HTTP requests: POST /workspace (create), POST /conversation
// (provision), POST /goal (submit + execute). Nothing here provisions a
// conversation or seeds a task through a test-only path — every step goes
// through the handlers the product registers.
//
// Protocol (same shape as conversation-case.mjs): node test/workspace-case.mjs
// <case> <dshHome> [jsonArg]. One JSON line on stdout, last line wins. Exit 0
// carries the case's own verdict in `ok`; exit 1 is reserved for an unexpected
// throw outside the case.

import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const caseName = process.argv[2];
const dshHome = process.argv[3];
const arg = process.argv[4] ? JSON.parse(process.argv[4]) : {};
process.env.DSH_HOME = dshHome;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ROUTE = '/plugins/operator-ui';
const OWNER = 'e2e-owner';
const OBJECTIVE = 'verify echo running total seed values';

// ---------------------------------------------------------------- ctx stub
// The plugin's whole boot surface is ctx.effect / ctx.webServer.register /
// ctx.tools.register. Route specs are captured verbatim and served below.
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

function matchRoute(pathname) {
  let best = null;
  for (const r of routes) {
    if (r.kind === 'exact') {
      if (pathname === r.path) return r;
      continue;
    }
    if (pathname === r.path || pathname.startsWith(r.path + '/')) {
      if (!best || r.path.length > best.path.length) best = r;
    }
  }
  return best;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = matchRoute(url.pathname);
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'no route for ' + url.pathname }));
    return;
  }
  try {
    await route.handler(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
    } else {
      try {
        res.end();
      } catch {}
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

const codeOf = (r) => (r.json && r.json.code) || null;
const tag = (r) => r.status + ':' + (codeOf(r) || '');

function assertRoutes() {
  const paths = routes.map((r) => r.path);
  const missing = [ROUTE].filter((p) => !paths.includes(p));
  return missing.length ? { ok: false, error: 'plugin registered no route at ' + missing.join(', '), registered: paths } : null;
}

// ------------------------------------------------------------------ cases
const cases = {
  // Refusals are part of the contract: a create that cannot be honored must
  // say why and must persist nothing.
  'create-refusals': async () => {
    const noOwner = await call('POST', '/workspace', { path: arg.wsDir });
    const noPath = await call('POST', '/workspace', { owner: OWNER });
    const badPath = await call('POST', '/workspace', { path: join(arg.wsDir, 'nope-missing'), owner: OWNER });
    const unknown = await call('GET', '/workspace?id=ws-does-not-exist&owner=' + OWNER);
    const codes = { noOwner: tag(noOwner), noPath: tag(noPath), badPath: tag(badPath), unknown: tag(unknown) };
    const ok =
      codes.noOwner === '400:workspace-owner-required' &&
      codes.noPath === '400:workspace-path-required' &&
      codes.badPath === '400:workspace-create-failed' &&
      codes.unknown === '404:workspace-not-found';
    return { ok, codes };
  },

  // Create is idempotent on the Archon side and owner-scoped on ours: the same
  // path returns the same workspace, a foreign owner is refused, and the
  // workspace resolves back to the live codebase row.
  'create-and-resolve': async () => {
    const first = await call('POST', '/workspace', { path: arg.wsDir, owner: OWNER });
    const ws = (first.json && first.json.workspace) || null;
    if (!ws) return { ok: false, error: 'create failed: ' + first.text.slice(0, 200) };
    const again = await call('POST', '/workspace', { path: arg.wsDir, owner: OWNER });
    const read = await call('GET', '/workspace?id=' + encodeURIComponent(ws.workspaceId) + '&owner=' + OWNER);
    const foreign = await call('GET', '/workspace?id=' + encodeURIComponent(ws.workspaceId) + '&owner=someone-else');
    const list = await call('GET', '/workspace?owner=' + OWNER);
    const listed = Boolean(
      list.json && Array.isArray(list.json.workspaces) && list.json.workspaces.some((w) => w.workspaceId === ws.workspaceId)
    );
    const cb = read.json && read.json.codebase;
    const ok =
      first.status === 200 &&
      first.json.ok === true &&
      ws.name === arg.wsName &&
      ws.path === arg.wsDir &&
      ws.owner === OWNER &&
      typeof ws.codebaseId === 'string' &&
      ws.codebaseId.length > 0 &&
      again.status === 200 &&
      again.json.workspace.workspaceId === ws.workspaceId &&
      read.status === 200 &&
      read.json.codebaseRead === 'ok' &&
      cb &&
      cb.path === arg.wsDir &&
      cb.codebaseId === ws.codebaseId &&
      foreign.status === 403 &&
      codeOf(foreign) === 'workspace-owner-mismatch' &&
      listed;
    return {
      ok,
      workspaceId: ws.workspaceId,
      codebaseId: ws.codebaseId,
      name: ws.name,
      path: ws.path,
      recreated: again.status === 200 && again.json.workspace.workspaceId === ws.workspaceId,
      codebaseRead: read.json && read.json.codebaseRead,
      codebasePath: cb && cb.path,
      foreign: tag(foreign),
      listed,
    };
  },

  // The two-step product path: submit first (refused for lack of a bound
  // conversation), then create the workspace, bind it through the supported
  // provisioning op, inspect dispatchability, and re-submit the SAME task.
  // Exactly one conversation creation may exist across both attempts.
  'refuse-then-provision': async () => {
    const refused = await call('POST', '/goal', { objective: OBJECTIVE, owner: OWNER });
    const g0 = (refused.json && refused.json.goal) || null;
    if (!g0) return { ok: false, error: 'goal submit failed: ' + refused.text.slice(0, 200) };
    const refusedOk =
      refused.status === 200 &&
      g0.verdict === 'FAILED' &&
      Array.isArray(g0.failureCodes) &&
      g0.failureCodes.includes('conversation-not-bound') &&
      !g0.attempts.length &&
      !g0.conversationId;
    const taskId = g0.taskId;

    const created = await call('POST', '/workspace', { path: arg.wsDir, owner: OWNER });
    const ws = (created.json && created.json.workspace) || null;
    if (!ws) return { ok: false, error: 'create failed: ' + created.text.slice(0, 200) };

    const prov = await call('POST', '/conversation', { op: 'provision', taskId, workspaceId: ws.workspaceId, owner: OWNER });
    const assoc = (prov.json && prov.json.association) || null;
    // The provision result IS provisionConversation's return: the archon id is
    // assoc.conversationId and the persisted record is one level deeper.
    const convId = (assoc && assoc.conversationId) || null;
    const provOk = prov.status === 200 && prov.json.ok === true && typeof convId === 'string' && convId.length > 0;

    const inspect = await call('GET', '/conversation?taskId=' + encodeURIComponent(taskId));
    const inspectOk =
      inspect.status === 200 &&
      inspect.json.dispatchable === true &&
      inspect.json.association &&
      assoc &&
      inspect.json.association.conversationId === convId &&
      inspect.json.workspace &&
      inspect.json.workspace.codebaseId === ws.codebaseId;

    const retry = await call('POST', '/goal', { objective: OBJECTIVE, retryOf: taskId, owner: OWNER });
    const g1 = (retry.json && retry.json.goal) || null;
    const retryOk =
      retry.status === 200 &&
      g1 &&
      g1.verdict === 'SHIP' &&
      g1.taskId === taskId &&
      g1.execution &&
      g1.execution.completed === true &&
      g1.conversationId === convId &&
      g1.workspace &&
      g1.workspace.codebaseId === ws.codebaseId &&
      g1.objectiveEvaluation &&
      g1.objectiveEvaluation.status === 'SATISFIED';

    return {
      ok: Boolean(refusedOk && provOk && inspectOk && retryOk),
      refusedOk,
      provOk,
      inspectOk,
      retryOk,
      taskId,
      verdict0: g0.verdict,
      failureCodes0: g0.failureCodes,
      attempts0: g0.attempts.length,
      workspaceId: ws.workspaceId,
      codebaseId: ws.codebaseId,
      conversationId: convId,
      provisionReused: Boolean(assoc && assoc.reused),
      verdict1: g1 && g1.verdict,
      failureCodes1: (g1 && g1.failureCodes) || [],
      attempts1: (g1 && g1.attempts.length) || 0,
      workingPath: ws.path,
    };
  },

  // The one-shot product path a fresh user walks: create the workspace, submit
  // the task against it, and let the plugin bind + dispatch on its own.
  'happy-e2e': async () => {
    const created = await call('POST', '/workspace', { path: arg.wsDir, owner: OWNER });
    const ws = (created.json && created.json.workspace) || null;
    if (!ws) return { ok: false, error: 'create failed: ' + created.text.slice(0, 200) };

    const submitted = await call('POST', '/goal', { objective: OBJECTIVE, workspaceId: ws.workspaceId, owner: OWNER });
    const g = (submitted.json && submitted.json.goal) || null;
    if (!g) return { ok: false, error: 'goal submit failed: ' + submitted.text.slice(0, 200) };

    const inspect = await call('GET', '/conversation?taskId=' + encodeURIComponent(g.taskId));
    const readback = await call('GET', '/goal?id=' + encodeURIComponent(g.taskId));
    const rb = (readback.json && readback.json.goal) || null;

    // Each leg is reported separately so a red run names the leg that failed
    // instead of collapsing into one boolean.
    const legs = {
      submitted: submitted.status === 200,
      verdict: g.verdict === 'SHIP',
      executionCompleted: Boolean(g.execution && g.execution.completed === true),
      executionStatus: Boolean(g.execution && g.execution.status === 'completed'),
      objectiveEvaluation: Boolean(g.objectiveEvaluation && g.objectiveEvaluation.status === 'SATISFIED'),
      conversationId: typeof g.conversationId === 'string' && g.conversationId.startsWith('web-'),
      workspaceCodebase: Boolean(g.workspace && g.workspace.codebaseId === ws.codebaseId),
      workspaceId: Boolean(g.workspace && g.workspace.workspaceId === ws.workspaceId),
      oneAttempt: g.attempts.length === 1,
      attemptRunId: Boolean(g.attempts[0] && g.attempts[0].runId),
      inspect: inspect.status === 200 && inspect.json.dispatchable === true,
      inspectConversation: Boolean(inspect.json && inspect.json.association && inspect.json.association.conversationId === g.conversationId),
      readback: readback.status === 200 && Boolean(rb) && rb.verdict === 'SHIP',
      // The durable record keeps ONE authoritative conversation identity,
      // `conversation.archonConversationId` — there is deliberately no second
      // flat copy of the id to drift from it.
      readbackConversation: Boolean(rb && rb.conversation && rb.conversation.archonConversationId === g.conversationId),
      readbackWorkspace: Boolean(rb && rb.workspace && rb.workspace.codebaseId === ws.codebaseId),
    };
    const ok = Object.values(legs).every(Boolean);

    return {
      ok,
      legs,
      taskId: g.taskId,
      workspaceId: ws.workspaceId,
      codebaseId: ws.codebaseId,
      conversationId: g.conversationId,
      runId: (g.attempts[0] && g.attempts[0].runId) || null,
      verdict: g.verdict,
      failureCodes: g.failureCodes,
      executionStatus: g.execution && g.execution.status,
      objectiveEvaluation: g.objectiveEvaluation && g.objectiveEvaluation.status,
      capabilityValidation: g.capabilityValidation && g.capabilityValidation.pass,
      trustLevel: g.trust && g.trust.level,
      dispatchable: inspect.json && inspect.json.dispatchable,
      readbackVerdict: rb && rb.verdict,
      readbackAssocId: rb && rb.conversation && rb.conversation.archonConversationId,
      readbackWorkspaceCodebase: rb && rb.workspace && rb.workspace.codebaseId,
      goalWorkspaceId: g.workspace && g.workspace.workspaceId,
      workingPath: ws.path,
    };
  },

  // A task that already executed in one workspace must be REFUSED when asked
  // to bind to a different one — never silently redirected.
  'task-mismatch': async () => {
    const ws1 = ((await call('POST', '/workspace', { path: arg.wsDir, owner: OWNER })).json || {}).workspace;
    const ws2 = ((await call('POST', '/workspace', { path: arg.wsDir2, owner: OWNER })).json || {}).workspace;
    if (!ws1 || !ws2) return { ok: false, error: 'workspace create failed' };
    const submitted = await call('POST', '/goal', { objective: OBJECTIVE, workspaceId: ws1.workspaceId, owner: OWNER });
    const g = (submitted.json && submitted.json.goal) || null;
    if (!g) return { ok: false, error: 'goal submit failed: ' + submitted.text.slice(0, 200) };
    const clash = await call('POST', '/conversation', {
      op: 'provision',
      taskId: g.taskId,
      workspaceId: ws2.workspaceId,
      owner: OWNER,
    });
    const ok =
      g.verdict === 'SHIP' &&
      clash.status === 409 &&
      codeOf(clash) === 'workspace-task-mismatch' &&
      ws1.codebaseId !== ws2.codebaseId;
    return {
      ok,
      verdict: g.verdict,
      taskId: g.taskId,
      conversationId: g.conversationId,
      codebaseId: ws1.codebaseId,
      ws1CodebaseId: ws1.codebaseId,
      ws2CodebaseId: ws2.codebaseId,
      clash: tag(clash),
      clashError: clash.json && clash.json.error,
    };
  },
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
