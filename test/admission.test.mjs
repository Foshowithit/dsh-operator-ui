// P6E phase-2 offline tests — execution admission (governed capability reuse).
// Every fixture envelope lives in an os.tmpdir() home: a full config file, an
// empty registry, the frozen workflow bytes, and a tasks.json store. What
// these establish, per the binding plan:
//   happy path    — one derived entry, reuse_count 0, every provenance pin
//                   re-derivable from the stored envelope; the task store is
//                   byte-unchanged by admission (a read stays a read)
//   refusal matrix — every typed refusal names its code AND leaves the
//                   registry AND the task store byte-unchanged
//   route gates   — the real routeObjective scores the admitted entry: the
//                   reuse objective passes both gates, disjoint and weak
//                   objectives refuse
//   authority     — PLAN_ONLY is approval (never silent auto), unknown scopes
//                   fail closed, required mode denies wrong-owner and
//                   unattributed records while dev passes through
//   history       — both envelopes group under the derived capability id with
//                   uses = 2 and objectives satisfied = 2, no decay
// The history test is this file's ONLY caller of the reconciling task read
// path (its once-guarded hydrate reads DSH_HOME at first call).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { admitExecution } from '../lib/admission.js';
import { routeObjective } from '../lib/goal.js';
import { decisionFor } from '../lib/authority.js';
import { taskAuthorizedForPrincipal, publicAuth, AUTH_REFUSAL } from '../lib/auth.js';
import { capabilityHistory, historyLines } from '../lib/history.js';

// Env overrides would silently repoint the config layers away from the
// fixture home — clear them for this process.
delete process.env.DSH_OPERATOR_UI_REGISTRY;
delete process.env.DSH_OPERATOR_UI_TEACH_WORKFLOWS;
delete process.env.DSH_OPERATOR_UI_TEACH_WORKSPACE;

const WORKFLOW = 'rcos-p6d-bridge';
const SENTINEL = 'rcos-bridge-sentinel:rcos-bridge-v1';
const RECEIPT = 'brg_adee94a83cb5800b358a2be7fc7de345';
const RECEIPT_SHA = 'sha256:4b3d340eb03c9b127caf7a1e341964566e4aea8d448057677709b7c830404a57';
const SOURCE_TASK = 'task-22695a67';
const SOURCE_RUN = 'fb6b229c6bddf9ac878137ece697be94';
const DESC = 'Bridge verification reuse candidate derived from the accepted P6D envelope.';
const TAGS = ['bridge', 'non-root', 'admission'];

// The SHIP envelope, shaped after the accepted P6D goal record: every field
// admission reads is present; the rest is incidental context.
function shipGoal(taskId = SOURCE_TASK) {
  return {
    taskId,
    tasksVersion: 2,
    kind: 'goal',
    objective: 'verify bridge non-root capability on the worker',
    status: 'closed',
    createdAt: '2026-09-23T11:00:00.000Z',
    endedAt: '2026-09-23T11:10:00.000Z',
    route: {
      selected: { id: 'verify-bridge', version: '1.0.0', workflow: WORKFLOW, lifecycle: 'active' },
      considered: [{ id: 'verify-bridge', score: 1, reasons: ['implements workflow ' + WORKFLOW] }],
      reason: 'implements workflow ' + WORKFLOW,
    },
    attempts: [{ attempt: 1, workflow: WORKFLOW, runId: SOURCE_RUN, status: 'completed', failureCode: null, error: null }],
    checks: [],
    execution: {},
    capabilityValidation: { pass: true, checks: [{ id: 'terminal-status', pass: true }, { id: 'declared-expectation', pass: true }] },
    objectiveEvaluation: {
      status: 'SATISFIED',
      pass: true,
      reason: 'required objective evidence is present',
      checks: [{ id: 'contains:' + SENTINEL, pass: true, expected: SENTINEL }],
    },
    claim: {},
    trust: {},
    nextAction: null,
    verdict: 'SHIP',
    verdictDetail: '',
    failureCodes: [],
    error: null,
    evidence: {},
    authority: {
      preset: 'AUTO_WITHIN_POLICY',
      requires: ['shell:execute'],
      granted: ['shell:execute'],
      missing: [],
      mode: 'auto',
      reason: 'every required scope is pre-authorized by AUTO_WITHIN_POLICY',
      approvedAt: null,
    },
    conversation: null,
    workspace: { workspaceId: 'ws-c9efbb767195c36c', name: 'ws', owner: 'p6e-owner' },
    executionEnvironment: {
      environmentId: 'env-p6d',
      establishedBy: 'adopted-run',
      runId: SOURCE_RUN,
      worker: {
        establishedBy: 'bridge-receipt',
        id: RECEIPT,
        status: 'not-claimed',
        ok: true,
        environmentId: 'env-p6d-solari',
        receiptSha256: RECEIPT_SHA,
      },
    },
    lineage: {},
    sealedBy: 'goal-m1',
  };
}

