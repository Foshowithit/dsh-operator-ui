#!/usr/bin/env node
// OP-4R — GPT-ordered DSH visibility-defect correction for Attempt 2.
// Read-model only: no Archon call, no dispatch, no attempt mutation beyond an
// APPEND-ONLY observation on attempt 2. Historical truth is preserved exactly
// as recorded (verdict FAILED, failureCode run-not-found); the independent
// correction rides beside it, and nextAction stops advertising an ordinary
// retry that deterministically returns the same menu.
import { readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { nextAction } from '../../lib/goal.js';

const home = process.env.HOME || '';
if (!home) { console.error('no home'); process.exit(2); }
// getDshHome semantics: DSH_HOME points at the root itself, else $HOME/.dsh.
const finalPath = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'operator-ui', 'tasks.json')
  : join(home, '.dsh', 'operator-ui', 'tasks.json');

const raw = await readFile(finalPath, 'utf8');
const doc = JSON.parse(raw);
const task = (doc.tasks || []).find((t) => t && t.taskId === 'task-970ff68d');
if (!task) { console.error('task-970ff68d not found in ' + finalPath); process.exit(1); }

// Preconditions: refuse to touch anything but the known attempt-2 record.
if (task.verdict !== 'FAILED' || (task.failureCodes || []).join(',') !== 'run-not-found') {
  console.error('refusing: envelope is not FAILED/run-not-found (' + task.verdict + '/' + (task.failureCodes || []).join(','));
  process.exit(1);
}
const attempt2 = (task.attempts || [])[1];
if (!attempt2 || attempt2.attempt !== 2) { console.error('refusing: attempt 2 not found'); process.exit(1); }
if (attempt2.failureCode !== 'run-not-found') { console.error('refusing: attempt 2 failureCode changed'); process.exit(1); }
if (attempt2.observation) { console.log('already recorded — no write'); process.exit(0); }

const backupPath = finalPath + '.bak-op4r-observation-20260922';
await copyFile(finalPath, backupPath).catch((e) => { if (e.code !== 'EEXIST') throw e; });

attempt2.observation = {
  observedAt: new Date().toISOString(),
  kind: 'prior-run-menu',
  sqliteRowId: 33758,
  match: 'Found a prior failed run of **csv-running-total-v1**',
  summary: 'Archon accepted the request and asked for a prior-failed-run decision; no execution was started.',
  evidence: [
    'archon.db remote_agent_messages rowid 33757 (user dispatch) + rowid 33758 (assistant: "Starting workflow: csv-running-total-v1" + "Found a prior failed run of …" menu) in conversation fc764d99b8f0d7ba3426df409ea63540 at 2026-09-22T04:02:19Z',
    'zero workflow run rows created in the dispatch window: TOTAL_RUNS stayed 3561; csv-running-total runs stayed 1 (historical 7245beda-c754-4862-af56-ae2e72e11d15 only)',
    'source: dispatchOrchestratorWorkflowOwned — without options.force the prior-failed-run guard short-circuits before run creation and buildFailedRunResumePrompt returns the 3-option menu',
  ],
  correction: 'Attempt 2 remains historically recorded as FAILED / run-not-found. Independently observed correction: Archon accepted the request and asked for a prior-failed-run decision; no execution was started.',
  notProofOf: 'execution',
  recordedBy: 'op4r-attempt2-observation-20260922',
};

const before = task.nextAction && task.nextAction.kind;
task.nextAction = nextAction(task); // menu observation -> operator-action, never retry

const tmp = finalPath + '.tmp-op4r-obs';
await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
await rename(tmp, finalPath);

console.log('backup:  ' + backupPath);
console.log('attempt2.observation appended (kind=' + attempt2.observation.kind + ', sqliteRowId=' + attempt2.observation.sqliteRowId + ')');
console.log('verdict preserved: ' + task.verdict + ' / ' + (task.failureCodes || []).join(','));
console.log('nextAction: ' + before + ' -> ' + task.nextAction.kind + ' ("' + task.nextAction.label + '")');
