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
import { mkdir, stat, readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join as pathJoin, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserSupervisor, findChrome } from './browser.js';
import { resolveConfig } from './config.js';
import { buildStatus, unwrapCatalog } from './status.js';
import { runVerification, readReceipt } from './verify.js';
import { runGoal, listGoals, getGoal } from './goal.js';
import { listTasksRead, getTaskRead, getTask, upsertTask } from './tasks.js';
import { provisionConversation, verifyConversationAssociation, transportForWorkspace } from './conversation.js';
import { createWorkspace, guidedWorkspacePath, listWorkspaces, resolveWorkspace, readCodebase } from './workspace.js';
import { publicEnvironments, defaultEnvironmentId, requireEnvironmentForOwner, requireEnvironmentAdapter } from './environments.js';
import { executeScoped, killScoped, solariReadiness } from './solari.js';
// P6D: the execution leg's second witness — written ONLY on a run that
// actually executed (ok:true), keyed by a server-minted id the workflow can
// carry but never forge.
import { writeBridgeReceipt } from './bridge-receipt.js';
import { authenticateRequest, ownerForRequest, environmentAllowedForPrincipal, taskAuthorizedForPrincipal, publicAuth, AUTH_REFUSAL } from './auth.js';
import { teachRCOS, promoteCandidate, listTeaching } from './teach.js';
import { acquireCapability } from './acquire.js';
import { exportCapability, stagePackage, verifyImport, admitImport } from './flowrouter.js';
import { admitExecution } from './admission.js';
import { resolveFederated, fetchExact } from './federation.js';
import { verifyProofCore, recordProof, listProofRecords, acknowledgeProof, quarantinedPublishers, isQuarantined, proofFromLocalHistory, QUARANTINE_CODE } from './equivocation.js';
import { capabilityHistory } from './history.js';
import { marketplaceStatus, searchMarketplace, fetchMarketplaceEntry, scopeEntriesForPrincipal, entryVisibleToPrincipal, importMarketplaceWorkflow, listInstallations } from './marketplace.js';
import { hostCompat, detectToolsVersion, judgeDsh, judgeTools, bannerBox } from './compat.js';
import { wmReceiptBridge } from './wm-bridge.js';

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

// Compatibility verdict, computed ONCE at module load: which DSH is this
// running inside, and which dsh-tools did we bind to? Both are reported on
// the status surface; here they only decide whether the boot log says
// something. A mismatch is REPORTED, never a refusal — see lib/compat.js,
// which records why (the 0.1.5-rc.3 A/B booted and served normally, so
// refusing would be a false alarm, and a false alarm is worse than a warning
// nobody asked for). The one thing this can be trusted to do is name both
// numbers before anyone treats the install as verified.
let HOST_COMPAT = null;
let TOOLS_COMPAT = null;
try {
  HOST_COMPAT = hostCompat();
  TOOLS_COMPAT = judgeTools(detectToolsVersion().version);
} catch { /* detection must never take the plugin down */ }

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

// ------------------------------------------------------------------ P3B auth helpers
// The principal this request authenticated as at the chokepoint (null in dev
// mode — every check below short-circuits and the pre-P3B path runs
// unchanged, byte for byte).
function principalOf(req) {
  return (req && req.auth && req.auth.principal) || null;
}

// The stored owner of a record: its own owner field when it carries one,
// otherwise the owner on its recorded workspace. NEVER a caller-supplied
// field. null = unattributed, which taskAuthorizedForPrincipal fail-closes in
// required mode: workspace-less envelopes and legacy reconstructed rows
// (neither records an owner) can be acted on by no principal.
function ownerOfRecord(record) {
  if (!record) return null;
  if (typeof record.owner === 'string' && record.owner.trim() !== '') return record.owner.trim();
  const wsOwner = record.workspace && record.workspace.owner;
  return typeof wsOwner === 'string' && wsOwner.trim() !== '' ? wsOwner.trim() : null;
}

// Shape an auth check's refusal exactly like every other refusal on this
// surface: a transport status with {ok:false, error, code}, sent BEFORE any
// store write or orchestrator contact.
function sendAuthRefusal(res, check) {
  return sendJson(res, check.status, { ok: false, error: check.error, code: check.code });
}

// Authorize a stored task before acting on it. A missing record is left to
// the operation's own not-found refusal; only a record that EXISTS is checked
// against its stored owner. Read-only — nothing here contacts the orchestrator.
async function authorizeTaskRecord(req, taskId) {
  const principal = principalOf(req);
  if (!principal) return { ok: true };
  const record = await getTask(taskId);
  if (!record) return { ok: true };
  const check = taskAuthorizedForPrincipal({ principal, recordOwner: ownerOfRecord(record), label: 'task ' + taskId });
  return check.ok ? { ok: true } : check;
}

