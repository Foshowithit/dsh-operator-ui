# Post-Walkthrough Control Plane Implementation Plan

> **Status (2026-09-17): executed.** The truth core (`lib/task-truth.js`,
> `lib/activity.js`, the fixture evaluator, and their tests) shipped on `main`
> via the `m1-truth-reconcile` line, now merged with the operator-UI line in
> `08a265e`. The checkboxes below are left as the historical plan of record.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume the frozen RCOS/DSH control-plane work by making task identity, objective evaluation, and claim/evidence semantics authoritative before adding the global Activity/Attention strip and Evidence Drawer.

**Architecture:** Archon remains durable execution truth and the plugin adds no persistence. RCOS task identity is embedded in Archon `conversation_id`, so task projection can be rebuilt after a plugin restart; capability validation and objective evaluation become separate contracts, and UI claims are pure projections over those facts. Activity/Attention and Evidence Drawer consume those projections and never become an authority.

**Tech Stack:** Node.js >=22 ESM, DeepSeek Harness side-loaded plugin seams, Archon v0.10.x HTTP API, React client module in `lib/client.js`, built-in `node:test`.

**Spec:** `docs/RCOS-CONTROL-PLANE-PRODUCT-ARCHITECTURE.md`

## Global Constraints

- Preserve the RCOS seam: DSH = cognitive/control interface, Workflow Manager = capability planner, Archon = durable DAG/execution truth, Pi = bounded execution runtime.
- Additive DSH slots only; never replace shipped single-kind UI slots.
- No new persistence in this plugin. Durable task truth must be reconstructable from Archon runs and existing sealed receipts.
- Do not infer execution or goal state from chat text.
- `execution completed`, `capability validation passed`, and `objective satisfied` are three distinct truths.
- `SHIP` requires objective evaluation to be `SATISFIED`; execution success alone can never imply goal success.
- Activity/Attention is an observer/index over authoritative state, never a second task store.
- Every consequential claim must expose why RCOS believes it through the shared claim/evidence grammar.
- Before merge: `node scripts/check.js` must pass and the repo's manual install/render/remove verification must remain intact.

---

### Task 1: Durable task identity + objective/claim truth core

**Files:**
- Create: `lib/task-truth.js`
- Create: `test/task-truth.test.mjs`
- Modify: `scripts/check.js`

**Interfaces:**
- Produces: `admitTask(objective, uuid?)`, `taskConversationId(taskId)`, `projectTaskFromRun(run)`, `evaluateObjective(input)`, `buildClaim(input)`.
- `projectTaskFromRun` only recognizes Archon runs whose `conversation_id` begins `rcos-task-`.
- `evaluateObjective` returns `{status:'SATISFIED'|'NOT_SATISFIED'|'NOT_EVALUATED', pass:boolean, reason:string, checks:Array}`.

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { admitTask, taskConversationId, projectTaskFromRun, evaluateObjective, buildClaim } from '../lib/task-truth.js';

test('task identity survives through Archon conversation_id', () => {
  const task = admitTask('count the words in README.txt', '00000000-0000-4000-8000-000000000123');
  assert.equal(task.taskId, 'task-00000000');
  assert.equal(task.conversationId, 'rcos-task-00000000');
  assert.equal(taskConversationId(task.taskId), task.conversationId);
});

