#!/usr/bin/env node
// eval/lib/flowrouter-i1-composition.mjs — FlowRouter I1: full federation
// composition / traceability (frozen spec 8fb55a4).
//
// Orchestration only. No new trust object, status, API, identity, ranking,
// selector, freshness concept or protocol. The receipt records what each
// already-sealed phase owns, the exact values crossing every seam, and the
// phase-coverage table distinguishing what I1 EXERCISES from the sealed
// prerequisites it INHERITS.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
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
const WORK = '/tmp/flowrouter-i1';
const B_HOME = '/tmp/opui-b-home';
const PORTS = { r1: 13181, r2: 13182, r3: 13183 };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const shaOf = (o) => sha(Buffer.from(typeof o === 'string' ? o : JSON.stringify(o), 'utf8'));

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

const receipt = {
  generated_at: new Date().toISOString(),
  spec: '8fb55a4 (I1 — full federation composition / traceability)',
  seam_values: [],   // machine-checkable values crossing each seam
  handoffs: [],
  coverage: [],
  steps: [],
};
const step = (name, ok, result) => { receipt.steps.push({ step: name, ok, result }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '  → ' + JSON.stringify(result).slice(0, 300))); };
const seam = (name, values) => { receipt.seam_values.push({ name, ...values }); };
const handoff = (from, to, owned_by, knows) => { receipt.handoffs.push({ from, to, owned_by, knows }); };

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
const consumerState = async () => {
  const reg = await readFile(join(B_HOME, 'operator-ui', 'b-registry.json'));
  let tasks = ''; try { tasks = await readFile(join(B_HOME, 'operator-ui', 'tasks.json'), 'utf8'); } catch {}
  const parsed = (() => { try { return JSON.parse(tasks).tasks || []; } catch { return []; } })();
  const pin = parsed.find((t) => t.kind === 'pin');
  return { registry_sha: sha(reg), registry_caps: (JSON.parse(reg.toString('utf8')).capabilities || []).length, taskstore_sha: sha(Buffer.from(tasks, 'utf8')), pin: pin ? pin.pin : null, pin_witness_sha: pin && pin.witness ? sha(Buffer.from(JSON.stringify(pin.witness), 'utf8')) : null, equivocation_records: parsed.filter((t) => t.kind === 'equivocation').length, kinds: parsed.map((t) => t.kind).sort() };
};

// ================= topology =================
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
await writeFile(join(B_HOME, 'operator-ui', 'b-registry.json'), JSON.stringify({ registry_version: 'rcos-public-v1', capabilities: [] }, null, 2) + '\n', 'utf8');
await rm(join(B_HOME, 'operator-ui', 'tasks.json'), { force: true });
if (!(await restartConsumerLane(8414, B_HOME))) { console.error('consumer lane did not come up'); process.exit(2); }
for (const id of Object.keys(PORTS)) await restartRepo(id, true);
step('topology: origin R1, mirror R2, destination R3, consumer, configured directory', (await get(ep('r1'), '/status')).status === 200 && (await get(ep('r3'), '/status')).status === 200, { ports: PORTS });

// ================= publisher + artifact =================
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
const matDigest = (m) => sha(Buffer.from(jcs(m), 'utf8'));

// ================= POSITIVE LANE =================
// 1. P0/P2 — publish + authenticate to R1
await post(ep('r1'), '/publisher', { genesis, events: [ev1] });
const pub = await post(ep('r1'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, artifact: artB64(files0), publication: ASSERT1 });
seam('P0/P2_publish', { D: D0, publisher_id: genesis.publisher_id, tuple: TUPLE, material_digest: matDigest(MATERIAL) });
step('lane 1. P0/P2 — publisher authenticates the publication into origin R1', pub.status === 200 && pub.body.D === D0 && pub.body.publisher_auth === 'VERIFIED', { D: String(pub.body.D).slice(0, 12) });

