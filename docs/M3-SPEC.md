# M3 — General Capability Acquisition (spec for adjudication)

Status: DRAFT for GPT adjudication. **No implementation until ACCEPTED.**
Frozen context: Eval Protocol v1 (protocol/corpus/grader hashes in
`eval/corpus-manifest.json`), sealed checkpoints `a9fad3f` (preflight),
`261fa48` (M2 Teach-path audit: BUILD is specialized), `06acfcd` (probe-run
provenance + false-BLOCK receipt). Owner: this repo. Adjudicator: the
DeepSeek RCOS design thread.

## 1. The gap M3 closes

RCOS has a proven lifecycle — GAP → CANDIDATE → EVALUATE → PROMOTE → ROUTE —
and the M2 audit proved its BUILD stage is a specialized demonstration
(`lib/teach.js` composes the hardcoded `workspace-word-count` candidate
regardless of the source objective, with zero model wiring). The independent
variable of Eval v1 — **evaluated reusable capability acquisition** — is not
implemented. M3 implements it. M3 is not "better Teach"; it is the missing
acquisition engine behind the already-proven lifecycle.

## 2. The two contracts

### 2.1 CapabilityAcquirer

```
CapabilityAcquirer(objective, task_context, available_primitives,
                   authority_policy)
  → CandidateCapability {
      manifest            // id, version, description
      implementation      // Archon workflow YAML — deterministic bash nodes
      output_contract     // the operator-legible result lines it promises
      routing_vocabulary  // declared tags for future routing
      required_authority  // scopes declared BEFORE routable (existing law)
      evaluator_plan      // how success is established from observable state
      provenance          // source task, acquisition session, cost ledger
    }
```

**Backend: DSH is the cognitive acquisition runtime.** No second ad-hoc model
harness inside RCOS: each acquisition attempt is a headless DSH session on the
frozen model lane (same endpoint/model/sampling as the eval baseline), driven
by the same mechanism as the DSH eval lane (`eval/lib/run-dsh-lane.mjs`
pattern). Every model call is metered as **teaching cost** — input/output
tokens and wall time recorded per phase, per the shakedown instrumentation.

### 2.2 The acquisition loop (bounded, evaluated)

```
inspect environment (workspace, available primitives, registry)
→ propose candidate (implementation + evaluator_plan)
→ execute isolated (fresh staged workspace, real Archon)
→ evaluate (evaluator_plan on observable state, held-out dev fixtures)
→ on failure: diagnose from evidence → MATERIALLY revise strategy
→ re-evaluate
→ terminal: CANDIDATE (every case passes) | REFUSED (budget exhausted
  or revision loop detected)
```

- **Budgets (defaults, §6):** ≤ 4 acquisition attempts, ≤ 50k output tokens,
  ≤ 10 min wall per acquisition. Budget exhaustion is a normal terminal state,
  recorded honestly.
- **Revision must be material:** a revision that does not change the strategy
  (same plan re-prompted) terminates the loop as REFUSED with the diagnosis
  trail as provenance.
- **No self-improvement:** the acquirer never edits its own prompt, code, or
  budget; revision happens inside a session bound to a fixed system contract.
- **Failure provenance:** every candidate and every evaluation — passed or
  failed — is preserved and hash-anchored through the existing
  `eval/lib/record.mjs` + `experiment.mjs` identity fields.

### 2.3 ObjectiveEvaluator

```
ObjectiveEvaluator(objective, evidence, task_context, evaluator_plan)
  → { result, reasons, evidence_refs, evaluator_identity, limitations }
```

- `evaluator_plan` is part of every CandidateCapability and defines how
  success is established from observable state: exact structured output,
  schema validation, file/state diff, invariant check, artifact inspection,
  or deterministic predicate. An independent model evaluator is allowed only
  where deterministic verification is impossible, and must carry explicit
  limitations.
- Lexical correspondence may contribute weak evidence; it can **never veto**
  stronger direct evidence (sealed ruling on the false-BLOCK receipt).
- Eval v1 records continue to carry both truths separately:
  `external_objective_satisfied` (frozen result-state grader, authoritative),
  `system_verdict` (RCOS's own decision), and
  `verdict_agrees_with_external`. **False SHIP** and **False BLOCK** are
  first-class error classes. Verify effects, not phrasing.

## 3. What does NOT change

1. Eval Protocol v1, corpus, and hashes — untouched, still frozen.
2. Registry schema and promotion gate (`admitted_after` = two distinct-task
   ships) and the fail-closed authority gate (`lib/authority.js` SCOPES,
   presets, gate-before-dispatch) — unchanged.
3. Promotion stays an explicit human click; acquired capabilities carry
   permanent provenance and declare `requires` before they can route.
4. No third store: acquisition envelopes live in `tasks.json` exactly like
   M2's teaching envelopes; artifacts under `eval/records/`.

## 4. Benchmark protection (hard rules)

- M3 development must not read Eval v1 hidden encounters 3–5 — their
  workspaces, `expected.json`, or graders — for any purpose.
- M3 proves out on a **separate synthetic acquisition dev suite**: new
  families generated by a new generator with its own independent seed,
  committed and hash-frozen before the first Eval v1 contact.
- Proposal: **4 families × 3 encounters (12 objectives)**, matched to Eval v1
  families in shape only, zero content reuse.
- The dev suite's frozen manifest is itself submitted for adjudication
  (milestone M3.0) before any acquisition run touches it.

## 5. Milestones (each ends commit + push + report to the thread)

- **M3.0** Dev suite: generator, families, frozen manifest → adjudication.
- **M3.1** CapabilityAcquirer skeleton wired to the DSH runtime; honest
  REFUSED path on budget exhaustion proven first.
- **M3.2** Full acquisition loop live on the dev suite: at least one family
  acquired end-to-end (acquire → evaluate → promote → reuse) or honest
  refusal data showing why not.
- **M3.3** ObjectiveEvaluator + dual-truth records on all paths.
- **M3.4** Dev-suite report: acquisition cost vs reuse amortization, False
  SHIP/BLOCK rates, refusal quality → GPT go/no-go on the Eval v1 50-task
  scored run.

## 6. Questions for the adjudicator

1. Budget defaults acceptable? (≤4 attempts / ≤50k output tokens / ≤10 min)
2. Dev-suite size: 4×3, or a different mix?
3. Confirm: promotion of M3-acquired capabilities stays a human click (we
   read M2 law as yes).
4. Dev-suite generator seed: public in-repo + frozen (our lean — fully
   reproducible, tuning prohibited by rule), or hidden?
