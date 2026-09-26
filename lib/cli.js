// dsh-operator-ui — the runtime surface: `doctor | install | verify`.
//
// WHY THIS EXISTS (D1–D4, agreed with GPT 2026-09-25)
//
// Until now the only way to put this plugin on a host was the DEVELOPMENT recipe
// in AGENTS.md: an isolated DSH home, `npx @deepseek-ai/dsh plugin add "$PWD"`,
// and the source checkout left sitting there as the thing the profile links to.
// That recipe cannot ship. It assumes a checkout, it assumes the network, and
// nothing about it is transactional or repeatable.
//
// So the published artifact carries a runtime surface instead of a
// certification instrument. GPT's ruling, which this module implements:
//
//   * `scripts/gate.mjs` is NOT shipped. It certifies a SOURCE TREE together
//     with its test environment, and the runtime package deliberately does not
//     contain that environment. Shipping it would offer a consumer a
//     verification command that cannot possibly reproduce source certification.
//   * What IS shipped is `dsh-operator-ui verify` — a DIFFERENT contract. It
//     verifies the INSTALLED PACKAGE/RUNTIME, not the source suite.
//   * `install` is durable, prerequisite-explicit, transactional, idempotent,
//     and able to prove the package works with no source checkout present.
//
// FOUR RULES THIS FILE IS BUILT AROUND
//
// 1. PREFLIGHT BEFORE MUTATION. Every prerequisite is classified before a single
//    byte is written. A missing Archon or a missing registry config must be a
//    refusal that leaves the host exactly as it was — not a half-install that
//    then fails.
//
// 2. NEVER INSTALL THE WORLD. A missing Archon is `BLOCKED: Archon prerequisite
//    unavailable`, with the exact requirement named. The installer does not
//    install or mutate Archon, Node, or DSH. Turning one npm package into a
//    machine bootstrapper with enormous authority is a separate product.
//
// 3. OFF-PIN IS NOT BREAKAGE. An off-pin host DSH reports UNVERIFIED and is
//    recorded in the receipt. It does not refuse: a refusal needs proof of
//    breakage and we do not have it (lib/compat.js documents the measured A/B).
//    Fabricating an incompatibility would trade a real signal for a false alarm.
//
// 4. A CLAIM IS NOT A PLAN. Every state this module reports is derived from a
//    read it actually performed, and every receipt field is a measurement. Where
//    a property cannot be established it says UNKNOWN rather than defaulting to
//    healthy — and the one place the installer cannot prove everything (it loads
//    the plugin half as a module graph; it does not boot a full DSH web server)
//    is named in the receipt rather than glossed.

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync, symlinkSync,
  readdirSync, lstatSync, copyFileSync, renameSync, readlinkSync, chmodSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { resolveConfig, getDshHome } from './config.js';
import { probeArchon, probeRegistry } from './status.js';
import { detectDshVersion, judgeDsh, hostCompat, PINNED_DSH, PKG_NAME, pluginRoot } from './compat.js';
import { provenanceRecord, judgeProvenance, PROVENANCE_SCHEMA } from './provenance.js';

export const CLI_NAME = 'dsh-operator-ui';
export const COMMANDS = ['doctor', 'install', 'verify'];
export const RECEIPT_SCHEMA = 1;
export const INSTALL_RECEIPT_FILE = 'install-receipt.json';
export const DEFAULT_PROFILE = 'web';

// The exit ladder. One ladder for the whole surface, so a caller can branch on
// the code without parsing prose — and so "nothing was mutated" is a code, not a
// sentence someone has to read.
//
//   0  READY | INSTALLED | ALREADY_INSTALLED | VERIFIED
//   1  UNVERIFIED  — everything needed is present, but a property could not be
//                    established (e.g. host DSH is off-pin). The command did
//                    what it was asked; the result is not claim-grade.
//   2  BLOCKED     — a required prerequisite is missing. NOTHING WAS MUTATED.
//   3  FAILED      — a mutation began and was rolled back (or the rollback
//                    itself failed — `rollback.failures` names what).
//   4  USAGE       — bad arguments. Nothing was read or written.
export const EXIT = {
  OK: 0,
  UNVERIFIED: 1,
  BLOCKED: 2,
  FAILED: 3,
  USAGE: 4,
};

export const DOCTOR_VERDICTS = ['READY', 'UNVERIFIED', 'BLOCKED'];
export const VERIFY_VERDICTS = ['VERIFIED', 'UNVERIFIED', 'BLOCKED'];

// ------------------------------------------------------------------ paths

/**
 * The durable install root.
 *
 * Under DSH_HOME on purpose. D1 asks the installed package to survive the
 * installer's execution environment disappearing — an npx temp dir being reaped,
 * the npm cache being cleared, a reboot, or the source checkout being deleted.
 * A path inside the profile's node_modules would survive a reboot but not a
 * package-manager run; a path under DSH_HOME survives all four, and it is the
 * one directory the plugin already owns by contract (AGENTS.md iron rule 2).
 */
export function installRoot({ home, env = process.env } = {}) {
  const override = env.DSH_OPERATOR_UI_INSTALL_ROOT;
  if (typeof override === 'string' && override.trim()) return resolve(override.trim());
  return join(home || getDshHome(), 'operator-ui', 'plugin');
}

export function profileDir(home, profile) {
  return join(home, 'profiles', profile);
}

export function receiptPath(home) {
  return join(home, 'operator-ui', INSTALL_RECEIPT_FILE);
}

// ------------------------------------------------------------------ small helpers

const isoNow = () => new Date().toISOString();

