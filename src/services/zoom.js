import jwt from 'jsonwebtoken';
import {
  createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID,
} from 'node:crypto';
import { config } from '../config/index.js';
import { sql } from '../db/connection.js';

const isPlaceholder = (value) => !value || /YOUR_ZOOM|CHANGE_ME/i.test(value);
const tokenCache = new Map();
const credentialsKey = createHash('sha256').update(config.zoom.credentialsEncryptionKey).digest();

const encryptSecret = (secret) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialsKey, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
};

const decryptSecret = (encoded) => {
  const [version, iv, tag, ciphertext] = String(encoded || '').split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Stored Zoom credentials cannot be decrypted.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', credentialsKey, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Stored Zoom credentials cannot be decrypted. Check ZOOM_CREDENTIALS_ENCRYPTION_KEY.');
  }
};

const staticAccountConfigured = (account) => Boolean(account)
  && ![account.accountId, account.userId, account.clientId, account.clientSecret, account.sdkKey, account.sdkSecret].some(isPlaceholder);

const fromManagedRow = (row) => ({
  label: row.label,
  accountId: row.account_id,
  userId: row.user_id,
  clientId: row.client_id,
  clientSecret: decryptSecret(row.client_secret_encrypted),
  sdkKey: row.meeting_sdk_client_id,
  sdkSecret: decryptSecret(row.meeting_sdk_client_secret_encrypted),
});

const getAccount = async (key) => {
  if (Object.hasOwn(config.zoom.accounts, key)) {
    const account = config.zoom.accounts[key];
    return staticAccountConfigured(account) ? account : null;
  }
  if (typeof key !== 'string' || key.length > 80 || !key.startsWith('db_')) return null;
  const [row] = await sql`SELECT * FROM zoom_accounts WHERE id = ${key} AND is_active = TRUE`;
  return row ? fromManagedRow(row) : null;
};

export const configuredZoomAccounts = async () => {
  const environmentAccounts = Object.entries(config.zoom.accounts)
    .filter(([, account]) => staticAccountConfigured(account))
    .map(([id, account]) => ({ id, label: account.label }));
  const managedAccounts = await sql`SELECT id, label FROM zoom_accounts WHERE is_active = TRUE ORDER BY created_at, id`;
  return [...environmentAccounts, ...managedAccounts];
};

export const zoomAccountConfigured = async (key) => Boolean(await getAccount(key));
export const zoomConfigured = async () => (await configuredZoomAccounts()).length > 0;

const normalizeCandidate = (input) => {
  const fields = {
    label: input?.label,
    accountId: input?.accountId,
    userId: input?.userId,
    clientId: input?.clientId,
    clientSecret: input?.clientSecret,
    sdkKey: input?.meetingSdkClientId,
    sdkSecret: input?.meetingSdkClientSecret,
  };
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > (name === 'label' ? 80 : 512)) {
      const error = new Error(`Enter a valid ${name === 'sdkKey' ? 'Meeting SDK Client ID' : name === 'sdkSecret' ? 'Meeting SDK Client Secret' : name}.`);
      error.status = 400;
      throw error;
    }
    fields[name] = value.trim();
  }
  if (Object.values(fields).some((value) => /[\u0000-\u001f\u007f]/.test(value))) {
    const error = new Error('Zoom account fields contain unsupported control characters.');
    error.status = 400;
    throw error;
  }
  if ([fields.accountId, fields.userId, fields.clientId, fields.clientSecret, fields.sdkKey, fields.sdkSecret].some(isPlaceholder)) {
    const error = new Error('Replace placeholder values with active Zoom credentials.');
    error.status = 400;
    throw error;
  }
  return fields;
};

