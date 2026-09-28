# Capability readiness view evidence

This records packet B1's source-only readiness projector. The tested code
commit is `ebaaf2e70ce1243730f654f7335611ab7c22b864` on
`rcos-dsh-reconcile`.

## What was checked

- `node --test test/capability-view.test.mjs` — PASS, 24/24.
- `node scripts/check.js` — PASS.
- `node scripts/gate.mjs --out <outside-repo-receipt>` — PASS on the exact
  code commit above: 575/575 tests, 51 named test entrypoints, 1,659 tracked
  files locked, 840 directories locked, and both write probes refused.
- The frozen snapshot hash was identical before and after the gate:
  `d3b4c67558827d291eb042d9ca575006afd4b1cb5c691415bf3b231fc29ac42a`.
  The gate recorded no changed test inputs and no Git working-tree changes.
- An independent read-only Luna review found no blocker, including on the
  final duplicate-ID refusal case.

## Scope and limits

The projector in `lib/capability-view.js` accepts only the source-observed
`registry_version: "v1"` envelope and explicit host observations. It does not
perform I/O, change routing, add a route/store/poller, or mutate the registry.
The exact contract is in `CAPABILITY-VIEW-CONTRACT.md`.

This commit does not wire the projection to the capability UI and supplies no
installed-artifact, independent-verification, current Archon, runtime, or
authority observation producer. The pure module cannot authenticate or prove
the freshness/context of observations; an eventual host producer must pass
`unknown` when that evidence cannot be established. No DSH installation,
Desktop visual QA, provider/service change, live task or workflow dispatch, or
capability execution was performed. Package, live-runtime, and visual
acceptance remain open.
