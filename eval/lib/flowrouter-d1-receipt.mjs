#!/usr/bin/env node
// eval/lib/flowrouter-d1-receipt.mjs — FlowRouter D1 acceptance matrix
// (frozen spec ac80256): untrusted endpoint directory.
//
// The positive path uses ONE endpoint in D1 and ONE tuple in D0, so the
// demonstration acquires neither an endpoint-selection nor a version-selection
// policy merely to reach SHIP.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, packageDigest } from '../../lib/flowrouter.js';
import { discoverCandidates } from '../../lib/discovery.js';
import {
  discoverEndpoints, normalizeEndpointEntries, canonicalOrigin, endpointListDigest, MAX_D1_ENDPOINTS,
} from '../../lib/directory.js';
import {
  generateKeypair, createGenesis, createKeyEvent, replayChain, signPublication, deriveKeyId, recordDigest,
} from '../../lib/identity.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = 'http://127.0.0.1:8412';
const B = 'http://127.0.0.1:8414';
const WORK = '/tmp/flowrouter-d1';
const B_HOME = '/tmp/opui-b-home';
const R_PORT = 13161;
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
const serviceStart = () => spawn(process.execPath, [join(root, 'eval', 'lib', 'flowrouter-service.mjs'), '--port', String(R_PORT), '--store', join(WORK, 'store-r1')], { detached: true, stdio: 'ignore' }).unref();
const waitUp = async (ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const s = await get(EP, '/status'); if (s.status === 200) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
};
const restartConsumerLane = async (port, home) => {
  killListener(port);
  await new Promise((r) => setTimeout(r, 1200));
  spawn(process.env.DSH_BIN || 'dsh', ['web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], { detached: true, stdio: 'ignore', cwd: home, env: { ...process.env, DSH_HOME: home } }).unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) { try { const s = await get('http://127.0.0.1:' + port, '/plugins/operator-ui/rcos'); if (s.status === 200) return true; } catch {} await new Promise((r) => setTimeout(r, 900)); }
  return false;
};
const EP = `http://127.0.0.1:${R_PORT}`;

const receipt = { generated_at: new Date().toISOString(), spec: 'ac80256 (D1 — untrusted endpoint directory)', steps: [] };
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
const consumerState = async () => {
  const reg = await readFile(join(B_HOME, 'operator-ui', 'b-registry.json'));
  let tasks = ''; try { tasks = await readFile(join(B_HOME, 'operator-ui', 'tasks.json'), 'utf8'); } catch {}
  const parsed = (() => { try { return JSON.parse(tasks).tasks || []; } catch { return []; } })();
  const pin = parsed.find((t) => t.kind === 'pin');
  return { registry_sha: sha(reg), taskstore_sha: sha(Buffer.from(tasks, 'utf8')), pin: pin ? pin.pin : null, pin_witness_sha: pin && pin.witness ? sha(Buffer.from(JSON.stringify(pin.witness), 'utf8')) : null, equivocation_records: parsed.filter((t) => t.kind === 'equivocation').length };
};

// ---------- topology: one repository + a consumer + a controlled directory ----------
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
await writeFile(join(B_HOME, 'operator-ui', 'b-registry.json'), JSON.stringify({ registry_version: 'rcos-public-v1', capabilities: [] }, null, 2) + '\n', 'utf8');
await rm(join(B_HOME, 'operator-ui', 'tasks.json'), { force: true });
if (!(await restartConsumerLane(8414, B_HOME))) { console.error('consumer lane did not come up'); process.exit(2); }
killListener(R_PORT);
serviceStart();
await waitUp();
step('topology: one repository (with a D0 possession index) + a consumer + a controlled directory', (await get(EP, '/status')).status === 200, { repo: EP });

// publisher + artifact, published to the repository
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
await post(EP, '/publisher', { genesis, events: [ev1] });
await post(EP, '/publish', { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, artifact: artB64(files0), publication: ASSERT1 });

// controlled directory
const dirPort = 13162;
let dirEntries = [];
let dirMode = 'empty';
const dir = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/endpoints') {
    let entries = dirEntries;
    if (dirMode === 'reverse') entries = [...dirEntries].reverse();
    if (dirMode === 'shuffled') entries = [...dirEntries].sort(() => Math.random() - 0.5);
    if (dirMode === 'flood') { entries = []; for (let i = 0; i < 10000; i++) entries.push({ endpoint: EP }); }
    if (dirMode === 'boundary256' || dirMode === 'boundary257' || dirMode === 'boundary257_shuffled') {
      const n = dirMode === 'boundary256' ? 256 : 257;
      entries = [];
      for (let i = 0; i < n; i++) entries.push({ endpoint: `https://e${i}.example.com` });
      if (dirMode === 'boundary257_shuffled') entries = entries.sort(() => Math.random() - 0.5);
    }
    if (dirMode === 'extra_fields') entries = [{ endpoint: EP, rank: 1 }, { endpoint: EP, publisher_id: genesis.publisher_id }, { ...dirEntries[0] }];
    if (dirMode === 'spellings') entries = [{ endpoint: EP }, { endpoint: EP + '/' }, { endpoint: 'http://127.0.0.1:19999' }, { endpoint: 'ftp://127.0.0.1:19999' }, { endpoint: 'http://user:pw@127.0.0.1:19999' }, { endpoint: EP + '/path' }, { endpoint: EP + '?q=1' }, { endpoint: EP + '#frag' }, { endpoint: 'https://example.com.' }, { endpoint: 'https://EXAMPLE.com' }];
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ name: u.searchParams.get('name'), entries, order_semantics: 'none' }));
  }
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => dir.listen(dirPort, '127.0.0.1', r));
const DIR = 'http://127.0.0.1:' + dirPort;
dirEntries = [{ endpoint: EP }];

