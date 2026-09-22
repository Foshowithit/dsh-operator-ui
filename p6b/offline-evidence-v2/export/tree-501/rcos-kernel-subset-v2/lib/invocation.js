'use strict';
// The invocation kernel: one way for RCOS to execute a registered capability.
//
// Invariant this file exists to hold:
//   If a registry entry claims to be a reusable capability, RCOS itself must
//   know how to invoke that capability from its declared adapter and validate
//   the result against its contract.
//
// What it deliberately is NOT: a router, a selector, a planner, or a judge.
// The caller names the capability. The kernel resolves the declaration, checks
// the input contract, runs the entrypoint once, checks the output contract and
// writes a write-once invocation artifact. It never decides whether the result
// was *good* — that belongs to the eval runner. An invocation succeeding does
// not prove the capability is good.
//
// It is also dumb about eligibility. The kernel contains no promotion or eval
// policy: the caller brings an eligibility decision (lib/eligibility.js), the
// kernel verifies that the decision refers to this capability and version, says
// eligible, was asked at scope=execute, permits this mode, and has intact
// integrity — then executes. It never recomputes eligibility, because two
// implementations of one policy is how a system starts disagreeing with itself.
// What stays here is execution safety: adapter declared, entrypoint present and
// executable, contracts validated, timeout. Those are not policy; they are "can
// these bytes run".
//
// That scope check is the one place the three meanings are allowed to touch:
// eligibility says MAY, selection (lib/selection.js) says WHICH, and this file
// says CAN EXECUTE SAFELY. A scope=compete decision means "this capability may
// stand for election" and must never authorize a run, so a compete decision
// handed to the kernel is refused here rather than trusted upstream.
//
// A caller may also bring the selection it reached this capability through.
// That is provenance, never authority: the selection is verified and the
// capability it chose must be the capability being invoked, but the fresh
// scope=execute decision is still what authorizes the run. Direct invocation
// (`rcos run <id>`) is not required to have had an election.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const R = require('./registry');
const A = require('./adapter');
const E = require('./eligibility');
const S = require('./selection');
// Safe at top level: evidence.js never loads this file — its producer checks
// read the manifest from disk — so there is no load cycle in either direction.
const EV = require('./evidence');

const INVOCATION_SCHEMA = 'rcos-invocation/1';
// normal  = production reuse.
// eval    = the eval runner exercising a capability that is not yet promoted.
// forensic= an explicit, recorded override to run something RCOS would
//           otherwise refuse (retired, or an unpromoted candidate).
// What each mode may invoke is not decided here: the mode must match the
// purpose of the eligibility decision the caller supplies.
const MODES = ['normal', 'eval', 'forensic'];
const INVOCATION_STATUSES = ['completed', 'rejected', 'failed', 'blocked'];
const ADAPTER_EXIT_BLOCKED = 4;
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_BUFFER = 16 * 1024 * 1024;
const INVOCATION_ID_RE = /^inv_\d{8}T\d{6}Z-[0-9a-f]{6}$/;

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function makeInvocationId(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return 'inv_' + iso + '-' + crypto.randomBytes(3).toString('hex');
}

function isInvocationId(id) { return INVOCATION_ID_RE.test(String(id)); }

function invocationsDir(homeDir) { return path.join(homeDir, 'invocations'); }
function invocationDir(homeDir, id) { return path.join(invocationsDir(homeDir), id); }

function listFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function fileEntry(root, p) {
  const buf = fs.readFileSync(p);
  return { path: path.relative(root, p).split(path.sep).join('/'), sha256: sha256(buf), bytes: buf.length };
}

// Self-integrity: the manifest hashes itself so a hand-edited manifest is
// detectable without trusting the file's own contents.
function manifestIntegrity(manifest) {
  const { integrity, ...rest } = manifest;
  return sha256(JSON.stringify(rest, null, 2) + '\n');
}

