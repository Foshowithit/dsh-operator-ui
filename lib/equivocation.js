// lib/equivocation.js — FlowRouter F1: equivocation evidence (spec e9e7ef6).
//
// One question: can a consumer turn a contradiction into portable, offline-
// verifiable evidence without any repository, majority, or global log gaining
// the authority to declare who is honest?
//
// FROZEN BOUNDARIES IMPLEMENTED HERE:
// - the portable evidence is ONLY proof_core (type, publisher_id, genesis,
//   branches, relation) with an EXACT schema — carrier annotations and local
//   notes live outside its bytes and never affect verification or identity;
// - no new cryptography: verification reuses the frozen P2 primitives
//   (verifyGenesis / replayChain / record digests). The core is unsigned; its
//   force comes entirely from the two publisher-signed branches inside it, so
//   a carrier can FORWARD a proof but can never AUTHOR a valid one;
// - verification is offline and self-contained: no peer, no pin, no network;
// - canonical pair selection (dedupe by head_sequence+head_digest, ascending
//   sort, lexicographically first non-comparable pair) is canonicalization
//   only and carries NO temporal meaning;
// - false-positive freedom under the frozen P2 assumptions + an uncompromised
//   genesis key: one linear history can never be packaged as a valid proof;
// - local policy: quarantine by verified unacknowledged proof, refusal code
//   PUBLISHER_EQUIVOCATION_UNACKNOWLEDGED, acknowledgment per proof digest
//   that records metadata and neither deletes the proof nor selects a branch.

import { createHash, randomUUID } from 'node:crypto';
import { jcs, verifyGenesis, replayChain, recordDigest } from './identity.js';
import { getTask, upsertTask, listTasks } from './tasks.js';

export const PROOF_TYPE = 'flowrouter.f1.equivocation-proof.v1';
export const QUARANTINE_CODE = 'PUBLISHER_EQUIVOCATION_UNACKNOWLEDGED';
export const RELATIONS = ['SAME_SEQUENCE_DIVERGENT', 'NONEXTENDING_FORK'];
const CORE_FIELDS = ['type', 'publisher_id', 'genesis', 'branches', 'relation'];
const BRANCH_FIELDS = ['events', 'head_sequence', 'head_digest'];
const HEX64 = /^[a-f0-9]{64}$/;

function f1err(code, detail) { const e = new Error(detail ? `${code}: ${detail}` : code); e.code = code; return e; }
const isoNow = () => new Date().toISOString();

// The proof's stable identity (acknowledgment + deduplication).
export function proofDigest(core) {
  return createHash('sha256')
    .update(Buffer.from(PROOF_TYPE + '\n', 'utf8'))
    .update(Buffer.from(jcs(core), 'utf8'))
    .digest('hex');
}

// ---------------------------------------------------------------- construction

// Chain digests at every prefix: index 0 is the genesis record digest.
function chainDigests(genesisRecord, events) {
  let d = recordDigest(genesisRecord);
  const digests = [d];
  for (const ev of events) { d = recordDigest(ev); digests.push(d); }
  return digests;
}

// A extends B iff B's head is B's declared sequence head inside A's chain.
function extendsOther(aDigests, b) {
  const idx = aDigests.indexOf(b.head_digest);
  return idx !== -1 && idx === b.head_sequence;
}

function deriveRelation(a, b) {
  if (a.head_sequence === b.head_sequence) return 'SAME_SEQUENCE_DIVERGENT';
  return 'NONEXTENDING_FORK';
}

