#!/usr/bin/env node
'use strict';
// Adapter for the audio-offline-verify capability.
//
// Domain work: run the frozen checker that already exists beside this file
// (adapter/av_check.py — the artifact this entry's historical run_ids name)
// once per probe, and record what it said VERBATIM. The wrapper forms no
// opinion about whether the media is right: that is the gates' job, and the
// checker's own exit code and printed lines are the things they read.
//
// It never modifies, re-implements or patches the checker. Its sha256 goes into
// the observation so the new receipt names the exact artifact identity it
// exercised, which is what lets a human line this receipt up against the
// historical asserted runs for the same script.
//
// Kernel interface (lib/invocation.js): the input document is at $RCOS_INPUT,
// the result goes to $RCOS_OUTPUT, supporting files go under $RCOS_EVIDENCE_DIR.
// Exit 4 = could not run; exit 0 = ran and wrote a result.

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

const checker = path.join(__dirname, 'av_check.py');
if (!fs.existsSync(checker)) cannotRun('checker is missing beside the adapter: ' + checker);

const checkerSha = crypto.createHash('sha256').update(fs.readFileSync(checker)).digest('hex');

// A receipt should not depend on where the checkout lives, nor on whether one of
// its roots is a symlink: node resolves this file's own directory, so __dirname
// can arrive as /private/tmp/... while RCOS_HOME arrives as /tmp/.... Both sides
// are therefore resolved before comparing, and a checker that is genuinely inside
// RCOS_HOME is recorded relative to it.
function realOr(p) { try { return fs.realpathSync(p); } catch (e) { return p; } }
const checkerReal = realOr(checker);
const homeReal = home ? realOr(home) : null;
const underHome = homeReal && (checkerReal === homeReal || checkerReal.startsWith(homeReal + path.sep));
const checkerPath = underHome
  ? path.relative(homeReal, checkerReal).split(path.sep).join('/')
  : checkerReal;

// Per-probe wall clock: the RMS leg decodes the whole audio stream, so a
// probe on a long file is slower than a header read. The kernel enforces the
// adapter's declared timeout around the whole invocation; this is the inner
// bound so one wedged probe cannot swallow the budget of the probes behind it.
const PROBE_TIMEOUT_MS = 30000;

// The checker prints fixed, one-line-per-fact output. The parsed block is a
// convenience for the gates; the raw text is recorded beside it so a gate can
// check the parse against the bytes it came from.
function parseObserved(stdout) {
  const num = (re) => { const m = stdout.match(re); return m ? Number(m[1]) : null; };
  const str = (re) => { const m = stdout.match(re); return m ? m[1] : null; };
  const rmsToken = str(/^audio RMS (\S+) dBFS$/m);
  return {
    container_duration_s: num(/^container duration ([\d.]+)s/m),
    video_codec: str(/^video (\S+) \d+x\d+$/m),
    video_width: num(/^video \S+ (\d+)x\d+$/m),
    video_height: num(/^video \S+ \d+x(\d+)$/m),
    audio_codec: str(/^audio (\S+) \d+Hz \d+ch$/m),
    audio_sample_rate: str(/^audio \S+ (\d+)Hz \d+ch$/m),
    audio_channels: str(/^audio \S+ \d+Hz (\d+)ch$/m),
    rms_token: rmsToken,
    rms_dbfs: rmsToken === null || !/^-?[\d.]+$/.test(rmsToken) ? null : Number(rmsToken),
    fail_lines: (stdout.match(/^FAIL (.*)$/gm) || []).map((l) => l.slice(5)),
    pass_marker: /^AV_CHECK_PASS$/m.test(stdout)
  };
}

function outcomeOf(exitStatus, signal) {
  if (signal) return signal === 'SIGTERM' ? 'timed_out' : 'errored';
  if (exitStatus === 0) return 'passed';
  if (exitStatus === 3) return 'caught';
  if (exitStatus === 4) return 'could_not_probe';
  return 'errored';
}

const probes = [];
const spawnErrors = [];
for (const p of input.probes) {
  const file = path.resolve(p.file);
  const argv = [checker, file];
  if (p.expect_video !== undefined && p.expect_video !== null) argv.push('--expect-video', String(p.expect_video));
  if (p.expect_audio !== undefined && p.expect_audio !== null) argv.push('--expect-audio', String(p.expect_audio));
  if (p.min_duration !== undefined && p.min_duration !== null) argv.push('--min-duration', String(p.min_duration));
  if (p.max_duration !== undefined && p.max_duration !== null) argv.push('--max-duration', String(p.max_duration));
  if (p.audio_must_sound === true) argv.push('--audio-must-sound');
  const startedAt = Date.now();
  const r = spawnSync('python3', argv, {
    cwd: work,
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS
  });
  spawnErrors.push(r.error ? p.name + ': ' + r.error.message : null);
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const exitStatus = typeof r.status === 'number' ? r.status : null;
  probes.push({
    name: p.name,
    file,
    // The exact argv the checker received. The observation names the flags so
    // a gate can tell a must-sound miss from a report-only pass, and so nobody
    // has to trust that the wrapper passed what the eval declared.
    argv: argv.slice(1),
    exit_status: exitStatus,
    signal: r.signal || null,
    outcome: outcomeOf(exitStatus, r.signal),
    duration_ms: Date.now() - startedAt,
    observed: parseObserved(stdout),
    stdout,
    stderr
  });
}

const observation = {
  schema: 'audio-offline-verify-observation/1',
  checker: {
    path: checkerPath,
    sha256: checkerSha,
    // Read from the checker's own docstring, not from a run: the documented
    // contract is the claim, and the probes above are what actually happened.
    documented_exit_codes: [0, 3, 4]
  },
  probes
};
fs.writeFileSync(outputPath, JSON.stringify(observation, null, 2) + '\n');

// Evidence: the raw text each verdict will be computed from. The kernel hashes
// and lists these; it does not judge them.
fs.mkdirSync(evidenceDir, { recursive: true });
for (const p of probes) {
  fs.writeFileSync(path.join(evidenceDir, 'probe-' + p.name + '.stdout.txt'), p.stdout);
  fs.writeFileSync(path.join(evidenceDir, 'probe-' + p.name + '.stderr.txt'), p.stderr);
  fs.writeFileSync(path.join(evidenceDir, 'probe-' + p.name + '.argv.json'), JSON.stringify(p.argv, null, 2) + '\n');
}
fs.writeFileSync(path.join(evidenceDir, 'checker.sha256'), checkerSha + '  ' + checkerPath + '\n');

// Exit 4 is reserved for "this capability could not run at all" — the
// interpreter is missing, or the checker was killed before it could report.
// A probe that exited 3 or 4 was able to run and said something; that is a
// result the gates must see, not a block.
const anyExecuted = probes.some((p) => p.exit_status !== null);
if (!anyExecuted) {
  const detail = spawnErrors.filter(Boolean).join(' | ');
  console.error('no probe produced an exit status' + (detail ? ' — ' + detail : ''));
  process.exit(4);
}

console.log('checker sha256 ' + checkerSha.slice(0, 16) + '  ' + checkerPath);
for (const p of probes) {
  console.log('  ' + p.name + ': exit ' + p.exit_status + ' (' + p.outcome + '), rms ' + p.observed.rms_token +
    ', ' + p.duration_ms + 'ms');
}
process.exit(0);
