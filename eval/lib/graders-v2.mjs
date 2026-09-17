#!/usr/bin/env node
// eval/lib/graders-v2.mjs — the canonical v2 ruler (GPT checkpoint:
// "10/10 deterministic graders + positive and negative controls +
// canonical execution-workspace artifact contract").
//
// One interface for every family: grader(expected, evidence, wsFiles)
//   expected   — frozen expected.json of the fixture
//   evidence   — operator-legible output text (node outputs the run produced)
//   wsFiles    — POST-RUN snapshot of the EXECUTION workspace
//                ([{ path, bytes, body }]) — file-state graders read HERE
//                and only here, never from a staging copy (the v1
//                grader-location defect class).
// Returns { satisfied, detail }. Grades ordered substance, never phrasing.
//
// Control discipline (GPT): every grader is proven to ACCEPT its golden
// evidence and to REJECT (a) subtly-wrong near-misses and (b) corrupt /
// empty evidence — see test-grader-controls.mjs.

import { D01, D02, D03, D04 } from './devsuite-graders.mjs';

const fmt = (list) => list.map((x) => JSON.stringify(x)).join(' | ').slice(0, 180);
const pairsOf = (evidence, re, map) => {
  const got = [];
  if (evidence) for (const m of evidence.matchAll(re)) got.push(map(m));
  return got;
};
const sameList = (want, got) =>
  want.length === got.length && want.every((w, i) => {
    const g = got[i];
    return g && Object.keys(w).every((k) => String(w[k]) === String(g[k]));
  });

// wsFiles helper: read a file body from the EXECUTION-workspace snapshot.
const wsBody = (wsFiles, path) => {
  const f = (wsFiles || []).find((x) => x.path === path);
  return f ? f.body : null;
};

// F01 — text stats: totals line across all .txt files.
const F01 = (expected, evidence) => {
  const t = expected.total;
  const m = evidence && (evidence.match(/TOTAL Lines: (\d+) Words: (\d+) Bytes: (\d+)/)
    || evidence.match(/RESULT lines=(\d+) words=(\d+) bytes=(\d+)/));
  const ok = !!m && Number(m[1]) === t.lines && Number(m[2]) === t.words && Number(m[3]) === t.bytes;
  return { satisfied: ok, detail: ok ? 'totals match' : `totals missing/wrong (want L=${t.lines} W=${t.words} B=${t.bytes})` };
};

// F02 — repository inventory: per-extension counts, total, TODO count.
const F02 = (expected, evidence) => {
  const missing = [];
  for (const [ext, n] of Object.entries(expected.byType || {})) {
    const hit = pairsOf(evidence, new RegExp(`(?:ext|type)=${ext}\\s+count=(\\d+)`, 'g'), (m) => m[1])[0]
      || (evidence && evidence.match(new RegExp(`${ext}[^\\n]{0,20}?(\\d+)\\b`))?.[1]);
    if (!hit || Number(hit) !== n) missing.push(`${ext}=${n}`);
  }
  const totalHit = evidence && (evidence.match(/RESULT total=(\d+)/) || evidence.match(/total[=:]\s*(\d+)/i))?.[1];
  if (!totalHit || Number(totalHit) !== expected.total) missing.push(`total=${expected.total}`);
  const todoHit = evidence && (evidence.match(/RESULT todo=(\d+)/) || evidence.match(/todo[s]?[=:]\s*(\d+)/i))?.[1];
  if (!todoHit || Number(todoHit) !== expected.todoCount) missing.push(`todo=${expected.todoCount}`);
  const ok = missing.length === 0;
  return { satisfied: ok, detail: ok ? 'inventory matches' : `missing/wrong: ${missing.join(', ')}` };
};

