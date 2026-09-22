'use strict';
// P6B runner v-next — evidence-first evaluation sequence.
//
// GPT ruling (RUN #2 CLOSED · OFFLINE REPAIR GO, 2026-09-22), verbatim order:
//   Execute -> Capture status -> Retrieve evidence -> Verify -> Classify -> Cleanup
// An expected evaluation failure (exit 3, verdict "fix") must NOT bypass
// artifact collection or independent verification. The runner retrieves the
// original receipt and available artifacts regardless of whether the
// evaluation returns ship, fix, or blocked, distinguishes a valid receipt
// describing failed work from a missing/corrupted/unverifiable one, and runs
// cleanup unconditionally.
//
// Partial-success retrieval (GPT ruling, P6B v2 A+B, 2026-09-22): when
// receipt.json is available but checks.json is missing, preserve the original
// receipt and classify the missing diagnostic artifact explicitly
// (diagnostics_missing) instead of discarding the whole run as unverifiable.
// For future live execution, original evidence must be retrieved BEFORE the
// worker is destroyed, including when the evaluation exits nonzero.
//
// Everything is injectable so the whole sequence is exercisable offline with
// an injected failure — no live sandbox. This module does not modify the
// frozen package; it is the candidate runner repair only.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const RECEIPT_SCHEMA = 'rcos-run-receipt/1';
export const PHASE_ORDER = ['execute', 'capture', 'retrieve', 'verify', 'classify', 'cleanup'];

// Classify the (exec, receipt, verification) triple. A receipt that exists,
// parses, matches schema, re-hashes clean, and agrees with the process exit
// code is VALID — its verdict stands even when the verdict is failure.
// Anything else is a runner-side finding that must not be confused with an
// honest "the work failed" answer.
export function classify(exec, retrieved, verification) {
  const exit = exec && typeof exec.status === 'number' ? exec.status : null;
  const execError = exec && exec.error ? exec.error : null;
  const base = { exit, exec_error: execError };
  // Partial success travels WITH the classification: a receipt that verified
  // clean still carries the record of which diagnostic artifacts were absent,
  // so a missing checks.json is named instead of swallowed — and never used to
  // discard the receipt itself.
  const diag = new Set();
  if (retrieved && Array.isArray(retrieved.diagnostics_missing)) {
    for (const d of retrieved.diagnostics_missing) diag.add(d);
  }
  if (verification && Array.isArray(verification.diagnostics_missing)) {
    for (const d of verification.diagnostics_missing) diag.add(d);
  }
  if (diag.size > 0) base.diagnostics_missing = Array.from(diag);

  if (!retrieved || retrieved.state === 'missing') {
    return Object.assign({}, base, { kind: 'receipt-missing' });
  }
  if (retrieved.state === 'corrupt') {
    return Object.assign({}, base, { kind: 'receipt-corrupt', reason: retrieved.reason || null });
  }
  if (retrieved.state === 'unavailable') {
    return Object.assign({}, base, {
      kind: 'receipt-unverifiable', problems: [retrieved.reason || 'retrieval failed']
    });
  }
  if (!verification || verification.state !== 'ok') {
    return Object.assign({}, base, {
      kind: 'receipt-unverifiable',
      problems: (verification && verification.problems) || ['verification did not run']
    });
  }

  const receipt = retrieved.receipt;
  const verdict = receipt.verdict;
  const expectedExit = verdict === 'ship' ? 0 : verdict === 'fix' ? 3 : verdict === 'blocked' ? 4 : null;
  if (expectedExit === null) {
    return Object.assign({}, base, { kind: 'receipt-corrupt', reason: 'unknown verdict: ' + String(verdict) });
  }
  if (exit !== null && exit !== expectedExit) {
    return Object.assign({}, base, {
      kind: 'receipt-exit-disagreement', verdict, expected_exit: expectedExit
    });
  }
  if (verdict === 'ship') return Object.assign({}, base, { kind: 'evaluation-passed', verdict });
  // A valid receipt describing failed work: the evaluation answered, the
  // answer is fix/blocked. This is a result, not a runner error.
  return Object.assign({}, base, { kind: 'valid-receipt-failed-work', verdict });
}

