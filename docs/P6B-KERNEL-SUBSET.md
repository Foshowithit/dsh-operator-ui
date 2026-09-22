# P6B Kernel Subset — Minimal Portable RCOS for `reuse-ledger-invariant-v1`

Preparation artifact for the P6B live gate (still **HOLD** — no sandbox creation, no
spending, until Adam authorizes account + cap). This document covers the second clause
of the P6B preparation directive: the minimal portable RCOS kernel subset required for
the existing `reuse-ledger-invariant-v1` evaluation, with source manifest, runtime
inventory, secret scan, exact execution commands, and the expected independent
verification procedure.

The SDK half of the directive is covered separately in `docs/SOLARI-P6B-SDK-INSPECTION.md`.

## 1. Provenance

- Source: the private Mac-cell RCOS repository at `~/zcode-rcos` (never pushed, never
  published). Revision at extraction: `703aa73e50008f852eeefbebac8a4e75a88bec00`
  ("rcos: weekly registry audit 2026-09-20 …").
- Method: files copied **verbatim** (byte-identical, no edits) into
  `p6b/rcos-kernel-subset/` in this worktree. Nothing in the subset was modified;
  only the *set* of files was reduced (see §5) and the executable bit preserved on
  `bin/rcos`.
- The private repo itself was treated read-only (one exception, disclosed in §9).

## 2. Source manifest (22 files, sha256)

The full hash list is machine-generated (never hand-copied) and committed at
`p6b/rcos-kernel-subset.manifest.sha256` — one `<sha256>  <path>` line per file,
relative to the subset root. Regenerate and cross-check with:

```bash
cd p6b/rcos-kernel-subset && find . -type f | sort | while read f; do
  printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "${f#./}"
done | diff - ../rcos-kernel-subset.manifest.sha256 && echo MANIFEST-MATCH
```

Spot values (from the committed manifest): `bin/rcos` begins `646ebdaab308079a…`;
the eval fixture `seed-registry.json` is `2793c39709e024ff…` — the same sha256 that
appears inside run receipts for both `evidence/inputs/seed-registry.json` and
`work/seed-registry.json`, which is itself a determinism check.
The 22 files are:

| Group | Files |
|---|---|
| Executable | `bin/rcos` (the whole CLI; requires all 12 libs at top level) |
| Kernel libs (13) | `lib/{adapter,admission,eligibility,evalrunner,evidence,invocation,jev-shadow,laya-shadow,registry,render,selection,traces,validate}.js` |
| Capability (4) | `capabilities/reuse-ledger/{EVAL.json,README.md,contract.json,adapter/run.js}` |
| Eval package (3) | `evals/reuse-ledger-invariant-v1/{eval.json,fixtures/seed-registry.json,gates/check.js}` |
| Registry (1) | `registry/capability-registry.json` (reduced, see §5) |

## 3. Runtime inventory

- **Runtime**: Node.js only — `v24.15.0` locally; any modern Node ≥ 18 with `node:test`
  is expected to work, but the verified version is v24.15.0.
- **Dependencies**: zero. Every `require()` in the subset is either a `node:` builtin
  (fs, path, os, crypto, child_process, zlib) or a relative `../lib/*` path. There is
  no `package.json` inside the subset, no `node_modules`, nothing to install.
- **Network**: none. The eval, its gates, and the reuse-ledger adapter make no network
  calls. The adapter spawns `RCOS_BIN` (resolved from `__dirname`, so relocation-safe).
- **Secrets/keys**: none required. Configuration is exclusively via the `RCOS_HOME`
  environment variable (plus the runner-set `RCOS_INPUT` / `RCOS_OUTPUT` /
  `RCOS_EVIDENCE_DIR` / `RCOS_INVOCATION_DIR` / `RCOS_BIN` / `RCOS_CAPABILITY_ID`).
- **Directory shape**: the repo root *is* `RCOS_HOME`. The subset is relocatable as a
  whole tree; `bin/rcos` finds libs relative to itself; evals and the registry are
  resolved under `$RCOS_HOME`.

## 4. What the eval does (why this is the right molecule)

