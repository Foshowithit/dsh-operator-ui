/**
 * WM-scoped, bounded transport to the Dell RCOS registry and Archon CLI.
 *
 * The only remote command is the fixed `bash -s` entrypoint below. Model data
 * travels as base64 JSON and is parsed remotely; it is never interpolated into
 * a shell command. IR compilation is narrowed further: only already-approved
 * Archon workflow nodes and promoted RCOS command capabilities are accepted.
 * Raw Bash, prompt/model nodes, and unlisted workflow names are refused.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { readDispatchBinding } from './dispatch-status.js';

export const name = 'rcos-archon-adapter';
export const inject = ['tools'];

const HOST_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,55}$/;
const CAPABILITY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WORKFLOW_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const CAPABILITY_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,31}$/;
const INVOCATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const QA_VERIFY_WORKFLOW = 'chow-qa-verify-v1';
const QA_CLAIMED_PATH_RE = /\/[A-Za-z0-9_./~-]+\.(?:yaml|yml|json|md|py|sh|txt|log|bak|html|mp4|jpg|jpeg|png|vtt|css|js)/;
const RUN_ID_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const MAX_IR_BYTES = 65536;
const MAX_TASK_CHARS = 8000;
const MAX_OUTPUT_CHARS = 48000;
const REMOTE_PYTHON = readFileSync(new URL('./rcos-archon-remote.py', import.meta.url), 'utf8');

// ir-compile executes these capabilities in the parent prelude, then injects
// absolute output claim_paths and the parent's clock into the child task.
// Only the exact generated invocation filename can supply a future QA claim.
function hasGeneratedInvocationClaim(ir) {
  const outputs = ir.outputs && typeof ir.outputs === 'object' && !Array.isArray(ir.outputs) ? Object.values(ir.outputs) : [];
  return (Array.isArray(ir.capability_refs) ? ir.capability_refs : []).some((ref) => {
    if (!ref || ref.role !== 'executed' || typeof ref.id !== 'string' || !CAPABILITY_RE.test(ref.id)) return false;
    const filename = `rcos-invocation-${ref.id}.json`;
    return outputs.includes(filename) || outputs.includes(`artifacts/${filename}`);
  });
}

export const Config = z.object({
  /** SSH user@host; SSH keys stay in the user's existing ssh-agent/config. */
  sshTarget: z.string().default(''),
  /** Host-owned Dell CC2 profile; never selected by model arguments. */
  desktopRunProfile: z.boolean().default(false),
  /** Only these pre-reviewed Chow workflows can be listed or run. */
  workflowAllowlist: z.array(z.string()).default([]),
  /** Executable name on the local DSH host. */
  sshPath: z.string().default('ssh'),
  /** Bounded transport timeout for catalog and compile operations. */
  timeoutMs: z.number().default(30000),
  /** Compilation can take longer than a read-only catalog call. */
  compileTimeoutMs: z.number().default(120000),
  /** Upper bound for one detached Archon run submission. */
  runTimeoutMs: z.number().default(900000),
  /** Existing dispatcher audit; must match the General seat auditDir. */
  auditDir: z.string().default(join(resolveDshHome(), 'runs', 'seat-dispatch')),
});

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', required: true },
    operation: { type: 'string', required: true },
    exit_code: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
    detail: { type: 'string', required: true },
    data_json: { type: 'string', required: true },
  },
  additionalProperties: false,
};

