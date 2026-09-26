#!/usr/bin/env python3
"""video-forensics-receipt — measure a video file against a craft register.

Turns the anti-slop law into a receipt. Measures loudness, dynamic range, true
peak, canvas luma, canvas saturation and a hold profile, then asserts them
against the measured envelope for the declared register. Every metric
definition is written into the receipt so no reader has to guess how a number
was produced.

Bands come from creative-study/PLAYBOOK.md (receipt-cited per-class envelopes,
118 rounds / 122 films). They are envelopes, not laws - a value outside the band
is a finding to read, not automatically a defect. Gates below encode only the
ones the classes actually agree on.

usage:
  forensics.py <video> --register explainer|brand|kinetic [--json <out>]

exit codes: 0 pass · 2 bad usage · 3 gate fail · 4 tooling missing
"""

import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

# Portable tool resolution: an explicit env override wins, otherwise whatever is
# on PATH. There is no machine-specific fallback path — a host whose ffmpeg lives
# somewhere unusual puts it on PATH (or names it in FFMPEG/FFPROBE), and a host
# without ffmpeg gets the documented exit 4 "tooling missing" rather than a
# hardcoded path that only resolves on one machine.
FFMPEG = os.environ.get('FFMPEG') or shutil.which('ffmpeg')
FFPROBE = os.environ.get('FFPROBE') or shutil.which('ffprobe')

# ------------------------------------------------------------------ analysis
# Motion is measured on a downscale, and the downscale sets the sensitivity:
# bicubic averaging attenuates small moving elements, so a 160x90 probe reads
# a piece with 24 cuts as nearly static. 480x270 keeps the signal usable while
# staying cheap. This is declared in the receipt because it is part of the
# measurement, not an implementation detail.
ANALYSIS_W, ANALYSIS_H = 480, 270

# The rate probe samples adjacent frames. Its absolute scale depends on frame
# rate and content, so it is REPORTED as a diagnostic and NOT gated.
RATE_FPS = 10

# The hold probe samples once per second and diffs adjacent samples, so each
# sample IS the change across a one-second window. A hold is a window in which
# the picture is essentially unchanged - which adjacent-frame differencing
# cannot detect, because a slow continuous drift also yields tiny per-frame
# deltas while the cumulative change is large.
HOLD_BASELINE_FPS = 1

# Normalised mean absolute luma change (0..1). 1/255 = 0.0039 is below one
# code value of mean change across the frame; at that level the picture is
# visually the same picture. Measured floor on a libx264 CRF-17 1080p piece:
# min adjacent-frame delta 0.0028 raw, i.e. 1.1e-5 normalised, so 0.004 sits
# far above codec noise and cannot be tripped by compression.
HOLD_EPS = 0.004
# A hold lane is legal craft. A piece that is MOSTLY holds is a slideshow.
HOLD_SHARE_MAX = 0.40
# No single near-static span may run longer than this.
HOLD_MAX_S = 5.0

# ---------------------------------------------------------------- registers
# (lufs_lo, lufs_hi, lra_lo, lra_hi, luma_lo, luma_hi, sat_lo, sat_hi)
# None = not gated for this register.
REGISTERS = {
    'explainer': dict(lufs=(-19.9, -14.3), lra=(2.8, 6.5),
                      luma=(0.06, 0.49), sat=(0.10, 0.86),
                      source='PLAYBOOK class E, n=8'),
    'brand':     dict(lufs=(-23.0, -11.2), lra=(None, 11.0),
                      luma=(0.26, 0.53), sat=(0.21, 0.31),
                      source='PLAYBOOK class I, n=9'),
    'kinetic':   dict(lufs=(-22.0, -18.0), lra=(None, None),
                      luma=(None, 0.20), sat=(None, None),
                      source='PLAYBOOK class Ty (score-mastered canvas)'),
}

