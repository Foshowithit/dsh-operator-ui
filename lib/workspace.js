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

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getDshHome, resolveConfig } from './config.js';

export const WORKSPACES_VERSION = 1;
const MAX_WORKSPACES = 200;

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

function archonHeaders() {
  const { config } = resolveConfig();
  const headers = {};
  const tokenVar = config.archon.tokenVar;
  if (typeof tokenVar === 'string' && process.env[tokenVar]) headers.authorization = 'Bearer ' + process.env[tokenVar];
  return headers;
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
async function registerCodebase(path) {
  const { config } = resolveConfig();
  let res;
  try {
    res = await fetch(config.archon.baseUrl + '/api/codebases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...archonHeaders() },
      body: JSON.stringify({ path }),
      signal: AbortSignal.timeout(Math.max(config.archon.timeoutMs, 10000)),
    });
  } catch (err) {
    throw wsErr('workspace-create-failed', 'workspace registration could not reach Archon: ' + String((err && err.message) || err), { path });
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body && typeof body.error === 'string' ? body.error : 'HTTP ' + res.status;
    throw wsErr('workspace-create-failed', 'workspace registration rejected: ' + detail, { path, status: res.status });
  }
  const row = normalizeCodebase(body);
  if (!row) throw wsErr('workspace-create-failed', 'workspace registration returned no codebase id', { path });
  return { row, created: res.status === 201 };
}

// Live codebase list. Unreachable Archon is a REPORTED state, never a
// fabricated answer; a reachable Archon with an unparseable body is a failure.
async function readCodebaseList() {
  const { config } = resolveConfig();
  let res;
  try {
    res = await fetch(config.archon.baseUrl + '/api/codebases', {
      headers: archonHeaders(),
      signal: AbortSignal.timeout(config.archon.timeoutMs),
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
// that is state 'ok' with a null codebase, not an unavailable read.
export async function readCodebase(codebaseId) {
  const { config } = resolveConfig();
  let res;
  try {
    res = await fetch(config.archon.baseUrl + '/api/codebases/' + encodeURIComponent(codebaseId), {
      headers: archonHeaders(),
      signal: AbortSignal.timeout(config.archon.timeoutMs),
    });
  } catch (err) {
    return { state: 'unavailable', codebase: null, reason: String((err && err.message) || err) };
  }
  if (res.status === 404) return { state: 'ok', codebase: null };
  if (!res.ok) return { state: 'unavailable', codebase: null, reason: 'HTTP ' + res.status };
  return { state: 'ok', codebase: normalizeCodebase(await res.json().catch(() => null)) };
}

// Best-effort rollback of a registration this process just made. Only called
// for the ambiguity refusal, where the row is seconds old and unused.
async function deleteCodebase(codebaseId) {
  const { config } = resolveConfig();
  try {
    const res = await fetch(config.archon.baseUrl + '/api/codebases/' + encodeURIComponent(codebaseId), {
      method: 'DELETE',
      headers: archonHeaders(),
      signal: AbortSignal.timeout(Math.max(config.archon.timeoutMs, 10000)),
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

export async function createWorkspace({ path, owner }) {
  const ownerValue = requireOwner(owner);
  const requestedPath = typeof path === 'string' ? path.trim() : '';
  if (!requestedPath) throw wsErr('workspace-path-required', 'workspace creation requires a path');

  const { row } = await registerCodebase(requestedPath);

  const store = await readStore();
  const known = store.workspaces.find((w) => w.codebaseId === row.codebaseId) || null;
  if (known) {
    // Idempotent re-create of the same path. A different owner is a refusal:
    // the workspace already belongs to someone.
    if (known.owner !== ownerValue) {
      throw wsErr('workspace-owner-mismatch', 'workspace already belongs to a different owner', { workspaceId: known.workspaceId, codebaseId: row.codebaseId });
    }
    return known;
  }
  if (store.workspaces.length >= MAX_WORKSPACES) {
    throw wsErr('workspace-limit-reached', 'workspace limit reached (' + MAX_WORKSPACES + ')');
  }

  // Ambiguity guard: binding resolves the project by name, so a second
  // codebase with the same name would make the binding undecidable.
  const list = await readCodebaseList();
  if (list.state === 'ok') {
    const conflicts = list.codebases.filter((c) => c.name === row.name && c.codebaseId !== row.codebaseId);
    if (conflicts.length > 0) {
      await deleteCodebase(row.codebaseId);
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
  return store.workspaces.filter((w) => w.owner === ownerValue);
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
  return record;
}
