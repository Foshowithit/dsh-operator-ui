#!/usr/bin/env node
// eval/lib/flowrouter-r0-receipt.mjs — FlowRouter R0 acceptance matrix
// (frozen spec 43ca378). Fourteen properties from spec §8.
//
// Topology: P → R1, replicate → R2, replicate → R3 (second hop), with
// consumer B knowing only R2/R3 for the exposed tuples. The source is never
// trusted: every byte and every signature is re-established at the
// destination, which is what this matrix attacks.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, packageDigest } from '../../lib/flowrouter.js';
import { verifyProofCore, proofDigest } from '../../lib/equivocation.js';
import { materialDigest } from '../../lib/replication.js';
import {
  generateKeypair, createGenesis, createKeyEvent, replayChain, signPublication,
  deriveKeyId, recordDigest,
} from '../../lib/identity.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = 'http://127.0.0.1:8412';
const B = 'http://127.0.0.1:8414';
const WORK = '/tmp/flowrouter-r0';
const B_HOME = '/tmp/opui-b-home';
const R_PORTS = { r1: 13131, r2: 13132, r3: 13133 };
const sha = (b) => createHash('sha256').update(b).digest('hex');

const post = async (base, path, body, opts = {}) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), ...opts });
  const text = await res.text();
  let parsed = {}; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 120) }; }
  return { status: res.status, body: parsed };
};
const get = async (base, path) => {
  const res = await fetch(base + path);
  const text = await res.text();
  let parsed = {}; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 120) }; }
  return { status: res.status, body: parsed };
};

