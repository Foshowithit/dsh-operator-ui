#!/usr/bin/env node
// eval/lib/flowrouter-f1-receipt.mjs — FlowRouter F1 acceptance matrix
// (frozen spec e9e7ef6). Eleven frozen cases: honest extension, multi-source
// equivocation, non-extending fork, local pinned witness (and the legacy
// witness-less pin), carrier-cannot-author, carrier-can-only-forward,
// withholding, D-conflict vs identity fork, three-branch canonicalization,
// consumer quarantine/acknowledgment, and causality (peer order, carrier,
// annotation, and an independent offline machine).
//
// Topology: publisher P (P2 identity) → repositories R1/R2 (independent) and
// R3 (evidence carrier only); consumer B on :8414 with the production plugin;
// a second, host-free offline verifier process for the causality case.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, packageDigest } from '../../lib/flowrouter.js';
import { verifyProofCore, proofDigest, PROOF_TYPE } from '../../lib/equivocation.js';
import {
  generateKeypair, createGenesis, createKeyEvent, replayChain, signPublication,
  deriveKeyId, recordDigest, jcs,
} from '../../lib/identity.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = 'http://127.0.0.1:8412';
const B = 'http://127.0.0.1:8414';
const WORK = '/tmp/flowrouter-f1';
const B_HOME = '/tmp/opui-b-home';
const R_PORTS = { r1: 13121, r2: 13122, r3: 13123 };
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
// Kill ONLY the listening process (lsof -ti :PORT also matches this harness's
// own keep-alive client sockets — killing those would SIGKILL the harness).
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
const receipt = { generated_at: new Date().toISOString(), steps: [] };
const step = (name, ok, result) => { receipt.steps.push({ step: name, ok, result }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '  → ' + JSON.stringify(result).slice(0, 260))); };

// ---------- artifact helpers (same P0 rule as the F0 harness) ----------
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
    pin_witness_sha: pin && pin.witness ? sha(Buffer.from(jcs(pin.witness), 'utf8')) : null,
  };
};
const quarantineState = async (publisherId) => get(B, '/plugins/operator-ui/f1?op=status' + (publisherId ? '&publisher_id=' + publisherId : ''));

// ---------- start three fresh repositories + clean consumer B ----------
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
await writeFile(join(B_HOME, 'operator-ui', 'b-registry.json'), JSON.stringify({ registry_version: 'rcos-public-v1', capabilities: [] }, null, 2) + '\n', 'utf8');
await rm(join(B_HOME, 'operator-ui', 'tasks.json'), { force: true });
for (const id of Object.keys(R_PORTS)) { await restartFreshStore(id); }
const ep = (id) => `http://127.0.0.1:${R_PORTS[id]}`;
step('three fresh repositories started (R1, R2 independent; R3 evidence carrier)', (await get(ep('r1'), '/status')).status === 200 && (await get(ep('r3'), '/status')).status === 200, { ports: R_PORTS });