function readJsonFile(file) {
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')), error: null, raw: null };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { value: null, error: null, raw: null, missing: true };
    return { value: null, error: e && e.message ? e.message : String(e), raw: null };
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Recursive file listing, repo-relative, POSIX separators, sorted. */
function listFiles(dir, prefix = '') {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? prefix + '/' + e.name : e.name;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Content identity of a directory's files.
 *
 * Returns { digest, files, bytes }. Two installs are "the same" only when this
 * digest matches — a size comparison would call two different builds of the same
 * version identical, which is precisely the mistake D0 exists to prevent.
 */
export function contentIdentity(dir) {
  const files = listFiles(dir);
  const h = createHash('sha256');
  let bytes = 0;
  for (const rel of files) {
    let buf;
    try { buf = readFileSync(join(dir, ...rel.split('/'))); } catch { continue; }
    bytes += buf.length;
    h.update(rel).update('\0').update(String(buf.length)).update('\0').update(sha256(buf)).update('\n');
  }
  return { digest: h.digest('hex'), files: files.length, bytes };
}

/**
 * The set of files the package declares it ships.
 *
 * `package.json` is always included (npm always packs it), and `files` is read
 * from the manifest rather than restated here: a hardcoded list would silently
 * stop matching the artifact the day someone adds a directory.
 */
export function shippedFiles(pkg) {
  const declared = Array.isArray(pkg && pkg.files) ? pkg.files : [];
  return ['package.json', ...declared].sort();
}

// ------------------------------------------------------------------ dsh binary

/** Resolve the `dsh` executable: env override first, then PATH. Never a shell. */
export function resolveDshBin(env = process.env) {
  const override = env.DSH_OPERATOR_UI_DSH_BIN;
  if (typeof override === 'string' && override.trim()) {
    const p = resolve(override.trim());
    return existsSync(p) ? { path: p, source: 'env:DSH_OPERATOR_UI_DSH_BIN' } : { path: null, source: null };
  }
  const path = env.PATH || '';
  for (const dir of path.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'dsh');
    try {
      if (statSync(candidate).isFile()) return { path: candidate, source: 'PATH' };
    } catch { /* keep scanning */ }
  }
  return { path: null, source: null };
}

function runVersion(bin, timeoutMs = 15000) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: timeoutMs });
  if (r.error) return { ok: false, error: r.error.message, version: null };
  const text = String(r.stdout || '').trim();
  const m = text.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return { ok: r.status === 0, error: r.status === 0 ? null : ('exit ' + r.status), version: m ? m[0] : null };
}

// ------------------------------------------------------------------ registration

/**
 * Read the profile's registration of this plugin.
 *
 * The contract read here is DSH's own, observed on a real profile — not a guess:
 *
 *   profiles/<profile>/package.json
 *     dependencies[<name>] = "link:<abs path>"      ← what makes it resolvable
 *     dsh.profile.bundles   contains <name>          ← what makes the loader compose it
 *   profiles/<profile>/node_modules/<name> -> <abs path>
 *
 * `bundles` is the authoritative half (cordis.yml is empty by design and the
 * tree is composed from the bundle list), so a registration missing from
 * `bundles` is reported as absent even if the dependency entry is present.
 */
export function readRegistration({ home, profile, name }) {
  const dir = profileDir(home, profile);
  const pkgPath = join(dir, 'package.json');
  const { value: pkg, error, missing } = readJsonFile(pkgPath);
  const linkPath = join(dir, 'node_modules', name);
  let symlinkTarget = null;
  let linkExists = false;
  try {
    const st = lstatSync(linkPath);
    linkExists = true;
    if (st.isSymbolicLink()) symlinkTarget = readlinkSync(linkPath);
  } catch { /* no link — reported as unregistered, not as an error */ }

  const depSpec = pkg && pkg.dependencies && typeof pkg.dependencies === 'object'
    ? (pkg.dependencies[name] || null)
    : null;
  const bundles = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)
    ? pkg.dsh.profile.bundles
    : null;

  return {
    profile,
    dir,
    packageJson: pkgPath,
    packageJsonPresent: !!pkg,
    packageJsonError: error,
    packageJsonMissing: !!missing,
    dependencySpec: depSpec,
    inBundles: Array.isArray(bundles) ? bundles.includes(name) : false,
    bundles: bundles || [],
    nodeModulesLink: linkExists,
    linkTarget: symlinkTarget,
    registered: !!(depSpec && Array.isArray(bundles) && bundles.includes(name) && linkExists),
  };
}

/** Does a dependency spec point at exactly this directory? */
export function specTargets(spec, dir) {
  if (typeof spec !== 'string') return false;
  const m = /^(?:link|file):(.+)$/.exec(spec.trim());
  if (!m) return false;
  return resolve(m[1]) === resolve(dir);
}

// ------------------------------------------------------------------ prerequisite checks

/**
 * Classify every prerequisite. Pure read — this function is what makes `doctor`
 * read-only by construction, and what makes `install` refuse before it writes.
 *
 * Each check returns { id, label, requirement, state, blocking, detail }.
 *   state: 'OK' | 'BLOCKED' | 'UNVERIFIED'
 *   blocking: true when its failure must stop a mutation.
 */
