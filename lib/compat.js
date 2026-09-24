// dsh-operator-ui — version compatibility guard.
//
// WHY THIS EXISTS
//
// Before this module the plugin had no host-version signal AT ALL. `probeDsh()`
// returned `version: null` with the comment "version exposure deferred to
// Slice 2", and `probeTools()` returned `version: null` too. The consequence
// was measured, not assumed: the same plugin booted under the COMPAT.md pin
// (DSH 0.1.0-rc.6) and under npm latest (DSH 0.1.5-rc.3) and produced
// status payloads that were BYTE-IDENTICAL apart from timestamps, paths and
// hashes. A verified installation and an unverified one were indistinguishable
// on every surface the operator could look at.
//
// WHAT THIS MODULE CLAIMS, AND WHAT IT DELIBERATELY DOES NOT
//
// Three states, never collapsed (the same rule status.js already follows):
//   VERIFIED   — the host version IS the COMPAT.md pin.
//   UNVERIFIED — a host version was detected and it is NOT the pin.
//   UNKNOWN    — no host version could be determined.
//
// UNVERIFIED and UNKNOWN are reported loudly. They are NOT a refusal, because
// a refusal needs proof of breakage and we do not have it: the live A/B boot
// of 0.1.5-rc.3 showed the plugin loading and serving normally. Refusing on a
// hunch would trade a real defect (no signal) for a worse one (false alarm).
// The verdict travels on every status surface instead, so the operator sees it
// before they trust the install.
//
// THE ONE STRUCTURAL FACT WE CAN STATE PLAINLY
//
// `@deepseek-ai/dsh-tools: ^0.1.0-rc.8` accepts exactly one published
// version — `0.1.0-rc.8` — and nothing else, because node-semver only lets a
// prerelease satisfy a set that carries a comparator on the SAME
// [major,minor,patch] tuple. Every later rc (0.1.1-rc.2 … 0.1.7-rc.2) and the
// `latest` dist-tag (0.0.1-rc.1) are rejected. That is measured against npm in
// test/compat.test.mjs, not asserted here.
//
// NO DEPENDENCIES. The plugin ships exactly one runtime dependency
// (@solarisdk/sandbox); pulling in `semver` for six comparisons would be a
// heavy price for a guard, so the comparator is implemented here and pinned to
// npm's answers by the test table. If node-semver's rules ever change, the
// table fails and names the row.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ------------------------------------------------------------------ pins
//
// COMPAT.md is the source of truth for the tested combination; these are its
// values mirrored into code so a runtime check cannot drift from the document
// without a contract-test leg noticing (scripts/check.js reads COMPAT.md and
// asserts they agree).

export const PINNED_DSH = '0.1.0-rc.6';
export const PINNED_TOOLS_RANGE = '^0.1.0-rc.8';
export const PKG_NAME = 'dsh-operator-ui';

const DSH_PKG = '@deepseek-ai/dsh';
const TOOLS_PKG = '@deepseek-ai/dsh-tools';

// ------------------------------------------------------------------ semver

const VERSION_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Parse a semver string. Returns {major, minor, patch, prerelease} or null.
 * `prerelease` is null when absent (which is what makes 1.0.0 > 1.0.0-rc.1),
 * otherwise an array of identifiers with purely-numeric ones as numbers.
 */
export function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const m = VERSION_RE.exec(input.trim());
  if (!m) return null;
  const pre = m[4] === undefined
    ? null
    : m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: pre };
}