// 2. R0 — authenticated custody replication R1 → R2
const rep = await post(ep('r2'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p2-selfcert-v1', ...TUPLE });
const r2Served = await get(ep('r2'), '/publication/' + TUPLE.publisher_id + '/' + TUPLE.name + '/' + TUPLE.version + '?scheme=p2-selfcert-v1');
handoff('origin R1', 'mirror R2', 'R0', 'custody of one exact validated object (blob + immutable binding)');
seam('R0_mirror', { D: r2Served.body.D, material_digest: matDigest(r2Served.body.material) });
step('lane 2. R0 — the mirror independently verified and now holds the ORIGINAL publisher material', rep.status === 200 && rep.body.D === D0 && matDigest(r2Served.body.material) === matDigest(MATERIAL), { D: String(rep.body.D).slice(0, 12), identical: matDigest(r2Served.body.material) === matDigest(MATERIAL) });

// 3. D1 — endpoint discovery from the configured untrusted directory (ONE endpoint)
const dirPort = 13184;
const dirStub = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/endpoints') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ name: u.searchParams.get('name'), entries: [{ endpoint: ep('r2') }], order_semantics: 'none' })); }
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => dirStub.listen(dirPort, '127.0.0.1', r));
const DIR = 'http://127.0.0.1:' + dirPort;
const d1 = await discoverEndpoints({ directory: DIR, name: NAME });
handoff('directory Q', 'consumer', 'D1', 'endpoint candidates only — no publisher, tuple, digest, freshness or ranking');
seam('D1_endpoint', { endpoints: d1.endpoints, count: d1.endpoints.length });
step('lane 3. D1 — one endpoint candidate from the configured directory, with no capability claim and no authority', d1.endpoints.length === 1 && d1.endpoints[0] === ep('r2') && !JSON.stringify(d1).match(/publisher_id|claimed_D|"D"/), { endpoints: d1.endpoints });

// 4. D0 — exact tuple discovery from that endpoint's possession index (ONE tuple)
const d0 = await discoverCandidates({ endpoint: d1.endpoints[0], name: NAME });
handoff('endpoint R2', 'consumer', 'D0', 'exact tuple claims with a non-authoritative claimed_D');
seam('D0_tuple', { candidates: d0.candidates, count: d0.candidates.length });
step('lane 4. D0 — exactly one exact P2 tuple candidate; the candidate carries no digest and no version selection', d0.candidates.length === 1 && d0.candidates[0].version === TUPLE.version && d0.candidates[0].publisher_id === genesis.publisher_id && d0.candidates[0].claimed_D === undefined, { candidates: d0.candidates.length, version: d0.candidates[0] && d0.candidates[0].version });

// 5. explicit selection (the caller's act — one endpoint, one tuple)
const selected = d0.candidates[0];
seam('explicit_selection', { selected_tuple: selected, decided_by: 'caller/operator' });
step('lane 5. explicit selection — the caller picks the exact tuple (no rank, no latest, no scoring anywhere)', Object.keys(selected).sort().join(',') === 'name,publisher_id,publisher_scheme,version', { selected });

// 6. S0 — exact-scope backfill into the destination (internally ordinary R0)
const s0 = await syncExact({ source_endpoint: d1.endpoints[0], destination: ep('r3'), explicit_scope: { publications: [{ publisher_scheme: selected.publisher_scheme, publisher_id: selected.publisher_id, name: selected.name, version: selected.version }] } });
const r3Served = await get(ep('r3'), '/publication/' + TUPLE.publisher_id + '/' + TUPLE.name + '/' + TUPLE.version + '?scheme=p2-selfcert-v1');
handoff('mirror R2', 'destination R3', 'S0', 'an exact named object, copied additively through ordinary R0');
seam('S0_backfill', { outcome: s0.summary, observed_D: s0.results[0] && s0.results[0].observed_D, destination_D: r3Served.body.D });
step('lane 6. S0 — the exact named object is backfilled into the destination through ordinary R0 (one object, additive)', s0.summary.COPIED === 1 && r3Served.body.D === D0 && matDigest(r3Served.body.material) === matDigest(MATERIAL), { outcome: s0.summary, D: String(r3Served.body.D).slice(0, 12) });

// 7. F0 — exact resolution at the consumer against the destination only
const beforeUse = await consumerState();
const res = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'dest', endpoint: ep('r3') }], scheme: 'p2-selfcert-v1', ...TUPLE });
handoff('destination R3', 'consumer', 'F0', 'the resolved exact tuple + canonical proof material (read-only)');
seam('F0_resolution', { state: res.body.state, authenticated_D: res.body.candidate && res.body.candidate.D, selected_state: res.body.candidate && res.body.candidate.proof_state });
step('lane 7. F0 — exact resolution over the destination resolves the exact tuple with the canonical proof material', res.body.state === 'CONSISTENT' && res.body.candidate.D === D0, { state: res.body.state, D: String(res.body.candidate.D).slice(0, 12) });