/** Return local validation errors for the safe, model-authored IR subset. */
export function validateSafeIr(ir, { workflows = [], capabilities } = {}) {
  const errors = [];
  if (ir === null || typeof ir !== 'object' || Array.isArray(ir)) return ['IR must be a JSON object'];
  if (typeof ir.objective !== 'string' || !ir.objective.trim() || ir.objective.length > 4000) errors.push('IR objective must be a non-empty string of at most 4000 characters');
  for (const field of ['inputs', 'outputs']) {
    const values = ir[field];
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      errors.push(`IR ${field} must be a map of labels to safe relative artifact paths`);
      continue;
    }
    for (const [label, artifactPath] of Object.entries(values)) {
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(label)) errors.push(`IR ${field} label '${label}': unsafe label`);
      if (typeof artifactPath !== 'string' || !/^(?:artifacts\/)?[A-Za-z0-9._/-]{1,240}$/.test(artifactPath)
          || artifactPath.split('/').includes('..')) {
        errors.push(`IR ${field} '${label}': path must be a safe relative path`);
      }
    }
  }
  if (!Array.isArray(ir.acceptance) || ir.acceptance.length === 0 || ir.acceptance.length > 32) {
    errors.push('IR needs 1 to 32 acceptance criteria');
  } else {
    for (const [index, criterion] of ir.acceptance.entries()) {
      if (typeof criterion !== 'string' || !criterion.trim() || criterion.length > 1000 || /[\r\n\x00-\x1f]/.test(criterion)) {
        errors.push(`IR acceptance[${index}] must be a single-line string of at most 1000 characters`);
      }
    }
  }
  if (Array.isArray(ir.approval_gates) && ir.approval_gates.length > 0) {
    errors.push('IR approval_gates are not supported by this adapter; use an approved Archon workflow with its own approval policy');
  }
  if (!Array.isArray(ir.nodes) || ir.nodes.length === 0 || ir.nodes.length > 64) errors.push('IR needs 1 to 64 approved workflow nodes');

  for (const node of Array.isArray(ir.nodes) ? ir.nodes : []) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      errors.push('IR nodes must be objects');
      continue;
    }
    if (typeof node.id !== 'string' || !NODE_ID_RE.test(node.id)) {
      errors.push('IR node ids must be short alphanumeric ids with only underscore or hyphen');
    }
    if (node.memory_scope !== 'run') errors.push(`node '${String(node.id || '?')}': memory_scope must be 'run'`);
    if (!Array.isArray(node.depends_on) || node.depends_on.some((id) => typeof id !== 'string' || !NODE_ID_RE.test(id))) {
      errors.push(`node '${String(node.id || '?')}': depends_on must contain valid node ids`);
    }
    if (node.execution_class === 'deterministic') {
      errors.push(`node '${String(node.id || '?')}': deterministic nodes are not allowed because IR v0.1 emits model-authored Bash`);
      continue;
    }
    if (node.execution_class === 'model') {
      errors.push(`node '${String(node.id || '?')}': model nodes are not allowed in the bounded RCOS/Archon adapter`);
      continue;
    }
    if (node.execution_class === 'agent') {
      errors.push(`node '${String(node.id || '?')}': agent nodes are not supported by the compiled adapter`);
      continue;
    }
    if (node.execution_class !== 'workflow') {
      errors.push(`node '${String(node.id || '?')}': only Archon workflow nodes are allowed`);
      continue;
    }
    const workflow = node.ref && typeof node.ref === 'object' ? node.ref.workflow : undefined;
    if (typeof workflow !== 'string' || !WORKFLOW_RE.test(workflow)) {
      errors.push(`node '${String(node.id || '?')}': workflow must be a lowercase Archon workflow id`);
    } else if (!workflows.includes(workflow)) {
      errors.push(`node '${String(node.id || '?')}': workflow '${workflow}' is not in the approved Archon workflow catalog`);
    }
    if (node.ref && node.ref.inputs !== undefined && (!node.ref.inputs || typeof node.ref.inputs !== 'object' || Array.isArray(node.ref.inputs))) {
      errors.push(`node '${String(node.id || '?')}': workflow inputs must be a JSON object`);
    }
    if (workflow === QA_VERIFY_WORKFLOW) {
      const task = node.ref?.inputs?.task;
      if (typeof task !== 'string' || !task.trim() || (!QA_CLAIMED_PATH_RE.test(task) && !hasGeneratedInvocationClaim(ir))) {
        errors.push(`node '${String(node.id || '?')}': ${QA_VERIFY_WORKFLOW} requires ref.inputs.task to be a non-empty string and either an absolute claimed path with a supported file extension or an IR output naming the exact generated rcos-invocation-<executed-capability-id>.json receipt`);
      }
    }
  }

  const refs = Array.isArray(ir.capability_refs) ? ir.capability_refs : [];
  const executed = refs.filter((ref) => ref && ref.role === 'executed');
  if (executed.length === 0) errors.push('IR must execute at least one promoted RCOS capability');
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object' || !CAPABILITY_RE.test(String(ref.id || ''))) {
      errors.push('RCOS capability refs must use a lowercase registry capability id');
      continue;
    }
    if (!['executed', 'composed', 'dependency'].includes(ref.role)) {
      errors.push(`RCOS capability '${ref.id}' has an unsupported role`);
    }
    if (typeof ref.version !== 'undefined' && (typeof ref.version !== 'string' || !CAPABILITY_VERSION_RE.test(ref.version))) {
      errors.push(`RCOS capability '${ref.id}' has an invalid version`);
    }
    if (typeof ref.invocation_id !== 'undefined' && (typeof ref.invocation_id !== 'string' || !INVOCATION_ID_RE.test(ref.invocation_id))) {
      errors.push(`RCOS capability '${ref.id}' has an invalid authored invocation id`);
    }
    if (ref.role === 'executed' && Array.isArray(capabilities)) {
      const capability = capabilities.find((item) => item && item.id === ref.id);
      if (!capability || capability.status !== 'promoted' || capability.adapter?.type !== 'command') {
        errors.push(`executed capability '${ref.id}' is not promoted with a declared adapter`);
      }
    }
  }

  if (ir.outputs && typeof ir.outputs === 'object' && !Array.isArray(ir.outputs)) {
    for (const [label, outputPath] of Object.entries(ir.outputs)) {
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(label)) errors.push(`output '${label}': unsafe output label`);
      if (typeof outputPath !== 'string' || !/^(?:artifacts\/)?[A-Za-z0-9._/-]{1,240}$/.test(outputPath)
          || outputPath.split('/').includes('..')) {
        errors.push(`output '${label}': path must be a safe relative path under the Archon run artifacts directory`);
      }
    }
  }

  if (typeof ir.name !== 'undefined' && (typeof ir.name !== 'string' || !SLUG_RE.test(ir.name))) {
    errors.push('IR name must be a lowercase slug');
  }
  return [...new Set(errors)];
}

