/**
 * seat-dispatch: run exactly one governed turn in a genuinely fresh-root seat.
 *
 * The problem this closes is a composition problem, not a prompt problem. A
 * child session started by the ordinary subagent path JOINS its parent's
 * composition (composeFrom / applyChildComposition), so a child of the
 * conversation seat inherits the conversation seat's amputated tool surface and
 * cannot execute governed work no matter what its prompt says. This plugin
 * instead mounts a DIFFERENT preset's standing composition onto the child's
 * own agent scope (agentPresets.mount), which is exactly the mechanism
 * 'fresh root' means: the target preset -- and only the target preset -- owns
 * the child's tools, prompt sections, skill catalog, and model.
 *
 * Authority here is config, never intent:
 *   - only a caller composed from config.callerPreset may dispatch at all;
 *   - only ids in config.seats may be dispatched;
 *   - the target preset owns its own surface, and nothing it gains propagates
 *     back to the caller (the seat's scope is a different standing mount, and
 *     the seat's registrations live under the seat's own agent key);
 *   - the seat's verdict is only accepted as a receipt, never inferred from a
 *     turn ending, a file existing, or a confident sentence.
 *
 * The dispatcher owns the SEAT lifecycle (create, one followup turn, wait,
 * dispose). The Archon workflow library owns the WORKFLOW lifecycle inside the
 * seat: this plugin never claims a workflow succeeded, it only carries the run
 * id and the machine-readable status the seat read from the run's own artifact.
 *
 * @module dsh-seat-dispatch
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import * as receipt from './receipt.js';
import { createDispatchRunObserver } from './dispatch-status.js';

/** Cordis plugin name. */
export const name = 'seat-dispatch';

/** Services this plugin cannot work without. */
export const inject = ['agents', 'agentPresets', 'tools'];

/** Default seat: the governed execution seat. */
const DEFAULT_SEAT = 'workflow-manager';

/** Poll cadence while waiting for the seat. */
const POLL_MS = 350;

/** Intent classes recorded by the General seat before it responds or hands off. */
export const ROUTE_INTENTS = Object.freeze([
  'conversational',
  'read_only_inquiry',
  'clarification',
  'procedural_handoff',
]);

const ROUTING_DECISION_OUTPUT_PROPERTIES = {
  decision_id: { type: 'string' },
  intent: { type: 'string', enum: ROUTE_INTENTS },
  reason: { type: 'string' },
  caller_session_id: { type: 'string' },
  caller_turn_index: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
  caller_turn_start_event_index: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
  dispatch_run_id: { type: 'string' },
  recorded: { type: 'boolean' },
};

/** Model-interpreted routing declaration; this tool never creates an agent. */
export const ROUTING_DECISION_PARAMETERS = {
  intent: {
    type: 'string',
    enum: ROUTE_INTENTS,
    required: true,
    description: 'the model-interpreted handling class for this user request',
  },
  reason: {
    type: 'string',
    required: true,
    description: 'a concise explanation of why this intent fits, at most 2000 characters',
  },
};

/** Canonical persisted route-decision response. */
export const ROUTING_DECISION_TOOL_OUTPUT = {
  type: 'object',
  properties: {
    accepted: { type: 'boolean' },
    decision: { type: 'object', properties: ROUTING_DECISION_OUTPUT_PROPERTIES, additionalProperties: false },
    audit_log: { type: 'string' },
    audit_error: { type: 'string' },
  },
  additionalProperties: false,
};

const MAX_PENDING_ROUTE_DECISIONS = 1024;

/**
 * Plugin configuration, authored by the composition row that inserts it.
 *
 * There is deliberately no bypass flag: a caller cannot widen its own
 * authority, soften the receipt, or extend its own timeout past the ceiling.
 */
export const Config = z.object({
  /** Presets that may be dispatched, by id. */
  seats: z.array(z.string()).default([DEFAULT_SEAT]),
  /** The one preset whose sessions may dispatch at all. */
  callerPreset: z.string().default('general-idea'),
  /** Wall-clock ceiling for one dispatch, before cancellation. */
  timeoutMs: z.number().default(1800000),
  /** How long to wait for the seat to start its turn at all. */
  startupGraceMs: z.number().default(60000),
  /** How long a finished turn may lag its receipt before the wait gives up. */
  graceMs: z.number().default(15000),
  /** How long to let the seat's transcript drain after a receipt arrives. */
  drainMs: z.number().default(5000),
  /** Where the append-only dispatch audit log lives. */
  auditDir: z.string().default(join(resolveDshHome(), 'runs', 'seat-dispatch')),
});

/**
 * The model-facing argument schema of 'dispatch_seat'.
 *
 * Built from config so the advertised seat list and the enforced seat list are
 * the same list. A single-seat list omits 'enum' on purpose: an enum of one is
 * an accident waiting to happen, and the dispatcher still refuses an
 * unlisted id.
 * @param config - the resolved plugin config.
 * @returns the implicit-root parameter map.
 */
export function dispatchParameters(config) {
  const seats = config.seats;
  const seat = {
    type: 'string',
    required: true,
    description: 'which seat to dispatch: ' + seats.join(', ') + '. The seat preset -- not this caller -- owns its tools, prompt, and capabilities.',
  };
  if (seats.length > 1) seat.enum = seats;
  return {
    routing_decision_id: {
      type: 'string',
      required: true,
      description: 'the decision_id returned by record_routing_decision for this same active turn; only a recorded procedural_handoff decision can start a seat',
    },
    seat,
    objective: {
      type: 'string',
      required: true,
      description: 'the outcome to achieve, stated as work to be done rather than steps to follow',
    },
    done_when: {
      type: 'string',
      required: true,
      description: 'the observable condition that makes this dispatch finished -- the seat is held to it in its receipt evidence',
    },
    constraints: {
      type: 'array',
      items: { type: 'string' },
      description: 'binding limits the seat must respect, one per entry (things not to touch, evidence required, scope fences)',
    },
    context: {
      type: 'string',
      description: 'optional background the seat needs that it cannot discover itself: paths, prior findings, exact ids',
    },
    lane_expectation: {
      type: 'string',
      description: "optional provider/model this caller expects the seat to run on; recorded and compared against the lane observed in the seat's transcript, never used to re-point anything",
    },
    timeout_ms: {
      type: 'integer',
      description: 'optional shorter wall-clock budget for this dispatch; a value above the configured ceiling is clamped, never honoured',
    },
  };
}

