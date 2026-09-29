// A2-d WM program — the four failure-path probes. Each probe demands an
// EXPLICIT refusal from a real system layer, then the program continues —
// refusal + recovery, never a silent success or a silent crash:
//
//   P1 missing capability — rcos registry refusal (exit 2) BEFORE any
//      invocation record is created; no trace is the correct side-effect.
//   P2 invalid identity (kernel layer) — the promoted route-record-validate
//      capability refuses a delegated-child handoff record (kernel exit 3,
//      verdict authority-refusal) while the invocation itself completes
//      (adapter exit 0): the run recovers and reports the refusal.
//   P3 permission denied — the local ptc bash sandbox denies a write OUTSIDE
//      the seat workspace ("Operation not permitted") and leaves no file.
//   P4 backend down — ssh to a closed local port fails "Connection refused";
//      never the real Dell.
//
// The order P1 -> P2 -> P3 -> P4 plus this receipt IS the recovery proof: the
// seat kept serving after every refusal. Zero model spend; no Archon run in
// this dispatch (failure-path probes only), so the archon receipt fields are
// the contract literal 'none'. Receipt discipline identical to A2-c: 'ship'
// only if every probe produced its expected explicit refusal.
const DELL = 'chow@100.111.182.5';
const SSH = 'ssh -o BatchMode=yes -o ConnectTimeout=10';
const evidence = [];
let ok = true;
const flat = (r) => String(JSON.stringify(r)).replace(/\s+/g, ' ');
const text = (r) => (((r.stdout && r.stdout.text) || '') + '\n' + ((r.stderr && r.stderr.text) || ''));
const note = (name, passed, r, cap) => {
  if (!passed) ok = false;
  evidence.push(name + (passed ? ' [refused+recovered]' : ' [UNEXPECTED]') + ' exit=' + (r ? r.exitCode : 'n/a') + ' ' + (r ? flat(r).slice(0, cap || 420) : 'no result'));
};

// SHIP: byte-exact canonical probe inputs land on the Dell (P2 input is the
// 235-byte input.json of the calibrated invocation inv_20260929T142355Z-d8b6fb).
const shipP1 = await tools.bash({ command: `${SSH} ${DELL} "echo __B64_P1__ | base64 -d > /tmp/a2d-p1-input.json"`, description: 'Ship the P1 probe input to the Dell' });
const shipP2 = await tools.bash({ command: `${SSH} ${DELL} "echo __B64_P2__ | base64 -d > /tmp/a2d-p2-input.json"`, description: 'Ship the canonical P2 probe input to the Dell' });
const shipOk = shipP1.exitCode === 0 && shipP2.exitCode === 0;
if (!shipOk) ok = false;
evidence.push('ship/inputs [byte-exact] exit=' + shipP1.exitCode + ',' + shipP2.exitCode);

// P1 — MISSING CAPABILITY: the registry must refuse explicitly. Verified real
// calibration: exit 2, stdout empty, stderr 'rcos: no such capability
// 'no-such-capability' in the registry'; no invocation dir appears.
const p1 = await tools.bash({ command: `${SSH} ${DELL} '"$HOME/zcode-rcos/bin/rcos" run no-such-capability --input /tmp/a2d-p1-input.json --json'`, description: 'P1 missing capability: expect explicit registry refusal, exit 2, no invocation created' });
const p1ok = p1.exitCode === 2 && /no such capability/.test(text(p1));
note('P1/missing-capability', p1ok, p1);

// P2 — INVALID IDENTITY (kernel layer): the run must COMPLETE while refusing
// the delegated-child record inside it. stdout is the invocation record JSON.
const p2 = await tools.bash({ command: `${SSH} ${DELL} '"$HOME/zcode-rcos/bin/rcos" run route-record-validate --input /tmp/a2d-p2-input.json --json'`, description: 'P2 invalid identity at the kernel: run completes, record refused' });
let p2j = null;
try { p2j = JSON.parse((p2.stdout && p2.stdout.text) || ''); } catch (e) { /* regex fallback below */ }
const invId = (p2j && p2j.invocation_id) || ((/inv_[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}/.exec(text(p2)) || [])[0] || null);
const p2ok = p2.exitCode === 0 && p2j !== null
  && p2j.status === 'completed'
  && p2j.adapter && p2j.adapter.exit_code === 0
  && Array.isArray(p2j.evidence) && p2j.evidence.some((e) => String(e.path || '').includes('kernel-authority-refused'))
  && invId !== null;
note('P2/kernel-refusal(run-completed)', p2ok, p2, 500);

