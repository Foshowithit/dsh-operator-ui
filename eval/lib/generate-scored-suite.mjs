#!/usr/bin/env node
// eval/lib/generate-scored-suite.mjs — EVAL PROTOCOL V2 scored suite
// (GPT-approved). Generates 12 NEW families (E01–E12 — none of D01–D16,
// none of F01–F10) with, per family:
//   internal fixtures I1–I5  (I1 admission, I2 diagnostic, I3 regression,
//                             I4+I5 dual sacred terminals)
//   scored encounters S1–S6  (S1 acquisition trigger, S2 reuse,
//                             S3 reuse-under-variation, S4–S5 contested,
//                             S6 untouched generalization)
// The acquisition's learning gates consume ONLY internal fixtures; scored
// encounters never feed learning (frozen development-set rule).
//
// Deterministic: seed reproduces the suite byte-identically.
// Usage: node eval/lib/generate-scored-suite.mjs --out eval/scored-suite --seed <n>
//
// GENERATION-TIME LAW (GPT): fixture/grader defects found here or in
// pre-run validation may be repaired before the suite freeze; after the
// freeze, no repair/re-generation based on RCOS behavior.

import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = join(root, argOf('--out', 'eval/scored-suite'));
const SEED = Number(argOf('--seed', 41803398));
const GENERATOR_VERSION = '4.0.0';

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

// Variant feature table shared by all families. v = 1..11.
// v1 plain · v2 new scale/names · v3 +#comments/blank lines ·
// v4 +quoting/schema flip · v5 +noise file/rows · v6..v11 fresh combos.
const feat = (v) => ({
  comments: v >= 3 && v !== 6,
  quoting: v >= 4,
  noiseFile: v >= 5 && v % 2 === 1,
  schemaFlip: v === 4 || v === 8 || v === 10,
  scale: v === 2 || v === 7 ? 'large' : 'normal',
  trailingNote: v >= 6,
});

// ================================================================ E01 reconcile
// Two inventories; report items whose quantities differ (system order).
const E01_ITEMS = ['arm', 'base', 'clamp', 'dowel', 'endcap', 'flange', 'grommet', 'hinge', 'jig', 'knob'];
function e01(r, v) {
  const f = feat(v);
  const files = {};
  const n = f.scale === 'large' ? int(r, 10, 14) : int(r, 6, 9);
  const items = [...E01_ITEMS].sort(() => r() - 0.5).slice(0, n);
  const sysQty = {}, phyQty = {};
  for (const it of items) {
    sysQty[it] = int(r, 1, 60);
    phyQty[it] = r() < 0.45 ? sysQty[it] : int(r, 1, 60);
  }
  const expect = { family: 'E01', diffs: [] };
  for (const it of items) if (sysQty[it] !== phyQty[it]) expect.diffs.push({ item: it, system: String(sysQty[it]), physical: String(phyQty[it]) });
  const fa = v === 2 ? 'records.csv' : 'system.csv';
  const fb = v === 2 ? 'counted.csv' : 'physical.csv';
  const row = (a, b) => (f.schemaFlip ? `${b},${a}` : `${a},${b}`);
  let abody = (f.comments ? '# system of record\n\n' : '') + 'item,qty\n';
  let bbody = (f.comments ? '# physical count\n\n' : '') + 'item,qty\n';
  for (const it of items) {
    const a = row(it, sysQty[it]), b = row(it, phyQty[it]);
    abody += (f.quoting ? `"${it}",${sysQty[it]}\n` : a + '\n');
    bbody += (f.quoting ? `"${it}",${phyQty[it]}\n` : b + '\n');
  }
  if (f.trailingNote) abody += '\n# end of system export\n';
  files[fa] = abody; files[fb] = bbody;
  if (f.noiseFile) files['count-notes.txt'] = 'Notes about the physical count process; not inventory data.\n';
  return {
    workspace: files,
    objective: `Compare ${fa} and ${fb}. Report every item whose quantity differs, in ${fa} order, one per line, as RESULT item=<item> system=<qty-a> physical=<qty-b>.${f.comments ? ' Comment lines starting with # and blank lines must be ignored.' : ''}${f.quoting ? ' Fields may be quoted.' : ''}${f.noiseFile ? ' Ignore files that are not the two inventories.' : ''}`,
    expected: expect,
  };
}

