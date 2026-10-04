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

function isStrongSecret(value, minBytes) {
  if (typeof value !== 'string' || !value) return false;
  const bytes = /^[0-9a-f]{2,}$/i.test(value) && value.length % 2 === 0 ? value.length / 2 : Buffer.from(value, 'base64').length;
  return bytes >= minBytes;
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
