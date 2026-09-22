# P6B v2 — Offline Verification Record

**Phase:** P6B-v2 offline candidate (ruling: "P6B Ruling — A + B as separate guarantees · Offline GO")
**Battery window:** 2026-09-22T20:54:12Z → 2026-09-22T20:54:13Z
**Evidence root:** `p6b/offline-evidence-v2/` (worktree `rcos-cloud-path-v1`, nothing pushed)
**Environment:** disposable Linux VM (lima, aarch64, 4 CPU / 4GiB), node v20.20.2 — no network calls, no sandbox provisioning, no paid services, production execution host untouched.

This record returns the actual results and an explicit readiness assessment for a separately
authorized live validation, per §5. It stops after the offline candidate.

---

## 1. Evidence-loss disclosure (read first)

A first battery export existed only in host `/tmp` and was lost before reaching the worktree:

- host `/tmp` was wiped between sessions,
- the VM was rebooted (guest `/tmp` wiped),
- it was never copied into the worktree,
- its run ids (`20260922T211555Z-f02d9e`, `20260922T211730Z-4ad2c1`) were ~35 minutes ahead
  of the 20:40:44Z session anchor — an unexplained clock anomaly.

That export is unrecoverable. Its envelope (`dsh-org-env-p6b/1`) is not cited as evidence
anywhere. The battery was re-run deterministically with the same script
(`p6b/offline-battery-v2.sh`, sha `14e788f9…`) and every artifact was persisted directly into
the worktree. **This dsh-org-env-p6b/2 / this record is the authoritative battery.** The run
ids below are clock-sane (20:54Z vs the 20:40:44Z anchor).

---

## 2. Package identity (new, independent — does not replace v1)

| field | value |
|---|---|
| package | `rcos-kernel-subset-v2` |
| version | `0.2.0-candidate.1` |
| source revision | `9bd484999fd2d4b23d2141bd45ccb85559b37488` + uncommitted candidate working tree |
| manifest | `p6b/rcos-kernel-subset-v2.manifest.sha256` — 27 files, independently pinned beside the package |
| manifest sha256 | `55ec0e5fd65079836711e07bb0b1be6fc4d8f5b73965d67efc5b17f29dbf120f` |
| evals | `reuse-ledger-invariant-v2` (Repair A), `execution-posture-v1` (Repair B) |
| execution spec | `p6b/EXECUTION-SPEC-v2.md`, sha256 `ba02abd9…` |
| guard | `p6b/run-isolated.cjs`, sha256 `395e69a0…` |

The original reuse-ledger-invariant-v1 evaluation, its frozen package, and the historical
Run #1 / Run #2 artifacts remain immutable and independently identifiable. This package has
its own version, source revision, manifest, and evaluation identity; it does not silently
replace the original while retaining the same evidence identity.

## 3. Battery matrix — actual results (all first-run GREEN, every scripted assertion held)

| # | uid | eval | run id | verdict | exit | gates | eval-verify |
|---|-----|------|--------|---------|------|-------|-------------|
| 1 | 501 | reuse-ledger-invariant-v2 | `20260922T205412Z-dccd80` | **ship** | 0 | 4/4 ok | exit 0 — 7 artifacts hash-clean, verdict ship |
| 2 | 501 | execution-posture-v1 | `20260922T205413Z-7e300b` | **ship** | 0 | 4/4 ok | exit 0 — 6 artifacts hash-clean, verdict ship |
| 3 | 0 | reuse-ledger-invariant-v2 | `20260922T205413Z-a39f7a` | **ship** | 0 | 4/4 ok | exit 0 — 7 artifacts hash-clean, verdict ship |
| 4 | 0 | execution-posture-v1 | `20260922T205413Z-1ebff4` | **blocked** | 4 | 3 ok + BLOCKED `live_non_root_requirement` | exit 0 — 6 artifacts hash-clean, verdict blocked |

Verbatim lines:

```
run 20260922T205412Z-dccd80: ship — all 4 required gates pass
run 20260922T205413Z-7e300b: ship — all 4 required gates pass
run 20260922T205413Z-a39f7a: ship — all 4 required gates pass
run 20260922T205413Z-1ebff4: blocked — evaluation could not establish a result: live_non_root_requirement (blocked)
  ok  sync_refuses_without_trace_log / trace_append_moves_count / append_failure_leaves_registry_untouched / sync_reconverges_read_only
  BLOCKED live_non_root_requirement
```

Receipt sha256s (4 runs): `af33b7f1eb0cd638…` (501-inv), `0147f7ee18975f9e…` (501-post),
`57e40df6f173524b…` (0-inv), `afb028fc21cc8218…` (0-post). Full values in
`dsh-org-env-p6b.json`.

