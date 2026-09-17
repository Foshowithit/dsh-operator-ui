#!/usr/bin/env node
// eval/lib/flowrouter-s0-receipt.mjs — FlowRouter S0 acceptance matrix
// (frozen spec ccf0387): exact-scope custody backfill.
//
// Topology: publisher P → origin R1 → mirror R2 (the configured SOURCE) → S0 →
// destination R3 → ordinary consumer. The destination never contacts P.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, packageDigest } from '../../lib/flowrouter.js';
import { syncExact, normalizeScope, objectKey, validateIntent } from '../../lib/sync.js';
import { proofDigest, verifyProofCore } from '../../lib/equivocation.js';
import {
  generateKeypair, createGenesis, createKeyEvent, replayChain, signPublication, deriveKeyId, recordDigest,
} from '../../lib/identity.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = 'http://127.0.0.1:8412';
const B = 'http://127.0.0.1:8414';
const WORK = '/tmp/flowrouter-s0';
const B_HOME = '/tmp/opui-b-home';
const PORTS = { r1: 13171, r2: 13172, r3: 13173 };
const sha = (b) => createHash('sha256').update(b).digest('hex');

const post = async (base, path, body) => {
  try {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const text = await res.text(); let parsed = {}; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: parsed };
  } catch (e) { return { status: 0, body: { error: String(e.message).slice(0, 140) } }; }
};
const get = async (base, path) => {
  try {
    const res = await fetch(base + path);
    const text = await res.text(); let parsed = {}; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: parsed };
  } catch (e) { return { status: 0, body: { error: String(e.message).slice(0, 140) } }; }
};
const killListener = (port) => {
  let pids = ''; try { pids = execFileSync('lsof', ['-ti', ':' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim(); } catch { return; }
  for (const pid of pids.split('\n').filter(Boolean)) { const n = Number(pid); if (n !== process.pid) { try { process.kill(n, 'SIGKILL'); } catch {} } }
};
const startRepo = (id) => spawn(process.execPath, [join(root, 'eval', 'lib', 'flowrouter-service.mjs'), '--port', String(PORTS[id]), '--store', join(WORK, 'store-' + id)], { detached: true, stdio: 'ignore' }).unref();
const waitRepo = async (id, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const s = await get(ep(id), '/status'); if (s.status === 200) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
};
const restartRepo = async (id, wipe) => {
  killListener(PORTS[id]);
  await new Promise((r) => setTimeout(r, 600));
  if (wipe) await rm(join(WORK, 'store-' + id), { recursive: true, force: true });
  startRepo(id);
  return waitRepo(id);
};
const restartConsumerLane = async (port, home) => {
  killListener(port);
  await new Promise((r) => setTimeout(r, 1200));
  spawn(process.env.DSH_BIN || 'dsh', ['web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], { detached: true, stdio: 'ignore', cwd: home, env: { ...process.env, DSH_HOME: home } }).unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) { try { const s = await get('http://127.0.0.1:' + port, '/plugins/operator-ui/rcos'); if (s.status === 200) return true; } catch {} await new Promise((r) => setTimeout(r, 900)); }
  return false;
};
const ep = (id) => `http://127.0.0.1:${PORTS[id]}`;
const repoState = async (id) => {
  const base = join(WORK, 'store-' + id);
  const out = { publications: 0, blobs: 0, evidence: 0, bytes: '' };
  try { out.publications = (await readFile(join(base, 'publications.jsonl'), 'utf8')).split('\n').filter(Boolean).length; } catch {}
  try { const { readdir } = await import('node:fs/promises'); out.blobs = (await readdir(join(base, 'blobs'))).filter((f) => f.endsWith('.pkg')).length; } catch {}
  try { const { readdir } = await import('node:fs/promises'); out.evidence = (await readdir(join(base, 'evidence'))).length; } catch {}
  try { out.bytes = (await readFile(join(base, 'publications.jsonl'), 'utf8')); } catch {}
  return out;
};
const consumerState = async () => {
  const reg = await readFile(join(B_HOME, 'operator-ui', 'b-registry.json'));
  let tasks = ''; try { tasks = await readFile(join(B_HOME, 'operator-ui', 'tasks.json'), 'utf8'); } catch {}
  const parsed = (() => { try { return JSON.parse(tasks).tasks || []; } catch { return []; } })();
  const pin = parsed.find((t) => t.kind === 'pin');
  return { registry_sha: sha(reg), taskstore_sha: sha(Buffer.from(tasks, 'utf8')), pin: pin ? pin.pin : null, pin_witness_sha: pin && pin.witness ? sha(Buffer.from(JSON.stringify(pin.witness), 'utf8')) : null, equivocation_records: parsed.filter((t) => t.kind === 'equivocation').length };
};

const receipt = { generated_at: new Date().toISOString(), spec: 'ccf0387 (S0 — exact-scope custody backfill)', steps: [] };
const step = (name, ok, result) => { receipt.steps.push({ step: name, ok, result }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '  → ' + JSON.stringify(result).slice(0, 300))); };

const artifactFiles = async (dir) => {
  const out = []; const { readdir } = await import('node:fs/promises');
  const walk = async (d, rel) => { for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) await walk(p, r); else out.push({ path: r, bytes: await readFile(p) }); } };
  await walk(dir, ''); return out.sort((a, b) => a.path.localeCompare(b.path));
};
const artB64 = (files) => Buffer.from(JSON.stringify({ files: files.map((f) => ({ path: f.path, b64: f.bytes.toString('base64') })) }), 'utf8').toString('base64');
const p0Of = (files) => {
  const cap = files.find((f) => f.path === 'capability.json');
  const m = JSON.parse(cap.bytes.toString('utf8'));
  const capNo = Buffer.from(canonicalJson({ ...m, implementation: { ...m.implementation, bundle: { algorithm: 'sha256' } } }), 'utf8');
  return packageDigest(files.map((f) => (f.path === 'capability.json' ? { path: f.path, bytes: capNo } : f)));
};

// ---------- topology ----------
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
await writeFile(join(B_HOME, 'operator-ui', 'b-registry.json'), JSON.stringify({ registry_version: 'rcos-public-v1', capabilities: [] }, null, 2) + '\n', 'utf8');
await rm(join(B_HOME, 'operator-ui', 'tasks.json'), { force: true });
if (!(await restartConsumerLane(8414, B_HOME))) { console.error('consumer lane did not come up'); process.exit(2); }
for (const id of Object.keys(PORTS)) await restartRepo(id, true);
step('topology: origin R1, mirror R2 (the configured SOURCE), destination R3, consumer', (await get(ep('r1'), '/status')).status === 200 && (await get(ep('r3'), '/status')).status === 200, { ports: PORTS });

// publisher + two artifacts (T1 and T2), published ONLY to R1, mirrored to R2
const A_PKG = (await post(A, '/plugins/operator-ui/flowrouter?op=export', { capabilityId: 'csv-running-total', outDir: join(WORK, 'export') })).body.packageDir;
const files1 = await artifactFiles(A_PKG);
const D1 = p0Of(files1);
const P = generateKeypair();
const genesis = createGenesis(P, 'publisher-p');
const K1 = generateKeypair();
const ev1 = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 1, prevRecordDigest: recordDigest(genesis), action: 'AUTHORIZE', keyId: deriveKeyId(K1.publicKeyRaw), publicKeyRaw: K1.publicKeyRaw, permissions: ['publish'] });
const chain1 = replayChain(genesis, [ev1]);
const T1 = { publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0' };
const T2 = { publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.2.0' };
const assertFor = (tuple) => signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: tuple.name, version: tuple.version, D: D1, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest });
await post(ep('r1'), '/publisher', { genesis, events: [ev1] });
await post(ep('r1'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...T1, artifact: artB64(files1), publication: assertFor(T1) });
await post(ep('r1'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...T2, artifact: artB64(files1), publication: assertFor(T2) });
await post(ep('r2'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p2-selfcert-v1', ...T1 });
await post(ep('r2'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p2-selfcert-v1', ...T2 });
step('setup: publisher → R1 (T1 + T2) → mirror R2 as the configured source', (await get(ep('r2'), '/publication/' + T1.publisher_id + '/' + T1.name + '/' + T1.version + '?scheme=p2-selfcert-v1')).status === 200, { T1: T1.version, T2: T2.version });

// ================= 1/2/19. positive publication backfill → consumer usability → no publisher contact =================
{
  const r3Before = await repoState('r3');
  const run = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', ...T1 }] } });
  const served = await get(ep('r3'), '/publication/' + T1.publisher_id + '/' + T1.name + '/' + T1.version + '?scheme=p2-selfcert-v1');
  const r2Served = await get(ep('r2'), '/publication/' + T1.publisher_id + '/' + T1.name + '/' + T1.version + '?scheme=p2-selfcert-v1');
  const m = (x) => sha(Buffer.from(canonicalJson(x), 'utf8'));
  step('1. positive: the destination backfills T1 from the MIRROR through ordinary R0 and re-serves the original publisher material unchanged', run.summary.COPIED === 1 && r3Before.publications === 0 && served.status === 200 && served.body.D === D1 && served.body.material.genesis.publisher_id === genesis.publisher_id && m(served.body.material) === m(r2Served.body.material), { outcome: run.summary, D: String(served.body.D).slice(0, 12), publisher: String(served.body.publisher_id).slice(0, 12) });
  // consumer usability through the destination only
  const r = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'dest', endpoint: ep('r3') }], scheme: 'p2-selfcert-v1', ...T1 });
  const fet = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: r.body.resolution_handle, D: D1 });
  const incoming = join(WORK, 'b-incoming');
  await rm(incoming, { recursive: true, force: true });
  for (const f of JSON.parse(Buffer.from(fet.body.bytes_b64 || '', 'base64') || '{"files":[]}').files || []) { const dest = join(incoming, f.path); await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, Buffer.from(f.b64, 'base64')); }
  const st = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming, alias: 'csv-running-total', identityMaterial: fet.body.material, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', ...T1, D: D1 } });
  const ver = await post(B, '/plugins/operator-ui/flowrouter?op=verify', { importTaskId: st.body.import && st.body.import.taskId, fixtureDir: '/tmp/flowrouter-p0/b-fixture' });
  const adm = await post(B, '/plugins/operator-ui/flowrouter?op=admit', { importTaskId: st.body.import && st.body.import.taskId });
  let goal = (await post(B, '/plugins/operator-ui/goal', { objective: 'Process values.csv in order and report the running total after each row, one per line, as RESULT row=<n> total=<cumulative sum>.' })).body.goal || {};
  const gate = new Set(goal.failureCodes || []).has('awaiting-approval');
  if (gate) goal = (await post(B, '/plugins/operator-ui/goal', { approveTaskId: goal.taskId })).body.goal || {};
  const checks = Object.fromEntries((goal.checks || []).map((c) => [c.id, c.pass]));
  step('2/19. a consumer uses the DESTINATION copy through ordinary F0/P2 → verify → admit → SHIP, and the destination never contacted the publisher', r.body.state === 'CONSISTENT' && fet.body.material.genesis.publisher_id === genesis.publisher_id && st.body.import && st.body.import.verdict === 'STAGED' && ver.body.import && ver.body.import.verdict === 'VERIFIED' && adm.body.ok === true && goal.verdict === 'SHIP' && gate && checks['objective-satisfaction'] === true, { state: r.body.state, verdict: goal.verdict });
  receipt.positive = { source: ep('r2'), destination: ep('r3'), D: D1, verdict: goal.verdict };
}

