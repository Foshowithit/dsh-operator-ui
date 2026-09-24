// Compatibility guard — lib/compat.js.
//
// Three things are being pinned here, in order of how easy they are to get
// silently wrong:
//
//   1. The semver table. The comparator is hand-written (the plugin ships one
//      runtime dependency and `semver` is not it), so every row below carries
//      the answer npm itself gives. A `satisfies()` that returned true for
//      everything would pass a naive test and ship — so the table is weighted
//      toward must-be-false rows, and one row exists purely as a negative
//      control.
//
//   2. Detection, proved per probe. detectDshVersion has three independent
//      sources (argv[1] ancestry, cwd ancestry, DSH_VERSION). Each is driven
//      in isolation so a broken one is named rather than masked by another
//      succeeding, plus a case with NO probes at all that must degrade to
//      UNKNOWN instead of inventing a version.
//
//   3. The verdicts flip. A guard that reports VERIFIED for any input is
//      worse than no guard: it manufactures confidence. Each judge is
//      asserted across its whole state set.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseVersion,
  compareVersions,
  satisfies,
  detectDshVersion,
  detectToolsVersion,
  judgeDsh,
  judgeTools,
  hostCompat,
  bannerBox,
  bannerLine,
  PINNED_DSH,
  PINNED_TOOLS_RANGE,
} from '../lib/compat.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ------------------------------------------------------------------ 1. semver
//
// Expected values are node-semver's answers, captured from `npx semver <v> -r
// <range>` against the real registry. Rows marked mustBeFalse are the ones a
// permissive comparator would get wrong.

test('satisfies() matches npm for every shape this project declares', () => {
  const MUST_BE_TRUE = [
    ['0.1.0-rc.8', '^0.1.0-rc.8'],   // the one version the peer range admits
    ['0.1.0', '^0.1.0-rc.8'],        // release outranks its own prerelease
    ['4.0.2', '^4.0.1'],             // cordis peer
    ['4.1.0', '^4.0.1'],
    ['0.1.6', '^0.1.5'],             // caret on 0.x may not cross minor
    ['22.1.0', '>=22.0.0'],
    ['1.2.3', '1.2.3'],
    ['1.9.0', '1.2.3 || 1.9.0'],     // an exact-version OR set admits its members
  ];
  const MUST_BE_FALSE = [
    ['0.1.1-rc.2', '^0.1.0-rc.8'],   // prerelease gate: tuple differs
    ['0.1.2-rc.1', '^0.1.0-rc.8'],
    ['0.1.5-rc.3', '^0.1.0-rc.8'],
    ['0.1.7-rc.2', '^0.1.0-rc.8'],
    ['0.0.1-rc.1', '^0.1.0-rc.8'],   // the `latest` dist-tag today
    ['0.2.0', '^0.1.0-rc.8'],        // caret bound on 0.x
    ['5.0.0', '^4.0.1'],
    ['4.0.0', '^4.0.1'],
    ['0.2.0', '^0.1.5'],             // caret must not cross the minor
    ['1.2.2', '1.2.3'],
    ['1.2.4', '1.2.3 || 1.9.0'],     // an exact-version range is not a floor
    ['1.9.0', '1.2.3 || 1.8.0'],
    ['1.0.0-rc.1', '^1.0.0'],        // prerelease gate on a 1.x range
    ['not-a-version', '^0.1.0-rc.8'],
  ];
  for (const [v, r] of MUST_BE_TRUE) {
    assert.equal(satisfies(v, r), true, `expected satisfies(${v}, ${r}) to be true`);
  }
  for (const [v, r] of MUST_BE_FALSE) {
    assert.equal(satisfies(v, r), false, `expected satisfies(${v}, ${r}) to be false`);
  }
  // Negative control: an always-true satisfies() would pass every MUST_BE_TRUE
  // row above and only this one catches it.
  assert.equal(satisfies('9.9.9', '<1.0.0'), false, 'vacuity control — satisfies() must be able to return false');
  assert.equal(satisfies('0.0.1', '^0.0.1'), true, 'vacuity control — and true');
});

test('the peer range admits exactly one published dsh-tools version', () => {
  // Every version dsh-tools has actually published (npm view ... versions).
  const PUBLISHED = [
    '0.0.1-rc.1', '0.0.1-rc.2', '0.0.1-rc.3', '0.0.1-rc.5',
    '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8',
    '0.1.1-rc.1', '0.1.1-rc.2',
    '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5', '0.1.2-rc.1',
    '0.1.3-alpha.2',
    '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3',
    '0.1.6-alpha.1', '0.1.6-alpha.2',
    '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2',
  ];
  const admitted = PUBLISHED.filter((v) => satisfies(v, PINNED_TOOLS_RANGE));
  assert.deepEqual(admitted, ['0.1.0-rc.8'],
    'the peer range should admit exactly 0.1.0-rc.8 — got ' + JSON.stringify(admitted));
});