const serviceStart = (id) => spawn(process.execPath, [join(root, 'eval', 'lib', 'flowrouter-service.mjs'), '--port', String(R_PORTS[id]), '--store', join(WORK, 'store-' + id)], { detached: true, stdio: 'ignore' }).unref();
// Kill ONLY the listener (lsof -ti :PORT also matches this harness's own
// keep-alive client sockets — killing those would kill the harness).
const killListener = (port) => {
  let pids = '';
  try { pids = execFileSync('lsof', ['-ti', ':' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim(); } catch { return; }
  for (const pid of pids.split('\n').filter(Boolean)) {
    const n = Number(pid);
    if (n === process.pid) continue;
    try { process.kill(n, 'SIGKILL'); } catch {}
  }
};
const waitUp = async (id, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const s = await get(ep(id), '/status'); if (s.status === 200) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};
const restartFreshStore = async (id) => {
  killListener(R_PORTS[id]);
  await new Promise((r) => setTimeout(r, 700));
  await rm(join(WORK, 'store-' + id), { recursive: true, force: true });
  serviceStart(id);
  return waitUp(id);
};
const resolveDshBin = () => {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  try { const p = execFileSync('bash', ['-lc', 'command -v dsh'], { encoding: 'utf8' }).trim(); if (p) return p; } catch {}
  try {
    const { readdirSync, statSync } = require('node:fs'); // eslint-disable-line
    for (const dir of readdirSync(join(process.env.HOME, '.npm', '_npx'))) {
      const cand = join(process.env.HOME, '.npm', '_npx', dir, 'node_modules', '.bin', 'dsh');
      try { if (statSync(cand).isFile()) return cand; } catch {}
    }
  } catch {}
  return 'dsh';
};
const restartConsumerLane = async (port, home) => {
  killListener(port);
  await new Promise((r) => setTimeout(r, 1200));
  const bin = resolveDshBin();
  spawn(bin, ['web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], { detached: true, stdio: 'ignore', cwd: home, env: { ...process.env, DSH_HOME: home } }).unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    try { const s = await get('http://127.0.0.1:' + port, '/plugins/operator-ui/rcos'); if (s.status === 200) return true; } catch {}
    await new Promise((r) => setTimeout(r, 900));
  }
  return false;
};

const receipt = { generated_at: new Date().toISOString(), steps: [] };
let forkCore = null; // the F1 core produced by the property-7b fork observation
const step = (name, ok, result) => { receipt.steps.push({ step: name, ok, result }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '  → ' + JSON.stringify(result).slice(0, 260))); };

const artifactOf = async (dir) => {
  const out = [];
  const { readdir } = await import('node:fs/promises');
  const walk = async (d, rel) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name); const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(p, r); else out.push({ path: r, bytes: await readFile(p) });
    }
  };
  await walk(dir, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
};
const artB64 = (files) => Buffer.from(JSON.stringify({ files: files.map((f) => ({ path: f.path, b64: f.bytes.toString('base64') })) }), 'utf8').toString('base64');
const p0DigestOfFiles = (files) => {
  const cap = files.find((f) => f.path === 'capability.json');
  const m = JSON.parse(cap.bytes.toString('utf8'));
  const capNo = Buffer.from(canonicalJson({ ...m, implementation: { ...m.implementation, bundle: { algorithm: 'sha256' } } }), 'utf8');
  return packageDigest(files.map((f) => (f.path === 'capability.json' ? { path: f.path, bytes: capNo } : f)));
};
const bAuthorityState = async () => {
  const reg = await readFile(join(B_HOME, 'operator-ui', 'b-registry.json'));
  let tasks = '';
  try { tasks = await readFile(join(B_HOME, 'operator-ui', 'tasks.json'), 'utf8'); } catch {}
  const parsed = (() => { try { return JSON.parse(tasks).tasks || []; } catch { return []; } })();
  const pin = parsed.find((t) => t.kind === 'pin');
  return {
    registry_sha: sha(reg),
    taskstore_sha: sha(Buffer.from(tasks, 'utf8')),
    pin: pin ? pin.pin : null,
    pin_witness_sha: pin && pin.witness ? sha(Buffer.from(JSON.stringify(pin.witness), 'utf8')) : null,
    kinds: parsed.map((t) => t.kind).sort(),
  };
};
const mirrorState = async (id) => {
  const store = join(WORK, 'store-' + id);
  const out = { publications: 0, blobs: 0, custody: 0, publishers: 0, mirror_meta: 0, index_entries: 0 };
  try { out.publications = (await readFile(join(store, 'publications.jsonl'), 'utf8')).split('\n').filter(Boolean).length; } catch {}
  try { const { readdir } = await import('node:fs/promises'); out.blobs = (await readdir(join(store, 'blobs'))).filter((f) => f.endsWith('.pkg')).length; } catch {}
  try { const { readdir } = await import('node:fs/promises'); out.publishers = (await readdir(join(store, 'publishers'))).length; } catch {}
  try { out.mirror_meta = (await readFile(join(store, 'mirror.jsonl'), 'utf8')).split('\n').filter(Boolean).length; } catch {}
  try { const idx = JSON.parse(await readFile(join(store, 'index.json'), 'utf8')); out.index_entries = idx.length; } catch {}
  try {
    const recs = (await readFile(join(store, 'publications.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    out.custody = recs.filter((r) => r.custody && r.custody.mirrored_from).length;
  } catch {}
  return out;
};
const publicationOf = async (id, tuple) => get(ep(id), '/publication/' + tuple.publisher_id + '/' + tuple.name + '/' + tuple.version + '?scheme=p2-selfcert-v1');

// ---------- start three fresh repositories + clean consumer B ----------
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
await writeFile(join(B_HOME, 'operator-ui', 'b-registry.json'), JSON.stringify({ registry_version: 'rcos-public-v1', capabilities: [] }, null, 2) + '\n', 'utf8');
await rm(join(B_HOME, 'operator-ui', 'tasks.json'), { force: true });
if (!(await restartConsumerLane(8414, B_HOME))) { console.error('consumer lane did not come up on :8414'); process.exit(2); }
for (const id of Object.keys(R_PORTS)) { await restartFreshStore(id); }
const ep = (id) => `http://127.0.0.1:${R_PORTS[id]}`;
step('three fresh repositories started (R1 source, R2 destination, R3 second hop)', (await get(ep('r1'), '/status')).status === 200 && (await get(ep('r3'), '/status')).status === 200, { ports: R_PORTS });

// ---------- publisher P: identity + package, published ONLY to R1 ----------
const P = generateKeypair();
const genesis = createGenesis(P, 'publisher-p');
const K1 = generateKeypair();
const ev1 = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 1, prevRecordDigest: recordDigest(genesis), action: 'AUTHORIZE', keyId: deriveKeyId(K1.publicKeyRaw), publicKeyRaw: K1.publicKeyRaw, permissions: ['publish'] });
const chain1 = replayChain(genesis, [ev1]);
const exp = await post(A, '/plugins/operator-ui/flowrouter?op=export', { capabilityId: 'csv-running-total', outDir: join(WORK, 'export') });
const A_PKG = exp.body.packageDir;
const files0 = await artifactOf(A_PKG);
const D0 = p0DigestOfFiles(files0);
const art0 = artB64(files0);
const assertAt = (chain) => signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain.head_sequence, identityHeadDigest: chain.head_digest });
const pubBody = (chain, publication) => ({ publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', artifact: art0, publication: publication || assertAt(chain) });
const TUPLE = { publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0' };
// ONE issued assertion: assertions carry issued_at, so re-signing produces
// different bytes for the same statement (that is the "freshly issued
// assertion" case property 7a exercises deliberately).
const ASSERT1 = assertAt(chain1);
const MATERIAL = { genesis, events: [ev1], publication: ASSERT1 };
await post(ep('r1'), '/publisher', { genesis, events: [ev1] });
const pub1 = await post(ep('r1'), '/publish', pubBody(chain1, ASSERT1));
step('P publishes an authenticated capability to R1 only', pub1.status === 200 && pub1.body.D === D0 && pub1.body.publisher_auth === 'VERIFIED', { D: String(pub1.body.D).slice(0, 16), auth: pub1.body.publisher_auth });

// ================= property 1 + 2: positive mirror, no mirror authorship =================
const beforeR2 = await mirrorState('r2');
const rep1 = await post(ep('r2'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p2-selfcert-v1', ...TUPLE });
const afterR2 = await mirrorState('r2');
step('property 1/2 positive mirror: R2 replicates from R1, stores the ORIGINAL material, and never talks to P', rep1.status === 200 && rep1.body.replicated === true && rep1.body.D === D0 && beforeR2.publications === 0 && afterR2.publications === 1 && afterR2.blobs === 1 && afterR2.custody === 1 && afterR2.publishers === 0, { replicated: rep1.body.replicated, D: String(rep1.body.D).slice(0, 16), r2: afterR2 });
{
  const served = await publicationOf('r2', TUPLE);
  const fromSource = await publicationOf('r1', TUPLE);
  const sameMaterial = served.status === 200 && fromSource.status === 200 && served.body.publisher_auth === 'VERIFIED'
    && materialDigest(served.body.material) === materialDigest(fromSource.body.material)
    && served.body.publisher_id === genesis.publisher_id
    && served.body.material.genesis.publisher_id === genesis.publisher_id;
  // nothing of R2's identity appears: the served record carries no mirror signature/identity
  const noMirrorIdentity = !JSON.stringify(served.body.material).includes('mirror') && served.body.material.publication.publisher_id === genesis.publisher_id;
  step('property 2 R2 serves the ORIGINAL publisher material byte-for-byte; no mirror identity enters it', sameMaterial && noMirrorIdentity, { served_auth: served.body.publisher_auth, material_identical: sameMaterial, publisher: String(served.body.publisher_id).slice(0, 12) });
}

// ================= property 13: consumer B knows only R2 =================
{
  const r = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'r2', endpoint: ep('r2') }], scheme: 'p2-selfcert-v1', ...TUPLE });
  const fetched = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: r.body.resolution_handle, D: D0 });
  const incoming = join(WORK, 'b-incoming');
  await rm(incoming, { recursive: true, force: true });
  for (const f of JSON.parse(Buffer.from(fetched.body.bytes_b64, 'base64').toString('utf8')).files) {
    const dest = join(incoming, f.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(f.b64, 'base64'));
  }
  const st = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming, alias: 'csv-running-total', identityMaterial: fetched.body.material, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, D: D0 } });
  const ver = await post(B, '/plugins/operator-ui/flowrouter?op=verify', { importTaskId: st.body.import?.taskId, fixtureDir: '/tmp/flowrouter-p0/b-fixture' });
  const adm = await post(B, '/plugins/operator-ui/flowrouter?op=admit', { importTaskId: st.body.import?.taskId });
  let g = (await post(B, '/plugins/operator-ui/goal', { objective: 'Process values.csv in order and report the running total after each row, one per line, as RESULT row=<n> total=<cumulative sum>.' })).body.goal || {};
  const gate = new Set(g.failureCodes || []).has('awaiting-approval');
  if (gate) g = (await post(B, '/plugins/operator-ui/goal', { approveTaskId: g.taskId })).body.goal || {};
  const checks = Object.fromEntries((g.checks || []).map((c) => [c.id, c.pass]));
  step('property 13 B talks ONLY to R2 and still authenticates P (resolve→fetch→stage→verify→admit→route→SHIP)', r.body.state === 'CONSISTENT' && r.body.observations[0].repository_id === 'r2' && fetched.body.material.genesis.publisher_id === genesis.publisher_id && fetched.body.recomputed_D === D0 && st.body.import?.verdict === 'STAGED' && ver.body.import?.verdict === 'VERIFIED' && adm.body.ok === true && g.verdict === 'SHIP' && gate && checks['objective-satisfaction'] === true, { state: r.body.state, fetched_D: String(fetched.body.recomputed_D).slice(0, 12), stage: st.body.import?.verdict, verify: ver.body.import?.verdict, verdict: g.verdict });
}

