# =============================================================================
# backend/Dockerfile — portable deployment for the Ai-Semo0o-Agent backend.
# Works on Fly.io, Railway, Render (Docker), Google Cloud Run, or any VPS.
# =============================================================================
# The backend uses ONLY Node.js built-in modules (node:http, node:sqlite,
# node:crypto, ...) and relative files — it has NO npm dependencies. That is
# why there is no `npm install` step below.
#
# Build (from the repository root):
#   docker build -f backend/Dockerfile -t ai-semo0o-backend .
#
# Run:
#   docker run -p 8787:8787 \
#     -e SECRETS_MASTER_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" \
#     -e ALLOWED_ORIGIN="https://your-app.vercel.app" \
#     -v ai_semo0o_data:/data \
#     ai-semo0o-backend
# =============================================================================
FROM node:22.11.0-bookworm-slim

# node:sqlite is experimental in Node 22 -> it must be enabled with a flag.
ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_FILE=/data/db/agent.sqlite \
    WORKSPACE_ROOT=/data/workspace \
    DISABLE_WORKER=0

WORKDIR /app

# The backend statically imports shared runtime modules that live OUTSIDE
# backend/, so they must be copied too (preserving the relative layout):
#   backend/tools/registry.mjs      -> ../../execution-core/tavily-search.mjs
#   backend/runners/code-runner.mjs -> ../../execution-core/code-run-tool.mjs
#   backend/browser/pool.mjs        -> ../../phase2-core/browser-agent.mjs
#   backend/browser/runner.mjs      -> ../../phase2-core/browser-agent.mjs
# Copying only backend/ makes the container crash at boot with
# ERR_MODULE_NOT_FOUND before it can ever bind a port.
COPY backend ./backend
COPY execution-core ./execution-core
COPY phase2-core ./phase2-core

# Persistent, writable location for the SQLite DB + workspace.
RUN mkdir -p /data/db /data/workspace
VOLUME ["/data"]

EXPOSE 8787

# SECRETS_MASTER_KEY and ALLOWED_ORIGIN must be provided at runtime
# (production env validation refuses to boot without them).
CMD ["node", "--experimental-sqlite", "backend/server.mjs"]
