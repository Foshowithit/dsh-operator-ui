// dsh-operator-ui — host half: read-only git summary routes.
//
// Registers /plugins/operator-ui/git under the webServer and answers the
// client panel with JSON. Read-only by construction: every git invocation
// uses a fixed argv (no shell), the only user-controlled inputs are the
// workspace path (must be an existing directory) and a repo-relative file
// (validated: relative, no '..' segment), and only read-only subcommands
// (status, log, diff) are ever spawned. Route disposal rides the plugin
// fiber — removing the plugin removes the route.

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

export const inject = ['webServer'];

const ROUTE_PREFIX = '/plugins/operator-ui';
const GIT_TIMEOUT_MS = 6000;
const MAX_DIFF_BYTES = 300_000;

const GIT = 'git';

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

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === ROUTE_PREFIX + '/git') {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
          return await handleGit(req, res, url);
        }
        return sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
      }
    },
  }));
}
