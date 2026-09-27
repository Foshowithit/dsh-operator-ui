import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const clientPath = new URL('../lib/client.js', import.meta.url);
const source = readFileSync(clientPath, 'utf8');

function loadAndApply() {
  let definition;
  let hookValues = [];
  let hookIndex = 0;
  const react = {
    Component: class Component {},
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useEffect() {}, useMemo(fn) { return fn(); }, useRef(value) { return { current: value }; },
    useState(initial) {
      const index = hookIndex++;
      if (!(index in hookValues)) hookValues[index] = typeof initial === 'function' ? initial() : initial;
      return [hookValues[index], (next) => { hookValues[index] = typeof next === 'function' ? next(hookValues[index]) : next; }];
    },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
  };
  const style = { setAttribute() {}, parentNode: null };
  const document = {
    head: { appendChild(node) { node.parentNode = this; }, removeChild(node) { node.parentNode = null; } },
    createElement() { return style; }, addEventListener() {}, removeEventListener() {},
  };
  const context = {
    window: { __ModuleLoader__: { load(value) { definition = value; } } }, document,
    console, setTimeout, clearTimeout,
    // The client has a module-owned refresh interval for unrelated surfaces;
    // this harness never mounts those surfaces and must not keep Node alive.
    setInterval() { return 0; }, clearInterval() {},
  };
  vm.runInNewContext(source, context, { filename: clientPath.pathname });
  const exports = definition.factory((name) => {
    if (name === 'react') return react;
    throw new Error('unexpected dependency: ' + name);
  });
  const entries = [];
  const disposers = [];
  const ctx = {
    slots: {
      inject(name, callback) { const dispose = callback(); return () => { dispose?.(); }; },
      register(spec, component) {
        const entry = { spec, component, removed: false };
        entries.push(entry);
        return () => { entry.removed = true; };
      },
    },
    effect(callback) { disposers.push(callback()); },
  };
  exports.apply(ctx);
  return {
    entries,
    dispose() { for (const dispose of disposers.splice(0)) dispose?.(); },
    render(component, props) { hookIndex = 0; return component(props); },
  };
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.children);
}

function find(node, predicate) {
  if (node == null) return null;
  if (Array.isArray(node)) { for (const item of node) { const found = find(item, predicate); if (found) return found; } return null; }
  if (typeof node !== 'object') return null;
  if (predicate(node)) return node;
  return find(node.children, predicate);
}

const args = JSON.stringify({ seat: 'wm', objective: 'Audit the workflow' });
const value = {
  ok: true, stage: 'complete', verdict: 'ship', detail: 'done', warnings: [],
  dispatch: {
    seat: 'wm', run_id: 'dispatch-1', seat_session_id: 'seat-1', caller_session_id: 'caller-1',
    caller_preset: 'general-idea', preset_source: 'session', caller_depth: 0,
    authority_basis: 'no-parent-root', turns_observed: 1, turn_started: true, duration_ms: 10,
    receipt_accepted: true, receipt_attempts: 1, receipt_refusals: 0, receipts_seen: 1,
    audit_log: '/tmp/seat-dispatch.jsonl', audit_error: 'none',
  },
  receipt: {
    verdict: 'ship', summary: 'Audited it', artifacts: ['/tmp/literal report.md'], evidence: ['check: PASS'], blockers: [],
    archon_run_id: 'none', archon_status: 'none', archon_artifact_dir: 'none', lane: 'provider/model', next: 'none',
  },
};
function toolBlock({ callId = 'call-1', value: result = value, argsRaw = args, text = null } = {}) {
  const wrapper = { operatorWm: { version: 1, callId, toolName: 'dispatch_seat', value: result } };
  return {
    kind: 'tool-result', callId, call: { name: 'dispatch_seat', argsRaw },
    content: [{ type: 'text', text: 'Seat reports a result.' }, { type: 'text', text: text ?? JSON.stringify(wrapper) }],
    isError: false,
  };
}

