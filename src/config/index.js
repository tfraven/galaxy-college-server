import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from server root directory
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  jwtSecret: process.env.JWT_SECRET || 'college_runner_jwt_dev_secret_fallback',
  databaseUrl: process.env.DATABASE_URL || '',
  zoom: {
    sdkKey: process.env.ZOOM_SDK_KEY || '',
    sdkSecret: process.env.ZOOM_SDK_SECRET || '',
    webhookSecret: process.env.ZOOM_WEBHOOK_SECRET_TOKEN || '',
  },
};