function failedGoal() {
  const g = shipGoal('task-3133be58');
  g.objective = 'measure bridge latency under the load profile';
  g.verdict = 'FAILED';
  g.objectiveEvaluation = { status: 'NOT_SATISFIED', pass: false, reason: 'required objective evidence is absent', checks: [{ id: 'contains:' + SENTINEL, pass: false, expected: SENTINEL }] };
  g.capabilityValidation = { pass: false, checks: [{ id: 'terminal-status', pass: true }, { id: 'declared-expectation', pass: false }] };
  g.failureCodes = ['objective-not-satisfied'];
  return g;
}

let homeCounter = 0;

async function freshHome(t, opts = {}) {
  homeCounter += 1;
  const dir = await mkdtemp(join(tmpdir(), 'opui-p6e-'));
  const prevHome = process.env.DSH_HOME;
  await mkdir(join(dir, 'operator-ui'), { recursive: true });
  await mkdir(join(dir, 'workflows'), { recursive: true });
  await mkdir(join(dir, 'teach-ws'), { recursive: true });
  const config = {
    registry: { path: opts.unconfigured ? '' : join(dir, 'registry.json'), schema: 'rcos-public-v1', maxBytes: 200000 },
    teaching: { workflowsDir: join(dir, 'workflows'), workspaceDir: join(dir, 'teach-ws') },
  };
  await writeFile(join(dir, 'operator-ui.config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
  await writeFile(join(dir, 'workflows', WORKFLOW + '.yaml'), 'name: ' + WORKFLOW + '\nkind: loop\nnodes: []\n', 'utf8');
  await setRegistry(dir, []);
  await putTasks(dir, []);
  process.env.DSH_HOME = dir;
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    process.env.DSH_HOME = prevHome;
  });
  return dir;
}

async function setRegistry(dir, capabilities) {
  await writeFile(join(dir, 'registry.json'), JSON.stringify({ registry_version: 'v1', capabilities }, null, 2) + '\n', 'utf8');
}

async function putTasks(dir, tasks) {
  await writeFile(join(dir, 'operator-ui', 'tasks.json'), JSON.stringify({ tasksVersion: 2, tasks }, null, 2) + '\n', 'utf8');
}

const shaFile = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');
const registryPath = (dir) => join(dir, 'registry.json');
const tasksPath = (dir) => join(dir, 'operator-ui', 'tasks.json');

async function admit(dir, overrides = {}) {
  return admitExecution({
    goalTaskId: SOURCE_TASK,
    requires: ['shell:execute'],
    description: DESC,
    tags: TAGS,
    ...overrides,
  });
}

// One refusal: seed the stores, snapshot both byte states, call, assert the
// typed code AND that neither store moved.
async function expectRefusal(dir, store, opts) {
  await putTasks(dir, store);
  await setRegistry(dir, opts.registryCaps || []);
  const regSha = await shaFile(registryPath(dir));
  const taskSha = await shaFile(tasksPath(dir));
  const out = await admit(dir, opts.args || { goalTaskId: (store[0] && store[0].taskId) || 'task-missing' });
  assert.equal(out.ok, false, opts.label + ' must refuse');
  assert.equal(out.code, opts.code, opts.label + ' must code ' + opts.code + ' — got ' + out.code + ' / ' + out.error);
  assert.match(out.error, opts.match);
  assert.equal(await shaFile(registryPath(dir)), regSha, opts.label + ' must leave the registry byte-unchanged');
  assert.equal(await shaFile(tasksPath(dir)), taskSha, opts.label + ' must leave the task store byte-unchanged');
}

