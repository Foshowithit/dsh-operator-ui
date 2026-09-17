#!/usr/bin/env node
// eval/lib/flowrouter-p1-receipt.mjs — FlowRouter P1 acceptance matrix
// (spec v2 / 874e148). Actors: A (dev lane :8412, owns the promoted
// capability), R (service on :13093), B (fresh lane :8414). Separate actor
// stores; B obtains the remote artifact ONLY through the P1 service
// interface (HTTP), never by reading A's export dir or R's blob store.
//
// Positive: A export → publish → discover → B fetch by D → B recomputes →
// P0 stage → STAGED/INELIGIBLE → B-local verify (fixture frozen+hashed
// before execution) → operator admission → normal route → authority gate
// → execute → SHIP.
// Negatives: N1 republish conflict · N2 corrupt fetch · N3 valid-object
// substitution (the decisive one) + nonexistent-D companion · N4 missing
// blob · N5 nonmutation through discover/fetch/stage · N6 exact versions.

import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, packageDigest } from '../../lib/flowrouter.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = 'http://127.0.0.1:8412';
const R = 'http://127.0.0.1:13093';
const B = 'http://127.0.0.1:8414';
const WORK = '/tmp/flowrouter-p1';
const B_HOME = '/tmp/opui-b-home';
const R_STORE = '/tmp/flowrouter-R';
const sha = (b) => createHash('sha256').update(b).digest('hex');

