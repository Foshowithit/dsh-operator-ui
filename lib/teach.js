// dsh-operator-ui — Teach Mode M2: capability ACQUISITION (GPT contract).
//
// Lifecycle: GAP → TEACH → BUILD → EVALUATE → CANDIDATE → PROMOTE → ROUTE.
// A no-route refusal or an objective-not-satisfied BLOCK is a GAP. "Teach
// RCOS" opens a TEACHING TASK — a separate durable task with its OWN
// identity; the source task is never mutated into a capability:
//
//   source_task_id     the task whose objective exposed the gap
//   teaching_task_id   the process of learning (this envelope, 'teach-…')
//   capability_id      the reusable intelligence produced IF learning
//                      succeeds (+ version, lifecycle CANDIDATE until the
//                      operator explicitly promotes it)
//
// HARD RULE (GPT): successful generation does NOT equal learned capability.
// BUILD composes a deterministic candidate workflow; EVALUATE then executes
// it on the real Archon against a held-out fixture set. Only when every
// case passes does the candidate OFFER promotion — and promotion is always
// an explicit human click. A candidate that fails any case is refused:
// "Couldn't learn this reliably … Not added to Intelligence." That failure
// path is as important as the happy path.
//
// Authority: the candidate DECLARES its required scopes before it can ever
// become routable — a generated capability cannot quietly acquire power.
// Provenance is permanently attached (built-by, source/teaching task,
// eval set, promoted-by/at, version).
//
// Writes (the ONLY ones this module makes, both under operator-configured
// paths): the candidate workflow YAML into teaching.workflowsDir, and
// per-eval fixture files into teaching.workspaceDir. Everything durable
// about the TEACHING itself lives in tasks.json (the task store) — no
// third store.

import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveConfig } from './config.js';
import { SCOPES } from './authority.js';
import { getTask, upsertTask, listTasks } from './tasks.js';

const isoNow = () => new Date().toISOString();
const sha256 = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

function archonHeaders() {
  const { config } = resolveConfig();
  const headers = {};
  const tokenVar = config.archon.tokenVar;
  if (typeof tokenVar === 'string' && process.env[tokenVar]) headers.authorization = 'Bearer ' + process.env[tokenVar];
  return headers;
}

// ------------------------------------------------------------ eval fixtures
//
// The held-out eval set for M2's proof: workspace-wide word counting over
// deterministic fixture workspaces. Each case writes ITS OWN README.txt into
// the run workspace, executes the candidate on the real Archon, and compares
// the observed operator-legible evidence to the expected numbers. Cases are
// chosen to be distinct (1 line / many lines / unicode) so a one-file or
// hardcoding learner cannot pass by luck.
const EVAL_SET = [
  { id: 'eval-single-line', content: 'hello world\n', words: 2, lines: 1, bytes: 12 },
  { id: 'eval-multi-line', content: 'the quick brown fox\njumps over the lazy dog\nand rests\n', words: 11, lines: 3, bytes: 54 },
  { id: 'eval-unicode', content: 'café naïve — résumé\nsecond line here\n', words: 7, lines: 2, bytes: 43 },
];

// ------------------------------------------------------------------ BUILD
//
// Deterministic synthesis: the candidate measures EVERY *.txt file in the
// run workspace (the gap example-text-stats cannot close — it reads exactly
// one file) and reports per-file plus TOTAL counts, ending with the
// candidate's own expectation marker so the 3-check gate applies to it too.

