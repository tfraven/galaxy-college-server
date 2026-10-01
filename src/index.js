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

// classroom.html needs COOP + COEP to enable SharedArrayBuffer (required by Zoom Audio SDK).
// These are scoped to just that document — applying them globally would block cross-origin
// subresources (images, fonts, etc.) that don't carry a Cross-Origin-Resource-Policy header.
app.use('/classroom.html', (_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
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

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

// Expose HTTP server for Express and WebSockets
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Store session peers: sessionId -> Set of { ws, userId, userName, role }
const sessionPeers = new Map();

wss.on('connection', (ws) => {
  let currentSessionId = null;
  let currentUser = null;

  ws.on('message', (messageRaw) => {
    try {
      const msg = JSON.parse(messageRaw);

      if (msg.type === 'join') {
        currentSessionId = String(msg.sessionId);
        currentUser = {
          ws,
          userId: msg.userId,
          userName: msg.userName,
          role: msg.role,
        };

        if (!sessionPeers.has(currentSessionId)) {
          sessionPeers.set(currentSessionId, new Set());
        }
        const roomSet = sessionPeers.get(currentSessionId);
        roomSet.add(currentUser);

        // Send existing peers list to the newly joined peer
        const peersInRoom = Array.from(roomSet)
          .filter(p => p.ws !== ws && p.ws.readyState === WebSocket.OPEN)
          .map(p => ({ userId: p.userId, userName: p.userName, role: p.role }));

        ws.send(JSON.stringify({
          type: 'peers-list',
          peers: peersInRoom,
        }));

        // Broadcast peer-joined to existing peers
        roomSet.forEach(peer => {
          if (peer.ws !== ws && peer.ws.readyState === WebSocket.OPEN) {
            peer.ws.send(JSON.stringify({
              type: 'peer-joined',
              peer: { userId: msg.userId, userName: msg.userName, role: msg.role },
            }));
          }
        });
      } else if (msg.type === 'signal') {
        // Forward WebRTC signal (offer/answer/candidate) to specific peer
        const targetUserId = msg.targetUserId;
        const peers = sessionPeers.get(currentSessionId);
        if (peers) {
          peers.forEach(peer => {
            if (String(peer.userId) === String(targetUserId) && peer.ws.readyState === WebSocket.OPEN) {
              peer.ws.send(JSON.stringify({
                type: 'signal',
                fromUserId: currentUser?.userId,
                fromUserName: currentUser?.userName,
                data: msg.data,
              }));
            }
          });
        }
      } else if (msg.type === 'chat') {
        // Broadcast chat to all peers in the session room
        const peers = sessionPeers.get(currentSessionId);
        if (peers) {
          peers.forEach(peer => {
            if (peer.ws.readyState === WebSocket.OPEN) {
              peer.ws.send(JSON.stringify({
                type: 'chat',
                message: msg.message,
              }));
            }
          });
        }
      }
    } catch (e) {
      console.error('[WS error]', e);
    }
  });

  ws.on('close', () => {
    if (currentSessionId && currentUser && sessionPeers.has(currentSessionId)) {
      const peers = sessionPeers.get(currentSessionId);
      peers.delete(currentUser);
      if (peers.size === 0) {
        sessionPeers.delete(currentSessionId);
      } else {
        peers.forEach(peer => {
          if (peer.ws.readyState === WebSocket.OPEN) {
            peer.ws.send(JSON.stringify({
              type: 'peer-left',
              userId: currentUser.userId,
            }));
          }
        });
      }
    }
  });
});

// Start Server
const startServer = async () => {
  try {
    await initSchema();
    await seedDatabase();

    server.listen(config.port, () => {
      console.log(`===============================================`);
      console.log(`  College Runner Server running on port ${config.port}`);
      console.log(`  Database: Neon PostgreSQL`);
      console.log(`  API Base URL: http://localhost:${config.port}/api/v1`);
      console.log(`  WebSocket URL: ws://localhost:${config.port}/ws`);
      console.log(`  Health Check: http://localhost:${config.port}/api/v1/health`);
      console.log(`===============================================`);
    });
  } catch (err) {
    console.error('Server startup failed:', err);
    process.exit(1);
  }
};

startServer();
