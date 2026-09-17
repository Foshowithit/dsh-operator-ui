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
    // Scope the mutating-subcommand ban to the GIT route's own code (its
    // argv construction), where its intent lives — not to unrelated route
    // vocabulary elsewhere in the host (e.g. an import "stage" op name).
    const gitImpl = src.slice(src.indexOf('async function handleGit'));
    const gitBody = gitImpl.slice(0, gitImpl.indexOf('\nasync function '));
    for (const banned of ['commit', 'reset', 'rebase', 'merge', 'clean', 'checkout', 'restore', 'stage']) {
      const re = new RegExp(`['"]${banned}['"]`);
      if (re.test(gitBody)) throw new Error(f + ': mutating git subcommand found in the git route: ' + banned);
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

// 8. Slice 2 (verifiable): the verification contract is machine-checked.
// 8a. lib/verify.js: level vocabulary, seal, staleness fingerprints, and the
// no-bypass rule — dispatch must go through the registry-resolved workflow
// binding (no hardcoded workflow name in a URL, no parallel verify path).
check('verify: levels + seal + staleness + registry-routed dispatch', () => {
  const v = readFileSync(join(root, 'lib', 'verify.js'), 'utf8');
  for (const lvl of ['NOT_VERIFIED', 'SYSTEM_VERIFIED', 'RCOS_VERIFIED']) {
    if (!v.includes("'" + lvl + "'")) throw new Error('lib/verify.js lost level ' + lvl);
  }
  for (const must of ['seal', 'sha256', 'manifestSha256', 'registrySha256', 'configHash', 'seedSha256', 'readReceipt', 'TAMPERED', 'STALE']) {
    if (!v.includes(must)) throw new Error('lib/verify.js lost ' + must);
  }
  // No-bypass: the dispatch URL is built from the registry-resolved binding.
  if (/\/api\/workflows\/[a-z0-9-]+\/run/.test(v)) throw new Error('lib/verify.js hardcodes a workflow name into the dispatch URL — route through the registry binding');
  if (!v.includes("'/api/workflows/' + encodeURIComponent(workflowName) + '/run'")) {
    throw new Error('lib/verify.js does not dispatch via the registry-resolved workflowName');
  }
  const host = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
  if (!host.includes("GIT_ROUTE + '/verify'")) throw new Error('lib/index.js lost the /verify route');
  execFileSync(process.execPath, ['--check', join(root, 'lib', 'verify.js')], { stdio: 'pipe' });
});

// 8b. Seed bundle: tracked, zero-credential (bash nodes only — no AI/provider
// surface), and the registry fixture carries the seeded capability binding.
check('seed bundle: zero-credential workflow + clearly-marked seeded capability', () => {
  const seed = readFileSync(join(root, 'fixtures', 'verify-echo-v1.yaml'), 'utf8');
  if (!/^name:\s*verify-echo-v1/m.test(seed)) throw new Error('seed workflow name wrong');
  if (!/bash:\s*/.test(seed)) throw new Error('seed has no bash nodes — it must be zero-credential/deterministic');
  for (const banned of ['prompt:', 'command:', 'tiers:', 'aliases:', 'approval:', 'model:']) {
    if (seed.includes(banned)) throw new Error('seed must stay zero-credential but contains ' + banned);
  }
  const reg = JSON.parse(readFileSync(join(root, 'fixtures', 'capability-registry.example.json'), 'utf8'));
  const cap = (reg.capabilities || []).find((c) => c.id === 'rcos-verify-echo');
  if (!cap) throw new Error('registry fixture lost the seeded capability rcos-verify-echo');
  if (cap.seed !== true || cap.status !== 'seeded') throw new Error('seeded capability must be marked seed:true + status:seeded (never mistakable for production intelligence)');
  if (cap.workflow !== 'verify-echo-v1') throw new Error('seeded capability workflow binding wrong');
  if (!cap.verification || !cap.verification.expectOutput) throw new Error('seeded capability lacks its verification expectation');
});

// 8c. Manifest owns the verification contract; the client surfaces it inside
// an existing tab (no new tab).
check('manifest: verification section consistent with code + client has no new tab', () => {
  const m = JSON.parse(readFileSync(join(root, 'system-manifest.json'), 'utf8'));
  if (!m.verification) throw new Error('manifest lost the verification section');
  for (const lvl of ['NOT_VERIFIED', 'SYSTEM_VERIFIED', 'RCOS_VERIFIED']) {
    if (!m.verification.levels[lvl]) throw new Error('manifest verification.levels lost ' + lvl);
  }
  if (!m.verification.receiptFile.includes('receipt.json')) throw new Error('manifest verification.receiptFile wrong');
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
  if (!client.includes('SystemVerification')) throw new Error('client lost the system-verification section');
  const tabs = [...client.matchAll(/id:\s*'(runs|git|browser|summary|files|workflows|capabilities|system|work|intelligence)'/g)].map((x) => x[1]);
  const allowed = new Set(['runs', 'git', 'browser', 'summary', 'files', 'workflows', 'capabilities', 'system', 'work', 'intelligence']);
  for (const t of tabs) if (!allowed.has(t)) throw new Error('client registered an unknown tab: ' + t);
  // M0 separation-of-concerns gates: eligibility is derived, never copied;
  // the gate reads receipt freshness live instead of duplicating state.
  if (!/deriveEligibility/.test(client)) throw new Error('client lost derived routingEligibility');
  if (/routingEligibility\s*=\s*[^;]*lifecycle/i.test(client)) throw new Error('eligibility must be derived, not assigned from lifecycle state');
  if (!client.includes('GateOverlay') || !client.includes('opui-gate')) throw new Error('client lost the first-run gate');
  if (!/verify\?op=receipt/.test(client)) throw new Error('client must read receipt freshness from /verify, not re-derive it');
});

// 8d. Public-release hygiene (RC0): no private ecosystem names or developer
// machine paths leak into tracked files. Seeded/example content must read as
// generic — never as accumulated production intelligence.
check('hygiene: no private names or machine paths in tracked files', () => {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: root, stdio: 'pipe' }).toString().split('\n').filter(Boolean);
  } catch {
    tracked = [];
  }
  const hits = [];
  for (const f of tracked) {
    if (!/\.(js|mjs|json|yaml|yml|md)$/.test(f)) continue;
    let src;
    try { src = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    const body = src.replace(/\/\/[^\n]*/g, '');
    for (const banned of [/chow-[a-z]/i, /\/Users\/[a-z0-9]+\//i, /\bDell\b/i]) {
      if (banned.test(body)) hits.push(f);
    }
  }
  if (hits.length) throw new Error('private references in tracked files: ' + [...new Set(hits)].join(', '));
});