export async function prerequisiteChecks({ home, profile, env = process.env, dshBin, resolved, detectDsh = detectDshVersion, archonProbe = probeArchon, registryProbe = probeRegistry }) {
  const checks = [];
  const name = PKG_NAME;

  // --- node -------------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    id: 'node',
    label: 'node runtime',
    requirement: 'node >= 22 (native WebSocket; AbortSignal.timeout)',
    state: major >= 22 ? 'OK' : 'BLOCKED',
    blocking: true,
    detail: { version: process.versions.node, major },
    reason: major >= 22 ? null : 'node ' + process.versions.node + ' is below the required 22 — the supervised browser needs a native WebSocket.',
  });

  // --- dsh binary -------------------------------------------------------
  const bin = dshBin || resolveDshBin(env);
  const ver = bin.path ? runVersion(bin.path) : { ok: false, error: 'not found', version: null };
  checks.push({
    id: 'dsh-binary',
    label: 'dsh executable',
    requirement: 'a `dsh` binary on PATH, or DSH_OPERATOR_UI_DSH_BIN pointing at one',
    state: bin.path && ver.ok ? 'OK' : 'BLOCKED',
    blocking: true,
    detail: { path: bin.path, source: bin.source, reported_version: ver.version },
    reason: bin.path && ver.ok
      ? null
      : 'No usable `dsh` executable: ' + (bin.path ? 'found at ' + bin.path + ' but `dsh --version` failed (' + ver.error + ')' : 'none found on PATH or via DSH_OPERATOR_UI_DSH_BIN') + '.',
  });

  // --- host DSH version -------------------------------------------------
  // Off-pin is UNVERIFIED, never BLOCKED. See rule 3 in the header.
  //
  // `detectDsh` is injectable for the same reason lib/compat.js makes all of its
  // probes injectable: a test that can only observe whatever DSH happens to sit
  // above the current working directory cannot prove the off-pin path exists.
  const detected = detectDsh({ env });
  const hostVerdict = judgeDsh(detected.version);
  const hostState = hostVerdict.state === 'VERIFIED' ? 'OK' : 'UNVERIFIED';
  checks.push({
    id: 'dsh-host',
    label: 'host DSH version',
    requirement: 'DSH ' + PINNED_DSH + ' (the COMPAT.md pin)',
    state: hostState,
    blocking: false,
    detail: { detected: detected.version, source: detected.source, pin: PINNED_DSH, verdict: hostVerdict.state },
    reason: hostState === 'OK' ? null : hostVerdict.headline,
  });

  // --- archon -----------------------------------------------------------
  const archon = resolved ? await archonProbe(resolved) : null;
  const archonOk = !!(archon && archon.state === 'AVAILABLE');
  checks.push({
    id: 'archon',
    label: 'Archon execution adapter',
    requirement: 'an Archon HTTP API answering with the catalog shape at archon.baseUrl',
    state: archonOk ? 'OK' : 'BLOCKED',
    blocking: true,
    detail: archon ? { base_url: archon.detail && archon.detail.baseUrl, source: archon.source, http_status: archon.detail && archon.detail.httpStatus, identity: archon.detail && archon.detail.identity } : null,
    reason: archonOk ? null : (archon ? archon.reason : 'Archon was not probed (no resolved config).'),
  });

  // --- registry ---------------------------------------------------------
  const registry = resolved ? await registryProbe(resolved) : null;
  const registryOk = !!(registry && registry.state === 'AVAILABLE');
  checks.push({
    id: 'registry',
    label: 'capability registry',
    requirement: 'registry.path in operator-ui.config.json pointing at a JSON file with a capabilities[] array',
    state: registryOk ? 'OK' : 'BLOCKED',
    blocking: true,
    detail: registry ? { path: registry.detail && registry.detail.path, source: registry.source, capabilities: registry.detail && registry.detail.capabilities } : null,
    reason: registryOk ? null : (registry ? registry.reason : 'The registry was not probed (no resolved config).'),
  });

  // --- profile ----------------------------------------------------------
  const pdir = profileDir(home, profile);
  const profileExists = existsSync(join(pdir, 'package.json'));
  checks.push({
    id: 'profile',
    label: 'DSH profile',
    requirement: 'a DSH profile directory at $DSH_HOME/profiles/<profile> with a package.json',
    state: profileExists ? 'OK' : 'BLOCKED',
    blocking: true,
    detail: { profile, dir: pdir },
    reason: profileExists ? null : 'No DSH profile at ' + pdir + '. Create it with DSH itself (`dsh --profile ' + profile + ' ...`) — the installer does not create profiles.',
  });

  // --- registration contract -------------------------------------------
  // WHICH DSH VERSION DECIDES MUTATION AUTHORITY?
  //
  // The `dsh` BINARY's own report, not a filesystem walk. The profile this
  // installer writes belongs to the DSH that owns it, and that is the CLI we
  // resolved and executed a moment ago. A walk from the current directory answers
  // "which DSH is above me right now", which is a different and much weaker
  // question — and one whose answer changes with where the command happens to be
  // run from (the frozen-snapshot gate made that concrete). Falling back to the
  // walk only when the binary reports nothing keeps the check honest without
  // making it ambient.
  const binaryVersion = (checks.find((c) => c.id === 'dsh-binary') || {}).detail?.reported_version || null;
  const walkedVersion = (checks.find((c) => c.id === 'dsh-host') || {}).detail?.detected || null;
  const authorityVersion = binaryVersion || walkedVersion;
  const authorityVerdict = judgeDsh(authorityVersion);
  checks.push({
    id: 'registration-contract',
    label: 'direct-registration contract',
    requirement: 'the host DSH reports the verified pin ' + PINNED_DSH,
    // NOT blocking: an off-pin host is UNVERIFIED, not incompatible. `install`
    // reads grants_mutation from this check; `doctor` only reports it.
    state: authorityVerdict.state === 'VERIFIED' ? 'OK' : 'UNVERIFIED',
    blocking: false,
    detail: {
      source: binaryVersion ? 'the `dsh` binary\'s own --version' : (walkedVersion ? 'filesystem walk' : 'none'),
      detected: authorityVersion,
      verified_pin: PINNED_DSH,
      verdict: authorityVerdict.state,
      grants_mutation: authorityVerdict.state === 'VERIFIED',
    },
    reason: authorityVerdict.state === 'VERIFIED' ? null : authorityVerdict.headline,
  });

  const blocking = checks.filter((c) => c.blocking && c.state !== 'OK');
  const unverified = checks.filter((c) => !c.blocking && c.state !== 'OK');
  const verdict = blocking.length ? 'BLOCKED' : (unverified.length ? 'UNVERIFIED' : 'READY');
  return { checks, verdict, blocking, unverified };
}

/**
 * May this host receive the DIRECT registration mutation?
 *
 * WHY THIS IS A SEPARATE GATE, AND NOT A BLOCKING PREREQUISITE
 *
 * The installer writes DSH's persisted profile schema directly (dependency spec
 * + bundle entry + node_modules link) instead of shelling out to
 * `dsh plugin add`. That is justified — the CLI path forwards to pnpm and a cold
 * run spent seven minutes on a corepack download before it could write — but it
 * moves the compatibility boundary: the installer now depends on a PRIVATE
 * persisted schema, not on a public command.
 *
 * So an off-pin or undetectable host must not silently receive that write. Note
 * what this is NOT: it is not a claim that the host is incompatible. `doctor`
 * keeps reporting an off-pin host as UNVERIFIED, because a refusal needs proof of
 * breakage and we do not have it. The rule is narrower than that, and it is
 * GPT's ruling of 2026-09-26:
 *
 *     unknown is not broken — but unknown also does not grant mutation authority.
 *
 * Hence two different aggregates over one measurement: `doctor` reports the
 * compatibility state, and `install` additionally requires authority. The named
 * reason is `registration-contract-unverified`, deliberately not `incompatible`.
 */
