/**
 * The seat-dispatch receipt: the exact contract a dispatched seat returns.
 *
 * Pure module. It imports nothing from the harness so the schema, the
 * validators, and the envelope renderer stay unit-testable outside a running
 * runtime -- a schema that cannot be exercised is a schema nobody has checked.
 *
 * Two artifacts live here and they are deliberately different things:
 *   RECEIPT_PARAMETERS   the model-facing argument schema of
 *                        'submit_dispatch_receipt', as an implicit-root
 *                        parameter map (per-property 'required: true').
 *   The canonical receipt the dispatcher records for an ACCEPTED submission.
 *                        The dispatcher adds run identity to what the seat
 *                        submitted; it never lets the seat author that
 *                        identity, and it never trusts a claim the transcript
 *                        can contradict (see lane observation in index.js).
 *
 * @module dsh-seat-dispatch/receipt
 */

/** Verdicts a seat may return, in the order of decreasing good news. */
export const RECEIPT_VERDICTS = ['ship', 'fix', 'blocked', 'pending'];

/** Archon's machine-readable run statuses; 'none' means no Archon run happened. */
export const RECEIPT_ARCHON_STATUSES = ['ship', 'fix', 'blocked', 'running', 'queued', 'pending', 'none'];
const ACTIVE_ARCHON_STATUSES = ['running', 'queued', 'pending'];

/** The literal a seat uses where a value genuinely does not exist. */
export const NONE = 'none';

/** The receipt tool's name: registered per dispatched agent, never globally. */
export const RECEIPT_TOOL_NAME = 'submit_dispatch_receipt';

/** Hard bounds, so one hostile or sloppy seat cannot flood the audit log. */
export const RECEIPT_BOUNDS = Object.freeze({
  summaryMax: 4000,
  itemsMax: 64,
  itemMax: 2000,
});

/**
 * The argument schema for 'submit_dispatch_receipt'.
 *
 * The implicit parameter root is an open object root by construction, so the
 * root's closure is enforced by validateReceipt instead -- an unknown key is a
 * rejected receipt, not a silently ignored one.
 */
export const RECEIPT_PARAMETERS = {
  verdict: {
    type: 'string',
    enum: RECEIPT_VERDICTS,
    required: true,
    description: "your own verdict: 'ship' when proven, 'fix' for a defect, 'blocked' when unable to proceed, 'pending' when a real Archon run is still active",
  },
  summary: {
    type: 'string',
    required: true,
    description: 'what you actually did, in at most a few sentences -- the claim the evidence below must support',
  },
  artifacts: {
    type: 'array',
    items: { type: 'string' },
    required: true,
    description: 'absolute paths of the artifacts you produced or changed; [] when you produced none',
  },
  evidence: {
    type: 'array',
    items: { type: 'string' },
    required: true,
    description: 'the exact commands, run ids, or file reads that prove the summary -- one real observation each; required non-empty for verdict "ship" or "pending"',
  },
  blockers: {
    type: 'array',
    items: { type: 'string' },
    required: true,
    description: 'the defects or conditions requiring action, one concrete condition each; name failed checks for verdict "fix"; required non-empty for verdict "blocked"; [] for "ship" or "pending"',
  },
  archon_run_id: {
    type: 'string',
    required: true,
    description: "the real Archon run id you executed, or the literal 'none' when you ran no Archon workflow -- never invent an id",
  },
  archon_status: {
    type: 'string',
    enum: RECEIPT_ARCHON_STATUSES,
    required: true,
    description: "the latest successful canonical run tool's effective_decision for a terminal run, or status for an active run; never substitute the raw wrapper EVAL; 'none' when archon_run_id is 'none'",
  },
  archon_artifact_dir: {
    type: 'string',
    required: true,
    description: "the absolute artifact directory of that run, or the literal 'none'",
  },
  lane: {
    type: 'string',
    required: true,
    description: "the provider/model you actually ran on, exactly as your own model identity reports it; do not guess and do not copy the caller's lane",
  },
  next: {
    type: 'string',
    required: true,
    description: "the single next action a human or the next seat should take, or the literal 'none'",
  },
};

