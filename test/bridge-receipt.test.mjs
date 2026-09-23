// P6D execution-leg bridge receipts — the PROTOCOL half.
//
// In-process tests over lib/bridge-receipt.js: what gets SEALED (only an outcome
// that ran, only a solari-sandbox worker), how the seal is witnessed (append-only
// chain journal, one-shot file, sha256 over the exact field order), and how the
// verify ladder refuses — missing, contract, id, seal, environment, identity,
// claim — in that order, each with its own code. The stored claim is re-run
// against live config: a receipt is a witness, never an authority.
//
// No network, no credential: identities are built with solariExecutionIdentity
// from declared (non-secret) inputs, and homes are throwaway tmpdir trees.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BRIDGE_ID_FIND,
  BRIDGE_RECEIPT_VERSION,
  bridgeReceiptDir,
  loadBridgeReceipt,
  verifyBridgeReceipt,
  writeBridgeReceipt,
} from '../lib/bridge-receipt.js';
import { solariExecutionIdentity, solariExecutionTuple } from '../lib/solari.js';

const sha256 = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

const ENV = {
  environmentId: 'env-sandbox',
  kind: 'solari-cloud',
  providerId: 'solari-dev',
  adapter: { kind: 'solari-sandbox', transport: { tokenVar: 'DSH_E2E_SOLARI_TOKEN' } },
  workspaceScope: { owners: ['*'] },
};

const CONFIG = { solari: { budgetCaps: { cpu: 2, memMb: 1024, timeoutMs: 600000 }, maxConcurrent: 1 } };

// An outcome that ran, exactly as the adapter reports it — ok, worker identity,
// run evidence, posture, verified death.
const okOutcome = (claim = 'solari-dev') => ({
  ok: true,
  identity: solariExecutionIdentity({
    environment: ENV,
    sandboxId: 'sbx-bridge-e2e',
    argv: ['echo', 'bridge-ok'],
    source: 'solari-execute',
    startedAt: '2026-09-23T00:00:00.000Z',
    finishedAt: '2026-09-23T00:00:05.000Z',
    providerClaim: claim,
    config: CONFIG,
  }),
  run: { exitCode: 0, stdout: 'bridge-ok\n', stderr: '' },
  posture: { user: 'sandbox', uid: 1000, probe: 'id -u', measuredAt: '2026-09-23T00:00:01.000Z' },
  cleanup: { ok: true, dead: true },
  verification: { verified: true, code: null },
  budget: { cpu: 1, memMb: 512, timeoutMs: 120000 },
  artifacts: { items: [] },
});

// The seal covers every field but itself, seal key last — the write order.
const sealOf = (r) => {
  const { receiptSha256, ...rest } = r;
  return sha256(JSON.stringify(rest));
};
// Rebuild the seal the way writeBridgeReceipt does. Tampering WITHOUT this trips
// bridge-receipt-sha-mismatch before the leg under test is reached.
const reseal = (record) => ({ ...record, receiptSha256: sealOf(record) });
const clone = (o) => JSON.parse(JSON.stringify(o));

let tmpRoot;
const newHome = async (name) => {
  const dir = join(tmpRoot, 'home-' + name);
  await mkdir(dir, { recursive: true });
  return dir;
};

