#!/usr/bin/env node
// eval/lib/generate-corpus.mjs — Eval Protocol v1 corpus generator.
//
// Deterministic: a fixed seed drives every variant, so regenerating the
// corpus anywhere produces byte-identical folders (and identical hashes).
// Output: eval/corpus/<FAMILY>/encounter-<N>/ with
//   workspace/     the fixture files the objective runs against
//   objective.txt  the natural-language objective (what both systems see)
//   expected.json  the post-hoc checker spec (expected.json is NEVER shown
//                  to the system under test — it grades the evidence)
//
// Anti-contamination: encounters 3-5 are the HELD-OUT variants. Their
// folders are generated with the rest (deterministic) but the manifest
// records them as hidden=true; the scored-run driver refuses to expose a
// hidden folder's workspace before its encounter.
//
// Usage: node eval/lib/generate-corpus.mjs [--out eval/corpus] [--seed 20260916]

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const OUT = join(root, argOf('--out', 'eval/corpus'));
const SEED = Number(argOf('--seed', 20260916));

// Deterministic PRNG (mulberry32) + integer helper.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const pick = (r, arr) => arr[int(r, 0, arr.length - 1)];
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const WORDS = ['alpha', 'bravo', 'delta', 'echo', 'kilo', 'nova', 'orbit', 'pixel', 'quartz', 'relay', 'sigma', 'tango', 'unity', 'vector', 'willow', 'xenon'];
const TOPICS = ['report', 'summary', 'index', 'ledger', 'catalog', 'journal', 'register'];

const PATHOLOGIES = ['', '', '', 'irrelevant/', '', 'notes/', ''];

// ---- family generators -------------------------------------------------
// Each returns, for an encounter, { workspace: {relpath: content},
// objective, expected }. expected.json is the post-hoc grader spec.

function f01TextStats(r) {
  const files = {};
  const n = int(r, 1, 4);
  const expect = { family: 'F01', files: {} };
  for (let i = 0; i < n; i++) {
    const name = (i === 0 ? 'README' : pick(r, TOPICS) + '-' + int(r, 1, 99)) + '.txt';
    const lines = int(r, 1, 6);
    const body = Array.from({ length: lines }, () => Array.from({ length: int(r, 1, 8) }, () => pick(r, WORDS)).join(' ')).join('\n') + '\n';
    files[name] = body;
    const words = body.trim().split(/\s+/).length;
    expect.files[name] = { lines, words, bytes: Buffer.byteLength(body) };
  }
  expect.total = {
    lines: Object.values(expect.files).reduce((a, f) => a + f.lines, 0),
    words: Object.values(expect.files).reduce((a, f) => a + f.words, 0),
    bytes: Object.values(expect.files).reduce((a, f) => a + f.bytes, 0),
  };
  const where = pick(r, PATHOLOGIES);
  const wfiles = {};
  for (const [k, v] of Object.entries(files)) wfiles[where ? where + k : k] = v;
  return {
    workspace: wfiles,
    objective: 'Count the lines, words, and bytes of every .txt file in the workspace (including subdirectories), and report the totals across all of them.',
    expected: expect,
  };
}

function f02RepoInspect(r) {
  const dirs = ['src', 'docs', 'tests'].slice(0, int(r, 2, 3));
  const files = {};
  const expect = { family: 'F02', byType: {}, total: 0 };
  for (const d of dirs) {
    const n = int(r, 1, 3);
    for (let i = 0; i < n; i++) {
      const ext = pick(r, ['js', 'md', 'json']);
      const name = `${d}/${pick(r, TOPICS)}-${int(r, 1, 20)}.${ext}`;
      files[name] = '// placeholder\n'.repeat(int(r, 1, 4));
      expect.byType[ext] = (expect.byType[ext] || 0) + 1;
      expect.total += 1;
    }
  }
  const todoFile = `${pick(r, dirs)}/${pick(r, TOPICS)}.md`;
  files[todoFile] = '# notes\n- TODO: fill me\n- done item\n';
  expect.todoCount = 1;
  return {
    workspace: files,
    objective: 'Inventory this repository: report how many files there are by extension (.js, .md, .json), the total file count, and how many TODO items the repository contains.',
    expected: expect,
  };
}

