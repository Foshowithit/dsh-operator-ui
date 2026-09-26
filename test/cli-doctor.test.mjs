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
import { join } from 'node:path';
import { startStubArchon, makeHost, runCli, scratch } from './cli-harness.mjs';
import { doctorReport, EXIT } from '../lib/cli.js';
import { PINNED_DSH } from '../lib/compat.js';

// THE HOST DSH VERSION IS AN ENVIRONMENTAL FACT, so these tests CONTROL it.
//
// The first version of this file let `detectDshVersion` find whatever DSH sat
// above the tree. In the working tree that is a real DSH 0.1.0-rc.6, so the
// verdict was READY; in the frozen-snapshot gate the tree lives under a temp
// path with no DSH above it, so the same code honestly reported UNKNOWN and the
// tests failed. The production behaviour was right in both cases — the TEST was
// inheriting a fact it had not declared. `detectDsh` is injectable for exactly
// this reason (the same seam lib/compat.js gives its own probes).
const AT_PIN = () => ({ version: PINNED_DSH, source: 'test-pinned', dir: null, via: null });
const deps = (over = {}) => ({ detectDsh: AT_PIN, ...over });

const archon = await startStubArchon();
after(() => archon.stop());

// A host per test, never deleted (see scratch() in the harness).
const newHome = () => join(scratch('opui-doc'), 'home');

const doctorJson = async ({ home, profile, env, deps: d }) =>
  doctorReport({ home, profile, env, deps: deps(d) });

test('doctor: a fully provisioned host reports READY with nothing blocking', async () => {
  const home = newHome();
  const host = makeHost({ home, archonPort: archon.port });
  const rep = await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(rep.verdict, 'READY');
  assert.equal(rep.exit_code, EXIT.OK);
  assert.deepEqual(rep.blocking, []);
  assert.equal(rep.checks.every((c) => c.state === 'OK'), true,
    'every check must be OK on a ready host: ' + JSON.stringify(rep.checks.filter((c) => c.state !== 'OK')));
});

test('doctor: reports the install state without letting it block readiness', async () => {
  // A fresh host that has never been installed is READY. Registration is what
  // `install` PRODUCES; folding it into the verdict would make doctor report
  // BLOCKED on exactly the host it is supposed to say yes to.
  const home = newHome();
  const host = makeHost({ home, archonPort: archon.port });
  const rep = await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(rep.install.registered, false);
  assert.equal(rep.verdict, 'READY');
  assert.match(rep.install.note, /it is what .install. produces/);
});

test('doctor: is read-only — the host is byte-identical afterwards, ready or blocked', async () => {
  const home = newHome();
  const host = makeHost({ home, archonPort: archon.port });
  const before = host.snapshot();
  await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(host.snapshot(), before, 'doctor changed the host');

  // and on a blocked host
  const home2 = newHome();
  const host2 = makeHost({ home: home2, archonPort: 1 });
  const before2 = host2.snapshot();
  const rep = await doctorJson({ home: home2, profile: 'web', env: host2.env });
  assert.equal(rep.verdict, 'BLOCKED');
  assert.equal(host2.snapshot(), before2, 'doctor changed a blocked host');
});

test('doctor: an unreachable Archon is BLOCKED and names the exact requirement', async () => {
  const home = newHome();
  const host = makeHost({ home, archonPort: 1 });
  const rep = await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(rep.verdict, 'BLOCKED');
  assert.equal(rep.exit_code, EXIT.BLOCKED);
  assert.deepEqual(rep.blocking.map((b) => b.id), ['archon']);
  const archonCheck = rep.checks.find((c) => c.id === 'archon');
  assert.match(archonCheck.requirement, /Archon HTTP API/);
  assert.match(archonCheck.reason, /not reachable|unhealthy|not Archon-compatible/);
});

test('doctor: a missing registry configuration is an explicit prerequisite failure', async () => {
  const home = newHome();
  const host = makeHost({ home, archonPort: archon.port, registry: 'none' });
  const rep = await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(rep.verdict, 'BLOCKED');
  assert.deepEqual(rep.blocking.map((b) => b.id), ['registry']);
  assert.match(rep.checks.find((c) => c.id === 'registry').reason, /No capability registry configured/);
});

test('doctor: a registry that parses but is not a registry is BLOCKED, not a crash', async () => {
  const home = newHome();
  const host = makeHost({ home, archonPort: archon.port, registry: 'invalid' });
  const rep = await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(rep.verdict, 'BLOCKED');
  assert.deepEqual(rep.blocking.map((b) => b.id), ['registry']);
});

test('doctor: a registry path that does not exist is BLOCKED and names the path', async () => {
  const home = newHome();
  const host = makeHost({ home, archonPort: archon.port, registry: 'missing-file' });
  const rep = await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(rep.verdict, 'BLOCKED');
  assert.match(rep.checks.find((c) => c.id === 'registry').reason, /does not exist/);
});

test('doctor: an absent DSH profile is BLOCKED and refuses to create one', async () => {
  const home = newHome();
  const host = makeHost({ home, archonPort: archon.port, withProfile: false });
  const rep = await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(rep.verdict, 'BLOCKED');
  assert.deepEqual(rep.blocking.map((b) => b.id), ['profile']);
  assert.match(rep.checks.find((c) => c.id === 'profile').reason, /does not create profiles/);
});

test('doctor: an off-pin host DSH is UNVERIFIED, not BLOCKED, and names both numbers', async () => {
  const home = newHome();
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
});