export function registrationAuthority(check) {
  const verified = !!(check && check.detail && check.detail.grants_mutation === true);
  return {
    id: 'registration-contract',
    state: verified ? 'OK' : 'UNVERIFIED',
    grants_mutation: verified,
    verified_pin: PINNED_DSH,
    detected: check && check.detail ? check.detail.detected : null,
    measured_from: check && check.detail ? check.detail.source : null,
    reason: verified
      ? null
      : 'registration-contract-unverified: the direct registration path writes DSH\'s persisted profile schema, '
        + 'which is only established for DSH ' + PINNED_DSH + '. Detected: '
        + ((check && check.detail && check.detail.detected) || 'none') + '. '
        + 'This is not a claim that the host is incompatible — it is that an unverified schema does not grant '
        + 'write authority. Register through the official `dsh plugin --profile <p> add <path>` CLI instead, '
        + 'or prove this DSH version and add it to the verified set.',
  };
}

// ------------------------------------------------------------------ reports

function doctorInstallBlock({ home, profile, name }) {
  const reg = readRegistration({ home, profile, name });
  const durable = installRoot({ home });
  const receipt = readJsonFile(receiptPath(home));
  return {
    registered: reg.registered,
    profile: reg.profile,
    profile_dir: reg.dir,
    dependency_spec: reg.dependencySpec,
    in_bundles: reg.inBundles,
    node_modules_link: reg.nodeModulesLink,
    install_root: durable,
    receipt_present: !!receipt.value,
    receipt_error: receipt.error,
    // Registration is NOT a readiness prerequisite — it is the OUTCOME of
    // `install`. Folding it into the verdict would make `doctor` report BLOCKED
    // on a fresh, perfectly ready host, which is the opposite of its job.
    note: 'registration is reported, not required: it is what `install` produces',
  };
}

export async function doctorReport({ home, profile = DEFAULT_PROFILE, env = process.env, deps = {} } = {}) {
  const h = home || getDshHome();
  const resolved = resolveConfig(h);
  const pre = await prerequisiteChecks({ home: h, profile, env, resolved, ...deps });
  const provenance = provenanceRecord({ root: pluginRoot() });
  return {
    command: 'doctor',
    schema: RECEIPT_SCHEMA,
    generated_at: isoNow(),
    read_only: true,
    dsh_home: h,
    profile,
    verdict: pre.verdict,
    exit_code: pre.verdict === 'READY' ? EXIT.OK : (pre.verdict === 'BLOCKED' ? EXIT.BLOCKED : EXIT.UNVERIFIED),
    checks: pre.checks,
    blocking: pre.blocking.map((c) => ({ id: c.id, reason: c.reason })),
    unverified: pre.unverified.map((c) => ({ id: c.id, reason: c.reason })),
    install: doctorInstallBlock({ home: h, profile, name: PKG_NAME }),
    registration_authority: registrationAuthority(pre.checks.find((c) => c.id === 'registration-contract')),
    provenance,
    provenance_verdict: judgeProvenance(provenance),
  };
}

// ------------------------------------------------------------------ install

/**
 * Copy the shipped set into `destDir`, with npm's file modes.
 *
 * The mode normalisation is not cosmetic. `copyFileSync` propagates a FILE's
 * mode, so a package copied out of a tree whose write bits were cleared arrives
 * read-only — and the gate clears the write bits on tracked inputs for the whole
 * of a run, so this is the normal case, not an exotic one. Left alone, the mode
 * of the tree the installer happened to be invoked from would leak into the
 * durable install: the same commit would produce a writable install from a
 * checkout and a read-only one under the gate. A tarball install produces 0644
 * files and 0755 directories, so that is what this produces — deterministically,
 * from any source.
 */
function copyShipped(root, pkg, destDir) {
  const FILE_MODE = 0o644;
  const DIR_MODE = 0o755;
  const EXEC_MODE = 0o755;
  mkdirSync(destDir, { recursive: true, mode: DIR_MODE });
  const copied = [];
  const isBin = (rel) => rel === 'bin' || rel.startsWith('bin/');
  for (const entry of shippedFiles(pkg)) {
    const src = join(root, ...entry.split('/'));
    const dst = join(destDir, ...entry.split('/'));
    let st;
    try { st = statSync(src); } catch { continue; }   // a declared-but-absent path is skipped, and the receipt's digest reflects that
    if (st.isDirectory()) {
      for (const rel of listFiles(src)) {
        const s = join(src, ...rel.split('/'));
        const d = join(dst, ...rel.split('/'));
        mkdirSync(dirname(d), { recursive: true, mode: DIR_MODE });
        copyFileSync(s, d);
        chmodSync(d, isBin(entry + '/' + rel) ? EXEC_MODE : FILE_MODE);
        copied.push(entry + '/' + rel);
      }
    } else {
      mkdirSync(dirname(dst), { recursive: true, mode: DIR_MODE });
      copyFileSync(src, dst);
      chmodSync(dst, isBin(entry) ? EXEC_MODE : FILE_MODE);
      copied.push(entry);
    }
  }
  return copied.sort();
}

/**
 * Register the durable copy in the profile.
 *
 * Reproduces the profile contract observed on a real DSH profile rather than
 * shelling out to a package manager: `dsh plugin ... add` forwards to pnpm,
 * which needs the network and a corepack download before it can write anything
 * (measured: a synthetic home produced no change and the run did not finish
 * inside 180 s). A durable install that only works with the network up is not
 * durable. What is written here is exactly what pnpm's `link:` writes — the
 * dependency spec, the bundle entry, and the node_modules symlink — and the
 * result is read back before it is believed.
 *
 * Returns { before, after, changed } so the caller can roll back byte-exactly.
 */
