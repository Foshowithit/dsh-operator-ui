# P6E governed-capability-reuse deployment — execution plan 2026-09-23

P6D CLOSED — "P6D Ruling — ACCEPTED · Isolated End-to-End Bridge Verified" (GPT ruling
2026-09-23): gates A/B/C/D/E/F PASS on branch L2 with production deployment or
capability promotion NOT CLAIMED. Findings that bind this plan: (1) the ruling
establishes "the verified join between the two execution legs (P6B = RCOS on Solari
worker; P6C = Operator goal through real Archon; P6D = both legs for the same goal with
durable server-side bridge receipt and re-derived checks)"; (2) "`adopted-run`
attributes the Archon dispatch leg and is NOT a Solari execution-provider identity" and
"`providerId: solari-dev` identifies the configured provider and is NOT an
authenticated provider-origin claim; because the live run response lacks
`execution_provider`, L2 correctly records that claim as absent — not matched";
(3) "Preserve the failure history" — the workflow-timeout unit error and the probe
SHA-format error remain failed attempts with preserved evidence; (4) billing: "Record
the billing result as $0.00 reported at closeout, based on the available balance and
ledger observations, rather than as a guarantee about future ledger adjustments." GPT
direction (verbatim): "Zcode — close P6D and advance without another approval loop" …
"Bottom line: The isolated end-to-end execution path is demonstrated. The next
challenge is governed capability reuse—proving that a successful execution can become
a reusable capability through an explicit, evidence-backed admission process, without
silently granting it new authority." Standing directive: work through Zcode without
routine approval round-trips; stop only for new money, a production change, public
release, or a material expansion of scope.

OBJECTIVE
The accepted P6D execution envelope becomes a routing capability through ONE explicit,
evidence-bound admission call — every entry field derived from the stored envelope or
the pinned workflow bytes, never caller-declared except the reuse-authority request
(cross-checked to be a subset of the authority the recorded execution actually held),
the description, and the tags — and the capability is then EARNED live: a NEW
authorized goal with a distinct objective routes to it on match merit, auto-dispatches
the same frozen workflow through the P6E Archon to the real Solari worker under the
same non-root posture, mints its OWN bridge receipt, and ships; afterwards the history
read model shows the reuse while the registry bytes are provably unchanged since
admission — capability reuse visible, silent authority grant impossible.

GATE IDENTITY AND SCOPE (typed here — upstream defined P6E only as "governed
capability reuse")
- P6E = (a) an explicit admission route (P3B owner-bound, exactly one registry write
  inside the admission function, every entry field evidence-derived); (b) a reuse
  dispatch through the full P6D-proven bridge path with a NEW bridge receipt and a
  NEW SHIP envelope; (c) reuse read-back through the history read model (the dispatch
  never mutates the registry — proven live by a sha freeze); (d) negative proof that
  admission cannot grant authority the recorded execution did not hold.
- P6B, P6C, and P6D are closed and stay separate: their evidence, archives, and
  verdicts are untouched by this gate (the P6D SHASUMS set re-verified at closeout).
- Out of scope: no client UI for admission (explicitness = a POST route behind
  `authorizeTaskRecord`, the same grade as teach-promote and flowrouter-admit; a UI is
  a separate gate); no `reuse_count` writer (the history read model IS the reuse
  metric — teach/import init 0 and the client renders it only as fallback behind the
  history line); no Archon source change; no vNext change; no production host; no
  publication; no spend beyond the existing free credits; no change to the frozen
  workflow yaml bytes (sha pinned below); no change to the P6B frozen capability
  package or its receipt contract.

FINDING 1 (pre-live, offline) — the registry has exactly two writers; P6E adds the
third under the same discipline
Evidence: a repo search for the registry writeFile pattern returns exactly two
matches — `lib/teach.js` inside `promoteCandidate` and `lib/flowrouter.js` inside
`admitImport` — with `scripts/check.js` forbidding the pattern in `acquire.js` and
separately forbidding federation, discovery, and the history read model from writing
at all. `reuse_count` is dead metadata: initialized 0 by teach and flowrouter,
rendered by the client as a fallback behind the history line, never advanced. P6E
adds the THIRD and only new writer: the write lives inside `admitExecution` exactly
as flowrouter's lives inside `admitImport`, goal dispatch never touches the registry
(proven live by the sha freeze across phases 4–7), and check.js's census is extended
to expect exactly three registry-writing lib files with one write each.

FINDING 2 (pre-live, offline) — routing is merit-based, so admission must derive the
id the history groups on
Evidence: `routeObjective` gates bind the reuse design — score ≥ 0.5 AND hits ≥ 2 or
a weak-match refusal — so a caller-declared id cannot guarantee routing. Admission
derives `id` from `envelope.route.selected.id` (`verify-bridge`) and the name from
the envelope objective, so both envelopes group in history (uses = 2) and a distinct
reuse objective still routes on match merit. With the typed admission tags the reuse
objective is predicted to hit 5 of 7 terms (0.714) — a prediction, not a gate; phase
4 records the actual matched N/M. A disjoint objective must still refuse (live).

FINDING 3 (pre-live, offline) — the envelope carries the objective RESULT; routing
needs the evaluator SPEC
Evidence: the accepted envelope's `objectiveEvaluation` carries {status, pass,
checks} — a result — while goal evaluation derives its evaluator from
`capability.objectiveEvaluation` — a spec. `task-truth.js` supports only
'output-lines' / 'output-contains' (anything else is notEvaluated), so admission
DERIVES {kind: 'output-contains', value} from the exactly one distinct `contains:`
check's expected value; zero distinct contains-checks, several distinct values, or a
non-contains check → typed refusal `admission-evaluator-not-derivable`. The evaluator
is never caller-declared and never invented.

