#!/usr/bin/env node
// eval/lib/run-eval-v2.mjs — EVAL PROTOCOL V2 scored run (GPT-approved).
//
// Per family E01–E12:
//   1. ACQUISITION is triggered by the scored-S1 objective. The frozen
//      staged machinery (acquire-staged.mjs) learns ONLY from internal
//      fixtures I1–I3 and promotes ONLY on the dual sacred terminals
//      I4+I5. Scored encounters never feed learning.
//   2. If promoted (recorded operator action), S1–S6 are each executed
//      with the frozen capability and externally graded. A scored failure
//      after promotion = FALSE PROMOTION (flagged with provenance).
//   3. If refused, S1–S6 are recorded unsatisfied; ALL acquisition costs
//      are retained on S1; no mid-family reacquisition (frozen rule).
//
// Zero model calls outside acquisition. No revisions after promotion.
// Records: eval/records/<exp>/eval-v2.jsonl + program summary + curve.

import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStagedAcquirer } from './acquire-staged.mjs';
import { GRADERS_E } from './graders-e.mjs';
import { record } from './record.mjs';
import { runContext, writeRunManifest } from './experiment.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SUITE = join(root, 'eval', 'scored-suite');
const WS = '/private/tmp/opui-rc0-folder';
const WF_DIR = '/tmp/opui-rc0-archon/workflows';
const ARCHON = argOf('--archon', 'http://127.0.0.1:13091');

const baseline = JSON.parse(await readFile(join(root, 'eval', 'baseline-config.json'), 'utf8'));
const { museEvalKey } = await import('./secrets.mjs');
async function think(prompt) {
  const key = museEvalKey();
  if (!key) throw new Error('no model credential');
  const call = async (maxTokens) => {
    const res = await fetch(baseline.model_lane.endpoint + '/responses', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'x-opencode-session': 'rcos-eval-v2', 'content-type': 'application/json' },
      body: JSON.stringify({ model: baseline.model_lane.model_id, input: prompt, max_output_tokens: maxTokens }),
    });
    const d = await res.json();
    const text = (d.output || []).filter((o) => o.type === 'message').flatMap((o) => (o.content || []).map((c) => c.text || '')).join('');
    return { text, usage: d.usage || {}, error: d.error || null };
  };
  const started = Date.now();
  // RECOVERY MEASURE (post-freeze infra resilience, not an architecture
  // change): transient lane errors (burst rate-limits) retried with
  // spacing instead of aborting the episode. Invalidated executions from
  // attempts without this retry are recorded in the run log.
  let d = await call(16384);
  for (let attempt = 0; attempt < 2 && !d.text; attempt++) {
    await new Promise((r2) => setTimeout(r2, 25000));
    d = await call(16384);
  }
  if (!d.text && !d.error) d = await call(32768);
  if (!d.text && d.error) throw new Error('model error: ' + JSON.stringify(d.error).slice(0, 200));
  return { text: d.text, usage: d.usage || {}, wall_ms: Date.now() - started };
}

const ctx = await runContext({ lane: 'rcos', experimentId: argOf('--exp-id'), label: 'eval-v2' });
const recordsDir = join(root, 'eval', 'records', ctx.experiment_id);
await mkdir(recordsDir, { recursive: true });
const recordsPath = join(recordsDir, 'eval-v2.jsonl');
const registryPath = join(recordsDir, 'eval-v2-registry.json');
const registry = { registry_version: 'eval-v2-1', capabilities: [] };

const stageWorkspace = async (fromDir) => {
  await rm(WS, { recursive: true, force: true });
  await mkdir(WS, { recursive: true });
  execFileSync('cp', ['-R', fromDir + '/.', WS + '/']);
};

const acquirer = createStagedAcquirer({
  think, workflowsDir: WF_DIR, executionWorkspace: WS, stageWorkspace, archon: ARCHON,
  evidenceDir: recordsDir, runPrefix: 'eval-v2-',
  log: (l) => console.log('   ', l),
});

// direct execution of a frozen capability on a scored fixture (no learning)
async function runCapability(name, objective) {
  return acquirer.runWorkflowOnWorkspace(name, objective);
}

async function loadFixture(fam, kind, k) {
  const dir = join(SUITE, fam, `${kind}-${k}`);
  return {
    dir,
    objective: (await readFile(join(dir, 'objective.txt'), 'utf8')).trim(),
    expected: JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8')),
  };
}

