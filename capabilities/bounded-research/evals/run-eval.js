#!/usr/bin/env node
// Eval runner for the bounded-research capability.
//
// Spins a loopback-only fixture server (canned pages, no external egress),
// runs the shipped adapter (../adapter/run.cjs) against cases.json, and
// checks the declared expectations. Exit 0 = every gate held; exit 1 =
// at least one gate did not.
//
// Negative control: `run-eval.js --negative` serves a perturbed page-a
// (query terms removed) while expectations stay put. The required outcome
// is eval FAILURE (non-zero exit): a suite that cannot fail proves nothing.
//
// Usage: node run-eval.js [--negative] [--artifacts <dir>]

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER = join(HERE, '..', 'adapter', 'run.cjs');
const FIXTURE_SERVER = join(HERE, 'fixture-server.cjs');
const argv = process.argv.slice(2);
const NEGATIVE = argv.includes('--negative');
const artIdx = argv.indexOf('--artifacts');
const ARTIFACTS = artIdx >= 0 ? argv[artIdx + 1] : null;

let failures = 0;
let checks = 0;
const ok = (line) => { checks++; console.log('  ok    ' + line); };
const fail = (line, detail) => { checks++; failures++; console.log('  FAIL  ' + line + (detail ? '  —  ' + detail : '')); };

const TERMS = 'bounded research citations';

// The fixture server runs in its own process: the eval parent blocks in
// spawnSync while adapters run, so an in-process server could never accept.
function startFixtureServer(perturbed) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [FIXTURE_SERVER, perturbed ? 'perturbed' : 'serve'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('fixture server did not report a port')); }, 10000);
    child.stdout.on('data', (c) => {
      buf += c.toString();
      const m = buf.match(/PORT (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolvePromise({ child, port: Number(m[1]) });
      }
    });
    child.on('exit', () => { clearTimeout(timer); reject(new Error('fixture server exited early')); });
  });
}

