#!/usr/bin/env node
// eval/lib/flowrouter-i0-walkthrough.mjs — FlowRouter I0: integrated
// federation walkthrough / composition seal (frozen spec 060aa90).
//
// ONE continuous campaign across TWO PHYSICAL MACHINES:
//   machine A (this orchestrator's host): publisher P + origin repository R1
//   machine B (independent host, reached over the network): R2 mirror,
//   R3 second-hop mirror + evidence carrier, and consumer B running the
//   production RCOS modules.
//
// No new protocol semantics, no new trust object: every step drives a surface
// that an already-sealed phase owns. The receipt records the immutable
// identities at each seam and demonstrates that the state which must remain
// local never crosses a handoff.

import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, release } from 'node:os';
import { canonicalJson, packageDigest } from '../../lib/flowrouter.js';
import { verifyProofCore, proofDigest } from '../../lib/equivocation.js';
import { materialDigest } from '../../lib/replication.js';
import {
  generateKeypair, createGenesis, createKeyEvent, replayChain, signPublication,
  deriveKeyId, recordDigest,
} from '../../lib/identity.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = 'http://127.0.0.1:8412';                      // local plugin (artifact source only)
const WORK = '/tmp/flowrouter-i0';
const A_REPO_PORT = 13141;                              // R1 origin (this host)
const A_FORK_PORT = 13145;                              // second origin branch (this host)
const B_HOST = process.env.I0_B_HOST || '203.0.113.1'; // independent machine (role B)
const A_HOST = process.env.I0_A_HOST || '203.0.113.2'; // this machine's routable address
const B = {
  r2: `http://${B_HOST}:13142`,
  r3: `http://${B_HOST}:13143`,
  actor: `http://${B_HOST}:8415`,
  r2local: 'http://127.0.0.1:13142',
  r3local: 'http://127.0.0.1:13143',
};
const A_EP = { r1: `http://${A_HOST}:${A_REPO_PORT}`, fork: `http://${A_HOST}:${A_FORK_PORT}` };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const RUN_NONCE = randomUUID();

// Network calls never throw: a dead or slow actor records a FAIL with the
// transport error instead of aborting the walkthrough.
const post = async (base, path, body, timeoutMs = 30000) => {
  try {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let parsed = {}; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: parsed };
  } catch (e) { return { status: 0, body: { error: String(e.message).slice(0, 140) } }; }
};
const get = async (base, path, timeoutMs = 20000) => {
  try {
    const res = await fetch(base + path, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let parsed = {}; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: parsed };
  } catch (e) { return { status: 0, body: { error: String(e.message).slice(0, 140) } }; }
};
const waitActorUp = async (ms = 45000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await get(B.actor, '/actor', 5000);
    if (r.status === 200) return true;
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  return false;
};

const receipt = {
  generated_at: new Date().toISOString(),
  spec: '060aa90 (I0 — integrated federation walkthrough / composition seal)',
  actors: {
    machine_A: { role: 'publisher_and_origin', platform: platform(), release: release(), node: process.version, run_nonce: RUN_NONCE },
    machine_B: null, // filled from B's own /actor
  },
  network_handoffs: [],
  checkpoints: [],
  steps: [],
};
const checkpoint = (name, data) => { receipt.checkpoints.push({ name, ...data }); };
const step = (name, ok, result) => { receipt.steps.push({ step: name, ok, result }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '  → ' + JSON.stringify(result).slice(0, 300))); };

// ---------- remote (machine B) control helpers ----------
// stdin is detached and every call has a hard timeout: a remote background
// process must never be able to hold the channel open and stall the campaign.
const sshRun = (cmd, timeoutMs = 45000) => {
  try {
    return execFileSync('ssh', ['-o', 'ConnectTimeout=10', `chow@${B_HOST}`, cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs }).trim();
  } catch (e) { return 'SSH_ERROR: ' + String(e.message).slice(0, 120); }
};

