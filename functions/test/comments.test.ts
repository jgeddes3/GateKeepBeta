import { describe, it, expect, vi } from "vitest";
import { callFn, makeAdminUser, signUpTestUser, signUpUnverifiedTestUser } from "./helpers";
import {
  adb, makeApprovedMusicianProfile, makeDraftEvent, addTiersAndPublish, makePublishedBookingEvent,
} from "./discoverFixtures";
import { addMember } from "./payoutFixtures";
import {
  COMMENT_UNDER_REVIEW_MESSAGE, EMAIL_NOT_VERIFIED_MESSAGE, REACTION_RATE_MAX,
  type EventCommentDoc, type EventDoc, type ShowPostDoc,
} from "@gatekeep/shared";
vi.setConfig({ testTimeout: 120_000 });

const FREE_TIER = [{ name: "GA", priceCents: 0, capacity: 20, saleStartsAt: null, saleEndsAt: null }];
const event = async (eventId: string) => (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
const count = async (eventId: string) => (await event(eventId)).commentCount ?? 0;
const comment = async (eventId: string, commentId: string) =>
  (await adb.doc(`events/${eventId}/comments/${commentId}`).get()).data() as EventCommentDoc | undefined;
const post = async (eventId: string, postId: string) =>
  (await adb.doc(`events/${eventId}/posts/${postId}`).get()).data() as ShowPostDoc;
const rateWindow = async (uid: string) =>
  (await adb.doc(`commentWindows/${uid}`).get()).data() as { at?: number[]; reactions?: number[] } | undefined;

type PostRes = { commentId: string; role: "fan" | "curator" | "artist" };
const say = (eventId: string, text: string, user: import("firebase/auth").User, parentId?: string) =>
  callFn<{ eventId: string; text: string; parentId?: string }, PostRes>(
    "postComment", { eventId, text, ...(parentId ? { parentId } : {}) }, user);

describe("postComment role derivation", () => {
  it("derives fan, curator, and artist, and refuses a closed event", async () => {
    // makePublishedBookingEvent gives a published event with a booking act,
    // so the musician side is a real lineup artist.
    const e = await makePublishedBookingEvent("cm1");
    const fan = await signUpTestUser(`cm1f-${Date.now()}@test.com`);

    const asFan = await say(e.eventId, "  can't wait  ", fan.user);
    expect(asFan.role).toBe("fan");
    const fanDoc = await comment(e.eventId, asFan.commentId);
    expect(fanDoc).toMatchObject({
      authorUid: fan.uid, authorRole: "fan", authorProfileId: null,
      parentId: null, text: "can't wait", hidden: false, hiddenBy: null, openReports: 0,
    });
    expect(fanDoc!.authorName.length).toBeGreaterThan(0);
    expect(await count(e.eventId)).toBe(1);

    const asCurator = await say(e.eventId, "doors at 8", e.owner.user);
    expect(asCurator.role).toBe("curator");
    expect(await comment(e.eventId, asCurator.commentId))
      .toMatchObject({ authorRole: "curator", authorProfileId: e.profileId });

    const asArtist = await say(e.eventId, "bringing the new set", e.musician.owner.user);
    expect(asArtist.role).toBe("artist");
    expect(await comment(e.eventId, asArtist.commentId))
      .toMatchObject({ authorRole: "artist", authorProfileId: e.musicianProfileId });
    expect(await count(e.eventId)).toBe(3);

    // The role follows MEMBERSHIP, not ownership: a plain member of either
    // profile carries the same tag as the founder.
    const curatorMember = await addMember(e.profileId, "cm1cm");
    expect((await say(e.eventId, "the bar opens at 7", curatorMember.user)).role).toBe("curator");
    const artistMember = await addMember(e.musicianProfileId, "cm1am");
    expect((await say(e.eventId, "our drummer is back", artistMember.user)).role).toBe("artist");
    expect(await count(e.eventId)).toBe(5);

    // Over-long text and an unverified email are both refused before anything
    // is written, so the count does not move.
    await expect(say(e.eventId, "x".repeat(501), fan.user)).rejects.toMatchObject({
      code: "functions/invalid-argument", message: "Comments are 1 to 500 characters.",
    });
    const unverified = await signUpUnverifiedTestUser(`cm1u-${Date.now()}@test.com`);
    await expect(say(e.eventId, "let me in", unverified.user)).rejects.toMatchObject({
      code: "functions/failed-precondition", message: EMAIL_NOT_VERIFIED_MESSAGE,
    });
    await expect(callFn("setGoing", { eventId: e.eventId, going: true }, unverified.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: EMAIL_NOT_VERIFIED_MESSAGE });
    expect(await count(e.eventId)).toBe(5);

    await adb.doc(`events/${e.eventId}`).update({ status: "cancelled" });
    await expect(say(e.eventId, "still on?", fan.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "Comments are closed." });
  });

  it("refuses comments on a draft event", async () => {
    const { eventId } = await makeDraftEvent("cm1d");
    const fan = await signUpTestUser(`cm1df-${Date.now()}@test.com`);
    await expect(say(eventId, "early bird", fan.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "Comments are closed." });
  });

  it("treats an ACCEPTED tagged act as an artist and a pending one as a fan", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("cm2");
    const artist = await makeApprovedMusicianProfile("cm2a");
    await callFn("tagEventArtist",
      { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, owner.user);
    await addTiersAndPublish(profileId, eventId, owner.user, FREE_TIER);

    // Pending: not on lineupMusicianProfileIds yet, so this member is a fan.
    const whilePending = await say(eventId, "pending here", artist.owner.user);
    expect(whilePending.role).toBe("fan");

    await callFn("respondToArtistTag",
      { eventId, musicianProfileId: artist.profileId, accept: true }, artist.owner.user);
    const afterAccept = await say(eventId, "accepted here", artist.owner.user);
    expect(afterAccept.role).toBe("artist");
    expect(await comment(eventId, afterAccept.commentId))
      .toMatchObject({ authorRole: "artist", authorProfileId: artist.profileId });
  });
});

describe("replies, hiding, deleting", () => {
  it("notifies only on a curator or artist reply to a FAN, and refuses two levels", async () => {
    const e = await makePublishedBookingEvent("cm3");
    const fan = await signUpTestUser(`cm3f-${Date.now()}@test.com`);
    const other = await signUpTestUser(`cm3o-${Date.now()}@test.com`);
    const root = await say(e.eventId, "who opens?", fan.user);

    await say(e.eventId, "no idea", other.user, root.commentId);
    const afterFanReply = await adb.collection(`users/${fan.uid}/notifications`)
      .where("kind", "==", "comment_reply").get();
    expect(afterFanReply.size).toBe(0);

    const curatorReply = await say(e.eventId, "The Act opens", e.owner.user, root.commentId);
    const notes = await adb.collection(`users/${fan.uid}/notifications`)
      .where("kind", "==", "comment_reply").get();
    expect(notes.size).toBe(1);
    expect(notes.docs[0].data()).toMatchObject({ refId: e.eventId, refKind: "event" });
    expect(notes.docs[0].data().title).toContain("replied to your comment");
    expect(notes.docs[0].id).toBe(`comment_reply:${curatorReply.commentId}`);

    // A curator answering their OWN comment notifies nobody.
    const curatorRoot = await say(e.eventId, "reminder", e.owner.user);
    await say(e.eventId, "again", e.owner.user, curatorRoot.commentId);
    expect((await adb.collection(`users/${e.owner.uid}/notifications`)
      .where("kind", "==", "comment_reply").get()).size).toBe(0);

    // Nor does a curator answering the ARTIST: only a FAN's comment earns a
    // reply notification (spec 3.2), profile-side shop talk never does.
    const artistRoot = await say(e.eventId, "load-in at 6?", e.musician.owner.user);
    await say(e.eventId, "make it 6:30", e.owner.user, artistRoot.commentId);
    expect((await adb.collection(`users/${e.musician.owner.uid}/notifications`)
      .where("kind", "==", "comment_reply").get()).size).toBe(0);

    await expect(say(e.eventId, "third level", fan.user, curatorReply.commentId))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    await expect(say(e.eventId, "nowhere", fan.user, "nosuchcomment"))
      .rejects.toMatchObject({ code: "functions/not-found" });

    // A parent id is only ever looked up under ITS OWN event, so one borrowed
    // from another show is simply absent.
    const elsewhere = await makeDraftEvent("cm3x");
    await addTiersAndPublish(elsewhere.profileId, elsewhere.eventId, elsewhere.owner.user, FREE_TIER);
    await expect(say(elsewhere.eventId, "wrong show", fan.user, root.commentId))
      .rejects.toMatchObject({ code: "functions/not-found" });

    // A hidden parent counts as gone: a reply must not drag a moderated
    // comment back into the thread.
    await callFn("hideComment", { eventId: e.eventId, commentId: root.commentId }, e.owner.user);
    await expect(say(e.eventId, "reviving this", other.user, root.commentId))
      .rejects.toMatchObject({ code: "functions/not-found", message: "That comment is gone." });
  });

  it("lets curator and artist members hide, only an admin unhide, and the author delete", async () => {
    const e = await makePublishedBookingEvent("cm4");
    const fan = await signUpTestUser(`cm4f-${Date.now()}@test.com`);
    const stranger = await signUpTestUser(`cm4s-${Date.now()}@test.com`);
    const a = await say(e.eventId, "hide me", fan.user);
    const b = await say(e.eventId, "delete me", fan.user);
    expect(await count(e.eventId)).toBe(2);

    await expect(callFn("hideComment", { eventId: e.eventId, commentId: a.commentId }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    await expect(callFn("hideComment", { eventId: e.eventId, commentId: a.commentId }, fan.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });

    // commentCount is the VISIBLE count, so hiding takes one off it.
    await callFn("hideComment", { eventId: e.eventId, commentId: a.commentId }, e.owner.user);
    expect(await comment(e.eventId, a.commentId)).toMatchObject({
      hidden: true, hiddenBy: { uid: e.owner.uid, role: "curator" },
    });
    expect(await count(e.eventId)).toBe(1);
    // Idempotent: a second hide neither rewrites nor double-counts.
    await callFn("hideComment", { eventId: e.eventId, commentId: a.commentId }, e.owner.user);
    expect(await count(e.eventId)).toBe(1);

    // The artist side can hide too.
    const c = await say(e.eventId, "artist hides this", fan.user);
    await callFn("hideComment", { eventId: e.eventId, commentId: c.commentId }, e.musician.owner.user);
    expect((await comment(e.eventId, c.commentId))!.hiddenBy).toMatchObject({ role: "artist" });
    expect(await count(e.eventId)).toBe(1);

    // An admin moderates any event's comments (the Reports panel's "Hide
    // comment" runs this same callable) and the trail records them as such.
    const d = await say(e.eventId, "admin hides this", fan.user);
    const moderator = await makeAdminUser("cm4adm");
    await callFn("hideComment", { eventId: e.eventId, commentId: d.commentId }, moderator.user);
    expect((await comment(e.eventId, d.commentId))!.hiddenBy)
      .toMatchObject({ uid: moderator.uid, role: "admin" });

    // Unhiding is admin only: the curator can take a comment down but cannot
    // put one back, so their reach never overrides moderation.
    await expect(callFn("hideComment",
      { eventId: e.eventId, commentId: a.commentId, hidden: false }, e.owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    const beforeUnhide = await count(e.eventId);
    await callFn("hideComment", { eventId: e.eventId, commentId: a.commentId, hidden: false }, moderator.user);
    expect(await comment(e.eventId, a.commentId)).toMatchObject({ hidden: false, hiddenBy: null });
    expect(await count(e.eventId)).toBe(beforeUnhide + 1);

    // A hidden comment is evidence: its author cannot delete it out from
    // under the people reviewing it.
    await expect(callFn("deleteComment", { eventId: e.eventId, commentId: c.commentId }, fan.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: COMMENT_UNDER_REVIEW_MESSAGE });

    await expect(callFn("deleteComment", { eventId: e.eventId, commentId: b.commentId }, e.owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    const before = await count(e.eventId);
    await callFn("deleteComment", { eventId: e.eventId, commentId: b.commentId }, fan.user);
    expect(await comment(e.eventId, b.commentId)).toBeUndefined();
    expect(await count(e.eventId)).toBe(before - 1);
    // Deleting again is a no-op, not a crash, and never drives the count negative.
    await callFn("deleteComment", { eventId: e.eventId, commentId: b.commentId }, fan.user);
    expect(await count(e.eventId)).toBe(before - 1);
  });

  it("caps a user at COMMENT_RATE_MAX comments per window across events", async () => {
    const e1 = await makePublishedBookingEvent("cm5a");
    const e2 = await makePublishedBookingEvent("cm5b");
    const fan = await signUpTestUser(`cm5f-${Date.now()}@test.com`);
    for (let i = 0; i < 6; i += 1) await say(e1.eventId, `one ${i}`, fan.user);
    for (let i = 0; i < 4; i += 1) await say(e2.eventId, `two ${i}`, fan.user);
    await expect(say(e2.eventId, "eleventh", fan.user)).rejects.toMatchObject({
      code: "functions/resource-exhausted",
      message: "You are sending too fast. Try again in a few minutes.",
    });
    await adb.doc(`commentWindows/${fan.uid}`).set({ at: [Date.now() - 11 * 60 * 1000] }, { merge: true });
    await expect(say(e2.eventId, "back", fan.user)).resolves.toMatchObject({ role: "fan" });
  });
});

describe("setGoing and setPostHeart", () => {
  it("toggles idempotently, keeps the counters right, and honours its own cap", async () => {
    const e = await makePublishedBookingEvent("cm6");
    const fan = await signUpTestUser(`cm6f-${Date.now()}@test.com`);
    const other = await signUpTestUser(`cm6o-${Date.now()}@test.com`);

    expect(await callFn("setGoing", { eventId: e.eventId, going: true }, fan.user))
      .toMatchObject({ going: true, goingCount: 1 });
    // Setting the same value again does not double-count.
    expect(await callFn("setGoing", { eventId: e.eventId, going: true }, fan.user))
      .toMatchObject({ going: true, goingCount: 1 });
    expect(await callFn("setGoing", { eventId: e.eventId, going: true }, other.user))
      .toMatchObject({ going: true, goingCount: 2 });
    expect(await callFn("setGoing", { eventId: e.eventId, going: false }, fan.user))
      .toMatchObject({ going: false, goingCount: 1 });
    // Un-going twice never drives the count below zero.
    expect(await callFn("setGoing", { eventId: e.eventId, going: false }, fan.user))
      .toMatchObject({ going: false, goingCount: 1 });
    expect((await event(e.eventId)).goingCount).toBe(1);

    const { postId } = await callFn<Record<string, unknown>, { postId: string }>(
      "createShowPost",
      { eventId: e.eventId, musicianProfileId: e.musicianProfileId, text: "see you Friday" },
      e.musician.owner.user);
    expect(await callFn("setPostHeart", { eventId: e.eventId, postId, hearted: true }, fan.user))
      .toMatchObject({ hearted: true, heartCount: 1 });
    expect(await callFn("setPostHeart", { eventId: e.eventId, postId, hearted: true }, fan.user))
      .toMatchObject({ hearted: true, heartCount: 1 });
    expect(await callFn("setPostHeart", { eventId: e.eventId, postId, hearted: false }, fan.user))
      .toMatchObject({ hearted: false, heartCount: 0 });
    expect((await post(e.eventId, postId)).heartCount).toBe(0);

    await expect(callFn("setGoing", { eventId: e.eventId, going: true }))
      .rejects.toMatchObject({ code: "functions/unauthenticated" });
    await expect(callFn("setPostHeart", { eventId: e.eventId, postId: "nope", hearted: true }, fan.user))
      .rejects.toMatchObject({ code: "functions/not-found" });

    // Only the four real TRANSITIONS above spent reaction budget; the no-op
    // taps wrote nothing, so they cost nothing.
    expect((await rateWindow(fan.uid))?.reactions?.length).toBe(4);

    // Reactions share one per-user cap over the same window as comments, on
    // the same doc but its own array.
    const now = Date.now();
    await adb.doc(`commentWindows/${fan.uid}`)
      .set({ reactions: Array.from({ length: REACTION_RATE_MAX }, () => now) }, { merge: true });
    await expect(callFn("setGoing", { eventId: e.eventId, going: true }, fan.user)).rejects.toMatchObject({
      code: "functions/resource-exhausted",
      message: "You are sending too fast. Try again in a few minutes.",
    });
    // The comment window on the same doc is untouched by the reaction cap.
    await expect(say(e.eventId, "still commenting", fan.user)).resolves.toMatchObject({ role: "fan" });
    await adb.doc(`commentWindows/${fan.uid}`).set({ reactions: [] }, { merge: true });

    // A removed post keeps its hearts but takes no new ones.
    await callFn("removeShowPost", { eventId: e.eventId, postId }, e.musician.owner.user);
    await expect(callFn("setPostHeart", { eventId: e.eventId, postId, hearted: true }, fan.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    // Reactions close with the event, exactly as comments do.
    await adb.doc(`events/${e.eventId}`).update({ status: "cancelled" });
    await expect(callFn("setGoing", { eventId: e.eventId, going: true }, fan.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "Comments are closed." });
  });
});
