import { db } from './connection.js';

export const initSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role INTEGER NOT NULL, -- 1: Admin, 2: Operator, 3: Teacher, 4: Student
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT,
      is_active INTEGER DEFAULT 1,
      must_change_pw INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level INTEGER NOT NULL, -- 1: 1st Year, 2: 2nd Year, 3: Entry
      grp INTEGER NOT NULL,   -- 1: Pre-Eng, 2: Pre-Med, 3: Comp Sci
      name TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      UNIQUE(level, grp)
    );

    CREATE TABLE IF NOT EXISTS sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      UNIQUE(class_id, name),
      FOREIGN KEY(class_id) REFERENCES classes(id)
    );

    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      subject_id INTEGER NOT NULL,
      UNIQUE(class_id, subject_id),
      FOREIGN KEY(class_id) REFERENCES classes(id),
      FOREIGN KEY(subject_id) REFERENCES subjects(id)
    );

    CREATE TABLE IF NOT EXISTS teacher_courses (
      user_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      PRIMARY KEY(user_id, course_id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(course_id) REFERENCES courses(id)
    );

    CREATE TABLE IF NOT EXISTS students (
      user_id INTEGER PRIMARY KEY,
      class_id INTEGER NOT NULL,
      section_id INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(class_id) REFERENCES classes(id),
      FOREIGN KEY(section_id) REFERENCES sections(id)
    );

    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      topic TEXT,
      body TEXT NOT NULL,
      image TEXT,
      opt_a TEXT NOT NULL,
      opt_b TEXT NOT NULL,
      opt_c TEXT NOT NULL,
      opt_d TEXT NOT NULL,
      correct TEXT NOT NULL CHECK(correct IN ('A','B','C','D')),
      explanation TEXT,
      is_active INTEGER DEFAULT 1,
      created_by INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(course_id) REFERENCES courses(id),
      FOREIGN KEY(created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      section_id INTEGER,
      title TEXT NOT NULL,
      duration_min INTEGER NOT NULL,
      mark_per_q INTEGER DEFAULT 1,
      neg_mark REAL DEFAULT 0,
      shuffle_q INTEGER DEFAULT 1,
      shuffle_opt INTEGER DEFAULT 1,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      result_mode INTEGER DEFAULT 1, -- 1: Immediate, 2: After close, 3: Manual
      results_released INTEGER DEFAULT 1,
      status INTEGER DEFAULT 1, -- 1: Draft, 2: Published, 3: Closed
      created_by INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(course_id) REFERENCES courses(id),
      FOREIGN KEY(section_id) REFERENCES sections(id),
      FOREIGN KEY(created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS test_questions (
      test_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      PRIMARY KEY(test_id, question_id),
      FOREIGN KEY(test_id) REFERENCES tests(id),
      FOREIGN KEY(question_id) REFERENCES questions(id)
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      seed INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      submitted_at TEXT,
      correct_cnt INTEGER,
      wrong_cnt INTEGER,
      score REAL,
      UNIQUE(test_id, student_id),
      FOREIGN KEY(test_id) REFERENCES tests(id),
      FOREIGN KEY(student_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS attempt_answers (
      attempt_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      chosen TEXT CHECK(chosen IN ('A','B','C','D') OR chosen IS NULL),
      PRIMARY KEY(attempt_id, question_id),
      FOREIGN KEY(attempt_id) REFERENCES attempts(id),
      FOREIGN KEY(question_id) REFERENCES questions(id)
    );

    CREATE TABLE IF NOT EXISTS live_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      section_id INTEGER,
      course_name TEXT,
      title TEXT NOT NULL,
      host_id INTEGER,
      plan_start TEXT NOT NULL,
      plan_end TEXT NOT NULL,
      status INTEGER DEFAULT 1, -- 1: Scheduled, 2: Live, 3: Ended
      started_at TEXT,
      ended_at TEXT,
      created_by INTEGER,
      zoom_session_id TEXT,
      zoom_session_pwd TEXT,
      FOREIGN KEY(class_id) REFERENCES classes(id),
      FOREIGN KEY(section_id) REFERENCES sections(id),
      FOREIGN KEY(host_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS session_joins (
      session_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      first_join TEXT DEFAULT (datetime('now')),
      PRIMARY KEY(session_id, student_id),
      FOREIGN KEY(session_id) REFERENCES live_sessions(id),
      FOREIGN KEY(student_id) REFERENCES users(id)
    );
  `);
};
