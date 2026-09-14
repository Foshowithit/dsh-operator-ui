#!/usr/bin/env node
// dsh-operator-ui contract test — run before every push: `node scripts/check.js`
// Validates the four-way name alignment the DSH plugin loader requires plus
// basic file integrity. Exit 1 on any failure.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

// 6. Repo hygiene.
check('repo hygiene: no dev-home, node_modules, or logs tracked', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, stdio: 'pipe' }).toString().split('\n');
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