// 9. Goal Mode (M1): objective → registry routing → Archon
// execution → evidence verification → verdict. Routing truth stays in the
// registry; verification is independent of the act of execution. M1 adds the
// third check (objective-satisfaction), the trust ladder, and Next Action —
// surfaced by the Result Card inside the existing Work surfaces (no new tab).
check('goal: registry-routed runner + independent verification + task identity', () => {
  const g = readFileSync(join(root, 'lib', 'goal.js'), 'utf8');
  for (const must of ['SHIP', 'BLOCK', 'FAILED', 'taskId', 'routeObjective', 'considered', 'declared-expectation', 'terminal-status', 'objective-satisfaction', 'evaluateObjective', 'trustLadder', 'nextAction', 'objectiveEvaluation']) {
    if (!g.includes(must)) throw new Error('lib/goal.js lost ' + must);
  }
  if (/\/api\/workflows\/[a-z0-9-]+\/run/.test(g)) throw new Error('lib/goal.js hardcodes a workflow dispatch URL — route through the registry');
  if (!g.includes('registry not configured')) throw new Error('goal.js lost the registry-required refusal');
  const host = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
  if (!host.includes("GIT_ROUTE + '/goal'")) throw new Error('lib/index.js lost the /goal route');
  const tasks = readFileSync(join(root, 'lib', 'tasks.js'), 'utf8');
  for (const must of ['objective-evaluation', 'capability-validation', 'sealedBy', 'trust', 'nextAction']) {
    if (!tasks.includes(must)) throw new Error('lib/tasks.js lost ' + must);
  }
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
  if (!client.includes('GoalComposer')) throw new Error('client lost the goal composer');
  if (!client.includes('What do you want RCOS to do?')) throw new Error('client lost the give-work affordance');
  for (const must of ['ResultCard', 'deriveLadder', 'deriveNextKind', 'opui-result', 'opui-ladder']) {
    if (!client.includes(must)) throw new Error('client lost M1 surface ' + must);
  }
  // SpineCard references shared helpers — every referenced helper must be
  // DEFINED in the same module scope (a dropped helper crashes the overlay
  // tree: React #185 abdication, tab still shows, no visible error).
  for (const fn of ['extractNodeOutputs', 'deriveEligibility', 'resubmitGoal']) {
    if (client.includes(fn + '(') || client.includes(fn + ' (')) {
      const def = new RegExp('(const|function)\\s+' + fn + '\\b');
      if (!def.test(client)) throw new Error('client calls ' + fn + ' but never defines it');
    }
  }
  execFileSync(process.execPath, ['--check', join(root, 'lib', 'goal.js')], { stdio: 'pipe' });
});