// The principal environment check for a retry/fork/approve anchor: the
// WORKSPACE the anchor recorded (resolved live, read-only — if it no longer
// resolves, runGoal's own resolution refuses there), else the configured
// default for a workspace-less anchor (required mode refuses those earlier).
async function environmentAllowedForAnchor(req, anchorWorkspace) {
  const principal = principalOf(req);
  if (!principal) return { ok: true };
  if (anchorWorkspace && anchorWorkspace.workspaceId && anchorWorkspace.owner) {
    try {
      const ws = await resolveWorkspace({ workspaceId: anchorWorkspace.workspaceId, owner: anchorWorkspace.owner });
      return environmentAllowedForPrincipal({ principal, environmentId: ws.environmentId });
    } catch {
      return { ok: true };
    }
  }
  return environmentAllowedForPrincipal({ principal, environmentId: defaultEnvironmentId(resolveConfig().config) });
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
    // P3B: the authenticated principal establishes the owner BEFORE anything
    // else. The caller's owner field may only BE one of the principal's own
    // owners — it can never BECOME authority by being supplied (dev mode:
    // principal null; the owner passes through unchanged).
    const principal = principalOf(req);
    const ownerDecision = ownerForRequest({ principal, owner: p.owner });
    if (!ownerDecision.ok) return sendAuthRefusal(res, ownerDecision);
    const owner = ownerDecision.owner;
    try {
      // Approval resumes an awaiting-approval task: SAME task id, new attempt,
      // with the approved flag so the authority gate dispatches. The gate
      // re-checks the stored envelope is genuinely awaiting-approval first —
      // an approval for any other state is refused, never silently executed.
      if (p.approveTaskId) {
        // GET /goal returns durable ENVELOPES: verdict is {decision, …} and
        // failureCodes live inside it — normalize before the gate check.
        const pending = await getGoal(String(p.approveTaskId).slice(0, 120));
        if (pending) {
          // P3B: approving is acting on a stored task — authorize against the
          // RECORD's stored owner (never the request) and the anchor's
          // environment, before the state gate and before goal.js reaches the
          // orchestrator. Dev: principal null, both checks no-op.
          const anchor = taskAuthorizedForPrincipal({ principal, recordOwner: ownerOfRecord(pending), label: 'task ' + pending.taskId });
          if (!anchor.ok) return sendAuthRefusal(res, anchor);
          const envOk = await environmentAllowedForAnchor(req, pending.workspace);
          if (!envOk.ok) return sendAuthRefusal(res, envOk);
        }
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
      if (p.retryOf || p.forkOf) {
        // P3B: a retry/fork inherits the anchor's identity — authorize the
        // stored parent against ITS record owner and environment first
        // (read-only; a parent that does not exist stays goal.js's refusal).
        const parent = await getTask(String(p.retryOf || p.forkOf).slice(0, 120));
        if (parent) {
          const anchor = taskAuthorizedForPrincipal({ principal, recordOwner: ownerOfRecord(parent), label: 'task ' + parent.taskId });
          if (!anchor.ok) return sendAuthRefusal(res, anchor);
          const envOk = await environmentAllowedForAnchor(req, parent.workspace);
          if (!envOk.ok) return sendAuthRefusal(res, envOk);
        }
      } else if (p.workspaceId && principal) {
        // P3B: resolve the workspace HERE so a foreign id is the store's own
        // 403 workspace-owner-mismatch (zero contact) and the environment
        // check answers for the STORED environment, not a request field.
        const ws = await resolveWorkspace({ workspaceId: p.workspaceId, owner });
        const envCheck = environmentAllowedForPrincipal({ principal, environmentId: ws.environmentId });
        if (!envCheck.ok) return sendAuthRefusal(res, envCheck);
      } else if (!p.workspaceId && principal) {
        // P3B required mode: a workspace-less envelope records NO owner, so
        // no principal could ever act on it again — refuse before creation.
        return sendJson(res, 403, {
          ok: false,
          code: AUTH_REFUSAL.UNATTRIBUTED,
          error: 'owner attribution required: a required-mode goal must be anchored to a workspace the principal is authorized for',
        });
      }
      const goal = await runGoal({ objective: p.objective, retryOf: p.retryOf, forkOf: p.forkOf, workspaceId: p.workspaceId, owner, environmentId: p.environmentId });
      return sendJson(res, 200, { ok: true, goal });
    } catch (e) {
      const code = (e && e.code) || null;
      // A workspace or environment that is unknown, foreign, malformed, or
      // declared-but-not-executable-here is a request error, not a server fault:
      // answer it with its own status so the caller sees which input was refused.
      // Every other coded throw keeps the plain 500 — but it KEEPS ITS CODE:
      // dropping the code here is how a typed refusal becomes an anonymous one,
      // which is the mechanism that let an unreadable store leave the process
      // byte-identical to a business refusal. A catch must never erase identity.
      if (typeof code === 'string' && (code.startsWith('workspace-') || code.startsWith('environment-'))) {
        return sendJson(res, workspaceStatus(code), { ok: false, error: String((e && e.message) || e).slice(0, 200), code });
      }
      if (typeof code === 'string' && code.startsWith('solari-')) {
        return sendJson(res, solariStatusFor(code), { ok: false, error: String((e && e.message) || e).slice(0, 200), code });
      }
      return sendJson(res, 500, { ok: false, error: String((e && e.message) || e).slice(0, 200), ...(code ? { code } : {}) });
    }
  }
  if (req.method === 'GET') {
    const id = url.searchParams.get('id');
    if (id) {
      // getTaskRead exposes the recovery identity block (reconciled/unresolved)
      // and the archonRead state; the plain envelope stays backward compatible.
      const read = await getTaskRead(id);
      if (!read.task) return sendJson(res, 404, { ok: false, error: 'no such goal' });
      // P3B: reading one record authorizes against ITS stored owner — the
      // request cannot point at a record it may not act on.
      const anchor = taskAuthorizedForPrincipal({ principal: principalOf(req), recordOwner: ownerOfRecord(read.task), label: 'task ' + id });
      if (!anchor.ok) return sendAuthRefusal(res, anchor);
      return sendJson(res, read.state === 'ok' ? 200 : 200, {
        ok: true,
        goal: read.task,
        ...(read.identity ? { recoveryIdentity: read.identity } : {}),
        ...(read.state !== 'ok' ? { archonRead: read.state, archonReadReason: read.reason } : {}),
      });
    }
    const list = await listTasksRead();
    // P3B: the list answers only with records this principal may act on
    // (dev mode: principal null, the untouched list is returned).
    const principal = principalOf(req);
    const goals = principal
      ? list.tasks.filter((task) => taskAuthorizedForPrincipal({ principal, recordOwner: ownerOfRecord(task) }).ok)
      : list.tasks;
    return sendJson(res, 200, {
      ok: true,
      goals,
      archonRead: list.state,
      ...(list.reason ? { archonReadReason: list.reason } : {}),
    });
  }
  return sendJson(res, 405, { ok: false, error: 'GET or POST only' });
}

// --------------------------------------------------------------- workspace (P2)
// A workspace is the Archon CODEBASE a task's conversation binds to — a third
// identity, distinct from the task and from the conversation. Creation goes
// through Archon's supported codebase API, and the row Archon returns is the
// only authority for the id, name and path: a caller-supplied name is never
// accepted here (the server names a codebase from its path's basename).
// Ownership is explicit and required on every operation, so a foreign owner
// fails closed before any side effect.
function workspaceStatus(code) {
  if (code === 'workspace-not-found' || code === 'task-not-found') return 404;
  if (code === 'workspace-owner-mismatch' || code === 'environment-unauthorized') return 403;
  if (code === 'workspace-name-ambiguous' || code === 'workspace-task-mismatch' || code === 'workspace-environment-mismatch') return 409;
  // A declared adapter this build does not implement is not a bad request: the
  // request was well-formed and the environment is honestly not executable here.
  if (code === 'environment-adapter-missing') return 501;
  // Implemented adapter, but the orchestrator protocol is not deployed inside
  // it (solari environments are execution-worker only in this build).
  if (code === 'solari-orchestrator-not-deployed') return 501;
  return 400;
}

// ------------------------------------------------------------- environments (P3A)
// Read-only projection of the configured execution environments: identity,
// orchestrator, declared provider, adapter implementation status, and the token
// VARIABLE name with a presence boolean. No secret value can appear here
// because no secret value ever enters an environment — a token is a name plus
// whether the process can currently see it.
async function handleEnvironments(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
  const { config } = resolveConfig();
  // P3B: the auth posture rides this authenticated-safe projection (mode,
  // loopback rule, principal COUNTS + presence — never a credential) so a
  // client can learn whether it must present a bearer without a round-trip
  // or a secret ever entering the response.
  return sendJson(res, 200, { ok: true, ...publicEnvironments(config), auth: publicAuth(config) });
}

