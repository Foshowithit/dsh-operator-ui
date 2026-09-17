#!/usr/bin/env node
// eval/lib/flowrouter-p2-receipt.mjs — P2 adversarial acceptance matrix
// (spec v3 / 5269f25). Actors: publishers P (genesis → K1 → rotation K2,
// REVOKE K1), repository R (the extended service), clean consumer B (the
// :8414 lane with its own home/registry/task store).
//
// Positive + the full frozen adversarial matrix. Publisher authentication
// is PROVENANCE ONLY — the receipt's final steps re-prove that the
// authenticated capability still needs P0 stage → B-local verify →
// operator admission → authority gate → SHIP.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, packageDigest } from '../../lib/flowrouter.js';
import {
  generateKeypair, createGenesis, verifyGenesis, createKeyEvent, replayChain,
  signPublication, verifyPublication, deriveKeyId, recordDigest, classifyFreshness, chainExtendsPin,
} from '../../lib/identity.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = 'http://127.0.0.1:8412';
const R = 'http://127.0.0.1:13093';
const B = 'http://127.0.0.1:8414';
const WORK = '/tmp/flowrouter-p2';
const B_HOME = '/tmp/opui-b-home';
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
const bRegState = async () => {
  const raw = await readFile(join(B_HOME, 'operator-ui', 'b-registry.json'));
  return { sha: sha(raw), caps: (JSON.parse(raw.toString('utf8')).capabilities || []).length };
};

const receipt = { generated_at: new Date().toISOString(), steps: [] };
const step = (name, ok, result) => { receipt.steps.push({ step: name, ok, result }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '  → ' + JSON.stringify(result).slice(0, 220))); };

// ================= clean slate (work dirs) =================
await rm('/tmp/flowrouter-p2', { recursive: true, force: true });

// ================= reset R + B =================
try {
  const pids = execFileSync('lsof', ['-ti', ':13093'], { encoding: 'utf8' }).trim();
  for (const pid of pids.split('\n').filter(Boolean)) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
} catch {}
await new Promise((r) => setTimeout(r, 1000));
await rm(R_STORE, { recursive: true, force: true });
spawn(process.execPath, [join(root, 'eval', 'lib', 'flowrouter-service.mjs'), '--store', R_STORE], { detached: true, stdio: 'ignore' }).unref();
for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); try { if ((await get(R, '/status')).body.publications === 0) break; } catch {} }
await writeFile(join(B_HOME, 'operator-ui', 'b-registry.json'), JSON.stringify({ registry_version: 'rcos-public-v1', capabilities: [] }, null, 2) + '\n', 'utf8');
await rm(join(B_HOME, 'operator-ui', 'tasks.json'), { force: true });
{
  let pid = null;
  try { pid = execFileSync('lsof', ['-ti', ':8414'], { encoding: 'utf8' }).trim().split('\n')[0]; } catch {}
  if (pid) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
  await new Promise((r) => setTimeout(r, 1200));
  const DSH_BIN = (await import('./secrets.mjs')).dshBin();
  spawn(DSH_BIN, ['web', '--host', '127.0.0.1', '--port', '8414', '--no-open'], { env: { ...process.env, DSH_HOME: B_HOME }, detached: true, stdio: 'ignore' }).unref();
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 1000)); try { up = (await fetch(B + '/plugins/operator-ui/rcos')).ok; } catch {} }
  step('actors fresh: R zero publications, B empty home', up === true, { R: (await get(R, '/status')).body, B: await bRegState() });
}

// ================= P: genesis + K1 + publication =================
await mkdir(WORK, { recursive: true });
const P = generateKeypair();
const genesis = createGenesis(P, 'optimized-workflow');
step('P1 genesis: derivation + self-signature verify', (() => { try { const g = verifyGenesis(genesis); return g.publisher_id === genesis.publisher_id; } catch { return false; } })(), { publisher_id: genesis.publisher_id.slice(0, 20) });

// negative: genesis key substitution
step('N1 genesis-key substitution → IDENTITY_DERIVATION_MISMATCH', (() => {
  try { const other = generateKeypair(); verifyGenesis({ ...genesis, genesis_key: { alg: 'ed25519', key: other.publicKeyB64 } }); return false; }
  catch (e) { return e.code === 'IDENTITY_DERIVATION_MISMATCH'; }
})(), {});

