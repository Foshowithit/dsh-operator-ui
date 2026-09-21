// P1 — evidence contract v2: the objective-echo hazard, closed at the product
// path.
//
// The v1 composition judged `[detailText, ...outputs]`, and `detailText` is the
// whole run-detail body including `run.user_message` — the dispatched objective
// echoed back verbatim. A token-presence evaluator could therefore be satisfied
// by the REQUEST repeating itself rather than by execution. The control leg
// below reproduces that hazard on the raw v1 composition; every later leg shows
// the v2 filter removes the echo, keeps run-level execution facts, and still
// admits genuine execution evidence. The last two legs pin the parts that a
// unit test cannot exercise end to end: stored v1 records are read verbatim
// (never rewritten), and the goal verify path actually composes through
// `composeEvidence` (a live dispatch would be required to run that path for
// real, so it is pinned at the source).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { evaluateObjective, excludeRequestEcho, EVIDENCE_CONTRACT_VERSION } from '../lib/task-truth.js';
import { composeEvidence, collectOutputs, validateCapability } from '../lib/goal.js';

// The declared csv-running-total evaluator (same tokens as
// test/objective-eval.test.mjs — the P-5 declared evaluator).
const REQUIRED = [
  'row=1 total=23',
  'row=2 total=28',
  'row=3 total=69',
  'row=4 total=81',
  'row=5 total=88',
  'row=6 total=118',
];
const EVALUATOR = { kind: 'output-lines', required: REQUIRED };

const OBJECTIVE = 'task task-970ff68d: Process values.csv in order and report running total after each row';
// The hazard case: a user who names the expected output lines in the ask. The
// run echoes the ask; a token evaluator over the raw body sees its own request.
const ECHO_OBJECTIVE = OBJECTIVE + ' (expected lines: ' + REQUIRED.join(', ') + ')';

const sha256 = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

// A run-detail body shaped like the one pollRun returns: run-level fields plus
// the request echo, and node_output events when the workflow emitted any.
function detailBody({ userMessage = OBJECTIVE, events = [], status = 'completed' } = {}) {
  return {
    run: {
      id: 'run-echo-1',
      status,
      workflow_name: 'csv-running-total-v1',
      conversation_id: 'rcos-task-970ff68d',
      user_message: userMessage,
    },
    events,
  };
}

const evaluate = (evidenceText) => evaluateObjective({
  executionCompleted: true,
  capabilityValidation: { pass: true },
  evaluator: EVALUATOR,
  evidenceText,
});

test('control — the v1 composition is satisfied by the echoed request alone (hazard reproduced)', () => {
  const body = detailBody({ userMessage: ECHO_OBJECTIVE });
  const v1Text = [JSON.stringify(body), ...[]].join('\n');
  const res = evaluate(v1Text);
  assert.equal(res.status, 'SATISFIED', 'v1 judges the request echo as if it were execution');
  assert.ok(res.checks.every((c) => c.pass === true));
});

test('fix — composeEvidence strips the echo, so the same body no longer satisfies', () => {
  const body = detailBody({ userMessage: ECHO_OBJECTIVE });
  const raw = JSON.stringify(body);
  const composed = composeEvidence({ detailText: raw, outputs: [] });

  assert.equal(composed.contract, EVIDENCE_CONTRACT_VERSION);
  assert.equal(composed.contract, 2);
  assert.ok(!composed.evidenceText.includes('user_message'), 'echo field must be gone');
  assert.ok(!composed.evidenceText.includes(REQUIRED[0]), 'echoed expected lines must not survive');

  // The filter is not a blanket erasure: run-level execution facts survive.
  assert.ok(composed.evidenceText.includes('run-echo-1'));
  assert.ok(composed.evidenceText.includes('completed'));
  assert.ok(composed.evidenceText.includes('csv-running-total-v1'));

  // The hash covers what was actually judged — and it is deliberately not the
  // v1 hash of the raw body.
  assert.equal(composed.evidenceSha256, sha256(excludeRequestEcho(raw)));
  assert.notEqual(composed.evidenceSha256, sha256(raw));

  const res = evaluate(composed.evidenceText);
  assert.equal(res.status, 'NOT_SATISFIED');
  assert.ok(res.checks.every((c) => c.pass === false));
});

test('declared-expectation fails closed against the echo too', () => {
  const body = detailBody({ userMessage: ECHO_OBJECTIVE });
  const composed = composeEvidence({ detailText: JSON.stringify(body), outputs: [] });
  const v = validateCapability({
    runStatus: 'completed',
    expect: { terminalStatus: 'completed', expectOutput: REQUIRED[0] },
    evidenceText: composed.evidenceText,
  });
  assert.equal(v.checks.find((c) => c.id === 'terminal-status').pass, true);
  assert.equal(v.checks.find((c) => c.id === 'declared-expectation').pass, false);
  assert.equal(v.pass, false);
});

