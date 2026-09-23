# P6D execution-bridge deployment — execution plan 2026-09-22

P6C CLOSED — "P6C Ruling — ACCEPTED · Isolated Live Integration Verified" (GPT ruling
2026-09-22): gates A/B/C/D(Attempt 3)/E/F PASS, Archon → Solari execution explicitly NOT
TESTED, `providerClaim` correctly not-claimed. Two findings survive closeout and bind
this plan: (1) "The first two attempts remain failures… Preserve all three outcomes, not
just the final green result." (2) "The worktree assumption is now falsified for this
Archon version and path… The accepted contract is execution within the isolated P6C
scope, with the actual working_path recorded—not an assertion that execution occurs at
codebase.default_cwd. Future integration plans should use that observed behavior rather
than repeat the disproven assumption." The ruling adds: "These rulings are based on
Zcode's supplied receipt; I have not independently opened the private evidence archive."
and "The env-p6c tag and adopted-run identity demonstrate the tested local routing and
attribution contract. They do not establish a Solari execution-provider identity. Keeping
providerClaim as not-claimed is correct." GPT direction (verbatim): "Zcode — close P6C
and define the next bridge … The next engineering task is no longer proving that
Operator can dispatch through a real Archon instance, or that RCOS can run on a Solari
worker separately. It is proving that one authorized Operator goal travels through
Archon to that worker and returns independently verifiable, correctly attributed
execution evidence."
Standing directive: work through Zcode without routine approval round-trips; stop only for
new money, a production change, public release, or a material expansion of scope.

OBJECTIVE
One authorized operator goal travels the full path live — admission → workspace →
`archon-http` environment → dispatch → run inside the orchestrator's recorded thread
worktree → the workflow's bash node POSTs the operator's loopback `op=run` →
`executeScoped` runs a posture-gated capability on the real Solari worker under the
documented free-tier caps, credential read server-side only → the operator persists a
server-side bridge receipt carrying the provider claim established from the worker's own
run response → Archon run terminal `completed` with the bridge id and the inner non-root
sentinel in node output → goal evaluation loads the receipt from the server-side store
and re-derives the claim verdict against the bound worker environment's declaration → a
sealed receipt carries BOTH witnesses (dispatch leg and execution leg) and the claim
verdict is reported as this run's actual outcome — with the solari-sandbox dispatch seam
still refusing before any orchestrator contact.

GATE IDENTITY AND SCOPE (typed here — upstream defined P6D only as "a separate gate,
untyped upstream")
- P6D = the Archon→Solari execution bridge the P6B ruling excluded and P6C did not test:
  (a) the full DSH Operator → Archon → Solari path with one authorized goal, and (b) the
  `execution_provider` claim mechanism enforced at the goal receipt — live-verified
  exactly as far as the worker's run response exposes a claim (Finding 2's typed
  branches), protocol-verified for `matches` / `mismatch` / `unsupported`-to-BLOCK
  through the same receipt code. `matches` is never claimed live on assumed field
  presence.
- P6C is closed and stays separate: its accepted receipt proves dispatch attribution
  (`adopted-run`, not-claimed) and nothing about execution. P6B, P6C, and P6D evidence
  and verdicts remain separate; P6B/P6C archives are untouched by this gate.
- Out of scope: production-host changes, publication, spend beyond the existing free
  credits, any change to the P6B frozen capability package or its receipts, any change
  to Archon source, vNext changes, re-running the P6B evaluation battery through the
  bridge (its evidence stands), and system-wide confinement claims (the P6B ruling's
  pre/post-guard caveat stands unchanged).

FINDING 1 (pre-live, offline) — the dispatch leg can never carry the claim
Evidence: a repo-wide search of the deployed Archon tree (`packages`, `*.ts`/`*.js`)
returns zero occurrences of `execution_provider`; v0.4.1 run rows store no claim column.
The receipt contract at `lib/environments.js` states the claim is "Established BY THE
EXECUTION PATH, never by the caller … the run record the orchestrator itself returned" —
so an adopted Archon run is honestly `not-claimed` forever, and post-hoc injection into
`evidence.run` would be fabrication the contract forbids. The Solari-side builder
(`solariExecutionIdentity`) reads `raw.execution_provider` from the worker's run response
inside `executeScoped`, and the `op=run` response already returns that identity — so the
claim's only honest route to the goal receipt is: worker response → operator process →
persisted server-side bridge receipt → goal evaluation loads it. Composition: a
two-witness receipt. The workflow transports only the server-generated receipt id — a
workflow author can carry an id, never mint a verdict (no secret, no identity builder,
no store write is reachable from YAML).

