// dsh-operator-ui — verification engine (Slice 2: VERIFIABLE).
//
// Turns "the pieces appear healthy" into "this installation executed a known
// verification path and produced sealed evidence". Two probes, no shortcuts:
//
//   Probe A (verify-machinery) — deterministic, zero-credential: the local
//   machinery (manifest load, seed-bundle hashing, config resolution, and the
//   evidence evaluator itself) is exercised and self-checked.
//
//   Probe B (rcos-execution-path) — the REAL RCOS path, no parallel
//   verification architecture: request → route THROUGH the configured
//   capability registry (the seeded capability's `workflow` binding is read
//   from the registry, never hardcoded here) → execute on the configured
//   Archon via its normal run API (the same API the Workflows tab proxies)
//   → collect run evidence → evaluate against the seeded expectation.
//
// Levels (Slice 2 authorization): NOT_VERIFIED < SYSTEM_VERIFIED (Probe A
// only) < RCOS_VERIFIED (A + B). A level is never stretched: if only A ran,
// the decision says SYSTEM_VERIFIED and B's blocker is named.
//
// The receipt is a machine-readable evidence artifact, hash-sealed after
// generation. Staleness: the receipt fingerprints the exact inputs it tested
// (manifest bytes, config hash, registry bytes, seed bytes, versions); a
// materially different installation reads STALE, a modified body reads
// TAMPERED. The receipt is the ONLY file this plugin writes, and only on an
// explicit POST — one artifact at $DSH_HOME/operator-ui/receipt.json.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { userInfo } from 'node:os';
import { resolveConfig, getDshHome, redactedConfig } from './config.js';
import { buildStatus, pluginRoot, configHash } from './status.js';

export const RECEIPT_VERSION = 1;
export const LEVELS = ['NOT_VERIFIED', 'SYSTEM_VERIFIED', 'RCOS_VERIFIED'];
export const SEED_CAPABILITY_ID = 'rcos-verify-echo';

const SEED_FILES = [
  { key: 'workflowYaml', rel: join('fixtures', 'verify-echo-v1.yaml') },
  { key: 'registryFixture', rel: join('fixtures', 'capability-registry.example.json') },
];

export function receiptPath(home) {
  return join(home || getDshHome(), 'operator-ui', 'receipt.json');
}

const sha256 = (buf) => 'sha256:' + createHash('sha256').update(buf).digest('hex');

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

const isoNow = () => new Date().toISOString();

function archonHeaders() {
  const { config } = resolveConfig();
  const headers = {};
  const tokenVar = config.archon.tokenVar;
  if (typeof tokenVar === 'string' && process.env[tokenVar]) {
    headers.authorization = 'Bearer ' + process.env[tokenVar]; // in-memory only
  }
  return headers;
}

// ---------------------------------------------------------------- fingerprints

async function computeFingerprints() {
  const resolved = resolveConfig();
  const root = pluginRoot();
  const seeds = {};
  for (const s of SEED_FILES) {
    try {
      seeds[s.key] = sha256(await readFile(join(root, s.rel), 'utf8'));
    } catch {
      seeds[s.key] = null;
    }
  }
  let registrySha = null;
  if (resolved.config.registry.path) {
    try {
      registrySha = sha256(await readFile(resolved.config.registry.path, 'utf8'));
    } catch {
      registrySha = null;
    }
  }
  let manifestSha = null;
  try {
    manifestSha = sha256(await readFile(join(root, 'system-manifest.json'), 'utf8'));
  } catch {
    manifestSha = null;
  }
  return {
    levelsContract: '1',
    pkgNode: process.versions.node,
    manifestSha256: manifestSha,
    registrySha256: registrySha,
    seedSha256: seeds,
    configHash: configHash(redactedConfig(resolved)),
  };
}

// The config fingerprint covers the REDACTED projection + sources (identical
// to the /status configHash) — values never enter it, and no secret value can
// change it.

// ------------------------------------------------------------------- Probe A

