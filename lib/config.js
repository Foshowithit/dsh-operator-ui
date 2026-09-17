// dsh-operator-ui — portable configuration contract (Slice 1: CONFIGURABLE).
//
// operator-ui.config.json v1 lives at $DSH_HOME/operator-ui.config.json (see
// GENERIC-INSTALL-DESIGN.md §3.3). Resolution order per key:
//   explicit env var (back-compat, wins) → config file → default.
//
// What this file OWNS (operator-UI integration/configuration + references):
// endpoint URLs, file paths, timeouts, caps, viewport. What it NEVER owns:
// DSH/Archon/RCOS state, and NEVER secret values — archon.tokenVar names an
// ENV VAR holding a bearer token (name only; presence is reported, the value
// is read from the environment at request time and never echoed).
//
// Every reported leaf carries its source: 'env' | 'file' | 'default'.
// Invalid values fall back to the default and are recorded in `errors` —
// INVALID is a reported state, never a boot failure.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRESETS } from './authority.js';

export const CONFIG_VERSION = 1;
export const CONFIG_FILE_NAME = 'operator-ui.config.json';

export function getDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const home = process.env.HOME || '';
  return home ? join(home, '.dsh') : '.dsh';
}

export function configPath(home) {
  return join(home || getDshHome(), CONFIG_FILE_NAME);
}

export const DEFAULTS = {
  configVersion: 1,
  archon: { baseUrl: 'http://127.0.0.1:3090', tokenVar: null, timeoutMs: 5000 },
  registry: { path: '', schema: 'rcos-public-v1', maxBytes: 200_000 },
  browser: { chromePath: null, userDataDir: null, idleMs: 600_000, viewport: [1280, 800] },
  git: { bin: 'git', timeoutMs: 6000, maxDiffBytes: 300_000 },
  files: { maxEntries: 1000, maxReadBytes: 200_000 },
  authority: { preset: 'ASK_BEFORE_ACTION' },
  teaching: { workflowsDir: '', workspaceDir: '' },
  // PRODUCTION acquisition cognition (GPT productization). null = honest
  // NOT_CONFIGURED refusal — the engine never fabricates a candidate.
  acquisition: null,
  // FlowRouter portability (P0): publisher identity for EXPORT (adapter
  // concern — acquisition never invents one) and the local export dir.
  flowrouter: null,
};

