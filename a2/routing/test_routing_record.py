#!/usr/bin/env python3
"""A2-b routing-record test: every emitter and validator exit path, on real + synthetic
fixtures. Exit 0 = all cases passed; nonzero = at least one failure (printed).

The conversational fixture is a REAL A1 loopback journal (zero dispatch_seat occurrences);
the audit fixtures are synthetic but field-exact to the plugin's auditRecord() — the real
audit line arrives with the A2-c live run.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
EMIT = HERE / "emit_routing_record.py"
VALID = HERE / "validate_routing_record.py"
AUDIT = HERE / "fixtures" / "audit-synthetic.jsonl"
J_CONV = HERE / "fixtures" / "journal-conversational-a1.zstd"
J_CONF = HERE / "fixtures" / "journal-conflict.txt"
SEATS = "wm"

results = []


def run(script, *args):
    return subprocess.run([sys.executable, str(script), *map(str, args)],
                          capture_output=True, text=True, timeout=300)


def case(name, got, want, note=""):
    ok = got == want
    results.append(ok)
    print("%s %-46s exit=%s want=%s %s" % ("PASS" if ok else "FAIL", name, got, want, note))
    return ok


def emit(*args):
    return run(EMIT, *args)


def validate(*args):
    return run(VALID, *args)


def main():
    tmp = Path(tempfile.mkdtemp(prefix="a2b-test-"))

    # --- happy paths ---------------------------------------------------------
    c1 = tmp / "c1"
    r = emit("--session-id", "session-73c7f33e-f7a4-482a-b964-4afd723da564",
             "--seats", SEATS, "--audit", AUDIT, "--journal", J_CONV, "--out", c1,
             "--turn-label", "a1-turn-1")
    case("emit conversational (real A1 journal)", r.returncode, 0, r.stderr.strip())
    recs = sorted(c1.glob("rr-*.json"))
    if case("conversational: exactly one record", len(recs), 1):
        rec = json.loads(recs[0].read_text())
        case("conversational: intent", rec["intent"], "conversational")
        case("conversational: no correlation", rec["correlation"]["dispatch_run_id"], "none")
        case("validate conversational", validate(recs[0], "--seats", SEATS).returncode, 0)

    c2 = tmp / "c2"
    r = emit("--session-id", "session-73c7f33e-f7a4-482a-b964-4afd723da564",
             "--seats", SEATS, "--audit", AUDIT, "--journal", J_CONV, "--out", c2,
             "--intent", "read-only-inquiry")
    recs2 = sorted(c2.glob("rr-*.json"))
    ok2 = case("emit read-only-inquiry restatement", r.returncode, 0, r.stderr.strip()) \
        and len(recs2) == 1
    if ok2:
        case("validate read-only-inquiry", validate(recs2[0], "--seats", SEATS).returncode, 0)

    c3 = tmp / "c3"
    r = emit("--session-id", "session-fix-handoff-ok", "--seats", SEATS, "--audit", AUDIT, "--out", c3)
    recs3 = sorted(c3.glob("rr-*.json"))
    if case("emit handoff (audit line 1)", r.returncode, 0, r.stderr.strip()) \
            and case("handoff: one record", len(recs3), 1):
        rec = json.loads(recs3[0].read_text())
        case("handoff: intent", rec["intent"], "procedural-handoff")
        case("handoff: authority ok", rec["validation"]["authority"]["ok"], True)
        case("handoff: audit line no", rec["correlation"]["audit_line_no"], 1)
        case("handoff: dispatch id carried", rec["correlation"]["dispatch_run_id"],
             "sd-20260929T010203-aaaa01")
        case("handoff: archon id carried", rec["correlation"]["archon_run_id"],
             "wf-20260929-aaaa")
        case("validate accepted handoff", validate(recs3[0], "--seats", SEATS).returncode, 0)

        # deterministic ids -> same inputs refuse to overwrite (write-once)
        r = emit("--session-id", "session-fix-handoff-ok", "--seats", SEATS, "--audit", AUDIT, "--out", c3)
        case("emit write-once collision", r.returncode, 2, r.stderr.strip())

    # --- refusal paths (the A2-d failure evidence) ---------------------------
    c4 = tmp / "c4"
    r = emit("--session-id", "session-fix-refused-child", "--seats", SEATS, "--audit", AUDIT, "--out", c4)
    recs4 = sorted(c4.glob("rr-*.json"))
    if case("emit refused handoff (delegated-child)", r.returncode, 0, r.stderr.strip()) \
            and case("refused: one record", len(recs4), 1):
        rec = json.loads(recs4[0].read_text())
        case("refused: authority.ok false recorded", rec["validation"]["authority"]["ok"], False)
        case("refused: basis carried", rec["validation"]["authority"]["basis"],
             "delegated-child")
        case("validate refused handoff -> 3", validate(recs4[0], "--seats", SEATS).returncode, 3)

    c5 = tmp / "c5"
    r = emit("--session-id", "session-fix-unlisted-seat", "--seats", SEATS, "--audit", AUDIT, "--out", c5)
    recs5 = sorted(c5.glob("rr-*.json"))
    if case("emit unlisted-seat handoff", r.returncode, 0, r.stderr.strip()) \
            and case("unlisted: one record", len(recs5), 1):
        case("validate unlisted seat -> 4",
             validate(recs5[0], "--seats", SEATS).returncode, 4)

    # --- emitter evidence paths ----------------------------------------------
    r = emit("--session-id", "session-fix-conflict", "--seats", SEATS, "--audit", AUDIT,
             "--journal", J_CONF, "--out", tmp / "c6")
    case("emit journal/audit conflict -> 3", r.returncode, 3, r.stderr.strip())

    r = emit("--session-id", "session-absent", "--seats", SEATS, "--audit", AUDIT, "--out", tmp / "c7")
    case("emit no evidence (no journal) -> 4", r.returncode, 4, r.stderr.strip())

    r = emit("--session-id", "x", "--seats", SEATS, "--audit", tmp / "missing.jsonl", "--out", tmp / "c8")
    case("emit unreadable audit -> 2", r.returncode, 2, r.stderr.strip())

    # --- validator schema + consistency (mutated copies of the good record) --
    good = json.loads(recs3[0].read_text())

    def mutate(name, fn, want, code=None):
        rec = json.loads(json.dumps(good))
        fn(rec)
        p = tmp / ("mut-%s.json" % name)
        p.write_text(json.dumps(rec))
        case("validate %s -> %d" % (name, code if code is not None else want),
             validate(p, "--seats", SEATS).returncode, want)

    mutate("wrong-record-tag", lambda r: r.__setitem__("record", "rcos-routing-record/2"), 2)
    mutate("bad-routing-id", lambda r: r.__setitem__("routing_id", "rr-nope"), 2)
    mutate("bad-intent", lambda r: r.__setitem__("intent", "maybe"), 2)
    mutate("authority-ok-contradicts-basis",
           lambda r: r["validation"]["authority"].__setitem__("ok", False), 2)
    mutate("handoff-without-dispatch-id",
           lambda r: r["correlation"].__setitem__("dispatch_run_id", "none"), 4)
    mutate("handoff-ghost-seat",
           lambda r: r["model_decision"].__setitem__(
               "args", {"seat": "ghost", "reason": "x"}), 4)

    conv = json.loads(recs[0].read_text())

    def mutate_conv(name, fn, want):
        rec = json.loads(json.dumps(conv))
        fn(rec)
        p = tmp / ("mutc-%s.json" % name)
        p.write_text(json.dumps(rec))
        case("validate %s -> %d" % (name, want), validate(p, "--seats", SEATS).returncode, want)

    mutate_conv("conversational-with-dispatch-correlation",
                lambda r: r["correlation"].__setitem__("dispatch_run_id", "sd-xyz"), 4)
    mutate_conv("conversational-with-audit-line",
                lambda r: r["correlation"].__setitem__("audit_line_no", 5), 4)
    mutate_conv("conversational-bad-ts",
                lambda r: r.__setitem__("ts", "not-a-time"), 2)

    passed, total = sum(results), len(results)
    print("\n%d/%d cases passed" % (passed, total))
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
