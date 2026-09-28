import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function readPackedFile(archive, rel) {
  const result = spawnSync('tar', ['-xOf', archive, `package/${rel}`], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, `archive must contain readable ${rel}: ${result.stderr}`);
  return result.stdout;
}

test('desktop package includes verifier manifest and seed runtime assets', () => {
  const destination = mkdtempSync(join(tmpdir(), 'dsh-operator-ui-pack-'));
  try {
    const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', destination, '--json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(packed.status, 0, `npm pack must succeed: ${packed.stderr}`);

    const parsed = JSON.parse(packed.stdout);
    const records = Array.isArray(parsed) ? parsed : Object.values(parsed);
    assert.equal(records.length, 1, 'npm pack must produce exactly one package record');
    const packData = records[0];
    assert.equal(typeof packData.filename, 'string');
    assert.ok(packData.filename.length > 0, 'npm pack record must name its archive');
    assert.ok(Array.isArray(packData.files), 'npm pack record must include its file inventory');
    const archive = join(destination, packData.filename);
    const archivePaths = new Set(packData.files.map((file) => file.path));
    for (const rel of [
      'system-manifest.json',
      'fixtures/verify-echo-v1.yaml',
      'fixtures/capability-registry.example.json',
    ]) {
      assert.ok(archivePaths.has(rel), `npm pack inventory must include ${rel}`);
    }

    const manifest = JSON.parse(readPackedFile(archive, 'system-manifest.json'));
    assert.equal(manifest.manifestVersion, 1);

    const workflow = readPackedFile(archive, 'fixtures/verify-echo-v1.yaml');
    assert.match(workflow, /rcos-verify-seed:rcos-verify-echo-v1/);
    const registry = JSON.parse(readPackedFile(archive, 'fixtures/capability-registry.example.json'));
    assert.ok(registry.capabilities.some((capability) => capability.id === 'rcos-verify-echo'));
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
