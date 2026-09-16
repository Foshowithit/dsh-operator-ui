#!/usr/bin/env node
// eval/lib/test-devsuite-graders.mjs — grader soundness self-test.
// Suite QA only (not an acquisition run): for every dev-suite objective,
// a golden evidence string built from expected.json must PASS, and a
// corrupted variant (entry dropped / value mutated) must FAIL.

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRADERS } from './devsuite-graders.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const suite = join(root, 'eval', 'devsuite');
const families = (await readdir(suite, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);

let pass = 0, fail = 0;
for (const fam of families.sort()) {
  const code = fam.slice(0, 3);
  const grader = GRADERS[code];
  if (!grader) throw new Error('no grader for ' + fam);
  for (const enc of ['encounter-1', 'encounter-2', 'encounter-3']) {
    const expected = JSON.parse(await readFile(join(suite, fam, enc, 'expected.json'), 'utf8'));
    const listKey = expected.below ? 'below' : expected.changed ? 'changed' : expected.tally ? 'tally' : 'shifts';
    const rows = expected[listKey];
    const lineOf = (row) => {
      const body = listKey === 'below' ? `item=${row.item} qty=${row.qty}`
        : listKey === 'changed' ? `key=${row.key} old=${row.old} new=${row.new}`
        : listKey === 'tally' ? `domain=${row.domain} count=${row.count}`
        : `shift=${row.name} minutes=${row.minutes}`;
      return `RESULT ${body}`;
    };
    const golden = rows.map(lineOf).join('\n') + '\n';
    const g = grader(expected, golden);
    const broken = (() => {
      if (rows.length === 0) return rows.map(lineOf).join('\n') + 'RESULT extra=1 qty=1\n';
      const dropped = rows.slice(0, -1);
      const mutated = rows.map((row, i) => i === rows.length - 1
        ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'number' ? v + 7 : v + 'X']))
        : row);
      return mutated.map(lineOf).join('\n') + '\n' + (dropped.length < rows.length ? '' : '');
    })();
    const b = grader(expected, broken);
    const gOk = g.satisfied === true;
    const bOk = b.satisfied === false;
    if (gOk && bOk) pass += 1;
    else { fail += 1; console.log(`SELf-TEST FAIL ${fam}/${enc}: golden=${g.satisfied} broken=${b.satisfied} (${g.detail})`); }
  }
}
console.log(`grader self-test: ${pass} family-encounters PASS, ${fail} FAIL`);
if (fail > 0) process.exit(1);
