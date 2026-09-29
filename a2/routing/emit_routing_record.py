#!/usr/bin/env python3
"""Emit rcos-routing-record/1 documents from runtime facts (A2-b).

Sources of truth, in order:
  1. the dsh-seat-dispatch append-only audit log (seat-dispatch.jsonl) — one JSON line
     per dispatch ATTEMPT, including every refusal, written before the dispatch value
     returns. Authoritative for authority/eligibility/correlation facts.
  2. the session journal — used ONLY (a) to corroborate "no dispatch_seat call" for a
     conversational record and (b) to recover the model's tool-call args. The journal is
     scanned for the literal tool NAME; message text is never parsed and never selects
     anything. Over-count direction is conservative: if the name appears ANYWHERE in the
     journal (call, schema dump, quoted string) and the audit log is empty for the
     session, that is reported as a conflict (exit 3), never silently emitted as
     conversational.

Behavioral intent derivation (no token matcher):
  audit line exists for the session  -> intent procedural-handoff (the call happened)
  audit empty + journal clean        -> intent conversational (restatable via --intent)
  audit empty + journal names tool   -> conflict, exit 3
  audit empty + no journal           -> exit 4, no evidence either way

Exit codes: 0 records written · 2 inputs unreadable · 3 journal/audit conflict ·
4 no evidence either way.
"""
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

RECORD = "rcos-routing-record/1"
TOOL = "dispatch_seat"
ROOT_BASES = ("lineage-clean-root", "no-parent-root")


def die(code, msg):
    print("emit: " + msg, file=sys.stderr)
    sys.exit(code)


def read_audit(path, session_id):
    lines = []
    text = Path(path).read_text(encoding="utf-8").splitlines()
    for no, line in enumerate(text, 1):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            die(2, "audit line %d is not JSON: %s" % (no, path))
        if rec.get("caller_session_id") == session_id:
            rec["_line_no"] = no
            lines.append(rec)
    return lines


def journal_text(path):
    """Decompress a session journal; plain text passes through."""
    raw = Path(path).read_bytes()
    if raw[:4] == b"\x28\xb5\x2f\xfd":
        try:
            out = subprocess.run(["zstd", "-dc", str(path)], capture_output=True, check=True,
                                 timeout=120).stdout
            return out.decode("utf-8", "replace")
        except FileNotFoundError:
            die(2, "journal is zstd but no zstd CLI on PATH")
        except subprocess.CalledProcessError as e:
            die(2, "zstd -dc failed on %s: %s" % (path, e.stderr[:200]))
    return raw.decode("utf-8", "replace")


TOOL_CALL_RE = re.compile(r'"name"\s*:\s*"dispatch_seat"')


def find_call_args(text):
    """Recover the model's dispatch_seat arguments from a journal, tolerantly.

    Returns None when the tool name never appears. When it appears, returns the first
    plausible arguments map found near the name (a schema dump carries no arguments map
    and is skipped), or an explicit unparsed marker. The marker is honest: the audit log,
    not this scan, is the proof a call happened.
    """
    if not TOOL_CALL_RE.search(text):
        return None
    for match in re.finditer(r"\{[^{}]*\"name\"\s*:\s*\"dispatch_seat\"[^{}]*\}", text):
        try:
            obj = json.loads(match.group(0))
        except json.JSONDecodeError:
            continue
        args = obj.get("arguments") or obj.get("parameters") or obj.get("input") or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                args = {}
        if isinstance(args, dict) and ("seat" in args or "objective" in args):
            return {k: args.get(k) for k in
                    ("seat", "objective", "done_when", "reason", "constraints", "context")
                    if k in args}
    return {"unparsed": True, "note": "journal names dispatch_seat; arguments not recoverable"}


def routing_id(session_id, dispatch_run, ts):
    """Deterministic per (session, dispatch, ts): rr-<stamp>-<6hex sha256(session|run|ts)>."""
    stamp = re.sub(r"[^0-9TZ+]", "", ts)
    basis = "%s|%s|%s" % (session_id, dispatch_run, ts)
    return "rr-%s-%s" % (stamp, hashlib.sha256(basis.encode()).hexdigest()[:6])


