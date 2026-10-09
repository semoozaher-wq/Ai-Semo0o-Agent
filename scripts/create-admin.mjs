#!/usr/bin/env node
/**
 * Bootstrap the FIRST owner account directly in the database.
 *
 * Why this exists
 * ---------------
 * This platform is a PRIVATE application: in production, open sign-up is closed
 * (`ALLOW_PUBLIC_REGISTRATION=false`) and the deployment may not even set
 * `APP_ACCESS_KEY`. In that configuration there is intentionally NO HTTP path to
 * create an account — which is exactly what we want for outsiders, but it also
 * means the operator needs a deliberate, out-of-band way to create the very
 * first account. That is this script.
 *
 * It writes the owner row directly (bypassing the network gate) and marks the
 * address as verified, so the account can sign in even when
 * `REQUIRE_EMAIL_VERIFICATION=true`.
 *
 * Usage
 * -----
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-passphrase' \
 *     node --experimental-sqlite scripts/create-admin.mjs
 *
 *   # or positionally
 *   node --experimental-sqlite scripts/create-admin.mjs you@example.com 'a-long-passphrase'
 *
 * The password must be at least 12 characters (enforced by the shared policy).
 * Run it on the same host/DB as the backend (or point DATABASE_FILE at the same
 * file) so the account lands in the live database.
 */
import { Database, now } from '../backend/db/client.mjs';
import { createUser } from '../backend/auth/security.mjs';

function parseArgs(argv) {
  const positional = argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const email = String(positional[0] ?? process.env.ADMIN_EMAIL ?? '').trim();
  const password = String(positional[1] ?? process.env.ADMIN_PASSWORD ?? '');
  return { email, password };
}

const { email, password } = parseArgs(process.argv);

if (!email || !password) {
  console.error('Usage:');
  console.error('  ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=\'a-long-passphrase\' node --experimental-sqlite scripts/create-admin.mjs');
  console.error('  node --experimental-sqlite scripts/create-admin.mjs <email> <password>');
  process.exit(2);
}

const db = new Database();
try {
  const existing = db.get('SELECT id FROM users WHERE lower(email)=lower(?)', email);
  if (existing) {
    console.error(`✖ An account already exists for ${email}. Nothing to do.`);
    process.exit(1);
  }
  const user = createUser(db, { email, password, tenantName: `${email} workspace` });
  // Mark the address verified so the account is usable even when the deployment
  // requires email verification for self-service sign-ups.
  db.run('UPDATE users SET email_verified_at=? WHERE id=?', now(), user.id);
  console.log('✅ Created owner account:');
  console.log(`   email  : ${user.email}`);
  console.log(`   role   : ${user.role}`);
  console.log(`   tenant : ${user.tenant_id}`);
  console.log('   You can now sign in with this email and password.');
} catch (error) {
  console.error(`✖ Failed: ${error.code || error.message}`);
  process.exit(1);
} finally {
  db.close();
}
