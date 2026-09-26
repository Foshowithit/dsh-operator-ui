#!/usr/bin/env python3
"""Detector-separation control for the qr-camo-embed eval gates.

Encodes the eval-4 lesson as a measured control: on this capability's output
the oracle lane is zxing-cpp on re-serialized PNG bytes and cv2.QRCodeDetector
is strictly weaker — on smooth covers cv2 passes at contrasts where zxing on
the crisp PNG fails, so a cv2-as-oracle gate would have false-passed decayed
output. The control mixes the shipped header back toward its cover canvas
(the embedded payload decays) and runs BOTH detectors on identical
re-serialized representations at each fade:

  fade 0.10  both decode the url          (payload still strong)
  fade 0.15  zxing decodes, cv2 misses    (the separation itself)
  fade 0.20  zxing misses too             (payload genuinely gone)

Fails its purpose if the measured separation ever flips.

Usage: decode_controls.py <header.png> <cover.png> <x0> <y0> <qs> <url>
Prints one JSON object {"legs": {"0.10": {"zxing": .., "cv2": ..}, ...}}.
Committed beside check.js and pinned by the source-identity gate; the frozen
script itself is never imported or modified.
"""
import json
import sys

import cv2
import numpy as np

from measure_blend import canvas

W, H = 1500, 500


def zxing_read(bgr):
    import zxingcpp
    r = zxingcpp.read_barcodes(bgr)
    return r[0].text if r else None


def cv2_read(bgr):
    try:
        res = cv2.QRCodeDetector().detectAndDecode(bgr)[0]
    except cv2.error:
        return None
    return res or None


def reserialize(bgr):
    ok, buf = cv2.imencode(".png", bgr)
    if not ok:
        return None
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


if __name__ == "__main__":
    from PIL import Image
    out_path, cover_path = sys.argv[1], sys.argv[2]
    x0, y0, qs = int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
    url = sys.argv[6]

    out = np.asarray(Image.open(out_path).convert("RGB")).astype("float64")
    cv = canvas(cover_path)
    yy, xx = np.mgrid[0:H, 0:W]
    in_patch = (xx >= x0) & (xx < x0 + qs) & (yy >= y0) & (yy < y0 + qs)

    legs = {}
    for fade in (0.10, 0.15, 0.20):
        mixed = out.copy()
        mixed[in_patch] = (1.0 - fade) * out[in_patch] + fade * cv[in_patch]
        bgr = reserialize(cv2.cvtColor(
            np.clip(mixed, 0, 255).astype("uint8"), cv2.COLOR_RGB2BGR))
        legs["%.2f" % fade] = {"zxing": zxing_read(bgr), "cv2": cv2_read(bgr)}

    print(json.dumps({"legs": legs}))
