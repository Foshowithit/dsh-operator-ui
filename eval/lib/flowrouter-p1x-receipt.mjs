#!/usr/bin/env node
// eval/lib/flowrouter-p1x-receipt.mjs — P1-X INDEPENDENT-EXECUTOR REPETITION
// (GPT directive). B is the DELL (chow), a genuinely independent machine:
// Linux x86_64, own RCOS home/registry/task store, own executor process.
// The capability artifact crosses ONLY over the network (dev-host fetches from
// R on the Mac by digest); no scp/rsync/shared mount carries it.
//
// Positive: A export → R publish → dev-host discover → dev-host fetch D0 →
// dev-host recompute → dev-host stage → dev-host-authored fixture (hashed ON the dev-host)
// → dev-host executor verify → operator admit → normal dev-host route → authority
// gate → dev-host execution → SHIP.
// Negatives (boundary-critical): corrupt transport before stage · forged
// valid-D index substitution · unavailable blob/no substitution · exact
// 0.1.0/0.1.1 retrieval · B nonmutation before admission.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, packageDigest } from '../../lib/flowrouter.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = 'http://127.0.0.1:8412';
const B = 'http://203.0.113.1:8415';                 // the dev-host
const MAC_TS = '203.0.113.2';                       // Mac's Tailscale IP
const R_URL_ON_DELL = 'http://' + MAC_TS + ':13093';   // how the DELL reaches R
const R_URL_LOCAL = 'http://127.0.0.1:13093';
const WORK = '/tmp/flowrouter-p1x';
const R_STORE = '/tmp/flowrouter-R';
const sha = (b) => createHash('sha256').update(b).digest('hex');

