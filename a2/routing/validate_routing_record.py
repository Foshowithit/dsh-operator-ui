#!/usr/bin/env python3
"""Validate a rcos-routing-record/1 document (A2-b gate).

The validator runs AFTER the model's behavioral decision and AFTER the emitter derived a
record from runtime facts. It decides three things, in this fixed order:

  1. SCHEMA (exit 2) — the record is a closed shape: known record tag, routing_id
     pattern, ts parseable, closed intent enum, closed `how` enum, closed authority-basis
     enum, and internal consistency of validation.ok flags with their bases.
  2. AUTHORITY (exit 3) — a procedural-handoff whose authority basis is not a root basis
     (lineage-clean-root | no-parent-root). Refused handoffs are still valid RECORDS;
     this exit is the machine-readable refusal, which is exactly the failure-path
     evidence A2-d requires.
  3. ELIGIBILITY / CONSISTENCY (exit 4) — the requested seat is not in the configured
     seat list, or the intent contradicts the recorded behavior (a handoff with no
     dispatch correlation; a no-dispatch record carrying dispatch correlation).

No message text is parsed. The only string comparisons are field equality against the
closed enumerations and the configured seat list.

Exit codes: 0 valid · 2 schema violation · 3 authority refusal · 4 eligibility or
consistency refusal.
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

RECORD = "rcos-routing-record/1"
INTENTS = {"conversational", "read-only-inquiry", "clarification", "procedural-handoff"}
NO_DISPATCH = {"conversational", "read-only-inquiry", "clarification"}
HOWS = {"dispatch_seat-call", "no-dispatch-call"}
BASES = {"lineage-clean-root", "no-parent-root", "delegated-child", "not-caller-preset",
         "unknown", "none"}
ROOT_BASES = {"lineage-clean-root", "no-parent-root"}
ROUTING_ID_RE = re.compile(r"^rr-[^-]+-[0-9a-f]{6}$")
REQUIRED_TOP = ["record", "routing_id", "ts", "session_id", "turn_label", "intent", "reason",
                "model_decision", "validation", "correlation"]


def fail(code, msg):
    print("validate: " + msg)
    sys.exit(code)


def load(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        fail(2, "record unreadable/not JSON: %s (%s)" % (path, e))


def check_schema(rec):
    if not isinstance(rec, dict):
        fail(2, "record is not a JSON object")
    missing = [k for k in REQUIRED_TOP if k not in rec]
    if missing:
        fail(2, "missing required keys: %s" % ", ".join(missing))
    if rec["record"] != RECORD:
        fail(2, "record tag %r != %r" % (rec["record"], RECORD))
    if not (isinstance(rec["routing_id"], str) and ROUTING_ID_RE.match(rec["routing_id"])):
        fail(2, "routing_id %r does not match rr-<stamp>-<6hex>" % rec.get("routing_id"))
    try:
        datetime.fromisoformat(str(rec["ts"]).replace("Z", "+00:00"))
    except ValueError:
        fail(2, "ts %r is not ISO8601" % rec.get("ts"))
    if rec["intent"] not in INTENTS:
        fail(2, "intent %r not in closed set %s" % (rec.get("intent"), sorted(INTENTS)))
    if not isinstance(rec["reason"], str) or not rec["reason"]:
        fail(2, "reason must be a non-empty string")

    md = rec["model_decision"]
    if not isinstance(md, dict) or md.get("how") not in HOWS:
        fail(2, "model_decision.how %r not in closed set %s" % (md.get("how"), sorted(HOWS)))
    if md["how"] == "no-dispatch-call" and md.get("args") is not None:
        fail(2, "no-dispatch-call record carries args")
    if md["how"] == "dispatch_seat-call" and md.get("args") is not None \
            and not isinstance(md.get("args"), dict):
        fail(2, "dispatch_seat-call args must be an object when present")

    val = rec["validation"]
    if not isinstance(val, dict) or not isinstance(val.get("authority"), dict) \
            or not isinstance(val.get("eligibility"), dict):
        fail(2, "validation.authority / validation.eligibility objects required")
    auth, elig = val["authority"], val["eligibility"]
    if auth.get("basis") not in BASES:
        fail(2, "authority.basis %r not in closed set" % auth.get("basis"))
    if not isinstance(auth.get("ok"), bool):
        fail(2, "authority.ok must be boolean")
    expected_ok = auth["basis"] in ROOT_BASES if rec["intent"] == "procedural-handoff" \
        else auth["basis"] == "none"
    if auth["ok"] != expected_ok:
        fail(2, "authority.ok=%s contradicts basis=%r for intent=%s"
             % (auth["ok"], auth["basis"], rec["intent"]))
    if not isinstance(elig.get("seat_listed"), (bool, type(None))):
        fail(2, "eligibility.seat_listed must be boolean or null")
    if not isinstance(elig.get("stage"), str):
        fail(2, "eligibility.stage must be a string")
    if not isinstance(elig.get("ok"), bool):
        fail(2, "eligibility.ok must be boolean")

    cor = rec["correlation"]
    if not isinstance(cor, dict):
        fail(2, "correlation object required")
    for k in ("dispatch_run_id", "seat_session_id", "audit_log", "archon_run_id"):
        if not isinstance(cor.get(k), str):
            fail(2, "correlation.%s must be a string" % k)
    if not isinstance(cor.get("audit_line_no"), (int, type(None))) \
            or isinstance(cor.get("audit_line_no"), bool):
        fail(2, "correlation.audit_line_no must be an integer or null")


def check_authority(rec):
    """Exit 3: a handoff the plugin's root gate would refuse (or did refuse)."""
    if rec["intent"] == "procedural-handoff" and rec["validation"]["authority"]["basis"] \
            not in ROOT_BASES:
        fail(3, "authority refusal: handoff basis %r is not a root basis"
             % rec["validation"]["authority"]["basis"])


