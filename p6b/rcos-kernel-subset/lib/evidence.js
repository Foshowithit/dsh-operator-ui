'use strict';
// The truth/evidence envelope: one way for RCOS to persist a claim about the
// world together with where it came from, what kind of truth it represents,
// and what prior evidence it depends on — without deciding which competing
// claim is ultimately correct.
//
// Invariant this file exists to hold:
//   Evidence records provenance and lineage. It never arbitrates truth.
//
// That is deliberately the smaller half of the problem. Classifying a claim
// (observation, inference, authoritative record, human attestation, action
// result) is not judging it true; pinning where it came from is not blessing
// the source; letting two competing claims coexist is not a bug. Anything that
// picks a winner — a resolver, "latest wins", source priority, confidence
// aggregation, a freshness policy, a planner — is a later step and must not
// live here. This file has no vocabulary for "correct", and that absence is
// the point.
//
// The protocol is the same three meanings as before, plus a fourth that is
// not an authority either:
//   selection says WHICH        (lib/selection.js)
//   eligibility says MAY        (lib/eligibility.js)
//   the kernel says CAN EXECUTE SAFELY   (lib/invocation.js)
//   evidence says WHAT WAS CLAIMED, BY WHOM, ON WHAT BASIS   (this file)
//
// So an evidence record is never an execution authorization, never an
// evaluation verdict, and never a license to act. An invocation's output files
// are not evidence automatically: an adapter that wants its output recorded
// as evidence must explicitly emit it through the emission path below, and
// the record it produces pins the invocation that produced it by id and by
// manifest bytes.
//
// Records live in one write-once store per home:
//
//   evidence-records/<evidence_id>/evidence.json
//   evidence-records/<bundle_id>/bundle.json
//
// A bundle is an immutable pin of a set of evidence ids — the shape the truth
// envelope offers an invocation that wants to say "this is the evidence set I
// consumed". It names records, never values: re-reading a bundle re-reads the
// records, so an edited record breaks the bundle that pinned it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EVIDENCE_SCHEMA = 'rcos-evidence/1';
const BUNDLE_SCHEMA = 'rcos-evidence-bundle/1';
// The truth classes are a closed vocabulary, and it is small on purpose:
// each one answers "what kind of claim is this" and nothing else. A claim's
// class never says whether the claim is true, fresh, or important — those are
// arbitration questions, and arbitration is not built yet.
const TRUTH_CLASSES = ['observation', 'inference', 'authoritative_record', 'human_attestation', 'action_result'];
// Where the claim came from, in the coarsest terms that stay honest: a sensor
// or probe reading, a derivation from other evidence, a document or registry
// treated as authoritative, a human saying so, or the recorded result of an
// action RCOS itself took. The vocabulary is closed for the same reason the
// truth classes are: a source kind is a label, not a rank.
const SOURCE_KINDS = ['sensor', 'derivation', 'document', 'human', 'action'];
const EVIDENCE_ID_RE = /^evid_\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const BUNDLE_ID_RE = /^evbnd_\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
// An emission file is data plus its envelope, and nothing else. The adapter
// writes the value bytes; the core writes the record around them.
const EMISSION_VALUE_MAX_BYTES = 1024 * 1024;

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function makeEvidenceId(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return 'evid_' + iso + '-' + crypto.randomBytes(3).toString('hex');
}

function makeBundleId(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return 'evbnd_' + iso + '-' + crypto.randomBytes(3).toString('hex');
}

function isEvidenceId(id) { return EVIDENCE_ID_RE.test(String(id)); }
function isBundleId(id) { return BUNDLE_ID_RE.test(String(id)); }

function evidenceStoreDir(homeDir) { return path.join(homeDir, 'evidence-records'); }
function evidenceDir(homeDir, id) { return path.join(evidenceStoreDir(homeDir), id); }
function evidencePath(homeDir, id) { return path.join(evidenceDir(homeDir, id), 'evidence.json'); }
function bundlePath(homeDir, id) { return path.join(evidenceDir(homeDir, id), 'bundle.json'); }

// Self-integrity, same discipline as the eligibility decision, the selection,
// and the invocation manifest: the document hashes itself, so an edited record
// is detectable without trusting the file's own contents.
function evidenceIntegrity(doc) {
  const { integrity, ...rest } = doc;
  return sha256(JSON.stringify(rest, null, 2) + '\n');
}

function bundleIntegrity(doc) {
  const { integrity, ...rest } = doc;
  return sha256(JSON.stringify(rest, null, 2) + '\n');
}

