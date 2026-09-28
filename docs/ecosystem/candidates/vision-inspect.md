# Candidate: vision-inspect (from Anionex/dsh-vision-toolkit)

- Entry: `dshfind-api:Anionex/dsh-vision-toolkit` (MIT, stars 884, fresh 2026-09-28).
- User outcome: inspect-data — image in, description/answer out (pasted-image
  recognition, multi-image Q&A, screenshot description).
- Proposed contract: inputs (1–4 images within size caps, question ≤280 chars),
  outputs (bounded text answer + per-image handling note), evidence (image
  digests, model lane record), refusal cases (no image, unreadable image,
  image-count over cap — answer NOIMAGE rather than guessing).
- Why not native reuse: text-only lanes cannot see images; the pack binds an
  image-capable lane behind an explicit observation instead of ad-hoc calls.
- Binding: pending B2.
- Prerequisites: image-capable model lane with digit-read confirmation
  (deepseek-v4.1-flash declares image input; confirm per lane before use).
- Status: proposal. No code copied; no install, runtime, or compatibility claim.
