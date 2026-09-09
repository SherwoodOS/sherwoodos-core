#!/bin/sh
set -e
cd /app

DATA_DIR="${DATA_DIR:-/data}"
if ! mkdir -p "$DATA_DIR" 2>/dev/null || ! [ -w "$DATA_DIR" ]; then
  echo "[entrypoint] $DATA_DIR is not writable, falling back to /tmp/data (state will not survive a restart)"
  DATA_DIR=/tmp/data
  mkdir -p "$DATA_DIR"
fi
export DATA_DIR
export DATABASE_URL="${DATABASE_URL:-file:$DATA_DIR/app.db}"

if [ "${CHAIN_MODE:-fork}" = "fork" ]; then
  FORK_URL="${FORK_RPC_URL:-https://robinhood.drpc.org}"
  export HOME="$DATA_DIR/home"
  mkdir -p "$HOME"
  (
    while true; do
      anvil --fork-url "$FORK_URL" --chain-id "${CHAIN_ID:-4663}" --host 127.0.0.1 --port 8663 \
        --state "$DATA_DIR/anvil-state.json" --state-interval 30 \
        --compute-units-per-second "${ANVIL_CUPS:-80}" --retries 5 --timeout 45000 \
        --silent || echo "[anvil] exited with $?; restarting in 5s"
      sleep 5
    done
  ) &
  export RPC_URL="${RPC_URL:-http://127.0.0.1:8663}"
fi

exec bun run backend/src/index.ts
