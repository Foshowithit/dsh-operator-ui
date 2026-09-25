// P3B inbound-authentication negatives — the PARENT half.
//
// Two layers, one file:
//
//   1. UNIT: lib/auth.js decisions against synthetic requests — the peer matrix
//      (loopback, mapped-IPv4, missing, proxied), the credential matrix (missing,
//      malformed, invalid, revoked, unset-tokenVar), the config normalizers, and
//      the public projection. These run in-process because they are pure.
//
//   2. E2E: the same harness as environments-negative.test.mjs — a mock archon
//      with call counters, a child process per case booting the real plugin
//      surface with a real operator-ui.config.json, and CALL DELTAS proving that
//      refused requests cost the orchestrator literally nothing.
//
// The zero-side-effect claim is the point of this file. An authentication or
// authorization refusal that touches the orchestrator before refusing is a
// breach with extra steps; every refusal case below asserts an all-zero delta.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// --------------------------------------------------------------- mock lifecycle
//
// The mock binds an OS-assigned ephemeral port, never a hardcoded 137xx, so two
// concurrent runs of this file (or this file beside any other) cannot collide
// on a port. Binding :0 only PROBES for a free port: the kernel releases it the
// instant we close, so a sibling process can steal it before the mock child
// binds. startMock() treats a failed start as a lost race and retries on a
// fresh port rather than trusting the probed number.
async function freePort() {
  const srv = createServer();
  await new Promise((res, rej) => { srv.once('error', rej); srv.listen(0, '127.0.0.1', res); });
  const { port } = srv.address();
  await new Promise((res) => srv.close(res));
  return port;
}

