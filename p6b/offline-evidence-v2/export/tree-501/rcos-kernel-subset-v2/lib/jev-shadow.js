'use strict';
// The Jev shadow comparator: jev-ranker@experimental-1.
//
// GPT's ruling on the router experiment wires Jev in as a selector primitive —
// but in tranche 1 it has NO authority at all. This module is the shape that
// ruling takes: an OBSERVER beside a completed selection, never a SELECTORS
// occupant. It runs after the bus has spoken, consumes the same verified
// candidate set, asks Jev what it would have picked, applies the experiment's
// veto and escalator logic as a simulation, and seals an immutable shadow
// record. Nothing here changes execution: the selection artifact, the selector
// registry, and the invocation path are untouched. A shadow record is evidence
// for the 10-leg acceptance bar, never a routing decision.
//
// Ruling constraints this module enforces by construction:
//   - Jev's choice does not change execution (observer-only; default OFF and
//     fires only on explicit invocation, from the CLI or a direct call).
//   - Jev cannot admit, bypass, execute, persist, or gate anything. The veto
//     and escalator outcomes recorded here are simulations computed against a
//     frozen copy of the experiment harness rules, not enforcement.
//   - Raw confidence is never a registry feature, training target, or gate —
//     and there is deliberately NO numeric threshold anywhere in this file.
//     Confidence values exist only inside the hashed vendor_output section as
//     verbatim vendor output. The top-level diagnostics are bucketed or
//     structural: separation_class, escalation_triggered, vetoed, abstained,
//     top_agrees_with_selection, rank_of_selected.
//   - Fail-closed: any Jev transport failure, malformed answer, or pick
//     outside the eligible set is recorded as an unavailable/failed shadow
//     record and returned, never thrown into the caller's path.
//
// Test-safety: the Jev transport is injectable. Tests pass a fake
// `transport(payload)` and never touch the network; no test in this repo may
// spend a cent or read the API key. The default transport refuses outright.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const E = require('./eligibility');
const S = require('./selection');

const SHADOW_SCHEMA = 'rcos-jev-shadow/1';
const SHADOW_SELECTOR = { id: 'jev-ranker', version: 'experimental-1' };
const SHADOW_ID_RE = /^shd_\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const SHADOW_STATUSES = ['compared', 'unavailable', 'failed'];
const OUTCOME_STATUSES = ['completed', 'rejected', 'failed', 'blocked', 'unknown'];

// The OpenRouter decisions route this module would call in live mode. Kept in
// one place so the fake transports in tests and the real lane can never drift
// apart on where the wire goes. No live call happens here: the default
// transport throws, and only an explicitly passed transport runs.
const OPENROUTER_BASE_URL = 'https://openrouter.ai';
const OPENROUTER_DECISIONS_PATH = '/api/alpha/decisions';
const OPENROUTER_MODEL = 'typesafe/jev-1.13';

// Per-call pricing from the experiment's adapter: input tokens are billed,
// output tokens are free. A transport that reports usage gets its cost
// computed here; one that does not leaves cost null rather than guessed.
const JEV_INPUT_USD_PER_BTOK = 42;
function costOf(usage) {
  if (!usage || typeof usage.input_tokens !== 'number') return null;
  return usage.input_tokens / 1e9 * JEV_INPUT_USD_PER_BTOK;
}

// Separation classes, from the experiment's Phase 4 finding: the Choice
// low-confidence/low-separation corner is a real ambiguity detector (it
// catches both attack picks and narrowing-induced errors and flags
// fragile-correct answers) but has no portable correctness threshold. So the
// classes are descriptive bands, and low/very-low is the escalator's input —
// never a correctness gate, never a commit/abstain rule.
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
function isShadowId(id) { return typeof id === 'string' && SHADOW_ID_RE.test(id); }

function shadowsDir(homeDir) { return path.join(homeDir, 'shadow'); }
function shadowDir(homeDir, id) { return path.join(shadowsDir(homeDir), id); }

