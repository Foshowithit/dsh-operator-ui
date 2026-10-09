import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(packageDir, 'package.json'), 'utf8'));
const patch = await readFile(resolve(packageDir, 'cordis.patch.yml'), 'utf8');

function section(start, end) {
  const startAt = patch.indexOf(start);
  assert.notEqual(startAt, -1, `missing section marker ${start}`);
  const endAt = patch.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `missing section end marker ${end}`);
  return patch.slice(startAt, endAt);
}

const general = section('    - id: preset-general-idea\n', '    - id: preset-workflow-manager\n');
const workflowManager = section('    - id: preset-workflow-manager\n', '\n#');

test('the package is a loadable DSH bundle carrying its declarative seat presets', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(manifest.exports['./rcos-archon-adapter'], './lib/rcos-archon-adapter.js');
  assert.doesNotMatch(patch, /id: agent-preset-registry/, 'the base-owned registry stays editable from Agent preset settings');
  assert.match(patch, /id: preset-general-idea[\s\S]*?name: '@deepseek-ai\/dsh-agent-preset'[\s\S]*?id: general-idea/);
  assert.match(patch, /id: preset-workflow-manager[\s\S]*?name: '@deepseek-ai\/dsh-agent-preset'[\s\S]*?id: workflow-manager/);
});

test('General records intent, has one governed execution path, and no direct mutation or delegation surface', () => {
  assert.match(general, /name: 'dsh-seat-dispatch-2'/);
  assert.match(general, /record_routing_decision exactly once/);
  for (const intent of ['conversational', 'read_only_inquiry', 'clarification', 'procedural_handoff']) {
    assert.ok(general.includes(intent), `General routing instruction must include ${intent}`);
  }
  assert.match(general, /name: 'dsh-seat-dispatch-2\/tool-restriction'[\s\S]*?allow: \[\]/);
  for (const scoped of [
    '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-tool-skill',
    '@deepseek-ai/dsh-tool-todo',
    '@deepseek-ai/dsh-tool-web',
  ]) {
    assert.ok(general.includes(`name: '${scoped}'`), `General must compose scoped tool ${scoped}`);
  }
  assert.ok(general.includes("name: '@deepseek-ai/dsh-tool-ask-user'"), 'the scoped ask-user tool remains visible without a global allowlist entry');
  assert.match(general, /name: '@deepseek-ai\/dsh-tool-todo'[\s\S]*?allowParallelInProgress: false/);
  for (const forbidden of [
    '@deepseek-ai/dsh-tool-bash',
    '@deepseek-ai/dsh-tool-pwsh',
    "@deepseek-ai/dsh-tool-fs'",
    '@deepseek-ai/dsh-tool-subagent',
    '@deepseek-ai/dsh-tool-workflow',
    '@deepseek-ai/dsh-tool-goal',
    '@deepseek-ai/dsh-command-goal',
  ]) assert.ok(!general.includes(forbidden), `General must not compose ${forbidden}`);
  assert.ok(general.includes("name: '@deepseek-ai/dsh-tool-fs-search'"));
  assert.ok(general.includes("name: '@deepseek-ai/dsh-tool-web'"));
  assert.ok(general.includes('fetch: false'));
});

test('both seats compact automatically at 10% of each model window with proportional retention', () => {
  for (const [name, preset] of [['General', general], ['Workflow Manager', workflowManager]]) {
    const compaction = preset.slice(preset.indexOf('id: compaction\n'));
    assert.match(compaction, /auto: true/, `${name} compaction must be automatic`);
    assert.match(compaction, /headroomTokens: 8192/);
    assert.match(compaction, /maxTokens: 131072/);
    assert.match(compaction, /thresholdRatio: 0\.1/);
    assert.match(compaction, /retainRatio: 0\.04/);
    assert.doesNotMatch(compaction, /retainTokens:/, 'retained history must scale with the message budget');
    assert.doesNotMatch(compaction, /modelPolicies:/, 'the 10% policy must apply to every routed model');
  }
});

