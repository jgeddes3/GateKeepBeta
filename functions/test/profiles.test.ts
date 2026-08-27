import { describe, it, expect, vi } from "vitest";
import {
  signUpTestUser, signUpUnverifiedTestUser, callFn, wait, uploadTestAudio, makeWav, waitForTrackStatus, makeAdminUser,
  seedCuratorGateContent,
} from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getStorage as adminStorage } from "firebase-admin/storage";
import {
  RESUBMIT_COOLDOWN_MS, type ProfileDraftInput, type CreateTrackInput, type GigDoc, type BookingRequestDoc,
} from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
// Admin SDK must target the storage emulator (mirrors helpers.ts) — needed
// by the deleteProfile storage cascade tests below.
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= "localhost:9199";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const abucket = adminStorage(admin).bucket("gatekeep-dev-jg.firebasestorage.app");

// The draft-cap and deleteProfile tests below make several sequential
// callable invocations per test; give them the same cold-start headroom
// used elsewhere in this suite (see members.test.ts / review.test.ts). The
// SP4 (Task 7) booking-cascade test further down chains a real
// applyToGig -> acceptBooking pair on top of that, matching
// bookingLifecycle.test.ts's own 20s precedent for this family of tests.
vi.setConfig({ testTimeout: 20_000 });

const draft = (handle: string): ProfileDraftInput =>
  ({ type: "musician", subtype: "band", name: "The Midnight Owls", handle });

// For submitProfileForReview tests whose subject is the status transition
// itself (not the Task 4 curator minimum-content gate, tested separately
// below) — pair with seedCuratorGateContent before submitting so those tests
// stay focused on submit/resubmit/delete mechanics.
const curatorDraft = (handle: string): ProfileDraftInput =>
  ({ type: "curator", subtype: "venue", name: "The Rooftop", handle });

