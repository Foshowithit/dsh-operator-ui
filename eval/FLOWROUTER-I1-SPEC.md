# FlowRouter I1 — Full Federation Composition / Traceability (spec v1, for adjudication)

Status: spec-only. No code until frozen.
Sealed phases: P0, P1, P1-X, P2, F0 (6093ce5), F1 (e9e7ef6), R0 (43ca378),
I0 (060aa90), D0 (d0e935d), D1 (ac80256), S0 (ccf0387).

## 0. The one question

**Can the completed FlowRouter system operate as one traceable composition from
capability publication and untrusted discovery through exact-scope backfill and
consumer-local SHIP, while every transition remains owned by its already-sealed
phase and orchestration gains zero authority?**

I1 creates **no new trust object, status, API, identity, ranking, selector,
freshness concept or protocol.** It is orchestration and receipts only, and it
does not modify I0.

One framing correction I1 takes as frozen: the eleven seals are NOT one linear
runtime chain. Some are foundational or orthogonal — P1/P1-X establish transport
behaviour, F1 is an adversarial/equivocation branch, S0 composes R0 custody — so
the artifact shows a **composition graph with complete phase coverage**, not a
fabricated serial pipeline.

## 1. Composition graph (frozen shape)

```
                     P0  exact artifact integrity ─────────────┐
                     P1  repository transport foundation       │ content
                     P1-X real-network physical portability    │
                     P2  publisher authentication ─────────────┤ binding
                                                               ▼
   publisher P ──► origin R1 ──► R0 custody ──► mirror R2 ─────────────┐
                                        (S0 composes R0, never replaces it)
                                                                      │
   D1  endpoint discovery ◄── configured untrusted directory Q        │
        │ (name → endpoint candidates)                                │
        ▼                                                              │
   D0  tuple discovery    (name → exact P2 tuple candidates)           │
        │                                                              │
        ▼                                                              │
   explicit selection of ONE exact tuple T                             │
        │                                                              │
        ▼                                                              │
   S0  exact-scope custody backfill ──► destination R3 ◄───────────────┘
        │
        ▼
   F0  exact multi-repository resolution ──► P2 authentication ──► exact D
        │                                                              │
        ▼                                                              ▼
   stage ──► B-local verification ──► explicit admission ──► route ──► SHIP
```

Orthogonal/branch phases:

```
   F1  equivocation evidence  (branch — see §3, never forced into the happy path)
   I0  prior federation composition  (the earlier two-machine composition seal)
```

## 2. Positive lane (frozen, one endpoint and one tuple)

```
publisher P
  ↓ P0/P2        publish + authenticate
origin R1
  ↓ R0           authenticated custody replication
mirror R2
  ↓ D1(name)     1 endpoint candidate discovered from the configured directory Q
endpoint R2
  ↓ D0(name)     1 exact tuple candidate claimed by R2's possession index
exact tuple T
  ↓ explicit selection by the caller/operator
S0 exact-scope backfill (internally ordinary R0)
  ↓
destination R3
  ↓ F0 exact resolution
P2 authentication
  ↓ exact D / P0 recomputation
stage
  ↓ B-local verification
explicit admission
  ↓ route
SHIP
```

**One D1 endpoint and one D0 tuple, deliberately**, so no hidden
endpoint-selection or version-selection policy is acquired to reach SHIP.

## 3. Equivocation branch (frozen, separate from the happy path)

```
publisher fork
→ F0 sees non-comparable observations
→ F1 proof constructed
→ untrusted transport / optional S0 evidence custody
→ destination independently verifies the evidence
→ NO automatic quarantine from custody
→ explicit F1 ingest
→ quarantine
→ pre-pin / pre-import refusal
→ acknowledgment preserves the evidence
```

The branch is recorded separately and is never required for the positive lane to
succeed — that is how F1 belongs in a full-system proof.

## 4. Boundary handoff records (required receipt content)

At every hop the receipt records which phase owns the transition and what that
phase knows — explicitly: **what D1 knows** (endpoint candidates only), **what
D0 adds** (exact tuple claims, with `claimed_D` non-authoritative), **what S0 is
allowed to copy** (exact named objects, additively), **where R0 independently
verifies** (before every commit, blob before binding), **what F0 resolves** (the
exact tuple across configured peers), **what P2 authenticates** (publisher
identity bound to tuple and D), **what P0 proves** (byte-level artifact
integrity by recomputation), and **the exact point at which local admission
makes something routable** (the explicit admission step, and nowhere earlier).

## 5. Phase-coverage table (required in the receipt or accompanying markdown)

| Phase | Role in the composition |
|---|---|
| P0 | exact artifact integrity |
| P1 | repository transport foundation |
| P1-X | real-network physical portability |
| P2 | publisher authentication |
| F0 | exact multi-repository resolution |
| F1 | equivocation evidence (branch) |
| R0 | authenticated custody replication |
| I0 | prior federation composition |
| D0 | tuple discovery |
| D1 | endpoint discovery |
| S0 | exact-scope custody backfill |

I1 does not supersede these seals; it demonstrates that their boundaries
compose.

## 6. Acceptance claim

**The completed FlowRouter federation can take a consumer from only a canonical
capability name and a configured untrusted directory to a consumer-local SHIP
through untrusted discovery, authenticated custody transfer, exact federation
resolution and local verification/admission — while repositories, directories,
mirrors, sync bookkeeping, transport and orchestration acquire no authority
beyond their already-sealed roles.**

## 7. Required receipt properties

- The positive lane runs in one campaign from `name + directory` to SHIP, with
  the boundary handoff records of §4 and the phase-coverage table of §5.
- The equivocation branch runs in the same campaign, separately, and ends with
  the evidence retained after acknowledgment.
- No phase's semantics are modified to make the lane pass: if a genuine seam
  defect appears, the owning sealed phase is patched narrowly and that phase's
  own receipt is re-run before the I1 seal.
- The receipt asserts the ABSENCE of authority: no trust object, status, ranking,
  selector, freshness or identity field is introduced anywhere by I1, and every
  consumer-local trust mutation in the campaign is attributable to a sealed
  phase (stage for pins, explicit admission for routing, explicit F1 ingest for
  quarantine).

## 8. Freeze request

Confirm or amend: (a) the composition-graph framing and the no-new-objects rule
(§0, §1); (b) the positive lane with one D1 endpoint and one D0 tuple (§2);
(c) the separate equivocation branch (§3); (d) the boundary handoff records
(§4); (e) the phase-coverage table (§5); (f) the acceptance claim (§6);
(g) the required receipt properties, including the absence-of-authority
assertions (§7). On freeze, I1 is orchestration-only: an implementation commit
followed by a receipt-only child, exactly as every sealed phase before it.
