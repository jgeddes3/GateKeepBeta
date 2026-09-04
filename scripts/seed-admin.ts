// Usage: pnpm tsx scripts/seed-admin.ts someone@example.com [--project <id>]
// Spec §8: admin accounts must be Google sign-in accounts (inherits Google 2FA).
// Only seed emails that signed up with "Continue with Google".
// Against emulator: FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 pnpm tsx scripts/seed-admin.ts ...
// Against a real project: GOOGLE_APPLICATION_CREDENTIALS=<service-account.json> pnpm tsx scripts/seed-admin.ts ...
//   (the project id comes from --project, GCLOUD_PROJECT, or the credentials file, in that order)
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { resolveProjectId, stripProjectFlag } from "./projectId.js";

const args = stripProjectFlag(process.argv.slice(2));
const email = args[0];
if (!email) { console.error("Usage: seed-admin.ts <email> [--project <id>]"); process.exit(1); }
const projectId = resolveProjectId(process.argv);
console.log(`project: ${projectId}`);
const app = getApps()[0] ?? initializeApp({ projectId });
const user = await getAuth(app).getUserByEmail(email);
// Mirrors functions/src/review.ts's grantAdmin compensating control (spec
// §8): admin accounts must be Google sign-in accounts.
const isGoogleLinked = user.providerData.some((p) => p.providerId === "google.com");
if (!isGoogleLinked) {
  console.error(`Refusing: ${email} is not a Google sign-in account. Admin accounts must use Google sign-in.`);
  process.exit(1);
}
await getAuth(app).setCustomUserClaims(user.uid, { ...user.customClaims, admin: true });
console.log(`admin claim granted to ${email} (${user.uid})`);