// ================= 1. positive: name + directory → one endpoint → one tuple → sealed path → SHIP =================
let positiveEndpoints = null;
{
  const disc = await discoverEndpoints({ directory: DIR, name: NAME });
  positiveEndpoints = disc.endpoints;
  const ep0 = disc.endpoints[0];
  const cands = await discoverCandidates({ endpoint: ep0, name: NAME });
  const cand = cands.candidates[0];
  const r = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'learned', endpoint: ep0 }], scheme: cand.publisher_scheme, publisher_id: cand.publisher_id, name: cand.name, version: cand.version });
  const fet = await post(B, '/plugins/operator-ui/federation?op=fetch', { resolution_handle: r.body.resolution_handle, D: r.body.candidate && r.body.candidate.D });
  const incoming = join(WORK, 'b-incoming');
  await rm(incoming, { recursive: true, force: true });
  for (const f of JSON.parse(Buffer.from(fet.body.bytes_b64 || '', 'base64') || '{"files":[]}').files || []) {
    const dest = join(incoming, f.path); await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, Buffer.from(f.b64, 'base64'));
  }
  const st = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming, alias: 'csv-running-total', identityMaterial: fet.body.material, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', ...TUPLE, D: D0 } });
  const ver = await post(B, '/plugins/operator-ui/flowrouter?op=verify', { importTaskId: st.body.import && st.body.import.taskId, fixtureDir: '/tmp/flowrouter-p0/b-fixture' });
  const adm = await post(B, '/plugins/operator-ui/flowrouter?op=admit', { importTaskId: st.body.import && st.body.import.taskId });
  let goal = (await post(B, '/plugins/operator-ui/goal', { objective: 'Process values.csv in order and report the running total after each row, one per line, as RESULT row=<n> total=<cumulative sum>.' })).body.goal || {};
  const gate = new Set(goal.failureCodes || []).has('awaiting-approval');
  if (gate) goal = (await post(B, '/plugins/operator-ui/goal', { approveTaskId: goal.taskId })).body.goal || {};
  const checks = Object.fromEntries((goal.checks || []).map((c) => [c.id, c.pass]));
  receipt.positive = { learned_from_directory: disc.learned_from_directory, endpoint: ep0, candidate: cand, D: D0, final_verdict: goal.verdict };
  step('1. positive: name + directory only → one endpoint → one D0 tuple → F0/P2 → stage → B-local verify → explicit admit → route → SHIP, authenticating publisher P (not the directory)', disc.endpoints.length === 1 && cands.candidates.length === 1 && r.body.state === 'CONSISTENT' && fet.body.material.genesis.publisher_id === genesis.publisher_id && st.body.import && st.body.import.verdict === 'STAGED' && ver.body.import && ver.body.import.verdict === 'VERIFIED' && adm.body.ok === true && goal.verdict === 'SHIP' && gate && checks['objective-satisfaction'] === true, { endpoints: disc.endpoints.length, candidates: cands.candidates.length, verdict: goal.verdict });
}

