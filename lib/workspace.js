// dsh-operator-ui — explicit workspace identity (P2).
//
// A workspace is a distinct identity from a task (the RCOS objective) and from
// a conversation: it is the Archon CODEBASE that a task's conversation binds
// to. Creation goes through Archon's supported codebase API
// (POST /api/codebases) and the row Archon returns is the ONLY authority for
// the workspace's id, name, and path — the real server's body schema accepts
// exactly one of url|path and strips unknown keys, so a caller-supplied name
// is ignored and the name is always the basename of the registered path.
// Nothing here derives a workspace name locally.
//
// Rules (GPT P2 work order, 2026-09-21):
// - ownership is explicit and required. A workspace record is never created
//   without an owner, and a resolve that does not carry the recorded owner
//   fails closed (workspace-owner-mismatch) instead of silently using someone
//   else's workspace.
// - the record persists only AFTER Archon confirmed the registration, and it
//   is keyed on the codebase id Archon returned, so a crash between
//   registration and use surfaces as a re-resolvable record rather than a
//   duplicate registration.
// - registration is idempotent by path: Archon dedupes by default_cwd and
//   answers 200 (already existed) vs 201 (created); both are the same
//   workspace identity here.
// - a name collision across DIFFERENT codebases is a refusal, not a coin flip:
//   conversation binding selects the project BY NAME, so two codebases sharing
//   a name would make the binding ambiguous. When the live list is reachable
//   the fresh registration is rolled back and the create is refused. When the
//   list is unreachable the record is kept with nameChecked:false — the
//   bind-time read-back verification remains the backstop.
//
// Rules added for P3A environment binding (GPT work order, 2026-09-21):
// - a workspace is registered IN an environment: the codebase id it carries was
//   minted by that environment's orchestrator, so the environment is recorded on
//   the record and every later read of the workspace goes through that
//   environment's transport. A workspace is never re-pointed: re-creating the
//   same codebase id under a different environment is a refusal
//   (workspace-environment-mismatch), not a silent re-bind.
// - a record written before P3A carries no environmentId and was registered
//   against the local orchestrator transport, so a missing field resolves to
//   env-local — NEVER to the configured default, which would silently move an
//   existing workspace onto a cloud environment.
// - a declared-but-unimplemented adapter is refused BEFORE the registration
//   side effect, because registering a codebase IS a side effect in the
//   orchestrator and there is no transport to perform it through. Reads report
//   the same condition as an honest unavailable state.
// - environment selection is checked against the environment's workspace scope,
//   and the resolve path fails closed on an unknown or foreign environment.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getDshHome, resolveConfig } from './config.js';
import {
  LOCAL_ENVIRONMENT_ID,
  environmentAdapterStatus,
  environmentTransport,
  isEnvironmentId,
  requireEnvironmentAdapter,
  requireEnvironmentForOwner,
  resolveEnvironment,
} from './environments.js';

export const WORKSPACES_VERSION = 1;
const MAX_WORKSPACES = 200;

// P5 guided creation (C1): the ONLY place a server-generated workspace path is
// built. The configured root is the sole parent, a caller label may only narrow
// the basename (strict charset, traversal rejected — never sanitized into
// something the caller did not ask for), and the timestamp + random suffix are
// minted HERE so the final path is always server-generated even when a label
// is supplied.
const LABEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,38}$/;
export function guidedWorkspacePath({ root, label, now = new Date(), randomHex }) {
  if (typeof root !== 'string' || !root.startsWith('/')) {
    throw wsErr('workspace-root-not-configured', 'guided workspace creation requires a configured absolute workspaces root (workspaces.root / DSH_OPERATOR_UI_WORKSPACES_ROOT)');
  }
  let slug = 'ws';
  if (label !== undefined && label !== null && String(label).trim() !== '') {
    const raw = String(label).trim();
    if (!LABEL_RE.test(raw) || raw.includes('..')) {
      throw wsErr('workspace-label-invalid', 'workspace label must be 1-39 chars of letters, digits, dot, dash, underscore with no ".." — got a label that could not be used safely');
    }
    slug = raw.toLowerCase();
  }
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const rand = typeof randomHex === 'string' ? randomHex : randomBytes(2).toString('hex');
  return { path: join(root, slug + '-' + stamp + '-' + rand), slug };
}

