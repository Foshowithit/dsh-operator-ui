'use strict';

/* RCOS IR v0.1 -> Archon DAG compiler (A2-c prerequisite, additive).
 *
 * Contract sources: ~/chow-work/rcos/ir-v0.1.md (frozen v0.1) and
 * docs/a2-supported-contracts-20260929.md §8. The mapping is deliberately
 * partial and fails closed on everything v0 cannot represent honestly:
 *
 *   execution_class deterministic -> bash node (ref verbatim, cwd $ARTIFACTS_DIR)
 *   execution_class model        -> prompt node; ALL model nodes must share one
 *                                   lane, which becomes the workflow header
 *                                   (per-node lanes are not representable)
 *   execution_class agent        -> COMPILE ERROR (no native v0 node type;
 *                                   decompose, or reference as a workflow)
 *   execution_class workflow     -> bash node calling `archon workflow run`
 *   memory_scope run             -> $ARTIFACTS_DIR (only representable scope)
 *   memory_scope turn|workflow|workflow-role -> COMPILE ERROR
 *   approval_gates[]             -> fail-closed HITL bash node after its
 *                                   boundary node; dependents are rewired to
 *                                   depend on the approval node
 *   capability_refs[executed]    -> prelude bash node: `rcos run <id>` with the
 *                                   run's JSON $ARGUMENTS as --input; the
 *                                   kernel mints the live invocation id
 *   capability_refs[composed|dependency] -> header comment only, never a node
 *   outputs                      -> top-level eval.check (`test -s` each);
 *                                   a leading `artifacts/` maps to $ARTIFACTS_DIR
 *   acceptance                   -> recorded in eval.pass + eval.check comments;
 *                                   judgment criteria stay owned by the
 *                                   capability's own eval, not this DAG
 *
 * The output is deterministic: no timestamps inside the artifact, so the same
 * IR + name always compiles to the same bytes.
 */