function composeWorkflowYaml(capId, version) {
  const wfName = capId + '-v' + version.replace(/\./g, '-');
  const yaml = [
    '# LEARNED by RCOS teaching (M2) — candidate ' + capId + ' v' + version + '.',
    '# Composed deterministically by lib/teach.js; executed + evaluated on the',
    '# real Archon against a held-out fixture set BEFORE promotion was offered.',
    '',
    'name: ' + wfName,
    'description: >',
    '  LEARNED capability: counts lines, words, and bytes across EVERY .txt',
    '  file in the run workspace and reports per-file lines plus totals',
    '  (deterministic, zero-credential).',
    '',
    'nodes:',
    '  - id: measure-all',
    '    bash: >',
    '      total_lines=0; total_words=0; total_bytes=0; found=0;',
    '      for f in *.txt; do',
    '        [ -e "$f" ] || continue; found=1;',
    '        l=$(wc -l < "$f" | tr -d " ");',
    '        w=$(wc -w < "$f" | tr -d " ");',
    '        b=$(wc -c < "$f" | tr -d " ");',
    '        echo "file $f: Lines: $l Words: $w Bytes: $b";',
    '        total_lines=$((total_lines + l)); total_words=$((total_words + w)); total_bytes=$((total_bytes + b));',
    '      done;',
    '      if [ "$found" -eq 0 ]; then echo "no .txt files in workspace"; total_lines=0; total_words=0; total_bytes=0; fi;',
    '      echo "TOTAL Lines: $total_lines Words: $total_words Bytes: $total_bytes"',
    '',
    '  - id: report',
    '    depends_on: [measure-all]',
    '    bash: echo \'learned-' + capId + ':done\'',
    '',
  ].join('\n');
  return { wfName, yaml };
}

// --------------------------------------------------------------- dispatch

async function archonPost(path, body, timeoutMs) {
  const { config } = resolveConfig();
  const res = await fetch(config.archon.baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...archonHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(timeoutMs, 10000)),
  });
  if (!res.ok) throw new Error('archon HTTP ' + res.status);
  return res.json();
}

