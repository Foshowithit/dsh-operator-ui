import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildRemoteProgram} from '../lib/rcos-archon-adapter.js';
const seat='ffdf93a7-5c78-4366-a692-c665db9f8488';
const runId='cb7343b6d1ee1a74fc90c6830d7401c1';
const workflow='rcos-ir-live-smoke';
const row={id:runId,conversation_id:'b1921f164fa17854b2c1cf860e49936e',worker_platform_id:seat,workflow_name:workflow,status:'failed'};
const reviewedWorkflows=['chow-build-standard','chow-fix-loop','chow-ui-build','chow-eval-gate-v2','chow-qa-verify-v1','chow-planning-standard-v1','chow-test-v1','chow-code-review','chow-verify-output-v1','chow-research-search-v1'];
function remote(request,rows=[row],home,options={}) {
  const shell=buildRemoteProgram({...request,workflow_allowlist:request.workflow_allowlist||[workflow]});
  const program=shell.slice(shell.indexOf('\n')+1,-4);
  const harness=`import subprocess,json,builtins,os\nfixture_rows=json.loads(${JSON.stringify(JSON.stringify(rows))})\ndetached_reply=json.loads(${JSON.stringify(JSON.stringify(options.detachedReply||{ok:true,action:'run',detached:true,runId:'12345678123412341234123412345678',workflow}))})\ndirect_detail=json.loads(${JSON.stringify(JSON.stringify(options.directDetail||{id:'12345678123412341234123412345678',conversation_id:'b1921f164fa17854b2c1cf860e49936e',workflow_name:workflow,status:'running'}))})\nget_ready_after=${Number(options.getReadyAfter||0)}\nadmission_failure=${options.admissionFailure===true?'True':'False'}\nrace_snapshot_wrapper=${options.raceSnapshotWrapper===true?'True':'False'}\nsqlite_rows=json.loads(${JSON.stringify(JSON.stringify(options.sqliteRows||[]))})\nsubmissions=[]\ncompiles=[]\nadmissions=[]\noutputs=[]\nget_reads=[0]\nhistory_reads=[0]\ndef fake_run(argv,**kwargs):\n    if argv[0]=='sqlite3':\n        return subprocess.CompletedProcess(argv,0,json.dumps(sqlite_rows),'')\n    if argv[1:3]==['workflow','list']: value={'workflows':[{'name':${JSON.stringify(workflow)}},*[{'name':name} for name in json.loads(${JSON.stringify(JSON.stringify(reviewedWorkflows))})]]}\n    elif argv[1:3]==['workflow','runs']:\n        history_reads[0]+=1\n        value={'runs':fixture_rows}\n    elif argv[1:3]==['workflow','run']:\n        submissions.append(argv)\n        return subprocess.CompletedProcess(argv,0,json.dumps(detached_reply),'')\n    elif argv[1:3]==['workflow','get']:\n        if argv[3]==detached_reply.get('runId'):\n            get_reads[0]+=1\n            if get_reads[0]<=get_ready_after:return subprocess.CompletedProcess(argv,1,'','run not indexed yet')\n            value=direct_detail\n        else:value=next((row for row in fixture_rows if row.get('id')==argv[3]),fixture_rows[0])\n    elif argv[1:3]==['query','--json']: value={'capabilities':[{'id':'route-record-validate','status':'promoted','adapter':{'type':'command'}}]}\n    elif argv[1:3]==['ir-compile','--ir']:\n        compiles.append(argv)\n        if os.path.isdir(os.path.join(os.path.expanduser('~'),'.archon','rcos-desktop','source')):\n            original=os.path.join(os.path.expanduser('~'),'.archon','workflows','rcos-ir-'+argv[argv.index('--name')+1]+'.yaml')\n            os.makedirs(os.path.dirname(original),exist_ok=True)\n            open(original,'w').write('name: fixture-compiled-wrapper\\n')\n            if race_snapshot_wrapper:\n                snapshot=os.path.join(os.path.expanduser('~'),'.archon','rcos-desktop','source','.archon','workflows','rcos-ir-'+argv[argv.index('--name')+1]+'.yaml')\n                open(snapshot,'w').write('name: race-created-wrapper\\n')\n        return subprocess.CompletedProcess(argv,0,'compiled','')\n    elif argv[0]=='python3' and len(argv)>1 and argv[1].endswith(('regenerate-desktop-manifests.py','verify-desktop-manifests.py')):\n        admissions.append(argv)\n        if admission_failure and argv[1].endswith('regenerate-desktop-manifests.py'): return subprocess.CompletedProcess(argv,1,'','fixture registration failed')\n        return subprocess.CompletedProcess(argv,0,'manifest pass','')\n    elif len(argv)>1 and argv[1] in ['invocation-verify','eligibility-verify']: value={'ok':argv[1]!=${JSON.stringify(options.verificationFailure||'')},'problems':[]}\n    else:\n        return subprocess.CompletedProcess(argv,1,'','unexpected command')\n    return subprocess.CompletedProcess(argv,0,json.dumps(value),'')\nsubprocess.run=fake_run\n${home ? `os.path.expanduser=lambda path: ${JSON.stringify(home)}\n` : ""}original_print=builtins.print\nbuiltins.print=lambda value: outputs.append(json.loads(value))\ntry:\n    exec(${JSON.stringify(program)})\nexcept SystemExit as error:\n    if error.code not in (None,0): raise\nfinally:\n    builtins.print=original_print\nprint(json.dumps({'result':outputs[0],'submissions':submissions,'compiles':compiles,'admissions':admissions,'get_reads':get_reads[0],'history_reads':history_reads[0]}))\n`;
  const process=spawnSync('python3',['-c',harness],{encoding:'utf8'});
  assert.equal(process.status,0,process.stderr);
  return JSON.parse(process.stdout);
}
const qaWorkflow='chow-qa-verify-v1';
test('Desktop routing refuses an unavailable host profile before submission or compilation',()=>{
  const home=mkdtempSync(join(tmpdir(),'dsh-host-profile-'));
  try {
    const out=remote({operation:'archon_workflow_run',workflow_name:workflow,task:'{}',conversation_id:seat,desktop_run_profile:true},[],home);
    assert.equal(out.result.ok,false);
    assert.match(out.result.detail,/host-owned Desktop workflow profile.*unavailable/);
    assert.equal(out.submissions.length,0);
    const compiled=remote({operation:'rcos_compile_ir',name:'host-profile',ir:qaIr('Verify /tmp/README.md'),workflow_allowlist:[qaWorkflow],desktop_run_profile:true},[],home);
    assert.equal(compiled.result.ok,false);
    assert.equal(compiled.compiles.length,0);
  } finally {rmSync(home,{recursive:true,force:true});}
});
function qaIr(task) {
  return {
    objective:'Verify QA claims using the approved deterministic evidence workflow',
    inputs:{request:'artifacts/qa-request.json'},
    outputs:{receipt:'artifacts/qa-receipt.json'},
    acceptance:['QA EVAL is machine-readable'],
    nodes:[{id:'qa',execution_class:'workflow',ref:{workflow:qaWorkflow,inputs:task === undefined ? {} : {task}},depends_on:[],memory_scope:'run'}],
    capability_refs:[{id:'route-record-validate',version:'0.1.0',role:'executed'}],
  };
}
test('remote approved catalog publishes the reviewed QA task input contract',()=>{
  const out=remote({operation:'archon_workflow_catalog',workflow_allowlist:[qaWorkflow]});
  const qa=out.result.data.workflows.find(item=>item.id===qaWorkflow||item.name===qaWorkflow);
  assert.equal(qa.input_contract.field,'ref.inputs.task');
  assert.match(qa.input_contract.requirement,/absolute.*claimed.*path/i);
});
test('scoped web research declares evidence validation and Muse execution contracts',()=>{
  const out=remote({operation:'archon_workflow_catalog',workflow_allowlist:['chow-research-search-v1']});
  const research=out.result.data.workflows.find(item=>(item.id||item.name)==='chow-research-search-v1');
  assert.deepEqual(research.evaluation_contract,{gate_eligible:true,artifact:'EVAL.json',field:'decision',comparison:'case_insensitive',ship_value:'ship'});
  assert.equal(research.execution_contract.desktop_profile_eligible,true);
  assert.match(research.execution_contract.reason,/Muse.*real search.*citations/i);
  assert.equal(research.input_contract.field,'ref.inputs.task');
  assert.match(research.input_contract.requirement,/query.*search snippets/i);
  assert.equal(research.input_contract.example,'Python pathlib Path official documentation --max 3');
});
test('remote approved catalog publishes only evidence-backed evaluation contracts',()=>{
  const out=remote({operation:'archon_workflow_catalog',workflow_allowlist:reviewedWorkflows});
  const items=out.result.data.workflows;
  const byId=new Map(items.map(item=>[item.id||item.name,item.evaluation_contract]));
  for(const id of ['chow-build-standard','chow-fix-loop','chow-ui-build','chow-eval-gate-v2','chow-qa-verify-v1']) {
    assert.deepEqual(byId.get(id),{gate_eligible:true,artifact:'EVAL.json',field:'decision',comparison:'case_insensitive',ship_value:'ship'});
  }
  for(const [id,artifact,field] of [
    ['chow-planning-standard-v1','EVAL.json','decision'],
    ['chow-test-v1','RECEIPT.json','classification'],
    ['chow-code-review','RECEIPT.json','decision'],
    ['chow-verify-output-v1','EVAL.json','verdict'],
  ]) {
    const contract=byId.get(id);
    assert.equal(contract.gate_eligible,false,id);
    assert.equal(contract.artifact,artifact,id);
    assert.equal(contract.field,field,id);
    assert.match(contract.reason,/./,id);
    assert.equal(contract.ship_value,undefined,id);
  }
});
test('remote approved catalog separates Desktop execution eligibility from EVAL gate eligibility',()=>{
  const out=remote({operation:'archon_workflow_catalog',workflow_allowlist:reviewedWorkflows});
  const items=out.result.data.workflows;
  const byId=new Map(items.map(item=>[item.id||item.name,item.execution_contract]));
  assert.deepEqual(byId.get('chow-build-standard'),{
    desktop_profile_eligible:true,
    reason:'Eligible only through the reviewed, noninteractive Desktop-scoped workflow source; the stock approval-interactive workflow is not supported.',
  });
  assert.deepEqual(byId.get('chow-qa-verify-v1'),{
    desktop_profile_eligible:true,
    reason:'Deterministic Bash evidence checks with local post-run context distillation; no approval node or direct provider call.',
  });
  for(const [id,reason] of [
    ['chow-fix-loop',/approval node.*interactive/i],
    ['chow-ui-build',/approval node.*interactive/i],
    ['chow-eval-gate-v2',/host-owned shared LLM helper.*Desktop-owned provider profile/i],
  ]) {
    const contract=byId.get(id);
    assert.equal(contract.desktop_profile_eligible,false,id);
    assert.match(contract.reason,reason,id);
  }
});
function compileIrFor(workflowName) {
  return {
    objective:'Run an approved workflow and evaluate its result',
    inputs:{request:'artifacts/request.json'},
    outputs:{receipt:'artifacts/receipt.json'},
    acceptance:['The workflow result is verified'],
    nodes:[{id:'run',execution_class:'workflow',ref:{workflow:workflowName,inputs:workflowName===qaWorkflow?{task:'Verify /tmp/README.md'}:{}},depends_on:[],memory_scope:'run'}],
    capability_refs:[{id:'route-record-validate',version:'0.1.0',role:'executed'}],
  };
}
test('remote RCOS compiler refuses workflows whose real result shape cannot satisfy the EVAL decision gate',()=>{
  for(const workflowName of ['chow-planning-standard-v1','chow-test-v1','chow-code-review','chow-verify-output-v1']) {
    const out=remote({operation:'rcos_compile_ir',name:'ineligible-contract',ir:compileIrFor(workflowName),workflow_allowlist:reviewedWorkflows});
    assert.equal(out.result.ok,false,workflowName);
    assert.match(out.result.data.violations.join(' '),new RegExp(`${workflowName}.*(?:not eligible|cannot satisfy).*EVAL`,'i'));
    assert.equal(out.compiles.length,0,workflowName);
  }
});
test('remote RCOS compiler refuses workflows outside the Desktop execution profile before installation',()=>{
  for(const workflowName of ['chow-fix-loop','chow-ui-build','chow-eval-gate-v2']) {
    const out=remote({operation:'rcos_compile_ir',name:'desktop-profile-ineligible',ir:compileIrFor(workflowName),workflow_allowlist:reviewedWorkflows});
    assert.equal(out.result.ok,false,workflowName);
    assert.match(out.result.data.violations.join(' '),new RegExp(`${workflowName}.*not eligible for the Desktop execution profile`,'i'));
    assert.equal(out.compiles.length,0,workflowName);
  }
});
test('remote RCOS compiler accepts eligible build and QA workflow refs',()=>{
  for(const workflowName of ['chow-build-standard',qaWorkflow]) {
    const out=remote({operation:'rcos_compile_ir',name:'eligible-contract',ir:compileIrFor(workflowName),workflow_allowlist:reviewedWorkflows});
    assert.equal(out.result.ok,true,`${workflowName}: ${JSON.stringify(out.result)}`);
    assert.equal(out.compiles.length,1,workflowName);
  }
});
test('remote RCOS compiler refuses QA workflow without task or claimed path before invoking RCOS',()=>{
  for(const task of [undefined,'Run QA and tell me if it is good']) {
    const out=remote({operation:'rcos_compile_ir',name:'qa-contract',ir:qaIr(task),workflow_allowlist:[qaWorkflow]});
    assert.equal(out.result.ok,false);
    assert.match(out.result.data.violations.join(' '),/chow-qa-verify-v1.*task.*absolute.*claimed path/i);
    assert.equal(out.compiles.length,0);
  }
});
test('remote RCOS compiler accepts QA task with an absolute claimed file path',()=>{
  const out=remote({operation:'rcos_compile_ir',name:'qa-contract',ir:qaIr('Verify /Users/adam26/README.md and report evidence'),workflow_allowlist:[qaWorkflow]});
  assert.equal(out.result.ok,true);
  assert.equal(out.result.data.workflow_name,'rcos-ir-qa-contract');
  assert.equal(out.compiles.length,1);
});
test('remote QA admission accepts an executed capability receipt that the compiler creates before verification',()=>{
  for(const output of ['artifacts/rcos-invocation-route-record-validate.json','rcos-invocation-route-record-validate.json']) {
    const ir=qaIr('Verify the compiler-provided claim_paths using the parent run clock');
    ir.outputs={invocation:output};
    const out=remote({operation:'rcos_compile_ir',name:'qa-generated-claim',ir,workflow_allowlist:[qaWorkflow]});
    assert.equal(out.result.ok,true,JSON.stringify(out.result));
    assert.equal(out.compiles.length,1);
  }
});
test('remote QA admission refuses claims that are not generated receipts of an executed capability',()=>{
  const cases=[
    {output:'artifacts/receipt.json'},
    {output:'artifacts/rcos-invocation-other-capability.json'},
    {output:'artifacts/subdir/rcos-invocation-route-record-validate.json'},
    {output:'artifacts/../rcos-invocation-route-record-validate.json'},
    {output:'artifacts/rcos-invocation-route-record-validate.json',role:'dependency'},
    {output:'artifacts/rcos-invocation-route-record-validate.json',inputOnly:true},
    {output:'artifacts/rcos-invocation-route-record-validate.json',task:''},
  ];
  for(const scenario of cases) {
    const ir=qaIr(scenario.task ?? 'Verify the compiler-provided claims');
    ir.outputs=scenario.inputOnly?{receipt:'artifacts/receipt.json'}:{invocation:scenario.output};
    if(scenario.inputOnly)ir.inputs={invocation:scenario.output};
    if(scenario.role)ir.capability_refs[0].role=scenario.role;
    const out=remote({operation:'rcos_compile_ir',name:'qa-unbound-claim',ir,workflow_allowlist:[qaWorkflow]});
    assert.equal(out.result.ok,false,JSON.stringify(scenario));
    assert.match(out.result.data.violations.join(' '),/chow-qa-verify-v1.*task.*claimed path/i);
    assert.equal(out.compiles.length,0);
  }
});
test('remote retry finds exact external seat mapping without submitting twice',()=>{
  const out=remote({operation:'archon_workflow_run',workflow_name:workflow,task:'{}',conversation_id:seat});
  assert.equal(out.result.ok,true);
  assert.equal(out.result.data.run_id,runId);
  assert.equal(out.result.data.already_submitted,true);
  assert.deepEqual(out.submissions,[]);
});
test('run binds exact detached JSON run id even when capped history omits it',()=>{
  const directRunId='11111111222233334444555566666666';
  const directDetail={id:directRunId,conversation_id:'b1921f164fa17854b2c1cf860e49936e',workflow_name:workflow,status:'running'};
  const out=remote({operation:'archon_workflow_run',workflow_name:workflow,task:'{}',conversation_id:seat},[],undefined,{
    detachedReply:{ok:true,action:'run',detached:true,runId:directRunId,workflow},
    directDetail,
    getReadyAfter:1,
  });
  assert.equal(out.result.ok,true,JSON.stringify(out.result));
  assert.equal(out.result.data.run_id,directRunId);
  assert.equal(out.result.data.conversation_id,directDetail.conversation_id);
  assert.equal(out.result.data.workflow_name,workflow);
  assert.equal(out.result.data.status,'running');
  assert.equal(out.result.data.already_submitted,false);
  assert.equal(out.submissions.length,1);
  assert.ok(out.submissions[0].includes('--json'));
  assert.equal(out.get_reads,2,'poll exact get id briefly until indexed');
  assert.equal(out.history_reads,1,'only duplicate precheck may query capped history');
});
test('remote status authorizes the exact CLI platform mapping rather than internal id',()=>{
  const out=remote({operation:'archon_run_status',run_id:runId,conversation_id:seat});
  assert.equal(out.result.ok,true);
  assert.equal(out.result.data.run_id,runId);
});
test('remote status refuses a run mapped to another seat',()=>{
  const out=remote({operation:'archon_run_status',run_id:runId,conversation_id:'other-seat'});
  assert.equal(out.result.ok,false);
});
test('ambiguous external seat workflow mapping never selects or resubmits',()=>{
  const out=remote({operation:'archon_workflow_run',workflow_name:workflow,task:'{}',conversation_id:seat},[row,{...row,id:'a'.repeat(32)}]);
  assert.equal(out.result.ok,false);
  assert.deepEqual(out.submissions,[]);
});


