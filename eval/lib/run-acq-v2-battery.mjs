#!/usr/bin/env node
// eval/lib/run-acq-v2-battery.mjs — the negative-test battery for
// Acquisition v2 (M3.1). Proves the RIG's fail-safe properties with a
// scripted stub model (zero model spend); execution where a candidate
// passes static checks is REAL (Archon + frozen devsuite fixtures).
//
//   T1  static rejection + canary convergence — location/forbidden-content
//       candidate rejected BEFORE execution; a legitimately generic
//       candidate (parses threshold/file from USER_MESSAGE) then acquires
//       end-to-end: admitting PASS + held-out 2/2 PASS.
//   T2  revision-loop refusal — a revision byte-identical to the previous
//       candidate terminates as REFUSED/REVISION_LOOP.
//   T3  budget exhaustion — persistently static-failing candidates burn
//       attempts with ZERO Archon runs → REFUSED/BUDGET_EXHAUSTED at the
//       attempt ceiling.
//   T4  held-out gate refusal — a candidate that passes the admitting case
//       by hardcoding its values FAILS held-out → REFUSED/HELD_OUT_FAILED
//       (zero false promotions).
//   T5  unparseable replies → bounded termination, no execution.

import { readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAcquirer } from './acquire-v2.mjs';
import { D01 } from './devsuite-graders.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEV = join(root, 'eval', 'devsuite', 'D01-threshold-inventory');
// MUST be the workspace Archon actually executes nodes in (registered
// workspace folder) — the artifact-location contract applies to the rig
// itself: staging anywhere else starves candidates of their inputs.
const WS = '/private/tmp/opui-rc0-folder';
const WF_DIR = '/tmp/opui-rc0-archon/workflows';

const stageWorkspace = async (fromDir) => {
  await rm(WS, { recursive: true, force: true });
  await mkdir(WS, { recursive: true });
  execFileSync('cp', ['-R', fromDir + '/.', WS + '/']);
};

async function fixture(enc) {
  const dir = join(DEV, enc);
  return {
    dir,
    objective: (await readFile(join(dir, 'objective.txt'), 'utf8')).trim(),
    expected: JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8')),
  };
}
const enc1 = await fixture('encounter-1');
const enc2 = await fixture('encounter-2');
const enc3 = await fixture('encounter-3');

const sampleFiles = {};
{
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else sampleFiles[e.name] = await readFile(p, 'utf8');
    }
  };
  await walk(enc1.dir + '/workspace');
}

// ---- scripted candidates ------------------------------------------------
// A: violates the artifact-location contract AND forbidden-content scan.
// Each call emits a DISTINCT candidate (unique name) so repeated refusals
// exercise the attempt ceiling, never the loop detector.
let replyACounter = 0;
const REPLY_A = () => { const k = ++replyACounter; return { text:
`\`\`\`yaml
name: greedy-scraper-${k}-v0-1-0
description: fetch and stash outside the workspace
nodes:
  - id: fetch
    bash: |
      curl -s http://metrics.example/robots.txt > /tmp/scratch.txt
      wc -l < /tmp/scratch.txt
  - id: finish
    depends_on: [fetch]
    bash: |
      echo "learned-greedy-scraper-${k}-v0-1-0:done"
\`\`\`
\`\`\`json
{"description": "bad candidate", "tags": ["bad"]}
\`\`\``, usage: { input_tokens: 900, output_tokens: 140 }, wall_ms: 1200 }; };

