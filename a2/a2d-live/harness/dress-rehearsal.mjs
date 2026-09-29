// Dress rehearsal for program.a2d.txt: run the WHOLE probe program against
// mocked bash results shaped exactly like the real ptc runtime (each refusal
// calibrated from a real captured run), with the REAL receipt validator
// (imported from the seat-dispatch bundle) enforcing the contract on
// submit_dispatch_receipt — including one-receipt-only and hard refusal on
// any violation.
//
// Scenarios (arg 1): green (all four probes refuse as expected -> ship),
// red (the P3 sandbox DENIAL FAILS TO HAPPEN — the write succeeds, which is
// the worst failure mode a permission probe can have -> fix),
// refuse-first (submit refused once -> degraded receipt must still validate).
import { readFileSync } from 'node:fs';
import { validateReceipt } from '/Users/adam26/dsh-a0-boot/bundles/seat-dispatch-real/dsh-seat-dispatch/lib/receipt.js';

const scenario = process.argv[2] || 'green';
const HERE = new URL('.', import.meta.url);
const p2stdout = readFileSync(new URL('p2-invocation-stdout.json', HERE), 'utf8').trim();
const p2output = readFileSync(new URL('p2-output.json', HERE), 'utf8').trim();

function bashResult(stdoutText, { exitCode = 0, stderrText = '', denied = false } = {}) {
  return { kind: 'foreground', exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 60000,
    stdout: { text: stdoutText, truncated: false }, stderr: { text: stderrText, truncated: false },
    sandbox: { mode: 'workspace-write', denied, enforcement: 'full' } };
}

const submissions = [];
let refusalsLeft = scenario === 'refuse-first' ? 1 : 0;

const tools = {
  bash: async ({ command }) => {
    if (command.includes('base64 -d > /tmp/a2d-p1-input.json')) return bashResult('');
    if (command.includes('base64 -d > /tmp/a2d-p2-input.json')) return bashResult('');
    if (command.includes('no-such-capability')) {
      // calibrated real refusal: exit 2, stdout empty, message on stderr
      return bashResult('', { exitCode: 2, stderrText: "rcos: no such capability 'no-such-capability' in the registry" });
    }
    if (command.includes('route-record-validate --input')) return bashResult(p2stdout);
    if (command.includes('/output.json')) return bashResult(p2output);
    if (command.includes('echo a2d-p3 >')) {
      if (scenario === 'red') {
        // the denial did NOT happen: sandbox stayed silent and the write landed
        return bashResult('', { exitCode: 0, denied: false });
      }
      return bashResult('', { exitCode: 1, stderrText: 'zsh: operation not permitted: /Users/adam26/.a2d-p3-deny-1770000000000', denied: true });
    }
    if (command.includes('test -e')) {
      return bashResult(scenario === 'red' ? 'EXISTS\n' : 'ABSENT\n');
    }
    if (command.includes('-p 1')) {
      return bashResult('', { exitCode: 255, stderrText: 'ssh: connect to host 127.0.0.1 port 1: Connection refused' });
    }
    return { ...bashResult(''), exitCode: 1, stderr: { text: 'a2d rehearsal: unmatched command — fail loud', truncated: false } };
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

const body = readFileSync('/Users/adam26/dsh-a0-boot/a2d/program.a2d.txt', 'utf8');
const program = new Function('tools', `return (async () => {\n${body}\n})();`);

const final = await program(tools);
const s = submissions[0];
const assert = (cond, msg) => { if (!cond) { console.error('REHEARSAL FAIL [' + scenario + ']: ' + msg); process.exit(1); } };

assert(submissions.length === 1, 'exactly one accepted submission (got ' + submissions.length + ')');
if (scenario === 'green') {
  assert(s.verdict === 'ship', 'verdict ship, got ' + s.verdict);
  assert(s.archon_run_id === 'none' && s.archon_status === 'none' && s.archon_artifact_dir === 'none', 'archon none/none/none');
  assert(s.artifacts.length === 3 && s.artifacts[0].includes('inv_20260929T142355Z-d8b6fb'), 'artifacts are the P2 invocation files');
  assert(s.artifacts.includes('/home/chow/zcode-rcos/invocations/inv_20260929T142355Z-d8b6fb/evidence/kernel-authority-refused.txt'), 'kernel refusal evidence artifact');
  assert(s.blockers.length === 0 && s.evidence.length === 7, 'ship shape: no blockers, 7 evidence rows (ship + P1 + P2run + P2verdict + P3 + P3confirm + P4), got ' + s.evidence.length);
  const rows = s.evidence.join('\n');
  assert(rows.includes('P1/missing-capability [refused+recovered]'), 'P1 row');
  assert(rows.includes('P2/kernel-refusal(run-completed) [refused+recovered]'), 'P2 run row');
  assert(rows.includes('P2/kernel-refusal(verdict) [refused+recovered]'), 'P2 verdict row');
  assert(rows.includes('P3/permission-denied [refused+recovered]'), 'P3 row');
  assert(rows.includes('P4/backend-down [refused+recovered]'), 'P4 row');
  assert(!rows.includes('UNEXPECTED'), 'no unexpected rows in green');
} else {
  assert(s.verdict === 'fix', 'verdict fix, got ' + s.verdict);
  assert(s.blockers.length >= 1, 'fix carries a blocker');
  assert(s.artifacts.length === 0, 'fix claims no artifacts');
  if (scenario === 'red') assert(s.evidence.join('\n').includes('P3/permission-denied [UNEXPECTED]'), 'red names the silent-success P3');
  if (scenario === 'refuse-first') assert(s.summary.includes('refused by the contract'), 'degraded receipt explains the refusal');
}
console.log('REHEARSAL PASS [' + scenario + ']: verdict=' + s.verdict + ' archon=' + s.archon_run_id + '/' + s.archon_status + ' submissions=' + submissions.length + ' evidence=' + s.evidence.length);
