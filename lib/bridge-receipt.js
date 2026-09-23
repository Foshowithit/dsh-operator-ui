// dsh-operator-ui — P6D bridge receipt store (the SECOND witness).
//
// The two witnesses are never folded. The dispatch leg's identity stays
// `adopted-run` over the Archon conversation (honest not-claimed today —
// Archon v0.4.1 has no execution_provider concept). The execution leg is THIS
// store: when a goal's workflow reaches out to the loopback /solari route's
// op=run, the server executes, then persists an append-only receipt under
// DSH_HOME keyed by a server-generated opaque id, and only the id travels back
// through the workflow's bash node. A workflow author can carry an id; they can
// never mint a verdict — no secret, no identity builder, and no store write is
// reachable from YAML.
//
// On the goal side, `verifyBridgeReceipt` re-derives the sealed identitySha256
// over the SAME 10-tuple construction lib/solari.js sealed it with
// (solariExecutionTuple), re-resolves the worker environment from config, and
// re-runs providerClaimVerdict against the WORKER environment's declared
// providerId. Any drift — edited claim, rewritten identity, unknown id,
// environment gone from config — fails closed. Claim failures are BLOCK-class;
// they are never softened by a green objective.
//
// Store layout (DSH_HOME/bridge-receipts/):
//   brg_<32hex>.json   one record, created once with flag 'wx' (never rewritten)
//   bridge.log         append-only chain: {id, createdAt, identitySha256, prev}
//
// No credential ever enters a record: identity/run/posture/cleanup are the
// already-scrubbed evidence objects executeScoped produced, and the Solari key
// exists only inside the server-side process that ran the sandbox.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { solariExecutionTuple } from './solari.js';
import { providerClaimVerdict } from './environments.js';

export const BRIDGE_RECEIPT_VERSION = 1;
// Opaque, server-minted, 128 bits of hex. The ONLY string the workflow may
// carry back. Deliberately unparseable: an id reveals nothing about the run.
export const BRIDGE_ID_RE = /^brg_[0-9a-f]{32}$/;
// The RE above validates a BARE id; an id actually arrives embedded in node
// output ("…receipt brg_<32hex> persisted…"), so the goal side needs an
// unanchored finder over the evidence text. Finding it is not trusting it —
// the found id still goes through loadBridgeReceipt + verifyBridgeReceipt.
export const BRIDGE_ID_FIND = /brg_[0-9a-f]{32}/;

const sha256 = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

export function bridgeReceiptDir(home) {
  return join(home, 'bridge-receipts');
}

export function mintBridgeId() {
  return 'brg_' + randomBytes(16).toString('hex');
}

// Persist the execution leg's receipt. Called ONLY by the op=run handler
// immediately after executeScoped returns ok:true — i.e. after the sandbox ran
// AND after cleanup was attempted. Throws (typed .code) instead of returning a
// half-written record: a receipt that cannot be persisted must never hand back
// an id the goal side could not load.
export async function writeBridgeReceipt({ home, environmentId, environment, reason, outcome }) {
  if (!outcome || outcome.ok !== true) {
    const err = new Error('bridge receipts are written only for outcomes that ran — ok:true required');
    err.code = 'bridge-receipt-not-written';
    throw err;
  }
  // Normalized environments carry kind ∈ local | solari-cloud | custom-remote at
  // the top level; the adapter kind is what says solari-sandbox (the provenance
  // fixture is kind:'solari-cloud' + adapter.kind:'solari-sandbox'). Checking the
  // top-level kind here would refuse every real execution.
  if (!environment || !environment.adapter || environment.adapter.kind !== 'solari-sandbox') {
    const err = new Error('bridge receipts seal solari-sandbox executions only');
    err.code = 'bridge-receipt-environment-kind';
    throw err;
  }
  const id = mintBridgeId();
  const dir = bridgeReceiptDir(home);
  await mkdir(dir, { recursive: true });
  const createdAt = new Date().toISOString();

  // The identity, run, posture, cleanup, verification, and budget objects are
  // copied by value so a later mutation in the handler cannot move the record.
  const record = {
    contract: BRIDGE_RECEIPT_VERSION,
    id,
    createdAt,
    environmentId,
    // Declaration snapshot, exactly as config resolved it (names only — a
    // solari transport carries tokenVar/envAllowlist NAMES, never values).
    environment: JSON.parse(JSON.stringify(environment)),
    reason: typeof reason === 'string' ? reason : null,
    identity: outcome.identity,
    run: outcome.run,
    posture: outcome.posture || null,
    cleanup: outcome.cleanup || null,
    verification: outcome.verification || null,
    budget: outcome.budget || null,
    artifacts: outcome.artifacts || null,
  };
  // Seal over the record as it stands (this key is added last, so it is the
  // only field not covered by its own hash — it is compared, never trusted).
  record.receiptSha256 = sha256(JSON.stringify(record));

  // Chain journal first: if the journal cannot be appended the write refuses
  // (fail closed — no id, no record). An orphan journal line can only happen if
  // the subsequent file write then fails; the goal side loads FILES and would
  // fail closed on the missing id anyway.
  const prev = await readChainTip(dir);
  await appendFile(join(dir, 'bridge.log'), JSON.stringify({ id, createdAt, identitySha256: record.identity && record.identity.identitySha256, prev }) + '\n', 'utf8');

  // 'wx' = create-exclusively. A receipt file is written exactly once; the
  // store never edits or deletes one (append-only). An EEXIST here would mean
  // a 128-bit random id collided with an existing record — refuse rather than
  // overwrite (the caller gets a typed error and hands back no id).
  try {
    await writeFile(join(dir, record.id + '.json'), JSON.stringify(record), { flag: 'wx' });
  } catch (e) {
    const err = new Error('bridge receipt file write failed: ' + String((e && e.message) || e).slice(0, 200));
    err.code = 'bridge-receipt-write-failed';
    err.details = { id: record.id };
    throw err;
  }
  return record;
}