const EXECUTION_CLASSES = ['deterministic', 'model', 'agent', 'workflow'];
const MEMORY_SCOPES = ['turn', 'run', 'workflow', 'workflow-role'];
const REPRESENTABLE_SCOPES = ['run'];
const CAPABILITY_ROLES = ['executed', 'composed', 'dependency'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function slugFromObjective(ir) {
  const words = String((ir && ir.objective) || '')
    .split(/\s+/).filter(Boolean).slice(0, 6).join('-');
  const s = slug(words) || 'plan';
  return s;
}

/* ---------- YAML emission helpers (no dependency, deliberately) ---------- */

function yq(s) {
  // single-quoted YAML scalar; doubles any internal quote
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function plain(s) {
  return /^[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/.test(s) ? s : yq(s);
}

function blockLines(key, text, indent, out) {
  // `key: |` literal block; every content line indented indent+2
  const pad = ' '.repeat(indent + 2);
  out.push(' '.repeat(indent) + key + ': |');
  for (const line of String(text).split('\n')) out.push(line.length ? pad + line : '');
}

function shellSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/* ---------- validation ---------- */

function validateIR(ir) {
  const errors = [];
  if (ir === null || typeof ir !== 'object' || Array.isArray(ir)) return ['ir: not a JSON object'];

  if (typeof ir.objective !== 'string' || !ir.objective.trim()) {
    errors.push('objective: required non-empty string');
  }
  for (const k of ['inputs', 'outputs']) {
    const v = ir[k];
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      errors.push(k + ': required map of name -> path');
      continue;
    }
    for (const [name, p] of Object.entries(v)) {
      if (typeof p !== 'string' || !p.trim()) {
        errors.push(k + '.' + name + ': must be a non-empty path string');
      }
    }
  }
  if (!Array.isArray(ir.acceptance) || ir.acceptance.length === 0) {
    errors.push('acceptance: required non-empty list (criteria are defined before the run)');
  } else {
    ir.acceptance.forEach((c, i) => {
      if (typeof c !== 'string' || !c.trim()) errors.push('acceptance[' + i + ']: criterion must be a string');
    });
  }

  const nodeIds = new Set();
  if (!Array.isArray(ir.nodes) || ir.nodes.length === 0) {
    errors.push('nodes: required non-empty list');
  } else {
    for (const n of ir.nodes) {
      if (n === null || typeof n !== 'object' || Array.isArray(n)) {
        errors.push('nodes: every node must be an object'); continue;
      }
      if (typeof n.id !== 'string' || !n.id.trim()) { errors.push('node: id required'); continue; }
      if (!NODE_ID_RE.test(n.id)) {
        errors.push("node '" + n.id + "': id must match " + NODE_ID_RE + " (emitted verbatim into YAML)");
        continue;
      }
      if (nodeIds.has(n.id)) errors.push("node '" + n.id + "': duplicate id");
      nodeIds.add(n.id);
      if (!EXECUTION_CLASSES.includes(n.execution_class)) {
        errors.push("node '" + n.id + "': execution_class must be one of " + EXECUTION_CLASSES.join('|'));
      }
      if (n.memory_scope === undefined) {
        errors.push("node '" + n.id + "': memory_scope required");
      } else if (!MEMORY_SCOPES.includes(n.memory_scope)) {
        errors.push("node '" + n.id + "': memory_scope must be one of " + MEMORY_SCOPES.join('|'));
      } else if (!REPRESENTABLE_SCOPES.includes(n.memory_scope)) {
        errors.push("node '" + n.id + "': memory_scope '" + n.memory_scope + "' is not representable in an Archon DAG — only 'run' (= $ARTIFACTS_DIR) compiles in IR v0.1");
      }
      if (n.execution_class === 'deterministic') {
        if (typeof n.ref !== 'string' || !n.ref.trim()) {
          errors.push("node '" + n.id + "': deterministic ref must be a command string");
        }
      } else if (n.execution_class === 'model') {
        if (n.ref === null || typeof n.ref !== 'object' || Array.isArray(n.ref)) {
          errors.push("node '" + n.id + "': model ref must be an object {lane, prompt}");
        } else {
          if (typeof n.ref.lane !== 'string' || !n.ref.lane.includes('/') || !n.ref.lane.split('/')[0].trim() || !n.ref.lane.split('/').slice(1).join('/').trim()) {
            errors.push("node '" + n.id + "': model ref.lane must look like provider/modelid");
          }
          if (typeof n.ref.prompt !== 'string' || !n.ref.prompt.trim()) {
            errors.push("node '" + n.id + "': model ref.prompt required non-empty");
          }
        }
      } else if (n.execution_class === 'workflow') {
        if (n.ref === null || typeof n.ref !== 'object' || Array.isArray(n.ref)) {
          errors.push("node '" + n.id + "': workflow ref must be an object {workflow, inputs}");
        } else if (typeof n.ref.workflow !== 'string' || !n.ref.workflow.trim()) {
          errors.push("node '" + n.id + "': workflow ref.workflow required non-empty");
        } else if (n.ref.inputs !== undefined && (n.ref.inputs === null || typeof n.ref.inputs !== 'object' || Array.isArray(n.ref.inputs))) {
          errors.push("node '" + n.id + "': workflow ref.inputs must be an object");
        }
      } else if (n.execution_class === 'agent') {
        errors.push("node '" + n.id + "': execution_class 'agent' has no native Archon node type in IR v0.1 — decompose into model + deterministic nodes, or reference an already-certified workflow");
      }
    }
    // depends_on resolution + cycle detection (only meaningful once ids are known)
    const deps = new Map();
    for (const n of ir.nodes) {
      if (typeof n.id !== 'string' || !nodeIds.has(n.id)) continue;
      const list = Array.isArray(n.depends_on) ? n.depends_on : [];
      if (n.depends_on === undefined) list.length = 0;
      if (!Array.isArray(n.depends_on)) {
        errors.push("node '" + n.id + "': depends_on must be a list of node ids");
      }
      if (list.includes(n.id)) errors.push("node '" + n.id + "': depends_on itself");
      for (const d of list) {
        if (!nodeIds.has(d)) errors.push("node '" + n.id + "': depends_on unknown node '" + d + "'");
      }
      deps.set(n.id, list.filter(d => nodeIds.has(d) && d !== n.id));
    }
    // Kahn cycle check
    const indeg = new Map();
    for (const id of nodeIds) indeg.set(id, 0);
    for (const [id, list] of deps) for (const d of list) indeg.set(id, indeg.get(id) + 1);
    const queue = [...nodeIds].filter(id => indeg.get(id) === 0);
    const order = [];
    while (queue.length) {
      const cur = queue.shift();
      order.push(cur);
      for (const [id, list] of deps) {
        if (list.includes(cur)) {
          indeg.set(id, indeg.get(id) - 1);
          if (indeg.get(id) === 0) queue.push(id);
        }
      }
    }
    if (order.length !== nodeIds.size) {
      const cyc = [...nodeIds].filter(id => indeg.get(id) > 0 || !order.includes(id));
      errors.push('nodes: dependency cycle involving ' + cyc.map(x => "'" + x + "'").join(', '));
    }
  }

  // model lanes must agree (single-lane workflow header)
  const lanes = new Set();
  if (Array.isArray(ir.nodes)) {
    for (const n of ir.nodes) {
      if (n && n.execution_class === 'model' && n.ref && typeof n.ref === 'object' && typeof n.ref.lane === 'string' && n.ref.lane.includes('/')) {
        lanes.add(n.ref.lane);
      }
    }
  }
  if (lanes.size > 1) {
    errors.push('nodes: model nodes declare ' + lanes.size + " different lanes (" + [...lanes].join(', ') + ") — an Archon DAG carries ONE lane in its header; split the plan or unify the lane");
  }

  if (ir.approval_gates !== undefined) {
    if (!Array.isArray(ir.approval_gates)) {
      errors.push('approval_gates: must be a list');
    } else {
      for (const g of ir.approval_gates) {
        if (g === null || typeof g !== 'object' || typeof g.after !== 'string' || !g.after.trim()) {
          errors.push('approval_gates: every gate must name its node boundary as {after: <node id>}');
        } else if (!nodeIds.has(g.after)) {
          errors.push("approval_gates: boundary node '" + g.after + "' does not exist");
        }
      }
    }
  }

  if (ir.capability_refs !== undefined) {
    if (!Array.isArray(ir.capability_refs)) {
      errors.push('capability_refs: must be a list');
    } else {
      for (const c of ir.capability_refs) {
        if (c === null || typeof c !== 'object' || typeof c.id !== 'string' || !c.id.trim()) {
          errors.push('capability_refs: every entry needs a registry capability id');
        } else if (!CAPABILITY_ROLES.includes(c.role)) {
          errors.push("capability_refs '" + c.id + "': role must be one of " + CAPABILITY_ROLES.join('|'));
        }
      }
    }
  }

  return errors;
}

/* ---------- compile ---------- */

function outputArtifactsPath(p, warnings, name) {
  // IR plan-workdir-relative -> $ARTIFACTS_DIR-relative. The spec's example
  // writes outputs under `artifacts/`; in a compiled DAG the plan workdir IS
  // the run artifacts dir, so the prefix is dropped (warned, never silent).
  if (p.startsWith('artifacts/')) {
    const rest = p.slice('artifacts/'.length);
    warnings.push("outputs." + name + ": '" + p + "' mapped to $ARTIFACTS_DIR/" + rest + " (plan workdir == run artifacts dir)");
    return rest;
  }
  if (p.startsWith('/')) {
    warnings.push("outputs." + name + ": absolute path used verbatim (" + p + ")");
  }
  return p;
}

function compileIR(ir, opts) {
  opts = opts || {};
  const warnings = [];
  const errors = [];

  const name = opts.name === undefined ? slugFromObjective(ir) : String(opts.name);
  if (!NAME_RE.test(name)) {
    errors.push("name '" + name + "' must match " + NAME_RE + " (lowercase slug, used as rcos-ir-<name>)");
  }

  errors.push(...validateIR(ir));
  if (errors.length) return { ok: false, errors, warnings };

  const executedRefs = (ir.capability_refs || []).filter(c => c.role === 'executed');
  const metadataRefs = (ir.capability_refs || []).filter(c => c.role !== 'executed');

  if (ir.memory && typeof ir.memory === 'object') {
    if (ir.memory.workdir !== undefined) warnings.push('memory.workdir not compiled — Archon provides the run dir ($ARTIFACTS_DIR)');
    if (ir.memory.promotion !== undefined) warnings.push("memory.promotion ('" + ir.memory.promotion + "') recorded only — promotion happens through the registry, not the DAG");
  }
  if (!Array.isArray(ir.acceptance) || ir.acceptance.length === 0) warnings.push('acceptance: absent — eval.check enforces output presence only');
  for (const n of ir.nodes) {
    if (n.execution_class === 'deterministic' && typeof n.ref === 'string' && !n.ref.trimStart().startsWith('/') && !n.ref.includes('$')) {
      warnings.push("node '" + n.id + "': deterministic ref '" + n.ref + "' is relative — absolute refs (or $HOME/$ARTIFACTS_DIR-anchored) are safest inside an Archon DAG");
    }
  }
  for (const g of (ir.approval_gates || [])) {
    const decisions = (g && Array.isArray(g.decisions)) ? g.decisions : [];
    if (decisions.some(d => String(d).toLowerCase() === 'rework')) {
      warnings.push("approval gate after '" + g.after + "': decision 'rework' recorded but the v0 gate is approve-or-block only");
    }
  }

  // Deep-copy the node dependency lists; rewiring must never mutate the input IR.
  const deps = new Map(ir.nodes.map(n => [n.id, Array.isArray(n.depends_on) ? [...n.depends_on] : []]));

  // capability prelude: chained in declaration order; original entry nodes
  // become dependent on the last prelude node so no work starts before reuse.
  const capNodes = executedRefs.map((c, i) => ({
    kind: 'cap',
    id: 'cap-' + slug(c.id),
    cap: c,
    deps: i === 0 ? [] : ['cap-' + slug(executedRefs[i - 1].id)],
  }));
  if (capNodes.length) {
    const anchor = capNodes[capNodes.length - 1].id;
    for (const [id, list] of deps) {
      if (list.length === 0) { list.push(anchor); deps.set(id, list); }
    }
  }

  // approval gates: insert after the boundary, rewire its dependents.
  const approvalNodes = [];
  for (const g of (ir.approval_gates || [])) {
    const gid = 'approval-' + g.after;
    approvalNodes.push({ kind: 'approval', id: gid, after: g.after, gate: g, deps: [g.after] });
    for (const [id, list] of deps) {
      const at = list.indexOf(g.after);
      if (at !== -1 && id !== gid) list[at] = gid;
    }
  }

  // topological emission order for stable output
  const inDeg = new Map(ir.nodes.map(n => [n.id, 0]));
  const allIds = [...capNodes.map(n => n.id), ...ir.nodes.map(n => n.id), ...approvalNodes.map(n => n.id)];
  const effDeps = new Map([
    ...capNodes.map(n => [n.id, n.deps]),
    ...deps,
    ...approvalNodes.map(n => [n.id, n.deps]),
  ]);
  for (const [id, list] of effDeps) inDeg.set(id, list.length);
  const ready = allIds.filter(id => (effDeps.get(id) || []).length === 0);
  const emitted = [];
  while (ready.length) {
    ready.sort();
    const cur = ready.shift();
    emitted.push(cur);
    for (const id of allIds) {
      if ((effDeps.get(id) || []).includes(cur)) {
        const list = effDeps.get(id).filter(x => x !== cur);
        effDeps.set(id, list);
        if (list.length === 0) ready.push(id);
      }
    }
  }

  const byId = new Map([
    ...capNodes.map(n => [n.id, n]),
    ...ir.nodes.map(n => [n.id, { kind: n.execution_class, ...n }]),
    ...approvalNodes.map(n => [n.id, n]),
  ]);

  const lines = [];
  lines.push('# Compiled by rcos ir-compile from RCOS IR v0.1 — DO NOT HAND-EDIT.');
  lines.push('# Deterministic artifact: same IR + name => same bytes.');
  if (opts.sourceSha256) lines.push('# source IR sha256: ' + opts.sourceSha256);
  for (const c of metadataRefs) {
    lines.push('# capability_refs (role ' + c.role + ' — metadata only, NEVER executed as a node): ' + c.id + (c.version !== undefined ? '@' + c.version : '') + (c.invocation_id ? ' (authored-plan invocation_id ' + c.invocation_id + ')' : ''));
  }
  for (const c of executedRefs) {
    if (c.invocation_id) lines.push('# capability_refs ' + c.id + ' (role executed): authored-plan invocation_id ' + c.invocation_id + ' — the LIVE invocation id is minted by the rcos kernel at run time');
  }
  lines.push('name: rcos-ir-' + name);
  lines.push('version: "1"');
  blockLines('description', [
    'Compiled from RCOS IR v0.1. Mapping (partial by design): deterministic -> bash node,',
    'model -> prompt node (single lane in the workflow header), workflow -> archon workflow',
    'run, agent -> rejected at compile time; memory_scope run = $ARTIFACTS_DIR (others',
    'rejected); approval_gates -> fail-closed HITL nodes; capability_refs[executed] ->',
    "prelude 'rcos run' nodes (inputs = the run's JSON $ARGUMENTS).",
  ].join('\n'), 0, lines);
  lines.push('purpose: ' + yq(ir.objective));
  const lanes = new Set(ir.nodes.filter(n => n.execution_class === 'model').map(n => n.ref.lane));
  if (lanes.size === 1) {
    const [provider, ...rest] = [...lanes][0].split('/');
    lines.push('provider: ' + plain(provider));
    lines.push('model: ' + plain(rest.join('/')));
  } else {
    warnings.push('no single model lane: workflow header carries no provider/model (bash-only DAG)');
  }
  lines.push('routing:');
  lines.push('  category: rcos');
  lines.push('  tags:');
  lines.push('  - rcos-ir');
  lines.push('  - compiled');

  // eval: machine-checkable output presence; judgment criteria recorded, owned
  // by the capability's own eval per the IR spec ("defined before the run").
  const checkBody = ['set -eu'];
  for (const [oname, opath] of Object.entries(ir.outputs || {})) {
    const mapped = outputArtifactsPath(opath, warnings, oname);
    checkBody.push('test -s "$ARTIFACTS_DIR/' + mapped + '" || { echo "FAIL output \'' + oname + '\' missing: ' + mapped + '"; exit 1; }');
  }
  checkBody.push('echo "PASS: all declared IR outputs present"');
  if (Array.isArray(ir.acceptance)) {
    checkBody.push('# acceptance criteria (IR v0.1; judgment criteria are enforced by the owning eval):');
    for (const c of ir.acceptance) checkBody.push('# - ' + c);
  }
  lines.push('eval:');
  lines.push('  check_type: rcos_ir_check');
  lines.push('  pass:');
  for (const [oname] of Object.entries(ir.outputs || {})) lines.push('  - ' + yq('output \'' + oname + '\' present and non-empty in $ARTIFACTS_DIR'));
  lines.push('  fail:');
  lines.push('  - ' + yq('any declared IR output missing or empty'));
  blockLines('check', checkBody.join('\n'), 2, lines);

  lines.push('nodes:');
  for (const id of emitted) {
    const n = byId.get(id);
    emitNode(n, deps, lines);
  }

  return {
    ok: true,
    warnings,
    yaml: lines.join('\n') + '\n',
    meta: {
      name: 'rcos-ir-' + name,
      filename: 'rcos-ir-' + name + '.yaml',
      nodeCount: emitted.length,
      approvalCount: approvalNodes.length,
      executedCapabilityCount: capNodes.length,
    },
  };
}

function emitNode(n, deps, lines) {
  lines.push('- id: ' + n.id);
  const d = deps.get(n.id) || n.deps || [];
  if (d.length) lines.push('  depends_on: [' + d.join(', ') + ']');
  if (n.kind === 'cap') {
    const c = n.cap;
    lines.push('  description: ' + yq("IR capability_refs[executed] prelude: rcos run " + c.id + (c.version !== undefined ? '@' + c.version : '') + " — inputs are the run's JSON $ARGUMENTS; the kernel mints the live invocation id and eligibility is asked automatically"));
    lines.push('  type: bash');
    const s = slug(c.id);
    const body = [
      'set -euo pipefail',
      'RCOS_BIN="${RCOS_BIN:-$HOME/zcode-rcos/bin/rcos}"',
      'printf \'%s\' "${ARGUMENTS:-}" > "$ARTIFACTS_DIR/rcos-input-' + s + '.json"',
      'python3 -c \'import json,sys; json.load(open(sys.argv[1]))\' "$ARTIFACTS_DIR/rcos-input-' + s + '.json" || {',
      '  echo "cap-' + s + ': $ARGUMENTS is not valid JSON — pass the capability inputs as the run arguments" >&2',
      '  exit 2',
      '}',
      '"$RCOS_BIN" run ' + c.id + ' --input "$ARTIFACTS_DIR/rcos-input-' + s + '.json" --json > "$ARTIFACTS_DIR/rcos-invocation-' + s + '.json"',
    ].join('\n');
    blockLines('bash', body, 2, lines);
    lines.push('  timeout: 600000');
    return;
  }
  if (n.kind === 'approval') {
    lines.push('  description: ' + yq('IR approval gate after node ' + n.after + ' — fail-closed HITL: BLOCKED unless a human-dropped ~/.archon/approvals/<run_id>/APPROVAL.md (outside the LLM write path) grants release, or CHOW_AUTO_APPROVE=1'));
    lines.push('  type: bash');
    const body = [
      'set -euo pipefail',
      '# fail closed: purge anything the LLM may have staged in its own write path',
      'rm -f "$ARTIFACTS_DIR/APPROVAL.md"',
      'RUN_ID="$(basename "$ARTIFACTS_DIR")"',
      'APPROVAL="$HOME/.archon/approvals/$RUN_ID/APPROVAL.md"',
      'if [ "${CHOW_AUTO_APPROVE:-}" = "1" ]; then',
      '  echo "' + n.id + ': auto-approve via CHOW_AUTO_APPROVE=1 (env-gated, audited here)"',
      '  echo granted > "$ARTIFACTS_DIR/' + n.id + '.txt"',
      '  exit 0',
      'fi',
      'if [ -f "$APPROVAL" ] && grep -qiE \'granted|approved|approve\' "$APPROVAL"; then',
      '  echo "' + n.id + ': granted (human artifact at $APPROVAL)"',
      '  echo granted > "$ARTIFACTS_DIR/' + n.id + '.txt"',
      'else',
      '  echo "' + n.id + ': no human approval at $APPROVAL -> BLOCKED" >&2',
      '  echo blocked > "$ARTIFACTS_DIR/' + n.id + '.txt"',
      '  exit 2',
      'fi',
    ].join('\n');
    blockLines('bash', body, 2, lines);
    lines.push('  timeout: 15000');
    return;
  }
  if (n.kind === 'deterministic') {
    lines.push('  description: ' + yq('IR deterministic node (memory_scope: run) — ref executed verbatim; run memory is $ARTIFACTS_DIR'));
    lines.push('  type: bash');
    const body = ['set -euo pipefail', 'mkdir -p "$ARTIFACTS_DIR"', 'cd "$ARTIFACTS_DIR"', n.ref].join('\n');
    blockLines('bash', body, 2, lines);
    lines.push('  timeout: 600000');
    return;
  }
  if (n.kind === 'model') {
    lines.push('  description: ' + yq('IR model node — lane ' + n.ref.lane + ' (the single lane this workflow header carries)'));
    lines.push('  type: prompt');
    blockLines('prompt', n.ref.prompt, 2, lines);
    lines.push('  timeout: 900000');
    return;
  }
  if (n.kind === 'workflow') {
    lines.push('  description: ' + yq('IR workflow node — archon workflow run ' + n.ref.workflow + '; child run log at $ARTIFACTS_DIR/archon-child-' + n.id + '.log (extract the child run id from it for the trace)'));
    lines.push('  type: bash');
    const args = n.ref.inputs === undefined ? '' : ' ' + shellSingleQuote(JSON.stringify(n.ref.inputs));
    const body = [
      'set -euo pipefail',
      'archon workflow run ' + n.ref.workflow + args + ' > "$ARTIFACTS_DIR/archon-child-' + n.id + '.log" 2>&1',
    ].join('\n');
    blockLines('bash', body, 2, lines);
    lines.push('  timeout: 3600000');
    return;
  }
  throw new Error('emitNode: unhandled node kind ' + n.kind);
}

module.exports = {
  EXECUTION_CLASSES,
  MEMORY_SCOPES,
  REPRESENTABLE_SCOPES,
  CAPABILITY_ROLES,
  compileIR,
  validateIR,
  slug,
  slugFromObjective,
};
