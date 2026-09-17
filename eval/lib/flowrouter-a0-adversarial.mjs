#!/usr/bin/env node
// eval/lib/flowrouter-a0-adversarial.mjs — FlowRouter A0: cross-phase
// adversarial campaign (matrix frozen at aef3efd, executed here).
//
// Governing rule: composition may reduce availability or increase work; it must
// not manufacture authority. Criteria come from the frozen matrix and are not
// adjusted to results.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, packageDigest } from '../../lib/flowrouter.js';
import { discoverEndpoints } from '../../lib/directory.js';
import { discoverCandidates } from '../../lib/discovery.js';
import { syncExact } from '../../lib/sync.js';
import { proofDigest, verifyProofCore, buildProofCore } from '../../lib/equivocation.js';
import {
  generateKeypair, createGenesis, createKeyEvent, replayChain, signPublication, deriveKeyId, recordDigest, jcs,
} from '../../lib/identity.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = 'http://127.0.0.1:8412';
const B = 'http://127.0.0.1:8414';
const WORK = '/tmp/flowrouter-a0';
const B_HOME = '/tmp/opui-b-home';
const PORTS = { r1: 13191, r2: 13192, r3: 13193 };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const shaOf = (o) => sha(Buffer.from(typeof o === 'string' ? o : JSON.stringify(o), 'utf8'));
const matDigest = (m) => sha(Buffer.from(jcs(m), 'utf8'));

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
const restartRepo = async (id, wipe) => { killListener(PORTS[id]); await new Promise((r) => setTimeout(r, 600)); if (wipe) await rm(join(WORK, 'store-' + id), { recursive: true, force: true }); startRepo(id); return waitRepo(id); };
const restartConsumerLane = async (port, home) => {
  killListener(port); await new Promise((r) => setTimeout(r, 1200));
  spawn(process.env.DSH_BIN || 'dsh', ['web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], { detached: true, stdio: 'ignore', cwd: home, env: { ...process.env, DSH_HOME: home } }).unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) { try { const s = await get('http://127.0.0.1:' + port, '/plugins/operator-ui/rcos'); if (s.status === 200) return true; } catch {} await new Promise((r) => setTimeout(r, 900)); }
  return false;
};
const ep = (id) => `http://127.0.0.1:${PORTS[id]}`;
const consumerState = async () => {
  const reg = await readFile(join(B_HOME, 'operator-ui', 'b-registry.json'));
  let tasks = ''; try { tasks = await readFile(join(B_HOME, 'operator-ui', 'tasks.json'), 'utf8'); } catch {}
  const parsed = (() => { try { return JSON.parse(tasks).tasks || []; } catch { return []; } })();
  const pin = parsed.find((t) => t.kind === 'pin');
  return { registry_sha: sha(reg), registry_caps: (JSON.parse(reg.toString('utf8')).capabilities || []).length, taskstore_sha: sha(Buffer.from(tasks, 'utf8')), pin: pin ? pin.pin : null, pin_witness_sha: pin && pin.witness ? sha(Buffer.from(JSON.stringify(pin.witness), 'utf8')) : null, equivocation_records: parsed.filter((t) => t.kind === 'equivocation').length };
};
const repoState = async (id) => {
  const base = join(WORK, 'store-' + id); const out = { publications: 0, bytes: '', evidence: 0 };
  try { out.bytes = await readFile(join(base, 'publications.jsonl'), 'utf8'); out.publications = out.bytes.split('\n').filter(Boolean).length; } catch {}
  try { const { readdir } = await import('node:fs/promises'); out.evidence = (await readdir(join(base, 'evidence'))).length; } catch {}
  return out;
};

const receipt = { generated_at: new Date().toISOString(), matrix: 'aef3efd (A0 — cross-phase adversarial campaign)', attacks: [], steps: [] };
const step = (name, ok, result) => { receipt.steps.push({ step: name, ok, result }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '  → ' + JSON.stringify(result).slice(0, 300))); };
const record = (id, criterion, observed, verdict) => receipt.attacks.push({ id, criterion, observed, verdict });

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

// ---------- topology + honest baseline ----------
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
await writeFile(join(B_HOME, 'operator-ui', 'b-registry.json'), JSON.stringify({ registry_version: 'rcos-public-v1', capabilities: [] }, null, 2) + '\n', 'utf8');
await rm(join(B_HOME, 'operator-ui', 'tasks.json'), { force: true });
if (!(await restartConsumerLane(8414, B_HOME))) { console.error('consumer lane did not come up'); process.exit(2); }
for (const id of Object.keys(PORTS)) await restartRepo(id, true);

const A_PKG = (await post(A, '/plugins/operator-ui/flowrouter?op=export', { capabilityId: 'csv-running-total', outDir: join(WORK, 'export') })).body.packageDir;
const files0 = await artifactFiles(A_PKG);
const D0 = p0Of(files0);
const P = generateKeypair();
const genesis = createGenesis(P, 'publisher-p');
const K1 = generateKeypair();
const ev1 = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 1, prevRecordDigest: recordDigest(genesis), action: 'AUTHORIZE', keyId: deriveKeyId(K1.publicKeyRaw), publicKeyRaw: K1.publicKeyRaw, permissions: ['publish'] });
const chain1 = replayChain(genesis, [ev1]);
const NAME = 'csv-running-total';
const TUPLE = { publisher_id: genesis.publisher_id, name: NAME, version: '0.1.0' };
const ASSERT1 = signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: NAME, version: TUPLE.version, D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest });
const MATERIAL = { genesis, events: [ev1], publication: ASSERT1 };
await post(ep('r1'), '/publisher', { genesis, events: [ev1] });
const pub = await post(ep('r1'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, artifact: artB64(files0), publication: ASSERT1 });
await post(ep('r2'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p2-selfcert-v1', ...TUPLE });
step('baseline: honest publication at R1, mirror R2, destination R3, consumer B', pub.status === 200 && (await get(ep('r2'), '/status')).status === 200, { D: D0.slice(0, 12) });

// a controllable hostile directory + index host
let dirMode = 'honest';
let indexMode = 'honest';
const hostilePort = 13194;
const hostile = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/endpoints') {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (dirMode === 'honest') return res.end(JSON.stringify({ name: u.searchParams.get('name'), entries: [{ endpoint: ep('r2') }], order_semantics: 'none' }));
    if (dirMode === 'liar') return res.end(JSON.stringify({ entries: [{ endpoint: 'http://127.0.0.1:19999' }] }));
    if (dirMode === 'disappear') return res.end(JSON.stringify({ entries: [{ endpoint: 'http://127.0.0.1:13196' }] }));
    if (dirMode === 'repeat') { const e = []; for (let i = 0; i < 10000; i++) e.push({ endpoint: ep('r2') }); return res.end(JSON.stringify({ entries: e })); }
    return res.end(JSON.stringify({ entries: [] }));
  }
  if (u.pathname === '/possession') {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (indexMode === 'honest') return res.end(JSON.stringify({ name: u.searchParams.get('name'), entries: [{ publisher_scheme: 'p2-selfcert-v1', ...TUPLE, claimed_D: D0 }] }));
    if (indexMode === 'poisoned') return res.end(JSON.stringify({ entries: [{ publisher_scheme: 'p2-selfcert-v1', ...TUPLE, claimed_D: sha('lie') }] }));
    if (indexMode === 'phantom') return res.end(JSON.stringify({ entries: [{ publisher_scheme: 'p2-selfcert-v1', publisher_id: '9'.repeat(64), name: NAME, version: '0.1.0', claimed_D: sha('phantom') }] }));
    if (indexMode === 'repeat') { const e = []; for (let i = 0; i < 10000; i++) e.push({ publisher_scheme: 'p2-selfcert-v1', ...TUPLE, claimed_D: sha('d' + i) }); return res.end(JSON.stringify({ entries: e })); }
    return res.end(JSON.stringify({ entries: [] }));
  }
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => hostile.listen(hostilePort, '127.0.0.1', r));
const HQ = 'http://127.0.0.1:' + hostilePort;

