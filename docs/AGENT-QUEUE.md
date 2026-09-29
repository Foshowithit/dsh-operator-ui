# Desktop product agent queue

Coordinator-owned ledger. Read the [release plan](superpowers/plans/2026-09-28-public-desktop-release.md)
and [roadmap](PUBLIC-DESKTOP-ROADMAP.md) before claiming work.

Code baseline: `cc02ace` on `rcos-dsh-reconcile`. The first catalog pass
covered a 13-row sample only. D1 and D2 source audits found no supported
execution binding for either starter pack; both remain unavailable pending an
upstream contract. B1 and C1 remain source-contract implementations, not live
Desktop/Canvas wiring.

| Packet | Status | Dependencies | Owner / worktree / base / files |
| --- | --- | --- | --- |
| A1 Desktop compatibility contract | VERIFIED (source contract; runtime pending) · evidence `97c606f1402a25ba8db7f1058804ca54f1fef1f3` | none | Luna source audit + independent Luna review; `docs/DESKTOP-COMPATIBILITY.md`; 14/14 compatibility tests and `node scripts/check.js` PASS on evidence commit; installed `0.1.7-rc.2` is source-audited only, and new A2 target `0.2.0-rc.1` awaits package/runtime proof |
| B1 Capability readiness read model | DONE (source) · code `ebaaf2e`, gate `PASS` | none | 24/24 focused tests; 575/575 frozen gate on exact code commit; no UI/observation producer; see `docs/CAPABILITY-VIEW-EVIDENCE.md` |
| B1a Third-party plugin discovery contract | DONE (source audit; adapter/runtime pending) | A1, B1 | Luna source audit + independent survey reconciliation; `docs/PLUGIN-ECOSYSTEM-CONTRACT.md`; documented APIs, dataset rights limits and separate listing/host evidence types; no install or runtime edits |
| C1 Scoped execution source store | DONE (source) · code `1f73faf`, gate `PASS` | none | Gate snapshot `2097220`; no DSH/Canvas wiring; see `docs/EXECUTION-SOURCE-EVIDENCE.md` |
| A2 Packed install / setup | DONE (archive source proof `740bf11` gate PASS 596/596 + isolated boot/remove EXECUTED 2026-09-28) — completed by dsh-lead agent at base `f60bf81`; evidence `docs/DESKTOP-COMPATIBILITY.md` §A2 "EXECUTED", raw boot logs `~/dsh-a2-boot/` (machine-local, not committed); boot: fresh-`DSH_HOME` scratch profile, isolated userData via same-length asar name patch (pre-patch asar `cf92b07a…8ef53865` == recorded, post-patch `084abf1b…d95dcd9`), port 19388 via `cordis.patch.yml` `id: webserver`; shell HTTP 200 + auth flow + session scaffolded; session survived quit→relaunch; removal left active app's sessions (8), credentials mtime, and Electron userData mtime identical; zero leftover processes. Caveat recorded: per-file hash table 0/4 reproducible | A1 | feed re-fetched unchanged 2026-09-28; ZIP size + SHA-512 verified; asar inventory (runtime/dsh/dsh-tools `0.2.0-rc.1`, cordis `4.0.4`, node `24.18.1`); seams by string evidence; peer-range MISMATCH kept, no pin widened; active app untouched; see `docs/DESKTOP-COMPATIBILITY.md` §A2 |
| B2 Capability selection / task path | DONE (model + selection tests; UI proof waits P1) · 10/10 focused tests | A1, B1, B1a | `lib/capability-selection.js`, `test/capability-selection.test.mjs`; exact-identity resolution to archon-workflow binding; stale/changed/absent/unexecutable/ineligible all refuse with no binding or alternate; P2 addendum refines this packet, not a separate owner |
| C2 Canvas import / host mount | SOURCE ADAPTER DONE (6/6) · mount BLOCKED on donor provenance | A1, C1 | `lib/canvas-binding.js` + `test/canvas-binding.test.mjs` (pure run:/artifact: resolver, no fetching, scalars only); mount waits licensed donor bytes (untracked dirty-tree files, no reuse license, renderer unwired per seam recon); serialize shared client edits; P1 supplies synthetic QA only |
| C3 Canvas interaction / visual QA | WAITING | C2 | unclaimed |
| D1 First artifact capability | BLOCKED (source audit at `cc02ace`: current goal dispatch has no structured media input, contained file mapping, output/evidence contract or aggregate resource bound; keep `workflow: null`) | A2, B2 | `lib/goal.js` and `capabilities/audio-offline-verify/adapter/run.js`; revisit when a supported adapter contract exists |
| D2 Code-work pack | BLOCKED (source audit at `cc02ace`: current path has no bounded patch proposal, patch-specific approval or recovery contract; keep unbound) | A1, B2 | `lib/goal.js`, `lib/authority.js`, `lib/index.js`; revisit when DSH/Archon exposes an enforceable workspace allowlist and trusted diff-approval seam |
| E1 Complete journey / recovery | HEADLESS REHEARSAL DONE · live journey waits A2 boot + P1 bytes + C2 mount | C3, D1 | refusal path proven (B2 `absent-binding` on the K4 candidate, no dispatch); adapter evals + negative control green; `docs/DESKTOP-DAILY-USE.md` holds the manifest and exact next commands |
| R1 Public audit / CI | READY for inventory only | final evidence after E1, D2 | unclaimed |
| R2 Release candidate | WAITING | A2, C3, D1, D2, E1, R1 | unclaimed |
| G1 Measured growth | WAITING | real journey evidence | unclaimed |
| K1 Offline ecosystem inventory | DONE (starter sample) · code `adab354`, gate `PASS` 596/596 at `740bf11` | B1a | 13/13 focused tests; `scripts/plugin-inventory.mjs`, `test/plugin-inventory.test.mjs`, `docs/ecosystem/{sources.json,inventory.json,README.md}`; 13 entries, 0 conflicts, all sources honestly partial |
| K1b Full licensed awesome snapshot | DONE — implementation by Luna `/root/k1b_snapshot` (left uncommitted mid-task); committed by dsh session 2026-09-28 after independent verification: 15/15 focused tests, full gate `PASS` | B1a, K1 | `scripts/plugin-inventory.mjs` (`normalizeAwesomeSnapshot`), `test/plugin-inventory.test.mjs`, `docs/ecosystem/{sources.json,inventory.json,README.md,snapshots/}`; snapshot `awesome-dsh-plugin-2026-09-28.json.gz` ships as test fixture: 4,382 rows, SHA-256 `80c4bc9efbeb9a894aca4ccfc89391275449ff9b4b3b0cafaf45f4b145f218c5`; catalog metadata only (capabilities/install/stars projected out as inert) |
| K2 Bounded entry review | PARTIAL — second-worker APPROVE, validator `ok:true` for the 13-row starter sample only; full awesome snapshot awaits K1b | a K1 snapshot | `docs/ecosystem/batches/2026-09-28-batch-{a,b}.json`, 5 briefs in `docs/ecosystem/candidates/`; 4 task-pack + 1 ui-enhancement proposals, 3 host-plugin, 2 native-reuse/duplicate, 1 defer, 2 reject — all reasoned with revisit conditions; K4 lead: bounded-research |
| K3 Display-only discovery model | DONE (source) · 11/11 focused tests | B1a, K1 | `lib/plugin-discovery.js`, `test/plugin-discovery.test.mjs`; metadata-only projection, forged flags stripped, https-only links, unknown compatibility unless evidenced; no host-observation join or install action |
| K4 One community-derived outcome pack | DONE (candidate, unbound) · evals 8/8 + negative control, 3/3 focused tests | reviewed K2 candidate, A1, B2, supported binding | exclusive `capabilities/bounded-research/` (contract, adapter `246b077f…e1fd5`, evals, candidate registry entry) + `test/bounded-research-capability.test.mjs`; B2 rehearsal refuses `absent-binding` as designed; D1/D2 remain existing starter packets |
| P1 Actual-component preview | SOURCE RECONCILIATION NEEDED — upstream tag `dsh-v0.2.0-rc.1` lock resolves React/ReactDOM `18.3.1` (recorded in `docs/DESKTOP-POLISH-AUDIT.md`); local preview dependency bytes, resolver digest and browser rendering remain unproven | A1 | Existing loopback fixture host and guards at `c0473c7`; `docs/DESKTOP-VISUAL-QA.md` still says exact resolver is blocked, so reconcile that record before rendering; no live-app access |
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
