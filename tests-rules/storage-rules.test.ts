import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
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
beforeEach(async () => { await env.clearStorage(); });

const bytes = new Uint8Array([1, 2, 3]);
const meta = (contentType: string) => ({ contentType });

describe("storage: public serving path", () => {
  // SP6 posters live under the same world-readable public/photos prefix as
  // avatars and covers, and a fan looking at an event page is often signed
  // out, so the anonymous read is the case that actually has to work.
  it("an anonymous reader gets a processed poster object", async () => {
    const path = "public/photos/p1/poster-3fa85f64-5717-4562-b3fc-2c963f66afa6.jpg";
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), path), bytes, meta("image/jpeg"));
    });
    const anon = env.unauthenticatedContext().storage();
    await assertSucceeds(getBytes(ref(anon, path)));
    await assertSucceeds(getDownloadURL(ref(anon, path)));
  });
});

describe("storage: staging/audio", () => {
  it("owner uploads audio to own staging path; wrong uid, wrong type, zero-byte fail", async () => {
    const alice = env.authenticatedContext("alice").storage();
    const bob = env.authenticatedContext("bob").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/audio/alice/p1/t1"), bytes, meta("audio/mpeg")));
    await assertFails(uploadBytes(ref(bob, "staging/audio/alice/p1/t2"), bytes, meta("audio/mpeg")));
    await assertFails(uploadBytes(ref(alice, "staging/audio/alice/p1/t3"), bytes, meta("video/mp4")));
    await assertFails(uploadBytes(ref(alice, "staging/audio/alice/p1/t4"), new Uint8Array(0), meta("audio/mpeg")));
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
  it("retrying an upload (create then update) to the same staging path is allowed", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/audio/alice/p1/retry1"), bytes, meta("audio/mpeg")));
    await assertSucceeds(uploadBytes(ref(alice, "staging/audio/alice/p1/retry1"), bytes, meta("audio/mpeg"))); // retry = update
  });
  it("a literal '..' profileId or trackId segment, or a dot-containing profileId, is rejected", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertFails(uploadBytes(ref(alice, "staging/audio/alice/../t11"), bytes, meta("audio/mpeg")));
    await assertFails(uploadBytes(ref(alice, "staging/audio/alice/p1/.."), bytes, meta("audio/mpeg")));
    // "bad.id" fails the profileId char class regardless of whether the SDK
    // normalizes ".." segments before the request reaches the rules engine.
    await assertFails(uploadBytes(ref(alice, "staging/audio/alice/bad.id/t1"), bytes, meta("audio/mpeg")));
  });
});

describe("storage: staging/photos", () => {
  it("owner uploads images with a well-formed avatar/cover name; bad names/types fail", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/avatar-abc123"), bytes, meta("image/jpeg")));
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/cover-xyz"), bytes, meta("image/png")));
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/avatar-webp1"), bytes, meta("image/webp")));
    await assertFails(uploadBytes(ref(alice, "staging/photos/alice/p1/banner-abc"), bytes, meta("image/jpeg")));
    await assertFails(uploadBytes(ref(alice, "staging/photos/alice/p1/avatar-abc"), bytes, meta("application/pdf")));
  });
  it("owner uploads a gallery-kind image (curator profiles, Task 4b); a junk kind still fails", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/gallery-abc123"), bytes, meta("image/jpeg")));
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/gallery-xyz"), bytes, meta("image/png")));
    // Junk kind (not avatar/cover/gallery) is still rejected, the pattern
    // widened by one literal alternative, not loosened to accept anything.
    await assertFails(uploadBytes(ref(alice, "staging/photos/alice/p1/banner-abc"), bytes, meta("image/jpeg")));
  });
  it("owner uploads a poster-kind image (events, SP6 Task 4); a junk kind still fails", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/poster-abc123"), bytes, meta("image/jpeg")));
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/poster-xyz"), bytes, meta("image/png")));
    // Junk kind (not avatar/cover/gallery/poster) is still rejected: the
    // pattern widened by one literal alternative, not loosened to accept anything.
    await assertFails(uploadBytes(ref(alice, "staging/photos/alice/p1/banner-abc"), bytes, meta("image/jpeg")));
  });
  it("owner cannot delete a staging photo either; the trigger owns cleanup", async () => {
    const alice = env.authenticatedContext("alice").storage();
    await assertSucceeds(uploadBytes(ref(alice, "staging/photos/alice/p1/avatar-del1"), bytes, meta("image/jpeg")));
    await assertFails(deleteObject(ref(alice, "staging/photos/alice/p1/avatar-del1")));
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
  it("review reads are admin-only", async () => {
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
  it("review and public are pipeline-only, even for admins", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), "public/tracks/pz/t.m4a"), bytes, meta("audio/mp4"));
    });
    const admin = env.authenticatedContext("root", { admin: true }).storage();
    // Admin context is required: rules are default-deny, so a non-admin assertion
    // cannot tell `write: if false` from `write: if isAdmin()`.
    await assertFails(uploadBytes(ref(admin, "review/tracks/pz/evil.m4a"), bytes, meta("audio/mp4")));
    await assertFails(uploadBytes(ref(admin, "public/tracks/pz/evil.m4a"), bytes, meta("audio/mp4")));
    await assertFails(deleteObject(ref(admin, "public/tracks/pz/t.m4a")));
  });
  it("regression guard: public getDownloadURL works", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), "public/tracks/p1/t2.m4a"), bytes, meta("audio/mp4"));
    });
    const anon = env.unauthenticatedContext().storage();
    // The app's real read path, must survive any future tightening of the get/list split.
    await assertSucceeds(getDownloadURL(ref(anon, "public/tracks/p1/t2.m4a")));
  });
  it("a public/../review/... traversal-shaped object name is denied, even though it starts with public/", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      // GCS object names are flat strings, ".." here is a literal segment,
      // not filesystem traversal, but a fully-permissive
      // `public/{allPaths=**}` + `get:if true` rule would still match this
      // name since it starts with "public/". The segment-constrained rule
      // must reject it: "kind" resolves to "..", which fails the
      // tracks/photos allowlist.
      await uploadBytes(ref(ctx.storage(), "public/../review/tracks/p1/secret.m4a"), bytes, meta("audio/mp4"));
    });
    const anon = env.unauthenticatedContext().storage();
    const admin = env.authenticatedContext("root", { admin: true }).storage();
    await assertFails(getBytes(ref(anon, "public/../review/tracks/p1/secret.m4a")));
    await assertFails(getBytes(ref(admin, "public/../review/tracks/p1/secret.m4a")));
  });
  it("legit public track/photo serving shapes still resolve; list still denied", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await uploadBytes(ref(ctx.storage(), "public/tracks/p1/t3.m4a"), bytes, meta("audio/mp4"));
      await uploadBytes(ref(ctx.storage(), "public/photos/p1/avatar-3fa85f64-5717-4562-b3fc-2c963f66afa6.jpg"),
        bytes, meta("image/jpeg"));
    });
    const anon = env.unauthenticatedContext().storage();
    await assertSucceeds(getBytes(ref(anon, "public/tracks/p1/t3.m4a")));
    await assertSucceeds(getBytes(ref(anon, "public/photos/p1/avatar-3fa85f64-5717-4562-b3fc-2c963f66afa6.jpg")));
    await assertFails(listAll(ref(anon, "public/tracks/p1")));
  });
});