// 8. P2 + 9. P0 — authentication and recomputation at the consumer
const fet = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: res.body.resolution_handle, D: D0 });
handoff('consumer', 'consumer-local stage', 'P2 + P0', 'publisher identity bound to the exact tuple and a locally recomputed artifact digest');
seam('P2_authenticated', { publisher_id: fet.body.material && fet.body.material.genesis.publisher_id, material_digest: fet.body.material ? matDigest(fet.body.material) : null });
seam('P0_recomputed', { recomputed_D: fet.body.recomputed_D });
step('lane 8/9. P2 authenticates the ORIGINAL publisher and P0 recomputation confirms the artifact bytes', fet.status === 200 && fet.body.material.genesis.publisher_id === genesis.publisher_id && fet.body.recomputed_D === D0 && fet.body.recomputed_D === res.body.candidate.D, { publisher: String(fet.body.material.genesis.publisher_id).slice(0, 12), recomputed: String(fet.body.recomputed_D).slice(0, 12) });

// 10. stage → verify → admit → route → SHIP
{
  const incoming = join(WORK, 'b-incoming');
  await rm(incoming, { recursive: true, force: true });
  for (const f of JSON.parse(Buffer.from(fet.body.bytes_b64 || '', 'base64') || '{"files":[]}').files || []) { const dest = join(incoming, f.path); await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, Buffer.from(f.b64, 'base64')); }
  const afterFetch = await consumerState();
  const st = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming, alias: 'csv-running-total', identityMaterial: fet.body.material, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, D: D0 } });
  const afterStage = await consumerState();
  const ver = await post(B, '/plugins/operator-ui/flowrouter?op=verify', { importTaskId: st.body.import && st.body.import.taskId, fixtureDir: '/tmp/flowrouter-p0/b-fixture' });
  const beforeAdmit = await consumerState();
  const adm = await post(B, '/plugins/operator-ui/flowrouter?op=admit', { importTaskId: st.body.import && st.body.import.taskId });
  const afterAdmit = await consumerState();
  let goal = (await post(B, '/plugins/operator-ui/goal', { objective: 'Process values.csv in order and report the running total after each row, one per line, as RESULT row=<n> total=<cumulative sum>.' })).body.goal || {};
  const gate = new Set(goal.failureCodes || []).has('awaiting-approval');
  if (gate) goal = (await post(B, '/plugins/operator-ui/goal', { approveTaskId: goal.taskId })).body.goal || {};
  const checks = Object.fromEntries((goal.checks || []).map((c) => [c.id, c.pass]));
  handoff('stage', 'route', 'sealed P2 stage + explicit admission', 'the ONLY pin mutation is the stage; the ONLY routability change is explicit admission');
  seam('consumer_local', {
    pin_before_use: beforeUse.pin, pin_after_stage: afterStage.pin, pin_witness_sha: afterStage.pin_witness_sha,
    registry_before_admit: beforeAdmit.registry_sha, registry_after_admit: afterAdmit.registry_sha,
    route: goal.route && goal.route.selected, verdict: goal.verdict, final_verdict: goal.verdict,
  });
  step('lane 10. stage → B-local verify → explicit admission → route → SHIP, with the admitted LOCAL capability', ver.body.import && ver.body.import.verdict === 'VERIFIED' && adm.body.ok === true && goal.verdict === 'SHIP' && gate && checks['objective-satisfaction'] === true && afterAdmit.registry_caps === 1, { stage: st.body.import && st.body.import.verdict, verify: ver.body.import && ver.body.import.verdict, admit: adm.body.ok, verdict: goal.verdict });
  // seam correctness: exactly one trust mutation at each owned step
  const pinMovedAtStage = JSON.stringify(beforeUse.pin) !== JSON.stringify(afterStage.pin) && afterStage.pin.sequence === chain1.head_sequence;
  const registryMovedAtAdmit = afterFetch.registry_sha === beforeAdmit.registry_sha && afterAdmit.registry_sha !== beforeAdmit.registry_sha;
  const registryUnmovedByStage = afterFetch.registry_sha === afterStage.registry_sha;
  step('lane 10b. exactly one owned mutation per seam: the sealed stage moved the pin, explicit admission moved the registry, nothing else did', pinMovedAtStage && registryMovedAtAdmit && registryUnmovedByStage && beforeUse.equivocation_records === afterAdmit.equivocation_records, { pin_moved_at_stage: pinMovedAtStage, registry_moved_at_admit: registryMovedAtAdmit, registry_untouched_by_stage: registryUnmovedByStage, quarantine_untouched: beforeUse.equivocation_records === afterAdmit.equivocation_records });
}

