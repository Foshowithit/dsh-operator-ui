#!/usr/bin/env node
// Mock Archon server for sandbox verification of the Workflows tab.
// Mirrors the real :3090 routes the plugin proxies. Run:
//   node scripts/mock-archon.mjs [port]     (default 13090)
//
// Slice 0: the default is DELIBERATELY not 3090 — the mock must never collide
// with a real Archon on the default port. Point the plugin at the mock with
// DSH_OPERATOR_UI_ARCHON=http://127.0.0.1:13090.
//
// S2-R (2026-09-20): additive conversation-lifecycle surface mirroring the
// bundle-extracted real API — POST /api/conversations (strict body; pure row
// creation without `message`, and message-bearing creation trips a 501 so the
// S2-R contract never silently depends on it), GET/POST/DELETE
// /api/conversations/{id}, GET /{id}/messages, and POST /{id}/message with
// the deterministic `/setproject <name>` command — plus /api/_mock/* admin
// routes (call log, run seeding, one-shot delay/drop of the next dispatch)
// used by test/conversation.test.mjs. Dispatch now mirrors the real
// best-effort conversation lookup (dispatch proceeds over an unknown id —
// enforcement lives Mac-side) and stamps the conversation's effective cwd
// (cwd ?? codebase.default_cwd) onto the run.
//
// OP-4R Phase B (2026-09-22): attempt-scoped fresh-run support surface. The
// mock now (1) stores conversation tails as real MessageRow-shaped objects so
// the role-aware prior-run-menu detector runs against it, (2) emulates the
// real v0.10.1 prior-failed-run guard — an ordinary dispatch that matches a
// linked failed run with a working_path answers acceptance WITHOUT
// materializing a run and appends the combined Starting-workflow + 3-option
// decision menu assistant row, while a wire carrying a standalone `--force`
// token bypasses the guard exactly like the real `options.force` path,
// (3) force-strips the wire before persisting user_message (the real command
// handler does this, so the user-message linkage leg sees the plain prompt),
// (4) logs every dispatch wire to GET /api/_mock/dispatches for byte-level
// wire assertions, and (5) adds POST /api/_mock/seed-conversation to register
// a conversation with known platform/db ids plus two provisioning rows so the
// detector's pre-dispatch snapshot is never empty. Seed-run additionally
// accepts workingPath so a guard-matching failed run can be expressed.

import { createServer } from 'node:http';

const port = Number(process.argv[2] || 13090);
const dynamicRuns = []; // runs created via POST …/run during this process
const now = Date.now();
const min = 60 * 1000;
const hr = 60 * min;

// S2-R fixtures: the real p1x-csv-fixture project row (id as registered on
// the dev-host) plus a second project so a wrong-project binding is expressible.
const codebases = new Map([
  ['dc92aa5a4a569d452a2fa65a2a0e2053', { id: 'dc92aa5a4a569d452a2fa65a2a0e2053', name: 'p1x-csv-fixture', default_cwd: '/home/<redacted>/p1x-ws', ai_assistant_type: 'pi', kind: 'folder' }],
  ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', name: 'p2x-wrong-fixture', default_cwd: '/home/<redacted>/p2x-ws', ai_assistant_type: 'pi', kind: 'folder' }],
]);
const projectsByName = new Map([...codebases.values()].map((c) => [c.name, c]));
const conversations = new Map(); // platform conversation id → row (snake_case, like the real db)
// OP-4R Phase B: conversation tails are now MESSAGE ROWS mirroring the real
// MessageRow shape ({id, conversation_id, role, content, ...}) so the
// prior-run-menu detector (role-aware, id-keyed) can run against the mock.
const convMessages = new Map(); // platform conversation id → [message row]
let msgSeq = 0;
const pushMsg = (convId, role, content) => {
  const rows = convMessages.get(convId) || [];
  rows.push({
    id: String(++msgSeq),
    conversation_id: convId,
    role,
    content,
    metadata: null,
    user_id: null,
    created_at: new Date().toISOString(),
  });
  convMessages.set(convId, rows);
  return rows;
};
let dbSeq = 0;
let seedSeq = 0;
const callLog = []; // {at, method, path} — every request
// OP-4R: every workflow dispatch records its raw wire message here so tests
// can assert exactly what crossed the boundary (force token present/absent).
const dispatchWires = [];
let delayNextDispatchMs = 0;
let dropNextDispatch = false;
// OP-4R: monotonic dispatch/fork identity + armed fork count. Direct-dispatch
// ids come from ++dispatchRunSeq (never dynamicRuns.length, so seeded decoys
// can neither shift nor collide with dispatch ids); forked children mint from
// ++forkSeq under a DISTINCT prefix so id-pinning tests can tell them apart.
let dispatchRunSeq = 0;
let forkSeq = 0;
let forkNextDispatchCount = 0;

