// Usage: pnpm tsx scripts/seed-admin.ts someone@example.com
// Spec §8: admin accounts must be Google sign-in accounts (inherits Google 2FA).
// Only seed emails that signed up with "Continue with Google".
// Against emulator: FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 pnpm tsx scripts/seed-admin.ts ...
// Against prod: GOOGLE_APPLICATION_CREDENTIALS=<service-account.json> pnpm tsx scripts/seed-admin.ts ...
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const email = process.argv[2];
if (!email) { console.error("Usage: seed-admin.ts <email>"); process.exit(1); }
const app = getApps()[0] ?? initializeApp({ projectId: "gatekeep-dev-jg" });
const user = await getAuth(app).getUserByEmail(email);
await getAuth(app).setCustomUserClaims(user.uid, { admin: true });
console.log(`admin claim granted to ${email} (${user.uid})`);
