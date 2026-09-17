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
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, relative, sep, dirname } from 'node:path';
import { resolveConfig } from './config.js';
import { getTask, upsertTask } from './tasks.js';
import { SCOPES } from './authority.js';
import { evaluateObjective } from './goal.js';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isoNow = () => new Date().toISOString();

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
    return { ok: false, error: 'flowrouter.publisher is not configured (lowercase slug) — export refused' };
  }
  if (!cfg.registry || !cfg.registry.path) return { ok: false, error: 'registry not configured' };
  let registry;
  try { registry = JSON.parse(await readFile(cfg.registry.path, 'utf8')); } catch (e) { return { ok: false, error: 'registry unreadable' }; }
  const cap = (registry.capabilities || []).find((c) => c.id === capabilityId);
  if (!cap) return { ok: false, error: 'capability not found in this home\u2019s registry: ' + capabilityId };
  if (cap.status !== 'promoted') return { ok: false, error: 'only PROMOTED capabilities export (status: ' + cap.status + ')' };
  if ((cap.requiresUnknown || []).length) return { ok: false, error: 'capability declares unknown authority scopes — export refused (fail-closed)' };
  const unknownScopes = (cap.requires || []).filter((s) => !SCOPES.includes(s));
  if (unknownScopes.length) return { ok: false, error: 'undeclared authority scopes: ' + unknownScopes.join(', ') + ' — export refused' };

  const wfPath = join(cfg.teaching.workflowsDir, cap.workflow + '.yaml');
  let yamlBytes;
  try { yamlBytes = await readFile(wfPath); } catch { return { ok: false, error: 'workflow file missing: ' + cap.workflow }; }
  const yamlText = yamlBytes.toString('utf8');

  // MUST-NOT-EXPORT enforcement over everything that will ship.
  const unsafe = [];
  scanUnsafe(yamlText, 'workflow implementation', unsafe);
  if (/\b(api[_-]?key|token|secret|password)\s*[:=]/i.test(yamlText)) unsafe.push({ code: 'MUST_NOT_EXPORT', detail: 'credential-like assignment in implementation' });
  if (unsafe.length) return { ok: false, error: 'export refused: package would leak forbidden content', failures: unsafe };

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
export async function stagePackage({ packageDir, alias }) {
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
    t.local.routing = 'INELIGIBLE';
    t.endedAt = isoNow();
    await upsertTask(t);
    return { ok: true, import: t };
  };

  let manifest;
  try { manifest = JSON.parse(await readFile(join(packageDir, 'capability.json'), 'utf8')); }
  catch { return refuse('SCHEMA_INVALID', 'capability.json missing or unreadable'); }
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
  const entryRel = manifest.implementation.entrypoint;
  let yamlBytes;
  try { yamlBytes = await readFile(join(packageDir, entryRel)); }
  catch { return refuse('INTEGRITY_FAIL', 'entrypoint file missing from package'); }
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
  let registry = { capabilities: [] };
  try { registry = JSON.parse(await readFile(cfg.registry.path, 'utf8')); } catch {}
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
export async function verifyImport({ importTaskId, fixtureDir }) {
  const cfgRes = resolveConfig();
  const cfg = cfgRes.config || {};
  let t = await getTask(String(importTaskId || '').slice(0, 120));
  if (!t || t.kind !== 'import' || t.status !== 'staged') return { ok: false, error: 'import task is not STAGED — nothing to verify' };
  if (!cfg.teaching || !cfg.teaching.workspaceDir || !cfg.teaching.workflowsDir) return { ok: false, error: 'teaching dirs not configured on this home' };

  // freeze the B-local fixture first
  const fixtureFiles = await walkFiles(fixtureDir).catch(() => null);
  if (!fixtureFiles || !fixtureFiles.length) return { ok: false, error: 'fixture dir unreadable/empty — local verification needs a B-local fixture' };
  const objective = (fixtureFiles.find((f) => f.path === 'objective.txt') || {}).bytes?.toString('utf8').trim();
  const expectedRaw = (fixtureFiles.find((f) => f.path === 'expected.json') || {}).bytes?.toString('utf8');
  if (!objective || !expectedRaw) return { ok: false, error: 'fixture must contain objective.txt and expected.json (B-local truth)' };
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
  const pkgYaml = await readFile(join(t.packagePath, t.manifest.implementation.entrypoint));
  await writeFile(join(cfg.teaching.workflowsDir, localName + '.yaml'), pkgYaml);

  // execute the IMPORTED implementation on the local executor
  const archon = cfg.archon || {};
  await new Promise((r) => setTimeout(r, 2500));
  let started = false;
  for (let i = 0; i < 3 && !started; i++) {
    try {
      const res = await fetch(archon.baseUrl.replace(/\/$/, '') + '/api/workflows/' + encodeURIComponent(localName) + '/run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: objective, conversationId: 'import-verify-' + Date.now() }),
      });
      if (res.ok) started = true;
    } catch {}
    if (!started) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!started) return { ok: false, error: 'local executor refused the imported workflow' };
  let entry = null;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const lb = await (await fetch(archon.baseUrl.replace(/\/$/, '') + '/api/workflows/runs?limit=10')).json();
      entry = (lb.runs || []).find((x) => x.workflow_name === localName) || null;
      if (entry && ['completed', 'failed', 'error', 'cancelled'].includes(String(entry.status || '').toLowerCase())) break;
    } catch {}
  }
  const evidence = entry ? await (async () => {
    try {
      const d = await (await fetch(archon.baseUrl.replace(/\/$/, '') + '/api/workflows/runs/' + entry.id)).json();
      return ((d.events || []).map((e) => (e.data || {}).node_output ?? '').filter(Boolean)).join('\n');
    } catch { return ''; }
  })() : '';

  // B-local grading: the fixture's OWN expected truth (B-local, pre-frozen)
  let satisfied = false, detail = 'no run';
  if (entry && String(entry.status).toLowerCase() === 'completed') {
    const g = gradeAgainstB(expected, evidence);
    satisfied = g.satisfied; detail = g.detail;
  } else if (entry) detail = 'run status: ' + entry.status;
  const markerOk = evidence.includes('learned-' + localName + ':done') || /learned-[\w-]+:done/.test(evidence);

  t.verification = {
    fixture_hash: fixtureHash,
    fixture_frozen_before_execution: true,
    run_id: entry ? entry.id : null,
    run_status: entry ? entry.status : null,
    marker_ok: markerOk,
    grader: { satisfied, detail },
    verified_at: isoNow(),
  };
  t.checks.push({ id: 'local-verification', pass: satisfied && markerOk, detail: satisfied ? 'B independently observed the declared contract satisfied locally' + (markerOk ? ' (marker present)' : ' — EXPECTATION MARKER MISSING') : detail });
  if (!(satisfied && markerOk)) {
    t.verdict = 'REFUSED';
    t.status = 'refused';
    t.refusal = { code: 'LOCAL_VERIFICATION_FAILED', reason: detail };
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
  if (!t || t.kind !== 'import' || t.status !== 'verified') return { ok: false, error: 'import task is not VERIFIED — nothing to admit' };
  if (!cfg.registry || !cfg.registry.path) return { ok: false, error: 'registry not configured' };
  let registry;
  try { registry = JSON.parse(await readFile(cfg.registry.path, 'utf8')); } catch { return { ok: false, error: 'registry unreadable' }; }
  const localAlias = alias || t.local.alias;
  if ((registry.capabilities || []).some((c) => c.id === localAlias)) return { ok: false, error: 'LOCAL_ID_COLLISION — this home already owns "' + localAlias + '"' };
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