test('status exposes verified RCOS result content from the exact run only',()=>{
  const home=mkdtempSync(join(tmpdir(),'dsh-status-test-'));
  try {
    const outputRoot=join(home,'.archon/workspaces/test');
    const artifacts=join(outputRoot,'artifacts/runs',runId);
    const invocationId='inv_20260930T182406Z-ade3c6';
    const invocationDir=join(home,'zcode-rcos/invocations',invocationId);
    mkdirSync(artifacts,{recursive:true});mkdirSync(invocationDir,{recursive:true});
    const invocation={schema:'rcos-invocation/1',invocation_id:invocationId,capability_id:'tree-digest-verify',status:'completed',eligibility_decision_id:'elig_20260930T182406Z-8bc3b1',output:{path:'output.json'}};
    writeFileSync(join(artifacts,'rcos-invocation-tree-digest-verify.json'),JSON.stringify(invocation));
    writeFileSync(join(invocationDir,'manifest.json'),JSON.stringify(invocation));
    writeFileSync(join(invocationDir,'output.json'),JSON.stringify({schema:'tree-digest-report/1',results:[{empty_tree:true,files:0}],probes:[]}));
    const out=remote({operation:'archon_run_status',run_id:runId,conversation_id:seat},[{...row,output_root:outputRoot}],home);
    assert.equal(out.result.ok,true);
    assert.equal(out.result.data.rcos_invocations[0].invocation.invocation_id,invocationId);
    assert.equal(out.result.data.rcos_invocations[0].verification.ok,true);
    assert.equal(out.result.data.rcos_invocations[0].eligibility_verification.ok,true);
    assert.equal(out.result.data.rcos_invocations[0].output.results[0].empty_tree,true);
    invocation.output.path=join(home,'outside.json');
    writeFileSync(invocation.output.path,'{"secret":"should never return"}');
    writeFileSync(join(artifacts,'rcos-invocation-tree-digest-verify.json'),JSON.stringify(invocation));
    const escaped=remote({operation:'archon_run_status',run_id:runId,conversation_id:seat},[{...row,output_root:outputRoot}],home);
    assert.equal(escaped.result.data.rcos_invocations[0].output,undefined);
  } finally {rmSync(home,{recursive:true,force:true});}
});


