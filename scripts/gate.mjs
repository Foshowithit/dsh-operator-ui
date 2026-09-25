#!/usr/bin/env node
// scripts/gate.mjs — the frozen-provenance gate.
//
// WHY THIS EXISTS (P0.F, agreed with GPT 2026-09-25)
//
// A claim-grade result is only admissible if the tree under test was IMMUTABLE
// for the whole measurement window. This box has more than one writer: an
// autonomous agent, a sibling agent, and a human can all commit or edit while a
// suite runs. A single command can then observe TWO DIFFERENT IMPLEMENTATIONS
// OF THE SAME SYSTEM and produce a verdict that corresponds to neither commit —
// a nastier failure mode than ordinary test nondeterminism, because the verdict
// looks perfectly well-formed.
//
// So this gate binds every result to a tree identity, and when the tree moved it
// reports VOID — not PASS, not FAIL. A VOID is a statement that the run's
// evidence does not correspond to one tree; it is not a softer failure.
//
// IT ALSO OWNS AN EXPLICIT TEST SET. It expands the glob itself and records the
// expanded FILENAMES (and each file's content hash) in the receipt, so a receipt
// names exactly which files constituted the run instead of saying "372 pass".
// Implicit discovery is never used for claim-grade verification, and that is not
// fastidiousness: `node --test test/` also picks up the argv-driven `*-case.mjs`
// CHILD RUNNERS (Node's discovery convention matches every .mjs under a `test/`
// directory), and three of them fail when invoked as test entrypoints. Those
// failures establish that the runner invoked something that was not designed to
// be a test, not that the product is broken. Measured 2026-09-25:
//
//   node --test test/*.test.mjs   ->  # tests 372  # pass 372  # fail 0
//   node --test test/             ->  the same, PLUS 6 mis-discovered child
//                                     runners, of which 3 fail
//
// ADMISSION RULE
//
//   content_before == content_after    tracked working-tree content
//   HEAD_before    == HEAD_after       the commit
//   test_set_bytes == test_set_bytes   the files that constituted the run
//   else  VERDICT = VOID, reason = execution-provenance-changed
//
// The third clause is not redundant with the first. The tree identity hashes
// TRACKED files only, so a test file that is not yet committed contributes
// nothing to it — a run could be certified PASS while the very file that
// decided the verdict changed underneath it. Hashing the set directly closes
// that gap.
//
// The two identities are reported SEPARATELY on purpose. A concurrent COMMIT by
// another writer moves HEAD without touching one tracked file; that is a real
// provenance event and still voids the run, but it is a different fact from
// "the tested content changed", and a reader must be able to tell them apart
// rather than being told only that the run was thrown away.
//
// USAGE
//
//   node scripts/gate.mjs                  check.js leg + test leg
//   node scripts/gate.mjs --tests-only     skip the contract check leg
//   node scripts/gate.mjs --check-only     skip the test leg
//   node scripts/gate.mjs --no-run         dry: print the expanded test set
//   node scripts/gate.mjs --out <path>     receipt path
//   node scripts/gate.mjs --quiet          suppress leg output on the console
//
// EXIT CODES (distinct so a caller cannot mistake VOID for FAIL)
//
//   0  PASS   1  FAIL   2  VOID   3  the gate could not run
//
// The receipt is written OUTSIDE the tree by default. A gate that writes into
// the tree it just certified would dirty that tree and make its own next run
// inadmissible — the receipt path is therefore deliberately not inside the repo.

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);

export const CANONICAL_TEST_GLOB = 'test/*.test.mjs';

// ---------------------------------------------------------------------------
// Explicit test-set expansion
// ---------------------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Expand a single-`*` glob in the basename of a repo-relative path. Deliberately
// tiny and dependency-free: the set is small and fixed, and an explicit expander
// is the point (it yields NAMES we can record, where a shell glob yields the
// same thing but leaves no record). Returns sorted repo-relative paths.
export function expandTestSet(root, glob) {
  const dir = dirname(glob);
  const base = basename(glob);
  const abs = join(root, dir);
  if (!existsSync(abs)) throw new Error('test-set directory does not exist: ' + dir);
  const re = new RegExp('^' + base.split('*').map(escapeRe).join('.*') + '$');
  return readdirSync(abs)
    .filter((f) => re.test(f))
    .sort()
    .map((f) => join(dir, f));
}

