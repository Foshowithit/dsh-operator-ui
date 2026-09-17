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
const GENERATOR_VERSION = '3.0.0'; // v3: breadth — 12 new families x 5 encounters (E1 admission, E2 diagnostic, E3 regression, E4+E5 sacred terminals)

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


// ================================================================
// v3.0.0 breadth families (GPT directive: ~12 NEW families, none of
// D01–D04, none copied from F01–F10; genuinely different reusable
// capability structures). Encounters per family:
//   1 admission · 2 diagnostic/revision · 3 regression
//   4 terminal-a · 5 terminal-b   (both terminals sacred)
// Five-encounter variant design per family: E2 varies an ordinary
// parameter, E3 perturbs format, E4/E5 are fresh combinations.

// ---- D05 multi-file join: orders × prices → per-order totals
function d05OrderJoin(r, encounter) {
  const items = ['anchor-bolt', 'bracket', 'coupler', 'damper-cable', 'expansion-shell', 'flat-washer', 'gib-key', 'hex-nut'];
  const fnameO = encounter === 2 ? 'requests.csv' : 'orders.csv';
  const fnameP = encounter === 2 ? 'price-list.csv' : 'prices.csv';
  const prices = {};
  for (const it of items) prices[it] = int(r, 4, 90);
  const n = int(r, 5, 9);
  const orders = [];
  const expect = { family: 'D05', lines: [] };
  for (let i = 0; i < n; i++) {
    const it = pick(r, items);
    orders.push({ id: 'o' + (100 + i), item: it });
    expect.lines.push({ order: 'o' + (100 + i), item: it, total: String(prices[it]) });
  }
  const files = {};
  files[fnameP] = Object.entries(prices).map(([k, v]) => `${k},${v}`).join('\n') + '\n';
  const noiseP = encounter === 3 ? '# unit prices, USD\n\n' : '';
  files[fnameP] = noiseP + files[fnameP];
  let obody = 'order_id,item\n';
  for (const o of orders) obody += encounter === 4 ? `"${o.id}","${o.item}"\n` : `${o.id},${o.item}\n`;
  if (encounter === 3 || encounter === 5) obody += '\n# fulfilled orders only\n';
  if (encounter === 5) obody = '# daily export\n\n' + obody;
  files[fnameO] = obody;
  const varyNote = encounter === 4
    ? ' Fields may be quoted.'
    : (encounter === 3 || encounter === 5)
      ? ' Comment lines starting with # and blank lines must be ignored.'
      : '';
  return {
    workspace: files,
    objective: `Join ${fnameO} with ${fnameP} on the item column and report each order's total (the item's price), in orders-file order, one per line, as RESULT order=<order_id> item=<item> total=<price>.${varyNote}`,
    expected: expect,
  };
}

// ---- D06 hierarchical outline: count entries per top-level section
function d06OutlineCounts(r, encounter) {
  const sections = ['axles', 'brakes', 'cooling', 'drive', 'electrical', 'filters'];
  const subs = ['spec', 'torque', 'parts', 'notes', 'checks'];
  const chosen = [...sections].sort(() => r() - 0.5).slice(0, encounter === 1 ? 3 : 4);
  const expect = { family: 'D06', sections: [] };
  const lines = [];
  const fname = encounter === 2 ? 'service-outline.txt' : 'outline.txt';
  for (const sec of chosen) {
    lines.push(sec);
    const k = int(r, 2, 4);
    expect.sections.push({ section: sec, items: String(k) });
    for (let i = 0; i < k; i++) lines.push('  ' + pick(r, subs) + ' ' + int(r, 1, 99));
  }
  let body = lines.join('\n') + '\n';
  if (encounter === 3 || encounter === 5) body = '# maintenance outline — two-space indent means a sub-entry\n\n' + body;
  if (encounter === 4) body = body.replace(/\n  /g, '\n    ');
  if (encounter === 5) body += '\n# end of outline\n';
  const files = { [fname]: body };
  if (encounter === 3) files['readme.txt'] = 'Only top-level lines (no leading spaces) are sections. Count the sub-entries under each.\n';
  const indentNote = encounter === 4
    ? ' Indentation may be two or four spaces; a sub-entry is any line starting with whitespace.'
    : (encounter === 3 || encounter === 5)
      ? ' Comment lines starting with # must be ignored.'
      : '';
  return {
    workspace: files,
    objective: `In ${fname}, count the sub-entries under each top-level section (top-level lines have no leading whitespace) and report each section with its count, in file order, one per line, as RESULT section=<name> items=<count>.${indentNote}`,
    expected: expect,
  };
}

