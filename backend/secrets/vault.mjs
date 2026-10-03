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
export function redactSecrets(value, secrets = []) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets.filter(Boolean)) text = text.split(String(secret)).join('[REDACTED]');
  return text;
}