/** Build the fixed remote program; all caller data remains inside base64 JSON. */
export function buildRemoteProgram(request) {
  const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  const python = REMOTE_PYTHON.replace('__REQUEST_B64__', encoded);
  return "python3 - <<'PY'\n" + python + "\nPY\n";
}

function validateConfig(config) {
  if (typeof config.sshTarget !== 'string' || !HOST_RE.test(config.sshTarget)) {
    throw new Error('rcos-archon-adapter sshTarget must be a fixed user@host value');
  }
  if (!Array.isArray(config.workflowAllowlist) || config.workflowAllowlist.length === 0) {
    throw new Error('rcos-archon-adapter requires a non-empty approved workflow allowlist');
  }
  const invalid = config.workflowAllowlist.filter((item) => typeof item !== 'string' || !WORKFLOW_RE.test(item));
  if (invalid.length) throw new Error('rcos-archon-adapter workflowAllowlist contains an invalid workflow id');
  if (new Set(config.workflowAllowlist).size !== config.workflowAllowlist.length) {
    throw new Error('rcos-archon-adapter workflowAllowlist must not contain duplicates');
  }
  if (config.workflowAllowlist.some((item) => item.startsWith('rcos-ir-'))) {
    throw new Error('rcos-archon-adapter workflowAllowlist cannot pre-authorize compiled workflow names');
  }
  for (const field of ['timeoutMs', 'compileTimeoutMs', 'runTimeoutMs']) {
    if (!Number.isFinite(config[field]) || config[field] <= 0) {
      throw new Error(`rcos-archon-adapter ${field} must be a positive finite number`);
    }
  }
}