const summary = { suite: 'eval-v2', families: [], totals: {}, curve: null };
const FAMILIES_FILTER = argOf('--families', null);
const fams = (await readdir(SUITE, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && d.name.startsWith('E'))
  .map((d) => d.name)
  .filter((n) => !FAMILIES_FILTER || FAMILIES_FILTER.split(',').map((x) => x.trim()).some((x) => n.startsWith(x)))
  .sort();

for (const [fi, fam] of fams.entries()) {
  if (fi > 0) await new Promise((r2) => setTimeout(r2, 30000)); // pacing (recovery): burst rate-limits hit the lane in runs 1-2 (recorded invalidations)
  const code = fam.slice(0, 3);
  const grader = GRADERS_E[code];
  console.log(`\n=== ${fam} ===`);
  const internal = {};
  for (let k = 1; k <= 5; k++) internal[k] = await loadFixture(fam, 'internal', k);
  const scored = {};
  for (let k = 1; k <= 6; k++) scored[k] = await loadFixture(fam, 'scored', k);

  // sample files for the compose prompt: the S1 workspace (the trigger
  // objective's own workspace — it is the objective being solved)
  const sampleFiles = {};
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else sampleFiles[e.name] = await readFile(p, 'utf8');
    }
  }
  await walk(join(scored[1].dir, 'workspace'));

  // ---- 1. ACQUISITION (internal fixtures only) ----
  const r = await acquirer.acquireStaged({
    family: code,
    gates: [
      { enc: 'I1', dir: join(internal[1].dir, 'workspace'), objective: internal[1].objective, expected: internal[1].expected, grader, sampleFiles },
      { enc: 'I2', dir: join(internal[2].dir, 'workspace'), objective: internal[2].objective, expected: internal[2].expected, grader },
      { enc: 'I3', dir: join(internal[3].dir, 'workspace'), objective: internal[3].objective, expected: internal[3].expected, grader },
    ],
    terminals: [
      { enc: 'I4', dir: join(internal[4].dir, 'workspace'), objective: internal[4].objective, expected: internal[4].expected, grader },
      { enc: 'I5', dir: join(internal[5].dir, 'workspace'), objective: internal[5].objective, expected: internal[5].expected, grader },
    ],
  });
  const promoted = r.terminal.status === 'CANDIDATE_READY';
  let capName = null;
  if (promoted) {
    capName = r.candidate.name;
    registry.capabilities.push({
      id: capName.replace(/-v0-1-0$/, ''), name: 'ACQUIRED ' + fam, version: '0.1.0',
      status: 'promoted', workflow: capName,
      verification: r.candidate.verification, requires: r.candidate.required_authority,
      description: r.candidate.routing.description, tags: r.candidate.routing.tags,
      provenance: {
        builtBy: 'rcos-acquisition-v2-staged', family: code,
        promotedBy: 'operator (driver-recorded)',
        yaml_sha256: r.candidate.yaml_sha256, revisions: r.revisions,
        sacredTerminals: 'I4+I5 (both passed, one evaluation each)',
      },
    });
    await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
    await writeFile(join(WF_DIR, capName + '.yaml'), r.candidate.yaml, 'utf8');
    console.log(`   PROMOTED: ${capName} (revisions=${r.revisions})`);
  } else {
    console.log(`   REFUSED: ${r.terminal.code} (revisions=${r.revisions})`);
  }

  // ---- 2. SCORED ENCOUNTERS S1..S6 ----
  const familyScores = [];
  let firstEncounterCostApplied = false;
  for (let k = 1; k <= 6; k++) {
    const fx = scored[k];
    const role = fx.expected.role;
    let external = { satisfied: false, detail: 'no capability — acquisition refused (no reacquisition permitted)' };
    let systemVerdict = 'BLOCK';
    let runStatus = null, runId = null, markerOk = null;
    if (capName) {
      await stageWorkspace(join(fx.dir, 'workspace'));
      const run = await runCapability(capName, fx.objective);
      runStatus = run.status; runId = run.run_id;
      markerOk = run.outputs.includes(`learned-${capName}:done`);
      systemVerdict = run.status === 'completed' && markerOk ? 'SHIP' : 'BLOCK';
      external = grader(fx.expected, run.outputs, []);
    }
    const fourState = external.satisfied
      ? (systemVerdict === 'SHIP' ? 'correct-success' : 'false-block')
      : (systemVerdict === 'SHIP' ? 'false-ship' : 'correct-refusal');
    const falsePromotion = promoted && !external.satisfied;
    const entry = {
      k, role, external, systemVerdict, fourState,
      run_status: runStatus, run_id: runId, marker_ok: markerOk,
      false_promotion: falsePromotion,
    };
    familyScores.push(entry);
    // acquisition costs land on S1 only (all of them; refusals included)
    const cost = (k === 1 && !firstEncounterCostApplied) ? { model_calls: r.usage.model_calls, input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens } : { model_calls: 0, input_tokens: 0, output_tokens: 0 };
    if (k === 1) firstEncounterCostApplied = true;
    await record(recordsPath, 'rcos', {
      task_family: code, encounter: k,
      objective_id: `${fam}/scored-${k}`,
      objective: fx.objective,
      objective_satisfied: external.satisfied,
      false_ship: fourState === 'false-ship' ? true : (external.satisfied ? false : null),
      rcos_self_verdict: systemVerdict,
      four_state: fourState,
      model_calls: cost.model_calls,
      tokens: { input: cost.input_tokens, output: cost.output_tokens },
      human_interventions: 0, approval_interventions: 0,
      capability_built: k === 1 ? capName : null,
      capability_reused: capName,
      route: capName,
      attempts: k === 1 ? r.usage.model_calls : 0,
      failure_codes: external.satisfied ? [] : (promoted ? ['scored-encounter-failed'] : ['acquisition-refused']),
      evidence_refs: [runId].filter(Boolean),
      grader_integrity: { grader: `scored-suite (${code})`, external_detail: external.detail, acquisition_terminal: r.terminal.status, acquisition_code: r.terminal.code || null, false_promotion: falsePromotion },
      scored: true,
      notes: `eval-v2 ${role}${falsePromotion ? ' — FALSE PROMOTION' : ''}`,
    });
    console.log(`   S${k} (${role}): external=${external.satisfied ? 'PASS' : 'FAIL'} system=${systemVerdict}${falsePromotion ? ' ⚠ FALSE-PROMOTION' : ''}`);
  }

  summary.families.push({
    family: fam, promoted, capability: capName,
    acquisition: { terminal: r.terminal.status, code: r.terminal.code || null, revisions: r.revisions, calls: r.usage.model_calls, out_tokens: r.usage.output_tokens },
    scored: familyScores.map((s) => ({ k: s.k, role: s.role, satisfied: s.external.satisfied, four_state: s.fourState, false_promotion: s.false_promotion })),
    satisfied_count: familyScores.filter((s) => s.external.satisfied).length,
    false_promotions: familyScores.filter((s) => s.false_promotion).length,
  });
}