test('execution completion and capability validation do not imply objective satisfaction', () => {
  const result = evaluateObjective({ executionCompleted: true, capabilityValidation: { pass: true, checks: [] }, evaluator: null, evidenceText: 'done' });
  assert.equal(result.status, 'NOT_EVALUATED');
  assert.equal(result.pass, false);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/task-truth.test.mjs`
Expected: failure because `lib/task-truth.js` does not exist.

- [ ] **Step 3: Implement the minimal truth core**

Use `task-<8hex>` IDs, `rcos-task-<8hex>` Archon conversation IDs, projection only from matching Archon runs, explicit objective evaluator kinds (`output-lines`, `output-contains`), and the recursive claim support order `objective-evaluation → capability-validation → execution`.

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `node --test test/task-truth.test.mjs`
Expected: all Task 1 tests pass.

- [ ] **Step 5: Extend the contract checker**

`node scripts/check.js` must syntax-check `lib/task-truth.js`, run `test/task-truth.test.mjs`, and reject regressions that fuse objective evaluation into execution/capability verification.

- [ ] **Step 6: Commit**

```bash
git add lib/task-truth.js test/task-truth.test.mjs scripts/check.js
git commit -m "feat(goal): add durable task and objective truth contracts"
```

---

### Task 2: GoalRunner v1 uses the three-truth contract

**Files:**
- Modify: `lib/goal.js`
- Modify: `fixtures/capability-registry.example.json`
- Modify: `scripts/mock-archon.mjs`
- Test: `test/task-truth.test.mjs`

**Interfaces:**
- Consumes: Task 1 `admitTask`, `projectTaskFromRun`, `evaluateObjective`, `buildClaim`.
- Produces: Goal objects with `execution`, `capabilityValidation`, `objectiveEvaluation`, `claim`, and `verdict`.
- Dispatch uses `conversationId = taskConversationId(taskId)`; run discovery prefers exact `conversation_id` equality rather than only “new run with same workflow”.

- [ ] **Step 1: Add failing tests for objective-gated SHIP and run projection**

Add cases proving: no declared objective evaluator => `BLOCK`, declared evaluator with required evidence => `SHIP`, and an Archon run can reconstruct the task ID from its conversation ID.

- [ ] **Step 2: Verify RED**

Run: `node --test test/task-truth.test.mjs`
Expected: new GoalRunner-contract assertions fail before integration.

- [ ] **Step 3: Integrate task admission and exact conversation-bound discovery**

Replace GoalRunner's ad-hoc `goal-<uuid>`/random conversation ID path with `admitTask(objective)` and exact `conversation_id` discovery.

- [ ] **Step 4: Split verification into capability validation and objective evaluation**

Capability validation checks execution terminal status plus the registry `verification` contract. Objective evaluation reads the separate registry `objectiveEvaluation` declaration. Set `SHIP` only when execution completed, capability validation passed, and objective evaluation is `SATISFIED`; otherwise use `BLOCK` unless execution itself failed.

- [ ] **Step 5: Give `example-text-stats` an explicit objective evaluator**

Add:

```json
"objectiveEvaluation": {
  "kind": "output-lines",
  "required": ["README.txt", "Lines:", "Words:", "Bytes:"]
}
```

The mock non-seeded run must return those evidence lines plus `example-text-stats:done` so the contract is demonstrable end to end.

- [ ] **Step 6: Run focused tests + contract checker**

Run:

```bash
node --test test/task-truth.test.mjs
node scripts/check.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/goal.js fixtures/capability-registry.example.json scripts/mock-archon.mjs scripts/check.js test/task-truth.test.mjs
git commit -m "feat(goal): gate SHIP on objective evaluation"
```

---

### Task 3: Activity/Attention projection API

**Files:**
- Create: `lib/activity.js`
- Modify: `lib/index.js`
- Create: `test/activity.test.mjs`
- Modify: `scripts/check.js`

**Interfaces:**
- Produces: `projectActivity({runs, goals, receipt}) -> {running, needsAttention, recent}`.
- `/plugins/operator-ui/activity` is read-only and computes its response from Archon runs, GoalRunner projections, and receipt state on demand.

- [ ] **Step 1: Write failing projection tests** for running Archon work, blocked goals, verification disagreement, and recently finished SHIP.
- [ ] **Step 2: Verify RED** with `node --test test/activity.test.mjs`.
- [ ] **Step 3: Implement the pure projector** with no mutable store.
- [ ] **Step 4: Add the read-only host route** that fetches existing authoritative sources and passes them into the projector.
- [ ] **Step 5: Verify GREEN** with focused tests and `node scripts/check.js`.
- [ ] **Step 6: Commit** with `feat(activity): add authoritative activity projection`.

---

### Task 4: Global Activity/Attention strip

**Files:**
- Modify: `lib/client.js`
- Modify: `scripts/check.js`

**Interfaces:**
- Consumes: Task 3 `/plugins/operator-ui/activity` projection.
- Produces: persistent nav indicator (`● N running · M needs attention` or `✓ RCOS ready`) and a compact drawer with Running / Needs you / Recently finished groups.

- [ ] **Step 1: Add contract assertions** that the strip reads `/activity` and contains no client-side task authority or verdict derivation.
- [ ] **Step 2: Verify RED** via `node scripts/check.js`.
- [ ] **Step 3: Implement the strip and drawer** in the shared persistent surface navigation.
- [ ] **Step 4: Verify GREEN** with `node scripts/check.js` and the isolated DSH UI manual smoke.
- [ ] **Step 5: Commit** with `feat(ui): add global RCOS activity and attention strip`.

---

### Task 5: Shared Evidence Drawer / claim inspector

**Files:**
- Modify: `lib/client.js`
- Modify: `lib/index.js` only if a read-only evidence expansion route is required
- Create: `test/claims.test.mjs` if claim normalization expands beyond Task 1
- Modify: `scripts/check.js`

**Interfaces:**
- Consumes: Task 1 claim grammar and existing run/receipt/provenance facts.
- Produces: one drawer used by `SHIP`, `ELIGIBLE`, `VERIFIED`, `COMPLETED`, and artifact claims.

- [ ] **Step 1: Write failing claim-normalization tests** for nested supports and missing evidence.
- [ ] **Step 2: Verify RED**.
- [ ] **Step 3: Implement the Evidence affordance and drawer** showing Claim, Supported by, Execution, Observed, Delta, and Provenance.
- [ ] **Step 4: Wire consequential claims** from SYSTEM, WORK, Goal Mode, and INTELLIGENCE without duplicating derivation logic in the renderer.
- [ ] **Step 5: Verify GREEN** with tests, `node scripts/check.js`, and isolated UI walkthrough.
- [ ] **Step 6: Commit** with `feat(evidence): add recursive RCOS claim inspector`.

---

### Task 6: Final regression and walkthrough proof

**Files:**
- Modify: `docs/RCOS-CONTROL-PLANE-PRODUCT-ARCHITECTURE.md`
- Add screenshots under: `docs/screenshots-m1/`

**Interfaces:**
- Produces: a verified post-walkthrough receipt proving the new truth model plus the two named primitives.

- [ ] **Step 1: Run** `node --test test/*.test.mjs`.
- [ ] **Step 2: Run** `node scripts/check.js`.
- [ ] **Step 3: Perform isolated DSH manual verification**: install → first-run gate → Work goal → objective-gated SHIP/BLOCK → activity drawer → evidence drawer → remove plugin → sessions intact.
- [ ] **Step 4: Capture fixture-only screenshots** for Work, Activity/Attention, and Evidence Drawer.
- [ ] **Step 5: Update the architecture doc** to mark implemented primitives and record remaining interaction-system backlog without claiming future work is complete.
- [ ] **Step 6: Commit** with `docs(m1): record post-walkthrough control-plane proof`.