async function handleWorkspace(req, res, url) {
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8000) return sendJson(res, 413, { ok: false, error: 'body too large' });
    }
    let p;
    try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
    // P3B: the principal establishes the owner, and its environment scope is
    // checked BEFORE the store creates anything — a workspace outside the
    // principal's scope costs zero orchestrator contact.
    const principal = principalOf(req);
    const ownerDecision = ownerForRequest({ principal, owner: p.owner });
    if (!ownerDecision.ok) return sendAuthRefusal(res, ownerDecision);
    const owner = ownerDecision.owner;
    const wantedEnv = typeof p.environmentId === 'string' && p.environmentId !== '' ? p.environmentId : defaultEnvironmentId(resolveConfig().config);
    const envCheck = environmentAllowedForPrincipal({ principal, environmentId: wantedEnv });
    if (!envCheck.ok) return sendAuthRefusal(res, envCheck);
    // P5 guided creation (C1): the path is minted SERVER-SIDE beneath the
    // configured workspaces root — the caller names at most a label. The
    // owner above is already principal-derived; the advanced path-supplied
    // flow below is unchanged.
    if (p.guided === true) {
      if (typeof p.path === 'string' && p.path.trim() !== '') {
        return sendJson(res, 400, { ok: false, code: 'guided-path-conflict', error: 'guided creation generates the path — do not send both guided and path' });
      }
      const { config } = resolveConfig();
      let generated;
      try {
        generated = guidedWorkspacePath({ root: config.workspaces && config.workspaces.root, label: p.label });
      } catch (e) {
        return sendJson(res, 400, { ok: false, code: (e && e.code) || 'workspace-guided-refused', error: String((e && e.message) || e).slice(0, 300) });
      }
      try {
        await mkdir(generated.path, { recursive: true });
      } catch (e) {
        return sendJson(res, 500, { ok: false, code: 'workspace-root-unwritable', error: ('could not create the workspace directory under the configured root: ' + String((e && e.message) || e)).slice(0, 300) });
      }
      try {
        const workspace = await createWorkspace({ path: generated.path, owner, environmentId: p.environmentId });
        return sendJson(res, 200, { ok: true, workspace, guided: { root: config.workspaces.root } });
      } catch (e) {
        const code = (e && e.code) || null;
        return sendJson(res, workspaceStatus(code), { ok: false, error: String((e && e.message) || e).slice(0, 300), code });
      }
    }
    try {
      const workspace = await createWorkspace({ path: p.path, owner, environmentId: p.environmentId });
      return sendJson(res, 200, { ok: true, workspace });
    } catch (e) {
      const code = (e && e.code) || null;
      return sendJson(res, workspaceStatus(code), { ok: false, error: String((e && e.message) || e).slice(0, 300), code });
    }
  }
  if (req.method === 'GET') {
    const id = url.searchParams.get('id');
    // P3B: the query owner is a CLAIM — accepted only when it is one of the
    // principal's own owners (dev mode: principal null, passes through).
    const ownerDecision = ownerForRequest({ principal: principalOf(req), owner: url.searchParams.get('owner') });
    if (!ownerDecision.ok) return sendAuthRefusal(res, ownerDecision);
    const owner = ownerDecision.owner;
    try {
      if (id) {
        const workspace = await resolveWorkspace({ workspaceId: id, owner });
        // P3B: the principal's environment scope answers for the STORED
        // environment, after the store's own owner resolution.
        const envCheck = environmentAllowedForPrincipal({ principal: principalOf(req), environmentId: workspace.environmentId });
        if (!envCheck.ok) return sendAuthRefusal(res, envCheck);
        // The record is the store's truth; the codebase read is Archon's, live.
        // Both are reported so a reader can tell which one answered.
        const live = await readCodebase(workspace.codebaseId, workspace.environmentId);
        return sendJson(res, 200, {
          ok: true,
          workspace,
          codebaseRead: live.state,
          ...(live.reason ? { codebaseReadReason: live.reason } : {}),
          ...(live.codebase ? { codebase: live.codebase } : {}),
        });
      }
      const workspaces = await listWorkspaces({ owner });
      return sendJson(res, 200, { ok: true, workspaces });
    } catch (e) {
      const code = (e && e.code) || null;
      return sendJson(res, workspaceStatus(code), { ok: false, error: String((e && e.message) || e).slice(0, 300), code });
    }
  }
  return sendJson(res, 405, { ok: false, error: 'GET or POST only' });
}

