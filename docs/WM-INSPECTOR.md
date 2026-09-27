# Seat dispatch inspection

The Operator plugin registers an additive `dispatch_seat` tool card. Expand the
card to inspect the seat's reported verdict, artifact paths, evidence, blockers,
warnings, and Archon identifiers. File actions use DSH's file-opening callback;
raw call/result and the native Trajectory inspection remain available.

It also registers an additive `job_list` card on DSH's currently unclaimed
keyed tool-view entry. DSH's built-in `job_list` returns the caller's public job
snapshot array (including running and finished jobs); the card is explicit that
this is a snapshot from one result, not live state. An empty snapshot means no
jobs were visible to that caller at the time of that call. Pending, mismatched,
or malformed results never imply that no job exists. The expanded card preserves
DSH's original text result and Trajectory inspection. It displays only the public
`id`, `kind`, `label`, `status`, `detail`, `startedAt`, and `finishedAt` fields;
internal `ownerSession` and notification bookkeeping are omitted.

The host bridge uses DSH's `tools/post-execute` hook to append a versioned JSON
content block containing the canonical dispatch value and exact call id. It
preserves the original summary and tool value. Native model-visible results
therefore include additional structured content, capped at 96 KiB. Downstream
refusals or content/value replacements are preserved without appending stale
receipt data. No additional endpoint or store is introduced.

The same hook attaches the canonical `job_list` snapshot to its exact call id,
after downstream gates accept the result. Its versioned envelope contains only
the public fields above and is bounded at 96 KiB. The original text and canonical
value remain intact; the structured copy is also model-visible. No job data is
retained outside DSH's call result, and downstream refusals or replacements stay
authoritative.

The card updates through native DSH tool-block updates. A pending call says
"Awaiting result"; it does not infer worker activity or progress. A receipt's
SHIP is explicitly seat-reported, not an independent evaluation. Legacy logs,
truncated content, or results with no matching structured block remain available
as raw text and are labeled unavailable for structured inspection.

## Validation and remaining work

Run `node --test test/job-list-bridge.test.mjs test/wm-bridge.test.mjs test/wm-inspector.test.mjs test/wm-ui.test.mjs`
for call-bound job snapshots, receipt/identity/authority, and UI callback
regressions. The optional
`node scripts/wm-runtime-smoke.mjs /absolute/runtime/node_modules` uses the
installed ToolRuntime and dispatcher schema/renderer with a synthetic tool body
to verify the transport into the actual client projector. It does not launch an
agent, contact a model, or edit the runtime.

Live worker/graph inspection still requires a supported dispatch lifecycle
correlation contract and authorized source access. Browser visual review,
code-mode end-to-end transport, and an isolated real WM dispatch remain release
acceptance work; unit tests and the synthetic runtime probe do not establish
those outcomes.

The DSH profile fixture flow can create and prompt a session, but this repo has
no supported way to seed a synthetic completed `dispatch_seat` tool-result
block into that session. The receipt bridge only adds its block after the tool
actually executes. Browser review of settled cards therefore remains deferred
until a supported synthetic web-view seam exists; no web server, browser, live
install, or live dispatch was started for this review.

The current card keeps the objective separate from reported result/status
detail, distinguishes seat receipts from dispatcher outcomes and generic DSH
tool errors, and gives pending and unavailable results explicit wording. These
states are covered by the component harness, but that source-level check is not
a visual browser review.
