'use strict';

// The RCOS eval runner. Before this existed, a "ship" was an assertion: someone
// did work, someone wrote a RECEIPT.json by hand, and eval-submit recorded the
// claim. After this, a ship is a mechanical derivation: RCOS executes a declared
// evaluation over frozen inputs, runs the declared gates, and computes the
// verdict from their exit codes.
//
// Two layers, deliberately separated:
//   evals/<eval-id>/     eval DEFINITION (eval.json + fixtures + adapter + gates)
//   runs/<run-id>/       one EXECUTION of a definition (immutable, hash-sealed)
//
// Division of responsibility (non-negotiable, from the Core 1.0 ruling):
//   - adapters execute domain work and return evidence
//   - gates decide pass/fail/blocked from that evidence
//   - the RUNNER computes the verdict from gate results — nothing downstream may
//     write a verdict directly
//
// Exit-code contract, shared with the existing adapter convention in this repo
// (see capabilities/audio-offline-verify/adapter/av_check.py):
//   0 = pass / executed, 3 = gate failure / fix, 4 = cannot probe / blocked.
// Adapters signal "prerequisite unavailable" with 4; any other non-zero adapter
// exit means the evaluation could not establish a result at all -> blocked.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const I = require('./invocation');
const E = require('./eligibility');

const EVAL_SCHEMA = 'rcos-eval/1';
// rcos-eval/2 removes the eval package's private adapter: the package names a
// registered capability and its input, and the run executes it through the
// invocation kernel. The runner must not maintain a second way of invoking
// capabilities — the thing an eval measures has to be the thing reuse calls.
const EVAL_SCHEMA_V2 = 'rcos-eval/2';
const EVAL_SCHEMAS = [EVAL_SCHEMA, EVAL_SCHEMA_V2];
const RUN_SCHEMA = 'rcos-run/1';
const RECEIPT_SCHEMA = 'rcos-run-receipt/1';
const GATE_TYPES = ['deterministic'];
const GATE_STATUSES = ['pass', 'fail', 'blocked', 'error'];

const EXIT_PASS = 0;
const EXIT_FAIL = 3;
const EXIT_BLOCKED = 4;

const DEFAULT_ADAPTER_TIMEOUT_MS = 120000;
const DEFAULT_GATE_TIMEOUT_MS = 60000;

const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;
const PLACEHOLDER_KEYS = ['work', 'eval_dir', 'run_dir'];

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function hashFile(p) { return sha256(fs.readFileSync(p)); }

function evalsDir(homeDir) { return path.join(homeDir, 'evals'); }
function runsDir(homeDir) { return path.join(homeDir, 'runs'); }
function evalDir(homeDir, evalId) { return path.join(evalsDir(homeDir), evalId); }
function runDir(homeDir, runId) { return path.join(runsDir(homeDir), runId); }

// run ids are timestamps + entropy so a run directory name is self-describing
// and collision-free without coordination: 20260917T211412Z-92c41a
function makeRunId(now) {
  const d = now || new Date();
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return stamp + '-' + crypto.randomBytes(3).toString('hex');
}

function isRunId(s) { return typeof s === 'string' && /^\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(s); }

// Any argv element starting with './' is resolved against the eval package
// directory. Without this rule, gate scripts would have to be addressed
// relative to the run's work dir (their cwd), which is a different tree.
function resolveArgv(argv, dir) {
  return argv.map((a) => (typeof a === 'string' && a.startsWith('./') ? path.join(dir, a.slice(2)) : a));
}

// rcos-eval/2 input values may name run-time paths. One pass, and an unknown
// placeholder is an error rather than a silently empty string.
function resolveTemplate(value, ctx, trail) {
  const where = trail || 'capability_input';
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER_RE, (m, k) => {
      if (!PLACEHOLDER_KEYS.includes(k)) {
        throw new Error(where + ': unknown placeholder ' + m + ' (known: ' + PLACEHOLDER_KEYS.map((x) => '{' + x + '}').join(', ') + ')');
      }
      return ctx[k];
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => resolveTemplate(v, ctx, where + '[' + i + ']'));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = resolveTemplate(value[k], ctx, where + '.' + k);
    return out;
  }
  return value;
}

