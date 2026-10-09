/**
 * First-account bootstrap (`scripts/create-admin.mjs`).
 *
 * A private deployment closes self-service sign-up, so the operator needs a
 * deliberate out-of-band way to create the very first owner account. These
 * tests prove that path works end to end and is safe to re-run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../db/client.mjs';
import { authenticate } from '../auth/security.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join('scripts', 'create-admin.mjs');

function runCreateAdmin(dbFile, args) {
  return spawnSync(process.execPath, ['--experimental-sqlite', SCRIPT, ...args], {
    cwd: REPO,
    env: { ...process.env, DATABASE_FILE: dbFile },
    encoding: 'utf8',
  });
}

test('create-admin bootstraps a verified owner that can sign in', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'semo-admin-'));
  try {
    const dbFile = path.join(dir, 'agent.sqlite');
    const result = runCreateAdmin(dbFile, ['owner@example.com', 'supersecretpass123']);
    assert.equal(result.status, 0, result.stderr);

    const db = new Database(dbFile);
    const user = db.get('SELECT email, role, email_verified_at FROM users WHERE lower(email)=lower(?)', 'owner@example.com');
    assert.ok(user, 'owner row exists');
    assert.equal(user.role, 'owner');
    assert.ok(user.email_verified_at, 'address is marked verified');
    // The whole point: the account is usable even when the deployment requires
    // email verification for self-service sign-ups.
    const session = authenticate(db, 'owner@example.com', 'supersecretpass123', undefined, { requireEmailVerification: true });
    assert.ok(session.session.token, 'session issued');
    assert.equal(session.user.role, 'owner');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create-admin refuses to overwrite an existing account', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'semo-admin-'));
  try {
    const dbFile = path.join(dir, 'agent.sqlite');
    assert.equal(runCreateAdmin(dbFile, ['owner@example.com', 'supersecretpass123']).status, 0);
    const second = runCreateAdmin(dbFile, ['owner@example.com', 'anotherlongpass123']);
    assert.notEqual(second.status, 0, 'second run must fail');
    assert.match(second.stderr, /already exists/i);
    const db = new Database(dbFile);
    const count = db.get('SELECT COUNT(*) AS n FROM users WHERE lower(email)=lower(?)', 'owner@example.com').n;
    assert.equal(count, 1, 'exactly one account remains');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create-admin rejects a password shorter than the shared policy', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'semo-admin-'));
  try {
    const dbFile = path.join(dir, 'agent.sqlite');
    const result = runCreateAdmin(dbFile, ['owner@example.com', 'short']);
    assert.notEqual(result.status, 0);
    const db = new Database(dbFile);
    const count = db.get('SELECT COUNT(*) AS n FROM users').n;
    assert.equal(count, 0, 'no account written on policy failure');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
