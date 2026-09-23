// dsh-operator-ui — explicit Archon conversation association (S2-R).
//
// A task's Archon conversation is a DISTINCT identity from the RCOS objective
// (task id) and from any execution (run id). This module makes the association
// explicit, durable, and inspectable: the envelope carries a `conversation`
// block whose `archonConversationId` is the id Archon itself returned from its
// supported creation API — never a value derived from the task id.
//
// Rules (GPT S2-R work order, 2026-09-20):
// - intent-evidence-before-call: provisioning intent persists BEFORE the
//   creation POST, so a crash between create and persist surfaces as
//   conversation-provision-unresolved (a recoverable orphan that gets
//   reported) instead of a blind second creation.
// - one creation POST per association. Every later call verifies the existing
//   association and, if a previous run died mid-sequence, idempotently
//   completes bind/verify — it never re-creates.
// - project binding is established at CREATION time (the create body carries
//   codebaseId, so the row is bound at birth) and is VERIFIED by reading the
//   conversation back. `/setproject` remains only as a legacy fallback for an
//   unbound conversation with no expected codebase id — Archon v0.4.1 has no
//   /setproject handler (live-confirmed 2026-09-23: the message is accepted
//   with HTTP 200 but codebase_id stays null), so an accepted reply is never
//   proof of binding.
// - fail closed: dispatch reads this association via
//   requireDispatchableConversation. An unknown or derived conversation id can
//   never reach a dispatch, and the run's workflow must match independently
//   (enforced by the caller's run discovery).
//
// P3A (environment model): every conversation call talks to the orchestrator of
// the ENVIRONMENT THE TASK IS BOUND TO, through an explicit transport — never
// through a module-global "current environment". A transport carries the base
// URL, the timeout, and a headers() that reads the named token at request time.
// The parameter is optional everywhere and defaults to the Local transport, so
// every pre-P3A call site keeps its historical behavior byte for byte.

import { resolveConfig } from './config.js';
import { getTask, upsertTask } from './tasks.js';
import { environmentTransport, localTransport, requireEnvironmentAdapter, requireOrchestratorProtocol, resolveEnvironment } from './environments.js';

// Archon conversation ids are `web-…` platform ids; the same shape gate the
// real server applies to the /message path parameter.
const CONVERSATION_ID_RE = /^[\w-]+$/;

function isoNow() { return new Date().toISOString(); }

function convErr(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

// Transport timeout, normalized: a transport that carries no usable timeout
// must never reach AbortSignal.timeout(undefined), which throws instead of
// timing out. `floor` raises a too-short configured timeout for calls that
// legitimately take longer (creation, binding).
function transportTimeout(tp, floor) {
  const n = Number(tp && tp.timeoutMs);
  const ms = Number.isFinite(n) && n > 0 ? n : 30000;
  return floor ? Math.max(ms, floor) : ms;
}

function safeJson(value) {
  try { return JSON.stringify(value).slice(0, 300); } catch { return null; }
}

// GET /api/conversations/{id} looks the row up by PLATFORM id and returns the
// full row (existence + binding verification primitive). Field spellings are
// accepted in snake_case or camelCase — the exact serializer on the real
// server was confirmed from the bundle as snake_case, but the projection must
// not break if it ever changes.
function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const id = row.platform_conversation_id ?? row.platformConversationId ?? row.conversationId ?? null;
  const codebaseId = row.codebase_id ?? row.codebaseId ?? null;
  return { id: id == null ? '' : String(id), codebaseId: codebaseId == null ? null : String(codebaseId), cwd: row.cwd || null };
}

async function fetchConversation(id, transport) {
  const { config } = resolveConfig();
  const tp = transport || localTransport(config);
  let res;
  try {
    res = await fetch(tp.baseUrl + '/api/conversations/' + encodeURIComponent(id), {
      headers: tp.headers(),
      signal: AbortSignal.timeout(transportTimeout(tp)),
    });
  } catch (err) {
    throw convErr('conversation-verify-failed', 'conversation verification could not reach Archon: ' + String((err && err.message) || err), { conversationId: id, environmentId: tp.environmentId || null });
  }
  if (res.status === 404) throw convErr('conversation-association-dangling', 'associated conversation does not exist in Archon', { conversationId: id, environmentId: tp.environmentId || null });
  if (!res.ok) throw convErr('conversation-verify-failed', 'conversation verification failed: HTTP ' + res.status, { conversationId: id, environmentId: tp.environmentId || null });
  return normalizeRow(await res.json().catch(() => null));
}