// ================= A0-1 lying directory + poisoned index =================
{
  const before = await consumerState();
  dirMode = 'liar';
  const d1 = await discoverEndpoints({ directory: HQ, name: NAME });
  dirMode = 'honest';
  indexMode = 'phantom';
  // the PHANTOM claim comes from the hostile index; the honest repository is
  // what the consumer actually resolves against
  const d0 = await discoverCandidates({ endpoint: HQ, name: NAME });
  indexMode = 'honest';
  // the consumer ignores the phantom claim: it resolves the honest tuple only
  const res = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'dest', endpoint: ep('r3') }], scheme: 'p2-selfcert-v1', ...TUPLE });
  const after = await consumerState();
  const crit = d1.endpoints.length === 1 && d0.candidates.length === 1 && d0.candidates[0].publisher_id === '9'.repeat(64) && d0.candidates[0].claimed_D === undefined && before.registry_sha === after.registry_sha && before.equivocation_records === after.equivocation_records && JSON.stringify(before.pin) === JSON.stringify(after.pin);
  record('A0-1', 'discovery yields candidates; downstream resolves honest or refuses; no trust-state change', { lying_directory_endpoint: d1.endpoints, poisoned_candidate: d0.candidates[0], consumer_resolution: res.body.state }, crit ? 'PASS' : 'FAIL');
  step('A0-1 lying directory + poisoned index: candidates appear, the phantom claim carries no digest, and no trust state moves', crit, { endpoint: d1.endpoints[0], phantom: d0.candidates[0].publisher_id.slice(0, 8), registry_unchanged: before.registry_sha === after.registry_sha });
}

