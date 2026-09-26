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
import { createHash } from 'node:crypto';
import { stat, readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join as pathJoin, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserSupervisor, findChrome } from './browser.js';
import { resolveConfig } from './config.js';
import { buildStatus, unwrapCatalog } from './status.js';
import { runVerification, readReceipt } from './verify.js';
import { runGoal, listGoals, getGoal } from './goal.js';
import { listTasksRead, getTaskRead } from './tasks.js';
import { teachRCOS, promoteCandidate, listTeaching } from './teach.js';
import { acquireCapability } from './acquire.js';
import { exportCapability, stagePackage, verifyImport, admitImport } from './flowrouter.js';
import { resolveFederated, fetchExact } from './federation.js';
import { verifyProofCore, recordProof, listProofRecords, acknowledgeProof, quarantinedPublishers, isQuarantined, proofFromLocalHistory, QUARANTINE_CODE } from './equivocation.js';
import { capabilityHistory } from './history.js';

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

// ---------------------------------------------- W2 agent verbs: host implementations
//
// The gate is resolved PER CALL from operator-ui.config.json (same restart-free
// contract as every other key). Workflow names and ids are constrained before
// they are ever interpolated into a URL, so a crafted name cannot redirect the
// request to another Archon route. `fetch` is a deliberate direct use rather
// than the read-only archonGet() helper above: that helper is the W1 read
// surface and must stay incapable of POSTing, while these verbs own the one
// sanctioned mutation (and only behind the gate).

const WORKFLOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function archonError(e, baseUrl) {
  const msg = String((e && e.message) || e);
  const unreachable = /fetch failed|ECONNREFUSED|timeout|aborted|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN/i.test(msg);
  return {
    ok: false,
    unreachable,
    baseUrl,
    error: unreachable ? 'Archon not reachable at ' + baseUrl : msg.slice(0, 300),
  };
}

// The acceptance body is hashed and reported whole: a dispatch answers an
// ACCEPTANCE, not the run, and this repo has already been bitten by treating a
// missing run id as success (see docs/ARCHON-INTEGRATION.md). Nothing here
// invents a run id Archon did not send.
function acceptanceFrom(body) {
  const token = body && (body.runId || body.run_id || body.correlationId || (body.run && body.run.id));
  return {
    accepted: !!(body && body.accepted),
    status: (body && typeof body.status === 'string') ? body.status : null,
    runId: token ? String(token) : null,
  };
}