function isoNow() { return new Date().toISOString(); }

function wsErr(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function workspacesFilePath() {
  return join(getDshHome(), 'operator-ui', 'workspaces.json');
}

async function readStore() {
  let raw;
  try {
    raw = await readFile(workspacesFilePath(), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { version: WORKSPACES_VERSION, workspaces: [] };
    throw wsErr('workspace-store-unreadable', 'workspace store could not be read: ' + String((err && err.message) || err));
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    throw wsErr('workspace-store-unreadable', 'workspace store is not valid JSON');
  }
  const workspaces = Array.isArray(parsed && parsed.workspaces) ? parsed.workspaces.filter((w) => w && typeof w === 'object') : [];
  return { version: parsed && parsed.version ? parsed.version : WORKSPACES_VERSION, workspaces };
}

async function writeStore(store) {
  const file = workspacesFilePath();
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + randomBytes(4).toString('hex');
  await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  await rename(tmp, file);
}

// The environment a stored record is bound to. A pre-P3A record has no field:
// it was registered through the local orchestrator transport, so it resolves to
// env-local. Reading a missing field as the configured default would move an
// existing workspace onto a cloud environment without anyone asking for it.
export function recordEnvironmentId(record) {
  const id = record && record.environmentId;
  return isEnvironmentId(id) ? id : LOCAL_ENVIRONMENT_ID;
}

// Read-side adapter gap. A declared-but-unimplemented adapter has no transport
// at all (a solari-sandbox declaration carries no endpoint by construction), so
// reads answer an unavailable state naming the gap instead of building a
// malformed URL out of undefined.
function adapterGap(environment) {
  const status = environmentAdapterStatus(environment);
  return status.implemented ? null : status;
}

// The wire row's `commands` is an object and timestamps are ISO strings; the
// projection accepts snake_case or camelCase so it survives a serializer
// change, and requires a usable id — a row without one is not a workspace.
function normalizeCodebase(row) {
  if (!row || typeof row !== 'object') return null;
  const codebaseId = row.id ?? row.codebaseId ?? null;
  if (codebaseId == null || String(codebaseId) === '') return null;
  const name = row.name ?? null;
  const path = row.default_cwd ?? row.defaultCwd ?? row.path ?? null;
  return {
    codebaseId: String(codebaseId),
    name: name == null ? '' : String(name),
    path: path == null ? null : String(path),
    kind: row.kind ? String(row.kind) : null,
    repositoryUrl: row.repository_url ?? row.repositoryUrl ?? null,
  };
}

// POST /api/codebases. Exactly one of url|path; the caller here only ever
// registers a local path, so a url is refused rather than silently rewritten.
// The transport is supplied by the caller and is the ONLY way this reaches an
// orchestrator: nothing here reads config.archon directly any more.
async function registerCodebase(path, transport) {
  let res;
  try {
    res = await fetch(transport.baseUrl + '/api/codebases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...transport.headers() },
      body: JSON.stringify({ path }),
      signal: AbortSignal.timeout(Math.max(transport.timeoutMs, 10000)),
    });
  } catch (err) {
    throw wsErr('workspace-create-failed', 'workspace registration could not reach Archon: ' + String((err && err.message) || err), { path, environmentId: transport.environmentId });
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body && typeof body.error === 'string' ? body.error : 'HTTP ' + res.status;
    throw wsErr('workspace-create-failed', 'workspace registration rejected: ' + detail, { path, status: res.status, environmentId: transport.environmentId });
  }
  const row = normalizeCodebase(body);
  if (!row) throw wsErr('workspace-create-failed', 'workspace registration returned no codebase id', { path, environmentId: transport.environmentId });
  return { row, created: res.status === 201 };
}

// Live codebase list. Unreachable Archon is a REPORTED state, never a
// fabricated answer; a reachable Archon with an unparseable body is a failure.
async function readCodebaseList(transport) {
  let res;
  try {
    res = await fetch(transport.baseUrl + '/api/codebases', {
      headers: transport.headers(),
      signal: AbortSignal.timeout(transport.timeoutMs),
    });
  } catch (err) {
    return { state: 'unavailable', codebases: null, reason: String((err && err.message) || err) };
  }
  if (!res.ok) return { state: 'unavailable', codebases: null, reason: 'HTTP ' + res.status };
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body)) return { state: 'unavailable', codebases: null, reason: 'codebase list was not an array' };
  return { state: 'ok', codebases: body.map(normalizeCodebase).filter(Boolean) };
}