FINDING 4 (pre-live, offline) — no-silent-authority is one cross-check
Evidence: the caller's ONLY authority-bearing input is the reuse `requires` list. It
is validated against SCOPES via `requiresOf` (unknown scope → fail closed) and
cross-checked ⊆ `envelope.authority.granted` — naming a scope the recorded execution
did not hold → typed refusal `admission-requires-not-held`. Admission can NARROW
authority, never widen it; the entry carries the envelope's authority slice verbatim
as provenance so the bound authority stays auditable after the fact.

FINDING 5 (pre-live, offline) — the bridge stamp transfers; a reuse dispatch is a
re-verification, not a replay
Evidence: the envelope's worker stamp ({establishedBy: 'bridge-receipt', id,
environmentId 'env-p6d-solari', receiptSha256, …}) makes `goal.js`'s
capability.bridge block re-arm on reuse. Admission carries `bridge.environmentId`
ONLY — the receipt id does NOT enter the entry, because each dispatch mints its own
`brg_` id against the append-only store (one-shot sealed write), so the reuse
produces a second two-witness receipt instead of replaying the first. An incomplete
worker stamp (missing establishedBy / environmentId / receipt id / receiptSha256) →
typed refusal `admission-bridge-stamp-invalid` — partial evidence is never silently
dropped.

FINDING 6 (pre-live, offline) — one bytes channel for execute-and-pin
Evidence: `teaching.workflowsDir` points at `~/.p6e/home/workflows`, which receives
a byte copy of the P6D evidence yaml — sha `f802e973460116a5050cc3f4294827f56246ab8b
0d5f7effc560acb0f97c27ee` verified on both sides (the frozen bytes rule). Admission
pins `workflowSha256` from those bytes (unreadable → `admission-workflow-bytes-missing`);
`envelopeSha256 = 'sha256:' + sha256(JSON.stringify(envelope))` is computed inside
admission from the STORED record and re-derived on later reads, so store drift AFTER
admission is detected. Store authenticity at admission rests on the same trust every
store-backed promotion has (a P3B owner-bound record), anchored further by the
phase-3 cross-pin: the source runId `fb6b229c6bddf9ac878137ece697be94` and receipt
`brg_adee94a83cb5800b358a2be7fc7de345` must appear inside the P6D phase-6 log whose
sha `8ac76865cea8bf7139a46d4841748690afd2517dafe11c5e6108f984a62bfaa5` verifies
against the sealed SHASUMS.

