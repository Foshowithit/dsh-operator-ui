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
// - project binding goes through the supported deterministic interface
//   (POST /api/conversations/{id}/message with `/setproject <name>`) and is
//   VERIFIED by reading the conversation back; an accepted reply is not proof
//   of binding.
// - fail closed: dispatch reads this association via
//   requireDispatchableConversation. An unknown or derived conversation id can
//   never reach a dispatch, and the run's workflow must match independently
//   (enforced by the caller's run discovery).

import { resolveConfig } from './config.js';
import { getTask, upsertTask } from './tasks.js';

// Archon conversation ids are `web-…` platform ids; the same shape gate the
// real server applies to the /message path parameter.
const CONVERSATION_ID_RE = /^[\w-]+$/;

function isoNow() { return new Date().toISOString(); }

function convErr(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function archonHeaders() {
  const { config } = resolveConfig();
  const headers = {};
  const tokenVar = config.archon.tokenVar;
  if (typeof tokenVar === 'string' && process.env[tokenVar]) headers.authorization = 'Bearer ' + process.env[tokenVar];
  return headers;
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

async function fetchConversation(id) {
  const { config } = resolveConfig();
  let res;
  try {
    res = await fetch(config.archon.baseUrl + '/api/conversations/' + encodeURIComponent(id), {
      headers: archonHeaders(),
      signal: AbortSignal.timeout(config.archon.timeoutMs),
    });
  } catch (err) {
    throw convErr('conversation-verify-failed', 'conversation verification could not reach Archon: ' + String((err && err.message) || err), { conversationId: id });
  }
  if (res.status === 404) throw convErr('conversation-association-dangling', 'associated conversation does not exist in Archon', { conversationId: id });
  if (!res.ok) throw convErr('conversation-verify-failed', 'conversation verification failed: HTTP ' + res.status, { conversationId: id });
  return normalizeRow(await res.json().catch(() => null));
}

// Supported deterministic project-selection interface. An accepted reply is
// NOT proof of binding — the caller must re-read the conversation and compare
// codebase ids.
async function setProject(id, projectName) {
  const { config } = resolveConfig();
  let res;
  try {
    res = await fetch(config.archon.baseUrl + '/api/conversations/' + encodeURIComponent(id) + '/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...archonHeaders() },
      body: JSON.stringify({ message: '/setproject ' + projectName }),
      signal: AbortSignal.timeout(Math.max(config.archon.timeoutMs, 10000)),
    });
  } catch (err) {
    throw convErr('conversation-bind-failed', 'project binding could not reach Archon: ' + String((err && err.message) || err), { conversationId: id, projectName });
  }
  if (!res.ok) throw convErr('conversation-bind-failed', 'project binding rejected: HTTP ' + res.status, { conversationId: id, projectName });
  return true;
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
// Never creates anything.
export async function verifyConversationAssociation({ taskId, expectedCodebaseId } = {}) {
  if (!taskId) throw convErr('conversation-not-bound', 'no task id — no conversation association can exist', { taskId });
  const task = await getTask(taskId);
  const assoc = associationOf(task);
  if (!assoc || !assoc.archonConversationId) {
    throw convErr('conversation-not-bound', 'task has no associated Archon conversation — provision one before dispatch', { taskId });
  }
  const id = String(assoc.archonConversationId);
  if (!CONVERSATION_ID_RE.test(id)) {
    throw convErr('conversation-association-invalid', 'persisted conversation association is malformed', { taskId, archonConversationId: id });
  }
  const row = await fetchConversation(id);
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
export async function requireDispatchableConversation({ taskId } = {}) {
  if (!taskId) throw convErr('conversation-not-bound', 'no task id — no conversation association can exist', { taskId });
  const task = await getTask(taskId);
  const assoc = associationOf(task);
  if (assoc && assoc.provisioningState === 'intent') {
    throw convErr('conversation-provision-unresolved', 'provisioning intent persisted but no conversation id was recorded — reconcile the orphan before dispatch', { taskId, intentAt: assoc.intentAt || null });
  }
  return verifyConversationAssociation({ taskId });
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
async function finishAssociation({ taskId, id, assoc, projectName, expectedCodebaseId }) {
  const wantedProject = projectName || assoc.projectName || null;
  const wantedCodebase = expectedCodebaseId ? String(expectedCodebaseId) : (assoc.expectedCodebaseId ? String(assoc.expectedCodebaseId) : null);

  const row = await fetchConversation(id); // 404 → conversation-association-dangling
  let liveCodebase = row ? row.codebaseId : null;

  if (wantedCodebase && liveCodebase && liveCodebase !== wantedCodebase) {
    const err = convErr('conversation-bound-wrong-project', 'conversation is bound to a different project than the persisted association', { taskId, conversationId: id, expectedCodebaseId: wantedCodebase, liveCodebaseId: liveCodebase });
    await recordBindError(taskId, assoc, err.code, err.message, { liveCodebaseId: liveCodebase });
    throw err;
  }

  if (!liveCodebase && wantedProject) {
    await setProject(id, wantedProject);
    const rebound = await fetchConversation(id);
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
// `projectName` names a REGISTERED project; binding is done by name through
// the supported /setproject interface. `expectedCodebaseId`, when provided,
// is the codebase row the binding must land on — anything else fails closed.
export async function provisionConversation({ taskId, projectName, expectedCodebaseId } = {}) {
  if (!taskId) throw convErr('task-not-found', 'taskId required', {});
  if (!projectName || typeof projectName !== 'string') throw convErr('conversation-provision-invalid-input', 'projectName required', { taskId });
  const existing = await getTask(taskId);
  if (!existing) throw convErr('task-not-found', 'no task envelope for ' + taskId, { taskId });
  const assoc = associationOf(existing);

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
    return finishAssociation({ taskId, id, assoc, projectName, expectedCodebaseId });
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

  const { config } = resolveConfig();
  let created = null;
  try {
    const res = await fetch(config.archon.baseUrl + '/api/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...archonHeaders() },
      // Empty body: a message-bearing creation has side effects (persisted
      // message, AI call) and is not part of this contract. codebaseId is
      // omitted deliberately — the project binding happens deterministically
      // by NAME via /setproject, and is verified afterwards.
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(Math.max(config.archon.timeoutMs, 10000)),
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
  return finishAssociation({ taskId, id: archonConversationId, assoc: persisted, projectName: String(projectName), expectedCodebaseId });
}
