// dsh-operator-ui — GoalRunner v1.
//
// objective -> ROUTE -> AUTHORITY -> EXECUTE -> EVIDENCE -> CAPABILITY
// VALIDATION -> OBJECTIVE EVALUATION -> VERDICT.
//
// Three truths stay separate:
//   execution completed != capability validated != objective satisfied.
// SHIP is earned only when all three are supported by evidence.
// Executed task identity is durable through an explicit, persisted
// conversation association (lib/conversation.js): the dispatch conversation id
// is what Archon returned when the conversation was provisioned — never
// derived from the task id, and re-verified immediately before every dispatch.
//
// The operator layer sits on top of the three truths and never blurs them:
// the trust ladder names the truth each rung vouches for, and a Next Action
// suggests the single operator move that unblocks the goal (it never
// auto-executes).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolveConfig } from './config.js';
import { requiresOf, decisionFor } from './authority.js';
import { upsertTask, envelopeFromGoal, getTask, peekTask, listTasks, forkTaskId } from './tasks.js';
import { admitTask, evaluateObjective, buildClaim, runWorkflowName, verifyParentLinkage, excludeRequestEcho, EVIDENCE_CONTRACT_VERSION } from './task-truth.js';
import { requireDispatchableConversation, associatedConversationId, provisionConversation } from './conversation.js';
import { resolveWorkspace } from './workspace.js';
import { LOCAL_ENVIRONMENT_ID, resolveEnvironment, requireEnvironmentForOwner, requireEnvironmentAdapter, requireOrchestratorProtocol, environmentTransport, localTransport, executionIdentityFromRun, receiptEnvironment } from './environments.js';
import { verifyBridgeReceipt, loadBridgeReceipt, BRIDGE_ID_FIND } from './bridge-receipt.js';
import { isTerminalRunStatus } from './run-status.js';

const sha256 = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const isoNow = () => new Date().toISOString();

// Every outbound call on the goal path goes through an environment transport.
// The timeout floor is defensive: an adapter that declares no usable timeout
// still gets a bounded wait rather than an AbortSignal built from undefined.
const transportTimeout = (tp, floor) => {
  const n = Number(tp && tp.timeoutMs);
  const ms = Number.isFinite(n) && n > 0 ? n : 30000;
  return floor ? Math.max(ms, floor) : ms;
};

const STOPWORDS = new Set(['the', 'a', 'an', 'in', 'on', 'of', 'to', 'for', 'and', 'or', 'my', 'me', 'it', 'is', 'are', 'this', 'that', 'with', 'give', 'do', 'rcos', 'please']);

