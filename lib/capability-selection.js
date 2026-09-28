// lib/capability-selection.js — explicit canonical capability selection (B2).
//
// Consumes lib/capability-view.js: an explicit {id, version} (+ optional
// sourceDigest) selection resolves to the entry's exact archon-workflow
// binding, or refuses with a named code. There is no lexical fallback, no
// replacement choice, and no dispatch: refusals carry reasons and never a
// binding or an alternate. Pure with no I/O on import.

import { projectCapabilityView } from './capability-view.js';

export const SELECTION_SCHEMA = 'operator-capability-selection/1';
const MAX_TEXT = 180;

function refusal(code, message, reasons = []) {
  return {
    ok: false, schema: SELECTION_SCHEMA, code,
    message: String(message).slice(0, MAX_TEXT),
    reasons: Array.isArray(reasons) ? reasons.slice(0, 8).map((r) => String(r).slice(0, MAX_TEXT)) : [],
    binding: null, alternate: null,
  };
}

function safeSelection(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return null;
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !d.enumerable || d.get || d.set || !Object.hasOwn(d, 'value')) return null;
    }
    const { id, version, sourceDigest } = value;
    if (typeof id !== 'string' || id.length === 0) return null;
    if (typeof version !== 'string' || version.length === 0) return null;
    if (sourceDigest !== undefined && (typeof sourceDigest !== 'string' || sourceDigest.length === 0)) return null;
    return { id, version, sourceDigest: sourceDigest ?? null };
  } catch {
    return null;
  }
}

export function selectCapability({ registry, observations, selection } = {}) {
  const sel = safeSelection(selection);
  if (!sel) return refusal('selection-required', 'An explicit capability id and version are required.');
  let view;
  try {
    view = projectCapabilityView({ registry, observations });
  } catch {
    return refusal('selection-required', 'The readiness projection could not run.');
  }
  if (!view || !Array.isArray(view.entries)) {
    return refusal('selection-required', 'The readiness projection produced no entries.');
  }
  // Exact identity match only: id AND version, case-sensitive, no substrings.
  const entry = view.entries.find((e) => e && e.id === sel.id && e.version === sel.version);
  if (!entry) return refusal('unknown-capability', 'No registry entry carries that exact id and version.');
  const entryDigest = entry.sourceDigest ?? null;
  if (sel.sourceDigest !== null && entryDigest !== null && sel.sourceDigest !== entryDigest) {
    return refusal('stale-identity', 'The pinned digest does not match the registry entry.');
  }
  if (!entry.binding) {
    return refusal('absent-binding', 'The selected entry declares no execution binding.');
  }
  if (!entry.executable || entry.executable.state !== 'yes') {
    return refusal('not-executable', 'The selected entry is not execution-ready.', entry.executable ? entry.executable.reasons : []);
  }
  if (!entry.eligible || entry.eligible.state !== 'yes') {
    return refusal('not-eligible', 'The selected entry is not eligible in this context.', entry.eligible ? entry.eligible.reasons : []);
  }
  return {
    ok: true,
    schema: SELECTION_SCHEMA,
    selection: { id: entry.id, version: entry.version, sourceDigest: entryDigest },
    binding: entry.binding,
  };
}
