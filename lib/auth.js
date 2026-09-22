// ---------------------------------------------------------------- P3B auth
//
// Inbound authentication at the plugin's own route boundary. This module owns
// exactly three decisions and nothing else:
//
//   1. Mode            — dev or required. Mode comes from CONFIG only, never
//                        from the request, never from an env var: a credential
//                        must not be able to lower the bar it is measured by.
//   2. Authentication  — does this request carry a credential that verifies
//                        against a declared principal? A verified credential
//                        establishes a PRINCIPAL. It does not, by itself,
//                        authorize anything.
//   3. Authorization   — is this principal allowed to act as this owner, on
//                        this environment, against this task? Three independent
//                        checks, always required mode, never derived from a
//                        caller-supplied field.
//
// Secrets: a principal declares a tokenVar — an env-var NAME, the same
// reference-not-value shape archon.tokenVar and dsh-credentials already use.
// The value is read from process.env at request time, compared with
// timingSafeEqual, and never returned, logged, echoed, or projected anywhere.
//
// The development loopback posture is PEER-address based (req.socket.remoteAddress),
// not Host-header based: the kernel-supplied peer cannot be forged by a request.
// Loopback is a local-development boundary, never production authentication —
// in required mode a token is still required even from 127.0.0.1.
//
// Import surface is node:crypto only, so lib/config.js can import the
// normalizers without a cycle.

import { createHash, timingSafeEqual } from 'node:crypto';

export const AUTH_CONTRACT_VERSION = 1;
export const AUTH_MODES = ['dev', 'required'];

// A principal id is a stable slug. Owner ids are already free-form strings
// throughout the store, so ownerIds accepts any non-empty string; environment
// ids are the stricter env-[a-z0-9-] shape environments.js already enforces.
const PRINCIPAL_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const ENV_ID_RE = /^env-[a-z0-9][a-z0-9-]{0,40}$/;
const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function aErr(key, message) {
  return { key, message };
}

// The refusals this module produces. They are TRANSPORT errors (HTTP 401/403),
// deliberately a third category: workspace refusals are 4xx-from-codes and goal
// refusals are 200-verdicts, but an authentication failure happens BEFORE any
// handler runs, so it can only be a transport refusal with zero orchestrator
// contact. Codes are stable strings the tests assert on.
export const AUTH_REFUSAL = {
  MISSING: 'authentication-required',
  MALFORMED: 'authentication-malformed',
  INVALID: 'authentication-invalid',
  REVOKED: 'authentication-revoked',
  IMPERSONATION: 'owner-impersonation-refused',
  // The environment check composes with the existing per-owner workspace scope
  // in environments.js: both must pass, so the code matches the existing
  // 'environment-unauthorized' refusal rather than inventing a second name.
  ENV_DENIED: 'environment-unauthorized',
  WORKSPACE_DENIED: 'cross-workspace-refused',
  TASK_DENIED: 'task-owner-mismatch',
  // A required-mode operation with no attributable owner: fail closed rather
  // than acting under an ambient identity.
  UNATTRIBUTED: 'owner-attribution-required',
  // The dev loopback boundary: a non-loopback peer in dev posture is refused
  // here, before any handler runs.
  DEV_BOUNDARY: 'dev-boundary-refused',
};

// Read a bearer credential from a request. Returns:
//   { present: false }            — no Authorization header, no bearer form
//   { present: true, malformed }  — header present but not a single bearer token
//   { present: true, token }      — a candidate token (NOT yet verified)
// The token is never logged and never placed on any object that is serialized.
export function readBearer(req) {
  const raw = req && req.headers ? req.headers.authorization : undefined;
  if (typeof raw !== 'string' || raw === '') return { present: false };
  const m = /^Bearer[ \t]+(\S+)$/i.exec(raw.trim());
  if (!m) return { present: true, malformed: true };
  return { present: true, token: m[1] };
}

