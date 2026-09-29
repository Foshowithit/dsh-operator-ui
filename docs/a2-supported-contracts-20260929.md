# A2-a — Supported contracts at the Desktop→WM→Archon boundary

Date: 2026-09-29 · lane: `model = z.ai / glm-5.3-flash` (receipts: commands re-runnable on this
machine / the Dell; every claim below traces to a file or command listed in §11).

Purpose (per plan 9839ad5): read the real contracts BEFORE wiring A2-b/c/d, and write down
what is actually supported — including the gap. Rule carried from the plan: **no invented
workflow bindings in the canonical registry.**

---

## 1. RCOS IR v0.1 — `~/rcos/ir-v0.1.md` (frozen, 74 lines)

Neutral plan format between DSH WM (cognitive) and Archon DAGs (procedural). "A plan document
conforming to this schema compiles to exactly one executable DAG via a backend adapter.
Nothing above the IR may assume Archon, Pi, or DSH."

Schema: `objective` (one sentence) · `inputs`/`outputs` (named artifacts, concrete paths or
schemas — never "a report") · `acceptance` (criteria, each mapping to a gate, defined before
the run) · `nodes[]` with `id`, `execution_class: deterministic|model|agent|workflow`, `ref`,
`depends_on[]`, `memory_scope: turn|run|workflow|workflow-role` · `memory` (workdir +
inbox→standing promotion) · `approval_gates[]` (node boundary + approve/reject/rework) ·
`capability_refs[]` (`id/version/role: executed|composed|dependency/invocation_id`).

Tier rule (authoring time): deterministic if possible; bounded single judgment → `model`;
open-ended multi-step tool use → `agent`; composition of certified behavior → `workflow`.

Reuse rule: verified against the trace, never self-certified — "selected ≠ executed ≠
consumed; only the last counts as reuse."

**Status: format only. No compiler exists (§9).**

## 2. Capability adapter — Dell `~/zcode-rcos/lib/adapter.js` (225 lines)

- `type: 'command'` is the only adapter type. `entrypoint` and contract paths are
  **home-relative** (no absolute paths, no `..`); validation is a deterministic JSON-schema
  subset (no external validator dependency).
- Contract shape `rcos-capability-contract/1`: `input` (properties, required) and `output`
  (enum of allowed result documents) with `additionalProperties: false` in both directions.
  Exemplar: `capabilities/reuse-ledger/contract.json` (output enum
  `["reuse-ledger-observation/1"]`, sha256 pattern `^[0-9a-f]{64}$`).
- `validateContractShape` runs at registration; `validateValue` at invoke time. An adapter
  that fails shape validation cannot be registered at all.

## 3. Evidence admission — Dell `~/zcode-rcos/lib/admission.js` (661 lines)

Closed policy vocabulary `{policy_id, policy_version, external_sources:
forbidden|permitted, truth_classes[]}`; verdicts ADMIT / REJECT / UNRESOLVED over 9 sorted
reason codes (POLICY_SATISFIED, EXTERNAL_SOURCE_FORBIDDEN, INTEGRITY_FAILED,
LINEAGE_CYCLE, LINEAGE_SOURCE_MISSING, CONFLICT_UNRESOLVED, TRUTH_CLASS_NOT_PERMITTED,
EXTERNAL_SOURCE_PERMITTED). Transitive lineage walk; write-once admission receipts
(`rcos-evidence-admission/1`, non-recursive mkdir EEXIST = collision signal); sha256
self-integrity with the integrity field stripped; drift re-verification without re-deciding.
Invariant, verbatim: admission "never decides truth, never rewrites evidence, never grants
authority."

## 4. Selection bus — Dell `~/zcode-rcos/lib/selection.js` (530 lines)

Three meanings, never collapsed (from the module itself): **selection says WHICH / eligibility
says MAY / the kernel says CAN EXECUTE SAFELY.**

- Selector statuses: `selected | abstained | ambiguous` (ambiguous is reported, never
  tie-broken). Core-only statuses: `no_candidates | failed`.
- Selector registry (built per call, `buildSelectorRegistry(homeDir)`):
  - `explicit@1` — input is exactly one key `capability_id`; abstains otherwise.
  - `fit@1` (`selectors/fit.js`) — matches ONLY declared facts: `contract.input.properties`,
    `contract.output` enum, `EVAL.json gates[].id`. No similarity scores, no task-text
    parsing, no ranking.
- Candidates = verified `scope=compete` eligibility decisions. Selection artifacts are
  write-once with self-integrity + `candidate_set_sha256`. Selection is **provenance, never
  authority** — the kernel re-checks eligibility at invoke time regardless.

## 5. Invocation kernel — Dell `~/zcode-rcos/lib/invocation.js` (703 lines) + `rcos run`

`invokeCapability(homeDir, capabilityId, opts)`: the **caller names the capability**; the
kernel resolves the declaration, validates input against the contract, runs the entrypoint
**once** under timeout, validates output, writes a write-once invocation artifact. Requires a
**fresh `scope=execute` eligibility decision** — a `compete` decision is refused.