// ================================================================ E02 overlaps
// Report every pair of overlapping intervals, in first-interval file order.
function e02(r, v) {
  const f = feat(v);
  const files = {};
  const names = ['ada', 'bo', 'cy', 'di', 'eli', 'fay', 'gus', 'hal'];
  const n = f.scale === 'large' ? 6 : 4;
  const chosen = [...names].sort(() => r() - 0.5).slice(0, n);
  const slots = [];
  for (const nm of chosen) {
    const start = int(r, 6, 17) * 60 + pick(r, [0, 15, 30]);
    const dur = int(r, 30, 150);
    slots.push({ nm, start, end: start + dur });
  }
  const fmt = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  // guarantee >= 1 overlap: every fixture must have a non-empty expectation
  // (empty expectations are trivially satisfiable — controls caught this)
  if (slots.length >= 2) {
    const hasOverlap = slots.some((a, i) => slots.some((b, j) => j > i && a.start < b.end && b.start < a.end));
    if (!hasOverlap) {
      slots[1].start = slots[0].start + 15;
      slots[1].end = slots[0].start + 15 + 45;
    }
  }
  const expect = { family: 'E02', pairs: [] };
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i], b = slots[j];
      if (a.start < b.end && b.start < a.end) expect.pairs.push({ first: a.nm, second: b.nm });
    }
  }
  const fname = v === 2 ? 'cover-plan.txt' : 'schedule.txt';
  let body = (f.comments ? '# coverage plan\n\n' : '') + 'name start end\n';
  for (const s of slots) {
    const line = v === 4 ? `SHIFT ${s.nm} ${fmt(s.start)}-${fmt(s.end)}` : `${s.nm} ${fmt(s.start)} ${fmt(s.end)}`;
    body += line + '\n';
  }
  if (f.trailingNote) body += '\n# shifts listed chronologically by start\n';
  files[fname] = body;
  if (f.noiseFile) files['policy.txt'] = 'Back-to-back intervals do not overlap. Overlap means sharing any minute.\n';
  return {
    workspace: files,
    objective: `In ${fname}, every line gives a shift's start and end time. Report every PAIR of shifts that overlap (share at least one minute), in the order the FIRST shift appears in the file, one per line, as RESULT overlap=<first>,<second> using the names as written.${v === 4 ? ' Lines may be formatted "SHIFT <name> HH:MM-HH:MM".' : ''}${f.comments ? ' Comment lines starting with # must be ignored.' : ''}${f.noiseFile ? ' Ignore non-schedule files.' : ''}`,
    expected: expect,
  };
}

// ================================================================ E03 column sums
// Sum every numeric column of a grid; report in header order.
function e03(r, v) {
  const f = feat(v);
  const files = {};
  const cols = ['jan', 'feb', 'mar', 'apr', 'may'];
  const k = f.scale === 'large' ? 5 : 3;
  const use = cols.slice(0, k);
  const rows = int(r, 4, 7);
  const data = [];
  const sums = Object.fromEntries(use.map((c) => [c, 0]));
  for (let i = 0; i < rows; i++) {
    const row = {};
    for (const c of use) { row[c] = int(r, 1, 90); sums[c] += row[c]; }
    data.push(row);
  }
  const expect = { family: 'E03', columns: use.map((c) => ({ column: c, sum: String(sums[c]) })) };
  const fname = v === 2 ? 'quarter-grid.csv' : 'grid.csv';
  let body = (f.comments ? '# monthly grid\n\n' : '') + 'row,' + use.join(',') + '\n';
  data.forEach((row, i) => { body += `r${i + 1},` + use.map((c) => row[c]).join(',') + '\n'; });
  if (f.trailingNote) body += '# totals not included\n';
  files[fname] = body;
  if (f.noiseFile) files['legend.txt'] = 'Each row is one store; each column is one month.\n';
  return {
    workspace: files,
    objective: `Sum each month column in ${fname} and report every column with its total, in header order, one per line, as RESULT column=<name> sum=<total>.${f.comments ? ' Comment lines starting with # must be ignored.' : ''}${f.noiseFile ? ' Ignore non-grid files.' : ''}`,
    expected: expect,
  };
}

