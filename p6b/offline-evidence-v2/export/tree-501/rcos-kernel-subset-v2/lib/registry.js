'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { KINDS, VERDICTS, validateRegistry, shipCount } = require('./validate');
const A = require('./adapter');
const { deriveReuseCounts } = require('./traces');

const RETIREMENT_POLICY_VERSION = 'rcos-retire/1';

function todayStr(d = new Date()) { return d.toISOString().slice(0, 10); }

function loadRegistry(homeDir) {
  const p = path.join(homeDir, 'registry', 'capability-registry.json');
  const reg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const errors = validateRegistry(reg);
  if (errors.length > 0) throw new Error('invalid registry at ' + p + ':\n- ' + errors.join('\n- '));
  return reg;
}

function saveRegistry(homeDir, reg) {
  const errors = validateRegistry(reg);
  if (errors.length > 0) throw new Error('refusing to save invalid registry:\n- ' + errors.join('\n- '));
  fs.writeFileSync(path.join(homeDir, 'registry', 'capability-registry.json'), JSON.stringify(reg, null, 2) + '\n');
}

function findCapability(reg, id) {
  const cap = reg.capabilities.find((c) => c.id === id);
  if (!cap) throw new Error('unknown capability \'' + id + '\'');
  return cap;
}

function queryCapabilities(reg, opts = {}) {
  return reg.capabilities.filter((c) =>
    (!opts.status || c.status === opts.status) && (!opts.kind || c.kind === opts.kind));
}

function proposeCapability(reg, spec) {
  if (!spec || !spec.id || !spec.name || !spec.kind) throw new Error('propose requires id, name, kind');
  if (reg.capabilities.some((c) => c.id === spec.id)) throw new Error('capability \'' + spec.id + '\' already exists');
  if (!KINDS.includes(spec.kind)) throw new Error('kind must be one of ' + KINDS.join('|'));
  const cap = {
    id: spec.id, name: spec.name, kind: spec.kind, version: spec.version || '0.1.0',
    status: 'candidate', admitted_after: [], evals: [], reuse_count: 0, last_eval: null
  };
  if (spec.lineage !== undefined) cap.lineage = spec.lineage;
  reg.capabilities.push(cap);
  return cap;
}

function submitEval(reg, id, ev) {
  const cap = findCapability(reg, id);
  if (!ev || !ev.task_id || !ev.run_id) throw new Error('eval-submit requires task_id and run_id');
  if (!VERDICTS.includes(ev.verdict)) throw new Error('verdict must be one of ' + VERDICTS.join('|'));
  const entry = { task_id: ev.task_id, verdict: ev.verdict, run_id: ev.run_id };
  // Only the eval runner sets 'executed'; everything else is an assertion by
  // definition. Legacy entries carry no field at all and read as asserted.
  entry.provenance = ev.provenance === 'executed' ? 'executed' : 'asserted';
  cap.evals.push(entry);
  cap.last_eval = ev.date || todayStr();
  return cap;
}

function promoteCapability(reg, id, date = todayStr()) {
  const cap = findCapability(reg, id);
  if (cap.status !== 'candidate') throw new Error('cannot promote \'' + id + '\': status is ' + cap.status + ', must be candidate');
  const ships = cap.evals.filter((e) => e.verdict === 'ship');
  if (ships.length < 2) throw new Error('cannot promote \'' + id + '\': x2-ship gate needs 2 shipped evals, has ' + ships.length);
  const tasks = [...new Set(ships.map((e) => e.task_id))];
  if (tasks.length < 2) {
    throw new Error('cannot promote \'' + id + '\': x2-ship gate needs 2 DISTINCT task ids — same-task repeats do not count ' +
      '(the point is transfer, not memorization); both ships are on \'' + tasks[0] + '\'');
  }
  const runless = ships.filter((e) => typeof e.run_id !== 'string' || e.run_id.trim().length === 0);
  if (runless.length > 0) {
    throw new Error('cannot promote \'' + id + '\': no run id, no admission — ship eval(s) missing run_id: ' +
      runless.map((e) => e.task_id).join(', '));
  }
  cap.status = 'promoted';
  cap.admitted_after = tasks;
  armRetirement(cap, date);
  return cap;
}

// Retirement is armed AT ADMISSION, never later: promotion without retirement
// is hoarding — the registry must shrink as well as grow. Thresholds stay null
// until pilot data calibrates them (the upstream spec says settle from pilot
// data; inventing numbers here would be a check that cannot fail).
function armRetirement(cap, date = todayStr()) {
  if (cap.retirement) return cap;
  cap.retirement = {
    armed_at: date,
    policy_version: RETIREMENT_POLICY_VERSION,
    decay: { window: 5, threshold: null },
    neglect: { n: 20, threshold: null }
  };
  return cap;
}