async function hostWorkflowRun({ workflow, conversationId, message }) {
  const resolved = resolveConfig();
  const cfg = resolved.config;
  const baseUrl = cfg.archon.baseUrl;

  // THE GATE. OFF (or absent) short-circuits here: no URL is built, no fetch is
  // called, and — deliberately — not even a reachability read is attempted, so
  // "gate OFF" means zero traffic to Archon, not merely zero accepted POSTs.
  if (cfg.allowRun !== true) {
    return {
      ok: false,
      refused: true,
      allowRun: false,
      allowRunSource: resolved.sources.allowRun || 'default',
      workflow: String(workflow || ''),
      conversationId: String(conversationId || ''),
      baseUrl,
      error: 'workflow_run is disabled: set "allowRun": true in ' + resolved.path +
        ' to arm run-triggering for this plugin row (current value: ' + JSON.stringify(cfg.allowRun) +
        ', source: ' + (resolved.sources.allowRun || 'default') +
        '). Read-only verbs workflow_status and workflow_artifacts are unaffected. No request was sent to Archon.',
    };
  }

  if (typeof workflow !== 'string' || !WORKFLOW_NAME_RE.test(workflow)) {
    return { ok: false, allowRun: true, workflow: String(workflow || ''), baseUrl, error: 'bad workflow name (letters, digits, dot, underscore, dash only)' };
  }
  if (typeof conversationId !== 'string' || !conversationId.trim() || conversationId.length > 200) {
    return { ok: false, allowRun: true, workflow, baseUrl, error: 'conversationId must be a non-empty string (Archon rejects a dispatch without one)' };
  }

  const headers = { 'content-type': 'application/json' };
  const tokenVar = cfg.archon.tokenVar;
  if (typeof tokenVar === 'string' && process.env[tokenVar]) headers.authorization = 'Bearer ' + process.env[tokenVar];

  const payload = { conversationId: conversationId.trim() };
  if (typeof message === 'string' && message.length > 0) payload.message = message.slice(0, 20000);

  try {
    const res = await fetch(baseUrl + '/api/workflows/' + encodeURIComponent(workflow) + '/run', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.max(cfg.archon.timeoutMs, 10000)),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) {
      return { ok: false, allowRun: true, workflow, conversationId: conversationId.trim(), baseUrl, accepted: false, error: 'Archon dispatch HTTP ' + res.status + (body && body.error ? ': ' + String(body.error).slice(0, 200) : '') };
    }
    const acc = acceptanceFrom(body);
    return {
      ok: true,
      allowRun: true,
      workflow,
      conversationId: conversationId.trim(),
      baseUrl,
      accepted: acc.accepted,
      status: acc.status,
      runId: acc.runId,
      responseSha256: 'sha256:' + createHash('sha256').update(JSON.stringify(body === null ? text : body)).digest('hex'),
      dispatch: { responseKeys: body && typeof body === 'object' ? Object.keys(body).slice(0, 20) : [], runIdFromAcceptance: acc.runId },
    };
  } catch (e) {
    return { ok: false, allowRun: true, workflow, conversationId: conversationId.trim(), baseUrl, ...archonError(e, baseUrl) };
  }
}

async function hostWorkflowStatus({ id, limit }) {
  const cfg = resolveConfig().config;
  const baseUrl = cfg.archon.baseUrl;
  const headers = {};
  const tokenVar = cfg.archon.tokenVar;
  if (typeof tokenVar === 'string' && process.env[tokenVar]) headers.authorization = 'Bearer ' + process.env[tokenVar];
  try {
    if (id !== undefined && id !== null && id !== '') {
      if (typeof id !== 'string' || !RUN_ID_RE.test(id)) return { ok: false, baseUrl, id: String(id), error: 'bad run id' };
      const res = await fetch(baseUrl + '/api/workflows/runs/' + encodeURIComponent(id), { headers, signal: AbortSignal.timeout(cfg.archon.timeoutMs) });
      if (!res.ok) return { ok: false, baseUrl, id, error: 'Archon HTTP ' + res.status };
      const body = await res.json();
      const run = body && body.run ? body.run : body;
      return { ok: true, baseUrl, id, run: run || null };
    }
    const n = Math.min(50, Math.max(1, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 20));
    const res = await fetch(baseUrl + '/api/workflows/runs?limit=' + n, { headers, signal: AbortSignal.timeout(cfg.archon.timeoutMs) });
    if (!res.ok) return { ok: false, baseUrl, error: 'Archon HTTP ' + res.status };
    const body = await res.json();
    const runs = (body && body.runs) || [];
    return { ok: true, baseUrl, count: runs.length, runs };
  } catch (e) {
    return { ok: false, baseUrl, ...archonError(e, baseUrl) };
  }
}