// ================================================================ E04 hourly counts
// Count events per hour; report hours with at least one event, ascending.
function e04(r, v) {
  const f = feat(v);
  const files = {};
  const n = f.scale === 'large' ? int(r, 16, 22) : int(r, 10, 14);
  const counts = new Map();
  const lines = [];
  for (let i = 0; i < n; i++) {
    const h = int(r, 6, 21);
    const m = pick(r, [5, 10, 20, 35, 45, 55]);
    counts.set(h, (counts.get(h) || 0) + 1);
    lines.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${pick(r, ['open', 'close', 'scan', 'sync'])}`);
  }
  const expect = { family: 'E04', hours: [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([h, c]) => ({ hour: String(h).padStart(2, '0'), count: String(c) })) };
  const fname = v === 2 ? 'access-feed.txt' : 'events.txt';
  let body = (f.comments ? '# access events\n\n' : '') + lines.join('\n') + '\n';
  if (f.trailingNote) body += '# end\n';
  files[fname] = body;
  if (f.noiseFile) files['note.txt'] = 'Timestamps are 24-hour HH:MM.\n';
  return {
    workspace: files,
    objective: `Count the events per hour in ${fname} and report every hour that has at least one event, sorted by hour ascending, one per line, as RESULT hour=<HH> count=<n> (two-digit hour).${f.comments ? ' Comment lines starting with # must be ignored.' : ''}${f.noiseFile ? ' Ignore non-feed files.' : ''}`,
    expected: expect,
  };
}

// ================================================================ E05 shares
// Percentage share per category, 1 decimal, desc share then name; exclude "other".
function e05(r, v) {
  const f = feat(v);
  const files = {};
  const cats = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
  const k = f.scale === 'large' ? 5 : 4;
  const use = [...cats].sort(() => r() - 0.5).slice(0, k);
  const counts = {};
  let total = 0;
  for (const c of use) { counts[c] = int(r, 5, 60); total += counts[c]; }
  const exclude = v >= 4; // later variants exclude an "other" bucket from the total
  let excl = 0;
  if (exclude) { excl = int(r, 10, 40); }
  const denom = total + excl;
  const expect = { family: 'E05', shares: use.map((c) => ({ category: c, share: (counts[c] * 100 / (exclude ? total : total)).toFixed(1) })) };
  // share denominator: when "other" is excluded the shares are of the named total
  expect.shares = use.map((c) => ({ category: c, share: (counts[c] * 100 / total).toFixed(1) }));
  const sorted = [...expect.shares].sort((a, b) => Number(b.share) - Number(a.share) || a.category.localeCompare(b.category));
  expect.shares = sorted;
  const fname = v === 2 ? 'visits-by-channel.csv' : 'visits.csv';
  let body = (f.comments ? '# channel visits\n\n' : '') + 'channel,visits\n';
  for (const c of use) body += `${c},${counts[c]}\n`;
  if (exclude) body += `other,${excl}\n`;
  if (f.trailingNote) body += '# other is not a named channel\n';
  files[fname] = body;
  if (f.noiseFile) files['readme.txt'] = exclude ? 'Shares are computed over NAMED channels only; the "other" row is excluded from both numerator and denominator.\n' : 'Shares are computed over all rows.\n';
  return {
    workspace: files,
    objective: `Report each named channel's share of total visits in ${fname} as a percentage with exactly one decimal place, sorted by share descending then channel name alphabetically, one per line, as RESULT category=<name> share=<pct>% (include the % sign in the value).${exclude ? ' The "other" row is NOT a named channel and must be excluded from the share computation.' : ''}${f.comments ? ' Comment lines starting with # must be ignored.' : ''}`,
    expected: expect,
  };
}

