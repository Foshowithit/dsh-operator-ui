#!/usr/bin/env node
// eval/lib/experiment.mjs — experiment identity, lane snapshots, teaching
// cost accounting (GPT's three pre-run requirements for Eval Protocol v1).
//
// 1. IDENTITY: every record must be explainable months later. A run context
//    pins experiment_id + protocol_hash + corpus_hash + system_build_sha +
//    lane + grader_hash, and EVERY record carries them.
// 2. CLEAN LANES: the scored RCOS lane starts with only the explicitly
//    declared seed intelligence — the runner ASSERTS the snapshot (registry
//    == seed set, no durable task/teaching history) and records both lanes'
//    baseline hashes in the run manifest. DSH likewise per its baseline.
// 3. TEACHING COST: RCOS cumulative cost includes teaching/build runs and
//    held-out teaching evals, not just the 50 objective executions. The
//    recorder tracks them from the Archon run list under the teaching
//    conversation prefix.

import { createHash } from 'node:crypto';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = join(join(import.meta.dirname), '..', '..');
const sha256File = async (p) => 'sha256:' + createHash('sha256').update(await readFile(p)).digest('hex');
const sha256Obj = (o) => 'sha256:' + createHash('sha256').update(JSON.stringify(o)).digest('hex');

// ------------------------------------------------------------- 1. identity

