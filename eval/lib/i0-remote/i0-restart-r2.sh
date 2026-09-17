#!/bin/bash
# Restart machine B's R2 mirror in place (its durable store is untouched).
pkill -f 'flowrouter-service[.]mjs --port 13142' 2>/dev/null
sleep 1
cd /home/<redacted>/rcos-p1x
DSH_HOME=/tmp/i0-b/actor-home nohup node eval/lib/flowrouter-service.mjs --port 13142 --store /tmp/i0-b/stores/r2 > /tmp/i0-b/r2.log 2>&1 < /dev/null &
sleep 3
curl -s -m 4 http://127.0.0.1:13142/status
echo
