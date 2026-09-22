# P4 — Archon marketplace integration (design)

Date: 2026-09-22 · Branch: rcos-cloud-path-v1 (isolated worktree) · Predecessor: P3B (`952e051`)

GPT work order: make Archon's existing workflow marketplace discoverable and usable
through DSH Operator's INTELLIGENCE surface — feature-detect, authenticated and
workspace-scoped, with a fail-closed security policy and STRICT promotion isolation.
No second control plane, no competing marketplace, no vNext contract change.

## Ground truth (verified before designing)

- Archon 0.x (docs current to v0.10.1) ships **no marketplace REST**. `marketplace`
  in the official reference is skills.sh (Claude-native skills), and
  `archon workflow install <slug>` is a roadmap item. Therefore the ONLY honest
  integration is **feature detection against the documented `GET /api/openapi.json`**,
  with an explicit unavailable state when the namespace is absent. Production Dell
  (v0.10.x) will report *unavailable* and remain fully operational — which is exactly
  the older-install compatibility the order demands.
- Promotion = a registry entry (`status: 'promoted'`) written by
  `teach.js promoteCandidate` after an explicit operator click on a CANDIDATE
  teaching task. Installation (workflow YAML present in a watched workflows dir) is a
  different act with different authority. P4 must not blur them.
- P3B established the authenticated boundary: the GIT_ROUTE prefix chokepoint
  authenticates BEFORE dispatch, `req.auth` carries the decision, and
  `ownerForRequest` / `environmentAllowedForPrincipal` /
  `taskAuthorizedForPrincipal` (lib/auth.js) are the authorization vocabulary.
  Any new route under the prefix inherits the boundary — the P3B unauthenticated
  sweep already proves a never-registered subpath gets 401 before 404.

## The five states (structurally separate — GPT condition 2)

```
discovered  →  installed  →  execution-eligible  →  execution-verified  →  promoted
 (search)      (P4 import)   (existing gated        (existing verify/       (existing
                             execution verbs ONLY)  acquire evidence ONLY)  promoteCandidate
                                                                            click ONLY)
```

P4 implements **discovery, inspection, and installation** (the first arrow) and
*records* the other three as separately-gated states it cannot confer. An import
record is NOT a teaching task: it structurally cannot enter `promoteCandidate`
(that path requires a CANDIDATE teaching envelope), and P4 never writes the
capability registry. The ledger says so on every record.

## Feature detection

`detectMarketplaceSupport(archon)` fetches `GET {archon.baseUrl}/api/openapi.json`
(the documented discovery endpoint, present on real installs) and looks for an
`/api/marketplace/` namespace in `paths`. Results:

- namespace present → `{ supported: true, paths }`
- 404, no namespace, unreachable, timeout → `{ supported: false, reason, hint }`

Detection failure NEVER throws to the client and NEVER changes any other op.
`?op=marketplace-status` reports the verdict verbatim with an actionable hint.

## Scoping (authenticated, workspace-scoped)

Marketplace entries carry `visibility` (`public` | `private`) and `owner`.

- **Search**: private entries are filtered out unless the authenticated principal's
  owner set includes the entry owner. Dev mode (no principal) sees public only —
  fail-closed, not fail-open.
- **Inspect**: a private entry owned by someone else refuses
  `marketplace-entry-forbidden` (403) — filtering alone would leak existence.
- **Import**: runs the full P3B authorization ladder BEFORE any Archon contact:
  `ownerForRequest` → `owner-impersonation-refused`; workspace resolution +
  `environmentAllowedForPrincipal` → `workspace-not-found` /
  `cross-workspace-refused` / `environment-unauthorized`. Zero mock write-counter
  deltas on every refusal.

## The import ladder (fail-closed; order is the contract)

1. Install target configured (`marketplace.workflowsDir`) → else
   `marketplace-target-not-configured` (400).
2. Authorization ladder above (403s; no Archon contact yet).
3. Feature detect → `marketplace-unsupported` (409).
4. Fetch entry detail → `marketplace-entry-not-found`; visibility →
   `marketplace-entry-forbidden`.
5. Pin: entry must declare `revision` AND `digest` → else `source-unpinned`.
   Requested revision ≠ pinned → `revision-mismatch`.
6. Fetch source at the pinned revision; `sha256(bytes) ≠ entry.digest` →
   `source-tampered`. Fetch failure → `marketplace-unreachable`.