// Artifact truth comes from the run record Archon serves: the receipt's
// declared artifact list plus any artifact-ish path the run/events carry. The
// authoritative on-disk directory belongs to the Archon host and is named as a
// pointer only — this plugin never reads it, and never claims a file exists
// that Archon did not declare.
async function hostWorkflowArtifacts({ id }) {
  const cfg = resolveConfig().config;
  const baseUrl = cfg.archon.baseUrl;
  const headers = {};
  const tokenVar = cfg.archon.tokenVar;
  if (typeof tokenVar === 'string' && process.env[tokenVar]) headers.authorization = 'Bearer ' + process.env[tokenVar];
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) return { ok: false, baseUrl, id: String(id || ''), error: 'bad run id' };
  try {
    const res = await fetch(baseUrl + '/api/workflows/runs/' + encodeURIComponent(id), { headers, signal: AbortSignal.timeout(cfg.archon.timeoutMs) });
    if (!res.ok) return { ok: false, baseUrl, id, error: 'Archon HTTP ' + res.status };
    const body = await res.json();
    const run = (body && body.run ? body.run : body) || {};
    const events = (body && body.events) || [];
    const artifacts = [];
    const add = (v) => {
      const s = typeof v === 'string' ? v.trim() : '';
      if (s && s.length <= 300 && !artifacts.includes(s)) artifacts.push(s);
    };
    const receipt = run.receipt || null;
    if (receipt && Array.isArray(receipt.artifacts)) for (const a of receipt.artifacts.slice(0, 200)) add(a);
    if (Array.isArray(run.artifacts)) for (const a of run.artifacts.slice(0, 200)) add(typeof a === 'string' ? a : a && a.path);
    for (const ev of events.slice(0, 500)) {
      const d = ev && ev.data;
      if (d && Array.isArray(d.artifacts)) for (const a of d.artifacts.slice(0, 200)) add(a);
    }
    return {
      ok: true,
      baseUrl,
      id,
      status: typeof run.status === 'string' ? run.status : null,
      path: typeof run.artifacts_dir === 'string' ? run.artifacts_dir : (typeof run.artifact_dir === 'string' ? run.artifact_dir : null),
      receiptDecision: receipt && typeof receipt.decision === 'string' ? receipt.decision : null,
      count: artifacts.length,
      artifacts: artifacts.slice(0, 200),
    };
  } catch (e) {
    return { ok: false, baseUrl, id, ...archonError(e, baseUrl) };
  }
}

// ------------------------------------------------------------------ goal runner

// M1-candidate surface, shipped zero-credential: objective → registry-routed
// capability → Archon execution → evidence evaluation → SHIP/BLOCK/FAILED.
// task_id is born here (above DSH/Archon); goal envelopes are durable in
// $DSH_HOME/operator-ui/tasks.json — the durable records are the Archon run,
// the task envelope, and the sealed receipts.
async function handleGoal(req, res, url) {
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8000) return sendJson(res, 413, { ok: false, error: 'body too large' });
    }
    let p;
    try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
    try {
      // Approval resumes an awaiting-approval task: SAME task id, new attempt,
      // with the approved flag so the authority gate dispatches. The gate
      // re-checks the stored envelope is genuinely awaiting-approval first —
      // an approval for any other state is refused, never silently executed.
      if (p.approveTaskId) {
        // GET /goal returns durable ENVELOPES: verdict is {decision, …} and
        // failureCodes live inside it — normalize before the gate check.
        const pending = await getGoal(String(p.approveTaskId).slice(0, 120));
        const pv = pending && pending.verdict;
        const vStr = typeof pv === 'string' ? pv : (pv && pv.decision) || null;
        const codes = new Set(Array.isArray(pending && pending.failureCodes)
          ? pending.failureCodes
          : (pv && pv.failureCodes) || []);
        if (!pending || vStr !== 'PENDING' || !codes.has('awaiting-approval')) {
          return sendJson(res, 409, { ok: false, error: 'task is not awaiting approval' });
        }
        // The retry authorization is named honestly at its source: the operator
        // approved THROUGH this endpoint, and goal.js carries the genuine
        // original approval timestamp forward rather than re-stamping it.
        const goal = await runGoal({ retryOf: pending.taskId, approved: true, authorization: { source: 'approve-task' } });
        return sendJson(res, 200, { ok: true, goal });
      }
      const goal = await runGoal({ objective: p.objective, retryOf: p.retryOf, forkOf: p.forkOf });
      return sendJson(res, 200, { ok: true, goal });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String((e && e.message) || e).slice(0, 200) });
    }
  }
  if (req.method === 'GET') {
    const id = url.searchParams.get('id');
    if (id) {
      // getTaskRead exposes the recovery identity block (reconciled/unresolved)
      // and the archonRead state; the plain envelope stays backward compatible.
      const read = await getTaskRead(id);
      if (!read.task) return sendJson(res, 404, { ok: false, error: 'no such goal' });
      return sendJson(res, read.state === 'ok' ? 200 : 200, {
        ok: true,
        goal: read.task,
        ...(read.identity ? { recoveryIdentity: read.identity } : {}),
        ...(read.state !== 'ok' ? { archonRead: read.state, archonReadReason: read.reason } : {}),
      });
    }
    const list = await listTasksRead();
    return sendJson(res, 200, {
      ok: true,
      goals: list.tasks,
      archonRead: list.state,
      ...(list.reason ? { archonReadReason: list.reason } : {}),
    });
  }
  return sendJson(res, 405, { ok: false, error: 'GET or POST only' });
}

