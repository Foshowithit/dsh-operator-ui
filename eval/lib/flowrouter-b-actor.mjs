#!/usr/bin/env node
// eval/lib/flowrouter-b-actor.mjs — minimal B-actor host (P1-X): runs the
// EXACT production RCOS modules (lib/flowrouter.js, lib/goal.js,
// lib/tasks.js, lib/config.js, lib/authority.js — all plain Node ESM with
// no DSH-host dependencies) in a small HTTP host process on an independent
// machine. This is B's side of the P1-X independent-executor receipt.
//
// B-local responsibilities (all executed ON B):
//   /machine          machine + process identity evidence
//   /bstate           registry + task-store state (nonmutation checks)
//   /fetch-stage      network-fetch a package from R by digest, recompute
//                     the P0 digest B-side, extract B-local, stage it —
//                     the capability artifact crosses ONLY via the network
//   /make-fixture     author a B-local verification fixture + hash it on B
//   /verify /admit    production verifyImport / admitImport
//   /goal             production runGoal (route → authority gate → execute
//                     → objective evaluation → verdict), /goal approve
//
// Config comes from RCOS_HOME/operator-ui.config.json (B-local paths; the
// executor baseUrl points at B's own runner).

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname, platform, release } from 'node:os';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(argOf('--port', 8415));
const REPO = argOf('--repo', process.env.P1X_REPO || process.cwd());
process.env.DSH_HOME = argOf('--home', process.env.DSH_HOME || process.env.P1X_HOME);

const { stagePackage, verifyImport, admitImport } = await import(join(REPO, 'lib', 'flowrouter.js'));
const { runGoal } = await import(join(REPO, 'lib', 'goal.js'));
const { resolveConfig } = await import(join(REPO, 'lib', 'config.js'));

const cfgRes = resolveConfig();
const cfg = cfgRes.config || {};
const sha = (b) => createHash('sha256').update(b).digest('hex');

