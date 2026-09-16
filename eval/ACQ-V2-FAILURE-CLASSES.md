# Capability Acquisition v2 — Failure-Class Decomposition (GPT directive, step 1)

Scope: the 16 refused acquisitions from the sealed scored run
(bb6ab6d / scored-40d21bd3). Method: forensic replay — each failed
candidate workflow was re-executed on real Archon against its family
fixture and re-graded against post-run workspace state + evidence
(eval/lib/acquire-v2-forensics.mjs → eval/ACQ-V2-FORENSICS.json).

## The class table

| class | count | families | meaning |
|---|---|---|---|
| grader-coverage gap | 9 | F02×2, F05×2, F06×2, F07×2, F10×1 | candidate ran to `completed` on real Archon with plausible correct-shaped output; no deterministic grader existed to verify it |
| grader-location defect | 4 | F04×2, F08×2 | candidate's output artifact was CORRECT in the execution workspace (`sorted.txt` / `stock.json` byte-compared PASS on replay) but the scored-run grader read the staging directory instead — misgraded as failure |
| substantive wrong-output | 2 | F01×2 | composed workflow produced no `TOTAL` line — output contract partially missed; genuinely wrong or incomplete |
| (successful) | 2 | F03, F09 | promoted during the run |

## What this rewrites

The sealed v1 number (acquisition success 2/18) is a **lower bound**.
Forensic replay reclassifies the 16 refusals as:

- 4 provably-correct candidates misgraded by instrumentation (grader read
  the wrong directory);
- 9 completed-execution candidates with no grader in scope — acquisition
  may have succeeded but was unverifiable under the frozen harness;
- 2 genuinely wrong outputs (both F01, the same failure mode: the
  candidate's evidence lacked the TOTAL contract line);
- (the remaining refused attempt corresponds to a candidate whose file was
  overwritten by a later attempt — noted, not replayable).

So the dominant v1 failure class was **measurement infrastructure**
(grader coverage + grader location), not candidate quality. This does not
change the sealed v1 result (it stands as-run, per GPT); it defines what
Acquisition v2 must build first.

## The real engineering signal that survives

Even after reclassification, 2-of-10 gradeable families succeeded per
attempt and several families needed multiple attempts — the acquisition
loop's diagnose-and-revise capability is the bottleneck GPT predicted:
today's loop is MODEL → candidate → evaluate → fail → refuse, with no
failure-driven revision.

## Acquisition v2 design (derived from the classes)

1. **Grader coverage first**: deterministic result-state graders for ALL
   10 families (F02 inventory, F05 verdict, F06 release evidence, F07
   duplicate set/order, F10 mismatch set). Every family gradeable.
2. **Artifact-location contract**: the acquisition prompt and the grader
   agree on WHERE artifacts must be written (workspace root), and the
   grader reads the execution workspace — never a staging copy.
3. **Static checks before execution**: YAML schema validation (the exact
   node dialect), marker-line presence, forbidden-content scan (network,
   credentials), name uniqueness — refuse generation cheaply before
   spending an Archon run.
4. **Diagnose-revise loop (bounded)**: on failure, feed the failure
   evidence (run status + node outputs + grader detail) back to the
   acquisition model for a REVISION attempt; each revision is metered and
   versioned (v0.1.0 → v0.1.1 …), provenance chain per revision. Budget:
   max 3 revisions per family per teaching episode.
5. **Independent evaluation**: the final accepted candidate is evaluated
   on held-out teaching fixtures (freshly generated, never the admitting
   case, never future scored cases) before promotion.

## v2 targets (architecture-level, per GPT)

- substantially higher acquisition success on the devsuite,
- zero false promotions (every promotion backed by held-out evaluation),
- bounded acquisition cost (≤3 revisions, metered),
- per-revision provenance,
- v1 corpus stays frozen and untouched.
