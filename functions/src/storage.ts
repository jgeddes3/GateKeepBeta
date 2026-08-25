import { getStorage } from "firebase-admin/storage";

// Must match the client apps' storageBucket (apps/*/src/lib/firebase.ts) and the
// bucket the processUpload trigger listens on — the emulator namespaces buckets
// by name, so a bare getStorage().bucket() (projectId.appspot.com) would watch
// a different, empty bucket than the one clients upload to.
// env override so a future prod deploy can't silently write to the dev bucket.
export const STORAGE_BUCKET = process.env.STORAGE_BUCKET ?? "gatekeep-dev-jg.firebasestorage.app";
export const bucket = () => getStorage().bucket(STORAGE_BUCKET);

// Every best-effort storage cleanup across the media/tracks pipelines goes
// through here instead of a bare `.catch(() => {})` — a cleanup that
// silently fails (quota, a permissions drift, an emulator hiccup) would
// otherwise leave no trace anywhere. Still non-fatal: logging, never
// rethrowing, so a cleanup failure can never turn into a stuck/duplicate
// object. Originally private to media.ts (processUpload); moved here so
// tracks.ts's reviewTrack can reuse the same logged-catch pattern — `source`
// identifies the caller (e.g. "processUpload", "reviewTrack") so the log
// line doesn't misattribute a cleanup to the wrong pipeline.
export function logDeleteFailure(source: string, phase: string, path: string) {
  return (e: unknown) => console.error(`${source}: ${phase} cleanup failed`, path, e);
}
