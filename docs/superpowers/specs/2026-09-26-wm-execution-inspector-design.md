# DSH Operator WM Execution Inspector

**Status:** execution authorized; first-slice amendment below supersedes conflicting proposal details
**Date:** 2026-09-26  
**Scope:** the first Creative Canvas execution-object vertical slice

## Source-review amendment (2026-09-26)

The user approved Luna team execution. Implementation proceeds under
`../plans/2026-09-26-wm-inspector.md`. The initial deliverable consumes DSH's
existing live tool-block updates and displays the structured dispatch receipt
inside the keyed tool card. It adds no host route and no renderer polling.
The route/graph/worker sections below describe later milestones, not facts
already supported by the dispatcher.

Source inspection proved that dispatch returns its exact child/run identity
only after settling and disposing the seat. Parent/preset headers alone do not
attribute a child to a call. Missing result means awaiting result, never an
inferred running state. A seat's reported SHIP is a receipt claim, not
independent verification. The first slice must preserve these distinctions;
full live inspection needs a supported correlation seam and authorization for
session reads before it can meet the original end-to-end acceptance criteria.

## Intent

When a user expands a `dispatch_seat · wm` tool call, the row should reveal
the real WM execution behind that call. The existing DSH workflow card remains
the native summary surface; DSH Operator adds an inspectable depth layer backed
by the same DSH session events, seat-dispatch receipt, optional seat audit row,
and existing Archon run data. The expanded view must make the current state
legible without inventing progress, workers, success, artifacts, or evidence.

This is the first execution-object implementation for the Creative Canvas
direction: chat → WM → structured workflow → Archon execution → artifacts and
verification → durable receipt. Later execution types can reuse the projection
and panel grammar, but this slice only owns `dispatch_seat`.

## Constraints and observed contracts

- DSH’s stock `@deepseek-ai/dsh-client-ui-tool` renderer dispatches a custom
  `tool.call.toolview` by the wire tool name. `dispatch_seat` is therefore an
  additive renderer seam; the generic tool card remains the fallback for raw
  input and unsupported data.
- A DSH caller session is an event-sourced `Session`. `tool/call` carries the
  exact unparsed argument string and `tool/result` carries the model-facing
  result, error, and optional metadata. A seat child is identified from its
  actual session header (`parentSession` and `agentPreset`), never from a
  client-created tracker.
- `dsh-seat-dispatch` treats its receipt as the success signal. Its durable
  fields include `verdict`, `summary`, `artifacts`, `evidence`, `blockers`,
  `archon_run_id`, `archon_status`, `archon_artifact_dir`, `lane`, and `next`.
  `none` means no Archon run was observed; it must remain `none` in the UI.
- The seat audit JSONL is append-only and may be unavailable, incomplete, or
  on a different profile. It is supplementary provenance, not a replacement
  for the session log or receipt.
- DSH Operator already exposes read-only Archon catalog, run-list, and run
  detail routes. The inspector may link or include an Archon run only when the
  receipt supplies a real run id; it must not manufacture a run id or duplicate
  Archon state.
- All changes stay in the isolated `rcos-dsh-reconcile` branch. No live client or
  execution-host install, publish, promotion, push, or render is part of this slice.

## Proposed architecture

### 1. A pure observed-data projector

Create `lib/wm-inspector.js` with a small, testable projection boundary. Its
inputs are the caller's matching `tool/call` and `tool/result` events, the
observed direct child sessions, optional audit rows, and optional Archon run
detail. It returns a JSON-safe `wm-execution` object with explicit `null` or
`unknown` values when a fact cannot be established.

The projector is the only place that translates DSH and seat-dispatch shapes
into Operator UI language. It must:

- preserve the raw argument and result separately from the derived summary;
- derive `running`, `completed`, `fix`, `blocked`, timeout, and receipt-missing
  states from observed events and receipt fields;
- expose workers only when a real child session with a WM seat identity exists;
- expose progress only with an observed numeric basis, otherwise leave it
  unknown;
- copy receipt artifacts, evidence, checks, blockers, failures, retries, and
  Archon identity without upgrading their meaning;
- keep `sources` on the projection so a panel can distinguish DSH session,
  seat receipt, seat audit, and Archon facts.

The projector does not read the filesystem, poll Archon, mutate a session, or
infer success from a completed turn, an artifact path, or a child count.

### 2. A host-owned, read-only WM projection route

Extend the host plugin injection with the existing DSH `sessions` service and
add `GET /plugins/operator-ui/wm?op=execution&session=<caller>&call=<callId>`
behind the existing authentication chokepoint. The handler will:

1. resolve the caller session from `ctx.sessions`;
2. locate the exact `dispatch_seat` call and matching result by `callId`;
3. enumerate direct child sessions from actual headers and event logs;
4. read only the bounded seat-audit rows relevant to the dispatch, when the
   configured DSH home exposes them;
5. fetch existing Archon run detail only for a real receipt `archon_run_id`;
6. pass those observations to the pure projector and return its JSON.

Not-found, malformed, and unavailable sources return a structured refusal or
an explicit unavailable source. The route never creates a run record,
background worker, cache, receipt, or inferred status.

### 3. An additive DSH tool-call renderer

