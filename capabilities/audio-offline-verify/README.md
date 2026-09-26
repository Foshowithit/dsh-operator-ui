# Audio Offline Verify

Registry id: `audio-offline-verify` · kind: `script`

## Contract

**Covers.** Receipting an offline-rendered media file without a human ear:
`capabilities/audio-offline-verify/adapter/av_check.py` runs ffprobe JSON and
asserts video codec (`--expect-video`), audio codec or explicit absence
(`--expect-audio aac|none`), and duration within `[--min-s, --max-s]`; astats
RMS_level is always reported; `--audio-must-sound` makes RMS < −60 dBFS (or
None/−inf) a hard FAIL — "has an audio track" and "the track contains sound"
are different claims. Exit codes: 0 pass, 3 gate-fail, 4 tooling-missing.

**Does NOT cover.** What the sound IS (meloody, speech content) — an llm or
human gate covers that. Streaming/live inputs (files only). Loudness
normalization compliance (RMS is reported, not asserted, unless must-sound).

**Adapter pointer.** `capabilities/audio-offline-verify/adapter/av_check.py`.

## Gates

| id | kind | check |
|----|------|-------|
| container | deterministic | ffprobe parses; video codec matches `--expect-video`; duration inside `[min,max]` |
| audio-track | deterministic | audio codec matches `--expect-audio` (aac present, or genuinely absent when `none`) |
| sounds | deterministic | with `--audio-must-sound`: astats RMS_level > −60 dBFS (None/−inf = FAIL); RMS always reported in the receipt |

## Attack case

**The silent soundtrack.** A mux that produced a valid aac track from silence
(e.g. muted capture, dead input) passes every container and codec check —
"audio: aac, 44100 Hz" in the receipt while the file contains no sound.
Caught by `--audio-must-sound`: the attack file (video-only mux attempted
with an empty source) exits 3 with `FAIL MUST_SOUND but RMS ... below -60
floor`. Known wart: −inf RMS parses to "RMS None dBFS" in the message —
functional, accepted.

## Lineage

Descends from the video-forensics-receipt gates (ffprobe-as-receipt) and the
chalk-capture pipeline's mux step. Built 09-17 during the admission campaign
after a muted-capture scare in the face-in-scene eval chain; consumers: any
mp4 mux step (chalk shots, face-in-scene outputs, X packages).

## Eval log

- 09-17 eval-1 (traced): chalk-eval2.mp4 (3.0s h264 960x540 + aac 44100 mono,
  RMS −35.11 dBFS) — PASS with must-sound on.
- 09-17 eval-2 (traced): shot-face-v2-r3.mp4 — PASS as report-only
  (`--expect-audio aac`, RMS −inf reported, no must-sound; silent-by-design
  file verified as such).
- 09-17 attack (traced): mute attempt — exit 3, MUST_SOUND floor tripped.
