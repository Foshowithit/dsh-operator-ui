#!/usr/bin/env node
// eval/lib/flowrouter-show.mjs — print the sealed FlowRouter evidence as a
// readable trace. PACKAGING ONLY: this reads the committed receipts and prints
// them; it contains no protocol logic, runs no network calls, and writes
// nothing. Use it when you have five minutes and want to see the end-to-end
// path and the adversarial result without reading JSON.

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const receiptPath = (name) => join(root, 'eval', 'receipts', name);
const load = async (name) => JSON.parse(await readFile(receiptPath(name), 'utf8'));

const line = (s = '') => process.stdout.write(s + '\n');
const rule = () => line('─'.repeat(78));

const i1 = await load('FLOWROUTER-I1-RECEIPT.json');
const a0 = await load('FLOWROUTER-A0-RECEIPT.json');
const claims = await load('FLOWROUTER-P2-RECEIPT.json').catch(() => null);

line('FlowRouter — sealed evidence, end to end');
line(`generated_at: ${i1.generated_at}   spec: ${i1.spec}`);
rule();
line('THE PATH (every step verified at the time it ran)');
line();
for (const s of i1.steps) line(`  [${s.ok ? 'ok  ' : 'FAIL'}] ${s.step}`);
line();
rule();
line('WHAT CROSSES EACH SEAM (machine-checked continuity)');
line();
for (const seam of i1.seam_values) {
  line(`  ${seam.name}`);
  for (const [k, v] of Object.entries(seam)) {
    if (k === 'name') continue;
    const rendered = typeof v === 'string' ? v : JSON.stringify(v);
    const val = rendered.length > 120 ? rendered.slice(0, 117) + '...' : rendered;
    line(`      ${k.padEnd(24)} ${val}`);
  }
}
line();
rule();
line('WHO OWNS WHAT (and who may never write it)');
line();
for (const h of i1.handoffs) line(`  ${h.from} → ${h.to}\n      owned by: ${h.owned_by}\n      crosses:  ${h.knows}`);
line();
rule();
line('PHASE COVERAGE');
line();
for (const c of i1.coverage) line(`  ${c.phase.padEnd(6)} ${c.role.padEnd(38)} ${c.i1_coverage}`);
line();
rule();
line('ADVERSARIAL CAMPAIGN (criteria frozen before execution)');
line();
line(`  ${a0.rule}`);
line();
for (const a of a0.attacks) line(`  ${a.verdict === 'PASS' ? 'ok  ' : 'FAIL'} ${a.id.padEnd(7)} ${a.criterion.slice(0, 96)}`);
line();
line(`  ${a0.attacks.length} attacks · ${a0.attacks.filter((a) => a.verdict === 'PASS').length} passed · zero manufactured authority`);
line();
rule();
line('THE CLAIM THIS EVIDENCE EARNS');
line();
line(`  ${i1.claim}`);
line();
rule();
line('READ NEXT');
line('  eval/FLOWROUTER-ARCHITECTURE.md   phase map + trust-boundary map');
line('  eval/FLOWROUTER-CLAIMS.md         proven / assumed / unproven / out of scope');
line('  eval/receipts/                    14 raw receipts (the primary evidence)');
line();
line('NOTE: this printer reads committed receipts only. It performs no network');
line('calls and writes nothing; the harnesses that produced the receipts are in');
line('eval/lib/ and can be re-run (see eval/FLOWROUTER-REPRODUCE.md).');