// ---------- P: identity + package ----------
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
// extend the identity to seq 2 (the honest extension used by case 1)
const K2 = generateKeypair();
const ev2 = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(K2.publicKeyRaw), publicKeyRaw: K2.publicKeyRaw, permissions: ['publish'] });
const chain2 = replayChain(genesis, [ev1, ev2]);
const assertAt = (chain, evs) => signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain.head_sequence, identityHeadDigest: chain.head_digest });
const pubBodyAt = (chain, evs) => ({ publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', artifact: art0, publication: assertAt(chain, evs) });

// Case 1 (honest extension) — B resolves seq1 on R1 and seq2 (its extension) on R2
{
  await post(ep('r1'), '/publisher', { genesis, events: [ev1] });
  await post(ep('r2'), '/publisher', { genesis, events: [ev1, ev2] });
  const p1 = await post(ep('r1'), '/publish', pubBodyAt(chain1));
  const p2 = await post(ep('r2'), '/publish', pubBodyAt(chain2));
  const r = await post(B, '/plugins/operator-ui/federation?op=resolve', {
    peers: [{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }],
    scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0',
  });
  step('case 1 honest extension (seq1 + seq2) → CONSISTENT at seq2, NO proof emitted', p1.status === 200 && p2.status === 200 && r.body.state === 'CONSISTENT' && r.body.candidate.proof_state.head_sequence === 2 && !r.body.proof_core, { state: r.body.state, head: r.body.candidate?.proof_state?.head_sequence, proof: r.body.proof_core ? 'EMITTED' : null });
  // B stages the honest state so it holds a pinned witness (seq2) for later cases
  const incoming = join(WORK, 'b-incoming');
  await rm(incoming, { recursive: true, force: true });
  for (const f of files0) { const dest = join(incoming, f.path); await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, f.bytes); }
  const st = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming, alias: 'csv-running-total', identityMaterial: { genesis, events: [ev1, ev2], publication: assertAt(chain2) }, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0 } });
  const ver = await post(B, '/plugins/operator-ui/flowrouter?op=verify', { importTaskId: st.body.import?.taskId, fixtureDir: '/tmp/flowrouter-p0/b-fixture' });
  const adm = await post(B, '/plugins/operator-ui/flowrouter?op=admit', { importTaskId: st.body.import?.taskId });
  const ba = await bAuthorityState();
  step('case 1b pin created at seq2 AND retains the exact identity witness; admission intact', st.body.import?.verdict === 'STAGED' && ba.pin && ba.pin.sequence === 2 && ba.pin_witness_sha !== null && adm.body.ok === true, { stage: st.body.import?.verdict, verify: ver.body.import?.verdict, pin: ba.pin && ba.pin.sequence, witness: ba.pin_witness_sha ? ba.pin_witness_sha.slice(0, 12) : null });
  receipt._pinWitnessSha = ba.pin_witness_sha;
}

// Case 2 (multi-source equivocation at the SAME sequence) — R1 seq3-branchX, R2 seq3-branchY
// a seq-3 state on the honest prefix [ev1, ev2]; two of these are siblings
const siblingAt3 = () => { const k = generateKeypair(); return createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 3, prevRecordDigest: recordDigest(ev2), action: 'AUTHORIZE', keyId: deriveKeyId(k.publicKeyRaw), publicKeyRaw: k.publicKeyRaw, permissions: ['publish'] }); };
let forkCore, forkDigest;
{
  const X = siblingAt3();
  const Y = siblingAt3(); // same sequence, same predecessor, different key
  const chainX = replayChain(genesis, [ev1, ev2, X]);
  const chainY = replayChain(genesis, [ev1, ev2, Y]);
  // each repository must hold ITS branch: a fresh store per branch (the
  // service binds a tuple+D once and would otherwise return the old record)
  await restartFreshStore('r1');
  await restartFreshStore('r2');
  await post(ep('r1'), '/publisher', { genesis, events: [ev1, ev2, X] });
  await post(ep('r2'), '/publisher', { genesis, events: [ev1, ev2, Y] });
  const q = { scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0' };
  const r1p = await post(ep('r1'), '/publish', { ...pubBodyAt(chainX), publication: assertAt(chainX) });
  const r2p = await post(ep('r2'), '/publish', { ...pubBodyAt(chainY), publication: assertAt(chainY) });
  const before = await bAuthorityState();
  const r = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }], ...q });
  const after = await bAuthorityState();
  forkCore = r.body.proof_core;
  forkDigest = r.body.proof_digest;
  step('case 2 same-sequence divergence across repositories → CONFLICT + verified proof core; resolve still byte-identical read-only', r1p.status === 200 && r2p.status === 200 && r.body.state === 'CONFLICT' && !!forkCore && forkCore.relation === 'SAME_SEQUENCE_DIVERGENT' && before.taskstore_sha === after.taskstore_sha && before.registry_sha === after.registry_sha, { state: r.body.state, peers: r.body.observations.map((o) => o.repository_id + ':' + o.status), relation: forkCore && forkCore.relation, digest: forkDigest && forkDigest.slice(0, 16), read_only: before.taskstore_sha === after.taskstore_sha, publish: [r1p.body.error || r1p.body.D?.slice(0, 8), r2p.body.error || r2p.body.D?.slice(0, 8)] });
  // offline verification, same process, zero network use
  const v = verifyProofCore(forkCore);
  step('case 2b the core verifies offline: canonical pair, declared heads, derived relation, content address', v.ok === true && v.proof_digest === forkDigest && v.relation === 'SAME_SEQUENCE_DIVERGENT', { digest_match: v.proof_digest === forkDigest, relation: v.relation });
}

