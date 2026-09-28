const WM_FIELDS = new Set(['seat', 'objective', 'state', 'verdict', 'summary', 'stage', 'auditLog', 'auditError', 'archonRunId', 'archonStatus']);
const JOB_FIELDS = new Set(['state', 'summary', 'jobCount']);
const MAX_TEXT = 10_000;
const MAX_ID = 512;
const MAX_DATE = 8_640_000_000_000_000;

const record = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : null;
    return !!descriptor && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
};
const text = (value, max = MAX_TEXT) => typeof value === 'string' && value.length <= max;
const identity = (value) => text(value, MAX_ID) && value.trim().length > 0;
const reportedIdentity = (value) => identity(value) && value.trim().toLowerCase() !== 'none';
const freezeCopy = (value) => {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCopy));
  if (record(value)) return Object.freeze(Object.fromEntries(Object.keys(value).map((key) => [key, freezeCopy(value[key])])));
  return value;
};
const frozenContext = (context) => Object.freeze({
  workspaceId: context.workspaceId, sessionId: context.sessionId,
  callId: context.callId, toolName: context.toolName,
});
const validContext = (context) => record(context) &&
  Object.keys(context).length === 4 && ['workspaceId', 'sessionId', 'callId', 'toolName'].every((key) => Object.hasOwn(context, key) && identity(context[key])) &&
  (context.toolName === 'dispatch_seat' || context.toolName === 'job_list');

export function createExecutionSourceStore() {
  let context = null;
  let token = null;
  let disposed = false;
  let listeners = new Set();
  let snapshot = Object.freeze({ context: null, availability: 'unknown', observation: null, reason: 'no-selection' });

  const publish = (next) => {
    snapshot = freezeCopy(next);
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* One consumer cannot prevent delivery to the others. */ }
    }
  };

  const select = (candidate) => {
    if (disposed) return null;
    const issuedToken = {};
    token = issuedToken;
    context = validContext(candidate) ? frozenContext(candidate) : null;
    publish({ context, availability: 'unknown', observation: null, reason: context ? 'awaiting-observation' : 'no-selection' });
    if (!context) { if (token === issuedToken) token = null; return null; }
    return token === issuedToken && !disposed ? issuedToken : null;
  };

  const accept = (selectionToken, observation) => {
    if (disposed || !token || selectionToken !== token || !record(observation)) return false;
    const keys = ['workspaceId', 'sessionId', 'callId', 'toolName', 'kind', 'phase', 'observedAt', 'values'];
    if (Object.keys(observation).some((key) => !keys.includes(key) && key !== 'reportedRun' && key !== 'reason') ||
        !keys.every((key) => Object.hasOwn(observation, key)) ||
        !['workspaceId', 'sessionId', 'callId', 'toolName'].every((key) => observation[key] === context[key]) ||
        observation.kind !== 'dsh-call-snapshot' || !['pending', 'settled', 'unavailable'].includes(observation.phase) ||
        !(observation.observedAt === null || (Number.isSafeInteger(observation.observedAt) && observation.observedAt >= 0 && observation.observedAt <= MAX_DATE)) ||
        !record(observation.values)) return false;

    const allowed = context.toolName === 'dispatch_seat' ? WM_FIELDS : JOB_FIELDS;
    const values = observation.values;
    if (Object.keys(values).some((key) => !allowed.has(key)) || Object.entries(values).some(([key, value]) =>
      key === 'jobCount' ? !(Number.isSafeInteger(value) && value >= 0) : value !== null && !text(value))) return false;
    if (context.toolName === 'dispatch_seat') {
      if (values.jobCount !== undefined || !['awaiting-result', 'unavailable', 'failed', 'blocked', 'completed'].includes(values.state)) return false;
      if (observation.phase === 'pending' && (values.state !== 'awaiting-result' || Object.keys(values).some((key) => !['seat', 'objective', 'state'].includes(key)))) return false;
      if (observation.phase === 'unavailable' && (values.state !== 'unavailable' || ['verdict', 'stage', 'archonRunId', 'archonStatus', 'auditLog'].some((key) => values[key] != null) || Object.hasOwn(observation, 'reportedRun'))) return false;
      if (values.state === 'unavailable' && observation.phase !== 'unavailable') return false;
      if (observation.phase === 'settled' && values.state === 'awaiting-result') return false;
      if (values.state === 'unavailable' && ['verdict', 'stage', 'archonRunId', 'archonStatus', 'auditLog'].some((key) => values[key] != null)) return false;
      if (observation.phase === 'settled' && values.state === 'completed' &&
          (values.stage !== 'complete' || !['ship', 'fix'].includes(values.verdict))) return false;
      if (observation.phase === 'settled' && values.state === 'blocked' && values.verdict !== 'blocked') return false;
      if (observation.phase === 'settled' && values.state === 'failed' && values.verdict != null) return false;
      if (Object.hasOwn(observation, 'reportedRun')) {
        const reportedRun = observation.reportedRun;
        if (observation.phase !== 'settled' || !record(reportedRun) || Object.keys(reportedRun).length !== 2 ||
            !reportedIdentity(reportedRun.runId) || !reportedIdentity(reportedRun.seatSessionId)) return false;
      }
    } else {
      if (Object.hasOwn(observation, 'reportedRun') || !['awaiting-result', 'unavailable', 'failed', 'snapshot'].includes(values.state) ||
          (values.jobCount !== undefined && (!Number.isSafeInteger(values.jobCount) || values.jobCount < 0))) return false;
      if (observation.phase === 'pending' && (values.state !== 'awaiting-result' || Object.keys(values).some((key) => !['state', 'summary'].includes(key)))) return false;
      if (observation.phase === 'unavailable' && (values.state !== 'unavailable' || values.jobCount !== undefined)) return false;
      if (values.state === 'unavailable' && observation.phase !== 'unavailable') return false;
      if (observation.phase === 'settled' && ['awaiting-result'].includes(values.state)) return false;
      if (observation.phase === 'settled' && values.state === 'snapshot' && values.jobCount === undefined) return false;
      if (observation.phase === 'settled' && values.state !== 'snapshot' && values.jobCount !== undefined) return false;
    }
    if (Object.hasOwn(observation, 'reason') && observation.reason !== null && !text(observation.reason)) return false;

    const copiedObservation = {
      kind: observation.kind, phase: observation.phase, observedAt: observation.observedAt,
      values: { ...values },
    };
    if (Object.hasOwn(observation, 'reportedRun')) copiedObservation.reportedRun = { ...observation.reportedRun };
    publish({ context, availability: observation.phase, observation: copiedObservation,
      reason: observation.reason === undefined ? null : observation.reason });
    return true;
  };

  const getSnapshot = () => snapshot;
  const subscribe = (listener) => {
    if (disposed || typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    context = null; token = null;
    publish({ context: null, availability: 'unknown', observation: null, reason: 'disposed' });
    listeners.clear();
  };

  return Object.freeze({ select, accept, getSnapshot, subscribe, dispose });
}