function shadowIntegrity(doc) {
  const { integrity, ...rest } = doc;
  return sha256(JSON.stringify(rest, null, 2) + '\n');
}
function canonicalSetSha(value) {
  return sha256(JSON.stringify(value, null, 2) + '\n');
}

// The vendor question cards come from the eligibility decisions' own contents
// — capability id and version plus what RCOS observed — because registry
// entries carry no self-description. No gold, no family, no block: exactly
// what an arriving model would see.
function buildQuestionCards(candidates) {
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

function orderProbabilities(probabilities) {
  const entries = Object.entries(probabilities || {});
  entries.sort((a, b) => b[1] - a[1]);
  return entries;
}

// separation = top probability / runner-up, the experiment's Phase 4 measure.
// Null when there is nothing to separate (fewer than two values, or a zero
// runner-up): the escalator treats "no competition visible" as unknown, not
// as confident.
function separationOf(probabilities) {
  const entries = orderProbabilities(probabilities);
  if (entries.length < 2) return null;
  const second = entries[1][1];
  if (!second) return null;
  return entries[0][1] / second;
}

// The escalator simulation, frozen from the experiment: low-confidence AND
// low-separation is the only trigger. Confidence alone never fires it (Phase 4
// proved confidence is inverted on the full pool), separation alone never
// fires it, and neither is a threshold a deployment may tune — the bands are
// structural, not calibrated.
function escalationWouldFire(pickProb, sepClass) {
  return pickProb !== null && pickProb < 0.5
    && (sepClass === 'very-low' || sepClass === 'low');
}

function defaultTransport() {
  throw new Error('no Jev transport configured — pass an explicit transport (tests use a fake); the shadow never dials out on its own');
}

// Compare Jev against a completed selection. Reads the selection artifact,
// re-verifies it, asks Jev (via the injected transport) to rank the same
// verified candidate set, simulates the veto and escalator, and seals the
// record. Returns { ok, shadow_id, record, dir, record_path } on success, or
// { ok:false, error } where the failure is ours (bad selection, unwritable
// home). Jev-side failure is NOT an error return: it seals an
// unavailable/failed record and returns ok:true with that record, fail-closed.
function compareShadow(homeDir, selectionId, opts = {}) {
  const transport = opts.transport || defaultTransport;
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
  const cards = buildQuestionCards(candidates);
  const criteria = Object.assign({ fresh: 'solve the task directly, without any capability' }, cards);
  const selectionSha = sha256(fs.readFileSync(path.join(S.selectionDir(homeDir, selectionId), 'selection.json')));

  const question = {
    type: 'choice',
    text: 'Which single option should handle this task? Choose \'fresh\' unless a listed capability\'s stated purpose and preconditions genuinely cover this task as given.',
    criteria
  };
  const payload = {
    model: OPENROUTER_MODEL,
    state: 'RCOS shadow comparison for selection ' + selectionId + ': ' + eligibleSet.length + ' eligible candidates.',
    questions: { rank: question }
  };

  // Jev-side failure seals a record, never throws. The status says what
  // happened: unavailable (transport down / refused) or failed (answer
  // arrived but is unusable — malformed, out-of-set, wrong shape).
  let answer = null;
  let vendorError = null;
  let status = 'compared';
  let usage = null;
  let latencyMs = null;
  try {
    const started = Date.now();
    const response = transport(payload);
    latencyMs = Date.now() - started;
    usage = response && response.usage ? response.usage : null;
    answer = response && response.answers ? response.answers.rank : null;
    if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string') {
      status = 'failed';
      vendorError = 'answer is not a usable Choice result';
      answer = null;
    } else if (!Object.prototype.hasOwnProperty.call(criteria, answer.choice)) {
      status = 'failed';
      vendorError = 'Jev picked \'' + answer.choice + '\' — outside the eligible set, so the veto rejects it';
      answer = null;
    }
  } catch (e) {
    status = 'unavailable';
    vendorError = 'Jev transport failed: ' + (e && e.message ? e.message : String(e));
    answer = null;
  }

  const probabilities = answer && answer.probabilities ? answer.probabilities : null;
  const ordered = probabilities ? orderProbabilities(probabilities).map(([choice, p]) => ({ choice, probability: p })) : [];
  const pickProb = probabilities && answer && typeof probabilities[answer.choice] === 'number'
    ? probabilities[answer.choice] : null;
  const separation = probabilities ? separationOf(probabilities) : null;
  const sepClass = status === 'compared'
    ? (ordered.length < 2 ? 'single' : separationClass(separation))
    : 'unknown';
  const escalation = status === 'compared' ? escalationWouldFire(pickProb, sepClass) : false;
  // The veto is the wall the bus already built: a pick outside the verified
  // eligible set can never stand. Here it is a simulation — the record says
  // what the veto WOULD have done — because the shadow enforces nothing.
  const vetoed = status === 'compared' ? !Object.prototype.hasOwnProperty.call(criteria, answer.choice) : false;
  const abstained = status === 'compared' ? answer.choice === 'fresh' : false;
  const topAgrees = status === 'compared'
    ? answer.choice === verified.selection.selected_capability_id : false;
  const rankOfSelected = status === 'compared' && probabilities
    ? ordered.findIndex((o) => o.choice === verified.selection.selected_capability_id) : -1;

  let id = opts.shadowId || makeShadowId(now);
  if (opts.shadowId && !isShadowId(id)) throw new Error('bad shadow id: ' + id);
  fs.mkdirSync(shadowsDir(homeDir), { recursive: true });
  const dir = shadowDir(homeDir, id);
  for (let attempt = 0; ; attempt += 1) {
    try { fs.mkdirSync(dir); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (opts.shadowId) throw new Error('shadow record ' + id + ' already exists — shadow records are write-once and never rewritten');
      if (attempt >= 5) throw e;
      id = makeShadowId(now);
    }
  }

  // GPT's nine per-event fields, in the ruling's shape. Confidence appears
  // NOWHERE at this level: separation_class and escalation_triggered carry
  // the structure, vetoed/abstained carry the wall, and the raw vendor
  // numbers live only inside vendor_output, sealed by the same hash. The
  // eventual actual outcome is unknowable at compare time, so the record
  // links forward (outcome_path) rather than fabricating it — outcome.json
  // lands later via recordOutcome, once.
  const record = {
    schema: SHADOW_SCHEMA,
    shadow_id: id,
    shadow_selector: { ...SHADOW_SELECTOR },
    selection_id: selectionId,
    selection_sha256: selectionSha,
    eligible_candidate_set: eligibleSet,
    current_chosen_capability: verified.selection.selected_capability_id,
    jev_ranking: ordered.map((o) => o.choice),
    jev_top_candidate: status === 'compared' ? answer.choice : null,
    fresh_veto_outcome: status === 'compared' ? (vetoed ? 'vetoed' : 'kept') : 'not-run',
    escalation_triggered: escalation,
    eventual_actual_outcome: null,
    outcome_path: 'outcome.json',
    cost: status === 'compared' ? costOf(usage) : null,
    latency_ms: status === 'compared' ? latencyMs : null,
    separation_class: sepClass,
    vetoed,
    abstained,
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
      choice: answer.choice,
      probabilities: answer.probabilities,
      confidence: Object.prototype.hasOwnProperty.call(answer, 'confidence') ? answer.confidence : null,
      usage: null,
      note: 'verbatim vendor output, sealed by this record\'s integrity hash. Raw confidence here is evidence, never a feature, target, or gate.'
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
function recordOutcome(homeDir, shadowId, invocationId, opts = {}) {
  if (!isShadowId(shadowId)) return { ok: false, error: 'not a shadow id: ' + String(shadowId) };
  const dir = shadowDir(homeDir, shadowId);
  const recordPath = path.join(dir, 'record.json');
  if (!fs.existsSync(recordPath)) return { ok: false, error: 'no such shadow record: ' + shadowId };
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
        return { ok: false, error: 'invocation ' + invocationId + ' names selection ' + manifest.selection_id + ' but shadow ' + shadowId + ' compares ' + record.selection_id };
      }
    }
    if (invocationStatus && OUTCOME_STATUSES.includes(invocationStatus)) outcome = invocationStatus;
  }
  const doc = {
    schema: SHADOW_SCHEMA,
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
    if (e.code === 'EEXIST') return { ok: false, error: 'shadow ' + shadowId + ' already has an outcome — outcomes are append-once and never rewritten' };
    throw e;
  }
  return { ok: true, shadow_id: shadowId, outcome, outcome_path: outcomePath };
}

