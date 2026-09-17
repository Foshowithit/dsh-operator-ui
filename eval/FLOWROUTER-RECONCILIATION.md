# RCOS ↔ FlowRouter Reconciliation (Portability P0 — spec pass, no code)

GPT directive (checkpoint 384b303): map the ACTUAL production RCOS objects
against frozen FlowRouter Capability Manifest v0.1, classify every field,
freeze the architectural contract, then implement. **The manifest is not
changed and no networking is built until this mapping is adjudicated.**

Production objects mapped (all real, at `384b303`):
- **CandidateCapability** — `lib/acquire.js` (the object the acquisition
  produces; proven live: `csv-running-total`)
- **Registry entry** — the promoted capability (registry, `rcos-public-v1`)
- **Acquisition envelope** — the durable task in `tasks.json` (attempts
  trail, evaluations, provenance)
- **Capability history** — `lib/history.js` read-model (operating history,
  named decay, version lineage)

## 1. Field-by-field mapping

Format: `RCOS field → FlowRouter v0.1 field` · classification.
EXACT = semantic identity · ADAPTER = mechanically different shape, lossless
translation · MANIFEST-GAP = RCOS has it, v0.1 has no home (optional field
or v0.2 addition needed) · RCOS-GAP = manifest expects it, production RCOS
lacks or is weaker · MUST-NOT-EXPORT = never leaves the home instance.

