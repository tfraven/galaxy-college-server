# galaxy-college-server

## Production setup

- Set `NODE_ENV=production`, `DATABASE_URL`, and a newly generated `JWT_SECRET` with at least 32 random characters.
- Set `CORS_ORIGINS` to a comma-separated list of exact HTTPS origins for browser clients (for example, the deployed web app origin). Do not include URL paths or trailing slashes. Native mobile requests do not require a browser origin.
- Set `ZOOM_SDK_KEY` and `ZOOM_SDK_SECRET` from a Zoom Video SDK app. OAuth app credentials and webhook verification tokens cannot sign Video SDK join tokens.
- For Android push notifications, add the Firebase Android app config as `galaxycollege/app/google-services.json` (package ID `com.example.galaxycollege`). Set `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT_JSON` in the server deployment environment, then enable the Firebase Cloud Messaging API. The service account JSON belongs only in the server's secret store; do not put it in the Android app or source control. `GOOGLE_APPLICATION_CREDENTIALS` is also supported for server environments that provide a credentials file.
- Set the mobile build's `EXPO_PUBLIC_API_URL` to the deployed API base ending in `/api/v1`.
- Deploy the `server` directory as the Vercel project root. The classroom document is served through Express so its CSP, camera/microphone policy, and no-store headers apply.
- Do not run the demo `seed` script in production. On a new database, set `INITIAL_ADMIN_USERNAME`, `INITIAL_ADMIN_NAME`, and `INITIAL_ADMIN_PASSWORD` in a trusted local environment, run `npm run bootstrap-admin` once, then remove those variables. Bootstrap refuses to run after an admin exists and does not print the password.
- Existing demo accounts still using the seed password are forced through the change-password screen on the first production startup. Replace any credentials that have been shared outside the deployment secret store.

The mobile app stores native access tokens with Expo SecureStore. Browser builds use per-tab session storage; production browser origins still need to be listed in `CORS_ORIGINS`.
