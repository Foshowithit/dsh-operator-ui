#!/usr/bin/env node
'use strict';
// Adapter for qr-camo-embed.
//
// The capability is one frozen script beside this file:
//
//   make_header_v2.py [url]
//       blends a scannable QR payload into the cover image camo-src.png found
//       in the CURRENT DIRECTORY and writes camo-qr-header.png beside it. Its
//       SRC/OUT_PNG are cwd-relative by design; its documented exit codes are
//       0 (embedded, every stress decode passed) and 1, which covers both its
//       refusals (exact stderr line: 'payload too long: ...' or 'no contrast
//       level survived the stress ladder — payload or cover unusable') and any
//       uncaught Python error (traceback). This adapter does not pre-judge
//       which kind of exit 1 it saw: the raw streams are recorded and the
//       gates tell the two apart by their exact lines.
//
// The script is not modified, re-implemented, or patched here. The adapter
// gives each case its own scratch directory, copies the case's cover to
// camo-src.png (the name the script reads), runs the script with the case URL
// as argv[1], and records what the script did — including the bytes it left
// behind. It cannot turn a failed blend into a passing record: every value in
// the observation is an argv, one of the script's own output streams, or a
// hash/header of a file the script read or wrote.
//
// Interpreter resolution, in order: $RCOS_QR_PYTHON if set, else
// evidence/qr-venv/bin/python under RCOS_HOME. A one-shot dependency probe
// (cv2, qrcode, zxingcpp, numpy, PIL) runs before any case; a missing or
// broken interpreter is cannotRun (exit 4), never a fabricated case record.
// The interpreter is environment, not capability bytes: it is inherited
// unchanged (the deps resolve through the process environment), and no
// absolute user path is embedded in these committed lines.
//
// Kernel interface (lib/invocation.js): the input document is at $RCOS_INPUT,
// the result goes to $RCOS_OUTPUT, supporting files go under $RCOS_EVIDENCE_DIR.
// Exit 4 = could not run; exit 0 = ran and wrote a result.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const CASE_TIMEOUT_MS = 60000;
const SRC_NAME = 'camo-src.png';
const OUT_NAME = 'camo-qr-header.png';
const PROBE_SNIPPET =
  "import json,sys,cv2,numpy,PIL;" +
  "from importlib.metadata import version as _v;" +
  "print(json.dumps({'cv2':cv2.__version__,'qrcode':_v('qrcode')," +
  "'zxingcpp':_v('zxing-cpp'),'numpy':numpy.__version__," +
  "'pillow':PIL.__version__,'python':sys.version.split()[0]}))";

function cannotRun(msg) {
  console.error(msg);
  process.exit(4);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const HOME = process.env.RCOS_HOME || path.join(os.homedir(), 'zcode-rcos');
// The invocation kernel exports RCOS_INVOCATION_WORK_DIR (lib/invocation.js);
// RCOS_WORK_DIR belongs to the eval runner's gate children, which do not spawn
// this file. The kernel also sets the process cwd to the invocation work dir.
const WORK = process.env.RCOS_INVOCATION_WORK_DIR || process.env.RCOS_WORK_DIR;
const EVIDENCE = process.env.RCOS_EVIDENCE_DIR;
const INPUT = process.env.RCOS_INPUT;
const OUTPUT = process.env.RCOS_OUTPUT;
if (!WORK || !EVIDENCE || !INPUT || !OUTPUT) {
  cannotRun('missing kernel env (RCOS_INVOCATION_WORK_DIR/RCOS_EVIDENCE_DIR/RCOS_INPUT/RCOS_OUTPUT)');
}

const SCRIPT = path.join(__dirname, 'make_header_v2.py');
const SCRIPT_SHA = sha256(fs.readFileSync(SCRIPT));

function resolveInterpreter() {
  const candidates = [];
  if (process.env.RCOS_QR_PYTHON) candidates.push(process.env.RCOS_QR_PYTHON);
  candidates.push(path.join(HOME, 'evidence', 'qr-venv', 'bin', 'python'));
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (e) {
      // try the next candidate
    }
  }
  cannotRun('no usable interpreter: set RCOS_QR_PYTHON or provide evidence/qr-venv/bin/python under RCOS_HOME');
}

