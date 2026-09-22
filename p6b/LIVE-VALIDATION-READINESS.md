# P6B — live-validation readiness pin (pre-Run-#3 procedure)

Status: procedure pin only, per GPT ruling "P6B Ruling — Offline Preparation
ACCEPTED · Live HOLD" (2026-09-22): *"One integration point to pin before any
future live run."* This document authorizes nothing. Run #3, a third Solari
sandbox, live execution, paid service, push, publication, production change,
and vNext change all remain un-authorized and require their own rulings. P6C
and P6D remain separate gates.

This is not a candidate change: the v2 candidate stays exactly as committed
(candidate `5cad2530763e3a65812f011648aab7d32162c4e4`, identity pin
`72efd5d5edc35842de4e3d965b91eb6c9e5e036a`, package
`rcos-kernel-subset-v2@0.2.0-candidate.1`, manifest
`55ec0e5fd65079836711e07bb0b1be6fc4d8f5b73965d67efc5b17f29dbf120f`).

## The integration point: two identities, never inferred from each other

A future live procedure must distinguish:

1. **Control-plane identity** — every file movement goes through SDK file ops
   that accept NO user/identity parameter:
   - in: `files.write(path, data, mode)` (historical Run #2 transfer: package
     tree at recorded modes, guard + manifest at 0644),
   - verify-in: `files.read(...)` read-backs,
   - out: `files.readText(path)` (adapter artifact fetch, ≤10 paths, 15s each,
     pre-cleanup), plus `files.upload(path, data)` / signed `uploadUrl(path)`
     in the SDK surface.
   The identity the guest file service uses to place or read those bytes is
   likewise unclaimed and unmeasured (the SDK exposes no execution-identity
   field anywhere; provider claims are `not-claimed` by design). It must not
   be assumed equal to — or different from — the execution identity below.
2. **Guest execution identity** — the identity of the process that runs the
   guard and RCOS workload via `commands.run(cmd, { args, cwd, env, user })`.
   This is the ONLY surface carrying the proposed `user` switch, and the only
   identity the posture eval measures (`process.getuid()`, cross-checked by
   gate `posture_report_matches_process`).

Passing `user` to `commands.run` says nothing about which identity wrote the
files or will read the receipts. Neither side may be inferred from the other,
from an env var, a UID field, or any provider-claimed value.

## The four decisive checks (measured live, never inferred from passing `user`)

1. The selected non-root process can **read** the transferred package
   (explicit read of every manifested file under the switched identity).
2. It can **write only to its authorized run directories** (`runs/`,
   `invocations/`, `eligibility/`, `evidence-records/`, `traces/`) — enforced
   by the isolation guard's stray-file rule, `--check-only` before and after.
3. It can **execute the guard and the evaluations** (node + exec bits under
   the switched identity, through the pinned guard form).
4. The artifacts remain **retrievable by the control plane** after execution
   (`files.readText` over the control channel, pre-cleanup) and re-hash clean
   against the receipt after retrieval.

## Failure protocol (from the ruling; operationalized)

If the user switch is **rejected, ignored, or produces an unwritable
workspace**:

1. Record the exact failure verbatim (SDK error text, observed effective uid,
   gate stderr).
2. Retrieve whatever evidence exists — runner order is immutable:
   execute → capture → retrieve → verify → classify → cleanup; no exit code
   bypasses retrieval.
3. Clean up (kill + death probe).
4. **Stop.** No retry loop, no configuration mutation to force a pass, no
   second attempt inside the same authorization.

**Never fall back to running the posture-gated workload as root.** Root
execution must refuse (gate `live_non_root_requirement` →
`environment-incompatibility … effective uid is 0`, verdict blocked, exit 4),
and that refusal remains the recorded outcome. Repair B is not weakened to
make any provider compatible.

## Authorization status

- Live validation: **HOLD — requires a separate Run #3 ruling** (authorized
  account, server-side credentials, explicit spending cap established first).
- Offline evidence standing: candidate committed, `scripts/check.js` PASS,
  `test/*.test.mjs` 171/171, runner-vnext 10/10, v1 diff empty, historical
  Run #1/#2 evidence unchanged, spend this phase $0.00.
- Historical evidence preservation: the four untracked files (two
  private-path scripts + two excluded logs) now also exist as verified
  byte-identical copies in a durable PRIVATE archive
  (`~/.p6b-private-evidence-archive/2026-09-22-run1-run2/`, with its own
  manifest); hashes pin identity, the archive preserves bytes. Never alter,
  publish, or git-track them.