// Teach Mode (M2): capability ACQUISITION. POST {sourceTaskId} opens a
// teaching task (build → evaluate on the real Archon → candidate or honest
// refusal); POST {promoteTaskId} is the explicit human promotion; GET reads
// durable teaching envelopes from the task store (no third store).
// PRODUCTION acquisition route (GPT productization): the proven staged
// mechanism on the real task workspace. Promotion goes through the SAME
// explicit operator machinery as Teach (promoteTaskId → teach.js).
async function handleAcquire(req, res, url) {
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2000) return sendJson(res, 413, { ok: false, error: 'body too large' });
    }
    let p;
    try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
    try {
      if (p.promoteTaskId) {
        const out = await promoteCandidate({ teachingTaskId: p.promoteTaskId });
        return out.ok ? sendJson(res, 200, out) : sendJson(res, 409, out);
      }
      if (p.sourceTaskId) {
        const out = await acquireCapability({ sourceTaskId: String(p.sourceTaskId).slice(0, 120) });
        return out.ok ? sendJson(res, 200, out) : sendJson(res, 400, out);
      }
      return sendJson(res, 400, { ok: false, error: 'sourceTaskId or promoteTaskId required' });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String((e && e.message) || e).slice(0, 200) });
    }
  }
  if (req.method === 'GET') {
    const t = await listTeaching();
    return sendJson(res, 200, { ok: true, teaching: t });
  }
  return sendJson(res, 405, { ok: false, error: 'GET or POST only' });
}

// FlowRouter portability P0 (export / stage / verify / admit) — local
// transport only, no networking.
async function handleFlowrouter(req, res, url) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    // op=stage carries the publisher's identity material: genesis + the full
    // key-state event chain + the assertion. That grows with every rotation,
    // so the cap is generous by design — a long-lived identity legitimately
    // exceeds a few KB.
    if (body.length > 512_000) return sendJson(res, 413, { ok: false, error: 'body too large' });
  }
  let p;
  try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
  const op = url.searchParams.get('op') || p.op;
  try {
    let out;
    if (op === 'export') out = await exportCapability({ capabilityId: String(p.capabilityId || '').slice(0, 120), outDir: String(p.outDir || '').slice(0, 500) });
    else if (op === 'stage') out = await stagePackage({ packageDir: String(p.packageDir || '').slice(0, 500), alias: p.alias ? String(p.alias).slice(0, 120) : undefined, identityMaterial: p.identityMaterial || undefined, expectedTuple: p.expectedTuple || undefined });
    else if (op === 'verify') out = await verifyImport({ importTaskId: String(p.importTaskId || '').slice(0, 120), fixtureDir: String(p.fixtureDir || '').slice(0, 500) });
    else if (op === 'admit') out = await admitImport({ importTaskId: String(p.importTaskId || '').slice(0, 120), alias: p.alias ? String(p.alias).slice(0, 120) : undefined });
    else return sendJson(res, 400, { ok: false, error: 'op must be export|stage|verify|admit' });
    return sendJson(res, out.ok ? 200 : 409, out);
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String((e && e.message) || e).slice(0, 200) });
  }
}

