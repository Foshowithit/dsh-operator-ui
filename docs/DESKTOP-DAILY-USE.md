# Daily-use candidate status (P4/E1 ledger)

Candidate: `bounded-research 0.1.0` (candidate, unbound). This document is
the exact manifest plus the honest gap list. It is not a release, a
promotion, or an install instruction for a live profile.

## Candidate manifest (exact)

| File | Identity |
| --- | --- |
| `capabilities/bounded-research/contract.json` | `rcos-capability-contract/1` |
| `capabilities/bounded-research/adapter/run.cjs` | sha256 `246b077f…e1fd5` |
| `capabilities/bounded-research/evals/run-eval.js` + `fixture-server.cjs` | 8/8 PASS, `--negative` exits 1 as required |
| `capabilities/bounded-research/registry-entry.json` | `status: candidate`, `workflow: null` |
| `test/bounded-research-capability.test.mjs` | 3/3 PASS |

## Journey rehearsal (headless, 2026-09-28)

- K2 dispositions cover all 13 K1 entries (validator `ok:true`); K4 built
  from the approved `bounded-research` brief.
- B2 `selectCapability` on the candidate registry entry returns
  `ok:false, code:absent-binding, binding:null, alternate:null` — the exact
  refusal the design requires: no binding, no fallback, no dispatch.
- Adapter evidence is independent: passage sha256 values are recomputed
  from raw evidence bodies; the eval's negative control proves the suite
  can fail.

## Install / rollback

Nothing installs: with `workflow:null` the entry cannot be selected for
execution, so there is no live state to roll back. Enabling needs (1) a
supported archon-workflow binding, (2) B2 selection success against a
promoted record, (3) admission in DSH's own flow. Do not replace the
user's app during development; the disposable-profile boot below comes first.

## Unresolved limitations (exact next commands)

1. **A2 disposable boot — DONE 2026-09-28** (active app untouched end-to-end):
   executed per `docs/DESKTOP-COMPATIBILITY.md` §A2 ("EXECUTED" section):
   verified zip re-fetched (SHA-512 feed match; asar `cf92b07a…8ef53865`),
   booted from scratch with a fresh `DSH_HOME` profile on isolated port
   19388, stock shell + auth + first session proven, session survived
   quit → relaunch, removal left real sessions/credentials/userData
   byte-identical. Exact command, port-override patch, isolation recipe and
   limits live in that section. Enabling daily use still needs items 2–4.
2. **P1 exact React bytes**: pin resolved `react`/`react-dom` + source
   digest from the target host source (ranges `^18.2.0` recorded; lockfile
   resolution and local bundled bytes still unproven), then flip
   `checkResolverProof` inputs and render the real factory without dispatch.
3. **C2 mount**: donor PanelDoc bytes are unidentified (untracked, dirty
   tree) with no reuse license — pin + review provenance first; the pure
   binding resolver (`lib/canvas-binding.js`, 6/6) covers the source-adapter
   half only. Then wire one seam and mount in the isolated profile.
4. **E1 live journey**: one complete task ×3 changed inputs, one
   unavailable-prerequisite case, one refusal, one failure + rerun/recovery
   — all in the disposable profile, all evidence-bound to exact bytes.