const PYTHON = resolveInterpreter();

// The interpreter's dependency versions are measured, not asserted: if any dep
// is missing the capability cannot run and says so. cv2/numpy/PIL resolve
// through the process environment (they are not vendored inside the venv),
// which is why this probe runs through the same spawn path as a real case.
function probeInterpreter(pythonAbs) {
  const res = spawnSync(pythonAbs, ['-c', PROBE_SNIPPET], { encoding: 'utf8', timeout: 30000 });
  const err = res.error;
  if (err && err.code !== 'ETIMEDOUT') {
    cannotRun('could not start interpreter ' + pythonAbs + ': ' + err.message);
  }
  if (res.status !== 0) {
    cannotRun('dependency probe failed for ' + pythonAbs +
      ' (exit ' + String(res.status) + '): ' + (res.stderr || '').trim().slice(0, 500));
  }
  let deps;
  try {
    deps = JSON.parse((res.stdout || '').trim().split('\n').pop());
  } catch (e) {
    cannotRun('dependency probe produced unparseable output: ' + (res.stdout || '').slice(0, 200));
  }
  for (const k of ['cv2', 'qrcode', 'zxingcpp', 'numpy', 'pillow', 'python']) {
    if (typeof deps[k] !== 'string' || !deps[k]) cannotRun('dependency probe missing ' + k);
  }
  return deps;
}

const DEPS = probeInterpreter(PYTHON);

// Recorded paths are invocation-relative wherever they can be, so a copied
// invocation's record still reads correctly in the copy.
function workRel(p) {
  const rel = path.relative(WORK, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : p;
}

// The frozen script and (when it lives under the home) the interpreter are
// recorded relative to RCOS_HOME, so the record survives a copied home.
function homeRel(p) {
  const rel = path.relative(HOME, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : p;
}

function fileEntry(p) {
  const buf = fs.readFileSync(p);
  return { path: workRel(p), sha256: sha256(buf), bytes: buf.length, png: pngHeader(buf) };
}

// Header only: the script's own bytes decide what the images contain, and the
// gate re-reads the pixels. This asks the file, not PIL.
function pngHeader(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 33) return null;
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bit_depth: buf[24],
    color_type: buf[25],
  };
}

// Outcome of one script run. SIGTERM means this adapter's timeout fired. Exit
// 0 = embedded; exit 1 = refused (documented refusal or traceback — the
// streams decide, not this label); anything else = errored.
function outcomeOf(exitStatus, signal) {
  if (signal === 'SIGTERM') return 'timed_out';
  if (exitStatus === 0) return 'embedded';
  if (exitStatus === 1) return 'refused';
  return 'errored';
}

