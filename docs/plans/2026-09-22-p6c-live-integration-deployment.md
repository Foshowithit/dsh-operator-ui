# P6C live-integration deployment — execution plan 2026-09-22

P6B CLOSED — LIVE VALIDATION ACCEPTED (GPT ruling 2026-09-22, thread 6ab16cac): reuse-ledger
SHIP 4/4, execution-posture SHIP 4/4, artifact verification 13/13, sandbox cleanup VERIFIED.
The three attempts remain visible: attempt 1 failed on the runner's stderr handling,
attempt 2 failed on artifact decoding, attempt 3 passed after offline corrections — neither
earlier attempt becomes a pass retroactively. GPT direction (verbatim): "Zcode — close P6B
and move to the next gate … close out its billing and evidence records, then advance the
work to P6C rather than keeping you in an approval loop."
Standing directive: work through Zcode without routine approval round-trips; stop only for
new money, a production change, public release, or a material expansion of scope.

OBJECTIVE
Deploy a live Archon orchestrator (v0.4.1, reviewed upstream commit) as an isolated local
instance so the DSH Operator conversation/dispatch protocol runs against a real
orchestrator for the first time, and prove one deterministic capability end to end:
workspace create → conversation provisioned and verifiably bound → workflow dispatched →
run terminal `completed` → evidence evaluated → sealed receipt — all over live HTTP, with
the solari-sandbox seam still refusing before any orchestrator contact.

GATE IDENTITY AND SCOPE (honest scoping — no prose definition of P6C/P6D exists upstream)
- P6C = the live-integration DEPLOYMENT gate named by `lib/solari.js` and pinned by the
  boundary test: "no Archon answers inside [a worker] until the separate live-integration
  deployment exists (P6C)". Opening it means a genuinely deployed orchestrator answers the
  conversation/dispatch protocol through an `archon-http` environment entry.
- P6D = a separate gate, untyped upstream: reserved for the Archon→Solari execution bridge
  (the `execution_provider` "matches" claim and the full DSH Operator → Archon → Solari
  path), which the P6B ruling explicitly excluded. P6C does not touch it.
- Out of scope: production-host changes, publication, spend, any change to the P6B frozen
  capability package or its receipts, and system-wide confinement claims (the P6B ruling's
  pre/post-guard caveat stands unchanged).

