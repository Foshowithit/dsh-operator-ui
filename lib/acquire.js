// lib/acquire.js — PRODUCTION Capability Acquisition (GPT productization
// ruling, checkpoint 7b5c9cc): the Acquisition v2 mechanism — proven in the
// sealed Eval Protocol v2 program (48/72 scored, 48/48 promoted-family
// reliability, zero false promotions) — wired into the real M3 product
// path instead of the eval harness.
//
//   GAP from normal WORK
//     → compose candidate (configured cognition; DSH headless per M3-SPEC
//       §2.1, or a model endpoint)
//     → static validation (dialect, output contract, location, forbidden)
//     → execute on the ORIGINATING task's real workspace (Archon)
//     → independent objective evaluation (lib/task-truth.js evaluateObjective,
//       object form; evaluator = the originating task's declared
//       objectiveEvaluation — the M1 adjudicator, never the acquisition's
//       own opinion)
//     → on failure: redacted diagnosis → material revision (≤3) → re-execute
//     → CANDIDATE (promotion offered; the explicit operator click lives in
//       teach.js promoteCandidate) | REFUSED (reasons + attempts trail)
//
// Discipline carried over from the sealed program:
// - fail-closed: no cognition configured → REFUSED, never a fake candidate
// - conjunctive budgets: ≤3 revisions / ≤4 model calls / 50k out tokens /
//   10 min wall — first ceiling hit refuses
// - byte-identical revision → REVISION_LOOP refusal
// - every candidate persisted in the envelope's attempts trail (no third
//   store: the envelope lives in tasks.json like every other RCOS task)
// - the acquisition's own opinion never promotes: objective evaluation +
//   operator click are the two gates
// - RC read-outcomes: an Archon read that could not be completed is an OUTAGE,
//   never "the candidate failed" — UNAVAILABLE / ABSENT / MALFORMED are their
//   own outcomes (see runWorkflowOnArchon), they consume no revision, and they
//   never blame the candidate (same discipline as lib/goal.js, lib/tasks.js).

import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { resolveConfig } from './config.js';
import { getTask, upsertTask, listTasks } from './tasks.js';
import { evaluateObjective } from './task-truth.js';
import { isTerminalRunStatus } from './run-status.js';

const sha256s = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const isoNow = () => new Date().toISOString();

export const ACQ_BUDGET = { maxRevisions: 3, maxCalls: 4, maxOutputTokens: 50000, maxWallMs: 600000 };

// The INFRASTRUCTURE-attempt bound. A transient Archon outage is legitimately
// retryable, but a PERMANENT one (dispatch accepted and the run never
// materializes, or Archon is unreadable) must not retry forever with no
// terminal state. The acquisition envelope is minted fresh per invocation
// (`acq_…`), so no counter on the envelope alone can survive a retry — the
// count is therefore DERIVED from the durable store: prior acquisitions for the
// SAME source task that ended in an infrastructure outage. At the limit the
// envelope becomes TERMINAL with an INSPECT action — never REFUSED, because
// REFUSED would blame the candidate for our inability to run it. No new
// persistence: tasks.json is the store and listTasks() is its read.
export const INFRA_ATTEMPT_LIMIT = 3;

// The number of CONSECUTIVE prior infrastructure outages recorded for a source
// task. Ordered by the envelopes' own createdAt (the store's ordering key), so a
// later invocation that reached a real outcome — CANDIDATE, REFUSED, anything
// that is not an outage — ENDS the streak. Without that reset the bound could
// never clear, and "could not be given a fair run after N attempts" would be a
// false statement about failures that were months apart.
function consecutiveInfraOutages(prior, sourceTaskId) {
  const mine = prior
    .filter((x) => x && x.kind === 'teaching' && x.sourceTaskId === sourceTaskId)
    .sort((a, b) => String(a.createdAt || a.startedAt || '').localeCompare(String(b.createdAt || b.startedAt || '')));
  let n = 0;
  for (let i = mine.length - 1; i >= 0; i--) {
    if (!mine[i].outage) break;
    n += 1;
  }
  return n;
}