export function tokenize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export function routeObjective(objective, registry) {
  const caps = registry && Array.isArray(registry.capabilities) ? registry.capabilities : [];
  const objTokens = new Set(tokenize(objective));
  const scored = [];
  for (const c of caps) {
    if (c.seed === true) continue;
    const hay = tokenize([c.id, c.name, c.description, (c.tags || []).join(' ')].join(' '));
    let hits = 0;
    for (const t of objTokens) if (hay.includes(t)) hits++;
    const score = objTokens.size ? hits / Math.max(objTokens.size, 1) : 0;
    const reasons = [];
    if (c.workflow) reasons.push('implements workflow ' + c.workflow);
    if (score > 0) reasons.push('matched ' + hits + '/' + objTokens.size + ' objective terms');
    else reasons.push('no objective terms matched');
    if (c.status === 'retired') reasons.push('lifecycle RETIRED');
    scored.push({ capability: c, score, hits, reasons });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored.find((s) => s.capability.workflow) || null;
  const decision = {
    objective,
    considered: scored.map((s) => ({ id: s.capability.id, score: Number(s.score.toFixed(2)), reasons: s.reasons })),
    selected: null,
    reason: null,
  };
  if (!best || best.score <= 0) {
    decision.reason = 'no capability in the registry matches this objective — add intelligence first';
    return decision;
  }
  if (best.score < 0.5 || best.hits < 2) {
    decision.reason = 'best candidate ' + best.capability.id + ' matches too weakly (' + best.hits + ' of ' + objTokens.size + ' objective terms, score ' + best.score.toFixed(2) + ') — refusing to guess; refine the objective or add intelligence';
    return decision;
  }
  if (best.capability.status === 'retired') {
    decision.reason = 'best match ' + best.capability.id + ' is RETIRED — routing refused';
    return decision;
  }
  decision.selected = { id: best.capability.id, version: best.capability.version || null, workflow: best.capability.workflow, lifecycle: best.capability.status || 'unknown' };
  decision.reason = best.reasons.join('; ');
  return decision;
}

// Dispatch answers an ACCEPTANCE, not the run (OP-4, verified against the live
// adapter): the response body carries no run identity today. The body is still
// captured and hashed, and any run id / correlation token it ever does carry is
// preferred over searching recent runs — verified through the same run-detail
// path as every other adoption before it is trusted.
// P3A: every call on this path goes through the ENVIRONMENT TRANSPORT resolved
// for the attempt, never through a module-level header helper. The transport
// names which environment is being dispatched to; when a caller passes none
// (legacy and test call sites) the local environment is the honest default,
// because that is what the pre-P3A code always did.
async function dispatchWorkflow(workflowName, message, conversationId, transport) {
  const { config } = resolveConfig();
  const tp = transport || localTransport(config);
  const res = await fetch(tp.baseUrl + '/api/workflows/' + encodeURIComponent(workflowName) + '/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...tp.headers() },
    body: JSON.stringify({ message, conversationId }),
    signal: AbortSignal.timeout(transportTimeout(tp, 10000)),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error('dispatch HTTP ' + res.status);
  const token = body && (body.runId || body.run_id || body.correlationId || (body.run && body.run.id));
  return {
    accepted: !!(body && body.accepted),
    status: (body && body.status) || null,
    runId: token ? String(token) : null,
    responseSha256: body ? sha256(JSON.stringify(body)) : null,
  };
}

// Run discovery is identity-strict (T1), revised by OP-4R. Adoption has three
// modes, in preference order:
//   1. dispatch-provided — a direct run identifier / correlation token taken
//      from the dispatch response body, verified through the same run-detail
//      path as every other mode before it is trusted;
//   2. direct-exact — the run carries conversation_id EXACTLY equal to our
//      bound platform id AND the expected workflow name (the S2-R contract,
//      unchanged);
//   3. parent-linked — the server forked a CHILD conversation for the worker,
//      so run.conversation_id is an id we have never seen. The run is adopted
//      only when independently retrieved run detail proves it belongs to OUR
//      dispatch: exact workflow name, parent_conversation_id equal
//      (namespace-exact, db-id against db-id) to the persisted association,
//      parent_platform_id equal (platform-id against platform-id) to the
//      persisted association, codebase_id equal to the association's expected
//      project, and an exact user_message equal to the message dispatched.
//      Two runs that both verify fail closed as 'run-ambiguous'; a
//      workflow-name-only match is never adoption.
const ADOPTION_DEADLINE_MS = 10000;
const ADOPTION_POLL_MS = 500;
const ADOPTION_SETTLE_POLLS = 2;
// The terminal-state poll window. Named because the refusal prose DERIVES from
// it: a hardcoded '30s' in the message would silently drift from the deadline
// it describes.
const RUN_TERMINAL_WINDOW_MS = 30000;
// The goal verdict an OUTCOME-UNKNOWN refusal carries. A read we could not
// complete — or a record we could not use as evidence — is not a verdict about
// the work, so it is UNKNOWN and never FAILED: FAILED blames the capability for
// our own inability to read. Same vocabulary as lib/teach.js / lib/acquire.js.
const OUTCOME_UNKNOWN_VERDICT = 'UNKNOWN';
// The refusal codes that mean "we could not read it" rather than "the work
// failed". A code in this set seals UNKNOWN at the ONE catch site below; every
// other code seals FAILED. Keyed on the CODE so every throw that raises one is
// covered by construction — the discovery outage, the unreadable-record refusal
// and the terminal-poll outage all raise 'archon-unavailable', and the
// unreadable-record refusal also raises 'evidence-invalid'. A per-throw
// `verdict:` field would be one refactor away from being forgotten on the next
// such throw; this cannot be, and the guard test enumerates the codes.
//
// `run-not-found` is deliberately NOT here: every read that could answer DID
// answer, so it is a verdict about the work, and it is the one that prescribes
// the retry. `run-timeout` is NOT here either: the reads succeeded and the run
// simply never finished — an answer about the run, not a failure to read. Same
// for `run-ambiguous`, `workflow-name-mismatch` and the `conversation-*` codes.
export const OUTCOME_UNKNOWN_CODES = new Set(['archon-unavailable', 'evidence-invalid']);

// Identity truth (runWorkflowName, verifyParentLinkage) lives in
// lib/task-truth.js since Phase C-R — the recovery path consumes it without
// importing this module. Re-exported here so every existing importer (tests
// included) keeps its import site.
export { runWorkflowName, verifyParentLinkage, fetchRunDetail };

// ---------------------------------------------------------- run-detail read
//
// INVARIANTS this read exists to protect — a future reader WILL be tempted to
// collapse these back into `null`, so don't:
//   * A FAILED READ CANNOT ESTABLISH A MISMATCH. If the record could not be
//     read, we know nothing about its identity; a read failure is never
//     reported as a workflow/leg mismatch.
//   * AN UNREADABLE RECORD CANNOT ESTABLISH A MATCH. A candidate is adopted
//     ONLY from a FOUND read — never from a list row standing in for a detail
//     read that failed.
// The outcome is TYPED so callers can tell an authoritative absence
// (NOT_FOUND) from an outage (UNAVAILABLE) from corrupt evidence (INVALID).
const RUN_READ_MAX_RETRIES = 2; // bounded: at most 2 retries -> 3 attempts
const RUN_READ_RETRY_BACKOFF_MS = 50; // well under ADOPTION_DEADLINE_MS (10000)

// The typed reason a NON-adopted candidate is rejected with, keyed by read
// outcome. FOUND is included because a FOUND record can still be rejected on
// identity grounds (workflow mismatch) — that nuance belongs to the caller.
const READ_REJECTION_REASON = {
  FOUND: 'workflow mismatch',
  NOT_FOUND: 'run-not-found',
  UNAVAILABLE: 'archon-unavailable',
  INVALID: 'evidence-invalid',
};

async function fetchRunDetail(runId, transport) {
  const { config } = resolveConfig();
  const tp = transport || localTransport(config);
  const url = tp.baseUrl + '/api/workflows/runs/' + encodeURIComponent(runId);
  for (let attempts = 1; ; attempts += 1) {
    let res;
    try {
      res = await fetch(url, { headers: tp.headers(), signal: AbortSignal.timeout(transportTimeout(tp)) });
    } catch {
      // Thrown fetch / AbortError / timeout: a retryable transport failure.
      if (attempts <= RUN_READ_MAX_RETRIES) { await new Promise((r) => setTimeout(r, RUN_READ_RETRY_BACKOFF_MS)); continue; }
      return { outcome: 'UNAVAILABLE', detail: null, readError: 'run detail read failed after ' + attempts + ' attempts', attempts };
    }
    // 404/410 are Archon ANSWERING absence — authoritative, never retried.
    if (res.status === 404 || res.status === 410) {
      return { outcome: 'NOT_FOUND', detail: null, readError: 'HTTP ' + res.status, attempts };
    }
    if (!res.ok) {
      // 5xx/429 are retryable. Any other non-ok 4xx could not be read reliably
      // and is NOT an absence.
      const retryable = res.status >= 500 || res.status === 429;
      if (retryable && attempts <= RUN_READ_MAX_RETRIES) { await new Promise((r) => setTimeout(r, RUN_READ_RETRY_BACKOFF_MS)); continue; }
      return { outcome: 'UNAVAILABLE', detail: null, readError: 'HTTP ' + res.status, attempts };
    }
    let body;
    try {
      body = await res.json();
    } catch {
      return { outcome: 'INVALID', detail: null, readError: 'run detail body was not valid JSON', attempts };
    }
    const record = body && typeof body === 'object' && body.run ? body.run : body;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return { outcome: 'INVALID', detail: null, readError: 'run detail body was not a record', attempts };
    }
    if (typeof record.id === 'string' && record.id.length > 0 && record.id !== runId) {
      // Integrity: the server returned a DIFFERENT record than the one asked for.
      return { outcome: 'INVALID', detail: null, readError: 'run detail id mismatch: ' + record.id + ' != ' + runId, attempts };
    }
    if ((record.id === undefined || record.id === null) && body && body.error) {
      // Explicit negative envelope (the mock's HTTP 200 + {error:'not found'}).
      return { outcome: 'NOT_FOUND', detail: null, readError: 'explicit negative envelope', attempts };
    }
    if (record.id !== runId) {
      // A record that does not name itself cannot be the run we asked for —
      // the id is what makes FOUND mean "we read THE run". This subsumes the
      // proxy/health-envelope case: {ok:true} and {status:'completed'} carry no
      // id and are INVALID here rather than FOUND with a fabricated id.
      return { outcome: 'INVALID', detail: null, readError: 'run detail body carried no run id', attempts };
    }
    return { outcome: 'FOUND', detail: { ...record }, readError: null, attempts };
  }
}

export function directExact(run, conversationId, workflowName) {
  return Boolean(run) && run.conversation_id === conversationId && runWorkflowName(run) === workflowName;
}

export function adoptionRecord({ mode, detail, conversationId, workflowName, evidence, candidatesConsidered, discoveredAfterMs, detailText }) {
  return {
    mode,
    runId: detail.id,
    workflow: runWorkflowName(detail) || workflowName,
    boundConversationId: conversationId,
    // The child conversation id is recorded verbatim as provenance and is
    // never compared against either namespace of the durable association.
    childConversationId: detail.conversation_id || null,
    parentConversationId: detail.parent_conversation_id || null,
    parentPlatformId: detail.parent_platform_id || null,
    codebaseId: detail.codebase_id || null,
    userMessage: detail.user_message || null,
    verifiedFrom: 'run-detail',
    evidence: evidence || [],
    candidatesConsidered: candidatesConsidered || 1,
    discoveredAfterMs: discoveredAfterMs == null ? null : discoveredAfterMs,
    detailSha256: detailText ? sha256(detailText) : null,
  };
}

// OP-4R Phase C-R: discovery is also an Archon READ. A deadline reached with
// ZERO successful list reads is an outage — materially different from "Archon
// answered and named no run" — and must never be reported as run-not-found
// (which would license a redispatch of an already-dispatched workflow).
// P3A: discovery reads the SAME environment the dispatch went to. The
// transport is optional — an omitted transport means the local environment,
// which is what every pre-P3A caller meant — so a run is never sought in one
// environment while it was dispatched to another.
export async function discoverRun({ workflowName, preIds, conversationId, association, dispatchedMessage, dispatchedRunId, transport }) {
  const { config } = resolveConfig();
  const tp = transport || localTransport(config);
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const rejected = [];
  const excluded = [];
  const consideredIds = new Set();
  let candidatesConsidered = 0;
  let successfulListReads = 0;

  // (1) dispatch-provided identity, verified before trust.
  if (dispatchedRunId) {
    candidatesConsidered += 1;
    const read = await fetchRunDetail(dispatchedRunId, tp);
    if (read.outcome === 'FOUND' && runWorkflowName(read.detail) === workflowName) {
      const detail = read.detail;
      const adoption = adoptionRecord({ mode: 'dispatch-provided', detail, conversationId, workflowName, evidence: verifyParentLinkage(detail, association, workflowName, dispatchedMessage).evidence, candidatesConsidered, discoveredAfterMs: elapsed(), detailText: JSON.stringify(detail) });
      return { status: 'found', adoption, candidates: [dispatchedRunId], rejected, excluded, dispatchToken: dispatchedRunId, elapsedMs: elapsed() };
    }
    // A non-FOUND read is rejected with its TYPED outcome: an outage is never
    // dressed up as a workflow mismatch, and a 404 is never unavailability.
    rejected.push({ id: dispatchedRunId, source: 'dispatch-token', outcome: read.outcome, reason: READ_REJECTION_REASON[read.outcome], attempts: read.attempts });
  }

  // (2)+(3) direct-exact and parent-linked candidates, polled to the deadline.
  let verified = null;
  let verifiedPolls = 0;
  for (;;) {
    try {
      const lr = await fetch(tp.baseUrl + '/api/workflows/runs?limit=50', { headers: tp.headers(), signal: AbortSignal.timeout(transportTimeout(tp)) });
      if (lr.ok) {
        // The counter's discriminator is "did we obtain a READABLE BODY", not
        // "did the transport answer". Counting a 200 before its body parses
        // leaves the `=== 0` outage guard below unfired when every list read is
        // a 200 we cannot read, so the deadline fall-through reports ABSENCE for
        // a list we never read — and absence here prescribes a RETRY, which this
        // module's own comment records can double-run a live workflow.
        // `{"runs": []}` stays an authoritative absence; a missing or non-array
        // `runs` is a read we could not complete — the same rule already landed
        // at lib/verify.js readRunList (`!Array.isArray(lrun.runs)` ->
        // UNAVAILABLE) and lib/acquire.js findRun. Four readers, one rule.
        //
        // A FOURTH READER OF THE SAME RULE, IN THIS SAME FILE, DID NOT FOLLOW
        // IT UNTIL RECENTLY — which is why the fact is kept rather than deleted.
        // findConversationRun, later in this file, read this same endpoint with
        // `const runs = (lb && lb.runs) || []` — no `Array.isArray` gate — so a
        // 200 whose body was valid JSON with no `runs` key collapsed to `[]` and
        // was returned as `status: 'none'`, which that function's OWN
        // doc-comment defines as "an ANSWERED absence". The `|| []` merged "no
        // runs key" and "an empty runs array", which are different events: one
        // is a read we could not complete, the other is an authoritative
        // absence. Its PARSE form was already correct — `lr.json()` sits inside
        // the same try, so a body that fails to parse already returned
        // 'unavailable' — it was the SHAPE form that was wrong, which is why
        // this was the same trap as the gate on the line above and not the same
        // trap as the parse gate. Reported by storefaults. It mattered more than
        // a wrong status: the caller records `strayDiagnostic` ONLY on the
        // 'unavailable' branch, so a false 'none' recorded nothing and fell
        // through to `run-not-found` — an authoritative absence with no trace
        // that the read had failed, which is exactly what licenses the retry
        // that can double-run a live workflow. Now gated on the SAME predicate
        // as the line above, so the two readers of one endpoint no longer
        // disagree about what a readable list is.
        let lb = null;
        try { lb = await lr.json(); } catch { lb = null; }
        const parsed = !!(lb && Array.isArray(lb.runs));
        if (parsed) successfulListReads += 1;
        const runs = parsed ? lb.runs : [];
        // P5: a run excluded ONLY by the pre-dispatch snapshot boundary is
        // RECORDED here, never silently dropped — dropping it makes the
        // caller's "no run appeared" a false statement while a fully-linked run
        // sits on this conversation. It is deliberately NOT a rejection:
        // nothing about its identity failed, so it must not enter `rejected`
        // (which means "identity rejections"). Recorded once per run.
        for (const r of runs) {
          if (!r || !r.id || !preIds.has(r.id)) continue;
          if (runWorkflowName(r) !== workflowName) continue;
          const linked = r.conversation_id === conversationId
            || (r.parent_conversation_id === (association && association.dbId)
              && r.parent_platform_id === (association && association.archonConversationId));
          if (linked && !excluded.some((e) => e.id === r.id)) excluded.push({ id: r.id, reason: 'pre-dispatch' });
        }
        const fresh = runs.filter((r) => r && r.id && !preIds.has(r.id));
        const exact = fresh.find((r) => directExact(r, conversationId, workflowName));
        if (exact && !consideredIds.has(exact.id)) {
          candidatesConsidered += 1;
          const read = await fetchRunDetail(exact.id, tp);
          if (read.outcome !== 'FOUND') {
            // An unreadable record cannot establish a match: the LIST row is
            // NEVER substituted for a detail read that failed (the old
            // `detail || exact` fallback did exactly that). Record the typed
            // rejection and keep looking at the remaining candidates.
            consideredIds.add(exact.id);
            rejected.push({ id: exact.id, source: 'direct-exact', outcome: read.outcome, reason: READ_REJECTION_REASON[read.outcome], attempts: read.attempts });
          } else {
            const detail = read.detail;
            const check = verifyParentLinkage(detail, association, workflowName, dispatchedMessage);
            // Direct-exact identity (conversation + workflow) is NOT enough on
            // its own: every APPLICABLE linkage leg must also hold, or a run on
            // our own conversation with a foreign project, a different message
            // or a foreign workspace would be adopted. `check.pass` is the
            // conjunction over applicable legs — a direct run's absent parent
            // legs are marked inapplicable by the predicate itself, so this is
            // not a weaker gate for direct runs, just a correctly scoped one.
            if (!check.pass) {
              consideredIds.add(exact.id);
              rejected.push({ id: exact.id, source: 'direct-exact', reason: 'parent linkage failed: ' + check.evidence.filter((e) => e.applicable !== false && !e.pass).map((e) => e.id).join(','), childConversationId: detail.conversation_id || null });
            } else {
              const adoption = adoptionRecord({ mode: 'direct-exact', detail, conversationId, workflowName, evidence: check.evidence, candidatesConsidered, discoveredAfterMs: elapsed(), detailText: JSON.stringify(detail) });
              return { status: 'found', adoption, candidates: [exact.id], rejected, excluded, dispatchToken: null, elapsedMs: elapsed() };
            }
          }
        }
        const matching = fresh.filter((r) => runWorkflowName(r) === workflowName);
        for (const c of matching) {
          // One examination per run: the settle polls re-list the same rows,
          // and re-counting them would inflate candidatesConsidered and
          // duplicate rejected entries.
          if (consideredIds.has(c.id)) continue;
          consideredIds.add(c.id);
          candidatesConsidered += 1;
          const read = await fetchRunDetail(c.id, tp);
          if (read.outcome !== 'FOUND') {
            // The typed outcome replaces the single generic string: an outage
            // is named as an outage, an authoritative absence as absence.
            rejected.push({ id: c.id, source: 'parent-linked', outcome: read.outcome, reason: READ_REJECTION_REASON[read.outcome], attempts: read.attempts });
            continue;
          }
          const detail = read.detail;
          const check = verifyParentLinkage(detail, association, workflowName, dispatchedMessage);
          if (!check.pass) {
            rejected.push({ id: c.id, source: 'parent-linked', reason: 'parent linkage failed: ' + check.evidence.filter((e) => e.applicable !== false && !e.pass).map((e) => e.id).join(','), childConversationId: detail.conversation_id || null });
            continue;
          }
          if (verified && verified.detail.id !== detail.id) {
            // Two runs both prove they belong to this dispatch: no unique,
            // independently supported attribution means no adoption.
            return { status: 'ambiguous', adoption: null, candidates: [verified.detail.id, detail.id], rejected, excluded, dispatchToken: null, elapsedMs: elapsed() };
          }
          if (!verified) verifiedPolls = 1;
          verified = { detail, evidence: check.evidence, text: JSON.stringify(detail) };
        }
      }
    } catch { /* keep polling */ }

    if (verified) {
      if (verifiedPolls >= ADOPTION_SETTLE_POLLS) {
        const adoption = adoptionRecord({ mode: 'parent-linked', detail: verified.detail, conversationId, workflowName, evidence: verified.evidence, candidatesConsidered, discoveredAfterMs: elapsed(), detailText: verified.text });
        return { status: 'found', adoption, candidates: [verified.detail.id], rejected, excluded, dispatchToken: null, elapsedMs: elapsed() };
      }
      verifiedPolls += 1;
    }
    if (Date.now() - startedAt > ADOPTION_DEADLINE_MS) {
      if (successfulListReads === 0) {
        return { status: 'unavailable', adoption: null, candidates: [], rejected, excluded, dispatchToken: null, elapsedMs: elapsed(), reason: 'archon run list never returned a successful read during discovery — outage, not absence' };
      }
      if (excluded.length) {
        // The exclusion is named on the STATUS too (the same field 'unavailable'
        // uses), so a caller can tell "nothing materialized" from "a linked run
        // was excluded on the temporal boundary" without reading `excluded`.
        return { status: 'none', adoption: null, candidates: [], rejected, excluded, dispatchToken: null, elapsedMs: elapsed(), reason: excluded.length + ' fully-linked run(s) excluded on the pre-dispatch snapshot boundary: ' + excluded.map((e) => e.id).join(', ') };
      }
      return { status: 'none', adoption: null, candidates: [], rejected, excluded, dispatchToken: null, elapsedMs: elapsed() };
    }
    await new Promise((r) => setTimeout(r, ADOPTION_POLL_MS));
  }
}

// Diagnostic for the discovered-null path: if a run DID appear on our
// conversation with a different workflow, that is an identity failure worth
// naming precisely, not a generic run-not-found.
//
// Typed like every other read here: an unreadable list is 'unavailable' (we
// cannot name a mismatch AND we cannot assert its absence), a successful read
// with no such run is 'none' (an ANSWERED absence), and a match is 'found'.
async function findConversationRun(conversationId, preIds, transport) {
  const { config } = resolveConfig();
  const tp = transport || localTransport(config);
  try {
    const lr = await fetch(tp.baseUrl + '/api/workflows/runs?limit=50', { headers: tp.headers(), signal: AbortSignal.timeout(transportTimeout(tp)) });
    if (!lr.ok) return { status: 'unavailable', run: null, reason: 'HTTP ' + lr.status };
    const lb = await lr.json();
    // A 200 whose body is not a run LIST is not a successful read. `(lb && lb.runs) || []`
    // collapsed "no runs key" into "an empty runs array", so an unreadable list was returned as
    // 'none' — which this function's own doc-comment calls an ANSWERED absence, and the CALLER
    // records `strayDiagnostic` ONLY on the 'unavailable' branch, so the gap was not even
    // recorded. Mirror discoverRun's contract-level predicate in this same file
    // (`const parsed = !!(lb && Array.isArray(lb.runs))`): a non-array body is a read that never
    // completed. A body that FAILS TO PARSE is unaffected — it throws into the catch below — and
    // `{"runs": []}` stays an authoritative absence, so only the shape case moves.
    if (!lb || !Array.isArray(lb.runs)) {
      return { status: 'unavailable', run: null, reason: 'HTTP ' + lr.status + ' with a body that is not a run list' };
    }
    const runs = lb.runs;
    const run = runs.find((r) => r && !preIds.has(r.id) && r.conversation_id === conversationId) || null;
    return run ? { status: 'found', run } : { status: 'none', run: null };
  } catch (err) {
    return { status: 'unavailable', run: null, reason: String((err && err.message) || err) };
  }
}

// Awaiting a terminal state is also a READ, so it carries the same typed
// distinction: 'terminal' (we read a finished run), 'timeout' (reads succeeded
// but the run never finished — an answer about the run), and 'unavailable'
// (no read ever succeeded — an outage, never a timeout).
async function pollRun(runId, transport) {
  const { config } = resolveConfig();
  const tp = transport || localTransport(config);
  const deadline = Date.now() + RUN_TERMINAL_WINDOW_MS;
  let successfulReads = 0;
  let lastReadError = null;
  // Two independent reasons a read can fail to be a read, kept apart because
  // they type differently at the deadline. `sawUnreadable`: the read never
  // completed (transport, non-2xx, unparseable body) — an OUTAGE. `sawNonRecord`:
  // a 2xx whose body parsed and is not the run record — corrupt evidence, not an
  // outage, and not "the run did not finish" either.
  let sawUnreadable = false;
  let sawNonRecord = false;
  for (;;) {
    try {
      const res = await fetch(tp.baseUrl + '/api/workflows/runs/' + encodeURIComponent(runId), { headers: tp.headers(), signal: AbortSignal.timeout(transportTimeout(tp)) });
      if (res.ok) {
        // Same rule as discoverRun: a 200 whose body cannot be USED is not a
        // successful read. Counting it would let the `=== 0` guard below miss
        // and return 'timeout' — "the run never finished" — for a run we never
        // obtained. `parsed` is a flag, not a truthiness test on the body, so a
        // body that legitimately parses to a falsy value still counts as a BODY.
        //
        // THE RECORD PREDICATE, and why it is the ID LEG. `parsed` alone asks
        // only "did the body parse"; a read is a read iff the body is the record
        // FOR THIS RUN — the contract fetchRunDetail already applies to these
        // same bytes one reader up ("a record that does not name itself cannot
        // be the run we asked for — the id is what makes FOUND mean we read THE
        // run"), and the one the mock's `not-run-object` mode pins. Requiring the
        // CONSUMED field (`status`) instead would be wrong for a different
        // reason: a well-formed record that simply has no status YET is the run
        // we asked for, and rejecting it would turn "we read the run and it has
        // not finished" into "we could not read it".
        //
        // THE ID LEG CANNOT REJECT A RECORD WE ADOPTED. pollRun only ever polls
        // a runId that was adopted, and every adoption mode requires a FOUND
        // fetchRunDetail read of this same URL — which requires `record.id ===
        // runId`. So this leg can only bite if the server's answer CHANGES
        // between the adoption read and a poll, i.e. through a fault knob rather
        // than through a run. That is what makes the flip set enumerable instead
        // of open-ended, and it is enumerated: the goal-case child's `thenBody`
        // is used on the detail surface by exactly ONE row
        // (`goal-poll-run-not-a-record`, the row this predicate exists for), and
        // the mock's `detail-fault` is armed only by
        // test/detail-read-outcomes.test.mjs, which drives fetchRunDetail and
        // discoverRun directly and never polls.
        //
        // WHAT THE NOTE THIS REPLACED GOT WRONG. This block was a KNOWN RESIDUAL
        // arguing the predicate was a contract decision that could not be
        // tightened without moving fixture rows, and it named `{run: null,
        // events: []}` — the shape the goal-case child serves by default — as the
        // hazard. That shape is never served to a POLL: the child serves it only
        // to rows whose `detail.run` is absent, and those rows never adopt, so
        // they never reach here. The note was right that the enumeration had to
        // come first, and wrong that it was unaffordable. And if a future row
        // ever does serve `{run: null}` to a poll, INVALID is the CORRECT answer
        // for it rather than a regression: we asked for a run and obtained no
        // record, which is the same fact fetchRunDetail already classifies as
        // INVALID for these exact bytes.
        //
        // NOT TO BE CONFLATED with the STATUS predicate below: this is about
        // whether we obtained the RECORD, while `isTerminalRunStatus` is about
        // what the status we read MEANS. A perfectly readable record can carry a
        // status we cannot classify, and a 200 that is not a record has no status
        // at all.
        let body = null;
        let parsed = false;
        try { body = await res.json(); parsed = true; } catch { lastReadError = 'HTTP ' + res.status + ' with an unreadable body'; }
        if (parsed) {
          const record = body && typeof body === 'object' && body.run ? body.run : body;
          if (record && typeof record === 'object' && !Array.isArray(record) && record.id === runId) {
            successfulReads += 1;
          } else {
            sawNonRecord = true;
          }
        } else {
          sawUnreadable = true;
        }
        const run = body && body.run ? body.run : body;
        const events = body && body.events ? body.events : [];
        const st = run && run.status;
        // A SEPARATE decision from the read predicate above, and not to be
        // conflated with it: `parsed` asks "did we obtain a body", this asks
        // "does the status we read mean the run is finished". Only a status we
        // RECOGNISE as terminal ends the poll (TERMINAL_RUN_STATUSES); an
        // unrecognised one keeps polling and ends in the named window. Before
        // this, the test was `st && st !== 'running' && ...`, which read any
        // unrecognised truthy status as finished.
        if (isTerminalRunStatus(st)) return { status: 'terminal', run, events, detailText: JSON.stringify(body) };
      } else {
        sawUnreadable = true;
        lastReadError = 'HTTP ' + res.status;
      }
    } catch (err) {
      sawUnreadable = true;
      lastReadError = String((err && err.message) || err);
    }
    if (Date.now() > deadline) {
      if (successfulReads === 0) {
        // An outage DOMINATES a bad record — the same rule the caller applies to
        // `unreadableCode` on the discovery surface ("if any candidate's read
        // never completed we cannot know what the others would have said
        // either"). So `invalid` is claimed only when EVERY unusable read was a
        // parsed non-record: Archon answered, and what it answered is not the
        // run. That is corrupt evidence, never an outage and never a timeout —
        // a timeout would claim the run did not finish.
        if (!sawUnreadable && sawNonRecord) return { status: 'invalid', run: null, events: [], reason: 'every read returned a body that is not the run record' };
        return { status: 'unavailable', run: null, events: [], reason: lastReadError || 'run detail never returned a successful read' };
      }
      // No `reason` here: the caller composes the timeout prose from the named
      // window. A second, unused copy would be a string nobody reads and
      // everybody trusts to stay in sync.
      return { status: 'timeout', run: null, events: [] };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export const collectOutputs = (events) => {
  const outs = [];
  for (const e of events || []) {
    const d = e && e.data;
    const o = d && (typeof d.node_output === 'string' ? d.node_output : (typeof d.output === 'string' ? d.output : null));
    if (o && o.trim()) outs.push({ node: e.step_name || 'node', output: o.trim() });
  }
  return outs;
};

// Compose the evaluated evidence bundle from a polled run. The detail text is
// filtered through excludeRequestEcho first, so the evaluator sees independent
// execution evidence — not the dispatched objective echoed back in
// `run.user_message`. The hash covers the FILTERED detail, which is why this
// is a versioned contract (EVIDENCE_CONTRACT_VERSION): v2 records hash what
// they actually judged, and v1 records (no `contract` field) are read verbatim
// and never recomputed.
export function composeEvidence({ detailText, outputs }) {
  const detail = excludeRequestEcho(detailText);
  const evidenceText = [detail, ...(outputs || [])].join('\n');
  return { contract: EVIDENCE_CONTRACT_VERSION, evidenceText, evidenceSha256: sha256(detail) };
}

// The v0 gate asked two questions: terminal status + the capability's declared
// expectation. A capability that declares no expectation can reach COMPLETED
// but never SHIP — evidence, not optimism.
export function validateCapability({ runStatus, expect, evidenceText }) {
  const terminalExpected = expect && expect.terminalStatus ? String(expect.terminalStatus) : 'completed';
  const checks = [{ id: 'terminal-status', pass: runStatus === terminalExpected }];
  if (expect && expect.expectOutput) checks.push({ id: 'declared-expectation', pass: String(evidenceText || '').includes(expect.expectOutput) });
  else checks.push({ id: 'declared-expectation', pass: false, reason: 'capability has no declared expectation' });
  return { pass: checks.every((c) => c.pass), checks };
}

// ------------------------------------------------- objective evaluation (M1)
//
// The third truth is OBJECTIVE SATISFACTION, and it is answered by the
// capability's own DECLARED EVALUATOR (capability.objectiveEvaluation in the
// registry — output-lines / output-contains kinds), evaluated against the
// collected evidence by lib/task-truth.js. No hidden policy, no LLM judge, no
// new dependencies: a capability that declares no evaluator yields
// NOT_EVALUATED, and a declared evaluator the evidence misses yields
// NOT_SATISFIED. Either way the verdict BLOCKs — evidence, not optimism.

// ---------------------------------------------------------- trust ladder (M1)
//
// Observed → Executed → Validated → Objective satisfied, DERIVED per goal from
// the same fields and RECONCILED with the three-truth model, never replacing
// it: each rung names the truth it vouches for (execution, capability
// validation, objective evaluation). Rungs are cumulative — a higher rung
// implies every rung below it.
//
//   Observed            the goal exists with an objective (truth: none yet)
//   Executed            an attempt reached a terminal run status on the
//                       execution adapter (truth: execution)
//   Validated           the 2-check gate passed: terminal status +
//                       capability's declared expectation (truth: capability
//                       validation)
//   Objective satisfied the 3-check gate passed: + objective satisfaction
//                       (truth: objective evaluation)
export const LADDER = ['Observed', 'Executed', 'Validated', 'Objective satisfied'];

export function trustLadder(goal) {
  const attempts = (goal && goal.attempts) || [];
  const last = attempts[attempts.length - 1] || null;
  const checks = (goal && goal.checks) || [];
  const rung = { index: 0, label: 'Observed', truth: null };
  const executed = !!(last && typeof last.status === 'string' && !['running', 'queued', 'pending'].includes(last.status));
  if (executed) {
    rung.index = 1;
    rung.label = 'Executed';
    rung.truth = 'execution';
  }
  const validated = executed && checks.some((c) => c.id === 'terminal-status' && c.pass) &&
    (!checks.some((c) => c.id === 'declared-expectation') || checks.some((c) => c.id === 'declared-expectation' && c.pass));
  if (validated) {
    rung.index = 2;
    rung.label = 'Validated';
    rung.truth = 'capability validation';
  }
  if (validated && checks.some((c) => c.id === 'objective-satisfaction' && c.pass)) {
    rung.index = 3;
    rung.label = 'Objective satisfied';
    rung.truth = 'objective evaluation';
  }
  return { rungs: LADDER, ...rung };
}

// ----------------------------------------------------------- next action (M1)
//
// Next Action is a first-class enumerated operator action DERIVED from verdict
// + failureCodes + ladder position. It SUGGESTS; it never auto-executes.
// Approval is suggested through the same channel: an awaiting-approval task
// names 'approve' with the authority reason, and the Preview surface renders
// the envelope's authority block as "RCOS plans to …".
export function nextAction(goal) {
  const verdict = goal && goal.verdict;
  const codes = new Set((goal && goal.failureCodes) || []);
  const ladder = trustLadder(goal);
  const act = (kind, label, reason) => ({ kind, label, reason, ladder: ladder.label });
  if (codes.has('awaiting-approval')) {
    const why = (goal && goal.authority && goal.authority.reason) || 'the capability needs authority the preset does not pre-authorize';
    return act('approve', 'Approve plan', why);
  }
  if (verdict === 'PENDING' || !verdict) return act('wait', 'Wait for the run', 'the goal has not reached a verdict yet');
  if (verdict === 'SHIP') {
    return codes.size
      ? act('inspect', 'Inspect checks', 'shipped with advisory codes: ' + [...codes].join(', '))
      : act('ship', 'Ship it', 'execution, capability validation, and objective evaluation all passed');
  }
  if (codes.has('objective-required')) return act('refine', 'Refine the objective', 'no objective was given — say what you want done');
  if (codes.has('registry-not-configured')) return act('configure', 'Configure the registry', 'routing needs registry truth — set registry.path');
  if (codes.has('no-route')) return act('teach', 'Acquire capability', 'no capability matches this objective — RCOS can acquire one (bounded staged evaluation; your explicit promotion)');
  if (codes.has('run-not-found')) return act('retry', 'Retry (same task)', 'dispatch was accepted but no run appeared — a retry may let discovery catch up');
  if (codes.has('run-ambiguous')) return act('inspect', 'Inspect the duplicate runs', 'two runs independently verify as this dispatch — no unique attribution means no adoption, so resolve the duplicate before retrying');
  if (codes.has('workflow-name-mismatch')) return act('inspect', 'Inspect the conversation', 'a run appeared on the bound conversation under a different workflow — the conversation is not executing this task\u2019s workflow');
  if (codes.has('archon-unavailable')) return act('inspect', 'Inspect Archon availability', 'the dispatch was accepted but Archon could not be read — outcome unknown; an outage is never a retry signal');
  if (codes.has('evidence-invalid')) return act('inspect', 'Inspect the run record', 'a run matching this workflow appeared but its record could not be read as evidence — the outcome is unknown, so a retry could double-run it');
  if (codes.has('run-timeout')) return act('inspect', 'Inspect the run', 'the run never reached a terminal state — look before retrying');
  if (codes.has('run-failed')) return act('retry', 'Retry (same task)', 'the execution adapter reported failure — retry preserves task identity');
  if (codes.has('expectation-not-met') || codes.has('capability-validation-failed')) return act('inspect', 'Inspect the evidence', 'the run finished but its evidence missed the capability\u2019s declared expectation');
  if (codes.has('objective-not-evaluated')) return act('configure', 'Declare an objective evaluator', 'the capability declares no objective evaluator — satisfaction cannot be evaluated until it does');
  if (codes.has('objective-not-satisfied')) return act('fork', 'Fork as new task', 'the capability ran clean but did not satisfy the objective — fork to try different intelligence');
  if (codes.has('run-not-terminal')) return act('inspect', 'Inspect the run', 'the run left no terminal status to evaluate');
  if (codes.has('conversation-not-bound')) return act('provision', 'Provision the conversation', 'no Archon conversation is associated with this task — provision one through the supported interface before dispatch');
  if (codes.has('conversation-provision-unresolved')) return act('inspect', 'Inspect provisioning', 'a provisioning intent is recorded without a conversation id — reconcile the orphan before re-provisioning');
  if (codes.has('conversation-association-dangling')) return act('inspect', 'Inspect the association', 'the associated conversation no longer exists in Archon — the association must be reconciled, never silently re-created');
  if (codes.has('conversation-bound-wrong-project')) return act('inspect', 'Inspect the project binding', 'the conversation is bound to a different project than the recorded association expects');
  if ([...codes].some((c) => c.startsWith('conversation-'))) return act('inspect', 'Inspect provisioning', 'conversation provisioning or verification failed — inspect before retrying');
  return act('inspect', 'Inspect the task', 'verdict ' + verdict + ' — open the spine before acting');
}

// The three truths collapse into exactly one verdict + failure code here —
// nothing else in the system decides SHIP/BLOCK/FAILED.
//
// Both status tests below are RAW, and `execution.completed` is decided raw by
// the caller (see the KNOWN GAP enumeration at the VERIFY block): a run whose
// status is 'FAILED' does not match `=== 'failed'` here, and a run whose status
// is 'COMPLETED' does not set `completed`, so both fall to the `run-not-terminal`
// line and the operator is told the run "left no terminal status to evaluate".
// The fix is `normaliseRunStatus` on the comparison, never on the recorded
// evidence. Held for the one coordinated change with lib/verify.js.
export function deriveGoalVerdict({ execution, capabilityValidation, objectiveEvaluation }) {
  if (execution && execution.status === 'failed') return { verdict: 'FAILED', failureCode: 'run-failed' };
  if (!execution || execution.completed !== true) return { verdict: 'FAILED', failureCode: 'run-not-terminal' };
  if (!capabilityValidation || capabilityValidation.pass !== true) return { verdict: 'BLOCK', failureCode: 'capability-validation-failed' };
  if (!objectiveEvaluation || objectiveEvaluation.status === 'NOT_EVALUATED') return { verdict: 'BLOCK', failureCode: 'objective-not-evaluated' };
  if (objectiveEvaluation.status !== 'SATISFIED' || objectiveEvaluation.pass !== true) return { verdict: 'BLOCK', failureCode: 'objective-not-satisfied' };
  return { verdict: 'SHIP', failureCode: null };
}

// ------------------------------------------------------------------ goal

export async function listGoals() { return listTasks(); }
// The host's GET-by-id path is synchronous. listGoals() hydrates this cache
// from Archon after restart; GoalRunner itself uses getTask() below whenever
// it requires authoritative async reconstruction for retry/fork.
export function getGoal(taskId) { return peekTask(taskId); }

let inflight = null;

export function runGoal({ objective, retryOf, forkOf, approved, authorization, workspaceId, owner, environmentId }) {
  if (inflight) return inflight;
  inflight = _run({ objective, retryOf, forkOf, approved, authorization, workspaceId, owner, environmentId }).finally(() => { inflight = null; });
  return inflight;
}

async function _run({ objective, retryOf, forkOf, approved, authorization, workspaceId, owner, environmentId }) {
  let taskId;
  let conversationId = null;
  let lineage = null;
  let priorAttempts = [];
  // Workspace identity (P2): the Archon codebase this task's conversation binds
  // to. `parentWorkspace` is carried from the parent envelope on retry/fork/
  // approval-resume so a resumed attempt keeps its workspace — and its recorded
  // owner, so the ownership check still runs.
  let parentWorkspace = null;
  let workspace = null;
  // The attempt this invocation creates. Hoisted so the catch can stamp ONLY
  // its own attempt — attempts carried in from a prior attempt are immutable
  // recorded truth and are never rewritten.
  let attempt = null;
  // Execution environment identity (P3A): resolved from the workspace binding
  // when the task carries one, otherwise selected by the caller within its owner
  // scope. Hoisted so the catch can still report which environment the attempt
  // was aimed at, and so the transport below is a single resolved object rather
  // than a config read repeated at each call site.
  let environment = null;
  let transport = null;

  let carriedApprovalAt = null;
  if (retryOf) {
    const parent = await getTask(retryOf);
    if (!parent) throw Object.assign(new Error('retry parent not found: ' + retryOf), { code: 'retry-parent-not-found' });
    taskId = parent.taskId;
    // T1 (amended): a retry dispatches on the conversation explicitly and
    // durably associated with the SAME task — or fails closed in the gate
    // below when none exists. No derived id.
    conversationId = await associatedConversationId(taskId);
    objective = objective || parent.objective;
    // Prior attempts are CLONED: they are carried forward as recorded truth
    // and never mutated by this invocation. The last carried attempt is
    // backfilled (append-only) from the parent envelope's already-recorded
    // failure truth where the attempt itself did not carry it.
    priorAttempts = (Array.isArray(parent.attempts) ? parent.attempts : []).map((a) => ({ ...a }));
    const carriedLast = priorAttempts[priorAttempts.length - 1];
    if (carriedLast) {
      if (!carriedLast.failureCode && Array.isArray(parent.failureCodes) && parent.failureCodes.length) carriedLast.failureCode = parent.failureCodes[0];
      if (!carriedLast.error && parent.error) carriedLast.error = parent.error;
      if (!carriedLast.endedAt) carriedLast.endedAt = parent.endedAt || null;
    }
    carriedApprovalAt = (parent.authority && parent.authority.approvedAt) || null;
    lineage = parent.lineage || null;
    parentWorkspace = parent.workspace || null;
  } else if (forkOf) {
    const parent = await getTask(forkOf);
    if (!parent) throw Object.assign(new Error('fork parent not found: ' + forkOf), { code: 'fork-parent-not-found' });
    taskId = forkTaskId();
    // A fork is a NEW task identity: it has no conversation association until
    // one is provisioned for it explicitly. The dispatch gate below enforces
    // that; no id is derived from the new task id.
    objective = objective || parent.objective;
    lineage = { parentTaskId: parent.taskId, forkedFromTaskId: parent.taskId };
    parentWorkspace = parent.workspace || null;
  } else {
    const admitted = admitTask(objective);
    taskId = admitted.taskId;
    objective = admitted.objective;
  }

  const goal = {
    taskId,
    conversationId,
    // The explicit conversation association is attached to the goal after the
    // dispatch gate runs (see below); until then it is unset.
    conversation: null,
    // The workspace this task runs against (P2); resolved below. Null means the
    // task carries no workspace — provisioning is skipped and the pre-P2
    // dispatch-gate behavior stands.
    workspace: null,
    // The execution environment this attempt runs in (P3A); resolved below from
    // the workspace binding or the caller's selection. Null until resolved.
    executionEnvironment: null,
    objective: String(objective || '').slice(0, 500),
    startedAt: isoNow(),
    endedAt: null,
    route: null,
    attempts: priorAttempts,
    checks: [],
    execution: null,
    capabilityValidation: null,
    objectiveEvaluation: null,
    claim: null,
    trust: trustLadder({ attempts: [], checks: [] }),
    nextAction: nextAction({ verdict: 'PENDING', failureCodes: [] }),
    verdict: 'PENDING',
    failureCodes: [],
    lineage: lineage || undefined,
  };

  try {
    if (!objective || typeof objective !== 'string' || !objective.trim()) throw Object.assign(new Error('objective required'), { code: 'objective-required' });

    // ---- WORKSPACE RESOLUTION (P2): read-only and fails closed — owner is
    // required and must match the record — so an unknown or foreign workspace
    // is refused BEFORE any side effect (no envelope write, no conversation).
    if (workspaceId) {
      workspace = await resolveWorkspace({ workspaceId, owner });
    } else if (parentWorkspace && parentWorkspace.workspaceId) {
      workspace = await resolveWorkspace({ workspaceId: parentWorkspace.workspaceId, owner: parentWorkspace.owner });
    }
    goal.workspace = workspace ? {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      path: workspace.path,
      codebaseId: workspace.codebaseId,
      kind: workspace.kind,
      owner: workspace.owner,
    } : null;

    const resolved = resolveConfig();

    // ---- ENVIRONMENT RESOLUTION (P3A): the execution environment this attempt
    // actually runs in. A workspace-bound task CARRIES its environment — the
    // recorded binding is truth, and a caller asking for a different one is
    // refused rather than silently re-bound. With no workspace, the caller may
    // select an environment its owner scope allows, and the configured default
    // applies otherwise. A declared-but-unimplemented adapter is refused HERE,
    // before the registry, the authority gate, the conversation gate and the
    // dispatch: an environment that cannot execute must not reach any of them.
    const requestedEnvId = environmentId === undefined || environmentId === null || environmentId === ''
      ? null
      : String(environmentId);
    if (workspace) {
      if (requestedEnvId && requestedEnvId !== workspace.environmentId) {
        throw Object.assign(
          new Error('workspace ' + workspace.workspaceId + ' is bound to environment ' + workspace.environmentId + ', not ' + requestedEnvId),
          {
            code: 'workspace-environment-mismatch',
            workspaceId: workspace.workspaceId,
            boundEnvironmentId: workspace.environmentId,
            requestedEnvironmentId: requestedEnvId,
          },
        );
      }
      environment = resolveEnvironment({ environmentId: workspace.environmentId, config: resolved.config });
    } else {
      environment = requireEnvironmentForOwner({ environmentId: requestedEnvId || undefined, owner, config: resolved.config });
    }
    requireEnvironmentAdapter(environment);
    requireOrchestratorProtocol(environment);
    transport = environmentTransport(environment, resolved.config);
    goal.executionEnvironment = receiptEnvironment(environment);

    if (!resolved.config.registry.path) throw Object.assign(new Error('registry not configured — set registry.path'), { code: 'registry-not-configured' });
    const registry = JSON.parse(await readFile(resolved.config.registry.path, 'utf8'));
    const route = routeObjective(objective, registry);
    goal.route = route;
    if (!route.selected) throw Object.assign(new Error(route.reason), { code: 'no-route' });

    const capability = registry.capabilities.find((c) => c.id === route.selected.id) || {};
    const expect = capability.verification || null;
    const objectiveEvaluator = capability.objectiveEvaluation || null;

    // ---- AUTHORITY (permissions round): the capability declares what it
    // REQUIRES; the operator preset pre-authorizes (grants) a subset. When the
    // decision is approval, seal an awaiting-approval envelope and return
    // BEFORE dispatch — the Preview surface renders this envelope; approval
    // resumes the SAME task (retryOf + approved flag).
    const { requires, unknown } = requiresOf(capability);
    const preset = resolveConfig().config.authority.preset;
    const decision = decisionFor(preset, requires, unknown);
    goal.authority = {
      preset,
      requires,
      granted: decision.granted,
      missing: decision.missing,
      mode: decision.mode,
      reason: decision.reason,
      approvedAt: null,
    };
    if (decision.mode === 'approval' && !approved) {
      goal.verdict = 'PENDING';
      goal.failureCodes = ['awaiting-approval'];
      goal.trust = trustLadder(goal);
      goal.nextAction = nextAction(goal);
      goal.endedAt = null;
      await upsertTask(envelopeFromGoal(goal, goal.lineage));
      return goal;
    }
    if (approved) {
      // A retry resumes an ALREADY-APPROVED task: the genuine approval
      // timestamp recorded on the prior attempt is CARRIED forward, never
      // re-stamped — re-stamping would manufacture approval evidence the
      // operator never gave at this attempt's time. The retry authorization
      // itself is recorded transparently beside it.
      if (retryOf && carriedApprovalAt) {
        goal.authority.approvedAt = carriedApprovalAt;
        goal.authority.approvedFrom = 'carried-from-prior-attempt';
      } else {
        goal.authority.approvedAt = isoNow();
        goal.authority.approvedFrom = 'granted-at-this-attempt';
      }
      if (retryOf) {
        goal.authority.retryAuthorization = {
          authorizedAt: isoNow(),
          carriedApprovalAt: carriedApprovalAt || null,
          via: (authorization && authorization.source) || 'unspecified',
        };
      }
    }

    // ---- WORKSPACE → CONVERSATION (P2): the supported provisioning path. A
    // task carrying a workspace has its conversation provisioned here through
    // the real product path — no test-only seeding. Provisioning is idempotent
    // per task (its reuse path performs no creation), so it runs unconditionally
    // once a workspace is resolved. Placement is deliberate: AFTER the authority
    // block, so an unapproved task provisions nothing, and immediately BEFORE
    // the T1 gate, which still verifies the association live against Archon.
    // A retry reuses the parent task id and must NOT re-upsert: its stored
    // envelope already carries the association, and overwriting it would wipe
    // the association and blind a second creation. A fork mints a fresh task id
    // with no envelope, so it upserts its own first.
    if (goal.workspace) {
      if (!retryOf) await upsertTask(envelopeFromGoal(goal, goal.lineage));
      await provisionConversation({
        taskId,
        projectName: goal.workspace.name,
        expectedCodebaseId: goal.workspace.codebaseId,
        // The workspace identity the run must report as its working_path. It
        // rides the association so the expectation survives restart and is the
        // same value the recovery path sees — see lib/task-truth.js's
        // working-path leg for the stated cwd-override limitation.
        expectedWorkspacePath: goal.workspace.path,
        transport,
      });
    }

    // ---- T1 CONVERSATION GATE (S2-R, amended): a dispatch may only proceed
    // on the conversation explicitly and durably associated with this task,
    // verified LIVE against Archon immediately before dispatch. The run's
    // conversation_id must exactly equal the persisted association id, and the
    // workflow name must match independently (enforced again in run
    // discovery). A workflow-name-only fallback is prohibited. Anything short
    // of a verified association fails closed BEFORE any dispatch.
    const bound = await requireDispatchableConversation({ taskId, transport });
    conversationId = bound.conversationId;
    goal.conversationId = conversationId;
    goal.conversation = bound.association;

    // The exact message string is composed ONCE: dispatch sends it and T1
    // verification compares the run's recorded user_message against it.
    const dispatchMessage = 'task ' + taskId + ': ' + objective;
    attempt = {
      attempt: priorAttempts.length + 1,
      startedAt: isoNow(),
      workflow: route.selected.workflow,
      runId: null,
      status: null,
      outputs: [],
      verdict: null,
      failureCode: null,
      error: null,
      childConversationId: null,
      adoption: null,
      dispatch: null,
      discovery: null,
    };
    goal.attempts.push(attempt);

    const preIds = new Set();
    try {
      // The snapshot is taken from the SAME environment the dispatch is about to
      // go to — a pre-id list from another orchestrator would be meaningless.
      const lr = await fetch(transport.baseUrl + '/api/workflows/runs?limit=50', { headers: transport.headers(), signal: AbortSignal.timeout(transportTimeout(transport)) });
      if (lr.ok) {
        const lb = await lr.json();
        for (const r of (lb && lb.runs) || []) if (r && r.id) preIds.add(r.id);
      }
    } catch { /* discovery aid only */ }

    const dispatched = await dispatchWorkflow(route.selected.workflow, dispatchMessage, conversationId, transport);
    attempt.dispatch = {
      accepted: dispatched.accepted,
      status: dispatched.status,
      runId: dispatched.runId,
      responseSha256: dispatched.responseSha256,
    };
    const discovery = await discoverRun({
      workflowName: route.selected.workflow,
      preIds,
      conversationId,
      association: bound.association,
      dispatchedMessage: dispatchMessage,
      dispatchedRunId: dispatched.runId,
      transport,
    });
    if (discovery.status === 'ambiguous') {
      // Two runs independently verify as this dispatch: no unique attribution
      // means no adoption — fail closed rather than guess.
      throw Object.assign(
        new Error('run identity ambiguous — ' + discovery.candidates.length + ' runs independently verify as this dispatch: ' + discovery.candidates.join(', ')),
        { code: 'run-ambiguous' }
      );
    }
    if (discovery.status === 'unavailable') {
      // An outage is outcome-unknown, never run-not-found: the dispatch was
      // accepted, so a retry could double-run a workflow that may be alive.
      // The stray-run diagnostic is skipped too — its null must not be read
      // as "no run exists" while Archon is unreadable.
      attempt.discovery = {
        candidates: discovery.candidates,
        dispatchToken: discovery.dispatchToken,
        rejected: discovery.rejected.slice(0, 5),
        elapsedMs: discovery.elapsedMs,
        unavailable: true,
        reason: discovery.reason,
      };
      throw Object.assign(new Error('dispatch accepted but Archon could not be read during discovery — run outcome unknown (' + discovery.reason + ')'), { code: 'archon-unavailable' });
    }
    if (discovery.status === 'none') {
      // 'none' says only that nothing was ADOPTED — it is not by itself a claim
      // of absence. A candidate whose detail read was UNAVAILABLE or INVALID
      // means a run appeared that we hold an id for and could not read: an
      // outcome we cannot call an absence, and one that must never reach the
      // retry next-action (a retry could double-run a workflow that is alive).
      // This is derived BEFORE the P5 pre-dispatch-exclusion message below: a
      // run we hold an id for and could not read is the more dangerous fact
      // (the exclusion licenses a retry, an unreadable record does not), so it
      // wins when both are present. The exclusion is still recorded either way.
      const unreadable = (discovery.rejected || []).filter((r) => r.outcome === 'UNAVAILABLE' || r.outcome === 'INVALID');
      const unavailableIds = unreadable.filter((r) => r.outcome === 'UNAVAILABLE').map((r) => r.id);
      const invalidIds = unreadable.filter((r) => r.outcome === 'INVALID').map((r) => r.id);
      // An outage DOMINATES a bad record: if any candidate's read never
      // completed we cannot know what the others would have said either.
      const unreadableCode = unreadable.length ? (unavailableIds.length ? 'archon-unavailable' : 'evidence-invalid') : null;
      attempt.discovery = {
        candidates: discovery.candidates,
        dispatchToken: discovery.dispatchToken,
        rejected: discovery.rejected.slice(0, 5),
        excluded: (discovery.excluded || []).slice(0, 5),
        elapsedMs: discovery.elapsedMs,
        ...(unreadableCode ? { unreadableCode, unreadableRuns: unreadable.map((r) => r.id) } : {}),
      };
      // Derived BEFORE the stray diagnostic: that read exists only to make a
      // run-not-found refusal precise, so it is pointless (and a wasted read)
      // when the refusal is going to name an unreadable record instead.
      if (unreadableCode) {
        const why = [
          unavailableIds.length ? unavailableIds.length + ' unreadable (the record could not be read)' : null,
          invalidIds.length ? invalidIds.length + ' not usable as evidence' : null,
        ].filter(Boolean).join(', ');
        // No `verdict:` here — the catch derives it from the code, and it is the
        // only authority for it (see OUTCOME_UNKNOWN_CODES). `unreadableCode` is
        // always a member of that set, so this refusal seals UNKNOWN.
        throw Object.assign(
          new Error('dispatch accepted and ' + unreadable.length + ' run(s) matching this workflow appeared but could not be admitted (' + why + '): ' + unreadable.map((r) => r.id).join(', ') + ' — the run outcome is unknown, and an unreadable record is not an absence, so this is never reported as run-not-found'),
          { code: unreadableCode }
        );
      }
      // Identity-precise diagnostics before the generic code: a run that
      // appeared on OUR conversation under a DIFFERENT workflow is a T1
      // identity failure, and a workflow-name match on a foreign conversation
      // is exactly the adoption the amended rule prohibits.
      const stray = await findConversationRun(conversationId, preIds, transport);
      if (stray.status === 'unavailable') {
        // Reaching here means the FRESH LIST READ SUCCEEDED (zero successful
        // list reads return 'unavailable' earlier) and NO rejection was an
        // unreadable record (those are refused above), so the run-not-found
        // refusal below is derived from reads that answered. Only this SEPARATE
        // stray observation failed; the gap is recorded, never turned into a
        // claim about the run.
        attempt.discovery.strayDiagnostic = 'unavailable: ' + stray.reason;
      } else if (stray.run) {
        throw Object.assign(
          new Error('run ' + stray.run.id + ' appeared on conversation ' + conversationId + ' with workflow ' + (stray.run.workflow_name || (stray.run.workflow && stray.run.workflow.name) || 'unknown') + ', expected ' + route.selected.workflow),
          { code: 'workflow-name-mismatch' }
        );
      }
      // P5: a fully-linked run excluded ONLY because it predates the dispatch
      // makes the generic "no run appeared" a false statement. The code stays
      // run-not-found (retry is the right action in both cases) but the message
      // must not deny a run that is sitting on this conversation.
      if ((discovery.excluded || []).length) {
        throw Object.assign(new Error('dispatch accepted but no run appeared — ' + discovery.excluded.length + ' fully-linked run(s) were excluded on the pre-dispatch snapshot boundary (they predate this dispatch): ' + discovery.excluded.map((e) => e.id).join(', ')), { code: 'run-not-found' });
      }
      throw Object.assign(new Error('dispatch accepted but no run appeared'), { code: 'run-not-found' });
    }
    attempt.adoption = discovery.adoption;
    attempt.childConversationId = discovery.adoption.childConversationId;
    attempt.runId = discovery.adoption.runId;

    const evidence = await pollRun(attempt.runId, transport);
    if (evidence.status === 'unavailable') {
      // The run record could not be read at all: outcome unknown, never a
      // timeout (a timeout claims the run was read and simply never finished).
      throw Object.assign(new Error('dispatch accepted but the run record could not be read while awaiting a terminal state — run outcome unknown (' + evidence.reason + ')'), { code: 'archon-unavailable' });
    }
    if (evidence.status === 'invalid') {
      // Archon ANSWERED, and what it answered is not the run we adopted. That is
      // corrupt evidence, not an outage and not a timeout: a timeout would claim
      // the run was read and never finished, which is a claim about the WORK for
      // a record we never obtained. This is the branch the poll's INVALID outcome
      // needs — without it a non-record body would fall through to `!==
      // 'terminal'` and still refuse run-timeout. The code is the same one the
      // detail reader's INVALID outcome maps to, so the verdict is derived at the
      // single catch site rather than restated here.
      throw Object.assign(new Error('dispatch accepted and the run was adopted, but every read while awaiting a terminal state returned a body that is not the run record — the run outcome is unknown, and a record we could not obtain is not a run that failed to finish (' + evidence.reason + ')'), { code: 'evidence-invalid' });
    }
    if (evidence.status !== 'terminal') throw Object.assign(new Error('run did not reach a terminal state within ' + (RUN_TERMINAL_WINDOW_MS / 1000) + 's'), { code: 'run-timeout' });
    attempt.status = (evidence.run && evidence.run.status) || null;
    attempt.endedAt = isoNow();
    attempt.outputs = collectOutputs(evidence.events).map((o) => o.node + ': ' + o.output).slice(0, 10);
    const composed = composeEvidence({ detailText: evidence.detailText, outputs: attempt.outputs });
    const evidenceText = composed.evidenceText;
    goal.evidence = { contract: composed.contract, events: (evidence.events || []).length, outputs: attempt.outputs, evidenceSha256: composed.evidenceSha256 };

    // ---- VERIFY (M1: the evaluation gate — terminal status + declared
    // expectation + OBJECTIVE SATISFACTION, in that order; 'verifier quorum'
    // is reserved for independent verification authorities that vote). Every
    // check records its detail inline: a BLOCK names what missed.
    //
    // KNOWN GAP, ENUMERATED, NOT YET FIXED — the terminal-status rule has TWO
    // halves and only the READ half is landed (lib/run-status.js). pollRun now
    // classifies case-insensitively, but the CONSUMERS below compare the RAW
    // value, so a run reporting 'COMPLETED' stops the poll correctly and is then
    // judged as though it had not finished. The four sites, in the order this
    // chain reaches them. Each is named by its ENCLOSING FUNCTION and the
    // expression itself, never by a line number: two of the four references in
    // the first draft of this block were already wrong by the time the block was
    // finished — one of them pushed down by the block's own length. Find them by
    // the expression.
    //   1. trustLadder          `executed`, the old deny-list:
    //                           !['running','queued','pending'].includes(last.status)
    //   2. the VERIFY site      goal.execution = { completed: evidence.run.status
    //                           === 'completed', ... }
    //   3. validateCapability   `pass: runStatus === terminalExpected`
    //   4. deriveGoalVerdict    `execution.status === 'failed'`, and the
    //                           `execution.completed !== true` test below it
    // Consequence, worst first: (2) makes `execution.completed` false, so (4)
    // returns FAILED / `run-not-terminal` and nextAction then tells the operator
    // "the run left no terminal status to evaluate" — a FALSE claim about a run
    // that reported a terminal status we did not fold. (lib/verify.js has the
    // same pair — `runStatus !== expect.terminalStatus` in evaluateEvidence, and
    // `runObj.status === 'failed'` in probeA — where the code is coarse but the
    // prose is honest, because the blocker appends the actual status. Here the
    // prose itself lies, which is why this one matters more.)
    // THE FIX IS `normaliseRunStatus` ON THE COMPARISON, NEVER ON THE RECORD:
    // attempt.status and goal.execution.status are evidence and are hashed into
    // the receipt, so normalising them would rewrite what we claim we observed.
    // Not landed here because it is ONE coordinated change with lib/verify.js's
    // pair and the ruling is pending; the flip set is EMPTY (every fixture drives
    // lowercase statuses and declares a lowercase terminalStatus).
    goal.execution = { completed: evidence.run.status === 'completed', status: evidence.run.status, runId: attempt.runId };
    goal.capabilityValidation = validateCapability({ runStatus: evidence.run.status, expect, evidenceText });
    goal.objectiveEvaluation = evaluateObjective({
      executionCompleted: goal.execution.completed,
      capabilityValidation: goal.capabilityValidation,
      evaluator: objectiveEvaluator,
      evidenceText,
    });
    // The receipt's execution identity, ESTABLISHED BY THE PATH THAT RAN: the
    // environment comes from the binding this attempt resolved, and the provider
    // claim from the run record the orchestrator itself returned. The claim is
    // then ENFORCED, not merely recorded — a run claiming a provider the bound
    // environment never declared cannot be sealed as a satisfied goal.
    goal.executionEnvironment = {
      ...receiptEnvironment(environment),
      establishedBy: 'adopted-run',
      runId: attempt.runId,
      identity: executionIdentityFromRun({ environment, run: evidence.run, source: 'adopted-run', config: resolved.config }),
    };
    const claimVerdict = goal.executionEnvironment.identity.providerClaim;
    // ---- P6D execution leg (the SECOND witness). A bridge-declaring capability
    // requires the worker's own receipt: the id its node output carried, the
    // server-side record that id names, and the claim re-derived against the
    // WORKER environment's declaration — never the dispatch environment's. The
    // dispatch leg above stays `adopted-run`; the two witnesses are recorded
    // side by side, never folded. No bridge declared → this block does not run
    // and the receipt keeps its exact pre-P6D shape.
    let bridgeVerdict = null;
    if (capability.bridge) {
      const idMatch = BRIDGE_ID_FIND.exec(evidenceText);
      const bridgeId = idMatch ? idMatch[0] : null;
      const record = bridgeId ? await loadBridgeReceipt(resolved.home, bridgeId) : null;
      const declaredWorkerEnvId =
        typeof capability.bridge === 'object' && capability.bridge && capability.bridge.environmentId
          ? String(capability.bridge.environmentId)
          : null;
      // The receipt's environmentId resolves to the config's worker environment;
      // a capability-declared id, when present, is the environment this goal is
      // authorized to check against — a receipt minted for another environment
      // then fails the declared-id comparison instead of silently re-binding.
      const workerEnvId = declaredWorkerEnvId || (record && record.environmentId) || null;
      let workerEnvironment = null;
      if (workerEnvId) {
        try {
          workerEnvironment = resolveEnvironment({ environmentId: workerEnvId, config: resolved.config });
          requireEnvironmentAdapter(workerEnvironment);
        } catch {
          // An unresolvable worker is reported fail-closed by the verdict below
          // (bridge-environment-unresolvable) — not as a generic goal-failed.
          workerEnvironment = null;
        }
      }
      bridgeVerdict = verifyBridgeReceipt(record, {
        environmentId: workerEnvId,
        environment: workerEnvironment,
        config: resolved.config,
      });
      goal.executionEnvironment.worker = {
        establishedBy: 'bridge-receipt',
        id: bridgeId,
        status: bridgeVerdict.status,
        ok: bridgeVerdict.ok === true,
        code: bridgeVerdict.code || null,
        claimed: bridgeVerdict.claimed !== undefined ? bridgeVerdict.claimed : null,
        declared: bridgeVerdict.declared !== undefined ? bridgeVerdict.declared : null,
        reason: bridgeVerdict.reason,
        environmentId: workerEnvironment ? workerEnvironment.environmentId : workerEnvId,
        identitySha256: bridgeVerdict.identitySha256 || null,
        receiptSha256: bridgeVerdict.receiptSha256 || null,
        runExitCode: bridgeVerdict.runExitCode !== undefined ? bridgeVerdict.runExitCode : null,
        cleanupOk: bridgeVerdict.cleanupOk !== undefined ? bridgeVerdict.cleanupOk : null,
        dead: bridgeVerdict.dead !== undefined ? bridgeVerdict.dead : null,
        posture: bridgeVerdict.posture || null,
      };
    }
    // One flat, inspectable list — the evidence drawer renders it and the
    // trust ladder reads it; objective-satisfaction is the rung-3 witness. The
    // bridge check exists ONLY on bridge-declaring goals.
    goal.checks = [
      ...goal.capabilityValidation.checks,
      { id: 'objective-satisfaction', pass: goal.objectiveEvaluation.status === 'SATISFIED', detail: goal.objectiveEvaluation.reason },
      { id: 'execution-provider-claim', pass: claimVerdict.ok === true, detail: claimVerdict.reason },
      ...(bridgeVerdict ? [{ id: 'bridge-provider-claim', pass: bridgeVerdict.ok === true, detail: bridgeVerdict.reason }] : []),
      ...(goal.objectiveEvaluation.checks || []),
    ];
    goal.claim = buildClaim({
      kind: 'goal-satisfied',
      label: 'Goal satisfied',
      objectiveEvaluation: goal.objectiveEvaluation,
      capabilityValidation: goal.capabilityValidation,
      execution: goal.execution,
      observed: attempt.outputs,
      provenance: { capability: route.selected.id, version: route.selected.version, workflow: route.selected.workflow },
    });

    const verdictDecision = deriveGoalVerdict({ execution: goal.execution, capabilityValidation: goal.capabilityValidation, objectiveEvaluation: goal.objectiveEvaluation });
    goal.verdict = verdictDecision.verdict;
    if (verdictDecision.failureCode) goal.failureCodes.push(verdictDecision.failureCode);
    // A provider claim the bound environment cannot account for is an integrity
    // failure of the receipt, not a capability shortfall: it blocks regardless of
    // what the evaluation found, and it never softens a FAILED verdict.
    if (claimVerdict.ok !== true) {
      if (goal.verdict !== 'FAILED') goal.verdict = 'BLOCK';
      goal.failureCodes.push(claimVerdict.code);
    }
    // The execution leg is the same class of integrity failure: a
    // bridge-declaring goal whose receipt is missing, unresolvable, tampered,
    // or claim-mismatched blocks the receipt regardless of a green objective,
    // and it never downgrades a FAILED verdict.
    if (bridgeVerdict && bridgeVerdict.ok !== true) {
      if (goal.verdict !== 'FAILED') goal.verdict = 'BLOCK';
      goal.failureCodes.push(bridgeVerdict.code);
    }

    goal.trust = trustLadder(goal);
    goal.nextAction = nextAction(goal);
  } catch (e) {
    // The verdict is derived from the refusal CODE, at this ONE site, which is
    // the only authority for it. A code meaning "we could not read it" seals
    // UNKNOWN; every other refusal is FAILED. Deriving here rather than on each
    // throw is deliberate: the three throws that raise an outcome-unknown code
    // are covered by construction, so a fourth cannot forget to carry a verdict
    // (the state this replaced: the unreadable-record throw sealed UNKNOWN while
    // the discovery-outage and terminal-poll throws — same code — sealed FAILED).
    goal.verdict = OUTCOME_UNKNOWN_CODES.has(e && e.code) ? OUTCOME_UNKNOWN_VERDICT : 'FAILED';
    goal.failureCodes.push((e && e.code) || 'goal-failed');
    goal.error = String((e && e.message) || e).slice(0, 200);
    // Only OUR attempt is stamped: attempts carried in from a prior attempt are
    // immutable recorded truth. The failure this invocation hit is recorded on
    // the attempt it belongs to, beside the goal-level code.
    if (attempt && !attempt.endedAt) attempt.endedAt = isoNow();
    if (attempt) {
      attempt.failureCode = (e && e.code) || 'goal-failed';
      attempt.error = String((e && e.message) || e).slice(0, 200);
    }
    // Even a refusal carries its ladder + next action: Observed + the
    // operator action that unblocks it (configure / teach / refine).
    goal.trust = trustLadder(goal);
    goal.nextAction = nextAction(goal);
  }

  goal.endedAt = isoNow();
  await upsertTask(envelopeFromGoal(goal, goal.lineage));
  return goal;
}
