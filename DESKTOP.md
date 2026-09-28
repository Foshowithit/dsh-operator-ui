# DeepSeek Desktop Operator — product home

This repository is the central development home for our DSH Desktop product:
Operator, the planned open canvas, and the capabilities-library experience.
The product direction was confirmed on 2026-09-28. The integration branch is
`rcos-dsh-reconcile`; the package identity remains `dsh-operator-ui`.

This is a development consolidation, not a completed migration or release.
Existing installations continue to run their installed bytes. Other runtime
repositories and the earlier Canvas source have not been merged here.

Public release work follows the [product roadmap](docs/PUBLIC-DESKTOP-ROADMAP.md),
[agent execution plan](docs/superpowers/plans/2026-09-28-public-desktop-release.md)
and [ownership queue](docs/AGENT-QUEUE.md). The
[ecosystem and daily-use addendum](docs/superpowers/plans/2026-09-28-ecosystem-capabilities-desktop-polish.md)
assigns directory review, capability conversion and Desktop polish to bounded
agent packets. B1 and C1 have source-only contracts and tested implementations;
A1 has a source-audited Desktop contract with runtime proof pending. Shared
integration files have one writer.

## The experience we are building

Choose a capability or describe a task. See the selected execution, its
outputs, and its evidence together. Open a tool call into a useful inspector;
arrange inspectors and artifacts on a canvas. Reuse a capability when it
works, and use observed failures to drive the next improvement.

The first complete product milestone is:

> Choose one real capability → start an authorized task → inspect execution
> on Canvas → open an artifact → review its evidence → run it again.

Useful breadth means tasks people can actually complete. A growing catalog
alone is not proof of capability, reliability, or general intelligence.

## Ownership and code map

| Area | Home / authority |
| --- | --- |
| DSH extension and execution inspectors | `lib/client.js`, `lib/wm-bridge.js`, `lib/job-list-bridge.js` |
| Host integration and readiness | `lib/index.js`, `lib/config.js`, `lib/verify.js`, `system-manifest.json` |
| Product routing, tasks, evaluation and authority | Existing modules under `lib/`; preserve their current contracts |
| Capability assets maintained here | `capabilities/`; external canonical registries retain their own ownership |
| Capability-library UI | Existing Intelligence/Capabilities surfaces; grow their shared experience here |
| Canvas migration | `docs/CANVAS-DSH-SEAM-RECON.md`; source import and DSH binding still pending |
| Artifact federation | `FLOWROUTER.md`; sealed protocol boundaries remain in force |
| Verification and release | `test/`, `scripts/`, `COMPAT.md`, `CONTRIBUTING.md` |

DSH owns sessions and tool calls. Archon owns its workflow execution. The
canonical registry owns capability records. The product composes their
authorized data; centralizing development does not duplicate their stores.
Use the existing DSH extension seams and preserve stock surfaces.

DSH plugins and Operator capabilities are separate things. A DSH plugin can
add host tools or UI; an Operator capability is a task-level contract with an
explicit binding and evidence. Community directories such as
[dshfind](https://dshfind.com) and the [awesome-dsh-plugin list](https://awesome-dsh-plugin.com)
are third-party discovery sources; [dshmarket](https://dshmarket.com) is a
third-party marketplace that can be installed through DSH's plugin flow. None
is a canonical capability record or permission source. Show any surfaced
listing with its origin and compatibility evidence; a listing or plugin
installation alone never makes a capability verified or eligible. Keep
installation in DSH's user-controlled plugin flow. Plugin code gets whatever
host access DSH's install and runtime behavior permits; Operator does not review
or limit it. The user's plugin-install decision through DSH is separate from
task admission.

## Ordered delivery queue

### 1. Desktop readiness

- Ship the manifest and seed assets actually consumed by verification.
- Separate a valid receipt seal from its achieved verification level.
- Check the current Desktop extension contracts in source; record an exact
  tested host version before expanding the compatibility claim.
- Prove the resulting package in an isolated profile before release.

Acceptance: the packaged product can find its own verification inputs, and
partial, unavailable, stale and failed verification cannot claim RCOS success.
The current development slice addresses the first two items only.

### 2. Usable capabilities library

- Consume an explicit projection of canonical capability records; do not
  silently substitute invented workflow bindings or permissions.
- Show separately what is installed, verified, executable and eligible now.
- Give unavailable capabilities a concrete reason and missing prerequisites.
- Start with a small useful set spanning inspection, code, research and
  artifacts, chosen from actual available adapters and execution evidence.
- For each addition, record input/output contract, version, requirements,
  permissions, real execution binding, evals and provenance.
- Treat third-party plugin directories as discovery only. Preserve their source
  and declared compatibility separately from tested host support and canonical
  capability readiness; link out until a supported machine-readable contract is
  verified.

Acceptance: one chosen capability completes the actual product path. A larger
library follows by repeating that proof, with refusals and unavailable states
tested alongside successful execution. Production execution remains a
separate release/operations step.

### 3. Open canvas

- Establish a host-owned source adapter with exact context/call identity,
  scalar projections and teardown on context changes.
- Import reviewed, pinned Canvas components with attribution; the donor
  currently contains untracked work and cannot be copied wholesale.
- Retain the twelve-primitive PanelDoc vocabulary, trusted host approval UI,
  and human control of focus. A panel reference cannot authorize a data read.
- Start with explicitly labeled call snapshots and reported WM results;
  live workers need an actual supported lifecycle correlation contract.

Acceptance: one task's inspector and artifact can be opened together, updated
from authorized source data, and closed without leaking state to another
task. No invented progress, forced camera movement, or automatic approvals.

### 4. Capability growth loop

Mine a real task failure → propose a bounded capability change → execute
independent evals → review evidence → explicitly promote → measure reuse and
regressions. Keep held-out tasks and negative cases. Failed improvements stay
visible and reversible; promotion never follows from an agent's claim alone.

Acceptance: an improvement makes a previously failing task succeed without
regressing the existing evaluation set or expanding permissions silently.

## Working safely alongside the running product

One team owns an integration worktree at a time. Allocate disjoint files to
workers; the parent reviews and verifies the combined changes. Inspect branch
state and ownership before editing. Do not merge old worktrees in bulk.

Development here does not authorize editing installed profiles, changing
provider configuration, restarting services, dispatching live tasks, changing
registry authority, or publishing. Use isolated fixtures for development and
bind verification evidence to the exact tested commit. A passing source test
does not establish a working live install or visual acceptance.

## Current evidence and limits

Call-bound WM/job snapshots: implementation `6c8af01`, evidence in
`docs/superpowers/plans/2026-09-26-wm-inspector.md`. Canvas reconnaissance:
`1e06151`, `docs/CANVAS-DSH-SEAM-RECON.md`.

Capability readiness projection: source implementation `ebaaf2e`, evidence in
`docs/CAPABILITY-VIEW-EVIDENCE.md`. The projection is not yet connected to a
host observation producer or capability UI.

The complete Canvas/capability path above is not ready yet. Track completed
slices by tested commits; do not turn this roadmap into a release claim.

Desktop readiness code `4a4cb1a` includes the verifier manifest in the package
and distinguishes receipt validity from its achieved verification level.
See [the verification record](docs/DESKTOP-READINESS-EVIDENCE.md) for exact scope.
C1 adds a tested pure execution-source store at `1f73faf`; the [evidence](docs/EXECUTION-SOURCE-EVIDENCE.md)
records its source gate and states that DSH/Canvas wiring remains future work.