function runCase(c) {
  const started = Date.now();
  const caseDir = path.join(WORK, 'case-' + c.name);
  fs.mkdirSync(caseDir, { recursive: true });
  // The script reads SRC = 'camo-src.png' relative to its cwd: the cover is
  // copied under THAT name, whatever the case's source path is called.
  fs.copyFileSync(c.source, path.join(caseDir, SRC_NAME));

  const scriptAbs = path.resolve(SCRIPT);
  const argv = [scriptAbs, c.url];
  const res = spawnSync(PYTHON, argv, { cwd: caseDir, encoding: 'utf8', timeout: CASE_TIMEOUT_MS });
  if (res.error && res.error.code !== 'ETIMEDOUT') {
    cannotRun('could not start interpreter: ' + res.error.message);
  }
  const duration_ms = Date.now() - started;
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const exit_status = typeof res.status === 'number' ? res.status : null;
  const signal = res.signal || null;

  // Files the script left in its scratch dir, minus the cover this adapter
  // placed there: on success exactly camo-qr-header.png, on refusal none.
  const out_files = fs.readdirSync(caseDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== SRC_NAME)
    .map((e) => e.name)
    .sort()
    .map((name) => fileEntry(path.join(caseDir, name)));

  const produced = out_files
    .filter((f) => f.png)
    .map((f) => ({ evidenceName: f.path.split('/').pop(), source: path.join(caseDir, f.path.split('/').pop()) }));

  // The run's own copy of every stream and every produced byte, so a later
  // reader never has to trust this record or the work dir's survival.
  fs.writeFileSync(path.join(EVIDENCE, 'case-' + c.name + '.stdout.txt'), stdout);
  fs.writeFileSync(path.join(EVIDENCE, 'case-' + c.name + '.stderr.txt'), stderr);
  fs.writeFileSync(path.join(EVIDENCE, 'case-' + c.name + '.argv.json'),
    JSON.stringify({ argv, interpreter: PYTHON, cwd: caseDir, exit_status, signal, duration_ms }, null, 2) + '\n');
  for (const p of produced) {
    fs.copyFileSync(p.source, path.join(EVIDENCE, 'case-' + c.name + '.' + p.evidenceName));
  }

  return {
    name: c.name,
    operation: c.operation,
    source: fileEntry(c.source),
    url: c.url,
    argv,
    interpreter_path: PYTHON,
    exit_status,
    signal,
    outcome: outcomeOf(exit_status, signal),
    duration_ms,
    stdout,
    stderr,
    out_files,
  };
}

let input;
try {
  input = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
} catch (e) {
  cannotRun('could not read $RCOS_INPUT as JSON: ' + e.message);
}

// Cross-field rules the contract's schema subset cannot express. Reported as
// exit 4: this is a request the capability cannot carry out, not a finding.
const seen = new Set();
for (const c of input.cases) {
  if (seen.has(c.name)) cannotRun('duplicate case name: ' + c.name);
  seen.add(c.name);
  if (!fs.existsSync(c.source)) cannotRun('case ' + c.name + ': source does not exist: ' + c.source);
}

fs.writeFileSync(path.join(EVIDENCE, 'frozen.sha256'),
  SCRIPT_SHA + '  ' + SCRIPT + '\n' + 'interpreter: ' + PYTHON + '\n');
fs.writeFileSync(path.join(EVIDENCE, 'deps.json'), JSON.stringify(DEPS, null, 2) + '\n');

const cases = input.cases.map(runCase);

const observation = {
  schema: 'qr-camo-embed-observation/1',
  frozen: {
    script: {
      path: homeRel(SCRIPT),
      sha256: SCRIPT_SHA,
      usage: 'make_header_v2.py [url] — reads ./camo-src.png, writes ./camo-qr-header.png, cwd-relative',
      documented_exit_codes: [0, 1],
    },
    interpreter: {
      path: homeRel(PYTHON),
      version: DEPS.python,
      deps: {
        cv2: DEPS.cv2,
        qrcode: DEPS.qrcode,
        zxingcpp: DEPS.zxingcpp,
        numpy: DEPS.numpy,
        pillow: DEPS.pillow,
      },
    },
  },
  cases,
};

fs.writeFileSync(OUTPUT, JSON.stringify(observation, null, 2) + '\n');

for (const c of cases) {
  console.log(c.name + ' [' + c.operation + '] exit=' + String(c.exit_status) +
    ' outcome=' + c.outcome + ' out_files=' + c.out_files.length +
    (c.signal ? ' signal=' + c.signal : ''));
}
console.log('observed ' + cases.length + ' cases (script ' + SCRIPT_SHA.slice(0, 12) +
  ', interpreter ' + homeRel(PYTHON) + ')');
process.exit(0);
