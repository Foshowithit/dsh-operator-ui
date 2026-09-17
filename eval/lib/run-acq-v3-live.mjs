#!/usr/bin/env node
// eval/lib/run-acq-v3-live.mjs — the staged-gate revision experiment
// (GPT's authorized option (b) with the development-set rule):
//
//   E1 admission → E2 diagnostic/revision → E3 regression → E4 sacred
//   terminal. Failures on E1–E3 drive ≤3 GLOBAL revisions from redacted
//   evidence (category + own outputs, never expected values); after each
//   revision the candidate re-earns all gates. E4: exactly one terminal
//   evaluation; PASS permits promotion, FAIL refuses the episode.
//
// Suite: eval/devsuite-v4 (frozen pre-run). Machinery frozen: graders,
// static validator, contracts, promotion criteria. Architecture
// experiment per GPT — tiny sample, not a general acquisition rate.

import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStagedAcquirer } from './acquire-staged.mjs';
import { D01, D02, D03, D04 } from './devsuite-graders.mjs';
import { GRADERS_V2 } from './graders-v2.mjs';
import { record } from './record.mjs';
import { runContext, writeRunManifest } from './experiment.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SUITE = argOf('--suite', 'devsuite-v4');
const DEV = join(root, 'eval', SUITE);
const WS = '/private/tmp/opui-rc0-folder';
const WF_DIR = '/tmp/opui-rc0-archon/workflows';
const FAMILIES = argOf('--families', null)
  ? argOf('--families').split(',').map((s) => s.trim()).filter(Boolean)
  : (await readdir(DEV)).filter((d) => /^D\d+/.test(d)).sort();

const baseline = JSON.parse(await readFile(join(root, 'eval', 'baseline-config.json'), 'utf8'));
const { museEvalKey } = await import('./secrets.mjs');
async function think(prompt) {
  const key = museEvalKey();
  if (!key) throw new Error('no model credential (set MUSE_EVAL_KEY or RCOS_VAULT_DIR)');
  const call = async (maxTokens) => {
    const res = await fetch(baseline.model_lane.endpoint + '/responses', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'x-opencode-session': 'rcos-acq-v3', 'content-type': 'application/json' },
      body: JSON.stringify({ model: baseline.model_lane.model_id, input: prompt, max_output_tokens: maxTokens }),
    });
    const d = await res.json();
    const text = (d.output || []).filter((o) => o.type === 'message').flatMap((o) => (o.content || []).map((c) => c.text || '')).join('');
    return { text, usage: d.usage || {}, error: d.error || null };
  };
  const started = Date.now();
  let d = await call(16384);
  if (!d.text && !d.error) d = await call(32768);
  if (!d.text && d.error) throw new Error('model error: ' + JSON.stringify(d.error).slice(0, 200));
  return { text: d.text, usage: d.usage || {}, wall_ms: Date.now() - started };
}

const ctx = await runContext({ lane: 'rcos', experimentId: argOf('--exp-id'), label: 'acq-v3-staged' });
const recordsDir = join(root, 'eval', 'records', ctx.experiment_id);
await mkdir(recordsDir, { recursive: true });
const recordsPath = join(recordsDir, 'acq-v3.jsonl');
const registryPath = join(recordsDir, 'acq-v3-registry.json');
const registry = { registry_version: 'acq-v3-1', capabilities: [] };

const stageWorkspace = async (fromDir) => {
  await rm(WS, { recursive: true, force: true });
  await mkdir(WS, { recursive: true });
  execFileSync('cp', ['-R', fromDir + '/.', WS + '/']);
};

const GRADERS = { D01, D02, D03, D04, ...GRADERS_V2 };
const acquirer = createStagedAcquirer({
  think, workflowsDir: WF_DIR, executionWorkspace: WS, stageWorkspace,
  archon: argOf('--archon', 'http://127.0.0.1:13091'),
  evidenceDir: recordsDir,
  log: (l) => console.log('  ', l),
});

async function loadEnc(fam, enc) {
  const dir = join(DEV, fam, enc);
  return {
    dir,
    objective: (await readFile(join(dir, 'objective.txt'), 'utf8')).trim(),
    expected: JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8')),
  };
}

const summary = { suite: SUITE, families: [], totals: { acquired: 0, refused: 0, model_calls: 0, input_tokens: 0, output_tokens: 0, wall_ms: 0 } };

