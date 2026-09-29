# A2-d LIVE RUN — honest receipt (2026-09-29)

**Result: GREEN, exit 0.** One A2-d composer run: conversational turn (no
dispatch) → invalid dispatch (explicit authority refusal) → valid dispatch (WM
seat runs the four-failure-path program, submits a contract-valid ship receipt).
Zero model spend.

| Field | Value |
|---|---|
| Lane | `loopback-0spend/deepseek-flash` — loopback at 127.0.0.1:8793, dummy key, model turns SCRIPTED; zero inference, zero spend |
| Machine | Mac (scratch DSH_HOME `/Users/adam26/dsh-a0-boot/home`; zero writes to active `~/.dsh`) + Dell over ssh (read paths + `rcos` invocations only) |
| Caller session | `session-c25a5bf8-0af5-45a1-91b9-d2aaacebe445` (preset `idea-chat`) |
| Composer plugin | `dsh-a2d-composer` @ `~/dsh-a0-boot/bundles/a2d-composer/` |
| Program | `harness/program.template.js` → built to `~/dsh-a0-boot/a2d/program.a2d.txt` (9374 chars) by `harness/build.py` |
| Receipt (harness) | `evidence/composer-receipt.json` — schema `a2d-composer-run/1`, ok `true` |
| Receipt (dispatcher) | `sd-20260929T143615Z-7cff40` ship, accepted 1st attempt |
| Audit rows appended | 2 (rows 11–12 → `evidence/seat-dispatch-audit-live.jsonl`) |

## Turn deltas (the dispatch proofs)

| Turn | Loopback route | Audit delta | Result |
|---|---|---|---|
| 1 brainstorm | `caller/brainstorm` | **0** | conversational, as required |
| 2 invalid dispatch | `caller/invalid-dispatch` | **+1** | refusal row `sd-20260929T143614Z-e9e484` (stage `authority-seat`, verdict `blocked`, receipt_accepted `false`, 3 ms, detail names dispatchable seats) — refusal is the PASS condition |
| 3 procedural | `caller/procedural` → `wm/probes` (program 9374 chars) → `wm/close` | **+1** | ship row `sd-20260929T143615Z-7cff40` (receipt accepted, 2266 ms, archon none/none/none with only the two expected contract warnings) |

Loopback journal: 8/8 requests routed as designed (`evidence/loopback.jsonl`),
0 unexpected routes, 0 500s, apiKey fingerprint only. P3 sandbox marker left NO
residue in `$HOME` (checked). Full chain + the four failure paths:
**CORRELATION.md**.

## The arc, honestly

1. **Dress rehearsal first** (`harness/dress-rehearsal.mjs`, real
   `validateReceipt` from the seat-dispatch bundle): green / red / refuse-first
   all PASS against calibrated real Dell outputs, before any live attempt.
2. **First live attempt FAILED**: `a2d-composer (dsh-a2d-composer): failed to
   import` — direct import test reproduced
   `The requested module '@deepseek-ai/dsh-brand' does not provide an export
   named 'brandString'`. Root cause: the a2c plugin package ships its own
   `node_modules` so `@deepseek-ai/*` resolve inside the package; the a2d
   package had none and resolution walked up to a foreign tree. Fix: copy the
   a2c package's `node_modules` into `dsh-a2d-composer/`; import then OK.
3. **Clean relaunch** (task stopped, port freed, evidence truncated):
   exit 0, receipt green on every assertion above. No second failure.

## What is real vs scripted

Real (production code paths): dispatcher authority gate + refusal settle, seat
composition (wm), ptc `run_code` lane + sandbox enforcement, receipt contract
validation (closed 10-field root, one-receipt-only), audit jsonl appends, ssh to
Dell, RCOS registry + invocation recording, eligibility.

Scripted (test-only): the three model turns (loopback markers), the caller
"model" id (a label). No real inference anywhere; scratch DSH_HOME has no
credentials, so spend was impossible by construction.

## Dell-side deltas from this run

- `~/zcode-rcos/invocations/inv_20260929T143616Z-e77b7d/` + eligibility
  `elig_20260929T143616Z-6aa801` (live P2 kernel-refusal invocation;
  independently verified: status completed, adapter exit 0, records[0] exit 3
  `authority-refusal`, summary `valid:0 authority_refusals:1`).
- `/tmp/a2d-p1-input.json` (14 B) + `/tmp/a2d-p2-input.json` (235 B, sha256
  `e3ab8b7bafdc2b3594b599e09d8d8ca6fc815059f55ede1cfde77450cbf36394`) shipped
  at 14:36Z for the probes.
- Earlier calibration invocations from the same session:
  `inv_20260929T142230Z-249206`, `inv_20260929T142355Z-d8b6fb` (+ eligibility
  dirs) — committed together in the Dell evidence commit.
