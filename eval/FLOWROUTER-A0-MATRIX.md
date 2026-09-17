# FlowRouter A0 — Cross-Phase Adversarial Campaign (matrix frozen before execution)

Status: matrix frozen; execution follows in a separate commit.
Scope: composition-level attacks against the seams between already-sealed phases.
No protocol expansion. No phase is reopened unless the campaign produces
contradictory evidence against that phase's EARNED claim.

Governing rule (frozen):

> **Composition may reduce availability or increase work. It must not
> manufacture authority.**

Harmless failure is not a defect. Each attack below states its success
criterion in advance; criteria are not moved after results are visible.

Topology per attack: publisher P, origin R1, mirror R2, destination R3,
consumer B, configured directory Q — with the hostile parts introduced by the
attacker named in the case.

## A0-1 — Lying directory + poisoned possession index

**Setup**: Q returns an endpoint that (a) holds nothing for the name, and
(b) whose possession index lists a tuple it cannot produce.
**Success criterion**: discovery yields candidates; every downstream step either
resolves to the honest tuple or refuses; no pin, registry, admission, quarantine
or routing change occurs anywhere; nothing is admitted.

## A0-2 — Directory endpoint disappears after selection

**Setup**: Q returns an endpoint; the endpoint's listener is killed after the
selection but before the consumer path.
**Success criterion**: the consumer's F0 observation is ABSENT/UNAVAILABLE, its
candidate set is empty or non-VALID, and no consumer-local trust state changes.
Availability loss only.

## A0-3 — S0 source dies halfway through a mixed scope

**Setup**: one scope with publication + blob + proof intents; the source is
killed after the first intent commits.
**Success criterion**: the committed object survives, the rest are
UNAVAILABLE/REFUSED, no rollback occurs, no trust state changes, and the run
records only custody outcomes.

## A0-4 — R0 conflict while F1 fork evidence exists

**Setup**: the same tuple with a different D exists at the source while two
non-comparable publisher histories are observable across repositories.
**Success criterion**: S0 refuses the conflicting backfill (state byte-identical)
AND the consumer still obtains a verifying F1 proof core through F0/F1 —
replication neither suppresses nor manufactures the fork evidence.

## A0-5 — Stale/false claimed_D plus mirror failover

**Setup**: an index advertises a wrong `claimed_D`; the first mirror is killed
after resolution so the fetch fails over.
**Success criterion**: the authenticated D comes from F0/P2 (never the index),
the failover serves the SAME exact tuple/D from the remaining VALID peer, and no
state changes beyond availability.

## A0-6 — Repeated directory/index observations attempting to create weight

**Setup**: the directory returns one endpoint 10,000 times; the index returns
one tuple 10,000 times with differing `claimed_D` values.
**Success criterion**: one endpoint candidate, one tuple candidate, identical
downstream authentication; no score, rank, popularity or weight anywhere.

## A0-7 — Valid custody of an F1 proof without ingest, then restart

**Setup**: a valid proof is copied through S0 into the destination; then both the
destination and the consumer are restarted.
**Success criterion**: the evidence survives the restart byte-identically and
still verifies; quarantine remains UNCHANGED (custody still is not ingest); pins
unchanged; an explicit ingest afterwards still activates quarantine.

## A0-8 — Consumer pin already ahead of the material being backfilled

**Setup**: the consumer is pinned at a later identity state while a
destination is backfilled with an object authenticated against an earlier state.
**Success criterion**: the backfill itself is unaffected (custody is not
consumer state); using the earlier-state material at the consumer follows
ordinary P2 rules (refusal or classification), and the existing pin is NOT
rewound.

## A0-9 — Malformed scope mixed with valid intents

**Setup**: one scope containing a valid publication intent, a publication intent
carrying a `D`, a `"latest"` selector, a malformed digest and an unknown field.
**Success criterion**: exactly the valid intent is processed; every malformed
record is rejected with a reason; nothing is silently normalized or ignored.

## A0-10 — Restart between custody and consumer use

**Setup**: backfill commits, then the destination is restarted before the
consumer resolves against it.
**Success criterion**: the consumer path succeeds from durable state and the
custody outcome is unchanged — no dependency on process memory.

## A0-11 — Everything hostile at once

**Setup**: lying directory + poisoned index + stale claimed_D + a source that
dies mid-scope + a restart between custody and use, in one campaign.
**Success criterion**: the final safety property is **REFUSE or UNAVAILABLE with
trust state unchanged** — NOT successful availability. No authority may be
manufactured by any combination; every consumer-local mutation, if any, remains
attributable to a sealed step.

## Reporting rule

The receipt records, per attack: the setup actually constructed, the observed
outcomes, the trust-state hashes before/after, and the criterion verdict. If any
attack contradicts a sealed phase's earned claim, execution STOPS, that phase is
patched narrowly, its own receipt is re-run, and A0 restarts — A0 never papers
over a seam and never lowers a criterion.