// LEGACY FALLBACK ONLY (see the binding rule at the top of this file): Archon
// v0.4.1 implements no /setproject handler, so this can only bind on servers
// that do. An accepted reply is NOT proof of binding — the caller re-reads the
// conversation and compares codebase ids, and an unbound result fails closed.
async function setProject(id, projectName, transport) {
  const { config } = resolveConfig();
  const tp = transport || localTransport(config);
  let res;
  try {
    res = await fetch(tp.baseUrl + '/api/conversations/' + encodeURIComponent(id) + '/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tp.headers() },
      body: JSON.stringify({ message: '/setproject ' + projectName }),
      signal: AbortSignal.timeout(transportTimeout(tp, 10000)),
    });
  } catch (err) {
    throw convErr('conversation-bind-failed', 'project binding could not reach Archon: ' + String((err && err.message) || err), { conversationId: id, projectName, environmentId: tp.environmentId || null });
  }
  if (!res.ok) throw convErr('conversation-bind-failed', 'project binding rejected: HTTP ' + res.status, { conversationId: id, projectName, environmentId: tp.environmentId || null });
  return true;
}

// The transport for a task's bound workspace: the environment the workspace
// RECORDS, resolved and adapter-checked, never a caller-supplied name. A task
// with no recorded workspace has no environment binding yet — it is provisioned
// through the Local path, exactly as before P3A. An environment whose adapter
// this build does not implement throws here, and an implemented adapter whose
// orchestrator role is not deployed (the solari execution worker) throws here
// too: this module speaks the orchestrator conversation protocol, and no
// protocol call may be built against an endpoint that does not exist.
export function transportForWorkspace({ workspace, config } = {}) {
  const resolved = config || resolveConfig().config;
  const environmentId = workspace && workspace.environmentId ? workspace.environmentId : null;
  if (!environmentId) return localTransport(resolved);
  const environment = requireEnvironmentAdapter(resolveEnvironment({ environmentId, config: resolved }));
  requireOrchestratorProtocol(environment);
  return environmentTransport(environment, resolved);
}

async function recordBindError(taskId, assoc, code, message, extra = {}) {
  try {
    const task = await getTask(taskId);
    await upsertTask({ ...task, conversation: { ...assoc, bindError: { code, message, ...extra, at: isoNow() } } });
  } catch { /* best-effort annotation; the thrown error carries the truth */ }
}

function associationOf(task) {
  const assoc = task && task.conversation;
  return assoc && typeof assoc === 'object' ? assoc : null;
}

// Verify an existing association: existence, current binding, and — when the
// association recorded an expectation — that the binding still matches it.
// Never creates anything. The transport follows the TASK's recorded workspace
// binding unless the caller supplies the one it already resolved; a task with
// no recorded environment is verified through the Local path, exactly as before
// P3A.
export async function verifyConversationAssociation({ taskId, expectedCodebaseId, transport } = {}) {
  if (!taskId) throw convErr('conversation-not-bound', 'no task id — no conversation association can exist', { taskId });
  const task = await getTask(taskId);
  const assoc = associationOf(task);
  if (!assoc || !assoc.archonConversationId) {
    throw convErr('conversation-not-bound', 'task has no associated Archon conversation — provision one before dispatch', { taskId });
  }
  const tp = transport || transportForWorkspace({ workspace: task && task.workspace });
  const id = String(assoc.archonConversationId);
  if (!CONVERSATION_ID_RE.test(id)) {
    throw convErr('conversation-association-invalid', 'persisted conversation association is malformed', { taskId, archonConversationId: id });
  }
  const row = await fetchConversation(id, tp);
  const liveCodebase = row ? row.codebaseId : null;
  if (!liveCodebase) {
    throw convErr('conversation-not-bound', 'association exists but the conversation is not bound to a project — set the project before dispatch', { taskId, conversationId: id });
  }
  const expected = expectedCodebaseId || assoc.verifiedCodebaseId || assoc.expectedCodebaseId || null;
  if (expected && liveCodebase !== String(expected)) {
    throw convErr('conversation-bound-wrong-project', 'conversation is bound to a different project than the persisted association', { taskId, conversationId: id, expectedCodebaseId: String(expected), liveCodebaseId: liveCodebase });
  }
  return { conversationId: id, codebaseId: liveCodebase, association: assoc };
}

