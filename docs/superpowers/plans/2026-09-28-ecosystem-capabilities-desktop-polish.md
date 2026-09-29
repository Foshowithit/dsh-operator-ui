# Ecosystem capabilities and daily-use Desktop delivery plan

> **For agentic workers:** Use superpowers:subagent-driven-development or
> superpowers:executing-plans for one claimed packet at a time. The user selected
> Luna implementation workers with independent review. Checkboxes are future
> acceptance work, not completion claims.

**Goal:** Account for the useful functionality across all three nominated plugin
directories, turn appropriate candidates into tested capabilities, and deliver a
polished Desktop journey the user can use before the whole catalog is processed.

**Architecture:** Extend the existing DSH Desktop product and canonical RCOS
admission/execution path. Keep a repository-owned research inventory outside the
runtime, reuse native DSH tools where appropriate, and create task packs only for
outcomes that need a repeatable contract and evidence. The runtime library consumes
explicit observations; a directory listing never becomes execution authority.

**Tech Stack:** Existing Node >=22 ESM host, DSH ModuleLoader with host React,
Cordis additive slots, Node test runner, current Archon binding and closed
PanelDoc renderer. No new application framework or package manager is assumed.

**Spec:** [Public product roadmap](../../PUBLIC-DESKTOP-ROADMAP.md).
This is an execution addendum to the [release plan](2026-09-28-public-desktop-release.md),
not a second queue. [AGENT-QUEUE](../../AGENT-QUEUE.md) remains the ownership ledger.

**Research baseline:** Operator commit b49559c, 2026-09-28. Read the
[plugin source contract](../../PLUGIN-ECOSYSTEM-CONTRACT.md),
[directory survey](../../PLUGIN-DISCOVERY-SURVEY.md), and
[Desktop source audit](../../DESKTOP-POLISH-AUDIT.md).
Their observations are source evidence, not installation or runtime certification.

## What “all the links” and “usable” mean

Scope is dshfind.com, dshmarket.com and awesome-dsh-plugin.com, plus the primary
package/repository documentation linked by their plugin entries. Do not recursively
crawl arbitrary outbound links. Freeze a source snapshot/date for each sweep;
later additions are a separate delta, so a growing directory does not make a
completed snapshot impossible to account for.

Every collected listing gets a disposition. Every useful distinct outcome gets
an integration proposal. A plugin that adds a theme, provider, transport, or
runtime service is not automatically a task capability. Prefer using an existing
native tool over wrapping it in an unnecessary workflow.

The first daily-use milestone is a supported isolated Desktop installation with
one complete capability → authorized task → inspector/artifact → evidence → rerun
journey and recoverable failures. It does not wait for thousands of catalog entries.
The public alpha still has the broader gates in the release plan.

## Global constraints

- One team per worktree, at most three workers plus the integrator. Claim files in
  the queue before edits. Only the integrator edits shared client/host entrypoints,
  package metadata, gate discovery, roadmap or queue.
- Preserve stock DSH chat/tabs, existing control plane, canonical registry
  ownership and all twelve PanelDoc primitives. User gestures control focus.
- B1 currently supports only an explicit archon-workflow binding. A plugin ID,
  DSH tool name or MCP server cannot be cast into it. A new execution binding needs
  a separately reviewed source-backed contract; do not build a second task engine.
- Deterministic normalization of catalog metadata is allowed; it is not a task
  router. Selection remains explicit or supported model-assisted selection.
- Publisher compatibility declarations, installed host plugins, RCOS installation,
  independent verification and current eligibility are distinct facts.
- Catalog research files below are offline development artifacts, excluded from
  runtime imports/package contents. They are not a new persistent runtime registry.
- No product polling, arbitrary session routes, implicit installation, live
  profile/provider/service changes, canonical promotion, push or publication.
  Keep scheduled work off. No heavy job or live WM dispatch is needed for planning.
- Follow current source/runbooks before any isolated runtime action. Pin the exact
  host/tool/plugin tuple and use a disposable home. Never fall back to the user's
  default profile or restart/navigate the active Desktop.