/**
 * Canonical output of 'dispatch_seat' (value-schema DSL: no 'required' clause
 * exists in this DSL, so every declared property is always emitted).
 *
 * A blocked verdict and a failed dispatch are both ok:false; the stage tells
 * them apart, and only stage 'complete' means the seat actually answered.
 */
export const DISPATCH_OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'true only when the seat answered ship or fix with an accepted receipt; pending is not completion of the objective' },
    stage: { type: 'string', description: "where the dispatch ended: complete | authority | authority-route | authority-root | authority-seat | resolve | create | receipt-missing | timeout | aborted | error" },
    verdict: { type: 'string', description: 'the seat verdict, or the synthesized blocked verdict of a failed dispatch' },
    detail: { type: 'string', description: 'one paragraph a caller can act on' },
    warnings: { type: 'array', items: { type: 'string' }, description: 'unsupported claims and lane confounds, surfaced beside the verdict rather than dropped' },
    routing: {
      type: 'object',
      properties: ROUTING_DECISION_OUTPUT_PROPERTIES,
      additionalProperties: false,
    },
    lane: {
      type: 'object',
      properties: {
        declared: { type: 'string' },
        observed: { type: 'string' },
        mismatch: { type: 'boolean' },
        caller_expectation: { type: 'string', description: 'the lane the caller expected, recorded verbatim as telemetry; a disagreement with "observed" raises a warning and never changes authority or the verdict' },
      },
      additionalProperties: false,
    },
    dispatch: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        seat: { type: 'string' },
        seat_session_id: { type: 'string' },
        caller_session_id: { type: 'string' },
        caller_preset: { type: 'string' },
        preset_source: { type: 'string' },
        caller_depth: { type: 'number' },
        authority_basis: { type: 'string', description: "why the authority gate decided as it did: lineage-clean-root (a forked caller with no delegation record) | no-parent-root (a true top-level session) | delegated-child (origin 'subagent' and/or delegationDepth > 0) | not-caller-preset | unknown" },
        turns_observed: { type: 'number' },
        turn_started: { type: 'boolean' },
        duration_ms: { type: 'number' },
        receipt_accepted: { type: 'boolean' },
        receipt_attempts: { type: 'number' },
        receipt_refusals: { type: 'number' },
        receipts_seen: { type: 'number' },
        audit_log: { type: 'string' },
        audit_error: { type: 'string' },
      },
      additionalProperties: false,
    },
    receipt: {
      type: 'object',
      properties: {
        verdict: { type: 'string' },
        summary: { type: 'string' },
        artifacts: { type: 'array', items: { type: 'string' } },
        evidence: { type: 'array', items: { type: 'string' } },
        blockers: { type: 'array', items: { type: 'string' } },
        archon_run_id: { type: 'string' },
        archon_status: { type: 'string' },
        archon_artifact_dir: { type: 'string' },
        lane: { type: 'string' },
        next: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/** Canonical output of the seat-local receipt tool. */
export const RECEIPT_TOOL_OUTPUT = {
  type: 'object',
  properties: {
    accepted: { type: 'boolean' },
    violations: { type: 'array', items: { type: 'string' } },
    run_id: { type: 'string' },
  },
  additionalProperties: false,
};

/** One-line description of what a seat's receipt tool does. */
const RECEIPT_TOOL_DESCRIPTION = 'Submit the single authoritative receipt for this seat dispatch: verdict, summary, artifacts, evidence, blockers, the real Archon run id and its machine-readable status, the lane you actually ran on, and the next action. Call this tool directly and exactly once. A ship verdict requires a real Archon run reporting ship. An active run may be reported as pending with the real run id and next poll action. A schema-invalid submission is refused with its violations and does NOT consume your one receipt; a valid submission ends the dispatch.';

/**
 * Build the seat-local receipt tool.
 *
 * The tool is registered on the SEAT's own agent scope, never globally, so it
 * exists only while one dispatch runs and only for the agent that dispatch
 * created. It is exported for testability: the real defineTool validates these
 * schemas at author time, so a test can compile them without a runtime.
 * @param options - the submission handler.
 * @returns the tool definition, ready for agentCtx.tools.register.
 */
export function buildReceiptTool(options) {
  return defineTool({
    name: receipt.RECEIPT_TOOL_NAME,
    description: RECEIPT_TOOL_DESCRIPTION,
    parameters: receipt.RECEIPT_PARAMETERS,
    output: {
      schema: RECEIPT_TOOL_OUTPUT,
      render: (args, value) => [
        {
          type: 'text',
          text: value.accepted
            ? 'receipt accepted for dispatch ' + value.run_id + '; this dispatch is now complete and your session is closing'
            : 'receipt refused for dispatch ' + value.run_id + ': ' + value.violations.join('; '),
        },
      ],
    },
    timeoutMs: 30000,
    execute: (attempt, exec) => Promise.resolve(options.submit(attempt, exec)),
  });
}

/** Sleep, without depending on a global timer API. */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** One readable line from any thrown value. */
function describe(error) {
  if (error === null || error === undefined) return 'unknown error';
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Clamp a requested budget into the configured ceiling. */
function clampBudget(requested, ceiling) {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return ceiling;
  return Math.min(Math.floor(requested), ceiling);
}

/**
 * Resolve the seat's AgentOptions by INHERITANCE, the way every other child
 * agent in this runtime does.
 *
 * A seat created with no agent options carries `options.model === undefined`,
 * and the mounted preset's persona interpolates `{{model}}` under the strict
 * rules of prompt assembly -- so the seat's first turn dies before it ever
 * builds a request ("prompt variable ... has no value for this assembly"), and a
 * preset that did not reference the variable would instead fail the request
 * seed with "has no provider/model: set AgentOptions.provider and
 * AgentOptions.model". Either way the seat is unrunnable, so the route is
 * inherited here rather than assumed: the caller's own resolved route first
 * (the same source `resolveChildAgentOptions` uses for a child), then the
 * deployment default for a caller that carries none. Authority is unchanged --
 * this reads a route, it does not widen who may dispatch.
 * @param callerAgent - the calling agent whose route the seat inherits.
 * @param ctx - the plugin context, used to read the optional default service.
 * @returns the agentOptions for ctx.agents.create().
 */
function inheritAgentOptions(callerAgent, ctx) {
  const route = callerAgent === undefined || callerAgent === null ? undefined : callerAgent.options;
  const inherited = {};
  if (typeof route?.provider === 'string' && route.provider.length > 0) inherited.provider = route.provider;
  if (typeof route?.model === 'string' && route.model.length > 0) inherited.model = route.model;
  if (typeof route?.reasoningEffort === 'string' && route.reasoningEffort.length > 0) inherited.reasoningEffort = route.reasoningEffort;
  if (inherited.model !== undefined) return inherited;
  const defaults = ctx.get('agentDefaultModel');
  let selection;
  try {
    selection = typeof defaults?.currentSelection === 'function' ? defaults.currentSelection() : undefined;
  } catch (error) {
    selection = undefined; /* the deployment default is unreadable; leave the route as inherited */
  }
  if (selection === undefined || selection === null) return inherited;
  if (inherited.provider === undefined && typeof selection.provider === 'string' && selection.provider.length > 0) inherited.provider = selection.provider;
  if (inherited.model === undefined && typeof selection.model === 'string' && selection.model.length > 0) inherited.model = selection.model;
  if (inherited.reasoningEffort === undefined && typeof selection.reasoningEffort === 'string' && selection.reasoningEffort.length > 0) inherited.reasoningEffort = selection.reasoningEffort;
  return inherited;
}

/**
 * Encode one value as JSON and decode it back, or undefined when it cannot be.
 * @param value - any value carried by a session event.
 * @returns a detached JSON-safe copy, or undefined.
 */
function jsonSafe(value) {
  if (value === undefined) return undefined;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : JSON.parse(encoded);
  } catch (error) {
    return undefined;
  }
}

/**
 * Reduce one turn/end reason to a JSON-safe STRUCTURED value.
 *
 * The reason is the dispatcher's only evidence for why a seat turn ended, so it
 * is persisted as a structure and never as a string: `String(reason)` renders a
 * failed turn as "[object Object]" and destroys the kind, the message, and the
 * code that identify the failure. A live Error in the reason (an aborted turn
 * carries `signal.reason`) is not JSON-safe, so it is reduced to its own fields
 * -- and the result is proven JSON-safe before it reaches the audit line.
 * @param reason - the raw turn/end reason.
 * @returns a JSON-safe structured reason, or undefined when there is none.
 */
function structuredReason(reason) {
  if (reason === undefined || reason === null) return undefined;
  if (typeof reason !== 'object') return reason;
  if (reason instanceof Error) {
    const reduced = { name: reason.name, message: reason.message };
    for (const [key, value] of Object.entries(reason)) {
      const safe = jsonSafe(value);
      if (safe !== undefined) reduced[key] = safe;
    }
    return reduced;
  }
  const safe = jsonSafe(reason);
  return safe === undefined ? { message: describe(reason) } : safe;
}

/**
 * Read one structured turn reason as a single prose clause.
 * @param reason - a value produced by structuredReason().
 * @returns a short human-readable form, or an empty string when there is none.
 */
function reasonSummary(reason) {
  if (reason === undefined || reason === null) return '';
  if (typeof reason !== 'object') return String(reason);
  const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown';
  const error = reason.error !== undefined && reason.error !== null && typeof reason.error === 'object' ? reason.error : undefined;
  const message = typeof error?.message === 'string' ? error.message : typeof reason.message === 'string' ? reason.message : undefined;
  const code = typeof error?.code === 'string' ? error.code : typeof reason.code === 'string' ? reason.code : undefined;
  return kind + (message === undefined ? '' : ': ' + message) + (code === undefined ? '' : ' [' + code + ']');
}

/**
 * Read the preset a caller is actually composed from.
 *
 * The live scope chain is the authority (a child whose durable header is still
 * being assembled has no preset event yet), with the session header as the
 * fallback, and the source is recorded so the audit says which one answered.
 * @param presets - the agentPresets service.
 * @param agent - the calling agent, or undefined.
 * @returns the preset id and where it came from.
 */
function readCallerPreset(presets, agent) {
  try {
    const live = presets.composedPreset(agent.ctx);
    if (typeof live === 'string' && live.length > 0) return { id: live, source: 'scope' };
  } catch (error) {
    /* fall through to the durable header */
  }
  try {
    const resolved = presets.resolveSessionPreset(agent.session);
    if (typeof resolved === 'string' && resolved.length > 0) return { id: resolved, source: 'session' };
  } catch (error) {
    /* unresolved */
  }
  const header = agent.session?.header?.agentPreset;
  if (typeof header === 'string' && header.length > 0) return { id: header, source: 'header' };
  return { id: 'unknown', source: 'none' };
}

/**
 * Count the seat's turns from an array index baseline.
 *
 * 'turn/start' and 'turn/end' are the only evidence that the seat did anything
 * at all: a turn that never started and a turn that ran without submitting a
 * receipt are different failures and must not be reported as the same one.
 * @param agent - the seat agent.
 * @param from - the events length observed before the followup.
 * @returns the observed turn counts.
 */
function observeTurns(agent, from) {
  const events = agent?.session?.snapshotEvents?.() ?? [];
  let started = 0;
  let ended = 0;
  let lastStart = -1;
  let lastEnd = -1;
  let lastReason;
  for (let index = from; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type === 'turn/start') {
      started += 1;
      lastStart = index;
    } else if (event?.type === 'turn/end') {
      ended += 1;
      lastEnd = index;
      const reason = event?.data?.reason;
      if (reason !== undefined && reason !== null) lastReason = structuredReason(reason);
    }
  }
  return { started, ended, openTurn: lastStart > lastEnd, lastReason };
}

/**
 * Read the lane the seat actually ran on out of its own transcript.
 *
 * This is the confound detector. A seat can say anything about its model; the
 * transcript records what the runtime used. The event shape is probed
 * defensively rather than assumed, and 'unknown' is a legitimate answer.
 * @param agent - the seat agent.
 * @param from - the events length observed before the followup.
 * @returns the observed 'provider/model', or undefined.
 */
function observeLane(agent, from) {
  const events = agent?.session?.snapshotEvents?.() ?? [];
  for (let index = events.length - 1; index >= from; index -= 1) {
    const data = events[index]?.data;
    if (data === undefined || data === null) continue;
    const message = data.message !== undefined && data.message !== null ? data.message : data.role !== undefined ? data : undefined;
    const source = message?.source;
    if (source?.kind !== 'model') continue;
    const provider = source.provider ?? source.providerId;
    const model = source.model ?? source.modelId;
    if (typeof model !== 'string' || model.length === 0) continue;
    return (typeof provider === 'string' && provider.length > 0 ? provider + '/' : '') + model;
  }
  return undefined;
}

/**
 * Build a typed model-interpreted intent record tied to the caller's durable
 * session and currently open turn. This record is descriptive; it does not
 * grant authority or select a capability.
 * @param agent - the calling General agent.
 * @param intent - one of the closed route intent classes.
 * @param reason - concise explanation for the selected intent.
 * @param decisionId - unique route-decision identity.
 * @param dispatchRunId - linked seat-dispatch identity, if one exists.
 * @param recorded - whether the decision has been appended to the route log.
 * @returns the immutable route-decision record.
 */
export function buildRoutingDecision(agent, intent, reason, decisionId = 'rd-' + randomUUID(), dispatchRunId = 'none', recorded = false) {
  if (!ROUTE_INTENTS.includes(intent)) throw new TypeError('routing intent is not in the closed route intent set');
  const session = agent?.session;
  let turnOrdinal = 0;
  let activeTurn;
  let events = [];
  try {
    const snapshot = session?.snapshotEvents?.();
    if (Array.isArray(snapshot)) events = snapshot;
  } catch (error) {
    events = [];
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type === 'turn/start') {
      turnOrdinal += 1;
      const storedTurn = event?.data?.turn;
      const storedSeq = event?.seq;
      activeTurn = {
        turnIndex: Number.isSafeInteger(storedTurn) && storedTurn > 0 ? storedTurn : turnOrdinal,
        eventIndex: Number.isSafeInteger(storedSeq) && storedSeq >= 0 ? storedSeq : index,
      };
    } else if (event?.type === 'turn/end') {
      activeTurn = undefined;
    }
  }
  return Object.freeze({
    decision_id: decisionId,
    intent,
    reason: typeof reason === 'string' ? reason.trim() : '',
    caller_session_id: typeof session?.id === 'string' && session.id.length > 0 ? session.id : receipt.NONE,
    caller_turn_index: activeTurn?.turnIndex ?? null,
    caller_turn_start_event_index: activeTurn?.eventIndex ?? null,
    dispatch_run_id: dispatchRunId,
    recorded: recorded === true,
  });
}

