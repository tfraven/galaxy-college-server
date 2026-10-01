import bcrypt from 'bcryptjs';
import { db } from './connection.js';
import { initSchema } from './schema.js';

export const seedDatabase = async () => {
  initSchema();

  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  if (userCount > 0) {
    console.log('Database already contains records. Skipping seed.');
    return;
  }

  console.log('Seeding College Runner database with initial data...');

  const defaultPasswordHash = bcrypt.hashSync('password123', 10);

  // 1. Classes
  const insertClass = db.prepare('INSERT INTO classes (level, grp, name) VALUES (?, ?, ?)');
  const c1 = insertClass.run(1, 1, '1st Year Pre-Engineering').lastInsertRowid;
  const c2 = insertClass.run(1, 2, '1st Year Pre-Medical').lastInsertRowid;
  const c3 = insertClass.run(1, 3, '1st Year Computer Science').lastInsertRowid;
  const c4 = insertClass.run(2, 1, '2nd Year Pre-Engineering').lastInsertRowid;

  // 2. Sections
  const insertSection = db.prepare('INSERT INTO sections (class_id, name) VALUES (?, ?)');
  const secA1 = insertSection.run(c1, 'Section A').lastInsertRowid;
  insertSection.run(c1, 'Section B');
  insertSection.run(c2, 'Section A');
  insertSection.run(c3, 'Section A');

  // 3. Subjects
  const insertSubject = db.prepare('INSERT INTO subjects (name) VALUES (?)');
  const subPhysics = insertSubject.run('Physics').lastInsertRowid;
  const subChemistry = insertSubject.run('Chemistry').lastInsertRowid;
  const subMath = insertSubject.run('Mathematics').lastInsertRowid;
  const subCompSci = insertSubject.run('Computer Science').lastInsertRowid;
  const subBio = insertSubject.run('Biology').lastInsertRowid;
  const subEnglish = insertSubject.run('English').lastInsertRowid;

  // 4. Courses (Class + Subject)
  const insertCourse = db.prepare('INSERT INTO courses (class_id, subject_id) VALUES (?, ?)');
  const crsPhy1 = insertCourse.run(c1, subPhysics).lastInsertRowid;
  const crsChem1 = insertCourse.run(c1, subChemistry).lastInsertRowid;
  const crsMath1 = insertCourse.run(c1, subMath).lastInsertRowid;
  const crsEng1 = insertCourse.run(c1, subEnglish).lastInsertRowid;
  insertCourse.run(c2, subBio);
  insertCourse.run(c3, subCompSci);

  // 5. Users
  const insertUser = db.prepare(`
    INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
    VALUES (?, ?, ?, ?, ?, 1, 0)
  `);

  const adminId = insertUser.run(1, 'admin', defaultPasswordHash, 'Prof. Aslam Pervez (Dean)', '+923001112233').lastInsertRowid;
  const opId = insertUser.run(2, 'operator', defaultPasswordHash, 'Kamran Abbasi (Exam Cell)', '+923004445566').lastInsertRowid;
  const teacherId = insertUser.run(3, 'teacher', defaultPasswordHash, 'Prof. Tariq Mahmood (HOD Physics)', '+923007778899').lastInsertRowid;
  const teacher2Id = insertUser.run(3, 'dr_ayesha', defaultPasswordHash, 'Dr. Ayesha Siddiqa (Chemistry)', '+923008889900').lastInsertRowid;

  // Assign teachers to courses
  const insertTeacherCourse = db.prepare('INSERT INTO teacher_courses (user_id, course_id) VALUES (?, ?)');
  insertTeacherCourse.run(teacherId, crsPhy1);
  insertTeacherCourse.run(teacher2Id, crsChem1);

  // Students
  const insertStudent = db.prepare('INSERT INTO students (user_id, class_id, section_id) VALUES (?, ?, ?)');

  const s1 = insertUser.run(4, 'PE1-1001', defaultPasswordHash, 'Ahmed Ali', '+923001234561').lastInsertRowid;
  insertStudent.run(s1, c1, secA1);

  const s2 = insertUser.run(4, 'PE1-1002', defaultPasswordHash, 'Fatima Zahra', '+923001234562').lastInsertRowid;
  insertStudent.run(s2, c1, secA1);

  const s3 = insertUser.run(4, 'PE1-1003', defaultPasswordHash, 'Muhammad Bilal', '+923001234563').lastInsertRowid;
  insertStudent.run(s3, c1, secA1);

  const s4 = insertUser.run(4, 'PM1-1001', defaultPasswordHash, 'Zainab Noor', '+923001234564').lastInsertRowid;
  insertStudent.run(s4, c2, null);

  const s5 = insertUser.run(4, 'CS1-1001', defaultPasswordHash, 'Hamza Tariq', '+923001234565').lastInsertRowid;
  insertStudent.run(s5, c3, null);

  // 6. Questions (Catalog)
  const insertQuestion = db.prepare(`
    INSERT INTO questions (course_id, topic, body, image, opt_a, opt_b, opt_c, opt_d, correct, explanation, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const q1 = insertQuestion.run(
    crsPhy1,
    'Thermodynamics',
    'A heat engine operates between temperatures 500 K and 300 K. What is the maximum theoretical efficiency achievable?',
    'https://images.unsplash.com/photo-1635070041078-e363dbe005cb?auto=format&fit=crop&w=800&q=80',
    '60%',
    '40%',
    '25%',
    '50%',
    'B',
    'Carnot efficiency = 1 - (Tc / Th) = 1 - (300/500) = 1 - 0.6 = 0.40 (40%).',
    teacherId
  ).lastInsertRowid;

  const q2 = insertQuestion.run(
    crsPhy1,
    'Vectors & Equilibrium',
    'Two forces of magnitudes 6 N and 8 N act at a right angle (90°) to each other. The magnitude of their resultant force is:',
    null,
    '14 N',
    '2 N',
    '10 N',
    '48 N',
    'C',
    'Resultant R = sqrt(F1^2 + F2^2) = sqrt(6^2 + 8^2) = sqrt(36 + 64) = sqrt(100) = 10 N.',
    teacherId
  ).lastInsertRowid;

  const q3 = insertQuestion.run(
    crsPhy1,
    'Motion & Force',
    'A projectile is launched with velocity v at an angle of 30° to the horizontal. At what complementary angle will the horizontal range be the same?',
    'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=800&q=80',
    '45°',
    '60°',
    '90°',
    '15°',
    'B',
    'Horizontal range of a projectile is identical for complementary angles theta and (90° - theta). For 30°, the complement is 60°.',
    teacherId
  ).lastInsertRowid;

  const q4 = insertQuestion.run(
    crsPhy1,
    'Circular Motion',
    'When a body moves along a circular path with constant speed, the work done by the centripetal force is always:',
    null,
    'Maximum',
    'Negative',
    'Positive',
    'Zero',
    'D',
    'Centripetal force is perpendicular to instantaneous displacement at all points (angle 90°), so W = F * d * cos(90°) = 0.',
    teacherId
  ).lastInsertRowid;

  const q5 = insertQuestion.run(
    crsPhy1,
    'Work & Energy',
    'If the momentum of a moving body is doubled, its kinetic energy increases by what factor?',
    null,
    '2 times',
    '4 times',
    '8 times',
    'Remains unchanged',
    'B',
    'Kinetic energy KE = p^2 / (2m). Since KE is proportional to p^2, doubling momentum quadruples KE (factor of 4).',
    teacherId
  ).lastInsertRowid;

  const q6 = insertQuestion.run(
    crsChem1,
    'Stoichiometry',
    'How many moles of oxygen gas (O2) are required to completely react with 2 moles of Hydrogen gas (H2) to form liquid water?',
    null,
    '1 mole',
    '2 moles',
    '0.5 moles',
    '4 moles',
    'A',
    'Balanced equation: 2H2 + O2 -> 2H2O. Thus 2 moles of H2 require exactly 1 mole of O2.',
    teacher2Id
  ).lastInsertRowid;

  // 7. Tests
  const insertTest = db.prepare(`
    INSERT INTO tests (
      course_id, section_id, title, duration_min, mark_per_q, neg_mark,
      shuffle_q, shuffle_opt, start_at, end_at, result_mode, results_released, status, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date();
  const startAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const endAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Test 1: Published Physics Midterm
  const t1 = insertTest.run(
    crsPhy1,
    null,
    'Midterm Examination: Mechanics & Thermodynamics',
    15,
    2,
    0.5,
    1,
    1,
    startAt,
    endAt,
    1,
    1,
    2, // Published
    teacherId
  ).lastInsertRowid;

  // Link questions to Test 1
  const insertTestQ = db.prepare('INSERT INTO test_questions (test_id, question_id) VALUES (?, ?)');
  insertTestQ.run(t1, q1);
  insertTestQ.run(t1, q2);
  insertTestQ.run(t1, q3);
  insertTestQ.run(t1, q4);
  insertTestQ.run(t1, q5);

  // Test 2: Published Chemistry Quiz
  const t2 = insertTest.run(
    crsChem1,
    null,
    'Chemistry Fundamental Stoichiometry Quiz',
    10,
    1,
    0,
    1,
    1,
    startAt,
    endAt,
    1,
    1,
    2, // Published
    teacher2Id
  ).lastInsertRowid;
  insertTestQ.run(t2, q6);

  // 8. Sample completed attempt for student 1 (Ahmed Ali) on Test 2
  const insertAttempt = db.prepare(`
    INSERT INTO attempts (test_id, student_id, seed, started_at, deadline_at, submitted_at, correct_cnt, wrong_cnt, score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const pastStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const pastSubmit = new Date(now.getTime() - 24 * 60 * 60 * 1000 + 7 * 60 * 1000).toISOString();
  const att1 = insertAttempt.run(
    t2,
    s1,
    10492,
    pastStart,
    pastSubmit,
    pastSubmit,
    1,
    0,
    1.0
  ).lastInsertRowid;

  const insertAnswer = db.prepare('INSERT INTO attempt_answers (attempt_id, question_id, chosen) VALUES (?, ?, ?)');
  insertAnswer.run(att1, q6, 'A');

  // 9. Live Sessions
  const insertSession = db.prepare(`
    INSERT INTO live_sessions (
      class_id, section_id, course_name, title, host_id,
      plan_start, plan_end, status, started_at, zoom_session_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Active Live Session (Status 2 = LIVE)
  const session1 = insertSession.run(
    c1,
    secA1,
    'Physics',
    'Physics Ch 3: Projectile Motion & Numerical Problem Solving',
    teacherId,
    now.toISOString(),
    new Date(now.getTime() + 90 * 60 * 1000).toISOString(),
    2, // LIVE
    now.toISOString(),
    'zoom_session_physics_101'
  ).lastInsertRowid;

  // Scheduled Session (Status 1 = SCHEDULED)
  insertSession.run(
    c1,
    null,
    'Chemistry',
    'Chemistry: Chemical Bonding & Hybridization Theory',
    teacher2Id,
    new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString(),
    new Date(now.getTime() + 4.5 * 60 * 60 * 1000).toISOString(),
    1, // SCHEDULED
    null,
    'zoom_session_chem_102'
  );

  console.log('Database successfully seeded:');
  console.log('  - Admin: admin / password123');
  console.log('  - Operator: operator / password123');
  console.log('  - Faculty: teacher / password123');
  console.log('  - Student: PE1-1001 / password123');
  console.log('  - 1 Live Session, 2 Tests, 6 Questions created.');
};

// Execute if run directly from CLI
if (process.argv[1]?.endsWith('seed.js')) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed error:', err);
      process.exit(1);
    });
}
