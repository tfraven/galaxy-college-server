import { getFirebaseMessaging } from '../config/firebaseAdmin.js';
import { sql } from '../db/connection.js';

const CHUNK_SIZE = 500;

const notificationBody = (body) => {
  const text = String(body);
  let preview = '';
  for (const character of text) {
    if (Buffer.byteLength(preview + character, 'utf8') > 1600) break;
    preview += character;
  }
  return preview.length < text.length ? `${preview}…` : preview;
};

export const sendPushToUsers = async (userIds, { type, title, body, relatedType, relatedId }) => {
  const ids = [...new Set((userIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return;

  const messaging = getFirebaseMessaging();
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