const getValidationToken = async (account) => {
  const url = new URL('https://zoom.us/oauth/token');
  url.searchParams.set('grant_type', 'account_credentials');
  url.searchParams.set('account_id', account.accountId);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${account.clientId}:${account.clientSecret}`).toString('base64')}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    const error = new Error('Could not reach Zoom to validate these credentials. Try again.');
    error.status = 502;
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const error = new Error('Zoom rejected the Server-to-Server OAuth credentials. Check the account ID, client ID, client secret, and app activation.');
    error.status = 400;
    throw error;
  }
  return payload.access_token;
};

const validationApi = async (accessToken, path, { method = 'GET', body } = {}) => {
  let response;
  try {
    response = await fetch(`https://api.zoom.us/v2${path}`, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    const error = new Error('Could not reach the Zoom API to finish validating this account. Try again.');
    error.status = 502;
    throw error;
  }
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('Zoom authenticated the app, but the selected host or required Zoom permissions could not be verified. Check the host user and app scopes.');
    error.status = 400;
    throw error;
  }
  return payload;
};

export const validateZoomAccountCredentials = async (input) => {
  const account = normalizeCandidate(input);
  const accessToken = await getValidationToken(account);

  await validationApi(accessToken, `/users/${encodeURIComponent(account.userId)}/token?type=zak`);

  const startTime = new Date(Date.now() + 20 * 60_000).toISOString();
  const meeting = await validationApi(accessToken, `/users/${encodeURIComponent(account.userId)}/meetings`, {
    method: 'POST',
    body: {
      topic: `Galaxy College credential check ${randomBytes(3).toString('hex')}`,
      type: 2,
      start_time: startTime,
      duration: 5,
      timezone: 'UTC',
      settings: { waiting_room: true, join_before_host: false },
    },
  });

  try {
    await validationApi(accessToken, `/meetings/${encodeURIComponent(meeting.id)}`, { method: 'DELETE' });
  } catch {
    const error = new Error('Zoom created a temporary validation meeting, but cleanup was not confirmed. The account was not saved; remove that temporary meeting in Zoom and retry.');
    error.status = 502;
    throw error;
  }

  try {
    const now = Math.floor(Date.now() / 1000) - 30;
    jwt.sign({ appKey: account.sdkKey, iat: now, exp: now + 120, tokenExp: now + 120 }, account.sdkSecret, { algorithm: 'HS256' });
  } catch {
    const error = new Error('The Meeting SDK Client ID and Client Secret could not be used to create an SDK token.');
    error.status = 400;
    throw error;
  }

  return {
    account,
    checks: [
      'Server-to-Server OAuth credentials accepted by Zoom',
      'Host user and host-token permission verified',
      'Meeting creation permission verified; temporary meeting deleted',
      'Meeting SDK signature generated locally; Zoom checks it during a meeting join',
    ],
  };
};

export const listZoomAccountsForAdmin = async () => {
  const environmentAccounts = Object.entries(config.zoom.accounts)
    .filter(([, account]) => staticAccountConfigured(account))
    .map(([id, account]) => ({ id, label: account.label, source: 'environment', isActive: true, permanent: true }));
  const managedAccounts = await sql`
    SELECT id, label, is_active AS "isActive", validated_at AS "validatedAt", created_at AS "createdAt"
    FROM zoom_accounts ORDER BY created_at DESC, id
  `;
  return [...environmentAccounts, ...managedAccounts.map((row) => ({ ...row, source: 'database', permanent: false }))];
};

export const createManagedZoomAccount = async (input, createdBy) => {
  const { account, checks } = await validateZoomAccountCredentials(input);
  const staticDuplicate = Object.values(config.zoom.accounts)
    .some((candidate) => staticAccountConfigured(candidate) && candidate.accountId === account.accountId);
  const [existing] = await sql`SELECT id FROM zoom_accounts WHERE account_id = ${account.accountId}`;
  if (staticDuplicate || existing) {
    const error = new Error('This Zoom account is already configured.');
    error.status = 409;
    throw error;
  }
  const id = `db_${randomUUID()}`;
  const [row] = await sql`
    INSERT INTO zoom_accounts (
      id, label, account_id, user_id, client_id, client_secret_encrypted,
      meeting_sdk_client_id, meeting_sdk_client_secret_encrypted, created_by, validated_at
    ) VALUES (
      ${id}, ${account.label}, ${account.accountId}, ${account.userId}, ${account.clientId}, ${encryptSecret(account.clientSecret)},
      ${account.sdkKey}, ${encryptSecret(account.sdkSecret)}, ${createdBy}, NOW()
    )
    RETURNING id, label, is_active AS "isActive", validated_at AS "validatedAt", created_at AS "createdAt"
  `;
  tokenCache.delete(id);
  return { ...row, source: 'database', permanent: false, checks };
};

