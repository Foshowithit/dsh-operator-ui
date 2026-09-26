#!/bin/sh
# Generates the video fixtures for evals/filmstrip-verify-protocol-v1.
#
# Self-locating: it writes into the directory it lives in, so the package's inputs can be rebuilt
# from a clean checkout without editing a path. (The first draft of this script lived in /tmp and
# used `cd "$(dirname "$0")/.."`, which from /tmp resolves to `/` and tried to `mkdir /evals`. A
# generator that only runs from one machine's scratch directory is not a reproducible fixture.)
#
# Everything here is lavfi + x264: no network, no source media, no external asset. Flat-colour
# sources compress to a few hundred KB, so the fixtures are cheap to keep in git.
#
#   cut-continuous.mp4   20s  continuous motion at every 1s sample + an in-band bed   -> all legs pass
#   slideshow-holds.mp4  18s  six 3-second solid-colour holds + the same bed          -> no-slideshow fails on the SHARE arm
#   long-hold.mp4        28s  motion except one 8-second static window + the same bed -> no-slideshow fails on the LONGEST arm
#   silent-motion.mp4    12s  continuous motion, NO audio stream                      -> audio-bed fails (no stream)
#   quiet-bed.mp4        14s  continuous motion + a bed at -40 dB                     -> audio-bed fails (below the floor)
#   hot-bed.mp4          10s  continuous motion + a bed at +18 dB                     -> audio-bed fails (above the ceiling)
#
# Each fixture isolates exactly one arm of exactly one leg. The two no-slideshow fixtures are a pair
# because that leg is an AND of two thresholds (hold_share <= 0.40 AND longest_hold_s <= 5.0); one
# slideshow fixture would only ever prove one arm is live, and a bug that hardcoded the other arm
# would pass every gate in the package. The three audio fixtures are a triple for the same reason:
# "no stream at all", "a stream too quiet to be a bed" and "a stream too hot to be a master" fail
# through three different code paths (a null from the stream probe, and two ends of one comparison).
#
# TWO TOOL FACTS THIS SCRIPT ENCODES, both found by measuring rather than by reading:
#
#  1. `drawbox` does NOT re-evaluate its x/y expressions per frame. `drawbox=x='mod(t*135,525)-45'`
#     draws the box once at its t=0 position and leaves it there: the clip is a still image, every
#     1s difference sample reads 0, and a fixture built that way measures as a perfect slideshow.
#     `overlay` DOES re-evaluate per frame, which is what the motion sprites below use. (`drawbox`'s
#     `enable` timeline option IS honoured per frame, so the slideshow fixture can still use it for
#     its full-frame colour changes.)
#
#  2. lavfi's `sine` has amplitude 1/8, not 1.0, so an unfiltered 220 Hz sine measures -21.1 dBFS
#     (a full-scale sine would be -3.0). The in-band fixture therefore needs NO volume filter, and
#     the quiet/hot fixtures are offsets from -21.1: -40 dB -> -61.1 (under the -45 floor),
#     +18 dB -> -3.6 (over the -6 ceiling).
set -eu

cd "$(dirname "$0")"

FFMPEG=${FFMPEG:-ffmpeg}
V="-hide_banner -loglevel error -y"

# 480x270 is the adapter's own analysis geometry (ANALYSIS_W/ANALYSIS_H). Authoring at that size
# removes a resampling step from the fixture, so what the measurement sees is what was drawn.
W=480
H=270
FPS=24

VIDEO="-c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p"
AUDIO="-c:a aac -b:a 64k"

# A 45x90 box crossing the frame at 135 px/s, plus a full-width 6px bar climbing it at 67 px/s.
# Both are pure functions of t, so every 1-second baseline sample sees real change. The measured
# difference is ~5.7/255 = 0.022, about 5x the adapter's 0.004 hold threshold.
MOTION="[0:v][1:v]overlay=x='mod(t*135,525)-45':y=90[m];[m][2:v]overlay=x=0:y='mod(t*67,270)'[v]"

# Six stills, three seconds each. The base colour covers [0,3) and each drawbox covers one later
# 3-second window, so the frame changes only at the 3s boundaries — which is exactly a slideshow.
# Kept as one literal string rather than assembled by concatenation: a filtergraph that is only
# correct after five shell appends is a filtergraph nobody can read in a diff.
SLIDES="[0:v]drawbox=x=0:y=0:w=480:h=270:color=0x1f6f8b:t=fill:enable='gte(t,3)*lt(t,6)',drawbox=x=0:y=0:w=480:h=270:color=0xe0b354:t=fill:enable='gte(t,6)*lt(t,9)',drawbox=x=0:y=0:w=480:h=270:color=0xff5a3c:t=fill:enable='gte(t,9)*lt(t,12)',drawbox=x=0:y=0:w=480:h=270:color=0xf6f1e7:t=fill:enable='gte(t,12)*lt(t,15)',drawbox=x=0:y=0:w=480:h=270:color=0x2b3a4a:t=fill:enable='gte(t,15)*lt(t,18)'[v]"

