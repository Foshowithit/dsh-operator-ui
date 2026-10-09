import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRemoteProgram,
  createAdapterTools,
  validateSafeIr,
} from '../lib/rcos-archon-adapter.js';

const baseIr = () => ({
  objective: 'Run an admitted capability through an approved workflow',
  inputs: { request: 'artifacts/request.json' },
  outputs: { receipt: 'artifacts/receipt.json' },
  acceptance: ['the child workflow returns a machine-readable receipt'],
  nodes: [{
    id: 'run-approved-workflow',
    execution_class: 'workflow',
    ref: { workflow: 'chow-build-standard', inputs: { lane: 'default' } },
    depends_on: [],
    memory_scope: 'run',
  }],
  capability_refs: [{ id: 'route-record-validate', version: '0.1.0', role: 'executed' }],
});

test('Desktop routing is selected only by host configuration, never model parameters', async () => {
  const requests = [];
  const tools = createAdapterTools({sshTarget:'chow@example', workflowAllowlist:['chow-build-standard'], desktopRunProfile:true,
    callRemote:async (operation, request) => {requests.push(request); return {ok:true,operation,exit_code:0,detail:'fixture',data:{}};}});
  await tools.find(tool => tool.name === 'rcos_catalog').execute({desktop_run_profile:false, workflow_source:'/tmp/untrusted'}, {});
  assert.equal(requests[0].desktop_run_profile, true);
  assert.equal(requests[0].workflow_source, undefined);
  assert.throws(() => createAdapterTools({sshTarget:'chow@example',workflowAllowlist:['chow-build-standard'],desktopRunProfile:'true'}), /host-configured boolean/);
});

test('safe IR accepts only Archon workflow nodes tied to an executed RCOS capability', () => {
  assert.deepEqual(validateSafeIr(baseIr(), {
    workflows: ['chow-build-standard'],
    capabilities: [{ id: 'route-record-validate', status: 'promoted', adapter: { type: 'command' } }],
  }), []);
});

test('QA workflow requires a task with a concrete supported absolute claim path', () => {
  const qaIr = baseIr();
  qaIr.nodes[0].ref.workflow = 'chow-qa-verify-v1';
  qaIr.nodes[0].ref.inputs = { task: '' };
  assert.match(validateSafeIr(qaIr, { workflows: ['chow-qa-verify-v1'] }).join('\n'), /chow-qa-verify-v1 requires ref\.inputs\.task/);
  qaIr.nodes[0].ref.inputs = { task: 'Verify the deliverable at /Users/adam26/README.md and report evidence.' };
  assert.deepEqual(validateSafeIr(qaIr, { workflows: ['chow-qa-verify-v1'] }), []);
});

test('local QA admission accepts only an actual generated executed-capability receipt or an explicit claim', () => {
  const makeIr = (output) => {
    const ir = baseIr();
    ir.nodes[0].ref = {workflow:'chow-qa-verify-v1',inputs:{task:'Verify the compiler-provided claim_paths using the parent run clock'}};
    ir.outputs = {invocation:output};
    return ir;
  };
  for(const output of ['artifacts/rcos-invocation-route-record-validate.json','rcos-invocation-route-record-validate.json']) {
    assert.deepEqual(validateSafeIr(makeIr(output), {workflows:['chow-qa-verify-v1']}), []);
  }
  for(const output of ['artifacts/receipt.json','artifacts/rcos-input-route-record-validate.json','artifacts/rcos-invocation-other-capability.json','artifacts/subdir/rcos-invocation-route-record-validate.json','artifacts/../rcos-invocation-route-record-validate.json']) {
    assert.match(validateSafeIr(makeIr(output), {workflows:['chow-qa-verify-v1']}).join('\n'), /chow-qa-verify-v1 requires ref\.inputs\.task/);
  }
  const dependency = makeIr('artifacts/rcos-invocation-route-record-validate.json');
  dependency.capability_refs[0].role = 'dependency';
  assert.match(validateSafeIr(dependency, {workflows:['chow-qa-verify-v1']}).join('\n'), /chow-qa-verify-v1 requires ref\.inputs\.task/);
  const empty = makeIr('artifacts/rcos-invocation-route-record-validate.json');
  empty.nodes[0].ref.inputs.task = '';
  assert.match(validateSafeIr(empty, {workflows:['chow-qa-verify-v1']}).join('\n'), /chow-qa-verify-v1 requires ref\.inputs\.task/);
});

