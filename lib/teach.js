// dsh-operator-ui — Teach Mode M2: capability ACQUISITION (GPT contract).
//
// Lifecycle: GAP → TEACH → BUILD → EVALUATE → CANDIDATE → PROMOTE → ROUTE.
// A no-route refusal or an objective-not-satisfied BLOCK is a GAP. "Teach
// RCOS" opens a TEACHING TASK — a separate durable task with its OWN
// identity; the source task is never mutated into a capability:
//
//   source_task_id     the task whose objective exposed the gap
//   teaching_task_id   the process of learning (this envelope, 'teach-…')
//   capability_id      the reusable intelligence produced IF learning
//                      succeeds (+ version, lifecycle CANDIDATE until the
//                      operator explicitly promotes it)
//
// HARD RULE (GPT): successful generation does NOT equal learned capability.
// BUILD composes a deterministic candidate workflow; EVALUATE then executes
// it on the real Archon against a held-out fixture set. Only when every
// case passes does the candidate OFFER promotion — and promotion is always
// an explicit human click. A candidate that fails any case is refused:
// "Couldn't learn this reliably … Not added to Intelligence." That failure
// path is as important as the happy path.
//
// Authority: the candidate DECLARES its required scopes before it can ever
// become routable — a generated capability cannot quietly acquire power.
// Provenance is permanently attached (built-by, source/teaching task,
// eval set, promoted-by/at, version).
//
// Writes (the ONLY ones this module makes, both under operator-configured
// paths): the candidate workflow YAML into teaching.workflowsDir, and
// per-eval fixture files into teaching.workspaceDir. Everything durable
// about the TEACHING itself lives in tasks.json (the task store) — no
// third store.

import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveConfig } from './config.js';
import { SCOPES } from './authority.js';
import { getTask, upsertTask, listTasks } from './tasks.js';

const isoNow = () => new Date().toISOString();
const sha256 = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');

// How long a DISPATCHED run may take to reach a terminal state before the
// candidate is judged on it. Named so the deadline and the operator-facing
// reason can never drift apart.
const TERMINAL_POLL_MS = 60000;

// How long a just-DISPATCHED run may take to APPEAR in the run list before we
// stop waiting for it — the write→read consistency wait, not a workload wait.
// Deliberately NOT shared with goal.js's ADOPTION_DEADLINE_MS or verify.js's
// discovery deadline even though all three are 10000 today: goal.js's adoption
// also proves multi-candidate linkage, so it may legitimately need a longer
// window, and a shared constant would silently constrain it. Named per site so
// the magic number is a stated fact; nothing couples the three.
const DISCOVERY_DEADLINE_MS = 10000;

// The INFRASTRUCTURE-attempt bound. A transient Archon outage is legitimately
// retryable, but the teaching envelope is minted fresh per invocation
// ('teach-…'), so no counter on the envelope alone can survive a retry — a
// permanent outage would retry forever with no terminal state. The count is
// therefore DERIVED from the durable store: prior teaching envelopes for the
// SAME source task that ended in an outage. At the limit the envelope becomes
// terminal with an INSPECT action — never REFUSED, because REFUSED would blame
// the capability for our inability to run it. No new persistence: tasks.json is
// the store and listTasks() is its read.
export const INFRA_ATTEMPT_LIMIT = 3;

// The THREE conditions that mean "the candidate never got a FAIR RUN": an outage
// (we could not reach/read Archon), an authoritative absence (Archon answered and
// named no such run), and a dispatch response Archon answered with but we could
// not read. All three are UNKNOWN and all three count toward the bound — none is
// a capability verdict. Mirrors lib/acquire.js, which classifies the same three
// conditions as UNAVAILABLE / ABSENT / MALFORMED; teach.js was the only one of
// the three modules turning them into a verdict.
//
// ONE table carries BOTH the outcome and the terminal action's label, so the
// label cannot drift from the outcome. The label matters: at the bound an
// ABSENT streak must NOT tell the operator to inspect Archon's availability —
// Archon ANSWERED, so availability is provably not the problem.
//
// CROSS-MODULE RULE: the same outcome must yield the same label for the same
// unreadable OBJECT; where the object differs the label must differ, and the
// difference must be commented. So MALFORMED appears here with a DIFFERENT label
// from lib/acquire.js's: acquire's points at 'Inspect the run record' because
// there a run DETAIL body was unreadable, whereas here the run never appeared at
// all (the DISPATCH response itself was unreadable), so there is no run record to
// inspect and that label would be a false pointer. Deliberately two local tables
// rather than a shared module — the outcome sets now coincide, but the labels
// legitimately differ per object, so sharing the strings would force one to lie.
const UNFAIR_RUN_OUTCOMES = {
  'archon-unavailable': { outcome: 'UNAVAILABLE', exhaustedLabel: 'Inspect Archon availability' },
  'run-not-found': { outcome: 'ABSENT', exhaustedLabel: 'Inspect the dispatch path' },
  'dispatch-malformed': { outcome: 'MALFORMED', exhaustedLabel: 'Inspect the dispatch response' },
};

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

