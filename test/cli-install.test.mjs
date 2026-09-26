// `install` and `verify`: the D1/D2 half of distribution.
//
// WHAT IS PROVEN HERE, and why each one is a real requirement rather than a
// restatement of the implementation:
//
//   * PREFLIGHT BEFORE MUTATION — a blocked host is byte-identical afterwards.
//     Measured with a content hash of the whole synthetic home, so "nothing was
//     written" is a fact about the filesystem, not a claim about the code path.
//   * TRANSACTIONAL FAILURE — when the boot leg fails after the durable copy and
//     the registration exist, the profile is restored BYTE-EXACTLY and the
//     durable copy is gone. The failure is produced by a package whose module
//     graph genuinely cannot load, not by a stubbed-out installer.
//   * IDEMPOTENCE — a second install converges and changes nothing, and the
//     bundle list does not grow a second entry.
//   * D1 DURABILITY — the installed package's OWN bin runs with no source
//     checkout in play, and the durable tree contains no reference to it.
//   * NO CREDENTIALS IN THE RECEIPT.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, cpSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubArchon, makeHost, makeSourceCopy, runCli, scratch, NODE, REPO } from './cli-harness.mjs';
import { contentIdentity, installRoot, verifyInstalled, EXIT } from '../lib/cli.js';
import { PINNED_DSH } from '../lib/compat.js';

const archon = await startStubArchon();
after(() => archon.stop());

const durableOf = (home) => join(installRoot({ home }), 'dsh-operator-ui-0.11.0');
const profilePkg = (home) => JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'));

// Scratch directories are never deleted — see scratch() in the harness for why
// (a suite that recursively removes a dozen synthetic homes trips the host's
// per-turn bulk-delete guard, which is how the frozen-snapshot gate caught the
// first version of this file).

test('install: a blocked host is refused BEFORE any mutation, byte-for-byte', async () => {
  const dir = scratch('opui-inst');
  const home = join(dir, 'home');
  const host = makeHost({ home, archonPort: 1 });
  const before = host.snapshot();
  const r = runCli(['install', '--json'], { env: host.env });
  const rep = JSON.parse(r.stdout);
  assert.equal(r.code, EXIT.BLOCKED);
  assert.equal(rep.state, 'BLOCKED');
  assert.equal(rep.mutated, false);
  assert.deepEqual(rep.blocking.map((b) => b.id), ['archon']);
  assert.equal(host.snapshot(), before, 'a blocked install wrote to the host');
  assert.equal(existsSync(durableOf(home)), false, 'a blocked install created the durable root');
  assert.match(rep.reason, /Nothing was written/);
});

test('install: --dry-run passes preflight and writes nothing', async () => {
  const dir = scratch('opui-inst');
  const home = join(dir, 'home');
  const host = makeHost({ home, archonPort: archon.port });
  const before = host.snapshot();
  const r = runCli(['install', '--json', '--dry-run'], { env: host.env });
  const rep = JSON.parse(r.stdout);
  assert.equal(r.code, 0);
  assert.equal(rep.state, 'DRY_RUN');
  assert.equal(rep.mutated, false);
  assert.equal(host.snapshot(), before);
});