// Constant-time string compare. Length is compared first (it is public shape,
// not secret content), then digest-vs-digest through timingSafeEqual so the
// comparison itself leaks no timing.
function secretEquals(a, b) {
  const ha = createHash('sha256').update(String(a), 'utf8').digest();
  const hb = createHash('sha256').update(String(b), 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

function principalById(config, id) {
  const auth = config && config.auth;
  if (!auth || !Array.isArray(auth.principals)) return null;
  return auth.principals.find((p) => p.id === id) || null;
}

// ------------------------------------------------------------ config normalizers
// Called from lib/config.js during resolveConfig, so the same INVALID-is-a-reported-state
// discipline applies: a malformed auth block degrades the WHOLE block to dev
// mode (fail closed toward openness only because dev is the pre-P3B posture
// every existing deployment is already running) and lands in `errors`.

export function normalizeAuth(raw) {
  const errors = [];
  if (raw === undefined || raw === null) {
    return { value: null, errors };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(aErr('auth', 'must be an object or null — auth block ignored (dev mode)'));
    return { value: null, errors };
  }
  const mode = raw.mode === undefined ? 'dev' : raw.mode;
  if (typeof mode !== 'string' || !AUTH_MODES.includes(mode)) {
    errors.push(aErr('auth.mode', 'must be "dev" or "required" — using dev'));
    return { value: null, errors };
  }
  const loopback = raw.loopback === undefined ? 'allow' : raw.loopback;
  if (loopback !== 'allow' && loopback !== 'deny') {
    errors.push(aErr('auth.loopback', 'must be "allow" or "deny" — using allow'));
    return { value: null, errors };
  }
  const principalsRaw = raw.principals === undefined ? [] : raw.principals;
  if (!Array.isArray(principalsRaw)) {
    errors.push(aErr('auth.principals', 'must be an array — auth block ignored (dev mode)'));
    return { value: null, errors };
  }
  const principals = [];
  const seen = new Set();
  for (let i = 0; i < principalsRaw.length; i++) {
    const p = principalsRaw[i];
    const at = 'auth.principals[' + i + ']';
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      errors.push(aErr(at, 'must be an object — principal dropped'));
      continue;
    }
    // The design doc names these principalId/ownerId (singular); the code
    // reads id/ownerIds (plural). Accept both so the documented config shape
    // verifies — the request body must never be a source of identity, but the
    // config file must accept what the design promises.
    const idRaw = typeof p.id === 'string' ? p.id
      : (typeof p.principalId === 'string' ? p.principalId : '');
    const id = idRaw.trim();
    if (!PRINCIPAL_ID_RE.test(id)) {
      errors.push(aErr(at + '.id', 'must be a slug /^[a-z0-9][a-z0-9-]{0,40}$/ — principal dropped'));
      continue;
    }
    if (seen.has(id)) {
      errors.push(aErr(at + '.id', 'duplicate principal id "' + id + '" — principal dropped'));
      continue;
    }
    const tokenVar = p.tokenVar === undefined ? null : p.tokenVar;
    if (tokenVar !== null && !(typeof tokenVar === 'string' && ENV_VAR_RE.test(tokenVar))) {
      errors.push(aErr(at + '.tokenVar', 'must be an env-var NAME (or null) — never a secret value — principal dropped'));
      continue;
    }
    const revoked = p.revoked === true;
    const ownerIdsRaw = Array.isArray(p.ownerIds) ? p.ownerIds
      : (typeof p.ownerId === 'string' ? [p.ownerId] : []);
    const ownerIds = ownerIdsRaw
      .filter((o) => typeof o === 'string' && o.trim() !== '')
      .map((o) => o.trim());
    const environmentIds = Array.isArray(p.environmentIds)
      ? p.environmentIds.filter((e) => typeof e === 'string' && ENV_ID_RE.test(e))
      : null; // null = no environment restriction declared (the per-owner scope still applies)
    seen.add(id);
    principals.push({ id, tokenVar, revoked, ownerIds, environmentIds });
  }
  // required mode with no usable principal means every request would be
  // refused forever — that is a config ERROR worth reporting, not a silent
  // lockdown. The block still normalizes: mode stays as declared so the
  // operator sees their own intent refuse loudly.
  if (mode === 'required' && principals.length === 0) {
    errors.push(aErr('auth.principals', 'required mode declares no valid principals — every request will be refused'));
  }
  return { value: { mode, loopback, principals }, errors };
}

export function normalizeTrustedProxy(raw) {
  const errors = [];
  if (raw === undefined || raw === null) {
    return { value: null, errors };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(aErr('trustedProxy', 'must be an object or null — block ignored (no proxy trust)'));
    return { value: null, errors };
  }
  const addresses = Array.isArray(raw.addresses)
    ? raw.addresses.filter((a) => typeof a === 'string' && a.trim() !== '')
    : [];
  if (addresses.length === 0) {
    errors.push(aErr('trustedProxy.addresses', 'must be a non-empty array of peer addresses — block ignored (no proxy trust)'));
    return { value: null, errors };
  }
  const header = raw.header === undefined ? 'x-forwarded-for' : raw.header;
  if (typeof header !== 'string' || !/^[a-z0-9-]+$/.test(header)) {
    errors.push(aErr('trustedProxy.header', 'must be a lowercase header name — using x-forwarded-for'));
  }
  return {
    value: { addresses, header: typeof header === 'string' && /^[a-z0-9-]+$/.test(header) ? header : 'x-forwarded-for' },
    errors,
  };
}

// ------------------------------------------------------------ peer resolution
// The genuine peer, as the kernel reports it. X-forwarded-for is honored ONLY
// when the immediate peer is a declared trusted proxy, and default-OFF: an
// untrusted peer supplying its own XFF must never be believed.

function normalizeIp(ip) {
  if (typeof ip !== 'string' || ip === '') return null;
  // node reports IPv4-mapped IPv6 for dual-stack listeners (::ffff:127.0.0.1)
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1];
  return ip;
}