FINDING 2 (pre-live) — the live run response has never been field-probed for a claim
P6B's recorded note — "SDK create/get response exposes no execution-identity field
(not-claimed); control-plane identity vs guest execution identity are never inferred
from each other" — covers create/get only; `executeScoped` reads the claim from
`handle.commands.run(...)`'s response, a different payload never observed field-by-field
live. Typed branches:
- L1: the run response carries a non-empty `execution_provider` → the worker
  environment's `providerId` is declared to the provider's observed self-name (the
  observation recorded as evidence) and gate D requires a live `matches`.
- L2: the response carries no claim → the live verdict is honestly `not-claimed` (ok),
  the absence is recorded as this gate's typed finding exactly as P6C recorded its own,
  and `matches` / `mismatch` / `unsupported`-BLOCK are proven protocol-faithfully
  offline through the SAME receipt code with a protocol-faithful mock response field.
Neither branch substitutes for the other; the probe chooses the branch and the verdict
reports it explicitly.

FINDING 3 (pre-live, offline) — `op=run` would execute the workload as root today
Evidence: the worker session default is uid 0 (P6B evidence: `defaultUid: 0`,
`defaultUser: "root"`); P6B Run #3 proved the per-command user switch lands non-root
(`honoredUser: "sandbox"`, string form, `userMeasured: "sandbox"`), and the SDK command
options carry `user?: string` — but `executeScoped` passes only `{args, cwd, env}`, no
user field, and `lib/solari.js` contains no workload-user reference. The standing rule —
"never fall back to running the posture-gated workload as root" — makes this a blocking
pre-condition: the bridge phase extends `executeScoped` to pass the config-declared
honored switch (`solari.workloadUser: "sandbox"`); a posture-gated run that measures
uid 0 fails with a typed refusal; the guest-side script self-gates (emits its sentinel
only at non-root). If the honored form ever changes, P6B's candidate ladder (username →
`nobody` → string-uid → number-uid, stop at first honored) is the bounded live repair.

FINDING 4 (pre-live) — `pollRun`'s hard 30s deadline vs bridge latency
`pollRun` gives up 30,000ms after dispatch (500ms loop) while the documented free window
allows `timeoutMs` up to 600000 — and the bridge node adds create/connect/exec/cleanup
to the Archon leg. Phase 4 measures terminal latency live; if it cannot land inside 30s,
the bounded offline repair is raising the goal poll deadline with recorded justification —
never claiming completion early, never lowering the provider's documented cap.

FINDING 5 (pre-live) — callback auth posture
`op=run` sits behind the P3B `authenticateRequest` chokepoint; required mode demands a
bearer, which can never sit in workflow YAML (a secret in YAML is forbidden), while dev
mode admits only loopback peers (`AUTH_REFUSAL.DEV_BOUNDARY`). The P6D instance
therefore runs dev posture with the loopback boundary live-probed as a negative; required
mode stays suite-proven offline, and "Loopback in required mode is NOT authentication"
remains the documented rule. The Solari credential never enters the workflow, the node
environment, the HTTP response, the bridge receipt, or any log — digests and scrubbed
fields only.

