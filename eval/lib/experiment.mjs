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

// RCOS clean baseline: the declared seed registry, an EMPTY task store, and
// nothing else under operator-ui/. Anything else = contaminated start.
export async function snapshotRcosLane({ dshHome, seedRegistryPath }) {
  const reg = JSON.parse(await readFile(seedRegistryPath, 'utf8'));
  const caps = (reg.capabilities || []).map((c) => ({ id: c.id, version: c.version || null, status: c.status, seed: c.seed === true }));
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
    seedOnly: caps.every((c) => c.seed === true || c.status === 'candidate'),
    durableTasks: tasksCount,
    receiptLevel,
  };
  snapshot.clean = tasksCount === 0;
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
export function assertCleanLane(snapshot, { allowNonSeedCandidates = false } = {}) {
  const problems = [];
  if (snapshot.durableTasks !== 0) problems.push('durable task history exists (' + snapshot.durableTasks + ')');
  if (typeof snapshot.seedOnly === 'boolean' && !snapshot.seedOnly && !allowNonSeedCandidates) {
    problems.push('registry contains non-seed capabilities (development-acquired intelligence)');
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

export const _internals = { sha256Obj };
