'use strict';
// The selection bus: one way for RCOS to choose among capabilities that are
// already proven eligible to compete.
//
// Invariant this file exists to hold:
//   Selection may choose only among capabilities already proven eligible to
//   compete. Selection never grants execution authority.
//
// Everything else in RCOS is deterministic, and this file is the one place a
// choice gets made. That makes the shape of the hole load-bearing, so it is
// built as a socket rather than a policy: the core owns candidate integrity,
// artifact creation and result validation; a selector owns nothing but the
// choice. The socket has exactly one occupant — `explicit`, which names a
// capability and nothing else. No keywords, no similarity, no ranking, no
// model, no planner. Those are not stubs waiting to be filled in; the empty
// slots are the point, and an intelligent selector can only be added later
// against a world that already has grounded truth and explicit objectives.
//
// The protocol is deliberately three separate meanings, and none of them may
// be collapsed into another:
//   selection says WHICH   (this file)
//   eligibility says MAY   (lib/eligibility.js)
//   the kernel says CAN EXECUTE SAFELY   (lib/invocation.js)
//
// So a selection decision is never an authorization. A `scope=compete`
// eligibility decision says a capability may stand for election; the winner
// still has to come back with a fresh `scope=execute` decision before any
// adapter runs. This file reads decisions and never makes one: it does not
// call the eligibility engine, does not re-derive reasons, and does not know
// what `eligible` was computed from.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const E = require('./eligibility');

const SELECTION_SCHEMA = 'rcos-selection/1';
// The five outcomes are structurally distinct, and the difference matters:
//   selected     — a selector named exactly one candidate. The only status that
//                  may proceed toward execution.
//   abstained    — a selector ran and declined to choose (the request named
//                  nothing in the set).
//   ambiguous    — a selector ran and found more than one valid choice. It is a
//                  protocol outcome, not a failure of the run.
//   no_candidates— the core refused to convene a selector: the set was empty.
//                  No selector implementation can return this.
//   failed       — the core could not accept what the selector did (it threw,
//                  or returned a malformed or inconsistent result). No selector
//                  implementation may return this either.
// The last two can only come from the core, which is what keeps "the selector
// chose badly" and "there was nothing to choose from" from ever reading the
// same in an artifact.
const SELECTION_STATUSES = ['selected', 'abstained', 'ambiguous', 'no_candidates', 'failed'];
// What a selector implementation is allowed to return.
const SELECTOR_RESULT_STATUSES = ['selected', 'abstained', 'ambiguous'];
const SELECTION_ID_RE = /^sel_\d{8}T\d{6}Z-[0-9a-f]{6}$/;

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function makeSelectionId(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return 'sel_' + iso + '-' + crypto.randomBytes(3).toString('hex');
}

function isSelectionId(id) { return SELECTION_ID_RE.test(String(id)); }

function selectionsDir(homeDir) { return path.join(homeDir, 'selections'); }
function selectionDir(homeDir, id) { return path.join(selectionsDir(homeDir), id); }

// Self-integrity, same discipline as the eligibility decision and the
// invocation manifest: the document hashes itself, so an edited selection is
// detectable without trusting the file's own contents.
function selectionIntegrity(doc) {
  const { integrity, ...rest } = doc;
  return sha256(JSON.stringify(rest, null, 2) + '\n');
}

