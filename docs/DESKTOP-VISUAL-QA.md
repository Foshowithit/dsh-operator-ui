# Desktop visual QA — synthetic preview status (P1)

Fixture-host preparation only. Nothing here claims a working Desktop
install, a rendered plugin, or visual acceptance. The exact A2 host tuple
is additionally required for any Desktop compatibility claim.

## Resolver contract (proven 2026-09-28 evening — P1 bytes pinned)

| Item | Evidence | Status |
| --- | --- | --- |
| Upstream React range | `apps/desktop/package.json` at tag `dsh-v0.2.0-rc.1` declares `react: ^18.2.0` (desktop-shell devDependency) | Declared range (historical record) |
| Upstream lock resolution | `docs/DESKTOP-POLISH-AUDIT.md` — tag `dsh-v0.2.0-rc.1` resolves React/ReactDOM `18.3.1` | Recorded |
| Host bundle bytes (target 0.2.0-rc.1) | `dsh-web-frontend@0.2.0-rc.1` `dist/assets/index-Dy0OhsZ5.js`, 631,135 B, sha256 `d1f25447623f5c8324c7e2169c28729c8b587162d38c7a51594759e027998cd5`, react `version:"18.3.1"` marker in-bundle (probed read-only from the staged app's `app.asar`) | **Exact host bytes proven** |
| Host bundle bytes (installed 0.1.7-rc.2) | same package, `index-Q6zc2uHV.js`, sha256 `1f47db2d59dd8f6695cc0fe1277ef9b09ab613288c500d5ba63956f36f02e7fd`, react `version:"18.3.1"` marker | **Exact host bytes proven** |
| ModuleLoader require mapping | `lib/client.js` calls `require('react')` only (single `require(` in the factory); seeded external in host loader shape | Source-confirmed + exercised in the render harness |
| Local preview bytes | `react@18.3.1` + `react-dom@18.3.1` installed exact; UMD production digests pinned in `scripts/resolver-proof.json` (`d949f1c3…` / `35f4f974…`); the `/vendor/*` route re-hashes before serving and REFUSES on mismatch | **Exact local bytes proven, fail-closed** |

**Result: rendering UNBLOCKED (2026-09-28 evening).** The exact
React/ReactDOM identity (18.3.1) is triangulated three ways — upstream lock
record, staged 0.2.0-rc.1 host bundle bytes, installed 0.1.7-rc.2 host bundle
bytes — with per-host sha256 in `scripts/resolver-proof.json`.
`checkResolverProof` inputs were flipped to the real values (the gate's
semantics were not changed). The real factory (`lib/client.js`) now renders
in a real browser on the pinned bytes: harness `/render` captures the four
components the factory registers (`dispatch_seat`, `job_list`,
`conversation.view`, `shell.overlay`) and mounts two tool cards and the full capability registry tab with canned
versioned receipts and a canned registry — no dispatch, no CDN, no host
session. All 14 registered components are captured by the harness
(`job_list`, `dispatch_seat`, `runs`, `opui-palette`, `git`, `browser`,
`summary`, `files`, `workflows`, `capabilities`, `system`, `work`,
`intelligence`, `opui-gate`). Evidence:
`DESKTOP-VISUAL-QA-render-proof.png` (this directory; sha256
`6748c9e76e3f1407d9da0954d6090f5238eadd13b554096b7dbd41518c59010e`).
This render is also the B2 UI proof: the real `CapabilitiesTab` shows
promoted / candidate-at-gate / retired states from the canned registry
(`rcos-registry.json`) served same-origin by the preview server.

## What the harness does today

`node scripts/preview-operator.mjs --port <unused-port>` starts a
loopback-only fixture server (fails closed on non-loopback hosts, held
ports, bad args, or absent fixtures). Every JSON route carries the visible
`Synthetic preview` banner; `/status` reports the resolver as ready with the
pinned digest, `liveDispatch: false`, `toolExecution: false`,
`profileWrites: false`. The CLI loads `scripts/resolver-proof.json`;
without it the gate stays blocked and `/render` stays down. The `/vendor/*`
routes re-hash the local React UMD bytes against the proof and refuse
mismatches. Stop the owned process after QA; it never kills another listener.

Canned fixtures live in `test/fixtures/operator-preview/`:

- `states.json` — outcome matrix: missing, pending, refused, failed,
  unknown-outcome, reported-success, independently-verified, stale,
  tampered.
- `wm-card-compact.json` / `wm-card-expanded.json` — card layouts with
  long-title and long-error stress strings.
- `render.html` — the P1 render harness (loads pinned vendor bytes +
  the real factory, mounts canned versioned receipts, sets
  `window.__P1_RENDERED__`).

Guards are tested in `test/operator-preview.test.mjs` (traversal-safe
fixture selection, loopback binding, port validation, resolver gate,
banner presence, fail-closed absence).

## Acceptance still pending (unchecked)

Actual browser rendering of the real factory and registered components
**without dispatch is now PROVEN** (see resolver result above). Remaining
from the original list: captures at widths 390, 768, 1440 px; light/dark;
200% text; keyboard-only; long titles/errors; reduced motion — each with
exact code/host/fixture identity. Synthetic QA never replaces A2 Desktop
mounting.