`node bin/rcos eval-run --eval reuse-ledger-invariant-v1` drives a real capability
(`reuse-ledger`) through the real invocation kernel: the kernel invokes the adapter,
the adapter spawns `bin/rcos` against a scratch home, four deterministic gates
(`sync_refuses_without_trace_log`, `trace_append_moves_count`,
`append_failure_leaves_registry_untouched`, `sync_reconverges_read_only`) hash and
re-check the evidence, and a receipt plus eligibility decision are written under
`runs/<run-id>/`. `node bin/rcos eval-verify --run <run-id>` then re-hashes every
artifact named in the receipt. This exercises the reuse-ledger invariant end to end —
no mock, no benchmark checker, no rewritten evaluator.

## 5. Reduction: what was excluded and why

- **Registry**: the production registry has 22 capabilities; 21 were excluded. Four of
  those (`dell-gpu-dispatch`, `character-forge`, `local-talking-heads`,
  `video-forensics-receipt`) reference Dell/chow/local infrastructure and were never
  candidates. The rest (chromium/playwright, ffmpeg, MLX, model-key transports) cannot
  run in a Solari sandbox. The committed registry contains exactly one capability —
  `reuse-ledger`, copied verbatim from the production entry — plus
  `registry_version`. Any other capability id therefore fails registry lookup
  (this doubles as the unsupported-capability refusal control, §8).
- **Evals directory**: production `evals/` contains ~118 study-round directories of
  production experiment data. Only `evals/reuse-ledger-invariant-v1/` (eval.json +
  fixture + gates) was copied. The fixture registry is synthetic (`fixture-cap`,
  "Fixture capability (sandbox only)").
- **Capabilities**: only `capabilities/reuse-ledger/`.
- **Not copied**: run history, invocations, evidence-records, traces, selections,
  templates, migrations, scripts, docs, audits, runbooks, git metadata, and all other
  private production data. No infrastructure credentials exist in or were needed for
  the subset (the scan in §6 confirms).

## 6. Secret scan (procedure + result)

Procedure (run over all 22 staged files):

1. Identity/host/IP scan — `grep -rniE "/users/|adam|dell|chow|192\.168|10\.0\.|100\.[0-9]+\.|\.local|tailscale|hostname|api[_-]?key|secret|token|password|credential|bearer"`.
2. High-entropy literal scan — AWS `AKIA…`, GitHub `ghp_…`, OpenAI `sk-…`, and
   40+ char base64-ish runs, excluding the manifest's own sha256 lines.

Result: **zero findings**. All pattern hits were inspected and are false positives:
`.localeCompare` matching the `\.local` pattern; `token` appearing only as LLM usage
terminology (`input_tokens`, `budget_tokens_per_question`); and one comment in
`lib/laya-shadow.js` that literally says the transport needs "no
download/GPU/network/credentials". The `reuse-ledger` registry entry's lineage
mentions historical commit hashes (short SHAs) — identifiers only, not secrets.

## 7. Offline portable-run proof (no sandbox, disposable copy)

- Disposable copy: `/tmp/p6b-run1` (a plain copy of the subset tree), run with
  `RCOS_HOME=/tmp/p6b-run1` explicitly pinned.
- `node bin/rcos eval-run --eval reuse-ledger-invariant-v1` → run
  `20260922T154016Z-22cf21`, verdict **ship — all 4 required gates pass**, exit 0.
- `node bin/rcos eval-verify --run 20260922T154016Z-22cf21` → `ok: true`, 7 receipt
  artifacts hash-clean (`capability-input.json`, `checks.json`,
  `evidence/inputs/seed-registry.json`, `input.json`, `manifest.json`, `output.json`,
  `work/seed-registry.json`), exit 0. The two seed-registry copies share one sha256
  (`2793c397…`, identical to the staged fixture — deterministic byte-for-byte).
- Elapsed: seconds. No network, no keys.

## 8. Negative controls (disposable copy; original evidence untouched)

All three controls GPT specified, executed against the disposable run above:

1. **Tampering** — first attempt (string replace of `reuse_count` inside
   `output.json`) was a **no-op**: the literal does not occur in that file, so the
   bytes were unchanged and verification still passed. Recorded honestly as a failed
   tamper attempt. The *real* tamper (append one newline byte to `output.json`) →
   `eval-verify` **exit 3**, `MISMATCH output.json: sha256 mismatch (expected
   7668feb4…, got 492aed0d…)`, "run … FAILED verification".