// 10. Permissions round: presets over scopes, fail-closed, approval gating
// dispatch BEFORE any execution, granted policy riding the task envelope (no
// third store), Preview→Act→Prove rendered on the existing surfaces, and
// per-surface fault isolation (a card/surface may die; shell.overlay never).
check('authority: scope contract + approval gate before dispatch + envelope policy + fault isolation', () => {
  const au = readFileSync(join(root, 'lib', 'authority.js'), 'utf8');
  for (const must of ['filesystem:read', 'filesystem:write', 'shell:execute', 'credentials:use', 'git:push', 'external:submit',
    'PLAN_ONLY', 'ASK_BEFORE_ACTION', 'AUTO_WITHIN_POLICY', 'FULL_ACCESS',
    'grantsFor', 'requiresOf', 'decisionFor', 'humanScope', 'humanPreset']) {
    if (!au.includes(must)) throw new Error('lib/authority.js lost ' + must);
  }
  const cfg = readFileSync(join(root, 'lib', 'config.js'), 'utf8');
  for (const must of ["authority: { preset: 'ASK_BEFORE_ACTION' }", 'DSH_OPERATOR_UI_AUTHORITY_PRESET']) {
    if (!cfg.includes(must)) throw new Error('lib/config.js lost authority config: ' + must);
  }
  const g = readFileSync(join(root, 'lib', 'goal.js'), 'utf8');
  for (const must of ['requiresOf', 'decisionFor', 'awaiting-approval', 'approvedAt', "act('approve'"]) {
    if (!g.includes(must)) throw new Error('lib/goal.js lost authority wiring: ' + must);
  }
  // The gate must sit BEFORE the dispatch: an approval-required task can
  // never reach dispatchWorkflow in the same pass.
  const gateAt = g.indexOf("decision.mode === 'approval'");
  const dispatchAt = g.indexOf('await dispatchWorkflow(');
  if (gateAt < 0 || dispatchAt < 0 || gateAt > dispatchAt) throw new Error('authority gate must precede workflow dispatch');
  const host = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
  if (!host.includes('approveTaskId')) throw new Error('host lost the approval route');
  if (!host.includes('not awaiting approval')) throw new Error('approval must refuse tasks that are not awaiting approval');
  const tasks = readFileSync(join(root, 'lib', 'tasks.js'), 'utf8');
  for (const must of ['awaiting-approval', 'authority: goal.authority']) {
    if (!tasks.includes(must)) throw new Error('lib/tasks.js lost envelope policy: ' + must);
  }
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
  for (const must of ['Approve plan', 'RCOS plans to', 'approveTaskId', 'HUMAN_SCOPE', 'PRESET_LABEL']) {
    if (!client.includes(must)) throw new Error('client lost permissions surface: ' + must);
  }
  // Client human labels must cover exactly the host scope vocabulary — one
  // vocabulary, two tenses; a missing label would leak raw scope strings.
  const hostScopes = [...au.matchAll(/'([a-z]+:(?:read|write|execute|use|outbound|interact|draft|submit))'/g)].map((m) => m[1]);
  for (const s of new Set(hostScopes)) {
    if (!client.includes("'" + s + "'")) throw new Error('client HUMAN_SCOPE missing ' + s);
  }
  // Fault isolation: every registered surface is wrapped in CardBoundary and
  // the boundary never rethrows (no window.onerror rethrow / no bare throw).
  for (const surf of ['GitTab', 'BrowserTab', 'SummaryTab', 'FilesTab', 'WorkflowsTab', 'CapabilitiesTab', 'SystemSurface', 'WorkSurface', 'IntelligenceSurface', 'SurfaceOverlay']) {
    const re = new RegExp('h\\(CardBoundary,[^)]*h\\(' + surf + '\\b');
    if (!re.test(client)) throw new Error('surface not fault-isolated: ' + surf);
  }
  if (!client.includes('opui-card-dead')) throw new Error('client lost the killed-card fallback');
  const m = JSON.parse(readFileSync(join(root, 'system-manifest.json'), 'utf8'));
  if (!m.permissions || !Array.isArray(m.permissions.scopes) || !m.permissions.scopes.length) throw new Error('manifest lost the permissions section');
  for (const s of new Set(hostScopes)) {
    if (!m.permissions.scopes.includes(s)) throw new Error('manifest permissions.scopes missing ' + s);
  }
  execFileSync(process.execPath, ['--check', join(root, 'lib', 'authority.js')], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', join(root, 'lib', 'client.js')], { stdio: 'pipe' });
});

// 11. Teach Mode (M2): capability acquisition with three separate identities,
// an eval-before-candidate hard rule, explicit human promotion, and writes
// confined to the two operator-configured teaching paths.
check('teach: three identities + eval-before-candidate + explicit promotion + scoped writes', () => {
  const t = readFileSync(join(root, 'lib', 'teach.js'), 'utf8');
  for (const must of ['sourceTaskId', 'teachingTaskId', 'capabilityId', 'kind: \'teaching\'', 'CANDIDATE', 'REFUSED',
    'builtBy', 'EVAL_SET', 'requires', 'lifecycle', 'promotedAt', 'promoteCandidate', 'Not added to Intelligence']) {
    if (!t.includes(must)) throw new Error('lib/teach.js lost ' + must);
  }
  // Promotion must refuse non-candidates and duplicate ids (never overwrite).
  for (const must of ['not a CANDIDATE', 'already in the registry', 'requiresUnknown']) {
    if (!t.includes(must)) throw new Error('lib/teach.js lost promotion guard: ' + must);
  }
  const cfg = readFileSync(join(root, 'lib', 'config.js'), 'utf8');
  for (const must of ['DSH_OPERATOR_UI_TEACH_WORKFLOWS', 'DSH_OPERATOR_UI_TEACH_WORKSPACE']) {
    if (!cfg.includes(must)) throw new Error('lib/config.js lost teaching paths: ' + must);
  }
  const host = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
  if (!host.includes("GIT_ROUTE + '/teach'")) throw new Error('host lost the /teach route');
  if (!host.includes('promoteTaskId')) throw new Error('host lost the promotion route');
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
  for (const must of ['TeachingCard', 'Teach RCOS', 'Promote to Intelligence', 'teachFrom', 'RCOS learned this capability']) {
    if (!client.includes(must)) throw new Error('client lost teach surface: ' + must);
  }
  const m = JSON.parse(readFileSync(join(root, 'system-manifest.json'), 'utf8'));
  if (!m.teachMode || !m.teachMode.hardRule) throw new Error('manifest lost the teachMode section');
  execFileSync(process.execPath, ['--check', join(root, 'lib', 'teach.js')], { stdio: 'pipe' });
});

// 12. M2.5 Capability Memory: operating history is a READ MODEL over the
// task envelopes (no new store), decay is NAMED evidence — never a
// "confidence score" — and version lineage never overwrites history.

// Production acquisition (GPT productization of the sealed Eval v2 program):
// the proven mechanism ported into the product path. Contract properties:
// fail-closed cognition config, conjunctive budgets, static validation
// before ANY execution, redacted rename-loop refusal, objective evaluation
// (never the acquisition's own opinion) as the candidate gate, promotion via
// the existing explicit operator machinery only.
check('acquire: production acquisition — fail-closed, bounded, evaluate-then-candidate', () => {
  const a = readFileSync(join(root, 'lib', 'acquire.js'), 'utf8');
  for (const must of [
    'acquireCapability', 'staticValidate', 'ACQ_BUDGET',
    'maxRevisions: 3', 'maxCalls: 4', 'maxOutputTokens: 50000', 'maxWallMs: 600000',
    'ACQUISITION_NOT_CONFIGURED', 'BUDGET_EXHAUSTED', 'REVISIONS_EXHAUSTED', 'REVISION_LOOP',
    "kind: 'teaching'", 'evaluateObjective', 'verdict = \'CANDIDATE\'', "kind: 'promote'",
  ]) {
    if (!a.includes(must)) throw new Error('lib/acquire.js lost ' + must);
  }
  // never writes outside the configured teaching dirs, never reads credentials
  // from hardcoded paths (env only), never promotes itself
  if (/writeFile\([^)]*registry/.test(a)) throw new Error('acquisition must never write the registry — promotion is the operator click');
  const teachSrc = readFileSync(join(root, 'lib', 'teach.js'), 'utf8');
  if (/name:\s*'Workspace word count/.test(teachSrc)) throw new Error('promotion must derive the capability name from the candidate, never hardcode a demo name');
  if (new RegExp('chow' + '-secrets|\\/Users\\/').test(a)) throw new Error('acquisition must resolve credentials from env only');
  // static validation runs before any execute stage in the loop order
  const staticIdx = a.indexOf('staticValidate(parsed.yaml)');
  const execIdx = a.indexOf('runWorkflowOnArchon(name, t.objective');
  if (staticIdx < 0 || execIdx < 0 || staticIdx > execIdx) throw new Error('static validation must precede execution');
  const host = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
  if (!host.includes("GIT_ROUTE + '/acquire'")) throw new Error('host lost the /acquire route');
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
  if (!client.includes("'/plugins/operator-ui/acquire'")) throw new Error('gap affordance must call the production engine');
  execFileSync(process.execPath, ['--check', join(root, 'lib', 'acquire.js')], { stdio: 'pipe' });
});


// FlowRouter portability P0 (GPT-adjudicated contract): digest rule with
// the digest field omitted, namespaced identity + collision refusal,
// staged→verified→admitted state machine, B-local frozen verification
// fixtures, no networking, registry written ONLY by operator admission.
check('flowrouter: portability contract — digest rule, state machine, collision, no network', () => {
  const fr = readFileSync(join(root, 'lib', 'flowrouter.js'), 'utf8');
  for (const must of [
    'exportCapability', 'stagePackage', 'verifyImport', 'admitImport',
    'packageDigest', 'canonicalJson',
    'LOCAL_ID_COLLISION', 'INTEGRITY_FAIL', 'COMPATIBILITY_FAIL',
    'fixture_frozen_before_execution', 'STAGED', 'UNVERIFIED', 'INELIGIBLE',
    'VERIFIED', 'ELIGIBLE', 'MUST_NOT_EXPORT',
  ]) {
    if (!fr.includes(must)) throw new Error('lib/flowrouter.js lost ' + must);
  }
  // the digest rule must omit the digest fields during hashing
  if (!/bundle: \{ algorithm: 'sha256' \}/.test(fr)) throw new Error('package digest must be computed with the digest fields omitted');
  // receiver lifecycle starts closed and only admission opens routing
  if (!/local: \{ import: 'STAGED', verification: 'UNVERIFIED', routing: 'INELIGIBLE' \}/.test(fr)) throw new Error('receiver state must start STAGED/UNVERIFIED/INELIGIBLE');
  // registry writes exist ONLY in admitImport (operator admission)
  const writes = (fr.match(/writeFile\(cfg\.registry\.path/g) || []).length;
  if (writes !== 1) throw new Error('registry must be written exactly once, in admitImport');
  const admitIdx = fr.indexOf('export async function admitImport');
  const wIdx = fr.indexOf('writeFile(cfg.registry.path');
  if (admitIdx < 0 || wIdx < admitIdx) throw new Error('registry write must live inside admitImport');
  // no networking primitives beyond the LOCAL executor base URL
  if (/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(fr)) throw new Error('flowrouter P0 must not hardcode external URLs');
  const host = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
  if (!host.includes("GIT_ROUTE + '/flowrouter'")) throw new Error('host lost the /flowrouter route');
  execFileSync(process.execPath, ['--check', join(root, 'lib', 'flowrouter.js')], { stdio: 'pipe' });
});

check('memory: history read-model + named decay (no score) + lineage provenance', () => {
  const h = readFileSync(join(root, 'lib', 'history.js'), 'utf8');
  for (const must of ['capabilityHistory', 'listTasks', 'objectivesSatisfied', 'blocksAfterExecution', 'lastVerifiedAt', 'needsReevaluation', 'decayReason', 'recent']) {
    if (!h.includes(must)) throw new Error('lib/history.js lost ' + must);
  }
  if (/writeFile|mkdir|rename/.test(h)) throw new Error('history read-model must never write');
  if (/\bscore\s*[:=]/i.test(h) || /confidence\s*[:=]/i.test(h)) throw new Error('history must not collapse evidence into a confidence score');
  const host = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
  if (!host.includes("op === 'history'")) throw new Error('host lost the /rcos history op');
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
  for (const must of ['op=history', 'histLine', 'decayLine', 'Needs re-evaluation', 'learned via']) {
    if (!client.includes(must)) throw new Error('client lost memory surface: ' + must);
  }
  const m = JSON.parse(readFileSync(join(root, 'system-manifest.json'), 'utf8'));
  if (!m.memory || !m.memory.noScore) throw new Error('manifest lost the memory section');
  execFileSync(process.execPath, ['--check', join(root, 'lib', 'history.js')], { stdio: 'pipe' });
});

console.log(failures === 0 ? '\ncontract check: PASS' : `\ncontract check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
