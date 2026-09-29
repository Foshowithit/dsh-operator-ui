# A2-b — Routing record (`rcos-routing-record/1`)

The typed record between the ordinary conversation (idea-chat / General seat) and any seat
dispatch. Design rule from the plan (9839ad5), enforced structurally:

- **Model interprets intent.** The model's decision is behavioral: it either calls
  `dispatch_seat` in a turn or it does not. The call IS the "procedural handoff" decision;
  the absence of a call IS the "conversational" decision. No code parses message text.
- **Code validates AFTER the model decision.** `validate_routing_record.py` checks a closed
  schema + authority + eligibility on records the emitter derives from runtime facts (the
  plugin's append-only audit log, `seat-dispatch.jsonl`, written before every dispatch
  value returns — including every refusal).
- **No token matcher selects capabilities.** Neither script reads `objective`/`reason`
  content to choose anything. The only string comparisons are field EQUALITY against closed
  enumerations (intent, authority basis, seat list) and the literal tool NAME in a journal.

## Intents (closed set)

| intent | model behavior | dispatch? |
|---|---|---|
| `conversational` | no `dispatch_seat` call in the turn | no |
| `read-only-inquiry` | no call; answered inline from reading | no |
| `clarification` | no call; asked the user | no |
| `procedural-handoff` | called `dispatch_seat` | yes (or refusal recorded) |

The emitter cannot distinguish the three no-dispatch intents from behavior alone (by
design — that distinction belongs to the model's reply, not to a matcher). It emits
`conversational` for a no-dispatch turn and accepts `--intent` to restate it as
`read-only-inquiry`/`clarification` ONLY when a human or the model's own structured output
supplied that label; the validator refuses a no-dispatch record carrying any dispatch
correlation and a handoff record without one.

## Files

- `emit_routing_record.py` — derives one record per audited dispatch for a session
  (`procedural-handoff`), or exactly one `conversational` record when the audit log has no
  lines for the session AND the session journal contains no `dispatch_seat` occurrence.
  Takes `--seats` (the configured seat list) so the eligibility fact in the record is
  computed against the same closed list the dispatcher enforces, never guessed.
  Exit 0 written; 2 inputs unreadable; 3 journal/audit conflict (call in journal, no audit
  line — never silently resolved); 4 no evidence either way.
- `validate_routing_record.py` — the gate. Exit 0 valid; 2 schema violation;
  3 authority refusal (handoff whose `authority_basis` is not a root basis);
  4 eligibility/consistency refusal (seat not in the configured seat list, or
  intent↔behavior contradiction).
- `test_routing_record.py` — fixtures + refusal paths (36 cases, green 2026-09-29).
- `fixtures/` — a REAL A1 loopback journal (clean conversational), synthetic but
  field-exact audit lines (see `fixtures/README.md`), and a conflict journal.

## Record shape

```json
{
  "record": "rcos-routing-record/1",
  "routing_id": "rr-<UTCstamp>-<6hex of sha256(session|run|ts)>",
  "ts": "<ISO8601>",
  "session_id": "<caller session id>",
  "turn_label": "<journal turn anchor or 'audit-only'>",
  "intent": "conversational | read-only-inquiry | clarification | procedural-handoff",
  "reason": "behavioral fact: the dispatch reason arg verbatim, or 'no dispatch_seat call in session journal'",
  "model_decision": {
    "how": "dispatch_seat-call | no-dispatch-call",
    "args": { "seat": "...", "objective": "...", "done_when": "...", "reason": "...",
              "constraints": [], "context": "" }
  },
  "validation": {
    "authority": { "basis": "lineage-clean-root|no-parent-root|delegated-child|not-caller-preset|unknown|none", "ok": true },
    "eligibility": { "seat_listed": true, "stage": "complete|authority|resolve|...", "ok": true }
  },
  "correlation": { "dispatch_run_id": "sd-...|none", "seat_session_id": "...|none",
                   "audit_log": "<path>", "audit_line_no": 1,
                   "archon_run_id": "...|none" }
}
```

Authority bases accepted for a handoff: `lineage-clean-root`, `no-parent-root` (the
plugin's own root gate — it refuses `delegated-child` callers and non-caller-preset
sessions before any seat exists, and the refusal is still audited, so a refused handoff
emits a record with `validation.authority.ok=false` which the validator flags as exit 3 —
that IS the failure-path evidence A2-d needs).
