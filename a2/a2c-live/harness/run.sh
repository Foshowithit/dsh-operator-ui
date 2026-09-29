#!/bin/zsh
# A2-c composer run — scratch testbed (dsh-a0-boot), loopback-only, ZERO
# spend: dummy key + 127.0.0.1 base URL; the scratch DSH_HOME holds no real
# credentials. Boots the headless profile with the a2c overlay (one-shot rows
# disabled, composer row inserted), captures ndjson + stderr, and returns the
# dsh exit code.
#
# usage: run.sh            (dry-run program, no Dell)
#        A2C_PROGRAM=/Users/adam26/dsh-a0-boot/a2c/program.live.txt run.sh
set -u
BOOT=/Users/adam26/dsh-a0-boot
A2C=$BOOT/a2c
NODE=/Users/adam26/.nvm/versions/node/v24.15.0/bin/node
PORT=8793

export DSH_HOME=$BOOT/home
export DEEPSEEK_API_KEY='a2c-dummy-key-loopback-only'
export DEEPSEEK_BASE_URL="http://127.0.0.1:$PORT"

mkdir -p "$A2C/evidence" "$A2C/caller-cwd"
: > "$A2C/evidence/loopback.jsonl"

"$NODE" "$A2C/loopback.mjs" &
MOCK=$!
sleep 1

cd "$A2C/caller-cwd"
"$NODE" "$BOOT/rt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile headless --patch "$A2C/overlay.yml" \
  > "$A2C/evidence/composer.ndjson" 2> "$A2C/evidence/composer.stderr.log"
STATUS=$?

sleep 0.3
kill $MOCK 2>/dev/null
wait $MOCK 2>/dev/null
echo "exit=$STATUS"
exit $STATUS
