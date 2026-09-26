# EVIDENCE — video-forensics-receipt (ported by cap-port-a, 2026-09-25)

Per-capability run log. Every run below was executed on this Mac in this
session; run IDs are real UUIDs from my runs. The source repo's eval rows are
asserted prose and were **not** migrated — nothing here is copied evidence.

## What this is

A local single-file measurer (`adapter/forensics.py`, ffmpeg/ffprobe only)
wrapped by `adapter/run.cjs` in the rcos adapter kernel
(`RCOS_INPUT` / `RCOS_OUTPUT` / `RCOS_EVIDENCE_DIR`). It measures ebur128
loudness (integrated LUFS / LRA / true peak), canvas mean luma and saturation,
and a 1s-baseline hold profile per probe, then checks the measurements against
the envelope of the declared craft register (explainer / brand / kinetic).

Portability changes vs source: ffmpeg/ffprobe resolved from `$FFMPEG`/`$FFPROBE`
or `PATH` (no machine paths); adapter file is `run.cjs` because this repo is
`"type": "module"` and the adapter is CommonJS.

## How to run

```sh
# eval suite (self-contained; regenerates nothing, pins fixture hashes)
node capabilities/video-forensics-receipt/evals/run-eval.js

# negative control — MUST exit 1
node capabilities/video-forensics-receipt/evals/run-eval.js --negative

# fixtures (only if you want to rebuild them; the suite checks sha256 pins)
bash capabilities/video-forensics-receipt/evals/fixtures/generate.sh
```

Requires: node >= 22, python3, ffmpeg/ffprobe on `PATH` (9.0.1 at `~/homebrew/bin`).

## Commands run (exit codes)

| command | exit | result |
|---|---|---|
| `bash evals/fixtures/generate.sh` | 0 | 11 .mp4 fixtures generated, sha256-pinned in `evals/cases.json` |
| `node evals/run-eval.js --artifacts <out-of-repo dir>` | 0 | **EVAL PASS 75/75** gate checks; suite run `11f9d6ef-5a5d-481b-9c9e-ca3a2646d53e` |
| `node evals/run-eval.js --negative` | 1 | **NEGATIVE CONTROL CONFIRMED** — 4 gates failed on the perturbed input; suite run `bb2bf41d-0bcb-4021-a6e2-52a9622adfcf`, case run `ccdbdf52-5af6-4223-ae43-0722fb18b353` |

Case-level run IDs (all passed) are recorded in `registry-entry.json`
(`provenance.evalSet`) — 12 cases including both dead-arm findings below.

## Falsification

Negative control: the control case's fixture was swapped
(`envelope-pass` → `slideshow`) while the unperturbed expectations stayed in
place. The eval failed as required: `outcome` expected `"passed"` observed
`"caught"`, `failing_gates` expected `[]` observed
`["no-dead-frames","no-long-hold"]`, `hold_share 0.8974 > max 0.4`,
`longest_hold_s 7 > max 5` — 4 gates, exit 1.

## Findings / not claimed

- **Dead arms (executed findings, kept honest as cases):** the declared luma
  floor 0.06 is unreachable — flat black measures the metric's own black level
  (16/255 = 0.0627), so `luma-in-band` can only fail HIGH (case
  `luma-floor-arm-is-dead`, run `f93ac393-9042-455b-9853-56fd43f7e509`). The
  declared saturation ceiling 0.86 is unreachable — the most saturated canvas
  the metric sees (pure magenta) measures ~0.4667, so `saturation-in-band` can
  only fail LOW (case `sat-ceiling-arm-is-dead`, run
  `ca28fa72-f91c-4a17-83a9-2db99bf86d4d`). The live arms of both checks are
  covered by `overbright-fails-luma-ceiling` / `desaturated-fails-sat-floor`.
- Register bands are per-class corpus envelopes, not per-piece laws; a value
  outside a band is a finding to read.
- Hold sampling runs at 1 Hz, so holds resolve to about one second; motion is a
  luma proxy measured on a 480x270 downscale.
- No cut detection here (that lives in the other rig's scene-change path).
- Status is `candidate` — promotion is the registry owner's call at
  integration, not something this lane claims.