export function isLoopbackAddress(ip) {
  const v = normalizeIp(ip);
  if (!v) return false;
  if (v === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v);
}

export function peerAddress(req, config) {
  const immediate = normalizeIp(req && req.socket ? req.socket.remoteAddress : null);
  const trusted = config && config.trustedProxy;
  if (trusted && immediate && trusted.addresses.includes(immediate)) {
    const header = req.headers[trusted.header];
    const first = typeof header === 'string' ? header.split(',')[0].trim() : '';
    const fromProxy = normalizeIp(first);
    // The proxy is trusted, so its leftmost XFF entry is the client it saw.
    if (fromProxy) return { address: fromProxy, viaProxy: true, immediate };
  }
  return { address: immediate, viaProxy: false, immediate };
}

// ------------------------------------------------------------ authentication

// Establish a principal for a request, or refuse it. Never throws — returns a
// decision object the chokepoint turns into a transport refusal:
//
//   { ok: true,  mode: 'dev'|'required', principal: <object|null>, peer }
//   { ok: false, code, status, error }
//
// dev mode: no credential is checked; principal is null and downstream
// authorization checks are skipped (byte-for-byte preservation of the
// pre-P3B path — owner fields behave exactly as before).
// required mode: a verified, non-revoked principal is mandatory, including
// from loopback. Loopback in required mode is NOT authentication.
export function authenticateRequest(req, config) {
  const auth = config && config.auth ? config.auth : null;
  const peer = peerAddress(req, config);
  const mode = auth && auth.mode === 'required' ? 'required' : 'dev';

  if (mode === 'dev') {
    // Dev posture: no credential is checked, but the loopback boundary is
    // enforced. A peer the kernel does not report as loopback is refused here,
    // before any handler runs. 'deny' loopback config refuses even loopback
    // peers (a locked-down dev box); 'allow' admits only genuine loopback.
    const loopback = (auth && auth.loopback) || 'allow';
    if (!peer.address || !isLoopbackAddress(peer.address) || loopback === 'deny') {
      return {
        ok: false,
        code: AUTH_REFUSAL.DEV_BOUNDARY,
        status: 401,
        error: !peer.address
          ? 'refused: no peer address available to evaluate the development boundary'
          : 'refused: development posture serves loopback peers only',
      };
    }
    return { ok: true, mode: 'dev', principal: null, peer };
  }

  // ---- required mode from here ----
  if (!peer.address) {
    // The development boundary could not be established: no peer address is
    // available on this socket, so we cannot even report where it came from.
    return {
      ok: false,
      code: AUTH_REFUSAL.MISSING,
      status: 401,
      error: 'authentication required: no peer address available to evaluate the development boundary',
    };
  }

  const bearer = readBearer(req);
  if (!bearer.present || bearer.malformed) {
    return {
      ok: false,
      code: bearer.present ? AUTH_REFUSAL.MALFORMED : AUTH_REFUSAL.MISSING,
      status: 401,
      error: bearer.present
        ? 'authentication failed: Authorization header must be a single "Bearer <token>" value'
        : 'authentication required: no bearer credential supplied',
    };
  }

  // Verify against every declared principal. A token that matches no
  // principal is invalid; a tokenVar whose env var is unset means that
  // principal cannot authenticate right now (its credential is absent, not
  // wrong) — reported as invalid so no oracle distinguishes the two.
  let matched = null;
  let sawRevoked = false;
  for (const p of auth.principals) {
    if (!p.tokenVar) continue;
    const expected = process.env[p.tokenVar];
    if (typeof expected !== 'string' || expected === '') continue;
    if (!secretEquals(bearer.token, expected)) continue;
    // Exact token match. Revocation is checked AFTER the match so a revoked
    // principal's token is recognized as belonging to THAT principal (a
    // distinct, honest refusal) rather than collapsing into invalid.
    matched = p;
    break;
  }
  if (!matched) {
    return {
      ok: false,
      code: AUTH_REFUSAL.INVALID,
      status: 401,
      error: 'authentication failed: credential does not verify against any declared principal',
    };
  }
  if (matched.revoked) {
    return {
      ok: false,
      code: AUTH_REFUSAL.REVOKED,
      status: 401,
      error: 'authentication failed: principal "' + matched.id + '" is revoked',
    };
  }

  return { ok: true, mode: 'required', principal: matched, peer };
}