function archonHeaders() {
  const { config } = resolveConfig();
  const headers = {};
  const tokenVar = config.archon.tokenVar;
  if (typeof tokenVar === 'string' && process.env[tokenVar]) headers.authorization = 'Bearer ' + process.env[tokenVar];
  return headers;
}

// ------------------------------------------------------------ eval fixtures
//
// The held-out eval set for M2's proof: workspace-wide word counting over
// deterministic fixture workspaces. Each case writes ITS OWN README.txt into
// the run workspace, executes the candidate on the real Archon, and compares
// the observed operator-legible evidence to the expected numbers. Cases are
// chosen to be distinct (1 line / many lines / unicode) so a one-file or
// hardcoding learner cannot pass by luck.
const EVAL_SET = [
  { id: 'eval-single-line', content: 'hello world\n', words: 2, lines: 1, bytes: 12 },
  { id: 'eval-multi-line', content: 'the quick brown fox\njumps over the lazy dog\nand rests\n', words: 11, lines: 3, bytes: 54 },
  { id: 'eval-unicode', content: 'café naïve — résumé\nsecond line here\n', words: 7, lines: 2, bytes: 43 },
];

// ------------------------------------------------------------------ BUILD
//
// Deterministic synthesis: the candidate measures EVERY *.txt file in the
// run workspace (the gap example-text-stats cannot close — it reads exactly
// one file) and reports per-file plus TOTAL counts, ending with the
// candidate's own expectation marker so the 3-check gate applies to it too.

function composeWorkflowYaml(capId, version) {
  const wfName = capId + '-v' + version.replace(/\./g, '-');
  const yaml = [
    '# LEARNED by RCOS teaching (M2) — candidate ' + capId + ' v' + version + '.',
    '# Composed deterministically by lib/teach.js; executed + evaluated on the',
    '# real Archon against a held-out fixture set BEFORE promotion was offered.',
    '',
    'name: ' + wfName,
    'description: >',
    '  LEARNED capability: counts lines, words, and bytes across EVERY .txt',
    '  file in the run workspace and reports per-file lines plus totals',
    '  (deterministic, zero-credential).',
    '',
    'nodes:',
    '  - id: measure-all',
    '    bash: >',
    '      total_lines=0; total_words=0; total_bytes=0; found=0;',
    '      for f in *.txt; do',
    '        [ -e "$f" ] || continue; found=1;',
    '        l=$(wc -l < "$f" | tr -d " ");',
    '        w=$(wc -w < "$f" | tr -d " ");',
    '        b=$(wc -c < "$f" | tr -d " ");',
    '        echo "file $f: Lines: $l Words: $w Bytes: $b";',
    '        total_lines=$((total_lines + l)); total_words=$((total_words + w)); total_bytes=$((total_bytes + b));',
    '      done;',
    '      if [ "$found" -eq 0 ]; then echo "no .txt files in workspace"; total_lines=0; total_words=0; total_bytes=0; fi;',
    '      echo "TOTAL Lines: $total_lines Words: $total_words Bytes: $total_bytes"',
    '',
    '  - id: report',
    '    depends_on: [measure-all]',
    '    bash: echo \'learned-' + capId + ':done\'',
    '',
  ].join('\n');
  return { wfName, yaml };
}

// --------------------------------------------------------------- dispatch

async function archonPost(path, body, timeoutMs) {
  const { config } = resolveConfig();
  const res = await fetch(config.archon.baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...archonHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(timeoutMs, 10000)),
  });
  // Carry the status AND the body: a 4xx must be diagnosable from the envelope,
  // not reduced to a bare "archon HTTP 400". The caller classifies on OUR
  // `httpStatus`, never on `e.code` — AbortSignal.timeout rejects with a
  // DOMException whose legacy `code` is the NUMBER 23, so an `e.code` string
  // comparison silently misses every transport failure.
  if (!res.ok) throw Object.assign(new Error('archon HTTP ' + res.status), { httpStatus: res.status, body: (await res.text().catch(() => '')).slice(0, 200) });
  // A 200 whose body cannot be parsed is a THIRD condition, distinct from both
  // "unreachable" and "refused": Archon ANSWERED and what it returned was
  // unreadable. Deliberately carries NO `httpStatus` — if a future reader
  // reorders the dispatch ladder, an absent status degrades to
  // `archon-unavailable` (same fail-safe direction, same streak behaviour)
  // rather than falling through to `dispatch-rejected`, which would name the
  // wrong cause AND silently END the infrastructure streak.
  try {
    return await res.json();
  } catch {
    throw Object.assign(new Error('Archon answered HTTP ' + res.status + ' but the dispatch response could not be read (invalid JSON)'), { malformed: true });
  }
}

