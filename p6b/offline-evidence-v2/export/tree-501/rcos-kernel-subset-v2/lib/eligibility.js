'use strict';
// The deterministic eligibility engine.
//
// Invariant this file exists to hold:
//   Eligibility decides whether a named capability is permitted to compete or
//   execute in the supplied context. It never decides which capability is best.
//
// It is a pure function of three things: the registry entry, the capability's
// runtime state (executable? evidence real? evidence good?), and the caller
// context (a tiny flag set, one of three purposes). No mutation, no adapter
// execution, no model call, no trace write, no scoring, no ranking, no task
// interpretation. Nothing in this file may read the task, the user's prompt,
// the domain, or how often a capability has been reused.
//
// The decision is its own artifact (`rcos-eligibility/1`, write-once) because
// eligibility happens *before* selection, when no invocation exists yet. The
// invocation kernel consumes a decision — it never recomputes one. That split is
// the whole point: status/evidence/permission-to-compete policy lives here,
// "can these bytes actually be executed safely?" lives in the kernel.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const R = require('./registry');
const A = require('./adapter');

const ELIGIBILITY_SCHEMA = 'rcos-eligibility/1';
const PURPOSES = ['normal', 'eval', 'forensic'];
// MAY_COMPETE and MAY_EXECUTE are two questions, one engine. Today they produce
// the same answer; the field exists so a future selector can ask the first
// question without overloading a decision that authorized an execution.
const SCOPES = ['execute', 'compete'];
const DECISION_ID_RE = /^elig_\d{8}T\d{6}Z-[0-9a-f]{6}$/;

// The vocabulary, in canonical order. The order is the rule: reasons are
// emitted in the order of the question they answer, so two runs that fail for
// the same reasons always produce the same list, and a reader can stop at the
// first line and still know the most fundamental thing that is wrong.
//
//   1. identity          unknown_capability      — is this a capability RCOS holds?
//   2. permission        retired                 — may it compete at all, by status?
//                        candidate_not_allowed
//   3. executability     unsupported_adapter     — is there a way to run it? (most specific first)
//                        missing_adapter
//                        missing_contract
//                        not_executable
//   4. evidence reality  provenance_asserted     — was the evidence produced by RCOS?
//   5. evidence quality  latest_eval_blocked     — what does the newest evidence say?
//                        latest_eval_fix
//                        no_ship_eval
//                        eval_stale
//   6. context           forensic_reason_required — is the request complete?
//
// 'eligible' is the name of the positive outcome, not a failure: an eligible
// decision carries `reasons: []` and never lists it alongside anything.
const POSITIVE_REASON = 'eligible';
const REASON_CODES = [
  POSITIVE_REASON,
  'unknown_capability',
  'retired',
  'candidate_not_allowed',
  'unsupported_adapter',
  'missing_adapter',
  'missing_contract',
  'not_executable',
  'provenance_asserted',
  'latest_eval_blocked',
  'latest_eval_fix',
  'no_ship_eval',
  'eval_stale',
  'forensic_reason_required'
];
const REASON_RANK = new Map(REASON_CODES.map((c, i) => [c, i]));

// Exactly one executability reason is emitted, chosen by specificity: the
// reason that explains the most about why there is no runnable path.
function executabilityReason(state) {
  const a = state.adapter;
  if (!a.declared) return 'not_executable';
  if (!a.type_supported) return 'unsupported_adapter';
  if (a.declaration_errors.length > 0) return 'missing_adapter';
  if (a.contract_declared && !a.contract_usable) return 'missing_contract';
  if (!a.entrypoint_present || !a.entrypoint_executable) return 'not_executable';
  return null;
}

function orderReasons(list) {
  return [...new Set(list)].sort((a, b) => REASON_RANK.get(a) - REASON_RANK.get(b));
}