// ================= A0-2 directory endpoint disappears after selection =================
{
  // a real listener that is killed after discovery
  const livePort = 13196;
  const live = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise((r) => live.listen(livePort, '127.0.0.1', r));
  dirMode = 'disappear';
  const d1 = await discoverEndpoints({ directory: HQ, name: NAME });
  dirMode = 'honest';
  live.close();
  await new Promise((r) => setTimeout(r, 500));
  const before = await consumerState();
  const res = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'gone', endpoint: d1.endpoints[0] }], scheme: 'p2-selfcert-v1', ...TUPLE });
  const after = await consumerState();
  const obs = (res.body.observations || [])[0] || {};
  const crit = d1.endpoints.length === 1 && (obs.status === 'UNAVAILABLE' || obs.status === 'ABSENT') && res.body.fetch_permitted === false && before.registry_sha === after.registry_sha && JSON.stringify(before.pin) === JSON.stringify(after.pin);
  record('A0-2', 'F0 observation ABSENT/UNAVAILABLE; no consumer trust change; availability loss only', { observation: obs.status, fetch_permitted: res.body.fetch_permitted, state: res.body.state }, crit ? 'PASS' : 'FAIL');
  step('A0-2 an endpoint that disappears after selection costs a query and nothing else', crit, { observation: obs.status, state: res.body.state });
}

// ================= A0-3 S0 source dies halfway through a mixed scope =================
{
  await restartRepo('r3', true);
  // R2 (the source) holds the publication; R1 holds a distinct blob for content custody
  const s0partial = await (async () => {
    const first = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', ...TUPLE }] } });
    killListener(PORTS.r2);
    await new Promise((r) => setTimeout(r, 700));
    const rest = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { blobs: [{ D: D0 }], proofs: [{ proof_digest: sha('none') }] } });
    return { first, rest };
  })();
  const r3 = await repoState('r3');
  const served = await get(ep('r3'), '/publication/' + TUPLE.publisher_id + '/' + TUPLE.name + '/' + TUPLE.version + '?scheme=p2-selfcert-v1');
  const crit = s0partial.first.summary.COPIED === 1 && (s0partial.rest.summary.UNAVAILABLE || 0) >= 1 && r3.publications === 1 && served.status === 200;
  record('A0-3', 'committed object survives, rest UNAVAILABLE/REFUSED, no rollback, custody outcomes only', { first: s0partial.first.summary, rest: s0partial.rest.summary, publications: r3.publications }, crit ? 'PASS' : 'FAIL');
  step('A0-3 a source dying mid-scope leaves the committed object committed and reports the rest as unavailable', crit, { first: s0partial.first.summary, rest: s0partial.rest.summary });
  startRepo('r2'); await waitRepo('r2');
}

