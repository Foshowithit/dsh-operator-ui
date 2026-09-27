# Seat dispatch inspection

The Operator plugin registers an additive `dispatch_seat` tool card. Expand the
card to inspect the seat's reported verdict, artifact paths, evidence, blockers,
warnings, and Archon identifiers. File actions use DSH's file-opening callback;
raw call/result and the native Trajectory inspection remain available.

The host bridge uses DSH's `tools/post-execute` hook to append a versioned JSON
content block containing the canonical dispatch value and exact call id. It
preserves the original summary and tool value. Native model-visible results
therefore include additional structured content, capped at 96 KiB. Downstream
refusals or content/value replacements are preserved without appending stale
receipt data. No additional endpoint or store is introduced.

The card updates through native DSH tool-block updates. A pending call says
"Awaiting result"; it does not infer worker activity or progress. A receipt's
SHIP is explicitly seat-reported, not an independent evaluation. Legacy logs,
truncated content, or results with no matching structured block remain available
as raw text and are labeled unavailable for structured inspection.

## Validation and remaining work

Run `node --test test/wm-bridge.test.mjs test/wm-inspector.test.mjs test/wm-ui.test.mjs`
for receipt/identity/authority and UI callback regressions. The optional
`node scripts/wm-runtime-smoke.mjs /absolute/runtime/node_modules` uses the
installed ToolRuntime and dispatcher schema/renderer with a synthetic tool body
to verify the transport into the actual client projector. It does not launch an
agent, contact a model, or edit the runtime.

Live worker/graph inspection still requires a supported dispatch lifecycle
correlation contract and authorized source access. Browser visual review,
code-mode end-to-end transport, and an isolated real WM dispatch remain release
acceptance work; unit tests and the synthetic runtime probe do not establish
those outcomes.
