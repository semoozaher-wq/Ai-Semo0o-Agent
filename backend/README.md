# Production Backend Foundation

This directory contains a real Node 22 backend foundation for Ai-Semo0o-Agent. It is intentionally server-only and must not be imported into the Expo client.

## Components

- `db/schema.sql`: tenant-scoped SQLite schema with migrations and indexes.
- `db/client.mjs`: SQLite adapter with WAL mode, foreign keys, transactions, and migration bootstrap.
- `auth/security.mjs`: scrypt password hashing, opaque hashed sessions, expiry, revocation, roles, and tenant checks.
- `server.mjs`: authenticated HTTP API for health, auth, projects, workspaces, runs, approvals, pause/resume/cancel, and evidence retrieval.
- `queue/queue.mjs`: SQLite-backed durable run queue with recovery of interrupted `running` jobs and state transitions.
- `runners/code-runner.mjs`: server code-run handler that persists sandbox evidence and never converts a failed run into success.
- `worker.mjs`: independently supervised queue worker entrypoint.
- `security/http.mjs`: bounded IP rate limiting and security headers.
- `tools/registry.mjs`: explicit live-versus-unwired tool registry.
- `browser/runner.mjs`: server-only CDP runner boundary.
- `test/backend.test.mjs`: integration tests for auth, tenant isolation, approvals, queue execution, and evidence persistence.

## Run

```bash
DATABASE_FILE=./.data/agent.sqlite WORKSPACE_ROOT=./.data/workspaces PORT=8787 npm run start:backend

# Run the durable worker as a separate supervised process.
DATABASE_FILE=./.data/agent.sqlite npm run start:worker
```

The standalone service defaults to loopback binding; set `BIND_HOST=0.0.0.0` only behind an authenticated TLS reverse proxy. The default database is `./.data/agent.sqlite`; the database directory must not be group/world accessible and the database file is forced to `0600`. Production systemd units create `/var/lib/semo0o` as a private `0700` state directory and apply `UMask=0077` so SQLite WAL/SHM files remain private. The service does not load `.env` files: inject settings through the process supervisor or secret manager. Production project roots are derived by the backend as `<WORKSPACE_ROOT>/<projectId>`; callers cannot select arbitrary host paths. Put TLS, rate limiting, secret management, and an authenticated reverse proxy in front of it in production.

## SQLite archive operations

Create a consistent snapshot using SQLite `VACUUM INTO`, verify an archive, or restore it to a **new** database file (the tool never overwrites an existing file):

```bash
npm run db:backup -- /var/lib/ai-semo0o/agent.sqlite /var/backups/ai-semo0o/agent-2026-10-04.sqlite
npm run db:verify -- /var/backups/ai-semo0o/agent-2026-10-04.sqlite
npm run db:restore -- /var/backups/ai-semo0o/agent-2026-10-04.sqlite /var/lib/ai-semo0o/restore-candidate/agent.sqlite
```

The tool validates `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, and required application tables, emits a SHA-256 digest, and creates archive files with mode `0600` inside a directory with no group/other permissions. Test the restored candidate before stopping the service and changing `DATABASE_FILE`. This utility does **not** schedule backups, encrypt/off-site them, implement retention, or replace a production restore rehearsal; those remain deployment responsibilities.

## API outline

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/logout`
- `POST /projects`
- `GET /projects/:id`
- `POST /runs`
- `GET /runs/:id`
- `POST /runs/:id/approval` with `allow`, `deny`, or `cancel`
- `POST /runs/:id/pause`
- `POST /runs/:id/resume`
- `POST /runs/:id/cancel`
- `GET /health`
- `GET /tools/status`
- `GET /models/status`
- `POST /projects/:id/memory` with `{source,content}`
- `GET /projects/:id/memory?q=...`
- `GET /projects/:id/memory/export`
- `POST /projects/:id/memory/reindex`
- `DELETE /projects/:id/memory` (owner/admin)
- `GET /me/export`
- `DELETE /me` with `{confirmEmail}`

## Security rules

- Sessions are opaque random tokens; only SHA-256 hashes are stored.
- Passwords use Node scrypt and a minimum 12-character policy.
- Every project, workspace, task, run, and evidence query is tenant-scoped.
- Dangerous runs may begin in `waiting_approval`; denial transitions to `blocked`.
- Queue transitions are explicit and bounded; no infinite retry loop is present.
- Evidence is stored with a content hash and linked to the run.
- Code execution still requires a backend host with Docker/Podman/gVisor/Kata/microVM. If no runtime is available, the run fails with evidence rather than succeeding falsely.
- Agent runs enforce bounded steps, tool calls, retries, tokens, wall-clock time, cost, and duplicate-call loop detection. Configure with `AGENT_MAX_STEPS`, `AGENT_MAX_TOOL_CALLS`, `AGENT_MAX_RETRIES`, `AGENT_MAX_TOKENS`, `AGENT_MAX_COST_USD`, and `AGENT_TIMEOUT_MS`.
- API rate limiting defaults to a SQLite-backed fixed window shared by API processes using the same database. Set `RATE_LIMIT_MAX` per deployment.
- The server model contract is defined in `backend/models/catalog.mjs`; UI aliases are normalized and unknown model IDs are rejected.

## Current limits

The repository includes deployable templates under `infra/` for Nginx TLS reverse proxying and systemd supervision, plus GitHub workflows for Docker and Chromium smoke tests. The local `npm run test:browser-smoke` command executes Chromium against the exported `/chat` route.

Live Docker execution, Chromium/CDP pooling, external queue replacement, and secret-manager integration still require deployment infrastructure. The service fails closed when those runtimes are unavailable.
