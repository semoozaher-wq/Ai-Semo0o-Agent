import { createHmac } from 'node:crypto';
import { id, now } from '../db/client.mjs';

// ===========================================================================
// Transactional email outbox.
//
// Account tokens and invitations are written to a durable outbox row instead of
// being claimed as "sent". Delivery happens only through a configured provider
// adapter; with no provider the rows stay 'queued' and the API reports
// EMAIL_PROVIDER_NOT_CONFIGURED — the system never pretends an email was sent.
// ===========================================================================

const MAX_ATTEMPTS = 5;

export const EMAIL_TEMPLATES = Object.freeze({
  email_verification: { subject: 'Verify your Semo AI email address' },
  password_reset: { subject: 'Reset your Semo AI password' },
  invitation: { subject: 'You have been invited to a Semo AI workspace' },
});

function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('INVALID_EMAIL_RECIPIENT');
  return email;
}

export function enqueueEmail(db, { tenantId = null, to, template, subject, body }) {
  if (!EMAIL_TEMPLATES[template]) throw new Error(`INVALID_EMAIL_TEMPLATE:${template}`);
  const recipient = normalizeEmail(to);
  const timestamp = now();
  const outboxId = id('email');
  db.run(
    'INSERT INTO email_outbox(id,tenant_id,to_email,template,subject,body,status,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    outboxId, tenantId, recipient, template, String(subject || EMAIL_TEMPLATES[template].subject), String(body || ''), 'queued', 0, timestamp, timestamp,
  );
  db.run(
    'INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)',
    id('audit'), tenantId, 'email.queued', 'email_outbox', outboxId, JSON.stringify({ template }), timestamp,
  );
  return { outboxId, status: 'queued' };
}

export function listOutbox(db, tenantId, { status, limit = 50 } = {}) {
  const rows = status
    ? db.all('SELECT * FROM email_outbox WHERE tenant_id=? AND status=? ORDER BY created_at DESC LIMIT ?', tenantId, status, Math.min(200, limit))
    : db.all('SELECT * FROM email_outbox WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?', tenantId, Math.min(200, limit));
  return rows.map((row) => ({
    id: row.id, to: row.to_email, template: row.template, subject: row.subject,
    status: row.status, attempts: row.attempts, error: row.error, createdAt: row.created_at, sentAt: row.sent_at,
  }));
}

/**
 * Resolve a provider adapter from the environment. Returns null when nothing is
 * configured (the default, fail-closed posture). The webhook adapter is a real,
 * dependency-free transport suitable for a transactional email gateway.
 */
export function createEmailProvider(env = process.env) {
  const provider = String(env.EMAIL_PROVIDER || '').toLowerCase();
  if (!provider) return null;
  if (provider === 'webhook') {
    const url = env.EMAIL_WEBHOOK_URL;
    if (!url) return null;
    const secret = env.EMAIL_WEBHOOK_SECRET || '';
    return {
      id: 'webhook',
      async send({ to, subject, body, template }) {
        const payload = JSON.stringify({ to, subject, body, template });
        const signature = secret ? createHmac('sha256', secret).update(payload).digest('hex') : '';
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(signature ? { 'x-semo0o-signature': signature } : {}) },
          body: payload,
        });
        if (!response.ok) throw new Error(`EMAIL_WEBHOOK_HTTP_${response.status}`);
        const result = await response.json().catch(() => ({}));
        return { providerId: result.id || result.messageId || null };
      },
    };
  }
  // Unknown provider name: fail closed rather than silently dropping mail.
  return null;
}

/**
 * Drain queued outbox rows through the configured provider. Without a provider
 * this is a no-op that reports the fail-closed state; queued rows are preserved.
 */
export async function processOutbox(db, { env = process.env, limit = 25 } = {}) {
  const provider = createEmailProvider(env);
  const queued = db.all("SELECT * FROM email_outbox WHERE status='queued' ORDER BY created_at ASC LIMIT ?", Math.min(100, limit));
  if (!provider) return { providerConfigured: false, processed: 0, sent: 0, failed: 0, queued: queued.length };
  let sent = 0; let failed = 0;
  for (const row of queued) {
    const timestamp = now();
    try {
      const result = await provider.send({ to: row.to_email, subject: row.subject, body: row.body, template: row.template });
      db.run("UPDATE email_outbox SET status='sent', attempts=attempts+1, provider_id=?, error=NULL, sent_at=?, updated_at=? WHERE id=? AND status='queued'", result.providerId, timestamp, timestamp, row.id);
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = row.attempts + 1;
      const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
      db.run('UPDATE email_outbox SET status=?, attempts=?, error=?, updated_at=? WHERE id=? AND status=\'queued\'', status, attempts, message.slice(0, 500), timestamp, row.id);
      failed += 1;
    }
  }
  return { providerConfigured: true, provider: provider.id, processed: queued.length, sent, failed, queued: queued.length - sent };
}
