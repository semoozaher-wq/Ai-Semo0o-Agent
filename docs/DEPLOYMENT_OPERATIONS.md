# Production Deployment Operations Runbook

## Scope

The repository-level implementation and verification gates are complete for the backend, authentication, tenant isolation, queue, code-run boundary, security helpers, CI, and Chromium web smoke path. The remaining actions in this document are **field deployment operations**, not files that can be activated by default inside the local Sandbox.

## 1. Worker host and Docker smoke gate

Provision a dedicated worker host with Docker, Podman, gVisor, Kata, or a microVM runtime. Do not expose the Docker socket to agent-generated code. Pin and scan the language images used by `execution-core/sandbox.mjs`.

Run the real gate on that host or a Docker-enabled CI runner:

```bash
git checkout -- .
npm ci
npm run test:backend
node --test test/sandbox-runner.test.mjs
git push
# GitHub Actions: workflow_dispatch -> docker-smoke
```

The workflow `.github/workflows/docker-smoke.yml` runs a real JavaScript command inside the sandbox and asserts `network=none` and `isolated=true`. A failure must block deployment.

## 2. Secrets manager

Create secrets in the host/cloud secret manager, not in Git, Expo, or `.env` committed files:

```text
SECRETS_MASTER_KEY=<32 random bytes encoded as base64 or 64 hex characters>
TAVILY_API_KEY=<server-only Tavily key>
DATABASE_FILE=/var/lib/semo0o/agent.sqlite
ALLOWED_ORIGIN=https://agent.example.com
PORT=8787
```

Rotate `SECRETS_MASTER_KEY` only with a migration procedure that can decrypt and re-encrypt existing secrets. Do not rotate by replacing the variable blindly.

## 3. TLS, domain, and reverse proxy

Point DNS to the reverse proxy, issue an official certificate, replace `agent.example.com` and certificate paths in `infra/nginx.conf`, and validate:

```bash
nginx -t
curl -fsS https://agent.example.com/health
curl -i http://agent.example.com/health   # must redirect to HTTPS
```

Nginx provides TLS termination, HSTS, security headers, and an additional request-rate limit. The Node service must remain bound behind the proxy in production.

## 4. Backend and worker supervision

Install the systemd templates:

```bash
sudo install -m 0644 infra/ai-semo0o-backend.service /etc/systemd/system/
sudo install -m 0644 infra/ai-semo0o-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ai-semo0o-backend ai-semo0o-worker
sudo systemctl status ai-semo0o-backend ai-semo0o-worker
```

Run the HTTP service with `DISABLE_WORKER=1`; the independent worker owns queue execution. Confirm that interrupted runs recover and that only one worker lease is active for a run before enabling horizontal scale.

## 5. Chromium/CDP pool

Provision a browser host or managed browser provider. Keep CDP endpoints private and authenticated. Register the browser runner only on the server side, attach screenshots/DOM/console/network evidence to the run, and execute `.github/workflows/browser-e2e.yml` against the deployed URL. The local `npm run test:browser-smoke` only proves the exported web route renders in Chromium; it does not prove a remote CDP pool.

## 6. Operational acceptance criteria

A deployment is accepted only when all are true:

- `/health` is reachable only through HTTPS and the authenticated proxy.
- Auth registration/login/logout and tenant-isolation tests pass against the deployed database.
- Worker restart recovers a queued/running run without duplicate execution.
- Docker smoke passes on the actual worker host.
- `code.run` returns real evidence or a structured failure; it never returns simulated success.
- Tavily succeeds only when the server secret is present and is never logged.
- Chromium E2E passes against the deployed web route and browser host.
- Backups and restore have been tested.
- Alerts exist for worker death, queue age, failed runs, rate-limit spikes, and secret/configuration failures.
