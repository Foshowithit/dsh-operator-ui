// lib/capability-input.js — bounded capability-input construction (RCOS D1).
//
// A dispatched capability workflow receives its structured inputs as a JSON
// document in $ARGUMENTS (see lib/capability-dispatch.js for the transport
// law). This module turns a natural-language objective into that JSON for the
// capabilities that have a declared input contract, and REFUSES — never guesses
// — when it cannot build inputs that satisfy the contract. A refusal here is
// what keeps an autonomous route from executing a workflow on made-up inputs.
//
// The builder is intentionally narrow: one explicit, validated shape per
// capability, keyed by capability id. Unsupported capabilities refuse with a
// named code so the surface can say exactly why nothing was dispatched.

import { readFileSync as __defaultReadFileSync, statSync as __defaultStatSync } from 'node:fs';
import { createHash as __defaultCreateHash } from 'node:crypto';

const FILE_RE = /^\/[A-Za-z0-9._/-]{1,240}$/;      // absolute, no shell metachars
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const INPUT_BUILDER_CODES = {
  UNSUPPORTED: 'input-builder-unsupported',
  MISSING_FILE: 'input-file-missing',
  BAD_FILE: 'input-file-invalid',
};

function refuse(code, message) {
  return { ok: false, code, message: String(message).slice(0, 220), args: null };
}

