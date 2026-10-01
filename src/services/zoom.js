import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

// One Zoom room per class session, derived from the DB id (no link/ID is ever stored or shown).
export const sessionNameFor = (sessionId) => `class_${sessionId}`;

/**
 * Zoom Video SDK JWT.
 * Uses config.zoom.sdkKey / config.zoom.sdkSecret, which must be your *Video SDK* key and secret.
 */
export const generateVideoSdkToken = ({
  sessionName,
  isHost,
  userIdentity,
  durationSeconds = 4 * 60 * 60,
}) => {
  const sdkKey = config.zoom?.sdkKey;
  const sdkSecret = config.zoom?.sdkSecret;

  // Fail loudly. A token signed with a fake secret is rejected by Zoom with no useful message.
  if (!sdkKey || !sdkSecret || /YOUR_ZOOM/i.test(sdkKey) || /YOUR_ZOOM/i.test(sdkSecret)) {
    throw new Error('Zoom Video SDK key/secret are not configured on the server.');
  }

  const iat = Math.floor(Date.now() / 1000) - 30; // clock-skew buffer
  const exp = iat + durationSeconds;

  const token = jwt.sign(
    {
      app_key: sdkKey,
      tpc: sessionName,
      role_type: isHost ? 1 : 0,
      user_identity: String(userIdentity),
      version: 1,
      iat,
      exp,
    },
    sdkSecret,
    { algorithm: 'HS256' }
  );

  return { token, expiresAt: new Date(exp * 1000).toISOString() };
};