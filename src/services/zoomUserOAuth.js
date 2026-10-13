import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config/index.js';
import { sql } from '../db/connection.js';

const refreshJobs = new Map();

const oauthConfig = () => config.zoomUserOAuth;

export const zoomUserOAuthConfigured = () => {
  const oauth = oauthConfig();
  return Boolean(oauth.clientId && oauth.clientSecret && oauth.redirectUri && config.frontendUrl && /^[0-9a-f]{64}$/i.test(oauth.encryptionKey));
};

const requireOAuthConfig = () => {
  if (!zoomUserOAuthConfigured()) {
    const error = new Error('Zoom user authorization is not configured. Contact the administrator.');
    error.status = 503;
    throw error;
  }
  return oauthConfig();
};

const encryptionKey = () => Buffer.from(requireOAuthConfig().encryptionKey, 'hex');

const encrypt = (value) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext.toString('hex')].join(':');
};

const decrypt = (value) => {
  const [ivHex, tagHex, ciphertextHex] = String(value || '').split(':');
  if (!/^[0-9a-f]{24}$/i.test(ivHex || '') || !/^[0-9a-f]{32}$/i.test(tagHex || '') || !/^(?:[0-9a-f]{2})+$/i.test(ciphertextHex || '')) {
    throw Object.assign(new Error('The linked Zoom authorization could not be read. Reconnect your Zoom account.'), { status: 409 });
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
};

const zoomTokenRequest = async (params) => {
  const oauth = requireOAuthConfig();
  const credentials = Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString('base64');
  const response = await fetch(`https://zoom.us/oauth/token?${params.toString()}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const error = new Error('Zoom authorization failed. Please try connecting your Zoom account again.');
    error.status = 502;
    error.zoom = { operation: 'user-oauth-token', status: response.status, code: String(payload.error || '').slice(0, 64) };
    throw error;
  }
  return payload;
};

const zoomApiAsUser = async (accessToken, path) => {
  const response = await fetch(`https://api.zoom.us/v2${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(response.status === 401
      ? 'Zoom authorization expired. Reconnect your Zoom account.'
      : 'Zoom could not authorize this meeting. Check the Zoom app scopes and try again.');
    error.status = response.status === 401 ? 409 : 502;
    error.zoom = { operation: path.includes('/token?type=') ? 'participant-token' : 'user-profile', status: response.status, code: String(payload.code || '').slice(0, 64) };
    throw error;
  }
  return payload;
};

export const createZoomOAuthAuthorizationUrl = (state) => {
  const oauth = requireOAuthConfig();
  const url = new URL('https://zoom.us/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', oauth.clientId);
  url.searchParams.set('redirect_uri', oauth.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
};

export const exchangeZoomOAuthCode = async (code) => {
  const oauth = requireOAuthConfig();
  const params = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: oauth.redirectUri });
  return zoomTokenRequest(params);
};

export const refreshZoomOAuthToken = async (refreshToken) => {
  const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  return zoomTokenRequest(params);
};

export const getZoomUserProfile = (accessToken) => zoomApiAsUser(accessToken, '/users/me');

export const storeZoomUserConnection = async (userId, zoomUserId, zoomEmail, tokenPayload) => {
  if (!tokenPayload.access_token || !tokenPayload.refresh_token) {
    throw Object.assign(new Error('Zoom did not return a refresh token. Check the OAuth app configuration and reconnect.'), { status: 502 });
  }
  const accessExpiresAt = new Date(Date.now() + Math.max(60, Number(tokenPayload.expires_in || 3600)) * 1000);
  await sql`
    INSERT INTO zoom_user_connections (
      user_id, zoom_user_id, zoom_email, access_token_encrypted, refresh_token_encrypted, access_expires_at, is_active, updated_at
    ) VALUES (
      ${userId}, ${zoomUserId}, ${zoomEmail || null}, ${encrypt(tokenPayload.access_token)}, ${encrypt(tokenPayload.refresh_token)}, ${accessExpiresAt.toISOString()}, TRUE, NOW()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      zoom_user_id = EXCLUDED.zoom_user_id,
      zoom_email = EXCLUDED.zoom_email,
      access_token_encrypted = EXCLUDED.access_token_encrypted,
      refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
      access_expires_at = EXCLUDED.access_expires_at,
      is_active = TRUE,
      updated_at = NOW()
  `;
};