// Federation F0: READ-ONLY resolution (pins/registry/admission untouched)
// + exact-D fetch from an already-VALID peer.
async function handleFederation(req, res, url) {
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64_000) return sendJson(res, 413, { ok: false, error: 'body too large' });
  }
  let p;
  try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
  const op = url.searchParams.get('op') || p.op;
  try {
    if (op === 'resolve') {
      const out = await resolveFederated({ peers: p.peers, scheme: p.scheme, publisher_id: p.publisher_id, name: p.name, version: p.version });
      return sendJson(res, 200, out);
    }
    if (op === 'fetch') {
      // fetch consumes a B-authored resolution HANDLE — never a caller's
      // replayed resolution JSON — and re-observes the byte source itself.
      const out = await fetchExact({ resolutionHandle: p.resolution_handle, D: p.D, bytesFrom: p.bytes_from });
      return sendJson(res, 200, out);
    }
    return sendJson(res, 400, { ok: false, error: 'op must be resolve|fetch' });
  } catch (e) {
    return sendJson(res, 409, { ok: false, error: e.code || String(e.message), reason: String(e.message).slice(0, 200) });
  }
}

// F1 (spec e9e7ef6): equivocation evidence. verify is read-only; ingest is
// the ONLY state-changing operation and it verifies before recording.
async function handleF1(req, res, url) {
  const op = url.searchParams.get('op') || 'status';
  if (op === 'status') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    const publisherId = url.searchParams.get('publisher_id') || null;
    const proofs = await listProofRecords(publisherId || undefined);
    return sendJson(res, 200, {
      ok: true,
      quarantined: publisherId ? await isQuarantined(publisherId) : null,
      quarantined_publishers: await quarantinedPublishers(),
      proofs: proofs.map((t) => ({ proof_digest: t.proof_digest, publisher_id: t.publisher_id, relation: t.relation, acknowledged: t.acknowledged || null, recordedAt: t.recordedAt, observed_via: t.observed_via || [] })),
    });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 512_000) return sendJson(res, 413, { ok: false, error: 'body too large' });
  }
  let p;
  try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
  try {
    if (op === 'verify') {
      // OFFLINE, read-only, whole-or-nothing: never records anything
      const v = verifyProofCore(p.proof_core);
      return sendJson(res, 200, { ok: true, ...v });
    }
    if (op === 'local-proof') {
      // §3.2: build a fork proof from the CONSUMER'S OWN pinned witness — no
      // peer involved, nothing recorded (read-only construction)
      const out = await proofFromLocalHistory({ publisherId: String(p.publisher_id || '').slice(0, 64), observed: p.observed || {} });
      return out.ok
        ? sendJson(res, 200, { ok: true, proof_core: out.core, proof_digest: out.proof_digest, source: 'local-pinned-witness' })
        : sendJson(res, 409, out);
    }
    if (op === 'ingest') {
      const out = await recordProof({ core: p.proof_core, observedVia: p.observed_via });
      return sendJson(res, 200, { ok: true, recorded: out.recorded, deduplicated: !!out.deduplicated, proof_digest: out.proof_digest, quarantined: await isQuarantined(out.record.publisher_id), acknowledgement_required: true });
    }
    if (op === 'acknowledge') {
      const out = await acknowledgeProof({ proofDigest: p.proof_digest, operator: p.operator });
      return out.ok ? sendJson(res, 200, { ok: true, still_quarantined: out.still_quarantined }) : sendJson(res, 404, out);
    }
    return sendJson(res, 400, { ok: false, error: 'op must be verify|ingest|acknowledge|status' });
  } catch (e) {
    return sendJson(res, 409, { ok: false, error: e.code || String(e.message), reason: String(e.message).slice(0, 200) });
  }
}