// ================= property 9: consumer-local trust state untouched =================
{
  // Every mirror-side storage change below must leave B's trust state
  // completely alone: same registry bytes, same pins, same witness, same
  // task store — replication is not a consumer action.
  const bBefore = await bAuthorityState();
  const replicated2 = await post(ep('r3'), '/replicate', { source_endpoint: ep('r2'), scheme: 'p2-selfcert-v1', ...TUPLE });
  const reprinted = await post(ep('r2'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p2-selfcert-v1', ...TUPLE });
  const bAfter2 = await bAuthorityState();
  step('property 9 storage changes at mirrors, never B trust state (registry/pins/witness/task store byte-identical)', replicated2.status === 200 && reprinted.status === 200 && bBefore.registry_sha === bAfter2.registry_sha && bBefore.taskstore_sha === bAfter2.taskstore_sha && JSON.stringify(bBefore.pin) === JSON.stringify(bAfter2.pin) && bBefore.pin_witness_sha === bAfter2.pin_witness_sha && !bAfter2.kinds.includes('equivocation'), { registry_identical: bBefore.registry_sha === bAfter2.registry_sha, taskstore_identical: bBefore.taskstore_sha === bAfter2.taskstore_sha, pin: bAfter2.pin.sequence, witness_identical: bBefore.pin_witness_sha === bAfter2.pin_witness_sha });
}

// ================= property 13 (multi-hop): P → R1 → R2 → R3 → B =================
{
  const releasedB = await publicationOf('r3', TUPLE);
  const r = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'r3', endpoint: ep('r3') }], scheme: 'p2-selfcert-v1', ...TUPLE });
  const fetched = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: r.body.resolution_handle, D: D0 });
  const r2state = await mirrorState('r2');
  const r3state = await mirrorState('r3');
  const r2Served = await publicationOf('r2', TUPLE);
  step('property 13 (multi-hop) P → R1 → R2 → R3 → B: identical T/D/material after two custody hops; custody provenance never enters authentication', releasedB.status === 200 && materialDigest(releasedB.body.material) === materialDigest(r2Served.body.material) && releasedB.body.D === D0 && fetched.body.recomputed_D === D0 && fetched.body.material.genesis.publisher_id === genesis.publisher_id && r3state.custody === 1 && r2state.custody === 1, { r2_custody: r2state.custody, r3_custody: r3state.custody, D: String(releasedB.body.D).slice(0, 12), publisher: String(releasedB.body.publisher_id).slice(0, 12) });
}