// ================================================================ E06 longest streak
// Longest consecutive run of the same token; report length + kind.
function e06(r, v) {
  const f = feat(v);
  const files = {};
  const n = f.scale === 'large' ? int(r, 24, 30) : int(r, 14, 20);
  const seq = [];
  for (let i = 0; i < n; i++) seq.push(r() < 0.6 ? 'pass' : 'fail');
  let best = 1, bestKind = seq[0], cur = 1, curKind = seq[0];
  for (let i = 1; i < n; i++) {
    if (seq[i] === curKind) cur += 1;
    else { cur = 1; curKind = seq[i]; }
    if (cur > best || (cur === best && curKind === 'pass' && bestKind === 'fail')) { best = cur; bestKind = curKind; }
  }
  const expect = { family: 'E06', longest: String(best), kind: bestKind };
  const fname = v === 2 ? 'build-results.txt' : 'checks.txt';
  const tokens = v === 4 ? seq.map((t) => (t === 'pass' ? 'OK' : 'FAIL')) : seq;
  const norm = { OK: 'pass', FAIL: 'fail' };
  if (v === 4) {
    let b2 = 1, k2 = norm[tokens[0]], c2 = 1;
    for (let i = 1; i < tokens.length; i++) {
      const t = norm[tokens[i]];
      if (t === k2) c2 += 1; else { c2 = 1; k2 = t; }
      if (c2 > b2) { b2 = c2; k2 = t; }
    }
    expect.longest = String(b2); expect.kind = k2;
  }
  let body = (f.comments ? '# check results\n\n' : '') + tokens.join('\n') + '\n';
  if (f.trailingNote) body += '# end of run\n';
  files[fname] = body;
  if (f.noiseFile) files['summary.txt'] = 'This file describes the run; the sequence itself is in the results file.\n';
  return {
    workspace: files,
    objective: `In ${fname}, each line is one check result${v === 4 ? ' (OK means pass, FAIL means fail)' : ' (pass or fail)'}. Report the LONGEST run of identical consecutive results as RESULT longest=<n> kind=<pass|fail> (if two runs are equally long, report the one of kind pass).${f.comments ? ' Comment lines starting with # must be ignored.' : ''}${f.noiseFile ? ' Ignore descriptive files.' : ''}`,
    expected: expect,
  };
}


// ================================================================ E07 code mapping
// Map used codes to labels via a lookup file; unknown codes reported as UNKNOWN.
function e07(r, v) {
  const f = feat(v);
  const files = {};
  const codes = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8'];
  const labels = { A1: 'starter', B2: 'pro', C3: 'trial', D4: 'legacy', E5: 'edu', F6: 'gov', G7: 'lab', H8: 'beta' };
  const known = [...codes].sort(() => r() - 0.5).slice(0, f.scale === 'large' ? 6 : 5);
  const useCount = f.scale === 'large' ? int(r, 8, 10) : int(r, 5, 7);
  const used = [];
  for (let i = 0; i < useCount; i++) used.push(r() < 0.75 ? pick(r, known) : 'X' + int(r, 1, 9));
  const expect = { family: 'E07', rows: used.map((c) => ({ code: c, label: labels[c] ?? 'UNKNOWN' })) };
  const fa = v === 2 ? 'plans.csv' : 'codes.csv';
  const fb = v === 2 ? 'licenses-used.txt' : 'used.txt';
  let lbody = (f.comments ? '# plan codes\n\n' : '') + 'code,label\n';
  for (const c of known) lbody += (f.quoting ? `"${c}","${labels[c]}"\n` : `${c},${labels[c]}\n`);
  let ubody = (f.comments ? '# licenses in use\n\n' : '') + used.join('\n') + '\n';
  if (f.trailingNote) ubody += '\n';
  files[fa] = lbody; files[fb] = ubody;
  if (f.noiseFile) files['handbook.txt'] = 'Unknown codes must be reported with label UNKNOWN.\n';
  return {
    workspace: files,
    objective: `Map every code in ${fb} using the lookup in ${fa}, in ${fb} order, one per line, as RESULT code=<code> label=<label>. Codes missing from the lookup must be reported with label UNKNOWN.${f.comments ? ' Comment lines starting with # must be ignored.' : ''}${f.quoting ? ' Fields may be quoted.' : ''}${f.noiseFile ? ' Ignore non-lookup files.' : ''}`,
    expected: expect,
  };
}

