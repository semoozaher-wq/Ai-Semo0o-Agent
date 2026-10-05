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

# Only the backend tree is needed at runtime.
COPY backend ./backend

# Persistent, writable location for the SQLite DB + workspace.
RUN mkdir -p /data/db /data/workspace
VOLUME ["/data"]

EXPOSE 8787

# SECRETS_MASTER_KEY and ALLOWED_ORIGIN must be provided at runtime
# (production env validation refuses to boot without them).
CMD ["node", "--experimental-sqlite", "backend/server.mjs"]
