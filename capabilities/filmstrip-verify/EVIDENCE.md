# EVIDENCE — filmstrip-verify (ported by cap-port-a, 2026-09-25)

Per-capability run log. Every run below was executed on this Mac in this
session; run IDs are real UUIDs from my runs. The source repo's eval rows are
asserted prose and were **not** migrated — nothing here is copied evidence.

## What this is

Never trust a video by its size or by prose claims. `adapter/run.cjs` (rcos
adapter kernel: `RCOS_INPUT` / `RCOS_OUTPUT` / `RCOS_EVIDENCE_DIR`) extracts N
tiles at even timestamps (default 6) and measures three deterministic legs:

- **six-frames** — the tile count follows the request, measured from the strip
- **audio-bed** — `volumedetect` mean_volume within [-45, -6] dBFS (absent
  audio is REPORTED as null and fails the leg; it is not a crash)
- **no-slideshow (deterministic PROXY)** — `hold_share <= 0.40` and
  `longest_hold_s <= 5.0` at a 1s baseline

The protocol's sighted **distinct-motion** leg (per-frame motion notes) is
deliberately NOT claimed deterministic — see "not claimed".

Portability changes vs source: adapter file is `run.cjs` (repo is
`"type": "module"`, adapter is CommonJS); measurer self-path updated to
`capabilities/filmstrip-verify/adapter/run.cjs`; no machine paths.

## How to run

```sh
node capabilities/filmstrip-verify/evals/run-eval.js

# negative control — MUST exit 1
node capabilities/filmstrip-verify/evals/run-eval.js --negative

# fixtures (only to rebuild; the suite checks sha256 pins)
bash capabilities/filmstrip-verify/evals/fixtures/generate.sh
```

Requires: node >= 22, ffmpeg/ffprobe on `PATH` (9.0.1 at `~/homebrew/bin`).

## Commands run (exit codes)

| command | exit | result |
|---|---|---|
| `bash evals/fixtures/generate.sh` | 0 | 6 .mp4 fixtures generated, sha256-pinned in `evals/cases.json` |
| `node evals/run-eval.js --artifacts <out-of-repo dir>` | 0 | **EVAL PASS 62/62** gate checks; suite run `01423e6f-317b-468c-b92c-2d58ea32599d` |
| `node evals/run-eval.js --negative` | 1 | **NEGATIVE CONTROL CONFIRMED** — 5 gates failed on the perturbed input; suite run `be847785-eae1-4faf-9577-9cdc3288f107`, case run `aac9ba45-5815-4f58-930f-b2e41721e0c0` |

Case-level run IDs (all passed) are recorded in `registry-entry.json`
(`provenance.evalSet`) — 9 cases.

## Falsification

Negative control: the passing case's fixture was swapped
(`cut-continuous` → `slideshow-holds`) while the unperturbed expectations
stayed in place. The eval failed as required: `outcome` expected
`"measured-pass"` observed `"measured-fail"`, `failing_legs` expected `[]`
observed `["no-slideshow"]`, `pass_marker` `FILMSTRIP_FAIL`, `hold_share
0.6875 > max 0.4`, `leg_no_slideshow` false — 5 gates, exit 1.

## Findings / not claimed

- **distinct-motion is not claimed.** The source protocol's motion leg is
  sighted judgment; only the deterministic legs above were converted. The
  no-slideshow leg is a hold-profile PROXY — it catches freeze/slideshow
  patterns, not all unconvincing motion.
- The adapter PROCESS exits 0 whenever it measured; per-probe `exit_status`
  carries 3 for a gate fail and 4 for could-not-run (case
  `adapter-exit-code-is-not-a-verdict` pins this so nobody reads exit 0 as
  "passed").
- Hold sampling is 1 Hz; a 0.9s freeze is indistinguishable from motion.
- Status is `candidate` — promotion is the registry owner's call at
  integration, not something this lane claims.
