import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mod = await import('../lib/run-artifacts.js').catch(() => ({}));
const binding = { dispatch_id: 'sd-20261004T203020Z-96efb6', caller_session_id: 'caller-1', seat_session_id: 'seat-1', run_id: 'b'.repeat(32), archon_conversation_id: 'f'.repeat(32), workflow_name: 'rcos-ir-test', child_nodes: [{ id: 'qa', workflow: 'chow-qa-verify-v1' }] };
const record = { run_id: binding.dispatch_id, caller_session_id: binding.caller_session_id, seat_session_id: binding.seat_session_id, stage: 'complete', receipt_accepted: true, seat: 'workflow-manager', caller_preset: 'general-idea', authority_basis: 'no-parent-root', archon: { run_id: binding.run_id }, archon_binding: binding };

test('Archon detail capture kills excessive output and hung commands within its hard limits', () => {
  const source = fileURLToPath(new URL('../lib/run-artifacts-remote.py', import.meta.url));
  const script = String.raw`
import importlib.util, sys, time
spec=importlib.util.spec_from_file_location('preview', ${JSON.stringify(source)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert m.read_detail([sys.executable,'-c','print("{}")']) == {}
for code in ['import os; os.write(1,b"x"*1048576)', 'import os; os.write(2,b"x"*65536)', 'import time; time.sleep(10)']:
 start=time.monotonic()
 try: m.read_detail([sys.executable,'-c',code],timeout=0.5)
 except ValueError: pass
 else: raise AssertionError('unbounded subprocess accepted')
 assert time.monotonic()-start < 2
print('PASS: bounded stdout, stderr, timeout')
`;
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('artifact access resolves only the matching accepted host dispatch', async () => {
  assert.equal(typeof mod.readArtifactBinding, 'function', 'bounded host artifact binding is missing');
  const dir = await mkdtemp(join(tmpdir(), 'rcos-artifacts-'));
  try {
    await writeFile(join(dir, 'seat-dispatch.jsonl'), JSON.stringify(record) + '\n');
    const args = { auditDir: dir, dispatchId: binding.dispatch_id, callerSessionId: 'caller-1', runId: binding.run_id };
    assert.deepEqual(await mod.readArtifactBinding(args), binding);
    await assert.rejects(mod.readArtifactBinding({ ...args, callerSessionId: 'other' }), /originating chat/);
    await assert.rejects(mod.readArtifactBinding({ ...args, runId: 'a'.repeat(32) }), /identity/);
    await writeFile(join(dir, 'seat-dispatch.jsonl'), JSON.stringify(record) + '\n' + JSON.stringify(record) + '\n');
    await assert.rejects(mod.readArtifactBinding(args), /ambiguous/);
    await writeFile(join(dir, 'seat-dispatch.jsonl'), JSON.stringify({ ...record, receipt_accepted: false }) + '\n');
    await assert.rejects(mod.readArtifactBinding(args), /accepted/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('artifact route refuses public ownership ambiguity and renderer paths before SSH', async () => {
  assert.equal(typeof mod.createRunArtifactHandler, 'function', 'read-only artifact handler is missing');
  let calls = 0;
  const handler = mod.createRunArtifactHandler({ remote: async () => { calls++; return {}; } });
  const response = () => ({ status: null, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = body; } });
  const req = { method: 'GET', auth: { principal: { id: 'user' } } };
  let res = response();
  await handler(req, res, new URL('http://localhost/?dispatch_id=' + binding.dispatch_id), { artifacts: { sshTarget: 'chow@host' } });
  assert.equal(res.status, 403);
  req.auth.principal = null;
  res = response();
  await handler(req, res, new URL('http://localhost/?path=/etc/passwd'), { artifacts: { sshTarget: 'chow@host' } });
  assert.equal(res.status, 400);
  assert.equal(calls, 0);
});

test('remote preview enforces actual disk hashes, symlink boundaries, sizes and Archon identity', () => {
  const source = fileURLToPath(new URL('../lib/run-artifacts-remote.py', import.meta.url));
  const script = String.raw`
import importlib.util, tempfile, pathlib, json, hashlib
spec=importlib.util.spec_from_file_location('preview', ${JSON.stringify(source)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
 home=pathlib.Path(temp).resolve(); rid='b'*32
 root=home/'.archon/workspaces/test/artifacts/runs'/rid; root.mkdir(parents=True)
 inv=b'{"invocation_id":"one"}'; (root/'rcos-invocation-video.json').write_bytes(inv)
 media=b'fixture-media'; (root/'desktop-review').mkdir(); (root/'desktop-review/take.mp4').write_bytes(media)
 packet={'schema':'dsh-run-review/1','parent_run_id':rid,'invocation_receipt':'rcos-invocation-video.json','invocation_receipt_sha256':hashlib.sha256(inv).hexdigest(),'files':[{'name':'desktop-review/take.mp4','bytes':len(media),'sha256':hashlib.sha256(media).hexdigest()}]}
 manifest=root/'desktop-review.json'; manifest.write_text(json.dumps(packet))
 b={'run_id':rid,'archon_conversation_id':'f'*32,'workflow_name':'rcos-ir-test'}
 detail={'id':rid,'conversation_id':b['archon_conversation_id'],'workflow_name':b['workflow_name'],'output_root':str(root.parents[2])}
 req={'binding':b,'file':'desktop-review/take.mp4'}
 def reject(request=req, value=detail):
  try: m.inspect(request,home,value)
  except (ValueError,OSError): return
  raise AssertionError('unsafe read accepted')
 assert m.inspect(req,home,detail)['file']['sha256']==hashlib.sha256(media).hexdigest()
 assert len(m.inspect({'binding':b},home,detail)['files'])==2
 reject(value={**detail,'conversation_id':'a'*32}); reject(value={**detail,'workflow_name':'rcos-ir-other'})
 reject(value={**detail,'output_root':str(home/'outside')})
 reject(request={'binding':b,'file':'../../passwd'})
 (root/'desktop-review/take.mp4').write_bytes(b'tampered'); reject()
 (root/'desktop-review/take.mp4').unlink(); outside=home/'outside.mp4'; outside.write_bytes(media)
 (root/'desktop-review/take.mp4').symlink_to(outside); reject()
 (root/'desktop-review/take.mp4').unlink(); (root/'desktop-review').rmdir()
 folder=home/'external'; folder.mkdir(); (folder/'take.mp4').write_bytes(media)
 (root/'desktop-review').symlink_to(folder, target_is_directory=True); reject()
 (root/'desktop-review').unlink(); (root/'desktop-review').mkdir(); (root/'desktop-review/take.mp4').write_bytes(media)
 (root/'rcos-invocation-video.json').write_bytes(b'changed'); reject()
 (root/'rcos-invocation-video.json').write_bytes(inv)
 packet['files'][0]['bytes']=m.LIMIT+1; manifest.write_text(json.dumps(packet)); reject()
 packet['files'][0]['bytes']=len(media); packet['files'].append(dict(packet['files'][0])); manifest.write_text(json.dumps(packet)); reject()
 print('PASS: exact bytes, list, conversation, workflow, workspace, traversal, tamper, leaf/directory symlinks, invocation digest, byte cap, duplicate names')
`;
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS/);
});

test('accepted artifact route sends only the host binding and safe file name to its configured target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rcos-preview-route-'));
  try {
    await writeFile(join(dir, 'seat-dispatch.jsonl'), JSON.stringify(record) + '\n');
    const calls = [];
    const handler = mod.createRunArtifactHandler({ auditDir: dir, remote: async (target, request) => { calls.push({ target, request }); return { ok: true, run_id: binding.run_id, files: [] }; } });
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    const query = new URLSearchParams({ dispatch_id: binding.dispatch_id, caller_session_id: binding.caller_session_id, run_id: binding.run_id, file: 'desktop-review/take.mp4' });
    await handler({ method: 'GET', auth: { principal: null } }, res, new URL('http://localhost/?' + query), { artifacts: { sshTarget: 'chow@host' } });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [{ target: 'chow@host', request: { binding, file: 'desktop-review/take.mp4' } }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the domain report is resolved from the RCOS invocation and pinned by the run artifact hash', () => {
  // The run artifact's rcos-invocation-<cap>.json carries invocation_id and
  // output.sha256 -- a POINTER to the domain report but not its bytes. The bytes
  // live in the RCOS home at invocations/<id>/output.json. This test proves the
  // bridge: the report is exposed, and a report edited after sealing is REFUSED
  // rather than trusted. That is the exact evidence-access gap a reviewer hit
  // when it could see only output hashes.
  const source = fileURLToPath(new URL('../lib/run-artifacts-remote.py', import.meta.url));
  const script = String.raw`
import importlib.util, tempfile, pathlib, json, hashlib
spec=importlib.util.spec_from_file_location('preview', ${JSON.stringify(source)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
 home=pathlib.Path(temp).resolve(); rid='c'*32
 rcos=home/'zcode-rcos'; rcos.mkdir(parents=True)
 root=home/'.archon/workspaces/test/artifacts/runs'/rid; root.mkdir(parents=True)
 report={'schema':'mac-dell-staging-report/1','action':'stage','staging_id':'x-1','status':'fix','detail':{'reason':'sha256 mismatch'}}
 rbytes=json.dumps(report).encode()
 invdir=rcos/'invocations'/'inv_20261009T003205Z-abcdef'; invdir.mkdir(parents=True)
 (invdir/'output.json').write_bytes(rbytes)
 inv=json.dumps({'schema':'rcos-invocation/1','invocation_id':'inv_20261009T003205Z-abcdef','rcos_home':str(rcos),'adapter':{'exit_code':0},'output':{'path':'output.json','sha256':hashlib.sha256(rbytes).hexdigest(),'bytes':len(rbytes)}}).encode()
 (root/'rcos-invocation-mac-dell-staging.json').write_bytes(inv)
 b={'run_id':rid,'archon_conversation_id':'f'*32,'workflow_name':'rcos-ir-test'}
 detail={'id':rid,'conversation_id':b['archon_conversation_id'],'workflow_name':b['workflow_name'],'output_root':str(root.parents[2])}
 listing=m.inspect({'binding':b},home,detail)
 dr=[f for f in listing['files'] if f['name']=='rcos-domain-report.json']
 assert len(dr)==1, 'the domain report must appear in the listing'
 assert dr[0]['domain_status']=='fix', dr[0]
 got=m.inspect({'binding':b,'file':'rcos-domain-report.json'},home,detail)
 import base64
 assert json.loads(base64.b64decode(got['base64']))['status']=='fix'
 # a report edited after sealing must be REFUSED, not served
 (invdir/'output.json').write_bytes(json.dumps({**report,'status':'ship'}).encode())
 try:
  m.inspect({'binding':b,'file':'rcos-domain-report.json'},home,detail)
  raise AssertionError('a tampered domain report was served')
 except ValueError: pass
 print('PASS: domain report exposed, hash-pinned, tamper refused')
`
  const r = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS: domain report exposed, hash-pinned, tamper refused/);
});
