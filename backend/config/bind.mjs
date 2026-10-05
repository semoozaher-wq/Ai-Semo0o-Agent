/**
 * Decide which interface the HTTP server must bind to.
 *
 * Render (and every other container host: Railway, Fly.io, Cloud Run, ...) injects
 * `PORT` and requires the process to bind `0.0.0.0` so its router and port-scanner
 * can reach it. Binding to `127.0.0.1`/`localhost` makes the service unreachable
 * from outside and produces Render's "No open ports detected on 0.0.0.0 ...
 * Detected open ports on localhost" error.
 *
 * Rules:
 *   - On Render (RENDER=true / RENDER_SERVICE_ID / RENDER_EXTERNAL_URL) we FORCE
 *     `0.0.0.0`, regardless of BIND_HOST, so a stray loopback value can never
 *     break the deployment.
 *   - Otherwise, whenever `PORT` is present we also default to `0.0.0.0` (this is
 *     how every hosted platform signals "bind publicly").
 *   - A plain local run (no PORT, no RENDER) keeps the safer loopback default,
 *     and `BIND_HOST` can still override it explicitly.
 */
export function resolveBindHost(env = process.env) {
  const onRender = env.RENDER === 'true' || Boolean(env.RENDER_SERVICE_ID) || Boolean(env.RENDER_EXTERNAL_URL);
  if (onRender) return '0.0.0.0';
  if (env.BIND_HOST) return env.BIND_HOST;
  return env.PORT ? '0.0.0.0' : '127.0.0.1';
}
