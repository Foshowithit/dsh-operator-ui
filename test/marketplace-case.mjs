// P4 marketplace negatives — the CHILD half.
//
// Same protocol as auth-case.mjs: boots the REAL plugin surface (lib/index.js
// apply(ctx)) over a real HTTP listener on an ephemeral port and drives it with
// real requests. The marketplace posture under test is declared the way a
// deployment declares it — a real operator-ui.config.json in this case's own
// $DSH_HOME, written BEFORE the plugin is imported. Nothing mocks the engine.
//
// Two mock archons exist at the parent level: a PLAIN one (MOCK_MARKETPLACE
// unset — the unmodified v0.10.1 contract, no openapi.json, no marketplace
// routes) and a MARKET one (MOCK_MARKETPLACE=1). Which one a case's config
// points at decides the supported/unsupported half of the matrix.
//
// The zero-side-effect claim is measured in the child, per section, against
// the mock's own call counters: orchestrator WRITE counters must not move on
// ANY refusal, and marketplace read counters must not move on any refusal
// that must happen BEFORE orchestrator contact. Refusals after a read-only
// entry fetch report their marketplace delta in the result for the parent to
// pin exactly.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFile, mkdir, readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const caseName = process.argv[2];
const dshHome = process.argv[3];
const arg = process.argv[4] ? JSON.parse(process.argv[4]) : {};

process.env.DSH_HOME = dshHome;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ROUTE = '/plugins/operator-ui';

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

