# A2-c live dispatch — SHIP receipt after an honest 5-run arc (2026-09-29)

The dry-run (bb0939c) proved the plumbing with a scripted ladder. This run
replaced the script with the **real RCOS ladder executed by the dispatched WM
seat itself**: one ordinary procedural conversation in the testbed, dispatch to
the WM seat, and the seat's `run_code` program drives the actual RCOS CLI and
Archon **on the Dell** (`chow@100.111.182.5`):

1. **find/reuse** — `rcos query --json` piped through the shipped python
   helper; gate = exitCode 0 AND exactly one PROMOTED `route-record-validate`.
2. **compose/install** — `rcos ir-compile --ir ir-plan.json --name
   a2c-route-record-live --install` → `~/.archon/workflows/rcos-ir-a2c-route-record-live.yaml`.
3. **archon-run** — `archon workflow run rcos-ir-a2c-route-record-live "$(cat capability-input.json)"`,
   synchronous, log captured to file, grepped for `workflowRunId` +
   `Workflow completed successfully`.
4. **verify** — a FRESH `verify.py` execution on the Dell (new invocation id
   every time — nothing replayed), 6/6 checks, JSON report on stdout.
5. **receipt** — `submit_dispatch_receipt` under the real contract, with a
   try/catch degrade path so a refusal becomes a truthful `fix` receipt
   instead of a crash.

Runtime: real dsh `0.2.0-rc.1`, loopback model (`127.0.0.1:8793`, dummy key,
**zero inference, zero spend**), scratch `DSH_HOME=~/.dsh-a0-boot/home`. The
Archon workflow is bash-only nodes — no model anywhere in the DAG, so the
whole ladder costs nothing.

## The 5-run arc — one real bug per run, every receipt truthful

| # | run_id | verdict | the bug it exposed |
|---|---|---|---|
| 1 | `sd-20260929T140037Z-22172b` | fix | `contract.declaration_errors` / `contract_errors` in the rcos run-record are **arrays**, not strings — the verify helper mishandled them. |
| 2 | `sd-20260929T140223Z-e0c5af` | fix | run-record `output.path` is **relative**, resolving against `~/zcode-rcos/invocations/<invocation_id>/` — the program joined it wrong. |
| 3 | `sd-20260929T140339Z-3c8dfc` | fix | `JSON.stringify` escapes inner quotes, so `/"archon_run_id":"…"/` can never match a stringified tool result. Ladder was already green on the Dell (run `494c0b51`, `inv_20260929T140342Z-947513`) — the receipt honestly said fix. Fixed with `JSON.parse` primary + null-safe UUID-regex fallback. |
| 4 | `sd-20260929T140829Z-0ec5b3` | blocked, attempts 0 | submitted `archon_status: 'completed'` → `ToolCallError` (bindingFailure) → program crashed before any submit. Forensics from the seat transcript: ladder fully green (Archon `db8c816b…`, `inv_20260929T140832Z-0c1c4d`), submit call correct except the enum. **`archon_status` is the run's own verdict value (`ship|fix|blocked`), never a lifecycle word.** |
| 5 | `sd-20260929T141331Z-03e031` | **ship** | — attempts 1, refusals 0. |

## What ended the bug chain: the dress rehearsal

Before run 5, the harness gained `harness/dress-rehearsal.mjs`: it imports the
**real `validateReceipt`** from the shipped dispatcher bundle
(`bundles/seat-dispatch-real/dsh-seat-dispatch/lib/receipt.js`) and runs the
entire built program against mocked tools whose `submit_dispatch_receipt`
validates through the real contract (plus the one-receipt rule and
hard-throw). Three scenarios, all green before the live dispatch was spent:

- **green** — ship receipt with the real run-4 verifier stdout; asserts real
  uuid, `archon_status: ship`, 3 artifacts, ≥8 evidence lines.
- **red** — verifier exits 1 with empty stdout; asserts a consistent `fix`
  receipt. This scenario caught its own bug: a null-deref in the UUID fallback
  (`UUID_RE.exec(...)[0]` when exec returns null) that the green path missed.
- **refuse-first** — the first submit throws the real `archon_status` enum
  error; asserts the program degrades to a minimal guaranteed-valid `fix`
  receipt naming the refusal.

Weak agents, smart harness — applied twice: all ladder judgment lives in the
shipped python helpers (JS gates on exitCode only), and the receipt contract
is enforced at build time by the real validator.

## Independent evaluation on the Dell (seat-reported fields are claims)

Checked directly on the Dell after run 5 — not from the receipt:

- All 4 artifact files exist in the Archon run dir (listing deliberately
  excludes `pi-home/auth.json`, which Archon embeds in every run dir —
  sensitive, never print its contents).
- `verdict.json` — `a2c-route-record-live-verdict/1`, verdict **ship**,
  invocation `inv_20260929T141334Z-f61f40`, dispatch-handoff judged VALID,
  `rederived_summary == adapter_summary == frozen_arithmetic`
  `{total:1, valid:1, schema_violations:0, authority_refusals:0,
  eligibility_refusals:0, unreadable:0}`; probe of a missing record refused
  with `kernel_exit 2`; `problems: []`.
- `validation-report.json` — `ok: true`, 6/6 checks (capability found,
  completed, normal mode, promoted at run time, contract clean, contract io
  pass), 82 ms, **fresh execution** — new invocation id, nothing replayed.
- Run log — exactly one `Workflow completed successfully`; `workflowRunId`
  `89bbca5a-a83e-4a98-a4f2-6cafeac3554b` matches the receipt's
  `archon_run_id`.

## Files

- `harness/program.template.js` — the live WM program (placeholders for the
  four b64-embedded payloads); the receipt block with the JSON.parse
  extraction, null-safe UUID fallback, and try/catch degrade.
- `harness/build.py` — embeds payloads, validates both JSON payloads,
  syntax-checks the assembled program in node, asserts no unresolved
  placeholders → `program.live.txt` (19238 chars, the exact text that ran).
- `harness/dress-rehearsal.mjs` — validator-backed pre-flight, 3 scenarios.
- `harness/find.py`, `harness/verify.py` — the shipped python judgment
  helpers (all ladder intelligence; exitCode-gated from JS).
- `harness/capability-input.json`, `harness/ir-plan.json`,
  `harness/ir-plan-smoke.json`, `harness/run.sh` — capability input, IR plan
  (smoke variant), and the dispatch runner.
- `evidence/seat-dispatch-audit-live.jsonl` — the 5 live audit rows above.
- `evidence/req-6.json` — the raw loopback request envelope of run 5
  (contains the exact `submit_dispatch_receipt` call in the message chain;
  `sk-` grep hits are the `dsh-tool-ask-user` package name, no secrets).
- `evidence/composer-receipt.json`, `evidence/composer.ndjson`,
  `evidence/loopback.jsonl` — composer run receipt, event chain, loopback
  route log for the live arc.

Dell side (committed in `~/zcode-rcos`): the 5 `invocations/inv_2026…` dirs,
the 5 `eligibility/elig_2026…` dirs, and the installed workflow yaml copied
into the repo as source of truth. A harmless second workflow
(`rcos-ir-a2c-runtime-smoke.yaml`) remains installed from the smoke test.
