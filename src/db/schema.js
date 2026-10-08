import { sql } from './connection.js';

export const initSchema = async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      role INTEGER NOT NULL, -- 1: Admin, 2: Operator, 3: Teacher, 4: Student
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      must_change_pw BOOLEAN DEFAULT FALSE,
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS classes (
      id SERIAL PRIMARY KEY,
      level INTEGER NOT NULL, -- 1: 1st Year, 2: 2nd Year, 3: Entry
      grp INTEGER NOT NULL,   -- 1: Pre-Eng, 2: Pre-Med, 3: Comp Sci
      name TEXT NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      UNIQUE(level, grp)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sections (
      id SERIAL PRIMARY KEY,
      class_id INTEGER NOT NULL REFERENCES classes(id),
      name TEXT NOT NULL,
      UNIQUE(class_id, name)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS subjects (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS courses (
      id SERIAL PRIMARY KEY,
      class_id INTEGER NOT NULL REFERENCES classes(id),
      subject_id INTEGER NOT NULL REFERENCES subjects(id),
      UNIQUE(class_id, subject_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS teacher_courses (
      user_id INTEGER NOT NULL REFERENCES users(id),
      course_id INTEGER NOT NULL REFERENCES courses(id),
      PRIMARY KEY(user_id, course_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS students (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      class_id INTEGER NOT NULL REFERENCES classes(id),
      section_id INTEGER REFERENCES sections(id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES courses(id),
      topic TEXT,
      body TEXT NOT NULL,
      image TEXT,
      opt_a TEXT NOT NULL,
      opt_b TEXT NOT NULL,
      opt_c TEXT NOT NULL,
      opt_d TEXT NOT NULL,
      correct TEXT NOT NULL CHECK(correct IN ('A','B','C','D')),
      explanation TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS tests (
      id SERIAL PRIMARY KEY,
      course_id INTEGER NOT NULL REFERENCES courses(id),
      section_id INTEGER REFERENCES sections(id),
      title TEXT NOT NULL,
      duration_min INTEGER NOT NULL,
      mark_per_q NUMERIC DEFAULT 1,
      neg_mark NUMERIC DEFAULT 0,
      shuffle_q BOOLEAN DEFAULT TRUE,
      shuffle_opt BOOLEAN DEFAULT TRUE,
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      result_mode INTEGER DEFAULT 1, -- 1: Immediate, 2: After close, 3: Manual
      results_released BOOLEAN DEFAULT TRUE,
      status INTEGER DEFAULT 1, -- 1: Draft, 2: Published, 3: Closed
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS test_questions (
      test_id INTEGER NOT NULL REFERENCES tests(id),
      question_id INTEGER NOT NULL REFERENCES questions(id),
      PRIMARY KEY(test_id, question_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS attempts (
      id SERIAL PRIMARY KEY,
      test_id INTEGER NOT NULL REFERENCES tests(id),
      student_id INTEGER NOT NULL REFERENCES users(id),
      seed INTEGER NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      deadline_at TIMESTAMPTZ NOT NULL,
      submitted_at TIMESTAMPTZ,
      correct_cnt INTEGER,
      wrong_cnt INTEGER,
      score NUMERIC,
      UNIQUE(test_id, student_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS attempt_answers (
      attempt_id INTEGER NOT NULL REFERENCES attempts(id),
      question_id INTEGER NOT NULL REFERENCES questions(id),
      chosen TEXT CHECK(chosen IN ('A','B','C','D')),
      PRIMARY KEY(attempt_id, question_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS live_sessions (
      id SERIAL PRIMARY KEY,
      class_id INTEGER NOT NULL REFERENCES classes(id),
      section_id INTEGER REFERENCES sections(id),
      course_name TEXT,
      title TEXT NOT NULL,
      host_id INTEGER REFERENCES users(id),
      plan_start TIMESTAMPTZ NOT NULL,
      plan_end TIMESTAMPTZ NOT NULL,
      status INTEGER DEFAULT 1, -- 1: Scheduled, 2: Live, 3: Ended
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      created_by INTEGER REFERENCES users(id),
      zoom_session_id TEXT,
      zoom_session_pwd TEXT,
      zoom_meeting_id TEXT,
      zoom_passcode TEXT,
      zoom_join_url TEXT
    )
  `;

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0
  `;
  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS active_device_id TEXT,
    ADD COLUMN IF NOT EXISTS active_device_label TEXT,
    ADD COLUMN IF NOT EXISTS device_last_seen_at TIMESTAMPTZ
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username))`;

  await sql`
    CREATE TABLE IF NOT EXISTS device_login_requests (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      device_label TEXT NOT NULL,
      approval_key_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'superseded')),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      decided_at TIMESTAMPTZ,
      approved_token_version INTEGER
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_device_login_requests_pending ON device_login_requests (user_id, requested_at DESC) WHERE status = 'pending'`;

  await sql`
    CREATE TABLE IF NOT EXISTS security_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS login_rate_limits (
      ip_hash TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      reset_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_login_rate_limits_reset_at ON login_rate_limits (reset_at)`;

  // Databases created before the Zoom Video SDK migration may lack these; harmless otherwise.
  await sql`
    ALTER TABLE live_sessions
    ADD COLUMN IF NOT EXISTS zoom_meeting_id TEXT,
    ADD COLUMN IF NOT EXISTS zoom_passcode TEXT,
    ADD COLUMN IF NOT EXISTS zoom_join_url TEXT
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS session_joins (
      session_id INTEGER NOT NULL REFERENCES live_sessions(id),
      student_id INTEGER NOT NULL REFERENCES users(id),
      first_join TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(session_id, student_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS session_messages (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_name TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('announcement', 'live_scheduled', 'live_started', 'exam_published')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      related_type TEXT NOT NULL,
      related_id INTEGER NOT NULL,
      event_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at TIMESTAMPTZ,
      UNIQUE (user_id, event_key)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL`;
  await sql`
    CREATE TABLE IF NOT EXISTS push_installations (
      installation_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_push_installations_user ON push_installations (user_id)`;

  // Indexes for the hot paths: auto-submit job, student lists, session lists, question picking.
  await sql`CREATE INDEX IF NOT EXISTS idx_attempts_open ON attempts (deadline_at) WHERE submitted_at IS NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_attempts_student ON attempts (student_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_questions_course ON questions (course_id) WHERE is_active`;
  await sql`CREATE INDEX IF NOT EXISTS idx_test_questions_q ON test_questions (question_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_tests_course ON tests (course_id, status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_class ON live_sessions (class_id, status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_students_class ON students (class_id, section_id)`;

  console.log('PostgreSQL schema initialized successfully.');
};
