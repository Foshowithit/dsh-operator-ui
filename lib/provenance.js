// dsh-operator-ui — artifact provenance (D0/D4 distribution half).
//
// WHY THIS EXISTS
//
// The D0 evidence for 0.11.0 found that the packed artifact carried NO source
// commit: `npm pack` run from a DETACHED worktree does not inject `gitHead`, so
// the tarball could not say which commit it came from. A distribution loop that
// cannot identify the artifact it published cannot close — D4 asks that the
// published bytes correspond to a certified release, and "corresponds to" needs
// a name for the thing on the left.
//
// A CORRECTION, MEASURED 2026-09-26: the first reading of that finding was that
// packing from a BRANCH would fix it. It does not. `npm pack` on npm 10.9.7
// injects no `gitHead` from a detached worktree, from an attached branch, or via
// `npm publish --dry-run` — the packed manifest has no commit field in all three
// cases (measured: `gitHead: None` in the tarball's package.json, with HEAD on
// refs/heads/rcos-cloud-path-v1). So there is no npm-native mechanism to rely on
// here, and the commit has to be injected into the artifact EXPLICITLY at pack
// time. Until that injection exists, this module reports ABSENT — which is the
// honest answer, and the reason `verify` on an uninjected artifact says
// UNVERIFIED rather than claiming a certified release.
//
// THE EXPLICIT INJECTION (landed 2026-09-26)
//
// Since npm supplies nothing, `scripts/pack.mjs` writes the commit into the
// artifact itself, at pack time, into a SHIPPED file: `lib/build-provenance.json`.
// The injection happens in a detached staging worktree created for the pack —
// never in the source tree — so no tracked file is ever edited to build a
// release, and the tree stays clean for the gate.
//
// WHAT THIS MODULE IS, AND WHAT IT IS NOT
//
// It is a READER. It reports what the artifact itself carries. It never
// invents a commit, never falls back to "the current HEAD of some checkout",
// and never treats "unknown" as "fine".
//
//   VERIFIED      — the artifact carries `lib/build-provenance.json`, and that
//                   record is well-formed, complete, and agrees with the
//                   manifest it ships inside. This is the claim `PROVENANCE
//                   VERIFIED`: the installed bytes name their own source commit
//                   and the gate version that certified them.
//   IDENTIFIED    — no build provenance, but the manifest carries `gitHead`.
//                   (npm never writes one on this toolchain; kept because a
//                   reader must not discard evidence it is handed.)
//   UNIDENTIFIED  — the artifact carries no commit from any source. Reported
//                   loudly. The fix is to pack with `scripts/pack.mjs`.
//   UNKNOWN       — the manifest itself could not be read.
//   INVALID       — build provenance IS present but contradicts its own manifest
//                   (wrong package, wrong version, malformed, truncated). This
//                   is the tamper/truncation state, and it must never collapse
//                   into UNIDENTIFIED: "no record" and "a record that lies" are
//                   different findings with different remedies.
//
// `certified_by_gate_version` is the one value the runtime package cannot read
// from itself: `scripts/gate.mjs` is deliberately NOT shipped (the certification
// instrument and the certified product stay separate). So the runtime mirrors the
// number here and `scripts/check.js` asserts the two agree — the same
// cannot-drift-without-a-red-test pattern `lib/compat.js` uses for the COMPAT.md
// pin. A mirror without that leg would be exactly the stale-comment failure this
// repo keeps removing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PINNED_DSH, PINNED_TOOLS_RANGE, PKG_NAME, pluginRoot } from './compat.js';

export const PROVENANCE_SCHEMA = 1;

/** Mirrors `GATE_VERSION` in scripts/gate.mjs. check.js asserts they agree. */
export const CERTIFIED_BY_GATE_VERSION = 3;

/** The shipped file `scripts/pack.mjs` injects. Path is relative to the package root. */
export const BUILD_PROVENANCE_FILE = 'lib/build-provenance.json';

/** The schema version of the injected file. Bump only with a reader change. */
export const BUILD_PROVENANCE_SCHEMA = 1;

/**
 * Read the package.json this module is shipped inside.
 *
 * Never throws on a malformed or missing file: an unreadable own-manifest is a
 * reportable state (it makes every downstream judgement UNKNOWN), not a crash —
 * the same rule lib/config.js follows for an invalid operator config.
 */
