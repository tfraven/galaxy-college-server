import express from 'express';
import bcrypt from 'bcryptjs';
import { sql } from '../db/connection.js';

export const staffRouter = express.Router();

staffRouter.get('/', async (_req, res) => {
  try {
    const staff = await sql`
      SELECT id, role, username, full_name as "fullName", phone,
             is_active as "isActive", must_change_pw as "mustChangePw"
      FROM users
      WHERE role IN (2, 3)
      ORDER BY id ASC
    `;
    return res.json({ success: true, data: staff });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

staffRouter.post('/', async (req, res) => {
  try {
    const { role, username, fullName, phone } = req.body;
    if (!username || !fullName) {
      return res.status(400).json({ success: false, error: 'Full name and username are required' });
    }

    const existing = await sql`
      SELECT id FROM users WHERE LOWER(username) = LOWER(${username.trim()})
    `;
    if (existing.length > 0) {
      return res.status(400).json({ success: false, error: 'Username already in use' });
    }

    const defaultHash = await bcrypt.hash('staff123', 10);
    const finalRole = role || 3;

    const [newUser] = await sql`
      INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
      VALUES (${finalRole}, ${username.trim()}, ${defaultHash}, ${fullName.trim()}, ${phone || null}, TRUE, TRUE)
      RETURNING id
    `;

    return res.status(201).json({
      success: true,
      data: {
        id: newUser.id,
        role: finalRole,
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