// ------------------------------------------------------------ authorization
// All three run ONLY in required mode (principal non-null). In dev they return
// the untouched value so the existing path is byte-for-byte identical.

// (1) principal -> owner. The caller-supplied owner is REPLACED when absent
// and VERIFIED when present: a principal can never act as an owner it does not
// hold, and supplying someone else's id is refused rather than silently
// ignored (the refusal is the test's assertion point).
export function ownerForRequest({ principal, owner, code }) {
  if (!principal) return { ok: true, owner };
  const owners = principal.ownerIds || [];
  const supplied = typeof owner === 'string' && owner.trim() !== '' ? owner.trim() : null;
  if (supplied === null) {
    // No owner supplied: the principal's single owner becomes the identity.
    // Multiple owners and no supplied owner is ambiguous — refuse rather than
    // pick, because picking would grant authority the caller did not name.
    if (owners.length === 1) return { ok: true, owner: owners[0] };
    return {
      ok: false,
      code: AUTH_REFUSAL.UNATTRIBUTED,
      status: 403,
      error: 'owner attribution required: principal "' + principal.id + '" holds ' + owners.length + ' owners and the owner field was not supplied',
    };
  }
  if (!owners.includes(supplied)) {
    return {
      ok: false,
      code: AUTH_REFUSAL.IMPERSONATION,
      status: 403,
      error: 'owner impersonation refused: principal "' + principal.id + '" is not authorized to act as the owner named in the owner field',
    };
  }
  return { ok: true, owner: supplied };
}

// (2) principal -> environment. Independent of the per-owner workspace scope
// environments.js already enforces: this answers "may this principal touch
// this environment AT ALL", while environmentAllowsOwner answers "may this
// owner use it". A declared environmentIds of null means no extra restriction.
export function environmentAllowedForPrincipal({ principal, environmentId }) {
  if (!principal) return { ok: true };
  const allowed = principal.environmentIds;
  if (allowed === null || allowed === undefined) return { ok: true };
  if (typeof environmentId === 'string' && allowed.includes(environmentId)) return { ok: true };
  return {
    ok: false,
    code: AUTH_REFUSAL.ENV_DENIED,
    status: 403,
    error: 'principal "' + principal.id + '" is not authorized for environment "' + String(environmentId) + '"',
  };
}

// (3) principal -> a specific stored resource. The stored record's owner is
// the truth (never the caller's field): a principal may read/act on a task or
// workspace only when the record itself belongs to one of its owners. An
// unattributed record (null owner) is fail-closed in required mode: legacy
// rows with no owner cannot be reached by any principal.
export function taskAuthorizedForPrincipal({ principal, recordOwner, code, label }) {
  if (!principal) return { ok: true };
  const owners = principal.ownerIds || [];
  const owner = typeof recordOwner === 'string' && recordOwner.trim() !== '' ? recordOwner.trim() : null;
  if (owner && owners.includes(owner)) return { ok: true };
  if (!owner) {
    return {
      ok: false,
      code: AUTH_REFUSAL.UNATTRIBUTED,
      status: 403,
      error: 'owner attribution required: principal "' + principal.id + '" cannot act on an unattributed ' + (label || 'resource'),
    };
  }
  return {
    ok: false,
    code: code || AUTH_REFUSAL.TASK_DENIED,
    status: 403,
    error: 'principal "' + principal.id + '" is not authorized for ' + (label || 'this resource') +
      ' (owner "' + owner + '")',
  };
}

// ------------------------------------------------------------- public projection
// What /environments reports about auth: mode, loopback posture, principal
// COUNT and ids, and per-principal token PRESENCE booleans — the exact
// tokenConfigured precedent from archon.tokenVar. No tokenVar value, no token,
// no ownerIds is exposed here beyond the ids the operator configured.

export function publicAuth(config) {
  const auth = config && config.auth ? config.auth : null;
  if (!auth) {
    return { contract: AUTH_CONTRACT_VERSION, mode: 'dev', loopback: 'allow', principals: [] };
  }
  return {
    contract: AUTH_CONTRACT_VERSION,
    mode: auth.mode,
    loopback: auth.loopback,
    principals: auth.principals.map((p) => ({
      id: p.id,
      revoked: p.revoked,
      tokenVar: p.tokenVar,
      tokenConfigured: p.tokenVar ? !!process.env[p.tokenVar] : null,
      owners: (p.ownerIds || []).length,
      environments: p.environmentIds === null ? null : p.environmentIds.length,
    })),
  };
}
