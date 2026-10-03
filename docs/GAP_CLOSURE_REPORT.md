# Production Gap Closure Report

## Implemented in this pass

The remaining repository-level gaps were implemented as real code and deployable configuration rather than placeholder files.

| Gap | Delivered |
|---|---|
| Client API boundary | `src/services/api/client.ts` with backend URL configuration, auth session, projects, runs, approvals, and cancellation methods |
| Supervised worker | `backend/worker.mjs`, `npm run start:worker`, and systemd unit template |
| Rate limiting | Bounded IP limiter in `backend/security/http.mjs` and Nginx `limit_req` configuration |
| HTTP hardening | CSP, HSTS at proxy, no-store, nosniff, frame denial, strict CORS origin check |
| Tool connectivity | `backend/tools/registry.mjs` distinguishes live tools (`web.search` when `TAVILY_API_KEY` exists and `code.run`) from catalog-only tools; no simulated tools are reported |
| Web search | Existing Tavily adapter is discoverable through the server registry; missing key remains a hard failure |
| Browser E2E | `scripts/browser-smoke.mjs` runs real Chromium against exported `/chat`; CI workflow added |
| Docker smoke | CI workflow added to run a real Docker container on Docker-enabled GitHub runners |
| TLS/reverse proxy | `infra/nginx.conf` with HTTPS redirect, certificate paths, HSTS, proxy headers, and rate limit |
| Process supervision | `infra/ai-semo0o-backend.service` and `infra/ai-semo0o-worker.service` |
| CI/CD | General CI, security, Docker smoke, and Chromium smoke workflows |
| Security regression | Existing SSRF/path/secret tests plus backend tenant/auth/approval tests |

## Verification

- `npm test`: PASS — 80/80 harness, 28/28 execution, 14/14 Phase 1.
- `npm run test:phase2`: PASS — 11/11.
- `npm run test:backend`: PASS — 7/7.
- `npm run test:browser-smoke`: PASS — real Chromium rendered `/chat` successfully.
- `npm run typecheck`: PASS.
- `npm run lint`: PASS.
- `npm run build`: PASS.

## Items that cannot be truthfully completed inside this Sandbox

The current execution device has no Docker/Podman daemon. Therefore no live container run is claimed here; `.github/workflows/docker-smoke.yml` is the real execution gate for a Docker-enabled CI/worker host. The backend fails closed and persists failure evidence when no runner exists.

A managed external Secret Manager, public TLS certificate, DNS, reverse-proxy deployment, persistent worker host, and real Chromium/CDP browser pool are deployment operations. Templates and CI gates are included, but credentials and external infrastructure cannot be invented or activated from the repository alone.

## Deployment sequence

1. Set `DATABASE_FILE`, `SECRETS_MASTER_KEY`, `TAVILY_API_KEY`, `ALLOWED_ORIGIN`, and `PORT` in a server secret manager.
2. Run the HTTP service with `DISABLE_WORKER=1` under `ai-semo0o-backend.service`.
3. Run `backend/worker.mjs` under `ai-semo0o-worker.service`.
4. Put Nginx/HTTPS in front using `infra/nginx.conf`.
5. Run the Docker smoke workflow on the worker host.
6. Set `EXPO_PUBLIC_BACKEND_URL` for the Expo client and migrate UI flows to `backendApi` session methods.
7. Connect a real Chromium/CDP pool before enabling browser tools.