// An invocation outcome is not a verdict; it is the input the verdict is
// derived from. completed -> the adapter ran and its output validated;
// rejected -> the capability refused the input before executing.
function mapInvocationStatus(inv) {
  if (inv.status === 'completed') return { status: 'ok', reason: null };
  if (inv.status === 'rejected') return { status: 'blocked', reason: 'capability rejected the eval input before execution: ' + inv.basis };
  if (inv.status === 'failed') return { status: 'failed', reason: 'capability invocation failed: ' + inv.basis };
  return { status: 'blocked', reason: 'capability invocation blocked: ' + inv.basis };
}

function validateEvalSpec(spec, id) {
  const errors = [];
  if (typeof spec !== 'object' || spec === null) return ['eval.json: must be an object'];
  if (!EVAL_SCHEMAS.includes(spec.schema)) errors.push('schema: must be \'' + EVAL_SCHEMAS.join('\' or \'') + '\'');
  if (typeof spec.eval_id !== 'string' || spec.eval_id.length === 0) errors.push('eval_id: required non-empty string');
  else if (spec.eval_id !== id) errors.push('eval_id: must equal the directory name \'' + id + '\'');
  if (typeof spec.capability_id !== 'string' || spec.capability_id.length === 0) errors.push('capability_id: required non-empty string');
  if (spec.description !== undefined && typeof spec.description !== 'string') errors.push('description: must be a string when present');

  const a = spec.adapter;
  if (spec.schema === EVAL_SCHEMA_V2) {
    // The whole point of /2: no private invocation path.
    if (a !== undefined) {
      errors.push('adapter: rcos-eval/2 invokes the registered capability through the invocation kernel — declare capability_input instead of a private adapter');
    }
    if (typeof spec.capability_input !== 'object' || spec.capability_input === null || Array.isArray(spec.capability_input)) {
      errors.push('capability_input: required object for rcos-eval/2 (the input document for the registered capability)');
    }
    if (spec.capability_mode !== undefined && !I.MODES.includes(spec.capability_mode)) {
      errors.push('capability_mode: must be one of ' + I.MODES.join('|') + ' when present');
    }
  } else {
    if (typeof a !== 'object' || a === null) errors.push('adapter: must be an object');
    else {
      if (!Array.isArray(a.argv) || a.argv.length === 0 || !a.argv.every((x) => typeof x === 'string')) {
        errors.push('adapter.argv: required non-empty string[]');
      }
      if (a.timeout_s !== undefined && !(Number.isFinite(a.timeout_s) && a.timeout_s > 0)) errors.push('adapter.timeout_s: must be a positive number');
    }
  }

  if (!Array.isArray(spec.fixtures) || !spec.fixtures.every((x) => typeof x === 'string')) {
    errors.push('fixtures: required string[] (may be empty)');
  }

  if (!Array.isArray(spec.gates) || spec.gates.length === 0) {
    errors.push('gates: required non-empty array');
  } else {
    const seen = new Set();
    let required = 0;
    spec.gates.forEach((g, i) => {
      const p = 'gates[' + i + ']';
      if (typeof g !== 'object' || g === null) { errors.push(p + ': must be an object'); return; }
      if (typeof g.id !== 'string' || g.id.length === 0) errors.push(p + '.id: required non-empty string');
      else if (seen.has(g.id)) errors.push(p + '.id: duplicate gate id \'' + g.id + '\'');
      else seen.add(g.id);
      if (!GATE_TYPES.includes(g.type)) errors.push(p + '.type: must be one of ' + GATE_TYPES.join('|'));
      if (!Array.isArray(g.argv) || g.argv.length === 0 || !g.argv.every((x) => typeof x === 'string')) errors.push(p + '.argv: required non-empty string[]');
      if (g.required !== undefined && typeof g.required !== 'boolean') errors.push(p + '.required: must be a boolean when present');
      if (g.timeout_s !== undefined && !(Number.isFinite(g.timeout_s) && g.timeout_s > 0)) errors.push(p + '.timeout_s: must be a positive number');
      if (g.required !== false) required += 1;
    });
    // An eval with no required gate could "ship" without anything having to
    // pass — a check that cannot fail. Refuse the definition instead.
    if (required === 0) errors.push('gates: at least one gate must be required (an eval where nothing must pass cannot ship)');
  }
  return errors;
}

