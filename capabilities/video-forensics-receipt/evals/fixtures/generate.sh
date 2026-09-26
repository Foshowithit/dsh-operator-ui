#!/bin/sh
# Generates the video fixtures for evals/video-forensics-receipt-envelope-v1.
#
# Self-locating: writes into the directory it lives in, so the package's inputs rebuild from a
# clean checkout without editing a path.
#
# Everything is lavfi + x264: no network, no source media, no external asset.
#
#   #  fixture            dur  what it changes vs the control                     expected
#   1  envelope-pass.mp4   24  (the control)                                       ALL PASS
#   2  desaturated.mp4     24  grey canvas, grey sprite                            sat out LOW
#   3  overbright.mp4      24  bright canvas                                       luma out HIGH
#   4  quiet-mix.mp4       24  bed 0.45x                                             loudness out LOW
#   5  hot-mix.mp4         24  bed hotter                                            loudness out HIGH
#   6  narrow-lra.mp4      24  bed CONSTANT                                          lra out LOW
#   7  wide-lra.mp4        24  bed with a wide level swing                           lra out HIGH
#   8  slideshow.mp4       40  five 8s flat-colour holds                             BOTH motion gates
#   9  silent-motion.mp4   24  no audio stream                                       ALL PASS (loudness null)
#  10  black-frame.mp4      6  flat black, no audio                                  the luma FLOOR probe
#  11  magenta-canvas.mp4  24  magenta canvas + green sprite                         the saturation CEILING probe
#
# WHY ONE FIXTURE PER ARM. Each envelope gate is a band with a lo and a hi, so "the gate works"
# needs BOTH boundaries shown reachable: a one-armed test cannot tell a working two-sided check
# from a one-sided one. Fixtures 2-7 do exactly that, one arm each, and nothing else.
#
# The two motion gates are single-sided (<= 0.40 share, <= 5s span), so slideshow.mp4 is the arm.
# It trips both because a slideshow IS both things at once - splitting it would be inventing a
# distinction the capability does not make. Its palette is chosen so it fails on MOTION and not on
# colour, which is what makes it evidence for the motion gates rather than for the colour ones.
#
# TWO ARMS ARE UNREACHABLE, AND THIS PACKAGE SAYS SO INSTEAD OF FAKING THEM.
# Fixtures 10 and 11 are BOUND PROBES, not isolation fixtures. They exist to pin the two ends of
# the canvas metric's actual range, because measurement showed the declared bands run past them:
#
#   luma       declared explainer band 0.06 .. 0.49.  The metric is signalstats YAVG/255 on a
#              limited-range encode, so its floor is the black level 16/255 = 0.0627. Fixture 10 is
#              flat black and measures 0.0627 - already ABOVE the 0.06 floor. luma-in-band can
#              therefore only ever fail HIGH.
#   saturation declared explainer band 0.10 .. 0.86.  Measured over a 729-colour sweep of the RGB
#              cube, the metric's maximum is 0.4667 (pure green, pure magenta). Fixture 11 sits on
#              that maximum and is comfortably IN band. 0.86 is not merely hard to reach, it is
#              arithmetically unreachable by any file: saturation-in-band can only fail LOW, and
#              the top half of the declared band is dead.
#
# A package that shipped a "saturation ceiling" fixture and a "luma floor" fixture would be
# manufacturing evidence for two claims that cannot be true. The bound probes record the real
# range instead, and gates/canvas_metric_range_is_bounded reads them.
#
# Fixture 10's failing set is FORCED by the metric, not chosen: a flat frame cannot satisfy the
# motion gates (a still is a still), and a black frame cannot satisfy the saturation floor (a
# black pixel has no chroma). Its gate asserts the luma value and the luma verdict only.
#
# THREE TOOL FACTS THIS SCRIPT ENCODES, all found by measuring:
#
#  1. **zsh mangles `$VAR:` inside a filter string, and the mangling is SILENT when the result is
#     still a legal argument.** A first draft wrote `"color=c=$2:s=480x270:d=24:r=24"` inside a
#     shell function; zsh consumed `:s=...:d=...:r=...` as a substitution modifier and produced
#     `color=c=0x1a4a8024`, which ffmpeg parsed as a valid 8-hex-digit colour. The clip came out at
#     the color filter's DEFAULTS (320x240 @ 25fps) in a colour nobody chose, and passed every
#     envelope gate. Hence `${base}` braces everywhere below, never a bare `$2:`. The guard after
#     this comment re-execs under sh if someone runs the file with zsh.
#
#  2. **A constant tone cannot reach the LRA floor.** LRA is a RANGE (the spread of short-term
#     loudness), so a steady sine measures near 0 LU against a 2.8 LU floor. `narrow-lra.mp4` uses a
#     constant level precisely BECAUSE that fails; every other fixture needs genuine level variation
#     (`sin(2*PI*t/11)`), or it would fail lra-in-band for a reason that has nothing to do with what
#     it is testing.
#
#  3. **The colour must be checked, not assumed.** `overbright.mp4` fails the luma CEILING (0.49)
#     while staying inside the saturation band; `desaturated.mp4` fails the saturation FLOOR (0.10)
#     while staying inside the luma band. A grey fixture fails both if you are careless - which
#     would make it evidence for neither.
set -eu