function expandHome(p, home) {
  if (p === '~') return home;
  if (typeof p === 'string' && p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

// `~` in configured paths means the OPERATOR'S home ($HOME), the universal
// shell convention — never $DSH_HOME (a stranger writing ~/regs/reg.json
// expects their home dir, not a harness-internal path).

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

// Resolve the full config. Reads the file fresh on every call (restart-free;
// handlers call this per request). Never throws — a malformed file is
// reported in `errors` and the file layer is ignored.
export function resolveConfig(home) {
  const h = home || getDshHome();
  const userHome = process.env.HOME || h; // `~` expansion base (operator's home)
  const path = configPath(h);
  const errors = [];
  const sources = {};
  let file = null;
  let exists = false;

  try {
    const raw = readFileSync(path, 'utf8');
    exists = true;
    try {
      file = JSON.parse(raw);
    } catch (e) {
      errors.push({ key: '$file', message: 'config file is not valid JSON (' + String((e && e.message) || e).slice(0, 120) + ') — file layer ignored' });
      file = null;
    }
    if (file !== null && (typeof file !== 'object' || Array.isArray(file))) {
      errors.push({ key: '$file', message: 'config file root must be a JSON object — file layer ignored' });
      file = null;
    }
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      errors.push({ key: '$file', message: 'config file unreadable (' + String((e && e.message) || e).slice(0, 120) + ') — file layer ignored' });
    }
  }

  const fv = (section, key) =>
    file && typeof file[section] === 'object' && file[section] !== null ? file[section][key] : undefined;
  const bad = (key, message, fallback) => {
    errors.push({ key, message });
    sources[key] = 'default';
    return fallback;
  };

  const config = JSON.parse(JSON.stringify(DEFAULTS)); // deep copy of defaults

  // ---- archon ----
  if (process.env.DSH_OPERATOR_UI_ARCHON) {
    config.archon.baseUrl = process.env.DSH_OPERATOR_UI_ARCHON;
    sources['archon.baseUrl'] = 'env';
  } else if (fv('archon', 'baseUrl') !== undefined) {
    config.archon.baseUrl = fv('archon', 'baseUrl');
    sources['archon.baseUrl'] = 'file';
  } else {
    sources['archon.baseUrl'] = 'default';
  }
  try {
    const u = new URL(config.archon.baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http/https');
  } catch {
    config.archon.baseUrl = bad('archon.baseUrl', 'must be an absolute http(s) URL — using default', DEFAULTS.archon.baseUrl);
  }
  if (fv('archon', 'tokenVar') !== undefined) {
    const t = fv('archon', 'tokenVar');
    if (t === null) { config.archon.tokenVar = null; sources['archon.tokenVar'] = 'file'; }
    else if (typeof t === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) { config.archon.tokenVar = t; sources['archon.tokenVar'] = 'file'; }
    else config.archon.tokenVar = bad('archon.tokenVar', 'must be an env-var NAME (or null) — never a secret value', null);
  } else {
    sources['archon.tokenVar'] = 'default';
  }
  if (fv('archon', 'timeoutMs') !== undefined) {
    const t = fv('archon', 'timeoutMs');
    if (isInt(t) && t >= 500 && t <= 60000) { config.archon.timeoutMs = t; sources['archon.timeoutMs'] = 'file'; }
    else config.archon.timeoutMs = bad('archon.timeoutMs', 'must be an integer 500..60000 ms — using default', DEFAULTS.archon.timeoutMs);
  } else {
    sources['archon.timeoutMs'] = 'default';
  }

  // ---- registry ----
  if (process.env.DSH_OPERATOR_UI_REGISTRY) {
    config.registry.path = process.env.DSH_OPERATOR_UI_REGISTRY;
    sources['registry.path'] = 'env';
  } else if (fv('registry', 'path') !== undefined) {
    config.registry.path = fv('registry', 'path');
    sources['registry.path'] = 'file';
  } else {
    sources['registry.path'] = 'default';
  }
  if (typeof config.registry.path !== 'string') {
    config.registry.path = bad('registry.path', 'must be a string path — using default (unconfigured)', '');
  } else if (config.registry.path !== '') {
    const expanded = expandHome(config.registry.path, userHome);
    if (!expanded.startsWith('/')) {
      config.registry.path = bad('registry.path', 'relative paths rejected (portability) — use absolute or ~/ — using default (unconfigured)', '');
    } else {
      config.registry.path = expanded;
    }
  }
  if (fv('registry', 'schema') !== undefined) {
    const s = fv('registry', 'schema');
    if (typeof s === 'string' && s.length > 0) { config.registry.schema = s; sources['registry.schema'] = 'file'; }
    else config.registry.schema = bad('registry.schema', 'must be a non-empty schema name — using default', DEFAULTS.registry.schema);
  } else {
    sources['registry.schema'] = 'default';
  }
  if (fv('registry', 'maxBytes') !== undefined) {
    const m = fv('registry', 'maxBytes');
    if (isInt(m) && m >= 1024 && m <= 10_000_000) { config.registry.maxBytes = m; sources['registry.maxBytes'] = 'file'; }
    else config.registry.maxBytes = bad('registry.maxBytes', 'must be an integer 1024..10000000 — using default', DEFAULTS.registry.maxBytes);
  } else {
    sources['registry.maxBytes'] = 'default';
  }

  // ---- browser (boot-time knobs: read at apply(); file changes need restart — documented) ----
  if (process.env.DSH_OPERATOR_UI_CHROME) {
    config.browser.chromePath = process.env.DSH_OPERATOR_UI_CHROME;
    sources['browser.chromePath'] = 'env';
  } else if (fv('browser', 'chromePath') !== undefined) {
    const c = fv('browser', 'chromePath');
    if (c === null) { config.browser.chromePath = null; sources['browser.chromePath'] = 'file'; }
    else if (typeof c === 'string' && c !== '') { config.browser.chromePath = expandHome(c, userHome); sources['browser.chromePath'] = 'file'; }
    else config.browser.chromePath = bad('browser.chromePath', 'must be an absolute path or null — using default (auto-discover)', null);
  } else {
    sources['browser.chromePath'] = 'default';
  }
  if (fv('browser', 'userDataDir') !== undefined) {
    const u = fv('browser', 'userDataDir');
    if (u === null) { config.browser.userDataDir = null; sources['browser.userDataDir'] = 'file'; }
    else if (typeof u === 'string' && expandHome(u, userHome).startsWith('/')) { config.browser.userDataDir = expandHome(u, userHome); sources['browser.userDataDir'] = 'file'; }
    else config.browser.userDataDir = bad('browser.userDataDir', 'relative paths rejected — use absolute or ~/ — using default', null);
  } else {
    sources['browser.userDataDir'] = 'default';
  }
  if (fv('browser', 'idleMs') !== undefined) {
    const m = fv('browser', 'idleMs');
    if (isInt(m) && m >= 60000 && m <= 3600000) { config.browser.idleMs = m; sources['browser.idleMs'] = 'file'; }
    else config.browser.idleMs = bad('browser.idleMs', 'must be an integer 60000..3600000 ms — using default', DEFAULTS.browser.idleMs);
  } else {
    sources['browser.idleMs'] = 'default';
  }
  if (fv('browser', 'viewport') !== undefined) {
    const v = fv('browser', 'viewport');
    if (Array.isArray(v) && v.length === 2 && isInt(v[0]) && isInt(v[1]) && v[0] >= 320 && v[0] <= 4096 && v[1] >= 240 && v[1] <= 4096) {
      config.browser.viewport = [v[0], v[1]];
      sources['browser.viewport'] = 'file';
    } else {
      config.browser.viewport = bad('browser.viewport', 'must be [width,height] ints in range — using default', DEFAULTS.browser.viewport.slice());
    }
  } else {
    sources['browser.viewport'] = 'default';
  }

  // ---- git ----
  if (fv('git', 'bin') !== undefined) {
    const b = fv('git', 'bin');
    if (typeof b === 'string' && b.length > 0) { config.git.bin = b; sources['git.bin'] = 'file'; }
    else config.git.bin = bad('git.bin', 'must be a non-empty binary name/path — using default', DEFAULTS.git.bin);
  } else {
    sources['git.bin'] = 'default';
  }
  if (fv('git', 'timeoutMs') !== undefined) {
    const t = fv('git', 'timeoutMs');
    if (isInt(t) && t >= 1000 && t <= 60000) { config.git.timeoutMs = t; sources['git.timeoutMs'] = 'file'; }
    else config.git.timeoutMs = bad('git.timeoutMs', 'must be an integer 1000..60000 ms — using default', DEFAULTS.git.timeoutMs);
  } else {
    sources['git.timeoutMs'] = 'default';
  }
  if (fv('git', 'maxDiffBytes') !== undefined) {
    const m = fv('git', 'maxDiffBytes');
    if (isInt(m) && m >= 1024 && m <= 10_000_000) { config.git.maxDiffBytes = m; sources['git.maxDiffBytes'] = 'file'; }
    else config.git.maxDiffBytes = bad('git.maxDiffBytes', 'must be an integer 1024..10000000 — using default', DEFAULTS.git.maxDiffBytes);
  } else {
    sources['git.maxDiffBytes'] = 'default';
  }

  // ---- files ----
  if (fv('files', 'maxEntries') !== undefined) {
    const m = fv('files', 'maxEntries');
    if (isInt(m) && m >= 10 && m <= 20000) { config.files.maxEntries = m; sources['files.maxEntries'] = 'file'; }
    else config.files.maxEntries = bad('files.maxEntries', 'must be an integer 10..20000 — using default', DEFAULTS.files.maxEntries);
  } else {
    sources['files.maxEntries'] = 'default';
  }
  if (fv('files', 'maxReadBytes') !== undefined) {
    const m = fv('files', 'maxReadBytes');
    if (isInt(m) && m >= 1024 && m <= 10_000_000) { config.files.maxReadBytes = m; sources['files.maxReadBytes'] = 'file'; }
    else config.files.maxReadBytes = bad('files.maxReadBytes', 'must be an integer 1024..10000000 — using default', DEFAULTS.files.maxReadBytes);
  } else {
    sources['files.maxReadBytes'] = 'default';
  }

  // ---- authority (permissions round: operator preset over the scope contract —
  // a NAME only, never secrets; presets are personalities over scopes) ----
  if (process.env.DSH_OPERATOR_UI_AUTHORITY_PRESET) {
    const p = process.env.DSH_OPERATOR_UI_AUTHORITY_PRESET;
    if (PRESETS.includes(p)) { config.authority.preset = p; sources['authority.preset'] = 'env'; }
    else config.authority.preset = bad('authority.preset', 'must be one of ' + PRESETS.join('/') + ' — using default', DEFAULTS.authority.preset);
  } else if (fv('authority', 'preset') !== undefined) {
    const p = fv('authority', 'preset');
    if (PRESETS.includes(p)) { config.authority.preset = p; sources['authority.preset'] = 'file'; }
    else config.authority.preset = bad('authority.preset', 'must be one of ' + PRESETS.join('/') + ' — using default', DEFAULTS.authority.preset);
  } else {
    sources['authority.preset'] = 'default';
  }

  // ---- teaching (M2: WHERE learned-workflow artifacts may be written —
  // path REFERENCES only; empty = teaching reports NOT_CONFIGURED, honest) ----
  for (const [key, envName] of [
    ['workflowsDir', 'DSH_OPERATOR_UI_TEACH_WORKFLOWS'],
    ['workspaceDir', 'DSH_OPERATOR_UI_TEACH_WORKSPACE'],
  ]) {
    if (process.env[envName]) {
      const p = expandHome(process.env[envName], userHome);
      if (p.startsWith('/')) { config.teaching[key] = p; sources['teaching.' + key] = 'env'; }
      else config.teaching[key] = bad('teaching.' + key, 'must be an absolute path — using default (unconfigured)', '');
    } else if (fv('teaching', key) !== undefined) {
      const p = fv('teaching', key);
      if (typeof p === 'string' && expandHome(p, userHome).startsWith('/')) { config.teaching[key] = expandHome(p, userHome); sources['teaching.' + key] = 'file'; }
      else config.teaching[key] = bad('teaching.' + key, 'must be an absolute path (or ~/) — using default (unconfigured)', '');
    } else {
      sources['teaching.' + key] = 'default';
    }
  }

  // ---- acquisition (productization): cognition config for the proven
  // staged engine. Credential is an ENV VAR NAME only (never a path, never a
  // value). Budgets may only TIGHTEN the frozen ceilings.
  const acqRaw = file && typeof file === 'object' ? file.acquisition : undefined;
  let acq = null;
  if (acqRaw && typeof acqRaw === 'object' && !Array.isArray(acqRaw)) {
    const mode = acqRaw.mode === 'dsh' ? 'dsh' : acqRaw.mode === 'endpoint' ? 'endpoint' : null;
    if (!mode) {
      errors.push('acquisition.mode must be "endpoint" or "dsh" — acquisition stays NOT_CONFIGURED');
    } else if (mode === 'endpoint') {
      const endpoint = typeof acqRaw.endpoint === 'string' && /^https?:\/\//.test(acqRaw.endpoint) ? acqRaw.endpoint : null;
      const model = typeof acqRaw.model === 'string' && acqRaw.model ? acqRaw.model : null;
      const apiKeyEnv = typeof acqRaw.apiKeyEnv === 'string' && /^[A-Z][A-Z0-9_]*$/.test(acqRaw.apiKeyEnv) ? acqRaw.apiKeyEnv : null;
      if (!endpoint || !model || !apiKeyEnv) errors.push('acquisition endpoint mode needs endpoint (http(s)), model, apiKeyEnv (ENV VAR NAME) — acquisition stays NOT_CONFIGURED');
      else acq = { mode, endpoint, model, apiKeyEnv, sessionHeader: typeof acqRaw.sessionHeader === 'string' ? acqRaw.sessionHeader.slice(0, 80) : undefined };
    } else {
      const dshBin = typeof acqRaw.dshBin === 'string' && acqRaw.dshBin ? acqRaw.dshBin : 'dsh';
      acq = { mode, dshBin, workspaceDir: config.teaching.workspaceDir || '' };
    }
    if (acq && acqRaw.budget && typeof acqRaw.budget === 'object') {
      const cap = { maxRevisions: 3, maxCalls: 4, maxOutputTokens: 50000, maxWallMs: 600000 };
      const b = {};
      for (const k of Object.keys(cap)) {
        const v = acqRaw.budget[k];
        if (isInt(v) && v > 0) b[k] = Math.min(v, cap[k]); // tighten only
      }
      if (Object.keys(b).length) acq.budget = b;
    }
  } else if (acqRaw !== undefined) {
    errors.push('acquisition must be an object — acquisition stays NOT_CONFIGURED');
  }
  config.acquisition = acq;

  const frRaw = file && typeof file === 'object' ? file.flowrouter : undefined;
  let fr = null;
  if (frRaw && typeof frRaw === 'object' && !Array.isArray(frRaw)) {
    const publisher = typeof frRaw.publisher === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(frRaw.publisher) ? frRaw.publisher : null;
    const exportDir = typeof frRaw.exportDir === 'string' && frRaw.exportDir.startsWith('/') ? frRaw.exportDir : null;
    if (!publisher || !exportDir) errors.push('flowrouter needs publisher (lowercase slug) and exportDir (absolute path) — export stays NOT_CONFIGURED');
    else fr = { publisher, exportDir };
  } else if (frRaw !== undefined) {
    errors.push('flowrouter must be an object — export stays NOT_CONFIGURED');
  }
  config.flowrouter = fr;

  return { config, sources, errors, path, exists, home: h };
}

// The status-safe projection: tokenVar stays a NAME, plus a presence boolean.
// No secret value can appear here because no secret value ever enters the config.
export function redactedConfig(resolved) {
  const { config, sources, errors, path, exists } = resolved;
  const tokenVar = config.archon.tokenVar;
  return {
    path,
    exists,
    errors,
    archon: {
      baseUrl: config.archon.baseUrl,
      tokenVar,
      tokenConfigured: typeof tokenVar === 'string' ? !!process.env[tokenVar] : null,
      timeoutMs: config.archon.timeoutMs,
    },
    registry: { ...config.registry },
    browser: { ...config.browser },
    git: { ...config.git },
    files: { ...config.files },
    authority: { preset: config.authority.preset },
    teaching: { ...config.teaching },
    acquisition: config.acquisition ? { ...config.acquisition } : null,
    flowrouter: config.flowrouter ? { ...config.flowrouter } : null,
    sources,
  };
}
