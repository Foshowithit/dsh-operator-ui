'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const IRC = require('../lib/ir-compile');

/* The IR below is the spec's own minimal example (~/chow-work/rcos/ir-v0.1.md),
 * with the model lane filled in and refs made deployment-absolute — the shape
 * a reuse plan must take before it may compile. */
function goodIR() {
  return {
    objective: 'Reconcile ledger-A against statement-B using cap:reconcile-v3',
    inputs: { ledger: 'fixtures/ledger.json', statement: 'fixtures/statement.json' },
    outputs: { report: 'artifacts/RECONCILIATION.json' },
    acceptance: ['reconciled totals match to the cent', 'every unmatched line cited with id + amount'],
    nodes: [
      {
        id: 'reconcile', execution_class: 'deterministic',
        ref: 'python3 $HOME/caps/reconcile-v3/tools/reconcile.py',
        depends_on: [], memory_scope: 'run',
      },
      {
        id: 'review-gate', execution_class: 'model',
        ref: { lane: 'pi/glm-4.7', prompt: 'confirm no unmatched line lacks a citation' },
        depends_on: ['reconcile'], memory_scope: 'run',
      },
    ],
    memory: { workdir: 'run-artifacts/<run-id>/', promotion: 'inbox-then-standing' },
    approval_gates: [],
    capability_refs: [{ id: 'reconcile-v3', version: 2, role: 'executed', invocation_id: 'run-041-invocation-1' }],
  };
}

