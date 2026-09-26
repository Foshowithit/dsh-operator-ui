#!/usr/bin/env node
// dsh-operator-ui — D0 release-candidate packer.
//
// WHY THIS EXISTS
//
// The first D0 attempt produced a tarball that could not name its own source
// commit. `npm pack` was measured on npm 10.9.7 to inject no `gitHead` from a
// detached worktree, from an attached branch, or via `npm publish --dry-run`.
// So the commit has to be injected into the artifact EXPLICITLY, and this is the
// instrument that does it.
//
// WHAT IT DOES, AND WHY IN THIS ORDER
//
//   1. Refuse a dirty tree. A claim-grade artifact binds to a commit; packing
//      from a working tree with uncommitted edits produces bytes whose content
//      no commit describes.
//   2. Materialise a DETACHED worktree at that commit, outside the live tree.
//      The injected file is written THERE. No tracked file is ever edited to
//      build a release — that is the whole reason this is not a `prepack`
//      script, and `--ignore-scripts` is passed to npm so a future accidentally
//      added lifecycle hook cannot quietly reintroduce one.
//   3. Write `lib/build-provenance.json` deterministically: fixed key order, no
//      timestamp, no machine path, no absolute path of any kind. Same commit ->
//      byte-identical file -> (npm normalises mtimes) byte-identical tarball.
//   4. Pack. Then pack AGAIN from a second, fresh worktree and assert the two
//      tarballs are bit-identical. That assertion is the determinism witness;
//      without it "deterministic" is a claim about the code, not about the bytes.
//   5. Read the ARTIFACT, not the staging tree: extract the tarball and compute
//      the shipped-content digest from what is actually inside it.
//
// WHAT DELIBERATELY STAYS OUTSIDE THE TARBALL
//
//   The tarball's own sha256. A file cannot contain a hash of the archive it is
//   inside — that is circular, and the first thing a reviewer would (rightly)
//   reject. The SHA lives in the D0 receipt, written next to the tarball.
//   The shipped-content digest likewise excludes `lib/build-provenance.json`
//   itself, for the same reason.
//
// EXIT LADDER (mirrors the runtime surface's, and the gate's):
//   0 ok   1 an assertion about the artifact failed   3 could not run
//
// Usage: node scripts/pack.mjs [--out <dir>] [--receipt <file>] [--commit <sha>] [--json]

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

export const PACK_VERSION = 1;

// ---------------------------------------------------------------- primitives

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256File(p) {
  return sha256(readFileSync(p));
}

/** Sorted relative file paths under `dir`, using POSIX separators. */
function walk(dir, base = dir, acc = []) {
  for (const name of readdirSorted(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, base, acc);
    else if (st.isFile()) acc.push(relative(base, p).split(sep).join('/'));
  }
  return acc.sort();
}

function readdirSorted(dir) {
  // Deterministic order matters: an unsorted readdir makes the digest depend on
  // the filesystem's inode order, which is exactly the kind of ambient input
  // this repo keeps removing.
  return readdirSync(dir).sort();
}

/**
 * Read a pinned constant out of a source file by name, in the tree being packed.
 *
 * WHY NOT IMPORT IT: importing would bind the artifact to THIS checkout's module
 * graph rather than to the commit being packed. Reading it out of the staging
 * tree keeps the record a function of the commit and nothing else — which is the
 * entire property the determinism witness is testing.
 */
function pinnedConstant(srcText, name) {
  const m = srcText.match(new RegExp('export const ' + name + "\\s*=\\s*'([^']+)'"));
  return m ? m[1] : null;
}

