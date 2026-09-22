# P6B v2 — offline execution specification

Status: **offline candidate only**. This specification governs the OFFLINE
verification battery for the v2 candidate package. It authorizes no live
sandbox, no paid cloud execution, no production modification, no vNext change,
no public push, publication, or production capability promotion. P6C and P6D
remain separate gates.

## Package identity

- package: `rcos-kernel-subset-v2` (see `PACKAGE-IDENTITY.json` inside the root)
- version: `0.2.0-candidate.1`
- source revision: worktree `9bd484999fd2d4b23d2141bd45ccb85559b37488` + uncommitted candidate changes
- manifest (independently pinned, OUTSIDE the package root):
  `p6b/rcos-kernel-subset-v2.manifest.sha256`
- evaluation identities (both NEW):
  - `reuse-ledger-invariant-v2` — schema rcos-eval/2, invocation-kernel path
  - `execution-posture-v1` — schema rcos-eval/1, private posture reporter
- The historical `reuse-ledger-invariant-v1` evaluation, the original package
  (`p6b/rcos-kernel-subset/`), and its Run #1 / Run #2 artifacts remain
  untouched and independently identifiable. This package never replaces them.

## Guarantees under test (kept separate, per ruling)

1. **Repair A — privilege-independent append-failure invariant**
   (eval `reuse-ledger-invariant-v2`): the capability adapter moves the trace
   log aside and puts a directory at its path; the real `rcos reuse-log` is
   refused at `open(2)` with `EISDIR` for every uid (root bypasses DAC mode
   bits, not file-type checks); the trace log and registry must be
   byte-identical and no trace row for the blocked task may appear; the child
   stderr must name `EISDIR`. `lib/traces.js` is byte-identical to v1 — no
   production bypass exists; the fixture lives only in eval-owned adapter code
   and cannot be activated by a model, workflow input, or untrusted caller in
   normal production execution. The gate does NOT accept root's chmod-bypass
   behavior as success.
2. **Repair B — execution-isolation posture** (eval `execution-posture-v1`):
   the runtime reports effective uid/gid plus stated restrictions and what the
   posture does NOT establish; the declared `non-root` requirement is evaluated
   against live identity; a root runtime refuses with the explicit result
   `environment-incompatibility` (gate exit 4 → verdict blocked, reason in
   checks.json), never a silent pass; a `complete-sandbox` claim is refused
   even for a non-root posture, as is any unknown requirement. A non-root uid
   alone is never treated as a complete sandbox boundary.

## Battery matrix (offline, isolated VM, two separate tree copies)

Guard form (`RCOS_HOME` must equal the guard's own env and the root; manifest
flag is mandatory — the guard's default manifest is the v1 one):

```sh
RCOS_HOME=$ROOT node <host>/p6b/run-isolated.cjs --root $ROOT \
  --manifest <host>/p6b/rcos-kernel-subset-v2.manifest.sha256 \
  -- node $ROOT/bin/rcos eval-run --eval <eval-id>
```

| # | tree uid | eval | expected |
|---|----------|------|----------|
| 1 | 501 (user) | `reuse-ledger-invariant-v2` | ship, 4/4 gates, exit 0 |
| 2 | 0 (root) | `reuse-ledger-invariant-v2` | **ship, 4/4 gates, exit 0 — headline: privilege-independent** |
| 3 | 501 (user) | `execution-posture-v1` | ship, 4/4, exit 0 (live non-root requirement met) |
| 4 | 0 (root) | `execution-posture-v1` | blocked, exit 4; gate `live_non_root_requirement` stderr names `environment-incompatibility`; gates 1–3 still pass |

After every run: `node $ROOT/bin/rcos eval-verify --run <run-id>` → exit 0.
Guard `--check-only` runs before and after each uid's batch (manifest +
stray-file rule: run artifacts only under `runs/`, `invocations/`,
`eligibility/`, `traces/`, `evidence-records/`).

**Negative controls** (deliberate invariant violations; disposable COPIES in
`/tmp` only — the original run dirs stay immutable; gates run read-only):

- **NC1 — gate must fail on real mutation**: copy a shipped run's invocation
  dir to `/tmp`, tamper `output.json`'s fault-step `registry_sha256` to zeros,
  run gate `append_failure_leaves_registry_untouched` with
  `RCOS_INVOCATION_DIR=<copy>` → **exit 3** ("registry mutated").
- **NC2 — evidence contradiction overrides every gate**: in another copy append
  one valid extra row to `evidence/traces.jsonl` → **every** gate exits 3 with
  "the observation contradicts its own evidence".

**Runner v-next** (host, synthetic dirs): `node --test p6b/runner-vnext/runner-vnext.test.mjs`
→ **10/10**, covering the evidence-first sequence, partial-success retrieval
(receipt present + `checks.json` missing → receipt preserved, classification
carries `diagnostics_missing: ["checks.json"]`), and unconditional cleanup.

**Host hygiene**: `node --check` on every JS file in the v2 tree; JSON parse
of every JSON; `scripts/check.js` tracked-file gate; content grep for the three
forbidden literals across the whole new tree/evidence (no production-host
names, no private path literals, no credentials); no AppleDouble / `.DS_Store`
sidecars.

## Readiness assessment (returned for review — not a promotion)

- Battery outcomes, verbatim: receipts + `checks.json` + guard outputs +
  negative-control exits, pulled back OUTSIDE the package root into
  `p6b/offline-evidence-v2/`.
- An explicit statement of what this does NOT establish: no live validation,
  no host certification, no production readiness, no Solari contact of any
  kind. The next milestone after review would be a separately authorized live
  validation — not taken here.