const verify = (record, environment = ENV, environmentId = ENV.environmentId) =>
  verifyBridgeReceipt(record, { environmentId, environment, config: CONFIG });

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'p6d-bridge-'));
});
after(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

test('write: only an outcome that ran is sealed, and a refusal never creates the store', async () => {
  const home = await newHome('guard');

  await assert.rejects(
    () => writeBridgeReceipt({ home, environmentId: ENV.environmentId, environment: ENV, reason: 'p6d guard', outcome: { ...okOutcome(), ok: false } }),
    (e) => e.code === 'bridge-receipt-not-written' && /only for outcomes that ran/.test(e.message),
  );
  await assert.rejects(
    () => writeBridgeReceipt({
      home,
      environmentId: 'env-remote',
      environment: { environmentId: 'env-remote', kind: 'custom-remote', providerId: 'archon-remote', adapter: { kind: 'archon-http', transport: {} } },
      reason: 'p6d guard',
      outcome: okOutcome(),
    }),
    (e) => e.code === 'bridge-receipt-environment-kind' && /solari-sandbox executions only/.test(e.message),
  );

  const entries = await readdir(home);
  assert.deepEqual(entries, [], 'both refusals precede the mkdir — no store exists for a refusal');
});

test('write: a sealed receipt is written once, chained in the journal, and loads back whole', async () => {
  const home = await newHome('happy');
  const first = await writeBridgeReceipt({ home, environmentId: ENV.environmentId, environment: ENV, reason: 'p6d first leg', outcome: okOutcome() });

  assert.match(first.id, /^brg_[0-9a-f]{32}$/, 'ids are server-minted, not caller-supplied');
  assert.equal(first.contract, BRIDGE_RECEIPT_VERSION);
  assert.equal(first.receiptSha256, sealOf(first), "the seal is over the record's own fields, seal excluded");
  assert.equal(first.environmentId, 'env-sandbox');
  assert.equal(first.reason, 'p6d first leg');
  assert.equal(first.identity.role, 'execution-worker');
  assert.equal(first.identity.identitySha256, sha256(JSON.stringify(solariExecutionTuple(first.identity))));

  const evidence = 'node output … ' + first.id + ' trailing';
  assert.equal(BRIDGE_ID_FIND.exec(evidence)[0], first.id, 'the goal path extracts the id the store minted');

  const loaded = await loadBridgeReceipt(home, first.id);
  assert.ok(loaded, 'the store answers its own id');
  assert.equal(loaded.receiptSha256, first.receiptSha256);
  assert.deepEqual(loaded, first, 'load is a faithful round trip — no normalization');

  // The journal runs BEFORE the file: an entry the journal cannot chain is never
  // acknowledged. Two writes → two lines, the second chaining the first.
  const second = await writeBridgeReceipt({ home, environmentId: ENV.environmentId, environment: ENV, reason: 'p6d second leg', outcome: okOutcome() });
  assert.notEqual(second.id, first.id, 'each execution seals its own receipt');
  const lines = (await readFile(join(bridgeReceiptDir(home), 'bridge.log'), 'utf8'))
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].id, first.id);
  assert.equal(lines[0].prev, null, 'the first entry chains from nothing');
  assert.equal(lines[0].identitySha256, first.identity.identitySha256, 'the journal witnesses the identity too');
  assert.equal(lines[1].id, second.id);
  assert.equal(lines[1].prev, sha256(JSON.stringify(lines[0])), 'the chain tip is the digest of the previous entry');
});

test('load: an id the store cannot answer loads as null — never a partial record', async () => {
  const home = await newHome('load');
  const record = await writeBridgeReceipt({ home, environmentId: ENV.environmentId, environment: ENV, reason: 'p6d load', outcome: okOutcome() });

  assert.equal(await loadBridgeReceipt(home, 'not-a-brg-id'), null, 'malformed ids never reach the filesystem');
  assert.equal(await loadBridgeReceipt(home, 'brg_' + 'z'.repeat(32)), null, 'hex or nothing');
  assert.equal(await loadBridgeReceipt(home, 42), null);
  assert.equal(await loadBridgeReceipt(home, 'brg_' + 'ab'.repeat(16)), null, 'a well-formed id the store never minted reads as absent');

  // The file exists but was placed under a DIFFERENT id: record.id must match
  // the id being asked for, or the answer is absent.
  const otherId = 'brg_' + 'cd'.repeat(16);
  await writeFile(join(bridgeReceiptDir(home), otherId + '.json'), JSON.stringify(record));
  assert.equal(await loadBridgeReceipt(home, otherId), null, 'an id swapped under a record loads as null');
  assert.ok(await loadBridgeReceipt(home, record.id), 'the genuine file still answers for its own id');
});

test('verify: the ladder refuses in order — missing, contract, id, seal, seal-mismatch', async () => {
  const home = await newHome('ladder');
  const record = await writeBridgeReceipt({ home, environmentId: ENV.environmentId, environment: ENV, reason: 'p6d ladder', outcome: okOutcome() });

  const missing = verifyBridgeReceipt(null, { environmentId: ENV.environmentId, environment: ENV, config: CONFIG });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'bridge-receipt-missing');
  assert.ok(/fails closed/.test(missing.reason));

  const wrongContract = clone(record);
  wrongContract.contract = 2;
  const c = verify(wrongContract);
  assert.equal(c.status, 'invalid', 'contract is checked before the seal');
  assert.equal(c.code, 'bridge-receipt-contract');

  const wrongId = clone(record);
  wrongId.id = 'brg_' + 'z'.repeat(32);
  assert.equal(verify(wrongId).code, 'bridge-receipt-id');

  const unsealed = clone(record);
  delete unsealed.receiptSha256;
  const s = verify(unsealed);
  assert.equal(s.status, 'invalid');
  assert.equal(s.code, 'bridge-receipt-seal-missing');

  const altered = clone(record);
  altered.posture = { user: 'sandbox', uid: 0, probe: 'id -u', measuredAt: 'x' };
  const t = verify(altered);
  assert.equal(t.status, 'tampered');
  assert.equal(t.code, 'bridge-receipt-sha-mismatch');
  assert.ok(/does not re-seal/.test(t.reason));
});