test('install: copies durably, registers in the profile, boots, and receipts', async () => {
  const dir = scratch('opui-inst');
  const home = join(dir, 'home');
  const host = makeHost({ home, archonPort: archon.port });
  const r = runCli(['install', '--json'], { env: host.env });
  const rep = JSON.parse(r.stdout);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(rep.state, 'INSTALLED');
  assert.equal(rep.mutated, true);

  // the durable copy exists outside the profile and outside the source tree
  assert.equal(existsSync(join(durableOf(home), 'lib', 'index.js')), true);
  assert.equal(existsSync(join(durableOf(home), 'bin', 'dsh-operator-ui.mjs')), true);
  assert.equal(rep.location.durable_dir.startsWith(home), true, 'the durable copy must live under DSH_HOME');

  // registration: exactly what the real `dsh plugin add` writes (verified against
  // a live profile: the dependency spec, the bundle entry, the node_modules link)
  const pkg = profilePkg(home);
  assert.equal(pkg.dependencies['dsh-operator-ui'], 'link:' + durableOf(home));
  assert.deepEqual(pkg.dsh.profile.bundles,
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-operator-ui']);
  assert.equal(existsSync(join(home, 'profiles', 'web', 'node_modules', 'dsh-operator-ui')), true);

  // the boot leg is named, and its scope is declared rather than implied
  assert.equal(rep.boot.ok, true);
  assert.equal(rep.boot.method, 'module-graph-load');
  assert.match(rep.boot.scope, /full DSH web server boot is not performed/);

  // receipt on disk, under the directory the plugin already owns by contract
  const receipt = JSON.parse(readFileSync(join(home, 'operator-ui', 'install-receipt.json'), 'utf8'));
  assert.equal(receipt.state, 'INSTALLED');
  assert.equal(receipt.package.version, '0.11.0');
});

test('install: a second run converges and changes nothing', async () => {
  const dir = scratch('opui-inst');
  const home = join(dir, 'home');
  const host = makeHost({ home, archonPort: archon.port });
  assert.equal(runCli(['install', '--json'], { env: host.env }).code, 0);
  const afterFirst = host.snapshot();
  const bundlesFirst = profilePkg(home).dsh.profile.bundles.length;
  const receiptFirst = readFileSync(join(home, 'operator-ui', 'install-receipt.json'), 'utf8');

  const r2 = runCli(['install', '--json'], { env: host.env });
  const rep2 = JSON.parse(r2.stdout);
  assert.equal(r2.code, 0);
  assert.equal(rep2.state, 'ALREADY_INSTALLED');
  assert.equal(rep2.mutated, false);
  assert.equal(rep2.location.converged, true);
  assert.equal(rep2.receipt_action, 'preserved', 'a converged run must not rewrite the receipt');
  assert.equal(host.snapshot(), afterFirst, 'the second install changed the host');
  assert.equal(readFileSync(join(home, 'operator-ui', 'install-receipt.json'), 'utf8'), receiptFirst,
    'the receipt changed on a converged run');
  assert.equal(profilePkg(home).dsh.profile.bundles.length, bundlesFirst,
    'the second install duplicated the bundle entry');
});

test('install: a converged host whose receipt was deleted becomes verifiable again', async () => {
  // The one case where a no-op run must still write: without it, a host that had
  // its receipt removed could never be verified again, and `install` would report
  // success while `verify` reported "never installed".
  const dir = scratch('opui-inst');
  const home = join(dir, 'home');
  const host = makeHost({ home, archonPort: archon.port });
  runCli(['install', '--json'], { env: host.env });
  assert.equal(runCli(['verify', '--json'], { env: host.env }).code, EXIT.UNVERIFIED);
  unlinkSync(join(home, 'operator-ui', 'install-receipt.json'));
  assert.equal(runCli(['verify', '--json'], { env: host.env }).code, EXIT.BLOCKED, 'verify must notice the missing receipt');

  const rep = JSON.parse(runCli(['install', '--json'], { env: host.env }).stdout);
  assert.equal(rep.state, 'ALREADY_INSTALLED');
  assert.equal(rep.mutated, false, 'recovering the receipt is not a mutation of the install');
  assert.equal(rep.receipt_action, 'written');
  assert.equal(runCli(['verify', '--json'], { env: host.env }).code, EXIT.UNVERIFIED, 'the host must be verifiable again');
});

test('install: a failure AFTER mutation rolls the profile back byte-exactly', async () => {
  const dir = scratch('opui-inst');
  const home = join(dir, 'home');
  const host = makeHost({ home, archonPort: archon.port });

  // A package whose module graph cannot load: the boot leg fails after the
  // durable copy and the registration already exist — the only window where
  // "transactional" means anything.
  const broken = makeSourceCopy(join(dir, 'broken-src'), { corruptEntry: true });
  const profileBefore = readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8');

  const r = runCli(['install', '--json'], { env: host.env, bin: join(broken, 'bin', 'dsh-operator-ui.mjs') });
  const rep = JSON.parse(r.stdout);
  assert.equal(r.code, EXIT.FAILED, r.stderr);
  assert.equal(rep.state, 'FAILED_ROLLED_BACK');
  assert.equal(rep.mutated, false);
  assert.equal(rep.rollback.attempted, true);
  assert.deepEqual(rep.rollback.failures, [], 'the rollback itself must not have failed');
  assert.match(rep.reason, /boot leg failed/);

  // the profile is byte-identical to what it was before the attempt
  assert.equal(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'), profileBefore,
    'the rollback did not restore the profile package.json');
  assert.equal(existsSync(join(home, 'profiles', 'web', 'node_modules', 'dsh-operator-ui')), false,
    'the rollback left the node_modules link behind');
  assert.equal(existsSync(durableOf(home)), false, 'the rollback left the durable copy behind');
});

test('install: the receipt carries provenance and no credentials', async () => {
  const dir = scratch('opui-inst');
  const home = join(dir, 'home');
  const host = makeHost({ home, archonPort: archon.port });
  runCli(['install', '--json'], { env: host.env });
  const raw = readFileSync(join(home, 'operator-ui', 'install-receipt.json'), 'utf8');
  const receipt = JSON.parse(raw);

  // the provenance facts GPT required in the artifact's receipt
  assert.equal(typeof receipt.package.version, 'string');
  assert.equal(receipt.package.provenance_schema, 1);
  assert.equal(typeof receipt.package.certified_by_gate_version, 'number');
  assert.equal(receipt.compatibility.dsh_pin, '0.1.0-rc.6');
  assert.equal(typeof receipt.archon.detail.base_url, 'string');
  assert.equal(typeof receipt.registry.detail.path, 'string');

  // no credential material of any kind
  assert.equal(/Bearer\s+[A-Za-z0-9]/.test(raw), false, 'the receipt carries an authorization value');
  assert.equal(/"(token|secret|password|credential)[a-z_]*"\s*:\s*"[^"]+"/i.test(raw), false,
    'the receipt carries a credential-valued field');
});

