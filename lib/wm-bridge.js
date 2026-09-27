// DSH tools/post-execute exposes the canonical tool value before rendering
// commits to the session log. Preserve the producer's summary and add a bounded
// structured copy for the keyed tool card, including code-mode subcalls. No
// second store, runtime monkey patch, or parsing of a model's prose is needed.
// A downstream refusal/replacement always wins: never restore superseded data.
export async function wmReceiptBridge(exec, result, next) {
  const decision = await next();
  if (decision.kind !== 'accept' || Object.hasOwn(decision, 'content') || Object.hasOwn(decision, 'value')) return decision;
  if (exec.name !== 'dispatch_seat' || typeof exec.callId !== 'string' || !exec.callId || result.isError !== false) return decision;
  const value = result.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.dispatch || typeof value.dispatch.run_id !== 'string') return decision;
  if (!Array.isArray(result.content)) return decision;
  // Values have already passed DSH's schema and lossless-JSON snapshot. Retain
  // a defensive bound so presentation can never fail or amplify huge results.
  let text;
  try { text = JSON.stringify({ operatorWm: { version: 1, callId: exec.callId, toolName: 'dispatch_seat', value } }); }
  catch { return decision; }
  if (Buffer.byteLength(text, 'utf8') > 96 * 1024) return decision;
  return { ...decision, content: [...result.content, { type: 'text', text }] };
}