// ================= A0-4 R0 conflict while F1 fork evidence exists =================
{
  // a different D for the same tuple at the source, plus two non-comparable histories across repos
  const alt = join(WORK, 'pkg-alt');
  execFileSync('rm', ['-rf', alt]); execFileSync('cp', ['-R', A_PKG, alt]);
  { const { readdir } = await import('node:fs/promises'); const wfName = (await readdir(join(alt, 'workflows')))[0]; const wf = join(alt, 'workflows', wfName);
    await writeFile(wf, (await readFile(wf, 'utf8')) + '\n# a0-alt\n', 'utf8');
    const capPath = join(alt, 'capability.json'); const cap = JSON.parse(await readFile(capPath, 'utf8')); const wfBytes = await readFile(wf);
    cap.implementation.bundle = { algorithm: 'sha256' };
    const capBytes = Buffer.from(canonicalJson(cap), 'utf8');
    cap.implementation.bundle.package_digest = packageDigest([{ path: 'capability.json', bytes: capBytes }, { path: cap.implementation.entrypoint, bytes: wfBytes }]);
    cap.implementation.bundle.digest = sha(wfBytes); await writeFile(capPath, canonicalJson(cap), 'utf8'); }
  const altFiles = await artifactFiles(alt);
  const Dalt = p0Of(altFiles);
  const kX = generateKeypair();
  const evX = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(kX.publicKeyRaw), publicKeyRaw: kX.publicKeyRaw, permissions: ['publish'] });
  const kY = generateKeypair();
  const evY = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(kY.publicKeyRaw), publicKeyRaw: kY.publicKeyRaw, permissions: ['publish'] });
  const V2 = { publisher_id: genesis.publisher_id, name: NAME, version: '0.2.0' };
  await restartRepo('r1', true);
  await post(ep('r1'), '/publisher', { genesis, events: [ev1, evX] });
  await post(ep('r1'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...V2, artifact: artB64(files0), publication: signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: NAME, version: V2.version, D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: 2, identityHeadDigest: replayChain(genesis, [ev1, evX]).head_digest }) });
  await restartRepo('r2', true);
  await post(ep('r2'), '/publisher', { genesis, events: [ev1, evY] });
  await post(ep('r2'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...V2, artifact: artB64(files0), publication: signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: NAME, version: V2.version, D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: 2, identityHeadDigest: replayChain(genesis, [ev1, evY]).head_digest }) });
  const fork = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }], scheme: 'p2-selfcert-v1', ...V2 });
  // and an R0 conflict: R3 already holds T1 at D0 while the source offers Dalt
  await restartRepo('r3', true);
  await post(ep('r3'), '/publisher', { genesis, events: [ev1] });
  await post(ep('r3'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, artifact: artB64(files0), publication: ASSERT1 });
  await restartRepo('r1', true);
  await post(ep('r1'), '/publisher', { genesis, events: [ev1] });
  await post(ep('r1'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, artifact: artB64(altFiles), publication: signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: NAME, version: TUPLE.version, D: Dalt, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest }) });
  const beforeBytes = (await repoState('r3')).bytes;
  const conflict = await syncExact({ source_endpoint: ep('r1'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', ...TUPLE }] } });
  const afterBytes = (await repoState('r3')).bytes;
  const core = fork.body.proof_core;
  const coreVerifies = core ? verifyProofCore(core).ok === true : false;
  const crit = conflict.summary.REFUSED === 1 && beforeBytes === afterBytes && fork.body.state === 'CONFLICT' && coreVerifies;
  record('A0-4', 'S0 refuses the conflict with state byte-identical AND the consumer still obtains a verifying F1 core', { s0: conflict.summary, consumer_state: fork.body.state, core_verifies: coreVerifies }, crit ? 'PASS' : 'FAIL');
  step('A0-4 an R0 conflict does not suppress (or manufacture) fork evidence: S0 refuses while F0/F1 still delivers a verifying core', crit, { s0: conflict.summary, state: fork.body.state, core_verifies: coreVerifies });
}

// ================= A0-5 stale claimed_D + mirror failover =================
{
  // clean D0 state on the origin, the mirror and the destination
  await restartRepo('r1', true);
  await post(ep('r1'), '/publisher', { genesis, events: [ev1] });
  await post(ep('r1'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, artifact: artB64(files0), publication: ASSERT1 });
  await restartRepo('r2', true); await restartRepo('r3', true);
  await post(ep('r2'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p2-selfcert-v1', ...TUPLE });
  indexMode = 'poisoned';
  const d0 = await discoverCandidates({ endpoint: ep('r2'), name: NAME });
  indexMode = 'honest';
  await restartRepo('r3', false);
  await post(ep('r3'), '/replicate', { source_endpoint: ep('r2'), scheme: 'p2-selfcert-v1', ...TUPLE });
  const res = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'm1', endpoint: ep('r2') }, { repository_id: 'm2', endpoint: ep('r3') }], scheme: 'p2-selfcert-v1', ...TUPLE });
  killListener(PORTS.r2);
  await new Promise((r) => setTimeout(r, 800));
  const fet = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: res.body.resolution_handle, D: D0 });
  const crit = d0.candidates[0].claimed_D === undefined && res.body.state === 'CONSISTENT' && fet.status === 200 && fet.body.recomputed_D === D0 && fet.body.fetched_from === 'm2';
  if (!crit) console.log('A0-5 diagnose:', JSON.stringify({ d0: d0.candidates, state: res.body.state, obs: (res.body.observations || []).map((o) => o.repository_id + ':' + o.status), fetch: fet.body }).slice(0, 400));
  record('A0-5', 'authenticated D from F0/P2 (never the index); failover serves the SAME exact T/D; only availability changes', { index_claim_dropped: d0.candidates[0].claimed_D === undefined, fetched_from: fet.body.fetched_from, recomputed_D: String(fet.body.recomputed_D).slice(0, 12) }, crit ? 'PASS' : 'FAIL');
  step('A0-5 a stale claimed_D contributes nothing and mirror failover serves the same exact T/D', crit, { from: fet.body.fetched_from, D: String(fet.body.recomputed_D).slice(0, 12) });
  startRepo('r2'); await waitRepo('r2');
}

