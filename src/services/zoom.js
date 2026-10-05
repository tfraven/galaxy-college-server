import jwt from 'jsonwebtoken';
import { createHmac } from 'node:crypto';
import { config } from '../config/index.js';

// Student-facing references avoid exposing sequential database ids in the UI or API payloads.
export const sessionReferenceFor = (sessionId) =>
  `s_${Buffer.from(String(sessionId), 'utf8').toString('base64url')}`;

export const sessionIdFromReference = (reference) => {
  if (typeof reference !== 'string') return null;
  if (/^[1-9]\d*$/.test(reference)) {
    const id = Number(reference);
    return Number.isSafeInteger(id) ? id : null;
  }
  if (!/^s_[A-Za-z0-9_-]+$/.test(reference)) return null;

  try {
    const encoded = reference.slice(2);
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    const id = Number(decoded);
    return /^[1-9]\d*$/.test(decoded)
      && Number.isSafeInteger(id)
      && sessionReferenceFor(id) === reference
      ? id
      : null;
  } catch {
    return null;
  }
};

// Stable Zoom room names are keyed and do not reveal the sequential database id.
export const sessionNameFor = (sessionId) => {
  const digest = createHmac('sha256', config.zoom.sdkSecret || config.jwtSecret)
    .update(`live-session:${sessionId}`)
    .digest('hex')
    .slice(0, 26);
  return `class_${digest}`;
};

const isPlaceholder = (v) => !v || /YOUR_ZOOM/i.test(v);

export const zoomConfigured = () => !isPlaceholder(config.zoom.sdkKey) && !isPlaceholder(config.zoom.sdkSecret);

/**
 * Zoom *Video SDK* JWT (HS256).
 * Claims per Zoom docs: app_key, tpc (session name), role_type (1 host / 0 participant), version, iat, exp.
 * The SDK key + secret must come from a Video SDK app. Meeting SDK credentials produce "invalid signature".
 */
export const generateVideoSdkToken = ({ sessionName, isHost, userIdentity, durationSeconds = 4 * 60 * 60 }) => {
  if (!zoomConfigured()) {
    // Fail loudly: a token signed with a fake secret is rejected by Zoom with no useful message.
    const err = new Error('Zoom Video SDK key/secret are not configured on the server.');
    err.status = 503;
    throw err;
  }

  const iat = Math.floor(Date.now() / 1000) - 30; // clock-skew buffer
  const exp = iat + durationSeconds;

  const token = jwt.sign(
    {
      app_key: config.zoom.sdkKey,
      tpc: sessionName,
      role_type: isHost ? 1 : 0,
      user_identity: String(userIdentity),
      // session_key is a Zoom *password* field — omit it unless you intentionally
      // want a password-protected session. Including it causes Zoom to reject joiners
      // that don't supply the matching password and triggers endless RECONNECTING_MEETING.
      version: 1,
      iat,
      exp,
    },
    config.zoom.sdkSecret,
    { algorithm: 'HS256', noTimestamp: true }
  );

  return { token, expiresAt: new Date(exp * 1000).toISOString() };
};
