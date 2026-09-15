// dsh-operator-ui — host half.
//
// Two responsibilities, both read-only toward the world:
//   1. /plugins/operator-ui/git  — read-only git summary for the Git tab.
//   2. /plugins/operator-ui/browser* — the supervised on-screen browser
//      ("browser with a leash"): ONE owned Chromium the agent drives via the
//      browser_* tools and the human watches live over SSE. See lib/browser.js
//      for the leash rules (single instance, idle reaper, http/https only).
//
// Route disposal rides the plugin fiber — removing the plugin removes every
// route and kills the supervised browser.

import { spawn } from 'node:child_process';
import { stat, readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join as pathJoin, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserSupervisor, findChrome } from './browser.js';
import { resolveConfig } from './config.js';
import { buildStatus, unwrapCatalog } from './status.js';
import { runVerification, readReceipt } from './verify.js';

// Plugin version for the /status surface (package.json, read once —
// the version cannot change without a reinstall).
let PKG_VERSION = null;
try {
  const pkgRaw = readFileSync(pathJoin(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8');
  PKG_VERSION = JSON.parse(pkgRaw).version || null;
} catch {
  PKG_VERSION = null;
}

// Slice 0 (generic install): @deepseek-ai/dsh-tools is a PEER dependency, and
// `link:` installs do not install peers — so a clean clone must NOT die here.
// Resolve it lazily: when absent, the plugin still boots and serves every tab,
// but the four browser_* agent tools stay unregistered and the Browser tab says
// so honestly (see TOOLS_UNAVAILABLE + the /browser/status fields below).
let defineTool = null;
let TOOLS_UNAVAILABLE = null;
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
} catch (e) {
  TOOLS_UNAVAILABLE =
    'agent browser tools disabled: peer package @deepseek-ai/dsh-tools did not resolve (' +
    String((e && e.message) || e).slice(0, 160) + '). Install it to enable browser_navigate/snapshot/click/type.';
}

export const inject = ['webServer', 'tools'];

const GIT_ROUTE = '/plugins/operator-ui';
const BROWSER_ROUTE = '/plugins/operator-ui/browser';

// ------------------------------------------------------------------ archon proxy (read-only)
//
// Slice 1 (configurable): the base URL + timeout + bearer slot resolve PER
// REQUEST from operator-ui.config.json (env>file>default — see lib/config.js),
// never read once at module load. Token VALUES live only in the environment
// under the configured tokenVar NAME; they are held in memory for one fetch
// and never reported (see lib/status.js).

async function archonGet(path) {
  const { config } = resolveConfig();
  const headers = {};
  const tokenVar = config.archon.tokenVar;
  if (typeof tokenVar === 'string' && process.env[tokenVar]) {
    headers.authorization = 'Bearer ' + process.env[tokenVar];
  }
  const res = await fetch(config.archon.baseUrl + path, {
    headers,
    signal: AbortSignal.timeout(config.archon.timeoutMs),
  });
  if (!res.ok) throw new Error('archon HTTP ' + res.status);
  return res.json();
}

function archonBaseForCopy() {
  return resolveConfig().config.archon.baseUrl;
}

async function handleArchon(req, res, url) {
  const op = url.searchParams.get('op') || 'runs';
  try {
    if (op === 'catalog') {
      // Normalize at the boundary (real v0.10.x wraps entries as
      // {workflow:{…}}; the client consumes flat entries — see status.js).
      const raw = await archonGet('/api/workflows');
      const list = raw && (raw.workflows || raw.items || raw.data);
      return sendJson(res, 200, { ok: true, workflows: unwrapCatalog(list) });
    }
    if (op === 'runs') {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 20)));
      return sendJson(res, 200, { ok: true, ...(await archonGet('/api/workflows/runs?limit=' + limit)) });
    }
    if (op === 'run') {
      const id = safeRelFile(url.searchParams.get('id'));
      if (!id) return sendJson(res, 400, { ok: false, error: 'bad run id' });
      return sendJson(res, 200, { ok: true, ...(await archonGet('/api/workflows/runs/' + encodeURIComponent(id))) });
    }
    return sendJson(res, 400, { ok: false, error: 'unknown op: ' + op });
  } catch (e) {
    const msg = String((e && e.message) || e);
    const unreachable = /fetch failed|ECONNREFUSED|timeout|aborted/i.test(msg);
    return sendJson(res, 200, { ok: false, unreachable, error: unreachable ? 'Archon not reachable at ' + archonBaseForCopy() : msg });
  }
}

