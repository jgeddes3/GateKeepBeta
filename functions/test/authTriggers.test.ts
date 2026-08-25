// Admin SDK against emulator to read users docs regardless of rules.
process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";

import { describe, it, expect } from "vitest";
import { doc, getDoc } from "firebase/firestore";
import { signUpTestUser, db, wait } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";

const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });

describe("onUserCreated", () => {
  it("creates users/{uid} with email and defaults", async () => {
    const { uid } = await signUpTestUser(`alice-${Date.now()}@test.com`);
    await wait(1500); // trigger is async
    const snap = await adminFirestore(admin).doc(`users/${uid}`).get();
    expect(snap.exists).toBe(true);
    expect(snap.data()?.email).toContain("@test.com");
    expect(snap.data()?.photoUrl).toBeNull();
    expect(typeof snap.data()?.createdAt).toBe("number");
  });
});
