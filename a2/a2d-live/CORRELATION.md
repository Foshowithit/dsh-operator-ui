# A2-d — correlation chain + failure paths, from real runs

Gate (plan 9839ad5): *one chain with distinct IDs: Desktop session/turn → routing
decision → WM dispatch (jsonl) → capability/IR revision → Archon run id → artifact
dir → evaluator verdict. Failure paths (missing capability, invalid identity,
permission denied, backend down) each show explicit refusal/recovery.*

Two real runs satisfy it, both loopback-scripted at the model layer (zero
inference, zero spend) and production-real everywhere else — dispatcher authority
gate, seat composition, ptc sandbox, receipt contract, audit jsonl, RCOS registry,
Archon. Every ID below is real and every claim points at a file on disk.

## Part 1 — the chain (A2-c live run, 2026-09-29T14:13Z)

| # | Layer | ID / value | Evidence |
|---|-------|-----------|----------|
| 1 | Caller session (Desktop-equivalent composer turn) | `session-2d9aeaba-c6b1-4ce8-8a25-f61db4144805` (preset `idea-chat`) | `../a2c-live/evidence/composer-receipt.json` |
| 2 | Routing decision — the model turn's `dispatch_seat` tool_use for seat `wm` | tool call captured verbatim in the caller request | `../a2c-live/evidence/req-6.json` |
| 3 | WM dispatch (audit jsonl) | `sd-20260929T141331Z-03e031` — stage `complete`, verdict `ship`, authority_basis `no-parent-root`, receipt_accepted `true`, seat_session `4e2324d5-9036-4337-bb5c-e564ae537d87` | `../a2c-live/evidence/seat-dispatch-audit-live.jsonl` (row 5) |
| 4 | Capability revision | `route-record-validate` v0.1.0, status PROMOTED (Dell commit 616202d) | Dell `~/zcode-rcos` registry; queried live by the program (`harness/find.py`) |
| 5 | IR revision | workflow `rcos-ir-a2c-route-record-live`, kernel sha256 `acd12945a3b732ac801ee90cd3476f237f928bcaecea5a8ece5f6da099eab8c0` | Dell Archon workflows root |
| 6 | Capability invocation (inside the Archon run) | `inv_20260929T141334Z-f61f40` — route-record-validate, completed, adapter exit 0 | Dell `~/zcode-rcos/invocations/inv_20260929T141334Z-f61f40/` |
| 7 | Archon run id | `89bbca5a-a83e-4a98-a4f2-6cafeac3554b` | audit row 5 `archon.run_id`; Dell Archon runs root |
| 8 | Artifact dir | `/home/chow/.archon/workspaces/_folder/chow/artifacts/runs/89bbca5a-a83e-4a98-a4f2-6cafeac3554b/` — `rcos-invocation-route-record-validate.json`, `validation-report.json`, `verdict.json` | audit row 5 `artifacts` (all three listed) |
| 9 | Evaluator verdict | `verdict.json` = **ship**; `validation-report.json` = 6/6 re-derived checks pass | artifact dir (Dell-verified 2026-09-29; dir also embeds `pi-home/` — treat as sensitive, never printed) |

The chain is **distinct-ID end to end**: the caller session id ≠ seat session id ≠
dispatch run id ≠ invocation id ≠ Archon run id, and each hop is recorded by the
system that made it (loopback journal → audit jsonl → RCOS registry/invocations →
Archon runs → artifact verdicts).

### Honest note on the validated record's inner IDs

The capability's *payload* was fixture `handoff-valid.json`
(routing_id `rr-20260929T085040Z-2f6312`). Its inner correlation fields
(`session-945b8f2a-005d-45ac-9773-fb10a8854c76`,
`sd-20260929T085040Z-2f6312`, `session-seat-…-0001`) are **A2-b-era synthetic
mirrors** — they are content the validator judged, not IDs of the live chain
above. The correlation proven here is between the live dispatch-layer IDs
(rows 1–9); the fixture's inner mirrors are deliberately distinct, and the
kernel's authority check validated them on their own terms (parent lineage
`no-parent-root`, basis clean). No ID is claimed twice under two roles.

