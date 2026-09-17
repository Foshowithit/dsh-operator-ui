# Reproducing the FlowRouter evidence

Everything below re-runs the harnesses that produced the receipts in
`eval/receipts/`. Read this honestly: some phases re-run anywhere, one needs a
second machine, and the receipts — not this guide — are the primary evidence.

## 0. What you need

- **Node.js 22+** (the harnesses use `fetch`, `node:crypto` Ed25519 and ESM).
- The repository's `lib/` and `eval/lib/` (included); no external services.
- For the two-machine phases (P1-X and I0): **a second machine reachable over a
  network** (they were proven with two independent hosts), plus SSH access if
  you want the same orchestration the receipts used. Everything else runs on one
  host with loopback addresses.

Nothing here contacts the public internet, and no harness needs credentials.

## 1. Five minutes: read the sealed trace

```bash
node eval/lib/flowrouter-show.mjs
```

Prints the end-to-end trace, the seam values, the handoff table, the
adversarial campaign and the claim, all read from the committed receipts. No
network, no writes.

## 2. The structural invariants (fast, always worth running)

```bash
node scripts/check.js
```

Asserts, mechanically: no signing primitive appears anywhere in the replication
path (a mirror can forward a publication, never author one); discovery modules
cannot write local state; candidate identity is the exact tuple with
`claimed_D` excluded from it; the possession index carries exactly the five
frozen fields; content is committed before bindings; mirrored bindings stay out
of the discovery index; the capability-name grammar is the sealed one; and no
freshness/ranking vocabulary exists in the sync coordinator.

## 3. Re-running a phase receipt

Each harness is self-contained and prints `PASS`/`FAIL` per step, then writes
its receipt JSON. Example — the composition phase:

```bash
DSH_BIN=$(command -v dsh) node eval/lib/flowrouter-i1-composition.mjs
```

| Phase | Harness | Notes |
|---|---|---|
| R0 mirror replication | `eval/lib/flowrouter-r0-receipt.mjs` | starts its own repositories on loopback ports |
| F0 multi-repository resolution | `eval/lib/flowrouter-f0-receipt.mjs` | starts four repository services |
| F1 equivocation evidence | `eval/lib/flowrouter-f1-receipt.mjs` | uses the two-machine actor for the offline leg |
| D0 possession index | `eval/lib/flowrouter-d0-receipt.mjs` | includes a controlled hostile index |
| D1 endpoint directory | `eval/lib/flowrouter-d1-receipt.mjs` | includes a controlled hostile directory |
| S0 exact-scope backfill | `eval/lib/flowrouter-s0-receipt.mjs` | includes an adversarial F1 control |
| I1 composition | `eval/lib/flowrouter-i1-composition.mjs` | needs the consumer lane (`DSH_BIN`) |
| A0 adversarial campaign | `eval/lib/flowrouter-a0-adversarial.mjs` | matrix text: `eval/FLOWROUTER-A0-MATRIX.md` |
| I0 two-machine composition | `eval/lib/flowrouter-i0-walkthrough.mjs` | **needs machine B** (see §4) |
| P1-X independent machine | the P1-X harness plus the B-side actor (`eval/lib/flowrouter-b-actor.mjs`) | **needs machine B** |

Several harnesses expect a local consumer lane (the DSH operator UI plugin)
listening on a loopback port; they start and restart it themselves when
`DSH_BIN` points at a `dsh` binary. Where a harness needs a hostile server it
starts its own stub in-process — nothing external is required.

## 4. The second-machine phases (honest caveats)

P1-X and I0 were proven with **two independent hosts**: a publisher/origin host
("machine A") and a mirror/consumer host ("machine B"), with artifacts crossing
the network only. To reproduce:

1. Deploy the repository to machine B (`rsync` the `lib/` and `eval/lib/` trees;
   that deploy is code movement, disclosed in the receipts — artifacts
   themselves crossed by network fetch only).
2. Machine B needs: Node 22+, a writable home directory, and (for I0) a local
   execution runner plus the consumer actor used as one-shot processes.
3. Set the two host addresses:
   `I0_A_HOST=<machine A address> I0_B_HOST=<machine B address> node eval/lib/flowrouter-i0-walkthrough.mjs`
4. The harness deploys its own remote scripts under `eval/lib/i0-remote/`, so it
   is self-contained given SSH access; without a second machine, that phase
   cannot be reproduced and the receipt remains the evidence.

Note from building it: on machine B a session-scope kill reaps `setsid`
children, so in-place service restarts use `nohup` inside an uploaded script
(that is why `i0-remote/` exists). That is operational, not protocol.

## 5. How to read a receipt

Every receipt is raw JSON with:

- `generated_at` and the `spec` commit it was built against;
- a `steps` array — one entry per assertion, each with `ok` and the observed
  values (never a summary boolean only);
- phase-specific evidence: seam values and handoff records (I1), per-attack
  criterion/observed/verdict (A0), per-peer observations (F0), per-scenario
  outcomes (D0/D1/S0/R0/F1).

The **commit chain is the provenance**: each receipt commit is a child of the
implementation commit that produced it, and the spec was frozen before that. If
you want to check a claim, follow `eval/FLOWROUTER-CLAIMS.md` to the receipt,
then follow the receipt's parent commit to the code that ran.

## 6. What re-running does NOT establish

Re-running reproduces the behaviour on your machine; it does not extend any
claim. In particular nothing here can produce global freshness, detect
withholding, or make a first contact trustworthy — those are stated limits of
the design (`FLOWROUTER-CLAIMS.md` §3), not things more runs would fix.
