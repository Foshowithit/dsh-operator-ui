// scripts/plugin-inventory.mjs — offline ecosystem inventory normalizer/validator.
//
// K1 (docs/superpowers/plans/2026-09-28-ecosystem-capabilities-desktop-polish.md):
// read-only, manual/operator-run acquisition stays outside this module. This
// file is a pure normalizer/validator with bounded inputs and no I/O on
// import. It never fetches, scrapes, installs, or executes community code.
//
// Interfaces frozen by the plan:
//   normalizeInventory({ sources, listings })
//     -> { schema, entries, conflicts, coverage }
//   validateDispositionCoverage(inventory, decisions)
//     -> { ok, missing, duplicateDecisions, unknownEntries }
//
// Catalog research files are offline development artifacts, excluded from
// runtime imports/package contents. They are not a persistent runtime
// registry.

export const INVENTORY_SCHEMA = 'operator-plugin-inventory/1';

const MAX_SOURCES = 16;
const MAX_LISTINGS = 100;
const MAX_TEXT = 280;
const MAX_CONFLICTS = 100;
const ALLOWED_ACCESS = new Set([
  'licensed-snapshot',
  'link-only',
  'downstream-view',
  'manual-review',
]);
const ALLOWED_DISPOSITIONS = new Set([
  'native-reuse',
  'optional-host-plugin',
  'task-pack',
  'ui-enhancement',
  'duplicate',
  'defer',
  'reject',
]);

function cleanText(value, fallback = '') {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : fallback;
}

function error(type, message, extra = {}) {
  return { type, message: String(message).slice(0, MAX_TEXT), ...extra };
}

function pushConflict(conflicts, entry) {
  if (conflicts.length < MAX_CONFLICTS) conflicts.push(entry);
}

