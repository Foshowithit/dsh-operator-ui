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

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argOf('--port', 13093));
const STORE = argOf('--store', '/tmp/flowrouter-R');
const BLOBS = join(STORE, 'blobs');
const PUBS = join(STORE, 'publications.jsonl');
const INDEX = join(STORE, 'index.json');

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

async function loadState() {
  await mkdir(BLOBS, { recursive: true });
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
const findPub = (p, n, v) => publications.find((r) => r.publisher_id === p && r.name === n && r.version === v);

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
    out.push({ publisher_id: rec.publisher_id, name: rec.name, version: rec.version, D: rec.D, published_at: rec.published_at, ...meta });
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
    // ---------------- POST /publish ----------------
    if (req.method === 'POST' && url.pathname === '/publish') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
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

      // in-package identity must agree with the requested ref
      try {
        const m = JSON.parse(files.find((f) => f.path === 'capability.json').bytes.toString('utf8'));
        const id = (m.identity || {}).id || '';
        const ver = (m.identity || {}).version || '';
        const expectedId = publisher_id + '/' + name;
        if (id && id !== expectedId) return json(res, 409, { error: 'IDENTITY_VERSION_MISMATCH', reason: `package identity ${id} ≠ ${expectedId}` });
        if (ver && ver !== version) return json(res, 409, { error: 'IDENTITY_VERSION_MISMATCH', reason: `package version ${ver} ≠ ${version}` });
      } catch { return json(res, 400, { error: 'PACKAGE_MALFORMED', reason: 'capability.json unreadable' }); }

      return await withPublishLock(async () => {
        const existing = findPub(publisher_id, name, version);
        if (existing) {
          if (existing.D === D) return json(res, 200, { publisher_id, name, version, D, idempotent: true });
          return json(res, 409, { error: 'PUBLISH_CONFLICT', reason: `package_ref already bound to ${existing.D}` });
        }
        // blob FIRST, binding second (crash → orphan blob, never binding-to-absent)
        await writeFile(join(BLOBS, D + '.pkg'), artifactBytes);
        await commitPublication({ publisher_id, name, version, D, published_at: nowIso() });
        await rebuildIndex();
        return json(res, 200, { publisher_id, name, version, D });
      });
    }

    // ---------------- GET /publication/:p/:n/:v ----------------
    const pubMatch = url.pathname.match(/^\/publication\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (req.method === 'GET' && pubMatch) {
      const p1 = decodeURIComponent(pubMatch[1]), n1 = decodeURIComponent(pubMatch[2]), v1 = decodeURIComponent(pubMatch[3]);
      if (!CANON.test(p1) || !CANON.test(n1) || !VER.test(v1)) {
        return json(res, 400, { error: 'IDENTITY_NONCANONICAL', reason: 'components must be canonical (reject-not-normalize)' });
      }
      const rec = findPub(p1, n1, v1);
      if (!rec) return json(res, 404, { error: 'FETCH_UNAVAILABLE', reason: 'no publication record' });
      return json(res, 200, { publisher_id: rec.publisher_id, name: rec.name, version: rec.version, D: rec.D });
    }

    // ---------------- GET /discover ----------------
    if (req.method === 'GET' && url.pathname === '/discover') {
      const q = url.searchParams;
      // canonical query values only (reject-not-normalize, same as publish)
      for (const [key, re] of [['publisher', CANON], ['name', CANON], ['version', VER]]) {
        const v = q.get(key);
        if (v !== null && !re.test(v)) return json(res, 400, { error: 'IDENTITY_NONCANONICAL', reason: `${key} must be canonical` });
      }
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
        // §3 RECORDS AUTHORITATIVE: validate the binding before returning it
        const rec = findPub(e.publisher_id, e.name, e.version);
        if (!rec) {
          // ghost: diagnostic only — never expose a fetch-authorizing digest
          results.push({ ...e, D: null, truth: 'INDEX_METADATA_STALE', diagnostic: true, reason: 'no publication record — entry is not package truth' });
          continue;
        }
        if (rec.D !== e.D) { results.push({ ...e, D: rec.D, truth: 'INDEX_METADATA_STALE', reason: 'index digest disagreed with the immutable record — serving record truth' }); continue; }
        results.push({ ...e, truth: 'RECORD' });
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