async function startMock({ attempts = 6, readyTimeoutMs = 5000 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = await freePort();
    const base = 'http://127.0.0.1:' + port;
    const proc = spawn(process.execPath, [join(ROOT, 'scripts', 'mock-archon.mjs'), String(port)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    let exited = null;
    proc.on('exit', (code) => { exited = code; });
    const deadline = Date.now() + readyTimeoutMs;
    let ready = false;
    for (;;) {
      if (exited !== null) {
        lastErr = new Error('mock archon exited (' + exited + ') before binding :' + port +
          ' — the probed port was taken before the bind' + (stderr ? ': ' + stderr.trim().split('\n')[0] : ''));
        break;
      }
      try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {}
      if (Date.now() > deadline) { lastErr = new Error('mock archon never answered on :' + port + ' within ' + readyTimeoutMs + 'ms'); break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (ready && exited === null) return { proc, port, base };
    if (ready) lastErr = new Error('mock archon on :' + port + ' exited right after answering');
    try { proc.kill('SIGKILL'); } catch {}
  }
  throw new Error('could not start a mock archon after ' + attempts + ' attempts: ' + (lastErr ? lastErr.message : 'unknown'));
}

let mockProc;
// Acquire the port and prove the mock is live BEFORE any config or case code can
// observe BASE (REQUIRED_CONFIG below reads BASE at module-eval time). No hard-fail
// guard survives: with an ephemeral port there is nothing to collide with, and
// startMock()'s retry absorbs the only remaining race (a sibling stealing the
// probed port).
const mock = await startMock();
const BASE = mock.base;
mockProc = mock.proc;

// ----------------------------------------------------------------- unit imports

const authUrl = pathToFileURL(join(ROOT, 'lib', 'auth.js')).href;
const { readBearer, normalizeAuth, normalizeTrustedProxy, isLoopbackAddress, peerAddress, authenticateRequest, ownerForRequest, environmentAllowedForPrincipal, taskAuthorizedForPrincipal, publicAuth, AUTH_REFUSAL, AUTH_CONTRACT_VERSION } = await import(authUrl);

const configUrl = pathToFileURL(join(ROOT, 'lib', 'config.js')).href;
const { resolveConfig, redactedConfig } = await import(configUrl);

// The same single-capability registry the other E2E files use.
const REGISTRY = {
  capabilities: [
    {
      id: 'verify-echo',
      objective: 'verify echo running total seed values',
      workflow: 'verify-echo-v1',
      tags: ['verify', 'echo', 'running', 'total', 'seed', 'values'],
      requires: ['shell:execute'],
      verification: { terminalStatus: 'completed', expectOutput: 'rcos-verify-seed:rcos-verify-echo-v1' },
      objectiveEvaluation: { kind: 'output-contains', value: 'rcos-verify-seed:rcos-verify-echo-v1' },
    },
  ],
};

const TOKENS = {
  root: 'e2e-root-token-4f19ab',
  alice: 'e2e-alice-token-9d72c3',
  bob: 'e2e-bob-token-1a55e8',
  gone: 'e2e-revoked-token-77b0d4',
  // A credential that verifies against NO principal — never configured anywhere.
  wrong: 'e2e-wrong-token-0c0ffe',
};

const TOKEN_VARS = {
  root: 'AUTH_ROOT_TOKEN',
  alice: 'AUTH_ALICE_TOKEN',
  bob: 'AUTH_BOB_TOKEN',
  gone: 'AUTH_GONE_TOKEN',
  unset: 'AUTH_UNSET_TOKEN',
};

// required-mode config: five principals covering the whole decision matrix —
// multi-owner unrestricted, single-owner environment-scoped, single-owner
// unrestricted, revoked, and declared-but-unset credential.
const REQUIRED_CONFIG = {
  auth: {
    mode: 'required',
    loopback: 'allow',
    principals: [
      { id: 'svc-root', tokenVar: TOKEN_VARS.root, ownerIds: ['alice', 'bob'] },
      { id: 'svc-alice', tokenVar: TOKEN_VARS.alice, ownerIds: ['alice'], environmentIds: ['env-local'] },
      { id: 'svc-bob', tokenVar: TOKEN_VARS.bob, ownerIds: ['bob'] },
      { id: 'svc-gone', tokenVar: TOKEN_VARS.gone, ownerIds: ['alice'], revoked: true },
      { id: 'svc-unset', tokenVar: TOKEN_VARS.unset, ownerIds: ['alice'] },
    ],
  },
  environments: {
    defaultId: 'env-local',
    list: [
      {
        environmentId: 'env-remote',
        kind: 'custom-remote',
        providerId: 'archon-remote',
        adapter: { kind: 'archon-http', transport: { baseUrl: BASE, timeoutMs: 5000 } },
      },
    ],
  },
};

const archonHttp = (providerId, extra = {}) => ({
  kind: 'custom-remote',
  providerId,
  adapter: { kind: 'archon-http', transport: { baseUrl: BASE, timeoutMs: 5000, ...(extra.transport || {}) } },
  ...extra,
});

const DEV_CONFIG = {
  environments: {
    defaultId: 'env-local',
    list: [archonHttp('archon-remote', { environmentId: 'env-remote' })],
  },
};

// ----------------------------------------------------------------- unit helpers

const reqOf = (headers, remoteAddress) => ({ headers: headers || {}, socket: { remoteAddress } });

// ----------------------------------------------------------------- UNIT: bearer parsing

test('readBearer: absent, malformed, and well-formed bearer credentials', () => {
  assert.deepEqual(readBearer(reqOf({}), null), { present: false }, 'no header is absent, not malformed');
  assert.deepEqual(readBearer(reqOf({ authorization: '' })), { present: false });
  assert.deepEqual(readBearer(reqOf({ authorization: 'Basic abc' })), { present: true, malformed: true }, 'non-bearer scheme is malformed, not missing');
  assert.deepEqual(readBearer(reqOf({ authorization: 'Bearer' })), { present: true, malformed: true }, 'a bare word is malformed');
  assert.deepEqual(readBearer(reqOf({ authorization: 'Bearer   ' })), { present: true, malformed: true }, 'an empty credential is malformed');
  assert.deepEqual(readBearer(reqOf({ authorization: 'Bearer abc def' })), { present: true, malformed: true }, 'two tokens in one header is malformed');
  const ok = readBearer(reqOf({ authorization: 'Bearer tok-1' }));
  assert.deepEqual(ok, { present: true, token: 'tok-1' });
  assert.equal(readBearer(reqOf({ authorization: 'bearer tok-2' })).token, 'tok-2', 'the scheme is case-insensitive, the token is not touched');
});

// ----------------------------------------------------------------- UNIT: config normalizers

test('normalizeAuth: a valid block survives, with ownerId singular accepted', () => {
  const r = normalizeAuth({
    mode: 'required',
    loopback: 'deny',
    principals: [
      { id: 'p1', tokenVar: 'T_ONE', ownerIds: ['a', 'b'], environmentIds: ['env-x'] },
      { principalId: 'p2-alias', ownerId: 'solo', tokenVar: null },
    ],
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.value.mode, 'required');
  assert.equal(r.value.loopback, 'deny');
  assert.equal(r.value.principals.length, 2);
  assert.deepEqual(r.value.principals[0], { id: 'p1', tokenVar: 'T_ONE', revoked: false, ownerIds: ['a', 'b'], environmentIds: ['env-x'] });
  assert.deepEqual(r.value.principals[1], { id: 'p2-alias', tokenVar: null, revoked: false, ownerIds: ['solo'], environmentIds: null }, 'the documented singular names verify; null environmentIds means unrestricted');
});

test('normalizeAuth: malformed blocks degrade to dev mode with reported errors, never a boot failure', () => {
  assert.deepEqual(normalizeAuth(undefined), { value: null, errors: [] });
  const notObject = normalizeAuth('required');
  assert.equal(notObject.value, null);
  assert.equal(notObject.errors.length, 1);

  const badMode = normalizeAuth({ mode: 'yolo', principals: [{ id: 'p1', tokenVar: 'T' }] });
  assert.equal(badMode.value, null, 'a bad mode drops the whole block: dev is the pre-P3B posture');
  assert.ok(badMode.errors[0].key.startsWith('auth.mode'));

  const badLoopback = normalizeAuth({ mode: 'dev', loopback: 'maybe', principals: [] });
  assert.equal(badLoopback.value, null);
  assert.ok(badLoopback.errors[0].key.startsWith('auth.loopback'));

  const badPrincipals = normalizeAuth({ mode: 'required', principals: 'p1' });
  assert.equal(badPrincipals.value, null);
  assert.ok(badPrincipals.errors[0].key.startsWith('auth.principals'));

  const badTokenVar = normalizeAuth({ mode: 'required', principals: [{ id: 'p1', tokenVar: 'sk-live-secret-value' }] });
  assert.equal(badTokenVar.value.principals.length, 0, 'a tokenVar that is a secret VALUE drops the principal');
  assert.ok(badTokenVar.errors[0].message.includes('never a secret value'));

  const badId = normalizeAuth({ mode: 'required', principals: [{ id: 'Bad Id!', tokenVar: 'T' }] });
  assert.equal(badId.value.principals.length, 0);
  assert.ok(badId.errors[0].key.endsWith('.id'));

  const dup = normalizeAuth({ mode: 'required', principals: [{ id: 'p1', tokenVar: 'T' }, { id: 'p1', tokenVar: 'T2' }] });
  assert.equal(dup.value.principals.length, 1, 'a duplicate id drops the later principal');
  assert.equal(dup.value.principals[0].tokenVar, 'T');
  assert.equal(dup.errors.length, 1);

  const emptyRequired = normalizeAuth({ mode: 'required', principals: [] });
  assert.equal(emptyRequired.value.mode, 'required', 'the declared mode is kept so the operator sees their own intent refuse loudly');
  assert.equal(emptyRequired.errors.length, 1, 'and the config error names what will happen');

  const envFilter = normalizeAuth({ mode: 'dev', principals: [{ id: 'p1', tokenVar: 'T', environmentIds: ['env-ok', 'nope', 42] }] });
  assert.deepEqual(envFilter.value.principals[0].environmentIds, ['env-ok'], 'malformed environment ids are filtered, not fatal');
});

test('normalizeTrustedProxy: default-off, header sanity, empty means ignored', () => {
  assert.deepEqual(normalizeTrustedProxy(undefined), { value: null, errors: [] });
  const bad = normalizeTrustedProxy('yes');
  assert.equal(bad.value, null);
  const empty = normalizeTrustedProxy({ addresses: [] });
  assert.equal(empty.value, null, 'an empty address list trusts no one');
  assert.equal(empty.errors.length, 1);
  const ok = normalizeTrustedProxy({ addresses: ['10.0.0.9'], header: 'x-real-ip' });
  assert.deepEqual(ok.value, { addresses: ['10.0.0.9'], header: 'x-real-ip' });
  assert.deepEqual(ok.errors, []);
  const defHeader = normalizeTrustedProxy({ addresses: ['10.0.0.9'] });
  assert.equal(defHeader.value.header, 'x-forwarded-for');
});

// ----------------------------------------------------------------- UNIT: peer resolution

test('isLoopbackAddress: v4, v6, mapped-v4, and the things that are not loopback', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.8.8.8'), true, 'the whole 127/8 is loopback');
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true, 'dual-stack listeners report mapped addresses');
  assert.equal(isLoopbackAddress('::ffff:203.0.113.5'), false, 'a mapped PUBLIC address is not loopback');
  assert.equal(isLoopbackAddress('203.0.113.5'), false);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1)'), false);
  assert.equal(isLoopbackAddress(''), false);
  assert.equal(isLoopbackAddress(null), false);
  assert.equal(isLoopbackAddress('127.0.0.1.evil.example'), false);
});

test('peerAddress: the kernel peer is the truth; XFF is believed only through a declared proxy', () => {
  const noProxy = peerAddress(reqOf({ 'x-forwarded-for': '203.0.113.5' }, '127.0.0.1'), null);
  assert.equal(noProxy.address, '127.0.0.1', 'no trustedProxy declared: XFF is ignored, spoof dead');
  assert.equal(noProxy.viaProxy, false);

  const untrusted = peerAddress(
    reqOf({ 'x-forwarded-for': '127.0.0.1' }, '203.0.113.5'),
    { trustedProxy: { addresses: ['10.0.0.9'], header: 'x-forwarded-for' } },
  );
  assert.equal(untrusted.address, '203.0.113.5', 'an untrusted peer claiming loopback XFF is NOT believed — it is refused as itself');

  const trusted = peerAddress(
    reqOf({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, '10.0.0.9'),
    { trustedProxy: { addresses: ['10.0.0.9'], header: 'x-forwarded-for' } },
  );
  assert.equal(trusted.address, '203.0.113.5', 'a trusted proxy makes its leftmost XFF entry the client');
  assert.equal(trusted.viaProxy, true);
  assert.equal(trusted.immediate, '10.0.0.9');

  const customHeader = peerAddress(reqOf({ 'x-real-ip': '198.51.100.7' }, '10.0.0.9'), { trustedProxy: { addresses: ['10.0.0.9'], header: 'x-real-ip' } });
  assert.equal(customHeader.address, '198.51.100.7');

  const mapped = peerAddress(reqOf({}, '::ffff:127.0.0.1'), null);
  assert.equal(mapped.address, '127.0.0.1', 'mapped-v4 normalizes before any comparison');

  const absent = peerAddress(reqOf({}, null), null);
  assert.equal(absent.address, null, 'no peer address is reported as absent, never guessed');
});

// ----------------------------------------------------------------- UNIT: the decision matrix

const REQUIRED = { auth: normalizeAuth(JSON.parse(JSON.stringify(REQUIRED_CONFIG.auth))).value, trustedProxy: null };
const DEVA = { auth: null, trustedProxy: null };
const DEV_DENY = { auth: { mode: 'dev', loopback: 'deny', principals: [] }, trustedProxy: null };

// The unit process intentionally boots with NO token env (publicAuth below must
// see honest absence). The credential tests set exactly the vars they need for
// their duration and remove them again — TOKEN_VARS.unset is never set.
const withTokenEnv = async (names, run) => {
  const vars = names.map((n) => TOKEN_VARS[n]);
  for (let i = 0; i < names.length; i++) process.env[vars[i]] = TOKENS[names[i]];
  try {
    await run();
  } finally {
    for (const v of vars) delete process.env[v];
  }
};

test('authenticateRequest, dev mode: loopback passes with no principal; everything else fails closed', () => {
  const ok = authenticateRequest(reqOf({}, '127.0.0.1'), DEVA);
  assert.deepEqual({ ok: ok.ok, mode: ok.mode, principal: ok.principal }, { ok: true, mode: 'dev', principal: null });

  const mapped = authenticateRequest(reqOf({}, '::ffff:127.0.0.1'), DEVA);
  assert.equal(mapped.ok, true);

  const external = authenticateRequest(reqOf({}, '203.0.113.5'), DEVA);
  assert.deepEqual({ ok: external.ok, code: external.code, status: external.status }, { ok: false, code: AUTH_REFUSAL.DEV_BOUNDARY, status: 401 });

  const absent = authenticateRequest(reqOf({}, null), DEVA);
  assert.equal(absent.code, AUTH_REFUSAL.DEV_BOUNDARY, 'no peer address cannot establish the development boundary: fail closed');
  assert.equal(absent.status, 401);

  // A presented credential in dev mode is decoration: it changes nothing and
  // yields no principal.
  const decorated = authenticateRequest(reqOf({ authorization: 'Bearer ' + TOKENS.alice }, '127.0.0.1'), DEVA);
  assert.deepEqual({ ok: decorated.ok, principal: decorated.principal }, { ok: true, principal: null });

  const denied = authenticateRequest(reqOf({}, '127.0.0.1'), DEV_DENY);
  assert.equal(denied.code, AUTH_REFUSAL.DEV_BOUNDARY, 'loopback deny locks even loopback out of dev posture');

  const proxied = authenticateRequest(reqOf({ 'x-forwarded-for': '127.0.0.1' }, '203.0.113.5'), DEVA);
  assert.equal(proxied.code, AUTH_REFUSAL.DEV_BOUNDARY, 'XFF spoofing cannot buy the dev boundary');
});

test('authenticateRequest, required mode: the four credential refusals, and loopback is not authentication', async () => {
  await withTokenEnv(['gone'], () => {
    const missing = authenticateRequest(reqOf({}, '127.0.0.1'), REQUIRED);
    assert.deepEqual({ ok: missing.ok, code: missing.code, status: missing.status }, { ok: false, code: AUTH_REFUSAL.MISSING, status: 401 });

    const malformed = authenticateRequest(reqOf({ authorization: 'Basic ' + TOKENS.alice }, '127.0.0.1'), REQUIRED);
    assert.equal(malformed.code, AUTH_REFUSAL.MALFORMED);
    assert.equal(malformed.status, 401);

    const invalid = authenticateRequest(reqOf({ authorization: 'Bearer ' + TOKENS.wrong }, '127.0.0.1'), REQUIRED);
    assert.equal(invalid.code, AUTH_REFUSAL.INVALID);
    assert.equal(invalid.status, 401);

    const revoked = authenticateRequest(reqOf({ authorization: 'Bearer ' + TOKENS.gone }, '127.0.0.1'), REQUIRED);
    assert.deepEqual({ ok: revoked.ok, code: revoked.code }, { ok: false, code: AUTH_REFUSAL.REVOKED }, 'a revoked credential is RECOGNIZED, then refused as revoked — honest, not collapsed into invalid');

    // Loopback buys NOTHING in required mode: same refusals from 127.0.0.1 as
    // from anywhere else.
    assert.equal(authenticateRequest(reqOf({}, '10.1.2.3'), REQUIRED).code, AUTH_REFUSAL.MISSING, 'external peer, missing credential: same refusal');
  });
});

test('authenticateRequest, required mode: verification succeeds and establishes exactly the matching principal', async () => {
  await withTokenEnv(['alice', 'bob', 'root'], () => {
    const viaLoopback = authenticateRequest(reqOf({ authorization: 'Bearer ' + TOKENS.alice }, '127.0.0.1'), REQUIRED);
    assert.equal(viaLoopback.ok, true, 'a valid credential authenticates from loopback — loopback is a dev posture, never a credential substitute');
    assert.equal(viaLoopback.principal.id, 'svc-alice');
    assert.equal(viaLoopback.mode, 'required');

    const viaExternal = authenticateRequest(reqOf({ authorization: 'Bearer ' + TOKENS.bob }, '203.0.113.5'), REQUIRED);
    assert.equal(viaExternal.ok, true, 'authentication is credential-based: an external peer with a valid credential authenticates');
    assert.equal(viaExternal.principal.id, 'svc-bob');

    const viaProxy = authenticateRequest(
      reqOf({ 'x-forwarded-for': '203.0.113.5', authorization: 'Bearer ' + TOKENS.root }, '10.0.0.9'),
      { auth: REQUIRED.auth, trustedProxy: { addresses: ['10.0.0.9'], header: 'x-forwarded-for' } },
    );
    assert.equal(viaProxy.ok, true);
    assert.equal(viaProxy.principal.id, 'svc-root');
    assert.equal(viaProxy.peer.address, '203.0.113.5');

    const noPeer = authenticateRequest(reqOf({ authorization: 'Bearer ' + TOKENS.alice }, null), REQUIRED);
    assert.equal(noPeer.ok, false, 'fail closed: without a peer address even a valid credential is refused — the dev boundary cannot be established reliably');
    assert.equal(noPeer.status, 401);

    const unsetVar = authenticateRequest(reqOf({ authorization: 'Bearer ' + TOKENS.alice + 'x' }, '127.0.0.1'), REQUIRED);
    assert.equal(unsetVar.code, AUTH_REFUSAL.INVALID, 'a token matching no declared principal is invalid; the unset-tokenVar principal contributes nothing');
  });
});

// ----------------------------------------------------------------- UNIT: authorization decisions

test('ownerForRequest: principal establishes identity; the owner field is verified or replaced, never trusted', () => {
  const noPrincipal = ownerForRequest({ principal: null, owner: 'whoever' });
  assert.deepEqual(noPrincipal, { ok: true, owner: 'whoever' }, 'dev mode: byte-for-byte passthrough');

  const alice = { id: 'svc-alice', ownerIds: ['alice'] };
  const implied = ownerForRequest({ principal: alice, owner: undefined });
  assert.deepEqual(implied, { ok: true, owner: 'alice' }, 'omitted owner resolves to the single owner');
  const trimmed = ownerForRequest({ principal: alice, owner: '  alice  ' });
  assert.deepEqual(trimmed, { ok: true, owner: 'alice' });

  const impersonation = ownerForRequest({ principal: alice, owner: 'bob' });
  assert.equal(impersonation.ok, false);
  assert.equal(impersonation.code, AUTH_REFUSAL.IMPERSONATION);
  assert.equal(impersonation.status, 403);

  const root = { id: 'svc-root', ownerIds: ['alice', 'bob'] };
  const named = ownerForRequest({ principal: root, owner: 'bob' });
  assert.deepEqual(named, { ok: true, owner: 'bob' }, 'one of its own owners, named: allowed');
  const ambiguous = ownerForRequest({ principal: root, owner: undefined });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, AUTH_REFUSAL.UNATTRIBUTED, 'two owners and no name is ambiguous: refuse rather than pick');
  assert.equal(ambiguous.status, 403);
});

test('environment and record authorization: independent of the request, stored owner is the truth', () => {
  const scoped = { id: 'svc-alice', ownerIds: ['alice'], environmentIds: ['env-local'] };
  assert.deepEqual(environmentAllowedForPrincipal({ principal: scoped, environmentId: 'env-local' }), { ok: true });
  const denied = environmentAllowedForPrincipal({ principal: scoped, environmentId: 'env-remote' });
  assert.equal(denied.code, AUTH_REFUSAL.ENV_DENIED);
  assert.equal(denied.status, 403);
  const unrestricted = { id: 'svc-root', ownerIds: ['alice'], environmentIds: null };
  assert.deepEqual(environmentAllowedForPrincipal({ principal: unrestricted, environmentId: 'env-remote' }), { ok: true }, 'null environmentIds is no extra restriction');

  // taskAuthorizedForPrincipal: the RECORD's owner decides.
  const bob = { id: 'svc-bob', ownerIds: ['bob'] };
  const onAlice = taskAuthorizedForPrincipal({ principal: bob, recordOwner: 'alice', label: 'task-1' });
  assert.equal(onAlice.ok, false);
  assert.equal(onAlice.code, AUTH_REFUSAL.TASK_DENIED);
  const onOwn = taskAuthorizedForPrincipal({ principal: bob, recordOwner: 'bob', label: 'task-2' });
  assert.deepEqual(onOwn, { ok: true });
  const onUnattributed = taskAuthorizedForPrincipal({ principal: bob, recordOwner: null, label: 'task-3' });
  assert.equal(onUnattributed.ok, false, 'an unattributed record is fail-closed in required mode');
  assert.equal(onUnattributed.code, AUTH_REFUSAL.UNATTRIBUTED);
  const devPassthrough = taskAuthorizedForPrincipal({ principal: null, recordOwner: 'alice', label: 'task-4' });
  assert.deepEqual(devPassthrough, { ok: true }, 'dev mode: no record checks at all');
});

// ----------------------------------------------------------------- UNIT: public projection

test('publicAuth: posture and presence only — never a credential value', () => {
  const proj = publicAuth({ auth: REQUIRED.auth });
  assert.equal(proj.contract, AUTH_CONTRACT_VERSION);
  assert.equal(proj.mode, 'required');
  assert.equal(proj.loopback, 'allow');
  const byId = Object.fromEntries(proj.principals.map((p) => [p.id, p]));
  assert.equal(byId['svc-root'].tokenConfigured, false, 'unit process has no token vars set: presence is honest');
  assert.equal(byId['svc-unset'].tokenConfigured, false);
  assert.equal(byId['svc-gone'].revoked, true);
  assert.equal(byId['svc-root'].owners, 2);
  assert.equal(byId['svc-alice'].environments, 1);
  const text = JSON.stringify(proj);
  for (const t of Object.values(TOKENS)) assert.equal(text.includes(t), false, 'no token VALUE may appear in the projection');
  assert.deepEqual(publicAuth({}), { contract: AUTH_CONTRACT_VERSION, mode: 'dev', loopback: 'allow', principals: [] }, 'no auth block: the dev posture is reported');
});

// ----------------------------------------------------------------- UNIT: config integration

test('resolveConfig: the auth block round-trips through a real config file; malformed degrades with reported errors; redaction excludes auth', async () => {
  const home = await mkdtemp(join(tmpdir(), 'p3b-config-'));
  try {
    await writeFile(join(home, 'operator-ui.config.json'), JSON.stringify({ auth: REQUIRED_CONFIG.auth, environments: REQUIRED_CONFIG.environments }));
    const resolved = resolveConfig(home);
    assert.deepEqual(resolved.errors, [], 'a well-formed block lands clean');
    assert.equal(resolved.config.auth.mode, 'required');
    assert.equal(resolved.config.auth.principals.length, 5);
    assert.equal(resolved.config.trustedProxy, null, 'proxy trust is default-off');
    assert.equal(resolved.sources.auth, 'file');

    await writeFile(join(home, 'operator-ui.config.json'), JSON.stringify({ auth: { mode: 'required', principals: [{ id: 'p1', tokenVar: 'sk-live-secret' }] } }));
    const degraded = resolveConfig(home);
    assert.equal(degraded.config.auth.mode, 'required', 'the declared mode is kept so the operator sees their own intent refuse loudly');
    assert.equal(degraded.config.auth.principals.length, 0, 'the dropped principal leaves zero usable principals — every request refuses');
    assert.ok(degraded.errors.some((e) => e.key === 'auth.principals[0].tokenVar'), 'and the reason is reported, with its key');

    await writeFile(join(home, 'operator-ui.config.json'), JSON.stringify({ auth: REQUIRED_CONFIG.auth, trustedProxy: { addresses: ['10.0.0.9'] } }));
    const withProxy = resolveConfig(home);
    assert.deepEqual(withProxy.config.trustedProxy, { addresses: ['10.0.0.9'], header: 'x-forwarded-for' });

    // Redaction: the unauthenticated-facing config surface must not carry the
    // auth block or the principal table at all. (sources.auth = 'file' is the
    // provenance NAME — intended, and asserted above.)
    const redactedObj = redactedConfig(withProxy);
    assert.equal(redactedObj.auth, undefined, 'the auth block never projects onto the redacted surface');
    const redacted = JSON.stringify(redactedObj);
    assert.equal(redacted.includes('"principals"'), false, 'nor does the principal table');
    for (const t of Object.values(TOKEN_VARS)) assert.equal(redacted.includes(t), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------- E2E harness

let tmpRoot;
let registryPath;
let wsRoot;
const dirs = {};
let homeRequired;
let homeDev;

const newDir = async (name) => {
  const p = join(wsRoot, name);
  await mkdir(p, { recursive: true });
  return realpath(p);
};

const mockCalls = async () => {
  const b = await (await fetch(BASE + '/api/_mock/calls')).json();
  return {
    createPosts: b.createPosts,
    dispatchPosts: b.dispatchPosts,
    codebasePosts: b.codebasePosts,
    setProjectPosts: b.setProjectPosts,
  };
};

const delta = (before_, after_) => ({
  createPosts: after_.createPosts - before_.createPosts,
  dispatchPosts: after_.dispatchPosts - before_.dispatchPosts,
  codebasePosts: after_.codebasePosts - before_.codebasePosts,
  setProjectPosts: after_.setProjectPosts - before_.setProjectPosts,
});

const ZERO = { createPosts: 0, dispatchPosts: 0, codebasePosts: 0, setProjectPosts: 0 };

async function runCase(caseName, home, arg, timeoutMs = 120000) {
  const args = [join(ROOT, 'test', 'auth-case.mjs'), caseName, home];
  if (arg !== undefined) args.push(JSON.stringify(arg));
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_OPERATOR_UI_ARCHON: BASE,
      DSH_OPERATOR_UI_REGISTRY: registryPath,
      DSH_OPERATOR_UI_AUTHORITY_PRESET: 'AUTO_WITHIN_POLICY',
      DSH_HOME: home,
      [TOKEN_VARS.root]: TOKENS.root,
      [TOKEN_VARS.alice]: TOKENS.alice,
      [TOKEN_VARS.bob]: TOKENS.bob,
      [TOKEN_VARS.gone]: TOKENS.gone,
      // TOKEN_VARS.unset is deliberately NOT set.
    },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    err += d;
  });
  const code = await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('case ' + caseName + ' timed out after ' + timeoutMs + 'ms\nstderr: ' + err));
    }, timeoutMs);
    child.on('exit', (c) => {
      clearTimeout(t);
      resolve(c);
    });
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
  assert.equal(code, 0, 'case ' + caseName + ' exited ' + code + '\nstderr: ' + err);
  if (process.env.P3B_DEBUG) console.log('\n[P3B_DEBUG ' + caseName + ' stdout]\n' + out + '\n[stderr]\n' + err);
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'p3b-auth-'));
  registryPath = join(tmpRoot, 'registry.json');
  await writeFile(registryPath, JSON.stringify(REGISTRY, null, 2));

  wsRoot = join(tmpRoot, 'ws');
  for (const name of ['aliceLocal', 'aliceRemote', 'bobLocal', 'impersonate', 'unattrib', 'devMallory']) {
    dirs[name] = await newDir(name);
  }
  homeRequired = join(tmpRoot, 'home-required');
  homeDev = join(tmpRoot, 'home-dev');
});

