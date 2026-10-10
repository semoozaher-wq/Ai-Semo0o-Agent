/**
 * Startup environment validation.
 *
 * The server/worker call `assertEnv()` before binding a port or opening the
 * database so that a production process can never start with a dangerous or
 * incomplete configuration (missing secrets, wildcard CORS, relative workspace
 * root, ...). Development and test runs are intentionally permissive.
 */
import path from 'node:path';

const LLM_KEY_VARS = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY'];
const REQUIRED_IN_PRODUCTION = ['SECRETS_MASTER_KEY', 'DATABASE_FILE', 'WORKSPACE_ROOT'];

// Numeric tuning knobs introduced by the scheduler + queue hardening. Each is
// validated so a typo (e.g. `TRIGGER_CONCURRENCY=abc`) is surfaced at boot
// instead of silently collapsing to a default at runtime. `min` is the smallest
// accepted value; `zeroOk` marks knobs where 0 is a meaningful setting (backoff
// disabled).
const NUMERIC_ENV = Object.freeze({
  WORKER_POLL_MS: { min: 1 },
  WORKER_MAX_ATTEMPTS: { min: 1 },
  WORKER_CONCURRENCY: { min: 1 },
  WORKER_LEASE_MS: { min: 10_000 },
  WORKER_RETRY_BACKOFF_MS: { min: 0 },
  WORKER_RETRY_BACKOFF_MAX_MS: { min: 0 },
  TRIGGER_POLL_MS: { min: 1_000 },
  TRIGGER_MAX_PER_TICK: { min: 1 },
  TRIGGER_CONCURRENCY: { min: 1 },
  TRIGGER_MAX_RETRIES: { min: 0 },
  TRIGGER_RETRY_BACKOFF_MS: { min: 0 },
  TRIGGER_RETRY_BACKOFF_MAX_MS: { min: 0 },
});

// Provider-selection vars and the values each accepts. An unrecognised value is
// fail-closed at runtime (no provider is built) which is easy to miss, so it is
// surfaced at boot as a warning.
const PROVIDER_ENV = Object.freeze({
  IMAGE_PROVIDER: ['openai', 'gemini', 'http'],
  VISION_PROVIDER: ['openai', 'gemini'],
  CALENDAR_PROVIDER: ['webhook'],
  EMAIL_PROVIDER: ['resend', 'sendgrid', 'webhook'],
  SLACK_PROVIDER: ['webhook', 'bot'],
  STT_PROVIDER: ['openai', 'gemini', 'http'],
  TTS_PROVIDER: ['openai', 'elevenlabs', 'http'],
  // Video generation is served by three backends (see tools/connectors.mjs):
  //   google    — Veo 3.1 via the Gemini API (text-to-video, image-to-video, extension)
  //   replicate — any pinned video model version
  //   http      — an operator-hosted gateway
  // Video EDITING (video-to-video) is a SEPARATE provider selected by
  // VIDEO_EDIT_PROVIDER and is validated below.
  VIDEO_PROVIDER: ['google', 'replicate', 'http'],
  VIDEO_EDIT_PROVIDER: ['http', 'replicate'],
  AUDIO_PROVIDER: ['http', 'replicate'],
});

function isStrongSecret(value, minBytes) {
  if (typeof value !== 'string' || !value) return false;
  const bytes = /^[0-9a-f]{2,}$/i.test(value) && value.length % 2 === 0 ? value.length / 2 : Buffer.from(value, 'base64').length;
  return bytes >= minBytes;
}

// Validate every present numeric knob. Returns the list of offending var names.
function validateNumericEnv(env) {
  const bad = [];
  for (const [key, { min }] of Object.entries(NUMERIC_ENV)) {
    const raw = env[key];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) bad.push(key);
  }
  return bad;
}

