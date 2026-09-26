// P6B fail-closed isolation guard (p6b/run-isolated.cjs) — the execution
// boundary GPT required after the 20260922T153919Z incident: every test here
// proves a refusal (or an isolated accept) WITHOUT any write escaping the
// disposable root. Refusal cases assert the root's file inventory is
// byte-identical before/after, so "refuses before any filesystem mutation" is
// tested, not just claimed. The production-default branch is exercised by
// passing the real default home as --root; the guard only ever realpath()s it,
// and the refusal fires before any child process exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, readdirSync, chmodSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKTREE = dirname(HERE);
const GUARD = join(WORKTREE, 'p6b', 'run-isolated.cjs');
const SUBSET = join(WORKTREE, 'p6b', 'rcos-kernel-subset');
const MANIFEST = join(WORKTREE, 'p6b', 'rcos-kernel-subset.manifest.sha256');

// ADD owner-write to a path; never SET a mode.
//
// The distinction is load-bearing and it was learned the hard way. A blanket
// `chmod 0644` drops git's executable bit, and two files in this subset are
// executable — `bin/rcos` and `capabilities/reuse-ledger/adapter/run.js` — with
// the eval spawning the adapter directly. The first version of this helper did
// the blanket thing and failed "guard runs the real eval end-to-end" with exit 4,
// in a way that looked like a product failure. It is the same mistake
// `unlockTrackedInputs` in scripts/gate.mjs documents: a mode restore that is not
// derived from the original mode is a silent change to the execution inputs.
function addOwnerWrite(p) {
  try {
    chmodSync(p, (statSync(p).mode & 0o7777) | 0o200);
  } catch { /* best effort — a path that cannot be read is reported by its own test */ }
}

function makeWritable(root) {
  const dirs = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { dirs.push(p); walk(p); } else { addOwnerWrite(p); }
    }
  })(root);
  for (const d of dirs.reverse()) addOwnerWrite(d);
  addOwnerWrite(root);
}

// The disposable root exists to be MUTATED: most tests below provoke a refusal
// by editing it. So it declares itself writable rather than inheriting the mode
// of the tracked source it was copied from.
//
// This is a real precondition, not cosmetics, and it was invisible until the
// gate started making the tracked execution inputs read-only (P0.4). `cpSync`
// propagates a FILE's mode, so a copy made from a locked tree is born 0444 and
// three tests in this file failed with EACCES the first time the lock ran:
// "guard refuses on manifest hash drift", "guard refuses a second capability in
// the registry", and "guard runs the real eval end-to-end". The defect was
// always present — the fixture depended on the WRITABILITY OF ITS INPUT, which
// was never declared. Same class as the preflight test's dependency on
// ephemeral /tmp state: the environment changed, and an undeclared assumption
// surfaced as a red test rather than as a silently weaker one.
function freshRoot(t) {
  const root = join(tmpdir(), `p6b-guard-test-${randomUUID()}`);
  cpSync(SUBSET, root, { recursive: true });
  makeWritable(root);
  // Also on teardown: a test may legitimately leave the root read-only, and
  // rmSync cannot unlink out of a 0555 directory.
  t.after(() => { makeWritable(root); rmSync(root, { recursive: true, force: true }); });
  return root;
}

function inventory(root) {
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else files.push(`${full.slice(root.length)}:${createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 16)}`);
    }
  })(root);
  return files.join('|');
}

function runGuard(root, { env = {}, args = [] } = {}) {
  return spawnSync(process.execPath, [GUARD, ...args], {
    encoding: 'utf8',
    cwd: WORKTREE,
    env: { ...process.env, ...env },
  });
}

test('guard refuses when RCOS_HOME is unset — the incident case — and writes nothing', (t) => {
  const root = freshRoot(t);
  const before = inventory(root);
  const env = { ...process.env };
  delete env.RCOS_HOME;
  const r = spawnSync(process.execPath, [GUARD, '--root', root, '--', 'node', 'bin/rcos', 'evals'], {
    encoding: 'utf8', cwd: WORKTREE, env,
  });
  assert.equal(r.status, 9);
  assert.match(r.stderr, /REFUSAL — RCOS_HOME is not set/);
  assert.equal(inventory(root), before, 'root inventory changed during refusal');
});