CLI contract (`bin/rcos`, case `run`, lines 377–410):

```
rcos run <capability-id> --input <file.json> [--mode normal|forensic] [--forensic <reason>]
```

- `--mode forensic` **requires** `--forensic <reason>` ("an override nobody can mistake for
  production reuse").
- Exit codes: `0` invoked; `2` unreadable input / bad mode / eligibility engine error /
  contract failure; `4` eligibility says NO (prints `ELIGIBLE: no`, reasons, `decision_id`).
- The verdict is always derived from gate exit codes (0 pass / 3 fail / 4 blocked) —
  "nothing on the command line may assert a verdict."

## 6. Registry state — Dell `~/zcode-rcos/registry/capability-registry.json`

29 promoted capabilities: **16 `script`, 10 `runbook`, 3 `workflow`** (character-forge,
x-media-package, receipt-figure-render). Entry keys: `id, name, kind, version, status,
admitted_after, evals[{task_id, verdict, run_id, provenance}], reuse_count, last_eval,
lineage, adapter{type, entrypoint, timeout_seconds, contract}, retirement{armed_at,
policy_version, decay, neglect}`.

**Load-bearing fact:** the 3 workflow-kind entries carry **no `adapter` block** — e.g.
character-forge (v1.1.0, 2 ship evals) binds only by `lineage` prose ("Dell Archon workflow
character-forge-v1") and eval evidence. They are provenance records, **not kernel-invocable
bindings**: `rcos run character-forge` cannot resolve an entrypoint. Machine-invocable today
= command/script entries only. So "workflow bindings" in the canonical registry are
records of what ran, never instructions for how to run — and A2 must not add invented ones.

## 7. Archon execution substrate (Dell, LIVE)

- `~/.local/bin/archon`; `GET http://127.0.0.1:3090/health` → `{"status":"ok"}` (checked
  2026-09-29). Never restart this service (standing rule).
- CLI surface: `workflow list | run <name> "<task>" | status | runs | get <run-id> | wait |
  resume | cancel | abandon | respond <run-id> <decision> [text] | search | install | test`
  (+ fixtures via `fixtures/*.stubs.yaml`, never contacting a provider).
- DAG YAML shape (448 workflows in `~/.archon/workflows/`; exemplar `chow-eval-gate-v2.yaml`,
  322 lines): top-level `name, version, description, purpose, provider, model,
  routing{category,tags}, nodes[]`. Each node: `id`, `depends_on[]`, `timeout`, and a body of
  **`bash:`** (deterministic) or **`prompt:`** (model call; prompt text may reference
  `$ARGUMENTS`; lane comes from top-level `provider`/`model`).
- Node-body census across the library: 69 workflows with `bash` bodies, 20 with `prompt`,
  1 with a dedicated approval gate — approvals are implemented as **fail-closed bash nodes**
  reading a human-dropped artifact at `~/.archon/approvals/<run_id>/APPROVAL.md`, explicitly
  OUTSIDE the LLM write path, purging any LLM-staged approval first, `exit 2` when absent
  (env-gated `CHOW_AUTO_APPROVE=1` is the only bypass; pattern in
  `chow-agent-architect-v3.yaml`).
- Node env contract: `$ARTIFACTS_DIR` (run-scoped, the only LLM-writable location),
  `$ARGUMENTS` (the task string), `$HOME`.
- **Workflow-to-workflow composition has no native node type**: it is a bash node calling
  `archon workflow run <name> ...` and recording the child run id (proven pattern, e.g. the
  nested-run receipts in the chow-* library).
- **Name resolution is global-only**: `~/.archon/workflows/`. A workflow placed in
  `./workflows/` under the cwd is NOT listed and NOT runnable (probe 2026-09-29:
  `archon workflow run probe-resolve` from its own cwd → not-found + suggestions; probe
  cleaned up). A2-compiled DAGs must be **additively installed** into the global library
  under a distinct `rcos-ir-*` namespace.

## 8. IR → Archon mapping (the contract A2 adds; nothing else fills it)

Compile rules — one IR document → exactly one Archon workflow YAML:

| IR field | Archon target | Notes / limits |
|---|---|---|
| `objective` | `workflow run` task argument | single sentence, passed as `"<task>"` |
| `inputs` | prelude bash node materializing files under `$ARTIFACTS_DIR/inputs/` | paths must be Dell-absolute at compile time |
| `outputs` | nodes write into `$ARTIFACTS_DIR`; final node checks declared paths exist and are non-empty | "a report" is already illegal in IR |
| `acceptance` | one eval bash node per criterion + `EVAL.json` verdict in the house receipt format (`decision/score/reasons/required_fixes`, per `chow-eval-gate-v2` v4) | gates defined before run (IR rule) |
| `nodes[].execution_class: deterministic` | `bash:` node, one command, `timeout` carried | `ref` must be a command resolvable on the Dell |
| `…: model` | `prompt:` node; lane = top-level `provider`/`model` | per-node lane override is NOT supported — distinct lanes ⇒ distinct compiled workflows |
| `…: agent` | **NOT SUPPORTED by compiler v0** — compile error, explicit | no native agent node type; agents are whole workflows in the library |
| `…: workflow` | `bash:` node calling `archon workflow run <ref.name>` (composition-by-CLI, the library's own pattern) | child run id recorded into `$ARTIFACTS_DIR` |
| `depends_on` | node `depends_on` (direct) | |
| `memory_scope` | only `run` is representable (=$ARTIFACTS_DIR); `turn|workflow|workflow-role` ⇒ compile error in v0 | honest limit, stated up front |
| `memory.promotion` | **NOT compiled** — inbox→standing promotion stays a WM/registry-side concern | |
| `approval_gates` | fail-closed bash approval node (human artifact at `~/.archon/approvals/<run_id>/APPROVAL.md`, purge LLM-staged files, `exit 2` when absent) | proven in-library pattern |
| `capability_refs[role: executed]` | prelude bash node running `rcos run <id> --input <json>` per ref; kernel writes the `invocation_id` artifact; compiler records the mapping IR-ref → invocation artifact path | this is what makes "executed" traceable; `rcos run` exit 4 (not eligible) surfaces as a blocked node |
| `capability_refs[role: composed|dependency]` | recorded in the compiled YAML's metadata block only (provenance) | |

Failure semantics (required by A2 gate): missing capability ⇒ `rcos run` exit ≠ 0 ⇒ node
fails ⇒ run status carries it; invalid identity ⇒ kernel refuses; backend down ⇒ health
check preflight node exits non-zero. No silent substitution anywhere.

## 9. The proven gap — no IR→DAG compiler exists

- `grep -rn "execution_class\|ir-v0" ~/zcode-rcos/` → **zero hits** (2026-09-29). No code
  path anywhere in zcode-rcos reads an IR document or emits an Archon workflow.
- Archon is referenced only in `docs/2026-09-14-zcode-rcos-design.md` — design prose, no code.
- The invocation kernel cannot execute `workflow`-kind registry entries (§6).
- `~/rcos/ARCHITECTURE.md`'s honest table already says it: §1 DSH General "not exercised",
  §2 procedural compiler "not exercised", §3 Archon DAGs "not exercised". **A2-c exists to
  flip exactly these three rows** with one captured run.

Therefore A2 builds the missing backend adapter at the zcode-rcos boundary — additive
(`lib/ir-compile.js` + a `rcos ir-compile` subcommand), no changes to existing lib files.

## 10. Non-goals / no-invention rules for A2-b/c/d

1. The canonical registry (`~/zcode-rcos/registry/capability-registry.json`) is **read-only**
   for A2. Testbed eligibility/invocation artifacts may live in a scratch home; nothing is
   promoted without Adam.
2. No new workflow bindings are authored into the canonical registry; compiled DAGs install
   only into `~/.archon/workflows/rcos-ir-*.yaml` (additive, namespaced, removable).
3. `agent`-class and non-`run` memory scopes are explicit compile errors, not silent
   downgrades.
4. Routing (A2-b) is a typed record interpreted by the model, validated by code AFTER the
   decision — no token matcher selects capabilities (plan requirement, mirrors §4's
   declared-facts-only discipline).
5. Missing capability in a request ⇒ explicit blocked/build outcome (A2-c), never a
   lookalike substitution.

## 11. Receipts

| # | fact | source |
|---|---|---|
| 1 | IR schema + tier + reuse rules | `~/rcos/ir-v0.1.md` (read in full) |
| 2 | honest exercised/not-exercised baseline | `~/rcos/ARCHITECTURE.md` §"What has actually executed" |
| 3 | adapter contract | Dell `~/zcode-rcos/lib/adapter.js` (225 lines, read) |
| 4 | admission vocabulary | Dell `~/zcode-rcos/lib/admission.js` (661 lines, read) |
| 5 | selection semantics | Dell `~/zcode-rcos/lib/selection.js` (530) + `lib/selectors/fit.js` |
| 6 | kernel + run CLI + exit codes | Dell `~/zcode-rcos/lib/invocation.js` (703), `bin/rcos` case `run` :377-410 |
| 7 | registry 29 = 16/10/3, no adapter on workflow-kind | `python3` dump of `capability-registry.json` (character-forge entry shown in full) |
| 8 | Archon live | `curl 127.0.0.1:3090/health` → ok |
| 9 | DAG shape + node census (69 bash / 20 prompt / 1 approval) | `~/.archon/workflows/*.yaml` grep census + `chow-eval-gate-v2.yaml` read |
| 10 | approval = fail-closed human artifact, exit 2 | `chow-agent-architect-v3.yaml` HITL node read |
| 11 | global-only name resolution | cwd probe `probe-resolve` not listed / not runnable (probe removed) |
| 12 | no compiler exists | zero-hit grep for `execution_class\|ir-v0` under `~/zcode-rcos` |
