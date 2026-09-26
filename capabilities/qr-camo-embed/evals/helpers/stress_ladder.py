#!/usr/bin/env python3
"""Decode stress ladder for the qr-camo-embed eval gates.

Mirrors the frozen script's own acceptance test (make_header_v2.py
stress_pass, lines 96-107) leg for leg on a shipped header PNG:

  disk      PNG re-serialization round-trip (imencode -> imdecode)
  jpeg78    full-size JPEG re-encode at quality 78
  halfsize  half-size INTER_AREA resize saved as JPEG quality 70
  jpeg85    full-size JPEG re-encode at quality 85

The script runs this ladder with zxing ONLY, on decoded BGR arrays — never
an in-memory pre-encode array, never the cv2 detector as a fallback (on
smooth covers cv2 passes at contrasts where zxing on the re-serialized PNG
fails, which is exactly how eval-4 slipped through the first ladder). This
helper reproduces that oracle lane unchanged. Prints one JSON object:
  {"url": <decoded or null>, "legs": {leg: url-or-null}, "all_pass": bool}

Usage: stress_ladder.py <png> <expected-url>
Committed beside check.js and pinned by the source-identity gate; the frozen
script itself is never imported or modified.
"""
import json
import sys

import cv2
import numpy as np
import zxingcpp


def decode_z(b):
    r = zxingcpp.read_barcodes(b)
    return r[0].text if r else None


def jpeg(b, q):
    return cv2.imdecode(
        cv2.imencode(".jpg", b, [cv2.IMWRITE_JPEG_QUALITY, q])[1],
        cv2.IMREAD_COLOR)


def ladder(png_path):
    a = cv2.imdecode(np.fromfile(png_path, dtype=np.uint8), cv2.IMREAD_COLOR)
    if a is None:
        return None
    ok, buf = cv2.imencode(".png", a)
    if not ok:
        return None
    from_disk = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    small = cv2.resize(a, (a.shape[1] // 2, a.shape[0] // 2),
                       interpolation=cv2.INTER_AREA)
    return {
        "disk": decode_z(from_disk),
        "jpeg78": decode_z(jpeg(a, 78)),
        "halfsize": decode_z(jpeg(small, 70)),
        "jpeg85": decode_z(jpeg(a, 85)),
    }


if __name__ == "__main__":
    png_path, expected = sys.argv[1], sys.argv[2]
    legs = ladder(png_path)
    if legs is None:
        print(json.dumps({"url": None, "legs": None, "all_pass": False,
                          "error": "unreadable png: %s" % png_path}))
        sys.exit(0)
    all_pass = all(v == expected for v in legs.values())
    print(json.dumps({"url": legs["disk"], "legs": legs, "all_pass": all_pass}))
