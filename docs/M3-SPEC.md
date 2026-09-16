# M3 — General Capability Acquisition (spec for adjudication)

Status: ACCEPTED by GPT (checkpoint `fbdf976`), amendments folded in below.
Implementation still HOLD until M3.0 dev-suite adjudication.
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

- **Budgets (ACCEPTED as hard ceilings, conjunctive):** attempts ≥ 4 **OR**
  output_tokens ≥ 50,000 **OR** wall ≥ 10 min → terminal
  `REFUSED / BUDGET_EXHAUSTED`. Any single ceiling hit refuses — no further
  attempts. The cost ledger tracks **input + output + cache tokens** where
  exposed (the 50k output ceiling is not the complete model budget; total
  model-usage ceilings are a supported contract field for later tuning).
  Budget exhaustion is a normal terminal state, recorded honestly.
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
- **Evaluator boundary (anti-self-grading amendment):** an evaluator_plan is
  never accepted solely because the acquisition session proposed it. A
  separate evaluator boundary validates the proposed plan against the
  independently frozen acceptance conditions before it evaluates observed
  effects. This yields an M3 metric: **evaluator-plan agreement** — does the
  capability's own proposed evaluation agree with independent ground truth.
  This is the instrument that catches permissive false-SHIP evaluators and
  the next false-BLOCK.
- Lexical correspondence may contribute weak evidence; it can **never veto**
  stronger direct evidence (sealed ruling on the false-BLOCK receipt).
- Eval v1 records continue to carry both truths separately:
  `external_objective_satisfied` (frozen result-state grader, authoritative),
  `system_verdict` (RCOS's own decision), and
  `verdict_agrees_with_external`. **False SHIP** and **False BLOCK** are
  first-class error classes. Verify effects, not phrasing.

## 3. What does NOT change

1. Eval Protocol v1, corpus, and hashes — untouched, still frozen.
2. Registry schema and promotion machinery and the fail-closed authority
   gate (`lib/authority.js` SCOPES, presets, gate-before-dispatch) —
   unchanged. Two distinct concepts, never conflated:
   **admission eligibility** (the registry gate: `admitted_after` = two
   distinct-task ships) ≠ **operator promotion authorization** (the explicit
   human click). Two ships never authorize a bypass of the click.
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
- **Suite shape (ACCEPTED): 4 families × 3 encounters (12 objectives)** with
  semantically distinct encounter roles per family: **encounter 1 =
  acquisition**, **encounter 2 = reuse under ordinary variation** (not a
  rename), **encounter 3 = contract-preserving perturbation / generalization**
  (irrelevant data, changed ordering/layout, extra files, changed
  cardinality, benign edge cases). M3.2 is not required to "win" all four
  families — trustworthy success and refusal behavior is the target.
- **Freeze bundle (seed PUBLIC):** generator source hash, generator version,
  seed, manifest hash, fixture hashes, expected-state hashes, grader hashes,
  generation timestamp — all committed together. Post-freeze rule is
  behavioral: nothing changes because M3 performed poorly; if the suite
  itself is defective, record the defect and version the WHOLE suite.
- The frozen suite manifest is submitted for adjudication (M3.0) before any
  acquisition run touches it, with an explicit contamination statement
  confirming nothing from Eval v1 hidden encounters entered generation.

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

## 6. Adjudicated answers (sealed)

1. Budgets accepted as hard ceilings; conjunctive exhaustion; ledger tracks
   input + output + cache tokens (§2.2).
2. Dev suite 4×3 kept; encounters carry acquisition / reuse / perturbation
   roles (§4).
3. Promotion stays an explicit human click for M3; auto-promotion is a future
   policy, never smuggled in. Admission eligibility ≠ promotion
   authorization (§3).
4. Generator seed PUBLIC + frozen; freeze bundle per §4; post-freeze rule is
   behavioral (version the whole suite, never silently patch cases).

## 7. M3.0 acceptance target (next deliverable)

Bring the **suite only** — no acquisition runs. Four genuinely distinct
families; three encounters each with acquisition/reuse/perturbation roles;
independent expected-state graders; public frozen seed/generator; all hashes;
explicit contamination statement. On pass: **M3.0 FROZEN → M3.1 authorized.**