METRIC_DEFS = {
    'loudness': 'ffmpeg ebur128=peak=true, audio-only (-vn). Values read from '
                'the summary block only - ebur128 also streams a per-frame '
                'line carrying the same labels, whose first sample reads '
                'I: -70.0 LUFS.',
    'canvas':   f'signalstats over fps=2,scale={ANALYSIS_W}:{ANALYSIS_H}; '
                'YAVG/255 and SATAVG/255 averaged over all samples.',
    'motion_rate': f'tblend=all_mode=difference over fps={RATE_FPS},'
                   f'scale={ANALYSIS_W}:{ANALYSIS_H},format=gray; mean YAVG/255. '
                   'Diagnostic only - scale depends on frame rate and content.',
    'hold':     f'tblend=all_mode=difference over fps={HOLD_BASELINE_FPS},'
                f'scale={ANALYSIS_W}:{ANALYSIS_H},format=gray. Each sample is '
                'the mean absolute luma change across a 1s window. A window is '
                f'"held" when it is below {HOLD_EPS}. longest_hold_s is the '
                'longest run of consecutive held windows, in seconds.',
}


def probe(path):
    out = subprocess.run([
        FFPROBE, '-v', 'error', '-show_entries',
        'format=duration,size,bit_rate:stream=index,codec_type,codec_name,'
        'width,height,r_frame_rate,bit_rate',
        '-of', 'json', str(path)], capture_output=True, text=True).stdout
    d = json.loads(out)
    streams = d.get('streams', [])
    v = next((s for s in streams if s.get('codec_type') == 'video'), {})
    a = next((s for s in streams if s.get('codec_type') == 'audio'), None)

    fps_raw = v.get('r_frame_rate') or '0/1'
    try:
        num, den = fps_raw.split('/')
        fps = round(float(num) / float(den), 3) if float(den) else None
    except (ValueError, ZeroDivisionError):
        fps = None

    return {
        'duration': round(float(d['format']['duration']), 3),
        'size_bytes': int(d['format']['size']),
        'video_codec': v.get('codec_name'),
        'width': v.get('width'), 'height': v.get('height'),
        'fps': fps, 'fps_raw': fps_raw,
        'video_bitrate': int(v['bit_rate']) if v.get('bit_rate') else None,
        'has_audio': a is not None,
        'audio_codec': a.get('codec_name') if a else None,
        'audio_bitrate': int(a['bit_rate']) if a and a.get('bit_rate') else None,
    }


def _summary_block(text):
    """ebur128 streams a per-frame line before the summary, and that streaming
    line also carries `I:`, `LRA:` and `TPK:`. Searching the whole stderr finds
    the first frame's `I: -70.0 LUFS` and reports it as the integrated value.
    Only the block after the last `Summary:` is authoritative."""
    i = text.rfind('Summary:')
    return text[i:] if i >= 0 else text


def _field(block, header, label):
    """Value of `label` inside the section introduced by `header`."""
    m = re.search(re.escape(header) + r'[\s\S]{0,80}?' +
                  re.escape(label) + r'\s*(-?[\d.]+)', block)
    return float(m.group(1)) if m else None


def loudness(path):
    """ebur128 summary: integrated LUFS, LRA, true peak. Audio-only decode."""
    p = subprocess.run([FFMPEG, '-hide_banner', '-i', str(path), '-vn',
                        '-af', 'ebur128=peak=true', '-f', 'null', '-'],
                       capture_output=True, text=True)
    t = p.stderr
    s = _summary_block(t)

    def last(pat):
        """Fallback: last match anywhere, if the summary section is absent
        (older ffmpeg builds label the block differently)."""
        m = re.findall(pat, t)
        return float(m[-1]) if m else None

    lufs = _field(s, 'Integrated loudness:', 'I:')
    lra = _field(s, 'Loudness range:', 'LRA:')
    tp = _field(s, 'True peak:', 'Peak:')
    if lufs is None:
        lufs = last(r'I:\s*(-?[\d.]+)\s*LUFS')
    if lra is None:
        lra = last(r'LRA:\s*(-?[\d.]+)\s*LU')
    if tp is None:
        tp = last(r'TPK:\s*(-?[\d.]+)')
    return {
        'lufs': lufs,
        'lra': lra,
        'true_peak_dbfs': tp,
        'summary_found': 'Summary:' in t,
    }