// GET /api/codebases/{id}. A 404 means Archon ANSWERED and the row is gone —
// that is state 'ok' with a null codebase, not an unavailable read. The
// environment is an explicit argument because the read must go to the
// orchestrator that minted the id, not to whatever is configured as default.
export async function readCodebase(codebaseId, environmentId) {
  const { config } = resolveConfig();
  const environment = resolveEnvironment({ environmentId, config });
  const gap = adapterGap(environment);
  if (gap) return { state: 'unavailable', codebase: null, reason: gap.reason, environmentId: environment.environmentId };
  const transport = environmentTransport(environment, config);
  let res;
  try {
    res = await fetch(transport.baseUrl + '/api/codebases/' + encodeURIComponent(codebaseId), {
      headers: transport.headers(),
      signal: AbortSignal.timeout(transport.timeoutMs),
    });
  } catch (err) {
    return { state: 'unavailable', codebase: null, reason: String((err && err.message) || err), environmentId: environment.environmentId };
  }
  if (res.status === 404) return { state: 'ok', codebase: null };
  if (!res.ok) return { state: 'unavailable', codebase: null, reason: 'HTTP ' + res.status, environmentId: environment.environmentId };
  return { state: 'ok', codebase: normalizeCodebase(await res.json().catch(() => null)) };
}