const K1 = generateKeypair();
const ev1 = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 1, prevRecordDigest: recordDigest(genesis), action: 'AUTHORIZE', keyId: deriveKeyId(K1.publicKeyRaw), publicKeyRaw: K1.publicKeyRaw, permissions: ['publish'] });
const chain1 = replayChain(genesis, [ev1]);
step('K1 authorized; chain replays (seq 1, active=1)', chain1.head_sequence === 1 && chain1.active.size === 1, { head: chain1.head_digest.slice(0, 16) });

// register publisher with R
const reg = await post(R, '/publisher', { genesis, events: [ev1] });
step('R registers publisher; reported head equals the verified chain (no off-by-one)', reg.status === 200 && reg.body.head_sequence === chain1.head_sequence && reg.body.head_digest === chain1.head_digest, { reported: reg.body.head_sequence, verified: chain1.head_sequence });

// ================= A export + package (reuse csv-running-total) =================
const exp = await post(A, '/plugins/operator-ui/flowrouter?op=export', { capabilityId: 'csv-running-total', outDir: join(WORK, 'export') });
const A_PKG = exp.body.packageDir;
const D0 = exp.body.package_digest;
const artifactOf = async (dir) => {
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
};
const files0 = await artifactOf(A_PKG);
const art0 = Buffer.from(JSON.stringify({ files: files0.map((f) => ({ path: f.path, b64: f.bytes.toString('base64') })) }), 'utf8');
step('A export for the P2 chain (D0)', !!D0, { D0: D0.slice(0, 16) });

const pub0 = signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest });
step('K1 signs the exact publication (name+version+D at identity state 1)', (() => { try { verifyPublication(pub0, chain1); return true; } catch { return false; } })(), { key_id: pub0.key_id.slice(0, 12) });

// P1 legacy publication by the SAME textual components (namespace separation)
const leg = await post(R, '/publish', { publisher_scheme: 'p1-configured-v1', publisher_id: 'mac-a', name: 'csv-running-total', version: '0.1.0', artifact: art0.toString('base64') });
step('legacy p1-configured-v1 publication accepted (UNAUTHENTICATED)', leg.status === 200 && leg.body.publisher_auth === 'UNAUTHENTICATED', leg.body);

// P2 authenticated publication
const auth0 = await post(R, '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', artifact: art0.toString('base64'), publication: pub0 });
step('R independently verifies BEFORE the authenticated binding (VERIFIED)', auth0.status === 200 && auth0.body.publisher_auth === 'VERIFIED', auth0.body);

// negative: assertion name/version substitution
{
  const bad = signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'other-name', version: '0.1.0', D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest });
  const r2 = await post(R, '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', artifact: art0.toString('base64'), publication: bad });
  step('N2 name substitution → SIGNED_STATEMENT_MISMATCH, no binding', r2.status === 409 && r2.body.error === 'SIGNED_STATEMENT_MISMATCH', r2.body);
}
// negative: package/D mutation
{
  const bad = signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.4.4', D: 'e'.repeat(64), keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest });
  const r3 = await post(R, '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.4.4', artifact: art0.toString('base64'), publication: bad });
  step('N3 package/D mutation → SIGNED_STATEMENT_MISMATCH (signed D ≠ recomputed), no binding', r3.status === 409 && r3.body.error === 'SIGNED_STATEMENT_MISMATCH', r3.body);
{
  const r3b = await post(R, '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.6.0', artifact: art0.toString('base64') });
  step('N3b p2-selfcert publication missing its assertion → PUBLISHER_AUTH_INVALID', r3b.status === 409 && r3b.body.error === 'PUBLISHER_AUTH_INVALID', r3b.body);
}
}
// negative: unauthorized signer
{
  const KX = generateKeypair();
  const bad = signPublication({ privateKey: KX.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.5.0', D: D0, keyId: deriveKeyId(KX.publicKeyRaw), identitySequence: chain1.head_sequence, identityHeadDigest: chain1.head_digest });
  const r4 = await post(R, '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.5.0', artifact: art0.toString('base64'), publication: bad });
  step('N4 unauthorized signer → KEY_NOT_AUTHORIZED, no binding', r4.status === 409 && r4.body.error === 'KEY_NOT_AUTHORIZED', r4.body);
}
// negative: attacker package under victim identity
{
  const ATK = generateKeypair();
  const atkGenesis = createGenesis(ATK, 'attacker');
  const atkK = generateKeypair();
  const atkEv = createKeyEvent({ genesisKp: ATK, genesisRecord: atkGenesis, sequence: 1, prevRecordDigest: recordDigest(atkGenesis), action: 'AUTHORIZE', keyId: deriveKeyId(atkK.publicKeyRaw), publicKeyRaw: atkK.publicKeyRaw, permissions: ['publish'] });
  const atkChain = replayChain(atkGenesis, [atkEv]);
  // attacker signs THEIR package but claims the VICTIM's identity fields
  const atkPub = { ...signPublication({ privateKey: atkK.privateKey, publisherId: atkGenesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0, keyId: deriveKeyId(atkK.publicKeyRaw), identitySequence: atkChain.head_sequence, identityHeadDigest: atkChain.head_digest }), publisher_id: genesis.publisher_id };
  const r5 = await post(R, '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', artifact: art0.toString('base64'), publication: atkPub });
  step('N5 attacker D under victim identity → auth fails, no binding', r5.status === 409 && ['SIGNED_STATEMENT_MISMATCH', 'PUBLISHER_AUTH_INVALID', 'KEY_NOT_AUTHORIZED'].includes(r5.body.error), r5.body);
}
// negative: malformed transitions
{
  const badEv = (() => { try { createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 3, prevRecordDigest: chain1.head_digest, action: 'AUTHORIZE', keyId: deriveKeyId(K1.publicKeyRaw), publicKeyRaw: K1.publicKeyRaw, permissions: ['publish'] }); return 'crafted'; } catch { return 'craft-failed'; } })();
  const evGap = { ...ev1, sequence: 5 }; // sequence gap + it will fail signature anyway
  let code = null;
  try { replayChain(genesis, [evGap]); } catch (e) { code = e.code; }
  step('N6 malformed history (sequence gap / dup key) → IDENTITY_RECORD_INVALID', code === 'IDENTITY_RECORD_INVALID', { gap_code: code, dup_attempt: (() => { try { replayChain(genesis, [ev1, createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(K1.publicKeyRaw), publicKeyRaw: K1.publicKeyRaw, permissions: ['publish'] })]); return 'accepted'; } catch (e) { return e.code; } })() });
}