# The same moving box, switched off for t in [6,14). The frame is then a flat colour and genuinely
# identical between samples, so the run of holds is real rather than an artefact of low contrast.
# A static window of length L yields L-1 zero samples (the two samples that straddle the window
# edges still see the sprite appear or vanish), so 8s of stillness gives longest_hold_s = 7 —
# comfortably over the 5.0 threshold — while 7 holds out of 27 samples is 0.259, comfortably under
# the 0.40 share threshold. That separation is what isolates this fixture's arm from slideshow-holds.
LONGHOLD="[0:v][1:v]overlay=x='mod(t*135,525)-45':y=90:enable='lt(t,6)+gte(t,14)'[v]"

# --- 1. continuous motion + an in-band bed -------------------------------------------------
# No volume filter: the raw sine already sits at -21.1 dBFS, mid-band.
$FFMPEG $V -f lavfi -i "color=c=0x102030:s=${W}x${H}:d=20:r=${FPS}" \
  -f lavfi -i "color=c=0xff5a3c:s=45x90:d=20:r=${FPS}" \
  -f lavfi -i "color=c=0xf6f1e7:s=480x6:d=20:r=${FPS}" \
  -f lavfi -i "sine=frequency=220:sample_rate=48000:duration=20" \
  -filter_complex "$MOTION" -map "[v]" -map 3:a \
  $VIDEO $AUDIO -shortest cut-continuous.mp4

# --- 2. six 3-second holds + the same bed --------------------------------------------------
$FFMPEG $V -f lavfi -i "color=c=0x0b1a2a:s=${W}x${H}:d=18:r=${FPS}" \
  -f lavfi -i "sine=frequency=220:sample_rate=48000:duration=18" \
  -filter_complex "$SLIDES" -map "[v]" -map 1:a \
  $VIDEO $AUDIO -shortest slideshow-holds.mp4

# --- 3. one long hold inside otherwise-continuous motion -----------------------------------
$FFMPEG $V -f lavfi -i "color=c=0x101820:s=${W}x${H}:d=28:r=${FPS}" \
  -f lavfi -i "color=c=0xff5a3c:s=45x90:d=28:r=${FPS}" \
  -f lavfi -i "sine=frequency=220:sample_rate=48000:duration=28" \
  -filter_complex "$LONGHOLD" -map "[v]" -map 2:a \
  $VIDEO $AUDIO -shortest long-hold.mp4

# --- 4. continuous motion, no audio stream at all -------------------------------------------
# No audio input and no -map: the container carries a video stream and nothing else. This is the
# fixture that proves the audio-bed leg reports an ABSENT bed rather than crashing on a null.
$FFMPEG $V -f lavfi -i "color=c=0x1a1020:s=${W}x${H}:d=12:r=${FPS}" \
  -f lavfi -i "color=c=0xff5a3c:s=45x90:d=12:r=${FPS}" \
  -f lavfi -i "color=c=0xf6f1e7:s=480x6:d=12:r=${FPS}" \
  -filter_complex "$MOTION" -map "[v]" -an \
  $VIDEO -shortest silent-motion.mp4

# --- 5. continuous motion + a bed far below the floor ----------------------------------------
$FFMPEG $V -f lavfi -i "color=c=0x201a10:s=${W}x${H}:d=14:r=${FPS}" \
  -f lavfi -i "color=c=0xff5a3c:s=45x90:d=14:r=${FPS}" \
  -f lavfi -i "color=c=0xf6f1e7:s=480x6:d=14:r=${FPS}" \
  -f lavfi -i "sine=frequency=220:sample_rate=48000:duration=14" \
  -filter_complex "$MOTION" -map "[v]" -map 3:a -af "volume=-40dB" \
  $VIDEO $AUDIO -shortest quiet-bed.mp4

# --- 6. continuous motion + a bed hot enough to clip ----------------------------------------
$FFMPEG $V -f lavfi -i "color=c=0x102018:s=${W}x${H}:d=10:r=${FPS}" \
  -f lavfi -i "color=c=0xff5a3c:s=45x90:d=10:r=${FPS}" \
  -f lavfi -i "color=c=0xf6f1e7:s=480x6:d=10:r=${FPS}" \
  -f lavfi -i "sine=frequency=220:sample_rate=48000:duration=10" \
  -filter_complex "$MOTION" -map "[v]" -map 3:a -af "volume=+18dB" \
  $VIDEO $AUDIO -shortest hot-bed.mp4

ls -l *.mp4
