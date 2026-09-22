'use strict';
// Evidence admission: the deterministic, consumer-scoped gate that answers one
// narrow question — "may THIS consumer, for THIS purpose, rely on THIS
// evidence record, given what the record is and where it came from?"
//
// Invariant this file exists to hold:
//   Admission decides admissibility for a stated consumer policy.
//   It never decides truth, never rewrites evidence, never grants authority.
//
// It is deliberately the smallest possible step beyond the evidence envelope
// (lib/evidence.js), and it borrows that file's discipline wholesale:
//
//   Integrity is not truth.          A hash-verified record can still be wrong.
//   Provenance is not authority.     A producer pin says who ran, not who is right.
//   External evidence stays external. producer: null cannot pass an
//                                    executed-only policy by passing the hasher.
//   Inference is not source material. A derived claim keeps its lineage, and a
//                                    consumer may demand better than inference.
//   Conflict coexists.                A verified contradiction is reported
//                                    UNRESOLVED — never arbitrated, never newest-wins.
//   Unknown is not false.             A missing record is UNRESOLVED, not rejected.
//
// The shape, per the frozen contract (docs/2026-09-19-step61-admission-freeze.md):
//
//   evidence record / bundle
//     → integrity + schema verification      (lib/evidence.js verify*)
//     → source + lineage checks              (external rule, lineage walk)
//     → consumer-specific admission policy   (closed vocabulary, no defaults)
//     → ADMIT / REJECT / UNRESOLVED          (deterministic, reason-coded)
//     → separate write-once admission receipt  (rcos-evidence-admission/1)
//
// The pipeline is fixed and the inputs are closed: a policy may say which
// truth classes it relies on and whether externally sourced records are
// permitted, and nothing else. Admission has no vocabulary for "correct", no
// confidence, no freshness window, no source ranking, and no authority
// hierarchy — every one of those is a governance question this file refuses
// to answer by existing. An admission decision does not touch the evidence
// store, the registry, selections, invocations, or reuse counts; it is a
// receipt a later consumer may read, and nothing more.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EV = require('./evidence');

const ADMISSION_SCHEMA = 'rcos-evidence-admission/1';
const ADMISSION_ID_RE = /^adm_\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const ADMISSION_STORE = 'evidence-admissions';
const RESULTS = ['ADMIT', 'REJECT', 'UNRESOLVED'];
const EXTERNAL_SOURCES = ['forbidden', 'permitted'];
// Closed and sorted, like every other vocabulary in this home. A reason code
// is a fact about why the pipeline landed where it landed — never a judgment
// about which claim is true.
const REASON_CODES = [
  'CONFLICT_UNRESOLVED',
  'EXTERNAL_SOURCE_FORBIDDEN',
  'EXTERNAL_SOURCE_PERMITTED',
  'INTEGRITY_FAILED',
  'LINEAGE_CYCLE',
  'LINEAGE_SOURCE_MISSING',
  'POLICY_SATISFIED',
  'TRUTH_CLASS_NOT_PERMITTED'
];

function sha256(buf) { return EV.sha256(buf); }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function makeAdmissionId(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return 'adm_' + iso + '-' + crypto.randomBytes(3).toString('hex');
}

function isAdmissionId(id) { return ADMISSION_ID_RE.test(String(id)); }

function admissionStoreDir(homeDir) { return path.join(homeDir, ADMISSION_STORE); }
function admissionDir(homeDir, id) { return path.join(admissionStoreDir(homeDir), id); }
function admissionPath(homeDir, id) { return path.join(admissionDir(homeDir, id), 'admission.json'); }