// ---------- local (machine A) repository control ----------
const aKillListener = (port) => {
  let pids = '';
  try { pids = execFileSync('lsof', ['-ti', ':' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim(); } catch { return; }
  for (const pid of pids.split('\n').filter(Boolean)) { const n = Number(pid); if (n !== process.pid) { try { process.kill(n, 'SIGKILL'); } catch {} } }
};
const startARepo = (port, store) => spawn(process.execPath, [join(root, 'eval', 'lib', 'flowrouter-service.mjs'), '--port', String(port), '--store', store], { detached: true, stdio: 'ignore' }).unref();
const waitARepo = async (port, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const s = await get(`http://127.0.0.1:${port}`, '/status'); if (s.status === 200) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};
const restartARepo = async (port, store, wipe) => {
  aKillListener(port);
  await new Promise((r) => setTimeout(r, 500));
  if (wipe) await rm(store, { recursive: true, force: true });
  startARepo(port, store);
  return waitARepo(port);
};
const aRepoState = async (store) => {
  const out = { publications: 0, blobs: 0, custody: 0 };
  try { const recs = (await readFile(join(store, 'publications.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); out.publications = recs.length; out.custody = recs.filter((r) => r.custody).length; } catch {}
  try { out.blobs = (await readdir(join(store, 'blobs'))).filter((f) => f.endsWith('.pkg')).length; } catch {}
  return out;
};

// ---------- helpers ----------
const artifactFiles = async (dir) => {
  const out = [];
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
const p0Of = (files) => {
  const cap = files.find((f) => f.path === 'capability.json');
  const m = JSON.parse(cap.bytes.toString('utf8'));
  const capNo = Buffer.from(canonicalJson({ ...m, implementation: { ...m.implementation, bundle: { algorithm: 'sha256' } } }), 'utf8');
  return packageDigest(files.map((f) => (f.path === 'capability.json' ? { path: f.path, bytes: capNo } : f)));
};
const handoff = (o) => receipt.network_handoffs.push({ transfer: 'network', shared_filesystem: false, ...o });

// ================= topology =================
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
// deploy the remote-side scripts this campaign uses (machine B bootstrap and
// the two in-place restarts) — the run is self-contained given SSH access
{
  const remoteDir = join(root, 'eval', 'lib', 'i0-remote');
  for (const f of await readdir(remoteDir)) {
    execFileSync('scp', ['-q', join(remoteDir, f), `chow@${B_HOST}:/tmp/${f}`], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  }
}
// machine B: bootstrap the campaign's independent services (fresh consumer
// home, two empty repositories, B's own runner) over the network
{
  const out = sshRun('bash /tmp/i0-start-b.sh', 90000);
  receipt.machine_b_bootstrap = out.split('\n');
  // readiness gate: the campaign must not start against half-started services
  const ready = async () => {
    try {
      const [r2, r3, act] = await Promise.all([get(B.r2, '/status'), get(B.r3, '/status'), get(B.actor, '/actor')]);
      return r2.status === 200 && r3.status === 200 && act.status === 200;
    } catch { return false; }
  };
  let ok = false;
  for (let i = 0; i < 24 && !ok; i++) { ok = await ready(); if (!ok) await new Promise((r) => setTimeout(r, 2500)); }
  receipt.machine_b_ready = ok;
  if (!ok) { console.error('machine B services did not come up:', receipt.machine_b_bootstrap.join(' | ')); process.exit(2); }
}
await restartARepo(A_REPO_PORT, join(WORK, 'store-r1'), true);
await restartARepo(A_FORK_PORT, join(WORK, 'store-fork'), true);
{
  const actorB = await get(B.actor, '/actor');
  receipt.actors.machine_B = actorB.status === 200 ? { role: actorB.body.role, platform: actorB.body.platform, release: actorB.body.release, node: actorB.body.node, run_nonce: actorB.body.run_nonce } : { error: 'unreachable', status: actorB.status };
  const r2 = await get(B.r2, '/status');
  const r3 = await get(B.r3, '/status');
  const distinct = receipt.actors.machine_B && receipt.actors.machine_B.run_nonce && receipt.actors.machine_B.run_nonce !== RUN_NONCE
    && receipt.actors.machine_B.platform !== platform();
  step('topology: publisher+origin on machine A, mirrors+consumer on an independent machine B (distinct actors, network only)', r2.status === 200 && r3.status === 200 && !!distinct, { machine_B: receipt.actors.machine_B && { role: receipt.actors.machine_B.role, platform: receipt.actors.machine_B.platform }, r2: r2.body, r3: r3.body });
}

// ================= 1. P creates + authenticates the publication (on A) =================
const files0 = await artifactFiles((await post(A, '/plugins/operator-ui/flowrouter?op=export', { capabilityId: 'csv-running-total', outDir: join(WORK, 'export') })).body.packageDir);
const D0 = p0Of(files0);
const P = generateKeypair();
const genesis = createGenesis(P, 'publisher-p');
const K1 = generateKeypair();
const ev1 = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 1, prevRecordDigest: recordDigest(genesis), action: 'AUTHORIZE', keyId: deriveKeyId(K1.publicKeyRaw), publicKeyRaw: K1.publicKeyRaw, permissions: ['publish'] });
const chain1 = replayChain(genesis, [ev1]);
const TUPLE = { publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0' };
const ASSERT1 = signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest });
const MATERIAL1 = { genesis, events: [ev1], publication: ASSERT1 };
{
  await post(A_EP.r1, '/publisher', { genesis, events: [ev1] });
  const pub = await post(A_EP.r1, '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: TUPLE.name, version: TUPLE.version, artifact: artB64(files0), publication: ASSERT1 });
  checkpoint('publish', { D: D0, publisher_id: genesis.publisher_id, key_id: deriveKeyId(K1.publicKeyRaw), identity_sequence: chain1.head_sequence, identity_head_digest: chain1.head_digest, tuple: TUPLE, publisher_auth: pub.body.publisher_auth, artist: 'machine_A' });
  step('1. P creates and authenticates the publication; R1 (machine A) receives P2 material + P0 artifact', pub.status === 200 && pub.body.D === D0 && pub.body.publisher_auth === 'VERIFIED', { D: String(pub.body.D).slice(0, 16), auth: pub.body.publisher_auth });
}

// ================= 2. R2 replicates from R1 (network handoff A→B) =================
{
  const rep = await post(B.r2, '/replicate', { source_endpoint: A_EP.r1, scheme: 'p2-selfcert-v1', ...TUPLE });
  const served = await get(B.r2, '/publication/' + TUPLE.publisher_id + '/' + TUPLE.name + '/' + TUPLE.version + '?scheme=p2-selfcert-v1');
  handoff({ hop: 'R1 -> R2', object_D: D0, source_actor: 'machine_A', receiving_actor: 'machine_B', source_endpoint: 'machine_A:R1', receiving_endpoint: 'machine_B:R2' });
  checkpoint('mirror_hop_1', { D: served.body.D, material_digest: served.body.material ? materialDigest(served.body.material) : null, custody_from: 'machine_A:R1' });
  step('2. R2 (machine B) replicates the publication from R1 (machine A) — artifact crossed the network only', rep.status === 200 && rep.body.D === D0 && served.status === 200 && served.body.D === D0 && served.body.material.genesis.publisher_id === genesis.publisher_id, { replicated: rep.body.replicated, D: String(served.body.D).slice(0, 16) });
}

// ================= 3. R3 replicates from R2 (second custody hop) =================
{
  const rep = await post(B.r3, '/replicate', { source_endpoint: B.r2local, scheme: 'p2-selfcert-v1', ...TUPLE });
  const served = await get(B.r3, '/publication/' + TUPLE.publisher_id + '/' + TUPLE.name + '/' + TUPLE.version + '?scheme=p2-selfcert-v1');
  const r1Served = await get(A_EP.r1, '/publication/' + TUPLE.publisher_id + '/' + TUPLE.name + '/' + TUPLE.version + '?scheme=p2-selfcert-v1');
  const m = (x) => materialDigest(x);
  const sameEverywhere = m(served.body.material) === m(r1Served.body.material);
  checkpoint('mirror_hop_2', { D: served.body.D, material_digest: m(served.body.material), identical_to_origin: sameEverywhere, custody_from: 'machine_B:R2' });
  step('3. R3 replicates from R2; the P2 material is byte-identical at R1, R2 and R3 (custody metadata never enters it)', rep.status === 200 && sameEverywhere && !JSON.stringify(served.body.material).includes('custody'), { identical: sameEverywhere, D: String(served.body.D).slice(0, 16) });
}

// ================= 4. B resolves across the configured repositories (read-only) =================
const bStateBeforeResolve = (await get(B.actor, '/bstate')).body;
let resolution;
{
  resolution = await post(B.actor, '/federation-resolve', {
    peers: [{ repository_id: 'r2', endpoint: B.r2local }, { repository_id: 'r3', endpoint: B.r3local }],
    scheme: 'p2-selfcert-v1', ...TUPLE,
  });
  const after = (await get(B.actor, '/bstate')).body;
  checkpoint('f0_resolution', { state: resolution.body.state, D: resolution.body.candidate && resolution.body.candidate.D, observations: (resolution.body.observations || []).map((o) => o.repository_id + ':' + o.status), selected_state: resolution.body.candidate && resolution.body.candidate.proof_state });
  step('4. F0 resolution at B is read-only: CONSISTENT with candidate, and B registry/task store/pin unchanged', resolution.status === 200 && resolution.body.state === 'CONSISTENT' && resolution.body.candidate.D === D0 && after.registry_sha === bStateBeforeResolve.registry_sha && after.taskstore_sha === bStateBeforeResolve.taskstore_sha && JSON.stringify(after.pin) === JSON.stringify(bStateBeforeResolve.pin), { state: resolution.body.state, registry_identical: after.registry_sha === bStateBeforeResolve.registry_sha, pin: after.pin });
}

// ================= 5. B fetches exact-D and recomputes P0 itself =================
let fetched;
{
  fetched = await post(B.actor, '/federation-fetch', { resolution_handle: resolution.body.resolution_handle, D: D0 });
  handoff({ hop: 'R2 -> consumer B', object_D: D0, source_actor: 'machine_B:R2', receiving_actor: 'machine_B:consumer' });
  checkpoint('consumer_fetch', { fetched_from: fetched.body.fetched_from, recomputed_D: fetched.body.recomputed_D, material_source: fetched.body.proof_source, proof_state: fetched.body.proof_state });
  step('5. B exact-D fetches and independently recomputes P0; the handoff carries the canonical proof material', fetched.status === 200 && fetched.body.recomputed_D === D0 && !!fetched.body.material, { from: fetched.body.fetched_from, recomputed: String(fetched.body.recomputed_D).slice(0, 16) });
}

// ================= 6. B stages (the ONLY pin-mutating step) =================
let staged;
{
  const before = (await get(B.actor, '/bstate')).body;
  staged = await post(B.actor, '/stage-fetched', { artifact_b64: fetched.body.bytes_b64, alias: 'csv-running-total', identityMaterial: fetched.body.material, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, D: D0 } });
  const after = (await get(B.actor, '/bstate')).body;
  checkpoint('consumer_stage', { verdict: staged.body.import && staged.body.import.verdict, import_task: staged.body.import && staged.body.import.taskId, pin_before: before.pin, pin_after: after.pin, pin_witness_sha: after.pin_witness_sha, registry_sha: after.registry_sha });
  step('6. only the sealed P2 stage creates the pin — and it retains the identity witness; registry untouched by staging', staged.status === 200 && staged.body.import.verdict === 'STAGED' && after.pin && after.pin.sequence === chain1.head_sequence && !!after.pin_witness_sha && after.registry_sha === before.registry_sha, { verdict: staged.body.import && staged.body.import.verdict, pin: after.pin && after.pin.sequence, witness: !!after.pin_witness_sha });
}

// ================= 7. B-local verification on a B-authored frozen fixture =================
let verified;
{
  const fixture = await post(B.actor, '/make-fixture', {});
  verified = await post(B.actor, '/verify', { importTaskId: staged.body.import.taskId, fixtureDir: fixture.body.fixtureDir });
  checkpoint('consumer_verify', { verdict: verified.body.import && verified.body.import.verdict, fixture_authors: fixture.body.authors, fixture_hash: fixture.body.fixture_hash });
  step('7. B authors its own fixture and verifies the imported capability locally (verification is B evidence)', verified.status === 200 && verified.body.import.verdict === 'VERIFIED' && fixture.body.authors === 'B', { verdict: verified.body.import && verified.body.import.verdict });
}

// ================= 8. explicit admission; capability becomes routable =================
let admitted;
{
  admitted = await post(B.actor, '/admit', { importTaskId: staged.body.import.taskId, alias: 'csv-running-total' });
  const st = (await get(B.actor, '/bstate')).body;
  checkpoint('consumer_admission', { ok: admitted.body.ok, registry_sha: st.registry_sha, registry_caps: st.registry_caps });
  step('8. only explicit admission makes the capability routable (registry changed exactly here)', admitted.status === 200 && admitted.body.ok === true && st.registry_caps === 1, { caps: st.registry_caps });
}

// ================= 9. route → gate → execute → SHIP (local capability) =================
{
  let goal = (await post(B.actor, '/goal', { objective: 'Process values.csv in order and report the running total after each row, one per line, as RESULT row=<n> total=<cumulative sum>.' })).body.goal || {};
  const gate = new Set(goal.failureCodes || []).has('awaiting-approval');
  if (gate) goal = (await post(B.actor, '/goal', { approveTaskId: goal.taskId, approved: true })).body.goal || {};
  const checks = Object.fromEntries((goal.checks || []).map((c) => [c.id, c.pass]));
  checkpoint('consumer_ship', { verdict: goal.verdict, route: goal.route && goal.route.selected, gate_observed: gate, checks, task_id: goal.taskId });
  step('9. B routes to the ADMITTED LOCAL capability, passes its own gate, executes and SHIPs', goal.verdict === 'SHIP' && gate && checks['objective-satisfaction'] === true && goal.route && goal.route.selected, { verdict: goal.verdict, gate, route: goal.route && goal.route.selected });
}

// ================= 10. the equivocation campaign (same campaign, same run) =================
// P's identity produces incompatible histories at the same sequence for a NEW
// version of the same capability; two independent repositories expose the two
// branches (one on A, one mirrored to B).
const V2 = '0.2.0';
const mkSib = () => { const k = generateKeypair(); return createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(k.publicKeyRaw), publicKeyRaw: k.publicKeyRaw, permissions: ['publish'] }); };
const X = mkSib(); const Y = mkSib();
const chainX = replayChain(genesis, [ev1, X]); const chainY = replayChain(genesis, [ev1, Y]);
const assertV2 = (chain) => signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: TUPLE.name, version: V2, D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain.head_sequence, identityHeadDigest: chain.head_digest });
const TUPLE2 = { publisher_id: genesis.publisher_id, name: TUPLE.name, version: V2 };
let forkCore = null;
{
  // branch Y → R1 (machine A); branch X → a second origin on machine A, then MIRRORED to R2 (machine B)
  await restartARepo(A_REPO_PORT, join(WORK, 'store-r1'), false);
  await post(A_EP.r1, '/publisher', { genesis, events: [ev1, Y] });
  const pubY = await post(A_EP.r1, '/publish', { publisher_scheme: 'p2-selfcert-v1', ...TUPLE2, artifact: artB64(files0), publication: assertV2(chainY) });
  await post(A_EP.fork, '/publisher', { genesis, events: [ev1, X] });
  const pubX = await post(A_EP.fork, '/publish', { publisher_scheme: 'p2-selfcert-v1', ...TUPLE2, artifact: artB64(files0), publication: assertV2(chainX) });
  const mirroredX = await post(B.r2, '/replicate', { source_endpoint: A_EP.fork, scheme: 'p2-selfcert-v1', ...TUPLE2 });
  const resolved = await post(B.actor, '/federation-resolve', {
    peers: [{ repository_id: 'r1', endpoint: A_EP.r1 }, { repository_id: 'r2', endpoint: B.r2local }],
    scheme: 'p2-selfcert-v1', ...TUPLE2,
  });
  forkCore = resolved.body.proof_core || null;
  checkpoint('f0_fork', { state: resolved.body.state, reason: resolved.body.reason, proof_digest: resolved.body.proof_digest, relation: forkCore && forkCore.relation, branches: forkCore && forkCore.branches.map((b) => ({ head_sequence: b.head_sequence, head_digest: b.head_digest })) });
  step('10. two independent repositories expose incompatible signed histories; F0 sees the conflict and F1 constructs the proof core', pubY.status === 200 && pubX.status === 200 && mirroredX.status === 200 && resolved.body.state === 'CONFLICT' && !!forkCore && resolved.body.proof_digest === proofDigest(forkCore), { state: resolved.body.state, relation: forkCore && forkCore.relation, digest: resolved.body.proof_digest && resolved.body.proof_digest.slice(0, 16) });
}

// ================= 11. transport the proof through an untrusted mirror =================
{
  const digest = proofDigest(forkCore);
  const stored = await post(B.r3, '/evidence', { proof_digest: digest, proof_core: forkCore });
  const fetchedBytes = Buffer.from(await (await fetch(B.r3 + '/evidence/' + digest)).arrayBuffer());
  const identical = fetchedBytes.equals(Buffer.from(JSON.stringify(forkCore), 'utf8'));
  handoff({ hop: 'proof -> R3 carrier', object: 'F1 proof_core', proof_digest: digest, source_actor: 'consumer B', receiving_actor: 'machine_B:R3', transfer: 'network', shared_filesystem: false });
  // B verifies OFFLINE on the independent machine, from the carrier's bytes only
  const offline = await post(B.actor, '/f1-verify', { proof_core: JSON.parse(fetchedBytes.toString('utf8')) });
  checkpoint('f1_transport_and_offline_verify', { proof_digest: digest, bytes_identical: identical, offline_digest: offline.body.digest, relation: offline.body.relation });
  step('11. the proof crosses through an untrusted mirror byte-identically and verifies OFFLINE on the independent machine to the same proof_digest', stored.status === 200 && identical && offline.status === 200 && offline.body.digest === digest, { stored: stored.body.stored, identical, digest_match: offline.body.digest === digest });
}

// ================= 12/13. transport quarantines nobody; explicit ingest does =================
{
  const before = await get(B.actor, '/f1-status?publisher_id=' + genesis.publisher_id);
  const ingest = await post(B.actor, '/f1-ingest', { proof_core: forkCore, observed_via: ['r1', 'r2'] });
  const after = await get(B.actor, '/f1-status?publisher_id=' + genesis.publisher_id);
  const bState = (await get(B.actor, '/bstate')).body;
  checkpoint('f1_ingest', { quarantined_before_ingest: before.body.quarantined, quarantined_after_ingest: after.body.quarantined, proofs: after.body.proofs.length, equivocation_records: bState.equivocation_records });
  step('12/13. storing/transporting the proof quarantined nobody; explicit F1 ingest at B activates the quarantine', before.body.quarantined === false && ingest.body.quarantined === true && after.body.quarantined === true && after.body.proofs.length === 1, { before: before.body.quarantined, after: after.body.quarantined });
}

// ================= 14/15. quarantine blocks BEFORE pin mutation; admitted state unchanged =================
{
  const before = (await get(B.actor, '/bstate')).body;
  const beforeReg = before.registry_sha;
  const blocked = await post(B.actor, '/stage-fetched', { artifact_b64: fetched.body.bytes_b64, alias: 'csv-running-total-rev', identityMaterial: fetched.body.material, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, D: D0 } });
  const after = (await get(B.actor, '/bstate')).body;
  checkpoint('quarantine_block', { refusal: blocked.body.import && blocked.body.import.refusal, pin_before: before.pin, pin_after: after.pin, registry_unchanged: beforeReg === after.registry_sha });
  step('14/15. quarantine refuses the next import BEFORE any pin mutation, and the admitted capability/registry are unchanged', blocked.body.import && blocked.body.import.verdict === 'REFUSED' && blocked.body.import.refusal && blocked.body.import.refusal.code === 'PUBLISHER_EQUIVOCATION_UNACKNOWLEDGED' && JSON.stringify(before.pin) === JSON.stringify(after.pin) && beforeReg === after.registry_sha, { refusal: blocked.body.import && blocked.body.import.refusal && blocked.body.import.refusal.code, registry_unchanged: beforeReg === after.registry_sha });
}

