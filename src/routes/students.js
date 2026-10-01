import express from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/connection.js';

export const studentsRouter = express.Router();

studentsRouter.get('/', (_req, res) => {
  try {
    const students = db.prepare(`
      SELECT 
        s.user_id as userId,
        u.username as rollNo,
        u.full_name as fullName,
        u.phone,
        s.class_id as classId,
        c.name as className,
        s.section_id as sectionId,
        sec.name as sectionName,
        u.is_active as isActive
      FROM students s
      JOIN users u ON s.user_id = u.id
      JOIN classes c ON s.class_id = c.id
      LEFT JOIN sections sec ON s.section_id = sec.id
      ORDER BY s.user_id ASC
    `).all();

    return res.json({ success: true, data: students });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

studentsRouter.post('/', (req, res) => {
  const { fullName, rollNo, classId, sectionId, phone } = req.body;
  if (!fullName || !rollNo || !classId) {
    return res.status(400).json({ success: false, error: 'Full name, roll number, and class are required' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(rollNo.trim());
  if (existing) {
    return res.status(400).json({ success: false, error: `Roll number "${rollNo}" already exists` });
  }

  const defaultHash = bcrypt.hashSync('student123', 10);

  const transaction = db.transaction(() => {
    const userRes = db.prepare(`
      INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
      VALUES (4, ?, ?, ?, ?, 1, 1)
    `).run(rollNo.trim(), defaultHash, fullName.trim(), phone || null);

    const userId = userRes.lastInsertRowid;

    db.prepare(`
      INSERT INTO students (user_id, class_id, section_id)
      VALUES (?, ?, ?)
    `).run(userId, classId, sectionId || null);

    const cls = db.prepare('SELECT name FROM classes WHERE id = ?').get(classId);
    const sec = sectionId ? db.prepare('SELECT name FROM sections WHERE id = ?').get(sectionId) : null;

    return {
      user: {
        id: userId,
        role: 4,
        username: rollNo.trim(),
        fullName: fullName.trim(),
        phone: phone || null,
        isActive: true,
        mustChangePw: true,
      },
      student: {
        userId,
        rollNo: rollNo.trim(),
        classId,
        className: cls ? cls.name : '',
        sectionId: sectionId || null,
        sectionName: sec ? sec.name : null,
      },
    };
  });

  try {
    const data = transaction();
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// STU-4 & STU-5: Preview bulk upload
studentsRouter.post('/preview-bulk', (req, res) => {
  try {
    const { prefix = 'PE1-', startNumber = 1001, padding = 4, sampleRows = [] } = req.body;

    const existingUsers = db.prepare('SELECT LOWER(username) as username FROM users').all();
    const existingUsernames = new Set(existingUsers.map((u) => u.username));

    let currentNum = parseInt(startNumber, 10) || 1001;
    const padLen = parseInt(padding, 10) || 4;

    const previewRows = sampleRows.map((r, idx) => {
      let valid = true;
      let error = undefined;

      if (!r.fullName || !r.fullName.trim()) {
        valid = false;
        error = 'Full name missing';
      }

      let generatedRollNo = '';
      while (true) {
        const numStr = String(currentNum).padStart(padLen, '0');
        generatedRollNo = `${prefix}${numStr}`;
        currentNum++;
        if (!existingUsernames.has(generatedRollNo.toLowerCase())) {
          existingUsernames.add(generatedRollNo.toLowerCase());
          break;
        }
      }

      return {
        rowNum: idx + 1,
        fullName: r.fullName,
        generatedRollNo,
        classId: r.classId,
        valid,
        error,
      };
    });

    const totalValid = previewRows.filter((r) => r.valid).length;
    return res.json({
      success: true,
      data: {
        previewRows,
        totalValid,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// STU-6: Commit bulk upload in a single transaction
studentsRouter.post('/commit-bulk', (req, res) => {
  try {
    const { validRows = [] } = req.body;
    if (!validRows.length) {
      return res.status(400).json({ success: false, error: 'No valid rows provided' });
    }

    const defaultHash = bcrypt.hashSync('student123', 10);
    const credentials = [];

    const insertUserStmt = db.prepare(`
      INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
      VALUES (4, ?, ?, ?, ?, 1, 1)
    `);

    const insertStudentStmt = db.prepare(`
      INSERT INTO students (user_id, class_id, section_id)
      VALUES (?, ?, ?)
    `);

    const commitTx = db.transaction(() => {
      for (const row of validRows) {
        const tempPass = `Pass@${Math.floor(1000 + Math.random() * 9000)}`;
        const userHash = bcrypt.hashSync(tempPass, 10);

        const userRes = insertUserStmt.run(
          row.generatedRollNo,
          userHash,
          row.fullName,
          row.phone || null
        );

        insertStudentStmt.run(
          userRes.lastInsertRowid,
          row.classId,
          row.sectionId || null
        );

        credentials.push({
          rollNo: row.generatedRollNo,
          tempPass,
        });
      }
    });

    commitTx();

    return res.json({
      success: true,
      data: {
        importedCount: validRows.length,
        credentials,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});