// Self-integrity, same formula as every other receipt in this home: the
// document hashes itself with the integrity field stripped, so an edited
// decision is detectable without trusting the file's own contents.
function admissionIntegrity(doc) {
  const { integrity, ...rest } = doc;
  return sha256(JSON.stringify(rest, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Input validation. The policy is a consumer's stated reliance terms, and the
// vocabulary is closed: unknown fields are refused and nothing is defaulted,
// because a default is admission silently deciding for the consumer.
// ---------------------------------------------------------------------------

function validatePolicy(policy) {
  if (!isPlainObject(policy)) return { ok: false, error: 'policy is not an object' };
  const allowed = ['policy_id', 'policy_version', 'external_sources', 'truth_classes'];
  for (const k of Object.keys(policy)) {
    if (!allowed.includes(k)) return { ok: false, error: 'unknown policy field: ' + k + ' — the policy vocabulary is closed' };
  }
  for (const k of allowed) {
    if (!(k in policy)) return { ok: false, error: 'policy field missing: ' + k + ' — admission invents no defaults' };
  }
  if (typeof policy.policy_id !== 'string' || policy.policy_id.length === 0) {
    return { ok: false, error: 'policy_id must be a non-empty string' };
  }
  if (typeof policy.policy_version !== 'string' || policy.policy_version.length === 0) {
    return { ok: false, error: 'policy_version must be a non-empty string' };
  }
  if (!EXTERNAL_SOURCES.includes(policy.external_sources)) {
    return { ok: false, error: 'external_sources must be one of: ' + EXTERNAL_SOURCES.join(', ') };
  }
  if (!Array.isArray(policy.truth_classes) || policy.truth_classes.length === 0) {
    return { ok: false, error: 'truth_classes must be a non-empty array — admission invents no defaults' };
  }
  for (const t of policy.truth_classes) {
    if (!EV.TRUTH_CLASSES.includes(t)) {
      return { ok: false, error: 'unknown truth_class in policy: ' + String(t) };
    }
  }
  if (new Set(policy.truth_classes).size !== policy.truth_classes.length) {
    return { ok: false, error: 'truth_classes names a class more than once' };
  }
  return { ok: true, policy };
}

function validateConsumer(consumer) {
  if (!isPlainObject(consumer)) return { ok: false, error: 'consumer is not an object' };
  for (const k of Object.keys(consumer)) {
    if (k !== 'name' && k !== 'purpose') return { ok: false, error: 'unknown consumer field: ' + k };
  }
  if (typeof consumer.name !== 'string' || consumer.name.length === 0) {
    return { ok: false, error: 'consumer.name must be a non-empty string' };
  }
  if (typeof consumer.purpose !== 'string' || consumer.purpose.length === 0) {
    return { ok: false, error: 'consumer.purpose must be a non-empty string — the decision must say what it was for' };
  }
  return { ok: true, consumer };
}

function validateTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { ok: false, error: 'targets must be a non-empty array of {kind, id}' };
  }
  const seen = new Set();
  for (const t of targets) {
    if (!isPlainObject(t)) return { ok: false, error: 'target is not an object: ' + JSON.stringify(t) };
    for (const k of Object.keys(t)) {
      if (k !== 'kind' && k !== 'id') return { ok: false, error: 'unknown target field: ' + k };
    }
    if (t.kind !== 'evidence' && t.kind !== 'bundle') {
      return { ok: false, error: 'target kind must be evidence or bundle: ' + String(t.kind) };
    }
    const shaped = t.kind === 'evidence' ? EV.isEvidenceId(t.id) : EV.isBundleId(t.id);
    if (!shaped) return { ok: false, error: 'not a ' + t.kind + ' id: ' + String(t.id) };
    const key = t.kind + ':' + t.id;
    if (seen.has(key)) return { ok: false, error: 'target names ' + key + ' more than once' };
    seen.add(key);
  }
  return { ok: true, targets };
}

// ---------------------------------------------------------------------------
// Fault classification. lib/evidence.js reports problems as strings; the
// admission pipeline maps them onto the closed reason codes. A record whose
// problems are ALL "the cited material is not there" is an unknown, not a
// rejection (invariant: unknown is not false). A cycle is a structural
// rejection. Everything else — edited bytes, bad schema, unreadable JSON,
// stray artifacts — is an integrity failure.
// ---------------------------------------------------------------------------

function isMissingFlavor(p) {
  return /^evidence not found: /.test(p) || /^derived input is missing: /.test(p);
}

function problemsToCode(problems) {
  if (problems.length > 0 && problems.every(isMissingFlavor)) return 'LINEAGE_SOURCE_MISSING';
  if (problems.some((p) => /lineage cycle through /.test(p))) return 'LINEAGE_CYCLE';
  return 'INTEGRITY_FAILED';
}

function codeOutcome(code) {
  if (code === 'LINEAGE_SOURCE_MISSING' || code === 'CONFLICT_UNRESOLVED') return 'UNRESOLVED';
  if (code === 'POLICY_SATISFIED' || code === 'EXTERNAL_SOURCE_PERMITTED') return 'ADMIT';
  return 'REJECT';
}

// Row level: a known fault is never reported as unknown, so REJECT outranks
// UNRESOLVED here. (The set-level precedence is a separate, committed rule —
// see evaluateAdmission.)
function rowOutcome(codes) {
  const outcomes = [...codes].map(codeOutcome);
  if (outcomes.includes('REJECT')) return 'REJECT';
  if (outcomes.includes('UNRESOLVED')) return 'UNRESOLVED';
  return 'ADMIT';
}

// Set level, exactly as frozen: any UNRESOLVED makes the whole decision
// UNRESOLVED — a conflict anywhere is not drowned by a rejection elsewhere.
function setResult(codes) {
  const outcomes = [...codes].map(codeOutcome);
  if (outcomes.includes('UNRESOLVED')) return 'UNRESOLVED';
  if (outcomes.includes('REJECT')) return 'REJECT';
  return 'ADMIT';
}

// ---------------------------------------------------------------------------
// The lineage walk. For every record admission evaluates, the records it
// (transitively) derives from are pinned into the decision: exists, bytes,
// verified, and whether RCOS produced them. The walk reads; it never writes
// and never judges the claims themselves.
// ---------------------------------------------------------------------------

function producerClass(doc) {
  if (!doc) return null;
  return doc.producer == null ? 'external' : 'rcos';
}

function evaluateAdmission(home, request, opts = {}) {
  if (!isPlainObject(request)) return { ok: false, error: 'request is not an object' };
  const pv = validatePolicy(request.policy);
  if (!pv.ok) return { ok: false, error: pv.error };
  const cv = validateConsumer(request.consumer);
  if (!cv.ok) return { ok: false, error: cv.error };
  const tv = validateTargets(request.targets);
  if (!tv.ok) return { ok: false, error: tv.error };

  const now = opts.now || new Date();
  const policy = pv.policy;
  const verifyCache = new Map();   // evidence id → verifyEvidence result
  const lineage = new Map();       // evidence id → lineage entry

  const verifyRecord = (id) => {
    if (!verifyCache.has(id)) verifyCache.set(id, EV.verifyEvidence(home, id));
    return verifyCache.get(id);
  };

  // Walk one root's transitive inputs, registering lineage entries and
  // returning the codes the root inherits from what the walk finds. A root
  // that fails verification contributes no lineage: its own fault already
  // decides the row, and its bytes are not trustworthy enough to walk.
  const walkLineage = (rootId) => {
    const inherited = new Set();
    const rootVerify = verifyRecord(rootId);
    if (!rootVerify.ok) return inherited;
    const seen = new Set([rootId]);
    const queue = [...docInputs(rootVerify.evidence)];
    while (queue.length > 0) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const v = verifyRecord(id);
      const exists = fs.existsSync(EV.evidencePath(home, id));
      if (!lineage.has(id)) {
        lineage.set(id, {
          id,
          exists,
          sha256: exists ? sha256(fs.readFileSync(EV.evidencePath(home, id))) : null,
          verified: v.ok,
          producer_class: exists ? producerClass(v.evidence) : null
        });
      }
      if (!exists) { inherited.add('LINEAGE_SOURCE_MISSING'); continue; }
      if (!v.ok) {
        // The root's basis contains a record that is itself broken: propagate
        // the same classification the record would earn on its own.
        inherited.add(problemsToCode(v.problems));
        continue;
      }
      if (producerClass(v.evidence) === 'external' && policy.external_sources === 'forbidden') {
        // Strict external rule: an executed-only policy reaches through the
        // whole lineage. An inference rooted in an externally supplied record
        // is not RCOS-executed evidence either.
        inherited.add('EXTERNAL_SOURCE_FORBIDDEN');
      }
      queue.push(...docInputs(v.evidence));
    }
    return inherited;
  };

  function docInputs(doc) {
    return doc && doc.derived && Array.isArray(doc.derived.inputs) ? doc.derived.inputs : [];
  }

  // One evidence record against the policy. `member` marks rows computed for
  // a bundle's members, which are evaluated exactly like named targets.
  const evaluateRecord = (id) => {
    const row = {
      kind: 'evidence',
      id,
      sha256: null,
      verified: false,
      verify_problems: [],
      outcome: null,
      reason_codes: []
    };
    const storePath = EV.evidencePath(home, id);
    const exists = fs.existsSync(storePath);
    const v = verifyRecord(id);
    if (!exists) {
      // Absent record: unknown, not false. The policy is never consulted
      // about a record that is not there.
      row.verify_problems = [...v.problems];
      row.reason_codes = ['LINEAGE_SOURCE_MISSING'];
      row.outcome = 'UNRESOLVED';
      return row;
    }
    row.sha256 = sha256(fs.readFileSync(storePath));
    row.verified = v.ok;
    row.verify_problems = [...v.problems];
    const codes = new Set();
    if (!v.ok) {
      codes.add(problemsToCode(row.verify_problems));
    } else {
      const doc = v.evidence;
      if (doc.producer == null) {
        // producer: null is an honestly external record — the policy says
        // whether such records may be relied on, and the answer is recorded,
        // never hidden: permitted-external stays visible in the codes even
        // when the record is admitted.
        codes.add(policy.external_sources === 'forbidden' ? 'EXTERNAL_SOURCE_FORBIDDEN' : 'EXTERNAL_SOURCE_PERMITTED');
      }
      if (!policy.truth_classes.includes(doc.truth_class)) {
        // The consumer demanded better material than this record offers.
        codes.add('TRUTH_CLASS_NOT_PERMITTED');
      }
      if (codes.size === 0) codes.add('POLICY_SATISFIED');
      for (const c of walkLineage(id)) codes.add(c);
    }
    row.reason_codes = [...codes].sort();
    row.outcome = rowOutcome(codes);
    return row;
  };

  // One bundle: verify the pin, then evaluate every member as a full record.
  // The bundle object itself has no producer and no truth class, so the
  // policy never applies to it — the bundle's own row only carries what its
  // verification and its members earn.
  const evaluateBundle = (id) => {
    const row = {
      kind: 'bundle',
      id,
      sha256: null,
      verified: false,
      verify_problems: [],
      members: [],
      outcome: null,
      reason_codes: []
    };
    const storePath = EV.bundlePath(home, id);
    const exists = fs.existsSync(storePath);
    const b = EV.verifyBundle(home, id);
    const outcomes = [];
    const codes = new Set();
    if (!exists) {
      row.verify_problems = [...b.problems];
      codes.add('LINEAGE_SOURCE_MISSING');
      row.reason_codes = [...codes].sort();
      row.outcome = 'UNRESOLVED';
      return row;
    }
    row.sha256 = sha256(fs.readFileSync(storePath));
    row.verified = b.ok;
    row.verify_problems = [...b.problems];
    if (!b.ok) codes.add(problemsToCode(row.verify_problems));
    else codes.add('POLICY_SATISFIED');
    outcomes.push(rowOutcome(codes));
    if (b.bundle && Array.isArray(b.bundle.members)) {
      for (const m of b.bundle.members) {
        // A member whose pinned hash no longer matches the store bytes is an
        // integrity failure on the bundle row's own terms — checked here even
        // when the member record happens to verify, because the bundle's
        // promise is about these exact bytes.
        const memberRow = evaluateRecord(m.evidence_id);
        const memberPath = EV.evidencePath(home, m.evidence_id);
        if (fs.existsSync(memberPath) && sha256(fs.readFileSync(memberPath)) !== m.evidence_sha256) {
          const pinProblem = 'member \'' + m.evidence_id + '\': evidence_sha256 does not match the record it names';
          if (!memberRow.verify_problems.includes(pinProblem)) memberRow.verify_problems.push(pinProblem);
          if (!memberRow.reason_codes.includes('INTEGRITY_FAILED')) memberRow.reason_codes.push('INTEGRITY_FAILED');
          memberRow.reason_codes.sort();
          memberRow.verified = false;
          memberRow.outcome = 'REJECT';
        }
        row.members.push(memberRow);
        for (const c of memberRow.reason_codes) codes.add(c);
        outcomes.push(memberRow.outcome);
      }
    }
    row.reason_codes = [...codes].sort();
    row.outcome = outcomes.includes('REJECT') ? 'REJECT'
      : outcomes.includes('UNRESOLVED') ? 'UNRESOLVED' : 'ADMIT';
    return row;
  };

  // -- Pipeline. The order is fixed by the frozen contract. --
  // (1) integrity + schema verification and (2) source + lineage checks and
  // (3) policy evaluation happen inside each row evaluation; (4) the conflict
  // scan runs across every evaluated record; (5) the result and receipt
  // follow.
  const rows = tv.targets.map((t) => (t.kind === 'bundle' ? evaluateBundle(t.id) : evaluateRecord(t.id)));

  // (4) Conflict scan: verified records only — a tampered record's claims are
  // not reliable grounds for declaring a contradiction, and its own row is
  // already REJECT. Lineage inputs are scanned too? No: the frozen scope is
  // named targets and bundle members. A conflict between a target and a
  // record it merely derives from is the target's lineage business, and
  // arbitration is not admission's business at all — coexistence is reported,
  // never resolved.
  const evaluated = new Map();
  for (const r of rows) {
    if (r.kind === 'evidence' && r.verified) evaluated.set(r.id, verifyRecord(r.id).evidence);
    for (const m of r.members || []) {
      if (m.verified && !evaluated.has(m.id)) evaluated.set(m.id, verifyRecord(m.id).evidence);
    }
  }
  const groups = new Map();
  for (const id of [...evaluated.keys()].sort()) {
    const doc = evaluated.get(id);
    const key = JSON.stringify([doc.subject, doc.predicate]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id, subject: doc.subject, predicate: doc.predicate, value_sha256: doc.value_sha256 });
  }
  const conflicts = [];
  for (const key of [...groups.keys()].sort()) {
    const recs = groups.get(key);
    for (let i = 0; i < recs.length; i += 1) {
      for (let j = i + 1; j < recs.length; j += 1) {
        if (recs[i].value_sha256 !== recs[j].value_sha256) {
          const [a, b] = [recs[i], recs[j]].sort((x, y) => x.id.localeCompare(y.id));
          conflicts.push({
            a: a.id,
            b: b.id,
            subject: a.subject,
            predicate: a.predicate,
            value_sha256_a: a.value_sha256,
            value_sha256_b: b.value_sha256
          });
        }
      }
    }
  }
  conflicts.sort((x, y) =>
    x.subject.localeCompare(y.subject) || x.predicate.localeCompare(y.predicate) ||
    x.a.localeCompare(y.a) || x.b.localeCompare(y.b));

  const setCodes = new Set();
  for (const r of rows) for (const c of r.reason_codes) setCodes.add(c);
  if (conflicts.length > 0) setCodes.add('CONFLICT_UNRESOLVED');

  const evaluation = {
    consumer: { name: cv.consumer.name, purpose: cv.consumer.purpose },
    policy: pv.policy,
    targets: rows,
    conflicts,
    lineage: [...lineage.values()].sort((a, b) => a.id.localeCompare(b.id)),
    result: setResult(setCodes),
    reason_codes: [...setCodes].sort(),
    recorded_at: now.toISOString()
  };
  return { ok: true, evaluation };
}

