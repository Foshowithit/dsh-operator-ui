// lib/sync.js — FlowRouter S0: exact-scope custody backfill (spec ccf0387).
//
// One question: can a destination backfill an explicit finite set of exact
// FlowRouter objects from one configured source by independently applying the
// already-sealed custody rules to each item — while sync scheduling,
// repetition, interruption, bookkeeping, source availability and source
// omission grant no authority over freshness, completeness, publisher
// identity, consumer trust, admission or routing?
//
// FROZEN BOUNDARIES IMPLEMENTED HERE:
// - S0 is a LOCAL COORDINATOR, not a protocol: it has no /sync surface, no
//   persistent network API, and it REUSES the sealed operations rather than
//   reimplementing them — publications go through the destination's ordinary
//   R0 replication transaction, content through the sealed content-only
//   custody path, evidence through the F1 evidence path (which never ingests);
// - it reconciles an EXPLICIT FINITE LOCAL SCOPE of exact object intents. It
//   never enumerates source state, never discovers versions, and never accepts
//   "latest"/"all"/"everything" selectors;
// - scope records are STRICT: unknown fields or selectors reject rather than
//   being silently ignored, and a publication intent may not carry a D, a
//   range, a wildcard, a tag or an inventory predicate;
// - additive custody only: source absence NEVER deletes anything, and a run is
//   never batch-atomic — committed objects stay committed;
// - the journal is LOCAL bookkeeping. It records only what a local action
//   observed, never freshness, completeness, recency, ranking or consensus,
//   and it is never an input to pinning, quarantine, admission, routing,
//   discovery ordering, F0 validity or repository authenticity.

import { createHash } from 'node:crypto';
import { writeFile, appendFile } from 'node:fs/promises';
import { canonicalOrigin } from './directory.js';
import { proofDigest, verifyProofCore } from './equivocation.js';

const HEX64 = /^[a-f0-9]{64}$/;
const CANON_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CANON_VERSION = /^\d+\.\d+\.\d+$/;

const sha256hex = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
export const objectKey = (intent) => {
  if (intent.kind === 'publication') return ['pub', intent.publisher_scheme, intent.publisher_id, intent.name, intent.version].join('|');
  if (intent.kind === 'blob') return 'blob|' + intent.D;
  if (intent.kind === 'proof') return 'proof|' + intent.proof_digest;
  return 'invalid';
};

// STRICT intent validation: exactly one shape per object class, no extra fields.
export function validateIntent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'intent must be an object' };
  const keys = Object.keys(raw).sort().join(',');
  if (keys === 'name,publisher_id,publisher_scheme,version') { // Object.keys(...).sort() order
    if (raw.publisher_scheme !== 'p2-selfcert-v1') return { error: 'only p2-selfcert-v1 publications are backfillable' };
    if (!HEX64.test(String(raw.publisher_id || ''))) return { error: 'publisher_id must be 64-hex' };
    if (typeof raw.name !== 'string' || !CANON_NAME.test(raw.name)) return { error: 'name must be canonical' };
    if (typeof raw.version !== 'string' || !CANON_VERSION.test(raw.version)) return { error: 'version must be canonical x.y.z' };
    return { intent: { kind: 'publication', publisher_scheme: 'p2-selfcert-v1', publisher_id: raw.publisher_id, name: raw.name, version: raw.version } };
  }
  if (keys === 'D') {
    if (!HEX64.test(String(raw.D || ''))) return { error: 'D must be 64-hex' };
    return { intent: { kind: 'blob', D: raw.D } };
  }
  if (keys === 'proof_digest') {
    if (!HEX64.test(String(raw.proof_digest || ''))) return { error: 'proof_digest must be 64-hex' };
    return { intent: { kind: 'proof', proof_digest: raw.proof_digest } };
  }
  return { error: `unknown scope record fields "${keys}" — a publication intent carries exactly publisher_scheme, publisher_id, name, version; a blob intent exactly D; a proof intent exactly proof_digest (no D, latest, ranges, wildcards, tags or inventory predicates)` };
}

export function normalizeScope(scope) {
  const publications = (scope && scope.publications) || [];
  const blobs = (scope && scope.blobs) || [];
  const proofs = (scope && scope.proofs) || [];
  const raws = [...publications, ...blobs, ...proofs];
  const intents = [];
  const rejected = [];
  for (const r of raws) {
    // the RAW record is validated exactly as supplied: a strict contract must
    // never quietly strip a field (a D on a publication intent, a "latest"
    // selector, a tag) and then accept the remainder
    const v = validateIntent(r);
    if (v.error) { rejected.push({ record: r, error: v.error }); continue; }
    intents.push(v.intent);
  }
  const byKey = new Map();
  for (const i of intents) byKey.set(objectKey(i), i); // exact duplicates collapse
  const ordered = [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, i]) => i); // determinism only
  return { intents: ordered, rejected, duplicates_collapsed: intents.length - ordered.length };
}

const post = async (base, path, body, timeoutMs = 60000) => {
  try {
    const res = await fetch(base.replace(/\/$/, '') + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text(); let parsed = {}; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: parsed };
  } catch (e) { return { status: 0, body: { error: String(e.message).slice(0, 140) } }; }
};

// One publication intent → the destination's ORDINARY R0 transaction.
async function backfillPublication({ destination, source, intent }) {
  const out = await post(destination, '/replicate', { source_endpoint: source, scheme: intent.publisher_scheme, publisher_id: intent.publisher_id, name: intent.name, version: intent.version });
  if (out.status === 200 && out.body.replicated && out.body.idempotent) return { outcome: 'ALREADY_PRESENT', observed_D: out.body.D, detail: out.body };
  if (out.status === 200 && out.body.replicated) return { outcome: 'COPIED', observed_D: out.body.D, detail: { requested_D: out.body.requested_D, recomputed_D: out.body.recomputed_D } };
  const code = out.body.error || out.body.error_code || 'REPLICATION_REFUSED';
  const unreachable = out.status === 0 || /SOURCE_UNAVAILABLE|SOURCE_ABSENT|SOURCE_UNREACHABLE/.test(String(code));
  return { outcome: unreachable ? 'UNAVAILABLE' : 'REFUSED', error_code: code, detail: out.body };
}

