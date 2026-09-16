#!/usr/bin/env node
// eval/lib/run-scored.mjs — the 50-task scored experiment (Eval Protocol v1).
//
// GPT-authorized. Runs the FROZEN interleaved stream for both lanes:
//   RCOS lane — goal pipeline on the clean prepared lane; on a gap
//     (no-route / objective-not-satisfied) the normal Teach path attempts
//     acquisition ONCE per family using the frozen muse lane (metered as
//     teaching cost), evaluates the candidate, promotes on pass, then
//     retries the objective once.
//   DSH lane — normal headless agent loop per objective.
//
// Records carry the FOUR-STATE classification (GPT): external truth ×
// RCOS self-verdict → correct-success | false-block | correct-refusal |
// false-ship. The internal evaluator is part of the system under test —
// its false-BLOCKs are measured, never repaired mid-run.
//
// FREEZE: no RCOS/routing/evaluator/Teach/grader/corpus changes are made
// by this script. If something breaks mid-run, the break is recorded and
// the stream continues (or halts with a full record store).

import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRunManifest } from './experiment.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256s = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const LANE = argOf('--lane', 'rcos'); // rcos | dsh
const RCOS_URL = argOf('--rcos', 'http://127.0.0.1:8413');
const LANE_HOME = argOf('--lane-home', '/tmp/opui-scored-rcos');
const DSH_HOME = argOf('--dsh-home', '/tmp/opui-scored-dsh');
const DSH_BIN = argOf('--dsh-bin', '/Users/<redacted>/.npm/_npx/6c7f445d1bf61956/node_modules/.bin/dsh');
const ARCHON_WORKFLOWS = argOf('--workflows-dir', '/tmp/opui-rc0-archon/workflows');
const ARCHON_WORKSPACE = argOf('--workspace-dir', '/private/tmp/opui-rc0-folder');
const ARCHON = argOf('--archon', 'http://127.0.0.1:13091');
const BUDGET_MS = Number(argOf('--budget-ms', 300000));
const MAX_OBJECTIVES = Number(argOf('--max', 50));

const manifest = JSON.parse(await readFile(join(root, 'eval', 'corpus-manifest.json'), 'utf8'));
const baseline = JSON.parse(await readFile(join(root, 'eval', 'baseline-config.json'), 'utf8'));

// Experiment identity (immutable per run).
const { randomUUID } = await import('node:crypto');
const experiment_id = 'scored-' + randomUUID().slice(0, 8);
const protocol_hash = sha256s(await readFile(join(root, 'eval', 'protocol-v1.md'), 'utf8'));
const corpus_hash = sha256s(await readFile(join(root, 'eval', 'corpus-manifest.json'), 'utf8'));
const grader_hash = sha256s(await readFile(join(root, 'eval', 'lib', 'record.mjs'), 'utf8'));
let build_sha = null;
try { build_sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}
const IDENTITY = { experiment_id, protocol_hash, corpus_hash, grader_hash, system_build_sha: build_sha, scored: true };

const recordsDir = join(root, 'eval', 'records', experiment_id);
await mkdir(recordsDir, { recursive: true });
const recordsPath = join(recordsDir, `scored-${LANE}.jsonl`);
const runLog = [];

function logEvent(e) {
  runLog.push({ at: new Date().toISOString(), ...e });
  console.log('LOG:', JSON.stringify(e).slice(0, 200));
}

// Four-state classification (GPT's table).
function fourState(externalSatisfied, selfVerdict) {
  const ship = selfVerdict === 'SHIP';
  if (externalSatisfied && ship) return 'correct-success';
  if (externalSatisfied && !ship) return 'false-block';
  if (!externalSatisfied && !ship) return 'correct-refusal';
  return 'false-ship';
}

async function record(fields) {
  const line = JSON.stringify({ ...IDENTITY, ...fields, scored: fields.scored ?? true }) + '\n';
  const { appendFile } = await import('node:fs/promises');
  await appendFile(recordsPath, line, 'utf8');
}

// ---- fixture staging into the lane execution workspace ----
async function stageFixture(objId) {
  const stage = join(recordsDir, 'stage', objId.replace(/[\/]/g, '__'));
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  execFileSync('cp', ['-R', join(root, 'eval', 'corpus', objId, 'workspace') + '/.', stage + '/']);
  const objective = (await readFile(join(root, 'eval', 'corpus', objId, 'objective.txt'), 'utf8')).trim();
  const expected = JSON.parse(await readFile(join(root, 'eval', 'corpus', objId, 'expected.json'), 'utf8'));
  await rm(ARCHON_WORKSPACE, { recursive: true, force: true });
  await mkdir(ARCHON_WORKSPACE, { recursive: true });
  execFileSync('cp', ['-R', stage + '/.', ARCHON_WORKSPACE + '/']);
  return { stage, objective, expected };
}

