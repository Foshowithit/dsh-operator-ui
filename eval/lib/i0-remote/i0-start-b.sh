#!/bin/bash
# Machine B bootstrap for the I0 campaign: wipe B's I0 state, then start the
# two repositories, the consumer actor and B's own execution runner.
pkill -f 'flowrouter-service[.]mjs --port 1314' 2>/dev/null
pkill -f 'local-dag-runner[.]mjs --port 13094' 2>/dev/null
sleep 1
rm -rf /tmp/i0-b
mkdir -p /tmp/i0-b/stores /tmp/i0-b/actor-home/operator-ui /tmp/i0-b/wf /tmp/i0-b/ws
echo '{"registry_version":"rcos-public-v1","capabilities":[]}' > /tmp/i0-b/actor-home/operator-ui/b-registry.json
echo '{"tasksVersion":1,"tasks":[]}' > /tmp/i0-b/actor-home/operator-ui/tasks.json
cat > /tmp/i0-b/actor-home/operator-ui.config.json << 'CFG'
{ "registry": { "path": "/tmp/i0-b/actor-home/operator-ui/b-registry.json" },
  "archon": { "baseUrl": "http://127.0.0.1:13094", "timeoutMs": 120000 },
  "execution": { "mode": "archon" },
  "teaching": { "workflowsDir": "/tmp/i0-b/wf", "workspaceDir": "/tmp/i0-b/ws" } }
CFG
cd /home/chow/rcos-p1x
for spec in "13142 r2" "13143 r3"; do
  set -- $spec
  DSH_HOME=/tmp/i0-b/actor-home nohup node eval/lib/flowrouter-service.mjs --port "$1" --store "/tmp/i0-b/stores/$2" > "/tmp/i0-b/$2.log" 2>&1 < /dev/null &
done
DSH_HOME=/tmp/i0-b/actor-home nohup node eval/lib/local-dag-runner.mjs --port 13094 --workflows-dir /tmp/i0-b/wf --workspace /tmp/i0-b/ws --state /tmp/i0-b/runs.jsonl > /tmp/i0-b/runner.log 2>&1 < /dev/null &
sleep 4
echo "R2: $(curl -s -m 4 http://127.0.0.1:13142/status)"
echo "R3: $(curl -s -m 4 http://127.0.0.1:13143/status)"
echo "RUNNER: $(curl -s -m 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:13094/api/workflows/runs)"