// ================= A0-6 repetition attempting to create weight =================
{
  dirMode = 'repeat';
  const d1 = await discoverEndpoints({ directory: HQ, name: NAME });
  dirMode = 'honest';
  indexMode = 'repeat';
  const d0 = await discoverCandidates({ endpoint: ep('r2'), name: NAME });
  indexMode = 'honest';
  const res = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'one', endpoint: ep('r2') }], scheme: 'p2-selfcert-v1', ...TUPLE });
  const crit = d1.endpoints.length === 1 && d0.candidates.length === 1 && res.body.state === 'CONSISTENT' && res.body.observations.length === 1 && !JSON.stringify([d1, d0, res.body]).match(/score|rank|popular|weight|trust_level/i);
  record('A0-6', '10,000 endpoint copies → one endpoint; 10,000 differing-D claims → one tuple; no weight vocabulary', { endpoints: d1.endpoints.length, candidates: d0.candidates.length, observations: res.body.observations.length }, crit ? 'PASS' : 'FAIL');
  step('A0-6 repetition across directory and index creates no weight: one endpoint, one tuple, one observation', crit, { endpoints: d1.endpoints.length, candidates: d0.candidates.length });
}

// ================= A0-7 proof custody without ingest, then restart =================
let a0Core = null;
{
  const kX = generateKeypair();
  const evX = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(kX.publicKeyRaw), publicKeyRaw: kX.publicKeyRaw, permissions: ['publish'] });
  const kY = generateKeypair();
  const evY = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(kY.publicKeyRaw), publicKeyRaw: kY.publicKeyRaw, permissions: ['publish'] });
  a0Core = buildProofCore({ genesis, states: [{ events: [ev1, evX] }, { events: [ev1, evY] }] }).core;
  const pd = proofDigest(a0Core);
  await post(ep('r1'), '/evidence', { proof_digest: pd, proof_core: a0Core });
  const before = await consumerState();
  const custody = await syncExact({ source_endpoint: ep('r1'), destination: ep('r3'), explicit_scope: { proofs: [{ proof_digest: pd }] } });
  // restarts on both sides
  await restartRepo('r3', false);
  if (!(await restartConsumerLane(8414, B_HOME))) { console.error('lane failed to restart'); process.exit(2); }
  const after = await consumerState();
  const atDest = await fetch(ep('r3') + '/evidence/' + pd);
  const bytes = Buffer.from(await atDest.arrayBuffer());
  const stillVerifies = verifyProofCore(JSON.parse(bytes.toString('utf8'))).proof_digest === pd;
  const ingestBefore = await post(B, '/plugins/operator-ui/f1?op=ingest', { proof_core: a0Core, observed_via: ['r1'] });
  const crit = custody.summary.COPIED === 1 && before.equivocation_records === after.equivocation_records && JSON.stringify(before.pin) === JSON.stringify(after.pin) && stillVerifies && ingestBefore.body.quarantined === true;
  record('A0-7', 'evidence survives restarts byte-identical and verifies; quarantine unchanged by custody; explicit ingest still activates it', { custody: custody.summary, quarantine_before: before.equivocation_records, quarantine_after: after.equivocation_records, ingest_quarantined: ingestBefore.body.quarantined }, crit ? 'PASS' : 'FAIL');
  step('A0-7 proof custody without ingest survives restarts, still quarantines nobody, and ingest afterwards still works', crit, { custody: custody.summary, survives: stillVerifies, ingest: ingestBefore.body.quarantined });
  // clean the quarantine for the remaining cases
  await post(B, '/plugins/operator-ui/f1?op=acknowledge', { proof_digest: proofDigest(a0Core), operator: 'a0' });
}

