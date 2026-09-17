#!/usr/bin/env node
// eval/lib/run-acq-v2-live.mjs — Acquisition v2 LIVE run (M3.1/M3.2): the
// bounded acquire loop with the REAL muse cognition lane, one devsuite
// family at a time. The negative battery (run-acq-v2-battery.mjs) proved
// the rig's fail-safe properties with a stub; this run measures the real
// thing: acquisition success, refusal quality, cost, provenance.
//
// Promotion is an explicit operator action performed by this driver and
// recorded as such — a CANDIDATE_READY terminal is required first (held-out
// gate passed), and the capability lands in the run's registry copy with
// permanent provenance. The v1 corpus stays untouched.

import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAcquirer } from './acquire-v2.mjs';
import { D01, D02, D03, D04 } from './devsuite-graders.mjs';
import { record } from './record.mjs';
import { runContext, writeRunManifest } from './experiment.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SUITE = argOf('--suite', 'devsuite');
const DEV = join(root, 'eval', SUITE);
const WS = '/private/tmp/opui-rc0-folder';          // Archon's real execution workspace
const WF_DIR = '/tmp/opui-rc0-archon/workflows';    // Archon hot-reload dir
const FAMILIES = (argOf('--families', 'D01-threshold-inventory,D02-config-diff,D03-domain-tally,D04-shift-handoff')).split(',').map((s) => s.trim()).filter(Boolean);

// Frozen model lane (baseline-config.json) — responses API + session header.
const baseline = JSON.parse(await readFile(join(root, 'eval', 'baseline-config.json'), 'utf8'));
const { museEvalKey } = await import('./secrets.mjs');
const museKey = () => museEvalKey();
async function think(prompt) {
  const key = museKey();
  if (!key) throw new Error('no model credential (vault opencode-muse-eval.key)');
  const started = Date.now();
  // v2.3: exp-9f93805d D03 died as MODEL_ERROR when the reply consumed the
  // whole 8192-token budget on reasoning and returned no message content.
  // Raise the ceiling and retry once on truncation-empty text.
  const call = async (maxTokens) => {
    const res = await fetch(baseline.model_lane.endpoint + '/responses', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'x-opencode-session': 'rcos-acq-v2', 'content-type': 'application/json' },
      body: JSON.stringify({ model: baseline.model_lane.model_id, input: prompt, max_output_tokens: maxTokens }),
    });
    const d = await res.json();
    const text = (d.output || []).filter((o) => o.type === 'message').flatMap((o) => (o.content || []).map((c) => c.text || '')).join('');
    return { text, usage: d.usage || {}, error: d.error || null };
  };
  let d = await call(16384);
  if (!d.text && !d.error) d = await call(32768);
  if (!d.text && d.error) throw new Error('model error: ' + JSON.stringify(d.error).slice(0, 200));
  return { text: d.text, usage: d.usage || {}, wall_ms: Date.now() - started };
}

const ctx = await runContext({ lane: 'rcos', experimentId: argOf('--exp-id'), label: 'acq-v2' });
const recordsDir = join(root, 'eval', 'records', ctx.experiment_id);
await mkdir(recordsDir, { recursive: true });
const recordsPath = join(recordsDir, 'acq-v2.jsonl');
const registryPath = join(recordsDir, 'acq-v2-registry.json');
const registry = { registry_version: 'acq-v2-1', capabilities: [] };

const stageWorkspace = async (fromDir) => {
  await rm(WS, { recursive: true, force: true });
  await mkdir(WS, { recursive: true });
  execFileSync('cp', ['-R', fromDir + '/.', WS + '/']);
};

const GRADERS = { D01, D02, D03, D04 };

const SINGLE_SHOT = args.includes('--single-shot');
const acquirer = createAcquirer({
  think, workflowsDir: WF_DIR, executionWorkspace: WS, stageWorkspace,
  evidenceDir: recordsDir,
  budget: SINGLE_SHOT ? { maxAttempts: 1, maxOutputTokens: 50000, maxWallMs: 600000, maxRevisions: 0 } : undefined,
  log: (l) => console.log('  ', l),
});
if (SINGLE_SHOT) console.log('SINGLE-SHOT mode: one candidate per family, no revision — GPT baseline order');

const summary = { families: [], totals: { acquired: 0, refused: 0, model_calls: 0, input_tokens: 0, output_tokens: 0, wall_ms: 0 } };

