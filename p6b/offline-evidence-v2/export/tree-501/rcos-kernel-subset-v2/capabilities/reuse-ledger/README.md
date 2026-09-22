# Reuse ledger invariant

Registry id: `reuse-ledger` · kind: `script`

Probes the invariant that makes the reuse count trustworthy: **the stored
`reuse_count` is a cache, and it may only move by appending a trace line.**
A cache with nothing to verify against is *unverifiable*, not empty — so it is
refused, never zeroed — and when an append fails, the registry must be left
byte-identical (trace first, registry second).

## Contract
- Covers: a registry whose `reuse_count` cache is checked against its trace log;
  the four observable steps are (1) `sync` with no trace log must refuse,
  (2) a `reuse-log` append moves the stored count, (3) a `reuse-log` whose trace
  append is blocked (read-only log) must leave the registry byte-identical, and
  (4) `sync` afterwards must find nothing to change.
- Does NOT cover: promotion, retirement, gate policy, or any judgement about
  whether a capability *should* have been reused. It observes the ledger; it
  does not rule on it.
- Adapter: `capabilities/reuse-ledger/adapter/run.js`, invoked by the RCOS
  invocation kernel (`rcos run reuse-ledger --input <file>`). Input is a seed
  registry to probe; output is the observation record the gates read.
- The probe runs against a SANDBOX home inside the invocation's work dir. It
  never touches the caller's `RCOS_HOME` — making the append fail on purpose
  requires a registry you are allowed to break.

## Evidence
`invocations/<invocation_id>/` holds the input, the observation, and the
supporting files the conclusion rests on: the sandbox registry as it ended up,
the trace log, and the per-step record.
