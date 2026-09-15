// dsh-operator-ui — authoritative status surface (Slice 1: CONFIGURABLE).
//
// GET /plugins/operator-ui/status answers the stranger's question: "what RCOS
// pieces are configured, available, missing, invalid, or not yet verified?"
//
// Rules (from the Slice 1 authorization):
// - Every reported field names its authority. DSH-owned truth comes from DSH,
//   Archon-owned truth from Archon, registry truth from the registry file.
//   The operator UI owns only its own integration state.
// - Configuration is separated from observation: a configured Archon URL does
//   not mean Archon is AVAILABLE; an existing registry path does not mean its
//   schema is valid; a populated provider slot does not mean VERIFIED.
// - UNKNOWN, NOT_CONFIGURED, UNAVAILABLE, INVALID, and UNVERIFIED are distinct
//   states — never collapsed into one red light. Unknown is valid.
// - Live authoritative reads/probes per request; nothing is cached. Each probe
//   carries checkedAt; freshness facts (registry mtime, probe latency) are
//   exposed inline.
// - No secret value can appear here: config carries slot NAMES only, presence
//   booleans are reported, token values stay in process memory for one request.

import { spawn } from 'node:child_process';
import { stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, redactedConfig } from './config.js';

export function pluginRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

const isoNow = () => new Date().toISOString();

// Stable stringify so configHash is reproducible (same config ⇒ same hash).
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

export function configHash(redacted) {
  return 'sha256:' + createHash('sha256').update(stableStringify({ config: redacted, sources: redacted.sources })).digest('hex').slice(0, 32);
}

function base(cls, authority) {
  return {
    class: cls,            // core | surface | execution-adapter | integration | tool
    state: 'UNKNOWN',      // AVAILABLE | UNAVAILABLE | NOT_CONFIGURED | INVALID | NOT_INSTALLED | UNKNOWN
    configured: null,      // true/false, or null when the concept does not apply
    installed: null,
    available: null,       // true/false/null(unknown)
    verified: false,       // Slice 2 owns `true`; Slice 1 only ever reports false
    version: null,
    authority,
    source: null,          // where the reported value came from
    reason: null,          // actionable degraded reason, or null when healthy
    checkedAt: isoNow(),
  };
}

function srcLabel(resolved, key) {
  const s = resolved.sources[key];
  if (s === 'env') {
    const envName = { 'archon.baseUrl': 'DSH_OPERATOR_UI_ARCHON', 'registry.path': 'DSH_OPERATOR_UI_REGISTRY', 'browser.chromePath': 'DSH_OPERATOR_UI_CHROME' }[key];
    return envName ? 'env:' + envName : 'env';
  }
  if (s === 'file') return 'file:' + resolved.path;
  return 'default';
}

function runBin(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out: '', err: String((e && e.message) || e) });
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ code: -1, out, err: 'timed out' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 8000) out += d; });
    child.on('error', (e) => finish({ code: -1, out, err: String(e.message || e) }));
    child.on('close', (code) => finish({ code, out, err: '' }));
  });
}

// ------------------------------------------------------------------ archon

async function probeArchon(resolved) {
  const c = base('execution-adapter', 'live probe of the configured Archon HTTP API (same path the Workflows tab proxies)');
  const cfg = resolved.config.archon;
  c.source = srcLabel(resolved, 'archon.baseUrl');
  c.configured = true; // a URL is always resolved; `source` says whether anyone chose it
  const tokenVar = cfg.tokenVar;
  const tokenPresent = typeof tokenVar === 'string' ? !!process.env[tokenVar] : null;
  c.detail = { baseUrl: cfg.baseUrl, tokenSlot: tokenVar, tokenPresent };
  const headers = {};
  if (typeof tokenVar === 'string' && process.env[tokenVar]) {
    headers.authorization = 'Bearer ' + process.env[tokenVar]; // in-memory only, never reported
  }
  const t0 = Date.now();
  try {
    const res = await fetch(cfg.baseUrl + '/api/workflows', { headers, signal: AbortSignal.timeout(cfg.timeoutMs) });
    c.detail.latencyMs = Date.now() - t0;
    c.detail.httpStatus = res.status;
    if (!res.ok) {
      c.available = false;
      c.state = 'UNAVAILABLE';
      c.reason = 'Archon answered HTTP ' + res.status + ' at ' + cfg.baseUrl + ' (' + c.source + '). ' +
        (res.status === 401 || res.status === 403
          ? 'Authentication failed — check the ' + (tokenVar || '(no token slot configured)') + ' credential in its owning store.'
          : 'The endpoint is reachable but unhealthy — check the Archon server logs.');
      return c;
    }
    let body = null;
    try { body = await res.json(); } catch {}
    const list = body && (body.workflows || body.items || body.data);
    if (Array.isArray(list)) c.detail.workflows = list.length;
    c.available = true;
    c.state = 'AVAILABLE';
    return c;
  } catch (e) {
    const msg = String((e && e.message) || e);
    c.detail.latencyMs = Date.now() - t0;
    c.available = false;
    c.state = 'UNAVAILABLE';
    c.reason = 'Archon not reachable at ' + cfg.baseUrl + ' (' + c.source + '). ' +
      'Start Archon (`archon serve`, default :3090) or set archon.baseUrl in ' +
      resolved.path + ' (or DSH_OPERATOR_UI_ARCHON). Probe error: ' + msg.slice(0, 120);
    return c;
  }
}