// The evidence set is hashed as a set, independently of the rest of the bundle
// document, so "the bundle pinned exactly this" is checkable on its own.
function evidenceSetSha256(members) {
  return sha256(JSON.stringify(members, null, 2) + '\n');
}

function mkdirWriteOnce(homeDir, id, opts = {}) {
  const dir = evidenceDir(homeDir, id);
  // The container may not exist yet; the id directory itself is created
  // non-recursively so EEXIST stays the write-once signal.
  fs.mkdirSync(evidenceStoreDir(homeDir), { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (opts.namedId) {
      // The message names the artifact the caller named. Records and bundles
      // share one store directory, so a caller who named a bundle id that
      // exists must not be told an evidence record exists — it is a different
      // artifact and a different answer.
      const label = opts.label || 'evidence';
      const plural = opts.plural || 'evidence records';
      throw new Error(label + ' ' + id + ' already exists — ' + plural + ' are write-once and never rewritten');
    }
    throw e;
  }
  return dir;
}

// Field-level validation shared by every path that mints a record: the CLI
// emission path, the library caller, and the tests. Returns an array of
// problems; empty means the fields are well-formed (not that they are true).
function validateEvidenceFields(f) {
  const problems = [];
  if (!isPlainObject(f)) return ['evidence fields must be an object'];
  if (typeof f.subject !== 'string' || f.subject.length === 0) {
    problems.push('subject: a non-empty string is required');
  }
  if (typeof f.predicate !== 'string' || f.predicate.length === 0) {
    problems.push('predicate: a non-empty string is required');
  }
  // The question is what bytes the record will carry, not what the caller
  // passed: `value: undefined` (or a function, or a symbol) serializes to
  // nothing, so JSON would drop the key and the minted file would carry no
  // value at all — a shape verification rejects. The check answers about the
  // file on disk, which is also the only thing the verifier can see.
  if (!Object.prototype.hasOwnProperty.call(f, 'value')) {
    problems.push('value: present but unset is not a claim — supply a value, even null');
  } else {
    let serialized = null;
    try { serialized = JSON.stringify(f.value); } catch (e) { serialized = null; }
    if (serialized === undefined) {
      problems.push('value: present but unset is not a claim — supply a value, even null');
    } else if (serialized === null) {
      problems.push('value: must be JSON-serializable');
    } else {
      const bytes = Buffer.byteLength(serialized + '\n', 'utf8');
      if (bytes > EMISSION_VALUE_MAX_BYTES) problems.push('value: serialized value is ' + bytes + ' bytes, over the ' + EMISSION_VALUE_MAX_BYTES + '-byte limit');
    }
  }
  if (!TRUTH_CLASSES.includes(f.truth_class)) {
    problems.push('truth_class: must be one of ' + TRUTH_CLASSES.join('|'));
  }
  if (!isPlainObject(f.source)) {
    problems.push('source: an object with kind and ref is required');
  } else {
    if (!SOURCE_KINDS.includes(f.source.kind)) {
      problems.push('source.kind: must be one of ' + SOURCE_KINDS.join('|'));
    }
    if (typeof f.source.ref !== 'string' || f.source.ref.length === 0) {
      problems.push('source.ref: a non-empty string is required');
    }
    for (const k of Object.keys(f.source)) {
      if (k !== 'kind' && k !== 'ref') problems.push('source.' + k + ': unknown field — source carries kind and ref only');
    }
  }
  if (typeof f.observed_at !== 'string' || Number.isNaN(Date.parse(f.observed_at))) {
    problems.push('observed_at: an ISO-8601 timestamp is required');
  }
  for (const k of ['valid_at', 'expires_at']) {
    if (f[k] !== undefined && f[k] !== null && (typeof f[k] !== 'string' || Number.isNaN(Date.parse(f[k])))) {
      problems.push(k + ': an ISO-8601 timestamp or null');
    }
  }
  if (f.valid_at && f.expires_at && Date.parse(f.expires_at) < Date.parse(f.valid_at)) {
    problems.push('expires_at: before valid_at — a claim cannot expire before it becomes valid');
  }
  return problems;
}

// Lineage validation: derived evidence must name inputs that exist, are not
// itself, and do not lead back to itself. Existence is checked against the
// store on disk; cycles are checked by walking the recorded input lists, which
// is why inputs must already be sealed records before they can be cited.
function checkLineage(homeDir, inputs, selfId) {
  const problems = [];
  if (!Array.isArray(inputs)) return ['derived.inputs: an array is required'];
  const seen = new Set();
  for (const id of inputs) {
    if (typeof id !== 'string' || !isEvidenceId(id)) {
      problems.push('derived.inputs: \'' + String(id) + '\' is not an evidence id');
      continue;
    }
    if (id === selfId) {
      problems.push('derived.inputs: cites itself — a record cannot depend on its own existence');
      continue;
    }
    if (seen.has(id)) {
      problems.push('derived.inputs: names \'' + id + '\' more than once — an input set is a set');
      continue;
    }
    seen.add(id);
    if (!fs.existsSync(evidencePath(homeDir, id))) {
      problems.push('derived.inputs: no such evidence record: ' + id);
    }
  }
  if (problems.length > 0) return problems;
  // Cycle walk: from each input, follow its recorded inputs. Anything that
  // reaches back to the record being minted is a lineage cycle.
  const reachesSelf = (fromId, trail) => {
    if (fromId === selfId) return true;
    if (trail.has(fromId)) return false;
    trail.add(fromId);
    let doc;
    try { doc = JSON.parse(fs.readFileSync(evidencePath(homeDir, fromId), 'utf8')); } catch (e) { return false; }
    const next = doc && doc.derived && Array.isArray(doc.derived.inputs) ? doc.derived.inputs : [];
    for (const n of next) {
      if (reachesSelf(n, trail)) return true;
    }
    return false;
  };
  for (const id of seen) {
    if (reachesSelf(id, new Set())) {
      problems.push('derived.inputs: lineage cycle — \'' + id + '\' depends, through recorded inputs, on the record being minted');
    }
  }
  return problems;
}

// Field-shape plus lineage validation shared by direct creation and by emission
// classification: answers "could this claim be minted as a record" without
// writing anything. `selfId` is the id the record would carry, so the
// self-reference and cycle checks mean the same thing in both paths —
// classification assigns the id up front for exactly this reason.
function checkMintable(homeDir, fields, selfId) {
  const problems = validateEvidenceFields(fields);
  if (problems.length > 0) return problems;
  // Derived means one thing and one thing only: truth_class inference. A
  // non-inference record that carries inputs would mint a record the verifier
  // rejects, so the shapes must agree here rather than at read time.
  const isDerived = fields.truth_class === 'inference';
  const inputsField = fields.derived !== undefined && fields.derived !== null
    ? fields.derived.inputs : undefined;
  if (isDerived) {
    if (!Array.isArray(inputsField) || inputsField.length === 0) {
      return ['derived evidence requires inputs — an inference with nothing behind it is an assertion wearing lineage clothes'];
    }
    return checkLineage(homeDir, inputsField, selfId);
  }
  if (inputsField !== undefined && inputsField !== null) {
    if (!Array.isArray(inputsField)) return ['derived.inputs: an array is required'];
    if (inputsField.length > 0) {
      return ['derived.inputs: only inference records carry inputs — a non-inference claim stands on its source, not on other records'];
    }
  }
  return [];
}

// The producer check shared by minting and verification: the pinned manifest
// must exist, must still be the same bytes, must parse, and must have run the
// named capability. Returns problems; empty means the pin holds.
//
// Deliberately shallow — never a verifyInvocation call. At mint time the
// invocation is still minting its own emitted records, so asking "are all its
// records present" deadlocks the first mint; at any time a full call would
// recurse, because the invocation verifier checks its emitted records right
// back. Each side checks the other's bytes, and the same predicate runs at
// mint and at read, so creation never mints a pin verification rejects. The
// full health of the run stays verifyInvocation's own question — a record
// vouches for the bytes it pins, not for the chain behind them.
function checkProducerPin(homeDir, pr) {
  if (!isPlainObject(pr) ||
      typeof pr.capability_id !== 'string' || pr.capability_id.length === 0 ||
      typeof pr.capability_version !== 'string' || pr.capability_version.length === 0 ||
      typeof pr.invocation_id !== 'string' || pr.invocation_id.length === 0 ||
      typeof pr.invocation_manifest_sha256 !== 'string' ||
      !SHA256_RE.test(pr.invocation_manifest_sha256)) {
    return ['producer: must name capability_id, capability_version, invocation_id, and invocation_manifest_sha256'];
  }
  const manifestPath = path.join(homeDir, 'invocations', pr.invocation_id, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return ['producer invocation is missing: ' + pr.invocation_id];
  }
  if (sha256(fs.readFileSync(manifestPath)) !== pr.invocation_manifest_sha256) {
    return ['producer invocation changed since the record was written: ' + pr.invocation_id];
  }
  let manifested;
  try { manifested = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {
    return ['producer invocation manifest is not valid JSON: ' + pr.invocation_id];
  }
  if (manifested.capability_id !== pr.capability_id || manifested.capability_version !== pr.capability_version) {
    return ['producer names ' + pr.capability_id + ' ' + pr.capability_version + ' but the invocation ran ' + manifested.capability_id + ' ' + manifested.capability_version];
  }
  return [];
}
//
// `fields` carries subject, predicate, value, truth_class, source, observed_at
// and optionally valid_at/expires_at and derived.inputs. `producer` is null
// for a directly recorded claim, or { capability_id, capability_version,
// invocation_id, invocation_manifest_sha256 } for a claim emitted from inside
// an invocation — in which case the invocation must still verify and the
// manifest bytes must still match, because a record that pins a run pins the
// run as it was.
//
// It refuses to write anything for malformed fields, missing inputs, a
// self-reference, or a lineage cycle: an evidence record is a claim with its
// provenance attached, and there is no honest record to write when the
// provenance does not check out.
function createEvidence(homeDir, fields, opts = {}) {
  const now = opts.now || new Date();
  // The id comes first, because the mintability checks depend on it: the
  // self-reference and cycle checks answer against the id the record would
  // carry. Classification assigns the same id up front for exactly this
  // reason, so classify and mint share one predicate — checkMintable — rather
  // than two implementations of one policy that can disagree about what
  // "valid" means. (They did disagree, once: creation minted shapes the
  // verifier rejects. It cannot anymore.)
  let id = opts.evidenceId || makeEvidenceId(now);
  if (opts.evidenceId && !isEvidenceId(id)) throw new Error('bad evidence id: ' + id);

  let dir;
  for (let attempt = 0; ; attempt += 1) {
    const problems = checkMintable(homeDir, fields || {}, id);
    if (problems.length > 0) return { ok: false, error: problems.join('; ') };
    try { dir = mkdirWriteOnce(homeDir, id, { namedId: Boolean(opts.evidenceId) }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (opts.evidenceId) throw e;
      if (attempt >= 5) throw e;
      // A fresh anonymous candidate gets the full check again: the checks
      // depend on the id, so a new id means a new answer, however cheap.
      id = makeEvidenceId(now);
    }
  }
  // Past the loop the checks passed, so these shapes hold: fields is an
  // object, and an inference carries a non-empty inputs array.
  const isDerived = fields.truth_class === 'inference';
  const inputs = isDerived ? [...fields.derived.inputs] : [];

  // A record that pins an invocation pins the run as it was: the pinned
  // manifest bytes must still match, and they must have run the named
  // capability. Production checks the same shallow pin the verifier does (see
  // checkProducerPin), so creation never mints a shape verification rejects —
  // without asking the still-minting invocation for its own full health, which
  // would deadlock the first record and recurse at read time.
  let producer = null;
  const producerOpt = opts.producer === undefined ? null : opts.producer;
  if (producerOpt !== null) {
    const pinProblems = checkProducerPin(homeDir, producerOpt);
    if (pinProblems.length > 0) {
      return { ok: false, error: pinProblems.join('; ') };
    }
    producer = {
      capability_id: producerOpt.capability_id,
      capability_version: producerOpt.capability_version,
      invocation_id: producerOpt.invocation_id,
      invocation_manifest_sha256: producerOpt.invocation_manifest_sha256
    };
  }

  const doc = {
    schema: EVIDENCE_SCHEMA,
    evidence_id: id,
    subject: fields.subject,
    predicate: fields.predicate,
    value: fields.value,
    value_sha256: sha256(JSON.stringify(fields.value, null, 2) + '\n'),
    truth_class: fields.truth_class,
    source: { kind: fields.source.kind, ref: fields.source.ref },
    observed_at: fields.observed_at,
    valid_at: fields.valid_at === undefined ? null : fields.valid_at,
    expires_at: fields.expires_at === undefined ? null : fields.expires_at,
    derived: isDerived ? { inputs: [...inputs] } : { inputs: [] },
    producer,
    recorded_at: now.toISOString(),
    rcos_home: homeDir,
    created_at: new Date().toISOString()
  };
  doc.integrity = { algo: 'sha256', value: evidenceIntegrity(doc) };
  const recordPath = path.join(dir, 'evidence.json');
  fs.writeFileSync(recordPath, JSON.stringify(doc, null, 2) + '\n');
  return {
    ok: true,
    evidence_id: id,
    evidence: doc,
    dir,
    evidence_path: recordPath,
    evidence_sha256: sha256(fs.readFileSync(recordPath))
  };
}

function readEvidence(homeDir, id) {
  const p = evidencePath(homeDir, id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Deterministic and deliberately stupid, in the same sense the selection
// verifier is: it re-hashes the record, re-checks the schema and the closed
// vocabularies, re-reads every lineage input, and confirms the producer's
// invocation still verifies and still matches by bytes.
//
// It does not and cannot judge whether the claim is true, whether the source
// is trustworthy, whether a competing record is better, or whether the value
// is fresh. Those are arbitration questions for a step that does not exist
// yet, and a verifier that answered them would be a quiet resolver living
// inside the audit path.
function verifyEvidence(homeDir, id) {
  const dir = evidenceDir(homeDir, id);
  if (!fs.existsSync(dir)) return { ok: false, problems: ['evidence not found: ' + id], checked: 0 };
  const p = evidencePath(homeDir, id);
  if (!fs.existsSync(p)) return { ok: false, problems: ['evidence.json missing'], checked: 0 };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { ok: false, problems: ['evidence.json is not valid JSON: ' + e.message], checked: 0 };
  }
  const problems = [];
  if (doc.schema !== EVIDENCE_SCHEMA) problems.push('schema is not ' + EVIDENCE_SCHEMA);
  if (doc.evidence_id !== id) problems.push('evidence_id does not match its directory name');
  if (!doc.integrity || doc.integrity.algo !== 'sha256') problems.push('integrity missing or not sha256');
  else if (doc.integrity.value !== evidenceIntegrity(doc)) problems.push('evidence integrity mismatch — the record was edited after it was written');
  if (typeof doc.subject !== 'string' || doc.subject.length === 0) problems.push('subject missing');
  if (typeof doc.predicate !== 'string' || doc.predicate.length === 0) problems.push('predicate missing');
  if (!Object.prototype.hasOwnProperty.call(doc, 'value')) problems.push('value missing');
  else if (doc.value_sha256 !== sha256(JSON.stringify(doc.value, null, 2) + '\n')) {
    problems.push('value_sha256 does not match the recorded value');
  }
  if (!TRUTH_CLASSES.includes(doc.truth_class)) problems.push('unknown truth_class: ' + String(doc.truth_class));
  if (!isPlainObject(doc.source) || !SOURCE_KINDS.includes(doc.source.kind)) {
    problems.push('unknown source.kind: ' + String(doc.source && doc.source.kind));
  }
  if (!isPlainObject(doc.source) || typeof doc.source.ref !== 'string' || doc.source.ref.length === 0) {
    problems.push('source.ref missing');
  }
  if (typeof doc.observed_at !== 'string' || Number.isNaN(Date.parse(doc.observed_at))) {
    problems.push('observed_at missing or not a timestamp');
  }
  const inputs = doc.derived && Array.isArray(doc.derived.inputs) ? doc.derived.inputs : null;
  if (inputs === null) {
    problems.push('derived.inputs is not an array');
  } else {
    if (doc.truth_class === 'inference' && inputs.length === 0) {
      problems.push('an inference with no inputs cites nothing — lineage is load-bearing for derived claims');
    }
    if (doc.truth_class !== 'inference' && inputs.length > 0) {
      problems.push('a non-inference record carries inputs — only inference records derive from other records');
    }
    const seen = new Set();
    let checked = 0;
    for (const inId of inputs) {
      if (typeof inId !== 'string' || !isEvidenceId(inId)) { problems.push('derived input is not an evidence id: ' + String(inId)); continue; }
      if (inId === id) { problems.push('derived input cites itself'); continue; }
      if (seen.has(inId)) { problems.push('derived input names ' + inId + ' more than once'); continue; }
      seen.add(inId);
      const ip = evidencePath(homeDir, inId);
      if (!fs.existsSync(ip)) { problems.push('derived input is missing: ' + inId); continue; }
      let inDoc;
      try { inDoc = JSON.parse(fs.readFileSync(ip, 'utf8')); } catch (e) {
        problems.push('derived input is not valid JSON: ' + inId);
        continue;
      }
      checked += 1;
      if (inDoc.integrity && inDoc.integrity.algo === 'sha256' && inDoc.integrity.value !== evidenceIntegrity(inDoc)) {
        problems.push('derived input was edited after it was written: ' + inId);
      }
    }
    // The cycle check re-walks recorded inputs from each input, exactly as
    // creation did: a cycle smuggled in after the fact reads the same.
    const reachesSelf = (fromId, trail) => {
      if (fromId === id) return true;
      if (trail.has(fromId)) return false;
      trail.add(fromId);
      let d;
      try { d = JSON.parse(fs.readFileSync(evidencePath(homeDir, fromId), 'utf8')); } catch (e) { return false; }
      const next = d && d.derived && Array.isArray(d.derived.inputs) ? d.derived.inputs : [];
      for (const n of next) {
        if (reachesSelf(n, trail)) return true;
      }
      return false;
    };
    for (const inId of seen) {
      if (fs.existsSync(evidencePath(homeDir, inId)) && reachesSelf(inId, new Set())) {
        problems.push('lineage cycle through ' + inId + ' — the record depends on its own existence');
      }
    }
    if (doc.producer !== null && doc.producer !== undefined) {
      for (const q of checkProducerPin(homeDir, doc.producer)) problems.push(q);
    }
    const stray = fs.readdirSync(dir).filter((n) => n !== 'evidence.json');
    for (const n of stray) problems.push('artifact present but not part of an evidence record: ' + n);
    return { ok: problems.length === 0, problems, checked: checked + 1, evidence: doc };
  }
  return { ok: problems.length === 0, problems, checked: 1, evidence: doc };
}

function listEvidence(homeDir) {
  const dir = evidenceStoreDir(homeDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isEvidenceId(e.name))
    .map((e) => e.name)
    .sort()
    .map((id) => {
      const d = readEvidence(homeDir, id);
      return {
        evidence_id: id,
        subject: d ? d.subject : null,
        predicate: d ? d.predicate : null,
        truth_class: d ? d.truth_class : null,
        source: d ? d.source : null,
        observed_at: d ? d.observed_at : null,
        inputs: d && d.derived && Array.isArray(d.derived.inputs) ? d.derived.inputs.length : null,
        producer_invocation_id: d && d.producer ? d.producer.invocation_id : null,
        recorded_at: d ? d.recorded_at : null,
        dir: evidenceDir(homeDir, id)
      };
    });
}

// A bundle pins a set of evidence ids by naming them and hashing the set.
// It verifies each member and confirms the set hash, nothing more: a bundle
// never re-states a value, never ranks its members, and never resolves
// disagreements between them. Two records that contradict each other pin
// together without complaint — coexistence is legal, arbitration is later.
function createBundle(homeDir, evidenceIds, opts = {}) {
  const now = opts.now || new Date();
  if (!Array.isArray(evidenceIds)) return { ok: false, error: 'a bundle pins an array of evidence ids' };
  const seen = new Set();
  const members = [];
  for (const id of evidenceIds) {
    if (typeof id !== 'string' || !isEvidenceId(id)) {
      return { ok: false, error: 'not an evidence id: ' + String(id) };
    }
    if (seen.has(id)) {
      return { ok: false, error: 'bundle names \'' + id + '\' more than once — a bundle pins a set' };
    }
    seen.add(id);
    const v = verifyEvidence(homeDir, id);
    if (!v.ok) {
      return { ok: false, error: 'member evidence ' + id + ' does not verify: ' + v.problems.join('; ') };
    }
    const recordSha = sha256(fs.readFileSync(evidencePath(homeDir, id)));
    members.push({ evidence_id: id, evidence_sha256: recordSha });
  }
  members.sort((a, b) => a.evidence_id.localeCompare(b.evidence_id));

  let id = opts.bundleId || makeBundleId(now);
  if (opts.bundleId && !isBundleId(id)) throw new Error('bad bundle id: ' + id);
  let dir;
  for (let attempt = 0; ; attempt += 1) {
    try { dir = mkdirWriteOnce(homeDir, id, { namedId: Boolean(opts.bundleId), label: 'bundle', plural: 'bundles' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (attempt >= 5) throw e;
      id = makeBundleId(now);
    }
  }
  const doc = {
    schema: BUNDLE_SCHEMA,
    bundle_id: id,
    members,
    evidence_set_sha256: evidenceSetSha256(members),
    purpose: typeof opts.purpose === 'string' ? opts.purpose : null,
    created_at: new Date().toISOString()
  };
  if (opts.invocationId !== undefined && opts.invocationId !== null) {
    doc.consumed_by_invocation_id = opts.invocationId;
  }
  doc.integrity = { algo: 'sha256', value: bundleIntegrity(doc) };
  const bundleFile = path.join(dir, 'bundle.json');
  fs.writeFileSync(bundleFile, JSON.stringify(doc, null, 2) + '\n');
  return {
    ok: true,
    bundle_id: id,
    bundle: doc,
    dir,
    bundle_path: bundleFile,
    bundle_sha256: sha256(fs.readFileSync(bundleFile)),
    members
  };
}

function readBundle(homeDir, id) {
  const p = bundlePath(homeDir, id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function verifyBundle(homeDir, id) {
  const dir = evidenceDir(homeDir, id);
  if (!fs.existsSync(dir)) return { ok: false, problems: ['bundle not found: ' + id], checked: 0 };
  const p = bundlePath(homeDir, id);
  if (!fs.existsSync(p)) return { ok: false, problems: ['bundle.json missing'], checked: 0 };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { ok: false, problems: ['bundle.json is not valid JSON: ' + e.message], checked: 0 };
  }
  const problems = [];
  if (doc.schema !== BUNDLE_SCHEMA) problems.push('schema is not ' + BUNDLE_SCHEMA);
  if (doc.bundle_id !== id) problems.push('bundle_id does not match its directory name');
  if (!doc.integrity || doc.integrity.algo !== 'sha256') problems.push('integrity missing or not sha256');
  else if (doc.integrity.value !== bundleIntegrity(doc)) problems.push('bundle integrity mismatch — the bundle was edited after it was written');
  const members = Array.isArray(doc.members) ? doc.members : null;
  if (!members) {
    problems.push('members is not an array');
  } else {
    if (doc.evidence_set_sha256 !== evidenceSetSha256(members)) {
      problems.push('evidence_set_sha256 does not match the pinned member set');
    }
    const seen = new Set();
    let checked = 0;
    const sorted = [...members].sort((a, b) => String(a.evidence_id).localeCompare(String(b.evidence_id)));
    if (JSON.stringify(members.map((m) => m.evidence_id)) !== JSON.stringify(sorted.map((m) => m.evidence_id))) {
      problems.push('members are not in evidence_id sort order — the set hash assumes sorted order');
    }
    for (const m of members) {
      if (!isPlainObject(m) || typeof m.evidence_id !== 'string' || !isEvidenceId(m.evidence_id)) {
        problems.push('member is not a pinned evidence entry: ' + JSON.stringify(m));
        continue;
      }
      if (seen.has(m.evidence_id)) { problems.push('member names ' + m.evidence_id + ' more than once'); continue; }
      seen.add(m.evidence_id);
      const v = verifyEvidence(homeDir, m.evidence_id);
      if (!v.ok) {
        for (const q of v.problems) problems.push('member ' + m.evidence_id + ': ' + q);
        continue;
      }
      checked += 1;
      const recordSha = sha256(fs.readFileSync(evidencePath(homeDir, m.evidence_id)));
      if (recordSha !== m.evidence_sha256) {
        problems.push('member \'' + m.evidence_id + '\': evidence_sha256 does not match the record it names');
      }
    }
    const stray = fs.readdirSync(dir).filter((n) => n !== 'bundle.json');
    for (const n of stray) problems.push('artifact present but not part of a bundle: ' + n);
    return { ok: problems.length === 0, problems, checked: checked + 1, bundle: doc };
  }
  return { ok: problems.length === 0, problems, checked: 1, bundle: doc };
}

function listBundles(homeDir) {
  const dir = evidenceStoreDir(homeDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isBundleId(e.name))
    .map((e) => e.name)
    .sort()
    .map((id) => {
      const d = readBundle(homeDir, id);
      return {
        bundle_id: id,
        members: d && Array.isArray(d.members) ? d.members.map((m) => m.evidence_id) : null,
        purpose: d ? d.purpose : null,
        consumed_by_invocation_id: d ? (d.consumed_by_invocation_id || null) : null,
        created_at: d ? d.created_at : null,
        dir: evidenceDir(homeDir, id)
      };
    });
}

// ---------------------------------------------------------------------------
// The emission path: how an adapter's output becomes evidence, explicitly.
//
// Invocation output is not evidence automatically. An adapter that wants a
// claim recorded writes an emission file into $RCOS_EVIDENCE_DIR — one JSON
// object, `{ fields, producer }`, where `fields` is the claim and `producer`
// names the invocation it ran as. The kernel never reads these files itself;
// `collectEmissions` runs after the adapter exits, validates each file
// against the same rules as a direct record, and mints one evidence record
// per valid emission. An invalid emission is reported, never recorded, and
// never fails the invocation it rode along with: the run happened, the claim
// about the run did not check out, and those are two different facts.
//
// An emission file that is not valid JSON, or not an object with a `fields`
// object, is reported as malformed rather than validated — validation answers
// "is this claim well-formed", which requires a claim to answer about.
// ---------------------------------------------------------------------------

function readEmissionFile(p) {
  let raw;
  try { raw = fs.readFileSync(p); } catch (e) {
    return { ok: false, error: 'emission file is not readable: ' + e.message };
  }
  if (raw.length > EMISSION_VALUE_MAX_BYTES + 65536) {
    return { ok: false, error: 'emission file is over the size limit' };
  }
  let doc;
  try { doc = JSON.parse(raw.toString('utf8')); } catch (e) {
    return { ok: false, error: 'emission file is not valid JSON: ' + e.message };
  }
  if (!isPlainObject(doc) || !isPlainObject(doc.fields)) {
    return { ok: false, error: 'emission file must be an object with a `fields` object' };
  }
  return { ok: true, fields: doc.fields, producer: doc.producer === undefined ? null : doc.producer };
}

function listEmissionFiles(evidenceDirPath) {
  if (!fs.existsSync(evidenceDirPath)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.emission.json')) out.push(p);
    }
  };
  walk(evidenceDirPath);
  return out;
}

// Runs after the adapter exits. `invocationCtx` carries the invocation the
// emissions ran inside: { invocation_id, capability_id, capability_version,
// invocation_manifest_sha256 }. A producer block inside an emission file must
// agree with that context — an adapter can only emit evidence about the run
// it actually ran in, never about another invocation.
function collectEmissions(homeDir, evidenceDirPath, invocationCtx, opts = {}) {
  const now = opts.now || new Date();
  const minted = [];
  const skipped = [];
  const classified = classifyEmissions(homeDir, evidenceDirPath, invocationCtx, { now });
  for (const s of classified.skipped) skipped.push(s);
  for (const v of classified.valid) {
    const producer = {
      capability_id: invocationCtx.capability_id,
      capability_version: invocationCtx.capability_version,
      invocation_id: invocationCtx.invocation_id,
      invocation_manifest_sha256: invocationCtx.invocation_manifest_sha256
    };
    // The id classification checked is the id that mints: the lineage answers
    // (self-reference, cycles) mean the same thing in both halves because the
    // id never changes between them.
    const res = createEvidence(homeDir, v.fields, { now, evidenceId: v.evidence_id, producer });
    if (!res.ok) {
      skipped.push({ file: v.file, reason: res.error });
      continue;
    }
    minted.push({ file: v.file, evidence_id: res.evidence_id, evidence_sha256: res.evidence_sha256 });
  }
  return { minted, skipped };
}

// The classify half of collection, without the minting half: reads every
// emission file, reports the malformed ones, runs the full mintability check
// (fields plus lineage) against an assigned evidence id, and confirms the
// producer block (when present) names this invocation. No store writes happen
// here, which is what lets the kernel run classification before its manifest
// seals — the skipped list is known while the manifest bytes are still open —
// and mint only after the manifest hash exists to pin. The assigned id travels
// with the valid entry so minting checks the same answer creation would: the
// self-reference and cycle answers cannot drift between the two halves.
function classifyEmissions(homeDir, evidenceDirPath, invocationCtx, opts = {}) {
  const now = opts.now || new Date();
  const valid = [];
  const skipped = [];
  const files = listEmissionFiles(evidenceDirPath);
  for (const f of files) {
    const rel = path.relative(evidenceDirPath, f).split(path.sep).join('/');
    const parsed = readEmissionFile(f);
    if (!parsed.ok) {
      skipped.push({ file: rel, reason: parsed.error });
      continue;
    }
    if (parsed.producer !== null && parsed.producer !== undefined) {
      const pr = parsed.producer;
      const mismatch =
        !isPlainObject(pr) ||
        pr.invocation_id !== invocationCtx.invocation_id ||
        pr.capability_id !== invocationCtx.capability_id ||
        pr.capability_version !== invocationCtx.capability_version;
      if (mismatch) {
        skipped.push({ file: rel, reason: 'producer block does not name this invocation — an adapter emits evidence about its own run only' });
        continue;
      }
    }
    const evidenceId = makeEvidenceId(now);
    const mintProblems = checkMintable(homeDir, parsed.fields, evidenceId);
    if (mintProblems.length > 0) {
      skipped.push({ file: rel, reason: mintProblems.join('; ') });
      continue;
    }
    valid.push({ file: rel, evidence_id: evidenceId, fields: parsed.fields });
  }
  return { valid, skipped };
}

module.exports = {
  EVIDENCE_SCHEMA,
  BUNDLE_SCHEMA,
  TRUTH_CLASSES,
  SOURCE_KINDS,
  EVIDENCE_ID_RE,
  BUNDLE_ID_RE,
  EMISSION_VALUE_MAX_BYTES,
  makeEvidenceId,
  makeBundleId,
  isEvidenceId,
  isBundleId,
  evidenceStoreDir,
  evidenceDir,
  evidencePath,
  bundlePath,
  evidenceIntegrity,
  bundleIntegrity,
  evidenceSetSha256,
  validateEvidenceFields,
  checkLineage,
  checkMintable,
  checkProducerPin,
  createEvidence,
  readEvidence,
  verifyEvidence,
  listEvidence,
  createBundle,
  readBundle,
  verifyBundle,
  listBundles,
  readEmissionFile,
  listEmissionFiles,
  collectEmissions,
  classifyEmissions,
  sha256
};
