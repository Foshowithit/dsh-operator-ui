// lib/candidate-promotion.js — the promotion gate for a PLAIN registry candidate.
//
// WHY THIS MODULE EXISTS
//
// RCOS has TWO promotion paths, and only one of them exists:
//   1. lib/teach.js promoteCandidate — promotes a TEACHING task's capability
//      after re-deriving its held-out evaluation evidence. Rigorous, shipped.
//   2. A plain registry candidate (e.g. `mac-dell-staging`, status:'candidate')
//      — created outside the teaching flow — has NO promote path at all.
//
// The roadmap's Capability-library law is explicit:
//   "Each shipped capability includes a versioned input/output contract, exact
//    runtime binding, declared dependencies and scopes, examples, independent
//    evals, negative cases, provenance, license information and resource
//    limits. … Do not promote on an agent's self-score."
//
// ---------------------------------------------------------------------------
// SCHEMA HONESTY (measured 2026-10-08, canonical Dell registry)
// ---------------------------------------------------------------------------
// An earlier revision of this module invented two legs — `verification.
// expectOutput` and `objectiveEvaluation.kind` — that DO NOT EXIST in the real
// RCOS registry schema. Measured against /home/chow/zcode-rcos/registry/
// capability-registry.json, all 42 PROMOTED capabilities carry neither field,
// and the canonical `promoteCapability` in lib/registry.js never reads them.
// Those legs were an invented check that could never pass on real data — the
// exact "a gate that cannot fire is not a gate" defect the both-arms doctrine
// names. They are REMOVED here and replaced by the canonical x2-ship rule.
//
// The real registry entry shape (authoritative, from lib/registry.js):
//   { id, name, kind, version, status, admitted_after[], evals[],
//     reuse_count, last_eval, lineage?, retirement?, provenance?, adapter? }
//   eval entry: { task_id, verdict: 'ship'|'fix'|'blocked', run_id,
//                 provenance: 'executed'|'asserted' }
//
// The canonical x2-ship gate (lib/registry.js promoteCapability) requires:
//   a. status === 'candidate'
//   b. >= 2 ship evals
//   c. >= 2 DISTINCT task_ids among the ships ("the point is transfer, not
//      memorization")
//   d. every ship eval carries a non-empty run_id ("no run id, no admission")
//   e. retirement is ARMED AT ADMISSION (promotion without retirement is
//      hoarding; the registry must shrink as well as grow)
//
// This module mirrors that rule EXACTLY and adds the operator-explicit step:
// canonical `rcos promote` is a bare CLI ceremony, but promotion here is
// EVIDENCE-CHECKED and requires an explicit operator assertion, so an agent can
// never promote its own candidate on a self-score.
//
// A reuse count is an EXECUTION signal, never a quality signal, and is never
// sufficient on its own — it is reported, never load-bearing.

export const PROMOTION_SCHEMA = 'rcos-candidate-promotion/2';

// The canonical retirement policy version, mirrored from lib/registry.js so a
// promotion performed through this gate arms retirement identically to
// `rcos promote`.
export const RETIREMENT_POLICY_VERSION = 'rcos-retire/1';

function refuse(code, message, legs) {
  return { ok: false, code, error: String(message).slice(0, 300), legs: legs || [] };
}

