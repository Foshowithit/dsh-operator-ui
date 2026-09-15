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

## 9. Why this passes the stranger test

A stranger gets RCOS running and verified in minutes — the SYSTEM gate is
the proven verification path rendered in plain language. When something
matters, the same person (or the operator who follows them) can drill from a
task to its route decision, the exact capability version, the Archon run and
its node events, hash-addressed artifacts, and the sealed receipt naming the
adapter class that executed. Simple at the surface, inspectable to the
metal — and every green light is earned by execution, sealed, and allowed to
go stale.