export const setManagedZoomAccountActive = async (id, isActive) => {
  if (typeof id !== 'string' || !id.startsWith('db_') || id.length > 80) {
    const error = new Error('Only database-managed Zoom accounts can be changed.');
    error.status = 400;
    throw error;
  }
  const [row] = await sql`SELECT * FROM zoom_accounts WHERE id = ${id}`;
  if (!row) {
    const error = new Error('Zoom account not found.');
    error.status = 404;
    throw error;
  }
  if (isActive) {
    const account = fromManagedRow(row);
    const input = {
      label: account.label,
      accountId: account.accountId,
      userId: account.userId,
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      meetingSdkClientId: account.sdkKey,
      meetingSdkClientSecret: account.sdkSecret,
    };
    await validateZoomAccountCredentials(input);
  } else {
    const [sessionUse] = await sql`
      SELECT id FROM live_sessions
      WHERE zoom_account = ${id} AND deleted_at IS NULL AND plan_end > NOW() AND status <> 3
      LIMIT 1
    `;
    const [scheduleUse] = await sql`
      SELECT id FROM recurring_live_schedules
      WHERE zoom_account = ${id} AND enabled = TRUE AND deleted_at IS NULL
      LIMIT 1
    `;
    if (sessionUse || scheduleUse) {
      const error = new Error('This account is assigned to an upcoming/live class or enabled recurring schedule. Move those classes first.');
      error.status = 409;
      throw error;
    }
  }
  const [updated] = await sql`
    UPDATE zoom_accounts
    SET is_active = ${isActive}, validated_at = CASE WHEN ${isActive} THEN NOW() ELSE validated_at END, updated_at = NOW()
    WHERE id = ${id}
    RETURNING id, label, is_active AS "isActive", validated_at AS "validatedAt", created_at AS "createdAt"
  `;
  if (!isActive) tokenCache.delete(id);
  return { ...updated, source: 'database', permanent: false };
};

export const sessionReferenceFor = (id) => `s_${Buffer.from(String(id), 'utf8').toString('base64url')}`;

export const sessionIdFromReference = (reference) => {
  if (typeof reference !== 'string') return null;
  if (/^[1-9]\d*$/.test(reference)) {
    const id = Number(reference);
    return Number.isSafeInteger(id) ? id : null;
  }
  if (!/^s_[A-Za-z0-9_-]+$/.test(reference)) return null;
  try {
    const decoded = Buffer.from(reference.slice(2), 'base64url').toString('utf8');
    const id = Number(decoded);
    const canonical = `s_${Buffer.from(String(id), 'utf8').toString('base64url')}`;
    return /^[1-9]\d*$/.test(decoded) && Number.isSafeInteger(id) && canonical === reference ? id : null;
  } catch {
    return null;
  }
};

const getAccessToken = async (key, account) => {
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const credentials = Buffer.from(`${account.clientId}:${account.clientSecret}`).toString('base64');
  const url = new URL('https://zoom.us/oauth/token');
  url.searchParams.set('grant_type', 'account_credentials');
  url.searchParams.set('account_id', account.accountId);
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Basic ${credentials}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const error = new Error(payload.reason || payload.error || 'Could not authenticate with the selected Zoom account.');
    error.status = response.status === 401 ? 503 : 502;
    error.zoom = {
      account: key,
      operation: 'oauth-token',
      status: response.status,
      code: String(payload.error || payload.reason || '').slice(0, 64),
    };
    throw error;
  }
  tokenCache.set(key, { accessToken: payload.access_token, expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000 });
  return payload.access_token;
};