// ================= property 10: copy count adds zero authority =================
{
  const one = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'r2', endpoint: ep('r2') }], scheme: 'p2-selfcert-v1', ...TUPLE });
  const many = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }, { repository_id: 'r3', endpoint: ep('r3') }], scheme: 'p2-selfcert-v1', ...TUPLE });
  const authOf = (o) => o.body.observations.map((x) => x.publisher_auth).join('|');
  const noAuthorityFields = !JSON.stringify(many.body).match(/rank|score|popular|trust_score|endorse|freshness_claim/i);
  step('property 10 one mirror and three mirrors give the same publisher authentication — possession adds no ranking/score/endorsement', one.body.state === 'CONSISTENT' && many.body.state === 'CONSISTENT' && authOf(one) === 'VERIFIED' && /^VERIFIED(\|VERIFIED)*$/.test(authOf(many)) && one.body.candidate.D === many.body.candidate.D && noAuthorityFields, { one: authOf(one), many: authOf(many), same_D: one.body.candidate.D === many.body.candidate.D });
}

// ================= property 8: idempotence =================
{
  const before = await mirrorState('r2');
  const again = await post(ep('r2'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p2-selfcert-v1', ...TUPLE });
  const after = await mirrorState('r2');
  step('property 8 exact repeat replication is one semantic object (idempotent, no second copy, no extra trust)', again.status === 200 && again.body.idempotent === true && before.publications === after.publications && before.blobs === after.blobs && before.mirror_meta === after.mirror_meta, { idempotent: again.body.idempotent, publications: after.publications, meta_records: after.mirror_meta });
}

// ================= property 3: byte substitution =================
{
  const goodBlob = await readFile(join(WORK, 'store-r1', 'blobs', D0 + '.pkg'));
  const swapped = JSON.parse(goodBlob.toString('utf8'));
  const wf = swapped.files.find((f) => f.path !== 'capability.json');
  wf.b64 = Buffer.from('# substituted bytes during replication\n').toString('base64');
  await writeFile(join(WORK, 'store-r1', 'blobs', D0 + '.pkg'), JSON.stringify(swapped), 'utf8');
  const before = await mirrorState('r3');
  // r3 already holds T/D; ask a FRESH destination (r2 is idempotent) — use a new port? r3 holds it too.
  // Instead: a fresh destination store is started for this case only.
  killListener(R_PORTS.r3);
  await new Promise((r) => setTimeout(r, 700));
  await rm(join(WORK, 'store-r3'), { recursive: true, force: true });
  serviceStart('r3');
  await waitUp('r3');
  const subst = await post(ep('r3'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p2-selfcert-v1', ...TUPLE });
  const after = await mirrorState('r3');
  await writeFile(join(WORK, 'store-r1', 'blobs', D0 + '.pkg'), goodBlob, 'utf8');
  step('property 3 source advertises valid signed T/D but serves altered bytes → recomputation rejects; NOTHING commits', subst.status === 409 && subst.body.error === 'REPLICATION_BYTES_SUBSTITUTED' && after.publications === 0 && after.blobs === 0, { error: subst.body.error, committed_publications: after.publications, committed_blobs: after.blobs });
  // re-establish the mirror at R3 for the remaining cases
  const re = await post(ep('r3'), '/replicate', { source_endpoint: ep('r2'), scheme: 'p2-selfcert-v1', ...TUPLE });
  receipt._r3_restored = re.status === 200;
}

// ================= property 4: binding substitution (malicious source stub) =================
{
  // A stub source that returns well-formed JSON with tampered outer metadata
  // or material that authenticates something else.
  const stubPort = 13134;
  const stub = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const m = u.pathname.match(/^\/publication\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const mode = process.env.__STUB_MODE;
      const rec = { publisher_scheme: 'p2-selfcert-v1', publisher_id: decodeURIComponent(m[1]), name: decodeURIComponent(m[2]), version: decodeURIComponent(m[3]), D: D0, publisher_auth: 'VERIFIED', material: MATERIAL };
      if (mode === 'name') rec.name = 'csv-total-renamed';
      if (mode === 'material_other') { rec.material = { ...MATERIAL, publication: signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'other-capability', version: '9.9.9', D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest }) }; }
      if (mode === 'bad_genesis') rec.material = { ...MATERIAL, genesis: { ...genesis, signature: Buffer.alloc(64).toString('base64url') } };
      if (mode === 'bad_head') rec.material = { ...MATERIAL, events: [ev1], publication: signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: 7, identityHeadDigest: chain1.head_digest }) };
      if (mode === 'unauthorized') { const kX = generateKeypair(); rec.material = { ...MATERIAL, publication: signPublication({ privateKey: kX.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest }) }; }
      if (mode === 'different_D') rec.D = 'a'.repeat(64);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(rec));
    }
    if (req.method === 'GET' && /^\/fetch\/[a-f0-9]{64}$/.test(u.pathname)) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(JSON.stringify({ files: files0.map((f) => ({ path: f.path, b64: f.bytes.toString('base64') })) }));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => stub.listen(stubPort, '127.0.0.1', r));
  const results = {};
  for (const mode of ['name', 'material_other', 'bad_genesis', 'bad_head', 'unauthorized', 'different_D']) {
    process.env.__STUB_MODE = mode;
    killListener(R_PORTS.r3);
    await new Promise((r) => setTimeout(r, 500));
    await rm(join(WORK, 'store-r3'), { recursive: true, force: true });
    serviceStart('r3');
    await waitUp('r3');
    const out = await post(ep('r3'), '/replicate', { source_endpoint: 'http://127.0.0.1:' + stubPort, scheme: 'p2-selfcert-v1', ...TUPLE });
    const state = await mirrorState('r3');
    results[mode] = { error: out.body.error || null, committed: state.publications };
  }
  stub.close();
  const allRefused = Object.values(results).every((r) => r.committed === 0 && typeof r.error === 'string' && r.error.startsWith('REPLICATION_'));
  step('property 4/5 binding + history substitution from a malicious source → six tamper families all refused before any commit', allRefused, results);
  // restore a clean mirror at R3 for later cases
  const re = await post(ep('r3'), '/replicate', { source_endpoint: ep('r2'), scheme: 'p2-selfcert-v1', ...TUPLE });
  receipt._r3_restored2 = re.status === 200;
}