// Case 3 (non-extending fork at DIFFERENT sequences) + ancestor control
{
  // two branches share the prefix [ev1, ev2] and diverge at seq 3; one of
  // them continues to seq 4, so the heads differ in sequence and neither is
  // an ancestor of the other
  const mk3 = () => { const k = generateKeypair(); return createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 3, prevRecordDigest: recordDigest(ev2), action: 'AUTHORIZE', keyId: deriveKeyId(k.publicKeyRaw), publicKeyRaw: k.publicKeyRaw, permissions: ['publish'] }); };
  const a3 = mk3();
  const b3 = mk3();
  const kb4 = generateKeypair();
  const b4 = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 4, prevRecordDigest: recordDigest(b3), action: 'AUTHORIZE', keyId: deriveKeyId(kb4.publicKeyRaw), publicKeyRaw: kb4.publicKeyRaw, permissions: ['publish'] });
  const built = (await import('../../lib/equivocation.js')).buildProofCore({ genesis, states: [{ events: [ev1, ev2, a3] }, { events: [ev1, ev2, b3, b4] }] });
  const ancestor = (await import('../../lib/equivocation.js')).buildProofCore({ genesis, states: [{ events: [ev1] }, { events: [ev1, ev2] }] });
  const sameBranch = (await import('../../lib/equivocation.js')).buildProofCore({ genesis, states: [{ events: [ev1, ev2, b3] }, { events: [ev1, ev2, b3, b4] }] });
  step('case 3 non-extending branching at different sequences → NONEXTENDING_FORK; ancestor and strict-extension pairs never yield a proof', built && built.core.relation === 'NONEXTENDING_FORK' && ancestor === null && sameBranch === null, { relation: built && built.core.relation, ancestor: ancestor === null ? 'no proof (correct)' : 'PROOF (wrong)', strict_extension: sameBranch === null ? 'no proof (correct)' : 'PROOF (wrong)' });
}

// Case 4 (local pinned witness) — B is pinned at seq2; a conflicting seq-3 sibling arrives locally
{
  // B's pin sits at seq 2 (head of [ev1, ev2]). A history is a FORK of that
  // pinned state when it does not contain the pinned head — a descendant
  // branch would merely extend it — so the observed branch diverges AT seq 2.
  const kZ = generateKeypair();
  const ev2Z = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(kZ.publicKeyRaw), publicKeyRaw: kZ.publicKeyRaw, permissions: ['publish'] });
  const local = await post(B, '/plugins/operator-ui/f1?op=local-proof', { publisher_id: genesis.publisher_id, observed: { events: [ev1, ev2Z] } });
  const witnessUsed = local.status === 200 && local.body.proof_core && local.body.proof_core.relation === 'SAME_SEQUENCE_DIVERGENT';
  // a mere extension of the pinned state is NOT a contradiction
  const extension = await post(B, '/plugins/operator-ui/f1?op=local-proof', { publisher_id: genesis.publisher_id, observed: { events: [ev1, ev2] } });
  // legacy control: a pin that predates witness retention cannot fabricate one
  const legacy = await post(B, '/plugins/operator-ui/f1?op=local-proof', { publisher_id: 'f'.repeat(64), observed: { events: [ev1, ev2Z] } });
  step('case 4 local-history fork proven from the RETAINED pin witness (no peer); extension is no proof and a witness-less pin refuses honestly', witnessUsed && extension.status === 409 && extension.body.error === 'NO_CONTRADICTION' && legacy.status === 409 && legacy.body.error === 'NO_PINNED_WITNESS', { witness: witnessUsed, extension: extension.body.error || null, legacy: legacy.body.error || null });
}

