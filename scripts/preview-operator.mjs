// scripts/preview-operator.mjs — development-only synthetic preview host (P1).
//
// A fixture host for the actual served client module. It supplies only
// explicit mocked services/slots/observables and canned same-origin
// responses. It is not a production route, not a new DSH session, and it
// never dispatches a live task.
//
// Fail-closed rules (tested in test/operator-preview.test.mjs):
// - fixture selection cannot read outside the named fixture directory;
// - the server binds loopback only and never kills another listener;
// - no tool execution, no outbound fetch, no profile writes;
// - real-component rendering waits for the pinned React resolver proof
//   (docs/DESKTOP-VISUAL-QA.md); until then every route carries the
//   synthetic banner and /status reports the resolver as blocked.
//
// Pure guards have no I/O on import. The server starts only when this file
// is executed directly with `node scripts/preview-operator.mjs --port <n>`.

import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const SYNTHETIC_BANNER = 'Synthetic preview — canned fixtures only, no live task, no live session.';
export const FIXTURE_DIR_NAME = 'operator-preview';
const MAX_NAME = 64;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function buildSyntheticBanner() {
  return SYNTHETIC_BANNER;
}

// Resolve a fixture name to a path inside fixtureDir. Anything that is not
// a plain allowlisted name fails closed — traversal, absolute paths, and
// extensions never resolve.
export function resolveFixture({ fixtureDir, name }) {
  if (typeof fixtureDir !== 'string' || fixtureDir.length === 0) {
    return { ok: false, reason: 'fixture directory is required' };
  }
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, reason: 'fixture name is required' };
  }
  if (name.length > MAX_NAME || !NAME_RE.test(name)) {
    return { ok: false, reason: 'fixture name must match [a-z0-9-] (no traversal, no extensions)' };
  }
  const base = resolve(fixtureDir);
  const candidate = resolve(join(base, `${name}.json`));
  if (candidate !== join(base, `${name}.json`) || !candidate.startsWith(base + sep)) {
    return { ok: false, reason: 'fixture resolves outside the fixture directory' };
  }
  return { ok: true, path: candidate };
}

export function readFixture({ fixtureDir, name }) {
  const resolved = resolveFixture({ fixtureDir, name });
  if (!resolved.ok) return resolved;
  if (!existsSync(resolved.path)) {
    return { ok: false, reason: 'fixture absent — fail closed, no fallback content' };
  }
  try {
    return { ok: true, path: resolved.path, body: readFileSync(resolved.path, 'utf8') };
  } catch {
    return { ok: false, reason: 'fixture unreadable — fail closed' };
  }
}

// CLI parsing is pure: --port <unused-port>. Anything else fails closed.
export function parsePreviewArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  let port = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--port') {
      const raw = args[i + 1];
      if (raw === undefined) return { ok: false, reason: '--port requires a value' };
      if (!/^\d+$/.test(raw)) return { ok: false, reason: '--port must be a number' };
      port = Number(raw);
      i += 1;
    } else {
      return { ok: false, reason: `unknown argument: ${args[i]}` };
    }
  }
  if (port === null) return { ok: false, reason: '--port <unused-port> is required' };
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    return { ok: false, reason: '--port must be 1024-65535 (no privileged ports)' };
  }
  return { ok: true, port };
}

export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

// Resolver gate: real-component rendering needs a pinned host React/ReactDOM
// (exact versions plus source digest). Anything less stays blocked — a VM
// stub or a guessed CDN never counts as the resolver proof.
export function checkResolverProof(proof) {
  if (!proof || typeof proof !== 'object') {
    return { ready: false, reason: 'no resolver proof supplied' };
  }
  for (const key of ['reactVersion', 'reactDomVersion', 'sourceDigest', 'requireMapping']) {
    if (typeof proof[key] !== 'string' || proof[key].trim().length === 0) {
      return { ready: false, reason: `resolver proof missing ${key}` };
    }
  }
  return { ready: true, detail: `react ${proof.reactVersion} + react-dom ${proof.reactDomVersion} (${proof.sourceDigest})` };
}

