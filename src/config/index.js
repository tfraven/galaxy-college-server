import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from the server root directory (server/.env)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const isProd = process.env.NODE_ENV === 'production';
const jwtSecret = process.env.JWT_SECRET || '';

// A guessable fallback secret in production means anyone can forge an admin token.
if (isProd && jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be set to a random string of at least 32 characters in production.');
}

export const config = {
  isProd,
  port: parseInt(process.env.PORT || '5000', 10),
  jwtSecret: jwtSecret || 'dev-only-insecure-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  databaseUrl: process.env.DATABASE_URL || '',
  // Comma separated list. Empty = allow all (fine for a mobile app + dev).
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Dev-only escape hatch for the old "log in with roll number only" behaviour. Ignored in production.
  allowPasswordlessLogin: !isProd && process.env.ALLOW_PASSWORDLESS_LOGIN === 'true',
  zoom: {
    // Must be the Video SDK SDK Key + SDK Secret, not OAuth Client ID/Secret, API keys, or Meeting SDK credentials.
    sdkKey: process.env.ZOOM_SDK_KEY || '',
    sdkSecret: process.env.ZOOM_SDK_SECRET || '',
  },
};