def canvas(path, fps=2):
    """Mean luma and saturation over the piece, via signalstats."""
    p = subprocess.run([
        FFMPEG, '-hide_banner', '-i', str(path), '-vf',
        f'fps={fps},scale={ANALYSIS_W}:{ANALYSIS_H},signalstats,'
        'metadata=print:file=-',
        '-an', '-f', 'null', '-'], capture_output=True, text=True)
    ys, ss = [], []
    for line in (p.stdout + p.stderr).splitlines():
        m = re.search(r'YAVG=([\d.]+)', line)
        if m:
            ys.append(float(m.group(1)) / 255.0)
        m = re.search(r'SATAVG=([\d.]+)', line)
        if m:
            ss.append(float(m.group(1)) / 255.0)
    return {
        'luma': round(sum(ys) / len(ys), 4) if ys else None,
        'saturation': round(sum(ss) / len(ss), 4) if ss else None,
        'samples': len(ys),
    }


def _diff_series(path, fps):
    """Mean absolute luma difference between adjacent samples at `fps`."""
    p = subprocess.run([
        FFMPEG, '-hide_banner', '-i', str(path), '-vf',
        f'fps={fps},scale={ANALYSIS_W}:{ANALYSIS_H},format=gray,'
        'tblend=all_mode=difference,signalstats,metadata=print:file=-',
        '-an', '-f', 'null', '-'], capture_output=True, text=True)
    vals = []
    for line in (p.stdout + p.stderr).splitlines():
        m = re.search(r'YAVG=([\d.]+)', line)
        if m:
            vals.append(float(m.group(1)) / 255.0)
    return vals


def _longest_run(flags):
    """(length, start_index) of the longest run of True."""
    best = cur = 0
    start = bstart = 0
    for i, f in enumerate(flags):
        if f:
            if cur == 0:
                start = i
            cur += 1
            if cur > best:
                best, bstart = cur, start
        else:
            cur = 0
    return best, bstart


def motion(path):
    """Rate probe (diagnostic) + hold probe (gated)."""
    rate = _diff_series(path, RATE_FPS)
    hold = _diff_series(path, HOLD_BASELINE_FPS)

    out = {
        'motion_rate': round(sum(rate) / len(rate), 5) if rate else None,
        'rate_samples': len(rate),
        'hold_windows': len(hold),
        'hold_eps': HOLD_EPS,
    }
    if not hold:
        out.update({'hold_share': None, 'longest_hold_s': None,
                    'longest_hold_at_s': None})
        return out

    flags = [v < HOLD_EPS for v in hold]
    run, start = _longest_run(flags)
    out.update({
        'hold_share': round(sum(flags) / len(flags), 4),
        'longest_hold_s': run,
        'longest_hold_at_s': start,
        'hold_series': [round(v, 5) for v in hold],
    })
    return out


