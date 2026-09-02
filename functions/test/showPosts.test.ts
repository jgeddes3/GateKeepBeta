import { describe, it, expect, vi } from "vitest";
import { callFn, makeAdminUser } from "./helpers";
import { adb, makeFan, makePublishedBookingEvent } from "./discoverFixtures";
import {
  SHOW_POST_LIMIT_MESSAGE, SHOW_POST_RATE_MESSAGE, SHOW_POST_EVENT_CLOSED_MESSAGE, type ShowPostDoc, type NotificationDoc,
} from "@gatekeep/shared";
vi.setConfig({ testTimeout: 40_000 });

describe("createShowPost", () => {
  it("a lineup member posts; followers get one show_post notification", async () => {
    const { musician, eventId } = await makePublishedBookingEvent("sp1");
    const fan = await makeFan("sp1f");
    await callFn("followTarget", { targetId: musician.profileId, targetType: "musician" }, fan.user);
    const { postId } = await callFn<Record<string, unknown>, { postId: string }>("createShowPost",
      { eventId, musicianProfileId: musician.profileId, text: "  Doors at 8, we go on at 9.  " }, musician.owner.user);
    const post = (await adb.doc(`events/${eventId}/posts/${postId}`).get()).data() as ShowPostDoc;
    expect(post).toMatchObject({ eventId, musicianProfileId: musician.profileId, authorUid: musician.owner.uid, status: "live", text: "Doors at 8, we go on at 9." });
    const n = (await adb.collection(`users/${fan.uid}/notifications`).get()).docs.map((d) => ({ id: d.id, ...(d.data() as NotificationDoc) }));
    const posts = n.filter((x) => x.kind === "show_post");
    expect(posts).toHaveLength(1); expect(posts[0].id).toBe(`post:${postId}`); expect(posts[0].refId).toBe(eventId);
  });
  it("refuses non-members, non-lineup profiles, empty and overlong text", async () => {
    const { curator, musician, eventId } = await makePublishedBookingEvent("sp2");
    const stranger = await makeFan("sp2s");
    await expect(callFn("createShowPost", { eventId, musicianProfileId: musician.profileId, text: "hi" }, stranger.user)).rejects.toMatchObject({ code: "functions/permission-denied" });
    await expect(callFn("createShowPost", { eventId, musicianProfileId: curator.profileId, text: "hi" }, curator.owner.user)).rejects.toMatchObject({ code: "functions/permission-denied" });
    await expect(callFn("createShowPost", { eventId, musicianProfileId: musician.profileId, text: "   " }, musician.owner.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("createShowPost", { eventId, musicianProfileId: musician.profileId, text: "x".repeat(281) }, musician.owner.user)).rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
  it("rate-limits, caps at three live posts, and closes after the show ends", async () => {
    const { musician, eventId } = await makePublishedBookingEvent("sp3");
    const post = (text: string) => callFn<Record<string, unknown>, { postId: string }>("createShowPost", { eventId, musicianProfileId: musician.profileId, text }, musician.owner.user);
    const first = await post("one");
    await expect(post("two")).rejects.toMatchObject({ code: "functions/failed-precondition", message: SHOW_POST_RATE_MESSAGE });
    // Age the first post past the interval, then fill the cap.
    await adb.doc(`events/${eventId}/posts/${first.postId}`).update({ createdAt: Date.now() - 11 * 60 * 1000 });
    const second = await post("two");
    await adb.doc(`events/${eventId}/posts/${second.postId}`).update({ createdAt: Date.now() - 11 * 60 * 1000 });
    await post("three");
    await adb.collection(`events/${eventId}/posts`).get().then((s) => Promise.all(s.docs.map((d) => d.ref.update({ createdAt: Date.now() - 11 * 60 * 1000 }))));
    await expect(post("four")).rejects.toMatchObject({ code: "functions/failed-precondition", message: SHOW_POST_LIMIT_MESSAGE });
    // Removing one live post frees a slot.
    await callFn("removeShowPost", { eventId, postId: first.postId }, musician.owner.user);
    await post("four");
    await adb.doc(`events/${eventId}`).update({ endsAt: Date.now() - 1000 });
    await expect(post("five")).rejects.toMatchObject({ code: "functions/failed-precondition", message: SHOW_POST_EVENT_CLOSED_MESSAGE });
  });
});

describe("removeShowPost", () => {
  it("author removes as author; admin removes as admin with an audit row; strangers cannot", async () => {
    const { musician, eventId } = await makePublishedBookingEvent("sp4");
    const mk = () => callFn<Record<string, unknown>, { postId: string }>("createShowPost", { eventId, musicianProfileId: musician.profileId, text: "hello" }, musician.owner.user);
    const a = await mk();
    await adb.doc(`events/${eventId}/posts/${a.postId}`).update({ createdAt: Date.now() - 11 * 60 * 1000 });
    const b = await mk();
    const stranger = await makeFan("sp4s");
    await expect(callFn("removeShowPost", { eventId, postId: a.postId }, stranger.user)).rejects.toMatchObject({ code: "functions/permission-denied" });
    await callFn("removeShowPost", { eventId, postId: a.postId }, musician.owner.user);
    expect((await adb.doc(`events/${eventId}/posts/${a.postId}`).get()).data()).toMatchObject({ status: "removed", removedBy: "author" });
    const admin = await makeAdminUser("sp4a");
    await callFn("removeShowPost", { eventId, postId: b.postId }, admin.user);
    expect((await adb.doc(`events/${eventId}/posts/${b.postId}`).get()).data()).toMatchObject({ status: "removed", removedBy: "admin" });
    const audit = await adb.collection("auditLogs").where("action", "==", "show_post_removed").where("targetId", "==", `${eventId}/${b.postId}`).get();
    expect(audit.size).toBe(1);
    await callFn("removeShowPost", { eventId, postId: b.postId }, admin.user); // idempotent
  });
});
