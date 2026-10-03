# Production Backend Foundation

This directory contains a real Node 22 backend foundation for Ai-Semo0o-Agent. It is intentionally server-only and must not be imported into the Expo client.

## Components

- `db/schema.sql`: tenant-scoped SQLite schema with migrations and indexes.
- `db/client.mjs`: SQLite adapter with WAL mode, foreign keys, transactions, and migration bootstrap.
- `auth/security.mjs`: scrypt password hashing, opaque hashed sessions, expiry, revocation, roles, and tenant checks.
- `server.mjs`: authenticated HTTP API for health, auth, projects, workspaces, runs, approvals, pause/resume/cancel, and evidence retrieval.
- `queue/queue.mjs`: SQLite-backed durable run queue with recovery of interrupted `running` jobs and state transitions.
- `runners/code-runner.mjs`: server code-run handler that persists sandbox evidence and never converts a failed run into success.
- `test/backend.test.mjs`: integration tests for auth, tenant isolation, approvals, queue execution, and evidence persistence.

## Run

```bash
DATABASE_FILE=./data/agent.sqlite PORT=8787 npm run start:backend
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

## Security rules

- Sessions are opaque random tokens; only SHA-256 hashes are stored.
- Passwords use Node scrypt and a minimum 12-character policy.
- Every project, workspace, task, run, and evidence query is tenant-scoped.
- Dangerous runs may begin in `waiting_approval`; denial transitions to `blocked`.
- Queue transitions are explicit and bounded; no infinite retry loop is present.
- Evidence is stored with a content hash and linked to the run.
- Code execution still requires a backend host with Docker/Podman/gVisor/Kata/microVM. If no runtime is available, the run fails with evidence rather than succeeding falsely.

## Current limits

This is the first production backend slice, not a claim that every external integration is complete. Browser Chromium pooling, external queue replacement, secret-vault integration, TLS termination, rate limiting, and live Docker CI require deployment infrastructure and are documented as remaining operations in the production gap matrix.