// Deterministic evaluator: the run's own terminal status must equal the
// seeded expectation AND the run evidence must contain the seeded marker.
// Self-tested by Probe A on every verification run.
export function evaluateEvidence(runStatus, runDetailText, expect) {
  if (!expect || typeof expect.expectOutput !== 'string' || expect.expectOutput.length === 0) return false;
  if (expect.terminalStatus && runStatus !== expect.terminalStatus) return false;
  if (typeof runDetailText !== 'string' || !runDetailText.includes(expect.expectOutput)) return false;
  return true;
}

async function probeA() {
  const t0 = Date.now();
  const p = { id: 'verify-machinery', kind: 'deterministic-zero-credential', level: 'SYSTEM', pass: false, failureCode: null, detail: {}, startedAt: isoNow() };
  try {
    const root = pluginRoot();
    const manifest = JSON.parse(await readFile(join(root, 'system-manifest.json'), 'utf8'));
    if (manifest.manifestVersion !== 1) throw new Error('manifestVersion ' + manifest.manifestVersion + ' != 1');
    p.detail.manifestVersion = manifest.manifestVersion;

    const seeds = {};
    for (const s of SEED_FILES) {
      seeds[s.key] = sha256(await readFile(join(root, s.rel), 'utf8'));
    }
    p.detail.seedHashes = seeds;

    const resolved = resolveConfig();
    p.detail.configErrors = resolved.errors.length;

    const expect = { expectOutput: 'rcos-verify-seed:rcos-verify-echo-v1', terminalStatus: 'completed' };
    const good = evaluateEvidence('completed', '{"status":"completed","output":"rcos-verify-seed:rcos-verify-echo-v1"}', expect);
    const badOutput = evaluateEvidence('completed', '{"status":"completed","output":"something-else"}', expect);
    const badStatus = evaluateEvidence('failed', '{"status":"failed","output":"rcos-verify-seed:rcos-verify-echo-v1"}', expect);
    if (!good || badOutput || badStatus) throw new Error('evaluator self-test failed (accept=' + good + ' rejectOutput=' + badOutput + ' rejectStatus=' + badStatus + ')');
    p.detail.evaluatorSelfTest = 'accept-expects + reject-wrong-output + reject-wrong-status';

    p.pass = true;
  } catch (e) {
    p.failureCode = 'probeA-machinery-failed';
    p.detail.error = String((e && e.message) || e).slice(0, 200);
  }
  p.durationMs = Date.now() - t0;
  return p;
}

// ------------------------------------------------------------------- Probe B