function retireCapability(reg, id, reason) {
  const cap = findCapability(reg, id);
  if (!reason || reason.trim().length === 0) throw new Error('cannot retire \'' + id + '\': a reason is required');
  cap.status = 'retired';
  cap.retire_reason = reason.trim();
  return cap;
}

// reuse_count is a CACHE of the trace log, not independent truth. There is no
// manual increment path: reuseDeltas() is read-only, syncDerivedReuse() is the
// single writer, and the only way to move the number is to append a trace.
function reuseDeltas(reg, traces) {
  const counts = deriveReuseCounts(traces);
  const deltas = [];
  for (const c of reg.capabilities) {
    const derived = counts[c.id] || 0;
    if (c.reuse_count !== derived) deltas.push({ id: c.id, stored: c.reuse_count, derived });
  }
  return deltas;
}

function syncDerivedReuse(reg, traces) {
  const deltas = reuseDeltas(reg, traces);
  for (const d of deltas) findCapability(reg, d.id).reuse_count = d.derived;
  return deltas;
}

function auditRegistry(reg, now = new Date(), traces = null, opts = {}) {
  const errors = validateRegistry(reg);
  const warnings = [];
  for (const c of reg.capabilities) {
    if (c.status === 'promoted' && shipCount(c) < 2) {
      errors.push('\'' + c.id + '\': promoted without x2-ship gate (' + shipCount(c) + ' ships)');
    }
    if (c.status === 'promoted') {
      const tasks = [...new Set(c.evals.filter((e) => e.verdict === 'ship').map((e) => e.task_id))];
      if (tasks.length < 2) {
        errors.push('\'' + c.id + '\': promoted without 2 distinct ship task ids (' + tasks.length + ') — same-task repeats do not count');
      }
      const runless = c.evals.filter((e) => e.verdict === 'ship' && (typeof e.run_id !== 'string' || e.run_id.trim().length === 0));
      if (runless.length > 0) {
        errors.push('\'' + c.id + '\': no run id, no admission — ship eval(s) missing run_id: ' + runless.map((e) => e.task_id).join(', '));
      }
      if (!c.retirement) errors.push('\'' + c.id + '\': promoted without retirement armed (arm at admission, never later)');
    }
    if (c.status === 'candidate' && c.evals.length === 0) {
      warnings.push('\'' + c.id + '\': candidate with zero evals');
    } else {
      const tail = c.evals.slice(-2);
      if (tail.length === 2 && tail.every((e) => e.verdict !== 'ship')) {
        const armed = c.status === 'promoted' && c.retirement ? ' (retirement armed ' + c.retirement.armed_at + ', policy ' + c.retirement.policy_version + ')' : '';
        warnings.push('\'' + c.id + '\': decaying — last 2 evals not shipped' + armed);
      }
    }
    if (c.status === 'promoted' && c.last_eval) {
      const ageDays = (now - Date.parse(c.last_eval + 'T00:00:00Z')) / 86400000;
      if (ageDays > 90) warnings.push('\'' + c.id + '\': stale — last eval ' + c.last_eval);
    }
  }
  if (traces !== null) {
    for (const d of reuseDeltas(reg, traces)) {
      warnings.push('\'' + d.id + '\': reuse cache stale — stored ' + d.stored + ', trace-derived ' + d.derived + ' (run `rcos sync`)');
    }
  }
  // Executability. A registry entry that declares no adapter is a claim RCOS
  // cannot act on; an entry that declares one pointing at nothing is a broken
  // promise. Declaration *shape* is already covered by validateRegistry above;
  // what needs the filesystem is checked here, and needs a home to check
  // against (callers that pass no home get the shape checks only).
  const homeDir = opts && opts.homeDir ? opts.homeDir : null;
  const executable = [];
  for (const c of reg.capabilities) {
    if (c.adapter === undefined) continue;
    if (A.validateAdapterDeclaration(c.adapter).length > 0) continue;
    if (homeDir) {
      const ep = A.resolveEntrypoint(homeDir, c.adapter);
      if (!fs.existsSync(ep) || !fs.statSync(ep).isFile()) {
        errors.push('\'' + c.id + '\': adapter entrypoint is missing: ' + c.adapter.entrypoint);
        continue;
      }
      try { fs.accessSync(ep, fs.constants.X_OK); } catch (e) {
        errors.push('\'' + c.id + '\': adapter entrypoint is not executable: ' + c.adapter.entrypoint);
        continue;
      }
      const contractRes = A.loadContract(homeDir, c.adapter);
      if (!contractRes.ok) {
        errors.push('\'' + c.id + '\': declared contract is malformed: ' + contractRes.errors.join('; '));
        continue;
      }
    }
    executable.push(c.id);
  }
  const total = reg.capabilities.length;
  if (total > 0) {
    warnings.push(total + ' capabilities: ' + executable.length + ' executable, ' + (total - executable.length) + ' non-executable (no runnable adapter declared)');
    const promotedNoAdapter = reg.capabilities.filter((c) => c.status === 'promoted' && !executable.includes(c.id));
    if (promotedNoAdapter.length > 0) {
      const ids = promotedNoAdapter.map((c) => c.id);
      const preview = ids.slice(0, 5).join(', ') + (ids.length > 5 ? ' (+' + (ids.length - 5) + ' more)' : '');
      warnings.push(promotedNoAdapter.length + '/' + reg.capabilities.filter((c) => c.status === 'promoted').length +
        ' promoted capabilities have no executable adapter — RCOS cannot invoke them from the registry: ' + preview +
        ' (legacy entries; no adapter or evidence is invented for them — see README)');
    }
  }
  // Provenance summary: how much of the registry rests on executed evidence
  // rather than assertion. A warning, never an error — the promoted set that
  // predates the eval runner is legitimately asserted, and nothing is
  // backfilled. The number should fall as capabilities are re-run for real.
  const promoted = reg.capabilities.filter((c) => c.status === 'promoted');
  const assertedOnly = promoted.filter((c) => c.evals.every((e) => e.provenance !== 'executed'));
  if (promoted.length > 0 && assertedOnly.length > 0) {
    warnings.push(assertedOnly.length + '/' + promoted.length + ' promoted capabilities rest entirely on asserted evals — ' +
      'no runner-backed run yet (define evals/<id>/ packages and run `rcos eval-run --eval <id> --task <t> --submit`)');
  }
  // Eligibility decisions on disk. A decision is the artifact the invocation
  // kernel consumes, so a decision that has been edited, speaks a reason code
  // outside the canonical vocabulary, or names a capability/version the
  // registry no longer holds is an error, not a curiosity. Mechanical only:
  // the audit reads decisions and never writes one.
  if (homeDir) {
    // lazy require — lib/eligibility.js requires this module
    const E = require('./eligibility');
    const decisions = E.listDecisions(homeDir);
    for (const d of decisions) {
      const p = path.join(E.decisionDir(homeDir, d.decision_id), 'decision.json');
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        errors.push('eligibility decision ' + d.decision_id + ': decision.json is not readable JSON: ' + e.message);
        continue;
      }
      if (!doc.integrity || doc.integrity.algo !== 'sha256') {
        errors.push('eligibility decision ' + d.decision_id + ': no sha256 integrity block');
      } else if (doc.integrity.value !== E.decisionIntegrity(doc)) {
        errors.push('eligibility decision ' + d.decision_id + ': integrity mismatch — the decision was edited after it was written');
      }
      for (const r of doc.reasons || []) {
        if (!E.REASON_CODES.includes(r)) errors.push('eligibility decision ' + d.decision_id + ': unknown reason code \'' + r + '\'');
      }
      if (doc.eligible === true && (doc.reasons || []).some((r) => r !== E.POSITIVE_REASON)) {
        errors.push('eligibility decision ' + d.decision_id + ': eligible:true alongside negative reasons');
      }
      const decidedCap = reg.capabilities.find((c) => c.id === doc.capability_id) || null;
      if (!decidedCap) {
        errors.push('eligibility decision ' + d.decision_id + ': references unknown capability \'' + doc.capability_id + '\'');
      } else if (doc.capability_version !== null && doc.capability_version !== undefined && doc.capability_version !== decidedCap.version) {
        errors.push('eligibility decision ' + d.decision_id + ': decided about ' + doc.capability_id + ' ' + doc.capability_version +
          ' but the registry now holds ' + decidedCap.version);
      }
    }
    // The reuse question the whole step exists to answer: which promoted
    // capabilities RCOS would actually refuse to reuse right now. One warning
    // per distinct reason set, so 20 legacy entries read as a shape rather than
    // 20 lines of noise.
    const normalCtx = E.buildContext('normal');
    const fails = [];
    for (const c of reg.capabilities) {
      if (c.status !== 'promoted') continue;
      const dec = E.decide(c, E.deriveRuntimeState(homeDir, c), Object.assign({}, normalCtx, { explicit_capability_id: c.id }));
      if (!dec.eligible) fails.push({ id: c.id, reasons: dec.reasons });
    }
    if (fails.length > 0) {
      const groups = new Map();
      for (const f of fails) {
        const k = f.reasons.join(', ');
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(f.id);
      }
      for (const [k, ids] of groups) {
        const preview = ids.slice(0, 4).join(', ') + (ids.length > 4 ? ' (+' + (ids.length - 4) + ' more)' : '');
        warnings.push(ids.length + ' promoted capability/capabilities fail default normal eligibility [' + k + ']: ' + preview);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

module.exports = {
  todayStr, loadRegistry, saveRegistry, findCapability, queryCapabilities,
  proposeCapability, submitEval, promoteCapability, retireCapability, armRetirement,
  reuseDeltas, syncDerivedReuse, auditRegistry, RETIREMENT_POLICY_VERSION
};
