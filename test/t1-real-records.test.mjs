// OP-4R Phase A finish: T1 run attribution replayed against Archon's ACTUAL
// parent-child execution record — not a mock shape.
//
// The fixture is the real run-detail response (read-only GET) of run
// 7245beda-c754-4862-af56-ae2e72e11d15, the ONE authorized live dispatch of
// OP-4 (failed; run untouched and preserved). The association block is copied
// from the persisted DSH task envelope (tasks.json). GPT work order: "Complete
// and test run attribution using Archon's actual parent-child execution
// records. Preserve the original failed attempt and require unambiguous
// association with a specific dispatch."
//
// Every negative leg below mutates exactly one field of the REAL record, so
// each of the five linkage legs is proven to bite on the live shape — a leg
// that could never fail would make the conjunction vacuous.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runWorkflowName,
  directExact,
  verifyParentLinkage,
  adoptionRecord,
} from '../lib/goal.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'op4-real-run-7245beda.json'), 'utf8'),
);
const run = fixture.run;
const a = fixture.associationFromPersistedEnvelope;

const WF = a.workflowName;
const MSG = a.dispatchedMessage;

test('fixture integrity: the record is the real failed run, unmutated', () => {
  assert.equal(run.id, '7245beda-c754-4862-af56-ae2e72e11d15');
  assert.equal(run.status, 'failed');
  // The live API carries both parent namespaces — the field names T1 verifies
  // were confirmed against this record, not assumed from the vendored subset.
  assert.equal(run.parent_conversation_id, a.dbId);
  assert.equal(run.parent_platform_id, a.archonConversationId);
  assert.equal(run.codebase_id, a.expectedCodebaseId);
  assert.equal(run.user_message, MSG);
  assert.equal(runWorkflowName(run), WF);
});

test('real record: the original S2-R direct-exact rule still misses (the fork gap)', () => {
  // direct-exact compares run.conversation_id to the bound PLATFORM id; the
  // forked child carries its own db id. This is the observed OP-4 miss and it
  // must stay a miss — parent-linked is the mode that adopts this shape.
  assert.equal(directExact(run, a.archonConversationId, WF), false);
});

test('real record: parent-linked adoption verifies on all five legs', () => {
  const check = verifyParentLinkage(run, a, WF, MSG);
  assert.equal(check.pass, true, JSON.stringify(check.evidence, null, 2));
  const ids = check.evidence.map((e) => e.id).sort();
  assert.deepEqual(ids, [
    'codebase-id',
    'parent-conversation-id',
    'parent-platform-id',
    'user-message',
    'workflow-name',
  ]);
  for (const leg of check.evidence) assert.equal(leg.pass, true, leg.id);
});

test('real record: adoption record binds the child verbatim with provenance', () => {
  const rec = adoptionRecord({
    mode: 'parent-linked',
    detail: run,
    conversationId: a.archonConversationId,
    workflowName: WF,
    evidence: verifyParentLinkage(run, a, WF, MSG).evidence,
    candidatesConsidered: 1,
    discoveredAfterMs: 0,
    detailText: JSON.stringify(run),
  });
  assert.equal(rec.mode, 'parent-linked');
  assert.equal(rec.runId, run.id);
  assert.equal(rec.childConversationId, 'cadfdd377f089e980b2558f348196a29');
  assert.equal(rec.parentConversationId, a.dbId);
  assert.equal(rec.parentPlatformId, a.archonConversationId);
  assert.equal(rec.codebaseId, a.expectedCodebaseId);
  assert.equal(rec.userMessage, MSG);
  assert.equal(rec.verifiedFrom, 'run-detail');
  assert.match(rec.detailSha256, /^sha256:[0-9a-f]{64}$/);
});

// One mutation per leg: adoption must refuse, and the refusing leg must be
// exactly the mutated one (fail on the RIGHT leg, not just fail).
const MUTATIONS = [
  {
    id: 'workflow-name',
    note: 'workflow-name-only match is never adoption (S2-R rule)',
    mutate: (r) => { r.workflow_name = 'some-other-workflow'; },
    expectFailing: ['workflow-name'],
  },
  {
    id: 'parent-conversation-id',
    note: 'child of a DIFFERENT conversation',
    mutate: (r) => { r.parent_conversation_id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; },
    expectFailing: ['parent-conversation-id'],
  },
  {
    id: 'parent-platform-id',
    note: 'platform namespace points elsewhere',
    mutate: (r) => { r.parent_platform_id = 'web-999999999999-other'; },
    expectFailing: ['parent-platform-id'],
  },
  {
    id: 'codebase-id',
    note: 'run in a different project',
    mutate: (r) => { r.codebase_id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; },
    expectFailing: ['codebase-id'],
  },
  {
    id: 'user-message',
    note: 'message does not match THIS dispatch',
    mutate: (r) => { r.user_message = 'task task-other: different objective'; },
    expectFailing: ['user-message'],
  },
];

for (const m of MUTATIONS) {
  test(`real record negative: ${m.id} leg bites — ${m.note}`, () => {
    const mutated = JSON.parse(JSON.stringify(run));
    m.mutate(mutated);
    const check = verifyParentLinkage(mutated, a, WF, MSG);
    assert.equal(check.pass, false, `${m.id} leg did not reject`);
    const failing = check.evidence.filter((e) => !e.pass).map((e) => e.id);
    assert.deepEqual(failing, m.expectFailing);
  });
}

test('real record negative: missing association keys fail closed, not vacuously', () => {
  for (const key of ['dbId', 'archonConversationId', 'expectedCodebaseId']) {
    const broken = { ...a };
    delete broken[key];
    const check = verifyParentLinkage(run, broken, WF, MSG);
    assert.equal(check.pass, false, `missing ${key} must fail closed`);
    const named = check.evidence.find((e) => e.id === (key === 'dbId' ? 'parent-conversation-id' : key === 'archonConversationId' ? 'parent-platform-id' : 'codebase-id'));
    assert.equal(named.pass, false);
    assert.match(named.reason, /no recorded|no expected/);
  }
});

test('real record negative: null/undefined run detail never verifies', () => {
  assert.equal(verifyParentLinkage(null, a, WF, MSG).pass, false);
  assert.equal(directExact(null, a.archonConversationId, WF), false);
});
