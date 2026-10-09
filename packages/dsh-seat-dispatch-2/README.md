# dsh-seat-dispatch-2

An RC.2-compatible routing recorder and `dispatch_seat` tool for the
General/Idea seat. It records the model's handling intent for a session turn;
only a persisted `procedural_handoff` decision can create a fresh-root Workflow
Manager seat. The dispatcher sends one bounded work envelope, accepts one
validated receipt, and audits each dispatch or refusal.

## Runtime target and port

This package targets the installed DSH runtime `0.2.0-rc.2`. Its `dsh-tools`,
`dsh-llm`, and `dsh-session` peers are pinned to that version. The
`runtime-compatibility` test calls RC.2's actual
`evaluatePluginCompatibility` function.

The source port was first adapted to RC.1's session changes, then verified
against the RC.2 runtime modules:

- Transcript reads use `session.snapshotEvents()` instead of the removed
  `session.events` property.
- A plugin-authored turn uses source kind `plugin:seat-dispatch`, the session
  format accepted by RC.2.

The `createUserMessage`, `SessionId`, `defineTool`, and async
`agentPresets.mount(ctx, id)` call shapes remain compatible. The existing
`agents.create({ sessionId, meta, agentOptions, setup })` remains covered by the
source suite. The declarative `@deepseek-ai/dsh-agent-preset` composition used
by the bundle passes RC.2 package validation.

## Composition boundary

The package is also an additive DSH bundle: its `cordis.patch.yml` declares the
`general-idea` and `workflow-manager` presets. After installing the bundle,
select **General / Idea** as the new-task default in **Settings > Agent presets**.
The built-in preset registry remains owned by `dsh-web-app`, so this preference
stays editable and the bundle can be removed cleanly. General contains
read/search, web search, clarification, todo, compaction, one route-recording
tool, and exactly one execution tool: `dispatch_seat`. It does not compose
shell, write, goal, workflow, or subagent tools. The dispatcher row uses
`callerPreset: general-idea` and `seats: [workflow-manager]`; the Workflow
Manager preset cannot dispatch another seat.

The per-seat `tool-restriction` plugin reads RC.1's host-global schemas and
denies every global tool outside the configured allowlist. It rejects an
allowlist name absent from that registry, and leaves the preset's own scoped
tools visible. General's wire schemas are `ask_user_question`,
`dispatch_seat`, `record_routing_decision`, `glob`, `grep`, `skill`,
`todo_write`, and `web_search`. The current Desktop composition presents
Workflow Manager's scoped RCOS/Archon tools and receipt tool as native calls.
It exposes no shell or file-writing tool. The earlier RC.1 PTC surface probe
below remains historical evidence, not the current Desktop tool presentation.

Workflow Manager uses scoped RCOS/Archon tools for bounded execution. Its
persona requires RCOS capability discovery/admission
and independent evaluation before a ship receipt. The dispatch audit directory
resolves under the runtime's `DSH_HOME`, so isolated profiles keep their
evidence isolated.
Active Archon runs return `pending` with unfinished checks until the terminal
status and evaluation are available. A pending receipt preserves the exact run
id, observed status, and next poll action without claiming failure or success.
The host records successful compile/run identities from canonical `tools/result`
values in the existing `seat-dispatch.jsonl` audit. Once that seat closes,
General can dispatch a fresh Workflow Manager to call `archon_dispatch_status`
with the saved dispatch id. The trusted parent chat must match the original
caller; the host supplies the exact original run, conversation, workflow, and
child identities. This operation only reads status and cannot launch a second
run. A receipt must retain a run identity that the seat launched or successfully
read, including when the verdict is blocked; an omitted or substituted run id
is refused without consuming the receipt slot. The binding survives app
restarts, and repeated follow-ups retain the
original binding. Both the dispatcher and adapter must use the same `auditDir`
when overriding its default. Older audit rows without a captured binding require
operator inspection of the exact Dell run; they cannot be reconstructed from
chat text. `archon_run_status` stays limited to the creating seat.