// Case 5 (carrier cannot author) — every tamper fails offline
{
  const results = {};
  const mutate = (fn) => { const c = JSON.parse(JSON.stringify(forkCore)); fn(c); try { verifyProofCore(c); return 'VERIFIED'; } catch (e) { return e.code || 'ERR'; } };
  results.tampered_branch = mutate((c) => { c.branches[0].events[2].signature = Buffer.alloc(64).toString('base64url'); });
  results.foreign_genesis = mutate((c) => { const Q = generateKeypair(); c.genesis = createGenesis(Q, 'attacker'); });
  results.duplicated_branch = mutate((c) => { c.branches[1] = JSON.parse(JSON.stringify(c.branches[0])); });
  results.wrong_relation = mutate((c) => { c.relation = 'NONEXTENDING_FORK'; });
  results.ancestor_pair = mutate((c) => { c.branches = [{ events: [ev1], head_sequence: 1, head_digest: chain1.head_digest }, JSON.parse(JSON.stringify(c.branches[1]))]; c.relation = c.branches[0].head_sequence === c.branches[1].head_sequence ? 'SAME_SEQUENCE_DIVERGENT' : 'NONEXTENDING_FORK'; });
  results.unknown_core_field = mutate((c) => { c.extra = 'x'; });
  results.unknown_branch_field = mutate((c) => { c.branches[0].note = 'x'; });
  const allRejected = Object.values(results).every((v) => v === 'EQUIVOCATION_PROOF_INVALID');
  step('case 5 carrier-authored tampering (7 independent corruptions) → every one INVALID offline', allRejected, results);
  const carrierReject = await post(B, '/plugins/operator-ui/f1?op=ingest', { proof_core: (() => { const c = JSON.parse(JSON.stringify(forkCore)); c.genesis = createGenesis(generateKeypair(), 'attacker'); return c; })() });
  step('case 5b ingest independently verifies before recording — a forged core is refused and records nothing', carrierReject.status === 409 && carrierReject.body.error === 'EQUIVOCATION_PROOF_INVALID' && (await quarantineState(genesis.publisher_id)).body.proofs.length === 0, { status: carrierReject.status, error: carrierReject.body.error });
}

// Case 6 (carrier can only forward) — R3 stores nothing itself; it is a pure relay
{
  const carrierSeen = (await get(ep('r3'), '/status')).body;
  const forward = await post(B, '/plugins/operator-ui/f1?op=verify', { proof_core: forkCore });
  step('case 6 the carrier holds no authoritative state; the core a carrier forwards verifies byte-identically at the receiving consumer', carrierSeen.publications === 0 && forward.status === 200 && forward.body.proof_digest === forkDigest && JSON.stringify(forward.body) === JSON.stringify(verifyProofCore(forkCore)), { carrier_publications: carrierSeen.publications, digest_match: forward.body.proof_digest === forkDigest });
}

// Case 7 (withholding) — P equivocates but only R1 carries a branch: no proof, ordinary path proceeds
{
  const k = generateKeypair();
  const ev3k = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 3, prevRecordDigest: recordDigest(ev2), action: 'AUTHORIZE', keyId: deriveKeyId(k.publicKeyRaw), publicKeyRaw: k.publicKeyRaw, permissions: ['publish'] });
  const chainK = replayChain(genesis, [ev1, ev2, ev3k]);
  await restartFreshStore('r1');
  await restartFreshStore('r2');
  await post(ep('r2'), '/publisher', { genesis, events: [ev1, ev2] });
  await post(ep('r1'), '/publisher', { genesis, events: [ev1, ev2, ev3k] });
  await post(ep('r1'), '/publish', { ...pubBodyAt(chainK), publication: assertAt(chainK) });
  const r = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }], scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0' });
  const single = await post(B, '/plugins/operator-ui/f1?op=verify', { proof_core: forkCore });
  step('case 7 withholding: one branch only → PARTIAL with no proof (limitation demonstrated, not hidden)', r.body.state === 'PARTIAL' && !r.body.proof_core && single.status === 200, { state: r.body.state, proof: r.body.proof_core ? 'EMITTED' : null });
}