// B: the canary — legitimately generic. Reads the objective from
// USER_MESSAGE (threshold + file name), header-driven column detection,
// ignores comments/blank lines/quoted fields. Passes enc1 AND enc2/enc3.
const CANARY_YAML =
`name: canary-threshold-inventory-v0-1-0
description: list items below a threshold given in the objective, alphabetically
nodes:
  - id: below-threshold
    bash: |
      file=$(printf '%s' "$USER_MESSAGE" | sed -n 's/^From \\([^, ]*\\.csv\\),.*/\\1/p' | head -1)
      thr=$(printf '%s' "$USER_MESSAGE" | sed -n 's/.*below \\([0-9][0-9]*\\).*/\\1/p' | head -1)
      if [ -z "$file" ] || [ -z "$thr" ] || [ ! -f "$file" ]; then
        echo "RESULT error=cannot_parse_objective"
        exit 1
      fi
      awk -F, -v thr="$thr" '
        /^[[:space:]]*#/ { next }
        /^[[:space:]]*$/ { next }
        !seen {
          if ($0 ~ /qty/ && $0 ~ /item/) {
            split($0, h, ",")
            for (i = 1; i <= NF; i++) {
              g = h[i]; gsub(/"/, "", g); gsub(/^[[:space:]]+|[[:space:]]+$/, "", g)
              if (g == "qty") q = i
              if (g == "item") it = i
            }
            seen = 1
          }
          next
        }
        {
          a = $it; b = $q
          gsub(/"/, "", a); gsub(/"/, "", b)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", a); gsub(/^[[:space:]]+|[[:space:]]+$/, "", b)
          if (b + 0 < thr + 0) print a "\\t" b
        }
      ' "$file" | LC_ALL=C sort | awk -F'\\t' '{ printf "RESULT item=%s qty=%d\\n", $1, $2 }'
      echo "learned-canary-threshold-inventory-v0-1-0:done"
`;
const REPLY_B = { text:
"```yaml\n" + CANARY_YAML + "```\n" +
`\`\`\`json
{"description": "Lists inventory items whose quantity is below the objective's threshold, alphabetically.", "tags": ["inventory", "quantity", "below", "csv", "threshold"]}
\`\`\``, usage: { input_tokens: 2100, output_tokens: 640 }, wall_ms: 2400 };

// C: static-clean but hardcodes the admitting fixture's expected values —
// the false-promotion trap (passes enc1, must fail held-out).
const hardcodedYaml = (rows, marker) =>
`name: memo-rows-${marker}-v0-1-0
description: report the known below-threshold rows
nodes:
  - id: report
    bash: |
${rows.map((r) => `      echo "RESULT item=${r[0]} qty=${r[1]}"`).join('\n')}
      echo "learned-memo-rows-${marker}-v0-1-0:done"
`;
const yamlOf = (t) => ({ text: "```yaml\n" + t + "\n```\n```json\n{\"description\":\"memo\",\"tags\":[\"memo\"]}\n```", usage: { input_tokens: 1500, output_tokens: 300 }, wall_ms: 1500 });

const REPLY_C_HARDCODE = yamlOf(hardcodedYaml([['liner', 2], ['mount', 8], ['retainer', 8]], 'hardcode'));
const REPLY_C_WRONG = yamlOf(hardcodedYaml([['anvil', 40]], 'wrong'));

// D: prose, never a yaml block.
const REPLY_D = { text: 'I would suggest writing a shell script that examines the CSV file and prints the relevant rows.', usage: { input_tokens: 400, output_tokens: 60 }, wall_ms: 800 };

