#!/usr/bin/env node
'use strict';
// filmstrip-verify — the filmstrip video verification protocol, as an adapter.
//
// The capability's own EVAL.json states four legs:
//
//   six-frames       deterministic  exactly 6 frames at even timestamps across the duration
//   audio-bed        deterministic  volumedetect mean_volume reported and within the mix target
//   distinct-motion  llm            per-frame motion notes describe a distinct visible change
//   no-slideshow     llm            motion is continuous — no static holds over stills
//
// Two of those are llm legs, and an llm leg is not a gate — it is an assertion nobody can
// re-run. This adapter keeps the two deterministic legs verbatim and gives `no-slideshow` the
// deterministic proxy it always deserved: a 1-second-baseline hold measurement. That proxy is
// the SAME claim as video-forensics-receipt's `no-long-hold` gate, one asserted by an eye and
// one measured, so the two capabilities share a definition rather than drifting apart.
//
// `distinct-motion` is deliberately NOT converted. "Describe a distinct visible change in every
// frame" is a sighted judgment about content, not a measurement, and faking a number for it
// would be inventing evidence. It stays where it is: a leg the filmstrip asks a viewer to
// perform, recorded in the strip the adapter produces.
//
// The adapter measures. It does not decide. Exit 0 means the measurement ran; the eval package's
// gates own pass/fail.
//
// Usage:
//   kernel:  RCOS_INPUT=<input.json> RCOS_OUTPUT=<out.json> RCOS_EVIDENCE_DIR=<dir> run.js
//   cli:     run.js --input <input.json> [--out <out.json>] [--evidence-dir <dir>]
//
// Exit codes: 0 measured (deterministic legs pass) · 2 bad usage · 3 measured (a leg failed)
//             · 4 could not run (ffmpeg/ffprobe missing, or a probe file is unreadable)

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCHEMA = 'filmstrip-verify-observation/1';

// --- constants -----------------------------------------------------------------------------
// Calibrated on 2026-09-23 against two known subjects: the One Question deliverable (a real
// 24-cut film) and a 6-still 15s-each slideshow fixture built to fail. At a 1-second baseline
// on a 480x270 downscale the real film's minimum sample was 0.0028 and the slideshow's hold
// share was 0.888 / longest hold 14s. These are the numbers the gates were proven reachable
// AND failable at; they are not free parameters.
const DEFAULT_FRAMES = 6;
const ANALYSIS_W = 480;
const ANALYSIS_H = 270;
const HOLD_BASELINE_FPS = 1;
const HOLD_EPS = 0.004;        // normalized mean |dluma| per 1s sample; below this is a hold
const HOLD_SHARE_MAX = 0.40;   // fraction of samples allowed to be holds
const HOLD_MAX_S = 5.0;        // longest single hold tolerated, seconds
const LOUDNESS_FLOOR_DB = -45; // "an audio bed exists" — below this it is not a bed
const LOUDNESS_CEIL_DB = -6;   // "not clipping the master" — above this it is too hot

const METRIC_DEFS = {
  frames_extracted:
    'Tiles in the produced filmstrip. Requested frames are sampled on an even fps grid across ' +
    'the duration; a strip whose width is not frames*tile_width means the extractor dropped or ' +
    'duplicated a frame.',
  mean_volume_db:
    'ffmpeg volumedetect mean_volume over the whole file, dBFS. null when the file carries no ' +
    'audio stream, which is a fact and not a failure.',
  hold_share:
    'Fraction of 1-second samples whose normalized mean absolute luma difference from the ' +
    'previous sample is below HOLD_EPS. Normalization is /255 on the difference image.',
  longest_hold_s:
    'Length of the longest run of consecutive hold samples, in seconds. At a 1s baseline one ' +
    'sample is one second.',
  deterministic_legs:
    'The two legs of the filmstrip protocol that can be re-run by a machine, plus the ' +
    'deterministic proxy for the no-slideshow llm leg. distinct-motion has no proxy by design.'
};

// --- process plumbing ----------------------------------------------------------------------

function which(bin) {
  const r = spawnSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, {
    encoding: opts.encoding === undefined ? 'utf8' : opts.encoding,
    maxBuffer: opts.maxBuffer || 64 * 1024 * 1024,
    timeout: opts.timeout || 600000
  });
  return {
    code: r.status === null ? 124 : r.status,
    stdout: r.stdout === null ? '' : r.stdout,
    stderr: r.stderr === null ? '' : r.stderr,
    argv: [bin].concat(args)
  };
}

function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
  catch (e) { return null; }
}

// --- measurement --------------------------------------------------------------------------