// ================================================================ E08 template render
// Render a template with variables; report rendered lines in order.
function e08(r, v) {
  const f = feat(v);
  const files = {};
  const vars = { area: pick(r, ['north', 'south', 'central']), lead: pick(r, ['maria', 'tomek', 'priya', 'sam']), unit: 'u' + int(r, 10, 99), count: String(int(r, 4, 20)) };
  const lines = [
    'Deployment for {{area}}',
    'Lead engineer: {{lead}}',
    'Unit {{unit}} covers {{count}} nodes.',
  ];
  const expect = { family: 'E08', lines: lines.map((l, i) => ({ line: String(i + 1), text: l.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '') })) };
  const ft = v === 2 ? 'deploy-card.txt' : 'template.txt';
  const fv = v === 2 ? 'deploy-values.txt' : 'vars.txt';
  let tbody = (f.comments ? '# deployment template\n\n' : '') + lines.join('\n') + '\n';
  if (f.trailingNote) tbody += '# template end\n';
  let vbody = (f.comments ? '# variable values\n\n' : '') + Object.entries(vars).map(([k, val]) => `${k}=${val}`).join('\n') + '\n';
  files[ft] = tbody; files[fv] = vbody;
  if (f.noiseFile) files['style.txt'] = 'Placeholders look like {{name}}; values come from the values file.\n';
  return {
    workspace: files,
    objective: `Render ${ft} by replacing every {{name}} placeholder with the matching value from ${fv}. Report each rendered line in order, one per line, as RESULT line=<n> text=<rendered line>.${f.comments ? ' Comment lines starting with # must be ignored in BOTH files (placeholders in comments do not count).' : ''}${f.noiseFile ? ' Ignore non-template files.' : ''}`,
    expected: expect,
  };
}

// ================================================================ E09 top-N with ties
// Top N scores including ALL boundary ties.
function e09(r, v) {
  const f = feat(v);
  const files = {};
  const names = ['axiom', 'boru', 'cairn', 'duna', 'ember', 'flint', 'gorse', 'hale'];
  const n = f.scale === 'large' ? 8 : 6;
  const chosen = [...names].sort(() => r() - 0.5).slice(0, n);
  const scored = chosen.map((nm) => ({ nm, score: int(r, 40, 99) }));
  const topN = v >= 4 ? 3 : 2;
  const cutoff = [...scored].sort((a, b) => b.score - a.score)[Math.min(topN, scored.length) - 1].score;
  const expect = { family: 'E09', rows: scored.filter((x) => x.score >= cutoff).sort((a, b) => b.score - a.score || a.nm.localeCompare(b.nm)).map((x) => ({ name: x.nm, score: String(x.score) })) };
  const fname = v === 2 ? 'leaderboard.csv' : 'scores.csv';
  let body = (f.comments ? '# tournament scores\n\n' : '') + 'name,score\n';
  for (const x of scored) body += (f.quoting ? `"${x.nm}",${x.score}\n` : `${x.nm},${x.score}\n`);
  files[fname] = body;
  if (f.noiseFile) files['rules.txt'] = 'Report at least N entries and include every tied score at the boundary.\n';
  return {
    workspace: files,
    objective: `Report the top ${topN} scores from ${fname} — including EVERY entry tied with the ${topN}th-place score — sorted by score descending then name alphabetically, one per line, as RESULT name=<name> score=<n>.${f.comments ? ' Comment lines starting with # must be ignored.' : ''}${f.quoting ? ' Fields may be quoted.' : ''}`,
    expected: expect,
  };
}

