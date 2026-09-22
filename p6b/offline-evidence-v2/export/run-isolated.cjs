#!/usr/bin/env node
'use strict';

// Fail-closed isolation guard for the P6B cloud experiment (GPT ruling 2026-09-22:
// "Implement a fail-closed isolation guard at the experiment's execution boundary").
//
// Refuses — before ANY filesystem write and before spawning the wrapped command —
// unless every one of these holds:
//   1. --root <dir> names an existing directory that is NOT the production RCOS
//      default (os.homedir()/zcode-rcos), the home directory itself, or its parent.
//   2. RCOS_HOME is explicitly set and resolves to exactly the same real path as
//      --root (symlink/ambiguity refusal via realpath on both sides).
//   3. Every file under the root matches the committed sha256 manifest exactly —
//      no missing files, no hash drift, no unlisted extras.
//   4. The registry contains exactly one capability: reuse-ledger, whose adapter
//      entrypoint resolves inside the root.
//   5. Artifact output locations (runs/, invocations/, eligibility/,
//      evidence-records/, traces/) are absent or real directories inside the root
//      — never symlinks pointing out.
// Only then does it exec the command after `--` with RCOS_HOME pinned to the
// verified root. The guard itself performs zero writes; refusals exit 9.
//
// Usage:
//   node p6b/run-isolated.cjs --root <dir> [--manifest <path>] [--check-only] -- <cmd> [args...]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const OUTPUT_DIRS = ['runs', 'invocations', 'eligibility', 'evidence-records', 'traces'];
const EXIT_REFUSAL = 9;

function refuse(reason) {
  process.stderr.write(`isolation-guard: REFUSAL — ${reason}\n`);
  process.exit(EXIT_REFUSAL);
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function listFilesRecursive(dir, base) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (e.isSymbolicLink()) out.push({ rel, symlink: true });
    else if (e.isDirectory()) out.push(...listFilesRecursive(full, base));
    else if (e.isFile()) out.push({ rel, symlink: false });
  }
  return out;
}

function parseArgs(argv) {
  const root = { value: null };
  const manifest = { value: null };
  const checkOnly = { value: false };
  const cmd = [];
  let seenDashDash = false;
  for (let i = 0; i < argv.length; i++) {
    if (seenDashDash) { cmd.push(argv[i]); continue; }
    if (argv[i] === '--') { seenDashDash = true; continue; }
    if (argv[i] === '--root') { root.value = argv[++i]; continue; }
    if (argv[i] === '--manifest') { manifest.value = argv[++i]; continue; }
    if (argv[i] === '--check-only') { checkOnly.value = true; continue; }
    refuse(`unrecognized argument "${argv[i]}" (expected --root <dir> [--manifest <path>] [--check-only] -- <cmd>)`);
  }
  return { root: root.value, manifest: manifest.value, checkOnly: checkOnly.value, cmd };
}