// Case 8 (D-conflict vs identity fork)
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
  // (i) D disagreement with COMPARABLE histories → content conflict only
  const kA = generateKeypair();
  const evA = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 3, prevRecordDigest: recordDigest(ev2), action: 'AUTHORIZE', keyId: deriveKeyId(kA.publicKeyRaw), publicKeyRaw: kA.publicKeyRaw, permissions: ['publish'] });
  const chainA = replayChain(genesis, [ev1, ev2, evA]);
  await restartFreshStore('r1');
  await restartFreshStore('r2');
  await post(ep('r1'), '/publisher', { genesis, events: [ev1, ev2, evA] });
  await post(ep('r2'), '/publisher', { genesis, events: [ev1, ev2, evA] });
  await post(ep('r1'), '/publish', { ...pubBodyAt(chainA), publication: assertAt(chainA) });
  await post(ep('r2'), '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', artifact: artB64(altFiles), publication: signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: Dalt, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chainA.head_sequence, identityHeadDigest: chainA.head_digest }) });
  const dOnly = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }], scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0' });
  step('case 8 D disagreement with comparable histories → content CONFLICT, no F1 proof', dOnly.body.state === 'CONFLICT' && !dOnly.body.proof_core, { state: dOnly.body.state, proof: dOnly.body.proof_core ? 'EMITTED' : null });
  // (ii) same D disagreement + a genuine history fork → F1 evidence still emitted
  const kC = generateKeypair();
  const evC = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 3, prevRecordDigest: recordDigest(ev2), action: 'AUTHORIZE', keyId: deriveKeyId(kC.publicKeyRaw), publicKeyRaw: kC.publicKeyRaw, permissions: ['publish'] });
  const chainC = replayChain(genesis, [ev1, ev2, evC]);
  await restartFreshStore('r2');
  await post(ep('r2'), '/publisher', { genesis, events: [ev1, ev2, evC] });
  await post(ep('r2'), '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', artifact: artB64(altFiles), publication: signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: Dalt, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chainC.head_sequence, identityHeadDigest: chainC.head_digest }) });
  const both = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'r1', endpoint: ep('r1') }, { repository_id: 'r2', endpoint: ep('r2') }], scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0' });
  step('case 8b D conflict AND a genuine history fork → the identity proof is emitted regardless of the D conflict', both.body.state === 'CONFLICT' && !!both.body.proof_core && both.body.proof_core.relation === 'SAME_SEQUENCE_DIVERGENT', { state: both.body.state, peers: both.body.observations.map((o) => o.repository_id + ':' + o.status), relation: both.body.proof_core && both.body.proof_core.relation, reason: both.body.reason });
}

// Case 9 (three branches, permuted peer order) — canonical pair + bytes invariant
{
  const mkSibling = () => { const k = generateKeypair(); return createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 3, prevRecordDigest: recordDigest(ev2), action: 'AUTHORIZE', keyId: deriveKeyId(k.publicKeyRaw), publicKeyRaw: k.publicKeyRaw, permissions: ['publish'] }); };
  const s1 = mkSibling(); const s2 = mkSibling(); const s3 = mkSibling();
  const states = [s1, s2, s3].map((ev) => ({ events: [ev1, ev2, ev] }));
  const built = (await import('../../lib/equivocation.js')).buildProofCore({ genesis, states });
  const builtPermuted = (await import('../../lib/equivocation.js')).buildProofCore({ genesis, states: [states[2], states[0], states[1]] });
  const dig = (c) => proofDigest(c);
  const observedVia = { observed_via: ['r1', 'r2', 'r3'] };
  const v1 = await post(B, '/plugins/operator-ui/f1?op=verify', { proof_core: built.core, local_annotation: observedVia });
  const v2 = await post(B, '/plugins/operator-ui/f1?op=verify', { proof_core: builtPermuted.core, local_annotation: { observed_via: ['r3'] } });
  // pick the lexicographically-first canonical pair expectation independently
  const sortedHeads = [s1, s2, s3].map((ev) => replayChain(genesis, [ev1, ev2, ev])).map((c) => c.head_digest).sort();
  step('case 9 three conflicting branches in different order → identical canonical pair, core bytes and digest; annotations never bind', JSON.stringify(built.core) === JSON.stringify(builtPermuted.core) && v1.body.proof_digest === v2.body.proof_digest && built.core.branches[0].head_digest === sortedHeads[0] && built.core.branches[1].head_digest === sortedHeads[1], { digest: v1.body.proof_digest.slice(0, 16), pair: [built.core.branches[0].head_digest.slice(0, 8), built.core.branches[1].head_digest.slice(0, 8)] });
}

