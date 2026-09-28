import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNTHETIC_BANNER,
  buildSyntheticBanner,
  checkResolverProof,
  isLoopbackHost,
  parsePreviewArgs,
  resolveFixture,
  readFixture,
  startPreviewServer,
} from '../scripts/preview-operator.mjs';

test('every preview carries the synthetic banner', () => {
  assert.match(buildSyntheticBanner(), /Synthetic preview/);
  assert.match(SYNTHETIC_BANNER, /no live task/);
});

test('fixture selection cannot escape the fixture directory', () => {
  const dir = '/tmp/preview-fixtures';
  for (const evil of ['../secret', '..\\secret', '/abs/path', '', 'a/b', 'x.json', '.hidden', 'A', 'has space', 'x'.repeat(65)]) {
    const result = resolveFixture({ fixtureDir: dir, name: evil });
    assert.equal(result.ok, false, evil || '(empty)');
  }
  const good = resolveFixture({ fixtureDir: dir, name: 'states' });
  assert.equal(good.ok, true);
  assert.ok(good.path.endsWith('/states.json'));
  assert.ok(good.path.startsWith(dir));
});

test('absent or unreadable fixtures fail closed with no fallback', () => {
  const missing = readFixture({ fixtureDir: '/tmp/preview-fixtures-that-do-not-exist', name: 'states' });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /fail closed|absent/i);
  const noDir = resolveFixture({ fixtureDir: '', name: 'states' });
  assert.equal(noDir.ok, false);
});

test('preview binds loopback only', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('192.168.1.2'), false);
  assert.equal(isLoopbackHost('example.com'), false);
});

test('port parsing rejects privileged, wild, and unknown input', () => {
  assert.equal(parsePreviewArgs(['node', 'x', '--port', '3921']).ok, true);
  for (const argv of [
    ['node', 'x'],
    ['node', 'x', '--port'],
    ['node', 'x', '--port', '80'],
    ['node', 'x', '--port', '0'],
    ['node', 'x', '--port', '99999'],
    ['node', 'x', '--port', 'abc'],
    ['node', 'x', '--host', '0.0.0.0'],
  ]) {
    assert.equal(parsePreviewArgs(argv).ok, false, JSON.stringify(argv));
  }
});

test('resolver gate: stubs and partial proofs stay blocked', () => {
  assert.equal(checkResolverProof(null).ready, false);
  assert.equal(checkResolverProof({}).ready, false);
  assert.equal(checkResolverProof({ reactVersion: '18.3.1' }).ready, false);
  const full = checkResolverProof({
    reactVersion: '18.3.1',
    reactDomVersion: '18.3.1',
    sourceDigest: 'sha256:pending',
    requireMapping: "require('react') only",
  });
  assert.equal(full.ready, true);
});

test('server refuses non-loopback hosts without binding', async () => {
  const result = await startPreviewServer({ port: 3921, host: '0.0.0.0', fixtureDir: '/tmp/preview-fixtures' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /loopback/);
});

test('server serves banner plus fixture state on loopback', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'preview-test-'));
  writeFileSync(join(dir, 'states.json'), JSON.stringify({ states: ['missing'] }));
  const started = await startPreviewServer({ port: 0, fixtureDir: dir });
  // Port 0 is OS-assigned (test-only); the CLI still requires 1024-65535.
  assert.equal(started.ok, true);
  try {
    const get = (path) => new Promise((resolvePromise, reject) => {
      import('node:http').then(({ default: http }) => {
        http.get({ host: '127.0.0.1', port: started.port, path }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolvePromise({ status: res.statusCode, body: JSON.parse(body) }));
        }).on('error', reject);
      });
    });
    const status = await get('/status');
    assert.equal(status.status, 200);
    assert.match(status.body.banner, /Synthetic preview/);
    assert.equal(status.body.resolver.status, 'blocked');
    assert.equal(status.body.liveDispatch, false);
    const fixture = await get('/states');
    assert.equal(fixture.status, 200);
    assert.match(fixture.body.banner, /Synthetic preview/);
    const absent = await get('/no-such-fixture');
    assert.equal(absent.status, 404);
  } finally {
    await new Promise((resolvePromise) => started.server.close(resolvePromise));
  }
});