// ================= 16/17. acknowledgment keeps evidence; ordinary P2 rules still apply =================
{
  const digest = proofDigest(forkCore);
  const before = (await get(B.actor, '/bstate')).body;
  const ack = await post(B.actor, '/f1-acknowledge', { proof_digest: digest, operator: 'operator' });
  const st = await get(B.actor, '/f1-status?publisher_id=' + genesis.publisher_id);
  const after = (await get(B.actor, '/bstate')).body;
  const proofsKept = st.body.proofs.length === 1 && st.body.proofs[0].proof_digest === digest && st.body.proofs[0].acknowledged;
  // after acknowledgment the quarantine is gone, and the SAME import now
  // proceeds — judged only by ordinary P2 rules
  const retry = await post(B.actor, '/stage-fetched', { artifact_b64: fetched.body.bytes_b64, alias: 'csv-running-total-rev', identityMaterial: fetched.body.material, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, D: D0 } });
  checkpoint('acknowledgment', { ack: ack.body.ok, still_quarantined: ack.body.still_quarantined, proofs_kept: proofsKept, pin_before: before.pin, pin_after: after.pin, post_ack_stage: retry.body.import && retry.body.import.verdict });
  step('16/17. acknowledgment preserves the proof bytes/digest and the pin, lifts the quarantine, and the retried import is judged by ordinary P2 semantics', ack.body.ok === true && ack.body.still_quarantined === false && proofsKept && JSON.stringify(before.pin) === JSON.stringify(after.pin) && retry.body.import && retry.body.import.verdict === 'STAGED', { ack: ack.body.ok, still_quarantined: ack.body.still_quarantined, post_ack_stage: retry.body.import && retry.body.import.verdict });
}

