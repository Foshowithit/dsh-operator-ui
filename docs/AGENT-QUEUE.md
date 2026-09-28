# Desktop product agent queue

Coordinator-owned ledger. Read the [release plan](superpowers/plans/2026-09-28-public-desktop-release.md)
and [roadmap](PUBLIC-DESKTOP-ROADMAP.md) before claiming work.

Code baseline: `4a4cb1a` on `rcos-dsh-reconcile`. Planning auditors have
finished and do not own implementation files. The C1 team below is active.

| Packet | Status | Dependencies | Owner / worktree / base / files |
| --- | --- | --- | --- |
| A1 Desktop compatibility contract | READY | none | unclaimed |
| B1 Capability readiness read model | READY | none | unclaimed |
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
