#!/usr/bin/env bash
# Simulates Render booting the backend with ONLY SECRETS_MASTER_KEY set
# (Render sets NODE_ENV=production by default and does NOT set DATABASE_FILE /
# WORKSPACE_ROOT). Confirms the storage defaults kick in, the server binds
# 0.0.0.0:${PORT} and /health = 200.
set -u

cd "$(dirname "$0")/.." || exit 1
export PATH=/tmp/node-v22.23.2-linux-x64/bin:$PATH

PORT="${PORT:-10000}"
SIM_DIR="$(mktemp -d)"
LOG="$SIM_DIR/startup.log"

export NODE_ENV=production
export RENDER=true
export PORT
export SECRETS_MASTER_KEY="$(node -e "console.log(Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'))")"
# NOTE: DATABASE_FILE and WORKSPACE_ROOT are intentionally UNSET (Render default).
unset DATABASE_FILE WORKSPACE_ROOT DATABASE_DIR

echo "### Render-like env: NODE_ENV=production RENDER=true PORT=$PORT"
echo "### DATABASE_FILE / WORKSPACE_ROOT: (unset -> code defaults)"
echo

node --experimental-sqlite backend/server.mjs >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 30); do
  grep -q "backend listening on" "$LOG" && break
  sleep 0.5
done

echo "===== STARTUP LOG ====="
grep -vE "ExperimentalWarning|trace-warnings" "$LOG"
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
