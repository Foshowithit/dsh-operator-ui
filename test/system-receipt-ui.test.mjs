import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const clientPath = new URL('../lib/client.js', import.meta.url);
const source = readFileSync(clientPath, 'utf8');

function loadClient() {
  let definition;
  const context = {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    document: { createElement() { return { setAttribute() {}, parentNode: null }; }, head: { appendChild() {} } },
    setInterval() { return 0; }, clearInterval() {}, setTimeout, clearTimeout, console,
  };
  vm.runInNewContext(source, context, { filename: clientPath.pathname });
  const react = {
    Component: class Component {}, createElement() {}, useEffect() {}, useMemo(fn) { return fn(); },
    useRef(value) { return { current: value }; }, useState(value) { return [value, () => {}]; },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
  };
  return definition.factory((name) => {
    if (name === 'react') return react;
    throw new Error('unexpected dependency: ' + name);
  });
}

const receipt = (achieved, extra = {}) => ({
  createdAt: '2026-09-28T12:00:00.000Z',
  ...(achieved === undefined ? {} : { levels: { achieved } }),
  ...extra,
});

test('fresh receipt headlines distinguish RCOS execution from system verification', () => {
  const { projectSystemReceiptHeadline } = loadClient();
  const rcos = projectSystemReceiptHeadline({ state: 'VALID', receipt: receipt('RCOS_VERIFIED') });
  assert.equal(rcos.title, '✓ RCOS verified');
  assert.match(rcos.subtitle, /Core execution path verified/);
  assert.doesNotMatch(rcos.subtitle, /NaN|undefined/);

  const system = projectSystemReceiptHeadline({ state: 'VALID', receipt: receipt('SYSTEM_VERIFIED') });
  assert.equal(system.title, 'System verified');
  assert.match(system.subtitle, /RCOS execution is not verified/);
  assert.equal(system.claimsCoreExecution, false);

  for (const achieved of ['NOT_VERIFIED', undefined, 'FUTURE_RUNG']) {
    const projection = projectSystemReceiptHeadline({ state: 'VALID', receipt: receipt(achieved) });
    assert.notEqual(projection.title, '✓ RCOS verified');
    assert.match(projection.subtitle, /Core execution is not verified/);
    assert.equal(projection.claimsCoreExecution, false);
  }
});

test('failure codes are preserved as literal projection text', () => {
  const { projectSystemReceiptHeadline } = loadClient();
  const projection = projectSystemReceiptHeadline({
    state: 'VALID', receipt: receipt('SYSTEM_VERIFIED', { failureCodes: ['archon-unavailable', 'seed-path-skipped'] }),
  });
  assert.deepEqual(Array.from(projection.failureCodes), ['archon-unavailable', 'seed-path-skipped']);
  const hostile = projectSystemReceiptHeadline({
    state: 'VALID', receipt: receipt('SYSTEM_VERIFIED', { failureCodes: ['<img src=x onerror=alert(1)>'] }),
  });
  assert.deepEqual(Array.from(hostile.failureCodes), ['<img src=x onerror=alert(1)>'],
    'failure codes remain literal text values for the UI to render as text');
});

test('missing receipt and misplaced verification fields cannot claim execution', () => {
  const { projectSystemReceiptHeadline } = loadClient();
  for (const rec of [null, {}, { achieved: 'RCOS_VERIFIED' }, { decision: 'RCOS_VERIFIED' }]) {
    const projection = projectSystemReceiptHeadline({ state: 'VALID', receipt: rec });
    assert.equal(projection.claimsCoreExecution, false);
    assert.equal(projection.title, 'Not verified yet');
  }
});

test('RCOS success remains accurate when receipt time is absent or malformed', () => {
  const { projectSystemReceiptHeadline } = loadClient();
  for (const createdAt of [undefined, 'not-a-date']) {
    const rec = receipt('RCOS_VERIFIED');
    if (createdAt === undefined) delete rec.createdAt;
    else rec.createdAt = createdAt;
    const projection = projectSystemReceiptHeadline({ state: 'VALID', receipt: rec });
    assert.equal(projection.claimsCoreExecution, true);
    assert.match(projection.subtitle, /Core execution path verified\./);
    assert.doesNotMatch(projection.subtitle, /NaN|undefined/);
  }
});

test('stale, tampered, missing, and unsealed receipt states never become success', () => {
  const { projectSystemReceiptHeadline } = loadClient();
  for (const [state, title] of [
    ['STALE', 'RCOS verification is stale'],
    ['TAMPERED', 'Receipt was modified after sealing'],
    ['NONE', 'Not verified yet'],
    ['UNSEALED', 'Not verified yet'],
  ]) {
    const projection = projectSystemReceiptHeadline({ state, receipt: receipt('RCOS_VERIFIED') });
    assert.equal(projection.title, title);
    assert.equal(projection.claimsCoreExecution, false);
  }
});

test('system surface, nav badge, and genesis card render the shared receipt projection', () => {
  assert.match(source, /const hero = projectSystemReceiptHeadline\(vr, optionalDown\.length\)/);
  assert.match(source, /hero\.title/);
  assert.match(source, /hero\.subtitle/);
  assert.match(source, /const receiptHeadline = projectSystemReceiptHeadline\(vr\)/);
  assert.match(source, /receiptHeadline\.claimsCoreExecution/);
  assert.match(source, /const verifiedHeadline = projectSystemReceiptHeadline\(vr\)/);
  assert.match(source, /verifiedHeadline\.title/);
  assert.match(source, /verifiedHeadline\.subtitle/);
  assert.doesNotMatch(source, /'RCOS VERIFIED'[),]/);
  assert.doesNotMatch(source, /'Real execution completed through Archon\. This installation is sealed and verified\.'/);
});
