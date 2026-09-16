#!/usr/bin/env node
// eval/lib/static-checks.mjs — Acquisition v2 preflight (failure class 3
// countermeasure): cheap structural rejection of a candidate BEFORE any
// Archon execution. Pure function: (yamlText) → { ok, failures, parsed }.
//
// Every failure carries a machine-readable code that the diagnose-revise
// prompt quotes verbatim, so revision is driven by the checker, not vibes.
//
// Parsing uses js-yaml (the only dependency in eval tooling; resolved from
// the global lib because this repo deliberately ships no node_modules).

import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
let yaml = null;
try { yaml = require_('js-yaml'); } catch {
  try { yaml = require_((await import('./secrets.mjs')).jsYamlPath()); } catch {}
}

// v1.0.1 defect fix (live acq-v2 run exp-cc66cc852): the bare-token
// FORBIDDEN_CREDENTIAL regex (\bKEY=, password) false-positived on
// legitimate key/value-diff logic (family D02 candidates compare env files
// whose DATA contains key=value text), strangling 3 of 4 attempts before
// execution. Credential scanning is now contextual: reads of credential
// stores, and assignments/exports of secret-named variables at bash
// line-start. Data text inside comparisons/quotes no longer trips it.
// Failure details now quote the matched line so the revise loop can react.
const FORBIDDEN = [
  ['FORBIDDEN_NETWORK', /\b(curl|wget|nc|ncat|ftp|ssh|scp|rsync|ping)\b/, 'network access is not allowed in a deterministic capability'],
  ['FORBIDDEN_PRIVILEGE', /\b(sudo|su|doas)\b/, 'privilege escalation is not allowed'],
  ['FORBIDDEN_DESTRUCTIVE', /(rm\s+-rf\s+[\/~]|mkfs|dd\s+if=|>\s*\/dev\/sd[a-z])/, 'destructive shell is not allowed'],
];
// v1.0.2 defect fix (live acq-v2.1 run exp-075ac248): CREDENTIAL_STORE's
// `\.env\b` matched ANY *.env-suffixed file — family D02's own fixtures
// (release-a.env / release-b.env) — so legit env-diff candidates were
// strangled pre-execution. The credential convention is the HIDDEN dotfile
// `.env` (and .env.* variants), not a *.env suffix. Persisted candidates
// made this diagnosis mechanical: the failure detail quotes the matched
// line, which named the fixture file itself.
const CREDENTIAL_STORE = /(~\/\.ssh|~\/\.aws|~\/\.[a-z-]*secrets|\.netrc|id_rsa|(^|[^A-Za-z0-9_.])\.env(\.|[ \t"'\\/)]|$))/;
// Name must END in the secret word: API_SECRET= trips, KEY_VALUE_PAIRS= doesn't.
const SECRET_ASSIGN = /^[ \t]*(export[ \t]+)?[A-Za-z_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD)=/;

// Scan yaml text line-by-line for a context-sensitive rule; detail quotes
// the offending line so diagnosis is evidence-driven.
function scanLines(text, rule) {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    if (rule.test(line)) return line.trim().slice(0, 120);
  }
  return null;
}

export function staticChecks(yamlText) {
  if (!yaml) return { ok: false, failures: [{ code: 'CHECKER_UNAVAILABLE', detail: 'js-yaml not resolvable' }], parsed: null };
  const failures = [];
  const push = (code, detail) => failures.push({ code, detail });
  if (typeof yamlText !== 'string' || !yamlText.trim()) {
    return { ok: false, failures: [{ code: 'YAML_EMPTY', detail: 'no yaml text' }], parsed: null };
  }

  let doc = null;
  try { doc = yaml.load(yamlText); } catch (e) {
    return { ok: false, failures: [{ code: 'YAML_UNPARSEABLE', detail: String(e.message).slice(0, 200) }], parsed: null };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, failures: [{ code: 'YAML_UNPARSEABLE', detail: 'top level must be a mapping' }], parsed: null };
  }

  const extra = Object.keys(doc).filter((k) => !['name', 'description', 'nodes'].includes(k));
  if (extra.length) push('SCHEMA_KEYS', `unknown top-level keys: ${extra.join(', ')}`);
  const parsed = { name: doc.name, description: doc.description, nodes: Array.isArray(doc.nodes) ? doc.nodes : null };

  if (!parsed.name || typeof parsed.name !== 'string') push('NAME_MISSING', 'workflow has no name');
  else if (!/^[a-z0-9][a-z0-9-]*-v0-1-0$/.test(parsed.name)) push('NAME_FORMAT', `name "${parsed.name}" must be lowercase-hyphenated and end -v0-1-0`);

  if (!parsed.nodes || parsed.nodes.length === 0) push('NODES_EMPTY', 'workflow has no nodes');
  else {
    const ids = new Set();
    parsed.nodes.forEach((n, idx) => {
      const id = String((n && n.id) || '').trim();
      if (!id) push('NODE_ID_MISSING', `node ${idx + 1} has no id`);
      else if (ids.has(id)) push('NODE_ID_DUP', `duplicate node id: ${id}`);
      else ids.add(id);
      const bash = String((n && n.bash) || '').trim();
      if (!bash) push('NODE_BASH_MISSING', `node "${id || idx + 1}" has no bash script`);
    });
    const byId = new Map(parsed.nodes.map((n) => [String((n && n.id) || '').trim(), n]));
    const depsOf = (n) => {
      const raw = n && n.depends_on;
      if (Array.isArray(raw)) return raw.map((s) => String(s).trim());
      return String(raw || '').replace(/[\[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    };
    for (const n of parsed.nodes)
      for (const d of depsOf(n))
        if (!byId.has(d)) push('DEP_UNKNOWN', `node "${n.id}" depends on unknown node "${d}"`);
    // cycle check (DFS, iterative per root)
    const WHITE = 0, GREY = 1, BLACK = 2;
    const color = new Map([...byId.keys()].map((k) => [k, WHITE]));
    let cycle = false;
    const visit = (id, path) => {
      if (cycle) return;
      if (color.get(id) === GREY) { push('DEP_CYCLE', 'dependency cycle: ' + [...path, id].join(' -> ')); cycle = true; return; }
      if (color.get(id) !== WHITE) return;
      color.set(id, GREY);
      for (const d of depsOf(byId.get(id) || {})) if (byId.has(d)) visit(d, [...path, id]);
      color.set(id, BLACK);
    };
    for (const id of byId.keys()) visit(id, []);
  }

  // Output contract (checked on the raw text so block scalars are covered).
  if (!/\bRESULT\b/.test(yamlText)) push('CONTRACT_NO_RESULT', 'no RESULT line anywhere — output contract requires RESULT key=value evidence lines');
  const marker = (yamlText.match(/learned-[\w-]+:done/) || [null])[0];
  if (!marker) push('CONTRACT_NO_MARKER', 'no expectation marker learned-<name>:done echoed anywhere');
  else if (parsed.name && marker !== `learned-${parsed.name}:done`)
    push('CONTRACT_MARKER_NAME', `marker "${marker}" does not match workflow name "${parsed.name}" (expected learned-${parsed.name}:done)`);

  // Artifact-location contract: artifacts stay in the workspace (cwd).
  if (/>\s*\/(?!dev\/null)/.test(yamlText) || /\btee\s+\/(?!dev\/null)/.test(yamlText))
    push('LOCATION_ABSOLUTE_WRITE', 'redirect to an absolute filesystem path — artifacts must stay in the workspace');
  if (/(\bcp\b|\bmv\b|\btee\b|>|>>)\s+["']?(~\/|\/tmp\/|\/var\/|\/etc\/|\/Users\/|\/home\/)/.test(yamlText))
    push('LOCATION_ABSOLUTE_WRITE', 'writes outside the workspace (absolute path)');
  if (/(cp|mv|tee|>)\s+["']?\.\.\//.test(yamlText))
    push('LOCATION_PARENT_ESCAPE', 'writes via ../ escape the workspace');
  if (/mkdir\s+[^|;\n]*["']?(~\/|\/(tmp|var|etc|Users|home)\b)/.test(yamlText))
    push('LOCATION_ABSOLUTE_WRITE', 'mkdir outside the workspace');

  for (const [code, re, why] of FORBIDDEN) {
    const hit = scanLines(yamlText, re);
    if (hit) push(code, why + ' — matched: ' + hit);
  }
  const credStore = scanLines(yamlText, CREDENTIAL_STORE);
  if (credStore) push('FORBIDDEN_CREDENTIAL', 'reads a credential store — matched: ' + credStore);
  const credAssign = scanLines(yamlText, SECRET_ASSIGN);
  if (credAssign) push('FORBIDDEN_CREDENTIAL', 'assigns a secret-named variable — matched: ' + credAssign);

  return { ok: failures.length === 0, failures, parsed };
}

// The revision prompt quotes failure codes verbatim; this renders them.
export function renderFailures(failures) {
  return failures.map((f) => `- ${f.code}: ${f.detail}`).join('\n');
}
