#!/bin/bash
# Restart machine B's consumer actor in place (state on disk is untouched).
pkill -f 'flowrouter-b-actor[.]mjs' 2>/dev/null
sleep 1
cd /home/chow/rcos-p1x
DSH_HOME=/tmp/i0-b/actor-home nohup node eval/lib/flowrouter-b-actor.mjs --port 8415 --repo /home/chow/rcos-p1x > /tmp/i0-b/actor.log 2>&1 < /dev/null &
sleep 3
curl -s -m 4 http://127.0.0.1:8415/actor | head -c 120
echo