test('verify: the worker environment must resolve, and must be the one declared', async () => {
  const home = await newHome('env');
  const record = await writeBridgeReceipt({ home, environmentId: ENV.environmentId, environment: ENV, reason: 'p6d env', outcome: okOutcome() });

  const gone = verifyBridgeReceipt(record, { environmentId: ENV.environmentId, environment: null, config: CONFIG });
  assert.equal(gone.status, 'unresolvable');
  assert.equal(gone.code, 'bridge-environment-unresolvable');
  assert.ok(/no longer exists/.test(gone.reason));

  const declared = verify(record, ENV, 'env-sandbox-renamed');
  assert.equal(declared.status, 'environment-mismatch');
  assert.equal(declared.code, 'bridge-environment-mismatch');
  assert.ok(/was written for environment/.test(declared.reason));

  const renamed = verifyBridgeReceipt(record, { environmentId: null, environment: { ...ENV, environmentId: 'env-sandbox-renamed' }, config: CONFIG });
  assert.equal(renamed.code, 'bridge-environment-mismatch');
  assert.ok(/config now declares it as/.test(renamed.reason));

  const ok = verify(record);
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test('verify: the identity is witnessed — role, tuple, and declared provider', async () => {
  const home = await newHome('identity');
  const record = await writeBridgeReceipt({ home, environmentId: ENV.environmentId, environment: ENV, reason: 'p6d identity', outcome: okOutcome() });

  const roleRec = clone(record);
  roleRec.identity.role = 'dispatch-witness';
  const r6 = verify(reseal(roleRec));
  assert.equal(r6.status, 'invalid', 'role is checked before the tuple re-derives');
  assert.equal(r6.code, 'bridge-identity-role');
  assert.ok(/not execution-worker/.test(r6.reason));

  const tupleRec = clone(record);
  tupleRec.identity.sandboxId = 'sbx-altered';
  const r7 = verify(reseal(tupleRec));
  assert.equal(r7.status, 'tampered');
  assert.equal(r7.code, 'bridge-identity-sha-mismatch');
  assert.ok(/does not re-derive/.test(r7.reason));

  // Declared provider: re-derived honestly under a provider this environment is
  // not — refused with both sides named.
  const providerRec = clone(record);
  providerRec.identity.providerDeclared = 'other-cloud';
  providerRec.identity.identitySha256 = sha256(JSON.stringify(solariExecutionTuple(providerRec.identity)));
  const r8 = verify(reseal(providerRec));
  assert.equal(r8.status, 'environment-mismatch');
  assert.equal(r8.code, 'bridge-environment-mismatch');
  assert.ok(/was sealed under providerId/.test(r8.reason));
});

test('verify: the stored claim is re-run against live config — a witness, never an authority', async () => {
  const home = await newHome('claim');
  const writeClaim = (claim) => writeBridgeReceipt({
    home,
    environmentId: ENV.environmentId,
    environment: ENV,
    reason: 'p6d claim ' + String(claim),
    outcome: okOutcome(claim),
  });

  const matched = await writeClaim('solari-dev');
  const m = verify(matched);
  assert.equal(m.status, 'matches');
  assert.equal(m.ok, true);
  assert.equal(m.code, null);
  assert.equal(m.claimed, 'solari-dev');
  assert.equal(m.declared, 'solari-dev');
  assert.ok(m.reason.startsWith('bridge receipt ' + matched.id + ' (execution leg): '), m.reason);
  assert.equal(m.establishedBy, 'bridge-receipt');
  assert.equal(m.identitySha256, matched.identity.identitySha256);
  assert.equal(m.receiptSha256, matched.receiptSha256);
  assert.equal(m.id, matched.id);
  assert.equal(m.runExitCode, 0, 'the run evidence rides the receipt');
  assert.equal(m.cleanupOk, true, "cleanup is the receipt's own record, not an assumption");
  assert.equal(m.dead, true);
  assert.equal(m.posture && m.posture.uid, 1000, 'the non-root posture travels with the execution leg');
  assert.equal(m.storedStatus, 'matches');

  const silent = await writeClaim(null);
  const n = verify(silent);
  assert.equal(n.status, 'not-claimed');
  assert.equal(n.ok, true, 'silence is not a violation — but it is never conflated with a match');
  assert.equal(n.claimed, null);

  const unknown = await writeClaim('aws-lambda');
  const u = verify(unknown);
  assert.equal(u.status, 'unsupported');
  assert.equal(u.ok, false);
  assert.equal(u.code, 'execution-provider-unsupported');

  const other = await writeClaim('archon-local');
  const x = verify(other);
  assert.equal(x.status, 'mismatch');
  assert.equal(x.ok, false);
  assert.equal(x.code, 'execution-provider-mismatch');
  assert.equal(x.claimed, 'archon-local');
  assert.equal(x.declared, 'solari-dev');
});
