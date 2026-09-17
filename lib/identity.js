// lib/identity.js — FlowRouter P2 publisher identity, implemented against
// the FROZEN spec v3 (commit 5269f25). No protocol redesign here.
//
// content integrity ≠ publisher authenticity ≠ local capability trust
//
// Ed25519 only · unpadded canonical base64url · UTF-8 RFC 8785 JCS
// canonicalization (subset: our records carry strings, string arrays,
// integers and booleans — floats are rejected) · full-length 64-hex ids ·
// genesis-signed AUTHORIZE/REVOKE state chain with frozen transition
// validity · detached publication assertions bound to the exact identity
// state · consumer pinning with FIRST_OBSERVATION_UNPROVEN /
// MATCHES_LOCAL_PIN / EXTENDS_LOCAL_PIN and fork-refusal.

import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, createPrivateKey, createPublicKey } from 'node:crypto';

// ---------------------------------------------------------------- primitives
export function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) throw p2err('ENCODING_INVALID', 'not unpadded canonical base64url');
  const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (b64url(b) !== s) throw p2err('ENCODING_INVALID', 'non-canonical base64url');
  return b;
}
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');
const utf8 = (s) => Buffer.from(s, 'utf8');

// JCS subset canonicalization (records are string/int/bool/array/object).
export function jcs(value) {
  const walk = (v) => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) throw p2err('IDENTITY_RECORD_INVALID', 'JCS subset: non-integer numbers are not used in P2 records');
      return String(v);
    }
    if (Array.isArray(v)) return '[' + v.map(walk).join(',') + ']';
    if (typeof v === 'object') {
      const keys = Object.keys(v).sort(); // JCS: UTF-16 code-unit order (ASCII keys here)
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + walk(v[k])).join(',') + '}';
    }
    throw p2err('IDENTITY_RECORD_INVALID', 'unsupported value');
  };
  return walk(value);
}

function p2err(code, detail) {
  const e = new Error(detail ? `${code}: ${detail}` : code);
  e.code = code;
  return e;
}
export { p2err };

// ---------------------------------------------------------------- key material
export function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = b64urlDecode(jwk.x);                      // 32-byte raw
  return { privateKey, publicKey, publicKeyRaw: raw, publicKeyB64: b64url(raw) };
}

export function keyObjectFromRaw(rawBytes) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(rawBytes) }, format: 'jwk' });
}

function signRecord(privateKey, messageBytes) {
  return b64url(cryptoSign(null, messageBytes, privateKey));
}
function verifyRecord(publicKeyRaw, messageBytes, sigB64) {
  try {
    return cryptoVerify(null, messageBytes, keyObjectFromRaw(publicKeyRaw), b64urlDecode(sigB64));
  } catch { return false; }
}

// ---------------------------------------------------------------- identity ids
export function derivePublisherId(genesisKeyRaw) {
  return sha256Hex(Buffer.concat([utf8('flowrouter.p2.publisher-id.v1'), genesisKeyRaw]));
}
export function deriveKeyId(publicKeyRaw) {
  return sha256Hex(Buffer.concat([utf8('flowrouter.p2.key-id.v1'), publicKeyRaw]));
}

// ---------------------------------------------------------------- signed bytes
export function recordDigest(fullRecord) {
  return sha256Hex(Buffer.concat([utf8('flowrouter.p2.record-digest.v1\n'), utf8(jcs(fullRecord))]));
}
function signedBytes(domain, recordMinusSig) {
  return Buffer.concat([utf8(domain), utf8(jcs(recordMinusSig))]);
}

// ---------------------------------------------------------------- genesis
export function createGenesis(genesisKp, displayName) {
  const publisherId = derivePublisherId(genesisKp.publicKeyRaw);
  const record = {
    record_type: 'flowrouter.p2.genesis.v1',
    publisher_scheme: 'p2-selfcert-v1',
    publisher_id: publisherId,
    genesis_key: { alg: 'ed25519', key: genesisKp.publicKeyB64 },
    ...(displayName ? { display_name: String(displayName) } : {}),
    created_at: new Date().toISOString(), // signed METADATA only
  };
  const self_signature = signRecord(genesisKp.privateKey, signedBytes('flowrouter.p2.genesis\n', record));
  return { ...record, self_signature };
}

