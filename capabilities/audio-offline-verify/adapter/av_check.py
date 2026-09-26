#!/usr/bin/env python3
"""Offline A/V container + loudness verifier — proves a produced media file's
stream layout and (optionally) that its audio actually sounds, without ever
playing it.

Why: silent/cut/truncated muxes ship as "done" because the file exists and
plays. ffprobe layout assertions + an RMS floor catch the mute-file and
wrong-duration cases deterministically. Loudness values are REPORTED either
way so runs are comparable.

Usage:
  av_check.py <file> [--expect-video h264] [--expect-audio aac|none]
                     [--min-duration S] [--max-duration S]
                     [--audio-must-sound]      # RMS floor -60 dBFS becomes a gate
Exit 0 all gates pass; 3 gate failure; 4 cannot probe.

Tool resolution (portable port): the ffprobe/ffmpeg binaries are found via
$AV_CHECK_FFPROBE / $AV_CHECK_FFMPEG when set, else on PATH. The upstream
artifact this port derives from pinned absolute build paths; that is the only
behavioral difference, and the ffmpeg binary actually used is part of the run
record (see tool lines in the output).
"""
import json
import os
import re
import shutil
import subprocess
import sys


def resolve_tool(env_var, name):
  override = os.environ.get(env_var)
  if override:
    return override
  found = shutil.which(name)
  if found:
    return found
  print(f"PROBE_FAIL {name} not found (set {env_var} or put {name} on PATH)")
  sys.exit(4)


FFPROBE = resolve_tool("AV_CHECK_FFPROBE", "ffprobe")
FFMPEG = resolve_tool("AV_CHECK_FFMPEG", "ffmpeg")
print(f"tool ffprobe {FFPROBE}")
print(f"tool ffmpeg {FFMPEG}")


def arg(name, default=None):
  if name in sys.argv:
    return sys.argv[sys.argv.index(name) + 1]
  return default


path = sys.argv[1]
expect_video = arg("--expect-video", "h264")
expect_audio = arg("--expect-audio")  # default: any (report); 'none' = must be absent
min_dur = float(arg("--min-duration", "0"))
max_dur = float(arg("--max-duration", "1e9"))
must_sound = "--audio-must-sound" in sys.argv

probe = subprocess.run(
    [FFPROBE, "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
    capture_output=True, text=True)
if probe.returncode != 0:
    print(f"PROBE_FAIL {probe.stderr.strip()[:120]}")
    sys.exit(4)
info = json.loads(probe.stdout)
streams = info.get("streams", [])
dur = float(info.get("format", {}).get("duration", 0))
v = next((s for s in streams if s.get("codec_type") == "video"), None)
a = next((s for s in streams if s.get("codec_type") == "audio"), None)

fail = []
print(f"file {path}")
print(f"container duration {dur:.3f}s  streams: "
      f"{', '.join(s.get('codec_name', '?') for s in streams)}")
if not v:
    fail.append("NO_VIDEO_STREAM")
else:
    print(f"video {v.get('codec_name')} {v.get('width')}x{v.get('height')}")
    if expect_video and v.get("codec_name") != expect_video:
        fail.append(f"VIDEO_CODEC {v.get('codec_name')} != {expect_video}")
if expect_audio == "none":
    if a:
        fail.append(f"AUDIO_PRESENT expected none (got {a.get('codec_name')})")
elif a:
    print(f"audio {a.get('codec_name')} {a.get('sample_rate', '?')}Hz "
          f"{a.get('channels', '?')}ch")
    if expect_audio and a.get("codec_name") != expect_audio:
        fail.append(f"AUDIO_CODEC {a.get('codec_name')} != {expect_audio}")
if not (min_dur <= dur <= max_dur):
    fail.append(f"DURATION {dur:.3f} outside [{min_dur}, {max_dur}]")

rms_dbfs = None
if a:
    ast = subprocess.run(
        [FFMPEG, "-nostats", "-i", path, "-map", f"0:a:0", "-af", "astats=measure_overall=RMS_level:measure_perchannel=none", "-f", "null", "-"],
        capture_output=True, text=True)
    m = re.search(r"RMS level dB:\s*(-?[\d.]+|inf|-inf)", ast.stderr)
    if m:
        tok = m.group(1)
        rms_dbfs = None if "inf" in tok else float(tok)
        print(f"audio RMS {tok} dBFS")
    else:
        print("audio RMS unparseable")
if must_sound:
    if not a:
        fail.append("MUST_SOUND but no audio stream")
    elif rms_dbfs is None or rms_dbfs < -60.0:
        fail.append(f"MUST_SOUND but RMS {rms_dbfs} dBFS below -60 floor (silent track)")

if fail:
    for f in fail:
        print("FAIL " + f)
    sys.exit(3)
print("AV_CHECK_PASS")