function loadEvalPackage(homeDir, id) {
  const dir = evalDir(homeDir, id);
  const specPath = path.join(dir, 'eval.json');
  if (!fs.existsSync(specPath)) {
    const e = new Error('no eval package \'' + id + '\' at ' + specPath);
    e.code = 'ENOEVAL';
    throw e;
  }
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  } catch (err) {
    const e = new Error('eval.json is not valid JSON: ' + err.message);
    e.code = 'EBADEVAL';
    throw e;
  }
  const errors = validateEvalSpec(spec, id);
  if (errors.length > 0) {
    const e = new Error('invalid eval package \'' + id + '\':\n  ' + errors.join('\n  '));
    e.code = 'EBADEVAL';
    e.errors = errors;
    throw e;
  }
  const fixtures = [];
  for (const name of spec.fixtures) {
    const p = path.join(dir, 'fixtures', name);
    if (!fs.existsSync(p)) {
      const e = new Error('fixture missing: fixtures/' + name);
      e.code = 'EBADEVAL';
      throw e;
    }
    const buf = fs.readFileSync(p);
    fixtures.push({ name, path: p, sha256: sha256(buf), bytes: buf.length });
  }
  return { id, dir, spec, fixtures };
}

// The single place a verdict is computed. Inputs are adapter outcome and gate
// results only — no caller may pass a verdict in.
function deriveVerdict(adapterResult, gateResults) {
  if (adapterResult.status !== 'ok') {
    const why = adapterResult.status === 'blocked'
      ? 'adapter could not execute: ' + adapterResult.reason
      : 'adapter failed: ' + adapterResult.reason;
    return { verdict: 'blocked', basis: why };
  }
  const blocked = gateResults.filter((g) => g.status === 'blocked' || g.status === 'error');
  if (blocked.length > 0) {
    return {
      verdict: 'blocked',
      basis: 'evaluation could not establish a result: ' + blocked.map((g) => g.id + ' (' + g.status + ')').join(', ')
    };
  }
  const required = gateResults.filter((g) => g.required);
  const failed = required.filter((g) => g.status === 'fail');
  if (failed.length > 0) {
    return {
      verdict: 'fix',
      basis: failed.length + ' of ' + required.length + ' required gates fail: ' + failed.map((g) => g.id).join(', ')
    };
  }
  return { verdict: 'ship', basis: 'all ' + required.length + ' required gates pass' };
}

function classifyGateExit(code) {
  if (code === EXIT_PASS) return 'pass';
  if (code === EXIT_FAIL) return 'fail';
  if (code === EXIT_BLOCKED) return 'blocked';
  return 'error';
}

function runChild(argv, opts) {
  const started = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    env: opts.env,
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    maxBuffer: 8 * 1024 * 1024
  });
  const duration = Date.now() - started;
  const out = {
    argv,
    exit_code: r.status,
    signal: r.signal === undefined ? null : r.signal,
    stdout: r.stdout === null || r.stdout === undefined ? '' : r.stdout,
    stderr: r.stderr === null || r.stderr === undefined ? '' : r.stderr,
    duration_ms: duration
  };
  if (r.error) out.error = r.error.code || r.error.message;
  return out;
}

function listFilesRecursive(root, base) {
  const b = base === undefined ? root : base;
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(p, b));
    else if (entry.isFile()) out.push(path.relative(b, p));
  }
  return out;
}

