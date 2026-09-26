# QR camo embed recipe

Registry id: `qr-camo-embed` · kind: `script`

Scannable QR embedded INTO artwork (Twitter-header class output), blended
so it reads as part of the piece — not invisible, not a sticker.

## Contract
- Covers: embedding a SHORT payload (~<=35-char URL at ERROR_CORRECT_H in
  the 1500x500 window at MODULE=11) into a mid-tone photographic or
  textured cover (~L 80-140), verified scannable after real-world
  transcode (external jpeg re-encode).
- Does NOT cover: very dark covers (the quiet-zone halo lifts to a
  visibly flat light box — eval-5 2026-09-17, confirmed by muse + eye);
  flat pale synthetic covers (halo reads as a flat square — eval-4);
  long payloads (>~35 chars overflow the placement window — 42-char hog
  URL fails); portrait-only output; landscape sources are fine as of the
  eval-5 orientation fix (rotate only portrait sources).
- Adapter: `capabilities/qr-camo-embed/adapter/make_header_v2.py`
  (adaptive-contrast DESCENDING ladder 0.80->0.52, seeded per-module
  jitter, texture retention; runs in a venv with cv2+qrcode+zxing-cpp,
  e.g. `evidence/qr-venv/`).

## Gates (EVAL.json)
- g1 (`scans`, deterministic): the FINAL rendered PNG decodes via zxing to
  the exact target URL, and again after an external jpeg-q85 re-encode
  (Twitter-grade transcode).
- g2 (`integrated`, llm): sighted muse pass — QR reads as part of the
  artwork (modules carry local color, no stark white quiet-zone box, no
  sticker look) while staying findable. Explicitly NOT 'invisible': the
  scan-survival contrast floor is 0.52 dark-gain on textured covers
  (adaptive ladder 2026-09-17; every fainter level fails the stress
  ladder), so a fully hidden QR is out of contract.

## Attack case
- False-pass mode: a weaker detector blesses a contrast level the real
  world will reject. Concretely: cv2.QRCodeDetector accepts dark_gain
  0.74 on a smooth cover where zxing on the crisp PNG fails (eval-4
  2026-09-17) — cv2-pass-with-zxing-fail is exactly the false pass.
- Caught by: g1 is zxing-ONLY, run on RE-SERIALIZED PNG bytes from disk
  (never the in-memory array) plus the external jpeg-q85 — the stress
  ladder must BE the gate, never a weaker fallback of it. A blend level
  that only cv2 likes cannot pass. The g2 muse gate catches the opposite
  failure: bulletproof scan at v1's 0.52-flat that reads as a stark QR
  overlay.

## Lineage
- zcode memory `qr-camo-embed-recipe` (real @Foshowithit header task,
  08-30); v2 adaptive blend + honest gate re-scope during the 09-17
  admission campaign.

## Eval log (append per ship; receipts live in evidence/qr-camo-embed/)
- 2026-09-17 eval-3 ship: v2 on camo texture, full gates, 0.68 gain.
- 2026-09-17 eval-4 fix: ladder/gate mismatch found+fixed (zxing-only
  re-serialized ladder); rerun PASS. eval-4 cover (pale synthetic) FAILED
  g2 — halo square; contract narrowed.
- 2026-09-17 eval-5 fix: real DARK cover — deterministic PASS, muse FAIL
  (halo lifts to light box); orientation bug found+fixed. Contract
  narrowed to mid-tone covers.
- 2026-09-17 eval-6 ship: real bearing-race frame (mid-tone), upright,
  0.80 gain, ALL gates PASS incl. muse 'reads as a watermark, not a
  pasted sticker'.
