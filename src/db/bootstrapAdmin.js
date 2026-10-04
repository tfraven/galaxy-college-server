import bcrypt from 'bcryptjs';
import { sql } from './connection.js';
import { initSchema } from './schema.js';

const username = (process.env.INITIAL_ADMIN_USERNAME || '').trim();
const fullName = (process.env.INITIAL_ADMIN_NAME || '').trim();
const password = process.env.INITIAL_ADMIN_PASSWORD || '';

const bootstrap = async () => {
  if (!/^[A-Za-z0-9._-]{3,128}$/.test(username)) {
    throw new Error('Set INITIAL_ADMIN_USERNAME to 3–128 letters, numbers, dots, dashes or underscores.');
  }
  if (!fullName || fullName.length > 128) throw new Error('Set INITIAL_ADMIN_NAME (maximum 128 characters).');
  if (password.length < 12 || password.length > 128 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('INITIAL_ADMIN_PASSWORD must be at least 12 characters and no more than 72 UTF-8 bytes.');
  }

  await initSchema();
  const [admin] = await sql`SELECT id FROM users WHERE role = 1 LIMIT 1`;
  if (admin) throw new Error('An administrator already exists; bootstrap can only run on a database without one.');

  const [collision] = await sql`SELECT id FROM users WHERE LOWER(username) = LOWER(${username}) LIMIT 1`;
  if (collision) throw new Error('That username is already in use.');

  const passwordHash = await bcrypt.hash(password, 12);
  const [created] = await sql`
    INSERT INTO users (role, username, password_hash, full_name, is_active, must_change_pw)
    VALUES (1, ${username.toLowerCase()}, ${passwordHash}, ${fullName}, TRUE, FALSE)
    RETURNING id
  `;
  if (!created) throw new Error('Administrator was not created.');
  console.log('Initial administrator account created. Remove the bootstrap environment variables now.');
};

bootstrap().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Administrator bootstrap failed.');
  process.exitCode = 1;
});
