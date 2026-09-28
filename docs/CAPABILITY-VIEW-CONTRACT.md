# Capability readiness view contract

Status: frozen for packet B1 before implementation. This is an ephemeral,
display-only projection; it does not authorize dispatch, edit the canonical
registry, or replace any execution or approval authority.

## Source mapping

| Source | Observed contract | B1 treatment |
| --- | --- | --- |
| `fixtures/capability-registry.example.json` and registry fixtures | Top-level `registry_version: "v1"`, `capabilities[]`; entries use `id`, `version`, `status`, optional `workflow`, `kind`, `requires`, `evals`, and `provenance` | Accept only the observed `registry_version: "v1"` envelope. Read identity, lifecycle, explicit workflow and top-level `sourceDigest` only. |
| `lib/status.js:probeRegistry` | Reads configured registry JSON; checks only for a `capabilities[]` array. `rcos-public-v1` is the configuration's declared expectation, not a demonstrated on-disk version marker. | Do not interpret status-probe success as per-entry validity, install, verification, or executability. Reject unknown payload schema instead of treating it as an empty registry. |
| `lib/goal.js:routeObjective` | Reads `capabilities[]`; skips `seed: true`; selects records with a truthy explicit `workflow`; refuses a best match only when its status is exactly `retired` | `binding` comes only from a nonblank `workflow` field. No adapter, ID, tag, description, kind, or historical record is a workflow binding. B1 does not change this router. |
| `lib/authority.js` | `requires[]` names permission scopes; `decisionFor` evaluates them against an operator preset for one task | `requires` is not a list of machine dependencies. Authority is a separate, context-scoped observation and remains host-owned. |
| `lib/client.js:deriveEligibility` and Intelligence | Shows lifecycle separately from a derived routing-eligibility label; historical eval dots are presentation | B1 does not trust UI-derived labels or eval history. A later consumer may render the projection; B1 does not change the current UI. |
| `lib/status.js:probeArchon`, `unwrapCatalog`, and `lib/index.js` catalog proxy | Archon is recognized from a workflow catalog; wrapped and flat rows normalize to named entries | B1 consumes an explicit normalized catalog observation and compares the exact `workflow` name. It performs no network or filesystem reads. |

The four repository capability records (`audio-offline-verify`,
`filmstrip-verify`, `video-forensics-receipt`, and `qr-camo-embed`) are
`candidate`, have `workflow: null`, and store evaluation material under
`provenance`; they do not establish a current Desktop binding or independent
verification. In particular, `provenance.measurerSha256` is a digest of a
measurer, not a digest of the installed capability package. B1 must not
reinterpret it as `sourceDigest`.

## API and schemas

```js
projectCapabilityView({ registry, observations })
// -> { schema: 'operator-capability-view/1', entries: Entry[], errors: Error[] }
```

`registry` is the already-read canonical object. The only supported payload
marker in this packet is `registry_version: "v1"` with a `capabilities` array.
The config label `rcos-public-v1` and the permissive status probe are not
additional payload schemas. A missing registry, another marker, or a missing
array returns a named error; it never returns a successful empty catalog.

`observations` is optional. When present, its exact schema is
`operator-capability-observations/1`:

```js
{
  schema: 'operator-capability-observations/1',
  runtime: { compatible: Fact },
  workflowCatalog: {
    state: 'available' | 'unavailable' | 'unknown',
    names: string[],
    reasons: string[]
  },
  capabilities: [{
    id: string,
    version: string,
    sourceDigest?: string,
    installed: Fact,
    verified: Fact,
    dependencies: [{ name: string, fact: Fact }],
    authority: Fact
  }]
}
```

`Fact` is `{ state: 'yes' | 'no' | 'unknown', reasons: string[] }`.
`runtime.compatible` is evidence for the target runtime combination.
`workflowCatalog` is the normalized, current Archon catalog; `names` are exact
workflow names, and names are meaningful only when `state` is `available`.
Each capability observation is matched by exact `id` and `version`; when a
digest appears on either side, both sides must contain the same digest. A
missing/mismatched identity never lends facts to another version or artifact.
The registry digest is read only from the record's top-level `sourceDigest`;
nested provenance digests are not substituted.

The registry record's optional top-level `dependencies` array is the declared
machine-dependency list. Every declared dependency needs a same-named fact in
the matched observation. An absent or malformed declaration is unknown, not
an empty dependency list. The `requires` array remains permission scopes and
is never used as machine-dependency evidence. A registry record with an
explicit empty `dependencies: []` declares no additional machine dependencies.

Observation facts are host reports for this projection only. They do not grant
permission, bypass human approval, or become dispatch tokens. A consumer must
continue to call the existing authority and execution paths. The pure projector
cannot authenticate a producer or establish freshness: the host must supply
fresh authoritative observations, and must pass `unknown` whenever it cannot
establish that. B1 adds no observation producer, route, poller, cache, or
persistence.

Inputs are JSON-like records with own enumerable string data properties. The
projector must not invoke accessors; symbols, accessors, hidden own properties,
unsupported values, or malformed records produce errors and cannot produce
affirmative readiness. Inputs are not mutated. Output order is deterministic
by capability ID using code-unit ordering.

## Entry semantics

Each valid, unique registry record projects to:

```js
{
  id: string,
  version: string | null,
  lifecycle: string,
  sourceDigest: string | null,
  binding: null | { kind: 'archon-workflow', workflowName: string },
  present: Fact,
  installed: Fact,
  verified: Fact,
  executable: Fact,
  eligible: Fact
}
```

- `present` is `yes` only because a unique valid identity appears in the
  accepted registry. It says nothing about local installation.
- `installed` is copied only from a matching explicit host observation. No
  repository file, registry record, or DSH plugin installation implies that a
  capability adapter is installed.
- `verified` is copied only from a matching independent verification
  observation. `evals`, `last_eval`, `provenance`, receipt-seal validity alone,
  or a success-looking field cannot make it `yes`.
- `binding` uses only a nonblank string at `record.workflow`; otherwise it is
  `null`. The only B1 binding kind is `archon-workflow`.
- `executable` is `yes` only when installation and runtime compatibility are
  explicitly `yes`, a binding exists and its exact name is present in an
  available workflow catalog, and every declared machine dependency is
  explicitly available. A known blocker yields `no`; missing evidence yields
  `unknown`. Missing binding is a known `no` for the current Archon route.
  This is a readiness summary, not permission to dispatch.
- `eligible` is `yes` only for lifecycle `promoted` or `verified` when
  `verified`, `executable`, and the matched current `authority` fact are all
  `yes`. `candidate`, `retired`, or `seed: true` is `no` regardless of
  historical eval material or affirmative observations. A known negative fact
  yields `no`; incomplete evidence yields `unknown`. Authority remains scoped
  to the host's current context and this display result never authorizes work.

Fact reasons are bounded display text. Missing evidence uses `unknown` with a
concrete reason; it is never upgraded to `yes`. Duplicate registry IDs are
ambiguous: omit every colliding record and return an error. Duplicate matched
observation identities are likewise rejected and their facts remain unknown.
Malformed individual entries return errors and are omitted; other valid unique
entries may still be projected. Unsupported or missing registry schema returns
no entries. Error objects are `{ code, message }` with bounded, non-secret
messages.

## Required tests

Cover missing registry and unsupported schema; null workflow candidate;
historical eval/provenance not being verification or executability; absent
dependency; wrong version and digest; duplicate IDs and duplicate observation
identity; missing authority; fully evidenced eligible capability; unknown and
unavailable catalog/runtime; stable ordering; no input mutation; malformed
objects/accessors; and refusal to infer a workflow from other fields.
