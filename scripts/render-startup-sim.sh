#!/usr/bin/env bash
# Simulates Render booting the service with its DEFAULT start command: `node server.js`.
# Confirms the shim launches backend/server.mjs, binds 0.0.0.0:${PORT} and /health = 200.
set -u

cd "$(dirname "$0")/.." || exit 1
export PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH

PORT="${PORT:-10000}"
SIM_DIR="$(mktemp -d)"
LOG="$SIM_DIR/startup.log"

export NODE_ENV=production
export RENDER=true
export PORT
export BIND_HOST=127.0.0.1   # must be overridden to 0.0.0.0 on Render
export SECRETS_MASTER_KEY="$(node -e "console.log(Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'))")"
export DATABASE_FILE="$SIM_DIR/db/agent.sqlite"
export WORKSPACE_ROOT="$SIM_DIR/workspace"
export ALLOWED_ORIGIN="https://example.vercel.app"
export PUBLIC_APP_URL="https://example.vercel.app"
mkdir -p "$WORKSPACE_ROOT"

echo "### Command Render runs by default: node server.js"
echo "### PORT=$PORT  RENDER=$RENDER  BIND_HOST=$BIND_HOST"
echo

node server.js >"$LOG" 2>&1 &
PID=$!

# wait for the listening line (max ~15s)
for _ in $(seq 1 30); do
  grep -q "backend listening on" "$LOG" && break
  sleep 0.5
done

echo "===== STARTUP LOG ====="
cat "$LOG"
echo
echo "===== GET /health ====="
curl -s -o "$SIM_DIR/health.json" -w "HTTP %{http_code}\n" "http://127.0.0.1:${PORT}/health"
cat "$SIM_DIR/health.json"; echo
echo
echo "===== socket binding (ss -ltnp) ====="
ss -ltnp 2>/dev/null | grep -E ":${PORT}\b" || echo "(ss not available)"

kill "$PID" 2>/dev/null
sleep 1
kill -9 "$PID" 2>/dev/null
rm -rf "$SIM_DIR"
