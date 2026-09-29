#!/bin/zsh
# A2-d composer run — scratch testbed (dsh-a0-boot), loopback-only, ZERO
# spend: dummy key + 127.0.0.1 base URL; the scratch DSH_HOME holds no real
# credentials. Boots the headless profile with the a2d overlay (one-shot rows
# disabled, composer row inserted), captures ndjson + stderr, and returns the
# dsh exit code. The WM program (program.a2d.txt) runs the four failure-path
# probes; P1/P2 reach the Dell over ssh read-only-or-/tmp, P3/P4 are local.
set -u
BOOT=/Users/adam26/dsh-a0-boot
A2D=$BOOT/a2d
NODE=/Users/adam26/.nvm/versions/node/v24.15.0/bin/node
PORT=8793

export DSH_HOME=$BOOT/home
export DEEPSEEK_API_KEY='a2d-dummy-key-loopback-only'
export DEEPSEEK_BASE_URL="http://127.0.0.1:$PORT"

mkdir -p "$A2D/evidence" "$A2D/caller-cwd"
: > "$A2D/evidence/loopback.jsonl"

"$NODE" "$A2D/loopback.mjs" &
MOCK=$!
sleep 1

cd "$A2D/caller-cwd"
"$NODE" "$BOOT/rt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile headless --patch "$A2D/overlay.yml" \
  > "$A2D/evidence/composer.ndjson" 2> "$A2D/evidence/composer.stderr.log"
STATUS=$?

sleep 0.3
kill $MOCK 2>/dev/null
wait $MOCK 2>/dev/null
echo "exit=$STATUS"
exit $STATUS