/** Declared keys of a receipt, in envelope order. */
export const RECEIPT_KEYS = Object.freeze(Object.keys(RECEIPT_PARAMETERS));

/** Keys whose absence is a refusal rather than a warning. */
const REQUIRED_KEYS = Object.freeze([...RECEIPT_KEYS]);

/**
 * Output projection of the receipt inside the dispatch tool's canonical value.
 *
 * Every property is declared but none is required: the dispatcher emits an
 * empty object when no receipt was accepted, and the closed root still refuses
 * an undeclared field. Nullability is expressed by the enclosing ok/stage pair
 * rather than by a union branch.
 */
export const RECEIPT_OUTPUT_PROPERTIES = Object.freeze({
  verdict: { type: 'string', enum: RECEIPT_VERDICTS },
  summary: { type: 'string' },
  artifacts: { type: 'array', items: { type: 'string' } },
  evidence: { type: 'array', items: { type: 'string' } },
  blockers: { type: 'array', items: { type: 'string' } },
  archon_run_id: { type: 'string' },
  archon_status: { type: 'string', enum: RECEIPT_ARCHON_STATUSES },
  archon_artifact_dir: { type: 'string' },
  lane: { type: 'string' },
  next: { type: 'string' },
});

/** Whether one value is a usable non-empty string. */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Normalize one string list, or record a violation and yield no items. */
function checkStringList(value, key, violations) {
  if (!Array.isArray(value)) {
    violations.push(key + ': must be an array of strings');
    return [];
  }
  if (value.length > RECEIPT_BOUNDS.itemsMax) {
    violations.push(key + ': at most ' + RECEIPT_BOUNDS.itemsMax + ' items');
    return [];
  }
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isNonEmptyString(item)) {
      violations.push(key + '[' + index + ']: must be a non-empty string');
      continue;
    }
    if (item.length > RECEIPT_BOUNDS.itemMax) {
      violations.push(key + '[' + index + ']: longer than ' + RECEIPT_BOUNDS.itemMax + ' characters');
      continue;
    }
    out.push(item.trim());
  }
  return out;
}

/**
 * Validate one candidate receipt against the closed contract.
 *
 * Root closure, value bounds, and the cross-field rules that make a verdict
 * mean something are all enforced here, in one place, so the tool schema and
 * the dispatcher cannot disagree about what a receipt is.
 * @param args - the argument object, however malformed.
 * @returns path-qualified violations; empty means valid.
 */