function runAdapter(input, evidenceDir) {
  const dir = mkdtempSync(join(tmpdir(), 'br-eval-'));
  const inputPath = join(dir, 'input.json');
  const outPath = join(dir, 'observation.json');
  writeFileSync(inputPath, JSON.stringify(input));
  const run = spawnSync(process.execPath, [ADAPTER, '--input', inputPath, '--out', outPath, '--evidence-dir', evidenceDir], { encoding: 'utf8', timeout: 30000 });
  let output = null;
  try {
    if (existsSync(outPath)) output = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch {}
  return { exit: run.status, stderr: run.stderr, output, evidenceDir };
}

const main = async () => {
  const { child, port } = await startFixtureServer(NEGATIVE);
  const host = '127.0.0.1';
  const page = (p) => `http://${host}:${port}${p}`;
  const root = mkdtempSync(join(tmpdir(), 'br-eval-root-'));
  try {
    const cases = [
      {
        id: 'valid-two-pages-cited',
        input: { query: TERMS, urls: [page('/page-a'), page('/page-b')], allowlist: [host] },
        expect: { exit: 0, cited: 2, refused: 0, excerptContains: 'bounded research', termHit: true, evidenceFiles: true },
      },
      {
        id: 'off-allowlist-refused-before-fetch',
        input: { query: TERMS, urls: [page('/page-a'), 'https://example.com/not-listed'], allowlist: [host] },
        expect: { exit: 0, cited: 1, refused: 1, refusedReasons: ['off-allowlist'] },
      },
      {
        id: 'empty-query-rejected',
        input: { query: '   ', urls: [page('/page-a')], allowlist: [host] },
        expect: { exit: 2, noObservation: true },
      },
      {
        id: 'missing-page-refused',
        input: { query: TERMS, urls: [page('/missing')], allowlist: [host] },
        expect: { exit: 0, cited: 0, refused: 1, refusedReasons: ['http-404'] },
      },
      {
        id: 'empty-200-body-refused-not-cited',
        input: { query: TERMS, urls: [page('/empty')], allowlist: [host] },
        expect: { exit: 0, cited: 0, refused: 1, refusedReasons: ['empty-body'] },
      },
      {
        id: 'slow-page-times-out',
        input: { query: TERMS, urls: [page('/slow')], allowlist: [host], timeoutMs: 700 },
        expect: { exit: 0, cited: 0, refused: 1, refusedReasons: ['timeout'] },
      },
      {
        id: 'binary-payload-refused',
        input: { query: TERMS, urls: [page('/binary')], allowlist: [host] },
        expect: { exit: 0, cited: 0, refused: 1, refusedReasons: ['non-text-payload'] },
      },
      {
        id: 'six-urls-exceed-input-cap',
        input: { query: TERMS, urls: [page('/page-a'), page('/page-b'), page('/empty'), page('/missing'), page('/slow'), page('/binary')], allowlist: [host] },
        expect: { exit: 2, noObservation: true },
      },
    ];
    for (const c of cases) {
      const evDir = join(root, c.id);
      mkdirSync(evDir, { recursive: true });
      const r = runAdapter(c.input, evDir);
      const e = c.expect;
      if (r.exit !== e.exit) { fail(`${c.id}: exit`, `expected ${e.exit}, got ${r.exit} (${(r.stderr || '').trim().slice(0, 120)})`); continue; }
      if (e.noObservation) {
        if (r.output !== null) fail(`${c.id}: no observation file`, 'observation was written anyway');
        else ok(`${c.id}: rejected without observation`);
        continue;
      }
      const out = r.output;
      if (!out || out.schema !== 'bounded-research-observation/1') { fail(`${c.id}: schema`, 'missing observation'); continue; }
      if (out.query !== TERMS) { fail(`${c.id}: query echo`, JSON.stringify(out.query)); continue; }
      if (out.passages.length !== e.cited) { fail(`${c.id}: cited count`, `expected ${e.cited}, got ${out.passages.length}`); continue; }
      if (out.refused.length !== e.refused) { fail(`${c.id}: refused count`, `expected ${e.refused}, got ${out.refused.length}`); continue; }
      if (e.refusedReasons) {
        const got = out.refused.map((x) => x.reason).sort().join(',');
        const want = [...e.refusedReasons].sort().join(',');
        if (got !== want) { fail(`${c.id}: refusal reasons`, `expected ${want}, got ${got}`); continue; }
      }
      if (e.excerptContains) {
        const hit = out.passages.some((p) => p.excerpt.toLowerCase().includes(e.excerptContains));
        if (!hit) { fail(`${c.id}: excerpt`, `no passage contains ${e.excerptContains}`); continue; }
      }
      if (e.termHit !== undefined) {
        if (!out.passages.every((p) => p.termHit === e.termHit)) { fail(`${c.id}: termHit`, 'flag mismatch'); continue; }
      }
      if (e.evidenceFiles) {
        const files = readdirSync(evDir);
        const bodies = files.filter((f) => /^body-\d+\.bin$/.test(f));
        if (bodies.length !== out.passages.length || !files.includes('fetch-log.json') || !files.includes('input.json')) {
          fail(`${c.id}: evidence files`, files.join(','));
          continue;
        }
        let digestsOk = true;
        out.passages.forEach((p, i) => {
          const h = createHash('sha256').update(readFileSync(join(evDir, `body-${i}.bin`))).digest('hex');
          if (h !== p.sha256) digestsOk = false;
        });
        if (!digestsOk) { fail(`${c.id}: evidence digests`, 'recomputed sha256 disagrees'); continue; }
      }
      ok(`${c.id}: cited ${e.cited}, refused ${e.refused}`);
    }
    if (ARTIFACTS) {
      mkdirSync(ARTIFACTS, { recursive: true });
      writeFileSync(join(ARTIFACTS, 'eval-summary.json'), JSON.stringify({ checks, failures, negative: NEGATIVE }, null, 2) + '\n');
    }
  } finally {
    child.kill();
  }
  console.log(failures === 0 ? `eval PASS (${checks} checks)` : `eval FAIL (${failures}/${checks} failed)`);
  process.exit(failures === 0 ? 0 : 1);
};

main();