// The candidate set is hashed as a set, independently of the rest of the
// document, so "the set was exactly this" is checkable on its own.
function candidateSetSha256(candidates) {
  return sha256(JSON.stringify(candidates, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// The selector interface.
//
//   select({ candidates, selector_input }) -> selector_result
//
// `candidates` is the verified set: [{ capability_id, capability_version }].
// `selector_input` is whatever that selector asked for. The core never reads
// it — it stores it, hashes it and hands it over. That opacity is deliberate:
// RCOS selection-core has no vocabulary for task text, intent, domain,
// similarity or scores, so no selector can smuggle a router in through a
// shared input schema. If a future selector wants those things, they are that
// selector's own business, and its own input artifact.
//
// A result is { status, selected_capability_id, reason }. `reason` is prose
// for a human reading the artifact; it is never parsed.
// ---------------------------------------------------------------------------

// explicit@1 — the only selector that ships.
//
// It names one capability and answers one question: is that capability in the
// set? That is enough to exercise the entire protocol (candidate integrity,
// the replaceable interface, the abstain path, the fresh execute handoff)
// without any semantic matching, which is what makes it legal under the
// deterministic-router ban. There is deliberately no single-candidate
// automatic selector and no "best match" selector: both would be defensible
// and neither is needed yet, and architectural ambiguity is not free.
const explicit = {
  id: 'explicit',
  version: '1',
  // The selector's own input vocabulary, and it is closed. A field this
  // selector does not understand is refused rather than ignored, so an input
  // that looks like a routing request cannot be silently accepted as one.
  validateInput(doc) {
    const errors = [];
    if (!isPlainObject(doc)) return ['selector input must be an object'];
    for (const k of Object.keys(doc)) {
      if (k !== 'capability_id') {
        errors.push('selector input.' + k + ': unknown field — explicit@1 accepts exactly one key, capability_id');
      }
    }
    if (typeof doc.capability_id !== 'string' || doc.capability_id.length === 0) {
      errors.push('selector input.capability_id: a non-empty string is required');
    }
    return errors;
  },
  select({ candidates, selector_input }) {
    const wanted = selector_input.capability_id;
    const inSet = candidates.some((c) => c.capability_id === wanted);
    if (!inSet) {
      return {
        status: 'abstained',
        selected_capability_id: null,
        reason: 'requested \'' + wanted + '\' is not in the eligible candidate set [' +
          candidates.map((c) => c.capability_id).join(', ') + ']'
      };
    }
    return {
      status: 'selected',
      selected_capability_id: wanted,
      reason: 'requested \'' + wanted + '\' is in the eligible candidate set'
    };
  }
};

// The shipped selector registry. `selectors` is threaded through
// createSelection so a caller can supply a different registry — that is the
// seam the tests use to prove a non-shipped selector drives the identical
// protocol, and it is not a place to park fake implementations: nothing else
// is registered here, and nothing else should be until a selector is real.
const SELECTORS = { explicit };

function resolveSelector(selectors, id, version) {
  if (typeof id !== 'string' || id.length === 0) return { ok: false, error: 'a selector id is required' };
  const impl = Object.prototype.hasOwnProperty.call(selectors, id) ? selectors[id] : undefined;
  if (!impl) {
    return {
      ok: false,
      error: 'no selector \'' + id + '\' is installed — this build ships exactly one: ' +
        Object.keys(selectors).join(', ') + ' (a selector has to exist as code before it can be named in an artifact)'
    };
  }
  // A caller that names no version gets the installed one; the artifact always
  // records the concrete version that actually ran.
  if (version === undefined || version === null) return { ok: true, impl };
  if (typeof version !== 'string' || version.length === 0) {
    return { ok: false, error: 'selector version must be a non-empty string' };
  }
  if (impl.version !== version) {
    return { ok: false, error: 'selector \'' + id + '\' is version ' + impl.version + ', not \'' + version + '\'' };
  }
  return { ok: true, impl };
}

// Reads one candidate decision and reduces it to a pinned candidate entry.
// Everything a selection claims about a candidate is checked here: the
// artifact exists, it is the same bytes it was when it was written, it is
// about this capability and version, it was asked at scope=compete, and it
// said yes. Selection consumes eligibility; it never recomputes it.
function readCandidate(homeDir, decisionId) {
  if (typeof decisionId !== 'string' || !E.isDecisionId(decisionId)) {
    return { ok: false, error: 'candidate eligibility decision id is not a decision id: ' + String(decisionId) };
  }
  const decisionPath = path.join(E.decisionDir(homeDir, decisionId), 'decision.json');
  if (!fs.existsSync(decisionPath)) {
    return { ok: false, error: 'no such eligibility decision artifact: ' + decisionId };
  }
  const sha = sha256(fs.readFileSync(decisionPath));
  const verified = E.verifyDecision(homeDir, decisionId);
  if (!verified.ok) {
    return { ok: false, error: 'candidate eligibility decision ' + decisionId + ' does not verify: ' + verified.problems.join('; ') };
  }
  const doc = verified.decision;
  if (doc.scope !== 'compete') {
    return {
      ok: false,
      error: 'candidate eligibility decision ' + decisionId + ' has scope \'' + doc.scope + '\' — a candidate must be a scope=compete decision, because competing is the only question selection is allowed to ask'
    };
  }
  if (doc.eligible !== true) {
    return {
      ok: false,
      error: 'candidate eligibility decision ' + decisionId + ' does not permit competition: ' + (doc.reasons || []).join(', ')
    };
  }
  return {
    ok: true,
    candidate: {
      capability_id: doc.capability_id,
      capability_version: doc.capability_version,
      eligibility_decision_id: decisionId,
      eligibility_sha256: sha
    },
    decision: doc
  };
}

// Assembles and verifies the candidate set. Returns a refusal (no artifact)
// for anything that would make the set less than exact: an unusable decision,
// a duplicate capability, an empty list is NOT a refusal — it is a legitimate
// `no_candidates` outcome and is handled by the caller.
function buildCandidateSet(homeDir, decisionIds) {
  const candidates = [];
  const seen = new Set();
  for (const id of decisionIds) {
    const res = readCandidate(homeDir, id);
    if (!res.ok) return { ok: false, error: res.error };
    const c = res.candidate;
    if (seen.has(c.capability_id)) {
      return {
        ok: false,
        error: 'candidate set names \'' + c.capability_id + '\' more than once — a candidate set is a set, and two pinned decisions for one capability is an ambiguity the protocol will not guess its way out of'
      };
    }
    seen.add(c.capability_id);
    candidates.push(c);
  }
  return { ok: true, candidates };
}

// The core. Consumes verified scope=compete decisions, convenes one selector,
// validates what it did, and writes an immutable artifact.
//
// It refuses to write anything for a malformed request (an uninstalled
// selector, a selector input the selector itself rejects, a candidate set it
// cannot verify): a selection artifact is a record of a choice among valid
// options, and there is no honest artifact to write when the options were not
// valid. `failed` is for the case where the options were valid and the
// selector misbehaved — that IS worth recording, because it is a fact about
// the selector.
function createSelection(homeDir, opts = {}) {
  const selectors = opts.selectors || SELECTORS;
  const selectorId = opts.selectorId === undefined ? explicit.id : opts.selectorId;
  const selectorVersion = opts.selectorVersion === undefined ? null : opts.selectorVersion;
  const resolved = resolveSelector(selectors, selectorId, selectorVersion);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const impl = resolved.impl;

  const selectorInput = opts.selectorInput === undefined ? null : opts.selectorInput;
  // The selector owns its own input schema; the core only insists that the
  // selector got to judge it before anything was chosen.
  const inputErrors = typeof impl.validateInput === 'function' ? impl.validateInput(selectorInput) : [];
  if (inputErrors.length > 0) {
    return { ok: false, error: 'selector ' + impl.id + '@' + impl.version + ' rejected its input: ' + inputErrors.join('; ') };
  }

  const decisionIds = Array.isArray(opts.candidateDecisionIds) ? opts.candidateDecisionIds : [];
  const built = buildCandidateSet(homeDir, decisionIds);
  if (!built.ok) return { ok: false, error: built.error };
  const candidates = built.candidates;

  const now = opts.now || new Date();
  let status;
  let selectedCapabilityId = null;
  let statusBasis;

  if (candidates.length === 0) {
    // Nothing to convene. A selector is never asked to choose from an empty
    // set, so `no_candidates` cannot be confused with a selector's opinion.
    status = 'no_candidates';
    statusBasis = 'the candidate set is empty — no scope=compete eligible decision was supplied, so no selector was convened';
  } else {
    let result = null;
    let threw = null;
    try {
      result = impl.select({
        candidates: candidates.map((c) => ({ capability_id: c.capability_id, capability_version: c.capability_version })),
        selector_input: selectorInput
      });
    } catch (e) {
      threw = e && e.message ? e.message : String(e);
    }
    const problems = [];
    if (threw !== null) {
      problems.push('selector ' + impl.id + '@' + impl.version + ' threw: ' + threw);
    } else if (!isPlainObject(result)) {
      problems.push('selector returned ' + (result === null ? 'null' : typeof result) + ', not a result object');
    } else {
      if (!SELECTOR_RESULT_STATUSES.includes(result.status)) {
        problems.push('selector returned status \'' + result.status + '\', which is not one of ' + SELECTOR_RESULT_STATUSES.join('|') +
          ' (no_candidates and failed are the core\'s to report, not a selector\'s)');
      } else if (result.status === 'selected') {
        const named = result.selected_capability_id;
        if (typeof named !== 'string' || !candidates.some((c) => c.capability_id === named)) {
          problems.push('selector said \'selected\' but named \'' + String(named) + '\', which is not a capability in the candidate set');
        }
      } else if (result.selected_capability_id !== null && result.selected_capability_id !== undefined) {
        problems.push('selector said \'' + result.status + '\' but also named a capability — an abstention or an ambiguity selects nothing');
      }
    }
    if (problems.length > 0) {
      // Valid options, misbehaving selector. That is a fact worth an artifact.
      status = 'failed';
      statusBasis = problems.join('; ');
    } else {
      status = result.status;
      selectedCapabilityId = result.status === 'selected' ? result.selected_capability_id : null;
      statusBasis = typeof result.reason === 'string' && result.reason.length > 0
        ? result.reason
        : 'selector ' + impl.id + '@' + impl.version + ' returned ' + result.status;
    }
  }

  let id = opts.selectionId || makeSelectionId(now);
  if (opts.selectionId && !isSelectionId(id)) throw new Error('bad selection id: ' + id);
  const dir = selectionDir(homeDir, id);
  // The container may not exist yet; the id directory itself is created
  // non-recursively so EEXIST stays the write-once signal.
  fs.mkdirSync(selectionsDir(homeDir), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try { fs.mkdirSync(dir); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (opts.selectionId) throw new Error('selection ' + id + ' already exists — selections are write-once and never rewritten');
      if (attempt >= 5) throw e;
      id = makeSelectionId(now);
    }
  }

  const doc = {
    schema: SELECTION_SCHEMA,
    selection_id: id,
    selector: { id: impl.id, version: impl.version },
    // Stored verbatim and never interpreted: the core has no opinion about
    // what a selector asked for, but an artifact that does not record what was
    // asked cannot be audited, and a hash with no bytes behind it cannot be
    // checked.
    selector_input: selectorInput,
    selector_input_sha256: sha256(JSON.stringify(selectorInput, null, 2) + '\n'),
    candidates,
    candidate_set_sha256: candidateSetSha256(candidates),
    status,
    selected_capability_id: selectedCapabilityId,
    status_basis: statusBasis,
    decided_at: now.toISOString(),
    rcos_home: homeDir,
    created_at: new Date().toISOString()
  };
  doc.integrity = { algo: 'sha256', value: selectionIntegrity(doc) };
  const selectionPath = path.join(dir, 'selection.json');
  fs.writeFileSync(selectionPath, JSON.stringify(doc, null, 2) + '\n');
  return {
    ok: true,
    selection_id: id,
    selection: doc,
    dir,
    selection_path: selectionPath,
    selection_sha256: sha256(fs.readFileSync(selectionPath)),
    status: doc.status,
    selected_capability_id: doc.selected_capability_id,
    status_basis: doc.status_basis,
    candidates
  };
}

function readSelection(homeDir, id) {
  const p = path.join(selectionDir(homeDir, id), 'selection.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Deterministic and deliberately stupid, in the same sense the eligibility
// verifier is: it re-hashes the artifact, re-checks the schema, re-reads every
// candidate decision, and confirms that the capability that was selected is
// one of the candidates and that the status agrees with what was selected.
//
// It does not and cannot judge whether the choice was smart, whether the task
// semantically matched, whether another candidate would have been better, or
// whether a rationale sounds convincing. Those are selector-quality questions
// for evals, and a verifier that answered them would be a second, quieter
// selector living inside the audit path.
function verifySelection(homeDir, id) {
  const dir = selectionDir(homeDir, id);
  if (!fs.existsSync(dir)) return { ok: false, problems: ['selection not found: ' + id], checked: 0 };
  const p = path.join(dir, 'selection.json');
  if (!fs.existsSync(p)) return { ok: false, problems: ['selection.json missing'], checked: 0 };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { ok: false, problems: ['selection.json is not valid JSON: ' + e.message], checked: 0 };
  }
  const problems = [];
  if (doc.schema !== SELECTION_SCHEMA) problems.push('schema is not ' + SELECTION_SCHEMA);
  if (doc.selection_id !== id) problems.push('selection_id does not match its directory name');
  if (!doc.integrity || doc.integrity.algo !== 'sha256') problems.push('integrity missing or not sha256');
  else if (doc.integrity.value !== selectionIntegrity(doc)) problems.push('selection integrity mismatch — the selection was edited after it was written');
  if (!SELECTION_STATUSES.includes(doc.status)) problems.push('unknown status: ' + String(doc.status));
  if (!isPlainObject(doc.selector) || typeof doc.selector.id !== 'string' || doc.selector.id.length === 0) {
    problems.push('selector.id missing');
  }
  if (!isPlainObject(doc.selector) || typeof doc.selector.version !== 'string' || doc.selector.version.length === 0) {
    problems.push('selector.version missing');
  }
  if (doc.selector_input_sha256 !== sha256(JSON.stringify(doc.selector_input, null, 2) + '\n')) {
    problems.push('selector_input_sha256 does not match the recorded selector input');
  }

  const candidates = Array.isArray(doc.candidates) ? doc.candidates : null;
  if (!candidates) {
    problems.push('candidates is not an array');
  } else {
    if (doc.candidate_set_sha256 !== candidateSetSha256(candidates)) {
      problems.push('candidate_set_sha256 does not match the recorded candidate set');
    }
    const seen = new Set();
    let checked = 0;
    for (const c of candidates) {
      if (!isPlainObject(c)) { problems.push('candidate entry is not an object'); continue; }
      if (typeof c.capability_id !== 'string' || c.capability_id.length === 0) problems.push('candidate has no capability_id');
      if (seen.has(c.capability_id)) problems.push('candidate set names ' + c.capability_id + ' more than once');
      seen.add(c.capability_id);
      // The candidate is re-read, not trusted: the decision must still exist,
      // still be the same bytes, and still say yes to competing.
      const res = readCandidate(homeDir, c.eligibility_decision_id);
      if (!res.ok) { problems.push('candidate \'' + c.capability_id + '\': ' + res.error); continue; }
      checked += 1;
      if (res.candidate.eligibility_sha256 !== c.eligibility_sha256) {
        problems.push('candidate \'' + c.capability_id + '\': eligibility_sha256 does not match the decision artifact it names');
      }
      if (res.candidate.capability_id !== c.capability_id) {
        problems.push('candidate \'' + c.capability_id + '\': the decision it names is about \'' + res.candidate.capability_id + '\'');
      }
      if (res.candidate.capability_version !== c.capability_version) {
        problems.push('candidate \'' + c.capability_id + '\': decision names version ' + res.candidate.capability_version + ', selection pins ' + c.capability_version);
      }
    }
    if (candidates.length === 0 && doc.status !== 'no_candidates') {
      problems.push('candidate set is empty but status is \'' + doc.status + '\' — an empty set can only be no_candidates');
    }
    if (candidates.length > 0 && doc.status === 'no_candidates') {
      problems.push('status is no_candidates but the candidate set is not empty');
    }
    if (doc.status === 'selected') {
      if (typeof doc.selected_capability_id !== 'string' || !seen.has(doc.selected_capability_id)) {
        problems.push('status is selected but selected_capability_id \'' + String(doc.selected_capability_id) + '\' is not a candidate');
      }
    } else if (doc.selected_capability_id !== null) {
      problems.push('status is \'' + doc.status + '\' but a capability was selected — only \'selected\' names a capability');
    }
    const stray = fs.readdirSync(dir).filter((n) => n !== 'selection.json');
    for (const n of stray) problems.push('artifact present but not part of a selection: ' + n);
    return { ok: problems.length === 0, problems, checked: checked + 1, selection: doc, candidates };
  }
  return { ok: problems.length === 0, problems, checked: 1, selection: doc };
}

function listSelections(homeDir) {
  const dir = selectionsDir(homeDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isSelectionId(e.name))
    .map((e) => e.name)
    .sort()
    .map((id) => {
      const d = readSelection(homeDir, id);
      return {
        selection_id: id,
        selector: d ? d.selector : null,
        status: d ? d.status : null,
        selected_capability_id: d ? d.selected_capability_id : null,
        candidates: d && Array.isArray(d.candidates) ? d.candidates.map((c) => c.capability_id) : null,
        decided_at: d ? d.decided_at : null,
        dir: selectionDir(homeDir, id)
      };
    });
}

module.exports = {
  SELECTION_SCHEMA,
  SELECTION_STATUSES,
  SELECTOR_RESULT_STATUSES,
  SELECTORS,
  explicit,
  resolveSelector,
  makeSelectionId,
  isSelectionId,
  selectionsDir,
  selectionDir,
  selectionIntegrity,
  candidateSetSha256,
  readCandidate,
  buildCandidateSet,
  createSelection,
  verifySelection,
  readSelection,
  listSelections,
  sha256
};
