#!/usr/bin/env node
// eval/lib/test-grader-controls.mjs — adversarial control suite for the
// canonical v2 ruler (GPT requirement): "for every family, deliberately
// feed at least one subtly wrong result and prove the grader rejects it.
// A grader that only demonstrates it accepts correct output isn't enough."
//
// For EVERY fixture in both suites (corpus F01–F10 × 5 encounters,
// devsuite D01–D04 × 3) the golden evidence built from its expected.json
// must PASS, and each mutation must FAIL:
//   subtle  — one value off by a little / one line altered / order swapped
//   corrupt — empty evidence
// Any accept of a mutated control is a FAILING TEST (grader defect).

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRADERS_V2 } from './graders-v2.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- golden evidence builders (expected.json → the canonical output) ----
const GOLDEN = {
  F01: (e) => ({ evidence: `Processing complete.\nTOTAL Lines: ${e.total.lines} Words: ${e.total.words} Bytes: ${e.total.bytes}` }),
  F02: (e) => ({ evidence: Object.entries(e.byType).map(([x, n]) => `RESULT ext=${x} count=${n}`).join('\n') + `\nRESULT total=${e.total}\nRESULT todo=${e.todoCount}` }),
  F03: (e) => ({ evidence: Object.entries(e.fields).map(([h, p]) => `RESULT host=${h} port=${p}`).join('\n') }),
  F04: (e) => ({ wsFiles: [{ path: e.file, bytes: e.sorted.join('\n').length, body: e.sorted.join('\n') + '\n' }], evidence: `sorted ${e.sorted.length} lines` }),
  F05: (e) => ({ evidence: e.verdict === 'FAIL' ? `gate verdict: FAIL — missing files: ${e.missing.join(', ')}` : `gate verdict: PASS (all files present)` }),
  F06: (e) => ({ evidence: `RESULT version=${e.version}\n` + e.entries.map((x) => `RESULT entry=${x}`).join('\n') }),
  F07: (e) => ({ evidence: e.duplicates.map((d) => `RESULT email=${d.email} count=${d.count}`).join('\n') }),
  F08: (e) => ({ wsFiles: [{ path: 'stock.json', bytes: JSON.stringify(e.json).length, body: JSON.stringify(e.json) }], evidence: 'converted 1 file' }),
  F09: (e) => ({ evidence: `counts — INFO: ${e.counts.INFO}, WARN: ${e.counts.WARN}, ERROR: ${e.counts.ERROR}` }),
  F10: (e) => (e.mismatches || []).length
    ? { evidence: e.mismatches.map((m) => `RESULT package=${m.name} declared=${m.declared} locked=${m.locked}`).join('\n') }
    : { evidence: 'RESULT mismatches=0' },
  D01: (e) => ({ evidence: e.below.map((b) => `RESULT item=${b.item} qty=${b.qty}`).join('\n') }),
  D02: (e) => ({ evidence: e.changed.map((c) => `RESULT key=${c.key} old=${c.old} new=${c.new}`).join('\n') }),
  D03: (e) => ({ evidence: e.tally.map((t) => `RESULT domain=${t.domain} count=${t.count}`).join('\n') }),
  D04: (e) => ({ evidence: e.shifts.map((s) => `RESULT shift=${s.name} minutes=${s.minutes}`).join('\n') }),

  D05: (e) => ({ evidence: e.lines.map((l) => `RESULT order=${l.order} item=${l.item} total=${l.total}`).join('\n') }),
  D06: (e) => ({ evidence: e.sections.map((x) => `RESULT section=${x.section} items=${x.items}`).join('\n') }),
  D07: (e) => ({ evidence: `RESULT final=${e.final}\nRESULT min=${e.min}` }),
  D08: (e) => ({ evidence: e.statuses.map((x) => `RESULT file=${x.file} status=${x.status}`).join('\n') }),
  D09: (e) => ({ evidence: e.days.map((x) => `RESULT date=${x.date} count=${x.count}`).join('\n') }),
  D10: (e) => ({ wsFiles: e.files.map((f) => ({ path: f.file, bytes: Number(f.size), body: 'x' })), evidence: e.files.map((f) => `RESULT file=${f.file} size=${f.size}`).join('\n') }),
  D11: (e) => ({ evidence: e.contacts.map((x) => `RESULT name=${x.name} phone=${x.phone}`).join('\n') }),
  D12: (e) => ({ evidence: e.counts.map((x) => `RESULT component=${x.component} deps=${x.deps}`).join('\n') + `\nRESULT heaviest=${e.heaviest}` }),
  D13: (e) => ({ evidence: e.applied.map((x) => `RESULT key=${x.key} from=${x.from} to=${x.to}`).join('\n') }),
  D14: (e) => ({ evidence: e.totals.map((x) => `RESULT region=${x.region} total=${x.total}`).join('\n') }),
  D15: (e) => ({ evidence: e.rows.map((x) => `RESULT name=${x.name} version=${x.version} status=${x.status}`).join('\n') }),
  D16: (e) => ({ evidence: e.buckets.map((x) => `RESULT bucket=${x.bucket} count=${x.count}`).join('\n') }),
};

