// dsh-operator-ui — execution environments (P3A).
//
// An execution environment answers ONE question: where does a dispatched
// workflow actually run, and who owns the run record that comes back?
//
// Three identities stay strictly separate, and a receipt must never blur them:
//
//   ORCHESTRATOR  who accepted the dispatch and owns the run record. Today
//                 that is Archon, reached over its HTTP protocol. The
//                 orchestrator is NOT an execution-environment identity: an
//                 Archon instance fronting a remote worker is ONE orchestrator
//                 with a remote provider, not two environments.
//   PROVIDER      who executed the work. DECLARED by the environment before
//                 dispatch, and separately CLAIMED by the run record the
//                 orchestrator returns. The two are compared, never assumed
//                 equal — a run that claims a provider nobody declared is a
//                 receipt failure, not a curiosity.
//   ENVIRONMENT   the stable internal id binding a workspace to an
//                 orchestrator + adapter + provider + workspace scope.
//
// A display label is never any of the three. Labels are cosmetic; ids are what
// receipts, durable stores, and refusals carry.
//
// The LOCAL environment always exists and is SYNTHESIZED from config.archon.*,
// so a configuration written before this module existed resolves to exactly the
// transport it used before — identical behavior, no migration, no rewrite of
// stored records.
//
// A declared-but-unimplemented adapter is INSPECTABLE and refuses to dispatch.
// It never silently falls back to the local environment: a silent fallback
// would make the environment identity recorded in the receipt a lie.
//
// Nothing here holds a secret. A token is named (an env-var NAME), never
// carried: `tokenVar` travels; `process.env[tokenVar]` is read at request time
// and its value never enters a config object, a receipt, or a log.

import { createHash } from 'node:crypto';

export const ENVIRONMENT_CONTRACT_VERSION = 1;
export const LOCAL_ENVIRONMENT_ID = 'env-local';
export const ENVIRONMENT_ID_RE = /^env-[a-z0-9][a-z0-9-]{0,40}$/;
export const ENVIRONMENT_KINDS = ['local', 'solari-cloud', 'custom-remote'];
export const ADAPTER_KINDS = ['archon-http', 'solari-sandbox'];
export const ORCHESTRATOR_ID = 'archon';
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IMPLEMENTED_ADAPTERS = new Set(['archon-http']);

const sha256 = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

export const isEnvironmentId = (v) => typeof v === 'string' && ENVIRONMENT_ID_RE.test(v);

// ---------------------------------------------------------------- the local env
//
// Synthesized, never configured: it is the transport config.archon.* already
// describes. Its adapter is the Archon HTTP protocol, so a pre-P3A install
// keeps working with the same baseUrl, the same token name, the same timeout.
export function localEnvironment(config) {
  const archon = (config && config.archon) || {};
  return {
    environmentId: LOCAL_ENVIRONMENT_ID,
    kind: 'local',
    label: 'Local',
    providerId: 'archon-local',
    orchestrator: { id: ORCHESTRATOR_ID, adapter: 'archon-http' },
    adapter: {
      kind: 'archon-http',
      transport: {
        baseUrl: archon.baseUrl,
        tokenVar: typeof archon.tokenVar === 'string' ? archon.tokenVar : null,
        timeoutMs: archon.timeoutMs,
      },
    },
    workspaceScope: { owners: null },
    source: 'synthesized-from-archon-config',
  };
}

