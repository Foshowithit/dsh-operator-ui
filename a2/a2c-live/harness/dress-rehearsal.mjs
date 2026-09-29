// Dress rehearsal for program.live.txt: run the WHOLE program against mocked
// bash results shaped exactly like the real ptc runtime, with the REAL receipt
// validator (imported from the seat-dispatch bundle) enforcing the contract on
// submit_dispatch_receipt — including one-receipt-only and hard refusal on any
// violation, the same failure mode that burned live run 4.
//
// Scenarios (arg 1): green (ladder all-zero, verifier ok), red (verify ok:false),
// refuse-first (submit refused once -> degraded receipt must still be valid).
import { readFileSync } from 'node:fs';
import { validateReceipt } from '/Users/adam26/dsh-a0-boot/bundles/seat-dispatch-real/dsh-seat-dispatch/lib/receipt.js';

const scenario = process.argv[2] || 'green';
const verifyText = readFileSync('/tmp/a2c-verify-stdout-r4.json', 'utf8').trim();

function bashResult(stdoutText) {
  return { kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 60000,
    stdout: { text: stdoutText, truncated: false }, stderr: { text: '', truncated: false },
    sandbox: { mode: 'workspace-write', denied: false, enforcement: 'full' } };
}

const submissions = [];
let refusalsLeft = scenario === 'refuse-first' ? 1 : 0;

const tools = {
  bash: async ({ command }) => {
    if (command.includes('a2c-find.py')) {
      return bashResult('{"id": "route-record-validate", "status": "promoted", "adapter_declared": true, "evals_total": 3, "evals_executed": 1, "latest_executed_verdict": "ship"}\n');
    }
    if (command.includes('a2c-verify-live.py')) {
      if (scenario === 'red') {
        return { ...bashResult(''), exitCode: 1, stderr: { text: 'FAIL: workflow did not complete', truncated: false } };
      }
      return bashResult(verifyText);
    }
    return bashResult('');
  },
  submit_dispatch_receipt: async (args) => {
    if (refusalsLeft > 0) {
      refusalsLeft -= 1;
      throw new Error('ToolCallError: invalid arguments: "archon_status" must be one of ["ship","fix","blocked","none"]');
    }
    const violations = validateReceipt(args);
    if (violations.length) throw new Error('ToolCallError: invalid arguments: ' + violations.join('; '));
    if (submissions.length >= 1) throw new Error('second submission refused');
    submissions.push(args);
    return { accepted: true, verdict: args.verdict };
  },
};

const body = readFileSync('/Users/adam26/dsh-a0-boot/a2c/program.live.txt', 'utf8');
const program = new Function('tools', `return (async () => {\n${body}\n})();`);

const final = await program(tools);
const s = submissions[0];
const assert = (cond, msg) => { if (!cond) { console.error('REHEARSAL FAIL [' + scenario + ']: ' + msg); process.exit(1); } };

assert(submissions.length === 1, 'exactly one accepted submission (got ' + submissions.length + ')');
if (scenario === 'green') {
  assert(s.verdict === 'ship', 'verdict ship, got ' + s.verdict);
  assert(s.archon_run_id === 'db8c816b-68fb-430d-9c21-d218fb936ceb', 'real run id');
  assert(s.archon_status === 'ship', 'archon_status ship (run own verdict), got ' + s.archon_status);
  assert(s.archon_artifact_dir.endsWith('/runs/db8c816b-68fb-430d-9c21-d218fb936ceb'), 'real artifact dir');
  assert(s.summary.includes('inv_20260929T140832Z-0c1c4d'), 'summary carries invocation id');
  assert(s.artifacts.length === 3 && s.blockers.length === 0 && s.evidence.length >= 8, 'ship shape');
} else {
  assert(s.verdict === 'fix', 'verdict fix, got ' + s.verdict);
  assert(s.blockers.length >= 1, 'fix carries a blocker');
  if (scenario === 'red') assert(s.archon_status === 'fix' || s.archon_run_id === 'none', 'red status consistent');
  if (scenario === 'refuse-first') assert(s.summary.includes('refused by the contract'), 'degraded receipt explains the refusal');
}
console.log('REHEARSAL PASS [' + scenario + ']: verdict=' + s.verdict + ' archon_status=' + s.archon_status + ' run_id=' + s.archon_run_id.slice(0, 8) + ' submissions=' + submissions.length);