export function registerInProfile({ home, profile, name, durableDir }) {
  const dir = profileDir(home, profile);
  const pkgPath = join(dir, 'package.json');
  const before = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(before);
  const wantedSpec = 'link:' + durableDir;

  pkg.dependencies = (pkg.dependencies && typeof pkg.dependencies === 'object') ? pkg.dependencies : {};
  pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {};
  pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles.slice() : [];

  const depAlready = pkg.dependencies[name] === wantedSpec;
  const bundleAlready = bundles.includes(name);
  const linkPath = join(dir, 'node_modules', name);
  const linkAlready = existsSync(linkPath);

  if (depAlready && bundleAlready && linkAlready) {
    return { changed: false, before, after: before, spec: wantedSpec };
  }

  pkg.dependencies[name] = wantedSpec;
  if (!bundleAlready) bundles.push(name);
  pkg.dsh.profile.bundles = bundles;

  // Write the manifest and the symlink together. A crash between them leaves a
  // registration the read-back will call unregistered, which is exactly what the
  // rollback path is for.
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  // unlinkSync, not rmSync: this removes a SYMLINK, and `rmSync` on a symlink to a
  // directory is ambiguous about whether it removes the link or the target. The
  // unambiguous single-entry operation is the right one here — and it matters in
  // practice, because a recursive-looking delete on this path is what a host-side
  // bulk-delete guard is entitled to stop.
  try { unlinkSync(linkPath); } catch { /* absent — the normal first-install case */ }
  symlinkSync(durableDir, linkPath, 'dir');

  return { changed: true, before, after: readFileSync(pkgPath, 'utf8'), spec: wantedSpec };
}

function unregisterFromProfile({ home, profile, name, before }) {
  const dir = profileDir(home, profile);
  const pkgPath = join(dir, 'package.json');
  const failures = [];
  try {
    if (typeof before === 'string') writeFileSync(pkgPath, before);
  } catch (e) { failures.push('restore profile package.json: ' + (e && e.message)); }
  try { unlinkSync(join(dir, 'node_modules', name)); } catch (e) { if (e && e.code !== 'ENOENT') failures.push('remove node_modules link: ' + (e && e.message)); }
  return failures;
}

/**
 * The boot leg.
 *
 * Loads the plugin's host half as a whole module graph FROM THE DURABLE
 * LOCATION, in a child process, with no source checkout in play. This is a real
 * boot of the plugin half — it is not a full DSH web server boot, and the
 * receipt says `method: module-graph-load` so nobody has to guess which one it
 * was. (The same leg scripts/check.js runs over lib/, aimed at the installed
 * copy instead of the working tree.)
 */
export function bootCheck(durableDir, { timeoutMs = 30000 } = {}) {
  const entry = join(durableDir, 'lib', 'index.js');
  if (!existsSync(entry)) return { ok: false, method: 'module-graph-load', exit_code: null, error: 'entry not present: lib/index.js' };
  const t0 = Date.now();
  const r = spawnSync(process.execPath,
    ['--input-type=module', '-e', 'await import(' + JSON.stringify(new URL('file://' + entry).href) + ')'],
    { encoding: 'utf8', timeout: timeoutMs, cwd: durableDir });
  const ms = Date.now() - t0;
  return {
    ok: !r.error && r.status === 0,
    method: 'module-graph-load',
    scope: 'the plugin host half loads as a whole graph from the durable location; a full DSH web server boot is not performed here',
    exit_code: r.status === null ? null : r.status,
    ms,
    error: r.error ? r.error.message : (r.status === 0 ? null : String(r.stderr || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300)),
  };
}

/**
 * Install the packaged plugin onto this host.
 *
 * Order is the contract: resolve → preflight → durable copy → register → boot →
 * receipt. Everything before the first write is a read; everything after it is
 * inside a rollback boundary.
 */
