import base64
import hashlib
import json
import math
import os
import re
import subprocess
import tempfile
import time

REQ = json.loads(base64.b64decode("__REQUEST_B64__").decode("utf-8"))
HOME = os.path.expanduser("~")
RCOS_ROOT = os.path.join(HOME, "zcode-rcos")
RCOS = os.path.join(RCOS_ROOT, "bin", "rcos")
ARCHON = os.path.join(HOME, ".local", "bin", "archon")
DESKTOP_ROOT = os.path.join(HOME, ".archon", "rcos-desktop")
DESKTOP_SOURCE = os.path.join(DESKTOP_ROOT, "source")
DESKTOP_CONFIG = os.path.join(DESKTOP_ROOT, "config.yaml")
DESKTOP_MODE = REQ.get("desktop_run_profile") is True
NESTED_ROOT = "/var/tmp/chow-nested-runs"
ALLOW = set(REQ.get("workflow_allowlist") or [])
CAP_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
WF_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
NODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+_-]{0,31}$")
QA_VERIFY_WORKFLOW = "chow-qa-verify-v1"
QA_CLAIMED_PATH_RE = re.compile(r"/[A-Za-z0-9_./~-]+[.](?:yaml|yml|json|md|py|sh|txt|log|bak|html|mp4|jpg|jpeg|png|vtt|css|js)")
RUN_ID_RE = re.compile(r"^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$")
WORKFLOW_EVALUATION_CONTRACTS = {
    "chow-research-search-v1": {"gate_eligible": True, "artifact": "EVAL.json", "field": "decision", "comparison": "case_insensitive", "ship_value": "ship"},
    "chow-build-standard": {"gate_eligible": True, "artifact": "EVAL.json", "field": "decision", "comparison": "case_insensitive", "ship_value": "ship"},
    "chow-fix-loop": {"gate_eligible": True, "artifact": "EVAL.json", "field": "decision", "comparison": "case_insensitive", "ship_value": "ship"},
    "chow-ui-build": {"gate_eligible": True, "artifact": "EVAL.json", "field": "decision", "comparison": "case_insensitive", "ship_value": "ship"},
    "chow-eval-gate-v2": {"gate_eligible": True, "artifact": "EVAL.json", "field": "decision", "comparison": "case_insensitive", "ship_value": "ship"},
    QA_VERIFY_WORKFLOW: {"gate_eligible": True, "artifact": "EVAL.json", "field": "decision", "comparison": "case_insensitive", "ship_value": "ship"},
    "chow-planning-standard-v1": {"gate_eligible": False, "artifact": "EVAL.json", "field": "decision", "reason": "The decision value completed marks task completion, not a passing evaluation; it cannot satisfy the RCOS ship gate."},
    "chow-test-v1": {"gate_eligible": False, "artifact": "RECEIPT.json", "field": "classification", "reason": "The result is a receipt classification rather than the canonical EVAL.json decision consumed by the RCOS ship gate."},
    "chow-code-review": {"gate_eligible": False, "artifact": "RECEIPT.json", "field": "decision", "reason": "The decision is emitted in a receipt from review evidence, not the canonical EVAL.json decision consumed by the RCOS ship gate."},
    "chow-verify-output-v1": {"gate_eligible": False, "artifact": "EVAL.json", "field": "verdict", "reason": "The workflow writes verdict rather than decision; the RCOS ship gate consumes only EVAL.json.decision."},
}
WORKFLOW_EXECUTION_CONTRACTS = {
    "chow-research-search-v1": {"desktop_profile_eligible": True, "reason": "Eligible only through the reviewed Desktop-scoped Muse synthesis with real search evidence and citations validated before SHIP."},
    "chow-build-standard": {"desktop_profile_eligible": True, "reason": "Eligible only through the reviewed, noninteractive Desktop-scoped workflow source; the stock approval-interactive workflow is not supported."},
    "chow-fix-loop": {"desktop_profile_eligible": False, "reason": "The workflow contains an approval node, which Archon classifies as interactive even when SKIP_HITL skips it; detached Desktop execution is refused."},
    "chow-ui-build": {"desktop_profile_eligible": False, "reason": "The workflow contains an approval node, which Archon classifies as interactive even when SKIP_HITL skips it; detached Desktop execution is refused."},
    "chow-eval-gate-v2": {"desktop_profile_eligible": False, "reason": "The workflow calls a host-owned shared LLM helper outside the Desktop-owned provider profile."},
    QA_VERIFY_WORKFLOW: {"desktop_profile_eligible": True, "reason": "Deterministic Bash evidence checks with local post-run context distillation; no approval node or direct provider call."},
}
MAX_OUTPUT = 48000
MAX_CHILD_LOG_BYTES = 512 * 1024
MAX_CHILD_EVALUATIONS = 4


def has_generated_invocation_claim(ir):
    # The compiler's parent prelude writes this receipt before the QA child,
    # and supplies absolute output claim_paths plus the parent's start clock.
    outputs = ir.get("outputs")
    values = list(outputs.values()) if isinstance(outputs, dict) else []
    refs = ir.get("capability_refs")
    for ref in refs if isinstance(refs, list) else []:
        if not isinstance(ref, dict) or ref.get("role") != "executed" or not isinstance(ref.get("id"), str) or not CAP_RE.fullmatch(ref["id"]):
            continue
        filename = "rcos-invocation-" + ref["id"] + ".json"
        if filename in values or "artifacts/" + filename in values:
            return True
    return False


def result(ok, operation, code=None, detail="", data=None):
    print(json.dumps({
        "ok": bool(ok),
        "operation": operation,
        "exit_code": code,
        "detail": str(detail)[:1200],
        "data": data,
    }, separators=(",", ":"), ensure_ascii=False))


def clipped(value, limit=MAX_OUTPUT):
    return str(value or "")[-limit:]


def desktop_profile_ready():
    try:
        manifest_path = os.path.join(DESKTOP_ROOT, "profile-manifest.json")
        if os.path.realpath(DESKTOP_SOURCE) != DESKTOP_SOURCE or os.path.realpath(DESKTOP_CONFIG) != DESKTOP_CONFIG or os.path.realpath(manifest_path) != manifest_path:
            return False
        if os.path.getsize(manifest_path) > 16384 or os.path.getsize(DESKTOP_CONFIG) > 32768:
            return False
        with open(manifest_path, encoding="utf-8") as file:
            manifest = json.load(file)
        if not isinstance(manifest, dict) or manifest.get("schema") != "rcos-desktop-profile/1" or manifest.get("model") != "pi/opencode-go-responses/muse-spark-1.3-contributor" or manifest.get("effort") != "xhigh":
            return False
        with open(DESKTOP_CONFIG, "rb") as file:
            if hashlib.sha256(file.read(32769)).hexdigest() != manifest.get("config_sha256"):
                return False
        files = manifest.get("files")
        if not isinstance(files, dict) or not files or len(files) > 64:
            return False
        required = {".archon/workflows/" + name + ".yaml" for name in ALLOW if not name.startswith("rcos-ir-")}
        if not required.issubset(files):
            return False
        for relative, digest in files.items():
            if not isinstance(relative, str) or os.path.isabs(relative) or ".." in relative.split("/") or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                return False
            path = os.path.join(DESKTOP_SOURCE, relative)
            if os.path.realpath(path) != path or os.path.commonpath([DESKTOP_SOURCE, path]) != DESKTOP_SOURCE or os.path.getsize(path) > 262144:
                return False
            with open(path, "rb") as file:
                if hashlib.sha256(file.read(262145)).hexdigest() != digest:
                    return False
        return True
    except (OSError, ValueError, TypeError):
        return False


def desktop_run_args():
    if not DESKTOP_MODE:
        return []
    return ["--workflow-source", DESKTOP_SOURCE, "--config", DESKTOP_CONFIG]


def install_desktop_wrapper(name):
    if not DESKTOP_MODE:
        return
    original = os.path.join(HOME, ".archon", "workflows", "rcos-ir-" + name + ".yaml")
    destination = os.path.join(DESKTOP_SOURCE, ".archon", "workflows", "rcos-ir-" + name + ".yaml")
    if not desktop_profile_ready() or os.path.realpath(original) != original or not os.path.isfile(original) or os.path.getsize(original) > 262144:
        raise ValueError("compiled wrapper or trusted Desktop source is unavailable or outside its fixed path")
    with open(original, "rb") as source:
        content = source.read(262145)
    lane = "rcos-ir-" + name
    generator = os.path.join(RCOS_ROOT, "tools", "regenerate-desktop-manifests.py")
    verifier = os.path.join(RCOS_ROOT, "tools", "verify-desktop-manifests.py")
    manifests = [os.path.join(DESKTOP_ROOT, filename) for filename in
                 ("approved-source-manifest.json", "profile-manifest.json")]
    previous = {path: open(path, "rb").read() for path in manifests}
    created = False
    try:
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
        with os.fdopen(descriptor, "wb") as target:
            target.write(content)
        admission = run(["python3", generator, "--admit-compiled", lane, "--write"], 30)
        if not isinstance(admission, subprocess.CompletedProcess) or admission.returncode != 0:
            raise ValueError("exact Desktop manifest admission failed: " + clipped(getattr(admission, "stderr", ""), 500))
        verification = run(["python3", verifier], 30)
        if not isinstance(verification, subprocess.CompletedProcess) or verification.returncode != 0:
            raise ValueError("Desktop manifest verification failed: " + clipped(getattr(verification, "stdout", ""), 500))
    except (OSError, ValueError):
        if created:
            for path, content_before in previous.items():
                descriptor, staged = tempfile.mkstemp(prefix=".desktop-manifest-rollback-", dir=DESKTOP_ROOT)
                with os.fdopen(descriptor, "wb") as target:
                    target.write(content_before)
                os.replace(staged, path)
            if os.path.isfile(destination):
                os.unlink(destination)
        raise


