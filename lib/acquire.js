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
//     → independent objective evaluation (lib/goal.js evaluateObjective —
//       the M1 adjudicator, never the acquisition's own opinion)
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

import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { resolveConfig } from './config.js';
import { getTask, upsertTask } from './tasks.js';
import { evaluateObjective } from './goal.js';

const sha256s = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const isoNow = () => new Date().toISOString();

export const ACQ_BUDGET = { maxRevisions: 3, maxCalls: 4, maxOutputTokens: 50000, maxWallMs: 600000 };

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
async function runWorkflowOnArchon(workflow, message, archon, timeoutMs) {
  await new Promise((r) => setTimeout(r, 2500)); // catalog hot-reload
  let started = false;
  for (let i = 0; i < 3 && !started; i++) {
    try {
      const res = await fetch(archon.baseUrl.replace(/\/$/, '') + '/api/workflows/' + encodeURIComponent(workflow) + '/run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, conversationId: 'rcos-acquire-' + Date.now() }),
      });
      if (res.ok) started = true;
    } catch { /* retry */ }
    if (!started) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!started) return { status: 'NO_RUN', outputs: [], runId: null };
  const findRun = async () => {
    try {
      const lb = await (await fetch(archon.baseUrl.replace(/\/$/, '') + '/api/workflows/runs?limit=10')).json();
      return (lb.runs || []).find((x) => x.workflow_name === workflow) || null;
    } catch { return null; }
  };
  const deadline = Date.now() + (timeoutMs || 90000);
  let entry = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    entry = await findRun();
    if (entry && ['completed', 'failed', 'error', 'cancelled'].includes(String(entry.status || '').toLowerCase())) break;
  }
  if (!entry) return { status: 'NO_RUN', outputs: [], runId: null };
  let detail = null;
  try { detail = await (await fetch(archon.baseUrl.replace(/\/$/, '') + '/api/workflows/runs/' + entry.id)).json(); } catch {}
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
    provenance: { builtBy: 'acquisition-v2 (production port of the sealed program 7b5c9cc)', mechanism: 'compose → static → execute → evaluate → revise ≤3' },
    attempts: [],
    evaluations: [],
    nextAction: { kind: 'inspect', label: 'Acquisition running', reason: 'Composing a candidate capability for this objective.' },
  };
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
    const evidence = run.outputs.join('\n');
    const markerOk = evidence.includes('learned-' + (name || '').replace(/-v0-1-0$/, '') + '-') || evidence.includes('learned-' + name + ':done');
    const objectiveEval = evaluateObjective(t.objective, evidence);
    const attempt = {
      rev: revision, stage: 'execute', at: isoNow(), yaml_sha256: currentHash, name,
      run: { run_id: run.runId, status: run.status },
      output_sha256: sha256s(evidence),
      verification: { terminal_status: run.status === 'completed', marker: markerOk },
      objective_eval: objectiveEval,
    };
    t.evaluations.push({ caseId: 'originating-task', runId: run.runId, status: run.status, pass: run.status === 'completed' && markerOk && objectiveEval.pass, reason: objectiveEval.detail || null });
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
        evidence: { runId: run.runId, objectiveEval: objectiveEval.detail || 'objective evaluation passed' },
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
      evalReason: objectiveEval.detail || (markerOk ? 'objective not satisfied' : 'expectation marker not found in evidence'),
    };
  }
}