async function readChainTip(dir) {
  try {
    const text = await readFile(join(dir, 'bridge.log'), 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    if (!lines.length) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    return sha256(JSON.stringify(last));
  } catch {
    return null; // no chain yet (or an unreadable tip — the chain is evidence, not the load path)
  }
}

// Load by id. ANY problem — bad format, missing file, unparseable JSON,
// unreadable directory — yields null: an id the goal side cannot resolve is
// exactly the fail-closed case the plan pins (unknown/tampered id → BLOCK).
export async function loadBridgeReceipt(home, id) {
  if (typeof id !== 'string' || !BRIDGE_ID_RE.test(id)) return null;
  try {
    const raw = await readFile(join(bridgeReceiptDir(home), id + '.json'), 'utf8');
    const record = JSON.parse(raw);
    if (!record || typeof record !== 'object' || record.id !== id) return null;
    return record;
  } catch {
    return null;
  }
}

// The goal-side verification. `environment` is the WORKER environment freshly
// resolved from live config (requireEnvironmentForOwner + adapter gate already
// ran in goal.js); `config` is the same resolved config the claim verdict needs
// for its known-provider list. Returns the verdict ACTUALLY observed for this
// branch — matches / mismatch / unsupported / not-claimed — plus the receipt
// provenance, or a typed fail-closed refusal (ok:false → BLOCK-class).
export function verifyBridgeReceipt(record, { environmentId, environment, config }) {
  if (!record || typeof record !== 'object') {
    return { status: 'missing', ok: false, code: 'bridge-receipt-missing', reason: 'the bridge-declaring goal produced no loadable bridge receipt for its id — nothing executed is asserted, and the goal fails closed' };
  }
  if (record.contract !== BRIDGE_RECEIPT_VERSION) {
    return { status: 'invalid', ok: false, code: 'bridge-receipt-contract', reason: 'bridge receipt contract ' + JSON.stringify(record.contract) + ' is not the supported version ' + BRIDGE_RECEIPT_VERSION };
  }
  if (typeof record.id !== 'string' || !BRIDGE_ID_RE.test(record.id)) {
    return { status: 'invalid', ok: false, code: 'bridge-receipt-id', reason: 'bridge receipt id is not a server-minted brg_ id' };
  }
  // The record-level seal covers everything OUTSIDE the identity (run, posture,
  // cleanup, verification, response projection). Recompute over the record as
  // written — key order is the file's parse order, identical to the write-time
  // order because the seal key was appended last.
  if (typeof record.receiptSha256 !== 'string') {
    return { status: 'invalid', ok: false, code: 'bridge-receipt-seal-missing', reason: 'bridge receipt ' + record.id + ' carries no receipt seal — refusing an unsealed record' };
  }
  {
    const { receiptSha256, ...rest } = record;
    const recomputedSeal = sha256(JSON.stringify(rest));
    if (recomputedSeal !== receiptSha256) {
      return { status: 'tampered', ok: false, code: 'bridge-receipt-sha-mismatch', reason: 'bridge receipt ' + record.id + ' does not re-seal (' + recomputedSeal.slice(0, 15) + '… vs sealed ' + receiptSha256.slice(0, 15) + '…) — the record was altered after it was written' };
    }
  }
  if (!environment) {
    return { status: 'unresolvable', ok: false, code: 'bridge-environment-unresolvable', reason: 'the worker environment for bridge receipt ' + record.id + ' does not resolve from config — the execution witness cannot be checked against a declaration that no longer exists' };
  }
  if (environmentId && record.environmentId !== environmentId) {
    return { status: 'environment-mismatch', ok: false, code: 'bridge-environment-mismatch', reason: 'bridge receipt ' + record.id + ' was written for environment ' + JSON.stringify(record.environmentId) + ' but the goal checks ' + JSON.stringify(environmentId) };
  }
  if (record.environmentId !== environment.environmentId) {
    return { status: 'environment-mismatch', ok: false, code: 'bridge-environment-mismatch', reason: 'bridge receipt ' + record.id + ' was written for environment ' + JSON.stringify(record.environmentId) + ' but config now declares it as ' + JSON.stringify(environment.environmentId) };
  }

  const identity = record.identity;
  if (!identity || typeof identity !== 'object' || typeof identity.identitySha256 !== 'string') {
    return { status: 'invalid', ok: false, code: 'bridge-identity-missing', reason: 'bridge receipt ' + record.id + ' carries no execution-worker identity' };
  }
  if (identity.role !== 'execution-worker') {
    return { status: 'invalid', ok: false, code: 'bridge-identity-role', reason: 'bridge receipt ' + record.id + ' identity role is ' + JSON.stringify(identity.role) + ', not execution-worker' };
  }
  // Re-derive over the shared tuple construction — if any stored field was
  // edited after sealing, the hash drifts and the receipt is refused.
  const recomputed = sha256(JSON.stringify(solariExecutionTuple(identity)));
  if (recomputed !== identity.identitySha256) {
    return { status: 'tampered', ok: false, code: 'bridge-identity-sha-mismatch', reason: 'bridge receipt ' + record.id + ' identity does not re-derive (' + recomputed.slice(0, 15) + '… vs sealed ' + String(identity.identitySha256).slice(0, 15) + '…) — the record was altered after it was written' };
  }
  if (identity.providerDeclared !== environment.providerId) {
    return { status: 'environment-mismatch', ok: false, code: 'bridge-environment-mismatch', reason: 'bridge receipt ' + record.id + ' was sealed under providerId ' + JSON.stringify(identity.providerDeclared) + ' but the worker environment now declares ' + JSON.stringify(environment.providerId) };
  }

  // The claim string itself is inside the sealed tuple (index 10). Re-run the
  // SAME verdict code the dispatch leg uses, against the WORKER environment's
  // declared providerId and the live config — the branch reported here is the
  // branch actually observed at goal-evaluation time.
  const storedClaim = identity.providerClaim;
  const claim = storedClaim && storedClaim.claimed !== undefined && storedClaim.claimed !== null && storedClaim.claimed !== '' ? storedClaim.claimed : null;
  const verdict = providerClaimVerdict({ environment, claim, config });

  return {
    status: verdict.status, // matches | mismatch | unsupported | not-claimed
    ok: verdict.ok === true,
    code: verdict.code || null,
    claimed: verdict.claimed,
    declared: verdict.declared,
    reason: 'bridge receipt ' + record.id + ' (execution leg): ' + verdict.reason,
    id: record.id,
    createdAt: record.createdAt || null,
    establishedBy: 'bridge-receipt',
    identitySha256: identity.identitySha256,
    receiptSha256: record.receiptSha256 || null,
    storedStatus: storedClaim && storedClaim.status !== undefined ? storedClaim.status : null,
    runExitCode: record.run && typeof record.run.exitCode === 'number' ? record.run.exitCode : null,
    cleanupOk: record.cleanup ? record.cleanup.ok === true : null,
    dead: record.cleanup ? record.cleanup.dead === true : null,
    posture: record.posture || null,
  };
}