// `token` is the bearer VALUE (not the var name) or null for no header at all.
async function call(method, path, body, { token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token !== undefined && token !== null) headers.authorization = 'Bearer ' + token;
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

// Mock call counters — the child reads the SAME mock the plugin's archon
// transport is pointed at (arg.mockBase), so deltas are real request counts.
async function mockCalls() {
  const b = await (await fetch(arg.mockBase + '/api/_mock/calls')).json();
  return {
    createPosts: b.createPosts,
    dispatchPosts: b.dispatchPosts,
    codebasePosts: b.codebasePosts,
    setProjectPosts: b.setProjectPosts,
    marketplaceGets: b.marketplaceGets,
  };
}
const WRITE_KEYS = ['createPosts', 'dispatchPosts', 'codebasePosts', 'setProjectPosts'];
const delta = (before_, after_) => ({
  createPosts: after_.createPosts - before_.createPosts,
  dispatchPosts: after_.dispatchPosts - before_.dispatchPosts,
  codebasePosts: after_.codebasePosts - before_.codebasePosts,
  setProjectPosts: after_.setProjectPosts - before_.setProjectPosts,
  marketplaceGets: after_.marketplaceGets - before_.marketplaceGets,
});
const ZERO_WRITES = { createPosts: 0, dispatchPosts: 0, codebasePosts: 0, setProjectPosts: 0 };
const writesOf = (d) => ({ createPosts: d.createPosts, dispatchPosts: d.dispatchPosts, codebasePosts: d.codebasePosts, setProjectPosts: d.setProjectPosts });

async function ledgerOnDisk() {
  try {
    const parsed = JSON.parse(await readFile(join(dshHome, 'operator-ui', 'marketplace.json'), 'utf8'));
    return { exists: true, imports: parsed.imports || [] };
  } catch {
    return { exists: false, imports: [] };
  }
}
const fileExists = async (p) => access(p).then(() => true, () => false);

// Workspaces are created through the REAL surface the way a session creates
// them — POST /workspace with the case's own credential — so import probes run
// against records that exist in this case's own store.
let wsSeq = 0;
// Archon names a codebase after the path's basename and requires uniqueness
// across ITS lifetime — which spans several child cases against one mock. The
// case name + a per-process token keep every workspace name globally unique.
const wsRunToken = caseName + '-' + randomBytes(3).toString('hex');
async function ensureWorkspace(owner, token, environmentId) {
  const p = join(dshHome, 'ws', owner + '-' + ++wsSeq + '-' + wsRunToken);
  await mkdir(p, { recursive: true });
  const r = await call('POST', '/workspace', { path: p, owner, ...(environmentId ? { environmentId } : {}) }, { token });
  if (!r.json || !r.json.ok || !r.json.workspace) throw new Error('workspace create failed: ' + JSON.stringify(r.json || { status: r.status }));
  return r.json.workspace.workspaceId;
}

// One refusal probe: run the request, capture code + write-delta + marketplace
// read delta, and fold it into the case result.
async function probe(label, run) {
  const before_ = await mockCalls();
  const r = await run();
  const after_ = await mockCalls();
  const d = delta(before_, after_);
  return {
    label,
    status: r.status,
    code: codeOf(r),
    ok: r.json && r.json.ok,
    writes: writesOf(d),
    marketplaceGets: d.marketplaceGets,
    counts: (r.json && r.json.counts) || undefined,
  };
}

const importBody = (entryId, extra = {}) => ({
  entry_id: entryId,
  workspace_id: arg.workspaceId,
  owner: arg.owner,
  ...extra,
});
const doImport = (entryId, extra) => call('POST', '/marketplace?op=import', importBody(entryId, extra), { token: arg.token });

const out = { case: caseName, ok: true, checks: [] };
const check = (label, cond, detail) => {
  out.checks.push({ label, pass: Boolean(cond), ...(detail !== undefined ? { detail } : {}) });
  if (!cond) out.ok = false;
};

// ------------------------------------------------------------ case dispatcher

if (caseName === 'unsupported') {
  // PLAIN mock: no openapi.json, no marketplace routes. Detection must report
  // honest unavailability and every op must refuse 409 WITHOUT touching a
  // write counter — while the existing /archon surface stays fully alive.
  // The workspace rung of the ladder precedes feature detection, so the import
  // probe runs against a REAL workspace to reach the unsupported verdict.
  arg.owner = 'alice';
  arg.workspaceId = await ensureWorkspace('alice', null);
  const status = await call('GET', '/marketplace?op=status', undefined, {});
  check('status-200', status.status === 200);
  check('status-unsupported', status.json && status.json.supported === false, status.json && status.json.reason);
  check('status-honest-reason', status.json && status.json.reason === 'marketplace-not-advertised');
  const d0 = await probe('search', () => call('GET', '/marketplace?op=search', undefined, {}));
  check('search-409', d0.status === 409 && d0.code === 'marketplace-unsupported', JSON.stringify(d0));
  const d1 = await probe('inspect', () => call('GET', '/marketplace?op=inspect&entry_id=mkt-clean', undefined, {}));
  check('inspect-409', d1.status === 409 && d1.code === 'marketplace-unsupported');
  const d2 = await probe('import', () => doImport('mkt-clean'));
  check('import-409', d2.status === 409 && d2.code === 'marketplace-unsupported');
  check('import-zero-writes', JSON.stringify(d2.writes) === JSON.stringify(ZERO_WRITES), JSON.stringify(d2.writes));
  check('import-zero-market-reads', d2.marketplaceGets === 0);
  const archon = await call('GET', '/archon', undefined, {});
  check('archon-surface-unaffected', archon.status === 200 && archon.json && archon.json.ok === true, JSON.stringify(archon.json || {}).slice(0, 120));
  const ledger = await ledgerOnDisk();
  check('no-ledger-written', ledger.exists === false);
} else if (caseName === 'discovery') {
  // MARKET mock, dev posture: discovery + inspection work; scoping is PUBLIC
  // ONLY for a principal-less request (fail closed), and inspection of a
  // private entry refuses rather than leaks metadata.
  const status = await call('GET', '/marketplace?op=status', undefined, {});
  check('status-supported', status.json && status.json.supported === true, JSON.stringify(status.json || {}).slice(0, 160));
  check('status-advertises-paths', status.json && Array.isArray(status.json.paths) && status.json.paths.some((p) => p.startsWith('/api/marketplace/')));
  const search = await call('GET', '/marketplace?op=search', undefined, {});
  const ids = ((search.json && search.json.entries) || []).map((e) => e.id);
  check('search-200', search.status === 200);
  check('search-sees-public', ids.includes('mkt-clean'));
  check('search-dev-hides-private', !ids.includes('mkt-private-alice'), JSON.stringify(ids));
  const q = await call('GET', '/marketplace?op=search&q=tampered', undefined, {});
  check('search-q-filters', ((q.json && q.entries) || (q.json && q.json.entries) || []).every((e) => e.id === 'mkt-tampered'));
  const insp = await call('GET', '/marketplace?op=inspect&entry_id=mkt-clean', undefined, {});
  const e = insp.json && insp.json.entry;
  check('inspect-200', insp.status === 200);
  check('inspect-pinned', e && e.revision === 'rev-1' && typeof e.digest === 'string' && e.digest.startsWith('sha256:'));
  check('inspect-security-evidence', e && e.securityReview && e.securityReview.kind === 'deterministic-scan' && e.securityReview.status === 'complete');
  check('inspect-requires-permissions', e && Array.isArray(e.requires) && Array.isArray(e.permissions));
  check('inspect-no-source-bytes', e && e.source === undefined, 'source bytes are served only at the pinned-source fetch, never in inspection');
  const priv = await call('GET', '/marketplace?op=inspect&entry_id=mkt-private-alice', undefined, {});
  check('inspect-private-refused', priv.status === 403 && codeOf(priv) === 'marketplace-entry-forbidden');
  const missing = await call('GET', '/marketplace?op=inspect&entry_id=mkt-nope', undefined, {});
  check('inspect-missing-404', missing.status === 404 && codeOf(missing) === 'marketplace-entry-not-found');
  const inst = await call('GET', '/marketplace?op=installations', undefined, {});
  check('installations-empty', inst.status === 200 && inst.json && Array.isArray(inst.json.imports) && inst.json.imports.length === 0);
} else if (caseName === 'import-refusals') {
  // MARKET mock, dev posture, target + registry configured. Every security,
  // content, and admission refusal in the ladder, each leaving the
  // orchestrator untouched; then the two legal installs.
  arg.owner = 'alice';
  arg.workspaceId = await ensureWorkspace('alice', null);
  const refusals = [
    ['not-found', () => doImport('mkt-nope'), 404, 'marketplace-entry-not-found', 1],
    ['unpinned', () => doImport('mkt-unpinned'), 403, 'source-unpinned', 1],
    ['missing-dependency', () => doImport('mkt-missing-dep'), 403, 'missing-dependency', 1],
    // The security policy is evaluated after the pinned-source fetch (it audits
    // the SAME fetch the digest check consumes), so these refusals have
    // legitimately read entry + source — read-only, never a write.
    ['critical-findings', () => doImport('mkt-critical'), 403, 'security-blocking-findings', 2],
    ['ai-review-only', () => doImport('mkt-ai-only'), 403, 'security-evidence-insufficient', 2],
    ['no-security-review', () => doImport('mkt-no-scan'), 403, 'security-evidence-incomplete', 2],
    ['failed-scan', () => doImport('mkt-failed-scan'), 403, 'security-evidence-incomplete', 2],
    ['tampered-source', () => doImport('mkt-tampered'), 403, 'source-tampered', 2],
    ['clean-scan-evil-bytes', () => doImport('mkt-clean-but-evil'), 403, 'market-static-forbidden', 2],
    ['registry-shadow', () => doImport('mkt-registry-shadow'), 409, 'capability-name-collision', 2],
    ['medium-needs-approval', () => doImport('mkt-medium'), 403, 'security-approval-required', 2],
  ];
  for (const [label, run, wantStatus, wantCode, wantGets] of refusals) {
    const p = await probe(label, run);
    check(label + '-status', p.status === wantStatus && p.code === wantCode, JSON.stringify(p));
    check(label + '-zero-writes', JSON.stringify(p.writes) === JSON.stringify(ZERO_WRITES), JSON.stringify(p.writes));
    check(label + '-market-reads', p.marketplaceGets === wantGets, 'expected ' + wantGets + ' entry/source reads, saw ' + p.marketplaceGets);
  }
  const crit = out.checks.find((c) => c.label === 'critical-findings-status');
  // counts ride the blocking refusal so a human sees WHY without re-fetching.
  const countsProbe = await doImport('mkt-critical');
  check('blocking-counts-visible', countsProbe.json && countsProbe.json.counts && countsProbe.json.counts.critical === 1 && countsProbe.json.counts.high === 1, JSON.stringify(countsProbe.json || {}));
  void crit;

  // missing workspace: refused BEFORE contact (no entry read, no writes)
  const wsMiss = await probe('workspace-not-found', () => doImport('mkt-clean', { workspace_id: 'ws-none' }));
  check('workspace-not-found', wsMiss.status === 404 && wsMiss.code === 'workspace-not-found', JSON.stringify(wsMiss));
  check('workspace-not-found-zero-writes', JSON.stringify(wsMiss.writes) === JSON.stringify(ZERO_WRITES));
  check('workspace-not-found-zero-reads', wsMiss.marketplaceGets === 0);

  // legal install #1: the clean entry
  const good = await probe('clean-install', () => doImport('mkt-clean'));
  check('clean-install-200', good.status === 200 && good.ok === true, JSON.stringify(good));
  check('clean-install-reads', good.marketplaceGets === 2);
  const rec = (await ledgerOnDisk()).imports[0];
  check('ledger-record-shape', rec && rec.entryId === 'mkt-clean' && rec.revision === 'rev-1' && rec.owner === 'alice' && typeof rec.importId === 'string' && rec.importId.startsWith('mkt_'));
  check('ledger-states-installed-only', rec && rec.states && Object.keys(rec.states).length === 1 && rec.states.installed);
  check('ledger-not-execution-eligible', rec && rec.executionEligible === false && rec.executionVerified === false);
  check('ledger-promotion-closed', rec && rec.promotion && rec.promotion.admitted === false && /promoteCandidate/.test(rec.promotion.authority));
  check('ledger-security-recorded', rec && rec.security && rec.security.status === 'complete' && rec.security.counts && rec.security.counts.critical === 0);
  const yamlPath = join(arg.config.marketplace.workflowsDir, 'market-clean.yaml');
  check('yaml-installed', (await fileExists(yamlPath)) === true, yamlPath);

  // idempotency: same entry+revision+owner refuses with zero writes (the rung
  // sits after the entry+source reads, which are read-only).
  const again = await probe('already-installed', () => doImport('mkt-clean'));
  check('already-installed', again.status === 409 && again.code === 'already-installed', JSON.stringify(again));
  check('already-installed-zero-writes', JSON.stringify(again.writes) === JSON.stringify(ZERO_WRITES));
  check('already-installed-reads', again.marketplaceGets === 2, 'saw ' + again.marketplaceGets);

  // legal install #2: medium WITH explicit human approval — approval recorded
  const medium = await probe('medium-approved', () => doImport('mkt-medium', { approval: { acknowledged: true } }));
  check('medium-approved-200', medium.status === 200 && medium.ok === true, JSON.stringify(medium));
  const rec2 = (await ledgerOnDisk()).imports[1];
  check('medium-approval-recorded', rec2 && rec2.approval && rec2.approval.acknowledged === true && rec2.approval.by === 'operator-dev' && typeof rec2.approval.at === 'string');
  check('ledger-two-records', (await ledgerOnDisk()).imports.length === 2);
} else if (caseName === 'import-unconfigured') {
  // No marketplace.workflowsDir: the FIRST ladder rung refuses before anything
  // else — no detection fetch, no entry read, no ledger.
  const p = await probe('unconfigured', () => doImport('mkt-clean', { workspace_id: 'ws-any', owner: 'alice' }));
  check('unconfigured-400', p.status === 400 && p.code === 'marketplace-target-not-configured', JSON.stringify(p));
  check('unconfigured-zero-writes', JSON.stringify(p.writes) === JSON.stringify(ZERO_WRITES));
  check('unconfigured-zero-reads', p.marketplaceGets === 0);
  check('no-ledger-written', (await ledgerOnDisk()).exists === false);
} else if (caseName === 'auth-refusals') {
  // required mode. The P3B ladder runs before ANY marketplace contact for
  // owner/workspace/environment checks — assert zero marketplace reads AND
  // zero orchestrator writes on each. Then the scoping rules on reads, and a
  // positive control: an authorized import in required mode works.
  const T = arg.tokens;
  const mkToken = (k) => T[k];
  arg.owner = 'alice';
  arg.workspaceId = await ensureWorkspace('alice', mkToken('alice'));
  const bobWorkspaceId = await ensureWorkspace('bob', mkToken('bob'));
  // The env-remote workspace is SET UP by svc-root (environment-unrestricted);
  // the refusal under test is svc-alice — scoped to env-local — trying to use it.
  const remoteWorkspaceId = await ensureWorkspace('alice', mkToken('root'), 'env-remote');
  const noToken = await call('GET', '/marketplace?op=status', undefined, {});
  check('unauthenticated-401', noToken.status === 401 && Boolean(noToken.json && noToken.json.code), JSON.stringify({ status: noToken.status, code: codeOf(noToken) }));

  const imp = (entry, extra, who) => call('POST', '/marketplace?op=import', { entry_id: entry, workspace_id: arg.workspaceId, owner: arg.owner, ...extra }, { token: mkToken(who) });

  const bobAsAlice = await probe('owner-impersonation', () => imp('mkt-clean', { owner: 'alice' }, 'bob'));
  check('owner-impersonation', bobAsAlice.status === 403 && bobAsAlice.code === 'owner-impersonation-refused', JSON.stringify(bobAsAlice));
  check('owner-impersonation-zero-writes', JSON.stringify(bobAsAlice.writes) === JSON.stringify(ZERO_WRITES));
  check('owner-impersonation-zero-reads', bobAsAlice.marketplaceGets === 0);

  // `owner: undefined` in the spread REMOVES the inherited owner key, so the
  // body genuinely carries no attribution — JSON.stringify drops undefined.
  const rootNoOwner = await probe('unattributed', () => imp('mkt-clean', { owner: undefined }, 'root'));
  check('unattributed', rootNoOwner.status === 403 && rootNoOwner.code === 'owner-attribution-required', JSON.stringify(rootNoOwner));
  check('unattributed-zero-writes', JSON.stringify(rootNoOwner.writes) === JSON.stringify(ZERO_WRITES));
  check('unattributed-zero-reads', rootNoOwner.marketplaceGets === 0);

  const cross = await probe('cross-workspace', () => imp('mkt-clean', { workspace_id: bobWorkspaceId }, 'alice'));
  check('cross-workspace', cross.status === 403 && cross.code === 'cross-workspace-refused', JSON.stringify(cross));
  check('cross-workspace-zero-writes', JSON.stringify(cross.writes) === JSON.stringify(ZERO_WRITES));
  check('cross-workspace-zero-reads', cross.marketplaceGets === 0);

  const envDeny = await probe('environment-unauthorized', () => imp('mkt-clean', { workspace_id: remoteWorkspaceId }, 'alice'));
  check('environment-unauthorized', envDeny.status === 403 && envDeny.code === 'environment-unauthorized', JSON.stringify(envDeny));
  check('environment-unauthorized-zero-writes', JSON.stringify(envDeny.writes) === JSON.stringify(ZERO_WRITES));
  check('environment-unauthorized-zero-reads', envDeny.marketplaceGets === 0);

  const privInspect = await probe('inspect-private', () => call('GET', '/marketplace?op=inspect&entry_id=mkt-private-alice', undefined, { token: mkToken('bob') }));
  check('inspect-private-forbidden', privInspect.status === 403 && privInspect.code === 'marketplace-entry-forbidden', JSON.stringify(privInspect));
  check('inspect-private-zero-writes', JSON.stringify(privInspect.writes) === JSON.stringify(ZERO_WRITES));

  const bobSearch = await call('GET', '/marketplace?op=search', undefined, { token: mkToken('bob') });
  const bobIds = ((bobSearch.json && bobSearch.json.entries) || []).map((e) => e.id);
  check('search-scoped', bobIds.includes('mkt-clean') && !bobIds.includes('mkt-private-alice'), JSON.stringify(bobIds));

  const aliceImport = await probe('authorized-import-ok', () => imp('mkt-clean', {}, 'alice'));
  check('authorized-import-200', aliceImport.status === 200 && aliceImport.ok === true, JSON.stringify(aliceImport));

  const aliceList = await call('GET', '/marketplace?op=installations', undefined, { token: mkToken('alice') });
  check('owner-sees-own-import', aliceList.json && aliceList.json.imports && aliceList.json.imports.length === 1 && aliceList.json.imports[0].owner === 'alice');
  const bobList = await call('GET', '/marketplace?op=installations', undefined, { token: mkToken('bob') });
  check('other-owner-sees-nothing', bobList.json && bobList.json.imports && bobList.json.imports.length === 0);
  const bobAsAliceList = await call('GET', '/marketplace?op=installations&owner=alice', undefined, { token: mkToken('bob') });
  check(
    'list-impersonation-refused',
    bobAsAliceList.status === 403 && codeOf(bobAsAliceList) === 'owner-impersonation-refused',
    JSON.stringify({ status: bobAsAliceList.status, code: codeOf(bobAsAliceList), body: bobAsAliceList.json }),
  );
} else if (caseName === 'promotion-isolation') {
  // THE structural claim: an import never touches the capability registry,
  // never appears as an rcos capability, never creates a teaching envelope,
  // and its record states so explicitly.
  const T = arg.tokens;
  arg.owner = 'alice';
  arg.workspaceId = await ensureWorkspace('alice', T.alice);
  const registryBefore = await readFile(arg.registryPath, 'utf8');
  const rcosBefore = await call('GET', '/rcos', undefined, { token: arg.tokens.alice });
  const idsBefore = ((rcosBefore.json && rcosBefore.json.registry && rcosBefore.json.registry.capabilities) || []).map((c) => c.id);

  const good = await call('POST', '/marketplace?op=import', importBody('mkt-clean'), { token: arg.tokens.alice });
  check('import-200', good.status === 200 && good.json && good.json.ok === true, JSON.stringify(good.json || {}).slice(0, 200));

  const registryAfter = await readFile(arg.registryPath, 'utf8');
  check('registry-bytes-unchanged', registryAfter === registryBefore);
  const rcosAfter = await call('GET', '/rcos', undefined, { token: arg.tokens.alice });
  const idsAfter = ((rcosAfter.json && rcosAfter.json.registry && rcosAfter.json.registry.capabilities) || []).map((c) => c.id);
  check('capability-list-unchanged', JSON.stringify(idsAfter) === JSON.stringify(idsBefore), JSON.stringify({ before: idsBefore, after: idsAfter }));
  check('import-not-a-capability', !idsAfter.includes('market-clean'));

  const teach = await call('GET', '/teach', undefined, { token: arg.tokens.alice });
  check('no-teaching-envelope', !JSON.stringify(teach.json || {}).includes('market-clean'), JSON.stringify(teach.json || {}).slice(0, 200));

  const ledger = await ledgerOnDisk();
  const rec = ledger.imports[0];
  check('ledger-promotion-closed', rec && rec.promotion && rec.promotion.admitted === false && rec.promotion.reason === 'marketplace installation is not capability admission');
  check('ledger-execution-not-conferred', rec && rec.executionEligible === false && rec.executionVerified === false);
  check('ledger-states-installed-only', rec && rec.states && Object.keys(rec.states).length === 1 && rec.states.installed);

  const yamlPath = join(arg.config.marketplace.workflowsDir, 'market-clean.yaml');
  check('yaml-installed', (await fileExists(yamlPath)) === true);
  if (await fileExists(yamlPath)) {
    const yaml = await readFile(yamlPath, 'utf8');
    check('yaml-is-pinned-bytes', yaml.startsWith('name: market-clean'));
  }
} else {
  out.ok = false;
  out.error = 'unknown case: ' + caseName;
}

const missing = [ROUTE].filter((p) => !routes.some((r) => r.path === p));
if (missing.length) {
  out.ok = false;
  out.error = 'plugin registered no route at ' + missing.join(', ');
}

console.log(JSON.stringify(out));
server.close();
for (const t of teardowns) t();
process.exit(out.ok ? 0 : 1);