// ================================================================ E10 line-length policy
// Lines exceeding a maximum length, with line numbers.
function e10(r, v) {
  const f = feat(v);
  const files = {};
  const maxLen = [0, 40, 52, 40, 60, 48][v <= 5 ? v : 5] || 40;
  const n = f.scale === 'large' ? int(r, 12, 16) : int(r, 8, 12);
  const words = ['relay', 'orbit', 'panel', 'signal', 'buffer', 'channel', 'matrix', 'vector', 'socket', 'bridge'];
  const lines = [];
  for (let i = 0; i < n; i++) {
    const wc = int(r, 2, 12);
    const ln = Array.from({ length: wc }, () => pick(r, words)).join(' ');
    lines.push(ln);
  }
  const fname = v === 2 ? 'release-notes.txt' : 'notes.txt';
  const fstart = f.comments ? 3 : 1; // comment + blank line occupy file lines 1-2
  let body = (f.comments ? '# policy: max ' + maxLen + ' chars per line\n\n' : '') + lines.join('\n') + '\n';
  if (f.trailingNote) body += '# end of notes\n';
  // violations carry FILE line numbers (comments/blank lines count; the
  // trailing note does not contain data lines)
  const expect = { family: 'E10', violations: [] };
  lines.forEach((ln, i) => { if (ln.length > maxLen) expect.violations.push({ line: String(fstart + i), length: String(ln.length) }); });
  files[fname] = body;
  if (f.noiseFile) files['policy.txt'] = `Lines longer than ${maxLen} characters violate the policy.\n`;
  return {
    workspace: files,
    objective: `Every line in ${fname} must be at most ${maxLen} characters. Report each violating line in file order, one per line, as RESULT line=<line number> length=<character count>.${f.comments ? ' Comment lines starting with # are exempt and must be ignored.' : ''}${f.noiseFile ? ' Ignore non-notes files.' : ''}`,
    expected: expect,
  };
}

// ================================================================ E11 radius count
// Points within a radius of the origin; closest point reported.
function e11(r, v) {
  const f = feat(v);
  const files = {};
  const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
  const n = f.scale === 'large' ? 8 : 6;
  const chosen = [...names].sort(() => r() - 0.5).slice(0, n);
  const radius = [0, 10, 14, 10, 18, 12][v <= 5 ? v : 5] || 10;
  const pts = chosen.map((nm) => ({ nm, x: int(r, -20, 20), y: int(r, -20, 20) }));
  // guarantee >= 1 point within the radius (empty expectations are not
  // gradeable under the declared contract — controls caught this)
  if (!pts.some((p) => p.x * p.x + p.y * p.y <= radius * radius)) {
    pts[0].x = int(r, 0, Math.max(1, Math.floor(radius / 3)));
    pts[0].y = 0;
  }
  const within = pts.filter((p) => p.x * p.x + p.y * p.y <= radius * radius);
  const closest = within.length ? [...within].sort((a, b) => (a.x * a.x + a.y * a.y) - (b.x * b.x + b.y * b.y) || a.nm.localeCompare(b.nm))[0].nm : '';
  const expect = { family: 'E11', within: String(within.length), closest };
  const fname = v === 2 ? 'stations.csv' : 'points.csv';
  let body = (f.comments ? '# station coordinates\n\n' : '') + 'name,x,y\n';
  for (const p of pts) body += (f.quoting ? `"${p.nm}",${p.x},${p.y}\n` : `${p.nm},${p.x},${p.y}\n`);
  files[fname] = body;
  if (f.noiseFile) files['grid.txt'] = `Distance means straight-line distance from the origin (0,0); a point exactly on the radius counts as within.\n`;
  return {
    workspace: files,
    objective: `In ${fname}, count the points within straight-line distance ${radius} of the origin (points exactly on the radius count) and identify the closest point to the origin. Report exactly two lines: RESULT within=<count> and RESULT closest=<name> (alphabetical tie-break if two are equally close).${f.comments ? ' Comment lines starting with # must be ignored.' : ''}${f.quoting ? ' Fields may be quoted.' : ''}`,
    expected: expect,
  };
}

// ================================================================ E12 running totals
// Cumulative total after each row, in file order.
function e12(r, v) {
  const f = feat(v);
  const files = {};
  const n = f.scale === 'large' ? int(r, 9, 12) : int(r, 6, 9);
  const vals = Array.from({ length: n }, () => int(r, 5, 80));
  let acc = 0;
  const expect = { family: 'E12', rows: vals.map((val, i) => { acc += val; return { row: String(i + 1), total: String(acc) }; }) };
  const fname = v === 2 ? 'daily-units.csv' : 'values.csv';
  let body = (f.comments ? '# daily values\n\n' : '') + 'value\n';
  for (const val of vals) body += val + '\n';
  if (f.trailingNote) body += '# end of series\n';
  files[fname] = body;
  if (f.noiseFile) files['notes.txt'] = 'The running total starts at zero before the first row.\n';
  return {
    workspace: files,
    objective: `Process ${fname} in order and report the running total after each row, one per line, as RESULT row=<n> total=<cumulative sum>.${f.comments ? ' Comment lines starting with # must be ignored.' : ''}${f.noiseFile ? ' Ignore non-series files.' : ''}`,
    expected: expect,
  };
}