// Canonical pair from N observed states (frozen construction rule). Returns
// null when the states are all mutually comparable (no fork — the honest case).
export function buildProofCore({ genesis, states }) {
  const g = verifyGenesis(genesis);
  const seen = new Set();
  const unique = [];
  for (const st of states || []) {
    const events = (st && st.events) || [];
    const chain = replayChain(genesis, events);
    const key = chain.head_sequence + ':' + chain.head_digest;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ events, head_sequence: chain.head_sequence, head_digest: chain.head_digest });
  }
  unique.sort((x, y) => (x.head_sequence - y.head_sequence) || (x.head_digest < y.head_digest ? -1 : x.head_digest > y.head_digest ? 1 : 0));
  const digests = new Map(unique.map((b) => [b.head_sequence + ':' + b.head_digest, chainDigests(genesis, b.events)]));
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const a = unique[i];
      const b = unique[j];
      const aExt = extendsOther(digests.get(a.head_sequence + ':' + a.head_digest), b);
      const bExt = extendsOther(digests.get(b.head_sequence + ':' + b.head_digest), a);
      if (aExt || bExt) continue; // comparable — not a fork
      return {
        core: {
          type: PROOF_TYPE,
          publisher_id: g.publisher_id,
          genesis,
          branches: [
            { events: a.events, head_sequence: a.head_sequence, head_digest: a.head_digest },
            { events: b.events, head_sequence: b.head_sequence, head_digest: b.head_digest },
          ],
          relation: deriveRelation(a, b),
        },
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------- verification

function assertExactSchema(core) {
  if (!core || typeof core !== 'object' || Array.isArray(core)) throw f1err('EQUIVOCATION_PROOF_INVALID', 'core must be an object');
  const keys = Object.keys(core).sort();
  if (keys.join(',') !== [...CORE_FIELDS].sort().join(',')) throw f1err('EQUIVOCATION_PROOF_INVALID', 'core fields must be exactly ' + CORE_FIELDS.join(', '));
  if (core.type !== PROOF_TYPE) throw f1err('EQUIVOCATION_PROOF_INVALID', 'wrong proof type');
  if (!HEX64.test(String(core.publisher_id || ''))) throw f1err('EQUIVOCATION_PROOF_INVALID', 'publisher_id must be 64-hex');
  if (!RELATIONS.includes(core.relation)) throw f1err('EQUIVOCATION_PROOF_INVALID', 'unknown relation');
  if (!Array.isArray(core.branches) || core.branches.length !== 2) throw f1err('EQUIVOCATION_PROOF_INVALID', 'exactly two branches are required');
  for (const b of core.branches) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw f1err('EQUIVOCATION_PROOF_INVALID', 'branch must be an object');
    if (Object.keys(b).sort().join(',') !== [...BRANCH_FIELDS].sort().join(',')) throw f1err('EQUIVOCATION_PROOF_INVALID', 'branch fields must be exactly ' + BRANCH_FIELDS.join(', '));
    if (!Array.isArray(b.events)) throw f1err('EQUIVOCATION_PROOF_INVALID', 'branch events must be an array');
    if (!Number.isInteger(b.head_sequence) || b.head_sequence < 0) throw f1err('EQUIVOCATION_PROOF_INVALID', 'branch head_sequence must be a non-negative integer');
    if (!HEX64.test(String(b.head_digest || ''))) throw f1err('EQUIVOCATION_PROOF_INVALID', 'branch head_digest must be 64-hex');
  }
}

// Six frozen checks; anything off is INVALID and the core is discarded WHOLE.
export function verifyProofCore(core) {
  assertExactSchema(core);
  // Any failure inside the enclosed P2 material is a failure of THIS core:
  // the whole object is discarded, never partially believed (spec §5).
  const asInvalid = (what, fn) => {
    try { return fn(); } catch (e) {
      if (e && e.code === 'EQUIVOCATION_PROOF_INVALID') throw e;
      throw f1err('EQUIVOCATION_PROOF_INVALID', `${what}: ${String(e.message).slice(0, 120)}`);
    }
  };
  const g = asInvalid('genesis', () => verifyGenesis(core.genesis));
  if (g.publisher_id !== core.publisher_id) throw f1err('EQUIVOCATION_PROOF_INVALID', 'genesis does not authenticate the declared publisher_id');
  const [a, b] = core.branches;
  const replayed = core.branches.map((br) => {
    const chain = asInvalid('branch replay', () => replayChain(core.genesis, br.events));
    if (chain.head_sequence !== br.head_sequence || chain.head_digest !== br.head_digest) throw f1err('EQUIVOCATION_PROOF_INVALID', 'declared branch head does not match its replayed chain');
    return chain;
  });
  // canonical pair order: (head_sequence ASC, head_digest ASC)
  const ordered = a.head_sequence < b.head_sequence || (a.head_sequence === b.head_sequence && a.head_digest < b.head_digest);
  if (!ordered) throw f1err('EQUIVOCATION_PROOF_INVALID', 'branches are not in canonical order');
  if (jcs(a) === jcs(b)) throw f1err('EQUIVOCATION_PROOF_INVALID', 'identical branches are not a fork');
  const aDigests = chainDigests(core.genesis, a.events);
  const bDigests = chainDigests(core.genesis, b.events);
  if (extendsOther(aDigests, b) || extendsOther(bDigests, a)) throw f1err('EQUIVOCATION_PROOF_INVALID', 'branches are comparable — not a fork');
  if (core.relation !== deriveRelation(a, b)) throw f1err('EQUIVOCATION_PROOF_INVALID', 'declared relation does not match the derived relation');
  return {
    ok: true,
    publisher_id: core.publisher_id,
    relation: core.relation,
    proof_digest: proofDigest(core),
    branches: replayed.map((c) => ({ head_sequence: c.head_sequence, head_digest: c.head_digest })),
  };
}

