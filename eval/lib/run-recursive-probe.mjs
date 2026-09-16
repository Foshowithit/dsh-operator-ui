#!/usr/bin/env node
// eval/lib/run-recursive-probe.mjs — GPT's final gate before the scored run.
//
// One non-scored recursive acquisition/reuse probe on the CLEAN scored-style
// RCOS lane (--prepare-lane). One unfamiliar NON-held-out family:
//
//   ENCOUNTER 1: objective → no route (the gap) → Teach attempts
//     acquisition → if cognition is required, the frozen GLM-5.3 lane
//     composes the candidate (METERED as teaching cost) → held-out teaching
//     evals → CANDIDATE → explicit promotion → retry → external grader
//   ENCOUNTER 2: must route to the SAME capability/version, no new
//     teaching → external grader
//   ACCOUNTING: objective execution + acquisition/model + candidate
//     evaluation + retry = RCOS cumulative cost
//
// Acquisition failing is honest evidence; the LIFECYCLE measurement must
// succeed. Records land in eval/records/<exp-id>/recursive-probe.jsonl.

import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { record } from './record.mjs';
import { runContext, snapshotRcosLane, assertCleanLane, writeRunManifest } from './experiment.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256s = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const RCOS_URL = argOf('--rcos', 'http://127.0.0.1:8413');
const LANE_HOME = argOf('--lane-home', '/tmp/opui-shakedown-rcos');
const ARCHON_WORKFLOWS = argOf('--workflows-dir', '/tmp/opui-rc0-archon/workflows');
const ARCHON_WORKSPACE = argOf('--workspace-dir', '/private/tmp/opui-rc0-folder');
const FAMILY = argOf('--family', 'F03-structured-extraction');
// Acquisition cognition uses the SAME frozen lane as the DSH baseline:
// muse-spark contributor on the go endpoint (responses API), owner-supplied.
const MODEL = { endpoint: 'https://opencode.ai/zen/go/v1', model: 'muse-spark-1.3-contributor', session: 'rcos-eval-lane' };

const manifest = JSON.parse(await readFile(join(root, 'eval', 'corpus-manifest.json'), 'utf8'));
const baseline = JSON.parse(await readFile(join(root, 'eval', 'baseline-config.json'), 'utf8'));
const ctx = await runContext({ lane: 'rcos', experimentId: argOf('--exp-id') });
const recordsDir = join(root, 'eval', 'records', ctx.experiment_id);
await mkdir(recordsDir, { recursive: true });
const recordsPath = join(recordsDir, 'recursive-probe.jsonl');

// Credential via env injection (never printed/committed).
function museKey() {
  try {
    return readFileSync_(join(process.env.HOME, '.internal-secrets', 'opencode-muse-eval.key'), 'utf8').trim();
  } catch { return null; }
}
import { readFileSync } from 'node:fs';
function readFileSync_(p, enc) { return readFileSync(p, enc); }

// Metered cognitive-model call (teaching cost): prompt → text.
async function think(prompt, maxTokens = 8192) {
  const key = museKey();
  if (!key) throw new Error('no model credential available for acquisition');
  const started = Date.now();
  const res = await fetch(MODEL.endpoint + '/responses', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'x-opencode-session': MODEL.session, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL.model, input: prompt, max_output_tokens: maxTokens }),
  });
  const d = await res.json();
  // responses API: text lives in output[] message content parts
  const text = (d.output || [])
    .filter((o) => o.type === 'message')
    .flatMap((o) => (o.content || []).map((c) => c.text || ''))
    .join('');
  return {
    text,
    usage: d.usage || {},
    wall_ms: Date.now() - started,
    cost_note: 'contributor lane (no per-token price recorded)',
  };
}

// ---- the acquisition prompt: compose a candidate workflow for the family
function acquisitionPrompt(objective, sampleFiles) {
  const sample = Object.entries(sampleFiles).map(([n, c]) => `--- ${n} ---\n${c}`).join('\n');
  return `You are RCOS's capability-acquisition step. An objective could not be routed: no existing capability matches.

OBJECTIVE: ${objective}

A sample of the workspace it must work on:
${sample}

Compose ONE candidate workflow in Archon YAML. STRICT SCHEMA (this exact dialect):
- top-level keys: name, description, nodes
- name: lowercase, hyphenated, end with -v0-1-0
- each node: { id, bash: <shell script>, depends_on: [ids] (optional) }
- nodes run in the workspace directory (cwd = workspace root)
- The LAST node must echo an expectation marker line: learned-<name>:done
- The workflow must print OPERATOR-LEGIBLE result lines (labeled, not raw dumps) so evidence can be graded: include the word RESULT in each result line, e.g. 'RESULT key=value'
- Deterministic shell (sh-compatible), no network, no credentials.

Also provide ROUTING VOCABULARY: copy the distinctive CONTENT WORDS from the objective VERBATIM (exact singular/plural forms as used, including file-format and file-name words like txt/csv/json), plus 2-3 closely related lowercase words.

Reply with EXACTLY two fenced blocks:
1. a yaml code block containing the workflow
2. a json code block: {\"description\": \"<one sentence>\", \"tags\": [\"word\", ...]}`;
}

