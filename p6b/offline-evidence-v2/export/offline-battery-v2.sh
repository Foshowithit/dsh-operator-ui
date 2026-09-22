#!/usr/bin/env bash
# P6B v2 offline battery (per EXECUTION-SPEC-v2.md). Executes ONLY inside the
# disposable Linux VM: no network calls, no sandbox provisioning, no paid
# services, no production host. Two separate package trees — one under uid 501,
# one under uid 0 — each entry through the fail-closed isolation guard; then
# two negative controls on disposable invocation copies (gates read-only).
# All evidence is packed to $STAGE/export.tgz for pull-back into the worktree.
set -euo pipefail

STAGE=/tmp/p6b-v2-battery
SRC="$STAGE/src"
NODEDIR=/tmp/node-dist/node-v20.20.2-linux-arm64/bin
NODE="$NODEDIR/node"
export PATH="$NODEDIR:$PATH"   # gates/adapter spawn literal `node`; sudo (root part) passes this PATH explicitly

PART="${1:-all}"
mkdir -p "$STAGE/logs" "$STAGE/meta"

log() { echo "[$(date -u +%FT%TZ)] $*"; }
die() { echo "BATTERY-FAIL: $*" >&2; exit 1; }

[ -x "$NODE" ] || die "node missing at $NODE"
"$NODE" -v > "$STAGE/meta/node-version.txt"

guard() {
  local tree=$1; shift
  RCOS_HOME="$tree" "$NODE" "$SRC/run-isolated.cjs" \
    --root "$tree" \
    --manifest "$SRC/rcos-kernel-subset-v2.manifest.sha256" \
    "$@"
}

runid_of() { sed -n 's/^run \([^:]*\): .*/\1/p' "$1" | head -1; }
expect_exit() { [ "$2" -eq "$1" ] || die "$3: exit $2 (want $1)"; return 0; }
ok_lines() { grep -c '^  ok' "$1" || true; }

# --- uid 501 battery ------------------------------------------------------
user_part() {
  id > "$STAGE/meta/id-501.txt"
  local tree="$STAGE/tree-501/rcos-kernel-subset-v2"
  rm -rf "$STAGE/tree-501"
  mkdir -p "$STAGE/tree-501"
  cp -a "$SRC/rcos-kernel-subset-v2" "$tree"

  log "guard --check-only (uid 501, pre)"
  guard "$tree" --check-only > "$STAGE/logs/guard-501-pre.log" 2>&1 \
    || die "guard pre (501): $(cat "$STAGE/logs/guard-501-pre.log")"

  log "eval-run reuse-ledger-invariant-v2 as uid 501"
  set +e
  guard "$tree" -- "$NODE" "$tree/bin/rcos" eval-run --eval reuse-ledger-invariant-v2 \
    > "$STAGE/logs/eval-501-invariant.log" 2>&1
  local rc=$?
  set -e
  echo "$rc" > "$STAGE/meta/eval-501-invariant.exit"
  expect_exit 0 "$rc" "501 invariant"
  grep -q ': ship' "$STAGE/logs/eval-501-invariant.log" || die "501 invariant: verdict not ship"
  [ "$(ok_lines "$STAGE/logs/eval-501-invariant.log")" -eq 4 ] || die "501 invariant: want 4 ok gates, got $(ok_lines "$STAGE/logs/eval-501-invariant.log")"
  local run501inv
  run501inv=$(runid_of "$STAGE/logs/eval-501-invariant.log")
  [ -n "$run501inv" ] || die "501 invariant: run id unparseable"
  echo "$run501inv" > "$STAGE/meta/run-501-invariant.id"

  set +e
  guard "$tree" -- "$NODE" "$tree/bin/rcos" eval-verify --run "$run501inv" \
    > "$STAGE/logs/verify-501-invariant.log" 2>&1
  rc=$?; set -e
  echo "$rc" > "$STAGE/meta/verify-501-invariant.exit"
  expect_exit 0 "$rc" "501 invariant eval-verify"

  log "eval-run execution-posture-v1 as uid 501"
  set +e
  guard "$tree" -- "$NODE" "$tree/bin/rcos" eval-run --eval execution-posture-v1 \
    > "$STAGE/logs/eval-501-posture.log" 2>&1
  rc=$?; set -e
  echo "$rc" > "$STAGE/meta/eval-501-posture.exit"
  expect_exit 0 "$rc" "501 posture"
  grep -q ': ship' "$STAGE/logs/eval-501-posture.log" || die "501 posture: verdict not ship"
  [ "$(ok_lines "$STAGE/logs/eval-501-posture.log")" -eq 4 ] || die "501 posture: want 4 ok gates, got $(ok_lines "$STAGE/logs/eval-501-posture.log")"
  local run501pos
  run501pos=$(runid_of "$STAGE/logs/eval-501-posture.log")
  [ -n "$run501pos" ] || die "501 posture: run id unparseable"
  echo "$run501pos" > "$STAGE/meta/run-501-posture.id"

  set +e
  guard "$tree" -- "$NODE" "$tree/bin/rcos" eval-verify --run "$run501pos" \
    > "$STAGE/logs/verify-501-posture.log" 2>&1
  rc=$?; set -e
  echo "$rc" > "$STAGE/meta/verify-501-posture.exit"
  expect_exit 0 "$rc" "501 posture eval-verify"

  log "guard --check-only (uid 501, post)"
  guard "$tree" --check-only > "$STAGE/logs/guard-501-post.log" 2>&1 \
    || die "guard post (501): $(cat "$STAGE/logs/guard-501-post.log")"
  log "uid501 battery GREEN"
}