// ------------------------------------------------------------------ git read-only helpers

function runGit(cwd, args) {
  const { config } = resolveConfig();
  const timeoutMs = config.git.timeoutMs;
  return new Promise((resolve) => {
    const child = spawn(config.git.bin, ['--no-pager', '-C', cwd, ...args], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: -1, out, err: 'git timed out' });
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (out.length < 4_000_000) out += d;
    });
    child.stderr.on('data', (d) => {
      if (err.length < 64_000) err += d;
    });
    child.on('error', (e) => finish({ code: -1, out, err: String(e.message || e) }));
    child.on('close', (code) => finish({ code, out, err }));
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function requireDir(path) {
  if (!path || !path.startsWith('/') || path.includes('\0')) {
    throw new Error('path must be an absolute directory');
  }
  const s = await stat(path);
  if (!s.isDirectory()) throw new Error('path is not a directory');
  return path;
}

function safeRelFile(file) {
  if (!file || file.startsWith('/') || file.includes('\\')) return null;
  const segs = file.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return segs.join('/');
}

async function handleGit(req, res, url) {
  const op = url.searchParams.get('op') || 'status';
  let cwd;
  try {
    cwd = await requireDir(url.searchParams.get('path'));
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e.message || e) });
  }

  if (op === 'status') {
    const st = await runGit(cwd, ['status', '--porcelain=v1', '-b', '--untracked-files=normal']);
    if (st.code !== 0) {
      const notRepo = /not a git repository/i.test(st.err);
      return sendJson(res, 200, {
        ok: !notRepo,
        notRepo,
        error: notRepo ? 'not a git repository' : st.err.slice(0, 400),
        branch: null,
        files: [],
        log: [],
      });
    }
    const lines = st.out.split('\n').filter((l) => l.length > 0);
    let branch = null;
    const files = [];
    for (const line of lines) {
      if (line.startsWith('## ')) {
        branch = line.slice(3).trim();
        continue;
      }
      const x = line[0];
      const y = line[1];
      const file = line.slice(3);
      files.push({
        x, y, file,
        untracked: x === '?' && y === '?',
        // GooeyPi-Changes-style area classification (a file can be in both).
        staged: x !== ' ' && x !== '?',
        unstaged: y !== ' ' && y !== '?',
      });
    }
    // +adds / -dels per file vs HEAD (tracked changes only; untracked = new).
    const numstat = await runGit(cwd, ['diff', '--numstat', 'HEAD']);
    const counts = {};
    if (numstat.code === 0) {
      for (const line of numstat.out.split('\n')) {
        const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (m) counts[m[3]] = { adds: m[1] === '-' ? null : Number(m[1]), dels: m[2] === '-' ? null : Number(m[2]) };
      }
    }
    for (const f of files) {
      const c = counts[f.file];
      if (c) { f.adds = c.adds; f.dels = c.dels; }
      else if (f.untracked) { f.adds = null; f.dels = null; }
      else { f.adds = 0; f.dels = 0; }
    }
    const lg = await runGit(cwd, ['log', '--oneline', '-8']);
    const log = lg.code === 0
      ? lg.out.split('\n').filter((l) => l.length > 0).slice(0, 8)
      : [];
    return sendJson(res, 200, { ok: true, notRepo: false, branch, files, log });
  }

  if (op === 'diff') {
    const file = safeRelFile(url.searchParams.get('file'));
    if (!file) return sendJson(res, 400, { ok: false, error: 'bad file argument' });
    // vs HEAD so staged + unstaged both show (the review view, not plumbing).
    // git asymmetry: porcelain paths are repo-root-relative but diff pathspecs
    // are cwd-relative — anchor at the toplevel; the file arg is already
    // root-relative (it came from status --porcelain).
    const top = await runGit(cwd, ['rev-parse', '--show-toplevel']);
    if (top.code !== 0) return sendJson(res, 200, { ok: false, error: 'not a git repository', file, diff: '' });
    const toplevel = top.out.trim().split('\n')[0];
    const d = await runGit(toplevel, ['diff', 'HEAD', '--', file]);
    let out = d.code === 0 ? d.out : '';
    const maxDiffBytes = resolveConfig().config.git.maxDiffBytes;
    if (out.length > maxDiffBytes) out = out.slice(0, maxDiffBytes) + '\n… (diff truncated)';
    return sendJson(res, 200, {
      ok: d.code === 0,
      error: d.code === 0 ? null : d.err.slice(0, 400),
      file,
      diff: out,
    });
  }

  return sendJson(res, 400, { ok: false, error: 'unknown op: ' + op });
}

