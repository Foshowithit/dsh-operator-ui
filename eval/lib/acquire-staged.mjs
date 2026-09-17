#!/usr/bin/env node
// eval/lib/acquire-staged.mjs — Acquisition v3 staged-gate loop (GPT
// ruling on Revision Experiment #1):
//
//   ADMIT -> DEVELOPMENT/DIAGNOSTIC -> REVISION -> REGRESSION -> FRESH
//   PROMOTION EVAL
//
// Gates E1 (admission), E2 (diagnostic/revision), E3 (regression
// challenge) are learning-permitted: a gate failure's REDACTED evidence
// (failure category, the candidate's own outputs, artifact paths, static
// codes — never expected values) may drive a bounded revision. After each
// revision the candidate must re-earn ALL gates from E1 (regression).
// E4 is sacred: generated/frozen beforehand, never exposed to the loop in
// any form, exactly ONE terminal evaluation — PASS permits promotion,
// FAIL refuses the episode. No revision from E4.
//
// Budget (M3-SPEC §2.2, conjunctive): model calls >= 4 (1 compose + 3
// revisions) OR output_tokens >= 50,000 OR wall >= 10 min -> REFUSED.
// Byte-identical revision -> REFUSED/REVISION_LOOP.
//
// Provenance: every candidate persisted as its own file; per attempt:
// parent hash, candidate hash, prompt hash, model usage, static result,
// Archon run ID/status, grader category (what the model saw) AND full
// grader detail (what the record keeps — the model never sees it).

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { staticChecks } from './static-checks.mjs';

