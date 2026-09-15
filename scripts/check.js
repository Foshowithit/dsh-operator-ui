#!/usr/bin/env node
// dsh-operator-ui contract test — run before every push: `node scripts/check.js`
// Validates the four-way name alignment the DSH plugin loader requires plus
// basic file integrity. Exit 1 on any failure.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const ok = (label) => console.log('  ok  ' + label);
const fail = (label, detail) => { failures++; console.error('FAIL  ' + label + (detail ? ' — ' + detail : '')); };
const check = (label, fn) => {
  try { fn(); ok(label); } catch (e) { fail(label, e.message); }
};

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = pkg.name;

// 1. package.json shape: the loader contract lives in the `dsh` field.
check('package.json: dsh.client + dsh.bundle.patch declared', () => {
  if (!pkg.dsh || !pkg.dsh.client || pkg.dsh.client.platform !== 'web') throw new Error('dsh.client.platform must be "web"');
  if (!Array.isArray(pkg.dsh.client.inject) || pkg.dsh.client.inject.length === 0) throw new Error('dsh.client.inject missing');
  if (pkg.dsh.bundle?.patch !== './cordis.patch.yml') throw new Error('dsh.bundle.patch must be "./cordis.patch.yml"');
});

// 2. Bundle patch: exactly one insert row, named after the package.
check('cordis.patch.yml: single self-insert row matching package name', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  if (!/insert\s*:/.test(patch)) throw new Error('no "- insert:" row (top-level - id: rows cannot create plugins)');
  const m = patch.match(/name\s*:\s*['"]([^'"]+)['"]/);
  if (!m || m[1] !== name) throw new Error('insert row name ' + (m ? m[1] : '(none)') + ' != package name ' + name);
});

// 3. Client half: ModuleLoader id matches the package name (the served module
//    graph keys on it) and it declares the ctx services it uses.
check('lib/client.js: __ModuleLoader__ id matches package name', () => {
  const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
  if (!src.includes('__ModuleLoader__.load')) throw new Error('not a ModuleLoader module');
  const m = src.match(/id:\s*['"]([^'"]+)['"]/);
  if (!m || m[1] !== name) throw new Error('ModuleLoader id ' + (m ? m[1] : '(none)') + ' != package name ' + name);
  for (const face of ['slots', 'sessions']) {
    if (!src.includes(`'${face}'`) && !src.includes(`"${face}"`)) throw new Error('client apply does not reference ctx.' + face);
  }
});

// 4. Syntax of all lib files.
for (const f of ['lib/index.js', 'lib/client.js', 'lib/browser.js']) {
  check(f + ': parses', () => {
    execFileSync(process.execPath, ['--check', join(root, f)], { stdio: 'pipe' });
  });
}

// 5. Host half: every host file stays read-only (no mutating git ops, no shell).
check('host half: read-only (fixed argv, no shell)', () => {
  for (const f of ['lib/index.js', 'lib/browser.js']) {
    const src = readFileSync(join(root, f), 'utf8');
    if (/spawn\([^,]+,\s*['"`]/.test(src) && !/spawn\(\s*(GIT|chrome),/.test(src)) throw new Error(f + ': unexpected bare spawn');
    if (/\bexec(Sync)?\(|\bexecFile(Sync)?\(/.test(src.replace(/\/\/[^\n]*/g, ''))) throw new Error(f + ': shell-executing helpers are banned; use spawn with argv arrays');
    for (const banned of ['commit', 'reset', 'rebase', 'merge', 'clean', 'checkout', 'restore', 'stage']) {
      const re = new RegExp(`['"]${banned}['"]`);
      if (re.test(src)) throw new Error(f + ': mutating git subcommand found: ' + banned);
    }
  }
});

// 6. Slice 0 (generic install): node version, peer resolution, zip tolerance.
// 6a. Node >= 22 (native WebSocket in lib/browser.js; AbortSignal.timeout).
check('runtime: node >= 22', () => {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) throw new Error('node ' + process.versions.node + ' < 22 — the Browser tab needs native WebSocket');
});

// 6b. Peer resolution: cordis is host-provided (the plugin never imports it —
// the loader injects ctx), so assert no lib file imports it directly; dsh-tools
// is OPTIONAL (graceful-degrade path in lib/index.js) but its absence must be
// VISIBLE, not silent — so check that the degrade path exists.
check('peers: cordis host-provided; dsh-tools absence degrades honestly', () => {
  for (const f of ['lib/index.js', 'lib/client.js', 'lib/browser.js']) {
    const src = readFileSync(join(root, f), 'utf8');
    if (src.includes("from '@deepseek-ai/cordis'") || src.includes('from "@deepseek-ai/cordis"'))
      throw new Error(f + ' imports cordis directly — the host provides the seam via ctx');
  }
  if (!pkg.peerDependencies?.['@deepseek-ai/cordis'] || !pkg.peerDependencies?.['@deepseek-ai/dsh-tools'])
    throw new Error('package.json peerDependencies must declare both cordis and dsh-tools ranges');
  const require = createRequire(join(root, 'package.json'));
  let toolsResolve = true;
  try { require.resolve('@deepseek-ai/dsh-tools'); } catch { toolsResolve = false; }
  const host = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
  if (!host.includes('TOOLS_UNAVAILABLE')) throw new Error('lib/index.js lost the TOOLS_UNAVAILABLE degrade path');
  if (!host.includes('toolsAvailable')) throw new Error('lib/index.js lost the toolsAvailable status field');
  if (!toolsResolve) console.log('  note dsh-tools peer absent — degrade path present (browser agent tools honestly disabled)');
});

// 6c. Repo hygiene.
check('repo hygiene: no dev-home, node_modules, or logs tracked', () => {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: root, stdio: 'pipe' }).toString().split('\n');
  } catch {
    // Zip download, not a clone: fall back to a working-tree scan (gitignore
    // semantics approximated — dev-home/ and node_modules/ must be absent).
    console.log('  note not a git clone — scanning working tree instead');
    tracked = [];
    const walk = (dir, prefix) => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        const rel = prefix + e;
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          if (e === 'node_modules' || e === 'dev-home' || e === '.git') { tracked.push(rel + '/(dir present)'); continue; }
          walk(full, rel + '/');
        } else if (/\.log$/.test(e)) tracked.push(rel);
      }
    };
    walk(root, '');
  }
  const bad = tracked.filter((f) => /^(dev-home|node_modules)\//.test(f) || /\.log$/.test(f));
  if (bad.length) throw new Error('tracked: ' + bad.join(', '));
});
check('repo hygiene: required files present', () => {
  for (const f of ['README.md', 'LICENSE', 'docs/runs-panel.png', 'docs/git-panel.png', 'docs/command-palette.png']) {
    readFileSync(join(root, f));
  }
});

console.log(failures === 0 ? '\ncontract check: PASS' : `\ncontract check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
