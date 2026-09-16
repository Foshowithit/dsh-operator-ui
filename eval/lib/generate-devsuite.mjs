#!/usr/bin/env node
// eval/lib/generate-devsuite.mjs — M3.0 synthetic acquisition dev suite.
//
// Separate from Eval Protocol v1 by design: distinct family codes (D01-D04
// vs F01-F10), an independent seed, zero content reuse, and NO reads of
// the Eval v1 corpus tree (the generator imports nothing and opens nothing
// outside its own output). Deterministic: the public seed reproduces the suite
// byte-identically anywhere.
//
// Suite shape (GPT-adjudicated, docs/M3-SPEC.md §4): 4 families x 3
// encounters, each family's encounters carrying distinct lifecycle roles:
//   encounter 1 = acquisition (base task)
//   encounter 2 = reuse under ordinary variation
//   encounter 3 = contract-preserving perturbation / generalization
//
// Output: eval/devsuite/<FAMILY>/encounter-<N>/{workspace/, objective.txt,
// expected.json} + eval/devsuite-manifest.json
//
// Usage: node eval/lib/generate-devsuite.mjs [--out eval/devsuite] [--seed 31415926]

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
const OUT = join(root, argOf('--out', 'eval/devsuite'));
const SEED = Number(argOf('--seed', 31415926));
const GENERATOR_VERSION = '2.0.0'; // v2: four encounters per family (GPT chain: ADMIT -> DIAGNOSTIC -> REGRESSION -> SACRED TERMINAL)

// Deterministic PRNG (mulberry32) — same construction as the corpus
// generator, independent seed and independent content.
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

// ------------------------------------------------------------- D01 family
// Threshold inventory: filter a CSV by qty and report matches in order.
const D01_ITEMS = ['anvil', 'bearing', 'collar', 'damper', 'gasket', 'insert', 'journal', 'keyway', 'liner', 'mount', 'nut', 'o-ring', 'plate', 'retainer', 'spacer', 'washer'];
function d01ThresholdInventory(r, encounter) {
  const files = {};
  const expect = { family: 'D01', below: [] };
  const threshold = [0, 10, 25, 18, 30][encounter];
  const fname = encounter === 2 ? 'supply.csv' : encounter === 4 ? 'stocktake.csv' : 'inventory.csv';
  const cols = encounter === 2 ? 'qty,item,bin' : 'item,qty';
  const rows = [];
  const n = int(r, 8, 12);
  const chosen = [...D01_ITEMS].sort(() => r() - 0.5).slice(0, n);
  for (const item of chosen) {
    const qty = int(r, 1, 40);
    rows.push([item, qty]);
    if (qty < threshold) expect.below.push({ item, qty });
  }
  expect.below.sort((a, b) => a.item.localeCompare(b.item));
  const bin = () => 'B' + int(r, 1, 9) + int(r, 0, 9);
  let body = (encounter === 3 || encounter === 4)
    ? '# weekly stock export\n\n' + cols + '\n'
    : cols + '\n';
  for (const [item, qty] of rows) {
    if (encounter === 2) body += `${qty},${item},${bin()}\n`;
    else if (encounter === 3 || encounter === 4) {
      if (r() < 0.3) body += `# cycle ${int(r, 1, 52)} verified\n`;
      body += `"${item}",${qty}\n`;
    } else body += `${item},${qty}\n`;
  }
  if (encounter === 3) {
    body += `\n# end of export\n`;
    files['readme-first.txt'] = 'This folder also contains stock notes that are NOT part of the inventory export.\n';
  }
  if (encounter === 4) {
    body += `\n# audited by ${pick(r, ['jreactor', 'mvolk', 'dshears'])}\n`;
    files['recount.csv'] = 'item,qty\n' + rows.slice(0, 3).map(([i2, q2]) => `${i2},${q2 + 100}\n`).join('');
  }
  files[fname] = body;
  const varyNote = encounter === 2
    ? ' The quantity column comes first in this export.'
    : encounter === 3
      ? ' Fields may be quoted; comment lines starting with # and blank lines must be ignored; ignore every other file in the workspace.'
      : encounter === 4
        ? ' Fields may be quoted; comment lines starting with # and blank lines must be ignored; ignore every other file in the workspace.'
        : '';
  return {
    workspace: files,
    objective: `From ${fname}, list every item whose quantity is below ${threshold}, sorted alphabetically by item name, one per line, as RESULT item=<name> qty=<n>.${varyNote}`,
    expected: expect,
  };
}

