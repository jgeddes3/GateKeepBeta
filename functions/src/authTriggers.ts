import * as functionsV1 from "firebase-functions/v1";
import { getFirestore } from "firebase-admin/firestore";
import type { UserDoc } from "@gatekeep/shared";

// v1 API: auth onCreate has no v2 equivalent yet.
export const onUserCreated = functionsV1.auth.user().onCreate(async (user) => {
  const docData: UserDoc = {
    displayName: user.displayName ?? user.email?.split("@")[0] ?? "New user",
    email: user.email ?? "",
    photoUrl: user.photoURL ?? null,
    homeCity: null,
    createdAt: Date.now(),
  };
  await getFirestore().doc(`users/${user.uid}`).set(docData);
});