function f03Extraction(r) {
  const recs = int(r, 2, 5);
  const lines = [];
  const expect = { family: 'F03', fields: {} };
  for (let i = 0; i < recs; i++) {
    const host = pick(r, WORDS) + '-' + int(r, 1, 9) + '.example.test';
    const port = int(r, 1000, 9999);
    lines.push(`host: ${host}`, `port: ${port}`, '');
    expect.fields[host] = port;
  }
  return {
    workspace: { 'config.txt': lines.join('\n') },
    objective: 'Extract every host and port pair from config.txt and report them as host=port, one per line, in the order they appear.',
    expected: expect,
  };
}

function f04Transform(r) {
  const n = int(r, 3, 8);
  const words = Array.from({ length: n }, () => pick(r, WORDS));
  const messy = words.map((w) => (r() < 0.5 ? w.toUpperCase() : w)).map((w) => w + (r() < 0.5 ? '  ' : ' ')).join('\n') + '\n';
  return {
    workspace: { 'list.txt': messy },
    objective: 'Clean up list.txt: trim trailing whitespace, lowercase everything, sort the lines alphabetically, and save the result as sorted.txt (one word per line).',
    expected: { family: 'F04', sorted: [...words].map((w) => w.toLowerCase()).sort(), file: 'sorted.txt' },
  };
}

function f05Validation(r) {
  const need = ['manifest.json', 'readme.md'];
  const files = { 'manifest.json': JSON.stringify({ name: 'pkg-' + pick(r, WORDS), files: ['a.txt', 'b.txt'] }, null, 2), 'readme.md': '# pkg\n' };
  const broken = r() < 0.5;
  files['a.txt'] = 'aaa\n';
  if (broken) files['b.txt'] = undefined; // manifest lists b.txt but it is missing
  else files['b.txt'] = 'bbb\n';
  const wfiles = Object.fromEntries(Object.entries(files).filter(([, v]) => v !== undefined));
  return {
    workspace: wfiles,
    objective: 'Validate this release against manifest.json: check that every file the manifest lists actually exists in the workspace. Report PASS if all present, otherwise FAIL with the missing file names.',
    expected: { family: 'F05', verdict: broken ? 'FAIL' : 'PASS', missing: broken ? ['b.txt'] : [] },
  };
}

function f06ReleasePrep(r) {
  const version = `1.${int(r, 0, 9)}.${int(r, 0, 9)}`;
  const changes = Array.from({ length: int(r, 2, 4) }, () => '- ' + pick(r, WORDS) + ': ' + pick(r, ['fixed', 'added', 'removed']) + ' ' + pick(r, WORDS));
  return {
    workspace: { 'CHANGELOG.md': '# Changelog\n\n## Unreleased\n' + changes.join('\n') + '\n', 'version.txt': version + '\n' },
    objective: 'Prepare release evidence: report the current version from version.txt and list the Unreleased changelog entries verbatim.',
    expected: { family: 'F06', version, entries: changes },
  };
}

function f07Duplicates(r) {
  const base = Array.from({ length: int(r, 4, 8) }, () => pick(r, WORDS) + '@test.invalid');
  const withDupes = [...base, ...base.slice(0, int(r, 1, 2))];
  const shuffled = withDupes.map((v) => ({ v, k: r() })).sort((a, b) => a.k - b.k).map((x) => x.v);
  const counts = {};
  for (const v of shuffled) counts[v] = (counts[v] || 0) + 1;
  return {
    workspace: { 'emails.txt': shuffled.join('\n') + '\n' },
    objective: 'emails.txt has one email per line. Report every email that appears MORE THAN ONCE, with its total count, most frequent first.',
    expected: { family: 'F07', duplicates: Object.entries(counts).filter(([, c]) => c > 1).map(([email, count]) => ({ email, count })) },
  };
}

function f08Conversion(r) {
  const rows = Array.from({ length: int(r, 2, 4) }, () => ({ name: pick(r, WORDS), qty: int(r, 1, 50) }));
  const csv = 'name,qty\n' + rows.map((x) => `${x.name},${x.qty}`).join('\n') + '\n';
  return {
    workspace: { 'stock.csv': csv },
    objective: 'Convert stock.csv to stock.json — a JSON array of objects with numeric qty: [{"name":"…","qty":N},…]',
    expected: { family: 'F08', json: rows },
  };
}

function f09LogAnalysis(r) {
  const levels = ['INFO', 'WARN', 'ERROR'];
  const lines = [];
  const counts = { INFO: 0, WARN: 0, ERROR: 0 };
  for (let i = 0; i < int(r, 8, 20); i++) {
    const lv = pick(r, levels);
    counts[lv] += 1;
    lines.push(`2026-09-16T10:${String(int(r, 10, 59)).padStart(2, '0')}:00Z ${lv} ${pick(r, WORDS)} service ok`);
  }
  return {
    workspace: { 'app.log': lines.join('\n') + '\n' },
    objective: 'From app.log, report the number of INFO, WARN, and ERROR lines (exactly those three counts).',
    expected: { family: 'F09', counts },
  };
}

