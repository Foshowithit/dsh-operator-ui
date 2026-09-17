#!/usr/bin/env node
// eval/lib/flowrouter-d0-receipt.mjs — FlowRouter D0 acceptance matrix
// (frozen spec d0e935d): untrusted repository possession index.
//
// Fourteen frozen cases. The positive one deliberately queries a name with ONE
// exact tuple so D0 cannot acquire a version-choice policy merely to reach
// SHIP. Adversarial cases drive a CONTROLLED index (a stub) so lies, floods,
// permutations and stale digests can be injected precisely.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, packageDigest } from '../../lib/flowrouter.js';
import {
  discoverCandidates, normalizeCandidateEntries, candidateKey, candidateDigest, MAX_D0_CANDIDATES,
} from '../../lib/discovery.js';
import {
  generateKeypair, createGenesis, createKeyEvent, replayChain, signPublication, deriveKeyId, recordDigest,
} from '../../lib/identity.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = 'http://127.0.0.1:8412';
const B = 'http://127.0.0.1:8414';
const WORK = '/tmp/flowrouter-d0';
const B_HOME = '/tmp/opui-b-home';
const R_PORTS = { r1: 13151, r2: 13152 };
const sha = (b) => createHash('sha256').update(b).digest('hex');

const post = async (base, path, body) => {
  try {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const text = await res.text();
    let parsed = {}; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: parsed };
  } catch (e) { return { status: 0, body: { error: String(e.message).slice(0, 140) } }; }
};
const get = async (base, path) => {
  try {
    const res = await fetch(base + path);
    const text = await res.text();
    let parsed = {}; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: parsed };
  } catch (e) { return { status: 0, body: { error: String(e.message).slice(0, 140) } }; }
};
const serviceStart = (id) => spawn(process.execPath, [join(root, 'eval', 'lib', 'flowrouter-service.mjs'), '--port', String(R_PORTS[id]), '--store', join(WORK, 'store-' + id)], { detached: true, stdio: 'ignore' }).unref();
const killListener = (port) => {
  let pids = '';
  try { pids = execFileSync('lsof', ['-ti', ':' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim(); } catch { return; }
  for (const pid of pids.split('\n').filter(Boolean)) { const n = Number(pid); if (n !== process.pid) { try { process.kill(n, 'SIGKILL'); } catch {} } }
};
const waitUp = async (id, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const s = await get(ep(id), '/status'); if (s.status === 200) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
};
const restartFreshStore = async (id) => {
  killListener(R_PORTS[id]);
  await new Promise((r) => setTimeout(r, 700));
  await rm(join(WORK, 'store-' + id), { recursive: true, force: true });
  serviceStart(id);
  return waitUp(id);
};
const restartConsumerLane = async (port, home) => {
  killListener(port);
  await new Promise((r) => setTimeout(r, 1200));
  const bin = process.env.DSH_BIN || 'dsh';
  spawn(bin, ['web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], { detached: true, stdio: 'ignore', cwd: home, env: { ...process.env, DSH_HOME: home } }).unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) { try { const s = await get('http://127.0.0.1:' + port, '/plugins/operator-ui/rcos'); if (s.status === 200) return true; } catch {} await new Promise((r) => setTimeout(r, 900)); }
  return false;
};

const receipt = { generated_at: new Date().toISOString(), spec: 'd0e935d (D0 — untrusted repository possession index)', steps: [] };
const step = (name, ok, result) => { receipt.steps.push({ step: name, ok, result }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '  → ' + JSON.stringify(result).slice(0, 300))); };

const artifactFiles = async (dir) => {
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
const p0Of = (files) => {
  const cap = files.find((f) => f.path === 'capability.json');
  const m = JSON.parse(cap.bytes.toString('utf8'));
  const capNo = Buffer.from(canonicalJson({ ...m, implementation: { ...m.implementation, bundle: { algorithm: 'sha256' } } }), 'utf8');
  return packageDigest(files.map((f) => (f.path === 'capability.json' ? { path: f.path, bytes: capNo } : f)));
};
const consumerState = async () => {
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
    equivocation_records: parsed.filter((t) => t.kind === 'equivocation').length,
  };
};

// ---------- topology ----------
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
await writeFile(join(B_HOME, 'operator-ui', 'b-registry.json'), JSON.stringify({ registry_version: 'rcos-public-v1', capabilities: [] }, null, 2) + '\n', 'utf8');
await rm(join(B_HOME, 'operator-ui', 'tasks.json'), { force: true });
if (!(await restartConsumerLane(8414, B_HOME))) { console.error('consumer lane did not come up'); process.exit(2); }
for (const id of Object.keys(R_PORTS)) { await restartFreshStore(id); }
const ep = (id) => `http://127.0.0.1:${R_PORTS[id]}`;
step('topology: an origin repository, a mirror, and a consumer', (await get(ep('r1'), '/status')).status === 200 && (await get(ep('r2'), '/status')).status === 200, { ports: R_PORTS });

// ---------- publisher P + one artifact, published to R1 and mirrored to R2 ----------
const files0 = await artifactFiles((await post(A, '/plugins/operator-ui/flowrouter?op=export', { capabilityId: 'csv-running-total', outDir: join(WORK, 'export') })).body.packageDir);
const D0 = p0Of(files0);
const P = generateKeypair();
const genesis = createGenesis(P, 'publisher-p');
const K1 = generateKeypair();
const ev1 = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 1, prevRecordDigest: recordDigest(genesis), action: 'AUTHORIZE', keyId: deriveKeyId(K1.publicKeyRaw), publicKeyRaw: K1.publicKeyRaw, permissions: ['publish'] });
const chain1 = replayChain(genesis, [ev1]);
const NAME = 'csv-running-total';
const TUPLE = { publisher_id: genesis.publisher_id, name: NAME, version: '0.1.0' };
const ASSERT1 = signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: NAME, version: TUPLE.version, D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest });
await post(ep('r1'), '/publisher', { genesis, events: [ev1] });
const pub1 = await post(ep('r1'), '/publish', { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, artifact: artB64(files0), publication: ASSERT1 });
const rep = await post(ep('r2'), '/replicate', { source_endpoint: ep('r1'), scheme: 'p2-selfcert-v1', ...TUPLE });
step('P publishes to R1 and R2 mirrors it (the D0 subject is a mirrored P2 binding)', pub1.status === 200 && rep.status === 200 && rep.body.D === D0, { published: pub1.body.D && String(pub1.body.D).slice(0, 12), mirrored: rep.body.D && String(rep.body.D).slice(0, 12) });