// Best-effort rollback of a registration this process just made. Only called
// for the ambiguity refusal, where the row is seconds old and unused.
async function deleteCodebase(codebaseId, transport) {
  try {
    const res = await fetch(transport.baseUrl + '/api/codebases/' + encodeURIComponent(codebaseId), {
      method: 'DELETE',
      headers: transport.headers(),
      signal: AbortSignal.timeout(Math.max(transport.timeoutMs, 10000)),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function requireOwner(owner) {
  const value = typeof owner === 'string' ? owner.trim() : '';
  if (!value) throw wsErr('workspace-owner-required', 'workspace operations require an explicit owner');
  return value;
}

export async function createWorkspace({ path, owner, environmentId }) {
  const ownerValue = requireOwner(owner);
  const requestedPath = typeof path === 'string' ? path.trim() : '';
  if (!requestedPath) throw wsErr('workspace-path-required', 'workspace creation requires a path');

  // Environment selection is resolved and authorized BEFORE anything is
  // created: an unauthorized selection, an unknown environment, or a declared
  // adapter this build does not implement must not leave a codebase behind in
  // an orchestrator.
  const { config } = resolveConfig();
  const environment = requireEnvironmentForOwner({ environmentId, owner: ownerValue, config });
  requireEnvironmentAdapter(environment);
  const transport = environmentTransport(environment, config);

  const { row } = await registerCodebase(requestedPath, transport);

  const store = await readStore();
  const known = store.workspaces.find((w) => w.codebaseId === row.codebaseId) || null;
  if (known) {
    // Idempotent re-create of the same path. A different owner is a refusal:
    // the workspace already belongs to someone.
    if (known.owner !== ownerValue) {
      throw wsErr('workspace-owner-mismatch', 'workspace already belongs to a different owner', { workspaceId: known.workspaceId, codebaseId: row.codebaseId });
    }
    // The codebase id was minted by one environment's orchestrator. The same id
    // reached through a different environment is not the same workspace, and
    // re-binding it would make the environment recorded in a receipt a lie.
    const boundId = recordEnvironmentId(known);
    if (boundId !== environment.environmentId) {
      throw wsErr('workspace-environment-mismatch', 'workspace is bound to a different environment', {
        workspaceId: known.workspaceId,
        codebaseId: row.codebaseId,
        boundEnvironmentId: boundId,
        requestedEnvironmentId: environment.environmentId,
      });
    }
    return { ...known, environmentId: boundId };
  }
  if (store.workspaces.length >= MAX_WORKSPACES) {
    throw wsErr('workspace-limit-reached', 'workspace limit reached (' + MAX_WORKSPACES + ')');
  }

  // Ambiguity guard: binding resolves the project by name, so a second
  // codebase with the same name would make the binding undecidable.
  const list = await readCodebaseList(transport);
  if (list.state === 'ok') {
    const conflicts = list.codebases.filter((c) => c.name === row.name && c.codebaseId !== row.codebaseId);
    if (conflicts.length > 0) {
      await deleteCodebase(row.codebaseId, transport);
      throw wsErr('workspace-name-ambiguous', 'workspace name is not unique in Archon: ' + row.name, {
        name: row.name,
        codebaseId: row.codebaseId,
        conflicts: conflicts.map((c) => ({ codebaseId: c.codebaseId, path: c.path })),
      });
    }
  }

  const record = {
    workspaceId: 'ws-' + randomBytes(8).toString('hex'),
    name: row.name,
    path: row.path,
    requestedPath,
    codebaseId: row.codebaseId,
    kind: row.kind,
    owner: ownerValue,
    environmentId: environment.environmentId,
    createdAt: isoNow(),
    nameChecked: list.state === 'ok',
  };
  store.workspaces.push(record);
  store.version = WORKSPACES_VERSION;
  await writeStore(store);
  return record;
}

export async function listWorkspaces({ owner }) {
  const ownerValue = requireOwner(owner);
  const store = await readStore();
  // The environment is projected through the same legacy rule as the resolve
  // path, so a caller never has to know that pre-P3A records omit the field.
  return store.workspaces
    .filter((w) => w.owner === ownerValue)
    .map((w) => ({ ...w, environmentId: recordEnvironmentId(w) }));
}

export async function resolveWorkspace({ workspaceId, owner }) {
  const ownerValue = requireOwner(owner);
  const id = typeof workspaceId === 'string' ? workspaceId.trim() : '';
  if (!id) throw wsErr('workspace-id-required', 'workspace resolution requires a workspaceId');
  const store = await readStore();
  const record = store.workspaces.find((w) => w.workspaceId === id) || null;
  if (!record) throw wsErr('workspace-not-found', 'no such workspace: ' + id, { workspaceId: id });
  if (record.owner !== ownerValue) {
    throw wsErr('workspace-owner-mismatch', 'workspace belongs to a different owner', { workspaceId: id, codebaseId: record.codebaseId });
  }
  // Fail closed on the binding itself: an environment that is no longer
  // configured, or one whose scope no longer admits this owner, makes the
  // workspace unusable — and a workspace whose environment cannot be named
  // must not dispatch anywhere. The adapter is deliberately NOT required here:
  // an inspectable-but-unimplemented environment stays inspectable, and the
  // dispatch path is where the missing adapter becomes a refusal.
  const environmentId = recordEnvironmentId(record);
  requireEnvironmentForOwner({ environmentId, owner: ownerValue, config: resolveConfig().config });
  return { ...record, environmentId };
}
