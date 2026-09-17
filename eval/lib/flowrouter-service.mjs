#!/usr/bin/env node
// eval/lib/flowrouter-service.mjs — FlowRouter service R (P1 network
// primitive, spec v2 / commit 874e148). The smallest possible network
// around the P0 artifact. ZERO authority to make anything routable.
//
// Storage (all under --store):
//   publications.jsonl   immutable append-once binding records:
//                        {publisher_id, name, version, D, published_at}
//                        — AUTHORITATIVE for discovery (§3)
//   blobs/<D>.pkg        the stored package artifact (canonical byte
//                        serialization of the P0 package file list)
//   index.json           DERIVED, rebuildable cache (never authority)
//
// Semantics implemented exactly per the frozen spec:
// §1 vocabulary: publisher_id/name/version canonical lowercase tokens,
//    noncanonical REJECTED (never normalized); version exact string.
// §2 transactional publish: R recomputes the P0 digest itself; blob
//    stored BEFORE the binding commits; same-D idempotent; different-D
//    PUBLISH_CONFLICT; published_at created once, index rebuilds copy it.
// §3 discovery: every returned binding validated against the immutable
//    record; mismatch → INDEX_METADATA_STALE or record truth; forged
//    index metadata NEVER served as package truth.
// §4 fetch: GET /fetch/:D returns the stored artifact; D is the P0 digest.
// §5 failures: PUBLISH_CONFLICT · PUBLISH_INVALID · PACKAGE_MALFORMED ·
//    IDENTITY_NONCANONICAL · IDENTITY_VERSION_MISMATCH ·
//    FETCH_DIGEST_MISMATCH · FETCH_UNAVAILABLE · INDEX_METADATA_STALE ·
//    NETWORK_FAILURE · SERVICE_UNAVAILABLE. No path substitutes bytes.
//
// Artifact format: canonical JSON {files:[{path, b64}]} with files sorted
// by path — a byte-exact serialization of the package file list. The P0
// digest rule is the ONLY digest rule: extraction → P0 recomputation.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyGenesis, replayChain, verifyPublication, recordDigest } from '../../lib/identity.js';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argOf('--port', 13093));
const STORE = argOf('--store', '/tmp/flowrouter-R');
const BLOBS = join(STORE, 'blobs');
const PUBS = join(STORE, 'publications.jsonl');
const INDEX = join(STORE, 'index.json');
const PUBLISHERS = join(STORE, 'publishers');

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const nowIso = () => new Date().toISOString();