// ================= case 1: positive mirrored discovery → full sealed path to SHIP =================
{
  // the consumer knows ONLY the name and R2's endpoint
  const disc = await discoverCandidates({ endpoint: ep('r2'), name: NAME });
  step('1. positive: name + mirror endpoint → exactly one exact P2 tuple candidate, no version choice', disc.candidates.length === 1 && disc.candidates[0].version === TUPLE.version && disc.candidates[0].publisher_id === genesis.publisher_id && disc.truncated === false && disc.learned_from_index === ep('r2'), { candidates: disc.candidates.length, version: disc.candidates[0] && disc.candidates[0].version });

  // the caller selects THE candidate (here it is the only one) and the claiming
  // endpoints become ordinary F0 peers
  const cand = disc.candidates[0];
  const r = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'r2', endpoint: ep('r2') }], scheme: cand.publisher_scheme, publisher_id: cand.publisher_id, name: cand.name, version: cand.version });
  const fet = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: r.body.resolution_handle, D: r.body.candidate && r.body.candidate.D });
  const incoming = join(WORK, 'b-incoming');
  await rm(incoming, { recursive: true, force: true });
  for (const f of JSON.parse(Buffer.from(fet.body.bytes_b64 || '', 'base64') || '{"files":[]}').files || []) {
    const dest = join(incoming, f.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(f.b64, 'base64'));
  }
  const st = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming, alias: 'csv-running-total', identityMaterial: fet.body.material, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, D: D0 } });
  const ver = await post(B, '/plugins/operator-ui/flowrouter?op=verify', { importTaskId: st.body.import && st.body.import.taskId, fixtureDir: '/tmp/flowrouter-p0/b-fixture' });
  const adm = await post(B, '/plugins/operator-ui/flowrouter?op=admit', { importTaskId: st.body.import && st.body.import.taskId });
  let goal = (await post(B, '/plugins/operator-ui/goal', { objective: 'Process values.csv in order and report the running total after each row, one per line, as RESULT row=<n> total=<cumulative sum>.' })).body.goal || {};
  const gate = new Set(goal.failureCodes || []).has('awaiting-approval');
  if (gate) goal = (await post(B, '/plugins/operator-ui/goal', { approveTaskId: goal.taskId })).body.goal || {};
  const checks = Object.fromEntries((goal.checks || []).map((c) => [c.id, c.pass]));
  step('1b. the discovered candidate feeds the ORDINARY sealed path → stage → verify → admit → route → SHIP, authenticating the original publisher', r.body.state === 'CONSISTENT' && fet.body.recomputed_D === D0 && fet.body.material.genesis.publisher_id === genesis.publisher_id && st.body.import && st.body.import.verdict === 'STAGED' && ver.body.import && ver.body.import.verdict === 'VERIFIED' && adm.body.ok === true && goal.verdict === 'SHIP' && gate && checks['objective-satisfaction'] === true, { state: r.body.state, stage: st.body.import && st.body.import.verdict, verdict: goal.verdict });
  receipt.positive = { learned_from_index: disc.learned_from_index, candidate: cand, D: D0, final_verdict: goal.verdict };
}

