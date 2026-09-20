import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateObjective } from '../lib/task-truth.js';

// csv-running-total objective (vertical-slice spec §5.5 / P-5 declared evaluator).
const REQUIRED = [
  'row=1 total=23',
  'row=2 total=28',
  'row=3 total=69',
  'row=4 total=81',
  'row=5 total=88',
  'row=6 total=118',
];
const EVALUATOR = { kind: 'output-lines', required: REQUIRED };

const evaluate = (evidenceText) => evaluateObjective({
  executionCompleted: true,
  capabilityValidation: { pass: true },
  evaluator: EVALUATOR,
  evidenceText,
});

test('objective-echo evidence without the required lines is NOT_SATISFIED (T2a)', () => {
  const echo = evaluate('Read values.csv and print the running total for every row. Each line should state the row index and the accumulated total.');
  assert.equal(echo.status, 'NOT_SATISFIED');
  assert.equal(echo.pass, false);
  assert.equal(echo.checks.length, REQUIRED.length);
  assert.ok(echo.checks.every((c) => c.pass === false));
});

test('token boundaries reject near-miss continuations on either side (T2b)', () => {
  const suffix = evaluate(REQUIRED.slice(0, -1).join('\n') + '\nRESULT row=6 total=1180');
  assert.equal(suffix.status, 'NOT_SATISFIED');
  assert.equal(suffix.checks.at(-1).pass, false);

  const prefix = evaluate(REQUIRED.slice(0, -1).join('\n') + '\nxrow=6 total=118');
  assert.equal(prefix.status, 'NOT_SATISFIED');
  assert.equal(prefix.checks.at(-1).pass, false);
});

test('non-word trailing characters do not defeat a real evidence line', () => {
  const punctuated = evaluate(REQUIRED.slice(0, -1).join('\n') + '\nrow=6 total=118.');
  assert.equal(punctuated.status, 'SATISFIED');
  const annotated = evaluate(REQUIRED.slice(0, -1).join('\n') + '\nrow=6 total=118 (final)');
  assert.equal(annotated.status, 'SATISFIED');
});

test('a clean run log with all six lines in noise satisfies the objective', () => {
  const log = [
    '$ python3 running_total.py values.csv',
    ...REQUIRED,
    'done',
  ].join('\n');
  const good = evaluate(log);
  assert.equal(good.status, 'SATISFIED');
  assert.equal(good.reason, 'all required evidence lines are present');
  assert.ok(good.checks.every((c) => c.pass === true));
});

test('lib module graph loads as a whole (R-5 export leg pinned in test lane)', async () => {
  const mod = await import('../lib/index.js');
  assert.equal(typeof mod, 'object');
});