for (const fam of FAMILIES) {
  const code = fam.slice(0, 3);
  const grader = GRADERS[code];
  if (!grader) { console.log(fam + ': no grader — skipped'); continue; }
  console.log(`\n=== ${fam} ===`);
  const e1 = await loadEnc(fam, 'encounter-1');
  const e2 = await loadEnc(fam, 'encounter-2');
  const e3 = await loadEnc(fam, 'encounter-3');
  const e4 = await loadEnc(fam, 'encounter-4');
  const e5 = await loadEnc(fam, 'encounter-5');

  const sampleFiles = {};
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else sampleFiles[e.name] = await readFile(p, 'utf8');
    }
  }
  await walk(e1.dir + '/workspace');

  const mkGate = (label, enc) => ({ enc: label, dir: enc.dir + '/workspace', objective: enc.objective, expected: enc.expected, grader });
  const r = await acquirer.acquireStaged({
    family: code,
    gates: [
      { ...mkGate('E1', e1), sampleFiles },
      mkGate('E2', e2),
      mkGate('E3', e3),
    ],
    terminals: [mkGate('E4a', e4), mkGate('E4b', e5)],
  });

  summary.totals.model_calls += r.usage.model_calls;
  summary.totals.input_tokens += r.usage.input_tokens;
  summary.totals.output_tokens += r.usage.output_tokens;
  summary.totals.wall_ms += r.usage.wall_ms;

  let outcome;
  if (r.terminal.status === 'CANDIDATE_READY') {
    outcome = 'acquired';
    summary.totals.acquired += 1;
    const cap = {
      id: r.candidate.name.replace(/-v0-1-0$/, ''),
      name: 'LEARNED ' + fam, kind: 'workflow', version: '0.1.0',
      status: 'promoted', workflow: r.candidate.name,
      requires: r.candidate.required_authority,
      verification: r.candidate.verification,
      description: r.candidate.routing.description,
      tags: r.candidate.routing.tags,
      provenance: {
        builtBy: 'rcos-acquisition-v3-staged', family: fam,
        teachingModel: baseline.model_lane.model_id,
        promotedBy: 'operator (driver-recorded)',
        yaml_sha256: r.candidate.yaml_sha256,
        revisions: r.revisions,
        terminalGates: 'E4a + E4b (sacred, one evaluation each, both required) ',
      },
    };
    registry.capabilities.push(cap);
    await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
    await writeFile(join(WF_DIR, r.candidate.name + '.yaml'), r.candidate.yaml, 'utf8');
  } else {
    outcome = 'refused:' + r.terminal.code;
    summary.totals.refused += 1;
  }

  // progression chain: ordered attempt trail with attempt TYPES
  // (compose / revision / gate-run) — revision records are not gate passes.
  const chain = [];
  for (const a of r.attempts) {
    if (a.gate === 'compose') chain.push({ rev: a.rev, kind: 'compose', verdict: a.failureKind ? 'FAIL:' + a.failureKind : 'ok' });
    else if (a.gate === 'static') chain.push({ rev: a.rev, kind: 'static-fail', verdict: 'FAIL:' + (a.staticFailures || []).map((f) => f.code).join(',') });
    else if (a.failureKind === 'parse') chain.push({ rev: a.rev, kind: 'parse-fail', verdict: 'FAIL' });
    else if (!a.run) chain.push({ rev: a.rev, kind: 'revision', verdict: a.failureKind ? 'FAIL:' + a.failureKind : 'ok' });
    else chain.push({ rev: a.rev, kind: 'gate-run', gate: a.gate, verdict: a.failureKind ? 'FAIL' : 'PASS', category: a.graderCategory || null });
  }

  await record(recordsPath, 'rcos', {
    task_family: code, encounter: 1,
    objective_id: fam + '/staged-episode',
    objective: e1.objective,
    objective_satisfied: r.terminal.status === 'CANDIDATE_READY',
    false_ship: r.terminal.status === 'CANDIDATE_READY' ? false : null,
    rcos_self_verdict: r.terminal.status,
    four_state: r.terminal.status === 'CANDIDATE_READY' ? 'correct-success' : 'correct-refusal',
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
      grader: 'devsuite-v1 contracts (frozen ' + code + '), suite ' + SUITE,
      progression_chain: chain,
      attempts_trail: r.attempts.map((a) => ({ rev: a.rev, gate: a.gate, failure: a.failureKind, grader: a.grader?.detail || null, static_codes: (a.staticFailures || []).map((f) => f.code), run_id: a.run?.run_id || null })),
    },
    scored: false,
    notes: 'acquisition v3 staged: ' + outcome,
  });

  summary.families.push({
    family: fam, outcome,
    revisions: r.revisions,
    attempts: r.usage.model_calls,
    input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens,
    workflow: r.terminal.status === 'CANDIDATE_READY' ? r.candidate.name : null,
    chain,
    refusal: r.terminal.status === 'REFUSED' ? r.terminal : null,
  });
  console.log(`${fam}: ${outcome.toUpperCase()} (revisions=${r.revisions}, calls=${r.usage.model_calls})`);
}

await writeRunManifest(recordsDir, ctx, { kind: 'acq-v3-staged', families: FAMILIES, summary });
console.log('\n==== ACQ-V3 STAGED SUMMARY ====');
console.log(JSON.stringify(summary, null, 1));
console.log('records:', recordsPath);