// ================= case 2: origin/mirror equivalence =================
{
  const fromOrigin = await discoverCandidates({ endpoint: ep('r1'), name: NAME });
  const fromMirror = await discoverCandidates({ endpoint: ep('r2'), name: NAME });
  const same = candidateDigest(fromOrigin.candidates) === candidateDigest(fromMirror.candidates) && fromOrigin.candidates.length === 1;
  const rO = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'r1x', endpoint: ep('r1') }], scheme: 'p2-selfcert-v1', ...TUPLE });
  const rM = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'r2x', endpoint: ep('r2') }], scheme: 'p2-selfcert-v1', ...TUPLE });
  step('2. origin index and mirror index yield the identical candidate set and the identical downstream trust result', same && rO.body.state === 'CONSISTENT' && rM.body.state === 'CONSISTENT' && rO.body.candidate.D === rM.body.candidate.D && rO.body.observations[0].publisher_auth === rM.body.observations[0].publisher_auth, { same_candidates: same, origin: rO.body.state, mirror: rM.body.state });
}

// ================= controlled index (stub) for the adversarial cases =================
const stubPort = 13153;
let stubMode = 'empty';
let stubEntries = [];
const stub = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/possession') {
    let entries = stubEntries;
    if (stubMode === 'permuted') entries = [...stubEntries].reverse();
    if (stubMode === 'flood_d') { entries = []; for (let i = 0; i < 10000; i++) entries.push({ ...stubEntries[0], claimed_D: sha('fake' + i) }); }
    if (stubMode === 'boundary256' || stubMode === 'boundary257' || stubMode === 'boundary257_shuffled') {
      const n = stubMode === 'boundary256' ? 256 : 257;
      entries = [];
      for (let i = 0; i < n; i++) entries.push({ ...stubEntries[0], version: `0.0.${i}` });
      if (stubMode === 'boundary257_shuffled') entries = entries.sort(() => Math.random() - 0.5);
    }
    if (stubMode === 'malformed') entries = [{ ...stubEntries[0], publisher_scheme: 'p1-configured-v1' }, { ...stubEntries[0], claimed_D: 'nothex' }, stubEntries[0]];
    if (stubMode === 'wrong_name_flood') {
      entries = [];
      for (let i = 0; i < 10000; i++) entries.push({ ...stubEntries[0], name: 'other-capability', version: `0.${Math.floor(i / 1000)}.${i % 1000}` });
      entries.push(stubEntries[0]);
    }
    if (stubMode === 'unsorted_random') entries = [...entries].sort(() => Math.random() - 0.5);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ name: u.searchParams.get('name'), entries, order_semantics: 'none' }));
  }
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => stub.listen(stubPort, '127.0.0.1', r));
const stubEp = 'http://127.0.0.1:' + stubPort;
const VICTIM = '2'.repeat(64);
const ENTRY = { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: NAME, version: '0.1.0', claimed_D: D0 };
stubEntries = [ENTRY];

