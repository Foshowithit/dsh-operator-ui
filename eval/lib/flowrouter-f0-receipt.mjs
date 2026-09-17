#!/usr/bin/env node
// eval/lib/flowrouter-f0-receipt.mjs — Federation F0 acceptance matrix
// (spec 6093ce5). Topology: Publisher P → R1 + R2; malicious/stale R3/R4;
// clean consumer B. Resolution runs through B's /federation route
// (read-only): peers are defined in the harness as consumer-assigned
// {repository_id, endpoint} pairs.
//
// Positive: P publishes the same authenticated package to R1 and R2 → B
// resolves exact agreement → fetches from one VALID peer → independently
// re-verifies → sealed local path → SHIP.
// Adversarial + the three causality checks from the frozen ruling.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, packageDigest } from '../../lib/flowrouter.js';
import {
  generateKeypair, createGenesis, createKeyEvent, replayChain, signPublication,
  deriveKeyId, recordDigest,
} from '../../lib/identity.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = 'http://127.0.0.1:8412';
const B = 'http://127.0.0.1:8414';
const WORK = '/tmp/flowrouter-f0';
const B_HOME = '/tmp/opui-b-home';
const R_PORTS = { r1: 13111, r2: 13112, r3: 13113, r4: 13114 };
const sha = (b) => createHash('sha256').update(b).digest('hex');

const post = async (base, path, body) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const get = async (base, path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const serviceStart = (id) => spawn(process.execPath, [join(root, 'eval', 'lib', 'flowrouter-service.mjs'), '--port', String(R_PORTS[id]), '--store', join(WORK, 'store-' + id)], { detached: true, stdio: 'ignore' }).unref();
// Kill ONLY the listening process. lsof -ti :PORT also matches this harness's
// own keep-alive client sockets — killing those pids SIGKILLs the harness.
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
// Full restart: kill the listener FIRST (otherwise the replacement cannot
// bind and the stale process keeps serving a deleted store), wipe, respawn,
// then wait for real liveness instead of a fixed sleep.
const restartFreshStore = async (id) => {
  killListener(R_PORTS[id]);
  await new Promise((r) => setTimeout(r, 700));
  await rm(join(WORK, 'store-' + id), { recursive: true, force: true });
  serviceStart(id);
  return waitUp(id);
};
const receipt = { generated_at: new Date().toISOString(), steps: [] };
const step = (name, ok, result) => { receipt.steps.push({ step: name, ok, result }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '  → ' + JSON.stringify(result).slice(0, 220))); };

// ---------- helpers ----------
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
  let pin = null;
  try { pin = (JSON.parse(tasks).tasks || []).find((t) => t.kind === 'pin'); } catch {}
  return { registry_sha: sha(reg), taskstore_sha: sha(Buffer.from(tasks, 'utf8')), pin: pin ? pin.pin : null };
};

// ---------- start four repositories (fresh stores) ----------
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
await writeFile(join(B_HOME, 'operator-ui', 'b-registry.json'), JSON.stringify({ registry_version: 'rcos-public-v1', capabilities: [] }, null, 2) + '\n', 'utf8');
await rm(join(B_HOME, 'operator-ui', 'tasks.json'), { force: true });
for (const port of Object.values(R_PORTS)) {
  killListener(port);
}
await new Promise((r) => setTimeout(r, 1000));
for (const id of Object.keys(R_PORTS)) { await restartFreshStore(id); }
const ep = (id) => `http://127.0.0.1:${R_PORTS[id]}`;
const PEERS = [ { repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }, { repository_id: 'r3', endpoint: ep('r3') } ];
const resolveOn = (peers, q) => post(B, '/plugins/operator-ui/federation?op=resolve', { peers, ...q });
step('four fresh repositories started on consumer-assigned endpoints', (await get(ep('r1'), '/status')).status === 200 && (await get(ep('r4'), '/status')).status === 200, { ports: R_PORTS });