function readShadow(homeDir, id) {
  const p = path.join(shadowDir(homeDir, id), 'record.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listShadows(homeDir) {
  const dir = shadowsDir(homeDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isShadowId(d.name))
    .map((d) => d.name)
    .sort();
}

// Deterministic verifier in the house style: re-hash the record, re-check
// the schema and id, re-verify the linked selection, re-read every candidate
// decision, and confirm no stray files. Confidence values are never
// inspected — they are sealed vendor output, not claims.
function verifyShadow(homeDir, id) {
  const dir = shadowDir(homeDir, id);
  if (!fs.existsSync(dir)) return { ok: false, problems: ['shadow record not found: ' + id], checked: 0 };
  const problems = [];
  let record = null;
  const p = path.join(dir, 'record.json');
  if (!fs.existsSync(p)) problems.push('record.json missing');
  else {
    try { record = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { problems.push('record.json is not valid JSON: ' + e.message); }
  }
  if (record) {
    if (record.schema !== SHADOW_SCHEMA) problems.push('schema is not ' + SHADOW_SCHEMA);
    if (record.shadow_id !== id) problems.push('shadow_id does not match its directory name');
    if (!record.integrity || record.integrity.algo !== 'sha256') problems.push('integrity missing or not sha256');
    else if (record.integrity.value !== shadowIntegrity(record)) problems.push('record integrity mismatch — the record was edited after it was written');
    if (!SHADOW_STATUSES.includes(record.status)) problems.push('unknown shadow status: ' + String(record.status));
    if (record.shadow_selector && (record.shadow_selector.id !== 'jev-ranker' || record.shadow_selector.version !== 'experimental-1')) {
      problems.push('shadow_selector is not jev-ranker@experimental-1');
    }
    if (!SEPARATION_CLASSES.includes(record.separation_class)) problems.push('unknown separation_class: ' + String(record.separation_class));
    // Raw confidence must not leak to the top level: it lives only in
    // vendor_output, sealed as verbatim vendor evidence.
    for (const k of ['confidence', 'pick_probability', 'pick_prob', 'probabilities', 'vendor_confidence']) {
      if (Object.prototype.hasOwnProperty.call(record, k)) problems.push('raw vendor number at top level: ' + k + ' — confidence lives only inside vendor_output');
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
    for (const n of stray) problems.push('artifact present but not part of a shadow record: ' + n);
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
  SHADOW_SCHEMA,
  SHADOW_SELECTOR,
  SHADOW_STATUSES,
  SHADOW_ID_RE,
  OPENROUTER_BASE_URL,
  OPENROUTER_DECISIONS_PATH,
  OPENROUTER_MODEL,
  SEPARATION_CLASSES,
  makeShadowId,
  isShadowId,
  shadowsDir,
  shadowDir,
  shadowIntegrity,
  separationOf,
  separationClass,
  escalationWouldFire,
  compareShadow,
  recordOutcome,
  readShadow,
  listShadows,
  verifyShadow,
  sha256
};