async function archonGet(path, timeoutMs) {
  const { config } = resolveConfig();
  const res = await fetch(config.archon.baseUrl + path, { headers: archonHeaders(), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw Object.assign(new Error('archon HTTP ' + res.status), { httpStatus: res.status });
  return res.json();
}

// Run one workflow to terminal, discovering the run id from the run list
// (same acceptance contract as goal.js/verify.js: POST answers {accepted}).
//
// RC read-outcomes invariant (same discipline as goal.js fetchRunDetail /
// discoverRun): discovery and the terminal poll are Archon READS. A deadline
// reached with ZERO successful reads is an OUTAGE — never "Archon answered and
// named no run". Collapsing the two would seal a REFUSED teaching verdict (and
// burn the rest of the eval budget) for a capability that never got a fair run.
// An outage throws code `archon-unavailable`; a genuine absence — Archon
// answered and there is no such run — throws `run-not-found`.
//
// RC workspace-identity invariant (D3, 2026-09-26). The held-out eval PLANTS its
// fixture at `teaching.workspaceDir` and then reads the run's evidence. That is
// only meaningful if the run actually EXECUTED there, and nothing checked it.
// Measured against a real Archon (0.4.1): the web adapter gives EVERY dispatched
// run its own git worktree —
//   working_path = <archon-home>/workspaces/<cb>/worktrees/archon/thread-<id>
// — and a codebase cannot even be registered unless it is a git repo, so there
// is no configuration in which a web-dispatched run executes at the codebase's
// `default_cwd`. The fixture was therefore invisible to the candidate, every case
// observed zeros, and `_teach` sealed REFUSED with "Candidate succeeded 0/3
// evaluations" — a FALSE statement about the candidate, produced by an
// unverified precondition. Same defect class as the read collapses this module
// already fixes: the recorded verdict was not the thing that happened.
//
// The rule, and the asymmetry that keeps it honest:
//   - a working_path that is ABSENT (null/undefined/non-string) proves NOTHING —
//     an orchestrator that does not report one is UNVERIFIED, not mismatched, so
//     behaviour is unchanged (every fixture-less stub keeps working);
//   - a working_path that is PRESENT and differs ESTABLISHES the mismatch, and
//     that is a CONFIGURATION condition: not an outage, not the candidate's
//     failure, and not retryable without a config change.
async function runWorkflow(wfName, message, timeoutMs, expectedWorkspacePath) {
  const preIds = new Set();
  try {
    const lb = await archonGet('/api/workflows/runs?limit=50', timeoutMs);
    for (const r of (lb && lb.runs) || []) if (r && r.id) preIds.add(r.id);
  } catch { /* discovery aid only */ }
  // The dispatch is a WRITE, but a dispatch that could not be COMPLETED is not
  // a capability verdict — the candidate never got a run, so the outcome is
  // unknown, not failed. THREE distinguishable conditions, three codes:
  // unreachable -> `archon-unavailable`; answered-and-refused -> `dispatch-rejected`
  // (which carries no `.outage`, so it ENDS the streak); answered-with-an-unreadable
  // response -> `dispatch-malformed`. Classify on OUR wrapper (`httpStatus` /
  // `malformed`), never on `e.code` (an abort's DOMException carries the numeric
  // code 23, so a string comparison silently misses every transport failure).
  try {
    await archonPost('/api/workflows/' + encodeURIComponent(wfName) + '/run', { message, conversationId: 'rcos-teach-' + randomUUID().slice(0, 8) }, timeoutMs);
  } catch (e) {
    // MUST precede the status ladder. A 200 whose body could not be read is
    // neither unreachable nor refused, and this branch is the ONLY thing keeping
    // it out of `dispatch-rejected` (see the note in archonPost). It is also not
    // an outage of the read leg: Archon answered, so the operator's target is
    // what Archon RETURNED, not whether Archon is up.
    if (e && e.malformed) {
      throw Object.assign(new Error('the dispatch could not be completed — Archon ANSWERED and its response was unreadable, so the run outcome is unknown (' + String((e && e.message) || e).slice(0, 120) + ')'), { code: 'dispatch-malformed' });
    }
    const status = e && typeof e.httpStatus === 'number' ? e.httpStatus : null;
    const said = e && e.body ? ' — Archon said: ' + e.body : '';
    if (status === null) {
      throw Object.assign(new Error('the dispatch could not be completed — Archon was unreachable, so the run outcome is unknown (' + String((e && e.message) || e).slice(0, 120) + ')'), { code: 'archon-unavailable' });
    }
    if (status >= 500 || status === 429) {
      throw Object.assign(new Error('the dispatch was not accepted — Archon answered HTTP ' + status + ', a server-side or rate-limit condition rather than a capability failure' + said), { code: 'archon-unavailable' });
    }
    throw Object.assign(new Error('the dispatch was rejected — Archon answered HTTP ' + status + said), { code: 'dispatch-rejected' });
  }
  const deadline = Date.now() + DISCOVERY_DEADLINE_MS;
  let runId = null;
  let successfulListReads = 0; // discovery-window reads that actually answered
  let lastListError = null;
  while (Date.now() < deadline && !runId) {
    await new Promise((r) => setTimeout(r, 700));
    try {
      const lb = await archonGet('/api/workflows/runs?limit=50', timeoutMs);
      successfulListReads += 1;
      for (const r of (lb && lb.runs) || []) if (r && r.id && !preIds.has(r.id) && r.workflow_name === wfName) { runId = r.id; break; }
    } catch (e) { lastListError = String((e && e.message) || e).slice(0, 120); /* keep polling */ }
  }
  if (!runId) {
    if (successfulListReads === 0) {
      throw Object.assign(new Error('Archon was never successfully read during discovery — the run outcome is unknown, not absent (' + (lastListError || 'no successful run-list read') + ')'), { code: 'archon-unavailable' });
    }
    // Archon ANSWERED the run list and named no such run — an authoritative
    // absence, not an outage. Name the workflow and say who answered, so the
    // operator can act on the message rather than on a bare "no run appeared".
    throw Object.assign(new Error('dispatch was accepted but no run for ' + wfName + ' appeared — Archon answered and named no such run'), { code: 'run-not-found' });
  }
  const pollDeadline = Date.now() + TERMINAL_POLL_MS;
  let successfulDetailReads = 0; // terminal-poll reads that actually answered
  let lastDetailError = null;
  for (;;) {
    let d;
    try {
      d = await archonGet('/api/workflows/runs/' + encodeURIComponent(runId), timeoutMs);
      successfulDetailReads += 1;
    } catch (e) {
      // A transient read failure is retried to the deadline — it must never
      // throw straight out of runWorkflow as an untyped error (which the
      // _teach catch would seal as a REFUSED learning verdict).
      lastDetailError = String((e && e.message) || e).slice(0, 120);
      if (Date.now() > pollDeadline) {
        if (successfulDetailReads === 0) throw Object.assign(new Error('Archon was never successfully read while polling run ' + runId + ' — the run outcome is unknown (' + (lastDetailError || 'no successful detail read') + ')'), { code: 'archon-unavailable' });
        throw Object.assign(new Error('the run was READ but did not reach a terminal state within the ' + (TERMINAL_POLL_MS / 1000) + 's polling window — this is evidence about the candidate workflow, not a failed read'), { code: 'run-timeout' });
      }
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    const run = (d && d.run) || d;
    // The workspace-identity check runs on the FIRST read that carries a
    // working_path — before the terminal test, so case 1 aborts the whole eval
    // instead of burning the remaining cases on a fixture the run cannot see.
    const reportedWorkspacePath = run && typeof run.working_path === 'string' && run.working_path ? run.working_path : null;
    if (reportedWorkspacePath && expectedWorkspacePath && reportedWorkspacePath !== expectedWorkspacePath) {
      throw Object.assign(
        new Error('the run executed in ' + reportedWorkspacePath + ' but the held-out fixtures were planted in ' + expectedWorkspacePath
          + ' — the orchestrator isolated this run away from the configured eval workspace, so the evidence is not about the candidate'),
        { code: 'run-workspace-mismatch', reportedWorkspacePath, expectedWorkspacePath },
      );
    }
    if (run && ['completed', 'failed'].includes(run.status)) {
      const events = (d && d.events) || run.events || [];
      const outputs = [];
      let text = '';
      for (const e of events) {
        const o = e && e.data && (typeof e.data.node_output === 'string' ? e.data.node_output : (typeof e.data.output === 'string' ? e.data.output : null));
        if (o && o.trim()) { outputs.push(o.trim()); text += o.trim() + '\n'; }
      }
      return { status: run.status, runId, outputs, text };
    }
    if (Date.now() > pollDeadline) throw Object.assign(new Error('the run was READ but did not reach a terminal state within the ' + (TERMINAL_POLL_MS / 1000) + 's polling window — this is evidence about the candidate workflow, not a failed read'), { code: 'run-timeout' });
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ------------------------------------------------------------ teaching run

async function _teach({ sourceTaskId }) {
  const startedAt = isoNow();
  const teachingTaskId = 'teach-' + randomUUID().slice(0, 8);
  const t = {
    taskId: teachingTaskId,
    tasksVersion: 1,
    kind: 'teaching',
    sourceTaskId: String(sourceTaskId || '').slice(0, 120),
    status: 'learning',
    createdAt: startedAt,
    endedAt: null,
    gap: null,            // why the source task exposed a gap (failure codes + reason)
    candidate: null,      // the composed package (identity, scopes, yaml, eval set)
    evaluations: [],      // per-case real-Archon results
    verdict: null,        // 'CANDIDATE' (all evals passed) | 'REFUSED' (any failed) | 'UNKNOWN' (Archon outage — never fairly tested)
    provenance: {
      builtBy: 'rcos-teaching-m2',
      teachingTaskId,
      sourceTaskId: String(sourceTaskId || '').slice(0, 120),
    },
    nextAction: null,
    sealedBy: 'goal-runner-m2-teach',
  };
  // Declared OUTSIDE the try so an Archon outage mid-evaluation still persists
  // the cases that DID run — an outage must not erase honest partial evidence.
  const evalResults = [];

  // The infrastructure-attempt count, carried ACROSS invocations (see
  // INFRA_ATTEMPT_LIMIT). Derived from the durable store, so a retry of the
  // SAME source task continues the count instead of silently resetting it. A
  // store-read failure must not fabricate a bound, so it stays at 1.
  let infraAttempts = 1;
  try {
    const prior = await listTasks();
    infraAttempts = 1 + consecutiveInfraOutages(prior, t.sourceTaskId);
  } catch { /* unbounded by a failed count, but never falsely bounded */ }
  t.infraAttempts = infraAttempts;

  try {
    const cfgRes = resolveConfig();
    const teaching = cfgRes.config.teaching || {};
    if (!cfgRes.config.registry.path) throw Object.assign(new Error('registry not configured'), { code: 'registry-not-configured' });
    if (!teaching.workflowsDir || !teaching.workspaceDir) throw Object.assign(new Error('teaching not configured — set teaching.workflowsDir and teaching.workspaceDir'), { code: 'teaching-not-configured' });

    // ---- GAP: read the source task's honest failure
    const src = await getTask(t.sourceTaskId);
    if (!src) throw Object.assign(new Error('source task not found'), { code: 'source-not-found' });
    const srcCodes = (src.verdict && src.verdict.failureCodes) || src.failureCodes || [];
    t.gap = {
      objective: src.objective,
      failureCodes: srcCodes,
      reason: srcCodes.includes('no-route')
        ? 'no capability in the registry matched this objective'
        : 'the routed capability ran but did not satisfy the objective',
    };

    // ---- BUILD: deterministic candidate composition. The candidate declares
    // its authority scopes BEFORE it can ever become routable.
    const capId = 'workspace-word-count';
    const version = '0.1.0';
    const { wfName, yaml } = composeWorkflowYaml(capId, version);
    t.candidate = {
      capabilityId: capId,
      version,
      workflow: wfName,
      workflowYaml: yaml,
      workflowSha256: sha256(yaml),
      provides: 'Counts lines, words, and bytes across every .txt file in the workspace, with totals',
      routingVocabulary: ['workspace', 'words', 'count', 'every', 'file', 'text', 'totals'],
      requires: ['filesystem:read', 'shell:execute'],
      requiresUnknown: [],
      verification: { expectOutput: 'learned-' + capId + ':done', terminalStatus: 'completed' },
      lifecycle: 'candidate',
    };
    for (const s of t.candidate.requires) if (!SCOPES.includes(s)) t.candidate.requiresUnknown.push(s);
    await mkdir(teaching.workflowsDir, { recursive: true });
    await writeFile(join(teaching.workflowsDir, wfName + '.yaml'), yaml, 'utf8');

    // ---- EVALUATE: held-out fixture workspaces on the REAL Archon.
    // Successful generation is not learned capability — every case must pass
    // on evidence before promotion may even be OFFERED.
    await mkdir(teaching.workspaceDir, { recursive: true });
    for (const fx of EVAL_SET) {
      await writeFile(join(teaching.workspaceDir, 'README.txt'), fx.content, 'utf8');
      const run = await runWorkflow(wfName, 'teaching eval ' + teachingTaskId + '/' + fx.id, cfgRes.config.archon.timeoutMs, teaching.workspaceDir);
      // Node output arrives as per-event blobs (a blob may hold several
      // lines) — match against the JOINED evidence text, never one output.
      const allText = (run.outputs || []).join('\n');
      const m = allText.match(/TOTAL Lines: (\d+) Words: (\d+) Bytes: (\d+)/);
      const obs = m ? { lines: Number(m[1]), words: Number(m[2]), bytes: Number(m[3]) } : null;
      const pass = run.status === 'completed' &&
        allText.includes('learned-' + capId + ':done') &&
        !!obs && obs.lines === fx.lines && obs.words === fx.words && obs.bytes === fx.bytes;
      evalResults.push({
        caseId: fx.id, status: run.status, runId: run.runId,
        expected: { lines: fx.lines, words: fx.words, bytes: fx.bytes },
        observed: obs, pass,
      });
    }
    t.evaluations = evalResults;
    const passed = evalResults.filter((e) => e.pass).length;
    if (passed !== evalResults.length) {
      // The honest refusal: a candidate that failed ANY case is not learned.
      t.verdict = 'REFUSED';
      t.status = 'failed';
      t.nextAction = { kind: 'inspect', label: 'Inspect the evidence', reason: 'Couldn\u2019t learn this reliably. Candidate succeeded ' + passed + '/' + evalResults.length + ' evaluations. Not added to Intelligence.' };
      t.endedAt = isoNow();
      await upsertTask(t);
      return t;
    }

    // ---- CANDIDATE: evals passed. Promotion stays an explicit HUMAN action.
    t.verdict = 'CANDIDATE';
    t.status = 'candidate';
    t.nextAction = { kind: 'promote', label: 'Promote to Intelligence', reason: 'Tested on ' + evalResults.length + ' held-out cases — all execution checks, capability validations, and objective evaluations passed. Promotion needs your explicit approval.' };
    t.endedAt = isoNow();
    await upsertTask(t);
    return t;
  } catch (e) {
    // A CLOSED classification. There is deliberately no `else -> REFUSED`
    // bucket: an error this module did not anticipate must never be readable as
    // "the capability failed". Three slots, and none may be folded into another:
    //   outage  = an external read failed (or the dispatch could not be attempted)
    //   blocked = the invocation never reached a run (local contention, or a
    //             remote dispatch rejection — Archon ANSWERED)
    //   refusal = a verdict WAS reached
    const code = (e && e.code) || null;
    t.evaluations = evalResults;
    t.error = String((e && e.message) || e).slice(0, 200);

    if (UNFAIR_RUN_OUTCOMES[code]) {
      // The candidate never got a fair run, so nothing about it was learned —
      // sealing REFUSED here would blame the capability for infrastructure AND
      // burn the rest of the eval budget. Unknown, retryable, bounded.
      const attempt = t.infraAttempts || 1;
      const exhausted = attempt >= INFRA_ATTEMPT_LIMIT;
      const { outcome, exhaustedLabel } = UNFAIR_RUN_OUTCOMES[code];
      t.verdict = 'UNKNOWN';
      t.status = String(outcome).toLowerCase(); // UNAVAILABLE -> 'unavailable', ABSENT -> 'absent'
      t.outage = { outcome, code, reason: t.error, attempt, limit: INFRA_ATTEMPT_LIMIT, exhausted };
      t.nextAction = exhausted
        ? { kind: 'inspect', label: exhaustedLabel, reason: 'The candidate could not be given a fair run after ' + attempt + ' infrastructure attempts — this is not a capability verdict. ' + t.error }
        : { kind: 'retry', label: 'Retry teaching', reason: 'The candidate was never fairly tested (' + outcome.toLowerCase() + ') — the outcome is unknown (infrastructure attempt ' + attempt + ' of ' + INFRA_ATTEMPT_LIMIT + '). Retry when Archon is reachable.' };
      t.endedAt = isoNow();
      await upsertTask(t);
      return t;
    }

    if (code === 'run-workspace-mismatch') {
      // Its OWN slot, deliberately NOT folded into UNFAIR_RUN_OUTCOMES. That
      // table is the retryable infrastructure streak, and its terminal label is
      // an INSPECT of infrastructure. This condition is neither: retrying cannot
      // change it, and the thing to look at is the CONFIGURATION (which
      // directory the orchestrator executes in versus which one the fixtures are
      // written to). It carries NO `.outage` field, so it does not extend the
      // infrastructure streak — the same reasoning that keeps `dispatch-rejected`
      // out of it. The verdict is UNKNOWN: nothing about the candidate was
      // learned, so REFUSED would be a false accusation and would burn the
      // capability's reputation for our configuration error.
      t.verdict = 'UNKNOWN';
      t.status = 'workspace-mismatch';
      t.blocked = {
        code: 'run-workspace-mismatch',
        reason: t.error,
        reportedWorkspacePath: (e && e.reportedWorkspacePath) || null,
        expectedWorkspacePath: (e && e.expectedWorkspacePath) || null,
      };
      t.nextAction = {
        kind: 'configure',
        label: 'Configure the eval workspace',
        reason: 'The orchestrator executed the run in a different directory than the one the held-out fixtures were written to, so the candidate was never actually tested — this is not a capability verdict. Point teaching.workspaceDir at the directory the orchestrator executes runs in, or configure the orchestrator to execute in teaching.workspaceDir. ' + t.error,
      };
      t.endedAt = isoNow();
      await upsertTask(t);
      return t;
    }

    if (code === 'dispatch-rejected') {
      // Archon ANSWERED and refused the dispatch — a definitive answer, so this
      // is NOT an outage and carries NO `.outage` field: consecutiveInfraOutages
      // counts `.outage` envelopes only, so the infrastructure streak genuinely
      // ENDS here rather than being silently extended. Still not a capability
      // verdict: no run ever happened.
      t.verdict = 'UNKNOWN';
      t.status = 'dispatch-rejected';
      t.blocked = { code: 'dispatch-rejected', reason: t.error };
      t.nextAction = { kind: 'inspect', label: 'Inspect the dispatch rejection', reason: 'Archon rejected the dispatch, so the candidate never ran — this is not a capability verdict. ' + t.error };
      t.endedAt = isoNow();
      await upsertTask(t);
      return t;
    }

    if (code === 'run-timeout') {
      // A run that was READ and did not reach a terminal state is evidence about
      // the candidate workflow, not a failed read (see the reason at the throw
      // site). Deliberately REFUSED — a considered non-change.
      t.verdict = 'REFUSED';
      t.status = 'failed';
      t.nextAction = { kind: 'inspect', label: 'Inspect the evidence', reason: t.error };
      t.endedAt = isoNow();
      await upsertTask(t);
      return t;
    }

    if (code === 'registry-not-configured' || code === 'teaching-not-configured' || code === 'source-not-found') {
      // Genuine setup failures: a verdict WAS reached — we cannot teach this
      // source for a stated, non-infrastructure reason. Unchanged.
      t.verdict = 'REFUSED';
      t.status = 'failed';
      t.nextAction = { kind: 'inspect', label: 'Inspect the teaching task', reason: t.error };
      t.endedAt = isoNow();
      await upsertTask(t);
      return t;
    }

    // DEFAULT: an error this module did not anticipate. Terminal (inspect, not
    // retry) so it cannot loop, and never readable as a capability verdict.
    t.verdict = 'UNKNOWN';
    t.status = 'unclassified';
    t.nextAction = { kind: 'inspect', label: 'Inspect the teaching task', reason: 'Teaching failed for a reason this module does not classify (code: ' + (code === null ? 'none' : String(code)) + ') — this is not a capability verdict. ' + t.error };
    t.endedAt = isoNow();
    await upsertTask(t);
    return t;
  }
}

// Single-flight guard. The teaching scratch space is FIXED-path — `_teach`
// hardcodes capId 'workspace-word-count' / version '0.1.0' (so the workflow YAML
// name is fixed) and the eval fixture is the fixed
// join(teaching.workspaceDir, 'README.txt'). Two concurrent runs would collide
// on those files, so only one teaching run may be in flight.
//
// The guard must not, however, answer one source's request with another
// source's envelope: that would report task B with task A's gap, candidate and
// verdict — the same defect as a read collapse, one level out, at the REQUEST
// boundary. A request for the SAME source is a duplicate and gets the in-flight
// result; a request for a DIFFERENT source gets a typed `blocked` outcome.
let teachInflight = null; // { sourceTaskId, promise } | null

// The THREE outcome slots, and none may be folded into another:
//   outage  = an external read failed (or the dispatch could not be attempted);
//             carries `.outage` and counts toward the infrastructure bound.
//   blocked = the invocation never reached a run — LOCAL contention (another
//             teaching run holds the single-flight scratch space) or a REMOTE
//             dispatch rejection (Archon ANSWERED and refused). Carries NO
//             `.outage`, so it never extends the infrastructure streak.
//   refusal = a verdict WAS reached.
// One field covers both `blocked` cases because they answer the same question
// ("why did this invocation produce no fair run?"): `contention` would be a
// false name for a remote rejection (it asserts local busy-ness), and
// `dispatch-rejected` may live in neither `refusal` (no verdict was reached)
// nor `outage` (Archon answered). Fail-closed: no candidate, no capability
// verdict, no promotion.
//
// Returned, NEVER persisted — and that is load-bearing: a teaching envelope for
// this source would also falsely END its infrastructure-outage streak, because
// consecutiveInfraOutages() treats any non-outage envelope as a real outcome.
function teachingBusy(requestedSourceTaskId, inFlightSourceTaskId) {
  const reason = 'teaching is already running for source ' + inFlightSourceTaskId + ' — this request for ' + requestedSourceTaskId + ' was not run (teaching is single-flight: the workflow and eval fixture paths are fixed)';
  return {
    taskId: null,
    kind: 'teaching',
    sourceTaskId: requestedSourceTaskId,
    status: 'unavailable',
    verdict: 'UNKNOWN',
    candidate: null,
    evaluations: [],
    error: reason,
    blocked: {
      code: 'teaching-already-in-flight',
      inFlightSourceTaskId,
      requestedSourceTaskId,
      reason,
    },
    nextAction: {
      kind: 'retry',
      label: 'Retry teaching',
      reason: 'teaching is already running for source ' + inFlightSourceTaskId + '; wait for it to finish, then retry this request for ' + requestedSourceTaskId,
    },
    endedAt: isoNow(),
  };
}

export function teachRCOS({ sourceTaskId }) {
  const src = String(sourceTaskId || '').slice(0, 120);
  if (teachInflight) {
    // Same source: a duplicate of the in-flight run — return its result.
    if (teachInflight.sourceTaskId === src) return teachInflight.promise;
    // Different source: never answer with the in-flight source's envelope.
    return Promise.resolve(teachingBusy(src, teachInflight.sourceTaskId));
  }
  const promise = _teach({ sourceTaskId: src }).finally(() => { teachInflight = null; });
  teachInflight = { sourceTaskId: src, promise };
  return promise;
}

// ------------------------------------------------------------------ PROMOTE
//
// The explicit human action. Promotion writes the candidate into the
// OPERATOR's registry (registry.path) — with provenance permanently
// attached — and seals the teaching envelope as promoted. It refuses
// anything that is not a CANDIDATE, and it refuses candidates with unknown
// scopes (fail-closed, same as dispatch).
export async function promoteCandidate({ teachingTaskId }) {
  // EVERY refusal below carries a `code`, because the route derives the HTTP
  // status from it (`flowrouterRefusalStatus(out.code)` in lib/index.js — the
  // acquire route's promote branch AND the teach route's promote branch both
  // call it). Without a code, `out.code` is undefined, the mapping matches
  // nothing, and every refusal — INCLUDING a registry READ failure — leaves as
  // the same do-not-retry 409. The `error` prose is unchanged byte-for-byte: it
  // is read by humans and by other consumers, and the code is added ALONGSIDE
  // it, never instead of it. (Deliberately no line numbers: they drift, and a
  // stale reference in a comment is its own small version of this defect.)
  const t = await getTask(String(teachingTaskId || '').slice(0, 120));
  if (!t || t.kind !== 'teaching' || t.verdict !== 'CANDIDATE' || t.status !== 'candidate') {
    return { ok: false, code: 'capability-not-promoted', error: 'teaching task is not a CANDIDATE — nothing to promote' };
  }
  const cand = t.candidate;
  if (!cand || (cand.requiresUnknown || []).length) {
    return { ok: false, code: 'authority-scopes-unknown', error: 'candidate declares unknown authority scopes — promotion refused' };
  }
  const cfgRes = resolveConfig();
  if (!cfgRes.config.registry.path) return { ok: false, code: 'registry-not-configured', error: 'registry not configured' };
  let registry;
  try {
    registry = JSON.parse(await readFile(cfgRes.config.registry.path, 'utf8'));
  } catch (e) {
    // Split on ENOENT exactly as lib/flowrouter.js's admitImport and
    // lib/admission.js's workflow-bytes read do: "create it" and "fix it" are
    // different operator actions, and one code for both is the collapse in the
    // ABSENCE direction. Both halves land on 500 — the registry is LOCAL DURABLE
    // STATE, not a request input — so the split changes the message and the
    // operator's first move, not the status. (`registry-not-configured` above is
    // the request-input case: you never set the path, so 400.)
    return e && e.code === 'ENOENT'
      ? { ok: false, code: 'registry-missing', error: 'the configured registry file is not there: ' + cfgRes.config.registry.path }
      : { ok: false, code: 'registry-unreadable', error: 'registry unreadable: ' + String((e && e.message) || e).slice(0, 120) };
  }
  // We READ the registry and it is not a registry — MALFORMED, never "missing".
  if (!registry || !Array.isArray(registry.capabilities)) return { ok: false, code: 'registry-malformed', error: 'registry has no capabilities array' };
  if (registry.capabilities.some((c) => c.id === cand.capabilityId)) {
    return { ok: false, code: 'capability-not-promoted', error: 'capability already in the registry — promotion refused (promote a NEW version instead)' };
  }
  const entry = {
    id: cand.capabilityId,
    name: cand.provides ? 'LEARNED — ' + String(cand.provides).slice(0, 80) : 'LEARNED ' + cand.capabilityId,
    kind: 'workflow',
    version: cand.version,
    status: 'promoted',
    workflow: cand.workflow,
    requires: cand.requires,
    verification: cand.verification,
    description: cand.provides,
    tags: cand.routingVocabulary,
    provenance: {
      builtBy: t.provenance.builtBy,
      sourceTaskId: t.sourceTaskId,
      teachingTaskId: t.taskId,
      evalSet: (t.evaluations || []).map((e) => ({ caseId: e.caseId, runId: e.runId, pass: e.pass })),
      promotedBy: 'operator',
      promotedAt: isoNow(),
    },
    admitted_after: [],
    evals: [],
    reuse_count: 0,
    last_eval: null,
  };
  registry.capabilities.push(entry);
  await writeFile(cfgRes.config.registry.path, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  t.status = 'promoted';
  t.nextAction = { kind: 'retry', label: 'Try original objective again', reason: 'RCOS learned this capability — the original objective can now route to it.' };
  await upsertTask(t);
  return { ok: true, teaching: t, capability: entry };
}

export async function listTeaching() {
  return (await listTasks()).filter((t) => t.kind === 'teaching');
}