// ----------------------------------------------------------- config validation
//
// Called by lib/config.js, which owns the error-reporting contract: this
// function RETURNS errors as {key, message} and never throws, so an invalid
// environment is a reported state that drops the entry — never a boot failure.
// The local environment is not configurable here: it is synthesized, and a
// configured entry that tries to redefine it is refused.
export function normalizeEnvironments(raw) {
  const errors = [];
  const list = [];
  const out = { defaultId: LOCAL_ENVIRONMENT_ID, list, errors };
  if (raw === undefined || raw === null) return out;

  let block = raw;
  if (Array.isArray(raw)) block = { list: raw };
  if (typeof block !== 'object' || block === null) {
    errors.push({ key: 'environments', message: 'must be an object {defaultId, list} or an array of environments — using the local environment only' });
    return out;
  }

  const seen = new Set([LOCAL_ENVIRONMENT_ID]);
  const rawList = block.list === undefined || block.list === null ? [] : block.list;
  if (!Array.isArray(rawList)) {
    errors.push({ key: 'environments.list', message: 'must be an array — using the local environment only' });
  } else {
    for (let i = 0; i < rawList.length; i++) {
      const key = 'environments.list[' + i + ']';
      const e = rawList[i];
      if (typeof e !== 'object' || e === null || Array.isArray(e)) {
        errors.push({ key, message: 'must be an object — entry dropped' });
        continue;
      }
      if (!isEnvironmentId(e.environmentId)) {
        errors.push({ key: key + '.environmentId', message: 'must match ' + String(ENVIRONMENT_ID_RE) + ' (a stable internal id, not a display label) — entry dropped' });
        continue;
      }
      if (e.environmentId === LOCAL_ENVIRONMENT_ID) {
        errors.push({ key: key + '.environmentId', message: '"' + LOCAL_ENVIRONMENT_ID + '" is reserved for the synthesized local environment — entry dropped' });
        continue;
      }
      if (seen.has(e.environmentId)) {
        errors.push({ key: key + '.environmentId', message: 'duplicate environment id "' + e.environmentId + '" — entry dropped' });
        continue;
      }
      if (!ENVIRONMENT_KINDS.includes(e.kind) || e.kind === 'local') {
        errors.push({ key: key + '.kind', message: 'must be one of ' + ENVIRONMENT_KINDS.filter((k) => k !== 'local').join(', ') + ' — entry dropped' });
        continue;
      }
      if (typeof e.providerId !== 'string' || !PROVIDER_ID_RE.test(e.providerId)) {
        errors.push({ key: key + '.providerId', message: 'must be a declared provider id matching ' + String(PROVIDER_ID_RE) + ' — entry dropped (a receipt must name who executes, never infer it)' });
        continue;
      }
      const adapter = e.adapter;
      if (typeof adapter !== 'object' || adapter === null || !ADAPTER_KINDS.includes(adapter.kind)) {
        errors.push({ key: key + '.adapter.kind', message: 'must be one of ' + ADAPTER_KINDS.join(', ') + ' — entry dropped' });
        continue;
      }
      const transport = {};
      if (adapter.kind === 'archon-http') {
        const t = adapter.transport === undefined || adapter.transport === null ? {} : adapter.transport;
        if (typeof t !== 'object' || Array.isArray(t)) {
          errors.push({ key: key + '.adapter.transport', message: 'must be an object — entry dropped' });
          continue;
        }
        if (t.baseUrl !== undefined) {
          let ok = false;
          try {
            const u = new URL(String(t.baseUrl));
            ok = u.protocol === 'http:' || u.protocol === 'https:';
          } catch { ok = false; }
          if (!ok) {
            errors.push({ key: key + '.adapter.transport.baseUrl', message: 'must be an absolute http(s) URL — entry dropped' });
            continue;
          }
          transport.baseUrl = String(t.baseUrl);
        }
        if (t.tokenVar !== undefined && t.tokenVar !== null) {
          if (typeof t.tokenVar !== 'string' || !TOKEN_VAR_RE.test(t.tokenVar)) {
            errors.push({ key: key + '.adapter.transport.tokenVar', message: 'must be an env-var NAME (or null) — never a secret value; entry dropped' });
            continue;
          }
          transport.tokenVar = t.tokenVar;
        }
        if (t.timeoutMs !== undefined) {
          const n = Number(t.timeoutMs);
          if (!Number.isInteger(n) || n < 500 || n > 60000) {
            errors.push({ key: key + '.adapter.transport.timeoutMs', message: 'must be an integer 500..60000 — entry dropped' });
            continue;
          }
          transport.timeoutMs = n;
        }
      } else {
        // The Solari adapter takes NO endpoint: the official SDK supplies its
        // documented base URL, and an invented or account-specific URL in
        // source is exactly what the environment contract forbids. Only the
        // secret's NAME is configurable.
        if (adapter.transport && (adapter.transport.baseUrl !== undefined || adapter.transport.endpoint !== undefined || adapter.transport.url !== undefined)) {
          errors.push({ key: key + '.adapter.transport', message: 'the ' + adapter.kind + ' adapter takes no endpoint — the official SDK supplies its documented base URL; entry dropped' });
          continue;
        }
        const t = adapter.transport === undefined || adapter.transport === null ? {} : adapter.transport;
        if (t.tokenVar !== undefined && t.tokenVar !== null) {
          if (typeof t.tokenVar !== 'string' || !TOKEN_VAR_RE.test(t.tokenVar)) {
            errors.push({ key: key + '.adapter.transport.tokenVar', message: 'must be an env-var NAME (or null) — never a secret value; entry dropped' });
            continue;
          }
          transport.tokenVar = t.tokenVar;
        }
      }

      let workspaceScope = { owners: null };
      if (e.workspaceScope !== undefined && e.workspaceScope !== null) {
        if (typeof e.workspaceScope !== 'object' || Array.isArray(e.workspaceScope)) {
          errors.push({ key: key + '.workspaceScope', message: 'must be an object {owners: [...]} or {owners: null} — entry dropped' });
          continue;
        }
        const owners = e.workspaceScope.owners;
        if (owners !== undefined && owners !== null) {
          if (!Array.isArray(owners) || owners.some((o) => typeof o !== 'string' || !o.trim())) {
            errors.push({ key: key + '.workspaceScope.owners', message: 'must be null (any owner) or a non-empty array of owner names — entry dropped' });
            continue;
          }
          workspaceScope = { owners: owners.map((o) => o.trim()) };
        }
      }

      seen.add(e.environmentId);
      list.push({
        environmentId: e.environmentId,
        kind: e.kind,
        label: typeof e.label === 'string' && e.label.trim() ? e.label.trim().slice(0, 60) : e.environmentId,
        providerId: e.providerId,
        orchestrator: { id: ORCHESTRATOR_ID, adapter: adapter.kind },
        adapter: { kind: adapter.kind, transport },
        workspaceScope,
        source: 'config',
      });
    }
  }

  if (block.defaultId !== undefined && block.defaultId !== null) {
    if (!isEnvironmentId(block.defaultId)) {
      errors.push({ key: 'environments.defaultId', message: 'must match ' + String(ENVIRONMENT_ID_RE) + ' — using ' + LOCAL_ENVIRONMENT_ID });
    } else if (!seen.has(block.defaultId)) {
      errors.push({ key: 'environments.defaultId', message: 'names environment "' + block.defaultId + '" which is not configured — using ' + LOCAL_ENVIRONMENT_ID });
    } else {
      out.defaultId = block.defaultId;
    }
  }
  return out;
}

