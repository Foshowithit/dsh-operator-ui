import glob
import json
import os
import re
import sys

# A2-c live VERIFY step: read /tmp/a2c-live-run.log, resolve the Archon run
# uuid, check the three declared outputs in the run artifacts dir, load
# verdict.json + validation-report.json, and print one JSON line.
# Exit 0 = everything green (workflow completed, files present, verdict ship).
LOG = "/tmp/a2c-live-run.log"
RUNS = os.path.expanduser("~/.archon/workspaces/_folder/chow/artifacts/runs")

log = open(LOG, errors="replace").read()
uuids = re.findall(r'"workflowRunId":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"', log)
if not uuids:
    print(json.dumps({"ok": False, "problems": ["no workflowRunId in run log"]}))
    sys.exit(1)
uuid = uuids[0]
art = os.path.join(RUNS, uuid)
completed = log.count("Workflow completed successfully")
node_failed = log.count('"msg":"dag_node_failed"')

problems = []
if completed < 1:
    problems.append("workflow did not complete")
if node_failed > 0:
    problems.append("%d node failure(s)" % node_failed)
files = {}
for name in ["rcos-invocation-route-record-validate.json", "validation-report.json", "verdict.json"]:
    p = os.path.join(art, name)
    files[name] = os.path.exists(p) and os.path.getsize(p) > 0
    if not files[name]:
        problems.append("missing/empty output: " + name)

verdict_doc = report_doc = None
if files.get("verdict.json"):
    try:
        verdict_doc = json.load(open(os.path.join(art, "verdict.json")))
        if verdict_doc.get("verdict") != "ship":
            problems.append("verdict.json says " + str(verdict_doc.get("verdict")) + ": " + json.dumps(verdict_doc.get("problems")))
    except Exception as e:
        problems.append("verdict.json unparseable: " + str(e)[:100])
if files.get("validation-report.json"):
    try:
        report_doc = json.load(open(os.path.join(art, "validation-report.json")))
        if not report_doc.get("ok"):
            problems.append("validation-report not ok")
    except Exception as e:
        problems.append("validation-report.json unparseable: " + str(e)[:100])

out = {
    "ok": not problems,
    "archon_run_id": uuid,
    "archon_short": uuid[:8],
    "archon_status": "completed" if completed else "not-completed",
    "artifact_dir": art,
    "files_ok": all(files.values()),
    "rcos_invocation_id": (verdict_doc or {}).get("invocation_id") or (report_doc or {}).get("invocation_id"),
    "live_verdict": (verdict_doc or {}).get("verdict"),
    "rederived_summary": (verdict_doc or {}).get("rederived_summary"),
    "probe_missing_record": (verdict_doc or {}).get("probe_missing_record"),
    "problems": problems,
}
print(json.dumps(out))
sys.exit(0 if out["ok"] else 1)