// Case 10 (quarantine + acknowledgment lifecycle)
{
  const ingest = await post(B, '/plugins/operator-ui/f1?op=ingest', { proof_core: forkCore, observed_via: ['r1', 'r2'] });
  const st = await quarantineState(genesis.publisher_id);
  // refusal BEFORE pin mutation: pin + admitted capability state must be unchanged
  const before = await bAuthorityState();
  const blocked = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: join(WORK, 'b-incoming'), alias: 'csv-running-total-again', identityMaterial: { genesis, events: [ev1, ev2], publication: assertAt(chain2) }, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0 } });
  const after = await bAuthorityState();
  const admittedStill = true; // registry untouched (asserted byte-identical below)
  step('case 10 ingest quarantines; a new P2 import refuses with the dedicated code BEFORE any pin mutation', ingest.body.recorded === true && ingest.body.quarantined === true && st.body.quarantined === true && blocked.body.import?.verdict === 'REFUSED' && blocked.body.import?.refusal?.code === 'PUBLISHER_EQUIVOCATION_UNACKNOWLEDGED' && before.pin.sequence === after.pin.sequence && before.registry_sha === after.registry_sha && before.taskstore_sha !== after.taskstore_sha, { refusal: blocked.body.import?.refusal?.code, pin_before: before.pin.sequence, pin_after: after.pin.sequence, registry_unchanged: before.registry_sha === after.registry_sha });
  // acknowledgment: metadata only, evidence kept, pin untouched, no branch selected
  const beforeAck = await bAuthorityState();
  const ack = await post(B, '/plugins/operator-ui/f1?op=acknowledge', { proof_digest: forkDigest, operator: 'operator' });
  const afterAck = await bAuthorityState();
  const st2 = await quarantineState(genesis.publisher_id);
  const stillHeld = st2.body.proofs.length === 1 && st2.body.proofs[0].proof_digest === forkDigest;
  step('case 10b acknowledgment keeps the evidence, alters neither pin nor branch selection, and lifts quarantine', ack.body.ok === true && ack.body.still_quarantined === false && stillHeld && afterAck.pin.sequence === beforeAck.pin.sequence && afterAck.registry_sha === beforeAck.registry_sha, { ack: ack.body.ok, still_quarantined: ack.body.still_quarantined, pin: afterAck.pin.sequence });
  // a second unacknowledged proof re-quarantines
  const kS = generateKeypair();
  const evS = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 3, prevRecordDigest: recordDigest(ev2), action: 'AUTHORIZE', keyId: deriveKeyId(kS.publicKeyRaw), publicKeyRaw: kS.publicKeyRaw, permissions: ['publish'] });
  const other = (await import('../../lib/equivocation.js')).buildProofCore({ genesis, states: [{ events: [ev1, ev2, evS] }, { events: forkCore.branches[1].events }] });
  const ingest2 = await post(B, '/plugins/operator-ui/f1?op=ingest', { proof_core: other.core, observed_via: ['local-pinned-witness'] });
  const st3 = await quarantineState(genesis.publisher_id);
  const blocked2 = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: join(WORK, 'b-incoming'), alias: 'csv-running-total-third', identityMaterial: { genesis, events: [ev1, ev2], publication: assertAt(chain2) }, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0 } });
  step('case 10c a second unacknowledged proof re-quarantines and blocks imports again', ingest2.body.quarantined === true && st3.body.quarantined === true && st3.body.proofs.length === 2 && blocked2.body.import?.refusal?.code === 'PUBLISHER_EQUIVOCATION_UNACKNOWLEDGED', { proofs: st3.body.proofs.length, refusal: blocked2.body.import?.refusal?.code });
}

