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
import {
  provenanceRecord, judgeProvenance, judgeBuildProvenance, readBuildProvenance,
  PROVENANCE_SCHEMA, CERTIFIED_BY_GATE_VERSION, BUILD_PROVENANCE_FILE,
} from '../lib/provenance.js';
import { PINNED_DSH } from '../lib/compat.js';
import { GATE_VERSION } from '../scripts/gate.mjs';
import { buildProvenanceRecord, serialiseProvenance } from '../scripts/pack.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'opui-prov-'));

function fixture(pkg) {
  const dir = tmp();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  return dir;
}

/** A fixture that also carries the pack-time injected record. */
function injected(pkg, prov) {
  const dir = fixture(pkg);
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'lib', 'build-provenance.json'), typeof prov === 'string' ? prov : JSON.stringify(prov));
  return dir;
}

const HONEST = (over = {}) => ({
  schema: 1,
  artifact: 'runtime',
  package: 'dsh-operator-ui',
  package_version: '0.11.0',
  source_commit: 'c'.repeat(40),
  certified_by_gate_version: GATE_VERSION,
  compatibility_pin: PINNED_DSH,
  tools_range: '^0.1.0-rc.8',
  node_range: '>=22',
  ...over,
});

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
  assert.match(v.detail, /injected explicitly at pack time/);
  assert.match(v.detail, /scripts\/pack\.mjs/, 'the refusal must name the instrument that fixes it');
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

// ---------------------------------------------- the injected build record

test('provenance: an injected record that agrees with its manifest is VERIFIED', () => {
  const root = injected({ name: 'dsh-operator-ui', version: '0.11.0' }, HONEST());
  const rec = provenanceRecord({ root });
  assert.equal(rec.build_provenance.present, true);
  assert.equal(rec.build_provenance.state, 'VERIFIED');
  assert.equal(rec.source_commit, 'c'.repeat(40));
  assert.equal(rec.source_commit_origin, 'build-provenance',
    'the commit must be attributed to the injected record, not to an absent gitHead');
  const v = judgeProvenance(rec);
  assert.equal(v.state, 'VERIFIED');
  assert.equal(v.ok, true);
  assert.equal(v.claim, 'PROVENANCE VERIFIED', 'the claim GPT asked verify to report, by name');
  rmSync(root, { recursive: true, force: true });
});

test('provenance: a record that contradicts its own manifest is INVALID, never "absent"', () => {
  // This is the collapse that matters. If tampering read as "no provenance", a
  // rewritten artifact would look like an uncertified one instead of an attacked
  // one — the same typed-read rule lib/goal.js applies to external records.
  const cases = {
    'a version lie': HONEST({ package_version: '9.9.9' }),
    'a package lie': HONEST({ package: 'not-this-package' }),
    'a malformed commit': HONEST({ source_commit: 'deadbeef' }),
    'a missing commit': HONEST({ source_commit: undefined }),
    'an unknown schema': HONEST({ schema: 99 }),
  };
  for (const [label, prov] of Object.entries(cases)) {
    const root = injected({ name: 'dsh-operator-ui', version: '0.11.0' }, prov);
    const v = judgeProvenance(provenanceRecord({ root }));
    assert.equal(v.state, 'INVALID', label + ' must be INVALID, got ' + v.state);
    assert.equal(v.ok, false);
    assert.equal(v.claim, 'PROVENANCE INVALID');
    assert.ok(v.problems.length > 0, label + ' must name what is wrong');
    rmSync(root, { recursive: true, force: true });
  }
});

test('provenance: a corrupt or truncated record is INVALID, not absent', () => {
  for (const raw of ['{ not json', '[]', 'null', '']) {
    const root = injected({ name: 'dsh-operator-ui', version: '0.11.0' }, raw);
    const v = judgeProvenance(provenanceRecord({ root }));
    assert.equal(v.state, 'INVALID', 'raw ' + JSON.stringify(raw) + ' must be INVALID, got ' + v.state);
    rmSync(root, { recursive: true, force: true });
  }
});

test('provenance: an older gate or pin is a NOTE, not a refusal', () => {
  // Deliberate asymmetry. A record naming an older gate version is an older
  // artifact, not a lie; refusing it would make every previously certified
  // release unverifiable the moment a constant moves. Drift is reported.
  const root = injected({ name: 'dsh-operator-ui', version: '0.11.0' },
    HONEST({ certified_by_gate_version: GATE_VERSION - 1, compatibility_pin: '0.0.0-ancient' }));
  const v = judgeProvenance(provenanceRecord({ root }));
  assert.equal(v.state, 'VERIFIED');
  assert.equal(v.ok, true);
  assert.equal(v.notes.length, 2, 'both drifts must be reported as notes: ' + JSON.stringify(v.notes));
  assert.match(v.notes.join(' '), /gate v/);
  assert.match(v.notes.join(' '), /pin/);
  rmSync(root, { recursive: true, force: true });
});

test('provenance: a missing record is ABSENT and does NOT read as tampering', () => {
  const root = fixture({ name: 'dsh-operator-ui', version: '0.11.0' });
  const bp = readBuildProvenance(root);
  assert.equal(bp.present, false);
  assert.equal(bp.error, null, 'a missing file is not a read error — that is the whole distinction');
  assert.equal(judgeBuildProvenance(bp, { name: 'dsh-operator-ui', version: '0.11.0' }).state, 'ABSENT');
  rmSync(root, { recursive: true, force: true });
});

test('provenance: the reader and the writer agree on the injected path', () => {
  const root = injected({ name: 'dsh-operator-ui', version: '0.11.0' }, HONEST());
  assert.ok(BUILD_PROVENANCE_FILE.split('/').length === 2, 'the path is a two-segment package-relative path');
  assert.equal(readBuildProvenance(root).present, true);
  rmSync(root, { recursive: true, force: true });
});

test('provenance: the injected record is a function of the commit alone', () => {
  // The determinism property, at unit level: no clock, no host, no path. Two
  // records built from the same commit serialise to the same bytes even when the
  // caller supplies its keys in a different order — which is exactly what makes
  // the packer's repack witness meaningful.
  const pkg = { name: 'dsh-operator-ui', version: '0.11.0', engines: { node: '>=22' },
    peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.8' } };
  const compatSrc = "export const PINNED_DSH = '" + PINNED_DSH + "';\n";
  const a = buildProvenanceRecord({ pkg, commit: 'd'.repeat(40), gateVersion: GATE_VERSION, compatSrc });
  const b = buildProvenanceRecord({ pkg, commit: 'd'.repeat(40), gateVersion: GATE_VERSION, compatSrc });
  assert.equal(serialiseProvenance(a), serialiseProvenance(b));
  assert.equal(a.compatibility_pin, PINNED_DSH, 'the pin is read out of the packed commit, not retyped');
  // Reordering the record's own keys must not change the bytes: the serialiser
  // owns the order, not the caller.
  const shuffled = {};
  for (const k of Object.keys(a).reverse()) shuffled[k] = a[k];
  assert.equal(serialiseProvenance(shuffled), serialiseProvenance(a));
  assert.ok(serialiseProvenance(a).endsWith('\n'), 'a trailing newline keeps the file byte-stable');
  // And the bytes must be checkable: the record it writes must read back VERIFIED.
  const dir = injected({ name: 'dsh-operator-ui', version: '0.11.0' }, JSON.parse(serialiseProvenance(a)));
  assert.equal(judgeProvenance(provenanceRecord({ root: dir })).state, 'VERIFIED',
    'the packer\'s own serialiser must produce a record the reader accepts');
  rmSync(dir, { recursive: true, force: true });
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