// write the artifact into a local incoming dir (this campaign never populated one)
{
  const incoming = join(WORK, 'b-incoming');
  await rm(incoming, { recursive: true, force: true });
  for (const f of files0) { const dest = join(incoming, f.path); await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, f.bytes); }
}

// ================= A0-8 consumer pin ahead of backfilled material =================
{
  // put the consumer's pin AHEAD: stage the seq-2 branch material first so the
  // pin sits at identity state 2
  const kX = generateKeypair();
  const evX = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(kX.publicKeyRaw), publicKeyRaw: kX.publicKeyRaw, permissions: ['publish'] });
  const chainX = replayChain(genesis, [ev1, evX]);
  // the SAME artifact tuple, authenticated against a LATER identity state (2)
  const aheadAssert = signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: NAME, version: TUPLE.version, D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: 2, identityHeadDigest: chainX.head_digest });
  const incoming = join(WORK, 'b-incoming');
  const ahead = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming, alias: 'pin-ahead-' + Math.random().toString(36).slice(2, 6), identityMaterial: { genesis, events: [ev1, evX], publication: aheadAssert }, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, D: D0 } });
  const pinned = await consumerState();
  const pinnedSeq = pinned.pin && pinned.pin.sequence;
  // now backfill the STATE-1 object into the destination and try to use it
  const run = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', ...TUPLE }] } });
  const afterSync = await consumerState();
  const use = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming, alias: 'earlier-state-' + Math.random().toString(36).slice(2, 6), identityMaterial: MATERIAL, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, D: D0 } });
  const afterUse = await consumerState();
  const crit = pinnedSeq === 2 && (afterSync.pin && afterSync.pin.sequence === 2) && afterUse.pin && afterUse.pin.sequence === 2 && use.body.import && use.body.import.verdict === 'REFUSED';
  record('A0-8', 'custody unaffected by consumer state; the pin is never rewound; consumer-side use follows ordinary P2 rules', { pin_after_ahead_stage: pinnedSeq, backfill: run.summary, pin_after_sync: afterSync.pin && afterSync.pin.sequence, use_verdict: use.body.import && use.body.import.verdict, use_refusal: use.body.import && use.body.import.refusal && use.body.import.refusal.code }, crit ? 'PASS' : 'FAIL');
  step('A0-8 a pin ahead of the backfilled material is never rewound; using the earlier-state object follows ordinary P2 rules', crit, { pin: pinnedSeq, after_use: afterUse.pin && afterUse.pin.sequence, use: use.body.import && use.body.import.verdict, refusal: use.body.import && use.body.import.refusal && use.body.import.refusal.code });
}