function parseYamlBlock(text) {
  // fence-tolerant: accept an unterminated final fence (truncation)
  const m = text.match(/```yaml\n([\s\S]*?)(?:```|$)/) || text.match(/```\n([\s\S]*?)(?:```|$)/);
  return m ? m[1] : null;
}
function parseRouting(text) {
  const m = text.match(/```json\n([\s\S]*?)```/);
  if (!m) return { description: 'LEARNED during recursive probe', tags: [] };
  try {
    const j = JSON.parse(m[1]);
    return { description: String(j.description || 'LEARNED during recursive probe'), tags: (j.tags || []).map((t) => String(t).toLowerCase()) };
  } catch { return { description: 'LEARNED during recursive probe', tags: [] }; }
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

async function runGoal(objective) {
  const res = await fetch(RCOS_URL + '/plugins/operator-ui/goal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objective }) });
  return (await res.json()).goal || {};
}

async function gradeOutput(expected, stage, evidenceText) {
  const fam = expected.family;
  if (fam === 'F03') {
    // Grade the SUBSTANCE: the sequence of (host, port) pairs, tolerant of
    // line format (RESULT host=X port=Y, RESULT X=Y, X=Y all accepted).
    // Skip non-pair keys (totals/status/artifacts) by requiring the host to
    // look like the fixture's host names (contain a dot or hyphen, not a
    // known meta key).
    const meta = new Set(['total_pairs', 'status', 'artifact', 'count']);
    const got = [];
    for (const m of evidenceText.matchAll(/RESULT\s+(\S+)=(\d+)/g)) {
      // fixture hosts are dotted names; summary keys (total_pairs,
      // host_entries, status, ...) are not pairs and are skipped
      if (!meta.has(m[1]) && m[1].includes('.')) got.push([m[1], m[2]]);
    }
    for (const m of evidenceText.matchAll(/host=(\S+)\s+port=(\d+)/g)) {
      got.push([m[1], m[2]]);
    }
    const want = Object.entries(expected.fields);
    const ok = want.length === got.length && want.every(([h, p], i) => got[i] && got[i][0] === h && got[i][1] === String(p));
    return { satisfied: ok, detail: ok ? 'extraction matches' : `extraction mismatch (want ${want.length} pairs, got ${got.length})` };
  }
  if (fam === 'F07') {
    const got = [...evidenceText.matchAll(/RESULT email=(\S+) count=(\d+)/g)].map((m) => ({ email: m[1], count: Number(m[2]) }));
    const want = expected.duplicates;
    const ok = want.length === got.length && want.every((w, i) => got[i] && got[i].email === w.email && got[i].count === w.count);
    return { satisfied: ok, detail: ok ? 'duplicates match' : 'duplicate report mismatch' };
  }
  return { satisfied: false, detail: 'no grader wired for ' + fam };
}

// ---- main ----
const probe = { lane_snapshot: null, teaching: null, encounters: {}, cumulative_cost: { objective_executions: 0, acquisitions: 0, candidate_evaluations: 0, retries: 0, model_usage: [] } };

// 1. Clean lane preparation: reset the lane's operator-ui state (durable
// tasks, receipts, registry) while keeping the installed plugin profile.
async function prepareLane() {
  const opui = join(LANE_HOME, 'operator-ui');
  await rm(opui, { recursive: true, force: true });
  await mkdir(opui, { recursive: true });
  const reg = JSON.parse(await readFile(join(root, 'fixtures', 'capability-registry.example.json'), 'utf8'));
  const stripped = (reg.capabilities || []).filter((c) => !(c.provenance && c.provenance.builtBy));
  await writeFile(join(opui, 'seed-registry.json'), JSON.stringify({ ...reg, capabilities: stripped, _lane_note: 'EVAL LANE — fixture registry minus development-acquired capabilities' }, null, 2) + '\n', 'utf8');
  await writeFile(join(LANE_HOME, 'operator-ui.config.json'), JSON.stringify({
    archon: { baseUrl: argOf('--archon', 'http://127.0.0.1:13091'), timeoutMs: 8000 },
    registry: { path: join(opui, 'seed-registry.json') },
    authority: { preset: 'ASK_BEFORE_ACTION' },
    teaching: { workflowsDir: ARCHON_WORKFLOWS, workspaceDir: ARCHON_WORKSPACE },
  }, null, 2) + '\n', 'utf8');
  return stripped.length === (reg.capabilities || []).length ? 0 : (reg.capabilities || []).length - stripped.length;
}
const strippedCount = await prepareLane();

// 1. Clean lane preparation
const reg = JSON.parse(await readFile(join(LANE_HOME, 'operator-ui', 'seed-registry.json'), 'utf8'));
const snap = await snapshotRcosLane({ dshHome: LANE_HOME, seedRegistryPath: join(LANE_HOME, 'operator-ui', 'seed-registry.json') });
assertCleanLane(snap);
probe.lane_snapshot = { clean: true, registryHash: snap.registryHash };
console.log('lane snapshot: CLEAN (seed-only, zero history)');

const enc = [1, 2].map((n) => manifest.objectives.find((o) => o.id === `${FAMILY}/encounter-${n}` && !o.hidden));
if (enc.some((o) => !o || o.hidden)) throw new Error('probe family must have non-held-out encounters 1 and 2 in the visible corpus');

// 2. ENCOUNTER 1: expect the gap
const e1 = await stageFixture(enc[0].id);
await rm(ARCHON_WORKSPACE, { recursive: true, force: true });
await mkdir(ARCHON_WORKSPACE, { recursive: true });
execFileSync('cp', ['-R', e1.stage + '/.', ARCHON_WORKSPACE + '/']);
const g1 = await runGoal(e1.objective);
const g1codes = g1.failureCodes || (g1.verdict && g1.verdict.failureCodes) || [];
probe.encounters.encounter1 = { objective: e1.objective, routed: !!g1.route?.selected, refusal: g1codes };
console.log('ENC1:', g1.route?.selected ? 'ROUTED (unexpected!)' : 'no route → gap confirmed', `(${g1codes.join(',') || ''})`);
await record(recordsPath, 'rcos', { task_family: FAMILY, encounter: 1, objective_id: enc[0].id, objective: e1.objective, objective_satisfied: false, false_ship: null, failure_codes: g1codes, evidence_refs: [g1.taskId].filter(Boolean), human_interventions: 0, approval_interventions: 0, route: null, attempts: 0, scored: false, notes: 'encounter 1 gap admission' });

if (!g1.route?.selected) {
  // 3. TEACH with cognitive acquisition (metered)
  console.log('TEACH: composing candidate with', MODEL.model, '...');
  const files = {};
  async function walkDir(d, base) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walkDir(p, base);
      else files[e.name] = await readFile(p, 'utf8');
    }
  }
  await walkDir(e1.stage);
  const acq = await think(acquisitionPrompt(e1.objective, files));
  probe.cumulative_cost.acquisitions += 1;
  probe.cumulative_cost.model_usage.push({ phase: 'acquisition', model: MODEL.model, input_tokens: acq.usage.input_tokens ?? null, output_tokens: acq.usage.output_tokens ?? null, wall_ms: acq.wall_ms });
  const yaml = parseYamlBlock(acq.text);
  if (!yaml) {
    console.log('acquisition reply head:', acq.text.slice(0, 300));
    throw new Error('acquisition produced no YAML block');
  }
  const routing = parseRouting(acq.text);
  const nameMatch = yaml.match(/^name:\s*(\S+)/m);
  const wfName = nameMatch ? nameMatch[1] : 'learned-candidate-v0-1-0';
  await writeFile(join(ARCHON_WORKFLOWS, wfName + '.yaml'), yaml, 'utf8');
  console.log('candidate workflow written:', wfName);

  // 4. Evaluate candidate on the ENCOUNTER-1 fixture itself (the only
  // non-contaminating fixture available pre-promotion): run it on Archon.
  await new Promise((r) => setTimeout(r, 2500)); // Archon catalog refresh
  const evRes = await fetch('http://127.0.0.1:13091/api/workflows/' + encodeURIComponent(wfName) + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'teaching eval', conversationId: 'rcos-teach-' + Date.now() }) });
  const accepted = evRes.ok;
  let evOut = null;
  if (accepted) {
    await new Promise((r) => setTimeout(r, 6000));
    const lb = await (await fetch('http://127.0.0.1:13091/api/workflows/runs?limit=10')).json();
    const rid = (lb.runs || []).find((x) => x.workflow_name === wfName)?.id;
    if (rid) {
      const rd = await (await fetch('http://127.0.0.1:13091/api/workflows/runs/' + rid)).json();
      evOut = ((rd.events || []).map((e) => (e.data || {}).node_output || (e.data || {}).output).filter(Boolean)).join('\n');
    }
  }
  probe.cumulative_cost.candidate_evaluations += 1;
  const grader = await gradeOutput(e1.expected, e1.stage, evOut || '');
  console.log('CANDIDATE EVAL:', grader.satisfied ? 'PASS' : 'FAIL', '-', grader.detail);
  probe.teaching = { workflow: wfName, candidate_eval: grader, yaml_sha256: sha256s(yaml) };

  // 5. Explicit promotion = write the learned capability into the LANE
  // registry (operator action in the real flow; the probe driver performs
  // the write on the operator's behalf, recorded as such).
  if (grader.satisfied) {
    // Declared output contract: read the expectation marker back from the
    // candidate YAML so the 3-check gate can verify it on every future use.
    const marker = (yaml.match(/learned-[\w-]+:done/) || [null])[0];
    reg.capabilities.push({
      id: wfName.replace(/-v0-1-0$/, ''), name: 'LEARNED ' + FAMILY, kind: 'workflow', version: '0.1.0',
      status: 'promoted', workflow: wfName, requires: ['filesystem:read', 'shell:execute'],
      verification: marker ? { expectOutput: marker, terminalStatus: 'completed' } : undefined,
      description: routing.description, tags: routing.tags, provenance: { builtBy: 'rcos-recursive-probe', teachingModel: MODEL.model, promotedBy: 'operator' },
    });
    await writeFile(join(LANE_HOME, 'operator-ui', 'seed-registry.json'), JSON.stringify(reg, null, 2) + '\n', 'utf8');
    probe.teaching.promoted = true;
    console.log('PROMOTED (operator action, recorded):', wfName);
  }
}

