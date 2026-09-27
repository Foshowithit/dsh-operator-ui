const MAX_ENVELOPE_BYTES = 96 * 1024;
const JOB_STATUSES = new Set(['running', 'stopping', 'completed', 'killed', 'failed']);

function publicSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  if (typeof snapshot.id !== 'string' || typeof snapshot.kind !== 'string' || typeof snapshot.label !== 'string') return null;
  if (!JOB_STATUSES.has(snapshot.status) || !Number.isInteger(snapshot.startedAt)) return null;
  if (snapshot.detail !== undefined && typeof snapshot.detail !== 'string') return null;
  if (snapshot.finishedAt !== undefined && !Number.isInteger(snapshot.finishedAt)) return null;

  return {
    id: snapshot.id,
    kind: snapshot.kind,
    label: snapshot.label,
    status: snapshot.status,
    ...(snapshot.detail !== undefined ? { detail: snapshot.detail } : {}),
    startedAt: snapshot.startedAt,
    ...(snapshot.finishedAt !== undefined ? { finishedAt: snapshot.finishedAt } : {}),
  };
}

// Expose the canonical job_list value to the keyed operator card while keeping
// DSH's text presentation intact. Downstream refusals and replacements remain
// authoritative; no value is retained outside this call-bound result.
export async function jobListBridge(exec, result, next) {
  const decision = await next();
  if (decision.kind !== 'accept' || Object.hasOwn(decision, 'content') || Object.hasOwn(decision, 'value')) return decision;
  if (exec.name !== 'job_list' || typeof exec.callId !== 'string' || !exec.callId || result.isError !== false) return decision;
  if (!Array.isArray(result.value) || !Array.isArray(result.content)) return decision;

  const value = result.value.map(publicSnapshot);
  if (value.some((snapshot) => snapshot === null)) return decision;

  let text;
  try {
    text = JSON.stringify({
      operatorJobList: { version: 1, callId: exec.callId, toolName: 'job_list', jobs: value },
    });
  } catch {
    return decision;
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_ENVELOPE_BYTES) return decision;
  return { ...decision, content: [...result.content, { type: 'text', text }] };
}