function probe(file) {
  const r = run('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file
  ]);
  if (r.code !== 0) return { ok: false, error: (r.stderr || '').trim().split('\n')[0] || 'ffprobe failed' };
  let doc;
  try { doc = JSON.parse(r.stdout); } catch (e) { return { ok: false, error: 'ffprobe output is not JSON' }; }
  const v = (doc.streams || []).find((s) => s.codec_type === 'video') || null;
  const a = (doc.streams || []).find((s) => s.codec_type === 'audio') || null;
  if (!v) return { ok: false, error: 'no video stream' };
  const duration = Number(doc.format && doc.format.duration);
  const fps = v.avg_frame_rate && v.avg_frame_rate !== '0/0'
    ? (() => { const [n, d] = v.avg_frame_rate.split('/').map(Number); return d ? n / d : null; })()
    : null;
  return {
    ok: true,
    duration_s: Number.isFinite(duration) ? duration : null,
    width: v.width || null,
    height: v.height || null,
    fps,
    video_codec: v.codec_name || null,
    has_audio: a !== null,
    audio_codec: a ? a.codec_name : null
  };
}

// The strip is the artifact a human reviews, and its width is the arithmetic that proves the
// frame count: `tile` cannot emit a tile it was not given, so a short strip means dropped frames.
function makeStrip(file, frames, durationS, outPng) {
  const fps = durationS && durationS > 0 ? frames / durationS : 1;
  const r = run('ffmpeg', [
    '-hide_banner', '-nostdin', '-y', '-i', file,
    '-vf', 'fps=' + fps.toFixed(6) + ',scale=' + ANALYSIS_W + ':-2,tile=' + frames + 'x1',
    '-frames:v', '1', '-an', outPng
  ]);
  const out = {
    argv: r.argv, exit_status: r.code,
    stderr_tail: (r.stderr || '').trim().split('\n').slice(-3).join('\n'),
    path: outPng, frames_requested: frames, frames_extracted: null,
    strip_width: null, strip_height: null, tile_width: null
  };
  if (r.code !== 0 || !fs.existsSync(outPng)) return out;
  const p = run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', outPng]);
  try {
    const v = (JSON.parse(p.stdout).streams || []).find((s) => s.codec_type === 'video');
    if (v && v.width) {
      out.strip_width = v.width;
      out.strip_height = v.height;
      out.tile_width = Math.floor(v.width / frames);
      out.frames_extracted = out.tile_width > 0 ? Math.round(v.width / out.tile_width) : null;
    }
  } catch (e) { /* width stays null; the gate will read that as "not proven" */ }
  return out;
}