// ---------------------------------------------------------------- resolution

export function listEnvironments(config) {
  const block = (config && config.environments) || {};
  const configured = Array.isArray(block.list) ? block.list : [];
  return [localEnvironment(config), ...configured];
}

export function defaultEnvironmentId(config) {
  const block = (config && config.environments) || {};
  return isEnvironmentId(block.defaultId) ? block.defaultId : LOCAL_ENVIRONMENT_ID;
}

export function findEnvironment(environmentId, config) {
  const id = environmentId === undefined || environmentId === null || environmentId === '' ? defaultEnvironmentId(config) : String(environmentId);
  return listEnvironments(config).find((e) => e.environmentId === id) || null;
}

const envErr = (code, message, details = {}) => Object.assign(new Error(message), { code, details });

export function resolveEnvironment({ environmentId, config }) {
  const env = findEnvironment(environmentId, config);
  if (!env) {
    throw envErr('environment-not-found', 'environment "' + String(environmentId) + '" is not configured', {
      requested: environmentId === undefined || environmentId === null ? null : String(environmentId),
      known: listEnvironments(config).map((e) => e.environmentId),
    });
  }
  return env;
}

// A workspace bound to a scoped environment may only be used by the owners
// that environment names. `owners: null` means unscoped (the local case).
export function environmentAllowsOwner(env, owner) {
  const scope = env && env.workspaceScope;
  if (!scope || scope.owners === null || scope.owners === undefined) return true;
  return typeof owner === 'string' && scope.owners.includes(owner);
}

