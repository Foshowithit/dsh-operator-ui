# Open Canvas Desktop: public product roadmap

2026-09-28 · Proposed release scope · Development home: this repository.

This is the product specification for the [agent execution plan](superpowers/plans/2026-09-28-public-desktop-release.md).
It supersedes older delivery order where that conflicts with centering the
product on DSH Desktop. Existing runtime, authority and sealed protocol
contracts still apply. A plan is not a release or a claim that these features work.

## The promise

**An open agent workspace where people turn goals into useful artifacts,
watch the work, inspect the evidence, and add capabilities that improve with use.**

The ambition behind “AGI in a repo” belongs in the long-term research direction.
The public product promise should be demonstrated tasks and measured reliability.
Do not market a catalog count, an agent's self-report, or a passing unit suite as
general intelligence. A stronger launch is a stranger completing useful work.

Working product title: **Open Canvas Desktop**, built on DeepSeek Harness.
Keep `dsh-operator-ui` as the package identity until the compatibility and release
work establishes a migration path. Public naming and attribution must make the
upstream relationship clear; do not imply this is an official upstream product.

## One source home, distinct runtime owners

Develop the product in this repository. Keep DSH as a pinned upstream dependency.
Do not fork its Desktop shell or merge every historical repository into this one.

| Responsibility | Authority / source home |
| --- | --- |
| Sessions, model access, tool calls, native chat | DSH; consume its supported extension contracts |
| Workflow dispatch and execution | Existing Archon integration; one execution authority |
| Capability admission and canonical records | The configured canonical registry and current promotion path |
| Operator UX, selected execution views, capability catalog UX | This repo, initially existing `lib/` modules |
| Canvas schema, renderer integration, portable starter assets | Reviewed source maintained here after explicit import |
| Durable task history and verification | Existing task/receipt stores; no parallel task database |

Use selective imports with provenance, licensing and tests. Keep protocol research,
private deployment data and unrelated runtime history out of the public launch
surface. Existing tracked research can remain in the development repository until
the publication audit determines what can travel into the public artifact/history.
Do not rewrite history or delete evidence as part of ordinary development.

## What the user sees

1. **Start:** open a workspace, see prerequisites, try a clearly labeled sample,
   or connect an existing supported execution environment. Provider secrets stay
   with the runtime's credential mechanism.
2. **Choose:** describe a goal or select a capability. See required access, missing
   dependencies and expected outputs before execution. The model can propose a
   plan; the existing authority path decides what may execute.
3. **Work:** chat remains usable. A selected task can open into a canvas with
   execution details, files and artifacts together. The user controls focus,
   layout and approvals. Avoid adding another wall of administrative tabs.
4. **Inspect:** a tool call expands into structured detail. Observations have a
   source, identity and time. Missing data says unknown; snapshots say snapshot.
   Seat-reported success stays distinguishable from independent verification.
5. **Reuse:** rerun a proven capability with new inputs. Compare its evidence and
   failures. Propose improvements without silently promoting them.

## The first public alpha

Target people comfortable installing a developer tool: builders, researchers and
technical creators. A later release can optimize consumer onboarding.

The first complete milestone is **choose a capability → authorize a task → inspect
it on Canvas → open an artifact → inspect evidence → rerun with changed inputs**.

Release target: macOS first for Desktop, with a separately verified Linux web/plugin
path. Node >=22 is the current source requirement. Do not claim native Windows
support. An exact DSH Desktop/host/tools combination must be established by the
compatibility packet; the current source pin `0.1.0-rc.6` is not proof for the
Desktop release the user currently runs.

Ship three demonstrations, each executable from published instructions:

| Demo | User-visible result | Required proof |
| --- | --- | --- |
| First-run verification | Understand prerequisites and verification level | Packaged seed inputs resolve; a real configured seed run earns its rung; missing execution stays unverified |
| Inspect a local artifact | Choose an audio/video file, get codec/duration/sound observations and evidence on Canvas | First candidate: `audio-offline-verify`; supported workflow binding, explicit prerequisites, negative and missing-tool cases |
| Improve a small code task | Produce a bounded patch with test output, then independently review it | New portable pack using existing runtime tools; exact workspace scope and no automatic publish/merge |

A static sample of any demo is labeled **sample data**. The zero-credential seed
is a verification fixture, not the headline capability. “Zero credential” does
not mean zero prerequisites: the artifact checker still needs its declared tools
and a supported execution environment.

### Capability library: useful breadth with honest states

Begin with the three demos, then grow toward a target of **8–12 independently
proven capabilities** across code, research, data and creative inspection.
The count is a direction, not the alpha release gate.

| Candidate / pack | Current source evidence | Planned role |
| --- | --- | --- |
| `audio-offline-verify` | Adapter, input/output contract and historical eval records exist; registry entry is candidate with no workflow | First bounded artifact capability after binding is proven |
| `filmstrip-verify` | Adapter and recorded eval evidence exist; no product workflow binding | Optional creative inspection pack |
| `video-forensics-receipt` | Measurer and recorded eval evidence exist; no product workflow binding | Optional creative inspection pack |
| `qr-camo-embed` | Adapter and recorded eval evidence exist; no product workflow binding | Optional artifact creation pack with explicit input limits |
| Code inspect / patch / test / independent review | DSH tools and integration mechanisms exist; a portable product pack is not certified here | First general work pack |
| Research collect / cite / synthesize | Proposed pack, no public certification claimed | Source-linked brief with bounded network access |
| Data inspect / transform / report | Proposed pack, no public certification claimed | Small local CSV/JSON outputs with deterministic checks |