export function validateEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const production = env.NODE_ENV === 'production';

  if (production) {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (!env[key]) errors.push(`MISSING_${key}`);
    }
    if (env.SECRETS_MASTER_KEY && !isStrongSecret(env.SECRETS_MASTER_KEY, 32)) errors.push('SECRETS_MASTER_KEY_MUST_BE_32_BYTES');
    if (env.WORKSPACE_ROOT && !path.isAbsolute(env.WORKSPACE_ROOT)) errors.push('WORKSPACE_ROOT_MUST_BE_ABSOLUTE');
    if (env.DATABASE_FILE && !path.isAbsolute(env.DATABASE_FILE)) errors.push('DATABASE_FILE_MUST_BE_ABSOLUTE');
    if (env.ALLOWED_ORIGIN === '*') errors.push('ALLOWED_ORIGIN_WILDCARD_FORBIDDEN');
    if (!env.ALLOWED_ORIGIN) warnings.push('ALLOWED_ORIGIN_NOT_SET');
    if (env.BILLING_WEBHOOK_SECRET && !isStrongSecret(env.BILLING_WEBHOOK_SECRET, 16)) errors.push('BILLING_WEBHOOK_SECRET_TOO_SHORT');
    if (env.BILLING_PROVIDER && !env.BILLING_WEBHOOK_SECRET) errors.push('BILLING_WEBHOOK_SECRET_REQUIRED');
    if (env.BROWSER_CDP_URL && !/^wss?:\/\//i.test(env.BROWSER_CDP_URL)) errors.push('BROWSER_CDP_URL_INVALID');
    // Private-app gate: a production deployment must not accept open sign-up. It
    // is gated when either APP_ACCESS_KEY is set or ALLOW_PUBLIC_REGISTRATION is
    // explicitly false. A short shared key is flagged (brute-forceable).
    const allowPublicRaw = String(env.ALLOW_PUBLIC_REGISTRATION ?? '').trim().toLowerCase();
    const publicExplicitlyClosed = ['0', 'false', 'no', 'off'].includes(allowPublicRaw);
    if (env.APP_ACCESS_KEY && String(env.APP_ACCESS_KEY).trim().length < 12) errors.push('APP_ACCESS_KEY_TOO_SHORT');
    if (!env.APP_ACCESS_KEY && !publicExplicitlyClosed) warnings.push('PRIVATE_APP_NOT_GATED');
    // Locked-out configuration: sign-up is closed AND no access key is set, so
    // there is no self-service way in. That is a valid private posture, but the
    // operator must create the first account out-of-band — surface the exact
    // command instead of leaving them stranded.
    if (!env.APP_ACCESS_KEY && publicExplicitlyClosed) warnings.push('NO_SIGNUP_PATH_USE_CREATE_ADMIN');
    if (allowPublicRaw && !['0', '1', 'true', 'false', 'yes', 'no', 'on', 'off'].includes(allowPublicRaw)) warnings.push('UNKNOWN_ALLOW_PUBLIC_REGISTRATION_VALUE');
    // Browser production hardening: an in-process Chromium runs with --no-sandbox
    // (required inside containers) and shares the server's network namespace, so an
    // externally managed CDP fleet is preferred. A plaintext ws:// endpoint to a
    // remote host is also flagged because CDP is unauthenticated.
    if (env.BROWSER_LAUNCH_LOCAL === 'true') warnings.push('BROWSER_LAUNCH_LOCAL_IN_PROCESS');
    if (env.BROWSER_CDP_URL && /^ws:\/\//i.test(env.BROWSER_CDP_URL) && !/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(env.BROWSER_CDP_URL)) warnings.push('BROWSER_CDP_URL_NOT_TLS');
    // Observability: without structured logs an operator cannot trace a production
    // incident back to a request. This is a warning, not a fatal misconfiguration.
    if (!['json', 'pretty'].includes(String(env.LOG_FORMAT ?? '').toLowerCase()) && !env.LOG_LEVEL) warnings.push('LOG_FORMAT_NOT_SET');
  }

  if (!LLM_KEY_VARS.some((key) => env[key])) warnings.push('NO_LLM_PROVIDER_CONFIGURED');
  if (env.TAVILY_API_KEY === '') warnings.push('TAVILY_API_KEY_EMPTY');

  // Numeric tuning knobs: a malformed value is always an error (in every
  // environment) because it means the operator's intent was not applied.
  for (const key of validateNumericEnv(env)) errors.push(`INVALID_NUMERIC_${key}`);

  // Provider selection: an unrecognised name silently disables the connector.
  for (const [key, allowed] of Object.entries(PROVIDER_ENV)) {
    const value = String(env[key] || '').toLowerCase();
    if (value && !allowed.includes(value)) warnings.push(`UNKNOWN_${key}_VALUE`);
  }

  return { ok: errors.length === 0, errors, warnings, production };
}

export function assertEnv(env = process.env) {
  const result = validateEnv(env);
  if (!result.ok) {
    const error = new Error(`ENV_VALIDATION_FAILED:${result.errors.join(',')}`);
    error.code = 'ENV_VALIDATION_FAILED';
    error.errors = result.errors;
    throw error;
  }
  for (const warning of result.warnings) {
    // Warnings are surfaced without leaking values.
    process.emitWarning(`env: ${warning}`, { code: 'ENV_WARNING' });
  }
  return result;
}
