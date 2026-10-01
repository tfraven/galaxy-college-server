import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../db/connection.js';
import { config } from '../config/index.js';

export const authRouter = express.Router();

authRouter.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username) {
      return res.status(400).json({ success: false, error: 'Username or Roll Number is required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username.trim());
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials. User not found.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ success: false, error: 'Account is deactivated. Contact Admin.' });
    }

    // Verify password if provided
    if (password && !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ success: false, error: 'Invalid password. Please check your credentials.' });
    }

    let studentProfile = undefined;
    if (user.role === 4) {
      const st = db.prepare(`
        SELECT s.*, c.name as class_name, sec.name as section_name
        FROM students s
        JOIN classes c ON s.class_id = c.id
        LEFT JOIN sections sec ON s.section_id = sec.id
        WHERE s.user_id = ?
      `).get(user.id);

      if (st) {
        studentProfile = {
          userId: st.user_id,
          rollNo: user.username,
          classId: st.class_id,
          className: st.class_name,
          sectionId: st.section_id,
          sectionName: st.section_name,
        };
      }
    }

    const userDto = {
      id: user.id,
      role: user.role,
      username: user.username,
      fullName: user.full_name,
      phone: user.phone,
      isActive: Boolean(user.is_active),
      mustChangePw: Boolean(user.must_change_pw),
    };

    const token = jwt.sign(
      {
        id: user.id,
        role: user.role,
        username: user.username,
      },
      config.jwtSecret,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      data: {
        token,
        user: userDto,
        student: studentProfile,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

authRouter.get('/me', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Missing authorization token' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, config.jwtSecret);

    const user = db.prepare('SELECT id, role, username, full_name, phone, is_active, must_change_pw FROM users WHERE id = ?').get(decoded.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    return res.json({
      success: true,
      data: {
        id: user.id,
        role: user.role,
        username: user.username,
        fullName: user.full_name,
        phone: user.phone,
        isActive: Boolean(user.is_active),
        mustChangePw: Boolean(user.must_change_pw),
      },
    });
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
});
