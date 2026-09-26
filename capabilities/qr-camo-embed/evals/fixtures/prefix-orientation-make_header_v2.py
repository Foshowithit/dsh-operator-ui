#!/usr/bin/env python3
"""QR camo embed v2 — adaptive-contrast camouflage blend.

v1 (workspace/default/qr-camo-header/make_header.py) pressed dark modules to
~0.52x local luminance: bulletproof scans, but the finder squares + module
grid read instantly (muse eyes FAIL, 2026-09-17). v2 searches DESCENDING
contrast for the faintest blend that still survives the full stress ladder
(png / jpeg78 / half-size jpeg70 / jpeg85), then adds per-module gain jitter
(seeded, deterministic) and keeps more bark grain inside modules so no flat
square shows. Contract: payloads short enough that the QR fits the 1500x500
placement window at MODULE=11 (~<=35 chars URL at ERROR_CORRECT_H).
"""
import sys
import cv2
import numpy as np
import qrcode
import zxingcpp
from PIL import Image, ImageFilter

SRC = "camo-src.png"
OUT_PNG = "camo-qr-header.png"
URL = sys.argv[1] if len(sys.argv) > 1 else "https://optimizedworkflow.dev"
W, H = 1500, 500
MODULE = 11
rng = np.random.default_rng(20260917)

# --- 1. cover prep (unchanged from v1) ---
img = Image.open(SRC).convert("RGB").rotate(-90, expand=True)
scale = W / img.width
img = img.resize((W, round(img.height * scale)), Image.LANCZOS)
top = (img.height - H) // 2
header = img.crop((0, top, W, top + H))
bg0 = np.asarray(header).astype(np.float32)

# --- 2. QR matrix; plain-QR sanity before any camo ---
qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, border=4)
qr.add_data(URL)
qr.make(fit=True)
matrix = np.array(qr.get_matrix(), dtype=np.uint8)
print(f"QR version {qr.version}, {matrix.shape[0]}x{matrix.shape[1]} modules")
qs = matrix.shape[0] * MODULE
_plain = np.asarray(
    Image.fromarray(np.where(matrix, 0, 255).astype(np.uint8)).resize((qs, qs), Image.NEAREST)
)
_res = zxingcpp.read_barcodes(cv2.cvtColor(_plain, cv2.COLOR_GRAY2BGR))
assert _res and _res[0].text == URL, f"plain QR sanity failed: {_res!r}"
qr_img = ~(_plain > 128)

if qs > H - 40 or qs > W - int(W * 0.55) - 40:
    sys.exit(f"payload too long: QR {qs}px does not fit the {W}x{H} placement window")

# --- 3. smoothest mid-tone placement, right half (unchanged) ---
gray = cv2.cvtColor(bg0.astype(np.uint8), cv2.COLOR_RGB2GRAY)
pad = 20
best, best_score = None, 1e18
for y in range(pad, H - qs - pad, 20):
    for x in range(int(W * 0.55), W - qs - pad, 20):
        patch = gray[y : y + qs, x : x + qs]
        score = patch.std() + abs(float(patch.mean()) - 110) * 0.3
        if score < best_score:
            best_score, best = score, (x, y)
x0, y0 = best
print(f"placed at ({x0},{y0}), smoothness score {best_score:.1f}")

ring = (
    np.kron(
        np.pad(np.zeros((matrix.shape[0] - 8, matrix.shape[0] - 8), dtype=bool), 4, constant_values=True),
        np.ones((MODULE, MODULE), dtype=bool),
    )
    & ~qr_img
)

region = bg0[y0 : y0 + qs, x0 : x0 + qs]
flat = region.copy()
for my in range(0, qs, MODULE):
    for mx in range(0, qs, MODULE):
        blk = region[my : my + MODULE, mx : mx + MODULE]
        flat[my : my + MODULE, mx : mx + MODULE] = blk.mean(axis=(0, 1))
L = np.maximum(flat.mean(axis=2, keepdims=True), 1.0)

# feathered edge alpha (unchanged)
feather = 14
alpha = np.ones((qs, qs), dtype=np.float32)
ramp = np.linspace(0, 1, feather)
alpha[:feather, :] *= ramp[:, None]; alpha[-feather:, :] *= ramp[::-1][:, None]
alpha[:, :feather] *= ramp[None, :]; alpha[:, -feather:] *= ramp[::-1][None, :]

# --- 4. adaptive-contrast blend: faintest dark gain that survives the ladder ---
# The ladder must BE the gate: zxing-only decode of re-serialized PNG bytes
# (never an in-memory array, never the cv2 detector as a fallback — on smooth
# covers cv2 passes at contrasts where zxing on the crisp PNG fails, which is
# exactly how eval-4 2026-09-17 slipped through the first ladder version).
def stress_pass(arr):
    a = cv2.cvtColor(np.clip(arr, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
    ok, buf = cv2.imencode(".png", a)
    assert ok
    from_disk = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    def decode_z(b):
        r = zxingcpp.read_barcodes(b)
        return r[0].text if r else ""
    def jpeg(b, q):
        return cv2.imdecode(cv2.imencode(".jpg", b, [cv2.IMWRITE_JPEG_QUALITY, q])[1], cv2.IMREAD_COLOR)
    small = cv2.resize(a, (W // 2, H // 2), interpolation=cv2.INTER_AREA)
    return all(decode_z(x) == URL for x in (from_disk, jpeg(a, 78), jpeg(small, 70), jpeg(a, 85)))

def build(dark_top, jitter, texture):
    b = bg0.copy()
    reg = b[y0 : y0 + qs, x0 : x0 + qs]
    g = rng.uniform(1.0 - jitter, 1.0, size=qr_img.shape).astype(np.float32)
    dark_gain = np.minimum(dark_top, 96.0 / L[..., 0]) * g
    light_gain = np.clip(104.0 / L[..., 0], 1.0, 122.0 / L[..., 0])
    quiet_gain = np.clip(100.0 / L[..., 0], 1.0, 122.0 / L[..., 0])
    gain = np.where(qr_img, dark_gain, np.where(ring, quiet_gain, light_gain))[..., None]
    blended = np.clip(flat * gain + texture * (reg - flat), 0, 255)
    b[y0 : y0 + qs, x0 : x0 + qs] = blended * alpha[..., None] + reg * (1 - alpha[..., None])
    return b

chosen = None
for dark_top in (0.80, 0.74, 0.68, 0.62, 0.56, 0.52):
    cand = build(dark_top, jitter=0.10, texture=0.18)
    if stress_pass(cand):
        chosen = (dark_top, cand)
        break
if chosen is None:
    sys.exit("no contrast level survived the stress ladder — payload or cover unusable")
dark_top, bg = chosen
print(f"adaptive contrast: dark_gain top {dark_top} (v1 used 0.52 flat)")

out = Image.fromarray(np.clip(bg, 0, 255).astype(np.uint8))
out.save(OUT_PNG)
print("ALL SCANS PASS (stress ladder at minimal visible contrast)")