export function requireEnvironmentForOwner({ environmentId, owner, config }) {
  const env = resolveEnvironment({ environmentId, config });
  if (!environmentAllowsOwner(env, owner)) {
    throw envErr('environment-unauthorized', 'owner is not authorized for environment ' + env.environmentId, {
      environmentId: env.environmentId,
      allowedOwners: env.workspaceScope.owners,
    });
  }
  return env;
}

// ------------------------------------------------------------- adapter status

export function environmentAdapterStatus(env) {
  const kind = env && env.adapter && env.adapter.kind;
  if (IMPLEMENTED_ADAPTERS.has(kind)) return { implemented: true, code: null, reason: null };
  return {
    implemented: false,
    code: 'environment-adapter-missing',
    reason: 'the ' + String(kind) + ' execution adapter is declared but not implemented in this build — this environment is inspectable and refuses to dispatch',
  };
}

export function requireEnvironmentAdapter(env) {
  const status = environmentAdapterStatus(env);
  if (!status.implemented) {
    throw envErr(status.code, status.reason, { environmentId: env.environmentId, adapter: env.adapter && env.adapter.kind });
  }
  return env;
}

// ---------------------------------------------------------------- transport
//
// A transport is the ONLY thing that talks to an orchestrator: baseUrl +
// timeout + a headers() that reads the named token from the environment at
// request time. `headers()` is shaped exactly like the operator's historical
// archonHeaders() helper, so it is a drop-in at every existing fetch site.
export function localTransport(config) {
  const archon = (config && config.archon) || {};
  return {
    environmentId: LOCAL_ENVIRONMENT_ID,
    baseUrl: archon.baseUrl,
    timeoutMs: archon.timeoutMs,
    headers() {
      const headers = {};
      const tokenVar = archon.tokenVar;
      if (typeof tokenVar === 'string' && process.env[tokenVar]) headers.authorization = 'Bearer ' + process.env[tokenVar];
      return headers;
    },
  };
}

export function environmentTransport(env, config) {
  if (!env || env.kind === 'local') return localTransport(config);
  const t = (env.adapter && env.adapter.transport) || {};
  return {
    environmentId: env.environmentId,
    baseUrl: t.baseUrl,
    timeoutMs: t.timeoutMs,
    headers() {
      const headers = {};
      const tokenVar = t.tokenVar;
      if (typeof tokenVar === 'string' && process.env[tokenVar]) headers.authorization = 'Bearer ' + process.env[tokenVar];
      return headers;
    },
  };
}

export function transportFor({ environmentId, config }) {
  const environment = resolveEnvironment({ environmentId, config });
  return { environment, transport: environmentTransport(environment, config) };
}

// ------------------------------------------------- execution identity (receipts)
//
// Established BY THE EXECUTION PATH, never by the caller: the environment comes
// from the resolved binding, and the provider claim comes from the run record
// the orchestrator itself returned. The hash is a witness of the tuple that was
// actually recorded — it is not proof that any particular machine executed the
// work, and nothing here may be read as such.
export function executionIdentityFromRun({ environment, run, source, config }) {
  const r = run || {};
  const workflow = r.workflow_name || (r.workflow && r.workflow.name) || null;
  const claim = r.execution_provider === undefined || r.execution_provider === null || r.execution_provider === '' ? null : String(r.execution_provider);
  const tuple = [
    environment.environmentId,
    environment.orchestrator.id,
    environment.orchestrator.adapter,
    environment.providerId,
    source || null,
    r.id || null,
    workflow,
    r.conversation_id || null,
    r.codebase_id || null,
    r.working_path || null,
    claim,
  ];
  return {
    contract: ENVIRONMENT_CONTRACT_VERSION,
    environmentId: environment.environmentId,
    kind: environment.kind,
    orchestrator: { id: environment.orchestrator.id, adapter: environment.orchestrator.adapter },
    providerDeclared: environment.providerId,
    providerClaim: providerClaimVerdict({ environment, claim, config }),
    establishedBy: source || null,
    runId: r.id || null,
    workflowName: workflow,
    conversationId: r.conversation_id || null,
    codebaseId: r.codebase_id || null,
    workingPath: r.working_path || null,
    identitySha256: sha256(JSON.stringify(tuple)),
  };
}