// ---------------------------------------------------------------------------
// The receipt. Write-once: the id directory is created non-recursively so
// EEXIST stays the collision signal, and a named id that already exists is a
// refusal, never a rewrite.
// ---------------------------------------------------------------------------

function createAdmission(home, request, opts = {}) {
  const evaluated = evaluateAdmission(home, request, opts);
  if (!evaluated.ok) return evaluated;
  const now = opts.now || new Date();
  let id = opts.admissionId || makeAdmissionId(now);
  if (opts.admissionId && !isAdmissionId(id)) throw new Error('bad admission id: ' + id);

  const storeDir = admissionStoreDir(home);
  fs.mkdirSync(storeDir, { recursive: true });
  let dir = admissionDir(home, id);
  try {
    // Non-recursive on purpose: EEXIST on the leaf is the collision signal,
    // and mkdirSync returns nothing useful here — the path is built by hand.
    fs.mkdirSync(dir, { recursive: false });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (opts.admissionId) {
      return { ok: false, error: 'decisions are write-once: ' + id + ' already exists' };
    }
    let attempt = 0;
    for (;;) {
      attempt += 1;
      if (attempt > 5) throw e;
      id = makeAdmissionId(now);
      dir = admissionDir(home, id);
      try { fs.mkdirSync(dir, { recursive: false }); break; } catch (e2) {
        if (e2.code !== 'EEXIST') throw e2;
      }
    }
  }

  const doc = {
    schema: ADMISSION_SCHEMA,
    admission_id: id,
    consumer: evaluated.evaluation.consumer,
    policy: evaluated.evaluation.policy,
    targets: evaluated.evaluation.targets,
    conflicts: evaluated.evaluation.conflicts,
    lineage: evaluated.evaluation.lineage,
    result: evaluated.evaluation.result,
    reason_codes: evaluated.evaluation.reason_codes,
    recorded_at: evaluated.evaluation.recorded_at,
    rcos_home: home,
    created_at: now.toISOString()
  };
  doc.integrity = { algo: 'sha256', value: admissionIntegrity(doc) };
  const admissionFile = path.join(dir, 'admission.json');
  fs.writeFileSync(admissionFile, JSON.stringify(doc, null, 2) + '\n');
  return {
    ok: true,
    admission_id: id,
    admission: doc,
    dir,
    admission_path: admissionFile,
    admission_sha256: sha256(fs.readFileSync(admissionFile))
  };
}