async function archonGet(path, timeoutMs) {
  const { config } = resolveConfig();
  const res = await fetch(config.archon.baseUrl + path, { headers: archonHeaders(), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error('archon HTTP ' + res.status);
  return res.json();
}

// Run one workflow to terminal, discovering the run id from the run list
// (same acceptance contract as goal.js/verify.js: POST answers {accepted}).
async function runWorkflow(wfName, message, timeoutMs) {
  const preIds = new Set();
  try {
    const lb = await archonGet('/api/workflows/runs?limit=50', timeoutMs);
    for (const r of (lb && lb.runs) || []) if (r && r.id) preIds.add(r.id);
  } catch { /* discovery aid only */ }
  await archonPost('/api/workflows/' + encodeURIComponent(wfName) + '/run', { message, conversationId: 'rcos-teach-' + randomUUID().slice(0, 8) }, timeoutMs);
  const deadline = Date.now() + 10000;
  let runId = null;
  while (Date.now() < deadline && !runId) {
    await new Promise((r) => setTimeout(r, 700));
    try {
      const lb = await archonGet('/api/workflows/runs?limit=50', timeoutMs);
      for (const r of (lb && lb.runs) || []) if (r && r.id && !preIds.has(r.id) && r.workflow_name === wfName) { runId = r.id; break; }
    } catch { /* keep polling */ }
  }
  if (!runId) throw Object.assign(new Error('dispatch accepted but no run appeared'), { code: 'run-not-found' });
  const pollDeadline = Date.now() + 60000;
  for (;;) {
    const d = await archonGet('/api/workflows/runs/' + encodeURIComponent(runId), timeoutMs);
    const run = (d && d.run) || d;
    if (run && ['completed', 'failed'].includes(run.status)) {
      const events = (d && d.events) || run.events || [];
      const outputs = [];
      let text = '';
      for (const e of events) {
        const o = e && e.data && (typeof e.data.node_output === 'string' ? e.data.node_output : (typeof e.data.output === 'string' ? e.data.output : null));
        if (o && o.trim()) { outputs.push(o.trim()); text += o.trim() + '\n'; }
      }
      return { status: run.status, runId, outputs, text };
    }
    if (Date.now() > pollDeadline) throw Object.assign(new Error('run did not reach a terminal state'), { code: 'run-timeout' });
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ------------------------------------------------------------ teaching run

async function _teach({ sourceTaskId }) {
  const startedAt = isoNow();
  const teachingTaskId = 'teach-' + randomUUID().slice(0, 8);
  const t = {
    taskId: teachingTaskId,
    tasksVersion: 1,
    kind: 'teaching',
    sourceTaskId: String(sourceTaskId || '').slice(0, 120),
    status: 'learning',
    createdAt: startedAt,
    endedAt: null,
    gap: null,            // why the source task exposed a gap (failure codes + reason)
    candidate: null,      // the composed package (identity, scopes, yaml, eval set)
    evaluations: [],      // per-case real-Archon results
    verdict: null,        // 'CANDIDATE' (all evals passed) | 'REFUSED' (any failed)
    provenance: {
      builtBy: 'rcos-teaching-m2',
      teachingTaskId,
      sourceTaskId: String(sourceTaskId || '').slice(0, 120),
    },
    nextAction: null,
    sealedBy: 'goal-runner-m2-teach',
  };

  try {
    const cfgRes = resolveConfig();
    const teaching = cfgRes.config.teaching || {};
    if (!cfgRes.config.registry.path) throw Object.assign(new Error('registry not configured'), { code: 'registry-not-configured' });
    if (!teaching.workflowsDir || !teaching.workspaceDir) throw Object.assign(new Error('teaching not configured — set teaching.workflowsDir and teaching.workspaceDir'), { code: 'teaching-not-configured' });

    // ---- GAP: read the source task's honest failure
    const src = await getTask(t.sourceTaskId);
    if (!src) throw Object.assign(new Error('source task not found'), { code: 'source-not-found' });
    const srcCodes = (src.verdict && src.verdict.failureCodes) || src.failureCodes || [];
    t.gap = {
      objective: src.objective,
      failureCodes: srcCodes,
      reason: srcCodes.includes('no-route')
        ? 'no capability in the registry matched this objective'
        : 'the routed capability ran but did not satisfy the objective',
    };

    // ---- BUILD: deterministic candidate composition. The candidate declares
    // its authority scopes BEFORE it can ever become routable.
    const capId = 'workspace-word-count';
    const version = '0.1.0';
    const { wfName, yaml } = composeWorkflowYaml(capId, version);
    t.candidate = {
      capabilityId: capId,
      version,
      workflow: wfName,
      workflowYaml: yaml,
      workflowSha256: sha256(yaml),
      provides: 'Counts lines, words, and bytes across every .txt file in the workspace, with totals',
      routingVocabulary: ['workspace', 'words', 'count', 'every', 'file', 'text', 'totals'],
      requires: ['filesystem:read', 'shell:execute'],
      requiresUnknown: [],
      verification: { expectOutput: 'learned-' + capId + ':done', terminalStatus: 'completed' },
      lifecycle: 'candidate',
    };
    for (const s of t.candidate.requires) if (!SCOPES.includes(s)) t.candidate.requiresUnknown.push(s);
    await mkdir(teaching.workflowsDir, { recursive: true });
    await writeFile(join(teaching.workflowsDir, wfName + '.yaml'), yaml, 'utf8');

    // ---- EVALUATE: held-out fixture workspaces on the REAL Archon.
    // Successful generation is not learned capability — every case must pass
    // on evidence before promotion may even be OFFERED.
    await mkdir(teaching.workspaceDir, { recursive: true });
    const evalResults = [];
    for (const fx of EVAL_SET) {
      await writeFile(join(teaching.workspaceDir, 'README.txt'), fx.content, 'utf8');
      const run = await runWorkflow(wfName, 'teaching eval ' + teachingTaskId + '/' + fx.id, cfgRes.config.archon.timeoutMs);
      // Node output arrives as per-event blobs (a blob may hold several
      // lines) — match against the JOINED evidence text, never one output.
      const allText = (run.outputs || []).join('\n');
      const m = allText.match(/TOTAL Lines: (\d+) Words: (\d+) Bytes: (\d+)/);
      const obs = m ? { lines: Number(m[1]), words: Number(m[2]), bytes: Number(m[3]) } : null;
      const pass = run.status === 'completed' &&
        allText.includes('learned-' + capId + ':done') &&
        !!obs && obs.lines === fx.lines && obs.words === fx.words && obs.bytes === fx.bytes;
      evalResults.push({
        caseId: fx.id, status: run.status, runId: run.runId,
        expected: { lines: fx.lines, words: fx.words, bytes: fx.bytes },
        observed: obs, pass,
      });
    }
    t.evaluations = evalResults;
    const passed = evalResults.filter((e) => e.pass).length;
    if (passed !== evalResults.length) {
      // The honest refusal: a candidate that failed ANY case is not learned.
      t.verdict = 'REFUSED';
      t.status = 'failed';
      t.nextAction = { kind: 'inspect', label: 'Inspect the evidence', reason: 'Couldn\u2019t learn this reliably. Candidate succeeded ' + passed + '/' + evalResults.length + ' evaluations. Not added to Intelligence.' };
      t.endedAt = isoNow();
      await upsertTask(t);
      return t;
    }

    // ---- CANDIDATE: evals passed. Promotion stays an explicit HUMAN action.
    t.verdict = 'CANDIDATE';
    t.status = 'candidate';
    t.nextAction = { kind: 'promote', label: 'Promote to Intelligence', reason: 'Tested on ' + evalResults.length + ' held-out cases — all execution checks, capability validations, and objective evaluations passed. Promotion needs your explicit approval.' };
    t.endedAt = isoNow();
    await upsertTask(t);
    return t;
  } catch (e) {
    t.verdict = 'REFUSED';
    t.status = 'failed';
    t.error = String((e && e.message) || e).slice(0, 200);
    t.nextAction = { kind: 'inspect', label: 'Inspect the teaching task', reason: t.error };
    t.endedAt = isoNow();
    await upsertTask(t);
    return t;
  }
}

let teachInflight = null;
export function teachRCOS({ sourceTaskId }) {
  if (teachInflight) return teachInflight;
  teachInflight = _teach({ sourceTaskId }).finally(() => { teachInflight = null; });
  return teachInflight;
}

// ------------------------------------------------------------------ PROMOTE
//
// The explicit human action. Promotion writes the candidate into the
// OPERATOR's registry (registry.path) — with provenance permanently
// attached — and seals the teaching envelope as promoted. It refuses
// anything that is not a CANDIDATE, and it refuses candidates with unknown
// scopes (fail-closed, same as dispatch).
export async function promoteCandidate({ teachingTaskId }) {
  const t = await getTask(String(teachingTaskId || '').slice(0, 120));
  if (!t || t.kind !== 'teaching' || t.verdict !== 'CANDIDATE' || t.status !== 'candidate') {
    return { ok: false, error: 'teaching task is not a CANDIDATE — nothing to promote' };
  }
  const cand = t.candidate;
  if (!cand || (cand.requiresUnknown || []).length) {
    return { ok: false, error: 'candidate declares unknown authority scopes — promotion refused' };
  }
  const cfgRes = resolveConfig();
  if (!cfgRes.config.registry.path) return { ok: false, error: 'registry not configured' };
  let registry;
  try {
    registry = JSON.parse(await readFile(cfgRes.config.registry.path, 'utf8'));
  } catch (e) {
    return { ok: false, error: 'registry unreadable: ' + String((e && e.message) || e).slice(0, 120) };
  }
  if (!registry || !Array.isArray(registry.capabilities)) return { ok: false, error: 'registry has no capabilities array' };
  if (registry.capabilities.some((c) => c.id === cand.capabilityId)) {
    return { ok: false, error: 'capability already in the registry — promotion refused (promote a NEW version instead)' };
  }
  const entry = {
    id: cand.capabilityId,
    name: cand.provides ? 'LEARNED — ' + String(cand.provides).slice(0, 80) : 'LEARNED ' + cand.capabilityId,
    kind: 'workflow',
    version: cand.version,
    status: 'promoted',
    workflow: cand.workflow,
    requires: cand.requires,
    verification: cand.verification,
    description: cand.provides,
    tags: cand.routingVocabulary,
    provenance: {
      builtBy: t.provenance.builtBy,
      sourceTaskId: t.sourceTaskId,
      teachingTaskId: t.taskId,
      evalSet: (t.evaluations || []).map((e) => ({ caseId: e.caseId, runId: e.runId, pass: e.pass })),
      promotedBy: 'operator',
      promotedAt: isoNow(),
    },
    admitted_after: [],
    evals: [],
    reuse_count: 0,
    last_eval: null,
  };
  registry.capabilities.push(entry);
  await writeFile(cfgRes.config.registry.path, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  t.status = 'promoted';
  t.nextAction = { kind: 'retry', label: 'Try original objective again', reason: 'RCOS learned this capability — the original objective can now route to it.' };
  await upsertTask(t);
  return { ok: true, teaching: t, capability: entry };
}

export async function listTeaching() {
  return (await listTasks()).filter((t) => t.kind === 'teaching');
}
