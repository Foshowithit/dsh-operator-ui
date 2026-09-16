#!/usr/bin/env node
// eval/lib/acquire-v2.mjs — CapabilityAcquirer v2 (M3.1).
//
// The v1 loop was MODEL → candidate → evaluate → fail → refuse. The sealed
// run's failure-class decomposition (eval/ACQ-V2-FAILURE-CLASSES.md) showed
// the dominant classes were grader-side, and the loop had no revision.
// v2 implements GPT's prescribed loop:
//
//   MODEL → candidate → STATIC CHECKS → execute isolated → grade the
//   EXECUTION WORKSPACE → on failure: evidence-bundle → diagnose →
//   MATERIALLY revise → re-execute → held-out evaluation → CANDIDATE
//   (promotion stays an explicit operator action downstream)
//
// Budgets (M3-SPEC §2.2, conjunctive hard ceilings): attempts ≥ 4 OR
// output_tokens ≥ 50,000 OR wall ≥ 10 min → terminal REFUSED with
// BUDGET_EXHAUSTED. Revision loop detection: a revision whose yaml hash
// equals the previous candidate is REFUSED with REVISION_LOOP.
//
// The model backend is pluggable (`think`): muse-lane responses API
// (proven in v1) or a headless DSH session (the M3.1 spec backend) behind
// the same interface. Every think() call is metered as teaching cost.