// ------------------------------------------------------------------ registry

async function probeRegistry(resolved) {
  const c = base('core', 'live read of the configured registry file (RCOS-owned truth; this UI never edits it)');
  const cfg = resolved.config.registry;
  c.source = srcLabel(resolved, 'registry.path');
  c.detail = { path: cfg.path || null, schemaDeclared: cfg.schema, maxBytes: cfg.maxBytes };
  if (!cfg.path) {
    c.configured = false;
    c.available = false;
    c.state = 'NOT_CONFIGURED';
    c.reason = 'No capability registry configured. Set registry.path in ' + resolved.path +
      ' (or DSH_OPERATOR_UI_REGISTRY). For a first-run proof, point it at the tracked example fixture.';
    return c;
  }
  c.configured = true;
  let s;
  try {
    s = await stat(cfg.path);
  } catch {
    c.available = false;
    c.state = 'UNAVAILABLE';
    c.reason = 'Configured registry path does not exist: ' + cfg.path + ' (' + c.source + '). Fix the path or restore the file.';
    return c;
  }
  if (!s.isFile()) {
    c.available = false;
    c.state = 'INVALID';
    c.reason = 'Registry path is not a file: ' + cfg.path + ' (' + c.source + ').';
    return c;
  }
  c.detail.bytes = s.size;
  c.detail.mtime = new Date(s.mtimeMs).toISOString();
  if (s.size > cfg.maxBytes) {
    c.available = false;
    c.state = 'INVALID';
    c.reason = 'Registry file too large (' + s.size + ' > ' + cfg.maxBytes + ' bytes cap). Raise registry.maxBytes or shrink the registry.';
    return c;
  }
  let raw;
  try {
    raw = await readFile(cfg.path, 'utf8');
  } catch (e) {
    c.available = false;
    c.state = 'UNAVAILABLE';
    c.reason = 'Registry file unreadable: ' + String((e && e.message) || e).slice(0, 120);
    return c;
  }
  let reg;
  try {
    reg = JSON.parse(raw);
  } catch (e) {
    c.available = false;
    c.state = 'INVALID';
    c.reason = 'Registry file is not valid JSON (' + String((e && e.message) || e).slice(0, 100) + '). Fix or re-export the registry.';
    return c;
  }
  c.detail.schemaDetected = (reg && (reg.registry_version || reg.version)) || 'unknown';
  const caps = reg && reg.capabilities;
  if (!Array.isArray(caps)) {
    c.available = false;
    c.state = 'INVALID';
    c.reason = 'Registry parses but has no capabilities[] array (declared schema: ' + cfg.schema +
      ', detected: ' + c.detail.schemaDetected + '). Target the public canonical contract.';
    return c;
  }
  c.available = true;
  c.state = 'AVAILABLE';
  c.detail.capabilities = caps.length;
  return c;
}

// ------------------------------------------------------------------ git / chrome / node

async function probeGit(resolved) {
  const c = base('tool', 'local git binary (read-only fixed-argv use; same binary the Git tab shells)');
  const cfg = resolved.config.git;
  c.source = resolved.sources['git.bin'] === 'file' ? 'file:' + resolved.path : 'default';
  c.detail = { bin: cfg.bin, timeoutMs: cfg.timeoutMs, maxDiffBytes: cfg.maxDiffBytes };
  const r = await runBin(cfg.bin, ['--version'], Math.min(cfg.timeoutMs, 8000));
  if (r.code === 0) {
    c.installed = true;
    c.available = true;
    c.state = 'AVAILABLE';
    c.version = r.out.trim().slice(0, 60) || null;
  } else {
    c.installed = false;
    c.available = false;
    c.state = 'UNAVAILABLE';
    c.reason = 'git binary not runnable (' + cfg.bin + ', ' + c.source + '): ' + String(r.err || r.out).slice(0, 100) + '. Install git ≥ 2.30 — the Git/Files tabs need it.';
  }
  return c;
}

