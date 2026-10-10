#!/usr/bin/env bash
# Local backend launcher WITH a local mock LLM provider wired in, so the full
# generation pipeline can be exercised end-to-end when no real provider keys
# exist. The "key" is a clearly-labelled local placeholder — NOT a real secret.
set -euo pipefail
export NODE_ENV=development
export PORT="${PORT:-8787}"
export SECRETS_MASTER_KEY="$(cat /tmp/semo0o/master.key)"
export DATABASE_FILE=/tmp/semo0o/agent.sqlite
export WORKSPACE_ROOT=/tmp/semo0o/workspace
export ALLOW_PUBLIC_REGISTRATION=true
export ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-http://localhost:8090}"
export PUBLIC_APP_URL="${PUBLIC_APP_URL:-http://localhost:8090}"
export RATE_LIMIT_MAX="${RATE_LIMIT_MAX:-100000}"
# --- Local mock LLM (OpenAI-compatible) — NOT a real provider/key ---
export OPENAI_API_KEY="local-mock-not-a-real-key"
export OPENAI_API_BASE="http://127.0.0.1:8790/v1"
export OPENAI_MODEL="gpt-5-mini"
exec node --experimental-sqlite backend/server.mjs
