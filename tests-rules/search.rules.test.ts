import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { collection, doc, getDoc, getDocs, setDoc, deleteDoc, query, where } from "firebase/firestore";

// Sub-project 8 rules matrix: searchIndex and searchBudgets are server-only,
// savedSearches are owner-read and callable-write.

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

describe("searchIndex and searchBudgets", () => {
  it("nobody reads or writes them, not even admin or the subject", async () => {
    await seed("searchIndex/artist_mus1", { kind: "artist", sourceId: "mus1", title: "The Act" });
    await seed("searchBudgets/bob", { date: "2026-09-02", count: 1 });
    const bob = env.authenticatedContext("bob").firestore();
    const root = env.authenticatedContext("root", { admin: true }).firestore();
    for (const db of [bob, root]) {
      await assertFails(getDoc(doc(db, "searchIndex/artist_mus1")));
      await assertFails(getDocs(query(collection(db, "searchIndex"), where("kind", "==", "artist"))));
      await assertFails(setDoc(doc(db, "searchIndex/artist_mus2"), { kind: "artist" }));
      await assertFails(getDoc(doc(db, "searchBudgets/bob")));
      await assertFails(setDoc(doc(db, "searchBudgets/bob"), { date: "2026-09-02", count: 0 }));
    }
  });
});

describe("savedSearches", () => {
  it("owner can get and list their own; others and anonymous cannot; no client writes", async () => {
    await seed("savedSearches/s1", { uid: "bob", face: "fan", kind: "show", q: "owls", filters: {}, label: "\"owls\"", createdAt: 1, lastMatchedAt: null });
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(getDoc(doc(bob, "savedSearches/s1")));
    await assertSucceeds(getDocs(query(collection(bob, "savedSearches"), where("uid", "==", "bob"))));
    const carol = env.authenticatedContext("carol").firestore();
    await assertFails(getDoc(doc(carol, "savedSearches/s1")));
    await assertFails(getDocs(query(collection(carol, "savedSearches"), where("uid", "==", "bob"))));
    await assertFails(getDocs(query(collection(env.unauthenticatedContext().firestore(), "savedSearches"), where("uid", "==", "bob"))));
    await assertFails(setDoc(doc(bob, "savedSearches/s2"), { uid: "bob", face: "fan", kind: "show", q: "", filters: {}, label: "", createdAt: 1, lastMatchedAt: null }));
    await assertFails(deleteDoc(doc(bob, "savedSearches/s1")));
  });
});
