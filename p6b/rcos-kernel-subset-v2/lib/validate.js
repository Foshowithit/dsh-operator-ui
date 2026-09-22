'use strict';

const STATUSES = ['promoted', 'candidate', 'retired'];
const KINDS = ['script', 'prompt-template', 'agent-team', 'model-node', 'workflow', 'skill', 'subagent', 'runbook', 'automation'];
const VERDICTS = ['ship', 'fix', 'blocked'];
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RETIREMENT_POLICY_VERSIONS = ['rcos-retire/1'];
const A = require('./adapter');
// How an eval entry came to exist. 'executed' = the RCOS eval runner produced
// it from a run directory; 'asserted' = a human or agent claimed it. Absent
// means asserted (every eval submitted before the runner existed). Nothing is
// backfilled: an assertion stays an assertion until it is re-run.
const PROVENANCES = ['executed', 'asserted'];

function isStr(v) { return typeof v === 'string'; }

function isValidDate(s) {
  return isStr(s) && DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

function validateEval(e, path, errors) {
  if (typeof e !== 'object' || e === null) { errors.push(path + ': must be an object'); return; }
  if (!isStr(e.task_id) || e.task_id.length === 0) errors.push(path + '.task_id: required non-empty string');
  if (!VERDICTS.includes(e.verdict)) errors.push(path + '.verdict: must be one of ' + VERDICTS.join('|'));
  if (!isStr(e.run_id) || e.run_id.length === 0) errors.push(path + '.run_id: required non-empty string');
  if (e.provenance !== undefined && !PROVENANCES.includes(e.provenance)) {
    errors.push(path + '.provenance: must be one of ' + PROVENANCES.join('|') + ' when present');
  }
}

// Retirement is armed at admission, never later, so a promoted capability
// always carries the policy it will be judged against. Thresholds are allowed
// to be null on purpose: the upstream spec says settle from pilot data, and a
// number invented before the pilot is a check that cannot fail.
function validateRetirement(r, path, errors) {
  if (typeof r !== 'object' || r === null) { errors.push(path + ': must be an object'); return; }
  if (!isValidDate(r.armed_at)) errors.push(path + '.armed_at: must be YYYY-MM-DD');
  if (!RETIREMENT_POLICY_VERSIONS.includes(r.policy_version)) {
    errors.push(path + '.policy_version: must be one of ' + RETIREMENT_POLICY_VERSIONS.join('|'));
  }
  const d = r.decay;
  if (typeof d !== 'object' || d === null) errors.push(path + '.decay: must be an object');
  else {
    if (!Number.isInteger(d.window) || d.window < 1) errors.push(path + '.decay.window: must be integer >= 1');
    if (!(d.threshold === null || typeof d.threshold === 'number')) errors.push(path + '.decay.threshold: must be null or number');
  }
  const n = r.neglect;
  if (typeof n !== 'object' || n === null) errors.push(path + '.neglect: must be an object');
  else {
    if (!Number.isInteger(n.n) || n.n < 1) errors.push(path + '.neglect.n: must be integer >= 1');
    if (!(n.threshold === null || typeof n.threshold === 'number')) errors.push(path + '.neglect.threshold: must be null or number');
  }
}

function validateCapability(c, path, errors) {
  if (typeof c !== 'object' || c === null) { errors.push(path + ': must be an object'); return; }
  if (!isStr(c.id) || !ID_RE.test(c.id)) errors.push(path + '.id: must match ' + ID_RE);
  if (!isStr(c.name) || c.name.length === 0) errors.push(path + '.name: required non-empty string');
  if (!KINDS.includes(c.kind)) errors.push(path + '.kind: must be one of ' + KINDS.join('|'));
  if (!isStr(c.version) || !VERSION_RE.test(c.version)) errors.push(path + '.version: must be semver x.y.z');
  if (!STATUSES.includes(c.status)) errors.push(path + '.status: must be one of ' + STATUSES.join('|'));
  if (!Array.isArray(c.admitted_after) || !c.admitted_after.every(isStr)) errors.push(path + '.admitted_after: must be string[]');
  if (!Array.isArray(c.evals)) { errors.push(path + '.evals: must be an array'); }
  else c.evals.forEach((e, i) => validateEval(e, path + '.evals[' + i + ']', errors));
  if (!Number.isInteger(c.reuse_count) || c.reuse_count < 0) errors.push(path + '.reuse_count: must be integer >= 0');
  if (!(c.last_eval === null || isValidDate(c.last_eval))) errors.push(path + '.last_eval: must be null or YYYY-MM-DD');
  if (c.lineage !== undefined && !isStr(c.lineage)) errors.push(path + '.lineage: must be a string when present');
  if (c.adapter !== undefined) {
    A.validateAdapterDeclaration(c.adapter).forEach((e) => errors.push(path + '.' + e));
  }
  if (c.status === 'retired' && (!isStr(c.retire_reason) || c.retire_reason.length === 0)) errors.push(path + '.retire_reason: required when status is retired');
  if (c.status === 'promoted' && c.retirement === undefined) {
    errors.push(path + '.retirement: required when status is promoted (arm at admission, never later)');
  } else if (c.retirement !== undefined) {
    validateRetirement(c.retirement, path + '.retirement', errors);
  }
}

function shipCount(c) { return c.evals.filter((e) => e.verdict === 'ship').length; }

function validateRegistry(reg) {
  if (typeof reg !== 'object' || reg === null) return ['registry: must be an object'];
  const errors = [];
  if (!isStr(reg.registry_version) || reg.registry_version.length === 0) errors.push('registry_version: required non-empty string');
  if (!Array.isArray(reg.capabilities)) { errors.push('capabilities: must be an array'); return errors; }
  const seen = new Set();
  reg.capabilities.forEach((c, i) => {
    validateCapability(c, 'capabilities[' + i + ']', errors);
    if (c && isStr(c.id)) {
      if (seen.has(c.id)) errors.push('capabilities[' + i + '].id: duplicate id \'' + c.id + '\'');
      seen.add(c.id);
    }
  });
  return errors;
}

module.exports = {
  STATUSES, KINDS, VERDICTS, PROVENANCES, RETIREMENT_POLICY_VERSIONS,
  validateRegistry, validateCapability, validateRetirement, shipCount, isValidDate
};
