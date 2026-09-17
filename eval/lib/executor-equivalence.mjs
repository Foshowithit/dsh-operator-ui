#!/usr/bin/env node
// eval/lib/executor-equivalence.mjs — GPT-directed executor-equivalence
// receipt: one frozen acquired workflow + one multi-node/dependency
// workflow, executed on local-dag-runner (:13092) and REAL Archon v0.10.1
// (:13091) against the SAME frozen YAML + fixture. Zero model calls, zero
// revision. Compares: terminal state, node ordering, grading-relevant node
// outputs, workspace/artifact delta, external grader result.

import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRADERS_V2 } from './graders-v2.mjs';
const { D05, D12 } = GRADERS_V2;

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WS = '/private/tmp/opui-rc0-folder';
const WF_DIR = '/tmp/opui-rc0-archon/workflows';
const SHIM = 'http://127.0.0.1:13092';
const REAL = 'http://127.0.0.1:13091';
const sha = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

const CASES = [
  {
    label: 'ordinary (multi-file join)',
    family: 'D05-order-join',
    enc: 'encounter-1',
    workflow: 'join-orders-prices-v0-1-0',
    yaml: join(root, 'eval', 'records', 'acq-v3-breadth', 'D05-rev0-d80175ae7158.yaml'),
    grader: D05,
  },
  {
    label: 'dependency/recovery family (dep graph)',
    family: 'D12-dep-graph',
    enc: 'encounter-1',
    workflow: 'acq3-d12-mu4vgg92-r2-v0-1-0',
    yaml: join(root, 'eval', 'records', 'acq-v3-breadth', 'D12-rev2-82fd638fbddd.yaml'),
    grader: D12,
  },
];

async function stageFixture(famDir) {
  await rm(WS, { recursive: true, force: true });
  await mkdir(WS, { recursive: true });
  execFileSync('cp', ['-R', join(root, 'eval', 'devsuite-v5', famDir.dir) + '/.', WS + '/']);
}

async function workspaceState() {
  const files = [];
  async function walk(d, rel) {
    let list = [];
    try { list = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(join(d, e.name), r);
      else {
        let body = null;
        try { body = await readFile(join(d, e.name), 'utf8'); } catch {}
        files.push({ path: r, sha256: body === null ? null : sha(body), bytes: body === null ? null : Buffer.byteLength(body) });
      }
    }
  }
  await walk(WS, '');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function runOn(executorUrl, workflow, message) {
  await fetch(executorUrl + '/api/workflows/' + encodeURIComponent(workflow) + '/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, conversationId: 'equiv-' + Date.now() }),
  });
  const deadline = Date.now() + 90000;
  let entry = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const lb = await (await fetch(executorUrl + '/api/workflows/runs?limit=10')).json();
      entry = (lb.runs || []).find((x) => x.workflow_name === workflow) || null;
      if (entry && ['completed', 'failed', 'error', 'cancelled'].includes(String(entry.status || '').toLowerCase())) break;
    } catch { /* keep polling */ }
  }
  const detail = await (await fetch(executorUrl + '/api/workflows/runs/' + entry.id)).json();
  // node identity: real Archon exposes it as event.step_name; the shim as
  // data.node (receipt-instrument fix, first equivalence pass read neither).
  // Real Archon emits node_started + node_completed pairs; the shim one
  // event per node. Node ORDER is taken from completions only.
  const events = (detail.events || [])
    .filter((e) => (e.event_type ? e.event_type === 'node_completed' : true))
    .map((e) => ({ output: (e.data || {}).node_output ?? null, node: e.step_name ?? (e.data || {}).node ?? null }));
  return { status: String(entry.status || 'UNKNOWN').toLowerCase(), outputs: events.map((e) => e.output).filter(Boolean).join('\n'), nodeOrder: events.map((e) => e.node).filter(Boolean), runId: entry.id };
}

const receipt = { generated_at: new Date().toISOString(), cases: [] };
for (const c of CASES) {
  const fixture = join(root, 'eval', 'devsuite-v5', c.family, c.enc);
  const objective = (await readFile(join(fixture, 'objective.txt'), 'utf8')).trim();
  const expected = JSON.parse(await readFile(join(fixture, 'expected.json'), 'utf8'));
  await writeFile(join(WF_DIR, c.workflow + '.yaml'), await readFile(c.yaml, 'utf8'), 'utf8');
  await new Promise((r) => setTimeout(r, 3000)); // hot-reload both executors

  const results = {};
  for (const [label, url] of [['local_dag_runner', SHIM], ['real_archon_0_10_1', REAL]]) {
    await stageFixture({ dir: join(c.family, c.enc, 'workspace') });
    const before = await workspaceState();
    const run = await runOn(url, c.workflow, objective);
    const after = await workspaceState();
    const grader = c.grader(expected, run.outputs, after);
    const delta = after.filter((f) => !before.some((b) => b.path === f.path && b.sha256 === f.sha256)).map((f) => ({ path: f.path, sha256: f.sha256, changes: before.some((b) => b.path === f.path) ? 'modified' : 'created' }));
    results[label] = { terminal: run.status, nodeOrder: run.nodeOrder, outputs: run.outputs, grader: { satisfied: grader.satisfied, detail: grader.detail }, delta };
  }

  const [a, b] = [results.local_dag_runner, results.real_archon_0_10_1];
  const agree = {
    terminal: a.terminal === b.terminal,
    node_order: JSON.stringify(a.nodeOrder) === JSON.stringify(b.nodeOrder),
    grading_relevant_outputs: a.outputs.trim() === b.outputs.trim(),
    workspace_delta: JSON.stringify(a.delta) === JSON.stringify(b.delta),
    grader_result: a.grader.satisfied === b.grader.satisfied,
  };
  receipt.cases.push({
    label: c.label, family: c.family, workflow: c.workflow, objective,
    local_dag_runner: a, real_archon_0_10_1: b, agree,
    all_agree: Object.values(agree).every(Boolean),
  });
  console.log(`\n== ${c.workflow} (${c.label})`);
  console.log('   shim :', a.terminal, '| grader:', a.grader.satisfied, '| nodes:', a.nodeOrder.join('>'));
  console.log('   real :', b.terminal, '| grader:', b.grader.satisfied, '| nodes:', b.nodeOrder.join('>'));
  console.log('   agree:', JSON.stringify(agree));
}

receipt.verdict = receipt.cases.every((c) => c.all_agree) ? 'EQUIVALENT — all five axes agree on every case' : 'MISMATCH — executor compatibility defect';
const out = join(root, 'eval', 'records', 'executor-equivalence.json');
await writeFile(out, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
console.log('\nverdict:', receipt.verdict);
console.log('receipt:', out);
