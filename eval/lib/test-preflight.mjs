#!/usr/bin/env node
// eval/lib/test-preflight.mjs — NEGATIVE tests for the parity/freshness
// preflight (GPT requirement): deliberately mutate HEAD, model, hardware,
// runtime budget, and corpus hash — and prove each mismatch REFUSES.
// Run: node eval/lib/test-preflight.mjs   (exit 0 = all refusals proven)

import { runContext, assertParity, assertBaselineFresh, observeLive } from './experiment.mjs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const baseline = JSON.parse(await readFile(join(root, 'eval', 'baseline-config.json'), 'utf8'));
const ctx = await runContext({ lane: 'dsh' });
const live = await observeLive({ laneHome: '/tmp/opui-shakedown-dsh', budgetMs: baseline.budget.wall_ms_per_objective, corpusPath: join(root, 'eval', 'corpus-manifest.json') });

let failures = 0;
const expectRefuse = (name, fn) => {
  try {
    fn();
    console.log(`  ✗ ${name}: ACCEPTED (should have refused)`); failures += 1;
  } catch (e) {
    console.log(`  ✓ ${name}: refused — ${String(e.message).split('\n')[0].slice(0, 80)}`);
  }
};
const expectOk = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}: accepted (unmutated control)`);
  } catch (e) {
    console.log(`  ✗ ${name}: refused unexpectedly — ${String(e.message).split('\n')[0].slice(0, 80)}`); failures += 1;
  }
};

const LIVE = {
  model_endpoint: live.model_endpoint,
  model_id: live.model_id,
  model_sampling: live.model_sampling,
  hardware: live.hardware,
  corpus_hash: live.corpus_hash,
  budget: live.budget,
  tool_availability: { verdict: 'EQUIVALENT', explained: 'test' },
};

console.log('1. unmutated control (dsh lane):');
expectOk('parity accepts matching live state', () => assertParity(baseline, ctx, LIVE, { requiresModel: true }));

console.log('2. mutated model ID:');
expectRefuse('wrong model refuses', () => assertParity(baseline, ctx, { ...LIVE, model_id: 'wrong-model-9' }, { requiresModel: true }));

console.log('3. mutated HEAD (freshness):');
expectRefuse('stale HEAD refuses', () => assertBaselineFresh(baseline, 'sha-not-the-frozen-commit'));

console.log('4. mutated hardware:');
expectRefuse('different machine refuses', () => assertParity(baseline, ctx, { ...LIVE, hardware: { ...live.hardware, cpus: live.hardware.cpus + 97 } }, { requiresModel: true }));

console.log('5. mutated runtime budget:');
expectRefuse('different wall budget refuses', () => assertParity(baseline, ctx, { ...LIVE, budget: { wall_ms_per_objective: baseline.budget.wall_ms_per_objective + 1 } }, { requiresModel: true }));

console.log('6. mutated corpus hash:');
expectRefuse('drifted corpus refuses', () => assertParity(baseline, ctx, { ...LIVE, corpus_hash: 'sha256:deadbeef' }, { requiresModel: true }));

console.log('7. unresolved model lane (dsh requires model):');
{
  const b2 = JSON.parse(JSON.stringify(baseline));
  b2.model_lane = { endpoint: null, model_id: null, sampling: null };
  expectRefuse('null model lane refuses', () => assertParity(b2, ctx, LIVE, { requiresModel: true }));
}

console.log('8. rcos no-cognitive-model records ARCHITECTURAL (not a refusal):');
{
  const rows = assertParity(baseline, ctx, { no_cognitive_model: true, hardware: live.hardware, corpus_hash: live.corpus_hash, budget: live.budget, tool_availability: { verdict: 'EQUIVALENT', explained: 'deterministic pipeline' } }, { requiresModel: false });
  const arch = rows.filter((r) => r.verdict.startsWith('ARCHITECTURAL'));
  console.log(`  ✓ ${arch.length} model rows recorded as ARCHITECTURAL, ${rows.length - arch.length} rows SAME`);
}

if (failures) {
  console.log(`\nPREFLIGHT TESTS: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nPREFLIGHT TESTS: all refusals proven.');