// ------------------------------------------------------------ conversation (P2)
// The supported provisioning path for a task's Archon conversation — the
// product surface that replaces test-only seeding. Provisioning is idempotent
// per task (an association that already carries a conversation id is VERIFIED,
// never re-created) and requires a resolved workspace, because the project
// binding IS the workspace's Archon codebase: a task is never bound to a
// project it does not record. GET is the inspect surface — read-only toward the
// store, with the association verified live against Archon.
async function handleConversation(req, res, url) {
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8000) return sendJson(res, 413, { ok: false, error: 'body too large' });
    }
    let p;
    try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
    const taskId = String(p.taskId || '').slice(0, 120);
    // P3B: the principal establishes the owner before any resolution — a
    // foreign owner field is refused here, never resolved against.
    const principal = principalOf(req);
    const ownerDecision = ownerForRequest({ principal, owner: p.owner });
    if (!ownerDecision.ok) return sendAuthRefusal(res, ownerDecision);
    const owner = ownerDecision.owner;
    try {
      if (p.op === 'provision') {
        const workspace = await resolveWorkspace({ workspaceId: p.workspaceId, owner });
        const task = await getTask(taskId);
        if (!task) return sendJson(res, 404, { ok: false, error: 'no such task: ' + taskId, code: 'task-not-found' });
        // P3B: provisioning is acting on a stored task — authorize against
        // the RECORD's stored owner and the workspace's STORED environment
        // before the binding write and before provisionConversation reaches
        // the orchestrator.
        const anchor = taskAuthorizedForPrincipal({ principal, recordOwner: ownerOfRecord(task), label: 'task ' + taskId });
        if (!anchor.ok) return sendAuthRefusal(res, anchor);
        const envCheck = environmentAllowedForPrincipal({ principal, environmentId: workspace.environmentId });
        if (!envCheck.ok) return sendAuthRefusal(res, envCheck);
        const recorded = task.workspace || null;
        if (recorded && String(recorded.codebaseId) !== String(workspace.codebaseId)) {
          // Rebinding a task to another codebase is never implicit: the
          // conversation would then be bound to a project the task does not
          // record. Refuse — a different workspace means a different task.
          return sendJson(res, 409, {
            ok: false,
            code: 'workspace-task-mismatch',
            error: 'task ' + taskId + ' is recorded against codebase ' + recorded.codebaseId + ', not ' + workspace.codebaseId,
          });
        }
        // The same codebase id reached through a different environment is not
        // the same workspace, and a task is never silently moved between
        // environments: the binding recorded here is what a receipt later names.
        const recordedEnv = recorded ? (recorded.environmentId || null) : null;
        if (recordedEnv && recordedEnv !== workspace.environmentId) {
          return sendJson(res, 409, {
            ok: false,
            code: 'workspace-environment-mismatch',
            error: 'task ' + taskId + ' is bound to environment ' + recordedEnv + ', not ' + workspace.environmentId,
          });
        }
        if (!recorded) {
          // The binding is recorded BEFORE the conversation exists, so the
          // association is never implied by the call that created it.
          await upsertTask({
            ...task,
            workspace: {
              workspaceId: workspace.workspaceId,
              name: workspace.name,
              path: workspace.path,
              codebaseId: workspace.codebaseId,
              kind: workspace.kind,
              owner: workspace.owner,
              environmentId: workspace.environmentId,
            },
          });
        }
        const association = await provisionConversation({
          taskId,
          projectName: workspace.name,
          expectedCodebaseId: workspace.codebaseId,
          // The workspace path the dispatched run must report as working_path —
          // carried on the association, the same place expectedCodebaseId lives.
          expectedWorkspacePath: workspace.path,
          // The environment the workspace was just resolved and authorized in —
          // the conversation is created in the same orchestrator the task is
          // bound to, never in whichever one happens to be configured globally.
          transport: transportForWorkspace({ workspace }),
        });
        return sendJson(res, 200, { ok: true, association, workspace });
      }
      if (p.op === 'verify') {
        // P3B: even a read-back verifies against the record's stored owner.
        const check = await authorizeTaskRecord(req, taskId);
        if (!check.ok) return sendAuthRefusal(res, check);
        const association = await verifyConversationAssociation({ taskId });
        return sendJson(res, 200, { ok: true, association });
      }
      return sendJson(res, 400, { ok: false, error: 'op must be provision or verify' });
    } catch (e) {
      const code = (e && e.code) || null;
      const status = code === 'conversation-provision-rejected' ? 409 : workspaceStatus(code);
      return sendJson(res, status, { ok: false, error: String((e && e.message) || e).slice(0, 300), code });
    }
  }
  if (req.method === 'GET') {
    const taskId = String(url.searchParams.get('taskId') || '').slice(0, 120);
    if (!taskId) return sendJson(res, 400, { ok: false, error: 'taskId required' });
    const task = await getTask(taskId);
    if (!task) return sendJson(res, 404, { ok: false, error: 'no such task: ' + taskId });
    // P3B: inspecting a task's association authorizes against the record's
    // stored owner — no principal reads another owner's task.
    const anchor = taskAuthorizedForPrincipal({ principal: principalOf(req), recordOwner: ownerOfRecord(task), label: 'task ' + taskId });
    if (!anchor.ok) return sendAuthRefusal(res, anchor);
    const stored = task.conversation || null;
    try {
      const association = await verifyConversationAssociation({ taskId, transport: transportForWorkspace({ workspace: task.workspace }) });
      return sendJson(res, 200, { ok: true, taskId, workspace: task.workspace || null, association, dispatchable: true });
    } catch (e) {
      // The refusal is the answer, not an error: a task with no verified
      // association is exactly what an operator needs to see here.
      return sendJson(res, 200, {
        ok: true,
        taskId,
        workspace: task.workspace || null,
        association: stored,
        dispatchable: false,
        code: (e && e.code) || null,
        reason: String((e && e.message) || e).slice(0, 300),
      });
    }
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
        // P3B: promotion acts on a stored record — authorize against ITS
        // stored owner first (a teaching record carries no owner: required
        // mode fails closed UNATTRIBUTED; dev passes through).
        const check = await authorizeTaskRecord(req, String(p.promoteTaskId).slice(0, 120));
        if (!check.ok) return sendAuthRefusal(res, check);
        const out = await promoteCandidate({ teachingTaskId: p.promoteTaskId });
        // The status comes from the code, not from `ok`. promoteCandidate emits
        // a code on every refusal (lib/teach.js): a registry READ failure is
        // `registry-unreadable` / `registry-malformed` (500 — a local read
        // failed), unknown authority is `authority-scopes-unknown` (403), an
        // unconfigured registry path is `registry-not-configured` (400), and the
        // deterministic state conflicts (not-a-CANDIDATE, already-in-registry)
        // are `capability-not-promoted`, which keeps the do-not-retry 409 they
        // legitimately deserve. This comment previously asserted that contract
        // while promoteCandidate returned NO code at all, so `out.code` was
        // undefined at every refusal, the mapping matched nothing, and all of
        // them left as 409 — the registry read failure included. The comment
        // described the intent; the producer did not fulfil it.
        return out.ok ? sendJson(res, 200, out) : sendJson(res, flowrouterRefusalStatus(out.code), out);
      }
      if (p.sourceTaskId) {
        const check = await authorizeTaskRecord(req, String(p.sourceTaskId).slice(0, 120));
        if (!check.ok) return sendAuthRefusal(res, check);
        const out = await acquireCapability({ sourceTaskId: String(p.sourceTaskId).slice(0, 120) });
        return out.ok ? sendJson(res, 200, out) : sendJson(res, 400, out);
      }
      return sendJson(res, 400, { ok: false, error: 'sourceTaskId or promoteTaskId required' });
    } catch (e) {
      // The code is preserved AND mapped: an Archon outage out of getTask
      // reaches here as `archon-unavailable`, and a bare 500 with no code left
      // it anonymous — indistinguishable from a bug in this route.
      const code = (e && e.code) || null;
      return sendJson(res, flowrouterRefusalStatus(code, 500), { ok: false, error: String((e && e.message) || e).slice(0, 200), ...(code ? { code } : {}) });
    }
  }
  if (req.method === 'GET') {
    // P3B: teaching records carry no owner, so required mode fail-closes the
    // list to records this principal could act on; dev sees the untouched list.
    const principal = principalOf(req);
    const t = await listTeaching();
    const teaching = principal
      ? t.filter((record) => taskAuthorizedForPrincipal({ principal, recordOwner: ownerOfRecord(record) }).ok)
      : t;
    return sendJson(res, 200, { ok: true, teaching });
  }
  return sendJson(res, 405, { ok: false, error: 'GET or POST only' });
}

// FlowRouter portability P0 (export / stage / verify / admit) — local
// transport only, no networking.

// ONE mapping from a refusal code to the transport status, so the status
// follows the OPERATOR ACTION and never claims a verdict the data does not
// support. 409 means "do not retry", which is the right answer for a
// DETERMINISTIC refusal — and the wrong answer for an outage, so no code that
// means "an external read failed" may map to 409. The previous
// `out.ok ? 200 : 409` ternary sent every refusal as 409, including the
// executor-unreachable outage, and none of these refusals even carried a code.
//
// The line is drawn by WHO failed:
//   502 = a REMOTE upstream did not answer (Archon, the local executor) — an
//         outage, so the operator must be able to retry;
//   500 = a LOCAL read failed, or local state is inconsistent — inspect and
//         repair, then retry;
//   400 = the operator must change an input; 403 = well-formed, not allowed.
// 502-vs-500 is a property of the CODE, never of the path it arrived by: the
// same Archon outage is 502 whether it is returned as `archon-unavailable`
// (out of getTask) or as `EXECUTOR_UNREACHABLE` (out of verifyImport).
//
// The code is NORMALISED before lookup because this codebase names the same
// condition in two conventions — UPPER_SNAKE in the flowrouter family,
// lower-hyphen in the teach/tasks family. One condition gets ONE status
// regardless of which module named it.
//
// `fallback` is the status for a code this mapping does not know, and the two
// callers need different answers. A RETURNED refusal falls through to 409: it
// is a considered "do not retry". A THROWN error passes 500, because an
// unexpected throw is not a considered refusal and must never inherit the one
// status an outage may not receive.
//
// `DELIBERATE_409_CODES` is the decision record for that fallthrough, and it is
// exported so a guard test can assert that every code the producers can emit is
// either mapped above or listed here — an unenumerated code silently becoming
// "do not retry" is the dangerous default this guards against.
export const DELIBERATE_409_CODES = new Set([
  'CAPABILITY_NOT_FOUND',      // the id is not in a registry we READ
  'CAPABILITY_NOT_PROMOTED',   // a state conflict, not a read failure
  'LOCAL_ID_COLLISION',        // a state conflict, not a read failure
  'SCHEMA_INVALID',            // a verdict about a package we read
  'INTEGRITY_FAIL',            // ditto (digest mismatch)
  'COMPATIBILITY_FAIL',        // ditto (local requirements)
  'LOCAL_VERIFICATION_ABSENT',    // the executor ANSWERED and named no run
  'LOCAL_VERIFICATION_MALFORMED', // a record came back and is unusable
  'LOCAL_VERIFICATION_FAILED',    // a verdict about the imported artifact
  'UNAUTHENTICATED',              // fail-closed provenance verdicts: retrying
  'PUBLISHER_AUTH_INVALID',       // the identical package reproduces them
  'SIGNED_STATEMENT_MISMATCH',
  'SEQUENCE_ROLLBACK',
  'IDENTITY_HISTORY_FORK',
  'KEY_NOT_AUTHORIZED',
  'PUBLISHER_EQUIVOCATION_UNACKNOWLEDGED',
  // teach's promotion gate re-derives the verdict from the evidence the
  // envelope carries (D3.B). All three are verdicts about a record we READ:
  // the record contradicts itself, so retrying changes nothing — the operator
  // must repair the store or re-run the acquisition. Deliberately NOT 500:
  // nothing is unreadable, and 500 would claim the machine is unwell.
  'EVIDENCE_ABSENT',               // CANDIDATE with no evaluations behind it
  'EVIDENCE_CONTRADICTS_VERDICT',  // CANDIDATE whose own evaluations did not pass
  'CANDIDATE_BYTES_ALTERED',       // the candidate bytes do not hash to the declared digest
]);

