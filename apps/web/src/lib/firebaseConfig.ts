// Public web-app config from Firebase console, Project settings, Your apps.
// These values are NOT secrets; security comes from rules + App Check.
//
// SP10 Task 24 (cross-cutting #7): every value reads NEXT_PUBLIC_FIREBASE_*
// first so a production build can target another project without a code
// change; the dev project is the documented default (apps/web/.env.example).
// An empty string counts as unset so a blank line in .env cannot blank a
// field. No "use client" here: plain constants, safe for RSC imports.
const pick = (value: string | undefined, fallback: string): string =>
  value !== undefined && value.length > 0 ? value : fallback;

export const firebaseConfig = {
  apiKey: pick(process.env.NEXT_PUBLIC_FIREBASE_API_KEY, "AIzaSyCj3Q8__Tmu4B-UCE1fTMZxK31L9Cq_NqU"),
  authDomain: pick(process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, "gatekeep-dev-jg.firebaseapp.com"),
  projectId: pick(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID, "gatekeep-dev-jg"),
  storageBucket: pick(process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET, "gatekeep-dev-jg.firebasestorage.app"),
  messagingSenderId: pick(process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID, "894446689930"),
  appId: pick(process.env.NEXT_PUBLIC_FIREBASE_APP_ID, "1:894446689930:web:20531390a23a3804b05773"),
};