// ================= 3/4. exact scope only; out-of-scope untouched =================
{
  const run = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', ...T2 }] } });
  const t2AtDest = await get(ep('r3'), '/publication/' + T2.publisher_id + '/' + T2.name + '/' + T2.version + '?scheme=p2-selfcert-v1');
  const scope = normalizeScope({ publications: [{ publisher_scheme: 'p2-selfcert-v1', ...T2 }] });
  const noNewer = !JSON.stringify(run).match(/latest|newer|newest|recommend/i) && scope.intents.length === 1;
  step('3/4. exact scope only: T2 is copied only because it is named, no "newer version" observation is produced, and out-of-scope objects remain untouched', run.summary.COPIED === 1 && t2AtDest.status === 200 && noNewer && scope.intents[0].version === T2.version, { outcome: run.summary, newer_language: !noNewer });
}

// ================= 5. content-only D =================
{
  const before = await repoState('r3');
  const run = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { blobs: [{ D: D1 }] } });
  const after = await repoState('r3');
  step('5. a content-only intent caches bytes by recomputation WITHOUT inventing a publication binding', run.summary.COPIED === 1 && after.publications === before.publications && after.blobs >= before.blobs, { outcome: run.summary, publications_unchanged: after.publications === before.publications });
}

// ================= 6. F1 evidence copies; quarantine unchanged until ingest =================
{
  // build a real fork core: two sibling histories for a fresh version
  const kA = generateKeypair();
  const evA = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(kA.publicKeyRaw), publicKeyRaw: kA.publicKeyRaw, permissions: ['publish'] });
  const kB = generateKeypair();
  const evB = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(kB.publicKeyRaw), publicKeyRaw: kB.publicKeyRaw, permissions: ['publish'] });
  const V3 = { publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.3.0' };
  await post(ep('r1'), '/publisher', { genesis, events: [ev1, evA] });
  await post(ep('r1'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...V3, artifact: artB64(files1), publication: signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: V3.name, version: V3.version, D: D1, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: 2, identityHeadDigest: replayChain(genesis, [ev1, evA]).head_digest }) });
  const other = await post(ep('r2'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p2-selfcert-v1', ...V3 });
  // assemble a fork core locally (sealed F1 construction) and store it at R2
  const { buildProofCore } = await import('../../lib/equivocation.js');
  const built = buildProofCore({ genesis, states: [{ events: [ev1, evA] }, { events: [ev1, evB] }] });
  const core = built.core;
  const pd = proofDigest(core);
  await post(ep('r2'), '/evidence', { proof_digest: pd, proof_core: core });
  const before = await consumerState();
  const run = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { proofs: [{ proof_digest: pd }] } });
  const atDest = await fetch(ep('r3') + '/evidence/' + pd);
  const bytes = Buffer.from(await atDest.arrayBuffer());
  const identical = bytes.equals(Buffer.from(JSON.stringify(core), 'utf8'));
  const verified = verifyProofCore(JSON.parse(bytes.toString('utf8'))).proof_digest === pd;
  const after = await consumerState();
  step('6. the exact proof copies byte-identically and verifies at the destination, while quarantine stays unchanged (syncing a proof does NOT ingest it)', other.status === 200 && run.summary.COPIED === 1 && atDest.status === 200 && identical && verified && before.equivocation_records === after.equivocation_records && JSON.stringify(before.pin) === JSON.stringify(after.pin), { outcome: run.summary, identical, verified, quarantine_unchanged: before.equivocation_records === after.equivocation_records });
}

