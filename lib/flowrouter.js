// lib/flowrouter.js — RCOS ↔ FlowRouter portability adapter (P0).
//
// Frozen architecture (GPT-adjudicated, eval/FLOWROUTER-RECONCILIATION.md +
// amendments): RCOS internal capability → export adapter → canonical
// Capability Package (transport/storage only) → import adapter →
// STAGED/UNTRUSTED → {schema, integrity, compatibility, dependencies,
// authority} → LOCAL VERIFICATION (B-local fixture, frozen before
// execution) → operator admission → ELIGIBLE → normal router.
//
// CONSTITUTIONAL RULE: FlowRouter can transport evidence of trust. It
// cannot transport trust itself. Source facts cross only as
// provenance.source.*; the receiver starts STAGED / UNVERIFIED /
// INELIGIBLE and only local verification + operator admission advance it.
//
// Package digest (amendment 1, OCI-like): SHA256 over the canonical
// ordered list of [relative-path, byte-length, SHA256(file-bytes)] — with
// capability.json canonicalized OMITTING implementation.bundle.digest and
// implementation.bundle.package_digest. implementation digest =
// SHA256(workflow YAML bytes), reported separately.
//
// MUST-NOT-EXPORT (enforced at export; refusal, never silent stripping):
// credentials/credential stores, absolute local paths, machine state,
// mutable timestamps in identity-bearing content, unknown or undeclared
// authority scopes.
//
// P0 scope: no networking. Transport is a local directory. Publish/index/
// discover/fetch are a later phase — local reverification stays the trust
// boundary regardless.

import { randomUUID, createHash } from 'node:crypto';
import { verifyGenesis, replayChain, verifyPublication, classifyFreshness, chainExtendsPin, recordDigest } from './identity.js';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, relative, sep, dirname } from 'node:path';
import { resolveConfig } from './config.js';
import { getTask, upsertTask } from './tasks.js';
import { isQuarantined, QUARANTINE_CODE } from './equivocation.js';
import { SCOPES } from './authority.js';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isoNow = () => new Date().toISOString();

// ONE mapping from a FlowRouter REFUSAL code to the operator's next action, so
// no refusal reaches the operator without a decision attached — and so the
// prescribed action never contradicts what the code already established. The
// distinction is the same one flowrouterRefusalStatus draws in lib/index.js: a
// DETERMINISTIC refusal about data that WAS read is 'inspect' (retrying it
// unchanged reproduces it), while a read that could not be COMPLETED is 'retry'
// (the artifact never got a fair look). The fallback names no cause on purpose:
// a future code added without an entry must degrade to a NEUTRAL instruction,
// never to a false one (same discipline as acquire.js's exhausted-label table).
const REFUSAL_ACTION = {
  // The local installation is at fault: repair it, then retry.
  REGISTRY_MISSING: { kind: 'retry', label: 'Create the capability registry' },
  REGISTRY_UNREADABLE: { kind: 'retry', label: 'Repair the capability registry' },
  // The PACKAGE is at fault, and a package is a REQUEST INPUT the operator
  // named — so the remedy is to fix the input, not to repair the machine.
  PACKAGE_MANIFEST_MISSING: { kind: 'inspect', label: 'Supply the package manifest' },
  PACKAGE_MANIFEST_UNREADABLE: { kind: 'retry', label: 'Repair the package manifest' },
  PACKAGE_BYTES_MISSING: { kind: 'retry', label: 'Re-stage the package' },
  PACKAGE_BYTES_UNREADABLE: { kind: 'retry', label: 'Repair the staged package' },
  // An external read could not be completed: nothing was verified.
  LOCAL_VERIFICATION_UNAVAILABLE: { kind: 'retry', label: 'Retry local verification' },
  // The local executor ANSWERED — its answer is the finding.
  LOCAL_VERIFICATION_ABSENT: { kind: 'inspect', label: 'Inspect the local executor' },
  LOCAL_VERIFICATION_MALFORMED: { kind: 'inspect', label: 'Inspect the run record' },
  // A verdict about the artifact itself.
  LOCAL_VERIFICATION_FAILED: { kind: 'inspect', label: 'Inspect the imported implementation' },
  SCHEMA_INVALID: { kind: 'inspect', label: 'Inspect the package manifest' },
  // A package that DECLARES a file it does not ship, vs a declared path that is
  // there but cannot be read: fix the input, or repair the path. Neither is an
  // integrity verdict — see INTEGRITY_FAIL, which now means only a digest
  // mismatch on bytes we did read.
  INTEGRITY_ENTRYPOINT_MISSING: { kind: 'inspect', label: 'Supply the declared entrypoint file' },
  INTEGRITY_ENTRYPOINT_UNREADABLE: { kind: 'retry', label: 'Repair the package entrypoint path' },
  INTEGRITY_FAIL: { kind: 'inspect', label: 'Inspect the package integrity evidence' },
  COMPATIBILITY_FAIL: { kind: 'inspect', label: 'Inspect the local requirements' },
  LOCAL_ID_COLLISION: { kind: 'inspect', label: 'Choose a different local alias' },
  // Publisher authentication is provenance only — the action inspects the proof.
  [QUARANTINE_CODE]: { kind: 'inspect', label: 'Review the equivocation proof' },
  IDENTITY_HISTORY_FORK: { kind: 'inspect', label: 'Review the equivocation proof' },
  UNAUTHENTICATED: { kind: 'inspect', label: 'Inspect the publisher proof' },
  PUBLISHER_AUTH_INVALID: { kind: 'inspect', label: 'Inspect the publisher proof' },
  SIGNED_STATEMENT_MISMATCH: { kind: 'inspect', label: 'Inspect the publisher proof' },
  SEQUENCE_ROLLBACK: { kind: 'inspect', label: 'Inspect the publisher proof' },
  KEY_NOT_AUTHORIZED: { kind: 'inspect', label: 'Inspect the publisher proof' },
};