export function validateReceipt(args) {
  const violations = [];
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['receipt: must be an object'];
  }
  for (const key of Object.keys(args)) {
    if (!RECEIPT_KEYS.includes(key)) violations.push(key + ': unknown receipt field (the receipt is closed)');
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in args)) violations.push(key + ': required');
  }

  const verdict = args.verdict;
  if (!RECEIPT_VERDICTS.includes(verdict)) {
    violations.push('verdict: must be one of ' + RECEIPT_VERDICTS.join(' | '));
  }
  if (!isNonEmptyString(args.summary)) violations.push('summary: must be a non-empty string');
  else if (args.summary.length > RECEIPT_BOUNDS.summaryMax) {
    violations.push('summary: longer than ' + RECEIPT_BOUNDS.summaryMax + ' characters');
  }

  const evidence = checkStringList(args.evidence, 'evidence', violations);
  const blockers = checkStringList(args.blockers, 'blockers', violations);
  checkStringList(args.artifacts, 'artifacts', violations);

  if (!isNonEmptyString(args.archon_run_id)) violations.push('archon_run_id: must be a non-empty string (use "none")');
  if (!RECEIPT_ARCHON_STATUSES.includes(args.archon_status)) {
    violations.push('archon_status: must be one of ' + RECEIPT_ARCHON_STATUSES.join(' | '));
  }
  if (!isNonEmptyString(args.archon_artifact_dir)) violations.push('archon_artifact_dir: must be a non-empty string (use "none")');
  if (!isNonEmptyString(args.lane)) violations.push('lane: must be a non-empty string (provider/model)');
  if (!isNonEmptyString(args.next)) violations.push('next: must be a non-empty string (use "none")');

  /* Cross-field: a verdict is a claim, and a claim with no support is a defect.
   * These are refusals, not warnings, because each names a shape the
   * dispatcher could not honestly report upward. */
  if (verdict === 'blocked' && blockers.length === 0) {
    violations.push('blockers: verdict "blocked" requires at least one concrete blocker');
  }
  if (verdict === 'ship' && blockers.length > 0) {
    violations.push('blockers: verdict "ship" cannot carry blockers -- use "fix" or "blocked"');
  }
  if (verdict === 'ship' && evidence.length === 0) {
    violations.push('evidence: verdict "ship" requires at least one real observation');
  }
  const hasRun = isNonEmptyString(args.archon_run_id) && args.archon_run_id !== NONE;
  if (verdict === 'pending') {
    if (!hasRun) violations.push('verdict "pending" requires a real Archon run id');
    if (!ACTIVE_ARCHON_STATUSES.includes(args.archon_status)) violations.push('verdict "pending" requires active Archon status');
    if (blockers.length > 0) violations.push('blockers: verdict "pending" cannot carry blockers');
    if (evidence.length === 0) violations.push('evidence: verdict "pending" requires at least one real observation');
    if (!isNonEmptyString(args.next) || args.next === NONE) violations.push('next: verdict "pending" requires a next action');
  }
  if (verdict !== 'pending' && ACTIVE_ARCHON_STATUSES.includes(args.archon_status)) {
    violations.push('verdict "' + verdict + '" contradicts Archon status "' + args.archon_status + '"');
  }
  if (verdict === 'ship' && !hasRun) {
    violations.push('verdict "ship" requires a real Archon run id');
  }
  if (verdict === 'ship' && hasRun && args.archon_status !== 'ship') {
    violations.push('verdict "ship" contradicts Archon status "' + args.archon_status + '"');
  }
  if (hasRun && args.archon_status === NONE) {
    violations.push('archon_status: a run id was supplied, so its status cannot be "none"');
  }
  if (!hasRun && args.archon_status !== NONE) {
    violations.push('archon_status: must be "none" when archon_run_id is "none"');
  }

  return violations;
}

/**
 * Canonicalize one validated receipt.
 *
 * Trims, orders, and freezes the fields so the audit line and the model-facing
 * projection can never disagree, and so a caller cannot mutate what was
 * recorded.
 * @param args - a receipt that already passed validateReceipt.
 * @returns the canonical receipt.
 */
export function normalizeReceipt(args) {
  const listed = (value) => Object.freeze((value ?? []).map((item) => String(item).trim()));
  return Object.freeze({
    verdict: args.verdict,
    summary: String(args.summary).trim(),
    artifacts: listed(args.artifacts),
    evidence: listed(args.evidence),
    blockers: listed(args.blockers),
    archon_run_id: String(args.archon_run_id).trim(),
    archon_status: args.archon_status,
    archon_artifact_dir: String(args.archon_artifact_dir).trim(),
    lane: String(args.lane).trim(),
    next: String(args.next).trim(),
  });
}

/**
 * The visible consequences of an accepted receipt.
 *
 * A receipt is accepted for what it is -- a claim by the seat -- but a claim
 * the dispatcher can see is unsupported is reported as a warning beside the
 * verdict, never quietly dropped.
 * @param receipt - a canonical receipt.
 * @returns warning strings, possibly empty.
 */
export function receiptWarnings(receipt) {
  const warnings = [];
  if (receipt.archon_run_id === NONE) {
    warnings.push('no Archon run id: this seat reported no Archon workflow run, so no workflow lifecycle was observed');
  }
  if (receipt.archon_artifact_dir === NONE) {
    warnings.push('no Archon artifact dir: the run has no inspectable artifact path');
  }
  if (/\bv?4[-_]flash\b/i.test(receipt.lane)) {
    warnings.push('lane names a V4-Flash-shaped model id ("' + receipt.lane + '"); the standing directive is DeepSeek V4.1 only');
  }
  if (receipt.verdict === 'fix' && receipt.blockers.length === 0) {
    warnings.push('verdict "fix" with no blocker: the defect is not named');
  }
  return warnings;
}