/**
 * Cancel a seat that will not report, then let the caller dispose it.
 * @param agent - the seat agent.
 * @param reason - the cancellation cause.
 */
async function cancelSeat(agent, reason) {
  if (agent === undefined || agent === null || typeof agent.cancel !== 'function') return;
  try {
    await agent.cancel(reason, { keepInbox: false });
    return;
  } catch (error) {
    /* fall through to the argument-free form */
  }
  try {
    await agent.cancel();
  } catch (error) {
    /* disposal still ends the loop */
  }
}

/**
 * Append one audit line.
 *
 * The audit is written before the value is returned, and its own failure is
 * reported in the value: a dispatch whose record could not be written is not
 * allowed to look like a clean one.
 * @param dir - audit directory.
 * @param record - the JSON-serializable record.
 * @returns the audit path, or an error string.
 */
async function writeJsonl(dir, filename, record) {
  const path = join(dir, filename);
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(path, JSON.stringify(record) + '\n', 'utf8');
    return { path, error: receipt.NONE };
  } catch (error) {
    return { path, error: describe(error) };
  }
}

/** Append one route-decision record independently from seat execution records. */
function writeRoutingAudit(dir, decision) {
  return writeJsonl(dir, 'routing-decisions.jsonl', {
    record_type: 'routing-decision',
    ts: new Date().toISOString(),
    ...decision,
  });
}

