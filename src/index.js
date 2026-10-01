import express from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import { sql } from './db/connection.js';
import { initSchema } from './db/schema.js';
import { seedDatabase } from './db/seed.js';

import { authRouter } from './routes/auth.js';
import { masterRouter } from './routes/master.js';
import { studentsRouter } from './routes/students.js';
import { staffRouter } from './routes/staff.js';
import { catalogRouter } from './routes/catalog.js';
import { testsRouter } from './routes/tests.js';
import { examRouter } from './routes/exam.js';
import { sessionsRouter } from './routes/sessions.js';

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '../public');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static assets with permissive isolation headers for Zoom Video SDK Web
app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});
app.use(express.static(publicDir));

// Health Check
app.get('/api/v1/health', (_req, res) => {
  res.json({
    status: 'ok',
    db: 'neon-postgresql',
    timestamp: new Date().toISOString(),
    service: 'College Runner API',
    zoomSdkConfigured: Boolean(config.zoom.sdkKey && config.zoom.sdkKey !== 'YOUR_ZOOM_SDK_KEY_OR_CLIENT_ID_HERE'),
  });
});

// API Routes
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/master', masterRouter);
app.use('/api/v1/students', studentsRouter);
app.use('/api/v1/staff', staffRouter);
app.use('/api/v1/catalog', catalogRouter);
app.use('/api/v1/tests', testsRouter);
app.use('/api/v1/exam', examRouter);
app.use('/api/v1/sessions', sessionsRouter);

// EXM-7: Background job to auto-submit expired exam attempts
const autoSubmitExpiredAttempts = async () => {
  try {
    const now = new Date().toISOString();
    const expired = await sql`
      SELECT id, test_id FROM attempts
      WHERE submitted_at IS NULL AND deadline_at <= ${now}
    `;

    for (const att of expired) {
      const testRows = await sql`SELECT mark_per_q, neg_mark FROM tests WHERE id = ${att.test_id}`;
      const test = testRows[0];
      const questions = await sql`
        SELECT q.id, q.correct
        FROM questions q
        JOIN test_questions tq ON q.id = tq.question_id
        WHERE tq.test_id = ${att.test_id}
      `;

      const answers = await sql`
        SELECT question_id, chosen FROM attempt_answers WHERE attempt_id = ${att.id}
      `;
      const answersMap = {};
      for (const a of answers) answersMap[a.question_id] = a.chosen;

      let correctCnt = 0;
      let wrongCnt = 0;

      for (const q of questions) {
        const chosen = answersMap[q.id];
        if (chosen === q.correct) correctCnt++;
        else if (chosen) wrongCnt++;
      }

      const markPerQ = parseFloat(test?.mark_per_q || 1);
      const negMark = parseFloat(test?.neg_mark || 0);
      const score = Math.max(0, correctCnt * markPerQ - wrongCnt * negMark);

      await sql`
        UPDATE attempts
        SET submitted_at = ${now}, correct_cnt = ${correctCnt}, wrong_cnt = ${wrongCnt}, score = ${score}
        WHERE id = ${att.id}
      `;

      console.log(`[EXM-7 Auto-Submit] Finalized expired attempt #${att.id}`);
    }
  } catch (err) {
    console.error('Auto-submit error:', err);
  }
};

setInterval(autoSubmitExpiredAttempts, 30000); // Check every 30s

// Start Server
const startServer = async () => {
  try {
    await initSchema();
    await seedDatabase();

    app.listen(config.port, () => {
      console.log(`===============================================`);
      console.log(`  College Runner Server running on port ${config.port}`);
      console.log(`  Database: Neon PostgreSQL`);
      console.log(`  API Base URL: http://localhost:${config.port}/api/v1`);
      console.log(`  Health Check: http://localhost:${config.port}/api/v1/health`);
      console.log(`===============================================`);
    });
  } catch (err) {
    console.error('Server startup failed:', err);
    process.exit(1);
  }
};

startServer();