const sha256s = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Grader-failure CATEGORY only — the frozen graders' details carry want/got
// (expected answers); the revision channel must never see them.
function categoryOf(detail) {
  if (!detail) return 'result-substance mismatch';
  const cut = String(detail).split(/\bwant\b|\(expected|\bexpected\b|:/)[0].trim();
  return cut || 'result-substance mismatch';
}

export const DEFAULT_STAGED_BUDGET = { maxAttempts: 4, maxOutputTokens: 50000, maxWallMs: 600000, maxRevisions: 3 };

export function createStagedAcquirer(opts) {
  const {
    think,
    archon = 'http://127.0.0.1:13091',
    workflowsDir,
    executionWorkspace,
    stageWorkspace,
    budget = DEFAULT_STAGED_BUDGET,
    log = () => {},
    runPrefix = 'rcos-acqv3-',
    evidenceDir = null,
  } = opts;

  const persist = evidenceDir ? async (fname, body) => {
    try { await mkdir(evidenceDir, { recursive: true }); await writeFile(join(evidenceDir, fname), body, 'utf8'); } catch {}
  } : null;

  async function runWorkflowOnWorkspace(name, message) {
    await sleep(2500);
    let started = false;
    for (let i = 0; i < 3 && !started; i++) {
      try {
        const post = await fetch(archon + '/api/workflows/' + encodeURIComponent(name) + '/run', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message, conversationId: runPrefix + Date.now() }),
        });
        if (post.ok) started = true;
      } catch { /* retry */ }
      if (!started) await sleep(2000);
    }
    if (!started) return { status: 'NO_RUN', outputs: '', run_id: null };
    const listRun = async () => {
      try {
        const lb = await (await fetch(archon + '/api/workflows/runs?limit=10')).json();
        return (lb.runs || []).find((x) => x.workflow_name === name) || null;
      } catch { return null; }
    };
    const deadline = Date.now() + 90000;
    let entry = null;
    while (Date.now() < deadline) {
      await sleep(2000);
      entry = await listRun();
      if (entry && ['completed', 'failed', 'error', 'cancelled'].includes(String(entry.status || '').toLowerCase())) break;
    }
    if (!entry) return { status: 'NO_RUN', outputs: '', run_id: null };
    let detail = null;
    try { detail = await (await fetch(archon + '/api/workflows/runs/' + entry.id)).json(); } catch {}
    const outputs = ((detail && detail.events) || [])
      .map((e) => (e.data || {}).node_output || (e.data || {}).output || '')
      .filter(Boolean).join('\n');
    return { status: String(entry.status || 'UNKNOWN').toLowerCase(), outputs, run_id: entry.id };
  }

  async function workspaceSnapshot(dir) {
    const files = [];
    async function walk(d, rel) {
      let list = [];
      try { list = await readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) await walk(join(d, e.name), r);
        else {
          let body = null;
          try { const b = await readFile(join(d, e.name)); if (b.length <= 65536) body = b.toString('utf8'); } catch {}
          files.push({ path: r, bytes: body === null ? null : Buffer.byteLength(body), body });
        }
      }
    }
    await walk(dir, '');
    return files;
  }

  function composePrompt(objective, sampleFiles) {
    const sample = Object.entries(sampleFiles).map(([n, c]) => `--- ${n} ---\n${c}`).join('\n');
    return `You are RCOS's capability-acquisition step. An objective could not be routed: no existing capability matches.

OBJECTIVE: ${objective}

A sample of the workspace it must run in (cwd = workspace root):
${sample}

Compose ONE candidate workflow in Archon YAML. STRICT SCHEMA (this exact dialect):
- top-level keys: name, description, nodes
- name: lowercase, hyphenated, end with -v0-1-0
- each node: { id, bash: <shell script>, depends_on: [ids] (optional) }
- nodes run with cwd = the workspace root
- ARTIFACT-LOCATION CONTRACT: write every file INSIDE the workspace (relative paths only). Never write to /tmp, /, ~, or any absolute path, and never via ../.
- The workflow receives the objective text in the environment variable USER_MESSAGE — parse any per-run parameters (thresholds, file names, options) from it at run time so the capability generalizes across workspaces of this kind.
- The LAST node must echo an expectation marker line: learned-<name>:done
- The workflow must print OPERATOR-LEGIBLE result lines (labeled, not raw dumps): include the word RESULT in each result line, e.g. 'RESULT key=value'
- Deterministic shell (sh-compatible), no network, no credentials.
- Generic across workspaces of this KIND: do not hardcode this exact file's contents or values.

Also provide ROUTING VOCABULARY: copy the distinctive CONTENT WORDS from the objective VERBATIM (exact singular/plural forms as used, including file-format and file-name words), plus 2-3 closely related lowercase words.

Reply with EXACTLY two fenced blocks:
1. a yaml code block containing the workflow
2. a json code block: {"description": "<one sentence>", "tags": ["word", ...]}`;
  }

  function diagnosePrompt(ctx) {
    const { gateObjective, prevYaml, checksText, runStatus, outputs, graderCategory, wsFilePaths, requiredName } = ctx;
    const ev = [];
    ev.push(`The candidate workflow you composed FAILED its evaluation for this objective. Diagnose from the evidence and produce a REVISED candidate.`);
    ev.push(`OBJECTIVE: ${gateObjective}`);
    ev.push(`YOUR PREVIOUS CANDIDATE:\n\`\`\`yaml\n${prevYaml}\`\`\``);
    if (ctx.failureKind === 'static') {
      ev.push(`STATIC CHECK FAILURES (the candidate was never executed):\n${checksText}`);
    } else {
      ev.push(`WORKFLOW RUN STATUS: ${runStatus}`);
      ev.push(`YOUR PRODUCED NODE OUTPUTS (verbatim):\n${String(outputs).slice(0, 4000) || '(none captured)'}`);
      ev.push(`POST-RUN WORKSPACE FILES: ${(wsFilePaths || []).join(', ') || '(none)'}`);
      ev.push(`EXTERNAL GRADER CATEGORY: ${graderCategory} — the objective's declared result contract was not met. Compare your produced output (above) against the objective text yourself; expected values are not provided.`);
    }
    ev.push(`RULES:
- Fix the ACTUAL defect the evidence points to. Do not restate the same strategy.
- Keep the STRICT SCHEMA and the ARTIFACT-LOCATION CONTRACT (relative paths only, all writes inside the workspace).
- The revised workflow MUST be named ${requiredName} and its LAST node must echo: learned-${requiredName}:done
- Output contract: operator-legible lines containing the word RESULT.
- The capability must GENERALIZE: it receives the objective text in $USER_MESSAGE at run time — parse parameters (thresholds, file names, options) from it; handle format variations the objective describes (quoting, comments, case folding, extra files, '=' inside values).`);
    ev.push(`Reply with EXACTLY two fenced blocks:
1. a yaml code block containing the REVISED workflow
2. a json code block: {"description": "<one sentence>", "tags": ["word", ...]}`);
    return ev.join('\n\n');
  }

  function parseReply(text) {
    const ym = text.match(/```yaml\n([\s\S]*?)(?:```|$)/) || text.match(/```\n([\s\S]*?)(?:```|$)/);
    const jm = text.match(/```json\n([\s\S]*?)```/);
    let routing = { description: 'LEARNED capability (staged acquisition)', tags: [] };
    if (jm) { try { const j = JSON.parse(jm[1]); routing = { description: String(j.description || routing.description), tags: (j.tags || []).map((t) => String(t).toLowerCase()) }; } catch {} }
    return { yaml: ym ? ym[1] : null, routing };
  }

  /**
   * acquireStaged(): E1→E2→E3 gate chain with full re-earning after every
   * revision, then the single sacred E4 terminal evaluation.
   * @param {object} p
   *   family: 'D03' etc.
   *   gates: [{ enc, dir, objective, expected, grader, sampleFiles }] — E1,E2,E3
   *   terminal: { enc, dir, objective, expected, grader } — E4
   */
  async function acquireStaged(p) {
    const started = Date.now();
    const usage = { input_tokens: 0, output_tokens: 0, model_calls: 0, wall_ms: 0 };
    const attempts = [];
    const baseTag = 'acq3-' + p.family.toLowerCase() + '-' + Date.now().toString(36);
    // candidate state (current = latest STATIC-CLEAN candidate)
    let yamlText = null, routing = null, name = null, currentHash = null;
    // last failure evidence (drives the next diagnosis; never expected values)
    let lastFailure = null; // { gate, kind:'static'|'execution'|'parse', gateObjective, checksText, runStatus, outputs, wsFilePaths, graderCategory }
    let terminal = null;
    let revisions = 0;
    let frontier = 0;

    const meter = (u, wall) => {
      usage.input_tokens += u.input_tokens || 0;
      usage.output_tokens += u.output_tokens || 0;
      usage.model_calls += 1;
      usage.wall_ms += wall || 0;
    };
    const budgetHit = () => {
      if (usage.model_calls >= budget.maxAttempts) return `attempts ${usage.model_calls} ≥ ${budget.maxAttempts}`;
      if (usage.output_tokens >= budget.maxOutputTokens) return `output_tokens ${usage.output_tokens} ≥ ${budget.maxOutputTokens}`;
      if (Date.now() - started >= budget.maxWallMs) return `wall ${Date.now() - started}ms ≥ ${budget.maxWallMs}ms`;
      return null;
    };
    const ref = (code, extra) => ({ status: 'REFUSED', code, revisions, frontier, ...extra });

    const acceptCandidate = async (yaml, promptSha, reply, rev, gateLabel, parentHash, staticFailures) => {
      const hash = sha256s(yaml);
      if (persist) await persist(`${p.family}-rev${rev}-${hash.slice(7, 19)}.yaml`, yaml);
      return { hash };
    };

    while (true) {
      const b = budgetHit();

      // ---- PRODUCE phase: no valid candidate → compose or revise ----
      if (!yamlText) {
        if (b) { terminal = ref('BUDGET_EXHAUSTED', { detail: b }); break; }
        const gate0 = p.gates[0];
        const prompt = composePrompt(gate0.objective, gate0.sampleFiles);
        let reply;
        try { reply = await think(prompt); }
        catch (e) { terminal = ref('MODEL_ERROR', { detail: String(e.message).slice(0, 200) }); break; }
        meter(reply.usage || {}, reply.wall_ms);
        const parsed = parseReply(reply.text || '');
        const attempt = { rev: 0, gate: 'compose', parentHash: null, at: new Date().toISOString(), prompt_sha256: sha256s(prompt), model: reply.usage || {} };
        if (!parsed.yaml) { attempt.failureKind = 'parse'; attempts.push(attempt); continue; }
        const checks = staticChecks(parsed.yaml);
        yamlText = parsed.yaml; routing = parsed.routing;
        name = (yamlText.match(/^name:\s*(\S+)/m) || [])[1] || null;
        currentHash = sha256s(yamlText);
        if (persist) await persist(`${p.family}-rev0-${currentHash.slice(7, 19)}.yaml`, yamlText);
        if (!checks.ok) {
          attempt.failureKind = 'static'; attempt.staticFailures = checks.failures; attempt.yaml_sha256 = currentHash; attempt.name = name;
          attempts.push(attempt);
          lastFailure = { gate: 'static', kind: 'static', gateObjective: gate0.objective, checksText: checks.failures.map((f) => `- ${f.code}: ${f.detail}`).join('\n') };
          log(`rev0 static-fail: ${checks.failures.map((f) => f.code).join(',')}`);
          continue;
        }
        attempt.failureKind = null; attempt.yaml_sha256 = currentHash; attempt.name = name;
        attempts.push(attempt);
        continue; // valid candidate → gates run below
      }

      // ---- revise phase (a failure is pending) ----
      if (lastFailure) {
        const b2 = budgetHit();
        if (revisions >= budget.maxRevisions || b2) {
          terminal = ref(b2 ? 'BUDGET_EXHAUSTED' : 'REVISIONS_EXHAUSTED', { detail: b2 || `revisions ${revisions} ≥ ${budget.maxRevisions}`, failedGate: lastFailure.gate, lastCategory: lastFailure.graderCategory || null });
          break;
        }
        const revision = revisions + 1;
        const prompt = diagnosePrompt({
          gateObjective: lastFailure.gateObjective || p.gates[0].objective,
          prevYaml: yamlText,
          failureKind: lastFailure.kind,
          checksText: lastFailure.checksText || '',
          runStatus: lastFailure.runStatus,
          outputs: lastFailure.outputs,
          graderCategory: lastFailure.graderCategory,
          wsFilePaths: lastFailure.wsFilePaths || [],
          requiredName: `${baseTag}-r${revision}-v0-1-0`,
        });
        let reply;
        try { reply = await think(prompt); }
        catch (e) { terminal = ref('MODEL_ERROR', { detail: String(e.message).slice(0, 200) }); break; }
        meter(reply.usage || {}, reply.wall_ms);
        log(`revision #${revision} for ${lastFailure.gate} (out=${reply.usage?.output_tokens ?? '?'})`);
        const parsed = parseReply(reply.text || '');
        const attempt = { rev: revision, gate: lastFailure.gate, parentHash: currentHash, at: new Date().toISOString(), prompt_sha256: sha256s(prompt), model: reply.usage || {} };
        if (!parsed.yaml) { attempt.failureKind = 'parse'; attempts.push(attempt); continue; }
        const newHash = sha256s(parsed.yaml);
        if (newHash === currentHash) { terminal = ref('REVISION_LOOP', { detail: `revision ${revision} byte-identical to previous candidate` }); break; }
        const checks = staticChecks(parsed.yaml);
        yamlText = parsed.yaml; routing = parsed.routing;
        name = (yamlText.match(/^name:\s*(\S+)/m) || [])[1] || name;
        currentHash = newHash;
        revisions = revision;
        if (persist) await persist(`${p.family}-rev${revision}-${newHash.slice(7, 19)}.yaml`, yamlText);
        if (!checks.ok) {
          attempt.failureKind = 'static'; attempt.staticFailures = checks.failures; attempt.yaml_sha256 = newHash; attempt.name = name;
          attempts.push(attempt);
          lastFailure = { gate: 'static', kind: 'static', gateObjective: lastFailure.gateObjective, checksText: checks.failures.map((f) => `- ${f.code}: ${f.detail}`).join('\n') };
          continue;
        }
        attempt.failureKind = null; attempt.yaml_sha256 = newHash; attempt.name = name;
        attempts.push(attempt);
        frontier = 0; // REGRESSION: the new candidate re-earns all gates
        lastFailure = null;
        continue;
      }

      // ---- EVALUATE phase: run the frontier gate with the valid candidate ----
      if (b) { terminal = ref('BUDGET_EXHAUSTED', { detail: b }); break; }
      const gate = p.gates[frontier];
      await stageWorkspace(gate.dir);
      await writeFile(join(workflowsDir, name + '.yaml'), yamlText, 'utf8');
      const run = await runWorkflowOnWorkspace(name, gate.objective);
      const wsFiles = await workspaceSnapshot(executionWorkspace);
      // Evidence = the run's node outputs. (Defect fix, exp-612462ae: the
      // former outputs+workspace-bodies join double-counted candidates that
      // both print RESULT lines and write them to a workspace file, so
      // ordered-list graders saw every pair twice and misgraded correct
      // candidates. wsFiles stay available to file-state graders and the
      // provenance trail.)
      const evidence = run.outputs;
      const grade = gate.grader(gate.expected, evidence, wsFiles);
      const cat = categoryOf(grade.detail);
      log(`rev${revisions} gate ${gate.enc}: run=${run.status} ${grade.satisfied ? 'PASS' : 'FAIL'} (${cat})`);
      attempts.push({
        rev: revisions, gate: gate.enc, failureKind: grade.satisfied ? null : 'execution',
        yaml_sha256: currentHash, parentHash: null, name,
        run: { workflow: name, run_id: run.run_id, status: run.status },
        outputs: String(run.outputs).slice(0, 4000),
        wsFilePaths: wsFiles.map((f) => f.path),
        grader: grade, graderCategory: cat,
        at: new Date().toISOString(),
      });
      if (grade.satisfied) {
        frontier += 1;
        if (frontier >= p.gates.length) break; // all gates earned → E4
        continue;
      }
      lastFailure = {
        gate: gate.enc, kind: 'execution', gateObjective: gate.objective,
        runStatus: run.status, outputs: run.outputs,
        wsFilePaths: wsFiles.map((f) => f.path),
        graderCategory: cat,
      };
      // loop → revise phase
    }
    if (frontier >= p.gates.length && (!terminal || terminal.status !== 'REFUSED')) {
      // ---- SACRED TERMINALS: one evaluation each, in order, never feeds
      // back. Promotion requires EVERY terminal to pass in this same
      // candidate version (GPT breadth ruling: >= 2 unseen proofs). ----
      const terminals = p.terminals || (p.terminal ? [p.terminal] : []);
      const terminalRuns = [];
      let allPass = true;
      for (const t of terminals) {
        await stageWorkspace(t.dir);
        await writeFile(join(workflowsDir, name + '.yaml'), yamlText, 'utf8');
        const run = await runWorkflowOnWorkspace(name, t.objective);
        const wsFiles = await workspaceSnapshot(executionWorkspace);
        const evidence = run.outputs; // same defect fix as the gate phase
        const grade = t.grader(t.expected, evidence, wsFiles);
        terminalRuns.push({ gate: t.enc, run_id: run.run_id, status: run.status, satisfied: grade.satisfied, detail: grade.detail });
        attempts.push({
          rev: revisions, gate: t.enc, failureKind: grade.satisfied ? null : 'terminal',
          yaml_sha256: currentHash, parentHash: null, name,
          run: { workflow: name, run_id: run.run_id, status: run.status },
          outputs: String(run.outputs).slice(0, 4000),
          grader: grade,
          at: new Date().toISOString(),
        });
        log(`${t.enc} TERMINAL: run=${run.status} ${grade.satisfied ? 'PASS' : 'FAIL'}`);
        if (!grade.satisfied) { allPass = false; break; } // remaining terminals unexposed? NO: each is one shot; a failed first terminal refuses the episode
      }
      terminal = allPass
        ? { status: 'CANDIDATE_READY', terminalRuns }
        : { status: 'REFUSED', code: 'TERMINAL_FAILED', detail: 'a sacred terminal evaluation failed — no revision permitted', terminalRuns };
    }

    return {
      terminal, attempts, usage, revisions,
      candidate: terminal.status === 'CANDIDATE_READY' ? {
        name, yaml_sha256: currentHash, yaml: yamlText, routing,
        verification: { expectOutput: `learned-${name}:done`, terminalStatus: 'completed' },
        required_authority: ['filesystem:read', 'shell:execute'],
        provenance: { builtBy: 'rcos-acquisition-v3-staged', family: p.family, revisions, model: usage },
      } : null,
    };
  }

  return { acquireStaged, runWorkflowOnWorkspace, workspaceSnapshot };
}