function comparePrerelease(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;   // a release outranks any of its prereleases
  if (b === null) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;   // fewer fields ranks lower
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = typeof x === 'number';
    const yn = typeof y === 'number';
    if (xn && yn) return x < y ? -1 : 1;
    if (xn) return -1;                // numeric identifiers sort before alphanumerics
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** -1 / 0 / 1. Accepts strings or parsed objects. NaN if either is unparseable. */
export function compareVersions(a, b) {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  if (!x || !y) return NaN;
  if (x.major !== y.major) return x.major < y.major ? -1 : 1;
  if (x.minor !== y.minor) return x.minor < y.minor ? -1 : 1;
  if (x.patch !== y.patch) return x.patch < y.patch ? -1 : 1;
  return comparePrerelease(x.prerelease, y.prerelease);
}

// `^` upper bound follows node-semver's 0.x rule: a caret on 0.y.z may not
// cross into 0.(y+1).0, so ^0.1.0-rc.8 is >=0.1.0-rc.8 <0.2.0.
function caretBound(v) {
  if (v.major > 0) return { major: v.major + 1, minor: 0, patch: 0, prerelease: null };
  if (v.minor > 0) return { major: 0, minor: v.minor + 1, patch: 0, prerelease: null };
  return { major: 0, minor: 0, patch: v.patch + 1, prerelease: null };
}

function comparatorsFor(token) {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token.trim());
  if (!m) return null;
  const op = m[1] || '=';
  const ver = parseVersion(m[2]);
  if (!ver) return null;
  if (op === '^') return [{ op: '>=', ver }, { op: '<', ver: caretBound(ver) }];
  if (op === '~') return [{ op: '>=', ver }, { op: '<', ver: { major: ver.major, minor: ver.minor + 1, patch: 0, prerelease: null } }];
  return [{ op, ver }];
}

function testSet(v, comps) {
  for (const c of comps) {
    const cmp = compareVersions(v, c.ver);
    if (Number.isNaN(cmp)) return false;
    if (c.op === '>=' && !(cmp >= 0)) return false;
    if (c.op === '>' && !(cmp > 0)) return false;
    if (c.op === '<=' && !(cmp <= 0)) return false;
    if (c.op === '<' && !(cmp < 0)) return false;
    if (c.op === '=' && cmp !== 0) return false;
  }
  // node-semver's prerelease gate: a version carrying a prerelease may only
  // satisfy a set that contains a comparator on the SAME [major,minor,patch]
  // tuple AND carrying a prerelease of its own. This single rule is why
  // ^0.1.0-rc.8 admits 0.1.0-rc.8 and rejects 0.1.5-rc.3.
  if (v.prerelease !== null) {
    const allowed = comps.some((c) => c.ver.prerelease !== null
      && c.ver.major === v.major
      && c.ver.minor === v.minor
      && c.ver.patch === v.patch);
    if (!allowed) return false;
  }
  return true;
}

/** Does `version` satisfy `range`? Mirrors node-semver's satisfies() for the
 *  comparator shapes this project declares (^, ~, >=, >, <=, <, =, exact, ||). */
export function satisfies(version, range) {
  const v = typeof version === 'string' ? parseVersion(version) : version;
  if (!v) return false;
  if (typeof range !== 'string' || range.trim() === '' || range.trim() === '*') {
    return v.prerelease === null;
  }
  return range.split('||').some((part) => {
    const comps = [];
    for (const token of part.trim().split(/\s+/)) {
      if (!token) continue;
      const parsed = comparatorsFor(token);
      if (!parsed) return false;
      comps.push(...parsed);
    }
    return comps.length > 0 && testSet(v, comps);
  });
}

// ------------------------------------------------------------------ filesystem probes

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function packageSubpath(name) {
  return name.split('/');
}

/** Walk up from `startDir` looking for `name`, either as the directory's own
 *  package.json or nested under its node_modules. Bounded (64 levels) so a
 *  pathological tree cannot spin. Returns {version, dir, how} or null. */