// ================= 2. entry shape: exactly {endpoint}; extra fields reject =================
{
  dirMode = 'extra_fields';
  const disc = await discoverEndpoints({ directory: DIR, name: NAME });
  step('2/3. an entry carries exactly {endpoint}: the two well-formed ones dedupe to one candidate and both extra-field entries are rejected', disc.endpoints.length === 1 && disc.diagnostics.rejected === 2 && disc.diagnostics.rejected_reasons['an entry carries exactly the field "endpoint"'] === 2, { endpoints: disc.endpoints.length, rejected: disc.diagnostics.rejected, reasons: disc.diagnostics.rejected_reasons });
}

// ================= 4/5/6. canonicalization: spellings, schemes, malformed locators =================
{
  dirMode = 'spellings';
  const disc = await discoverEndpoints({ directory: DIR, name: NAME });
  const canon = [canonicalOrigin(EP), canonicalOrigin(EP + '/'), canonicalOrigin('http://127.0.0.1:19999'), canonicalOrigin('ftp://x'), canonicalOrigin('http://user:pw@h'), canonicalOrigin('https://example.com.'), canonicalOrigin('https://EXAMPLE.com')];
  // ten entries: two spelling pairs collapse (EP + EP/ and EXAMPLE.com + example.com.), and five locators are invalid (non-http scheme, credentials, path, query, fragment)
  step('4/5/6. equivalent spellings dedupe, http/https stay distinct, and malformed locators are rejected while consuming no slots', disc.endpoints.length === 3 && disc.diagnostics.duplicates_collapsed === 2 && disc.diagnostics.invalid_locators === 5 && canon[0] === canon[1] && canon[0] !== canon[2] && canon[6] === 'https://example.com' && canon[5] === 'https://example.com' && canon[3] === null, { endpoints: disc.endpoints, collapsed: disc.diagnostics.duplicates_collapsed, invalid_locators: disc.diagnostics.invalid_locators, http_vs_https_distinct: canon[0] !== canon[2], root_dot_collapsed: canon[5] === canon[6] });
}

// ================= 7. repetition =================
{
  dirMode = 'flood';
  const disc = await discoverEndpoints({ directory: DIR, name: NAME });
  const one = normalizeEndpointEntries([{ endpoint: EP }]);
  step('7. 10,000 copies of one endpoint normalize to exactly one candidate (1 = 10,000 in trust weight)', disc.endpoints.length === 1 && disc.diagnostics.duplicates_collapsed === 9999 && endpointListDigest(disc.endpoints) === endpointListDigest(one.endpoints), { endpoints: disc.endpoints.length, collapsed: disc.diagnostics.duplicates_collapsed });
}

// ================= 8. permutation =================
{
  dirMode = 'empty';
  dirEntries = [{ endpoint: EP }, { endpoint: 'https://b.example.com' }, { endpoint: 'https://a.example.com' }];
  const forward = await discoverEndpoints({ directory: DIR, name: NAME });
  dirMode = 'reverse';
  const reversed = await discoverEndpoints({ directory: DIR, name: NAME });
  dirMode = 'shuffled';
  const shuffled = await discoverEndpoints({ directory: DIR, name: NAME });
  dirMode = 'empty';
  step('8. every response permutation normalizes to the identical candidate list', endpointListDigest(forward.endpoints) === endpointListDigest(reversed.endpoints) && endpointListDigest(forward.endpoints) === endpointListDigest(shuffled.endpoints) && forward.endpoints.length === 3, { forward: forward.endpoints, digest_stable: endpointListDigest(forward.endpoints) === endpointListDigest(shuffled.endpoints) });
}