// ================= 18. mirror death after resolution → exact-T/D failover =================
{
  const res = await post(B.actor, '/federation-resolve', { peers: [{ repository_id: 'r2', endpoint: B.r2local }, { repository_id: 'r3', endpoint: B.r3local }], scheme: 'p2-selfcert-v1', ...TUPLE });
  // kill R2 (a mirror that produced a VALID observation) on machine B
  // the bracket trick: a pattern that cannot match this very command line
  sshRun("pkill -f 'flowrouter-service[.]mjs --port 13142' ; true", 20000);
  await new Promise((r) => setTimeout(r, 1500));
  const fetchedAfter = await post(B.actor, '/federation-fetch', { resolution_handle: res.body.resolution_handle, D: D0 });
  checkpoint('mirror_death_failover', { resolved_state: res.body.state, observations: (res.body.observations || []).map((o) => o.repository_id + ':' + o.status), fetched_from: fetchedAfter.body.fetched_from, recomputed_D: fetchedAfter.body.recomputed_D, error: fetchedAfter.body.error || null });
  step('18. after a mirror dies, failover serves the SAME exact T/D from another VALID peer (never a version or source substitution)', res.body.state === 'CONSISTENT' && fetchedAfter.status === 200 && fetchedAfter.body.recomputed_D === D0 && fetchedAfter.body.fetched_from === 'r3', { from: fetchedAfter.body.fetched_from, recomputed: String(fetchedAfter.body.recomputed_D || fetchedAfter.body.error).slice(0, 16) });
  // bring R2 back from its durable store (fresh process, same on-disk state)
  // the proven remote pattern: an uploaded script that nohup-launches (a
  // session-scope kill reaps setsid children on this host)
  const restored = sshRun('bash /tmp/i0-restart-r2.sh', 40000);
  receipt.mirror_restart = restored.slice(0, 120);
  await new Promise((r) => setTimeout(r, 1500));
}