Invoice reconciliation status exposes a verified domain verdict, engine exit,
and bounded numeric counts from the known report schema. The exact output bytes
must match the canonical invocation fingerprint after invocation and eligibility
verification. Invoice IDs, amounts, source paths, and refusal reasons are not
projected. Workflow SHIP is retained as raw evidence; effective acceptance follows
invoice FIX/BLOCKED, and an unavailable or invalid invoice outcome blocks acceptance.

`wishing-film-run` v1.0.0 status also projects its verified film result: PASS,
FAIL and VACUOUS map to SHIP, FIX and BLOCKED. Adapter completion alone cannot
approve the film. The projection requires the exact canonical invocation,
eligibility verification and hashed output bytes, consistent renderer exit and
failed checks, and the frozen 21-check/grid/timeline contract for PASS or FAIL.
Unknown versions and inconsistent outputs block acceptance. The status includes
only verdict, counts, failed check IDs and timeline gate exit; input paths,
measurements and process output remain private. This capability renders the
existing wishing-2024 project; it does not create arbitrary films.

Visual inspection status now interprets `filmstrip-verify` v1.0.0,
`video-forensics-receipt` v0.1.0 and `webgl-film-capture` v1.0.0 using their
versioned observation contracts. Verified measured defects produce FIX;
unavailable, incomplete, contradictory or unsupported evidence blocks
acceptance. All probes must pass. A successful inspector process or wrapper
EVAL cannot approve a defective clip. Forensics checks are recalculated against
the selected reference register; null measurements cannot pass. Capture requires
a complete frame manifest and nonempty comparison from a second launch.
Status exposes only measurement scope, probe counts and fixed check IDs, after
canonical invocation/eligibility verification and output fingerprint checking.
These checks establish those measurement results; artistic quality and distinct
motion still require visual review. Up to eight invocation receipts are checked;
overflow blocks acceptance instead of silently dropping later evidence.

`bounded-research` v0.1.1 provides an executable named-URL cited-fetch prelude.
Status verifies the canonical invocation and eligibility seals, exact output
fingerprint and bounded observation schema. One or more valid passages produce
a scoped SHIP; zero passages produce BLOCKED even with wrapper SHIP. Projection
exposes counts and known refusal reasons, excluding query, URLs and excerpts.
Actual Desktop IANA fetch and intentional off-allowlist refusal passed their
respective SHIP/BLOCKED acceptance cases with no receipt warnings on 2026-10-03.

The reviewed Desktop snapshot of `chow-research-search-v1` runs native Muse
synthesis after real search and ranking. The writer receives only usable ranked
evidence, cites those exact URLs, and runs the read-only `--check-only` validator
before returning its brief, with at most two corrections. The final deterministic
gate remains strict. On 2026-10-03 a fresh actual Desktop job returned SHIP for
parent `6d62c93bd6009bca89aef73cba9bea6e` and research child
`4bb7b929bbf8e2a8ac81e3f23a6afce0`; a status-only recheck after a confirmed
restart preserved both identities and accepted one receipt with zero warnings.
Verified child evaluations now include the canonical `artifact_dir` and bounded
`artifact_names`, so Desktop can identify the child brief, search results and
EVAL without guessing parent paths. File bodies remain outside this projection.
The brief's evidence scope is search snippets; citation membership and scope
checks do not certify the truth of every claim. Earlier blocked history is retained.

General's persona asks the model to record one typed intent for each request:
`conversational`, `read_only_inquiry`, `clarification`, or
`procedural_handoff`. Each record includes a unique decision id, the caller's
session id and active turn, and the model's reason; append-only records live at
`$DSH_HOME/runs/seat-dispatch/routing-decisions.jsonl`. Recording intent does
not grant authority or choose a capability. A seat can start only when
`dispatch_seat` receives a persisted `procedural_handoff` id from the same
active turn. The dispatch audit links that decision id to its dispatch id.
Preset, lineage, and seat allowlist checks still decide whether the handoff is
authorized. A real installed Desktop folder request followed this route and
returned a verified Workflow Manager receipt; see the bounded acceptance below.

