import { randomBytes } from 'node:crypto';

/** Random one-time password with 72 bits of entropy. Shown once; only its hash is stored. */
export const generateTempPassword = () => `Temp-${randomBytes(9).toString('base64url')}`;
