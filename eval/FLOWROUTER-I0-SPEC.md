# FlowRouter I0 — Integrated Federation Walkthrough / Composition Seal
(spec v1, for adjudication)

Status: spec-only. No code until frozen.
Sealed predecessors: P0, P1, P1-X, P2, F0 (6093ce5), F1 (e9e7ef6), R0 (43ca378).

## 0. The one question

**Can the entire sealed FlowRouter chain operate end-to-end across independent
machines and repositories, with every trust transition occurring at the
already-frozen boundary that owns it, and with no hidden handoff between
phases gaining authority?**

I0 introduces **no new protocol object, no new trust primitive, and no new
authority surface**. Its purpose is to prove that the independently sealed
pieces actually compose into one system rather than merely passing isolated
phase harnesses.

Earned claim (to be sealed): *FlowRouter's independently sealed integrity,
publisher-authentication, federation, equivocation-evidence and replication
mechanisms compose into one continuous real-network lifecycle without
collapsing their trust boundaries.*

## 1. No-new-semantics rule (frozen)

I0 may add ONLY: orchestration/harness code, fixtures, topology setup,
instrumentation needed to expose receipts, and one integrated raw receipt.

I0 MUST NOT modify the semantics of P0, P1, P1-X, P2, F0, F1 or R0 to make the
walkthrough easier, and MUST NOT invent an I0 surface: **no new API, no new
network object, no new trust labels, no repository identity, no status
hierarchy, no "system seal" token.** The receipt is the artifact.

If the integrated run exposes a genuine seam defect, the owning sealed
implementation is patched narrowly and its own acceptance evidence is re-run
before the I0 seal. I0 never papers over a seam.

## 2. Frozen topology (real machines, no shared filesystem)

```
Machine A                                   Machine B
  publisher P                                 R2 mirror
  R1 origin repository        real network    R3 second-hop mirror
                                              consumer B / RCOS
```

- The original publication and the final consumer MUST be on machines with
  genuine machine/network separation (artifact movement over the network
  only).
- R3 MAY live on either machine or a third environment; the network-only rule
  for artifacts remains absolute.
- The consumer starts with NO knowledge of the publication other than the
  exact tuple and a configured peer set.

## 3. Integrated lifecycle (the positive run, one continuous campaign)

```
P creates and authenticates the publication
R1 receives the P2 publication + P0 artifact
R2 replicates from R1
R3 replicates from R2                      (second custody hop)
B knows the exact tuple / resolves across the configured repositories
B independently verifies the publisher proof
B exact-D fetches
B recomputes P0 integrity
B stages
B local verification
B explicit admission
route
SHIP
```

Each step executes through the surface that already owns it; nothing is
short-circuited, and no step's outcome is taken from a repository's verdict.

## 4. Equivocation campaign (same run, after the positive path)

```
P's identity produces incompatible signed histories
independent repositories expose the two branches
F0 observes the conflict
F1 proof_core is constructed
the proof is transported through an untrusted repository/mirror
B verifies it OFFLINE
explicit F1 ingest
publisher quarantine
a new import refuses BEFORE any pin mutation
operator acknowledgment
evidence remains
ordinary P2 rules still apply to any later import
```

Explicitly NOT required: removal of already-admitted capabilities (F1 froze the
opposite).

## 5. Seam invariants (each one is a receipt checkpoint)

1. P0 `D` at original publish = the value observed at R2 = R3 = the final
   consumer's own recomputation.
2. The original `publisher_id` and the P2 material survive multi-hop custody
   unchanged (byte-identical material digest at every hop).
3. Repository custody metadata never enters publisher-authentication material
   (nothing of any repository's identity appears in what is signed).
4. Mirroring causes no consumer pin / admission / registry mutation.
5. F0 resolution causes no pin / admission / registry mutation (read-only).
6. Fetch cannot substitute another `D`, another version, or another source
   state (exact-T/D only, recomputed at the consumer).
7. Only the sealed P2 stage may create or advance the consumer pin.
8. Only explicit admission makes the capability routable.
9. The final SHIP uses the admitted LOCAL capability, not any repository's
   verdict.
10. An F1 proof transported through a mirror verifies to the same
    `proof_digest`.
11. Merely storing/transporting that proof quarantines nobody.
12. Explicit F1 ingest activates the quarantine.
13. Quarantine blocks a subsequent P2 import BEFORE pin mutation.
14. The existing admitted capability remains unchanged throughout.
15. Acknowledgment preserves the proof bytes/digest and does not alter the pin;
    after acknowledgment, ordinary P2 verification — not the acknowledgment —
    determines whether a later import can proceed.
16. Copy count, repository count and custody path never appear as trust inputs
    anywhere in the run.
17. Killing one mirror after resolution leaves failover exact-T/D under the
    sealed F0 behavior — never a version or source substitution.
18. Durable-state boundaries: the run includes at least one CONSUMER restart
    and one REPOSITORY restart, and every invariant above still holds after
    them (the walkthrough rests on durable state, not process memory).

## 6. Required receipt fields

Primary artifact: **`eval/receipts/FLOWROUTER-I0-RECEIPT.json`**, carrying
phase-linked checkpoints rather than one final boolean. For each seam, the
receipt records the immutable identities involved:

- P0 `D` (per hop and per recomputation);
- P2 `publisher_id`, key id, identity sequence and head digest;
- the exact tuple;
- F0's selected state (and the observations it came from);
- F1 `proof_digest` (and the offline verification verdict);
- R0 material digests at each custody hop;
- consumer pin before/after each mutation, plus the pin witness digest;
- registry / admission state (byte hashes) at each checkpoint;
- the final route verdict and the check set that produced it;
- machine roles and platforms (role labels only — never host names or
  machine-specific paths);
- restart boundaries with the state re-read from disk after each.

The strongest property the receipt must demonstrate is not "every operation
succeeded" but: **the same identifiers survive the handoffs where they are
supposed to survive, and the state that must remain local never crosses those
handoffs.**

## 7. Deliverable pattern

Spec commit → freeze → orchestration implementation commit → execute that exact
implementation → receipt-only child commit with the raw JSON, as with every
sealed phase. The orchestration may be a single harness that drives the sealed
surfaces; it must not embed new protocol logic.

## 8. After I0 (frozen direction, NOT opened here)

- **D0 — untrusted location discovery** comes next, before sync. It traffics in
  endpoint observations ("endpoint X claims to serve tuple T"), never in
  globally meaningful repository identities ("repository R is the authoritative
  holder of T"). `repository_id` stays consumer-local configuration. Any
  cryptographically durable repository identity is its own security phase
  because it creates a genuinely new trust object.
- Directory and repository-index are related but not identical (where might I
  ask? vs what does this endpoint claim to hold?) and may or may not share one
  protocol; that is a D0 scope question.
- **Sync** (later): a sync agent may say "I have not yet copied object X" or
  "source S currently serves object Y". It may never turn that into "you are
  behind the publisher" or "Y is globally latest". Backfill is custody; global
  freshness is not.

## 9. Freeze request

Confirm or amend: (a) the no-new-semantics rule and the seam-defect procedure
(§1); (b) the two-machine topology and network-only artifact movement (§2);
(c) the positive and equivocation lifecycles (§3, §4); (d) the eighteen seam
invariants, in particular the restart and mirror-failover boundaries (§5);
(e) the receipt fields, including the role-label-only rule for machine
identification (§6); (f) the frozen direction for D0 and sync (§8). On freeze,
the I0 orchestration implementation and the integrated raw receipt follow.