export function flowrouterRefusalStatus(code, fallback = 409) {
  const k = String(code || '').toUpperCase().replace(/-/g, '_');
  // An upstream that did not answer, or answered unhealthily: retryable. Same
  // status the marketplace route already uses for an Archon that failed.
  // ARCHON_UNAVAILABLE is getTask's throw (lib/tasks.js) — a remote read that
  // did not complete, so it belongs here and not in the 500 group.
  // LOCAL_VERIFICATION_UNAVAILABLE is the local executor never answering during
  // verification: also an outage. (Today it rides inside a REFUSED envelope, so
  // it does not reach this mapping — classified here so that the day it does,
  // an outage cannot inherit 409.)
  if (k === 'EXECUTOR_UNREACHABLE' || k === 'EXECUTOR_UNHEALTHY' || k === 'ARCHON_UNAVAILABLE'
    || k === 'LOCAL_VERIFICATION_UNAVAILABLE') return 502;
  // A read of local durable state failed (or local state is inconsistent):
  // the machine is unwell — inspect and repair, then retry. Never 409. The
  // registry/workflow/fixture/package codes arrive in BOTH conventions and
  // normalise to one: e.g. teach's `registry-unreadable` and the flowrouter
  // family's REGISTRY_UNREADABLE are the same condition and the same remedy.
  if (k === 'REGISTRY_UNREADABLE' || k === 'REGISTRY_MISSING' || k === 'REGISTRY_MALFORMED'
    || k === 'WORKFLOW_BYTES_MISSING' || k === 'WORKFLOW_BYTES_UNREADABLE'
    || k === 'PACKAGE_BYTES_MISSING' || k === 'PACKAGE_BYTES_UNREADABLE'
    || k === 'PACKAGE_MANIFEST_UNREADABLE' || k === 'INTEGRITY_ENTRYPOINT_UNREADABLE'
    || k === 'FIXTURE_UNREADABLE') return 500;
  // Configuration or request validation: the operator must change an input.
  // The two `_MISSING` package codes sit here and not in the 500 group on
  // purpose: at STAGE time the package dir is a request input the operator
  // named, so a manifest that is not there means "supply a package that has
  // one" and an entrypoint that is not there means "supply the file you
  // declared", not "repair the machine". The 500 group's PACKAGE_BYTES_* are
  // the other side of that line — by VERIFY time the staged package is local
  // durable state, so its absence is an inconsistency to repair. Same family,
  // different question, different operator action; the split is the point.
  // INTEGRITY_FAIL is deliberately NOT in either list: a digest mismatch on
  // bytes we DID read is a verdict, and stays a deliberate 409.
  if (k === 'EXPORT_NOT_CONFIGURED' || k === 'REGISTRY_NOT_CONFIGURED' || k === 'TEACHING_NOT_CONFIGURED'
    || k === 'IMPORT_NOT_STAGED' || k === 'IMPORT_NOT_VERIFIED' || k === 'FIXTURE_INCOMPLETE'
    || k === 'PACKAGE_MANIFEST_MISSING' || k === 'INTEGRITY_ENTRYPOINT_MISSING') return 400;
  // Authority or permission: well-formed, not allowed.
  if (k === 'AUTHORITY_SCOPES_UNKNOWN' || k === 'AUTHORITY_SCOPES_UNDECLARED'
    || k === 'EXPORT_LEAK_FORBIDDEN') return 403;
  // Everything else is a deterministic refusal about data that WAS read.
  return fallback;
}

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
    if (!out.ok) return sendJson(res, flowrouterRefusalStatus(out.code), out);
    return sendJson(res, 200, out);
  } catch (e) {
    // A coded throw keeps its code, exactly as the goal route does at :272: a
    // refusal that leaves without its identity is the defect, because the
    // caller cannot tell it apart from any other refusal. The STATUS comes from
    // the mapping with a 500 default rather than a hardcoded 500, because a
    // throw is not a considered refusal but a recognised upstream outage still
    // is one: getTask throws `archon-unavailable` at lib/flowrouter.js:481 and
    // :683, and that must leave as 502 — the same status the executor outage
    // gets when verifyImport RETURNS it — not 500. An unrecognised throw keeps
    // 500 and never inherits the 409 fallthrough.
    const code = (e && e.code) || null;
    return sendJson(res, flowrouterRefusalStatus(code, 500), { ok: false, error: String((e && e.message) || e).slice(0, 200), ...(code ? { code } : {}) });
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
    // Same treatment as the F1 catch: map the code rather than hardcode 409,
    // so an unreachable upstream is retryable and only a genuine deterministic
    // refusal keeps the do-not-retry default.
    const code = (e && e.code) || null;
    return sendJson(res, flowrouterRefusalStatus(code), { ok: false, error: code || String(e.message), reason: String(e.message).slice(0, 200), ...(code ? { code } : {}) });
  }
}

// P4 marketplace: Discover → Inspect → Import through Archon's OWN marketplace
// surface (feature-detected on openapi.json — never a second catalog, never an
// invented endpoint). GET ops are reads; the only state-changing op is POST
// ?op=import, whose engine runs the full ladder (auth before ANY orchestrator
// contact; security and static gates before ANY local write) and whose only
// writes are the YAML file + ledger row — never the capability registry.

// ONE mapping from a feature-detection outcome to the transport refusal, shared
// by search and inspect so the two can never disagree about reality. An
// UNREADABLE read is an OUTAGE, not a durable claim about the installation:
// collapsing these into 'marketplace-unsupported' told the operator that the
// installation does not advertise a marketplace when Archon was merely down.
// NOT_ADVERTISED (Archon ANSWERED and advertises no namespace) is the only
// outcome that earns 'marketplace-unsupported'.
function marketplaceSupportRefusal(support) {
  if (support.outcome === 'UNAVAILABLE') return { status: 502, code: 'marketplace-unreachable', error: support.hint };
  if (support.outcome === 'INVALID') return { status: 502, code: support.reason, error: support.hint };
  if (support.outcome === 'NOT_CONFIGURED') return { status: 400, code: support.reason, error: support.hint };
  return { status: 409, code: 'marketplace-unsupported', error: support.hint };
}