async function handleTeach(req, res, url) {
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2000) return sendJson(res, 413, { ok: false, error: 'body too large' });
    }
    let p;
    try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
    try {
      if (p.promoteTaskId) {
        const out = await promoteCandidate({ teachingTaskId: p.promoteTaskId });
        return out.ok ? sendJson(res, 200, out) : sendJson(res, 409, out);
      }
      if (p.sourceTaskId) {
        const teaching = await teachRCOS({ sourceTaskId: p.sourceTaskId });
        return sendJson(res, 200, { ok: true, teaching });
      }
      return sendJson(res, 400, { ok: false, error: 'sourceTaskId or promoteTaskId required' });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String((e && e.message) || e).slice(0, 200) });
    }
  }
  if (req.method === 'GET') {
    const id = url.searchParams.get('id');
    if (id) {
      const t = await listTeaching();
      const hit = t.find((x) => x.taskId === id);
      return hit ? sendJson(res, 200, { ok: true, teaching: hit }) : sendJson(res, 404, { ok: false, error: 'no such teaching task' });
    }
    return sendJson(res, 200, { ok: true, teaching: await listTeaching() });
  }
  return sendJson(res, 405, { ok: false, error: 'GET or POST only' });
}

async function handleArchon(req, res, url) {  const op = url.searchParams.get('op') || 'runs';
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
  if (op === 'history') {
    // M2.5 capability operating history: a READ MODEL over tasks.json —
    // uses, objective-satisfaction record, decay (named, never a score).
    try {
      return sendJson(res, 200, { ok: true, ...(await capabilityHistory()) });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
  }
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
        if (url.pathname === GIT_ROUTE + '/goal') {
          return await handleGoal(req, res, url);
        }
        if (url.pathname === GIT_ROUTE + '/teach') {
          return await handleTeach(req, res, url);
        }
        if (url.pathname === GIT_ROUTE + '/acquire') {
          return await handleAcquire(req, res, url);
        }
        if (url.pathname === GIT_ROUTE + '/flowrouter') {
          return await handleFlowrouter(req, res, url);
        }
        if (url.pathname === GIT_ROUTE + '/federation') {
          return await handleFederation(req, res, url);
        }
        if (url.pathname === GIT_ROUTE + '/f1') {
          return await handleF1(req, res, url);
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

  // ------------------------------------------------ W2 agent verbs (gated)
  // workflow_status / workflow_artifacts are READ-only reads of the same Archon
  // API the /archon proxy already serves; workflow_run is the single
  // run-TRIGGERING verb and refuses unless the operator sets "allowRun": true
  // in the config file. With the gate OFF no POST is issued and no connection
  // to Archon is opened at all — the refusal happens before the gate's own
  // status read, and the status/artifacts verbs never POST under any flag.
  //
  // A verb's OUTPUT CARRIES ITS OWN OUTCOME: defineTool validates output
  // structurally but callers routinely receive raw values through the fixpoint,
  // so every refusal is returned as { ok: false, refused: true, error } rather
  // than thrown — a refusal that can be mistaken for a transport failure would
  // make the gate unverifiable from the outside.
  ctx.effect(() => {
    ctx.tools.register(defineTool({
      name: 'workflow_run',
      description: 'Trigger a named Archon workflow run from the plugin host. GATED: refuses with refused=true unless "allowRun": true is set for this plugin row in $DSH_HOME/operator-ui.config.json (default OFF). The dispatch answers an ACCEPTANCE, not the run — treat runId as a hint and confirm it with workflow_status.',
      parameters: {
        workflow: { type: 'string', required: true, description: 'Workflow name as it appears in the Archon catalog (see GET /plugins/operator-ui/archon?op=catalog).' },
        conversationId: { type: 'string', required: true, description: 'Archon conversation id the run is dispatched into. Archon rejects a dispatch without one.' },
        message: { type: 'string', description: 'Prompt/message for the run. Forwarded verbatim when given.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            refused: { type: 'boolean' },
            error: { type: 'string' },
            allowRun: { type: 'boolean' },
            allowRunSource: { type: 'string' },
            workflow: { type: 'string' },
            conversationId: { type: 'string' },
            accepted: { type: 'boolean' },
            status: { type: 'string' },
            runId: { type: 'string' },
            responseSha256: { type: 'string' },
            baseUrl: { type: 'string' },
            dispatch: { type: 'json' },
          },
        },
        render: (_a, v) => [{
          type: 'text',
          text: v && v.ok
            ? `Dispatched ${v.workflow} to Archon (${v.baseUrl}) as an acceptance: accepted=${v.accepted}, status=${v.status === null ? 'null' : v.status}, runId=${v.runId === null ? 'not carried by the acceptance' : v.runId}. Confirm the run with workflow_status.`
            : `workflow_run refused: ${(v && v.error) || 'unknown error'}`,
        }],
      },
      execute: (args) => hostWorkflowRun(args),
    }));

    ctx.tools.register(defineTool({
      name: 'workflow_status',
      description: 'Read one Archon workflow run by id (status, current step, message, model bindings, receipt decision) or the most recent runs when no id is given. Read-only: never dispatches.',
      parameters: {
        id: { type: 'string', description: 'Run id from the Archon catalog or a dispatch. Omit to list recent runs.' },
        limit: { type: 'integer', description: 'Max runs to list when id is omitted (default 20, capped 50).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            error: { type: 'string' },
            unreachable: { type: 'boolean' },
            baseUrl: { type: 'string' },
            id: { type: 'string' },
            count: { type: 'integer' },
            run: { type: 'json' },
            runs: { type: 'json' },
          },
        },
        render: (_a, v) => {
          if (!v || !v.ok) return [{ type: 'text', text: `workflow_status failed: ${(v && v.error) || 'unknown error'}${v && v.unreachable ? ' (Archon unreachable)' : ''}` }];
          if (v.id) return [{ type: 'text', text: `Archon run ${v.id} — status ${(v.run && v.run.status) || 'unknown'}, step ${v.run && v.run.current_step_index != null ? v.run.current_step_index : '?'}${v.run && v.run.workflow_name ? ' (' + v.run.workflow_name + ')' : ''}.` }];
          return [{ type: 'text', text: `Latest ${v.count} Archon run(s) from ${v.baseUrl}: ${(v.runs || []).slice(0, 10).map((r) => (r && r.workflow_name) + ' #' + (r && r.id) + ' [' + ((r && r.status) || 'unknown') + ']').join(', ') || 'none'}` }];
        },
      },
      execute: (args) => hostWorkflowStatus(args),
    }));

    ctx.tools.register(defineTool({
      name: 'workflow_artifacts',
      description: 'List the artifacts a completed Archon run declares (its receipt artifacts plus any artifact paths recorded on the run). Read-only: never dispatches, and never reads outside the Archon API.',
      parameters: {
        id: { type: 'string', required: true, description: 'Run id whose artifacts are wanted.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            error: { type: 'string' },
            unreachable: { type: 'boolean' },
            baseUrl: { type: 'string' },
            id: { type: 'string' },
            status: { type: 'string' },
            path: { type: 'string' },
            count: { type: 'integer' },
            artifacts: { type: 'json' },
            receiptDecision: { type: 'string' },
          },
        },
        render: (_a, v) => [{
          type: 'text',
          text: v && v.ok
            ? `Run ${v.id} declares ${v.count} artifact(s)${v.receiptDecision ? ' under receipt ' + v.receiptDecision : ''}: ${(v.artifacts || []).slice(0, 20).join(', ') || 'none'}`
            : `workflow_artifacts failed: ${(v && v.error) || 'unknown error'}`,
        }],
      },
      execute: (args) => hostWorkflowArtifacts(args),
    }));
  });

  // ------------------------------------------------------------ teardown
  ctx.effect(() => async () => {
    await browser.dispose();
  });
}