def in_band(v, lo, hi):
    if v is None:
        return None
    if lo is not None and v < lo:
        return False
    if hi is not None and v > hi:
        return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('--register', required=True, choices=sorted(REGISTERS))
    ap.add_argument('--json', dest='json_out')
    a = ap.parse_args()

    path = pathlib.Path(a.video)
    if not path.exists():
        print(f'FATAL: no such file: {path}', file=sys.stderr)
        return 2
    for tool in (FFMPEG, FFPROBE):
        if not tool or not pathlib.Path(tool).exists():
            print(f'FATAL: tooling missing: {tool or "(ffmpeg/ffprobe not found on PATH)"}',
                  file=sys.stderr)
            return 4

    band = REGISTERS[a.register]
    rec = {
        'schema': 'video-forensics-receipt/1',
        'file': str(path),
        'register': a.register,
        'band_source': band['source'],
        'analysis': {'width': ANALYSIS_W, 'height': ANALYSIS_H,
                     'rate_fps': RATE_FPS, 'hold_baseline_fps': HOLD_BASELINE_FPS},
        'thresholds': {'hold_eps': HOLD_EPS,
                       'hold_share_max': HOLD_SHARE_MAX,
                       'hold_max_s': HOLD_MAX_S},
        'metric_defs': METRIC_DEFS,
        'probe': probe(path),
    }
    rec['loudness'] = loudness(path)
    rec['canvas'] = canvas(path)
    rec['motion'] = motion(path)

    checks = []

    def add(cid, val, lo, hi, ok, unit=None):
        checks.append((cid, val, lo, hi, ok, unit))

    lo, hi = band['lufs']
    add('loudness-in-band', rec['loudness']['lufs'], lo, hi,
        in_band(rec['loudness']['lufs'], lo, hi), 'LUFS')
    lo, hi = band['lra']
    add('lra-in-band', rec['loudness']['lra'], lo, hi,
        in_band(rec['loudness']['lra'], lo, hi), 'LU')
    lo, hi = band['luma']
    add('luma-in-band', rec['canvas']['luma'], lo, hi,
        in_band(rec['canvas']['luma'], lo, hi))
    lo, hi = band['sat']
    add('saturation-in-band', rec['canvas']['saturation'], lo, hi,
        in_band(rec['canvas']['saturation'], lo, hi))

    # ---- motion gates, shared by every register ----------------------------
    hs = rec['motion']['hold_share']
    add('no-dead-frames', hs, None, HOLD_SHARE_MAX,
        None if hs is None else hs <= HOLD_SHARE_MAX, 'share')

    lh = rec['motion']['longest_hold_s']
    add('no-long-hold', lh, None, HOLD_MAX_S,
        None if lh is None else lh <= HOLD_MAX_S, 's')

    rec['checks'] = [
        {'id': cid, 'value': v, 'lo': lo, 'hi': hi,
         'pass': (None if p is None else bool(p)), 'unit': unit}
        for cid, v, lo, hi, p, unit in checks
    ]

    fails = [c for c in rec['checks'] if c['pass'] is False]
    rec['verdict'] = 'PASS' if not fails else 'FAIL'

    # ---- report ------------------------------------------------------------
    pr = rec['probe']
    print(f"{path.name}  {pr['width']}x{pr['height']}  {pr['duration']}s  "
          f"{pr['fps']}fps  {pr['video_codec']}"
          + (f" + {pr['audio_codec']}" if pr['has_audio'] else ' (no audio)'))
    print(f"register: {a.register}  ({band['source']})")
    print(f"analysis: {ANALYSIS_W}x{ANALYSIS_H}  rate@{RATE_FPS}fps  "
          f"hold baseline 1s  hold eps {HOLD_EPS}\n")
    print(f"  {'metric':<22} {'value':>10}   {'band':<18} verdict")
    for c in rec['checks']:
        u = c.get('unit') or ''
        su = f' {u}' if u else ''
        lo_s = '-' if c['lo'] is None else f"{c['lo']}{su}"
        hi_s = '-' if c['hi'] is None else f"{c['hi']}{su}"
        v = '-' if c['value'] is None else f"{c['value']}{su}"
        mark = 'n/a' if c['pass'] is None else ('ok' if c['pass'] else 'OUT')
        print(f"  {c['id']:<22} {v:>11}   {f'{lo_s} .. {hi_s}':<21} {mark}")

    mo = rec['motion']
    print(f"\n  motion rate {mo['motion_rate']}  ({mo['rate_samples']} adjacent "
          f"samples @ {RATE_FPS}fps)")
    print(f"  hold share {mo['hold_share']}  longest hold {mo['longest_hold_s']}s"
          + (f" at t={mo['longest_hold_at_s']}s" if mo.get('longest_hold_at_s')
             else '')
          + f"  ({mo['hold_windows']} windows @ 1s)")
    if pr['has_audio'] and not rec['loudness']['summary_found']:
        print('  note: ebur128 summary block not found; loudness values came '
              'from the last streaming line')

    if a.json_out:
        pathlib.Path(a.json_out).write_text(json.dumps(rec, indent=1))
        print(f"\n  receipt -> {a.json_out}")

    if fails:
        print(f"\nVERDICT: FAIL  ({len(fails)} gate(s) outside band)")
        for c in fails:
            print(f"  - {c['id']}: {c['value']} outside {c['lo']}..{c['hi']}")
        return 3
    print('\nVERDICT: PASS')
    return 0


if __name__ == '__main__':
    sys.exit(main())
