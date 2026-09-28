# Desktop product agent queue

Coordinator-owned ledger. Read the [release plan](superpowers/plans/2026-09-28-public-desktop-release.md)
and [roadmap](PUBLIC-DESKTOP-ROADMAP.md) before claiming work.

Code baseline: `ebaaf2e` on `rcos-dsh-reconcile`. Planning auditors have
finished. B1 and C1 are complete at the source-contract level; neither is
wired to the live Desktop or Canvas. See their evidence docs.

| Packet | Status | Dependencies | Owner / worktree / base / files |
| --- | --- | --- | --- |
| A1 Desktop compatibility contract | VERIFIED (source contract; runtime pending) · evidence `97c606f1402a25ba8db7f1058804ca54f1fef1f3` | none | Luna source audit + independent Luna review; `docs/DESKTOP-COMPATIBILITY.md`; 14/14 compatibility tests and `node scripts/check.js` PASS on evidence commit; installed `0.1.7-rc.2` is source-audited only, and new A2 target `0.2.0-rc.1` awaits package/runtime proof |
| B1 Capability readiness read model | DONE (source) · code `ebaaf2e`, gate `PASS` | none | 24/24 focused tests; 575/575 frozen gate on exact code commit; no UI/observation producer; see `docs/CAPABILITY-VIEW-EVIDENCE.md` |
| B1a Third-party plugin discovery contract | DONE (source audit; adapter/runtime pending) | A1, B1 | Luna source audit + independent survey reconciliation; `docs/PLUGIN-ECOSYSTEM-CONTRACT.md`; documented APIs, dataset rights limits and separate listing/host evidence types; no install or runtime edits |
| C1 Scoped execution source store | DONE (source) · code `1f73faf`, gate `PASS` | none | Gate snapshot `2097220`; no DSH/Canvas wiring; see `docs/EXECUTION-SOURCE-EVIDENCE.md` |
| A2 Packed install / setup | DONE (archive source proof; isolated boot/remove pending) · code `740bf11`, gate `PASS` 596/596 | A1 | feed re-fetched unchanged 2026-09-28; ZIP size + SHA-512 verified; asar inventory (runtime/dsh/dsh-tools `0.2.0-rc.1`, cordis `4.0.4`, node `24.18.1`); seams by string evidence; peer-range MISMATCH kept, no pin widened; active app untouched; see `docs/DESKTOP-COMPATIBILITY.md` §A2 |
| B2 Capability selection / task path | READY for observation contract and selection tests; UI proof waits P1 | A1, B1, B1a | unclaimed; P2 addendum refines this packet, not a separate owner |
| C2 Canvas import / host mount | READY for donor provenance and source adapter; mount proof pending | A1, C1 | unclaimed; serialize shared client edits; P1 supplies synthetic QA only |
| C3 Canvas interaction / visual QA | WAITING | C2 | unclaimed |
| D1 First artifact capability | WAITING | A2, B2 | unclaimed |
| D2 Code-work pack | WAITING | A1, B2 | unclaimed |
| E1 Complete journey / recovery | WAITING | C3, D1 | unclaimed |
| R1 Public audit / CI | READY for inventory only | final evidence after E1, D2 | unclaimed |
| R2 Release candidate | WAITING | A2, C3, D1, D2, E1, R1 | unclaimed |
| G1 Measured growth | WAITING | real journey evidence | unclaimed |
| K1 Offline ecosystem inventory | DONE (source) · code `adab354`, gate `PASS` 596/596 at `740bf11` | B1a | 13/13 focused tests; `scripts/plugin-inventory.mjs`, `test/plugin-inventory.test.mjs`, `docs/ecosystem/{sources.json,inventory.json,README.md}`; 13 entries, 0 conflicts, all sources honestly partial; reuse reads licensed-feed rows only |
| K2 Bounded entry review | WAITING | a K1 snapshot | unclaimed; disjoint 25-entry ranges and candidate briefs; no shared ledger edits |
| K3 Display-only discovery model | WAITING for sanitized K1 fixtures | B1a, K1 | unclaimed; `lib/plugin-discovery.js`, `test/plugin-discovery.test.mjs`; no host-observation join or install action |
| K4 One community-derived outcome pack | WAITING | reviewed K2 candidate, A1, B2, supported binding | unclaimed; exclusive `capabilities/<id>/` and focused test; D1/D2 remain existing starter packets |
| P1 Actual-component preview | CONTRACT DONE (resolver ranges pinned; rendering BLOCKED on exact bytes) · code `c0473c7`, gate `PASS` 596/596 at `740bf11` | A1 | 8/8 focused tests; preview script, fixtures and `docs/DESKTOP-VISUAL-QA.md`; loopback-only synthetic host with fail-closed guards; upstream react/react-dom `^18.2.0` recorded, exact resolution unproven — no CDN, no stub, no live-app read; no active app access |
| P3 Canvas polish (C2/C3 refinement) | WAITING | C2, P1; artifact authorization proof | same owner/claim as C3; not a second integration team |
| P4 Daily-use candidate (E1 refinement) | WAITING | A2, B2, P3, one proven D1/D2/K4 outcome | same owner/claim as E1; narrower candidate does not satisfy full E1/R2 release gates |

## Completed planning team — 2026-09-28

User requested an ecosystem-wide capability conversion plan and daily-use Desktop
polish plan, with Luna subagents. One team, base `b49559c`, in the isolated
reconcile worktree. Research and planning only in this
batch; no live app, install, provider, registry or schedule changes.

| Work | Status | Exclusive owner / files |
| --- | --- | --- |
| Marketplace/DSH source contract | SOURCE REVIEWED | `ecosystem_market_audit`; B1a document above |
| Directory coverage and candidate survey | SOURCE REVIEWED | `ecosystem_directory_survey`; `docs/PLUGIN-DISCOVERY-SURVEY.md`; 13 candidates, not a full sweep |
| Desktop UI source audit | SOURCE REVIEWED | `desktop_receipt_truth` (reused worker); `docs/DESKTOP-POLISH-AUDIT.md`; runtime/visual proof pending |
| Integrated execution plan and queue | DOCS REVIEWED | parent integrator with independent Luna review; [ecosystem and Desktop plan](superpowers/plans/2026-09-28-ecosystem-capabilities-desktop-polish.md), roadmap, product-home links and this queue |

Claims above cover this documentation batch only and are released when it is
committed. The next three independent claims are A2 source/package proof, K1
offline inventory and P1 resolver/preview preparation. P2 reuses B2; P3/P4 reuse
C3/E1 ownership. Future acceptance boxes remain unchecked. No runtime or visual
tests were run for these documentation changes.

Claim protocol:

1. Inspect active agents/tasks and git status. An old owner with unfinished work
   blocks a new team even if a heartbeat fires again.
2. Integrator records worker identity, worktree, base SHA and exclusive files in
   the row before edits. Status becomes CLAIMED, then REVIEW, then VERIFIED or
   BLOCKED with a concrete reason. READY is never a completion claim.
3. Shared entrypoints belong to the integrator. Workers submit integration diffs;
   they do not race to edit `lib/client.js`, `lib/index.js` or package metadata.
4. Completion includes exact test/evidence locations and code SHA. Release a claim
   only after work is integrated, explicitly handed off, or stopped with its diff
   preserved. Reconcile abandoned claims with the actual owner before resuming.
5. Do not mark every dependent packet READY after one unit test. Check its stated
   contract and runtime evidence dependencies. At most three workers plus the
   integrator in the current four-slot team; swap workers for review as needed.