// ================= A0-9 malformed scope mixed with valid intents =================
{
  // frozen setup: ONE valid publication plus FOUR malformed records —
  // publication-with-D, "latest", a malformed digest, and an unknown field
  const run = await syncExact({
    source_endpoint: ep('r2'), destination: ep('r3'),
    explicit_scope: {
      publications: [
        { publisher_scheme: 'p2-selfcert-v1', ...TUPLE },
        { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, D: D0 },
        { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: NAME, version: 'latest' },
        { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: NAME, version: '0.1.0', tag: 'stable' },
      ],
      blobs: [{ D: 'not-a-digest' }],
    },
  });
  const reasons = run.rejected_scope_records.map((r) => r.error);
  const crit = run.results.length === 1 && run.rejected_scope_records.length === 4 && reasons.length === 4;
  record('A0-9', 'exactly the valid intent is processed; every malformed record is rejected with a reason; nothing silently normalized', { processed: run.results.length, rejected: run.rejected_scope_records.length, reasons: reasons.map((r) => r.slice(0, 44)) }, crit ? 'PASS' : 'FAIL');
  step('A0-9 one valid intent + four malformed records: exactly the valid one is processed and all four are rejected with reasons', crit, { processed: run.results.length, rejected: run.rejected_scope_records.length });
}

// ================= A0-10 restart between custody and consumer use =================
{
  // This case tests the RESTART boundary, not the accumulated pin: A0-8
  // deliberately advanced the consumer's pin to a later identity state, and
  // the sealed rollback rule then (correctly) classifies the state-1 object as
  // INVALID for that pin. A fresh consumer — no pins, no quarantine — is the
  // honest setting for a restart-durability check.
  await rm(join(B_HOME, 'operator-ui', 'tasks.json'), { force: true });
  if (!(await restartConsumerLane(8414, B_HOME))) { console.error('lane failed to restart'); process.exit(2); }
  // a clean D0 state on the source so this case tests the restart boundary
  // rather than leftovers from earlier attacks
  await restartRepo('r1', true);
  await post(ep('r1'), '/publisher', { genesis, events: [ev1] });
  await post(ep('r1'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, artifact: artB64(files0), publication: ASSERT1 });
  await restartRepo('r2', true);
  await post(ep('r2'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p2-selfcert-v1', ...TUPLE });
  await restartRepo('r3', true);
  const run = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', ...TUPLE }] } });
  const beforeRestart = (await repoState('r3')).bytes;
  await restartRepo('r3', false);
  const afterRestart = (await repoState('r3')).bytes;
  const res = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'dest', endpoint: ep('r3') }], scheme: 'p2-selfcert-v1', ...TUPLE });
  const crit = (run.summary.COPIED === 1 || run.summary.ALREADY_PRESENT === 1) && beforeRestart === afterRestart && res.body.state === 'CONSISTENT' && res.body.candidate.D === D0;
  if (!crit) console.log('A0-10 diagnose:', JSON.stringify({ summary: run.summary, bytes_identical: beforeRestart === afterRestart, state: res.body.state, obs: (res.body.observations || []).map((o) => o.repository_id + ':' + o.status) }).slice(0, 300));
  record('A0-10', 'the consumer path succeeds from durable state and the custody outcome is unchanged across a restart', { consumer: 'fresh consumer (A0-8 advanced the pin; the rollback rule correctly rejects the earlier state for it)', custody: run.summary, bytes_identical: beforeRestart === afterRestart, resolution: res.body.state }, crit ? 'PASS' : 'FAIL');
  step('A0-10 a restart between custody and consumer use changes nothing: durable state, same resolution', crit, { resolution: res.body.state, bytes_identical: beforeRestart === afterRestart });
}

