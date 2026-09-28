# Candidate: office-artifact (from dream-num/dsh-univer-office)

- Entry: `dshfind-api:dream-num/dsh-univer-office` (Apache-2.0, stars 429, fresh 2026-09-28).
- User outcome: document artifact — structured data + template in,
  .xlsx/.docx/.pptx bytes out with formula and layout checks.
- Proposed contract: inputs (data tables ≤100 rows, template id, output format),
  outputs (file bytes + row/column inventory), evidence (formula re-evaluation,
  byte digest, template pin), refusal cases (oversize data, unknown template,
  formula mismatch — never ship unchecked bytes).
- Why not native reuse: native office tooling covers single-shot file ops; the
  pack adds the repeatable evidence contract (recomputed formulas, pinned
  templates) for delegated document work.
- Binding: pending B2.
- Prerequisites: artifact output checks independent of the producer.
- Status: proposal. No code copied; no install, runtime, or compatibility claim.