# Word splitting is load-bearing below ($VIDEO $AUDIO, $FFMPEG). zsh does not split unquoted
# expansions, so a zsh run would silently pass one giant argument to ffmpeg. Re-exec under sh.
if [ -n "${ZSH_VERSION:-}" ]; then
  exec sh "$0" "$@"
fi

cd "$(dirname "$0")"

FFMPEG=${FFMPEG:-ffmpeg}
V="-hide_banner -loglevel error -y"

# 480x270 is the measurer's own analysis geometry (ANALYSIS_W/ANALYSIS_H), so what the measurement
# sees is what was drawn, with no resampling step in the fixture itself.
W=480
H=270
FPS=24
DUR=24

VIDEO="-c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p"
AUDIO="-c:a aac -b:a 96k"

# A 70x130 sprite crossing the frame at 140 px/s. `overlay` re-evaluates x/y per frame; `drawbox`
# does NOT (it draws once at t=0 and leaves it there, which makes the clip a still image).
SPRITE_W=70
SPRITE_H=130

# A bed whose level genuinely varies. The 11-second period is long relative to the 3s short-term
# loudness window, so the spread is real and LRA lands mid-band rather than at the edge.
BED_VARYING="1.8+0.5*sin(2*PI*t/11)"
# Same mean level, no variation - this is what drops LRA under the floor.
BED_FLAT="1.8"
# ~5 dB hotter, same variation, so loudness moves and LRA does not.
BED_HOT="3.2+0.9*sin(2*PI*t/11)"
# The same shape as the control, scaled down ~7 dB: loudness falls out the floor, LRA is unchanged
# (a pure gain change cannot move a RANGE).
BED_QUIET="0.45*(1.8+0.5*sin(2*PI*t/11))"
# A wide swing. LRA is the spread of short-term loudness, so this is what pushes it over the 6.5 LU
# ceiling - but widening the swing also raises integrated loudness, which is why the whole
# expression is scaled by 0.85: that pulls LUFS back to about -15.1 while leaving LRA at 10.9.
# Without the scale factor this fixture would fail loudness too and would be evidence for neither.
BED_WIDE="0.85*(1.8+1.6*sin(2*PI*t/7))"

# --- the moving-canvas fixtures -------------------------------------------------------------
# base/sprite colour pairs, chosen to move ONE envelope metric at a time.
motion_fixture() { # $1=out $2=base $3=sprite $4=bed-expr
  ffmpeg $V -f lavfi -i "color=c=${2}:s=${W}x${H}:d=${DUR}:r=${FPS}" \
    -f lavfi -i "color=c=${3}:s=${SPRITE_W}x${SPRITE_H}:d=${DUR}:r=${FPS}" \
    -f lavfi -i "sine=frequency=300:sample_rate=48000:duration=${DUR}" \
    -filter_complex "[0:v][1:v]overlay=x='mod(t*140,540)-60':y=80[v]" \
    -map "[v]" -map 2:a -af "volume='${4}':eval=frame" \
    $VIDEO $AUDIO -shortest "${1}"
}