Register a `tool.call.toolview` renderer for the exact key `dispatch_seat` in
`lib/client.js`. The compact row follows the native DSH hierarchy:

`WM · <observed objective> · RUNNING` (and a numeric progress fraction only
when the projector reports one).

Clicking the row expands an inspector in the same tool area and fetches the host
projection. The panel uses local tabs—Graph, Workers, Artifacts, Evidence,
Terminal—without adding another top-level navigation pile. Each tab is an
honest view of the projection:

- **Graph:** observed Archon run identity/status and a link/action into the
  existing Workflows surface when available; otherwise the panel says the
  graph is not observed.
- **Workers:** actual child WM sessions, their ids, preset, running state, and
  last observed activity.
- **Artifacts:** receipt-declared artifacts only, using the existing file-open
  callback where available.
- **Evidence:** receipt, evaluator/check fields, Archon provenance, and audit
  provenance as distinct sources.
- **Terminal:** actual terminal/tool activity from observed child events;
  absence is rendered as absence.

Raw JSON remains a secondary disclosure inside the expanded card. Completion
leaves a durable result and receipt visible through the existing conversation
history; the panel does not create a second run history.

### 4. Generalization seam

The projection shape is intentionally named an execution object and carries a
stable `kind`, `identity`, `state`, `workflow`, `workers`, `activity`,
`artifacts`, `evidence`, `failures`, `blockers`, and `sources` vocabulary. The
first renderer is WM-specific, but later renderers for Archon, browser, files,
tests, evaluators, and terminal can register the same slot and panel grammar.
The 12-primitive Canvas document and typed run-scoped bindings remain a later
surface; this slice supplies the source-backed execution object they will
consume.

## Data shape

The endpoint returns `{ ok: true, execution }`, where `execution` is JSON-safe
and follows this contract:

```text
execution.kind = "wm-execution"
execution.identity = {
  callerSessionId,
  callId,
  dispatchRunId?,
  seat
}
execution.summary = {
  objective?,
  state: "running" | "completed" | "failed" | "blocked" | "unknown",
  verdict?: "ship" | "fix" | "blocked" | "none",
  progress: { value?: number, basis: "observed" | "unknown" },
  elapsedMs?
}
execution.workflow = { name?, currentNode?, archonRunId?, archonStatus? }
execution.workers = [{ sessionId, seat, preset?, state, activity? }]
execution.activity = [{ source, time?, label, detail? }]
execution.artifacts = [{ path, label?, source: "receipt" | "audit" }]
execution.evidence = {
  receipt?, evaluator?, checks?, archon?, audit?, sources: [...]
}
execution.failures = [{ source, code?, message }]
execution.blockers = [{ source, code?, message }]
execution.retries = [{ source, count?, detail? }]
execution.raw = { argsRaw?, result? }
execution.sources = ["dsh-session", "seat-receipt", "seat-audit", "archon"]
```

Optional keys are omitted when absent; unknown facts use `null` or the explicit
`unknown` vocabulary rather than guessed defaults. The public projection is
bounded to the data needed by the panel and never exposes credentials.

## Failure and authority behavior

- A live call with no result is `running` only because the matching DSH tool
  result is absent; it is not proof that the seat is making progress.
- A result with `receipt-missing`, timeout, refusal, or a `blocked` verdict is
  shown as such, with the message and blockers visible.
- A receipt with `archon_run_id: "none"` has no Graph run. Archon fetch failure
  is shown as an unavailable Archon source, not converted to success or a fake
  graph.
- Multiple children, missing children, malformed JSON, missing audit files, and
  unavailable sessions all degrade to explicit unknown/unavailable fields.
- The route inherits the plugin's existing auth boundary and GET-only route
  pattern. The client cannot supply authority, approval, identity, or receipt
  values; it only selects a caller session and call id already present in DSH.

## Acceptance criteria

1. Expanding a real `dispatch_seat` call opens a live, source-backed inspector
   in the same tool area while the stock DSH workflow renderer remains intact.
2. The compact row never displays fabricated progress, workers, success, model,
   cost, artifacts, or activity.
3. The expanded view shows actual WM state, child sessions, receipt fields,
   Archon identity/status, failures, blockers, and artifacts when those facts
   exist, and says when they do not.
4. Raw call data remains available as a secondary disclosure.
5. The pure projector has tests for running, shipped, fix, blocked, timeout,
   receipt-missing, malformed, absent-child, and absent-Archon cases.
6. Host/client contract tests pin the route, slot key, no-duplicate-state rule,
   and no-inference vocabulary.
7. The complete frozen gate, syntax checks, and deterministic package check pass
   on one clean isolated commit.

## Roadmap after this slice

1. WM inspector vertical slice (this spec).
2. Fullscreen/deeper Archon execution view using the existing Workflows data
   and run links.
3. Shared execution-object renderers for Archon/DAG, browser, files/diff/tests,
   artifacts, evaluator/evidence, and terminal.
4. CanvasShell/CanvasPlane integration with the closed 12-primitive PanelDoc
   vocabulary, typed run-scoped bindings, hashable panel evidence, and
   summon-never-steal beacons.
5. Visual evaluator passes for the black-and-volt Creative Canvas surface,
   including failure, approval, and offline/unknown states.
