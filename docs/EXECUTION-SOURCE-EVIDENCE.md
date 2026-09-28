# Execution source store evidence

2026-09-28 · Source-only C1 packet. Implementation: `1f73fafe95e3c5169b93a3d02ad2dde9857a6fec`.

## Behavior delivered

The pure `createExecutionSourceStore()` keeps a selected tool observation with
its exact workspace, session, call and tool identity. New selections invalidate
late results, including a second selection of the same call. It accepts only
bounded, tool-specific scalar projections, copies/freezes snapshots, and makes
missing or malformed observations explicitly unavailable. Settled WM dispatcher
failures retain dispatcher state without inventing a seat receipt verdict.
Job-list snapshots cannot claim a run ID, worker stream or live state.

The [contract](EXECUTION-SOURCE-CONTRACT.md) documents the normalized shapes,
phase rules, field allowlists, bounds and identity limits. The store does not
read from DSH, prove a source, authorize access, create run/artifact bindings or
change the PanelDoc vocabulary. No DSH adapter or Canvas mount consumes this
module yet; those belong to C2 after the current Desktop contract is established.

## Verification

| Check | Result | Scope |
| --- | --- | --- |
| `node --test test/execution-source.test.mjs` | 12/12 pass | Exact context matching, generations, refusal cases, state/phase consistency, immutable snapshots, disposal and hidden-field rejection |
| Independent Luna review | No remaining material findings | Three review findings addressed; dispatcher verdict reconciled with the actual projector |
| `node scripts/check.js` | PASS | Host module graph loads with 36 modules; repository contracts and hygiene |
| `node scripts/gate.mjs --out <receipt>` | PASS, 551/551 | Frozen snapshot at docs queue commit `2097220b611ff04616e6bfcc3d16c435ace84a7e`; 50 named entrypoints |

The gate locked 1,655 tracked files and 840 directories read-only; both lock
probes refused writes. Snapshot tree `bca6ad87577b4eb00b131eb19fd3583be9466f60f4c906d1a7f0c5f60dd835a0`
and the 50-file test set remained unchanged. The only commit after the C1 code
commit was the queue-status documentation commit; the tested code bytes are the
same `1f73faf` implementation above.

## Limits

This establishes source tests and host contract loading only. It does not prove
current Desktop compatibility, a running DSH-to-Canvas binding, visual behavior,
live job status, a WM dispatch, installed-profile behavior or independent source
authorization. The module currently has no runtime consumer.
