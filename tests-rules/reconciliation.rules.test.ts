import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { doc, setDoc, updateDoc } from "firebase/firestore";

// Sub-project 11 rules matrix: the users/{uid} owner update keeps photoUrl
// and loses displayName, homeCity, and homeGeo (updateAccount owns all
// three); events stay callable-only, tagged lineup acts included.

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

const seedUser = () => seed("users/bob", {
  displayName: "Bob", email: "bob@test.com", photoUrl: null,
  homeCity: "Austin", homeGeo: { lat: 30.27, lng: -97.74 }, createdAt: 1,
});

describe("users/{uid} owner update", () => {
  it("still writes photoUrl", async () => {
    await seedUser();
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(updateDoc(doc(bob, "users/bob"), { photoUrl: "https://example.com/a.jpg" }));
    await assertSucceeds(updateDoc(doc(bob, "users/bob"), { photoUrl: null }));
    await assertFails(updateDoc(doc(bob, "users/bob"), { photoUrl: "http://example.com/a.jpg" }));
  });
  it("cannot write displayName, homeCity, or homeGeo, alone or alongside photoUrl", async () => {
    await seedUser();
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(updateDoc(doc(bob, "users/bob"), { displayName: "Bobby" }));
    await assertFails(updateDoc(doc(bob, "users/bob"), { homeCity: "Dallas" }));
    await assertFails(updateDoc(doc(bob, "users/bob"), { homeCity: null }));
    await assertFails(updateDoc(doc(bob, "users/bob"), { homeGeo: { lat: 1, lng: 2 } }));
    await assertFails(updateDoc(doc(bob, "users/bob"),
      { photoUrl: "https://example.com/a.jpg", displayName: "Bobby" }));
    const carol = env.authenticatedContext("carol").firestore();
    await assertFails(updateDoc(doc(carol, "users/bob"), { photoUrl: "https://example.com/a.jpg" }));
  });
});

describe("events with a tagged lineup act", () => {
  it("stay world-readable when published and client-unwritable", async () => {
    await seed("events/ev1", {
      curatorProfileId: "cur1", title: "Tagged night", status: "published",
      lineup: [{ kind: "tagged", musicianProfileId: "mus1", name: "The Act", status: "pending", taggedAt: 1, respondedAt: null }],
      lineupMusicianProfileIds: [], startsAt: 2, endsAt: 3,
      ageRestriction: "18_plus", doorsAt: 1,
    });
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(updateDoc(doc(bob, "events/ev1"), {
      lineup: [{ kind: "tagged", musicianProfileId: "mus1", name: "The Act", status: "accepted", taggedAt: 1, respondedAt: 2 }],
    }));
  });
});