// ------------------------------------------------------------- D02 family
// Config diff: report keys whose value differs between two env files.
const D02_KEYS = ['batch_size', 'cache_ttl', 'endpoint', 'flush_ms', 'grpc_port', 'heap_max', 'idle_timeout', 'jobs_concurrency', 'keepalive_s', 'log_level', 'max_retries', 'metrics_path', 'queue_depth', 'region', 'sample_rate', 'timeout_ms', 'tls_verify', 'worker_count'];
const D02_VALUES = ['128', '300', '60', '900', 'us-east-1', 'info', '4', '0.25', 'on', '512m', 'https://relay.internal', 'v2', 'jsonl', 'strict'];
function d02ConfigDiff(r, encounter) {
  const files = {};
  const keys = [...D02_KEYS].sort(() => r() - 0.5).slice(0, encounter === 1 ? 8 : encounter === 4 ? 13 : 11);
  const a = {}, b = {};
  for (const k of keys) {
    a[k] = pick(r, D02_VALUES);
    b[k] = r() < 0.4 ? pick(r, D02_VALUES) : a[k];
  }
  const fa = encounter === 2 ? 'stage-a.env' : encounter === 4 ? 'prod-a.env' : 'release-a.env';
  const fb = encounter === 2 ? 'stage-b.env' : encounter === 4 ? 'prod-b.env' : 'release-b.env';
  const render = (m) => Object.entries(m).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  files[fa] = render(a);
  files[fb] = render(b);
  let expect = { family: 'D02', changed: [] };
  for (const k of keys) if (a[k] !== b[k]) expect.changed.push({ key: k, old: a[k], new: b[k] });
  if (encounter === 3) {
    // contract-preserving perturbation: comments, blank lines, duplicate
    // spacing, and keys present in only ONE file (noise — ignored by contract)
    const noiseA = '# deployed via pipeline\n\n';
    const noiseB = '# candidate build\n\n\n';
    const soloA = { feature_flag_x: 'on', legacy_route: 'off' };
    const soloB = { feature_flag_y: 'off' };
    files[fa] = noiseA + render(a) + Object.entries(soloA).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    files[fb] = noiseB + render(b) + '\n' + Object.entries(soloB).map(([k, v]) => `${k} = ${v}`).join('\n') + '\n';
    files['deploy-notes.txt'] = 'Both env files are structurally valid; only shared keys with differing values matter for the release report.\n';
  }
  if (encounter === 4) {
    // fresh combination: comments, solo keys both sides, AND values
    // containing '=' characters (env values may hold URLs with queries).
    // Mutate `a` BEFORE the changed-keys computation below so expected
    // matches the workspace (checker-caused fix, v2.0.0).
    const aes = Object.entries(a);
    aes[0][1] = aes[0][1] + '?env=' + encounter;
    aes[1][1] = 'bearer://' + aes[1][1];
    Object.assign(a, Object.fromEntries(aes));
    const noiseA = '# production snapshot\n\n';
    const noiseB = '# production candidate\n\n';
    const soloA = { trace_sampling: 'on' };
    const soloB = { shadow_route: 'off' };
    files[fa] = noiseA + render(a) + Object.entries(soloA).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    files[fb] = noiseB + render(b) + '\n' + Object.entries(soloB).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    // expected must describe the WRITTEN files — recompute after mutation
    expect.changed = [];
    for (const k of keys) if (a[k] !== b[k]) expect.changed.push({ key: k, old: a[k], new: b[k] });
  }
  return {
    workspace: files,
    objective: (encounter === 3 || encounter === 4)
      ? `Compare ${fa} and ${fb}. Report every key present in BOTH files whose value differs, in the order the key appears in ${fa}, one per line, as RESULT key=<key> old=<value-a> new=<value-b>. Comment lines, blank lines, and keys present in only one file must be ignored.${encounter === 4 ? ' Values may contain = characters; report them verbatim.' : ''}`
      : `Compare ${fa} and ${fb}. Report every key whose value differs between the two files, in the order the key appears in ${fa}, one per line, as RESULT key=<key> old=<value-a> new=<value-b>.`,
    expected: expect,
  };
}