// ================= property 6: destination conflict (different D) =================
{
  // A second source publishes a DIFFERENT artifact for the same tuple.
  const alt = join(WORK, 'pkg-alt');
  execFileSync('rm', ['-rf', alt]); execFileSync('cp', ['-R', A_PKG, alt]);
  {
    const wf = join(alt, 'workflows', 'csv-running-total-v0-1-0.yaml');
    await writeFile(wf, (await readFile(wf, 'utf8')) + '\n# alt-bytes\n', 'utf8');
    const capPath = join(alt, 'capability.json');
    const cap = JSON.parse(await readFile(capPath, 'utf8'));
    const wfBytes = await readFile(wf);
    cap.implementation.bundle = { algorithm: 'sha256' };
    const capBytes = Buffer.from(canonicalJson(cap), 'utf8');
    cap.implementation.bundle.package_digest = packageDigest([{ path: 'capability.json', bytes: capBytes }, { path: cap.implementation.entrypoint, bytes: wfBytes }]);
    cap.implementation.bundle.digest = sha(wfBytes);
    await writeFile(capPath, canonicalJson(cap), 'utf8');
  }
  const altFiles = await artifactOf(alt);
  const Dalt = p0DigestOfFiles(altFiles);
  await restartFreshStore('r1');
  await post(ep('r1'), '/publisher', { genesis, events: [ev1] });
  await post(ep('r1'), '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', artifact: artB64(altFiles), publication: signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: Dalt, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest }) });
  const before = await mirrorState('r2');
  const beforeBytes = await readFile(join(WORK, 'store-r2', 'publications.jsonl'), 'utf8');
  const conflict = await post(ep('r2'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p2-selfcert-v1', ...TUPLE });
  const afterBytes = await readFile(join(WORK, 'store-r2', 'publications.jsonl'), 'utf8');
  const after = await mirrorState('r2');
  step('property 6 same tuple at a different D → refuse; the held binding is byte-identical (no overwrite, no majority)', conflict.status === 409 && conflict.body.error === 'REPLICATION_D_CONFLICT' && beforeBytes === afterBytes && after.publications === before.publications && after.blobs === before.blobs, { error: conflict.body.error, binding_unchanged: beforeBytes === afterBytes, held_D: String(conflict.body.held_D).slice(0, 12), offered_D: String(conflict.body.offered_D).slice(0, 12) });
}

// ================= property 7: material conflict (compatible + fork) =================
{
  // (a) COMPATIBLE material for the same T/D: same history, freshly issued
  // assertion (identical semantics, different signature bytes) → the mirror
  // refuses to replace, and NO F1 evidence is produced anywhere by that.
  const reissued = signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest });
  const compatible = { genesis, events: [ev1], publication: reissued };
  const compatibleDiffers = materialDigest(compatible) !== materialDigest(MATERIAL);
  await restartFreshStore('r1');
  await post(ep('r1'), '/publisher', { genesis, events: [ev1] });
  await post(ep('r1'), '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', artifact: art0, publication: reissued });
  const beforeBytes = await readFile(join(WORK, 'store-r2', 'publications.jsonl'), 'utf8');
  const matConflict = await post(ep('r2'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p2-selfcert-v1', ...TUPLE });
  const afterBytes = await readFile(join(WORK, 'store-r2', 'publications.jsonl'), 'utf8');
  const lvl = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }], scheme: 'p2-selfcert-v1', ...TUPLE });
  step('property 7a compatible material for the same T/D → refuse replacement (immutability), NO F1 evidence emitted, mirror not an adjudicator', matConflict.status === 409 && matConflict.body.error === 'REPLICATION_MATERIAL_CONFLICT' && beforeBytes === afterBytes && !lvl.body.proof_core && lvl.body.state === 'CONSISTENT', { error: matConflict.body.error, material_differs: compatibleDiffers, f1_proof: lvl.body.proof_core ? 'EMITTED (wrong)' : null, consumer_state: lvl.body.state });

  // (b) NON-COMPARABLE material for the same T/D: a fresh mirror holds a
  // SIBLING branch at the same sequence as the source. The mirror still
  // refuses to replace what it holds, and a consumer observing BOTH
  // repositories sees the sealed F0/F1 fork — the mirror neither creates nor
  // suppresses that evidence.
  const kSib = generateKeypair();
  const evSib = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(kSib.publicKeyRaw), publicKeyRaw: kSib.publicKeyRaw, permissions: ['publish'] });
  const chainSib = replayChain(genesis, [ev1, evSib]);
  const sibAssert = signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chainSib.head_sequence, identityHeadDigest: chainSib.head_digest });
  // the sibling branch is published to R1 and then MIRRORED into R3
  await restartFreshStore('r1');
  await post(ep('r1'), '/publisher', { genesis, events: [ev1, evSib] });
  await post(ep('r1'), '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', artifact: art0, publication: sibAssert });
  await restartFreshStore('r3');
  const mirrored = await post(ep('r3'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p2-selfcert-v1', ...TUPLE });
  // now R1 carries a DIFFERENT sibling at the same sequence (a second branch)
  const kSib2 = generateKeypair();
  const evSib2 = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(kSib2.publicKeyRaw), publicKeyRaw: kSib2.publicKeyRaw, permissions: ['publish'] });
  const chainSib2 = replayChain(genesis, [ev1, evSib2]);
  await restartFreshStore('r1');
  await post(ep('r1'), '/publisher', { genesis, events: [ev1, evSib2] });
  await post(ep('r1'), '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', artifact: art0, publication: signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chainSib2.head_sequence, identityHeadDigest: chainSib2.head_digest }) });
  const beforeBytes2 = await readFile(join(WORK, 'store-r3', 'publications.jsonl'), 'utf8');
  const forkConflict = await post(ep('r3'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p2-selfcert-v1', ...TUPLE });
  const afterBytes2 = await readFile(join(WORK, 'store-r3', 'publications.jsonl'), 'utf8');
  const obs = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r3', endpoint: ep('r3') }], scheme: 'p2-selfcert-v1', ...TUPLE });
  let forkVerifies = false;
  if (obs.body.proof_core) { try { forkVerifies = verifyProofCore(obs.body.proof_core).ok === true && obs.body.proof_digest === proofDigest(obs.body.proof_core); } catch { forkVerifies = false; } }
  step('property 7b non-comparable material for the same T/D → mirror refuses (no overwrite); the F0/F1 fork path still works across the two repositories', mirrored.status === 200 && forkConflict.status === 409 && forkConflict.body.error === 'REPLICATION_MATERIAL_CONFLICT' && beforeBytes2 === afterBytes2 && obs.body.state === 'CONFLICT' && !!obs.body.proof_core && forkVerifies, { mirrored: mirrored.status, error: forkConflict.body.error, binding_unchanged: beforeBytes2 === afterBytes2, consumer_state: obs.body.state, reason: obs.body.reason, f1_verifies: forkVerifies });
  receipt._fork_observed = { relation: obs.body.proof_core && obs.body.proof_core.relation };
  forkCore = obs.body.proof_core || null;
}

// ================= property 11: staleness is observed, never asserted =================
{
  // R2 holds the state-1 mirror; R1 now carries a compatible extension (seq 2).
  const K2 = generateKeypair();
  const ev2 = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(K2.publicKeyRaw), publicKeyRaw: K2.publicKeyRaw, permissions: ['publish'] });
  const chain2 = replayChain(genesis, [ev1, ev2]);
  await restartFreshStore('r1');
  await post(ep('r1'), '/publisher', { genesis, events: [ev1, ev2] });
  await post(ep('r1'), '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', artifact: art0, publication: signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain2.head_sequence, identityHeadDigest: chain2.head_digest }) });
  const servedByR2 = await publicationOf('r2', TUPLE);
  const r = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }], scheme: 'p2-selfcert-v1', ...TUPLE });
  const r2assertsNothing = !JSON.stringify(servedByR2.body).match(/"fresh|current_version|latest|stale"/i) && servedByR2.body.material.publication.identity_sequence === 1;
  step('property 11 a stale mirror asserts nothing: R2 keeps serving state 1, the consumer (not R2) classifies the compatible extension', r.body.state === 'CONSISTENT' && r.body.candidate.proof_state.head_sequence === 2 && servedByR2.body.material.publication.identity_sequence === 1 && r2assertsNothing, { consumer_head: r.body.candidate.proof_state.head_sequence, r2_serves_state: servedByR2.body.material.publication.identity_sequence, r2_claims_freshness: !r2assertsNothing });
}