**Row 3 is the headline:** the EISDIR append-boundary fixture passes identically under uid 0
and uid 501. The append-failure invariant is proven under both tested privilege levels —
exactly what the chmod-0444 fixture could not do (v1 produced `fix 2/4` under root in Run #2).
This is **Repair A: privilege-independent failure testing**, kept as its own guarantee.

**Row 4 is Repair B:** root does not silently pass the non-root requirement. The sealed
`checks.json` (sha `eb16b883…`) records gates 1–3 `pass` exit 0 and gate 4:

```json
{ "id": "live_non_root_requirement", "status": "blocked", "exit_code": 4,
  "stderr": "environment-incompatibility: requirement non-root not met: effective uid is 0" }
```

The runner preserved the refusal verbatim; verdict `blocked`, not a fabricated ship. Non-root
UID alone is never treated as a complete sandbox boundary (gate 3 refuses any complete-sandbox
claim). Repair B does not substitute for Repair A and vice versa.

## 4. Isolation guard (fail-closed, at the execution boundary)

`run-isolated.cjs --check-only` × 4 (pre/post × both trees), all exit 0:

```
isolation-guard: OK — root …/tree-{501|root}/rcos-kernel-subset-v2 verified
(manifest 27 files, registry 1 capability reuse-ledger, RCOS_HOME pinned)
```

Every eval ran through the guard (manifest check → spawn with pinned `RCOS_HOME`); the guard
refuses non-manifested files outside the output dirs. It writes nothing itself — post-run
check-only also passed (only `runs/…` and `invocations/…` appeared).

## 5. Negative controls (gate rejects lying evidence)

| id | fault injected (disposable copy) | result |
|----|----------------------------------|--------|
| NC1 | step `registry_sha256` zeroed in `output.json` | exit **3** — `FAIL append_failure_leaves_registry_untouched: registry mutated by the failed append` |
| NC2 | one extra valid trace row appended to `evidence/traces.jsonl` | exit **3** — `FAIL sync_refuses_without_trace_log: the observation contradicts its own evidence: evidence/traces.jsonl does not match the trace rows in the observation` |

Original receipts were untouched (deterministic destructive controls ran only on copies).

## 6. Host-side verification (static)

- `scripts/check.js` → **PASS** exit 0 (hygiene + secrets + module graph).
- Evidence hygiene re-run after the pull: production-execution-host name literal /
  agent-prefix pattern / private home-directory paths → **0 hits**;
  secret-shaped patterns → **0 hits** (167 files).
- `runner-vnext` tests → **10/10 pass**. The §4 requirement is implemented and tested: if
  `receipt.json` is available but `checks.json` is missing, the original receipt is preserved,
  `diagnostics_missing:['checks.json']` is classified explicitly, and nothing is discarded;
  original evidence retrieval-before-destroy is specified for future live execution including
  nonzero exits.
- Worktree suites → `node --test test/*.test.mjs`: **tests 171, pass 171, fail 0**.

## 7. Readiness assessment (explicit)

**Ready (offline level):** the offline candidate package `rcos-kernel-subset-v2@0.2.0-candidate.1`
has passed its complete offline verification + negative-test battery per EXECUTION-SPEC-v2:
both guarantees demonstrated separately under both tested privilege levels, evidence-preserving
runner green, independent manifest + execution specification produced, all evidence persisted
to this worktree. **Stopping here and returning this evidence for review**, per §5.

**Next milestone (requires separate authorization — not requested, not started):** a new RCOS
live evaluation proving the append-failure invariant under both privilege levels, together with
a runner that preserves failure evidence, executed only if/when the thread authorizes live
validation with an authorized account, server-side credentials, and an explicit spending cap.

**Not claimed (non-claims):**

- No live validation. P6B live execution remains on HOLD. No Run #3, no third Solari sandbox,
  no paid cloud execution of any kind (actual metered spend this phase: $0.00).
- No host certification. Protocol-verified ≠ live-verified.
- No production readiness; **P6B is not SHIP**; P6C and P6D remain separate gates; a mock
  admission or this single offline pass is not verified promotion.
- No modification of the production execution host, no vNext contract change, no public push,
  no publication, no capability promotion.
- Forensic distinction preserved (§1): the EISDIR mechanism is a sufficient mechanism for the
  observed Run #2 failure signature. It does **not** prove the destroyed Solari guest's UID or
  establish that the missing original live receipt contained exactly the same detailed failures.
- Repaired-battery v1 evidence from the lost export is not claimed anywhere; only this
  authoritative 20:54Z battery is presented.

---

*Evidence: `p6b/offline-evidence-v2/` — `dsh-org-env-p6b.json`, `export.tgz`
(sha `95af198a…`, 167 files), `export/{logs,meta,tree-501,tree-root,nc1,nc2,
rcos-kernel-subset-v2.manifest.sha256,run-isolated.cjs,offline-battery-v2.sh}`.*