FINDING 7 (pre-live, offline) — the status vocabulary decides the entry's status
Evidence: observed statuses — the P6D hand-seed wrote 'active'; teach/import write
'promoted'; routing refuses only 'retired'; flowrouter's export requires 'promoted'
exactly. Admission writes 'promoted' — routing-visible AND export-compatible. The
seed flag is never set (routing skips seed === true entries).

DEPLOYMENT DESIGN (local and isolated — this deployment IS the named gate, not a
production change; zero Archon source change — gate E means zero NEW change, not a
pristine tree: the instance carries the one pre-existing local mod
`packages/isolation/src/providers/worktree.ts` exactly as P6C/P6D ran with it, at the
same baseline commit `4964e2ab`)
- Fresh instance at Archon v0.4.1, bun toolchain, `ARCHON_HOME=~/.p6e/home` — fresh;
  every derived path derives from `getArchonHome()`, so shared user-scope config is
  never read or written. No `.env` in scope → boot smart-default, zero AI
  credentials in-process.
- `PORT=3098` loopback only; neutral cwd `~/.p6e/serv`; P6C-proven HOME setup
  replicated, including the resolvable `main` its thread worktrees need; ws git
  baseline (`git init -b main` + empty baseline commit) per the P6D observation.
- Operator evidence surface on `127.0.0.1:3198` with `DSH_HOME=~/.p6e/dsh`, config
  `operator-ui.config.json` mirroring P6D with typed deltas: archon baseUrl
  `http://127.0.0.1:3098`, tokenVar null, timeoutMs 5000; environments = `env-p6e`
  (custom-remote + `archon-http`, workspaceScope owners `['p6e-owner']`) AND
  `env-p6d-solari` EXACTLY as P6D (kind solari-cloud, providerId solari-dev, adapter
  solari-sandbox with empty transport, NO workspaceScope — the id must match the
  admitted stamp verbatim) AND `env-mixed` (owners `['someone-else']`); solari
  budgetCaps = documented free maxima (cpu 1, memMb 1024, timeoutMs 600000),
  maxConcurrent 1, workloadUser 'sandbox'; authority preset AUTO_WITHIN_POLICY;
  teaching {workflowsDir, workspaceDir} under `~/.p6e/home` (written absolute in the
  config file, which is a deployment artifact and never git-tracked); registry path
  `~/.p6e/dsh/registry.json` starting EMPTY ({registry_version: 'v1',
  capabilities: []}); NO auth section (dev posture — the P3B passthrough labeled
  honest, required-mode refusal suite-proven) and NO key fields: the runtime
  credential is read by the phase process from the authorized Keychain entry into
  `process.env` (the transport's documented tokenVar) — never argv, never logs,
  never config, never evidence.
- Admission module `lib/admission.js`: `admitExecution({goalTaskId, requires,
  description, tags})` — fail-closed gates in order: stored envelope exists
  (`admission-goal-not-found`); kind === 'goal' (`admission-not-a-goal`); closed +
  verdict SHIP + objectiveEvaluation.pass + capabilityValidation.pass + error null +
  failureCodes empty (`admission-not-shipped`, message names the failed gate); an
  attempt with runId and status 'completed' (`admission-no-completed-run`);
  route.selected present (`admission-route-unselected`); authority present with
  granted array (`admission-authority-missing`); requiresOf unknown scope
  (`admission-unknown-scope`); requires ⊆ granted (`admission-requires-not-held`);
  evaluator derivable (`admission-evaluator-not-derivable`); workflow bytes readable
  (`admission-workflow-bytes-missing`); duplicate id → "capability already in the
  registry — admission refused"; description ≤500 non-empty and tags ≤32 each
  matching `/^[a-z0-9][a-z0-9-]*$/` (`admission-metadata-invalid`); complete bridge
  stamp when present (`admission-bridge-stamp-invalid`). Entry: id/version/workflow
  from route.selected; name 'ADMITTED — ' + envelope.objective (≤200); status
  'promoted'; the caller's requires; verification {terminalStatus: attempt status,
  expectOutput: the contains expected}; objectiveEvaluation {kind: 'output-contains',
  value}; bridge {environmentId} when stamped; provenance {admission:
  'execution-admission-v1', sourceTaskId, sourceRunId, envelopeSha256,
  workflowSha256, authority verbatim slice, bridge {receiptId, receiptSha256} when
  present, admittedBy: 'operator', admittedAt}; admitted_after [], evals [],
  reuse_count 0, last_eval null. Exactly ONE writeFile — inside `admitExecution`.
  The phase-3 evidenceAnchor cross-pin is recorded in the PHASE LOG, never in the
  registry (caller-supplied provenance would be a trust leak).
