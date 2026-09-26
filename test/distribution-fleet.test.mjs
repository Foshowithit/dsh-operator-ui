import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const readJson = (relativePath) => JSON.parse(readFileSync(join(root, relativePath), 'utf8'));

test('the runtime package declares the seeded registry and capability fleet', () => {
  const pkg = readJson('package.json');
  const registry = readJson('fixtures/capability-registry.example.json');
  const ids = new Set(registry.capabilities.map((capability) => capability.id));
  const runtimePatterns = [
    'capabilities/*/README.md',
    'capabilities/*/adapter',
    'capabilities/*/contract.json',
    'capabilities/*/registry-entry.json',
  ];

  assert.ok(pkg.files.includes('fixtures'), 'the package must ship fixture and seed inputs');
  for (const pattern of runtimePatterns) {
    assert.ok(pkg.files.includes(pattern), `the package must ship ${pattern}`);
  }
  assert.ok(ids.has('rcos-verify-echo'), 'the seeded RCOS verification capability must remain present');
  for (const id of [
    'video-forensics-receipt',
    'filmstrip-verify',
    'audio-offline-verify',
    'qr-camo-embed',
  ]) {
    assert.ok(ids.has(id), `the OOB capability ${id} must remain discoverable`);
    assert.equal(readJson(`capabilities/${id}/registry-entry.json`).id, id);
    assert.ok(existsSync(join(root, `capabilities/${id}/adapter`)), `${id} must ship an adapter`);
  }
  assert.ok(existsSync(join(root, 'fixtures/workspace-word-count-v0-1-0.yaml')));
  assert.equal(
    pkg.files.some((entry) => entry.includes('/evals') || entry.includes('EVIDENCE')),
    false,
    'evaluation runs and evidence must stay out of the runtime package',
  );
});
