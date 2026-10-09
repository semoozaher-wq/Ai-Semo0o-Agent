/**
 * First-owner bootstrap from environment variables (`backend/auth/bootstrap.mjs`).
 *
 * A private deployment closes self-service sign-up, so the operator needs a way
 * to create the very first account. The CLI (`scripts/create-admin.mjs`) covers
 * the shell case; this module covers the "set two variables in the host
 * dashboard" case (Render, etc.). These tests prove it is opt-in, idempotent,
 * never destructive, and that a half-configured bootstrap fails closed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../db/client.mjs';
import { authenticate } from '../auth/security.mjs';
import { bootstrapFirstOwner } from '../auth/bootstrap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function withDb(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'semo-boot-'));
  try {
    return fn(new Database(path.join(dir, 'agent.sqlite')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('bootstrap is a no-op when nothing is configured', () => {
  withDb((db) => {
    const result = bootstrapFirstOwner(db, {});
    assert.equal(result.created, false);
    assert.equal(result.reason, 'NOT_CONFIGURED');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM users').n, 0);
    db.close();
  });
});

test('bootstrap creates a verified owner that can sign in with verification required', () => {
  withDb((db) => {
    const result = bootstrapFirstOwner(db, {
      BOOTSTRAP_ADMIN_EMAIL: 'boss@example.com',
      BOOTSTRAP_ADMIN_PASSWORD: 'a-very-long-password-123',
    });
    assert.equal(result.created, true);
    assert.equal(result.user.email, 'boss@example.com');
    assert.equal(result.user.role, 'owner');

    const row = db.get('SELECT email, role, email_verified_at FROM users WHERE lower(email)=lower(?)', 'boss@example.com');
    assert.equal(row.role, 'owner');
    assert.ok(row.email_verified_at, 'address marked verified');
    // Usable even when the deployment requires email verification.
    const session = authenticate(db, 'boss@example.com', 'a-very-long-password-123', undefined, { requireEmailVerification: true });
    assert.ok(session.session.token);
    db.close();
  });
});

test('bootstrap never touches a database that already has accounts', () => {
  withDb((db) => {
    assert.equal(bootstrapFirstOwner(db, { BOOTSTRAP_ADMIN_EMAIL: 'first@example.com', BOOTSTRAP_ADMIN_PASSWORD: 'a-very-long-password-123' }).created, true);
    const second = bootstrapFirstOwner(db, { BOOTSTRAP_ADMIN_EMAIL: 'second@example.com', BOOTSTRAP_ADMIN_PASSWORD: 'a-very-long-password-123' });
    assert.equal(second.created, false);
    assert.equal(second.reason, 'USERS_EXIST');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM users').n, 1, 'no second account created');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM users WHERE lower(email)=lower(?)', 'second@example.com').n, 0);
    db.close();
  });
});

test('bootstrap fails closed on a half-configured or policy-violating request', () => {
  withDb((db) => {
    assert.throws(() => bootstrapFirstOwner(db, { BOOTSTRAP_ADMIN_EMAIL: 'x@example.com' }), /BOOTSTRAP_ADMIN_PASSWORD_MISSING/);
    assert.throws(() => bootstrapFirstOwner(db, { BOOTSTRAP_ADMIN_PASSWORD: 'a-very-long-password-123' }), /BOOTSTRAP_ADMIN_EMAIL_MISSING/);
    assert.throws(() => bootstrapFirstOwner(db, { BOOTSTRAP_ADMIN_EMAIL: 'not-an-email', BOOTSTRAP_ADMIN_PASSWORD: 'a-very-long-password-123' }), /BOOTSTRAP_ADMIN_EMAIL_INVALID/);
    assert.throws(() => bootstrapFirstOwner(db, { BOOTSTRAP_ADMIN_EMAIL: 'x@example.com', BOOTSTRAP_ADMIN_PASSWORD: 'short' }), /PASSWORD_POLICY_FAILED/);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM users').n, 0, 'nothing written on failure');
    db.close();
  });
});