test('doctor: an undetectable host DSH is UNVERIFIED and invents no version', async () => {
  const home = newHome();
  const host = makeHost({ home, archonPort: archon.port });
  const rep = await doctorJson({
    home, profile: 'web', env: host.env,
    deps: { detectDsh: () => ({ version: null, source: null, dir: null, via: null }) },
  });
  assert.equal(rep.verdict, 'UNVERIFIED');
  const check = rep.checks.find((c) => c.id === 'dsh-host');
  assert.equal(check.detail.detected, null);
  assert.match(check.reason, /UNKNOWN/);
});

test('doctor: a missing dsh executable is BLOCKED with the requirement named', async () => {
  const home = newHome();
  const host = makeHost({ home, archonPort: archon.port });
  const env = { ...host.env, DSH_OPERATOR_UI_DSH_BIN: join(home, 'does-not-exist') };
  const rep = await doctorJson({ home, profile: 'web', env });
  assert.equal(rep.verdict, 'BLOCKED');
  assert.deepEqual(rep.blocking.map((b) => b.id), ['dsh-binary']);
  assert.match(rep.checks.find((c) => c.id === 'dsh-binary').requirement, /DSH_OPERATOR_UI_DSH_BIN/);
});

test('doctor: the child process renders JSON and exits with the code its verdict implies', async () => {
  // Deliberately NOT asserting a specific verdict here: the host DSH version is an
  // environmental fact a child process cannot be given by injection, and a test
  // that hardcodes READY fails wherever no DSH sits above the tree — which is how
  // the frozen-snapshot gate caught the first version of this file. What is
  // checked is the CONTRACT: the exit code must agree with the reported verdict.
  const home = newHome();
  const host = makeHost({ home, archonPort: archon.port });
  const r = runCli(['doctor', '--json'], { env: host.env });
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.read_only, true);
  assert.ok(['READY', 'UNVERIFIED', 'BLOCKED'].includes(rep.verdict));
  assert.equal(rep.exit_code, r.code, 'the reported exit_code must be the process exit code');
  assert.ok([EXIT.OK, EXIT.UNVERIFIED].includes(r.code),
    'with every blocking prerequisite present the process must not report a block, got ' + r.code);
  assert.equal(rep.checks.length > 0, true);

  // A host missing a blocking prerequisite must exit 2 — "nothing was mutated" —
  // regardless of anything else about the environment.
  const home2 = newHome();
  const host2 = makeHost({ home: home2, archonPort: 1 });
  const r2 = runCli(['doctor', '--json'], { env: host2.env });
  assert.equal(r2.code, 2, 'a blocked doctor must exit 2, the "nothing was mutated" code');
  assert.equal(JSON.parse(r2.stdout).verdict, 'BLOCKED');
});

test('doctor: an off-pin host DSH WITHHOLDS mutation authority without calling it incompatible', async () => {
  // GPT's ruling, 2026-09-26: "unknown is not broken — but unknown also does not
  // grant mutation authority." Two aggregates over one measurement: the verdict
  // stays UNVERIFIED (this host may well work), and the authority is withheld
  // because the direct registration path writes DSH's private profile schema.
  const home = newHome();
  const host = makeHost({ home, archonPort: archon.port, dshVersion: '9.9.9' });
  const rep = await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(rep.verdict, 'UNVERIFIED', 'an off-pin host must not be reported as blocked');
  assert.deepEqual(rep.blocking, []);
  assert.equal(rep.registration_authority.grants_mutation, false);
  assert.equal(rep.registration_authority.detected, '9.9.9');
  assert.equal(rep.registration_authority.measured_from, "the `dsh` binary's own --version");
  assert.match(rep.registration_authority.reason, /^registration-contract-unverified/);
  assert.match(rep.registration_authority.reason, /not a claim that the host is incompatible/);
  assert.equal(/incompatible DSH|is incompatible\./.test(rep.registration_authority.reason), false);
});

test('doctor: an on-pin host DSH grants mutation authority', async () => {
  const home = newHome();
  const host = makeHost({ home, archonPort: archon.port, dshVersion: PINNED_DSH });
  const rep = await doctorJson({ home, profile: 'web', env: host.env });
  assert.equal(rep.registration_authority.grants_mutation, true);
  assert.equal(rep.registration_authority.reason, null);
  assert.equal(rep.registration_authority.verified_pin, PINNED_DSH);
});

test('doctor: the authority is measured from the dsh binary, not from a filesystem walk', async () => {
  // The walk answers "which DSH is above me right now", whose answer changes with
  // where the command runs. The binary that OWNS the profile is the one that
  // decides, so a walked version is only a fallback.
  const home = newHome();
  const host = makeHost({ home, archonPort: archon.port, dshVersion: PINNED_DSH });
  const rep = await doctorJson({
    home, profile: 'web', env: host.env,
    deps: { detectDsh: () => ({ version: '1.2.3', source: 'test-injected', dir: null, via: null }) },
  });
  assert.equal(rep.registration_authority.grants_mutation, true,
    'the binary reports the pin, so authority must be granted regardless of the walk');
  assert.equal(rep.checks.find((c) => c.id === 'dsh-host').state, 'UNVERIFIED',
    'the walked version is still reported honestly on its own check');
});

test('doctor: an unknown command is a usage error, not a crash', async () => {
  const home = newHome();
  const host = makeHost({ home, archonPort: archon.port });
  const r = runCli(['frobnicate'], { env: host.env });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.stderr, /unknown command/);
});
