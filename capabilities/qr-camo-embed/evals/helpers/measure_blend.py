#!/usr/bin/env python3
"""Blend-signature measurement for the qr-camo-embed eval gates.

Reconstructs the cover canvas exactly as the frozen script does
(make_header_v2.py lines 29-35, verbatim: portrait rotate, LANCZOS resize,
centre crop), then measures the embedded patch region of an output header
against that canvas in the 1500x500 output frame:

  ring44  outer 44 px band of the QR patch (the quiet zone the script's
          quiet_gain drives toward luma ~100)
  box     patch inset by 44 px (the data-module region)
  patch   the whole 407 px patch

Luma is Rec.709 (0.2126/0.7152/0.0722). Prints one JSON object. This file is
committed beside check.js and pinned by the source-identity gate; the frozen
script itself is never imported or modified.
"""
import json
import sys

import numpy as np
from PIL import Image

W, H = 1500, 500


def canvas(src_path):
    img = Image.open(src_path).convert("RGB")
    if img.height > img.width:
        img = img.rotate(-90, expand=True)
    scale = W / img.width
    img = img.resize((W, round(img.height * scale)), Image.LANCZOS)
    top = (img.height - H) // 2
    return np.asarray(img.crop((0, top, W, top + H))).astype(np.float64)


def luma(arr):
    return 0.2126 * arr[..., 0] + 0.7152 * arr[..., 1] + 0.0722 * arr[..., 2]


def measure(cover_path, out_path, x0, y0, qs):
    cv = luma(canvas(cover_path))
    ov = luma(np.asarray(Image.open(out_path).convert("RGB")).astype(np.float64))
    if ov.shape != (H, W):
        return {"error": "output is %dx%d, expected %dx%d" % (ov.shape[1], ov.shape[0], W, H)}
    a, b = y0 + 44, y0 + qs - 44
    c, d = x0 + 44, x0 + qs - 44
    box_c, box_o = cv[a:b, c:d], ov[a:b, c:d]
    yy, xx = np.mgrid[0:H, 0:W]
    in_patch = (xx >= x0) & (xx < x0 + qs) & (yy >= y0) & (yy < y0 + qs)
    in_box = (xx >= c) & (xx < d) & (yy >= a) & (yy < b)
    ring = in_patch & ~in_box
    return {
        "ring44_delta": round(float(ov[ring].mean() - cv[ring].mean()), 2),
        "ring44_out": round(float(ov[ring].mean()), 2),
        "ring44_canvas": round(float(cv[ring].mean()), 2),
        "box_delta": round(float(box_o.mean() - box_c.mean()), 2),
        "box_out": round(float(box_o.mean()), 2),
        "patch_delta": round(float(ov[in_patch].mean() - cv[in_patch].mean()), 2),
    }


if __name__ == "__main__":
    cover, out, x0, y0, qs = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
    print(json.dumps(measure(cover, out, x0, y0, qs)))
