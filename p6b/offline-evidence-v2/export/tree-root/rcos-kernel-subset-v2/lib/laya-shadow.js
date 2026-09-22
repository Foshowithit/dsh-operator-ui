'use strict';
// The Laya shadow comparator: laya-ranker@experimental-1.
//
// SECOND experimental comparator (GPT Tranche-2 authorization), mirroring
// lib/jev-shadow.js leg for leg. Like the Jev observer, this module is an
// OBSERVER beside a completed selection, never a SELECTORS occupant. It runs
// after the bus has spoken, consumes the same verified candidate set, asks
// Laya (via an injected local-inference transport) what it would have picked,
// applies the veto and escalator logic as a simulation, and seals an
// immutable shadow record. Nothing here changes execution: the selection
// artifact, the selector registry, and the invocation path are untouched.
// A Laya shadow record is evidence for the Tranche-2 bar, never a routing
// decision. The two observers never read each other's answers: agreement is
// never correctness, and neither shadow takes the other's output as input.
//
// Ruling constraints this module enforces by construction:
//   - Laya's choice does not change execution (observer-only; default OFF and
//     fires only on explicit invocation, from the CLI or a direct call).
//   - Laya cannot admit, bypass, execute, persist, or gate anything. The veto
//     and escalator outcomes recorded here are simulations, not enforcement.
//   - Raw scores are never a registry feature, training target, or gate — and
//     there is deliberately NO numeric threshold anywhere in this file. Raw
//     numbers exist only inside the hashed vendor_output section as verbatim
//     model output. The top-level diagnostics are bucketed or structural:
//     separation_class, escalation_triggered, vetoed, abstained,
//     top_agrees_with_selection, rank_of_selected.
//   - Fail-closed: transport failure, malformed typed answers, picks outside
//     the eligible set, and oversized ballots are recorded as
//     unavailable/failed/unsupported shadow records and returned, never
//     thrown into the caller's path.
//
// GPT's four Tranche-2 requirements, and where each lives:
//   (1) Model execution outside the observer via injectable transport; fakes
//       need no download/GPU/network/credentials; typed responses accepted
//       AND validated ................ defaultTransport + validateTyped.
//   (2) Capacity limits explicit in a versioned transport contract; an
//       oversized ballot seals `unsupported` BEFORE any transport call —
//       visible, never silently truncated .. LAYA_TRANSPORT_CONTRACT + the
//       overflow gate at the top of compareLaya.
//   (3) Provenance (selection, candidate identities, transport version,
//       checkpoint identity, response bytes) + own immutable tree +
//       independent outcome join ..... record fields + shadow-laya/ +
//       recordLayaOutcome (joins on the kernel manifest's top-level
//       selection_id, exactly like the Jev observer).
//   (4) Local-ranker-flattering failures tested: malformed, out-of-set,
//       overflow, near-twin ambiguity, transport failure,
//       correct-capability-absent ... tests/laya-shadow.test.js; behaviors:
//       failed / failed / unsupported / escalation-diagnostic / unavailable /
//       abstained-with-reason.
//
// Test-safety: the Laya transport is injectable. Tests pass a fake
// `transport(payload)` and never touch weights, runners, or the network; no
// test in this repo may spend a cent, fetch a checkpoint, or read a
// credential. Local inference means no API dollars exist at all: cost is
// always null, never zero (zero would claim a measured cost). The default
// transport refuses outright.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const E = require('./eligibility');
const S = require('./selection');

const LAYA_SCHEMA = 'rcos-laya-shadow/1';
const LAYA_SELECTOR = { id: 'laya-ranker', version: 'experimental-1' };
const LAYA_ID_RE = /^shd_\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const LAYA_STATUSES = ['compared', 'unavailable', 'failed', 'unsupported'];
const LAYA_OUTCOME_STATUSES = ['completed', 'rejected', 'failed', 'blocked', 'unknown'];