// Pin the BYTES of every file in the explicit set, not just its name.
//
// Why this is not redundant with the tree identity: the tree identity hashes
// TRACKED files only (`git ls-files`), so a test file that is not yet committed
// contributes nothing to it. A run could then be certified PASS while the very
// file that decided the verdict changed underneath it. Hashing the set directly
// closes that gap, and it is what lets a receipt name the exact bytes that
// produced the number rather than only the filename that held them.
//
// Returns { path: sha256 } and throws on a file it cannot read, because an
// unhashable member means the set is not pinned and the run is not admissible.
export function hashTestSet(root, set) {
  const out = {};
  for (const rel of set) {
    out[rel] = sha256(readFileSync(join(root, rel)));
  }
  return out;
}

// Which members of the set changed between the two samples. Sorted so the
// receipt is stable and a diff is readable.
export function testSetDrift(before, after) {
  const changed = [];
  const names = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const rel of [...names].sort()) {
    if (before[rel] !== after[rel]) changed.push(rel);
  }
  return changed;
}

// Every `.mjs` under `test/` is a candidate for implicit discovery, whether or
// not it is a test entrypoint. Recorded so the receipt can state how many
// non-entrypoint programs the explicit set is deliberately excluding.
export function discoverableNonEntrypoints(root, explicitSet) {
  const testDir = join(root, 'test');
  if (!existsSync(testDir)) return [];
  const chosen = new Set(explicitSet.map((p) => basename(p)));
  return readdirSync(testDir)
    .filter((f) => f.endsWith('.mjs') && !chosen.has(f))
    .sort()
    .map((f) => join('test', f));
}

// ---------------------------------------------------------------------------
// Tree identity
// ---------------------------------------------------------------------------

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function git(root, args) {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe', maxBuffer: 1 << 28 });
}

// HEAD as a commit id, or a named non-answer. A gate that cannot read HEAD must
// say so rather than inventing one — "unknown" is not a value that compares
// equal to itself, and the caller below depends on that.
export function headId(root) {
  try {
    return git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
  } catch (e) {
    return 'UNREADABLE:' + String((e && e.message) || e).slice(0, 80);
  }
}