async function probeChrome(resolved, findChrome) {
  const c = base('integration', 'local Chrome/Chromium binary (the supervised Browser tab; OPTIONAL — human+agent driving only)');
  const cfg = resolved.config.browser;
  c.detail = { idleMs: cfg.idleMs, userDataDir: cfg.userDataDir || '<$DSH_HOME/operator-ui-browser>' };
  let candidate = null;
  if (cfg.chromePath) {
    candidate = cfg.chromePath;
    c.source = srcLabel(resolved, 'browser.chromePath');
  } else {
    try {
      candidate = findChrome ? findChrome() : null;
    } catch { candidate = null; }
    c.source = 'auto-discovery (fixed candidate list)';
  }
  c.detail.chromePath = candidate;
  if (candidate && existsSync(candidate)) {
    c.installed = true;
    c.available = true;
    c.state = 'AVAILABLE';
    const r = await runBin(candidate, ['--version'], 5000);
    if (r.code === 0 && r.out.trim()) c.version = r.out.trim().slice(0, 80);
  } else {
    c.installed = false;
    c.available = false;
    c.state = 'UNAVAILABLE';
    c.configured = cfg.chromePath ? true : false;
    c.reason = candidate
      ? 'Configured Chrome path does not exist: ' + candidate + ' (' + c.source + '). Fix browser.chromePath or unset it for auto-discovery.'
      : 'No Chrome/Chromium found (' + c.source + '). The Browser tab cannot start. Install Chrome/Chromium or set browser.chromePath in ' + resolved.path + ' (or DSH_OPERATOR_UI_CHROME). OPTIONAL — every other tab is unaffected.';
  }
  return c;
}

function probeNode() {
  const c = base('tool', 'process runtime (native WebSocket + AbortSignal.timeout need Node ≥ 22)');
  c.installed = true;
  c.available = true;
  c.configured = null;
  c.version = process.versions.node;
  const major = Number(process.versions.node.split('.')[0]);
  c.detail = { meetsMinimum: major >= 22 };
  if (major >= 22) {
    c.state = 'AVAILABLE';
  } else {
    c.state = 'INVALID';
    c.reason = 'Node ' + process.versions.node + ' < 22 — the Browser tab needs native WebSocket. Install Node ≥ 22.';
  }
  return c;
}

// ------------------------------------------------------------------ dsh / self / tools

function probeDsh() {
  const c = base('core', 'host runtime (this plugin is loaded inside DSH; version exposure deferred to Slice 2)');
  c.configured = null;
  c.installed = true;
  c.available = true;
  c.state = 'AVAILABLE';
  c.version = null;
  c.reason = null;
  return c;
}

function probeSelf(pkgVersion, resolved, redacted) {
  const c = base('surface', 'this plugin (package.json + live config resolution)');
  c.installed = true;
  c.available = true;
  c.state = 'AVAILABLE';
  c.version = pkgVersion;
  c.configured = redacted.exists;
  c.source = redacted.exists ? 'file:' + redacted.path : 'defaults (no config file)';
  c.detail = {
    configPath: redacted.path,
    configExists: redacted.exists,
    configErrors: redacted.errors,
    configHash: configHash(redacted),
  };
  if (redacted.errors.length > 0) {
    c.reason = redacted.errors.length + ' config value(s) invalid — fell back to defaults (see configErrors). Fix ' + redacted.path + '. State stays AVAILABLE: INVALID values never block boot.';
  }
  return c;
}

