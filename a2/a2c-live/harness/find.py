import json, sys

# A2-c live FIND step: parse `rcos query --json` from stdin, locate
# route-record-validate, gate on promoted. Exit 0 promoted / 3 not promoted /
# 4 missing. Prints one JSON line either way.
raw = sys.stdin.read()
try:
    j = json.loads(raw)
except Exception as e:
    print(json.dumps({"id": "route-record-validate", "status": "unparseable", "error": str(e)[:120]}))
    sys.exit(4)
rows = j if isinstance(j, list) else (j.get("rows") or j.get("capabilities") or j.get("items") or [])
row = None
for r in rows:
    if isinstance(r, dict) and r.get("id") == "route-record-validate":
        row = r
        break
if row is None:
    print(json.dumps({"id": "route-record-validate", "status": "missing"}))
    sys.exit(4)
evals = row.get("evals") or []
executed = [e for e in evals if isinstance(e, dict) and e.get("provenance") == "executed"]
info = {
    "id": row.get("id"),
    "status": row.get("status"),
    "adapter_declared": bool(row.get("adapter")),
    "evals_total": len(evals),
    "evals_executed": len(executed),
    "latest_executed_verdict": executed[-1].get("verdict") if executed else None,
}
print(json.dumps(info))
sys.exit(0 if row.get("status") == "promoted" else 3)
