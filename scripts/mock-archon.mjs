#!/usr/bin/env node
// Mock Archon server for sandbox verification of the Workflows tab.
// Mirrors the real :3090 routes the plugin proxies. Run:
//   node scripts/mock-archon.mjs [port]     (default 3090)

import { createServer } from 'node:http';

const port = Number(process.argv[2] || 3090);
const now = Date.now();
const min = 60 * 1000;
const hr = 60 * min;

const workflows = [
  { name: 'chow-research-search-v1', description: 'Web research with search + brief artifacts', category: 'research', tags: ['research', 'search'] },
  { name: 'chow-video-prod-v1', description: 'Deterministic canvas → MP4 explainer pipeline', category: 'media', tags: ['video', 'canvas'] },
  { name: 'chow-qa-verify-v1', description: 'Path/contract verification gate', category: 'qa', tags: ['verify', 'gate'] },
  { name: 'chow-muse-gen-v1', description: 'API-first image generation lane', category: 'media', tags: ['image', 'muse'] },
  { name: 'chow-explainer-v1', description: 'Explainer video assembly with eval gate', category: 'media', tags: ['video', 'eval'] },
  { name: 'chow-tts-prod-v1', description: 'Voiceover production lane', category: 'media', tags: ['tts', 'audio'] },
  { name: 'chow-canvas-prod-v1', description: 'Canvas render pipeline', category: 'media', tags: ['canvas'] },
  { name: 'chow-echo-ground-v1', description: 'Ground-truth echo verification', category: 'qa', tags: ['verify'] },
];

const runs = [
  { id: 'run-mock-001', workflow_name: 'chow-research-search-v1', user_message: 'research MCP SDK changes for the connector plan', status: 'completed', current_step_index: 3, started_at: now - 2 * hr, metadata: { model_bindings: { planner: 'muse-1.3', worker: 'det-flash' } }, receipt: { decision: 'ship', summary: 'Brief verified against 6 sources; artifact set complete.', artifacts: ['RESEARCH_BRIEF.md', 'SEARCH_RESULTS.json', 'CHOW_CONTEXT.json'] } },
  { id: 'run-mock-002', workflow_name: 'chow-video-prod-v1', user_message: 'explainer cut for the bearing assembly', status: 'running', current_step_index: 2, started_at: now - 9 * min, metadata: { model_bindings: { renderer: 'det-canvas' } } },
  { id: 'run-mock-003', workflow_name: 'chow-qa-verify-v1', user_message: 'verify draftforge DXF round trip', status: 'failed', current_step_index: 2, started_at: now - 4 * hr, metadata: { model_bindings: { verifier: 'muse-1.3' } }, receipt: { decision: 'blocked', summary: '2 path checks failed: foreign-DXF probe never wrote output.', artifacts: ['EVAL.json', 'VALIDATION.md'] } },
  { id: 'run-mock-004', workflow_name: 'chow-muse-gen-v1', user_message: 'sign face art for hog crankers', status: 'completed', current_step_index: 4, started_at: now - 6 * hr, metadata: { model_bindings: { artist: 'muse-image-1.0' } }, receipt: { decision: 'ship', summary: '4/4 spelled text correct, 2240×1120 WebP quirk handled.', artifacts: ['SIGN_FACE.png', 'EVAL.json'] } },
  { id: 'run-mock-005', workflow_name: 'chow-explainer-v1', user_message: 'immune-system explainer v11 kit', status: 'completed', current_step_index: 5, started_at: now - 26 * hr, metadata: { model_bindings: { planner: 'muse-1.3', voice: 'tts-prod' } }, receipt: { decision: 'fix', summary: 'Layout score 9.1 — below the 9.3 gate; re-run with tightened grid.', artifacts: ['EVAL.json', 'FINAL_REPORT.md'] } },
  { id: 'run-mock-006', workflow_name: 'chow-tts-prod-v1', user_message: 'voiceover for the tour cut', status: 'completed', current_step_index: 3, started_at: now - 49 * hr, metadata: { model_bindings: { voice: 'tts-prod' } }, receipt: { decision: 'ship', summary: 'VO rendered, loudness normalized.', artifacts: ['VO.mp3', 'RECEIPT.json'] } },
  { id: 'run-mock-007', workflow_name: 'chow-canvas-prod-v1', user_message: 'canvas capture for the model-compare entry', status: 'running', current_step_index: 1, started_at: now - 2 * min, metadata: { model_bindings: { renderer: 'det-canvas' } } },
  { id: 'run-mock-008', workflow_name: 'chow-echo-ground-v1', user_message: 'ground-truth echo for the router eval', status: 'failed', current_step_index: 1, started_at: now - 71 * hr, metadata: {}, receipt: { decision: 'blocked', summary: 'Upstream lane unreachable during verification window.', artifacts: ['EVAL.json'] } },
  { id: 'run-mock-009', workflow_name: 'chow-research-search-v1', user_message: 'survey of harness landscape boards', status: 'completed', current_step_index: 3, started_at: now - 96 * hr, metadata: { model_bindings: { planner: 'muse-1.3' } }, receipt: { decision: 'ship', summary: 'Board claims cross-checked; two false claims flagged.', artifacts: ['RESEARCH_BRIEF.md'] } },
  { id: 'run-mock-010', workflow_name: 'chow-qa-verify-v1', user_message: 'verify shop-os AR/AP books', status: 'completed', current_step_index: 2, started_at: now - 120 * hr, metadata: { model_bindings: { verifier: 'det-flash' } }, receipt: { decision: 'ship', summary: 'Books balanced; projected −$100 matches.', artifacts: ['VALIDATION.md', 'EVAL.json'] } },
  { id: 'run-mock-011', workflow_name: 'chow-muse-gen-v1', user_message: 'prop concept art batch', status: 'completed', current_step_index: 4, started_at: now - 144 * hr, metadata: { model_bindings: { artist: 'muse-image-1.0' } }, receipt: { decision: 'fix', summary: '3/6 assets spelled text correctly; regenerate failures.', artifacts: ['EVAL.json'] } },
  { id: 'run-mock-012', workflow_name: 'chow-video-prod-v1', user_message: 'retro cut for the space sim', status: 'completed', current_step_index: 5, started_at: now - 170 * hr, metadata: { model_bindings: { renderer: 'det-canvas', planner: 'muse-1.3' } }, receipt: { decision: 'ship', summary: '1080p60 delivered, filmstrip verified.', artifacts: ['CUT.mp4', 'EVAL.json', 'FINAL_REPORT.md'] } },
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