after(async () => {
  if (mockProc) mockProc.kill('SIGKILL');
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

// ----------------------------------------------------------------- E2E: the cases

let ids = {};

test('required-setup: three workspaces, three shipped tasks, principals establishing their own owners', async () => {
  const r = await runCase('required-setup', homeRequired, {
    config: REQUIRED_CONFIG,
    mockBase: BASE,
    dirs,
    tokens: TOKENS,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.aliceLocalOwner, 'alice', 'the principal\'s single owner is applied when the field is omitted');
  assert.equal(r.aliceLocalEnvironment, 'env-local', 'an unnamed environment takes the configured default');
  assert.equal(r.aliceRemoteOwner ?? 'alice', 'alice', 'svc-root names alice, one of its own owners');
  assert.equal(r.aliceRemoteEnvironment, 'env-remote');
  assert.equal(r.bobLocalOwner, 'bob');
  assert.match(r.aliceTask.tag, /200:SHIP:/, 'the required-mode happy path still ships: ' + r.aliceTask.tag);
  assert.match(r.aliceRemoteTask.tag, /200:SHIP:/, JSON.stringify(r.aliceRemoteTask));
  assert.match(r.bobTask.tag, /200:SHIP:/, JSON.stringify(r.bobTask));
  ids = { aliceTaskId: r.aliceTask.taskId, aliceRemoteTaskId: r.aliceRemoteTask.taskId, bobTaskId: r.bobTask.taskId, aliceLocalId: r.aliceLocalId, aliceRemoteId: r.aliceRemoteId, bobLocalId: r.bobLocalId };
});

test('auth-surface: the posture is inspectable without a credential, and no secret value crosses the wire', async () => {
  const before_ = await mockCalls();
  const r = await runCase('auth-surface', homeRequired, { config: REQUIRED_CONFIG, mockBase: BASE, dirs, tokens: TOKENS });
  const d = delta(before_, await mockCalls());

  assert.equal(r.ok, true, JSON.stringify(r));
  // The chokepoint answers BEFORE dispatch: even the posture route refuses an
  // unauthenticated caller with the stable transport refusal. A client learns
  // it must present a credential from the refusal itself.
  assert.equal(r.noAuthStatus, 401);
  assert.equal(r.noAuthCode, 'authentication-required');
  assert.equal(r.listStatus, 200);
  assert.equal(r.contract, AUTH_CONTRACT_VERSION);
  assert.equal(r.mode, 'required');
  assert.equal(r.loopback, 'allow');
  assert.equal(r.principalCount, 5);
  assert.equal(r.rootTokenConfigured, true, 'the parent set that token var: presence is honest');
  assert.equal(r.unsetTokenConfigured, false, 'the unset credential is reported absent, never substituted');
  assert.equal(r.goneRevoked, true);
  assert.equal(r.rootOwners, 2);
  assert.equal(r.aliceEnvironments, 1);
  for (const key of ['textHasAliceSecret', 'textHasRootSecret', 'textHasBobSecret', 'textHasGoneSecret']) {
    assert.equal(r[key], false, key + ': a token VALUE must never appear on the surface');
  }
  assert.deepEqual(d, ZERO, 'reading the posture touches no orchestrator state');
});

test('required-refusals: missing, malformed, invalid, revoked — all 401 with stable codes, before any handler', async () => {
  const before_ = await mockCalls();
  const r = await runCase('required-refusals', homeRequired, { config: REQUIRED_CONFIG, mockBase: BASE, dirs, tokens: TOKENS });
  const d = delta(before_, await mockCalls());

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.missing, '401:authentication-required');
  assert.equal(r.wrongScheme, '401:authentication-malformed', 'a non-bearer scheme is malformed, not missing');
  assert.equal(r.bareWord, '401:authentication-malformed');
  assert.equal(r.emptyValue, '401:authentication-malformed');
  assert.equal(r.invalid, '401:authentication-invalid');
  assert.equal(r.revoked, '401:authentication-revoked', 'the revoked credential is recognized, then refused as revoked');
  assert.ok(String(r.revokedError).includes('svc-gone'), 'the refusal names the revoked principal — honest, and still secret-free');
  assert.equal(r.absentCredential, '401:authentication-invalid', 'an unrecognized token is invalid on any route');
  assert.equal(r.readMissing, '401:authentication-required', 'authentication is not per-method');
  assert.equal(r.readInvalid, '401:authentication-invalid');
  assert.equal(r.browserOp, '401:authentication-required', 'the exact route that bypasses the prefix chokepoint enforces the same gate');
  assert.equal(r.unknownUnauth, '401:authentication-required', 'the boundary runs before dispatch: even a 404 path answers 401 first');
  assert.equal(r.unknownAuthed, '404:', 'and with a valid credential the same path is honestly 404');
  assert.deepEqual(d, ZERO, 'not one refusal reached the orchestrator');
});

test('unauth-route-sweep: every route — and every would-be-404 path — answers 401 without a credential', async () => {
  const before_ = await mockCalls();
  const r = await runCase('unauth-route-sweep', homeRequired, { config: REQUIRED_CONFIG, mockBase: BASE, dirs, tokens: TOKENS });
  const d = delta(before_, await mockCalls());

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.prefixRegistered, true);
  const expected = ['git', 'files', 'archon', 'rcos', 'verify', 'goal', 'workspace', 'environments', 'conversation', 'teach', 'acquire', 'flowrouter', 'federation', 'f1', 'no-such-subpath'];
  for (const sub of expected) {
    assert.equal(r.results['/' + sub], '401:authentication-required', '/' + sub + ' must refuse unauthenticated access');
  }
  assert.equal(r.browserOp, '401:authentication-required');
  assert.equal(r.browserStream, '401:authentication-required', 'the SSE exact route refuses before writing its 200 stream');
  assert.equal(r.browserStatus, '401:authentication-required', 'the browser status exact route enforces the same gate');
  assert.equal(r.gitStatus, '401:authentication-required', 'the git status exact route enforces the same gate');
  assert.equal(r.controlStatus, 200, 'the sweep did not break authenticated access');
  assert.deepEqual(d, ZERO, 'the sweep left zero orchestrator contact');
});

test('owner-impersonation: a supplied owner field never becomes authority', async () => {
  const before_ = await mockCalls();
  const r = await runCase('owner-impersonation', homeRequired, {
    config: REQUIRED_CONFIG, mockBase: BASE, dirs, tokens: TOKENS,
    aliceRemoteId: ids.aliceRemoteId, bobTaskId: ids.bobTaskId,
  });
  const d = delta(before_, await mockCalls());

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.wsAsBob, '403:owner-impersonation-refused', 'workspace provisioning cannot be pointed at another owner');
  assert.equal(r.goalAsBob, '403:owner-impersonation-refused', 'dispatch cannot be pointed at another owner');
  assert.equal(r.listAsBob, '403:owner-impersonation-refused', 'even a listing claim of another owner is refused');
  assert.equal(r.resolveAsBob, '403:owner-impersonation-refused');
  assert.equal(r.retryAsBob, '403:owner-impersonation-refused', 'retrying INTO another owner\'s task fails the same way');
  assert.match(r.implied, /^200:/, 'the same principal, no owner named, proceeds');
  assert.equal(r.impliedOwner, 'alice');
  // The single codebase POST is the control's own successful workspace
  // creation (implied) — every REFUSED attempt contributed zero.
  assert.deepEqual(d, { ...ZERO, codebasePosts: 1 }, 'every impersonation attempt cost the orchestrator nothing');
});

