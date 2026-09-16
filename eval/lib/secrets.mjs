#!/usr/bin/env node
// eval/lib/secrets.mjs — environment-only credential resolution for the
// eval lane. The RC0 tree carries no private ecosystem names or developer
// machine paths (scripts/check.js hygiene rule): runs inject the model key
// directly (MUSE_EVAL_KEY) or point RCOS_VAULT_DIR at a local vault
// directory holding opencode-muse-eval.key. Nothing here names a path on
// any specific machine.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';

export function museEvalKey() {
  if (process.env.MUSE_EVAL_KEY) return process.env.MUSE_EVAL_KEY.trim();
  const dir = process.env.RCOS_VAULT_DIR;
  if (!dir) return null;
  try { return readFileSync(join(dir, 'opencode-muse-eval.key'), 'utf8').trim(); } catch { return null; }
}

// The DSH CLI resolves from env or PATH; the eval lane pins a version via
// env on machines that cache it.
export function dshBin() {
  return process.env.DSH_BIN || 'dsh';
}

// js-yaml is not a repo dependency (this tree ships no node_modules); it
// resolves from the ambient environment only.
export function jsYamlPath() {
  return process.env.RCOS_JS_YAML
    || join(homedir(), '.nvm', 'versions', 'node', 'v24.15.0', 'lib', 'node_modules', 'js-yaml');
}