async function handleMarketplace(req, res, url) {
  const { config } = resolveConfig();
  const principal = principalOf(req);
  const op = url.searchParams.get('op') || (req.method === 'GET' ? 'status' : null);
  if (op === 'status') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    return sendJson(res, 200, await marketplaceStatus(config.archon));
  }
  if (op === 'search') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    const support = await marketplaceStatus(config.archon);
    if (!support.supported) {
      const r = marketplaceSupportRefusal(support);
      return sendJson(res, r.status, { ok: false, code: r.code, error: r.error });
    }
    const q = url.searchParams.get('q') || '';
    const found = await searchMarketplace(config.archon, q);
    const entries = scopeEntriesForPrincipal(found, principal);
    return sendJson(res, 200, { ok: true, entries });
  }
  if (op === 'inspect') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    const entryId = url.searchParams.get('entry_id');
    if (!entryId) return sendJson(res, 400, { ok: false, error: 'entry_id required', code: 'entry-id-required' });
    const support = await marketplaceStatus(config.archon);
    if (!support.supported) {
      const r = marketplaceSupportRefusal(support);
      return sendJson(res, r.status, { ok: false, code: r.code, error: r.error });
    }
    const { entry, notFound } = await fetchMarketplaceEntry(config.archon, entryId);
    if (notFound || !entry) return sendJson(res, 404, { ok: false, code: 'marketplace-entry-not-found', error: 'no such marketplace entry: ' + entryId });
    if (!entryVisibleToPrincipal(entry, principal)) {
      return sendJson(res, 403, { ok: false, code: 'marketplace-entry-forbidden', error: 'marketplace entry "' + entryId + '" is private and this principal does not hold its owner' });
    }
    return sendJson(res, 200, { ok: true, entry });
  }
  if (op === 'installations') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    const out = await listInstallations({ principal, owner: url.searchParams.get('owner') });
    if (!out.ok) return sendAuthRefusal(res, out);
    return sendJson(res, 200, out);
  }
  if (op === 'import') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8000) return sendJson(res, 413, { ok: false, error: 'body too large' });
    }
    let p;
    try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
    const out = await importMarketplaceWorkflow({
      entryId: p.entry_id,
      revision: p.revision,
      workspaceId: p.workspace_id,
      owner: p.owner,
      approval: p.approval,
      principal,
    });
    if (!out.ok) return sendJson(res, out.status, { ok: false, code: out.code, error: out.error, ...(out.counts ? { counts: out.counts } : {}) });
    return sendJson(res, 200, out);
  }
  return sendJson(res, 400, { ok: false, error: 'op must be status|search|inspect|installations|import' });
}

// ------------------------------------------------------------- solari (P6A)

// HTTP status for a typed Solari outcome. Request-shaped refusals are 400;
// over-cap budget is 403 (well-formed but not allowed); plan and concurrency
// are provider economics (402/429); token configuration is 409 (fix the
// environment config, then retry); SDK absence and a not-deployed orchestrator
// are honest 501s; anything the live provider itself rejected is 502 — an
// upstream failure, never a client error.
function solariStatusFor(code) {
  if (code === 'solari-argv-invalid' || code === 'solari-env-values-forbidden' || code === 'solari-env-names-invalid'
    || code === 'solari-capability-unsupported' || code === 'solari-budget-invalid' || code === 'solari-reason-required'
    || code === 'solari-artifacts-invalid' || code === 'solari-adapter-mismatch' || code === 'solari-op-unsupported') return 400;
  if (code === 'solari-env-privileged' || code === 'solari-budget-over-cap') return 403;
  // P6D: a posture that would run a posture-gated workload as root is 403 —
  // well-formed request, not allowed; the root fallback is never taken.
  if (code === 'solari-non-root-required') return 403;
  if (code === 'solari-env-not-allowed') return 400;
  if (code === 'solari-plan-gated') return 402;
  if (code === 'solari-concurrency-limit') return 429;
  if (code === 'solari-token-missing' || code === 'solari-token-var-invalid' || code === 'solari-sandbox-unknown') return 409;
  if (code === 'solari-sdk-missing' || code === 'solari-sdk-shape' || code === 'solari-orchestrator-not-deployed') return 501;
  return 502;
}