import { readFile, writeFile, rm, readdir, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { staticChecks, renderFailures } from './static-checks.mjs';

const sha256s = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_BUDGET = { maxAttempts: 4, maxOutputTokens: 50000, maxWallMs: 600000, maxRevisions: 3 };

export function createAcquirer(opts) {
  const {
    think,                       // async (prompt) → { text, usage:{input_tokens,output_tokens}, wall_ms }
    archon = 'http://127.0.0.1:13091',
    workflowsDir,                // Archon hot-reload dir
    executionWorkspace,          // the dir Archon workflows run in (cwd)
    stageWorkspace,              // async (fromDir) → stages a fixture INTO executionWorkspace
    budget = DEFAULT_BUDGET,
    log = () => {},
    runPrefix = 'rcos-acqv2-',   // conversationId prefix (teaching-cost accounting)
    evidenceDir = null,          // if set, every candidate + failure trail is persisted here
  } = opts;

  const persist = evidenceDir ? async (fname, body) => {
    try { await mkdir(evidenceDir, { recursive: true }); await writeFile(join(evidenceDir, fname), body, 'utf8'); } catch {}
  } : null;

  async function runWorkflowOnWorkspace(name, message = 'candidate evaluation') {
    // Returns { status, outputs, run_id }. Facts proven by probe:
    // - POST /run returns only {accepted,status:"started"} — no run id —
    //   and a freshly written workflow may not be in the catalog for a
    //   few seconds, so the POST is retried on failure.
    // - The runs LIST carries the authoritative status (newest first);
    //   the run DETAIL endpoint returns events but status:null — so the
    //   list is polled to terminal, then detail supplies outputs.
    await sleep(2500); // Archon catalog hot-reload (~2s, proven)
    let started = false;
    for (let i = 0; i < 3 && !started; i++) {
      try {
        const post = await fetch(archon + '/api/workflows/' + encodeURIComponent(name) + '/run', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message, conversationId: runPrefix + Date.now() }),
        });
        if (post.ok) started = true;
      } catch { /* transient; retry */ }
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
    const status = String(entry.status || 'UNKNOWN').toLowerCase();
    return { status, outputs, run_id: entry.id };
  }

  async function workspaceSnapshot(dir) {
    // Post-run snapshot of the EXECUTION workspace (never the staging copy):
    // relative file list + small-file contents, for file-state graders and
    // provenance. This is the countermeasure to the v1 grader-location
    // defect (4 provably-correct candidates misgraded from the wrong dir).
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
- ARTIFACT-LOCATION CONTRACT: write every file INSIDE the workspace (relative paths only). Never write to /tmp, /, ~, or any absolute path, and never via ../. Scratch files also stay in the workspace.
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
    const { objective, prevYaml, failureKind, checks, runStatus, outputs, graderDetail, snapshot } = ctx;
    const ev = [];
    ev.push(`The candidate workflow you composed for this objective FAILED. Diagnose from the evidence and produce a REVISED candidate.`);
    ev.push(`OBJECTIVE: ${objective}`);
    ev.push(`YOUR PREVIOUS CANDIDATE:\n\`\`\`yaml\n${prevYaml}\`\`\``);
    if (failureKind === 'static') {
      ev.push(`STATIC CHECK FAILURES (the candidate was never executed):\n${renderFailures(checks)}`);
    } else {
      ev.push(`WORKFLOW RUN STATUS: ${runStatus}`);
      ev.push(`NODE OUTPUTS (verbatim):\n${String(outputs).slice(0, 4000) || '(none captured)'}`);
      ev.push(`EXTERNAL GRADER VERDICT: ${graderDetail}`);
      if (snapshot && snapshot.length) {
        ev.push(`POST-RUN WORKSPACE FILES: ${snapshot.map((f) => f.path).join(', ')}`);
      }
    }
    ev.push(`RULES:
- Fix the ACTUAL defect the evidence points to. Do not restate the same strategy.
- Keep the STRICT SCHEMA and the ARTIFACT-LOCATION CONTRACT (relative paths only, all writes inside the workspace).
- The revised workflow MUST be named ${ctx.requiredName} and its LAST node must echo: learned-${ctx.requiredName}:done
- Output contract: operator-legible lines containing the word RESULT.`);
    ev.push(`Reply with EXACTLY two fenced blocks:
1. a yaml code block containing the REVISED workflow
2. a json code block: {"description": "<one sentence>", "tags": ["word", ...]}`);
    return ev.join('\n\n');
  }

  function parseReply(text) {
    const ym = text.match(/```yaml\n([\s\S]*?)(?:```|$)/) || text.match(/```\n([\s\S]*?)(?:```|$)/);
    const jm = text.match(/```json\n([\s\S]*?)```/);
    let routing = { description: 'LEARNED capability (acquisition v2)', tags: [] };
    if (jm) { try { const j = JSON.parse(jm[1]); routing = { description: String(j.description || routing.description), tags: (j.tags || []).map((t) => String(t).toLowerCase()) }; } catch {} }
    return { yaml: ym ? ym[1] : null, routing };
  }

  /**
   * acquire(): run the bounded loop for ONE family against ONE admitting
   * fixture, then evaluate the surviving candidate on held-out fixtures.
   *
   * @param {object} p
   * @param {string} p.objective — the admitting objective text
   * @param {string} p.family — family code (e.g. 'D01')
   * @param {object} p.sampleFiles — { filename: contents } of the admitting workspace
   * @param {string} p.admittingDir — fixture workspace dir to stage for the admitting run
   * @param {Function} p.grader — (expected, evidenceText, wsFiles) → {satisfied, detail}
   * @param {object} p.expected — expected.json of the admitting fixture
   * @param {Array} p.heldOut — [{ dir, expected }] freshly-generated never-admitting fixtures
   */
  async function acquire(p) {
    const started = Date.now();
    const usage = { input_tokens: 0, output_tokens: 0, model_calls: 0, wall_ms: 0 };
    const attempts = [];       // per-revision provenance trail
    const baseTag = 'acq2-' + p.family.toLowerCase() + '-' + Date.now().toString(36);
    let prevYaml = null;
    let prevHash = null;
    let yamlText = null, routing = null, name = null;
    let terminal = null;

    const budgetHit = () => {
      if (usage.model_calls >= budget.maxAttempts) return `attempts ${usage.model_calls} ≥ ${budget.maxAttempts}`;
      if (usage.output_tokens >= budget.maxOutputTokens) return `output_tokens ${usage.output_tokens} ≥ ${budget.maxOutputTokens}`;
      if (Date.now() - started >= budget.maxWallMs) return `wall ${Date.now() - started}ms ≥ ${budget.maxWallMs}ms`;
      return null;
    };

    const meter = (u, wall) => {
      usage.input_tokens += u.input_tokens || 0;
      usage.output_tokens += u.output_tokens || 0;
      usage.model_calls += 1;
      usage.wall_ms += wall || 0;
    };

    while (!terminal) {
      const b = budgetHit();
      if (b) { terminal = { status: 'REFUSED', code: 'BUDGET_EXHAUSTED', detail: b }; break; }

      const revision = attempts.filter((a) => a.kind === 'revision').length;
      let prompt, kind;
      if (!prevYaml) { prompt = composePrompt(p.objective, p.sampleFiles); kind = 'initial'; }
      else {
        kind = 'revision';
        prompt = diagnosePrompt({
          objective: p.objective, prevYaml, failureKind: attempts[attempts.length - 1].failureKind,
          checks: attempts[attempts.length - 1].staticFailures,
          runStatus: attempts[attempts.length - 1].runStatus,
          outputs: attempts[attempts.length - 1].outputs,
          graderDetail: attempts[attempts.length - 1].graderDetail,
          snapshot: attempts[attempts.length - 1].wsFiles,
          requiredName: `${baseTag}-r${revision + 1}-v0-1-0`,
        });
      }

      let reply;
      try { reply = await think(prompt); } catch (e) {
        terminal = { status: 'REFUSED', code: 'MODEL_ERROR', detail: String(e.message).slice(0, 200) }; break;
      }
      meter(reply.usage || {}, reply.wall_ms);
      log(`[acq2 ${p.family}] ${kind} #${usage.model_calls} (${(reply.usage || {}).output_tokens ?? '?'} out tokens)`);

      const parsed = parseReply(reply.text || '');
      if (!parsed.yaml) {
        attempts.push({ rev: revision, kind, failureKind: 'parse', at: new Date().toISOString(), prompt_sha256: sha256s(prompt), model: { input_tokens: reply.usage?.input_tokens ?? null, output_tokens: reply.usage?.output_tokens ?? null } });
        const b2 = budgetHit();
        if (b2) { terminal = { status: 'REFUSED', code: 'BUDGET_EXHAUSTED', detail: b2 }; } 
        continue;
      }
      yamlText = parsed.yaml; routing = parsed.routing;
      const hash = sha256s(yamlText);
      if (prevHash && hash === prevHash) {
        terminal = { status: 'REFUSED', code: 'REVISION_LOOP', detail: 'revision ' + revision + ' is byte-identical to the previous candidate' };
        break;
      }

      const checks = staticChecks(yamlText);
      const nm = (yamlText.match(/^name:\s*(\S+)/m) || [])[1] || null;
      name = nm;
      if (persist) await persist(`${p.family}-rev${revision}-${hash.slice(7, 19)}.yaml`, yamlText);
      if (!checks.ok) {
        attempts.push({ rev: revision, kind, failureKind: 'static', staticFailures: checks.failures, yaml_sha256: hash, name: nm, at: new Date().toISOString(), prompt_sha256: sha256s(prompt), model: { input_tokens: reply.usage?.input_tokens ?? null, output_tokens: reply.usage?.output_tokens ?? null } });
        prevYaml = yamlText; prevHash = hash;
        const b2 = budgetHit();
        if (b2) terminal = { status: 'REFUSED', code: 'BUDGET_EXHAUSTED', detail: b2 };
        continue;
      }

      // execute on the admitting fixture (isolated: fresh workspace).
      // The objective travels as the run message — Archon exposes it to
      // nodes as $USER_MESSAGE, which is how one capability serves the
      // varying parameters (thresholds, file names) of its family.
      await stageWorkspace(p.admittingDir);
      await writeFile(join(workflowsDir, name + '.yaml'), yamlText, 'utf8');
      const run = await runWorkflowOnWorkspace(name, p.objective);
      const wsFiles = await workspaceSnapshot(executionWorkspace);
      const evidence = run.outputs + '\n' + wsFiles.map((f) => f.body || '').join('\n');
      const grade = p.grader(p.expected, evidence, wsFiles);
      attempts.push({
        rev: revision, kind, failureKind: grade.satisfied ? null : 'execution',
        yaml_sha256: hash, name: nm, staticFailures: [], at: new Date().toISOString(),
        prompt_sha256: sha256s(prompt),
        run: { workflow: name, run_id: run.run_id, status: run.status },
        outputs: String(run.outputs).slice(0, 4000),
        wsFiles: wsFiles.map((f) => f.path),
        grader: grade,
        model: { input_tokens: reply.usage?.input_tokens ?? null, output_tokens: reply.usage?.output_tokens ?? null },
      });
      log(`[acq2 ${p.family}] rev ${revision} run=${run.status} grader=${grade.satisfied ? 'PASS' : 'FAIL'} (${grade.detail})`);

      if (grade.satisfied) break; // admitting case green → held-out gate
      prevYaml = yamlText; prevHash = hash;
      const b2 = budgetHit();
      if (b2) terminal = { status: 'REFUSED', code: 'BUDGET_EXHAUSTED', detail: b2 };
    }

    if (!terminal || terminal.status !== 'REFUSED') {
      // Held-out evaluation gate: the FINAL candidate re-executes on freshly
      // generated fixtures it has never seen. Zero false promotions: any
      // held-out failure refuses promotion.
      const heldResults = [];
      let allPass = true;
      for (const [i, ho] of (p.heldOut || []).entries()) {
        await stageWorkspace(ho.dir);
        const run = await runWorkflowOnWorkspace(name, ho.objective || p.objective);
        const wsFiles = await workspaceSnapshot(executionWorkspace);
        const evidence = run.outputs + '\n' + wsFiles.map((f) => f.body || '').join('\n');
        const grade = p.grader(ho.expected, evidence, wsFiles);
        heldResults.push({ fixture: i + 1, run_status: run.status, run_id: run.run_id, satisfied: grade.satisfied, detail: grade.detail });
        if (!grade.satisfied) allPass = false;
        log(`[acq2 ${p.family}] held-out ${i + 1}: ${grade.satisfied ? 'PASS' : 'FAIL'} (${grade.detail})`);
      }
      if (!allPass) terminal = { status: 'REFUSED', code: 'HELD_OUT_FAILED', detail: 'candidate passed the admitting case but failed held-out evaluation', heldResults };
      else terminal = { status: 'CANDIDATE_READY', heldResults };
    }

    const finalAttempt = [...attempts.reverse()].find((a) => a.yaml_sha256);
    attempts.reverse();
    return {
      terminal,
      attempts,
      usage,
      candidate: terminal.status === 'CANDIDATE_READY' ? {
        name, yaml_sha256: finalAttempt?.yaml_sha256, yaml: yamlText,
        routing,
        verification: { expectOutput: `learned-${name}:done`, terminalStatus: 'completed' },
        required_authority: ['filesystem:read', 'shell:execute'],
        provenance: { builtBy: 'rcos-acquisition-v2', family: p.family, sourceTask: p.objective, revisions: attempts.length, model: usage },
      } : null,
    };
  }

  return { acquire, runWorkflowOnWorkspace, workspaceSnapshot };
}
