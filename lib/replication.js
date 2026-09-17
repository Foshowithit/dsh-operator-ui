// lib/replication.js — FlowRouter R0: authenticated mirror replication
// (spec 43ca378).
//
// One question: can a repository persistently mirror an authenticated P2
// publication from another repository, without ever becoming the publisher,
// without inheriting trust from the source repository, and without changing
// any consumer-local trust state?
//
// FROZEN BOUNDARIES IMPLEMENTED HERE:
// - exactly three transportable objects: content (P0 bytes by D), the P2
//   publication object (exact tuple → D plus genesis + events + assertion),
//   and optionally an F1 proof_core (by proof_digest). No separate
//   identity-chain replication, and consumer-local trust state never travels;
// - P1 bindings are NOT replication-capable (their origin component is
//   consumer-local by construction); raw P0 blobs may still be cached by D;
// - pull only, permissionless at the trust layer: the source gets zero
//   authority, and a mirror NEVER re-attests — it stores and re-serves the
//   ORIGINAL publisher's material, and its custody metadata is local and
//   non-authoritative;
// - the destination independently verifies: the material must bind the exact
//   requested tuple → D, the artifact bytes are fetched by that D and the P0
//   digest is RECOMPUTED, requiring recomputed_D == signed_D == requested_D;
// - commit order: blob first, binding second;
// - idempotent for byte-identical material; every other case fails closed with
//   the existing object left untouched — a different D, or different material
//   for the same tuple+D. The latter is IMMUTABILITY, never an equivocation
//   finding: replication is not a history adjudicator;
// - no version fallback, ever.

import { createHash } from 'node:crypto';
import { verifyGenesis, replayChain, verifyPublication, jcs } from './identity.js';

export const R0 = {
  SOURCE_ABSENT: 'REPLICATION_SOURCE_ABSENT',
  SOURCE_UNAVAILABLE: 'REPLICATION_SOURCE_UNAVAILABLE',
  SOURCE_MALFORMED: 'REPLICATION_SOURCE_MALFORMED',
  P1_NOT_FEDERATABLE: 'REPLICATION_P1_NOT_FEDERATABLE',
  TUPLE_MISMATCH: 'REPLICATION_TUPLE_MISMATCH',
  MATERIAL_INVALID: 'REPLICATION_MATERIAL_INVALID',
  BYTES_SUBSTITUTED: 'REPLICATION_BYTES_SUBSTITUTED',
  CONFLICT_D: 'REPLICATION_D_CONFLICT',
  MATERIAL_CONFLICT: 'REPLICATION_MATERIAL_CONFLICT',
  INVALID_REQUEST: 'REPLICATION_INVALID_REQUEST',
};

export function r0err(code, detail) { const e = new Error(detail ? `${code}: ${detail}` : code); e.code = code; return e; }
const sha256hex = (b) => createHash('sha256').update(b).digest('hex');

