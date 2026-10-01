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

  // 30-second buffer against server clock skew on Zoom authorization servers
  const iat = Math.floor(Date.now() / 1000) - 30;
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

/**
 * Resolve Zoom Meeting details including direct join URL, native app deep link,
 * and official Zoom Web Client URL.
 * Only builds URLs if a genuine meeting link or ID is supplied.
 */
export const resolveZoomMeetingDetails = ({
  sessionId,
  customUrl,
  customMeetingId,
  customPasscode,
  displayName = 'Participant',
  isHost = false,
}) => {
  let targetUrl = customUrl ? String(customUrl).trim() : '';

  // Check fallback from environment variable if no session URL was specified
  if (!targetUrl && process.env.DEFAULT_ZOOM_MEETING_URL) {
    targetUrl = process.env.DEFAULT_ZOOM_MEETING_URL.trim();
  }

  let meetingId = customMeetingId ? String(customMeetingId).replace(/[\s-]+/g, '') : '';
  let passcode = customPasscode ? String(customPasscode).trim() : '';

  if (targetUrl) {
    // 1. Check if targetUrl is just a raw numeric meeting ID (9-11 digits)
    const digitsOnly = targetUrl.replace(/[\s-]+/g, '');
    if (/^\d{9,11}$/.test(digitsOnly) && !meetingId) {
      meetingId = digitsOnly;
    } else {
      // 2. Extract from standard URL paths: /j/1234567890 or /wc/1234567890 or confno=1234567890
      const idMatch = targetUrl.match(/\/(?:j|wc|s)\/(\d{9,11})/i) || targetUrl.match(/confno=(\d{9,11})/i);
      if (idMatch && !meetingId) {
        meetingId = idMatch[1];
      }
      // 3. Extract passcode: ?pwd=xxxx
      const pwdMatch = targetUrl.match(/[?&]pwd=([^&#]+)/i);
      if (pwdMatch && !passcode) {
        passcode = pwdMatch[1];
      }
    }
  }

  const hasValidMeeting = Boolean(meetingId && /^\d{9,11}$/.test(meetingId));

  if (!hasValidMeeting) {
    return {
      hasValidMeeting: false,
      meetingId: '',
      passcode: '',
      zoomUrl: targetUrl || '',
      zoomAppUrl: '',
      webClientUrl: '',
    };
  }

  const encodedName = encodeURIComponent(displayName);
  const pwdQuery = passcode ? `?pwd=${encodeURIComponent(passcode)}` : '';
  const pwdParam = passcode ? `&pwd=${encodeURIComponent(passcode)}` : '';

  const zoomUrl = `https://zoom.us/j/${meetingId}${pwdQuery}`;
  const zoomAppUrl = `zoomus://zoom.us/join?confno=${meetingId}${pwdParam}&uname=${encodedName}`;
  const webClientUrl = `https://app.zoom.us/wc/${meetingId}/join?prefer=1${pwdParam}&uname=${encodedName}`;

  return {
    hasValidMeeting: true,
    meetingId,
    passcode,
    zoomUrl,
    zoomAppUrl,
    webClientUrl,
  };
};
