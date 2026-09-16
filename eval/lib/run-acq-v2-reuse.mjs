#!/usr/bin/env node
// eval/lib/run-acq-v2-reuse.mjs — the REUSE leg of M3.2: an acquired
// capability (CANDIDATE_READY + recorded operator promotion from a live
// acquisition run) is installed into a lane registry, and the RCOS goal
// pipeline must route LATER objectives to it, execute it on Archon, and
// independently grade the results — acquire → evaluate → promote → REUSE.
//
// Uses the DEV lane only (:8412); the scored lane stays sealed. The lane's
// registry is a fresh file (example fixture + the acquired capability), so
// the repo fixture stays pristine. The lane config is pointed at it — this
// IS the recorded operator promotion on the dev installation.

import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { record } from './record.mjs';
import { runContext, writeRunManifest } from './experiment.mjs';
import { D03 } from './devsuite-graders.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const LANE = argOf('--lane', 'http://127.0.0.1:8412');
const LANE_HOME = argOf('--lane-home', '/tmp/opui-m1-home');
const SOURCE_EXP = argOf('--source-exp', 'exp-7f1c3390');          // live run whose registry holds the acquired capability
const FAMILY_DIR = argOf('--family', 'D03-domain-tally');
const ARCHON_WORKSPACE = argOf('--workspace-dir', '/private/tmp/opui-rc0-folder');

const ctx = await runContext({ lane: 'rcos', experimentId: argOf('--exp-id'), label: 'acq-v2-reuse' });
const recordsDir = join(root, 'eval', 'records', ctx.experiment_id);

// 1. Install: example fixture registry + the acquired capability.
const srcRegistry = JSON.parse(await readFile(join(root, 'eval', 'records', SOURCE_EXP, 'acq-v2-registry.json'), 'utf8'));
if (!(srcRegistry.capabilities || []).length) throw new Error('source registry has no acquired capabilities');
const fixture = JSON.parse(await readFile(join(root, 'fixtures', 'capability-registry.example.json'), 'utf8'));
const devRegistry = {
  ...fixture,
  registry_version: 'dev-acq-v2-1',
  _note: 'DEV lane registry: example fixture + acquisition-v2 acquired capability (recorded operator promotion; provenance intact).',
  capabilities: [...fixture.capabilities, ...srcRegistry.capabilities],
};
const devRegPath = join(LANE_HOME, 'operator-ui', 'dev-registry.json');
await writeFile(devRegPath, JSON.stringify(devRegistry, null, 2) + '\n', 'utf8');

const cfgPath = join(LANE_HOME, 'operator-ui.config.json');
const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
const prevRegPath = (cfg.registry || {}).path;
cfg.registry = { path: devRegPath };
await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('registry installed:', devRegPath, '(was:', prevRegPath + ')');
const cap = srcRegistry.capabilities[0];
console.log('acquired capability:', cap.id, '→ workflow', cap.workflow);

// 2. Reuse: route each held-out objective through the goal pipeline.
async function stageWorkspace(fromDir) {
  execFileSync('rm', ['-rf', ARCHON_WORKSPACE]);
  execFileSync('mkdir', ['-p', ARCHON_WORKSPACE]);
  execFileSync('cp', ['-R', fromDir + '/.', ARCHON_WORKSPACE + '/']);
}

const summary = { source_exp: SOURCE_EXP, capability: cap.id, encounters: [] };
for (const enc of ['encounter-2', 'encounter-3']) {
  const dir = join(root, 'eval', 'devsuite', FAMILY_DIR, enc);
  const objective = (await readFile(join(dir, 'objective.txt'), 'utf8')).trim();
  const expected = JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8'));
  await stageWorkspace(dir + '/workspace');
  console.log(`\n=== ${enc}: ${objective.slice(0, 80)}...`);

  let g = {};
  const started = Date.now();
  for (let pass = 1; pass <= 2; pass++) {
    const body = pass === 1 ? { objective } : { approveTaskId: g.taskId };
    const res = await fetch(LANE + '/plugins/operator-ui/goal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    g = (await res.json()).goal || g;
    const codes = new Set(g.failureCodes || (g.verdict && g.verdict.failureCodes) || []);
    if (pass === 1 && codes.has('awaiting-approval')) continue; // approve on pass 2
    break;
  }
  const wall = Date.now() - started;
  const v = typeof g.verdict === 'string' ? g.verdict : (g.verdict && g.verdict.decision) || null;
  const evidence = ((g.evidence || {}).outputs || []).join('\n');
  const route = g.route?.selected?.id || null;
  const gr = D03(expected, evidence);
  console.log(`route=${route} verdict=${v} | external grader: ${gr.satisfied ? 'PASS' : 'FAIL'} (${gr.detail})`);

  await record(join(recordsDir, 'acq-v2-reuse.jsonl'), 'rcos', {
    task_family: 'D03', encounter: enc === 'encounter-2' ? 2 : 3,
    objective_id: FAMILY_DIR + '/' + enc,
    objective,
    objective_satisfied: gr.satisfied,
    false_ship: gr.satisfied && v !== 'SHIP' ? true : (!gr.satisfied && v === 'SHIP' ? true : false),
    rcos_self_verdict: v,
    four_state: gr.satisfied ? (v === 'SHIP' ? 'correct-success' : 'false-block') : (v === 'SHIP' ? 'false-ship' : 'correct-refusal'),
    wall_time_ms: wall,
    human_interventions: 0,
    approval_interventions: (g.failureCodes || []).includes('awaiting-approval') ? 1 : 0,
    capability_reused: route,
    route,
    attempts: 1,
    failure_codes: g.failureCodes || [],
    evidence_refs: [g.taskId].filter(Boolean),
    grader_integrity: { grader: 'devsuite-v1 (frozen D03)', detail: gr.detail },
    scored: false,
    notes: 'acquisition v2 REUSE via goal pipeline (dev lane)',
  });
  summary.encounters.push({ enc, route, verdict: v, satisfied: gr.satisfied, detail: gr.detail });
}

await writeRunManifest(recordsDir, ctx, { kind: 'acq-v2-reuse', summary });
console.log('\n==== REUSE SUMMARY ====');
console.log(JSON.stringify(summary, null, 1));
console.log('records:', join(recordsDir, 'acq-v2-reuse.jsonl'));