function walkFor(startDir, name) {
  const segments = packageSubpath(name);
  let dir = startDir;
  for (let i = 0; i < 64 && dir; i++) {
    const here = readJson(join(dir, 'package.json'));
    if (here && here.name === name) return { version: here.version || null, dir, how: 'package-ancestor' };
    const nested = readJson(join(dir, 'node_modules', ...segments, 'package.json'));
    if (nested && nested.name === name) {
      return { version: nested.version || null, dir: join(dir, 'node_modules', ...segments), how: 'node_modules' };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Which DSH is this plugin actually running inside?
 *
 * Order matters. `process.argv[1]` is the running CLI entry — under
 * `npx @deepseek-ai/dsh@X web` it sits at .../@deepseek-ai/dsh/lib/bin.js, so
 * walking up finds the REAL installed version rather than a hoped-for one.
 * cwd is the fallback (correct for `dsh` invoked from its install tree).
 * DSH_VERSION is accepted last, and only if it parses: an env var can be
 * stale in a way a package.json on disk cannot.
 *
 * All probes are injectable so the test can drive each one in isolation and
 * prove a detection failure degrades to UNKNOWN rather than inventing a
 * version.
 */
export function detectDshVersion(opts = {}) {
  const env = opts.env || process.env;
  const starts = [];
  const argv1 = opts.argv1 !== undefined ? opts.argv1 : process.argv[1];
  if (argv1) {
    try { starts.push(dirname(resolve(argv1))); } catch { /* ignore */ }
  }
  const cwd = opts.cwd !== undefined ? opts.cwd : process.cwd();
  if (cwd) starts.push(cwd);
  if (Array.isArray(opts.extraDirs)) starts.push(...opts.extraDirs);

  for (const start of starts) {
    if (!start) continue;
    try {
      const hit = walkFor(start, DSH_PKG);
      if (hit && hit.version) {
        return { version: hit.version, source: hit.how, dir: hit.dir, via: start };
      }
    } catch { /* unreadable ancestor — keep walking */ }
  }

  const fromEnv = env.DSH_VERSION;
  if (fromEnv && parseVersion(fromEnv)) {
    return { version: fromEnv.replace(/^v/, ''), source: 'env:DSH_VERSION', dir: null, via: null };
  }
  return { version: null, source: null, dir: null, via: null };
}

/**
 * Which @deepseek-ai/dsh-tools did THIS plugin bind to?
 *
 * Resolved through the plugin's own module graph, which is the copy that
 * `defineTool` in lib/index.js actually imported. Resolution failing is a
 * legitimate state (the peer is OPTIONAL — see COMPAT.md), not an error.
 */
export function detectToolsVersion(opts = {}) {
  const fromFile = opts.fromFile || fileURLToPath(new URL('./index.js', import.meta.url));
  try {
    const req = createRequire(pathToFileURL(fromFile).href);
    const pkgPath = req.resolve(TOOLS_PKG + '/package.json');
    const pkg = readJson(pkgPath);
    if (pkg && pkg.version) return { version: pkg.version, source: pkgPath };
  } catch { /* peer absent — the documented OPTIONAL case */ }
  if (opts.extraDirs) {
    for (const dir of opts.extraDirs) {
      try {
        const hit = walkFor(dir, TOOLS_PKG);
        if (hit && hit.version) return { version: hit.version, source: hit.dir };
      } catch { /* keep looking */ }
    }
  }
  return { version: null, source: null };
}

// ------------------------------------------------------------------ verdicts

/**
 * Judge the HOST DSH. Never blocks: an UNVERIFIED host is reported, not
 * refused — see the module header for why a refusal would be dishonest here.
 *
 *  @returns {{state:'VERIFIED'|'UNVERIFIED'|'UNKNOWN', ok:boolean, headline:string, detail:string}}
 */
export function judgeDsh(version) {
  if (!version) {
    return {
      state: 'UNKNOWN',
      ok: false,
      headline: 'host DSH version: UNKNOWN',
      detail:
        'Could not determine which DSH this plugin is running inside. This build was verified against DSH '
        + PINNED_DSH + ' (COMPAT.md). Compatibility is UNVERIFIED — check `dsh --version` on the host before trusting this install.',
    };
  }
  if (version === PINNED_DSH) {
    return {
      state: 'VERIFIED',
      ok: true,
      headline: 'host DSH ' + version + ': VERIFIED (matches COMPAT.md pin)',
      detail: null,
    };
  }
  return {
    state: 'UNVERIFIED',
    ok: false,
    headline: 'host DSH ' + version + ': UNVERIFIED (pin is ' + PINNED_DSH + ')',
    detail:
      'This host runs DSH ' + version + '; the tested pin is ' + PINNED_DSH + ' (COMPAT.md). The plugin booted, '
      + 'but this combination has not been verified — re-run the COMPAT verification before treating the surfaces below as authoritative.',
  };
}

/**
 * Judge the dsh-tools peer the plugin actually bound to.
 *
 * ABSENT is a legitimate, non-error state: the peer is OPTIONAL and the plugin
 * boots without it (COMPAT.md "What OPTIONAL means here"). MISMATCH is a
 * structural fact — the resolved version does not satisfy the declared range —
 * and is reported as available:false because the plugin's own peer contract is
 * being violated, even though the import succeeded.
 */
export function judgeTools(version) {
  if (!version) {
    return {
      state: 'ABSENT',
      ok: true,
      blocking: false,
      headline: '@deepseek-ai/dsh-tools: not installed (OPTIONAL)',
      detail: 'The four browser_* agent tools stay unregistered; every other tab is unaffected.',
    };
  }
  if (satisfies(version, PINNED_TOOLS_RANGE)) {
    return {
      state: 'SATISFIED',
      ok: true,
      blocking: false,
      headline: '@deepseek-ai/dsh-tools ' + version + ' satisfies ' + PINNED_TOOLS_RANGE,
      detail: null,
    };
  }
  return {
    state: 'MISMATCH',
    ok: false,
    blocking: false,
    headline: '@deepseek-ai/dsh-tools ' + version + ' does NOT satisfy ' + PINNED_TOOLS_RANGE,
    detail:
      'The plugin bound dsh-tools ' + version + ' but declares the peer range ' + PINNED_TOOLS_RANGE + '. '
      + 'Under that range only 0.1.0-rc.8 is admitted, so this install is off-pin: the browser_* tools were '
      + 'built against a different dsh-tools than the one the host resolved.',
  };
}

/** One-line boot banner. Kept to a single console line so it survives log
 *  truncation and is greppable (`grep COMPAT`). */
export function bannerLine(verdict) {
  const flag = verdict.state === 'VERIFIED' ? 'ok' : 'COMPAT';
  return '[dsh-operator-ui] ' + flag + ' ' + verdict.headline + (verdict.detail ? ' — ' + verdict.detail : '');
}

/** Full multi-line box for the boot log: unmissable, and it names BOTH
 *  numbers so nobody has to go looking for which side moved. */
export function bannerBox(verdicts) {
  // Only verdicts that actually object earn a banner. A VERIFIED or SATISFIED
  // verdict passed in by a careless caller must stay silent, so the filter
  // lives here rather than at the call site.
  const rows = verdicts.filter((v) => v && v.ok === false)
    .map((v) => '  ' + v.headline + (v.detail ? '\n      ' + v.detail : ''));
  if (rows.length === 0) return null;
  const width = Math.min(96, Math.max(...rows.map((r) => r.length)) + 2);
  return [
    '[dsh-operator-ui] compatibility — this installation is NOT on the tested pin',
    '='.repeat(width),
    ...rows,
    '='.repeat(width),
  ].join('\n');
}

// ------------------------------------------------------------------ plugin root

export function pluginRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * The one call the status surface wants: detect + judge the host DSH in a
 * single object shaped for `components.dsh`.
 */
export function hostCompat(opts = {}) {
  const detected = detectDshVersion(opts);
  const verdict = judgeDsh(detected.version);
  return {
    version: detected.version,
    source: detected.source,
    dir: detected.dir,
    pin: PINNED_DSH,
    state: verdict.state,
    ok: verdict.ok,
    headline: verdict.headline,
    detail: verdict.detail,
  };
}
