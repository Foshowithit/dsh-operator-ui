# Candidate: image-studio (from shanliuling/dsh-image-gen)

- Entry: `dshfind-api:shanliuling/dsh-image-gen` (Apache-2.0, stars 513, fresh 2026-09-28).
- User outcome: media creation — prompt + constraints in, image bytes +
  provenance out (generate, edit, compare, gallery).
- Proposed contract: inputs (prompt ≤500 chars, size preset, seed),
  outputs (image bytes + seed/model record), evidence (provenance record,
  held-out prompt checks), refusal cases (missing provider credentials,
  policy refusal, generation failure — surface, never fabricate).
- Why not native reuse: no native image-generation tool exists on this lane;
  the pack wraps an operator-supplied provider behind an auditable contract.
- Binding: pending B2.
- Prerequisites: operator-supplied provider credentials (never bundled),
  output provenance checks.
- Status: proposal. No code copied; no install, runtime, or compatibility claim.