// The full sequence. Phases run in the ruling's order; cleanup runs in
// `finally` so no classification outcome — or thrown retrieve/verify — can
// skip it. Failures inside cleanup are RECORDED (cleanupError), never thrown
// over the classification the caller needs.
export async function runEvaluation({ exec, retrieve, verify, cleanup }) {
  const record = { phases: [], exec: null, retrieved: null, verification: null, classification: null, cleanup: null, cleanupError: null };

  try {
    record.phases.push('execute');
    try {
      record.exec = await exec();
    } catch (err) {
      record.exec = { status: null, error: String((err && err.message) || err) };
    }

    record.phases.push('capture');
    // capture = the normalized exec outcome above; no verdict decisions here.

    // A retrieval or verification crash is itself a classifiable finding —
    // it must reach classify() (as unverifiable) instead of escaping past
    // the caller, or the run would end with no verdict record at all.
    record.phases.push('retrieve');
    try {
      record.retrieved = await retrieve(record.exec);
    } catch (err) {
      record.retrieved = { state: 'unavailable', receipt: null, reason: 'retrieval failed: ' + String((err && err.message) || err) };
    }

    record.phases.push('verify');
    try {
      record.verification = await verify(record.retrieved);
    } catch (err) {
      record.verification = { state: 'failed', problems: ['verification failed: ' + String((err && err.message) || err)] };
    }

    record.phases.push('classify');
    record.classification = classify(record.exec, record.retrieved, record.verification);
    return record;
  } finally {
    record.phases.push('cleanup');
    try {
      record.cleanup = await cleanup();
    } catch (err) {
      record.cleanupError = String((err && err.message) || err);
    }
  }
}

function within(runDir, rel) {
  const base = path.resolve(runDir);
  const p = path.resolve(base, rel);
  return p === base || p.startsWith(base + path.sep);
}

// Retrieve receipt + artifacts from a real run dir. state is one of
// ok | missing | corrupt — the distinction the ruling requires.
export function fsRetrieve(runDir) {
  return async function retrieve() {
    const receiptPath = path.join(runDir, 'receipt.json');
    if (!fs.existsSync(receiptPath)) return { state: 'missing', receipt: null, runDir };
    let receipt;
    try {
      receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    } catch (err) {
      return { state: 'corrupt', receipt: null, runDir, reason: 'receipt.json is not valid JSON: ' + err.message };
    }
    if (!receipt || typeof receipt !== 'object') {
      return { state: 'corrupt', receipt: null, runDir, reason: 'receipt.json is not an object' };
    }
    if (receipt.schema !== RECEIPT_SCHEMA) {
      return { state: 'corrupt', receipt: null, runDir, reason: 'receipt schema must be ' + RECEIPT_SCHEMA + ', got ' + String(receipt.schema) };
    }
    if (typeof receipt.verdict !== 'string' || !Array.isArray(receipt.artifacts)) {
      return { state: 'corrupt', receipt: null, runDir, reason: 'receipt missing verdict or artifacts list' };
    }
    // Partial success: the receipt survived — record which diagnostic artifact
    // is absent so classification can name it rather than discard the run.
    const diagnostics_missing = fs.existsSync(path.join(runDir, 'checks.json')) ? [] : ['checks.json'];
    return { state: 'ok', receipt, runDir, diagnostics_missing };
  };
}

// Independent re-hash of every artifact the receipt names (eval-verify
// semantics, runnable on a retrieved receipt alone). Artifact paths must stay
// inside the run dir — a receipt naming ../../etc is unverifiable, not a
// licence to read it.
export function fsVerify() {
  return async function verify(retrieved) {
    if (!retrieved || retrieved.state !== 'ok') {
      return { state: 'skipped', problems: ['no valid receipt to verify'] };
    }
    const problems = [];
    const diagnostics_missing = [];
    for (const a of retrieved.receipt.artifacts) {
      const rel = a && a.path;
      if (typeof rel !== 'string' || !within(retrieved.runDir, rel)) {
        problems.push('artifact path escapes run dir: ' + String(rel));
        continue;
      }
      const p = path.join(retrieved.runDir, rel);
      if (!fs.existsSync(p)) {
        // checks.json is a DIAGNOSTIC artifact: its absence is classified
        // explicitly, not treated as a discarded run. Every other artifact the
        // receipt lists but the disk lacks is still a hard failure, and a
        // checks.json that EXISTS but fails its hash still hard-fails.
        if (rel === 'checks.json') { diagnostics_missing.push('checks.json'); continue; }
        problems.push('missing artifact: ' + rel);
        continue;
      }
      const sha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      if (sha !== a.sha256) problems.push('hash mismatch: ' + rel);
      if (typeof a.bytes === 'number' && fs.statSync(p).size !== a.bytes) problems.push('size mismatch: ' + rel);
    }
    return problems.length
      ? { state: 'failed', problems, diagnostics_missing }
      : { state: 'ok', problems: [], diagnostics_missing };
  };
}