/** Append one seat-dispatch audit line. */
function writeAudit(dir, record) {
  return writeJsonl(dir, 'seat-dispatch.jsonl', record);
}

/** The record of one resolved seat in the dispatch value. */
function seatReceiptProjection(value) {
  if (value === undefined) return {};
  return {
    verdict: value.verdict,
    summary: value.summary,
    artifacts: [...value.artifacts],
    evidence: [...value.evidence],
    blockers: [...value.blockers],
    archon_run_id: value.archon_run_id,
    archon_status: value.archon_status,
    archon_artifact_dir: value.archon_artifact_dir,
    lane: value.lane,
    next: value.next,
  };
}

/** Record a model-interpreted route and arm only this turn's procedural handoff. */
async function persistRoutingDecision(config, pending, args, exec) {
  const intent = args?.intent;
  if (!ROUTE_INTENTS.includes(intent)) throw new TypeError('routing intent is not in the closed route intent set');
  const rawReason = typeof args?.reason === 'string' ? args.reason : '';
  const decision = buildRoutingDecision(exec?.agent, intent, rawReason);
  if (decision.reason.length === 0 || decision.reason.length > 2000) {
    return { accepted: false, decision, audit_log: receipt.NONE, audit_error: 'reason must be non-empty and no longer than 2000 characters' };
  }
  if (decision.caller_session_id === receipt.NONE || decision.caller_turn_index === null) {
    return { accepted: false, decision, audit_log: receipt.NONE, audit_error: 'route decision could not bind to an active caller session turn' };
  }

  const persisted = Object.freeze({ ...decision, recorded: true });
  const audited = await writeRoutingAudit(config.auditDir, persisted);
  if (audited.error !== receipt.NONE) {
    return {
      accepted: false,
      decision,
      audit_log: audited.path,
      audit_error: audited.error,
    };
  }

  /* Only the most recent classification for a caller session can authorize a
   * handoff. Old ids remain in the append-only log but cannot be replayed. */
  for (const [id, previous] of pending) {
    if (previous.caller_session_id === persisted.caller_session_id) pending.delete(id);
  }
  pending.set(persisted.decision_id, persisted);
  while (pending.size > MAX_PENDING_ROUTE_DECISIONS) pending.delete(pending.keys().next().value);
  return { accepted: true, decision: persisted, audit_log: audited.path, audit_error: receipt.NONE };
}

/** Render the route tool's durable outcome in a compact, readable form. */
function renderRoutingDecision(_args, value) {
  const decision = value.decision;
  return [{
    type: 'text',
    text: value.accepted
      ? 'routing decision recorded: ' + decision.intent + ' id=' + decision.decision_id + ' session=' + decision.caller_session_id + ' turn=' + decision.caller_turn_index
      : 'routing decision refused: ' + value.audit_error,
  }];
}

/**
 * Register the route recorder and the one governed execution tool in General.
 * @param ctx - the plugin context (the caller preset's layer).
 * @param config - the resolved plugin config.
 */
