#!/usr/bin/env node
// eval/lib/devsuite-graders.mjs — independent result-state graders for the
// M3.0 dev suite. Pure functions: (expected, evidenceText) → {satisfied,
// detail}. These grade OBSERVED EFFECTS (the ordered substance of the
// output), never phrasing — the ObjectiveEvaluator law (docs/M3-SPEC.md
// §2.3) in its deterministic form.

const pairsOf = (evidence, re, map) => {
  const got = [];
  for (const m of evidence.matchAll(re)) got.push(map(m));
  return got;
};
const sameList = (want, got) =>
  want.length === got.length && want.every((w, i) => {
    const g = got[i];
    return g && Object.keys(w).every((k) => String(w[k]) === String(g[k]));
  });
const fmt = (list) => list.map((x) => JSON.stringify(x)).join(' | ').slice(0, 160);

export const D01 = (expected, evidence) => {
  const want = expected.below.map((b) => ({ item: b.item, qty: String(b.qty) }));
  const got = pairsOf(evidence, /RESULT\s+item=(\S+)\s+qty=(\d+)/g, (m) => ({ item: m[1], qty: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? `all ${want.length} below-threshold items in order` : `want [${fmt(want)}] got [${fmt(got)}]` };
};

export const D02 = (expected, evidence) => {
  const want = expected.changed.map((c) => ({ key: c.key, old: c.old, new: c.new }));
  const got = pairsOf(evidence, /RESULT\s+key=(\S+)\s+old=(\S+)\s+new=(\S+)/g, (m) => ({ key: m[1], old: m[2], new: m[3] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? `all ${want.length} changed keys in file order` : `want [${fmt(want)}] got [${fmt(got)}]` };
};

export const D03 = (expected, evidence) => {
  const want = expected.tally.map((t) => ({ domain: t.domain, count: String(t.count) }));
  const got = pairsOf(evidence, /RESULT\s+domain=(\S+)\s+count=(\d+)/g, (m) => ({ domain: m[1], count: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? `tally matches (${want.length} domains, sorted)` : `want [${fmt(want)}] got [${fmt(got)}]` };
};

export const D04 = (expected, evidence) => {
  const want = expected.shifts.map((s) => ({ shift: s.name, minutes: String(s.minutes) }));
  const got = pairsOf(evidence, /RESULT\s+shift=(\S+)\s+minutes=(\d+)/g, (m) => ({ shift: m[1], minutes: m[2] }));
  const ok = sameList(want, got);
  return { satisfied: ok, detail: ok ? `all ${want.length} shifts in file order` : `want [${fmt(want)}] got [${fmt(got)}]` };
};

export const GRADERS = { D01, D02, D03, D04 };
