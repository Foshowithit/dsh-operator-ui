// RC3.2 attempt wording (GPT work order, 2026-09-22).
//
// The three-attempt spine wording is a RELEASE CONTRACT, not prose style:
//
//   Attempt 1 · Failed            — original DSH observation first, then the
//                                   independently verified historical Archon
//                                   execution (failure text only from the
//                                   identification entry's failureSummary);
//   Attempt 2 · No workflow execution — dispatch accepted, menu presented;
//   Attempt 3 · SHIP              — run completed, objective satisfied.
//
// Evidence absent → the original observation plus an explicit attribution
// limitation. The categorical 'no execution —' fallthrough is banned: absence
// of evidence is never restated as evidence of absence.
//
// client.js is a self-contained ModuleLoader bundle (no ESM), so the wording
// region between the test-extraction banners is extracted and evaluated here
// — the SAME bytes the browser runs. The reconcile tests exercise the real
// identification path against the captured live fixture.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identifyHistoricalRun } from '../lib/reconcile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BEGIN = '// --- BEGIN attempt-wording (test-extracted region) ---';
const END = '// --- END attempt-wording (test-extracted region) ---';

async function loadWording() {
  const src = await readFile(resolve(HERE, '..', 'lib', 'client.js'), 'utf8');
  const from = src.indexOf(BEGIN);
  const to = src.indexOf(END);
  assert.ok(from !== -1 && to !== -1 && to > from, 'wording region banners present in lib/client.js');
  const region = src.slice(from + BEGIN.length, to);
  // goalVerdict is the only out-of-region dependency the wording region has;
  // the stub mirrors lib/client.js's own implementation for string verdicts.
  const goalVerdict = (g) => {
    if (!g) return 'PENDING';
    const v = g.verdict;
    if (typeof v === 'string') return v;
    if (v && typeof v.decision === 'string') return v.decision;
    return 'PENDING';
  };
  return new Function(
    'goalVerdict',
    region + '\nreturn { attemptOutcomeWord, attemptSpineLabel, originalObservationText, failurePhrase, identificationForAttempt, attemptBody };',
  )(goalVerdict);
}

const RUN_7245 = '7245beda-c754-4862-af56-ae2e72e11d15';
const RUN_6846 = '6846cd8a-993f-46ee-83c1-f3b87418b4b6';

// The live task-970ff68d envelope's three attempts, as recorded (original
// observation fields verbatim; no field invented).
const liveEnvelope = () => ({
  taskId: 'task-970ff68d',
  verdict: 'SHIP',
  failureCodes: [],
  attempts: [
    {
      attempt: 1,
      workflow: 'csv-running-total-v1',
      runId: null,
      status: null,
      failureCode: 'run-not-found',
      error: 'dispatch accepted but no run appeared',
      observation: null,
    },
    {
      attempt: 2,
      workflow: 'csv-running-total-v1',
      runId: null,
      status: null,
      failureCode: 'run-not-found',
      error: 'dispatch accepted but no run appeared',
      observation: { kind: 'prior-run-menu', sqliteRowId: 33758 },
    },
    {
      attempt: 3,
      workflow: 'csv-running-total-v1',
      runId: RUN_6846,
      status: 'completed',
      failureCode: [],
      observation: null,
    },
  ],
  reconciliation: [
    {
      kind: 'child-run-identified',
      runId: RUN_7245,
      statusObserved: 'failed',
      checkedAt: '2026-09-22T00:00:00.000Z',
      failureSummary: {
        text: 'bash: line 3: TASK: unbound variable',
        source: 'Archon run log jsonl exec_output stderr_tail (op4 live-execution receipt, 2026-09-21)',
        observedAt: '2026-09-21T00:30:54.599Z',
      },
      note: 'historical association identified a child run; the original observation (FAILED / run-not-found) is preserved verbatim above and unchanged',
    },
    { kind: 'child-run-association-verified', runId: RUN_6846, statusObserved: 'completed' },
  ],
});

test('RC3.2 the three-attempt spine renders GPT\'s exact labels and bodies', async () => {
  const w = await loadWording();
  const g = liveEnvelope();
  const [a1, a2, a3] = g.attempts;

  assert.equal(w.attemptSpineLabel(a1, g), 'Attempt 1 · Failed');
  assert.equal(
    w.attemptBody(a1, g),
    'Original DSH observation: run not found during discovery. Independently verified Archon execution: run `7245beda…` failed with an unbound Bash variable.',
  );

  assert.equal(w.attemptSpineLabel(a2, g), 'Attempt 2 · No workflow execution');
  assert.equal(
    w.attemptBody(a2, g),
    'Dispatch accepted; Archon presented the prior-failed-run decision menu.',
  );

  assert.equal(w.attemptSpineLabel(a3, g), 'Attempt 3 · SHIP');
  assert.equal(
    w.attemptBody(a3, g),
    'Run `6846cd8a…` completed; objective satisfied.',
  );
});

