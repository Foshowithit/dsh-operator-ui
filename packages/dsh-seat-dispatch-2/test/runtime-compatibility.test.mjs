import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const runtimeModules = process.env.DSH_RUNTIME_NODE_MODULES;

test('DSH 0.2.0-rc.1 accepts the dispatcher package peers', { skip: !runtimeModules }, async () => {
  const appBootPath = join(runtimeModules, '@deepseek-ai/dsh-app-boot/lib/index.js');
  const { evaluatePluginCompatibility } = await import(pathToFileURL(appBootPath));
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const issue = evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.1');

  assert.equal(issue, undefined, JSON.stringify(issue));
});