export const FAMILIES = [
  { code: 'E01', name: 'E01-inventory-reconcile', gen: e01 },
  { code: 'E02', name: 'E02-interval-overlaps', gen: e02 },
  { code: 'E03', name: 'E03-column-sums', gen: e03 },
  { code: 'E04', name: 'E04-hourly-counts', gen: e04 },
  { code: 'E05', name: 'E05-category-shares', gen: e05 },
  { code: 'E06', name: 'E06-longest-streak', gen: e06 },
  { code: 'E07', name: 'E07-code-mapping', gen: e07 },
  { code: 'E08', name: 'E08-template-render', gen: e08 },
  { code: 'E09', name: 'E09-top-n-ties', gen: e09 },
  { code: 'E10', name: 'E10-line-length-policy', gen: e10 },
  { code: 'E11', name: 'E11-radius-count', gen: e11 },
  { code: 'E12', name: 'E12-running-totals', gen: e12 },
];

// ---- assembly: internal I1–I5 + scored S1–S6 per family ----

const ROLES_INTERNAL = { 1: 'admission', 2: 'diagnostic', 3: 'regression', 4: 'terminal-a', 5: 'terminal-b' };
const ROLES_SCORED = { 1: 'acquisition', 2: 'reuse', 3: 'reuse-variation', 4: 'contested-a', 5: 'contested-b', 6: 'untouched-generalization' };

await mkdir(OUT, { recursive: true });
const r = prng(SEED);
const fixtures = [];
for (const fam of FAMILIES) {
  for (const [kind, roles] of [['internal', ROLES_INTERNAL], ['scored', ROLES_SCORED]]) {
    for (const [kStr, role] of Object.entries(roles)) {
      const k = Number(kStr);
      const v = kind === 'internal' ? k : 5 + k; // fresh combos for scored
      const { workspace, objective, expected } = fam.gen(r, v);
      fixtures.push({ fam, kind, k, role, workspace, objective, expected });
    }
  }
}
const manifest = { protocol: 'eval-v2-scored-suite', seed: SEED, generatorVersion: GENERATOR_VERSION, generatedAt: new Date().toISOString(), families: [], fixtures: [] };
for (const fx of fixtures) {
  const dir = join(OUT, fx.fam.name, `${fx.kind}-${fx.k}`, 'workspace');
  await mkdir(dir, { recursive: true });
  const fileHashes = {};
  for (const [rel, content] of Object.entries(fx.workspace).sort()) {
    await writeFile(join(dir, rel), content, 'utf8');
    fileHashes[rel] = sha256(content);
  }
  const expectedJson = JSON.stringify({ ...fx.expected, role: fx.role, fixture_kind: fx.kind }, null, 2) + '\n';
  await writeFile(join(OUT, fx.fam.name, `${fx.kind}-${fx.k}`, 'objective.txt'), fx.objective + '\n', 'utf8');
  await writeFile(join(OUT, fx.fam.name, `${fx.kind}-${fx.k}`, 'expected.json'), expectedJson, 'utf8');
  manifest.fixtures.push({
    id: `${fx.fam.name}/${fx.kind}-${fx.k}`, family: fx.fam.code, kind: fx.kind, index: fx.k, role: fx.role,
    files: fileHashes, objective_sha256: sha256(fx.objective + '\n'), expected_sha256: sha256(expectedJson),
  });
}
for (const fam of FAMILIES) manifest.families.push({ code: fam.code, name: fam.name });
await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`scored suite: ${FAMILIES.length} families, ${fixtures.length} fixtures → ${OUT}`);
