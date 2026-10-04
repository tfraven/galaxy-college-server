import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from the server root directory (server/.env)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const isProd = process.env.NODE_ENV === 'production';
const jwtSecret = process.env.JWT_SECRET || '';
const jwtExpiresIn = process.env.JWT_EXPIRES_IN || (isProd ? '8h' : '7d');
const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

// A guessable fallback secret in production means anyone can forge an admin token.
if (isProd && jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be set to a random string of at least 32 characters in production.');
}

if (isProd) {
  const duration = /^(\d+)(m|h)$/.exec(jwtExpiresIn);
  const minutes = duration ? Number(duration[1]) * (duration[2] === 'h' ? 60 : 1) : Infinity;
  if (minutes > 12 * 60) {
    throw new Error('JWT_EXPIRES_IN must be 12 hours or less in production (for example, 8h).');
  }
}

for (const origin of corsOrigins) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`Invalid CORS_ORIGINS entry: ${origin}`);
  }
  if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`CORS_ORIGINS entries must be exact HTTP(S) origins: ${origin}`);
  }
}

export const config = {
  isProd,
  port: parseInt(process.env.PORT || '5000', 10),
  jwtSecret: jwtSecret || 'dev-only-insecure-secret-change-me',
  jwtExpiresIn,
  jwtIssuer: 'college-runner-api',
  jwtAudience: 'college-runner-mobile',
  databaseUrl: process.env.DATABASE_URL || '',
  // An empty list denies browser origins; native mobile requests do not use browser CORS.
  corsOrigins,
  zoom: {
    // Must be the Video SDK SDK Key + SDK Secret, not OAuth Client ID/Secret, API keys, or Meeting SDK credentials.
    sdkKey: process.env.ZOOM_SDK_KEY || '',
    sdkSecret: process.env.ZOOM_SDK_SECRET || '',
  },
};