export function apply(ctx, config) {
  const pending = new Map();
  ctx.tools.register(defineTool({
    name: 'record_routing_decision',
    description: 'Persist the model-interpreted handling choice for this user request: conversational, read_only_inquiry, clarification, or procedural_handoff. This tool only records intent; it does not grant permissions, select capabilities, create a seat, or run work. Record one decision before answering or handing work off. A procedural_handoff id is required by dispatch_seat in the same active turn.',
    parameters: ROUTING_DECISION_PARAMETERS,
    output: { schema: ROUTING_DECISION_TOOL_OUTPUT, render: renderRoutingDecision },
    execute: (args, exec) => persistRoutingDecision(config, pending, args, exec),
  }));
  ctx.tools.register(defineTool({
    name: 'dispatch_seat',
    description: 'Run exactly one governed turn in a fresh-root agent seat composed from ANOTHER preset, and return that seat receipt: verdict ship|fix|blocked|pending, artifacts, evidence, the real Archon run id with its machine-readable status, the lane it actually ran on, and the next action. Use it only after record_routing_decision returned a procedural_handoff decision id for this active turn. You supply that id, the objective, what done means, and the constraints; the target preset alone owns the seat tools, prompt, and model, and nothing it gains comes back to this seat. The seat must submit one receipt with its direct tool; a missing, refused, or invalid receipt is reported as a blocked dispatch and never as success.',
    parameters: dispatchParameters(config),
    output: { schema: DISPATCH_OUTPUT, render: renderDispatch },
    timeoutMs: clampBudget(undefined, config.timeoutMs) + 120000,
    execute: (args, exec) => dispatchSeat(ctx, config, args, exec, pending),
  }));
}