test('environment-impersonation: the stored environment decides, on reads as on writes', async () => {
  const before_ = await mockCalls();
  const r = await runCase('environment-impersonation', homeRequired, {
    config: REQUIRED_CONFIG, mockBase: BASE, dirs, tokens: TOKENS,
    aliceRemoteId: ids.aliceRemoteId, aliceLocalId: ids.aliceLocalId,
  });
  const d = delta(before_, await mockCalls());

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.readRemote, '403:environment-unauthorized', 'a record she OWNS is still refused when its stored environment is out of scope');
  assert.equal(r.createRemote, '403:environment-unauthorized', 'creation in an out-of-scope environment is refused before the store makes anything');
  assert.match(r.control, /^200:/, 'her in-scope record stays reachable');
  assert.equal(r.controlEnvironment, 'env-local');
  assert.deepEqual(d, ZERO, 'the refused creation registered no codebase and touched nothing');
});

test('cross-workspace: bob cannot read, list, retry, fork, inspect, teach, or acquire alice\'s records', async () => {
  const before_ = await mockCalls();
  const r = await runCase('cross-workspace', homeRequired, {
    config: REQUIRED_CONFIG, mockBase: BASE, dirs, tokens: TOKENS,
    aliceTaskId: ids.aliceTaskId, bobTaskId: ids.bobTaskId, aliceLocalId: ids.aliceLocalId,
  });
  const d = delta(before_, await mockCalls());

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.goalRead, '403:task-owner-mismatch', 'a record read is authorized against the stored owner');
  assert.equal(r.goalListExcludesAlice, true, 'the list answers only with records the principal may act on');
  assert.equal(r.goalListIncludesBob, true, 'and bob\'s own record is still there');
  assert.equal(r.retry, '403:task-owner-mismatch', 'retry cannot anchor to another owner\'s task');
  assert.equal(r.fork, '403:task-owner-mismatch', 'fork cannot inherit another owner\'s task');
  assert.equal(r.convInspect, '403:task-owner-mismatch', 'conversation inspection is record-authorized');
  assert.equal(r.convVerify, '403:task-owner-mismatch', 'so is the verify op');
  assert.equal(r.teachTask, '403:task-owner-mismatch', 'teaching cannot be seeded from another owner\'s task');
  assert.equal(r.acquireTask, '403:task-owner-mismatch', 'nor acquisition');
  assert.equal(r.workspaceResolve, '403:workspace-owner-mismatch', 'the store\'s own owner resolution still answers for workspaces');
  assert.match(r.ownRead, /^200:/, 'control: bob reads bob');
  assert.deepEqual(d, ZERO, 'zero orchestrator side effects across the whole matrix');
});