// ---- subtle-wrong mutators: each must flip the verdict ----
const SUBTLE = {
  F01: { evidence: (e) => `TOTAL Lines: ${e.total.lines} Words: ${e.total.words} Bytes: ${e.total.bytes + 1}` },
  F02: { evidence: (e) => { const k = Object.keys(e.byType)[0]; const parts = Object.entries(e.byType).map(([x, n]) => `RESULT ext=${x} count=${x === k ? n + 1 : n}`); return parts.join('\n') + `\nRESULT total=${e.total}\nRESULT todo=${e.todoCount}`; } },
  F03: { evidence: (e) => { const es = Object.entries(e.fields); const last = es[es.length - 1]; return es.slice(0, -1).map(([h, p]) => `RESULT host=${h} port=${p}`).concat([`RESULT host=${last[0]} port=${Number(last[1]) + 1}`]).join('\n'); } },
  F04: { wsFiles: (e) => [{ path: e.file, bytes: 1, body: e.sorted.slice(0, -1).concat([e.sorted[e.sorted.length - 1] + ' ']).join('\n') + '\n' }] },
  F05: { evidence: (e) => e.verdict === 'FAIL' ? 'gate verdict: PASS (all files present)' : `gate verdict: FAIL — missing files: ${e.missing.length ? e.missing.join(', ') : 'none.txt'}` },
  F06: { evidence: (e) => `RESULT version=${e.version}\n` + e.entries.map((x, i) => `RESULT entry=${i === Math.floor(e.entries.length / 2) ? x.replace(/\w$/, (c) => c === 'a' ? 'b' : 'a') : x}`).join('\n') },
  F07: { evidence: (e) => { const ds = e.duplicates.map((d) => ({ ...d })); ds[0].count += 1; return ds.map((d) => `RESULT email=${d.email} count=${d.count}`).join('\n'); } },
  F08: { wsFiles: (e) => { const arr = JSON.parse(JSON.stringify(e.json)); if (Array.isArray(arr) && arr.length) arr[0].qty = (arr[0].qty ?? 0) + 1; else arr.__extra = 1; return [{ path: 'stock.json', bytes: 1, body: JSON.stringify(arr) }]; } },
  F09: { evidence: (e) => `counts — INFO: ${e.counts.INFO + 1}, WARN: ${e.counts.WARN}, ERROR: ${e.counts.ERROR}` },
  F10: { evidence: (e) => (e.mismatches || []).length ? `RESULT package=${e.mismatches[0].name} declared=${e.mismatches[0].declared} locked=${e.mismatches[0].locked}.9` : 'RESULT package=phantom declared=1.0.0 locked=1.0.1' },
  D01: { evidence: (e) => { const bs = e.below.map((b) => ({ ...b })); bs[0].qty += 1; return bs.map((b) => `RESULT item=${b.item} qty=${b.qty}`).join('\n'); } },
  D02: { evidence: (e) => { const cs = e.changed.map((c) => ({ ...c })); cs[cs.length - 1].new = cs[cs.length - 1].new + 'x'; return cs.map((c) => `RESULT key=${c.key} old=${c.old} new=${c.new}`).join('\n'); } },
  D03: { evidence: (e) => { const ts = e.tally.map((t) => ({ ...t })); ts[0].count += 1; return ts.map((t) => `RESULT domain=${t.domain} count=${t.count}`).join('\n'); } },
  D04: { evidence: (e) => { const ss = e.shifts.map((s) => ({ ...s })); ss[0].minutes += 1; return ss.map((s) => `RESULT shift=${s.name} minutes=${s.minutes}`).join('\n'); } },

  D05: { evidence: (e) => { const ls = e.lines.map((l) => ({ ...l })); ls[ls.length - 1].total = String(Number(ls[ls.length - 1].total) + 1); return ls.map((l) => `RESULT order=${l.order} item=${l.item} total=${l.total}`).join('\n'); } },
  D06: { evidence: (e) => { const xs = e.sections.map((x) => ({ ...x })); xs[0].items = String(Number(xs[0].items) + 1); return xs.map((x) => `RESULT section=${x.section} items=${x.items}`).join('\n'); } },
  D07: { evidence: (e) => `RESULT final=${Number(e.final) + 1}\nRESULT min=${e.min}` },
  D08: { evidence: (e) => { const xs = e.statuses.map((x) => ({ ...x })); const bad = xs.find((x) => x.status === 'ok'); if (bad) bad.status = 'mismatch'; else xs[0].status = 'ok'; return xs.map((x) => `RESULT file=${x.file} status=${x.status}`).join('\n'); } },
  D09: { evidence: (e) => { const xs = e.days.map((x) => ({ ...x })); xs[0].count = String(Number(xs[0].count) + 1); return xs.map((x) => `RESULT date=${x.date} count=${x.count}`).join('\n'); } },
  D10: { evidence: (e) => e.files.map((f) => `RESULT file=${f.file} size=${Number(f.size) + 1}`).join('\n') },
  D11: { evidence: (e) => { const xs = e.contacts.map((x) => ({ ...x })); xs[0].phone = xs[0].phone.slice(0, 9); return xs.map((x) => `RESULT name=${x.name} phone=${x.phone}`).join('\n'); } },
  D12: { evidence: (e) => { const xs = e.counts.map((x) => ({ ...x })); xs[0].deps = String(Number(xs[0].deps) + 1); return xs.map((x) => `RESULT component=${x.component} deps=${x.deps}`).join('\n') + `\nRESULT heaviest=${e.heaviest}`; } },
  D13: { evidence: (e) => { const xs = e.applied.map((x) => ({ ...x })); xs[0].to = xs[0].to + 'x'; return xs.map((x) => `RESULT key=${x.key} from=${x.from} to=${x.to}`).join('\n'); } },
  D14: { evidence: (e) => { const xs = e.totals.map((x) => ({ ...x })); xs[0].total = String(Number(xs[0].total) + 1); return xs.map((x) => `RESULT region=${x.region} total=${x.total}`).join('\n'); } },
  D15: { evidence: (e) => { const xs = e.rows.map((x) => ({ ...x })); xs[0].status = xs[0].status === 'stale' ? 'current' : 'stale'; return xs.map((x) => `RESULT name=${x.name} version=${x.version} status=${x.status}`).join('\n'); } },
  D16: { evidence: (e) => { const xs = e.buckets.map((x) => ({ ...x })); xs[0].count = String(Number(xs[0].count) + 1); return xs.map((x) => `RESULT bucket=${x.bucket} count=${x.count}`).join('\n'); } },
};

