// Sentry-compatible error tracking. Parses a Sentry DSN and posts events to the
// store endpoint using the Sentry auth header. The tracker is fail-closed: with
// no DSN configured it returns a no-op so the server never pretends errors are
// being reported when they are not. captureException never throws into the
// request path — reporting must never break serving traffic.

function parseDsn(dsn) {
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const projectId = url.pathname.replace(/^\//, '');
    if (!publicKey || !projectId) return null;
    const storeUrl = `${url.protocol}//${url.host}/api/${projectId}/store/`;
    return { publicKey, projectId, storeUrl, host: url.host };
  } catch {
    return null;
  }
}

function errorToEvent(error, context = {}) {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    event_id: (globalThis.crypto?.randomUUID?.() ?? String(Date.now())).replace(/-/g, ''),
    timestamp: new Date().toISOString(),
    platform: 'node',
    level: context.level || 'error',
    logger: context.logger || 'ai-semo0o-agent',
    environment: context.environment || process.env.NODE_ENV || 'production',
    release: context.release || process.env.SERVICE_VERSION || undefined,
    transaction: context.transaction || undefined,
    tags: context.tags || {},
    extra: context.extra || {},
    exception: {
      values: [{
        type: err.name || 'Error',
        value: err.message,
        stacktrace: err.stack ? { frames: err.stack.split('\n').slice(1).map((line) => ({ filename: line.trim() })) } : undefined,
      }],
    },
  };
}

export function createErrorTracker(env = process.env) {
  const dsn = env.SENTRY_DSN;
  if (!dsn) return null;
  const parsed = parseDsn(dsn);
  if (!parsed) throw new Error('SENTRY_DSN_INVALID');
  const timeoutMs = Number(env.SENTRY_TIMEOUT_MS || 5000);

  return {
    provider: 'sentry',
    host: parsed.host,
    async captureException(error, context = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const event = errorToEvent(error, context);
        await fetch(parsed.storeUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${parsed.publicKey}, sentry_client=ai-semo0o-agent/1.0`,
          },
          body: JSON.stringify(event),
          signal: controller.signal,
          redirect: 'error',
        });
        return event.event_id;
      } catch {
        return null; // reporting failures must never surface to the caller
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function errorTrackerStatus(env = process.env) {
  if (!env.SENTRY_DSN) return { configured: false, provider: null };
  const parsed = parseDsn(env.SENTRY_DSN);
  return parsed ? { configured: true, provider: 'sentry', host: parsed.host } : { configured: false, provider: 'sentry', error: 'SENTRY_DSN_INVALID' };
}