// ---------- P: genesis + chain ----------
const P = generateKeypair();
const genesis = createGenesis(P, 'publisher-p');
const K1 = generateKeypair();
const ev1 = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 1, prevRecordDigest: recordDigest(genesis), action: 'AUTHORIZE', keyId: deriveKeyId(K1.publicKeyRaw), publicKeyRaw: K1.publicKeyRaw, permissions: ['publish'] });
const chain1 = replayChain(genesis, [ev1]);
await post(ep('r1'), '/publisher', { genesis, events: [ev1] });
await post(ep('r2'), '/publisher', { genesis, events: [ev1] });
await post(ep('r3'), '/publisher', { genesis, events: [ev1] });

// ---------- positive: same package published to R1 and R2 ----------
const exp = await post(A, '/plugins/operator-ui/flowrouter?op=export', { capabilityId: 'csv-running-total', outDir: join(WORK, 'export') });
const A_PKG = exp.body.packageDir;
const files0 = await artifactOf(A_PKG);
const D0 = p0DigestOfFiles(files0);
const art0 = artB64(files0);
const pub0 = signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest });
const pubBody = { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', artifact: art0, publication: pub0 };
const p1res = await post(ep('r1'), '/publish', pubBody);
const p2res = await post(ep('r2'), '/publish', pubBody);
step('P publishes the same authenticated package to R1 and R2', p1res.status === 200 && p2res.status === 200 && p1res.body.D === D0 && p2res.body.D === D0, { r1: p1res.body.publisher_auth, r2: p2res.body.publisher_auth });

const Q = { scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0' };
const before = await bAuthorityState();
const r2v = await resolveOn([{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }], Q);
step('positive resolve over two VALID replicas → CONSISTENT with candidate', r2v.body.state === 'CONSISTENT' && r2v.body.candidate && r2v.body.candidate.D === D0 && r2v.body.fetch_permitted === true, { state: r2v.body.state, peers: r2v.body.observations.map((o) => o.repository_id + ':' + o.status) });

// A configured peer that simply does not carry the tuple is ABSENT — the
// frozen aggregate for VALID+VALID+ABSENT is PARTIAL (never CONSISTENT),
// and the candidate/fetch permission are unaffected.
const r = await resolveOn(PEERS, Q);
step('third configured peer ABSENT → PARTIAL (not CONSISTENT), candidate + fetch still permitted', r.body.state === 'PARTIAL' && r.body.candidate && r.body.candidate.D === D0 && r.body.fetch_permitted === true && r.body.observations.find((o) => o.repository_id === 'r3').status === 'ABSENT', { state: r.body.state, peers: r.body.observations.map((o) => o.repository_id + ':' + o.status) });

const rid = r.body.observations.find((o) => o.status === 'VALID').repository_id;
const fe = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: r.body.resolution_handle, D: D0 });
step('exact-D fetch via the B-authored resolution handle; D recomputed on receipt + canonical proof material returned', fe.status === 200 && fe.body.recomputed_D === D0 && fe.body.fetched_from === rid && !!fe.body.material && !!fe.body.proof_state, { from: fe.body.fetched_from, recomputed: fe.body.recomputed_D ? String(fe.body.recomputed_D).slice(0, 16) : (fe.body.error || 'missing'), proof_source: fe.body.proof_source });

