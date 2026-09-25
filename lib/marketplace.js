// lib/marketplace.js — P4 Archon marketplace integration (design:
// docs/plans/2026-09-22-p4-marketplace-integration-design.md).
//
// Discover → Inspect → Install, with the later states (execution-eligible,
// execution-verified, promoted) RECORDED but never conferred here. The three
// structural rules the GPT order pins:
//   1. feature detection against the documented GET /api/openapi.json — an
//      install without a marketplace namespace is honestly unavailable and
//      every other op is untouched (older installs keep working);
//   2. authorization BEFORE orchestrator contact — the P3B ladder
//      (ownerForRequest → resolveWorkspace → environmentAllowedForPrincipal)
//      runs before the first marketplace fetch, so an unauthorized import
//      leaves zero orchestrator side effects;
//   3. installation is not admission — an import never writes the capability
//      registry, never creates a teaching envelope, and its ledger record
//      carries promotion.admitted:false with the authority named.

import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getDshHome, resolveConfig } from './config.js';
import { ownerForRequest, environmentAllowedForPrincipal, AUTH_REFUSAL } from './auth.js';
import { resolveWorkspace } from './workspace.js';

const sha256s = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const isoNow = () => new Date().toISOString();
const MARKET_NS = '/api/marketplace/';

// Transport-shaped refusal, identical vocabulary to every other refusal on
// this surface. The route handler sends it verbatim.
const refuse = (status, code, error, extra) => ({ ok: false, status, code, error, ...(extra || {}) });

// ---------------------------------------------------------------- detection

