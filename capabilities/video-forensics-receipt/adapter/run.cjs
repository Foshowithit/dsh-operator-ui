#!/usr/bin/env node
'use strict';
// Adapter for the video-forensics-receipt capability.
//
// Domain work: run the measurer that already exists beside this file
// (adapter/forensics.py) once per probe, and record what it said VERBATIM. The
// wrapper forms no opinion about whether a piece is good: that is the gates'
// job, and the measurer's own exit code and printed lines are the things they
// read.
//
// It never modifies, re-implements or patches the measurer. Its sha256 goes
// into the observation so the receipt names the exact artifact identity it
// exercised, which is what lets a human line this up against historical runs
// for the same script.
//
// Kernel interface (lib/invocation.js): the input document is at $RCOS_INPUT,
// the result goes to $RCOS_OUTPUT, supporting files go under
// $RCOS_EVIDENCE_DIR. Exit 4 = could not run; exit 0 = ran and wrote a result.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const inputPath = process.env.RCOS_INPUT;
const outputPath = process.env.RCOS_OUTPUT;
const evidenceDir = process.env.RCOS_EVIDENCE_DIR;
const home = process.env.RCOS_HOME;
const work = process.cwd();

function cannotRun(msg) { console.error(msg); process.exit(4); }

if (!inputPath || !outputPath || !evidenceDir) {
  cannotRun('adapter needs RCOS_INPUT, RCOS_OUTPUT and RCOS_EVIDENCE_DIR in the environment');
}

const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
if (!Array.isArray(input.probes) || input.probes.length === 0) {
  cannotRun('input needs a non-empty probes array');
}

const measurer = path.join(__dirname, 'forensics.py');
if (!fs.existsSync(measurer)) cannotRun('measurer is missing beside the adapter: ' + measurer);

const measurerSha = crypto.createHash('sha256').update(fs.readFileSync(measurer)).digest('hex');

// A receipt should not depend on where the checkout lives, nor on whether one
// of its roots is a symlink: node resolves this file's own directory, so
// __dirname can arrive as /private/tmp/... while RCOS_HOME arrives as /tmp/....
// Both sides are resolved before comparing, and a measurer that is genuinely
// inside RCOS_HOME is recorded relative to it.
function realOr(p) { try { return fs.realpathSync(p); } catch (e) { return p; } }
const measurerReal = realOr(measurer);
const homeReal = home ? realOr(home) : null;
const underHome = homeReal && (measurerReal === homeReal || measurerReal.startsWith(homeReal + path.sep));
const measurerPath = underHome
  ? path.relative(homeReal, measurerReal).split(path.sep).join('/')
  : measurerReal;

// A probe decodes the file up to four times (loudness, canvas, rate probe,
// hold probe). On a 90s 1080p piece that is ~15-25s. The kernel enforces the
// adapter's declared timeout around the whole invocation; this is the inner
// bound so one wedged probe cannot swallow the budget of the probes behind it.
const PROBE_TIMEOUT_MS = 120000;

const PYTHON = process.env.RCOS_PYTHON || 'python3';

function outcomeOf(exitStatus, signal) {
  if (signal) return signal === 'SIGTERM' ? 'timed_out' : 'errored';
  if (exitStatus === 0) return 'passed';
  if (exitStatus === 3) return 'caught';
  if (exitStatus === 4) return 'could_not_measure';
  return 'errored';
}

// The flat facts a gate reads. Lifted from the receipt JSON rather than parsed
// out of prose, because the receipt IS the machine-readable artifact and a
// regex over stdout would be a second, weaker copy of it. The raw text is
// recorded beside this so a gate can always check the two against each other.
function observedFrom(receipt) {
  if (!receipt) {
    return {
      duration_s: null, width: null, height: null, fps: null,
      video_codec: null, audio_codec: null, has_audio: null,
      lufs: null, lra: null, true_peak_dbfs: null,
      luma: null, saturation: null,
      motion_rate: null, hold_share: null, longest_hold_s: null,
      failing_gates: [], pass_marker: false
    };
  }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const p = receipt.probe || {};
  const l = receipt.loudness || {};
  const c = receipt.canvas || {};
  const m = receipt.motion || {};
  return {
    duration_s: num(p.duration),
    width: Number.isInteger(p.width) ? p.width : null,
    height: Number.isInteger(p.height) ? p.height : null,
    fps: num(p.fps),
    video_codec: p.video_codec || null,
    audio_codec: p.audio_codec || null,
    has_audio: typeof p.has_audio === 'boolean' ? p.has_audio : null,
    lufs: num(l.lufs),
    lra: num(l.lra),
    true_peak_dbfs: num(l.true_peak_dbfs),
    luma: num(c.luma),
    saturation: num(c.saturation),
    motion_rate: num(m.motion_rate),
    hold_share: num(m.hold_share),
    longest_hold_s: num(m.longest_hold_s),
    failing_gates: (receipt.checks || [])
      .filter((x) => x && x.pass === false)
      .map((x) => String(x.id)),
    pass_marker: receipt.verdict === 'PASS'
  };
}