// frozen P0 digest rule (local copy — identical to lib/flowrouter.js)
function canonicalJson(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = walk(v[k]); return o; }
    return v;
  };
  return JSON.stringify(walk(value));
}
function packageDigest(files) {
  const list = files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\n${f.bytes.length}\n${sha(f.bytes)}\n`).join('');
  return sha(Buffer.from(list, 'utf8'));
}
function p0DigestOf(files) {
  const cap = files.find((f) => f.path === 'capability.json');
  const m = JSON.parse(cap.bytes.toString('utf8'));
  const bundle = (m.implementation && m.implementation.bundle) || {};
  const capNo = Buffer.from(canonicalJson({ ...m, implementation: { ...(m.implementation || {}), bundle: { algorithm: bundle.algorithm || 'sha256' } } }), 'utf8');
  return packageDigest(files.map((f) => (f.path === 'capability.json' ? { path: f.path, bytes: capNo } : f)));
}

async function bstate() {
  const regRaw = await readFile(cfg.registry.path).catch(() => Buffer.from('{}'));
  let taskRaw = '';
  try { taskRaw = await readFile(join(process.env.DSH_HOME, 'operator-ui', 'tasks.json'), 'utf8'); } catch {}
  let imports = 0;
  try { imports = (JSON.parse(taskRaw).tasks || []).filter((t) => t.kind === 'import').length; } catch {}
  return {
    registry_sha: sha(regRaw), registry_caps: (JSON.parse(regRaw.toString('utf8')).capabilities || []).length,
    taskstore_sha: sha(Buffer.from(taskRaw, 'utf8')), import_tasks: imports,
  };
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    let body = null;
    if (req.method === 'POST') { body = ''; for await (const c of req) { body += c; if (body.length > 4_000_000) return json(res, 413, { error: 'too large' }); } try { body = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); } }

    if (req.method === 'GET' && url.pathname === '/machine') {
      return json(res, 200, {
        hostname: hostname(), platform: platform(), release: release(),
        node: process.version, pid: process.pid,
        registry_path: cfg.registry.path,
        teaching: cfg.teaching,
        executor: cfg.archon && cfg.archon.baseUrl,
        home: process.env.DSH_HOME,
      });
    }
    if (req.method === 'GET' && url.pathname === '/bstate') return json(res, 200, await bstate());

    if (req.method === 'POST' && url.pathname === '/reset') {
      // receipt-harness only: return B to a genuinely empty consumer state
      await writeFile(cfg.registry.path, JSON.stringify({ registry_version: 'rcos-public-v1', capabilities: [] }, null, 2) + '\n', 'utf8');
      await writeFile(join(process.env.DSH_HOME, 'operator-ui', 'tasks.json'), JSON.stringify({ schema: 1, tasks: [] }, null, 2) + '\n', 'utf8');
      return json(res, 200, { reset: true, ...(await bstate()) });
    }

    if (req.method === 'POST' && url.pathname === '/discover') {
      // B-side discovery THROUGH THE NETWORK: the Dell asks R directly.
      const { rUrl, publisher, name, version } = body;
      const qs = new URLSearchParams();
      if (publisher) qs.set('publisher', publisher);
      if (name) qs.set('name', name);
      if (version) qs.set('version', version);
      const r2 = await fetch(rUrl.replace(/\/$/, '') + '/discover?' + qs.toString());
      const d2 = await r2.json();
      return json(res, r2.status, { discovered_from: rUrl, queried: Object.fromEntries(qs), ...d2 });
    }

    if (req.method === 'POST' && url.pathname === '/fetch-digest') {
      // fetch by digest over the network + recompute B-side, no staging
      const { rUrl, D } = body;
      const r3 = await fetch(rUrl.replace(/\/$/, '') + '/fetch/' + D);
      if (!r3.ok) return json(res, r3.status, { error: 'FETCH_UNAVAILABLE', fetched_from: rUrl, requested_D: D });
      const wire = Buffer.from(await r3.arrayBuffer());
      const obj = JSON.parse(wire.toString('utf8'));
      const files = obj.files.map((f) => ({ path: f.path, bytes: Buffer.from(f.b64, 'base64') }));
      const recomputed = p0DigestOf(files);
      return json(res, 200, { fetched_from: rUrl, requested_D: D, recomputed_D: recomputed, matches: recomputed === D });
    }

    if (req.method === 'POST' && url.pathname === '/fetch-corrupt-stage') {
      // N-negative: fetch over the network, corrupt ONE workflow byte B-side,
      // recompute B-side, refuse with FETCH_DIGEST_MISMATCH before any stage.
      const { rUrl, D, alias } = body;
      const impBefore = (await bstate()).import_tasks;
      const wire = Buffer.from(await (await fetch(rUrl.replace(/\/$/, '') + '/fetch/' + D)).arrayBuffer());
      const obj = JSON.parse(wire.toString('utf8'));
      const wfIdx = obj.files.findIndex((f) => f.path.includes('workflows/'));
      const wfB = Buffer.from(obj.files[wfIdx].b64, 'base64');
      wfB[wfB.length - 1] ^= 0x01;
      obj.files[wfIdx].b64 = wfB.toString('base64');
      const files = obj.files.map((f) => ({ path: f.path, bytes: Buffer.from(f.b64, 'base64') }));
      const recomputed = p0DigestOf(files);
      const refusal = recomputed !== D ? 'FETCH_DIGEST_MISMATCH' : null;
      const impAfter = (await bstate()).import_tasks;
      let stageResult = null;
      if (refusal) {
        // refused BEFORE stage — no stagePackage call happens
        stageResult = { refused_before_stage: true };
      } else {
        stageResult = await stagePackage({ packageDir: '/nonexistent', alias });
      }
      return json(res, refusal ? 409 : 200, { error: refusal, requested_D: D, recomputed_D: recomputed, fetched_from: rUrl, corrupted_on: 'B', stage: stageResult, stage_calls_delta: impAfter - impBefore });
    }

    if (req.method === 'POST' && url.pathname === '/fetch-stage') {
      // B-side network fetch: bytes come from R over HTTP only; the digest
      // is recomputed ON B; extraction and staging are B-local.
      const { rUrl, D, alias } = body;
      const wire = Buffer.from(await (await fetch(rUrl.replace(/\/$/, '') + '/fetch/' + D)).arrayBuffer());
      const obj = JSON.parse(wire.toString('utf8'));
      const files = obj.files.map((f) => ({ path: f.path, bytes: Buffer.from(f.b64, 'base64') }));
      const recomputed = p0DigestOf(files);
      if (recomputed !== D) return json(res, 409, { error: 'FETCH_DIGEST_MISMATCH', expected: D, recomputed });
      const dir = join(process.env.DSH_HOME, 'incoming', D.slice(0, 16));
      await rm(dir, { recursive: true, force: true });
      for (const f of files) {
        const dest = join(dir, f.path);
        await mkdir(join(dest, '..'), { recursive: true });
        await writeFile(dest, f.bytes);
      }
      const out = await stagePackage({ packageDir: dir, alias });
      return json(res, out.ok ? 200 : 409, { ...out, fetch: { fetched_from: rUrl, requested_D: D, recomputed_D: recomputed, extracted_to: dir } });
    }

    if (req.method === 'POST' && url.pathname === '/make-fixture') {
      // The fixture is authored HERE (B), with B-chosen values, and hashed
      // HERE — before any execution of the imported implementation.
      const vals = body.values || [19, 8, 33, 4, 24, 11];
      const fixtureDir = join(process.env.DSH_HOME, 'fixtures', 'p1x-' + randomUUID().slice(0, 8));
      await mkdir(join(fixtureDir, 'workspace'), { recursive: true });
      let acc = 0;
      const rows = vals.map((v, i) => { acc += v; return { row: String(i + 1), total: String(acc) }; });
      await writeFile(join(fixtureDir, 'workspace', 'values.csv'), 'value\n' + vals.join('\n') + '\n', 'utf8');
      await writeFile(join(fixtureDir, 'objective.txt'), 'Process values.csv in order and report the running total after each row, one per line, as RESULT row=<n> total=<cumulative sum>.\n', 'utf8');
      await writeFile(join(fixtureDir, 'expected.json'), JSON.stringify({ rows }, null, 2) + '\n', 'utf8');
      const files = [
        { path: 'objective.txt', bytes: await readFile(join(fixtureDir, 'objective.txt')) },
        { path: 'expected.json', bytes: await readFile(join(fixtureDir, 'expected.json')) },
        { path: 'workspace/values.csv', bytes: await readFile(join(fixtureDir, 'workspace', 'values.csv')) },
      ];
      const hash = packageDigest(files);
      return json(res, 200, { fixtureDir, authors: 'B', hash_computed_on: hostname(), fixture_hash: hash, values: vals, rows });
    }

    if (req.method === 'POST' && url.pathname === '/verify') {
      const out = await verifyImport({ importTaskId: body.importTaskId, fixtureDir: body.fixtureDir });
      return json(res, out.ok ? 200 : 409, out);
    }
    if (req.method === 'POST' && url.pathname === '/admit') {
      const out = await admitImport({ importTaskId: body.importTaskId, alias: body.alias });
      return json(res, out.ok ? 200 : 409, out);
    }
    if (req.method === 'POST' && url.pathname === '/goal') {
      // mirror the plugin route exactly: an approval resumes the SAME task
      // (retryOf + approved) after re-checking it is genuinely awaiting.
      if (body.approveTaskId) {
        const { getGoal } = await import(join(REPO, 'lib', 'goal.js'));
        const pending = await getGoal(String(body.approveTaskId).slice(0, 120));
        const pv = pending && pending.verdict;
        const vStr = typeof pv === 'string' ? pv : (pv && pv.decision) || null;
        const codes = new Set(Array.isArray(pending && pending.failureCodes) ? pending.failureCodes : (pv && pv.failureCodes) || []);
        if (!pending || vStr !== 'PENDING' || !codes.has('awaiting-approval')) {
          return json(res, 409, { error: 'task is not awaiting approval' });
        }
        const goal = await runGoal({ retryOf: pending.taskId, approved: true });
        return json(res, 200, { goal });
      }
      const g = await runGoal({ objective: body.objective, retryOf: body.retryOf, forkOf: body.forkOf });
      return json(res, 200, { goal: g });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e).slice(0, 300) });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`B-actor on :${PORT} (repo ${REPO}, home ${process.env.DSH_HOME})`));
