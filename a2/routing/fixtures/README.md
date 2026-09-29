# A2-b fixtures

- `journal-conversational-a1.zstd` — a REAL journal from the A1 loopback testbed
  (`~/dsh-a0-boot/home/sessions/.../session-73c7f33e-f7a4-482a-b964-4afd723da564/session.v4.jsonl.zstd`,
  copied verbatim 2026-09-29). Zero `dispatch_seat` occurrences — a genuinely no-dispatch
  session (it turned once and errored MISSING_CREDENTIAL before any tool could exist).
  This is the honest conversational fixture: not synthesized.
- `audit-synthetic.jsonl` — SYNTHETIC audit lines in the EXACT field shape of the
  plugin's `auditRecord()` (`dsh-seat-dispatch/lib/index.js`, one JSON object per line,
  every field present with realistic values). The synthetic part is the VALUES, not the
  shape. The REAL audit line (a live dispatch_seat call in the A2-c testbed run) lands in
  A2-c and replaces these for the production chain; until then these exist so the
  emitter/validator refusals are exercised against the true field names.
  Three lines: accepted handoff (lineage-clean-root, complete), delegated-child refusal,
  unlisted-seat refusal.
- `journal-conflict.txt` — synthetic plain-text journal whose tool-call event names
  `dispatch_seat` for a session with NO audit line: the never-silently-resolved conflict
  (emitter exit 3).
