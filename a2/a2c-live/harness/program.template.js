// A2-c LIVE WM program — the real A2-c ladder on the Dell: FIND the promoted
// route-record-validate capability (REUSE), COMPOSE it into a bash-only
// Archon DAG via RCOS IR and install it (IMPROVE — the workflow persists as a
// reusable live-verification harness), RUN it on Archon (BUILD), and verify
// the run artifacts against re-derived expectations. Every decision lives in
// the python helpers shipped to the Dell; this program is a thin ladder of
// exitCode gates. Zero model spend: the DAG is bash-only, the seat runs on
// the loopback lane. Receipt discipline: verdict 'ship' only if EVERY step
// exits 0 and the on-Dell verifier reports ok — any failure downgrades to
// 'fix' with the failing output as evidence and empty artifacts.
const DELL = 'chow@100.111.182.5';
const evidence = [];
let ok = true;
const step = async (name, command, description, cap) => {
  const r = await tools.bash({ command, description });
  if (r.exitCode !== 0) ok = false;
  evidence.push(name + ': exit=' + r.exitCode + ' ' + String(JSON.stringify(r)).replace(/\s+/g, ' ').slice(0, cap || 420));
  return r;
};

// SHIP: helpers + IR plan + capability input land on the Dell as files.
const shipFind = await step('ship/find-helper', `ssh ${DELL} "echo __B64_FIND__ | base64 -d > /tmp/a2c-find.py"`, 'Ship the find helper to the Dell');
const shipVerify = await step('ship/verify-helper', `ssh ${DELL} "echo __B64_VERIFY__ | base64 -d > /tmp/a2c-verify-live.py"`, 'Ship the live verifier to the Dell');
const shipIr = await step('ship/ir-plan', `ssh ${DELL} "echo __B64_IR__ | base64 -d > /tmp/a2c-ir-plan.json"`, 'Ship the RCOS IR plan to the Dell');
const shipInput = await step('ship/capability-input', `ssh ${DELL} "echo __B64_INPUT__ | base64 -d > /tmp/a2c-capability-input.json"`, 'Ship the capability input to the Dell');
const jsonOk = await step('ship/json-check', `ssh ${DELL} 'python3 -m json.tool /tmp/a2c-ir-plan.json > /dev/null && python3 -m json.tool /tmp/a2c-capability-input.json > /dev/null'`, 'Both shipped JSON files parse');

// FIND + REUSE: the registry must say promoted (runner-backed eval, 616202d).
const find = await step('find+reuse', `ssh ${DELL} '"$HOME/zcode-rcos/bin/rcos" query --json | python3 /tmp/a2c-find.py'`, 'Find route-record-validate and gate on promoted');

// COMPOSE + IMPROVE: compile the IR to an Archon workflow and install it.
await step('compose+install', `ssh ${DELL} 'cd /tmp && "$HOME/zcode-rcos/bin/rcos" ir-compile --ir /tmp/a2c-ir-plan.json --name a2c-route-record-live --install'`, 'Compile IR to a bash-only workflow and install it on Archon');

// BUILD: run the workflow on Archon; the run message is the capability input.
await step('build/archon-run', `ssh ${DELL} 'cd ~ && export PATH="$HOME/.local/bin:$PATH" && archon workflow run rcos-ir-a2c-route-record-live "$(cat /tmp/a2c-capability-input.json)" > /tmp/a2c-live-run.log 2>&1'`, 'Run the bash-only workflow on Archon');

// VERIFY: on-Dell verifier re-derives everything from the run log + artifacts.
const verify = await step('verify', `ssh ${DELL} 'python3 /tmp/a2c-verify-live.py'`, 'Verify run completion, outputs, and re-derived verdict', 900);

// Receipt: gated on the ladder; ids and statuses only from the verifier's own
// report. Contract (dsh-seat-dispatch/lib/receipt.js): closed fields,
// archon_status is the run's OWN verdict artifact value (ship|fix|blocked|none)
// — never a lifecycle word like 'completed'; absent ids are the literal 'none'.
const vstr = String(JSON.stringify(verify));
let vj = null;
try { vj = JSON.parse(verify && verify.stdout && verify.stdout.text); } catch (e) { /* regex fallback below */ }
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const afterKey = (key) => (vstr.includes(key) ? vstr.slice(vstr.indexOf(key)) : '');
const uuidAfter = (key) => { const m = UUID_RE.exec(afterKey(key)); return m ? m[0] : null; };
const runId = (vj && vj.archon_run_id) || uuidAfter('archon_run_id') || 'none';
const artDir = (vj && vj.artifact_dir) || 'none';
const invId = (vj && vj.rcos_invocation_id) || 'unknown-invocation';
const liveVerdict = vj ? vj.live_verdict : null;
const verifyOk = !vj || vj.ok === true; // an unparsable verifier report is not a pass
const ship = ok && runId !== 'none' && artDir !== 'none' && verifyOk && liveVerdict === 'ship';
const archStatus = runId === 'none' ? 'none' : (liveVerdict === 'ship' ? 'ship' : 'fix');
const receipt = {
  verdict: ship ? 'ship' : 'fix',
  summary: ship
    ? 'Ladder complete on the Dell: found route-record-validate PROMOTED in the registry (reuse), composed it via RCOS IR into a bash-only 3-node Archon DAG (cap prelude + verify-invocation + rederive-verdict) and installed it as rcos-ir-a2c-route-record-live (improve — reusable harness), ran it on Archon with the routing record as the run message (build), and independently re-derived the verdict from the artifacts: invocation ' + invId + ' completed in normal mode, dispatch-handoff judged VALID, all summary counts re-derived and matching, missing_record probe refused with kernel exit 2. Zero model spend — the DAG is bash-only.'
    : 'Ladder failed somewhere below ship: one or more steps exited non-zero or the verifier did not confirm. No artifacts claimed.',
  artifacts: ship ? [artDir + '/rcos-invocation-route-record-validate.json', artDir + '/validation-report.json', artDir + '/verdict.json'] : [],
  evidence: evidence,
  blockers: ship ? [] : ['see evidence for the first non-zero step'],
  archon_run_id: runId,
  archon_status: archStatus,
  archon_artifact_dir: artDir,
  lane: 'loopback-0spend/deepseek-flash',
  next: 'A2-d: correlation chain distinct ids + 4 failure paths',
};
let submitted;
try {
  submitted = await tools.submit_dispatch_receipt(receipt);
} catch (e) {
  // A contract refusal is still an honest outcome: degrade to a minimal valid
  // receipt rather than crashing receipt-less (receipt-missing reads 'blocked').
  const why = String((e && e.message) || e).slice(0, 250);
  submitted = await tools.submit_dispatch_receipt({
    verdict: 'fix',
    summary: 'Ladder executed but the primary receipt was refused by the contract: ' + why,
    artifacts: [],
    evidence: evidence.length ? evidence.slice(0, 8) : ['no step evidence captured'],
    blockers: ['receipt contract refusal: ' + why],
    archon_run_id: runId,
    archon_status: runId === 'none' ? 'none' : 'fix',
    archon_artifact_dir: artDir,
    lane: 'loopback-0spend/deepseek-flash',
    next: 'compare the refused receipt fields against dsh-seat-dispatch/lib/receipt.js',
  });
}
return submitted;