// P2b — the run's OWN output.json carries the refusal verdict.
const p2b = invId ? await tools.bash({ command: `${SSH} ${DELL} 'cat "$HOME/zcode-rcos/invocations/${invId}/output.json"'`, description: 'P2 read the invocation output.json (the refusal verdict)' }) : null;
let p2bj = null;
if (p2b && p2b.exitCode === 0) { try { p2bj = JSON.parse(p2b.stdout.text || ''); } catch (e) { /* leave null */ } }
const rec0 = p2bj && Array.isArray(p2bj.records) ? p2bj.records[0] : null;
const p2bok = !!(p2bj && rec0 && rec0.exit === 3 && rec0.verdict === 'authority-refusal'
  && p2bj.summary && p2bj.summary.authority_refusals === 1 && p2bj.summary.valid === 0);
if (p2b) note('P2/kernel-refusal(verdict)', p2bok, p2b, 500);
else { ok = false; evidence.push('P2/kernel-refusal(verdict) [UNEXPECTED] no invocation id — output.json not read'); }

// P3 — PERMISSION DENIED (local ptc sandbox): a write outside the seat
// workspace must be denied and leave no file. Unique marker per run so stale
// residue can never false-fail the probe.
const marker = '/Users/adam26/.a2d-p3-deny-' + Date.now();
const p3 = await tools.bash({ command: `echo a2d-p3 > ${marker}`, description: 'P3 write outside the seat workspace: expect sandbox denial' });
const p3check = await tools.bash({ command: `test -e ${marker} && echo EXISTS || echo ABSENT`, description: 'P3 confirm the denied write left no file' });
const p3ok = (p3.exitCode !== 0 || (p3.sandbox && p3.sandbox.denied) === true)
  && /not permitted/i.test(text(p3))
  && /ABSENT/.test((p3check.stdout && p3check.stdout.text) || '');
note('P3/permission-denied', p3ok, p3, 500);
if (p3ok) evidence.push('P3/permission-denied [file-absent-confirmed] ' + ((p3check.stdout && p3check.stdout.text) || '').trim());

// P4 — BACKEND DOWN: ssh to a closed LOCAL port must fail explicitly.
const p4 = await tools.bash({ command: `ssh -p 1 -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null chow@127.0.0.1 true`, description: 'P4 backend down: connection to a closed port must be refused' });
const p4ok = p4.exitCode !== 0 && /connection refused/i.test(text(p4));
note('P4/backend-down', p4ok, p4);

// Receipt: gated on all four refusals; ids only from the systems' own output.
// Contract (dsh-seat-dispatch/lib/receipt.js): closed fields, archon_status
// is the run's OWN verdict artifact value (ship|fix|blocked|none); no Archon
// run here, so run id / artifact dir / status are the literal 'none'.
const ship = ok;
const invDir = invId ? '/home/chow/zcode-rcos/invocations/' + invId : null;
const receipt = {
  verdict: ship ? 'ship' : 'fix',
  summary: ship
    ? 'All four A2-d failure paths refused explicitly and the seat recovered after each. P1 missing capability: rcos registry refusal exit 2 ("no such capability"), refusal precedes invocation recording so no trace exists. P2 invalid identity at the kernel: invocation ' + invId + ' completed (adapter exit 0) while the delegated-child handoff record inside it was refused — kernel exit 3, verdict authority-refusal, summary.authority_refusals=1, evidence kernel-authority-refused.txt. P3 permission denied: the ptc sandbox denied a write outside the seat workspace ("Operation not permitted") and the file is absent. P4 backend down: ssh to closed 127.0.0.1:1 failed "Connection refused". The P1->P2->P3->P4 order plus this accepted receipt is the recovery demonstration. No Archon run in this dispatch; archon fields are the contract literal none. Zero model spend.'
    : 'One or more probes did NOT produce its expected explicit refusal — see the UNEXPECTED evidence rows. No artifacts claimed.',
  artifacts: ship && invDir ? [invDir + '/manifest.json', invDir + '/output.json', invDir + '/evidence/kernel-authority-refused.txt'] : [],
  evidence: evidence,
  blockers: ship ? [] : ['probe(s) marked UNEXPECTED — see evidence rows'],
  archon_run_id: 'none',
  archon_status: 'none',
  archon_artifact_dir: 'none',
  lane: 'loopback-0spend/deepseek-flash',
  next: 'A2-d CORRELATION.md (chain run-5 ids + these four refusal paths), then B1 Canvas Alpha',
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
    summary: 'Probes executed but the primary receipt was refused by the contract: ' + why,
    artifacts: [],
    evidence: evidence.length ? evidence.slice(0, 8) : ['no step evidence captured'],
    blockers: ['receipt contract refusal: ' + why],
    archon_run_id: 'none',
    archon_status: 'none',
    archon_artifact_dir: 'none',
    lane: 'loopback-0spend/deepseek-flash',
    next: 'compare the refused receipt fields against dsh-seat-dispatch/lib/receipt.js',
  });
}
return submitted;
