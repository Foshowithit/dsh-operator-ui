#!/usr/bin/env node
'use strict';
// Adapter for the reuse-ledger capability.
//
// Domain work: exercise the reuse-ledger invariant against a SANDBOX home
// inside the invocation's work dir. The probe has to be able to make a trace
// append fail on purpose, so it must never touch the caller's RCOS_HOME.
//
// Kernel interface (lib/invocation.js): the input document is at $RCOS_INPUT,
// the result goes to $RCOS_OUTPUT, supporting files go under $RCOS_EVIDENCE_DIR.
// Exit 4 = could not run; exit 0 = ran and wrote a result. This adapter forms no
// opinion about whether the ledger behaved well — the gates do that.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const inputPath = process.env.RCOS_INPUT;
const outputPath = process.env.RCOS_OUTPUT;
const evidenceDir = process.env.RCOS_EVIDENCE_DIR;
const rcos = process.env.RCOS_BIN;
const work = process.cwd();

function cannotRun(msg) { console.error(msg); process.exit(4); }

if (!inputPath || !outputPath || !rcos) {
  cannotRun('adapter needs RCOS_INPUT, RCOS_OUTPUT and RCOS_BIN in the environment');
}
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
if (typeof input.seed_registry !== 'string' || typeof input.probe_capability !== 'string') {
  cannotRun('input needs seed_registry and probe_capability');
}
if (!fs.existsSync(input.seed_registry)) {
  cannotRun('seed_registry does not exist: ' + input.seed_registry);
}
const sandboxName = input.sandbox === undefined ? 'sandbox-home' : input.sandbox;
if (sandboxName !== path.basename(sandboxName)) cannotRun('sandbox must be a single directory name');

const home = path.join(work, sandboxName);
const regPath = path.join(home, 'registry', 'capability-registry.json');
const tracesPath = path.join(home, 'traces', 'traces.jsonl');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function registry() { return JSON.parse(fs.readFileSync(regPath, 'utf8')); }
function probeEntry() {
  const c = registry().capabilities.find((x) => x.id === input.probe_capability);
  if (!c) cannotRun('seed registry has no capability \'' + input.probe_capability + '\'');
  return c;
}
function traceRows() {
  if (!fs.existsSync(tracesPath)) return [];
  return fs.readFileSync(tracesPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
function rcosRun(...argv) {
  const r = spawnSync(rcos, argv, { env: Object.assign({}, process.env, { RCOS_HOME: home }), encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

fs.mkdirSync(path.join(home, 'registry'), { recursive: true });
fs.copyFileSync(input.seed_registry, regPath);
probeEntry(); // refuse early if the seed registry cannot answer the probe
const initialRegistrySha = sha(regPath);

const steps = [];
function step(name, result) {
  const record = {
    name,
    result,
    stored_after: probeEntry().reuse_count,
    registry_sha256: sha(regPath),
    trace_lines: traceRows().length
  };
  steps.push(record);
  return record;
}

// 1. No trace log yet: sync must REFUSE rather than zero the cache. A cache
//    with nothing to verify against is unverifiable, not empty.
step('sync_without_trace_log', rcosRun('sync'));

// 2. A reuse appends a trace line and the count follows the trace.
step('reuse_log_first', rcosRun('reuse-log', '--id', input.probe_capability, '--task', 't-adapter-1',
  '--run', '20260917T120000Z-aaaaaa', '--verdict', 'ship'));

// 3. Freeze the trace log (read-only file): the append now fails. The registry
//    must be left exactly as it was — trace first, registry second.
fs.chmodSync(tracesPath, 0o444);
step('reuse_log_append_blocked', rcosRun('reuse-log', '--id', input.probe_capability, '--task', 't-adapter-2',
  '--run', '20260917T120001Z-bbbbbb', '--verdict', 'ship'));
fs.chmodSync(tracesPath, 0o644);

// 4. With the trace log intact again, sync must find nothing to change: the
//    cache already equals the trace-derived count.
step('sync_reconverges', rcosRun('sync'));

const traces = traceRows();
const observation = {
  schema: 'reuse-ledger-observation/1',
  probe_capability: input.probe_capability,
  sandbox_home: home,
  initial_registry_sha256: initialRegistrySha,
  steps,
  traces
};
fs.writeFileSync(outputPath, JSON.stringify(observation, null, 2) + '\n');

// Evidence: the bytes the conclusion rests on — the registry as it ended up,
// the trace log, and the per-step record. The kernel hashes and lists these;
// it does not judge them.
fs.mkdirSync(evidenceDir, { recursive: true });
fs.copyFileSync(regPath, path.join(evidenceDir, 'registry-after.json'));
if (fs.existsSync(tracesPath)) fs.copyFileSync(tracesPath, path.join(evidenceDir, 'traces.jsonl'));
fs.writeFileSync(path.join(evidenceDir, 'steps.json'), JSON.stringify(steps, null, 2) + '\n');

// The one claim this adapter makes about its own run, as an emission file the
// kernel classifies: the probe completed, and the registry it ended with. The
// invocation id is derived from the evidence dir's own path, not an env var —
// if the two ever disagree, the kernel skips the claim and says why.
fs.writeFileSync(path.join(evidenceDir, 'probe.emission.json'), JSON.stringify({
  fields: {
    subject: 'reuse-ledger-probe/' + input.probe_capability,
    predicate: 'probe_completed',
    value: {
      probe_capability: input.probe_capability,
      steps: steps.length,
      final_registry_sha256: sha(regPath),
      final_reuse_count: probeEntry().reuse_count
    },
      truth_class: 'observation',
      source: { kind: 'action', ref: 'probe executed inside this invocation' },
      observed_at: new Date().toISOString()
  },
  producer: {
    capability_id: process.env.RCOS_CAPABILITY_ID,
    capability_version: process.env.RCOS_CAPABILITY_VERSION,
    invocation_id: path.basename(path.dirname(evidenceDir))
  }
}, null, 2) + '\n');

console.log('sandbox home: ' + home);
for (const s of steps) console.log('  ' + s.name + ': exit ' + s.result.status + ', reuse_count ' + s.stored_after);
process.exit(0);
