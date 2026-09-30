#!/usr/bin/env node
/**
 * boot-smoke.mjs — prove the locked DSH host actually boots.
 *
 * Why this exists
 * ---------------
 * `@deepseek-ai/dsh@0.1.0-rc.6` declares FLOATING caret ranges on its Cordis
 * stack (`@deepseek-ai/cordis: ^4.0.1`, `cordis-plugin-hmr: ^1.0.16`, ...).
 * A fresh install therefore resolves whatever is newest at install time. Newer
 * Cordis/HMR releases dropped the `registerConfig()` hook that the rc.6
 * launcher calls, so a fresh install today dies at boot with:
 *
 *   dsh: user patch-layer watching requires the Cordis HMR service
 *
 * `host/package.json` pins that stack with npm `overrides`. This script is the
 * gate that proves the pin still produces a booting host. It is deliberately
 * an end-to-end observation (spawn the real CLI, wait for a real HTTP 200),
 * not a version-comparison assertion — a version list that matches the pin
 * while the host fails to boot is exactly the failure mode we are guarding.
 *
 * Usage:
 *   node scripts/boot-smoke.mjs                # host boot only
 *   node scripts/boot-smoke.mjs --with-plugin  # also install + probe the plugin
 *
 * Exit codes: 0 PASS, 1 FAIL.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_DSH_BIN = path.join(
  REPO_ROOT, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
);
const BUDGET_MS = Number(process.env.BOOT_SMOKE_BUDGET_MS || 120_000);
const WITH_PLUGIN = process.argv.includes('--with-plugin');

const PINNED = {
  '@deepseek-ai/dsh': '0.1.0-rc.6',
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/cordis-plugin-group': '1.0.2',
  '@deepseek-ai/cordis-plugin-hmr': '1.0.17',
  '@deepseek-ai/cordis-plugin-include': '1.0.7',
  '@deepseek-ai/cordis-plugin-loader': '1.0.3',
  '@deepseek-ai/cordis-plugin-timer': '1.1.4',
};

const report = { steps: [], verdict: 'FAIL', reason: null };
const say = (step, ok, detail) => {
  report.steps.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? '  — ' + detail : ''}`);
};

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** One HTTP GET, no proxy, short timeout. Returns {code, body} or null. */
function probe(port, urlPath = '/', timeout = 3000) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: urlPath, agent: false, timeout },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 4096) body += c; });
        res.on('end', () => resolve({ code: res.statusCode, body }));
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function readVersions(base) {
  const out = {};
  for (const pkg of Object.keys(PINNED)) {
    try {
      out[pkg] = JSON.parse(
        fs.readFileSync(path.join(base, pkg, 'package.json'), 'utf8'),
      ).version;
    } catch {
      out[pkg] = null;
    }
  }
  return out;
}

function pinCheck() {
  const mods = path.join(REPO_ROOT, 'host', 'node_modules');
  const got = readVersions(mods);
  const bad = Object.entries(PINNED).filter(([k, v]) => got[k] !== v);
  const detail = bad.length
    ? bad.map(([k, v]) => `${k}=${got[k] ?? '(absent)'} want ${v}`).join('; ')
    : Object.entries(got).map(([k, v]) => `${k.replace('@deepseek-ai/', '')}@${v}`).join(' ');
  say('locked tree matches the pin', bad.length === 0, detail);
  return bad.length === 0;
}