// ---- D07 stateful ledger fold: final + minimum running balance
function d07LedgerFold(r, encounter) {
  const fname = encounter === 2 ? 'transactions-journal.txt' : 'ledger.txt';
  const start = int(r, 100, 400);
  const n = int(r, 6, 10);
  let bal = start, min = start;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const kind = r() < 0.5 ? 'credit' : 'debit';
    const amt = int(r, 5, 120);
    bal += kind === 'credit' ? amt : -amt;
    if (bal < min) min = bal;
    rows.push({ kind, amt });
  }
  const expect = { family: 'D07', final: String(bal), min: String(min) };
  let body = encounter === 3 ? `# opening balance ${start}\n` : '';
  if (encounter === 4) body = `opening=${start}\n`;
  for (const row of rows) {
    if (encounter === 4) body += `${row.kind === 'credit' ? '+' : '-'}${amt2(row)}\n`;
    else body += `${row.kind} ${row.amt}\n`;
  }
  if (encounter === 5) body = '# journal export\n\n' + body + `\n# opening balance was ${start}\n`;
  function amt2(row) { return String(row.amt); }
  const files = { [fname]: body };
  const objText = `A ledger starts at balance ${start}. Apply every transaction in ${fname} in order (credit adds, debit subtracts).`;
  const varyNote = encounter === 4
    ? ' Signed amounts like +40 or -25 mean credit or debit; the opening balance line (opening=N) must be ignored in favor of the stated start.'
    : (encounter === 3 || encounter === 5)
      ? ' Comment lines starting with # must be ignored.'
      : '';
  return {
    workspace: files,
    objective: `${objText} Report the final balance and the lowest balance reached at any point (the opening balance counts as a point), one per line, as RESULT final=<balance> and RESULT min=<balance>.${varyNote}`,
    expected: expect,
  };
}

// ---- D08 cross-file validation: manifest vs checksums status
function d08CrossValidation(r, encounter) {
  const arts = ['boot.img', 'core.pkg', 'diag.bin', 'env.map', 'firmware.sig', 'grub.cfg', 'hash.txt', 'initrd.gz'];
  const chosen = [...arts].sort(() => r() - 0.5).slice(0, int(r, 5, 7));
  const fnameM = encounter === 2 ? 'release-manifest.txt' : 'manifest.txt';
  const fnameC = encounter === 2 ? 'computed-hashes.txt' : 'checksums.txt';
  const manifestSet = new Set(chosen);
  // drop/add to create missing entries
  if (chosen.length > 3) manifestSet.delete(chosen[chosen.length - 1]); // in checksums, missing from manifest → ignore? contract: report per checksummed file
  const hashOf = {};
  for (const f of chosen) hashOf[f] = Array.from({ length: 8 }, () => '0123456789abcdef'[int(r, 0, 15)]).join('');
  const corrupted = encounter >= 3 && chosen.length > 2 ? chosen[1] : chosen[0];
  const checksummed = new Set(chosen);
  if (encounter >= 4) checksummed.delete(chosen[0]); // manifested but not checksummed → missing
  const expect = { family: 'D08', statuses: [] };
  let cbody = '';
  for (const f of chosen) {
    if (!checksummed.has(f)) continue;
    const shown = f === corrupted ? Array.from({ length: 8 }, () => '0123456789abcdef'[int(r, 0, 15)]).join('') : hashOf[f];
    cbody += `${f}:${shown}\n`;
    const status = manifestSet.has(f) ? (shown === hashOf[f] ? 'ok' : 'mismatch') : 'unexpected';
    expect.statuses.push({ file: f, status });
  }
  for (const f of manifestSet) {
    if (!checksummed.has(f)) {
      expect.statuses.push({ file: f, status: 'missing' });
    }
  }
  expect.statuses.sort((a, b) => a.file.localeCompare(b.file));
  let mbody = '';
  for (const f of [...manifestSet].sort()) mbody += `${f}\n`;
  if (encounter === 3 || encounter === 4) mbody = '# files required for release\n' + mbody;
  if (encounter === 5) { mbody += '\n'; }
  const files = { [fnameM]: mbody, [fnameC]: cbody };
  const varyNote = (encounter === 3 || encounter === 4)
    ? ' Comment lines starting with # must be ignored.'
    : encounter === 5
      ? ' Comment lines starting with # must be ignored; report statuses in alphabetical file order.'
      : '';
  return {
    workspace: files,
    objective: `Validate ${fnameC} against ${fnameM}: every file listed in the checksum file must appear in the manifest with a matching hash, and every manifest file must be present in the checksum file. Report per file, in alphabetical file order, one per line, as RESULT file=<name> status=<ok|mismatch|unexpected|missing> where unexpected means checksummed but not in the manifest and missing means manifested but not checksummed.${varyNote}`,
    expected: expect,
  };
}