2. **Missing artifact** — `rm runs/<id>/checks.json` → `eval-verify` **exit 3**,
   `MISMATCH checks.json: missing` (and the still-tampered `output.json` also
   reported — the verifier reports every failure, not just the first).
3. **Unsupported capability refusal** — the reduced registry contains exactly one
   capability; any other id fails registry lookup at invocation time. The adapter-side
   refusal surface (undeclared env vars, privileged env vars, unsupported operations)
   is covered by the worktree's `solari-negative` suite (16/16 passing), which refuses
   before sandbox creation.

## 9. Incident disclosure (record actual failures)

During the first offline proof run, `eval-run` was invoked from the disposable copy
**without `RCOS_HOME` set**. `bin/rcos` line 88 defaults to `~/zcode-rcos`, so one
full eval run wrote into the **production Mac cell**: exactly 4 directories, all
timestamped `20260922T153919Z` (`runs/…-d49275`, `invocations/inv_…-67d8f1`,
`eligibility/elig_…-865d2b`, `evidence-records/evid_…-11be5b`). The run itself passed
(ship), which is how the wrong home was noticed in the receipt's paths.

Cleanup and proof: the production registry (mtime Sep 20), traces (Sep 17), and all
pre-existing git modifications were confirmed untouched (`git status` diff limited to
pre-existing entries; no new modifications). Exactly the 4 timestamped directories
were removed; `find *20260922T153919Z*` now returns 0 entries. Nothing else was read,
modified, or removed. (A later `eval-verify` also ran once with the default home; it
is read-only and failed fast with "no receipt", writing nothing.)

Lesson, now baked into the exact commands (§10): **`RCOS_HOME` must be exported
explicitly in every command**; a defensive `env \| grep RCOS_HOME` assertion precedes
the run.

## 10. Exact execution commands (sandbox-side)

Transfer: push the 22 files (paths preserved) via the SDK's `files.write`, then:

```bash
# 0) assert the workspace root is pinned (hard requirement; see §9 incident)
export RCOS_HOME="<sandbox-root-of-subset>"
test "$RCOS_HOME" = "$(pwd)" || exit 9   # run from the subset root
env | grep -qx "RCOS_HOME=$RCOS_HOME" || exit 9

# 1) manifest check (independent re-hash of the transferred source)
shasum -a 256 -c <manifest> || exit 9

# 2) real RCOS execution — the existing evaluator, not a substitute
node bin/rcos eval-run --eval reuse-ledger-invariant-v1
# expect: "ship — all 4 required gates pass", exit 0; run id from stdout/receipt

# 3) independent verification — re-hash every receipt artifact
node bin/rcos eval-verify --run <run-id>
# expect: 7 artifact(s) hash-clean, ok: true, exit 0

# 4) negative controls — on a DISPOSABLE COPY of the run dir, not the original
cp -r runs/<run-id> /tmp/neg-tamper && printf '\n' >> /tmp/neg-tamper/output.json \
  && RCOS_HOME="$PWD" node bin/rcos eval-verify --run <run-id>   # expect exit 3 MISMATCH
```

Budget context: pure-node, seconds of wall time; at the microVM rate (~$0.086/hr) the
whole sequence is well under the proposed $1 cap — which remains **unauthorized**.

## 11. Expected independent verification procedure (GPT-side)

Given only the receipt GPT will receive, an independent party can verify by:

1. Re-hash the transferred subset against the committed manifest (§2) — byte identity
   to the private source revision `703aa73` is claimed, not asserted.
2. From the run receipt: recompute each artifact's sha256 and compare to
   `receipt.artifacts` (this is what `eval-verify` automates; exit 0 = clean).
3. Check the receipt's gate list against the eval.json's 4 required gates and the
   recorded verdict `ship`.
4. Re-run any negative control on a disposable copy and confirm exit 3 + MISMATCH.
5. Confirm the provider-returned sandbox identity, command exit statuses, original
   stdout/stderr receipts, and cleanup response are quoted verbatim, not paraphrased.

## 12. Boundary conditions

- Sandbox results are **candidate/forensic evidence only** — never promotion input,
  never merged into the production Mac cell's records.
- vNext contract untouched; production Dell untouched (modulo the disclosed §9
  stray-write, fully cleaned and proven); nothing published or pushed.
- **Live gate remains HOLD**: no sandbox creation until Adam authorizes the account,
  server-side credential configuration, and the $1 cap with no automatic top-ups.
