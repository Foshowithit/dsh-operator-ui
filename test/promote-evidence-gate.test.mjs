// The promotion gate must RE-DERIVE the verdict, not read a self-declared one.
//
// WHY THIS FILE EXISTS
// Measured on the real supported promotion path (D3.B, 2026-09-26) against a
// real Archon 0.4.1 through the certified artifact: a teaching envelope whose
// `verdict` said CANDIDATE while its OWN `evaluations` said 0/3 passed — and
// whose `candidate.workflowSha256` did not hash the `candidate.workflowYaml` it
// carried — was PROMOTED. The registry gained the capability and its bytes:
//
//   registry  dda9c69640e4524aaf87c8649ba28c6c34e3d64ef9d272ec1e9c77f3debd209d
//          -> b4cd0c41b5e62679435ab3a163360eecd809b131c5e87dc89f05f5a803426343
//
// The gate checked `verdict === 'CANDIDATE'` — a field it TRUSTED — and never
// looked at the evidence sitting next to it in the same record. This is the same
// defect family as the workspace-identity bug in the same module: the recorded
// verdict was not the thing that happened. One direction accused a candidate
// that was never tested; this direction admits a candidate that never passed.
//
// THE CONTROL IS THE POINT. A gate that refused EVERYTHING would satisfy the
// three tamper legs, so the last leg promotes an HONEST envelope and requires
// the registry to gain the entry. Without it this file would pin a refusal, not
// a gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sha256 = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const YAML = [
  'name: promote-gate-probe-v0-1-0',
  'description: promote-gate probe',
  'nodes:',
  '  - id: n1',
  '    bash: echo RESULT probe=ok; echo learned-promote-gate-probe:done',
].join('\n');

let home = null;
let registryPath = null;
let promoteCandidate = null;
let upsertTask = null;

const PASSING = [
  { caseId: 'eval-single-line', status: 'completed', runId: 'r1', expected: { lines: 1 }, observed: { lines: 1 }, pass: true },
  { caseId: 'eval-multi-line', status: 'completed', runId: 'r2', expected: { lines: 3 }, observed: { lines: 3 }, pass: true },
  { caseId: 'eval-unicode', status: 'completed', runId: 'r3', expected: { lines: 2 }, observed: { lines: 2 }, pass: true },
];
const ALL_FAILED = PASSING.map((e) => ({ ...e, pass: false, observed: { lines: 0 } }));

function envelope(id, { evaluations, workflowSha256 } = {}) {
  return {
    taskId: id, tasksVersion: 1, kind: 'teaching', sourceTaskId: 'task-promote-gate',
    status: 'candidate', verdict: 'CANDIDATE',
    createdAt: '2026-03-01T00:00:00.000Z', endedAt: '2026-03-01T00:01:00.000Z',
    gap: { objective: 'count words', failureCodes: ['no-route'], reason: 'no capability in the registry matched this objective' },
    candidate: {
      capabilityId: 'promote-gate-probe', version: '0.1.0',
      workflow: 'promote-gate-probe-v0-1-0', workflowYaml: YAML,
      workflowSha256: workflowSha256 === undefined ? sha256(YAML) : workflowSha256,
      provides: 'promote gate probe', routingVocabulary: ['probe'],
      requires: ['shell:execute'], requiresUnknown: [],
      verification: { expectOutput: 'learned-promote-gate-probe:done', terminalStatus: 'completed' },
      lifecycle: 'candidate',
    },
    evaluations: evaluations === undefined ? PASSING : evaluations,
    provenance: { builtBy: 'test', teachingTaskId: id, sourceTaskId: 'task-promote-gate' },
    nextAction: { kind: 'promote', label: 'Promote to Intelligence', reason: 'test' },
    sealedBy: 'test',
  };
}

async function registry() {
  return JSON.parse(await readFile(registryPath, 'utf8'));
}
async function registrySha() {
  return createHash('sha256').update(await readFile(registryPath)).digest('hex');
}

test.before(async () => {
  home = await mkdtemp(join(tmpdir(), 'opui-promote-gate-'));
  process.env.DSH_HOME = home;
  await mkdir(join(home, 'operator-ui'), { recursive: true });
  registryPath = join(home, 'registry.json');
  await writeFile(registryPath, JSON.stringify({ schema: 'rcos-public-v1', capabilities: [] }, null, 2) + '\n');
  await writeFile(join(home, 'operator-ui.config.json'), JSON.stringify({
    registry: { path: registryPath },
    archon: { baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 },
    teaching: { workflowsDir: join(home, 'wf'), workspaceDir: join(home, 'ws') },
  }, null, 2) + '\n');

  ({ promoteCandidate } = await import('../lib/teach.js'));
  ({ upsertTask } = await import('../lib/tasks.js'));
});

test.after(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

test('TAMPER: a CANDIDATE whose own evaluations did not pass is REFUSED, and the registry does not move', async () => {
  await upsertTask(envelope('teach-tamper-failed-evals', { evaluations: ALL_FAILED }));
  const before = await registrySha();

  const out = await promoteCandidate({ teachingTaskId: 'teach-tamper-failed-evals' });

  assert.equal(out.ok, false, 'poisoned evidence must not promote');
  assert.equal(out.code, 'evidence-contradicts-verdict');
  assert.ok(/did not pass/.test(out.error), 'the reason names the evidence, not a generic refusal');
  assert.equal(await registrySha(), before, 'the registry must be byte-identical after a refused promotion');
  assert.equal((await registry()).capabilities.length, 0, 'no promoted entry was created');
});

test('TAMPER: a CANDIDATE with no evaluation evidence at all is REFUSED', async () => {
  await upsertTask(envelope('teach-tamper-no-evals', { evaluations: [] }));
  const before = await registrySha();

  const out = await promoteCandidate({ teachingTaskId: 'teach-tamper-no-evals' });

  assert.equal(out.ok, false);
  assert.equal(out.code, 'evidence-absent');
  assert.equal(await registrySha(), before);
  assert.equal((await registry()).capabilities.length, 0);
});

test('TAMPER: candidate bytes that do not hash to the declared digest are REFUSED', async () => {
  await upsertTask(envelope('teach-tamper-bytes', { workflowSha256: 'sha256:' + '0'.repeat(64) }));
  const before = await registrySha();

  const out = await promoteCandidate({ teachingTaskId: 'teach-tamper-bytes' });

  assert.equal(out.ok, false);
  assert.equal(out.code, 'candidate-bytes-altered');
  assert.ok(/altered after it was evaluated/.test(out.error));
  assert.equal(await registrySha(), before, 'a digest mismatch must not touch the registry');
  assert.equal((await registry()).capabilities.length, 0);
});

test('CONTROL: an HONEST envelope still promotes — the gate is a gate, not a wall', async () => {
  await upsertTask(envelope('teach-honest'));
  const before = await registrySha();

  const out = await promoteCandidate({ teachingTaskId: 'teach-honest' });

  assert.equal(out.ok, true, 'an honest CANDIDATE must still be promotable (error=' + out.error + ', code=' + out.code + ')');
  assert.equal(out.capability.id, 'promote-gate-probe');
  assert.notEqual(await registrySha(), before, 'the registry MUST move for an honest promotion');
  const caps = (await registry()).capabilities;
  assert.equal(caps.length, 1);
  assert.equal(caps[0].status, 'promoted');
  assert.equal(caps[0].workflow, 'promote-gate-probe-v0-1-0');
  assert.deepEqual(caps[0].provenance.evalSet.map((e) => e.pass), [true, true, true],
    'the promoted entry carries the evidence it was promoted on');
});