function runEval(homeDir, evalId, opts) {
  const o = opts || {};
  const home = path.resolve(homeDir);
  const pkg = loadEvalPackage(home, evalId);
  const startedAt = new Date();
  const runId = o.runId || makeRunId(startedAt);
  if (!isRunId(runId)) throw new Error('run id must look like 20260917T211412Z-92c41a, got \'' + runId + '\'');
  const dir = runDir(home, runId);
  if (fs.existsSync(dir)) {
    throw new Error('run ' + runId + ' already exists — runs are immutable and never rewritten: ' + dir);
  }
  const work = path.join(dir, 'work');
  const evidence = path.join(dir, 'evidence');
  fs.mkdirSync(path.join(evidence, 'inputs'), { recursive: true });
  fs.mkdirSync(path.join(evidence, 'outputs'), { recursive: true });
  fs.mkdirSync(work, { recursive: true });

  // 1. freeze inputs: fixtures are copied into the work dir (the adapter's
  //    workspace) and their hashes recorded before anything executes.
  const frozen = [];
  for (const f of pkg.fixtures) {
    const dst = path.join(work, f.name);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(f.path, dst);
    const evDst = path.join(evidence, 'inputs', f.name);
    fs.mkdirSync(path.dirname(evDst), { recursive: true });
    fs.copyFileSync(f.path, evDst);
    frozen.push({ name: f.name, sha256: f.sha256, bytes: f.bytes });
  }
  const input = {
    schema: RUN_SCHEMA,
    eval_id: pkg.id,
    capability_id: pkg.spec.capability_id,
    eval_sha256: hashFile(path.join(pkg.dir, 'eval.json')),
    adapter_argv: pkg.spec.adapter ? resolveArgv(pkg.spec.adapter.argv, pkg.dir) : null,
    fixtures: frozen,
    created_at: startedAt.toISOString()
  };

  // rcos-eval/2: the package's input document is resolved and handed to the
  // invocation kernel. Written before input.json so the run's own record names
  // the exact bytes the capability was given.
  let capabilityInput = null;
  if (pkg.spec.schema === EVAL_SCHEMA_V2) {
    capabilityInput = resolveTemplate(pkg.spec.capability_input, { work, eval_dir: pkg.dir, run_dir: dir });
    const ciPath = path.join(dir, 'capability-input.json');
    fs.writeFileSync(ciPath, JSON.stringify(capabilityInput, null, 2) + '\n');
    input.capability_input = { path: 'capability-input.json', sha256: hashFile(ciPath) };
  }
  fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify(input, null, 2) + '\n');

  const childEnv = Object.assign({}, process.env, o.env, {
    RCOS_HOME: home,
    RCOS_RUN_DIR: dir,
    RCOS_WORK_DIR: work,
    RCOS_EVIDENCE_DIR: evidence,
    RCOS_EVAL_DIR: pkg.dir,
    RCOS_BIN: path.join(__dirname, '..', 'bin', 'rcos')
  });

  // 2. get the work done; 3. capture what it produced. /2 goes through the
  //    invocation kernel — the same path reuse calls. /1 keeps its private
  //    adapter for as long as its package exists, but the architecture points
  //    at /2: no package gets to maintain a second way of invoking a capability.
  let invocation = null;
  let eligibility = null;
  let adapterRun;
  let adapterStatus;
  let adapterReason = null;
  if (pkg.spec.schema === EVAL_SCHEMA_V2) {
    // Eligibility is asked in the package's declared mode and the answer is
    // recorded with the run. An eval exists to establish quality, so the eval
    // caller context does not require the quality it is about to measure — but
    // the kernel still executes nothing without a decision naming this
    // capability, this version and this purpose.
    const capMode = pkg.spec.capability_mode || 'eval';
    const dec = E.decideForHome(home, pkg.spec.capability_id, {
      purpose: capMode,
      scope: 'execute',
      // a package that declares forensic mode is itself the recorded reason
      forensicReason: capMode === 'forensic' ? 'eval package ' + pkg.id + ' declares capability_mode forensic' : undefined,
      now: startedAt
    });
    if (!dec.ok) {
      adapterStatus = 'blocked';
      adapterReason = 'eligibility could not be decided: ' + dec.error;
      adapterRun = { argv: [], exit_code: null, signal: null, stdout: '', stderr: '', duration_ms: 0 };
    } else {
      eligibility = {
        decision_id: dec.decision_id,
        sha256: dec.decision_sha256,
        purpose: dec.decision.caller_context.purpose,
        eligible: dec.eligible,
        reasons: dec.reasons,
        dir: path.relative(home, dec.dir).split(path.sep).join('/')
      };
      if (!dec.eligible) {
        adapterStatus = 'blocked';
        adapterReason = 'capability is not eligible in ' + capMode + ' mode: ' + dec.reasons.join(', ');
        adapterRun = { argv: [], exit_code: null, signal: null, stdout: '', stderr: '', duration_ms: 0 };
      } else {
        const inv = I.invokeCapability(home, pkg.spec.capability_id, {
          input: capabilityInput,
          mode: capMode,
          now: startedAt,
          eligibilityDecisionId: dec.decision_id
        });
        if (!inv.ok) {
          adapterStatus = 'blocked';
          adapterReason = 'invocation could not start: ' + inv.error;
          adapterRun = { argv: [], exit_code: null, signal: null, stdout: '', stderr: '', duration_ms: 0 };
        } else {
          const mapped = mapInvocationStatus(inv);
          adapterStatus = mapped.status;
          adapterReason = mapped.reason;
          adapterRun = {
            argv: [path.join(home, inv.manifest.adapter.entrypoint || '')],
            exit_code: inv.manifest.adapter.exit_code,
            signal: inv.manifest.adapter.signal,
            stdout: '',
            stderr: '',
            duration_ms: inv.manifest.duration_ms
          };
          invocation = {
            invocation_id: inv.invocation_id,
            status: inv.status,
            mode: inv.manifest.mode,
            dir: path.relative(home, inv.dir).split(path.sep).join('/'),
            manifest_sha256: inv.manifest_sha256,
            output_sha256: inv.output_sha256,
            eligibility_decision_id: inv.eligibility_decision_id,
            eligibility_sha256: inv.eligibility_sha256
          };
          childEnv.RCOS_INVOCATION_ID = inv.invocation_id;
          childEnv.RCOS_INVOCATION_DIR = inv.dir;
          childEnv.RCOS_INVOCATION_STATUS = inv.status;
        }
      }
    }
  } else {
    adapterRun = runChild(input.adapter_argv, {
      cwd: work,
      env: childEnv,
      timeoutMs: (pkg.spec.adapter.timeout_s || DEFAULT_ADAPTER_TIMEOUT_MS / 1000) * 1000
    });
    if (adapterRun.error) { adapterStatus = 'failed'; adapterReason = adapterRun.error; }
    else if (adapterRun.signal) { adapterStatus = 'failed'; adapterReason = 'killed by signal ' + adapterRun.signal; }
    else if (adapterRun.exit_code === EXIT_BLOCKED) { adapterStatus = 'blocked'; adapterReason = 'adapter reported prerequisite unavailable (exit 4)'; }
    else if (adapterRun.exit_code !== EXIT_PASS) { adapterStatus = 'failed'; adapterReason = 'adapter exited ' + adapterRun.exit_code; }
    else { adapterStatus = 'ok'; }
  }
  const adapterResult = Object.assign({ status: adapterStatus, reason: adapterReason }, adapterRun);

  const produced = [];
  for (const rel of listFilesRecursive(work)) {
    if (frozen.some((f) => f.name === rel)) continue; // the frozen copies themselves
    const p = path.join(work, rel);
    const buf = fs.readFileSync(p);
    const evDst = path.join(evidence, 'outputs', rel);
    fs.mkdirSync(path.dirname(evDst), { recursive: true });
    fs.copyFileSync(p, evDst);
    produced.push({ path: rel, sha256: sha256(buf), bytes: buf.length });
  }
  const output = { schema: RUN_SCHEMA, run_id: runId, adapter: adapterResult, produced };
  fs.writeFileSync(path.join(dir, 'output.json'), JSON.stringify(output, null, 2) + '\n');

  // 4. run the declared gates. All gates run even after a failure — the receipt
  //    is more useful when it shows the whole picture than when it stops at the
  //    first red. Gates are skipped only when the adapter never executed.
  const gateResults = [];
  for (const g of pkg.spec.gates) {
    const required = g.required !== false;
    if (adapterStatus !== 'ok') {
      gateResults.push({
        id: g.id, type: g.type, required, argv: resolveArgv(g.argv, pkg.dir),
        status: 'blocked', exit_code: null, signal: null, stdout: '', stderr: '',
        duration_ms: 0, note: 'not run: adapter did not execute'
      });
      continue;
    }
    const r = runChild(resolveArgv(g.argv, pkg.dir), {
      cwd: work,
      env: childEnv,
      timeoutMs: (g.timeout_s || DEFAULT_GATE_TIMEOUT_MS / 1000) * 1000
    });
    const status = r.error ? 'error' : classifyGateExit(r.exit_code);
    gateResults.push(Object.assign({ id: g.id, type: g.type, required, status }, r));
  }
  const checks = { schema: RUN_SCHEMA, run_id: runId, gates: gateResults };
  fs.writeFileSync(path.join(dir, 'checks.json'), JSON.stringify(checks, null, 2) + '\n');

  // 5. the runner — and only the runner — computes the verdict.
  const derived = deriveVerdict(adapterResult, gateResults);
  const finishedAt = new Date();
  const manifest = {
    schema: RUN_SCHEMA,
    run_id: runId,
    eval_id: pkg.id,
    capability_id: pkg.spec.capability_id,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt - startedAt,
    invocation,
    eligibility,
    rcos_home: home,
    node: process.version
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // 6. seal: the receipt hashes every other artifact in the run dir. Written
  //    last so it never has to hash itself.
  const artifacts = [];
  for (const rel of listFilesRecursive(dir)) {
    if (rel === 'receipt.json') continue;
    const p = path.join(dir, rel);
    artifacts.push({ path: rel, sha256: hashFile(p), bytes: fs.statSync(p).size });
  }
  const receipt = {
    schema: RECEIPT_SCHEMA,
    run_id: runId,
    eval_id: pkg.id,
    capability_id: pkg.spec.capability_id,
    verdict: derived.verdict,
    verdict_basis: derived.basis,
    gates: gateResults.map((g) => ({ id: g.id, type: g.type, required: g.required, status: g.status, exit_code: g.exit_code })),
    invocation,
    eligibility,
    artifacts,
    created_at: finishedAt.toISOString()
  };
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

  return { run_id: runId, run_dir: dir, verdict: receipt.verdict, basis: receipt.verdict_basis, gates: receipt.gates, receipt };
}