function invokeCapability(homeDir, capabilityId, opts = {}) {
  const mode = opts.mode || 'normal';
  if (!MODES.includes(mode)) return { ok: false, error: 'unknown mode \'' + mode + '\' (one of ' + MODES.join('|') + ')' };
  const now = opts.now || new Date();
  const reg = R.loadRegistry(homeDir);
  // Deliberately not R.findCapability: an id the registry does not hold is a
  // refusal the kernel reports, not an exception the caller has to catch.
  const cap = reg.capabilities.find((c) => c.id === capabilityId);
  if (!cap) return { ok: false, error: 'no such capability \'' + capabilityId + '\' in the registry' };

  let id = opts.invocationId || makeInvocationId(now);
  if (opts.invocationId && !isInvocationId(id)) throw new Error('bad invocation id: ' + id);
  // A caller that names no decision has not asked the question eligibility
  // answers. That is a programming error, not a refusal, so it is reported
  // without writing an artifact.
  const decisionId = opts.eligibilityDecisionId;
  if (typeof decisionId !== 'string' || !E.isDecisionId(decisionId)) {
    return { ok: false, error: 'invocation requires an eligibility decision — construct a caller context and run the eligibility engine first (rcos run and eval-run do this for you), then pass its decision id' };
  }
  const dir = invocationDir(homeDir, id);
  // The container may not exist yet; the id directory itself is created
  // non-recursively so EEXIST stays the write-once signal.
  fs.mkdirSync(invocationsDir(homeDir), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try { fs.mkdirSync(dir); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (opts.invocationId) throw new Error('invocation ' + id + ' already exists — invocations are write-once and never rewritten');
      if (attempt >= 5) throw e;
      id = makeInvocationId(now);
    }
  }
  const workDir = path.join(dir, 'work');
  const evidenceDir = path.join(dir, 'evidence');
  fs.mkdirSync(workDir);
  fs.mkdirSync(evidenceDir);

  const startedAt = new Date();
  const inputDoc = opts.input === undefined ? null : opts.input;
  fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify(inputDoc, null, 2) + '\n');

  const decl = cap.adapter;
  const declErrors = decl === undefined
    ? ['capability declares no adapter — RCOS has no declared way to invoke it']
    : A.validateAdapterDeclaration(decl);
  const contractRes = declErrors.length === 0 ? A.loadContract(homeDir, decl) : { ok: false, contract: null, errors: [], path: null };
  const entrypoint = declErrors.length === 0 ? A.resolveEntrypoint(homeDir, decl) : null;

  let status;
  let basis;
  let spawnRes = null;
  let inputCheck = { status: 'not-checked', errors: [] };
  let outputCheck = { status: 'not-checked', errors: [] };
  let outputFile = null;
  let decision = null;
  let decisionSha = null;
  let decisionPath = null;
  const decisionProblems = [];
  // Optional, and only provenance: see the header. Absent for direct invocation.
  const selectionId = typeof opts.selectionId === 'string' && opts.selectionId.length > 0 ? opts.selectionId : null;
  let selection = null;
  let selectionSha = null;
  let selectionPath = null;
  const selectionProblems = [];
  // Evidence classification state, computed once right before the manifest
  // seals and minted right after. The kernel never treats adapter output as
  // evidence on its own: an adapter that wants a claim recorded writes an
  // emission file into $RCOS_EVIDENCE_DIR, and each minted record pins this
  // invocation by id and by the manifest's own bytes.
  //
  // The ordering is load-bearing. Classification runs while the manifest is
  // still open (it needs no manifest hash), the manifest seals, the sha of the
  // sealed bytes is known, and only then does minting happen — so a record can
  // never carry a placeholder hash or pin bytes that later change. An invalid
  // emission is reported in the manifest's emission_skipped list, never
  // recorded, and never fails the invocation it rode along with: the run
  // happened, the claim about the run did not check out, and those are two
  // different facts.
  let classifiedEmissions = { valid: [], skipped: [] };
  // Sealed into the manifest: the file each valid emission came from and the
  // evidence id classification assigned it. Classification fixes those ids
  // while the manifest is still open, which is the only reason the sealed bytes
  // can name records that do not exist yet — the manifest-to-record half of the
  // two-way link. Record hashes cannot seal here (the records do not exist
  // until the manifest bytes exist to pin); they travel in the return value.
  let emittedEvidenceSealed = [];
  // Minted after the seal, with hashes. Returned to the caller, never
  // resealed: resealing would change the bytes the records pin.
  let emittedEvidence = [];
  let emissionSkipped = [];

  // Adapter-emitted evidence is validated exactly once, regardless of which
  // exit path seals the manifest: run classification, stamp the skipped entries
  // into the result so the manifest records what it refused and why, and fill
  // the sealed list from the same classification. Both lists must be complete
  // before the manifest is written — an array handed to the manifest and
  // appended to afterwards would put entries in the returned object that the
  // sealed bytes do not carry, which is how the manifest-to-record half of the
  // link goes vacuous while every in-memory check still passes.
  const classifyStep6Emissions = () => {
    classifiedEmissions = EV.classifyEmissions(homeDir, evidenceDir, {
      invocation_id: id,
      capability_id: cap.id,
      capability_version: cap.version
    });
    emissionSkipped.push(...classifiedEmissions.skipped);
    for (const v of classifiedEmissions.valid) {
      emittedEvidenceSealed.push({ file: v.file, evidence_id: v.evidence_id });
    }
  };

  // After the manifest file exists, each classified-valid emission is minted
  // as a record whose producer block pins the sealed manifest bytes. The id
  // classification assigned is the id that mints, so the self-reference and
  // cycle answers cannot drift between the halves. Minting cannot fail the
  // invocation: classification already ran the full mintability check, and the
  // only remaining producer question — manifest exists and bytes match — is
  // true by construction at this point. A defensive failure is reported to the
  // caller rather than thrown, so the artifact can never be left half-minted by
  // an exception; it cannot be written back into the manifest, because the
  // manifest is sealed and resealing it would change the bytes the records pin.
  // The disk side shows the same failure from the other direction: the sealed
  // manifest names an id whose record is not there, which is exactly what
  // verifyInvocation reports as a missing record.
  const mintStep6Emissions = (manifestSha) => {
    for (const v of classifiedEmissions.valid) {
      const res = EV.createEvidence(homeDir, v.fields, {
        evidenceId: v.evidence_id,
        producer: {
          capability_id: cap.id,
          capability_version: cap.version,
          invocation_id: id,
          invocation_manifest_sha256: manifestSha
        }
      });
      if (res.ok) {
        emittedEvidence.push({ file: v.file, evidence_id: res.evidence_id, evidence_sha256: res.evidence_sha256 });
      } else {
        emissionSkipped.push({ file: v.file, reason: res.error });
      }
    }
  };

  const finish = () => {
    const completedAt = new Date();
    fs.writeFileSync(path.join(dir, 'stdout.txt'), spawnRes && spawnRes.stdout ? spawnRes.stdout : '');
    fs.writeFileSync(path.join(dir, 'stderr.txt'), spawnRes && spawnRes.stderr ? spawnRes.stderr : '');
    // Classify adapter emissions while the manifest is still open: the skipped
    // list seals into the manifest below, and the valid ones mint only after
    // the manifest bytes exist to pin. Every exit path runs this, so every
    // manifest carries the same emission shape — including refusals sealed
    // before any adapter ran, where classification trivially finds nothing.
    classifyStep6Emissions();
    const manifest = {
      schema: INVOCATION_SCHEMA,
      invocation_id: id,
      capability_id: cap.id,
      capability_version: cap.version,
      registry_status: cap.status,
      mode,
      status,
      status_basis: basis,
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      duration_ms: completedAt.getTime() - startedAt.getTime(),
      input: fileEntry(dir, path.join(dir, 'input.json')),
      output: outputFile && fs.existsSync(outputFile) ? fileEntry(dir, outputFile) : null,
      stdout: fileEntry(dir, path.join(dir, 'stdout.txt')),
      stderr: fileEntry(dir, path.join(dir, 'stderr.txt')),
      evidence: listFilesRecursive(evidenceDir).map((p) => fileEntry(dir, p)),
      adapter: {
        type: declErrors.length === 0 ? decl.type : null,
        entrypoint: declErrors.length === 0 ? decl.entrypoint : null,
        timeout_seconds: declErrors.length === 0 ? (decl.timeout_seconds === undefined ? DEFAULT_TIMEOUT_SECONDS : decl.timeout_seconds) : null,
        exit_code: spawnRes ? spawnRes.status : null,
        signal: spawnRes ? spawnRes.signal : null,
        error: spawnRes && spawnRes.error ? String(spawnRes.error.code || spawnRes.error.message) : null
      },
      contract: {
        path: contractRes.path === null || contractRes.path === undefined ? null : path.relative(homeDir, contractRes.path),
        declaration_errors: declErrors,
        contract_errors: contractRes.errors,
        input: inputCheck,
        output: outputCheck
      },
      rcos_home: homeDir,
      created_at: completedAt.toISOString(),
      // The decision this invocation consumed. Copied, not recomputed: the
      // manifest records what eligibility said, and points at the artifact
      // that said it.
      eligibility_decision_id: decisionId,
      eligibility_sha256: decisionSha,
      eligibility: {
        scope: decision ? decision.scope : null,
        purpose: decision && decision.caller_context ? decision.caller_context.purpose : null,
        eligible: decision ? decision.eligible : null,
        reasons: decision ? decision.reasons : null,
        path: decisionPath !== null && fs.existsSync(decisionPath) ? path.relative(homeDir, decisionPath).split(path.sep).join('/') : null
      },
      // The election this invocation was reached through, when there was one.
      // Copied, not recomputed, exactly like the decision above — and null for
      // direct invocation, which is a legitimate way to run a capability.
      selection_id: selectionId,
      selection_sha256: selectionSha,
      selection: selectionId === null ? null : {
        selector: selection ? selection.selector : null,
        status: selection ? selection.status : null,
        selected_capability_id: selection ? selection.selected_capability_id : null,
        candidates: selection && Array.isArray(selection.candidates) ? selection.candidates.map((c) => c.capability_id) : null,
        path: selectionPath !== null && fs.existsSync(selectionPath) ? path.relative(homeDir, selectionPath).split(path.sep).join('/') : null
      },
      // What this run's adapter explicitly emitted as evidence, and what it
      // tried to emit that did not check out. `emitted_evidence` seals the
      // file each valid emission came from plus the evidence id classification
      // assigned it — the manifest-to-record half of the two-way link. Record
      // hashes cannot seal here (the records do not exist until the manifest
      // bytes exist to pin); they travel in the return value below. The record
      // carries the other half: its producer block pins this manifest by id
      // and by bytes. An adapter that emitted nothing leaves an empty array
      // and an empty skipped list — the honest answer for "nothing was
      // claimed", not a gap. The emission files themselves stay listed under
      // `evidence` above (they are files in the artifact); these two blocks
      // are the core's judgment about them. Both lists seal as copies taken
      // here: what follows the seal (minting) must not be able to change what
      // the sealed bytes say, and it must not be able to make the returned
      // object disagree with the file on disk.
      emitted_evidence: emittedEvidenceSealed.map((x) => ({ file: x.file, evidence_id: x.evidence_id })),
      emission_skipped: emissionSkipped.map((x) => ({ file: x.file, reason: x.reason }))
    };
    if (mode === 'forensic') manifest.forensic_reason = opts.forensicReason || null;
    manifest.integrity = { algo: 'sha256', value: manifestIntegrity(manifest) };
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    // The manifest bytes now exist: mint each classified-valid emission as a
    // record pinning them. Minting runs after every manifest write, including
    // refusals — where the valid list is always empty, because an adapter that
    // never ran emitted nothing.
    const manifestSha = sha256(fs.readFileSync(manifestPath));
    mintStep6Emissions(manifestSha);
    return {
      ok: true,
      status,
      basis,
      invocation_id: id,
      capability_id: cap.id,
      dir,
      manifest,
      manifest_path: manifestPath,
      manifest_sha256: manifestSha,
      output_sha256: manifest.output ? manifest.output.sha256 : null,
      eligibility_decision_id: decisionId,
      eligibility_sha256: decisionSha,
      eligibility: manifest.eligibility,
      eligibility_decision: decision,
      selection_id: selectionId,
      selection_sha256: selectionSha,
      selection: manifest.selection,
      // The return value carries what the sealed bytes cannot: the record hash
      // each emitted file minted, once the sealed manifest existed to pin. The
      // manifest carries ids; the return adds hashes. Nothing reseals after
      // this point — a reseal would change the bytes the records pin.
      emitted_evidence: emittedEvidence,
      emission_skipped: emissionSkipped
    };
  };

  // 1. The eligibility decision. Consumed, never recomputed. The kernel asks
  //    five questions of the artifact and refuses on any no.
  decisionPath = path.join(E.decisionDir(homeDir, decisionId), 'decision.json');
  if (!fs.existsSync(decisionPath)) {
    decisionProblems.push('no such eligibility decision artifact: ' + decisionId);
  } else {
    const raw = fs.readFileSync(decisionPath);
    decisionSha = sha256(raw);
    try { decision = JSON.parse(raw.toString('utf8')); } catch (e) {
      decisionProblems.push('eligibility decision is not valid JSON: ' + e.message);
      decision = null;
    }
  }
  if (decision) {
    if (!decision.integrity || decision.integrity.algo !== 'sha256') {
      decisionProblems.push('eligibility decision carries no integrity block');
    } else if (decision.integrity.value !== E.decisionIntegrity(decision)) {
      decisionProblems.push('eligibility decision integrity mismatch — it was edited after it was written');
    }
    if (decision.capability_id !== cap.id || decision.capability_version !== cap.version) {
      decisionProblems.push('eligibility decision is about ' + decision.capability_id + ' ' + decision.capability_version + ', not ' + cap.id + ' ' + cap.version);
    }
    if (decision.eligible !== true) {
      decisionProblems.push('eligibility decision does not permit execution: ' + (decision.reasons || []).join(', '));
    }
    // The fifth question, and the one that keeps the three meanings apart: a
    // decision that only permitted competition must not authorize a run.
    if (decision.scope !== 'execute') {
      decisionProblems.push('eligibility decision was asked at scope \'' + decision.scope + '\' — only a scope=execute decision authorizes execution, and a scope=compete decision means "may stand for election", not "may run"');
    }
    const decidedPurpose = decision.caller_context ? decision.caller_context.purpose : null;
    if (decidedPurpose !== mode) {
      decisionProblems.push('eligibility decision was made for purpose \'' + decidedPurpose + '\', which does not authorize a ' + mode + '-mode invocation');
    }
  }
  if (decisionProblems.length > 0) {
    status = 'blocked';
    basis = 'eligibility decision ' + decisionId + ' does not authorize this invocation: ' + decisionProblems.join('; ');
    return finish();
  }

  // 1b. The selection, when the caller brought one. Verified, never trusted,
  //     and it must have chosen the capability actually being invoked — a
  //     selection that says WHICH is still not an authorization, so this block
  //     only refuses; it never permits anything the decision above did not.
  if (selectionId !== null) {
    selectionPath = path.join(S.selectionDir(homeDir, selectionId), 'selection.json');
    if (!fs.existsSync(selectionPath)) {
      selectionProblems.push('no such selection artifact: ' + selectionId);
    } else {
      const v = S.verifySelection(homeDir, selectionId);
      if (!v.ok) {
        selectionProblems.push(...v.problems);
      } else {
        selection = v.selection;
        selectionSha = sha256(fs.readFileSync(selectionPath));
        if (selection.status !== 'selected') {
          selectionProblems.push('selection status is \'' + selection.status + '\' — only a selection that named a capability can be attached to an invocation');
        }
        if (selection.selected_capability_id !== cap.id) {
          selectionProblems.push('selection chose \'' + String(selection.selected_capability_id) + '\', not \'' + cap.id + '\'');
        }
      }
    }
  }
  if (selectionProblems.length > 0) {
    status = 'blocked';
    basis = 'selection ' + selectionId + ' does not authorize this invocation: ' + selectionProblems.join('; ');
    return finish();
  }

  // 2. Adapter declaration.
  if (declErrors.length > 0) { status = 'blocked'; basis = 'adapter declaration is not usable: ' + declErrors.join('; '); return finish(); }

  // 3. Contract declaration (a contract that cannot be enforced blocks; it does
  //    not silently downgrade to "no contract").
  if (!contractRes.ok) { status = 'blocked'; basis = 'declared contract is not usable: ' + contractRes.errors.join('; '); return finish(); }

  // 4. Entrypoint.
  if (!fs.existsSync(entrypoint)) {
    status = 'blocked';
    basis = 'adapter entrypoint is missing: ' + decl.entrypoint;
    return finish();
  }
  if (!fs.statSync(entrypoint).isFile()) { status = 'blocked'; basis = 'adapter entrypoint is not a file: ' + decl.entrypoint; return finish(); }
  try { fs.accessSync(entrypoint, fs.constants.X_OK); } catch (e) {
    status = 'blocked';
    basis = 'adapter entrypoint is not executable: ' + decl.entrypoint;
    return finish();
  }

  // 5. Input contract — before any execution.
  if (contractRes.contract && contractRes.contract.input) {
    const errs = A.validateValue(inputDoc, contractRes.contract.input, 'input');
    if (errs.length > 0) {
      inputCheck = { status: 'fail', errors: errs };
      status = 'rejected';
      basis = 'input did not satisfy the declared input contract: ' + errs.join('; ');
      return finish();
    }
    inputCheck = { status: 'pass', errors: [] };
  }

  // 6. Execute the declared adapter once.
  outputFile = path.join(dir, 'output.json');
  const timeoutSeconds = decl.timeout_seconds === undefined ? DEFAULT_TIMEOUT_SECONDS : decl.timeout_seconds;
  const childEnv = Object.assign({}, process.env, {
    RCOS_HOME: homeDir,
    RCOS_BIN: path.join(__dirname, '..', 'bin', 'rcos'),
    RCOS_INVOCATION_ID: id,
    RCOS_INVOCATION_DIR: dir,
    RCOS_INVOCATION_WORK_DIR: workDir,
    RCOS_INPUT: path.join(dir, 'input.json'),
    RCOS_OUTPUT: outputFile,
    RCOS_EVIDENCE_DIR: evidenceDir,
    RCOS_CAPABILITY_ID: cap.id,
    RCOS_CAPABILITY_VERSION: cap.version,
    RCOS_CAPABILITY_DIR: path.join(homeDir, 'capabilities', cap.id),
    RCOS_ADAPTER_TYPE: decl.type,
    RCOS_MODE: mode
  });
  spawnRes = spawnSync(entrypoint, [], {
    cwd: workDir,
    env: childEnv,
    encoding: 'utf8',
    timeout: timeoutSeconds * 1000,
    maxBuffer: MAX_BUFFER
  });

  if (spawnRes.error) {
    const code = String(spawnRes.error.code || spawnRes.error.message);
    status = 'blocked';
    basis = 'adapter could not be started (' + code + ')';
    return finish();
  }
  if (spawnRes.signal) {
    status = 'failed';
    basis = 'adapter was killed by ' + spawnRes.signal + (spawnRes.signal === 'SIGTERM' && spawnRes.status === null ? ' (timeout after ' + timeoutSeconds + 's)' : '');
    return finish();
  }
  if (spawnRes.status === ADAPTER_EXIT_BLOCKED) {
    status = 'blocked';
    basis = 'adapter reported it could not run (exit ' + ADAPTER_EXIT_BLOCKED + ')';
    return finish();
  }
  if (spawnRes.status !== 0) {
    status = 'failed';
    basis = 'adapter exited ' + spawnRes.status;
    return finish();
  }

  // 7. Output contract. Exit 0 with malformed output is a failure, never a
  //    completion.
  if (!fs.existsSync(outputFile)) {
    status = 'failed';
    basis = 'adapter exited 0 but wrote no output at $RCOS_OUTPUT';
    return finish();
  }
  let outputDoc;
  try {
    outputDoc = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  } catch (e) {
    outputCheck = { status: 'fail', errors: ['output.json is not valid JSON: ' + e.message] };
    status = 'failed';
    basis = 'adapter exited 0 but its output is not valid JSON: ' + e.message;
    return finish();
  }
  if (contractRes.contract && contractRes.contract.output) {
    const errs = A.validateValue(outputDoc, contractRes.contract.output, 'output');
    if (errs.length > 0) {
      outputCheck = { status: 'fail', errors: errs };
      status = 'failed';
      basis = 'adapter exited 0 but its output violates the declared output contract: ' + errs.join('; ');
      return finish();
    }
    outputCheck = { status: 'pass', errors: [] };
  } else {
    outputCheck = { status: 'not-declared', errors: [] };
  }

  status = 'completed';
  basis = 'adapter exited 0 and its output satisfied the declared contract';
  return finish();
}

