#!/usr/bin/env node
'use strict';
// Private adapter for execution-posture-v1 (rcos-eval/1): records the runtime's
// real effective identity and the live evaluation of the eval's declared
// execution-isolation requirement into the run work dir. The gates judge this
// report against the process identity they themselves run under — same uid,
// same machine. Exit 0 = recorded; whether the requirement is MET is the
// gates' verdict, not the adapter's.

const fs = require('node:fs');
const path = require('node:path');
const iso = require(path.join(__dirname, '..', '..', '..', 'lib', 'execisolation'));

const work = process.env.RCOS_WORK_DIR || process.cwd();
const posture = iso.executionPosture();
const declared = { requires: 'non-root' };
const live = iso.requirePosture(declared);

const report = {
  schema: 'execution-posture-report/1',
  posture: posture,
  declared_requirement: declared,
  live_evaluation: live,
  recorded_at: new Date().toISOString()
};
fs.writeFileSync(path.join(work, 'posture.json'), JSON.stringify(report, null, 2) + '\n');

console.log('posture: euid=' + posture.euid + ' is_root=' + posture.is_root +
  ' non_root_requirement_ok=' + live.ok + (live.result ? ' (' + live.result + ')' : ''));
process.exit(0);