Both seats compose automatic compaction with a 10% target threshold for each
routed model, capped by the budget left after output reservation and 8,192
tokens of headroom. Retention scales at 4% of the message budget. A
1,000,000-token context therefore triggers at 100,000 tokens; smaller windows
scale with their available budget and retain a smaller recent tail. Summary
output is capped at 131,072 tokens. Each adapter's routed output reservation
plus headroom must fit its context window.

The dispatcher checks the caller's live preset and delegation lineage, admits
only configured seat ids, mounts the target preset into the new agent scope,
and accepts success only from a validated receipt submitted by that agent.
Receipt schema, one-shot behavior, and audit fields are kept from the prior
dispatcher contract.

## Verification status

The package suite uses the actual DSH 0.2.0-rc.2 npm runtime modules. Run it
from this package with the runtime's module directory available:

```sh
DSH_RUNTIME_NODE_MODULES=/path/to/dsh/node_modules npm test
```

The source suite covers the RC.2 schemas, peer-compatibility checker, seat
boundaries, and compaction policy in the published engine: both seats register
the automatic pre-step hook, trigger at 100,000 tokens for a 1M window, and
scale to a 12,800-token threshold with a proportional retained tail for a
128k window under an 8,192-token output reservation. The earlier isolated seat-surface
probe records General's exact tool set and refusal of direct mutation,
delegation, goal, and workflow calls in
[`docs/evidence/a1-rc1-tool-composition.json`](../../docs/evidence/a1-rc1-tool-composition.json).
The adapter composition probe records the exact Workflow Manager wire,
registry, and PTC SDK schemas in
[`docs/evidence/a1-rcos-adapter-composition.json`](../../docs/evidence/a1-rcos-adapter-composition.json).
The follow-up routing probe records the General route-recorder schema alongside
both seat surfaces in
[`docs/evidence/a1-rcos-routing-composition.json`](../../docs/evidence/a1-rcos-routing-composition.json).
The probes made no model API calls. The follow-up probe directly submitted one
forged route id to `dispatch_seat`; RC.1 returned `authority-route` before
creating a seat, and no RCOS/Archon adapter body ran. These isolated probes prove
composition and the direct handoff refusal. A subsequent RC.2 installed Desktop
acceptance dispatched an ordinary folder request, completed an RCOS invocation
and a QA child on the Dell, and returned an accepted ship receipt. Independent
checks verified invocation integrity, eligibility, the actual isolated child
directory, and parent and child EVAL decisions. This proves that bounded
folder/QA journey; it does not certify every catalog workflow or a fresh public
installation.

Run the package suite with the installed runtime module directory to include
the environment-dependent compatibility and compaction checks.

### Live Archon identity and recovery

Archon may return either a 32-character hexadecimal run id or a dashed UUID.
Its `conversation_id` is an internal database identity; the exact DSH seat id
appears as `worker_platform_id` in CLI history. The adapter resolves this mapping
on submission and retains the confirmed internal identity, workflow and creating
seat for exact-id status reads. A repeated run-tool call for the same compiled
name only searches for the existing run; it never submits again. Use a newly
compiled unique name for a distinct job. If lookup cannot resolve a unique run,
stop and reconcile the evidence before creating another job.

Status includes up to two verified RCOS invocation summaries from that run.
Each must equal the canonical RCOS manifest and pass invocation verification;
eligibility verification is reported separately. Input/output bodies are omitted;
only fingerprints and byte counts are exposed. The known tree-digest report has
a bounded projection of counts, digests and refusal probes. Artifacts outside the
Archon workspace root or escaping their run directory are not read.

