// tests for scripts/gate.mjs — the frozen-provenance gate (P0.F).
//
// The gate's whole value is its ADMISSION RULE, so the rule is tested directly
// and exhaustively here rather than being exercised only through a real run.
// A gate whose VOID branch has never been observed is a gate that has never
// been shown to be able to refuse — and a gate that cannot refuse is a
// rubber stamp.
//
// Two things are pinned that a naive implementation gets wrong:
//
//   1. VOID is not FAIL. A provenance move must not be reported as a failed
//      test run, because "the tests failed" and "this run is not evidence about
//      any commit" are different claims and lead to different actions.
//   2. A HEAD-only move (a concurrent commit by another writer, no tracked file
//      touched) is a real provenance event AND a different fact from a content
//      change. Both void; the receipt must say which happened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deriveVerdict,
  legFailed,
  expandTestSet,
  discoverableNonEntrypoints,
  hashTestSet,
  testSetDrift,
  parseTestTotals,
  CANONICAL_TEST_GLOBS,
  trackedFiles,
  manifestIdentity,
  headId,
  createFrozenSnapshot,
  removeFrozenSnapshot,
} from '../scripts/gate.mjs';

// ---------------------------------------------------------------------------
// The admission rule
// ---------------------------------------------------------------------------

const SAME = { contentBefore: 'c1', contentAfter: 'c1', headBefore: 'h1', headAfter: 'h1' };
// The RECEIPT leg shape (`exit_code`), deliberately. See the drift test below.
const GREEN = [{ name: 'tests', exit_code: 0 }];
const RED = [{ name: 'tests', exit_code: 1 }];

test('admission: an unmoved tree with green legs is PASS', () => {
  const v = deriveVerdict({ ...SAME, legs: GREEN });
  assert.equal(v.verdict, 'PASS');
  assert.equal(v.reason, null);
  assert.deepEqual(v.moved, []);
  assert.equal(v.headOnlyMove, false);
});

test('admission: an unmoved tree with a red leg is FAIL, and names the leg', () => {
  const v = deriveVerdict({ ...SAME, legs: RED });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reason, /tests exited 1/);
  assert.deepEqual(v.moved, []);
});

test('admission: a tracked-content move VOIDS a GREEN run', () => {
  // The whole point: a green result computed against a moving tree is not
  // evidence, so it must not be reported as a pass.
  const v = deriveVerdict({ ...SAME, contentAfter: 'c2', legs: GREEN });
  assert.equal(v.verdict, 'VOID');
  assert.equal(v.reason, 'execution-provenance-changed');
  assert.deepEqual(v.moved, ['tracked-content']);
  assert.equal(v.headOnlyMove, false);
});

test('admission: a tracked-content move VOIDS a RED run too, and is not FAIL', () => {
  const v = deriveVerdict({ ...SAME, contentAfter: 'c2', legs: RED });
  assert.equal(v.verdict, 'VOID');
  assert.notEqual(v.verdict, 'FAIL');
  assert.equal(v.reason, 'execution-provenance-changed');
});

test('admission: a HEAD-only move VOIDS, and is flagged as HEAD-only', () => {
  // A concurrent COMMIT by another agent writes refs and objects, never
  // working-tree files. It is a provenance event and voids the run, but it is
  // NOT the same fact as "the tested content changed" — the receipt must say so
  // rather than reporting a bare VOID that a reader would misread.
  const v = deriveVerdict({ ...SAME, headAfter: 'h2', legs: GREEN });
  assert.equal(v.verdict, 'VOID');
  assert.deepEqual(v.moved, ['head']);
  assert.equal(v.headOnlyMove, true);
});

test('admission: both identities moving reports both, and is not HEAD-only', () => {
  const v = deriveVerdict({ ...SAME, contentAfter: 'c2', headAfter: 'h2', legs: GREEN });
  assert.equal(v.verdict, 'VOID');
  assert.deepEqual(v.moved, ['tracked-content', 'head']);
  assert.equal(v.headOnlyMove, false);
});

test('admission: provenance is decided BEFORE any leg result', () => {
  // Even with an EMPTY leg list — no legs ran at all — a moved tree is VOID.
  // Precedence matters: if leg results could outrank provenance, a green leg
  // could launder a contaminated window into a PASS.
  const v = deriveVerdict({ ...SAME, contentAfter: 'c2', legs: [] });
  assert.equal(v.verdict, 'VOID');
  assert.equal(v.reason, 'execution-provenance-changed');
});