test('happy path: SHIP envelope → one derived entry, reuse_count 0, provenance pins re-derive', async (t) => {
  const dir = await freshHome(t);
  const env = shipGoal();
  await putTasks(dir, [env]);
  const taskSha = await shaFile(tasksPath(dir));

  const out = await admit(dir);
  assert.equal(out.ok, true, out.error);
  const e = out.entry;

  // identity derived from the envelope — never caller-declared
  assert.equal(e.id, 'verify-bridge');
  assert.equal(e.version, '1.0.0');
  assert.equal(e.workflow, WORKFLOW);
  assert.equal(e.status, 'promoted');
  assert.equal(e.kind, 'workflow');
  assert.ok(e.name.startsWith('ADMITTED — verify bridge'), e.name);
  assert.deepEqual(e.requires, ['shell:execute']);
  assert.equal(e.description, DESC);
  assert.deepEqual(e.tags, TAGS);

  // evaluator DERIVED from the single contains: expectation
  assert.deepEqual(e.objectiveEvaluation, { kind: 'output-contains', value: SENTINEL });
  assert.equal(e.verification.expectOutput, SENTINEL);
  assert.equal(e.verification.terminalStatus, 'completed');

  // bridge stamp carried at top level only; receipt id lives in provenance
  assert.deepEqual(e.bridge, { environmentId: 'env-p6d-solari' });
  assert.deepEqual(e.provenance.bridge, { receiptId: RECEIPT, receiptSha256: RECEIPT_SHA });

  // never used, never decayed
  assert.equal(e.reuse_count, 0);
  assert.deepEqual(e.admitted_after, []);
  assert.deepEqual(e.evals, []);
  assert.equal(e.last_eval, null);

  // provenance pins re-derive from the stored bytes
  const p = e.provenance;
  assert.equal(p.admission, 'execution-admission-v1');
  assert.equal(p.sourceTaskId, SOURCE_TASK);
  assert.equal(p.sourceRunId, SOURCE_RUN);
  assert.equal(p.envelopeSha256, 'sha256:' + createHash('sha256').update(JSON.stringify(env)).digest('hex'));
  assert.equal(p.workflowSha256, createHash('sha256').update(await readFile(join(dir, 'workflows', WORKFLOW + '.yaml'))).digest('hex'));
  assert.deepEqual(p.authority, env.authority);
  assert.equal(p.admittedBy, 'operator');
  assert.ok(p.admittedAt);

  // exactly one entry on disk; the task store never moved
  const reg = JSON.parse(await readFile(registryPath(dir), 'utf8'));
  assert.equal(reg.capabilities.length, 1);
  assert.deepEqual(reg.capabilities[0], e);
  assert.equal(await shaFile(tasksPath(dir)), taskSha, 'admission must never rewrite the task store');
});