# The control: mid-dark saturated canvas (luma ~0.31, sat ~0.16 - both mid-band on explainer).
motion_fixture envelope-pass.mp4 0x1a4a80 0xffb347 "${BED_VARYING}"
# Grey canvas and grey sprite: saturation collapses toward 0 while luma stays mid-band.
motion_fixture desaturated.mp4   0x4a4a4a 0x9a9a9a "${BED_VARYING}"
# Bright saturated canvas: luma goes over the 0.49 ceiling while saturation stays in band.
motion_fixture overbright.mp4    0xffd54a 0xff8a3c "${BED_VARYING}"
# Identical canvas and motion to the control; only the bed level moves - down, then up.
motion_fixture quiet-mix.mp4     0x1a4a80 0xffb347 "${BED_QUIET}"
motion_fixture hot-mix.mp4       0x1a4a80 0xffb347 "${BED_HOT}"
# Identical again; only the bed's VARIATION is removed, then widened.
motion_fixture narrow-lra.mp4    0x1a4a80 0xffb347 "${BED_FLAT}"
motion_fixture wide-lra.mp4      0x1a4a80 0xffb347 "${BED_WIDE}"
# The saturation CEILING probe. Magenta canvas and green sprite are two of the four colours that
# sit ON the metric's measured maximum (0.4667), so the frame mean is the maximum too; both are
# inside the luma band (0.4157 and 0.5686), so this fixture passes every gate. It is the evidence
# that 0.86 is unreachable: the most saturated frame the metric can see is 0.4667, and it is
# comfortably IN band.
motion_fixture magenta-canvas.mp4 0xff00ff 0x00ff00 "${BED_VARYING}"

# --- the slideshow attack -------------------------------------------------------------------
# Five stills, eight seconds each. A static window of length L yields L-1 zero samples at a 1s
# baseline (the samples straddling the edges still see the colour change), so 8s of stillness gives
# longest_hold_s = 7 - over the 5s ceiling - while the share lands far over 0.40 as well.
# The palette is chosen so every still is individually inside the explainer canvas envelope (mean
# luma 0.30, mean saturation 0.17, both mid-band): a slideshow must fail on MOTION, not on colour,
# or it would be evidence for the wrong gate. The colours are strongly contrasting, which matters
# for the arithmetic above: adjacent stills that were close in level would let the edge samples
# read as held too and merge two 8s holds into one 15s run.
ffmpeg $V -f lavfi -i "color=c=0x1a4a80:s=${W}x${H}:d=40:r=${FPS}" \
  -f lavfi -i "sine=frequency=300:sample_rate=48000:duration=40" \
  -filter_complex "[0:v]drawbox=x=0:y=0:w=480:h=270:color=0x2a7a3a:t=fill:enable='gte(t,8)*lt(t,16)',drawbox=x=0:y=0:w=480:h=270:color=0x9a1a3a:t=fill:enable='gte(t,16)*lt(t,24)',drawbox=x=0:y=0:w=480:h=270:color=0x2a2a9a:t=fill:enable='gte(t,24)*lt(t,32)',drawbox=x=0:y=0:w=480:h=270:color=0x0a6a6a:t=fill:enable='gte(t,32)*lt(t,40)'[v]" \
  -map "[v]" -map 1:a -af "volume='${BED_VARYING}':eval=frame" \
  $VIDEO $AUDIO -shortest slideshow.mp4

# --- no audio stream at all ------------------------------------------------------------------
# No audio input and no -map: the container carries video only. This is the fixture that proves the
# loudness fields are reported as null and the loudness gates read n/a rather than FAIL - a clip
# with no audio is not a clip with bad audio.
ffmpeg $V -f lavfi -i "color=c=0x1a4a80:s=${W}x${H}:d=${DUR}:r=${FPS}" \
  -f lavfi -i "color=c=0xffb347:s=${SPRITE_W}x${SPRITE_H}:d=${DUR}:r=${FPS}" \
  -filter_complex "[0:v][1:v]overlay=x='mod(t*140,540)-60':y=80[v]" \
  -map "[v]" -an \
  $VIDEO -shortest silent-motion.mp4

# --- the luma FLOOR probe ---------------------------------------------------------------------
# Flat black, no audio, 6 seconds. Six seconds is deliberate: at the 1s hold baseline that is 5
# windows, so longest_hold_s lands exactly on the 5.0s ceiling and PASSES, while hold_share is 1.0
# and fails. Nothing here is tuned to look good - the point is the luma value.
ffmpeg $V -f lavfi -i "color=c=0x000000:s=${W}x${H}:d=6:r=${FPS}" \
  $VIDEO -an black-frame.mp4

ls -l *.mp4