test('genuine execution evidence still satisfies after the filter (fix is not a blanket refusal)', () => {
  const events = [{ id: 'ev-1', event_type: 'node_output', step_name: 'emit', data: { output: REQUIRED.join('\n') } }];
  const body = detailBody({ userMessage: OBJECTIVE, events });
  const outputs = collectOutputs(body.events).map((o) => o.node + ': ' + o.output);
  const composed = composeEvidence({ detailText: JSON.stringify(body), outputs });

  const res = evaluate(composed.evidenceText);
  assert.equal(res.status, 'SATISFIED');
  assert.equal(res.reason, 'all required evidence lines are present');

  const v = validateCapability({
    runStatus: 'completed',
    expect: { terminalStatus: 'completed', expectOutput: REQUIRED[0] },
    evidenceText: composed.evidenceText,
  });
  assert.equal(v.pass, true);
});

test('grounding — on the real captured run, exactly the request echo is removed and nothing else', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/op4-real-run-7245beda.json', import.meta.url), 'utf8'));
  const msg = fixture.run.user_message;

  // pollRun accepts either body shape the run endpoint returns — the wrapper
  // `{ run, events }` or the bare run object — and hashes whatever came back.
  // The fixture's `associationFromPersistedEnvelope` is a capture annotation
  // (it names itself as coming from the persisted envelope), not part of the
  // polled body, so it is deliberately not in the raw text here.
  const shapes = [
    ['wrapped', JSON.stringify({ run: fixture.run, events: [] })],
    ['bare', JSON.stringify(fixture.run)],
  ];
  for (const [label, raw] of shapes) {
    const filtered = excludeRequestEcho(raw);
    assert.ok(!filtered.includes(msg), label + ': the real dispatched message must not survive');
    const before = JSON.parse(raw);
    const after = JSON.parse(filtered);
    delete (before.run || before).user_message;
    assert.deepEqual(after, before, label + ': every field except the request echo must be byte-identical');
    const afterRun = after.run || after;
    assert.equal(afterRun.status, fixture.run.status, label + ': run status is execution evidence and is kept');
    assert.equal(afterRun.workflow_name, fixture.run.workflow_name);
    assert.equal(afterRun.id, fixture.run.id);
  }
});

test('a v1-shaped stored evidence bundle (no contract field) round-trips verbatim — never rewritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opui-evc-'));
  process.env.DSH_HOME = dir;
  try {
    const v1Task = {
      taskId: 'task-0000beef',
      objective: OBJECTIVE,
      status: 'closed',
      sealedBy: 'goal-runner-m1',
      verdict: 'SHIP',
      // v1 record: no `contract` field. This is what a historical receipt
      // looks like; nothing may recompute or rewrite it.
      evidence: { events: 1, outputs: ['emit: row=1 total=23'], evidenceSha256: 'sha256:' + 'a'.repeat(64) },
    };
    const bust = Date.now() + '-' + Math.random().toString(36).slice(2);
    const modA = await import('../lib/tasks.js?bust=' + bust + '-a');
    await modA.upsertTask(v1Task);

    const modB = await import('../lib/tasks.js?bust=' + bust + '-b');
    const read = await modB.getTask('task-0000beef');
    assert.deepEqual(read.evidence, v1Task.evidence, 'historical evidence must survive a restart untouched');
    assert.equal(Object.hasOwn(read.evidence, 'contract'), false, 'no contract field may be added to a v1 record');
  } finally {
    delete process.env.DSH_HOME;
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-JSON detail is passed through untouched (no silent evidence loss)', () => {
  assert.equal(excludeRequestEcho('not json'), 'not json');
  assert.equal(excludeRequestEcho(''), '');
  assert.equal(excludeRequestEcho(null), '');
  assert.equal(excludeRequestEcho('[1,2]'), '[1,2]');

  const nested = JSON.stringify({
    run: { id: 'r1' },
    events: [{ id: 'e1', data: { user_message: 'echo', output: 'kept' } }],
  });
  const out = JSON.parse(excludeRequestEcho(nested));
  assert.equal(out.events[0].data.user_message, undefined);
  assert.equal(out.events[0].data.output, 'kept', 'node output data is execution evidence and is kept');
});

test('the goal verify path composes through composeEvidence (wiring tripwire)', async () => {
  const src = await readFile(new URL('../lib/goal.js', import.meta.url), 'utf8');
  assert.ok(
    src.includes('composeEvidence({ detailText: evidence.detailText, outputs: attempt.outputs })'),
    'the verify path must compose evidence through composeEvidence',
  );
  assert.ok(src.includes('contract: composed.contract'), 'goal.evidence must record the contract version');
  assert.ok(!/const evidenceText = \[evidence\.detailText/.test(src), 'the raw v1 composition must not return');
});