// ---------------------------------------------------------------- cognition
//
// Two backends behind one interface (prompt → { text, usage }):
//   'endpoint' — model endpoint (responses API), proven in the sealed run
//   'dsh'      — headless DSH session on the frozen lane (M3-SPEC §2.1)
async function thinkEndpoint(prompt, cfg) {
  const key = process.env[cfg.apiKeyEnv || ''];
  if (!key) throw Object.assign(new Error('cognition credential env ' + cfg.apiKeyEnv + ' is not set'), { code: 'no-cognition-credential' });
  const started = Date.now();
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + key };
  if (cfg.sessionHeader) headers['x-opencode-session'] = cfg.sessionHeader;
  const res = await fetch(cfg.endpoint.replace(/\/$/, '') + '/responses', {
    method: 'POST', headers,
    body: JSON.stringify({ model: cfg.model, input: prompt, max_output_tokens: cfg.maxOutputTokens || 16384 }),
  });
  const d = await res.json();
  const text = (d.output || []).filter((o) => o.type === 'message').flatMap((o) => (o.content || []).map((c) => c.text || '')).join('');
  if (!text && d.error) throw Object.assign(new Error('model error: ' + JSON.stringify(d.error).slice(0, 160)), { code: 'model-error' });
  return { text, usage: d.usage || {}, wall_ms: Date.now() - started };
}

async function thinkDsh(prompt, cfg) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.dshBin || 'dsh', ['--profile', 'headless', prompt], {
      cwd: cfg.workspaceDir,
      env: { ...process.env, ...(cfg.dshEnv || {}) },
      timeout: cfg.dshTimeoutMs || 240000,
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('error', (e) => reject(Object.assign(e, { code: 'dsh-spawn-failed' })));
    child.on('close', (code) => {
      if (code !== 0 && !out.trim()) return reject(Object.assign(new Error('dsh session exited ' + code), { code: 'dsh-failed' }));
      resolve({ text: out, usage: {}, wall_ms: Date.now() - started });
    });
  });
}

async function think(prompt, cfg) {
  if (cfg.mode === 'dsh') return thinkDsh(prompt, cfg);
  return thinkEndpoint(prompt, cfg);
}

