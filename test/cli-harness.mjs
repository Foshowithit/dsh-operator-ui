// Shared harness for the runtime-surface tests (doctor / install / verify).
//
// This file is a HELPER, not a test entrypoint: it is named by the test files
// that import it, which is what scripts/check.js requires of every .mjs under a
// test/ directory that the canonical set excludes.
//
// WHAT IT BUILDS: a synthetic DSH host — a profile directory, a config file
// pointing at a stub Archon and a real registry fixture, and a stub `dsh`
// binary. Every test drives the REAL lib/cli.js against that host. Nothing here
// reimplements the installer, the registration reader, or the verdict rules; the
// harness only controls the ENVIRONMENT those rules are evaluated against, so a
// passing test cannot diverge from the production path.

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const NODE = process.execPath;
export const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
export const CLI_BIN = join(REPO, 'bin', 'dsh-operator-ui.mjs');

const PROFILE_PKG = (bundles) => JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dsh: { profile: { bundles } },
}, null, 2) + '\n';

// The stub Archon is INLINE rather than a sibling file on purpose: scripts/check.js
// refuses any .mjs under a test/ directory that no test entrypoint names, and a
// second stub file would be exactly that orphan. It is passed to a child process
// as an inline module so it also cannot share this process's event loop — a
// spawnSync against a server living in the same process deadlocks (measured: the
// first version of this harness hung for five minutes with zero output).
const STUB_ARCHON_SRC = `
import { createServer } from 'node:http';
const server = createServer((req, res) => {
  if (req.url === '/api/workflows') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ workflows: [{ name: 'verify-echo-v1' }] }));
    return;
  }
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: 'stub-1.0.0' }));
    return;
  }
  res.writeHead(404); res.end('{}');
});
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
`;

/** Start the stub Archon as its own process and return { port, stop }. */
export async function startStubArchon({ offline = false } = {}) {
  if (offline) return { port: 1, stop: () => {} };  // port 1 refuses connections
  const child = spawn(NODE, ['--input-type=module', '-e', STUB_ARCHON_SRC], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('stub archon did not report a port')), 10000);
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) { clearTimeout(t); res(Number(buf.trim())); }
    });
  });
  return { port, stop: () => child.kill() };
}

/**
 * A fresh scratch directory.
 *
 * Scratch directories are deliberately NOT deleted by these tests. The host
 * enforces a per-turn bulk-delete guard (`SAFE_DELETE_BULK_CONFIRM_REQUIRED`),
 * and a suite that recursively removes a dozen synthetic DSH homes crosses it —
 * measured: the frozen-snapshot gate failed 12 cases that pass in the live tree,
 * two of them solely because a cleanup delete tripped the guard. Nothing here
 * needs a tree to be destroyed in order to be tested, so nothing destroys one.
 * The OS reaps its own temp area; the cost is a few MB of files under $TMPDIR.
 */
export function scratch(label = 'opui') {
  return mkdtempSync(join(tmpdir(), label + '-'));
}

/**
 * Create a synthetic host.
 *
 * Returns handles plus a `snapshot()` that hashes the whole home, which is how
 * the read-only and preflight-before-mutation claims are measured rather than
 * asserted.
 */
export function makeHost({ home, archonPort, profile = 'web', bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], registry = 'valid', dshVersion = '0.1.0-rc.6', withProfile = true } = {}) {
  mkdirSync(join(home, 'operator-ui'), { recursive: true });

  if (withProfile) {
    mkdirSync(join(home, 'profiles', profile), { recursive: true });
    writeFileSync(join(home, 'profiles', profile, 'package.json'), PROFILE_PKG(bundles));
  }

  let registryPath = null;
  if (registry === 'valid') {
    registryPath = join(home, 'registry.json');
    copyFileSync(join(REPO, 'fixtures', 'capability-registry.example.json'), registryPath);
  } else if (registry === 'invalid') {
    registryPath = join(home, 'registry.json');
    writeFileSync(registryPath, '{ not json');
  } else if (registry === 'missing-file') {
    registryPath = join(home, 'nope.json');
  }

  const config = { configVersion: 1, archon: { baseUrl: 'http://127.0.0.1:' + archonPort } };
  if (registryPath) config.registry = { path: registryPath };
  writeFileSync(join(home, 'operator-ui.config.json'), JSON.stringify(config, null, 2) + '\n');

  const stubDsh = join(home, 'stub-dsh');
  writeFileSync(stubDsh, '#!/bin/sh\necho ' + dshVersion + '\n');
  chmodSync(stubDsh, 0o755);

  return {
    home,
    profile,
    registryPath,
    stubDsh,
    env: { ...process.env, DSH_HOME: home, DSH_OPERATOR_UI_DSH_BIN: stubDsh },
    /** Content hash of every file under the home, for before/after comparison. */
    snapshot() {
      const h = createHash('sha256');
      const walk = (dir, prefix) => {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
          const rel = prefix ? prefix + '/' + e.name : e.name;
          const full = join(dir, e.name);
          if (e.isSymbolicLink()) { h.update(rel + '\0link\n'); continue; }
          if (e.isDirectory()) { walk(full, rel); continue; }
          try { h.update(rel + '\0' + statSync(full).size + '\0' + createHash('sha256').update(readFileSync(full)).digest('hex') + '\n'); }
          catch { h.update(rel + '\0unreadable\n'); }
        }
      };
      walk(home, '');
      return h.digest('hex');
    },
    /** Raw file listing of the home, so a test can name what appeared. */
    list() {
      const out = [];
      const walk = (dir, prefix) => {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const rel = prefix ? prefix + '/' + e.name : e.name;
          out.push(rel + (e.isDirectory() ? '/' : ''));
          if (e.isDirectory() && !e.isSymbolicLink()) walk(join(dir, e.name), rel);
        }
      };
      walk(home, '');
      return out.sort();
    },
  };
}

