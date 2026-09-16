#!/usr/bin/env node
// eval/lib/acquire-v2-forensics.mjs — Capability Acquisition v2, step 1 (GPT):
// decompose the 16 failed acquisitions into failure classes BEFORE changing
// the acquisition loop.
//
// For each failed candidate workflow (still on disk in the Archon workflows
// dir): deploy its family fixture into the execution workspace, run the
// candidate on real Archon, then apply the family grader against BOTH the
// evidence text and the post-run workspace artifacts — distinguishing:
//   execution-error        the workflow crashed / never completed
//   artifact-correct       output correct in the workspace → the scored-run
//                          failure was a GRADER LOCATION defect, not the
//                          candidate (reclassifiable)
//   wrong-output           ran but produced wrong substance
//   format-mismatch        substance present, line format differs

import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF_DIR = '/tmp/opui-rc0-archon/workflows';
const WORKSPACE = '/private/tmp/opui-rc0-folder';
const ARCHON = 'http://127.0.0.1:13091';

// Failed candidates by family (from the scored run's refusal log; one
// representative candidate each — the latest generation per family).
const FAILED = [
  { family: 'F04-line-transform', yaml: 'clean-list-sort-v0-1-0.yaml', enc: 1 },
  { family: 'F04-line-transform', yaml: 'cleanup-list-txt-v0-1-0.yaml', enc: 1 },
  { family: 'F01-text-stats-workspace', yaml: 'count-txt-totals-v0-1-0.yaml', enc: 1 },
  { family: 'F01-text-stats-workspace', yaml: 'count-txt-lines-words-bytes-v0-1-0.yaml', enc: 1 },
  { family: 'F08-format-conversion', yaml: 'stock-csv-to-json-v0-1-0.yaml', enc: 1 },
  { family: 'F08-format-conversion', yaml: 'convert-stock-csv-to-json-v0-1-0.yaml', enc: 1 },
  { family: 'F02-repository-inspection', yaml: 'repository-inventory-v0-1-0.yaml', enc: 1 },
  { family: 'F02-repository-inspection', yaml: 'inventory-repository-v0-1-0.yaml', enc: 1 },
  { family: 'F05-validation-gate', yaml: 'validate-release-manifest-v0-1-0.yaml', enc: 1 },
  { family: 'F06-release-prep', yaml: 'prepare-release-evidence-v0-1-0.yaml', enc: 1 },
  { family: 'F06-release-prep', yaml: 'release-evidence-collector-v0-1-0.yaml', enc: 1 },
  { family: 'F07-duplicate-report', yaml: 'duplicate-emails-report-v0-1-0.yaml', enc: 1 },
  { family: 'F07-duplicate-report', yaml: 'email-duplicate-reporter-v0-1-0.yaml', enc: 1 },
  { family: 'F10-dependency-audit', yaml: 'compare-package-dependencies-v0-1-0.yaml', enc: 1 },
  { family: 'F10-dependency-audit', yaml: 'package-dependency-lock-compare-v0-1-0.yaml', enc: 1 },
];

async function readOpt(p) { try { return await readFile(p, 'utf8'); } catch { return null; } }

// Family graders against POST-RUN WORKSPACE artifacts + evidence.
async function gradeF04(workspace, expected) {
  const body = await readFile(join(workspace, expected.file), 'utf8').catch(() => null);
  const lines = body ? body.replace(/\n+$/, '').split('\n') : null;
  const ok = !!lines && JSON.stringify(lines) === JSON.stringify(expected.sorted);
  return { ok, detail: ok ? 'sorted.txt correct (in workspace)' : `sorted.txt ${body === null ? 'MISSING from workspace' : 'content wrong'}` };
}
async function gradeF08(workspace, expected) {
  const body = await readFile(join(workspace, 'stock.json'), 'utf8').catch(() => null);
  let arr = null; try { arr = JSON.parse(body); } catch {}
  const ok = !!arr && JSON.stringify(arr) === JSON.stringify(expected.json);
  return { ok, detail: ok ? 'stock.json correct (in workspace)' : `stock.json ${body === null ? 'MISSING from workspace' : 'content wrong'}` };
}
async function gradeF01(_w, expected, evidence) {
  const t = expected.total;
  const m = evidence && evidence.match(/TOTAL Lines: (\d+) Words: (\d+) Bytes: (\d+)/);
  const ok = !!m && Number(m[1]) === t.lines && Number(m[2]) === t.words && Number(m[3]) === t.bytes;
  return { ok, detail: ok ? 'totals correct' : (m ? `totals wrong (${m[0]})` : 'no TOTAL line') };
}