// The run record's own claim about who executed, compared against what the
// bound environment declared. Absent claim: nothing is asserted, nothing is
// violated (legacy and local run records carry no claim). A claim that names a
// provider NO configured environment declares is UNSUPPORTED — the receipt is
// describing an execution this operator cannot account for, and that fails
// closed. A claim that names a different known provider is a MISMATCH.
export function providerClaimVerdict({ environment, claim, config }) {
  const declared = environment.providerId;
  if (claim === undefined || claim === null || claim === '') {
    return { status: 'not-claimed', ok: true, code: null, claimed: null, declared, reason: 'the run record claims no execution provider — nothing asserted, nothing violated' };
  }
  const claimed = String(claim);
  if (claimed === declared) {
    return { status: 'matches', ok: true, code: null, claimed, declared, reason: 'the run record claims the provider the bound environment declared' };
  }
  const known = listEnvironments(config).map((e) => e.providerId);
  if (!known.includes(claimed)) {
    return {
      status: 'unsupported',
      ok: false,
      code: 'execution-provider-unsupported',
      claimed,
      declared,
      reason: 'the run record claims execution provider "' + claimed + '", which no configured environment declares — the receipt cannot account for this execution',
    };
  }
  return {
    status: 'mismatch',
    ok: false,
    code: 'execution-provider-mismatch',
    claimed,
    declared,
    reason: 'the run record claims execution provider "' + claimed + '" but the bound environment declared "' + declared + '"',
  };
}

// ---------------------------------------------------------------- projection
//
// The status-safe shape: no secret value can appear here because no secret
// value ever enters an environment. A token is a NAME plus a presence boolean.
export function publicEnvironment(env, config) {
  const status = environmentAdapterStatus(env);
  const t = (env.adapter && env.adapter.transport) || {};
  const tokenVar = env.kind === 'local' ? (((config || {}).archon || {}).tokenVar || null) : (t.tokenVar || null);
  return {
    environmentId: env.environmentId,
    kind: env.kind,
    label: env.label,
    providerId: env.providerId,
    orchestrator: { id: env.orchestrator.id, adapter: env.orchestrator.adapter },
    adapter: {
      kind: env.adapter.kind,
      implemented: status.implemented,
      reason: status.reason,
      baseUrl: env.kind === 'local' ? (((config || {}).archon || {}).baseUrl || null) : (t.baseUrl || null),
      tokenVar,
      tokenConfigured: typeof tokenVar === 'string' ? !!process.env[tokenVar] : null,
      timeoutMs: env.kind === 'local' ? (((config || {}).archon || {}).timeoutMs || null) : (t.timeoutMs === undefined ? null : t.timeoutMs),
    },
    workspaceScope: env.workspaceScope,
    source: env.source,
  };
}

export function publicEnvironments(config) {
  const block = (config && config.environments) || {};
  return {
    contract: ENVIRONMENT_CONTRACT_VERSION,
    defaultId: defaultEnvironmentId(config),
    environments: listEnvironments(config).map((e) => publicEnvironment(e, config)),
  };
}

// The RECEIPT shape: identity only. Deliberately omits the display label — a
// receipt records the actual execution identity, never a presentation string a
// caller could have supplied — and every transport detail (endpoint, token
// variable name, timeout), because a receipt is durable evidence, not
// configuration. `orchestrator` names the component that ran the workflow;
// `providerId` names the provider the environment DECLARED could host it. The
// run's own claim is compared against that declaration separately, by
// executionIdentityFromRun, and never folded into it.
export function receiptEnvironment(env) {
  return {
    contract: ENVIRONMENT_CONTRACT_VERSION,
    environmentId: env.environmentId,
    kind: env.kind,
    providerId: env.providerId,
    orchestrator: { id: env.orchestrator.id, adapter: env.orchestrator.adapter },
  };
}