/** Run the CLI in a child process. Returns { code, stdout, stderr }. */
export function runCli(args, { env, bin = CLI_BIN, cwd = REPO } = {}) {
  const r = spawnSync(NODE, [bin, ...args], { encoding: 'utf8', env, cwd });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Run the CLI in-process (same code path, no child) — for verdict unit tests. */
export async function runCliInProcess(args, { env, cwd } = {}) {
  const cli = await import('../lib/cli.js');
  const chunks = { out: '', err: '' };
  const stdout = { write: (s) => { chunks.out += s; } };
  const stderr = { write: (s) => { chunks.err += s; } };
  const prevCwd = process.cwd();
  const prevHome = process.env.DSH_HOME;
  const prevBin = process.env.DSH_OPERATOR_UI_DSH_BIN;
  if (cwd) process.chdir(cwd);
  process.env.DSH_HOME = env.DSH_HOME;
  if (env.DSH_OPERATOR_UI_DSH_BIN) process.env.DSH_OPERATOR_UI_DSH_BIN = env.DSH_OPERATOR_UI_DSH_BIN;
  try {
    const code = await cli.main(args, { env, stdout, stderr });
    return { code, stdout: chunks.out, stderr: chunks.err };
  } finally {
    if (cwd) process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    if (prevBin === undefined) delete process.env.DSH_OPERATOR_UI_DSH_BIN; else process.env.DSH_OPERATOR_UI_DSH_BIN = prevBin;
  }
}

/**
 * A standalone copy of the package that can be edited freely.
 *
 * Two uses: `corruptEntry: true` produces a package whose module graph cannot
 * load (the rollback test needs a failure that happens AFTER the durable copy and
 * the registration exist), and `corruptEntry: false` produces a package a test
 * may legitimately modify — for example to give its manifest a `gitHead`, which
 * is what a branch-packed artifact carries and what a detached-worktree pack
 * does not.
 */
export function makeSourceCopy(dest, { corruptEntry = false } = {}) {
  mkdirSync(join(dest, 'lib'), { recursive: true });
  mkdirSync(join(dest, 'bin'), { recursive: true });
  copyFileSync(join(REPO, 'package.json'), join(dest, 'package.json'));
  copyFileSync(join(REPO, 'cordis.patch.yml'), join(dest, 'cordis.patch.yml'));
  copyFileSync(join(REPO, 'bin', 'dsh-operator-ui.mjs'), join(dest, 'bin', 'dsh-operator-ui.mjs'));
  for (const f of readdirSync(join(REPO, 'lib'))) {
    if (!f.endsWith('.js')) continue;
    copyFileSync(join(REPO, 'lib', f), join(dest, 'lib', f));
  }
  // `copyFileSync` propagates a FILE's mode, and these tests may be running out of
  // a tree whose write bits the gate has cleared. A fixture whose stated purpose
  // is to be EDITED must be editable, so the modes are normalised rather than
  // inherited — otherwise the test fails with EACCES in the snapshot and passes
  // in the working tree, which is exactly the divergence the gate caught.
  for (const dir of [dest, join(dest, 'lib'), join(dest, 'bin')]) chmodSync(dir, 0o755);
  for (const rel of ['package.json', 'cordis.patch.yml', 'bin/dsh-operator-ui.mjs']) {
    chmodSync(join(dest, ...rel.split('/')), 0o644);
  }
  for (const f of readdirSync(join(dest, 'lib'))) chmodSync(join(dest, 'lib', f), 0o644);
  if (corruptEntry) {
    // A module graph that cannot load. This is the failure the rollback path
    // exists for: it happens AFTER the durable copy and the registration exist.
    writeFileSync(join(dest, 'lib', 'index.js'), 'throw new Error("corrupt entry (rollback test)");\n');
  }
  return dest;
}