const GRADERS = { 'F04-line-transform': gradeF04, 'F08-format-conversion': gradeF08, 'F01-text-stats-workspace': gradeF01 };

async function main() {
  const out = [];
  for (const f of FAILED) {
    const yamlPath = join(WF_DIR, f.yaml);
    let yaml;
    try { yaml = await readFile(yamlPath, 'utf8'); } catch { out.push({ ...f, class: 'candidate-file-lost' }); continue; }
    const nameMatch = yaml.match(/^name:\s*(\S+)/m);
    const wfName = nameMatch ? nameMatch[1] : f.yaml.replace(/\.yaml$/, '');
    const objective = (await readFile(join(root, 'eval', 'corpus', f.family, `encounter-${f.enc}`, 'objective.txt'), 'utf8')).trim();
    const expected = JSON.parse(await readFile(join(root, 'eval', 'corpus', f.family, `encounter-${f.enc}`, 'expected.json'), 'utf8'));

    // fixture reset into the execution workspace
    await rm(WORKSPACE, { recursive: true, force: true });
    await mkdir(WORKSPACE, { recursive: true });
    execFileSync('cp', ['-R', join(root, 'eval', 'corpus', f.family, `encounter-${f.enc}`, 'workspace') + '/.', WORKSPACE + '/']);

    // dispatch candidate
    let accepted = true;
    try {
      const res = await fetch(ARCHON + '/api/workflows/' + encodeURIComponent(wfName) + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'forensic replay', conversationId: 'acq-v2-forensics-' + Date.now() }) });
      accepted = res.ok;
    } catch { accepted = false; }
    if (!accepted) { out.push({ ...f, wfName, class: 'dispatch-failed' }); continue; }
    await new Promise((r) => setTimeout(r, 7000));
    let lb = {};
    try { lb = await (await fetch(ARCHON + '/api/workflows/runs?limit=15')).json(); } catch {}
    const run = (lb.runs || []).find((x) => x.workflow_name === wfName);
    if (!run) { out.push({ ...f, wfName, class: 'run-not-found' }); continue; }
    const rd = await (await fetch(ARCHON + '/api/workflows/runs/' + run.id)).json();
    const status = (rd.run || {}).status;
    const evidence = ((rd.events || []).map((e) => (e.data || {}).node_output || (e.data || {}).output).filter(Boolean)).join('\n');

    const g = GRADERS[f.family]; // family-specific
    if (!g) { out.push({ ...f, wfName, runStatus: status, class: 'needs-grader', evidence: evidence.slice(0, 150) }); continue; }
    const verdict = await g(WORKSPACE, expected, evidence);
    let cls;
    if (status !== 'completed') cls = 'execution-error';
    else if (verdict.ok) cls = 'artifact-correct-was-misgraded';
    else if ((verdict.detail || '').includes('MISSING from workspace')) cls = 'artifact-written-elsewhere-or-not-written';
    else cls = 'wrong-output';
    out.push({ family: f.family, wfName, runStatus: status, class: cls, grader: verdict.detail });
  }
  console.log(JSON.stringify(out, null, 1));
  await writeFile(join(root, 'eval', 'ACQ-V2-FORENSICS.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  const byClass = {};
  for (const o of out) byClass[o.class] = (byClass[o.class] || 0) + 1;
  console.log('classes:', JSON.stringify(byClass));
}

main().catch((e) => { console.error(e); process.exit(1); });