// The dispatch-time gate (T1): the run's conversation_id must exactly equal
// the id durably associated with this task, verified live just before
// dispatch. Returns the association the dispatch must use.
export async function requireDispatchableConversation({ taskId, transport } = {}) {
  if (!taskId) throw convErr('conversation-not-bound', 'no task id — no conversation association can exist', { taskId });
  const task = await getTask(taskId);
  const assoc = associationOf(task);
  if (assoc && assoc.provisioningState === 'intent') {
    throw convErr('conversation-provision-unresolved', 'provisioning intent persisted but no conversation id was recorded — reconcile the orphan before dispatch', { taskId, intentAt: assoc.intentAt || null });
  }
  return verifyConversationAssociation({ taskId, transport });
}

// The id to use for a dispatch, if a valid association is persisted. Returns
// null when there is none (fresh/retry/fork task provisioned later) — callers
// treat null as "not yet provisioned", never as a license to derive an id.
export async function associatedConversationId(taskId) {
  try {
    const task = await getTask(taskId);
    const assoc = associationOf(task);
    const id = assoc && assoc.archonConversationId ? String(assoc.archonConversationId) : null;
    return id && CONVERSATION_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

// Shared tail of provisioning: verify the conversation exists, bind the
// project if (and only if) it is not already bound, re-verify, and persist the
// verified association. Idempotent: every step is skipped when already done.
async function finishAssociation({ taskId, id, assoc, projectName, expectedCodebaseId, transport }) {
  const wantedProject = projectName || assoc.projectName || null;
  const wantedCodebase = expectedCodebaseId ? String(expectedCodebaseId) : (assoc.expectedCodebaseId ? String(assoc.expectedCodebaseId) : null);
  const tp = transport || transportForWorkspace({ workspace: (await getTask(taskId))?.workspace });

  const row = await fetchConversation(id, tp); // 404 → conversation-association-dangling
  let liveCodebase = row ? row.codebaseId : null;

  if (wantedCodebase && liveCodebase && liveCodebase !== wantedCodebase) {
    const err = convErr('conversation-bound-wrong-project', 'conversation is bound to a different project than the persisted association', { taskId, conversationId: id, expectedCodebaseId: wantedCodebase, liveCodebaseId: liveCodebase });
    await recordBindError(taskId, assoc, err.code, err.message, { liveCodebaseId: liveCodebase });
    throw err;
  }

  if (!liveCodebase && wantedProject) {
    await setProject(id, wantedProject, tp);
    const rebound = await fetchConversation(id, tp);
    liveCodebase = rebound ? rebound.codebaseId : null;
    if (!liveCodebase) {
      const err = convErr('conversation-bind-unverified', 'project binding did not take effect — the conversation is still unbound', { taskId, conversationId: id, projectName: wantedProject });
      await recordBindError(taskId, assoc, err.code, err.message, {});
      throw err;
    }
    if (wantedCodebase && liveCodebase !== wantedCodebase) {
      const err = convErr('conversation-bound-wrong-project', 'project binding landed on a different project than expected', { taskId, conversationId: id, expectedCodebaseId: wantedCodebase, liveCodebaseId: liveCodebase });
      await recordBindError(taskId, assoc, err.code, err.message, { liveCodebaseId: liveCodebase });
      throw err;
    }
  }

  const verified = {
    ...assoc,
    provisioningState: 'associated',
    archonConversationId: id,
    projectName: wantedProject || assoc.projectName || null,
    expectedCodebaseId: wantedCodebase,
    boundAt: assoc.boundAt || isoNow(),
    boundProjectName: wantedProject || assoc.boundProjectName || null,
    verifiedAt: isoNow(),
    verifiedCodebaseId: liveCodebase,
    bindError: null,
  };
  const task = await getTask(taskId);
  await upsertTask({ ...task, conversation: verified });
  return { reused: Boolean(assoc.verifiedAt), conversationId: id, dbId: assoc.dbId || null, codebaseId: liveCodebase, association: verified };
}

// Provision (or reuse) the Archon conversation durably associated with a task.
// `projectName` names a REGISTERED project; binding is established at CREATION
// by passing `expectedCodebaseId` as the create body's codebaseId (the route
// validates the codebase exists, the row binds at birth) and verified by
// reading the conversation back. `expectedCodebaseId`, when provided, is the
// codebase row the binding must land on — anything else fails closed.
export async function provisionConversation({ taskId, projectName, expectedCodebaseId, transport } = {}) {
  if (!taskId) throw convErr('task-not-found', 'taskId required', {});
  if (!projectName || typeof projectName !== 'string') throw convErr('conversation-provision-invalid-input', 'projectName required', { taskId });
  const existing = await getTask(taskId);
  if (!existing) throw convErr('task-not-found', 'no task envelope for ' + taskId, { taskId });
  const assoc = associationOf(existing);
  // Every call in this function — creation, verification, binding — goes to the
  // orchestrator of the environment the TASK RECORDS, resolved and adapter-checked
  // once, here. A caller that already resolved it (the route, from the workspace it
  // just authorized) passes it in; otherwise the task's own binding decides.
  const tp = transport || transportForWorkspace({ workspace: existing.workspace });

  // intent-evidence-before-call: an intent record with no conversation id
  // means a previous attempt died at (or before) the creation POST. Creating
  // again here would blind-mint a second conversation — report the unresolved
  // association instead (a recoverable orphan beats a wrong identity).
  if (assoc && !assoc.archonConversationId && assoc.provisioningState === 'intent') {
    throw convErr('conversation-provision-unresolved', 'provisioning intent persisted but no conversation id was recorded — reconcile the orphan before re-provisioning', { taskId, intentAt: assoc.intentAt || null });
  }

  if (assoc && assoc.archonConversationId) {
    const id = String(assoc.archonConversationId);
    if (!CONVERSATION_ID_RE.test(id)) {
      throw convErr('conversation-association-invalid', 'persisted conversation association is malformed', { taskId, archonConversationId: id });
    }
    if (assoc.provisioningState === 'intent') {
      // Unreachable in practice (intent records carry no id) but kept as an
      // explicit guard: an intent state must never be silently upgraded.
      throw convErr('conversation-provision-unresolved', 'provisioning intent persisted but no conversation id was recorded — reconcile the orphan before re-provisioning', { taskId, intentAt: assoc.intentAt || null });
    }
    // Reuse path: verify + idempotently complete bind/verify. No creation.
    return finishAssociation({ taskId, id, assoc, projectName, expectedCodebaseId, transport: tp });
  }

  // intent-evidence-before-call: persist provisioning intent FIRST. If the
  // process dies between the creation POST and the association write below,
  // the next attempt reports conversation-provision-unresolved instead of
  // silently minting a second (orphaned) conversation.
  const intent = {
    provisioningState: 'intent',
    intentAt: isoNow(),
    projectName: String(projectName),
    expectedCodebaseId: expectedCodebaseId ? String(expectedCodebaseId) : null,
  };
  await upsertTask({ ...existing, conversation: intent });

  let created = null;
  try {
    const res = await fetch(tp.baseUrl + '/api/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tp.headers() },
      // codebaseId rides the create body (the same expectedCodebaseId already
      // persisted as intent above) so the row is BOUND AT BIRTH — the route
      // validates the codebase and getOrCreateConversation persists it. A
      // message-bearing creation has side effects (persisted message, AI call)
      // and is not part of this contract. No codebase id → empty body, and
      // finishAssociation's legacy /setproject fallback (which Archon v0.4.1
      // cannot satisfy) decides honestly instead.
      body: JSON.stringify(expectedCodebaseId ? { codebaseId: String(expectedCodebaseId) } : {}),
      signal: AbortSignal.timeout(transportTimeout(tp, 10000)),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw convErr('conversation-provision-rejected', 'conversation creation rejected: HTTP ' + res.status + (text ? ' — ' + text.slice(0, 200) : ''), { taskId });
    }
    created = await res.json();
  } catch (err) {
    if (err && err.code) throw err;
    throw convErr('conversation-provision-failed', 'conversation creation could not be completed: ' + String((err && err.message) || err), { taskId });
  }

  const archonConversationId = created && created.conversationId ? String(created.conversationId) : null;
  const dbId = created && created.id != null ? String(created.id) : null;
  if (!archonConversationId || !CONVERSATION_ID_RE.test(archonConversationId)) {
    throw convErr('conversation-provision-invalid-response', 'conversation creation returned no usable conversation id', { taskId, response: safeJson(created) });
  }

  // Persist the REAL returned id before binding: the association must survive
  // even if binding then fails.
  const persisted = {
    provisioningState: 'associated',
    archonConversationId,
    dbId,
    provisionedAt: isoNow(),
    provisionedVia: 'POST /api/conversations',
    projectName: String(projectName),
    expectedCodebaseId: expectedCodebaseId ? String(expectedCodebaseId) : null,
  };
  await upsertTask({ ...existing, conversation: persisted });
  return finishAssociation({ taskId, id: archonConversationId, assoc: persisted, projectName: String(projectName), expectedCodebaseId, transport: tp });
}
