# FlowRouter

**A federation layer for capability artifacts that can transport *evidence* of
trust — never trust itself.**

Repositories, mirrors, discovery indexes and sync schedulers in FlowRouter are
all assumed to be **untrusted**. Any one of them may lie, omit, reorder or
disappear. The system is built so that a lie costs a failed query and nothing
else: every fact a consumer acts on is re-established locally from
cryptographic evidence — the artifact's own bytes, the publisher's own
signatures, and (when two publishers states contradict) the publisher's own
contradiction.

> **FlowRouter can transport evidence of trust. It cannot transport trust
> itself.**
>
> **Custody provenance is not authentication provenance.**
>
> **Backfill is custody. Global freshness is not.**

## What it actually does, end to end

A consumer that knows only a capability **name** and a directory can reach a
locally admitted, executing capability on its own machine:

```
name + untrusted directory
  → endpoint candidates          (D1: "where might I ask?" — a locator, nothing more)
  → exact tuple candidates       (D0: "what does that endpoint claim to hold?")
  → the caller picks one exact tuple
  → custody backfill             (S0: exact-scope, additive, internally ordinary R0)
  → exact federation resolution  (F0: across independent repositories)
  → publisher authentication     (P2: self-certifying identity + key chain)
  → artifact recomputation       (P0: the bytes prove themselves)
  → local stage → local verification → explicit admission → route → SHIP
```

Along the way, untrusted repositories may mirror each other (R0), untrusted
directories may point anywhere (D1), untrusted indexes may lie (D0), and an
untrusted sync scheduler may copy objects (S0). None of them can make a
publisher real, a tuple authentic, a version "latest", or a capability
routable.

When a publisher *does* misbehave — signing two incompatible histories — the
system turns that into portable evidence (F1): a self-contained proof that
verifies offline, survives transport through untrusted carriers, and drives
explicit, local quarantine. Carrying that evidence quarantines nobody; only an
explicit consumer-side ingest does.

## The picture

[`docs/flowrouter-trust-boundaries.svg`](docs/flowrouter-trust-boundaries.svg) — the
three layers (untrusted claims / cryptographic evidence / consumer-local trust),
the three operations that may write consumer-local state, and the rule that
verification only ever flows upward.

## Read it in this order


| Document | What it gives you |
|---|---|
| [`eval/FLOWROUTER-ARCHITECTURE.md`](eval/FLOWROUTER-ARCHITECTURE.md) | The phase map and the **trust-boundary map**: which layer may only be verified upward, and exactly which consumer-local operations may write which trust surfaces |
| [`eval/FLOWROUTER-I1-TRACE.md`](eval/FLOWROUTER-I1-TRACE.md) | **One readable end-to-end proof**, generated from the sealed receipt: every step, every boundary handoff, every value crossing a seam |
| [`eval/FLOWROUTER-A0-SUMMARY.md`](eval/FLOWROUTER-A0-SUMMARY.md) | The **adversarial campaign**: eleven cross-phase attacks with their criteria fixed in advance, and what hostile composition can and cannot do |
| [`eval/FLOWROUTER-CLAIMS.md`](eval/FLOWROUTER-CLAIMS.md) | **Claim boundaries**: what is proven (with the receipt for each), what is assumed, what is explicitly unproven, what is out of scope |

If you only read one thing, read `FLOWROUTER-CLAIMS.md` — it is deliberately
written so that nothing is claimed more strongly than the evidence supports.

### Four words, in plain terms

- **digest** — a fingerprint of a file's exact bytes. Change one byte and the
  fingerprint changes, so a receiver can always tell whether what it got is what
  was sent.
- **mirror** — a second server that holds a copy of someone else's published
  artifact, so the publisher can go offline and the artifact is still reachable.
- **pin** — a note a consumer keeps about *which* publisher identity state it has
  already accepted, so it can notice if it is later shown something
  inconsistent with what it saw before.
- **custody** — who is holding which bytes right now. In FlowRouter, custody
  earns nothing: holding a copy never makes a copy more trustworthy.

## The evidence

Every phase was built under one discipline:

```
spec commit → adjudicated freeze → implementation commit
            → execute that exact commit → receipt-only child commit (raw JSON)
```

The sealed chain:

```
P0 → P1 → P1-X → P2 → F0 → F1 → R0 → I0 → D0 → D1 → S0 → I1  (+ A0 adversarial)
 │     │      │     │    │    │    │    │    │    │     │      │
 │     │      │     │    │    │    │    │    │    │     │      └ composition traceability
 │     │      │     │    │    │    │    │    │    │     └ exact-scope custody backfill
 │     │      │     │    │    │    │    │    │    └ endpoint directory (untrusted)
 │     │      │     │    │    │    │    │    └ possession index (untrusted)
 │     │      │     │    │    │    │    └ prior two-machine composition
 │     │      │     │    │    │    └ authenticated mirror replication
 │     │      │     │    │    └ equivocation evidence (offline-verifiable)
 │     │      │     │    └ exact multi-repository resolution
 │     │      │     └ publisher identity / authentication
 │     │      └ proven on a second physical machine
 │     └ repository transport (publish / index / discover / fetch)
 └ canonical artifact digest
```

Thirteen FlowRouter seal/composition/adversarial receipts — plus the earlier product-path receipt, which is not one of the FlowRouter claims — live in [`eval/receipts/`](eval/receipts/). Each one is
the output of the exact implementation commit named in its parent commit
message — the receipts are the evidence, and the code that produced them is in
[`eval/lib/`](eval/lib/).

## What is proven — and what is not

Proven (each with its receipt, indexed in `FLOWROUTER-CLAIMS.md`): artifact
integrity by recomputation; network transport; a second physical machine;
self-certifying publisher authentication that survives malicious repositories;
deterministic multi-repository resolution with no majority or availability
authority; offline-verifiable equivocation evidence; authenticated mirroring
that survives concurrent conflict; two-machine composition; untrusted
index/directory discovery with zero authority; exact-scope backfill; full
traceability; and an adversarial campaign that produced only refusal,
unavailability or extra work.

**Explicitly not proven, and stated as limits rather than gaps:**

- **there is no global freshness anywhere** — FlowRouter never says which
  version is "current";
- **withholding is undetectable** — a repository, directory or peer that omits
  something cannot be caught;
- **first-contact honesty is unprovable** — one source and no prior state
  cannot distinguish an honest publisher from a liar;
- **equivocation evidence proves what a key did**, not which human used it, and
  cannot separate intent from key compromise;
- **custody is never authority** — mirrors, copy counts and custody paths grant
  nothing, so a mirror can never vouch for freshness or completeness;
- **directories and indexes may lie** — by design, and safely.

## Reproducing it

[`eval/FLOWROUTER-REPRODUCE.md`](eval/FLOWROUTER-REPRODUCE.md) lists the exact
commands, prerequisites and honest caveats (including which phases were proven
across two machines and what that requires). `node scripts/check.js` asserts the
structural invariants on every run, and a five-minute reader can print the sealed
end-to-end trace with:

```bash
node eval/lib/flowrouter-show.mjs
```

## Scope

This repository is the RCOS operator surface plus the FlowRouter program. The
FlowRouter work here is **closed at its frozen boundary**: the protocol is
sealed, the evidence is committed, and no further protocol phases (continuous
sync, reputation, "latest", directory consensus, publisher UX) are in progress.
What remains is packaging and review.