for (const fam of FAMILIES) {
  const code = fam.slice(0, 3);
  const grader = GRADERS[code];
  if (!grader) { console.log(fam + ': no grader — skipped'); continue; }
  console.log(`\n=== ${fam} ===`);
  const enc = {};
  for (const e of ['encounter-1', 'encounter-2', 'encounter-3']) {
    const dir = join(DEV, fam, e);
    enc[e] = {
      dir,
      objective: (await readFile(join(dir, 'objective.txt'), 'utf8')).trim(),
      expected: JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8')),
    };
  }
  const sampleFiles = {};
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else sampleFiles[e.name] = await readFile(p, 'utf8');
    }
  }
  await walk(enc['encounter-1'].dir + '/workspace');

  const r = await acquirer.acquire({
    objective: enc['encounter-1'].objective,
    family: code,
    sampleFiles,
    admittingDir: enc['encounter-1'].dir + '/workspace',
    expected: enc['encounter-1'].expected,
    grader,
    heldOut: [
      { dir: enc['encounter-2'].dir + '/workspace', expected: enc['encounter-2'].expected, objective: enc['encounter-2'].objective },
      { dir: enc['encounter-3'].dir + '/workspace', expected: enc['encounter-3'].expected, objective: enc['encounter-3'].objective },
    ],
  });

  summary.totals.model_calls += r.usage.model_calls;
  summary.totals.input_tokens += r.usage.input_tokens;
  summary.totals.output_tokens += r.usage.output_tokens;
  summary.totals.wall_ms += r.usage.wall_ms;

  let outcome, satisfied = false, falseShip = null;
  if (r.terminal.status === 'CANDIDATE_READY') {
    outcome = 'acquired';
    satisfied = true; falseShip = false;
    summary.totals.acquired += 1;
    // Explicit promotion (operator action performed by the driver,
    // recorded as such) into THIS RUN's registry copy.
    const cap = {
      id: r.candidate.name.replace(/-v0-1-0$/, ''),
      name: 'LEARNED ' + fam, kind: 'workflow', version: '0.1.0',
      status: 'promoted', workflow: r.candidate.name,
      requires: r.candidate.required_authority,
      verification: r.candidate.verification,
      description: r.candidate.routing.description,
      tags: r.candidate.routing.tags,
      provenance: {
        builtBy: 'rcos-acquisition-v2', family: fam,
        teachingModel: baseline.model_lane.model_id,
        promotedBy: 'operator (driver-recorded)',
        heldOutResults: r.terminal.heldResults,
        yaml_sha256: r.candidate.yaml_sha256,
        revisions: r.candidate.provenance.revisions,
      },
    };
    registry.capabilities.push(cap);
    await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
    await writeFile(join(WF_DIR, r.candidate.name + '.yaml'), r.candidate.yaml, 'utf8');
  } else {
    outcome = 'refused:' + r.terminal.code;
    summary.totals.refused += 1;
  }

  await record(recordsPath, 'rcos', {
    task_family: code, encounter: 1,
    objective_id: fam + '/encounter-1',
    objective: enc['encounter-1'].objective,
    objective_satisfied: satisfied,
    false_ship: falseShip,
    rcos_self_verdict: r.terminal.status,
    four_state: satisfied ? 'correct-success' : 'correct-refusal',
    wall_time_ms: r.usage.wall_ms,
    model_calls: r.usage.model_calls,
    tokens: { input: r.usage.input_tokens, output: r.usage.output_tokens },
    human_interventions: 0,
    approval_interventions: 0,
    capability_built: r.terminal.status === 'CANDIDATE_READY' ? r.candidate.name : null,
    capability_reused: null,
    route: null,
    attempts: r.usage.model_calls,
    failure_codes: r.terminal.status === 'REFUSED' ? [r.terminal.code] : [],
    evidence_refs: r.attempts.map((a) => a.yaml_sha256).filter(Boolean),
    grader_integrity: {
      grader: 'devsuite-v1 (frozen ' + code + ')',
      held_out_gate: r.terminal.heldResults || null,
      attempts_trail: r.attempts.map((a) => ({ rev: a.rev, kind: a.kind, failure: a.failureKind, grader: a.grader?.detail || null, static_codes: (a.staticFailures || []).map((f) => f.code) })),
    },
    scored: false,
    notes: 'acquisition v2 live: ' + outcome,
  });

  summary.families.push({
    family: fam, outcome,
    attempts: r.usage.model_calls,
    input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens,
    workflow: r.terminal.status === 'CANDIDATE_READY' ? r.candidate.name : null,
    held_out: r.terminal.heldResults || null,
    refusal: r.terminal.status === 'REFUSED' ? r.terminal : null,
  });
  console.log(`${fam}: ${outcome.toUpperCase()} (attempts=${r.usage.model_calls}, out_tokens=${r.usage.output_tokens})`);
}

await writeRunManifest(recordsDir, ctx, { kind: 'acq-v2-live', families: FAMILIES, summary });
console.log('\n==== ACQ-V2 LIVE SUMMARY ====');
console.log(JSON.stringify(summary, null, 1));
console.log('records:', recordsPath);