// Plain JSON-like data only: ordinary objects/arrays/scalars, no getters,
// no hidden fields, no symbols, no cycles. Accessor-bearing metadata must be
// refused as a conflict, never read through.
function isPlainData(value, seen = new Set(), depth = 0) {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 16 || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      const keys = Reflect.ownKeys(value);
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      if (!length || length.enumerable || length.get || length.set) return false;
      if (!Number.isSafeInteger(length.value) || keys.length !== length.value + 1) return false;
      for (let i = 0; i < length.value; i += 1) {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        if (!d || !d.enumerable || d.get || d.set || !Object.hasOwn(d, 'value')) return false;
        if (!isPlainData(d.value, seen, depth + 1)) return false;
      }
      return true;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false;
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !d.enumerable || d.get || d.set || !Object.hasOwn(d, 'value')) return false;
      if (!isPlainData(d.value, seen, depth + 1)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function hasAccessor(value) {
  try {
    if (!value || typeof value !== 'object') return false;
    for (const key of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (d && (d.get || d.set)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function nonblank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validUrl(value) {
  if (!nonblank(value)) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

// Normalize a repository URL for overlap comparison. Lowercase origin+path,
// strip trailing slashes and a .git suffix. A monorepo subpath stays on the
// entry record; comparison uses the repo root only.
export function normalizeRepositoryUrl(url) {
  if (!nonblank(url)) return null;
  try {
    const u = new URL(url.trim());
    let path = u.pathname.replace(/\/+$/, '');
    if (path.toLowerCase().endsWith('.git')) path = path.slice(0, -4);
    if (!path) path = '/';
    return `${u.host.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/i, '');
  }
}

function normalizeSource(raw, conflicts) {
  if (!raw || typeof raw !== 'object' || hasAccessor(raw) || !isPlainData(raw)) {
    pushConflict(conflicts, error('malformed-source', 'source is not plain data'));
    return null;
  }
  const sourceId = cleanText(raw.sourceId);
  if (!nonblank(sourceId)) {
    pushConflict(conflicts, error('malformed-source', 'source missing sourceId'));
    return null;
  }
  const sourceUrl = nonblank(raw.sourceUrl) ? raw.sourceUrl.trim().slice(0, MAX_TEXT) : null;
  if (raw.sourceUrl !== undefined && raw.sourceUrl !== null && !validUrl(raw.sourceUrl)) {
    pushConflict(conflicts, error('malformed-source', 'source URL is not a valid URL', { sourceId }));
  }
  const accessBasis = nonblank(raw.accessBasis) ? raw.accessBasis.trim() : null;
  if (!accessBasis || !ALLOWED_ACCESS.has(accessBasis)) {
    pushConflict(conflicts, error('malformed-source', 'unknown accessBasis', { sourceId }));
  }
  let advertisedTotal = null;
  if (raw.advertisedTotal !== undefined && raw.advertisedTotal !== null) {
    if (!Number.isInteger(raw.advertisedTotal) || raw.advertisedTotal < 0) {
      pushConflict(conflicts, error('malformed-source', 'advertisedTotal must be an integer >= 0 or null', { sourceId }));
    } else {
      advertisedTotal = raw.advertisedTotal;
    }
  }
  let claimedRows = null;
  if (raw.collectedRows !== undefined && raw.collectedRows !== null) {
    if (!Number.isInteger(raw.collectedRows) || raw.collectedRows < 0) {
      pushConflict(conflicts, error('malformed-source', 'collectedRows must be an integer >= 0', { sourceId }));
    } else {
      claimedRows = raw.collectedRows;
    }
  }
  const traversalComplete = raw.traversalComplete === true;
  const observedAt = nonblank(raw.observedAt) ? raw.observedAt.trim().slice(0, MAX_TEXT) : null;
  const sourceDigest = nonblank(raw.sourceDigest) ? raw.sourceDigest.trim().slice(0, MAX_TEXT) : null;
  const unresolvedReason = nonblank(raw.unresolvedReason)
    ? raw.unresolvedReason.trim().slice(0, MAX_TEXT)
    : nonblank(raw.unresolvedCursor)
      ? String(raw.unresolvedCursor).trim().slice(0, MAX_TEXT)
      : null;
  return {
    sourceId,
    sourceUrl,
    observedAt,
    accessBasis: ALLOWED_ACCESS.has(accessBasis) ? accessBasis : null,
    advertisedTotal,
    claimedRows,
    traversalComplete,
    sourceDigest,
    unresolvedReason,
  };
}

function deriveEntryId(sourceId, sourceKey, index, sourceDigest) {
  if (nonblank(sourceKey)) return `${sourceId}:${sourceKey.trim().slice(0, MAX_TEXT)}`;
  const digest = nonblank(sourceDigest) ? sourceDigest.trim().slice(0, 12) : 'no-digest';
  return `${sourceId}:row-${index}#${digest}`;
}

function normalizeListing(raw, index, sourceById, conflicts) {
  if (!raw || typeof raw !== 'object' || hasAccessor(raw) || !isPlainData(raw)) {
    const entryId = `unknown:row-${index}#no-digest`;
    pushConflict(conflicts, error('malformed-listing', 'listing is not plain data', { entryId }));
    return null;
  }
  const sourceId = cleanText(raw.sourceId);
  if (!nonblank(sourceId)) {
    pushConflict(conflicts, error('missing-identity', 'listing has no sourceId', { entryId: `unknown:row-${index}#no-digest` }));
    return null;
  }
  if (!sourceById.has(sourceId)) {
    pushConflict(conflicts, error('unknown-source', 'listing references an undeclared source', { entryId: `${sourceId}:row-${index}#no-digest`, sourceId }));
    return null;
  }
  const source = sourceById.get(sourceId);
  const sourceKey = nonblank(raw.sourceKey) ? raw.sourceKey.trim().slice(0, MAX_TEXT) : null;
  let entryId = deriveEntryId(sourceId, sourceKey, index, source.sourceDigest);
  const url = nonblank(raw.url) ? raw.url.trim().slice(0, MAX_TEXT) : null;
  if (url !== null && !validUrl(raw.url)) {
    pushConflict(conflicts, error('malformed-listing', 'listing URL is not a valid URL', { entryId }));
  }
  const repositoryUrl = nonblank(raw.repositoryUrl) ? raw.repositoryUrl.trim().slice(0, MAX_TEXT) : null;
  const packageName = nonblank(raw.packageName) ? raw.packageName.trim().slice(0, MAX_TEXT) : null;
  // Scoped names (@scope/name) are preserved verbatim; never split or shorten.
  if (packageName !== null && /[\s]/.test(packageName)) {
    pushConflict(conflicts, error('malformed-listing', 'packageName contains whitespace', { entryId }));
  }
  const packageVersion = nonblank(raw.packageVersion) ? raw.packageVersion.trim().slice(0, MAX_TEXT) : null;
  if (!sourceKey && !repositoryUrl && !packageName) {
    pushConflict(conflicts, error('missing-identity', 'no sourceKey, repositoryUrl, or packageName', { entryId }));
  }
  return {
    entryId,
    sourceId,
    sourceKey,
    url,
    packageName,
    packageVersion: packageVersion ?? null,
    repositoryUrl,
    repositorySubpath: nonblank(raw.repositorySubpath) ? raw.repositorySubpath.trim().slice(0, MAX_TEXT) : null,
    repositoryRef: nonblank(raw.repositoryRef) ? raw.repositoryRef.trim().slice(0, MAX_TEXT) : null,
    publisher: nonblank(raw.publisher) ? raw.publisher.trim().slice(0, MAX_TEXT) : null,
    declaredDshRange: nonblank(raw.declaredDshRange) ? raw.declaredDshRange.trim().slice(0, MAX_TEXT) : null,
    licenseEvidence: nonblank(raw.licenseEvidence) ? raw.licenseEvidence.trim().slice(0, MAX_TEXT) : null,
    updatedAt: nonblank(raw.updatedAt) ? raw.updatedAt.trim().slice(0, MAX_TEXT) : null,
  };
}

export function normalizeInventory(input) {
  const conflicts = [];
  // Top-level guard is shallow on purpose: a single accessor-bearing row must
  // surface as a per-row malformed-listing conflict, not reject the batch.
  if (!input || typeof input !== 'object' || hasAccessor(input)) {
    return { schema: INVENTORY_SCHEMA, entries: [], conflicts: [error('malformed-input', 'input is not plain data')], coverage: [] };
  }
  const rawSources = Array.isArray(input.sources) ? input.sources : null;
  const rawListings = Array.isArray(input.listings) ? input.listings : null;
  if (!rawSources || !rawListings) {
    pushConflict(conflicts, error('malformed-input', 'sources and listings must both be arrays'));
    return { schema: INVENTORY_SCHEMA, entries: [], conflicts, coverage: [] };
  }
  if (rawSources.length > MAX_SOURCES) {
    pushConflict(conflicts, error('batch-capped', `too many sources: ${rawSources.length} > ${MAX_SOURCES}`));
  }
  const cappedListings = rawListings.length > MAX_LISTINGS;
  if (cappedListings) {
    pushConflict(
      conflicts,
      error('batch-capped', `operator batch capped at ${MAX_LISTINGS} rows; ${rawListings.length} supplied — pause and record continuation`, {
        processed: MAX_LISTINGS,
        supplied: rawListings.length,
      }),
    );
  }
  const sources = [];
  const sourceById = new Map();
  for (const raw of rawSources.slice(0, MAX_SOURCES)) {
    const s = normalizeSource(raw, conflicts);
    if (!s) continue;
    if (sourceById.has(s.sourceId)) {
      pushConflict(conflicts, error('duplicate-source', 'repeated sourceId', { sourceId: s.sourceId }));
      continue;
    }
    sourceById.set(s.sourceId, s);
    sources.push(s);
  }
  const batch = rawListings.slice(0, MAX_LISTINGS);
  const entries = [];
  const seenIds = new Map();
  batch.forEach((raw, index) => {
    const entry = normalizeListing(raw, index, sourceById, conflicts);
    if (!entry) return;
    if (seenIds.has(entry.entryId)) {
      const n = seenIds.get(entry.entryId) + 1;
      seenIds.set(entry.entryId, n);
      pushConflict(conflicts, error('duplicate-key', 'repeated sourceKey within one source', { entryId: entry.entryId }));
      entry.entryId = `${entry.entryId}#dup${n}`;
    } else {
      seenIds.set(entry.entryId, 1);
    }
    entries.push(entry);
  });
  // Overlap: same normalized repository under more than one entry. Both rows
  // are kept; the ambiguity is surfaced, never merged.
  const byRepo = new Map();
  for (const e of entries) {
    if (!e.repositoryUrl) continue;
    const key = normalizeRepositoryUrl(e.repositoryUrl);
    if (!key) continue;
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key).push(e.entryId);
  }
  for (const [repository, ids] of byRepo) {
    const sourcesTouched = new Set(ids.map((id) => entries.find((e) => e.entryId === id)?.sourceId));
    if (ids.length > 1 && (sourcesTouched.size > 1 || new Set(ids.map((id) => {
      const e = entries.find((x) => x.entryId === id);
      return `${e.packageName ?? ''}@${e.packageVersion ?? ''}#${e.repositorySubpath ?? ''}`;
    })).size > 1)) {
      // Same repo with distinct packages/subpaths/versions is expected to be
      // distinct rows; still surface cross-source overlap explicitly.
      if (sourcesTouched.size > 1) {
        pushConflict(conflicts, error('overlap', 'same repository appears in more than one source; rows kept distinct', { repository, entryIds: ids.slice().sort() }));
      }
    }
  }
  // Coverage: per-source accounting. Incomplete coverage can never read as
  // complete: a source that claims traversalComplete while its claimed or
  // actual row count disagrees with its advertised total is a mismatch.
  const coverage = sources.map((s) => {
    const actual = entries.filter((e) => e.sourceId === s.sourceId).length;
    let complete = s.traversalComplete;
    let reason = s.unresolvedReason;
    if (s.claimedRows !== null && s.claimedRows !== actual) {
      pushConflict(conflicts, error('coverage-mismatch', `source claimed ${s.claimedRows} rows but ${actual} normalized`, { sourceId: s.sourceId }));
      complete = false;
      reason = reason ?? 'claimed count disagrees with normalized rows';
    }
    if (s.advertisedTotal !== null && s.traversalComplete && actual !== s.advertisedTotal) {
      pushConflict(conflicts, error('coverage-mismatch', `traversalComplete with ${actual}/${s.advertisedTotal} rows`, { sourceId: s.sourceId }));
      complete = false;
      reason = reason ?? 'partial traversal cannot be complete';
    }
    if (cappedListings) {
      complete = false;
      reason = reason ?? 'batch capped; continuation unrecorded';
    }
    return {
      sourceId: s.sourceId,
      advertisedTotal: s.advertisedTotal,
      collectedRows: actual,
      traversalComplete: complete,
      unresolvedReason: complete ? null : (reason ?? 'partial coverage'),
    };
  }).sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  entries.sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
  conflicts.sort((a, b) => {
    const t = String(a.type).localeCompare(String(b.type));
    if (t !== 0) return t;
    return String(a.entryId ?? a.sourceId ?? '').localeCompare(String(b.entryId ?? b.sourceId ?? ''));
  });
  return { schema: INVENTORY_SCHEMA, entries, conflicts, coverage };
}

export function validateDispositionCoverage(inventory, decisions) {
  const missing = [];
  const duplicateDecisions = [];
  const unknownEntries = [];
  const ids = new Set();
  if (!inventory || typeof inventory !== 'object' || !Array.isArray(inventory.entries)) {
    return { ok: false, missing, duplicateDecisions, unknownEntries: [error('malformed-inventory', 'inventory has no entries array')] };
  }
  for (const e of inventory.entries) {
    if (e && typeof e.entryId === 'string') ids.add(e.entryId);
  }
  if (!Array.isArray(decisions)) {
    return { ok: false, missing: [...ids].sort(), duplicateDecisions, unknownEntries };
  }
  const counts = new Map();
  for (const d of decisions) {
    if (!d || typeof d !== 'object' || typeof d.entryId !== 'string') {
      unknownEntries.push(error('malformed-decision', 'decision has no entryId'));
      continue;
    }
    if (typeof d.disposition !== 'string' || !ALLOWED_DISPOSITIONS.has(d.disposition)) {
      unknownEntries.push(error('unknown-disposition', 'disposition is not in the K2 vocabulary', { entryId: d.entryId }));
      continue;
    }
    if (!ids.has(d.entryId)) {
      unknownEntries.push(error('unknown-entry', 'decision references an entry not in the inventory', { entryId: d.entryId }));
      continue;
    }
    counts.set(d.entryId, (counts.get(d.entryId) ?? 0) + 1);
  }
  for (const id of ids) {
    const n = counts.get(id) ?? 0;
    if (n === 0) missing.push(id);
    else if (n > 1) duplicateDecisions.push(id);
  }
  missing.sort();
  duplicateDecisions.sort();
  unknownEntries.sort((a, b) => String(a.entryId ?? '').localeCompare(String(b.entryId ?? '')));
  return { ok: missing.length === 0 && duplicateDecisions.length === 0 && unknownEntries.length === 0, missing, duplicateDecisions, unknownEntries };
}