The host observes successful native `tools/result` values within the dispatched
seat. Receipt admission requires an observed run identity and checks
`archon_status` and verdict against the latest canonical status result. Terminal
acceptance uses `effective_decision`; a raw wrapper SHIP cannot override a domain
FIX or BLOCKED. An active run requires a pending receipt. Launch acceptance
alone permits an observed active status, and a terminal receipt requires an
exact run status read. Unknown terminal acceptance is blocked. A contradictory
receipt is refused without consuming its one-shot slot, so the seat can correct
it. These observations are ephemeral; recovery still uses the existing dispatch
audit and adds no new store. Summaries and evidence text remain seat reports.


### Scoped Desktop execution profile

The installed Desktop preset sets the host-owned `desktopRunProfile` option. The remote adapter uses the fixed Dell source project at `~/.archon/rcos-desktop/source`, with approved workflow snapshots under `.archon/workflows`, and its protected run config. A trusted `profile-manifest.json` pins the configuration and source hashes; a missing or altered profile refuses execution. Before Desktop compilation, the adapter checks the independent manifest verifier. After compilation, it copies the generated wrapper into the snapshot, admits that one exact compiler-produced file to the Desktop manifest, and verifies the snapshot again. Failed admission restores both manifests and removes the copied snapshot wrapper; a wrapper already present during installation is preserved. Model arguments cannot choose a provider, credentials, source directory, or config path. The host sets `PI_CODING_AGENT_DIR` to the isolated provider profile. Workflow snapshots use the literal OpenCode Go Muse Spark 1.3 Contributor model and Xhigh effort. After the live compile-only admission smoke, the reconciled snapshot reports 47 current files, no drift, and no unmanifested wrappers; the independent verifier passes 178 claims.

Child execution is accepted only with a compiler receipt and independently checked run identity, working directory, completion, canonical bounded EVAL, and ship verdict. Parent completion alone is insufficient. The RCOS parent prelude executes each admitted capability before its child workflows. For verification of that result, use `chow-qa-verify-v1` with a non-empty `ref.inputs.task` and declare the exact `artifacts/rcos-invocation-<executed-capability-id>.json` output. The compiler injects absolute `claim_paths` and the parent's start clock into the child task at execution. Admission also accepts explicit absolute file claims; arbitrary future filenames, other capability ids, and dependency-only references do not satisfy generated-claim admission. QA checks file existence and freshness; the parent separately verifies RCOS integrity, eligibility, and input/output contracts. `chow-build-standard` performs project build work within an isolated child directory, whose rules prohibit reading external parent receipts.

The installed profile and receipt checks passed the folder/QA acceptance.
Each catalog entry publishes host-reviewed evaluation and execution contracts.
Planning, test, review and verification routes with incompatible result formats
are refused before compilation. Fix-loop and UI-build routes are refused because
their approval nodes make detached execution interactive; standalone eval-gate
is refused because its direct provider helper bypasses the Desktop model profile.
The build route uses the dedicated unattended Desktop source. The real Desktop
acceptance completed with parent and child SHIP, verified RCOS integrity, five
Muse Xhigh session logs, and four independently rerun passing pytest checks.

The prepared catalog also admits `chow-research-search-v1`. Its task is a search
query with optional `--max N` or `--full`. The initial Dell root diagnostic used
CC2 Muse and did not prove Desktop execution. On 2026-10-03 a refresh regression
was reproduced: a generic workflow model pin restored a legacy Bash helper
that ignored the Muse profile. The scoped `pin-opencode-go-muse-research-v1`
rule now admits only the exact reviewed source generation and protected template.
Its native synthesis command uses OpenCode Go Muse 1.3 Contributor Xhigh;
changed global sources or templates require review instead of silent replacement.
Four regression cases passed, including independent verifier rejection of
template tampering and refusal of an unreviewed original generation. Sixteen
brief-gate cases cover actual-result admission, required sections, citation
membership and scope disclosure. The evidence gate checks those contracts,
not semantic fact accuracy.
See the private repair evidence for exact run identities and installed hashes.
