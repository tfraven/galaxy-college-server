import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { config } from '../config/index.js';

const isPlaceholder = (value) => !value || /YOUR_ZOOM|CHANGE_ME/i.test(value);
const tokenCache = new Map();

const getAccount = (key) => {
  const account = config.zoom.accounts[key];
  if (!account || [account.accountId, account.userId, account.clientId, account.clientSecret, account.sdkKey, account.sdkSecret].some(isPlaceholder)) return null;
  return account;
};

export const configuredZoomAccounts = () => Object.entries(config.zoom.accounts)
  .filter(([key]) => getAccount(key))
  .map(([id, account]) => ({ id, label: account.label }));

export const zoomAccountConfigured = (key) => Boolean(getAccount(key));
export const zoomConfigured = () => configuredZoomAccounts().length > 0;

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
  settings: { waiting_room: true, join_before_host: false, host_video: true, participant_video: true },
});

export const createZoomMeeting = async (key, details) => {
  const account = getAccount(key);
  if (!account) {
    const error = new Error(`Zoom account ${key === 'account2' ? '2' : '1'} is not configured.`);
    error.status = 503;
    throw error;
  }
  const meeting = await zoomApi(key, account, `/users/${encodeURIComponent(account.userId)}/meetings`, {
    method: 'POST', body: meetingInput(details),
  });
  return { meetingId: String(meeting.id), passcode: meeting.password || '', joinUrl: meeting.join_url || '' };
};

export const updateZoomMeeting = async (key, meetingId, details) => {
  const account = getAccount(key);
  if (!account) throw Object.assign(new Error('The configured Zoom account is unavailable.'), { status: 503 });
  const { password: _unused, ...body } = meetingInput(details);
  await zoomApi(key, account, `/meetings/${encodeURIComponent(meetingId)}`, { method: 'PATCH', body });
};

export const deleteZoomMeeting = async (key, meetingId) => {
  const account = getAccount(key);
  if (!account || !meetingId) return;
  await zoomApi(key, account, `/meetings/${encodeURIComponent(meetingId)}`, { method: 'DELETE' });
};

export const generateMeetingSdkToken = async ({ accountKey, meetingNumber, isHost }) => {
  const account = getAccount(accountKey);
  if (!account || !meetingNumber) {
    const error = new Error('Zoom Meeting SDK and meeting account credentials are not configured.');
    error.status = 503;
    throw error;
  }
  const iat = Math.floor(Date.now() / 1000) - 30;
  const exp = iat + 60 * 60 * 2;
  const signature = jwt.sign({
    appKey: account.sdkKey,
    mn: String(meetingNumber),
    role: isHost ? 1 : 0,
    iat,
    exp,
    tokenExp: exp,
  }, account.sdkSecret, { algorithm: 'HS256' });

  const zak = isHost
    ? (await zoomApi(accountKey, account, `/users/${encodeURIComponent(account.userId)}/token?type=zak`)).token
    : undefined;
  return { signature, zak, expiresAt: new Date(exp * 1000).toISOString() };
};