const readBody = (req) => new Promise((resolve) => {
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 64000) req.destroy(); });
  req.on('end', () => resolve(body));
});

// OP-4R: list-vs-detail projection for the run-detail-retrieval proof.
// A run carrying __project.listHidesParent strips every parent_* leg from
// LIST entries; DETAIL merges __project.detailOnly over the stored row. The
// __project envelope itself is NEVER exposed on either surface. Mac-side
// revised T1 must therefore succeed on LIST-hidden legs via the detail GET
// and must refuse a run whose DETAIL legs fail even when the list looks right.
const publicRun = (r, { forDetail = false } = {}) => {
  const { __project, ...rest } = r || {};
  if (!__project) return { ...rest };
  if (forDetail) return { ...rest, ...(__project.detailOnly || {}) };
  if (__project.listHidesParent) {
    const out = { ...rest };
    for (const k of Object.keys(out)) if (k.startsWith('parent_')) delete out[k];
    return out;
  }
  return { ...rest };
};

const workflows = [
  { name: 'verify-echo-v1', description: 'SEEDED system-verification echo (zero-credential, deterministic)', category: 'seed', tags: ['seed', 'verify'] },
  { name: 'example-research-search-v1', description: 'EXAMPLE — web research with search + brief artifacts', category: 'research', tags: ['research', 'search'] },
  { name: 'example-video-prod-v1', description: 'Deterministic canvas → MP4 explainer pipeline', category: 'media', tags: ['video', 'canvas'] },
  { name: 'example-qa-verify-v1', description: 'Path/contract verification gate', category: 'qa', tags: ['verify', 'gate'] },
  { name: 'example-image-gen-v1', description: 'API-first image generation lane', category: 'media', tags: ['image', 'muse'] },
  { name: 'example-explainer-v1', description: 'Explainer video assembly with eval gate', category: 'media', tags: ['video', 'eval'] },
  { name: 'example-tts-prod-v1', description: 'Voiceover production lane', category: 'media', tags: ['tts', 'audio'] },
  { name: 'example-canvas-prod-v1', description: 'Canvas render pipeline', category: 'media', tags: ['canvas'] },
  { name: 'example-echo-ground-v1', description: 'Ground-truth echo verification', category: 'qa', tags: ['verify'] },
  { name: 'csv-running-total-v1', description: 'Deterministic CSV running total over values.csv (seeded mock)', category: 'seed', tags: ['csv', 'running', 'total'] },
];

// OP-4R Phase B: explicit per-workflow seeded outputs. Keying by workflow
// name (rather than a shared constant) so the csv fixture's expectation
// ('rcos-verify-seed:csv-running-total-v1') and the pre-existing verify-echo
// expectation stay byte-exact and independent.
const SEEDED_OUTPUT = {
  'verify-echo-v1': 'rcos-verify-seed:rcos-verify-echo-v1',
  'csv-running-total-v1': 'rcos-verify-seed:csv-running-total-v1',
};