test('registers and disposes an additive keyed dispatch_seat tool view', () => {
  const app = loadAndApply();
  const wm = app.entries.find((entry) => entry.spec.name === 'tool.call.toolview' && entry.spec.key === 'dispatch_seat');
  assert.ok(wm, 'dispatch_seat uses the keyed tool-call renderer');
  assert.ok(app.entries.some((entry) => entry.spec.name === 'conversation.view' && entry.spec.id === 'runs'), 'existing Runs tab remains registered');
  assert.equal(typeof wm.component, 'function');
  app.dispose();
  assert.equal(wm.removed, true, 'plugin effect disposal removes the keyed renderer');
});

test('expansion reveals receipt claims and raw call/result disclosure; actions preserve exact identities', () => {
  const app = loadAndApply();
  const wm = app.entries.find((entry) => entry.spec.name === 'tool.call.toolview' && entry.spec.key === 'dispatch_seat');
  let inspected = 0;
  const opened = [];
  const props = { callId: 'call-1', toolName: 'dispatch_seat', block: toolBlock(), openFile: (path) => opened.push(path), inspect: () => inspected++ };
  let tree = app.render(wm.component, props);
  assert.match(textOf(tree), /Seat reports SHIP/);
  const toggle = find(tree, (node) => node.props?.className === 'opui-wm-toggle');
  assert.ok(toggle);
  toggle.props.onClick();
  tree = app.render(wm.component, props);
  const content = textOf(tree);
  assert.match(content, /Raw call and result/);
  assert.match(content, /Arguments/);
  assert.match(content, /Result/);
  assert.match(content, /Seat verdict · ship/);
  assert.doesNotMatch(content, /Verified|Independently verified/);
  const artifact = find(tree, (node) => node.type === 'button' && node.props?.className === 'opui-btn' && textOf(node) === '/tmp/literal report.md');
  assert.ok(artifact, 'artifact path is rendered literally as a button');
  artifact.props.onClick();
  assert.deepEqual(opened, ['/tmp/literal report.md']);
  const inspect = find(tree, (node) => node.type === 'button' && textOf(node) === 'Inspect in Trajectory');
  assert.ok(inspect);
  inspect.props.onClick();
  assert.equal(inspected, 1);
  app.dispose();
});

test('pending calls show no fabricated progress and non-WM seats retain their observed label', () => {
  const app = loadAndApply();
  const wm = app.entries.find((entry) => entry.spec.name === 'tool.call.toolview' && entry.spec.key === 'dispatch_seat');
  const pending = { kind: 'tool-call', callId: 'call-1', name: 'dispatch_seat', argsRaw: args };
  const pendingTree = app.render(wm.component, { callId: 'call-1', toolName: 'dispatch_seat', block: pending });
  assert.match(textOf(pendingTree), /wm/);
  assert.match(textOf(pendingTree), /Awaiting result/);
  assert.doesNotMatch(textOf(pendingTree), /%|\d+\s*\/\s*\d+|worker/i);
  const otherArgs = JSON.stringify({ seat: 'workflow-manager', objective: 'Review workflow' });
  const otherTree = app.render(wm.component, { callId: 'call-2', toolName: 'dispatch_seat', block: { ...pending, callId: 'call-2', argsRaw: otherArgs } });
  assert.match(textOf(otherTree), /workflow-manager/);
  app.dispose();
});

test('malformed or mismatched structured results remain visibly unavailable', () => {
  const app = loadAndApply();
  const wm = app.entries.find((entry) => entry.spec.name === 'tool.call.toolview' && entry.spec.key === 'dispatch_seat');
  for (const block of [
    toolBlock({ text: '{bad json' }),
    toolBlock({ text: JSON.stringify({ operatorWm: { version: 1, callId: 'other-call', toolName: 'dispatch_seat', value } }) }),
    toolBlock({ value: { ok: true } }),
  ]) {
    const tree = app.render(wm.component, { callId: 'call-1', toolName: 'dispatch_seat', block });
    assert.match(textOf(tree), /Result unavailable/);
  }
  app.dispose();
});

