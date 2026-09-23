// P6E — execution admission: a SHIP-verified goal envelope becomes a
// registry capability through ONE explicit, evidence-derived write. This is
// the registry's third and only new writer (teach promotion, flowrouter
// import admission, execution admission) — dispatch never touches the
// registry, and this module never touches the reconciling task read path:
// the stored envelope is read directly so a read stays a read (the store is
// byte-unchanged by every refusal AND by the happy path). Every entry field
// is derived from the STORED envelope; the caller supplies only requires
// (validated against the envelope's own granted authority), description and
// typed tags. Admission can NARROW authority — never widen it.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveConfig, getDshHome } from './config.js';
import { requiresOf } from './authority.js';
import { BRIDGE_ID_RE } from './bridge-receipt.js';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isoNow = () => new Date().toISOString();

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const TAG_RE = /^[a-z0-9][a-z0-9-]*$/;

async function storedGoal(taskId) {
  try {
    const raw = await readFile(join(getDshHome(), 'operator-ui', 'tasks.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const tasks = parsed && Array.isArray(parsed.tasks) ? parsed.tasks : [];
    return tasks.find((t) => t && t.taskId === taskId) || null;
  } catch {
    return null;
  }
}

export async function admitExecution({ goalTaskId, requires, description, tags }) {
  const { config: cfg } = resolveConfig();
  const id = String(goalTaskId || '').slice(0, 120);
  const env = await storedGoal(id);
  if (!env) return { ok: false, code: 'admission-goal-not-found', error: 'no stored goal envelope for ' + id };
  if (env.kind !== 'goal') return { ok: false, code: 'admission-not-a-goal', error: 'envelope kind is ' + String(env.kind) + ' — only a goal envelope can be admitted' };

  // SHIP gate — every execution verdict must hold; the failed gate is named
  // so the refusal is actionable rather than a bare deny.
  const failedGates = [];
  if (env.status !== 'closed') failedGates.push('status=' + String(env.status));
  if (env.verdict !== 'SHIP') failedGates.push('verdict=' + String(env.verdict));
  if (!(env.objectiveEvaluation && env.objectiveEvaluation.pass)) failedGates.push('objectiveEvaluation.pass');
  if (!(env.capabilityValidation && env.capabilityValidation.pass)) failedGates.push('capabilityValidation.pass');
  if (env.error) failedGates.push('error');
  if (Array.isArray(env.failureCodes) && env.failureCodes.length) failedGates.push('failureCodes=' + failureList(env.failureCodes));
  if (failedGates.length) return { ok: false, code: 'admission-not-shipped', error: 'envelope is not SHIP — failed gate: ' + failedGates.join(', ') };

  const attempt = (Array.isArray(env.attempts) ? env.attempts : []).find((a) => a && a.runId && a.status === 'completed');
  if (!attempt) return { ok: false, code: 'admission-no-completed-run', error: 'envelope carries no completed run — nothing durable to reuse from' };

  const route = env.route || null;
  const selected = route && route.selected;
  if (!selected || !selected.id || !selected.workflow) return { ok: false, code: 'admission-route-unselected', error: 'envelope has no selected route — reuse would have nothing to route through' };

  const authority = env.authority || null;
  if (!authority || !Array.isArray(authority.granted)) return { ok: false, code: 'admission-authority-missing', error: 'envelope authority carries no granted scopes' };

  const req = requiresOf({ requires });
  if (req.unknown.length) return { ok: false, code: 'admission-unknown-scope', error: 'unknown authority scope(s): ' + req.unknown.join(', ') };
  const notHeld = req.requires.filter((s) => !authority.granted.includes(s));
  if (notHeld.length) return { ok: false, code: 'admission-requires-not-held', error: 'requires ' + notHeld.join(', ') + ' — the source envelope was granted only [' + authority.granted.join(', ') + ']' };

  // Evaluator derivation: exactly ONE distinct contains: expectation across
  // the objective checks. Never caller-declared, never invented.
  const objChecks = (env.objectiveEvaluation && Array.isArray(env.objectiveEvaluation.checks)) ? env.objectiveEvaluation.checks : [];
  const expected = [...new Set(objChecks.filter((c) => c && typeof c.id === 'string' && c.id.startsWith('contains:') && typeof c.expected === 'string' && c.expected).map((c) => c.expected))];
  if (expected.length !== 1) return { ok: false, code: 'admission-evaluator-not-derivable', error: 'objective checks derive ' + expected.length + ' distinct contains: expectations — exactly one is required' };
  const evaluator = { kind: 'output-contains', value: expected[0] };

  // One bytes channel: the frozen workflow must exist on disk to pin.
  let workflowBytes = null;
  try { workflowBytes = await readFile(join(cfg.teaching.workflowsDir || '', selected.workflow + '.yaml')); } catch { workflowBytes = null; }
  if (!workflowBytes) return { ok: false, code: 'admission-workflow-bytes-missing', error: 'workflow bytes for ' + selected.workflow + ' not found under the configured teaching workflows dir' };
  const workflowSha256 = sha256(workflowBytes);

  if (!cfg.registry.path) return { ok: false, code: 'admission-registry-not-configured', error: 'registry not configured' };
  let registry = null;
  try {
    registry = JSON.parse(await readFile(cfg.registry.path, 'utf8'));
  } catch (e) {
    return { ok: false, error: 'registry unreadable: ' + ((e && e.message) || String(e)) };
  }
  if (!registry || !Array.isArray(registry.capabilities)) return { ok: false, error: 'registry has no capabilities array' };
  if (registry.capabilities.some((c) => c && c.id === selected.id)) return { ok: false, code: 'admission-already-in-registry', error: 'capability already in the registry — admission refused' };

  // Typed metadata contract: description 1..500, tags typed slugs.
  const desc = typeof description === 'string' ? description.trim() : '';
  if (!desc || desc.length > 500) return { ok: false, code: 'admission-metadata-invalid', error: 'description must be 1-500 characters' };
  const tagList = Array.isArray(tags) ? tags.map((t) => String(t)) : null;
  if (!tagList || tagList.length > 32 || tagList.some((t) => !TAG_RE.test(t))) return { ok: false, code: 'admission-metadata-invalid', error: 'tags must be at most 32 typed slugs matching [a-z0-9][a-z0-9-]*' };

  // Bridge stamp must be COMPLETE — establishedBy, environmentId, the brg_
  // receipt id and its sha256 receipt sha all present and well-formed.
  const worker = env.executionEnvironment && env.executionEnvironment.worker;
  const stamped = worker && worker.establishedBy && worker.environmentId && BRIDGE_ID_RE.test(String(worker.id || '')) && SHA256_RE.test(String(worker.receiptSha256 || ''));
  if (!stamped) return { ok: false, code: 'admission-bridge-stamp-invalid', error: 'execution bridge stamp is incomplete (establishedBy, environmentId, brg_ receipt id, sha256 receipt sha all required)' };

  const envelopeSha256 = 'sha256:' + sha256(JSON.stringify(env));
  const entry = {
    id: selected.id,
    version: selected.version || '1.0.0',
    workflow: selected.workflow,
    name: ('ADMITTED — ' + String(env.objective || selected.id)).slice(0, 200),
    status: 'promoted',
    kind: 'workflow',
    requires: req.requires,
    description: desc,
    verification: { terminalStatus: attempt.status, expectOutput: evaluator.value },
    objectiveEvaluation: evaluator,
    tags: tagList,
    bridge: { environmentId: worker.environmentId },
    provenance: {
      admission: 'execution-admission-v1',
      sourceTaskId: env.taskId,
      sourceRunId: attempt.runId,
      envelopeSha256,
      workflowSha256,
      authority: JSON.parse(JSON.stringify(authority)),
      bridge: { receiptId: worker.id, receiptSha256: worker.receiptSha256 },
      admittedBy: 'operator',
      admittedAt: isoNow(),
    },
    admitted_after: [],
    evals: [],
    reuse_count: 0,
    last_eval: null,
  };
  registry.capabilities.push(entry);
  await writeFile(cfg.registry.path, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  return { ok: true, entry };
}

function failureList(codes) {
  return codes.map((c) => String(c)).join(',');
}