/** One model-facing summary of a completed or failed dispatch. */
export function renderDispatch(args, value) {
  const lines = [
    'dispatch_seat ' + (value.verdict === 'pending' ? 'PENDING' : value.ok ? 'OK' : 'NOT-OK')
      + ' stage=' + value.stage
      + ' verdict=' + value.verdict
      + ' seat=' + value.dispatch.seat
      + ' run=' + value.dispatch.run_id,
  ];
  lines.push('routing: decision=' + value.routing.decision_id
    + ' intent=' + value.routing.intent
    + ' session=' + value.routing.caller_session_id
    + ' turn=' + (value.routing.caller_turn_index ?? 'unknown')
    + ' recorded=' + value.routing.recorded
    + ' reason=' + value.routing.reason);
  lines.push(value.detail);
  const reported = value.receipt;
  if (reported !== undefined && reported.summary !== undefined) {
    lines.push('summary: ' + reported.summary);
    if (Array.isArray(reported.evidence) && reported.evidence.length > 0) lines.push('evidence: ' + reported.evidence.join(' | '));
    if (Array.isArray(reported.blockers) && reported.blockers.length > 0) lines.push('blockers: ' + reported.blockers.join(' | '));
    lines.push('archon: status=' + reported.archon_status + ' run=' + reported.archon_run_id + ' artifacts=' + reported.archon_artifact_dir);
    lines.push('next: ' + reported.next);
  }
  lines.push('lane: declared=' + value.lane.declared + ' observed=' + value.lane.observed + (value.lane.mismatch ? ' MISMATCH' : ''));
  if (value.warnings.length > 0) lines.push('warnings: ' + value.warnings.join(' | '));
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Dispatch one seat and wait for its receipt.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin config.
 * @param args - validated tool arguments.
 * @param exec - the tool execution context (caller agent, signal).
 * @returns the canonical dispatch value.
 */
function resolveDispatchRoute(pending, callerAgent, requestedId, runId) {
  const id = typeof requestedId === 'string' && requestedId.length > 0 ? requestedId : receipt.NONE;
  const decision = pending.get(id);
  if (decision === undefined) {
    return {
      decision: buildRoutingDecision(callerAgent, 'procedural_handoff', '', id, runId, false),
      issue: 'dispatch_seat requires a persisted routing decision id from record_routing_decision in this active turn; no seat was created.',
    };
  }
  pending.delete(id);
  const linked = Object.freeze({ ...decision, dispatch_run_id: runId });
  if (decision.intent !== 'procedural_handoff') {
    return {
      decision: linked,
      issue: 'dispatch_seat requires a procedural_handoff routing decision; the recorded intent was ' + decision.intent + '.',
    };
  }
  const active = buildRoutingDecision(callerAgent, 'procedural_handoff', decision.reason, decision.decision_id, runId, false);
  if (active.caller_session_id !== decision.caller_session_id
    || active.caller_turn_index !== decision.caller_turn_index
    || active.caller_turn_start_event_index !== decision.caller_turn_start_event_index) {
    return {
      decision: linked,
      issue: 'the recorded procedural_handoff belongs to a different or closed caller session turn; no seat was created.',
    };
  }
  if (decision.recorded !== true) {
    return {
      decision: linked,
      issue: 'the procedural_handoff decision was not durably recorded; no seat was created.',
    };
  }
  return { decision: linked, issue: undefined };
}

async function dispatchSeat(ctx, config, args, exec, pendingRouteDecisions) {
  const startedAt = Date.now();
  const runId = receipt.mintRunId();
  const callerAgent = exec?.agent;
  const route = resolveDispatchRoute(pendingRouteDecisions, callerAgent, args?.routing_decision_id, runId);
  const routeDecision = route.decision;
  const state = {
    runId,
    routeDecision,
    routingIssue: route.issue,
    seat: String(args.seat),
    stage: 'authority',
    detail: '',
    warnings: [],
    receipt: undefined,
    receiptAccepted: false,
    attempts: 0,
    refusals: 0,
    receiptsSeen: 0,
    turns: { started: 0, ended: 0, openTurn: false, lastReason: undefined },
    seatSessionId: receipt.NONE,
    seatLane: 'unknown',
    laneMismatch: false,
    laneObserved: undefined,
    callerSessionId: routeDecision.caller_session_id,
    callerPreset: 'unknown',
    presetSource: 'none',
    callerDepth: 0,
    callerParentSession: receipt.NONE,
    callerOrigin: receipt.NONE,
    authorityBasis: 'unknown',
    callerLaneExpectation: typeof args.lane_expectation === 'string' && args.lane_expectation.length > 0 ? args.lane_expectation : receipt.NONE,
    auditLog: receipt.NONE,
    auditError: receipt.NONE,
    startedAt,
  };

  const presets = ctx.agentPresets;
  const callerSession = callerAgent?.session;
  let handle;

  /**
   * Build the canonical value, dispose the seat, and append the audit line.
   * Every exit from this function goes through here, so no path can return
   * without either disposing the seat or recording why it could not.
   * @param stage - where the dispatch ended.
   * @param detail - the actionable sentence for the caller.
   * @param extra - additional state to fold in before building the value.
   * @returns the canonical value.
   */
  const settle = async (stage, detail, extra) => {
    state.stage = stage;
    state.detail = detail;
    if (extra !== undefined) Object.assign(state, extra);
    if (handle !== undefined) {
      try {
        await handle.dispose();
        handle = undefined;
      } catch (error) {
        state.warnings.push('seat disposal failed: ' + describe(error));
      }
    }
    state.archonBinding = state.runObserver?.get(state.receipt?.archon_run_id);
    if (state.receipt?.verdict === 'pending' && state.archonBinding) {
      state.receipt = Object.freeze({ ...state.receipt,
        next: 'Use archon_dispatch_status with dispatch_id ' + state.archonBinding.dispatch_id + ' from this same chat to check Archon run ' + state.archonBinding.run_id + '. Do not start another workflow.',
      });
    }
    const value = buildValue(state);
    const audited = await writeAudit(config.auditDir, auditRecord(state, value));
    state.auditLog = audited.path;
    state.auditError = audited.error;
    value.dispatch.audit_log = audited.path;
    value.dispatch.audit_error = audited.error;
    value.dispatch.duration_ms = Date.now() - startedAt;
    if (audited.error !== receipt.NONE) value.warnings.push('audit log could not be written: ' + audited.error);
    return value;
  };

  try {
    /* 1. Authority: the caller's own composition, read live, not asserted. */
    if (callerAgent === undefined || callerAgent === null) {
      return await settle('authority', 'dispatch_seat requires a calling agent; the runtime supplied none.');
    }
    if (state.routingIssue !== undefined) {
      return await settle('authority-route', state.routingIssue);
    }
    if (routeDecision.reason.length === 0 || routeDecision.reason.length > 2000) {
      return await settle('authority', 'dispatch_seat requires a concise, non-empty reason for the procedural handoff (maximum 2000 characters).');
    }
    if (routeDecision.caller_session_id === receipt.NONE || routeDecision.caller_turn_index === null) {
      return await settle('authority', 'dispatch_seat could not bind this procedural handoff to an active caller session turn; no seat was created.');
    }
    const caller = readCallerPreset(presets, callerAgent);
    state.callerPreset = caller.id;
    state.presetSource = caller.source;
    state.callerSessionId = typeof callerSession?.id === 'string' ? callerSession.id : receipt.NONE;
    /* Root ownership, read only from trusted runtime session state -- never from
     * the caller's own arguments.
     *
     * parentSession alone is NOT the load-bearing record, and treating it as one
     * is a false positive with a permanent blast radius. TWO distinct mechanisms
     * write a session header, and only one of them is delegation:
     *
     *   - DELEGATION stamps origin 'subagent' + delegationDepth = parent+1 +
     *     parentSession (dsh-subagent childSessionMeta(), and this tool's own
     *     meta at create() below, which stamps the same trio).
     *   - FORK stamps parentSession ALONE -- session store fork() copies cwd and
     *     parentSession from the live source and nothing else, so a forked
     *     session has a parentSession header while carrying no origin and
     *     delegationDepth 0. It is a fresh root of its own preset, not a child.
     *
     * So the discriminator is the recorded delegation record -- origin and
     * depth -- never the mere presence of a parentSession header. Measured on
     * this box's 966 stored sessions: 603 carry origin 'subagent', 359 carry no
     * parentSession, and exactly 4 carry the fork shape (parentSession, no
     * origin, delegationDepth 0). The partition is exact; the header presence
     * test was the only thing conflating the fork with a child.
     *
     * state.callerParentSession is recorded for the detail sentence and the
     * audit trail, never as evidence of delegation. The monotone direction of
     * @deepseek-ai/dsh-subagent delegationDepthOf() is preserved: origin and
     * depth can only ever ADD a refusal, never remove one. */
    const callerHeader = callerSession?.header ?? {};
    const depthOf = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);
    state.callerDepth = Math.max(depthOf(callerHeader.delegationDepth), depthOf(callerAgent?.options?.subagentDepth));
    state.callerParentSession = typeof callerHeader.parentSession === 'string' && callerHeader.parentSession.length > 0 ? callerHeader.parentSession : receipt.NONE;
    state.callerOrigin = typeof callerHeader.origin === 'string' && callerHeader.origin.length > 0 ? callerHeader.origin : receipt.NONE;
    const delegated = state.callerOrigin === 'subagent' || state.callerDepth > 0;
    /* The machine-checkable reason for the decision this gate just made. A
     * genuine top-level session and a forked one both satisfy ROOT-ONLY; they
     * are kept as separate values so the audit can always tell them apart. */
    state.authorityBasis = delegated
      ? 'delegated-child'
      : (state.callerParentSession === receipt.NONE ? 'no-parent-root' : 'lineage-clean-root');
    if (caller.id !== config.callerPreset) {
      return await settle(
        'authority',
        'dispatch_seat is callable only from the "' + config.callerPreset + '" seat; this session is composed from "' + caller.id + '" (read from the ' + caller.source + '). A seat cannot dispatch seats.',
      );
    }

    /* v0 authority is ROOT-ONLY: the top-level General seat, not a delegated child
     * that merely happens to be composed from the same preset. */
    if (delegated) {
      return await settle(
        'authority-root',
        'dispatch_seat is callable only from the top-level "' + config.callerPreset + '" seat; this caller is a delegated agent (parentSession ' + state.callerParentSession + ', origin ' + state.callerOrigin + ', delegationDepth ' + state.callerDepth + '). A delegated agent cannot dispatch seats.',
      );
    }

    /* 2. Only the configured seats are dispatchable. */
    if (!config.seats.includes(state.seat)) {
      return await settle(
        'authority-seat',
        'seat "' + state.seat + '" is not dispatchable from this composition; dispatchable seats: ' + config.seats.join(', ') + '.',
      );
    }

    /* 3. The mount primitive must exist before anything is created: an
     *    unmountable seat would join the caller's composition instead. */
    if (typeof presets?.mount !== 'function') {
      return await settle('resolve', 'the agentPresets service exposes no mount(); a fresh-root seat cannot be composed, and a child that cannot mount must not be created.');
    }

    /* 4. Run identity and the one-shot receipt slot. The receipt tool is built
     *    before create() because setup() may run during it. */
    let settleReceipt;
    const receiptPromise = new Promise((resolve) => {
      settleReceipt = resolve;
    });
    const submit = (attempt, execution) => {
      state.attempts += 1;
      if (handle === undefined || execution?.agent !== handle.agent) {
        state.refusals += 1;
        return { accepted: false, violations: ['this tool belongs to one dispatch and one seat agent; the caller is neither'], run_id: state.runId };
      }
      if (state.receiptAccepted) {
        state.refusals += 1;
        return { accepted: false, violations: ['a receipt was already accepted for this dispatch'], run_id: state.runId };
      }
      const violations = [...receipt.validateReceipt(attempt), ...state.runObserver.receiptViolations(attempt)];
      if (violations.length > 0) {
        /* An invalid receipt is refused WITH its violations and does not
         * consume the one-shot slot: the contract is correctable, it is just
         * not ignorable. */
        state.refusals += 1;
        return { accepted: false, violations, run_id: state.runId };
      }
      state.receiptsSeen += 1;
      state.receipt = receipt.normalizeReceipt(attempt);
      state.receiptAccepted = true;
      settleReceipt(state.receipt);
      return { accepted: true, violations: [], run_id: state.runId };
    };
    const receiptTool = buildReceiptTool({ submit });

    /* 5. Compose the seat: mount the target preset, then register the receipt
     *    tool on the seat's own scope. Order matters -- the receipt tool is a
     *    registration of the dispatched agent, and the mount is what makes the
     *    agent a genuine fresh root of the target preset. */
    const seatSessionId = SessionId(randomUUID());
    state.seatSessionId = seatSessionId;
    state.runObserver = createDispatchRunObserver({ dispatchId: state.runId, callerSessionId: state.callerSessionId, seatSessionId });
    const meta = {
      origin: 'subagent',
      delegationDepth: state.callerDepth + 1,
      agentPreset: state.seat,
    };
    if (typeof callerSession?.id === 'string') meta.parentSession = callerSession.id;
    const cwd = callerSession?.header?.cwd;
    if (typeof cwd === 'string' && cwd.length > 0) meta.cwd = cwd;
    try {
      handle = await ctx.agents.create({
        sessionId: seatSessionId,
        meta,
        /* The seat's route comes from the caller, like any other child agent's:
         * a seat created without one is unrunnable before its first request. */
        agentOptions: inheritAgentOptions(callerAgent, ctx),
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, state.seat);
          agentCtx.on('tools/result', state.runObserver.observe);
          agentCtx.tools.register(receiptTool);
        },
      });
    } catch (error) {
      const message = describe(error);
      const unknownPreset = /unknown preset|UnknownPreset|preset .* not found/i.test(message);
      return await settle(
        unknownPreset ? 'resolve' : 'create',
        'the "' + state.seat + '" seat could not be composed: ' + message,
      );
    }

    /* 6. Baseline the transcript before the single followup, so turn evidence
     *    and lane evidence are attributable to THIS dispatch only. */
    const from = handle.agent.session.snapshotEvents?.().length ?? 0;
    state.fromIndex = from;

    /* This is the seat's request seed, not proof of the executed route: the
     * runtime request waterfall can change it. Give the seat the exact IDs for
     * reporting, while observeLane remains the independent source of truth. */
    const seatOptions = handle.agent.options;
    const seatConfiguredLane = typeof seatOptions?.provider === 'string' && seatOptions.provider.length > 0
      && typeof seatOptions?.model === 'string' && seatOptions.model.length > 0
      ? seatOptions.provider + '/' + seatOptions.model : undefined;
    const envelope = receipt.renderEnvelope({
      runId: state.runId,
      routeDecisionId: routeDecision.decision_id,
      seat: state.seat,
      callerSessionId: state.callerSessionId,
      callerPreset: state.callerPreset,
      seatSessionId,
      delegationDepth: meta.delegationDepth,
      seatConfiguredLane,
      laneExpectation: state.callerLaneExpectation === receipt.NONE ? undefined : state.callerLaneExpectation,
      objective: args.objective,
      doneWhen: args.done_when,
      reason: routeDecision.reason,
      constraints: Array.isArray(args.constraints) ? args.constraints.map((item) => String(item)) : [],
      context: typeof args.context === 'string' && args.context.length > 0 ? args.context : undefined,
    });

    /* 7. Exactly one turn. */
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: envelope }],
      /* v4 session format rejects the retired bare 'plugin' source kind; a
       * plugin-produced message must carry its producer-owned 'plugin:<name>' kind. */
      source: { kind: 'plugin:' + name },
    }));

    /* 8. Wait: the receipt is the only success, a drained turn is not. */
    const budget = clampBudget(args.timeout_ms, config.timeoutMs);
    const deadline = Date.now() + budget;
    const startupDeadline = Date.now() + Math.min(config.startupGraceMs, budget);
    let idleSince;
    let outcome = 'timeout';
    for (;;) {
      if (state.receiptAccepted) {
        outcome = 'receipt';
        break;
      }
      state.turns = observeTurns(handle.agent, from);
      if (exec?.signal?.aborted === true) {
        outcome = 'aborted';
        break;
      }
      const now = Date.now();
      if (state.turns.started === 0) {
        if (now > startupDeadline) {
          outcome = 'never-started';
          break;
        }
      } else if (state.turns.openTurn === false && state.turns.ended >= state.turns.started) {
        if (idleSince === undefined) idleSince = now;
        else if (now - idleSince >= config.graceMs) {
          outcome = 'receipt-missing';
          break;
        }
      } else {
        idleSince = undefined;
      }
      if (now > deadline) {
        outcome = 'timeout';
        break;
      }
      await sleep(POLL_MS);
    }

    if (outcome !== 'receipt') {
      await cancelSeat(handle.agent, 'seat dispatch ' + state.runId + ': ' + outcome);
      state.turns = observeTurns(handle.agent, from);
      const observed = observeLane(handle.agent, from);
      const details = {
        timeout: 'the seat did not submit a receipt within ' + budget + ' ms; it was cancelled. A dispatch is never inferred from a running seat.',
        aborted: 'the caller cancelled this dispatch before the seat submitted a receipt; the seat was cancelled with it.',
        'never-started': 'the seat never started a turn within ' + config.startupGraceMs + ' ms; nothing was executed.',
        'receipt-missing': 'the seat finished ' + state.turns.started + ' turn(s) without submitting a receipt, so there is no authoritative verdict to report. Treat as blocked: the work may or may not have happened.',
      };
      state.laneObserved = observed;
      state.seatLane = observed ?? 'unknown';
      return await settle(
        outcome === 'never-started' ? 'receipt-missing' : outcome,
        details[outcome] ?? details.timeout,
        { laneMismatch: false },
      );
    }

    /* 9. A receipt arrived. Let the transcript drain briefly for completeness,
     *    then stop: the receipt is the boundary and nothing after it is read. */
    try {
      await Promise.race([handle.agent.whenIdle(), sleep(config.drainMs)]);
    } catch (error) {
      /* a drain failure cannot invalidate an already accepted receipt */
    }
    state.turns = observeTurns(handle.agent, from);
    const observed = observeLane(handle.agent, from);
    const declared = state.receipt.lane;
    const mismatch = receipt.lanesConflict(declared, observed);
    const warnings = receipt.receiptWarnings(state.receipt);
    if (observed === undefined) {
      warnings.push('lane not observable: no model-sourced event in the seat transcript, so the declared lane is unverified');
    } else {
      state.seatLane = observed;
      if (mismatch) warnings.push('lane mismatch: the seat declared "' + declared + '" but its transcript shows "' + observed + '"');
    }
    /* caller_expectation is recorded-only telemetry: it never participates in any
     * authority decision or in the verdict. A disagreement with the observed lane
     * is surfaced as a warning so the confound is visible, and nothing more. */
    if (observed !== undefined && state.callerLaneExpectation !== receipt.NONE && receipt.laneExpectationConflicts(state.callerLaneExpectation, observed)) {
      warnings.push('caller lane expectation not met: the caller expected "' + state.callerLaneExpectation + '" but the seat ran on "' + observed + '" (recorded telemetry, never an authority decision)');
    }
    if (state.turns.started > 1) warnings.push('the seat ran ' + state.turns.started + ' turns; a dispatch is one turn, so later turns were not read');
    if (state.refusals > 0) warnings.push(state.refusals + ' receipt submission(s) were refused before one was accepted');
    state.laneObserved = observed;
    state.laneMismatch = mismatch;
    const verdict = state.receipt.verdict;
    return await settle(
      'complete',
      'the seat answered with verdict "' + verdict + '" on ' + state.turns.started + ' turn(s)' + (state.turns.lastReason === undefined ? '' : ' (last turn ended: ' + reasonSummary(state.turns.lastReason) + ')') + '. Receipt run identity and status were checked against this seat canonical tool results; summary and evidence text remain seat reports.',
      { warnings },
    );
  } catch (error) {
    return await settle('error', 'dispatch_seat failed unexpectedly: ' + describe(error));
  }
}

