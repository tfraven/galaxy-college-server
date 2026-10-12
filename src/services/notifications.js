import { sql } from '../db/connection.js';
import { sendPushToUsers } from './pushNotifications.js';

/** Save an in-app notification and send a best-effort native push to matching students. */
export const notifyStudents = async ({ type, title, body, relatedType, relatedId, eventKey, classId, sectionId = null }) => {
  const targetClassId = Number(classId);
  const targetSectionId = sectionId == null ? null : Number(sectionId);
  if (!Number.isSafeInteger(targetClassId) || targetClassId <= 0) {
    throw new TypeError('A valid classId is required when notifying students.');
  }
  if (targetSectionId !== null && (!Number.isSafeInteger(targetSectionId) || targetSectionId <= 0)) {
    throw new TypeError('sectionId must be a positive integer when provided.');
  }

  const created = await sql`
    INSERT INTO notifications (user_id, type, title, body, related_type, related_id, event_key)
    SELECT u.id, ${type}, ${title}, ${body}, ${relatedType}, ${relatedId}, ${eventKey}
    FROM users u
    JOIN students s ON s.user_id = u.id
    WHERE u.role = 4 AND u.is_active = TRUE
      AND s.class_id = ${targetClassId}
      AND (${targetSectionId}::int IS NULL OR s.section_id = ${targetSectionId}::int)
    ON CONFLICT (user_id, event_key) DO NOTHING
    RETURNING user_id AS "userId"
  `;
  await sendPushToUsers(created.map(({ userId }) => userId), { type, title, body, relatedType, relatedId });
};
