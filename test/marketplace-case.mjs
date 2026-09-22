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
    // Rung 2 (attribution) refuses before ANY marketplace contact: no entry
    // read at all. The spread sets workspace_id to undefined, which
    // JSON.stringify omits — a body genuinely carrying no workspace_id.
    ['workspace-id-required', () => doImport('mkt-clean', { workspace_id: undefined }), 400, 'workspace-id-required', 0],
    ['not-found', () => doImport('mkt-nope'), 404, 'marketplace-entry-not-found', 1],
    // The requested revision is checked against the pin AFTER the entry fetch
    // and BEFORE the source fetch: one read, no content contact.
    ['revision-mismatch', () => doImport('mkt-clean', { revision: 'rev-99' }), 409, 'revision-mismatch', 1],
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
    // Source FETCH failure (5xx after a passing pin): entry + source reads
    // happened, but a transport failure is 502 marketplace-unreachable — the
    // ladder never reaches the security/static/admission rungs.
    ['source-unreachable', () => doImport('mkt-source-down'), 502, 'marketplace-unreachable', 2],
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

  // C3 (P5): client-supplied approval attribution is NEVER proof. The body
  // carries a forged by/at pair; the recorded approval must still name the
  // SERVER-derived principal ('operator-dev' in dev posture) and the SERVER
  // clock, not anything the caller sent.
  const forged = await probe('medium-forged-attribution', () => doImport('mkt-medium-b', { approval: { acknowledged: true, by: 'attacker-mallory', at: '1970-01-01T00:00:00.000Z' } }));
  check('forged-attribution-200', forged.status === 200 && forged.ok === true, JSON.stringify(forged));
  const rec3 = (await ledgerOnDisk()).imports[2];
  check('forged-by-ignored', rec3 && rec3.approval && rec3.approval.by === 'operator-dev', JSON.stringify(rec3 && rec3.approval));
  check('forged-at-ignored', rec3 && rec3.approval && rec3.approval.at !== '1970-01-01T00:00:00.000Z' && !Number.isNaN(Date.parse(rec3.approval.at)), JSON.stringify(rec3 && rec3.approval));
  check('forged-counts-medium', rec3 && rec3.security && rec3.security.counts && rec3.security.counts.medium === 1);
  check('ledger-three-records', (await ledgerOnDisk()).imports.length === 3);
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
  // Every op on the route — the four GETs and the POST import — must 401 at
  // the prefix chokepoint: no marketplace contact, no orchestrator writes.
  const unauthOps = [
    ['status', 'GET', '/marketplace?op=status', undefined],
    ['search', 'GET', '/marketplace?op=search', undefined],
    ['inspect', 'GET', '/marketplace?op=inspect&entry_id=mkt-clean', undefined],
    ['installations', 'GET', '/marketplace?op=installations', undefined],
    ['import', 'POST', '/marketplace?op=import', importBody('mkt-clean')],
  ];
  for (const [op, method, path, body] of unauthOps) {
    const p = await probe('unauth-' + op, () => call(method, path, body, {}));
    check('unauthenticated-401-' + op, p.status === 401 && Boolean(p.code), JSON.stringify(p));
    check('unauthenticated-401-' + op + '-zero-writes', JSON.stringify(p.writes) === JSON.stringify(ZERO_WRITES), JSON.stringify(p.writes));
    check('unauthenticated-401-' + op + '-zero-reads', p.marketplaceGets === 0, 'saw ' + p.marketplaceGets);
  }

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

  // Import of a private entry the principal does not hold: refused at the
  // visibility rung — the entry fetch was read-only, nothing else contacted.
  const privImport = await probe('import-private', () =>
    call('POST', '/marketplace?op=import', { entry_id: 'mkt-private-alice', workspace_id: bobWorkspaceId, owner: 'bob' }, { token: mkToken('bob') }));
  check('import-private-forbidden', privImport.status === 403 && privImport.code === 'marketplace-entry-forbidden', JSON.stringify(privImport));
  check('import-private-zero-writes', JSON.stringify(privImport.writes) === JSON.stringify(ZERO_WRITES));
  check('import-private-reads', privImport.marketplaceGets === 1, 'saw ' + privImport.marketplaceGets);

  const bobSearch = await call('GET', '/marketplace?op=search', undefined, { token: mkToken('bob') });
  const bobIds = ((bobSearch.json && bobSearch.json.entries) || []).map((e) => e.id);
  check('search-scoped', bobIds.includes('mkt-clean') && !bobIds.includes('mkt-private-alice'), JSON.stringify(bobIds));

  const aliceImport = await probe('authorized-import-ok', () => imp('mkt-clean', {}, 'alice'));
  check('authorized-import-200', aliceImport.status === 200 && aliceImport.ok === true, JSON.stringify(aliceImport));

  // C3 (P5), required mode: an approval carried by the CLIENT naming someone
  // else ('bob') and an epoch timestamp must record NEITHER — the server
  // derives the approver from the authenticated principal (alice's token →
  // principal svc-alice, NOT the owner string the body could have named) and
  // the time from its own clock.
  const aliceMedium = await probe('required-medium-approved', () => imp('mkt-medium', { approval: { acknowledged: true, by: 'bob', at: '1970-01-01T00:00:00.000Z' } }, 'alice'));
  check('required-medium-200', aliceMedium.status === 200 && aliceMedium.ok === true, JSON.stringify(aliceMedium));
  const recM = (await ledgerOnDisk()).imports[1];
  check('required-approval-by-principal', recM && recM.approval && recM.approval.by === 'svc-alice', JSON.stringify(recM && recM.approval));
  check('required-approval-at-server', recM && recM.approval && recM.approval.at !== '1970-01-01T00:00:00.000Z' && !Number.isNaN(Date.parse(recM.approval.at)));

  // And an anonymous approval attempt in required mode never reaches the
  // security rung at all — 401 at the boundary, zero contact.
  const anonMedium = await probe('anon-medium-approval', () => imp('mkt-medium-b', { approval: { acknowledged: true } }, undefined));
  check('anon-medium-401', anonMedium.status === 401, JSON.stringify(anonMedium));
  check('anon-medium-zero-writes', JSON.stringify(anonMedium.writes) === JSON.stringify(ZERO_WRITES));

  const aliceList = await call('GET', '/marketplace?op=installations', undefined, { token: mkToken('alice') });
  check('owner-sees-own-import', aliceList.json && aliceList.json.imports && aliceList.json.imports.length === 2 && aliceList.json.imports.every((r) => r.owner === 'alice'), JSON.stringify((aliceList.json && aliceList.json.imports || []).map((r) => r.owner)));
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
} else if (caseName === 'registry-unreadable') {
  // A registry that EXISTS but cannot be parsed. The path is validated as a
  // string at config load; the JSON.parse happens at request time — so this
  // boots clean and fails at the admission rung: after the read-only
  // entry+source legs, before ANY write. Dev posture, target configured.
  arg.owner = 'alice';
  arg.workspaceId = await ensureWorkspace('alice', null);
  const p = await probe('registry-unreadable', () => doImport('mkt-clean'));
  check('registry-unreadable-403', p.status === 403 && p.code === 'registry-unreadable', JSON.stringify(p));
  check('registry-unreadable-zero-writes', JSON.stringify(p.writes) === JSON.stringify(ZERO_WRITES), JSON.stringify(p.writes));
  check('registry-unreadable-reads', p.marketplaceGets === 2, 'expected entry+source reads, saw ' + p.marketplaceGets);
  check('no-ledger-written', (await ledgerOnDisk()).exists === false);
} else if (caseName === 'workspace-guided') {
  // P5 C1 (required mode): guided creation mints the path SERVER-SIDE under
  // the configured root — the caller names at most a label. Unsafe labels,
  // a smuggled path, an impersonated owner, an unattributed principal, and a
  // declared-but-unimplemented execution adapter all fail closed, with the
  // orchestrator untouched on every refusal.
  const T = arg.tokens;
  const root = arg.guidedRoot;
  const guided = (body, token) => call('POST', '/workspace', { guided: true, ...body }, { token });
  const callsAtStart = await mockCalls();

  // happy path: label narrows the basename; everything else is server-minted
  const created = await guided({ label: 'demo-lab', owner: 'alice' }, T.alice);
  const ws = created.json && created.json.workspace;
  check('guided-labeled-200', created.status === 200 && created.json && created.json.ok === true, JSON.stringify(created.json || {}).slice(0, 200));
  check('guided-path-under-root', Boolean(ws) && typeof ws.path === 'string' && ws.path.startsWith(root + '/demo-lab-'), ws && ws.path);
  check('guided-owner-derived', Boolean(ws) && ws.owner === 'alice', ws && ws.owner);
  check('guided-root-echoed', created.json && created.json.guided && created.json.guided.root === root);
  check('guided-has-workspace-id', Boolean(ws) && typeof ws.workspaceId === 'string' && ws.workspaceId.length > 0);

  const bare = await guided({ owner: 'alice' }, T.alice);
  check('guided-unlabeled-200', bare.status === 200 && bare.json && bare.json.ok === true, JSON.stringify(bare.json || {}).slice(0, 200));
  check('guided-unlabeled-servername', bare.json && bare.json.workspace && bare.json.workspace.path.startsWith(root + '/ws-'), bare.json && bare.json.workspace && bare.json.workspace.path);

  // unsafe labels are REJECTED, never sanitized into something else
  const badLabels = [
    ['traversal-label', '../../escape'],
    ['absolute-label', '/etc/evil'],
    ['dotdot-label', 'ok..name'],
    ['space-label', 'Demo Lab'],
  ];
  for (const [name, bad] of badLabels) {
    const p = await probe('guided-label-' + name, () => guided({ label: bad, owner: 'alice' }, T.alice));
    check(name + '-400', p.status === 400 && p.code === 'workspace-label-invalid', JSON.stringify(p));
    check(name + '-zero-writes', JSON.stringify(p.writes) === JSON.stringify(ZERO_WRITES), JSON.stringify(p.writes));
  }

  // guided and path are mutually exclusive — no smuggled paths
  const both = await probe('guided-path-conflict', () => call('POST', '/workspace', { guided: true, label: 'x', path: '/tmp/evil', owner: 'alice' }, { token: T.alice }));
  check('guided-path-conflict-400', both.status === 400 && both.code === 'guided-path-conflict', JSON.stringify(both));
  check('guided-path-conflict-zero-writes', JSON.stringify(both.writes) === JSON.stringify(ZERO_WRITES), JSON.stringify(both.writes));

  // bob may not mint a workspace owned by alice
  const mallory = await probe('guided-impersonation', () => guided({ label: 'steal', owner: 'alice' }, T.bob));
  check('guided-impersonation-403', mallory.status === 403 && mallory.code === 'owner-impersonation-refused', JSON.stringify(mallory));
  check('guided-impersonation-zero-writes', JSON.stringify(mallory.writes) === JSON.stringify(ZERO_WRITES), JSON.stringify(mallory.writes));

  // svc-root holds two owners; with no owner named the request is unattributable
  const unattr = await probe('guided-unattributed', () => guided({ label: 'whose' }, T.root));
  check('guided-unattributed-403', unattr.status === 403 && unattr.code === 'owner-attribution-required', JSON.stringify(unattr));
  check('guided-unattributed-zero-writes', JSON.stringify(unattr.writes) === JSON.stringify(ZERO_WRITES), JSON.stringify(unattr.writes));

  // GPT negative 7: a declared-but-unimplemented execution adapter is an honest
  // 501 — inspectable, refused before registration, never a silent fallback.
  const broken = await probe('guided-adapter-missing', () => call('POST', '/workspace', { guided: true, label: 'broken', environmentId: 'env-broken', owner: 'alice' }, { token: T.root }));
  check('guided-adapter-missing-501', broken.status === 501 && broken.code === 'solari-orchestrator-not-deployed', JSON.stringify(broken));
  check('guided-adapter-missing-zero-writes', JSON.stringify(broken.writes) === JSON.stringify(ZERO_WRITES), JSON.stringify(broken.writes));

  // svc-alice is scoped to env-local; reaching for the broken env is an
  // authorization refusal at the boundary — zero contact of any kind.
  const envDenied = await probe('guided-env-unauthorized', () => call('POST', '/workspace', { guided: true, label: 'nope', environmentId: 'env-broken', owner: 'alice' }, { token: T.alice }));
  check('guided-env-unauthorized-403', envDenied.status === 403 && envDenied.code === 'environment-unauthorized', JSON.stringify(envDenied));
  check('guided-env-unauthorized-zero-writes', JSON.stringify(envDenied.writes) === JSON.stringify(ZERO_WRITES), JSON.stringify(envDenied.writes));
  check('guided-env-unauthorized-zero-reads', envDenied.marketplaceGets === 0);

  // exactly the two happy-path creates registered a codebase; nothing else did
  const callsNow = await mockCalls();
  check('guided-two-registrations', callsNow.codebasePosts - callsAtStart.codebasePosts === 2, JSON.stringify({ atStart: callsAtStart.codebasePosts, now: callsNow.codebasePosts }));
  check('guided-zero-dispatch', callsNow.dispatchPosts === callsAtStart.dispatchPosts);
} else if (caseName === 'workspace-guided-unconfigured') {
  // Dev posture, NO workspaces.root: guided creation fails CLOSED — a beginner
  // never gets a guessed path — while the advanced path-supplied flow (the
  // authorized escape hatch) still works exactly as before.
  const p = await probe('guided-unconfigured', () => call('POST', '/workspace', { guided: true, label: 'demo-lab', owner: 'alice' }, {}));
  check('guided-unconfigured-400', p.status === 400 && p.code === 'workspace-root-not-configured', JSON.stringify(p));
  check('guided-unconfigured-zero-writes', JSON.stringify(p.writes) === JSON.stringify(ZERO_WRITES), JSON.stringify(p.writes));

  const both = await probe('guided-unconfigured-path-conflict', () => call('POST', '/workspace', { guided: true, path: '/tmp/x' }, {}));
  check('guided-unconfigured-conflict-400', both.status === 400 && both.code === 'guided-path-conflict', JSON.stringify(both));
  check('guided-unconfigured-conflict-zero-writes', JSON.stringify(both.writes) === JSON.stringify(ZERO_WRITES), JSON.stringify(both.writes));

  // positive control: the advanced flow is untouched by the guided branch
  const advPath = join(dshHome, 'ws', 'advanced-' + wsRunToken);
  await mkdir(advPath, { recursive: true });
  const adv = await call('POST', '/workspace', { path: advPath, owner: 'alice' }, {});
  check('advanced-flow-200', adv.status === 200 && adv.json && adv.json.ok === true, JSON.stringify(adv.json || {}).slice(0, 200));
  check('advanced-flow-is-own-path', adv.json && adv.json.workspace && adv.json.workspace.path === advPath);
} else if (caseName === 'beginner-flow') {
  // P5 gate demo (required mode): ONE beginner principal walks provisioning →
  // discovery → inspection → import → execution-authorization → execution-
  // verification → capability-admission, starting from an empty store. Every
  // stage reports its own verdict in out.stages; where this harness cannot
  // honestly execute something real, the stage says UNVERIFIED instead of
  // performing a simulation and calling it a run.
  const T = arg.tokens;
  const tok = T.alice;
  const stages = [];
  const stage = (name, verdict, detail) => stages.push({ stage: name, verdict, detail });
  const callsAtStart = await mockCalls();
  const registryBefore = await readFile(arg.registryPath, 'utf8');

  // 1 — provisioning: guided creation, server-minted path, principal-derived owner
  const prov = await call('POST', '/workspace', { guided: true, label: 'demo-lab', owner: 'alice' }, { token: tok });
  const ws = prov.json && prov.json.workspace;
  const provOk = prov.status === 200 && Boolean(ws) && typeof ws.path === 'string' && ws.path.startsWith(arg.beginnerRoot + '/demo-lab-') && ws.owner === 'alice';
  check('stage-provisioning', provOk, JSON.stringify(prov.json || {}).slice(0, 240));
  stage('workspace-provisioning', provOk ? 'PASS' : 'FAIL', provOk ? 'guided create minted ' + ws.path + ' for owner ' + ws.owner + ' under the configured root' : 'guided create refused');
  arg.owner = 'alice';
  arg.token = tok;
  arg.workspaceId = ws && ws.workspaceId;

  // 2 — discovery: what the marketplace offers, with no source bytes in the listing
  const status = await call('GET', '/marketplace?op=status', undefined, { token: tok });
  const search = await call('GET', '/marketplace?op=search', undefined, { token: tok });
  const ids = ((search.json && search.json.entries) || []).map((e) => e.id);
  const noSourceInList = ((search.json && search.json.entries) || []).every((e) => e.source === undefined);
  const discOk = status.json && status.json.supported === true && ids.includes('mkt-clean') && ids.includes('mkt-medium') && ids.includes('mkt-critical');
  check('stage-discovery', discOk, JSON.stringify({ supported: status.json && status.json.supported, ids }));
  check('stage-discovery-no-source-bytes', noSourceInList);
  stage('discovery', discOk && noSourceInList ? 'PASS' : 'FAIL', ids.length + ' entries visible; requirements, revisions, and security status listed without source bytes');

  // 3 — inspection: findings readable BEFORE any install decision
  const inspClean = await call('GET', '/marketplace?op=inspect&entry_id=mkt-clean', undefined, { token: tok });
  const inspMedium = await call('GET', '/marketplace?op=inspect&entry_id=mkt-medium', undefined, { token: tok });
  const cleanEntry = inspClean.json && inspClean.json.entry;
  const medEntry = inspMedium.json && inspMedium.json.entry;
  const medFindings = (medEntry && medEntry.securityReview && medEntry.securityReview.findings) || [];
  const inspOk = inspClean.status === 200 && inspMedium.status === 200 && Boolean(cleanEntry) && Boolean(cleanEntry.securityReview) && cleanEntry.securityReview.status === 'complete' && medFindings.filter((f) => f.severity === 'medium').length === 1;
  check('stage-inspection', inspOk, JSON.stringify({ clean: cleanEntry && cleanEntry.securityReview, medium: medEntry && medEntry.securityReview }));
  const noBytes = !JSON.stringify(inspClean.json).includes('run: echo') && !JSON.stringify(inspMedium.json).includes('run: echo');
  check('stage-inspection-no-source-bytes', noBytes);
  stage('inspection', inspOk && noBytes ? 'PASS' : 'FAIL', 'security evidence inspectable pre-install: clean entry scan-complete, medium entry shows 1 medium finding; source withheld');

  // 4 — import: clean installs; medium is blocked until explicit human approval,
  // and the recorded approval names the SERVER-derived principal, not the client
  const clean = await probe('stage-import-clean', () => doImport('mkt-clean'));
  check('stage-import-clean-200', clean.status === 200 && clean.ok === true, JSON.stringify(clean));
  const yamlPath = join(arg.config.marketplace.workflowsDir, 'market-clean.yaml');
  check('stage-import-clean-yaml', (await fileExists(yamlPath)) === true, yamlPath);

  const medRefused = await probe('stage-import-medium-unapproved', () => doImport('mkt-medium'));
  check('stage-import-medium-refused', medRefused.status === 403 && medRefused.code === 'security-approval-required', JSON.stringify(medRefused));
  check('stage-import-medium-refused-zero-writes', JSON.stringify(medRefused.writes) === JSON.stringify(ZERO_WRITES), JSON.stringify(medRefused.writes));

  const medOk = await probe('stage-import-medium-approved', () => doImport('mkt-medium', { approval: { acknowledged: true } }));
  check('stage-import-medium-200', medOk.status === 200 && medOk.ok === true, JSON.stringify(medOk));
  const medRec = (await ledgerOnDisk()).imports.find((r) => r.entryId === 'mkt-medium');
  // 'svc-alice' is the authenticated PRINCIPAL id — the identity the server
  // itself derived, not the owner label and not anything the client sent.
  const approvalOk = medRec && medRec.approval && medRec.approval.acknowledged === true && medRec.approval.by === 'svc-alice' && typeof medRec.approval.at === 'string' && medRec.approval.at !== '1970-01-01T00:00:00.000Z';
  check('stage-import-approval-server-derived', approvalOk, JSON.stringify(medRec && medRec.approval));
  stage('import', clean.status === 200 && medRefused.status === 403 && medOk.status === 200 && approvalOk ? 'PASS' : 'FAIL', 'clean entry installed to the configured target; medium entry blocked until approval; approval recorded by principal svc-alice (server-derived) at server time');

  // 5 — execution authorization: the record itself states no authority was conferred
  const installs = await call('GET', '/marketplace?op=installations', undefined, { token: tok });
  const recClean = ((installs.json && installs.json.imports) || []).find((r) => r.entryId === 'mkt-clean');
  const authzOk = Boolean(recClean) && recClean.executionEligible === false && recClean.executionVerified === false && recClean.states && Boolean(recClean.states.installed) && Object.keys(recClean.states).length === 1;
  check('stage-execution-authorization', authzOk, JSON.stringify(recClean || {}).slice(0, 300));
  stage('execution-authorization', authzOk ? 'PASS' : 'FAIL', 'installation record carries executionEligible=false, executionVerified=false, states=installed only — installing did NOT confer execution authority');

  // 6 — execution verification: honestly UNVERIFIED. This harness runs a mock
  // orchestrator; no real workflow execution was attempted and none is claimed.
  const callsNow = await mockCalls();
  const zeroDispatch = callsNow.dispatchPosts === callsAtStart.dispatchPosts;
  check('stage-execution-zero-dispatch', zeroDispatch, JSON.stringify({ dispatchPostsAtStart: callsAtStart.dispatchPosts, dispatchPostsNow: callsNow.dispatchPosts }));
  stage('execution-verification', 'UNVERIFIED', 'isolated harness runs a mock Archon — no real workflow execution was attempted and none is claimed; dispatch counter unmoved at ' + callsAtStart.dispatchPosts);

  // 7 — capability admission: installation is NOT admission; the promotion
  // path exists and was not exercised, and nothing pretended otherwise.
  const rcos = await call('GET', '/rcos', undefined, { token: tok });
  const capIds = ((rcos.json && rcos.json.registry && rcos.json.registry.capabilities) || []).map((c) => c.id);
  const recCleanLedger = (await ledgerOnDisk()).imports.find((r) => r.entryId === 'mkt-clean');
  const registryAfter = await readFile(arg.registryPath, 'utf8');
  const admOk = !capIds.includes('market-clean') && Boolean(recCleanLedger) && recCleanLedger.promotion && recCleanLedger.promotion.admitted === false && registryAfter === registryBefore;
  check('stage-admission', admOk, JSON.stringify({ capIds, promotion: recCleanLedger && recCleanLedger.promotion, registryUnchanged: registryAfter === registryBefore }));
  stage('capability-admission', admOk ? 'PASS' : 'FAIL', 'installed workflow is NOT a capability: registry bytes unchanged, promotion.admitted=false — admission requires the RCOS promotion path, which this flow does not exercise and does not claim to');

  out.stages = stages;
  check('seven-stages-reported', stages.length === 7, JSON.stringify(stages.map((s) => s.stage + ':' + s.verdict)));
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