/**
 * Compose the canonical value from the accumulated state.
 *
 * Exported because the tool's declared output schema and this builder are one
 * contract: the test asserts they declare exactly the same fields, so a value
 * the runtime would reject cannot ship.
 * @param state - the accumulated dispatch state.
 * @returns the canonical dispatch value.
 */
export function buildValue(state) {
  const reported = state.receipt;
  const missingReceiptReason = state.stage === 'receipt-missing' && state.turns.lastReason?.kind === 'error'
    ? ' Last turn ended: ' + reasonSummary(state.turns.lastReason)
    : '';
  return {
    ok: state.stage === 'complete' && reported !== undefined && (reported.verdict === 'ship' || reported.verdict === 'fix'),
    stage: state.stage,
    verdict: reported === undefined ? 'blocked' : reported.verdict,
    detail: state.detail + missingReceiptReason,
    warnings: [...state.warnings],
    routing: state.routeDecision ?? buildRoutingDecision(undefined, 'procedural_handoff', '', 'none', 'none', false),
    lane: {
      declared: reported === undefined ? receipt.NONE : reported.lane,
      observed: state.laneObserved === undefined ? state.seatLane : state.laneObserved,
      mismatch: state.laneMismatch === true,
      caller_expectation: state.callerLaneExpectation,
    },
    dispatch: {
      run_id: state.runId,
      seat: state.seat,
      seat_session_id: state.seatSessionId,
      caller_session_id: state.callerSessionId,
      caller_preset: state.callerPreset,
      preset_source: state.presetSource,
      caller_depth: state.callerDepth,
      authority_basis: state.authorityBasis ?? 'unknown',
      turns_observed: state.turns.started,
      turn_started: state.turns.started > 0,
      duration_ms: Date.now() - state.startedAt,
      receipt_accepted: state.receiptAccepted,
      receipt_attempts: state.attempts,
      receipt_refusals: state.refusals,
      receipts_seen: state.receiptsSeen,
      audit_log: state.auditLog,
      audit_error: state.auditError,
    },
    receipt: seatReceiptProjection(reported),
  };
}