// ---- frozen P0 digest rule (identical to lib/flowrouter.js) ----
// NOTE: returns canonical JSON TEXT (the frozen rule hashes bytes, and the
// digest must match the producer's byte-for-byte).
function canonicalJson(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}
export function packageDigestOf(files) {
  const cap = files.find((f) => f.path === 'capability.json');
  if (!cap) throw r0err(R0.SOURCE_MALFORMED, 'artifact carries no capability.json');
  const m = JSON.parse(cap.bytes.toString('utf8'));
  const bundle = (m.implementation && m.implementation.bundle) || {};
  const capNo = Buffer.from(canonicalJson({ ...m, implementation: { ...(m.implementation || {}), bundle: { algorithm: bundle.algorithm || 'sha256' } } }), 'utf8');
  const list = files.map((f) => (f.path === 'capability.json' ? { path: f.path, bytes: capNo } : f))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\n${f.bytes.length}\n${sha256hex(f.bytes)}\n`).join('');
  return sha256hex(Buffer.from(list, 'utf8'));
}
export const artifactFilesFromWire = (wireBytes) => {
  const obj = JSON.parse(wireBytes.toString('utf8'));
  if (!Array.isArray(obj.files) || obj.files.length === 0) throw r0err(R0.SOURCE_MALFORMED, 'artifact carries no files');
  return obj.files.map((f) => ({ path: f.path, bytes: Buffer.from(f.b64, 'base64') }));
};

// Material identity: the bytes of the authenticated publication object. Two
// materials are the SAME object iff their canonical forms are identical.
export const materialDigest = (material) => sha256hex(Buffer.from(jcs({
  genesis: material.genesis, events: material.events || [], publication: material.publication,
}), 'utf8'));

// Independent verification at the DESTINATION: the source's own verdicts are
// never inputs. Returns the exact requested tuple → D when the material is
// genuinely authenticated.
export function verifySourcePublication({ record, tuple }) {
  if (!record || typeof record !== 'object') throw r0err(R0.SOURCE_MALFORMED, 'no publication record');
  const scheme = record.publisher_scheme || 'p1-configured-v1';
  if (scheme === 'p1-configured-v1') throw r0err(R0.P1_NOT_FEDERATABLE, 'a P1 publication binding is origin-scoped and does not federate in R0');
  if (scheme !== 'p2-selfcert-v1') throw r0err(R0.SOURCE_MALFORMED, `unknown scheme "${String(scheme).slice(0, 32)}"`);
  if (record.publisher_id !== tuple.publisher_id || record.name !== tuple.name || record.version !== tuple.version) {
    throw r0err(R0.TUPLE_MISMATCH, 'source record does not carry the exact requested tuple');
  }
  const material = record.material;
  if (!material || !material.genesis || !Array.isArray(material.events) || !material.publication) {
    throw r0err(R0.MATERIAL_INVALID, 'source supplied no complete P2 verification material');
  }
  const assertion = material.publication;
  let g, chain, vp;
  try {
    g = verifyGenesis(material.genesis);
    chain = replayChain(material.genesis, material.events);
    vp = verifyPublication(assertion, chain);
  } catch (e) {
    throw r0err(R0.MATERIAL_INVALID, String(e.message).slice(0, 140));
  }
  // the material must bind the EXACT requested tuple and the D it advertises
  const checks = [
    [assertion.publisher_scheme, 'p2-selfcert-v1', 'assertion scheme'],
    [assertion.publisher_id, tuple.publisher_id, 'assertion publisher_id'],
    [g.publisher_id, tuple.publisher_id, 'verified genesis publisher_id'],
    [vp.publisher_id, tuple.publisher_id, 'verified assertion publisher'],
    [assertion.name, tuple.name, 'assertion name'],
    [assertion.version, tuple.version, 'assertion version'],
    [assertion.D, record.D, 'assertion D vs the served D'],
  ];
  for (const [actual, expected, what] of checks) {
    if (actual !== expected) throw r0err(R0.TUPLE_MISMATCH, `${what}: ${String(actual).slice(0, 24)} !== ${String(expected).slice(0, 24)}`);
  }
  return { D: assertion.D, material, material_digest: materialDigest(material), publisher_id: g.publisher_id, head_sequence: chain.head_sequence };
}

// The destination's commit decision. Pure: given what it already holds and
// what the source offered, decide. Never adjudicates histories.
export function replicationDecision({ existing, incoming }) {
  if (!existing) return { action: 'commit' };
  if (existing.D !== incoming.D) {
    return { action: 'refuse', code: R0.CONFLICT_D, reason: 'this repository already holds the same P2 tuple at a different D — existing binding unchanged (never overwritten, never majority-resolved)' };
  }
  if (existing.material_digest === incoming.material_digest) return { action: 'idempotent' };
  return {
    action: 'refuse',
    code: R0.MATERIAL_CONFLICT,
    reason: 'the same tuple+D is already held with different authenticated material — the stored object is immutable (this is a storage rule, not an equivocation finding: the difference may be an assertion reissue, a compatible extension, or a fork, and ordinary P2/F0/F1 semantics decide what it means when observed)',
  };
}

// ---- source client (pull only) ----
export async function fetchSourcePublication({ endpoint, tuple, timeoutMs = 10000 }) {
  const base = String(endpoint).replace(/\/$/, '');
  const url = base + '/publication/' + encodeURIComponent(tuple.publisher_id) + '/' + encodeURIComponent(tuple.name) + '/' + encodeURIComponent(tuple.version) + '?scheme=p2-selfcert-v1';
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }); } catch (e) { throw r0err(R0.SOURCE_UNAVAILABLE, String(e.message).slice(0, 120)); }
  if (res.status === 404) throw r0err(R0.SOURCE_ABSENT, 'the source does not carry this exact tuple (no version fallback exists in R0)');
  if (!res.ok) throw r0err(R0.SOURCE_UNAVAILABLE, 'source answered HTTP ' + res.status);
  try { return await res.json(); } catch { throw r0err(R0.SOURCE_MALFORMED, 'source returned an unparseable publication record'); }
}

export async function fetchSourceBytes({ endpoint, D, timeoutMs = 20000 }) {
  const base = String(endpoint).replace(/\/$/, '');
  let res;
  try { res = await fetch(base + '/fetch/' + D, { signal: AbortSignal.timeout(timeoutMs) }); } catch (e) { throw r0err(R0.SOURCE_UNAVAILABLE, String(e.message).slice(0, 120)); }
  if (!res.ok) throw r0err(R0.SOURCE_UNAVAILABLE, 'source served no artifact for this D (HTTP ' + res.status + ')');
  return Buffer.from(await res.arrayBuffer());
}

// The frozen transaction, minus storage (the caller commits blob then binding).
// requested_D = the D obtained from — and authenticated by — the exact tuple
// lookup, then used as the exact-D fetch target.
export async function planReplication({ source_endpoint, tuple, lookupExisting, existingMaterialDigest, timeoutMs }) {
  const record = await fetchSourcePublication({ endpoint: source_endpoint, tuple, timeoutMs });
  const verified = verifySourcePublication({ record, tuple }); // throws on P1 / mismatch / invalid material
  const requested_D = verified.D;
  const wire = await fetchSourceBytes({ endpoint: source_endpoint, D: requested_D, timeoutMs });
  let recomputed_D;
  try { recomputed_D = packageDigestOf(artifactFilesFromWire(wire)); } catch (e) {
    throw r0err(R0.SOURCE_MALFORMED, String(e.message).slice(0, 140));
  }
  if (recomputed_D !== verified.D) {
    throw r0err(R0.BYTES_SUBSTITUTED, `the source advertised D ${verified.D.slice(0, 16)}… but the bytes it served recompute to ${recomputed_D.slice(0, 16)}… — no binding is committed and no substitution is performed`);
  }
  const existing = lookupExisting ? await lookupExisting() : null;
  const decision = replicationDecision({
    existing: existing ? { D: existing.D, material_digest: existingMaterialDigest } : null,
    incoming: { D: verified.D, material_digest: verified.material_digest },
  });
  return {
    ok: decision.action !== 'refuse',
    action: decision.action,
    code: decision.code || null,
    reason: decision.reason || null,
    tuple,
    requested_D: verified.D,
    recomputed_D,
    material: verified.material,
    material_digest: verified.material_digest,
    wire_bytes: wire,
    publisher: { publisher_id: verified.publisher_id, head_sequence: verified.head_sequence },
  };
}