test('expanded receipt binds the exact DSH call id to dispatcher run and seat session ids', () => {
  const app = loadAndApply();
  const wm = app.entries.find((entry) => entry.spec.name === 'tool.call.toolview' && entry.spec.key === 'dispatch_seat');
  const treeProps = { callId: 'call-1', toolName: 'dispatch_seat', block: toolBlock() };
  let tree = app.render(wm.component, treeProps);
  find(tree, (node) => node.props?.className === 'opui-wm-toggle').props.onClick();
  tree = app.render(wm.component, treeProps);
  const content = textOf(tree);
  assert.match(content, /call-1/);
  assert.match(content, /dispatch-1/);
  assert.match(content, /seat-1/);
  assert.match(content, /call-1[\s\S]*(dispatch-1)[\s\S]*(seat-1)/);

  // A valid envelope from another tool invocation cannot lend its dispatch
  // identity to this row, even if the surrounding arguments are identical.
  const mismatchedProps = {
    callId: 'other-call', toolName: 'dispatch_seat',
    block: toolBlock({ callId: 'call-1' }),
  };
  let mismatched = app.render(wm.component, mismatchedProps);
  find(mismatched, (node) => node.props?.className === 'opui-wm-toggle').props.onClick();
  mismatched = app.render(wm.component, mismatchedProps);
  assert.match(textOf(mismatched), /Result unavailable/);
  assert.doesNotMatch(textOf(mismatched), /Dispatch · dispatch-1|Seat session · seat-1/);
  app.dispose();
});

test('dispatcher audit path and error are visible as inert text only', () => {
  const app = loadAndApply();
  const wm = app.entries.find((entry) => entry.spec.name === 'tool.call.toolview' && entry.spec.key === 'dispatch_seat');
  const opened = [];
  const props = {
    callId: 'call-1', toolName: 'dispatch_seat', block: toolBlock(),
    openFile: (path) => opened.push(path),
  };
  let tree = app.render(wm.component, props);
  find(tree, (node) => node.props?.className === 'opui-wm-toggle').props.onClick();
  tree = app.render(wm.component, props);
  const content = textOf(tree);
  assert.match(content, /\/tmp\/seat-dispatch\.jsonl/);
  assert.match(content, /Audit log/);
  assert.match(content, /Audit error/);
  const audit = find(tree, (node) => textOf(node).includes('/tmp/seat-dispatch.jsonl'));
  assert.ok(audit, 'audit receipt details are rendered');
  assert.notEqual(audit.type, 'button', 'audit path is inert text, not an open-file action');
  assert.equal(find(tree, (node) => node.type === 'button' && textOf(node).includes('/tmp/seat-dispatch.jsonl')), null);
  assert.deepEqual(opened, [], 'rendering the global audit path never opens it');
  app.dispose();
});

test('missing dispatcher identity fields cannot be presented as authoritative receipt details', () => {
  const app = loadAndApply();
  const wm = app.entries.find((entry) => entry.spec.name === 'tool.call.toolview' && entry.spec.key === 'dispatch_seat');
  for (const [field, invalid] of [
    ['run_id', undefined], ['seat_session_id', undefined],
    ['run_id', '   '], ['seat_session_id', '   '],
  ]) {
    const result = structuredClone(value);
    if (invalid === undefined) delete result.dispatch[field];
    else result.dispatch[field] = invalid;
    const props = {
      callId: 'call-1', toolName: 'dispatch_seat', block: toolBlock({ value: result }),
    };
    let tree = app.render(wm.component, props);
    find(tree, (node) => node.props?.className === 'opui-wm-toggle').props.onClick();
    tree = app.render(wm.component, props);
    assert.match(textOf(tree), /Result unavailable/);
    assert.doesNotMatch(textOf(tree), /Seat reports SHIP|Dispatch · dispatch-1|Seat session · seat-1/);
  }
  app.dispose();
});