// ================= 9. 256/257 boundary =================
{
  dirMode = 'boundary256';
  const b256 = await discoverEndpoints({ directory: DIR, name: NAME });
  dirMode = 'boundary257';
  const b257 = await discoverEndpoints({ directory: DIR, name: NAME });
  dirMode = 'boundary257_shuffled';
  const shuffled = await discoverEndpoints({ directory: DIR, name: NAME });
  dirMode = 'empty';
  step('9. MAX_D1_ENDPOINTS = 256: 256 unique → 256 with truncated false; 257 → the canonical first 256 with truncated true, order-independent', MAX_D1_ENDPOINTS === 256 && b256.endpoints.length === 256 && b256.truncated === false && b257.endpoints.length === 256 && b257.truncated === true && b257.diagnostics.total_unique === 257 && endpointListDigest(b257.endpoints) === endpointListDigest(shuffled.endpoints), { at_256: `${b256.endpoints.length}/truncated=${b256.truncated}`, at_257: `${b257.endpoints.length}/truncated=${b257.truncated}/unique=${b257.diagnostics.total_unique}`, order_independent: endpointListDigest(b257.endpoints) === endpointListDigest(shuffled.endpoints) });
}

// ================= 10. false endpoint (holds nothing for N) =================
{
  dirEntries = [{ endpoint: 'http://127.0.0.1:19999' }];
  const disc = await discoverEndpoints({ directory: DIR, name: NAME });
  const before = await consumerState();
  const cands = await discoverCandidates({ endpoint: disc.endpoints[0], name: NAME }).catch((e) => ({ error: e.code || 'D0_INDEX_UNAVAILABLE', candidates: [] }));
  const after = await consumerState();
  step('10. a false endpoint (holding nothing for N) yields no useful candidate and mutates no trust state', disc.endpoints.length === 1 && (cands.error === 'D0_INDEX_UNAVAILABLE' || cands.candidates.length === 0) && before.registry_sha === after.registry_sha && JSON.stringify(before.pin) === JSON.stringify(after.pin), { d0: cands.error || `candidates=${cands.candidates.length}`, pin_unchanged: JSON.stringify(before.pin) === JSON.stringify(after.pin) });
}

// ================= 11. swapped publisher / 12. directory-D0 disagreement =================
{
  // the directory suggests an endpoint that knows nothing about this name;
  // D0 governs and returns zero matching candidates, and D1 contributes nothing
  dirEntries = [{ endpoint: EP }];
  const disc = await discoverEndpoints({ directory: DIR, name: 'another-capability' });
  const cands = await discoverCandidates({ endpoint: disc.endpoints[0], name: 'another-capability' });
  step('11/12. the directory suggestion cannot override D0: an endpoint with no matching possession yields zero candidates, and no publisher identity is involved at D1 at all', disc.endpoints.length === 1 && cands.candidates.length === 0 && !JSON.stringify(disc).match(/publisher_id|publisher_scheme|claimed_D|"D"/), { candidates: cands.candidates.length, d1_carries_publisher_data: /publisher_id|claimed_D/.test(JSON.stringify(disc)) });
}

// ================= 13. withholding =================
{
  dirMode = 'empty'; dirEntries = [];
  const disc = await discoverEndpoints({ directory: DIR, name: NAME });
  step('13. withholding: a directory that omits a working repository is indistinguishable from an empty one — no completeness claim is made', disc.endpoints.length === 0 && disc.truncated === false && disc.diagnostics.total_unique === 0, { endpoints: disc.endpoints.length, completeness_claimed: false });
}

// ================= 14. directory disappears after observation =================
{
  dirEntries = [{ endpoint: EP }];
  const disc = await discoverEndpoints({ directory: DIR, name: NAME });
  const before = await consumerState();
  // query a dead directory: the already-normalized candidate is unaffected
  const dead = await discoverEndpoints({ directory: 'http://127.0.0.1:19998', name: NAME }).catch((e) => ({ error: e.code || 'D1_DIRECTORY_UNAVAILABLE' }));
  const cands = await discoverCandidates({ endpoint: disc.endpoints[0], name: NAME });
  const after = await consumerState();
  step('14. a directory that disappears after observation changes nothing: the normalized candidate still works through D0', disc.endpoints.length === 1 && dead.error === 'D1_DIRECTORY_UNAVAILABLE' && cands.candidates.length === 1 && before.registry_sha === after.registry_sha, { dead_directory: dead.error, candidates: cands.candidates.length });
}

// ================= 15. no automatic dereference =================
{
  dirEntries = [];
  const hits = [];
  const spy = createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ entries: [] })); });
  await new Promise((r) => spy.listen(13163, '127.0.0.1', r));
  const spyEp = 'http://127.0.0.1:13163';
  dirEntries = [{ endpoint: spyEp }, { endpoint: 'http://127.0.0.1:13164' }];
  const disc = await discoverEndpoints({ directory: DIR, name: NAME });
  await new Promise((r) => setTimeout(r, 800));
  step('15. obtaining D1 results makes ZERO network calls to the returned endpoints (no automatic dereference)', disc.endpoints.length === 2 && hits.length === 0, { endpoints: disc.endpoints.length, calls_to_returned_endpoints: hits.length });
  spy.close();
}