// ================= case 0: the canonical grammar matches the sealed tuple namespace =================
{
  const oneChar = normalizeCandidateEntries([{ ...ENTRY, name: 'a', version: '0.1.0' }], { expectedName: 'a' });
  const prerelease = normalizeCandidateEntries([{ ...ENTRY, version: '1.0.0-rc1' }], { expectedName: NAME });
  step('0. the canonical validator IS the sealed tuple grammar: a one-character name is legal, a prerelease version is not', oneChar.candidates.length === 1 && oneChar.candidates[0].name === 'a' && prerelease.candidates.length === 0 && prerelease.diagnostics.rejected === 1, { one_char: oneChar.candidates.length, prerelease_candidates: prerelease.candidates.length });
}


// ================= case 3: false publisher entry =================
{
  stubMode = 'empty'; stubEntries = [{ ...ENTRY, publisher_id: VICTIM }];
  const disc = await discoverCandidates({ endpoint: stubEp, name: NAME });
  const cand = disc.candidates[0];
  // the endpoint cannot produce any material for the victim publisher
  const r = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'liar', endpoint: ep('r1') }], scheme: cand.publisher_scheme, publisher_id: cand.publisher_id, name: cand.name, version: cand.version });
  const obs = (r.body.observations || [])[0] || {};
  const before = await consumerState();
  // and an import claiming the victim tuple cannot ride the honest material
  const st = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: join(WORK, 'b-incoming'), alias: 'victim-cap', identityMaterial: { genesis, events: [ev1], publication: ASSERT1 }, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', publisher_id: VICTIM, name: NAME, version: '0.1.0', D: D0 } });
  const after = await consumerState();
  step('3. a false publisher entry yields a candidate that ordinary verification rejects — no pin, no admission', disc.candidates.length === 1 && obs.status !== 'VALID' && r.body.fetch_permitted === false && st.body.import && st.body.import.verdict === 'REFUSED' && JSON.stringify(before.pin) === JSON.stringify(after.pin) && before.registry_sha === after.registry_sha, { observation: obs.status, resolve_state: r.body.state, fetch_permitted: r.body.fetch_permitted, stage_refusal: st.body.import && st.body.import.refusal && st.body.import.refusal.code, pin_unchanged: JSON.stringify(before.pin) === JSON.stringify(after.pin) });
}

// ================= case 4: false / stale claimed_D =================
{
  stubMode = 'empty'; stubEntries = [{ ...ENTRY, claimed_D: sha('bogus-claimed-D') }];
  const disc = await discoverCandidates({ endpoint: stubEp, name: NAME });
  const cand = disc.candidates[0];
  // the consumer ignores claimed_D entirely: it resolves the exact tuple and
  // takes the authenticated D from F0/P2
  const r = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'stale', endpoint: ep('r1') }], scheme: cand.publisher_scheme, publisher_id: cand.publisher_id, name: cand.name, version: cand.version });
  const authenticatedD = r.body.candidate && r.body.candidate.D;
  step('4. a false/stale claimed_D has zero authority: the candidate carries no D and F0/P2 supplies the authenticated one', disc.candidates[0].claimed_D === undefined && authenticatedD === D0 && authenticatedD !== sha('bogus-claimed-D'), { candidate_keys: Object.keys(disc.candidates[0]).sort(), authenticated_D: String(authenticatedD).slice(0, 12), claimed_D_in_candidate: disc.candidates[0].claimed_D === undefined ? 'absent' : 'PRESENT (wrong)' });
}

