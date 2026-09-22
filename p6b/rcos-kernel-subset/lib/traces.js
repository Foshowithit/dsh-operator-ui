'use strict';

// Outcome traces: the accumulating (task context -> capability -> outcome)
// dataset. The registry stays the promotion SSOT; traces are append-only and
// never rewritten — they are the corpus a future router learns from. A trace
// line is written on EVERY eval-submit; backfilled lines are flagged so the
// learnable fraction stays honest.

const fs = require('node:fs');
const path = require('node:path');

const TRACE_SCHEMA = 'rcos-trace/1';
const SOURCES = ['reuse', 'synthesize'];
const VERDICTS = ['ship', 'fix', 'blocked'];

function tracesPath(homeDir) {
  return path.join(homeDir, 'traces', 'traces.jsonl');
}

function appendTrace(homeDir, t) {
  if (!t || !t.capability || !t.task_id || !t.verdict) {
    throw new Error('trace needs capability, task_id, verdict');
  }
  if (!VERDICTS.includes(t.verdict)) {
    throw new Error('trace verdict must be one of ' + VERDICTS.join('|'));
  }
  if (t.source !== undefined && t.source !== null && !SOURCES.includes(t.source)) {
    throw new Error('trace source must be one of ' + SOURCES.join('|') + ' (or omitted)');
  }
  const rec = {
    schema: TRACE_SCHEMA,
    ts: new Date().toISOString(),
    capability: t.capability,
    task_id: t.task_id,
    verdict: t.verdict,
    context: t.context === undefined ? null : t.context,
    source: t.source === undefined ? null : t.source,
    seconds: t.seconds === undefined ? null : t.seconds,
    backfilled: t.backfilled === undefined ? false : t.backfilled,
    date: t.date === undefined ? null : t.date
  };
  fs.mkdirSync(path.join(homeDir, 'traces'), { recursive: true });
  fs.appendFileSync(tracesPath(homeDir), JSON.stringify(rec) + '\n');
  return rec;
}

function loadTraces(homeDir) {
  const p = tracesPath(homeDir);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// reuse_count is DERIVED, never edited: a reuse is a trace line with
// source=reuse. Backfilled lines are excluded on purpose — they were
// reconstructed FROM the registry, so counting them would let the registry
// certify itself. This is the only source of truth for how often a capability
// was actually reused; the registry field is a cache of this function.
function deriveReuseCounts(traces) {
  const counts = {};
  for (const t of traces) {
    if (t.source !== 'reuse' || t.backfilled === true) continue;
    counts[t.capability] = (counts[t.capability] || 0) + 1;
  }
  return counts;
}

// Absent traces file = a fresh home (nothing to verify against) — callers use
// this to distinguish "unverifiable" from "verified empty".
function hasTraceFile(homeDir) {
  return fs.existsSync(tracesPath(homeDir));
}

// Every registry eval should have at least one trace line. Returns human-
// readable gap descriptions (empty list = consistent). Eval entries carry no
// per-eval date, so the dedupe key is (capability, task_id).
function traceGaps(reg, traces) {
  const seen = new Set(traces.map((t) => t.capability + '\u0000' + t.task_id));
  const gaps = [];
  for (const c of reg.capabilities) {
    for (const e of c.evals) {
      if (!seen.has(c.id + '\u0000' + e.task_id)) {
        gaps.push('\'' + c.id + '\': no trace line for eval ' + e.task_id);
      }
    }
  }
  return gaps;
}

module.exports = { TRACE_SCHEMA, SOURCES, VERDICTS, tracesPath, appendTrace, loadTraces, traceGaps, deriveReuseCounts, hasTraceFile };