// Real-component serving (P1): the pinned resolver proof names exact local
// React UMD bytes; the vendor route serves them ONLY after re-hashing the file
// and matching the committed digest — a byte mismatch is a refusal, never a
// fallback to some other bytes. /client.js serves the real plugin factory and
// /render serves the harness page that mounts it without any dispatch.
const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);
const VENDOR_ROUTES = {
  '/vendor/react.production.min.js': {
    file: 'node_modules/react/umd/react.production.min.js',
    digestKey: 'react',
  },
  '/vendor/react-dom.production.min.js': {
    file: 'node_modules/react-dom/umd/react-dom.production.min.js',
    digestKey: 'reactDom',
  },
};

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function vendorResponse(route, proof) {
  const spec = VENDOR_ROUTES[route];
  const declared = proof && proof.source && proof.source.localPreviewBytes && proof.source.localPreviewBytes[spec.digestKey];
  const abs = join(REPO_ROOT, spec.file);
  if (!existsSync(abs)) {
    return { status: 500, body: `pinned bytes missing: ${spec.file}` };
  }
  const actual = sha256File(abs);
  if (!declared || actual !== declared.sha256) {
    return { status: 500, body: `digest mismatch for ${spec.file}: bytes are not the pinned resolver proof` };
  }
  return { status: 200, body: readFileSync(abs), type: 'application/javascript; charset=utf-8' };
}

export function startPreviewServer({ port, host = '127.0.0.1', fixtureDir, resolverProof = null }) {
  if (!isLoopbackHost(host)) {
    return Promise.resolve({ ok: false, reason: 'preview binds loopback only' });
  }
  const gate = checkResolverProof(resolverProof);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${host}`);
    if (url.pathname === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        banner: SYNTHETIC_BANNER,
        resolver: gate.ready ? { status: 'ready', detail: gate.detail } : { status: 'blocked', reason: gate.reason },
        liveDispatch: false,
        toolExecution: false,
        profileWrites: false,
      }));
      return;
    }
    if (url.pathname === '/plugins/operator-ui/rcos' && url.searchParams.get('op') === 'registry') {
      const fixture = readFixture({ fixtureDir, name: 'rcos-registry' });
      res.writeHead(fixture.ok ? 200 : 404, { 'content-type': 'application/json' });
      res.end(fixture.ok ? fixture.body : JSON.stringify({ ok: false, error: fixture.reason }));
      return;
    }
    if (url.pathname === '/render') {
      const page = readFileSync(join(REPO_ROOT, 'test/fixtures/operator-preview/render.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    if (url.pathname === '/client.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(readFileSync(join(REPO_ROOT, 'lib/client.js')));
      return;
    }
    if (VENDOR_ROUTES[url.pathname]) {
      const out = vendorResponse(url.pathname, resolverProof);
      if (out.type) {
        res.writeHead(out.status, { 'content-type': out.type });
        res.end(out.body);
      } else {
        res.writeHead(out.status, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(out.body);
      }
      return;
    }
    const name = url.pathname.replace(/^\//, '').replace(/\.json$/, '') || 'states';
    const fixture = readFixture({ fixtureDir, name });
    res.writeHead(fixture.ok ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      banner: SYNTHETIC_BANNER,
      ...(fixture.ok ? { fixture: name, body: fixture.body } : { error: fixture.reason }),
    }));
  });
  return new Promise((resolvePromise) => {
    const onError = (err) => {
      // A port held by another listener is a refusal, never a kill order.
      resolvePromise({ ok: false, reason: err && err.code === 'EADDRINUSE' ? 'port in use — stop the owner or pick another port; this preview never kills listeners' : `listen failed: ${err && err.message ? err.message : err}` });
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolvePromise({ ok: true, server, port: server.address().port, host });
    });
  });
}

const invokedDirectly = typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('preview-operator.mjs');
if (invokedDirectly) {
  const parsed = parsePreviewArgs(process.argv);
  if (!parsed.ok) {
    console.error(`preview-operator: ${parsed.reason}`);
    process.exit(2);
  }
  const fixtureDir = new URL('../test/fixtures/operator-preview/', import.meta.url).pathname;
  let resolverProof = null;
  try {
    resolverProof = JSON.parse(readFileSync(new URL('./resolver-proof.json', import.meta.url), 'utf8'));
  } catch (e) {
    console.error(`preview-operator: resolver proof unavailable (${e.message}) — /status stays blocked, /render stays down`);
  }
  startPreviewServer({ port: parsed.port, fixtureDir, resolverProof }).then((started) => {
    if (!started.ok) {
      console.error(`preview-operator: ${started.reason}`);
      process.exit(1);
    }
    console.log(`preview-operator: ${SYNTHETIC_BANNER}`);
    console.log(`preview-operator: listening on http://${started.host}:${started.port} (loopback only; owned process — stop it after QA)`);
  });
}
