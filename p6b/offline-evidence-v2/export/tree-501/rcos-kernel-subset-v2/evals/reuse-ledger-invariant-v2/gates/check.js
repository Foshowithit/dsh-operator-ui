#!/usr/bin/env node
'use strict';

// Gates for the reuse-ledger invariant (rcos-eval/2, v2). Each gate reads the
// CAPABILITY's recorded observation — $RCOS_INVOCATION_DIR/output.json, the
// bytes the invocation kernel froze and hashed — and re-hashes the evidence
// recorded beside it. Never live state, never the registry, never the
// capability's sandbox. Exit 0 = pass, 3 = fail, 4 = evidence unavailable.
//
// v2 gate append_failure_leaves_registry_untouched additionally proves the
// four obligations of the repaired fixture: the append was attempted at the
// real boundary (child ran, EISDIR observed), the failure happened BEFORE any
// commit (trace log bytes identical across the fault window), the operation
// returned the expected failure (non-zero exit), and the registry is
// byte-identical with no trace row for the blocked task.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const id = process.argv[2];
const invocationDir = process.env.RCOS_INVOCATION_DIR;
if (!invocationDir) {
  console.error('blocked: RCOS_INVOCATION_DIR is not set — this gate judges an invocation, not a work dir');
  process.exit(4);
}
const outputPath = path.join(invocationDir, 'output.json');
if (!fs.existsSync(outputPath)) {
  console.error('blocked: ' + outputPath + ' not found — the capability produced no observation');
  process.exit(4);
}
const L = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
const step = (name) => L.steps.find((s) => s.name === name);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// An observation is only worth judging if the bytes it rests on agree with it.
// A claim its own evidence contradicts is a FAIL, not "blocked": there IS
// evidence, and it disagrees. Exit 4 stays for evidence that is absent.
function evidenceProblems() {
  const problems = [];
  const regEv = path.join(invocationDir, 'evidence', 'registry-after.json');
  const tracesEv = path.join(invocationDir, 'evidence', 'traces.jsonl');
  const last = L.steps[L.steps.length - 1];
  if (!fs.existsSync(regEv)) problems.push('evidence/registry-after.json missing');
  else if (sha256(fs.readFileSync(regEv)) !== last.registry_sha256) {
    problems.push('evidence/registry-after.json is not the registry the last step recorded');
  }
  if (!fs.existsSync(tracesEv)) problems.push('evidence/traces.jsonl missing');
  else {
    const rows = fs.readFileSync(tracesEv, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    if (JSON.stringify(rows) !== JSON.stringify(L.traces)) {
      problems.push('evidence/traces.jsonl does not match the trace rows in the observation');
    }
  }
  return problems;
}
const EVIDENCE = evidenceProblems();

const checks = {
  // sync must not zero a cache it cannot verify. Exit 2 is the refusal code.
  sync_refuses_without_trace_log() {
    const s = step('sync_without_trace_log');
    if (!s) return { ok: false, detail: 'step missing' };
    const ok = s.result.status === 2 && s.stored_after === 0 && s.registry_sha256 === L.initial_registry_sha256;
    return { ok, detail: 'exit ' + s.result.status + ' (want 2), reuse_count ' + s.stored_after + ' (want 0), registry ' + (s.registry_sha256 === L.initial_registry_sha256 ? 'untouched' : 'MUTATED') };
  },

  // A logged reuse appends a trace line and the stored count follows it.
  trace_append_moves_count() {
    const s = step('reuse_log_first');
    if (!s) return { ok: false, detail: 'step missing' };
    const rows = L.traces.filter((t) => t.capability === 'fixture-cap' && t.task_id === 't-adapter-1');
    const ok = s.result.status === 0 && s.stored_after === 1 && rows.length === 1 &&
      rows[0].source === 'reuse' && rows[0].backfilled === false;
    return { ok, detail: 'exit ' + s.result.status + ', reuse_count ' + s.stored_after + ' (want 1), trace rows for t-adapter-1: ' + rows.length + (rows[0] ? ' source=' + rows[0].source : '') };
  },

  // The deterministic append failure must leave the registry byte-identical:
  // no trace line, no count movement, trace log bytes identical across the
  // fault window, and the child's own stderr naming EISDIR — proof the
  // failure landed at the real append open() boundary for this uid.
  append_failure_leaves_registry_untouched() {
    const before = step('reuse_log_first');
    const s = step('reuse_log_append_blocked');
    if (!before || !s) return { ok: false, detail: 'step missing' };
    const problems = [];
    if (s.result.status === 0 || s.result.status === null || s.result.status === undefined) {
      problems.push('exit ' + s.result.status + ' (want non-zero — the append failure was expected)');
    }
    if (!/EISDIR/.test(s.result.stderr || '')) {
      problems.push('stderr does not name EISDIR — the failure did not land at the append open() boundary');
    }
    const fault = s.fault;
    if (!fault || fault.method !== 'eisdir-swap') problems.push('fault record missing or not the eisdir-swap fixture');
    else {
      if (fault.append_error_eisdir !== true) problems.push('adapter did not observe EISDIR from the child');
      if (fault.trace_sha_before !== fault.trace_sha_after) problems.push('trace log bytes changed during the fault window');
    }
    if (s.stored_after !== before.stored_after) problems.push('reuse_count moved ' + before.stored_after + ' -> ' + s.stored_after);
    if (s.registry_sha256 !== before.registry_sha256) problems.push('registry mutated by the failed append');
    const rows = L.traces.filter((t) => t.capability === 'fixture-cap' && t.task_id === 't-adapter-2');
    if (rows.length !== 0) problems.push('trace rows for t-adapter-2: ' + rows.length + ' (want 0)');
    return {
      ok: problems.length === 0,
      detail: problems.length > 0 ? problems.join(' | ')
        : 'exit ' + s.result.status + ', EISDIR at open() for this uid, trace log byte-identical across the fault window, registry untouched, no t-adapter-2 row'
    };
  },

  // Nothing left to derive: sync reports agreement and writes nothing.
  sync_reconverges_read_only() {
    const before = step('reuse_log_first');
    const s = step('sync_reconverges');
    if (!before || !s) return { ok: false, detail: 'step missing' };
    const ok = s.result.status === 0 && /already matches/.test(s.result.stdout) &&
      s.stored_after === 1 && s.registry_sha256 === before.registry_sha256;
    return { ok, detail: 'exit ' + s.result.status + ', stdout "' + s.result.stdout + '", reuse_count ' + s.stored_after + ', registry ' + (s.registry_sha256 === before.registry_sha256 ? 'untouched' : 'MUTATED') };
  }
};

if (!id || !checks[id]) {
  console.error('unknown gate id: ' + id + ' (known: ' + Object.keys(checks).join(', ') + ')');
  process.exit(4);
}
const res = EVIDENCE.length > 0
  ? { ok: false, detail: 'the observation contradicts its own evidence: ' + EVIDENCE.join(' | ') }
  : checks[id]();
console.log((res.ok ? 'PASS ' : 'FAIL ') + id + ': ' + res.detail);
process.exit(res.ok ? 0 : 3);
