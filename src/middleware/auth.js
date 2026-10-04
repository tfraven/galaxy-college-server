import jwt from 'jsonwebtoken';
import { sql } from '../db/connection.js';
import { config } from '../config/index.js';

export const ROLE = { ADMIN: 1, OPERATOR: 2, TEACHER: 3, STUDENT: 4 };
export const STAFF_ROLES = [ROLE.ADMIN, ROLE.OPERATOR, ROLE.TEACHER];

const loadUser = async (id) => {
    const [u] = await sql`
    SELECT id, role, username, full_name, is_active, must_change_pw, token_version
    FROM users WHERE id = ${id}
  `;
    return u || null;
};

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const fail = (res, status, error) => res.status(status).json({ success: false, error });

/** Verifies the Bearer token and sets req.user. Every non-public route must sit behind this. */
export const authenticate = asyncHandler(async (req, res, next) => {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return fail(res, 401, 'Missing authorization token');

    let decoded;
    try {
        decoded = jwt.verify(header.slice(7), config.jwtSecret, {
            algorithms: ['HS256'],
            issuer: config.jwtIssuer,
            audience: config.jwtAudience,
        });
    } catch {
        return fail(res, 401, 'Invalid or expired token');
    }

    if (!Number.isSafeInteger(decoded.id) || decoded.id <= 0 || !Number.isSafeInteger(decoded.ver)) {
        return fail(res, 401, 'Invalid or expired token');
    }

    const user = await loadUser(decoded.id);
    if (!user) return fail(res, 401, 'User not found');
    if (decoded.ver !== user.token_version) return fail(res, 401, 'Invalid or expired token');
    if (!user.is_active) return fail(res, 403, 'Account is deactivated. Contact Admin.');

    const passwordChangeAllowed = req.baseUrl === '/api/v1/auth'
        && ['/me', '/change-password'].includes(req.path);
    if (user.must_change_pw && !passwordChangeAllowed) {
        return fail(res, 403, 'Change your temporary password before continuing.');
    }

    req.user = {
        id: user.id,
        role: user.role,
        username: user.username,
        fullName: user.full_name,
        mustChangePw: user.must_change_pw,
        tokenVersion: user.token_version,
    };
    next();
});

export const requireRole = (...roles) => (req, res, next) =>
    roles.includes(req.user?.role) ? next() : fail(res, 403, 'You do not have permission to do this.');

export const isStaff = (user) => STAFF_ROLES.includes(user.role);

export const toInt = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
};
