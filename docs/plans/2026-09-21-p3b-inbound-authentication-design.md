# P3B · Inbound Authentication — Scoped Design

> **Status (2026-09-21): design only, not implemented, not approved.** No code
> in this document exists. It is returned with the P3A implementation evidence
> for review, per the ruling that inbound authentication is a required gate
> *before* public or multi-user cloud access. Nothing here authorizes exposure.

**Goal:** close the caller-impersonation hole at the plugin's route boundary,
without becoming an identity platform, and without breaking the existing Local
execution path.

**Non-goal (explicit):** this design does not by itself make DSH Operator safe
to expose publicly. See §7 — the plugin does not own its own listener, so a
second layer outside this repository is a prerequisite that this work cannot
supply.

---

## 1. What exists today, measured

These are read from the tree at `b58389b`, not assumed.

| Fact | Evidence |
| --- | --- |
| There is no inbound authentication of any kind. | `grep -rn "req.headers" lib/index.js` returns no credential read. The only `authorization` in that file is **outbound** (`lib/index.js:77`, `'Bearer ' + process.env[tokenVar]` for the Archon call). |
| `owner` is a caller-supplied string, not a credential. | `lib/workspace.js:219` — `requireOwner(owner)` trims `body.owner` and rejects only the empty case. |
| Owner scoping is a *consistency* check, not an *authentication*. | `lib/workspace.js:246` — `if (known.owner !== ownerValue) throw … 'workspace-owner-mismatch'`. It proves the caller and the record agree; both sides of the comparison are supplied by the caller. |
| A caller can act as any owner by writing that owner's identifier. | Follows directly: `POST /goal {owner:"X"}` with no credential is honored as `X`. This is the hole. |
| The plugin does not own its bind surface. | `lib/index.js:833` registers a prefix handler into the **host's** web server (`ctx.webServer.register({kind:'prefix', path:'/plugins/operator-ui', handler})`). There is no `.listen()` in `lib/`. The bind address, TLS, and network reachability belong to the host. |

**Consequence for the design:** identity must be *established* by a credential
the caller presents, and the request body must stop being a source of identity.
The plugin's job is the chokepoint; the host's job is the perimeter.

---

## 2. The boundary

Two layers, because one is not in this repository.