fs.mkdirSync(evidenceDir, { recursive: true });

const probes = [];
const spawnErrors = [];
for (const p of input.probes) {
  const file = path.resolve(p.file);
  const receiptPath = path.join(evidenceDir, 'probe-' + p.name + '.receipt.json');
  const argv = [measurer, file, '--register', String(p.register), '--json', receiptPath];
  const startedAt = Date.now();
  const r = spawnSync(PYTHON, argv, {
    cwd: work,
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS
  });
  spawnErrors.push(r.error ? p.name + ': ' + r.error.message : null);

  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const exitStatus = typeof r.status === 'number' ? r.status : null;

  let receipt = null;
  if (fs.existsSync(receiptPath)) {
    try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); }
    catch (e) { receipt = null; }
  }

  const entry = {
    name: p.name,
    file,
    register: p.register,
    // The exact argv the measurer received. The observation names the register
    // so a gate can tell which envelope was tested, and so nobody has to trust
    // that the wrapper passed what the eval declared.
    argv: argv.slice(1),
    exit_status: exitStatus,
    signal: r.signal || null,
    outcome: outcomeOf(exitStatus, r.signal),
    duration_ms: Date.now() - startedAt,
    observed: observedFrom(receipt),
    stdout,
    stderr
  };
  if (receipt) entry.receipt = receipt;
  probes.push(entry);
}

const observation = {
  schema: 'video-forensics-receipt-observation/1',
  measurer: {
    path: measurerPath,
    sha256: measurerSha,
    // Read from the measurer's own docstring, not from a run: the documented
    // contract is the claim, and the probes above are what actually happened.
    documented_exit_codes: [0, 2, 3, 4]
  },
  probes
};
fs.writeFileSync(outputPath, JSON.stringify(observation, null, 2) + '\n');

// Evidence: the raw text each verdict will be computed from. The kernel hashes
// and lists these; it does not judge them.
for (const p of probes) {
  fs.writeFileSync(path.join(evidenceDir, 'probe-' + p.name + '.stdout.txt'), p.stdout);
  fs.writeFileSync(path.join(evidenceDir, 'probe-' + p.name + '.stderr.txt'), p.stderr);
  fs.writeFileSync(path.join(evidenceDir, 'probe-' + p.name + '.argv.json'), JSON.stringify(p.argv, null, 2) + '\n');
}
fs.writeFileSync(path.join(evidenceDir, 'measurer.sha256'), measurerSha + '  ' + measurerPath + '\n');

// Exit 4 is reserved for "this capability could not run at all" — the
// interpreter is missing, or the measurer was killed before it could report.
// A probe that exited 3 or 4 was able to run and said something; that is a
// result the gates must see, not a block.
const anyExecuted = probes.some((p) => p.exit_status !== null);
if (!anyExecuted) {
  const detail = spawnErrors.filter(Boolean).join(' | ');
  console.error('no probe produced an exit status' + (detail ? ' — ' + detail : ''));
  process.exit(4);
}

console.log('measurer sha256 ' + measurerSha.slice(0, 16) + '  ' + measurerPath);
for (const p of probes) {
  const o = p.observed;
  console.log('  ' + p.name + ' [' + p.register + ']: exit ' + p.exit_status +
    ' (' + p.outcome + '), lufs ' + o.lufs + ', sat ' + o.saturation +
    ', hold ' + o.hold_share + ', ' + p.duration_ms + 'ms' +
    (o.failing_gates.length ? ', OUT: ' + o.failing_gates.join(',') : ''));
}
process.exit(0);