// ================= 16. no trust-state mutation =================
{
  dirEntries = [{ endpoint: EP }];
  const before = await consumerState();
  const repoBefore = (await get(EP, '/status')).body;
  await discoverEndpoints({ directory: DIR, name: NAME });
  await discoverCandidates({ endpoint: EP, name: NAME });
  await discoverEndpoints({ directory: DIR, name: 'other-name' });
  const after = await consumerState();
  const repoAfter = (await get(EP, '/status')).body;
  step('16. D1 query/normalization leaves consumer pins/witness/registry/task store and repository state byte-identical', before.registry_sha === after.registry_sha && before.taskstore_sha === after.taskstore_sha && JSON.stringify(before.pin) === JSON.stringify(after.pin) && before.pin_witness_sha === after.pin_witness_sha && before.equivocation_records === after.equivocation_records && repoBefore.publications === repoAfter.publications, { registry_identical: before.registry_sha === after.registry_sha, pin_identical: JSON.stringify(before.pin) === JSON.stringify(after.pin), publications: repoAfter.publications });
}

// ================= 17. manual equivalence =================
{
  dirEntries = [{ endpoint: EP }];
  const learned = (await discoverEndpoints({ directory: DIR, name: NAME })).endpoints[0];
  const typed = canonicalOrigin(EP);
  const a = await discoverCandidates({ endpoint: learned, name: NAME });
  const b = await discoverCandidates({ endpoint: typed, name: NAME });
  const ra = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'learned', endpoint: learned }], scheme: 'p2-selfcert-v1', ...TUPLE });
  const rb = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'typed', endpoint: typed }], scheme: 'p2-selfcert-v1', ...TUPLE });
  step('17. a directory-learned endpoint is indistinguishable from the SAME endpoint typed manually (identical D0 candidates and identical F0 result)', learned === typed && JSON.stringify(a.candidates) === JSON.stringify(b.candidates) && ra.body.state === 'CONSISTENT' && rb.body.state === 'CONSISTENT' && ra.body.candidate.D === rb.body.candidate.D, { learned: learned, typed: typed, same_candidates: JSON.stringify(a.candidates) === JSON.stringify(b.candidates), same_state: ra.body.state === rb.body.state });
}

// ================= 18. copy / membership count adds nothing =================
{
  dirEntries = [{ endpoint: EP }, { endpoint: EP }, { endpoint: EP }];
  const many = await discoverEndpoints({ directory: DIR, name: NAME });
  dirEntries = [{ endpoint: EP }];
  const one = await discoverEndpoints({ directory: DIR, name: NAME });
  const rMany = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: many.endpoints.map((e, i) => ({ repository_id: 'm' + i, endpoint: e })), scheme: 'p2-selfcert-v1', ...TUPLE });
  const rOne = await post(B, '/plugins/operator-ui/federation?op=resolve', { peers: [{ repository_id: 'm0', endpoint: one.endpoints[0] }], scheme: 'p2-selfcert-v1', ...TUPLE });
  step('18. repeated membership inside a directory adds nothing: identical candidate list and identical authentication', many.endpoints.length === 1 && endpointListDigest(many.endpoints) === endpointListDigest(one.endpoints) && rMany.body.state === rOne.body.state && rMany.body.observations.length === 1 && rMany.body.observations[0].publisher_auth === 'VERIFIED', { endpoints: many.endpoints.length, state: rMany.body.state, observations: rMany.body.observations.length });
}

dir.close();

const okAll = receipt.steps.every((s) => s.ok);
receipt.verdict = okAll
  ? 'D1 GREEN — a name and an untrusted directory yield endpoint candidates that safely enter D0→F0→P2; membership, repetition, ordering, availability and operator behavior carry zero authority'
  : 'MATRIX INCOMPLETE';
await writeFile(join(root, 'eval', 'receipts', 'FLOWROUTER-D1-RECEIPT.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log('\nverdict:', receipt.verdict);
if (!okAll) process.exitCode = 1;
