// lib/discovery.js — FlowRouter D0: untrusted repository possession index
// (spec d0e935d).
//
// One question: given a repository endpoint and only a canonical capability
// name, can a consumer learn exact P2 tuple candidates that the endpoint
// claims to possess, WITHOUT granting that index any trust authority?
//
// FROZEN BOUNDARIES IMPLEMENTED HERE:
// - an entry is the minimal claim (publisher_scheme, publisher_id, name,
//   version, claimed_D); the endpoint is observation provenance, never a
//   repository identity;
// - claimed_D IS NOT TRUSTED INPUT and does not participate in candidate
//   identity, deduplication, ordering, the candidate bound, peer multiplicity,
//   downstream selection or trust weighting. T/D1 and T/D2 normalize to ONE
//   candidate T;
// - candidate identity is the exact P2 tuple:
//   (publisher_scheme, publisher_id, name, version);
// - MAX_D0_CANDIDATES = 256, applied AFTER deterministic normalization:
//   validate → normalize to tuple keys → dedupe by tuple key → canonical
//   bytewise sort → retain 256 → truncated = unique > 256. The sort carries no
//   preference semantics; it exists solely so truncation is independent of
//   attacker-supplied ordering;
// - discovery is READ-ONLY: nothing here writes pins, task evidence,
//   quarantine, the registry, admission, routing or replication state, and no
//   version is ever selected.

import { createHash } from 'node:crypto';

export const MAX_D0_CANDIDATES = 256;
const HEX64 = /^[a-f0-9]{64}$/;
const CANON_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/;
const CANON_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;

const sha256hex = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
export const candidateKey = (c) => [c.publisher_scheme, c.publisher_id, c.name, c.version].join('|');
export const candidateDigest = (candidates) => sha256hex(candidates.map(candidateKey).join('\n'));

// A candidate is exactly the tuple — claimed_D is deliberately absent.
function validEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'entry is not an object';
  if (Object.keys(e).sort().join(',') !== 'claimed_D,name,publisher_id,publisher_scheme,version') return 'entry fields must be exactly publisher_scheme, publisher_id, name, version, claimed_D';
  if (e.publisher_scheme !== 'p2-selfcert-v1') return 'only P2 publication bindings are indexable';
  if (!HEX64.test(String(e.publisher_id || ''))) return 'publisher_id must be 64-hex';
  if (typeof e.name !== 'string' || !CANON_NAME.test(e.name)) return 'name must be canonical';
  if (typeof e.version !== 'string' || !CANON_VERSION.test(e.version)) return 'version must be canonical';
  if (!HEX64.test(String(e.claimed_D || ''))) return 'claimed_D must be 64-hex';
  return null;
}

// Normalize UNTRUSTED index entries into the frozen candidate set.
// Returns candidates (tuple-only), truncation state, and non-authoritative
// diagnostics (including contradictory D claims) for the receipt.
export function normalizeCandidateEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const byKey = new Map();
  let rejected = 0;
  const rejectedReasons = {};
  for (const e of list) {
    const why = validEntry(e);
    if (why) { rejected++; rejectedReasons[why] = (rejectedReasons[why] || 0) + 1; continue; }
    const key = candidateKey(e);
    const seen = byKey.get(key) || { publisher_scheme: e.publisher_scheme, publisher_id: e.publisher_id, name: e.name, version: e.version, claimed_D_values: new Set(), observations: 0 };
    seen.claimed_D_values.add(e.claimed_D);
    seen.observations += 1;
    byKey.set(key, seen);
  }
  const unique = [...byKey.values()].map((c) => ({
    publisher_scheme: c.publisher_scheme,
    publisher_id: c.publisher_id,
    name: c.name,
    version: c.version,
    claimed_D_values: [...c.claimed_D_values].sort(),
    observations: c.observations,
  }));
  // canonical bytewise order — serialization only, no preference
  unique.sort((a, b) => (a.publisher_scheme < b.publisher_scheme ? -1 : a.publisher_scheme > b.publisher_scheme ? 1
    : a.publisher_id < b.publisher_id ? -1 : a.publisher_id > b.publisher_id ? 1
    : a.name < b.name ? -1 : a.name > b.name ? 1
    : a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  const total_unique = unique.length;
  const candidates = unique.slice(0, MAX_D0_CANDIDATES).map((c) => ({
    publisher_scheme: c.publisher_scheme, publisher_id: c.publisher_id, name: c.name, version: c.version,
  }));
  const diagnostics = {
    entries_seen: list.length,
    rejected,
    rejected_reasons: rejectedReasons,
    total_unique,
    contradictory_d_claims: unique.filter((c) => c.claimed_D_values.length > 1).map((c) => ({ key: candidateKey(c), claimed_D_values: c.claimed_D_values.length })),
    duplicate_observations: unique.reduce((n, c) => n + (c.observations - 1), 0),
  };
  return { candidates, truncated: total_unique > MAX_D0_CANDIDATES, diagnostics };
}

// Query ONE endpoint's possession index for one exact canonical name. The
// response is untrusted input; nothing is verified here and nothing is written.
export async function queryPossessionIndex({ endpoint, name, timeoutMs = 10000 }) {
  const base = String(endpoint).replace(/\/$/, '');
  const res = await fetch(base + '/possession?name=' + encodeURIComponent(String(name)), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw Object.assign(new Error('index answered HTTP ' + res.status), { code: 'D0_INDEX_UNAVAILABLE' });
  const body = await res.json();
  return { endpoint, entries: Array.isArray(body.entries) ? body.entries : [], order_semantics: body.order_semantics || null };
}

// The consumer-facing step: name + endpoint → normalized candidate set with
// discovery provenance. Selecting ONE exact tuple is the caller's act; nothing
// here chooses a version or contacts any publication endpoint.
export async function discoverCandidates({ endpoint, name, timeoutMs }) {
  const raw = await queryPossessionIndex({ endpoint, name, timeoutMs });
  const norm = normalizeCandidateEntries(raw.entries);
  return { ...norm, learned_from_index: raw.endpoint, order_semantics: raw.order_semantics };
}