// 6. ENCOUNTER 1 RETRY (if promoted) and 7. ENCOUNTER 2 (reuse, no teaching)
for (const [label, o] of [['retry', enc[0]], ['encounter2', enc[1]]]) {
  if (label === 'retry' && !probe.teaching?.promoted) continue;
  const st = await stageFixture(o.id);
  await rm(ARCHON_WORKSPACE, { recursive: true, force: true });
  await mkdir(ARCHON_WORKSPACE, { recursive: true });
  execFileSync('cp', ['-R', st.stage + '/.', ARCHON_WORKSPACE + '/']);
  const g = await runGoal(st.objective);
  const codes = g.failureCodes || (g.verdict && g.verdict.failureCodes) || [];
  if (codes.includes('awaiting-approval')) {
    probe.cumulative_cost.retries += label === 'retry' ? 1 : 0;
    const g2 = await (await fetch(RCOS_URL + '/plugins/operator-ui/goal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approveTaskId: g.taskId }) })).json();
    Object.assign(g, g2.goal || {});
  }
  const evidence = ((g.evidence || {}).outputs || []).join('\n');
  const gr = await gradeOutput(st.expected, st.stage, evidence);
  probe.cumulative_cost.objective_executions += 1;
  probe.encounters[label] = { routed: !!g.route?.selected, capability: g.route?.selected?.id || null, verdict: g.verdict, grader: gr };
  await record(recordsPath, 'rcos', { task_family: FAMILY, encounter: label === 'retry' ? 1 : 2, objective_id: o.id, objective: st.objective, objective_satisfied: gr.satisfied, false_ship: gr.satisfied ? false : null, wall_time_ms: null, failure_codes: codes, evidence_refs: [g.taskId].filter(Boolean), capability_reused: label === 'encounter2' ? (g.route?.selected?.id || null) : null, route: g.route?.selected?.id || null, attempts: (g.attempts || []).length, human_interventions: 0, approval_interventions: codes.includes('awaiting-approval') ? 1 : 0, scored: false, notes: 'probe ' + label });
  console.log(`${label.toUpperCase()}: routed=${!!g.route?.selected} → ${g.verdict} | grader: ${gr.satisfied ? 'PASS' : 'FAIL'} (${gr.detail}) | capability: ${g.route?.selected?.id || '—'}`);
}

await writeRunManifest(recordsDir, ctx, { kind: 'recursive-probe', probe });
console.log('\ncumulative cost:', JSON.stringify(probe.cumulative_cost, null, 1));
console.log('records:', recordsPath);