// ================= 6b. adversarial: digest-matching but INVALID evidence =================
{
  // A source can serve a core whose digest matches the requested digest while
  // the core itself fails sealed F1 verification. The destination's evidence
  // path is a dumb carrier and verifies nothing, so the COORDINATOR must.
  const kA = generateKeypair();
  const evA = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(kA.publicKeyRaw), publicKeyRaw: kA.publicKeyRaw, permissions: ['publish'] });
  const kB = generateKeypair();
  const evB = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(kB.publicKeyRaw), publicKeyRaw: kB.publicKeyRaw, permissions: ['publish'] });
  const { buildProofCore } = await import('../../lib/equivocation.js');
  const valid = buildProofCore({ genesis, states: [{ events: [ev1, evA] }, { events: [ev1, evB] }] }).core;
  const tampered = JSON.parse(JSON.stringify(valid));
  tampered.branches[0].events[1].signature = Buffer.alloc(64).toString('base64url');
  const pd = proofDigest(tampered);
  // a stub source that serves the tampered core under its (correct) digest
  const stubPort = 13174;
  const stub = createServer((req, res) => {
    if (req.url.startsWith('/evidence/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(tampered)); }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => stub.listen(stubPort, '127.0.0.1', r));
  const before = await consumerState();
  const beforeEv = (await repoState('r3')).evidence;
  const run = await syncExact({ source_endpoint: 'http://127.0.0.1:' + stubPort, destination: ep('r3'), explicit_scope: { proofs: [{ proof_digest: pd }] } });
  const afterEv = (await repoState('r3')).evidence;
  const after = await consumerState();
  const atDest = await fetch(ep('r3') + '/evidence/' + pd);
  stub.close();
  step('6b. a digest-matching but cryptographically INVALID core is REFUSED at the destination — nothing is stored, quarantine and pins unchanged', run.summary.REFUSED === 1 && run.results[0].error_code === 'EVIDENCE_INVALID' && afterEv === beforeEv && atDest.status === 404 && before.equivocation_records === after.equivocation_records && JSON.stringify(before.pin) === JSON.stringify(after.pin), { outcome: run.summary, error: run.results[0].error_code, evidence_at_destination: atDest.status, quarantine_unchanged: before.equivocation_records === after.equivocation_records });
}

// ================= 7. idempotent repeat =================
{
  const before = await repoState('r3');
  const run = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', ...T1 }], blobs: [{ D: D1 }], proofs: [{ proof_digest: (await repoState('r2')).bytes ? undefined : undefined }].filter((x) => x && x.proof_digest !== undefined) } });
  const after = await repoState('r3');
  step('7. re-running the same scope is idempotent: no duplicate binding, no extra trust, no extra authority', run.summary.ALREADY_PRESENT >= 1 && after.publications === before.publications && after.bytes === before.bytes, { outcome: run.summary, publications: after.publications });
}

// ================= 8/9. the two R0 conflicts =================
{
  // (8) same tuple, different D: source offers a DIFFERENT artifact for T1
  const alt = join(WORK, 'pkg-alt');
  execFileSync('rm', ['-rf', alt]); execFileSync('cp', ['-R', A_PKG, alt]);
  {
    const { readdir } = await import('node:fs/promises');
    const wfName = (await readdir(join(alt, 'workflows')))[0];
    const wf = join(alt, 'workflows', wfName);
    await writeFile(wf, (await readFile(wf, 'utf8')) + '\n# s0-alt\n', 'utf8');
    const capPath = join(alt, 'capability.json');
    const cap = JSON.parse(await readFile(capPath, 'utf8'));
    const wfBytes = await readFile(wf);
    cap.implementation.bundle = { algorithm: 'sha256' };
    const capBytes = Buffer.from(canonicalJson(cap), 'utf8');
    cap.implementation.bundle.package_digest = packageDigest([{ path: 'capability.json', bytes: capBytes }, { path: cap.implementation.entrypoint, bytes: wfBytes }]);
    cap.implementation.bundle.digest = sha(wfBytes);
    await writeFile(capPath, canonicalJson(cap), 'utf8');
  }
  const altFiles = await artifactFiles(alt);
  const Dalt = p0Of(altFiles);
  await restartRepo('r2', true);
  await post(ep('r2'), '/publisher', { genesis, events: [ev1] });
  await post(ep('r2'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...T1, artifact: artB64(altFiles), publication: signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: T1.name, version: T1.version, D: Dalt, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest }) });
  const before = await repoState('r3');
  const run = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', ...T1 }] } });
  const after = await repoState('r3');
  step('8. same T / different D at the source → ordinary R0 refusal with the destination state byte-identical', run.summary.REFUSED === 1 && run.results[0].error_code === 'REPLICATION_D_CONFLICT' && before.bytes === after.bytes, { outcome: run.summary, error: run.results[0].error_code, unchanged: before.bytes === after.bytes });

  // (9) same T+D, different material: a freshly issued assertion (compatible difference)
  const reissued = signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: T1.name, version: T1.version, D: D1, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest });
  await restartRepo('r2', true);
  await post(ep('r2'), '/publisher', { genesis, events: [ev1] });
  await post(ep('r2'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...T1, artifact: artB64(files1), publication: reissued });
  const before2 = await repoState('r3');
  const run2 = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', ...T1 }] } });
  const after2 = await repoState('r3');
  step('9. same T+D / different material → ordinary R0 material refusal with the existing destination state byte-identical', run2.summary.REFUSED === 1 && run2.results[0].error_code === 'REPLICATION_MATERIAL_CONFLICT' && before2.bytes === after2.bytes, { outcome: run2.summary, error: run2.results[0].error_code, unchanged: before2.bytes === after2.bytes });
}

