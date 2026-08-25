import { describe, it, beforeAll, afterAll } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { ref, uploadBytes, getBytes, getDownloadURL, listAll, deleteObject } from "firebase/storage";

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "gatekeep-dev-jg",
    storage: { rules: readFileSync("../storage.rules", "utf8"), host: "localhost", port: 9199 },
  });
});
afterAll(async () => { await env.cleanup(); });

const bytes = new Uint8Array([1, 2, 3]);
const meta = (contentType: string) => ({ contentType });

describe("storage: staging/audio", () => {
  it("owner uploads audio to own staging path; wrong uid, wrong type fail", async () => {
    const alice = env.authenticatedContext("alice").storage();
    const bob = env.authenticatedContext("bob").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/audio/alice/p1/t1"), bytes, meta("audio/mpeg")));
    await assertFails(uploadBytes(ref(bob, "staging/audio/alice/p1/t2"), bytes, meta("audio/mpeg")));
    await assertFails(uploadBytes(ref(alice, "staging/audio/alice/p1/t3"), bytes, meta("video/mp4")));
  });
  it("staging is never readable, even by the owner", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/audio/alice/p1/t9"), bytes, meta("audio/mpeg")));
    await assertFails(getBytes(ref(alice, "staging/audio/alice/p1/t9")));
  });
  it("owner cannot delete their own staging object; the trigger owns cleanup", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/audio/alice/p1/t10"), bytes, meta("audio/mpeg")));
    await assertFails(deleteObject(ref(alice, "staging/audio/alice/p1/t10")));
  });
  it("a literal '..' profileId segment is rejected", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertFails(uploadBytes(ref(alice, "staging/audio/alice/../t11"), bytes, meta("audio/mpeg")));
  });
});

describe("storage: staging/photos", () => {
  it("owner uploads images with a well-formed avatar/cover name; bad names/types fail", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/avatar-abc123"), bytes, meta("image/jpeg")));
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/cover-xyz"), bytes, meta("image/png")));
    await assertFails(uploadBytes(ref(alice, "staging/photos/alice/p1/banner-abc"), bytes, meta("image/jpeg")));
    await assertFails(uploadBytes(ref(alice, "staging/photos/alice/p1/avatar-abc"), bytes, meta("application/pdf")));
  });
});

describe("storage: public and review", () => {
  it("public is world-readable and never client-writable", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), "public/tracks/p1/t1.m4a"), bytes, meta("audio/mp4"));
    });
    const anon = env.unauthenticatedContext().storage();
    await assertSucceeds(getBytes(ref(anon, "public/tracks/p1/t1.m4a")));
    await assertFails(uploadBytes(ref(anon, "public/tracks/p1/evil.m4a"), bytes, meta("audio/mp4")));
    await assertFails(listAll(ref(anon, "public")));
    const alice = env.authenticatedContext("alice").storage();
    await assertFails(uploadBytes(ref(alice, "public/photos/p1/avatar-x.jpg"), bytes, meta("image/jpeg")));
  });
  it("review is admin-read-only", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), "review/tracks/p1/t1.m4a"), bytes, meta("audio/mp4"));
    });
    const admin = env.authenticatedContext("root", { admin: true }).storage();
    const alice = env.authenticatedContext("alice").storage();
    const anon = env.unauthenticatedContext().storage();
    await assertSucceeds(getBytes(ref(admin, "review/tracks/p1/t1.m4a")));
    await assertFails(getBytes(ref(alice, "review/tracks/p1/t1.m4a")));
    await assertFails(getBytes(ref(anon, "review/tracks/p1/t1.m4a")));
  });
  it("regression guards: public getDownloadURL works, staging retry-overwrite allowed, photo delete denied", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), "public/tracks/p1/t2.m4a"), bytes, meta("audio/mp4"));
    });
    const anon = env.unauthenticatedContext().storage();
    // The app's real read path — must survive any future tightening of the get/list split.
    await assertSucceeds(getDownloadURL(ref(anon, "public/tracks/p1/t2.m4a")));
    const alice = env.authenticatedContext("alice").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/audio/alice/p1/retry1"), bytes, meta("audio/mpeg")));
    await assertSucceeds(uploadBytes(ref(alice, "staging/audio/alice/p1/retry1"), bytes, meta("audio/mpeg"))); // retry = update
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/avatar-del1"), bytes, meta("image/jpeg")));
    await assertFails(deleteObject(ref(alice, "staging/photos/alice/p1/avatar-del1")));
  });
});
