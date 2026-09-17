// lib/federation.js — FlowRouter Federation F0 (implementation against the
// frozen spec 6093ce5 + the frozen implementation semantics).
//
// One question only: can a consumer query multiple independently operated
// repositories, resolve an authenticated publication deterministically,
// fetch it from one of them, and preserve every P0/P1/P2 trust boundary —
// without treating any repository as global authority?
//
// FROZEN BOUNDARIES IMPLEMENTED HERE:
// - peers = finite configured {repository_id, endpoint} set; repository_id
//   is CONSUMER-ASSIGNED and endpoint-bound — a repository-supplied id is
//   never accepted; duplicate configured ids refuse federation startup.
// - per-peer status exactly VALID | INVALID | ABSENT | UNAVAILABLE;
// - P2 validation independently verifies tuple/D/proof while CONSULTING
//   the existing local pin WITHOUT changing it (OBSERVE/RESOLVE is
//   read-only; only the sealed P2 stage/import path mutates pins);
// - P1 results are keyed by B-local repository_id and never merged;
// - deterministic aggregates: CONSISTENT | PARTIAL | CONFLICT | INVALID |
//   EMPTY; CONFLICT/INVALID/EMPTY have NO automatic fetch path; only
//   CONSISTENT or PARTIAL with a resolved candidate may proceed to fetch;
// - compatible P2 heads (strict extensions) resolve to the unique highest
//   head that cryptographically extends every lower valid head, labeled
//   NOT globally fresh; equal-sequence or non-extending heads = CONFLICT;
// - exact-D alternate fetch only from a peer ALREADY VALID for that exact
//   tuple/D; after fetch, D is recomputed and the proof independently
//   re-verified; federation itself has zero registry/admission/routing/
//   pin authority.
// - fetch NEVER trusts caller JSON: it consumes a B-authored ephemeral
//   resolution handle (in-process, non-persistent, zero authority) and
//   RE-OBSERVES the byte source at fetch time, requiring the full tuple
//   binding (scheme/publisher/name/version/D) against the resolution's
//   canonical candidate;
// - the fetch/stage handoff carries the resolution's CANONICAL proof
//   material (the unique highest mutually compatible identity state, chosen
//   deterministically by head then repository_id) — never an arbitrary
//   peer's, so the pin cannot be advanced to a lower state depending on
//   which mirror happened to serve the bytes.

import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyGenesis, replayChain, verifyPublication, classifyFreshness, chainExtendsPin } from './identity.js';
import { canonicalJson } from './flowrouter.js';
import { resolveConfig } from './config.js';
import { getTask } from './tasks.js';

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