function pluginInstall(smoke, env) {
  const pnpm = spawnSync('pnpm', ['--version'], { env, encoding: 'utf8' });
  if (pnpm.status !== 0) {
    say('pnpm available (required by `dsh plugin`)', false,
      'pnpm not on PATH — `dsh plugin` forwards to pnpm');
    return false;
  }
  say('pnpm available (required by `dsh plugin`)', true, `pnpm ${pnpm.stdout.trim()}`);

  // The plugin install resolves the profile's bundle graph through pnpm and is
  // slow on a cold cache — a cold-cache run on the dev box was still going at
  // 19 minutes when it was interrupted, so the budget is deliberately generous
  // and the failure message says the timeout was the cause rather than leaving
  // it to look like a pnpm error.
  const r = spawnSync(
    process.execPath,
    [HOST_DSH_BIN, 'plugin', '--profile', 'web', 'add', REPO_ROOT, '--ignore-scripts'],
    { env, encoding: 'utf8', timeout: 900_000 },
  );
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = r.status === 0 && !/not found on PATH/.test(out);
  const why = r.error && /ETIMEDOUT/.test(String(r.error.code))
    ? `plugin install timed out after 900s (cold pnpm cache?)`
    : out.trim().split('\n').slice(-3).join(' | ');
  say('plugin installs into a disposable profile', ok,
    ok ? 'profile/web updated' : why);
  if (!ok) return false;

  const manifest = path.join(smoke, 'dsh-home', 'profiles', 'web', 'package.json');
  try {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const bundled = (m.dsh?.profile?.bundles || []).some((b) => /operator-ui/.test(b))
      || Object.keys(m.dependencies || {}).some((d) => /operator-ui/.test(d));
    say('plugin is registered in the profile', bundled,
      bundled ? 'dsh-operator-ui present' : 'not present in deps/bundles');
    return bundled;
  } catch (e) {
    say('plugin is registered in the profile', false, String(e.message));
    return false;
  }
}

async function bootAndProbe(smoke, port, label) {
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(smoke, 'home'),
    DSH_HOME: path.join(smoke, 'dsh-home'),
    NO_COLOR: '1',
    CI: '1',
  };
  const child = spawn(
    process.execPath,
    [HOST_DSH_BIN, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const t0 = Date.now();
  let code = null;
  let exited = null;
  child.on('exit', (c) => { exited = c; });

  while (Date.now() - t0 < BUDGET_MS) {
    if (exited !== null) break;
    const res = await probe(port);
    if (res && res.code >= 200 && res.code < 400) { code = res.code; break; }
    await new Promise((r) => setTimeout(r, 750));
  }

  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 500));
  try { child.kill('SIGKILL'); } catch { /* already gone */ }

  const errLine = out.split('\n').find((l) => /Error:/.test(l));
  if (code !== null) {
    say(`${label} answers HTTP`, true, `HTTP ${code} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return true;
  }
  say(`${label} answers HTTP`, false,
    exited !== null
      ? `exited rc=${exited}${errLine ? ' — ' + errLine.trim() : ''}`
      : `no HTTP answer within ${BUDGET_MS}ms${errLine ? ' — ' + errLine.trim() : ''}`);
  return false;
}

async function main() {
  console.log('boot-smoke: locked DSH host\n');

  if (!fs.existsSync(HOST_DSH_BIN)) {
    say('host is installed', false,
      `missing ${path.relative(REPO_ROOT, HOST_DSH_BIN)} — run: npm install --prefix host`);
    report.reason = 'host not installed';
    return finish(1);
  }
  say('host is installed', true, path.relative(REPO_ROOT, HOST_DSH_BIN));

  const pinOk = pinCheck();

  const smoke = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-smoke-'));
  fs.mkdirSync(path.join(smoke, 'home'), { recursive: true });
  fs.mkdirSync(path.join(smoke, 'dsh-home'), { recursive: true });

  let pluginOk = true;
  if (WITH_PLUGIN) {
    // NOTE: only DSH_HOME is disposable here. HOME is deliberately the real one:
    // pnpm keeps its content-addressable store under HOME, so pointing HOME at an
    // empty temp dir forces a full cold download of the profile's bundle graph.
    // That is almost certainly why an earlier manual run of this step was still
    // going at 19 minutes — the isolation that matters is DSH_HOME, not HOME.
    pluginOk = pluginInstall(smoke, {
      PATH: process.env.PATH, HOME: process.env.HOME,
      DSH_HOME: path.join(smoke, 'dsh-home'), CI: '1',
    });
  }

  const port = await freePort();
  const bootOk = await bootAndProbe(smoke, port, WITH_PLUGIN ? 'host+plugin' : 'host');

  const ok = pinOk && bootOk && pluginOk;
  report.verdict = ok ? 'PASS' : 'FAIL';
  report.reason = ok ? 'locked host boots' : 'see failed steps above';
  return finish(ok ? 0 : 1);
}

function finish(code) {
  console.log('\n' + JSON.stringify(report, null, 2));
  console.log(`\nboot-smoke: ${report.verdict}`);
  process.exit(code);
}

main().catch((e) => {
  say('boot-smoke crashed', false, e.stack || String(e));
  report.reason = 'unexpected error';
  finish(1);
});
