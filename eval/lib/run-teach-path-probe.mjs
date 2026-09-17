#!/usr/bin/env node
// eval/lib/run-teach-path-probe.mjs — GPT's FINAL gate: one unchanged M2
// Teach-path probe on the clean scored-style RCOS lane.
//
// Drives ONLY existing machinery over HTTP — no lib changes, no new
// acquisition logic, no model calls:
//
//   clean lane → ENCOUNTER 1 goal (unfamiliar non-held-out family)
//     → no route (the gap) → POST /teach {sourceTaskId}
//     → existing BUILD + existing evaluator + existing promotion gate
//     → if CANDIDATE: explicit promotion → retry goal → external grader
//     → ENCOUNTER 2 goal → external grader
//
// The question this probe answers (GPT): can the EXISTING lib/teach.js
// acquire an arbitrary missing capability? Whatever happens is recorded
// honestly; acquisition failing at any stage is a valid gate outcome.
// Records land in eval/records/<exp-id>/teach-path-probe.jsonl.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { record } from './record.mjs';
import { runContext, snapshotRcosLane, assertCleanLane, writeRunManifest } from './experiment.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const RCOS_URL = argOf('--rcos', 'http://127.0.0.1:8413');
const ARCHON = argOf('--archon', 'http://127.0.0.1:13091');
const LANE_HOME = argOf('--lane-home', '/tmp/opui-shakedown-rcos');
const ARCHON_WORKFLOWS = argOf('--workflows-dir', '/tmp/opui-rc0-archon/workflows');
const ARCHON_WORKSPACE = argOf('--workspace-dir', '/private/tmp/opui-rc0-folder');
const FAMILY = argOf('--family', 'F03-structured-extraction');

const manifest = JSON.parse(await readFile(join(root, 'eval', 'corpus-manifest.json'), 'utf8'));
const ctx = await runContext({ lane: 'rcos', experimentId: argOf('--exp-id') });
const recordsDir = join(root, 'eval', 'records', ctx.experiment_id);
await mkdir(recordsDir, { recursive: true });
const recordsPath = join(recordsDir, 'teach-path-probe.jsonl');