// Routes through the REGISTRY (the capability's own `workflow` binding is the
// routing truth) and executes on the CONFIGURED Archon via its normal run API.
// No workflow name is hardcoded into the dispatch path.
async function probeB(status) {
  const t0 = Date.now();
  const p = {
    id: 'rcos-execution-path',
    kind: 'routed-archon-execution',
    level: 'RCOS',
    pass: false,
    failureCode: null,
    detail: {},
    startedAt: isoNow(),
  };
  const resolved = resolveConfig();
  const { config } = resolved;

  // ---- preflight: what RCOS_VERIFIED genuinely requires
  if (!status || !status.components || status.components.archon.state !== 'AVAILABLE') {
    p.failureCode = status && status.components.archon.detail && status.components.archon.detail.identity === 'not-archon-shaped'
      ? 'archon-not-archon-shaped' : 'archon-unavailable';
    p.detail.blocker = 'archon component is ' + (status ? status.components.archon.state : 'UNKNOWN') +
      ' — RCOS_VERIFIED requires a reachable Archon-compatible execution adapter';
    p.durationMs = Date.now() - t0;
    return p;
  }
  if (status.components.rcos.state !== 'AVAILABLE') {
    p.failureCode = status.components.rcos.state === 'NOT_CONFIGURED' ? 'registry-not-configured' : 'registry-' + status.components.rcos.state.toLowerCase();
    p.detail.blocker = 'capability registry is ' + status.components.rcos.state + ' — routing needs registry truth';
    p.durationMs = Date.now() - t0;
    return p;
  }

  // ---- route: read the seeded capability from the registry
  let registry;
  try {
    registry = JSON.parse(await readFile(config.registry.path, 'utf8'));
  } catch (e) {
    p.failureCode = 'registry-unreadable';
    p.detail.blocker = String((e && e.message) || e).slice(0, 160);
    p.durationMs = Date.now() - t0;
    return p;
  }
  const caps = Array.isArray(registry.capabilities) ? registry.capabilities : [];
  const cap = caps.find((c) => c && c.id === SEED_CAPABILITY_ID);
  if (!cap) {
    p.failureCode = 'seed-capability-missing';
    p.detail.blocker = 'registry has no seeded capability ' + SEED_CAPABILITY_ID +
      ' — import the seed bundle (see DEPLOY.md) so verification can route';
    p.durationMs = Date.now() - t0;
    return p;
  }
  const workflowName = cap.workflow;
  if (typeof workflowName !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(workflowName)) {
    p.failureCode = 'seed-capability-no-binding';
    p.detail.blocker = 'seeded capability ' + SEED_CAPABILITY_ID + ' has no usable `workflow` binding';
    p.durationMs = Date.now() - t0;
    return p;
  }
  p.detail.routedVia = { capability: cap.id, version: cap.version, workflow: workflowName, seeded: !!cap.seed };

  // ---- seed workflow file must exist (provenance: hash what we claim we ran)
  let seedYaml = null;
  try {
    seedYaml = await readFile(join(pluginRoot(), 'fixtures', 'verify-echo-v1.yaml'), 'utf8');
  } catch {
    p.failureCode = 'seed-workflow-missing';
    p.detail.blocker = 'fixtures/verify-echo-v1.yaml is missing from the plugin tree';
    p.durationMs = Date.now() - t0;
    return p;
  }
  p.detail.seedWorkflowSha256 = sha256(seedYaml);

  // ---- execute: normal Archon run API (same base the Workflows tab proxies)
  let runId = null;
  try {
    const res = await fetch(config.archon.baseUrl + '/api/workflows/' + encodeURIComponent(workflowName) + '/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...archonHeaders() },
      body: JSON.stringify({ message: 'rcos system verification (seeded ' + cap.id + ' probe)' }),
      signal: AbortSignal.timeout(Math.max(config.archon.timeoutMs, 10000)),
    });
    if (!res.ok) throw new Error('dispatch HTTP ' + res.status);
    let body = await res.json();
    const run = body && typeof body === 'object' && body.run ? body.run : body;
    runId = (run && (run.id || run.runId)) || null;
    if (!runId) throw new Error('dispatch returned no run id');
    p.detail.dispatchHttpStatus = res.status;
  } catch (e) {
    p.failureCode = 'dispatch-failed';
    p.detail.blocker = 'POST /api/workflows/' + workflowName + '/run → ' + String((e && e.message) || e).slice(0, 140);
    p.durationMs = Date.now() - t0;
    return p;
  }
  p.detail.runId = runId;

  // ---- evidence: poll the run to a terminal state (bounded)
  const deadline = Date.now() + 20000;
  let detail = null;
  try {
    for (;;) {
      const res = await fetch(config.archon.baseUrl + '/api/workflows/runs/' + encodeURIComponent(runId), {
        headers: archonHeaders(),
        signal: AbortSignal.timeout(config.archon.timeoutMs),
      });
      if (res.ok) {
        detail = await res.json();
        const d = detail && detail.run ? detail.run : detail;
        const st = d && d.status;
        if (st && st !== 'running' && st !== 'queued' && st !== 'pending') break;
      }
      if (Date.now() > deadline) { detail = null; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (e) {
    p.failureCode = 'evidence-fetch-failed';
    p.detail.blocker = String((e && e.message) || e).slice(0, 140);
    p.durationMs = Date.now() - t0;
    return p;
  }
  if (!detail) {
    p.failureCode = 'run-timeout';
    p.detail.blocker = 'run ' + runId + ' did not reach a terminal state within 20s — evidence insufficient, level not claimed';
    p.durationMs = Date.now() - t0;
    return p;
  }

  // ---- evaluate against the seeded expectation
  const expect = cap.verification || {};
  const detailText = JSON.stringify(detail);
  p.detail.evidenceSha256 = sha256(detailText);
  const runObj = detail && detail.run ? detail.run : detail;
  p.detail.runStatus = runObj.status || null;
  if (runObj.status === 'failed') {
    p.failureCode = 'run-failed';
    p.detail.blocker = 'seeded workflow run failed on the execution adapter';
  } else if (!evaluateEvidence(runObj.status, detailText, expect)) {
    p.failureCode = 'evidence-mismatch';
    p.detail.blocker = 'run evidence did not match the seeded expectation' +
      (expect.terminalStatus ? ' (terminal status ' + expect.terminalStatus + ', got ' + (runObj.status || 'none') + ')' : '') +
      ' or the marker was missing: ' + (expect.expectOutput || '(none declared)');
  } else {
    p.pass = true;
    p.detail.evaluated = 'marker + terminal status matched the seeded expectation';
  }
  p.durationMs = Date.now() - t0;
  return p;
}

// ------------------------------------------------------------------- receipt

function buildReceipt({ probes, status, fingerprints, decision, failureCodes, startedAt }) {
  const resolved = resolveConfig();
  const redacted = redactedConfig(resolved);
  const root = pluginRoot();
  let runtimeUser = null;
  try { runtimeUser = userInfo().username; } catch { runtimeUser = null; }

  const archon = status.components.archon;
  const execution = probes.find((x) => x.id === 'rcos-execution-path');
  const execEvidence = execution && execution.pass ? {
    adapter: 'archon',
    baseUrl: archon.detail.baseUrl,
    routedVia: execution.detail.routedVia || null,
    runId: execution.detail.runId || null,
    runStatus: execution.detail.runStatus || null,
    seedWorkflowSha256: execution.detail.seedWorkflowSha256 || null,
    evidenceSha256: execution.detail.evidenceSha256 || null,
    durationMs: execution.durationMs,
  } : null;

  const seedBundle = [];
  for (const s of SEED_FILES) {
    seedBundle.push({ file: s.rel, sha256: fingerprints.seedSha256[s.key] });
  }

  const receipt = {
    receiptVersion: RECEIPT_VERSION,
    createdAt: isoNow(),
    startedAt,
    machine: { platform: process.platform, arch: process.arch, node: process.versions.node, runtimeUser },
    installation: { dshHome: resolved.home, receiptFile: receiptPath(resolved.home) },
    components: Object.fromEntries(Object.entries(status.components).map(([k, c]) => [k, { state: c.state, version: c.version || null }])),
    manifest: { file: 'system-manifest.json', manifestVersion: 1, sha256: fingerprints.manifestSha256 },
    configAuthority: { path: redacted.path, exists: redacted.exists, configHash: fingerprints.configHash, errorCount: redacted.errors.length },
    registry: resolved.config.registry.path
      ? { path: resolved.config.registry.path, sha256: fingerprints.registrySha256, schema: resolved.config.registry.schema }
      : { configured: false },
    seedBundle,
    probes,
    execution: execEvidence,
    levels: { vocabulary: LEVELS, achieved: decision },
    decision,
    failureCodes,
    fingerprints,
  };
  const body = stableStringify(receipt);
  receipt.seal = { algorithm: 'sha256', covers: 'receipt-body-without-seal', hash: sha256(body) };
  return receipt;
}

// ------------------------------------------------------------------ seal check

function sealValid(receipt) {
  if (!receipt || typeof receipt !== 'object' || !receipt.seal || typeof receipt.seal.hash !== 'string') return false;
  const { seal, ...body } = receipt;
  return sha256(stableStringify(body)) === seal.hash;
}

function diffFingerprints(live, sealed) {
  const reasons = [];
  if (!sealed || typeof sealed !== 'object') return ['receipt has no fingerprints'];
  if (sealed.pkgNode !== live.pkgNode) reasons.push('node version changed (' + sealed.pkgNode + ' → ' + live.pkgNode + ')');
  if (sealed.manifestSha256 !== live.manifestSha256) reasons.push('system-manifest.json changed since verification');
  if (sealed.configHash !== live.configHash) reasons.push('operator-ui configuration changed since verification');
  if (sealed.registrySha256 !== live.registrySha256) reasons.push(sealed.registrySha256 === null || live.registrySha256 === null
    ? 'registry configuration changed since verification'
    : 'capability registry contents changed since verification');
  const seedsA = sealed.seedSha256 || {};
  const seedsB = live.seedSha256 || {};
  for (const key of new Set([...Object.keys(seedsA), ...Object.keys(seedsB)])) {
    if (seedsA[key] !== seedsB[key]) reasons.push('seed bundle changed: ' + key);
  }
  return reasons;
}

// ------------------------------------------------------------------ entry: run

let inflight = null;

export function runVerification(ctx) {
  if (inflight) return inflight;
  inflight = _run(ctx).finally(() => { inflight = null; });
  return inflight;
}

async function _run({ browser, findChrome, pkgVersion, toolsUnavailable }) {
  const startedAt = isoNow();
  const status = await buildStatus({ browser, findChrome, pkgVersion, toolsUnavailable });

  const probeAResult = await probeA();
  let probes = [probeAResult];
  let executionBlocker = null;
  let probeBResult = null;
  if (probeAResult.pass) {
    probeBResult = await probeB(status);
    probes.push(probeBResult);
    if (!probeBResult.pass) executionBlocker = probeBResult.failureCode;
  } else {
    executionBlocker = 'probeA-machinery-failed';
  }

  const decision = !probeAResult.pass
    ? 'NOT_VERIFIED'
    : (probeBResult && probeBResult.pass) ? 'RCOS_VERIFIED' : 'SYSTEM_VERIFIED';

  const failureCodes = probes.filter((x) => !x.pass && x.failureCode).map((x) => x.failureCode);

  // Fingerprints are computed AFTER the probes: the receipt vouches for the
  // inputs as they were observed during this verification run.
  const fingerprints = await computeFingerprints();
  const receipt = buildReceipt({ probes, status, fingerprints, decision, failureCodes, startedAt });

  const file = receiptPath();
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  } catch (e) {
    return {
      ok: false,
      error: 'verification ran but the receipt could not be written to ' + file + ': ' + String((e && e.message) || e).slice(0, 140),
      receipt,
      freshness: { state: 'UNSEALED', staleReasons: [], sealValid: null, checkedAt: isoNow() },
    };
  }
  const freshness = await readReceipt();
  return { ok: true, decision, executionBlocker, receipt, freshness, file };
}

// ----------------------------------------------------------------- entry: read

// Read-only. Never writes. Recomputes the seal and the fingerprints fresh, so
// an old receipt can never present itself as proof of a materially different
// installation: VALID / STALE(reasons) / TAMPERED / NONE.
export async function readReceipt() {
  const checkedAt = isoNow();
  const file = receiptPath();
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { state: 'NONE', receipt: null, file, sealValid: null, staleReasons: [], checkedAt };
  }
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch (e) {
    return { state: 'TAMPERED', receipt: null, file, sealValid: false, staleReasons: ['receipt file is not valid JSON'], checkedAt };
  }
  const sealOk = sealValid(receipt);
  if (!sealOk) {
    return { state: 'TAMPERED', receipt, file, sealValid: false, staleReasons: ['sealed body no longer matches its hash — modified after generation'], checkedAt };
  }
  const staleReasons = diffFingerprints(await computeFingerprints(), receipt.fingerprints);
  return { state: staleReasons.length ? 'STALE' : 'VALID', receipt, file, sealValid: true, staleReasons, checkedAt };
}