// ------------------------------------------------------------- D03 family
// Domain tally: count top-level domains across URLs in a notes file.
const D03_DOMAINS = ['acmetools', 'brightworks', 'cedarsupply', 'dockside', 'eastfield', 'graniteco', 'harborline', 'ironwood', 'juniperlabs', 'kilnworks'];
const D03_TLDS = ['com', 'io', 'net', 'org'];
const D03_PATHS = ['', '/docs', '/pricing', '/a/b/c', '/index.html', '/support?plan=pro', '/downloads/'];
function d03DomainTally(r, encounter) {
  const files = {};
  const counts = new Map();
  const n = int(r, 12, 18);
  const lines = [];
  const url = (r) => {
    const d = pick(r, D03_DOMAINS);
    const tld = pick(r, D03_TLDS);
    const sub = r() < 0.3 ? 'www.' : r() < 0.15 ? 'cdn.' : '';
    const path = pick(r, D03_PATHS);
    const scheme = r() < 0.5 ? 'https' : 'http';
    return `${scheme}://${sub}${d}.${tld}${path}`;
  };
  for (let i = 0; i < n; i++) {
    const u = url(r);
    lines.push(u);
    const host = u.split('//')[1].split('/')[0].replace(/^(www|cdn)\./, '');
    counts.set(host, (counts.get(host) || 0) + 1);
  }
  if (encounter >= 2) {
    // ordinary variation in E2, extra noise in E3
    const noise = ['saved from old browser export', '', '  ', 'check these later', '# pinned'];
    for (const t of noise) if (r() < 0.6) lines.splice(int(r, 0, lines.length), 0, t);
  }
  if (encounter === 3) {
    // case variants + trailing punctuation must fold into the same domain
    const d = pick(r, D03_DOMAINS) + '.' + pick(r, D03_TLDS);
    lines.splice(int(r, 0, lines.length), 0, `HTTPS://${d.toUpperCase()}/Guide,`);
    lines.splice(int(r, 0, lines.length), 0, `https://${d}/x.`);
    const host = d;
    counts.set(host, (counts.get(host) || 0) + 2);
  }
  if (encounter === 4) {
    // fresh combination: uppercase hosts with punctuation AND subdomain
    // folding, interleaved with comment noise, higher cardinality
    for (let i2 = 0; i2 < 4; i2++) {
      const d2 = pick(r, D03_DOMAINS) + '.' + pick(r, D03_TLDS);
      const sub2 = pick(r, ['www.', 'cdn.', 'mail.']);
      lines.splice(int(r, 0, lines.length), 0, `HTTPS://${sub2}${d2.toUpperCase()}/Ref,`);
      const host2 = d2;
      counts.set(host2, (counts.get(host2) || 0) + 1);
    }
    lines.splice(int(r, 0, lines.length), 0, '# imported from old browser');
  }
  files[encounter === 4 ? 'links.txt' : 'bookmarks.txt'] = lines.join('\n') + '\n';
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const expect = { family: 'D03', tally: sorted.map(([domain, count]) => ({ domain, count })) };
  const caseNote = (encounter === 3 || encounter === 4)
    ? ' Domains are case-insensitive and trailing punctuation is not part of a URL; "www." and "cdn." prefixes are part of nothing — always tally the top-level domain.'
    : '';
  return {
    workspace: files,
    objective: `Tally how many URLs in bookmarks.txt point at each top-level domain (for example cdn.harborline.io counts as harborline.io). Report each domain with its total, sorted by count descending then domain alphabetically for ties, one per line, as RESULT domain=<domain> count=<n>.${caseNote}`,
    expected: expect,
  };
}