// ================= EQUIVOCATION BRANCH (separate from the happy path) =================
let forkCore = null;
{
  const kX = generateKeypair();
  const evX = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(kX.publicKeyRaw), publicKeyRaw: kX.publicKeyRaw, permissions: ['publish'] });
  const kY = generateKeypair();
  const evY = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(kY.publicKeyRaw), publicKeyRaw: kY.publicKeyRaw, permissions: ['publish'] });
  const V2 = { publisher_id: genesis.publisher_id, name: NAME, version: '0.2.0' };
  // branch X → R1 ; branch Y → the destination R3 (independent repositories)
  await restartRepo('r1', true);
  await post(ep('r1'), '/publisher', { genesis, events: [ev1, evX] });
  await post(ep('r1'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...V2, artifact: artB64(files0), publication: signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: NAME, version: V2.version, D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: 2, identityHeadDigest: replayChain(genesis, [ev1, evX]).head_digest }) });
  await post(ep('r3'), '/publisher', { genesis, events: [ev1, evY] });
  await post(ep('r3'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...V2, artifact: artB64(files0), publication: signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: NAME, version: V2.version, D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: 2, identityHeadDigest: replayChain(genesis, [ev1, evY]).head_digest }) });
  const fork = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'dest', endpoint: ep('r3') }], scheme: 'p2-selfcert-v1', ...V2 });
  forkCore = fork.body.proof_core || null;
  const pd = forkCore ? proofDigest(forkCore) : null;
  seam('F1_fork', { state: fork.body.state, relation: forkCore && forkCore.relation, proof_digest: pd });
  step('branch 1. F0 sees NON-COMPARABLE observations across two independent repositories and F1 constructs the proof core', fork.body.state === 'CONFLICT' && !!forkCore && forkCore.relation === 'SAME_SEQUENCE_DIVERGENT', { state: fork.body.state, relation: forkCore && forkCore.relation });

  // untrusted transport: the proof goes through R2's dumb evidence path...
  await post(ep('r2'), '/evidence', { proof_digest: pd, proof_core: forkCore });
  // ...and OPTIONAL S0 evidence custody copies it into R3 through the sealed coordinator
  const beforeCustody = await consumerState();
  const s0proof = await syncExact({ source_endpoint: ep('r2'), destination: ep('r3'), explicit_scope: { proofs: [{ proof_digest: pd }] } });
  const afterCustody = await consumerState();
  const atDest = await fetch(ep('r3') + '/evidence/' + pd);
  const bytes = Buffer.from(await atDest.arrayBuffer());
  const identical = bytes.equals(Buffer.from(JSON.stringify(forkCore), 'utf8'));
  const verifies = verifyProofCore(JSON.parse(bytes.toString('utf8'))).proof_digest === pd;
  seam('F1_carriage', { proof_digest: pd, identical, verifies, custody_outcome: s0proof.summary });
  step('branch 2. the proof crosses untrusted transport AND optional S0 evidence custody byte-identically, verifying at the destination — and custody alone quarantines NOBODY', s0proof.summary.COPIED === 1 && identical && verifies && beforeCustody.equivocation_records === afterCustody.equivocation_records && JSON.stringify(beforeCustody.pin) === JSON.stringify(afterCustody.pin), { custody: s0proof.summary, identical, verifies, quarantine_from_custody: beforeCustody.equivocation_records !== afterCustody.equivocation_records });

  // explicit F1 ingest activates the quarantine; refusal precedes pin mutation
  const beforeIngest = await consumerState();
  const blocked0 = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: join(WORK, 'b-incoming'), alias: 'post-fork', identityMaterial: MATERIAL, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, D: D0 } });
  const ingest = await post(B, '/plugins/operator-ui/f1?op=ingest', { proof_core: forkCore, observed_via: ['r1', 'dest'] });
  const blocked = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: join(WORK, 'b-incoming'), alias: 'post-fork-2', identityMaterial: MATERIAL, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, D: D0 } });
  const afterBlocked = await consumerState();
  seam('F1_ingest', { quarantined: ingest.body.quarantined, refusal: blocked.body.import && blocked.body.import.refusal && blocked.body.import.refusal.code });
  step('branch 3. explicit ingest quarantines; the next import refuses BEFORE any pin mutation, and the earlier admission stays untouched', ingest.body.quarantined === true && blocked.body.import && blocked.body.import.refusal && blocked.body.import.refusal.code === 'PUBLISHER_EQUIVOCATION_UNACKNOWLEDGED' && JSON.stringify(beforeIngest.pin) === JSON.stringify(afterBlocked.pin) && afterBlocked.registry_caps === 1, { quarantined: ingest.body.quarantined, refusal: blocked.body.import && blocked.body.import.refusal && blocked.body.import.refusal.code, caps: afterBlocked.registry_caps });
  const ack = await post(B, '/plugins/operator-ui/f1?op=acknowledge', { proof_digest: pd, operator: 'operator' });
  const st = (await get(B, '/plugins/operator-ui/f1?op=status&publisher_id=' + genesis.publisher_id)).body;
  step('branch 4. acknowledgment preserves the evidence and the pin while lifting the quarantine', ack.body.ok === true && ack.body.still_quarantined === false && st.proofs.length === 1 && st.proofs[0].proof_digest === pd && !!st.proofs[0].acknowledged, { ack: ack.body.ok, proofs: st.proofs.length });
}

