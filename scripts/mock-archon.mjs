#!/usr/bin/env node
// Mock Archon server for sandbox verification of the Workflows tab.
// Mirrors the real :3090 routes the plugin proxies. Run:
//   node scripts/mock-archon.mjs [port]     (default 3090)

import { createServer } from 'node:http';

const port = Number(process.argv[2] || 3090);

const workflows = [
  { name: 'internal-research-search-v1', description: 'Web research with search + brief artifacts', category: 'research', tags: ['research', 'search'] },
  { name: 'internal-video-prod-v1', description: 'Deterministic canvas → MP4 explainer pipeline', category: 'media', tags: ['video', 'canvas'] },
  { name: 'internal-qa-verify-v1', description: 'Path/contract verification gate', category: 'qa', tags: ['verify', 'gate'] },
  { name: 'internal-muse-gen-v1', description: 'API-first image generation lane', category: 'media', tags: ['image', 'muse'] },
];

const runs = [
  { id: 'run-mock-001', workflow_name: 'internal-research-search-v1', user_message: 'research MCP SDK changes', status: 'completed', current_step_index: 3, metadata: { model_bindings: { planner: 'muse-1.3' } }, receipt: { decision: 'ship', summary: 'brief verified' } },
  { id: 'run-mock-002', workflow_name: 'internal-video-prod-v1', user_message: 'explainer cut for bearings', status: 'running', current_step_index: 1, metadata: { model_bindings: { renderer: 'det-canvas' } } },
  { id: 'run-mock-003', workflow_name: 'internal-qa-verify-v1', user_message: 'verify draftforge round trip', status: 'failed', current_step_index: 2, metadata: {}, receipt: { decision: 'blocked', summary: '2 path checks failed' } },
];

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/api/workflows') return json({ workflows });
  if (url.pathname === '/api/workflows/runs') {
    const limit = Number(url.searchParams.get('limit') || 20);
    return json({ runs: runs.slice(0, limit) });
  }
  const runMatch = url.pathname.match(/^\/api\/workflows\/runs\/(.+)$/);
  if (runMatch) {
    const run = runs.find((r) => r.id === runMatch[1]);
    return run ? json(run) : json({ error: 'not found' });
  }
  res.writeHead(404);
  res.end('not found');
}).listen(port, '127.0.0.1', () => console.log(`mock archon on :${port}`));