// Re-hashes every artifact the manifest lists and flags files present but
// unlisted. Same discipline as eval-verify: an invocation artifact that has
// been edited is detectable.
function verifyInvocation(homeDir, id) {
  const dir = invocationDir(homeDir, id);
  if (!fs.existsSync(dir)) return { ok: false, problems: ['invocation not found: ' + id], checked: 0 };
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { ok: false, problems: ['manifest.json missing'], checked: 0 };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { ok: false, problems: ['manifest.json is not valid JSON: ' + e.message], checked: 0 };
  }
  const problems = [];
  if (!manifest.integrity || manifest.integrity.algo !== 'sha256') problems.push('manifest.integrity missing or not sha256');
  else if (manifest.integrity.value !== manifestIntegrity(manifest)) problems.push('manifest integrity mismatch — the manifest was edited after it was written');

  // The chain back to the eligibility decision is checked here, not in the
  // eligibility engine: an invocation whose authorizing decision has been
  // edited, or no longer exists, is a broken link.
  if (manifest.eligibility_decision_id) {
    const dp = path.join(E.decisionDir(homeDir, manifest.eligibility_decision_id), 'decision.json');
    if (!fs.existsSync(dp)) problems.push('eligibility decision referenced by the manifest is missing: ' + manifest.eligibility_decision_id);
    else if (sha256(fs.readFileSync(dp)) !== manifest.eligibility_sha256) problems.push('eligibility decision changed since the invocation was written: ' + manifest.eligibility_decision_id);
  } else {
    problems.push('manifest names no eligibility decision');
  }

  // The second half of the same chain, when the invocation was reached through
  // an election: the selection must still verify, must still be the same bytes,
  // and must still have chosen the capability that ran. Invocations written
  // before the selection bus existed have no selection_id and are not broken.
  if (manifest.selection_id) {
    const sp = path.join(S.selectionDir(homeDir, manifest.selection_id), 'selection.json');
    if (!fs.existsSync(sp)) {
      problems.push('selection referenced by the manifest is missing: ' + manifest.selection_id);
    } else {
      if (sha256(fs.readFileSync(sp)) !== manifest.selection_sha256) {
        problems.push('selection changed since the invocation was written: ' + manifest.selection_id);
      }
      const sv = S.verifySelection(homeDir, manifest.selection_id);
      if (!sv.ok) {
        for (const p of sv.problems) problems.push('selection ' + manifest.selection_id + ': ' + p);
      } else if (sv.selection.selected_capability_id !== manifest.capability_id) {
        problems.push('selection ' + manifest.selection_id + ' chose ' + String(sv.selection.selected_capability_id) + ' but this invocation ran ' + manifest.capability_id);
      }
    }
  }

  const listed = [];
  for (const key of ['input', 'output', 'stdout', 'stderr']) {
    if (manifest[key]) listed.push(manifest[key]);
  }
  for (const e of manifest.evidence || []) listed.push(e);
  for (const e of listed) {
    const p = path.join(dir, e.path);
    if (!fs.existsSync(p)) { problems.push('listed artifact is missing: ' + e.path); continue; }
    const buf = fs.readFileSync(p);
    if (sha256(buf) !== e.sha256) problems.push('artifact changed since the invocation was written: ' + e.path);
    if (buf.length !== e.bytes) problems.push('artifact size changed since the invocation was written: ' + e.path);
  }
  const listedPaths = new Set(listed.map((e) => e.path));
  for (const p of listFilesRecursive(dir)) {
    const rel = path.relative(dir, p).split(path.sep).join('/');
    if (rel === 'manifest.json' || rel.startsWith('work/')) continue;
    if (!listedPaths.has(rel)) problems.push('artifact present but not listed in the manifest: ' + rel);
  }

  // The emission story, for manifests sealed after the evidence envelope
  // landed. Each emitted entry must name a record that still exists, still
  // parses, still names this invocation as its producer, and still verifies
  // in full — the record half of the two-way link. verifyEvidence's producer
  // check is the same shallow predicate minting used (it reads the manifest
  // from disk and never calls back into this verifier), so checking a record
  // deeply here cannot recurse; the pin alone would miss a record edited
  // after minting, and this is where a reader looks.
  // Invocations sealed before the envelope existed carry no emission shape
  // and are not broken; an old reader that never heard of emitted_evidence
  // reads them exactly as before.
  if (manifest.emitted_evidence !== undefined || manifest.emission_skipped !== undefined) {
    const emitted = Array.isArray(manifest.emitted_evidence) ? manifest.emitted_evidence : null;
    const skippedEm = Array.isArray(manifest.emission_skipped) ? manifest.emission_skipped : null;
    if (emitted === null) problems.push('manifest.emitted_evidence is not an array');
    if (skippedEm === null) problems.push('manifest.emission_skipped is not an array');
    if (emitted !== null) {
      for (const entry of emitted) {
        const entryOk = entry && typeof entry === 'object' &&
          typeof entry.file === 'string' && typeof entry.evidence_id === 'string';
        if (!entryOk) { problems.push('emitted_evidence entry is malformed: ' + JSON.stringify(entry)); continue; }
        const rp = path.join(homeDir, 'evidence-records', entry.evidence_id, 'evidence.json');
        if (!fs.existsSync(rp)) {
          problems.push('emitted evidence record is missing: ' + entry.evidence_id + ' (from ' + entry.file + ')');
          continue;
        }
        let record;
        try { record = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch (e) {
          problems.push('emitted evidence record is not valid JSON: ' + entry.evidence_id);
          continue;
        }
        const pr = record.producer;
        if (!pr || typeof pr !== 'object' || pr.invocation_id !== id) {
          problems.push('emitted evidence ' + entry.evidence_id + ' does not name this invocation as its producer');
          continue;
        }
        const rv = EV.verifyEvidence(homeDir, entry.evidence_id);
        if (!rv.ok) {
          problems.push('emitted evidence ' + entry.evidence_id + ' does not verify: ' + rv.problems.join('; '));
        }
      }
    }
  }
  return { ok: problems.length === 0, problems, checked: listed.length, manifest };
}