const zoomApi = async (key, account, path, { method = 'GET', body } = {}) => {
  const accessToken = await getAccessToken(key, account);
  const response = await fetch(`https://api.zoom.us/v2${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.reason || `Zoom API request failed (${response.status}).`);
    error.status = response.status === 401 || response.status === 403 ? 503 : 502;
    error.zoom = {
      account: key,
      operation: path.includes('/token?type=zak') ? 'zak-token' : 'api-request',
      status: response.status,
      code: String(payload.code || '').slice(0, 64),
    };
    throw error;
  }
  return payload;
};

const meetingInput = ({ title, planStart, planEnd }) => ({
  topic: String(title || 'Live class').trim().slice(0, 200),
  type: 2,
  start_time: new Date(planStart).toISOString(),
  duration: Math.max(1, Math.ceil((new Date(planEnd).getTime() - new Date(planStart).getTime()) / 60_000)),
  timezone: 'UTC',
  password: randomBytes(5).toString('hex'),
  settings: {
    waiting_room: false,
    join_before_host: true,
    jbh_time: 0,
    host_video: true,
    participant_video: false,
    disable_participant_video: true,
    mute_upon_entry: true,
    allow_host_control_participant_mute_state: true,
    request_permission_to_unmute_participants: false,
    who_can_share_screen: 'host',
    whiteboard: false,
    meeting_authentication: false,
    auto_recording: 'none',
    disable_recording_control: 'all',
  },
});

export const createZoomMeeting = async (key, details) => {
  const account = await getAccount(key);
  if (!account) {
    const error = new Error('The selected Zoom account is not configured or active.');
    error.status = 503;
    throw error;
  }
  const meeting = await zoomApi(key, account, `/users/${encodeURIComponent(account.userId)}/meetings`, {
    method: 'POST', body: meetingInput(details),
  });
  return { meetingId: String(meeting.id), passcode: meeting.password || '' };
};

export const updateZoomMeeting = async (key, meetingId, details) => {
  const account = await getAccount(key);
  if (!account) throw Object.assign(new Error('The configured Zoom account is unavailable.'), { status: 503 });
  const { password: _unused, ...body } = meetingInput(details);
  await zoomApi(key, account, `/meetings/${encodeURIComponent(meetingId)}`, { method: 'PATCH', body });
};

export const deleteZoomMeeting = async (key, meetingId) => {
  const account = await getAccount(key);
  if (!account || !meetingId) return;
  await zoomApi(key, account, `/meetings/${encodeURIComponent(meetingId)}`, { method: 'DELETE' });
};

export const generateMeetingSdkToken = async ({ accountKey, meetingNumber, isHost }) => {
  const account = await getAccount(accountKey);
  if (!account || !meetingNumber) {
    const error = new Error('Zoom Meeting SDK and meeting account credentials are not configured.');
    error.status = 503;
    throw error;
  }
  const iat = Math.floor(Date.now() / 1000) - 30;
  const exp = iat + 60 * 60 * 2;
  const sdkJwt = jwt.sign({
    appKey: account.sdkKey,
    iat,
    exp,
    tokenExp: exp,
  }, account.sdkSecret, { algorithm: 'HS256' });
  const signature = jwt.sign({
    appKey: account.sdkKey,
    mn: String(meetingNumber),
    role: isHost ? 1 : 0,
    video_webrtc_mode: 1,
    iat,
    exp,
    tokenExp: exp,
  }, account.sdkSecret, { algorithm: 'HS256' });

  const zak = isHost
    ? (await zoomApi(accountKey, account, `/users/${encodeURIComponent(account.userId)}/token?type=zak`)).token
    : undefined;
  return { signature, sdkJwt, zak, expiresAt: new Date(exp * 1000).toISOString() };
};
