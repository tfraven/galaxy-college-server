import { sql } from '../db/connection.js';
import { notifyStudents } from './notifications.js';
import { createZoomMeeting } from './zoom.js';

const localDateParts = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return { year: Number(get('year')), month: Number(get('month')), day: Number(get('day')) };
};

const addDays = ({ year, month, day }, amount) => {
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
};

const dateKey = ({ year, month, day }) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const zonedLocalDateTimeToUtc = (date, time, timeZone) => {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let candidate = guess;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = formatter.formatToParts(new Date(candidate));
    const get = (type) => Number(parts.find((part) => part.type === type)?.value);
    const represented = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    candidate = guess - (represented - candidate);
  }
  return new Date(candidate);
};

const weekdayFor = ({ year, month, day }) => new Date(Date.UTC(year, month - 1, day)).getUTCDay();

/**
 * Creates each occurrence once and advances scheduled/live rows from wall-clock times.
 * Called by both the hosted process timer and the authenticated platform cron endpoint.
 */
export const runLiveSessionScheduler = async (now = new Date()) => {
  const schedules = await sql`
    SELECT r.id, r.class_id, r.section_id, r.course_name, r.title, r.host_id, r.timezone, r.weekly_slots,
           r.zoom_account,
           ARRAY(SELECT rvp.user_id FROM recurring_video_participants rvp WHERE rvp.schedule_id = r.id ORDER BY rvp.user_id) AS video_participant_ids
    FROM recurring_live_schedules r WHERE enabled = TRUE AND deleted_at IS NULL
  `;
  const todayByTimezone = new Map();
  let created = 0;

  for (const schedule of schedules) {
    const timeZone = schedule.timezone || 'Asia/Karachi';
    let today = todayByTimezone.get(timeZone);
    if (!today) {
      today = localDateParts(now, timeZone);
      todayByTimezone.set(timeZone, today);
    }
    const slots = Array.isArray(schedule.weekly_slots) ? schedule.weekly_slots : [];
    const occurrences = [];
    for (let dayOffset = 0; dayOffset < 14; dayOffset += 1) {
      const localDate = addDays(today, dayOffset);
      const weekday = weekdayFor(localDate);
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
        const slot = slots[slotIndex];
        if (Number(slot.weekday) !== weekday) continue;
        const key = `${dateKey(localDate)}:${slotIndex}`;
        const start = zonedLocalDateTimeToUtc(dateKey(localDate), slot.startTime, timeZone);
        const end = zonedLocalDateTimeToUtc(dateKey(localDate), slot.endTime, timeZone);
        if (end <= now) continue;
        occurrences.push({
          key,
          start,
          end,
        });
      }
    }
    const existingOccurrences = occurrences.length
      ? await sql`SELECT recurrence_key FROM live_sessions WHERE recurring_schedule_id = ${schedule.id} AND recurrence_key = ANY(${occurrences.map(({ key }) => key)}::text[])`
      : [];
    const existingKeys = new Set(existingOccurrences.map(({ recurrence_key }) => recurrence_key));
    for (const occurrence of occurrences) {
      if (existingKeys.has(occurrence.key)) continue;
        const meeting = await createZoomMeeting(schedule.zoom_account || 'account1', {
          title: schedule.title,
          planStart: occurrence.start,
          planEnd: occurrence.end,
        });
        const [session] = await sql`
          INSERT INTO live_sessions (
            class_id, section_id, course_name, title, host_id, plan_start, plan_end,
            status, created_by, recurring_schedule_id, recurrence_key, video_enabled,
            zoom_account, zoom_meeting_id, zoom_passcode, zoom_join_url
          )
          SELECT class_id, section_id, course_name, title, host_id, ${occurrence.start.toISOString()}, ${occurrence.end.toISOString()},
                 1, created_by, id, ${occurrence.key}, TRUE, ${schedule.zoom_account || 'account1'},
                 ${meeting.meetingId}, ${meeting.passcode}, ${meeting.joinUrl}
          FROM recurring_live_schedules WHERE id = ${schedule.id} AND enabled = TRUE AND deleted_at IS NULL
          ON CONFLICT (recurring_schedule_id, recurrence_key) WHERE recurrence_key IS NOT NULL DO NOTHING
          RETURNING id, class_id, section_id, course_name, title, plan_start
        `;
        if (!session) continue;
        const allowedIds = Array.isArray(schedule.video_participant_ids) ? schedule.video_participant_ids : [];
        if (allowedIds.length) {
          await sql`
            INSERT INTO video_participant_sessions (session_id, user_id, created_by)
            SELECT ${session.id}, value, ${schedule.host_id} FROM unnest(${allowedIds}::int[]) AS value
            ON CONFLICT DO NOTHING
          `;
        }
        created += 1;
        await notifyStudents({
          type: 'live_scheduled', title: `Live class scheduled: ${session.title}`,
          body: `${session.course_name || 'General'} • ${new Date(session.plan_start).toLocaleString()}`,
          relatedType: 'live_session', relatedId: session.id, eventKey: `live_scheduled:${session.id}`,
          classId: session.class_id, sectionId: session.section_id,
        });
    }
  }

  const started = await sql`
    UPDATE live_sessions SET status = 2, started_at = COALESCE(started_at, plan_start)
    WHERE recurring_schedule_id IS NOT NULL AND status = 1
      AND plan_start <= ${now.toISOString()} AND plan_end > ${now.toISOString()}
      AND EXISTS (
        SELECT 1 FROM recurring_live_schedules r
        WHERE r.id = live_sessions.recurring_schedule_id AND r.enabled = TRUE AND r.deleted_at IS NULL
      )
    RETURNING id, class_id, section_id, course_name, title
  `;
  for (const session of started) {
    await notifyStudents({
      type: 'live_started', title: `Live class is starting: ${session.title}`,
      body: `${session.course_name || 'General'} is live now.`,
      relatedType: 'live_session', relatedId: session.id, eventKey: `live_started:${session.id}`,
      classId: session.class_id, sectionId: session.section_id,
    });
  }

  const ended = await sql`
    UPDATE live_sessions SET status = 3, ended_at = COALESCE(ended_at, plan_end)
    WHERE recurring_schedule_id IS NOT NULL AND status IN (1, 2) AND plan_end <= ${now.toISOString()}
    RETURNING id
  `;
  return { created, started: started.length, ended: ended.length };
};