// Content identity of the TRACKED working tree: every tracked path plus the
// sha256 of the bytes on disk right now. This is what makes "the tested content
// changed" observable independently of whether anyone committed.
export function contentIdentity(root) {
  let files;
  try {
    files = git(root, ['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean).sort();
  } catch (e) {
    return { id: 'UNREADABLE:' + String((e && e.message) || e).slice(0, 80), files: 0 };
  }
  const h = createHash('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update('\0');
    let bytes;
    try {
      bytes = readFileSync(join(root, rel));
    } catch {
      // A tracked file that is missing or unreadable is a distinct state from
      // "unchanged", so it must hash differently rather than being skipped.
      h.update('UNREADABLE');
      h.update('\0');
      continue;
    }
    h.update(sha256(bytes));
    h.update('\0');
  }
  return { id: h.digest('hex'), files: files.length };
}

// The third signal, recorded because it is what a human would look at first.
export function porcelain(root) {
  try {
    return git(root, ['status', '--porcelain']).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verdict derivation (pure — the whole admission rule is testable without a run)
// ---------------------------------------------------------------------------

// The leg shape this rule consumes is the RECEIPT shape (`exit_code`), not a
// camelCase paraphrase of it. That is not cosmetic: the first version of this
// function read `leg.exitCode` while the runner emitted `exit_code`, so every
// leg compared `undefined !== 0` and a GREEN run was reported as FAIL — a
// verdict contradicting its own evidence legs, caught by the VOID demo rather
// than by reading. One name, one shape, and `legFailed` below is the only place
// the comparison happens so it cannot drift again.
export const legFailed = (leg) => leg.exit_code !== 0;

// Inputs are the two identities, the two HEADs, and the legs' exit codes.
// Precedence is deliberate: provenance is decided BEFORE any leg result, because
// a leg result computed against a moving tree is not evidence about anything.
export function deriveVerdict({
  contentBefore, contentAfter, headBefore, headAfter, testSetChanged = [], legs = [],
}) {
  const contentMoved = contentBefore !== contentAfter;
  const headMoved = headBefore !== headAfter;
  const setMoved = testSetChanged.length > 0;
  if (contentMoved || headMoved || setMoved) {
    const moved = [];
    if (contentMoved) moved.push('tracked-content');
    if (headMoved) moved.push('head');
    if (setMoved) moved.push('test-set');
    return {
      verdict: 'VOID',
      reason: 'execution-provenance-changed',
      moved,
      // Named explicitly so a HEAD-only move is not confused with a content
      // change. Both void the run; they are not the same event.
      headOnlyMove: !contentMoved && !setMoved && headMoved,
      testSetChanged,
    };
  }
  const failed = legs.filter(legFailed);
  if (failed.length) {
    return {
      verdict: 'FAIL',
      reason: failed.map((l) => l.name + ' exited ' + l.exit_code).join('; '),
      moved: [],
      headOnlyMove: false,
      testSetChanged: [],
    };
  }
  return { verdict: 'PASS', reason: null, moved: [], headOnlyMove: false, testSetChanged: [] };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const TEST_TOTALS_RE = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm;

export function parseTestTotals(stdout) {
  const out = {};
  for (const m of String(stdout).matchAll(TEST_TOTALS_RE)) out[m[1]] = Number(m[2]);
  // Absent is not zero. A run whose summary could not be read has UNKNOWN
  // counts, and recording 0 would be a fabricated pass count.
  return Object.keys(out).length ? out : null;
}

function runLeg({ name, argv, cwd, artifactDir, quiet }) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const res = spawnSync(process.execPath, argv, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  const finishedAt = new Date().toISOString();
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const outPath = join(artifactDir, name + '.stdout.txt');
  const errPath = join(artifactDir, name + '.stderr.txt');
  writeFileSync(outPath, stdout);
  writeFileSync(errPath, stderr);
  if (!quiet) {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  }
  return {
    name,
    command: [process.execPath, ...argv],
    exit_code: res.status === null ? null : res.status,
    signal: res.signal || null,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Date.now() - t0,
    stdout_artifact: outPath,
    stderr_artifact: errPath,
    stdout_sha256: sha256(Buffer.from(stdout)),
    stderr_sha256: sha256(Buffer.from(stderr)),
    totals: name === 'tests' ? parseTestTotals(stdout) : null,
  };
}

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (flag) => process.argv.includes(flag);

async function main() {
  const root = ROOT;
  const glob = arg('--test-glob', CANONICAL_TEST_GLOB);
  const quiet = has('--quiet');
  const noRun = has('--no-run');
  const checkOnly = has('--check-only');
  const testsOnly = has('--tests-only');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = arg('--out', join(homedir(), 'rcos-gate-receipt.json'));
  const artifactDir = join(homedir(), '.rcos-gate', stamp);

  // --- the explicit set, expanded and named BEFORE anything runs -------------
  let testSet;
  try {
    testSet = expandTestSet(root, glob);
  } catch (e) {
    console.error('GATE COULD NOT RUN: ' + e.message);
    process.exit(3);
  }
  if (!testSet.length) {
    console.error('GATE COULD NOT RUN: the explicit test set ' + glob + ' expanded to zero files');
    process.exit(3);
  }
  const excluded = discoverableNonEntrypoints(root, testSet);

  if (noRun) {
    console.log('explicit test set (' + testSet.length + ' files) from ' + glob + ':');
    for (const f of testSet) console.log('  ' + f);
    console.log('\ndeliberately EXCLUDED from the explicit set (' + excluded.length + '):');
    for (const f of excluded) console.log('  ' + f);
    process.exit(0);
  }

  mkdirSync(artifactDir, { recursive: true });

  const headBefore = headId(root);
  const contentBefore = contentIdentity(root);
  const porcelainBefore = porcelain(root);
  let setHashesBefore;
  try {
    setHashesBefore = hashTestSet(root, testSet);
  } catch (e) {
    console.error('GATE COULD NOT RUN: the explicit test set could not be hashed — ' + ((e && e.message) || e));
    process.exit(3);
  }
  const startedAt = new Date().toISOString();

  const legs = [];
  if (!testsOnly) {
    legs.push(runLeg({
      name: 'contract-check',
      argv: ['scripts/check.js'],
      cwd: root, artifactDir, quiet,
    }));
  }
  if (!checkOnly) {
    // Passed as explicit filenames. `--test` with a directory would re-enable
    // implicit discovery and re-admit the child runners this gate excludes.
    legs.push(runLeg({
      name: 'tests',
      argv: ['--test', ...testSet],
      cwd: root, artifactDir, quiet,
    }));
  }

  const finishedAt = new Date().toISOString();
  const headAfter = headId(root);
  const contentAfter = contentIdentity(root);
  const porcelainAfter = porcelain(root);
  let setHashesAfter;
  try {
    setHashesAfter = hashTestSet(root, testSet);
  } catch (e) {
    // A member that vanished mid-run is a set change, not a crash: the run's
    // evidence no longer corresponds to the set it named.
    setHashesAfter = null;
    console.error('note: the explicit test set could not be re-hashed — ' + ((e && e.message) || e));
  }
  const setChanged = setHashesAfter === null
    ? testSet.slice()
    : testSetDrift(setHashesBefore, setHashesAfter);

  const v = deriveVerdict({
    contentBefore: contentBefore.id, contentAfter: contentAfter.id,
    headBefore, headAfter,
    testSetChanged: setChanged,
    legs,
  });

  const receipt = {
    gate: 'scripts/gate.mjs',
    gate_version: 1,
    verdict: v.verdict,
    reason: v.reason,
    moved: v.moved,
    head_only_move: v.headOnlyMove,
    admission_rule: 'content_before == content_after AND HEAD_before == HEAD_after, else VOID',
    repo: root,
    started_at: startedAt,
    finished_at: finishedAt,
    tree_before: contentBefore.id,
    tree_after: contentAfter.id,
    head_before: headBefore,
    head_after: headAfter,
    tracked_files: contentBefore.files,
    porcelain_before: porcelainBefore,
    porcelain_after: porcelainAfter,
    test_glob: glob,
    expanded_test_set: testSet,
    expanded_test_set_count: testSet.length,
    // The exact BYTES that produced the numbers, not only the filenames that
    // held them. Independent of the tree identity, which covers tracked files
    // only — so this is what pins an uncommitted test file.
    test_set_hashes_before: setHashesBefore,
    test_set_hashes_after: setHashesAfter,
    test_set_changed: setChanged,
    excluded_from_explicit_set: excluded,
    excluded_reason: 'not test entrypoints (argv-driven child runners); implicit discovery mis-runs them',
    legs,
    receipt_path: outPath,
  };
  writeFileSync(outPath, JSON.stringify(receipt, null, 2));

  // --- human summary --------------------------------------------------------
  const bar = '='.repeat(78);
  console.log('\n' + bar);
  console.log('RCOS FROZEN-PROVENANCE GATE');
  console.log(bar);
  console.log('verdict       : ' + v.verdict + (v.reason ? '  (' + v.reason + ')' : ''));
  if (v.moved.length) console.log('moved         : ' + v.moved.join(', ') + (v.headOnlyMove ? '  [HEAD-only: a concurrent commit, no tracked file changed]' : ''));
  console.log('HEAD          : ' + headBefore + (headBefore === headAfter ? '  (unchanged)' : '  -> ' + headAfter));
  console.log('tree          : ' + contentBefore.id.slice(0, 16) + '...' + (contentBefore.id === contentAfter.id ? '  (unchanged)' : '  -> ' + contentAfter.id.slice(0, 16) + '...'));
  console.log('tracked files : ' + contentBefore.files);
  console.log('explicit set  : ' + testSet.length + ' files from ' + glob + ' (' + excluded.length + ' non-entrypoint .mjs excluded)');
  console.log('set bytes     : ' + Object.keys(setHashesBefore).length + ' hashed' + (setChanged.length ? '  ' + setChanged.length + ' CHANGED: ' + setChanged.join(', ') : '  (unchanged)'));
  for (const l of legs) {
    const totals = l.totals
      ? '  tests=' + l.totals.tests + ' pass=' + l.totals.pass + ' fail=' + l.totals.fail
      : '';
    console.log('leg           : ' + l.name + ' exit=' + l.exit_code + totals);
  }
  console.log('receipt       : ' + outPath);
  console.log('artifacts     : ' + artifactDir);
  console.log(bar);

  if (v.verdict === 'VOID') {
    console.log('VOID is neither a pass nor a failure: the run does not correspond to one tree.');
    console.log('Re-run on a quiet tree. Do not record this run as evidence.');
    process.exit(2);
  }
  process.exit(v.verdict === 'PASS' ? 0 : 1);
}

// Only run when invoked as a program, so the pure helpers above are importable
// by the test suite without executing a gate.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error('GATE COULD NOT RUN: ' + ((e && e.stack) || e));
    process.exit(3);
  });
}
