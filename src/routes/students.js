import express from 'express';
import bcrypt from 'bcryptjs';
import { sql } from '../db/connection.js';

export const studentsRouter = express.Router();

studentsRouter.get('/', async (_req, res) => {
  try {
    const students = await sql`
      SELECT
        s.user_id as "userId",
        u.username as "rollNo",
        u.full_name as "fullName",
        u.phone,
        s.class_id as "classId",
        c.name as "className",
        s.section_id as "sectionId",
        sec.name as "sectionName",
        u.is_active as "isActive"
      FROM students s
      JOIN users u ON s.user_id = u.id
      JOIN classes c ON s.class_id = c.id
      LEFT JOIN sections sec ON s.section_id = sec.id
      ORDER BY s.user_id ASC
    `;
    return res.json({ success: true, data: students });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

studentsRouter.post('/', async (req, res) => {
  const { fullName, rollNo, classId, sectionId, phone } = req.body;
  if (!fullName || !rollNo || !classId) {
    return res.status(400).json({ success: false, error: 'Full name, roll number, and class are required' });
  }

  try {
    const existing = await sql`
      SELECT id FROM users WHERE LOWER(username) = LOWER(${rollNo.trim()})
    `;
    if (existing.length > 0) {
      return res.status(400).json({ success: false, error: `Roll number "${rollNo}" already exists` });
    }

    const defaultHash = await bcrypt.hash('student123', 10);

    const [newUser] = await sql`
      INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
      VALUES (4, ${rollNo.trim()}, ${defaultHash}, ${fullName.trim()}, ${phone || null}, TRUE, TRUE)
      RETURNING id
    `;

    const userId = newUser.id;

    await sql`
      INSERT INTO students (user_id, class_id, section_id)
      VALUES (${userId}, ${classId}, ${sectionId || null})
    `;

    const [cls] = await sql`SELECT name FROM classes WHERE id = ${classId}`;
    let sec = null;
    if (sectionId) {
      const rows = await sql`SELECT name FROM sections WHERE id = ${sectionId}`;
      sec = rows[0];
    }

    return res.status(201).json({
      success: true,
      data: {
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
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Preview bulk upload
studentsRouter.post('/preview-bulk', async (req, res) => {
  try {
    const { prefix = 'PE1-', startNumber = 1001, padding = 4, sampleRows = [] } = req.body;

    const existingUsers = await sql`SELECT LOWER(username) as username FROM users`;
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

      return { rowNum: idx + 1, fullName: r.fullName, generatedRollNo, classId: r.classId, valid, error };
    });

    const totalValid = previewRows.filter((r) => r.valid).length;
    return res.json({ success: true, data: { previewRows, totalValid } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Commit bulk upload
studentsRouter.post('/commit-bulk', async (req, res) => {
  try {
    const { validRows = [] } = req.body;
    if (!validRows.length) {
      return res.status(400).json({ success: false, error: 'No valid rows provided' });
    }

    const credentials = [];

    for (const row of validRows) {
      const tempPass = `Pass@${Math.floor(1000 + Math.random() * 9000)}`;
      const userHash = await bcrypt.hash(tempPass, 10);

      const [newUser] = await sql`
        INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
        VALUES (4, ${row.generatedRollNo}, ${userHash}, ${row.fullName}, ${row.phone || null}, TRUE, TRUE)
        RETURNING id
      `;

      await sql`
        INSERT INTO students (user_id, class_id, section_id)
        VALUES (${newUser.id}, ${row.classId}, ${row.sectionId || null})
      `;

      credentials.push({ rollNo: row.generatedRollNo, tempPass });
    }

    return res.json({
      success: true,
      data: { importedCount: validRows.length, credentials },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});
