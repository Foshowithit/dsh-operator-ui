# FlowRouter D1 — Untrusted Endpoint Directory (spec v1, for adjudication)

Status: spec-only. No code until frozen.
Sealed predecessors: P0, P1, P1-X, P2, F0 (6093ce5), F1 (e9e7ef6), R0 (43ca378),
I0 (060aa90), D0 (d0e935d).

## 0. The one question

**Given a canonical capability name and ONE configured directory endpoint, can a
consumer learn repository endpoint candidates worth asking, without directory
membership, multiplicity, ordering, availability, or operator behavior
acquiring any trust authority?**

D1 does not discover directories themselves: the directory endpoint is
consumer-configured. The three layers stay mechanically separable:

```
D1      — where might I ask?
D0      — what does that endpoint claim to hold?
F0/P2   — what is cryptographically true?
```

## 1. Directory entry: locator only (frozen)

The entry schema is exactly:

```
{ "endpoint": "<absolute http(s) origin>" }
```

Nothing else. No `publisher_id`, `publisher_scheme`, `name`, `version`, `D` /
`claimed_D`, `publisher_auth`, freshness, timestamp, `score`, `rank`,
`popularity`, `availability`, or `repository_id`.

Semantically, for a query naming canonical capability `N`:

> *Directory Q suggests that endpoint E may be worth asking about N.*

That is all. **The name lives in the query context, not the entry** — a
directory may return the same endpoint for every name and remain
conformant-but-useless; D0 determines what the endpoint actually claims.

Core invariants:

- **D1 transports locators, never capability claims.**
- **A directory suggestion is not a repository identity.**

## 2. Endpoint identity and canonicalization (frozen)

```
endpoint_candidate_key = canonical_origin(endpoint)
```

Only absolute `http://` or `https://` repository origins are allowed:

```
parse as URL
→ scheme must be http or https
→ hostname required
→ no username/password
→ no query
→ no fragment
→ path must be empty or "/"
→ lowercase / standard URL host normalization (IDNA)
→ collapse default ports
→ remove an otherwise-equivalent terminal DNS root dot
→ canonical origin
```

- These are ONE candidate: `https://EXAMPLE.com`, `https://example.com/`,
  `https://example.com:443/`.
- These are DISTINCT candidates, because transport scheme is part of the
  locator: `http://example.com` vs `https://example.com`.
- `example.com` and `example.com.` must not consume separate candidate slots.
- **No semantic network identity.** `https://example.com`,
  `https://93.184.216.34` and `https://alias.example.net` remain separate
  candidates even if DNS leads them to one machine. **D1 must not resolve DNS
  merely to deduplicate** — DNS aliases are not repository identities.

## 3. Network-safety boundary (frozen)

**D1 MUST NOT automatically dereference the endpoint candidates it receives.**
A malicious shared directory must not become "send the consumer to arbitrary
network locations".

```
name + configured directory
    ↓
normalized endpoint candidates            ← D1 ENDS HERE
    ↓
caller/operator explicitly selects one or more exact candidates
    ↓
D0(endpoint, name)
```

- From D0 onward, a directory-learned endpoint is **indistinguishable from that
  same endpoint having been typed manually**.
- D1 cannot become an SSRF/metadata-scanning primitive because someone poisoned
  a directory.
- Automatic probing or fan-out across directory results is a separate policy
  boundary and is NOT part of D1.

## 4. Repetition, ordering, bounds (frozen)

```
MAX_D1_ENDPOINTS = 256

validate locator syntax
  → canonicalize to endpoint_candidate_key
  → dedupe BY canonical origin
  → canonical bytewise sort by canonical origin
  → retain the first 256
  → truncated = true iff more than 256 unique valid endpoint candidates existed
```

- Ordering carries ZERO preference meaning; the canonical sort exists solely so
  truncation is independent of directory-supplied order.
- `1 occurrence = 100 occurrences = 10,000 occurrences` in trust weight.
- `256 unique → 256 retained, truncated:false`;
  `257 unique → canonical first 256 retained, truncated:true`.
- Repetition, ordering and survival of the local bound must never become inputs
  to downstream trust.

## 5. Time and availability (frozen)

D1 entries have **no time field at all**. No age, `last_seen`, `fresh`, TTL as
evidence, or uptime score.

A directory response means only: *"Q returned E during this query."*

If E is dead one millisecond later, nothing changes except availability; an
endpoint answering quickly gains no trust.

## 6. Directory operator model (frozen)

The directory operator is allowed to lie; safety comes from the lie having no
authority. The operator MAY invent endpoints, omit endpoints, reorder them,
duplicate them, disappear, or return endpoints that know nothing about the
queried name. All are allowed failure modes.

- **D1 makes no completeness claim.** Absence means only "this directory did not
  return an endpoint" — never that no endpoint exists.
- A manually configured repository endpoint remains FIRST-CLASS; nothing in D1
  is mandatory for FlowRouter operation.
