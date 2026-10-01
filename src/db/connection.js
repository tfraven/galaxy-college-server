import { neon } from '@neondatabase/serverless';
import { config } from '../config/index.js';

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL environment variable is not set. Please add your Neon connection string to server/.env');
}

// Tagged template literal SQL executor (Neon serverless HTTP transport)
// Usage: await sql`SELECT * FROM users WHERE id = ${userId}`
export const sql = neon(config.databaseUrl);

export default sql;