// ---------- full sealed local path to SHIP ----------
if (!fe.body.bytes_b64) {
  // No crash on a failed fetch — record the positive-path failure and keep
  // the adversarial matrix running so the receipt shows everything at once.
  step('federation-resolved capability → sealed local path → SHIP', false, { reason: 'fetch produced no artifact bytes', fetch_status: fe.status, fetch_error: fe.body.error || null });
} else {
  const incoming = join(WORK, 'b-incoming');
  await rm(incoming, { recursive: true, force: true });
  for (const f of JSON.parse(Buffer.from(fe.body.bytes_b64, 'base64').toString('utf8')).files) {
    const dest = join(incoming, f.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(f.b64, 'base64'));
  }
  // the stage handoff uses the FETCHED canonical F0-selected material —
  // never a peer picked by the caller
  const material = fe.body.material;
  const st = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming, identityMaterial: material, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0 } });
  const ver = await post(B, '/plugins/operator-ui/flowrouter?op=verify', { importTaskId: st.body.import?.taskId, fixtureDir: '/tmp/flowrouter-p0/b-fixture' });
  const adm = await post(B, '/plugins/operator-ui/flowrouter?op=admit', { importTaskId: st.body.import?.taskId });
  let g = (await post(B, '/plugins/operator-ui/goal', { objective: 'Process values.csv in order and report the running total after each row, one per line, as RESULT row=<n> total=<cumulative sum>.' })).body.goal || {};
  const gate = new Set(g.failureCodes || []).has('awaiting-approval');
  if (gate) g = (await post(B, '/plugins/operator-ui/goal', { approveTaskId: g.taskId })).body.goal || {};
  const checks = Object.fromEntries((g.checks || []).map((c) => [c.id, c.pass]));
  step('federation-resolved capability → sealed local path → SHIP', st.body.import?.verdict === 'STAGED' && ver.body.import?.verdict === 'VERIFIED' && adm.body.ok === true && g.verdict === 'SHIP' && gate && checks['objective-satisfaction'] === true, { stage: st.body.import?.verdict, verify: ver.body.import?.verdict, admit: adm.body.ok, verdict: g.verdict, gate });
}