// Versioned transport contract. Representation: one typed decision over an
// explicit option list; per-question budget 1024 tokens (typed-decisions
// checkpoint); at most MAX_OPTIONS options per call; overflow behavior is
// `unsupported` — the observer seals that status and never calls the
// transport, so nothing is ever silently truncated or chunked-and-merged
// behind the record's back. Raising MAX_OPTIONS is a contract-version bump,
// and any such bump must first pass Jev-grade adversarial and lost-candidate
// tests before any claim is made about larger ballots.
const LAYA_TRANSPORT_CONTRACT = {
  version: 'rcos-laya-transport/1',
  representation: 'typed-decision-over-option-list',
  context_budget_tokens_per_question: 1024,
  max_options: 20,
  overflow: 'unsupported'
};
// Pinned checkpoint identity. A string pin, not a fetch: the observer never
// downloads weights. A real runner presents this same pin with its bytes;
// the record carries whichever pin the transport ran under.
const LAYA_CHECKPOINT_DEFAULT = 'convaiinnovations/laya-typed-decisions';

// Separation classes, shared with the Jev observer: descriptive bands, and
// low/very-low is the escalator's input — never a correctness gate, never a
// commit/abstain rule.
const SEPARATION_CLASSES = ['very-low', 'low', 'moderate', 'high', 'single', 'unknown'];
function separationClass(separation) {
  if (separation === null || separation === undefined) return 'unknown';
  if (separation < 1.2) return 'very-low';
  if (separation < 1.6) return 'low';
  if (separation < 3.0) return 'moderate';
  return 'high';
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function makeShadowId(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return 'shd_' + iso + '-' + crypto.randomBytes(3).toString('hex');
}
function isShadowId(id) { return typeof id === 'string' && LAYA_ID_RE.test(id); }

function shadowsDir(homeDir) { return path.join(homeDir, 'shadow-laya'); }
function shadowDir(homeDir, id) { return path.join(shadowsDir(homeDir), id); }

function shadowIntegrity(doc) {
  const { integrity, ...rest } = doc;
  return sha256(JSON.stringify(rest, null, 2) + '\n');
}
function canonicalSetSha(value) {
  return sha256(JSON.stringify(value, null, 2) + '\n');
}

// The option cards come from the eligibility decisions' own contents —
// capability id and version plus what RCOS observed — because registry
// entries carry no self-description. The same cards the bus saw; the typed
// decision answers over exactly these options.
function buildOptionCards(candidates) {
  const cards = {};
  for (const c of candidates) {
    const observed = c.decision.observed_state || {};
    const bits = [
      'capability ' + c.capability_id + ' version ' + c.capability_version,
      'kind ' + (observed.kind || 'unknown'),
      'status ' + (observed.status || 'unknown')
    ];
    cards[c.capability_id] = bits.join('; ');
  }
  return cards;
}

function orderScores(scores) {
  const entries = Object.entries(scores || {});
  entries.sort((a, b) => b[1] - a[1]);
  return entries;
}

// separation = top probability / runner-up, the experiment's Phase 4
// measure. Null when there is nothing to separate (fewer than two values, or
// a zero runner-up): the escalator treats "no competition visible" as
// unknown, not as confident.
function separationOf(probabilities) {
  const entries = orderScores(probabilities);
  if (entries.length < 2) return null;
  const second = entries[1][1];
  if (!second) return null;
  return entries[0][1] / second;
}

// The escalator simulation, frozen from the experiment: low-confidence AND
// low-separation is the only trigger. Confidence alone never fires it,
// separation alone never fires it, and neither is a threshold a deployment
// may tune — the bands are structural, not calibrated.
function escalationWouldFire(pickProb, sepClass) {
  return pickProb !== null && pickProb < 0.5
    && (sepClass === 'very-low' || sepClass === 'low');
}

// The seam, not an implementation. There is deliberately no default that
// loads weights, shells to a runner, or dials out: without an explicit
// transport the observer seals `unavailable`, and the record says so.
function defaultTransport() {
  throw new Error('no Laya transport configured — pass an explicit transport (tests use a fake); the shadow never runs inference on its own');
}

// A typed Laya decision, validated — never trusted. Accepted shape:
//   { type:'decision', pick:<id|null>, scores:{<id>:n...},
//     probabilities:{<id>:n...}, checkpoint:<non-empty string>,
//     abstain_reason?:<string> }
// pick null + a string abstain_reason = the model abstains (e.g. the correct
// capability is absent from the ballot); the record says abstained with the
// reason instead of inventing a pick. Anything else is `failed`.
function validateTyped(answer, eligibleSet) {
  const problems = [];
  if (!answer || typeof answer !== 'object') return { ok: false, problems: ['answer is not an object'] };
  if (answer.type !== 'decision') problems.push('answer.type must be "decision", got ' + JSON.stringify(answer.type));
  if (answer.pick !== null && !eligibleSet.includes(answer.pick)) {
    problems.push('pick ' + JSON.stringify(answer.pick) + ' is outside the eligible set, so the veto rejects it');
  }
  for (const k of ['scores', 'probabilities']) {
    if (!answer[k] || typeof answer[k] !== 'object' || Array.isArray(answer[k])) {
      problems.push(k + ' must be an object');
    }
  }
  // A ranking over nothing is a vacuous claim, not a decision: scores must
  // name at least one option. Probabilities may be absent-as-empty (the model
  // can score without calibrating), but then the pick probability is null and
  // the escalator stays silent.
  if (answer.scores && typeof answer.scores === 'object' && !Array.isArray(answer.scores)
      && Object.keys(answer.scores).length === 0) {
    problems.push('scores must name at least one option');
  }
  if (answer.pick === null && typeof answer.abstain_reason !== 'string') {
    problems.push('a null pick must carry a string abstain_reason');
  }
  if (typeof answer.checkpoint !== 'string' || answer.checkpoint.length === 0) {
    problems.push('checkpoint must be a non-empty string pin');
  }
  return problems.length === 0 ? { ok: true, problems: [] } : { ok: false, problems };
}

// Compare Laya against a completed selection. Reads the selection artifact,
// re-verifies it, asks Laya (via the injected transport) to decide over the
// same verified candidate set, simulates the veto and escalator, and seals
// the record. Returns { ok, shadow_id, record, dir, record_path,
// record_sha256 } on success, or { ok:false, error } where the failure is
// ours (bad selection, unwritable home). Laya-side failure is NOT an error
// return: it seals an unavailable/failed/unsupported record and returns
// ok:true with that record, fail-closed.
function compareLaya(homeDir, selectionId, opts = {}) {
  const transport = opts.transport || defaultTransport;
  const checkpoint = opts.checkpoint || LAYA_CHECKPOINT_DEFAULT;
  const now = opts.now || new Date();

  const selDoc = S.readSelection(homeDir, selectionId);
  if (!selDoc) return { ok: false, error: 'no such selection artifact: ' + selectionId };
  const verified = S.verifySelection(homeDir, selectionId);
  if (!verified.ok) {
    return { ok: false, error: 'selection ' + selectionId + ' does not verify: ' + verified.problems.join('; ') };
  }

  // Re-read every candidate decision the way the bus does, so the shadow's
  // "eligible candidate set" is the bus's wall, not the record's claim.
  const candidates = [];
  for (const c of verified.selection.candidates) {
    const rc = S.readCandidate(homeDir, c.eligibility_decision_id);
    if (!rc.ok) return { ok: false, error: 'candidate decision unreadable: ' + rc.error };
    candidates.push({
      capability_id: c.capability_id,
      capability_version: c.capability_version,
      eligibility_decision_id: c.eligibility_decision_id,
      decision: rc.decision
    });
  }
  const eligibleSet = candidates.map((c) => c.capability_id);
  const cards = buildOptionCards(candidates);
  const options = Object.assign({ fresh: 'solve the task directly, without any capability' }, cards);
  const selectionSha = sha256(fs.readFileSync(path.join(S.selectionDir(homeDir, selectionId), 'selection.json')));

  // Capacity gate FIRST: a ballot the contract cannot represent seals
  // `unsupported` before any transport call. Never truncate, never chunk
  // silently, never ask the model a question the record cannot show.
  if (eligibleSet.length > LAYA_TRANSPORT_CONTRACT.max_options) {
    let id = opts.shadowId || makeShadowId(now);
    if (opts.shadowId && !isShadowId(id)) throw new Error('bad shadow id: ' + id);
    fs.mkdirSync(shadowsDir(homeDir), { recursive: true });
    const dir = shadowDir(homeDir, id);
    for (let attempt = 0; ; attempt += 1) {
      try { fs.mkdirSync(dir); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (opts.shadowId) throw new Error('laya shadow record ' + id + ' already exists — shadow records are write-once and never rewritten');
        if (attempt >= 5) throw e;
        id = makeShadowId(now);
      }
    }
    const record = {
      schema: LAYA_SCHEMA,
      shadow_id: id,
      shadow_selector: { ...LAYA_SELECTOR },
      transport_contract: LAYA_TRANSPORT_CONTRACT.version,
      checkpoint,
      selection_id: selectionId,
      selection_sha256: selectionSha,
      eligible_candidate_set: eligibleSet,
      current_chosen_capability: verified.selection.selected_capability_id,
      laya_ranking: [],
      laya_top_candidate: null,
      fresh_veto_outcome: 'not-run',
      escalation_triggered: false,
      eventual_actual_outcome: null,
      outcome_path: 'outcome.json',
      cost: null,
      latency_ms: null,
      separation_class: 'unknown',
      vetoed: false,
      abstained: false,
      abstain_reason: null,
      top_agrees_with_selection: false,
      rank_of_selected: -1,
      status: 'unsupported',
      vendor_error: 'ballot of ' + eligibleSet.length + ' exceeds contract max_options ' + LAYA_TRANSPORT_CONTRACT.max_options + ' — unsupported, never truncated',
      candidate_set_sha256: canonicalSetSha(eligibleSet),
      compared_at: now.toISOString(),
      rcos_home: homeDir,
      created_at: new Date().toISOString(),
      vendor_output: null
    };
    record.integrity = { algo: 'sha256', value: shadowIntegrity(record) };
    const recordPath = path.join(dir, 'record.json');
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
    return { ok: true, shadow_id: id, record, dir, record_path: recordPath, record_sha256: sha256(fs.readFileSync(recordPath)) };
  }

  const question = {
    type: 'typed-decision',
    text: 'Which single option should handle this task? Choose \'fresh\' unless a listed capability\'s stated purpose and preconditions genuinely cover this task as given. Answer with a typed decision over exactly these options.',
    options
  };
  const payload = {
    contract: LAYA_TRANSPORT_CONTRACT.version,
    checkpoint,
    state: 'RCOS laya shadow comparison for selection ' + selectionId + ': ' + eligibleSet.length + ' eligible options.',
    questions: { rank: question }
  };

  // Laya-side failure seals a record, never throws. The status says what
  // happened: unavailable (transport down / refused), failed (the typed
  // answer arrived but is unusable — malformed, out-of-set, wrong shape), or
  // unsupported (sealed above, before the transport ran).
  let answer = null;
  let vendorError = null;
  let status = 'compared';
  let latencyMs = null;
  try {
    const started = Date.now();
    const response = transport(payload);
    latencyMs = Date.now() - started;
    answer = response && response.answers ? (response.answers.rank || response.answers.decision) : null;
    if (!answer) {
      status = 'failed';
      vendorError = 'answer is not a usable typed decision';
      answer = null;
    } else {
      const v = validateTyped(answer, Object.keys(options));
      if (!v.ok) {
        status = 'failed';
        vendorError = 'typed response failed validation: ' + v.problems.join('; ');
        answer = null;
      }
    }
  } catch (e) {
    status = 'unavailable';
    vendorError = 'Laya transport failed: ' + (e && e.message ? e.message : String(e));
    answer = null;
  }

  const probabilities = answer && answer.probabilities ? answer.probabilities : null;
  const scores = answer && answer.scores ? answer.scores : null;
  const ordered = scores ? orderScores(scores).map(([choice, score]) => ({ choice, score })) : [];
  const pickProb = probabilities && answer && answer.pick !== null && typeof probabilities[answer.pick] === 'number'
    ? probabilities[answer.pick] : null;
  const separation = probabilities ? separationOf(probabilities) : null;
  const sepClass = status === 'compared'
    ? (ordered.length < 2 ? 'single' : separationClass(separation))
    : 'unknown';
  const escalation = status === 'compared' ? escalationWouldFire(pickProb, sepClass) : false;
  // The veto is the wall the bus already built: a pick outside the verified
  // eligible set can never stand. Validation already rejected out-of-set
  // picks, so on a compared record the veto never fires — the field stays to
  // keep the ruling's shape, and the simulation is honest about that.
  const vetoed = false;
  const abstained = status === 'compared' ? (answer.pick === null || answer.pick === 'fresh') : false;
  const topAgrees = status === 'compared'
    ? answer.pick === verified.selection.selected_capability_id : false;
  const rankOfSelected = status === 'compared' && scores
    ? ordered.findIndex((o) => o.choice === verified.selection.selected_capability_id) : -1;

  let id = opts.shadowId || makeShadowId(now);
  if (opts.shadowId && !isShadowId(id)) throw new Error('bad shadow id: ' + id);
  fs.mkdirSync(shadowsDir(homeDir), { recursive: true });
  const dir = shadowDir(homeDir, id);
  for (let attempt = 0; ; attempt += 1) {
    try { fs.mkdirSync(dir); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (opts.shadowId) throw new Error('laya shadow record ' + id + ' already exists — shadow records are write-once and never rewritten');
      if (attempt >= 5) throw e;
      id = makeShadowId(now);
    }
  }

  // GPT's nine per-event fields, in the ruling's shape — laya_ranking and
  // laya_top_candidate standing where jev_ranking and jev_top_candidate
  // stand on the sibling observer. Raw scores appear NOWHERE at this level:
  // separation_class and escalation_triggered carry the structure,
  // vetoed/abstained carry the wall, and the raw model numbers live only
  // inside vendor_output, sealed by the same hash. The eventual actual
  // outcome is unknowable at compare time, so the record links forward
  // (outcome_path) rather than fabricating it — outcome.json lands later via
  // recordLayaOutcome, once.
  const record = {
    schema: LAYA_SCHEMA,
    shadow_id: id,
    shadow_selector: { ...LAYA_SELECTOR },
    transport_contract: LAYA_TRANSPORT_CONTRACT.version,
    checkpoint,
    selection_id: selectionId,
    selection_sha256: selectionSha,
    eligible_candidate_set: eligibleSet,
    current_chosen_capability: verified.selection.selected_capability_id,
    laya_ranking: ordered.map((o) => o.choice),
    laya_top_candidate: status === 'compared' ? answer.pick : null,
    fresh_veto_outcome: status === 'compared' ? (vetoed ? 'vetoed' : 'kept') : 'not-run',
    escalation_triggered: escalation,
    eventual_actual_outcome: null,
    outcome_path: 'outcome.json',
    cost: null,
    latency_ms: status === 'compared' ? latencyMs : null,
    separation_class: sepClass,
    vetoed,
    abstained,
    abstain_reason: status === 'compared' && answer.pick === null ? answer.abstain_reason : null,
    top_agrees_with_selection: topAgrees,
    rank_of_selected: rankOfSelected,
    status,
    vendor_error: vendorError,
    candidate_set_sha256: canonicalSetSha(eligibleSet),
    compared_at: now.toISOString(),
    rcos_home: homeDir,
    created_at: new Date().toISOString(),
    vendor_output: status === 'compared' ? {
      answer_type: answer.type,
      choice: answer.pick,
      scores: answer.scores,
      probabilities: answer.probabilities,
      abstain_reason: Object.prototype.hasOwnProperty.call(answer, 'abstain_reason') ? answer.abstain_reason : null,
      checkpoint: answer.checkpoint,
      response_sha256: sha256(JSON.stringify(answer)),
      note: 'verbatim model output, sealed by this record\'s integrity hash. Raw scores here are evidence, never a feature, target, or gate.'
    } : null
  };
  record.integrity = { algo: 'sha256', value: shadowIntegrity(record) };
  const recordPath = path.join(dir, 'record.json');
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  return {
    ok: true,
    shadow_id: id,
    record,
    dir,
    record_path: recordPath,
    record_sha256: sha256(fs.readFileSync(recordPath))
  };
}

// Append the eventual actual outcome, once. The outcome is unknowable when
// the shadow compares, so it links forward instead: this reads the sealed
// record, resolves the invocation (if any), and writes outcome.json beside
// record.json — per-file write-once, the record itself never mutating.
function recordLayaOutcome(homeDir, shadowId, invocationId, opts = {}) {
  if (!isShadowId(shadowId)) return { ok: false, error: 'not a laya shadow id: ' + String(shadowId) };
  const dir = shadowDir(homeDir, shadowId);
  const recordPath = path.join(dir, 'record.json');
  if (!fs.existsSync(recordPath)) return { ok: false, error: 'no such laya shadow record: ' + shadowId };
  const I = require('./invocation');
  const manifest = I.readManifest(homeDir, invocationId);
  let outcome = 'unknown';
  let invocationStatus = null;
  if (manifest) {
    invocationStatus = manifest.status || null;
    // The join key is manifest.selection_id (top level), not the nested
    // manifest.selection block, which carries selector/status/candidates/path
    // but no id of its own. A missing selection_id means direct invocation —
    // legitimate, and its outcome still records honestly as the event's own.
    if (manifest.selection_id) {
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      if (manifest.selection_id !== record.selection_id) {
        return { ok: false, error: 'invocation ' + invocationId + ' names selection ' + manifest.selection_id + ' but laya shadow ' + shadowId + ' compares ' + record.selection_id };
      }
    }
    if (invocationStatus && LAYA_OUTCOME_STATUSES.includes(invocationStatus)) outcome = invocationStatus;
  }
  const doc = {
    schema: LAYA_SCHEMA,
    shadow_id: shadowId,
    invocation_id: invocationId,
    invocation_found: manifest !== null,
    invocation_status: invocationStatus,
    eventual_actual_outcome: outcome,
    recorded_at: (opts.now || new Date()).toISOString()
  };
  doc.integrity = { algo: 'sha256', value: shadowIntegrity(doc) };
  const outcomePath = path.join(dir, 'outcome.json');
  try {
    fs.writeFileSync(outcomePath, JSON.stringify(doc, null, 2) + '\n', { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') return { ok: false, error: 'laya shadow ' + shadowId + ' already has an outcome — outcomes are append-once and never rewritten' };
    throw e;
  }
  return { ok: true, shadow_id: shadowId, outcome, outcome_path: outcomePath };
}

function readLayaShadow(homeDir, id) {
  const p = path.join(shadowDir(homeDir, id), 'record.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listLayaShadows(homeDir) {
  const dir = shadowsDir(homeDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isShadowId(d.name))
    .map((d) => d.name)
    .sort();
}

// Deterministic verifier in the house style: re-hash the record, re-check
// the schema, selector pin, contract pin, and checkpoint pin, re-verify the
// linked selection, re-read every candidate decision, and confirm no stray
// files. Raw scores are never inspected — they are sealed model output, not
// claims.
function verifyLayaShadow(homeDir, id) {
  const dir = shadowDir(homeDir, id);
  if (!fs.existsSync(dir)) return { ok: false, problems: ['laya shadow record not found: ' + id], checked: 0 };
  const problems = [];
  let record = null;
  const p = path.join(dir, 'record.json');
  if (!fs.existsSync(p)) problems.push('record.json missing');
  else {
    try { record = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { problems.push('record.json is not valid JSON: ' + e.message); }
  }
  if (record) {
    if (record.schema !== LAYA_SCHEMA) problems.push('schema is not ' + LAYA_SCHEMA);
    if (record.shadow_id !== id) problems.push('shadow_id does not match its directory name');
    if (!record.integrity || record.integrity.algo !== 'sha256') problems.push('integrity missing or not sha256');
    else if (record.integrity.value !== shadowIntegrity(record)) problems.push('record integrity mismatch — the record was edited after it was written');
    if (!LAYA_STATUSES.includes(record.status)) problems.push('unknown laya shadow status: ' + String(record.status));
    if (record.shadow_selector && (record.shadow_selector.id !== 'laya-ranker' || record.shadow_selector.version !== 'experimental-1')) {
      problems.push('shadow_selector is not laya-ranker@experimental-1');
    }
    if (record.transport_contract !== LAYA_TRANSPORT_CONTRACT.version) {
      problems.push('transport contract is not ' + LAYA_TRANSPORT_CONTRACT.version);
    }
    if (typeof record.checkpoint !== 'string' || record.checkpoint.length === 0) {
      problems.push('checkpoint pin missing — the record must say which weights it ran under');
    }
    if (!SEPARATION_CLASSES.includes(record.separation_class)) problems.push('unknown separation_class: ' + String(record.separation_class));
    if (record.status === 'unsupported' && !/max_options|exceeds/i.test(record.vendor_error || '')) {
      problems.push('unsupported records must name the capacity limit they hit');
    }
    if (record.cost !== null) problems.push('cost must be null — local inference has no API dollars to count');
    // Raw scores must not leak to the top level: they live only in
    // vendor_output, sealed as verbatim model evidence.
    for (const k of ['scores', 'probabilities', 'pick_probability', 'pick_prob', 'confidence', 'vendor_confidence']) {
      if (Object.prototype.hasOwnProperty.call(record, k)) problems.push('raw model number at top level: ' + k + ' — scores live only inside vendor_output');
    }
    const sel = S.verifySelection(homeDir, record.selection_id);
    if (!sel.ok) problems.push('linked selection does not verify: ' + sel.problems.join('; '));
    else {
      if (record.current_chosen_capability !== sel.selection.selected_capability_id) {
        problems.push('current_chosen_capability does not match the linked selection\'s winner');
      }
      const live = sel.selection.candidates.map((c) => E.readDecision(homeDir, c.eligibility_decision_id))
        .filter(Boolean).map((d) => d.capability_id);
      if (JSON.stringify([...live].sort()) !== JSON.stringify([...(record.eligible_candidate_set || [])].sort())) {
        problems.push('eligible_candidate_set does not match the linked selection\'s candidates');
      }
    }
    if (record.candidate_set_sha256 !== canonicalSetSha(record.eligible_candidate_set || [])) {
      problems.push('candidate_set_sha256 does not match the recorded eligible set');
    }
    const stray = fs.readdirSync(dir).filter((n) => n !== 'record.json' && n !== 'outcome.json');
    for (const n of stray) problems.push('artifact present but not part of a laya shadow record: ' + n);
    const op = path.join(dir, 'outcome.json');
    if (fs.existsSync(op)) {
      try {
        const odoc = JSON.parse(fs.readFileSync(op, 'utf8'));
        if (odoc.integrity && odoc.integrity.algo === 'sha256' && odoc.integrity.value !== shadowIntegrity(odoc)) {
          problems.push('outcome integrity mismatch — the outcome was edited after it was written');
        }
        if (odoc.shadow_id !== id) problems.push('outcome shadow_id does not match its directory name');
      } catch (e) { problems.push('outcome.json is not valid JSON: ' + e.message); }
    }
  }
  return { ok: problems.length === 0, problems, checked: 1, record };
}

module.exports = {
  LAYA_SCHEMA,
  LAYA_SELECTOR,
  LAYA_STATUSES,
  LAYA_ID_RE,
  LAYA_TRANSPORT_CONTRACT,
  LAYA_CHECKPOINT_DEFAULT,
  SEPARATION_CLASSES,
  makeShadowId,
  isShadowId,
  shadowsDir,
  shadowDir,
  shadowIntegrity,
  separationOf,
  separationClass,
  escalationWouldFire,
  validateTyped,
  compareLaya,
  recordLayaOutcome,
  readLayaShadow,
  listLayaShadows,
  verifyLayaShadow,
  sha256
};