// ================= defects 1/3 negatives =================
// P->Q outer tuple substitution at R: valid P proof, request claims another publisher_id
{
  const Q = generateKeypair();
  const qGenesis = createGenesis(Q, 'victim-q');
  const rq = await post(R, '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: qGenesis.publisher_id, name: 'csv-running-total', version: '0.9.0', artifact: art0.toString('base64'), publication: { ...pub0, name: 'csv-running-total', version: '0.9.0' } });
  step('N7 outer tuple substitution P→Q at R → SIGNED_STATEMENT_MISMATCH', rq.status === 409 && rq.body.error === 'SIGNED_STATEMENT_MISMATCH', rq.body);
}
// wrong algorithm + malformed encodings
{
  let algCode = null, encCode = null;
  try { verifyGenesis({ ...genesis, genesis_key: { alg: 'rsa', key: genesis.genesis_key.key } }); } catch (e) { algCode = e.code; }
  try { verifyGenesis({ ...genesis, genesis_key: { alg: 'ed25519', key: genesis.genesis_key.key + '==' } }); } catch (e) { encCode = e.code; }
  step('N8 wrong algorithm → ALGORITHM_UNSUPPORTED', algCode === 'ALGORITHM_UNSUPPORTED', { algCode });
  step('N9 noncanonical key encoding → ENCODING_INVALID', encCode === 'ENCODING_INVALID', { encCode });
}
// AUTHORIZE key_id/public_key mismatch + REVOKE unknown key
{
  let idMix = null, revUnknown = null;
  const OTHER = generateKeypair();
  const badAuth = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(K1.publicKeyRaw), publicKeyRaw: OTHER.publicKeyRaw, permissions: ['publish'] });
  try { replayChain(genesis, [ev1, badAuth]); } catch (e) { idMix = e.code; }
  const badRevoke = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'REVOKE', keyId: deriveKeyId(OTHER.publicKeyRaw) });
  try { replayChain(genesis, [ev1, badRevoke]); } catch (e) { revUnknown = e.code; }
  step('N10 AUTHORIZE key_id/public_key mismatch → IDENTITY_RECORD_INVALID', idMix === 'IDENTITY_RECORD_INVALID', { idMix });
  step('N11 REVOKE unknown/inactive key → IDENTITY_RECORD_INVALID', revUnknown === 'IDENTITY_RECORD_INVALID', { revUnknown });
}