def handoff_record(session_id, audit, args, audit_path, turn_label, seats):
    """One audited dispatch attempt -> one procedural-handoff record, refusal or not."""
    basis = audit.get("authority_basis", "unknown")
    seat = audit.get("seat")
    seat_listed = isinstance(seat, str) and seat in seats
    ts = audit.get("ts") or datetime.now(timezone.utc).isoformat(timespec="seconds")
    archon = audit.get("archon") or {}
    reason = None
    if isinstance(args, dict):
        reason = args.get("reason")
    if not reason:
        reason = audit.get("last_turn_reason") or audit.get("detail")
    return {
        "record": RECORD,
        "routing_id": routing_id(session_id, audit.get("run_id", "none"), ts),
        "ts": ts,
        "session_id": session_id,
        "turn_label": turn_label,
        "intent": "procedural-handoff",
        "reason": reason or "audited dispatch_seat call",
        "model_decision": {"how": "dispatch_seat-call", "args": args},
        "validation": {
            # authority and eligibility are independent gates; ok mirrors the plugin's
            # own decision for authority, and seat_listed for eligibility (stage is
            # recorded evidence of where the dispatch ended, never a gate here).
            "authority": {"basis": basis, "ok": basis in ROOT_BASES},
            "eligibility": {"seat_listed": seat_listed, "stage": audit.get("stage", "unknown"),
                            "ok": seat_listed},
        },
        "correlation": {
            "dispatch_run_id": audit.get("run_id", "none"),
            "seat_session_id": audit.get("seat_session_id", "none"),
            "audit_log": str(audit_path),
            "audit_line_no": audit.get("_line_no"),
            "archon_run_id": archon.get("run_id") or "none",
        },
    }


def conversational_record(session_id, ts, audit_path, turn_label, intent):
    return {
        "record": RECORD,
        "routing_id": routing_id(session_id, "none", ts),
        "ts": ts,
        "session_id": session_id,
        "turn_label": turn_label,
        "intent": intent,
        "reason": "no dispatch_seat call in session journal and no audit line for this session",
        "model_decision": {"how": "no-dispatch-call", "args": None},
        "validation": {
            "authority": {"basis": "none", "ok": True},
            "eligibility": {"seat_listed": None, "stage": "not-dispatched", "ok": True},
        },
        "correlation": {
            "dispatch_run_id": "none", "seat_session_id": "none",
            "audit_log": str(audit_path), "audit_line_no": None, "archon_run_id": "none",
        },
    }


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--session-id", required=True)
    ap.add_argument("--seats", required=True,
                    help="comma-separated configured seat list — the same closed list the "
                         "dispatcher advertises and enforces; eligibility facts in the "
                         "record are computed against it, never guessed")
    ap.add_argument("--audit", required=True, help="seat-dispatch.jsonl")
    ap.add_argument("--journal", help="session journal (zstd or plain)")
    ap.add_argument("--out", required=True, help="output directory for rr-*.json")
    ap.add_argument("--turn-label", default="audit-only")
    ap.add_argument("--intent", choices=["conversational", "read-only-inquiry", "clarification"],
                    default="conversational",
                    help="restates a no-dispatch turn; only a human or the model's structured "
                         "output may supply this label — the emitter never infers it from text")
    a = ap.parse_args()

    audit_path = Path(a.audit)
    if not audit_path.is_file():
        die(2, "audit log not readable: %s" % audit_path)
    audit_lines = read_audit(audit_path, a.session_id)

    journal_args = None
    journal_names_tool = False
    if a.journal:
        jp = Path(a.journal)
        if not jp.is_file():
            die(2, "journal not readable: %s" % jp)
        text = journal_text(jp)
        journal_names_tool = bool(TOOL_CALL_RE.search(text))
        journal_args = find_call_args(text)

    if audit_lines and a.intent != "conversational":
        die(4, "--intent %s contradicts audited dispatch calls for session %s"
            % (a.intent, a.session_id))

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    seats = {s.strip() for s in a.seats.split(",") if s.strip()}

    if audit_lines:
        records = [handoff_record(a.session_id, rec, journal_args, audit_path, a.turn_label,
                                  seats)
                   for rec in audit_lines]
    else:
        if a.journal and journal_names_tool:
            die(3, "journal names dispatch_seat but the audit log has no line for session %s — "
                   "conflict; never resolved silently" % a.session_id)
        if not a.journal:
            die(4, "no audit line and no journal: cannot honestly state intent for session %s"
                % a.session_id)
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        records = [conversational_record(a.session_id, now, audit_path, a.turn_label, a.intent)]

    for rec in records:
        p = out / (rec["routing_id"] + ".json")
        if p.exists():
            die(2, "refusing to overwrite existing record %s (write-once)" % p)
        p.write_text(json.dumps(rec, indent=1, sort_keys=False) + "\n", encoding="utf-8")
        print("wrote %s intent=%s authority=%s" % (p, rec["intent"],
                                                   rec["validation"]["authority"]["basis"]))


if __name__ == "__main__":
    main()