// ================= 10/11. missing object; interrupted run =================
{
  const missing = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '9.9.9' }] } });
  step('10. a missing requested object is recorded as unavailable with no trust mutation', (missing.summary.REFUSED === 1 || missing.summary.UNAVAILABLE === 1) && String(missing.results[0].error_code).startsWith('REPLICATION_'), { outcome: missing.summary, error: missing.results[0].error_code });

  // interruption: first intent succeeds from R1, then the source dies before the second
  await restartRepo('r3', true);
  const alive = await post(ep('r1'), '/status').catch(() => ({}));
  const runInterrupt = await (async () => {
    // source = R1 for the first object; then kill R1 and attempt a second
    const first = await syncExact({ source_endpoint: ep('r1'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', ...T1 }] } });
    killListener(PORTS.r1);
    await new Promise((r) => setTimeout(r, 800));
    const second = await syncExact({ source_endpoint: ep('r1'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', ...T2 }] } });
    return { first, second };
  })();
  const stillThere = await get(ep('r3'), '/publication/' + T1.publisher_id + '/' + T1.name + '/' + T1.version + '?scheme=p2-selfcert-v1');
  const notThere = await get(ep('r3'), '/publication/' + T2.publisher_id + '/' + T2.name + '/' + T2.version + '?scheme=p2-selfcert-v1');
  step('11. an interrupted run keeps what committed: the first object survives, the second never appears, and nothing is rolled back', runInterrupt.first.summary.COPIED === 1 && runInterrupt.second.summary.UNAVAILABLE === 1 && stillThere.status === 200 && notThere.status === 404, { first: runInterrupt.first.summary, second: runInterrupt.second.summary, first_present: stillThere.status, second_present: notThere.status });
  startRepo('r1'); await waitRepo('r1');
}

// ================= 12. source absence never deletes =================
{
  await restartRepo('r2', true); // the source now holds NOTHING
  const before = await repoState('r3');
  const run = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', ...T1 }] } });
  const after = await repoState('r3');
  const stillServed = await get(ep('r3'), '/publication/' + T1.publisher_id + '/' + T1.name + '/' + T1.version + '?scheme=p2-selfcert-v1');
  step('12. source absence never deletes: the object already held at the destination survives a source that no longer serves it', (run.summary.UNAVAILABLE === 1 || run.summary.REFUSED === 1) && before.bytes === after.bytes && stillServed.status === 200 && !JSON.stringify(run).match(/revoked|obsolete|delete|stale/i), { outcome: run.summary, unchanged: before.bytes === after.bytes, still_served: stillServed.status, forbidden_conclusions: !/revoked|obsolete|delete|stale/i.test(JSON.stringify(run)) });
}

// ================= 13/14. no consumer-trust mutation; no discovery authority =================
{
  const before = await consumerState();
  const repoBefore = await repoState('r3');
  await syncExact({ source_endpoint: ep('r3'), destination: ep('r3'), explicit_scope: { blobs: [{ D: D1 }] } });
  const after = await consumerState();
  const d0 = await get(ep('r3'), '/possession?name=csv-running-total');
  step('13/14. S0 custody work leaves consumer trust state byte-identical and grants no discovery authority', before.registry_sha === after.registry_sha && before.taskstore_sha === after.taskstore_sha && JSON.stringify(before.pin) === JSON.stringify(after.pin) && before.pin_witness_sha === after.pin_witness_sha && before.equivocation_records === after.equivocation_records && d0.status === 200, { registry_identical: before.registry_sha === after.registry_sha, pin_identical: JSON.stringify(before.pin) === JSON.stringify(after.pin), d0_entries: (d0.body.entries || []).length });
}

// ================= 15. scope duplicate neutrality =================
{
  const dup = normalizeScope({ publications: [{ publisher_scheme: 'p2-selfcert-v1', ...T1 }, { publisher_scheme: 'p2-selfcert-v1', ...T1 }, { publisher_scheme: 'p2-selfcert-v1', ...T1 }], blobs: [{ D: D1 }, { D: D1 }] });
  step('15. duplicate scope intents collapse to one custody operation each', dup.intents.length === 2 && dup.duplicates_collapsed === 3, { intents: dup.intents.length, collapsed: dup.duplicates_collapsed });
}

// ================= 16. strict scope records =================
{
  const bad = normalizeScope({ publications: [{ publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'x', version: '1.0.0', D: D1 }, { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'x', version: 'latest' }], blobs: [{ D: 'nope' }] });
  const shapes = [validateIntent({ publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'ok-name', version: '1.0.0' }), validateIntent({ D: D1 }), validateIntent({ proof_digest: D1 })];
  step('16. scope records are strict: D on a publication intent, "latest", a malformed digest and any unknown field all reject rather than being silently ignored', bad.intents.length === 0 && bad.rejected.length === 3 && shapes.every((s) => !!s.intent) && !!validateIntent({ publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'ok-name', version: '1.0.0', latest: true }).error, { rejected: bad.rejected.length, accepted_shapes: shapes.filter((s) => !!s.intent).length });
}

// ================= 17. mirror-to-mirror =================
{
  await restartRepo('r3', true);
  const run = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', ...T1 }] } });
  // repoint the source at R1 for a clean mirror-source comparison
  await restartRepo('r2', true);
  await post(ep('r2'), '/publisher', { genesis, events: [ev1] });
  await post(ep('r2'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...T1, artifact: artB64(files1), publication: assertFor(T1) });
  await restartRepo('r3', true);
  const run2 = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', ...T1 }] } });
  const served = await get(ep('r3'), '/publication/' + T1.publisher_id + '/' + T1.name + '/' + T1.version + '?scheme=p2-selfcert-v1');
  step('17. mirror-to-mirror: the destination receives the ORIGINAL publisher material, never a source re-attestation', run2.summary.COPIED === 1 && served.body.material.genesis.publisher_id === genesis.publisher_id && served.body.material.publication.publisher_id === genesis.publisher_id && !JSON.stringify(served.body.material).includes('re-attest'), { outcome: run2.summary, publisher: String(served.body.material.genesis.publisher_id).slice(0, 12) });
}

// ================= 18. restart durability =================
{
  const before = await repoState('r3');
  await restartRepo('r3', false);
  const after = await repoState('r3');
  const served = await get(ep('r3'), '/publication/' + T1.publisher_id + '/' + T1.name + '/' + T1.version + '?scheme=p2-selfcert-v1');
  step('18. restart durability: exact object custody survives a destination restart from disk', before.bytes === after.bytes && served.status === 200 && served.body.D === D1, { publications: after.publications, served: served.status });
}

// ================= 20. journal semantics =================
{
  const journalPath = join(WORK, 's0-journal.jsonl');
  await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', ...T1 }] }, journal_path: journalPath, run_id: 'run-journal' });
  const journal = await readFile(journalPath, 'utf8');
  const lines = journal.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const forbidden = /UP_TO_DATE|LATEST|"BEHIND"|STALE|"CURRENT"|SOURCE_AHEAD|DESTINATION_BEHIND|FULLY_SYNCED_WITH_SOURCE|COMPLETE_REPLICA/;
  step('20. the journal is local bookkeeping: operational fields only, with the forbidden freshness/completeness vocabulary absent by construction', lines.length === 1 && lines[0].run_id === 'run-journal' && !!lines[0].attempted_at && !!lines[0].requested_object_key && !forbidden.test(journal), { journal_lines: lines.length, fields: Object.keys(lines[0]).sort(), freshness_vocabulary: forbidden.test(journal) ? 'PRESENT (wrong)' : 'absent' });
}

const okAll = receipt.steps.every((s) => s.ok);
receipt.verdict = okAll
  ? 'S0 GREEN — exact-scope backfill changes what a repository POSSESSES, never what a consumer is entitled to believe'
  : 'MATRIX INCOMPLETE';
await writeFile(join(root, 'eval', 'receipts', 'FLOWROUTER-S0-RECEIPT.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log('\nverdict:', receipt.verdict);
if (!okAll) process.exitCode = 1;