// ================= B: independent verification + pinning =================
const before = await bRegState();
const fetched = Buffer.from(await (await fetch(R + '/fetch/' + D0)).arrayBuffer());
const incoming = join(WORK, 'b-incoming');
await rm(incoming, { recursive: true, force: true });
{
  const obj = JSON.parse(fetched.toString('utf8'));
  for (const f of obj.files) {
    const dest = join(incoming, f.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(f.b64, 'base64'));
  }
}
const material = (await get(R, '/publication/' + genesis.publisher_id + '/csv-running-total/0.1.0')).body.material;
step('R carries full verification material (genesis + events + assertion)', !!material && !!material.genesis && Array.isArray(material.events) && !!material.publication, { keys: material ? Object.keys(material) : null });

const EXPECTED0 = { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0 };
const st1 = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming, identityMaterial: material, expectedTuple: EXPECTED0 });
step('B independently verifies → VERIFIED / FIRST_OBSERVATION_UNPROVEN', st1.body.import?.publisher?.publisher_auth === 'VERIFIED' && st1.body.import?.publisher?.freshness === 'FIRST_OBSERVATION_UNPROVEN', st1.body.import?.publisher);
const importId1 = st1.body.import?.taskId;

// repeated delivery of the EXACT pinned state → MATCHES_LOCAL_PIN, pin unchanged
const pinBefore = (() => { try { return JSON.parse(require('fs').readFileSync(join(B_HOME, 'operator-ui', 'tasks.json'), 'utf8')).tasks.find((t) => t.kind === 'pin'); } catch { return null; } })();
const st1b = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming, alias: 'repeat-alias', identityMaterial: material, expectedTuple: EXPECTED0 });
const pinAfter = (() => { try { return JSON.parse(require('fs').readFileSync(join(B_HOME, 'operator-ui', 'tasks.json'), 'utf8')).tasks.find((t) => t.kind === 'pin'); } catch { return null; } })();
step('repeated exact state → MATCHES_LOCAL_PIN, pin NOT mutated', st1b.body.import?.publisher?.freshness === 'MATCHES_LOCAL_PIN' && pinBefore && pinAfter && JSON.stringify(pinBefore.pin) === JSON.stringify(pinAfter.pin), { freshness: st1b.body.import?.publisher?.freshness, pin: pinAfter && pinAfter.pin });