test('unattributed: ambiguity is refused, never picked; a workspace-less required goal cannot be attributed', async () => {
  const before_ = await mockCalls();
  const r = await runCase('unattributed', homeRequired, { config: REQUIRED_CONFIG, mockBase: BASE, dirs, tokens: TOKENS });
  const d = delta(before_, await mockCalls());

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.wsNoOwner, '403:owner-attribution-required', 'two owners and no name: refuse rather than choose');
  assert.equal(r.goalNoOwner, '403:owner-attribution-required');
  assert.equal(r.goalNoWorkspace, '403:owner-attribution-required', 'a workspace-less goal records no owner, so it could never be acted on again: refused before creation');
  assert.match(r.named, /^200:/, 'naming one of its own owners un-ambiguates');
  assert.equal(r.namedOwner, 'bob');
  // The single codebase POST is the control's own successful workspace
  // creation (named) — every REFUSED attempt contributed zero.
  assert.deepEqual(d, { ...ZERO, codebasePosts: 1 });
});

test('required-lists: unattributed store sections fail closed to principals, never leak whole', async () => {
  const before_ = await mockCalls();
  const r = await runCase('required-lists', homeRequired, {
    config: REQUIRED_CONFIG, mockBase: BASE, dirs, tokens: TOKENS,
    aliceTaskId: ids.aliceTaskId, aliceRemoteTaskId: ids.aliceRemoteTaskId,
  });
  const d = delta(before_, await mockCalls());

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.teachStatus, 200);
  assert.equal(r.teachCount, 0, 'teaching records carry no owner: a principal sees none of them');
  assert.equal(r.acquireCount, 0);
  assert.equal(r.goalCount, 2, 'the goal list is exactly the principal\'s own records (both of alice\'s)');
  assert.equal(r.goalListOnlyOwn, true);
  assert.deepEqual(d, ZERO);
});

test('dev-preserved: no auth block means the pre-P3B path, byte for byte — owner passthrough and header indifference', async () => {
  const r = await runCase('dev-preserved', homeDev, { config: DEV_CONFIG, mockBase: BASE, dirs, tokens: TOKENS });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.mallory, /^200:/, 'dev mode: the owner field still passes through untouched');
  assert.equal(r.malloryOwner, 'mallory');
  assert.equal(r.strayHeaderStatus, 200, 'a presented credential is decoration in dev');
  assert.equal(r.strayAuthMode, 'dev');
  assert.equal(r.strayPrincipalCount, 0);
  assert.match(r.goal, /200:SHIP:/, 'and the dev happy path still ships: ' + r.goal);
  assert.equal(r.goalOwner, 'mallory');
});