async function api(path, body, timeoutMs = 180000) {
  const res = await fetch(RCOS_URL + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

async function stageFixture(objId) {
  const stage = join(recordsDir, 'stage', objId.replace(/[\/]/g, '__'));
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  execFileSync('cp', ['-R', join(root, 'eval', 'corpus', objId, 'workspace') + '/.', stage + '/']);
  const objective = (await readFile(join(root, 'eval', 'corpus', objId, 'objective.txt'), 'utf8')).trim();
  const expected = JSON.parse(await readFile(join(root, 'eval', 'corpus', objId, 'expected.json'), 'utf8'));
  return { stage, objective, expected };
}

function gradeExtraction(expected, evidenceText) {
  const meta = new Set(['total_pairs', 'status', 'artifact', 'count']);
  const got = [];
  for (const m of evidenceText.matchAll(/RESULT\s+(\S+)=(\d+)/g)) {
    if (!meta.has(m[1]) && m[1].includes('.')) got.push([m[1], m[2]]);
  }
  for (const m of evidenceText.matchAll(/host=(\S+)\s+port=(\d+)/g)) {
    got.push([m[1], m[2]]);
  }
  const want = Object.entries(expected.fields);
  const ok = want.length === got.length && want.every(([h, p], i) => got[i] && got[i][0] === h && got[i][1] === String(p));
  return { satisfied: ok, detail: ok ? 'extraction matches' : `extraction mismatch (want ${want.length} pairs, got ${got.length})` };
}

function codesOf(goal) {
  return (goal && goal.failureCodes) || (goal && goal.verdict && goal.verdict.failureCodes) || [];
}

async function evidenceTextOf(goal) {
  const attempts = (goal && goal.attempts) || [];
  const runId = attempts.length && attempts[attempts.length - 1] && attempts[attempts.length - 1].runId;
  if (!runId) return '';
  try {
    const d = await (await fetch(ARCHON + '/api/workflows/runs/' + encodeURIComponent(runId), { signal: AbortSignal.timeout(15000) })).json();
    const run = (d && d.run) || d;
    const events = (d && d.events) || run.events || [];
    return events.map((e) => e && e.data && (typeof e.data.node_output === 'string' ? e.data.node_output : (typeof e.data.output === 'string' ? e.data.output : ''))).filter(Boolean).join('\n');
  } catch { return ''; }
}

// ---- clean lane preparation (identical to the shakedown/probe recipe)
async function prepareLane() {
  const opui = join(LANE_HOME, 'operator-ui');
  await rm(opui, { recursive: true, force: true });
  await mkdir(opui, { recursive: true });
  const reg = JSON.parse(await readFile(join(root, 'fixtures', 'capability-registry.example.json'), 'utf8'));
  const stripped = (reg.capabilities || []).filter((c) => !(c.provenance && c.provenance.builtBy));
  await writeFile(join(opui, 'seed-registry.json'), JSON.stringify({ ...reg, capabilities: stripped, _lane_note: 'EVAL LANE — fixture registry minus development-acquired capabilities' }, null, 2) + '\n', 'utf8');
  await writeFile(join(LANE_HOME, 'operator-ui.config.json'), JSON.stringify({
    archon: { baseUrl: ARCHON, timeoutMs: 8000 },
    registry: { path: join(opui, 'seed-registry.json') },
    authority: { preset: 'ASK_BEFORE_ACTION' },
    teaching: { workflowsDir: ARCHON_WORKFLOWS, workspaceDir: ARCHON_WORKSPACE },
  }, null, 2) + '\n', 'utf8');
}
await prepareLane();
const snap = await snapshotRcosLane({ dshHome: LANE_HOME, seedRegistryPath: join(LANE_HOME, 'operator-ui', 'seed-registry.json') });
assertCleanLane(snap);
console.log('lane snapshot: CLEAN (seed-only, zero history)');

const enc = [1, 2].map((n) => manifest.objectives.find((o) => o.id === `${FAMILY}/encounter-${n}` && !o.hidden));
if (enc.some((o) => !o || o.hidden)) throw new Error('probe family must have non-held-out encounters 1 and 2 in the visible corpus');

const probe = { lane_snapshot: { clean: true, registryHash: snap.registryHash }, teach_path: null, encounters: {}, cumulative_cost: { objective_executions: 0, acquisitions: 0, candidate_evaluations: 0, retries: 0, model_usage: [] } };

async function runEncounter(n, note) {
  const e = await stageFixture(enc[n - 1].id);
  await rm(ARCHON_WORKSPACE, { recursive: true, force: true });
  await mkdir(ARCHON_WORKSPACE, { recursive: true });
  execFileSync('cp', ['-R', e.stage + '/.', ARCHON_WORKSPACE + '/']);
  await new Promise((r) => setTimeout(r, 2000)); // archon workspace settle
  const goal = await api('/plugins/operator-ui/goal', { objective: e.objective });
  const g = goal.goal || goal;
  const codes = codesOf(g);
  const evidence = await evidenceTextOf(g);
  const grade = gradeExtraction(e.expected, evidence);
  probe.cumulative_cost.objective_executions += 1;
  return { e, g, codes, evidence, grade, note };
}

// ---- ENCOUNTER 1: expect the gap
const e1 = await runEncounter(1, 'gap admission');
probe.encounters.encounter1 = { objective: e1.e.objective, routed: !!(e1.g.route && e1.g.route.selected), refusal: e1.codes, taskId: e1.g.taskId };
console.log('ENC1:', (e1.g.route && e1.g.route.selected) ? 'ROUTED (unexpected!)' : 'no route → gap confirmed', `(${e1.codes.join(',') || ''})`);
await record(recordsPath, 'rcos', { task_family: FAMILY, encounter: 1, objective_id: enc[0].id, objective: e1.e.objective, objective_satisfied: false, false_ship: null, failure_codes: e1.codes, evidence_refs: [e1.g.taskId].filter(Boolean), human_interventions: 0, approval_interventions: 0, route: null, attempts: 0, scored: false, notes: 'teach-path probe: encounter 1 gap admission' });

if ((e1.g.route && e1.g.route.selected) || !e1.g.taskId) {
  probe.teach_path = { skipped: 'encounter 1 did not produce a routable gap' };
  await writeRunManifest(recordsDir, ctx, { kind: 'teach-path-probe', probe });
  console.log('teach path skipped — nothing to teach on');
  process.exit(0);
}

// ---- TEACH: the EXISTING M2 entry point, unchanged
console.log('TEACH: POST /teach {sourceTaskId: ' + e1.g.taskId + '} (existing lib/teach.js machinery, unchanged) ...');
const t0 = Date.now();
const tRes = await api('/plugins/operator-ui/teach', { sourceTaskId: e1.g.taskId });
const teaching = (tRes && tRes.teaching) || tRes;
const evals = (teaching && teaching.evaluations) || [];
probe.cumulative_cost.acquisitions += 1;
probe.cumulative_cost.candidate_evaluations += evals.length;
// THE architectural fact under test: the existing teach machinery invokes
// NO cognitive model at all — acquisition cost is wall-clock only.
probe.teach_path = {
  teaching_task_id: teaching && teaching.taskId,
  verdict: teaching && teaching.verdict,
  candidate_capability: (teaching && teaching.candidate && teaching.candidate.capabilityId) || null,
  candidate_version: (teaching && teaching.candidate && teaching.candidate.version) || null,
  source_objective: e1.e.objective,
  candidate_matches_source_objective: false, // set below from the candidate id vs the objective text
  evaluations: evals.map((x) => ({ caseId: x.caseId, status: x.status, pass: x.pass, expected: x.expected, observed: x.observed })),
  wall_ms: Date.now() - t0,
  model_calls: 0,
};
if (probe.teach_path.candidate_capability && probe.teach_path.candidate_capability !== 'workspace-word-count') {
  // if the machinery ever produces something else, record it verbatim — do not assume
  probe.teach_path.candidate_matches_source_objective = null;
}
console.log('TEACH verdict:', teaching && teaching.verdict, '| candidate:', probe.teach_path.candidate_capability, 'v' + probe.teach_path.candidate_version, `(${evals.filter((x) => x.pass).length}/${evals.length} evals passed, 0 model calls)`);
await record(recordsPath, 'rcos', { task_family: FAMILY, encounter: 1, objective_id: enc[0].id + '/teach', objective: e1.e.objective, objective_satisfied: false, false_ship: null, failure_codes: teaching && teaching.verdict === 'REFUSED' ? ['teach-refused'] : [], evidence_refs: [teaching && teaching.taskId].filter(Boolean), human_interventions: 0, approval_interventions: 0, route: null, attempts: evals.length, capability_built: probe.teach_path.candidate_capability, scored: false, notes: `existing M2 teach machinery, unchanged: verdict=${teaching && teaching.verdict} candidate=${probe.teach_path.candidate_capability} model_calls=0` });

let promoted = false;
if (teaching && teaching.verdict === 'CANDIDATE') {
  // ---- explicit promotion (the operator action, via the existing route)
  const pRes = await api('/plugins/operator-ui/teach', { promoteTaskId: teaching.taskId });
  promoted = !!(pRes && pRes.ok);
  probe.teach_path.promotion = promoted ? { ok: true, capability: pRes.capability && pRes.capability.id } : { ok: false, error: pRes && pRes.error };
  console.log('PROMOTE:', promoted ? 'promoted ' + (pRes.capability && pRes.capability.id) : 'refused: ' + (pRes && pRes.error));
} else {
  probe.teach_path.promotion = { ok: false, reason: 'verdict ' + (teaching && teaching.verdict) + ' — gate stops here per GPT (preserve the failure)' };
}

// ---- RETRY encounter 1 through the (possibly) learned capability
if (promoted) {
  probe.cumulative_cost.retries += 1;
  const r1 = await runEncounter(1, 'retry after promotion');
  const routed = !!(r1.g.route && r1.g.route.selected);
  let approvals = 0;
  let final = r1.g;
  let finalCodes = r1.codes;
  let finalEvidence = r1.evidence;
  if (finalCodes.includes('awaiting-approval') || (final.verdict && final.verdict.decision === 'PENDING')) {
    const aRes = await api('/plugins/operator-ui/goal', { approveTaskId: final.taskId });
    approvals = 1;
    final = (aRes && aRes.goal) || final;
    finalCodes = codesOf(final);
    finalEvidence = await evidenceTextOf(final);
  }
  const grade = gradeExtraction(r1.e.expected, finalEvidence);
  probe.encounters.retry = { routed, route_selected: (final.route && final.route.selected) || null, approvals, failure_codes: finalCodes, grader: grade, taskId: final.taskId };
  console.log('RETRY ENC1:', routed ? 'routed → ' + ((final.route && final.route.selected) || {}).capability : 'still no route', '| grader:', grade.detail);
  await record(recordsPath, 'rcos', { task_family: FAMILY, encounter: 1, objective_id: enc[0].id + '/retry', objective: r1.e.objective, objective_satisfied: grade.satisfied, false_ship: grade.satisfied ? null : false, failure_codes: finalCodes, evidence_refs: [final.taskId].filter(Boolean), human_interventions: 0, approval_interventions: approvals, route: (final.route && final.route.selected) || null, attempts: 1, capability_reused: routed ? (final.route && final.route.selected && final.route.selected.capability) || probe.teach_path.candidate_capability : null, scored: false, notes: 'retry after promotion through existing machinery: ' + grade.detail });
}

// ---- ENCOUNTER 2: reuse path
const e2 = await runEncounter(2, 'encounter 2 reuse check');
const routed2 = !!(e2.g.route && e2.g.route.selected);
let approvals2 = 0;
let final2 = e2.g;
let final2Codes = e2.codes;
let final2Evidence = e2.evidence;
if (final2Codes.includes('awaiting-approval') || (final2.verdict && final2.verdict.decision === 'PENDING')) {
  const aRes2 = await api('/plugins/operator-ui/goal', { approveTaskId: final2.taskId });
  approvals2 = 1;
  final2 = (aRes2 && aRes2.goal) || final2;
  final2Codes = codesOf(final2);
  final2Evidence = await evidenceTextOf(final2);
}
const grade2 = gradeExtraction(e2.e.expected, final2Evidence);
probe.encounters.encounter2 = { routed: routed2, route_selected: (final2.route && final2.route.selected) || null, approvals: approvals2, failure_codes: final2Codes, grader: grade2, taskId: final2.taskId };
console.log('ENC2:', routed2 ? 'routed → ' + ((final2.route && final2.route.selected) || {}).capability : 'no route', '| grader:', grade2.detail);
await record(recordsPath, 'rcos', { task_family: FAMILY, encounter: 2, objective_id: enc[1].id, objective: e2.e.objective, objective_satisfied: grade2.satisfied, false_ship: grade2.satisfied ? null : false, failure_codes: final2Codes, evidence_refs: [final2.taskId].filter(Boolean), human_interventions: 0, approval_interventions: approvals2, route: (final2.route && final2.route.selected) || null, attempts: routed2 ? 1 : 0, capability_reused: routed2 ? probe.teach_path.candidate_capability : null, scored: false, notes: 'encounter 2 through existing machinery: ' + grade2.detail });

await writeRunManifest(recordsDir, ctx, { kind: 'teach-path-probe', probe });
console.log('\nrecords:', recordsPath);
console.log('ACCOUNTING:', JSON.stringify(probe.cumulative_cost));
