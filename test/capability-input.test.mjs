// test/capability-input.test.mjs — the bounded capability-input builder.
//
// Load-bearing properties proven here:
//   - audio-offline-verify builds {probes:[{name,file}]} from an objective path
//   - mac-dell-staging builds a CONTRACT-VALID input: the exact five required
//     fields of the capability's declared contract, with a sha256 and base64
//     DERIVED FROM THE REAL FILE (not invented) — an input of `{action, source}`
//     would be refused by the adapter and make a promoted capability unreachable
//   - the builder REFUSES (never guesses) on a missing/empty/directory/oversize
//     source, and honours the 8 MiB staging bound
//   - rollback needs NO source file (it identifies a staged copy by id)
//   - an unsupported capability refuses with a named code
//
// deps are injected so no real filesystem is touched and the hash is checkable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCapabilityInput, hasInputBuilder, extractCandidateFiles, INPUT_BUILDER_CODES } from '../lib/capability-input.js';

// A deterministic fake fs: readFileSync returns registered bytes; statSync
// reports directories for paths ending in '/'.
function fakeDeps({ files = {}, dirs = [] } = {}) {
  return {
    readFileSync: (p) => {
      if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return Buffer.from(files[p]);
    },
    statSync: (p) => ({ isDirectory: () => dirs.includes(p) }),
    createHash,
  };
}

const MAC_DELL_REQUIRED = ['action', 'staging_id', 'content_b64', 'content_sha256', 'target_relative_path'];

test('extractCandidateFiles finds absolute paths WITH an extension only', () => {
  // /etc/passwd has no extension and is correctly NOT a candidate; a relative
  // path is never a candidate.
  const f = extractCandidateFiles('check /tmp/a.mp4 and /etc/passwd and not/relative.txt and /tmp/b.json');
  assert.deepEqual(f, ['/tmp/a.mp4', '/tmp/b.json']);
});

test('audio-offline-verify builds probes from an absolute media path', () => {
  const r = buildCapabilityInput('audio-offline-verify', 'verify /tmp/clip.mp4 has audio');
  assert.equal(r.ok, true);
  assert.equal(r.args.probes.length, 1);
  assert.equal(r.args.probes[0].file, '/tmp/clip.mp4');
  assert.equal(r.args.probes[0].name, 'clip');
});

test('audio-offline-verify refuses with no file path', () => {
  const r = buildCapabilityInput('audio-offline-verify', 'check the audio please');
  assert.equal(r.ok, false);
  assert.equal(r.code, INPUT_BUILDER_CODES.MISSING_FILE);
});

test('mac-dell-staging stage output carries EXACTLY the contract required fields', () => {
  const bytes = Buffer.from('rcos staging payload\n');
  const deps = fakeDeps({ files: { '/tmp/src.bin': bytes } });
  const r = buildCapabilityInput('mac-dell-staging', 'stage /tmp/src.bin into test-fixtures/src.bin', deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  const args = r.args;
  for (const k of MAC_DELL_REQUIRED) assert.ok(k in args, 'missing contract field ' + k);
  // no extra fields — the contract is additionalProperties:false
  assert.deepEqual(Object.keys(args).sort(), [...MAC_DELL_REQUIRED].sort());
  assert.equal(args.action, 'stage');
  assert.equal(args.content_sha256, createHash('sha256').update(bytes).digest('hex'), 'sha256 must be derived from the real bytes');
  assert.equal(Buffer.from(args.content_b64, 'base64').toString(), bytes.toString(), 'content_b64 must round-trip the real bytes');
  assert.equal(args.target_relative_path, 'test-fixtures/src.bin');
});

test('mac-dell-staging default target is a contained test-fixtures path from the basename', () => {
  const deps = fakeDeps({ files: { '/tmp/x.bin': Buffer.from('x') } });
  const r = buildCapabilityInput('mac-dell-staging', 'stage /tmp/x.bin', deps);
  assert.equal(r.ok, true);
  assert.equal(r.args.target_relative_path, 'test-fixtures/x.bin');
});

test('mac-dell-staging refuses a missing source (never invents a hash)', () => {
  const r = buildCapabilityInput('mac-dell-staging', 'stage /tmp/absent.bin', fakeDeps({}));
  assert.equal(r.ok, false);
  assert.equal(r.code, INPUT_BUILDER_CODES.MISSING_FILE);
});

test('mac-dell-staging refuses a directory source', () => {
  // A directory with an extension-looking name still resolves as a candidate,
  // and the stat-first check refuses it as the WRONG KIND of thing (BAD_FILE),
  // not as unreadable.
  const r = buildCapabilityInput('mac-dell-staging', 'stage /tmp/adir.bin', fakeDeps({ dirs: ['/tmp/adir.bin'] }));
  assert.equal(r.ok, false);
  assert.equal(r.code, INPUT_BUILDER_CODES.BAD_FILE);
});

test('mac-dell-staging refuses an empty source', () => {
  const r = buildCapabilityInput('mac-dell-staging', 'stage /tmp/empty.bin', fakeDeps({ files: { '/tmp/empty.bin': Buffer.alloc(0) } }));
  assert.equal(r.ok, false);
  assert.equal(r.code, INPUT_BUILDER_CODES.BAD_FILE);
});

test('mac-dell-staging refuses a source over the 8 MiB bound', () => {
  const r = buildCapabilityInput('mac-dell-staging', 'stage /tmp/big.bin', fakeDeps({ files: { '/tmp/big.bin': Buffer.alloc(8 * 1024 * 1024 + 1) } }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'input-file-too-large');
});

test('mac-dell-staging rollback needs NO file — it identifies a staged copy by id', () => {
  const r = buildCapabilityInput('mac-dell-staging', 'rollback staging_id my-staged-copy', fakeDeps({}));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.args, { action: 'rollback', staging_id: 'my-staged-copy' });
});

test('mac-dell-staging rollback without an id refuses', () => {
  const r = buildCapabilityInput('mac-dell-staging', 'please rollback now', fakeDeps({}));
  assert.equal(r.ok, false);
  assert.equal(r.code, INPUT_BUILDER_CODES.BAD_FILE);
});

test('mac-dell-staging publish honours an explicit target marker', () => {
  const deps = fakeDeps({ files: { '/tmp/p.bin': Buffer.from('p') } });
  const r = buildCapabilityInput('mac-dell-staging', 'publish /tmp/p.bin into docs/p.bin', deps);
  assert.equal(r.ok, true);
  assert.equal(r.args.action, 'publish');
  assert.equal(r.args.target_relative_path, 'docs/p.bin');
});

test('an unsupported capability refuses with a named code', () => {
  const r = buildCapabilityInput('no-such-cap', 'do a thing to /tmp/a.bin');
  assert.equal(r.ok, false);
  assert.equal(r.code, INPUT_BUILDER_CODES.UNSUPPORTED);
});

test('hasInputBuilder reports the registered builders', () => {
  assert.equal(hasInputBuilder('audio-offline-verify'), true);
  assert.equal(hasInputBuilder('mac-dell-staging'), true);
  assert.equal(hasInputBuilder('nope'), false);
});

test('a path with shell metacharacters is not extracted as a candidate', () => {
  const f = extractCandidateFiles('stage /tmp/a.mp4;rm -rf / and /tmp/ok.mp4');
  assert.ok(f.includes('/tmp/ok.mp4'));
  assert.ok(!f.some((p) => p.includes(';')));
});