Every card separates **present**, **installed**, **verified**, **executable** and
**eligible now**. Unknown is a value, not an implicit yes. A candidate may be
visible and still not runnable. The card names concrete reasons and the next
human action. Local files and historical evals cannot manufacture a canonical
registry entry or an execution binding.

Each shipped capability includes a versioned input/output contract, exact runtime
binding, declared dependencies and scopes, examples, independent evals, negative
cases, provenance, license information and resource limits. Model/provider
requirements are explicit. Do not promote on an agent's self-score.

### Canvas: execution becomes inspectable

First ship manual opening/closing and arrangement of a selected execution view,
artifact and evidence. Add pan/zoom, connections and richer arrangement after
those sources are correct. Layout starts ephemeral; durable layout requires a
separate storage contract and is not permission to add a store now.

Preserve the twelve-primitive PanelDoc vocabulary. Binding syntax is not
authorization. Use a host-owned, exact source identity; DSH session/call IDs and
Archon run IDs remain different namespaces. WM settlement can expose its exact
reported run/seat IDs; it cannot expose an invented live worker stream. A
`job_list` result is a call snapshot, not a run.

Keep trusted approval controls and verification badges outside agent-authored
panels. Text authored by an agent can never become an authority label. Source
bindings clear when context changes or a component unmounts. Preserve native
file/inspect callbacks and stock DSH tabs. Missing source data must never create
progress, percentages, animation implying work, or success.

## Delivery stages and release gates

| Stage | Deliverable | Exit evidence |
| --- | --- | --- |
| 0. Baseline | Central repo direction and truthful packaged readiness | Code checkpoint `4a4cb1a`; source checks are separate from installed/visual proof |
| 1. Foundations | Exact Desktop support matrix, catalog view contract, Canvas source contract | Three independent packets with fixtures and reviewed interfaces |
| 2. First useful loop | One real capability bound to a task; inspector + artifact + evidence | End-to-end isolated execution and negative cases; no private host knowledge needed |
| 3. Product alpha | Canvas interaction, onboarding, code pack, graceful recovery | Supported fresh-profile install, use, restart/recovery and uninstall; visual/accessibility QA |
| 4. Public release candidate | Clean source/package, contributor path, release evidence | Publication audit, reproducible package, CI, newcomer trials and documented limitations |
| 5. Expansion | Research/data/creative packs and measured improvements | Each pack independently passes its contract, negative cases and end-to-end task |

No calendar promise: the critical path is runtime compatibility → binding →
complete user loop → fresh-user acceptance. The Canvas source contract and the
catalog projection can progress alongside compatibility work. More workers do
not remove those dependencies.

The public alpha decision requires:

- Two fresh-profile installations using published instructions and no developer
  credentials or private infrastructure; user-supplied provider credentials are
  allowed where documented. At least one tester did not implement the feature.
- Three successful reruns of each supported demo with changed inputs, plus its
  failure/refusal cases. This is a release sanity bar, not a reliability estimate.
- Missing provider, unavailable runtime, denied permission, malformed artifact,
  disconnect, duplicate submission, restart and cancellation/outcome-unknown
  behavior visible and tested. Unsupported cancellation is labeled explicitly.
- Canvas keyboard navigation, readable narrow layouts, bounded scrolling, loading,
  missing, error and long-content states reviewed with sanitized fixtures.
- Stock DSH remains usable; install/remove leaves pre-existing sessions intact.
- Exact-commit gate, dependency/package provenance and repeatable artifact hash;
  source tests, runtime tests, model-assisted evals and visual QA reported separately.
- Public source/history/package audit: no credentials, private paths, private
  receipts or personal media; dependency/import rights and notices checked.
- Publication checklist names the artifact, repository history strategy, version,
  support matrix, known limits and rollback. Publication is a final explicit step.

## How the system grows more capable

An observed failure produces a bounded improvement proposal. The proposal gets
contract tests and an evaluation set containing held-out and refusal cases. A
separate reviewer evaluates outputs and regressions. Existing admission and
promotion mechanisms decide whether to admit it; rollback retains provenance.

Measure task completion, independently accepted output quality, intervention
count, elapsed time, reported model cost when available, refusal correctness and
reuse regressions. Record unknown cost as unknown. Compare model/runtime versions
and task conditions; do not collapse the result into an “AGI score.”

Later work can improve decomposition, model-assisted tool selection, reusable
memory and task-specific agent teams. None requires another task engine, a second
registry, self-granted permissions or uncontrolled recursive agent spawning.
The current lexical route in `lib/goal.js` is a legacy path to assess; do not
expand it into a new universal deterministic router.

## Working agreement for agent teams

Use the [execution plan](superpowers/plans/2026-09-28-public-desktop-release.md).
One integrator owns the shared branch and shared entrypoints. Up to three Luna
workers take independent packets, with a reviewer replacing a worker as slots
free up. Independent worktrees are appropriate for overlapping future changes;
never run two teams against the same worktree.

Do not modify the user's live profile, providers, runtime services or canonical
registry to satisfy a development check. Do not push, publish, promote or dispatch
heavy jobs. If a packet needs a currently unavailable runtime seam, submit the
source-backed limit and a smaller truthful slice; do not invent the seam.