// The caller context is deliberately tiny, and deliberately closed: anything
// that would make this a routing decision is refused outright rather than
// ignored. A capability is not more legitimate because it has been reused
// often, because its name matches the task, or because something ranked it.
const CONTEXT_KEYS = [
  'purpose',
  'explicit_capability_id',
  'allow_candidate',
  'allow_retired',
  'require_executed_provenance',
  'require_current_ship',
  'forensic_reason',
  'scope'
];
const FORBIDDEN_CONTEXT_KEYS = [
  'task', 'task_text', 'user_prompt', 'prompt', 'keywords', 'domain', 'intent',
  'semantic_similarity', 'similarity', 'score', 'scores', 'ranking', 'rank',
  'preferred_capability', 'runner_up', 'model_recommendation', 'cost',
  'cost_preference', 'latency', 'latency_preference', 'selection_rate',
  'history', 'reuse_count'
];

// normal   = production reuse. Promoted, executable, executed evidence, current ship.
// eval     = the runner establishing quality. That is the entire point of eval,
//            so it does not require the quality it is about to measure.
// forensic = an explicit, recorded override: candidates and retired entries are
//            permitted, but a reason is required and it lands in the artifact.
function buildContext(purpose, opts = {}) {
  const base = {
    purpose,
    explicit_capability_id: opts.capabilityId === undefined ? null : opts.capabilityId,
    scope: opts.scope === undefined ? 'execute' : opts.scope,
    forensic_reason: opts.forensicReason === undefined ? null : opts.forensicReason
  };
  if (purpose === 'normal') {
    return Object.assign(base, {
      allow_candidate: false, allow_retired: false,
      require_executed_provenance: true, require_current_ship: true
    });
  }
  if (purpose === 'eval') {
    return Object.assign(base, {
      allow_candidate: true, allow_retired: false,
      require_executed_provenance: false, require_current_ship: false
    });
  }
  if (purpose === 'forensic') {
    return Object.assign(base, {
      allow_candidate: true, allow_retired: true,
      require_executed_provenance: false, require_current_ship: false
    });
  }
  return base;
}

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function validateContext(context) {
  const errors = [];
  if (!isPlainObject(context)) return ['caller context must be an object'];
  for (const k of Object.keys(context)) {
    if (FORBIDDEN_CONTEXT_KEYS.includes(k)) {
      errors.push('caller context.' + k + ': forbidden — eligibility may not see task text, semantic intent, scores, rankings or reuse history');
    } else if (!CONTEXT_KEYS.includes(k)) {
      errors.push('caller context.' + k + ': unknown field (the caller context vocabulary is closed)');
    }
  }
  if (!PURPOSES.includes(context.purpose)) errors.push('caller context.purpose: must be one of ' + PURPOSES.join('|'));
  if (!SCOPES.includes(context.scope)) errors.push('caller context.scope: must be one of ' + SCOPES.join('|'));
  if (typeof context.explicit_capability_id !== 'string' || context.explicit_capability_id.length === 0) {
    errors.push('caller context.explicit_capability_id: a non-empty string is required — eligibility is always asked about a named capability');
  }
  for (const k of ['allow_candidate', 'allow_retired', 'require_executed_provenance', 'require_current_ship']) {
    if (typeof context[k] !== 'boolean') errors.push('caller context.' + k + ': must be a boolean');
  }
  if (context.forensic_reason !== null && typeof context.forensic_reason !== 'string') {
    errors.push('caller context.forensic_reason: must be a string or null');
  }
  return errors;
}