// ---- D09 daily report: per-date event counts, sorted by date
function d09DailyReport(r, encounter) {
  const fname = encounter === 2 ? 'activity-feed.txt' : 'events.log';
  const days = 4;
  const dates = [];
  let day = int(r, 3, 20);
  const month = pick(r, ['2026-08-', '2026-09-']);
  for (let i = 0; i < days; i++) { dates.push(month + String(day).padStart(2, '0')); day += int(r, 1, 3); }
  const counts = new Map(dates.map((d) => [d, 0]));
  const lines = [];
  const kinds = ['deploy', 'backup', 'rotate', 'scan', 'patch'];
  const total = int(r, 10, 16);
  for (let i = 0; i < total; i++) {
    const d2 = pick(r, dates);
    counts.set(d2, counts.get(d2) + 1);
    lines.push(`${d2} ${pick(r, kinds)} ok`);
  }
  const expect = { family: 'D09', days: dates.sort().map((d2) => ({ date: d2, count: String(counts.get(d2)) })) };
  let body = lines.join('\n') + '\n';
  if (encounter === 3 || encounter === 4) body = '# event feed — one event per line\n\n' + body;
  if (encounter === 4) body += '\nfeed complete\n';
  if (encounter === 5) body = lines.map((l, i2) => (i2 % 4 === 0 ? '[' + l.slice(0, 10) + '] ' + l : l)).join('\n') + '\n';
  const files = { [fname]: body };
  const varyNote = encounter === 4
    ? ' Comment lines and the trailing "feed complete" line must be ignored.'
    : encounter === 5
      ? ' Some lines carry a bracketed [date] prefix before the real date — use the first bare date token on the line (YYYY-MM-DD).'
      : (encounter === 3)
        ? ' Comment lines starting with # must be ignored.'
        : '';
  return {
    workspace: files,
    objective: `Count the events per date in ${fname} and report each date with its count, sorted by date ascending, one per line, as RESULT date=<YYYY-MM-DD> count=<n>.${varyNote}`,
    expected: expect,
  };
}

// ---- D10 filesystem selection: files above a size threshold
function d10FileSelection(r, encounter) {
  const files = {};
  const namePool = ['alpha.dat', 'bravo.log', 'charlie.cfg', 'delta.dat', 'echo.log', 'fox.cfg'];
  const threshold = [0, 800, 1500, 1200, 2000, 900][encounter];
  const expect = { family: 'D10', files: [] };
  const picked = [...namePool].sort(() => r() - 0.5).slice(0, 5);
  for (const nm of picked) {
    const size = int(r, 100, 2600);
    files[nm] = 'x'.repeat(size);
    if (size > threshold) expect.files.push({ file: nm, size: String(size) });
  }
  if (encounter === 3 || encounter === 5) {
    files['notes.txt'] = 'Sizes on disk are authoritative; ignore this file.\n';
  }
  if (encounter === 4) {
    const deep = 'y'.repeat(int(r, 1500, 2500));
    files['sub/deep.dat'] = deep;
    if (deep.length > threshold) expect.files.push({ file: 'sub/deep.dat', size: String(deep.length) });
  }
  expect.files.sort((a, b) => a.file.localeCompare(b.file));
  const varyNote = encounter === 4
    ? ' Search subdirectories too; report paths relative to the workspace.'
    : encounter === 3
      ? ' Ignore non-data files only if their content says to ignore them — otherwise apply the size rule to every file.'
      : encounter === 5
        ? ' Ignore notes.txt.'
        : '';
  return {
    workspace: files,
    objective: `Report every file in the workspace whose size is greater than ${threshold} bytes, in alphabetical path order, one per line, as RESULT file=<path> size=<bytes>.${varyNote}`,
    expected: expect,
  };
}

