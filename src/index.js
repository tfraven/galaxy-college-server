import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { config } from './config/index.js';
import { sql } from './db/connection.js';
import { initSchema } from './db/schema.js';
import { forceLegacyDemoPasswordChange } from './db/securityMigrations.js';
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
// Keep the classroom document out of Vercel's public/ static file path so that
// this function can attach the per-response CSP and media permissions headers.
const classroomPath = path.join(__dirname, 'views/classroom.html');
const classroomHtml = readFileSync(classroomPath, 'utf8');
const inlineHashes = (tag) => {
  const pattern = new RegExp(`<${tag}\\b(?![^>]*\\bsrc\\s*=)[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
  return [...classroomHtml.matchAll(pattern)].map((match) => {
    const normalized = match[1].replace(/\r\n?/g, '\n');
    return `'sha256-${createHash('sha256').update(normalized).digest('base64')}'`;
  });
};
const classroomCsp = [
  "default-src 'self'",
  `script-src 'self' ${inlineHashes('script').join(' ')} 'wasm-unsafe-eval' https://source.zoom.us https://*.zoom.us`,
  "style-src 'self' 'unsafe-inline' https://source.zoom.us https://*.zoom.us",
  "img-src 'self' data: blob: https://zoom.us https://*.zoom.us",
  "font-src 'self' data: https://zoom.us https://*.zoom.us",
  "media-src 'self' blob: https://zoom.us https://*.zoom.us",
  "connect-src 'self' https://zoom.us https://*.zoom.us wss://zoom.us wss://*.zoom.us",
  "worker-src 'self' blob: https://zoom.us https://*.zoom.us",
  "child-src 'self' blob: https://zoom.us https://*.zoom.us",
  "frame-src 'self' https://zoom.us https://*.zoom.us",
  `frame-ancestors 'self'${config.corsOrigins.length ? ` ${config.corsOrigins.join(' ')}` : ''}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const app = express();

// Vercel overwrites X-Forwarded-For, so one trusted proxy hop is safe for client-IP limiting.
app.set('trust proxy', config.isProd ? 1 : false);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: false, // the classroom page uses a Zoom-specific policy below
  crossOriginEmbedderPolicy: false, // COEP is scoped to classroom.html for Zoom's SharedArrayBuffer use
  crossOriginResourcePolicy: false,
  frameguard: false, // the web classroom may be embedded by an explicitly trusted app origin
  referrerPolicy: { policy: 'no-referrer' },
  hsts: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
}));
const allowedOrigins = new Set(config.corsOrigins);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
  maxAge: 600,
}));
app.use(express.json({ limit: '4mb' })); // question images are capped at 2 MB (CAT-5)
app.use(express.urlencoded({ extended: true, limit: '100kb', parameterLimit: 100 }));

app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// classroom.html is cross-origin isolated (COOP + COEP) so the Zoom SDK can use SharedArrayBuffer for
// audio/video. Scoped to this one document: applying it globally would block cross-origin images/fonts.
// `credentialless` lets Zoom's CDN scripts load without needing CORP headers.
app.use('/classroom.html', (_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self)');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', classroomCsp);
  next();
});
app.get('/classroom.html', (_req, res, next) => {
  res.type('html').sendFile(classroomPath, (err) => {
    if (err) next(err);
  });
});
app.use(express.static(publicDir));

app.get('/api/v1/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
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
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  // Log only safe metadata: parser and database errors can contain request data or SQL details.
  console.error('[request-error]', { status, code: String(err.code || '').slice(0, 40), type: String(err.type || '').slice(0, 40) });
  const message = status === 413 ? 'Request body is too large.' : status < 500 ? 'Invalid request.' : status === 503 ? 'Service unavailable.' : 'Internal server error';
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
    console.error('[auto-submit] error', { code: String(err?.code || '').slice(0, 40) });
  } finally {
    autoSubmitRunning = false;
  }
};

const start = async () => {
  try {
    if (config.isProd) {
      await initSchema();
      await forceLegacyDemoPasswordChange();
    } else await seedDatabase();

    if (!zoomConfigured()) {
      console.warn('[zoom] ZOOM_SDK_KEY / ZOOM_SDK_SECRET missing: live classes cannot issue join tokens.');
    }
    setInterval(autoSubmitExpiredAttempts, 30_000);

    app.listen(config.port, () => {
      console.log(`College Runner API on :${config.port}  (health: /api/v1/health)`);
    });
  } catch (err) {
    console.error('Server startup failed:', { code: String(err?.code || '').slice(0, 40), name: String(err?.name || '').slice(0, 40) });
    process.exit(1);
  }
};

start();