def run(argv, timeout=30):
    try:
        environment = {**os.environ, "PATH": os.path.join(HOME, ".local", "bin") + os.pathsep + os.environ.get("PATH", "")}
        if DESKTOP_MODE:
            environment.update({"PI_CODING_AGENT_DIR": os.path.join(DESKTOP_ROOT, "pi-agent"),
                                "RCOS_DESKTOP_RUN_PROFILE": "1",
                                "CHOW_NEST_ROOT": "/var/tmp/chow-nested-runs"})
        return subprocess.run(
            argv,
            cwd=HOME,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env=environment,
        )
    except subprocess.TimeoutExpired as error:
        return error


def parse_json(value):
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return None


def records(value, key):
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for field in (key, "items", "data"):
            if isinstance(value.get(field), list):
                return value[field]
    return []


def workflow_id(row):
    if not isinstance(row, dict):
        return None
    return row.get("id") or row.get("name")


def workflow_name(row):
    if not isinstance(row, dict):
        return None
    return row.get("workflow") or row.get("workflowName") or row.get("workflow_name") or row.get("name")


def workflow_rows():
    source_args = ["--workflow-source", DESKTOP_SOURCE] if DESKTOP_MODE else []
    process = run([ARCHON, "workflow", "list", "--json", *source_args], 30)
    if not isinstance(process, subprocess.CompletedProcess) or process.returncode != 0:
        return None, process
    value = parse_json(process.stdout)
    if value is None:
        return None, process
    return records(value, "workflows"), process


def capability_rows():
    process = run([RCOS, "query", "--json"], 30)
    if not isinstance(process, subprocess.CompletedProcess) or process.returncode != 0:
        return None, process
    value = parse_json(process.stdout)
    if value is None:
        return None, process
    return records(value, "capabilities"), process


def run_rows():
    process = run([ARCHON, "workflow", "runs", "--all", "--json", "--limit", "100"], 30)
    if not isinstance(process, subprocess.CompletedProcess) or process.returncode != 0:
        return None, process
    value = parse_json(process.stdout)
    if value is None:
        return None, process
    return records(value, "runs"), process


