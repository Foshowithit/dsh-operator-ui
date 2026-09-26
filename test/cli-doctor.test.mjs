// `doctor`: read-only prerequisite report.
//
// Two properties are load-bearing and both are measured here rather than
// asserted in prose:
//   1. doctor WRITES NOTHING — on a ready host and on a blocked one.
//   2. an off-pin host DSH is UNVERIFIED, never BLOCKED. A refusal needs proof of
//      breakage; lib/compat.js documents the measured A/B boot that says we do not
//      have it. Fabricating an incompatibility would be worse than the missing
//      signal this guard was built to remove.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startStubArchon, makeHost, runCli } from './cli-harness.mjs';
import { doctorReport, EXIT } from '../lib/cli.js';
import { PINNED_DSH } from '../lib/compat.js';

const archon = await startStubArchon();
after(() => archon.stop());

const homePath = (name) => join(mkdtempSync(join(tmpdir(), 'opui-doc-')), name);

const doctorJson = async ({ home, profile, env, deps }) =>
  doctorReport({ home, profile, env, deps });

test('doctor: a fully provisioned host reports READY with nothing blocking', async () => {
  const home = homePath('home');
  const host = makeHost({ home, archonPort: archon.port });
  const rep = await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(rep.verdict, 'READY');
  assert.equal(rep.exit_code, EXIT.OK);
  assert.deepEqual(rep.blocking, []);
  assert.equal(rep.checks.every((c) => c.state === 'OK'), true,
    'every check must be OK on a ready host: ' + JSON.stringify(rep.checks.filter((c) => c.state !== 'OK')));
  rmSync(join(home, '..'), { recursive: true, force: true });
});

test('doctor: reports the install state without letting it block readiness', async () => {
  // A fresh host that has never been installed is READY. Registration is what
  // `install` PRODUCES; folding it into the verdict would make doctor report
  // BLOCKED on exactly the host it is supposed to say yes to.
  const home = homePath('home');
  const host = makeHost({ home, archonPort: archon.port });
  const rep = await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(rep.install.registered, false);
  assert.equal(rep.verdict, 'READY');
  assert.match(rep.install.note, /it is what .install. produces/);
  rmSync(join(home, '..'), { recursive: true, force: true });
});

test('doctor: is read-only — the host is byte-identical afterwards, ready or blocked', async () => {
  const home = homePath('home');
  const host = makeHost({ home, archonPort: archon.port });
  const before = host.snapshot();
  await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(host.snapshot(), before, 'doctor changed the host');

  // and on a blocked host
  const home2 = homePath('home');
  const host2 = makeHost({ home: home2, archonPort: 1 });
  const before2 = host2.snapshot();
  const rep = await doctorJson({ home: home2, profile: 'web', env: host2.env });
  assert.equal(rep.verdict, 'BLOCKED');
  assert.equal(host2.snapshot(), before2, 'doctor changed a blocked host');
  rmSync(join(home, '..'), { recursive: true, force: true });
  rmSync(join(home2, '..'), { recursive: true, force: true });
});

test('doctor: an unreachable Archon is BLOCKED and names the exact requirement', async () => {
  const home = homePath('home');
  const host = makeHost({ home, archonPort: 1 });
  const rep = await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(rep.verdict, 'BLOCKED');
  assert.equal(rep.exit_code, EXIT.BLOCKED);
  assert.deepEqual(rep.blocking.map((b) => b.id), ['archon']);
  const archonCheck = rep.checks.find((c) => c.id === 'archon');
  assert.match(archonCheck.requirement, /Archon HTTP API/);
  assert.match(archonCheck.reason, /not reachable|unhealthy|not Archon-compatible/);
  rmSync(join(home, '..'), { recursive: true, force: true });
});

test('doctor: a missing registry configuration is an explicit prerequisite failure', async () => {
  const home = homePath('home');
  const host = makeHost({ home, archonPort: archon.port, registry: 'none' });
  const rep = await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(rep.verdict, 'BLOCKED');
  assert.deepEqual(rep.blocking.map((b) => b.id), ['registry']);
  assert.match(rep.checks.find((c) => c.id === 'registry').reason, /No capability registry configured/);
  rmSync(join(home, '..'), { recursive: true, force: true });
});

test('doctor: a registry that parses but is not a registry is BLOCKED, not a crash', async () => {
  const home = homePath('home');
  const host = makeHost({ home, archonPort: archon.port, registry: 'invalid' });
  const rep = await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(rep.verdict, 'BLOCKED');
  assert.deepEqual(rep.blocking.map((b) => b.id), ['registry']);
  rmSync(join(home, '..'), { recursive: true, force: true });
});

