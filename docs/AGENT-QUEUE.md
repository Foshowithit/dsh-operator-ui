# Desktop product agent queue

Coordinator-owned ledger. Read the [release plan](superpowers/plans/2026-09-28-public-desktop-release.md)
and [roadmap](PUBLIC-DESKTOP-ROADMAP.md) before claiming work.

Code baseline: `ebaaf2e` on `rcos-dsh-reconcile`. Planning auditors have
finished. B1 and C1 are complete at the source-contract level; neither is
wired to the live Desktop or Canvas. See their evidence docs.

| Packet | Status | Dependencies | Owner / worktree / base / files |
| --- | --- | --- | --- |
| A1 Desktop compatibility contract | VERIFIED (source contract; runtime pending) · evidence `97c606f1402a25ba8db7f1058804ca54f1fef1f3` | none | Luna source audit + independent Luna review; `docs/DESKTOP-COMPATIBILITY.md`; 14/14 compatibility tests and `node scripts/check.js` PASS on evidence commit; local Desktop `0.1.7-rc.2` remains an A2 candidate only, with no install/render/dispatch proof |
| B1 Capability readiness read model | DONE (source) · code `ebaaf2e`, gate `PASS` | none | 24/24 focused tests; 575/575 frozen gate on exact code commit; no UI/observation producer; see `docs/CAPABILITY-VIEW-EVIDENCE.md` |
| C1 Scoped execution source store | DONE (source) · code `1f73faf`, gate `PASS` | none | Gate snapshot `2097220`; no DSH/Canvas wiring; see `docs/EXECUTION-SOURCE-EVIDENCE.md` |
| A2 Packed install / setup | WAITING | A1 | unclaimed |
| B2 Capability selection / task path | WAITING | A1, B1 | unclaimed |
| C2 Canvas import / host mount | WAITING | A1, C1 | unclaimed |
| C3 Canvas interaction / visual QA | WAITING | C2 | unclaimed |
| D1 First artifact capability | WAITING | A2, B2 | unclaimed |
| D2 Code-work pack | WAITING | A1, B2 | unclaimed |
| E1 Complete journey / recovery | WAITING | C3, D1 | unclaimed |
| R1 Public audit / CI | READY for inventory only | final evidence after E1, D2 | unclaimed |
| R2 Release candidate | WAITING | A2, C3, D1, D2, E1, R1 | unclaimed |
| G1 Measured growth | WAITING | real journey evidence | unclaimed |

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