// P0 digest recomputation over received bytes (capability.json canonicalized
// with the bundle digest fields omitted, then the frozen ordered list).
function packageDigestOf(files) {
  const cap = files.find((f) => f.path === 'capability.json');
  const m = JSON.parse(cap.bytes.toString('utf8'));
  const bundle = (m.implementation && m.implementation.bundle) || {};
  const capNo = Buffer.from(canonicalJson({ ...m, implementation: { ...(m.implementation || {}), bundle: { algorithm: bundle.algorithm || 'sha256' } } }), 'utf8');
  const list = files.map((f) => (f.path === 'capability.json' ? { path: f.path, bytes: capNo } : f))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\n${f.bytes.length}\n${createHash('sha256').update(f.bytes).digest('hex')}\n`).join('');
  return createHash('sha256').update(Buffer.from(list, 'utf8')).digest('hex');
}

// Consumer-configured peer validation (frozen): duplicate local ids refuse
// federation startup entirely.
export function validatePeers(peers) {
  if (!Array.isArray(peers) || peers.length === 0) throw fedErr('FEDERATION_NOT_CONFIGURED', 'no peers configured');
  const seen = new Set();
  for (const p of peers) {
    if (!p || typeof p.repository_id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.repository_id)) throw fedErr('PEER_INVALID', 'each peer needs a canonical local repository_id');
    if (typeof p.endpoint !== 'string' || !/^https?:\/\//.test(p.endpoint)) throw fedErr('PEER_INVALID', `peer ${p.repository_id} needs an http(s) endpoint`);
    if (seen.has(p.repository_id)) throw fedErr('PEER_DUPLICATE_ID', `duplicate configured repository_id "${p.repository_id}" — federation refuses to start`);
    seen.add(p.repository_id);
  }
  return peers;
}
function fedErr(code, detail) { const e = new Error(detail ? `${code}: ${detail}` : code); e.code = code; return e; }

// local pin consultation (READ-ONLY — never written here)
async function readPin(publisherId) {
  const t = await getTask('pin_' + publisherId);
  return t && t.pin ? { sequence: t.pin.sequence, head_digest: t.pin.head_digest } : null;
}

// one peer query + independent classification → VALID | INVALID | ABSENT | UNAVAILABLE
async function observePeer(peer, { scheme, publisher_id, name, version }) {
  const base = { repository_id: peer.repository_id, endpoint: peer.endpoint };
  let res;
  try {
    res = await fetch(peer.endpoint.replace(/\/$/, '') + '/publication/' + encodeURIComponent(publisher_id) + '/' + encodeURIComponent(name) + '/' + encodeURIComponent(version) + (scheme ? '?scheme=' + encodeURIComponent(scheme) : ''), { signal: AbortSignal.timeout(10000) });
  } catch (e) {
    return { ...base, status: 'UNAVAILABLE', reason: String(e.message || e).slice(0, 120) };
  }
  if (res.status === 404) return { ...base, status: 'ABSENT' };
  if (!res.ok) return { ...base, status: 'UNAVAILABLE', reason: 'HTTP ' + res.status };
  let body;
  try { body = await res.json(); } catch { return { ...base, status: 'INVALID', reason: 'unparseable response' }; }

  // never accept repository-supplied identity of the repository itself;
  // the tuple components, however, are exactly what we must verify.
  const tuple = { publisher_scheme: body.publisher_scheme, publisher_id: body.publisher_id, name: body.name, version: body.version };
  if (tuple.publisher_id !== publisher_id || tuple.name !== name || tuple.version !== version || (scheme && tuple.publisher_scheme !== scheme)) {
    return { ...base, status: 'INVALID', reason: 'tuple mismatch vs query', tuple };
  }
  const D = body.D;
  const auth = body.publisher_auth || 'UNAUTHENTICATED';
  const material = body.material || null;

  if (tuple.publisher_scheme === 'p1-configured-v1') {
    // P1: origin-scoped by the B-LOCAL repository id; never merged.
    return { ...base, status: 'VALID', tuple, D, publisher_auth: auth, material: null, origin_scoped: true };
  }
  // P2: independent verification; the pin is consulted, never written.
  try {
    if (!material || !material.genesis || !Array.isArray(material.events) || !material.publication) throw fedErr('INVALID', 'no verification material');
    const g = verifyGenesis(material.genesis);
    const chain = replayChain(material.genesis, material.events);
    const vp = verifyPublication(material.publication, chain);
    if (material.publication.D !== D) throw fedErr('INVALID', 'assertion D differs from the served D');
    if (g.publisher_id !== publisher_id || vp.publisher_id !== publisher_id) throw fedErr('INVALID', 'proof does not authenticate the queried publisher');
    if (material.publication.name !== name || material.publication.version !== version) throw fedErr('INVALID', 'proof does not authenticate the queried name/version');
    // pin classification (read-only)
    const pin = await readPin(publisher_id);
    const cls = classifyFreshness(pin, { sequence: chain.head_sequence, head_digest: chain.head_digest });
    if (cls.freshness === 'EXTENDS_LOCAL_PIN') chainExtendsPin(material.genesis, material.events, pin);
    return {
      ...base, status: 'VALID', tuple, D, publisher_auth: 'VERIFIED', material,
      freshness: cls.freshness, head_sequence: chain.head_sequence, head_digest: chain.head_digest,
    };
  } catch (e) {
    return { ...base, status: 'INVALID', reason: e.code ? `${e.code}` : String(e.message).slice(0, 120), tuple, D };
  }
}

// aggregates (frozen five-state machine; CONFLICT outranks everything)
export function aggregate(observations) {
  const valid = observations.filter((o) => o.status === 'VALID');
  const invalid = observations.filter((o) => o.status === 'INVALID');
  if (valid.length === 0) {
    if (invalid.length > 0) return { state: 'INVALID', observations, candidate: null, fetch_permitted: false };
    return { state: 'EMPTY', observations, candidate: null, fetch_permitted: false };
  }
  // CONFLICT: two or more VALID P2 observations for the same tuple disagree on D
  // or carry incompatible authenticated histories. Invalid peers never conflict.
  const p2 = valid.filter((o) => o.tuple.publisher_scheme === 'p2-selfcert-v1');
  const ds = new Set(p2.map((o) => o.D));
  if (ds.size > 1) return { state: 'CONFLICT', observations, candidate: null, fetch_permitted: false, reason: 'valid P2 observations disagree on D' };
  let proofState = null;
  let canonicalMaterial = null;
  let canonicalSource = null;
  if (p2.length > 0) {
    // compatible heads: the unique highest head that cryptographically
    // extends every lower valid head (strict extension via chain relation).
    // Canonical order: head_sequence DESC, then repository_id ASC — so the
    // selected proof material is independent of peer query order.
    const sorted = [...p2].sort((a, b) => (b.head_sequence - a.head_sequence) || (a.repository_id < b.repository_id ? -1 : a.repository_id > b.repository_id ? 1 : 0));
    // equal sequence with different heads → CONFLICT
    const top = sorted[0];
    const sameSeq = sorted.filter((o) => o.head_sequence === top.head_sequence);
    if (new Set(sameSeq.map((o) => o.head_digest)).size > 1) {
      return { state: 'CONFLICT', observations, candidate: null, fetch_permitted: false, reason: 'equal-sequence valid heads differ' };
    }
    // every lower head must be an ancestor of the highest (strict extension)
    for (const lower of sorted.slice(1)) {
      const ext = (() => { try { chainExtendsPin(top.material.genesis, top.material.events, { sequence: lower.head_sequence, head_digest: lower.head_digest }); return true; } catch { return false; } })();
      if (!ext) return { state: 'CONFLICT', observations, candidate: null, fetch_permitted: false, reason: `non-extending heads (${lower.head_sequence} vs ${top.head_sequence})` };
    }
    proofState = { head_sequence: top.head_sequence, head_digest: top.head_digest, proof_source: top.repository_id, globally_fresh: false, note: 'most advanced mutually compatible state observed in this query — not globally fresh' };
    // THE canonical proof material for the sealed P2 stage handoff
    canonicalMaterial = top.material;
    canonicalSource = top.repository_id;
  }
  const allValid = observations.every((o) => o.status === 'VALID');
  const D = [...ds][0] || (valid[0] && valid[0].D);
  const candidate = {
    tuple: p2.length ? valid.find((o) => o.tuple.publisher_scheme === 'p2-selfcert-v1').tuple : valid[0].tuple,
    D,
    proof_state: proofState,
    // F0-selected proof material (not the caller's, not an arbitrary peer's)
    material: canonicalMaterial,
    material_source: canonicalSource,
    valid_peers: valid.map((o) => o.repository_id),
    p1_origin_scoped: valid.filter((o) => o.origin_scoped).map((o) => ({ repository_id: o.repository_id, tuple: o.tuple, D: o.D })),
  };
  // P1: no cross-repository collapsing — a P1 candidate is only meaningful
  // when exactly one origin-scoped observation exists for it.
  if (p2.length === 0) {
    const origins = new Set(valid.map((o) => o.repository_id));
    candidate.p1_requires_single_origin = origins.size > 1;
    if (origins.size > 1) return { state: 'CONFLICT', observations, candidate: null, fetch_permitted: false, reason: 'P1 identity is origin-scoped and never merged across repositories' };
  }
  return {
    state: allValid ? 'CONSISTENT' : 'PARTIAL',
    observations, candidate, fetch_permitted: true,
  };
}

// Ephemeral, in-process, non-persistent resolution handles. A handle is a
// REFERENCE to a resolution B itself produced — never a claim supplied by a
// caller — and carries zero trust authority of its own.
const RESOLUTIONS = new Map();
const RESOLUTION_TTL_MS = 30 * 60 * 1000;
const RESOLUTION_MAX = 64;
function rememberResolution(entry) {
  const handle = 'fedres_' + randomBytes(16).toString('hex');
  const now = Date.now();
  for (const [h, v] of RESOLUTIONS) if (now - v.created_at > RESOLUTION_TTL_MS) RESOLUTIONS.delete(h);
  while (RESOLUTIONS.size >= RESOLUTION_MAX) RESOLUTIONS.delete(RESOLUTIONS.keys().next().value);
  RESOLUTIONS.set(handle, { ...entry, handle, created_at: now });
  return handle;
}
function lookupResolution(handle) {
  if (typeof handle !== 'string' || !/^fedres_[a-f0-9]{32}$/.test(handle)) return null;
  const v = RESOLUTIONS.get(handle);
  if (!v || Date.now() - v.created_at > RESOLUTION_TTL_MS) { RESOLUTIONS.delete(handle); return null; }
  return v;
}

export async function resolveFederated({ peers, scheme, publisher_id, name, version }) {
  const cfg = resolveConfig().config || {};
  const peerSet = validatePeers(peers || (cfg.federation && cfg.federation.peers) || []);
  // query peers INDEPENDENTLY (parallel, deterministic aggregation)
  const observations = await Promise.all(peerSet.map((p) => observePeer(p, { scheme, publisher_id, name, version })));
  const agg = aggregate(observations);
  const resolution_handle = rememberResolution({ peerSet, query: { scheme: scheme || null, publisher_id, name, version }, observations, candidate: agg.candidate, fetch_permitted: !!agg.fetch_permitted });
  return { ok: true, query: { scheme: scheme || null, publisher_id, name, version }, resolution_handle, ...agg };
}

// Exact-D fetch. Trust model:
//   - the resolution is B's own (looked up by handle), never caller JSON;
//   - the byte source must be a peer that is VALID for this exact tuple/D
//     in that resolution AND still VALID for it when re-observed NOW;
//   - the returned bytes are recomputed locally and must equal the resolved
//     D, and the canonical (F0-selected) proof material is re-verified and
//     returned for the stage handoff.
export async function fetchExact({ resolutionHandle, D, bytesFrom }) {
  const res = lookupResolution(resolutionHandle);
  if (!res) throw fedErr('FETCH_NOT_PERMITTED', 'no such resolution handle — fetch consumes a B-authored resolution, not a caller-supplied claim');
  const cand = res.candidate;
  if (!res.fetch_permitted || !cand || cand.D !== D) {
    throw fedErr('FETCH_NOT_PERMITTED', 'no resolved candidate for this exact D — CONFLICT/INVALID/EMPTY and mismatched D have no fetch path');
  }
  const eligible = res.observations.filter((o) => o.status === 'VALID' && o.D === D);
  if (eligible.length === 0) throw fedErr('FETCH_NOT_PERMITTED', 'no peer was recorded VALID for this exact tuple/D');
  if (bytesFrom && !eligible.some((o) => o.repository_id === bytesFrom)) {
    throw fedErr('FETCH_NOT_PERMITTED', `byte source ${bytesFrom} is not VALID for this exact tuple/D`);
  }
  // deterministic order: explicit byte source first, otherwise canonical
  // repository_id order
  const order = (bytesFrom ? [bytesFrom] : []).concat(eligible.map((o) => o.repository_id).filter((r) => r !== bytesFrom).sort());
  let lastReason = 'no VALID peer could serve this exact D with a matching recomputation — no substitution performed';
  for (const repoId of order) {
    const peerCfg = res.peerSet.find((p) => p.repository_id === repoId);
    if (!peerCfg) continue;
    // RE-OBSERVE now: the peer must still verify for this exact tuple/D —
    // caller-supplied status/material is never used.
    const fresh = await observePeer(peerCfg, res.query);
    if (fresh.status !== 'VALID' || fresh.D !== D) { lastReason = `byte source ${repoId} is not VALID for this exact tuple/D on re-observation`; continue; }
    if (cand.tuple.publisher_scheme === 'p2-selfcert-v1') {
      // full tuple binding: scheme + publisher + name + version + D must
      // agree across the served proof, the verified genesis and the
      // resolution's canonical candidate
      try {
        const g = verifyGenesis(fresh.material.genesis);
        const chain = replayChain(fresh.material.genesis, fresh.material.events);
        const vp = verifyPublication(fresh.material.publication, chain);
        const pub = fresh.material.publication;
        if (pub.publisher_scheme !== cand.tuple.publisher_scheme) throw fedErr('FETCH_NOT_PERMITTED', 'served proof scheme differs from the resolution');
        if (pub.publisher_id !== cand.tuple.publisher_id || g.publisher_id !== cand.tuple.publisher_id) throw fedErr('FETCH_NOT_PERMITTED', 'served proof publisher differs from the resolution');
        if (pub.name !== cand.tuple.name || pub.version !== cand.tuple.version) throw fedErr('FETCH_NOT_PERMITTED', 'served proof name/version differs from the resolution');
        if (pub.D !== cand.D) throw fedErr('FETCH_NOT_PERMITTED', 'served proof D differs from the resolution');
        if (vp.publisher_id !== cand.tuple.publisher_id) throw fedErr('FETCH_NOT_PERMITTED', 'served assertion does not authenticate the resolved publisher');
      } catch (e) {
        lastReason = String(e.message).slice(0, 160);
        continue;
      }
    }
    let wire;
    try {
      const r = await fetch(peerCfg.endpoint.replace(/\/$/, '') + '/fetch/' + D, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) { lastReason = `byte source ${repoId} served no artifact for this D`; continue; }
      wire = Buffer.from(await r.arrayBuffer());
    } catch { lastReason = `byte source ${repoId} unavailable for artifact retrieval`; continue; }
    // recompute the P0 digest over the received bytes — a malformed or
    // hostile artifact is a source failure, never an escape from the route
    let recomputed;
    try {
      const obj = JSON.parse(wire.toString('utf8'));
      if (!Array.isArray(obj.files) || obj.files.length === 0) throw new Error('artifact carries no files');
      const files = obj.files.map((f) => ({ path: f.path, bytes: Buffer.from(f.b64, 'base64') }));
      recomputed = packageDigestOf(files);
    } catch (e) {
      lastReason = `byte source ${repoId} served an unusable artifact: ${String(e.message).slice(0, 80)}`;
      continue;
    }
    if (recomputed !== D) { lastReason = 'received bytes do not recompute to the resolved D'; continue; }
    // The canonical proof material is the resolution's F0-selected state —
    // not this peer's (which may be a lower compatible head). Re-verify it
    // before handing it to the sealed stage path.
    let material = cand.material || null;
    if (cand.tuple.publisher_scheme === 'p2-selfcert-v1') {
      if (!material) { lastReason = 'resolution carried no canonical proof material'; continue; }
      const g2 = verifyGenesis(material.genesis);
      const ch2 = replayChain(material.genesis, material.events);
      const vp2 = verifyPublication(material.publication, ch2);
      const pub2 = material.publication;
      const okTuple = pub2.publisher_scheme === cand.tuple.publisher_scheme
        && pub2.publisher_id === cand.tuple.publisher_id && g2.publisher_id === cand.tuple.publisher_id
        && pub2.name === cand.tuple.name && pub2.version === cand.tuple.version
        && pub2.D === cand.D && vp2.publisher_id === cand.tuple.publisher_id;
      if (!okTuple) { lastReason = 'canonical proof material failed the tuple rebinding'; continue; }
      if (cand.proof_state && (pub2.identity_sequence !== cand.proof_state.head_sequence || pub2.identity_head_digest !== cand.proof_state.head_digest)) {
        lastReason = 'canonical proof material does not match the resolved proof state';
        continue;
      }
    } else {
      material = null; // P1: no portable proof material
    }
    return {
      ok: true, fetched_from: repoId, D, bytes_b64: wire.toString('base64'), recomputed_D: recomputed,
      tuple: cand.tuple, material, proof_state: cand.proof_state, proof_source: cand.material_source,
    };
  }
  throw fedErr('FETCH_UNAVAILABLE', lastReason);
}
