import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

const APP_NAME = 'galaxy-college-push';
let initializationErrorLogged = false;
let credentialsWarningLogged = false;

/** Returns null until server-only Firebase Admin credentials are configured. */
export const getFirebaseMessaging = () => {
  const serviceAccountText = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  const credentialsAvailable = serviceAccountText || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialsAvailable) {
    if (!credentialsWarningLogged) {
      credentialsWarningLogged = true;
      console.warn('[push] Firebase Admin credentials are not configured; push delivery is disabled.');
    }
    return null;
  }

  try {
    const existing = getApps().find((app) => app.name === APP_NAME);
    if (existing) return getMessaging(existing);

    const serviceAccount = serviceAccountText ? JSON.parse(serviceAccountText) : null;
    const projectId = process.env.FIREBASE_PROJECT_ID?.trim() || serviceAccount?.project_id;
    const app = initializeApp({
      credential: serviceAccount ? cert(serviceAccount) : applicationDefault(),
      ...(projectId ? { projectId } : {}),
    }, APP_NAME);
    return getMessaging(app);
  } catch (error) {
    if (!initializationErrorLogged) {
      initializationErrorLogged = true;
      console.error('[push] Firebase Admin initialization failed:', error.message);
    }
    return null;
  }
};