// ================= property 12: F1 evidence carriage through a mirror =================
{
  // The core the consumer produced in 7b travels through R2's dumb evidence
  // path. Storing it at a mirror quarantines nobody anywhere; only B's
  // explicit ingest can, and that stays exactly as sealed.
  const coreOk = !!forkCore;
  const store = coreOk ? await post(ep('r2'), '/evidence', { proof_digest: proofDigest(forkCore), proof_core: forkCore }) : { status: 0, body: {} };
  const fetched = coreOk ? await fetch(ep('r2') + '/evidence/' + proofDigest(forkCore)) : null;
  const bytes = fetched ? Buffer.from(await fetched.arrayBuffer()) : Buffer.alloc(0);
  const identical = coreOk && bytes.equals(Buffer.from(JSON.stringify(forkCore), 'utf8'));
  const verifies = coreOk ? verifyProofCore(JSON.parse(bytes.toString('utf8'))).proof_digest === proofDigest(forkCore) : false;
  const quarantineBefore = await get(B, '/plugins/operator-ui/f1?op=status');
  const stBefore = await get(B, '/plugins/operator-ui/f1?op=status&publisher_id=' + genesis.publisher_id);
  // explicit ingest at B is what activates local policy
  const ingest = coreOk ? await post(B, '/plugins/operator-ui/f1?op=ingest', { proof_core: forkCore, observed_via: ['r1', 'r2'] }) : { body: {} };
  const stAfter = await get(B, '/plugins/operator-ui/f1?op=status&publisher_id=' + genesis.publisher_id);
  const ack = coreOk ? await post(B, '/plugins/operator-ui/f1?op=acknowledge', { proof_digest: proofDigest(forkCore), operator: 'operator' }) : { body: {} };
  step('property 12: a proof mirrored at R2 quarantines nobody; byte-identical through the carrier; only B\'s explicit ingest activates quarantine (then acknowledged)', coreOk && store.body.stored === true && identical && verifies && quarantineBefore.body.quarantined_publishers.length === 0 && stBefore.body.quarantined === false && ingest.body.quarantined === true && stAfter.body.quarantined === true && ack.body.still_quarantined === false, { stored_at_mirror: store.body.stored, bytes_identical: identical, verifies: verifies, quarantined_before: stBefore.body.quarantined, quarantined_after_ingest: stAfter.body.quarantined, after_ack: ack.body.still_quarantined });
  receipt.f1_carriage = { proof_digest: coreOk ? proofDigest(forkCore).slice(0, 16) : null, mirrored: store.body.stored || false, identical, verifies };
}