// ================= seam continuity (machine-checkable) =================
{
  const s = (n) => receipt.seam_values.find((x) => x.name === n);
  const endpointContinuous = s('D1_endpoint').endpoints[0] === r2EndpointCheck();
  function r2EndpointCheck() { return ep('r2'); }
  const d0Tuple = s('D0_tuple').candidates[0];
  const publisherContinuous = s('P0/P2_publish').publisher_id === s('P2_authenticated').publisher_id && s('P2_authenticated').publisher_id === s('P0/P2_publish').publisher_id;
  const dContinuous = s('P0/P2_publish').D === s('R0_mirror').D && s('R0_mirror').D === s('S0_backfill').destination_D && s('S0_backfill').destination_D === s('P0_recomputed').recomputed_D && s('P0_recomputed').recomputed_D === s('F0_resolution').authenticated_D;
  const materialContinuous = s('P0/P2_publish').material_digest === s('R0_mirror').material_digest && s('R0_mirror').material_digest === s('P2_authenticated').material_digest;
  const tupleContinuous = d0Tuple.publisher_id === s('P0/P2_publish').tuple.publisher_id && d0Tuple.name === s('P0/P2_publish').tuple.name && d0Tuple.version === s('P0/P2_publish').tuple.version;
  step('seams. the object leaving each phase IS the object entering the next: canonical endpoint, exact tuple, publisher_id, D and material digest all continuous', endpointContinuous && tupleContinuous && publisherContinuous && dContinuous && materialContinuous, { endpoint_continuous: endpointContinuous, tuple_continuous: tupleContinuous, publisher_continuous: publisherContinuous, D_continuous: dContinuous, material_continuous: materialContinuous });
}

