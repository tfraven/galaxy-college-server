import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config/index.js';

/**
 * Generate a Zoom Video SDK JWT token.
 * Reference: https://developers.zoom.us/docs/video-sdk/auth/
 *
 * @param {Object} params
 * @param {string} params.sessionName - Unique topic or room name for the class
 * @param {number} params.roleType - 1 for host/teacher, 0 for student attendee
 * @param {string} params.userIdentity - Name or ID of the student / teacher
 * @param {string} [params.sessionKey] - Optional password for the room
 * @param {number} [params.durationSeconds] - Token validity in seconds (default 2 hours)
 */
export const generateZoomSessionToken = ({
  sessionName,
  roleType = 0,
  userIdentity,
  sessionKey = '',
  durationSeconds = 7200,
}) => {
  const sdkKey = config.zoom.sdkKey;
  const sdkSecret = config.zoom.sdkSecret;
  const isConfigured =
    sdkKey &&
    sdkSecret &&
    sdkKey !== 'YOUR_ZOOM_SDK_KEY_OR_CLIENT_ID_HERE' &&
    sdkSecret !== 'YOUR_ZOOM_SDK_SECRET_HERE';

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + durationSeconds;

  const payload = {
    app_key: sdkKey || 'demo_zoom_sdk_key',
    tpc: sessionName,
    role_type: roleType,
    session_key: sessionKey || '',
    user_identity: String(userIdentity),
    version: 1,
    iat,
    exp,
  };

  const secretToUse = isConfigured ? sdkSecret : 'demo_zoom_secret_key_for_testing';
  const token = jwt.sign(payload, secretToUse, { algorithm: 'HS256' });

  return {
    token,
    sessionName,
    roleType,
    userRole: roleType === 1 ? 'host' : 'student',
    canTalk: true,       // Audio unmute permitted for students
    canShareVideo: true, // Camera permitted for students
    expiresAt: new Date(exp * 1000).toISOString(),
    isRealZoomCredentialsConfigured: isConfigured,
  };
};
