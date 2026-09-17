# Federation F0 — Multi-Repository Discovery / Resolution (spec for adjudication; NO CODE)

GPT ruling: F0 answers one narrow question —

> Can a consumer query multiple independently operated FlowRouter
> repositories, resolve an authenticated publication deterministically,
> fetch it from one of them, and preserve every P0/P1/P2 trust boundary
> without treating any repository as global authority?

Spec-first because the dangerous part is not HTTP plumbing — it is
deterministic resolution when repositories disagree. No code until frozen.

## 1. Scope

- **Multiple independent R instances** (R1, R2, R3 …), each with its own
  store, index, and operator. B has a **configured peer set**.
- **Cross-repository discovery and exact publication resolution.**
- **NOT in F0**: replication, repository consensus, rankings, "best
  source", automatic failover to a *different* version, global promotion,
  public marketplace, transparency/gossip (F1).
- A repository MAY cache bytes by immutable `D` after fetching them —
  that is a **content cache**, not the creation of a new authoritative
  publication binding.

## 2. The central object and per-scheme identity semantics

The structured tuple stays central:

```
(publisher_scheme, publisher_id, name, version)  → D   (+ publisher proof for P2)
```

**P2 (`p2-selfcert-v1`)**: the namespace is global because `publisher_id`
is self-certifying. If R1 and R2 both carry the same P2 tuple:

- same `D` + independently valid publisher proof → **equivalent
  observations (mirrors)** — the repetition adds no trust, only
  availability;
- different `D` → **federation CONFLICT** — never "pick one";
- same `D` but different identity history/proof → verify BOTH
  independently; anything inconsistent with B's pin and the frozen P2
  rules fails closed;
- a stale-but-once-valid state served to a FRESH consumer remains the
  known P2 limitation (labeled, never claimed fresh) — F0 does not
  attempt to solve it; F1 exists for that.

**P1 (`p1-configured-v1`)**: configured nicknames are NOT globally unique.
In federation, P1 identity is origin-scoped:

```
(repository_id, "p1-configured-v1", publisher_id, name, version)
```

P1 publications stay discoverable but are **never collapsed across
repositories** — two repositories carrying the same textual P1 triple are
two distinct origin-scoped identities.

## 3. Frozen invariants (protocol, not storage)

1. The P0 package digest `D` remains the one package-content truth.
2. P2 publisher authentication remains independently verifiable by B;
   repositories only TRANSPORT evidence.
3. B-local verification + explicit operator admission remain the ONLY
   path to eligibility/routing.
4. Every repository's index remains derived, cacheable, and
   non-authoritative.
5. Exact version resolution stays exact; federation introduces **no
   `latest`**.
6. Repetition adds no trust: a repository cannot confer more trust merely
   because multiple repositories repeat the same claim.
7. B's P2 history pin remains consumer-local and authoritative for
   rollback/fork detection.
8. Discovery never mutates B's registry and never admits anything.
9. Repository count / popularity / availability can never become a
   ranking or trust score.
10. **No silent substitution**: if B selected tuple T with digest D from
    R1 and R1 cannot serve it, B may fetch that exact same T/D from R2
    ONLY if R2 independently proves the identical binding. B never falls
    forward/backward to another version or digest.

**Core resolution rule (frozen):** *Repositories provide observations; the
publisher proof and immutable binding define identity; the consumer
resolves only exact agreement, never repository opinion.*

## 4. Peer query result and consumer resolution

Per peer, the conceptual result is:

```
repo_id → (publisher_scheme, publisher_id, name, version) → D
        → publisher proof (P2: genesis, key-event chain, assertion)
        → repository availability status
```

B validates each observation independently under the frozen P0/P1/P2
rules (integrity, P2 chain verification + pinning, tuple binding), then
derives exactly one state:

| state | meaning |
|---|---|
| **CONSISTENT** | all valid observations agree on the exact authenticated tuple/D |
| **PARTIAL** | some peers unavailable or lacking the publication, but all valid observations that exist agree |
| **CONFLICT** | two valid observations claim the same exact P2 tuple with different D, or incompatible authenticated identity histories |
| **INVALID** | observations fail P0/P2 validation |

**CONFLICT is fail-closed for automatic resolution. No majority vote.**
Three lying repositories do not beat one repository carrying the
publisher's valid signed statement.

## 5. Acceptance experiment (after the freeze)

Topology: **Publisher P → R1 + R2; malicious/stale R3; clean consumer B.**

**Positive**: P publishes the same authenticated package to R1 and R2 →
B discovers across both → resolves exact agreement (CONSISTENT) → fetches
from one → independently re-verifies P2 → the already-sealed local path:
P0 stage → B-local verification → operator admission → routing →
authority gate → SHIP.

**Adversarial (same receipt)**:
1. same P2 tuple, different D across repositories → CONFLICT, fail-closed;
2. forged metadata from one peer → that observation INVALID, others stand;
3. one peer unavailable, exact-D retrieval from another (no substitution);
4. stale P2 state vs B's pin → SEQUENCE_ROLLBACK / labeled limitation per
   the frozen P2 rules (never claimed fresh);
5. a repository omitting the publication entirely → PARTIAL;
6. duplicate identical mirrors → CONSISTENT, no trust inflation;
7. P1 with identical textual identity on two repositories → remains
   origin-distinct, never merged;
8. discovery across N repositories → B's authority state (registry,
   pins, admission) unchanged.

## 6. Explicitly out of F0

Replication; repository consensus; global promotion; rankings /
reputation / "best source"; automatic version failover; public
marketplace mechanics; and — explicitly — the transparency/gossip
problem (two fresh consumers shown different valid histories). F0 will
make that limitation MORE VISIBLE, which is useful; it is addressed in
F1.

Sequence: **F0 multi-repository discovery/resolution → F1
transparency/gossip → only then replication / public federation
mechanics.**
