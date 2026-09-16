# RCOS Control Plane — Product Architecture Proposal

Round: product architecture (per the RC0 PASS gate). **No implementation in
this round.** Everything here is constrained by the proven RC0 contracts:
the portable config (§3.3), the system manifest, the authoritative /status
surface and its six-state vocabulary, the sealed genesis receipt with
fingerprint staleness and tamper detection, and the seeded registry-routed
verification path (Probe A/B) — all REAL-STACK-PROVEN at `2505786`.

The thesis in one line: **GET RCOS → VERIFY MACHINE → ADD INTELLIGENCE →
GIVE IT WORK** — with every layer still drillable down to a workflow node, a
model invocation, an artifact, a receipt, or a machine.

---

## 1. Product surfaces (replaces the nine-tab accumulation)

Four surfaces, ordered by what a user needs, not by which subsystem owns the
data. Each existing tab maps into exactly one (§6 disposition table).

### 1.1 SYSTEM — "bring this machine online"

First-run and runtime management. A fresh install with no valid genesis
receipt opens HERE, not into an empty workspace shell.

```
RCOS — let's bring this system online.

  DSH .............. ✓ 0.1.0-rc.6 (verified pin)
  Archon ........... ✓ v0.10.1 (archon@0.10.1)
  Registry ......... ✓ rcos-public-v1 · 9 capabilities
  Browser tools .... ○ optional (agent driving off)
  Model provider ... – not configured (optional for verification)

  [ Verify RCOS ]        ← runs Probe A + Probe B; execution is the gate
```

- Verified → **RCOS VERIFIED — real execution completed through Archon ·
  genesis receipt sha256:71a7…** and the shell opens.
- The screen answers exactly the five Setup questions from the RC0 gate:
  what do I need / have / what's wrong / what can be verified now / what did
  RCOS actually test.
- Also owns: health over time, restart semantics (already documented per
  key), upgrade-through-reverification (a COMPAT pin bump stales every
  receipt by fingerprint — already mechanical), and Admin-stage items later
  (routing policy, bindings) behind a drill-in, not a new top surface.

Sources: `/status` + `/verify` + `system-manifest.json` — all already
machine-checked; this surface is a rendering of contracts that cannot drift.

### 1.2 WORK — one task, end to end (the everyday screen)

Solves the original "pick Runs, then Workflows, then Browser" split. The
center is ONE task; everything else is contextual.

```
┌ Task: "analyze this bearing drawing" ───────────── SHIP ┐
│ request → route → capability → workflow → nodes →      │
│ tools/subagents → artifacts → verification → verdict   │
│                                                        │
│  [Timeline] [Evidence] [Files] [Git] [Browser] [Receipt]│  ← contextual,
│                                                         //    attached panes
└────────────────────────────────────────────────────────┘
```

- A task = one request flowing through the chain above. DSH sessions and
  Archon runs are both views over tasks, not separate destinations.
- SHIP / FIX / BLOCK is the terminal verdict (Archon receipts already speak
  this language).
- Browser/Git/Files/terminal become **contextual execution surfaces** —
  attached to the task in flight, not places you "go".
- Depends on the identity model (§3) to stitch the chain end-to-end.

### 1.3 INTELLIGENCE — installed executable intelligence

Converges the current Workflows + Capabilities concepts into one catalog.
A user sees "what can this system do"; the implementation stack is a
drill-down, not the primary object.

```
Available Intelligence
┌────────────────────────────────────────────┐
│ bearing-drawing-analysis   v2.4   VERIFIED │
│ implements: manufacturing.drawing.analyze  │
│ requires: vision model · python3           │
│ evidence: 47 evals · reuse 12 · promoted   │
│ [run]  [details]                           │
└────────────────────────────────────────────┘
```

- Drill-down per capability: capability → workflow(s) → runtime/model
  requirements → dependencies → verification history → reuse → provenance →
  version → lifecycle state.