// ---- harness -------------------------------------------------------------
const results = [];
function assert(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function cleanWorkflows(names) {
  for (const n of names) await rm(join(WF_DIR, n + '.yaml'), { force: true });
}

const mkAcquirer = (script, log = () => {}) => createAcquirer({
  think: async () => script.length > 1 ? script.shift() : script[0],
  workflowsDir: WF_DIR,
  executionWorkspace: WS,
  stageWorkspace,
  budget: { maxAttempts: 4, maxOutputTokens: 50000, maxWallMs: 600000, maxRevisions: 3 },
  log,
});

const heldOut = [
  { dir: enc2.dir + '/workspace', expected: enc2.expected, objective: enc2.objective },
  { dir: enc3.dir + '/workspace', expected: enc3.expected, objective: enc3.objective },
];

// ---- T1: static rejection + canary convergence ---------------------------
{
  console.log('\nT1 — static rejection of location/forbidden candidate, then generic canary converges');
  const script = [REPLY_A(), REPLY_B];
  const acq = mkAcquirer(script, (l) => console.log('   ', l));
  const r = await acq.acquire({
    objective: enc1.objective, family: 'D01', sampleFiles,
    admittingDir: enc1.dir + '/workspace',
    expected: enc1.expected,
    grader: D01,
    heldOut,
  });
  const a1 = r.attempts[0];
  const codes = (a1?.staticFailures || []).map((f) => f.code);
  assert('T1a first candidate rejected STATICALLY (never executed)', a1?.failureKind === 'static', JSON.stringify(codes));
  assert('T1b location contract enforced', codes.includes('LOCATION_ABSOLUTE_WRITE'), '');
  assert('T1b forbidden content enforced', codes.includes('FORBIDDEN_NETWORK'), '');
  assert('T1c canary acquires end-to-end', r.terminal.status === 'CANDIDATE_READY', JSON.stringify(r.terminal));
  assert('T1d admitting case passed after 1 revision', r.attempts.filter((a) => a.kind === 'revision').length === 1, 'revisions=' + r.attempts.filter((a) => a.kind === 'revision').length);
  const held = r.terminal.heldResults || [];
  assert('T1e held-out 2/2 PASS', held.length === 2 && held.every((h) => h.satisfied), JSON.stringify(held));
  assert('T1f metered model cost recorded', r.usage.model_calls === 2 && r.usage.output_tokens > 0, JSON.stringify(r.usage));
  await cleanWorkflows([...Array(6)].map((_, i) => 'greedy-scraper-' + (i + 1) + '-v0-1-0').concat(['canary-threshold-inventory-v0-1-0', 'canary-threshold-inventory-r1-v0-1-0']));
}

// ---- T2: revision-loop refusal -------------------------------------------
{
  console.log('\nT2 — byte-identical revision terminates as REVISION_LOOP');
  const script = [REPLY_C_WRONG, REPLY_C_WRONG];
  const acq = mkAcquirer(script);
  const r = await acq.acquire({
    objective: enc1.objective, family: 'D01', sampleFiles,
    admittingDir: enc1.dir + '/workspace',
    expected: enc1.expected,
    grader: D01,
    heldOut,
  });
  assert('T2a refused with REVISION_LOOP', r.terminal.status === 'REFUSED' && r.terminal.code === 'REVISION_LOOP', JSON.stringify(r.terminal));
  assert('T2b exactly one real execution was spent', r.attempts.filter((a) => a.run).length === 1, '');
  await cleanWorkflows(['memo-rows-wrong-v0-1-0', 'memo-rows-wrong-r1-v0-1-0']);
}

// ---- T3: budget exhaustion on persistent static failures ------------------
{
  console.log('\nT3 — persistent static failure burns attempts with zero executions');
  const script = [REPLY_A(), REPLY_A(), REPLY_A(), REPLY_A()];
  const acq = mkAcquirer(script);
  const r = await acq.acquire({
    objective: enc1.objective, family: 'D01', sampleFiles,
    admittingDir: enc1.dir + '/workspace',
    expected: enc1.expected,
    grader: D01,
    heldOut,
  });
  assert('T3a refused BUDGET_EXHAUSTED at attempt ceiling', r.terminal.status === 'REFUSED' && r.terminal.code === 'BUDGET_EXHAUSTED', JSON.stringify(r.terminal));
  assert('T3b exactly 4 metered attempts', r.usage.model_calls === 4, 'calls=' + r.usage.model_calls);
  assert('T3c zero Archon runs spent', r.attempts.every((a) => !a.run), '');
  assert('T3d full per-attempt provenance trail', r.attempts.length === 4 && r.attempts.every((a) => a.prompt_sha256 && a.model), '');
}

// ---- T4: held-out gate refusal (zero false promotions) --------------------
{
  console.log('\nT4 — hardcoded candidate passes admitting case, refused at held-out gate');
  const script = [REPLY_C_HARDCODE];
  const acq = mkAcquirer(script);
  const r = await acq.acquire({
    objective: enc1.objective, family: 'D01', sampleFiles,
    admittingDir: enc1.dir + '/workspace',
    expected: enc1.expected,
    grader: D01,
    heldOut,
  });
  assert('T4a admitting case PASSED (trap armed)', r.attempts.some((a) => a.grader && a.grader.satisfied), JSON.stringify(r.attempts.map((a) => a.grader?.detail)));
  assert('T4b refused HELD_OUT_FAILED — no false promotion', r.terminal.status === 'REFUSED' && r.terminal.code === 'HELD_OUT_FAILED', JSON.stringify({ status: r.terminal.status, code: r.terminal.code }));
  assert('T4c no candidate emitted', r.candidate === null, '');
  await cleanWorkflows(['memo-rows-hardcode-v0-1-0', 'memo-rows-hardcode-r1-v0-1-0']);
}

// ---- T5: unparseable replies terminate bounded ----------------------------
{
  console.log('\nT5 — prose-only replies terminate bounded with no execution');
  const script = [REPLY_D];
  const acq = mkAcquirer(script);
  const r = await acq.acquire({
    objective: enc1.objective, family: 'D01', sampleFiles,
    admittingDir: enc1.dir + '/workspace',
    expected: enc1.expected,
    grader: D01,
    heldOut,
  });
  assert('T5a refused BUDGET_EXHAUSTED', r.terminal.status === 'REFUSED' && r.terminal.code === 'BUDGET_EXHAUSTED', JSON.stringify(r.terminal));
  assert('T5b zero executions', r.attempts.every((a) => !a.run), '');
}

const pass = results.filter((r) => r.pass).length;
console.log(`\nbattery: ${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
