# A2-c composer dry-run — GREEN receipt (2026-09-29)

One ordinary conversation, two turns, on the real dsh 0.2.0-rc.1 runtime with a
loopback model (127.0.0.1:8793, dummy key, **zero inference, zero spend**).
Everything downstream of the model turn is production code: the `dispatch_seat`
tool, WM seat composition from the `wm` preset, the PTC `run_code` lane, the
`submit_dispatch_receipt` contract, and the audit append.

## Result (exit 0)

| Stage | Evidence |
|---|---|
| Caller mounts `idea-chat` | `composer/preset composed_preset=idea-chat`; header `agentPreset: idea-chat` |
| Turn 1 brainstorm — zero dispatch | `composer/turn1-brainstorm dispatch_delta=0` (audit line count unchanged) |
| Turn 2 procedural — dispatches | `composer/turn2-procedural dispatch_delta=1`, audit record `run_id sd-20260929T085040Z-2f6312` |
| Seat composition | `stage: complete`, 1 turn, `reason: completed`, 362 ms |
| Authority | `authority_basis: no-parent-root` (root caller), `caller_depth 0` → seat `delegationDepth 1` |
| PTC lane | WM requests carry exactly `tools: [run_code]` (presentation filter verified in loopback bodies) |
| Receipt | `receipt_accepted: true`, attempts 1, refusals 0, `verdict: ship` |
| Artifact honesty | `caller-cwd/seat-run/artifact.txt` exists on disk and matches the receipt claim |
| Lane honesty | declared `loopback-0spend/deepseek-flash`, observed `deepseek-official/deepseek-flash`, mismatch false (model halves equal; the label is loopback-only, no inference ran — DeepSeek floor note: no real model was selected or billed) |

Files: `evidence/composer-receipt.json` (schema `a2c-composer-run/1`),
`evidence/composer.ndjson` (event chain), `evidence/seat-dispatch-audit.jsonl`
(3 lines: the two failure-path records from debug runs + the green one),
`evidence/loopback-routes.jsonl` (route chain caller/brainstorm → secondary →
caller/procedural → wm/ladder → wm/close → caller/close).

## What the harness caught (rc.8 → 0.2 deltas, all fixed in scratch, converter stays verbatim)

1. **persona schema** — rc.8 `config.text:` → 0.2 requires `prefix:` (suffix
   "", complete false, includeRuntimeContext true). Found by the first boot;
   `audit-row-schemas.mjs` (recursive row-schema audit incl. `cordis:group`
   rows whose `config:` IS the plugin list) proved persona was the only
   invalid row. AB note item.
2. **workflow engine host** — rc.8 `workflow-worker-thread` is
   peer-incompatible with 0.2.0-rc.1 and auto-disables; `tool-workflow` then
   waits forever on the `workflowEngine` service. 0.2's host is
   `dsh-workflow-ptc` (config `provider: spawn`) — the shape the installed
   desktop profile uses. Swapped in all 3 groups. AB note item.
3. **`session.events`** — 0.2 Session exposes `snapshotEvents()` / `seq`, not a
   live `events` array. Dispatcher bundle fixed (3 sites). Bundle bug, not a
   profile delta.
4. **v4 source kind** — bare `kind: 'plugin'` is retired; plugin-produced
   messages must carry `kind: 'plugin:<name>'`. Dispatcher envelope fixed.
   Bundle bug, not a profile delta.
5. **bash sandbox discipline** — the bash tool runs `workspace-write`; writes
   outside the seat cwd are denied (`Operation not permitted`, recorded in the
   result). The dry-run program now writes inside the seat workspace and GATES
   its verdict on bash exit codes — a denied write downgrades to `fix` with
   empty artifacts. This is the receipt discipline the first scripted program
   violated (declared `ship` with a nonexistent artifact; the on-disk check
   caught it).

Earlier scratch delta (kept): `mode: code` → `mode: ptc` on
`dsh-agent-tool-presentation`.

## Known non-blocking warnings

- `workflow-worker-thread` disable warnings on stderr (expected after the
  swap the row is gone; the warnings in the captured logs predate the swap).
- Dispatcher warns `no Archon run id` when a receipt honestly reports
  `archon_status: 'none'` — legitimate for the dry-run; the live run must
  carry a real run id.
- `composed_preset` was null in debug runs (accessor returns the id string;
  harness applied `?.id`) — fixed; final run reports `idea-chat`.

## Zero-spend guarantee

Loopback-only base URL, dummy key (`a2c-dummy-key-loopback-only`), scratch
`DSH_HOME` with no credentials. The loopback journals every request with
`sha256[:10]` key fingerprint only — the key material is never written. No
inference ran on any provider: the model id `deepseek-flash` is a loopback
label, not a selection (DeepSeek floor rule honored trivially — nothing real
was called).
