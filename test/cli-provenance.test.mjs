// Provenance: can the artifact name the commit it came from?
//
// The D0 finding this pins: `npm pack` from a DETACHED worktree injects no
// `gitHead`, so the tarball could not identify its source commit. The dangerous
// response is a fallback — "assume the current HEAD" — which would make an
// unidentified artifact indistinguishable from an identified one. These tests
// exist to prove the module refuses to do that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provenanceRecord, judgeProvenance, PROVENANCE_SCHEMA, CERTIFIED_BY_GATE_VERSION } from '../lib/provenance.js';
import { PINNED_DSH } from '../lib/compat.js';
import { GATE_VERSION } from '../scripts/gate.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'opui-prov-'));

function fixture(pkg) {
  const dir = tmp();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  return dir;
}

test('provenance: a manifest carrying gitHead identifies its source commit', () => {
  const root = fixture({ name: 'dsh-operator-ui', version: '0.11.0', gitHead: 'a'.repeat(40), engines: { node: '>=22' } });
  const rec = provenanceRecord({ root });
  assert.equal(rec.source_commit_state, 'IDENTIFIED');
  assert.equal(rec.source_commit, 'a'.repeat(40));
  assert.equal(rec.artifact, 'runtime', 'the record must say which half of the project this is');
  assert.equal(rec.package_version, '0.11.0');
  const v = judgeProvenance(rec);
  assert.equal(v.state, 'IDENTIFIED');
  assert.equal(v.ok, true);
  rmSync(root, { recursive: true, force: true });
});

test('provenance: a manifest with no gitHead is ABSENT, and is never guessed', () => {
  const root = fixture({ name: 'dsh-operator-ui', version: '0.11.0' });
  const rec = provenanceRecord({ root });
  assert.equal(rec.source_commit, null);
  assert.equal(rec.source_commit_state, 'ABSENT');
  const v = judgeProvenance(rec);
  assert.equal(v.state, 'UNIDENTIFIED');
  assert.equal(v.ok, false, 'an artifact that cannot name its commit must not be reported ok');
  assert.match(v.detail, /detached worktree/);
  rmSync(root, { recursive: true, force: true });
});

test('provenance: an unreadable manifest is UNKNOWN, not ABSENT and not ok', () => {
  const root = fixture('{ not json at all');
  const rec = provenanceRecord({ root });
  assert.equal(rec.source_commit_state, 'UNKNOWN');
  assert.ok(rec.manifest_error, 'the read failure must be carried, not swallowed');
  assert.equal(judgeProvenance(rec).ok, false);
  rmSync(root, { recursive: true, force: true });
});

test('provenance: a missing manifest is UNKNOWN rather than a crash', () => {
  const root = tmp();
  const rec = provenanceRecord({ root });
  assert.equal(rec.source_commit_state, 'UNKNOWN');
  assert.equal(rec.package_version, null);
  assert.equal(judgeProvenance(rec).ok, false);
  rmSync(root, { recursive: true, force: true });
});

test('provenance: a whitespace-only gitHead does not count as a commit', () => {
  const root = fixture({ name: 'dsh-operator-ui', version: '0.11.0', gitHead: '   ' });
  const rec = provenanceRecord({ root });
  assert.equal(rec.source_commit, null);
  assert.equal(rec.source_commit_state, 'ABSENT');
  rmSync(root, { recursive: true, force: true });
});

test('provenance: the three states stay distinct', () => {
  const a = fixture({ name: 'x', version: '1.0.0', gitHead: 'b'.repeat(40) });
  const b = fixture({ name: 'x', version: '1.0.0' });
  const c = fixture('{');
  const states = new Set([
    judgeProvenance(provenanceRecord({ root: a })).state,
    judgeProvenance(provenanceRecord({ root: b })).state,
    judgeProvenance(provenanceRecord({ root: c })).state,
  ]);
  assert.equal(states.size, 3, 'IDENTIFIED / UNIDENTIFIED / UNKNOWN must never collapse');
  for (const d of [a, b, c]) rmSync(d, { recursive: true, force: true });
});

test('provenance: the record carries the certification facts the release needs', () => {
  const rec = provenanceRecord();
  assert.equal(rec.schema, PROVENANCE_SCHEMA);
  assert.equal(rec.compatibility_pin, PINNED_DSH);
  assert.equal(typeof rec.tools_range, 'string');
  assert.equal(rec.certified_by_gate_version, CERTIFIED_BY_GATE_VERSION);
  // The artifact cannot read scripts/gate.mjs (it is deliberately not shipped),
  // so the number is mirrored — and this leg is what stops the mirror drifting.
  assert.equal(CERTIFIED_BY_GATE_VERSION, GATE_VERSION,
    'lib/provenance.js mirrors the gate version; it has drifted from scripts/gate.mjs');
});

test('provenance: the shipped runtime package contains no certification instrument', async () => {
  // GPT's Ruling 1, as a test rather than a promise: the gate certifies a source
  // TREE together with its test environment, and the runtime package does not
  // contain that environment. If `files` ever grows to include it, the published
  // `verify` would look like it could reproduce source certification.
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const shipped = pkg.files;
  assert.ok(shipped.includes('bin'), 'the runtime surface must ship');
  assert.ok(!shipped.some((f) => /scripts|test|eval/.test(f)),
    'the certification instrument (scripts/, test/, eval/) must not ship: ' + JSON.stringify(shipped));
});