// Re-hash every artifact the receipt names and compare. This is the check that
// CAN fail: if a run directory is edited after the fact, verification says so.
function verifyRun(homeDir, runId) {
  const dir = runDir(homeDir, runId);
  const receiptPath = path.join(dir, 'receipt.json');
  if (!fs.existsSync(receiptPath)) {
    const e = new Error('no receipt at ' + receiptPath);
    e.code = 'ENORECEIPT';
    throw e;
  }
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const mismatches = [];
  if (receipt.run_id !== runId) mismatches.push({ path: 'receipt.json', problem: 'receipt run_id \'' + receipt.run_id + '\' != directory \'' + runId + '\'' });
  const listed = new Set();
  for (const a of receipt.artifacts) {
    listed.add(a.path);
    const p = path.join(dir, a.path);
    if (!fs.existsSync(p)) { mismatches.push({ path: a.path, problem: 'missing' }); continue; }
    const actual = hashFile(p);
    if (actual !== a.sha256) mismatches.push({ path: a.path, problem: 'sha256 mismatch', expected: a.sha256, actual });
  }
  for (const rel of listFilesRecursive(dir)) {
    if (rel === 'receipt.json') continue;
    if (!listed.has(rel)) mismatches.push({ path: rel, problem: 'not listed in receipt' });
  }
  return { ok: mismatches.length === 0, run_id: runId, receipt, mismatches };
}

