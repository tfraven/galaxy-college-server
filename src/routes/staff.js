import express from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/connection.js';

export const staffRouter = express.Router();

staffRouter.get('/', (_req, res) => {
  try {
    const staff = db.prepare(`
      SELECT id, role, username, full_name as fullName, phone, is_active as isActive, must_change_pw as mustChangePw
      FROM users
      WHERE role IN (2, 3)
      ORDER BY id ASC
    `).all();

    return res.json({
      success: true,
      data: staff.map((s) => ({
        ...s,
        isActive: Boolean(s.isActive),
        mustChangePw: Boolean(s.mustChangePw),
      })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

staffRouter.post('/', (req, res) => {
  try {
    const { role, username, fullName, phone } = req.body;
    if (!username || !fullName) {
      return res.status(400).json({ success: false, error: 'Full name and username are required' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username.trim());
    if (existing) {
      return res.status(400).json({ success: false, error: 'Username already in use' });
    }

    const defaultHash = bcrypt.hashSync('staff123', 10);
    const result = db.prepare(`
      INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
      VALUES (?, ?, ?, ?, ?, 1, 1)
    `).run(role || 3, username.trim(), defaultHash, fullName.trim(), phone || null);

    return res.status(201).json({
      success: true,
      data: {
        id: result.lastInsertRowid,
        role: role || 3,
        username: username.trim(),
        fullName: fullName.trim(),
        phone: phone || null,
        isActive: true,
        mustChangePw: true,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});