async function callSsh(config, request, { signal, timeoutMs } = {}) {
const script = buildRemoteProgram({ ...request, workflow_allowlist: request.workflow_allowlist || config.workflowAllowlist });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      try { child?.kill('SIGTERM'); } catch { /* process may have exited */ }
      finish({ ok: false, operation: request.operation, exit_code: null, detail: 'SSH request was cancelled', data: null });
    };
    const timer = setTimeout(() => {
      try { child?.kill('SIGTERM'); } catch { /* process may have exited */ }
      finish({ ok: false, operation: request.operation, exit_code: null, detail: 'SSH request timed out', data: null });
    }, Math.max(1000, timeoutMs || config.timeoutMs));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      child = spawn(config.sshPath, [
        '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
        config.sshTarget, 'bash -s',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-MAX_OUTPUT_CHARS); });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
      child.on('error', (error) => finish({ ok: false, operation: request.operation, exit_code: null, detail: 'SSH transport error: ' + String(error?.message || error).slice(0, 400), data: null }));
      child.on('close', (code) => {
        let parsed;
        try { parsed = JSON.parse(stdout.trim()); } catch { parsed = null; }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return finish(parsed);
        finish({
          ok: false,
          operation: request.operation,
          exit_code: Number.isInteger(code) ? code : null,
          detail: 'The Dell adapter returned no valid JSON result' + (stderr ? ': ' + stderr.trim().slice(-1200) : ''),
          data: { output_tail: stdout.slice(-1200) },
        });
      });
      child.stdin.end(script);
    } catch (error) {
      finish({ ok: false, operation: request.operation, exit_code: null, detail: 'SSH transport could not start: ' + String(error?.message || error).slice(0, 400), data: null });
    }
  });
}

function toOutput(operation, value) {
  let dataJson = '';
  try { dataJson = JSON.stringify(value?.data ?? null); } catch { dataJson = 'null'; }
  if (dataJson.length > MAX_OUTPUT_CHARS) dataJson = dataJson.slice(-MAX_OUTPUT_CHARS);
  return {
    ok: value?.ok === true,
    operation,
    exit_code: Number.isInteger(value?.exit_code) ? value.exit_code : null,
    detail: typeof value?.detail === 'string' ? value.detail.slice(0, 1200) : 'No adapter detail returned',
    data_json: dataJson,
  };
}

function makeTool({ name: toolName, description, parameters, operation, payload, timeoutMs, callRemote, onSuccess }) {
  return defineTool({
    name: toolName,
    description,
    parameters,
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `${value.ok ? 'OK' : 'REFUSED'} ${value.operation} exit=${value.exit_code}\n${value.detail}\n${value.data_json}`,
      }],
    },
    timeoutMs,
    async execute(args, exec) {
      const request = await payload(args, exec);
      const result = await callRemote(operation, request, exec?.signal, timeoutMs);
      if (result?.ok === true) onSuccess?.(request, result);
      return toOutput(operation, result);
    },
  });
}