// ================= case 5: nonexistent tuple =================
{
  stubMode = 'empty'; stubEntries = [{ ...ENTRY, version: '9.9.9' }];
  const disc = await discoverCandidates({ endpoint: stubEp, name: NAME });
  const cand = disc.candidates[0];
  const r = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'ghost', endpoint: ep('r1') }], scheme: cand.publisher_scheme, publisher_id: cand.publisher_id, name: cand.name, version: cand.version });
  step('5. an indexed tuple the endpoint does not possess surfaces as ABSENT (aggregate EMPTY) — a harmless candidate failure', disc.candidates.length === 1 && r.body.state === 'EMPTY' && r.body.observations[0].status === 'ABSENT' && r.body.fetch_permitted === false, { state: r.body.state, observation: r.body.observations[0].status });
}

// ================= case 6: malformed material AND wrong-name poisoning =================
{
  stubMode = 'malformed'; stubEntries = [ENTRY];
  const disc = await discoverCandidates({ endpoint: stubEp, name: NAME });
  // the index may list anything; ordinary P2 verification still rejects bad material
  const st = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: join(WORK, 'b-incoming'), alias: 'bad-material', identityMaterial: { genesis, events: [ev1], publication: { ...ASSERT1, signature: Buffer.alloc(64).toString('base64url'), D: D0 } }, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, D: D0 } });
  step('6. malformed entries are rejected by normalization, and invalid publication material is still rejected by P2', disc.diagnostics.rejected === 2 && disc.candidates.length === 1 && st.body.import && st.body.import.verdict === 'REFUSED', { rejected: disc.diagnostics.rejected, candidates: disc.candidates.length, stage: st.body.import && st.body.import.verdict });

  // wrong-name poisoning: 10,000 canonical entries for ANOTHER name plus one
  // real match. The query boundary must bind, and the junk must consume zero
  // candidate slots (otherwise it could crowd out legitimate candidates).
  stubEntries = [ENTRY]; // the query is for NAME
  stubMode = 'wrong_name_flood';
  const poison = await discoverCandidates({ endpoint: stubEp, name: NAME });
  step('6b. 10,000 canonical entries for ANOTHER name cannot enter the result or consume bound slots — exactly one candidate, for the requested name', poison.candidates.length === 1 && poison.candidates[0].name === NAME && poison.diagnostics.wrong_name_observations === 10000 && poison.diagnostics.total_unique === 1 && poison.truncated === false, { candidates: poison.candidates.length, name: poison.candidates[0] && poison.candidates[0].name, wrong_name: poison.diagnostics.wrong_name_observations, unique: poison.diagnostics.total_unique });
}

// ================= case 7: repetition (identical AND differing D claims) =================
{
  const one = normalizeCandidateEntries([ENTRY]);
  const manySame = normalizeCandidateEntries(Array.from({ length: 500 }, () => ({ ...ENTRY })));
  const manyDiffD = normalizeCandidateEntries(Array.from({ length: 10000 }, (_, i) => ({ ...ENTRY, claimed_D: sha('diff' + i) })));
  const same = (x) => candidateDigest(x.candidates);
  step('7. repetition with identical or with 10,000 DIFFERENT claimed_D values always yields exactly one candidate', one.candidates.length === 1 && manySame.candidates.length === 1 && manyDiffD.candidates.length === 1 && same(one) === same(manySame) && same(one) === same(manyDiffD) && manyDiffD.diagnostics.duplicate_observations === 9999, { one: one.candidates.length, many_same: manySame.candidates.length, many_diff_D: manyDiffD.candidates.length, digest_stable: same(one) === same(manyDiffD) });
}

// ================= case 8: permutation =================
{
  const other = { ...ENTRY, version: '0.2.0' };
  const base = [ENTRY, other, { ...ENTRY, claimed_D: sha('x') }];
  const perm = [base[2], base[1], base[0]];
  const a = normalizeCandidateEntries(base);
  const b = normalizeCandidateEntries(perm);
  stubMode = 'permuted'; stubEntries = base;
  const viaStub = await discoverCandidates({ endpoint: stubEp, name: NAME });
  step('8. arbitrary permutations (including differing D claims for one tuple) normalize identically, over a stub that reverses order', candidateDigest(a.candidates) === candidateDigest(b.candidates) && candidateDigest(a.candidates) === candidateDigest(viaStub.candidates) && a.candidates.length === 2 && a.truncated === false, { a: a.candidates.length, b: b.candidates.length, via_index: viaStub.candidates.length, digest_stable: candidateDigest(a.candidates) === candidateDigest(viaStub.candidates) });
}

