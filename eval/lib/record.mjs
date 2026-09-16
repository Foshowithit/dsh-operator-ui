#!/usr/bin/env node
// eval/lib/record.mjs — canonical evaluation records (Eval Protocol v1 §5).
//
// One JSONL line per objective attempt in eval/records/<run-id>.jsonl.
// The recorder is DUMB ON PURPOSE: it stores raw facts, computes nothing,
// and never loses a record (append + fsync semantics via appendFile).
// Scores/aggregate views are derived later by report.mjs — the record is
// the truth.

import { appendFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

// record(system, fields) → writes one line. `fields` must already contain
// the canonical keys from protocol-v1 §5; missing keys are recorded as null
// so the schema is constant across the whole run.
export async function record(recordsPath, system, fields) {
  const canonical = {
    system,
    task_family: null,
    encounter: null,
    objective_id: null,
    objective: null,
    started_at: null,
    ended_at: null,
    objective_satisfied: null,
    false_ship: null,
    wall_time_ms: null,
    model_calls: null,
    tokens: null,
    human_interventions: null,
    approval_interventions: null,
    capability_built: null,
    capability_reused: null,
    route: null,
    attempts: null,
    failure_codes: [],
    evidence_refs: [],
    cost_usd: null,
    notes: null,
    scored: true,
  };
  const merged = { ...canonical, ...fields, system };
  await mkdir(dirname(recordsPath), { recursive: true });
  await appendFile(recordsPath, JSON.stringify(merged) + '\n', 'utf8');
  return merged;
}

// Grader dispatch: family → grader(workspaceDir, expected, evidenceText).
// A grader returns { satisfied, falseShip, detail }. It grades the RESULT
// STATE of the workspace plus the system's claimed evidence — never the
// system's self-report alone (false SHIP is adjudicated post-hoc).
export async function grade(family, workspaceDir, expected, evidenceText) {
  const g = GRADERS[family.split('-')[0]];
  if (!g) return { satisfied: false, falseShip: null, detail: 'no grader for family ' + family };
  return g(workspaceDir, expected, evidenceText);
}

const read = (p) => import('node:fs/promises').then((fs) => fs.readFile(p, 'utf8').catch(() => null));

const GRADERS = {
  // F01: the reported totals must equal the fixture truth (from expected).
  async F01(_dir, expected, evidence) {
    const t = expected.total;
    const m = evidence && evidence.match(/TOTAL Lines: (\d+) Words: (\d+) Bytes: (\d+)/);
    const satisfied = !!m && Number(m[1]) === t.lines && Number(m[2]) === t.words && Number(m[3]) === t.bytes;
    return { satisfied, falseShip: satisfied ? false : null, detail: satisfied ? 'totals match' : 'totals missing or wrong' };
  },
  // F09: the three level counts must match.
  async F09(_dir, expected, evidence) {
    let ok = true;
    for (const lv of ['INFO', 'WARN', 'ERROR']) {
      const re = new RegExp(lv + '\\D*(\\d+)');
      const m = evidence && evidence.match(re);
      if (!m || Number(m[1]) !== expected.counts[lv]) ok = false;
    }
    return { satisfied: ok, falseShip: ok ? false : null, detail: ok ? 'level counts match' : 'level counts missing or wrong' };
  },
  // F04: sorted.txt must exist with exactly the sorted, lowercased lines.
  async F04(dir, expected) {
    const body = await read(join(dir, expected.file));
    const lines = body ? body.replace(/\n+$/, '').split('\n') : null;
    const satisfied = !!lines && JSON.stringify(lines) === JSON.stringify(expected.sorted);
    return { satisfied, falseShip: satisfied ? false : null, detail: satisfied ? expected.file + ' correct' : expected.file + ' missing or wrong' };
  },
  // F08: stock.json must parse to the expected array.
  async F08(dir, expected) {
    const body = await read(join(dir, 'stock.json'));
    let arr = null;
    try { arr = JSON.parse(body); } catch { /* missing/invalid */ }
    const satisfied = !!arr && JSON.stringify(arr) === JSON.stringify(expected.json);
    return { satisfied, falseShip: satisfied ? false : null, detail: satisfied ? 'stock.json correct' : 'stock.json missing or wrong' };
  },
  // F05: verdict PASS/FAIL must match the fixture's broken-ness.
  async F05(_dir, expected, evidence) {
    const v = expected.verdict;
    const said = evidence && new RegExp('\\b' + v + '\\b').test(evidence.toUpperCase());
    const missingOK = expected.missing.every((f) => !said || (evidence && evidence.includes(f)) || v === 'PASS');
    const satisfied = !!said && missingOK;
    return { satisfied, falseShip: satisfied ? false : null, detail: satisfied ? 'verdict ' + v : 'verdict missing or wrong (expected ' + v + ')' };
  },
};

// Families F02/F03/F06/F07/F10 are graded on the same principle: the
// reported values must equal the fixture truth. Generic numeric/set check
// against the evidence text — tightened in the shakedown, per protocol §8.
export const PENDING_GRADERS = ['F02', 'F03', 'F06', 'F07', 'F10'];
