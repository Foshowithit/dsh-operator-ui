#!/usr/bin/env node
// eval/lib/run-dsh-lane.mjs — the DSH lane of Eval Protocol v1.
//
// "DSH gets DSH" (GPT fairness constraint): the NORMAL DSH agent loop —
// `dsh --profile headless "<objective>"` with cwd = the staged fixture
// workspace — no RCOS routing/workflows/memory/teach machinery, nothing
// removed that DSH ordinarily has. One objective per invocation.
//
// Baseline parity: eval/baseline-config.json records the frozen environment
// (versions, model identity/params, profile hash, tool inventory, hardware,
// config hashes, corpus + grader hashes). The runner REFUSES to start if it
// is absent — parity is a precondition, not a snapshot afterwards.

import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { record, grade } from './record.mjs';
import { runContext, snapshotDshLane, writeRunManifest, assertParity, assertBaselineFresh, observeLive } from './experiment.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256s = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DSH_BIN = argOf('--dsh-bin', '/Users/adam26/.npm/_npx/6c7f445d1bf61956/node_modules/.bin/dsh');
const LANE_HOME = argOf('--lane-home', '/tmp/opui-shakedown-dsh');
const PROFILE = argOf('--profile', 'headless');
const BUDGET_MS = Number(argOf('--budget-ms', 300000));
const FAMILIES = (argOf('--families', 'F09-log-analysis,F08-format-conversion')).split(',');
const ENCOUNTERS = (argOf('--encounters', '1,2')).split(',').map(Number);
const MARK = { scored: false, notes: 'shakedown — instrumentation proof only, NOT performance data' };

const manifest = JSON.parse(await readFile(join(root, 'eval', 'corpus-manifest.json'), 'utf8'));
const baselinePath = join(root, 'eval', 'baseline-config.json');

// The model lane credential is injected as an ENV VAR NAME at spawn time —
// never committed, never printed (protocol: no secrets, ever). The zai
// coding-plan lane is read from the local ZCode config by agreement with
// the owner ("continue" = shakedown-scale authorization; the scored run
// re-confirms the lane before launch).
function laneEnv() {
  const env = { ...process.env, DSH_HOME: LANE_HOME };
  if (baseline.model_lane && baseline.model_lane.credential_source === 'zcode-zai-coding-plan') {
    try {
      const cfg = JSON.parse(readFileSync(join(process.env.HOME, '.zcode', 'v2', 'config.json'), 'utf8'));
      env.ZAI_EVAL_KEY = cfg.provider['builtin:zai-coding-plan'].options.apiKey;
    } catch { /* leave unset — the run will fail auth honestly */ }
  }
  return env;
}

// Parity precondition: the frozen baseline must exist and be complete.
let baseline;
try {
  baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
} catch {
  console.error('REFUSING to run: eval/baseline-config.json missing — freeze the baseline first (node eval/lib/write-baseline.mjs)');
  process.exit(1);
}
for (const k of ['dsh_version', 'model', 'profile', 'hardware', 'profile_config_hash']) {
  if (!baseline[k]) { console.error('REFUSING to run: baseline-config.json missing ' + k); process.exit(1); }
}

const ctx = await runContext({ lane: 'dsh', experimentId: argOf('--exp-id') });

// Parity preflight (GPT), in the prescribed order: runContext →
// assertBaselineFresh → INDEPENDENTLY OBSERVED live state → assertParity.
// The live side is measured from the machine + the lane's resolved config
// files — never echoed from the baseline.
try {
  assertBaselineFresh(baseline, ctx.system_build_sha);
  const live = await observeLive({ laneHome: LANE_HOME, budgetMs: BUDGET_MS, corpusPath: join(root, 'eval', 'corpus-manifest.json') });
  assertParity(baseline, ctx, {
    model_endpoint: live.model_endpoint,
    model_id: live.model_id,
    model_sampling: live.model_sampling,
    hardware: live.hardware,
    corpus_hash: live.corpus_hash,
    budget: live.budget,
    tool_availability: { verdict: 'EQUIVALENT', explained: 'DSH normal agent loop with its built-in tool set' },
  }, { requiresModel: true });
} catch (e) {
  console.error('REFUSING to run: ' + String(e.message).split('\n')[0]);
  process.exit(1);
}