// ---- external result-state grading (record.mjs graders + F03/F07 general) ----
async function grade(expected, stage, evidenceText) {
  const fam = expected.family;
  if (fam === 'F08') {
    const body = await readFile(join(stage, 'stock.json'), 'utf8').catch(() => null);
    let arr = null;
    try { arr = JSON.parse(body); } catch {}
    const ok = !!arr && JSON.stringify(arr) === JSON.stringify(expected.json);
    return { satisfied: ok, detail: ok ? 'stock.json correct' : 'stock.json missing/wrong' };
  }
  if (fam === 'F04') {
    const body = await readFile(join(stage, expected.file), 'utf8').catch(() => null);
    const lines = body ? body.replace(/\n+$/, '').split('\n') : null;
    const ok = !!lines && JSON.stringify(lines) === JSON.stringify(expected.sorted);
    return { satisfied: ok, detail: ok ? expected.file + ' correct' : expected.file + ' missing/wrong' };
  }
  if (fam === 'F03') {
    const meta = new Set(['total_pairs', 'status', 'artifact', 'count']);
    const got = [];
    for (const m of evidenceText.matchAll(/RESULT\s+(\S+)=(\d+)/g)) {
      if (!meta.has(m[1]) && m[1].includes('.')) got.push([m[1], m[2]]);
    }
    for (const m of evidenceText.matchAll(/host=(\S+)\s+port=(\d+)/g)) got.push([m[1], m[2]]);
    const want = Object.entries(expected.fields);
    const ok = want.length === got.length && want.every(([h, p], i) => got[i] && got[i][0] === h && got[i][1] === String(p));
    return { satisfied: ok, detail: ok ? 'extraction matches' : `extraction mismatch (want ${want.length}, got ${got.length})` };
  }
  if (fam === 'F01') {
    const m = evidenceText && evidenceText.match(/TOTAL Lines: (\d+) Words: (\d+) Bytes: (\d+)/);
    const t = expected.total;
    const ok = !!m && Number(m[1]) === t.lines && Number(m[2]) === t.words && Number(m[3]) === t.bytes;
    return { satisfied: ok, detail: ok ? 'totals match' : 'totals missing/wrong' };
  }
  if (fam === 'F09') {
    let ok = true;
    for (const lv of ['INFO', 'WARN', 'ERROR']) {
      const m = evidenceText && evidenceText.match(new RegExp(lv + '\\D*(\\d+)'));
      if (!m || Number(m[1]) !== expected.counts[lv]) ok = false;
    }
    return { satisfied: ok, detail: ok ? 'level counts match' : 'level counts missing/wrong' };
  }
  // F02/F05/F06/F07/F10: generic content-word evidence check deferred to the
  // grader-integrity layer; mark honestly as grader-limited (recorded, not
  // silently scored).
  return { satisfied: false, detail: 'GRADER-LIMITED: no deterministic grader for ' + fam, limited: true };
}

// ---- acquisition (RCOS lane, metered teaching cost) ----
const museKey = () => {
  try { return readFile(join(process.env.HOME, '.internal-secrets', 'opencode-muse-eval.key'), 'utf8').then((s) => s.trim()); } catch { return null; }
};
async function think(prompt) {
  const key = await museKey();
  const started = Date.now();
  const res = await fetch(baseline.model_lane.endpoint + '/responses', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'x-opencode-session': 'rcos-eval-teach', 'content-type': 'application/json' },
    body: JSON.stringify({ model: baseline.model_lane.model_id, input: prompt, max_output_tokens: 8192 }),
  });
  const d = await res.json();
  const text = (d.output || []).filter((o) => o.type === 'message').flatMap((o) => (o.content || []).map((c) => c.text || '')).join('');
  return { text, usage: d.usage || {}, wall_ms: Date.now() - started };
}

const acquiredFamilies = new Set();
const acquisition = { attempts: 0, successes: 0, model_usage: [] };

