// SP10 Task 24 (cross-cutting #7, #27): the seed scripts used to hardcode the
// dev project id. Resolution order: an explicit --project argument, then
// GCLOUD_PROJECT, then the project_id inside the GOOGLE_APPLICATION_CREDENTIALS
// file, then the dev project ONLY when an emulator host is set (the emulator
// project id must match firebase.json). Anything else refuses, so a real
// project is never written to by accident.
import { readFileSync } from "node:fs";

const DEV_PROJECT_ID = "gatekeep-dev-jg";

export function stripProjectFlag(argv: string[]): string[] {
  const i = argv.indexOf("--project");
  if (i < 0) return argv;
  return [...argv.slice(0, i), ...argv.slice(i + 2)];
}

export function resolveProjectId(argv: string[]): string {
  const i = argv.indexOf("--project");
  const fromArg = i >= 0 ? argv[i + 1] : undefined;
  if (fromArg) return fromArg;
  if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credsPath) {
    const creds = JSON.parse(readFileSync(credsPath, "utf8")) as { project_id?: unknown };
    if (typeof creds.project_id === "string" && creds.project_id.length > 0) return creds.project_id;
  }
  const inEmulator = !!process.env.FIREBASE_AUTH_EMULATOR_HOST || !!process.env.FIRESTORE_EMULATOR_HOST;
  if (inEmulator) return DEV_PROJECT_ID;
  console.error(
    "Refusing: no project id. Pass --project <id>, set GCLOUD_PROJECT, or point GOOGLE_APPLICATION_CREDENTIALS at a service-account file.");
  process.exit(1);
}
