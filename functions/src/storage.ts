import { getStorage } from "firebase-admin/storage";

// Must match the client apps' storageBucket (apps/*/src/lib/firebase.ts) and the
// bucket the processUpload trigger listens on — the emulator namespaces buckets
// by name, so a bare getStorage().bucket() (projectId.appspot.com) would watch
// a different, empty bucket than the one clients upload to.
export const STORAGE_BUCKET = "gatekeep-dev-jg.firebasestorage.app";
export const bucket = () => getStorage().bucket(STORAGE_BUCKET);
