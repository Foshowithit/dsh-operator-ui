#!/usr/bin/env node
// eval/lib/test-scored-controls.mjs — adversarial controls for the Eval v2
// scored suite: for EVERY fixture (12 families × 11 = 132), golden evidence
// built from expected.json must PASS, a subtly-wrong mutation must FAIL, and
// empty evidence must FAIL. Same discipline as the v2 ruler.

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRADERS_E } from './graders-e.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUITE = join(root, 'eval', 'scored-suite');

const GOLDEN = {
  E01: (e) => ({ evidence: e.diffs.map((d) => `RESULT item=${d.item} system=${d.system} physical=${d.physical}`).join('\n') }),
  E02: (e) => ({ evidence: e.pairs.map((p) => `RESULT overlap=${p.first},${p.second}`).join('\n') }),
  E03: (e) => ({ evidence: e.columns.map((c) => `RESULT column=${c.column} sum=${c.sum}`).join('\n') }),
  E04: (e) => ({ evidence: e.hours.map((h) => `RESULT hour=${h.hour} count=${h.count}`).join('\n') }),
  E05: (e) => ({ evidence: e.shares.map((s) => `RESULT category=${s.category} share=${s.share}%`).join('\n') }),
  E06: (e) => ({ evidence: `RESULT longest=${e.longest} kind=${e.kind}` }),
  E07: (e) => ({ evidence: e.rows.map((r) => `RESULT code=${r.code} label=${r.label}`).join('\n') }),
  E08: (e) => ({ evidence: e.lines.map((l) => `RESULT line=${l.line} text=${l.text}`).join('\n') }),
  E09: (e) => ({ evidence: e.rows.map((r) => `RESULT name=${r.name} score=${r.score}`).join('\n') }),
  E10: (e) => ({ evidence: e.violations.map((v) => `RESULT line=${v.line} length=${v.length}`).join('\n') }),
  E11: (e) => ({ evidence: `RESULT within=${e.within}\nRESULT closest=${e.closest}` }),
  E12: (e) => ({ evidence: e.rows.map((r) => `RESULT row=${r.row} total=${r.total}`).join('\n') }),
};

const SUBTLE = {
  E01: (e) => { const d = e.diffs.map((x) => ({ ...x })); if (d.length) d[0].physical = String(Number(d[0].physical) + 1); return { evidence: d.map((x) => `RESULT item=${x.item} system=${x.system} physical=${x.physical}`).join('\n') }; },
  E02: (e) => { const p = e.pairs.map((x) => ({ ...x })); if (p.length) p[p.length - 1].second = p[p.length - 1].first; return { evidence: p.map((x) => `RESULT overlap=${x.first},${x.second}`).join('\n') }; },
  E03: (e) => { const c = e.columns.map((x) => ({ ...x })); if (c.length) c[0].sum = String(Number(c[0].sum) + 1); return { evidence: c.map((x) => `RESULT column=${x.column} sum=${x.sum}`).join('\n') }; },
  E04: (e) => { const h = e.hours.map((x) => ({ ...x })); if (h.length) h[0].count = String(Number(h[0].count) + 1); return { evidence: h.map((x) => `RESULT hour=${x.hour} count=${x.count}`).join('\n') }; },
  E05: (e) => { const s = e.shares.map((x) => ({ ...x })); if (s.length) s[0].share = (Number(s[0].share) + 0.1).toFixed(1); return { evidence: s.map((x) => `RESULT category=${x.category} share=${x.share}%`).join('\n') }; },
  E06: (e) => ({ evidence: `RESULT longest=${Number(e.longest) + 1} kind=${e.kind}` }),
  E07: (e) => { const r = e.rows.map((x) => ({ ...x })); const k = r.findIndex((x) => x.label !== 'UNKNOWN'); if (k >= 0) r[k].label = 'gold'; else if (r.length) r[0].label = 'UNKNOWN'; return { evidence: r.map((x) => `RESULT code=${x.code} label=${x.label}`).join('\n') }; },
  E08: (e) => { const l = e.lines.map((x) => ({ ...x })); if (l.length) l[l.length - 1].text = l[l.length - 1].text + ' x'; return { evidence: l.map((x) => `RESULT line=${x.line} text=${x.text}`).join('\n') }; },
  E09: (e) => { const r = e.rows.map((x) => ({ ...x })); if (r.length) r[r.length - 1].score = String(Number(r[r.length - 1].score) - 1); return { evidence: r.map((x) => `RESULT name=${x.name} score=${x.score}`).join('\n') }; },
  E10: (e) => { const v = e.violations.map((x) => ({ ...x })); const out = v.length ? v.slice(0, -1) : [{ line: '1', length: '999' }]; return { evidence: out.map((x) => `RESULT line=${x.line} length=${x.length}`).join('\n') }; },
  E11: (e) => ({ evidence: `RESULT within=${Number(e.within) + 1}\nRESULT closest=${e.closest}` }),
  E12: (e) => { const r = e.rows.map((x) => ({ ...x })); if (r.length) r[r.length - 1].total = String(Number(r[r.length - 1].total) + 1); return { evidence: r.map((x) => `RESULT row=${x.row} total=${x.total}`).join('\n') }; },
};

let pass = 0, fail = 0;
const failures = [];
const fams = (await readdir(SUITE, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
for (const fam of fams) {
  const code = fam.slice(0, 3);
  const grader = GRADERS_E[code];
  for (const kind of ['internal', 'scored']) {
    for (let k = 1; k <= (kind === 'internal' ? 5 : 6); k++) {
      const id = `${fam}/${kind}-${k}`;
      let expected;
      try { expected = JSON.parse(await readFile(join(SUITE, fam, `${kind}-${k}`, 'expected.json'), 'utf8')); } catch { failures.push(`${id}: no expected.json`); fail++; continue; }
      try {
        const g = GOLDEN[code](expected);
        const gp = grader(expected, g.evidence, g.wsFiles);
        if (gp.satisfied) pass++; else { fail++; failures.push(`${id} GOLDEN REJECTED — ${gp.detail}`); }
        const s = SUBTLE[code](expected);
        const sp = grader(expected, s.evidence, s.wsFiles);
        if (!sp.satisfied) pass++; else { fail++; failures.push(`${id} SUBTLE WRONG ACCEPTED — GRADER DEFECT`); }
        const ep = grader(expected, '', []);
        if (!ep.satisfied) pass++; else { fail++; failures.push(`${id} EMPTY EVIDENCE ACCEPTED — GRADER DEFECT`); }
      } catch (e) { fail++; failures.push(`${id}: control crashed — ${e.message}`); }
    }
  }
}
console.log(`scored-suite controls: ${pass}/${pass + fail} PASS across ${fams.length} families`);
if (fail) { console.log('FAILURES:'); for (const f of failures.slice(0, 30)) console.log('  ' + f); process.exit(1); }
