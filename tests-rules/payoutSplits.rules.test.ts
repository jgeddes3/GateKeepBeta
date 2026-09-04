import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import { initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { collection, doc, getDoc, getDocs, setDoc, query, where } from "firebase/firestore";

let env: RulesTestEnvironment;
beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "gatekeep-dev-jg",
    firestore: { rules: readFileSync("../firestore.rules", "utf8"), host: "localhost", port: 8080 },
  });
});
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });
const seed = async (path: string, data: object) => {
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), path), data); });
};

describe("users/{uid}/private/stripe", () => {
  it("owner reads, nobody else, no client writes", async () => {
    await seed("users/bob/private/stripe", { accountId: "acct_1", transfersEnabled: true, payoutsEnabled: true, instantEligible: false, onboardingStartedAt: 1, onboardedAt: 2, updatedAt: 2 });
    await assertSucceeds(getDoc(doc(env.authenticatedContext("bob").firestore(), "users/bob/private/stripe")));
    await assertFails(getDoc(doc(env.authenticatedContext("carol").firestore(), "users/bob/private/stripe")));
    await assertFails(setDoc(doc(env.authenticatedContext("bob").firestore(), "users/bob/private/stripe"), { accountId: "x" }));
  });
});

describe("heldShares", () => {
  it("the member and the profile's members read, others cannot, no client writes", async () => {
    await seed("profiles/band/members/alice", { uid: "alice", role: "admin", label: "", joinedAt: 1 });
    await seed("heldShares/k:bob", { profileId: "band", uid: "bob", amountCents: 500, purpose: "earnings", ref: { bookingId: "b", gigId: "g" }, status: "held", createdAt: 1, releasedAt: null, transferId: null });
    await assertSucceeds(getDoc(doc(env.authenticatedContext("bob").firestore(), "heldShares/k:bob")));
    await assertSucceeds(getDoc(doc(env.authenticatedContext("alice").firestore(), "heldShares/k:bob")));
    await assertSucceeds(getDocs(query(collection(env.authenticatedContext("alice").firestore(), "heldShares"), where("profileId", "==", "band"))));
    await assertSucceeds(getDocs(query(collection(env.authenticatedContext("bob").firestore(), "heldShares"), where("uid", "==", "bob"))));
    await assertFails(getDoc(doc(env.authenticatedContext("carol").firestore(), "heldShares/k:bob")));
    await assertFails(setDoc(doc(env.authenticatedContext("bob").firestore(), "heldShares/k:bob"), { status: "released" }));
  });
  it("ledger stays admin-only", async () => {
    await seed("ledger/share_transfer:tr_1", { kind: "share_transfer", amountCents: 1, uid: "bob", profileId: "band", at: 1 });
    await assertFails(getDoc(doc(env.authenticatedContext("bob").firestore(), "ledger/share_transfer:tr_1")));
  });
});
