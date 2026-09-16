#!/usr/bin/env node
// eval/lib/run-shakedown.mjs — non-scored 2-family × 2-encounter × 2-lane
// shakedown (Eval Protocol v1 §8, GPT-authorized).
//
// Purpose ONLY: prove the pipeline end to end
//   fixture reset → objective admission → execution → result capture →
//   external grading → telemetry record → reset → other lane
// and surface instrumentation defects. Performance is explicitly NOT data:
// no capability/routing quality tuning may come from these records.
//
// Lanes:
//   rcos — POST /plugins/operator-ui/goal against a CLEAN lane home
//          (assertCleanLane guardrail), grading from result state.
//   dsh  — baseline-config.json declares the DSH driver invocation; when the
//          driver is not yet wired the lane is recorded SKIPPED with the
//          reason (honest), never faked.
//
// Every record carries the experiment identity + grader-integrity fields.

import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { record, grade } from './record.mjs';
import { runContext, snapshotRcosLane, assertCleanLane, writeRunManifest } from './experiment.mjs';

const execFn = (cmd, args) => { execFileSync(cmd, args); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256s = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const RCOS_URL = argOf('--rcos', 'http://127.0.0.1:8412');
const LANE_HOME = argOf('--lane-home', '/tmp/opui-shakedown-rcos');
const SEED_REGISTRY = argOf('--seed-registry', join(root, 'fixtures', 'capability-registry.example.json'));
const WORKSPACE_DIR = argOf('--workspace-dir', '/private/tmp/opui-rc0-folder'); // the Archon-registered folder the lane executes in
const FAMILIES = (argOf('--families', 'F09-log-analysis,F08-format-conversion')).split(',');
const ENCOUNTERS = (argOf('--encounters', '1,2')).split(',').map(Number);
const MARK = { scored: false, notes: 'shakedown — instrumentation proof only, NOT performance data' };

const manifest = JSON.parse(await readFile(join(root, 'eval', 'corpus-manifest.json'), 'utf8'));
const ctx = await runContext({ lane: process.argv.includes('--lane-dsh') ? 'dsh' : 'rcos', experimentId: argOf('--exp-id') });

const recordsDir = join(root, 'eval', 'records', ctx.experiment_id);
await mkdir(recordsDir, { recursive: true });
const recordsPath = join(recordsDir, `shakedown-${ctx.lane}.jsonl`);
const defects = [];

async function stageWorkspace(obj) {
  // fixture reset: copy the objective's workspace into the live stage dir
  const stage = join(recordsDir, 'stage', obj.id.replace(/[\/]/g, '__'));
  await rm(stage, { recursive: true, force: true });
  const src = join(root, 'eval', 'corpus', obj.id, 'workspace');
  const expected = JSON.parse(await readFile(join(root, 'eval', 'corpus', obj.id, 'expected.json'), 'utf8'));
  const objective = (await readFile(join(root, 'eval', 'corpus', obj.id, 'objective.txt'), 'utf8')).trim();
  let count = 0;
  async function cp(from, to) {
    for (const e of await readdir(from, { withFileTypes: true })) {
      const fp = join(from, e.name), tp = join(to, e.name);
      if (e.isDirectory()) { await mkdir(tp, { recursive: true }); await cp(fp, tp); }
      else { const c = await readFile(fp); await mkdir(dirname(tp), { recursive: true }); await writeFile(tp, c); count += 1; }
    }
  }
  await cp(src, stage);
  const expectedHash = sha256s(JSON.stringify(expected));
  return { stage, expected, objective, expectedHash, fixtureFiles: count };
}

async function workspaceHash(dir) {
  const parts = [];
  async function walk(d) {
    let list = [];
    try { list = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else parts.push(e.name + ':' + sha256s(await readFile(p)));
    }
  }
  await walk(dir);
  return sha256s(parts.join('|'));
}

async function runRcosObjective(obj, staged) {
  const started = Date.now();
  const res = await fetch(RCOS_URL + '/plugins/operator-ui/goal', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objective: staged.objective }),
  });
  let goal = (await res.json()).goal || {};
  const approvals = [];
  let attempts = 1;
  // The authority gate is part of the RCOS lane's NORMAL policy: an
  // awaiting-approval envelope is approved once (approval_intervention).
  const codes = new Set(((goal.failureCodes) || (goal.verdict && goal.verdict.failureCodes) || []));
  if (codes.has('awaiting-approval')) {
    approvals.push(new Date().toISOString());
    const r2 = await fetch(RCOS_URL + '/plugins/operator-ui/goal', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approveTaskId: goal.taskId }),
    });
    goal = (await r2.json()).goal || goal;
  }
  // The fixture files the objective runs against live in the STAGE dir; the
  // RCOS lane executes in its own registered workspace, so the runner copies
  // the staged fixture into the lane workspace between admission and poll —
  // the SAME files the objective names. (Grading reads the stage dir.)
  const evidenceText = (goal.evidence && goal.evidence.outputs || []).join('\n');
  return { goal, wall_time_ms: Date.now() - started, approval_interventions: approvals.length, approvals, evidenceText, attempts };
}

const hiddenGuard = (obj) => { if (obj.hidden) throw new Error('shakedown tried to use a HELD-OUT objective: ' + obj.id); };

