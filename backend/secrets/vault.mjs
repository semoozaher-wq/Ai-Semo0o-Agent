import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function masterKey() {
  const raw = process.env.SECRETS_MASTER_KEY;
  if (!raw) throw new Error('SECRETS_MASTER_KEY_REQUIRED');
  const key = Buffer.from(raw, /^[0-9a-f]{64}$/i.test(raw) ? 'hex' : 'base64');
  if (key.length !== 32) throw new Error('SECRETS_MASTER_KEY_MUST_BE_32_BYTES');
  return key;
}
export function encryptSecret(value) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}
export function decryptSecret(encoded) {
  const [ivRaw, tagRaw, dataRaw] = String(encoded).split('.');
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataRaw, 'base64url')), decipher.final()]).toString('utf8');
}
export function secretFingerprint(value) { return createHash('sha256').update(String(value)).digest('hex'); }

// ===========================================================================
// Secret redaction
// ---------------------------------------------------------------------------
// Two complementary layers, applied before ANY untrusted value is persisted
// (evidence, tool_calls, run_events, audit_logs, checkpoint_json, result_json):
//
//   1. known-value redaction  -> exact values of configured secrets (env keys)
//   2. shape redaction        -> high-signal secret formats (API keys, JWTs,
//                                Bearer tokens, private keys, DSN passwords)
//
// Shape redaction is always on, so even an unconfigured/unknown secret that
// leaks through a tool result is scrubbed. Known-value redaction catches opaque
// secrets that have no recognisable shape.
// ===========================================================================

/** Recognisable secret shapes. Order matters: most specific first. */
const SECRET_PATTERNS = Object.freeze([
  // PEM private keys (multi-line).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  // Provider API keys.
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  // Authorization headers.
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer [REDACTED]'],
  // Connection strings with an inline password.
  [/((?:mongodb|postgres|postgresql|mysql|redis|rediss|amqp|amqps):\/\/[^:@\s/]+:)[^@\s/]+(@)/gi, '$1[REDACTED]$2'],
  // `key: value` / `key=value` where the key names a credential.
  [/((?:authorization|api[_-]?key|apikey|access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|token|password|passwd|pwd|client[_-]?secret)\s*["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-./+=]{8,}/gi, '$1[REDACTED]'],
]);

/**
 * Object keys whose value is always a credential. Anchored so that unrelated
 * keys such as `totalTokens` / `promptTokens` are never touched.
 */
const SENSITIVE_KEY = /^(?:pass(?:word|wd)?|pwd|secret|secrets|token|tokens|api[_-]?key|apikey|access[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|auth|authorization|credential|credentials|client[_-]?secret|private[_-]?key|secret[_-]?key|x[_-]?api[_-]?key|cookie|set[_-]?cookie|session[_-]?id)$/i;

/** Env var names that always hold a secret, regardless of suffix heuristics. */
const SENSITIVE_ENV_NAMES = Object.freeze([
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'SECRETS_MASTER_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'GITHUB_TOKEN', 'GH_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_TOKEN',
  'DATABASE_URL', 'REDIS_URL', 'STRIPE_SECRET_KEY',
]);

/** Env var names that look like a credential by suffix. */
const SENSITIVE_ENV_PATTERN = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS)$/i;

/**
 * Collect the exact values of configured secrets from the environment so they
 * can be redacted even when they have no recognisable shape. Values shorter
 * than 6 characters are ignored to avoid scrubbing common short strings.
 */
export function collectKnownSecrets(env = process.env) {
  const found = new Set();
  const add = (value) => { const text = String(value ?? ''); if (text.length >= 6) found.add(text); };
  for (const name of SENSITIVE_ENV_NAMES) add(env?.[name]);
  for (const [name, value] of Object.entries(env ?? {})) {
    if (SENSITIVE_ENV_PATTERN.test(name)) add(value);
  }
  return [...found];
}

/** Redact a single string: known values first, then recognisable shapes. */
export function redactString(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets) {
    if (secret) text = text.split(String(secret)).join('[REDACTED]');
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

/**
 * Backwards-compatible string redactor. Accepts a string or any JSON value and
 * always returns a redacted string (the historic contract used by the red-team
 * test). Prefer {@link redactDeep} when the value's structure must be preserved.
 */
export function redactSecrets(value, secrets = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return redactString(text, secrets);
}

/**
 * Structure-preserving redactor: recursively scrubs every string leaf and
 * replaces the value of any credential-named key. Used at every persistence
 * boundary so secrets never reach the database.
 */
export function redactDeep(value, secrets = []) {
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) { out[key] = '[REDACTED]'; continue; }
      out[key] = redactDeep(item, secrets);
    }
    return out;
  }
  return value;
}
