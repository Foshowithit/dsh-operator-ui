# P5 dispatch — GPT ruling 2026-09-22 (recovered verbatim from thread via backend-api)

P4 ACCEPTED — protocol-verified. GO P5. Commit ea68797 + 119/119 satisfy the P4 offline
integration gate. Preserve protocol-verified vs live-verified distinction.

OBJECTIVE: Make DSH Operator usable by a beginner starting from an empty workspace, using
the existing SYSTEM / WORK / INTELLIGENCE surfaces. Target flow: Create workspace → discover
workflow → inspect → import → configure → execute → verify → develop reusable capabilities.
Do not build a second control plane, marketplace, or capability-promotion mechanism.

IMPLEMENTATION REQUIREMENTS
1. Guided workspace creation through the existing P2 API. Generate safe, isolated workspace
   paths server-side. Derive ownership from the authenticated principal. Preserve authorized
   advanced configuration.
2. Wire the existing P4 marketplace API into INTELLIGENCE. Show available workflows,
   requirements, security findings, dependencies, provenance, and import status.
3. Explicit review moment for medium-severity findings. Derive the approving identity and
   timestamp server-side from the authenticated principal. Do not accept caller-supplied
   attribution as proof of approval. Preserve all existing blocking security rules.
4. Connect imported workflow records to WORK without granting automatic execution authority.
   Show the configuration and authorization requirements before execution.
5. Expose the existing RCOS candidate evaluation and promotion path. Show admission
   requirements and actual evidence. Do not convert an imported workflow into a promoted
   capability or substitute a mock promotion controller.
6. First-run example using an isolated, reproducible fixture. Label protocol simulation,
   mock execution, actual execution, and independently verified results distinctly.
7. Keep the current P3B authentication boundary. Do not expose credentials in the browser or
   introduce an authentication bypass for onboarding. Public browser sessions and network/TLS
   remain separately gated.
8. Preserve historical receipts, existing execution authority, workspace/environment scoping,
   and the established SYSTEM / WORK / INTELLIGENCE design.

REQUIRED NEGATIVE TESTS
- Unsafe workspace path or unauthorized owner.
- Cross-workspace workflow discovery and import.
- Critical/high findings or missing security evidence.
- Medium findings without valid approval.
- Installation mistaken for execution authority.
- Workflow installation mistaken for capability promotion.
- Missing model, tool, or execution adapter.
- Unsupported marketplace.
- A user-interface success state without corresponding execution evidence.

GATE
Demonstrate the beginner flow starting with an empty workspace and no pre-existing task or
conversation. Return separate results for workspace provisioning, discovery, inspection,
import, execution authorization, execution verification, and capability admission.
If the isolated environment cannot execute a real Archon workflow or a real RCOS promotion,
mark those portions UNVERIFIED rather than substituting a simulated success.
Run the full test suite and contract checks. Preserve worktree isolation.
Do not modify the production execution host, change vNext, upgrade production Archon, publish code,
expose Operator publicly, or provision paid Solari infrastructure.
Return the P5 implementation receipt, executed tests, and the exact remaining blockers for
the first real cloud-based beginner session.

C-decisions (abridged): C1 server-generated paths beneath configured root, principal-derived
owner, advanced path kept; C2 marketplace UI with actionable unsupported state; C3 medium
review screen, server-derived by/at; C4 show installed→executed→verified→admitted ladder via
existing promotion interface; C5 reproducible offline fixture demo, clearly labeled.
Browser auth: build/test in isolated env with server-side auth; no long-lived bearer token in
browser; public browser auth separately gated.