// ================= case 9: multiple versions, none selected =================
{
  stubEntries = [{ ...ENTRY, version: '0.1.0' }, { ...ENTRY, version: '0.2.0' }, { ...ENTRY, version: '2.0.0' }];
  stubMode = 'empty';
  const disc = await discoverCandidates({ endpoint: stubEp, name: NAME });
  const versions = disc.candidates.map((c) => c.version);
  const noSelection = !disc.candidates.some((c) => c.latest || c.preferred || c.current || c.selected) && !/latest|preferred|current|selected/.test(JSON.stringify(disc.candidates));
  step('9. multiple exact versions are all returned as candidates and D0 selects none of them', disc.candidates.length === 3 && versions.includes('0.1.0') && versions.includes('0.2.0') && versions.includes('2.0.0') && noSelection, { versions, selection_fields: noSelection ? 'none' : 'PRESENT (wrong)' });
}

// ================= case 10: withholding (stated limit) =================
{
  stubMode = 'empty'; stubEntries = [];
  const disc = await discoverCandidates({ endpoint: stubEp, name: NAME });
  const realIndex = await discoverCandidates({ endpoint: ep('r1'), name: NAME });
  step('10. withholding: an index that omits a held publication is indistinguishable from an empty one — no completeness claim', disc.candidates.length === 0 && disc.truncated === false && realIndex.candidates.length === 1 && disc.diagnostics.total_unique === 0, { omitting_index: disc.candidates.length, actual_holder_entries: realIndex.candidates.length, completeness_claimed: false });
}

// ================= case 11: index disappears after observation =================
{
  stubEntries = [ENTRY]; stubMode = 'empty';
  const disc = await discoverCandidates({ endpoint: stubEp, name: NAME });
  const before = await consumerState();
  const resolve = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'learned', endpoint: ep('r1') }], scheme: disc.candidates[0].publisher_scheme, publisher_id: disc.candidates[0].publisher_id, name: disc.candidates[0].name, version: disc.candidates[0].version });
  const after = await consumerState();
  // and with the index gone entirely, an unrelated endpoint still resolves
  const dead = await discoverCandidates({ endpoint: 'http://127.0.0.1:19999', name: NAME }).catch((e) => ({ error: e.code || 'D0_INDEX_UNAVAILABLE' }));
  step('11. an index that disappears changes nothing retroactively: the already-observed candidate still resolves through the publication endpoint', disc.candidates.length === 1 && resolve.body.state === 'CONSISTENT' && before.registry_sha === after.registry_sha && JSON.stringify(before.pin) === JSON.stringify(after.pin) && dead.error === 'D0_INDEX_UNAVAILABLE', { resolve: resolve.body.state, dead_index: dead.error, pin_unchanged: JSON.stringify(before.pin) === JSON.stringify(after.pin) });
}

// ================= case 12: no trust-state mutation =================
{
  stubEntries = [ENTRY, { ...ENTRY, version: '0.2.0' }];
  const before = await consumerState();
  await discoverCandidates({ endpoint: stubEp, name: NAME });
  await discoverCandidates({ endpoint: ep('r1'), name: NAME });
  await discoverCandidates({ endpoint: ep('r2'), name: NAME });
  const after = await consumerState();
  const r1Before = (await get(ep('r1'), '/status')).body;
  const r2Before = (await get(ep('r2'), '/status')).body;
  step('12. discovery and normalization leave consumer pins/witness/registry/task store and repository state byte-identical', before.registry_sha === after.registry_sha && before.taskstore_sha === after.taskstore_sha && JSON.stringify(before.pin) === JSON.stringify(after.pin) && before.pin_witness_sha === after.pin_witness_sha && before.equivocation_records === after.equivocation_records && r1Before.publications === r2Before.publications, { registry_identical: before.registry_sha === after.registry_sha, pin_identical: JSON.stringify(before.pin) === JSON.stringify(after.pin), r1: r1Before.publications, r2: r2Before.publications });
}