## Part 2 — failure paths, each refused explicitly and recovered (A2-d live run, 2026-09-29T14:36Z)

Caller `session-c25a5bf8-0af5-45a1-91b9-d2aaacebe445` (preset `idea-chat`), audit
rows 11–12 of the dispatcher jsonl. "Recovered" = the harness continued and the
final verdict was still reachable; ship is conjunction-gated on all four probes
refusing cleanly.

| # | Path (layer) | Probe | Refusal — on-disk evidence | Recovery |
|---|--------------|-------|---------------------------|----------|
| 1 | Undesignated seat (dispatcher authority) | `dispatch_seat(seat:'no-such-seat')` | audit row `sd-20260929T143614Z-e9e484`: stage `authority-seat`, ok `false`, verdict `blocked`, receipt_accepted `false`, 3 ms, detail: *"seat \"no-such-seat\" is not dispatchable from this composition; dispatchable seats: wm."* | next dispatch 1 s later → `sd-20260929T143615Z-7cff40` ship |
| 2 | Missing capability (RCOS registry) | `rcos run no-such-capability` over ssh | exit **2**, stderr `rcos: no such capability 'no-such-capability' in the registry`, **no invocation dir created** (refusal precedes recording — Dell dir listing confirms) | program asserted exitCode===2 && message; probe marked refused+recovered |
| 3 | Invalid identity/handoff (kernel authority) | `route-record-validate` on the delegated-child fixture | `inv_20260929T143616Z-e77b7d` — invocation **completed** (adapter exit 0) while record-level verdict is exit **3** `authority-refusal`, summary `valid:0, authority_refusals:1`, `evidence/kernel-authority-refused.txt`; eligibility `elig_20260929T143616Z-6aa801` | program read the fresh invocation's `output.json` and asserted the refusal shape; artifacts of this invocation are the ship receipt's artifact list |
| 4 | Permission denied (ptc sandbox) | write marker to `$HOME` from inside run_code | exit non-zero + `sandbox.denied` + "Operation not permitted" + follow-up `test -e` → ABSENT; post-run check: no `/Users/adam26/.a2d-p3-deny-*` residue | program asserted denial+absence; probe marked refused+recovered |
| 5 | Backend down (transport) | `ssh -p 1 … chow@127.0.0.1 true` — closed LOCAL port, never the real Dell | exit non-zero + "Connection refused" | program asserted the refusal text; probe marked refused+recovered |

Ship row `sd-20260929T143615Z-7cff40`: verdict `ship`, receipt_accepted `true`
(attempts 1, refusals 0), duration 2266 ms for the whole four-probe program,
archon `none/none/none` (by design — a2d spends nothing on Archon; the two
`none`-archon warnings in the row are the contract's expected notices), artifacts
= the three files of `inv_20260929T143616Z-e77b7d`. The receipt's in-program
acceptance echo (`accepted:true, run_id sd-…-7cff40`) is captured in
`evidence/req-7.json` (run_code tool_result).

### Evidence-trace caveat (honest receipt)

ptc `run_code` returns only the program's final value across the tool boundary;
per-probe stdout bodies are not persisted by the runtime. The per-probe rows are
therefore proven two ways: (a) the conjunction gate — verdict `ship` is
unreachable unless every probe's refusal assertion passed — and (b) independent
on-disk corroboration for each path listed in the table above (audit jsonl row,
Dell invocation dir + output.json + eligibility dir, absence of the sandbox
marker, exit-2 semantics verified against the registry in A2-b). The dress
rehearsal (`harness/dress-rehearsal.mjs`, real `validateReceipt`) exercised the
identical program logic green/red/refuse-first against calibrated real outputs
before the live run.

## Zero-spend + security

- Model turns scripted by the loopback (127.0.0.1:8793, dummy key) — zero
  inference, zero spend; the composer receipt states this in its `honesty` field.
- Backend-down probe targets a closed local port only; the real Dell was never
  probed, restarted, or killed.
- Archon artifact dirs embed `pi-home/auth.json` (sensitive) — never printed;
  only paths and verdicts are cited.
