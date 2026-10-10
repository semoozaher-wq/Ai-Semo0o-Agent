#!/usr/bin/env bash
# Local backend launcher for capturing REAL authenticated screenshots.
# Development posture: permissive env validation, public registration enabled,
# CORS locked to the static preview origin.
set -euo pipefail

export NODE_ENV=development
export PORT="${PORT:-8787}"
export SECRETS_MASTER_KEY="$(cat /tmp/semo0o/master.key)"
export DATABASE_FILE=/tmp/semo0o/agent.sqlite
export WORKSPACE_ROOT=/tmp/semo0o/workspace
export ALLOW_PUBLIC_REGISTRATION=true
export ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-http://localhost:8080}"
export PUBLIC_APP_URL="${PUBLIC_APP_URL:-http://localhost:8080}"
# Screenshot capture performs many rapid page loads from one IP; lift the
# per-IP fixed-window limiter (production default stays 120/min) so the
# authenticated session is not 429'd mid-capture.
export RATE_LIMIT_MAX="${RATE_LIMIT_MAX:-100000}"

exec node --experimental-sqlite backend/server.mjs
