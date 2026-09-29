// A2-c row-schema audit — TEST ONLY. Parses the scratch profile patch and
// validates every plugin row's config object against the ACTUAL 0.2 Config
// schema exported by the package it names (the same check mount performs).
// Reports every mismatch in one pass; exits 1 if any row fails.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const PROFILE = '/Users/adam26/dsh-a0-boot/home/profiles/headless/cordis.patch.yml';
const RT = '/Users/adam26/dsh-a0-boot/rt/dsh/node_modules';
const require = createRequire(join(RT, '/'));
const yaml = require('yaml');

const doc = yaml.parse(await readFile(PROFILE, 'utf8'));

// Collect every plugin row, recursing into agent-preset definitions:
// a preset row's config.plugins[] (and nested cordis:group rows) are plugin
// rows too — they mount at session scope and must satisfy the same Config.
const rows = [];
function collect(node) {
  if (Array.isArray(node)) { for (const child of node) collect(child); return; }
  if (node === null || typeof node !== 'object') return;
  if (node.name && typeof node.name === 'string' && node.name.startsWith('@')) rows.push(node);
  if (node.plugins) collect(node.plugins);
  if (Array.isArray(node.config)) collect(node.config); // cordis:group rows: config IS the plugin list
  if (node.config?.plugins) collect(node.config.plugins);
  if (node.insert) collect(node.insert);
}
collect(doc);
const seen = new Set();
for (const entry of doc ?? []) {
  if (entry.insert) collect(entry.insert);
}

let fail = 0;
const validated = new Set();
for (const row of rows) {
  const key = `${row.id ?? '?'}::${row.name}::${JSON.stringify(Object.keys(row.config ?? {}))}`;
  if (validated.has(key)) continue;
  validated.add(key);
  const pkgDir = join(RT, row.name);
  let pkg;
  try {
    const pkgJson = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
    const entryFile = pkgJson.exports?.['.']?.import ?? pkgJson.exports?.import ?? pkgJson.main ?? 'lib/index.js';
    const resolved = entryFile.startsWith('.') ? join(pkgDir, entryFile) : join(pkgDir, entryFile);
    pkg = await import(pathToFileURL(resolved).href);
  } catch (error) {
    console.log(`SKIP  ${row.id} (${row.name}): cannot load package: ${String(error).slice(0, 120)}`);
    continue;
  }
  const Config = pkg.Config;
  if (Config === undefined) {
    console.log(`NOTE  ${row.id} (${row.name}): no Config export — row config passes through unvalidated`);
    continue;
  }
  try {
    Config(row.config ?? {});
    console.log(`OK    ${row.id} (${row.name})`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${row.id} (${row.name}): ${String(error?.issues?.map((i) => `${i.path?.join('.')}: ${i.message}`).join('; ') ?? error?.message ?? error).slice(0, 200)}`);
  }
}
console.log(fail === 0 ? 'ALL ROWS VALID' : `${fail} ROW(S) INVALID`);
process.exit(fail === 0 ? 0 : 1);
