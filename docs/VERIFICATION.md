# Verification log

Every release must pass `node scripts/check.js` plus the manual protocol in
CONTRIBUTING.md. Torture results below are from 2026-09-14, DSH 0.1.0-rc.6,
isolated dev home.

## Torture suite (v0.5.0)

| # | Test | Result |
|---|---|---|
| T1 | Session flood: 25 rapid creates (31 total) → grid render, sort, filter, blanks toggle | PASS after fix* |
| T2 | Browser spawn/stop churn ×3 then final navigate | PASS, 1 instance |
| T3 | Parallel ops storm: 6 concurrent navigate/snapshot/click/type | PASS 6/6 ok, 1 instance |
| T4 | Multi-viewer SSE: 2 simultaneous stream clients | PASS (frames to both) |
| T5 | Heavy DOM page (~5000 nodes): snapshot caps | PASS (80 elements / 4000 chars caps hold) |
| T6 | Hard-kill orphan drill: SIGKILL host w/ browser out → restart → navigate | PASS (orphan swept, fresh start in 2.5 s, 1 instance) |
| T7 | Panel churn: 7 tabs ×2 rounds + palette open/close ×5 | PASS (0 JS errors, 0 slot-error dead cells) |

\* T1 found a real bug: the blanks-hidden filter was lost in an edit collision
and never shipped — torture caught it. Fixed in the same release.

## Standard verification protocol (every release)

1. `node scripts/check.js` — PASS.
2. Install into isolated dev home → all tabs render.
3. Feature-specific checks (browser: navigate/snapshot/click/type + live
   frames; git: status/diff/log; workflows: catalog/runs/detail or honest
   unreachable panel).
4. `dsh plugin remove` → UI reverts to stock; existing sessions intact.
