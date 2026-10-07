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
  const pattern = new RegExp(
    `<${tag}\\b(?![^>]*\\bsrc\\s*=)[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`,
    'gi'
  );

  return [...classroomHtml.matchAll(pattern)].map((match) => {
    const normalized = match[1].replace(/\r\n?/g, '\n');

    return `'sha256-${createHash('sha256')
      .update(normalized)
      .digest('base64')}'`;
  });
};

const classroomCsp = [
  "default-src 'self'",

  `script-src 'self' ${inlineHashes('script').join(
    ' '
  )} 'wasm-unsafe-eval' https://source.zoom.us https://*.zoom.us`,

  "style-src 'self' 'unsafe-inline' https://source.zoom.us https://*.zoom.us",

  "img-src 'self' data: blob: https://zoom.us https://*.zoom.us",

  "font-src 'self' data: https://zoom.us https://*.zoom.us",

  "media-src 'self' blob: https://zoom.us https://*.zoom.us",

  "connect-src 'self' https://zoom.us https://*.zoom.us wss://zoom.us wss://*.zoom.us",

  "worker-src 'self' blob: https://zoom.us https://*.zoom.us",

  "child-src 'self' blob: https://zoom.us https://*.zoom.us",

  "frame-src 'self' https://zoom.us https://*.zoom.us",

  `frame-ancestors 'self'${config.corsOrigins.length
    ? ` ${config.corsOrigins.join(' ')}`
    : ''
  }`,

  "object-src 'none'",

  "base-uri 'self'",

  "form-action 'self'",
].join('; ');

const app = express();

// Vercel overwrites X-Forwarded-For, so one trusted proxy hop is safe for client-IP limiting.
app.set('trust proxy', config.isProd ? 1 : false);

app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    frameguard: false,

    referrerPolicy: {
      policy: 'no-referrer',
    },

    hsts: config.isProd
      ? {
        maxAge: 31_536_000,
        includeSubDomains: true,
      }
      : false,
  })
);

const allowedOrigins = new Set(config.corsOrigins);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      if (!config.isProd && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }

      return callback(null, false);
    },

    methods: [
      'GET',
      'HEAD',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS',
    ],

    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Accept',
    ],

    maxAge: 600,
  })
);

app.use(
  express.json({
    limit: '4mb',
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: '100kb',
    parameterLimit: 100,
  })
);

app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});


/*
 * ============================================================
 * ZOOM CLASSROOM
 * ============================================================
 *
 * classroom.html needs special browser permissions because the
 * Zoom Video SDK uses camera/microphone/WebRTC inside the page.
 *
 * Android WebView can be stricter than desktop Chrome.
 *
 * In particular, Zoom can use *.zoom.us media contexts during
 * connection failover. The previous policy only allowed "self",
 * which could leave the media permission in "prompt" state and
 * result in:
 *
 * Connected
 *    ↓
 * Reconnecting (failover)
 *    ↓
 * Connected
 *    ↓
 * Reconnecting (failover)
 *
 * Allow Zoom's trusted origins here.
 */

app.use('/classroom.html', (_req, res, next) => {
  res.setHeader(
    'Cross-Origin-Opener-Policy',
    'same-origin'
  );

  res.setHeader(
    'Cross-Origin-Embedder-Policy',
    'credentialless'
  );

  /*
   * IMPORTANT:
   *
   * Allow camera/microphone for the classroom itself AND
   * Zoom's own origins.
   *
   * This is particularly important for Android WebView
   * failover/reconnection.
   */
  res.setHeader(
    'Permissions-Policy',
    [
      'camera=(self "https://zoom.us" "https://*.zoom.us")',
      'microphone=(self "https://zoom.us" "https://*.zoom.us")',
      'display-capture=(self "https://zoom.us" "https://*.zoom.us")',
      'fullscreen=(self "https://zoom.us" "https://*.zoom.us")',
    ].join(', ')
  );

  // Do not cache the classroom page.
  res.setHeader(
    'Cache-Control',
    'no-store'
  );

  // Zoom-specific CSP.
  res.setHeader(
    'Content-Security-Policy',
    classroomCsp
  );

  next();
});