// ---- frozen P0 digest rule (identical to lib/flowrouter.js) ----
function canonicalJson(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}
function packageDigest(files) {
  const list = files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\n${f.bytes.length}\n${sha256(f.bytes)}\n`).join('');
  return sha256(Buffer.from(list, 'utf8'));
}
// artifact bytes → file list (byte-exact)
function artifactToFiles(artifactBytes) {
  const obj = JSON.parse(artifactBytes.toString('utf8'));
  if (!obj || !Array.isArray(obj.files)) throw new Error('not an artifact');
  return obj.files.map((f) => ({ path: String(f.path), bytes: Buffer.from(String(f.b64), 'base64') }));
}
// P0 digest over an artifact: capability.json canonicalized with digest
// fields omitted (amendment-1 rule), other files byte-exact.
function artifactDigest(files) {
  const capFile = files.find((f) => f.path === 'capability.json');
  if (!capFile) throw new Error('artifact lacks capability.json');
  const manifest = JSON.parse(capFile.bytes.toString('utf8'));
  const bundle = (manifest.implementation && manifest.implementation.bundle) || {};
  const capNoDigest = Buffer.from(canonicalJson({
    ...manifest,
    implementation: { ...(manifest.implementation || {}), bundle: { algorithm: bundle.algorithm || 'sha256' } },
  }), 'utf8');
  return packageDigest(files.map((f) => (f.path === 'capability.json' ? { path: f.path, bytes: capNoDigest } : f)));
}

const CANON = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VER = /^\d+\.\d+\.\d+$/;

let publications = [];   // [{publisher_id, name, version, D, published_at}]
let index = [];          // derived entries

let publishers = {}; // publisher_id -> { genesis, events: [] }
async function loadState() {
  await mkdir(BLOBS, { recursive: true });
  await mkdir(PUBLISHERS, { recursive: true });
  try {
    const { readdir: rd } = await import('node:fs/promises');
    for (const f of await rd(PUBLISHERS)) {
      if (!f.endsWith('.json')) continue;
      const rec = JSON.parse(await readFile(join(PUBLISHERS, f), 'utf8'));
      publishers[rec.genesis.publisher_id] = rec;
    }
  } catch { publishers = {}; }
  try {
    publications = (await readFile(PUBS, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { publications = []; }
  try { index = JSON.parse(await readFile(INDEX, 'utf8')); } catch { index = []; }
}
async function commitPublication(rec) {
  // durable FIRST: the in-memory authoritative array only reflects what is
  // actually on disk (a failed append must never leave memory ahead of disk)
  await appendFile(PUBS, JSON.stringify(rec) + '\n', 'utf8');
  publications.push(rec);
}

// publishes are serialized through a lock: the findPub → blob → bind critical
// section must not interleave across concurrent requests (two different bytes
// for an unbound package_ref must never both commit)
let publishChain = Promise.resolve();
function withPublishLock(fn) {
  const p = publishChain.then(fn, fn);
  publishChain = p.then(() => {}, () => {});
  return p;
}
async function writeIndex() {
  await writeFile(INDEX, JSON.stringify(index, null, 2) + '\n', 'utf8');
}
const findPub = (p, n, v, scheme) => publications.find((r) => r.publisher_id === p && r.name === n && r.version === v && (scheme ? r.publisher_scheme === scheme : true));

// rebuild the derived index from authoritative records (copies published_at)
async function rebuildIndex() {
  const out = [];
  for (const rec of publications) {
    let meta = { kind: null, task_signatures: [], tags: [], compatibility: [], publisher: rec.publisher_id, evidence_summary: null };
    try {
      const files = artifactToFiles(await readFile(join(BLOBS, rec.D + '.pkg')));
      const m = JSON.parse(files.find((f) => f.path === 'capability.json').bytes.toString('utf8'));
      meta = {
        kind: (m.identity || {}).kind || null,
        task_signatures: ((m.routing || {}).task_signatures || []).slice(0, 32),
        tags: ((m.routing || {}).task_signatures || []).slice(0, 32),
        compatibility: (m.routing || {}).compatibility || [],
        publisher: ((m.identity || {}).publisher || {}).name || rec.publisher_id,
        evidence_summary: { verdicts: ((m.evidence || {}).verdicts || []).length, reported: true },
      };
    } catch { /* record without readable blob — index entry stays minimal */ }
    out.push({ publisher_scheme: rec.publisher_scheme || 'p1-configured-v1', publisher_id: rec.publisher_id, name: rec.name, version: rec.version, D: rec.D, published_at: rec.published_at, publisher_auth: rec.publisher_auth || 'UNAUTHENTICATED', ...meta });
  }
  index = out;
  await writeIndex();
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

await loadState();
await rebuildIndex();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // ---------------- POST /publisher ----------------
    if (req.method === 'POST' && url.pathname === '/publisher') {
      const chunks2 = [];
      for await (const c of req) { chunks2.push(c); if (Buffer.concat(chunks2).length > 400_000) return json(res, 413, { error: 'too large' }); }
      const { genesis, events } = JSON.parse(Buffer.concat(chunks2).toString('utf8') || '{}');
      let chain;
      try {
        chain = replayChain(genesis, events || []); // verify before storing
      } catch (e) {
        return json(res, 409, { error: e.code || 'IDENTITY_RECORD_INVALID', reason: String(e.message).slice(0, 200) });
      }
      publishers[genesis.publisher_id] = { genesis, events: events || [] };
      await writeFile(join(PUBLISHERS, genesis.publisher_id + '.json'), JSON.stringify(publishers[genesis.publisher_id], null, 2) + '\n', 'utf8');
      // report the VERIFIED chain's actual head (genesis = state 0)
      return json(res, 200, { publisher_id: genesis.publisher_id, head_sequence: chain.head_sequence, head_digest: chain.head_digest });
    }

    // ---------------- POST /publish ----------------
    if (req.method === 'POST' && url.pathname === '/publish') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      // (identity path handled below when publication material is present)
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { return json(res, 400, { error: 'PUBLISH_INVALID', reason: 'body is not valid JSON' }); }
      const { publisher_id, name, version } = parsed;
      if (typeof publisher_id !== 'string' || !CANON.test(publisher_id)) return json(res, 400, { error: 'IDENTITY_NONCANONICAL', reason: 'publisher_id must match ' + CANON });
      if (typeof name !== 'string' || !CANON.test(name)) return json(res, 400, { error: 'IDENTITY_NONCANONICAL', reason: 'name must match ' + CANON });
      if (typeof version !== 'string' || !VER.test(version)) return json(res, 400, { error: 'IDENTITY_NONCANONICAL', reason: 'version must match ' + VER });
      if (typeof parsed.artifact !== 'string') return json(res, 400, { error: 'PUBLISH_INVALID', reason: 'artifact (base64) required' });
      const artifactBytes = Buffer.from(parsed.artifact, 'base64');

      // R recomputes the P0 digest ITSELF
      let files;
      try { files = artifactToFiles(artifactBytes); } catch { return json(res, 400, { error: 'PACKAGE_MALFORMED', reason: 'artifact does not parse' }); }
      let D;
      try { D = artifactDigest(files); } catch (e) { return json(res, 400, { error: 'PACKAGE_MALFORMED', reason: String(e.message) }); }

      // in-package identity agreement: LEGACY scheme only. Under
      // p2-selfcert-v1 the package's P0 identity.id is exporter metadata —
      // the authenticated identity comes from the SIGNED assertion (§7),
      // which is checked (incl. name/version) further below.
      const reqScheme = parsed.publisher_scheme || 'p1-configured-v1';
      if (reqScheme === 'p1-configured-v1') {
        try {
          const m = JSON.parse(files.find((f) => f.path === 'capability.json').bytes.toString('utf8'));
          const id = (m.identity || {}).id || '';
          const ver = (m.identity || {}).version || '';
          const expectedId = publisher_id + '/' + name;
          if (id && id !== expectedId) return json(res, 409, { error: 'IDENTITY_VERSION_MISMATCH', reason: `package identity ${id} ≠ ${expectedId}` });
          if (ver && ver !== version) return json(res, 409, { error: 'IDENTITY_VERSION_MISMATCH', reason: `package version ${ver} ≠ ${version}` });
        } catch { return json(res, 400, { error: 'PACKAGE_MALFORMED', reason: 'capability.json unreadable' }); }
      } else {
        try { JSON.parse(files.find((f) => f.path === 'capability.json').bytes.toString('utf8')); } catch { return json(res, 400, { error: 'PACKAGE_MALFORMED', reason: 'capability.json unreadable' }); }
      }

      return await withPublishLock(async () => {
        const existing = findPub(publisher_id, name, version, reqScheme);

        // ---- P2 authenticated binding (spec v3): verify BEFORE publishing.
        // A supplied assertion is ALWAYS verified — even when the binding
        // already exists — so an invalid assertion can never ride an
        // idempotent/no-op path.
        let auth = { publisher_auth: 'UNAUTHENTICATED', material: null };
        if (reqScheme === 'p2-selfcert-v1') {
          const assertion = parsed.publication;
          // ---- frozen structured-tuple identity: the request must be
          // FIELDWISE EQUAL to the signed statement; the binding committed is
          // the SIGNED tuple, never an outer-request override. ----
          const tupleMismatch = (why) => { writeFile(join(BLOBS, D + '.pkg'), artifactBytes); return json(res, 409, { error: 'SIGNED_STATEMENT_MISMATCH', reason: why + ' (no P2 binding created; raw blob retained)' }); };
          if (!assertion) {
            await writeFile(join(BLOBS, D + '.pkg'), artifactBytes);
            return json(res, 409, { error: 'PUBLISHER_AUTH_INVALID', reason: 'missing publication assertion for a p2-selfcert publication (no P2 binding created; raw blob retained)' });
          }
          if (assertion.publisher_scheme !== 'p2-selfcert-v1' || reqScheme !== assertion.publisher_scheme) return tupleMismatch('scheme mismatch');
          if (publisher_id !== assertion.publisher_id) return tupleMismatch('request.publisher_id does not equal assertion.publisher_id');
          if (name !== assertion.name) return tupleMismatch('request.name does not equal assertion.name');
          if (version !== assertion.version) return tupleMismatch('request.version does not equal assertion.version');
          if (assertion.D !== D) return tupleMismatch('assertion.D does not match the recomputed package digest');
          const stored = publishers[assertion.publisher_id];
          if (!stored) {
            await writeFile(join(BLOBS, D + '.pkg'), artifactBytes);
            return json(res, 409, { error: 'PUBLISHER_AUTH_INVALID', reason: 'unknown publisher (no P2 binding created; raw blob retained)' });
          }
          let chain, vp;
          try {
            chain = replayChain(stored.genesis, stored.events);
            if (stored.genesis.publisher_id !== assertion.publisher_id) throw Object.assign(new Error('verified genesis publisher_id does not equal assertion.publisher_id'), { code: 'SIGNED_STATEMENT_MISMATCH' });
            vp = verifyPublication(assertion, chain);
          } catch (e) {
            await writeFile(join(BLOBS, D + '.pkg'), artifactBytes);
            return json(res, 409, { error: e.code || 'PUBLISHER_AUTH_INVALID', reason: String(e.message).slice(0, 200) });
          }
          auth = { publisher_auth: 'VERIFIED', material: { genesis: stored.genesis, events: stored.events, publication: assertion } };
        }

        if (existing) {
          if (existing.D === D) return json(res, 200, { publisher_scheme: reqScheme, publisher_id, name, version, D, publisher_auth: existing.publisher_auth || 'UNAUTHENTICATED', idempotent: true });
          return json(res, 409, { error: 'PUBLISH_CONFLICT', reason: `package_ref already bound to ${existing.D}` });
        }

        // blob FIRST, binding second (crash → orphan blob, never binding-to-absent).
        // For p2-selfcert the committed tuple is the SIGNED one (already
        // proven fieldwise-equal to the request above).
        const bindingTuple = auth.material
          ? { publisher_scheme: auth.material.publication.publisher_scheme, publisher_id: auth.material.publication.publisher_id, name: auth.material.publication.name, version: auth.material.publication.version, D: auth.material.publication.D }
          : { publisher_scheme: reqScheme, publisher_id, name, version, D };
        await writeFile(join(BLOBS, D + '.pkg'), artifactBytes);
        await commitPublication({ ...bindingTuple, published_at: nowIso(), ...auth });
        await rebuildIndex();
        return json(res, 200, { ...bindingTuple, publisher_auth: auth.publisher_auth });
      });
    }

    // ---------------- GET /status ----------------
    if (req.method === 'GET' && url.pathname === '/status') {
      let blobs = 0;
      try { blobs = (await readdir(BLOBS)).filter((f) => f.endsWith('.pkg')).length; } catch {}
      return json(res, 200, { publications: publications.length, blobs });
    }

    // ---------------- GET /publication/:p/:n/:v ----------------
    const pubMatch = url.pathname.match(/^\/publication\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (req.method === 'GET' && pubMatch) {
      // frozen rule: URL aliases/escapes are REJECTED, never normalized —
      // any percent-encoding in an identity segment is noncanonical input.
      const rawSegs = [pubMatch[1], pubMatch[2], pubMatch[3]];
      if (rawSegs.some((seg) => /%[0-9A-Fa-f]{2}/.test(seg))) {
        return json(res, 400, { error: 'IDENTITY_NONCANONICAL', reason: 'percent-encoded identity segments are rejected, never normalized' });
      }
      const p1 = decodeURIComponent(pubMatch[1]), n1 = decodeURIComponent(pubMatch[2]), v1 = decodeURIComponent(pubMatch[3]);
      if (!CANON.test(p1) || !CANON.test(n1) || !VER.test(v1)) {
        return json(res, 400, { error: 'IDENTITY_NONCANONICAL', reason: 'components must be canonical (reject-not-normalize)' });
      }
      const schemeQ = url.searchParams.get('scheme') || null;
      const rec = findPub(p1, n1, v1, schemeQ);
      if (!rec) return json(res, 404, { error: 'FETCH_UNAVAILABLE', reason: 'no publication record' });
      return json(res, 200, { publisher_scheme: rec.publisher_scheme || 'p1-configured-v1', publisher_id: rec.publisher_id, name: rec.name, version: rec.version, D: rec.D, publisher_auth: rec.publisher_auth || 'UNAUTHENTICATED', material: rec.material || null });
    }

    // ---------------- GET /discover ----------------
    if (req.method === 'GET' && url.pathname === '/discover') {
      const q = url.searchParams;
      // RAW query check first: percent-encoded canonical params are rejected
      // before any decoding (reject-not-normalize, same rule as publish).
      {
        const raw = url.search || '';
        for (const key of ['publisher', 'name', 'version']) {
          const m2 = raw.match(new RegExp('[?&]' + key + '=([^&]*)'));
          if (m2 && /%[0-9A-Fa-f]{2}/.test(m2[1])) {
            return json(res, 400, { error: 'IDENTITY_NONCANONICAL', reason: `${key} is percent-encoded — rejected, never normalized` });
          }
        }
      }
      // canonical query values only (reject-not-normalize, same as publish)
      for (const [key, re] of [['publisher', CANON], ['name', CANON], ['version', VER]]) {
        const v = q.get(key);
        if (v !== null && !re.test(v)) return json(res, 400, { error: 'IDENTITY_NONCANONICAL', reason: `${key} must be canonical` });
      }
      // frozen compatibility filter: INTERSECTION between the declared
      // compatibility list and the query's comma-separated list.
      const compatQ = q.get('compatibility');
      const compatList = compatQ ? compatQ.split(',').map((x) => x.trim()).filter(Boolean) : null;
      // The index is a DERIVED cache, not authority: read it fresh (a stale
      // or forged cache file must flow through the §3 validation below).
      let cache = index;
      try { cache = JSON.parse(await readFile(INDEX, 'utf8')); } catch { /* keep in-memory */ }
      const results = [];
      for (const e of cache) {
        if (q.get('publisher') && e.publisher_id !== q.get('publisher')) continue;
        if (q.get('name') && e.name !== q.get('name')) continue;
        if (q.get('version') && e.version !== q.get('version')) continue;
        if (q.get('kind') && e.kind !== q.get('kind')) continue;
        if (q.get('tag') && !(e.tags || []).includes(q.get('tag'))) continue;
        if (q.get('task_signature') && !(e.task_signatures || []).includes(q.get('task_signature'))) continue;
        if (q.get('has_evidence') === 'true' && !e.evidence_summary) continue;
        if (compatList && !(e.compatibility || []).some((c) => compatList.includes(c))) continue;
        // §3 RECORDS AUTHORITATIVE: validate the binding before returning it
        const rec = findPub(e.publisher_id, e.name, e.version, e.publisher_scheme);
        if (!rec) {
          // ghost: diagnostic only — never expose a fetch-authorizing digest
          results.push({ ...e, D: null, truth: 'INDEX_METADATA_STALE', diagnostic: true, reason: 'no publication record — entry is not package truth' });
          continue;
        }
        if (rec.D !== e.D) { results.push({ ...e, D: rec.D, truth: 'INDEX_METADATA_STALE', reason: 'index digest disagreed with the immutable record — serving record truth' }); continue; }
        results.push({ ...e, truth: 'RECORD', publisher_auth: rec.publisher_auth || 'UNAUTHENTICATED', material: rec.material || null });
      }
      // frozen ordering: publisher_id, then name, then version (component-wise)
      results.sort((a, b) =>
        a.publisher_id < b.publisher_id ? -1 : a.publisher_id > b.publisher_id ? 1
        : a.name < b.name ? -1 : a.name > b.name ? 1
        : a.version < b.version ? -1 : a.version > b.version ? 1 : 0);
      return json(res, 200, { results });
    }

    // ---------------- GET /fetch/:D ----------------
    const fetchMatch = url.pathname.match(/^\/fetch\/([a-f0-9]{64})$/);
    if (req.method === 'GET' && fetchMatch) {
      try {
        const bytes = await readFile(join(BLOBS, fetchMatch[1] + '.pkg'));
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(bytes);
      } catch {
        return json(res, 404, { error: 'FETCH_UNAVAILABLE', reason: 'no blob for ' + fetchMatch[1] });
      }
    }

    json(res, 404, { error: 'NOT_FOUND' });
  } catch (e) {
    json(res, 500, { error: 'SERVICE_UNAVAILABLE', reason: String(e && e.message || e).slice(0, 200) });
  }
});

server.listen(PORT, () => console.log(`flowrouter R on :${PORT} (store ${STORE})`));
