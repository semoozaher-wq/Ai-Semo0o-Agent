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
DATABASE_FILE=./data/agent.sqlite PORT=8787 npm run start:backend

# Run the durable worker as a separate supervised process.
DATABASE_FILE=./data/agent.sqlite npm run start:worker
```

The service binds to `0.0.0.0` for container deployment. Put TLS, rate limiting, secret management, and an authenticated reverse proxy in front of it in production.

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

## Security rules

- Sessions are opaque random tokens; only SHA-256 hashes are stored.
- Passwords use Node scrypt and a minimum 12-character policy.
- Every project, workspace, task, run, and evidence query is tenant-scoped.
- Dangerous runs may begin in `waiting_approval`; denial transitions to `blocked`.
- Queue transitions are explicit and bounded; no infinite retry loop is present.
- Evidence is stored with a content hash and linked to the run.
- Code execution still requires a backend host with Docker/Podman/gVisor/Kata/microVM. If no runtime is available, the run fails with evidence rather than succeeding falsely.

## Current limits

The repository includes deployable templates under `infra/` for Nginx TLS reverse proxying and systemd supervision, plus GitHub workflows for Docker and Chromium smoke tests. The local `npm run test:browser-smoke` command executes Chromium against the exported `/chat` route.

Live Docker execution, Chromium/CDP pooling, external queue replacement, and secret-manager integration still require deployment infrastructure. The service fails closed when those runtimes are unavailable.