| RCOS (production) | FlowRouter v0.1 | Class | Notes |
|---|---|---|---|
| `id` (capabilityId) | `identity.id` | **ADAPTER** | v0.1 requires `publisher/name`; local ids are bare. Export adapter prefixes the publishing home (e.g. `mac-a/csv-running-total`); import strips into `source.id` and keeps the local bare id. |
| `version` (0.1.0) | `identity.version` | **EXACT** | semver in both. |
| `description` (from candidate provides) | `identity.title` + `identity.description` | **ADAPTER** | one production string fills both (title = first clause). |
| `kind` ('workflow') | `identity.kind` | **EXACT** | workflow. |
| — | `identity.publisher` | **RCOS-GAP** | production has no publisher identity yet; the EXPORT ADAPTER supplies it from config (`export.publisher`), never invented internally. |
| `tags` (routingVocabulary) | `routing.domains` + `routing.task_signatures` | **ADAPTER** | production tags are flat words; adapter splits into domains vs signatures only if separable, else all land in `task_signatures` and a `domains` subset is derived conservatively. **No semantic enrichment** — what RCOS proved is what ships. |
| `workflow` (yaml name) | `implementation.entrypoint` / `implementation.workflow.ref` | **ADAPTER** | the YAML itself is packaged as `workflows/<name>.yaml`; entrypoint points at it. |
| (workflow YAML bytes) | `implementation.bundle` | **ADAPTER** | sha256 over the canonical package (see §3); import recomputes. |
| `verification.expectOutput` + `terminalStatus` | `contract.outputs` (partial) + `evidence` | **ADAPTER** | the declared expectation is part of the output contract; exported as an output-contract constraint + an evidence note; it is ALSO the local re-verification input. |
| `provides` (one-sentence contract) | `contract.constraints` / description | **ADAPTER** | no exact slot in v0.1; carried in `identity.description` and mirrored as a constraint string. Flagged as **MANIFEST-GAP** for v0.2 (a first-class `contract.statement`). |
| `requires` (`filesystem:read`, `shell:execute`) | `contract.side_effects` + v0.2 permissions field | **MANIFEST-GAP** | v0.1 has no explicit permission array (`side_effects` is coarse). Export maps conservatively: filesystem→`"write"`/`"read"`, network always `"none"` (acquisition forbids network); the exact scope list rides in an additive field `x-rcos.required_authority` (v0.1 allows unknown fields) pending v0.2. |
| `requiresUnknown` (must be empty) | — | **MUST-NOT-EXPORT** (and must be empty at export; otherwise export refuses) | fail-closed authority from M2. |
| `evidence.runId` + `objectiveEval` | `evidence.verdicts[]` | **ADAPTER** | one local verdict entry: `{task_id: source task, verdict: 'ship' (objective evaluation passed), run_id, at}`. |
| `provenance.sourceTaskId` | `evidence.sources` (additive `x-rcos`) | **ADAPTER** | durable pointer, meaningless on another machine but REQUIRED for lineage honesty: exported as provenance, never as local fact. |
| `provenance.teachingTaskId` (acq_…) | `x-rcos.provenance.acquisition_task` | **ADAPTER** | same: provenance only. |
| `provenance.builtBy` (engine id) | `x-rcos.provenance.built_by` | **ADAPTER** | engine identity travels as provenance. |
| `provenance.promotedBy/promotedAt` | `lifecycle` (source) + `stats.updated` | **ADAPTER** | **source-side facts only** — see §2 constitutional rule. |
| `status: 'promoted'` | `lifecycle.status` | **ADAPTER + RULE** | exported as `source.lifecycle`; on import it is provenance, NEVER the local status (local starts `candidate`-equivalent STAGED; `lifecycle.admitted_after` on B is populated only by B's local admissions). |
| `admitted_after`, `evals`, `reuse_count`, `last_eval` | `stats.*` + `evidence.verdicts` | **ADAPTER** | measured locally; export includes them as reported stats without attestation claims the exporter cannot back (v0.1 rule 3: evidence recorded, not self-declared; the exporter stamps `attestation: 'reported'`). |
| history read-model (objectivesSatisfied / blocksAfterExecution / decay) | `evidence.verdicts` + `stats.reliability` | **ADAPTER** | derived read-model → append-only verdict log and reported stats; nothing invented. |
| version lineage (history) | `composed_from` / successor notes | **MANIFEST-GAP** | v0.1 supports `composed_from` but not "this version supersedes that version"; export puts predecessors in `composed_from` + a `x-rcos.lineage` note; flagged for v0.2 `lineage` field. |
| objective-evaluation semantics (deterministic graders, dual sacred terminals, staged gates) | — (only `evidence.eval_suite` ref) | **MANIFEST-GAP (v0.2)** | the portability payload for v0.2: what evidence STANDARD was met. For P0 the receipt rides in `x-rcos.evidence_standard`. |
| — credentials (apiKeyEnv NAMES, env values) | — | **MUST-NOT-EXPORT** | never read, never packaged; export refuses if a candidate body references credential stores (static validator already blocks this). |
| — absolute paths (workflowsDir, workspaceDir, registry paths, DSH_HOME, task-store location) | — | **MUST-NOT-EXPORT** | package format uses relative URIs only; export adapter strips any absolute path from the packaged docs and refuses on detection. |
| — internal task-store records (tasks.json envelopes beyond the provenance refs above) | — | **MUST-NOT-EXPORT** | only explicit provenance pointers leave. |
| — machine state (hostnames, PIDs, run-URLs of the local Archon, local timestamps inside identity) | — | **MUST-NOT-EXPORT** | canonical package identity is timestamp-free (deterministic hash requirement). |

## 2. Frozen architectural contract (before code)

```
RCOS internal capability
        │
        ▼ export adapter
FlowRouter Capability Package  ── transport/storage only ──
        │
        ▼ import adapter
STAGED / UNTRUSTED
  ├── schema          (validates against manifest schema)
  ├── integrity       (content hash over canonical package)
  ├── compatibility   (runtime/tools/models available HERE?)
  ├── dependencies    (declared prerequisites satisfiable HERE?)
  ├── authority       (declared scopes decidable by LOCAL policy?)
  └── LOCAL REVERIFICATION (execute + local objective evaluation on a fresh local fixture)
        │
   ┌────┴─────┐
   ▼          ▼
VERIFIED    REFUSED
   │
   ▼ operator admission
ELIGIBLE
   │
   ▼ normal router
```

**Constitutional rule (verbatim): FlowRouter can transport evidence of
trust. It cannot transport trust itself.**

State model — source facts are provenance, never local state:

```
source.lifecycle  = PROMOTED      (provenance)
source.attestation= …             (provenance)
source.evidence   = …             (provenance)

local.import      = STAGED        (starts here, always)
local.verification= UNVERIFIED    (only LOCAL reverification changes it)
local.routing     = INELIGIBLE    (only operator admission changes it)
```

Package integrity (P0): canonical JSON of the package (sorted keys, no
timestamps/absolute paths in the identity-bearing parts) → `bundle.sha256`.
Deterministic: same home state ⇒ same hash.

## 3. Acceptance receipts (the proof plan, per the ruling)

`csv-running-total` from the live receipt (its acquisition provenance is
real; no new acquisition needed — this phase tests portability, not
acquisition).

**Positive round trip** — two clean RCOS homes A (the dev lane's home) and
B (a fresh home with its own registry + no knowledge of A):
A: export the already-promoted capability → canonical package (manifest +
implementation + evidence/provenance + package hash).
B: import → STAGED/INELIGIBLE → integrity PASS → compatibility PASS →
inspect source evidence → LOCAL REVERIFICATION against a fresh local
fixture (execute + local objective evaluation) → operator admission →
ELIGIBLE → normal routing → authority gate if required → execute →
objective evaluator → SHIP. Provenance chain traces: execution →
local-verify → package → source evals → source acquisition task.

**Negative A (tamper)**: alter one byte of the packaged implementation
after packaging → import INTEGRITY FAIL → never executed → INELIGIBLE.

**Negative B (authentic but unusable here)**: intact untampered package
whose declared requirement is unsatisfied locally (e.g. an authority scope
the local policy cannot decide, or a runtime/tool absent on B) → INTEGRITY
PASS → COMPATIBILITY/VERIFY FAIL → never routable. Proves authentic ≠
usable.

**Re-export lineage**: export from B again → source acquisition/promotion
provenance still points at A; B's import/verification/admission provenance
is APPENDED (new verdict entries + `x-rcos` import chain), never rewritten
into local authorship.

## 4. Explicitly out of scope for P0 (per the ruling)

Manifest v0.1 changes; networking (publish/index/discover/fetch);
marketplaces, reputation algorithms, global scores, generalized
cross-system adapters. Those follow only after this mapping is adjudicated
and the receipts above pass.

---

# AMENDMENTS (GPT adjudication of a0bcd3f) — appended, original record above unchanged

Ruling: **ACCEPTED WITH 3 PRE-IMPLEMENTATION AMENDMENTS.** a0bcd3f freezes
as the reconciliation baseline; implementation authorized; Manifest v0.1
untouched; still no networking.

## Amendment 1 — package digest definition (fix, f-d)

The submitted "canonical JSON → bundle.sha256" was self-referential (the
digest field lives inside the hashed content). Frozen rule (OCI-like):

```
content digest = SHA256( canonical ordered list of:
    relative-path · byte-length · SHA256(file-bytes) )
EXCEPT capability.json is canonicalized with implementation.bundle.digest
OMITTED when computing the package digest; the digest is inserted after.
```

Distinguish two hashes:
- **implementation digest** = SHA256(workflow YAML bytes) → `implementation.bundle.digest`
- **package digest** = SHA256(canonical package contents per the rule) → `implementation.bundle.package_digest`

Import repeats the identical procedure. Negative A (tamper) must
demonstrate BOTH mismatches before anything executes.

## Amendment 2 — identity namespacing + collision

`identity.id` is globally namespaced (`publisher/name`). A bare local id is
an ALIAS, never an identity:

```
source_identity: { id: "<publisher>/<name>", version }
local:           { alias: "<bare-id>" }
```

If B already owns the alias: import MUST NOT overwrite or merge — it
refuses `LOCAL_ID_COLLISION` or allocates an explicit new alias.
Publisher names are supplied by export configuration (adapter concern).

## Amendment 3 — verification truth split (frozen)

```
PACKAGE INTEGRITY → EXECUTABLE HERE → SOURCE EVIDENCE REPRODUCIBLE (optional)
  → LOCAL CAPABILITY VERIFICATION → OPERATOR ADMISSION
```

B's verification fixture and expected outcome MUST be B-local — never
contained in or derived from the imported package's answer material — and
the fixture is FROZEN/HASHED **before** B executes the imported
implementation. The claim established is exactly: *B independently
observed that the imported implementation satisfies its declared contract
locally.*

**State split (frozen):** source truth (PROMOTED, evaluations, history)
crosses only as `provenance.source.*`; receiver truth starts `STAGED /
UNVERIFIED / INELIGIBLE` and only local verification then operator
admission advance it. No imported lifecycle state crosses the line.

## Acceptance matrix (sharpened + collision negative added)

1. **Positive**: A promoted → export → clean B STAGED/INELIGIBLE →
   integrity → compatibility → independent B-local verification → operator
   admission → normal route → authority → execution → objective SHIP →
   re-export preserving A provenance + appending B provenance.
2. **Tamper negative**: one implementation byte changed → both digest
   mismatches → never executed.
3. **Compatibility negative**: authentic/integrity-green package whose
   local requirement is unavailable → compatibility failure → INELIGIBLE,
   never executed.
4. **Collision negative**: B already owns the alias → refusal (or explicit
   new alias); never overwrite existing intelligence.