DEPLOYMENT DESIGN (local and isolated — this deployment IS the named gate, not a
production change; zero Archon source change: the node-kind enum is
command|prompt|bash|loop|approval|cancel|script — no HTTP/callback node exists, so the
bash node's loopback POST is the bridge's only possible egress, and the only source
changed is the operator's)
- Fresh instance at Archon v0.4.1 (reviewed upstream commit), bun toolchain,
  `ARCHON_HOME=~/.p6d/home` — fresh; every derived path (`config.yaml`, `.env`,
  `workflows/`, `workspaces/`) derives from `getArchonHome()`, so shared user-scope
  config is never read or written. No `.env` anywhere in scope → boot smart-default,
  zero AI credentials in-process, bot/notification adapters off.
- `PORT=3098` pinned via `process.env.PORT`; `HOST=127.0.0.1` loopback only; neutral cwd
  `~/.p6d/serv` so no project-scoped config loads. P6C's proven HOME setup is
  replicated, including the resolvable `main` its thread worktrees need.
- OBSERVED worktree behavior (replacing P6C's falsified paragraph — the accepted
  contract): the conversation thread worktree `archon/thread-<shortHash>` is created
  during dispatch regardless of `worktree: {enabled: false}`; workflow-level worktree is
  skipped by policy (logged `worktree_disabled_by_policy`) but the run executes inside
  the thread worktree with `run.working_path` recording it. Execution is within the
  isolated scope with the actual `working_path` recorded — never an assertion about
  `codebase.default_cwd`.
- Deterministic workflow `$ARCHON_HOME/workflows/rcos-p6d-bridge.yaml`: unique name; one
  bash node POSTing `http://127.0.0.1:<operator>/…op=run` with `environmentId
  env-p6d-solari`, a ≤200-char reason, budget fields clamped to the documented free
  maxima, and argv in the documented pipeline form `["sh", "-c", "…"]` whose script
  prints `id -u` and emits sentinel `rcos-bridge-sentinel:rcos-bridge-v1` ONLY at
  non-root (a root run produces no sentinel and fails the expectation). Zero secret,
  zero inline env in the workflow; node output captures the response (bridge id,
  identity transparency copy, inner stdout).
- Operator evidence config (separate `$DSH_HOME=~/.p6d/dsh`): `archon.baseUrl` →
  `http://127.0.0.1:3098`; environments = `env-p6d` (custom-remote + `archon-http`) AND
  `env-p6d-solari` (`solari-sandbox`, NO endpoint — the dispatch seam must still refuse
  it; `providerId` declared per Finding 2's probe); `solari.workloadUser: "sandbox"`;
  budget caps = documented free-tier maxima (cpu 1, memMb 1024, timeoutMs 600000,
  maxConcurrent 1, template `base`, region us-west); authority `AUTO_WITHIN_POLICY`;
  registry `rcos-public-v1` carrying a `verify-bridge` capability (workflow
  `rcos-p6d-bridge`, expectOutput = the inner sentinel).
- Non-root enforcement in `executeScoped`: pass the config-declared honored user switch
  on the command; posture-gated runs measure uid after the switch, and a uid-0 result is
  a typed refusal (`solari-non-root-required`) — root fallback is never taken.
- Bridge receipt store: after `executeScoped` finishes (cleanup then verification, as
  today), the `op=run` handler persists an append-only receipt under `DSH_HOME` keyed by
  a server-generated opaque id — environmentId, providerId, source, sandboxId, argvSha,
  timings, the providerClaim verdict built from the raw run response, run digests,
  verification outcome; scrubbed, no credential, no env values. The HTTP response
  returns the id plus identity/run for transparency; the artifact that travels back
  through Archon is only the id.
- Goal receipt extension (additive): when evidence outputs carry a bridge id, goal
  evaluation loads the server-side receipt, re-derives `identitySha256` over the stored
  tuple, resolves the receipt's `environmentId` to the bound worker environment,
  re-runs `providerClaimVerdict` against that environment's declared `providerId`, and
  records `goal.executionEnvironment.worker = {establishedBy: 'bridge-receipt', …}`
  plus flat check `{id: 'bridge-provider-claim', pass: verdict.ok === true}`. Goals
  without a bridge keep today's receipt shape exactly (check absent, behavior
  unchanged); a bridge-declaring capability whose id is missing, unresolvable, or fails
  re-derivation fails closed — claim failures are BLOCK-class, never softened by a
  green objective. Two witnesses, never folded: the dispatch leg stays `adopted-run`
  (honest not-claimed today), the execution leg carries the claim; `receiptEnvironment`
  stays declaration-only, compared — never merged.

IMPLEMENTATION REQUIREMENTS (phases, executed autonomously under the standing directive)
1. Deploy the isolated instance (P6C-proven HOME setup, resolvable `main`) plus the P6D
   operator config; verify boot health (`GET /api/health`), loopback-only listener, zero
   AI credentials, no shared-scope read — before any other contact.
2. Live field probe (Finding 2): start the operator; one evidence-preserving probe
   execution through `env-p6d-solari` under free caps (credential read server-side;
   switch honored per the P6B ladder); record the run response field by field — claim
   field presence/value — choose branch L1 or L2 explicitly, finalize the `providerId`
   declaration to the observation (or record its absence), and record `id -u` output as
   the non-root proof. Any mismatch is a finding: record it, repair offline, continue.
3. Offline code phases with tests: the non-root switch + typed uid-0 refusal; the bridge
   receipt store (id transport, append-only write, load, sha re-derivation); the goal
   worker leg + `bridge-provider-claim`; unit negatives for `matches` / `mismatch` /
   `unsupported` / `not-claimed` / missing id / tampered receipt / unresolvable
   environment; no-bridge receipts unchanged. Full suite green, contract check PASS,
   FORBIDDEN-LITERALS clean, no key material anywhere.
4. Workflow + latency: dispatch `rcos-p6d-bridge` and measure terminal latency against
   `pollRun`'s 30s deadline (Finding 4); bounded repair with recorded justification if
   needed.
5. Live negatives (each with its evidence line): see REQUIRED NEGATIVE TESTS.
6. Live positive: ONE authorized goal run end to end — admission → workspace →
   `env-p6d` → seam → dispatch → thread-worktree execution → bash node → loopback
   `op=run` → non-root Solari execution under free caps → bridge receipt persisted →
   terminal `completed` → inner sentinel found in evidence → worker leg loaded and
   re-derived → claim verdict reported ACTUALLY per the chosen branch → objective SHIP →
   sealed two-witness receipt; task envelope durable; effective user non-root.
7. Report ACTUAL outcomes: separate P6D evidence directory, log, shas, and a separate
   P6D verdict record — never merged into P6B/P6C archives, never promoted on an
   assumed pass; every failed attempt preserved unaltered; billing read once,
   read-only, at closeout; local commits only, zero push.

REQUIRED NEGATIVE TESTS (live where marked, offline otherwise)
- Worker environment dispatch refused at `requireOrchestratorProtocol` pre-client with
  zero orchestrator posts (live).
- Non-loopback peer refused at `op=run` under dev posture (`DEV_BOUNDARY`), zero
  execution, no bridge receipt written (live where probeable).
- `op=run` unknown environment / bad owner → typed refusal, no worker contact.
- Free-refusal order intact: missing reason, shell-string command, inline env, over-cap
  budget, concurrency — all refuse before the credential is read (existing suite).
- uid-0 result on a posture-gated run → typed `solari-non-root-required` refusal; root
  fallback never taken (unit + live `id -u` = 1000 evidence).
- Bridge id absent on a bridge-declaring capability → the P6D claim letter cannot pass.
- Tampered bridge receipt (sha drift, edited claim, unresolvable id) → worker leg fails
  closed → BLOCK-class, never softened by a green objective (unit).
- Unknown claim value → `unsupported`, `ok:false`, `execution-provider-unsupported`
  (protocol).
- Forged `execution_provider` on a protocol-mock adopted run → `mismatch` → BLOCK —
  claim enforcement proven, not merely recorded (protocol).
- Auth refusal path: zero orchestrator contact (existing suite); required-mode
  loopback-is-not-authentication stays suite-proven offline.
- Spend surface untouched: existing free credits only, no account change, no top-up
  (billing read once, read-only, at closeout).

GATE (P6D passes only if ALL hold, live unless marked offline)
A. Isolated instance + operator config healthy on loopback; boot shows no AI credentials
   and no shared-scope config read; the workflow artifact carries zero secrets (yaml
   archived as evidence).
B. Live probe of the run response recorded field by field; branch L1/L2 chosen
   explicitly — L1 requires a live `matches`; L2 records live `not-claimed` with the
   absence typed, and `matches` / `mismatch` / `unsupported` proven offline through the
   SAME receipt code. `id -u` = 1000 on the live probe.
C. Seam refusal unchanged (worker environment dispatch, pre-client, zero posts);
   dev-boundary refused; free-refusal order intact.
D. One goal receipt: terminal `completed`, inner sentinel found, objective SHIP,
   dispatch identity `adopted-run` AND worker leg present + re-derived +
   `bridge-provider-claim` ok with status reported ACTUALLY per branch — this run's
   actual result, every attempt preserved, task envelope durable.
E. Full test suite green, contract check PASS (FORBIDDEN-LITERALS clean, no key),
   bridge extension additive (no-bridge receipts behavior unchanged), boundary test
   untouched, zero Archon source change.
F. Cleanup: instance stopped, sandbox killed with death verified, no orphan processes
   or listeners; evidence archived outside the worktree with shas; P6B and P6C archives
   and records untouched; local commits only, zero push.

STOP-TRIGGER CHECK: none of the four triggers fire — local isolated deployment (the gate
itself), existing free credits only, no production-host change, no publication; scope is
this typed gate only (the two-witness bridge receipt IS the P6D typing, not an
expansion), the P6B frozen package untouched, Archon source untouched, vNext untouched.