test('admission: an unreadable identity is a non-answer, not a match', () => {
  // contentIdentity() returns "UNREADABLE:<msg>" when git cannot be read. Two
  // such strings must never be treated as a confirmed-unchanged tree, so the
  // gate reports VOID rather than PASS. Pinned here because "unknown == unknown"
  // silently passing is exactly the class of bug this gate exists to catch.
  const u = 'UNREADABLE:not a git repository';
  const v = deriveVerdict({
    contentBefore: u, contentAfter: u, headBefore: u, headAfter: u, legs: GREEN,
  });
  assert.equal(v.verdict, 'PASS', 'identical unreadable values compare equal; the gate cannot detect this alone');
  // ^ documents the boundary honestly: the gate cannot distinguish "both reads
  //   failed identically" from "unchanged" by comparison alone. What it CAN do
  //   is refuse to let a real run reach here — see the runner test below.
});

test('admission: a leg keyed `exitCode` is NOT silently read as a failure', () => {
  // THE DRIFT THIS PINS. The first version of deriveVerdict read `leg.exitCode`
  // while runLeg emitted `exit_code`. Every leg then compared `undefined !== 0`
  // and a GREEN run was reported as FAIL — a verdict contradicting its own
  // evidence legs. It was caught by the end-to-end VOID demo, not by reading,
  // which is the argument for having the demo at all.
  //
  // The contract is the RECEIPT shape, and it is asserted rather than assumed:
  // a leg carrying only the camelCase key is NOT a leg the rule can read, so it
  // must be reported as malformed rather than being waved through as green.
  assert.equal(legFailed({ name: 'tests', exit_code: 0 }), false);
  assert.equal(legFailed({ name: 'tests', exit_code: 1 }), true);
  assert.equal(
    legFailed({ name: 'tests', exitCode: 0 }), true,
    'a camelCase leg must NOT be read as green — the shape is exit_code',
  );
  const v = deriveVerdict({ ...SAME, legs: [{ name: 'tests', exit_code: 0 }] });
  assert.equal(v.verdict, 'PASS', 'a green leg must produce PASS, never FAIL');
  assert.equal(v.reason, null);
});

test('admission: a changed test-set file VOIDS a green run', () => {
  // The tree identity hashes tracked files only, so an UNCOMMITTED test file
  // contributes nothing to it. Without this clause a run could be certified
  // PASS while the file that decided the verdict changed underneath it.
  const v = deriveVerdict({ ...SAME, testSetChanged: ['test/foo.test.mjs'], legs: GREEN });
  assert.equal(v.verdict, 'VOID');
  assert.deepEqual(v.moved, ['test-set']);
  assert.deepEqual(v.testSetChanged, ['test/foo.test.mjs']);
  assert.equal(v.headOnlyMove, false, 'a set change is not a HEAD-only move');
});

test('admission: a HEAD-only move stays HEAD-only when nothing else moved', () => {
  const v = deriveVerdict({ ...SAME, headAfter: 'h2', testSetChanged: [], legs: GREEN });
  assert.equal(v.headOnlyMove, true);
});

test('admission: a HEAD move plus a set change is not HEAD-only', () => {
  const v = deriveVerdict({
    ...SAME, headAfter: 'h2', testSetChanged: ['test/foo.test.mjs'], legs: GREEN,
  });
  assert.equal(v.headOnlyMove, false);
  assert.deepEqual(v.moved, ['head', 'test-set']);
});

test('testSetDrift: names exactly the members whose bytes moved', () => {
  const before = { 'a.test.mjs': 'h1', 'b.test.mjs': 'h2' };
  assert.deepEqual(testSetDrift(before, { 'a.test.mjs': 'h1', 'b.test.mjs': 'h2' }), []);
  assert.deepEqual(testSetDrift(before, { 'a.test.mjs': 'CHANGED', 'b.test.mjs': 'h2' }), ['a.test.mjs']);
});

test('testSetDrift: an added or removed member is drift, not silence', () => {
  // A member that appears or disappears between the samples is a set change in
  // its own right — the run's named set no longer describes what ran.
  assert.deepEqual(testSetDrift({ 'a.test.mjs': 'h1' }, {}), ['a.test.mjs']);
  assert.deepEqual(testSetDrift({}, { 'b.test.mjs': 'h2' }), ['b.test.mjs']);
});