7. Security policy — evaluated against the entry's `securityReview` evidence:
   - missing review, or `status !== 'complete'`, or no findings array →
     `security-evidence-incomplete` (403; failed/missing/incomplete fail closed)
   - evidence `kind: 'ai-review'` only → `security-evidence-insufficient`
     (an AI review alone is not proof of safety)
   - any `critical`/`high` finding → `security-blocking-findings` (403; hard block)
   - any `medium` finding without an explicit human approval in the request →
     `security-approval-required` (403); with approval, the approval is RECORDED
     (who/when/what was approved) in the ledger
   - `low` findings are recorded and block nothing — but waive nothing either:
     steps 5, 6, 8 still run
8. Own deterministic static pass on the DOWNLOADED bytes (never trusted from the
   marketplace): forbidden network/privilege/destructive/credential patterns,
   workspace-escape writes, `name:`/`nodes:` presence → `market-static-forbidden`.
9. Admission guard: if the capability registry is configured and already contains
   an entry whose id or workflow name collides → `capability-name-collision`
   (an import must never shadow a certified capability). Registry configured but
   unreadable → `registry-unreadable` (fail closed).
10. Idempotency: same entryId+revision already installed for this owner →
    `already-installed`.
11. ONLY NOW two local writes: the YAML into `marketplace.workflowsDir/<name>.yaml`,
    and an import record appended to `$DSH_HOME/operator-ui/marketplace.json`
    (atomic temp+rename, same discipline as tasks.json).

Refusals are transport-shaped `{ok:false, error, code}` with the P3B status
conventions, and leave the ledger, the workflows dir, the registry, and the mock's
write counters byte-identical.

## Ledger record (the distinct-state receipt)

```json
{
  "importId": "mkt_…",
  "entryId": "…", "entryName": "…", "publisher": "…",
  "revision": "…", "digest": "sha256:…",
  "owner": "…", "workspaceId": "…", "environmentId": "…",
  "importedAt": "…", "installedAs": "<name>.yaml",
  "security": { "kind": "static-scan", "status": "complete",
                "counts": { "critical": 0, "high": 0, "medium": 1, "low": 2 } },
  "approval": { "acknowledged": true, "by": "svc-alice", "at": "…" },
  "states": { "installed": "…" },
  "executionEligible": false,
  "executionVerified": false,
  "promotion": { "admitted": false,
                 "authority": "registry-promotion-only (teach.promoteCandidate)",
                 "reason": "marketplace installation is not capability admission" }
}
```

`executionEligible`/`executionVerified`/`promotion.admitted` are FOR A PURPOSE:
they can only ever be flipped by the EXISTING gated paths (execution config flag,
verify/acquire evidence, promoteCandidate), none of which P4 touches. P4 adds no
new execution route and no new promotion route.

## Mock marketplace (opt-in, sandbox-only)

`scripts/mock-archon.mjs` grows a marketplace namespace **only when
`MOCK_MARKETPLACE=1`** (the default stays exactly today's mock, so every existing
consumer and the unsupported-detection case ride the unmodified surface):

- `GET /api/openapi.json` advertising the marketplace paths (404 when disabled)
- `GET /api/marketplace/search?q=` — seeded entries
- `GET /api/marketplace/entries/:id` — detail incl. securityReview
- `GET /api/marketplace/entries/:id/source?revision=` — raw YAML + `x-content-digest`

Seeded negatives: `medium-finding`, `critical-finding`, `ai-only`, `no-scan`,
`unpinned`, `tampered` (served bytes ≠ advertised digest), `private-alice`
(visibility private, owner alice), `registry-shadow` (collides with a registry
capability), and `clean` (imports successfully). One more entry advertises a CLEAN
scan but its YAML actually contains `curl` — proving step 8 never trusts the
marketplace's own verdict. `/api/_mock/calls` gains `marketplaceGets` (a read
counter, allowed to move) alongside the write counters the zero-side-effect
assertions pin at zero.

## Verification honesty (GPT gate)

No marketplace-capable Archon exists to authorize against the production Dell, so
the live-import claim is labeled **protocol-verified** (full flow exercised against
the isolated compatible mock): never "live-verified". Real-host behavior for
v0.10.x is additionally covered by the unsupported-detection leg against the
UNMODIFIED default mock surface.

## Test inventory (test/marketplace-negative.test.mjs + marketplace-case.mjs)

- UNIT: security-policy matrix · static-check matrix · scoping filter.
- E2E (required mode, real listener, real config file, real mock):
  unsupported detection + older-install ops unchanged · status/search/inspect ·
  private-entry refusal · the full refusal ladder (each with zero write deltas)
  · the one happy-path import (receipt + ledger + YAML + registry untouched)
  · promotion isolation (import ≠ teaching task; registry byte-identical) ·
  installations owner-scoping · unauthenticated 401 sweep of the new route.
