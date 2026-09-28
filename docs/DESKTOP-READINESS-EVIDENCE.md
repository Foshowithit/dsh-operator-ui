# Desktop readiness evidence

2026-09-28. Code tested: `4a4cb1acede461ef11a8f6691962346ea75f3f79`.

## Change

The npm file inventory now includes `system-manifest.json`, which verification
reads at package root. The new archive test reads that manifest and both seed
assets from a real `npm pack --ignore-scripts` tarball.

System/activation headlines and the navigation badge now distinguish a valid
receipt seal from `receipt.levels.achieved`. Only a current `RCOS_VERIFIED`
receipt claims core execution; system-only, missing, stale and tampered cases
keep their limits. Missing/invalid timestamps do not produce a NaN age. Failure
codes remain literal text values rendered through React text children.

`DESKTOP.md` designates this repository as the central product development home.
It does not claim other repositories were migrated or the product released.

## Verification performed

| Check | Result | Scope |
| --- | --- | --- |
| Focused package, receipt UI and WM UI tests | 21/21 pass | Working source subsequently committed as the code above |
| `node scripts/check.js` | PASS | Contract and tracked-file hygiene |
| `node --test test/*.test.mjs` | 525/525 pass | Direct top-level suite; not the full canonical set |
| `node scripts/gate.mjs --out <receipt>` | PASS, 539/539 | Frozen snapshot of exact code commit; 49 named entrypoints |
| Independent Luna diff review | No remaining blocker | Actual `levels.achieved` producer shape, claims and packaging |

Gate input: 1,648 tracked files; 840 directories; read-only lock probes refused
both writes. Snapshot/set hashes remained unchanged. Gate source identity:
`9f72d22017797630955adb384d875aa81d1d0f745b6e984658ca3c47d188493a`.
The raw local receipt is named `rcos-desktop-readiness-gate.json`; it remains
outside the repository because it contains local environment paths.

The gate locks tracked source. Its dependency tree is an unhashed environment
input, as disclosed by the gate. This is not a fully hermetic execution claim.

## Limits

No current Desktop compatibility certification, installed-profile smoke,
browser visual QA, provider call, live WM/job dispatch, canonical registry
change, service restart, publication or promotion was performed for this slice.
The archive test is not a deterministic two-build certification; that release
check remains separate. UI projection tests use a lightweight ModuleLoader
harness and do not establish visual appearance.

Later roadmap/queue documentation does not inherit this test identity. Code
results above belong to the exact code commit only.