- Lifecycle (GPT's ladder, adopted):
  `DISCOVERED → INSTALLED → CONFIGURED → AVAILABLE → VERIFIED → PROMOTED →
  RETIRED`.
- **Correction (M0 authorization): verification state is NOT routing
  eligibility.** Verification is evidence/lifecycle state; eligibility is a
  derived decision. Two distinct concepts:
  - `lifecycleState` — where the capability is on the ladder above.
  - `routingEligibility` — `ELIGIBLE | INELIGIBLE | CONDITIONAL | UNKNOWN`,
    derived from evidence + CURRENT availability + compatibility + policy.
    A VERIFIED capability whose model/runtime disappeared is INELIGIBLE
    (reason: dependency unavailable); one forbidden for a task is
    CONDITIONAL; a fresh install with thin evidence may be UNKNOWN.
  - M0's derivation stays deliberately simple: verified + required
    dependencies currently AVAILABLE + compatible ⇒ ELIGIBLE — anything else
    is an explicit non-eligible/unknown state WITH REASONS, shown to the
    operator. No policy engine yet; lifecycle state is never the routing API.
- Seeded/example capabilities render with a distinct SEEDED badge — they can
  never be mistaken for accumulated production intelligence (existing seed
  markers carry over), and never visually compete with useful installed
  capabilities.

### 1.4 FLEET — contract-only now

Not in the first release. Design the seams so it fits: capabilities declare
requirements; machines expose what they are (arch, runtimes, providers,
execution adapters); the question RCOS eventually answers is **"where can
this capability execute?"** No distributed scheduling, no remote agent fleet
UI yet. The receipt's `executionAdapter` provenance is already the seed of
this: evidence names the machine class that executed.

---

## 2. First-run UX (fresh machine → RCOS_VERIFIED → first useful task)

1. User opens the UI on a fresh machine. No valid receipt ⇒ SYSTEM surface,
   full-screen, in plain language.
2. SYSTEM detects what exists (live probes, six-state vocabulary — never
   optimistic). Missing REQUIRED pieces get one-line fixes with copy-paste
   commands drawn from DEPLOY.md (the audited, classified bootstrap steps —
   every one AUTOMATABLE or a bounded human decision).
3. One click: **Verify RCOS** → Probe A (zero-credential machinery) → Probe
   B (seeded capability routed through the registry, executed by real
   Archon) → sealed genesis receipt. Progress shows the probes honestly;
   refusal states name the failing dependency (already proven by the break
   matrix).
4. RCOS VERIFIED banner with the receipt hash. The shell opens — SYSTEM
   stays reachable as a first-class surface.
5. **Correction (M0 authorization): genesis verification is NOT the user's
   "first useful task."** The seeded echo is the first VERIFIED execution —
   it proves RCOS works; it is not useful work, and it stays permanently
   SEEDED and SYSTEM-oriented. After the banner, the product transitions to
   WORK and asks: **"What do you want RCOS to do?"** If no useful
   capabilities are installed yet, that is surfaced honestly and the
   operator is directed to Add Intelligence — the natural progression is
   `system works → system has capabilities → user gives it work`, never
   teaching people that RCOS is a test harness.

The difference from a setup wizard: **verification requires execution.**
The green state is earned by a real run, sealed, and can go stale.

---

## 3. Canonical execution/event identity model

One task must be followable end-to-end across subsystems without private
knowledge. Proposed identity spine (each layer references the one above):

```
task_id            (RCOS-level identity, born ABOVE DSH/Archon at task
│                   admission — one user-visible unit of work)
 ├─ request        {text, attachments, submitted_at, origin}
 ├─ route_decision*{capability_id, capability_version, workflow, policy_ref,
 │                  reason, decided_at}                    ← registry truth
 ├─ execution*     {adapter: archon@0.10.1, run_id, conversation_id,
 │                  codebase_id, attempt, started_at}      ← Archon truth
 │   └─ nodes      [{node_id, status, duration, output_ref}]  ← DAG events
 ├─ artifacts      [{name, sha256, produced_by_node}]      ← hash-addressed
 ├─ verification   {receipt_ref, probe results, decision}  ← sealed
 └─ verdict        SHIP | FIX | BLOCK                      (per attempt)
                   (* = one task MAY have many)
```

Rules:
- **Each layer's truth stays with its owner** (no god-object): RCOS composes
  references; Archon owns run/node truth; the registry owns capability
  truth; the verifier owns receipt truth. This is the existing
  authority-per-field rule lifted to tasks.
- **Correction (M0 authorization): the task_id is born above DSH and
  Archon.** A task is NOT a session and NOT a run. The schema permits
  1-task → MANY route decisions / DSH sessions / Archon runs / attempts from
  day one; retries are the SAME task with distinct attempts. The 1:1
  mapping (one task = one existing DSH session or one Archon run) is an M0
  compatibility bridge only — the spine is assembled from ids that already
  exist today (run id, conversation_id, codebase_id, receipt path,
  capability id+version), but the identity itself is RCOS-owned and
  generated at task admission.
- Every evidence artifact is hash-addressed (receipts already are; extend to
  run artifacts), so "what did RCOS actually test" stays answerable at any
  layer, forever.

---

## 4. Component boundaries (no monolith)

```
┌────────────────────────── Control Plane (UI + contracts) ──────┐
│  SYSTEM · WORK · INTELLIGENCE · (FLEET later)                  │
│  exposes & coordinates — never re-implements                   │
└──────┬───────────────┬───────────────┬──────────────┬─────────┘
       │               │               │              │
   DSH (harness)   Archon (exec)   RCOS registry   providers
   cognitive/      workflow DAG    capability +    (own stores,
   agent runtime   runs/receipts   lifecycle       own auth)
```

- The control plane is **one client of many possible**; it reads
  authoritative contracts and coordinates (dispatch, verify), it does not
  absorb DSH, Archon, or the registry. RCOS must stay able to swap
  execution substrates (Pi, cloud workers) underneath.
- The plugin's host half stays read-only-toward-the-world plus the single
  verify POST — the control plane's write surface is receipts and
  coordination, nothing else.
- FLEET later = more rows in the same tables (machines as execution
  sources), not a new architecture.

---

## 5. Capability package manifest (design for FlowRouter — build nothing)

What a distributable RCOS capability package must DECLARE (not yet a
marketplace or package manager). Draft shape:

```yaml
package: manufacturing.drawing.analyze   # namespaced capability contract id
version: 2.4.0
identity: { author, license, homepage, signature }        # provenance, signed
provides:
  capability: manufacturing.drawing.analyze
  workflows: [ drawing-analysis-v2 ]      # bundled workflow assets
requires:                                  # runtime/model requirements
  runtime: { python3: ">=3.10" }
  models:  [{ role: vision, class: any-vision }]           # class, not vendor
  dependencies: [cad-parser >=1.2]
permissions:                               # declared, reviewed at install
  filesystem: { read: [./input], write: [./artifacts] }
  network: none
verification:                              # evidence, not promises
  evals: { count: 47, pass_gate: 0.9, last_run: 2026-09-14 }
  zeroCredentialProbe: probes/echo.yaml
compat: { rcosContract: X, archon: ">=0.10.1" }           # compatibility pins
lifecycle: { install: …, uninstall: …, migration: … }      # reversible ops
routing: { eligibility: VERIFIED, weight: 1.0 }            # policy inputs
```

Install flow (later): RCOS resolves the package → checks dependencies
against local truth → stages workflows/contracts → runs its verification
seed locally → **only then** flips lifecycle to routable. Uninstall is
reverse-plus-receipt-invalidation. This keeps RCOS core shipping "almost
nothing": core contracts + verification seeds + maybe a tiny starter pack —
FlowRouter becomes the distribution ecosystem, Chow becomes an instance
built on the platform rather than the architecture.

---

## 6. Disposition of every existing tab/feature

| today | disposition | where it goes |
|---|---|---|
| Runs | **merge** | WORK (session tasks) |
| Workflows | **merge** | WORK (execution detail) + INTELLIGENCE (workflow drill-down) |
| Capabilities | **merge** | INTELLIGENCE (the catalog core) |
| Summary | **merge** | WORK (task header/context cards); its System-verification cards move to SYSTEM |
| Git | **contextualize** | WORK attached pane (workspace evidence) |
| Files | **contextualize** | WORK attached pane (artifacts/browse) |
| Browser | **contextualize** | WORK attached pane (execution surface); stays optional |
| ⌘K palette | **keep** | global command surface |
| System-verification cards | **promote** | SYSTEM (first-run gate + health) |
| Genesis receipt view | **promote** | SYSTEM (+ drillable from WORK's verification pane) |
| (nothing) | **new** | task_id spine (§3), INTELLIGENCE lifecycle gating, package manifest schema |

Nothing is deleted outright; every tab's function survives inside a surface.
The nine destinations collapse to four surfaces + contextual panes.

---

## 7. Smallest product milestone after this round

**M0 — "verified machine, one honest task"** (authorized; keep narrow):

1. **SYSTEM v0**: the already-proven status/receipt/verification contract
   promoted into the first-run experience — no valid current receipt ⇒
   SYSTEM first-run; valid ⇒ normal shell. STALE / TAMPERED / NOT_VERIFIED
   stay visually and semantically distinct; state is never duplicated in the
   client (the contracts remain the only authority).
2. **WORK v0** (the key UX experiment): ONE coherent task view on the §3
   spine — request → route → capability → workflow/execution →
   result/evidence → verdict — for a real Archon-backed task. Browser/Git/
   Files attach contextually where evidence exists. No future node/subagent
   visualization yet.
3. **INTELLIGENCE v0**: merged catalog; capabilities primary, workflows
   inspectable beneath them. Lifecycle shown SEPARATELY from a derived
   `routingEligibility` (decision + reasons shown; the simple M0 derivation
   above; no policy engine). Seeded verification intelligence stays clearly
   SEEDED.
4. **FLEET**: contract only; at most a minimal read-only runtime identity if
   it falls naturally out of SYSTEM.
5. **Migration boundary (reversible)**: the nine-tab UI is NOT destroyed —
   a compatibility/debug flag keeps it available so legacy vs M0 can be
   compared on the same real task.

**M0 acceptance test** — a real (not mocked) Archon-backed task; an operator
unfamiliar with the internals must answer from the M0 UI alone: what did I
ask / what capability was chosen / why was it eligible / what workflow ran /
which execution corresponds / what did it produce / what evidence supports
the result / did RCOS accept-fix-block / where did it fail / what can I
inspect or intervene in. Every place the operator must leave WORK, read raw
JSON, use a CLI, or infer hidden state is recorded as M0 failure/debt.
Optimize for **legibility of execution**, not polish.

Everything else — FLEET scheduling, packages, policy engine, credential
entry — waits.

---

## 8. Explicitly NOT building yet

- Fleet scheduling / multi-machine execution (contract seams only).
- Capability package manager, marketplace, signature verification (manifest
  design only).
- Provider credential entry UI (presence checks stay; security design is
  its own round).
- Routing policy engine (state-gated eligibility as a simple filter first).
- Admin surface (routing policy, bindings, upgrades) beyond a SYSTEM
  drill-in placeholder.
- Any merge of DSH/Archon/RCOS/UI into one runtime (control plane stays a
  coordinator).
- v0.8-style tab features that deepen the nine-tab model.

---

## 9. ZCode parity map (2026-09-15 research folded in)

GPT's ZCode Desktop feature research (v3.10.2) is adopted as the capability
backlog for the control plane — mapped onto OUR four surfaces, not copied as
a monolith. The governing lesson from that research matches what RC0/M0
already proved: **UI is a replaceable control surface; sessions/runs are
durable runtime entities owned by DSH/Archon, and verification is a separate
evaluated state, never "the model stopped talking."**

### Already true in RCOS (built in Slices 0–2 / RC0 / M0)

| ZCode idea | RCOS form (exists today) |
|---|---|
| Goal Mode's separate verification step | sealed genesis receipt + Probe A/B + break/refuse matrix — completion is a separately evaluated, evidence-backed state |
| Task state UI (running/blocked/failed/done) | WORK task list with status + SHIP/FIX/BLOCK verdict chips |
| Turn execution summary | WORK spine: request → route → capability → execution (adapter+version) → evidence → verdict |
| Hooks / "termination is hookable" | receipt staleness + fingerprint invalidation; Archon approval gates on the execution path |
| Plugin = capability bundle | capability-package manifest proposal (§5): workflows + requirements + permissions + verification as one installable unit |
| Automations / idle queue (desktop-bound) | designed to live in ARCHON as durable workflow executions — the control plane only views/controls (beats the desktop-bound limit by architecture) |
| Repo Wiki as agent orientation | INTELLIGENCE + registry provenance: capabilities carry evidence, versions, and lifecycle truth agents can consume |
| Composer grammar (@/#,/, $) | DSH composer + ⌘K palette (exists); RCOS adds `@workflow` / `@capability` chips as a WORK-surface composer goal (M1+) |
| Read-only git surface | Git tab (read-only fixed-argv) — contextual pane in WORK |

### M1+ backlog (proposed order, after the M0 walkthrough gate)

1. **GoalRunner (P0)** — objective → Archon workflow execution → independent
   evidence verification (deterministic validators + eval workflows +
   multiple independent verifiers — a true quorum, NOT just another model pass; the v0 gate is two validation checks, quorum comes later) → SHIP / CONTINUE / BLOCK.
   State durable in Archon; the WORK surface renders objective, rounds,
   verification checklist, and next action. This is ZCode's best idea made
   stronger by our verification engine.
2. **Contextual ROUTE explanation (P0)** — the WORK spine's ROUTE row
   expandable: ✓ verified · ✓ deps available · ✓ compatible → selected from
   N eligible candidates (already flagged as M0 debt; the eligibility
   derivation exists, WORK just needs to inline it).
3. **Subagent/seat visualization (P0)** — Pi specialists + Archon dispatch
   rendered as parallel/background seats with returned evidence. Our
   agent/workflow/seat/runtime separation is already richer than ZCode's
   blended subagent config.
4. **Side conversations (P0)** — ask questions beside an active task without
   contaminating its timeline (DSH side-chat, attached to a WORK task).
5. **Edit + safe reset (P0)** — re-instruct and rewind that turn's file
   mutations, refusing unsafe restores (needs moving Git from read-only —
   its own gated round).
6. **Background processes detached from turns (P0)** — long builds/watchers
   as Archon runs, observable from WORK.
7. **P1**: repo wiki with verified/inferred/stale provenance states;
   task groups + change-counts (`+142 −37`) on task rows; scheduled Archon
   automations + idle-capability queue; remote/bot control of the same
   surfaces (FLEET seam); browser element-picker in the supervised browser.

### The boundary that stays (from the same research)

DSH = human control surface (conversations, composer, approvals, review).
Archon = durable goals, workflow state, schedules, verification, provenance.
Pi/specialists = isolated agent execution. Control plane = expose and
coordinate — never absorb. Every ZCode-derived feature lands as a client of
these contracts, never as new monolith logic.

---

### Interaction systems to mine next (design round 09-15, GPT adjudicated)

Stop mining ZCode/GooeyPi for visible features; mine them for interaction
systems that make an agent product feel coherent. Ten identified:

1. **Universal task/activity center** — a compact global indicator ("1
   running · 2 waiting · 1 needs you") answering "is anything actually
   happening?" without navigating.
2. **Human-attention / approval inbox** — one concept of "needs me":
   Approval required · Verification disagreement · Missing capability ·
   Permission required · Goal blocked · Evidence insufficient. The human
   side of SHIP/CONTINUE/BLOCK.
3. **Task handoff / resume card** — "Continue where you left off" with
   last objective, state, current attempt, why it stopped, next action.
4. **Diff-first change review** — "What did this task change?" as a task
   section (files created/modified/deleted, +/-, artifacts, causing
   execution), not the operator inspecting Git independently.
5. **Before/after task snapshot** — capture enough state at admission and
   completion that verification can reference the task's delta.
6. **Capability preview before execution** — expandable ROUTE stage:
   "intends to use X; requires Y; can access Z; expected output Q" — the
   natural future permission/trust layer.
7. **Artifact viewer as a first-class primitive** — tasks produce text/
   images/PDFs/CAD/G-code/JSON/reports; WORK should know "these are this
   task's outputs", preview, hash, and connect them to evidence.
8. **Command/action language** — ⌘K operating on RCOS concepts (Give work,
   Open task, Add intelligence, Verify system, Inspect capability, Stop
   execution, Open artifact).
9. **Trust/provenance inspector** — invented for RCOS, not copied: any
   consequential claim answers "why should I believe this?"
10. **Empty states that teach** — "RCOS has no intelligence for user work
    yet. Add a capability to teach it something it can execute and verify."

### The two named primitives (design-locked, implement after the walkthrough)

**1. Global RCOS Activity/Attention strip** — the single highest-leverage
first-time-polish addition. Restrained, in persistent navigation:

    ● 1 running · 1 needs attention        (or: ✓ RCOS ready)

Clicking opens a tiny activity drawer: Running ("Analyze README · Attempt 1
· Executing example-text-stats · 3s") / Needs you ("CNC quote ·
Verification disagreement · Review evidence →") / Recently finished
("Count README words · SHIP · 42s ago"). It is an observer/index over
authoritative execution state — never a new authority. Work, GoalRunner,
Archon background processes, automations, subagents, verification
disagreements, and Fleet all feed it.

**2. The Evidence Drawer** — the RCOS-specific killer primitive. Anywhere
RCOS makes a consequential claim (SHIP, ELIGIBLE, VERIFIED, COMPLETED,
artifact produced), a consistent Evidence affordance opens the chain:

    Claim:        Goal satisfied
    Supported by: Objective evaluator ✓ · Capability validation ✓ ·
                  Execution completed ✓
    Execution:    Archon run ee0588…
    Observed:     README.txt — Words: 7
    Delta:        No files changed
    Provenance:   example-text-stats@1.0.0 · registry hash · archon@0.10.1

The grammar: **RCOS makes claims. Every important claim can be opened to
see why RCOS believes it.** Recursive from SYSTEM's RCOS VERIFIED down to a
workflow result. This is where RCOS surpasses ZCode/GooeyPi.

---

### Second-page audit (09-15, Adam-requested second pass — 8 missed contracts)

First pass captured architectural headlines but underweighted operational
ergonomics. GPT adjudication: **ZCode/GooeyPi's best ideas aren't buttons
RCOS lacks — they're missing contracts.**

| # | ZCode/GooeyPi feature | Verdict | Stage | RCOS contract |
|---|---|---|---|---|
| 1 | Permission/execution personalities (Ask/Edit-auto/Plan/Full + model & reasoning as separate controls) | CONTROL PLANE — HIGH | M1 | **Execution policy contract**: PLAN_ONLY → ASK_BEFORE_ACTION → AUTO_WITHIN_POLICY → FULL_ACCESS, born with the task, inherited by attempts; intelligence selection ⊥ authority to act; feeds Approval Inbox + Evidence Drawer ("permitted by task policy AUTO_WITHIN_POLICY") |
| 2 | Conversation/task forking | CONTROL PLANE — HIGH | M1 data / M2 UX | **Lineage contract**: fork = NEW task_id (parent_task_id, forked_from_attempt_id, forked_from_event_id); inherits objective/context/settings/artifact refs; NEVER rewinds workspace state; attempt = same objective under same lineage, fork = new lineage |
| 3 | Project instructions (AGENTS.md) | CONTROL PLANE — HIGH | M1 | **Workspace Instructions contract**: capability definition ≠ workspace instructions ≠ operator prefs ≠ learned memory ≠ task objective; supports AGENTS.md import; provenance ("applied AGENTS.md:14"); conflicts exposed, never silently resolved |
| 4 | MCP server integration | CONTROL PLANE contract + RUNTIME execution | M1 schema / M2 UX | **Dependency contract**: `requires: {type: mcp, server, scope, transport, capabilities[]}` — RCOS describes/configures/verifies/routes; Archon/Pi/DSH execute; INTELLIGENCE shows "CONDITIONAL — Requires GitHub MCP — Not configured"; no secret side-effect installs; OAuth lives in the connection layer, isolated from manifests/receipts |
| 5 | Thinking/reasoning visibility | PARTIAL — REFRAME | M1 telemetry / M2 timeline | **Decision-evidence contract**: structured decision trace (Route 180ms → Plan 1.8s → Execute 420ms → Validate 90ms → Objective evaluation), concise execution/reasoning summaries, decisions, tool calls, timing, outcomes — NOT raw token-by-token CoT; model-independent, auditable, searchable |
| 6 | Bundled search tooling | RUNTIME | M1 infra | **Runtime primitive contracts**: fs.find / fs.search_text / fs.read_range / fs.list with stable schemas — deterministic machinery instead of model improvisation; control plane only shows "fs.search_text v1 — AVAILABLE/VERIFIED" |
| 7 | Session/state migration | CONTROL PLANE / distribution | M1 schema — must be mature before people depend on RCOS | **State continuity contract**: Detect → Inspect → Plan → Migrate → Verify → Receipt; provenance preserved ("Imported 14 tasks, 2 require re-verification, 1 dependency unavailable"); migration invalidates/reverifies trust claims that don't survive the move |
| 8 | Proxy/network configuration | SYSTEM + RUNTIME | M1 contract | **Network policy contract**: per traffic class (model/MCP/web/packages/workers) DIRECT/SYSTEM_PROXY/CUSTOM_PROXY/DENY; capabilities declare network requirements; runtime enforces, control plane owns config+policy+visibility; strengthens verification ("Network dependency: VERIFIED") |

GooeyPi elevations: **execution identity isolation** — seats/workers/tasks
receive only the credentials, MCP connections, filesystem and network access
they require (generalized credential isolation; a major future security
boundary that fits capability manifests); and **app-like capability
surfaces** — packages may declare `interaction: {surface, inputs,
artifacts, actions}` so FlowRouter packages become installable mini-apps
(M2/M3; control plane remains the shell; capabilities supply views, not
authority).

**Revised second-page priorities.** M1 foundations: durable task authority
+ task lineage/fork semantics; execution policy/permissions; workspace
instructions/provenance; objective evaluation/Claim→Evidence model. Then
infrastructure: normalized deterministic primitives, MCP dependency
contract, execution identity isolation, network policy, migration schema,
structured decision telemetry. Only then the visible parity items (task
trees, timeline UX, app-like surfaces, MCP management, dashboards,
marketplace, remote control).

---

## 10. Why this passes the stranger test

A stranger gets RCOS running and verified in minutes — the SYSTEM gate is
the proven verification path rendered in plain language. When something
matters, the same person (or the operator who follows them) can drill from a
task to its route decision, the exact capability version, the Archon run and
its node events, hash-addressed artifacts, and the sealed receipt naming the
adapter class that executed. Simple at the surface, inspectable to the
metal — and every green light is earned by execution, sealed, and allowed to
go stale.