// ------------------------------------------------------------- D04 family
// Shift durations: compute minutes per named shift from a handoff log.
const D04_NAMES = ['anne', 'boris', 'cleo', 'dev', 'ellie', 'farid', 'gus', 'hana'];
function d04ShiftHandoff(r, encounter) {
  const files = {};
  const pad = (x) => String(x).padStart(2, '0');
  const entries = [];
  const n = int(r, 4, 6);
  const chosen = [...D04_NAMES].sort(() => r() - 0.5).slice(0, n);
  const expect = { family: 'D04', shifts: [] };
  for (const name of chosen) {
    const startH = int(r, 5, 20), startM = pick(r, [0, 15, 30, 45]);
    const dur = int(r, 35, 400);
    const endTotal = startH * 60 + startM + dur;
    const endH = Math.floor(endTotal / 60), endM = endTotal % 60;
    const secs = (encounter === 3 || encounter === 4) && r() < 0.5 ? ':' + pad(int(r, 0, 59)) : '';
    const line = (encounter === 3 || encounter === 4) && r() < 0.4
      ? `SHIFT ${name.toUpperCase()}  START ${pad(startH)}:${pad(startM)}  END ${pad(endH)}:${pad(endM)}${secs}`
      : `SHIFT ${name} START ${pad(startH)}:${pad(startM)} END ${pad(endH)}:${pad(endM)}${secs}`;
    entries.push({ line, name, minutes: dur });
    expect.shifts.push({ name: name.toLowerCase(), minutes: dur });
  }
  const hfile = encounter === 4 ? 'shifts.txt' : 'handoff.txt';
  files[hfile] = (encounter === 3 || encounter === 4 ? '# floor handoff — times may include seconds; ignore them\n\n' : '') + entries.map((e) => e.line).join('\n') + '\n';
  if (encounter === 3) files[hfile] += '\nnote: swing coverage handled offline\n';
  if (encounter === 4) files[hfile] += '\nnote: holiday rota appended to the board\n';
  // file order for the report = the order entries were emitted
  return {
    workspace: files,
    objective: (encounter === 3 || encounter === 4)
      ? `From ${encounter === 4 ? 'shifts.txt' : 'handoff.txt'}, report each shift's duration in minutes in file order, one per line, as RESULT shift=<name> minutes=<m>. Names are lowercase in the report; when a time includes seconds, ignore them.`
      : `From handoff.txt, report each shift's duration in minutes in file order, one per line, as RESULT shift=<name> minutes=<m>.`,
    expected: expect,
  };
}

// ------------------------------------------------------------ assembly
const FAMILIES = [
  { code: 'D01', name: 'D01-threshold-inventory', gen: d01ThresholdInventory },
  { code: 'D02', name: 'D02-config-diff', gen: d02ConfigDiff },
  { code: 'D03', name: 'D03-domain-tally', gen: d03DomainTally },
  { code: 'D04', name: 'D04-shift-handoff', gen: d04ShiftHandoff },
];
const ROLES = { 1: 'admission', 2: 'diagnostic-revision', 3: 'regression', 4: 'terminal-promotion' };

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const r = prng(SEED);
const objectives = [];
for (const fam of FAMILIES) {
  for (let enc = 1; enc <= 4; enc++) {
    const { workspace, objective, expected } = fam.gen(r, enc);
    const dir = join(OUT, fam.name, 'encounter-' + enc);
    await mkdir(join(dir, 'workspace'), { recursive: true });
    let contentHash = createHash('sha256');
    contentHash.update(objective + '\n');
    const fileHashes = {};
    for (const [rel, content] of Object.entries(workspace).sort()) {
      await writeFile(join(dir, 'workspace', rel), content, 'utf8');
      const h = sha256(content);
      fileHashes[rel] = 'sha256:' + h;
      contentHash.update(rel + '\n' + h + '\n');
    }
    const expectedJson = JSON.stringify({ ...expected, encounter: enc, role: ROLES[enc] }, null, 2) + '\n';
    await writeFile(join(dir, 'objective.txt'), objective + '\n', 'utf8');
    await writeFile(join(dir, 'expected.json'), expectedJson, 'utf8');
    const expectedHash = 'sha256:' + sha256(expectedJson);
    contentHash.update('expected\n' + expectedHash + '\n');
    objectives.push({
      id: `${fam.name}/encounter-${enc}`,
      family: fam.code,
      encounter: enc,
      role: ROLES[enc],
      hidden: false,
      files: fileHashes,
      expected_sha256: expectedHash,
      sha256: 'sha256:' + contentHash.digest('hex'),
    });
  }
}
const stream = [
  ...objectives.filter((o) => o.encounter === 1).map((o) => o.id),
  ...objectives.filter((o) => o.encounter === 2).map((o) => o.id),
  ...objectives.filter((o) => o.encounter === 3).map((o) => o.id),
];
const manifest = {
  protocol: 'devsuite-m3-v2',
  seed: SEED,
  generatorVersion: GENERATOR_VERSION,
  generatedAt: new Date().toISOString(),
  contamination_statement: 'Generated by eval/lib/generate-devsuite.mjs, which reads nothing outside its own output: The Eval v1 corpus tree (families F01-F10, including its hidden encounters 3-5) played no part in generation; the path it lives under is referenced nowhere in this generator. Family codes D01-D04, fixture file names, and all content are disjoint from the corpus families.',
  objectives,
  stream,
};
const manifestPath = join(OUT, '..', 'devsuite-manifest.json');
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`dev suite: ${objectives.length} objectives across ${FAMILIES.length} families -> eval/devsuite`);
console.log('manifest:', manifestPath);
