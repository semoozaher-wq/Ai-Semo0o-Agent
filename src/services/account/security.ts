/**
 * Account-security pure helpers.
 *
 * These functions are intentionally dependency-free (no react-native, no fetch)
 * so the exact logic the Settings UI relies on can be unit-tested in isolation.
 * They cover the three user-facing security operations:
 *
 *   1. Two-factor (TOTP) enrollment — turning the server-issued secret into a
 *      scannable `otpauth://` URI and classifying what the user typed as a
 *      6-digit authenticator code vs. a 16-char recovery code vs. garbage.
 *   2. Data export — a stable, filesystem-safe filename and a human summary of
 *      how many records each section contains.
 *   3. Account deletion — the typed-email confirmation check that gates the
 *      destructive request (the backend enforces it too; this is the UX guard).
 */

/** What `POST /auth/mfa/setup` returns: the secret to enroll + one-time codes. */
export interface MfaSetupInfo {
  secret: string;
  recoveryCodes: string[];
  enabled: boolean;
}

export type MfaCodeKind = 'totp' | 'recovery' | 'invalid';

const TOTP_RE = /^\d{6}$/;
const RECOVERY_RE = /^[A-F0-9]{16}$/;

/**
 * Normalise user input for a second factor: drop the spaces/dashes people type
 * when copying a code, and upper-case it (recovery codes are hex). TOTP codes
 * are digits, so upper-casing is a no-op for them.
 */
export function normalizeMfaCode(input: string): string {
  return String(input ?? '').replace(/[\s-]/g, '').toUpperCase();
}

/** Classify a typed second factor so the UI can label the field correctly. */
export function classifyMfaCode(input: string): MfaCodeKind {
  const normalized = normalizeMfaCode(input);
  if (TOTP_RE.test(normalized)) return 'totp';
  if (RECOVERY_RE.test(normalized)) return 'recovery';
  return 'invalid';
}

/** True when the input is a well-formed TOTP code OR recovery code. */
export function isValidMfaCode(input: string): boolean {
  return classifyMfaCode(input) !== 'invalid';
}

/**
 * Build the `otpauth://totp/...` URI an authenticator app consumes (the same
 * format Google Authenticator, 1Password, Authy, etc. understand). The server
 * uses SHA1 / 6 digits / 30-second period, so those parameters are pinned here
 * to match `backend/auth/lifecycle.mjs` exactly — a mismatch would make every
 * generated code invalid.
 */
export function buildOtpAuthUrl({
  secret,
  account,
  issuer = 'Semo AI',
}: {
  secret: string;
  account: string;
  issuer?: string;
}): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: normalizeMfaCode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Group a raw recovery code into readable 4-char blocks (e.g. A1B2-C3D4-...). */
export function formatRecoveryCode(code: string): string {
  return normalizeMfaCode(code).replace(/(.{4})(?=.)/g, '$1-');
}

/** Join all recovery codes, one per line, for copy/print. */
export function formatRecoveryCodes(codes: string[]): string {
  return codes.map(formatRecoveryCode).join('\n');
}

/** A filesystem-safe export filename, e.g. `semo0o-export-user-example-com-2024-05-01.json`. */
export function exportFilename(email: string, date: Date = new Date()): string {
  const safe = String(email ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'account';
  const stamp = date.toISOString().slice(0, 10);
  return `semo0o-export-${safe}-${stamp}.json`;
}

export interface ExportSummary {
  sections: { name: string; count: number }[];
  totalRecords: number;
}

/**
 * Summarise an export payload by counting the array-valued sections (runs,
 * messages, conversations, …). Non-array keys (the user object, timestamps) are
 * ignored so the count reflects real records, not metadata.
 */
export function summarizeExport(payload: Record<string, unknown> | null | undefined): ExportSummary {
  const sections: { name: string; count: number }[] = [];
  let totalRecords = 0;
  for (const [name, value] of Object.entries(payload ?? {})) {
    if (Array.isArray(value)) {
      sections.push({ name, count: value.length });
      totalRecords += value.length;
    }
  }
  return { sections, totalRecords };
}

/**
 * The destructive-delete gate: the user must type their exact email. Case- and
 * whitespace-insensitive so it is forgiving to type but still deliberate. The
 * backend re-checks this (`DELETE_CONFIRMATION_REQUIRED`), so this is purely the
 * client-side guard that keeps the button disabled until the intent is explicit.
 */
export function isDeleteConfirmationValid(typed: string, email: string): boolean {
  return String(typed ?? '').trim().toLowerCase() === String(email ?? '').trim().toLowerCase();
}
