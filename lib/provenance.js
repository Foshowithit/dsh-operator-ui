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
// WHAT THIS MODULE IS, AND WHAT IT IS NOT
//
// It is a READER. It reports what the artifact itself carries. It never
// invents a commit, never falls back to "the current HEAD of some checkout",
// and never treats "unknown" as "fine".
//
//   source_commit IDENTIFIED — the artifact carries `gitHead`, injected by npm
//                              at pack time from the branch that was packed.
//   source_commit ABSENT     — the artifact carries no commit. Reported loudly.
//                              The fix is to pack from a branch, not to guess.
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
 * The provenance record the artifact carries about itself.
 *
 * @returns {{
 *   schema: number, artifact: 'runtime', package: string|null, package_version: string|null,
 *   source_commit: string|null, source_commit_state: 'IDENTIFIED'|'ABSENT'|'UNKNOWN',
 *   certified_by_gate_version: number, compatibility_pin: string, tools_range: string,
 *   node_range: string|null, manifest_error: string|null
 * }}
 */
export function provenanceRecord({ root = pluginRoot() } = {}) {
  const { pkg, error } = readOwnPackage(root);
  const gitHead = pkg && typeof pkg.gitHead === 'string' && pkg.gitHead.trim()
    ? pkg.gitHead.trim()
    : null;
  return {
    schema: PROVENANCE_SCHEMA,
    // The source/release side ships the gate and the full suite; this package is
    // the runtime half. Naming which half this is stops a consumer reading
    // `verify` output from believing it certifies the source tree.
    artifact: 'runtime',
    package: pkg && typeof pkg.name === 'string' ? pkg.name : null,
    package_version: pkg && typeof pkg.version === 'string' ? pkg.version : null,
    source_commit: gitHead,
    source_commit_state: error ? 'UNKNOWN' : (gitHead ? 'IDENTIFIED' : 'ABSENT'),
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
  if (record.source_commit_state === 'ABSENT') {
    return {
      state: 'UNIDENTIFIED',
      ok: false,
      headline: 'artifact provenance: NO SOURCE COMMIT',
      detail: 'This package carries no `gitHead`, so the installed bytes cannot be tied to a commit. '
        + 'That is what packing from a detached worktree produces. Pack from a branch, or inject the commit '
        + 'explicitly, before treating this artifact as a release candidate.',
    };
  }
  return {
    state: 'IDENTIFIED',
    ok: true,
    headline: 'artifact provenance: ' + record.package + '@' + record.package_version
      + ' from commit ' + String(record.source_commit).slice(0, 12),
    detail: null,
  };
}

/** The name the DSH profile registers this plugin under. */
export function registeredName(record) {
  return (record && record.package) || PKG_NAME;
}