**Layer 1 — host / proxy (outside this repo, host operator's).** Terminates
TLS, binds loopback or a private network, and is the only thing reachable from a
network. Public reachability cannot be created or prevented by plugin code.

**Layer 2 — plugin chokepoint (in this repo).** One credential check at the
single route dispatch point, before any handler runs.

The chokepoint is a real chokepoint: all fourteen routes (`/git`, `/files`,
`/archon`, `/rcos`, `/verify`, `/goal`, `/workspace`, `/environments`,
`/conversation`, `/teach`, `/acquire`, `/flowrouter`, `/federation`, `/f1`)
dispatch from inside the one handler registered at `lib/index.js:833`. A check
placed there is upstream of every handler, and no route can be added that
silently bypasses it.

---

## 3. The credential

A bearer token in the `Authorization` header, resolved to a **principal**:

```
principal = { principalId, ownerId, scopes[], environmentIds[] }
```

Principals are declared in `$DSH_HOME/operator-ui.config.json`:

```jsonc
"auth": {
  "mode": "required",
  "principals": [
    { "principalId": "adam-laptop",
      "ownerId": "adam",
      "tokenVar": "DSH_OPERATOR_TOKEN_ADAM",   // env var NAME, never the value
      "scopes": ["workspace:write", "goal:dispatch", "environment:select"],
      "environmentIds": ["env-local"] }
  ]
}
```

This is the pattern already proven in this repository for `archon.tokenVar`
(`lib/config.js:10`): **config holds the variable's name, the value lives in
the process environment, and the redacted projection reports presence as a
boolean** (`redactedConfig`, `lib/config.js:386`, `tokenConfigured`). No secret
value enters the config file, the repository, a receipt, a log, or a response.

**Why bearer + static principals rather than OAuth/OIDC/JWT.** It is the
smallest mechanism that closes the impersonation hole; it requires no new
service, no new persistence, and no new account model; it works unchanged in the
isolated development environment; and it is *replaceable at a seam*. The seam is
deliberately narrow — a function `resolvePrincipal(req, config) → principal |
null`. A later OIDC, mTLS, or host-supplied-identity implementation swaps that
one function and touches no handler. Scoped means this, not an identity
platform.

---

## 4. Per-request rules

Established before the handler runs:

1. **No credential, or a malformed one** → `401`, the handler does not run, and
   no orchestrator contact occurs.
2. **Unknown or revoked token** → `401`, compared in constant time, and the
   response body does not distinguish "unknown" from "wrong". The credential
   value never appears in a response, a receipt, or a log line.
3. **Body `owner` disagreeing with the principal's `ownerId`** →
   `403 owner-impersonation-refused`, naming the *field*, never echoing the
   credential. This is the direct answer to the ruling that a caller must not be
   able to impersonate another owner by supplying their identifier.
4. **Body `owner` agreeing, or absent** → accepted; absent is filled from the
   principal. (Positive control: the boundary is a door, not a wall.)
5. **Environment selection** is checked against the principal's
   `environmentIds` *in addition to* the existing `allowedOwners` scope on the
   environment itself. Two checks, because they answer different questions:
   *may this caller select it* versus *is this environment scoped to that
   owner*. A principal that is authorized to select an environment still cannot
   select one scoped away from its owner.

### Refusal shapes are preserved

P3A established, and its tests pin, that refusals on the two product paths have
**different shapes**: `POST /workspace` refuses as a transport error carrying
`code`, while `POST /goal` refuses as an HTTP 200 with `verdict: FAILED` and a
named `failureCode`, because "accepted and refused" is a product outcome rather
than a malformed request.

Authentication failures are a third category and are **not** product outcomes —
an unauthenticated caller has not been accepted into the product at all. They
are therefore transport errors on *both* paths (`401`), which is the one place
this design deliberately breaks the symmetry. Existing refusals keep their
shapes; the new refusals precede them.

---

## 5. Posture and the default

Three named modes, and **no mode that disables the boundary** — there is
deliberately no bypass switch to misconfigure:

| `auth` | Posture | Behaviour |
| --- | --- | --- |
| absent (`null`) | **dev-single-principal** | The existing local path is preserved, but a request whose apparent remote address is not loopback is refused `401`. Today such a request is *honored*; this is a strict tightening, and it is why the default closes the accidental-exposure hole without breaking any existing test. |
| `{mode:'required', …}` | **required** | Every request needs a valid credential, loopback or not. The production posture. |
| anything else | — | Refused at config read, with a named error. No unknown mode is ever silently treated as permissive. |

The loopback guard reads `req.socket.remoteAddress` (and `x-forwarded-for`
only when a trusted proxy is declared). Its honesty limit is stated in the code:
**a remote address is trustworthy only when no untrusted proxy sits in front**,
which is exactly why this is a development posture and not a production one.

---

## 6. Test plan (the P3B evidence shape)

Mirroring the P3A negative-test structure — child proves the response, parent
proves the orchestrator-side effect — because a refusal that still reached the
orchestrator is not a refusal.

| # | Leg | Assertion |
| --- | --- | --- |
| 1 | no credential | `401`, and the mock-archon counters show **zero** contact — proving the chokepoint precedes every handler |
| 2 | unknown credential | `401`; body does not distinguish unknown from wrong; the token value appears in no response body |
| 3 | impersonation | valid credential + `owner` of another owner → `403 owner-impersonation-refused`, zero orchestrator contact, no task envelope persisted |
| 4 | positive control | valid credential, `owner` absent → acts as the principal's owner and ships end-to-end |
| 5 | environment outside principal | `403 environment-unauthorized`, reached through the new check — proving the two environment checks compose |
| 6 | default posture | `auth: null` + non-loopback apparent address → `401` (the tightening) |
| 7 | secret hygiene | the resolved-auth projection carries `tokenVar` + a presence boolean only; no configured secret value appears in any response |
| 8 | two-sided | for every refusal above, the child proves the response and the parent proves the counters did not move |

---

## 7. What this design does NOT do

Stated plainly, because the gate is easy to over-read:

- **It does not make public exposure safe by itself.** The plugin does not own
  its listener (§1). Public access additionally requires Layer 1 — TLS, bind
  address, network policy — which is **outside this repository** and is a
  separate gate that this work cannot satisfy.
- It does not certify any host, and does not promote Solari to a certified host.
- No user database, registration, sessions, refresh tokens, OIDC, multi-tenancy,
  rate limiting, or audit-log service. Scopes are the single owner/environment
  pair, not a role system.
- It does not change the vNext contract, does not modify the production
  execution host, does not disturb the OP-4R worktree, and does not publish
  anything.
- It does not touch the Solari sandbox experiment, which remains a separate,
  approval-gated task.

## 8. Ordering

Public or multi-user access requires **all three**, in this order:

1. P3B Layer 2 implemented and its negative legs green (this design).
2. P3B Layer 1 present and verified (host/proxy: TLS, bind, network policy) —
   not in this repository.
3. An explicit go for exposure.

Until 1 and 2 are both satisfied, the current routes stay in the isolated
development environment, unexposed.