test('guard refuses when RCOS_HOME points somewhere other than --root', (t) => {
  const root = freshRoot(t);
  const other = join(tmpdir(), `p6b-guard-other-${randomUUID()}`);
  mkdirSync(other, { recursive: true });
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const before = inventory(root);
  const otherBefore = inventory(other);
  const r = runGuard(root, { env: { RCOS_HOME: other }, args: ['--root', root, '--', 'node', 'bin/rcos', 'evals'] });
  assert.equal(r.status, 9);
  assert.match(r.stderr, /does not match --root/);
  assert.equal(inventory(root), before, 'root inventory changed during refusal');
  assert.equal(inventory(other), otherBefore, 'the misdirected RCOS_HOME target was written to');
});

test('guard refuses when --root IS the production default home and writes nothing there', (t) => {
  const productionDefault = join(homedir(), 'zcode-rcos');
  if (!existsSync(productionDefault)) {
    t.skip('production RCOS home not present on this machine');
    return;
  }
  const runsDir = join(productionDefault, 'runs');
  const runsBefore = existsSync(runsDir) ? readdirSync(runsDir).sort().join('|') : null;
  const r = runGuard(productionDefault, {
    env: { RCOS_HOME: productionDefault },
    args: ['--root', productionDefault, '--', 'node', 'bin/rcos', 'evals'],
  });
  assert.equal(r.status, 9);
  assert.match(r.stderr, /production RCOS default home/);
  const runsAfter = existsSync(runsDir) ? readdirSync(runsDir).sort().join('|') : null;
  assert.equal(runsAfter, runsBefore, 'production runs/ changed during refusal');
});

test('guard verifies normally on a host where the production default home is ABSENT (fresh-sandbox case)', (t) => {
  // os.homedir() honors $HOME on POSIX; point HOME at an empty tmpdir so
  // ~/zcode-rcos does not exist — the fresh Solari sandbox situation. Without
  // the existsSync guard clause the guard crashed with ENOENT (exit 1 + stack)
  // instead of verifying: the happy path must not depend on the production
  // default home existing.
  const fakeHome = join(tmpdir(), `p6b-guard-nohome-${randomUUID()}`);
  mkdirSync(fakeHome, { recursive: true });
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }));
  assert.equal(existsSync(join(fakeHome, 'zcode-rcos')), false, 'precondition: default home absent');
  const root = freshRoot(t);
  const r = runGuard(root, { env: { HOME: fakeHome, RCOS_HOME: root }, args: ['--root', root, '--check-only'] });
  assert.equal(r.status, 0, `guard crashed instead of verifying: ${r.stderr}`);
  assert.match(r.stderr, /isolation-guard: OK/);
});

test('guard refuses on manifest hash drift', (t) => {
  const root = freshRoot(t);
  const target = join(root, 'lib', 'registry.js');
  writeFileSync(target, readFileSync(target, 'utf8').replace("'use strict'", "'use strict' // drift"), 'utf8');
  const before = inventory(root);
  const r = runGuard(root, { env: { RCOS_HOME: root }, args: ['--root', root, '--check-only'] });
  assert.equal(r.status, 9);
  assert.match(r.stderr, /sha256 mismatch for lib\/registry\.js/);
  assert.equal(inventory(root), before);
});

test('guard refuses on an unlisted extra file', (t) => {
  const root = freshRoot(t);
  writeFileSync(join(root, 'sneaky.txt'), 'not in the manifest\n');
  const r = runGuard(root, { env: { RCOS_HOME: root }, args: ['--root', root, '--check-only'] });
  assert.equal(r.status, 9);
  assert.match(r.stderr, /unlisted file inside root/);
});