test('refusal matrix: every typed code fires and neither store moves', async (t) => {
  const dir = await freshHome(t);
  const good = () => shipGoal();

  const cases = [
    { label: 'unknown goalTaskId', code: 'admission-goal-not-found', match: /no stored goal envelope/, store: [good()], args: { goalTaskId: 'task-none' } },
    { label: 'non-goal envelope', code: 'admission-not-a-goal', match: /kind is teaching/, store: [{ ...good(), kind: 'teaching' }] },
    { label: 'failed envelope names its gates', code: 'admission-not-shipped', match: /verdict=FAILED[\s\S]*failureCodes=objective-not-satisfied/, store: [failedGoal()] },
    { label: 'open envelope', code: 'admission-not-shipped', match: /status=open/, store: [{ ...good(), status: 'open' }] },
    { label: 'no completed run', code: 'admission-no-completed-run', match: /no completed run/, store: [{ ...good(), attempts: [{ attempt: 1, workflow: WORKFLOW, runId: SOURCE_RUN, status: 'failed' }] }] },
    { label: 'route not selected', code: 'admission-route-unselected', match: /no selected route/, store: [{ ...good(), route: { selected: null } }] },
    { label: 'authority missing', code: 'admission-authority-missing', match: /granted/, store: [{ ...good(), authority: { preset: 'AUTO_WITHIN_POLICY' } }] },
    { label: 'unknown scope fails closed', code: 'admission-unknown-scope', match: /bogus:scope/, store: [good()], args: { goalTaskId: SOURCE_TASK, requires: ['bogus:scope'], description: DESC, tags: TAGS } },
    { label: 'requires not held by the envelope', code: 'admission-requires-not-held', match: /filesystem:write/, store: [good()], args: { goalTaskId: SOURCE_TASK, requires: ['filesystem:write'], description: DESC, tags: TAGS } },
    {
      label: 'two distinct evaluator expectations',
      code: 'admission-evaluator-not-derivable',
      match: /2 distinct/,
      store: [(() => { const g = good(); g.objectiveEvaluation.checks = [{ id: 'contains:alpha:one', pass: true, expected: 'alpha:one' }, { id: 'contains:beta:two', pass: true, expected: 'beta:two' }]; return g; })()],
    },
    {
      label: 'no contains expectation',
      code: 'admission-evaluator-not-derivable',
      match: /0 distinct/,
      store: [(() => { const g = good(); g.objectiveEvaluation.checks = [{ id: 'lines:all-present', pass: true }]; return g; })()],
    },
    {
      label: 'workflow bytes missing',
      code: 'admission-workflow-bytes-missing',
      match: /no-such-workflow/,
      store: [(() => { const g = good(); g.route.selected = { id: 'other-cap', version: '1.0.0', workflow: 'no-such-workflow' }; return g; })()],
    },
    { label: 'already in the registry', code: 'admission-already-in-registry', match: /capability already in the registry — admission refused/, store: [good()], registryCaps: [{ id: 'verify-bridge' }] },
    { label: 'empty description', code: 'admission-metadata-invalid', match: /description/, store: [good()], args: { goalTaskId: SOURCE_TASK, requires: ['shell:execute'], description: '', tags: TAGS } },
    { label: 'oversized description', code: 'admission-metadata-invalid', match: /description/, store: [good()], args: { goalTaskId: SOURCE_TASK, requires: ['shell:execute'], description: 'x'.repeat(501), tags: TAGS } },
    { label: 'untyped tags', code: 'admission-metadata-invalid', match: /tags/, store: [good()], args: { goalTaskId: SOURCE_TASK, requires: ['shell:execute'], description: DESC, tags: ['Bad_Slug'] } },
    { label: 'missing tags', code: 'admission-metadata-invalid', match: /tags/, store: [good()], args: { goalTaskId: SOURCE_TASK, requires: ['shell:execute'], description: DESC, tags: undefined } },
    {
      label: 'incomplete bridge stamp',
      code: 'admission-bridge-stamp-invalid',
      match: /bridge stamp/,
      store: [(() => { const g = good(); delete g.executionEnvironment.worker.receiptSha256; return g; })()],
    },
  ];

  for (const c of cases) await expectRefusal(dir, c.store, c);
});

test('unconfigured registry refuses before any write', async (t) => {
  const dir = await freshHome(t, { unconfigured: true });
  await putTasks(dir, [shipGoal()]);
  const taskSha = await shaFile(tasksPath(dir));
  const out = await admit(dir);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'admission-registry-not-configured');
  assert.equal(await shaFile(tasksPath(dir)), taskSha);
});

test('re-admitting the same source refuses and leaves the registry byte-unchanged', async (t) => {
  const dir = await freshHome(t);
  await putTasks(dir, [shipGoal()]);
  const first = await admit(dir);
  assert.equal(first.ok, true, first.error);

  const regSha = await shaFile(registryPath(dir));
  const taskSha = await shaFile(tasksPath(dir));
  const again = await admit(dir);
  assert.equal(again.ok, false);
  assert.equal(again.code, 'admission-already-in-registry');
  assert.match(again.error, /capability already in the registry — admission refused/);
  assert.equal(await shaFile(registryPath(dir)), regSha, 'the duplicate admission must not touch the registry');
  assert.equal(await shaFile(tasksPath(dir)), taskSha);
  const reg = JSON.parse(await readFile(registryPath(dir), 'utf8'));
  assert.equal(reg.capabilities.length, 1, 'one admission = one capability, never two');
});

test('route score gates: the reuse objective routes, disjoint and weak objectives refuse', async (t) => {
  const dir = await freshHome(t);
  await putTasks(dir, [shipGoal()]);
  const out = await admit(dir);
  assert.equal(out.ok, true, out.error);
  const registry = JSON.parse(await readFile(registryPath(dir), 'utf8'));

  const reuse = routeObjective('re-verify bridge non-root worker capability after admission', registry);
  assert.ok(reuse.selected, 'reuse objective must route — ' + reuse.reason);
  assert.equal(reuse.selected.id, 'verify-bridge');
  assert.equal(reuse.selected.workflow, WORKFLOW);
  const scored = reuse.considered.find((c) => c.id === 'verify-bridge');
  assert.ok(scored.score >= 0.5, 'score gate: ' + scored.score);
  const m = /matched (\d+)\/(\d+) objective terms/.exec(reuse.reason);
  assert.ok(m, 'reason must record the match: ' + reuse.reason);
  assert.ok(Number(m[1]) >= 2, 'hits gate: ' + m[1]);

  const weak = routeObjective('bridge', registry);
  assert.equal(weak.selected, null);
  assert.match(weak.reason, /matches too weakly/);

  const disjoint = routeObjective('summarize the quarterly earnings deck', registry);
  assert.equal(disjoint.selected, null);
  assert.match(disjoint.reason, /add intelligence first/);
});