export async function installPlugin({ home, profile = DEFAULT_PROFILE, env = process.env, dryRun = false, deps = {} } = {}) {
  const { boot: bootFn = bootCheck, ...preDeps } = deps;
  const h = home || getDshHome();
  const resolved = resolveConfig(h);
  const provenance = provenanceRecord({ root: pluginRoot() });
  const root = pluginRoot();
  const { value: pkg } = readJsonFile(join(root, 'package.json'));
  const version = (pkg && pkg.version) || '0.0.0';
  const durableRoot = installRoot({ home: h, env });
  const durableDir = join(durableRoot, PKG_NAME + '-' + version);

  const pre = await prerequisiteChecks({ home: h, profile, env, resolved, ...preDeps });
  const authority = registrationAuthority(pre.checks.find((c) => c.id === 'registration-contract'));
  const base = {
    command: 'install',
    schema: RECEIPT_SCHEMA,
    generated_at: isoNow(),
    dsh_home: h,
    profile,
    package: {
      name: PKG_NAME,
      version,
      source_commit: provenance.source_commit,
      source_commit_state: provenance.source_commit_state,
      provenance_schema: PROVENANCE_SCHEMA,
      certified_by_gate_version: provenance.certified_by_gate_version,
    },
    compatibility: {
      dsh_pin: PINNED_DSH,
      dsh_host_version: (pre.checks.find((c) => c.id === 'dsh-host') || {}).detail?.detected ?? null,
      state: (pre.checks.find((c) => c.id === 'dsh-host') || {}).state ?? 'UNKNOWN',
    },
    location: { install_root: durableRoot, durable_dir: durableDir },
    preflight: { verdict: pre.verdict, checks: pre.checks.map((c) => ({ id: c.id, state: c.state, blocking: c.blocking })) },
    registration_authority: authority,
    archon: (() => { const c = pre.checks.find((x) => x.id === 'archon'); return c ? { state: c.state, detail: c.detail } : null; })(),
    registry: (() => { const c = pre.checks.find((x) => x.id === 'registry'); return c ? { state: c.state, detail: c.detail } : null; })(),
    boot: null,
    registration: null,
    rollback: null,
    host: { node: process.versions.node, platform: process.platform, arch: process.arch },
  };

  // ---- rule 1: preflight before mutation ------------------------------
  if (pre.verdict === 'BLOCKED') {
    return {
      ...base,
      state: 'BLOCKED',
      mutated: false,
      exit_code: EXIT.BLOCKED,
      reason: 'Required prerequisite missing: ' + pre.blocking.map((c) => c.id).join(', ')
        + '. Nothing was written.',
      blocking: pre.blocking.map((c) => ({ id: c.id, requirement: c.requirement, reason: c.reason })),
    };
  }

  if (dryRun) {
    return {
      ...base,
      state: 'DRY_RUN',
      mutated: false,
      exit_code: EXIT.OK,
      would_refuse: authority.grants_mutation ? null : authority.reason,
      reason: 'preflight passed; --dry-run writes nothing'
        + (authority.grants_mutation ? '' : ' — note: a real run would refuse (registration-contract-unverified)'),
    };
  }

  // ---- the mutation-authority gate (still before any write) ------------
  // Deliberately AFTER the dry-run branch so a dry run can REPORT this rather
  // than refuse, and deliberately BEFORE the first write so a refusal leaves the
  // host exactly as it was. See registrationAuthority() for why this is not
  // folded into the compatibility verdict.
  if (!authority.grants_mutation) {
    return {
      ...base,
      state: 'BLOCKED',
      mutated: false,
      exit_code: EXIT.BLOCKED,
      reason: authority.reason,
      blocking: [{ id: authority.id, requirement: 'a host DSH at the verified pin ' + PINNED_DSH, reason: authority.reason }],
    };
  }

  const rollback = { attempted: false, restored: [], failures: [] };
  let durableCreated = false;
  let registrationBefore = null;

  try {
    // ---- durable copy (staged, then renamed into place) ----------------
    const staged = durableDir + '.staging-' + process.pid + '-' + Math.random().toString(16).slice(2, 8);
    let converged = false;
    if (existsSync(durableDir)) {
      const existing = contentIdentity(durableDir);
      const tmpProbe = staged;
      copyShipped(root, pkg, tmpProbe);
      const incoming = contentIdentity(tmpProbe);
      rmSync(tmpProbe, { recursive: true, force: true });
      if (existing.digest === incoming.digest) converged = true;
      else { rmSync(durableDir, { recursive: true, force: true }); }
    }
    if (!converged) {
      copyShipped(root, pkg, staged);
      mkdirSync(dirname(durableDir), { recursive: true });
      renameSync(staged, durableDir);
      durableCreated = true;
    }
    const identity = contentIdentity(durableDir);

    // ---- register ------------------------------------------------------
    const reg = registerInProfile({ home: h, profile, name: PKG_NAME, durableDir });
    registrationBefore = reg.before;
    const regAfter = readRegistration({ home: h, profile, name: PKG_NAME });

    // ---- boot ----------------------------------------------------------
    const boot = bootFn(durableDir);

    base.boot = boot;
    base.registration = {
      changed: reg.changed,
      spec: reg.spec,
      in_bundles: regAfter.inBundles,
      node_modules_link: regAfter.nodeModulesLink,
      registered: regAfter.registered,
    };
    base.location = { ...base.location, created: durableCreated, converged, content_digest: identity.digest, files: identity.files, bytes: identity.bytes };

    if (!regAfter.registered) throw new Error('registration read-back failed: the profile does not list ' + PKG_NAME + ' with a link to ' + durableDir);
    if (!boot.ok) throw new Error('boot leg failed (' + boot.method + ', exit ' + boot.exit_code + '): ' + boot.error);

    const state = reg.changed || durableCreated ? 'INSTALLED' : 'ALREADY_INSTALLED';

    // IDEMPOTENCE, at the byte level. A converged run must leave the host
    // EXACTLY as it found it — including the receipt. Rewriting the receipt on
    // every invocation would stamp a new `generated_at` and make a no-op run
    // observably different from the run that actually installed something, which
    // is the "different effective state" idempotence is supposed to exclude.
    //
    // The receipt is still written when it is missing or when it no longer
    // describes what is on disk — otherwise a converged host whose receipt had
    // been deleted could never become verifiable again.
    const existing = readJsonFile(receiptPath(h));
    const receiptStale = !existing.value
      || (existing.value.location && existing.value.location.content_digest !== identity.digest);
    const writeReceipt = state === 'INSTALLED' || receiptStale;

    const receipt = {
      ...base,
      state,
      mutated: reg.changed || durableCreated,
      exit_code: EXIT.OK,
      receipt_action: writeReceipt ? 'written' : 'preserved',
      reason: state === 'ALREADY_INSTALLED'
        ? 'Already installed at this version and location; the second run converged and wrote nothing'
          + (writeReceipt ? ' except a receipt that no longer matched the installed bytes.' : '.')
        : 'Installed and registered.',
    };
    if (writeReceipt) writeInstallReceipt(h, receipt);
    return receipt;
  } catch (e) {
    // ---- transactional failure -----------------------------------------
    rollback.attempted = true;
    const failures = unregisterFromProfile({ home: h, profile, name: PKG_NAME, before: registrationBefore });
    rollback.failures.push(...failures);
    if (durableCreated) {
      try { rmSync(durableDir, { recursive: true, force: true }); rollback.restored.push('removed durable copy'); }
      catch (e2) { rollback.failures.push('remove durable copy: ' + (e2 && e2.message)); }
    }
    if (registrationBefore !== null) rollback.restored.push('restored profile package.json');
    return {
      ...base,
      state: 'FAILED_ROLLED_BACK',
      mutated: false,
      exit_code: EXIT.FAILED,
      reason: (e && e.message) || String(e),
      rollback,
    };
  }
}

function writeInstallReceipt(home, receipt) {
  const dir = join(home, 'operator-ui');
  mkdirSync(dir, { recursive: true });
  writeFileSync(receiptPath(home), JSON.stringify(receipt, null, 2) + '\n');
}

// ------------------------------------------------------------------ verify