app.get('/classroom.html', (_req, res, next) => {
  res.type('html').sendFile(
    classroomPath,
    (err) => {
      if (err) next(err);
    }
  );
});


app.use(express.static(publicDir));


/*
 * ============================================================
 * HEALTH
 * ============================================================
 */

app.get('/api/v1/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});


/*
 * ============================================================
 * API ROUTES
 * ============================================================
 */

// Public: login only.
app.use(
  '/api/v1/auth',
  authRouter
);

// Everything below requires authentication.
app.use(
  '/api/v1/master',
  authenticate,
  masterRouter
);

app.use(
  '/api/v1/students',
  authenticate,
  studentsRouter
);

app.use(
  '/api/v1/staff',
  authenticate,
  staffRouter
);

app.use(
  '/api/v1/users',
  authenticate,
  usersRouter
);

app.use(
  '/api/v1/catalog',
  authenticate,
  catalogRouter
);

app.use(
  '/api/v1/tests',
  authenticate,
  testsRouter
);

app.use(
  '/api/v1/exam',
  authenticate,
  examRouter
);

app.use(
  '/api/v1/sessions',
  authenticate,
  sessionsRouter
);


/*
 * ============================================================
 * 404
 * ============================================================
 */

app.use(
  '/api',
  (_req, res) =>
    res.status(404).json({
      success: false,
      error: 'Not found',
    })
);


/*
 * ============================================================
 * CENTRAL ERROR HANDLER
 * ============================================================
 */

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status =
    Number.isInteger(err.status) &&
      err.status >= 400 &&
      err.status < 600
      ? err.status
      : 500;

  console.error(
    '[request-error]',
    {
      status,
      code: String(err.code || '').slice(0, 40),
      type: String(err.type || '').slice(0, 40),
    }
  );

  const message =
    status === 413
      ? 'Request body is too large.'
      : status < 500
        ? 'Invalid request.'
        : status === 503
          ? 'Service unavailable.'
          : 'Internal server error';

  res.status(status).json({
    success: false,
    error: message,
  });
});


/*
 * ============================================================
 * AUTO-SUBMIT EXPIRED EXAMS
 * ============================================================
 */

let autoSubmitRunning = false;

const autoSubmitExpiredAttempts = async () => {
  if (autoSubmitRunning) {
    return;
  }

  autoSubmitRunning = true;

  try {
    const expired = await sql`
      SELECT id
      FROM attempts
      WHERE submitted_at IS NULL
        AND deadline_at <= NOW()
      LIMIT 200
    `;

    for (const { id } of expired) {
      await finalizeAttempt(id);

      console.log(
        `[auto-submit] finalized attempt #${id}`
      );
    }
  } catch (err) {
    console.error(
      '[auto-submit] error',
      {
        code: String(err?.code || '').slice(0, 40),
      }
    );
  } finally {
    autoSubmitRunning = false;
  }
};


/*
 * ============================================================
 * START SERVER
 * ============================================================
 */

const start = async () => {
  try {
    if (config.isProd) {
      await initSchema();
      await forceLegacyDemoPasswordChange();
    } else {
      await seedDatabase();
    }

    if (!zoomConfigured()) {
      console.warn(
        '[zoom] ZOOM_SDK_KEY / ZOOM_SDK_SECRET missing: live classes cannot issue join tokens.'
      );
    }

    if (
      config.isProd &&
      config.corsOrigins.length === 0
    ) {
      console.warn(
        '[security] CORS_ORIGINS is empty; browser frontends on other origins cannot call this API.'
      );
    }

    // Run expired-attempt processing every 30 seconds.
    setInterval(
      autoSubmitExpiredAttempts,
      30_000
    );

    app.listen(
      config.port,
      () => {
        console.log(
          `College Runner API on :${config.port}  (health: /api/v1/health)`
        );
      }
    );

  } catch (err) {
    console.error(
      'Server startup failed:',
      {
        code: String(err?.code || '').slice(0, 40),
        name: String(err?.name || '').slice(0, 40),
      }
    );

    process.exit(1);
  }
};

start();