// ------------------------------------------------------------------ workspace files (read-only)

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|bz2|xz|7z|rar|mp3|mp4|mov|webm|wav|ogg|woff2?|ttf|otf|eot|so|dylib|dll|exe|bin|wasm|class|jar|pyc|sqlite3?|db|parquet|arrow|pt|onnx|stl|obj|glb|gltf|hdr|exr)$/i;

function safeSubPath(base, rel) {
  if (rel === '' || rel === '.' || rel === '/') return base;
  if (typeof rel !== 'string' || rel.includes('\0') || rel.includes('\\')) return null;
  const segs = rel.split('/').filter((s) => s.length > 0);
  if (segs.some((s) => s === '.' || s === '..')) return null;
  const full = pathJoin(base, ...segs);
  return full.startsWith(base) ? full : null;
}

async function handleFiles(req, res, url) {
  const op = url.searchParams.get('op') || 'list';
  const { config } = resolveConfig();
  const maxEntries = config.files.maxEntries;
  const maxReadBytes = config.files.maxReadBytes;
  let root;
  try {
    root = await requireDir(url.searchParams.get('path'));
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: String(e.message || e) });
  }

  if (op === 'list') {
    const dir = safeSubPath(root, url.searchParams.get('rel') || '');
    if (!dir) return sendJson(res, 400, { ok: false, error: 'bad rel path' });
    try {
      const dirents = await readdir(dir, { withFileTypes: true });
      const entries = [];
      for (const d of dirents.slice(0, maxEntries)) {
        if (d.name === '.git' || d.name === 'node_modules') continue;
        let size = null;
        let mtime = null;
        if (!d.isDirectory()) {
          try {
            const s = await stat(pathJoin(dir, d.name));
            size = s.size;
            mtime = s.mtimeMs;
          } catch {}
        }
        entries.push({ name: d.name, dir: d.isDirectory(), size, mtime });
      }
      entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      return sendJson(res, 200, { ok: true, dir: dir.slice(root.length) || '/', entries, truncated: dirents.length > maxEntries });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
  }

  if (op === 'read') {
    const full = safeSubPath(root, url.searchParams.get('file') || '');
    if (!full) return sendJson(res, 400, { ok: false, error: 'bad file path' });
    if (BINARY_EXT.test(full)) return sendJson(res, 200, { ok: false, error: 'binary file — no preview' });
    try {
      const s = await stat(full);
      if (s.isDirectory()) return sendJson(res, 200, { ok: false, error: 'not a file' });
      if (s.size > maxReadBytes) return sendJson(res, 200, { ok: false, error: 'file too large to preview (>' + maxReadBytes + ' bytes)' });
      const buf = await readFile(full);
      // binary sniff: NUL byte in the first chunk
      if (buf.subarray(0, 8000).includes(0)) return sendJson(res, 200, { ok: false, error: 'binary file — no preview' });
      return sendJson(res, 200, { ok: true, file: full.slice(root.length), content: buf.toString('utf8') });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
  }

  return sendJson(res, 400, { ok: false, error: 'unknown op: ' + op });
}

// ------------------------------------------------------- rcos capability registry
//
// Slice 1: the path + size cap resolve per request from the portable config
// (env>file>default). Unconfigured or invalid is a REPORTED state (Slice 1
// status vocabulary), never a boot failure.

async function handleRcos(req, res, url) {
  const op = url.searchParams.get('op') || 'registry';
  if (op !== 'registry') return sendJson(res, 400, { ok: false, error: 'unknown op: ' + op });
  const { config, path: cfgPath } = resolveConfig();
  const registryPath = config.registry.path;
  const maxBytes = config.registry.maxBytes;
  try {
    if (!registryPath) {
      return sendJson(res, 200, { ok: false, error: 'capability registry not configured — set registry.path in ' + cfgPath + ' (or DSH_OPERATOR_UI_REGISTRY)' });
    }
    const s = await stat(registryPath);
    if (!s.isFile()) throw new Error('registry path is not a file');
    if (s.size > maxBytes) throw new Error('registry file too large (>' + maxBytes + ' bytes)');
    const raw = await readFile(registryPath, 'utf8');
    const registry = JSON.parse(raw);
    return sendJson(res, 200, { ok: true, registry, at: Date.now() });
  } catch (e) {
    return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
  }
}

// ------------------------------------------------------------------ browser tool plumbing

const ON_SCREEN_NOTE =
  'You are driving an ON-SCREEN browser that the human is watching live. ' +
  'Act legibly: navigate, take a browser_snapshot to see the page, then click refs / type. ' +
  'Prefer a few clear actions over many tiny ones.';

export function apply(ctx) {
  // Slice 1 boot-time knobs: browser chrome path / profile / idle / viewport
  // come from operator-ui.config.json (env>file>default); file changes need
  // a DSH restart (documented restart semantics — the supervisor holds them).
  const bootCfg = resolveConfig().config.browser;
  const browser = createBrowserSupervisor(ctx, {
    chromePath: bootCfg.chromePath,
    userDataDir: bootCfg.userDataDir,
    idleMs: bootCfg.idleMs,
    viewport: bootCfg.viewport,
  });

  // ------------------------------------------------------------ git route
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: GIT_ROUTE,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === GIT_ROUTE + '/git') {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
          return await handleGit(req, res, url);
        }
        if (url.pathname === GIT_ROUTE + '/files') {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
          return await handleFiles(req, res, url);
        }
        if (url.pathname === GIT_ROUTE + '/archon') {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
          return await handleArchon(req, res, url);
        }
        if (url.pathname === GIT_ROUTE + '/rcos') {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
          return await handleRcos(req, res, url);
        }
        if (url.pathname === GIT_ROUTE + '/verify') {
          return await handleVerify(req, res, url);
        }
        return sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    },
  }));

  // ---------------------------------------------------- browser routes (SSE + ops)
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BROWSER_ROUTE + '/stream',
    handler: (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      const remove = browser.addSseClient(res);
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch {}
      }, 15000);
      req.on('close', () => { clearInterval(heartbeat); remove(); });
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BROWSER_ROUTE + '/status',
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
      return sendJson(res, 200, {
        ok: true,
        ...browser.status(),
        toolsAvailable: !TOOLS_UNAVAILABLE,
        toolsError: TOOLS_UNAVAILABLE,
      });
    },
  }));

  // ------------------------------------------------- verify: verification + receipt
  // Slice 2 (verifiable): POST runs the two-probe verification (Probe A
  // zero-credential machinery self-check; Probe B routes through the
  // configured registry and executes the seeded workflow on the configured
  // Archon — the normal RCOS path, no parallel verify architecture) and
  // writes the sealed receipt to $DSH_HOME/operator-ui/receipt.json — the
  // ONLY file this plugin writes. GET reads it back with a fresh seal check
  // and fingerprint staleness diff: VALID / STALE / TAMPERED / NONE. Concurrent
  // POSTs serialize; a read never writes.
  async function handleVerify(req, res, url) {
    if (req.method === 'POST') {
      try {
        const result = await runVerification({
          browser,
          findChrome,
          pkgVersion: PKG_VERSION,
          toolsUnavailable: TOOLS_UNAVAILABLE,
        });
        return sendJson(res, result.ok ? 200 : 500, result);
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: 'verification crashed: ' + String((e && e.message) || e).slice(0, 200) });
      }
    }
    if (req.method === 'GET') {
      const op = url.searchParams.get('op') || 'receipt';
      if (op !== 'receipt') return sendJson(res, 400, { ok: false, error: 'unknown op: ' + op });
      try {
        const freshness = await readReceipt();
        return sendJson(res, 200, { ok: true, ...freshness });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: 'receipt read failed: ' + String((e && e.message) || e).slice(0, 200) });
      }
    }
    return sendJson(res, 405, { ok: false, error: 'GET or POST only' });
  }

  // ------------------------------------------------- status: the authoritative surface
  // Slice 1 (configurable): ONE route that answers "what RCOS pieces are
  // configured, available, missing, invalid, or not yet verified" — resolved
  // config (redacted), per-component facts with authority + source, and the
  // single-source viewport. Unreachable panels read this instead of
  // hardcoding defaults. No Setup UI, no new tab — the contract Setup (Slice 2)
  // will consume.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: GIT_ROUTE + '/status',
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
      try {
        const status = await buildStatus({
          browser,
          findChrome,
          pkgVersion: PKG_VERSION,
          toolsUnavailable: TOOLS_UNAVAILABLE,
        });
        return sendJson(res, 200, status);
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: 'status probe failed: ' + String((e && e.message) || e).slice(0, 200) });
      }
    },
  }));

  const OPS = {
    navigate: (p) => browser.navigate(p.url),
    stop: () => browser.stop().then(() => ({ stopped: true })),
    snapshot: () => browser.snapshot(),
    click: (p) => browser.click(p),
    type: (p) => browser.typeText(p),
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BROWSER_ROUTE + '/op',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 64_000) return sendJson(res, 413, { ok: false, error: 'body too large' });
      }
      let p;
      try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
      const fn = OPS[p.op];
      if (!fn) return sendJson(res, 400, { ok: false, error: 'unknown op: ' + p.op });
      try {
        return sendJson(res, 200, { ok: true, result: await fn(p) });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
    },
  }));

  // ------------------------------------------------------------ agent tools
  // Skipped (honestly) when the dsh-tools peer is absent — see top of file.
  // The Browser tab's status probe reports toolsAvailable:false + toolsError.
  if (TOOLS_UNAVAILABLE) {
    ctx.effect(() => {
      try { console.warn('[dsh-operator-ui] ' + TOOLS_UNAVAILABLE); } catch {}
    });
  } else {
  ctx.effect(() => {
    ctx.tools.register(defineTool({
      name: 'browser_navigate',
      description: ON_SCREEN_NOTE + ' Open a URL in the supervised browser. Use http/https URLs only.',
      parameters: {
        url: { type: 'string', required: true, description: 'Absolute http(s) URL to open.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string', required: true },
            title: { type: 'string', required: true },
          },
        },
        render: (_a, v) => [{ type: 'text', text: `Browser now on ${v.url} ("${v.title}"). The human can see it live.` }],
      },
      execute: (args) => browser.navigate(args.url),
    }));

    ctx.tools.register(defineTool({
      name: 'browser_snapshot',
      description: ON_SCREEN_NOTE + ' Read the current page: title, visible text, and clickable/typable elements with stable `ref` numbers. Call this before clicking or typing.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true },
            url: { type: 'string', required: true },
            text: { type: 'string', required: true },
            elements: {
              type: 'array', required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ref: { type: 'integer', required: true },
                  tag: { type: 'string', required: true },
                  text: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_a, v) => [{
          type: 'text',
          text: `Page "${v.title}" (${v.url}) — ${v.elements.length} interactive elements. Visible text follows:\n${v.text}`,
        }],
      },
      execute: async () => {
        const s = await browser.snapshot();
        return {
          title: s.title || '',
          url: s.url || '',
          text: s.text || '',
          elements: s.els.map((e) => ({ ref: e.ref, tag: e.tag, text: e.text })),
        };
      },
    }));

    ctx.tools.register(defineTool({
      name: 'browser_click',
      description: ON_SCREEN_NOTE + ' Click a page element by its `ref` number from the last browser_snapshot.',
      parameters: {
        ref: { type: 'integer', required: true, description: 'Element ref from browser_snapshot.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { clicked: { type: 'array', required: true, items: { type: 'integer' } } },
        },
        render: (_a, v) => [{ type: 'text', text: `Clicked at ${v.clicked[0]},${v.clicked[1]} on screen.` }],
      },
      execute: (args) => browser.click(args),
    }));

    ctx.tools.register(defineTool({
      name: 'browser_type',
      description: ON_SCREEN_NOTE + ' Type text into a page input: pass the element `ref` (from browser_snapshot). Set submit=true to press Enter afterwards.',
      parameters: {
        text: { type: 'string', required: true, description: 'Text to type.' },
        ref: { type: 'integer', description: 'Element ref to click/focus first.' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            typed: { type: 'integer', required: true },
            submit: { type: 'boolean', required: true },
          },
        },
        render: (_a, v) => [{ type: 'text', text: `Typed ${v.typed} characters${v.submit ? ' and pressed Enter' : ''}.` }],
      },
      execute: (args) => browser.typeText(args),
    }));
  }); // end agent-tools block (guarded by TOOLS_UNAVAILABLE above)
  } // end else (tools available)

  // ------------------------------------------------------------ teardown
  ctx.effect(() => async () => {
    await browser.dispose();
  });
}