test('the RC.2 compaction engine accepts both seat policies and registers automatic pressure checks', async (t) => {
  const runtimeNodeModules = process.env.DSH_RUNTIME_NODE_MODULES;
  if (!runtimeNodeModules) {
    t.skip('set DSH_RUNTIME_NODE_MODULES to exercise the published RC.2 compaction engine');
    return;
  }

  const { BasicCompactionEngine } = await import(pathToFileURL(resolve(
    runtimeNodeModules,
    '@deepseek-ai/dsh-compaction-basic/lib/index.js',
  )).href);

  for (const [name, preset] of [['General', general], ['Workflow Manager', workflowManager]]) {
    const compactionStart = preset.indexOf("name: '@deepseek-ai/dsh-compaction-basic'");
    const compactionEnd = preset.indexOf("name: '@deepseek-ai/dsh-command-compact'", compactionStart);
    assert.notEqual(compactionStart, -1);
    assert.notEqual(compactionEnd, -1);
    const configText = preset.slice(compactionStart, compactionEnd);
    const number = (key) => {
      const match = configText.match(new RegExp(`\\b${key}:\\s*(\\d+(?:\\.\\d+)?)`));
      assert.ok(match, `${name} compaction config must define ${key}`);
      return Number(match[1]);
    };
    const events = [];
    const engine = new BasicCompactionEngine({
      reflect: { provide() {} },
      on(event) { events.push(event); },
    }, {
      headroomTokens: number('headroomTokens'),
      maxTokens: number('maxTokens'),
      thresholdRatio: number('thresholdRatio'),
      retainRatio: number('retainRatio'),
      compactionRetries: number('compactionRetries'),
      auto: /\bauto:\s*true\b/.test(configText),
    });

    assert.equal(engine.config.auto, true);
    assert.equal(engine.config.thresholdRatio, 0.1);
    assert.equal(engine.config.retainRatio, 0.04);
    assert.ok(events.includes('agent/pre-step'), `${name} must register the automatic pre-step pressure check`);

    for (const scenario of [
      { contextWindow: 1_000_000, nodeCount: 100, tokensPerNode: 1_000, expectedEnd: 60 },
      { contextWindow: 128_000, nodeCount: 20, tokensPerNode: 640, expectedEnd: 12 },
    ]) {
      const outputReservation = 8_192;
      const threshold = Math.floor(Math.min(
        scenario.contextWindow * 0.1,
        scenario.contextWindow - outputReservation - 8_192,
      ));
      let totalTokens = threshold - 1;
      const surfaceNodes = Array.from({ length: scenario.nodeCount }, (_, index) => index + 1);
      const session = {
        events: [],
        surface: { nodes: surfaceNodes, replaceGeneration: 0 },
        requestHeader: () => ({ config: { provider: 'probe', model: `window-${scenario.contextWindow}`, maxTokens: outputReservation } }),
        eventAt: (seq) => ({ seq, type: 'user/message' }),
      };
      const meter = {
        measure: () => ({
          totalTokens,
          nodes: surfaceNodes.map((seq) => ({ seq, tokens: scenario.tokensPerNode })),
        }),
      };
      const engine = new BasicCompactionEngine({
        reflect: { provide() {} },
        on() {},
        get() { return undefined; },
        tokenMeter: meter,
        llm: { resolveModelInfo: async () => ({ context: { contextWindow: scenario.contextWindow }, defaultMaxTokens: outputReservation }) },
      }, {
        headroomTokens: number('headroomTokens'),
        maxTokens: number('maxTokens'),
        thresholdRatio: number('thresholdRatio'),
        retainRatio: number('retainRatio'),
        compactionRetries: number('compactionRetries'),
        auto: true,
      });
      const compactedRanges = [];
      engine.compactRegion = async (start, end) => {
        compactedRanges.push({ start, end });
        totalTokens = threshold - 1;
        return { start, end };
      };
      const agent = { session };

      assert.equal(await engine.compactIfNeeded(agent, 'pressure'), null, `${name} must wait below the ${threshold}-token threshold`);
      assert.deepEqual(compactedRanges, []);
      totalTokens = threshold;
      assert.deepEqual(await engine.compactIfNeeded(agent, 'pressure'), { start: 1, end: scenario.expectedEnd }, `${name} should retain the 4% recent tail at ${scenario.contextWindow} tokens`);
      assert.deepEqual(compactedRanges, [{ start: 1, end: scenario.expectedEnd }]);
    }
  }
});

test('Workflow Manager can use scoped RCOS/Archon tools through native presentation and has no direct shell', () => {
  assert.match(workflowManager, /name: 'dsh-seat-dispatch-2\/tool-restriction'[\s\S]*?allow: \[\]/);
  assert.ok(!workflowManager.match(/^\s+- bash$/m), 'the Workflow Manager allowlist must not expose bash');
  assert.ok(!workflowManager.includes("name: '@deepseek-ai/dsh-tool-bash'"));
  assert.match(workflowManager, /name: 'dsh-seat-dispatch-2\/rcos-archon-adapter'[\s\S]*?sshTarget: chow@100\.111\.182\.5/);
  for (const workflow of ['chow-build-standard', 'chow-code-review', 'chow-test-v1', 'chow-qa-verify-v1', 'chow-verify-output-v1', 'chow-eval-gate-v2', 'chow-fix-loop', 'chow-planning-standard-v1', 'chow-ui-build', 'chow-research-search-v1']) {
    assert.ok(workflowManager.includes(`- ${workflow}`), `approved workflow ${workflow} should be visible to RCOS IR composition`);
  }
  assert.match(workflowManager, /name: '@deepseek-ai\/dsh-tool-todo'[\s\S]*?allowParallelInProgress: false/);
  assert.match(workflowManager, /name: '@deepseek-ai\/dsh-agent-tool-presentation'\n\s+config:\n\s+mode: native/);
  for (const forbidden of [
    'id: tool-seat-dispatch',
    '@deepseek-ai/dsh-tool-pwsh',
    "@deepseek-ai/dsh-tool-fs'",
    '@deepseek-ai/dsh-tool-subagent',
    '@deepseek-ai/dsh-tool-goal',
    '@deepseek-ai/dsh-command-goal',
  ]) assert.ok(!workflowManager.includes(forbidden), `Workflow Manager must not compose ${forbidden}`);
});

test('Workflow Manager does not expose user questions to its runtime-owned child seat', () => {
  assert.ok(!workflowManager.includes("name: '@deepseek-ai/dsh-tool-ask-user'"));
});
