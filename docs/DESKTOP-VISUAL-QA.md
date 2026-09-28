# Desktop visual QA — synthetic preview status (P1)

Fixture-host preparation only. Nothing here claims a working Desktop
install, a rendered plugin, or visual acceptance. The exact A2 host tuple
is additionally required for any Desktop compatibility claim.

## Resolver contract (checked 2026-09-28)

| Item | Evidence | Status |
| --- | --- | --- |
| Upstream React range | `apps/desktop/package.json` at tag `dsh-v0.2.0-rc.1` declares `react: ^18.2.0` (desktop-shell devDependency) | Declared range only — exact resolved bytes not read |
| Upstream ReactDOM range | Same file declares `react-dom: ^18.2.0` | Declared range only |
| Upstream type pins | Same file declares `@types/react: ~18.3.1`, `@types/react-dom: ~18.3.0` | Type pins, not runtime proof |
| ModuleLoader require mapping | `lib/client.js` calls `require('react')` only; seeded external in host loader shape | Source-confirmed in this repo |
| Local archive React package | Installed `0.1.7-rc.2` archive probed read-only: no standalone `react/package.json` found (client React is bundled, not shipped as a separate package) | Exact local bytes unproven |
| Upstream lockfile resolution | Not read in this pass | Exact upstream bytes unproven |

**Result: rendering stays BLOCKED.** No guessed CDN, no VM stub, and no
live-app read was used as a resolver. When the exact React/ReactDOM
versions plus source digest are pinned from the target host source,
record them here with license and byte identity, then flip
`checkResolverProof` inputs — not the gate itself.

## What the harness does today

`node scripts/preview-operator.mjs --port <unused-port>` starts a
loopback-only fixture server (fails closed on non-loopback hosts, held
ports, bad args, or absent fixtures). Every route carries the visible
`Synthetic preview` banner; `/status` reports the resolver as blocked,
`liveDispatch: false`, `toolExecution: false`, `profileWrites: false`.
Stop the owned process after QA; it never kills another listener.

Canned fixtures live in `test/fixtures/operator-preview/`:

- `states.json` — outcome matrix: missing, pending, refused, failed,
  unknown-outcome, reported-success, independently-verified, stale,
  tampered.
- `wm-card-compact.json` / `wm-card-expanded.json` — card layouts with
  long-title and long-error stress strings.

Guards are tested in `test/operator-preview.test.mjs` (traversal-safe
fixture selection, loopback binding, port validation, resolver gate,
banner presence, fail-closed absence).

## Acceptance still pending (unchecked)

Actual browser rendering of the real factory and registered components
without dispatch (preferred patterns: `test/wm-ui.test.mjs`,
`test/system-receipt-ui.test.mjs` — no second copy of the production UI);
captures at widths 390, 768, 1440 px; light/dark; 200% text;
keyboard-only; long titles/errors; reduced motion — each with exact
code/host/fixture identity. Synthetic QA never replaces A2 Desktop
mounting.