/** Build definitions for a WM-scoped preset; dependency injection keeps tests offline. */
export function createAdapterTools({ sshTarget, workflowAllowlist, desktopRunProfile = false, sshPath = 'ssh', timeoutMs = 30000, compileTimeoutMs = 120000, runTimeoutMs = 900000, auditDir = join(resolveDshHome(), 'runs', 'seat-dispatch'), callRemote } = {}) {
  if (typeof desktopRunProfile !== 'boolean') throw new Error('desktopRunProfile must be a host-configured boolean');
  const config = { sshTarget, workflowAllowlist, desktopRunProfile, sshPath, timeoutMs, compileTimeoutMs, runTimeoutMs };
  validateConfig(config);
  const createdWorkflows = new Set();
  const compiledWorkflowChildren = new Map();
  const createdRuns = new Map();
  const attemptedWorkflows = new Set();
  let compileValidationFailures = 0;
  const currentWorkflowAllowlist = () => [...workflowAllowlist, ...createdWorkflows];
  const remote = (operation, request, signal, budget) => {
    const { dispatch_binding, requested_dispatch_id, ...remoteRequest } = request;
    // Status payloads obtain this exact wrapper from a captured run binding.
    const readWorkflow = operation === 'archon_run_status' ? [request.workflow_name] : [];
    const requestWithAllowlist = { ...remoteRequest, workflow_allowlist: [...new Set([...currentWorkflowAllowlist(), ...readWorkflow])], desktop_run_profile: desktopRunProfile };
    return callRemote
      ? callRemote(operation, requestWithAllowlist, signal, budget)
      : callSsh(config, { operation, ...requestWithAllowlist }, { signal, timeoutMs: budget });
  };
  const tool = (options) => {
    return makeTool({ ...options, callRemote: remote });
  };

  return [
    tool({
      name: 'rcos_catalog',
      description: 'Read the current Dell RCOS capability registry. This is discovery only; it grants no execution authority.',
      parameters: {},
      operation: 'rcos_catalog',
      payload: () => ({}),
      timeoutMs,
    }),
    tool({
      name: 'rcos_capability_contract',
      description: 'Read the exact JSON contract for one currently promoted RCOS capability, including its input and output requirements.',
      parameters: {
        capability_id: { type: 'string', required: true, description: 'Exact capability id returned by rcos_catalog.' },
      },
      operation: 'rcos_capability_contract',
      payload: (args) => {
        if (typeof args.capability_id !== 'string' || !CAPABILITY_RE.test(args.capability_id)) throw new Error('capability_id must be a lowercase RCOS id');
        return { capability_id: args.capability_id };
      },
      timeoutMs,
    }),
    tool({
      name: 'archon_workflow_catalog',
      description: 'Read the current Dell Archon catalog, filtered to the host-configured approved workflow names. Each reviewed workflow includes an evaluation_contract; select only gate_eligible:true workflows for RCOS wrappers. Also follow execution_contract: desktop_profile_eligible:false routes are refused because their launch or provider path is incompatible with this Desktop profile. Ineligible workflows are refused before compilation. The RCOS parent prelude executes the capability. To verify its generated receipt, select chow-qa-verify-v1 and follow its input_contract for compiler-provided claim_paths. chow-build-standard performs project work inside an isolated child directory; it cannot read external parent receipts.',
      parameters: {},
      operation: 'archon_workflow_catalog',
      payload: () => ({}),
      timeoutMs,
    }),
    tool({
      name: 'rcos_compile_ir',
      description: `Compile and additively install a bounded RCOS IR v0.1 wrapper. Before compiling, call rcos_catalog, then rcos_capability_contract with the exact promoted capability id; use its exact input schema for archon_workflow_run input_json. Also call archon_workflow_catalog, select only workflows with evaluation_contract.gate_eligible:true and no execution_contract.desktop_profile_eligible:false, and follow each workflow's input_contract. Workflows with incompatible evaluation, launch, or provider paths are refused before compilation. The parent prelude runs the executed capability before child workflow nodes. For verification of that result, select chow-qa-verify-v1, declare outputs.invocation="artifacts/rcos-invocation-<capability-id>.json", and use {"task":"Verify the compiler-provided claim_paths using the parent run clock"}. The compiler supplies real absolute claim_paths and run_start_epoch at execution; do not guess the future run directory or ask the child to rerun the capability. QA checks existence and freshness; the parent additionally verifies RCOS integrity, eligibility, and input/output contracts. For an existing explicit file claim, QA also accepts {"task":"Verify /absolute/path/to/claimed-file.md and report evidence"}. chow-build-standard is for actual project builds within the isolated child directory; its rules prohibit reading external parent receipts. The workflow value shown is an example from this preset's approved workflow list: ${workflowAllowlist[0]}. The executed capability's run artifacts are named rcos-input-<capability-id>.json and rcos-invocation-<capability-id>.json. This exact shape is accepted; use role "executed" for the capability that will run:
{
  "objective": "<what this bounded job should accomplish>",
  "inputs": {"request": "artifacts/rcos-input-<capability-id>.json"},
  "outputs": {"receipt": "artifacts/rcos-invocation-<capability-id>.json"},
  "acceptance": ["<one concise, testable success condition>"],
  "nodes": [{"id": "run-approved-workflow", "execution_class": "workflow", "ref": {"workflow": "${workflowAllowlist[0]}", "inputs": {"task": "<replace with selected workflow task; QA example: Verify /absolute/path/to/claimed-file.md>"}}, "depends_on": [], "memory_scope": "run"}],
  "capability_refs": [{"id": "<exact-promoted-capability-id>", "version": "<exact-capability-version>", "role": "executed"}]
}
Only the exact node shape above is supported: execution_class="workflow", ref.workflow and ref.inputs, depends_on array, and memory_scope="run". Raw Bash, model nodes, and unlisted workflows are refused. Three invalid IR attempts exhaust compilation for this seat; use the validation errors and this template carefully.`,
      parameters: {
        name: { type: 'string', required: true, description: 'A new lowercase slug for the namespaced rcos-ir workflow; existing names are never overwritten.' },
        ir_json: { type: 'string', required: true, description: 'The complete RCOS IR v0.1 JSON plan. Only workflow nodes plus at least one promoted executed capability ref are accepted.' },
      },
      operation: 'rcos_compile_ir',
      payload: (args) => {
        if (compileValidationFailures >= 3) {
          throw new Error('This seat has reached three IR validation failures; no remote compile was attempted. Submit a fix receipt naming this blocker; the caller can start a fresh dispatch with the exact rcos_compile_ir template and prior validation errors.');
        }
        const rejectValidation = (message) => {
          compileValidationFailures += 1;
          throw new Error(message);
        };
        let ir;
        try { ir = JSON.parse(args.ir_json); } catch { return rejectValidation('ir_json is not valid JSON. Copy the exact JSON template from this tool description and replace only its placeholders.'); }
        if (Buffer.byteLength(args.ir_json, 'utf8') > MAX_IR_BYTES) return rejectValidation(`ir_json exceeds ${MAX_IR_BYTES} bytes; use the compact template in this tool description.`);
        if (typeof args.name !== 'string' || !SLUG_RE.test(args.name)) return rejectValidation('name must be a new lowercase slug (lowercase letters, digits, hyphens; at most 56 characters).');
        const errors = validateSafeIr(ir, { workflows: currentWorkflowAllowlist() });
        if (errors.length) return rejectValidation(`IR validation failed: ${errors.join('; ')}. Expected nodes:[{"id":"run-approved-workflow","execution_class":"workflow","ref":{"workflow":"${workflowAllowlist[0]}","inputs":{}},"depends_on":[],"memory_scope":"run"}] and capability_refs:[{"id":"<exact-promoted-capability-id>","version":"<exact-version>","role":"executed"}]. Read that capability's rcos_capability_contract before supplying archon_workflow_run input_json.`);
        return { name: args.name, ir };
      },
      timeoutMs: compileTimeoutMs,
      onSuccess: (request) => {
        const workflowName = `rcos-ir-${request.name}`;
        createdWorkflows.add(workflowName);
        compiledWorkflowChildren.set(workflowName, request.ir.nodes
          .filter((node) => node?.execution_class === 'workflow' && node.ref && typeof node.ref === 'object')
          .map((node) => ({ id: node.id, workflow: node.ref.workflow })));
      },
    }),
    tool({
      name: 'archon_workflow_run',
      description: 'Start one RCOS-compiled workflow created by this seat. It requires structured JSON inputs and is bound to this Workflow Manager seat session; repeated calls only reconcile existing runs and never resubmit. Use a new compiled name for a distinct job.',
      parameters: {
        workflow_name: { type: 'string', required: true, description: 'Exact rcos-ir workflow name returned by rcos_compile_ir in this seat.' },
        input_json: { type: 'string', required: true, description: 'JSON object string matching the selected promoted capability contract; include the objective and task context.' },
      },
      operation: 'archon_workflow_run',
      payload: (args, exec) => {
        if (!createdWorkflows.has(args.workflow_name)) throw new Error('workflow must be successfully compiled by this seat before it can run');
        if (typeof args.input_json !== 'string' || !args.input_json.trim() || Buffer.byteLength(args.input_json, 'utf8') > MAX_TASK_CHARS) throw new Error(`input_json must be non-empty and at most ${MAX_TASK_CHARS} bytes`);
        let input;
        try { input = JSON.parse(args.input_json); } catch { throw new Error('input_json must be valid JSON'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input_json must be a JSON object');
        const conversationId = exec?.agent?.session?.id;
        if (typeof conversationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(conversationId)) throw new Error('live Workflow Manager seat session identity is unavailable');
        const lookupOnly = attemptedWorkflows.has(args.workflow_name);
        attemptedWorkflows.add(args.workflow_name);
        // The seat's dispatch frame cancels in-flight detached runs when its turn
        // closes, so a launch-and-report seat would always read a cancelled run with
        // no domain report (measured 2026-10-09). Ask the remote to wait for the run
        // to reach a terminal state before returning, capped 30s under the tool's own
        // budget so the SSH call itself never races the run.
        const waitSeconds = Math.max(0, Math.min(900, Math.floor(runTimeoutMs / 1000) - 30));
        return { workflow_name: args.workflow_name, task: JSON.stringify(input), conversation_id: conversationId, lookup_only: lookupOnly, child_nodes: compiledWorkflowChildren.get(args.workflow_name) || [], wait_seconds: waitSeconds };
      },
      timeoutMs: runTimeoutMs,
      onSuccess: (request, result) => {
        const runId = result?.data?.run_id || result?.data?.id;
        if (typeof runId === 'string' && RUN_ID_RE.test(runId)) createdRuns.set(runId, { seat: request.conversation_id, internal: result.data.conversation_id, workflow: request.workflow_name, child_nodes: request.child_nodes });
      },
    }),
    tool({
      name: 'archon_run_status',
      description: 'Read exact Archon status, bounded verified RCOS invocation evidence, and child workflow evaluations for a run returned by this seat. Use effective_decision for acceptance: invoice output.domain_verdict FIX/BLOCKED overrides workflow SHIP; unavailable verified invoice outcomes block acceptance. While status is running, queued, or pending, effective_decision=pending and pending_checks are unfinished checks. Parent completion alone does not establish ship.',
      parameters: {
        run_id: { type: 'string', required: true, description: 'Exact Archon run id returned by archon_workflow_run.' },
      },
      operation: 'archon_run_status',
      payload: (args, exec) => {
        if (typeof args.run_id !== 'string' || !RUN_ID_RE.test(args.run_id)) throw new Error('run_id must be the exact run id returned by Archon');
        if (!createdRuns.has(args.run_id)) throw new Error('run_id must be returned by archon_workflow_run in this seat');
        const conversationId = exec?.agent?.session?.id;
        if (typeof conversationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(conversationId)) throw new Error('live Workflow Manager seat session identity is unavailable');
        const binding = createdRuns.get(args.run_id);
        if (binding.seat !== conversationId) throw new Error("run must be polled by its creating seat");
        return { run_id: args.run_id, conversation_id: conversationId, archon_conversation_id: binding.internal, workflow_name: binding.workflow, child_nodes: binding.child_nodes };
      },
      timeoutMs,
    }),
    tool({
      name: 'archon_dispatch_status',
      description: 'Read an existing Archon run from a prior accepted Workflow Manager dispatch in this same General chat, including its exact child evaluations. Use this for follow-up checks after the original seat has closed or the app restarted. Supply the saved sd- dispatch id; the host audit supplies the original run, seat, workflow, and child identities. This only reads status: it cannot compile, start, or retry a workflow. Use archon_run_status only for a run started in the current seat.',
      parameters: {
        dispatch_id: { type: 'string', required: true, description: 'Exact sd- dispatch id returned by the previous dispatch_seat call.' },
      },
      operation: 'archon_run_status',
      payload: async (args, exec) => {
        const binding = await readDispatchBinding({ auditDir, dispatchId: args.dispatch_id, exec, workflowAllowlist });
        return { run_id: binding.run_id, conversation_id: binding.seat_session_id,
          archon_conversation_id: binding.archon_conversation_id, workflow_name: binding.workflow_name,
          child_nodes: binding.child_nodes, dispatch_binding: binding, requested_dispatch_id: args.dispatch_id };
      },
      onSuccess: (request, result) => {
        result.data = { ...result.data, dispatch_binding: request.dispatch_binding, requested_dispatch_id: request.requested_dispatch_id };
      },
      timeoutMs,
    }),
  ];
}

export function apply(ctx, config) {
  validateConfig(config);
  const tools = createAdapterTools(config);
  for (const tool of tools) ctx.tools.register(tool);
}