function f10DependencyAudit(r) {
  const deps = {};
  for (let i = 0; i < int(r, 3, 5); i++) deps[pick(r, WORDS) + '-lib'] = `${int(r, 0, 3)}.${int(r, 0, 9)}.0`;
  const lock = Object.fromEntries(Object.entries(deps).map(([k, v]) => (r() < 0.25 ? [k, '0.0.1-stale'] : [k, v])));
  const mismatched = Object.keys(deps).filter((k) => lock[k] !== deps[k]);
  return {
    workspace: { 'package.json': JSON.stringify({ dependencies: deps }, null, 2), 'package-lock.json': JSON.stringify({ locked: lock }, null, 2) },
    objective: 'Compare package.json dependencies against package-lock.json (the "locked" object) and report every dependency whose locked version does not match the declared version.',
    expected: { family: 'F10', mismatches: mismatched },
  };
}

const FAMILIES = [
  ['F01-text-stats-workspace', f01TextStats],
  ['F02-repository-inspection', f02RepoInspect],
  ['F03-structured-extraction', f03Extraction],
  ['F04-line-transform', f04Transform],
  ['F05-validation-gate', f05Validation],
  ['F06-release-prep', f06ReleasePrep],
  ['F07-duplicate-report', f07Duplicates],
  ['F08-format-conversion', f08Conversion],
  ['F09-log-analysis', f09LogAnalysis],
  ['F10-dependency-audit', f10DependencyAudit],
];

// ---- generate -----------------------------------------------------------

await rm(OUT, { recursive: true, force: true });
const manifest = { protocol: 'eval-protocol-v1', seed: SEED, generatedAt: new Date().toISOString(), objectives: [] };
let rng = prng(SEED);
for (const [famName, gen] of FAMILIES) {
  for (let enc = 1; enc <= 5; enc++) {
    // Per-objective sub-seed: deterministic AND independent of generation order.
    const sub = prng(parseInt(sha256(`${famName}#${enc}:${SEED}`).slice(0, 8), 16));
    const spec = gen(sub);
    const dir = join(OUT, famName, 'encounter-' + enc);
    for (const [rel, content] of Object.entries(spec.workspace)) {
      if (content === undefined) continue;
      const p = join(dir, 'workspace', rel);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content, 'utf8');
    }
    await writeFile(join(dir, 'objective.txt'), spec.objective + '\n', 'utf8');
    await writeFile(join(dir, 'expected.json'), JSON.stringify(spec.expected, null, 2) + '\n', 'utf8');
    manifest.objectives.push({
      id: `${famName}/encounter-${enc}`,
      family: famName.split('-')[0],
      encounter: enc,
      hidden: enc >= 3, // held-out variants: never exposed to teaching before their scored encounter
      sha256: sha256(JSON.stringify(spec)),
    });
  }
}

// Interleaved stream: fixed public seed, families shuffled (Fisher-Yates with
// the PRNG), encounters 1..5 inside each family kept in order (an encounter
// can never precede its family's first appearance).
const stream = [];
const byFamily = new Map(FAMILIES.map(([f]) => [f, []]));
for (const o of manifest.objectives) byFamily.get(o.family === 'F01' ? 'F01-text-stats-workspace' : o.id.split('/')[0]).push(o);
const fams = FAMILIES.map(([f]) => f);
for (let i = fams.length - 1; i > 0; i--) {
  const j = int(rng, 0, i);
  [fams[i], fams[j]] = [fams[j], fams[i]];
}
const queues = new Map(fams.map((f) => [f, byFamily.get(f).slice().sort((a, b) => a.encounter - b.encounter)]));
while (queues.size) {
  const keys = [...queues.keys()];
  const f = keys[int(rng, 0, keys.length - 1)];
  stream.push(queues.get(f).shift().id);
  if (!queues.get(f).length) queues.delete(f);
}
manifest.stream = stream;

const manifestPath = join(root, 'eval', 'corpus-manifest.json');
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('corpus:', manifest.objectives.length, 'objectives →', OUT);
console.log('manifest:', manifestPath);
console.log('stream head:', manifest.stream.slice(0, 12).join(' '));
