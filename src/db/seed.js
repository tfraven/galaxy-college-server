import bcrypt from 'bcryptjs';
import { sql } from './connection.js';
import { initSchema } from './schema.js';

export const seedDatabase = async () => {
  await initSchema();

  const [{ cnt }] = await sql`SELECT COUNT(*)::int as cnt FROM users`;
  if (cnt > 0) {
    console.log('Database already contains records. Skipping seed.');
    return;
  }

  console.log('Seeding College Runner database with initial data...');

  const defaultPasswordHash = await bcrypt.hash('password123', 10);

  // 1. Classes
  const [{ id: c1 }] = await sql`INSERT INTO classes (level, grp, name) VALUES (1, 1, '1st Year Pre-Engineering') RETURNING id`;
  const [{ id: c2 }] = await sql`INSERT INTO classes (level, grp, name) VALUES (1, 2, '1st Year Pre-Medical') RETURNING id`;
  const [{ id: c3 }] = await sql`INSERT INTO classes (level, grp, name) VALUES (1, 3, '1st Year Computer Science') RETURNING id`;
  await sql`INSERT INTO classes (level, grp, name) VALUES (2, 1, '2nd Year Pre-Engineering')`;

  // 2. Sections
  const [{ id: secA1 }] = await sql`INSERT INTO sections (class_id, name) VALUES (${c1}, 'Section A') RETURNING id`;
  await sql`INSERT INTO sections (class_id, name) VALUES (${c1}, 'Section B')`;
  await sql`INSERT INTO sections (class_id, name) VALUES (${c2}, 'Section A')`;
  await sql`INSERT INTO sections (class_id, name) VALUES (${c3}, 'Section A')`;

  // 3. Subjects
  const [{ id: subPhysics }]   = await sql`INSERT INTO subjects (name) VALUES ('Physics') RETURNING id`;
  const [{ id: subChemistry }] = await sql`INSERT INTO subjects (name) VALUES ('Chemistry') RETURNING id`;
  const [{ id: subMath }]      = await sql`INSERT INTO subjects (name) VALUES ('Mathematics') RETURNING id`;
  const [{ id: subCompSci }]   = await sql`INSERT INTO subjects (name) VALUES ('Computer Science') RETURNING id`;
  const [{ id: subBio }]       = await sql`INSERT INTO subjects (name) VALUES ('Biology') RETURNING id`;
  await sql`INSERT INTO subjects (name) VALUES ('English')`;

  // 4. Courses
  const [{ id: crsPhy1 }]   = await sql`INSERT INTO courses (class_id, subject_id) VALUES (${c1}, ${subPhysics}) RETURNING id`;
  const [{ id: crsChem1 }]  = await sql`INSERT INTO courses (class_id, subject_id) VALUES (${c1}, ${subChemistry}) RETURNING id`;
  await sql`INSERT INTO courses (class_id, subject_id) VALUES (${c1}, ${subMath})`;
  await sql`INSERT INTO courses (class_id, subject_id) VALUES (${c2}, ${subBio})`;
  await sql`INSERT INTO courses (class_id, subject_id) VALUES (${c3}, ${subCompSci})`;

  // 5. Users
  const [{ id: adminId }]   = await sql`
    INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
    VALUES (1, 'admin', ${defaultPasswordHash}, 'Prof. Aslam Pervez (Dean)', '+923001112233', TRUE, FALSE) RETURNING id`;

  await sql`
    INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
    VALUES (2, 'operator', ${defaultPasswordHash}, 'Kamran Abbasi (Exam Cell)', '+923004445566', TRUE, FALSE)`;

  const [{ id: teacherId }]  = await sql`
    INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
    VALUES (3, 'teacher', ${defaultPasswordHash}, 'Prof. Tariq Mahmood (HOD Physics)', '+923007778899', TRUE, FALSE) RETURNING id`;

  const [{ id: teacher2Id }] = await sql`
    INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
    VALUES (3, 'dr_ayesha', ${defaultPasswordHash}, 'Dr. Ayesha Siddiqa (Chemistry)', '+923008889900', TRUE, FALSE) RETURNING id`;

  // Teacher -> course assignments
  await sql`INSERT INTO teacher_courses (user_id, course_id) VALUES (${teacherId}, ${crsPhy1})`;
  await sql`INSERT INTO teacher_courses (user_id, course_id) VALUES (${teacher2Id}, ${crsChem1})`;

  // Students
  const [{ id: s1 }] = await sql`
    INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
    VALUES (4, 'PE1-1001', ${defaultPasswordHash}, 'Ahmed Ali', '+923001234561', TRUE, FALSE) RETURNING id`;
  await sql`INSERT INTO students (user_id, class_id, section_id) VALUES (${s1}, ${c1}, ${secA1})`;

  const [{ id: s2 }] = await sql`
    INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
    VALUES (4, 'PE1-1002', ${defaultPasswordHash}, 'Fatima Zahra', '+923001234562', TRUE, FALSE) RETURNING id`;
  await sql`INSERT INTO students (user_id, class_id, section_id) VALUES (${s2}, ${c1}, ${secA1})`;

  const [{ id: s3 }] = await sql`
    INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
    VALUES (4, 'PE1-1003', ${defaultPasswordHash}, 'Muhammad Bilal', '+923001234563', TRUE, FALSE) RETURNING id`;
  await sql`INSERT INTO students (user_id, class_id, section_id) VALUES (${s3}, ${c1}, ${secA1})`;

  const [{ id: s4 }] = await sql`
    INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
    VALUES (4, 'PM1-1001', ${defaultPasswordHash}, 'Zainab Noor', '+923001234564', TRUE, FALSE) RETURNING id`;
  await sql`INSERT INTO students (user_id, class_id, section_id) VALUES (${s4}, ${c2}, NULL)`;

  const [{ id: s5 }] = await sql`
    INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
    VALUES (4, 'CS1-1001', ${defaultPasswordHash}, 'Hamza Tariq', '+923001234565', TRUE, FALSE) RETURNING id`;
  await sql`INSERT INTO students (user_id, class_id, section_id) VALUES (${s5}, ${c3}, NULL)`;

  // 6. Questions
  const [{ id: q1 }] = await sql`
    INSERT INTO questions (course_id, topic, body, image, opt_a, opt_b, opt_c, opt_d, correct, explanation, created_by)
    VALUES (
      ${crsPhy1}, 'Thermodynamics',
      'A heat engine operates between temperatures 500 K and 300 K. What is the maximum theoretical efficiency achievable?',
      'https://images.unsplash.com/photo-1635070041078-e363dbe005cb?auto=format&fit=crop&w=800&q=80',
      '60%', '40%', '25%', '50%', 'B',
      'Carnot efficiency = 1 - (Tc / Th) = 1 - (300/500) = 1 - 0.6 = 0.40 (40%).',
      ${teacherId}
    ) RETURNING id`;

  const [{ id: q2 }] = await sql`
    INSERT INTO questions (course_id, topic, body, image, opt_a, opt_b, opt_c, opt_d, correct, explanation, created_by)
    VALUES (
      ${crsPhy1}, 'Vectors & Equilibrium',
      'Two forces of magnitudes 6 N and 8 N act at a right angle (90°) to each other. The magnitude of their resultant force is:',
      NULL,
      '14 N', '2 N', '10 N', '48 N', 'C',
      'Resultant R = sqrt(F1^2 + F2^2) = sqrt(6^2 + 8^2) = sqrt(36 + 64) = sqrt(100) = 10 N.',
      ${teacherId}
    ) RETURNING id`;

  const [{ id: q3 }] = await sql`
    INSERT INTO questions (course_id, topic, body, image, opt_a, opt_b, opt_c, opt_d, correct, explanation, created_by)
    VALUES (
      ${crsPhy1}, 'Motion & Force',
      'A projectile is launched with velocity v at an angle of 30° to the horizontal. At what complementary angle will the horizontal range be the same?',
      'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=800&q=80',
      '45°', '60°', '90°', '15°', 'B',
      'Horizontal range of a projectile is identical for complementary angles theta and (90° - theta). For 30°, the complement is 60°.',
      ${teacherId}
    ) RETURNING id`;

  const [{ id: q4 }] = await sql`
    INSERT INTO questions (course_id, topic, body, image, opt_a, opt_b, opt_c, opt_d, correct, explanation, created_by)
    VALUES (
      ${crsPhy1}, 'Circular Motion',
      'When a body moves along a circular path with constant speed, the work done by the centripetal force is always:',
      NULL,
      'Maximum', 'Negative', 'Positive', 'Zero', 'D',
      'Centripetal force is perpendicular to instantaneous displacement at all points (angle 90°), so W = F * d * cos(90°) = 0.',
      ${teacherId}
    ) RETURNING id`;

  const [{ id: q5 }] = await sql`
    INSERT INTO questions (course_id, topic, body, image, opt_a, opt_b, opt_c, opt_d, correct, explanation, created_by)
    VALUES (
      ${crsPhy1}, 'Work & Energy',
      'If the momentum of a moving body is doubled, its kinetic energy increases by what factor?',
      NULL,
      '2 times', '4 times', '8 times', 'Remains unchanged', 'B',
      'Kinetic energy KE = p^2 / (2m). Since KE is proportional to p^2, doubling momentum quadruples KE (factor of 4).',
      ${teacherId}
    ) RETURNING id`;

  const [{ id: q6 }] = await sql`
    INSERT INTO questions (course_id, topic, body, image, opt_a, opt_b, opt_c, opt_d, correct, explanation, created_by)
    VALUES (
      ${crsChem1}, 'Stoichiometry',
      'How many moles of oxygen gas (O2) are required to completely react with 2 moles of Hydrogen gas (H2) to form liquid water?',
      NULL,
      '1 mole', '2 moles', '0.5 moles', '4 moles', 'A',
      'Balanced equation: 2H2 + O2 -> 2H2O. Thus 2 moles of H2 require exactly 1 mole of O2.',
      ${teacher2Id}
    ) RETURNING id`;

  // 7. Tests
  const now = new Date();
  const startAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const endAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const [{ id: t1 }] = await sql`
    INSERT INTO tests (course_id, section_id, title, duration_min, mark_per_q, neg_mark, shuffle_q, shuffle_opt, start_at, end_at, result_mode, results_released, status, created_by)
    VALUES (${crsPhy1}, NULL, 'Midterm Examination: Mechanics & Thermodynamics', 15, 2, 0.5, TRUE, TRUE, ${startAt}, ${endAt}, 1, TRUE, 2, ${teacherId})
    RETURNING id`;

  await sql`INSERT INTO test_questions (test_id, question_id) VALUES (${t1}, ${q1})`;
  await sql`INSERT INTO test_questions (test_id, question_id) VALUES (${t1}, ${q2})`;
  await sql`INSERT INTO test_questions (test_id, question_id) VALUES (${t1}, ${q3})`;
  await sql`INSERT INTO test_questions (test_id, question_id) VALUES (${t1}, ${q4})`;
  await sql`INSERT INTO test_questions (test_id, question_id) VALUES (${t1}, ${q5})`;

  const [{ id: t2 }] = await sql`
    INSERT INTO tests (course_id, section_id, title, duration_min, mark_per_q, neg_mark, shuffle_q, shuffle_opt, start_at, end_at, result_mode, results_released, status, created_by)
    VALUES (${crsChem1}, NULL, 'Chemistry Fundamental Stoichiometry Quiz', 10, 1, 0, TRUE, TRUE, ${startAt}, ${endAt}, 1, TRUE, 2, ${teacher2Id})
    RETURNING id`;
  await sql`INSERT INTO test_questions (test_id, question_id) VALUES (${t2}, ${q6})`;

  // 8. Sample completed attempt for Ahmed Ali on Chemistry Quiz
  const pastStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const pastSubmit = new Date(now.getTime() - 24 * 60 * 60 * 1000 + 7 * 60 * 1000).toISOString();

  const [{ id: att1 }] = await sql`
    INSERT INTO attempts (test_id, student_id, seed, started_at, deadline_at, submitted_at, correct_cnt, wrong_cnt, score)
    VALUES (${t2}, ${s1}, 10492, ${pastStart}, ${pastSubmit}, ${pastSubmit}, 1, 0, 1.0)
    RETURNING id`;

  await sql`INSERT INTO attempt_answers (attempt_id, question_id, chosen) VALUES (${att1}, ${q6}, 'A')`;

  // 9. Live Sessions
  const [{ id: session1 }] = await sql`
    INSERT INTO live_sessions (class_id, section_id, course_name, title, host_id, plan_start, plan_end, status, started_at, zoom_session_id)
    VALUES (${c1}, ${secA1}, 'Physics', 'Physics Ch 3: Projectile Motion & Numerical Problem Solving', ${teacherId},
      ${now.toISOString()}, ${new Date(now.getTime() + 90 * 60 * 1000).toISOString()},
      2, ${now.toISOString()}, 'zoom_session_physics_101')
    RETURNING id`;

  await sql`
    INSERT INTO live_sessions (class_id, section_id, course_name, title, host_id, plan_start, plan_end, status, zoom_session_id)
    VALUES (${c1}, NULL, 'Chemistry', 'Chemistry: Chemical Bonding & Hybridization Theory', ${teacher2Id},
      ${new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString()},
      ${new Date(now.getTime() + 4.5 * 60 * 60 * 1000).toISOString()},
      1, 'zoom_session_chem_102')`;

  console.log('Database successfully seeded:');
  console.log('  - Admin:    admin / password123');
  console.log('  - Operator: operator / password123');
  console.log('  - Teacher:  teacher / password123');
  console.log('  - Student:  PE1-1001 / password123');
  console.log('  - 1 Live Session (LIVE), 2 Tests, 6 Questions created.');
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