async function teachForFamily(family, objective, sampleStage, expected) {
  if (acquiredFamilies.has(family)) return { attempted: false };
  acquisition.attempts += 1;
  console.log(`  TEACH[${family}]: composing candidate (metered cognition)...`);
  const files = {};
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p, base);
      else files[e.name] = await readFile(p, 'utf8');
    }
  }
  await walk(sampleStage);
  const sample = Object.entries(files).map(([n, c]) => `--- ${n} ---\n${String(c).slice(0, 400)}`).join('\n');
  const prompt = `You are RCOS's capability-acquisition step. An objective could not be satisfied by existing capabilities.

OBJECTIVE: ${objective}

A sample of the workspace it must work on:
${sample}

Compose ONE candidate workflow in Archon YAML. STRICT SCHEMA:
- top-level keys: name, description, nodes
- name: lowercase, hyphenated, end with -v0-1-0
- each node: { id, bash: <shell script>, depends_on: [ids] (optional) }
- nodes run in the workspace directory root
- The LAST node must echo an expectation marker line: learned-<name>:done
- The workflow must print OPERATOR-LEGIBLE result lines containing the word RESULT (e.g. 'RESULT key=value') so evidence can be graded.
- Deterministic sh-compatible shell, no network, no credentials.
- Generic across workspaces of this KIND: do not hardcode this exact file's contents.

Also provide ROUTING VOCABULARY: copy the distinctive CONTENT WORDS from the objective VERBATIM (exact singular/plural forms, including file-format and file-name words), plus 2-3 closely related lowercase words.

Reply with EXACTLY two fenced blocks:
1. a yaml code block containing the workflow
2. a json code block: {"description": "<one sentence>", "tags": ["word", ...]}`;

  const acq = await think(prompt);
  acquisition.model_usage.push({ family, input_tokens: acq.usage.input_tokens ?? null, output_tokens: acq.usage.output_tokens ?? null, wall_ms: acq.wall_ms });
  const ym = acq.text.match(/```yaml\n([\s\S]*?)(?:```|$)/);
  if (!ym) {
    logEvent({ event: 'acquisition-failed', family, reason: 'no yaml block' });
    return { attempted: true, ok: false };
  }
  const yamlText = ym[1];
  const nameMatch = yamlText.match(/^name:\s*(\S+)/m);
  if (!nameMatch) {
    logEvent({ event: 'acquisition-failed', family, reason: 'no workflow name' });
    return { attempted: true, ok: false };
  }
  const wfName = nameMatch[1];
  let jm = acq.text.match(/```json\n([\s\S]*?)```/);
  let tags = [];
  let description = 'LEARNED for ' + family;
  if (jm) {
    try {
      const j = JSON.parse(jm[1]);
      description = String(j.description || description);
      tags = (j.tags || []).map((t) => String(t).toLowerCase());
    } catch { /* keep defaults */ }
  }

  // evaluate the candidate on THIS fixture (the admitting case — not a
  // future/held-out benchmark case; contamination rule respected)
  await writeFile(join(ARCHON_WORKFLOWS, wfName + '.yaml'), yamlText, 'utf8');
  await new Promise((r) => setTimeout(r, 2500));
  await fetch(ARCHON + '/api/workflows/' + encodeURIComponent(wfName) + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'teaching eval', conversationId: 'rcos-teach-' + Date.now() }) });
  await new Promise((r) => setTimeout(r, 6000));
  let evText = '';
  try {
    const lb = await (await fetch(ARCHON + '/api/workflows/runs?limit=10')).json();
    const rid = (lb.runs || []).find((x) => x.workflow_name === wfName)?.id;
    if (rid) {
      const rd = await (await fetch(ARCHON + '/api/workflows/runs/' + rid)).json();
      evText = ((rd.events || []).map((e) => (e.data || {}).node_output || (e.data || {}).output).filter(Boolean)).join('\n');
    }
  } catch { /* recorded as eval failure */ }
  acquisition.candidate_evaluations = (acquisition.candidate_evaluations || 0) + 1;

  const g = await grade(expected, sampleStage, evText);
  const marker = (yamlText.match(/learned-[\w-]+:done/) || [null])[0];
  if (!g.satisfied) {
    logEvent({ event: 'acquisition-refused', family, reason: 'candidate failed external evaluation: ' + g.detail });
    return { attempted: true, ok: false };
  }
  // explicit promotion (operator action performed by the run driver,
  // recorded as such) — registry is the LANE's seed registry
  const regPath = join(LANE_HOME, 'operator-ui', 'seed-registry.json');
  const reg = JSON.parse(await readFile(regPath, 'utf8'));
  if (reg.capabilities.some((c) => c.workflow === wfName)) return { attempted: true, ok: true, already: true };
  reg.capabilities.push({
    id: wfName.replace(/-v0-1-0$/, ''), name: 'LEARNED ' + family, kind: 'workflow', version: '0.1.0',
    status: 'promoted', workflow: wfName, requires: ['filesystem:read', 'shell:execute'],
    verification: marker ? { expectOutput: marker, terminalStatus: 'completed' } : undefined,
    description, tags,
    provenance: { builtBy: 'rcos-scored-teach', teachingModel: baseline.model_lane.model_id, promotedBy: 'operator', family },
  });
  await writeFile(regPath, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  acquiredFamilies.add(family);
  acquisition.successes += 1;
  logEvent({ event: 'promoted', family, workflow: wfName });
  return { attempted: true, ok: true, capabilityId: wfName.replace(/-v0-1-0$/, '') };
}