// ---- D11 normalization: contacts to canonical form
function d11Normalize(r, encounter) {
  const firsts = ['Ava', 'Ben', 'Cleo', 'Dmitri', 'Esme', 'Farrow'];
  const lasts = ['Archer', 'Brooks', 'Calder', 'Dune', 'Ellery', 'Fox'];
  const fname = encounter === 2 ? 'people-raw.txt' : 'contacts.txt';
  const n = int(r, 4, 7);
  const expect = { family: 'D11', contacts: [] };
  const lines = [];
  for (let i = 0; i < n; i++) {
    const f = pick(r, firsts), l = pick(r, lasts);
    const digits = String(int(r, 200, 999)) + String(int(r, 100, 999)) + String(int(r, 1000, 9999));
    let raw = `${f} ${l}`;
    let phone = digits.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
    if (encounter === 3 || encounter === 4) phone = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    if (encounter === 5) raw = raw.toUpperCase();
    lines.push(`${raw} <${phone}>`);
    expect.contacts.push({ name: `${f} ${l}`.toLowerCase().replace(/\s+/, '-'), phone: digits });
  }
  let body = lines.join('\n') + '\n';
  if (encounter === 3 || encounter === 4) body = '# contact export\n\n' + body;
  const files = { [fname]: body };
  const varyNote = (encounter === 3 || encounter === 4)
    ? ' Comment lines starting with # must be ignored.'
    : '';
  return {
    workspace: files,
    objective: `Normalize every contact in ${fname}: the name becomes lowercase with a single hyphen between words (first-last), and the phone becomes exactly 10 digits with all punctuation removed. Report in file order, one per line, as RESULT name=<first-last> phone=<10 digits>.${varyNote}`,
    expected: expect,
  };
}

// ---- D12 dependency graph: direct-dependency counts + heaviest component
function d12DepGraph(r, encounter) {
  const comps = ['api', 'auth', 'build', 'daemon', 'export', 'frontend', 'gateway'];
  const chosen = [...comps].sort(() => r() - 0.5).slice(0, int(r, 5, 6));
  const fname = encounter === 2 ? 'component-map.txt' : 'deps.txt';
  const deps = {};
  for (const c of chosen) deps[c] = [];
  for (const c of chosen) {
    const k = int(r, 0, 2);
    const pool = chosen.filter((x) => x !== c && !deps[c].includes(x));
    for (let i = 0; i < Math.min(k, pool.length); i++) deps[c].push(pool.splice(int(r, 0, pool.length - 1), 1)[0]);
  }
  const expect = { family: 'D12', counts: [], heaviest: '' };
  let maxDeps = -1;
  for (const c of chosen.sort()) {
    expect.counts.push({ component: c, deps: String(deps[c].length) });
    if (deps[c].length > maxDeps) { maxDeps = deps[c].length; expect.heaviest = c; }
  }
  let body = '';
  for (const c of chosen) {
    if (deps[c].length === 0) body += `${c}\n`;
    else for (const d of deps[c]) body += `${c} -> ${d}\n`;
  }
  if (encounter === 3 || encounter === 4) body = '# component dependency edges\n\n' + body;
  if (encounter === 5) body += '# end of map\n';
  const files = { [fname]: body };
  const varyNote = (encounter === 3 || encounter === 4 || encounter === 5)
    ? ' Comment lines starting with # must be ignored. A component with no edges has zero dependencies.'
    : '';
  return {
    workspace: files,
    objective: `From the dependency edges in ${fname}, count each component's DIRECT dependencies and report every component with its count, in alphabetical component order, one per line, as RESULT component=<name> deps=<count>. Then report the component with the most dependencies on its own line as RESULT heaviest=<name> (alphabetical tie-break).${varyNote}`,
    expected: expect,
  };
}