/** Reduce a lane string to a comparable token. */
export function normalizeLane(lane) {
  return String(lane === undefined || lane === null ? '' : lane).trim().toLowerCase().replace(/^provider:/, '');
}

/**
 * Whether a seat's declared lane contradicts the lane observed in its log.
 *
 * Comparison is deliberately forgiving about the provider prefix and the
 * separator spelling, and deliberately strict about the model id: a confound
 * that changes the model must never be invisible.
 * @param declared - the seat's own 'lane' field.
 * @param observed - 'provider/model' read from the seat's transcript, or null.
 * @returns true when both are known and the model halves differ.
 */
export function lanesConflict(declared, observed) {
  if (!isNonEmptyString(declared) || !isNonEmptyString(observed)) return false;
  const split = (value) => normalizeLane(value).split('/').filter((part) => part.length > 0);
  const declaredParts = split(declared);
  const observedParts = split(observed);
  const declaredModel = declaredParts[declaredParts.length - 1];
  const observedModel = observedParts[observedParts.length - 1];
  if (declaredModel === undefined || observedModel === undefined) return false;
  return declaredModel !== observedModel;
}

/**
 * Compare a caller's requested lane with the observed lane. Callers may append
 * a human note (for example, a reasoning level), so only a lane-shaped prefix
 * is compared. Unstructured prose is not evidence of a lane mismatch.
 */
