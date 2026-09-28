// lib/plugin-discovery.js — display-only third-party discovery projection (K3).
//
// Projects B1a ExternalPluginListing metadata into bounded inert records.
// First slice: metadata ONLY. It neither accepts nor joins host observations
// or canonical links, and no entry enters projectCapabilityView. A directory
// listing never becomes execution authority.

export const DISCOVERY_SCHEMA = 'operator-plugin-discovery/1';
export const LIMITS = {
  maxListings: 100,
  maxText: 300,
  maxErrors: 100,
  allowedProtocols: ['https:'],
};

// Listing fields the projector reads. Anything else on the row (verified,
// eligible, readiness, installed, workflow, binding, canonical ids) is a
// forged flag: stripped and reported, never projected.
const READ_FIELDS = [
  'source', 'sourceKey', 'sourceDigest', 'fetchedAt', 'sourceAsOf',
  'publisher', 'name', 'description', 'category', 'repositoryUrl',
  'listingUrl', 'packageSpec', 'declaredDshRange',
];
const FORGED_FIELDS = [
  'verified', 'eligible', 'readiness', 'installed', 'executable',
  'workflow', 'binding', 'authority', 'observation', 'canonicalId',
  'capabilityId', 'promotion', 'approved',
];

function truncate(value) {
  return typeof value === 'string' ? value.trim().slice(0, LIMITS.maxText) : value;
}

function error(errors, code, message, extra = {}) {
  if (errors.length < LIMITS.maxErrors) {
    errors.push({ code, message: String(message).slice(0, LIMITS.maxText), ...extra });
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

function cleanUrl(value, errors, entryId) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    error(errors, 'bad-url', 'URL is not a string', { entryId });
    return null;
  }
  try {
    const u = new URL(value.trim());
    if (!LIMITS.allowedProtocols.includes(u.protocol)) {
      error(errors, 'bad-url', `URL protocol ${u.protocol} is not linkable`, { entryId });
      return null;
    }
    return value.trim().slice(0, LIMITS.maxText);
  } catch {
    error(errors, 'bad-url', 'URL does not parse', { entryId });
    return null;
  }
}

function cleanRange(value, errors, entryId) {
  if (value === null || value === undefined) return { state: 'unknown' };
  if (typeof value !== 'object' || Array.isArray(value)) {
    error(errors, 'bad-range', 'declared range is not an object', { entryId });
    return { state: 'unknown' };
  }
  const declared = typeof value.value === 'string' ? value.value.trim().slice(0, LIMITS.maxText) : '';
  const evidenceUrl = typeof value.evidenceUrl === 'string' ? value.evidenceUrl.trim() : '';
  if (!declared) return { state: 'unknown' };
  try {
    const u = new URL(evidenceUrl);
    if (!LIMITS.allowedProtocols.includes(u.protocol)) throw new Error('protocol');
  } catch {
    error(errors, 'range-without-evidence', 'declared range without linkable publisher evidence stays unknown', { entryId });
    return { state: 'unknown' };
  }
  return { state: 'declared', value: declared, evidenceUrl: evidenceUrl.slice(0, LIMITS.maxText) };
}

export function projectPluginDiscovery(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || hasAccessor(input)) {
    return { schema: DISCOVERY_SCHEMA, entries: [], errors: [{ code: 'malformed-input', message: 'input is not plain data' }] };
  }
  const listings = Array.isArray(input.listings) ? input.listings : null;
  if (!listings) {
    error(errors, 'malformed-input', 'listings must be an array');
    return { schema: DISCOVERY_SCHEMA, entries: [], errors };
  }
  const batch = listings.slice(0, LIMITS.maxListings);
  if (listings.length > LIMITS.maxListings) {
    error(errors, 'batch-capped', `capped at ${LIMITS.maxListings} rows; ${listings.length} supplied`, { processed: LIMITS.maxListings, supplied: listings.length });
  }
  const entries = [];
  const seen = new Set();
  batch.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || hasAccessor(raw)) {
      error(errors, 'malformed-row', 'row is not plain data', { entryId: `row-${index}` });
      return;
    }
    const source = typeof raw.source === 'string' ? raw.source.trim().slice(0, LIMITS.maxText) : 'unknown-source';
    const key = typeof raw.sourceKey === 'string' && raw.sourceKey.trim() ? raw.sourceKey.trim().slice(0, LIMITS.maxText) : `row-${index}`;
    const entryId = `${source}:${key}`;
    if (seen.has(entryId)) {
      error(errors, 'duplicate-id', 'repeated listing id; first row kept', { entryId });
      return;
    }
    seen.add(entryId);
    for (const field of FORGED_FIELDS) {
      if (raw[field] !== undefined) {
        error(errors, 'forged-flags', `row carries ${field}; stripped`, { entryId });
        break;
      }
    }
    const description = typeof raw.description === 'string' ? raw.description : null;
    if (typeof raw.description === 'string' && raw.description.length > LIMITS.maxText) {
      error(errors, 'truncated', 'description exceeds maxText; capped', { entryId });
    }
    const entry = {
      entryId,
      source,
      sourceKey: typeof raw.sourceKey === 'string' ? raw.sourceKey.trim().slice(0, LIMITS.maxText) : null,
      sourceDigest: typeof raw.sourceDigest === 'string' ? raw.sourceDigest.trim().slice(0, LIMITS.maxText) : null,
      fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt.trim().slice(0, LIMITS.maxText) : null,
      sourceAsOf: typeof raw.sourceAsOf === 'string' ? raw.sourceAsOf.trim().slice(0, LIMITS.maxText) : null,
      publisher: typeof raw.publisher === 'string' ? raw.publisher.trim().slice(0, LIMITS.maxText) : null,
      name: typeof raw.name === 'string' ? raw.name.trim().slice(0, LIMITS.maxText) : null,
      description: description === null ? null : truncate(description),
      category: typeof raw.category === 'string' ? raw.category.trim().slice(0, LIMITS.maxText) : null,
      repositoryUrl: cleanUrl(raw.repositoryUrl, errors, entryId),
      listingUrl: cleanUrl(raw.listingUrl, errors, entryId),
      packageSpec: typeof raw.packageSpec === 'string' ? raw.packageSpec.trim().slice(0, LIMITS.maxText) : null,
      declaredCompatibility: cleanRange(raw.declaredDshRange, errors, entryId),
      // Timestamps are preserved verbatim. There is no freshness threshold
      // and no active state: currency is always unknown at this slice.
      verifiedCurrent: 'unknown',
    };
    entries.push(entry);
  });
  entries.sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
  return { schema: DISCOVERY_SCHEMA, entries, errors };
}