test('RC3.2 no verified identity → original observation + explicit attribution limitation, never categorical "no execution"', async () => {
  const w = await loadWording();
  const g = liveEnvelope();
  g.reconciliation = g.reconciliation.filter((e) => e.kind !== 'child-run-identified');
  const body1 = w.attemptBody(g.attempts[0], g);
  assert.ok(body1.startsWith('Original DSH observation: run not found during discovery.'), 'original observation kept verbatim');
  assert.ok(body1.includes('Attribution limitation:'), 'the limitation is explicit');
  assert.ok(body1.includes('no execution claim is made either way'), 'absence of evidence is not restated as evidence of absence');
  assert.ok(!body1.includes('no execution —'), 'the banned categorical fallthrough never renders');
  // Attempt 2 is unaffected: its menu observation is its own evidence.
  assert.equal(w.attemptBody(g.attempts[1], g), 'Dispatch accepted; Archon presented the prior-failed-run decision menu.');
});

test('RC3.2 failurePhrase: unbound classification, verbatim fallback, explicit unavailable', async () => {
  const w = await loadWording();
  assert.equal(w.failurePhrase({ text: 'bash: line 3: TASK: unbound variable' }), 'failed with an unbound Bash variable');
  assert.equal(w.failurePhrase({ text: "DAG workflow 'csv-running-total-v1' failed: node compute failed." }), 'failed: DAG workflow \'csv-running-total-v1\' failed: node compute failed.');
  assert.equal(w.failurePhrase(null), 'failed (failure detail unavailable in this installation)');
  assert.equal(w.failurePhrase({ text: '  ' }), 'failed (failure detail unavailable in this installation)');
});

test('RC3.2 identification failureSummary: caller-supplied verified evidence wins; else run-detail prose; else no field', async () => {
  const fixture = JSON.parse(await readFile(join(HERE, 'fixtures', 'op4-real-run-7245beda.json'), 'utf8'));
  const expectedMessage = 'task task-970ff68d: Process values.csv in order and report running total after each row';
  assert.equal(fixture.run.user_message, expectedMessage, 'the fixture carries the exact dispatched message');
  const mkTask = () => ({
    taskId: 'task-970ff68d',
    objective: 'Process values.csv in order and report running total after each row',
    attempts: [{ attempt: 1, workflow: 'csv-running-total-v1', runId: null, failureCode: 'run-not-found' }],
    conversation: fixture.associationFromPersistedEnvelope,
  });
  const opts = () => ({
    runs: [fixture.run],
    fetchDetail: async () => fixture.run,
    expectedMessage,
    checkedAt: '2026-09-22T00:00:00.000Z',
  });

  // Supplied verified run-log evidence carries its source into the entry.
  const supplied = await identifyHistoricalRun(mkTask(), {
    ...opts(),
    failureEvidence: {
      text: 'bash: line 3: TASK: unbound variable',
      source: 'Archon run log jsonl exec_output stderr_tail (op4 live-execution receipt, 2026-09-21)',
      observedAt: '2026-09-21T00:30:54.599Z',
    },
  });
  assert.equal(supplied.identity.state, 'identified');
  assert.equal(supplied.appended, true);
  assert.equal(supplied.task.reconciliation[0].kind, 'child-run-identified');
  assert.equal(supplied.task.reconciliation[0].runId, RUN_7245);
  assert.equal(supplied.task.reconciliation[0].evidence.every((e) => e.pass), true, 'all five linkage legs verify');
  assert.equal(supplied.task.reconciliation[0].failureSummary.text, 'bash: line 3: TASK: unbound variable');
  assert.equal(
    supplied.task.reconciliation[0].failureSummary.source,
    'Archon run log jsonl exec_output stderr_tail (op4 live-execution receipt, 2026-09-21)',
  );

  // Without supplied evidence the run detail's own error field is used, labeled as such.
  const derived = await identifyHistoricalRun(mkTask(), opts());
  assert.equal(derived.identity.state, 'identified');
  assert.equal(derived.task.reconciliation[0].failureSummary.source, 'run detail metadata.error');
  assert.match(derived.task.reconciliation[0].failureSummary.text, /node compute failed/);

  // No prose anywhere → no failureSummary field at all (the UI then renders
  // its attribution-limitation phrase — never invented prose).
  const bareRun = { ...fixture.run, metadata: { ...fixture.run.metadata, error: undefined } };
  delete bareRun.metadata.error;
  const bare = await identifyHistoricalRun(mkTask(), {
    runs: [bareRun],
    fetchDetail: async () => bareRun,
    expectedMessage,
    checkedAt: '2026-09-22T00:00:00.000Z',
  });
  assert.equal(bare.identity.state, 'identified');
  assert.equal('failureSummary' in bare.task.reconciliation[0], false);
});
