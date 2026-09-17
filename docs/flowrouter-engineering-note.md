# What we proved about federating capability artifacts — and what we deliberately did not

*An engineering note on a system where every party that hands you bytes is
assumed to be lying, and trust still works.*

Every artifact-distribution system asks you to trust somebody. A package
registry, a mirror, a search index, a "latest version" pointer, a sync job —
each one is a place where someone else's assertion becomes your belief. Most
systems manage that risk with policy: signing keys, curated registries, review
processes, reputation. The bet behind FlowRouter is different. It asks: **can
you distribute artifacts between mutually distrusting parties, where nobody is
trusted at all — not the registry, not the mirror, not the directory, not even
the scheduler that copies your files — and still end up with something you are
justified in executing?**

We spent this program answering that, in eleven sealed phases plus an adversarial
campaign. Here is what we proved, stated as narrowly as the evidence allows.

## The shape of the answer

Three layers, and one rule about the direction of trust:

![FlowRouter trust boundaries](docs/flowrouter-trust-boundaries.svg)

- **Untrusted claims.** A directory says "endpoint E may be worth asking." A
  repository index says "I hold this exact artifact." A mirror holds a copy. A
  sync scheduler copies objects around. All of these may lie, omit, reorder,
  duplicate or vanish — and by design that costs a failed query and nothing
  else.
- **Cryptographic evidence.** The artifact's digest, the publisher's identity
  and key history, and — when a publisher contradicts itself — a portable proof
  of that contradiction. Every hop re-establishes these *locally*, from bytes
  and signatures. A source's verdict is never an input.
- **Consumer-local trust.** Which publisher identity state this machine has
  accepted, what it is willing to execute, which publishers it distrusts.
  Exactly three operations may write here, and nothing else in the system may
  touch them.

Verification only ever flows upward. Nothing downstream can make an upstream
claim true: a mirror cannot make a publisher real, a directory cannot make a
tuple authentic, and a scheduler cannot make anything fresh.

## What it feels like end to end

A consumer that knows only a **name** and a **directory** gets to a locally
admitted, executing capability:

```
name + untrusted directory
  → endpoint candidates            (a locator; no publisher, no digest, no rank)
  → exact tuple candidates         (a claim; its advertised digest carries no authority)
  → the caller picks one exact tuple
  → custody backfill               (additive; internally ordinary verified replication)
  → exact resolution across repos  (deterministic; no majority, no popularity)
  → publisher authentication       (self-certifying identity, key-state chain)
  → artifact recomputation         (the bytes prove themselves)
  → local stage → local verification → explicit admission → route → SHIP
```

The receipt for this path is not a log line. It records the exact values
crossing every seam — the endpoint, the tuple, the publisher id, the digest, the
material — so you can check that the object leaving one stage *is* the object
entering the next. That continuity, not the final "SHIP", is the interesting
property.

## What is proven

Each of these has a raw receipt in the repository; the claims document indexes
them all.

1. **Artifact integrity by recomputation.** A digest is recomputed from the
   bytes actually received, at every destination — never accepted from a source.
2. **Publisher authenticity that survives a malicious repository.** A
   repository cannot substitute the publisher namespace, the package binding,
   the identity history, or the authenticated outer metadata without being
   detected by the repository itself *and independently by the consumer*.
3. **Deterministic multi-repository resolution.** Given independent
   repositories that disagree, resolution is deterministic and fail-closed, and
   grants no authority to consensus, availability or ordering. Fetch may move
   between already-validated mirrors for the exact digest while the
   consumer-selected identity state stays invariant.
4. **Portable equivocation evidence.** When a publisher signs two incompatible
   histories, the contradiction becomes a self-contained proof that verifies
   offline, survives transport through untrusted carriers, and drives explicit
   local policy. Storing or forwarding that evidence quarantines nobody; only an
   explicit ingest does.
5. **Authenticated mirroring, including under concurrency.** A mirror preserves
   the original publisher's binding and never re-attests; concurrent conflicting
   replication converges to one immutable object rather than a second one.
6. **Untrusted discovery with zero authority.** Directory membership,
   index contents, repetition, ordering, malformed entries and a lying digest
   claim affect completeness or cost — never authenticity, admission or routing.
7. **Exact-scope backfill.** A destination copies named objects by
   independently re-applying the sealed rules to each; scheduling, interruption
   and a source that stops serving an object grant nothing, and source absence
   never deletes anything.
8. **Composition, proven twice.** Both between phases (one continuous
   traceable path) and physically (on two independent machines, with artifacts
   crossing only over the network).
9. **Hostile composition.** Across a pre-frozen matrix of eleven cross-phase
   attacks — a lying directory, a poisoned index, a disappearing endpoint, a
   source dying mid-copy, a conflict alongside genuine equivocation evidence, a
   stale advertised digest, repetition, custody without ingest across restarts,
   a consumer already ahead of the material, malformed scopes, all of it at once
   — the result was only refusal, unavailability or extra work. The governing
   rule held: *composition may reduce availability or increase work; it must not
   manufacture authority.*

## What is deliberately not proven

These are limits of the design, stated up front, not gaps we hope you miss:

- **There is no global freshness anywhere.** FlowRouter resolves exact states
  and proves contradictions. It never tells you which version is "current".
- **Withholding is undetectable.** A repository that omits an object it holds, a
  directory that omits an endpoint, a peer that keeps one branch of a fork to
  itself — none of that can be caught.
- **First-contact honesty is unprovable.** One source and no prior state cannot
  distinguish an honest publisher from a liar.
- **Equivocation evidence proves what a key did**, not which human used it, and
  cannot separate deliberate misbehaviour from key compromise.
- **Custody is never authority.** Copies, mirrors, copy counts and custody paths
  earn nothing — which also means a mirror can never vouch for freshness or
  completeness.
- **Directories and indexes may lie** — safely, but they may.

And nothing here is a consensus system: no ledger, no global ordering, no
reputation, no quorum.

## How to check any of it yourself

The discipline behind every phase was the same: a spec commit, an adjudicated
freeze, an implementation commit, execution of *that exact commit*, and a
receipt-only child commit carrying raw JSON. Thirteen receipts, and every claim
above points at one.

```bash
node eval/lib/flowrouter-show.mjs   # prints the end-to-end trace and the campaign
node scripts/check.js               # structural invariants, asserted on every run
```

`eval/FLOWROUTER-REPRODUCE.md` documents how to re-run each phase's harness,
including the honest caveat that two of them were proven across two machines.
`eval/FLOWROUTER-CLAIMS.md` is the claim-by-claim index, written so that nothing
is claimed more strongly than the evidence supports.

## Why the narrowness is the point

It would be easy to write a more impressive description of this system. It would
also be false in exactly the places that matter. What makes the program
interesting is not that it moves bytes between repositories — plenty of things
do that — but that its trust boundaries are stated precisely enough to be
attacked, and that they were attacked, and that the result was recorded raw.
A distribution system whose authors can tell you where it fails is more useful
than one whose authors can only tell you that it works.