# --- uid 0 battery (self re-entry through sudo) ---------------------------
root_part() {
  [ "$(id -u)" -eq 0 ] || die "root-part invoked as uid $(id -u)"
  id > "$STAGE/meta/id-0.txt"
  local tree="$STAGE/tree-root/rcos-kernel-subset-v2"
  rm -rf "$STAGE/tree-root"
  mkdir -p "$STAGE/tree-root"
  cp -a "$SRC/rcos-kernel-subset-v2" "$tree"

  log "guard --check-only (uid 0, pre)"
  guard "$tree" --check-only > "$STAGE/logs/guard-0-pre.log" 2>&1 \
    || die "guard pre (root): $(cat "$STAGE/logs/guard-0-pre.log")"

  log "eval-run reuse-ledger-invariant-v2 as uid 0 (headline: privilege-independent)"
  set +e
  guard "$tree" -- "$NODE" "$tree/bin/rcos" eval-run --eval reuse-ledger-invariant-v2 \
    > "$STAGE/logs/eval-0-invariant.log" 2>&1
  local rc=$?
  set -e
  echo "$rc" > "$STAGE/meta/eval-0-invariant.exit"
  expect_exit 0 "$rc" "root invariant"
  grep -q ': ship' "$STAGE/logs/eval-0-invariant.log" || die "root invariant: verdict not ship"
  [ "$(ok_lines "$STAGE/logs/eval-0-invariant.log")" -eq 4 ] || die "root invariant: want 4 ok gates, got $(ok_lines "$STAGE/logs/eval-0-invariant.log")"
  local run0inv
  run0inv=$(runid_of "$STAGE/logs/eval-0-invariant.log")
  [ -n "$run0inv" ] || die "root invariant: run id unparseable"
  echo "$run0inv" > "$STAGE/meta/run-0-invariant.id"

  set +e
  guard "$tree" -- "$NODE" "$tree/bin/rcos" eval-verify --run "$run0inv" \
    > "$STAGE/logs/verify-0-invariant.log" 2>&1
  rc=$?; set -e
  echo "$rc" > "$STAGE/meta/verify-0-invariant.exit"
  expect_exit 0 "$rc" "root invariant eval-verify"

  log "eval-run execution-posture-v1 as uid 0 (expect BLOCKED exit 4, named refusal)"
  set +e
  guard "$tree" -- "$NODE" "$tree/bin/rcos" eval-run --eval execution-posture-v1 \
    > "$STAGE/logs/eval-0-posture.log" 2>&1
  rc=$?; set -e
  echo "$rc" > "$STAGE/meta/eval-0-posture.exit"
  expect_exit 4 "$rc" "root posture"
  grep -q ': blocked' "$STAGE/logs/eval-0-posture.log" || die "root posture: verdict not blocked"
  grep -q '^  BLOCKED live_non_root_requirement' "$STAGE/logs/eval-0-posture.log" || die "root posture: gate4 not BLOCKED"
  [ "$(ok_lines "$STAGE/logs/eval-0-posture.log")" -eq 3 ] || die "root posture: gates 1-3 want 3 ok, got $(ok_lines "$STAGE/logs/eval-0-posture.log")"
  local run0pos
  run0pos=$(runid_of "$STAGE/logs/eval-0-posture.log")
  [ -n "$run0pos" ] || die "root posture: run id unparseable"
  echo "$run0pos" > "$STAGE/meta/run-0-posture.id"

  # The named refusal must be preserved in checks.json (full stderr per gate).
  local checks
  checks=$(find "$tree/runs" -name checks.json -path "*${run0pos}*" | head -1)
  [ -n "$checks" ] || die "root posture: checks.json not found under runs/"
  grep -q 'environment-incompatibility' "$checks" || die "root posture: checks.json lacks environment-incompatibility"
  echo "$checks" > "$STAGE/meta/checks-0-posture.path"

  set +e
  guard "$tree" -- "$NODE" "$tree/bin/rcos" eval-verify --run "$run0pos" \
    > "$STAGE/logs/verify-0-posture.log" 2>&1
  rc=$?; set -e
  echo "$rc" > "$STAGE/meta/verify-0-posture.exit"
  expect_exit 0 "$rc" "root posture eval-verify"

  log "guard --check-only (uid 0, post)"
  guard "$tree" --check-only > "$STAGE/logs/guard-0-post.log" 2>&1 \
    || die "guard post (root): $(cat "$STAGE/logs/guard-0-post.log")"

  chmod -R a+rX "$STAGE/tree-root"   # pull-back readable by uid 501
  log "uid 0 battery GREEN"
}

