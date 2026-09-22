#!/usr/bin/env node
// OP-4R Phase B integration case runner — the child-process half of
// test/op4r-phaseb-integration.test.mjs (GPT work order "Attempt 2 Ruling",
// Phase B). Each case hydrates the REAL attempt-2 envelope fixture into its
// own fresh DSH_HOME, then drives exactly one runGoal call against the mock
// Archon and reports the outcome as ONE JSON line on stdout — the LAST line.
// Protocol identical to conversation-case.mjs: lib modules cache task state
// in module scope, so every case must own a fresh process.
//
// Cases:
//   ordinary  — attempt-3 retry with NO fresh-run option: must encounter the
//               existing prior-run guard (menu observation, zero run).
//   force     — the explicitly authorized fresh-run request through the same
//               runGoal path: one new parent-linked run, attempt 3.
//   unapproved— fresh-run well-formed but no approval: the authority gate
//               still bites (the option never widens authority).
//   malformed — fresh-run present without explicit authorization: fails
//               closed before config, registry, approval, or dispatch.

import { copyFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'op4r-real-envelope-attempt2-task-970ff68d.json');

const caseName = process.argv[2];
const dshHome = process.argv[3];
if (!caseName || !dshHome) {
  console.error('usage: node test/op4r-phaseb-case.mjs <case> <dshHome> [jsonArg]');
  process.exit(2);
}

// DSH_HOME must be set BEFORE any lib import — lib/tasks.js resolves the
// store path through module state.
process.env.DSH_HOME = dshHome;

const TASK_ID = 'task-970ff68d';
const AUTHZ = { source: 'gpt-op4r-attempt-3' };
const FRESH_RUN = { authorized: true, via: 'gpt-op4r-attempt-3' };

async function main() {
  await mkdir(join(dshHome, 'operator-ui'), { recursive: true });
  await copyFile(FIXTURE, join(dshHome, 'operator-ui', 'tasks.json'));
  const { runGoal } = await import('../lib/goal.js');

  let params;
  switch (caseName) {
    case 'ordinary':
      params = { retryOf: TASK_ID, approved: true, authorization: AUTHZ };
      break;
    case 'force':
      params = { retryOf: TASK_ID, approved: true, authorization: AUTHZ, freshRun: FRESH_RUN };
      break;
    case 'unapproved':
      params = { retryOf: TASK_ID, authorization: AUTHZ, freshRun: FRESH_RUN };
      break;
    case 'malformed':
      params = { retryOf: TASK_ID, approved: true, freshRun: { authorized: false, via: 'gpt-op4r' } };
      break;
    default:
      console.error('unknown case: ' + caseName);
      process.exit(2);
  }

  const goal = await runGoal(params);
  const report = {
    taskId: goal.taskId,
    verdict: goal.verdict,
    failureCodes: goal.failureCodes,
    error: goal.error || null,
    nextAction: goal.nextAction || null,
    route: goal.route && goal.route.selected ? goal.route.selected : null,
    conversationId: goal.conversationId || null,
    authority: goal.authority || null,
    execution: goal.execution || null,
    capabilityValidation: goal.capabilityValidation || null,
    objectiveEvaluation: goal.objectiveEvaluation || null,
    trust: goal.trust || null,
    checks: goal.checks || null,
    attempts: (goal.attempts || []).map((a) => ({
      attempt: a.attempt,
      workflow: a.workflow,
      runId: a.runId,
      status: a.status,
      outputs: a.outputs || [],
      startedAt: a.startedAt || null,
      endedAt: a.endedAt || null,
      failureCode: a.failureCode ?? null,
      error: a.error ?? null,
      freshRun: a.freshRun ?? null,
      observation: a.observation ?? null,
      adoption: a.adoption ?? null,
      childConversationId: a.childConversationId ?? null,
      dispatch: a.dispatch ?? null,
      discovery: a.discovery ?? null,
    })),
  };
  console.log(JSON.stringify(report));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
