// lib/canvas-binding.js — pure PanelDoc binding-source resolver (C2 adapter slice).
//
// Resolves `run:ID/streams/NAME` and `artifact:ID` against host-supplied
// runs/artifacts dictionaries. No fetching, no reads, no relabeling: a DSH
// call ID, a path, and a URL are all refused, and missing entries return
// explicit unknown reasons. Only scalar values ever resolve — objects and
// arrays are refused rather than handed to a renderer. The host must supply
// only sources authorized for the current context; reference alone never
// authorizes a source read. Pure with no I/O on import.

export const BINDING_SCHEMA = 'operator-canvas-binding/1';
const MAX_TEXT = 180;
const ID = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
const RUN_RE = new RegExp(`^run:(${ID})\\/streams\\/(${ID})$`);
const ARTIFACT_RE = new RegExp(`^artifact:(${ID})$`);

function deny(code, reason) {
  return { ok: false, schema: BINDING_SCHEMA, code, reason: String(reason).slice(0, MAX_TEXT), value: null };
}

function hasAccessor(value) {
  try {
    if (!value || typeof value !== 'object') return false;
    for (const key of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (d && (d.get || d.set)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false;
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !d.enumerable || d.get || d.set || !Object.hasOwn(d, 'value')) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function resolveBindingSource(sources, ref) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > MAX_TEXT) {
    return deny('not-a-binding', 'A binding reference must be a short non-empty string.');
  }
  let match = RUN_RE.exec(ref);
  let kind = match ? 'run-stream' : null;
  if (!match) {
    match = ARTIFACT_RE.exec(ref);
    kind = match ? 'artifact' : null;
  }
  if (!match) return deny('not-a-binding', 'Only run:ID/streams/NAME and artifact:ID resolve.');
  if (!sources || typeof sources !== 'object' || hasAccessor(sources)) {
    return deny('malformed-sources', 'Host sources are not plain data.');
  }
  if (kind === 'run-stream') {
    const [, id, name] = match;
    const runs = sources.runs;
    if (!plainRecord(runs)) return deny('malformed-sources', 'Host runs are not a plain record.');
    const run = Object.hasOwn(runs, id) ? runs[id] : undefined;
    if (!plainRecord(run) || !plainRecord(run.streams)) return deny('unknown-run', `No such run: ${id}.`);
    if (!Object.hasOwn(run.streams, name)) return deny('unknown-stream', `Run ${id} has no stream ${name}.`);
    const value = run.streams[name];
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      if (typeof value === 'number' && !Number.isFinite(value)) return deny('non-scalar-source', 'Only finite scalars resolve.');
      return { ok: true, schema: BINDING_SCHEMA, kind, id, name, value };
    }
    return deny('non-scalar-source', 'Only scalar stream values resolve.');
  }
  const [, id] = match;
  const artifacts = sources.artifacts;
  if (!plainRecord(artifacts)) return deny('malformed-sources', 'Host artifacts are not a plain record.');
  if (!Object.hasOwn(artifacts, id)) return deny('unknown-artifact', `No such artifact: ${id}.`);
  const value = artifacts[id];
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) return deny('non-scalar-source', 'Only finite scalars resolve.');
    return { ok: true, schema: BINDING_SCHEMA, kind, id, value };
  }
  return deny('non-scalar-source', 'Only scalar artifact values resolve.');
}