// Reads what is true about this capability right now. Read-only: it stats files
// and reads the registry, and it never runs anything.
function deriveRuntimeState(homeDir, cap) {
  const decl = cap.adapter;
  const declared = decl !== undefined;
  const declarationErrors = declared ? A.validateAdapterDeclaration(decl) : [];
  // `usable` gates every adapter-derived field: an undeclared adapter and a
  // malformed one both mean there is nothing here to resolve.
  const usable = declared && declarationErrors.length === 0;
  const typeSupported = declared && isPlainObject(decl) && typeof decl.type === 'string' && A.ADAPTER_TYPES.includes(decl.type);
  const contractRes = usable ? A.loadContract(homeDir, decl) : { ok: false, contract: null, errors: [], path: null };
  let entrypointPresent = false;
  let entrypointExecutable = false;
  if (usable) {
    const entrypoint = A.resolveEntrypoint(homeDir, decl);
    entrypointPresent = fs.existsSync(entrypoint) && fs.statSync(entrypoint).isFile();
    if (entrypointPresent) {
      try { fs.accessSync(entrypoint, fs.constants.X_OK); entrypointExecutable = true; } catch (e) { entrypointExecutable = false; }
    }
  }
  const evals = Array.isArray(cap.evals) ? cap.evals : [];
  // Only evidence RCOS itself produced counts as runtime evidence. An asserted
  // eval is a record of a past judgment; it is not a runner-backed fact, and
  // this engine is the place where that distinction has to bite.
  const executed = evals.filter((e) => e && e.provenance === 'executed');
  const latest = executed.length > 0 ? executed[executed.length - 1] : null;
  const state = {
    status: cap.status,
    executable: false, // set below, from the same predicate the decision uses
    adapter: {
      declared,
      type: declared && isPlainObject(decl) ? (decl.type === undefined ? null : decl.type) : null,
      type_supported: typeSupported,
      declaration_errors: declarationErrors,
      entrypoint: usable ? decl.entrypoint : null,
      entrypoint_present: entrypointPresent,
      entrypoint_executable: entrypointExecutable,
      contract_declared: usable && decl.contract !== undefined,
      contract_usable: usable && (decl.contract === undefined || contractRes.ok),
      contract_errors: contractRes.errors
    },
    provenance: executed.length > 0 ? 'executed' : 'asserted',
    latest_eval_verdict: latest ? (latest.verdict === undefined ? null : latest.verdict) : null,
    // The registry records one timestamp per capability, not per eval, so this
    // is reported only when there is executed evidence for it to date.
    latest_eval_at: latest ? (cap.last_eval === undefined ? null : cap.last_eval) : null,
    // Step 4 does not invent a freshness duration. Until a capability/eval
    // policy supplies one, freshness is unknown and `eval_stale` cannot fire
    // from derived state — only from a state that states it explicitly.
    eval_fresh: 'unknown',
    evals_total: evals.length,
    evals_executed: executed.length
  };
  state.executable = executabilityReason(state) === null;
  return state;
}

// The pure core. `entry` may be null (the capability is not in the registry);
// `state` is what deriveRuntimeState returned.
function decide(entry, state, context) {
  const ctx = context;
  const reasons = [];
  if (!entry) {
    return {
      eligible: false,
      reasons: ['unknown_capability'],
      scope: ctx.scope,
      capability_id: ctx.explicit_capability_id,
      capability_version: null,
      caller_context: ctx,
      observed_state: null
    };
  }
  // 2. Permission by status. These are flags, not a ladder: eligibility is not
  //    "status == promoted", and normal reuse is not the only legitimate ask.
  if (entry.status === 'retired' && ctx.allow_retired !== true) reasons.push('retired');
  if (entry.status === 'candidate' && ctx.allow_candidate !== true) reasons.push('candidate_not_allowed');
  // 3. Executability: is there a declared, runnable way to invoke this at all?
  const ex = executabilityReason(state);
  if (ex) reasons.push(ex);
  // 4. Evidence reality.
  if (ctx.require_executed_provenance === true && state.provenance !== 'executed') reasons.push('provenance_asserted');
  // 5. Evidence quality — at most one reason, the newest verdict wins.
  if (ctx.require_current_ship === true) {
    const v = state.latest_eval_verdict;
    if (v === 'blocked') reasons.push('latest_eval_blocked');
    else if (v === 'fix') reasons.push('latest_eval_fix');
    else if (v !== 'ship') reasons.push('no_ship_eval');
    else if (state.eval_fresh === false) reasons.push('eval_stale');
  }
  // 6. Context completeness.
  if (ctx.purpose === 'forensic' &&
      !(typeof ctx.forensic_reason === 'string' && ctx.forensic_reason.trim().length > 0)) {
    reasons.push('forensic_reason_required');
  }
  const ordered = orderReasons(reasons);
  return {
    eligible: ordered.length === 0,
    reasons: ordered,
    scope: ctx.scope,
    capability_id: entry.id,
    capability_version: entry.version === undefined ? null : entry.version,
    caller_context: ctx,
    observed_state: state
  };
}