- Plugin install code follows DSH's actual host behavior. RCOS task admission
  does not review or limit third-party plugin code.
- Directory scale, stars and model self-reports are not quality or safety evidence.
  Missing results, telemetry or verification remain unknown.

## Review focus

1. Same repository hosts multiple packages, forks or versions: K1 preserves
   identities and source rows instead of merging by title or repository alone.
2. Missing page/cursor or inaccessible source: K1 reports partial coverage rather
   than “all audited”; site-advertised count remains separate from collected rows.
3. Malicious metadata/install text: K3 renders bounded inert strings and explicit
   vetted links; it never runs commands, fetches arbitrary URLs or grants scope.
4. Host/source update after qualification: K4 and B2 invalidate stale compatibility
   evidence and revalidate canonical identity before submission.
5. Context switch, duplicate click, restart or unknown outcome: P1/P3/P4 clear
   stale observations, preserve focus, and never silently re-dispatch work.

## Two parallel tracks

### First candidate wave

These are proposed outcomes, not installed or certified capabilities. The
[survey](../../PLUGIN-DISCOVERY-SURVEY.md) records 13 actual upstream candidates
and how deeply each was inspected. The table below selects useful starting
outcomes; K2 may change their order when binding or prerequisite evidence fails.

| Priority | Source / reuse path | First useful outcome | Proof before calling it ready |
| --- | --- | --- | --- |
| First journey | Native DSH tools; existing D2 packet | Inspect a small code task, produce a patch, run tests, get independent review | Workspace scope, bounded changes, test evidence and refusal cases |
| First research pack | [modsearch](https://github.com/liustack/modsearch) | A short research brief whose important claims link to fetched sources | Actual search/fetch contract, provenance, unavailable-source and citation checks |
| Next visual pack | [dsh-vision-toolkit](https://github.com/Anionex/dsh-vision-toolkit) | Inspect an image or screenshot and return bounded OCR/visual observations | Exact backend, supported image inputs, held-out accuracy and missing-evidence cases |
| Next document pack | [dsh-univer-office](https://github.com/dream-num/dsh-univer-office) | Inspect one small workbook and produce a checkable summary | One supported file format, formula/value preservation, input/output and round-trip checks |
| Existing artifact lane | Existing audio-offline-verify; D1 packet | Check a media file and inspect its measurements/evidence | Real binding and declared ffmpeg/ffprobe environment; no tooling installed on the active Mac |
| UI reuse candidate | [dsh-context](https://github.com/bowenliang123/dsh-context) | Understand context use and composition alongside a selected task | Prefer existing DSH projections; no duplicate unsupported live telemetry |
| Optional creative pack | [dsh-image-gen](https://github.com/shanliuling/dsh-image-gen) | Generate an image artifact with model/source evidence | Explicit backend credentials/cost, output containment and independent artifact checks |

The surveyed team/memory/remote-access/messaging plugins stay in the inventory
with explicit prerequisites. They do not become dependencies of the first
Desktop journey. The Spotlight/worktable candidates must demonstrate a gap beyond
our existing palette/Canvas before adding overlapping UI.

### Dependency map

~~~mermaid
flowchart LR
  B1a["B1a source boundary"] --> K1["K1 source inventory"]
  K1 --> K2["K2 disposition batches"]
  K2 --> K4["K4 one outcome pack"]
  B1a --> K3["K3 discovery read model"]
  A1["A1 source contracts"] --> P1["P1 fixture preview"]
  P1 --> B2["B2 usable library"]
  P1 --> C2["C2 Canvas mount"]
  C2 --> P3["P3 Canvas and inspector polish"]
  B2 --> K4
  K4 -. optional candidate .-> Outcome["One qualified outcome: D1, D2 or K4"]
  Native["Existing D1 / D2 packs"] --> Outcome
  Outcome --> P4["P4 daily-use acceptance"]
  A2["A2 exact Desktop package"] --> P4
  P3 --> P4
  P4 --> R2["Existing public release gates"]
~~~

K1/K2 can progress while Desktop work proceeds. B1a is the bounded source
contract, not an exhaustive ecosystem audit. Existing canonical capabilities can
drive the first useful journey. Third-party catalog completion is not a new
release-critical dependency.

The documented awesome-dsh-plugin JSON export and dshmarket share catalog
lineage; start K1 with a pinned licensed snapshot of that export. dshfind has a
documented public API with versioned dataset reads, but its catalog-content reuse
terms remain unresolved in this audit. Preserve link-only/manual research for
that source until the rights decision is recorded. See B1a for source permalinks.

## Track K: inspect, reuse and qualify the ecosystem

### K1 — Reproducible source inventory and coverage

**Owner/files:** one inventory worker; create
scripts/plugin-inventory.mjs, test/plugin-inventory.test.mjs,
docs/ecosystem/sources.json, docs/ecosystem/inventory.json and
docs/ecosystem/README.md. Parent owns any gate/package changes.
**Depends:** B1a. Source acquisition remains read-only and manual/operator-run;
this script is an offline normalizer/validator, not a network crawler.

**Interfaces to freeze:** normalizeInventory({sources, listings}) returns
{schema, entries, conflicts, coverage}; validateDispositionCoverage(inventory,
decisions) returns {ok, missing, duplicateDecisions, unknownEntries}.

Source records carry sourceId, sourceUrl, observedAt, sourceRef/digest when
available, accessBasis, advertisedTotal (integer or null), collectedRows,
traversalComplete and unresolvedCursor/reason. Counts are observations tied to
one snapshot, never a live widget. A source with no permitted enumerable interface
stays link-only and traversalComplete=false.

Listing records carry sourceId/sourceKey, source URL, package name/version when
explicit, repository URL/subdirectory/ref, publisher, declared DSH range,
license evidence and upstream update date when present. Null means missing;
unknown versions are not equivalent to every version.

Use entryId only as a local inventory-row reference. Where no stable source key
exists, derive it from sourceId, snapshot digest and row index; do not label it
as an upstream identity or use it to join runtime records. Shared catalog lineage
between dshmarket and awesome does not prove two differently timed snapshots
contain identical rows. Only exact evidenced matches share a reviewed grouping.

- [ ] Use only B1a's documented permitted source interface or explicitly licensed
  repository index. If none exists, capture minimal manually reviewed references
  and the coverage gap. Never manufacture a feed endpoint or scrape page markup.
- [ ] Freeze the inventory schema in docs/ecosystem/README.md. Keep a provenance
  edge for every original listing, including duplicates; a multi-package repo
  and an unverified fork remain distinct. Never deduplicate by display name.
- [ ] Write failing tests for overlapping sources, scoped package names, multiple
  packages per repository, version conflicts, missing identity, repeated cursor,
  interrupted traversal, malformed/accessor-bearing metadata and stable ordering.
- [ ] Implement the pure normalizer with bounded inputs and no I/O on import.
  Cap an operator acquisition batch at 100 rows or one published snapshot;
  pause and record continuation rather than launching unbounded parallel fetches.
- [ ] Run node --test test/plugin-inventory.test.mjs. Confirm output counts
  reconcile to original source rows and incomplete coverage cannot become complete.
- [ ] Have a different worker check a sample of identity matches and every
  conflict rule against primary sources. Commit code only after focused checks;
  parent runs the canonical gate against that code commit.

**Done:** coverage is measurable for each frozen source, including what is missing.
This is discovery coverage, not a claim that every plugin has been audited.

### K1b — Expand K1 with the full licensed awesome feed snapshot

The 13-row K1 inventory is a starter sample. The next bounded source-expansion
packet is fully specified in the [K1b implementation plan](2026-09-28-k1b-awesome-snapshot.md).
It captures the permitted awesome export only; dshfind remains link-only and
dshmarket remains the same catalog lineage. Collection coverage stays separate
from plugin review, compatibility and capability readiness.

### K2 — Assign every distinct entry a disposition

**Owner/files:** one reviewer per disjoint inventory-ID range; create
docs/ecosystem/batches/<snapshot>-<batch>.json and reviewed candidate briefs under
docs/ecosystem/candidates/<candidate-id>.md. Workers never edit a shared ledger
concurrently; parent merges their files and runs K1's coverage validator.
**Depends:** a K1 snapshot, not all sources being complete.

A decision contains entryId, disposition, reason, userOutcome, upstreamIdentity,
evidenceLinks, prerequisites, proposedCapabilityIds and reviewer. Disposition is
one of native-reuse, optional-host-plugin, task-pack, ui-enhancement, duplicate,
defer, or reject. Duplicate records name their actual equivalent; defer/reject
have a concrete source-backed reason and a revisit condition.

- [ ] Process 25 unique entries per worker batch. Inspect primary README, manifest,
  license, maintained version and public tool/input/output contract for promising
  entries; directory prose alone earns only “discovered”.
- [ ] Group by real user outcome: inspect files, research/cite, inspect data,
  code/test/review, artifact inspection, optional document/media creation,
  integrations, or Desktop usability. Preserve different providers/side effects.
- [ ] Prefer a useful native tool or host feature when available. Propose a task
  pack for a repeatable outcome with inputs, outputs, evidence and refusal cases.
  Provider/theme/session transport plugins stay host features.
- [ ] Select the next batch by daily-use value, evidence quality, portability,
  setup burden, cost/resource prerequisites and overlap with installed features.
  Write reasons; do not invent a universal safety score or deterministic router.
- [ ] Have a second worker review every proposed task-pack/UI integration, plus
  all rejected/duplicate identities likely to hide distinct functionality.
  Reconcile one disposition per inventory entry with K1's validator.
- [ ] Report collected → unique → inspected → proposed → runtime-qualified
  separately. Claim sweep completion only when every known source row is
  accounted for and unresolved source coverage remains explicitly listed.

**Done:** all entries in the assigned snapshot range have an inspectable decision;
the shortlist remains a shortlist, not proof the ecosystem is fully audited.

### K3 — Show useful discovery without inflating readiness

**Owner/files:** worker owns lib/plugin-discovery.js and
test/plugin-discovery.test.mjs; parent integrates only reviewed fields into
lib/client.js. No new host route, runtime catalog store or network scraper.
**Depends:** B1a's frozen field contract; K1 supplies sanitized fixtures.

**Interface:** projectPluginDiscovery({listings}) returns
{schema: 'operator-plugin-discovery/1', entries, errors}. Each entry contains only
B1a's ExternalPluginListing fields; errors contain bounded code/message strings.
Freeze maximum counts/string lengths and allowed URL protocols in the module's
contract tests before implementation. This first slice projects metadata only:
it neither accepts nor joins host observations or canonical links. Those reserved
B1a types need an explicit producer and matching contract in a later slice.
It stays separate from projectCapabilityView({registry, observations}).

- [ ] Write failing cases for untrusted URLs/command text, missing versions,
  forged verified/eligible flags, duplicate IDs and oversized text. Preserve
  sourceAsOf and collector fetchedAt separately; old or missing timestamps cannot
  imply current verification. Do not invent a freshness threshold or active state.
- [ ] Implement bounded inert discovery records with source and declared
  compatibility labels. The permitted awesome feed has no declared DSH range;
  show unknown unless separate publisher evidence actually supplies it. No list
  entry enters the canonical capability projector.
- [ ] Use explicit external links through the source-confirmed host link mechanism.
  A “View source” or “Open marketplace” action requires a gesture and does not
  install code. If that host mechanism is unknown, display inert source text.
- [ ] Run node --test test/plugin-discovery.test.mjs and review synthetic states.
  Add UI coverage via P1 before merging parent-owned client integration.

**Done:** people can understand and explore useful options while “ready to use”
continues to mean matched evidence from the existing capability model.

### K4 — Turn one approved outcome into a task pack

**Owner/files:** one worker per capabilities/<id>/, including contract.json,
registry-entry.json (candidate only), README.md, adapter/ and evals/; create
test/<id>-capability.test.mjs. Parent owns runtime bindings and package integration.
**Depends:** K2 source-reviewed candidate; A1/B2 and a supported exact execution
binding. Reuse D1/D2 for the artifact/code starter packs rather than duplicate them.

**Interface:** existing rcos-capability-contract/1 input/output schema and actual
adapter-kernel contract: RCOS_INPUT, RCOS_OUTPUT, RCOS_EVIDENCE_DIR. Verify the
kernel/runbook before adapting. Source identity pins upstream ref/package digest,
license and tool API; registry-entry.json alone neither installs nor promotes it.

- [ ] Freeze one user outcome, input limits, output/artifact shape, access,
  resources, dependencies, timeout and failure semantics. Record why native reuse
  alone is insufficient. If there is no supported binding, retain a proposal.
- [ ] Add failing contract/refusal tests before implementation: valid changed
  inputs, missing dependency, denied/out-of-scope access, malformed input,
  timeout/disconnect, invalid/missing evidence and misleading upstream success.
- [ ] Implement the smallest adapter using supported tools; avoid copying upstream
  code where a dependency or tool call suffices. Retain required notices.
- [ ] Run the focused test and candidate evals in the authorized bounded environment.
  A model-generated artifact needs independent output checks and held-out cases;
  never turn the model's own verdict into verification.
- [ ] Have a different worker verify the artifact and negative controls. Keep
  source tests, runtime outcome, artifact quality and compatibility as separate
  evidence bound to exact bytes. Missing cost/time measurements stay unknown.
- [ ] Parent integrates the reviewed candidate, runs the frozen gate on its code
  commit, and records evidence in a later docs commit. Canonical admission and
  promotion still use their existing owner; no Mac-side registry writes.

**Done:** one reproducible useful outcome with honest failure handling. Repeat
per useful candidate; multiple thin wrappers for one outcome do not count as breadth.

## Track P: make the Desktop pleasant and dependable

### A2 refinement — Current Desktop package and isolated setup

Reuse A2's files and tests in the main release plan. Before UI rollout, recheck the
advertised target recorded in DESKTOP-COMPATIBILITY.md (currently 0.2.0-rc.1),
then inspect exact archive/package/source identities and peer ranges. Keep the
installed 0.1.7-rc.2 source capture separate; never widen a pin just to clear a badge.

- [ ] Prepare a disposable-profile install/boot/remove/recovery runbook from the
  actual version's source. Do not assume DSH_HOME alone isolates an Electron shell.
- [ ] Verify doctor/setup shows the exact missing prerequisite with one actionable
  next step. A source-supported release is not runtime-certified.
- [ ] Prove stock surfaces and fixture sessions survive isolated install/remove.
  Record exact package hash, profile path, command and limits in A2 evidence.

### P1 — Real-component synthetic preview and state matrix

**Owner/files:** worker owns scripts/preview-operator.mjs,
test/operator-preview.test.mjs, test/fixtures/operator-preview/ and
docs/DESKTOP-VISUAL-QA.md. Parent owns any lib/client.js extraction/wiring.
**Depends:** A1's source contract for component loading and a pinned browser
React/ReactDOM resolver. The exact A2 host tuple is required for a Desktop
compatibility claim. Source preparation can start earlier; render implementation
waits for the resolver proof below.

**Interface:** a development-only fixture host loads the actual served client
module through window.__ModuleLoader__.load and host-matched React. It supplies
only explicit mocked services/slots/observables and canned same-origin responses.
It is not a new production route or a fabricated completed DSH session.

- [ ] Pin actual upstream React/ReactDOM versions and a reproducible development
  dependency/loader path from the target host source. Record license, exact bytes
  and ModuleLoader require mapping. This package currently supplies no React
  dependency; a VM stub is insufficient. If no supported browser resolver exists,
  finish this contract subtask and retain rendering as blocked rather than using
  a guessed CDN or reading a live app service.
- [ ] Prove the real factory and registered component render without dispatch.
  Prefer existing entry capture patterns in test/wm-ui.test.mjs and
  test/system-receipt-ui.test.mjs; do not build a second copy of the production UI.
- [ ] Add failing tests ensuring fixture selection cannot read outside the named
  fixture directory, reach live endpoints, run a tool, or write a profile.
  Fail closed when a fixture/service is absent.
- [ ] Implement a loopback-only preview, visibly marked “Synthetic preview”.
  Proposed CLI: node scripts/preview-operator.mjs --port <unused-port>.
  Stop its owned process after QA; never kill another listener to free a port.
- [ ] Include compact/expanded WM cards, job snapshot, library, setup/receipt,
  artifacts and errors: missing, pending, refused, failed, unknown outcome,
  reported success, independently verified, stale and tampered.
- [ ] Run node --test test/operator-preview.test.mjs test/wm-ui.test.mjs
  test/system-receipt-ui.test.mjs. Use actual browser rendering for subsequent
  visual checks; VM React stubs alone do not verify layout or keyboard behavior.
- [ ] Capture sanitized fixtures at widths 390, 768 and 1440 px; light/dark;
  200% text; keyboard-only; long titles/errors; and reduced motion. Record exact
  code/host/fixture identity. Synthetic QA does not replace A2 Desktop mounting.

**Done:** UI changes can be seen and evaluated without dispatching a live task.

### P2 — One understandable library and first-run experience

Implement within B2; it owns lib/capability-view.js consumption, canonical identity
selection and test/capability-selection.test.mjs. Parent edits lib/client.js,
lib/index.js and lib/goal.js. Source observations must be explicit; absent
observation producers keep the corresponding fact unknown.

- [ ] Make the existing Capabilities and Intelligence surfaces consume consistent
  readiness facts. Remove unsupported blanket claims such as “Installed executable
  capabilities” when the only data is a registry listing.
- [ ] Give each card a plain outcome, expected output, prerequisites, source and
  current reason. Start from a goal or filter by task; keep advanced evidence in
  expandable details. Do not scatter contract jargon through the primary flow.
- [ ] Ready/unavailable/explore states remain distinguishable. Search and filter
  are in-memory views of supplied data; native chat and stock tabs remain usable.
- [ ] Wire exact selectedCapability identity to existing admission as B2 specifies.
  Test stale digest/version, changed registry, duplicate submit, absent binding
  and denied scope; refusals dispatch nothing and never choose a replacement.
- [ ] First-run status gives one next action and a clearly labeled sample.
  Verification level, setup health and task success are separate.
- [ ] Run B2 focused tests plus P1 fixtures for empty, loading, error, zero matches,
  many entries and long text. Verify keyboard operation and focus preservation.

**Done:** a user understands what can work now and why another option cannot.

### P3 — A useful small Canvas with polished inspectors

Reuse C2/C3 files and tests. Pin donor bytes/license before import. Begin with a
selected task inspector, an artifact and evidence arranged manually; pan/zoom and
large graph effects come after the first complete journey.

- [ ] Mount reviewed components through the proven host seam; exact context/call
  identity feeds C1, while PanelDoc retains its existing run/artifact namespace.
- [ ] Keep objective, reported result, independent verification and unknown state
  visibly distinct. Snapshot timestamps never imply a live worker stream.
- [ ] Audit the target host's openFile/inspect callback path handling and test
  containment or an explicit host-authorized artifact mapping before enabling
  Canvas artifact actions. The current WM component forwards seat-reported paths;
  callback existence alone does not prove authorization. Until scoped access is
  proved, show receipt artifact paths as inert text. Untrusted paths/text cannot
  create file access or approval controls.
- [ ] Make expand/close, selection and arrangement usable by keyboard; restore
  focus to the user's initiating control. Bound long content, keep narrow layouts
  usable, respect reduced motion and use host theme tokens.
- [ ] Test context switch/unmount clearing, missing source, stale asynchronous
  updates, malformed/adversarial text, absent artifact and native callback failures.
- [ ] Run C2/C3 focused tests and P1 visual matrix, followed by actual isolated
  Desktop mount checks. Record the two evidence types separately.

**Done:** the selected work, its useful output and its evidence are easy to inspect.

### P4 — Daily-use acceptance, then the existing public-release gates

Reuse E1 recovery/journey tests and create docs/DESKTOP-DAILY-USE.md with an exact
candidate manifest, install/rollback instructions and unresolved limitations.
P4 accepts one proven D1, D2 or K4 outcome; K4 and full catalog coverage are
optional. This narrower daily-use milestone does not complete E1 or R2, whose
existing D1/artifact and D2/code requirements remain in the release plan.

- [ ] Demonstrate one complete useful journey three times with changed inputs,
  an unavailable-prerequisite case, a refusal and a failure; record actual results.
- [ ] Check reconnect/restart, context switches, repeated submission and cancellation
  or explicit unsupported/unknown outcome. Never automatically retry a task whose
  side effects are unknown.
- [ ] Confirm stock chat remains usable, no focus stealing occurs, and removing
  Operator leaves the pre-existing isolated fixture sessions intact.
- [ ] Review the candidate on keyboard/narrow/dark states and have a non-author
  follow the setup and first task instructions without private environment lore.
- [ ] Package from the exact tested commit. The user receives concrete upgrade and
  rollback details for a final live-install decision; do not replace their app
  during development.
- [ ] Then complete existing R1/R2 public audit, clean-source/history/package
  checks, reproducible builds and newcomer trials. A daily-use candidate is not
  an automatic public release or canonical promotion.

**Done:** a measured daily-use candidate, followed separately by public readiness.

## Team execution order and handoff

| Wave | Worker 1 | Worker 2 | Worker 3 | Parent integrator |
| --- | --- | --- | --- | --- |
| Current research | Marketplace/DSH source contract | Directory survey | Desktop source audit | Consolidate plan, dependencies and claims |
| Foundation | A2 package/isolated-profile proof | K1 offline inventory | P1 actual-component preview | Freeze interfaces; serialize shared edits |
| First journey | B2 isolated model/selection tests | C2 reviewed renderer/source adapter | K2 first candidate batch | Integrate library and mount one seam at a time |
| Daily-use candidate | One D1/D2 or K4 outcome pack | P3 focused visual/interaction fixes | Independent reviewer replacing a builder | P4 acceptance and exact-commit evidence |
| Expansion | One K4 pack directory | Another disjoint K4 pack | Reviewer/next K2 batch | Evaluate useful breadth and regressions |

No worker edits lib/client.js or lib/index.js in parallel with another. Workers
propose integration diffs to the parent; separate worktrees are used when a
packet cannot remain within disjoint files. The reviewer must not be the author
of the reviewed adapter. Do not grow the team beyond available slots.

Copyable handoff:

> Claim <packet> at <base SHA> in AGENT-QUEUE. Read the roadmap, this plan, the
> referenced source contract and AGENTS.md. Own only <exclusive files>. Deliver
> the packet's tests/evidence and a proposed shared-file integration diff.
> Preserve the current app, stock DSH, exact identity and canonical authority.
> Report unknowns and source/runtime/visual results separately. Do not install
> into live profiles, publish, promote, start schedules or run heavy jobs.

## Progress measures and stopping rules

Track source coverage, distinct user outcomes, independently qualified packs,
successful reruns, setup friction, user interventions and regressions. Publish
the evidence level beside each count. Runtime cost is recorded only when supplied.

A source outage pauses that source, not Desktop polish. A missing binding leaves
the candidate unavailable, not fabricated. A failed runtime or visual gate sends
the same slice back for repair before another feature is layered onto it.
A complete snapshot sweep can finish with justified deferred/rejected entries;
it does not require installing every plugin.

This planning batch runs no capability or Desktop compatibility tests because it
changes documentation only. Runtime and public-readiness checks above are future
acceptance work. Keep planned boxes unchecked until their evidence exists.