FINDING 1 (pre-live, offline) — `/setproject` does not exist in Archon v0.4.1
Evidence: the deterministic slash router (`command-handler.ts`) has no `setproject` case;
a repo-wide search returns zero; the help text advertises `/register-project` but no case
implements it either; the only web-path `codebase_id` bind in-repo is
`orchestrator-agent.ts`'s `updateConversation` inside `/workflow run` project resolution.
Consequence chain (a live run would fail at the conversation gate): operator `setProject`
POSTs `/conversations/{id}/message` with `/setproject …` → `dispatchToOrchestrator` always
returns `accepted:true` (HTTP 200 regardless of inner outcome) → `finishAssociation`
re-reads `codebase_id` → still null → `conversation-bind-unverified`.
Root-cause class: fixture drift — the name-based bind was validated against the mock's
`/setproject` fixture, which upstream never implemented. Exactly the defect class this
gate exists to surface.
Repair (offline, authorized by the standing directive's fixable-issue clause):
`provisionConversation` passes `codebaseId` (the `expectedCodebaseId` it already persists
as intent) in the create body. `createConversationBodySchema` accepts `{codebaseId?}`, the
route validates the codebase (400 on a stale id), and `getOrCreateConversation` binds the
row at birth — so `finishAssociation`'s first read sees the bound id, skips `setProject`
entirely, and verifies `liveCodebase === expectedCodebaseId` honestly. `setProject` stays
only as a legacy fallback for conversations that come back unbound with no expected id;
against v0.4.1 that fallback cannot bind, and the gate must then fail open-eyed. No Archon
source change. The misleading creation comment ("binding happens by NAME via /setproject")
is corrected.

DEPLOYMENT DESIGN (local and isolated — this deployment IS the named gate, not a
production change)
- Fresh instance at Archon v0.4.1 (reviewed upstream commit), bun toolchain.
- `ARCHON_HOME=~/.p6c/home` — fresh. Every derived path (`config.yaml`, `.env`,
  `workflows/`, `workspaces/`) derives from `getArchonHome()`, so the shared user-scope
  config is never read or written. No `.env` anywhere in scope → the boot smart-default
  holds, zero AI credentials in-process, bot/notification adapters stay off (tokens absent).
- `PORT=3097` pinned via `process.env.PORT`; `HOST=127.0.0.1` loopback only.
- Neutral cwd `~/.p6c/serv` so no project-scoped `.archon/` config or workflows load.
- Deterministic workflow `$ARCHON_HOME/workflows/rcos-p6c-echo.yaml`: unique name, one
  bash node echoing sentinel `rcos-verify-seed:rcos-verify-echo-v1`,
  `worktree: {enabled: false}` so the orchestrator skips isolation resolution and runs in
  the live checkout at `codebase.default_cwd` (no git required — verified in
  `dispatchOrchestratorWorkflow`).
- Executor gate (analyzed, then live-probed): provider resolves to
  `workflow.provider ?? config.assistant`; builtin providers register statically at boot
  and a bash-only DAG never calls an AI node — the run needs no credentials.
- Operator evidence config (separate `$DSH_HOME=~/.p6c/dsh`): `archon.baseUrl` → the
  deployed instance; environments = `env-p6c` (custom-remote + `archon-http` → baseUrl)
  AND `env-sandbox` (`solari-sandbox`, NO endpoint — the seam must still refuse it);
  authority `AUTO_WITHIN_POLICY` (grants `shell:execute`, not a holdout); registry
  `rcos-public-v1` carrying the verified `verify-echo` capability (six matching tags →
  routing score 1.0).

IMPLEMENTATION REQUIREMENTS (phases, executed autonomously under the standing directive)
1. Deploy the isolated instance; verify boot health (`GET /api/health`) and loopback-only
   listener before any other contact.
2. Protocol probes field by field against LIVE responses — not schema assumptions:
   codebase create (`id`/`default_cwd`/`name`), conversation create with `codebaseId` plus
   re-read binding, workflow discovery of `rcos-p6c-echo`, dispatch acceptance shape,
   run-list snake_case fields, status enum, run detail events. Any mismatch is a finding:
   record it, repair offline, continue.
3. Live confirmation of Finding 1: attempt the name-based bind on a throwaway
   conversation; record the accepted-but-unbound result verbatim as evidence.
4. Apply the Finding 1 repair in `provisionConversation`; boundary/refusal behavior
   untouched; conversation/workspace suites plus the full test suite green; contract
   checker FORBIDDEN-LITERALS clean with no key material.
5. Live negative: attempts bound to `env-sandbox` refuse at `requireOrchestratorProtocol`
   with code `solari-orchestrator-not-deployed` and zero orchestrator contact — the gate
   opens for the `archon-http` entry only, never by weakening the seam.
6. Live positive: one full goal run through `goal.js` — admission → workspace →
   environment → seam → dispatch → run terminal `completed` → `expectOutput` sentinel →
   objective evaluation → sealed receipt — effective user non-root, with
   `execution-provider-claim` `not-claimed` (honest: v0.4.1 stores no
   `execution_provider` column).
7. Report ACTUAL outcomes: separate P6C evidence file, log, shas, and a separate P6C
   verdict record — never merged into P6B's archive, never promoted on assumed pass.

REQUIRED NEGATIVE TESTS (live where marked, offline otherwise)
- Sandbox environment dispatch refused pre-client with zero orchestrator posts (live).
- Conversation created without binding never dispatches (operator T1 gate).
- Stale `codebaseId` on create → 400, no conversation row, no partial intent.
- Unresolved provisioning intent is never blind-minted into a second conversation.
- Auth refusal path: zero orchestrator contact (existing suite).
- Boundary suite unchanged and green: refusal deltas all zero, including `setProjectPosts`.
- Unknown objective routing refuses rather than guesses (existing suite).
- Spend surface untouched: no account change, no top-up, no new service (billing read
  once, read-only, at closeout).

GATE (P6C passes only if ALL hold, live)
A. Isolated instance healthy on loopback; boot shows no AI credentials, no bot tokens, and
   no read of user-scope config.
B. All protocol probes match field by field; Finding 1 confirmed live and repaired, the
   fix proven by a bound conversation re-read through the real operator path.
C. `env-sandbox` refuses at the seam, pre-client, zero posts.
D. One goal receipt: `completed`, sentinel found, objective SHIP, `environmentId env-p6c`,
   identity `adopted-run`, task envelope durable — reported as this run's actual result.
E. Full test suite green, contract check PASS, boundary test untouched.
F. Cleanup: instance stopped, no orphan processes; evidence archived outside the worktree
   with shas; P6B archives and records untouched; local commits only, zero push.

STOP-TRIGGER CHECK: none of the four triggers fire — local isolated deployment (the gate
itself), no spend, no production-host change, no publication, no scope change.