// ================= property 14: P1 boundary =================
{
  // a P1 package whose declared identity matches its tuple (the P1 path
  // validates the in-package identity block)
  const p1pkg = join(WORK, 'pkg-p1');
  execFileSync('rm', ['-rf', p1pkg]); execFileSync('cp', ['-R', A_PKG, p1pkg]);
  {
    const capPath = join(p1pkg, 'capability.json');
    const cap = JSON.parse(await readFile(capPath, 'utf8'));
    cap.identity = { ...(cap.identity || {}), id: 'nickname/p1-cap', version: '0.1.0' };
    await writeFile(capPath, JSON.stringify(cap, null, 2) + '\n', 'utf8');
  }
  const p1Files = await artifactOf(p1pkg);
  const p1 = await post(ep('r1'), '/publish', { publisher_scheme: 'p1-configured-v1', publisher_id: 'nickname', name: 'p1-cap', version: '0.1.0', artifact: artB64(p1Files) });
  const refused = await post(ep('r2'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p1-configured-v1', publisher_id: 'nickname', name: 'p1-cap', version: '0.1.0' });
  const refusedImplicit = await post(ep('r2'), '/replicate', { source_endpoint: ep('r1'), publisher_id: 'nickname', name: 'p1-cap', version: '0.1.0' });
  const stateBeforeCache = await mirrorState('r2');
  const cached = await post(ep('r2'), '/cache-blob', { source_endpoint: ep('r1'), D: D0 });
  const stateAfterCache = await mirrorState('r2');
  const explicitRefused = refused.status === 409 && refused.body.error === 'REPLICATION_P1_NOT_FEDERATABLE';
  const implicitRefused = refusedImplicit.status === 409 && String(refusedImplicit.body.error || '').startsWith('REPLICATION_');
  step('property 14 P1 binding replication refused (explicit P1_NOT_FEDERATABLE; implicit 409); raw P0 caching by D still legal and authorizes nothing', p1.status === 200 && explicitRefused && implicitRefused && cached.body.cached === true && cached.body.binding_created === false && stateBeforeCache.publications === stateAfterCache.publications, { p1_publish: p1.status, p1_error: p1.body.error || null, explicit: refused.body.error, implicit: refusedImplicit.body.error, cache: cached.body.cached === true ? 'cached' : cached.body.error, binding_created: cached.body.binding_created, publications_unchanged: stateBeforeCache.publications === stateAfterCache.publications });
}

const okAll = receipt.steps.every((s) => s.ok);
receipt.verdict = okAll ? 'R0 MATRIX GREEN — replication copies possession, never authority' : 'MATRIX INCOMPLETE';
await writeFile(join(root, 'eval', 'receipts', 'FLOWROUTER-R0-RECEIPT.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log('\nverdict:', receipt.verdict);