// The documented discovery endpoint. A real v0.10.x install answers 404 here
// (no openapi route) — that is the NOT_ADVERTISED verdict, an expected shape,
// not an error. Never throws; degraded honesty is the contract.
//
// The outcome vocabulary mirrors lib/status.js: an UNREADABLE read is never
// reported as absence. `supported:false` alone used to collapse four distinct
// conditions (unconfigured, an unhealthy HTTP answer, an unreadable body, and a
// thrown fetch/timeout) into "this installation does not advertise a
// marketplace" — a durable claim about the installation derived from a
// transient failure. NOT_ADVERTISED is now concluded ONLY when Archon actually
// answered and simply advertises no marketplace namespace.
export async function detectMarketplaceSupport(archon) {
  const base = String((archon && archon.baseUrl) || '').replace(/\/$/, '');
  const notAdvertisedHint = 'this Archon installation does not advertise a marketplace — discovery, inspection, and import are unavailable; the rest of the operator surface is unaffected';
  if (!base) {
    return {
      supported: false, outcome: 'NOT_CONFIGURED', reason: 'marketplace-not-configured',
      hint: 'no Archon base URL is configured, so marketplace support cannot be determined — set archon.baseUrl (or DSH_OPERATOR_UI_ARCHON); the rest of the operator surface is unaffected',
    };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (archon && archon.timeoutMs) || 5000);
    let res;
    try { res = await fetch(base + '/api/openapi.json', { signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    if (res.status === 404) return { supported: false, outcome: 'NOT_ADVERTISED', reason: 'marketplace-not-advertised', hint: notAdvertisedHint };
    if (!res.ok) {
      return {
        supported: false, outcome: 'UNAVAILABLE', reason: 'marketplace-unreachable',
        hint: 'Archon at ' + base + ' answered HTTP ' + res.status + ' for its discovery document — the endpoint is reachable but unhealthy, so marketplace support is UNKNOWN (not unsupported); check the Archon server. The rest of the operator surface is unaffected',
      };
    }
    let doc;
    try { doc = await res.json(); } catch {
      return {
        supported: false, outcome: 'INVALID', reason: 'marketplace-openapi-invalid',
        hint: 'Archon at ' + base + ' answered HTTP 200 for its discovery document but the body was not readable JSON — marketplace support is UNKNOWN (not unsupported); check the Archon server. The rest of the operator surface is unaffected',
      };
    }
    const paths = doc && doc.paths && typeof doc.paths === 'object' ? Object.keys(doc.paths) : [];
    const marketPaths = paths.filter((p) => typeof p === 'string' && p.startsWith(MARKET_NS));
    if (!marketPaths.length) return { supported: false, outcome: 'NOT_ADVERTISED', reason: 'marketplace-not-advertised', hint: notAdvertisedHint };
    return { supported: true, outcome: 'AVAILABLE', paths: marketPaths };
  } catch (e) {
    return {
      supported: false, outcome: 'UNAVAILABLE', reason: 'marketplace-unreachable',
      hint: 'Archon at ' + base + ' could not be reached for its discovery document (' + String((e && e.message) || e).slice(0, 120) + ') — marketplace support is UNKNOWN (not unsupported); start Archon or check archon.baseUrl. The rest of the operator surface is unaffected',
    };
  }
}

// ------------------------------------------------------------------ scoping

// Marketplace visibility: a private entry is visible only to a principal that
// holds its owner. Dev mode (null principal) sees PUBLIC ONLY — fail closed:
// the pre-authentication dev posture never becomes a way to browse someone's
// private catalog entries.
export function entryVisibleToPrincipal(entry, principal) {
  if (!entry) return false;
  if (entry.visibility !== 'private') return true;
  if (!principal) return false;
  const owners = principal.ownerIds || [];
  return typeof entry.owner === 'string' && owners.includes(entry.owner);
}

export function scopeEntriesForPrincipal(entries, principal) {
  return (Array.isArray(entries) ? entries : []).filter((e) => entryVisibleToPrincipal(e, principal));
}

function visibilityRefusal(entry, principal) {
  return refuse(403, 'marketplace-entry-forbidden',
    'marketplace entry "' + entry.id + '" is private to owner "' + entry.owner + '" and principal "' + (principal ? principal.id : 'dev') + '" does not hold that owner');
}

// ---------------------------------------------------------- security policy
//
// GPT-approved policy, verbatim semantics:
//   critical/high block installation; medium requires explicit human approval;
//   low does not waive execution permissions or other required checks;
//   failed, missing, or incomplete security evidence fails closed;
//   an AI review alone is not proof of safety.
export function evaluateSecurity(review) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  if (!review || typeof review !== 'object') {
    return { ok: false, code: 'security-evidence-incomplete', status: 403, counts, reason: 'no security review is present for this entry' };
  }
  if (review.status !== 'complete') {
    return { ok: false, code: 'security-evidence-incomplete', status: 403, counts, reason: 'security review status is "' + String(review.status) + '" — failed or incomplete evidence fails closed' };
  }
  // An AI review alone is not proof of safety: the evidence must carry a
  // deterministic scan component.
  if (review.kind === 'ai-review') {
    return { ok: false, code: 'security-evidence-insufficient', status: 403, counts, reason: 'the only security evidence is an AI review — a deterministic scan is required and an AI review alone is not accepted as proof of safety' };
  }
  if (!Array.isArray(review.findings)) {
    return { ok: false, code: 'security-evidence-incomplete', status: 403, counts, reason: 'security review carries no findings array — incomplete evidence fails closed' };
  }
  for (const f of review.findings) {
    const sev = f && typeof f.severity === 'string' ? f.severity.toLowerCase() : null;
    if (sev && sev in counts) counts[sev] += 1;
  }
  if (counts.critical > 0 || counts.high > 0) {
    return { ok: false, code: 'security-blocking-findings', status: 403, counts, reason: 'security review reports ' + counts.critical + ' critical and ' + counts.high + ' high findings — installation is blocked' };
  }
  if (counts.medium > 0) {
    return { ok: false, code: 'security-approval-required', status: 403, counts, reason: 'security review reports ' + counts.medium + ' medium finding(s) — installation requires explicit human approval' };
  }
  return { ok: true, counts, reason: counts.low > 0 ? 'clean except ' + counts.low + ' low finding(s) — recorded, non-blocking, waiving nothing' : 'clean' };
}

// ------------------------------------------------- our own deterministic gate
//
// Runs on the DOWNLOADED bytes — the marketplace's scan verdict is never
// trusted for the patterns that matter (the seeded clean-scan-but-evil entry
// proves the point). Same forbidden families as the acquisition static gate,
// minus the learned-dialect contract (a marketplace workflow is arbitrary
// Archon YAML, not a composed candidate).
export function marketStaticChecks(yamlText) {
  const failures = [];
  const push = (code, detail) => failures.push({ code, detail });
  if (typeof yamlText !== 'string' || !yamlText.trim()) return { ok: false, failures: [{ code: 'SOURCE_EMPTY', detail: 'no workflow source at the pinned revision' }], name: null };
  const name = (yamlText.match(/^name:\s*(\S+)/m) || [])[1];
  if (!name) push('NAME_MISSING', 'workflow has no name');
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) push('NAME_FORMAT', 'name "' + name + '" must be lowercase-hyphenated');
  if (!/^nodes:\s*(\n|$)/m.test(yamlText) && !/^nodes:\s*\[/m.test(yamlText)) push('NODES_MISSING', 'workflow has no nodes list');
  if (/>\s*\/(?!dev\/null)/.test(yamlText) || /\btee\s+\/(?!dev\/null)/.test(yamlText)) push('LOCATION_ABSOLUTE_WRITE', 'redirect to an absolute path — artifacts must stay in the workspace');
  if (/(cp|mv|tee|>)\s+["']?\.\.\//.test(yamlText)) push('LOCATION_PARENT_ESCAPE', 'writes via ../ escape the workspace');
  for (const [code, re, why] of [
    ['FORBIDDEN_NETWORK', /\b(curl|wget|nc|ncat|ftp|ssh|scp|rsync|ping)\b/, 'network access is not allowed'],
    ['FORBIDDEN_PRIVILEGE', /\b(sudo|su|doas)\b/, 'privilege escalation is not allowed'],
    ['FORBIDDEN_DESTRUCTIVE', /(rm\s+-rf\s+[\/~]|mkfs|dd\s+if=|>\s*\/dev\/sd[a-z])/, 'destructive shell is not allowed'],
    ['FORBIDDEN_CREDENTIAL', /(~\/\.[a-z-]*secrets|~\/\.ssh|~\/\.aws|\.netrc|id_rsa)/, 'credential stores must never be read'],
  ]) if (re.test(yamlText)) push(code, why);
  return { ok: failures.length === 0, failures, name };
}

// ------------------------------------------------------------------- ledger

const LEDGER_VERSION = 1;

function ledgerFilePath() {
  return join(getDshHome(), 'operator-ui', 'marketplace.json');
}

// Read the ledger and REPORT why it could not be read. An unreadable or
// corrupt ledger is NEVER the same fact as "no imports yet": the first is a
// refusal (fail closed), the second is a legitimately empty list. `[]` used to
// collapse both — which let `appendLedger` rewrite the file from the empty
// read (silently discarding import history) and let the idempotency guard
// re-permit an entry that was already installed.
//
// Returns { ok: true, imports } | { ok: false, code, reason }.
export async function readLedger() {
  let raw;
  try {
    raw = await readFile(ledgerFilePath(), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, imports: [] }; // no ledger file yet — legitimately empty
    return { ok: false, code: 'ledger-unreadable', reason: 'the marketplace ledger exists but could not be read (' + String((e && e.message) || e).slice(0, 120) + ') — refusing to treat it as empty' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, code: 'ledger-corrupt', reason: 'the marketplace ledger is not valid JSON (' + String((e && e.message) || e).slice(0, 100) + ') — refusing to treat it as empty' };
  }
  if (!parsed || parsed.ledgerVersion !== LEDGER_VERSION || !Array.isArray(parsed.imports)) {
    return { ok: false, code: 'ledger-corrupt', reason: 'the marketplace ledger does not match ledgerVersion ' + LEDGER_VERSION + ' + imports[] — refusing to treat it as empty' };
  }
  return { ok: true, imports: parsed.imports };
}

// Appends to the ledger array the caller ALREADY read (and validated). Taking
// the read as an argument removes the read-modify-write hazard entirely: no
// write can ever proceed from an unreadable read.
async function appendLedger(imports, record) {
  imports.push(record);
  const file = ledgerFilePath();
  const tmp = file + '.tmp';
  await mkdir(dirname(file), { recursive: true });
  await writeFile(tmp, JSON.stringify({ ledgerVersion: LEDGER_VERSION, imports }, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
  return record;
}

// ------------------------------------------------------------------- import
//
// The ladder order IS the contract (design §the-import-ladder): configuration
// and authorization refusals happen before ANY orchestrator contact; content
// and security refusals happen before ANY local write.
export async function importMarketplaceWorkflow({ entryId, revision, workspaceId, owner, approval, principal }) {
  const { config } = resolveConfig();
  const archon = config.archon;

  // (1) the one local write target this operation may ever use
  if (!config.marketplace || !config.marketplace.workflowsDir) {
    return refuse(400, 'marketplace-target-not-configured', 'marketplace.workflowsDir is not configured — there is nowhere to install an imported workflow');
  }

  // (2) P3B authorization ladder — principal→owner, then principal→workspace
  // record, then principal→environment. Zero Archon contact has happened.
  const ownerDecision = ownerForRequest({ principal, owner, code: AUTH_REFUSAL.IMPERSONATION });
  if (!ownerDecision.ok) return refuse(ownerDecision.status, ownerDecision.code, ownerDecision.error);
  const resolvedOwner = ownerDecision.owner;
  if (!workspaceId || typeof workspaceId !== 'string') {
    return refuse(400, 'workspace-id-required', 'import requires a workspaceId — installations are attributed to a workspace');
  }
  let ws = null;
  try {
    ws = await resolveWorkspace({ workspaceId, owner: resolvedOwner });
  } catch (e) {
    const code = (e && e.code) || null;
    if (code === 'workspace-owner-mismatch') {
      return refuse(403, AUTH_REFUSAL.WORKSPACE_DENIED, 'cross-workspace access refused: workspace "' + workspaceId + '" does not belong to owner "' + resolvedOwner + '"');
    }
    if (code === 'workspace-not-found') {
      return refuse(404, 'workspace-not-found', 'no such workspace: ' + workspaceId);
    }
    return refuse(400, code || 'workspace-unresolvable', 'workspace resolution failed: ' + String((e && e.message) || e).slice(0, 200));
  }
  const envDecision = environmentAllowedForPrincipal({ principal, environmentId: ws.environmentId });
  if (!envDecision.ok) return refuse(envDecision.status, envDecision.code, envDecision.error);

  // (3) feature detection — an install without a marketplace never reaches
  // the fetches below. An OUTAGE during detection is not "unsupported": the
  // refusal names the actual cause, and its hint names the STEP that could not
  // run so the diagnostic is precise without fragmenting the code.
  const support = await detectMarketplaceSupport(archon);
  if (!support.supported) {
    if (support.outcome === 'UNAVAILABLE') return refuse(502, 'marketplace-unreachable', 'feature detection could not run — ' + (support.hint || 'Archon could not be read; marketplace support is unknown'));
    if (support.outcome === 'INVALID') return refuse(502, support.reason, 'feature detection could not run — ' + (support.hint || 'Archon answered but its discovery document was unusable'));
    if (support.outcome === 'NOT_CONFIGURED') return refuse(400, support.reason, support.hint || 'no Archon base URL is configured');
    return refuse(409, 'marketplace-unsupported', support.hint || 'marketplace is not available on this Archon installation');
  }

  // (4)-(6) the entry, its pin, and its bytes — reads only
  const base = archon.baseUrl.replace(/\/$/, '');
  let entry = null;
  try {
    const res = await fetch(base + '/api/marketplace/entries/' + encodeURIComponent(String(entryId || '')));
    if (res.status === 404) return refuse(404, 'marketplace-entry-not-found', 'no such marketplace entry: ' + entryId);
    entry = await res.json();
    if (entry && entry.entry) entry = entry.entry;
  } catch {
    return refuse(502, 'marketplace-unreachable', 'marketplace entry fetch failed');
  }
  if (!entry || !entry.id) return refuse(404, 'marketplace-entry-not-found', 'no such marketplace entry: ' + entryId);
  if (!entryVisibleToPrincipal(entry, principal)) return visibilityRefusal(entry, principal);

  if (typeof entry.revision !== 'string' || !entry.revision.trim() || typeof entry.digest !== 'string' || !entry.digest.trim()) {
    return refuse(403, 'source-unpinned', 'entry "' + entry.id + '" declares no pinned revision + content digest — unpinned sources fail closed');
  }
  const pinned = entry.revision.trim();
  if (revision !== undefined && revision !== null && String(revision) !== pinned) {
    return refuse(409, 'revision-mismatch', 'requested revision "' + String(revision) + '" is not the pinned revision "' + pinned + '"');
  }

  // (5b) locally-knowable dependencies — an entry whose declared requirements
  // this installation cannot satisfy fails closed BEFORE a byte is fetched.
  // Unknown requirement ids are missing by definition (fail closed).
  const LOCAL_DEPENDENCIES = {
    archon: (c) => Boolean(c.archon && c.archon.baseUrl),
    registry: (c) => Boolean(c.registry && c.registry.path),
    teaching: (c) => Boolean(c.teaching && c.teaching.workflowsDir),
    acquisition: (c) => Boolean(c.acquisition),
    flowrouter: (c) => Boolean(c.flowrouter),
  };
  const requires = Array.isArray(entry.requires) ? entry.requires : [];
  const missingDeps = requires.filter((dep) => {
    if (typeof dep !== 'string') return true;
    const check = LOCAL_DEPENDENCIES[dep];
    return check ? !check(config) : true;
  });
  if (missingDeps.length) {
    return refuse(403, 'missing-dependency', 'entry "' + entry.id + '" requires locally unsatisfied dependencies: ' + missingDeps.join(', '));
  }

  let sourceText = null;
  try {
    const res = await fetch(base + '/api/marketplace/entries/' + encodeURIComponent(entry.id) + '/source?revision=' + encodeURIComponent(pinned));
    if (!res.ok) return refuse(502, 'marketplace-unreachable', 'marketplace source fetch failed (HTTP ' + res.status + ')');
    sourceText = await res.text();
  } catch {
    return refuse(502, 'marketplace-unreachable', 'marketplace source fetch failed');
  }
  const actualDigest = sha256s(sourceText);
  if (actualDigest !== entry.digest.trim()) {
    return refuse(403, 'source-tampered', 'served bytes digest ' + actualDigest + ' does not match the pinned digest ' + entry.digest.trim() + ' — the source changed under the pin');
  }

  // (7) the approved security policy, evaluated against the entry's evidence
  const security = evaluateSecurity(entry.securityReview);
  if (!security.ok && security.code !== 'security-approval-required') return security;

  let recordedApproval = null;
  if (security.code === 'security-approval-required') {
    if (!approval || approval.acknowledged !== true) return security;
    recordedApproval = { acknowledged: true, by: principal ? principal.id : 'operator-dev', at: isoNow() };
  }

  // (8) our own deterministic pass on the downloaded bytes
  const checks = marketStaticChecks(sourceText);
  if (!checks.ok || !checks.name) {
    return refuse(403, 'market-static-forbidden', 'the downloaded source failed deterministic static checks: ' +
      (checks.failures.length ? checks.failures.map((f) => f.code + ' (' + f.detail + ')').join('; ') : 'no workflow name could be resolved'));
  }
  const name = checks.name;

  // (9) admission guard — an import must never shadow a certified capability
  if (config.registry && config.registry.path) {
    let registry = null;
    try {
      registry = JSON.parse(await readFile(config.registry.path, 'utf8'));
    } catch {
      return refuse(403, 'registry-unreadable', 'the capability registry is configured but unreadable — failing closed rather than importing unverified');
    }
    const caps = registry && Array.isArray(registry.capabilities) ? registry.capabilities : null;
    if (!caps) return refuse(403, 'registry-unreadable', 'the capability registry has no capabilities array — failing closed');
    if (caps.some((c) => c && (c.id === name || c.workflow === name))) {
      return refuse(409, 'capability-name-collision', 'workflow name "' + name + '" collides with a certified registry capability — an import may never shadow admitted authority');
    }
  }

  // (10) idempotency — same entry at the same revision for the same owner.
  // The ledger is read ONCE here; an unreadable/corrupt ledger fails closed
  // BEFORE any write, so it can never be rewritten from an empty read (which
  // would discard import history) or let an already-installed entry through.
  const ledgerRead = await readLedger();
  if (!ledgerRead.ok) {
    return refuse(500, ledgerRead.code, ledgerRead.reason + ' — the import is refused rather than rewriting the ledger');
  }
  const ledger = ledgerRead.imports;
  if (ledger.some((r) => r.entryId === entry.id && r.revision === pinned && r.owner === resolvedOwner)) {
    return refuse(409, 'already-installed', 'entry "' + entry.id + '" at revision ' + pinned + ' is already installed for owner "' + resolvedOwner + '"');
  }

  // (11) the only two writes this operation can ever make
  const fileName = name + '.yaml';
  await mkdir(config.marketplace.workflowsDir, { recursive: true });
  await writeFile(join(config.marketplace.workflowsDir, fileName), sourceText, 'utf8');
  const record = {
    importId: 'mkt_' + randomUUID().slice(0, 8),
    entryId: entry.id,
    entryName: entry.name || entry.id,
    publisher: entry.owner || 'marketplace',
    revision: pinned,
    digest: entry.digest.trim(),
    owner: resolvedOwner,
    workspaceId,
    environmentId: ws.environmentId,
    importedAt: isoNow(),
    installedAs: fileName,
    security: { kind: entry.securityReview.kind || 'unknown', status: entry.securityReview.status, counts: security.counts },
    approval: recordedApproval,
    states: { installed: isoNow() },
    executionEligible: false,
    executionVerified: false,
    promotion: {
      admitted: false,
      authority: 'registry-promotion-only (teach.promoteCandidate)',
      reason: 'marketplace installation is not capability admission',
    },
  };
  await appendLedger(ledger, record);
  return { ok: true, import: record };
}

// -------------------------------------------------------------- installations

export async function listInstallations({ principal, owner }) {
  const ownerDecision = ownerForRequest({ principal, owner, code: AUTH_REFUSAL.IMPERSONATION });
  if (!ownerDecision.ok) return ownerDecision;
  // An unreadable ledger is a refusal, never "you have no imports" — absence
  // must not be manufactured from a read that failed.
  const ledgerRead = await readLedger();
  if (!ledgerRead.ok) return { ok: false, status: 500, code: ledgerRead.code, error: ledgerRead.reason };
  const ledger = ledgerRead.imports;
  // Required mode: a principal sees its own imports. Dev mode: the same
  // everything-visible posture every other read surface already has.
  const visible = principal ? ledger.filter((r) => r.owner === ownerDecision.owner) : ledger;
  return { ok: true, imports: visible };
}

// ------------------------------------------------------------- inspection io

export async function fetchMarketplaceEntry(archon, entryId) {
  const base = String((archon && archon.baseUrl) || '').replace(/\/$/, '');
  const res = await fetch(base + '/api/marketplace/entries/' + encodeURIComponent(String(entryId || '')));
  if (res.status === 404) return { notFound: true };
  const body = await res.json();
  return { entry: body && body.entry ? body.entry : body };
}

export async function searchMarketplace(archon, q) {
  const base = String((archon && archon.baseUrl) || '').replace(/\/$/, '');
  const url = base + '/api/marketplace/search' + (q ? '?q=' + encodeURIComponent(q) : '');
  const res = await fetch(url);
  const body = await res.json();
  const entries = (body && (body.entries || body.items || body.results)) || [];
  return Array.isArray(entries) ? entries : [];
}

export async function marketplaceStatus(archon) {
  const support = await detectMarketplaceSupport(archon);
  return { ok: true, ...support };
}
