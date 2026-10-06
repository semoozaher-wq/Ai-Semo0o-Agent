#!/usr/bin/env bash
# =============================================================================
# scripts/boot-smoke.sh
# -----------------------------------------------------------------------------
# Boots the REAL backend server (node:sqlite + the production env contract) and
# exercises the core E2E path:
#
#   boot -> /health (liveness) -> /ready (readiness)
#        -> POST /auth/register (auth) -> GET /tools/status (authenticated API)
#
# Exits non-zero on any failure. Used by CI (.github/workflows/quality.yml) and
# runnable locally:  bash scripts/boot-smoke.sh
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-8794}"
BIND_HOST="${BIND_HOST:-127.0.0.1}"
TMP="$(mktemp -d)"

export NODE_ENV=production
# A real secret is used when one is provided; otherwise a throwaway CI-only value.
export SECRETS_MASTER_KEY="${SECRETS_MASTER_KEY:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}"
export DATABASE_FILE="${DATABASE_FILE:-$TMP/db/agent.sqlite}"
export WORKSPACE_ROOT="${WORKSPACE_ROOT:-$TMP/workspace}"
export ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-https://ci.invalid}"
export PORT BIND_HOST
export DISABLE_WORKER="${DISABLE_WORKER:-1}"

mkdir -p "$(dirname "$DATABASE_FILE")" "$WORKSPACE_ROOT"

SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

node --experimental-sqlite backend/server.mjs > "$TMP/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 40); do
  curl -sf "http://${BIND_HOST}:${PORT}/health" >/dev/null && break
  sleep 0.5
done

echo "== /health =="
curl -sf "http://${BIND_HOST}:${PORT}/health"; echo
echo "== /ready (503 expected without an LLM provider) =="
curl -s -w '\nHTTP %{http_code}\n' "http://${BIND_HOST}:${PORT}/ready"

echo "== POST /auth/register (E2E auth) =="
REG="$(curl -sf -X POST "http://${BIND_HOST}:${PORT}/auth/register" \
  -H 'content-type: application/json' \
  -d '{"email":"ci-smoke@example.com","password":"ci-smoke-password-123","tenantName":"CI Smoke"}')"
TOKEN="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).session.token)' "$REG")"
echo "session token issued (length ${#TOKEN})"

echo "== GET /tools/status (authenticated) =="
curl -sf "http://${BIND_HOST}:${PORT}/tools/status" -H "authorization: Bearer ${TOKEN}" | head -c 300; echo

echo "BOOT SMOKE OK"