function refusalAction(code, reason) {
  const a = REFUSAL_ACTION[code] || { kind: 'inspect', label: 'Inspect the refusal' };
  return { kind: a.kind, label: a.label, reason: String(reason || '').slice(0, 200) };
}

// Deterministic JSON: recursively sorted keys, no whitespace.
export function canonicalJson(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

// The digest rule — identical on export and import (amendment 1).
export function packageDigest(files) {
  // files: [{ path (relative, posix), bytes: Buffer }] — sorted by path.
  const list = files
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\n${f.bytes.length}\n${sha256(f.bytes)}\n`)
    .join('');
  return sha256(Buffer.from(list, 'utf8'));
}

async function walkFiles(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkFiles(p, base));
    else out.push({ path: relative(base, p).split(sep).join('/'), bytes: await readFile(p) });
  }
  return out;
}

const UNSAFE = [
  [/(?:^|\/)(?:\/Users\/|\/private\/|\/tmp\/)/, 'absolute local path'],
  [/\/(?:Users|private|tmp)\/[A-Za-z0-9._-]+\//, 'absolute local path'],
  [/(~\/\.[a-z-]*secrets|~\/\.ssh|~\/\.aws|\.netrc|id_rsa)/, 'credential store reference'],
];
function scanUnsafe(text, where, failures) {
  for (const [re, why] of UNSAFE) if (re.test(text)) failures.push({ code: 'MUST_NOT_EXPORT', detail: `${why} in ${where}` });
}

// ============================================================== EXPORT (A)
export async function exportCapability({ capabilityId, outDir }) {
  const cfgRes = resolveConfig();
  const cfg = cfgRes.config || {};
  const fr = cfg.flowrouter || null;
  if (!fr || !fr.publisher || !/^[a-z0-9][a-z0-9-]*$/.test(fr.publisher)) {
    return { ok: false, code: 'EXPORT_NOT_CONFIGURED', error: 'flowrouter.publisher is not configured (lowercase slug) — export refused' };
  }
  if (!cfg.registry || !cfg.registry.path) return { ok: false, code: 'REGISTRY_NOT_CONFIGURED', error: 'registry not configured' };
  let registry;
  try { registry = JSON.parse(await readFile(cfg.registry.path, 'utf8')); }
  catch (e) {
    // A read that FAILED is not the same statement as "there is no registry":
    // one asks the operator to repair an installation, the other to create one.
    // Same split as lib/admission.js's workflow-bytes read.
    return e && e.code === 'ENOENT'
      ? { ok: false, code: 'REGISTRY_MISSING', error: 'the configured registry file is not there: ' + cfg.registry.path }
      : { ok: false, code: 'REGISTRY_UNREADABLE', error: 'the configured registry exists but could not be read (' + String((e && e.message) || e).slice(0, 120) + ') — this is a read failure, not an empty registry' };
  }
  const cap = (registry.capabilities || []).find((c) => c.id === capabilityId);
  if (!cap) return { ok: false, code: 'CAPABILITY_NOT_FOUND', error: 'capability not found in this home\u2019s registry: ' + capabilityId };
  if (cap.status !== 'promoted') return { ok: false, code: 'CAPABILITY_NOT_PROMOTED', error: 'only PROMOTED capabilities export (status: ' + cap.status + ')' };
  if ((cap.requiresUnknown || []).length) return { ok: false, code: 'AUTHORITY_SCOPES_UNKNOWN', error: 'capability declares unknown authority scopes — export refused (fail-closed)' };
  const unknownScopes = (cap.requires || []).filter((s) => !SCOPES.includes(s));
  if (unknownScopes.length) return { ok: false, code: 'AUTHORITY_SCOPES_UNDECLARED', error: 'undeclared authority scopes: ' + unknownScopes.join(', ') + ' — export refused' };

  const wfPath = join(cfg.teaching.workflowsDir, cap.workflow + '.yaml');
  let yamlBytes;
  try { yamlBytes = await readFile(wfPath); }
  catch (e) {
    // Same split as the registry read above: the file is absent, or it is there
    // and unreadable. Reporting the second as the first is the collapse this
    // work order exists to remove.
    return e && e.code === 'ENOENT'
      ? { ok: false, code: 'WORKFLOW_BYTES_MISSING', error: 'workflow file missing: ' + cap.workflow }
      : { ok: false, code: 'WORKFLOW_BYTES_UNREADABLE', error: 'the workflow file for ' + cap.workflow + ' is there but could not be read (' + String((e && e.message) || e).slice(0, 120) + ') — this is a read failure, not a missing workflow' };
  }
  const yamlText = yamlBytes.toString('utf8');

  // MUST-NOT-EXPORT enforcement over everything that will ship.
  const unsafe = [];
  scanUnsafe(yamlText, 'workflow implementation', unsafe);
  if (/\b(api[_-]?key|token|secret|password)\s*[:=]/i.test(yamlText)) unsafe.push({ code: 'MUST_NOT_EXPORT', detail: 'credential-like assignment in implementation' });
  if (unsafe.length) return { ok: false, code: 'EXPORT_LEAK_FORBIDDEN', error: 'export refused: package would leak forbidden content', failures: unsafe };

  const implementationDigest = sha256(yamlBytes);
  const sourceTaskId = (cap.provenance || {}).sourceTaskId || null;
  const acqTaskId = (cap.provenance || {}).teachingTaskId || null;
  const evalSet = (cap.provenance || {}).evalSet || [];

  const isImported = !!(cap.source_identity && cap.source_identity.id);
  const manifest = {
    manifest_version: '0.1',
    identity: {
      id: isImported ? cap.source_identity.id : `${fr.publisher}/${cap.id}`,
      version: cap.version || '0.1.0',
      title: (cap.name || cap.id).replace(/^LEARNED —\s*/, '').slice(0, 120),
      description: cap.description || 'LEARNED capability',
      kind: 'workflow',
      publisher: { name: fr.publisher },
    },
    contract: {
      outputs: [
        { name: 'operator_result_lines', type: 'string', description: 'RESULT key=value evidence lines on stdout' },
        { name: 'expectation_marker', type: 'string', description: `terminal marker ${cap.verification && cap.verification.expectOutput ? cap.verification.expectOutput : 'learned-' + cap.workflow + ':done'}` },
      ],
      constraints: ['runs offline', 'deterministic shell', 'no network', 'no credentials'],
      side_effects: { filesystem: 'write', network: 'none', spend_usd_max: 0 },
      idempotent: true,
    },
    implementation: {
      entrypoint: `workflows/${cap.workflow}.yaml`,
      workflow: { ref: `workflows/${cap.workflow}.yaml` },
      bundle: { algorithm: 'sha256', digest: implementationDigest },
    },
    routing: {
      task_signatures: (cap.tags || []).slice(0, 32),
      compatibility: ['rcos'],
    },
    evidence: {
      verdicts: evalSet.map((e) => ({
        task_id: sourceTaskId || 'unknown', verdict: e.pass ? 'ship' : 'blocked', run_id: e.runId, at: null,
      })),
      sources: sourceTaskId ? [{ kind: 'rcos-acquisition', source_task: sourceTaskId }] : [],
    },
    lifecycle: { status: cap.status, admitted_after: cap.admitted_after || [] },
    'x-rcos': {
      required_authority: cap.requires || [],
      provenance: {
        built_by: (cap.provenance || {}).builtBy || null,
        acquisition_task: acqTaskId,
        source_task: sourceTaskId,
        promoted_by: (cap.provenance || {}).promotedBy || null,
      },
      evidence_standard: 'staged-gates + dual-sacred-terminals + independent objective evaluation (Acquisition v2, sealed 7b5c9cc)',
      lineage: [],
      ...(isImported ? {
        import_chain: [
          ...(((cap.provenance || {}).source || {}).import_chain || []),
          {
            imported_by: 'this home',
            source_package_digest: ((cap.provenance || {}).source || {}).package_digest || null,
            local_alias: cap.id,
            verification: ((cap.provenance || {}).import || {}).verification || null,
            admitted_at: ((cap.provenance || {}).import || {}).admitted_at || null,
          },
        ],
        source_evidence_standard: ((cap.provenance || {}).source || {}).evidence_standard || null,
      } : {}),
    },
  };

  // assemble the package; digest = rule with digest fields omitted
  const canonicalNoDigest = Buffer.from(canonicalJson({
    ...manifest,
    implementation: { ...manifest.implementation, bundle: { algorithm: 'sha256' } },
  }), 'utf8');
  const files = [
    { path: 'capability.json', bytes: canonicalNoDigest },
    { path: manifest.implementation.entrypoint, bytes: yamlBytes },
  ];
  const pkgDigest = packageDigest(files);
  manifest.implementation.bundle.package_digest = pkgDigest;

  const pkgDir = join(outDir, fr.publisher, cap.id);
  await mkdir(join(pkgDir, 'workflows'), { recursive: true });
  await writeFile(join(pkgDir, 'capability.json'), canonicalJson(manifest), 'utf8');
  await writeFile(join(pkgDir, manifest.implementation.entrypoint), yamlBytes);
  return {
    ok: true,
    packageDir: pkgDir,
    identity: manifest.identity.id,
    version: manifest.identity.version,
    implementation_digest: implementationDigest,
    package_digest: pkgDigest,
  };
}

// ======================================================== STAGE (B, import)
export async function stagePackage({ packageDir, alias, identityMaterial, expectedTuple }) {
  const cfgRes = resolveConfig();
  const cfg = cfgRes.config || {};
  const t = {
    taskId: 'imp_' + randomUUID().slice(0, 8),
    kind: 'import',
    status: 'staged',
    verdict: 'STAGED',
    packagePath: packageDir, // local task-store record; never exported
    startedAt: isoNow(),
    local: { import: 'STAGED', verification: 'UNVERIFIED', routing: 'INELIGIBLE' },
    checks: [],
    source: {},
  };
  const refuse = async (code, reason) => {
    t.verdict = 'REFUSED';
    t.status = 'refused';
    t.refusal = { code, reason };
    t.nextAction = refusalAction(code, reason);
    t.local.routing = 'INELIGIBLE';
    t.endedAt = isoNow();
    await upsertTask(t);
    return { ok: true, import: t };
  };

  // The package manifest is a REQUEST INPUT — the operator named this package
  // dir — not local durable state, which is why this is not PACKAGE_BYTES_*. It
  // is still the same rule: a read that FAILED must not be reported as a verdict
  // about bytes we hold. ENOENT means "supply the package"; any other read error
  // means the path or the disk is unwell; and a PARSE failure on bytes we DID
  // read stays SCHEMA_INVALID, because a genuine verdict about bytes in hand must
  // not be softened into a read failure.
  const manifestPath = join(packageDir, 'capability.json');
  let manifestRaw;
  try { manifestRaw = await readFile(manifestPath, 'utf8'); }
  catch (e) {
    return e && e.code === 'ENOENT'
      ? refuse('PACKAGE_MANIFEST_MISSING', 'no capability.json in the package dir: ' + manifestPath)
      : refuse('PACKAGE_MANIFEST_UNREADABLE', 'the package manifest exists but could not be read (' + String((e && e.message) || e).slice(0, 120) + ') — this is a read failure, not a malformed package');
  }
  let manifest;
  try { manifest = JSON.parse(manifestRaw); }
  catch { return refuse('SCHEMA_INVALID', 'capability.json is not valid JSON'); }
  t.source = { identity: (manifest.identity || {}).id || null, version: (manifest.identity || {}).version || null, lifecycle: (manifest.lifecycle || {}).status || null };

  // --- schema
  const schemaFails = [];
  if (manifest.manifest_version !== '0.1') schemaFails.push('manifest_version must be "0.1"');
  const id = (manifest.identity || {}).id || '';
  if (!/^[a-z0-9][a-z0-9-_]*\/[a-z0-9][a-z0-9-_]*$/.test(id)) schemaFails.push('identity.id must be publisher/name');
  if (!/^\d+\.\d+\.\d+$/.test((manifest.identity || {}).version || '')) schemaFails.push('identity.version must be semver');
  if (!(manifest.implementation || {}).entrypoint) schemaFails.push('implementation.entrypoint required');
  t.checks.push({ id: 'schema', pass: schemaFails.length === 0, detail: schemaFails.join('; ') || 'manifest v0.1 shape valid' });
  if (schemaFails.length) return refuse('SCHEMA_INVALID', schemaFails.join('; '));

  // --- integrity (amendment 1) — both digests, before anything executes
  //
  // The old bare `catch { INTEGRITY_FAIL }` here reported two different
  // conditions as one: a package that declares an entrypoint it does not ship
  // (the schema check above already guarantees `entrypoint` is non-empty, so
  // "missing" is a real statement about the package), and a declared path that
  // is there but cannot be read. It also reported both as INTEGRITY_FAIL — a
  // DIGEST VERDICT about bytes we never got to hash. INTEGRITY_FAIL now means
  // only what it says (the mismatch check below, on bytes we DID read), because
  // "the digest does not match" and "we never read the bytes" are different
  // operator actions.
  const entryRel = manifest.implementation.entrypoint;
  let yamlBytes;
  try { yamlBytes = await readFile(join(packageDir, entryRel)); }
  catch (e) {
    return e && e.code === 'ENOENT'
      ? refuse('INTEGRITY_ENTRYPOINT_MISSING', 'the package declares an entrypoint it does not ship: ' + entryRel)
      : refuse('INTEGRITY_ENTRYPOINT_UNREADABLE', 'the declared package entrypoint exists but could not be read (' + String((e && e.message) || e).slice(0, 120) + ') — this is a read failure, not an integrity verdict');
  }
  const implDigest = sha256(yamlBytes);
  const declaredImpl = (manifest.implementation.bundle || {}).digest || null;
  const implOk = declaredImpl === implDigest;
  const pkgNoDigest = Buffer.from(canonicalJson({
    ...manifest,
    implementation: { ...manifest.implementation, bundle: { algorithm: (manifest.implementation.bundle || {}).algorithm || 'sha256' } },
  }), 'utf8');
  const pkgDigest = packageDigest([
    { path: 'capability.json', bytes: pkgNoDigest },
    { path: entryRel, bytes: yamlBytes },
  ]);
  const declaredPkg = (manifest.implementation.bundle || {}).package_digest || null;
  const pkgOk = declaredPkg === pkgDigest;
  t.checks.push({ id: 'integrity:implementation', pass: implOk, detail: implOk ? 'implementation digest matches' : `implementation digest mismatch (declared ${String(declaredImpl).slice(0, 16)}…, actual ${implDigest.slice(0, 16)}…)` });
  t.checks.push({ id: 'integrity:package', pass: pkgOk, detail: pkgOk ? 'package digest matches' : `package digest mismatch (declared ${String(declaredPkg).slice(0, 16)}…, actual ${pkgDigest.slice(0, 16)}…)` });
  if (!implOk || !pkgOk) return refuse('INTEGRITY_FAIL', 'authenticity check failed — never executed');

  // ---- P2 publisher authentication (spec v3): INDEPENDENT verification.
  // Everything here is PROVENANCE ONLY — no eligibility code path may read
  // publisher_auth (contract-asserted in scripts/check.js).
  if (identityMaterial) {
    try {
      if (!expectedTuple) throw Object.assign(new Error('staging with publisher material requires the expected discovery/fetch tuple — refusing to authenticate unbound proof'), { code: 'SIGNED_STATEMENT_MISMATCH' });
      const { genesis, events, publication } = identityMaterial;
      const g = verifyGenesis(genesis);
      // F1 (spec e9ef: §6): a locally quarantined publisher — a verified,
      // unacknowledged equivocation proof stands — refuses BEFORE any pin
      // mutation. Admitted capabilities are untouched; the refusal is local.
      if (await isQuarantined(g.publisher_id)) {
        t.publisher = { publisher_auth: 'VERIFIED', freshness: null, publisher_id: g.publisher_id, quarantined: true };
        t.checks.push({ id: 'publisher-equivocation', pass: false, detail: `${QUARANTINE_CODE}: a verified equivocation proof for this publisher stands unacknowledged — no pin mutation, no import` });
        t.verdict = 'REFUSED';
        t.status = 'refused';
        t.refusal = { code: QUARANTINE_CODE, reason: 'publisher is locally quarantined by a verified, unacknowledged equivocation proof' };
        t.nextAction = refusalAction(QUARANTINE_CODE, t.refusal.reason);
        t.endedAt = isoNow();
        await upsertTask(t);
        return { ok: true, import: t };
      }
      const chain = replayChain(genesis, events || []);
      const vp = verifyPublication(publication, chain);
      // frozen structured-tuple identity: the proof must authenticate the
      // EXACT tuple this consumer is importing — a malicious repository
      // rewriting only its outer metadata fails HERE even with valid
      // enclosed signatures.
      const tupleChecks = [
        [expectedTuple.publisher_scheme, publication.publisher_scheme, 'scheme'],
        [expectedTuple.publisher_id, publication.publisher_id, 'publisher_id'],
        [expectedTuple.publisher_id, g.publisher_id, 'verified genesis publisher_id'],
        [expectedTuple.name, publication.name, 'name'],
        [expectedTuple.version, publication.version, 'version'],
        [expectedTuple.D, publication.D, 'D'],
      ];
      for (const [expected, actual, what] of tupleChecks) {
        if (expected !== actual) throw Object.assign(new Error(`${what}: expected ${String(expected).slice(0, 20)} but the proof authenticates ${String(actual).slice(0, 20)}`), { code: 'SIGNED_STATEMENT_MISMATCH' });
      }
      // the assertion must bind THIS artifact's digest
      if (publication.D !== pkgDigest) throw Object.assign(new Error('assertion D does not match the RECOMPUTED package digest'), { code: 'SIGNED_STATEMENT_MISMATCH' });
      // consumer pinning (records live as task-store entries — the two-file law)
      const pinTaskId = 'pin_' + vp.publisher_id; // FULL 64-hex identity — no truncation (two publishers sharing a prefix must never share pins)
      const pinTask = await getTask(pinTaskId);
      const pin = pinTask && pinTask.pin ? { sequence: pinTask.pin.sequence, head_digest: pinTask.pin.head_digest } : null;
      const cls = classifyFreshness(pin, { sequence: chain.head_sequence, head_digest: chain.head_digest });
      if (cls.freshness === 'EXTENDS_LOCAL_PIN' || cls.freshness === 'FIRST_OBSERVATION_UNPROVEN') {
        chainExtendsPin(genesis, events || [], pin); // exact-extension check (fork guard)
      }
      const updatePin = cls.freshness !== 'MATCHES_LOCAL_PIN';
      t.publisher = {
        publisher_auth: 'VERIFIED',
        freshness: cls.freshness,
        publisher_id: vp.publisher_id,
        key_id: vp.key_id,
        identity_sequence: vp.identity_sequence,
        identity_head_digest: vp.identity_head_digest,
        genesis_digest: g.digest,
      };
      t.checks.push({ id: 'publisher-auth', pass: true, detail: `independently verified: publisher_auth=VERIFIED, freshness=${cls.freshness}` });
      if (updatePin) {
        await upsertTask({
          taskId: pinTaskId, kind: 'pin', status: 'active',
          pin: { publisher_id: vp.publisher_id, sequence: chain.head_sequence, head_digest: chain.head_digest },
          // F1 §3.2: the verified identity WITNESS for this exact pinned
          // state — evidence material only (no authority, no verification
          // effect), retained so a later contradiction can be proven offline
          // without any peer. MATCHES_LOCAL_PIN never rewrites it.
          witness: { genesis, events: events || [] },
          updatedAt: isoNow(),
        });
      }
    } catch (e) {
      const code = e.code || 'PUBLISHER_AUTH_INVALID';
      t.publisher = { publisher_auth: code === 'UNAUTHENTICATED' ? 'UNAUTHENTICATED' : 'INVALID', reason: String(e.message).slice(0, 200), failure: code };
      t.checks.push({ id: 'publisher-auth', pass: false, detail: `${code}: ${String(e.message).slice(0, 160)}` });
      // fail-closed per spec §7: an asserted p2-selfcert publication with
      // invalid proof does not proceed as a P2 import
      t.verdict = 'REFUSED';
      t.status = 'refused';
      t.refusal = { code, reason: String(e.message).slice(0, 200) };
      t.nextAction = refusalAction(code, t.refusal.reason);
      t.endedAt = isoNow();
      await upsertTask(t);
      return { ok: true, import: t };
    }
  } else {
    t.publisher = { publisher_auth: 'UNAUTHENTICATED', freshness: null };
  }


  // --- compatibility (authentic ≠ usable here)
  const compatFails = [];
  const reqAuth = (manifest['x-rcos'] || {}).required_authority || [];
  const unknownAuth = reqAuth.filter((s2) => !SCOPES.includes(s2));
  if (unknownAuth.length) compatFails.push('authority scopes not decidable by local policy: ' + unknownAuth.join(', '));
  const tools = (manifest.implementation || {}).tools || [];
  for (const tool of tools) {
    const probe = await new Promise((res) => {
      import('node:child_process').then(({ execFile }) => execFile('/usr/bin/env', ['sh', '-c', 'command -v ' + String(tool).replace(/[^a-z0-9._-]/gi, '')], (e) => res(!e)));
    });
    if (!probe) compatFails.push('required tool unavailable locally: ' + tool);
  }
  if (!((manifest.routing || {}).compatibility || []).includes('rcos')) compatFails.push('package does not declare rcos compatibility');
  t.checks.push({ id: 'compatibility', pass: compatFails.length === 0, detail: compatFails.join('; ') || 'no blocked local requirements' });
  if (compatFails.length) return refuse('COMPATIBILITY_FAIL', compatFails.join('; '));

  // --- collision (amendment 2): never overwrite existing local intelligence
  const localAlias = alias || id.split('/')[1];
  // The collision check reads the SAME durable registry that admission writes.
  // A failed read is not "this home owns nothing": the old `catch {}` collapsed
  // an unreadable registry into an empty capability list, so the check then
  // reported `alias free` for an alias that may well be taken. An unreadable
  // read must never be reported as absence — refuse, and say which.
  let registry;
  try { registry = JSON.parse(await readFile(cfg.registry.path, 'utf8')); }
  catch (e) {
    t.checks.push({ id: 'collision', pass: false, detail: 'the registry could not be read — alias ownership is UNKNOWN, not empty' });
    return e && e.code === 'ENOENT'
      ? refuse('REGISTRY_MISSING', 'the configured registry file is not there: ' + cfg.registry.path + ' — alias ownership cannot be checked')
      : refuse('REGISTRY_UNREADABLE', 'the configured registry exists but could not be read (' + String((e && e.message) || e).slice(0, 120) + ') — alias ownership cannot be checked');
  }
  if ((registry.capabilities || []).some((c) => c.id === localAlias)) {
    t.checks.push({ id: 'collision', pass: false, detail: 'local alias already owned: ' + localAlias });
    return refuse('LOCAL_ID_COLLISION', 'this home already owns "' + localAlias + '" — import refused (pass an explicit non-colliding alias)');
  }
  t.checks.push({ id: 'collision', pass: true, detail: 'alias free: ' + localAlias });

  t.local.alias = localAlias;
  t.manifest = {
    identity: manifest.identity,
    contract: manifest.contract || {},
    implementation: { entrypoint: entryRel, tools, bundle: manifest.implementation.bundle },
    routing: manifest.routing || {},
    evidence: manifest.evidence || {},
    lifecycle: manifest.lifecycle || {},
    xRcos: manifest['x-rcos'] || {},
  };
  t.checks.push({ id: 'staging', pass: true, detail: 'STAGED / UNVERIFIED / INELIGIBLE — local verification required' });
  await upsertTask(t);
  return { ok: true, import: t };
}

// ================================================== LOCAL VERIFICATION (B)
//
// The claim established (amendment 3): B independently observed that the
// imported implementation satisfies its declared contract locally. The
// fixture is B-local, frozen/hashed BEFORE execution, and never derived
// from package material.
// `timing` exists ONLY so the read-classification below is provable with
// deterministic tests; the defaults reproduce the production timing exactly,
// and every production caller omits it.
export async function verifyImport({ importTaskId, fixtureDir, timing }) {
  const cfgRes = resolveConfig();
  const cfg = cfgRes.config || {};
  let t = await getTask(String(importTaskId || '').slice(0, 120));
  if (!t || t.kind !== 'import' || t.status !== 'staged') return { ok: false, code: 'IMPORT_NOT_STAGED', error: 'import task is not STAGED — nothing to verify' };
  if (!cfg.teaching || !cfg.teaching.workspaceDir || !cfg.teaching.workflowsDir) return { ok: false, code: 'TEACHING_NOT_CONFIGURED', error: 'teaching dirs not configured on this home' };

  // freeze the B-local fixture first. The read is CLASSIFIED: a fixture dir that
  // could not be READ is a local-disk failure, while a dir that answered and is
  // empty is a request that pointed at the wrong place. The old single message
  // ("unreadable/empty") made the operator guess which one they had.
  let fixtureFiles = null;
  let fixtureReadError = null;
  try { fixtureFiles = await walkFiles(fixtureDir); } catch (e) { fixtureReadError = e; }
  if (fixtureReadError) {
    return { ok: false, code: 'FIXTURE_UNREADABLE', error: 'the B-local fixture dir could not be read (' + String((fixtureReadError && fixtureReadError.message) || fixtureReadError).slice(0, 120) + ') — this is a read failure, not an empty fixture' };
  }
  if (!fixtureFiles.length) {
    return { ok: false, code: 'FIXTURE_INCOMPLETE', error: 'the B-local fixture dir is empty — local verification needs a B-local fixture (objective.txt + expected.json)' };
  }
  const objective = (fixtureFiles.find((f) => f.path === 'objective.txt') || {}).bytes?.toString('utf8').trim();
  const expectedRaw = (fixtureFiles.find((f) => f.path === 'expected.json') || {}).bytes?.toString('utf8');
  if (!objective || !expectedRaw) return { ok: false, code: 'FIXTURE_INCOMPLETE', error: 'fixture must contain objective.txt and expected.json (B-local truth)' };
  const expected = JSON.parse(expectedRaw);
  const fixtureHash = packageDigest(fixtureFiles.map((f) => ({ path: f.path, bytes: f.bytes })));

  // stage B-local workspace + the imported implementation under its local alias
  const { execFileSync } = await import('node:child_process');
  const { rm } = await import('node:fs/promises');
  await rm(cfg.teaching.workspaceDir, { recursive: true, force: true });
  await mkdir(cfg.teaching.workspaceDir, { recursive: true });
  for (const f of fixtureFiles) {
    if (f.path === 'objective.txt' || f.path === 'expected.json') continue;
    if (f.path.startsWith('workspace/')) {
      const dest = join(cfg.teaching.workspaceDir, f.path.slice('workspace/'.length));
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, f.bytes);
    }
  }
  await mkdir(cfg.teaching.workflowsDir, { recursive: true });
  const localName = t.local.alias + '-v0-1-0';
  // The staged package's own bytes. This read used to be unguarded, so a
  // failure threw to the route catch and left as a 500 carrying a raw fs errno
  // (`ENOENT`/`EACCES`/`EISDIR`) as `code` — a code that is not ours and never
  // passed through the status mapping. Same split as the three reads above:
  // absent and there-but-unreadable are different operator actions.
  const pkgEntryPath = join(t.packagePath, t.manifest.implementation.entrypoint);
  let pkgYaml;
  try { pkgYaml = await readFile(pkgEntryPath); }
  catch (e) {
    return e && e.code === 'ENOENT'
      ? { ok: false, code: 'PACKAGE_BYTES_MISSING', error: 'the staged package entrypoint is not there: ' + pkgEntryPath }
      : { ok: false, code: 'PACKAGE_BYTES_UNREADABLE', error: 'the staged package entrypoint could not be read (' + String((e && e.message) || e).slice(0, 120) + ') — this is a read failure, not a missing package' };
  }
  await writeFile(join(cfg.teaching.workflowsDir, localName + '.yaml'), pkgYaml);

  // execute the IMPORTED implementation on the local executor
  const archon = cfg.archon || {};
  const tm = { settleMs: 2500, startAttempts: 3, startRetryMs: 2000, pollMs: 2000, deadlineMs: 90000, ...(timing || {}) };
  await new Promise((r) => setTimeout(r, tm.settleMs));
  let started = false;
  let startAnswered = false;   // the executor ANSWERED (any HTTP status)
  let startStatus = null;
  let startError = null;       // last transport failure, if it never answered
  for (let i = 0; i < tm.startAttempts && !started; i++) {
    try {
      const res = await fetch(archon.baseUrl.replace(/\/$/, '') + '/api/workflows/' + encodeURIComponent(localName) + '/run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: objective, conversationId: 'import-verify-' + Date.now() }),
      });
      startAnswered = true;
      startStatus = res.status;
      if (res.ok) started = true;
    } catch (e) { startError = String((e && e.message) || e); }
    if (!started) await new Promise((r) => setTimeout(r, tm.startRetryMs));
  }
  if (!started) {
    // Starting the run is itself a READ of external state: a transport failure
    // is an OUTAGE, never "the executor refused this workflow" — the operator
    // must not be told a false thing about the artifact.
    return startAnswered
      ? { ok: false, code: 'EXECUTOR_UNHEALTHY', error: 'local executor answered HTTP ' + startStatus + ' for the imported workflow — the run was not accepted' }
      : { ok: false, code: 'EXECUTOR_UNREACHABLE', error: 'local executor unreachable — the imported workflow could not be started (' + (startError || 'no answer') + '); this is an outage, not a verification result' };
  }

  // Observe the run. The list read is CLASSIFIED: a deadline reached with ZERO
  // successful reads is an outage, not "the run never appeared".
  let entry = null;
  let listReads = 0;
  let listReason = null;
  const deadline = Date.now() + tm.deadlineMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, tm.pollMs));
    try {
      const res = await fetch(archon.baseUrl.replace(/\/$/, '') + '/api/workflows/runs?limit=10');
      if (!res.ok) { listReason = 'the runs list answered HTTP ' + res.status; continue; }
      const lb = await res.json();
      if (!lb || !Array.isArray(lb.runs)) { listReason = 'the runs list response could not be read (no runs array)'; continue; }
      listReads += 1;
      listReason = null;
      entry = lb.runs.find((x) => x.workflow_name === localName) || null;
      if (entry && ['completed', 'failed', 'error', 'cancelled'].includes(String(entry.status || '').toLowerCase())) break;
    } catch (e) { listReason = 'the runs list could not be read (' + String((e && e.message) || e) + ')'; }
  }

  // The evidence read keeps its OWN outcome — never collapsed into ''.
  let evidence = '';
  let evidenceOutcome = 'ABSENT'; // ABSENT: there is no run whose evidence could be read
  let evidenceReason = null;
  if (entry) {
    try {
      const res = await fetch(archon.baseUrl.replace(/\/$/, '') + '/api/workflows/runs/' + entry.id);
      if (!res.ok) { evidenceOutcome = 'UNAVAILABLE'; evidenceReason = 'the run detail answered HTTP ' + res.status; }
      else {
        const d = await res.json();
        if (!d || !Array.isArray(d.events)) { evidenceOutcome = 'MALFORMED'; evidenceReason = 'the run detail carried no events array'; }
        else { evidenceOutcome = 'READ'; evidence = d.events.map((e) => (e.data || {}).node_output ?? '').filter(Boolean).join('\n'); }
      }
    } catch (e) { evidenceOutcome = 'UNAVAILABLE'; evidenceReason = 'the run detail could not be read (' + String((e && e.message) || e) + ')'; }
  }

  // B-local grading: the fixture's OWN expected truth (B-local, pre-frozen).
  // Grading runs ONLY on a READ evidence set — an unreadable one is classified
  // below, never graded as though it were empty.
  let satisfied = false, detail = 'no run';
  if (entry && String(entry.status).toLowerCase() === 'completed' && evidenceOutcome === 'READ') {
    const g = gradeAgainstB(expected, evidence);
    satisfied = g.satisfied; detail = g.detail;
  } else if (entry && String(entry.status).toLowerCase() === 'completed') {
    detail = 'the run completed but its evidence could not be read (' + evidenceReason + ')';
  } else if (entry) detail = 'run status: ' + entry.status;
  const markerOk = evidenceOutcome === 'READ' && (evidence.includes('learned-' + localName + ':done') || /learned-[\w-]+:done/.test(evidence));
  // Name what actually missed. A refusal whose reason quotes the grader while
  // the absent EXPECTATION MARKER is the real failure is a weaker refusal than
  // this codebase's own standard (goal.js names the check that failed).
  if (satisfied && !markerOk) detail = 'the local truth matched but the declared expectation marker (learned-' + localName + ':done) was absent from the run output';

  t.verification = {
    fixture_hash: fixtureHash,
    fixture_frozen_before_execution: true,
    run_id: entry ? entry.id : null,
    run_status: entry ? entry.status : null,
    marker_ok: markerOk,
    grader: { satisfied, detail },
    verified_at: isoNow(),
  };
  const refusal = classifyLocalVerification({
    workflowName: localName, listReads, listReason, entry, evidenceOutcome, evidenceReason,
    verified: satisfied && markerOk, detail,
  });
  t.checks.push({
    id: 'local-verification',
    pass: !refusal,
    detail: refusal
      ? refusal.code + ' — ' + refusal.reason
      : 'B independently observed the declared contract satisfied locally' + (markerOk ? ' (marker present)' : ' — EXPECTATION MARKER MISSING'),
  });
  if (refusal) {
    t.verdict = 'REFUSED';
    t.status = 'refused';
    t.refusal = refusal;
    t.nextAction = refusalAction(refusal.code, refusal.reason);
    t.endedAt = isoNow();
    await upsertTask(t);
    return { ok: true, import: t };
  }
  t.verdict = 'VERIFIED';
  t.status = 'verified';
  t.local.verification = 'VERIFIED';
  t.nextAction = { kind: 'admit', label: 'Admit to Intelligence', reason: 'B-local verification passed on a frozen fixture — admission needs your explicit approval.' };
  await upsertTask(t);
  return { ok: true, import: t };
}

// The local-verification READ classification. Every distinguishable failure of
// the read is named HERE, so an outage is never reported as a statement about
// the imported artifact: a deadline with zero successful list reads is
// UNAVAILABLE, an answered-but-empty read is ABSENT, a present-but-unusable
// record is MALFORMED, and only a run that actually ran and did not satisfy its
// declared contract is FAILED. Returns a refusal { code, reason }, or null when
// verification genuinely passed. Fails closed in every case.
export function classifyLocalVerification({ workflowName, listReads, listReason, entry, evidenceOutcome, evidenceReason, verified, detail }) {
  if (!listReads) {
    return { code: 'LOCAL_VERIFICATION_UNAVAILABLE', reason: 'the local executor could not be read while observing ' + workflowName + ' (' + (listReason || 'no readable response') + ') — no run was observed, so this is an outage, not a failed verification' };
  }
  if (!entry) {
    return { code: 'LOCAL_VERIFICATION_ABSENT', reason: 'the local executor answered and reported no run for ' + workflowName + ' — local verification never ran' };
  }
  if (evidenceOutcome === 'UNAVAILABLE') {
    return { code: 'LOCAL_VERIFICATION_UNAVAILABLE', reason: 'the run for ' + workflowName + ' was observed but its evidence could not be read (' + evidenceReason + ') — this is an outage, not a failed verification' };
  }
  if (evidenceOutcome === 'MALFORMED') {
    return { code: 'LOCAL_VERIFICATION_MALFORMED', reason: 'the run for ' + workflowName + ' was observed but its record is unusable (' + evidenceReason + ') — the evidence cannot be graded' };
  }
  if (!verified) {
    return { code: 'LOCAL_VERIFICATION_FAILED', reason: detail || 'the run did not satisfy the declared contract' };
  }
  return null;
}

// B-local grading: RESULT row=<n> total=<n> family is the P0 fixture's
// contract; the expected.json shape it grades against is B-authored.
function gradeAgainstB(expected, evidence) {
  if (Array.isArray(expected.rows)) {
    const got = [];
    for (const m of (evidence || '').matchAll(/RESULT\s+row=(\d+)\s+total=(\d+)/g)) got.push({ row: m[1], total: m[2] });
    const want = expected.rows.map((r2) => ({ row: String(r2.row), total: String(r2.total) }));
    const ok = want.length === got.length && want.every((w, i) => got[i] && got[i].row === w.row && got[i].total === w.total);
    return { satisfied: ok, detail: ok ? 'all running totals match locally-authored truth' : `local truth mismatch (want ${want.length} rows, got ${got.length})` };
  }
  return { satisfied: false, detail: 'unsupported expected.json shape for the P0 verifier' };
}

// ================================================== ADMISSION (B, operator)
export async function admitImport({ importTaskId, alias }) {
  const cfgRes = resolveConfig();
  const cfg = cfgRes.config || {};
  const t = await getTask(String(importTaskId || '').slice(0, 120));
  if (!t || t.kind !== 'import' || t.status !== 'verified') return { ok: false, code: 'IMPORT_NOT_VERIFIED', error: 'import task is not VERIFIED — nothing to admit' };
  if (!cfg.registry || !cfg.registry.path) return { ok: false, code: 'REGISTRY_NOT_CONFIGURED', error: 'registry not configured' };
  let registry;
  try { registry = JSON.parse(await readFile(cfg.registry.path, 'utf8')); }
  catch (e) {
    // The read is split on ENOENT exactly as lib/admission.js's workflow-bytes
    // read is: `-missing` means "create it", `-unreadable` means "fix it". The
    // old bare catch carried neither, so no caller could tell them apart.
    return e && e.code === 'ENOENT'
      ? { ok: false, code: 'REGISTRY_MISSING', error: 'the configured registry file is not there: ' + cfg.registry.path }
      : { ok: false, code: 'REGISTRY_UNREADABLE', error: 'the configured registry exists but could not be read (' + String((e && e.message) || e).slice(0, 120) + ') — this is a read failure, not an empty registry' };
  }
  const localAlias = alias || t.local.alias;
  if ((registry.capabilities || []).some((c) => c.id === localAlias)) return { ok: false, code: 'LOCAL_ID_COLLISION', error: 'LOCAL_ID_COLLISION — this home already owns "' + localAlias + '"' };
  const localName = localAlias + '-v0-1-0';
  const entry = {
    id: localAlias,
    name: 'IMPORTED — ' + ((t.manifest.identity || {}).title || localAlias),
    kind: 'workflow',
    version: (t.manifest.identity || {}).version || '0.1.0',
    status: 'promoted', // LOCAL lifecycle begins promoted ONLY via this explicit operator admission
    workflow: localName,
    requires: (t.manifest.xRcos || {}).required_authority || [],
    verification: {
      expectOutput: 'learned-' + localName + ':done',
      terminalStatus: 'completed',
    },
    description: (t.manifest.identity || {}).description || '',
    tags: ((t.manifest.routing || {}).task_signatures || []).slice(0, 32),
    source_identity: { id: t.source.identity, version: t.source.version },
    provenance: {
      // source truth — transported evidence, never local authorship
      source: {
        lifecycle: (t.manifest.lifecycle || {}).status || null,
        evidence: (t.manifest.evidence || {}).verdicts || [],
        provenance: (t.manifest.xRcos || {}).provenance || {},
        package_digest: (t.manifest.implementation.bundle || {}).package_digest || null,
        evidence_standard: (t.manifest.xRcos || {}).evidence_standard || null,
      },
      // receiver truth — appended, never rewritten
      import: {
        import_task: t.taskId,
        staged_at: t.startedAt,
        admitted_by: 'operator',
        admitted_at: isoNow(),
        verification: t.verification,
      },
    },
    admitted_after: [],
    evals: [],
    reuse_count: 0,
    last_eval: null,
  };
  registry.capabilities.push(entry);
  await writeFile(cfg.registry.path, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  t.status = 'admitted';
  t.verdict = 'ADMITTED';
  t.local.routing = 'ELIGIBLE';
  t.nextAction = { kind: 'retry', label: 'Run the objective', reason: 'The imported capability is now eligible for normal routing.' };
  await upsertTask(t);
  return { ok: true, import: t, capability: entry };
}