test('authority decisions: PLAN_ONLY is approval, unknown scopes fail closed, auto stays typed', () => {
  const plan = decisionFor('PLAN_ONLY', ['shell:execute'], []);
  assert.equal(plan.mode, 'approval');
  assert.deepEqual(plan.granted, []);
  assert.deepEqual(plan.missing, ['shell:execute']);

  const unknown = decisionFor('AUTO_WITHIN_POLICY', ['shell:execute', 'bogus:scope'], ['bogus:scope']);
  assert.equal(unknown.mode, 'approval');
  assert.match(unknown.reason, /unknown scope/);

  const auto = decisionFor('AUTO_WITHIN_POLICY', ['shell:execute'], []);
  assert.equal(auto.mode, 'auto');
  assert.deepEqual(auto.granted, ['shell:execute']);
  assert.deepEqual(auto.missing, []);
});

test('required mode: wrong owner and unattributed records deny; dev passes through', () => {
  assert.equal(taskAuthorizedForPrincipal({ principal: null, recordOwner: null }).ok, true);

  const wrong = taskAuthorizedForPrincipal({ principal: { id: 'op', ownerIds: ['someone-else'] }, recordOwner: 'p6e-owner', label: 'task ' + SOURCE_TASK });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, AUTH_REFUSAL.TASK_DENIED);
  assert.equal(wrong.status, 403);

  const unattributed = taskAuthorizedForPrincipal({ principal: { id: 'op', ownerIds: ['p6e-owner'] }, recordOwner: null, label: 'task ' + SOURCE_TASK });
  assert.equal(unattributed.ok, false);
  assert.equal(unattributed.code, AUTH_REFUSAL.UNATTRIBUTED);
  assert.equal(unattributed.status, 403);

  const owner = taskAuthorizedForPrincipal({ principal: { id: 'op', ownerIds: ['p6e-owner'] }, recordOwner: 'p6e-owner' });
  assert.equal(owner.ok, true);

  assert.equal(publicAuth({}).mode, 'dev');
});

test('history groups both envelopes under the derived id with uses = 2, no decay', async (t) => {
  const dir = await freshHome(t);
  const src = shipGoal();
  const reuse = shipGoal('task-9f1c22a4');
  reuse.attempts = [{ attempt: 1, workflow: WORKFLOW, runId: 'c0e1d2a3b4c5d6e7f8091a2b3c4d5e6f', status: 'completed', failureCode: null, error: null }];
  reuse.createdAt = '2026-09-23T11:30:00.000Z';
  reuse.endedAt = '2026-09-23T12:00:00.000Z';
  // a non-goal task carrying the same route must NOT inflate the group
  const other = shipGoal('task-teaching-row');
  other.kind = 'teaching';
  await putTasks(dir, [src, other, reuse]);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline fixture — no orchestrator contact'); };
  try {
    const h = await capabilityHistory();
    const cap = h.capabilities['verify-bridge'];
    assert.ok(cap, 'both envelopes must group under the derived id — keys: ' + Object.keys(h.capabilities).join(','));
    assert.equal(cap.uses, 2);
    assert.equal(cap.objectivesSatisfied, 2);
    assert.equal(cap.objectivesMissed, 0);
    assert.equal(cap.blocksAfterExecution, 0);
    assert.equal(cap.recent.length, 2);
    assert.equal(cap.needsReevaluation, false);
    assert.equal(cap.decayReason, null);
    assert.equal(cap.lastVerifiedAt, '2026-09-23T12:00:00.000Z');

    const line = historyLines(cap);
    assert.ok(line.startsWith('2 uses · 2 objectives satisfied · '), 'history line: ' + line);
  } finally {
    globalThis.fetch = realFetch;
  }
});
