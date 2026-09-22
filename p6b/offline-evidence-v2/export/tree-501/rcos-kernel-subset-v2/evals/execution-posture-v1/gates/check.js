#!/usr/bin/env node
'use strict';
// Gates for execution-posture-v1 (rcos-eval/1). The adapter recorded
// posture.json in the run work dir (this gate's cwd); the gates re-judge it
// against the live process identity they run under, prove both branches of the
// requirement evaluator with injected postures (deterministic regardless of
// the uid this evaluation itself runs as), refuse a complete-sandbox claim
// outright, and evaluate the LIVE non-root requirement — a root runtime
// refuses by NAME (environment-incompatibility) instead of silently claiming
// the requirement has been met. Exit 0 = pass, 3 = fail, 4 = blocked.

const fs = require('node:fs');
const path = require('node:path');
const iso = require(path.join(__dirname, '..', '..', '..', 'lib', 'execisolation'));

const id = process.argv[2];
const work = process.env.RCOS_WORK_DIR || process.cwd();
const reportPath = path.join(work, 'posture.json');

function fakePosture(over) {
  return Object.assign({
    schema: 'rcos-execution-posture/1',
    euid: 501,
    egid: 20,
    is_root: false,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    restrictions: ['euid is subject to POSIX file modes'],
    establishes: ['effective_user_identity'],
    does_not_establish: ['complete sandbox boundary (namespaces, seccomp, mount isolation not probed)']
  }, over);
}

const checks = {
  // The report must be THIS process's identity: same uid, consistent flags,
  // complete metadata, and the adapter's recorded live evaluation must
  // recompute from the recorded posture.
  posture_report_matches_process() {
    if (!fs.existsSync(reportPath)) return { ok: false, detail: 'posture.json missing from work dir' };
    let rep;
    try {
      rep = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (err) {
      return { ok: false, detail: 'posture.json is not valid JSON: ' + err.message };
    }
    if (rep.schema !== 'execution-posture-report/1') return { ok: false, detail: 'bad report schema: ' + String(rep.schema) };
    const p = rep.posture;
    const problems = [];
    const liveUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (p.euid !== liveUid) problems.push('reported euid ' + p.euid + ' != process euid ' + liveUid);
    if (p.is_root !== (liveUid === 0)) problems.push('is_root flag disagrees with the euid');
    if (p.egid !== (typeof process.getgid === 'function' ? process.getgid() : null)) problems.push('reported egid disagrees with the process');
    if (!Array.isArray(p.establishes) || !p.establishes.includes('effective_user_identity')) problems.push('establishes[] lacks effective_user_identity');
    if (!Array.isArray(p.does_not_establish) || p.does_not_establish.length === 0) problems.push('does_not_establish[] empty — posture claims no limits');
    if (!Array.isArray(p.restrictions) || p.restrictions.length === 0) problems.push('restrictions[] empty');
    if (!rep.declared_requirement || rep.declared_requirement.requires !== 'non-root') problems.push('declared requirement is not non-root');
    if (!rep.live_evaluation) problems.push('live_evaluation missing');
    else {
      const recomputed = iso.evaluatePosture(p, rep.declared_requirement);
      const recordedResult = rep.live_evaluation.result || null;
      if (recomputed.ok !== rep.live_evaluation.ok || (recomputed.result || null) !== recordedResult) {
        problems.push('recorded live_evaluation does not recompute from the recorded posture');
      }
    }
    return { ok: problems.length === 0, detail: problems.length > 0 ? problems.join(' | ') : 'euid ' + p.euid + ' matches this process, metadata complete, live_evaluation recomputes' };
  },

  // Both branches of the requirement evaluator, driven by injected postures:
  // root refused with the named result, non-root allowed — regardless of the
  // uid this evaluation itself runs as (privilege-independent by construction).
  non_root_requirement_branches_deterministic() {
    const refused = iso.evaluatePosture(fakePosture({ euid: 0, egid: 0, is_root: true }), { requires: 'non-root' });
    const allowed = iso.evaluatePosture(fakePosture(), { requires: 'non-root' });
    const problems = [];
    if (refused.ok !== false) problems.push('root posture was NOT refused');
    if (refused.result !== 'environment-incompatibility') problems.push('root refusal result is ' + String(refused.result) + ' (want environment-incompatibility)');
    if (!/effective uid is 0/.test(refused.reason || '')) problems.push('root refusal reason does not name the uid: ' + refused.reason);
    if (allowed.ok !== true) problems.push('non-root posture was refused: ' + allowed.reason);
    return { ok: problems.length === 0, detail: problems.length > 0 ? problems.join(' | ') : 'root -> environment-incompatibility, non-root -> ok (deterministic at any running uid)' };
  },

  // A complete-sandbox claim is never derivable from identity: even a
  // non-root posture is refused for that requirement, and unknown
  // requirements are refused too — no silent pass, ever.
  complete_sandbox_never_claimed() {
    const sandbox = iso.evaluatePosture(fakePosture(), { requires: 'complete-sandbox' });
    const unknown = iso.evaluatePosture(fakePosture(), { requires: 'magic-border' });
    const problems = [];
    if (sandbox.ok !== false) problems.push('complete-sandbox was CLAIMED from a uid alone');
    if (sandbox.result !== 'environment-incompatibility') problems.push('complete-sandbox result is ' + String(sandbox.result));
    if (unknown.ok !== false || unknown.result !== 'environment-incompatibility') problems.push('unknown requirement was not refused with environment-incompatibility');
    if (iso.REFUSAL_RESULT !== 'environment-incompatibility') problems.push('module refusal constant drifted: ' + iso.REFUSAL_RESULT);
    return { ok: problems.length === 0, detail: problems.length > 0 ? problems.join(' | ') : 'complete-sandbox and unknown requirements always refused with environment-incompatibility' };
  },

  // The LIVE requirement, bound to this process: a non-root runtime passes;
  // a root runtime refuses by NAME instead of claiming success. Refusal exits
  // 4 (blocked) with `environment-incompatibility: <reason>` on stderr, which
  // the eval runner preserves in checks.json.
  live_non_root_requirement() {
    const live = iso.requirePosture({ requires: 'non-root' });
    if (live.ok) {
      console.log('PASS live_non_root_requirement: non-root requirement met (euid ' + live.posture.euid + ')');
      process.exit(0);
    }
    console.error('environment-incompatibility: ' + live.reason);
    process.exit(4);
  }
};

if (!id || !checks[id]) {
  console.error('unknown gate id: ' + id + ' (known: ' + Object.keys(checks).join(', ') + ')');
  process.exit(4);
}
const res = checks[id]();
console.log((res.ok ? 'PASS ' : 'FAIL ') + id + ': ' + res.detail);
process.exit(res.ok ? 0 : 3);