// --------------------------------------------------------- static validation
//
// Compact production port of the sealed program's static-checks (v1.0.2):
// the cheapest refusal stage — nothing executes until a candidate passes.
export function staticValidate(yamlText) {
  const failures = [];
  const push = (code, detail) => failures.push({ code, detail });
  if (typeof yamlText !== 'string' || !yamlText.trim()) return { ok: false, failures: [{ code: 'YAML_EMPTY', detail: 'no candidate text' }] };
  const name = (yamlText.match(/^name:\s*(\S+)/m) || [])[1];
  if (!name) push('NAME_MISSING', 'workflow has no name');
  else if (!/^[a-z0-9][a-z0-9-]*-v0-1-0$/.test(name)) push('NAME_FORMAT', `name "${name}" must be lowercase-hyphenated and end -v0-1-0`);
  if (!/^nodes:\s*$/m.test(yamlText) && !/^nodes:\s*\n/m.test(yamlText)) push('NODES_MISSING', 'workflow has no nodes list');
  if (!/\bRESULT\b/.test(yamlText)) push('CONTRACT_NO_RESULT', 'no RESULT output lines — the operator-legible evidence contract requires them');
  const marker = (yamlText.match(/learned-[\w-]+:done/) || [null])[0];
  if (!marker) push('CONTRACT_NO_MARKER', 'no expectation marker learned-<name>:done');
  else if (name && marker !== `learned-${name}:done`) push('CONTRACT_MARKER_NAME', `marker "${marker}" does not match name "${name}"`);
  if (/>\s*\/(?!dev\/null)/.test(yamlText) || /\btee\s+\/(?!dev\/null)/.test(yamlText)) push('LOCATION_ABSOLUTE_WRITE', 'redirect to an absolute path — artifacts must stay in the workspace');
  if (/(cp|mv|tee|>)\s+["']?\.\.\//.test(yamlText)) push('LOCATION_PARENT_ESCAPE', 'writes via ../ escape the workspace');
  for (const [code, re, why] of [
    ['FORBIDDEN_NETWORK', /\b(curl|wget|nc|ncat|ftp|ssh|scp|rsync|ping)\b/, 'network access is not allowed'],
    ['FORBIDDEN_PRIVILEGE', /\b(sudo|su|doas)\b/, 'privilege escalation is not allowed'],
    ['FORBIDDEN_DESTRUCTIVE', /(rm\s+-rf\s+[\/~]|mkfs|dd\s+if=|>\s*\/dev\/sd[a-z])/, 'destructive shell is not allowed'],
    ['FORBIDDEN_CREDENTIAL', /(~\/\.[a-z-]*secrets|~\/\.ssh|~\/\.aws|\.netrc|id_rsa)/, 'credential stores must never be read'],
  ]) if (re.test(yamlText)) push(code, why);
  return { ok: failures.length === 0, failures, name };
}

// ------------------------------------------------------------- prompts
function composePrompt(objective, sample) {
  return `You are RCOS's capability-acquisition step. An objective could not be routed: no existing capability matches.

OBJECTIVE: ${objective}

A sample of the workspace it must run in (cwd = workspace root):
${sample}

Compose ONE candidate workflow in Archon YAML. STRICT SCHEMA:
- top-level keys: name, description, nodes
- name: lowercase, hyphenated, end with -v0-1-0
- each node: { id, bash: <shell script>, depends_on: [ids] (optional) }
- nodes run with cwd = the workspace root
- ARTIFACT-LOCATION CONTRACT: relative paths only; never write to /tmp, /, ~, or via ../
- The workflow receives the objective text in $USER_MESSAGE — parse per-run parameters from it so the capability generalizes across workspaces of this kind
- The LAST node must echo the marker: learned-<name>:done
- Print operator-legible result lines containing the word RESULT (e.g. 'RESULT key=value')
- Deterministic sh-compatible shell, no network, no credentials
- Generic across workspaces of this KIND: do not hardcode this exact file's contents

Also give ROUTING VOCABULARY: copy the distinctive CONTENT WORDS from the objective VERBATIM plus 2-3 related lowercase words.

Reply with EXACTLY two fenced blocks: yaml (the workflow) and json {"description": "...", "tags": ["..."]}.`;
}

function diagnosePrompt({ objective, prevYaml, runStatus, outputs, evalReason, requiredName }) {
  return `The candidate workflow you composed FAILED evaluation for this objective. Diagnose from the evidence and produce a REVISED candidate.

OBJECTIVE: ${objective}

YOUR PREVIOUS CANDIDATE:
\`\`\`yaml
${prevYaml}
\`\`\`

WORKFLOW RUN STATUS: ${runStatus}
YOUR PRODUCED OUTPUT (verbatim):
${String(outputs || '').slice(0, 3500) || '(none captured)'}
INDEPENDENT OBJECTIVE EVALUATION: ${evalReason}

RULES:
- Fix the ACTUAL defect the evidence points to; do not restate the same strategy.
- Keep the strict schema, the artifact-location contract, and the RESULT output contract.
- The revised workflow MUST be named ${requiredName} and echo learned-${requiredName}:done.
- Generalize: parse parameters from $USER_MESSAGE; handle quoting, comments, case, extra files.

Reply with EXACTLY two fenced blocks: yaml (the revised workflow) and json {"description": "...", "tags": ["..."]}.`;
}

function parseReply(text) {
  const ym = text.match(/```yaml\n([\s\S]*?)(?:```|$)/) || text.match(/```\n([\s\S]*?)(?:```|$)/);
  const jm = text.match(/```json\n([\s\S]*?)```/);
  let routing = { description: 'LEARNED capability', tags: [] };
  if (jm) { try { const j = JSON.parse(jm[1]); routing = { description: String(j.description || routing.description), tags: (j.tags || []).map((t) => String(t).toLowerCase()) }; } catch {} }
  return { yaml: ym ? ym[1] : null, routing };
}

