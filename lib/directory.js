// lib/directory.js — FlowRouter D1: untrusted endpoint directory (spec ac80256).
//
// One question: given a canonical capability name and ONE configured directory
// endpoint, can a consumer learn repository endpoint candidates worth asking,
// without membership, multiplicity, ordering, availability or operator
// behavior acquiring any trust authority?
//
// FROZEN BOUNDARIES IMPLEMENTED HERE:
// - the entry schema is EXACTLY { endpoint }: D1 transports LOCATORS, never
//   capability claims, and a directory suggestion is not a repository identity;
// - endpoint identity is a locator identity: canonical_origin(endpoint), with
//   http/https only, no credentials/query/fragment, empty-or-root path, host
//   normalization, default ports collapsed and a terminal DNS root dot removed.
//   http and https stay distinct; DNS is NEVER consulted for deduplication;
// - D1 does NOT dereference the candidates it returns: selection is the
//   caller's act. From D0 onward a directory-learned endpoint is
//   indistinguishable from a manually typed one;
// - MAX_D1_ENDPOINTS = 256, applied AFTER canonicalization and deduplication:
//   invalid locators and duplicate spellings consume ZERO candidate slots;
// - entries carry NO time or availability vocabulary of any kind;
// - discovery is READ-ONLY observation: nothing here writes pins, task
//   evidence, quarantine, the registry, admission, routing or replication
//   state, and the queried name reuses the already-sealed capability-name
//   grammar rather than defining a neighboring one.

import { createHash } from 'node:crypto';

export const MAX_D1_ENDPOINTS = 256;
// the ALREADY-SEALED capability-name grammar (identical to the repository's)
const CANON_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

const sha256hex = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
export const endpointListDigest = (endpoints) => sha256hex(endpoints.join('\n'));

// Canonical locator origin, or null when the locator is not a usable http(s)
// repository origin. No DNS resolution happens here or anywhere in this module.
export function canonicalOrigin(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  if (u.username || u.password) return null;
  if (u.search || u.hash) return null;
  if (!(u.pathname === '' || u.pathname === '/')) return null;
  let host = u.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1); // DNS root dot: example.com. === example.com
  if (!host) return null;
  const h = host.includes(':') ? '[' + host + ']' : host; // IPv6 literals keep their brackets
  return `${u.protocol}//${h}${u.port ? ':' + u.port : ''}`; // URL already drops default ports
}

function validEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'entry is not an object';
  if (Object.keys(e).sort().join(',') !== 'endpoint') return 'an entry carries exactly the field "endpoint"';
  if (typeof e.endpoint !== 'string') return 'endpoint must be a string';
  return null;
}

// Normalize UNTRUSTED directory entries into the frozen endpoint candidate set.
// Invalid locators and duplicate spellings consume zero of the 256 slots.
export function normalizeEndpointEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let rejected = 0;
  let invalidLocator = 0;
  const rejectedReasons = {};
  const byOrigin = new Map();
  for (const e of list) {
    const why = validEntry(e);
    if (why) { rejected++; rejectedReasons[why] = (rejectedReasons[why] || 0) + 1; continue; }
    const origin = canonicalOrigin(e.endpoint);
    if (!origin) { invalidLocator++; continue; }
    byOrigin.set(origin, (byOrigin.get(origin) || 0) + 1);
  }
  const unique = [...byOrigin.keys()].sort(); // bytewise canonical sort — serialization only
  const total_unique = unique.length;
  const endpoints = unique.slice(0, MAX_D1_ENDPOINTS);
  return {
    endpoints,
    truncated: total_unique > MAX_D1_ENDPOINTS,
    diagnostics: {
      entries_seen: list.length,
      rejected,
      rejected_reasons: rejectedReasons,
      invalid_locators: invalidLocator,
      duplicates_collapsed: [...byOrigin.values()].reduce((n, c) => n + (c - 1), 0),
      total_unique,
    },
  };
}

// Query ONE configured directory for one exact canonical capability name. The
// response is untrusted input; D1 makes no network call to any returned
// endpoint — that is the caller's explicit act.
export async function queryDirectory({ directory, name, timeoutMs = 10000 }) {
  if (typeof name !== 'string' || !CANON_NAME.test(name)) throw Object.assign(new Error('an exact canonical capability name is required'), { code: 'D1_NAME_NONCANONICAL' });
  const base = String(directory).replace(/\/$/, '');
  const res = await fetch(base + '/endpoints?name=' + encodeURIComponent(name), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw Object.assign(new Error('directory answered HTTP ' + res.status), { code: 'D1_DIRECTORY_UNAVAILABLE' });
  const body = await res.json();
  return { directory, entries: Array.isArray(body.entries) ? body.entries : [], order_semantics: body.order_semantics || null };
}

// The consumer-facing step: name + directory → normalized endpoint candidates
// with discovery provenance. Selecting an endpoint is the caller's act; D1
// neither selects nor contacts anything.
export async function discoverEndpoints({ directory, name, timeoutMs }) {
  const raw = await queryDirectory({ directory, name, timeoutMs });
  const norm = normalizeEndpointEntries(raw.entries);
  return { ...norm, learned_from_directory: raw.directory, order_semantics: raw.order_semantics };
}