test('compiles the spec-minimal reuse plan', () => {
  const res = IRC.compileIR(goodIR());
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.match(res.yaml, /^name: rcos-ir-/m);
  assert.match(res.yaml, /^purpose: 'Reconcile ledger-A/m);
  assert.match(res.yaml, /^provider: pi$/m);
  assert.match(res.yaml, /^model: glm-4\.7$/m);
  assert.match(res.meta.filename, /^rcos-ir-.*\.yaml$/);
  assert.equal(res.meta.executedCapabilityCount, 1);
});

test('executed capability ref becomes a prelude rcos run node; entry nodes anchor to it', () => {
  const res = IRC.compileIR(goodIR());
  assert.match(res.yaml, /- id: cap-reconcile-v3/);
  assert.match(res.yaml, /"\$RCOS_BIN" run reconcile-v3 --input "\$ARTIFACTS_DIR\/rcos-input-reconcile-v3\.json"/);
  // 'reconcile' had an empty depends_on: it must now wait on the prelude
  const rec = res.yaml.split('- id: reconcile\n')[1].split('\n- id:')[0];
  assert.match(rec, /depends_on: \[cap-reconcile-v3\]/);
  // prelude runs before reconcile in emission order
  assert.ok(res.yaml.indexOf('- id: cap-reconcile-v3') < res.yaml.indexOf('- id: reconcile'));
});

test('composed/dependency refs are metadata comments, never nodes', () => {
  const ir = goodIR();
  ir.capability_refs.push({ id: 'report-render-v1', role: 'composed' });
  const res = IRC.compileIR(ir);
  assert.match(res.yaml, /# capability_refs \(role composed — metadata only, NEVER executed as a node\): report-render-v1/);
  assert.doesNotMatch(res.yaml, /- id: cap-report-render-v1/);
});

test('deterministic node emits ref verbatim under cd $ARTIFACTS_DIR', () => {
  const res = IRC.compileIR(goodIR());
  const rec = res.yaml.split('- id: reconcile\n')[1].split('\n- id:')[0];
  assert.match(rec, /bash: \|/);
  assert.match(rec, /cd "\$ARTIFACTS_DIR"/);
  assert.match(rec, /python3 \$HOME\/caps\/reconcile-v3\/tools\/reconcile\.py/);
});

test('model node emits a prompt block; two lanes is a compile error', () => {
  const res = IRC.compileIR(goodIR());
  const rg = res.yaml.split('- id: review-gate\n')[1].split('\n- id:')[0];
  assert.match(rg, /type: prompt/);
  assert.match(rg, /prompt: \|/);
  assert.match(rg, /confirm no unmatched line lacks a citation/);

  const ir = goodIR();
  ir.nodes.push({
    id: 'second-opinion', execution_class: 'model',
    ref: { lane: 'pi/kimi-k3', prompt: 'sanity-check the totals' },
    depends_on: ['review-gate'], memory_scope: 'run',
  });
  const bad = IRC.compileIR(ir);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /ONE lane|different lanes/);
});

test('agent execution_class is a documented compile error', () => {
  const ir = goodIR();
  ir.nodes.push({ id: 'free-agent', execution_class: 'agent', ref: 'spec-name', depends_on: [], memory_scope: 'run' });
  const res = IRC.compileIR(ir);
  assert.equal(res.ok, false);
  assert.match(res.errors.join('\n'), /'agent' has no native Archon node type/);
});

test('memory_scope beyond run is a documented compile error', () => {
  const ir = goodIR();
  ir.nodes[1].memory_scope = 'turn';
  const res = IRC.compileIR(ir);
  assert.equal(res.ok, false);
  assert.match(res.errors.join('\n'), /memory_scope 'turn' is not representable/);
});

test('duplicate ids, unknown depends_on, self-dependency, cycles are errors', () => {
  const dup = goodIR(); dup.nodes.push({ ...dup.nodes[0] });
  assert.match(IRC.compileIR(dup).errors.join('\n'), /duplicate id/);

  const unknown = goodIR(); unknown.nodes[1].depends_on = ['ghost'];
  assert.match(IRC.compileIR(unknown).errors.join('\n'), /unknown node 'ghost'/);

  const self = goodIR(); self.nodes[0].depends_on = ['reconcile'];
  assert.match(IRC.compileIR(self).errors.join('\n'), /depends_on itself/);

  const cyc = goodIR(); cyc.nodes[0].depends_on = ['review-gate'];
  assert.match(IRC.compileIR(cyc).errors.join('\n'), /cycle/);
});

test('workflow node emits archon workflow run with JSON-quoted inputs', () => {
  const ir = goodIR();
  ir.nodes.push({
    id: 'render', execution_class: 'workflow',
    ref: { workflow: 'chow-render-v2', inputs: { style: 'minimal', pages: 2 } },
    depends_on: ['review-gate'], memory_scope: 'run',
  });
  const res = IRC.compileIR(ir);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  const rn = res.yaml.split('- id: render\n')[1].split('\n- id:')[0];
  assert.match(rn, /archon workflow run chow-render-v2 '\{"style":"minimal","pages":2\}' > "\$ARTIFACTS_DIR\/archon-child-render\.log"/);
});

test('approval gate compiles fail-closed and rewires dependents', () => {
  const ir = goodIR();
  ir.nodes.push({
    id: 'publish', execution_class: 'deterministic',
    ref: 'cp $ARTIFACTS_DIR/RECONCILIATION.json $ARTIFACTS_DIR/published.json',
    depends_on: ['review-gate'], memory_scope: 'run',
  });
  ir.approval_gates = [{ after: 'review-gate', decisions: ['approve', 'rework'] }];
  const res = IRC.compileIR(ir);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.match(res.yaml, /- id: approval-review-gate/);
  assert.match(res.yaml, /rm -f "\$ARTIFACTS_DIR\/APPROVAL\.md"/);
  assert.match(res.yaml, /CHOW_AUTO_APPROVE/);
  assert.match(res.yaml, /exit 2/);
  // 'publish' must now depend on the gate, not on the boundary node directly
  const pub = res.yaml.split('- id: publish\n')[1].split('\n- id:')[0];
  assert.match(pub, /depends_on: \[approval-review-gate\]/);
  // rework decision is recorded but warned: v0 is approve-or-block
  assert.match(res.warnings.join('\n'), /approve-or-block only/);
});

test('outputs map artifacts/ to $ARTIFACTS_DIR and land in eval.check', () => {
  const res = IRC.compileIR(goodIR());
  assert.match(res.yaml, /test -s "\$ARTIFACTS_DIR\/RECONCILIATION\.json" \|\| \{ echo "FAIL output 'report' missing: RECONCILIATION\.json"; exit 1; \}/);
  assert.match(res.yaml, /check_type: rcos_ir_check/);
  assert.match(res.warnings.join('\n'), /mapped to \$ARTIFACTS_DIR\/RECONCILIATION\.json/);
  // acceptance criteria are recorded, not silently dropped
  assert.match(res.yaml, /# - reconciled totals match to the cent/);
});

test('objective/acceptance/outputs are required', () => {
  const noObj = goodIR(); delete noObj.objective;
  assert.match(IRC.compileIR(noObj).errors.join('\n'), /objective/);
  const noAcc = goodIR(); noAcc.acceptance = [];
  assert.match(IRC.compileIR(noAcc).errors.join('\n'), /acceptance/);
  const noOut = goodIR(); noOut.outputs = 'nope';
  assert.match(IRC.compileIR(noOut).errors.join('\n'), /outputs/);
});

test('compile is deterministic and never mutates the input IR', () => {
  const ir = goodIR();
  const snapshot = JSON.stringify(ir);
  const a = IRC.compileIR(ir, { name: 'reconcile-demo' });
  const b = IRC.compileIR(ir, { name: 'reconcile-demo' });
  assert.equal(a.yaml, b.yaml);
  assert.equal(JSON.stringify(ir), snapshot);
});

test('name must be a lowercase slug; bad lane shapes are errors', () => {
  assert.match(IRC.compileIR(goodIR(), { name: 'Bad Name' }).errors.join('\n'), /name 'Bad Name'/);
  const ir = goodIR();
  ir.nodes[1].ref = { lane: 'no-slash', prompt: 'x' };
  assert.match(IRC.compileIR(ir).errors.join('\n'), /ref\.lane must look like provider\/modelid/);
});

test('no model nodes: header carries no provider/model, warning says so', () => {
  const ir = goodIR();
  ir.nodes = [ir.nodes[0]];
  const res = IRC.compileIR(ir);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.doesNotMatch(res.yaml, /^provider:/m);
  assert.match(res.warnings.join('\n'), /no single model lane/);
});

test('CLI: unreadable JSON exits 2; agent-class IR exits 3', () => {
  const bin = path.join(__dirname, '..', 'bin', 'rcos');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcos-irc-'));
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  let rc = -1;
  try { execFileSync(process.execPath, [bin, 'ir-compile', '--ir', bad], { stdio: 'pipe' }); } catch (e) { rc = e.status; }
  assert.equal(rc, 2);

  const agent = path.join(tmp, 'agent.json');
  const ir = goodIR();
  ir.nodes.push({ id: 'free-agent', execution_class: 'agent', ref: 'spec-name', depends_on: [], memory_scope: 'run' });
  fs.writeFileSync(agent, JSON.stringify(ir));
  rc = -1;
  try { execFileSync(process.execPath, [bin, 'ir-compile', '--ir', agent], { stdio: 'pipe' }); } catch (e) { rc = e.status; }
  assert.equal(rc, 3);

  const good = path.join(tmp, 'good.json');
  fs.writeFileSync(good, JSON.stringify(goodIR()));
  const out = path.join(tmp, 'out.yaml');
  const stdout = execFileSync(process.execPath, [bin, 'ir-compile', '--ir', good, '--name', 'demo', '--out', out], { encoding: 'utf8' });
  assert.match(stdout, /compiled rcos-ir-demo -> /);
  assert.ok(fs.statSync(out).size > 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});