// ---------------------------------------------------------------------------
// Re-verification. This deliberately does NOT re-run the policy: the decision
// is frozen, and re-deciding it later would be arbitration through the back
// door. What it checks instead is that the decision still holds — its own
// hash, its shape, its embedded policy, and every hash it pinned against the
// bytes actually in the stores right now. Drift is reported, never absorbed.
// ---------------------------------------------------------------------------

function verifyAdmission(home, id) {
  const dir = admissionDir(home, id);
  if (!fs.existsSync(dir)) return { ok: false, problems: ['admission not found: ' + id], checked: 0 };
  const p = admissionPath(home, id);
  if (!fs.existsSync(p)) return { ok: false, problems: ['admission.json missing'], checked: 0 };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { ok: false, problems: ['admission.json is not valid JSON: ' + e.message], checked: 0 };
  }
  const problems = [];
  let checked = 0;
  if (doc.schema !== ADMISSION_SCHEMA) problems.push('schema is not ' + ADMISSION_SCHEMA);
  if (doc.admission_id !== id) problems.push('admission_id does not match its directory name');
  if (!doc.integrity || doc.integrity.algo !== 'sha256') problems.push('integrity missing or not sha256');
  else if (doc.integrity.value !== admissionIntegrity(doc)) problems.push('admission integrity mismatch — the decision was edited after it was written');
  checked += 1;
  if (!RESULTS.includes(doc.result)) problems.push('unknown result: ' + String(doc.result));
  if (!Array.isArray(doc.reason_codes)) problems.push('reason_codes is not an array');
  else {
    for (const c of doc.reason_codes) {
      if (!REASON_CODES.includes(c)) problems.push('unknown reason code: ' + String(c));
    }
    if (JSON.stringify(doc.reason_codes) !== JSON.stringify([...doc.reason_codes].sort())) {
      problems.push('reason_codes are not in sort order');
    }
  }
  const pv = validatePolicy(doc.policy);
  if (!pv.ok) problems.push('embedded policy no longer validates: ' + pv.error);
  const cv = validateConsumer(doc.consumer);
  if (!cv.ok) problems.push('embedded consumer no longer validates: ' + cv.error);

  // Drift: every pinned hash against the bytes in the stores right now.
  const pinDrift = (label, storePath, pinned) => {
    const exists = fs.existsSync(storePath);
    if (pinned === null) {
      if (exists) problems.push(label + ' was absent at decision time but exists now');
      return;
    }
    if (!exists) { problems.push(label + ' pinned bytes are gone: ' + storePath); return; }
    const current = sha256(fs.readFileSync(storePath));
    if (current !== pinned) problems.push(label + ' pinned sha256 no longer matches the store bytes');
  };
  if (Array.isArray(doc.targets)) {
    for (const t of doc.targets) {
      checked += 1;
      if (!isPlainObject(t) || (t.kind !== 'evidence' && t.kind !== 'bundle')) {
        problems.push('target row is not a pinned entry: ' + JSON.stringify(t));
        continue;
      }
      const storePath = t.kind === 'evidence' ? EV.evidencePath(home, t.id) : EV.bundlePath(home, t.id);
      pinDrift('target ' + t.kind + ' ' + t.id + ':', storePath, t.sha256 === undefined ? null : t.sha256);
      if (t.kind === 'bundle' && Array.isArray(t.members)) {
        for (const m of t.members) {
          checked += 1;
          if (!isPlainObject(m) || typeof m.id !== 'string') {
            problems.push('bundle member row is not a pinned entry: ' + JSON.stringify(m));
            continue;
          }
          pinDrift('member ' + m.id + ':', EV.evidencePath(home, m.id), m.sha256 === undefined ? null : m.sha256);
        }
      }
    }
  } else {
    problems.push('targets is not an array');
  }
  if (Array.isArray(doc.lineage)) {
    for (const l of doc.lineage) {
      checked += 1;
      if (!isPlainObject(l) || typeof l.id !== 'string') {
        problems.push('lineage row is not a pinned entry: ' + JSON.stringify(l));
        continue;
      }
      pinDrift('lineage ' + l.id + ':', EV.evidencePath(home, l.id), l.sha256 === undefined ? null : l.sha256);
    }
  } else {
    problems.push('lineage is not an array');
  }
  const stray = fs.readdirSync(dir).filter((n) => n !== 'admission.json');
  for (const n of stray) problems.push('artifact present but not part of an admission: ' + n);
  return { ok: problems.length === 0, problems, checked, admission: doc };
}