// --------------------------------------------------------------- execution
//
// The outcome of an Archon READ is TYPED, never collapsed to null/NO_RUN. The
// defect this replaces: `catch { return null }` + `if (!entry) return NO_RUN`
// + `try { detail } catch {}` made an OUTAGE indistinguishable from "Archon
// answered and named no run", so a transient outage was reported as the
// CANDIDATE failing (blamed it, consumed a revision, could refuse a good
// candidate for a reason that was false). Same vocabulary as goal.js
// (UNAVAILABLE / NOT_FOUND / INVALID) and replication.js (SOURCE_UNAVAILABLE /
// SOURCE_ABSENT / SOURCE_MALFORMED):
//   UNAVAILABLE — the read could not be completed (transport / non-ok / timeout)
//   ABSENT      — Archon ANSWERED and there is no such run
//   MALFORMED   — a record came back but is unusable
// None of the three is a verdict on the candidate.
// The terminal-status rule is deliberately NOT defined here. It is ONE
// definition for the whole family, exported by lib/run-status.js
// (TERMINAL_RUN_STATUSES / isTerminalRunStatus), because it used to be answered
// five different ways and two of those readers disagreed about the SAME string.
// The home is run-status.js and NOT goal.js — and this comment previously said
// goal.js, so the import above was written as `from './goal.js'`. goal.js
// imports the predicate but deliberately does not re-export it (a constants-only
// module satisfies scripts/check.js's module-graph leg; a re-export would make
// goal.js a second, silent door to the same constant). The result was that
// lib/acquire.js could not LOAD at all — ESM link error, "does not provide an
// export named 'isTerminalRunStatus'" — and lib/index.js, which imports this
// file, went down with it. The stale prose did not merely mislead a reader; it
// produced the defect, and it stayed invisible because the verification gate had
// never been run. Keep this line and the import above in step.
// This file's copy was an allow-list that already included 'cancelled' — the
// right DIRECTION — so the shared rule WIDENS it rather than reversing it:
// 'canceled' (the other spelling) and 'blocked' join it, and the comparison is
// case-normalised, which this file already did. There is deliberately no local
// copy to shadow the import: a local copy is exactly what diverged.
//
// SCOPE, so the next reader does not over-claim it: this constant decides WHEN
// THE POLL STOPS. It does not decide what a terminal status MEANS, and that
// second question is a KNOWN RESIDUAL here, not an oversight:
//   runWorkflowOnArchon returns `status: <the terminal status>` and the engine
//   below scores the candidate with `run.status === 'completed'` (the
//   executionCompleted / capabilityValidation legs and the CANDIDATE branch).
//   So a run that ended 'cancelled' — which THIS FILE's own list already called
//   terminal, so it is reachable today, not hypothetically — is neither
//   UNAVAILABLE, ABSENT nor MALFORMED, and therefore falls through to
//   `lastFailure`: it consumes a REVISION and hands the model a diagnosis of a
//   failure that may not be the candidate's. Widening the terminal set does not
//   create that path; it makes 'canceled' and 'blocked' reach it without the
//   deadline wait instead of after it. The split it needs — only 'completed'
//   and 'failed' are evidence ABOUT the candidate; every other terminal status
//   is an unfair run — is filed as its own task and deliberately NOT
//   half-applied here, because landing the rule without it would leave this
//   comment describing behaviour the code does not have.
const UNREADABLE_RUN_STATUSES = new Set(['UNAVAILABLE', 'ABSENT', 'MALFORMED']);

// The exhausted-bound action is DERIVED from the recorded outcome, never
// hardcoded to availability. For UNAVAILABLE the read could not be completed,
// so "Inspect Archon availability" is right. For ABSENT (Archon ANSWERED and
// named no such run) and MALFORMED (a record came back unusable) the evidence
// has already CLEARED availability — a label pointing at Archon availability
// would be a false statement about the installation, and it is the text the
// operator actually clicks. Same defect class as the read sites: the recorded
// outcome is truthful, but the prescribed action must not contradict it.
const EXHAUSTED_INSPECT_LABEL = {
  UNAVAILABLE: 'Inspect Archon availability',
  ABSENT: 'Inspect the dispatch path',
  MALFORMED: 'Inspect the run record',
};

