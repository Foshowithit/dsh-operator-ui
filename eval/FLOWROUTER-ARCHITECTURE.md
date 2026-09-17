# FlowRouter — architecture and trust-boundary map

This is the readable overview of the sealed system. Every claim in it is backed
by a receipt; none of it is aspirational. Phase names in **bold** are sealed.

## 1. What the system is

A way to move *verified* capability artifacts between independently operated
repositories and into a consumer's local trust process, where **nobody you get
bytes from is trusted** — not the publisher's repository, not a mirror, not a
directory, not the sync scheduler, not a carrier of evidence.

The whole design follows one line:

> **FlowRouter can transport evidence of trust. It cannot transport trust
> itself.**

## 2. The phases, and what each one owns

```
        FOUNDATION                                    DISCOVERY
        ──────────                                    ─────────
        P0  artifact integrity (canonical digest)      D1  endpoint directory
        P1  repository transport (publish/fetch)       D0  possession index
        P1-X same, on a second physical machine        (where might I ask?)
        P2  publisher identity + authentication        (what does it claim?)

        RESOLUTION                       CUSTODY                 EVIDENCE
        ──────────                       ───────                 ────────
        F0  exact multi-repo resolve     R0  mirror replication  F1  equivocation proofs
        (what is cryptographically true) S0  exact-scope backfill
```

## 3. Trust-boundary map

The single most important property: **each phase knows only its own layer, and
no layer can manufacture the layer above it.**

```
┌────────────────────────────────────────────────────────────────────────────┐
│ CONSUMER-LOCAL TRUST  (never crosses a boundary; never transported)         │
│   pins · pin witnesses · quarantine · acknowledgments · registry ·         │
│   admission · routing · authority grants                                   │
│   Owned ONLY by consumer-local sealed operations (nothing else may write): │
│     P2 stage                → pins / pin witness                           │
│     explicit admission      → registry / routing eligibility               │
│     explicit F1 ingest/ack  → quarantine / acknowledgment state            │
└────────────────────────────────────────────────────────────────────────────┘
                 ▲                    ▲                       ▲
        stage mutates pins    admission enables      explicit ingest
        (only this)           routing (only this)     quarantines (only this)
                 │                    │                       │
┌────────────────┴────────────────────┴───────────────────────┴─────────────┐
│ EVIDENCE LAYER — cryptographic facts, independently re-established        │
│   P0  bytes → digest                      (recomputed, never taken)        │
│   P2  genesis + key chain + assertion     (replayed, never taken)          │
│   F1  two publisher-signed contradictory states (verified offline)         │
└────────────────────────────────────────────────────────────────────────────┘
                 ▲                    ▲                       ▲
┌────────────────┴────────────────────┴───────────────────────┴─────────────┐
│ CLAIM LAYER — untrusted statements about the world                       │
│   D1  "endpoint E may be worth asking"        (a locator, nothing else)   │
│   D0  "endpoint E claims it holds exact tuple T"  (claimed_D: no authority)│
│   R0/S0 custody provenance ("these bytes came via that source")           │
│   Every one of these may LIE. Safety comes from the lie having no power.  │
└────────────────────────────────────────────────────────────────────────────┘
```

The arrows only ever point **upward into verification**, never downward into
trust. A directory cannot make a tuple authentic; a mirror cannot make a
publisher real; a sync scheduler cannot make anything fresh; a carrier cannot
make evidence true.

## 4. The end-to-end path

```
publisher P ──► origin R1 ──► mirror R2 ──► destination R3
                   P0/P2        R0            R0 (via S0)
                                                │
        configured directory Q ──► D1 ──► endpoint R2
                                            │
                                    D0 ──► exact tuple T
                                            │
                                (caller selects exactly T)
                                            │
                                    S0 ──► backfill into R3
                                            │
                                    F0 ──► exact resolution at the consumer
                                            │
                                    P2 ──► original publisher authenticated
                                            │
                                    P0 ──► bytes recomputed
                                            │
        sealed stage (pin) ──► B-local verification ──► explicit admission
                                            │
                                route ──► SHIP  (the admitted LOCAL capability)
```

A worked, receipt-generated example of this exact path is in
`FLOWROUTER-I1-TRACE.md`.

## 5. The equivocation branch (orthogonal)

```
publisher fork ──► F0 sees non-comparable states ──► F1 proof core
        ──► untrusted transport / optional S0 evidence custody
        ──► destination verifies OFFLINE (custody alone quarantines nobody)
        ──► explicit F1 ingest ──► quarantine
        ──► next import refused BEFORE any pin mutation
        ──► acknowledgment keeps the evidence and lifts the quarantine
```

## 6. Sealed chain and evidence discipline

```
P0 → P1 → P1-X → P2 → F0 → F1 → R0 → I0 → D0 → D1 → S0 → I1 (+A0 adversarial)
```

Every phase followed the same rule: **spec commit → adjudicated freeze →
implementation commit → execute that exact commit → receipt-only child commit
containing raw JSON**. Two phases were additionally proven across two physical
machines (P1-X, I0). All receipts live in `eval/receipts/`, and every claim in
`FLOWROUTER-CLAIMS.md` points at one.