function runIsolated(argv) {
  const { root: rootArg, manifest: manifestArg, checkOnly, cmd } = parseArgs(argv);

  // 1. Root: explicit, existing, and not production-directed.
  if (!rootArg) refuse('--root <dir> is required');
  const root = path.resolve(rootArg);
  if (!fs.existsSync(root)) refuse(`--root "${rootArg}" does not resolve to an existing directory (${root})`);
  const rootReal = fs.realpathSync(root);
  const productionDefault = path.join(os.homedir(), 'zcode-rcos');
  // existsSync first: in a fresh sandbox the production default home is absent,
  // and an unconditional realpath() there would crash the happy path (ENOENT)
  // instead of verifying.
  if (fs.existsSync(productionDefault) && rootReal === fs.realpathSync(productionDefault)) {
    refuse(`--root resolves to the production RCOS default home (${productionDefault})`);
  }
  if (rootReal === fs.realpathSync(os.homedir())) refuse('--root resolves to the home directory itself');
  if (rootReal === path.dirname(os.homedir())) refuse('--root resolves to the parent of the home directory');

  // 2. RCOS_HOME must be explicitly set and resolve to the same real path.
  if (!process.env.RCOS_HOME) {
    refuse('RCOS_HOME is not set — without an explicit home the kernel would silently select the production default (incident 20260922T153919Z)');
  }
  const homeResolved = path.resolve(process.env.RCOS_HOME);
  if (!fs.existsSync(homeResolved)) {
    refuse(`RCOS_HOME "${process.env.RCOS_HOME}" does not exist (${homeResolved})`);
  }
  const homeReal = fs.realpathSync(homeResolved);
  if (homeReal !== rootReal) {
    refuse(`RCOS_HOME (${homeReal}) does not match --root (${rootReal}) — ambiguous or misdirected configuration`);
  }

  // 3. Manifest: exact sha256 match, no missing files, no unlisted extras, no symlinks.
  const manifestPath = manifestArg
    ? path.resolve(manifestArg)
    : path.join(__dirname, 'rcos-kernel-subset.manifest.sha256');
  if (!fs.existsSync(manifestPath)) refuse(`manifest not found at ${manifestPath}`);
  const expected = new Map();
  for (const line of fs.readFileSync(manifestPath, 'utf8').split('\n')) {
    const m = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (m) expected.set(m[2], m[1]);
  }
  if (expected.size === 0) refuse(`manifest at ${manifestPath} parsed to zero entries`);
  const actual = listFilesRecursive(rootReal, rootReal);
  for (const f of actual) {
    if (f.symlink) refuse(`unexpected symlink inside root: ${f.rel}`);
  }
  const actualByRel = new Map(actual.map((f) => [f.rel, f]));
  for (const [rel, hash] of expected) {
    if (!actualByRel.has(rel)) refuse(`manifest file missing from root: ${rel}`);
    const got = sha256File(path.join(rootReal, rel));
    if (got !== hash) refuse(`sha256 mismatch for ${rel}: expected ${hash.slice(0, 16)}…, got ${got.slice(0, 16)}…`);
  }
  for (const f of actual) {
    if (expected.has(f.rel)) continue;
    // Run artifacts are permitted ONLY inside the declared output locations;
    // an unlisted file anywhere else breaks the pre-execution freeze.
    if (OUTPUT_DIRS.some((d) => f.rel === d || f.rel.startsWith(d + '/'))) continue;
    refuse(`unlisted file inside root outside permitted output locations (${OUTPUT_DIRS.join(', ')}/): ${f.rel}`);
  }

  // 4. Registry: exactly one capability, reuse-ledger, entrypoint inside root.
  const registryPath = path.join(rootReal, 'registry', 'capability-registry.json');
  if (!fs.existsSync(registryPath)) refuse('registry/capability-registry.json missing from root');
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (e) {
    refuse(`registry is not valid JSON: ${e.message}`);
  }
  const caps = Array.isArray(registry.capabilities)
    ? registry.capabilities
    : Object.keys(registry.capabilities || {}).map((k) => ({ ...registry.capabilities[k], id: registry.capabilities[k].id || k }));
  if (!Array.isArray(caps) || caps.length !== 1) {
    refuse(`registry must contain exactly one capability for the isolated experiment (found ${caps ? caps.length : 'none'})`);
  }
  if (caps[0].id !== 'reuse-ledger') {
    refuse(`unexpected capability in isolated registry: "${caps[0].id}" (expected "reuse-ledger")`);
  }
  const entrypoint = caps[0].adapter && caps[0].adapter.entrypoint;
  const entryAbs = entrypoint && path.resolve(rootReal, entrypoint);
  if (!entryAbs || !entryAbs.startsWith(rootReal + path.sep)) {
    refuse(`adapter entrypoint "${entrypoint}" does not resolve inside the isolated root`);
  }
  if (!fs.existsSync(entryAbs)) refuse(`adapter entrypoint does not exist: ${entryAbs}`);

  // 5. Output locations: absent or real directories inside the root (no symlink escapes).
  for (const name of OUTPUT_DIRS) {
    const p = path.join(rootReal, name);
    if (!fs.existsSync(p)) continue;
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) refuse(`output location "${name}" is a symlink — possible write escape`);
    if (!st.isDirectory()) refuse(`output location "${name}" exists but is not a directory`);
    if (fs.realpathSync(p) !== p && !fs.realpathSync(p).startsWith(rootReal + path.sep)) {
      refuse(`output location "${name}" resolves outside the isolated root`);
    }
  }

  const summary = `isolation-guard: OK — root ${rootReal} verified (manifest ${expected.size} files, registry 1 capability reuse-ledger, RCOS_HOME pinned)`;
  process.stderr.write(`${summary}\n`);
  if (checkOnly) process.exit(0);

  if (cmd.length === 0) refuse('no command after `--` to execute');
  const result = spawnSync(cmd[0], cmd.slice(1), {
    stdio: 'inherit',
    cwd: rootReal,
    env: { ...process.env, RCOS_HOME: rootReal },
  });
  if (result.error) refuse(`failed to launch command: ${result.error.message}`);
  process.exit(result.status === null ? 1 : result.status);
}

module.exports = { runIsolated, parseArgs, OUTPUT_DIRS, EXIT_REFUSAL };

if (require.main === module) runIsolated(process.argv.slice(2));