/** The append-only audit record: one line per dispatch, refusals included. */
function auditRecord(state, value) {
  return {
    ts: new Date().toISOString(),
    run_id: state.runId,
    stage: state.stage,
    ok: value.ok,
    verdict: value.verdict,
    seat: state.seat,
    caller_session_id: state.callerSessionId,
    caller_preset: state.callerPreset,
    preset_source: state.presetSource,
    caller_depth: state.callerDepth,
    /* Additive (lineage repair, 2026-09-13): the machine-checkable reason for the
     * authority decision above. Existing fields keep their exact names and
     * meanings; this one is new and is the field an operator checks after the
     * restart to confirm a forked General was admitted:
     *   lineage-clean-root -- accepted: forked caller, no delegation record
     *   no-parent-root     -- accepted: true top-level session, no parentSession
     *   delegated-child    -- refused: origin 'subagent' and/or depth > 0
     *   not-caller-preset / unknown -- the other two gate exits. */
    authority_basis: state.authorityBasis ?? 'unknown',
    caller_parent_session: state.callerParentSession ?? receipt.NONE,
    caller_origin: state.callerOrigin ?? receipt.NONE,
    seat_session_id: state.seatSessionId,
    from_index: state.fromIndex ?? null,
    turns_observed: state.turns.started,
    turn_started: state.turns.started > 0,
    last_turn_reason: state.turns.lastReason ?? null,
    duration_ms: Date.now() - state.startedAt,
    receipt_accepted: state.receiptAccepted,
    receipt_attempts: state.attempts,
    receipt_refusals: state.refusals,
    lane: {
      declared: state.receipt === undefined ? null : state.receipt.lane,
      observed: state.laneObserved ?? null,
      caller_expectation: state.callerLaneExpectation,
      mismatch: state.laneMismatch === true,
    },
    archon: {
      run_id: state.receipt === undefined ? null : state.receipt.archon_run_id,
      status: state.receipt === undefined ? null : state.receipt.archon_status,
      artifact_dir: state.receipt === undefined ? null : state.receipt.archon_artifact_dir,
    },
    archon_binding: state.archonBinding ?? null,
    artifacts: state.receipt === undefined ? [] : [...state.receipt.artifacts],
    warnings: [...state.warnings],
    detail: state.detail,
    routing: state.routeDecision,
  };
}
