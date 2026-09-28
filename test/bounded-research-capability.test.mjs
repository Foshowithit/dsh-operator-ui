import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ADAPTER = join(root, 'capabilities', 'bounded-research', 'adapter', 'run.cjs');
const FIXTURE_SERVER = join(root, 'capabilities', 'bounded-research', 'evals', 'fixture-server.cjs');

// The fixture server runs in its own process: a parent blocked in spawnSync
// could never serve an in-process server (measured 2026-09-28).
function startServer() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [FIXTURE_SERVER], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('no port')); }, 10000);
    child.stdout.on('data', (c) => {
      buf += c.toString();
      const m = buf.match(/PORT (\d+)/);
      if (m) { clearTimeout(timer); resolvePromise({ child, port: Number(m[1]) }); }
    });
    child.on('exit', () => { clearTimeout(timer); reject(new Error('server exited')); });
  });
}

function run(input, evidenceDir) {
  const dir = mkdtempSync(join(tmpdir(), 'br-cap-'));
  const inputPath = join(dir, 'input.json');
  const outPath = join(dir, 'observation.json');
  writeFileSync(inputPath, JSON.stringify(input));
  const runResult = spawnSync(process.execPath, [ADAPTER, '--input', inputPath, '--out', outPath, '--evidence-dir', evidenceDir], { encoding: 'utf8', timeout: 30000 });
  let output = null;
  try {
    output = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch {}
  return { exit: runResult.status, output };
}

test('valid changed inputs cite with independent digest evidence', async () => {
  const { child, port } = await startServer();
  try {
    const host = '127.0.0.1';
    const evDir = mkdtempSync(join(tmpdir(), 'br-cap-ev-'));
    const r = run({ query: 'bounded research citations', urls: [`http://${host}:${port}/page-a`], allowlist: [host] }, evDir);
    assert.equal(r.exit, 0);
    assert.equal(r.output.schema, 'bounded-research-observation/1');
    assert.equal(r.output.passages.length, 1);
    const [p] = r.output.passages;
    assert.ok(p.excerpt.toLowerCase().includes('bounded research'));
    assert.equal(p.termHit, true);
    const raw = readFileSync(join(evDir, 'body-0.bin'));
    assert.equal(createHash('sha256').update(raw).digest('hex'), p.sha256);
  } finally {
    child.kill();
  }
});

test('contract and refusal matrix', async () => {
  const { child, port } = await startServer();
  try {
    const host = '127.0.0.1';
    const page = (p) => `http://${host}:${port}${p}`;
    const ev = () => { const d = mkdtempSync(join(tmpdir(), 'br-cap-ev-')); mkdirSync(d, { recursive: true }); return d; };
    // denied / out-of-scope access
    const denied = run({ query: 'q', urls: ['https://example.com/x'], allowlist: [host] }, ev());
    assert.equal(denied.exit, 0);
    assert.equal(denied.output.passages.length, 0);
    assert.deepEqual(denied.output.refused.map((x) => x.reason), ['off-allowlist']);
    // malformed input
    for (const bad of [
      { query: '', urls: [page('/page-a')], allowlist: [host] },
      { query: 'q', urls: [], allowlist: [host] },
      { query: 'q', urls: [page('/page-a')], allowlist: [] },
      { query: 'q', urls: [page('/page-a')], allowlist: [host], timeoutMs: 50 },
    ]) {
      const r = run(bad, ev());
      assert.equal(r.exit, 2, JSON.stringify(bad));
      assert.equal(r.output, null);
    }
    // timeout / disconnect
    const slow = run({ query: 'bounded research', urls: [page('/slow')], allowlist: [host], timeoutMs: 700 }, ev());
    assert.equal(slow.exit, 0);
    assert.deepEqual(slow.output.refused.map((x) => x.reason), ['timeout']);
    // misleading upstream success: 200 + empty body is refused, never cited
    const empty = run({ query: 'bounded research', urls: [page('/empty')], allowlist: [host] }, ev());
    assert.equal(empty.exit, 0);
    assert.equal(empty.output.passages.length, 0);
    assert.deepEqual(empty.output.refused.map((x) => x.reason), ['empty-body']);
    // missing evidence dir content: unwritable evidence dir fails closed
    const fileAsDir = join(ev(), 'blocker');
    writeFileSync(fileAsDir, 'x');
    const blocked = run({ query: 'q', urls: [page('/page-a')], allowlist: [host] }, join(fileAsDir, 'sub'));
    assert.equal(blocked.exit, 2);
  } finally {
    child.kill();
  }
});

test('registry entry is a candidate with no binding', async () => {
  const entry = JSON.parse(readFileSync(join(root, 'capabilities', 'bounded-research', 'registry-entry.json'), 'utf8'));
  assert.equal(entry.id, 'bounded-research');
  assert.equal(entry.status, 'candidate');
  assert.equal(entry.workflow, null);
  assert.match(entry.provenance.measurerSha256, /^[0-9a-f]{64}$/);
  const contract = JSON.parse(readFileSync(join(root, 'capabilities', 'bounded-research', 'contract.json'), 'utf8'));
  assert.equal(contract.schema, 'rcos-capability-contract/1');
});