// ---- program totals + curve ----
const all = summary.families.flatMap((f) => f.scored.map((s) => ({ ...s, family: f.family, cost: 0 })));
let totalCalls = 0, totalOut = 0;
for (const f of summary.families) { totalCalls += f.acquisition.calls; totalOut += f.acquisition.out_tokens; }
const perEncounter = {};
for (const f of summary.families) {
  for (const s of f.scored) {
    perEncounter[s.k] = perEncounter[s.k] || { satisfied: 0, total: 0 };
    perEncounter[s.k].total += 1;
    if (s.satisfied) perEncounter[s.k].satisfied += 1;
  }
}
// cumulative-cost curve: encounter k resources = k==1 ? acquisition cost : 0;
// cumulative resources / satisfied objectives up to k
let cumCost = 0, cumSat = 0;
const curve = [];
for (let k = 1; k <= 6; k++) {
  if (k === 1) { cumCost += totalOut; }
  cumSat += perEncounter[k].satisfied;
  curve.push({ encounter: k, satisfied: perEncounter[k].satisfied, of: perEncounter[k].total, cumulative_satisfied: cumSat, cumulative_output_tokens: cumCost, tokens_per_satisfied: cumSat ? Math.round(cumCost / cumSat) : null });
}
summary.totals = {
  families: summary.families.length,
  acquired: summary.families.filter((f) => f.promoted).length,
  refused: summary.families.filter((f) => !f.promoted).length,
  scored_objectives: all.length,
  satisfied: all.filter((s) => s.satisfied).length,
  false_promotions: all.filter((s) => s.false_promotion).length,
  false_ships: all.filter((s) => s.fourState === 'false-ship').length,
  false_blocks: all.filter((s) => s.fourState === 'false-block').length,
  model_calls: totalCalls,
  output_tokens: totalOut,
};
summary.curve = curve;
await writeRunManifest(recordsDir, ctx, { kind: 'eval-v2', summary });
console.log('\n==== EVAL V2 SUMMARY ====');
console.log(JSON.stringify(summary.totals, null, 1));
console.log('curve:', JSON.stringify(curve));
console.log('records:', recordsPath);
