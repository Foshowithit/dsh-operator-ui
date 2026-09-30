import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('packed plugin includes verification assets and Probe A passes offline', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'opui-pack-test-'));
  const packDir = join(temp, 'pack');
  const extractDir = join(temp, 'extract');
  const home = join(temp, 'dsh-home');
  await mkdir(packDir);
  await mkdir(extractDir);

  try {
    const packResult = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        PATH: process.env.PATH,
        HOME: temp,
        npm_config_cache: join(temp, 'npm-cache'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const packed = Array.isArray(packResult) ? packResult[0] : packResult['dsh-operator-ui'];
    const names = new Set(packed.files.map((file) => file.path));
    for (const required of [
      'system-manifest.json',
      'fixtures/verify-echo-v1.yaml',
      'fixtures/capability-registry.example.json',
    ]) assert.ok(names.has(required), `packed npm artifact is missing ${required}`);

    execFileSync('tar', ['-xzf', join(packDir, packed.filename), '-C', extractDir]);
    const packageRoot = join(extractDir, 'package');
    for (const required of [
      'system-manifest.json',
      'fixtures/verify-echo-v1.yaml',
      'fixtures/capability-registry.example.json',
    ]) await readFile(join(packageRoot, required));

    // Execute the extracted package in a fresh process with only disposable
    // home paths and PATH. No caller credentials/config can affect resolution.
    // The fetch stub prevents all network access; Probe B should fail closed.
    const script = `
      import { pathToFileURL } from 'node:url';
      globalThis.fetch = async () => { throw new Error('network disabled in package test'); };
      const verifier = await import(pathToFileURL(process.argv[1] + '/lib/verify.js').href);
      const result = await verifier.runVerification({});
      console.log(JSON.stringify({
        probeA: result.receipt.probes[0],
        decision: result.decision,
        probeBFailureCode: result.receipt.probes[1]?.failureCode,
      }));
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, packageRoot], {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 15000,
      env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output.trim());
    assert.equal(result.probeA.pass, true, 'Probe A should verify packed manifest and seed assets');
    assert.equal(result.probeA.failureCode, null);
    assert.equal(result.decision, 'SYSTEM_VERIFIED', 'offline Archon should prevent Probe B from claiming RCOS_VERIFIED');
    assert.equal(result.probeBFailureCode, 'archon-unavailable');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