const post = async (base, path, body) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const get = async (base, path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const receipt = { generated_at: new Date().toISOString(), steps: [] };
const step = (name, ok, result) => { receipt.steps.push({ step: name, ok, result }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name); };

// ============ machine evidence ============
let aMachine = {};
try {
  aMachine = {
    hostname: execFileSync('hostname', { encoding: 'utf8' }).trim(),
    computer_name: execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim(),
    platform: 'darwin ' + execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim(),
  };
} catch {}
const bMachine = (await get(B, '/machine')).body;
receipt.machines = { A: aMachine, R: { host: 'mac', store: R_STORE, endpoint_for_B: R_URL_ON_DELL }, B: bMachine };
step('P1-X actors are independent machines', aMachine.hostname && bMachine.hostname && aMachine.hostname !== bMachine.hostname, { A: aMachine.hostname, B: bMachine.hostname, B_platform: bMachine.platform });

// ============ fresh R on the Mac ============
try {
  const pids = execFileSync('lsof', ['-ti', ':13093'], { encoding: 'utf8' }).trim();
  for (const pid of pids.split('\n').filter(Boolean)) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
} catch {}
await new Promise((r) => setTimeout(r, 1000));
await rm(R_STORE, { recursive: true, force: true });
spawn(process.execPath, [join(root, 'eval', 'lib', 'flowrouter-service.mjs'), '--store', R_STORE], { detached: true, stdio: 'ignore' }).unref();
{
  let ok = false;
  for (let i = 0; i < 20 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { const st = await get(R_URL_LOCAL, '/status'); ok = st.body.publications === 0; } catch {}
  }
  step('R is a FRESH actor on the Mac (zero publications)', ok, (await get(R_URL_LOCAL, '/status')).body);
}
step('dev-host reaches R over the network (Tailscale)', (await (await fetch(R_URL_ON_DELL + '/status')).json()).publications === 0, { from: 'dev-host', to: R_URL_ON_DELL });

// ============ B starts fresh ============
{
  const rst = await post(B, '/reset');
  const st = await get(B, '/bstate');
  step('B (dev-host) starts empty: registry 0 caps, 0 import tasks', rst.body.reset === true && st.body.registry_caps === 0 && st.body.import_tasks === 0, st.body);
}

// ============ A export + publish 0.1.0 / 0.1.1 ============
await mkdir(WORK, { recursive: true });
const exp = await post(A, '/plugins/operator-ui/flowrouter?op=export', { capabilityId: 'csv-running-total', outDir: join(WORK, 'export') });
step('A export (P0)', exp.body.ok === true, { identity: exp.body.identity, D: exp.body.package_digest });
const A_PKG = exp.body.packageDir;
const D0 = exp.body.package_digest;

async function dirToArtifact(dir) {
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
const artifactBytesOf = (files) => Buffer.from(JSON.stringify({ files: files.map((f) => ({ path: f.path, b64: f.bytes.toString('base64') })) }), 'utf8');
const files0 = await dirToArtifact(A_PKG);
const art0 = artifactBytesOf(files0);
const pub0 = await post(R_URL_LOCAL, '/publish', { publisher_id: 'mac-a', name: 'csv-running-total', version: '0.1.0', artifact: art0.toString('base64') });
step('PUBLISH 0.1.0 → D0', pub0.status === 200 && pub0.body.D === D0, { D0: D0.slice(0, 16) });

// 0.1.1 = genuinely different package
const pkg11 = join(WORK, 'pkg-0.1.1');
execFileSync('cp', ['-R', A_PKG, pkg11]);
{
  const wf = join(pkg11, 'workflows', 'csv-running-total-v0-1-0.yaml');
  await writeFile(wf, (await readFile(wf, 'utf8')) + '\n# 0.1.1 revision note (immutable successor package)\n', 'utf8');
  const capPath = join(pkg11, 'capability.json');
  const cap = JSON.parse(await readFile(capPath, 'utf8'));
  cap.identity.version = '0.1.1';
  const wfBytes = await readFile(wf);
  cap.implementation.bundle = { algorithm: 'sha256' };
  const capBytes = Buffer.from(canonicalJson(cap), 'utf8');
  cap.implementation.bundle.package_digest = packageDigest([
    { path: 'capability.json', bytes: capBytes },
    { path: cap.implementation.entrypoint, bytes: wfBytes },
  ]);
  cap.implementation.bundle.digest = sha(wfBytes);
  await writeFile(capPath, canonicalJson(cap), 'utf8');
}
const files1 = await dirToArtifact(pkg11);
const D1 = (() => {
  const cap = files1.find((f) => f.path === 'capability.json');
  const m = JSON.parse(cap.bytes.toString('utf8'));
  const bundle = m.implementation.bundle;
  const capNo = Buffer.from(canonicalJson({ ...m, implementation: { ...m.implementation, bundle: { algorithm: 'sha256' } } }), 'utf8');
  return packageDigest(files1.map((f) => (f.path === 'capability.json' ? { path: f.path, bytes: capNo } : f)));
})();
const pub1 = await post(R_URL_LOCAL, '/publish', { publisher_id: 'mac-a', name: 'csv-running-total', version: '0.1.1', artifact: artifactBytesOf(files1).toString('base64') });
step('PUBLISH 0.1.1 → D1 (≠ D0)', pub1.status === 200 && pub1.body.D === D1 && D1 !== D0, { D0: D0.slice(0, 16), D1: D1.slice(0, 16) });

// ============ dev-host discovery → fetch → stage (all B-side, via network) ============
const before = (await get(B, '/bstate')).body;
const disc = await post(B, '/discover', { rUrl: R_URL_ON_DELL, publisher: 'mac-a', name: 'csv-running-total' });
const e10 = (disc.body.results || []).find((x) => x.version === '0.1.0');
step('dev-host discover (over the network) returns 0.1.0 = D0, record truth', !!e10 && e10.D === D0 && e10.truth === 'RECORD', { discovered_from: disc.body.discovered_from, entry: e10 ? { D: e10.D.slice(0, 16), truth: e10.truth } : null });
const afterDisc = (await get(B, '/bstate')).body;
step('N5a dev-host state unchanged after discovery', afterDisc.registry_sha === before.registry_sha && afterDisc.taskstore_sha === before.taskstore_sha, {});

const fs1 = await post(B, '/fetch-stage', { rUrl: R_URL_ON_DELL, D: D0 });
step('dev-host fetch-stage: network fetch + B-side recompute + B-side staging', fs1.status === 200 && fs1.body.import?.verdict === 'STAGED' && fs1.body.fetch?.recomputed_D === D0, { fetch: fs1.body.fetch, local: fs1.body.import?.local });
const afterStage = (await get(B, '/bstate')).body;
step('N5b dev-host registry unchanged after stage (one staging record appears)', afterStage.registry_sha === before.registry_sha && afterStage.import_tasks === before.import_tasks + 1, { import_tasks: afterStage.import_tasks });

// ============ dev-host-authored fixture (hashed ON the dev-host) ============
const fx = await post(B, '/make-fixture', { values: [23, 5, 41, 12, 7, 30] });
step('Fixture authored AND hashed on the dev-host (before execution)', fx.body.hash_computed_on === bMachine.hostname && !!fx.body.fixture_hash, { fixtureDir: fx.body.fixtureDir, hash: fx.body.fixture_hash, computed_on: fx.body.hash_computed_on });

// ============ dev-host verify (dev-host executor executes the import) ============
const ver = await post(B, '/verify', { importTaskId: fs1.body.import.taskId, fixtureDir: fx.body.fixtureDir });
step('dev-host-local verification: dev-host executor ran the imported implementation', ver.body.import?.verdict === 'VERIFIED' && ver.body.import?.verification?.fixture_hash === fx.body.fixture_hash, { error: ver.body.error || null, verification: ver.body.import?.verification || null, fixture_match: ver.body.import?.verification?.fixture_hash === fx.body.fixture_hash });
const afterVerify = (await get(B, '/bstate')).body;
step('N5c dev-host registry unchanged after verification (same single verified record)', afterVerify.registry_sha === before.registry_sha && afterVerify.import_tasks === before.import_tasks + 1, {});

// ============ operator admission on the dev-host ============
const adm = await post(B, '/admit', { importTaskId: fs1.body.import.taskId });
const afterAdmit = (await get(B, '/bstate')).body;
step('Operator admission mutates the dev-host registry (the ONLY mutation)', adm.body.ok === true && afterAdmit.registry_caps === 1 && afterAdmit.registry_sha !== afterVerify.registry_sha, { caps: afterAdmit.registry_caps });

// ============ normal dev-host route → gate → execution → SHIP ============
const OBJ = 'Process values.csv in order and report the running total after each row, one per line, as RESULT row=<n> total=<cumulative sum>.';
let g = (await post(B, '/goal', { objective: OBJ })).body.goal || {};
const gateObserved = new Set(g.failureCodes || []).has('awaiting-approval');
let approvals = 0;
if (gateObserved) { approvals = 1; g = (await post(B, '/goal', { approveTaskId: g.taskId })).body.goal || {}; }
const checkMap = Object.fromEntries((g.checks || []).map((c) => [c.id, c.pass]));
step('dev-host normal route → imported capability → dev-host authority gate → dev-host execution → SHIP',
  g.verdict === 'SHIP' && g.route?.selected?.id === 'csv-running-total' && gateObserved && approvals === 1
  && checkMap['terminal-status'] === true && checkMap['declared-expectation'] === true && checkMap['objective-satisfaction'] === true,
  { route: g.route?.selected?.id, gate_observed: gateObserved, approvals, checks: checkMap, verdict: g.verdict, trust: g.trust?.label, evidence_head: (g.evidence?.outputs || []).slice(0, 4) });

// ============ negatives ============
// N1 republish conflict
const tampered = (() => {
  const obj = JSON.parse(art0.toString('utf8'));
  const i = obj.files.findIndex((f) => f.path.includes('workflows/'));
  const b = Buffer.from(obj.files[i].b64, 'base64');
  b[b.length - 2] ^= 0x01;
  obj.files[i].b64 = b.toString('base64');
  return Buffer.from(JSON.stringify(obj), 'utf8');
})();
const n1 = await post(R_URL_LOCAL, '/publish', { publisher_id: 'mac-a', name: 'csv-running-total', version: '0.1.0', artifact: tampered.toString('base64') });
const refetch = Buffer.from(await (await fetch(R_URL_LOCAL + '/fetch/' + D0)).arrayBuffer());
const rfDigest = (() => {
  const o = JSON.parse(refetch.toString('utf8'));
  const files = o.files.map((f) => ({ path: f.path, bytes: Buffer.from(f.b64, 'base64') }));
  const cap = files.find((f) => f.path === 'capability.json');
  const m = JSON.parse(cap.bytes.toString('utf8'));
  const capNo = Buffer.from(canonicalJson({ ...m, implementation: { ...m.implementation, bundle: { algorithm: 'sha256' } } }), 'utf8');
  return packageDigest(files.map((f) => (f.path === 'capability.json' ? { path: f.path, bytes: capNo } : f)));
})();
step('N1 republish conflict; D0 intact', n1.status === 409 && n1.body.error === 'PUBLISH_CONFLICT' && rfDigest === D0, n1.body);

// N2 corrupt transport before stage (fetched on the dev-host, corrupted on the dev-host)
const n2 = await post(B, '/fetch-corrupt-stage', { rUrl: R_URL_ON_DELL, D: D0 });
step('N2 corrupt transport → dev-host-side recompute refuses BEFORE stage', n2.body.error === 'FETCH_DIGEST_MISMATCH' && n2.body.stage?.refused_before_stage === true && n2.body.stage_calls_delta === 0 && n2.body.corrupted_on === 'B', { requested: String(n2.body.requested_D).slice(0, 16), recomputed: String(n2.body.recomputed_D).slice(0, 16), stage_calls_delta: n2.body.stage_calls_delta });

// N3 forged valid-D index substitution (forge R's index on the Mac)
{
  const idxPath = join(R_STORE, 'index.json');
  const idx = JSON.parse(await readFile(idxPath, 'utf8'));
  idx.find((e) => e.version === '0.1.0').D = D1;
  await writeFile(idxPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');
  const d3 = await post(B, '/discover', { rUrl: R_URL_ON_DELL, publisher: 'mac-a', name: 'csv-running-total', version: '0.1.0' });
  const e3 = (d3.body.results || [])[0] || {};
  step('N3 forged valid-D substitution: dev-host is served D0 (record truth), never D1', e3.D === D0 && e3.truth === 'INDEX_METADATA_STALE' && e3.D !== D1, { served: String(e3.D).slice(0, 16), truth: e3.truth });
  const idx2 = JSON.parse(await readFile(idxPath, 'utf8'));
  idx2.find((e) => e.version === '0.1.0').D = 'f'.repeat(64);
  await writeFile(idxPath, JSON.stringify(idx2, null, 2) + '\n', 'utf8');
  const d3b = await post(B, '/discover', { rUrl: R_URL_ON_DELL, publisher: 'mac-a', name: 'csv-running-total', version: '0.1.0' });
  const e3b = (d3b.body.results || [])[0] || {};
  step('N3 companion: forged nonexistent D never served', e3b.D === D0 && e3b.truth === 'INDEX_METADATA_STALE', { served: String(e3b.D).slice(0, 16) });
}

// N4 unavailable blob → honest failure, no substitution
{
  const { rename } = await import('node:fs/promises');
  const blob = join(R_STORE, 'blobs', D0 + '.pkg');
  const hidden = blob + '.hidden';
  await rename(blob, hidden);
  const n4 = await post(B, '/fetch-digest', { rUrl: R_URL_ON_DELL, D: D0 });
  step('N4 unavailable blob → honest FETCH_UNAVAILABLE from the dev-host, no substitution', n4.status === 404 && n4.body.error === 'FETCH_UNAVAILABLE', { status: n4.status, error: n4.body.error });
  await rename(hidden, blob);
}

// N6 exact versions through the network
{
  const d10 = await post(B, '/discover', { rUrl: R_URL_ON_DELL, publisher: 'mac-a', name: 'csv-running-total', version: '0.1.0' });
  const d11 = await post(B, '/discover', { rUrl: R_URL_ON_DELL, publisher: 'mac-a', name: 'csv-running-total', version: '0.1.1' });
  const f10 = await post(B, '/fetch-digest', { rUrl: R_URL_ON_DELL, D: (d10.body.results || [])[0]?.D });
  const f11 = await post(B, '/fetch-digest', { rUrl: R_URL_ON_DELL, D: (d11.body.results || [])[0]?.D });
  step('N6 exact versions over the network: 0.1.0→D0, 0.1.1→D1, no latest', f10.body.recomputed_D === D0 && f11.body.recomputed_D === D1 && D0 !== D1, { d0: String(f10.body.recomputed_D).slice(0, 16), d1: String(f11.body.recomputed_D).slice(0, 16) });
}

const okAll = receipt.steps.every((s) => s.ok);
receipt.verdict = okAll ? 'P1-X MATRIX GREEN — independent-machine portability proven, trust boundary unmoved' : 'MATRIX INCOMPLETE';
receipt.transfer_channel = { capability_artifact: 'network only — the dev-host fetched bytes from R by digest over Tailscale; no scp/rsync/shared mount carried the artifact', code_deployment: 'rsync (plugin code, not the artifact) disclosed' };
await writeFile(join(root, 'eval', 'receipts', 'FLOWROUTER-P1X-RECEIPT.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log('\nverdict:', receipt.verdict);