def conversation_runs(conversation_id, limit=8):
    """Runs in one Archon conversation, straight from archon.db.

    The bounded CLI history (workflow runs --all --limit N) is a recency window:
    a busy host pushes a dispatch's sibling runs out of it, so the enumeration
    silently returned nothing. conversation_id is indexed, so query it directly
    and never depend on how many unrelated runs happened since.
    """
    db_path = os.path.join(HOME, ".archon", "archon.db")
    if not os.path.isfile(db_path):
        return []
    if not RUN_ID_RE.fullmatch(str(conversation_id)) or not isinstance(limit, int) or not 1 <= limit <= 64:
        return []
    # conversation_id is a validated 32-hex / UUID and limit is a bounded int, so
    # both are safe to inline: the sqlite3 CLI does not bind positional params
    # the way the C API does.
    query = ("SELECT id, conversation_id, workflow_name, status, started_at, completed_at, working_path, output_root "
             "FROM remote_agent_workflow_runs WHERE conversation_id = '%s' ORDER BY started_at DESC LIMIT %d"
             % (conversation_id, limit))
    try:
        process = subprocess.run(
            ["sqlite3", "-readonly", "-json", db_path, query],
            cwd=HOME, capture_output=True, text=True, timeout=15, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if process.returncode != 0 or not process.stdout.strip():
        return []
    value = parse_json(process.stdout)
    return value if isinstance(value, list) else []


def run_summary(row):
    fields = (
        "id", "conversation_id", "worker_platform_id", "workflow_name", "status", "current_step_name",
        "current_step_status", "started_at", "completed_at", "last_activity_at",
    )
    summary = {key: row[key] for key in fields if key in row}
    if isinstance(row.get("id"), str):
        summary["run_id"] = row["id"]
    return summary


def bounded_json(path, root, limit=16384):
    try:
        resolved = os.path.realpath(path)
        if os.path.commonpath([os.path.realpath(root), resolved]) != os.path.realpath(root) or not os.path.isfile(resolved) or os.path.getsize(resolved) > limit:
            return None
        with open(resolved, encoding="utf-8") as source:
            return parse_json(source.read(limit + 1))
    except (OSError, ValueError, UnicodeError):
        return None


def child_evaluations(parent_artifact_dir, child_nodes):
    evaluations = []
    blockers = []
    if not isinstance(child_nodes, list):
        return [], ["compiled child node map is unavailable"]
    valid_nodes = []
    for node in child_nodes:
        if not isinstance(node, dict) or not isinstance(node.get("id"), str) or not NODE_RE.fullmatch(node["id"]) or not isinstance(node.get("workflow"), str) or not WF_RE.fullmatch(node["workflow"]) or node["workflow"] not in ALLOW:
            blockers.append("compiled child node map contains an invalid or unapproved node")
            continue
        valid_nodes.append(node)
    if len(valid_nodes) > MAX_CHILD_EVALUATIONS:
        blockers.append("child evaluation limit exceeded; remaining children were not checked")
    for node in valid_nodes[:MAX_CHILD_EVALUATIONS]:
        node_id = node["id"]
        expected_workflow = node["workflow"]
        item = {"node_id": node_id, "workflow_name": expected_workflow, "status": "unresolved", "eval_state": "unresolved"}
        evaluations.append(item)
        # The receipt name is derived only from the host-bound compiled IR node id.
        receipt = bounded_json(os.path.join(parent_artifact_dir, "archon-child-" + node_id + ".json"), parent_artifact_dir, 8192)
        if not isinstance(receipt, dict) or receipt.get("schema") != "rcos-archon-child/1" or receipt.get("workflow_name") != expected_workflow:
            blockers.append("node " + node_id + ": compiler child receipt is missing or invalid")
            continue
        child_id = receipt.get("run_id")
        expected_cwd = receipt.get("expected_cwd")
        if not isinstance(child_id, str) or not RUN_ID_RE.fullmatch(child_id) or not isinstance(expected_cwd, str) or not os.path.isabs(expected_cwd):
            blockers.append("node " + node_id + ": compiler child receipt identity or expected cwd is invalid")
            continue
        workspace_root = os.path.realpath(os.path.join(HOME, ".archon", "workspaces"))
        expected_cwd = os.path.realpath(expected_cwd)
        try:
            cwd_trusted = os.path.commonpath([os.path.realpath(NESTED_ROOT), expected_cwd]) == os.path.realpath(NESTED_ROOT) and expected_cwd != os.path.realpath(NESTED_ROOT)
        except ValueError:
            cwd_trusted = False
        if not cwd_trusted:
            blockers.append("node " + node_id + ": receipt expected cwd is outside the certified nested run root")
            continue
        child_process = run([ARCHON, "workflow", "get", child_id, "--json"], 10)
        child_value = parse_json(getattr(child_process, "stdout", "")) if isinstance(child_process, subprocess.CompletedProcess) else None
        if not isinstance(child_process, subprocess.CompletedProcess) or child_process.returncode != 0 or not isinstance(child_value, dict) or child_value.get("id") != child_id or child_value.get("workflow_name") != expected_workflow or not isinstance(child_value.get("status"), str) or child_value.get("working_path") != receipt.get("expected_cwd"):
            blockers.append("node " + node_id + ": exact child status or expected working path could not be verified")
            continue
        item["run_id"] = child_id
        item["status"] = child_value["status"]
        item["working_path"] = child_value["working_path"]
        if receipt.get("status") != item["status"]:
            blockers.append("node " + node_id + ": child receipt status differs from Archon status")
        if item["status"] != "completed":
            blockers.append("node " + node_id + ": child status is " + item["status"])
        output_root = child_value.get("output_root")
        receipt_output_root = receipt.get("output_root")
        if not isinstance(output_root, str) or not isinstance(receipt_output_root, str) or receipt_output_root != output_root:
            item["eval_state"] = "missing"
            blockers.append("node " + node_id + ": child output root is missing or receipt does not match Archon status")
            continue
        artifact_dir = os.path.realpath(os.path.join(output_root, "artifacts", "runs", child_id))
        try:
            trusted = os.path.commonpath([workspace_root, artifact_dir]) == workspace_root
        except ValueError:
            trusted = False
        if not trusted or not os.path.isdir(artifact_dir):
            item["eval_state"] = "missing"
            blockers.append("node " + node_id + ": child EVAL is outside the trusted workspace or missing")
            continue
        eval_path = os.path.realpath(os.path.join(artifact_dir, "EVAL.json"))
        if not isinstance(receipt.get("eval_path"), str) or receipt["eval_path"] != eval_path:
            item["eval_state"] = "invalid"
            blockers.append("node " + node_id + ": child receipt EVAL path does not match the canonical run artifact")
            continue
        eval_value = bounded_json(eval_path, artifact_dir, 8000)
        if not isinstance(eval_value, dict) or not isinstance(eval_value.get("decision"), str):
            item["eval_state"] = "missing"
            blockers.append("node " + node_id + ": child EVAL is missing or invalid")
            continue
        item["eval_state"] = "verified"
        item["artifact_dir"] = artifact_dir
        item["artifact_names"] = sorted(os.listdir(artifact_dir))[:100]
        item["eval"] = {key: eval_value[key] for key in ("decision", "status", "reason", "check_type") if key in eval_value and (isinstance(eval_value[key], (str, int, float, bool)) or eval_value[key] is None)}
        if receipt.get("eval") != item["eval"]:
            blockers.append("node " + node_id + ": child receipt EVAL projection differs from the canonical EVAL")
        if eval_value["decision"].lower() != "ship":
            blockers.append("node " + node_id + ": child EVAL decision is " + eval_value["decision"])
    return evaluations, blockers


def verified_invocation_output(invocation_dir, fingerprint):
    # Read the same bounded bytes that are hashed. A prior invocation-verify
    # alone does not protect a later content read from an intervening change.
    limit = 16 * 1024 * 1024
    if (not isinstance(fingerprint, dict) or fingerprint.get("path") != "output.json"
            or type(fingerprint.get("bytes")) is not int or not 0 <= fingerprint["bytes"] <= limit
            or not isinstance(fingerprint.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint["sha256"])):
        return None
    try:
        path = os.path.realpath(os.path.join(invocation_dir, "output.json"))
        if os.path.commonpath([invocation_dir, path]) != invocation_dir:
            return None
        with open(path, "rb") as source:
            body = source.read(limit + 1)
        if len(body) != fingerprint["bytes"] or hashlib.sha256(body).hexdigest() != fingerprint["sha256"]:
            return None
        output = json.loads(body)
    except (OSError, ValueError, UnicodeError):
        return None
    return output


def invoice_outcome(invocation_dir, fingerprint):
    output = verified_invocation_output(invocation_dir, fingerprint)
    if (not isinstance(output, dict) or set(output) != {"schema", "domain_verdict", "engine_exit", "report"}
            or output.get("schema") != "invoice-reconciliation-report/1" or type(output.get("engine_exit")) is not int
            or output["engine_exit"] not in (0, 1, 2) or output.get("domain_verdict") != ("ship", "fix", "blocked")[output["engine_exit"]]
            or not isinstance(output.get("report"), dict)):
        return None
    summary = {key: output[key] for key in ("schema", "domain_verdict", "engine_exit")}
    stats = output["report"].get("stats")
    if isinstance(stats, dict):
        summary["stats"] = {key: stats[key] for key in ("total_a", "total_b", "matched", "conflicts", "missing", "unreconcilable")
                            if type(stats.get(key)) is int and 0 <= stats[key] <= 9007199254740991}
    # Never return invoice IDs, amounts, input paths, report bodies or reasons.
    return summary


FILM_V1_CHECKS = frozenset(("grid-pin", "shots-json", "shot-count", "frame-size", "gate-timeline", "bar-grid", "valley-locked", "law0-nondet", "law3-keys", "no-lyric-use", "out-guard", "shotmap-types", "bone-budget", "nearblack-floor", "accent-gate", "signal-budget", "hole-locked", "stills-size", "contact-sheet", "clips-60f", "clips-decode"))
VISUAL_VERSIONS = {"filmstrip-verify": "1.0.0", "video-forensics-receipt": "0.1.0", "webgl-film-capture": "1.0.0"}
DOMAIN_CAPABILITIES = ("invoice-reconciliation-verify", "wishing-film-run", "bounded-research", "mac-dell-staging", *VISUAL_VERSIONS)


def finite_number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def measured_video(observed):
    return (isinstance(observed, dict)
            and all(type(observed.get(key)) is int and 0 < observed[key] <= 65536 for key in ("width", "height"))
            and finite_number(observed.get("fps")) and 0 < observed["fps"] <= 1000
            and finite_number(observed.get("duration_s")) and 0 < observed["duration_s"] <= 86400)


FILMSTRIP_THRESHOLDS = {"frames_default": 6, "hold_baseline_fps": 1, "hold_eps": 0.004,
                       "hold_share_max": 0.4, "hold_max_s": 5, "loudness_floor_db": -45,
                       "loudness_ceil_db": -6, "analysis_width": 480, "analysis_height": 270}


def exact_numbers(value, expected):
    return (isinstance(value, dict) and set(value) == set(expected)
            and all(finite_number(value[key]) and value[key] == number for key, number in expected.items()))


def filmstrip_probe(probe):
    code, outcome, observed = probe.get("exit_status"), probe.get("outcome"), probe.get("observed")
    if type(code) is not int:
        return None
    if code == 4 and outcome == "could-not-run" and observed is None and probe.get("legs") is None and probe.get("strip") is None:
        return "blocked", []
    if code not in (0, 3) or outcome != ("measured-pass" if code == 0 else "measured-fail") or not measured_video(observed):
        return None
    requested, extracted = observed.get("frames_requested"), observed.get("frames_extracted")
    mean, share, longest = observed.get("mean_volume_db"), observed.get("hold_share"), observed.get("longest_hold_s")
    if (type(requested) is not int or not 2 <= requested <= 24
            or (extracted is not None and (type(extracted) is not int or not 0 <= extracted <= 24))
            or type(observed.get("has_audio")) is not bool
            or (mean is not None and not finite_number(mean))
            or (share is not None and (not finite_number(share) or not 0 <= share <= 1))
            or (longest is not None and (not finite_number(longest) or not 0 <= longest <= observed["duration_s"]))
            or not exact_numbers(observed.get("analysis_geometry"), {"width": 480, "height": 270, "baseline_fps": 1, "eps": 0.004})):
        return None
    expected = {"six-frames": extracted == requested,
                "audio-bed": mean is not None and -45 <= mean <= -6,
                "no-slideshow": share is not None and longest is not None and share <= 0.4 and longest <= 5}
    legs, strip = probe.get("legs"), probe.get("strip")
    if (not isinstance(legs, dict) or set(legs) != set(expected)
            or any(not isinstance(legs[key], dict) or type(legs[key].get("pass")) is not bool or legs[key]["pass"] != passed for key, passed in expected.items())
            or not isinstance(strip, dict) or type(strip.get("exit_status")) is not int
            or type(strip.get("frames_requested")) is not int or strip["frames_requested"] != requested
            or strip.get("frames_extracted") != extracted or type(strip.get("frames_extracted")) is not type(extracted)):
        return None
    failed = [key for key, passed in expected.items() if not passed]
    if (observed.get("failing_legs") != failed or observed.get("pass_marker") != ("FILMSTRIP_FAIL" if failed else "FILMSTRIP_PASS")
            or code != (3 if failed else 0)):
        return None
    incomplete = (strip["exit_status"] != 0 or extracted is None or share is None or longest is None
                  or mean is None and observed["has_audio"])
    return ("blocked" if incomplete else "fix" if failed else "ship"), failed


FORENSICS_BANDS = {"explainer": ((-19.9, -14.3), (2.8, 6.5), (0.06, 0.49), (0.10, 0.86)),
                   "brand": ((-23, -11.2), (None, 11), (0.26, 0.53), (0.21, 0.31)),
                   "kinetic": ((-22, -18), (None, None), (None, 0.20), (None, None))}
FORENSICS_FIELDS = (("loudness-in-band", "lufs"), ("lra-in-band", "lra"), ("luma-in-band", "luma"),
                    ("saturation-in-band", "saturation"), ("no-dead-frames", "hold_share"), ("no-long-hold", "longest_hold_s"))


def forensics_probe(probe):
    code, outcome, observed = probe.get("exit_status"), probe.get("outcome"), probe.get("observed")
    register = probe.get("register")
    if not isinstance(register, str) or register not in FORENSICS_BANDS or (code is not None and type(code) is not int):
        return None
    unavailable = {2: "errored", 4: "could_not_measure"}
    if code in unavailable and outcome == unavailable[code] and probe.get("receipt") is None:
        return "blocked", []
    if code is None and outcome in ("timed_out", "errored") and probe.get("receipt") is None:
        return "blocked", []
    receipt = probe.get("receipt")
    if (code not in (0, 3) or outcome != ("passed" if code == 0 else "caught") or probe.get("signal") is not None
            or not measured_video(observed) or type(observed.get("has_audio")) is not bool
            or not isinstance(receipt, dict) or receipt.get("schema") != "video-forensics-receipt/1" or receipt.get("register") != register
            or not exact_numbers(receipt.get("thresholds"), {"hold_eps": 0.004, "hold_share_max": 0.4, "hold_max_s": 5})):
        return None
    checks = receipt.get("checks")
    if not isinstance(checks, list) or len(checks) != len(FORENSICS_FIELDS):
        return None
    failed, incomplete = [], False
    bounds = (*FORENSICS_BANDS[register], (None, 0.4), (None, 5))
    for check, (check_id, field), (lo, hi) in zip(checks, FORENSICS_FIELDS, bounds):
        if not isinstance(check, dict) or check.get("id") != check_id:
            return None
        for key, expected in (("lo", lo), ("hi", hi)):
            actual = check.get(key)
            if (expected is None and actual is not None) or (expected is not None and (not finite_number(actual) or actual != expected)):
                return None
        value = check.get("value")
        if (value is not None and not finite_number(value)) or observed.get(field) != value or type(observed.get(field)) is not type(value):
            return None
        passed = None if value is None else (lo is None or value >= lo) and (hi is None or value <= hi)
        if check.get("pass") is not passed:
            return None
        incomplete |= value is None
        if passed is False:
            failed.append(check_id)
    # The frozen measurer can emit PASS with null checks. Those measurements
    # remain unavailable, even though its exit and receipt are consistent.
    verdict = "FAIL" if failed else "PASS"
    if (receipt.get("verdict") != verdict or code != (3 if failed else 0)
            or observed.get("failing_gates") != failed or observed.get("pass_marker") is not (not failed)):
        return None
    return ("blocked" if incomplete else "fix" if failed else "ship"), failed


CAPTURE_FIELDS = frozenset(("width", "height", "fps", "frames", "duration"))


def capture_field_diffs(diffs, manifest):
    if not isinstance(diffs, list) or len(diffs) > len(CAPTURE_FIELDS):
        return False
    seen = set()
    number = r"(?:[0-9]+(?:\.[0-9]+)?)(?:e[+-]?[0-9]+)?"
    for diff in diffs:
        if not isinstance(diff, str) or len(diff) > 100:
            return False
        match = re.fullmatch(r"(width|height|fps|frames|duration): (" + number + r") != (" + number + r")", diff)
        if match is None:
            return False
        field, left, right = match.groups()
        if field in seen:
            return False
        seen.add(field)
        left, right = float(left), float(right)
        maximum = 65536 if field in ("width", "height") else 100000 if field == "frames" else 120 if field == "fps" else 100000
        if (not finite_number(left) or not finite_number(right) or left != manifest[field]
                or not 0 < right <= maximum or right == left
                or field in ("width", "height", "frames") and not right.is_integer()):
            return False
    return True


def capture_probe(probe):
    code, outcome, observed = probe.get("exit_status"), probe.get("outcome"), probe.get("observed")
    if (code is not None and type(code) is not int) or type(probe.get("gate_ok")) is not bool:
        return None
    unavailable = {2: "errored", 3: "caught", 4: "could_not_capture"}
    if code in unavailable and outcome == unavailable[code] and probe["gate_ok"] is False:
        return "blocked", []
    if code is None and outcome in ("timed_out", "errored") and probe["gate_ok"] is False:
        return "blocked", []
    manifest, cross = probe.get("manifest"), probe.get("cross")
    if (code != 0 or outcome != "passed" or probe.get("signal") is not None
            or not isinstance(observed, dict) or not isinstance(manifest, dict) or manifest.get("schema") != "webgl-film-capture/1"
            or not isinstance(cross, dict)):
        return None
    for field in CAPTURE_FIELDS:
        value = manifest.get(field)
        if (not finite_number(value) or value <= 0 or observed.get(field) != value or type(observed.get(field)) is not type(value)
                or field in ("width", "height", "frames") and type(value) is not int):
            return None
    frames = manifest["frames"]
    if (frames > 100000 or manifest["width"] > 65536 or manifest["height"] > 65536 or manifest["fps"] > 120
            or abs(manifest["duration"] - frames / manifest["fps"]) > 1e-6):
        return None
    md5, compared, mismatches = manifest.get("md5"), cross.get("compared"), cross.get("mismatches")
    if (not isinstance(md5, dict) or len(md5) != frames
            or any(not isinstance(md5.get(str(index).zfill(5)), str) or not re.fullmatch(r"[a-f0-9]{32}", md5[str(index).zfill(5)]) for index in range(frames))):
        return None
    second, signal, second_outcome = cross.get("exit_status"), cross.get("signal"), cross.get("outcome")
    # Old receipts omitted the second process status. Matching hashes cannot
    # establish that its console, frame and timing gates actually passed.
    if "exit_status" not in cross or (second is not None and type(second) is not int):
        return None
    if second != 0 or signal is not None:
        expected = {2: "errored", 3: "caught", 4: "could_not_capture"}.get(second)
        valid = (signal is None and expected == second_outcome and expected is not None
                 or second is None and signal in ("SIGTERM", "SIGKILL")
                 and second_outcome == ("timed_out" if signal == "SIGTERM" else "errored"))
        if not valid or probe["gate_ok"] is not False or observed.get("deterministic") is not None:
            return None
        return ("fix", ["cross-launch-capture-gate"]) if second == 3 else ("blocked", [])
    if second_outcome != "passed":
        return None
    if (type(compared) is not int or compared != frames
            or type(mismatches) is not int or not 0 <= mismatches <= compared
            or not isinstance(cross.get("manifest_sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", cross["manifest_sha256"])):
        return None
    indices, diffs = cross.get("mismatch_indices"), cross.get("field_diffs")
    if (not isinstance(indices, list) or len(indices) != min(mismatches, 20) or len(set(str(i) for i in indices)) != len(indices)
            or any(not isinstance(index, str) or not re.fullmatch(r"[0-9]{5}", index) or int(index) >= frames for index in indices)
            or not capture_field_diffs(diffs, manifest)
            or type(observed.get("frames_compared")) is not int or observed["frames_compared"] != compared
            or type(observed.get("frame_mismatches")) is not int or observed["frame_mismatches"] != mismatches
            or type(observed.get("deterministic")) is not bool
            or not diffs and observed["deterministic"] is not (mismatches == 0)
            or mismatches > 0 and observed["deterministic"] is not False
            or probe["gate_ok"] is not (mismatches == 0 and not diffs)):
        return None
    failed = (["cross-launch-frame-determinism"] if mismatches else []) + (["cross-launch-manifest-fields"] if diffs else [])
    return ("fix" if failed else "ship"), failed


def visual_outcome(invocation_dir, fingerprint, capability, version):
    # Versioned projections interpret measured subject results, never the
    # adapter's transport exit, stdout, arbitrary paths or author assertions.
    if version != VISUAL_VERSIONS.get(capability):
        return None
    output = verified_invocation_output(invocation_dir, fingerprint)
    schemas = {"filmstrip-verify": "filmstrip-verify-observation/1", "video-forensics-receipt": "video-forensics-receipt-observation/1", "webgl-film-capture": "webgl-film-capture-observation/1"}
    if not isinstance(output, dict) or output.get("schema") != schemas[capability]:
        return None
    probes = output.get("probes")
    if not isinstance(probes, list) or not 1 <= len(probes) <= 16 or any(not isinstance(probe, dict) for probe in probes):
        return None
    if capability == "filmstrip-verify":
        if (output.get("measurer") != "capabilities/filmstrip-verify/adapter/run.js"
                or not isinstance(output.get("measurer_sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", output["measurer_sha256"])
                or not exact_numbers(output.get("thresholds"), FILMSTRIP_THRESHOLDS)):
            return None
        check, scope = filmstrip_probe, "frame-extraction-audio-holds"
    else:
        key, path = (("measurer", "capabilities/video-forensics-receipt/adapter/forensics.py") if capability == "video-forensics-receipt"
                     else ("capturer", "capabilities/webgl-film-capture/adapter/capture.js"))
        identity = output.get(key)
        if (not isinstance(identity, dict) or identity.get("path") != path
                or not isinstance(identity.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", identity["sha256"])
                or identity.get("documented_exit_codes") != [0, 2, 3, 4]):
            return None
        check, scope = ((forensics_probe, "reference-register-forensics") if capability == "video-forensics-receipt" else (capture_probe, "cross-launch-frame-determinism"))
    results = [check(probe) for probe in probes]
    if any(value is None for value in results):
        return None
    decisions = [value[0] for value in results]
    return {"schema": output["schema"], "scope": scope,
            "domain_verdict": "blocked" if "blocked" in decisions else "fix" if "fix" in decisions else "ship",
            "probes_total": len(probes), "probes_passed": decisions.count("ship"),
            "probes_failed": decisions.count("fix"), "probes_unavailable": decisions.count("blocked"),
            "failed_ids": sorted({check_id for _, failed in results for check_id in failed})}


def bounded_research_outcome(invocation_dir, fingerprint, version):
    output = verified_invocation_output(invocation_dir, fingerprint)
    if (version != "0.1.1" or not isinstance(output, dict)
            or set(output) != {"schema", "query", "passages", "refused"}
            or output.get("schema") != "bounded-research-observation/1"
            or not isinstance(output.get("query"), str) or not 1 <= len(output["query"].strip()) <= 280
            or not isinstance(output.get("passages"), list) or not isinstance(output.get("refused"), list)
            or not 1 <= len(output["passages"]) + len(output["refused"]) <= 5):
        return None
    from urllib.parse import urlsplit
    for passage in output["passages"]:
        if (not isinstance(passage, dict) or set(passage) != {"url", "host", "scheme", "status", "bytes", "sha256", "fetchedAt", "excerpt", "termHit"}
                or not isinstance(passage.get("url"), str) or not isinstance(passage.get("host"), str)
                or type(passage.get("status")) is not int or not 200 <= passage["status"] <= 299
                or type(passage.get("bytes")) is not int or not 1 <= passage["bytes"] <= 262144
                or not isinstance(passage.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", passage["sha256"])
                or not isinstance(passage.get("fetchedAt"), str) or not passage["fetchedAt"]
                or not isinstance(passage.get("excerpt"), str) or not 1 <= len(passage["excerpt"]) <= 500
                or type(passage.get("termHit")) is not bool):
            return None
        try:
            url = urlsplit(passage["url"])
            host = passage["host"].strip("[]")
            if (url.hostname != host or url.scheme != passage.get("scheme") or url.username or url.password
                    or not (url.scheme == "https" or url.scheme == "http" and host in ("127.0.0.1", "::1", "localhost"))):
                return None
        except ValueError:
            return None
    reasons = {"off-allowlist", "redirect-off-allowlist", "insecure-scheme", "credentials-in-url", "unparseable-url", "bad-redirect", "timeout", "fetch-error", "body-error", "non-text-payload", "oversize-payload", "empty-body", "no-extractable-text"}
    for refusal in output["refused"]:
        if (not isinstance(refusal, dict) or set(refusal) != {"url", "reason"}
                or not isinstance(refusal.get("url"), str) or not refusal["url"]
                or not isinstance(refusal.get("reason"), str)
                or not (refusal["reason"] in reasons or re.fullmatch(r"http-[0-9]{3}", refusal["reason"]))):
            return None
    # This is proof of cited fetching, not correctness of a research answer.
    # Empty observations are useful refusal evidence but cannot count as SHIP.
    return {"schema": output["schema"], "scope": "cited-fetch",
            "domain_verdict": "ship" if output["passages"] else "blocked",
            "passages": len(output["passages"]), "refused": len(output["refused"]),
            "term_hits": sum(p["termHit"] for p in output["passages"]),
            "refusal_reasons": sorted({r["reason"] for r in output["refused"]})}


def wishing_film_outcome(invocation_dir, fingerprint, version):
    # The frozen renderer and its executed PASS/defect evaluations define this
    # v1.0.0 contract. Adapter exit 0 means observation written, not film PASS.
    # Do not interpret a new version's unschematized output using these rules.
    output = verified_invocation_output(invocation_dir, fingerprint)
    if version != "1.0.0" or not isinstance(output, dict):
        return None
    verdict = output.get("verdict")
    run_exit = output.get("run_exit")
    checks = output.get("checks")
    failed_ids = output.get("failed_ids")
    if (type(run_exit) is not int or run_exit not in (0, 1, 2)
            or verdict != ("PASS", "FAIL", "VACUOUS")[run_exit]
            or not isinstance(checks, list) or not 1 <= len(checks) <= 128
            or not isinstance(failed_ids, list)):
        return None
    ids = []
    failed = []
    statuses = {}
    for check in checks:
        if (not isinstance(check, dict) or not isinstance(check.get("id"), str) or check["id"] not in FILM_V1_CHECKS | {"input"}
                or check.get("status") not in ("pass", "fail") or check["id"] in statuses):
            return None
        ids.append(check["id"])
        statuses[check["id"]] = check["status"]
        if check["status"] == "fail":
            failed.append(check["id"])
    if failed_ids != failed or (verdict == "PASS") != (len(failed) == 0):
        return None
    for field, count in (("checks_total", len(checks)), ("checks_failed", len(failed))):
        value = output.get(field)
        if value is not None and (type(value) is not int or value != count):
            return None
        if verdict != "VACUOUS" and value is None:
            return None
    gate = output.get("gate")
    gate_exit = gate.get("exit") if isinstance(gate, dict) else None
    if verdict != "VACUOUS":
        grid = output.get("grid_sha256")
        if (set(ids) != FILM_V1_CHECKS or type(gate_exit) is not int or not 0 <= gate_exit <= 255
                or statuses["gate-timeline"] != ("pass" if gate_exit == 0 else "fail")
                or not isinstance(grid, str) or re.fullmatch(r"33a9fec2[a-f0-9]{56}", grid) is None):
            return None
    summary = {"verdict": verdict, "domain_verdict": ("ship", "fix", "blocked")[run_exit],
               "run_exit": run_exit, "checks_total": len(checks), "checks_failed": len(failed), "failed_ids": failed}
    if type(gate_exit) is int and 0 <= gate_exit <= 255:
        summary["gate_exit"] = gate_exit
    # Artifact paths, argv, stdout/stderr and arbitrary measurements stay private.
    return summary


def mac_dell_staging_outcome(invocation_dir, fingerprint, version):
    # The mac-dell-staging v0.1.0 adapter NEVER executes staged content; it
    # always exits 0 and carries the DOMAIN status (ship|fix|blocked) inside the
    # report keyed by the action it performed. Reading only the adapter exit
    # code or the output digest is therefore BLIND to acceptance -- the very
    # gap a fresh seat reported. This resolves the frozen report body, verifies
    # it against the run-pinned digest, and exposes the bounded verdict plus the
    # real facts that decide it. Do not interpret a new version's
    # unschematized output using these rules.
    output = verified_invocation_output(invocation_dir, fingerprint)
    if version != "0.1.0" or not isinstance(output, dict):
        return None
    if (set(output) != {"schema", "action", "staging_id", "status", "detail"}
            or output.get("schema") != "mac-dell-staging-report/1"
            or output.get("action") not in ("stage", "publish", "rollback")
            or output.get("status") not in ("ship", "fix", "blocked")
            or not isinstance(output.get("staging_id"), str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", output["staging_id"])
            or not isinstance(output.get("detail"), dict)):
        return None
    action = output["action"]
    status = output["status"]
    detail = output["detail"]
    # The adapter's status is its domain verdict; expose it under the same key
    # the other capability extractors use so the run's acceptance arithmetic
    # (DOMAIN_CAPABILITIES / domain_verdict) sees it.
    summary = {"schema": output["schema"], "action": action, "status": status,
               "domain_verdict": status, "staging_id": output["staging_id"]}
    sha256_re = r"[a-f0-9]{64}"
    if action == "stage":
        if status == "ship":
            # Validated staged copy: identity proven, never executed.
            if (set(detail) != {"staged", "sha256", "bytes", "executed"}
                    or not isinstance(detail.get("staged"), str) or not detail["staged"]
                    or not isinstance(detail.get("sha256"), str) or re.fullmatch(sha256_re, detail["sha256"]) is None
                    or type(detail.get("bytes")) is not int or not 0 < detail["bytes"] <= 8 * 1024 * 1024
                    or detail.get("executed") is not False):
                return None
            summary.update({"bytes": detail["bytes"], "executed": False, "sha256": detail["sha256"]})
        elif status == "fix":
            # Identity refusal: the staged bytes did not match the declared hash.
            if (set(detail) != {"reason", "expected", "actual", "bytes"}
                    or detail.get("reason") != "sha256 mismatch"
                    or not isinstance(detail.get("expected"), str) or re.fullmatch(sha256_re, detail["expected"]) is None
                    or not isinstance(detail.get("actual"), str) or re.fullmatch(sha256_re, detail["actual"]) is None
                    or type(detail.get("bytes")) is not int or not 0 <= detail["bytes"] <= 8 * 1024 * 1024):
                return None
            summary.update({"reason": "sha256 mismatch", "expected": detail["expected"], "actual": detail["actual"], "bytes": detail["bytes"]})
        else:
            # Oversize / malformed / escape refusals before any write.
            if (set(detail) != {"reason", "bytes"}
                    or detail.get("reason") not in ("content exceeds 8 MiB",)
                    or type(detail.get("bytes")) is not int or not detail["bytes"] > 8 * 1024 * 1024):
                return None
            summary.update({"reason": detail["reason"], "bytes": detail["bytes"]})
    elif action == "publish":
        if status == "ship":
            # Reviewed publication: staged bytes copied in and verified. A null
            # lane means no compiled admission was claimed (and says so).
            if (set(detail) != {"published", "sha256", "manifest_admitted", "lane", "verified"}
                    or not isinstance(detail.get("published"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,200}", detail["published"])
                    or ".." in detail["published"].split("/")
                    or not isinstance(detail.get("sha256"), str) or re.fullmatch(sha256_re, detail["sha256"]) is None
                    or type(detail.get("manifest_admitted")) is not bool or detail.get("verified") is not True
                    or (detail.get("lane") is not None and (not isinstance(detail.get("lane"), str) or re.fullmatch(r"rcos-ir-[a-z0-9][a-z0-9-]{0,63}", detail["lane"]) is None))
                    or detail.get("manifest_admitted") != (detail.get("lane") is not None)):
                return None
            summary.update({"published": detail["published"], "sha256": detail["sha256"],
                            "manifest_admitted": detail["manifest_admitted"], "lane": detail.get("lane"), "verified": True})
        else:
            # A failed publication that was rolled back: nothing left behind.
            if (set(detail) != {"reason", "error", "rolled_back"}
                    or detail.get("reason") != "publication failed and was rolled back"
                    or not isinstance(detail.get("error"), str) or not 1 <= len(detail["error"]) <= 400
                    or detail.get("rolled_back") is not True):
                return None
            summary.update({"reason": detail["reason"], "rolled_back": True})
    else:  # rollback
        if status == "ship":
            # The published target was removed; the staged copy is retained.
            if (set(detail) != {"rolled_back", "staged_copy_retained"}
                    or not isinstance(detail.get("rolled_back"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,200}", detail["rolled_back"])
                    or ".." in detail["rolled_back"].split("/")
                    or not isinstance(detail.get("staged_copy_retained"), str) or not detail["staged_copy_retained"]):
                return None
            summary.update({"rolled_back": detail["rolled_back"], "staged_copy_retained": True})
        else:
            # Refused: there was no publish record to undo.
            if (set(detail) != {"reason", "staging_id"}
                    or detail.get("reason") != "no publish record to roll back"
                    or detail.get("staging_id") != output["staging_id"]):
                return None
            summary.update({"reason": detail["reason"]})
    # Absolute paths, argv, stdout/stderr and arbitrary error text stay private.
    return summary


def invocation_evidence(artifact_dir):
    evidence = []
    names = [name for name in sorted(os.listdir(artifact_dir)) if re.fullmatch(r"rcos-invocation-([a-z0-9][a-z0-9-]{0,63})\.json", name)]
    if len(names) > 8:
        # Never silently discard a later defect. Refuse oversized evidence
        # rather than spending an unbounded number of verifier subprocesses.
        return [{"error": "invocation receipt limit exceeded (maximum 8)", "evidence_limit_exceeded": True}]
    for name in names:
        match = re.fullmatch(r"rcos-invocation-([a-z0-9][a-z0-9-]{0,63})\.json", name)
        receipt = bounded_json(os.path.join(artifact_dir, name), artifact_dir)
        item = {"artifact": name}
        evidence.append(item)
        if not isinstance(receipt, dict) or receipt.get("schema") != "rcos-invocation/1" or receipt.get("capability_id") != match[1] or not re.fullmatch(r"inv_[A-Za-z0-9_-]{1,100}", str(receipt.get("invocation_id", ""))):
            item["error"] = "invalid invocation receipt"
            continue
        invocation_id = receipt["invocation_id"]
        invocation_root = os.path.join(RCOS_ROOT, "invocations")
        invocation_dir = os.path.realpath(os.path.join(invocation_root, invocation_id))
        if os.path.commonpath([os.path.realpath(invocation_root), invocation_dir]) != os.path.realpath(invocation_root):
            item["error"] = "invocation directory escaped the RCOS store"
            continue
        canonical = bounded_json(os.path.join(invocation_dir, "manifest.json"), invocation_dir)
        if canonical != receipt:
            item["error"] = "run receipt differs from canonical invocation manifest"
            continue
        checked = run([RCOS, "invocation-verify", "--invocation", invocation_id, "--json"], 5)
        verification = parse_json(getattr(checked, "stdout", ""))
        item["verification"] = {"ok": isinstance(checked, subprocess.CompletedProcess) and checked.returncode == 0 and isinstance(verification, dict) and verification.get("ok") is True}
        if not item["verification"]["ok"]:
            continue
        item["invocation"] = {key: receipt[key] for key in ("schema", "invocation_id", "capability_id", "capability_version", "mode", "status", "duration_ms", "eligibility_decision_id") if key in receipt}
        for field in ("input", "output"):
            fingerprint = receipt.get(field)
            if isinstance(fingerprint, dict):
                item["invocation"][field] = {key: fingerprint[key] for key in ("sha256", "bytes") if (key == "sha256" and isinstance(fingerprint.get(key), str) and re.fullmatch(r"[a-f0-9]{64}", fingerprint[key])) or (key == "bytes" and type(fingerprint.get(key)) is int and fingerprint[key] >= 0)}
        decision_id = receipt.get("eligibility_decision_id")
        if isinstance(decision_id, str) and re.fullmatch(r"elig_[A-Za-z0-9_-]{1,100}", decision_id):
            checked = run([RCOS, "eligibility-verify", "--decision", decision_id, "--json"], 5)
            verification = parse_json(getattr(checked, "stdout", ""))
            item["eligibility_verification"] = {"ok": isinstance(checked, subprocess.CompletedProcess) and checked.returncode == 0 and isinstance(verification, dict) and verification.get("ok") is True}
        if match[1] in DOMAIN_CAPABILITIES:
            if receipt.get("status") == "completed" and item.get("eligibility_verification", {}).get("ok") is True:
                summary = (invoice_outcome(invocation_dir, receipt.get("output")) if match[1] == "invoice-reconciliation-verify"
                           else visual_outcome(invocation_dir, receipt.get("output"), match[1], receipt.get("capability_version")) if match[1] in VISUAL_VERSIONS
                           else bounded_research_outcome(invocation_dir, receipt.get("output"), receipt.get("capability_version")) if match[1] == "bounded-research"
                           else mac_dell_staging_outcome(invocation_dir, receipt.get("output"), receipt.get("capability_version")) if match[1] == "mac-dell-staging"
                           else wishing_film_outcome(invocation_dir, receipt.get("output"), receipt.get("capability_version")))
                if summary is not None:
                    item["output"] = summary
            if "output" not in item:
                item["error"] = "verified " + match[1] + " outcome is unavailable or invalid"
        # Known schemas have bounded model-visible projections. Other
        # capabilities expose verified digests/status, never artifact bodies.
        if match[1] == "tree-digest-verify" and isinstance(receipt.get("output"), dict) and receipt["output"].get("path") == "output.json":
            output = bounded_json(os.path.join(invocation_dir, "output.json"), invocation_dir)
            if isinstance(output, dict) and output.get("schema") == "tree-digest-report/1" and isinstance(output.get("results"), list) and isinstance(output.get("probes"), list):
                item["output"] = {"schema": output["schema"], "results": [{key: row[key] for key in ("files", "digest", "empty_tree", "verdict", "files_delta") if key in row} for row in output.get("results", [])[:16] if isinstance(row, dict)], "probes": [{key: row[key] for key in ("probe", "refused", "would_be_exit") if key in row} for row in output.get("probes", [])[:16] if isinstance(row, dict)]}
    return evidence


def safe_relative_path(value):
    return (
        isinstance(value, str)
        and re.fullmatch(r"(?:artifacts/)?[A-Za-z0-9._/-]{1,240}", value) is not None
        and ".." not in value.split("/")
    )


op = REQ.get("operation")

if op == "rcos_catalog":
    rows, process = capability_rows()
    if rows is None:
        result(False, op, getattr(process, "returncode", None), "RCOS catalog could not be read or parsed", {"stderr": clipped(getattr(process, "stderr", ""), 1200)})
    else:
        fields = ("id", "name", "kind", "version", "status", "adapter", "reuse_count", "last_eval", "lineage")
        caps = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            item = {key: row[key] for key in fields if key in row}
            for key in ("name", "lineage"):
                if isinstance(item.get(key), str):
                    item[key] = item[key][:1000]
            caps.append(item)
        result(True, op, process.returncode, "RCOS registry read from the Dell", {"capabilities": caps})

elif op == "rcos_capability_contract":
    capability_id = REQ.get("capability_id")
    if not isinstance(capability_id, str) or not CAP_RE.fullmatch(capability_id):
        result(False, op, None, "capability_id must be a lowercase RCOS id")
    else:
        rows, process = capability_rows()
        cap = next((row for row in rows or [] if isinstance(row, dict) and row.get("id") == capability_id), None)
        if rows is None:
            result(False, op, getattr(process, "returncode", None), "RCOS registry could not be read")
        elif not isinstance(cap, dict) or cap.get("status") != "promoted" or not isinstance(cap.get("adapter"), dict) or cap["adapter"].get("type") != "command":
            result(False, op, None, "capability is not currently promoted with a command adapter")
        else:
            expected = "capabilities/" + capability_id + "/contract.json"
            if cap["adapter"].get("contract") != expected:
                result(False, op, None, "registry contract path does not match the capability's bounded contract location")
            else:
                capability_dir = os.path.realpath(os.path.join(RCOS_ROOT, "capabilities", capability_id))
                contract_path = os.path.realpath(os.path.join(capability_dir, "contract.json"))
                if os.path.commonpath([capability_dir, contract_path]) != capability_dir or not os.path.isfile(contract_path) or os.path.getsize(contract_path) > 32768:
                    result(False, op, None, "capability contract is missing, outside its directory, or larger than 32 KiB")
                else:
                    contract = parse_json(open(contract_path, encoding="utf-8").read())
                    if not isinstance(contract, dict):
                        result(False, op, None, "capability contract is not a JSON object")
                    else:
                        result(True, op, 0, "Promoted capability contract read from the registry-owned file", {"capability": {"id": capability_id, "name": cap.get("name"), "version": cap.get("version"), "adapter": cap["adapter"]}, "contract": contract})

elif op == "archon_workflow_catalog":
    rows, process = workflow_rows()
    if rows is None:
        result(False, op, getattr(process, "returncode", None), "Archon workflow catalog could not be read or parsed", {"stderr": clipped(getattr(process, "stderr", ""), 1200)})
    else:
        workflows = []
        for row in rows:
            if not isinstance(row, dict) or workflow_id(row) not in ALLOW:
                continue
            item = {key: row[key] for key in ("id", "name", "description", "purpose", "version") if key in row}
            for key in ("description", "purpose"):
                if isinstance(item.get(key), str):
                    item[key] = item[key][:1800]
            if workflow_id(row) == QA_VERIFY_WORKFLOW:
                item["input_contract"] = {
                    "field": "ref.inputs.task",
                    "type": "string",
                    "required": True,
                    "requirement": "Non-empty task string plus either a concrete absolute claimed file path, or an IR output naming artifacts/rcos-invocation-<executed-capability-id>.json. The compiler executes that capability in the parent prelude, then injects absolute claim_paths and the parent run_start_epoch into ARGUMENTS. QA checks file existence and freshness, not domain content; the parent separately verifies RCOS integrity, eligibility, and input/output contracts. Missing or stale claims block SHIP.",
                    "supported_extensions": ["yaml", "yml", "json", "md", "py", "sh", "txt", "log", "bak", "html", "mp4", "jpg", "jpeg", "png", "vtt", "css", "js"],
                    "example": "Verify the compiler-provided claim_paths using the parent run clock",
                    "generated_claim_output": "artifacts/rcos-invocation-<executed-capability-id>.json",
                }
            if workflow_id(row) == "chow-build-standard":
                item["input_contract"] = {
                    "field": "ref.inputs.task",
                    "type": "string",
                    "required": True,
                    "requirement": "Project build task constrained to the isolated child working directory and its artifacts. The source forbids inspecting other absolute paths supplied in the task, including parent capability receipts. Use chow-qa-verify-v1 for verification of compiler-provided parent claims; the parent prelude already executes the RCOS capability.",
                }
            if workflow_id(row) == "chow-research-search-v1":
                item["input_contract"] = {
                    "field": "ref.inputs.task",
                    "type": "string",
                    "required": True,
                    "requirement": "Non-empty search query, optionally followed by --max N or --full. Default evidence is search snippets; --full requests fetched excerpts where available. The preflight unwraps the RCOS task object and ignores compiler metadata. No usable results blocks before synthesis; citations and evidence scope are validated, factual claims are not independently fact-checked.",
                    "example": "Python pathlib Path official documentation --max 3",
                }
            evaluation_contract = WORKFLOW_EVALUATION_CONTRACTS.get(workflow_id(row))
            if evaluation_contract is not None:
                item["evaluation_contract"] = evaluation_contract
            execution_contract = WORKFLOW_EXECUTION_CONTRACTS.get(workflow_id(row))
            if execution_contract is not None:
                item["execution_contract"] = execution_contract
            workflows.append(item)
        result(True, op, process.returncode, "Only configured, reviewed Archon workflow names are shown", {"workflows": workflows, "allowlist": sorted(ALLOW)})

elif op == "archon_workflow_run":
    workflow = REQ.get("workflow_name")
    task = REQ.get("task")
    conversation_id = REQ.get("conversation_id")
    task_object = parse_json(task)
    if DESKTOP_MODE and not desktop_profile_ready():
        result(False, op, None, "host-owned Desktop workflow profile is unavailable; no fallback lane or run was started")
    elif not isinstance(workflow, str) or not WF_RE.fullmatch(workflow) or not workflow.startswith("rcos-ir-") or workflow not in ALLOW:
        result(False, op, None, "only an RCOS-compiled workflow created by this Workflow Manager seat may run")
    elif not isinstance(task, str) or len(task) > 8000 or not isinstance(task_object, dict):
        result(False, op, None, "task must be a JSON object string of at most 8000 characters")
    elif not isinstance(conversation_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", conversation_id):
        result(False, op, None, "live DSH seat session identity is missing or invalid")
    else:
        rows, catalog = workflow_rows()
        present = rows is not None and any(workflow_id(row) == workflow for row in rows if isinstance(row, dict))
        if not present:
            result(False, op, getattr(catalog, "returncode", None), "compiled workflow is absent from the current Archon catalog; no run was started")
        else:
            recent, listed = run_rows()
            if recent is None:
                result(False, op, getattr(listed, "returncode", None), "Archon run history could not be checked; refusing to start a possibly duplicate run")
            else:
                prior = [row for row in recent if isinstance(row, dict) and row.get("worker_platform_id") == conversation_id and workflow_name(row) == workflow]
                if len(prior) == 1:
                    summary = run_summary(prior[0])
                    summary["already_submitted"] = True
                    result(True, op, 0, "Reused the exact existing run for this Workflow Manager session; no duplicate was submitted", summary)
                elif len(prior) > 1:
                    result(False, op, None, "Multiple exact session/workflow runs exist; refusing to choose or resubmit", {"run_ids": [row.get("id") for row in prior if isinstance(row.get("id"), str)]})
                elif REQ.get("lookup_only") is True:
                    result(False, op, None, "No exact run is visible yet; lookup-only recovery never submits a duplicate", {"workflow_name": workflow, "conversation_id": conversation_id})
                else:
                    process = run([ARCHON, "workflow", "run", workflow, "--detach", "--json", "--conversation-id", conversation_id, *desktop_run_args(), task], 60)
                    if not isinstance(process, subprocess.CompletedProcess) or process.returncode != 0:
                        result(False, op, getattr(process, "returncode", None), "Archon rejected the workflow submission", {"stdout": clipped(getattr(process, "stdout", ""), 1200), "stderr": clipped(getattr(process, "stderr", ""), 1200)})
                    else:
                        receipt = parse_json(process.stdout)
                        run_id = receipt.get("runId") if isinstance(receipt, dict) else None
                        if (not isinstance(receipt, dict) or receipt.get("ok") is not True or receipt.get("action") != "run"
                                or receipt.get("detached") is not True or not isinstance(run_id, str) or not RUN_ID_RE.fullmatch(run_id)
                                or (receipt.get("workflow") is not None and receipt.get("workflow") != workflow)):
                            result(False, op, 0, "Archon accepted the request but returned no valid detached run receipt; retry will remain lookup-only", {"workflow_name": workflow, "conversation_id": conversation_id})
                            run_id = None
                        selected = None
                        if run_id is not None:
                            for _ in range(8):
                                detail_process = run([ARCHON, "workflow", "get", run_id, "--json"], 15)
                                detail = parse_json(getattr(detail_process, "stdout", "")) if isinstance(detail_process, subprocess.CompletedProcess) and detail_process.returncode == 0 else None
                                if isinstance(detail, dict) and detail.get("id") == run_id:
                                    reported_workflow = workflow_name(detail)
                                    if reported_workflow is not None and reported_workflow != workflow:
                                        break
                                    if detail.get("worker_platform_id") is not None and detail.get("worker_platform_id") != conversation_id:
                                        break
                                    if reported_workflow == workflow and isinstance(detail.get("conversation_id"), str) and RUN_ID_RE.fullmatch(detail["conversation_id"]):
                                        selected = detail
                                        break
                                time.sleep(0.25)
                        if run_id is None:
                            pass
                        elif selected is None:
                            result(False, op, 0, "Archon accepted the request but the exact detached run could not be verified; retry will remain lookup-only", {"run_id": run_id, "workflow_name": workflow, "conversation_id": conversation_id})
                        else:
                            summary = run_summary(selected)
                            summary["already_submitted"] = False
                            result(True, op, 0, "Archon accepted the RCOS-compiled workflow and its exact detached run was verified", summary)

elif op == "archon_run_status":
    run_id = REQ.get("run_id")
    conversation_id = REQ.get("conversation_id")
    if not isinstance(run_id, str) or not RUN_ID_RE.fullmatch(run_id):
        result(False, op, None, "run_id must be an exact run id returned by Archon")
    elif not isinstance(conversation_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", conversation_id):
        result(False, op, None, "live DSH seat session identity is missing or invalid")
    else:
        process = run([ARCHON, "workflow", "get", run_id, "--json"], 30)
        value = parse_json(getattr(process, "stdout", "")) if isinstance(process, subprocess.CompletedProcess) else None
        internal = REQ.get("archon_conversation_id")
        if isinstance(internal, str) and RUN_ID_RE.fullmatch(internal) and REQ.get("workflow_name") in ALLOW:
            # Identity captured by the host at submission, never a model-authored tool argument.
            bindings = [{"id": run_id, "conversation_id": internal, "workflow_name": REQ["workflow_name"]}]
        else:
            history, _ = run_rows()
            bindings = [row for row in history or [] if isinstance(row, dict) and row.get("id") == run_id and row.get("worker_platform_id") == conversation_id]
        if not isinstance(process, subprocess.CompletedProcess) or process.returncode != 0 or not isinstance(value, dict):
            result(False, op, getattr(process, "returncode", None), "Archon run detail could not be read", {"stderr": clipped(getattr(process, "stderr", ""), 1200)})
        elif len(bindings) != 1 or bindings[0].get("conversation_id") != value.get("conversation_id") or workflow_name(bindings[0]) != value.get("workflow_name") or not str(value.get("workflow_name") or "").startswith("rcos-ir-") or value.get("workflow_name") not in ALLOW:
            result(False, op, None, "run is not an RCOS-compiled workflow bound to this seat session")
        else:
            data = {key: value[key] for key in ("id", "conversation_id", "workflow_name", "status", "started_at", "completed_at", "last_activity_at", "working_path", "output_root", "outcome") if key in value}
            data["run_id"] = run_id
            if isinstance(value.get("metadata"), dict) and isinstance(value["metadata"].get("node_counts"), dict):
                data["node_counts"] = value["metadata"]["node_counts"]
            output_root = value.get("output_root") if isinstance(value.get("output_root"), str) else os.path.join(HOME, ".archon")
            artifact_dir = os.path.realpath(os.path.join(output_root, "artifacts", "runs", run_id))
            workspace_root = os.path.realpath(os.path.join(HOME, ".archon", "workspaces"))
            try:
                trusted_artifacts = os.path.commonpath([workspace_root, artifact_dir]) == workspace_root
            except ValueError:
                trusted_artifacts = False
            if trusted_artifacts and os.path.isdir(artifact_dir):
                data["artifact_dir"] = artifact_dir
                data["artifact_names"] = sorted(os.listdir(artifact_dir))[:100]
                eval_value = bounded_json(os.path.join(artifact_dir, "EVAL.json"), artifact_dir, 8000)
                if isinstance(eval_value, dict):
                    data["eval"] = {key: eval_value[key] for key in ("decision", "status", "reason", "check_type") if key in eval_value}
                data["rcos_invocations"] = invocation_evidence(artifact_dir)
            children, blockers = child_evaluations(artifact_dir, REQ.get("child_nodes"))
            data["child_evaluations"] = children
            domain_issues = []
            domain_decisions = []
            for item in data.get("rcos_invocations", []):
                if item.get("evidence_limit_exceeded") is True:
                    blockers.append("invocation receipt limit exceeded (maximum 8)")
                    continue
                capability_id = next((cap for cap in DOMAIN_CAPABILITIES if item.get("artifact") == "rcos-invocation-" + cap + ".json"), None)
                if capability_id is None:
                    continue
                summary = item.get("output")
                decision = summary.get("domain_verdict") if isinstance(summary, dict) else None
                domain_decisions.append(decision)
                if decision not in ("ship", "fix", "blocked"):
                    domain_issues.append(capability_id + ": verified domain outcome is unavailable")
                elif decision != "ship":
                    domain_issues.append(capability_id + ": domain verdict is " + decision)
            if data.get("status") in ("running", "queued", "pending"):
                # A detached run has not reached its acceptance boundary yet.
                # Missing child receipts and EVALs are checks to revisit, not failed gates.
                data["pending_checks"] = blockers
                data["acceptance_blockers"] = []
                data["effective_decision"] = "pending"
            elif data.get("status") != "completed":
                data["acceptance_blockers"] = ["parent run status is " + str(data.get("status") or "unknown")] + blockers + domain_issues
                data["effective_decision"] = "blocked"
            elif blockers:
                data["acceptance_blockers"] = blockers + domain_issues
                data["effective_decision"] = "blocked"
            else:
                data["acceptance_blockers"] = domain_issues
                parent_eval = data.get("eval")
                decision = parent_eval.get("decision") if isinstance(parent_eval, dict) and isinstance(parent_eval.get("decision"), str) else "unknown"
                if any(value not in ("ship", "fix") for value in domain_decisions):
                    decision = "blocked"
                elif "fix" in domain_decisions and decision.lower() in ("ship", "fix"):
                    decision = "fix"
                data["effective_decision"] = decision
            # A prior dispatch may have produced MORE THAN ONE run in the same
            # Archon conversation (e.g. a positive acceptance run beside a
            # deliberately-rejecting control run). The host records only the
            # single binding run_id, so a fresh seat could never read the
            # sibling -- the exact cross-seat evidence gap. When the request
            # carries a HOST-TRUSTED archon_conversation_id (captured at
            # submission, never a model argument), expose the same bounded
            # domain evidence for every sibling rcos-ir-* run sharing it.
            internal_conv = REQ.get("archon_conversation_id")
            if isinstance(internal_conv, str) and RUN_ID_RE.fullmatch(internal_conv):
                # A sibling is defined by SHARING THE TRUSTED CONVERSATION, never by
                # membership in this read's workflow allowlist. The allowlist holds
                # the reviewed names plus only the requested run's compiled wrapper;
                # a fresh seat reading a prior dispatch has NOT compiled the sibling
                # (e.g. the neg-hash control), so requiring membership silently hid
                # exactly the second run this channel exists to expose. The requested
                # run is still validated against ALLOW above, unchanged.
                siblings = [row for row in conversation_runs(internal_conv, 9) if isinstance(row, dict)
                            and row.get("id") != run_id
                            and isinstance(row.get("id"), str) and RUN_ID_RE.fullmatch(row["id"])
                            and isinstance(row.get("workflow_name"), str)
                            and row["workflow_name"].startswith("rcos-ir-")
                            and WF_RE.fullmatch(row["workflow_name"])]
                # Deterministic, bounded: newest first by the run's own clock.
                siblings.sort(key=lambda row: str(row.get("started_at") or ""), reverse=True)
                exposed = []
                for row in siblings[:8]:
                    sibling = {key: row[key] for key in ("conversation_id", "workflow_name", "status", "started_at", "completed_at") if key in row}
                    sibling["run_id"] = row["id"]
                    sib_dir = os.path.realpath(os.path.join(output_root, "artifacts", "runs", row["id"]))
                    try:
                        sib_trusted = os.path.commonpath([workspace_root, sib_dir]) == workspace_root
                    except ValueError:
                        sib_trusted = False
                    if sib_trusted and os.path.isdir(sib_dir):
                        sib_eval = bounded_json(os.path.join(sib_dir, "EVAL.json"), sib_dir, 8000)
                        if isinstance(sib_eval, dict):
                            sibling["eval"] = {key: sib_eval[key] for key in ("decision", "status", "reason", "check_type") if key in sib_eval}
                        sib_invocations = invocation_evidence(sib_dir)
                        sibling["rcos_invocations"] = sib_invocations
                        sib_decisions = []
                        for item in sib_invocations:
                            cap = next((c for c in DOMAIN_CAPABILITIES if item.get("artifact") == "rcos-invocation-" + c + ".json"), None)
                            if cap is None or not isinstance(item.get("output"), dict):
                                continue
                            sib_decisions.append(item["output"].get("domain_verdict"))
                        if sib_decisions:
                            sibling["domain_decisions"] = [d for d in sib_decisions]
                        # Give the sibling the SAME child evaluation the requested
                        # run gets: derive its child nodes from its own artifacts
                        # (archon-child-<node-id>.json), so "both run results" are
                        # symmetric rather than the requested run alone.
                        sib_nodes = []
                        try:
                            for entry in sorted(os.listdir(sib_dir)):
                                match = re.fullmatch(r"archon-child-([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.json", entry)
                                if not match:
                                    continue
                                receipt = bounded_json(os.path.join(sib_dir, entry), sib_dir, 8192)
                                if isinstance(receipt, dict) and isinstance(receipt.get("workflow_name"), str) and WF_RE.fullmatch(receipt["workflow_name"]):
                                    sib_nodes.append({"id": match[1], "workflow": receipt["workflow_name"]})
                        except OSError:
                            sib_nodes = []
                        if sib_nodes:
                            sib_children, _ = child_evaluations(sib_dir, sib_nodes)
                            sibling["child_evaluations"] = sib_children
                    exposed.append(sibling)
                # ALWAYS present the key when the trusted conversation id was
                # supplied -- an empty list means "the lookup ran and found no
                # sibling", which is a different fact from "no enumeration here".
                # A reader must never have to guess whether the channel ran.
                data["sibling_runs"] = exposed
            result(True, op, process.returncode, "Archon status, run identity, and available run artifacts were read by exact run id", data)

elif op == "rcos_compile_ir":
    ir = REQ.get("ir")
    name = REQ.get("name")
    errors = []
    if DESKTOP_MODE and not desktop_profile_ready():
        errors.append("host-owned Desktop workflow profile is unavailable; no fallback lane or installation is allowed")
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,55}", name):
        errors.append("workflow name must be a lowercase slug")
    if not isinstance(ir, dict):
        errors.append("IR must be a JSON object")
    elif len(json.dumps(ir, separators=(",", ":"), ensure_ascii=False).encode("utf-8")) > 65536:
        errors.append("IR exceeds 65536 bytes")

    if not errors:
        workflow_list, workflow_process = workflow_rows()
        capability_list, capability_process = capability_rows()
        actual_workflows = {workflow_id(row) for row in workflow_list or [] if isinstance(row, dict)}
        capabilities = {row.get("id"): row for row in capability_list or [] if isinstance(row, dict)}
        if workflow_list is None:
            errors.append("Archon catalog unavailable")
        if capability_list is None:
            errors.append("RCOS registry unavailable")
        if not isinstance(ir.get("objective"), str) or not ir.get("objective", "").strip() or len(ir.get("objective", "")) > 4000:
            errors.append("IR objective must be a non-empty string of at most 4000 characters")
        for field in ("inputs", "outputs"):
            values = ir.get(field)
            if not isinstance(values, dict):
                errors.append("IR " + field + " must be a map of labels to safe relative artifact paths")
                continue
            for label, value in values.items():
                if not isinstance(label, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", label) or not safe_relative_path(value):
                    errors.append("IR " + field + " contains an unsafe label or path")
        acceptance = ir.get("acceptance")
        if not isinstance(acceptance, list) or not 1 <= len(acceptance) <= 32 or any(not isinstance(item, str) or not item.strip() or len(item) > 1000 or re.search(r"[\x00-\x1f]", item) for item in acceptance):
            errors.append("IR needs 1 to 32 safe single-line acceptance criteria")
        if ir.get("approval_gates"):
            errors.append("IR approval_gates are not supported by this adapter")
        nodes = ir.get("nodes")
        if not isinstance(nodes, list) or not 1 <= len(nodes) <= 64:
            errors.append("IR needs 1 to 64 approved workflow nodes")
            nodes = []
        seen_node_ids = set()
        for node in nodes:
            if not isinstance(node, dict) or node.get("execution_class") != "workflow":
                errors.append("only Archon workflow nodes are allowed; deterministic Bash, model, and agent nodes are refused")
                continue
            node_id = node.get("id")
            if not isinstance(node_id, str) or not NODE_RE.fullmatch(node_id) or node_id in seen_node_ids or node.get("memory_scope") != "run":
                errors.append("workflow node ids must be unique and safe, and memory_scope must be run")
            if isinstance(node_id, str):
                seen_node_ids.add(node_id)
            dependencies = node.get("depends_on")
            if not isinstance(dependencies, list) or any(not isinstance(dep, str) or not NODE_RE.fullmatch(dep) for dep in dependencies):
                errors.append("workflow node dependencies must be a list of safe node ids")
            ref = node.get("ref") if isinstance(node.get("ref"), dict) else {}
            workflow = ref.get("workflow")
            if not isinstance(workflow, str) or not WF_RE.fullmatch(workflow) or workflow not in ALLOW or workflow not in actual_workflows:
                errors.append("workflow ref is not in both the current Archon catalog and configured approved allowlist")
            evaluation_contract = WORKFLOW_EVALUATION_CONTRACTS.get(workflow) if isinstance(workflow, str) else None
            if evaluation_contract is not None and evaluation_contract.get("gate_eligible") is False:
                errors.append(workflow + " is not eligible for the RCOS EVAL decision gate: " + evaluation_contract["reason"])
            execution_contract = WORKFLOW_EXECUTION_CONTRACTS.get(workflow) if isinstance(workflow, str) else None
            if execution_contract is not None and execution_contract.get("desktop_profile_eligible") is False:
                errors.append(workflow + " is not eligible for the Desktop execution profile: " + execution_contract["reason"])
            if ref.get("inputs") is not None and not isinstance(ref.get("inputs"), dict):
                errors.append("workflow ref inputs must be a JSON object")
            if workflow == QA_VERIFY_WORKFLOW:
                workflow_inputs = ref.get("inputs") if isinstance(ref.get("inputs"), dict) else {}
                qa_task = workflow_inputs.get("task")
                if not isinstance(qa_task, str) or not qa_task.strip() or (not QA_CLAIMED_PATH_RE.search(qa_task) and not has_generated_invocation_claim(ir)):
                    errors.append("chow-qa-verify-v1 requires ref.inputs.task to be a non-empty string and either an absolute claimed path with a supported file extension or an IR output naming the exact generated rcos-invocation-<executed-capability-id>.json receipt")

        refs = ir.get("capability_refs", [])
        if not isinstance(refs, list):
            errors.append("capability_refs must be a list")
            refs = []
        executed = []
        for ref in refs:
            if not isinstance(ref, dict) or not isinstance(ref.get("id"), str) or not CAP_RE.fullmatch(ref.get("id", "")) or ref.get("role") not in ("executed", "composed", "dependency"):
                errors.append("capability refs need a safe id and supported role")
                continue
            if ref.get("version") is not None and (not isinstance(ref.get("version"), str) or not VERSION_RE.fullmatch(ref.get("version", ""))):
                errors.append("capability ref version is invalid")
            if ref.get("invocation_id") is not None and (not isinstance(ref.get("invocation_id"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", ref.get("invocation_id", ""))):
                errors.append("capability ref invocation id is invalid")
            if ref.get("role") == "executed":
                executed.append(ref)
        if not executed:
            errors.append("at least one executed RCOS capability ref is required")
        for ref in executed:
            cap = capabilities.get(ref["id"])
            if not isinstance(cap, dict) or cap.get("status") != "promoted" or not isinstance(cap.get("adapter"), dict) or cap["adapter"].get("type") != "command":
                errors.append("each executed RCOS ref must name a currently promoted command capability")

        if not isinstance(workflow_process, subprocess.CompletedProcess) or not isinstance(capability_process, subprocess.CompletedProcess):
            errors.append("RCOS or Archon catalog command did not complete")
        if isinstance(name, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,55}", name):
            destination = os.path.join(HOME, ".archon", "workflows", "rcos-ir-" + name + ".yaml")
            if os.path.exists(destination):
                errors.append("compiled workflow already exists; choose a new name to preserve additive, write-once installation")
            if DESKTOP_MODE and os.path.lexists(os.path.join(DESKTOP_SOURCE, ".archon", "workflows", "rcos-ir-" + name + ".yaml")):
                errors.append("Desktop compiled workflow already exists; choose a new additive name")
        if DESKTOP_MODE and not errors:
            verifier = os.path.join(RCOS_ROOT, "tools", "verify-desktop-manifests.py")
            verification = run(["python3", verifier], 30)
            if not isinstance(verification, subprocess.CompletedProcess) or verification.returncode != 0:
                errors.append("trusted Desktop source manifest gate is not green; compile refused before installation")

    if errors:
        result(False, op, None, "safe RCOS IR compile refused before installation", {"violations": sorted(set(errors))})
    else:
        descriptor, path = tempfile.mkstemp(prefix="dsh-rcos-ir-", suffix=".json", dir="/tmp")
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(ir, output, separators=(",", ":"), ensure_ascii=False)
            process = run([RCOS, "ir-compile", "--ir", path, "--name", name, "--install"], 60)
            if not isinstance(process, subprocess.CompletedProcess):
                result(False, op, None, "RCOS compiler timed out before returning an install result")
            else:
                if process.returncode == 0:
                    try:
                        install_desktop_wrapper(name)
                    except (OSError, ValueError) as error:
                        result(False, op, None, "compiled wrapper could not be installed into the trusted Desktop source; do not execute it and choose a fresh name after repair", {"error": str(error)[:800]})
                        raise SystemExit(0)
                refs = [{key: ref[key] for key in ("id", "version", "role") if key in ref} for ref in ir.get("capability_refs", []) if isinstance(ref, dict)]
                workflows = [node["ref"]["workflow"] for node in ir.get("nodes", []) if isinstance(node, dict) and isinstance(node.get("ref"), dict) and isinstance(node["ref"].get("workflow"), str)]
                result(process.returncode == 0, op, process.returncode, "safe RCOS IR compile result", {"workflow_name": "rcos-ir-" + name, "workflow_file": os.path.join(HOME, ".archon", "workflows", "rcos-ir-" + name + ".yaml"), "capability_refs": refs, "archon_workflows": workflows, "stdout": clipped(process.stdout, 6000), "stderr": clipped(process.stderr, 6000)})
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

else:
    result(False, str(op or "unknown"), None, "unsupported RCOS/Archon adapter operation")