test('doctor: a registry path that does not exist is BLOCKED and names the path', async () => {
  const home = homePath('home');
  const host = makeHost({ home, archonPort: archon.port, registry: 'missing-file' });
  const rep = await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(rep.verdict, 'BLOCKED');
  assert.match(rep.checks.find((c) => c.id === 'registry').reason, /does not exist/);
  rmSync(join(home, '..'), { recursive: true, force: true });
});

test('doctor: an absent DSH profile is BLOCKED and refuses to create one', async () => {
  const home = homePath('home');
  const host = makeHost({ home, archonPort: archon.port, withProfile: false });
  const rep = await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(rep.verdict, 'BLOCKED');
  assert.deepEqual(rep.blocking.map((b) => b.id), ['profile']);
  assert.match(rep.checks.find((c) => c.id === 'profile').reason, /does not create profiles/);
  rmSync(join(home, '..'), { recursive: true, force: true });
});

test('doctor: an off-pin host DSH is UNVERIFIED, not BLOCKED, and names both numbers', async () => {
  const home = homePath('home');
  const host = makeHost({ home, archonPort: archon.port });
  const rep = await doctorJson({
    home, profile: 'web', env: host.env,
    deps: { detectDsh: () => ({ version: '9.9.9', source: 'test-injected', dir: null, via: null }) },
  });
  assert.equal(rep.verdict, 'UNVERIFIED');
  assert.equal(rep.exit_code, EXIT.UNVERIFIED);
  assert.deepEqual(rep.blocking, [], 'an off-pin host must not block');
  const check = rep.checks.find((c) => c.id === 'dsh-host');
  assert.equal(check.state, 'UNVERIFIED');
  assert.equal(check.blocking, false);
  assert.match(check.reason, /9\.9\.9/);
  assert.match(check.reason, new RegExp(PINNED_DSH.replace(/\./g, '\\.')),
    'the off-pin report must name the pin as well as the detected version');
  rmSync(join(home, '..'), { recursive: true, force: true });
});

test('doctor: an undetectable host DSH is UNVERIFIED and invents no version', async () => {
  const home = homePath('home');
  const host = makeHost({ home, archonPort: archon.port });
  const rep = await doctorJson({
    home, profile: 'web', env: host.env,
    deps: { detectDsh: () => ({ version: null, source: null, dir: null, via: null }) },
  });
  assert.equal(rep.verdict, 'UNVERIFIED');
  const check = rep.checks.find((c) => c.id === 'dsh-host');
  assert.equal(check.detail.detected, null);
  assert.match(check.reason, /UNKNOWN/);
  rmSync(join(home, '..'), { recursive: true, force: true });
});

test('doctor: a missing dsh executable is BLOCKED with the requirement named', async () => {
  const home = homePath('home');
  const host = makeHost({ home, archonPort: archon.port });
  const env = { ...host.env, DSH_OPERATOR_UI_DSH_BIN: join(home, 'does-not-exist') };
  const rep = await doctorJson({ home, profile: 'web', env });
  assert.equal(rep.verdict, 'BLOCKED');
  assert.deepEqual(rep.blocking.map((b) => b.id), ['dsh-binary']);
  assert.match(rep.checks.find((c) => c.id === 'dsh-binary').requirement, /DSH_OPERATOR_UI_DSH_BIN/);
  rmSync(join(home, '..'), { recursive: true, force: true });
});

test('doctor: the child process renders and exits with the documented code', async () => {
  const home = homePath('home');
  const host = makeHost({ home, archonPort: archon.port });
  const r = runCli(['doctor', '--json'], { env: host.env });
  assert.equal(r.code, 0);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.verdict, 'READY');
  assert.equal(rep.read_only, true);

  const home2 = homePath('home');
  const host2 = makeHost({ home: home2, archonPort: 1 });
  const r2 = runCli(['doctor', '--json'], { env: host2.env });
  assert.equal(r2.code, 2, 'a blocked doctor must exit 2, the "nothing was mutated" code');
  assert.equal(JSON.parse(r2.stdout).verdict, 'BLOCKED');
  rmSync(join(home, '..'), { recursive: true, force: true });
  rmSync(join(home2, '..'), { recursive: true, force: true });
});

test('doctor: an unknown command is a usage error, not a crash', async () => {
  const home = homePath('home');
  const host = makeHost({ home, archonPort: archon.port });
  const r = runCli(['frobnicate'], { env: host.env });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.stderr, /unknown command/);
  rmSync(join(home, '..'), { recursive: true, force: true });
});