export function verifyGenesis(record) {
  if (!record || record.record_type !== 'flowrouter.p2.genesis.v1') throw p2err('IDENTITY_RECORD_INVALID', 'not a genesis record');
  if (record.publisher_scheme !== 'p2-selfcert-v1') throw p2err('IDENTITY_RECORD_INVALID', 'wrong scheme');
  const raw = b64urlDecode(record.genesis_key.key);
  if (derivePublisherId(raw) !== record.publisher_id) throw p2err('IDENTITY_DERIVATION_MISMATCH', 'publisher_id does not derive from genesis key');
  const { self_signature, ...rest } = record;
  if (!verifyRecord(raw, signedBytes('flowrouter.p2.genesis\n', rest), self_signature)) throw p2err('IDENTITY_RECORD_INVALID', 'genesis self-signature invalid');
  return { publisher_id: record.publisher_id, genesisKeyRaw: raw, digest: recordDigest(record) };
}

// ---------------------------------------------------------------- key events
export function createKeyEvent({ genesisKp, genesisRecord, sequence, prevRecordDigest, action, keyId, publicKeyRaw, permissions }) {
  const record = {
    record_type: 'flowrouter.p2.key-event.v1',
    publisher_id: genesisRecord.publisher_id,
    sequence,
    prev_record_digest: prevRecordDigest,
    action,
    key_id: keyId,
    ...(action === 'AUTHORIZE' ? { public_key: { alg: 'ed25519', key: b64url(publicKeyRaw) }, permissions } : {}),
    issued_at: new Date().toISOString(), // signed METADATA only
  };
  const signature = signRecord(genesisKp.privateKey, signedBytes('flowrouter.p2.key-event\n', record));
  return { ...record, signature };
}

// Replay with the FROZEN transition validity (§3a). Returns the active set.
export function replayChain(genesisRecord, events) {
  const g = verifyGenesis(genesisRecord);
  let headDigest = g.digest;
  let seq = 0;
  const active = new Map(); // key_id -> { publicKeyRaw, permissions }
  for (const ev of events) {
    if (!ev || ev.record_type !== 'flowrouter.p2.key-event.v1') throw p2err('IDENTITY_RECORD_INVALID', 'not a key event');
    if (ev.publisher_id !== g.publisher_id) throw p2err('IDENTITY_RECORD_INVALID', 'wrong publisher_id');
    if (ev.sequence !== seq + 1) throw p2err('IDENTITY_RECORD_INVALID', 'sequence gap');
    if (ev.prev_record_digest !== headDigest) throw p2err('IDENTITY_RECORD_INVALID', 'wrong predecessor digest');
    const { signature, ...rest } = ev;
    if (!verifyRecord(g.genesisKeyRaw, signedBytes('flowrouter.p2.key-event\n', rest), signature)) throw p2err('IDENTITY_RECORD_INVALID', 'bad event signature');
    if (ev.action === 'AUTHORIZE') {
      if (!ev.public_key || !ev.public_key.key) throw p2err('IDENTITY_RECORD_INVALID', 'AUTHORIZE requires public_key');
      if (JSON.stringify(ev.permissions) !== JSON.stringify(['publish'])) throw p2err('IDENTITY_RECORD_INVALID', 'permissions must be exactly ["publish"]');
      const raw = b64urlDecode(ev.public_key.key);
      if (deriveKeyId(raw) !== ev.key_id) throw p2err('IDENTITY_RECORD_INVALID', 'key_id does not derive from public_key');
      if (active.has(ev.key_id)) throw p2err('IDENTITY_RECORD_INVALID', 'key already active');
      active.set(ev.key_id, { publicKeyRaw: raw, permissions: ev.permissions });
    } else if (ev.action === 'REVOKE') {
      if (ev.public_key !== undefined || ev.permissions !== undefined) throw p2err('IDENTITY_RECORD_INVALID', 'REVOKE must not carry public_key or permissions');
      if (!active.has(ev.key_id)) throw p2err('IDENTITY_RECORD_INVALID', 'revoking unknown or inactive key');
      active.delete(ev.key_id);
    } else {
      throw p2err('IDENTITY_RECORD_INVALID', 'unknown action');
    }
    headDigest = recordDigest(ev);
    seq = ev.sequence;
  }
  return { publisher_id: g.publisher_id, head_sequence: seq, head_digest: headDigest, active };
}