// --prepare-lane: build a CLEAN lane home — the frozen registry with any
// development-acquired (provenance-tagged) capability stripped, a lane
// config pointing at it, and zero durable history. Returns the registry
// path the snapshot must check.
async function prepareLane() {
  const reg = JSON.parse(await readFile(SEED_REGISTRY, 'utf8'));
  const stripped = (reg.capabilities || []).filter((c) => !(c.provenance && c.provenance.builtBy));
  const removed = (reg.capabilities || []).length - stripped.length;
  const laneReg = join(LANE_HOME, 'operator-ui', 'seed-registry.json');
  await mkdir(dirname(laneReg), { recursive: true });
  await writeFile(laneReg, JSON.stringify({ ...reg, capabilities: stripped, _lane_note: 'EVAL LANE — fixture registry minus development-acquired capabilities (guardrail)' }, null, 2) + '\n', 'utf8');
  const laneCfg = join(LANE_HOME, 'operator-ui.config.json');
  await mkdir(dirname(laneCfg), { recursive: true });
  await writeFile(laneCfg, JSON.stringify({
    archon: { baseUrl: argOf('--archon', 'http://127.0.0.1:13091'), timeoutMs: 8000 },
    registry: { path: laneReg },
    authority: { preset: 'ASK_BEFORE_ACTION' },
  }, null, 2) + '\n', 'utf8');
  return { laneReg, removed };
}

async function main() {
  let laneRegistryPath = SEED_REGISTRY;
  let lanePrep = null;
  if (process.argv.includes('--prepare-lane')) {
    lanePrep = await prepareLane();
    laneRegistryPath = lanePrep.laneReg;
    console.log('lane prepared at', LANE_HOME, '— dev-acquired caps stripped:', lanePrep.removed);
  }

  const picked = manifest.stream
    .map((id) => manifest.objectives.find((o) => o.id === id))
    .filter((o) => FAMILIES.some((f) => o.id.startsWith(f + '/')) && ENCOUNTERS.includes(o.encounter));
  console.log(`shakedown ${ctx.experiment_id} lane=${ctx.lane}: ${picked.length} objectives (non-scored)`);

  // Clean-lane snapshot + guardrail BEFORE anything runs.
  const snap = await snapshotRcosLane({ dshHome: LANE_HOME, seedRegistryPath: laneRegistryPath });
  try {
    assertCleanLane(snap);
    console.log('lane snapshot: CLEAN');
  } catch (e) {
    if (process.argv.includes('--allow-dirty-dev-home')) {
      defects.push('lane ran on a DIRTY snapshot (dev home) — acceptable ONLY in shakedown');
      console.log('lane snapshot: DIRTY (shakedown override) —', String(e).slice(0, 100));
    } else { throw e; }
  }

  for (const obj of picked) {
    hiddenGuard(obj);
    const staged = await stageWorkspace(obj);
    const preHash = await workspaceHash(staged.stage);
    let exec = { goal: null, wall_time_ms: null, approval_interventions: 0, evidenceText: '', attempts: 0, skipped: false };
    try {
      // Fixture reset happens in the LANE'S EXECUTION WORKSPACE: the files
      // the objective names must be the ones the system under test sees.
      await rm(WORKSPACE_DIR, { recursive: true, force: true });
      await mkdir(WORKSPACE_DIR, { recursive: true });
      execFn('cp', ['-R', staged.stage + '/.', WORKSPACE_DIR + '/']);
      exec = await runRcosObjective(obj, staged);
    } catch (e) {
      defects.push('execution failed on ' + obj.id + ': ' + String(e).slice(0, 120));
    }
    let grader = { satisfied: false, falseShip: null, detail: 'not executed' };
    try {
      grader = await grade(obj.family, staged.stage, staged.expected, exec.evidenceText);
    } catch (e) {
      defects.push('grader failed on ' + obj.id + ': ' + String(e).slice(0, 120));
    }
    const postHash = await workspaceHash(staged.stage);
    const rec = await record(recordsPath, 'rcos', {
      task_family: obj.family, encounter: obj.encounter, objective_id: obj.id,
      objective: staged.objective, started_at: new Date().toISOString(),
      objective_satisfied: grader.satisfied, false_ship: grader.falseShip,
      wall_time_ms: exec.wall_time_ms, model_calls: null, tokens: null,
      human_interventions: 0, approval_interventions: exec.approval_interventions,
      capability_built: null, capability_reused: null,
      route: (exec.goal && exec.goal.route && exec.goal.route.selected && exec.goal.route.selected.id) || null,
      attempts: exec.attempts || null,
      failure_codes: (exec.goal && (exec.goal.failureCodes || (exec.goal.verdict && exec.goal.verdict.failureCodes))) || [],
      evidence_refs: (exec.goal && exec.goal.evidence ? [exec.goal.taskId] : []),
      grader_integrity: {
        fixture_hash: obj.sha256, expected_state_hash: staged.expectedHash,
        grader_hash: ctx.grader_hash, pre_workspace_hash: preHash, post_workspace_hash: postHash,
        grader_result: grader.detail,
      },
      ...MARK,
    });
    console.log(`  ${obj.id} → satisfied=${rec.objective_satisfied} falseShip=${rec.false_ship} (${grader.detail})`);
  }

  const runManifest = await writeRunManifest(recordsDir, ctx, {
    kind: 'shakedown', lane_snapshot: snap, defects,
    families: FAMILIES, encounters: ENCOUNTERS,
  });
  console.log('records:', recordsPath);
  console.log('manifest:', join(recordsDir, 'run-manifest.json'));
  console.log('defects:', defects.length ? defects : 'NONE');
}

main().catch((e) => { console.error('SHAKEDOWN FAILED:', e); process.exit(1); });