// Ordered gate. Each leg is { id, pass, code, detail }. The decision is the
// conjunction over ALL legs; the FIRST failing leg named in order is the
// headline refusal code, so the operator is told the earliest thing to fix.
//
// `evalSet` is accepted for CALLERS THAT ALSO HOLD AN INDEPENDENT EVAL SET
// (e.g. a held-out suite run out-of-band). It is OPTIONAL and ADDITIVE: when
// present it can only ADD evidence legs, never replace the canonical
// registry-eval legs. When absent the canonical legs stand alone — which is the
// real-world case, because the registry IS the eval record of truth.
export function evaluatePromotion({ entry, ledger, contract, evalSet } = {}) {
  const legs = [];
  const check = (id, pass, code, detail) => legs.push({ id, pass: !!pass, code: pass ? null : code, detail: detail || null });

  // 1. The entry must be a plain candidate (not already promoted, not retired).
  const status = entry && entry.status;
  check('candidate', status === 'candidate', 'not-a-candidate', 'lifecycle is ' + String(status));

  // 2. A declared input/output contract. It may be INLINE (a resolved contract
  //    object) OR DECLARED BY PATH on the entry's adapter (`adapter.contract`).
  //    The registry convention is the path form: the contract file lives beside
  //    the adapter. Both are acceptable declarations; neither is a guess.
  const declaredContractPath = entry && entry.adapter && typeof entry.adapter.contract === 'string' ? entry.adapter.contract : null;
  const hasInlineContract = !!(contract && contract.input && contract.output);
  const hasContract = hasInlineContract || !!declaredContractPath;
  check('contract-declared', hasContract, 'contract-absent', hasContract ? null : 'no contract (inline or adapter.contract path)');

  // 3. An executable runtime binding OR an explicit runbook binding. The
  //    canonical rule needs an adapter entrypoint for a `script` kind, and a
  //    `workflow` for a runbook/workflow-backed capability. Either proves the
  //    entry can actually be reached — a promoted-but-unreachable capability is
  //    the exact defect lib/registry.js warns about
  //    (`non_executable_promoted`).
  const entrypoint = entry && entry.adapter && typeof entry.adapter.entrypoint === 'string' ? entry.adapter.entrypoint : null;
  const wh = entry && typeof entry.workflow === 'string' && entry.workflow.length ? entry.workflow : null;
  const reachable = !!(entrypoint || wh);
  check('runtime-bound', reachable, 'runtime-unbound', reachable ? null : 'no adapter.entrypoint and no workflow binding');

  // ---- canonical x2-ship legs -----------------------------------------------
  const evals = Array.isArray(entry && entry.evals) ? entry.evals : [];
  const ships = evals.filter((e) => e && e.verdict === 'ship');

  // 4. >= 2 shipped evals.
  check('x2-ship-count', ships.length >= 2, 'x2-ship-insufficient', 'needs 2 shipped evals, has ' + ships.length);

  // 5. >= 2 DISTINCT task ids — same-task repeats do not count.
  const shipTasks = [...new Set(ships.map((e) => e && e.task_id).filter((t) => typeof t === 'string' && t.length))];
  check('x2-distinct-tasks', shipTasks.length >= 2, 'x2-tasks-not-distinct',
    'needs 2 DISTINCT shipped task ids (transfer, not memorization), has ' + shipTasks.length +
    (shipTasks.length === 1 ? ' (both ships on \'' + shipTasks[0] + '\')' : ''));

  // 6. Every ship eval must carry a non-empty run id — "no run id, no admission".
  const runless = ships.filter((e) => !e || typeof e.run_id !== 'string' || e.run_id.trim().length === 0);
  check('x2-run-ids', runless.length === 0, 'x2-run-id-missing',
    runless.length ? 'ship eval(s) missing run_id: ' + runless.map((e) => (e && e.task_id) || '?').join(', ') : null);

  // 7. Executed provenance is the STRONGER form. The canonical rule does not
  //    require it, so this is NOT fatal — but the count is surfaced so an
  //    operator promoting on asserted-only evidence is told plainly.
  const executed = ships.filter((e) => e && e.provenance === 'executed').length;

  // 8. Retirement is armed at admission. If the entry already carries one the
  //    canonical rule treats it as satisfied; otherwise this leg records that
  //    `promotedEntry` WILL arm it (never a refusal — arming is what we do).
  const retirementArmed = !!(entry && entry.retirement);
  check('retirement-armable', true, null, retirementArmed ? 'retirement already armed' : 'retirement will be armed at admission (rcos-retire/1)');

  // 9. An ADDITIVE independent eval set, when the caller holds one. Optional:
  //    absent is not a failure (the registry is the eval record of truth), but
  //    a present-but-empty set is reported as a named gap.
  if (evalSet !== undefined) {
    const held = Array.isArray(evalSet) ? evalSet : [];
    check('independent-eval-set', held.length >= 1, 'independent-evals-absent', held.length ? held.length + ' independent case(s)' : 'caller passed an empty independent eval set');
  }

  // 10. A reuse ledger record is EXPECTED but is only supporting evidence: it can
  //     strengthen (an executed reuse exists) but a missing reuse is NOT fatal —
  //     it is reported, and the decision NEVER turns on it alone.
  const reused = Array.isArray(ledger && ledger.records) ? ledger.records.filter((r) => r && r.capabilityId === entry.id).length : 0;

  const failing = legs.filter((l) => !l.pass);
  const decision = {
    schema: PROMOTION_SCHEMA,
    capabilityId: entry && entry.id,
    promote: failing.length === 0,
    headlineCode: failing.length ? failing[0].code : null,
    remaining: failing.map((l) => l.code),
    legs,
    shipCount: ships.length,
    distinctShipTasks: shipTasks,
    executedShipCount: executed,
    reuseCount: reused,
    canonicalRule: 'x2-ship + 2 distinct tasks + run ids + retirement-at-admission (lib/registry.js promoteCapability)',
    note: reused === 0
      ? 'no executed reuse is recorded yet — the canonical gate does not require one; a reused capability is stronger evidence'
      : 'executed reuse recorded (' + reused + '×) — supporting evidence, never sufficient by itself',
  };
  return decision;
}

// The operator-explicit promotion. Refuses unless the caller asserts operator
// intent AND every leg passes. Writes the promoted entry with rollback lineage
// and arms retirement exactly as the canonical `rcos promote` does.
export function promotedEntry({ entry, decision, operatorAsserted, at } = {}) {
  if (!operatorAsserted) return refuse('operator-assertion-required', 'promotion requires an explicit operator assertion');
  if (!decision || decision.promote !== true) return refuse((decision && decision.headlineCode) || 'evidence-insufficient', 'the promotion gate did not pass: ' + String(decision && decision.headlineCode));
  const date = at || null;
  const prior = { version: entry.version, status: entry.status, workflow: entry.workflow || null };
  const tasks = decision.distinctShipTasks || [...new Set((entry.evals || []).filter((e) => e && e.verdict === 'ship').map((e) => e.task_id))];
  return {
    ok: true,
    entry: {
      ...entry,
      status: 'promoted',
      admitted_after: tasks,
      retirement: entry.retirement || {
        armed_at: date,
        policy_version: RETIREMENT_POLICY_VERSION,
        decay: { window: 5, threshold: null },
        neglect: { n: 20, threshold: null },
      },
      provenance: {
        ...(entry.provenance || {}),
        promotedBy: 'operator',
        promotedFrom: prior,
        promotionEvidence: {
          schema: PROMOTION_SCHEMA,
          canonicalRule: decision.canonicalRule,
          legsPassed: (decision.legs || []).map((l) => l.id),
          shipCountAtPromotion: decision.shipCount,
          distinctShipTasks: tasks,
          executedShipCount: decision.executedShipCount,
          reuseCountAtPromotion: decision.reuseCount,
        },
      },
      rollback: { toStatus: prior.status, toVersion: prior.version, at: date },
    },
  };
}