test('version parsing and ordering follow semver precedence', () => {
  assert.deepEqual(parseVersion('v1.2.3-rc.1+build.5'), { major: 1, minor: 2, patch: 3, prerelease: ['rc', 1] });
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(null), null);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0, 'release > prerelease');
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0-rc.2') < 0);
  assert.ok(compareVersions('1.0.0-rc.2', '1.0.0-rc.10') < 0, 'numeric identifiers compare numerically');
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0, 'fewer fields ranks lower');
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-1') > 0, 'numeric identifiers rank below alphanumeric ones');
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.ok(Number.isNaN(compareVersions('1.2.3', 'garbage')));
});

// ------------------------------------------------------------------ 2. detection

async function fakeDshTree(version) {
  const base = await mkdtemp(join(tmpdir(), 'compat-dsh-'));
  const pkgDir = join(base, 'node_modules', '@deepseek-ai', 'dsh');
  await mkdir(join(pkgDir, 'lib'), { recursive: true });
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }, null, 2));
  await writeFile(join(pkgDir, 'lib', 'bin.js'), '// fake cli entry\n');
  return { base, argv1: join(pkgDir, 'lib', 'bin.js') };
}

test('detection finds the host version from the running CLI entry', async () => {
  const { base, argv1 } = await fakeDshTree('0.1.5-rc.3');
  try {
    // cwd and env deliberately empty: this asserts probe A alone is sufficient.
    const hit = detectDshVersion({ argv1, cwd: null, env: {} });
    assert.equal(hit.version, '0.1.5-rc.3');
    assert.equal(hit.source, 'package-ancestor');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('detection finds the host version from cwd alone', async () => {
  const { base, argv1 } = await fakeDshTree('0.1.0-rc.6');
  try {
    // argv1 points somewhere that cannot resolve: probe B alone must carry it.
    const hit = detectDshVersion({ argv1: null, cwd: dirname(dirname(dirname(argv1))), env: {} });
    assert.equal(hit.version, '0.1.0-rc.6');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('detection falls back to DSH_VERSION only when it parses', async () => {
  const good = detectDshVersion({ argv1: null, cwd: null, env: { DSH_VERSION: 'v0.1.7-rc.2' } });
  assert.equal(good.version, '0.1.7-rc.2');
  assert.equal(good.source, 'env:DSH_VERSION');

  const garbage = detectDshVersion({ argv1: null, cwd: null, env: { DSH_VERSION: 'latest' } });
  assert.equal(garbage.version, null, 'an unparseable DSH_VERSION must not be believed');
});

test('detection with no probes available degrades to UNKNOWN', () => {
  const miss = detectDshVersion({ argv1: null, cwd: null, env: {} });
  assert.equal(miss.version, null, 'must not invent a version');
  assert.equal(miss.source, null);
  assert.equal(judgeDsh(miss.version).state, 'UNKNOWN');
});

test('dsh-tools resolves from the plugin tree, and ABSENT is legal', () => {
  const bound = detectToolsVersion();
  assert.ok(bound.version === null || typeof bound.version === 'string',
    'dsh-tools detection must yield a version string or null, never anything else');
  // ABSENT must never read as a failure: the peer is OPTIONAL (COMPAT.md).
  const absent = detectToolsVersion({ fromFile: join(tmpdir(), 'no-such-plugin-index.js') });
  assert.equal(absent.version, null);
  assert.equal(judgeTools(absent.version).state, 'ABSENT');
  assert.equal(judgeTools(absent.version).ok, true, 'an absent OPTIONAL peer is not an error');
});

// ------------------------------------------------------------------ 3. verdicts

test('judgeDsh reports three distinct states and never claims VERIFIED without the pin', () => {
  const verified = judgeDsh(PINNED_DSH);
  const unverified = judgeDsh('0.1.5-rc.3');
  const unknown = judgeDsh(null);

  assert.equal(verified.state, 'VERIFIED');
  assert.equal(verified.ok, true);

  assert.equal(unverified.state, 'UNVERIFIED');
  assert.equal(unverified.ok, false);
  // The whole point of the guard: both numbers in one sentence.
  assert.ok(unverified.detail.includes('0.1.5-rc.3'), 'detail must name the detected version');
  assert.ok(unverified.detail.includes(PINNED_DSH), 'detail must name the pin');

  assert.equal(unknown.state, 'UNKNOWN');
  assert.equal(unknown.ok, false);
  assert.ok(unknown.detail.includes(PINNED_DSH), 'UNKNOWN must still tell the operator what WAS expected');

  // Vacuity control — a judge that returned one state for every input passes
  // nothing above on its own.
  assert.equal(new Set([verified.state, unverified.state, unknown.state]).size, 3,
    'the three inputs must produce three different states');
  assert.equal(verified.ok && unverified.ok && unknown.ok, false, 'not every input can be ok');
});

test('judgeTools distinguishes satisfied, mismatch and absent', () => {
  const sat = judgeTools('0.1.0-rc.8');
  const bad = judgeTools('0.1.5-rc.3');
  const absent = judgeTools(null);

  assert.equal(sat.state, 'SATISFIED');
  assert.equal(sat.ok, true);

  assert.equal(bad.state, 'MISMATCH');
  assert.equal(bad.ok, false);
  assert.ok(bad.detail.includes('0.1.5-rc.3') && bad.detail.includes(PINNED_TOOLS_RANGE),
    'a mismatch must name both the bound version and the declared range');

  assert.equal(absent.state, 'ABSENT');
  assert.equal(absent.ok, true);

  assert.equal(new Set([sat.state, bad.state, absent.state]).size, 3,
    'the three inputs must produce three different states');
  // A mismatch must not be reported as blocking: nothing here has been proven
  // to break, and lib/compat.js says so in writing.
  assert.equal(bad.blocking, false);
});

test('the boot banner names both sides of the comparison', () => {
  const box = bannerBox([judgeDsh('0.1.5-rc.3'), judgeTools('0.1.5-rc.3')]);
  assert.ok(box, 'an off-pin install must produce a banner');
  assert.ok(box.includes('0.1.5-rc.3'), 'banner must name the detected version');
  assert.ok(box.includes(PINNED_DSH), 'banner must name the pin');
  assert.ok(box.includes(PINNED_TOOLS_RANGE), 'banner must name the peer range');

  assert.equal(bannerBox([]), null, 'no off-pin verdicts means no banner');
  assert.equal(bannerBox([judgeDsh(PINNED_DSH)]), null, 'a verified install must stay quiet');
  assert.ok(bannerLine(judgeDsh('0.1.5-rc.3')).includes('COMPAT'), 'the greppable line is flagged');
  assert.ok(bannerLine(judgeDsh(PINNED_DSH)).includes('ok'), 'and the healthy one is not');
});

// ------------------------------------------------------------------ 4. drift guard

test('code pins and COMPAT.md have not drifted apart', async () => {
  const { readFile } = await import('node:fs/promises');
  const compat = await readFile(join(ROOT, 'COMPAT.md'), 'utf8');
  assert.ok(compat.includes('`' + PINNED_DSH + '`'),
    'COMPAT.md no longer documents DSH pin ' + PINNED_DSH + ' — update lib/compat.js or COMPAT.md');
  // COMPAT.md documents the *resolved* version from the rc.6 install tree;
  // package.json documents the peer *range*. Both must agree with the guard.
  const toolsBase = PINNED_TOOLS_RANGE.replace(/^[\^~>=<\s]+/, '');
  assert.ok(compat.includes('`' + toolsBase + '`') || compat.includes(toolsBase),
    'COMPAT.md no longer documents the dsh-tools version ' + toolsBase
    + ' — update lib/compat.js or COMPAT.md');

  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-tools'], PINNED_TOOLS_RANGE,
    'package.json peerDependencies drifted from the guarded range');
});

test('status surface reports a host-version verdict instead of a null placeholder', async () => {
  const { buildStatus } = await import('../lib/status.js');
  const status = await buildStatus({ browser: null, findChrome: () => null, pkgVersion: '0.0.0-test', toolsUnavailable: null });

  assert.ok(status.compatibility, 'status must carry a top-level compatibility block');
  assert.equal(status.compatibility.pin.dsh, PINNED_DSH);
  assert.ok(['VERIFIED', 'UNVERIFIED', 'UNKNOWN'].includes(status.compatibility.dsh.state),
    'dsh compat state must be one of the three — got ' + status.compatibility.dsh.state);
  assert.ok(['SATISFIED', 'MISMATCH', 'ABSENT'].includes(status.components.tools.detail.compat),
    'tools compat state must be one of the three');

  // The defect this whole module exists to fix: the host version was
  // hard-coded to null, so verified and unverified installs matched byte for
  // byte. It must now be a real string, or an explicitly-declared null.
  assert.ok(status.components.dsh.version === null || typeof status.components.dsh.version === 'string');
  if (status.components.dsh.version !== null) {
    assert.notEqual(status.components.dsh.version, undefined);
    assert.equal(typeof status.components.dsh.detail.versionMatchesPin, 'boolean');
  }
  assert.equal(typeof status.compatibility.onPin, 'boolean');
});

test('hostCompat() and judgeDsh() agree with each other', async () => {
  const host = hostCompat({ argv1: null, cwd: null, env: {} });
  assert.equal(host.state, 'UNKNOWN');
  assert.equal(host.state, judgeDsh(host.version).state);
  assert.equal(host.pin, PINNED_DSH);

  const { base, argv1 } = await fakeDshTree(PINNED_DSH);
  try {
    const pinned = hostCompat({ argv1, cwd: null, env: {} });
    assert.equal(pinned.version, PINNED_DSH);
    assert.equal(pinned.state, 'VERIFIED');
    assert.equal(pinned.state, judgeDsh(pinned.version).state);
    assert.equal(pinned.ok, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
