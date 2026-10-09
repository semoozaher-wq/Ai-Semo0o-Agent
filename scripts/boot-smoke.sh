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
# This smoke gate boots the server with NODE_ENV=production (to exercise the real
# production env contract) and then registers a throwaway account. Production is
# fail-closed for self-service sign-up unless explicitly opted in, so the harness
# opts in here. This is a TEST-ONLY switch: it does not change the production
# default (which stays closed unless the operator sets ALLOW_PUBLIC_REGISTRATION).
export ALLOW_PUBLIC_REGISTRATION="${ALLOW_PUBLIC_REGISTRATION:-1}"
export PORT BIND_HOST
export DISABLE_WORKER="${DISABLE_WORKER:-1}"

# The DB client requires the database DIRECTORY to be private (mode 0700). A
# directory pre-created by a plain `mkdir -p` inherits the umask (0755), which
# makes the client REJECT the configured DATABASE_FILE and silently fall back to
# the shared repo DB (backend/data/agent.sqlite). That is neither hermetic nor
# idempotent: a second smoke run then hits EMAIL_ALREADY_REGISTERED (409) and the
# gate fails spuriously. Create the DB directory with the exact mode the client
# enforces so the configured (throwaway) path is always the one actually used.
mkdir -p "$WORKSPACE_ROOT"
DB_DIR="$(dirname "$DATABASE_FILE")"
mkdir -p "$DB_DIR"
chmod 700 "$DB_DIR"

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
# Capture the full response first, then print a preview. Piping curl straight
# into `head` makes curl exit 23 (CURLE_WRITE_ERROR / EPIPE) as soon as `head`
# closes the pipe; under `set -o pipefail` that aborted this smoke gate even
# though every step had succeeded. Reading into a variable avoids the SIGPIPE.
TOOLS_STATUS="$(curl -sf "http://${BIND_HOST}:${PORT}/tools/status" -H "authorization: Bearer ${TOKEN}")"
printf '%s\n' "${TOOLS_STATUS:0:300}"

echo "BOOT SMOKE OK"
