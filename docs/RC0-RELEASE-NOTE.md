# RC0 Release Note — dsh-operator-ui real-stack proof (2026-09-15)

RC0 is a REAL-STACK PROOF round: no product features. It proves the exact
verification path that passed against the sandbox mock against a fresh, real
Archon v0.10.1 deployment, with zero private deployment knowledge and zero
credentials.

## What was proven (one evidence packet)

A stranger following only tracked public artifacts can bring up the
known-good stack and cause the normal registry-routed execution path to
produce a real Archon execution and a valid, sealed genesis receipt:

- Fresh sandboxed real Archon **v0.10.1** (official public installer,
  `ARCHON_HOME` + `PORT` overrides, sqlite, no DB server) — the COMPAT pin,
  installed and served with no private config.
- Clean plugin tree (commit `4af0907`, `git archive` — no dev cache, no
  node_modules, no private files) + fresh `DSH_HOME` + one portable config
  file. Real DSH `0.1.0-rc.6`.
- `POST /plugins/operator-ui/verify` → **RCOS_VERIFIED**: routed through the
  configured registry (seeded capability `rcos-verify-echo`), dispatched on
  the real Archon run API, real run (UUID id), evidence sealed with
  `execution.executionAdapter: "archon@0.10.1"`.
- Negative gates on the real stack: break the adapter → certification REFUSED
  (`SYSTEM_VERIFIED`, `archon-unavailable`); restore → RCOS_VERIFIED
  reissued; tamper with the sealed receipt → TAMPERED; full process restart →
  receipt survives VALID, re-verification issues a NEW real run.
- Matrix: **9/9 cases PASS** (`/tmp/opui-rc0-evidence/matrix-rc0-run2.log`);
  mock regression after the contract fixes: **11/11** (slice-2 matrix).

## Real-stack mismatches found and fixed at the root (commit 4af0907)

Per the RC0 classification: wrong mock / wrong API assumptions — the verify
path itself gained no special cases.

1. **Catalog shape**: real v0.10.x wraps catalog entries as
   `{workflow:{…}}` — the mock had flattened them. Fixed by normalizing once
   at the boundary (`unwrapCatalog` shared by the /status identity probe and
   the Workflows proxy); mock corrected to mirror reality.
2. **Dispatch contract**: real run dispatch REQUIRES `conversationId` and
   answers an ACCEPTANCE (`{accepted:true}`) with no run id. The verifier now
   sends a deterministic conversationId and discovers the created run from
   the run list (pre-dispatch id snapshot).
3. **Adapter provenance**: receipts record `executionAdapter` from what the
   endpoint itself reports (`/api/health` version) — `archon@0.10.1` vs
   `archon@0.10.1-mock` vs `archon-compatible (unversioned)` — so a
   mock-backed receipt can never pose as a versioned real-Archon one.
4. **Bootstrap debts**: fresh installs need `mkdir -p ~/.archon/workflows`
   before the seed copy, and runs need a registered folder workspace
   (`POST /api/codebases`); remote-less git repos are refused by worktree
   isolation. Both now documented in DEPLOY.md with examples.

## Hygiene

- Leak scan clean: no private ecosystem names (`chow-*` mock demo entries
  replaced with generic examples), no developer machine paths, no machine
  names, no secrets in tracked files. New check.js gate 8d enforces it
  mechanically (19→20 gates, PASS).
- COMPAT pins match what was actually tested: DSH `0.1.0-rc.6`,
  Archon `v0.10.1` (real install), dsh-tools `0.1.0-rc.8` OPTIONAL,
  Node ≥ 22.
- Old WIP: one stash (`v0.8-split-view-WIP-prior-session-untouched`)
  deliberately left stashed — pre-generic-install UI work, superseded by
  this line; not dropped (owner's call).
- The clean-environment integration harness stays permanent (it has now
  caught real bugs three times that local development concealed: the
  `~`-expansion base, the ESM export error, and the real-Archon contract
  gaps).

## Checkpoints

- `4f440c2` — INSTALLABLE
- `79d84df` — CONFIGURABLE
- `f1667e9` — VERIFIABLE
- `4af0907` — RC0 real-stack contract fixes
- Branch `rc0-real-stack`; nothing pushed or merged.
