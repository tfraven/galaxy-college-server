import crypto from 'crypto';

/** Random one-time password, e.g. "Pass@482913". Shown once to the admin, never stored in plain text. */
export const generateTempPassword = () => `Pass@${crypto.randomInt(100000, 1000000)}`;