function readManifest(homeDir, id) {
  const p = path.join(invocationDir(homeDir, id), 'manifest.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listInvocations(homeDir) {
  const dir = invocationsDir(homeDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isInvocationId(e.name))
    .map((e) => e.name)
    .sort()
    .map((id) => {
      const m = readManifest(homeDir, id);
      return {
        invocation_id: id,
        capability_id: m ? m.capability_id : null,
        capability_version: m ? m.capability_version : null,
        status: m ? m.status : null,
        mode: m ? m.mode : null,
        // Invocations written before the eligibility engine existed carry no
        // decision and no eligibility block; the nulls are the honest answer
        // for them rather than a gap in the listing.
        eligibility_decision_id: m && m.eligibility_decision_id ? m.eligibility_decision_id : null,
        eligibility: m && m.eligibility ? m.eligibility : null,
        // Null for direct invocation, which never had an election to record.
        selection_id: m && m.selection_id ? m.selection_id : null,
        started_at: m ? m.started_at : null,
        completed_at: m ? m.completed_at : null,
        dir: invocationDir(homeDir, id)
      };
    });
}

module.exports = {
  INVOCATION_SCHEMA,
  MODES,
  INVOCATION_STATUSES,
  DEFAULT_TIMEOUT_SECONDS,
  makeInvocationId,
  isInvocationId,
  invocationsDir,
  invocationDir,
  invokeCapability,
  verifyInvocation,
  readManifest,
  listInvocations,
  sha256
};