function listEvalPackages(homeDir) {
  const root = evalsDir(homeDir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
    if (!entry.isDirectory()) continue;
    const specPath = path.join(root, entry.name, 'eval.json');
    if (!fs.existsSync(specPath)) continue; // legacy receipt-only dirs are not packages
    try {
      const pkg = loadEvalPackage(homeDir, entry.name);
      out.push({ id: pkg.id, capability_id: pkg.spec.capability_id, description: pkg.spec.description || null, gates: pkg.spec.gates.length, fixtures: pkg.fixtures.length, dir: pkg.dir });
    } catch (err) {
      out.push({ id: entry.name, error: err.message });
    }
  }
  return out;
}

function listRuns(homeDir) {
  const root = runsDir(homeDir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((x, y) => y.name.localeCompare(x.name))) {
    if (!entry.isDirectory()) continue;
    const receiptPath = path.join(root, entry.name, 'receipt.json');
    if (!fs.existsSync(receiptPath)) { out.push({ run_id: entry.name, error: 'no receipt.json' }); continue; }
    try {
      const r = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      out.push({ run_id: r.run_id, eval_id: r.eval_id, capability_id: r.capability_id, verdict: r.verdict, created_at: r.created_at });
    } catch (err) {
      out.push({ run_id: entry.name, error: err.message });
    }
  }
  return out;
}

module.exports = {
  EVAL_SCHEMA, RUN_SCHEMA, RECEIPT_SCHEMA, GATE_TYPES, GATE_STATUSES,
  EXIT_PASS, EXIT_FAIL, EXIT_BLOCKED,
  evalsDir, runsDir, evalDir, runDir, makeRunId, isRunId, resolveArgv,
  validateEvalSpec, loadEvalPackage, deriveVerdict, runEval, verifyRun,
  listEvalPackages, listRuns
};
