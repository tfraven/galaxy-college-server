import { createHmac } from 'node:crypto';
import { sql } from '../db/connection.js';
import { config } from '../config/index.js';

const MAX_REQUESTS = 300;
let nextCleanupAt = 0;

/** A shared Neon-backed IP bucket works across serverless instances without storing raw IPs. */
export const consumeLoginRateLimit = async (ipAddress) => {
  const ip = String(ipAddress || 'unknown').slice(0, 128);
  const ipHash = createHmac('sha256', config.jwtSecret).update(ip).digest('hex');
  const [bucket] = await sql`
    INSERT INTO login_rate_limits (ip_hash, attempts, reset_at)
    VALUES (${ipHash}, 1, NOW() + INTERVAL '15 minutes')
    ON CONFLICT (ip_hash) DO UPDATE SET
      attempts = CASE WHEN login_rate_limits.reset_at <= NOW() THEN 1 ELSE login_rate_limits.attempts + 1 END,
      reset_at = CASE WHEN login_rate_limits.reset_at <= NOW()
        THEN NOW() + INTERVAL '15 minutes' ELSE login_rate_limits.reset_at END
    RETURNING attempts, reset_at
  `;

  if (Date.now() >= nextCleanupAt) {
    nextCleanupAt = Date.now() + 60 * 60 * 1000;
    void sql`DELETE FROM login_rate_limits WHERE reset_at < NOW() - INTERVAL '1 day'`
      .catch((error) => console.warn('[auth] rate-limit cleanup failed:', error?.message || 'unknown error'));
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((new Date(bucket.reset_at).getTime() - Date.now()) / 1000));
  return {
    limited: bucket.attempts > MAX_REQUESTS,
    limit: MAX_REQUESTS,
    retryAfterSeconds,
    remaining: Math.max(0, MAX_REQUESTS - bucket.attempts),
  };
};