// ---- D13 structured patching: apply changes to KEY=VALUE config
function d13Patch(r, encounter) {
  const keys = ['cache_mb', 'heap', 'interval_s', 'jobs', 'keepalive', 'log_level', 'max_conn', 'retries', 'timeout'];
  const vals = ['64', '512m', '30', '4', 'on', 'info', '200', '3', '90'];
  const fnameC = encounter === 2 ? 'settings-current.txt' : 'deploy-config.txt';
  const fnameP = encounter === 2 ? 'planned-changes.txt' : 'changes.txt';
  const cfg = {};
  const chosen = [...keys].sort(() => r() - 0.5).slice(0, 6);
  chosen.forEach((k, i2) => { cfg[k] = vals[i2 % vals.length]; });
  const patchKeys = [...chosen].sort(() => r() - 0.5).slice(0, int(r, 2, 4));
  const expect = { family: 'D13', applied: [] };
  let pbody = '';
  for (const k of patchKeys) {
    const nv = pick(r, vals.filter((v) => v !== cfg[k])) || '99';
    pbody += `${k}: ${nv}\n`;
    expect.applied.push({ key: k, from: cfg[k], to: nv });
    cfg[k] = nv;
  }
  let cbody = '';
  for (const [k, v] of Object.entries(cfg)) cbody += `${k}=${v}\n`;
  // NOTE: config file must show ORIGINAL values for from=; patch applies
  // only in the report. Rebuild config with pre-patch values:
  const cfgOriginal = {};
  chosen.forEach((k, i2) => { cfgOriginal[k] = vals[i2 % vals.length]; });
  let cbodyOrig = '';
  for (const [k, v] of Object.entries(cfgOriginal)) cbodyOrig += `${k}=${v}\n`;
  if (encounter === 3 || encounter === 4) cbodyOrig = '# current deployment values\n' + cbodyOrig;
  if (encounter === 5) pbody = '# change plan — apply in order\n' + pbody;
  const files = { [fnameC]: cbodyOrig, [fnameP]: pbody };
  const varyNote = (encounter === 3 || encounter === 4)
    ? ' Comment lines starting with # must be ignored.'
    : encounter === 5
      ? ' Comment lines starting with # must be ignored; apply changes in plan order.'
      : '';
  return {
    workspace: files,
    objective: `${fnameP} lists planned changes, one per line as "key: newvalue". For each planned change (in plan order), report the key's CURRENT value from ${fnameC} and the new value, one per line, as RESULT key=<key> from=<current> to=<new>. Do not modify any file.${varyNote}`,
    expected: expect,
  };
}

// ---- D14 aggregation with exclusions: per-region totals
function d14RegionTotals(r, encounter) {
  const regions = ['east', 'gulf', 'north', 'west'];
  const fname = encounter === 2 ? 'sales-export.csv' : 'sales.csv';
  const cols = encounter === 2 ? 'amount,region' : 'region,amount';
  const totals = new Map(regions.map((x) => [x, 0]));
  const rows = [];
  // one guaranteed row per region first (zero-total regions would make the
  // report contract ambiguous), then random extras
  for (const reg of regions) {
    const amt = int(r, 10, 400);
    rows.push([reg, amt]);
    totals.set(reg, totals.get(reg) + amt);
  }
  const n = int(r, 6, 10);
  for (let i = 0; i < n; i++) {
    const reg = pick(r, regions);
    const amt = int(r, 10, 400);
    rows.push([reg, amt]);
    totals.set(reg, totals.get(reg) + amt);
  }
  let body = (encounter === 3 || encounter === 5) ? '# regional sales\n' : '';
  body += cols + '\n';
  for (const [reg, amt] of rows) {
    if ((encounter === 3 || encounter === 5) && r() < 0.2) body += `# void ${reg} ${amt}\n`;
    body += encounter === 4 ? `${amt},${reg}\n` : `${reg},${amt}\n`;
  }
  if (encounter === 3 || encounter === 5) body += '\n# void internal 999\n';
  const expect = { family: 'D14', totals: [] };
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [reg, tot] of sorted) expect.totals.push({ region: reg, total: String(tot) });
  const files = { [fname]: body };
  const varyNote = encounter === 2
    ? ' The amount column comes first in this export.'
    : (encounter === 3 || encounter === 5)
      ? ' Comment lines starting with # must be ignored (including voided rows).'
      : encounter === 4
        ? ' The amount column comes first in this export.'
        : '';
  return {
    workspace: files,
    objective: `Total the amounts per region in ${fname} and report each region with its total, sorted by total descending then region alphabetically, one per line, as RESULT region=<region> total=<amount>.${varyNote}`,
    expected: expect,
  };
}

