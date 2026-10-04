import bcrypt from 'bcryptjs';
import { sql } from './connection.js';

const LEGACY_DEMO_USERS = [
  'admin', 'operator', 'teacher', 'dr_ayesha',
  'PE1-1001', 'PE1-1002', 'PE1-1003', 'PM1-1001', 'CS1-1001',
];
const LEGACY_PASSWORD = 'password123';
const MIGRATION_NAME = 'force-legacy-demo-password-change-v1';

/**
 * Existing production databases may have been seeded before production seeding was disabled.
 * Force only accounts still using the known demo password to change it, and revoke old tokens.
 */
export const forceLegacyDemoPasswordChange = async () => {
  const [applied] = await sql`SELECT 1 FROM security_migrations WHERE name = ${MIGRATION_NAME}`;
  if (applied) return;

  const usernames = await sql`
    SELECT id, username, password_hash
    FROM users
    WHERE username IN ('admin', 'operator', 'teacher', 'dr_ayesha', 'PE1-1001', 'PE1-1002', 'PE1-1003', 'PM1-1001', 'CS1-1001')
      AND must_change_pw = FALSE
  `;

  for (const user of usernames) {
    if (!(await bcrypt.compare(LEGACY_PASSWORD, user.password_hash))) continue;
    await sql`
      UPDATE users
      SET must_change_pw = TRUE, token_version = token_version + 1
      WHERE id = ${user.id} AND must_change_pw = FALSE
    `;
  }

  // Insert last. If startup fails before here, the idempotent updates can safely be retried.
  await sql`INSERT INTO security_migrations (name) VALUES (${MIGRATION_NAME}) ON CONFLICT DO NOTHING`;
};
