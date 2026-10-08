import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { sql } from '../db/connection.js';

const APP_NAME = 'galaxy-college-push';
const CHUNK_SIZE = 500;
let credentialErrorLogged = false;

const notificationBody = (body) => {
  const text = String(body);
  let preview = '';
  for (const character of text) {
    if (Buffer.byteLength(preview + character, 'utf8') > 1600) break;
    preview += character;
  }
  return preview.length < text.length ? `${preview}…` : preview;
};

const messagingClient = () => {
  const serviceAccountText = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  const credentialsAvailable = serviceAccountText || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialsAvailable) return null;

  try {
    const existing = getApps().find((app) => app.name === APP_NAME);
    if (existing) return getMessaging(existing);

    const serviceAccount = serviceAccountText ? JSON.parse(serviceAccountText) : null;
    const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || serviceAccount?.project_id;
    const app = initializeApp({
      credential: serviceAccount ? cert(serviceAccount) : applicationDefault(),
      ...(projectId ? { projectId } : {}),
    }, APP_NAME);
    return getMessaging(app);
  } catch (error) {
    if (!credentialErrorLogged) {
      credentialErrorLogged = true;
      console.error('[push] Firebase initialization failed:', error.message);
    }
    return null;
  }
};

export const sendPushToUsers = async (userIds, { type, title, body, relatedType, relatedId }) => {
  const ids = [...new Set((userIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return;

  const messaging = messagingClient();
  if (!messaging) return;

  try {
    const installations = await sql`
      SELECT installation_id AS "installationId"
      FROM push_installations WHERE user_id = ANY(${ids}::int[])
    `;
    const fids = installations.map(({ installationId }) => installationId).filter(Boolean);

    for (let offset = 0; offset < fids.length; offset += CHUNK_SIZE) {
      const batch = fids.slice(offset, offset + CHUNK_SIZE);
      try {
        const result = await messaging.sendEachForMulticast({
          fids: batch,
          notification: { title, body: notificationBody(body) },
          data: {
            type: String(type),
            relatedType: String(relatedType),
            relatedId: String(relatedId),
          },
          android: {
            priority: 'high',
            notification: {
              channelId: 'academic_updates',
              clickAction: 'com.example.galaxycollege.OPEN_UPDATES',
            },
          },
        });
        const staleFids = result.responses.flatMap((response, index) => {
          const code = response.error?.code;
          return code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token'
            ? [batch[index]]
            : [];
        });
        if (staleFids.length) {
          await sql`DELETE FROM push_installations WHERE installation_id = ANY(${staleFids}::text[])`;
        }
      } catch (error) {
        console.error('[push] Delivery batch failed:', error.message);
      }
    }
  } catch (error) {
    // Push is best effort; the persisted in-app notification remains available.
    console.error('[push] Could not load notification recipients:', error.message);
  }
};