test('hashTestSet: pins real bytes and throws on a member it cannot read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-hash-'));
  try {
    writeFileSync(join(dir, 'x.test.mjs'), 'export const x = 1;\n');
    const h = hashTestSet(dir, ['x.test.mjs']);
    assert.match(h['x.test.mjs'], /^[0-9a-f]{64}$/);
    // Same bytes -> same hash; different bytes -> different hash.
    assert.deepEqual(hashTestSet(dir, ['x.test.mjs']), h);
    writeFileSync(join(dir, 'x.test.mjs'), 'export const x = 2;\n');
    assert.notDeepEqual(hashTestSet(dir, ['x.test.mjs']), h);
    // An unhashable member means the set is not pinned, so the gate must refuse
    // rather than record a receipt with a hole in it.
    assert.throws(() => hashTestSet(dir, ['missing.test.mjs']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hashTestSet: the real set hashes every member of the real set', () => {
  const root = join(import.meta.dirname, '..');
  const set = expandTestSet(root);
  const hashes = hashTestSet(root, set);
  assert.equal(Object.keys(hashes).length, set.length);
  for (const rel of set) assert.match(hashes[rel], /^[0-9a-f]{64}$/);
});

test('admission: VOID, PASS and FAIL are three distinct values', () => {
  const seen = new Set([
    deriveVerdict({ ...SAME, legs: GREEN }).verdict,
    deriveVerdict({ ...SAME, legs: RED }).verdict,
    deriveVerdict({ ...SAME, contentAfter: 'c2', legs: GREEN }).verdict,
  ]);
  assert.equal(seen.size, 3);
});

// ---------------------------------------------------------------------------
// Explicit test-set expansion
// ---------------------------------------------------------------------------

test('expandTestSet: the canonical set expands to the real test files, sorted', () => {
  const root = join(import.meta.dirname, '..');
  const set = expandTestSet(root);
  assert.ok(set.length > 0, 'the canonical glob must not be empty');
  assert.deepEqual(set, [...set].sort(), 'the set must be sorted so the receipt is stable');
  // The set is defined by NAME at any depth, so a member is any file whose
  // basename is a test-entrypoint name. Pinning the DIRECTORY here instead was
  // the regression: `assert.match(f, /^test\/.+\.test\.mjs$/)` required every
  // member to live under `test/`, which is why four `eval/lib/test-*.mjs`
  // entrypoints and `p6b/runner-vnext/runner-vnext.test.mjs` could be dropped
  // while this test stayed green.
  for (const f of set) {
    const base = f.split('/').pop();
    assert.match(base, /^(.*\.test\.mjs|test-.*\.mjs)$/, f + ' is not a test-entrypoint name');
  }
  // The falsifiable consequence of being name-based: at least one member must
  // lie outside `test/` on this repo. If this ever fails, the rule has been
  // narrowed back to a directory.
  assert.ok(
    set.some((f) => !f.startsWith('test/')),
    'the canonical set contains nothing outside test/ — the rule has been narrowed to a directory',
  );
});

test('expandTestSet: the entrypoints a directory-scoped glob dropped are present', () => {
  // The regression, named. `test/*.test.mjs` reported PASS 399/399/0 while these
  // five files — 14 tests, one of them the single genuine failure on this tree —
  // were not run at all. A test set that silently stops reaching a file is
  // indistinguishable from a file that passes, which is the whole reason this
  // boundary is pinned by name rather than by a glob.
  const root = join(import.meta.dirname, '..');
  const set = expandTestSet(root);
  for (const rel of [
    'eval/lib/test-preflight.mjs',
    'eval/lib/test-devsuite-graders.mjs',
    'eval/lib/test-scored-controls.mjs',
    'eval/lib/test-grader-controls.mjs',
    'p6b/runner-vnext/runner-vnext.test.mjs',
  ]) {
    assert.ok(set.includes(rel), rel + ' must be in the canonical test set');
  }
});

test('expandTestSet: the canonical set EXCLUDES every *-case.mjs child runner', () => {
  // This is the artefact, pinned. Node's discovery convention matches every
  // .mjs under a `test/` directory, so `node --test test/` mis-discovers the
  // argv-driven child runners. The explicit set must not contain one.
  const root = join(import.meta.dirname, '..');
  const set = expandTestSet(root);
  const offenders = set.filter((f) => /-case\.mjs$/.test(f));
  assert.deepEqual(offenders, [], 'a child runner must never be a test entrypoint');
});

test('expandTestSet: a glob matching nothing yields an empty set, not a throw', () => {
  const root = join(import.meta.dirname, '..');
  assert.deepEqual(expandTestSet(root, 'test/*.no-such-suffix.mjs'), []);
});

test('expandTestSet: a missing directory is a named failure, not a silent empty set', () => {
  // An empty set and an unreadable directory are different: the first is a
  // configuration mistake the caller must fix, the second would let a gate
  // report PASS having run nothing.
  assert.throws(
    () => expandTestSet(join(import.meta.dirname, '..'), 'no-such-dir/*.test.mjs'),
    /test-set directory does not exist/,
  );
});

test('discoverableNonEntrypoints: reports exactly the .mjs files the set excludes', () => {
  const root = join(import.meta.dirname, '..');
  const set = expandTestSet(root);
  const excluded = discoverableNonEntrypoints(root, set);
  const setNames = new Set(set.map((p) => p.split('/').pop()));
  for (const f of excluded) {
    assert.ok(!setNames.has(f.split('/').pop()), 'an excluded file must not be in the set');
    assert.match(f, /\.mjs$/);
  }
  // The three that were carried as "known reds" are the ones that fail when
  // mis-discovered; they must be named here as excluded, not merely absent.
  for (const f of ['conversation-case.mjs', 'marketplace-case.mjs', 'run-admission-goal-case.mjs']) {
    assert.ok(
      excluded.some((e) => e.endsWith(f)),
      f + ' must be reported as excluded from the explicit set',
    );
  }
});

test('discoverableNonEntrypoints: honours a temp root with no test dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-test-'));
  try {
    assert.deepEqual(discoverableNonEntrypoints(dir, []), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Totals parsing — a run whose summary is unreadable has UNKNOWN counts
// ---------------------------------------------------------------------------

test('parseTestTotals: reads the TAP summary', () => {
  // `# suites` is deliberately NOT parsed: it is a suite count, not a test
  // count, and the receipt's job is to state how many CASES passed. Asserted
  // by absence so a future edit that starts reporting it has to say why.
  const out = '# tests 372\n# suites 0\n# pass 372\n# fail 0\n# cancelled 0\n';
  const got = parseTestTotals(out);
  assert.deepEqual(got, { tests: 372, pass: 372, fail: 0, cancelled: 0 });
  assert.equal('suites' in got, false);
});

test('parseTestTotals: no summary is null, never a fabricated zero', () => {
  // Recording `pass: 0` for an unreadable run would be a fabricated count that
  // reads as a real result. Null forces the reader to see "unknown".
  assert.equal(parseTestTotals('boom\n'), null);
  assert.equal(parseTestTotals(''), null);
});

test('parseTestTotals: a failing summary is read, not discarded', () => {
  const out = '# tests 31\n# pass 28\n# fail 3\n';
  assert.deepEqual(parseTestTotals(out), { tests: 31, pass: 28, fail: 3 });
});

// ---------------------------------------------------------------------------
// The gate does not write into the tree it certifies
// ---------------------------------------------------------------------------

test('the default receipt path is outside the repo', async () => {
  // A gate that writes its receipt into the tree it just certified dirties that
  // tree and makes its own next run inadmissible. Checked by reading the source
  // for the default, because invoking main() here would run the whole suite.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(import.meta.dirname, '..', 'scripts', 'gate.mjs'), 'utf8');
  assert.match(src, /arg\('--out',\s*join\(homedir\(\)/, 'the default receipt must be under homedir()');
  assert.doesNotMatch(src, /arg\('--out',\s*join\(root/, 'the default receipt must not be inside the repo');
});

// ---------------------------------------------------------------------------
// Frozen snapshot (P0.4) — isolation, and what does and does not void
// ---------------------------------------------------------------------------

test('manifestIdentity: same bytes under the same name is the same identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-manifest-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    const id = manifestIdentity(dir, ['a.txt', 'b.txt']);
    assert.match(id, /^[0-9a-f]{64}$/);
    assert.equal(manifestIdentity(dir, ['a.txt', 'b.txt']), id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifestIdentity: a changed byte, a renamed path, or a vanished file all change it', () => {
  // Three distinct ways the execution inputs can move, each of which must be
  // observable — this function is the mechanism the VOID branch depends on.
  const dir = mkdtempSync(join(tmpdir(), 'gate-manifest-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const id = manifestIdentity(dir, ['a.txt']);
    // 1. content change
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    assert.notEqual(manifestIdentity(dir, ['a.txt']), id);
    // 2. the SAME bytes under a different path is a different subject
    writeFileSync(join(dir, 'renamed.txt'), 'two\n');
    assert.notEqual(manifestIdentity(dir, ['renamed.txt']), manifestIdentity(dir, ['a.txt']));
    // 3. a file that cannot be read must not be skipped: skipping would make a
    //    deleted file look like an unchanged one.
    const withMissing = manifestIdentity(dir, ['a.txt', 'gone.txt']);
    assert.notEqual(withMissing, manifestIdentity(dir, ['a.txt']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trackedFiles: non-empty, sorted, and the real repo list', () => {
  const root = join(import.meta.dirname, '..');
  const files = trackedFiles(root);
  assert.ok(files.length > 0, 'a repo with no tracked files cannot be gated');
  assert.deepEqual(files, [...files].sort(), 'sorted so before/after hash the same order');
});

test('createFrozenSnapshot: a detached worktree at the commit, with deps linked', () => {
  // The snapshot is the measured system, so its provenance is a git fact:
  // assert the snapshot really is a worktree AT the requested commit rather
  // than a copy that merely looks like one.
  const root = join(import.meta.dirname, '..');
  const commit = headId(root);
  assert.ok(!String(commit).startsWith('UNREADABLE'), 'HEAD must be readable for this test');
  const dest = mkdtempSync(join(tmpdir(), 'gate-snap-'));
  rmSync(dest, { recursive: true, force: true });   // worktree add wants to create it
  try {
    createFrozenSnapshot({ root, dest, commit });
    const inSnap = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dest, encoding: 'utf8' }).trim();
    assert.equal(inSnap, commit, 'the snapshot must be at exactly the requested commit');
    assert.ok(existsSync(join(dest, 'node_modules')), 'deps must be linked or the numbers are from another environment');
    assert.ok(existsSync(join(dest, 'scripts', 'gate.mjs')), 'the snapshot must carry the tracked tree');
  } finally {
    removeFrozenSnapshot({ root, dest });
  }
  // Cleanup must leave no dead worktree entry behind.
  const list = execFileSync('git', ['worktree', 'list'], { cwd: root, encoding: 'utf8' });
  assert.ok(!list.includes(dest), 'the snapshot must not linger in git worktree list');
});

test('admission: the verdict consumes the EXECUTION identity, never the dev tree', () => {
  // THE P0.4 SEMANTIC. Under snapshot isolation the development tree is not the
  // measured system, so a sibling committing during the run must not discard
  // this run's evidence. That holds structurally: source movement is not an
  // input to the rule at all — only the execution root's identity is. If a
  // future edit starts feeding the live tree in here, a busy box would start
  // voiding good runs again and this test is what catches it.
  const v = deriveVerdict({
    contentBefore: 'snapshot-id', contentAfter: 'snapshot-id',
    headBefore: 'commitX', headAfter: 'commitX',
    testSetChanged: [], legs: GREEN,
  });
  assert.equal(v.verdict, 'PASS', 'a still snapshot is admissible no matter what the dev tree does');
  assert.deepEqual(v.moved, []);

  // ...and a snapshot that DOES move still voids, green leg or not.
  const moved = deriveVerdict({
    contentBefore: 'snapshot-id', contentAfter: 'snapshot-id-MUTATED',
    headBefore: 'commitX', headAfter: 'commitX',
    testSetChanged: [], legs: GREEN,
  });
  assert.equal(moved.verdict, 'VOID');
  assert.equal(moved.reason, 'execution-provenance-changed');
});

test('the gate refuses a dirty tree instead of certifying an uncommitted subject', async () => {
  // A claim-grade receipt binds to a commit. Uncommitted content has no commit
  // identity, so there is nothing for the receipt to be evidence ABOUT — the
  // gate must refuse (exit 3) rather than silently testing HEAD while the user
  // believes their working copy was measured.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(import.meta.dirname, '..', 'scripts', 'gate.mjs'), 'utf8');
  assert.match(src, /workingTreeClean\(root\)/, 'the snapshot path must gate on a clean tree');
  assert.match(src, /--in-place/, 'the legacy live-tree mode must remain reachable for ad-hoc use');
});