// SP4 (Task 7) fixture — an approved musician profile with genuine
// portfolio-gate content, mirroring bookings.test.ts/bookingLifecycle.test.ts's
// identical helper. This file's own subject is profile deletion mechanics,
// not booking negotiation.
async function makeApprovedMusicianProfile(emailPrefix: string) {
  const owner = await signUpTestUser(`${emailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "musician", subtype: "solo", name: "The Act", handle: `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    owner.user);
  await adb.doc(`profiles/${profileId}`).update({
    "portfolio.bio": "A great live act.",
    "portfolio.genres": ["rock"],
    "portfolio.avatarPhotoPath": "public/photos/seed/avatar-seed.jpg",
  });
  await adb.doc(`profiles/${profileId}/tracks/seed-track`).set({
    title: "Demo", status: "approved", uploaderUid: owner.uid,
    startSec: 0, durationSec: 20, storagePath: "public/tracks/seed/demo.m4a",
    rejectionReason: null, failureReason: null, order: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const admin = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, admin.user);
  return { owner, profileId };
}

// SP4 (Task 7) fixture — a directly-seeded "open" gig, mirroring
// review.test.ts's identical seedOpenGig helper.
async function seedOpenGig(curatorProfileId: string): Promise<string> {
  const ref = adb.collection("gigs").doc();
  const now = Date.now();
  const doc: GigDoc = {
    curatorProfileId, seriesId: null, detachedFromTemplate: false,
    title: "Seeded gig", description: "", wants: { genres: ["rock"], actSizes: ["band"] },
    budget: { minCents: 1000, maxCents: 2000, structure: "perHour" },
    startsAt: now + 7 * 24 * 3600 * 1000, durationMinutes: 60,
    provisions: { hasPA: null, hasBackline: null, notes: null },
    location: {
      venueName: "The Rooftop", neighborhood: "Downtown", city: "Austin",
      geo: { lat: 30.27, lng: -97.74 }, addressVisibility: "public", address: "123 Main St, Austin, TX",
    },
    status: "open", createdAt: now, updatedAt: now,
    bookingId: null, bookedMusicianProfileId: null,
  };
  await ref.set(doc);
  return ref.id;
}

// SP4 (Task 7 quality-review fix) — mirrors review.test.ts/
// bookingLifecycle.test.ts's identical pollNotifications helper.
async function pollNotifications(uid: string) {
  const deadline = Date.now() + 10_000;
  let notes = await adb.collection(`users/${uid}/notifications`).get();
  while (notes.empty && Date.now() < deadline) {
    await wait(250);
    notes = await adb.collection(`users/${uid}/notifications`).get();
  }
  return notes;
}

describe("createProfileDraft", () => {
  it("creates draft profile, claims handle, adds creator as admin member", async () => {
    const { user, uid } = await signUpTestUser(`m1-${Date.now()}@test.com`);
    const handle = `owls_${Date.now()}`;
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", draft(handle), user);
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.status).toBe("draft");
    expect((await adb.doc(`handles/${handle}`).get()).data()?.profileId).toBe(profileId);
    const m = await adb.doc(`profiles/${profileId}/members/${uid}`).get();
    expect(m.data()?.role).toBe("admin");
  });
  it("rejects a taken handle and a reserved handle", async () => {
    const { user } = await signUpTestUser(`m2-${Date.now()}@test.com`);
    const handle = `dupe_${Date.now()}`;
    await callFn("createProfileDraft", draft(handle), user);
    await expect(callFn("createProfileDraft", draft(handle), user)).rejects.toThrow(/taken/i);
    await expect(callFn("createProfileDraft", draft("admin"), user)).rejects.toThrow(/reserved/i);
  });
  it("rejects unauthenticated calls", async () => {
    await expect(callFn("createProfileDraft", draft(`x_${Date.now()}`))).rejects.toThrow();
  });
  it("rejects an unverified-email caller with failed-precondition", async () => {
    const { user } = await signUpUnverifiedTestUser(`unverified-${Date.now()}@test.com`);
    await expect(callFn("createProfileDraft", draft(`unv_${Date.now()}`), user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });
  it("caps unsubmitted (draft/rejected) profiles per admin at 3, to prevent handle-squatting via never-submitted drafts", async () => {
    const { user } = await signUpTestUser(`cap-${Date.now()}@test.com`);
    for (let i = 0; i < 3; i++) {
      await callFn("createProfileDraft", draft(`cap${i}_${Date.now()}`), user);
    }
    await expect(callFn("createProfileDraft", draft(`cap3_${Date.now()}`), user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted" });
  });
});

describe("deleteProfile", () => {
  it("a profile admin deletes the profile: profile, members, and handle are all gone; audit written", async () => {
    const { user, uid } = await signUpTestUser(`del1-${Date.now()}@test.com`);
    const handle = `delp_${Date.now()}`;
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", draft(handle), user);
    await callFn("deleteProfile", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).exists).toBe(false);
    expect((await adb.doc(`profiles/${profileId}/members/${uid}`).get()).exists).toBe(false);
    expect((await adb.doc(`handles/${handle}`).get()).exists).toBe(false);
    const logs = await adb.collection("auditLogs")
      .where("targetId", "==", profileId).where("action", "==", "profile_deleted").get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data().actorUid).toBe(uid);
  });

  it("SP4 Task 13 (review): deleteProfile does not clobber a handle already reclaimed by a different profile (retry-safety)", async () => {
    const { user } = await signUpTestUser(`del1b-${Date.now()}@test.com`);
    const handle = `del1bp_${Date.now()}`;
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", draft(handle), user);
    // Simulates the retry edge the fix defends against: an EARLIER
    // deleteProfile attempt on THIS profile already freed the handle (then
    // crashed before recursiveDelete, leaving the profile doc — still
    // draft — for a client retry to find, exactly as here), and a totally
    // DIFFERENT profile has since claimed that now-free handle string.
    // Forcing the handles/{handle} doc directly (not via a second real
    // profile) isolates the assertion to deleteProfile's own precondition-
    // read, matching this suite's established isolation style elsewhere.
    const otherProfileId = "unrelated-profile-owns-this-handle-now";
    await adb.doc(`handles/${handle}`).set({ profileId: otherProfileId });

    await callFn("deleteProfile", { profileId }, user);

    expect((await adb.doc(`profiles/${profileId}`).get()).exists).toBe(false);
    // The handle doc survives, untouched, still naming the other claim.
    const handleDoc = await adb.doc(`handles/${handle}`).get();
    expect(handleDoc.exists).toBe(true);
    expect(handleDoc.data()?.profileId).toBe(otherProfileId);
  });

  it("a non-admin cannot delete the profile", async () => {
    const { user: admin } = await signUpTestUser(`del2-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", draft(`delp2_${Date.now()}`), admin);
    const { user: outsider } = await signUpTestUser(`del3-${Date.now()}@test.com`);
    await expect(callFn("deleteProfile", { profileId }, outsider))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("resolves the deletion dead-end: after deleteProfile, a formerly-sole-admin user can then deleteAccount", async () => {
    const { user } = await signUpTestUser(`del4-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", draft(`delp4_${Date.now()}`), user);
    // Blocked while sole admin (deleteAccount's existing invariant, unchanged).
    await expect(callFn("deleteAccount", {}, user)).rejects.toThrow(/admin/i);
    await callFn("deleteProfile", { profileId }, user);
    await expect(callFn("deleteAccount", {}, user)).resolves.toMatchObject({ ok: true });
  });

  // Finding 3: deleteProfile used to be client-gated only — a co-admin could
  // delete a LIVE approved profile server-side and immediately free the
  // handle for takeover. The server must enforce the same draft/rejected-only
  // gate the UI already assumes.
  it("refuses to delete an approved profile with failed-precondition; the profile, handle, and members all survive", async () => {
    const { user } = await signUpTestUser(`del5-${Date.now()}@test.com`);
    const handle = `del5p_${Date.now()}`;
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", curatorDraft(handle), user);
    await seedCuratorGateContent(adb, profileId);
    await callFn("submitProfileForReview", { profileId }, user);
    const adminUser = await makeAdminUser("del5admin");
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);
    await expect(callFn("deleteProfile", { profileId }, user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    expect((await adb.doc(`profiles/${profileId}`).get()).exists).toBe(true);
    expect((await adb.doc(`handles/${handle}`).get()).exists).toBe(true);
  });

  it("refuses to delete a pending_review profile with failed-precondition", async () => {
    const { user } = await signUpTestUser(`del6-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", curatorDraft(`del6p_${Date.now()}`), user);
    await seedCuratorGateContent(adb, profileId);
    await callFn("submitProfileForReview", { profileId }, user);
    await expect(callFn("deleteProfile", { profileId }, user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    expect((await adb.doc(`profiles/${profileId}`).get()).exists).toBe(true);
  });

  it("still allows deleting a draft profile and a rejected profile", async () => {
    const { user } = await signUpTestUser(`del7-${Date.now()}@test.com`);
    const { profileId: draftId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", curatorDraft(`del7d_${Date.now()}`), user);
    await callFn("deleteProfile", { profileId: draftId }, user);
    expect((await adb.doc(`profiles/${draftId}`).get()).exists).toBe(false);

    const { profileId: rejId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", curatorDraft(`del7r_${Date.now()}`), user);
    await seedCuratorGateContent(adb, rejId);
    await callFn("submitProfileForReview", { profileId: rejId }, user);
    const adminUser = await makeAdminUser("del7admin");
    await callFn("reviewProfile", { profileId: rejId, decision: "rejected", reason: "No thanks" }, adminUser.user);
    await callFn("deleteProfile", { profileId: rejId }, user);
    expect((await adb.doc(`profiles/${rejId}`).get()).exists).toBe(false);
  });

  it("rejects an unverified-email caller with failed-precondition", async () => {
    const { user } = await signUpTestUser(`del8-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", curatorDraft(`del8_${Date.now()}`), user);
    const { user: unverified } = await signUpUnverifiedTestUser(`del8u-${Date.now()}@test.com`);
    // unverified isn't even a member here, but the email-verification guard
    // must run (and fail) before that membership check is reached.
    await expect(callFn("deleteProfile", { profileId }, unverified))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("rejects a malformed profile id with invalid-argument", async () => {
    const { user } = await signUpTestUser(`del9-${Date.now()}@test.com`);
    await expect(callFn("deleteProfile", { profileId: "../etc" }, user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
});

describe("deleteProfile gig/series cascade (S6)", () => {
  it("removes the curator's gigs (with their private/location subdocs) and series", async () => {
    const { user } = await signUpTestUser(`s6a-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", curatorDraft(`s6a_${Date.now()}`), user);
    await seedCuratorGateContent(adb, profileId);
    await callFn("submitProfileForReview", { profileId }, user);
    const adminUser = await makeAdminUser("s6aadmin");
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);

    // Seed a gig (with a private/location subdoc) and a series directly —
    // this test's subject is the cascade, not gig/series creation mechanics.
    const gigRef = adb.collection("gigs").doc();
    await gigRef.set({
      curatorProfileId: profileId, seriesId: null, detachedFromTemplate: false,
      title: "X", description: "", wants: { genres: ["rock"], actSizes: ["band"] },
      budget: { minCents: 1000, maxCents: 2000, structure: "perHour" },
      startsAt: Date.now(), durationMinutes: 60,
      provisions: { hasPA: null, hasBackline: null, notes: null },
      location: { venueName: null, neighborhood: null, city: "Austin", geo: null, addressVisibility: "neighborhood", address: null },
      status: "draft", createdAt: Date.now(), updatedAt: Date.now(),
    });
    await adb.doc(`gigs/${gigRef.id}/private/location`).set({ address: "123 Main St", geo: { lat: 1, lng: 2 } });
    const seriesRef = adb.collection("gigSeries").doc();
    await seriesRef.set({
      curatorProfileId: profileId,
      recurrence: { weekday: 5, hour: 20, minute: 0, cadence: "weekly", endDate: null },
      fillMode: "per_occurrence", template: {},
      status: "active", materializedThrough: 0, createdAt: Date.now(), updatedAt: Date.now(),
    });

    // reject-from-approved is required before deleteProfile will accept
    // this profile (the draft/rejected-only gate) — its cascade closes/pauses
    // "open"/"active" content, but this gig is "draft" (untouched by it),
    // proving what removes it here is deleteProfile's OWN cascade.
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "test" }, adminUser.user);

    await callFn("deleteProfile", { profileId }, user);

    expect((await gigRef.get()).exists).toBe(false);
    expect((await adb.doc(`gigs/${gigRef.id}/private/location`).get()).exists).toBe(false);
    expect((await seriesRef.get()).exists).toBe(false);
  });

  it("does not touch another profile's gigs/series — negative control", async () => {
    const { user } = await signUpTestUser(`s6c-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", curatorDraft(`s6c_${Date.now()}`), user);
    const otherGigRef = adb.collection("gigs").doc();
    await otherGigRef.set({
      curatorProfileId: "some-other-profile-id", seriesId: null, detachedFromTemplate: false,
      title: "Survivor", description: "", wants: { genres: ["rock"], actSizes: ["band"] },
      budget: { minCents: 1000, maxCents: 2000, structure: "perHour" },
      startsAt: Date.now(), durationMinutes: 60,
      provisions: { hasPA: null, hasBackline: null, notes: null },
      location: { venueName: null, neighborhood: null, city: "Austin", geo: null, addressVisibility: "neighborhood", address: null },
      status: "draft", createdAt: Date.now(), updatedAt: Date.now(),
    });
    await callFn("deleteProfile", { profileId }, user);
    expect((await otherGigRef.get()).exists).toBe(true);
  });

  it("recomputes curatorAccess for former members — a uid with no other approved curator membership loses a (possibly stale) marker", async () => {
    const { user, uid } = await signUpTestUser(`s6b-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", curatorDraft(`s6b_${Date.now()}`), user);
    // Seeded directly — isolates the assertion to deleteProfile's OWN
    // post-cascade recompute rather than any earlier review.ts touchpoint
    // (this profile is deleted straight from "draft", which never runs
    // review.ts's cascade at all).
    await adb.doc(`curatorAccess/${uid}`).set({});
    await callFn("deleteProfile", { profileId }, user);
    expect((await adb.doc(`curatorAccess/${uid}`).get()).exists).toBe(false);
  });

  // SP4 (Task 7)
  it("unwinds a confirmed booking naming this profile — the booking survives as an 'expired' top-level record referencing the now-deleted profile id", async () => {
    const { user: curatorUser } = await signUpTestUser(`s6d-${Date.now()}@test.com`);
    const { profileId: curatorProfileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", curatorDraft(`s6d_${Date.now()}`), curatorUser);
    await seedCuratorGateContent(adb, curatorProfileId);
    await callFn("submitProfileForReview", { profileId: curatorProfileId }, curatorUser);
    const adminUser = await makeAdminUser("s6dadmin");
    await callFn("reviewProfile", { profileId: curatorProfileId, decision: "approved" }, adminUser.user);

    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("s6dm");
    const gigId = await seedOpenGig(curatorProfileId);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId, offer: { amountCents: 15000, note: "x" } }, musician.user);
    await callFn("acceptBooking", { bookingId }, curatorUser);
    expect((await adb.doc(`bookings/${bookingId}`).get()).data()?.status).toBe("confirmed");

    // Flip straight to "rejected" via the admin SDK (bypassing reviewProfile's
    // OWN reject-from-approved cascade entirely) so this test isolates
    // deleteProfile's OWN unwind cascade — not a booking already unwound by
    // an earlier step of the normal review-then-delete flow. This also
    // satisfies deleteProfile's own draft/rejected-only gate.
    await adb.doc(`profiles/${curatorProfileId}`).update({ status: "rejected" });

    await callFn("deleteProfile", { profileId: curatorProfileId }, curatorUser);

    expect((await adb.doc(`profiles/${curatorProfileId}`).get()).exists).toBe(false);
    const after = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(after.status).toBe("expired");
    expect(after.cancellation).toBeNull();
    // Top-level `bookings` doc is untouched by profileRef's recursiveDelete —
    // it survives, still naming the now-deleted curatorProfileId.
    expect(after.curatorProfileId).toBe(curatorProfileId);

    // Minor fix (Task 7 quality review): the musician side is notified.
    const musicianNotes = await pollNotifications(musician.uid);
    expect(musicianNotes.docs.some((d) =>
      d.data().kind === "booking" && /no longer available/i.test(d.data().body as string))).toBe(true);
  });
});

describe("submitProfileForReview", () => {
  it("moves draft to pending_review; only member admins may submit", async () => {
    const { user } = await signUpTestUser(`m3-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", curatorDraft(`sub_${Date.now()}`), user);
    await seedCuratorGateContent(adb, profileId);
    await callFn("submitProfileForReview", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("pending_review");
    const { user: outsider } = await signUpTestUser(`m4-${Date.now()}@test.com`);
    await expect(callFn("submitProfileForReview", { profileId }, outsider)).rejects.toThrow();
  });

  it("rejects re-submitting a profile already in pending_review", async () => {
    const { user } = await signUpTestUser(`m5-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", curatorDraft(`resub_${Date.now()}`), user);
    await seedCuratorGateContent(adb, profileId);
    await callFn("submitProfileForReview", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("pending_review");
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/pending_review|failed-precondition|Cannot submit/i);
  });

  it("rejects a non-admin member (role: member) trying to submit", async () => {
    const { user: admin } = await signUpTestUser(`m6-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", draft(`memb_${Date.now()}`), admin);
    const { uid: memberUid, user: member } = await signUpTestUser(`m7-${Date.now()}@test.com`);
    // Invite flow doesn't exist until Task 8 — seed the membership directly.
    await adb.doc(`profiles/${profileId}/members/${memberUid}`).set({
      uid: memberUid, role: "member", label: "x", joinedAt: Date.now(),
    });
    // The client SDK surfaces the HttpsError code as `functions/<code>` on
    // the rejected error's `.code`, not in `.message` — assert on that
    // rather than a message regex.
    await expect(callFn("submitProfileForReview", { profileId }, member))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});

describe("submitProfileForReview minimum content (musicians)", () => {
  it("refuses an empty musician draft, listing what's missing; passes once bio+genre+avatar+track exist", async () => {
    const { user } = await signUpTestUser(`gate-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Ava", handle: `gate_${Date.now()}` }, user);
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    await callFn("updatePortfolio", { profileId, bio: "Soul from Austin.", genres: ["soul"] }, user);
    // avatar via admin SDK shortcut (photo pipeline has its own tests)
    await adb.doc(`profiles/${profileId}`).update({ "portfolio.avatarPhotoPath": "public/photos/x/avatar-t.jpg" });
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/track/i); // still no track

    const wav = makeWav(12);
    const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Demo", startSec: 0, sizeBytes: wav.byteLength, contentType: "audio/wav" }, user);
    await uploadTestAudio(uploadPath, wav, "audio/wav", user);
    await waitForTrackStatus(adb, `profiles/${profileId}/tracks/${trackId}`, ["pending_review"]);
    await callFn("submitProfileForReview", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("pending_review");
  }, 60_000);

  it("lists all four missing items when nothing has been filled in", async () => {
    const { user } = await signUpTestUser(`gatem-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Empty", handle: `gatem_${Date.now()}` }, user);
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/bio.*genre.*photo.*track/i);
  });

  it("a track stuck in 'processing' (upload never completed) does not satisfy the gate", async () => {
    const { user } = await signUpTestUser(`gatep-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Stalled", handle: `gatep_${Date.now()}` }, user);
    await callFn("updatePortfolio", { profileId, bio: "Soul from Austin.", genres: ["soul"] }, user);
    await adb.doc(`profiles/${profileId}`).update({ "portfolio.avatarPhotoPath": "public/photos/x/avatar-t.jpg" });
    // createTrack writes the doc (status: "processing") before any bytes are
    // uploaded — abandon it here, exactly as a musician who never finishes
    // the upload would. LISTENABLE_TRACK_STATUSES excludes "processing", so
    // this must not satisfy the gate.
    await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Demo", startSec: 0, sizeBytes: 1000, contentType: "audio/wav" }, user);
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/track/i);
  });
});

describe("submitProfileForReview minimum content (curators)", () => {
  it("refuses an empty curator draft, listing what's missing; passes once about+photo+location+lookingFor exist", async () => {
    const { user } = await signUpTestUser(`cgate-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "curator", subtype: "venue", name: "The Room", handle: `cgate_${Date.now()}` }, user);
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/about.*photo.*location.*looking/i);

    await callFn("updateCuratorProfile", { profileId, about: "A great room for live music." }, user);
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/photo/i);

    await adb.doc(`profiles/${profileId}`).update({ "curator.photoPaths": ["public/photos/x/cover-t.jpg"] });
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/location/i);

    await callFn("updateCuratorProfile",
      { profileId, location: { address: "123 Main St, Austin, TX", city: "Austin" } }, user);
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/looking/i);

    await callFn("updateCuratorProfile",
      { profileId, lookingFor: { genres: ["rock"], actSizes: ["band"], notes: null } }, user);
    await callFn("submitProfileForReview", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("pending_review");
  });

  it("a venue's location requirement is not satisfied by a bare city — a real address is required", async () => {
    const { user } = await signUpTestUser(`cgatev-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "curator", subtype: "venue", name: "No Address Venue", handle: `cgatev_${Date.now()}` }, user);
    await callFn("updateCuratorProfile", { profileId, about: "x" }, user);
    await adb.doc(`profiles/${profileId}`).update({ "curator.photoPaths": ["public/photos/x/cover-t.jpg"] });
    await callFn("updateCuratorProfile",
      { profileId, lookingFor: { genres: ["rock"], actSizes: ["band"], notes: null } }, user);
    // Deliberately never set location — a venue's curator.location.address stays null.
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/location/i);
  });

  it("a planner/host's location requirement is satisfied by city alone (no street address ever stored)", async () => {
    const { user } = await signUpTestUser(`cgatep-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "curator", subtype: "planner", name: "Party Planner", handle: `cgatep_${Date.now()}` }, user);
    await callFn("updateCuratorProfile", { profileId, about: "x" }, user);
    await adb.doc(`profiles/${profileId}`).update({ "curator.photoPaths": ["public/photos/x/cover-t.jpg"] });
    await callFn("updateCuratorProfile", { profileId, location: { address: null, city: "Austin" } }, user);
    await callFn("updateCuratorProfile",
      { profileId, lookingFor: { genres: ["rock"], actSizes: ["band"], notes: null } }, user);
    await callFn("submitProfileForReview", { profileId }, user);
    const p = (await adb.doc(`profiles/${profileId}`).get()).data();
    expect(p?.status).toBe("pending_review");
    expect(p?.curator.location.address).toBeNull();
  });
});

describe("submitProfileForReview anti-spam", () => {
  it("caps pending curator profiles at MAX_PENDING_CURATOR_PROFILES per admin", async () => {
    const { user } = await signUpTestUser(`ccap-${Date.now()}@test.com`);
    const { profileId: p1 } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "curator", subtype: "venue", name: "Room A", handle: `ccapa_${Date.now()}` }, user);
    await seedCuratorGateContent(adb, p1);
    await callFn("submitProfileForReview", { profileId: p1 }, user);

    const { profileId: p2 } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "curator", subtype: "venue", name: "Room B", handle: `ccapb_${Date.now()}` }, user);
    await seedCuratorGateContent(adb, p2);
    await expect(callFn("submitProfileForReview", { profileId: p2 }, user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted" });
  });

  it("does not cap a musician submission on an unrelated curator's pending count", async () => {
    // Negative control: the curator pending-cap must only ever count curator
    // profiles, never gate a musician submission by the same admin.
    const { user } = await signUpTestUser(`ccapm-${Date.now()}@test.com`);
    const { profileId: curatorId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "curator", subtype: "venue", name: "Room C", handle: `ccapc_${Date.now()}` }, user);
    await seedCuratorGateContent(adb, curatorId);
    await callFn("submitProfileForReview", { profileId: curatorId }, user);

    const { profileId: musicianId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Solo Act", handle: `ccapms_${Date.now()}` }, user);
    await callFn("updatePortfolio", { profileId: musicianId, bio: "x", genres: ["soul"] }, user);
    await adb.doc(`profiles/${musicianId}`).update({ "portfolio.avatarPhotoPath": "public/photos/x/avatar-t.jpg" });
    const wav = makeWav(12);
    const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId: musicianId, title: "Demo", startSec: 0, sizeBytes: wav.byteLength, contentType: "audio/wav" }, user);
    await uploadTestAudio(uploadPath, wav, "audio/wav", user);
    await waitForTrackStatus(adb, `profiles/${musicianId}/tracks/${trackId}`, ["pending_review"]);
    await callFn("submitProfileForReview", { profileId: musicianId }, user);
    expect((await adb.doc(`profiles/${musicianId}`).get()).data()?.status).toBe("pending_review");
  }, 60_000);

  it("blocks resubmission within 24h of a rejection, and allows it again after 25h", async () => {
    const { user } = await signUpTestUser(`ccool-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "curator", subtype: "venue", name: "Cooldown Room", handle: `ccool_${Date.now()}` }, user);
    await seedCuratorGateContent(adb, profileId);
    await callFn("submitProfileForReview", { profileId }, user);
    const adminUser = await makeAdminUser("ccooladmin");
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "Not yet" }, adminUser.user);

    // +1h since rejection: still inside the 24h cooldown window.
    await adb.doc(`profiles/${profileId}`).update({ lastRejectedAt: Date.now() - 60 * 60 * 1000 });
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/24 hours/i);

    // +25h since rejection: past the cooldown, resubmission succeeds.
    await adb.doc(`profiles/${profileId}`).update({ lastRejectedAt: Date.now() - 25 * 60 * 60 * 1000 });
    await callFn("submitProfileForReview", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("pending_review");
  });

  // Task 8: resubmitCount lets the admin queue render "resubmitted Nth
  // time". Extends the cooldown fixture above — every resubmit still has to
  // clear the 24h cooldown, so lastRejectedAt is stamped back via the admin
  // SDK the same way that test does.
  it("resubmitCount increments across reject-then-resubmit cycles, and stays unset after the first-ever submission", async () => {
    const { user } = await signUpTestUser(`crsc-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "curator", subtype: "venue", name: "Resubmit Room", handle: `crsc_${Date.now()}` }, user);
    await seedCuratorGateContent(adb, profileId);
    await callFn("submitProfileForReview", { profileId }, user);
    // First-ever submission (draft -> pending_review) is not a "resubmit".
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.resubmitCount).toBeUndefined();

    const adminUser = await makeAdminUser("crscadmin");
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "Round 1" }, adminUser.user);
    await adb.doc(`profiles/${profileId}`).update({ lastRejectedAt: Date.now() - 25 * 60 * 60 * 1000 });
    await callFn("submitProfileForReview", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.resubmitCount).toBe(1);

    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "Round 2" }, adminUser.user);
    await adb.doc(`profiles/${profileId}`).update({ lastRejectedAt: Date.now() - 25 * 60 * 60 * 1000 });
    await callFn("submitProfileForReview", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.resubmitCount).toBe(2);
  });

  it("reviewProfile stamps lastRejectedAt on reject, live (not just via admin-SDK seeding above)", async () => {
    const { user } = await signUpTestUser(`cstamp-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "curator", subtype: "venue", name: "Stamp Room", handle: `cstamp_${Date.now()}` }, user);
    await seedCuratorGateContent(adb, profileId);
    await callFn("submitProfileForReview", { profileId }, user);
    const adminUser = await makeAdminUser("cstampadmin");
    const before = Date.now();
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "No thanks" }, adminUser.user);
    const p = (await adb.doc(`profiles/${profileId}`).get()).data();
    expect(typeof p?.lastRejectedAt).toBe("number");
    expect(p?.lastRejectedAt).toBeGreaterThanOrEqual(before);
  });

  it("cooldown boundary: just under RESUBMIT_COOLDOWN_MS elapsed is still blocked, just at/over it is allowed", async () => {
    const { user } = await signUpTestUser(`cbound-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "curator", subtype: "venue", name: "Boundary Room", handle: `cbound_${Date.now()}` }, user);
    await seedCuratorGateContent(adb, profileId);
    await callFn("submitProfileForReview", { profileId }, user);
    const adminUser = await makeAdminUser("cboundadmin");
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "Not yet" }, adminUser.user);

    // The check is `Date.now() - lastRejectedAt < RESUBMIT_COOLDOWN_MS`,
    // evaluated server-side at call time — not at the moment this test sets
    // lastRejectedAt via the admin SDK. A literal "-1ms / -0ms" boundary
    // isn't reliably testable across that gap: the RPC round-trip between
    // the write below and the callable actually running always costs a few
    // ms, which would silently push a naive "-1ms" case past the threshold
    // (observed while developing this test — it flaked green). A 300ms
    // margin is tight enough to still be testing the boundary (worlds
    // tighter than the existing +1h/+25h test above) while comfortably
    // absorbing local-emulator round-trip jitter in either direction.
    const BOUNDARY_MARGIN_MS = 300;

    // Just under the cooldown: elapsed at call time is (COOLDOWN - margin) +
    // network jitter, which stays < COOLDOWN as long as that jitter is
    // under the margin — still blocked.
    await adb.doc(`profiles/${profileId}`).update({
      lastRejectedAt: Date.now() - (RESUBMIT_COOLDOWN_MS - BOUNDARY_MARGIN_MS),
    });
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    // Just at/over the cooldown: elapsed at call time is (COOLDOWN + margin)
    // + network jitter, which is always >= COOLDOWN regardless of jitter —
    // allowed.
    await adb.doc(`profiles/${profileId}`).update({
      lastRejectedAt: Date.now() - (RESUBMIT_COOLDOWN_MS + BOUNDARY_MARGIN_MS),
    });
    await callFn("submitProfileForReview", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("pending_review");
  });

  it("the resubmit cooldown is a shared code path — it also blocks a musician's resubmission", async () => {
    const { user } = await signUpTestUser(`mcool-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Cooldown Act", handle: `mcool_${Date.now()}` }, user);
    await callFn("updatePortfolio", { profileId, bio: "x", genres: ["soul"] }, user);
    await adb.doc(`profiles/${profileId}`).update({ "portfolio.avatarPhotoPath": "public/photos/x/avatar-t.jpg" });
    const wav = makeWav(12);
    const { trackId, uploadPath } = await callFn<CreateTrackInput, { trackId: string; uploadPath: string }>(
      "createTrack", { profileId, title: "Demo", startSec: 0, sizeBytes: wav.byteLength, contentType: "audio/wav" }, user);
    await uploadTestAudio(uploadPath, wav, "audio/wav", user);
    await waitForTrackStatus(adb, `profiles/${profileId}/tracks/${trackId}`, ["pending_review"]);
    await callFn("submitProfileForReview", { profileId }, user);
    const adminUser = await makeAdminUser("mcooladmin");
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "Needs work" }, adminUser.user);

    // Musician submissions never went through a curator-only code path, so
    // this proves the cooldown check itself (not just the curator gate) is
    // type-agnostic, matching reviewProfile stamping lastRejectedAt for any type.
    await adb.doc(`profiles/${profileId}`).update({ lastRejectedAt: Date.now() - 60 * 60 * 1000 });
    await expect(callFn("submitProfileForReview", { profileId }, user))
      .rejects.toThrow(/24 hours/i);
  }, 60_000);
});

describe("deleteProfile storage cascade", () => {
  it("deletes the profile's public/review storage objects along with the docs", async () => {
    const { user } = await signUpTestUser(`delc-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Ava", handle: `delc_${Date.now()}` }, user);
    // Seed storage objects directly — exercising the full pipeline is Task 7's job.
    await abucket.file(`review/tracks/${profileId}/t1.m4a`).save(Buffer.from([1]), { contentType: "audio/mp4" });
    await abucket.file(`public/tracks/${profileId}/t2.m4a`).save(Buffer.from([1]), { contentType: "audio/mp4" });
    await abucket.file(`public/photos/${profileId}/avatar-x.jpg`).save(Buffer.from([1]), { contentType: "image/jpeg" });
    await callFn("deleteProfile", { profileId }, user);
    for (const p of [`review/tracks/${profileId}/t1.m4a`, `public/tracks/${profileId}/t2.m4a`,
                     `public/photos/${profileId}/avatar-x.jpg`]) {
      const [exists] = await abucket.file(p).exists();
      expect(exists).toBe(false);
    }
  }, 60_000);

  it("does not touch another profile's storage objects — negative control on the prefix sweep", async () => {
    const { user } = await signUpTestUser(`delcn-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Ava2", handle: `delcn_${Date.now()}` }, user);
    const { profileId: otherProfileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "musician", subtype: "solo", name: "Bystander", handle: `delcn2_${Date.now()}` }, user);
    const survivor = `public/tracks/${otherProfileId}/t9.m4a`;
    await abucket.file(survivor).save(Buffer.from([1]), { contentType: "audio/mp4" });
    await callFn("deleteProfile", { profileId }, user);
    const [exists] = await abucket.file(survivor).exists();
    expect(exists).toBe(true);
  }, 60_000);
});