// ---- D15 version audit: semver staleness vs a target
function d15VersionAudit(r, encounter) {
  const comps = ['agent', 'broker', 'cli', 'daemon', 'exporter'];
  const fname = encounter === 2 ? 'release-versions.txt' : 'versions.txt';
  const targetMajor = int(r, 2, 4);
  const chosen = [...comps].sort(() => r() - 0.5).slice(0, 5);
  const expect = { family: 'D15', rows: [] };
  let body = '';
  for (const c of chosen) {
    const major = int(r, 1, targetMajor + 1);
    const minor = int(r, 0, 9), patch = int(r, 0, 9);
    const v = `${major}.${minor}.${patch}`;
    body += `${c}: v${v}\n`;
    const status = major > targetMajor ? 'ahead' : major === targetMajor ? 'current' : 'stale';
    expect.rows.push({ name: c, version: v, status });
  }
  if (encounter === 3 || encounter === 4) body = '# component versions\n' + body;
  if (encounter === 5) body = body.replace(/: v/g, ':v');
  const files = { [fname]: body };
  const varyNote = encounter === 5
    ? ' The version may follow the colon with or without a space.'
    : (encounter === 3 || encounter === 4)
      ? ' Comment lines starting with # must be ignored.'
      : '';
  return {
    workspace: files,
    objective: `Every component in ${fname} reports a semver version. Compare each major version against target major ${targetMajor} and report per component, in file order, one per line, as RESULT name=<component> version=<x.y.z> status=<stale|current|ahead> where stale means major < target, current means major = target, ahead means major > target. Report the full three-part version verbatim.${varyNote}`,
    expected: expect,
  };
}

// ---- D16 duration binning: histogram over fixed buckets
function d16DurationBinning(r, encounter) {
  const fname = encounter === 2 ? 'job-durations.csv' : 'durations.csv';
  const buckets = ['0-59s', '60-119s', '120-239s', '240s+'];
  const n = int(r, 10, 16);
  const counts = new Map(buckets.map((b) => [b, 0]));
  const rows = [];
  for (let i = 0; i < n; i++) {
    const secs = int(r, 0, 300);
    rows.push(secs);
    const b = secs < 60 ? '0-59s' : secs < 120 ? '60-119s' : secs < 240 ? '120-239s' : '240s+';
    counts.set(b, counts.get(b) + 1);
  }
  const expect = { family: 'D16', buckets: buckets.map((b) => ({ bucket: b, count: String(counts.get(b)) })) };
  let body = (encounter === 3 || encounter === 5) ? '# job runtimes\n' : '';
  body += 'seconds\n';
  for (const s of rows) body += (encounter === 4 && r() < 0.5 ? `"${s}"` : String(s)) + '\n';
  const files = { [fname]: body };
  const varyNote = (encounter === 3 || encounter === 4)
    ? ' Comment lines starting with # must be ignored. Values may be quoted.'
    : encounter === 5
      ? ' Comment lines starting with # must be ignored.'
      : '';
  return {
    workspace: files,
    objective: `Bucket every duration in ${fname} into: 0-59s, 60-119s, 120-239s, 240s+ (upper bounds inclusive except the last bucket which includes everything 240 and above). Report every bucket with its count, in that bucket order, one per line, as RESULT bucket=<label> count=<n>.${varyNote}`,
    expected: expect,
  };
}

// ------------------------------------------------------------ assembly
const FAMILIES = [
  { code: 'D05', name: 'D05-order-join', gen: d05OrderJoin },
  { code: 'D06', name: 'D06-outline-counts', gen: d06OutlineCounts },
  { code: 'D07', name: 'D07-ledger-fold', gen: d07LedgerFold },
  { code: 'D08', name: 'D08-cross-validation', gen: d08CrossValidation },
  { code: 'D09', name: 'D09-daily-report', gen: d09DailyReport },
  { code: 'D10', name: 'D10-file-selection', gen: d10FileSelection },
  { code: 'D11', name: 'D11-normalize', gen: d11Normalize },
  { code: 'D12', name: 'D12-dep-graph', gen: d12DepGraph },
  { code: 'D13', name: 'D13-patch-plan', gen: d13Patch },
  { code: 'D14', name: 'D14-region-totals', gen: d14RegionTotals },
  { code: 'D15', name: 'D15-version-audit', gen: d15VersionAudit },
  { code: 'D16', name: 'D16-duration-binning', gen: d16DurationBinning },
];
const ROLES = { 1: 'admission', 2: 'diagnostic-revision', 3: 'regression', 4: 'terminal-promotion-a', 5: 'terminal-promotion-b' };

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const r = prng(SEED);
const objectives = [];
for (const fam of FAMILIES) {
  for (let enc = 1; enc <= 5; enc++) {
    const { workspace, objective, expected } = fam.gen(r, enc);
    const dir = join(OUT, fam.name, 'encounter-' + enc);
    await mkdir(join(dir, 'workspace'), { recursive: true });
    let contentHash = createHash('sha256');
    contentHash.update(objective + '\n');
    const fileHashes = {};
    for (const [rel, content] of Object.entries(workspace).sort()) {
      const dest = join(dir, 'workspace', rel);
      if (rel.includes('/')) await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, content, 'utf8');
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
  protocol: 'devsuite-m3-v3',
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