def check_eligibility(rec, seats):
    cor = rec["correlation"]
    md = rec["model_decision"]

    if rec["intent"] == "procedural-handoff":
        # the audit line is the behavioral proof; run id is minted before any gate
        if not isinstance(cor.get("audit_line_no"), int) or cor["audit_line_no"] < 1:
            fail(4, "handoff record has no audit line: behavior unproven")
        if cor["dispatch_run_id"] == "none":
            fail(4, "handoff record carries dispatch_run_id none")
        args = md.get("args")
        seat = args.get("seat") if isinstance(args, dict) else None
        if seat is not None:
            if seat not in seats:
                fail(4, "eligibility refusal: seat %r not in configured seats %s"
                     % (seat, sorted(seats)))
        elif rec["validation"]["eligibility"]["seat_listed"] is False:
            fail(4, "eligibility refusal: record states seat_listed=false")

    if rec["intent"] in NO_DISPATCH:
        if md["how"] != "no-dispatch-call":
            fail(4, "intent %s with how=%r contradicts behavior" % (rec["intent"], md["how"]))
        if cor["dispatch_run_id"] != "none" or cor["seat_session_id"] != "none" \
                or cor["archon_run_id"] != "none" or cor.get("audit_line_no") is not None:
            fail(4, "no-dispatch record carries dispatch correlation")


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("record", help="rr-*.json to validate")
    ap.add_argument("--seats", required=True,
                    help="comma-separated configured seat list (the closed list the "
                         "dispatcher advertises and enforces)")
    a = ap.parse_args()

    rec = load(a.record)
    seats = {s.strip() for s in a.seats.split(",") if s.strip()}
    check_schema(rec)
    check_authority(rec)
    check_eligibility(rec, seats)
    print("VALID %s intent=%s authority=%s seat-ok=%s" % (
        rec["routing_id"], rec["intent"], rec["validation"]["authority"]["basis"],
        rec["validation"]["eligibility"]["ok"]))
    sys.exit(0)


if __name__ == "__main__":
    main()
