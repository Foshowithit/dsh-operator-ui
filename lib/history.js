// dsh-operator-ui — M2.5: Capability Memory & Lifecycle (GPT directive).
//
// RCOS acquires Intelligence (M2); now it must know whether that
// Intelligence CONTINUES deserving trust. This module derives per-capability
// OPERATING HISTORY from the durable task envelopes — it is a READ MODEL
// over tasks.json + the registry, never a new store and never a copied
// state: delete nothing, invent nothing.
//
// Lifecycle: PROMOTED → USED → OBSERVED → RE-EVALUATED → IMPROVED /
// SUPERSEDED / RETIRED. History feeds OBSERVED and RE-EVALUATED:
//   uses, objective-satisfaction record, blocks after clean execution,
//   last-verified time, held-out eval record, version lineage.
//
// HARD RULE (GPT): do NOT collapse history into one "confidence score".
// The underlying evidence stays inspectable — every number here can be
// opened to the tasks it came from.
//
// Decay changes TRUST, not silence: a capability whose recent record
// degrades is flagged "Needs re-evaluation" with the reason; routing
// continues conditionally unless the operator retires it (existing
// lifecycle status). Version evolution never overwrites history: newer
// versions link back through provenance (improvedFrom) and the old
// version stays reconstructable.

import { listTasks } from './tasks.js';

const isoNow = () => new Date().toISOString();

// How many recent outcomes the decay window watches (GPT: "2 of last 5").
const DECAY_WINDOW = 5;
const DECAY_THRESHOLD = 2;

// One goal outcome for one capability, normalized from its envelope.
// Only goals that actually EXECUTED count as uses — refusals and
// awaiting-approval envelopes evaluated nothing and vouch for nothing.
function outcomeOf(g) {
  const attempts = g.attempts || [];
  if (!attempts.some((a) => a.runId)) return null; // never executed
  const v = typeof g.verdict === 'string' ? g.verdict : (g.verdict && g.verdict.decision) || null;
  const codes = Array.isArray(g.failureCodes) ? g.failureCodes : (g.verdict && g.verdict.failureCodes) || [];
  const obj = g.objectiveEvaluation || null;
  return {
    taskId: g.taskId,
    at: g.endedAt || g.createdAt || null,
    decision: v,
    // An OUTCOME-UNKNOWN refusal is not a quality datapoint about the
    // capability: an Archon outage (or a record we could not use as evidence)
    // means we could not establish the outcome at all, so it can neither count
    // as a missed objective nor help reach the decay window. It is still
    // RECORDED — "we could not establish the outcome" is worth keeping, it just
    // must not be scored. Same vocabulary the goal path seals (lib/goal.js
    // OUTCOME_UNKNOWN_CODES -> verdict UNKNOWN).
    outcomeUnknown: v === 'UNKNOWN',
    objectiveSatisfied: !!(obj && obj.pass),
    // BLOCK after clean execution: the capability ran its expectation fine
    // but the objective was still not satisfied — the sharpest decay signal.
    blockAfterExecution: v === 'BLOCK' && codes.includes('objective-not-satisfied'),
    failureCodes: codes,
  };
}

// Per-capability operating history over ALL durable goal envelopes.
export async function capabilityHistory() {
  const tasks = await listTasks();
  const byCap = {};
  for (const g of tasks) {
    if (g.kind !== 'goal') continue;
    const capId = g.route && g.route.selected && g.route.selected.id;
    if (!capId) continue;
    const o = outcomeOf(g);
    if (!o) continue;
    (byCap[capId] = byCap[capId] || { uses: 0, objectivesSatisfied: 0, objectivesMissed: 0, outcomesUnknown: 0, blocksAfterExecution: 0, lastVerifiedAt: null, lastUsedAt: null, recent: [] });
    const h = byCap[capId];
    // The USE is recorded either way: the capability was invoked and a run was
    // adopted. What an outage must not do is land in the quality columns — so it
    // gets its own counter instead of `objectivesMissed`.
    h.uses += 1;
    if (o.outcomeUnknown) h.outcomesUnknown += 1;
    else if (o.objectiveSatisfied) h.objectivesSatisfied += 1;
    else h.objectivesMissed += 1;
    if (o.blockAfterExecution) h.blocksAfterExecution += 1;
    if (o.decision === 'SHIP' && (!h.lastVerifiedAt || o.at > h.lastVerifiedAt)) h.lastVerifiedAt = o.at;
    if (!h.lastUsedAt || o.at > h.lastUsedAt) h.lastUsedAt = o.at;
    h.recent.push(o);
  }
  for (const id of Object.keys(byCap)) {
    const h = byCap[id];
    h.recent = h.recent.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, DECAY_WINDOW);
    // The decay window is measured over ESTABLISHED outcomes only. An
    // outcome-unknown observation stays in `recent` (it is worth keeping) but
    // contributes in NEITHER direction: it is not a miss, and it does not help
    // reach the window size. Counting it in the denominator would let an Archon
    // outage tip a capability into "needs re-evaluation" — the exact defect this
    // accounting exists to prevent.
    const established = h.recent.filter((o) => !o.outcomeUnknown);
    const missedRecent = established.filter((o) => !o.objectiveSatisfied).length;
    h.recentEstablished = established.length;
    h.recentMissed = missedRecent;
    // Decay: the recent record, named plainly. Never a score — the recent
    // outcomes themselves are the display.
    h.needsReevaluation = established.length >= 3 && missedRecent >= DECAY_THRESHOLD;
    h.decayReason = h.needsReevaluation
      ? missedRecent + ' of last ' + established.length + ' established objectives were not satisfied.'
      : null;
  }
  return { at: isoNow(), decayWindow: DECAY_WINDOW, decayThreshold: DECAY_THRESHOLD, capabilities: byCap };
}

// Human lines for the Intelligence card (GPT's card grammar):
//   18 uses · 17 objectives satisfied · last verified 2h ago
export function historyLines(h) {
  if (!h || !h.uses) return null;
  const verified = h.lastVerifiedAt ? 'last verified ' + relTime(h.lastVerifiedAt) : 'never SHIP-verified';
  // The line does arithmetic the reader will do too: `uses` counts every
  // invocation, `objectivesSatisfied` counts only established ones, so without
  // this clause 18 uses against 17 satisfied READS as one missed objective —
  // which is the collapse this accounting exists to prevent, one layer up. The
  // clause is emitted ONLY when an unknown observation exists, so a capability
  // with no outages produces the identical line it always did.
  const unknown = h.outcomesUnknown > 0
    ? h.outcomesUnknown + ' outcome' + (h.outcomesUnknown === 1 ? '' : 's') + ' unknown \u00b7 '
    : '';
  return h.uses + ' use' + (h.uses === 1 ? '' : 's') + ' \u00b7 ' + h.objectivesSatisfied + ' objective' + (h.objectivesSatisfied === 1 ? '' : 's') + ' satisfied \u00b7 ' + unknown + verified;
}

function relTime(ts) {
  const then = Date.parse(ts);
  if (isNaN(then)) return String(ts);
  const m = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (m < 60) return m + 'm ago';
  const hr = Math.round(m / 60);
  if (hr < 48) return hr + 'h ago';
  return Math.round(hr / 24) + 'd ago';
}