test('verify: VERIFIED when the installed runtime matches its receipt', async () => {
  const dir = scratch('opui-inst');
  const home = join(dir, 'home');
  const host = makeHost({ home, archonPort: archon.port });

  // Install from a source copy whose manifest carries `gitHead` — the shape a
  // BRANCH-packed artifact has. (The working tree has none, which is exactly the
  // D0 finding, and the next test pins that UNVERIFIED result.)
  const src = makeSourceCopy(join(dir, 'src'), { corruptEntry: false });
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  pkg.gitHead = 'c'.repeat(40);
  writeFileSync(join(src, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  const ins = JSON.parse(runCli(['install', '--json'], { env: host.env, bin: join(src, 'bin', 'dsh-operator-ui.mjs') }).stdout);
  assert.equal(ins.state, 'INSTALLED');
  assert.equal(ins.package.source_commit, 'c'.repeat(40));

  // Driven in-process so the host-compatibility leg can be held CONSTANT. The
  // ambient DSH version is not a property of this test's subject (does the
  // installed runtime match its receipt?), and letting it in is precisely what
  // made this case pass in the working tree and fail in the frozen snapshot.
  // Host compatibility has its own tests; here it is pinned.
  const rep = await verifyInstalled({
    home, profile: 'web', env: host.env,
    deps: { hostCompatFn: () => ({ state: 'VERIFIED', version: PINNED_DSH, pin: PINNED_DSH, headline: 'pinned' }) },
  });
  assert.equal(rep.exit_code, EXIT.OK, JSON.stringify(rep.findings));
  assert.equal(rep.state, 'VERIFIED');
  assert.deepEqual(rep.findings.filter((f) => f.state !== 'OK'), []);
});

test('verify: UNVERIFIED (not BLOCKED) when the installed artifact cannot name its commit', async () => {
  const dir = scratch('opui-inst');
  const home = join(dir, 'home');
  const host = makeHost({ home, archonPort: archon.port });
  runCli(['install', '--json'], { env: host.env });   // the working tree has no gitHead
  const r = runCli(['verify', '--json'], { env: host.env });
  const rep = JSON.parse(r.stdout);
  assert.equal(r.code, EXIT.UNVERIFIED);
  assert.equal(rep.state, 'UNVERIFIED');
  const prov = rep.findings.find((f) => f.id === 'provenance');
  assert.equal(prov.state, 'UNVERIFIED');
  assert.match(prov.reason, /gitHead/);
  // everything that IS checkable about the install still passes
  assert.equal(rep.findings.find((f) => f.id === 'boot').state, 'OK');
  assert.equal(rep.findings.find((f) => f.id === 'registration').state, 'OK');
});

test('verify: BLOCKED when nothing has been installed', async () => {
  const dir = scratch('opui-inst');
  const home = join(dir, 'home');
  const host = makeHost({ home, archonPort: archon.port });
  const r = runCli(['verify', '--json'], { env: host.env });
  assert.equal(r.code, EXIT.BLOCKED);
  assert.equal(JSON.parse(r.stdout).state, 'BLOCKED');
});

test('verify: BLOCKED when the durable copy has been deleted', async () => {
  const dir = scratch('opui-inst');
  const home = join(dir, 'home');
  const host = makeHost({ home, archonPort: archon.port });
  runCli(['install', '--json'], { env: host.env });
  // Renamed, not recursively deleted: the claim under test is "the recorded
  // location is gone", and one rename states it without a bulk delete.
  renameSync(durableOf(home), durableOf(home) + '.gone');
  const rep = JSON.parse(runCli(['verify', '--json'], { env: host.env }).stdout);
  assert.equal(rep.state, 'BLOCKED');
  assert.equal(rep.findings.find((f) => f.id === 'durable-copy').state, 'BLOCKED');
});

test('verify: BLOCKED when the installed bytes have been modified since the receipt', async () => {
  const dir = scratch('opui-inst');
  const home = join(dir, 'home');
  const host = makeHost({ home, archonPort: archon.port });
  runCli(['install', '--json'], { env: host.env });
  writeFileSync(join(durableOf(home), 'lib', 'index.js'), '// tampered\n');
  const rep = JSON.parse(runCli(['verify', '--json'], { env: host.env }).stdout);
  assert.equal(rep.state, 'BLOCKED');
  const f = rep.findings.find((x) => x.id === 'durable-copy');
  assert.equal(f.state, 'BLOCKED');
  assert.match(f.reason, /no longer match the receipt digest/);
});

test('verify: BLOCKED when the profile has been repointed at another location', async () => {
  const dir = scratch('opui-inst');
  const home = join(dir, 'home');
  const host = makeHost({ home, archonPort: archon.port });
  runCli(['install', '--json'], { env: host.env });
  const pkgPath = join(home, 'profiles', 'web', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.dependencies['dsh-operator-ui'] = 'link:' + join(dir, 'somewhere-else');
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  const rep = JSON.parse(runCli(['verify', '--json'], { env: host.env }).stdout);
  assert.equal(rep.state, 'BLOCKED');
  assert.match(rep.findings.find((f) => f.id === 'registration').reason, /not at the receipted durable location/);
});

test('D1 durability: the installed package runs with no source checkout in play', async () => {
  const dir = scratch('opui-inst');
  const home = join(dir, 'home');
  const host = makeHost({ home, archonPort: archon.port });
  runCli(['install', '--json'], { env: host.env });
  const durable = durableOf(home);

  // (a) nothing in the durable tree points back at the source checkout — the
  //     installed artifact carries no hidden dependency on where it was built
  const { execFileSync } = await import('node:child_process');
  let refs = '';
  try { refs = execFileSync('grep', ['-rl', REPO, durable], { encoding: 'utf8' }).trim(); }
  catch (e) { refs = e.status === 1 ? '' : 'grep failed'; }
  assert.equal(refs, '', 'the durable tree references the source checkout: ' + refs);

  // (b) the installed package's OWN bin runs, from a neutral working directory,
  //     with no npm cache and no npx temp dir involved
  const r = runCli(['verify', '--json'], { env: host.env, bin: join(durable, 'bin', 'dsh-operator-ui.mjs'), cwd: tmpdir() });
  assert.equal(r.code, EXIT.UNVERIFIED, 'the installed bin must run: ' + r.stderr);
  assert.equal(JSON.parse(r.stdout).state, 'UNVERIFIED');   // only provenance, as above

  // (c) and it still boots after the tree is RELOCATED — a reboot, a moved home,
  //     or an npx temp dir being reaped cannot break it
  const moved = join(dir, 'relocated');
  cpSync(durable, moved, { recursive: true });
  const boot = await import('node:child_process').then(({ spawnSync }) =>
    spawnSync(NODE, ['--input-type=module', '-e', 'await import(' + JSON.stringify('file://' + join(moved, 'lib', 'index.js')) + ')'],
      { encoding: 'utf8', cwd: tmpdir() }));
  assert.equal(boot.status, 0, 'the relocated copy failed to boot: ' + boot.stderr);
});

test('contentIdentity: two different builds of the same version are not identical', () => {
  // The D0 lesson, as a unit test: a version string is not an artifact identity.
  const dir = scratch();
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  makeSourceCopy(a, { corruptEntry: false });
  makeSourceCopy(b, { corruptEntry: false });
  assert.equal(contentIdentity(a).digest, contentIdentity(b).digest, 'identical trees must hash identically');
  writeFileSync(join(b, 'lib', 'index.js'), '// one byte different\n');
  assert.notEqual(contentIdentity(a).digest, contentIdentity(b).digest,
    'a changed file must change the identity even at the same version');
});
