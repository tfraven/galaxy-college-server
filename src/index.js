import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import { config } from './config/index.js';
import { sql } from './db/connection.js';
import { initSchema } from './db/schema.js';
import { seedDatabase } from './db/seed.js';
import { authenticate } from './middleware/auth.js';
import { finalizeAttempt } from './services/grading.js';
import { zoomConfigured } from './services/zoom.js';

import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { masterRouter } from './routes/master.js';
import { studentsRouter } from './routes/students.js';
import { staffRouter } from './routes/staff.js';
import { catalogRouter } from './routes/catalog.js';
import { testsRouter } from './routes/tests.js';
import { examRouter } from './routes/exam.js';
import { sessionsRouter } from './routes/sessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '../public');

const app = express();

app.use(cors(config.corsOrigins.length ? { origin: config.corsOrigins } : undefined));
app.use(express.json({ limit: '4mb' })); // question images are capped at 2 MB (CAT-5)
app.use(express.urlencoded({ extended: true }));

// classroom.html is cross-origin isolated (COOP + COEP) so the Zoom SDK can use SharedArrayBuffer for
// audio/video. Scoped to this one document: applying it globally would block cross-origin images/fonts.
// `credentialless` lets Zoom's CDN scripts load without needing CORP headers.
app.use('/classroom.html', (_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self)');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(publicDir));

app.get('/api/v1/health', (_req, res) => {
  res.json({
    status: 'ok',
    db: 'neon-postgresql',
    timestamp: new Date().toISOString(),
    service: 'College Runner API',
    zoomSdkConfigured: zoomConfigured(),
  });
});

// Public: login only. Everything below requires a valid token; each router adds its own role checks.
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/master', authenticate, masterRouter);
app.use('/api/v1/students', authenticate, studentsRouter);
app.use('/api/v1/staff', authenticate, staffRouter);
app.use('/api/v1/users', authenticate, usersRouter);
app.use('/api/v1/catalog', authenticate, catalogRouter);
app.use('/api/v1/tests', authenticate, testsRouter);
app.use('/api/v1/exam', authenticate, examRouter);
app.use('/api/v1/sessions', authenticate, sessionsRouter);

app.use('/api', (_req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// Central error handler: log the detail, never leak SQL/stack text to clients.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  const status = err.status && err.status < 600 ? err.status : 500;
  const message = status === 503 && err.message ? err.message : status === 500 ? 'Internal server error' : err.message;
  res.status(status).json({ success: false, error: message });
});

// EXM-7: finalize expired attempts even if the student's app is closed.
let autoSubmitRunning = false;
const autoSubmitExpiredAttempts = async () => {
  if (autoSubmitRunning) return; // never overlap runs
  autoSubmitRunning = true;
  try {
    const expired = await sql`SELECT id FROM attempts WHERE submitted_at IS NULL AND deadline_at <= NOW() LIMIT 200`;
    for (const { id } of expired) {
      await finalizeAttempt(id);
      console.log(`[auto-submit] finalized attempt #${id}`);
    }
  } catch (err) {
    console.error('[auto-submit] error', err);
  } finally {
    autoSubmitRunning = false;
  }
};

const start = async () => {
  try {
    await initSchema();
    await seedDatabase();

    if (!zoomConfigured()) {
      console.warn('[zoom] ZOOM_SDK_KEY / ZOOM_SDK_SECRET missing: live classes cannot issue join tokens.');
    }
    if (config.allowPasswordlessLogin) {
      console.warn('[auth] ALLOW_PASSWORDLESS_LOGIN is ON (dev only). Never enable this in production.');
    }

    setInterval(autoSubmitExpiredAttempts, 30_000);

    app.listen(config.port, () => {
      console.log(`College Runner API on :${config.port}  (health: /api/v1/health)`);
    });
  } catch (err) {
    console.error('Server startup failed:', err);
    process.exit(1);
  }
};

start();