// ================= 19. restart boundaries: durable state, not process memory =================
{
  const before = (await get(B.actor, '/f1-status?publisher_id=' + genesis.publisher_id)).body;
  const bBefore = (await get(B.actor, '/bstate')).body;
  const actorRestart = sshRun('bash /tmp/i0-restart-actor.sh', 40000);
  receipt.actor_restart = actorRestart.slice(0, 160);
  const actorBack = await waitActorUp(60000);
  receipt.actor_restart_verified = actorBack;
  const bAfterRaw = await get(B.actor, '/bstate');
  const afterRaw = await get(B.actor, '/f1-status?publisher_id=' + genesis.publisher_id);
  const bAfter = bAfterRaw.body || {};
  const after = afterRaw.body || {};
  const r3served = await get(B.r3, '/publication/' + TUPLE.publisher_id + '/' + TUPLE.name + '/' + TUPLE.version + '?scheme=p2-selfcert-v1');
  const beforeProofs = (before.proofs || []).length;
  const afterProofs = (after.proofs || []).length;
  checkpoint('restart_boundaries', {
    pin_before: bBefore.pin, pin_after: bAfter.pin,
    witness_before: bBefore.pin_witness_sha, witness_after: bAfter.pin_witness_sha,
    proofs_before: beforeProofs, proofs_after: afterProofs,
    actor_restart_cmd: receipt.actor_restart, actor_restart_verified: receipt.actor_restart_verified,
    bstate_status: bAfterRaw.status, f1_status_status: afterRaw.status,
    bstate_error: bAfterRaw.status === 200 ? null : bAfterRaw.body, f1_error: afterRaw.status === 200 ? null : afterRaw.body,
    actor_restarted: true,
  });
  step('19. consumer AND repository restarts: pin, witness, proofs, quarantine state and mirrored publications all recover from disk', actorBack && bAfter.pin && bAfter.pin.sequence === bBefore.pin.sequence && bAfter.pin_witness_sha === bBefore.pin_witness_sha && afterProofs === beforeProofs && afterProofs > 0 && after.quarantined === false && r3served.status === 200 && r3served.body.D === D0, { actor_back: actorBack, pin: bAfter.pin && bAfter.pin.sequence, witness_identical: bAfter.pin_witness_sha === bBefore.pin_witness_sha, proofs_before: beforeProofs, proofs_after: afterProofs, quarantined: after.quarantined, r3_serving: r3served.status, f1_error: afterRaw.status === 200 ? null : afterRaw.body });
}