// ---------------------------------------------------------------- local records

// The proof's identity is its full digest — the task key uses all of it (the
// store upserts by taskId, so a shorter id would create a collision domain
// that the frozen identity does not have).
const proofTaskId = (digest) => 'equiv_' + digest;

export async function listProofRecords(publisherId) {
  const all = await listTasks();
  return all.filter((t) => t.kind === 'equivocation' && (!publisherId || t.publisher_id === publisherId));
}

// Verify then record durably (dedupe by proof digest). Evidence only — this
// never touches a pin, a registry, or an admitted capability.
export async function recordProof({ core, observedVia }) {
  const v = verifyProofCore(core);
  const existing = (await listProofRecords(v.publisher_id)).find((t) => t.proof_digest === v.proof_digest);
  if (existing) return { ok: true, recorded: false, deduplicated: true, proof_digest: v.proof_digest, record: existing };
  const record = {
    taskId: proofTaskId(v.proof_digest),
    kind: 'equivocation',
    status: 'standing',
    publisher_id: v.publisher_id,
    relation: v.relation,
    proof_digest: v.proof_digest,
    proof_core: core,
    observed_via: normaliseObservedVia(observedVia),
    acknowledged: null,
    recordedAt: isoNow(),
  };
  await upsertTask(record);
  return { ok: true, recorded: true, proof_digest: v.proof_digest, record };
}

function normaliseObservedVia(via) {
  if (!via) return [];
  const list = Array.isArray(via) ? via : [via];
  return list.slice(0, 16).map((v) => String(v).slice(0, 120));
}

// A publisher is quarantined iff a VERIFIED proof record stands unacknowledged.
export async function isQuarantined(publisherId) {
  if (!publisherId) return false;
  const recs = await listProofRecords(publisherId);
  return recs.some((t) => !t.acknowledged);
}

export async function quarantinedPublishers() {
  const all = await listTasks();
  const map = new Map();
  for (const t of all) {
    if (t.kind !== 'equivocation' || t.acknowledged) continue;
    map.set(t.publisher_id, (map.get(t.publisher_id) || 0) + 1);
  }
  return [...map].map(([publisher_id, unacknowledged]) => ({ publisher_id, unacknowledged }));
}

// Acknowledgment is per proof digest: metadata only. It does not delete or
// weaken the proof, does not alter the pin, and does not select a branch.
export async function acknowledgeProof({ proofDigest: digest, operator }) {
  const recs = await listProofRecords();
  const rec = recs.find((t) => t.proof_digest === digest);
  if (!rec) return { ok: false, error: 'NO_SUCH_PROOF', reason: 'no local proof record with that digest' };
  const updated = { ...rec, acknowledged: { at: isoNow(), by: String(operator || 'operator').slice(0, 120) } };
  await upsertTask(updated);
  return { ok: true, proof: updated, still_quarantined: await isQuarantined(rec.publisher_id) };
}

// ---------------------------------------------------------------- local-history source

// Build a fork proof from the CONSUMER'S OWN material: the witness retained on
// the pin (genesis + events of the pinned state) plus a newly observed
// conflicting branch. A legacy pin without a witness yields no proof — the
// honest refusal, never a fabrication.
export async function proofFromLocalHistory({ publisherId, observed }) {
  const pinTask = await getTask('pin_' + publisherId);
  const w = pinTask && pinTask.witness;
  if (!w || !w.genesis || !Array.isArray(w.events)) {
    return { ok: false, error: 'NO_PINNED_WITNESS', reason: 'the pinned state predates witness retention — no portable local-history proof can be constructed' };
  }
  const built = buildProofCore({ genesis: w.genesis, states: [{ events: w.events }, { events: observed.events }] });
  if (!built) return { ok: false, error: 'NO_CONTRADICTION', reason: 'the observed history is comparable with the pinned witness' };
  return { ok: true, core: built.core, proof_digest: proofDigest(built.core) };
}