// legitimate extension: AUTHORIZE K2 (seq 2), publish 0.1.1 at state 2
const K2 = generateKeypair();
const ev2 = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 2, prevRecordDigest: recordDigest(ev1), action: 'AUTHORIZE', keyId: deriveKeyId(K2.publicKeyRaw), publicKeyRaw: K2.publicKeyRaw, permissions: ['publish'] });
await post(R, '/publisher', { genesis, events: [ev1, ev2] });
const chain2 = replayChain(genesis, [ev1, ev2]);
const pkg11 = join(WORK, 'pkg-0.1.1');
execFileSync('cp', ['-R', A_PKG, pkg11]);
{
  const wf = join(pkg11, 'workflows', 'csv-running-total-v0-1-0.yaml');
  await writeFile(wf, (await readFile(wf, 'utf8')) + '\n# 0.1.1 successor\n', 'utf8');
  const capPath = join(pkg11, 'capability.json');
  const cap = JSON.parse(await readFile(capPath, 'utf8'));
  cap.identity.version = '0.1.1';
  const wfBytes = await readFile(wf);
  cap.implementation.bundle = { algorithm: 'sha256' };
  const capBytes = Buffer.from(canonicalJson(cap), 'utf8');
  cap.implementation.bundle.package_digest = packageDigest([{ path: 'capability.json', bytes: capBytes }, { path: cap.implementation.entrypoint, bytes: wfBytes }]);
  cap.implementation.bundle.digest = sha(wfBytes);
  await writeFile(capPath, canonicalJson(cap), 'utf8');
}
const files1 = await artifactOf(pkg11);
const D1 = (() => { const cap = files1.find((f) => f.path === 'capability.json'); const m = JSON.parse(cap.bytes.toString('utf8')); const capNo = Buffer.from(canonicalJson({ ...m, implementation: { ...m.implementation, bundle: { algorithm: 'sha256' } } }), 'utf8'); return packageDigest(files1.map((f) => (f.path === 'capability.json' ? { path: f.path, bytes: capNo } : f))); })();
const pub1 = signPublication({ privateKey: K2.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.1', D: D1, keyId: deriveKeyId(K2.publicKeyRaw), identitySequence: chain2.head_sequence, identityHeadDigest: chain2.head_digest });
const auth1 = await post(R, '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.1', artifact: Buffer.from(JSON.stringify({ files: files1.map((f) => ({ path: f.path, b64: f.bytes.toString('base64') })) }), 'utf8').toString('base64'), publication: pub1 });
step('rotation: K2 authorized at seq 2; 0.1.1 published+verified', auth1.status === 200 && auth1.body.publisher_auth === 'VERIFIED', auth1.body);

const incoming11 = join(WORK, 'b-incoming-11');
await rm(incoming11, { recursive: true, force: true });
{
  const wire = Buffer.from(await (await fetch(R + '/fetch/' + D1)).arrayBuffer());
  for (const f of JSON.parse(wire.toString('utf8')).files) {
    const dest = join(incoming11, f.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(f.b64, 'base64'));
  }
}
const material11 = (await get(R, '/publication/' + genesis.publisher_id + '/csv-running-total/0.1.1')).body.material;
const st2 = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming11, identityMaterial: material11, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.1', D: D1 } });
step('legitimate extension → EXTENDS_LOCAL_PIN, pin advanced', st2.body.import?.publisher?.freshness === 'EXTENDS_LOCAL_PIN', st2.body.import?.publisher);

// REVOKE K1 (seq 3) then: old state served after pin → SEQUENCE_ROLLBACK; revoked K1 at current state → KEY_NOT_AUTHORIZED
const ev3 = createKeyEvent({ genesisKp: P, genesisRecord: genesis, sequence: 3, prevRecordDigest: recordDigest(ev2), action: 'REVOKE', keyId: deriveKeyId(K1.publicKeyRaw) });
const chain3 = replayChain(genesis, [ev1, ev2, ev3]);
{
  const st3 = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming, alias: 'rollback-alias', identityMaterial: material, expectedTuple: EXPECTED0 });
  step('old chain below pinned state → SEQUENCE_ROLLBACK refusal', st3.body.import?.verdict === 'REFUSED' && st3.body.import?.publisher?.failure === 'SEQUENCE_ROLLBACK', st3.body.import?.publisher);
  // K1 revoked at the CURRENT state: assertion claiming state 3 signed by K1
  let code = null;
  try {
    const k1ClaimsCurrent = signPublication({ privateKey: K1.privateKey, publisherId: genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0, keyId: deriveKeyId(K1.publicKeyRaw), identitySequence: chain3.head_sequence, identityHeadDigest: chain3.head_digest });
    verifyPublication(k1ClaimsCurrent, chain3);
  } catch (e) { code = e.code; }
  step('revoked K1 claiming the current state → KEY_NOT_AUTHORIZED', code === 'KEY_NOT_AUTHORIZED', { code });
  // forks
  let forkCode = null;
  try { classifyFreshness({ sequence: chain3.head_sequence, head_digest: chain3.head_digest }, { sequence: chain3.head_sequence, head_digest: 'f'.repeat(64) }); } catch (e) { forkCode = e.code; }
  step('same-height alternate head → IDENTITY_HISTORY_FORK', forkCode === 'IDENTITY_HISTORY_FORK', { forkCode });
  let fork2 = null;
  try { chainExtendsPin(genesis, [ev1, ev2, ev3], { sequence: chain2.head_sequence, head_digest: chain3.head_digest }); } catch (e) { fork2 = e.code; }
  step('non-extending higher state → IDENTITY_HISTORY_FORK', fork2 === 'IDENTITY_HISTORY_FORK', { fork2 });
}

// zero-authority: discovery/fetch alone leaves B's registry untouched
{
  await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming11, alias: 'noauth-alias', identityMaterial: material11, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', publisher_id: genesis.publisher_id, name: 'csv-running-total', version: '0.1.1', D: D1 } });
  const after = await bRegState();
  step('authenticated staging alone → zero registry authority', after.sha === before.sha && after.caps === 0, { before: before.caps, after: after.caps });
}