/**
 * Verify the INSTALLED runtime — not the source tree.
 *
 * GPT's ruling, restated so the difference cannot blur: `verify` answers "is the
 * thing installed on this host the thing the receipt says was installed, and does
 * it load?" It does NOT and cannot re-run source certification; the suite that
 * certifies the source lives on the source side and is deliberately not shipped.
 */
export async function verifyInstalled({ home, profile = DEFAULT_PROFILE, env = process.env, deps = {} } = {}) {
  const { boot: bootFn = bootCheck, hostCompatFn = hostCompat } = deps;
  const h = home || getDshHome();
  const resolved = resolveConfig(h);
  const receiptRead = readJsonFile(receiptPath(h));
  const findings = [];

  if (!receiptRead.value) {
    return {
      command: 'verify',
      schema: RECEIPT_SCHEMA,
      generated_at: isoNow(),
      dsh_home: h,
      profile,
      state: 'BLOCKED',
      exit_code: EXIT.BLOCKED,
      reason: 'No install receipt at ' + receiptPath(h) + (receiptRead.error ? ' (unreadable: ' + receiptRead.error + ')' : '') + ' — this host has not been installed by `' + CLI_NAME + ' install`.',
      findings,
      provenance: provenanceRecord({ root: pluginRoot() }),
    };
  }

  const receipt = receiptRead.value;
  const durableDir = receipt.location && receipt.location.durable_dir;
  const name = (receipt.package && receipt.package.name) || PKG_NAME;

  // 1. durable copy present and identical to what the receipt recorded
  let identity = null;
  if (!durableDir || !existsSync(durableDir)) {
    findings.push({ id: 'durable-copy', state: 'BLOCKED', reason: 'the durable copy recorded in the receipt is gone: ' + String(durableDir) });
  } else {
    identity = contentIdentity(durableDir);
    const recorded = receipt.location && receipt.location.content_digest;
    if (recorded && identity.digest !== recorded) {
      findings.push({ id: 'durable-copy', state: 'BLOCKED', reason: 'the installed bytes no longer match the receipt digest (recorded ' + String(recorded).slice(0, 12) + ', found ' + identity.digest.slice(0, 12) + ') — the install has been modified since it was receipted' });
    } else {
      findings.push({ id: 'durable-copy', state: 'OK', detail: { dir: durableDir, digest: identity.digest, files: identity.files } });
    }
  }

  // 2. version agreement between the receipt, the manifest on disk and the code
  const { value: pkg } = durableDir ? readJsonFile(join(durableDir, 'package.json')) : { value: null };
  const runtimeVersion = pkg && pkg.version;
  const receiptVersion = receipt.package && receipt.package.version;
  if (!runtimeVersion) findings.push({ id: 'version', state: 'BLOCKED', reason: 'no package.json in the durable copy' });
  else if (receiptVersion && runtimeVersion !== receiptVersion) {
    findings.push({ id: 'version', state: 'BLOCKED', reason: 'installed version ' + runtimeVersion + ' != receipted version ' + receiptVersion });
  } else findings.push({ id: 'version', state: 'OK', detail: { version: runtimeVersion } });

  // 3. registration still points at the durable copy
  const reg = readRegistration({ home: h, profile: receipt.profile || profile, name });
  if (!reg.registered) findings.push({ id: 'registration', state: 'BLOCKED', reason: 'the profile no longer registers ' + name });
  else if (!specTargets(reg.dependencySpec, durableDir)) {
    findings.push({ id: 'registration', state: 'BLOCKED', reason: 'the profile registers ' + name + ' at ' + String(reg.dependencySpec) + ', not at the receipted durable location' });
  } else findings.push({ id: 'registration', state: 'OK', detail: { spec: reg.dependencySpec, in_bundles: reg.inBundles } });

  // 4. the installed plugin half still boots from the durable location
  const boot = durableDir && existsSync(durableDir) ? bootFn(durableDir) : { ok: false, method: 'module-graph-load', error: 'durable copy absent' };
  findings.push({ id: 'boot', state: boot.ok ? 'OK' : 'BLOCKED', detail: boot, reason: boot.ok ? null : 'the installed plugin half does not load: ' + boot.error });

  // 5. host compatibility, re-measured now rather than replayed from the receipt
  const host = hostCompatFn({ env });
  findings.push({
    id: 'host-compat',
    state: host.state === 'VERIFIED' ? 'OK' : 'UNVERIFIED',
    detail: { detected: host.version, pin: host.pin, verdict: host.state },
    reason: host.state === 'VERIFIED' ? null : host.headline,
  });

  // 6. provenance: can the installed bytes name their source commit?
  const provenance = provenanceRecord({ root: durableDir || pluginRoot() });
  const pv = judgeProvenance(provenance);
  findings.push({ id: 'provenance', state: pv.ok ? 'OK' : 'UNVERIFIED', detail: provenance, reason: pv.ok ? null : pv.detail });

  const blocked = findings.filter((f) => f.state === 'BLOCKED');
  const unverified = findings.filter((f) => f.state === 'UNVERIFIED');
  const state = blocked.length ? 'BLOCKED' : (unverified.length ? 'UNVERIFIED' : 'VERIFIED');

  return {
    command: 'verify',
    schema: RECEIPT_SCHEMA,
    generated_at: isoNow(),
    dsh_home: h,
    profile: receipt.profile || profile,
    state,
    exit_code: state === 'VERIFIED' ? EXIT.OK : (state === 'BLOCKED' ? EXIT.BLOCKED : EXIT.UNVERIFIED),
    reason: state === 'VERIFIED'
      ? 'The installed runtime matches its receipt, is registered at the receipted location, and its host half loads from there.'
      : (blocked.length ? 'The installed runtime is broken: ' + blocked.map((f) => f.id).join(', ') : 'The installed runtime is intact but not claim-grade: ' + unverified.map((f) => f.id).join(', ')),
    receipt: { state: receipt.state, installed_at: receipt.generated_at, package: receipt.package },
    findings,
    provenance,
  };
}

// ------------------------------------------------------------------ argv + rendering