function listAdmissions(home) {
  const dir = admissionStoreDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isAdmissionId(e.name))
    .map((e) => e.name)
    .sort()
    .map((id) => {
      const raw = fs.existsSync(admissionPath(home, id)) ? JSON.parse(fs.readFileSync(admissionPath(home, id), 'utf8')) : null;
      return {
        admission_id: id,
        result: raw ? raw.result : null,
        consumer_name: raw && raw.consumer ? raw.consumer.name : null,
        purpose: raw && raw.consumer ? raw.consumer.purpose : null,
        policy_id: raw && raw.policy ? raw.policy.policy_id : null,
        policy_version: raw && raw.policy ? raw.policy.policy_version : null,
        recorded_at: raw ? raw.recorded_at : null,
        dir: admissionDir(home, id)
      };
    });
}

module.exports = {
  ADMISSION_SCHEMA,
  ADMISSION_ID_RE,
  ADMISSION_STORE,
  RESULTS,
  EXTERNAL_SOURCES,
  REASON_CODES,
  makeAdmissionId,
  isAdmissionId,
  admissionStoreDir,
  admissionDir,
  admissionPath,
  admissionIntegrity,
  validatePolicy,
  validateConsumer,
  validateTargets,
  problemsToCode,
  evaluateAdmission,
  createAdmission,
  verifyAdmission,
  listAdmissions
};