// Extract absolute file paths named in the objective. Bounded: only tokens that
// look like an absolute path with a media/known extension. No globbing.
export function extractCandidateFiles(objective) {
  const text = String(objective || '');
  const tokens = text.split(/[\s"'`]+/);
  const out = [];
  for (const t of tokens) {
    const cleaned = t.replace(/[),.;:]+$/, '');
    if (!cleaned.startsWith('/')) continue;
    if (!FILE_RE.test(cleaned)) continue;
    if (!/[.][A-Za-z0-9]{1,8}$/.test(cleaned)) continue;
    if (!out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

// audio-offline-verify: {"probes":[{name,file,...}]}. The objective must name at
// least one absolute media path; the probe name is derived from the basename.
function buildAudioOfflineVerify(objective) {
  const files = extractCandidateFiles(objective);
  if (!files.length) return refuse(INPUT_BUILDER_CODES.MISSING_FILE, 'audio-offline-verify needs at least one absolute media file path in the objective');
  const probes = files.map((file) => {
    const base = file.split('/').pop().replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'probe';
    let name = base.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    if (!NAME_RE.test(name)) name = 'probe';
    const probe = { name, file };
    // "must sound" is requested in the objective in natural language; honour it.
    if (/\bmust[- ]?sound\b|\bhas sound\b|\baudible\b|\bwith sound\b/i.test(String(objective))) probe.audio_must_sound = true;
    return probe;
  });
  return { ok: true, code: null, message: null, args: { probes } };
}

// mac-dell-staging: {action, staging_id, content_b64, content_sha256,
// target_relative_path}. The declared contract is `additionalProperties:false`
// with those five required, so an input of `{action, source}` is NOT a valid
// capability input — the adapter would refuse it and the capability would be
// promoted-but-unreachable. The builder therefore READS the named source file
// and derives the real identity: exact byte length, base64 of those bytes, and
// the sha256 of those bytes. It refuses when the file is missing, unreadable,
// a directory, empty, or over the capability's 8 MiB bound — never truncating
// and never fabricating a hash.
//
// `rollback` needs only staging_id, so it is built from the objective's staging
// id when one is named; a publish derives its staging_id from the source
// basename so stage and publish of the same file agree on the id.
const STAGING_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TARGET_REL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const MAC_DELL_MAX_BYTES = 8 * 1024 * 1024;

// Deterministic staging id from a source basename: lowercase, [a-z0-9._-] only,
// bounded to 64 chars. Same source -> same id, so stage then publish agree.
function stagingIdFor(file) {
  const base = String(file).split('/').pop().replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'staged';
  let id = base.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (!STAGING_ID_RE.test(id)) id = 'staged';
  return id;
}

// The objective may name the publish target with an explicit marker; otherwise
// the target is the source basename under the RCOS test-fixtures tree, which is
// a real, contained path and keeps the default honest and inspectable.
function targetRelativePathFor(objective, file) {
  const m = /(?:target|->|into)\s+([A-Za-z0-9][A-Za-z0-9._/-]{0,200})/i.exec(String(objective || ''));
  if (m && TARGET_REL_RE.test(m[1]) && !m[1].includes('..')) return m[1];
  const base = String(file).split('/').pop();
  return 'test-fixtures/' + base.replace(/[^A-Za-z0-9._-]/g, '-');
}

function buildMacDellStaging(objective, deps) {
  const text = String(objective || '');
  const files = extractCandidateFiles(objective);
  const readFileImpl = deps && deps.readFileSync;
  const actions = ['rollback', 'publish', 'stage'];
  let action = 'stage';
  for (const a of actions) { if (new RegExp('\\b' + a + '\\b', 'i').test(text)) { action = a; break; } }

  // ROLLBACK needs NO source file: it identifies a staged copy by id. Handle it
  // BEFORE the source guard, or a rollback objective would be refused for a
  // missing file it never needed.
  if (action === 'rollback') {
    const idm = /\bstaging[ _-]?id\s*[:=]?\s*([a-z0-9][a-z0-9._-]{0,63})/i.exec(text);
    const stagingId = idm ? idm[1] : (files.length ? stagingIdFor(files[0]) : null);
    if (!stagingId || !STAGING_ID_RE.test(stagingId)) {
      return refuse(INPUT_BUILDER_CODES.BAD_FILE, 'rollback needs a valid staging_id (e.g. "rollback staging_id <id>")');
    }
    return { ok: true, code: null, message: null, args: { action, staging_id: stagingId } };
  }

  if (!files.length) return refuse(INPUT_BUILDER_CODES.MISSING_FILE, 'mac-dell-staging needs an absolute source path in the objective');
  const source = files[0];

  if (typeof readFileImpl !== 'function') {
    // No reader injected: refuse rather than emit a hash we cannot back.
    return refuse(INPUT_BUILDER_CODES.MISSING_FILE, 'mac-dell-staging needs a file reader to derive the exact content hash');
  }
  // Stat BEFORE reading: reading a directory throws EISDIR, which would be
  // misreported as "not readable" (MISSING_FILE) instead of the real defect
  // (a directory is the wrong KIND of thing — BAD_FILE).
  let st;
  try { st = deps.statSync ? deps.statSync(source) : null; } catch { st = null; }
  if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
    return refuse(INPUT_BUILDER_CODES.BAD_FILE, 'source is a directory, not a file: ' + source);
  }
  let buf;
  try { buf = readFileImpl(source); } catch (e) { return refuse(INPUT_BUILDER_CODES.MISSING_FILE, 'source is not readable: ' + source); }
  if (!buf || buf.length === 0) return refuse(INPUT_BUILDER_CODES.BAD_FILE, 'source is empty: ' + source);
  if (buf.length > MAC_DELL_MAX_BYTES) return refuse('input-file-too-large', 'source exceeds the 8 MiB staging bound (' + buf.length + ' bytes): ' + source);

  const cryptoImpl = (deps && deps.createHash) || null;
  if (!cryptoImpl) return refuse(INPUT_BUILDER_CODES.MISSING_FILE, 'mac-dell-staging needs a hasher to derive sha256');
  const contentSha = cryptoImpl('sha256').update(buf).digest('hex');
  const stagingId = stagingIdFor(source);
  const targetRelativePath = targetRelativePathFor(text, source);
  if (!TARGET_REL_RE.test(targetRelativePath) || targetRelativePath.includes('..')) {
    return refuse(INPUT_BUILDER_CODES.BAD_FILE, 'derived target_relative_path is not a safe relative path');
  }
  return {
    ok: true, code: null, message: null,
    args: {
      action,
      staging_id: stagingId,
      content_b64: buf.toString('base64'),
      content_sha256: contentSha,
      target_relative_path: targetRelativePath,
    },
  };
}

const BUILDERS = {
  'audio-offline-verify': buildAudioOfflineVerify,
  'mac-dell-staging': buildMacDellStaging,
};

const DEFAULT_DEPS = { readFileSync: __defaultReadFileSync, statSync: __defaultStatSync, createHash: __defaultCreateHash };

export function buildCapabilityInput(capabilityId, objective, deps) {
  const d = deps || DEFAULT_DEPS;
  const builder = BUILDERS[capabilityId];
  if (!builder) return refuse(INPUT_BUILDER_CODES.UNSUPPORTED, 'no input builder is registered for capability ' + capabilityId);
  return builder(objective, d);
}

export function hasInputBuilder(capabilityId) {
  return Object.prototype.hasOwnProperty.call(BUILDERS, capabilityId);
}