function invoiceStatusFixture(capabilityId='invoice-reconciliation-verify',capabilityVersion='0.4.0') {
  const home=mkdtempSync(join(tmpdir(),'dsh-invoice-domain-'));
  const outputRoot=join(home,'.archon/workspaces/test');
  const artifacts=join(outputRoot,'artifacts/runs',runId);
  const invocationDir=join(home,'zcode-rcos/invocations/inv_domain-control');
  mkdirSync(artifacts,{recursive:true});mkdirSync(invocationDir,{recursive:true});
  writeFileSync(join(artifacts,'EVAL.json'),JSON.stringify({decision:'ship'}));
  const manifest={schema:'rcos-invocation/1',invocation_id:'inv_domain-control',capability_id:capabilityId,capability_version:capabilityVersion,status:'completed',eligibility_decision_id:'elig_domain-control'};
  const write=(output)=>{
    const bytes=Buffer.from(JSON.stringify(output));
    manifest.output={path:'output.json',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    writeFileSync(join(invocationDir,'output.json'),bytes);
    save();
  };
  const save=()=>{
    writeFileSync(join(artifacts,`rcos-invocation-${capabilityId}.json`),JSON.stringify(manifest));
    writeFileSync(join(invocationDir,'manifest.json'),JSON.stringify(manifest));
  };
  const status=(options={})=>remote({operation:'archon_run_status',run_id:runId,conversation_id:seat,child_nodes:[]},[{...row,status:options.parentStatus||'completed',output_root:outputRoot}],home,options).result.data;
  return {home,artifacts,invocationDir,manifest,write,save,status,close:()=>rmSync(home,{recursive:true,force:true})};
}

function visualObservation(capability, state='pass') {
  const unavailable=state==='unavailable', fail=state==='fail';
  const privateFields={name:'PRIVATE_NAME',file:'/PRIVATE_FILE',argv:['PRIVATE_ARGV'],stdout:'PRIVATE_STDOUT',stderr:'PRIVATE_STDERR'};
  if(capability==='filmstrip-verify') {
    const failing=fail?['no-slideshow']:[];
    return {schema:'filmstrip-verify-observation/1',measurer:'capabilities/filmstrip-verify/adapter/run.js',measurer_sha256:'a'.repeat(64),
      thresholds:{frames_default:6,hold_baseline_fps:1,hold_eps:0.004,hold_share_max:0.4,hold_max_s:5,loudness_floor_db:-45,loudness_ceil_db:-6,analysis_width:480,analysis_height:270},
      probes:[{...privateFields,exit_status:unavailable?4:fail?3:0,outcome:unavailable?'could-not-run':fail?'measured-fail':'measured-pass',
        observed:unavailable?null:{duration_s:16,width:480,height:270,fps:24,has_audio:true,frames_requested:6,frames_extracted:6,mean_volume_db:-21.1,max_volume_db:-18.1,hold_share:fail?0.688:0,longest_hold_s:fail?2:0,hold_sample_count:15,analysis_geometry:{width:480,height:270,baseline_fps:1,eps:0.004},failing_legs:failing,pass_marker:fail?'FILMSTRIP_FAIL':'FILMSTRIP_PASS'},
        legs:unavailable?null:Object.fromEntries(['six-frames','audio-bed','no-slideshow'].map(id=>[id,{pass:!failing.includes(id),detail:'PRIVATE_DETAIL'}])),
        strip:unavailable?null:{path:'/PRIVATE_STRIP',argv:['PRIVATE_ARGV'],exit_status:0,frames_requested:6,frames_extracted:6,strip_width:2880,tile_width:480}}]};
  }
  if(capability==='video-forensics-receipt') {
    const failing=fail?['no-dead-frames','no-long-hold']:[];
    const values=[-17,4,0.3,0.4,fail?0.8:0,fail?12:0];
    const bounds=[[-19.9,-14.3],[2.8,6.5],[0.06,0.49],[0.10,0.86],[null,0.4],[null,5]];
    const ids=['loudness-in-band','lra-in-band','luma-in-band','saturation-in-band','no-dead-frames','no-long-hold'];
    const receipt={schema:'video-forensics-receipt/1',register:'explainer',verdict:fail?'FAIL':'PASS',thresholds:{hold_eps:0.004,hold_share_max:0.4,hold_max_s:5},
      checks:ids.map((id,i)=>({id,value:values[i],lo:bounds[i][0],hi:bounds[i][1],pass:!failing.includes(id)}))};
    return {schema:'video-forensics-receipt-observation/1',measurer:{path:'capabilities/video-forensics-receipt/adapter/forensics.py',sha256:'a'.repeat(64),documented_exit_codes:[0,2,3,4]},
      probes:[{...privateFields,register:'explainer',exit_status:unavailable?2:fail?3:0,signal:null,outcome:unavailable?'errored':fail?'caught':'passed',
        observed:{duration_s:24,width:480,height:270,fps:24,has_audio:unavailable?null:true,lufs:unavailable?null:values[0],lra:unavailable?null:values[1],luma:unavailable?null:values[2],saturation:unavailable?null:values[3],hold_share:unavailable?null:values[4],longest_hold_s:unavailable?null:values[5],failing_gates:unavailable?[]:failing,pass_marker:!unavailable&&!fail},
        ...(unavailable?{}:{receipt})}]};
  }
  const md5=Object.fromEntries(Array.from({length:4},(_,i)=>[String(i).padStart(5,'0'),'a'.repeat(32)]));
  return {schema:'webgl-film-capture-observation/1',capturer:{path:'capabilities/webgl-film-capture/adapter/capture.js',sha256:'a'.repeat(64),documented_exit_codes:[0,2,3,4]},
    probes:[{...privateFields,scene:'/PRIVATE_SCENE',out:'/PRIVATE_OUT',exit_status:unavailable?4:0,signal:null,outcome:unavailable?'could_not_capture':'passed',gate_ok:!unavailable&&!fail,
      observed:{width:480,height:270,fps:2,frames:4,duration:2,deterministic:unavailable?null:!fail,frames_compared:unavailable?null:4,frame_mismatches:unavailable?null:fail?1:0},
      ...(unavailable?{}:{manifest:{schema:'webgl-film-capture/1',width:480,height:270,fps:2,frames:4,duration:2,md5},
        cross:{out:'/PRIVATE_CROSS',exit_status:0,signal:null,outcome:'passed',compared:4,mismatches:fail?1:0,mismatch_indices:fail?['00001']:[],field_diffs:[],manifest_sha256:'b'.repeat(64)}})}]};
}
const visualVersions={'filmstrip-verify':'1.0.0','video-forensics-receipt':'0.1.0','webgl-film-capture':'1.0.0'};
for(const [cap,version] of Object.entries(visualVersions)) {
  test(cap+': measured defect and unavailable subject cannot inherit wrapper SHIP',()=>{
    const f=invoiceStatusFixture(cap,version);
    try {
      for(const [state,decision] of [['fail','fix'],['unavailable','blocked'],['pass','ship']]) {
        f.write(visualObservation(cap,state)); const out=f.status();
        assert.equal(out.effective_decision,decision,state);
        assert.equal(out.eval.decision,'ship');
        assert.equal(out.rcos_invocations[0].output.domain_verdict,decision);
        assert.equal(out.rcos_invocations[0].output.probes_total,1);
        assert.equal(JSON.stringify(out).includes('PRIVATE_'),false);
      }
    } finally {f.close();}
  });
  test(cap+': unsupported version, tampering and invalid measurement evidence block acceptance',()=>{
    const f=invoiceStatusFixture(cap,version);
    try {
      for(const verificationFailure of ['invocation-verify','eligibility-verify']) {
        f.write(visualObservation(cap)); assert.equal(f.status({verificationFailure}).effective_decision,'blocked');
      }
      for(const modify of [
        o=>{o.probes=[];}, o=>{o.probes[0].exit_status=true;},
        o=>{o.probes[0].observed={};}, o=>{o.probes[0].outcome='PRIVATE_BAD_OUTCOME';},
        o=>{o.probes[0].observed.width=true;}, o=>{o.probes=Array(17).fill(o.probes[0]);},
        o=>{o.probes[0].exit_status=[];}, o=>{o.probes[0].observed.width=1e300;},
      ]) {
        const o=visualObservation(cap);modify(o);f.write(o);
        assert.equal(f.status().effective_decision,'blocked',JSON.stringify(o));
      }
      f.write(visualObservation(cap));f.manifest.capability_version='9.0.0';f.save();
      assert.equal(f.status().effective_decision,'blocked');
      f.manifest.capability_version=version;f.write(visualObservation(cap));
      writeFileSync(join(f.invocationDir,'output.json'),JSON.stringify(visualObservation(cap,'fail')));
      assert.equal(f.status().effective_decision,'blocked');
      f.write(visualObservation(cap,'fail'));
      assert.equal(f.status({parentStatus:'running'}).effective_decision,'pending');
      writeFileSync(join(f.artifacts,'EVAL.json'),JSON.stringify({decision:'blocked'}));
      assert.equal(f.status().effective_decision,'blocked');
    } finally {f.close();}
  });
}
test('visual projections reject contradictory gates, skipped measurements and empty determinism comparisons',()=>{
  const cases=[
    ['filmstrip-verify',o=>{o.probes[0].legs['no-slideshow'].pass=false;}],
    ['filmstrip-verify',o=>{o.probes[0].observed.frames_extracted=5;}],
    ['filmstrip-verify',o=>{o.thresholds.hold_share_max=1;}],
    ['video-forensics-receipt',o=>{o.probes[0].receipt.checks=[];}],
    ['video-forensics-receipt',o=>{o.probes[0].register=[];}],
    ['video-forensics-receipt',o=>{o.probes[0].receipt.checks[0].pass=null;o.probes[0].receipt.checks[0].value=null;o.probes[0].observed.lufs=null;}],
    ['video-forensics-receipt',o=>{o.probes[0].receipt.checks[0].value=-50;o.probes[0].observed.lufs=-50;}],
    ['webgl-film-capture',o=>{o.probes[0].observed.deterministic=null;delete o.probes[0].cross;}],
    ['webgl-film-capture',o=>{o.probes[0].observed.frames_compared=0;o.probes[0].cross.compared=0;o.probes[0].manifest.md5={};}],
    ['webgl-film-capture',o=>{o.probes[0].cross.field_diffs=['PRIVATE_DIFF'];}],
    ['webgl-film-capture',o=>{o.probes[0].manifest.md5['00001']='not-a-hash';}],
  ];
  for(const [cap,modify] of cases) {
    const f=invoiceStatusFixture(cap,visualVersions[cap]);
    try {const o=visualObservation(cap);modify(o);f.write(o);const out=f.status();assert.equal(out.effective_decision,'blocked',cap);assert.equal(JSON.stringify(out).includes('PRIVATE_'),false);}
    finally {f.close();}
  }
});

test('visual batch acceptance requires every probe to pass, with unavailable evidence taking precedence over a defect',()=>{
  for(const [cap,version] of Object.entries(visualVersions)) {
    const f=invoiceStatusFixture(cap,version);
    try {
      const output=visualObservation(cap);
      output.probes.push(visualObservation(cap,'fail').probes[0]);f.write(output);
      assert.equal(f.status().effective_decision,'fix');
      output.probes.push(visualObservation(cap,'unavailable').probes[0]);f.write(output);
      const out=f.status();assert.equal(out.effective_decision,'blocked');
      assert.equal(out.rcos_invocations[0].output.probes_passed,1);
      assert.equal(out.rcos_invocations[0].output.probes_failed,1);
      assert.equal(out.rcos_invocations[0].output.probes_unavailable,1);
    } finally {f.close();}
  }
});

test('capture manifest field differences use the actual bounded adapter comparison format',()=>{
  const f=invoiceStatusFixture('webgl-film-capture','1.0.0');
  try {
    const o=visualObservation('webgl-film-capture');
    o.probes[0].gate_ok=false;
    o.probes[0].cross.field_diffs=['width: 480 != 481'];
    f.write(o);
    const out=f.status();
    assert.equal(out.effective_decision,'fix');
    assert.deepEqual(out.rcos_invocations[0].output.failed_ids,['cross-launch-manifest-fields']);
    for(const diff of ['width: 480 != 480','width: 479 != 481','width: 480 != PRIVATE_VALUE','width: 480 != Infinity','width: 480 != -1','width: 480 != 1e300','width','unknown: 480 != 481']) {
      o.probes[0].cross.field_diffs=[diff];f.write(o);
      const invalid=f.status();assert.equal(invalid.effective_decision,'blocked',diff);
      assert.equal(JSON.stringify(invalid).includes('PRIVATE_'),false);
    }
  } finally {f.close();}
});

test('capture acceptance requires successful second-process evidence and never infers it from matching hashes',()=>{
  const f=invoiceStatusFixture('webgl-film-capture','1.0.0');
  try {
    const legacy=visualObservation('webgl-film-capture');
    delete legacy.probes[0].cross.exit_status;delete legacy.probes[0].cross.signal;delete legacy.probes[0].cross.outcome;
    f.write(legacy);assert.equal(f.status().effective_decision,'blocked','legacy receipt lacks second process proof');
    for(const [code,signal,outcome,decision] of [[0,null,'passed','ship'],[3,null,'caught','fix'],[4,null,'could_not_capture','blocked'],[2,null,'errored','blocked'],[null,'SIGTERM','timed_out','blocked']]) {
      const o=visualObservation('webgl-film-capture');
      Object.assign(o.probes[0].cross,{exit_status:code,signal,outcome});
      if(code!==0) {
        o.probes[0].gate_ok=false;o.probes[0].observed.deterministic=null;
        o.probes[0].observed.frames_compared=null;o.probes[0].observed.frame_mismatches=null;
        Object.assign(o.probes[0].cross,{compared:0,mismatches:0,mismatch_indices:[],manifest_sha256:null});
      }
      f.write(o);assert.equal(f.status().effective_decision,decision,outcome);
      if(code===3) assert.deepEqual(f.status().rcos_invocations[0].output.failed_ids,['cross-launch-capture-gate']);
    }
    for(const modify of [c=>{c.exit_status=true;},c=>{c.signal='PRIVATE_SIGNAL';},c=>{c.outcome='PRIVATE_OUTCOME';},c=>{c.exit_status=3;c.outcome='caught';}]) {
      const o=visualObservation('webgl-film-capture');Object.assign(o.probes[0].cross,{exit_status:0,signal:null,outcome:'passed'});modify(o.probes[0].cross);
      f.write(o);const out=f.status();assert.equal(out.effective_decision,'blocked');assert.equal(JSON.stringify(out).includes('PRIVATE_'),false);
    }
  } finally {f.close();}
});

test('visual defects after the first two invocation receipts remain visible, and receipt overflow blocks acceptance',()=>{
  const f=invoiceStatusFixture('filmstrip-verify','1.0.0');
  const add=(index)=>{
    const cap='aa-control-'+index, id='inv_control-'+index;
    const dir=join(f.home,'zcode-rcos/invocations',id);
    mkdirSync(dir,{recursive:true});
    const receipt={schema:'rcos-invocation/1',invocation_id:id,capability_id:cap,capability_version:'1.0.0',status:'completed',eligibility_decision_id:'elig_domain-control'};
    writeFileSync(join(dir,'manifest.json'),JSON.stringify(receipt));
    writeFileSync(join(f.artifacts,'rcos-invocation-'+cap+'.json'),JSON.stringify(receipt));
  };
  try {
    f.write(visualObservation('filmstrip-verify','fail'));add(0);add(1);
    const out=f.status();assert.equal(out.effective_decision,'fix');assert.equal(out.rcos_invocations.length,3);
    f.write(visualObservation('filmstrip-verify'));for(let i=2;i<8;i++)add(i);
    const overflow=f.status();assert.equal(overflow.effective_decision,'blocked');assert.match(overflow.acceptance_blockers.join(' '),/invocation.*limit/i);
  } finally {f.close();}
});

function researchObservation(cited=true) {
  return {schema:'bounded-research-observation/1',query:'research',
    passages:cited?[{url:'https://example.com/page',host:'example.com',scheme:'https',status:200,bytes:20,sha256:'a'.repeat(64),fetchedAt:'2026-10-03T20:00:00Z',excerpt:'PRIVATE_SOURCE_BODY research',termHit:true}]:[],
    refused:cited?[]:[{url:'https://example.com/PRIVATE_PATH',reason:'off-allowlist'}]};
}

test('bounded research with no cited passages cannot inherit workflow SHIP',()=>{
  const f=invoiceStatusFixture('bounded-research','0.1.1');
  try {
    for(const cited of [true,false]) {
      f.write(researchObservation(cited));
      const out=f.status();
      assert.equal(out.effective_decision,cited?'ship':'blocked');
      assert.deepEqual(out.rcos_invocations[0].output,{schema:'bounded-research-observation/1',scope:'cited-fetch',domain_verdict:cited?'ship':'blocked',passages:cited?1:0,refused:cited?0:1,term_hits:cited?1:0,refusal_reasons:cited?[]:['off-allowlist']});
      assert.equal(JSON.stringify(out).includes('PRIVATE_'),false);
    }
  } finally {f.close();}
});

test('bounded research refuses unsupported, malformed or tampered observations',()=>{
  const f=invoiceStatusFixture('bounded-research','0.1.1');
  try {
    const valid=researchObservation();
    for(const output of [{...valid,schema:'other/1'}, {...valid,passages:[{...valid.passages[0],bytes:0}]}, {...valid,passages:[{...valid.passages[0],sha256:'bad'}]}, {...valid,passages:[{...valid.passages[0],host:'other.com'}]}, {...valid,refused:[{url:'https://example.com',reason:'PRIVATE_ARBITRARY_REASON'}]}, {...valid,passages:Array(6).fill(valid.passages[0])}]) {
      f.write(output);
      const out=f.status();
      assert.equal(out.effective_decision,'blocked');
      assert.equal(out.rcos_invocations[0].output,undefined);
    }
    f.write(valid);f.manifest.capability_version='0.1.0';f.save();
    assert.equal(f.status().effective_decision,'blocked');
    f.manifest.capability_version='0.1.1';f.write(valid);
    writeFileSync(join(f.invocationDir,'output.json'),JSON.stringify(researchObservation(false)));
    assert.equal(f.status().effective_decision,'blocked');
    f.write(valid);
    assert.equal(f.status({verificationFailure:'eligibility-verify'}).effective_decision,'blocked');
  } finally {f.close();}
});

test('invoice domain FIX/BLOCKED overrides workflow SHIP while the passing control stays SHIP',()=>{
  const f=invoiceStatusFixture();
  try {
    for(const [domain_verdict,engine_exit] of [['ship',0],['fix',1],['blocked',2]]) {
      f.write({schema:'invoice-reconciliation-report/1',domain_verdict,engine_exit,report:{verdict:domain_verdict.toUpperCase(),stats:{matched:1,conflicts:0}}});
      const out=f.status();
      assert.equal(out.effective_decision,domain_verdict);
      assert.equal(out.eval.decision,'ship','retain the independent workflow evidence');
      assert.equal(out.rcos_invocations[0].output.domain_verdict,domain_verdict);
      assert.deepEqual(out.rcos_invocations[0].output.stats,{matched:1,conflicts:0});
      assert.equal(out.acceptance_blockers.length,domain_verdict==='ship'?0:1);
    }
  } finally {f.close();}
});

test('invoice status projects only the known verdict and numeric counts, never invoice values or refusal reasons',()=>{
  const f=invoiceStatusFixture();
  try {
    f.write({schema:'invoice-reconciliation-report/1',domain_verdict:'blocked',engine_exit:2,report:{verdict:'BLOCKED',reason:'PRIVATE_INVOICE_REASON',matched:['PRIVATE_INVOICE_ID'],stats:{matched:3,conflicts:true,missing:-1,total_a:'PRIVATE_AMOUNT',duplicates:['PRIVATE_DUPLICATE'],unreconcilable:2}}});
    const out=f.status();
    assert.deepEqual(out.rcos_invocations[0].output,{schema:'invoice-reconciliation-report/1',domain_verdict:'blocked',engine_exit:2,stats:{matched:3,unreconcilable:2}});
    assert.equal(JSON.stringify(out).includes('PRIVATE_'),false);
  } finally {f.close();}
});

test('invoice status refuses malformed or inconsistent domain outcomes and unsafe output paths',()=>{
  const f=invoiceStatusFixture();
  try {
    const valid={schema:'invoice-reconciliation-report/1',domain_verdict:'ship',engine_exit:0,report:{}};
    for(const output of [{...valid,schema:'arbitrary-report/1'},{...valid,domain_verdict:'SHIP'},{...valid,engine_exit:2},{...valid,engine_exit:false},{...valid,report:[]},{...valid,report:null}]) {
      f.write(output);
      const out=f.status();
      assert.equal(out.effective_decision,'blocked',JSON.stringify(output));
      assert.equal(out.rcos_invocations[0].output,undefined);
      assert.ok(out.acceptance_blockers.length>0);
    }
    f.write(valid);
    f.manifest.output.path='../outside.json';f.save();
    const out=f.status();
    assert.equal(out.effective_decision,'blocked');
    assert.equal(out.rcos_invocations[0].output,undefined);
  } finally {f.close();}
});

test('invoice status requires canonical receipt, invocation and eligibility verification, completed status and matching output bytes',()=>{
  const f=invoiceStatusFixture();
  try {
    const valid={schema:'invoice-reconciliation-report/1',domain_verdict:'ship',engine_exit:0,report:{}};
    for(const verificationFailure of ['invocation-verify','eligibility-verify']) {
      f.write(valid);
      const out=f.status({verificationFailure});
      assert.equal(out.effective_decision,'blocked',verificationFailure);
      assert.equal(out.rcos_invocations[0].output,undefined);
    }
    for(const mutate of [
      ()=>{f.manifest.status='failed';f.save();},
      ()=>{delete f.manifest.eligibility_decision_id;f.save();},
      ()=>{writeFileSync(join(f.invocationDir,'output.json'),JSON.stringify({...valid,domain_verdict:'blocked',engine_exit:2}));},
      ()=>{f.manifest.output.sha256='0'.repeat(64);f.save();},
      ()=>{f.manifest.output.bytes+=1;f.save();},
      ()=>{writeFileSync(join(f.artifacts,'rcos-invocation-invoice-reconciliation-verify.json'),'{}');},
    ]) {
      f.manifest.status='completed';f.manifest.eligibility_decision_id='elig_domain-control';f.write(valid);mutate();
      const out=f.status();
      assert.equal(out.effective_decision,'blocked');
      assert.equal(out.rcos_invocations[0].output,undefined);
    }
  } finally {f.close();}
});

// These are the frozen v1.0.0 renderer's checks, read from run.py and the
// independently executed PASS/defect observations on the Dell.
const filmCheckIds=['grid-pin','shots-json','shot-count','frame-size','gate-timeline','bar-grid','valley-locked','law0-nondet','law3-keys','no-lyric-use','out-guard','shotmap-types','bone-budget','nearblack-floor','accent-gate','signal-budget','hole-locked','stills-size','contact-sheet','clips-60f','clips-decode'];
function filmObservation(verdict='PASS') {
  const failed_ids=verdict==='FAIL'?['nearblack-floor','accent-gate']:verdict==='VACUOUS'?['grid-pin']:[];
  const checks=(verdict==='VACUOUS'?['grid-pin']:filmCheckIds).map(id=>({id,status:failed_ids.includes(id)?'fail':'pass',measured:'PRIVATE_MEASUREMENT',threshold:'PRIVATE_THRESHOLD'}));
  return {verdict,run_exit:{PASS:0,FAIL:1,VACUOUS:2}[verdict],failed_ids,checks,
    checks_total:verdict==='VACUOUS'?null:checks.length,checks_failed:verdict==='VACUOUS'?null:failed_ids.length,
    gate:verdict==='VACUOUS'?null:{exit:0},grid_sha256:(verdict==='VACUOUS'?'00000000':'33a9fec2')+'a'.repeat(56),
    inputs:{board:'/PRIVATE_BOARD'},argv:['PRIVATE_ARGV'],run_stdout_tail:'PRIVATE_STDOUT',run_stderr_tail:'PRIVATE_STDERR'};
}
test('film FAIL/VACUOUS overrides wrapper SHIP while the verified PASS control stays SHIP',()=>{
  const f=invoiceStatusFixture('wishing-film-run','1.0.0');
  try {
    for(const [verdict,domain] of [['FAIL','fix'],['VACUOUS','blocked'],['PASS','ship']]) {
      f.write(filmObservation(verdict));
      const out=f.status();
      assert.equal(out.effective_decision,domain,verdict);
      assert.equal(out.eval.decision,'ship','retain the independent wrapper decision');
      assert.equal(out.rcos_invocations[0].output.domain_verdict,domain);
      assert.equal(out.rcos_invocations[0].output.verdict,verdict);
      assert.equal(out.acceptance_blockers.length,domain==='ship'?0:1);
    }
  } finally {f.close();}
});
test('film status projects only verdict, counts and bounded check IDs without artifact bodies or paths',()=>{
  const f=invoiceStatusFixture('wishing-film-run','1.0.0');
  try {
    f.write(filmObservation('FAIL'));
    const out=f.status();
    assert.deepEqual(out.rcos_invocations[0].output,{verdict:'FAIL',domain_verdict:'fix',run_exit:1,checks_total:21,checks_failed:2,failed_ids:['nearblack-floor','accent-gate'],gate_exit:0});
    assert.equal(JSON.stringify(out).includes('PRIVATE_'),false);
  } finally {f.close();}
});
test('film status blocks inconsistent, incomplete or malformed known-contract results',()=>{
  const f=invoiceStatusFixture('wishing-film-run','1.0.0');
  try {
    const valid=filmObservation();
    for(const output of [
      {...valid,verdict:'ship'}, {...valid,run_exit:2}, {...valid,run_exit:false},
      {...valid,checks:[]}, {...valid,checks:valid.checks.slice(1),checks_total:20},
      {...valid,checks:[valid.checks[0],...valid.checks.slice(0,-1)]},
      {...valid,checks:[{...valid.checks[0],id:[]},...valid.checks.slice(1)]},
      {...valid,failed_ids:['accent-gate']}, {...valid,checks_total:22}, {...valid,checks_failed:true},
      {...valid,gate:{exit:1}}, {...valid,grid_sha256:'0'.repeat(64)},
      {...filmObservation('FAIL'),failed_ids:[]},
      {...filmObservation('VACUOUS'),failed_ids:['PRIVATE_UNSAFE_ID']},
    ]) {
      f.write(output);
      const out=f.status();
      assert.equal(out.effective_decision,'blocked',JSON.stringify(output));
      assert.equal(out.rcos_invocations[0].output,undefined);
      assert.match(out.acceptance_blockers.join(' '),/wishing-film-run.*verified domain outcome.*unavailable/);
    }
  } finally {f.close();}
});
test('film status requires the supported capability version, canonical manifest, verification and exact output bytes',()=>{
  const f=invoiceStatusFixture('wishing-film-run','1.0.0');
  try {
    for(const verificationFailure of ['invocation-verify','eligibility-verify']) {
      f.write(filmObservation());
      const out=f.status({verificationFailure});
      assert.equal(out.effective_decision,'blocked');
      assert.equal(out.rcos_invocations[0].output,undefined);
    }
    for(const mutate of [
      ()=>{f.manifest.capability_version='2.0.0';f.save();},
      ()=>{f.manifest.status='failed';f.save();},
      ()=>{delete f.manifest.eligibility_decision_id;f.save();},
      ()=>{writeFileSync(join(f.invocationDir,'output.json'),JSON.stringify(filmObservation('FAIL')));},
      ()=>{f.manifest.output.sha256='0'.repeat(64);f.save();},
      ()=>{f.manifest.output.bytes+=1;f.save();},
      ()=>{f.manifest.output.path='../outside.json';f.save();},
      ()=>{writeFileSync(join(f.artifacts,'rcos-invocation-wishing-film-run.json'),'{}');},
    ]) {
      f.manifest.capability_version='1.0.0';f.manifest.status='completed';f.manifest.eligibility_decision_id='elig_domain-control';f.write(filmObservation());mutate();
      const out=f.status();
      assert.equal(out.effective_decision,'blocked');
      assert.equal(out.rcos_invocations[0].output,undefined);
    }
  } finally {f.close();}
});
test('film outcome never upgrades parent FIX/BLOCKED and active runs remain PENDING',()=>{
  const f=invoiceStatusFixture('wishing-film-run','1.0.0');
  try {
    f.write(filmObservation());
    for(const decision of ['fix','blocked']) {
      writeFileSync(join(f.artifacts,'EVAL.json'),JSON.stringify({decision}));
      assert.equal(f.status().effective_decision,decision);
    }
    f.write(filmObservation('FAIL'));
    for(const parentStatus of ['running','queued','pending']) {
      const out=f.status({parentStatus});
      assert.equal(out.effective_decision,'pending');
      assert.deepEqual(out.acceptance_blockers,[]);
    }
    assert.equal(f.status({parentStatus:'failed'}).effective_decision,'blocked');
  } finally {f.close();}
});

test('lookup-only recovery never submits when no matching run exists',()=>{
  const out=remote({operation:'archon_workflow_run',workflow_name:workflow,task:'{}',conversation_id:seat,lookup_only:true},[]);
  assert.equal(out.result.ok,false);
  assert.deepEqual(out.submissions,[]);
});


test('out-of-workspace artifact root never exposes artifacts',()=>{
  const home=mkdtempSync(join(tmpdir(),'dsh-status-boundary-'));
  try {
    const root=join(home,'untrusted');
    mkdirSync(join(root,'artifacts/runs',runId),{recursive:true});
    writeFileSync(join(root,'artifacts/runs',runId,'EVAL.json'),'{"decision":"ship"}');
    const out=remote({operation:'archon_run_status',run_id:runId,conversation_id:seat},[{...row,output_root:root}],home);
    assert.equal(out.result.data.artifact_dir,undefined);
    assert.equal(out.result.data.eval,undefined);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('status marks completed child QA with blocked EVAL as an acceptance blocker',()=>{
  const home=mkdtempSync(join(tmpdir(),'dsh-child-eval-'));
  try {
    const parentRoot=join(home,'.archon/workspaces/parent');
    const parentArtifacts=join(parentRoot,'artifacts/runs',runId);
    const childId='6fe38448054f4cf48f937b28769ac211';
    const childRoot=join(home,'.archon/workspaces/child');
    const childArtifacts=join(childRoot,'artifacts/runs',childId);
    mkdirSync(parentArtifacts,{recursive:true});mkdirSync(childArtifacts,{recursive:true});
    writeFileSync(join(parentArtifacts,'EVAL.json'),JSON.stringify({decision:'ship',reason:'parent nodes completed'}));
    const evalValue={decision:'blocked',status:'blocked',reason:'no claimed paths extracted from task',check_type:'deterministic'};
    const expectedCwd='/var/tmp/chow-nested-runs/fixture-parent-qa-12345678';
    const rawEvalPath=join(childArtifacts,'EVAL.json');
    writeFileSync(rawEvalPath,JSON.stringify(evalValue));
    writeFileSync(join(childArtifacts,'RESEARCH_BRIEF.md'),'private content must not enter the status projection');
    const evalPath=realpathSync(rawEvalPath);
    writeFileSync(join(parentArtifacts,'archon-child-qa.json'),JSON.stringify({schema:'rcos-archon-child/1',run_id:childId,workflow_name:qaWorkflow,expected_cwd:expectedCwd,status:'completed',output_root:childRoot,eval_path:evalPath,eval:evalValue}));
    const child={id:childId,conversation_id:'internal-child',workflow_name:qaWorkflow,status:'completed',working_path:expectedCwd,output_root:childRoot};
    const parent={...row,status:'completed',output_root:parentRoot};
    const out=remote({operation:'archon_run_status',run_id:runId,conversation_id:seat,child_nodes:[{id:'qa',workflow:qaWorkflow}],workflow_allowlist:[workflow,qaWorkflow]},[parent,child],home);
    assert.equal(out.result.ok,true);
    assert.equal(out.result.data.child_evaluations[0].run_id,childId);
    assert.equal(out.result.data.child_evaluations[0].status,'completed');
    assert.equal(out.result.data.child_evaluations[0].artifact_dir,realpathSync(childArtifacts));
    assert.deepEqual(out.result.data.child_evaluations[0].artifact_names,['EVAL.json','RESEARCH_BRIEF.md']);
    assert.ok(!JSON.stringify(out.result.data).includes('private content'));
    assert.equal(out.result.data.child_evaluations[0].eval?.decision,'blocked',JSON.stringify(out.result.data));
    assert.equal(out.result.data.acceptance_blockers.length,1);
    assert.equal(out.result.data.effective_decision,'blocked');
    assert.equal(out.result.data.eval.decision,'ship','preserve the parent EVAL as raw evidence while gating effective decision');
    const shipEval={decision:'ship',reason:'All 1 claimed paths exist'};
    writeFileSync(rawEvalPath,JSON.stringify(shipEval));
    const receiptPath=join(parentArtifacts,'archon-child-qa.json');
    const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));receipt.eval=shipEval;
    writeFileSync(receiptPath,JSON.stringify(receipt));
    const accepted=remote({operation:'archon_run_status',run_id:runId,conversation_id:seat,child_nodes:[{id:'qa',workflow:qaWorkflow}],workflow_allowlist:[workflow,qaWorkflow]},[{...parent,status:'completed'},child],home);
    assert.deepEqual(accepted.result.data.acceptance_blockers,[]);
    assert.equal(accepted.result.data.effective_decision,'ship');
    assert.equal(accepted.result.data.child_evaluations[0].working_path,expectedCwd);
    assert.deepEqual(accepted.result.data.child_evaluations[0].eval,shipEval);
    // Approved build workflows write uppercase SHIP. Preserve the raw evidence.
    const upperEval={decision:'SHIP',reason:'Build checks passed'};
    writeFileSync(rawEvalPath,JSON.stringify(upperEval));
    receipt.eval=upperEval;
    writeFileSync(receiptPath,JSON.stringify(receipt));
    const uppercase=remote({operation:'archon_run_status',run_id:runId,conversation_id:seat,child_nodes:[{id:'qa',workflow:qaWorkflow}],workflow_allowlist:[workflow,qaWorkflow]},[{...parent,status:'completed'},child],home);
    assert.deepEqual(uppercase.result.data.acceptance_blockers,[]);
    assert.equal(uppercase.result.data.effective_decision,'ship');
    assert.deepEqual(uppercase.result.data.child_evaluations[0].eval,upperEval);
    for(const decision of ['FIX','BLOCK','completed',true,1]) {
      const rejectedEval={decision};
      writeFileSync(rawEvalPath,JSON.stringify(rejectedEval));
      receipt.eval=rejectedEval;
      writeFileSync(receiptPath,JSON.stringify(receipt));
      const rejected=remote({operation:'archon_run_status',run_id:runId,conversation_id:seat,child_nodes:[{id:'qa',workflow:qaWorkflow}],workflow_allowlist:[workflow,qaWorkflow]},[{...parent,status:'completed'},child],home);
      assert.equal(rejected.result.data.effective_decision,'blocked');
      assert.ok(rejected.result.data.acceptance_blockers.length>0);
    }
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('status reports child run unresolved when the compiler-generated receipt is missing',()=>{
  const home=mkdtempSync(join(tmpdir(),'dsh-child-eval-unresolved-'));
  try {
    const parentRoot=join(home,'.archon/workspaces/parent');
    const parentArtifacts=join(parentRoot,'artifacts/runs',runId);
    mkdirSync(parentArtifacts,{recursive:true});
    const out=remote({operation:'archon_run_status',run_id:runId,conversation_id:seat,child_nodes:[{id:'qa',workflow:qaWorkflow}],workflow_allowlist:[workflow,qaWorkflow]},[{...row,status:'completed',output_root:parentRoot}],home);
    assert.equal(out.result.data.child_evaluations[0].status,'unresolved');
    assert.equal(out.result.data.acceptance_blockers.length,1);
    assert.equal(out.result.data.effective_decision,'blocked');
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('running parent reports missing child receipt as pending, not an acceptance failure',()=>{
  const home=mkdtempSync(join(tmpdir(),'dsh-child-eval-pending-'));
  try {
    const parentRoot=join(home,'.archon/workspaces/parent');
    mkdirSync(join(parentRoot,'artifacts/runs',runId),{recursive:true});
    const out=remote({operation:'archon_run_status',run_id:runId,conversation_id:seat,child_nodes:[{id:'qa',workflow:qaWorkflow}],workflow_allowlist:[workflow,qaWorkflow]},[{...row,status:'running',output_root:parentRoot}],home);
    assert.equal(out.result.data.status,'running');
    assert.equal(out.result.data.child_evaluations[0].status,'unresolved');
    assert.equal(out.result.data.effective_decision,'pending');
    assert.deepEqual(out.result.data.acceptance_blockers,[]);
    assert.match(out.result.data.pending_checks[0],/child receipt is missing/);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('Desktop compiled wrapper is installed additively into the fixed trusted source and run uses fixed Go Muse arguments',()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'dsh-ready-profile-')));
  const source=join(home,'.archon','rcos-desktop','source');
  try {
    mkdirSync(join(source,'.archon','workflows'),{recursive:true});
    writeFileSync(join(home,'.archon','rcos-desktop','config.yaml'),'fixture: config\n');
    const snapshot='.archon/workflows/chow-qa-verify-v1.yaml';
    const yaml='name: chow-qa-verify-v1\nprovider: pi\nmodel: opencode-go-responses/muse-spark-1.3-contributor\neffort: xhigh\n';
    writeFileSync(join(source,snapshot),yaml);
    const digest=value=>createHash('sha256').update(value).digest('hex');
    writeFileSync(join(home,'.archon','rcos-desktop','profile-manifest.json'),JSON.stringify({schema:'rcos-desktop-profile/1',model:'pi/opencode-go-responses/muse-spark-1.3-contributor',effort:'xhigh',files:{[snapshot]:digest(yaml)},config_sha256:digest('fixture: config\n')}));
    writeFileSync(join(home,'.archon','rcos-desktop','approved-source-manifest.json'),'[]\n');
    const compiled=remote({operation:'rcos_compile_ir',name:'trusted-copy',ir:qaIr('Verify /tmp/README.md'),workflow_allowlist:[qaWorkflow],desktop_run_profile:true},[],home);
    assert.equal(compiled.result.ok,true,JSON.stringify(compiled.result));
    assert.equal(compiled.admissions.length,3);
    assert.match(compiled.admissions[0][1],/verify-desktop-manifests\.py$/);
    assert.deepEqual(compiled.admissions[1].slice(-3),['--admit-compiled','rcos-ir-trusted-copy','--write']);
    assert.match(compiled.admissions[2][1],/verify-desktop-manifests\.py$/);
    assert.equal(readFileSync(join(source,'.archon','workflows','rcos-ir-trusted-copy.yaml'),'utf8'),'name: fixture-compiled-wrapper\n');
    const out=remote({operation:'archon_workflow_run',workflow_name:workflow,task:'{}',conversation_id:seat,desktop_run_profile:true,workflow_source:'/tmp/model-override'},[],home);
    assert.equal(out.submissions.length,1);
    const argv=out.submissions[0];
    assert.equal(argv[argv.indexOf('--workflow-source')+1],source);
    assert.equal(argv[argv.indexOf('--config')+1],join(home,'.archon','rcos-desktop','config.yaml'));
    assert.equal(argv.includes('--model'),false);
    assert.equal(argv.includes('/tmp/model-override'),false);
    writeFileSync(join(source,snapshot),yaml+'# unexpected mutation\n');
    const tampered=remote({operation:'archon_workflow_run',workflow_name:workflow,task:'{}',conversation_id:seat,desktop_run_profile:true},[],home);
    assert.equal(tampered.result.ok,false);
    assert.equal(tampered.submissions.length,0);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('failed Desktop manifest admission removes the unregistered snapshot wrapper',()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'dsh-manifest-rollback-')));
  const desktop=join(home,'.archon','rcos-desktop');
  const source=join(desktop,'source');
  try {
    mkdirSync(join(source,'.archon','workflows'),{recursive:true});
    writeFileSync(join(desktop,'config.yaml'),'fixture: config\n');
    const key='.archon/workflows/chow-qa-verify-v1.yaml';
    const yaml='name: chow-qa-verify-v1\n';
    writeFileSync(join(source,key),yaml);
    const digest=value=>createHash('sha256').update(value).digest('hex');
    const manifest=JSON.stringify({schema:'rcos-desktop-profile/1',model:'pi/opencode-go-responses/muse-spark-1.3-contributor',effort:'xhigh',files:{[key]:digest(yaml)},config_sha256:digest('fixture: config\n')});
    writeFileSync(join(desktop,'profile-manifest.json'),manifest);
    writeFileSync(join(desktop,'approved-source-manifest.json'),'[]\n');
    const out=remote({operation:'rcos_compile_ir',name:'rollback-check',ir:qaIr('Verify /tmp/README.md'),workflow_allowlist:[qaWorkflow],desktop_run_profile:true},[],home,{admissionFailure:true});
    assert.equal(out.result.ok,false);
    assert.match(out.result.detail,/could not be installed/);
    assert.equal(out.compiles.length,1);
    assert.equal(out.admissions.length,2);
    assert.equal(existsSync(join(source,'.archon','workflows','rcos-ir-rollback-check.yaml')),false);
    assert.equal(readFileSync(join(desktop,'profile-manifest.json'),'utf8'),manifest);
    assert.equal(readFileSync(join(desktop,'approved-source-manifest.json'),'utf8'),'[]\n');
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('Desktop wrapper arriving during compilation is preserved',()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'dsh-manifest-duplicate-')));
  const desktop=join(home,'.archon','rcos-desktop');
  const source=join(desktop,'source');
  try {
    mkdirSync(join(source,'.archon','workflows'),{recursive:true});
    writeFileSync(join(desktop,'config.yaml'),'fixture: config\n');
    const pinnedKey='.archon/workflows/chow-qa-verify-v1.yaml';
    const compiledKey='.archon/workflows/rcos-ir-existing-copy.yaml';
    const pinned='name: chow-qa-verify-v1\n';
    const existing='name: race-created-wrapper\n';
    writeFileSync(join(source,pinnedKey),pinned);
    const digest=value=>createHash('sha256').update(value).digest('hex');
    const manifest=JSON.stringify({schema:'rcos-desktop-profile/1',model:'pi/opencode-go-responses/muse-spark-1.3-contributor',effort:'xhigh',files:{[pinnedKey]:digest(pinned)},config_sha256:digest('fixture: config\n')});
    writeFileSync(join(desktop,'profile-manifest.json'),manifest);
    writeFileSync(join(desktop,'approved-source-manifest.json'),'[]\n');
    const out=remote({operation:'rcos_compile_ir',name:'existing-copy',ir:qaIr('Verify /tmp/README.md'),workflow_allowlist:[qaWorkflow],desktop_run_profile:true},[],home,{raceSnapshotWrapper:true});
    assert.equal(out.result.ok,false);
    assert.match(out.result.detail,/could not be installed/);
    assert.equal(readFileSync(join(source,compiledKey),'utf8'),existing);
    assert.equal(readFileSync(join(desktop,'profile-manifest.json'),'utf8'),manifest);
    assert.equal(readFileSync(join(desktop,'approved-source-manifest.json'),'utf8'),'[]\n');
  } finally {rmSync(home,{recursive:true,force:true});}
});

// mac-dell-staging v0.1.0: the adapter always exits 0 and carries the DOMAIN
// verdict inside the report, so only resolving the frozen report body (pinned
// by the run's output digest) can establish acceptance. Shapes below are the
// exact (action, status) reports observed on the Dell.
function mdsReport(action,status,detail,stagingId='pc6') {
  return {schema:'mac-dell-staging-report/1',action,staging_id:stagingId,status,detail};
}
const mdsValid={
  'stage/ship':mdsReport('stage','ship',{staged:'/home/chow/.archon/staging/dbg-1/content.bin',sha256:'9'.repeat(64),bytes:3,executed:false},'dbg-1'),
  'stage/fix':mdsReport('stage','fix',{reason:'sha256 mismatch',expected:'0'.repeat(64),actual:'a'.repeat(64),bytes:46},'badhash'),
  'stage/blocked':mdsReport('stage','blocked',{reason:'content exceeds 8 MiB',bytes:8388609},'oversize'),
  'publish/ship':mdsReport('publish','ship',{published:'test-fixtures/pc6.bin',sha256:'4'.repeat(64),manifest_admitted:false,lane:null,verified:true}),
  'publish/blocked':mdsReport('publish','blocked',{reason:'publication failed and was rolled back',error:'manifest admission failed: admit-compiled: lane is absent or already approved: pc6\n',rolled_back:true}),
  'rollback/ship':mdsReport('rollback','ship',{rolled_back:'test-fixtures/pc6.bin',staged_copy_retained:'/home/chow/.archon/staging/pc6/content.bin'}),
  'rollback/blocked':mdsReport('rollback','blocked',{reason:'no publish record to roll back',staging_id:'pc6'}),
};
test('mac-dell-staging: every action/status report carries its real domain verdict, never wrapper ship',()=>{
  const f=invoiceStatusFixture('mac-dell-staging','0.1.0');
  try {
    for(const [key,report] of Object.entries(mdsValid)) {
      f.write(report); const out=f.status();
      const expected=report.status;
      assert.equal(out.effective_decision,expected,key);
      assert.equal(out.rcos_invocations[0].output.domain_verdict,expected,key);
      assert.equal(out.rcos_invocations[0].output.action,report.action,key);
      assert.equal(out.acceptance_blockers.length,expected==='ship'?0:1,key);
      assert.equal(JSON.stringify(out).includes('/home/chow'),false,key);
    }
  } finally {f.close();}
});
test('mac-dell-staging: malformed, inconsistent or tampered reports block acceptance',()=>{
  const f=invoiceStatusFixture('mac-dell-staging','0.1.0');
  try {
    for(const verificationFailure of ['invocation-verify','eligibility-verify']) {
      f.write(mdsValid['stage/ship']); assert.equal(f.status({verificationFailure}).effective_decision,'blocked');
    }
    const mutations=[
      o=>{o.schema='other/1';}, o=>{o.action='nuke';}, o=>{o.status='maybe';}, o=>{o.extra=1;},
      o=>{o.staging_id='BAD ID';}, o=>{o.detail=[];}, o=>{o.detail.secret='PRIVATE';},
      o=>{o.detail.executed=true;}, o=>{o.detail.bytes=0;}, o=>{o.detail.sha256='xyz';},
    ];
    for(const mutate of mutations) {
      const o=structuredClone(mdsValid['stage/ship']); mutate(o); f.write(o);
      assert.equal(f.status().effective_decision,'blocked',JSON.stringify(o).slice(0,80));
      assert.equal(f.status().rcos_invocations[0].output,undefined);
    }
    const badFix=structuredClone(mdsValid['stage/fix']); badFix.detail.reason='nope'; f.write(badFix);
    assert.equal(f.status().effective_decision,'blocked');
    const admitted=structuredClone(mdsValid['publish/ship']); admitted.detail.manifest_admitted=true; f.write(admitted);
    assert.equal(f.status().effective_decision,'blocked');
    const escape=structuredClone(mdsValid['publish/ship']); escape.detail.published='../etc/passwd'; f.write(escape);
    assert.equal(f.status().effective_decision,'blocked');
    const noRollback=structuredClone(mdsValid['publish/blocked']); noRollback.detail.rolled_back=false; f.write(noRollback);
    assert.equal(f.status().effective_decision,'blocked');
    const mismatch=structuredClone(mdsValid['rollback/blocked']); mismatch.detail.staging_id='other'; f.write(mismatch);
    assert.equal(f.status().effective_decision,'blocked');
    const unsupported=invoiceStatusFixture('mac-dell-staging','0.2.0');
    try { unsupported.write(mdsValid['stage/ship']); assert.equal(unsupported.status().effective_decision,'blocked'); }
    finally {unsupported.close();}
  } finally {f.close();}
});

// A dispatch can produce MORE THAN ONE run in the same Archon conversation (a
// positive acceptance run beside a deliberately-rejecting control). The host
// binding records only one run_id, so a fresh seat could not reach the sibling.
// When the host-trusted archon_conversation_id is present, the read must expose
// the same bounded domain evidence for every sibling rcos-ir-* run.
test('dispatch read exposes sibling runs from the same conversation with their domain evidence',()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'dsh-siblings-')));
  const conv='96f6edf4a8f7141f2530beacd4098d79';
  const seatId='0a4cb4c3-08c2-4233-9fdc-384cb0b7038f';
  const outputRoot=join(home,'.archon/workspaces/test');
  mkdirSync(join(home,'.archon'),{recursive:true});writeFileSync(join(home,'.archon','archon.db'),'');
  const mainRun='8181d37bb0f79c04cf0ce5ac1c009236';
  const sibRun='b80ddae2f4d044d2e7dec58715516014';
  const wfAccept='rcos-ir-mac-dell-staging-acceptance';
  const wfNeg='rcos-ir-mac-dell-staging-neg-hash';
  try {
    const writeRun=(runId,invId,report)=>{
      const artifacts=join(outputRoot,'artifacts/runs',runId);
      const invocationDir=join(home,'zcode-rcos/invocations',invId);
      mkdirSync(artifacts,{recursive:true});mkdirSync(invocationDir,{recursive:true});
      const bytes=Buffer.from(JSON.stringify(report));
      const manifest={schema:'rcos-invocation/1',invocation_id:invId,capability_id:'mac-dell-staging',capability_version:'0.1.0',status:'completed',eligibility_decision_id:'elig_domain-control',
        output:{path:'output.json',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}};
      writeFileSync(join(invocationDir,'output.json'),bytes);
      writeFileSync(join(artifacts,'rcos-invocation-mac-dell-staging.json'),JSON.stringify(manifest));
      writeFileSync(join(invocationDir,'manifest.json'),JSON.stringify(manifest));
      writeFileSync(join(artifacts,'EVAL.json'),JSON.stringify({decision:'ship'}));
    };
    writeRun(mainRun,'inv_main',mdsReport('stage','fix',{reason:'sha256 mismatch',expected:'2'.repeat(64),actual:'c'.repeat(64),bytes:169},'mac-origin-proof-wm311d61'));
    writeRun(sibRun,'inv_sib',mdsReport('stage','fix',{reason:'sha256 mismatch',expected:'0'.repeat(64),actual:'3'.repeat(64),bytes:68},'mac-origin-proof-wm311d61-neg'));
    // The rows the run identity / binding check reads (CLI history), and the
    // rows the sibling lookup reads (archon.db, window-independent).
    const rows=[
      {id:mainRun,conversation_id:conv,worker_platform_id:seatId,workflow_name:wfAccept,status:'completed',started_at:'2026-10-09T00:32:02.000Z',output_root:outputRoot},
      {id:sibRun,conversation_id:conv,worker_platform_id:seatId,workflow_name:wfNeg,status:'completed',started_at:'2026-10-09T00:32:47.000Z',output_root:outputRoot},
    ];
    const sqliteRows=[
      {id:sibRun,conversation_id:conv,workflow_name:wfNeg,status:'completed',started_at:'2026-10-09 00:32:44',completed_at:'2026-10-09 00:32:54',working_path:'/home/chow',output_root:outputRoot},
      {id:mainRun,conversation_id:conv,workflow_name:wfAccept,status:'completed',started_at:'2026-10-09 00:32:02',completed_at:'2026-10-09 00:32:12',working_path:'/home/chow',output_root:outputRoot},
    ];
    const out=remote({operation:'archon_run_status',run_id:mainRun,conversation_id:seatId,archon_conversation_id:conv,workflow_name:wfAccept,workflow_allowlist:[wfAccept,wfNeg],child_nodes:[]},rows,home,{sqliteRows}).result.data;
    assert.equal(out.effective_decision,'fix');
    assert.equal(out.rcos_invocations[0].output.domain_verdict,'fix');
    assert.equal(Array.isArray(out.sibling_runs),true);
    assert.equal(out.sibling_runs.length,1);
    const sib=out.sibling_runs[0];
    assert.equal(sib.run_id,sibRun);
    assert.equal(sib.workflow_name,wfNeg);
    assert.equal(sib.eval.decision,'ship');
    assert.deepEqual(sib.domain_decisions,['fix']);
    assert.equal(sib.rcos_invocations[0].output.domain_verdict,'fix');
    assert.equal(sib.rcos_invocations[0].output.expected,'0'.repeat(64));
    assert.equal(JSON.stringify(out.sibling_runs).includes(home),false);
    // Without the host-trusted conversation id (a bare model-arg read) the
    // sibling enumeration must NOT fire.
    const bare=remote({operation:'archon_run_status',run_id:mainRun,conversation_id:seatId,workflow_name:wfAccept,workflow_allowlist:[wfAccept,wfNeg],child_nodes:[]},rows,home).result.data;
    assert.equal(bare.sibling_runs,undefined);
    // On the trusted path a zero-match read still PRESENTS the key (empty list),
    // so a reader can tell "lookup ran, no sibling" from "no lookup here".
    const empty=remote({operation:'archon_run_status',run_id:mainRun,conversation_id:seatId,archon_conversation_id:conv,workflow_name:wfAccept,workflow_allowlist:[wfAccept,wfNeg],child_nodes:[]},rows,home,{sqliteRows:[]}).result.data;
    assert.deepEqual(empty.sibling_runs,[]);
    // A host-trusted conversation id that does not match the run is refused
    // outright (fail-closed), never silently re-scoped.
    const other=remote({operation:'archon_run_status',run_id:mainRun,conversation_id:seatId,archon_conversation_id:'d'.repeat(32),workflow_name:wfAccept,workflow_allowlist:[wfAccept,wfNeg],child_nodes:[]},rows,home).result;
    assert.equal(other.ok,false);
    assert.match(other.detail,/not an RCOS-compiled workflow bound to this seat session/);
  } finally {rmSync(home,{recursive:true,force:true});}
});