function probeTools(toolsUnavailable) {
  const c = base('integration', 'module resolution from the plugin tree (OPTIONAL peer @deepseek-ai/dsh-tools)');
  c.detail = { optional: true, tools: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type'] };
  if (toolsUnavailable) {
    c.installed = false;
    c.available = false;
    c.state = 'NOT_INSTALLED';
    c.reason = toolsUnavailable + ' OPTIONAL — human browser driving still works; agent driving is disabled until the peer resolves.';
  } else {
    c.installed = true;
    c.available = true;
    c.state = 'AVAILABLE';
  }
  return c;
}

// ------------------------------------------------------------------ provider slots
//
// Slot enumeration is data-driven from the TRACKED template
// (fixtures/providers.example.yaml) — presence only, never values. The owning
// store is $DSH_HOME/.env (DSH-owned); presence reflects this process's
// environment. A populated slot is CONFIGURED, never VERIFIED (Slice 2 owns
// live verification).

function parseProviderSlots(text) {
  // Minimal reader for OUR fixture format (not a general YAML parser):
  // `- row:` items carrying `envSlot:` + `state:`. Archon `role:` bindings
  // carry no `row:` so they never match.
  const slots = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const mRow = line.match(/^\s*-\s*row:\s*(\S+)\s*$/);
    if (mRow) { cur = { row: mRow[1], envSlot: null, required: null }; slots.push(cur); continue; }
    if (!cur) continue;
    const mEnv = line.match(/^\s*envSlot:\s*(\S+)\s*$/);
    if (mEnv) { cur.envSlot = mEnv[1]; continue; }
    const mState = line.match(/^\s*state:\s*(\S+)\s*$/);
    if (mState && !cur.required) cur.required = mState[1];
  }
  return slots.filter((s) => s.row && s.envSlot);
}

async function probeProviders(root) {
  const c = base('integration', '$DSH_HOME/.env via process environment (DSH-owned store; presence only — values never read, never reported)');
  c.detail = { template: 'fixtures/providers.example.yaml', slots: [] };
  let text;
  try {
    text = await readFile(join(root, 'fixtures', 'providers.example.yaml'), 'utf8');
  } catch (e) {
    c.state = 'UNKNOWN';
    c.reason = 'Provider template unreadable: ' + String((e && e.message) || e).slice(0, 100);
    return c;
  }
  const zeroProbe = (text.match(/^\s*zeroCredentialProbe:\s*(\S+)\s*$/m) || [])[1] || null;
  c.detail.zeroCredentialProbe = zeroProbe;
  let anyConfigured = false;
  for (const s of parseProviderSlots(text)) {
    const present = !!process.env[s.envSlot];
    if (present) anyConfigured = true;
    c.detail.slots.push({
      row: s.row,
      envSlot: s.envSlot,
      required: s.required || 'UNKNOWN',
      state: present ? 'CONFIGURED' : 'NOT_CONFIGURED',
      verified: false,
    });
  }
  c.configured = anyConfigured;
  c.available = null; // presence is not availability; Slice 2 proves live calls
  c.state = c.detail.slots.length ? 'AVAILABLE' : 'UNKNOWN';
  if (c.detail.slots.length) {
    c.reason = 'Slot presence only — a CONFIGURED slot is not VERIFIED. Live provider verification lands in Slice 2.';
  }
  return c;
}

// ------------------------------------------------------------------ entry

export async function buildStatus({ browser, findChrome, pkgVersion, toolsUnavailable }) {
  const resolved = resolveConfig();
  const redacted = redactedConfig(resolved);
  const root = pluginRoot();

  const [archon, rcos, git, chrome, providers] = await Promise.all([
    probeArchon(resolved),
    probeRegistry(resolved),
    probeGit(resolved),
    probeChrome(resolved, findChrome),
    probeProviders(root),
  ]);

  const node = probeNode();
  const dsh = probeDsh();
  const self = probeSelf(pkgVersion, resolved, redacted);
  const tools = probeTools(toolsUnavailable);

  // The supervised browser's LIVE viewport is the single source the client
  // scales clicks against (kills the host/client duplication trap). The
  // file-configured viewport applies at next browser start (documented
  // restart semantics); both are reported so drift is visible, never silent.
  let liveViewport = null;
  try { liveViewport = browser ? browser.status().viewport || null : null; } catch { liveViewport = null; }
  const configuredViewport = resolved.config.browser.viewport;
  const viewportRestartNeeded = Array.isArray(liveViewport) &&
    (liveViewport[0] !== configuredViewport[0] || liveViewport[1] !== configuredViewport[1]);

  return {
    ok: true,
    at: isoNow(),
    plugin: { name: 'dsh-operator-ui', version: pkgVersion },
    config: { ...redacted, hash: configHash(redacted) },
    viewport: { live: liveViewport, configured: configuredViewport, restartNeeded: !!viewportRestartNeeded },
    components: { dsh, operatorUi: self, archon, rcos, git, chrome, node, tools, providers },
  };
}
