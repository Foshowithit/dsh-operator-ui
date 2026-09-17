#!/usr/bin/env node
// eval/lib/graders-e.mjs — canonical graders for the Eval v2 scored suite
// families E01–E12. Same interface as graders-v2: (expected, evidence,
// wsFiles) → {satisfied, detail}. Grades ordered substance, never phrasing.
// Every grader is validated by test-scored-controls.mjs (golden accept +
// subtle-wrong reject + empty reject per fixture) and the fixture-
// consistency checker before the scored-suite freeze.

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

const E01 = (expected, evidence) => {
  const want = expected.diffs.map((d) => ({ item: d.item, system: d.system, physical: d.physical }));
  const got = pairsOf(evidence, /RESULT\s+item=(\S+)\s+system=(\d+)\s+physical=(\d+)/g, (m) => ({ item: m[1], system: m[2], physical: m[3] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? `all ${want.length} quantity differences in order` : `want [${fmt(want)}] got [${fmt(got)}]` };
};

const E02 = (expected, evidence) => {
  const want = expected.pairs.map((p) => ({ first: p.first, second: p.second }));
  const got = pairsOf(evidence, /RESULT\s+overlap=([^,\s]+),([^\s]+)/g, (m) => ({ first: m[1], second: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? `all ${want.length} overlapping pairs in order` : `want [${fmt(want)}] got [${fmt(got)}]` };
};

const E03 = (expected, evidence) => {
  const want = expected.columns.map((c) => ({ column: c.column, sum: String(c.sum) }));
  const got = pairsOf(evidence, /RESULT\s+column=(\S+)\s+sum=(\d+)/g, (m) => ({ column: m[1], sum: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? 'column sums match in header order' : `want [${fmt(want)}] got [${fmt(got)}]` };
};

const E04 = (expected, evidence) => {
  const want = expected.hours.map((h) => ({ hour: h.hour, count: String(h.count) }));
  const got = pairsOf(evidence, /RESULT\s+hour=(\d{2})\s+count=(\d+)/g, (m) => ({ hour: m[1], count: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? 'hourly counts match ascending' : `want [${fmt(want)}] got [${fmt(got)}]` };
};

const E05 = (expected, evidence) => {
  const want = expected.shares.map((s) => ({ category: s.category, share: s.share }));
  const got = pairsOf(evidence, /RESULT\s+category=(\S+)\s+share=([\d.]+)%/g, (m) => ({ category: m[1], share: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? 'category shares match' : `want [${fmt(want)}] got [${fmt(got)}]` };
};

const E06 = (expected, evidence) => {
  const m = evidence && evidence.match(/RESULT\s+longest=(\d+)\s+kind=(\S+)/);
  const ok = !!m && m[1] === expected.longest && m[2] === expected.kind;
  return { satisfied: ok, detail: ok ? 'longest streak matches' : `want longest=${expected.longest} kind=${expected.kind} got ${m ? m[1] + '/' + m[2] : 'none'}` };
};

const E07 = (expected, evidence) => {
  const want = expected.rows.map((x) => ({ code: x.code, label: x.label }));
  const got = pairsOf(evidence, /RESULT\s+code=(\S+)\s+label=(\S+)/g, (m) => ({ code: m[1], label: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? 'code mapping matches' : `want [${fmt(want)}] got [${fmt(got)}]` };
};

const E08 = (expected, evidence) => {
  const want = expected.lines.map((l) => ({ line: l.line, text: l.text }));
  const got = pairsOf(evidence, /RESULT\s+line=(\d+)\s+text=(.+)$/gm, (m) => ({ line: m[1], text: m[2].trim() }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? 'rendered lines match' : `want [${fmt(want)}] got [${fmt(got)}]` };
};

const E09 = (expected, evidence) => {
  const want = expected.rows.map((x) => ({ name: x.name, score: String(x.score) }));
  const got = pairsOf(evidence, /RESULT\s+name=(\S+)\s+score=(\d+)/g, (m) => ({ name: m[1], score: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? `top-${want.length} with boundary ties` : `want [${fmt(want)}] got [${fmt(got)}]` };
};

const E10 = (expected, evidence) => {
  const want = expected.violations.map((x) => ({ line: x.line, length: String(x.length) }));
  const got = pairsOf(evidence, /RESULT\s+line=(\d+)\s+length=(\d+)/g, (m) => ({ line: m[1], length: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? `all ${want.length} violations in order` : `want [${fmt(want)}] got [${fmt(got)}]` };
};

const E11 = (expected, evidence) => {
  const w = evidence && evidence.match(/RESULT\s+within=(\d+)/);
  const c = evidence && evidence.match(/RESULT\s+closest=(\S+)/);
  const ok = !!w && !!c && w[1] === expected.within && c[1] === expected.closest;
  return { satisfied: ok, detail: ok ? 'radius count + closest match' : `want within=${expected.within} closest=${expected.closest} got ${w ? w[1] : 'none'}/${c ? c[1] : 'none'}` };
};

const E12 = (expected, evidence) => {
  const want = expected.rows.map((x) => ({ row: x.row, total: String(x.total) }));
  const got = pairsOf(evidence, /RESULT\s+row=(\d+)\s+total=(\d+)/g, (m) => ({ row: m[1], total: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? 'running totals match' : `want [${fmt(want)}] got [${fmt(got)}]` };
};

export const GRADERS_E = { E01, E02, E03, E04, E05, E06, E07, E08, E09, E10, E11, E12 };