- A directory operator is never a publisher, a trust anchor, a repository
  authority, a canonical-namespace authority, or an availability oracle.

## 7. Consumer flow (frozen)

```
consumer knows: canonical capability name N + configured directory endpoint Q
query Q for N
receive untrusted locator observations: E1, E2, ...
validate → canonicalize → dedupe → canonical sort → bound
caller/operator chooses an exact endpoint E
D0(E, N) → exact tuple candidates
caller/operator chooses an exact tuple T
ordinary F0(T, peer set) → P2 auth → exact-D fetch → P0 recomputation
stage → local verify → admit → route → SHIP
```

Neither D1 nor D0 selects the "best" anything. **The positive receipt
deliberately uses ONE endpoint in D1 and ONE tuple in D0**, so the demonstration
acquires neither an endpoint-selection nor a version-selection policy merely to
reach SHIP.

## 8. Acceptance properties (for the later implementation round)

Claim to be earned: *a consumer that knows only a canonical capability name and
one configured untrusted directory endpoint can learn repository endpoint
candidates and safely enter the already-sealed D0→F0→P2 trust path, while
false, duplicated, reordered, omitted, malformed, unavailable or malicious
directory observations affect only discovery completeness or cost — not
publisher authenticity, capability trust, admission, or routing eligibility.*

1. **Positive**: name + directory only → one endpoint → D0 one tuple →
   F0/P2 → stage → B-local verify → explicit admit → SHIP, authenticating
   publisher P rather than directory Q.
2. A directory entry contains EXACTLY `{endpoint}`.
3. The directory cannot inject tuple/publisher/D/auth/freshness/rank fields;
   malformed entries with extra fields are rejected.
4. Canonical spellings of the same origin dedupe to one endpoint.
5. `http://` and `https://` remain distinct candidates.
6. Paths, query strings, fragments, credentials and non-HTTP(S) schemes are
   rejected.
7. Repetition: one endpoint vs 10,000 copies → one candidate.
8. Permutation: all response permutations normalize identically.
9. The 256/257 boundary mirrors the frozen algorithm exactly.
10. **False endpoint**: points at a repository holding nothing for N → D0
    returns no useful tuple; no trust mutation.
11. **Swapped publisher**: the endpoint's D0 index truthfully or falsely yields
    another publisher; D1 contributes nothing — D0/F0/P2 own what follows. The
    case does NOT require the endpoint to impersonate a publisher successfully;
    D1 has no say whatsoever about publisher identity.
12. **Directory/D0 disagreement**: the directory suggested E for N while E's
    possession index returns zero matching candidates → D0 governs; the
    directory cannot override it.
13. **Withholding**: the directory omits a known working repository →
    undetectable; the receipt explicitly states no completeness claim.
14. **Directory disappears after observation** → the already-normalized
    candidate neither gains nor loses trust.
15. **No automatic dereference**: obtaining D1 results alone produces ZERO
    network calls to the returned endpoints.
16. **No trust-state mutation**: query/normalization leaves pins, witnesses, F1
    records, registry, admission, routing and repository replication state
    byte-identical.
17. **Manual equivalence**: a typed endpoint E and a D1-learned E produce
    identical D0 candidate and downstream behavior.
18. **Copy/membership count adds nothing**: repeated appearance of E inside a
    directory yields no extra authority.

## 9. Explicitly deferred (not D1)

Multiple-directory aggregation or federation; discovering directory endpoints
themselves; signed directories; durable directory identity; durable repository
identity; directory reputation; endpoint reputation; availability scoring;
uptime history; automatic probing of returned endpoints; automatic fan-out;
crawling; peer exchange; semantic/fuzzy/tag search; ranking; popularity;
recommendations; "canonical repository"; publisher-directory bindings;
sync/watchers/backfill; global freshness.

**Trust derived from agreement among directories is deferred too**: ten
directories repeating one endpoint is not ten votes. Multi-directory behavior
deserves its own phase if it is ever needed.

Roadmap: **D1 endpoint directory → S0 synchronization/backfill**, with any
directory-federation or automatic-probing phase inserted explicitly if it later
becomes necessary.

## 10. Freeze request

Confirm or amend: (a) the locator-only entry schema and the two core invariants
(§1); (b) the canonicalization contract, including `http`/`https` distinctness,
the DNS-root-dot rule and the no-DNS-for-dedup rule (§2); (c) the
no-automatic-dereference boundary and the manual-equivalence rule from D0
onward (§3); (d) MAX_D1_ENDPOINTS = 256 with the frozen normalization order
(§4); (e) the total absence of time and availability fields (§5); (f) the
operator model, the no-completeness limit and the first-class manual path (§6);
(g) the consumer flow with the one-endpoint/one-tuple positive receipt (§7);
(h) the eighteen acceptance properties (§8); (i) the deferral list, including
no directory federation and no agreement-derived trust (§9). On freeze, the D1
implementation and its raw receipt follow the sealed pattern: implementation
commit first, receipt-only child second.