// ================= adversarial =================
// F1: same P2 tuple, different D across repositories → CONFLICT
{
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
  // P legitimately signs a DIFFERENT package for the same tuple (both valid)
  const pubAlt = signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: Dalt, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest });
  const r3pub = await post(ep('r3'), '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', artifact: artB64(altFiles), publication: pubAlt });
  const rc = await resolveOn(PEERS, { scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0' });
  step('F1 same tuple, different D across repositories → CONFLICT (fail-closed, no fetch)', r3pub.status === 200 && rc.body.state === 'CONFLICT' && rc.body.fetch_permitted === false && rc.body.candidate === null, { state: rc.body.state, reason: rc.body.reason });
  // clean up R3's conflicting publication for later steps
  await restartFreshStore('r3');
  await post(ep('r3'), '/publisher', { genesis, events: [ev1] });
}
// F2: forged metadata from one peer → that observation INVALID; valid peers stand
{
  // Simulated repository forgery: R3 publishes the legitimately-signed
  // package, then has its stored publication ASSERTION signature rewritten
  // (service stopped, record tampered, service restarted). The served proof
  // no longer verifies, so B must classify R3 INVALID — while R1/R2 stand
  // and the aggregate stays fetch-capable.
  await post(ep('r3'), '/publish', pubBody);
  killListener(R_PORTS.r3);
  await new Promise((res) => setTimeout(res, 600));
  const pp = join(WORK, 'store-r3', 'publications.jsonl');
  const recs = (await readFile(pp, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const rec of recs) if (rec.material && rec.material.publication) rec.material.publication.signature = Buffer.alloc(64).toString('base64url');
  await writeFile(pp, recs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  serviceStart('r3');
  await waitUp('r3');
  const rf = await resolveOn(PEERS, Q);
  const st3 = rf.body.observations.find((o) => o.repository_id === 'r3')?.status;
  step('F2 forged metadata from one peer → INVALID observation; others stand', st3 === 'INVALID' && rf.body.state === 'PARTIAL' && rf.body.fetch_permitted === true, { r3: st3, state: rf.body.state });
}
// F3: one peer unavailable → exact-D retrieval from another
{
  killListener(R_PORTS.r1);
  await new Promise((res) => setTimeout(res, 800));
  const ru = await resolveOn([{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }], { scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0' });
  const st1 = ru.body.observations.find((o) => o.repository_id === 'r1')?.status;
  const fu = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: ru.body.resolution_handle, D: D0 });
  step('F3 unavailable peer → UNAVAILABLE; fetch exact-D from the other VALID peer', st1 === 'UNAVAILABLE' && ru.body.state === 'PARTIAL' && fu.status === 200 && fu.body.fetched_from === 'r2' && fu.body.recomputed_D === D0, { r1: st1, from: fu.body.fetched_from });
  serviceStart('r1');
  await waitUp('r1');
}
// F4: repository omitting the publication → ABSENT → PARTIAL with a valid peer
{
  const ro = await resolveOn([{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r4', endpoint: ep('r4') }], { scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0' });
  const st4 = ro.body.observations.find((o) => o.repository_id === 'r4')?.status;
  step('F4 repository omitting the publication → ABSENT → PARTIAL', st4 === 'ABSENT' && ro.body.state === 'PARTIAL' && ro.body.fetch_permitted === true, { r4: st4, state: ro.body.state });
}
// F5: duplicate identical mirrors → CONSISTENT, no trust inflation
{
  const rm2 = await resolveOn([{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }], { scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0' });
  const heads = rm2.body.observations.filter((o) => o.status === 'VALID').map((o) => o.head_digest);
  step('F5 duplicate identical mirrors → CONSISTENT, one identical head (no inflation)', rm2.body.state === 'CONSISTENT' && new Set(heads).size === 1, { state: rm2.body.state, heads: heads.map((h) => h.slice(0, 8)) });
}
// F6: P1 same textual identity on two repositories → origin-scoped CONFLICT (never merged)
{
  // legit P1 packages with the publisher nickname component equal on both repos
  const mkP1 = async () => {
    const dir = join(WORK, 'pkg-p1-' + Math.random().toString(36).slice(2, 6));
    execFileSync('cp', ['-R', A_PKG, dir]);
    const capPath = join(dir, 'capability.json');
    const cap = JSON.parse(await readFile(capPath, 'utf8'));
    cap.identity.id = 'nickname/x';
    const wfBytes = await readFile(join(dir, cap.implementation.entrypoint));
    cap.implementation.bundle = { algorithm: 'sha256' };
    const capBytes = Buffer.from(canonicalJson(cap), 'utf8');
    cap.implementation.bundle.package_digest = packageDigest([{ path: 'capability.json', bytes: capBytes }, { path: cap.implementation.entrypoint, bytes: wfBytes }]);
    cap.implementation.bundle.digest = sha(wfBytes);
    await writeFile(capPath, canonicalJson(cap), 'utf8');
    const fs2 = await artifactOf(dir);
    return { art: artB64(fs2), D: p0DigestOfFiles(fs2) };
  };
  const a1 = await mkP1();
  const a2 = await mkP1();
  await post(ep('r1'), '/publish', { publisher_scheme: 'p1-configured-v1', publisher_id: 'nickname', name: 'x', version: '0.1.0', artifact: a1.art });
  await post(ep('r2'), '/publish', { publisher_scheme: 'p1-configured-v1', publisher_id: 'nickname', name: 'x', version: '0.1.0', artifact: a2.art });
  const rp = await resolveOn([{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }], { scheme: 'p1-configured-v1', publisher_id: 'nickname', name: 'x', version: '0.1.0' });
  step('F6 identical textual P1 identity on two repos → origin-scoped, never merged', rp.body.state === 'CONFLICT' && /origin-scoped/.test(rp.body.reason || ''), { state: rp.body.state, reason: rp.body.reason });
}
// F7: exact-D fetch NOT permitted after CONFLICT/EMPTY
{
  const rc = await resolveOn([{ repository_id: 'r9', endpoint: 'http://127.0.0.1:19999' }], { scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0' });
  const bad = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: rc.body.resolution_handle, D: D0 });
  step('F7 EMPTY resolution has no fetch path', rc.body.state === 'EMPTY' && bad.status === 409 && bad.body.error === 'FETCH_NOT_PERMITTED', { state: rc.body.state, fetch: bad.body.error });
}
// F8: duplicate configured repository_id → federation refuses to start
{
  const dup = await resolveOn([{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r1', endpoint: ep('r2') }], { scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0' });
  step('F8 duplicate configured repository_id → federation refuses to start', dup.status === 409 && dup.body.error === 'PEER_DUPLICATE_ID', dup.body);
}

// ================= resolve → fetch handoff attacks =================
// The resolution is B's own (handle-referenced); the fetch re-observes its
// byte source and independently rebinds the full tuple. A caller can
// neither replay a resolution nor steer the proof material.
{
  const replay = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolveResult: r.body, D: D0 });
  const forged = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: 'fedres_' + 'a'.repeat(32), D: D0 });
  const wrongD = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: r.body.resolution_handle, D: '0'.repeat(64) });
  step('H1 caller-supplied resolve JSON, forged handle, mismatched D → all FETCH_NOT_PERMITTED', replay.status === 409 && replay.body.error === 'FETCH_NOT_PERMITTED' && forged.status === 409 && forged.body.error === 'FETCH_NOT_PERMITTED' && wrongD.status === 409 && wrongD.body.error === 'FETCH_NOT_PERMITTED', { replay: replay.body.error, forged: forged.body.error, wrong_d: wrongD.body.error });
}
// H2: the caller may only steer the byte source among peers ALREADY VALID
// for this exact tuple/D — a peer that never carried it is refused.
{
  const steer = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: r.body.resolution_handle, D: D0, bytes_from: 'r4' });
  step('H2 bytes_from a peer not VALID for this exact tuple/D → FETCH_NOT_PERMITTED', steer.status === 409 && steer.body.error === 'FETCH_NOT_PERMITTED', { error: steer.body.error, reason: String(steer.body.reason || '').slice(0, 120) });
}
// H3: a resolution recorded VALID, then the sources stop carrying it —
// fetch fails closed by RE-OBSERVATION, not by trusting the stored status.
{
  await restartFreshStore('r1');
  await restartFreshStore('r2');
  const stale = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: r.body.resolution_handle, D: D0 });
  step('H3 peers stop carrying a previously VALID tuple → fetch fails closed on re-observation', stale.status === 409 && ['FETCH_UNAVAILABLE', 'FETCH_NOT_PERMITTED'].includes(stale.body.error), { error: stale.body.error, reason: String(stale.body.reason || '').slice(0, 140) });
}
// H4: bytes actually substituted at the byte source after resolution —
// recomputation rejects them and failover serves the honest mirror.
{
  await post(ep('r1'), '/publisher', { genesis, events: [ev1] });
  await post(ep('r2'), '/publisher', { genesis, events: [ev1] });
  const p1res2 = await post(ep('r1'), '/publish', pubBody);
  const p2res2 = await post(ep('r2'), '/publish', pubBody);
  const res2 = await resolveOn([{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }], Q);
  const goodBlob = await readFile(join(WORK, 'store-r1', 'blobs', D0 + '.pkg'));
  const swapped = JSON.parse(goodBlob.toString('utf8'));
  const wfEntry = swapped.files.find((f) => f.path !== 'capability.json');
  wfEntry.b64 = Buffer.from('# substituted artifact bytes\n').toString('base64');
  await writeFile(join(WORK, 'store-r1', 'blobs', D0 + '.pkg'), JSON.stringify(swapped), 'utf8');
  const fs2 = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: res2.body.resolution_handle, D: D0, bytes_from: 'r1' });
  await writeFile(join(WORK, 'store-r1', 'blobs', D0 + '.pkg'), goodBlob);
  step('H4 substituted bytes at the requested source are rejected; honest mirror serves instead', p1res2.status === 200 && p2res2.status === 200 && fs2.status === 200 && fs2.body.fetched_from === 'r2' && fs2.body.recomputed_D === D0, { from: fs2.body.fetched_from, recomputed: fs2.body.recomputed_D ? String(fs2.body.recomputed_D).slice(0, 16) : (fs2.body.error || null) });
}