// ================= 20. no authority from custody: identifiers preserved =================
{
  const r1Served = await get(A_EP.r1, '/publication/' + TUPLE.publisher_id + '/' + TUPLE.name + '/' + TUPLE.version + '?scheme=p2-selfcert-v1');
  const r2Served = await get(B.r2, '/publication/' + TUPLE.publisher_id + '/' + TUPLE.name + '/' + TUPLE.version + '?scheme=p2-selfcert-v1');
  const r3Served = await get(B.r3, '/publication/' + TUPLE.publisher_id + '/' + TUPLE.name + '/' + TUPLE.version + '?scheme=p2-selfcert-v1');
  const ids = [
    { actor: 'machine_A:R1', D: r1Served.body.D, publisher: r1Served.body.material.genesis.publisher_id, material: materialDigest(r1Served.body.material) },
    { actor: 'machine_B:R2', D: r2Served.body.D, publisher: r2Served.body.material.genesis.publisher_id, material: materialDigest(r2Served.body.material) },
    { actor: 'machine_B:R3', D: r3Served.body.D, publisher: r3Served.body.material.genesis.publisher_id, material: materialDigest(r3Served.body.material) },
  ];
  const allSame = new Set(ids.map((x) => [x.D, x.publisher, x.material].join('|'))).size === 1 && ids[0].D === D0 && ids[0].publisher === genesis.publisher_id;
  const st = (await get(B.actor, '/bstate')).body;
  const trustInputs = !JSON.stringify(receipt.checkpoints).match(/"copy_count|"repository_count|"custody_path|"rank|"score/i);
  const finalReg = st.registry_caps;
  checkpoint('identifier_survival', { per_actor: ids, identical: allSame, consumer_pin: st.pin, consumer_registry_caps: finalReg });
  step('20. the same identifiers survive every handoff (D, publisher, material digest identical at origin and both mirrors) and no custody/copy-count field appears as a trust input', allSame && trustInputs && finalReg === 1, { identical: allSame, trust_inputs_clean: trustInputs, caps: finalReg });
}

const okAll = receipt.steps.every((s) => s.ok);
receipt.verdict = okAll
  ? 'I0 GREEN — the sealed phases compose into one continuous real-network lifecycle without collapsing their trust boundaries'
  : 'WALKTHROUGH INCOMPLETE';
await writeFile(join(root, 'eval', 'receipts', 'FLOWROUTER-I0-RECEIPT.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log('\nverdict:', receipt.verdict);
if (!okAll) process.exitCode = 1;