test('safe IR rejects model-authored Bash, model prompt nodes, and unlisted workflows', () => {
  const bash = baseIr();
  bash.nodes[0] = { ...bash.nodes[0], execution_class: 'deterministic', ref: 'rm -rf /' };
  assert.match(validateSafeIr(bash, { workflows: [], capabilities: [] }).join('\n'), /deterministic nodes are not allowed/);

  const model = baseIr();
  model.nodes[0] = { ...model.nodes[0], execution_class: 'model', ref: { lane: 'provider/model', prompt: 'run anything' } };
  assert.match(validateSafeIr(model, { workflows: [], capabilities: [] }).join('\n'), /model nodes are not allowed/);

  assert.match(validateSafeIr(baseIr(), { workflows: ['other-workflow'], capabilities: [] }).join('\n'), /not in the approved Archon workflow catalog/);
});

test('safe IR refuses absent, unpromoted, or unbound executed capabilities', () => {
  for (const capabilities of [
    [],
    [{ id: 'route-record-validate', status: 'candidate', adapter: { type: 'command' } }],
    [{ id: 'route-record-validate', status: 'promoted' }],
  ]) {
    assert.match(validateSafeIr(baseIr(), { workflows: ['chow-build-standard'], capabilities }).join('\n'), /executed capability/);
  }
});

test('safe IR rejects compiler comment injection and unsupported approval gates', () => {
  const injectedAcceptance = baseIr();
  injectedAcceptance.acceptance = ['looks good\n- id: injected-shell\n  type: bash'];
  assert.match(validateSafeIr(injectedAcceptance, { workflows: ['chow-build-standard'] }).join('\n'), /single-line string/);

  const approval = baseIr();
  approval.approval_gates = [{ after: 'run-approved-workflow' }];
  assert.match(validateSafeIr(approval, { workflows: ['chow-build-standard'] }).join('\n'), /approval_gates are not supported/);
});