// P6A execution-worker route for solari-sandbox environments. status is a
// readiness read; run/kill are the only state-changing ops and each carries
// owner authorization BEFORE any provider contact. This route hosts no
// orchestrator: dispatch through a solari environment is refused at the
// protocol seam (requireOrchestratorProtocol), and responses project the same
// scrubbed evidence shape lib/solari.js produces — token values never cross it.
async function handleSolari(req, res, url) {
  // home rides along for the P6D bridge receipt store ($DSH_HOME/bridge-receipts).
  const { config, home } = resolveConfig();
  const op = url.searchParams.get('op') || (req.method === 'GET' ? 'status' : null);

  const principal = principalOf(req);
  // The solari route serves ONLY solari-sandbox adapters — every other kind
  // has its own surface (orchestrator protocol transport, local runs). The
  // owner is principal-derived and scoped BEFORE any provider contact.
  const resolveEnv = (requested, ownerRaw) => {
    const environmentId = typeof requested === 'string' && requested !== '' ? requested : url.searchParams.get('environment_id');
    if (!environmentId) return { error: sendJson(res, 400, { ok: false, code: 'environment-id-required', error: 'environment_id required' }) };
    const envCheck = environmentAllowedForPrincipal({ principal, environmentId });
    if (!envCheck.ok) return { error: sendAuthRefusal(res, envCheck) };
    const ownerDecision = ownerForRequest({ principal, owner: ownerRaw });
    if (!ownerDecision.ok) return { error: sendAuthRefusal(res, ownerDecision) };
    try {
      const environment = requireEnvironmentForOwner({ environmentId, owner: ownerDecision.owner, config });
      requireEnvironmentAdapter(environment);
      const kind = environment.adapter && environment.adapter.kind;
      if (kind !== 'solari-sandbox') {
        throw Object.assign(new Error('environment "' + environmentId + '" is not a solari-sandbox adapter (kind: ' + String(kind) + ')'), { code: 'solari-adapter-mismatch' });
      }
      return { environment };
    } catch (e) {
      const code = (e && e.code) || null;
      const status = typeof code === 'string' && code.startsWith('solari-') ? solariStatusFor(code)
        : typeof code === 'string' && code.startsWith('environment-') ? workspaceStatus(code) : 500;
      return { error: sendJson(res, status, { ok: false, code: code || 'environment-error', error: String((e && e.message) || e).slice(0, 200) }) };
    }
  };

  if (op === 'status') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    const r = resolveEnv(null, url.searchParams.get('owner'));
    if (r.error) return r.error;
    return sendJson(res, 200, { ok: true, environmentId: r.environment.environmentId, readiness: await solariReadiness(r.environment, config) });
  }

  if (op === 'run' || op === 'kill') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64000) return sendJson(res, 413, { ok: false, error: 'body too large' });
    }
    let p;
    try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
    const r = resolveEnv(p.environment_id || p.environmentId, p.owner);
    if (r.error) return r.error;
    const outcome = op === 'run'
      ? await executeScoped({ environment: r.environment, config, reason: p.reason, command: p.command, argv: p.argv, cwd: p.cwd, env: p.env, envNames: p.env_names || p.envNames, artifactPaths: p.artifact_paths || p.artifactPaths, budget: p.budget, expect: p.expect })
      : await killScoped({ environment: r.environment, sandboxId: p.sandbox_id || p.sandboxId });
    if (outcome.ok) {
      const body = {
        ok: true,
        environmentId: r.environment.environmentId,
        reason: outcome.reason,
        run: outcome.run,
        identity: outcome.identity,
        cleanup: outcome.cleanup,
        verification: outcome.verification,
        budget: outcome.budget,
        artifacts: outcome.artifacts,
        posture: outcome.posture || null,
      };
      // P6D: a run that executed gets its execution-leg receipt persisted
      // BEFORE the 200 goes out. If the receipt cannot be written, no id is
      // ever handed back — a bridge goal then fails closed on a missing id
      // rather than trusting an execution nobody can re-derive. A kill (no
      // execution) writes no receipt.
      if (op === 'run') {
        try {
          const record = await writeBridgeReceipt({
            home,
            environmentId: r.environment.environmentId,
            environment: r.environment,
            reason: p.reason,
            outcome,
          });
          body.bridge = { id: record.id, receiptSha256: record.receiptSha256, createdAt: record.createdAt };
        } catch (e) {
          return sendJson(res, 500, {
            ok: false,
            code: (e && e.code) || 'bridge-receipt-write-failed',
            error: String((e && e.message) || e).slice(0, 300),
          });
        }
      }
      return sendJson(res, 200, body);
    }
    return sendJson(res, solariStatusFor(outcome.code), {
      ok: false,
      code: outcome.code,
      error: String(outcome.reason || outcome.code).slice(0, 300),
      details: outcome.details || null,
    });
  }

  return sendJson(res, 400, { ok: false, code: 'solari-op-unsupported', error: 'op must be status|run|kill' });
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
    // The F1 producers THROW rather than return: verifyProofCore's
    // EQUIVOCATION_PROOF_INVALID (a validation refusal) and
    // proofFromLocalHistory's getTask read, which throws `archon-unavailable`
    // when the pin cannot be read. Hardcoding 409 told the operator "do not
    // retry" for an outage. The code is mapped instead; the 409 default is kept
    // for a throw that carries no read-failure code, so a validation refusal is
    // unchanged — and the code now rides the body as well as the message.
    const code = (e && e.code) || null;
    return sendJson(res, flowrouterRefusalStatus(code), { ok: false, error: code || String(e.message), reason: String(e.message).slice(0, 200), ...(code ? { code } : {}) });
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
        // P3B: promotion acts on a stored record — authorize against ITS
        // stored owner first (teaching records carry no owner: required mode
        // fails closed UNATTRIBUTED; dev passes through).
        const check = await authorizeTaskRecord(req, String(p.promoteTaskId).slice(0, 120));
        if (!check.ok) return sendAuthRefusal(res, check);
        const out = await promoteCandidate({ teachingTaskId: p.promoteTaskId });
        // Same mapping as the acquire route's promote branch: one code, one
        // status, regardless of which route asked. A registry READ failure is
        // 500; the deterministic refusals keep 409.
        return out.ok ? sendJson(res, 200, out) : sendJson(res, flowrouterRefusalStatus(out.code), out);
      }
      if (p.sourceTaskId) {
        const check = await authorizeTaskRecord(req, String(p.sourceTaskId).slice(0, 120));
        if (!check.ok) return sendAuthRefusal(res, check);
        const teaching = await teachRCOS({ sourceTaskId: p.sourceTaskId });
        return sendJson(res, 200, { ok: true, teaching });
      }
      return sendJson(res, 400, { ok: false, error: 'sourceTaskId or promoteTaskId required' });
    } catch (e) {
      // Same as the acquire route's catch: keep the code, and map it, so an
      // outage is not delivered anonymously as a bare 500.
      const code = (e && e.code) || null;
      return sendJson(res, flowrouterRefusalStatus(code, 500), { ok: false, error: String((e && e.message) || e).slice(0, 200), ...(code ? { code } : {}) });
    }
  }
  if (req.method === 'GET') {
    const principal = principalOf(req);
    const id = url.searchParams.get('id');
    if (id) {
      const t = await listTeaching();
      const hit = t.find((x) => x.taskId === id);
      if (!hit) return sendJson(res, 404, { ok: false, error: 'no such teaching task' });
      // P3B: a teaching record carries no owner — required mode fail-closes
      // this read too (dev: principal null, check no-ops).
      const check = taskAuthorizedForPrincipal({ principal, recordOwner: ownerOfRecord(hit), label: 'task ' + id });
      if (!check.ok) return sendAuthRefusal(res, check);
      return sendJson(res, 200, { ok: true, teaching: hit });
    }
    const all = await listTeaching();
    const teaching = principal
      ? all.filter((record) => taskAuthorizedForPrincipal({ principal, recordOwner: ownerOfRecord(record) }).ok)
      : all;
    return sendJson(res, 200, { ok: true, teaching });
  }
  return sendJson(res, 405, { ok: false, error: 'GET or POST only' });
}

// P6E execution admission — POST-only, P3B owner-bound: authorizeTaskRecord
// runs BEFORE any store read or write, so a refusal reaches zero
// orchestrator contact and zero registry bytes. Everything the entry carries
// is derived inside admitExecution from the stored envelope; the body only
// carries goalTaskId, requires, description, tags.

// ONE mapping from an admission refusal code to the transport status, so the
// status follows the OPERATOR ACTION rather than the `ok` flag. The previous
// `out.ok ? 200 : 409` ternary delivered a STORE READ failure as 409 Conflict —
// byte-identical to a genuine business refusal — and 409 tells the operator
// "do not retry" for the one condition whose remedy is "the machine is unwell;
// inspect, then retry".
//
// The line is drawn at the READ: a refusal whose meaning is "a read of local
// durable state failed" is a 500 (the same status the marketplace ledger
// already uses for ledger-unreadable / ledger-corrupt in lib/marketplace.js);
// every other code is a verdict about data that WAS read — a state, authority,
// or request conflict — and keeps 409. `admission-registry-unreadable`,
// `admission-registry-malformed` and `admission-workflow-unreadable` carry
// codes of their own (lib/admission.js) precisely so they cannot fall through
// to the 409 default as they used to.
//
// `admission-goal-not-found` deliberately stays 409, not 404: the two encode
// the same retryability (the id does not exist, so the identical request cannot
// succeed) and no client branches on the difference. A status must change a
// client behaviour to be worth splitting. If a client is ever added that
// retries on 409 but not 404, this is the line to revisit.
const ADMISSION_READ_FAILURE_CODES = new Set([
  'admission-store-unreadable',
  'admission-registry-unreadable',
  'admission-registry-malformed',
  'admission-workflow-unreadable',
]);

