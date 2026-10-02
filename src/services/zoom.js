import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

// One Zoom room per class session, derived from the DB id (no link/ID is ever stored or shown).
export const sessionNameFor = (sessionId) => `class_${sessionId}`;

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
      session_key: sessionName,
      version: 1,
      iat,
      exp,
    },
    config.zoom.sdkSecret,
    { algorithm: 'HS256' }
  );

  return { token, expiresAt: new Date(exp * 1000).toISOString() };
};