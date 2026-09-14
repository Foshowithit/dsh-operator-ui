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
import { stat } from 'node:fs/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createBrowserSupervisor } from './browser.js';

export const inject = ['webServer', 'tools'];

const GIT_ROUTE = '/plugins/operator-ui';
const BROWSER_ROUTE = '/plugins/operator-ui/browser';
const GIT_TIMEOUT_MS = 6000;
const MAX_DIFF_BYTES = 300_000;

const GIT = 'git';

// ------------------------------------------------------------------ git read-only helpers

function runGit(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(GIT, ['--no-pager', '-C', cwd, ...args], {
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
    }, GIT_TIMEOUT_MS);
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
      files.push({ x, y, file, untracked: x === '?' && y === '?' });
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
    if (out.length > MAX_DIFF_BYTES) out = out.slice(0, MAX_DIFF_BYTES) + '\n… (diff truncated)';
    return sendJson(res, 200, {
      ok: d.code === 0,
      error: d.code === 0 ? null : d.err.slice(0, 400),
      file,
      diff: out,
    });
  }

  return sendJson(res, 400, { ok: false, error: 'unknown op: ' + op });
}

// ------------------------------------------------------------------ browser tool plumbing

const ON_SCREEN_NOTE =
  'You are driving an ON-SCREEN browser that the human is watching live. ' +
  'Act legibly: navigate, take a browser_snapshot to see the page, then click refs / type. ' +
  'Prefer a few clear actions over many tiny ones.';

export function apply(ctx) {
  const browser = createBrowserSupervisor(ctx);

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
      return sendJson(res, 200, { ok: true, ...browser.status() });
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
  });

  // ------------------------------------------------------------ teardown
  ctx.effect(() => async () => {
    await browser.dispose();
  });
}