const frApi = async (base, op, body) => {
  const res = await fetch(`${base}/plugins/operator-ui/flowrouter?op=${op}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const goal = async (body) => {
  const res = await fetch(B + '/plugins/operator-ui/goal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json()).goal || {};
};

// ---- artifact serialization (dir ↔ canonical JSON bytes) ----
async function dirToArtifactFiles(dir) {
  const out = [];
  const walk = async (d, rel) => {
    const { readdir } = await import('node:fs/promises');
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(p, r);
      else out.push({ path: r, bytes: await readFile(p) });
    }
  };
  await walk(dir, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
const artifactBytesOf = (files) => Buffer.from(JSON.stringify({
  files: files.map((f) => ({ path: f.path, b64: f.bytes.toString('base64') })),
}), 'utf8');
async function artifactToDir(bytes, dir) {
  const obj = JSON.parse(bytes.toString('utf8'));
  await rm(dir, { recursive: true, force: true });
  for (const f of obj.files) {
    const dest = join(dir, f.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(f.b64, 'base64'));
  }
  return dir;
}
// P0 digest recomputation over extracted files (amendment-1 rule)
function p0DigestOf(files) {
  const cap = files.find((f) => f.path === 'capability.json');
  const m = JSON.parse(cap.bytes.toString('utf8'));
  const bundle = (m.implementation && m.implementation.bundle) || {};
  const capNoDigest = Buffer.from(canonicalJson({
    ...m, implementation: { ...(m.implementation || {}), bundle: { algorithm: bundle.algorithm || 'sha256' } },
  }), 'utf8');
  return packageDigest(files.map((f) => (f.path === 'capability.json' ? { path: f.path, bytes: capNoDigest } : f)));
}

const bState = async () => ({
  registry_sha: sha(await readFile(join(B_HOME, 'operator-ui', 'b-registry.json'))),
  registry_caps: JSON.parse(await readFile(join(B_HOME, 'operator-ui', 'b-registry.json'), 'utf8')).capabilities.length,
});

const receipt = { generated_at: new Date().toISOString(), steps: [], verdict: null };
const step = (name, ok, result) => { receipt.steps.push({ step: name, ok, result }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name); };

// ================= reset: clean B, clean R =================
await mkdir(WORK, { recursive: true });
await writeFile(join(B_HOME, 'operator-ui', 'b-registry.json'), JSON.stringify({ registry_version: 'rcos-public-v1', capabilities: [] }, null, 2) + '\n', 'utf8');
await rm(R_STORE, { recursive: true, force: true });

// (re)start R
const { spawn } = await import('node:child_process');
try { await fetch(R + '/discover'); } catch {
  spawn(process.execPath, [join(root, 'eval', 'lib', 'flowrouter-service.mjs'), '--store', R_STORE], { detached: true, stdio: 'ignore' }).unref();
  await new Promise((r) => setTimeout(r, 1500));
}

// ================= 1. A exports (P0) =================
const exp = await frApi(A, 'export', { capabilityId: 'csv-running-total', outDir: join(WORK, 'export') });
step('A.export', exp.body.ok === true, { identity: exp.body.identity, D: exp.body.package_digest });
const A_PKG = exp.body.packageDir;
const D0 = exp.body.package_digest;

// ================= 2. publish 0.1.0 =================
const files0 = await dirToArtifactFiles(A_PKG);
const art0 = artifactBytesOf(files0);
const pub0 = await fetch(R + '/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publisher_id: 'mac-a', name: 'csv-running-total', version: '0.1.0', artifact: art0.toString('base64') }) });
const pub0b = await pub0.json();
step('PUBLISH 0.1.0', pub0.status === 200 && pub0b.D === D0, pub0b);

// ================= 3. craft + publish 0.1.1 (genuinely different) =================
const pkg11 = join(WORK, 'pkg-0.1.1');
await cp(A_PKG, pkg11, { recursive: true });
{
  const wf = join(pkg11, 'workflows', 'csv-running-total-v0-1-0.yaml');
  await writeFile(wf, (await readFile(wf, 'utf8')) + '\n# 0.1.1 revision note (immutable successor package)\n', 'utf8');
  const capPath = join(pkg11, 'capability.json');
  const cap = JSON.parse(await readFile(capPath, 'utf8'));
  cap.identity.version = '0.1.1';
  const wfBytes = await readFile(wf);
  const implDigest = sha(wfBytes);
  cap.implementation.bundle = { algorithm: 'sha256' };
  const capBytes = Buffer.from(canonicalJson(cap), 'utf8');
  cap.implementation.bundle.package_digest = packageDigest([
    { path: 'capability.json', bytes: capBytes },
    { path: cap.implementation.entrypoint, bytes: wfBytes },
  ]);
  cap.implementation.bundle.digest = implDigest;
  await writeFile(capPath, canonicalJson(cap), 'utf8');
}
const files1 = await dirToArtifactFiles(pkg11);
const art1 = artifactBytesOf(files1);
const D1 = p0DigestOf(files1);
const pub1 = await fetch(R + '/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publisher_id: 'mac-a', name: 'csv-running-total', version: '0.1.1', artifact: art1.toString('base64') }) });
const pub1b = await pub1.json();
step('PUBLISH 0.1.1 (D1 ≠ D0)', pub1.status === 200 && pub1b.D === D1 && D1 !== D0, { D0: D0.slice(0, 16), D1: D1.slice(0, 16) });

// ================= 4. discovery (validated against records) =================
const disc = await (await fetch(R + '/discover?publisher=mac-a&name=csv-running-total')).json();
const e10 = (disc.results || []).find((x) => x.version === '0.1.0');
step('DISCOVER returns 0.1.0 with D0 (record truth)', !!e10 && e10.D === D0 && e10.truth === 'RECORD', { entry: e10 });

// ================= 5. POSITIVE: B fetch → stage → verify → admit → route =================
const before = await bState();
const fetched = Buffer.from(await (await fetch(R + '/fetch/' + D0)).arrayBuffer());
const bFiles = JSON.parse(fetched.toString('utf8')).files.map((f) => ({ path: f.path, bytes: Buffer.from(f.b64, 'base64') }));
const bRecomputed = p0DigestOf(bFiles);
step('B fetch(D0) → recompute equals D0', bRecomputed === D0, { recomputed: bRecomputed.slice(0, 16) });
const incoming = await artifactToDir(fetched, join(WORK, 'b-incoming'));
const stageB = await frApi(B, 'stage', { packageDir: incoming });
const afterStage = await bState();
step('P0 STAGE on fetched bytes', stageB.body.import?.verdict === 'STAGED', { checks: (stageB.body.import?.checks || []).map((c) => c.id + ':' + c.pass), local: stageB.body.import?.local });
step('N5a registry unchanged after discover+fetch+stage', before.registry_sha === afterStage.registry_sha && afterStage.registry_caps === 0, { before_caps: before.registry_caps, after_caps: afterStage.registry_caps });

// B-local fixture (authored here; frozen+hashed before execution)
const FIX = join(WORK, 'b-fixture');
await rm(FIX, { recursive: true, force: true });
await mkdir(join(FIX, 'workspace'), { recursive: true });
const vals = [19, 8, 33, 4, 24, 11];
let acc = 0;
const rows = vals.map((v, i) => { acc += v; return { row: String(i + 1), total: String(acc) }; });
await writeFile(join(FIX, 'workspace', 'values.csv'), 'value\n' + vals.join('\n') + '\n', 'utf8');
await writeFile(join(FIX, 'objective.txt'), 'Process values.csv in order and report the running total after each row, one per line, as RESULT row=<n> total=<cumulative sum>.\n', 'utf8');
await writeFile(join(FIX, 'expected.json'), JSON.stringify({ rows }, null, 2) + '\n', 'utf8');
const verB = await frApi(B, 'verify', { importTaskId: stageB.body.import.taskId, fixtureDir: FIX });
step('B-local verification (frozen fixture)', verB.body.import?.verdict === 'VERIFIED', verB.body.import?.verification);
const preAdmit = await bState();
step('N5b registry unchanged after B-local verification', preAdmit.registry_sha === afterStage.registry_sha, {});
const admB = await frApi(B, 'admit', { importTaskId: stageB.body.import.taskId });
const postAdmit = await bState();
step('operator admission mutates the registry (the ONLY mutation)', postAdmit.registry_caps === 1 && postAdmit.registry_sha !== preAdmit.registry_sha, { caps: postAdmit.registry_caps });

let g = await goal({ objective: 'Process values.csv in order and report the running total after each row, one per line, as RESULT row=<n> total=<cumulative sum>.' });
let approvals = 0;
if (new Set(g.failureCodes || []).has('awaiting-approval')) { approvals += 1; g = await goal({ approveTaskId: g.taskId }); }
step('B normal route → authority gate → SHIP', g.verdict === 'SHIP', { route: g.route?.selected?.id, checks: (g.checks || []).map((c) => c.id + ':' + c.pass), approvals, trust: g.trust?.label });

// ================= 6. NEGATIVES =================
// N1 republish conflict
const tamperedArt = (() => {
  const obj = JSON.parse(art0.toString('utf8'));
  const wfIdx = obj.files.findIndex((f) => f.path.includes('workflows/'));
  const b = Buffer.from(obj.files[wfIdx].b64, 'base64');
  b[b.length - 2] ^= 0x01;
  obj.files[wfIdx].b64 = b.toString('base64');
  return Buffer.from(JSON.stringify(obj), 'utf8');
})();
const n1 = await fetch(R + '/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publisher_id: 'mac-a', name: 'csv-running-total', version: '0.1.0', artifact: tamperedArt.toString('base64') }) });
const n1b = await n1.json();
const refetch = Buffer.from(await (await fetch(R + '/fetch/' + D0)).arrayBuffer());
const refetchP = p0DigestOf(JSON.parse(refetch.toString('utf8')).files.map((f) => ({ path: f.path, bytes: Buffer.from(f.b64, 'base64') })));
step('N1 republish conflict; original D0 intact', n1.status === 409 && n1b.error === 'PUBLISH_CONFLICT' && refetchP === D0, n1b);

// N2 corrupt fetched bytes
const corrupt = (() => {
  const obj = JSON.parse(art0.toString('utf8'));
  const wfIdx = obj.files.findIndex((f) => f.path.includes('workflows/'));
  const s = obj.files[wfIdx].b64;
  obj.files[wfIdx].b64 = s.slice(0, -4) + (s.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  return Buffer.from(JSON.stringify(obj), 'utf8');
})();
const corruptDir = await artifactToDir(corrupt, join(WORK, 'b-corrupt'));
const n2 = await frApi(B, 'stage', { packageDir: corruptDir, alias: 'corrupt-copy' });
const n2Checks = n2.body.import?.checks || [];
step('N2 corrupt fetch bytes fail integrity, never staged', n2.body.import?.refusal?.code === 'INTEGRITY_FAIL' && n2Checks.filter((c) => c.id.startsWith('integrity')).every((c) => !c.pass) && n2.body.import?.verification?.run_id == null, { refusal: n2.body.import?.refusal, integrity: n2Checks.filter((c) => c.id.startsWith('integrity')).map((c) => c.pass) });

// N3 valid-object substitution — the decisive one
{
  const idxPath = join(R_STORE, 'index.json');
  const idx = JSON.parse(await readFile(idxPath, 'utf8'));
  const target = idx.find((e) => e.version === '0.1.0');
  target.D = D1; // forge: point 0.1.0 at a VALID other package
  await writeFile(idxPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');
  const d3 = await (await fetch(R + '/discover?publisher=mac-a&name=csv-running-total&version=0.1.0')).json();
  const e3 = (d3.results || [])[0] || {};
  const servedD0 = e3.D === D0;
  const flagged = e3.truth === 'INDEX_METADATA_STALE';
  step('N3 valid-object substitution refused (record authority)', servedD0 && flagged && e3.D !== D1, { served_D: String(e3.D).slice(0, 16), truth: e3.truth, reason: e3.reason });
  // companion: forge to a NONEXISTENT digest
  const idx2 = JSON.parse(await readFile(idxPath, 'utf8'));
  idx2.find((e) => e.version === '0.1.0').D = 'f'.repeat(64);
  await writeFile(idxPath, JSON.stringify(idx2, null, 2) + '\n', 'utf8');
  const d3b = await (await fetch(R + '/discover?publisher=mac-a&name=csv-running-total&version=0.1.0')).json();
  const e3b = (d3b.results || [])[0] || {};
  step('N3 companion: forged nonexistent D never served', e3b.D === D0 && e3b.truth === 'INDEX_METADATA_STALE', { served_D: String(e3b.D).slice(0, 16), truth: e3b.truth });
}

// N4 unavailable blob
{
  const { rename } = await import('node:fs/promises');
  const blobPath = join(R_STORE, 'blobs', D0 + '.pkg');
  const hidden = join(R_STORE, 'blobs', D0 + '.pkg.hidden');
  await rename(blobPath, hidden);
  const n4 = await fetch(R + '/fetch/' + D0);
  const n4b = await n4.json().catch(() => ({}));
  step('N4 missing blob → honest FETCH_UNAVAILABLE', n4.status === 404 && n4b.error === 'FETCH_UNAVAILABLE', n4b);
  await rename(hidden, blobPath);
}

// N6 exact-version semantics
{
  const d10 = await (await fetch(R + '/discover?publisher=mac-a&name=csv-running-total&version=0.1.0')).json();
  const d11 = await (await fetch(R + '/discover?publisher=mac-a&name=csv-running-total&version=0.1.1')).json();
  const f10 = Buffer.from(await (await fetch(R + '/fetch/' + d10.results[0].D)).arrayBuffer());
  const f11 = Buffer.from(await (await fetch(R + '/fetch/' + d11.results[0].D)).arrayBuffer());
  const p10 = p0DigestOf(JSON.parse(f10.toString('utf8')).files.map((f) => ({ path: f.path, bytes: Buffer.from(f.b64, 'base64') })));
  const p11 = p0DigestOf(JSON.parse(f11.toString('utf8')).files.map((f) => ({ path: f.path, bytes: Buffer.from(f.b64, 'base64') })));
  step('N6 exact versions: 0.1.0→D0, 0.1.1→D1, no latest', p10 === D0 && p11 === D1 && D0 !== D1, { p10: p10.slice(0, 16), p11: p11.slice(0, 16) });
}

// verdict
const okAll = receipt.steps.every((s) => s.ok);
receipt.verdict = okAll ? 'P1 MATRIX GREEN — transport proven, trust boundary unmoved' : 'MATRIX INCOMPLETE';
receipt.actor_isolation = { A_home: '/tmp/opui-m1-home', R_store: R_STORE, B_home: B_HOME, transport: 'HTTP only (B fetched via /fetch, never read R blob store or A export dir)' };
await writeFile(join(root, 'eval', 'records', 'productization', 'FLOWROUTER-P1-RECEIPT.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log('\nverdict:', receipt.verdict);