# --- negative controls (uid 501, disposable copies, read-only gates) -----
negative_controls() {
  local tree="$STAGE/tree-501/rcos-kernel-subset-v2"
  local invs
  invs=$(ls "$tree/invocations" 2>/dev/null || true)
  [ "$(printf '%s' "$invs" | grep -c .)" -eq 1 ] || die "NC: expected exactly 1 invocation dir, got: [$invs]"
  local srcinv="$tree/invocations/$invs"

  # NC1: tamper the fault step's recorded registry sha in a COPY of output.json.
  # Evidence beside it stays untouched (passes the evidence check), but the gate's
  # own comparison fails: "registry mutated by the failed append" -> exit 3.
  local nc1="$STAGE/nc1"
  rm -rf "$nc1"; mkdir -p "$nc1"
  cp -a "$srcinv/." "$nc1/"
  "$NODE" -e '
    const fs = require("node:fs");
    const p = process.argv[1];
    const o = JSON.parse(fs.readFileSync(p, "utf8"));
    const st = o.steps.find((s) => s.name === "reuse_log_append_blocked");
    if (!st) { console.error("fault step not found"); process.exit(1); }
    st.registry_sha256 = "0".repeat(64);
    fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
  ' "$nc1/output.json" || die "NC1: tamper failed"
  set +e
  RCOS_INVOCATION_DIR="$nc1" "$NODE" "$tree/evals/reuse-ledger-invariant-v2/gates/check.js" \
    append_failure_leaves_registry_untouched > "$STAGE/logs/nc1-gate.log" 2>&1
  local rc=$?
  set -e
  echo "$rc" > "$STAGE/meta/nc1.exit"
  expect_exit 3 "$rc" "NC1"
  grep -q 'registry mutated' "$STAGE/logs/nc1-gate.log" || die "NC1: wrong failure reason: $(cat "$STAGE/logs/nc1-gate.log")"

  # NC2: append one VALID extra json row to a COPY of evidence/traces.jsonl.
  # The observation no longer matches its own evidence: every gate -> exit 3
  # with "the observation contradicts its own evidence".
  local nc2="$STAGE/nc2"
  rm -rf "$nc2"; mkdir -p "$nc2"
  cp -a "$srcinv/." "$nc2/"
  printf '%s\n' '{"capability":"fixture-cap","task_id":"nc2-extra","verdict":"ship","source":"reuse","backfilled":false}' \
    >> "$nc2/evidence/traces.jsonl"
  set +e
  RCOS_INVOCATION_DIR="$nc2" "$NODE" "$tree/evals/reuse-ledger-invariant-v2/gates/check.js" \
    sync_refuses_without_trace_log > "$STAGE/logs/nc2-gate.log" 2>&1
  rc=$?; set -e
  echo "$rc" > "$STAGE/meta/nc2.exit"
  expect_exit 3 "$rc" "NC2"
  grep -q 'contradicts its own evidence' "$STAGE/logs/nc2-gate.log" || die "NC2: wrong failure reason: $(cat "$STAGE/logs/nc2-gate.log")"
  log "negative controls GREEN (NC1 exit 3 registry-mutated, NC2 exit 3 evidence-contradiction)"
}

# --- orchestration --------------------------------------------------------
if [ "$PART" = "root-part" ]; then
  root_part
  exit 0
fi

if [ "$PART" = "all" ]; then
  [ "$(id -u)" -eq 501 ] || die "all invoked as uid $(id -u) (expected 501)"
  find "$SRC" \( -name '._*' -o -name '.DS_Store' \) -delete
  user_part
  log "handing to uid 0 via sudo (PATH carried explicitly)"
  sudo -n env "PATH=$PATH" bash "$0" root-part
  negative_controls
  log "packing export"
  rm -rf "$STAGE/export"
  mkdir -p "$STAGE/export"
  cp -a "$STAGE/logs" "$STAGE/meta" "$STAGE/export/"
  cp -a "$STAGE/tree-501" "$STAGE/export/tree-501"
  cp -a "$STAGE/tree-root" "$STAGE/export/tree-root"
  cp -a "$STAGE/nc1" "$STAGE/export/nc1"
  cp -a "$STAGE/nc2" "$STAGE/export/nc2"
  cp -a "$SRC/rcos-kernel-subset-v2.manifest.sha256" \
        "$SRC/run-isolated.cjs" \
        "$SRC/offline-battery-v2.sh" "$STAGE/export/"
  tar -C "$STAGE" -czf "$STAGE/export.tgz" export
  echo "BATTERY-COMPLETE"
  exit 0
fi
die "unknown part: $PART (use all|root-part)"
