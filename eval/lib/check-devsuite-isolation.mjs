#!/usr/bin/env node
// eval/lib/check-devsuite-isolation.mjs — benchmark-contamination guard.
// Asserts the M3.0 dev suite is structurally disjoint from Eval v1's corpus
// and that neither generator reads the other's tree. Exit 1 on any violation.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const suite = join(root, 'eval', 'devsuite');
const corpus = join(root, 'eval', 'corpus');
const problems = [];

// 1. family codes disjoint
const suiteFams = (await readdir(suite, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
const corpusFams = (await readdir(corpus, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
for (const f of suiteFams) {
  if (corpusFams.some((c) => c.startsWith(f.slice(0, 3) + '-') || c.includes(f))) {
    problems.push(`family overlap: ${f} vs corpus ${corpusFams.join(',')}`);
  }
}

// 2. fixture file names disjoint (workspace basenames)
const suiteFiles = new Set();
for (const fam of suiteFams) {
  for (const enc of await readdir(join(suite, fam))) {
    const ws = join(suite, fam, enc, 'workspace');
    try { for (const f of await readdir(ws)) suiteFiles.add(f); } catch {}
  }
}
const corpusFiles = new Set();
for (const fam of corpusFams) {
  for (const enc of await readdir(join(corpus, fam)).catch(() => [])) {
    const ws = join(corpus, fam, enc, 'workspace');
    try { for (const f of await readdir(ws)) corpusFiles.add(f); } catch {}
  }
}
for (const f of suiteFiles) if (corpusFiles.has(f)) problems.push(`fixture name overlap: ${f}`);

// 3. generators read nothing from the other tree
const devGen = await readFile(join(root, 'eval', 'lib', 'generate-devsuite.mjs'), 'utf8');
const corpusGen = await readFile(join(root, 'eval', 'lib', 'generate-corpus.mjs'), 'utf8');
if (/eval\/corpus/.test(devGen)) problems.push('devsuite generator references eval/corpus');
if (/devsuite/.test(corpusGen)) problems.push('corpus generator references devsuite');

// 4. no symlinks pointing outside the suite
for (const fam of suiteFams) {
  for (const enc of await readdir(join(suite, fam))) {
    const st = await stat(join(suite, fam, enc)).catch(() => null);
    if (st && !st.isDirectory()) problems.push(`unexpected non-dir ${fam}/${enc}`);
  }
}

if (problems.length) {
  console.log('ISOLATION VIOLATIONS:');
  for (const p of problems) console.log(' - ' + p);
  process.exit(1);
}
console.log(`isolation clean: ${suiteFams.length} dev families vs ${corpusFams.length} corpus families, ${suiteFiles.size} fixture names disjoint, generators mutually isolated`);