function measureLoudness(file, hasAudio) {
  if (!hasAudio) return { mean_volume_db: null, max_volume_db: null, argv: null, exit_status: 0 };
  const r = run('ffmpeg', ['-hide_banner', '-nostdin', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  // volumedetect reports through the ffmpeg log, which is stderr. stdout is read as well because
  // which stream a filter writes to is a property of the build, and reading the wrong one yields a
  // silent null that looks like "the file carries no audio" rather than "the parser missed".
  const text = (r.stderr || '') + '\n' + (r.stdout || '');
  const pick = (label) => {
    const m = [...text.matchAll(new RegExp(label + ':\\s*(-?[\\d.]+|-inf)\\s*dB', 'g'))];
    if (m.length === 0) return null;
    const raw = m[m.length - 1][1]; // last match: volumedetect prints one summary line
    return raw === '-inf' ? null : Number(raw);
  };
  return {
    mean_volume_db: pick('mean_volume'),
    max_volume_db: pick('max_volume'),
    argv: r.argv,
    exit_status: r.code
  };
}

// |f(t+1) - f(t)| at a 1s baseline, normalized /255, with the first sample dropped: `tblend`
// has no predecessor for frame 0 and emits the frame unchanged, which would read as a hold.
function measureHold(file) {
  const r = run('ffmpeg', [
    '-hide_banner', '-nostdin', '-i', file,
    '-vf', 'fps=' + HOLD_BASELINE_FPS + ',scale=' + ANALYSIS_W + ':' + ANALYSIS_H +
      ',tblend=all_mode=difference,signalstats,' +
      'metadata=print:key=lavfi.signalstats.YAVG',
    '-an', '-f', 'null', '-'
  ]);
  // `metadata=print` writes to the stream named by its `file` option, whose default is '-' — and
  // which stream that lands on is a build/version detail (the filter docs say standard output; the
  // log path says stderr). Read both: a missed stream yields zero samples, which the no-slideshow
  // leg would read as "not measured" instead of as a parse failure.
  const text = (r.stderr || '') + '\n' + (r.stdout || '');
  const samples = [...text.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)]
    .map((m) => Number(m[1]) / 255);
  const series = samples.slice(1);
  const flags = series.map((v) => v < HOLD_EPS);
  // NOT named `run`: a `let run` anywhere in this function shadows the module-level run() helper
  // for the WHOLE scope (temporal dead zone), so the `run('ffmpeg', …)` call above would throw
  // "Cannot access 'run' before initialization" — and only at runtime.
  let longest = 0, streak = 0;
  for (const f of flags) { streak = f ? streak + 1 : 0; if (streak > longest) longest = streak; }
  return {
    argv: r.argv, exit_status: r.code,
    samples: series.length,
    hold_samples: flags.filter(Boolean).length,
    hold_share: series.length > 0 ? flags.filter(Boolean).length / series.length : null,
    longest_hold_s: series.length > 0 ? longest / HOLD_BASELINE_FPS : null,
    min_sample: series.length > 0 ? Math.min(...series) : null,
    mean_sample: series.length > 0 ? series.reduce((a, b) => a + b, 0) / series.length : null,
    analysis: { width: ANALYSIS_W, height: ANALYSIS_H, baseline_fps: HOLD_BASELINE_FPS, eps: HOLD_EPS }
  };
}

// --- per-probe ----------------------------------------------------------------------------

function verifyProbe(probeSpec, evidenceDir) {
  const name = String(probeSpec.name);
  const file = path.resolve(String(probeSpec.file));
  const frames = Number.isInteger(probeSpec.frames) ? probeSpec.frames : DEFAULT_FRAMES;
  const record = {
    name, file, frames_requested: frames,
    exit_status: 4, outcome: 'could-not-run', observed: null, legs: null, strip: null
  };

  if (!fs.existsSync(file)) {
    record.stderr = 'probe file not found: ' + file;
    return record;
  }
  const meta = probe(file);
  if (!meta.ok) { record.stderr = 'ffprobe: ' + meta.error; return record; }

  const stripPath = path.join(evidenceDir, name + '.strip.png');
  const strip = makeStrip(file, frames, meta.duration_s, stripPath);
  const loud = measureLoudness(file, meta.has_audio);
  const hold = measureHold(file);

  // The two legs the capability states mechanically, plus the proxy for its llm no-slideshow leg.
  const legs = {
    'six-frames': {
      pass: strip.frames_extracted !== null && strip.frames_extracted === frames,
      detail: strip.frames_extracted + ' tile(s) of width ' + strip.tile_width +
        ' in a ' + strip.strip_width + 'px strip; requested ' + frames
    },
    'audio-bed': {
      pass: loud.mean_volume_db !== null &&
        loud.mean_volume_db >= LOUDNESS_FLOOR_DB && loud.mean_volume_db <= LOUDNESS_CEIL_DB,
      detail: loud.mean_volume_db === null
        ? (meta.has_audio
            ? 'volumedetect reported no mean_volume'
            : 'no audio stream — the audio-bed claim cannot be satisfied, so this leg fails (reported, not a crash)')
        : 'mean_volume ' + loud.mean_volume_db + ' dBFS, target [' + LOUDNESS_FLOOR_DB + ', ' + LOUDNESS_CEIL_DB + ']'
    },
    'no-slideshow': {
      pass: hold.hold_share !== null && hold.hold_share <= HOLD_SHARE_MAX && hold.longest_hold_s <= HOLD_MAX_S,
      detail: 'hold share ' + (hold.hold_share === null ? 'n/a' : hold.hold_share.toFixed(3)) +
        ' (max ' + HOLD_SHARE_MAX + '), longest hold ' +
        (hold.longest_hold_s === null ? 'n/a' : hold.longest_hold_s.toFixed(1)) + 's (max ' + HOLD_MAX_S + ')'
    }
  };
  const failing = Object.keys(legs).filter((k) => !legs[k].pass);

  record.observed = {
    duration_s: meta.duration_s,
    width: meta.width, height: meta.height, fps: meta.fps,
    video_codec: meta.video_codec, has_audio: meta.has_audio, audio_codec: meta.audio_codec,
    frames_requested: frames,
    frames_extracted: strip.frames_extracted,
    strip_path: fs.existsSync(stripPath) ? path.relative(evidenceDir, stripPath) : null,
    mean_volume_db: loud.mean_volume_db,
    max_volume_db: loud.max_volume_db,
    hold_share: hold.hold_share,
    longest_hold_s: hold.longest_hold_s,
    hold_samples: hold.hold_samples,
    hold_sample_count: hold.samples,
    min_hold_sample: hold.min_sample,
    analysis_geometry: hold.analysis,
    failing_legs: failing,
    pass_marker: failing.length === 0 ? 'FILMSTRIP_PASS' : 'FILMSTRIP_FAIL'
  };
  record.legs = legs;
  record.strip = {
    path: strip.path, argv: strip.argv, exit_status: strip.exit_status,
    frames_requested: strip.frames_requested, frames_extracted: strip.frames_extracted,
    strip_width: strip.strip_width, tile_width: strip.tile_width
  };
  // Deliberately no `tools` field. The contract's probe object is additionalProperties:false and
  // has no slot for it, so a `tools` block assigned here would be silently dropped by build() while
  // reading as though the observation carried it. The strip's argv IS carried, under `strip.argv`.
  record.exit_status = failing.length === 0 ? 0 : 3;
  record.outcome = failing.length === 0 ? 'measured-pass' : 'measured-fail';
  return record;
}

// --- entry ---------------------------------------------------------------------------------

// EXIT CODE TRAP — read this before "fixing" the exit status below.
//
// It is tempting to exit 3 when a probe fails the protocol, and the CLI reads better that way.
// It is WRONG for this house. The invocation kernel (lib/invocation.js) maps any non-zero,
// non-4 adapter exit to invocation status `failed`, and the eval runner's deriveVerdict maps
// `failed` to verdict `blocked`. So an adapter that exits 3 on a failing subject makes every
// eval that exercises a failing case permanently `blocked` — it can never report `fix`, and it
// can never ship.
//
// The rule the house actually follows (proved by evals/audio-offline-verify-container-sounds-v1,
// which runs seven probes of which four deliberately fail, and still ships): an adapter exits 0
// when it MEASURED, and 4 when it could not run. Whether the subject was any good is the GATES'
// business, not the adapter's. Per-probe `exit_status` and `failing_legs` stay in the
// observation as evidence for the gates to read; the process exit says only "I ran".
function build(probes, evidenceDir) {
  const results = probes.map((p) => verifyProbe(p, evidenceDir));
  const anyRan = results.some((r) => r.observed !== null);
  return {
    doc: {
      schema: SCHEMA,
      measurer: 'capabilities/filmstrip-verify/adapter/run.cjs',
      measurer_sha256: sha256File(__filename),
      metric_defs: METRIC_DEFS,
      thresholds: {
        frames_default: DEFAULT_FRAMES,
        hold_baseline_fps: HOLD_BASELINE_FPS,
        hold_eps: HOLD_EPS,
        hold_share_max: HOLD_SHARE_MAX,
        hold_max_s: HOLD_MAX_S,
        loudness_floor_db: LOUDNESS_FLOOR_DB,
        loudness_ceil_db: LOUDNESS_CEIL_DB,
        analysis_width: ANALYSIS_W,
        analysis_height: ANALYSIS_H
      },
      probes: results.map((r) => ({
        name: r.name, file: r.file, exit_status: r.exit_status, outcome: r.outcome,
        observed: r.observed, legs: r.legs, strip: r.strip, stderr: r.stderr || null
      }))
    },
    // 0 = every probe was measured (pass or fail — the gates decide which); 4 = nothing could run.
    exit_status: anyRan ? 0 : 4
  };
}

function main() {
  const args = process.argv.slice(2);
  const flag = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };

  let inputPath = process.env.RCOS_INPUT || flag('input');
  let outputPath = process.env.RCOS_OUTPUT || flag('out');
  let evidenceDir = process.env.RCOS_EVIDENCE_DIR || flag('evidence-dir');

  if (!inputPath) { console.error('filmstrip-verify: no input (set RCOS_INPUT or --input)'); process.exit(2); }
  if (!outputPath) { outputPath = path.join(process.cwd(), 'filmstrip-verify-observation.json'); }
  if (!evidenceDir) {
    evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filmstrip-verify-'));
  }
  fs.mkdirSync(evidenceDir, { recursive: true });

  if (!which('ffmpeg') || !which('ffprobe')) {
    console.error('filmstrip-verify: ffmpeg/ffprobe not on PATH — the measurer cannot run');
    process.exit(4);
  }

  let input;
  try { input = JSON.parse(fs.readFileSync(inputPath, 'utf8')); }
  catch (e) { console.error('filmstrip-verify: input is not readable JSON: ' + e.message); process.exit(2); }

  if (!Array.isArray(input.probes) || input.probes.length === 0) {
    console.error('filmstrip-verify: input.probes must be a non-empty array'); process.exit(2);
  }
  for (const p of input.probes) {
    if (!p || typeof p.name !== 'string' || typeof p.file !== 'string') {
      console.error('filmstrip-verify: every probe needs {name, file}'); process.exit(2);
    }
  }

  const { doc, exit_status } = build(input.probes, evidenceDir);
  fs.writeFileSync(outputPath, JSON.stringify(doc, null, 2) + '\n');
  for (const p of doc.probes) {
    console.log(p.outcome + '\t' + p.name + '\t' + (p.observed ? p.observed.pass_marker : 'NO-MEASUREMENT') +
      (p.observed && p.observed.failing_legs.length ? '\tfailing: ' + p.observed.failing_legs.join(',') : ''));
  }
  console.log('observation: ' + outputPath);
  process.exit(exit_status);
}

main();
