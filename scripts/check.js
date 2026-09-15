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

// 7. Slice 1 (configurable): the portable contract is machine-checked.
// 7a. system-manifest.json parses, carries the required sections, and every
// envOverrides name is a real DSH_OPERATOR_UI_* override the code reads.
check('manifest: parses + owns env table + matches code', () => {
  const m = JSON.parse(readFileSync(join(root, 'system-manifest.json'), 'utf8'));
  if (m.manifestVersion !== 1) throw new Error('manifestVersion must be 1');
  for (const section of ['components', 'configFile', 'envOverrides', 'statusRoute', 'credentials']) {
    if (!m[section]) throw new Error('manifest missing section: ' + section);
  }
  for (const comp of ['dsh', 'archon', 'rcos', 'operator-ui']) {
    if (!m.components[comp]) throw new Error('manifest missing component: ' + comp);
  }
  const code = ['lib/index.js', 'lib/browser.js', 'lib/config.js', 'lib/status.js']
    .map((f) => readFileSync(join(root, f), 'utf8')).join('\n');
  // `$`-prefixed keys are manifest comments, not env names.
  const owned = Object.keys(m.envOverrides).filter((k) => !k.startsWith('$'));
  for (const name of owned) {
    if (!code.includes(name)) throw new Error('manifest envOverrides.' + name + ' is not read anywhere in lib/');
  }
  // No override exists in code without manifest ownership (grep whole lib/).
  const inCode = new Set(code.match(/DSH_OPERATOR_UI_[A-Z_]+/g) || []);
  for (const name of inCode) {
    if (!m.envOverrides[name]) throw new Error('code reads ' + name + ' but the manifest does not own it');
  }
});

// 7b. DEPLOY.md's env table is generated-from/checked-against the manifest —
// every manifest override is documented, every documented one is owned.
check('manifest: DEPLOY.md documents exactly the owned env table', () => {
  const m = JSON.parse(readFileSync(join(root, 'system-manifest.json'), 'utf8'));
  const deploy = readFileSync(join(root, 'DEPLOY.md'), 'utf8');
  const owned2 = Object.keys(m.envOverrides).filter((k) => !k.startsWith('$'));
  for (const name of owned2) {
    if (!deploy.includes(name)) throw new Error('DEPLOY.md never documents ' + name);
  }
  const inDeploy = new Set(deploy.match(/DSH_OPERATOR_UI_[A-Z_]+/g) || []);
  for (const name of inDeploy) {
    if (!m.envOverrides[name]) throw new Error('DEPLOY.md documents ' + name + ' but the manifest does not own it');
  }
});

// 7c. The example config fixture parses and matches the code DEFAULTS shape
// (a stranger's first config must be a valid config).
check('config: example fixture parses + matches DEFAULTS', () => {
  const ex = JSON.parse(readFileSync(join(root, 'fixtures', 'operator-ui.config.example.json'), 'utf8'));
  if (ex.configVersion !== 1) throw new Error('example configVersion must be 1');
  const cfgSrc = readFileSync(join(root, 'lib', 'config.js'), 'utf8');
  for (const section of ['archon', 'registry', 'browser', 'git', 'files']) {
    if (typeof ex[section] !== 'object' || ex[section] === null)
      throw new Error('example missing section: ' + section);
    for (const key of Object.keys(ex[section])) {
      if (key === '$comment') continue;
      if (!cfgSrc.includes(key)) throw new Error('example key ' + section + '.' + key + ' unknown to lib/config.js');
    }
  }
  for (const f of ['lib/config.js', 'lib/status.js']) {
    execFileSync(process.execPath, ['--check', join(root, f)], { stdio: 'pipe' });
  }
});

// 7d. Status vocabulary: the six states stay distinct, verified:true is never
// reported by Slice 1 probes, and no unreachable panel hardcodes the default.
check('status: vocabulary distinct + VERIFIED deferred + no hardcoded defaults', () => {
  const st = readFileSync(join(root, 'lib', 'status.js'), 'utf8');
  for (const s of ['AVAILABLE', 'UNAVAILABLE', 'NOT_CONFIGURED', 'INVALID', 'NOT_INSTALLED', 'UNKNOWN']) {
    if (!st.includes("'" + s + "'")) throw new Error('lib/status.js lost state ' + s);
  }
  if (/verified:\s*true/.test(st)) throw new Error('Slice 1 must never report verified:true (Slice 2 owns live verification)');
  const host = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
  if (!host.includes('/status')) throw new Error('lib/index.js lost the /status route');
  if (!host.includes('resolveConfig')) throw new Error('lib/index.js lost per-request config resolution');
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
  if (client.includes('127.0.0.1:3090')) throw new Error('lib/client.js hardcodes the Archon default — read /status instead');
  for (const api of ['visualViewport', 'innerWidth', 'devicePixelRatio', 'matchMedia']) {
    if (client.includes(api)) throw new Error('lib/client.js sniffs browser geometry via ' + api + ' — viewport is single-source from /browser/status');
  }
});

// 7e. No-secret-literals lint (§3.5): no secret-looking values in tracked
// files. Slot NAMES (e.g. DSH_PROVIDER_API_KEY) are allowed; assignments of
// opaque token-ish strings are not.
check('secrets: no secret-looking literals in tracked files', () => {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: root, stdio: 'pipe' }).toString().split('\n').filter(Boolean);
  } catch {
    tracked = [];
  }
  const allow = new Set(['system-manifest.json', 'scripts/check.js']);
  const suspects = [];
  for (const f of tracked) {
    if (!/\.(js|mjs|json|yaml|yml|md)$/.test(f)) continue;
    if (f.startsWith('dev-home/') || f.startsWith('node_modules/')) continue;
    let src;
    try { src = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const body = line.replace(/\/\/[^\n]*/g, '');
      // Bearer assignments, sk-/ghp-/xox-style tokens, long base64-ish values.
      if (/authorization['"]?\s*:\s*['"]Bearer\s+[A-Za-z0-9\-_.~+/=]{8}|['"](sk-[A-Za-z0-9]{8}|ghp_[A-Za-z0-9]{8}|xox[bpas]-[A-Za-z0-9-]{6}|AIza[A-Za-z0-9\-_]{10}|eyJ[A-Za-z0-9\-_]{12})/.test(body)) {
        if (!allow.has(f)) suspects.push(f + ':' + (i + 1));
      }
      // Generic KEY = "opaque value" assignments, excluding slot names,
      // URLs, paths, version pins, and documented placeholders.
      const m = body.match(/^\s*['"]?([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))['"]?\s*[:=]\s*['"]([^'"]+)['"]/);
      if (m && !/^(DSH_|<|https?:|~\/|\/|\$|v?\d+\.|null$)/.test(m[2]) && m[2].length >= 8 && !allow.has(f)) {
        suspects.push(f + ':' + (i + 1) + ' (' + m[1] + ')');
      }
    });
  }
  if (suspects.length) throw new Error('possible secret literals: ' + suspects.join(', '));
});

console.log(failures === 0 ? '\ncontract check: PASS' : `\ncontract check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