const runs = [
  { id: 'run-mock-001', workflow_name: 'example-research-search-v1', user_message: 'research MCP SDK changes for the connector plan', status: 'completed', current_step_index: 3, started_at: now - 2 * hr, metadata: { model_bindings: { planner: 'muse-1.3', worker: 'det-flash' } }, receipt: { decision: 'ship', summary: 'Brief verified against 6 sources; artifact set complete.', artifacts: ['RESEARCH_BRIEF.md', 'SEARCH_RESULTS.json', 'CHOW_CONTEXT.json'] } },
  { id: 'run-mock-002', workflow_name: 'example-video-prod-v1', user_message: 'explainer cut for the bearing assembly', status: 'running', current_step_index: 2, started_at: now - 9 * min, metadata: { model_bindings: { renderer: 'det-canvas' } } },
  { id: 'run-mock-003', workflow_name: 'example-qa-verify-v1', user_message: 'verify draftforge DXF round trip', status: 'failed', current_step_index: 2, started_at: now - 4 * hr, metadata: { model_bindings: { verifier: 'muse-1.3' } }, receipt: { decision: 'blocked', summary: '2 path checks failed: foreign-DXF probe never wrote output.', artifacts: ['EVAL.json', 'VALIDATION.md'] } },
  { id: 'run-mock-004', workflow_name: 'example-image-gen-v1', user_message: 'sign face art for hog crankers', status: 'completed', current_step_index: 4, started_at: now - 6 * hr, metadata: { model_bindings: { artist: 'muse-image-1.0' } }, receipt: { decision: 'ship', summary: '4/4 spelled text correct, 2240×1120 WebP quirk handled.', artifacts: ['SIGN_FACE.png', 'EVAL.json'] } },
  { id: 'run-mock-005', workflow_name: 'example-explainer-v1', user_message: 'immune-system explainer v11 kit', status: 'completed', current_step_index: 5, started_at: now - 26 * hr, metadata: { model_bindings: { planner: 'muse-1.3', voice: 'tts-prod' } }, receipt: { decision: 'fix', summary: 'Layout score 9.1 — below the 9.3 gate; re-run with tightened grid.', artifacts: ['EVAL.json', 'FINAL_REPORT.md'] } },
  { id: 'run-mock-006', workflow_name: 'example-tts-prod-v1', user_message: 'voiceover for the tour cut', status: 'completed', current_step_index: 3, started_at: now - 49 * hr, metadata: { model_bindings: { voice: 'tts-prod' } }, receipt: { decision: 'ship', summary: 'VO rendered, loudness normalized.', artifacts: ['VO.mp3', 'RECEIPT.json'] } },
  { id: 'run-mock-007', workflow_name: 'example-canvas-prod-v1', user_message: 'canvas capture for the model-compare entry', status: 'running', current_step_index: 1, started_at: now - 2 * min, metadata: { model_bindings: { renderer: 'det-canvas' } } },
  { id: 'run-mock-008', workflow_name: 'example-echo-ground-v1', user_message: 'ground-truth echo for the router eval', status: 'failed', current_step_index: 1, started_at: now - 71 * hr, metadata: {}, receipt: { decision: 'blocked', summary: 'Upstream lane unreachable during verification window.', artifacts: ['EVAL.json'] } },
  { id: 'run-mock-009', workflow_name: 'example-research-search-v1', user_message: 'survey of harness landscape boards', status: 'completed', current_step_index: 3, started_at: now - 96 * hr, metadata: { model_bindings: { planner: 'muse-1.3' } }, receipt: { decision: 'ship', summary: 'Board claims cross-checked; two false claims flagged.', artifacts: ['RESEARCH_BRIEF.md'] } },
  { id: 'run-mock-010', workflow_name: 'example-qa-verify-v1', user_message: 'verify shop-os AR/AP books', status: 'completed', current_step_index: 2, started_at: now - 120 * hr, metadata: { model_bindings: { verifier: 'det-flash' } }, receipt: { decision: 'ship', summary: 'Books balanced; projected −$100 matches.', artifacts: ['VALIDATION.md', 'EVAL.json'] } },
  { id: 'run-mock-011', workflow_name: 'example-image-gen-v1', user_message: 'prop concept art batch', status: 'completed', current_step_index: 4, started_at: now - 144 * hr, metadata: { model_bindings: { artist: 'muse-image-1.0' } }, receipt: { decision: 'fix', summary: '3/6 assets spelled text correctly; regenerate failures.', artifacts: ['EVAL.json'] } },
  { id: 'run-mock-012', workflow_name: 'example-video-prod-v1', user_message: 'retro cut for the space sim', status: 'completed', current_step_index: 5, started_at: now - 170 * hr, metadata: { model_bindings: { renderer: 'det-canvas', planner: 'muse-1.3' } }, receipt: { decision: 'ship', summary: '1080p60 delivered, filmstrip verified.', artifacts: ['CUT.mp4', 'EVAL.json', 'FINAL_REPORT.md'] } },
];

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  callLog.push({ at: Date.now(), method: req.method, path: url.pathname });
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const fail = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  // RC0: the mock mirrors the REAL v0.10.1 API contract as closely as the
  // real server revealed it — wrapped catalog entries, /api/health with a
  // version string, conversationId-required dispatch answered with an
  // ACCEPTANCE (not the run), flat run-list entries, {run, events} detail.
  // The version string is deliberately suffix-marked so a mock-backed
  // receipt can never pose as a versioned real-Archon receipt.
  if (url.pathname === '/api/health') return json({ status: 'ok', version: '0.10.1-mock', adapter: 'web' });
  if (url.pathname === '/api/workflows') return json({ workflows: workflows.map((w) => ({ workflow: w })) });
  if (url.pathname === '/api/workflows/runs') {
    const limit = Number(url.searchParams.get('limit') || 20);
    const all = [...dynamicRuns, ...runs];
    return json({ runs: all.slice(0, limit).map((r) => publicRun(r)) });
  }
  const runMatch = url.pathname.match(/^\/api\/workflows\/runs\/(.+)$/);
  if (runMatch) {
    const run = [...dynamicRuns, ...runs].find((r) => r.id === runMatch[1]);
    if (!run) return json({ error: 'not found' });
    const pub = publicRun(run, { forDetail: true });
    return json({
      run: pub,
      events: (pub.output ? [{ id: 'ev-1', event_type: 'node_output', step_name: 'emit', data: { output: pub.output } }] : []),
    });
  }
  const runDispatch = url.pathname.match(/^\/api\/workflows\/([a-z0-9-]+)\/run$/);
  if (runDispatch && req.method === 'POST') {
    const wf = workflows.find((w) => w.name === runDispatch[1]);
    if (!wf) return fail(404, { error: 'unknown workflow: ' + runDispatch[1] });
    const body = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch {}
    if (typeof parsed.conversationId !== 'string' || parsed.conversationId.length === 0) {
      return fail(400, { error: 'conversationId must be a non-empty string' });
    }
    // Real contract: conversation lookup is BEST-EFFORT — dispatch proceeds
    // even over an unknown conversationId, so identity enforcement has to
    // live entirely Mac-side. When the conversation IS known, persist the
    // /workflow run message and stamp identity context onto the run.
    const convRow = conversations.get(parsed.conversationId) || null;
    const convCb = convRow ? codebases.get(convRow.codebase_id) : null;
    const workingPath = convRow ? (convRow.cwd || (convCb ? convCb.default_cwd : null)) : null;
    // OP-4R: parse the wire like the real command handler — a standalone
    // `--force` token sets force, and user_message persists the FORCE-STRIPPED
    // plain prompt (real handleWorkflowRunCommand filters the token before it
    // reaches run.user_message, so the user-message linkage leg matches).
    const wire = String(parsed.message || '');
    const force = wire.split(/\s+/).includes('--force');
    const plain = force ? wire.split(/\s+/).filter((t) => t !== '--force').join(' ') : wire;
    if (convRow) pushMsg(parsed.conversationId, 'user', '/workflow run ' + wf.name + ' ' + wire);
    const seeded = wf.name in SEEDED_OUTPUT;
    const makeDirectRun = () => {
      dynamicRuns.unshift({
        id: 'run-mock-verify-' + String(++dispatchRunSeq).padStart(3, '0'),
        conversation_id: parsed.conversationId,
        codebase_id: convRow ? convRow.codebase_id : null,
        working_path: workingPath,
        workflow_name: wf.name,
        user_message: plain,
        status: 'completed',
        outcome: null,
        current_step_index: 2,
        started_at: Date.now(),
        metadata: { seeded: wf.category === 'seed' },
        ...(seeded ? { output: SEEDED_OUTPUT[wf.name] } : {}),
        receipt: seeded
          ? { decision: 'ship', summary: 'Deterministic echo matched the seeded expectation (mock).', artifacts: ['EVAL.json'] }
          : { decision: 'ship', summary: 'Mock run completed.', artifacts: [] },
      });
    };
    // OP-4R: parent-linked child mint. conversation_id is an UNREGISTERED
    // child platform id (never added to `conversations`, so a child GET 404s
    // exactly like the real child that no conversation row exists for);
    // linkage lives on the run record: parent_conversation_id = parent DB id,
    // parent_platform_id = parent platform id. Same output/receipt tail as a
    // direct run so verification + objective evaluation behave identically.
    const makeForkedChild = () => {
      const childPlatformId = 'web-child-' + Date.now().toString(36) + '-' + String(++forkSeq).padStart(2, '0');
      dynamicRuns.unshift({
        id: 'run-mock-child-' + String(forkSeq).padStart(3, '0'),
        conversation_id: childPlatformId,
        parent_conversation_id: convRow ? convRow.id : null,
        parent_platform_id: parsed.conversationId,
        codebase_id: convRow ? convRow.codebase_id : null,
        working_path: workingPath,
        workflow_name: wf.name,
        user_message: plain,
        status: 'completed',
        outcome: null,
        current_step_index: 2,
        started_at: Date.now(),
        metadata: { seeded: wf.category === 'seed', forked: true },
        ...(seeded ? { output: SEEDED_OUTPUT[wf.name] } : {}),
        receipt: seeded
          ? { decision: 'ship', summary: 'Deterministic echo matched the seeded expectation (mock).', artifacts: ['EVAL.json'] }
          : { decision: 'ship', summary: 'Mock run completed.', artifacts: [] },
      });
    };
    // OP-4R: fork consumption takes precedence over the direct run — when N
    // children are armed the dispatch materializes ONLY those N children (no
    // direct run), forcing the parent-linked discovery path. Zero forks keeps
    // today's direct-exact shape byte-identical apart from the id sequence.
    const materialize = () => {
      const n = forkNextDispatchCount;
      forkNextDispatchCount = 0;
      if (n > 0 && convRow) {
        for (let i = 0; i < n; i++) makeForkedChild();
        return;
      }
      makeDirectRun();
    };
    // OP-4R: emulate the real v0.10.1 prior-failed-run guard. An ordinary
    // dispatch matching a LINKED failed run that carries a working_path answers
    // the combined Starting-workflow + 3-option decision menu and materializes
    // NOTHING (arms untouched); a wire carrying `--force` skips the guard the
    // same way options.force nulls resumableRun Mac-side.
    let guard = false;
    if (convRow && !force) {
      const prior = [...dynamicRuns, ...runs].find((r) => r
        && r.workflow_name === wf.name
        && r.status === 'failed'
        && r.working_path
        && (r.parent_platform_id === parsed.conversationId
          || r.parent_conversation_id === convRow.id
          || r.conversation_id === parsed.conversationId));
      if (prior) {
        guard = true;
        pushMsg(parsed.conversationId, 'assistant',
          'Starting workflow: `' + wf.name + '`\n---\n'
          + 'Found a prior failed run of **' + wf.name + '** (run `' + prior.id + '`).\n\n'
          + '**Run prompt was:**\n> ' + plain.slice(0, 160) + '\n\n'
          + '**Choose how to proceed:**\n'
          + '1. Inspect the prior run\n'
          + '2. Resume the prior run\n'
          + '3. Start a fresh run: /workflow run ' + wf.name + ' --force "' + plain.replace(/[\\\"`]/g, '\\$&') + '"');
      }
    }
    // UNCONDITIONAL wire log (after guard determination, before any
    // materialize/return) so tests can assert the exact boundary bytes —
    // including a guard hit whose dispatch materialized nothing.
    dispatchWires.push({ at: Date.now(), workflow: wf.name, conversationId: parsed.conversationId, wire, force, plain, guard });
    if (guard) return json({ accepted: true, status: 'started' });
    if (convRow) pushMsg(parsed.conversationId, 'assistant', 'Starting workflow: `' + wf.name + '`');
    if (dropNextDispatch) dropNextDispatch = false; // accepted, never materializes
    else if (delayNextDispatchMs > 0) {
      const ms = delayNextDispatchMs;
      delayNextDispatchMs = 0;
      setTimeout(materialize, ms);
    } else materialize();
    // Real dispatch answers an ACCEPTANCE, not the run.
    return json({ accepted: true, status: 'started' });
  }

  // ---- S2-R conversation surface (bundle-extracted contract) ----
  if (url.pathname === '/api/conversations' && req.method === 'POST') {
    const body = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { return fail(400, { error: 'invalid JSON body' }); }
    const known = new Set(['codebaseId', 'message']);
    const unknown = Object.keys(parsed).filter((k) => !known.has(k));
    if (unknown.length) return fail(400, { error: 'unsupported body keys: ' + unknown.join(', ') });
    if ('message' in parsed) return fail(501, { error: 'mock: message-bearing creation is not part of the S2-R contract' });
    let codebaseId = null;
    if (parsed.codebaseId != null) {
      if (typeof parsed.codebaseId !== 'string' || !codebases.has(parsed.codebaseId)) {
        return fail(400, { error: 'Codebase not found: No codebase with id ' + String(parsed.codebaseId) });
      }
      codebaseId = parsed.codebaseId;
    }
    const platformId = 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const row = {
      platform_conversation_id: platformId,
      id: 'db-' + String(++dbSeq),
      platform_type: 'web',
      codebase_id: codebaseId,
      cwd: null, // the real table persists NULL here; effective cwd = default_cwd
      ai_assistant_type: codebaseId ? (codebases.get(codebaseId).ai_assistant_type || 'claude') : 'claude',
      title: null,
      created_at: Date.now(),
    };
    conversations.set(platformId, row);
    convMessages.set(platformId, []);
    return json({ conversationId: platformId, id: row.id });
  }

  const convMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (convMatch) {
    const row = conversations.get(convMatch[1]) || null;
    if (!row) return fail(404, { error: 'Conversation not found' });
    if (req.method === 'GET') return json(row);
    if (req.method === 'DELETE') {
      conversations.delete(convMatch[1]);
      convMessages.delete(convMatch[1]);
      return json({ success: true });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { return fail(400, { error: 'invalid JSON body' }); }
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
      if (!title) return fail(400, { error: 'title must be a non-empty string' });
      row.title = title.slice(0, 255);
      return json({ success: true });
    }
    return fail(405, { error: 'method not allowed' });
  }

  const convMsgs = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (convMsgs && req.method === 'GET') {
    const row = conversations.get(convMsgs[1]) || null;
    if (!row) return fail(404, { error: 'Conversation not found' });
    return json(convMessages.get(convMsgs[1]) || []);
  }

  const convMessage = url.pathname.match(/^\/api\/conversations\/([^/]+)\/message$/);
  if (convMessage && req.method === 'POST') {
    if (!/^[\w-]+$/.test(convMessage[1])) return fail(400, { error: 'Invalid conversation ID' });
    const body = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { return fail(400, { error: 'invalid JSON body' }); }
    if (typeof parsed.message !== 'string' || parsed.message.length === 0) {
      return fail(400, { error: 'message must be a non-empty string' });
    }
    const row = conversations.get(convMessage[1]) || null;
    if (!row) return fail(404, { error: 'Conversation not found' });
    pushMsg(convMessage[1], 'user', parsed.message);
    if (parsed.message.startsWith('/setproject')) {
      // Deterministic project selection (am7): validate BY NAME, then the
      // binding write is {codebase_id: …, cwd: null, isolation_env_id: null}.
      const projectName = parsed.message.replace(/^\/setproject\s+/, '').trim();
      const project = projectsByName.get(projectName) || null;
      if (project) {
        row.codebase_id = project.id;
        pushMsg(convMessage[1], 'assistant', 'Project set to **' + projectName + '**\nWorking directory: ' + project.default_cwd);
      } else {
        pushMsg(convMessage[1], 'assistant', 'Unknown project: ' + projectName);
      }
    }
    return json({ accepted: true, status: 'ok' });
  }

  // ---- /api/_mock admin routes (test-only; never present on real Archon) ----
  if (url.pathname === '/api/_mock/calls' && req.method === 'GET') {
    const dispatchRe = /^\/api\/workflows\/([a-z0-9-]+)\/run$/;
    return json({
      calls: callLog,
      count: callLog.length,
      createPosts: callLog.filter((c) => c.method === 'POST' && c.path === '/api/conversations').length,
      dispatchPosts: callLog.filter((c) => c.method === 'POST' && dispatchRe.test(c.path)).length,
    });
  }
  if (url.pathname === '/api/_mock/seed-run' && req.method === 'POST') {
    const body = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { return fail(400, { error: 'invalid JSON body' }); }
    if (typeof parsed.conversationId !== 'string' || parsed.conversationId.length === 0) {
      return fail(400, { error: 'conversationId must be a non-empty string' });
    }
    if (typeof parsed.workflowName !== 'string' || parsed.workflowName.length === 0) {
      return fail(400, { error: 'workflowName must be a non-empty string' });
    }
    const id = typeof parsed.id === 'string' && parsed.id ? parsed.id : 'run-mock-seed-' + String(++seedSeq).padStart(3, '0');
    const materialize = () => {
      dynamicRuns.unshift({
        id,
        conversation_id: parsed.conversationId,
        codebase_id: typeof parsed.codebaseId === 'string' && parsed.codebaseId ? parsed.codebaseId : null,
        // OP-4R: seed-run can now stamp working_path so a guard-matching
        // failed run (failed + working_path + linked) can be expressed.
        ...(typeof parsed.workingPath === 'string' && parsed.workingPath ? { working_path: parsed.workingPath } : {}),
        workflow_name: parsed.workflowName,
        user_message: typeof parsed.message === 'string' && parsed.message ? parsed.message : '(mock-seeded)',
        ...(typeof parsed.parentConversationId === 'string' && parsed.parentConversationId ? { parent_conversation_id: parsed.parentConversationId } : {}),
        ...(typeof parsed.parentPlatformId === 'string' && parsed.parentPlatformId ? { parent_platform_id: parsed.parentPlatformId } : {}),
        status: typeof parsed.status === 'string' && parsed.status ? parsed.status : 'completed',
        outcome: null,
        current_step_index: 2,
        started_at: Date.now(),
        metadata: { seeded: true },
        ...(typeof parsed.output === 'string' && parsed.output ? { output: parsed.output } : {}),
        // OP-4R: projection legs for the run-detail-retrieval proof. Stored
        // server-side only, never exposed; list strips parent_* when
        // listHidesParent is set, detail merges detailOnly over the row.
        ...((parsed.listHidesParent === true || (parsed.detailOnly && typeof parsed.detailOnly === 'object'))
          ? { __project: { ...(parsed.listHidesParent === true ? { listHidesParent: true } : {}), ...(parsed.detailOnly && typeof parsed.detailOnly === 'object' ? { detailOnly: parsed.detailOnly } : {}) } }
          : {}),
        receipt: { decision: 'ship', summary: 'Seeded by mock admin route.', artifacts: [] },
      });
    };
    const delayMs = Number(parsed.delayMs || 0);
    if (delayMs > 0) setTimeout(materialize, delayMs);
    else materialize();
    return json({ seeded: true, id, delayedMs: delayMs });
  }
  // OP-4R: byte-level wire log — every workflow dispatch this process saw.
  if (url.pathname === '/api/_mock/dispatches' && req.method === 'GET') {
    return json({ count: dispatchWires.length, wires: dispatchWires });
  }
  // OP-4R: register a conversation under KNOWN platform/db ids (the real
  // lifecycle mints these at provisioning) and push two provisioning rows so
  // the prior-run-menu detector's pre-dispatch snapshot is never empty.
  if (url.pathname === '/api/_mock/seed-conversation' && req.method === 'POST') {
    const body = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { return fail(400, { error: 'invalid JSON body' }); }
    if (typeof parsed.platformId !== 'string' || !parsed.platformId) return fail(400, { error: 'platformId must be a non-empty string' });
    if (typeof parsed.dbId !== 'string' || !parsed.dbId) return fail(400, { error: 'dbId must be a non-empty string' });
    let cb = null;
    if (parsed.codebaseId != null) {
      if (typeof parsed.codebaseId !== 'string' || !codebases.has(parsed.codebaseId)) {
        return fail(400, { error: 'Codebase not found: No codebase with id ' + String(parsed.codebaseId) });
      }
      cb = codebases.get(parsed.codebaseId);
    }
    const row = {
      platform_conversation_id: parsed.platformId,
      id: parsed.dbId,
      platform_type: 'web',
      codebase_id: parsed.codebaseId || null,
      cwd: null,
      ai_assistant_type: cb ? (cb.ai_assistant_type || 'claude') : 'claude',
      title: null,
      created_at: Date.now(),
    };
    conversations.set(parsed.platformId, row);
    convMessages.set(parsed.platformId, []);
    if (cb) {
      pushMsg(parsed.platformId, 'user', '/setproject ' + cb.name);
      pushMsg(parsed.platformId, 'assistant', 'Project set to **' + cb.name + '**\nWorking directory: ' + cb.default_cwd);
    }
    return json({ conversationId: parsed.platformId, id: parsed.dbId });
  }
  if (url.pathname === '/api/_mock/delay-next-dispatch' && req.method === 'POST') {
    const body = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { return fail(400, { error: 'invalid JSON body' }); }
    const ms = Number(parsed.ms || 0);
    if (!(ms > 0)) return fail(400, { error: 'ms must be a positive number' });
    delayNextDispatchMs = ms;
    return json({ armed: true, ms });
  }
  if (url.pathname === '/api/_mock/drop-next-dispatch' && req.method === 'POST') {
    dropNextDispatch = true;
    return json({ armed: true });
  }
  // OP-4R: arm the next dispatch to materialize ONLY `count` parent-linked
  // children (no direct run), forcing the revised-T1 parent-linked path.
  // Range-capped 1..8: 2 exercises run-ambiguous, more would only burn wall
  // time inside the 10s adoption deadline. Never touches delay/drop state.
  if (url.pathname === '/api/_mock/fork-next-dispatch' && req.method === 'POST') {
    const body = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { return fail(400, { error: 'invalid JSON body' }); }
    const count = Number(parsed.count || 0);
    if (!Number.isInteger(count) || count < 1 || count > 8) return fail(400, { error: 'count must be an integer 1..8' });
    forkNextDispatchCount = count;
    return json({ armed: true, count });
  }

  res.writeHead(404);
  res.end('not found');
}).listen(port, '127.0.0.1', () => console.log(`mock archon on :${port}`));