async function fixtures() {
  const out = [];
  const corpusDir = join(root, 'eval', 'corpus');
  for (const fam of (await readdir(corpusDir)).sort()) {
    for (const enc of (await readdir(join(corpusDir, fam))).sort()) {
      const dir = join(corpusDir, fam, enc);
      try {
        out.push({ family: fam.slice(0, 3), id: `${fam}/${enc}`, expected: JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8')) });
      } catch { /* non-fixture entry */ }
    }
  }
  for (const suite of ['devsuite', 'devsuite-v2', 'devsuite-v3', 'devsuite-v4', 'devsuite-v5']) {
    const base = join(root, 'eval', suite);
    for (const fam of (await readdir(base)).sort()) {
      for (const enc of (await readdir(join(base, fam))).sort()) {
        const dir = join(base, fam, enc);
        try {
          out.push({ family: fam.slice(0, 3), id: `${suite}/${fam}/${enc}`, expected: JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8')) });
        } catch { /* non-fixture entry */ }
      }
    }
  }
  return out;
}

const all = await fixtures();
let pass = 0, fail = 0;
const failures = [];

for (const f of all) {
  const grader = GRADERS_V2[f.family];
  if (!grader) { fail++; failures.push(`${f.id}: NO GRADER`); continue; }
  const label = (verdict) => `${f.id} ${verdict}`;
  try {
    const golden = GOLDEN[f.family](f.expected);
    const gp = await grader(f.expected, golden.evidence, golden.wsFiles);
    if (gp.satisfied) pass++; else { fail++; failures.push(label('GOLDEN REJECTED') + ' — ' + gp.detail); }

    const subtleSpec = SUBTLE[f.family];
    const subtle = {
      evidence: subtleSpec.evidence ? subtleSpec.evidence(f.expected) : undefined,
      wsFiles: subtleSpec.wsFiles ? subtleSpec.wsFiles(f.expected) : undefined,
    };
    const sp = await grader(f.expected, subtle.evidence, subtle.wsFiles);
    if (!sp.satisfied) pass++; else { fail++; failures.push(label('SUBTLE WRONG ACCEPTED') + ' — GRADER DEFECT'); }

    const cp = await grader(f.expected, '', []);
    if (!cp.satisfied) pass++; else { fail++; failures.push(label('EMPTY EVIDENCE ACCEPTED') + ' — GRADER DEFECT'); }
  } catch (e) {
    fail++;
    failures.push(`${f.id}: control crashed — ${e.message}`);
  }
}

console.log(`grader controls: ${pass}/${pass + fail} PASS across ${all.length} fixtures × 3 controls`);
if (fail) {
  console.log('FAILURES:');
  for (const x of failures) console.log('  ' + x);
  process.exit(1);
}
