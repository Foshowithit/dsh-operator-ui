'use strict';
// Execution-isolation posture (P6B v2 candidate).
//
// Repair B is a SEPARATE guarantee from the append-failure invariant: this
// module reports the runtime's real effective identity and evaluates declared
// execution-isolation requirements against it. It establishes identity only.
// A non-root uid alone is NOT a complete sandbox boundary, and this module
// never claims one — requirements it cannot establish are refused with an
// explicit environment-incompatibility result instead of a silent pass.

const SCHEMA = 'rcos-execution-posture/1';
const REFUSAL_RESULT = 'environment-incompatibility';
const REQUIREMENTS = ['non-root', 'complete-sandbox'];

function executionPosture() {
  const euid = typeof process.getuid === 'function' ? process.getuid() : null;
  const egid = typeof process.getgid === 'function' ? process.getgid() : null;
  const isRoot = euid === 0;
  return {
    schema: SCHEMA,
    euid: euid,
    egid: egid,
    is_root: isRoot,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    restrictions: isRoot
      ? ['euid 0 bypasses POSIX file-mode checks (DAC)', 'no namespace/seccomp confinement established']
      : ['euid is subject to POSIX file modes', 'no namespace/seccomp confinement established by this module'],
    establishes: ['effective_user_identity'],
    does_not_establish: [
      'complete sandbox boundary (namespaces, seccomp, mount isolation not probed)'
    ]
  };
}

// Pure decision core: an explicit posture + requirement keeps both privilege
// branches deterministically testable from a single evaluation process, while
// requirePosture() below binds the same logic to the live process identity.
function evaluatePosture(posture, requirement) {
  const name = requirement && requirement.requires;
  if (!REQUIREMENTS.includes(name)) {
    return {
      ok: false,
      result: REFUSAL_RESULT,
      reason: 'unknown execution-isolation requirement: ' + String(name),
      posture: posture
    };
  }
  if (posture.euid === null || posture.euid === undefined) {
    return {
      ok: false,
      result: REFUSAL_RESULT,
      reason: 'effective uid not reportable on this platform',
      posture: posture
    };
  }
  if (name === 'complete-sandbox') {
    return {
      ok: false,
      result: REFUSAL_RESULT,
      reason: 'complete sandbox boundary cannot be established from uid/platform alone',
      posture: posture
    };
  }
  if (posture.is_root === true || posture.euid === 0) {
    return {
      ok: false,
      result: REFUSAL_RESULT,
      reason: 'requirement non-root not met: effective uid is 0',
      posture: posture
    };
  }
  return { ok: true, requirement: name, posture: posture };
}

function requirePosture(requirement) {
  return evaluatePosture(executionPosture(), requirement);
}

module.exports = {
  SCHEMA: SCHEMA,
  REFUSAL_RESULT: REFUSAL_RESULT,
  REQUIREMENTS: REQUIREMENTS,
  executionPosture: executionPosture,
  evaluatePosture: evaluatePosture,
  requirePosture: requirePosture
};