function admissionRefusalStatus(code) {
  return ADMISSION_READ_FAILURE_CODES.has(code) ? 500 : 409;
}

async function handleAdmission(req, res, url) {
  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 2000) return sendJson(res, 413, { ok: false, error: 'body too large' });
    }
    let p = null;
    try {
      p = JSON.parse(body || '{}');
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad json' });
    }
    const goalTaskId = String((p && p.goalTaskId) || '').slice(0, 120);
    if (!goalTaskId) return sendJson(res, 400, { ok: false, error: 'goalTaskId required' });
    try {
      const check = await authorizeTaskRecord(req, goalTaskId);
      if (!check.ok) return sendAuthRefusal(res, check);
      const out = await admitExecution({ goalTaskId, requires: p.requires, description: p.description, tags: p.tags });
      return out.ok ? sendJson(res, 200, out) : sendJson(res, admissionRefusalStatus(out.code), out);
    } catch (e) {
      // The refusal path above maps its codes; the THROW path must too, or an
      // Archon outage escaping admitExecution would leave anonymously as 500.
      const code = (e && e.code) || null;
      return sendJson(res, flowrouterRefusalStatus(code, 500), { ok: false, error: String((e && e.message) || e).slice(0, 200), ...(code ? { code } : {}) });
    }
  }
  return sendJson(res, 405, { ok: false, error: 'POST only' });
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
  // Cordis owns listener disposal. A capability check preserves degraded hosts
  // and the lightweight route harnesses; real DSH always supplies ctx.on.
  if (typeof ctx.on === 'function') ctx.on('tools/post-execute', wmReceiptBridge);
  // ------------------------------------------------------------ compatibility banner
  // Printed once, at load, and only when this install is off the tested pin.
  // It names both the detected value and the COMPAT.md pin so the operator
  // never has to go digging for which side moved. Non-blocking by design —
  // see lib/compat.js for why refusing here would be a false alarm.
  try {
    const verdicts = [];
    if (HOST_COMPAT) {
      const dshVerdict = judgeDsh(HOST_COMPAT.version);
      if (!dshVerdict.ok) verdicts.push(dshVerdict);
    }
    if (TOOLS_COMPAT && !TOOLS_COMPAT.ok) verdicts.push(TOOLS_COMPAT);
    const box = bannerBox(verdicts);
    if (box) {
      ctx.effect(() => { try { console.warn(box); } catch {} });
    }
  } catch { /* the banner is never load-bearing */ }

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
    handler: async (req, res, ...rest) => {
      // P3B: authentication at the plugin-handler boundary — BEFORE URL
      // parsing and before ANY workspace/task/conversation/execution handler
      // runs. In required mode a missing/malformed/invalid/revoked credential
      // is refused right here: zero store writes, zero orchestrator contact.
      // The decision rides req.auth for every per-handler owner/environment/
      // record check; dev mode attaches a principal-less decision and those
      // checks short-circuit to the pre-P3B path unchanged.
      const { config } = resolveConfig();
      const decision = authenticateRequest(req, config);
      if (!decision.ok) {
        return sendJson(res, decision.status, { ok: false, error: decision.error, code: decision.code });
      }
      req.auth = decision;
      try {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === GIT_ROUTE + '/git') {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
          return await handleGit(req, res, url, ...rest);
        }
        if (url.pathname === GIT_ROUTE + '/files') {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
          return await handleFiles(req, res, url, ...rest);
        }
        if (url.pathname === GIT_ROUTE + '/archon') {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
          return await handleArchon(req, res, url, ...rest);
        }
        if (url.pathname === GIT_ROUTE + '/rcos') {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
          return await handleRcos(req, res, url, ...rest);
        }
        if (url.pathname === GIT_ROUTE + '/verify') {
          return await handleVerify(req, res, url, ...rest);
        }
        if (url.pathname === GIT_ROUTE + '/goal') {
          return await handleGoal(req, res, url, ...rest);
        }
        if (url.pathname === GIT_ROUTE + '/workspace') {
          return await handleWorkspace(req, res, url, ...rest);
        }
        if (url.pathname === GIT_ROUTE + '/environments') {
          return await handleEnvironments(req, res, url, ...rest);
        }
        if (url.pathname === GIT_ROUTE + '/conversation') {
          return await handleConversation(req, res, url, ...rest);
        }
        if (url.pathname === GIT_ROUTE + '/teach') {
          return await handleTeach(req, res, url, ...rest);
        }
        if (url.pathname === GIT_ROUTE + '/admission') {
          return await handleAdmission(req, res, url, ...rest);
        }
        if (url.pathname === GIT_ROUTE + '/acquire') {
          return await handleAcquire(req, res, url, ...rest);
        }
        if (url.pathname === GIT_ROUTE + '/flowrouter') {
          return await handleFlowrouter(req, res, url, ...rest);
        }
        if (url.pathname === GIT_ROUTE + '/federation') {
          return await handleFederation(req, res, url, ...rest);
        }
        if (url.pathname === GIT_ROUTE + '/f1') {
          return await handleF1(req, res, url, ...rest);
        }
        if (url.pathname === GIT_ROUTE + '/marketplace') {
          return await handleMarketplace(req, res, url, ...rest);
        }
        if (url.pathname === GIT_ROUTE + '/solari') {
          return await handleSolari(req, res, url, ...rest);
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
      // P3B: the SSE stream is an exact route that bypasses the prefix
      // chokepoint — authenticate BEFORE the 200 stream is established,
      // because a live stream is already contact with the surface.
      const { config } = resolveConfig();
      const decision = authenticateRequest(req, config);
      if (!decision.ok) return sendJson(res, decision.status, { ok: false, error: decision.error, code: decision.code });
      req.auth = decision;
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
      // P3B: exact route — same boundary gate as the prefix chokepoint,
      // before any handler work runs.
      const { config } = resolveConfig();
      const decision = authenticateRequest(req, config);
      if (!decision.ok) return sendJson(res, decision.status, { ok: false, error: decision.error, code: decision.code });
      req.auth = decision;
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
  // writes the sealed receipt to $DSH_HOME/operator-ui/receipt.json. GET reads
  // it back with a fresh seal check and fingerprint staleness diff: VALID /
  // STALE / TAMPERED / NONE. Concurrent POSTs serialize; a read never writes.
  // The receipt is the only file THIS ROUTE writes; the plugin overall also
  // persists the capability registry (lib/teach.js), tasks.json (lib/tasks.js),
  // and a browser profile directory.
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
      // P3B: exact route — same boundary gate as the prefix chokepoint,
      // BEFORE buildStatus's probe work runs.
      const { config } = resolveConfig();
      const decision = authenticateRequest(req, config);
      if (!decision.ok) return sendJson(res, decision.status, { ok: false, error: decision.error, code: decision.code });
      req.auth = decision;
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
      // P3B: browser ops are EXECUTION actions on an exact route that bypasses
      // the prefix chokepoint — same boundary gate, same refusal shape,
      // enforced BEFORE the body is read.
      const { config } = resolveConfig();
      const decision = authenticateRequest(req, config);
      if (!decision.ok) return sendJson(res, decision.status, { ok: false, error: decision.error, code: decision.code });
      req.auth = decision;
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
