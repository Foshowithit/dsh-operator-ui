#!/usr/bin/env node
// eval/lib/local-dag-runner.mjs — minimal Archon-compatible workflow
// runner (fallback infrastructure after the /tmp cleanup destroyed the
// opui-rc0 Archon home and its run engine).
//
// Implements EXACTLY the API surface the acquisition harness uses:
//   POST /api/workflows/:name/run      {message, conversationId} → {accepted}
//   GET  /api/workflows/runs?limit=N   → {runs:[{id,workflow_name,status}]} newest-first
//   GET  /api/workflows/runs/:id       → {run:{status,...}, events:[{data:{node_output}}]}
//
// Semantics preserved from real Archon (proven in the sealed v2/v3 runs):
// - workflows hot-reload from <workflowsDir>/<name>.yaml at POST time
// - nodes execute sequentially in dependency order, cwd = workspace root,
//   USER_MESSAGE env = run message, bash -c per node
// - a non-zero node exit fails the run (downstream nodes skipped)
// - node_output events carry stdout (+ stderr on failure)
//
// NOT implemented: AI-assistant orchestration, marketplaces, auth. This is
// a deterministic bash DAG runner, disclosed as an infrastructure
// substitution in the experiment report.

import { createServer } from 'node:http';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argOf('--port', 13092));
const WORKFLOWS_DIR = argOf('--workflows-dir', '/tmp/opui-rc0-archon/workflows');
const WORKSPACE = argOf('--workspace', '/private/tmp/opui-rc0-folder');
const STATE_FILE = argOf('--state', '/tmp/local-dag-runs.jsonl');

// js-yaml from the ambient environment (same resolution as static-checks)
const { createRequire } = await import('node:module');
const require_ = createRequire(import.meta.url);
let yamlLib = null;
try { yamlLib = require_('js-yaml'); } catch {
  try { yamlLib = require_((await import('./secrets.mjs')).jsYamlPath()); } catch {}
}

const runs = new Map(); // id → {id, workflow_name, status, events:[{data:{node_output}}], started_at}
try {
  const { createInterface } = await import('node:readline');
  const fs = await import('node:fs');
  const rl = createInterface({ input: fs.createReadStream(STATE_FILE) });
  for await (const line of rl) {
    try { const r = JSON.parse(line); if (r.id) runs.set(r.id, r); } catch {}
  }
} catch { /* first boot */ }
const persistRun = async (r) => {
  runs.set(r.id, r);
  try { await (await import('node:fs/promises')).appendFile(STATE_FILE, JSON.stringify(r) + '\n', 'utf8'); } catch {}
};

function topoOrder(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const done = new Set();
  const order = [];
  const visit = (n, stack) => {
    if (done.has(n.id) || stack.has(n.id)) return;
    stack.add(n.id);
    const deps = Array.isArray(n.depends_on) ? n.depends_on : String(n.depends_on || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const d of deps) if (byId.has(d)) visit(byId.get(d), stack);
    stack.delete(n.id);
    done.add(n.id);
    order.push(n);
  };
  for (const n of nodes) visit(n, new Set());
  return order;
}

function bashExec(script, cwd, env) {
  return new Promise((resolve) => {
    execFile('/bin/bash', ['-c', script], { cwd, env, maxBuffer: 8 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ code: err && err.code !== undefined ? err.code : (err ? 1 : 0), stdout: String(stdout || ''), stderr: String(stderr || ''), killed: !!(err && err.killed) });
    });
  });
}

async function executeRun(run, wf, message) {
  const order = topoOrder(wf.nodes || []);
  for (const node of order) {
    const res = await bashExec(String(node.bash || ''), WORKSPACE, { ...process.env, USER_MESSAGE: message ?? '' });
    const output = (res.stdout + (res.code !== 0 ? `\n[stderr] ${res.stderr}` : '')).trim();
    run.events.push({ data: { node_output: output, node: node.id, exit: res.code } });
    if (res.code !== 0) {
      run.events.push({ data: { node_output: `DAG workflow '${wf.name}' failed: node ${node.id} failed. ${order.length - order.indexOf(node) - 1} downstream nodes were skipped.` } });
      run.status = 'failed';
      await persistRun(run);
      return;
    }
  }
  run.status = 'completed';
  await persistRun(run);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const runMatch = url.pathname.match(/^\/api\/workflows\/runs\/([a-f0-9-]+)$/);
    if (req.method === 'GET' && url.pathname === '/api/workflows/runs') {
      const limit = Number(url.searchParams.get('limit') || 20);
      const list = [...runs.values()].sort((a, b) => b.started_at - a.started_at).slice(0, limit)
        .map((r) => ({ id: r.id, workflow_name: r.workflow_name, status: r.status, started_at: r.started_at }));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ runs: list }));
    }
    if (req.method === 'GET' && runMatch) {
      const r = runs.get(runMatch[1]);
      if (!r) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ run: { id: r.id, status: r.status }, events: r.events }));
    }
    const runAction = url.pathname.match(/^\/api\/workflows\/([^/]+)\/run$/);
    if (req.method === 'POST' && runAction) {
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const name = decodeURIComponent(runAction[1]);
      let text = null;
      try { text = await readFile(join(WORKFLOWS_DIR, name + '.yaml'), 'utf8'); } catch {}
      if (!text) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: `Workflow not found: ${name}` })); }
      const wf = yamlLib.load(text);
      const run = { id: randomUUID(), workflow_name: wf.name || name, status: 'running', events: [], started_at: Date.now() };
      await persistRun(run);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, status: 'started' }));
      executeRun(run, wf, parsed.message).catch(async (e) => {
        run.events.push({ data: { node_output: `runner error: ${e.message}` } });
        run.status = 'failed';
        await persistRun(run);
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

await mkdir(dirname(STATE_FILE), { recursive: true }).catch(() => {});
server.listen(PORT, () => console.log(`local-dag-runner on :${PORT} (workflows: ${WORKFLOWS_DIR}, workspace: ${WORKSPACE})`));