export async function runContext({ lane, experimentId } = {}) {
  if (!['rcos', 'dsh'].includes(lane)) throw new Error('lane must be rcos|dsh');
  const protocolHash = await sha256File(join(root, 'eval', 'protocol-v1.md'));
  const corpusHash = await sha256File(join(root, 'eval', 'corpus-manifest.json'));
  let buildSha = null;
  try {
    const { execFileSync } = await import('node:child_process');
    buildSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch { /* non-git context: record null honestly */ }
  const graderHash = sha256File === null ? null : await sha256File(join(root, 'eval', 'lib', 'record.mjs'));
  return {
    experiment_id: experimentId || ('exp-' + randomUUID().slice(0, 8)),
    protocol_hash: protocolHash,
    corpus_hash: corpusHash,
    grader_hash: graderHash,
    system_build_sha: buildSha,
    lane,
    started_at: new Date().toISOString(),
  };
}

// ------------------------------------------------- 2. clean-lane snapshots

// RCOS clean baseline: the declared seed registry (which may contain
// declared EXAMPLE capabilities — that is its baseline), an EMPTY task
// store, and no capability that was ACQUIRED DURING DEVELOPMENT (any
// provenance-tagged learned entry). Anything else = contaminated start.
export async function snapshotRcosLane({ dshHome, seedRegistryPath }) {
  const reg = JSON.parse(await readFile(seedRegistryPath, 'utf8'));
  const caps = (reg.capabilities || []).map((c) => ({
    id: c.id, version: c.version || null, status: c.status, seed: c.seed === true,
    devAcquired: !!(c.provenance && c.provenance.builtBy),
  }));
  const operatorUi = join(dshHome, 'operator-ui');
  let tasksCount = 0;
  let receiptLevel = null;
  try {
    const tasks = JSON.parse(await readFile(join(operatorUi, 'tasks.json'), 'utf8'));
    tasksCount = (tasks.tasks || []).length;
  } catch { /* absent = clean */ }
  try {
    const receipt = JSON.parse(await readFile(join(operatorUi, 'receipt.json'), 'utf8'));
    receiptLevel = receipt.decision || receipt.level || null;
  } catch { /* absent */ }
  const snapshot = {
    dshHome,
    registryHash: await sha256File(seedRegistryPath),
    capabilities: caps,
    devAcquiredCount: caps.filter((c) => c.devAcquired).length,
    durableTasks: tasksCount,
    receiptLevel,
  };
  snapshot.clean = tasksCount === 0 && snapshot.devAcquiredCount === 0;
  return snapshot;
}

// DSH clean baseline: a fresh home with the declared baseline config; we
// record its config hash + that no plugin artifacts exist.
export async function snapshotDshLane({ dshHome }) {
  let entries = [];
  try { entries = await readdir(dshHome); } catch { /* fresh home may not exist yet */ }
  let configHash = null;
  try { configHash = await sha256File(join(dshHome, 'settings.yaml')); } catch { /* optional */ }
  return {
    dshHome,
    entries,
    configHash,
    clean: !entries.includes('operator-ui'),
  };
}

// The guardrail (GPT): refuse to run a scored lane on a dirty snapshot.
export function assertCleanLane(snapshot) {
  const problems = [];
  if (snapshot.durableTasks !== 0) problems.push('durable task history exists (' + snapshot.durableTasks + ')');
  if (typeof snapshot.devAcquiredCount === 'number' && snapshot.devAcquiredCount > 0) {
    problems.push('registry contains development-acquired capabilities (' + snapshot.devAcquiredCount + ')');
  }
  if (problems.length) throw new Error('lane snapshot is not clean: ' + problems.join('; '));
  return true;
}

// --------------------------------------------------- 3. teaching cost

// Teaching runs are identified by the teaching conversation prefix the
// goal/teach machinery uses ('rcos-teach-'). They are NOT scored objectives
// but they ARE RCOS resource cost (build + held-out evals + re-teaches).
export function teachingCostFromRunLists(beforeRuns, afterRuns) {
  const before = new Set((beforeRuns || []).map((r) => r.id));
  const teaching = (afterRuns || []).filter((r) => !before.has(r.id) && String(r.conversation_id || r.conversationId || '').startsWith('rcos-teach-'));
  return {
    teaching_runs: teaching.length,
    run_ids: teaching.map((r) => r.id),
  };
}

// ------------------------------------------------- run manifest (parity)

export async function writeRunManifest(recordsDir, ctx, extras) {
  const manifest = { ...ctx, ...extras, written_at: new Date().toISOString() };
  const p = join(recordsDir, 'run-manifest.json');
  await writeFile(p, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

// ----------------------------------------------------- live observation
//
// The parity check is only meaningful if the "live" side is INDEPENDENTLY
// OBSERVED — never echoed from the baseline. This measures the machine and
// re-reads the lane's resolved config files NOW.
export async function observeLive({ laneHome, budgetMs, corpusPath, dshBin } = {}) {
  const os = await import('node:os');
  const live = {
    hardware: {
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      mem_gb: Math.round(os.totalmem() / 1024 ** 3),
      hostname_hash: ('sha256:' + createHash('sha256').update(os.hostname()).digest('hex')).slice(0, 16),
    },
    corpus_hash: await sha256File(corpusPath),
    budget: { wall_ms_per_objective: budgetMs },
  };
  // Resolved DSH lane model config: parse the lane home's settings.yaml —
  // the agent-default-model (provider+model) and that provider's baseURL.
  if (laneHome) {
    try {
      const settings = await readFile(join(laneHome, 'settings.yaml'), 'utf8');
      const adm = settings.match(/agent-default-model:\s*\n\s*provider:\s*(\S+)\s*\n\s*model:\s*(\S+)/);
      if (adm) {
        live.model_id = adm[2];
        const provRe = new RegExp(`(\\S+):\\s*\\n[\\s\\S]*?api:[^\\n]*\\n[\\s\\S]*?baseURL:\\s*(\\S+)`);
        // find the baseURL within the named provider's block
        const provBlock = settings.match(new RegExp(`    ${adm[1]}:\\s*\\n([\\s\\S]*?)(?=\\n    \\S|\\n\\S)`));
        if (provBlock) {
          const bm = provBlock[1].match(/baseURL:\s*(\S+)/);
          if (bm) live.model_endpoint = bm[1];
        }
      }
      const sm = settings.match(/reasoningEffort:\s*(\S+)/);
      live.model_sampling = sm ? 'reasoningEffort=' + sm[1] : 'provider defaults';
    } catch { /* unreadable settings → model rows will MISMATCH, correctly */ }
  }
  return live;
}

// ------------------------------------------------- parity preflight (GPT)
//
// The final parity assertion BEFORE any shakedown/scored lane starts:
// shared resources must be SAME; architecture differences are recorded,
// never normalized away. `live` carries what THIS lane actually has.
// `requiresModel` — only a lane whose system invokes a cognitive model
// (dsh) is blocked by an unresolved model lane; a lane with NO cognitive
// model in its architecture (rcos v1 deterministic workflows) records that
// as an ARCHITECTURAL difference, which GPT explicitly allows.
export function assertParity(baseline, ctx, live, { requiresModel = false } = {}) {
  const rows = [];
  const ml = baseline.model_lane || {};
  if (requiresModel && !ml.model_id) {
    throw new Error('PARITY REFUSED: baseline model lane is unresolved — the owner must pick the funded model lane, then re-freeze eval/baseline-config.json once at the scored-build SHA');
  }
  const modelVerdict = (a, b) => {
    if (live.no_cognitive_model) return 'ARCHITECTURAL (recorded): this lane runs no cognitive model in v1';
    return a != null && b != null && a === b ? 'SAME' : 'MISMATCH';
  };
  rows.push({ name: 'model endpoint/provider', baseline: ml.endpoint || null, lane: live.model_endpoint || null, verdict: modelVerdict(ml.endpoint, live.model_endpoint) });
  rows.push({ name: 'model ID', baseline: ml.model_id || null, lane: live.model_id || null, verdict: modelVerdict(ml.model_id, live.model_id) });
  rows.push({ name: 'sampling/reasoning params', baseline: ml.sampling || null, lane: live.model_sampling || null, verdict: modelVerdict(ml.sampling, live.model_sampling) });
  const check = (name, a, b) => {
    const same = JSON.stringify(a) === JSON.stringify(b);
    rows.push({ name, baseline: a, lane: b, verdict: same ? 'SAME' : 'MISMATCH' });
    return same;
  };
  check('hardware', baseline.hardware, live.hardware);
  check('fixture/corpus hash', ctx.corpus_hash, live.corpus_hash);
  check('wall budget', baseline.budget.wall_ms_per_objective, live.budget.wall_ms_per_objective);
  const tools = live.tool_availability || {};
  rows.push({ name: 'base tool availability', baseline: 'equivalent', lane: tools.verdict || 'unrecorded', verdict: tools.verdict === 'EQUIVALENT' || tools.explained ? 'EQUIVALENT/EXPLAINED' : 'MISMATCH' });
  const failed = rows.filter((r) => r.verdict === 'MISMATCH');
  if (failed.length) {
    throw new Error('PARITY MISMATCH:\n' + failed.map((f) => `  ${f.name}: baseline=${JSON.stringify(f.baseline)} lane=${JSON.stringify(f.lane)}`).join('\n'));
  }
  return rows;
}

// Baseline freshness (GPT): the final baseline is frozen ONCE at the scored
// build SHA; HEAD must not move underneath a running experiment.
export function assertBaselineFresh(baseline, headSha) {
  if (!baseline.frozen_at_commit) throw new Error('baseline lacks frozen_at_commit — re-freeze with write-baseline.mjs');
  if (baseline.frozen_at_commit !== headSha) {
    throw new Error('baseline was frozen at ' + baseline.frozen_at_commit.slice(0, 10) + ' but HEAD is ' + String(headSha).slice(0, 10) + ' — re-freeze the baseline once at the scored build, then do not move HEAD underneath the experiment');
  }
  return true;
}

export const _internals = { sha256Obj };
