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
      zoom_session_pwd TEXT
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS session_joins (
      session_id INTEGER NOT NULL REFERENCES live_sessions(id),
      student_id INTEGER NOT NULL REFERENCES users(id),
      first_join TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(session_id, student_id)
    )
  `;

  console.log('PostgreSQL schema initialized successfully.');
};