export function laneExpectationConflicts(expected, observed) {
  if (!isNonEmptyString(expected) || !isNonEmptyString(observed)) return false;
  const lane = normalizeLane(expected).match(/^((?:provider:)?[a-z0-9][a-z0-9._:+@-]*(?:\s*\/\s*[a-z0-9][a-z0-9._:+@-]*)*)(?=\s*(?:$|\(|\[|—|–|;|,))/);
  if (lane === null) return false;
  return lanesConflict(lane[1].replace(/\s*\/\s*/g, '/'), observed);
}

/** One model-facing line describing an accepted receipt. */
export function renderReceiptText(receipt) {
  const parts = [
    'verdict ' + receipt.verdict,
    'archon ' + receipt.archon_status + ' (' + receipt.archon_run_id + ')',
    'lane ' + receipt.lane,
  ];
  return receipt.summary + ' [' + parts.join(' | ') + ']';
}

/** Mint one run identity: sortable, opaque, and unique enough for an audit log. */
export function mintRunId(now = new Date(), salt = Math.random()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const tail = Math.floor(salt * 0xffffff).toString(16).padStart(6, '0');
  return 'sd-' + stamp + '-' + tail;
}

/** Render one bullet list, or a placeholder when it is empty. */
function bullets(items, prefix = '- ') {
  if (items.length === 0) return '(none)';
  return items.map((item) => prefix + item).join('\n');
}

/**
 * Render the task envelope handed to the dispatched seat as its single turn.
 *
 * The envelope is the whole contract between the two seats: it carries the
 * objective, the binding reporting rules, and the direct receipt tool contract.
 * @param input - run identity, the seat, the caller, and the task fields.
 * @returns the envelope text.
 */
export function renderEnvelope(input) {
  const lines = [];
  lines.push('# Seat dispatch ' + input.runId);
  lines.push('');
  lines.push('You are running as the "' + input.seat + '" seat, composed fresh from its own preset by the harness seat-dispatch plugin. Your preset owns your tools, your system prompt, and your capabilities; the caller below owns none of them and receives none of them back.');
  lines.push('');
  lines.push('- caller session: ' + input.callerSessionId + ' (preset "' + input.callerPreset + '")');
  lines.push('- route decision: ' + input.routeDecisionId + ' (intent procedural_handoff)');
  lines.push('- seat session: ' + input.seatSessionId + ' (preset "' + input.seat + '")');
  lines.push('- delegation depth: ' + String(input.delegationDepth));
  if (input.seatConfiguredLane !== undefined) {
    lines.push('- seat configured lane: ' + input.seatConfiguredLane + ' (seat AgentOptions before the request; transcript observation remains authoritative)');
  }
  if (input.laneExpectation !== undefined) {
    lines.push('- caller lane expectation: ' + input.laneExpectation + ' (a report field only; nothing is re-pointed by it)');
  }
  lines.push('');
  lines.push('## Objective');
  lines.push(input.objective);
  lines.push('');
  lines.push('## Done when');
  lines.push(input.doneWhen);
  lines.push('');
  lines.push('## Why this was dispatched');
  lines.push(input.reason);
  if (input.constraints.length > 0) {
    lines.push('');
    lines.push('## Constraints (binding)');
    lines.push(bullets(input.constraints));
  }
  if (input.context !== undefined) {
    lines.push('');
    lines.push('## Context supplied by the caller');
    lines.push(input.context);
  }
  lines.push('');
  lines.push('## Reporting contract (binding: exactly one receipt)');
  lines.push('');
  lines.push('The Archon workflow library owns the workflow lifecycle; the dispatcher owns only this seat lifecycle. It records no success of its own: your receipt is the authoritative completion boundary, and your session is closed once it arrives.');
  lines.push('');
  lines.push('Submit exactly one receipt when the objective is met, or the moment you conclude it cannot proceed. Call the native ' + RECEIPT_TOOL_NAME + ' tool directly with the fields below, then return.');
  lines.push('');
  lines.push('~~~text');
  lines.push('{');
  lines.push("  verdict: 'ship' | 'fix' | 'blocked' | 'pending',");
  lines.push("  summary: 'what you actually did',");
  lines.push("  artifacts: ['/abs/path'],                  // [] when you produced none");
  lines.push("  evidence: ['exact command or read that proves it'],");
  lines.push("  blockers: ['the defect or condition requiring action'], // name defects for 'fix'; required for 'blocked'; [] for 'ship' or 'pending'");
  lines.push("  archon_run_id: '<real Archon run id>' | 'none',");
  lines.push("  archon_status: 'ship' | 'fix' | 'blocked' | 'running' | 'queued' | 'pending' | 'none', // canonical effective_decision for terminal runs, status for active runs");
  lines.push("  archon_artifact_dir: '/abs/artifact/dir' | 'none',");
  lines.push("  lane: '<provider>/<model you actually ran on>',");
  lines.push("  next: '<one next action>' | 'none',");
  lines.push('}');
  lines.push('~~~');
  lines.push('');
  lines.push('Rules the dispatcher enforces:');
  lines.push('- The receipt is closed. An unknown field, a missing field, or a verdict whose support is missing (a "ship" with no real Archon run or evidence, a "blocked" with no blocker) is refused, and a refusal is reported to the caller as a blocked dispatch, never as a success.');
  lines.push('- archon_run_id must be the real id of the run you executed or successfully read on a follow-up. Preserve that run id and its artifact directory for every verdict, including blocked. Never invent or omit it: the host refuses a receipt that discards a run identity captured from your canonical tools. Report none only when no run was launched or successfully read, and say why in evidence.');
  lines.push('- archon_status must match the latest successful canonical run tool result. For a terminal run use effective_decision, never the raw wrapper EVAL: a capability FIX or BLOCKED cannot become SHIP. Read archon_run_status before claiming terminal completion; launch acceptance alone proves no terminal verdict. Unavailable terminal acceptance is blocked. The host refuses contradictory receipts without consuming your receipt slot.');
  lines.push('- A run still reported as running after bounded polling is pending. Report its exact run id, the observed running status, evidence, and a concrete next poll action. Do not call an unfinished run blocked or ship.');
  lines.push('- lane must use the exact provider and model IDs you actually ran on. The seat configured lane above supplies the full request-seed IDs; use them when they match your actual route, without shortening them to a display name. If the runtime changed that route, report the actual IDs. The caller expectation is separate. The dispatcher independently reads your transcript and surfaces any mismatch; configured guidance cannot override the observed lane.');
  lines.push('- One receipt per dispatch. A second submission is refused.');
  lines.push('');
  lines.push('Nothing you write after the receipt is read. Work the objective now.');
  return lines.join('\n');
}