async function runWorkflowOnArchon(workflow, message, archon, timeoutMs) {
  const base = archon.baseUrl.replace(/\/$/, '');
  await new Promise((r) => setTimeout(r, 2500)); // catalog hot-reload
  let started = false;
  let dispatchError = null;
  for (let i = 0; i < 3 && !started; i++) {
    try {
      const res = await fetch(base + '/api/workflows/' + encodeURIComponent(workflow) + '/run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, conversationId: 'rcos-acquire-' + Date.now() }),
      });
      if (res.ok) started = true;
      else dispatchError = 'archon answered HTTP ' + res.status + ' on dispatch';
    } catch (e) { dispatchError = 'archon unreachable on dispatch (' + String((e && e.message) || e).slice(0, 80) + ')'; }
    if (!started) await new Promise((r) => setTimeout(r, 2000));
  }
  // The dispatch leg never completed (unreachable, or answering non-ok across
  // every retry — overwhelmingly the catalog hot-reload window): the candidate
  // was never executed, so this is an outage of the write leg, not its failure.
  if (!started) return { status: 'UNAVAILABLE', outputs: [], runId: null, reason: 'dispatch could not be completed — ' + (dispatchError || 'archon unreachable') };

  const findRun = async () => {
    try {
      const res = await fetch(base + '/api/workflows/runs?limit=10');
      if (!res.ok) return { state: 'UNAVAILABLE', entry: null, reason: 'archon runs list returned HTTP ' + res.status };
      let lb;
      try { lb = await res.json(); } catch { return { state: 'UNAVAILABLE', entry: null, reason: 'archon runs list response could not be read (invalid JSON)' }; }
      if (!lb || !Array.isArray(lb.runs)) return { state: 'UNAVAILABLE', entry: null, reason: 'archon runs list response could not be read (no runs array)' };
      return { state: 'OK', entry: lb.runs.find((x) => x.workflow_name === workflow) || null };
    } catch (e) { return { state: 'UNAVAILABLE', entry: null, reason: 'archon could not be reached (' + String((e && e.message) || e).slice(0, 80) + ')' }; }
  };

  const deadline = Date.now() + (timeoutMs || 90000);
  let entry = null;
  let successfulListReads = 0;
  let lastListReason = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const read = await findRun();
    if (read.state === 'OK') { successfulListReads += 1; entry = read.entry; }
    else lastListReason = read.reason;
    if (entry && isTerminalRunStatus(entry.status)) break;
  }
  if (!entry) {
    // ZERO successful reads is an outage; one or more successful reads that
    // never named our run is Archon ANSWERING absence. Never conflate them.
    if (successfulListReads === 0) {
      return { status: 'UNAVAILABLE', outputs: [], runId: null, reason: 'archon run list was never successfully read during acquisition — outcome unknown, not absent (' + (lastListReason || 'no successful run-list read') + ')' };
    }
    return { status: 'ABSENT', outputs: [], runId: null, reason: 'dispatch was accepted but no run for ' + workflow + ' appeared — Archon answered and named no such run' };
  }

  // The run exists and reached a terminal status on the LIST read; its EVIDENCE
  // read is a SECOND, independent read that can fail on its own. Returning
  // outputs=[] here (the old `catch {}`) made an unreadable evidence read look
  // like "produced nothing", which is exactly how an outage became the
  // candidate's fault.
  let detail = null;
  let detailReason = null;
  let malformed = false;
  try {
    const res = await fetch(base + '/api/workflows/runs/' + encodeURIComponent(entry.id));
    if (!res.ok) {
      detailReason = 'archon answered HTTP ' + res.status + ' on the run detail read';
    } else {
      let body = null;
      try { body = await res.json(); } catch { malformed = true; detailReason = 'run detail response could not be read (invalid JSON)'; }
      if (!malformed) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) { malformed = true; detailReason = 'run detail response was not a record'; }
        else detail = body;
      }
    }
  } catch (e) { detailReason = 'archon unreachable on the run detail read (' + String((e && e.message) || e).slice(0, 80) + ')'; }
  if (!detail) {
    return { status: malformed ? 'MALFORMED' : 'UNAVAILABLE', outputs: [], runId: entry.id, reason: detailReason || 'run detail could not be read' };
  }
  const outputs = ((detail && detail.events) || []).map((e) => (e.data || {}).node_output ?? '').filter(Boolean);
  return { status: String(entry.status || 'unknown').toLowerCase(), outputs, runId: entry.id };
}