function arg(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

// ------------------------------------------------- the injected record

/**
 * Build the provenance record. DETERMINISTIC: derived only from the commit's own
 * package.json and the commit id. No clock, no hostname, no path, no branch name
 * (a branch is a moving label; the commit is the fact).
 */
export function buildProvenanceRecord({ pkg, commit, gateVersion, compatSrc }) {
  return {
    schema: 1,
    artifact: 'runtime',
    package: pkg.name,
    package_version: pkg.version,
    source_commit: commit,
    certified_by_gate_version: gateVersion,
    compatibility_pin: compatSrc ? pinnedConstant(compatSrc, 'PINNED_DSH') : null,
    tools_range: (pkg.peerDependencies && pkg.peerDependencies['@deepseek-ai/dsh-tools']) || null,
    node_range: (pkg.engines && pkg.engines.node) || null,
  };
}

/** Serialise with a fixed key order and a trailing newline. */
export function serialiseProvenance(record) {
  const ORDER = [
    'schema', 'artifact', 'package', 'package_version', 'source_commit',
    'certified_by_gate_version', 'compatibility_pin', 'tools_range', 'node_range',
  ];
  const out = {};
  for (const k of ORDER) out[k] = record[k];
  return JSON.stringify(out, null, 2) + '\n';
}

// ------------------------------------------------- one pack

function packOnce({ root, commit, staging, outDir, gateVersion, ignoreScripts }) {
  git(root, ['worktree', 'add', '--detach', staging, commit]);

  const pkg = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'));
  const compatSrc = readFileSync(join(staging, 'lib', 'compat.js'), 'utf8');
  const record = buildProvenanceRecord({ pkg, commit, gateVersion, compatSrc });
  const provRel = 'lib/build-provenance.json';
  const provPath = join(staging, provRel);
  const provBytes = Buffer.from(serialiseProvenance(record), 'utf8');
  mkdirSync(dirname(provPath), { recursive: true });
  writeFileSync(provPath, provBytes);

  // Resolve npm RELATIVE TO THE NODE THAT IS RUNNING THIS, not from PATH. The
  // managed runtime on this box is not on the ambient PATH, and a bare `npm`
  // would silently pick a different toolchain — a different npm is a different
  // packer, which would break the determinism witness for the wrong reason.
  const npmJs = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const useCli = existsSync(npmJs);
  const npmBin = useCli ? process.execPath : join(dirname(process.execPath), 'npm');
  const npmArgs = (useCli ? [npmJs] : []).concat(['pack', '--ignore-scripts', '--pack-destination', outDir]);
  const stdout = execFileSync(npmBin, npmArgs, {
    cwd: staging,
    encoding: 'utf8',
    env: { ...process.env, npm_config_loglevel: 'error', npm_config_update_notifier: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tarballName = stdout.trim().split('\n').filter(Boolean).pop().trim();
  const tarball = join(outDir, tarballName);

  return { staging, tarball, tarballName, provRel, provBytes, record, pkg };
}

/** Extract a tarball and measure what is actually inside it. */
function measureArtifact({ tarball, provRel, provBytes }) {
  const ex = mkdtempSync(join(tmpdir(), 'dsh-artifact-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', ex], { stdio: ['ignore', 'pipe', 'pipe'] });
    const rootDir = join(ex, 'package');
    const files = walk(rootDir);

    const hashes = {};
    for (const rel of files) hashes[rel] = sha256File(join(rootDir, rel));

    // The shipped-content digest EXCLUDES the injected record: including it would
    // make the digest a function of itself.
    const digestInput = files.filter((r) => r !== provRel)
      .map((r) => r + '\n' + hashes[r] + '\n').join('');
    const contentDigest = sha256(Buffer.from(digestInput, 'utf8'));

    const shippedProv = files.includes(provRel) ? readFileSync(join(rootDir, provRel)) : null;

    return {
      files,
      file_count: files.length,
      hashes,
      content_digest_excluding_provenance: contentDigest,
      provenance_file: {
        path: provRel,
        shipped: !!shippedProv,
        sha256: shippedProv ? sha256(shippedProv) : null,
        byte_identical_to_injected: shippedProv ? shippedProv.equals(provBytes) : false,
      },
      manifest: files.includes('package.json')
        ? JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
        : null,
    };
  } finally {
    rmSync(ex, { recursive: true, force: true });
  }
}

// ------------------------------------------------- main

async function main(argv = process.argv.slice(2)) {
  const outDir = resolve(arg(argv, '--out', join(tmpdir(), 'dsh-d0-rc')));
  const asJson = argv.includes('--json');
  const failures = [];
  const fail = (id, detail) => failures.push({ id, detail });

  const root = git(REPO, ['rev-parse', '--show-toplevel']);
  const commit = arg(argv, '--commit', git(root, ['rev-parse', 'HEAD']));
  const branch = (() => { try { return git(root, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return '(unknown)'; } })();

  const dirty = git(root, ['status', '--porcelain']);
  if (dirty) {
    console.error('pack: REFUSED — the working tree is dirty. A release candidate binds to a commit.\n'
      + dirty.split('\n').map((l) => '  ' + l).join('\n'));
    return 3;
  }

  mkdirSync(outDir, { recursive: true });
  const receiptPath = resolve(arg(argv, '--receipt', join(outDir, 'd0-receipt.json')));

  // The gate version is READ from the gate, never retyped. A second copy of the
  // number is a second thing that can be wrong.
  const gateSrc = readFileSync(join(root, 'scripts', 'gate.mjs'), 'utf8');
  const gm = gateSrc.match(/export const GATE_VERSION\s*=\s*(\d+)/);
  if (!gm) { console.error('pack: could not read GATE_VERSION from scripts/gate.mjs'); return 3; }
  const gateVersion = Number(gm[1]);

  const stagingA = mkdtempSync(join(tmpdir(), 'dsh-pack-a-'));
  const stagingB = mkdtempSync(join(tmpdir(), 'dsh-pack-b-'));
  let a; let b; let art; let artB;
  try {
    a = packOnce({ root, commit, staging: stagingA, outDir, gateVersion });
    art = measureArtifact({ tarball: a.tarball, provRel: a.provRel, provBytes: a.provBytes });

    // --- assertions about the ARTIFACT (read from the tarball, not the tree) ---
    if (!art.provenance_file.shipped) fail('provenance-shipped', 'lib/build-provenance.json is not in the tarball');
    if (art.provenance_file.shipped && !art.provenance_file.byte_identical_to_injected) {
      fail('provenance-byte-identical', 'the packed provenance file differs from the injected bytes');
    }
    if (art.manifest && art.manifest.gitHead) {
      fail('no-npm-githead', 'npm DID inject gitHead (' + art.manifest.gitHead + '); the measurement this instrument is built on no longer holds');
    }
    for (const forbidden of ['scripts/gate.mjs', 'scripts/pack.mjs', 'scripts/check.js']) {
      if (art.files.includes(forbidden)) fail('instrument-shipped', forbidden + ' is in the runtime tarball');
    }
    if (!art.files.includes('bin/dsh-operator-ui.mjs')) fail('bin-shipped', 'the bin entrypoint is missing from the tarball');

    // --- determinism witness: pack a SECOND time from a fresh worktree ---
    b = packOnce({ root, commit, staging: stagingB, outDir, gateVersion });
    artB = measureArtifact({ tarball: b.tarball, provRel: b.provRel, provBytes: b.provBytes });
    const shaA = sha256File(a.tarball);
    const shaB = sha256File(b.tarball);
    if (shaA !== shaB) {
      fail('repack-not-deterministic', 'two packs of commit ' + commit.slice(0, 12) + ' differ: ' + shaA + ' vs ' + shaB);
    }
    if (art.content_digest_excluding_provenance !== artB.content_digest_excluding_provenance) {
      fail('repack-content-not-deterministic', 'the shipped-content digest differs between two packs of one commit');
    }
  } finally {
    for (const s of [stagingA, stagingB]) {
      try { git(root, ['worktree', 'remove', '--force', s]); } catch { /* best effort */ }
    }
    try { git(root, ['worktree', 'prune']); } catch { /* best effort */ }
  }

  const tarballSha = sha256File(a.tarball);
  const receipt = {
    pack_schema: PACK_VERSION,
    tool: 'scripts/pack.mjs',
    packed_from: { repo: 'dsh-operator-ui', branch, commit, tree_clean: true },
    gate_version: gateVersion,
    // The tarball's own hash lives HERE, outside the tarball. Never inside.
    tarball: {
      file: a.tarballName,
      path: a.tarball,
      sha256: tarballSha,
      bytes: statSync(a.tarball).size,
      file_count: art.file_count,
    },
    determinism: {
      witness: 'two independent packs from fresh detached worktrees at the same commit',
      repack_sha256: sha256File(b.tarball),
      bit_identical: tarballSha === sha256File(b.tarball),
    },
    injected: {
      path: a.provRel,
      sha256: art.provenance_file.sha256,
      record: a.record,
    },
    shipped_content: {
      digest_excluding_provenance: art.content_digest_excluding_provenance,
      files: art.files,
    },
    instrument_shipped: art.files.filter((f) => f.startsWith('scripts/')),
    manifest_githead: art.manifest ? (art.manifest.gitHead || null) : '(manifest unreadable)',
    verdict: failures.length ? 'FAIL' : 'PASS',
    failures,
  };
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');

  if (asJson) console.log(JSON.stringify(receipt, null, 2));
  else {
    console.log('pack: ' + receipt.verdict + '  ' + a.tarballName);
    console.log('  commit     : ' + commit.slice(0, 12) + '  (' + branch + ', clean tree)');
    console.log('  tarball    : sha256 ' + tarballSha);
    console.log('  bytes/files: ' + receipt.tarball.bytes + ' / ' + art.file_count);
    console.log('  injected   : ' + a.provRel + ' sha256 ' + String(art.provenance_file.sha256).slice(0, 16) + '…');
    console.log('  content    : ' + art.content_digest_excluding_provenance.slice(0, 16) + '… (excluding the injected record)');
    console.log('  determinism: repack bit-identical = ' + receipt.determinism.bit_identical);
    console.log('  npm gitHead: ' + (art.manifest && art.manifest.gitHead ? 'PRESENT (measurement broken)' : 'absent, as measured'));
    console.log('  instruments: ' + (receipt.instrument_shipped.length ? 'SHIPPED — ' + receipt.instrument_shipped.join(', ') : 'none shipped (correct)'));
    console.log('  receipt    : ' + receiptPath);
    for (const f of failures) console.log('  FAIL ' + f.id + ': ' + f.detail);
  }
  return failures.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error('pack: could not run — ' + (e && e.stack ? e.stack : e));
    process.exitCode = 3;
  });
}