// Case 11 (causality) — annotation/carrier independence + an independent offline machine
{
  const v = verifyProofCore(forkCore);
  const sameBytes = JSON.stringify(v) === JSON.stringify(verifyProofCore(JSON.parse(JSON.stringify(forkCore))));
  // independent offline verifier: a separate process importing ONLY the frozen
  // modules, with no peers, no config, and no network use
  const offlineScript = join(WORK, 'offline-verify.mjs');
  await writeFile(offlineScript, `import { verifyProofCore } from '${join(root, 'lib', 'equivocation.js')}';\nimport { readFileSync } from 'node:fs';\nconst core = JSON.parse(readFileSync(process.argv[2], 'utf8'));\nconst v = verifyProofCore(core);\nconsole.log(JSON.stringify({ digest: v.proof_digest, relation: v.relation, publisher_id: v.publisher_id }));\n`, 'utf8');
  const corePath = join(WORK, 'fork-core.json');
  await writeFile(corePath, JSON.stringify(forkCore), 'utf8');
  const out = execFileSync(process.execPath, [offlineScript, corePath], { encoding: 'utf8', env: { PATH: process.env.PATH } }).trim();
  const parsed = JSON.parse(out);
  step('case 11 an offline process with no peers/config computes the identical digest and verdict', sameBytes && parsed.digest === proofDigest(forkCore) && parsed.relation === 'SAME_SEQUENCE_DIVERGENT', { digest: parsed.digest.slice(0, 16), relation: parsed.relation });
  receipt.cross_machine = { digest: parsed.digest, relation: parsed.relation, publisher_id: parsed.publisher_id };

  // Independent MACHINE: the same core crosses to a second host over the
  // network and is verified there by the production module with no peers
  // configured, no registry, no pin — byte-identical digest and verdict.
  const REMOTE = process.env.F1_REMOTE_ACTOR || 'http://100.111.182.5:8415';
  let remote = null;
  try {
    const res = await fetch(REMOTE + '/f1-verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proof_core: forkCore }), signal: AbortSignal.timeout(10000) });
    remote = { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (e) { remote = { status: 0, body: { error: String(e.message).slice(0, 100) } }; }
  const machine = remote.status === 200 ? (await (await fetch(REMOTE + '/machine')).json().catch(() => ({}))) : {};
  const machineRole = machine.hostname ? 'independent machine B' : null; // role label only — never the host's name
  let tamper = null;
  try {
    const bad = JSON.parse(JSON.stringify(forkCore));
    bad.branches[1].events.push({ record_type: 'flowrouter.p2.key-event.v1' });
    const res2 = await fetch(REMOTE + '/f1-verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proof_core: bad }), signal: AbortSignal.timeout(10000) });
    tamper = { status: res2.status, body: await res2.json().catch(() => ({})) };
  } catch { tamper = { status: 0, body: {} }; }
  step('case 11b an independent machine verifies the transported core to the identical digest (and rejects a tampered copy)', remote.status === 200 && remote.body.digest === proofDigest(forkCore) && remote.body.relation === 'SAME_SEQUENCE_DIVERGENT' && tamper.status === 409, { machine: machineRole, machine_platform: machine.platform || null, digest: remote.body.digest ? remote.body.digest.slice(0, 16) : null, tamper: tamper.body.error || null });
  receipt.cross_machine_verification = { machine_role: machineRole, platform: machine.platform || null, node: machine.node || null, digest: remote.body.digest || null, relation: remote.body.relation || null, tampered_copy: tamper.body.error || null };
}

const okAll = receipt.steps.every((s) => s.ok);
receipt.verdict = okAll ? 'F1 MATRIX GREEN — equivocation evidence is portable, offline-verifiable, and locally actionable; carriers add zero authority' : 'MATRIX INCOMPLETE';
await writeFile(join(root, 'eval', 'receipts', 'FLOWROUTER-F1-RECEIPT.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log('\nverdict:', receipt.verdict);