export function parseArgv(argv) {
  const args = argv.slice();
  const command = args.find((a) => !a.startsWith('-')) || null;
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  return {
    command,
    json: args.includes('--json'),
    dryRun: args.includes('--dry-run'),
    profile: get('--profile') || DEFAULT_PROFILE,
    help: args.includes('--help') || args.includes('-h') || !command,
  };
}

export function renderDoctor(rep) {
  const lines = [];
  lines.push(CLI_NAME + ' doctor — read-only prerequisite report');
  lines.push('  DSH home : ' + rep.dsh_home);
  lines.push('  profile  : ' + rep.profile);
  lines.push('');
  for (const c of rep.checks) {
    const mark = c.state === 'OK' ? 'ok  ' : (c.state === 'BLOCKED' ? 'BLOCK' : 'warn');
    lines.push('  ' + mark + ' ' + c.id + (c.detail ? '  ' + JSON.stringify(c.detail) : ''));
    if (c.reason) lines.push('        ' + c.reason);
  }
  lines.push('');
  lines.push('  install  : ' + (rep.install.registered ? 'registered' : 'not registered')
    + ' (spec ' + String(rep.install.dependency_spec) + ')');
  lines.push('  artifact : ' + rep.provenance.package + '@' + rep.provenance.package_version
    + ' commit=' + (rep.provenance.source_commit ? String(rep.provenance.source_commit).slice(0, 12) : '(none)'));
  lines.push('  mutation : ' + (rep.registration_authority.grants_mutation
    ? 'direct registration AUTHORISED (host DSH is the verified pin)'
    : 'direct registration WITHHELD — registration-contract-unverified'));
  lines.push('');
  lines.push('  VERDICT  : ' + rep.verdict);
  if (rep.blocking.length) for (const b of rep.blocking) lines.push('    blocked on ' + b.id + ': ' + b.reason);
  return lines.join('\n');
}

export function renderInstall(rep) {
  const lines = [];
  lines.push(CLI_NAME + ' install — ' + rep.state);
  if (rep.state === 'BLOCKED') {
    lines.push('  nothing was written. Missing prerequisites:');
    for (const b of rep.blocking || []) lines.push('    ' + b.id + ': ' + b.reason);
    return lines.join('\n');
  }
  lines.push('  durable  : ' + rep.location.durable_dir + (rep.location.converged ? ' (converged, byte-identical)' : ''));
  lines.push('  digest   : ' + String(rep.location.content_digest || '').slice(0, 16) + '  files=' + rep.location.files);
  lines.push('  profile  : ' + rep.profile + '  spec=' + String(rep.registration && rep.registration.spec));
  lines.push('  boot     : ' + (rep.boot ? (rep.boot.ok ? 'ok' : 'FAILED') + ' (' + rep.boot.method + ', ' + rep.boot.ms + ' ms)' : '(not attempted)'));
  lines.push('  host DSH : ' + String(rep.compatibility.dsh_host_version) + ' vs pin ' + rep.compatibility.dsh_pin + ' → ' + rep.compatibility.state);
  if (rep.registration_authority) lines.push('  authority: ' + (rep.registration_authority.grants_mutation ? 'direct registration authorised' : 'registration-contract-unverified'));
  if (rep.would_refuse) lines.push('  would refuse: ' + rep.would_refuse);
  if (rep.rollback) lines.push('  rollback : ' + JSON.stringify(rep.rollback));
  return lines.join('\n');
}

export function renderVerify(rep) {
  const lines = [];
  lines.push(CLI_NAME + ' verify — ' + rep.state);
  for (const f of rep.findings) {
    const mark = f.state === 'OK' ? 'ok  ' : (f.state === 'BLOCKED' ? 'BLOCK' : 'warn');
    lines.push('  ' + mark + ' ' + f.id + (f.reason ? '  ' + f.reason : ''));
  }
  return lines.join('\n');
}

/** Entry point. Returns an exit code; never throws on a handled condition. */
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, deps = {} } = {}) {
  const opts = parseArgv(argv);
  if (opts.help && !opts.command) {
    stdout.write([
      CLI_NAME + ' — runtime surface for the DeepSeek Harness operator UI plugin',
      '',
      '  ' + CLI_NAME + ' doctor  [--profile <p>] [--json]   read-only prerequisite report',
      '  ' + CLI_NAME + ' install [--profile <p>] [--json] [--dry-run]',
      '  ' + CLI_NAME + ' verify  [--profile <p>] [--json]',
      '',
      '  Exit codes: 0 ok | 1 unverified | 2 blocked (nothing written) | 3 failed (rolled back) | 4 usage',
      '',
      '  This surface verifies the INSTALLED runtime. It does not and cannot re-run',
      '  source certification — the certification gate is not part of this package.',
      '',
    ].join('\n'));
    return EXIT.USAGE;
  }
  if (!COMMANDS.includes(opts.command)) {
    stderr.write('unknown command: ' + String(opts.command) + ' (expected one of ' + COMMANDS.join(', ') + ')\n');
    return EXIT.USAGE;
  }

  const home = env.DSH_HOME || getDshHome();
  try {
    if (opts.command === 'doctor') {
      const rep = await doctorReport({ home, profile: opts.profile, env, deps });
      stdout.write((opts.json ? JSON.stringify(rep, null, 2) : renderDoctor(rep)) + '\n');
      return rep.exit_code;
    }
    if (opts.command === 'install') {
      const rep = await installPlugin({ home, profile: opts.profile, env, dryRun: opts.dryRun, deps });
      stdout.write((opts.json ? JSON.stringify(rep, null, 2) : renderInstall(rep)) + '\n');
      return rep.exit_code;
    }
    const rep = await verifyInstalled({ home, profile: opts.profile, env, deps });
    stdout.write((opts.json ? JSON.stringify(rep, null, 2) : renderVerify(rep)) + '\n');
    return rep.exit_code;
  } catch (e) {
    stderr.write(CLI_NAME + ' ' + opts.command + ' failed: ' + ((e && e.stack) || String(e)) + '\n');
    return EXIT.FAILED;
  }
}

export { PINNED_DSH };