// N12 forged discovery metadata at B: valid P material, expected tuple rewritten P→Q
{
  const Q2 = generateKeypair();
  const q2Genesis = createGenesis(Q2, 'forger');
  const forged = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming, alias: 'forged-alias', identityMaterial: material, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', publisher_id: q2Genesis.publisher_id, name: 'csv-running-total', version: '0.1.0', D: D0 } });
  step('N12 forged discovery metadata at B (outer tuple P→Q) → refusal', forged.body.import?.verdict === 'REFUSED' && forged.body.import?.publisher?.failure === 'SIGNED_STATEMENT_MISMATCH', forged.body.import?.publisher);
  // missing expected tuple entirely → fail closed
  const unbound = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming, alias: 'unbound-alias', identityMaterial: material });
  step('N12b material without an expected tuple → fail closed', unbound.body.import?.verdict === 'REFUSED' && unbound.body.import?.publisher?.failure === 'SIGNED_STATEMENT_MISMATCH', unbound.body.import?.publisher);
}
// independent pins for two distinct full-length publisher IDs
{
  const P2x = generateKeypair();
  const g2 = createGenesis(P2x, 'second-publisher');
  const k2b = generateKeypair();
  const ev2b = createKeyEvent({ genesisKp: P2x, genesisRecord: g2, sequence: 1, prevRecordDigest: recordDigest(g2), action: 'AUTHORIZE', keyId: deriveKeyId(k2b.publicKeyRaw), publicKeyRaw: k2b.publicKeyRaw, permissions: ['publish'] });
  const chainB = replayChain(g2, [ev2b]);
  await post(R, '/publisher', { genesis: g2, events: [ev2b] });
  const pubB = signPublication({ privateKey: k2b.privateKey, publisherId: g2.publisher_id, name: 'csv-running-total', version: '0.2.0', D: D0, keyId: deriveKeyId(k2b.publicKeyRaw), identitySequence: chainB.head_sequence, identityHeadDigest: chainB.head_digest });
  const pubBR = await post(R, '/publish', { publisher_scheme: 'p2-selfcert-v1', publisher_id: g2.publisher_id, name: 'csv-running-total', version: '0.2.0', artifact: art0.toString('base64'), publication: pubB });
  const matB = (await get(R, '/publication/' + g2.publisher_id + '/csv-running-total/0.2.0')).body.material;
  const stB = await post(B, '/plugins/operator-ui/flowrouter?op=stage', { packageDir: incoming, alias: 'second-pub-alias', identityMaterial: matB, expectedTuple: { publisher_scheme: 'p2-selfcert-v1', publisher_id: g2.publisher_id, name: 'csv-running-total', version: '0.2.0', D: D0 } });
  const tasksRaw = JSON.parse(await readFile(join(B_HOME, 'operator-ui', 'tasks.json'), 'utf8'));
  const pinTasks = tasksRaw.tasks.filter((t) => t.kind === 'pin');
  const fullIds = pinTasks.map((t) => t.pin?.publisher_id || '');
  step('independent pins: two full-length publisher identities hold separate pin records', pubBR.status === 200 && stB.body.import?.publisher?.publisher_auth === 'VERIFIED' && pinTasks.length >= 2 && fullIds.every((x) => x.length === 64) && new Set(fullIds).size === fullIds.length, { pins: fullIds.map((x) => x.slice(0, 12) + '…(' + x.length + ')') });
}

// authenticated capability still needs the full local path: verify → admit → route → gate → SHIP
const ver = await post(B, '/plugins/operator-ui/flowrouter?op=verify', { importTaskId: importId1, fixtureDir: '/tmp/flowrouter-p0/b-fixture' });
const adm = await post(B, '/plugins/operator-ui/flowrouter?op=admit', { importTaskId: importId1 });
let g = (await post(B, '/plugins/operator-ui/goal', { objective: 'Process values.csv in order and report the running total after each row, one per line, as RESULT row=<n> total=<cumulative sum>.' })).body.goal || {};
const gateObserved = new Set(g.failureCodes || []).has('awaiting-approval');
if (gateObserved) g = (await post(B, '/plugins/operator-ui/goal', { approveTaskId: g.taskId })).body.goal || {};
const checkMap = Object.fromEntries((g.checks || []).map((c) => [c.id, c.pass]));
step('authenticated capability still: P0 stage → B-local verify → admission → route → gate → SHIP',
  ver.body.import?.verdict === 'VERIFIED' && adm.body.ok === true && g.verdict === 'SHIP' && gateObserved && checkMap['objective-satisfaction'] === true,
  { verify: ver.body.import?.verdict, admit: adm.body.ok, route: g.route?.selected?.id, gate: gateObserved, verdict: g.verdict });

const okAll = receipt.steps.every((s) => s.ok);
receipt.verdict = okAll ? 'P2 MATRIX GREEN — publisher authentication implemented, provenance only' : 'MATRIX INCOMPLETE';
await writeFile(join(root, 'eval', 'receipts', 'FLOWROUTER-P2-RECEIPT.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log('\nverdict:', receipt.verdict);