test('guard refuses a second capability in the registry', (t) => {
  const root = freshRoot(t);
  const regPath = join(root, 'registry', 'capability-registry.json');
  const reg = JSON.parse(readFileSync(regPath, 'utf8'));
  reg.capabilities.push({ ...JSON.parse(JSON.stringify(reg.capabilities[0])), id: 'fixture-cap' });
  writeFileSync(regPath, JSON.stringify(reg, null, 2) + '\n');
  // The registry edit changes its hash, so the test supplies a regenerated
  // manifest — this isolates the REGISTRY rule (exactly one capability) from
  // the manifest rule, which has its own test above.
  const regenerated = join(root, '..', `p6b-guard-manifest-${randomUUID()}`);
  const files = [];
  (function walk(dir, rel) {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r2 = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r2);
      else files.push(`${createHash('sha256').update(readFileSync(join(dir, e.name))).digest('hex')}  ${r2}`);
    }
  })(root, '');
  writeFileSync(regenerated, files.join('\n') + '\n', 'utf8');
  const before = inventory(root);
  const r = runGuard(root, {
    env: { RCOS_HOME: root },
    args: ['--root', root, '--manifest', regenerated, '--check-only'],
  });
  assert.equal(r.status, 9);
  assert.match(r.stderr, /exactly one capability/);
  assert.equal(inventory(root), before);
});

test('guard refuses a symlinked output dir that would escape the root', (t) => {
  const root = freshRoot(t);
  const escapeTarget = join(tmpdir(), `p6b-guard-escape-${randomUUID()}`);
  mkdirSync(escapeTarget, { recursive: true });
  t.after(() => rmSync(escapeTarget, { recursive: true, force: true }));
  symlinkSync(escapeTarget, join(root, 'runs'));
  const r = runGuard(root, { env: { RCOS_HOME: root }, args: ['--root', root, '--check-only'] });
  assert.equal(r.status, 9);
  assert.match(r.stderr, /unexpected symlink inside root: runs/);
  assert.equal(readdirSync(escapeTarget).length, 0, 'escape target received writes');
});

test('guard accepts a clean isolated copy (check-only)', (t) => {
  const root = freshRoot(t);
  const r = runGuard(root, { env: { RCOS_HOME: root }, args: ['--root', root, '--check-only'] });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /isolation-guard: OK/);
  assert.match(r.stderr, /manifest 22 files, registry 1 capability reuse-ledger/);
});

test('guard runs the real eval end-to-end in the isolated root and only there', (t) => {
  const root = freshRoot(t);
  const before = inventory(root);
  const r = runGuard(root, {
    env: { RCOS_HOME: root },
    args: ['--root', root, '--', 'node', 'bin/rcos', 'eval-run', '--eval', 'reuse-ledger-invariant-v1'],
  });
  assert.equal(r.status, 0, `eval-run through guard failed: ${r.stderr}`);
  assert.match(r.stdout, /ship — all 4 required gates pass/);
  // runs/ now exists INSIDE the root and nothing appeared outside it
  assert.ok(existsSync(join(root, 'runs')));
  const runIds = readdirSync(join(root, 'runs')).filter((n) => /^\d{8}T\d{6}Z-/.test(n));
  assert.equal(runIds.length, 1);
  assert.ok(readFileSync(join(root, 'runs', runIds[0], 'receipt.json'), 'utf8').includes('"run_id"'));
  const after = inventory(root);
  assert.ok(after.length > before.length, 'expected new artifacts inside the isolated root');
  // eval-verify through the guard on the fresh run
  const v = runGuard(root, {
    env: { RCOS_HOME: root },
    args: ['--root', root, '--', 'node', 'bin/rcos', 'eval-verify', '--run', runIds[0]],
  });
  assert.equal(v.status, 0, `eval-verify through guard failed: ${v.stderr}`);
  assert.match(v.stdout, /hash-clean/);
});

test('the disposable root is writable even when copied from a read-only source', (t) => {
  // PINS THE DECLARATION IN freshRoot. The fixture depends on its input being
  // readable and its copy being WRITABLE; when the gate began locking the tracked
  // execution inputs (P0.4) that second half stopped being free, because
  // `cpSync` propagates a file's mode. Without this test the dependency is only
  // observable when the whole suite happens to run under the gate — which is
  // exactly how it went unnoticed: `node --test test/isolation-guard.test.mjs`
  // was green for as long as nobody had locked the tree it copies from.
  const root = freshRoot(t);
  // An existing tracked file, a new file in an existing directory, and a new
  // directory — the three mutation routes the guard tests rely on.
  writeFileSync(join(root, 'lib', 'registry.js'), 'overwritten\n');
  writeFileSync(join(root, 'sneaky.txt'), 'not in the manifest\n');
  mkdirSync(join(root, 'probe-dir'));
  assert.equal(readFileSync(join(root, 'lib', 'registry.js'), 'utf8'), 'overwritten\n');
});