const recordsDir = join(root, 'eval', 'records', ctx.experiment_id);
await mkdir(recordsDir, { recursive: true });
const recordsPath = join(recordsDir, `shakedown-dsh.jsonl`);
const defects = [];

// Fresh clean lane home per run (snapshot BEFORE, per GPT requirement 2).
await rm(LANE_HOME, { recursive: true, force: true });
await mkdir(LANE_HOME, { recursive: true });
// The lane home needs its provider/model settings or DSH falls back to its
// default route (first shakedown caught this: instant MISSING_CREDENTIAL).
await writeFile(join(LANE_HOME, 'settings.yaml'),
  await readFile(join(root, 'eval', 'lib', 'dsh-lane-settings.template.yaml'), 'utf8'), 'utf8');
const snap = await snapshotDshLane({ dshHome: LANE_HOME });

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

const picked = manifest.stream
  .map((id) => manifest.objectives.find((o) => o.id === id))
  .filter((o) => FAMILIES.some((f) => o.id.startsWith(f + '/')) && ENCOUNTERS.includes(o.encounter));
console.log(`shakedown ${ctx.experiment_id} lane=dsh: ${picked.length} objectives (non-scored)`);

for (const obj of picked) {
  if (obj.hidden) throw new Error('shakedown tried to use a HELD-OUT objective: ' + obj.id);
  const src = join(root, 'eval', 'corpus', obj.id, 'workspace');
  const expected = JSON.parse(await readFile(join(root, 'eval', 'corpus', obj.id, 'expected.json'), 'utf8'));
  const objective = (await readFile(join(root, 'eval', 'corpus', obj.id, 'objective.txt'), 'utf8')).trim();
  const stage = join(recordsDir, 'stage', obj.id.replace(/[\/]/g, '__'));
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  execFileSync('cp', ['-R', src + '/.', stage + '/']);
  const preHash = await workspaceHash(stage);

  const started = Date.now();
  let stdout = '', code = 0, timedOut = false;
  try {
    stdout = execFileSync(DSH_BIN, ['--profile', PROFILE, objective], {
      cwd: stage, encoding: 'utf8', timeout: BUDGET_MS,
      env: laneEnv(),
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    if (e.killed) timedOut = true;
    stdout = (e.stdout || '') + String(e.stderr || '').slice(0, 2000);
    code = e.status ?? -1;
  }
  const wall = Date.now() - started;

  let grader = { satisfied: false, falseShip: null, detail: 'no evidence' };
  try {
    grader = await grade(obj.family, stage, expected, stdout);
  } catch (e) {
    defects.push('grader failed on ' + obj.id + ': ' + String(e).slice(0, 120));
  }
  const postHash = await workspaceHash(stage);
  const rec = await record(recordsPath, 'dsh', {
    task_family: obj.family, encounter: obj.encounter, objective_id: obj.id,
    objective, started_at: new Date(started).toISOString(),
    objective_satisfied: grader.satisfied, false_ship: grader.falseShip,
    wall_time_ms: wall, model_calls: null, tokens: null,
    human_interventions: 0, approval_interventions: 0,
    capability_built: null, capability_reused: null, route: 'dsh-headless-loop',
    attempts: 1, failure_codes: timedOut ? ['budget-timeout'] : code === 0 ? [] : ['exit-' + code],
    evidence_refs: ['stdout'],
    grader_integrity: {
      fixture_hash: obj.sha256, expected_state_hash: sha256s(JSON.stringify(expected)),
      grader_hash: ctx.grader_hash, pre_workspace_hash: preHash, post_workspace_hash: postHash,
      grader_result: grader.detail,
    },
    ...MARK,
  });
  console.log(`  ${obj.id} → satisfied=${rec.objective_satisfied} (${grader.detail}) wall=${wall}ms`);
}

const runManifest = await writeRunManifest(recordsDir, ctx, {
  kind: 'shakedown', lane_snapshot: snap, baseline, defects,
  families: FAMILIES, encounters: ENCOUNTERS,
});
console.log('records:', recordsPath);
console.log('defects:', defects.length ? defects : 'NONE');