// One content intent → the sealed content-only custody path (no binding).
async function backfillBlob({ destination, source, intent }) {
  const out = await post(destination, '/cache-blob', { source_endpoint: source, D: intent.D });
  if (out.status === 200 && out.body.cached) return { outcome: 'COPIED', observed_D: out.body.D, detail: { binding_created: false } };
  const code = out.body.error || 'CONTENT_REFUSED';
  return { outcome: out.status === 0 || /SOURCE_UNAVAILABLE|SOURCE_ABSENT/.test(String(code)) ? 'UNAVAILABLE' : 'REFUSED', error_code: code, detail: out.body };
}

// One evidence intent → fetched from the source, RE-verified locally against
// the requested digest, stored at the destination as bytes. Never ingested.
async function backfillProof({ destination, source, intent }) {
  let wire;
  try {
    const res = await fetch(source.replace(/\/$/, '') + '/evidence/' + intent.proof_digest, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { outcome: 'UNAVAILABLE', error_code: 'EVIDENCE_UNAVAILABLE', detail: { source_status: res.status } };
    wire = Buffer.from(await res.arrayBuffer());
  } catch (e) { return { outcome: 'UNAVAILABLE', error_code: 'SOURCE_UNREACHABLE', detail: { error: String(e.message).slice(0, 120) } }; }
  let core;
  try { core = JSON.parse(wire.toString('utf8')); } catch { return { outcome: 'REFUSED', error_code: 'EVIDENCE_MALFORMED' }; }
  const digest = proofDigest(core);
  if (digest !== intent.proof_digest) return { outcome: 'REFUSED', error_code: 'EVIDENCE_DIGEST_MISMATCH', detail: { recomputed: digest } };
  // A matching digest only proves the BYTES are the requested bytes — it says
  // nothing about whether they are valid evidence. The sealed F1 verifier must
  // accept the core HERE, at the destination, before any custody is committed:
  // the destination's evidence path is a deliberately dumb carrier and
  // verifies nothing.
  let verdict;
  try { verdict = verifyProofCore(core); } catch (e) {
    return { outcome: 'REFUSED', error_code: 'EVIDENCE_INVALID', detail: { reason: String(e.message).slice(0, 160) } };
  }
  if (verdict.proof_digest !== intent.proof_digest) return { outcome: 'REFUSED', error_code: 'EVIDENCE_DIGEST_MISMATCH', detail: { verified: verdict.proof_digest } };
  const stored = await post(destination, '/evidence', { proof_digest: intent.proof_digest, proof_core: core });
  if (stored.status === 200 && stored.body.stored) return { outcome: 'COPIED', observed_D: intent.proof_digest, detail: { ingested: false } };
  if (stored.status === 409) return { outcome: 'ALREADY_PRESENT', observed_D: intent.proof_digest, detail: stored.body };
  return { outcome: stored.status === 0 ? 'UNAVAILABLE' : 'REFUSED', error_code: stored.body.error || 'EVIDENCE_STORE_REFUSED', detail: stored.body };
}

// The local coordinator. One source endpoint, one destination, one explicit
// scope. No discovery, no enumeration, no batch trust.
export async function syncExact({ source_endpoint, destination, explicit_scope, journal_path, run_id }) {
  const source = canonicalOrigin(source_endpoint);
  const dest = canonicalOrigin(destination);
  if (!source) throw Object.assign(new Error('source_endpoint must be an absolute http(s) origin'), { code: 'S0_SOURCE_INVALID' });
  if (!dest) throw Object.assign(new Error('destination must be an absolute http(s) origin'), { code: 'S0_DESTINATION_INVALID' });
  const { intents, rejected, duplicates_collapsed } = normalizeScope(explicit_scope || {});
  const rid = run_id || 'run-' + sha256hex(new Date().toISOString() + Math.random()).slice(0, 12);
  const results = [];
  for (const intent of intents) {
    const started = new Date().toISOString();
    let r;
    if (intent.kind === 'publication') r = await backfillPublication({ destination: dest, source, intent });
    else if (intent.kind === 'blob') r = await backfillBlob({ destination: dest, source, intent });
    else r = await backfillProof({ destination: dest, source, intent });
    results.push({
      run_id: rid, source_endpoint: source, requested_object_key: objectKey(intent), object_class: intent.kind,
      intent, attempted_at: started, outcome: r.outcome, observed_D: r.observed_D || null, error_code: r.error_code || null, detail: r.detail || null,
    });
  }
  const run = {
    run_id: rid, source_endpoint: source, destination: dest,
    requested: intents.map(objectKey), rejected_scope_records: rejected, duplicates_collapsed,
    results,
    summary: results.reduce((m, r) => { m[r.outcome] = (m[r.outcome] || 0) + 1; return m; }, {}),
    // facts about THIS run's explicit scope only — never freshness/completeness
    scope_complete: results.length > 0 && results.every((r) => r.outcome === 'COPIED' || r.outcome === 'ALREADY_PRESENT'),
    scope_size: results.length,
  };
  if (journal_path) {
    try {
      await writeFile(journal_path, '', { flag: 'a' });
      for (const r of results) await appendFile(journal_path, JSON.stringify({ ...r, detail: undefined }) + '\n', 'utf8');
    } catch { /* a journal failure never changes custody outcomes */ }
  }
  return run;
}