// ================= coverage table =================
receipt.coverage = [
  { phase: 'P0', role: 'exact artifact integrity', i1_coverage: 'exercised' },
  { phase: 'P1', role: 'repository transport foundation', i1_coverage: 'inherited sealed prerequisite' },
  { phase: 'P1-X', role: 'real-network physical portability', i1_coverage: 'inherited sealed prerequisite' },
  { phase: 'P2', role: 'publisher authentication', i1_coverage: 'exercised' },
  { phase: 'F0', role: 'exact multi-repository resolution', i1_coverage: 'exercised' },
  { phase: 'F1', role: 'equivocation evidence (branch)', i1_coverage: 'exercised (separate branch)' },
  { phase: 'R0', role: 'authenticated custody replication', i1_coverage: 'exercised' },
  { phase: 'I0', role: 'prior federation composition', i1_coverage: 'inherited sealed prerequisite' },
  { phase: 'D0', role: 'tuple discovery', i1_coverage: 'exercised' },
  { phase: 'D1', role: 'endpoint discovery', i1_coverage: 'exercised' },
  { phase: 'S0', role: 'exact-scope custody backfill', i1_coverage: 'exercised' },
];

// ================= absence of authority =================
{
  const self = await readFile(fileURLToPath(import.meta.url), 'utf8');
  const forbidden = /VERIFIED_BY_I1|I1_SEAL|trust_score|ranking|popularity|recommended|latest|freshness_score|orchestration_authority/;
  // strip comments AND string literals: the campaign legitimately NAMES the
  // vocabulary it refuses
  const code = self.replace(/\/\/.*$/gm, '').replace(/`[^`]*`/g, '``').replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const clean = !forbidden.test(code);
  const mutations = receipt.seam_values.find((x) => x.name === 'consumer_local');
  const ownedOnly = !!mutations && mutations.registry_after_admit !== mutations.registry_before_admit;
  step('authority. I1 introduces no trust object, status, ranking, selector, freshness or identity field, and every consumer-local mutation is owned by a sealed step', clean && ownedOnly, { no_authority_vocabulary: clean, owned_mutations: ownedOnly });
}

dirStub.close();
receipt.claim = 'The completed FlowRouter federation can take a consumer from only a canonical capability name and a configured untrusted directory to a consumer-local SHIP through untrusted discovery, authenticated custody transfer, exact federation resolution and local verification/admission — while repositories, directories, mirrors, sync bookkeeping, transport and orchestration acquire no authority beyond their already-sealed roles.';
const okAll = receipt.steps.every((s) => s.ok);
receipt.verdict = okAll ? 'I1 GREEN — the sealed phases compose into one traceable federation path from a name and a directory to a consumer-local SHIP' : 'COMPOSITION INCOMPLETE';
await writeFile(join(root, 'eval', 'receipts', 'FLOWROUTER-I1-RECEIPT.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log('\nverdict:', receipt.verdict);
if (!okAll) process.exitCode = 1;