// F03 — structured extraction: ordered (host, port) pairs.
const F03 = (expected, evidence) => {
  const meta = new Set(['total_pairs', 'status', 'artifact', 'count']);
  const got = pairsOf(evidence, /RESULT\s+(\S+)=(\d+)/g, (m) => (!meta.has(m[1]) && m[1].includes('.') ? { host: m[1], port: m[2] } : null))
    .filter(Boolean);
  for (const m of evidence ? evidence.matchAll(/host=(\S+)\s+port=(\d+)/g) : []) got.push({ host: m[1], port: m[2] });
  const want = Object.entries(expected.fields).map(([host, port]) => ({ host, port: String(port) }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? 'extraction matches' : `want [${fmt(want)}] got [${fmt(got)}]` };
};

// F04 — line transform: the transformed file in the EXECUTION workspace.
const F04 = (expected, evidence, wsFiles) => {
  const body = wsBody(wsFiles, expected.file);
  const lines = body ? body.replace(/\n+$/, '').split('\n') : null;
  const ok = !!lines && JSON.stringify(lines) === JSON.stringify(expected.sorted);
  return { satisfied: ok, detail: ok ? `${expected.file} correct (execution workspace)` : `${expected.file} missing/wrong in execution workspace` };
};

// F05 — validation gate: verdict + missing-file evidence.
const F05 = (expected, evidence) => {
  const v = expected.verdict;
  const said = evidence && new RegExp('\\b' + v + '\\b').test(evidence.toUpperCase());
  const missingOK = expected.missing.every((f) => !said || (evidence && evidence.includes(f)) || v === 'PASS');
  const ok = !!said && missingOK;
  return { satisfied: ok, detail: ok ? `verdict ${v}` : `verdict missing/wrong (expected ${v})` };
};

// F06 — release prep: version + Unreleased entries (order preserved).
const F06 = (expected, evidence) => {
  const vHit = evidence && (evidence.match(/RESULT version=(\S+)/) || evidence.match(/version[=:]\s*(\S+)/i))?.[1];
  const versionOk = !!vHit && vHit === expected.version;
  const gotEntries = pairsOf(evidence, /RESULT entry=(.+)$/gm, (m) => m[1].trim());
  const entriesOk = sameList(expected.entries.map((e) => ({ entry: e })), gotEntries.map((e) => ({ entry: e })));
  const ok = versionOk && entriesOk;
  return { satisfied: ok, detail: ok ? 'release evidence matches' : `version ${versionOk ? 'ok' : `want ${expected.version} got ${vHit ?? 'none'}`}; entries ${entriesOk ? 'ok' : `want ${expected.entries.length} got ${gotEntries.length}`}` };
};

// F07 — duplicate report: ordered duplicate set.
const F07 = (expected, evidence) => {
  const got = pairsOf(evidence, /RESULT email=(\S+) count=(\d+)/g, (m) => ({ email: m[1], count: m[2] }));
  const want = expected.duplicates.map((d) => ({ email: d.email, count: String(d.count) }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? 'duplicates match' : `want [${fmt(want)}] got [${fmt(got)}]` };
};

// F08 — format conversion: converted JSON in the EXECUTION workspace.
const F08 = (expected, evidence, wsFiles) => {
  const body = wsBody(wsFiles, 'stock.json');
  let arr = null;
  try { arr = JSON.parse(body); } catch { /* missing/invalid */ }
  const ok = !!arr && JSON.stringify(arr) === JSON.stringify(expected.json);
  return { satisfied: ok, detail: ok ? 'stock.json correct (execution workspace)' : 'stock.json missing/wrong in execution workspace' };
};

// F09 — log analysis: per-level counts.
const F09 = (expected, evidence) => {
  let ok = true;
  for (const lv of ['INFO', 'WARN', 'ERROR']) {
    const m = evidence && evidence.match(new RegExp(lv + '\\D*(\\d+)'));
    if (!m || Number(m[1]) !== expected.counts[lv]) ok = false;
  }
  return { satisfied: ok, detail: ok ? 'level counts match' : 'level counts missing/wrong' };
};

// F10 — dependency audit: every mismatch reported (declared vs locked).
// Zero-mismatch fixtures must be DECLARED (a silent pass is not evidence).
const F10 = (expected, evidence) => {
  const want = (expected.mismatches || []).map((m) => ({ pkg: m.name, declared: m.declared, locked: m.locked }));
  const got = pairsOf(evidence, /RESULT package=(\S+) declared=(\S+) locked=(\S+)/g, (m) => ({ pkg: m[1], declared: m[2], locked: m[3] }));
  let ok;
  if (want.length === 0) {
    ok = got.length === 0 && !!evidence && /RESULT (mismatches=0|no mismatches)/i.test(evidence);
  } else {
    ok = sameList(want, got);
  }
  return { satisfied: ok, detail: ok ? (want.length ? 'mismatch set matches' : 'zero mismatches declared') : `want [${fmt(want)}] got [${fmt(got)}]` };
};


// ---- v3.0.0 breadth families (D05–D16) ----

// D05 — multi-file join: per-order totals in orders-file order.
const D05 = (expected, evidence) => {
  const want = expected.lines.map((l) => ({ order: l.order, item: l.item, total: l.total }));
  const got = pairsOf(evidence, /RESULT\s+order=(\S+)\s+item=(\S+)\s+total=(\S+)/g, (m) => ({ order: m[1], item: m[2], total: m[3] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? `all ${want.length} joined orders in file order` : `want [${fmt(want)}] got [${fmt(got)}]` };
};

// D06 — hierarchical outline: sub-entry counts per top-level section.
const D06 = (expected, evidence) => {
  const want = expected.sections.map((x) => ({ section: x.section, items: String(x.items) }));
  const got = pairsOf(evidence, /RESULT\s+section=(\S+)\s+items=(\d+)/g, (m) => ({ section: m[1], items: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? 'section counts match in file order' : `want [${fmt(want)}] got [${fmt(got)}]` };
};

// D07 — stateful ledger fold: final and minimum running balance.
const D07 = (expected, evidence) => {
  const fin = evidence && evidence.match(/RESULT\s+final=(-?\d+)/);
  const mn = evidence && evidence.match(/RESULT\s+min=(-?\d+)/);
  const ok = !!fin && !!mn && fin[1] === expected.final && mn[1] === expected.min;
  return { satisfied: ok, detail: ok ? 'ledger fold matches' : `final/min missing or wrong (want final=${expected.final} min=${expected.min})` };
};

// D08 — cross-file validation: per-file status, alphabetical order.
const D08 = (expected, evidence) => {
  const want = expected.statuses.map((x) => ({ file: x.file, status: x.status }));
  const got = pairsOf(evidence, /RESULT\s+file=(\S+)\s+status=(\S+)/g, (m) => ({ file: m[1], status: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? `all ${want.length} statuses in alphabetical order` : `want [${fmt(want)}] got [${fmt(got)}]` };
};

// D09 — daily report: per-date counts, date ascending.
const D09 = (expected, evidence) => {
  const want = expected.days.map((x) => ({ date: x.date, count: String(x.count) }));
  const got = pairsOf(evidence, /RESULT\s+date=(\d{4}-\d{2}-\d{2})\s+count=(\d+)/g, (m) => ({ date: m[1], count: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? 'per-date counts match, date order' : `want [${fmt(want)}] got [${fmt(got)}]` };
};

// D10 — filesystem selection: files above threshold, alphabetical paths.
const D10 = (expected, evidence, wsFiles) => {
  // Grader verifies against the EXECUTION workspace when available: the
  // reported sizes must match real file sizes (artifact-location honesty).
  const want = expected.files.map((x) => ({ file: x.file, size: String(x.size) }));
  const got = pairsOf(evidence, /RESULT\s+file=(\S+)\s+size=(\d+)/g, (m) => ({ file: m[1], size: m[2] }));
  let ok = sameList(want, got);
  let detail = ok ? 'selected files match, alphabetical' : `want [${fmt(want)}] got [${fmt(got)}]`;
  if (ok && wsFiles && wsFiles.length) {
    for (const g of got) {
      const real = wsFiles.find((f) => f.path === g.file);
      if (real && real.bytes !== null && Number(g.size) !== Number(real.bytes)) { ok = false; detail = `reported size ${g.size} but ${g.file} is ${real.bytes} bytes in the execution workspace`; break; }
    }
  }
  return { satisfied: ok, detail };
};

// D11 — normalization: lowercase-hyphen name + 10-digit phone.
const D11 = (expected, evidence) => {
  const want = expected.contacts.map((x) => ({ name: x.name, phone: x.phone }));
  const got = pairsOf(evidence, /RESULT\s+name=([a-z0-9-]+)\s+phone=(\d{10})/g, (m) => ({ name: m[1], phone: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? 'normalized contacts match' : `want [${fmt(want)}] got [${fmt(got)}]` };
};

// D12 — dependency graph: per-component counts + heaviest component.
const D12 = (expected, evidence) => {
  const wantCounts = expected.counts.map((x) => ({ component: x.component, deps: String(x.deps) }));
  const gotCounts = pairsOf(evidence, /RESULT\s+component=(\S+)\s+deps=(\d+)/g, (m) => ({ component: m[1], deps: m[2] }));
  const hv = evidence && evidence.match(/RESULT\s+heaviest=(\S+)/);
  const countsOk = sameList(wantCounts, gotCounts);
  const hvOk = !!hv && hv[1] === expected.heaviest;
  const ok = countsOk && hvOk;
  return { satisfied: ok, detail: ok ? 'dependency counts and heaviest match' : `counts ${countsOk ? 'ok' : `want [${fmt(wantCounts)}] got [${fmt(gotCounts)}]`}; heaviest ${hvOk ? 'ok' : `want ${expected.heaviest}`}` };
};

// D13 — structured patching: applied changes in plan order.
const D13 = (expected, evidence) => {
  const want = expected.applied.map((x) => ({ key: x.key, from: x.from, to: x.to }));
  const got = pairsOf(evidence, /RESULT\s+key=(\S+)\s+from=(\S+)\s+to=(\S+)/g, (m) => ({ key: m[1], from: m[2], to: m[3] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? 'patch plan applied in order' : `want [${fmt(want)}] got [${fmt(got)}]` };
};

// D14 — aggregation with exclusions: per-region totals.
const D14 = (expected, evidence) => {
  const want = expected.totals.map((x) => ({ region: x.region, total: String(x.total) }));
  const got = pairsOf(evidence, /RESULT\s+region=(\S+)\s+total=(\d+)/g, (m) => ({ region: m[1], total: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? 'region totals match' : `want [${fmt(want)}] got [${fmt(got)}]` };
};

// D15 — version audit: per-component semver staleness.
const D15 = (expected, evidence) => {
  const want = expected.rows.map((x) => ({ name: x.name, version: x.version, status: x.status }));
  const got = pairsOf(evidence, /RESULT\s+name=(\S+)\s+version=(\d+\.\d+\.\d+)\s+status=(\S+)/g, (m) => ({ name: m[1], version: m[2], status: m[3] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? 'version audit matches' : `want [${fmt(want)}] got [${fmt(got)}]` };
};

// D16 — duration binning: fixed-bucket histogram in bucket order.
const D16 = (expected, evidence) => {
  const want = expected.buckets.map((x) => ({ bucket: x.bucket, count: String(x.count) }));
  const got = pairsOf(evidence, /RESULT\s+bucket=(\S+)\s+count=(\d+)/g, (m) => ({ bucket: m[1], count: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? 'bucket histogram matches' : `want [${fmt(want)}] got [${fmt(got)}]` };
};

export const GRADERS_V2 = { F01, F02, F03, F04, F05, F06, F07, F08, F09, F10, D01, D02, D03, D04, D05, D06, D07, D08, D09, D10, D11, D12, D13, D14, D15, D16 };
export const FAMILY_CODES = Object.keys(GRADERS_V2);