// ---------------------------------------------------------------- publications
export function signPublication({ privateKey, publisherId, name, version, D, keyId, identitySequence, identityHeadDigest }) {
  const statement = {
    statement_type: 'flowrouter.p2.publication.v1',
    publisher_scheme: 'p2-selfcert-v1',
    publisher_id: publisherId,
    name, version, D,
    key_id: keyId,
    identity_sequence: identitySequence,
    identity_head_digest: identityHeadDigest,
    issued_at: new Date().toISOString(),
  };
  const signature = signRecord(privateKey, signedBytes('flowrouter.p2.publication\n', statement));
  return { ...statement, signature };
}

export function verifyPublication(assertion, chain) {
  // chain = replayChain(...) result; the key must be ACTIVE at the asserted state
  if (!assertion || assertion.statement_type !== 'flowrouter.p2.publication.v1') throw p2err('SIGNED_STATEMENT_MISMATCH', 'not a publication assertion');
  if (assertion.publisher_scheme !== 'p2-selfcert-v1') throw p2err('SIGNED_STATEMENT_MISMATCH', 'wrong scheme');
  if (assertion.publisher_id !== chain.publisher_id) throw p2err('SIGNED_STATEMENT_MISMATCH', 'publisher mismatch');
  if (assertion.identity_sequence !== chain.head_sequence || assertion.identity_head_digest !== chain.head_digest) {
    throw p2err('SIGNED_STATEMENT_MISMATCH', 'assertion is not bound to the supplied identity state');
  }
  const key = chain.active.get(assertion.key_id);
  if (!key) throw p2err('KEY_NOT_AUTHORIZED', 'key is not active at the asserted identity state');
  const { signature, ...rest } = assertion;
  if (!verifyRecord(key.publicKeyRaw, signedBytes('flowrouter.p2.publication\n', rest), signature)) throw p2err('SIGNED_STATEMENT_MISMATCH', 'signature invalid');
  return { publisher_id: assertion.publisher_id, key_id: assertion.key_id, identity_sequence: chain.head_sequence, identity_head_digest: chain.head_digest };
}

// ---------------------------------------------------------------- pinning
export function classifyFreshness(pin, served) {
  // pin: { sequence, head_digest } | null; served: { sequence, head_digest }
  if (!pin) return { freshness: 'FIRST_OBSERVATION_UNPROVEN' };
  if (served.sequence < pin.sequence) throw p2err('SEQUENCE_ROLLBACK', `served ${served.sequence} < pinned ${pin.sequence}`);
  if (served.sequence === pin.sequence) {
    if (served.head_digest !== pin.head_digest) throw p2err('IDENTITY_HISTORY_FORK', 'same sequence, different head');
    return { freshness: 'MATCHES_LOCAL_PIN' };
  }
  // greater sequence must extend the exact pinned head — extension requires
  // the carried chain to include the pinned head digest as a predecessor
  return { freshness: 'EXTENDS_LOCAL_PIN', requiresExtendedFrom: pin.head_digest };
}

// Verify a served chain extends the pin exactly (used for EXTENDS_LOCAL_PIN).
export function chainExtendsPin(genesisRecord, events, pin) {
  let headDigest = recordDigest(genesisRecord);
  const digests = [headDigest];
  for (const ev of events) { headDigest = recordDigest(ev); digests.push(headDigest); }
  if (!pin) return true;
  const idx = digests.indexOf(pin.head_digest);
  if (idx === -1) throw p2err('IDENTITY_HISTORY_FORK', 'served history does not include the pinned head');
  // the pinned head must be the prefix head at the pinned sequence
  const seqAtPin = idx; // genesis = 0
  if (seqAtPin !== pin.sequence) throw p2err('IDENTITY_HISTORY_FORK', 'pinned head does not sit at the pinned sequence');
  return true;
}