// Read-only evaluation: derive state, decide, write nothing. This is what the
// audit uses, because an audit must never mutate what it audits.
function evaluate(homeDir, capabilityId, context) {
  const errors = validateContext(context);
  if (errors.length > 0) return { ok: false, error: 'invalid caller context: ' + errors.join('; '), errors };
  const reg = R.loadRegistry(homeDir);
  const cap = reg.capabilities.find((c) => c.id === capabilityId) || null;
  const state = cap ? deriveRuntimeState(homeDir, cap) : null;
  return { ok: true, entry: cap, state, decision: decide(cap, state, context) };
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function makeDecisionId(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return 'elig_' + iso + '-' + crypto.randomBytes(3).toString('hex');
}

function isDecisionId(id) { return DECISION_ID_RE.test(String(id)); }

function eligibilityDir(homeDir) { return path.join(homeDir, 'eligibility'); }
function decisionDir(homeDir, id) { return path.join(eligibilityDir(homeDir), id); }

// Self-integrity, same discipline as the invocation manifest: the document
// hashes itself so a hand-edited decision is detectable without trusting the
// file's own contents.
function decisionIntegrity(doc) {
  const { integrity, ...rest } = doc;
  return sha256(JSON.stringify(rest, null, 2) + '\n');
}

// Decide and persist. The decision is write-once: an existing decision id is
// refused, never rewritten, so the artifact an invocation names can never
// change meaning after the fact.
function decideForHome(homeDir, capabilityId, opts = {}) {
  const context = opts.context || buildContext(opts.purpose || 'normal', Object.assign({ capabilityId }, opts));
  const res = evaluate(homeDir, capabilityId, context);
  if (!res.ok) return res;
  if (!res.entry) {
    // No artifact for a ghost: a decision is an attributable statement about a
    // capability RCOS holds, and there is nothing to attribute this one to.
    return { ok: false, error: 'no such capability \'' + capabilityId + '\' in the registry', decision: res.decision };
  }
  const now = opts.now || new Date();
  let id = opts.decisionId || makeDecisionId(now);
  if (opts.decisionId && !isDecisionId(id)) throw new Error('bad decision id: ' + id);
  const dir = decisionDir(homeDir, id);
  // The container may not exist yet; the id directory itself is created
  // non-recursively so EEXIST stays the write-once signal.
  fs.mkdirSync(eligibilityDir(homeDir), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try { fs.mkdirSync(dir); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (opts.decisionId) throw new Error('eligibility decision ' + id + ' already exists — decisions are write-once and never rewritten');
      if (attempt >= 5) throw e;
      id = makeDecisionId(now);
    }
  }
  const doc = {
    schema: ELIGIBILITY_SCHEMA,
    decision_id: id,
    scope: res.decision.scope,
    capability_id: res.decision.capability_id,
    capability_version: res.decision.capability_version,
    caller_context: res.decision.caller_context,
    observed_state: res.decision.observed_state,
    eligible: res.decision.eligible,
    reasons: res.decision.reasons,
    decided_at: now.toISOString(),
    rcos_home: homeDir,
    created_at: new Date().toISOString()
  };
  doc.integrity = { algo: 'sha256', value: decisionIntegrity(doc) };
  const decisionPath = path.join(dir, 'decision.json');
  fs.writeFileSync(decisionPath, JSON.stringify(doc, null, 2) + '\n');
  return {
    ok: true,
    decision_id: id,
    decision: doc,
    dir,
    decision_path: decisionPath,
    decision_sha256: sha256(fs.readFileSync(decisionPath)),
    eligible: doc.eligible,
    reasons: doc.reasons
  };
}

function readDecision(homeDir, id) {
  const p = path.join(decisionDir(homeDir, id), 'decision.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Re-hashes the decision, re-checks its shape and its vocabulary, and confirms
// the capability it names still resolves to the version it decided about.
function verifyDecision(homeDir, id) {
  const dir = decisionDir(homeDir, id);
  if (!fs.existsSync(dir)) return { ok: false, problems: ['eligibility decision not found: ' + id], checked: 0 };
  const p = path.join(dir, 'decision.json');
  if (!fs.existsSync(p)) return { ok: false, problems: ['decision.json missing'], checked: 0 };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { ok: false, problems: ['decision.json is not valid JSON: ' + e.message], checked: 0 };
  }
  const problems = [];
  if (doc.schema !== ELIGIBILITY_SCHEMA) problems.push('schema is not ' + ELIGIBILITY_SCHEMA);
  if (doc.decision_id !== id) problems.push('decision_id does not match its directory name');
  if (!doc.integrity || doc.integrity.algo !== 'sha256') problems.push('integrity missing or not sha256');
  else if (doc.integrity.value !== decisionIntegrity(doc)) problems.push('decision integrity mismatch — the decision was edited after it was written');
  for (const r of doc.reasons || []) {
    if (!REASON_RANK.has(r) || r === POSITIVE_REASON) problems.push('unknown reason code: ' + r);
  }
  if (JSON.stringify(doc.reasons || []) !== JSON.stringify(orderReasons(doc.reasons || []))) {
    problems.push('reasons are not in canonical order');
  }
  if (doc.eligible === true && (doc.reasons || []).length > 0) problems.push('eligible decision carries reasons');
  if (doc.eligible === false && (doc.reasons || []).length === 0) problems.push('ineligible decision carries no reason');
  const ctxErrors = validateContext(doc.caller_context);
  for (const e of ctxErrors) problems.push('recorded caller context is invalid: ' + e);
  const reg = R.loadRegistry(homeDir);
  const cap = reg.capabilities.find((c) => c.id === doc.capability_id) || null;
  if (!cap) problems.push('decision references unknown capability: ' + doc.capability_id);
  else if (cap.version !== doc.capability_version) {
    problems.push('decision references ' + doc.capability_id + ' ' + doc.capability_version + ' but the registry holds ' + cap.version);
  }
  const stray = fs.readdirSync(dir).filter((n) => n !== 'decision.json');
  for (const n of stray) problems.push('artifact present but not part of a decision: ' + n);
  return { ok: problems.length === 0, problems, checked: 1, decision: doc };
}

function listDecisions(homeDir) {
  const dir = eligibilityDir(homeDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isDecisionId(e.name))
    .map((e) => e.name)
    .sort()
    .map((id) => {
      const d = readDecision(homeDir, id);
      return {
        decision_id: id,
        capability_id: d ? d.capability_id : null,
        capability_version: d ? d.capability_version : null,
        scope: d ? d.scope : null,
        purpose: d && d.caller_context ? d.caller_context.purpose : null,
        eligible: d ? d.eligible : null,
        reasons: d ? d.reasons : null,
        decided_at: d ? d.decided_at : null,
        dir: decisionDir(homeDir, id)
      };
    });
}

module.exports = {
  ELIGIBILITY_SCHEMA,
  PURPOSES,
  SCOPES,
  POSITIVE_REASON,
  REASON_CODES,
  REASON_RANK,
  CONTEXT_KEYS,
  FORBIDDEN_CONTEXT_KEYS,
  orderReasons,
  executabilityReason,
  buildContext,
  validateContext,
  deriveRuntimeState,
  decide,
  evaluate,
  decideForHome,
  verifyDecision,
  readDecision,
  listDecisions,
  makeDecisionId,
  isDecisionId,
  eligibilityDir,
  decisionDir,
  decisionIntegrity,
  sha256
};