// ---- RCOS lane objective execution ----
async function runRcosObjective(obj, staged) {
  const started = Date.now();
  let approvals = 0;
  let teachOutcome = { attempted: false };
  let g = {};
  for (let pass = 1; pass <= 2; pass++) {
    const res = await fetch(RCOS_URL + '/plugins/operator-ui/goal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objective: staged.objective, ...(pass === 2 ? { retryOf: g.taskId, approved: true } : {}) }) });
    g = await (await res.json()).goal || g;
    const codes = new Set(g.failureCodes || (g.verdict && g.verdict.failureCodes) || []);
    if (codes.has('awaiting-approval')) {
      approvals += 1;
      const r2 = await fetch(RCOS_URL + '/plugins/operator-ui/goal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approveTaskId: g.taskId }) });
      g = await (await r2.json()).goal || g;
      break;
    }
    const routeMiss = codes.has('no-route') || codes.has('objective-not-satisfied');
    if (pass === 1 && routeMiss) {
      teachOutcome = await teachForFamily(obj.family, staged.objective, staged.stage, staged.expected);
      if (teachOutcome.attempted && teachOutcome.ok) continue; // retry same objective after acquisition
    }
    break;
  }
  const v = typeof g.verdict === 'string' ? g.verdict : (g.verdict && g.verdict.decision) || null;
  const evidence = ((g.evidence || {}).outputs || []).join('\n');
  return { goal: g, wall: Date.now() - started, approvals, teachOutcome, evidenceText: evidence, selfVerdict: v };
}

// ---- DSH lane objective execution ----
async function runDshObjective(staged) {
  const started = Date.now();
  let env = { ...process.env, DSH_HOME: DSH_HOME };
  const src = baseline.model_lane && baseline.model_lane.credential_source;
  if (src === 'vault-opencode-muse-contributor') {
    try { env.MUSE_EVAL_KEY = (await readFile(join(process.env.HOME, '.internal-secrets', 'opencode-muse-eval.key'), 'utf8')).trim(); } catch {}
  }
  let stdout = '', timedOut = false, code = 0;
  try {
    stdout = execFileSync(DSH_BIN, ['--profile', 'headless', staged.objective], { cwd: staged.stage, encoding: 'utf8', timeout: BUDGET_MS, env, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    timedOut = !!e.killed;
    stdout = (e.stdout || '') + String(e.stderr || '').slice(0, 2000);
    code = e.status ?? -1;
  }
  return { stdout, wall: Date.now() - started, timedOut, code };
}

// ---- lane preparation ----
async function prepareRcosLane() {
  const opui = join(LANE_HOME, 'operator-ui');
  await rm(opui, { recursive: true, force: true });
  await mkdir(opui, { recursive: true });
  const reg = JSON.parse(await readFile(join(root, 'fixtures', 'capability-registry.example.json'), 'utf8'));
  const stripped = (reg.capabilities || []).filter((c) => !(c.provenance && c.provenance.builtBy));
  await writeFile(join(opui, 'seed-registry.json'), JSON.stringify({ ...reg, capabilities: stripped, _lane_note: 'SCORED LANE — seed-only, zero history' }, null, 2) + '\n', 'utf8');
  await writeFile(join(LANE_HOME, 'operator-ui.config.json'), JSON.stringify({
    archon: { baseUrl: ARCHON, timeoutMs: 8000 },
    registry: { path: join(opui, 'seed-registry.json') },
    authority: { preset: 'ASK_BEFORE_ACTION' },
    teaching: { workflowsDir: ARCHON_WORKFLOWS, workspaceDir: ARCHON_WORKSPACE },
  }, null, 2) + '\n', 'utf8');
  const snap = { seedOnly: true, durableTasks: 0, note: 'lane prepared; restart the lane server before running' };
  return snap;
}
async function prepareDshLane() {
  await rm(DSH_HOME, { recursive: true, force: true });
  await mkdir(DSH_HOME, { recursive: true });
  await writeFile(join(DSH_HOME, 'settings.yaml'), await readFile(join(root, 'eval', 'lib', 'dsh-lane-settings.template.yaml'), 'utf8'), 'utf8');
  return { home: DSH_HOME, clean: true };
}

// ---- main ----
if (LANE === 'rcos') await prepareRcosLane();
else await prepareDshLane();

console.log(`SCORED RUN ${experiment_id} lane=${LANE}: ${Math.min(MAX_OBJECTIVES, manifest.stream.length)} objectives (FROZEN stream)`);
console.log('NOTE: after lane preparation, RESTART the lane server (8413 for rcos) before continuing if it is already running.');

const picked = manifest.stream.slice(0, MAX_OBJECTIVES).map((id) => ({ id, ...manifest.objectives.find((o) => o.id === id) }));
let done = 0;
for (const obj of picked) {
  if (obj.hidden) throw new Error('scored stream tried a HELD-OUT objective: ' + obj.id);
  const staged = await stageFixture(obj.id);
  const preHash = sha256s(JSON.stringify(obj));
  let out, grader;
  if (LANE === 'rcos') {
    out = await runRcosObjective(obj, staged);
    grader = await grade(staged.expected, staged.stage, out.evidenceText);
  } else {
    const r = await runDshObjective(staged);
    out = { evidenceText: r.stdout, wall: r.wall, approvals: 0, selfVerdict: r.code === 0 ? null : 'FAILED', timedOut: r.timedOut };
    grader = await grade(staged.expected, staged.stage, r.stdout);
    out.goal = {};
  }
  const selfVerdict = LANE === 'rcos' ? out.selfVerdict : null;
  const record_fields = {
    task_family: obj.family, encounter: obj.encounter, objective_id: obj.id, objective: staged.objective,
    started_at: new Date(Date.now() - out.wall).toISOString(), ended_at: new Date().toISOString(),
    objective_satisfied: grader.satisfied, false_ship: grader.satisfied === false && selfVerdict === 'SHIP' ? true : (grader.satisfied && selfVerdict === 'SHIP' ? false : null),
    rcos_self_verdict: selfVerdict,
    four_state: LANE === 'rcos' ? fourState(grader.satisfied, selfVerdict) : null,
    wall_time_ms: out.wall, model_calls: null, tokens: null,
    human_interventions: 0, approval_interventions: out.approvals || 0,
    capability_built: out.teachOutcome && out.teachOutcome.ok ? 'yes' : null,
    capability_reused: out.teachOutcome && !out.teachOutcome.attempted ? (out.goal && out.goal.route && out.goal.route.selected && out.goal.route.selected.id || null) : null,
    route: (out.goal && out.goal.route && out.goal.route.selected && out.goal.route.selected.id) || null,
    attempts: (out.goal && out.goal.attempts || []).length || null,
    failure_codes: (out.goal && (out.goal.failureCodes || (out.goal.verdict && out.goal.verdict.failureCodes))) || (out.timedOut ? ['budget-timeout'] : []),
    evidence_refs: (out.goal && out.goal.taskId ? [out.goal.taskId] : []),
    grader_integrity: { fixture_hash: obj.sha256, expected_state_hash: sha256s(JSON.stringify(staged.expected)), grader_hash, pre_workspace_hash: preHash, grader_result: grader.detail, grader_limited: !!grader.limited },
    notes: grader.limited ? 'grader-limited family — counted unsatisfied, flagged' : null,
  };
  await record(record_fields);
  done += 1;
  console.log(`  [${done}] ${obj.id} → external=${grader.satisfied} self=${selfVerdict} (${grader.detail})`);
}

await writeRunManifest(recordsDir, ctxLike(), {
  kind: 'scored-50', lane: LANE, objectives: done, acquisition,
  run_log: runLog, baseline_frozen_at_commit: baseline.frozen_at_commit,
});
function ctxLike() { return { ...IDENTITY, lane: LANE }; }
console.log('DONE:', done, 'objectives. records:', recordsPath);