export function readOwnPackage(root = pluginRoot()) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return { pkg, error: null };
  } catch (e) {
    return { pkg: null, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Read the pack-time provenance file the artifact carries.
 *
 * Three outcomes, kept distinct on purpose — this is the same typed-read
 * discipline `lib/goal.js` applies to external records, and for the same reason:
 * "there is no record" and "the record could not be read" are different facts.
 *
 *   { present: false, record: null, error: null }   — no such file
 *   { present: true,  record: {...}, error: null }  — a JSON object
 *   { present: true,  record: null, error: '...' }  — present but unreadable / not an object
 */
export function readBuildProvenance(root = pluginRoot()) {
  let raw;
  try {
    raw = readFileSync(join(root, BUILD_PROVENANCE_FILE), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { present: false, record: null, error: null };
    return { present: true, record: null, error: e && e.message ? e.message : String(e) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { present: true, record: null, error: 'not valid JSON: ' + (e && e.message ? e.message : String(e)) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { present: true, record: null, error: 'not a JSON object' };
  }
  return { present: true, record: parsed, error: null };
}

const COMMIT_RE = /^[0-9a-f]{40}$/;

/**
 * Judge the injected build-provenance record.
 *
 * The hard test is INTERNAL CONSISTENCY, not agreement with this runtime's
 * constants. A record that says `package_version: 9.9.9` inside a package whose
 * manifest says `0.11.0` is self-contradictory — tampered or truncated — and that
 * is a refusal. A record that names an OLDER gate version or an older
 * compatibility pin is not a lie; it is an older artifact, and downgrading it to
 * a refusal would make every previously-certified release unverifiable the moment
 * a constant moves. Those become `notes`.
 *
 * @returns {{ state: 'VERIFIED'|'ABSENT'|'INVALID', ok: boolean, problems: string[], notes: string[], record: object|null }}
 */
export function judgeBuildProvenance(bp, pkg) {
  const empty = { problems: [], notes: [], record: null };
  if (!bp || !bp.present) {
    return { ...empty, state: 'ABSENT', ok: false, problems: ['the artifact carries no ' + BUILD_PROVENANCE_FILE] };
  }
  if (bp.error || !bp.record) {
    return { ...empty, state: 'INVALID', ok: false, problems: [BUILD_PROVENANCE_FILE + ' is unreadable: ' + String(bp.error)] };
  }
  const r = bp.record;
  const problems = [];
  const notes = [];

  if (!Number.isInteger(r.schema) || r.schema < 1 || r.schema > BUILD_PROVENANCE_SCHEMA) {
    problems.push('schema ' + JSON.stringify(r.schema) + ' is not a known version (reader knows up to ' + BUILD_PROVENANCE_SCHEMA + ')');
  }
  if (typeof r.source_commit !== 'string' || !COMMIT_RE.test(r.source_commit)) {
    problems.push('source_commit is not a 40-hex commit: ' + JSON.stringify(r.source_commit));
  }
  if (!pkg) {
    notes.push('the manifest could not be read, so the record could not be cross-checked against it');
  } else {
    if (r.package !== pkg.name) problems.push('package ' + JSON.stringify(r.package) + ' != the manifest it ships inside (' + JSON.stringify(pkg.name) + ')');
    if (r.package_version !== pkg.version) problems.push('package_version ' + JSON.stringify(r.package_version) + ' != the manifest it ships inside (' + JSON.stringify(pkg.version) + ')');
  }
  if (r.certified_by_gate_version !== CERTIFIED_BY_GATE_VERSION) {
    notes.push('certified by gate v' + JSON.stringify(r.certified_by_gate_version) + '; this runtime mirrors v' + CERTIFIED_BY_GATE_VERSION);
  }
  if (r.compatibility_pin !== PINNED_DSH) {
    notes.push('packed against DSH pin ' + JSON.stringify(r.compatibility_pin) + '; this runtime pins ' + PINNED_DSH);
  }

  return { state: problems.length ? 'INVALID' : 'VERIFIED', ok: problems.length === 0, problems, notes, record: r };
}

/**
 * The provenance record the artifact carries about itself.
 *
 * @returns {{
 *   schema: number, artifact: 'runtime', package: string|null, package_version: string|null,
 *   source_commit: string|null, source_commit_origin: 'build-provenance'|'manifest-gitHead'|null,
 *   source_commit_state: 'IDENTIFIED'|'ABSENT'|'UNKNOWN',
 *   build_provenance: object, certified_by_gate_version: number, compatibility_pin: string,
 *   tools_range: string, node_range: string|null, manifest_error: string|null
 * }}
 */
export function provenanceRecord({ root = pluginRoot() } = {}) {
  const { pkg, error } = readOwnPackage(root);
  const gitHead = pkg && typeof pkg.gitHead === 'string' && pkg.gitHead.trim()
    ? pkg.gitHead.trim()
    : null;
  const bp = readBuildProvenance(root);
  const bv = judgeBuildProvenance(bp, pkg);
  const injected = bv.record && typeof bv.record.source_commit === 'string' ? bv.record.source_commit : null;
  const commit = injected || gitHead;
  return {
    schema: PROVENANCE_SCHEMA,
    // The source/release side ships the gate and the full suite; this package is
    // the runtime half. Naming which half this is stops a consumer reading
    // `verify` output from believing it certifies the source tree.
    artifact: 'runtime',
    package: pkg && typeof pkg.name === 'string' ? pkg.name : null,
    package_version: pkg && typeof pkg.version === 'string' ? pkg.version : null,
    source_commit: commit,
    source_commit_origin: injected ? 'build-provenance' : (gitHead ? 'manifest-gitHead' : null),
    source_commit_state: error ? 'UNKNOWN' : (commit ? 'IDENTIFIED' : 'ABSENT'),
    build_provenance: {
      present: bp.present,
      read_error: bp.error,
      state: bv.state,
      problems: bv.problems,
      notes: bv.notes,
      record: bv.record,
    },
    certified_by_gate_version: CERTIFIED_BY_GATE_VERSION,
    compatibility_pin: PINNED_DSH,
    tools_range: PINNED_TOOLS_RANGE,
    node_range: pkg && pkg.engines && typeof pkg.engines.node === 'string' ? pkg.engines.node : null,
    manifest_error: error,
  };
}

/** Judge whether the artifact can identify its own source. */
export function judgeProvenance(record) {
  if (!record || record.source_commit_state === 'UNKNOWN') {
    return {
      state: 'UNKNOWN',
      ok: false,
      headline: 'artifact provenance: UNKNOWN',
      detail: 'The package manifest could not be read'
        + (record && record.manifest_error ? ' (' + record.manifest_error + ')' : '')
        + ', so this artifact cannot identify its own version or source commit.',
    };
  }

  const bp = record.build_provenance || { present: false, state: 'ABSENT', problems: [], notes: [] };

  // A record that LIES outranks a missing record: it is the tamper signal, and
  // it must not be reported as "no provenance".
  if (bp.present && bp.state === 'INVALID') {
    return {
      state: 'INVALID',
      ok: false,
      claim: 'PROVENANCE INVALID',
      headline: 'artifact provenance: INVALID',
      detail: 'The artifact carries ' + BUILD_PROVENANCE_FILE + ' but it contradicts the package it ships inside: '
        + bp.problems.join('; ')
        + '. A self-contradictory provenance record is treated as tampering or truncation, not as absent provenance.',
      problems: bp.problems,
      notes: bp.notes || [],
    };
  }

  if (bp.present && bp.state === 'VERIFIED') {
    return {
      state: 'VERIFIED',
      ok: true,
      claim: 'PROVENANCE VERIFIED',
      headline: 'artifact provenance: VERIFIED — ' + record.package + '@' + record.package_version
        + ' from commit ' + String(record.source_commit).slice(0, 12),
      detail: null,
      problems: [],
      notes: bp.notes || [],
    };
  }

  if (record.source_commit_state === 'ABSENT') {
    return {
      state: 'UNIDENTIFIED',
      ok: false,
      claim: 'PROVENANCE ABSENT',
      headline: 'artifact provenance: NO SOURCE COMMIT',
      detail: 'This package carries neither ' + BUILD_PROVENANCE_FILE + ' nor a `gitHead`, so the installed bytes '
        + 'cannot be tied to a commit. No npm mechanism supplies one (measured on npm 10.9.7: neither a detached '
        + 'worktree, nor an attached branch, nor `npm publish --dry-run` writes a commit field), so the commit must '
        + 'be injected explicitly at pack time. Pack with `scripts/pack.mjs`; until then this artifact is not a '
        + 'release candidate.',
      problems: bp.problems || [],
      notes: bp.notes || [],
    };
  }
  return {
    state: 'IDENTIFIED',
    ok: true,
    claim: 'PROVENANCE PARTIAL',
    headline: 'artifact provenance: ' + record.package + '@' + record.package_version
      + ' from commit ' + String(record.source_commit).slice(0, 12),
    detail: 'Identified from the manifest\'s own `gitHead`, not from an injected record — this artifact was not '
      + 'packed by `scripts/pack.mjs`, so it names a commit but carries no gate/pin certification alongside it.',
    problems: [],
    notes: bp.notes || [],
  };
}

/** The name the DSH profile registers this plugin under. */
export function registeredName(record) {
  return (record && record.package) || PKG_NAME;
}
