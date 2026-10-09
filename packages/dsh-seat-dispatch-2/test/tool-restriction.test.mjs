import assert from 'node:assert/strict';
import test from 'node:test';
import { Config, apply, inject, name } from '../lib/tool-restriction.js';

test('restriction denies every global tool outside the seat allowlist', () => {
  const allow = ['glob', 'web_search'];
  const calls = [];
  const config = new Config({ allow });
  apply({ tools: {
    schemas: () => ['bash', 'glob', 'edit', 'web_search', 'new_host_tool', 'run_code'].map((name) => ({ name })),
    restrict: (filter) => calls.push(filter),
  } }, config);

  assert.equal(name, 'tool-restriction');
  assert.deepEqual(inject, ['tools']);
  assert.deepEqual(calls, [{ deny: ['bash', 'edit', 'new_host_tool'] }]);
});

test('restriction rejects seat allowlist names absent from the host-global registry', () => {
  const calls = [];
  const tools = {
    schemas: () => [{ name: 'glob' }],
    restrict: (filter) => calls.push(filter),
  };
  assert.throws(() => apply({ tools }, new Config({ allow: ['dispatch_seat'] })), /not a registered global tool/);
  assert.deepEqual(calls, []);
});

test('empty allowlist denies every host-global tool while excluding the PTC transport', () => {
  const calls = [];
  const tools = {
    schemas: () => ['bash', 'web_search', 'run_code'].map((name) => ({ name })),
    restrict: (filter) => calls.push(filter),
  };
  apply({ tools }, new Config({ allow: [] }));
  assert.deepEqual(calls, [{ deny: ['bash', 'web_search'] }]);
});

test('duplicate allowlists fail closed', () => {
  assert.throws(() => apply({ tools: { restrict() { assert.fail('duplicate allowlist reached the registry'); } } }, new Config({ allow: ['grep', 'grep'] })), /must not contain duplicates/);
});