// ================= causality checks ===============
// C1: peer-order permutation → identical aggregate/candidate
{
  const order = (peers) => resolveOn(peers, { scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0' });
  const o1 = await order([{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }, { repository_id: 'r3', endpoint: ep('r3') }]);
  const o2 = await order([{ repository_id: 'r3', endpoint: ep('r3') }, { repository_id: 'r2', endpoint: ep('r2') }, { repository_id: 'r1', endpoint: ep('r1') }]);
  const norm = (x) => JSON.stringify({
    s: x.body.state,
    c: x.body.candidate && {
      D: x.body.candidate.D,
      seq: x.body.candidate.proof_state && x.body.candidate.proof_state.head_sequence,
      // the SELECTED proof material must be order-independent too
      source: x.body.candidate.material_source,
      material: x.body.candidate.material && sha(Buffer.from(canonicalJson(x.body.candidate.material), 'utf8')).slice(0, 16),
    },
  });
  step('C1 peer-order permutation → identical aggregate + candidate', norm(o1) === norm(o2), { a: norm(o1), b: norm(o2) });
}
// C2: OBSERVE/RESOLVE leaves B's pins/task store byte-identical
{
  const b2 = await bAuthorityState();
  await resolveOn(PEERS, { scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0' });
  const a2 = await bAuthorityState();
  step('C2 OBSERVE/RESOLVE leaves B registry/task store/pin byte-identical', b2.registry_sha === a2.registry_sha && b2.taskstore_sha === a2.taskstore_sha && JSON.stringify(b2.pin) === JSON.stringify(a2.pin), { registry_sha: b2.registry_sha.slice(0, 16), registry_identical: b2.registry_sha === a2.registry_sha, taskstore_sha: b2.taskstore_sha.slice(0, 16), taskstore_identical: b2.taskstore_sha === a2.taskstore_sha, pin_before: b2.pin && b2.pin.sequence, pin_after: a2.pin && a2.pin.sequence, pin_identical: JSON.stringify(b2.pin) === JSON.stringify(a2.pin) });
}
// C3: compatible seq4 + seq6 → seq6 regardless of order; sibling → CONFLICT
{
  // branch A: 4 events; extended: 6 events; sibling: diverging event 2 (same seq 4)
  const mk = (kind) => {
    const evs = [ev1];
    const keys = [K1];
    const mkEv = (seq, action, keyPair, prevEv) => {
      const k = keyPair || generateKeypair();
      if (action === 'AUTHORIZE') keys.push(k);
      return createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: seq, prevRecordDigest: recordDigest(prevEv), action, keyId: deriveKeyId(k.publicKeyRaw), publicKeyRaw: k.publicKeyRaw, permissions: ['publish'] });
    };
    const extra = (n) => { for (let i = 0; i < n; i++) { if (kind === 'sibling' && i === 0) { const k = generateKeypair(); evs.push(createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: evs.length + 1, prevRecordDigest: recordDigest(evs[evs.length - 1]), action: 'AUTHORIZE', keyId: deriveKeyId(k.publicKeyRaw), publicKeyRaw: k.publicKeyRaw, permissions: ['publish'] })); } else evs.push(mkEv(evs.length + 1, 'AUTHORIZE', null, evs[evs.length - 1])); } };
    if (kind !== 'deep') extra(3); // seq 4 total
    if (kind === 'deep') extra(5); // seq 6 total
    return { evs, keys };
  };
  const brA = mk('branch');  // seq4 branch A
  const brD = mk('deep');    // seq6 extension of branch A? — NOT the same branch unless built from brA's events!
  // rebuild properly: deep = branch A events + 2 more
  const deepEvs = [...brA.evs];
  for (let i = 0; i < 2; i++) {
    const k = generateKeypair();
    deepEvs.push(createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: deepEvs.length + 1, prevRecordDigest: recordDigest(deepEvs[deepEvs.length - 1]), action: 'AUTHORIZE', keyId: deriveKeyId(k.publicKeyRaw), publicKeyRaw: k.publicKeyRaw, permissions: ['publish'] }));
  }
  const chainA = replayChain(genesis, brA.evs);
  const chainDeep = replayChain(genesis, deepEvs);
  const brB = mk('sibling'); // seq4 sibling (diverges at seq2)
  const chainB = replayChain(genesis, brB.evs);
  // publish same D0 at state 4 on r1; at state 6 (deep) on r2; sibling at state 4 on r4
  const assertAt = (chain, evs) => signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.3.0', D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain.head_sequence, identityHeadDigest: chain.head_digest });
  for (const [id, chain, evs] of [['r1', chainA, brA.evs], ['r2', chainDeep, deepEvs], ['r4', chainB, brB.evs]]) {
    await post(ep(id), '/publisher', { genesis, events: evs });
    const asr = signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.3.0', D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain.head_sequence, identityHeadDigest: chain.head_digest });
    await post(ep(id), '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.3.0', artifact: art0, publication: asr });
  }
  const q = { scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.3.0' };
  const d1 = await resolveOn([{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }], q);
  const d2 = await resolveOn([{ repository_id: 'r2', endpoint: ep('r2') }, { repository_id: 'r1', endpoint: ep('r1') }], q);
  const seqs = [d1.body.candidate?.proof_state?.head_sequence, d2.body.candidate?.proof_state?.head_sequence];
  step('C3a compatible seq4 + seq6 → seq6 regardless of peer order (labeled non-fresh)', d1.body.state === 'CONSISTENT' && d2.body.state === 'CONSISTENT' && seqs[0] === 6 && seqs[1] === 6 && d1.body.candidate.proof_state.globally_fresh === false, { seqs });
  const sib = await resolveOn([{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r4', endpoint: ep('r4') }], q);
  step('C3b equal-sequence sibling branches → CONFLICT', sib.body.state === 'CONFLICT' && /equal-sequence/.test(sib.body.reason || ''), { state: sib.body.state, reason: sib.body.reason });

  // C3c — the decisive end-to-end: bytes may come from the LOWER (seq-4)
  // mirror, but the sealed P2 stage must receive the F0-SELECTED canonical
  // (seq-6) material, so the pin advances to seq-6 regardless of which
  // mirror served the bytes and regardless of peer order.
  const peers12 = [{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }];
  const peers21 = [{ repository_id: 'r2', endpoint: ep('r2') }, { repository_id: 'r1', endpoint: ep('r1') }];
  const h12 = (await resolveOn(peers12, q)).body;
  const h21 = (await resolveOn(peers21, q)).body;
  const f1 = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: h12.resolution_handle, D: D0, bytes_from: 'r1' });
  const f2 = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: h21.resolution_handle, D: D0, bytes_from: 'r2' });
  const matSeq = (f) => f.body.material && f.body.material.publication.identity_sequence;
  const incoming2 = join(WORK, 'b-incoming-c3');
  await rm(incoming2, { recursive: true, force: true });
  for (const f of JSON.parse(Buffer.from(f1.body.bytes_b64, 'base64').toString('utf8')).files) {
    const dest = join(incoming2, f.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(f.b64, 'base64'));
  }
  const tuple3 = { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.3.0', D: D0 };
  // distinct local aliases: B already owns the plain name from the positive
  // path, and the two causality runs are separate imports
  const s1 = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming2, alias: 'csv-running-total-fed-order12', identityMaterial: f1.body.material, expectedTuple: tuple3 });
  const pin1 = (await bAuthorityState()).pin;
  const s2 = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming2, alias: 'csv-running-total-fed-order21', identityMaterial: f2.body.material, expectedTuple: tuple3 });
  const pin2 = (await bAuthorityState()).pin;
  step('C3c bytes from the seq-4 mirror still stage with F0-selected seq-6 material → pin seq-6 in both orders', f1.body.fetched_from === 'r1' && f2.body.fetched_from === 'r2' && matSeq(f1) === 6 && matSeq(f2) === 6 && s1.body.import?.verdict === 'STAGED' && s2.body.import?.verdict === 'STAGED' && pin1 && pin1.sequence === 6 && pin2 && pin2.sequence === 6, { bytes_from: [f1.body.fetched_from, f2.body.fetched_from], material_seq: [matSeq(f1), matSeq(f2)], stage: [s1.body.import?.verdict, s2.body.import?.verdict], stage_error: [s1.body.error || s1.body.reason || null, s2.body.error || s2.body.reason || null], pin_sequence: [pin1 && pin1.sequence, pin2 && pin2.sequence] });
}

const okAll = receipt.steps.every((s) => s.ok);
receipt.verdict = okAll ? 'F0 MATRIX GREEN — multi-repository resolution deterministic, zero repository authority' : 'MATRIX INCOMPLETE';
await writeFile(join(root, 'eval', 'receipts', 'FLOWROUTER-F0-RECEIPT.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log('\nverdict:', receipt.verdict);