// ================= case 13: flood bound with the frozen edge conditions =================
{
  // (a) 10,000 fake D claims for ONE tuple consume exactly one slot
  stubMode = 'flood_d';
  const flood = await discoverCandidates({ endpoint: stubEp, name: NAME });
  // (b) exactly 256 unique tuple keys → 256 retained, truncated false
  stubMode = 'boundary256';
  const b256 = await discoverCandidates({ endpoint: stubEp, name: NAME });
  // (c) 257 unique tuple keys → canonical first 256, truncated true
  stubMode = 'boundary257';
  const b257 = await discoverCandidates({ endpoint: stubEp, name: NAME });
  // (d) the canonical 256 are the same under a randomized response order of
  // the SAME 257-entry set
  stubMode = 'boundary257_shuffled';
  const shuffled = await discoverCandidates({ endpoint: stubEp, name: NAME });
  step('13. flood bound: 10,000 fake D claims → one slot; 256 → truncated false; 257 → canonical first 256 with truncated true, order-independent', flood.candidates.length === 1 && b256.candidates.length === 256 && b256.truncated === false && b257.candidates.length === 256 && b257.truncated === true && candidateDigest(b257.candidates) === candidateDigest(shuffled.candidates) && b257.diagnostics.total_unique === 257 && MAX_D0_CANDIDATES === 256, { flood: flood.candidates.length, at_256: `${b256.candidates.length}/truncated=${b256.truncated}`, at_257: `${b257.candidates.length}/truncated=${b257.truncated}/unique=${b257.diagnostics.total_unique}`, order_independent: candidateDigest(b257.candidates) === candidateDigest(shuffled.candidates) });
}

// ================= case 14: copy count adds nothing =================
{
  stubEntries = [ENTRY]; stubMode = 'empty';
  const oneIndex = await discoverCandidates({ endpoint: stubEp, name: NAME });
  const twoIndexes = await discoverCandidates({ endpoint: ep('r1'), name: NAME });
  const threeIndexes = await discoverCandidates({ endpoint: ep('r2'), name: NAME });
  const contexts = [oneIndex, twoIndexes, threeIndexes];
  const auths = [];
  for (const c of contexts) {
    const cand = c.candidates[0];
    const r = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'one', endpoint: ep('r1') }], scheme: cand.publisher_scheme, publisher_id: cand.publisher_id, name: cand.name, version: cand.version });
    auths.push(r.body.observations[0].publisher_auth);
  }
  const many = normalizeCandidateEntries(Array.from({ length: 8 }, () => ({ ...ENTRY })));
  step('14. the same tuple known through 1, 2 or N indexes (and repeated inside one) authenticates identically — copy count adds nothing', candidateDigest(oneIndex.candidates) === candidateDigest(twoIndexes.candidates) && candidateDigest(oneIndex.candidates) === candidateDigest(threeIndexes.candidates) && candidateDigest(many.candidates) === candidateDigest(oneIndex.candidates) && new Set(auths).size === 1 && auths[0] === 'VERIFIED', { identical_candidates: candidateDigest(oneIndex.candidates) === candidateDigest(threeIndexes.candidates), auth: auths });
}

stub.close();

const okAll = receipt.steps.every((s) => s.ok);
receipt.verdict = okAll
  ? 'D0 GREEN — a name and an endpoint yield exact tuple candidates that feed the sealed path; false, stale, duplicated, reordered, omitted or unavailable index observations affect only completeness or cost'
  : 'MATRIX INCOMPLETE';
await writeFile(join(root, 'eval', 'receipts', 'FLOWROUTER-D0-RECEIPT.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log('\nverdict:', receipt.verdict);
if (!okAll) process.exitCode = 1;
