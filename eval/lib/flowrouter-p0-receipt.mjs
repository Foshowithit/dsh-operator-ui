#!/usr/bin/env node
// eval/lib/flowrouter-p0-receipt.mjs — FlowRouter Portability P0 acceptance
// matrix (GPT-adjudicated): positive round trip A→B + tamper negative +
// compatibility negative + collision negative + lineage-preserving re-export.
//
// Homes: A = the dev lane (:8412, owns the promoted csv-running-total),
// B = a fresh lane (:8414, own DSH_HOME + own empty registry, no knowledge
// of the capability). Transport: local directories only — no networking.
//
// The B-local fixture is authored HERE, independently of any package
// material, and its digest is recorded before B executes the imported
// implementation (amendment 3).

import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = 'http://127.0.0.1:8412';
const B = 'http://127.0.0.1:8414';
const WORK = '/tmp/flowrouter-p0';
const sha = (b) => createHash('sha256').update(b).digest('hex');

const post = async (base, op, body) => {
  const res = await fetch(`${base}/plugins/operator-ui/flowrouter?op=${op}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const postGoal = async (base, body) => {
  const res = await fetch(base + '/plugins/operator-ui/goal', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return (await res.json()).goal || {};
};

const receipt = { generated_at: new Date().toISOString(), steps: [], verdict: null };

// idempotency: reset B to a clean home (empty registry + no admitted workflow)
const B_HOME = '/tmp/opui-b-home';
await writeFile(join(B_HOME, 'operator-ui', 'b-registry.json'), JSON.stringify({ registry_version: 'rcos-public-v1', capabilities: [] }, null, 2) + '\n', 'utf8');
// A's implementation file must remain in the shared executor catalog
// (one Archon instance serves both homes in this P0 receipt); restore it
// from the last export so re-runs are deterministic.
try {
  const prior = await readFile(join(WORK, 'export', 'mac-a', 'csv-running-total', 'workflows', 'csv-running-total-v0-1-0.yaml'));
  await writeFile('/tmp/opui-rc0-archon/workflows/csv-running-total-v0-1-0.yaml', prior);
} catch {}

// ---- B-local fixture: authored independently (new data, own truth) ----
const bVals = [14, 27, 9, 41, 6, 33, 18];
let acc = 0;
const bRows = bVals.map((v, i) => { acc += v; return { row: String(i + 1), total: String(acc) }; });
const FIX = join(WORK, 'b-fixture');
await rm(FIX, { recursive: true, force: true });
await mkdir(join(FIX, 'workspace'), { recursive: true });
const csv = 'value\n' + bVals.join('\n') + '\n';
await writeFile(join(FIX, 'workspace', 'values.csv'), csv, 'utf8');
const objective = 'Process values.csv in order and report the running total after each row, one per line, as RESULT row=<n> total=<cumulative sum>.';
await writeFile(join(FIX, 'objective.txt'), objective + '\n', 'utf8');
await writeFile(join(FIX, 'expected.json'), JSON.stringify({ rows: bRows }, null, 2) + '\n', 'utf8');
receipt.b_local_fixture = {
  authored_locally: true,
  values: bVals,
  expected: bRows,
  csv_sha256: sha(Buffer.from(csv, 'utf8')),
  note: 'authored by the receipt harness; not derived from any package material; digest recorded before B executes the import',
};

// ---- 1. POSITIVE: A exports the promoted capability ----
await mkdir(WORK, { recursive: true });
const exp = await post(A, 'export', { capabilityId: 'csv-running-total', outDir: join(WORK, 'export') });
receipt.steps.push({ step: 'A.export', ok: exp.body.ok === true, result: exp.body });
if (!exp.body.ok) { console.log('EXPORT FAILED:', exp.body); process.exit(1); }
const pkg = exp.body.packageDir;
const goodCopy = join(WORK, 'pkg-good');
const tamperCopy = join(WORK, 'pkg-tampered');
const compatCopy = join(WORK, 'pkg-compat-negative');
const reCopy = join(WORK, 'pkg-reexport');

// ---- 2. B stages the authentic package ----
const stage = await post(B, 'stage', { packageDir: pkg });
receipt.steps.push({ step: 'B.stage(positive)', ok: stage.body.ok === true, result: { verdict: stage.body.import?.verdict, local: stage.body.import?.local, checks: stage.body.import?.checks } });
const importId = stage.body.import?.taskId;

// ---- 3. B locally verifies against the frozen B-local fixture ----
const ver = await post(B, 'verify', { importTaskId: importId, fixtureDir: FIX });
receipt.steps.push({ step: 'B.verify', ok: ver.body.import?.verdict === 'VERIFIED', result: { verdict: ver.body.import?.verdict, verification: ver.body.import?.verification } });

// ---- 4. operator admission ----
const adm = await post(B, 'admit', { importTaskId: importId });
receipt.steps.push({ step: 'B.admit', ok: adm.body.ok === true, result: { capability: adm.body.capability ? { id: adm.body.capability.id, source_identity: adm.body.capability.source_identity, provenance_source: adm.body.capability.provenance.source, provenance_import: adm.body.capability.provenance.import } : adm.body.error } });

// ---- 5. B routes the objective to the imported capability ----
let g = await postGoal(B, { objective });
let approvals = 0;
const codes = new Set(g.failureCodes || []);
if (codes.has('awaiting-approval')) { approvals += 1; g = await postGoal(B, { approveTaskId: g.taskId }); }
receipt.steps.push({
  step: 'B.route+ship', ok: g.verdict === 'SHIP',
  result: { route: g.route?.selected?.id || null, verdict: g.verdict, checks: (g.checks || []).map((c) => ({ id: c.id, pass: c.pass })), trust: g.trust?.label, approvals, evidence_head: ((g.evidence || {}).outputs || []).slice(0, 6) },
});

// ---- NEGATIVE A: tampered implementation ----
await cp(pkg, tamperCopy, { recursive: true });
const yml = join(tamperCopy, 'workflows', 'csv-running-total-v0-1-0.yaml');
const y = await readFile(yml, 'utf8');
await writeFile(yml, y.replace('RESULT row=', 'RESULT rzow='), 'utf8'); // one-byte-class alteration
const tamper = await post(B, 'stage', { packageDir: tamperCopy, alias: 'tampered-alias' });
const tChecks = tamper.body.import?.checks || [];
receipt.steps.push({
  step: 'NEGATIVE-A.tamper', ok: tamper.body.import?.refusal?.code === 'INTEGRITY_FAIL',
  result: { refusal: tamper.body.import?.refusal, integrity: tChecks.filter((c) => c.id.startsWith('integrity')), executed: tamper.body.import?.verification?.run_id ?? null, routing: tamper.body.import?.local?.routing },
});

// ---- NEGATIVE B: authentic package, incompatible local requirement ----
// crafted with the SAME digest rule (authenticity holds), but declares a
// tool this machine does not have → integrity PASS, compatibility FAIL.
await cp(pkg, compatCopy, { recursive: true });
{
  const { canonicalJson, packageDigest } = await import('../../lib/flowrouter.js');
  const capPath = join(compatCopy, 'capability.json');
  const capJson = JSON.parse(await readFile(capPath, 'utf8'));
  capJson.implementation.tools = ['zztool-not-installed-here'];
  // mirror EXACTLY the importer's canonical form for the digest: bundle = {algorithm} only
  const implDigest = capJson.implementation.bundle.digest;
  capJson.implementation.bundle = { algorithm: 'sha256' };
  const capBytes = Buffer.from(canonicalJson(capJson), 'utf8');
  const wfBytes = await readFile(join(compatCopy, capJson.implementation.entrypoint));
  const newDigest = packageDigest([{ path: 'capability.json', bytes: capBytes }, { path: capJson.implementation.entrypoint, bytes: wfBytes }]);
  capJson.implementation.bundle = { algorithm: 'sha256', digest: implDigest, package_digest: newDigest };
  await writeFile(capPath, canonicalJson(capJson), 'utf8');
}
const compat = await post(B, 'stage', { packageDir: compatCopy, alias: 'compat-negative-alias' });
const cChecks = compat.body.import?.checks || [];
receipt.steps.push({
  step: 'NEGATIVE-B.compat', ok: compat.body.import?.refusal?.code === 'COMPATIBILITY_FAIL',
  result: { refusal: compat.body.import?.refusal, integrity: cChecks.filter((c) => c.id.startsWith('integrity')).map((c) => c.pass), executed: compat.body.import?.verification?.run_id ?? null, routing: compat.body.import?.local?.routing },
});

// ---- NEGATIVE C: collision on an owned alias ----
const collide = await post(B, 'stage', { packageDir: pkg });
receipt.steps.push({ step: 'NEGATIVE-C.collision', ok: collide.body.import?.refusal?.code === 'LOCAL_ID_COLLISION', result: { refusal: collide.body.import?.refusal } });

// ---- RE-EXPORT from B: lineage preserved + appended ----
const re = await post(B, 'export', { capabilityId: 'csv-running-total', outDir: join(WORK, 'reexport') });
let reInfo = re.body;
try {
  const reCap = JSON.parse(await readFile(join(re.body.packageDir, 'capability.json'), 'utf8'));
  reInfo = {
    identity_id: reCap.identity.id,
    provenance: reCap['x-rcos'].provenance,
    import_chain_len: (reCap['x-rcos'].import_chain || []).length,
    first_import_entry: (reCap['x-rcos'].import_chain || [])[0] || null,
  };
} catch {}
receipt.steps.push({ step: 'RE-EXPORT.lineage', ok: re.body.ok === true && reInfo.identity_id === exp.body.identity, result: reInfo });

// ---- verdict ----
const okAll = receipt.steps.every((s) => s.ok);
receipt.verdict = okAll ? 'P0 MATRIX GREEN — positive round trip + 3 negatives + lineage re-export' : 'MATRIX INCOMPLETE';
await mkdir(join(root, 'eval', 'records', 'productization'), { recursive: true });
await writeFile(join(root, 'eval', 'records', 'productization', 'FLOWROUTER-P0-RECEIPT.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log('\n==== FLOWROUTER P0 RECEIPT ====');
for (const s of receipt.steps) console.log((s.ok ? 'PASS' : 'FAIL') + '  ' + s.step);
console.log('verdict:', receipt.verdict);