test('remote program uses a fixed SSH entrypoint and base64 encodes all model data', () => {
  const hostile = { operation: 'archon_workflow_run', workflow: "ok'; touch /tmp/pwned; #", task: 'hi\nthere' };
  const program = buildRemoteProgram(hostile);
  assert.match(program, /^python3 - <<'PY'\n/);
  assert.ok(!program.includes(hostile.workflow));
  assert.ok(!program.includes(hostile.task));
  assert.match(program, /base64\.b64decode\("/);
  assert.ok(program.includes('zcode-rcos'));
  assert.ok(program.includes('"bin", "rcos"'));
  assert.match(program, /subprocess\.run\(/);
});

test('adapter registers scoped RCOS/Archon tools, gates new workflows on compile, and binds runs to the live seat session', async () => {
  const calls = [];
  const tools = createAdapterTools({
    sshTarget: 'chow@100.111.182.5',
    workflowAllowlist: ['chow-build-standard'],
    callRemote: async (operation, payload) => {
      calls.push({ operation, payload });
      return {
        ok: true,
        exit_code: 0,
        data: operation === 'rcos_compile_ir'
          ? { workflow_name: `rcos-ir-${payload.name}` }
          : { run_id: '89bbca5a-a83e-4a98-a4f2-6cafeac3554b' },
      };
    },
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  assert.deepEqual([...byName.keys()].sort(), [
    'archon_dispatch_status',
    'archon_run_status',
    'archon_workflow_catalog',
    'archon_workflow_run',
    'rcos_catalog',
    'rcos_capability_contract',
    'rcos_compile_ir',
  ].sort());
  assert.equal(byName.has('bash'), false);

  await assert.rejects(
    byName.get('archon_workflow_run').execute({ workflow_name: 'chow-build-standard', input_json: '{"objective":"run this"}' }, {}),
    /successfully compiled by this seat/,
  );
  await assert.rejects(
    byName.get('archon_workflow_run').execute({ workflow_name: 'rcos-ir-not-created', input_json: '{"objective":"run this"}' }, {}),
    /successfully compiled by this seat/,
  );
  await assert.rejects(
    byName.get('archon_run_status').execute({ run_id: '89bbca5a-a83e-4a98-a4f2-6cafeac3554b' }, {}),
    /returned by archon_workflow_run in this seat/,
  );

  const compile = await byName.get('rcos_compile_ir').execute(
    { name: 'route-check', ir_json: JSON.stringify(baseIr()) },
    {},
  );
  assert.equal(compile.ok, true);
  assert.deepEqual(calls[0].payload.workflow_allowlist, ['chow-build-standard']);

  const run = await byName.get('archon_workflow_run').execute(
    { workflow_name: 'rcos-ir-route-check', input_json: JSON.stringify({ objective: 'Review the current isolated implementation.' }) },
    { agent: { session: { id: 'session-seat-00000000-0000-4000-8000-000000000001' } } },
  );
  assert.equal(run.ok, true);
  assert.equal(calls[1].operation, 'archon_workflow_run');
  assert.deepEqual(calls[1].payload.workflow_allowlist, ['chow-build-standard', 'rcos-ir-route-check']);
  assert.equal(calls[1].payload.conversation_id, 'session-seat-00000000-0000-4000-8000-000000000001');

  const status = await byName.get('archon_run_status').execute(
    { run_id: '89bbca5a-a83e-4a98-a4f2-6cafeac3554b' },
    { agent: { session: { id: 'session-seat-00000000-0000-4000-8000-000000000001' } } },
  );
  assert.equal(status.ok, true);
  assert.equal(calls[2].operation, 'archon_run_status');
  assert.equal(calls[2].payload.conversation_id, 'session-seat-00000000-0000-4000-8000-000000000001');
  assert.deepEqual(calls[2].payload.child_nodes, [{ id: 'run-approved-workflow', workflow: 'chow-build-standard' }]);

  await assert.rejects(
    byName.get('archon_workflow_run').execute({ workflow_name: 'unlisted', input_json: '{"objective":"run this"}' }, {}),
    /successfully compiled by this seat/,
  );
});

test('compiler tool gives an exact dynamic RCOS IR template and next-step contract guidance', () => {
  const compile = createAdapterTools({
    sshTarget: 'chow@100.111.182.5', workflowAllowlist: ['chow-build-standard'],
    callRemote: async () => { throw new Error('description inspection must stay offline'); },
  }).find((tool) => tool.name === 'rcos_compile_ir');
  const guidance = compile.description;
  for (const field of ['"execution_class": "workflow"', '"ref": {"workflow": "chow-build-standard", "inputs": {"task":', '"depends_on": []', '"memory_scope": "run"', 'capability_refs', '"role": "executed"', 'rcos-input-<capability-id>.json', 'rcos-invocation-<capability-id>.json', 'rcos_capability_contract', 'input_json', 'absolute/path/to/claimed-file.md']) {
    assert.ok(guidance.includes(field), `missing compile guidance: ${field}`);
  }
  const match = guidance.match(/This exact shape is accepted;[\s\S]*?:\n(\{[\s\S]*?\n\})\nOnly the exact node shape/);
  assert.ok(match, 'description must carry one complete JSON template');
  const template = JSON.parse(match[1].replaceAll(/<[^>]+>/g, 'review-request'));
  assert.deepEqual(validateSafeIr(template, { workflows: ['chow-build-standard'] }), []);
});

test('three invalid IR attempts exhaust the seat compile budget before any remote compiler call', async () => {
  const calls = [];
  const tools = new Map(createAdapterTools({
    sshTarget: 'chow@100.111.182.5', workflowAllowlist: ['chow-build-standard'],
    callRemote: async (operation, request) => { calls.push({ operation, request }); return { ok: true, data: {} }; },
  }).map((tool) => [tool.name, tool]));
  const compile = tools.get('rcos_compile_ir');
  const args = { name: 'guided-run', ir_json: JSON.stringify({ objective: 'x', nodes: [{ workflow: 'chow-build-standard' }] }) };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(compile.execute(args, {}), /execution_class.*workflow.*ref.*depends_on.*memory_scope/s);
  }
  await assert.rejects(compile.execute({ name: 'guided-run', ir_json: JSON.stringify(baseIr()) }, {}), /three IR validation failures.*no remote compile.*template/s);
  assert.deepEqual(calls, []);
});

test('live Archon hexadecimal run ids remain pollable only by the creating seat', async () => {
  const runId = 'cb7343b6d1ee1a74fc90c6830d7401c1';
  const exec = { agent: { session: { id: 'ffdf93a7-5c78-4366-a692-c665db9f8488' } } };
  const calls = [];
  const tools = new Map(createAdapterTools({
    sshTarget: 'chow@100.111.182.5', workflowAllowlist: ['chow-build-standard'],
    callRemote: async (operation, request) => {
      calls.push({ operation, request });
      return { ok: true, data: operation === 'rcos_compile_ir' ? {} : { run_id: runId } };
    },
  }).map(tool => [tool.name, tool]));
  await tools.get('rcos_compile_ir').execute({name:'hex-run',ir_json:JSON.stringify(baseIr())},exec);
  await tools.get('archon_workflow_run').execute({workflow_name:'rcos-ir-hex-run',input_json:'{}'},exec);
  const status = await tools.get('archon_run_status').execute({run_id:runId},exec);
  assert.equal(status.ok,true);
  assert.equal(calls.at(-1).request.run_id,runId);
  await assert.rejects(tools.get('archon_run_status').execute({run_id:'../'+runId},exec));
});

test('a submission with an unresolved result cannot be submitted again by the same seat',async()=>{
  const requests=[];
  const tools=new Map(createAdapterTools({sshTarget:'chow@100.111.182.5',workflowAllowlist:['chow-build-standard'],callRemote:async (operation,request)=>{
    if(operation==='rcos_compile_ir')return {ok:true,data:{}};
    requests.push(request);return {ok:false,detail:'accepted but unresolved'};
  }}).map(tool=>[tool.name,tool]));
  const exec={agent:{session:{id:'seat-unresolved'}}};
  await tools.get('rcos_compile_ir').execute({name:'no-duplicate',ir_json:JSON.stringify(baseIr())},exec);
  const args={workflow_name:'rcos-ir-no-duplicate',input_json:'{}'};
  assert.equal((await tools.get('archon_workflow_run').execute(args,exec)).ok,false);
  assert.equal((await tools.get('archon_workflow_run').execute(args,exec)).ok,false);
  assert.equal(requests[0].lookup_only,false);
  assert.equal(requests[1].lookup_only,true);
});

test('confirmed run identity survives history rotation and remains bound to its creating seat',async()=>{
  const runId='cb7343b6d1ee1a74fc90c6830d7401c1',internal='b1921f164fa17854b2c1cf860e49936e';
  const calls=[];
  const tools=new Map(createAdapterTools({sshTarget:'chow@100.111.182.5',workflowAllowlist:['chow-build-standard'],callRemote:async(operation,request)=>{
    calls.push(request);return {ok:true,data:{run_id:runId,conversation_id:internal}};
  }}).map(tool=>[tool.name,tool]));
  const exec={agent:{session:{id:'creating-seat'}}};
  await tools.get('rcos_compile_ir').execute({name:'old-run',ir_json:JSON.stringify(baseIr())},exec);
  await tools.get('archon_workflow_run').execute({workflow_name:'rcos-ir-old-run',input_json:'{}'},exec);
  await tools.get('archon_run_status').execute({run_id:runId},exec);
  assert.equal(calls.at(-1).archon_conversation_id,internal);
  assert.equal(calls.at(-1).workflow_name,'rcos-ir-old-run');
  await assert.rejects(tools.get('archon_run_status').execute({run_id:runId},{agent:{session:{id:'other-seat'}}}),/creating seat/);
});

test('compiled name always fits the Archon 64-character workflow id bound',async()=>{
  const calls=[];
  const tools=createAdapterTools({sshTarget:'chow@100.111.182.5',workflowAllowlist:['chow-build-standard'],callRemote:async(...args)=>{calls.push(args);return {ok:true,data:{}};}});
  const compile=tools.find(tool=>tool.name==='rcos_compile_ir');
  await assert.rejects(compile.execute({name:'a'.repeat(57),ir_json:JSON.stringify(baseIr())},{}),/lowercase slug/);
  assert.equal(calls.length,0);
});