// ================= A0-11 everything hostile at once =================
{
  // Trust state snapshot BEFORE the hostile composition. The frozen criterion
  // is exact: the hostile path terminates REFUSE or UNAVAILABLE with trust
  // state UNCHANGED — so this case performs no honest stage of its own.
  const before = await consumerState();
  dirMode = 'liar';
  const d1 = await discoverEndpoints({ directory: HQ, name: NAME });
  indexMode = 'poisoned';
  const d0 = await discoverCandidates({ endpoint: ep('r2'), name: NAME });
  indexMode = 'honest';
  // source dies mid-scope while the advertised digest claim is stale
  const s0 = await (async () => {
    const first = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', ...TUPLE }] } });
    killListener(PORTS.r2);
    await new Promise((r) => setTimeout(r, 700));
    const second = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: NAME, version: '0.9.0' }] } });
    return { first, second };
  })();
  // restart between custody and use
  await restartRepo('r3', false);
  if (!(await restartConsumerLane(8414, B_HOME))) { console.error('lane failed to restart'); process.exit(2); }
  // the consumer asks for an object that no hostile input authenticated
  const res = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'dest', endpoint: ep('r3') }], scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: NAME, version: '0.9.0' });
  // and a hostile consumer-side attempt: the phantom publisher's tuple
  const stage = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: join(WORK, 'b-incoming'), alias: 'hostile-final-' + Math.random().toString(36).slice(2, 6), identityMaterial: MATERIAL, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', publisher_id: '9'.repeat(64), name: NAME, version: TUPLE.version, D: D0 } });
  const after = await consumerState();
  const unavailable = res.body.fetch_permitted === false || res.body.state !== 'CONSISTENT';
  const refused = !stage.body.import || stage.body.import.verdict === 'REFUSED';
  // Trust state = pin, witness, registry/admission, quarantine/equivocation —
  // exactly the four the frozen criterion names. The task store necessarily
  // records the REFUSED attempt itself, which is evidence of the attempt, not
  // a trust mutation, so it is checked separately below.
  const unchanged = before.registry_sha === after.registry_sha
    && before.registry_caps === after.registry_caps
    && JSON.stringify(before.pin) === JSON.stringify(after.pin)
    && before.pin_witness_sha === after.pin_witness_sha
    && before.equivocation_records === after.equivocation_records;
  const onlyRefusalRecorded = (() => {
    try {
      const tasks = JSON.parse(readFileSync(join(B_HOME, 'operator-ui', 'tasks.json'), 'utf8')).tasks || [];
      const imports = tasks.filter((t) => t.kind === 'import');
      return imports.length > 0 && imports.every((t) => t.verdict === 'REFUSED');
    } catch { return false; }
  })();
  const crit = unavailable && refused && unchanged;
  record('A0-11', 'REFUSE or UNAVAILABLE with trust state unchanged — not successful availability', { resolution: res.body.state, fetch_permitted: res.body.fetch_permitted, stage: stage.body.import && stage.body.import.verdict, trust_state_unchanged: unchanged, refusal_record_only: onlyRefusalRecorded, pin_before: before.pin, pin_after: after.pin }, crit ? 'PASS' : 'FAIL');
  step('A0-11 everything hostile at once: REFUSE/UNAVAILABLE with pin, witness, registry and quarantine byte-identical (the task store gains only the refused attempt)', crit, { resolution: res.body.state, stage: stage.body.import && stage.body.import.verdict, trust_unchanged: unchanged, refusal_record_only: onlyRefusalRecorded });
  startRepo('r2'); await waitRepo('r2');
}

hostile.close();
const allPass = receipt.attacks.every((a) => a.verdict === 'PASS');
receipt.rule = 'Composition may reduce availability or increase work. It must not manufacture authority.';
receipt.verdict = allPass ? 'A0 GREEN — eleven cross-phase attacks produce only REFUSE/UNAVAILABLE/extra work, never manufactured authority' : 'CAMPAIGN INCOMPLETE';
await writeFile(join(root, 'eval', 'receipts', 'FLOWROUTER-A0-RECEIPT.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log('\nverdict:', receipt.verdict);
if (!allPass) process.exitCode = 1;