- Route `POST GIT_ROUTE + '/admission'` (405 otherwise), body ≤2000, params sliced,
  `authorizeTaskRecord(req, goalTaskId)` FIRST (P3B) → sendAuthRefusal on fail;
  admission ok → 200 {ok, entry}; typed refusal → 409 {ok:false, code, error};
  catch → 500. No GET. goal / teach / acquire / marketplace must NOT import the
  module (static guard in check.js).
- check.js census: exactly three registry-writing lib files (teach, flowrouter,
  admission), one write each via the registry writeFile pattern, admission's write
  inside `export async function admitExecution` (indexOf ordering, like flowrouter's);
  must-include refusal strings + provenance keys; no import by goal/teach/acquire/
  marketplace; host includes `GIT_ROUTE + '/admission'`, `authorizeTaskRecord`, and
  `admitExecution`; `node --check` clean.

IMPLEMENTATION REQUIREMENTS (phases, executed autonomously under the standing
directive)
1. Deploy the isolated instance at `~/.p6e` (layout archon.log / dsh / evidence /
   home / serv / ws), write the config with the typed deltas, start the empty
   registry, git-baseline the ws, byte-copy the frozen yaml (sha verified both
   sides), boot Archon (`ARCHON_HOME=~/.p6e/home PORT=3098 HOST=127.0.0.1 bun`
   server entry, cwd `~/.p6e/serv`) and the operator surface, health-check both,
   dump config resolution, zero-secret scan — capture the deploy log and artifact
   shas BEFORE any other contact.
2. Offline code: `lib/admission.js` + the `/admission` route + the check.js census
   section + unit tests (fixture envelopes in `os.tmpdir()` homes: happy-path entry
   contract, the full refusal matrix with the registry byte-unchanged after each
   refusal, route score gates via the real `routeObjective`, PLAN_ONLY → approval via
   `decisionFor`, required-mode owner denial, history grouping of the two envelopes
   with uses = 2) → full suite green, contract check PASS, FORBIDDEN-LITERALS clean,
   no key → local commit → phase boots import the plugin fresh so the new route is
   loaded.
3. Evidence import + cross-pin + live admit: re-verify the P6D SHASUMS set (11
   entries, phase-6 log among them), confirm the source runId and receipt id appear
   inside that verified log, recompute the envelope sha == pin
   `9f2536fb37d79dff0dbffd966ece8c952266bfa8e806da66b52fec11e4b8a894`, write the
   P6E store byte-exact with only that envelope, POST `/admission` with the source
   goalTaskId `task-22695a67`, requires ⊆ granted, description and typed tags →
   assert registry 0→1, the full entry contract, provenance pins, reuse_count 0;
   record the registry sha R.
4. Live reuse: POST `/workspace` (owner p6e-owner) then POST `/goal` with a NEW
   distinct objective, owner p6e-owner, environmentId `env-p6e` — same invocation
   shape as the accepted P6D goal: route considered + matched N/M recorded (gates
   ≥0.5 / ≥2), authority auto-granted the same scopes, Archon dispatch of the frozen
   workflow, loopback `op=run`, uid 1000 under free caps, a NEW `brg_` receipt
   appended and verified against env-p6d-solari, bridge-provider-claim ok, terminal
   completed, SHIP envelope #2.
5. Read-back: history groups both envelopes under the derived id with uses = 2,
   objectives satisfied = 2, no decay flag; registry sha == R (dispatch never
   mutated it); both envelopes' `JSON.stringify` shas match their pins; the history
   line reads '2 uses · …'.
6. Live negatives with per-line evidence and sha-unchanged / restored assertions —
   see REQUIRED NEGATIVE TESTS.
7. Report ACTUAL outcomes: full suite, contract PASS, hygiene clean, key scan; P6B /
   P6C / P6D archives untouched (P6D SHASUMS re-verified 11/11); zero NEW Archon
   source change (git status = the one pre-existing mod + untracked tool dirs);
   git stack + zero-upstream proof; both processes stopped with death verified;
   billing read once, read-only, at closeout as an observation; separate P6E
   evidence directory, log, SHASUMS, and verdict — never merged into a prior gate's
   archive; shared-memory dated line; local commits only, zero push.

REQUIRED NEGATIVE TESTS (live where marked, offline otherwise)
- Unknown goalTaskId → `admission-goal-not-found`, registry sha unchanged (live).
- requires naming a scope the envelope did not hold → `admission-requires-not-held`,
  sha unchanged (live).
- Unknown scope name → `admission-unknown-scope`, sha unchanged (live).
- Re-admit the same source → "capability already in the registry" refusal, sha
  unchanged (live).
- Import the preserved FAILED fixture (the P6D phase-4 failed goal) →
  `admission-not-shipped` naming the failed gate, then the fixture is removed with
  the store byte-restored to its pre-import sha; both states recorded (live).
- Post-admission store drift (controlled byte flip) → the re-derived
  envelopeSha256 no longer matches the pin → detection fires → byte-restored (live).
- Disjoint objective (unrelated to the capability text) → routeObjective refusal at
  score 0, zero registry mutation, zero worker contact (live).
- PLAN_ONLY preset → `decisionFor` returns approval, never silent auto (offline).
- Required mode: wrong-owner task → TASK_DENIED; missing owner → UNATTRIBUTED; dev
  passthrough labeled mode 'dev' via publicAuth (offline).
- Evaluator-not-derivable / workflow-bytes-missing / authority-missing /
  route-unselected / non-goal / metadata-invalid / incomplete-bridge-stamp → typed
  refusals, registry byte-unchanged each (offline).
- Free-refusal order, worker-environment seam refusal, auth-refusal with zero
  orchestrator contact, never-write guards for acquire/marketplace/federation/
  history — existing suite green with the census now three (existing).
- Spend surface untouched: existing free credits only, no account change, no top-up
  (billing read once, read-only, at closeout).

GATE (P6E passes only if ALL hold, live unless marked offline)
A. Isolated instance healthy on loopback; no AI credentials in-process; no
   shared-scope config read; registry empty at baseline; workflow yaml
   byte-identical to the pinned frozen bytes; zero secrets anywhere.
B. Envelope imported byte-exact (sha equal on both sides); cross-pin holds — source
   runId and receipt id appear inside the P6D phase-6 log whose sha verifies against
   the sealed SHASUMS; the P6D store read-only.
C. Live admission: registry 0→1 behind `authorizeTaskRecord`; every entry field
   derived (only requires/description/tags caller-supplied); requires ⊆ granted
   proven in-line; evaluator derived; bridge carried; pins match; reuse_count 0; no
   import by goal/teach/acquire/marketplace; census exactly three writers.
D. Live reuse: routed on merit with the ACTUAL matched N/M ≥ both gates; authority
   auto-granted the same scopes; uid 1000; a NEW bridge receipt appended and
   verified against env-p6d-solari; bridge-provider-claim ok; SHIP envelope #2
   durable; every attempt preserved.
E. History shows both envelopes grouped with uses = 2, satisfied = 2, no decay;
   registry sha == R across phases 4–7; tamper detection bites on a controlled
   byte-flip and the store is restored; full suite green, contract PASS,
   FORBIDDEN-LITERALS clean, no key; zero NEW Archon source change.
F. Cleanup: both processes stopped with death verified; P6E evidence + SHASUMS
   archived outside the worktree; P6B/P6C/P6D archives and records untouched (P6D
   SHASUMS re-verified); local commits only, zero push.

STOP-TRIGGER CHECK: none of the four triggers fire — local isolated deployment (the
gate itself), existing free credits only (the billing line is an observation at
closeout, not a guarantee about future ledger adjustments), no production change, no
publication; scope is this typed gate only (the admission UI and a reuse_count writer
are explicitly deferred, not silently skipped); Archon beyond the carried
pre-existing mod, vNext, and the P6B frozen package untouched; all prior evidence and
failure history preserved.