export const getZoomUserConnectionStatus = async (userId) => {
  const [connection] = await sql`
    SELECT zoom_email, is_active, updated_at FROM zoom_user_connections WHERE user_id = ${userId}
  `;
  return {
    connected: Boolean(connection?.is_active),
    email: connection?.is_active ? connection.zoom_email || null : null,
    updatedAt: connection?.is_active ? connection.updated_at : null,
  };
};

const readConnection = async (userId) => {
  const [connection] = await sql`
    SELECT user_id, zoom_user_id, access_token_encrypted, refresh_token_encrypted, access_expires_at, is_active
    FROM zoom_user_connections WHERE user_id = ${userId}
  `;
  if (!connection?.is_active) {
    const error = new Error('Connect your Zoom account from your profile before joining a live class.');
    error.status = 409;
    error.zoom = { operation: 'participant-token', code: 'zoom_account_not_linked' };
    throw error;
  }
  return connection;
};

const getFreshAccessToken = async (userId) => {
  const connection = await readConnection(userId);
  if (new Date(connection.access_expires_at).getTime() > Date.now() + 60_000) {
    return decrypt(connection.access_token_encrypted);
  }

  const running = refreshJobs.get(userId);
  if (running) return running;
  const refreshJob = (async () => {
    // Another concurrent request may have refreshed the token while this request waited.
    const latest = await readConnection(userId);
    if (new Date(latest.access_expires_at).getTime() > Date.now() + 60_000) return decrypt(latest.access_token_encrypted);
    let refreshed;
    try {
      refreshed = await refreshZoomOAuthToken(decrypt(latest.refresh_token_encrypted));
    } catch (error) {
      if (error.zoom?.status === 401 || (error.zoom?.status === 400 && error.zoom?.code === 'invalid_grant')) {
        await sql`UPDATE zoom_user_connections SET is_active = FALSE, updated_at = NOW() WHERE user_id = ${userId}`;
        error.message = 'Zoom authorization expired. Reconnect your Zoom account from your profile.';
        error.status = 409;
      }
      throw error;
    }
    const expiresAt = new Date(Date.now() + Math.max(60, Number(refreshed.expires_in || 3600)) * 1000);
    await sql`
      UPDATE zoom_user_connections SET
        access_token_encrypted = ${encrypt(refreshed.access_token)},
        refresh_token_encrypted = ${encrypt(refreshed.refresh_token || decrypt(latest.refresh_token_encrypted))},
        access_expires_at = ${expiresAt.toISOString()}, is_active = TRUE, updated_at = NOW()
      WHERE user_id = ${userId}
    `;
    return refreshed.access_token;
  })();
  refreshJobs.set(userId, refreshJob);
  try {
    return await refreshJob;
  } finally {
    if (refreshJobs.get(userId) === refreshJob) refreshJobs.delete(userId);
  }
};

export const getZoomParticipantToken = async ({ userId, meetingNumber, type }) => {
  if (!['zak', 'onbehalf'].includes(type)) throw Object.assign(new Error('Unsupported Zoom participant authorization mode.'), { status: 400 });
  if (type === 'onbehalf' && !meetingNumber) throw Object.assign(new Error('A meeting number is required for an OBF token.'), { status: 400 });
  const accessToken = await getFreshAccessToken(userId);
  const path = type === 'zak'
    ? '/users/me/zak'
    : `/users/me/token?type=onbehalf&meeting_id=${encodeURIComponent(String(meetingNumber))}`;
  const payload = await zoomApiAsUser(accessToken, path);
  if (!payload.token) throw Object.assign(new Error(`Zoom did not return a ${type === 'zak' ? 'ZAK' : 'OBF'} token.`), { status: 502 });
  return payload.token;
};