// ============================================================ the engine
export async function acquireCapability({ sourceTaskId }) {
  const cfgRes = resolveConfig();
  const cfg = cfgRes.config || {};
  const acquisition = cfg.acquisition || null;
  const teaching = cfg.teaching || null;
  const archon = cfg.archon || null;

  const src = await getTask(String(sourceTaskId || '').slice(0, 120));
  if (!src || src.kind !== 'goal') return { ok: false, error: 'source task not found (acquisition starts from a goal task)' };

  const t = {
    taskId: 'acq_' + randomUUID().slice(0, 8),
    kind: 'teaching',
    status: 'acquiring',
    verdict: 'IN_PROGRESS',
    sourceTaskId: src.taskId,
    objective: src.objective,
    startedAt: isoNow(),
    createdAt: isoNow(), // the store's ordering key (see consecutiveInfraOutages)
    provenance: { builtBy: 'acquisition-v2 (production port of the sealed program 7b5c9cc)', mechanism: 'compose → static → execute → evaluate → revise ≤3' },
    attempts: [],
    evaluations: [],
    nextAction: { kind: 'inspect', label: 'Acquisition running', reason: 'Composing a candidate capability for this objective.' },
  };
  // The infrastructure-attempt count, carried ACROSS invocations (see
  // INFRA_ATTEMPT_LIMIT). Derived from the durable store, so a retry of the
  // SAME source task continues the count instead of silently resetting it. A
  // store-read failure must not fabricate a bound, so it stays at 1.
  try {
    const prior = await listTasks();
    t.infraAttempts = 1 + consecutiveInfraOutages(prior, t.sourceTaskId);
  } catch { t.infraAttempts = 1; /* unbounded by a failed count, but never falsely bounded */ }
  await upsertTask(t);

  const fail = async (code, reason, extra) => {
    t.verdict = 'REFUSED';
    t.status = 'failed';
    t.refusal = { code, reason, ...(extra || {}) };
    t.nextAction = { kind: 'inspect', label: 'Inspect the acquisition evidence', reason };
    t.endedAt = isoNow();
    await upsertTask(t);
    return { ok: true, teaching: t };
  };

  // An Archon OUTAGE is its own outcome — never REFUSED, never recorded as the
  // candidate's failure. The candidate never got a fair run, so the honest
  // result is "unknown, retry later" — until the infrastructure-attempt bound
  // is reached, at which point the envelope becomes TERMINAL with an INSPECT
  // action (still never a capability verdict). Promotion stays impossible
  // either way, because only a CANDIDATE can be promoted (fail-closed).
  const outage = async (outcome, reason, extra) => {
    const attempt = t.infraAttempts || 1;
    const exhausted = attempt >= INFRA_ATTEMPT_LIMIT;
    t.verdict = 'UNKNOWN';
    t.status = String(outcome || 'UNAVAILABLE').toLowerCase();
    // CONSIDERED NON-CHANGE: `t.outage` is deliberately NOT renamed to
    // something outcome-neutral. `outcome` always travels WITH the bucket, so
    // the durable record never asserts a bare outage — `outage: { outcome:
    // 'ABSENT' }` self-qualifies. The false claim was in the operator-facing
    // LABEL (fixed just below), not in the record; renaming would ripple into
    // consecutiveInfraOutages and every test for no operator-visible gain.
    t.outage = { outcome, reason, attempt, limit: INFRA_ATTEMPT_LIMIT, exhausted, ...(extra || {}) };
    // The fallback must NOT name a cause. It used to read
    // `|| 'Inspect Archon availability'`, which meant a fourth unreadable status
    // added to UNREADABLE_RUN_STATUSES without a matching label would tell the
    // operator to inspect Archon's availability — a causal claim the data does
    // not support, and precisely the restatement this table exists to prevent.
    // The map covers all three statuses today, so the fallback is unreachable;
    // it is kept only so a future omission degrades to a NEUTRAL instruction
    // rather than a false one. Dropping it entirely was rejected: `label` is
    // written into the durable envelope, and `undefined` would serialize the
    // field away, leaving the operator an action with no text at all.
    t.nextAction = exhausted
      ? { kind: 'inspect', label: EXHAUSTED_INSPECT_LABEL[outcome] || 'Inspect the run outcome', reason: 'The candidate could not be given a fair run after ' + attempt + ' infrastructure attempts — this is not a capability verdict. ' + reason }
      : { kind: 'retry', label: 'Retry acquisition', reason: reason + ' (infrastructure attempt ' + attempt + ' of ' + INFRA_ATTEMPT_LIMIT + ')' };
    t.endedAt = isoNow();
    await upsertTask(t);
    return { ok: true, teaching: t };
  };

  if (!acquisition) return fail('ACQUISITION_NOT_CONFIGURED', 'acquisition cognition is not configured — set config.acquisition {mode, endpoint/model/apiKeyEnv} or {mode:"dsh"}');
  if (!teaching || !teaching.workflowsDir) return fail('TEACHING_NOT_CONFIGURED', 'teaching.workflowsDir is not configured — nothing to execute');
  if (!archon || !archon.baseUrl) return fail('ARCHON_NOT_CONFIGURED', 'archon.baseUrl is not configured');

  const budget = { ...ACQ_BUDGET, ...(cfg.acquisition.budget || {}) };
  const usage = { calls: 0, output_tokens: 0, wall_ms: 0 };
  const started = Date.now();
  let yamlText = null, routing = null, currentHash = null, name = null;
  let lastFailure = null;
  let revision = 0;

  const overBudget = () => {
    if (usage.calls >= budget.maxCalls) return `model calls ${usage.calls} ≥ ${budget.maxCalls}`;
    if (usage.output_tokens >= budget.maxOutputTokens) return `output tokens ${usage.output_tokens} ≥ ${budget.maxOutputTokens}`;
    if (Date.now() - started >= budget.maxWallMs) return `wall ${Date.now() - started}ms ≥ ${budget.maxWallMs}ms`;
    return null;
  };

  // workspace sample for the compose prompt (max ~10 files, truncated)
  let sample = '';
  try {
    const entries = await readdir(teaching.workspaceDir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).slice(0, 10);
    for (const f of files) {
      const body = await readFile(join(teaching.workspaceDir, f.name), 'utf8').catch(() => null);
      if (body !== null) sample += `--- ${f.name} ---\n${body.slice(0, 600)}\n`;
    }
  } catch { sample = '(workspace not readable)'; }

  while (true) {
    const budgetHit = overBudget();
    if (budgetHit) return fail('BUDGET_EXHAUSTED', 'acquisition budget exhausted: ' + budgetHit, { attempts: t.attempts.length, revisions: revision });

    if (!yamlText) {
      // ---- COMPOSE ----
      const prompt = composePrompt(t.objective, sample);
      let reply;
      try { reply = await think(prompt, acquisition); }
      catch (e) { return fail(String(e.code || 'MODEL_ERROR').toUpperCase().replace(/-/g, '_'), 'cognition failed: ' + String(e.message).slice(0, 180)); }
      usage.calls += 1; usage.output_tokens += (reply.usage.output_tokens || 0); usage.wall_ms += reply.wall_ms;
      const parsed = parseReply(reply.text || '');
      const attempt = { rev: 0, stage: 'compose', at: isoNow(), prompt_sha256: sha256s(prompt), model: { output_tokens: reply.usage.output_tokens ?? null } };
      if (!parsed.yaml) { attempt.failure = 'parse'; t.attempts.push(attempt); await upsertTask(t); continue; }
      const checks = staticValidate(parsed.yaml);
      yamlText = parsed.yaml; routing = parsed.routing;
      name = (yamlText.match(/^name:\s*(\S+)/m) || [])[1] || null;
      currentHash = sha256s(yamlText);
      attempt.yaml_sha256 = currentHash; attempt.name = name; attempt.static = checks.ok ? 'pass' : checks.failures.map((f) => f.code);
      t.attempts.push(attempt);
      await upsertTask(t);
      if (!checks.ok) {
        lastFailure = { stage: 'static', detail: checks.failures.map((f) => `- ${f.code}: ${f.detail}`).join('\n') };
        continue;
      }
      continue;
    }

    // ---- REVISE (a failure is pending) ----
    if (lastFailure) {
      if (revision >= budget.maxRevisions) return fail('REVISIONS_EXHAUSTED', `revisions ${revision} ≥ ${budget.maxRevisions}`, { failedStage: lastFailure.stage, attempts: t.attempts.length });
      const next = revision + 1;
      const requiredName = `${(name || 'candidate').replace(/-r\d+-v0-1-0$|-v0-1-0$/, '')}-r${next}-v0-1-0`;
      const prompt = lastFailure.stage === 'static'
        ? `The candidate failed static validation — it was never executed:\n${lastFailure.detail}\n\nOBJECTIVE: ${t.objective}\n\nYOUR CANDIDATE:\n\`\`\`yaml\n${yamlText}\`\`\`\n\nProduce a corrected candidate named ${requiredName}. Reply with a yaml block and a json block.`
        : diagnosePrompt({ objective: t.objective, prevYaml: yamlText, runStatus: lastFailure.runStatus, outputs: lastFailure.outputs, evalReason: lastFailure.evalReason, requiredName });
      let reply;
      try { reply = await think(prompt, acquisition); }
      catch (e) { return fail(String(e.code || 'MODEL_ERROR').toUpperCase().replace(/-/g, '_'), 'cognition failed: ' + String(e.message).slice(0, 180)); }
      usage.calls += 1; usage.output_tokens += (reply.usage.output_tokens || 0); usage.wall_ms += reply.wall_ms;
      const parsed = parseReply(reply.text || '');
      const attempt = { rev: next, stage: 'revision', at: isoNow(), parent_sha256: currentHash, prompt_sha256: sha256s(prompt), model: { output_tokens: reply.usage.output_tokens ?? null } };
      if (!parsed.yaml) { attempt.failure = 'parse'; t.attempts.push(attempt); await upsertTask(t); continue; }
      const newHash = sha256s(parsed.yaml);
      if (newHash === currentHash) return fail('REVISION_LOOP', `revision ${next} is byte-identical to the previous candidate`);
      const checks = staticValidate(parsed.yaml);
      yamlText = parsed.yaml; routing = parsed.routing;
      name = (yamlText.match(/^name:\s*(\S+)/m) || [])[1] || name;
      currentHash = newHash; revision = next;
      attempt.yaml_sha256 = newHash; attempt.name = name; attempt.static = checks.ok ? 'pass' : checks.failures.map((f) => f.code);
      t.attempts.push(attempt);
      await upsertTask(t);
      if (!checks.ok) { lastFailure = { stage: 'static', detail: checks.failures.map((f) => `- ${f.code}: ${f.detail}`).join('\n') }; continue; }
      lastFailure = null;
      continue;
    }

    // ---- EXECUTE + EVALUATE ----
    await mkdir(teaching.workflowsDir, { recursive: true });
    await writeFile(join(teaching.workflowsDir, name + '.yaml'), yamlText, 'utf8');
    const run = await runWorkflowOnArchon(name, t.objective, archon, archon.timeoutMs);
    // An unreadable read is NOT a verdict on the candidate. UNAVAILABLE (the
    // read could not be completed), ABSENT (Archon answered and named no run)
    // and MALFORMED (a record came back unusable) are their own outcomes: no
    // revision is consumed, nothing is recorded as the candidate's failure, and
    // objective evaluation never runs on evidence we could not read (so it can
    // never report executionCompleted:false "caused by" the candidate). Fail
    // closed — an outage still never yields a promotion.
    if (UNREADABLE_RUN_STATUSES.has(run.status)) {
      t.attempts.push({ rev: revision, stage: 'execute', at: isoNow(), yaml_sha256: currentHash, name, run: { run_id: run.runId, status: run.status }, outcome: run.status, reason: run.reason || null, objective_eval: null });
      return outage(run.status, run.reason || ('Archon read outcome ' + run.status), { revision, attempts: t.attempts.length });
    }
    const evidence = run.outputs.join('\n');
    const markerOk = evidence.includes('learned-' + (name || '').replace(/-v0-1-0$/, '') + '-') || evidence.includes('learned-' + name + ':done');
    const objectiveEval = evaluateObjective({
      executionCompleted: run.status === 'completed',
      capabilityValidation: { pass: run.status === 'completed' && markerOk },
      evaluator: src.objectiveEvaluation || null,
      evidenceText: evidence,
    });
    const attempt = {
      rev: revision, stage: 'execute', at: isoNow(), yaml_sha256: currentHash, name,
      run: { run_id: run.runId, status: run.status },
      output_sha256: sha256s(evidence),
      verification: { terminal_status: run.status === 'completed', marker: markerOk },
      objective_eval: objectiveEval,
    };
    t.evaluations.push({ caseId: 'originating-task', runId: run.runId, status: run.status, pass: run.status === 'completed' && markerOk && objectiveEval.pass, reason: objectiveEval.reason || null });
    t.attempts.push(attempt);
    await upsertTask(t);

    if (run.status === 'completed' && markerOk && objectiveEval.pass) {
      // ---- CANDIDATE: promotion stays the explicit operator click ----
      t.verdict = 'CANDIDATE';
      t.status = 'candidate';
      t.candidate = {
        capabilityId: (name || 'learned-capability').replace(/-v0-1-0$/, ''),
        version: '0.1.0',
        workflow: name,
        requires: ['filesystem:read', 'shell:execute'],
        requiresUnknown: [],
        verification: { expectOutput: `learned-${name}:done`, terminalStatus: 'completed' },
        provides: routing.description,
        routingVocabulary: routing.tags,
        evidence: { runId: run.runId, objectiveEval: objectiveEval.reason || 'objective evaluation passed' },
      };
      t.nextAction = { kind: 'promote', label: 'Promote to Intelligence', reason: 'The candidate satisfied the originating objective on the real workspace and passed independent objective evaluation (revision ' + revision + '). Promotion needs your explicit approval.' };
      t.endedAt = isoNow();
      await upsertTask(t);
      return { ok: true, teaching: t };
    }

    lastFailure = {
      stage: 'execute',
      runStatus: run.status,
      outputs: evidence,
      evalReason: objectiveEval.reason || (markerOk ? 'objective not satisfied' : 'expectation marker not found in evidence'),
    };
  }
}
