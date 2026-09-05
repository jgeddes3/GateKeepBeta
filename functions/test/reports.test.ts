import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser, makeAdminUser } from "./helpers";
import { adb, makePublishedBookingEvent } from "./discoverFixtures";
import { makeMessagingPair, sendAs, conversation, mirror } from "./messagingFixtures";
import { REPORT_DUPLICATE_MESSAGE, type EventCommentDoc, type ReportDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 90_000 });

const report = async (reportId: string) =>
  (await adb.doc(`reports/${reportId}`).get()).data() as ReportDoc | undefined;

// The counter has to agree in THREE places at once: the top-level doc the
// admin panel reads and each side's own mirror row (Task 5 ruling 1), which is
// why every assertion below checks all three rather than the doc alone.
async function openReportsEverywhere(p: { pairId: string; musicianProfileId: string; curatorProfileId: string }) {
  return [
    (await conversation(p.pairId))?.openReports,
    (await mirror(p.musicianProfileId, p.pairId))?.openReports,
    (await mirror(p.curatorProfileId, p.pairId))?.openReports,
  ];
}

describe("reportConversation", () => {
  it("opens one report per reporter, bumps openReports on the doc and both mirrors, and resolving clears it", async () => {
    const p = await makeMessagingPair("rc1");
    await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "hello");

    const res = await callFn<Record<string, unknown>, { reportId: string }>("reportConversation",
      { profileId: p.curatorProfileId, conversationId: p.pairId, reason: "  abusive  " },
      p.curator.owner.user);
    expect(res.reportId).toBe(`conv:${p.pairId}:${p.curator.owner.uid}`);
    expect(await report(res.reportId)).toMatchObject({
      kind: "conversation", targetPath: p.pairId, reporterUid: p.curator.owner.uid,
      reporterProfileId: p.curatorProfileId, offenderUid: null, reason: "abusive", status: "open",
      resolvedBy: null, resolvedAt: null,
    });
    expect(await openReportsEverywhere(p)).toEqual([1, 1, 1]);

    // Same reporter, same target: a calm refusal, never a second open row and
    // never a second count. The reporter cannot read reports, so this message
    // is the only way the client knows the first one landed.
    await expect(callFn("reportConversation",
      { profileId: p.curatorProfileId, conversationId: p.pairId, reason: "still abusive" },
      p.curator.owner.user))
      .rejects.toMatchObject({ code: "functions/already-exists", message: REPORT_DUPLICATE_MESSAGE });
    expect((await report(res.reportId))!.reason).toBe("abusive");
    expect(await openReportsEverywhere(p)).toEqual([1, 1, 1]);

    // The other side reporting the same conversation is a second row.
    const second = await callFn<Record<string, unknown>, { reportId: string }>("reportConversation",
      { profileId: p.musicianProfileId, conversationId: p.pairId, reason: "them too" },
      p.musician.owner.user);
    expect(await openReportsEverywhere(p)).toEqual([2, 2, 2]);
    // Neither mirror names the reporter: a report is invisible as anything but
    // a count, on both sides.
    expect(Object.keys((await mirror(p.musicianProfileId, p.pairId))!)).not.toContain("reporterUid");

    const admin = await makeAdminUser("rc1a");
    await expect(callFn("resolveReport", { reportId: res.reportId }, p.curator.owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    await callFn("resolveReport", { reportId: res.reportId }, admin.user);
    expect(await report(res.reportId)).toMatchObject({ status: "resolved", resolvedBy: admin.uid });
    expect((await report(res.reportId))!.resolvedAt).toBeTypeOf("number");
    expect(await openReportsEverywhere(p)).toEqual([1, 1, 1]);
    // Resolving twice never drives openReports below zero.
    await callFn("resolveReport", { reportId: res.reportId }, admin.user);
    expect(await openReportsEverywhere(p)).toEqual([1, 1, 1]);
    await callFn("resolveReport", { reportId: second.reportId }, admin.user);
    expect(await openReportsEverywhere(p)).toEqual([0, 0, 0]);

    // A resolved report is not a life sentence: the same reporter may open it
    // again, on the same deterministic id, and the counter moves again.
    await callFn("reportConversation",
      { profileId: p.curatorProfileId, conversationId: p.pairId, reason: "it started again" },
      p.curator.owner.user);
    expect(await report(res.reportId)).toMatchObject({
      status: "open", reason: "it started again", resolvedBy: null, resolvedAt: null,
    });
    expect(await openReportsEverywhere(p)).toEqual([1, 1, 1]);
  });

  it("refuses a non-participant, a stranger, and a bad reason", async () => {
    const p = await makeMessagingPair("rc2");
    await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "hello");
    const stranger = await signUpTestUser(`rc2s-${Date.now()}@test.com`);
    await expect(callFn("reportConversation",
      { profileId: p.curatorProfileId, conversationId: p.pairId, reason: "nope" }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    const other = await makeMessagingPair("rc2b");
    await expect(callFn("reportConversation",
      { profileId: other.curatorProfileId, conversationId: p.pairId, reason: "nope" },
      other.curator.owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    await expect(callFn("reportConversation",
      { profileId: p.curatorProfileId, conversationId: p.pairId, reason: "nope" }))
      .rejects.toMatchObject({ code: "functions/unauthenticated" });
    for (const reason of ["", "   ", "x".repeat(301), 5, null]) {
      await expect(callFn("reportConversation",
        { profileId: p.curatorProfileId, conversationId: p.pairId, reason }, p.curator.owner.user))
        .rejects.toMatchObject({ code: "functions/invalid-argument" });
    }
    expect(await openReportsEverywhere(p)).toEqual([0, 0, 0]);
  });
});

describe("reportComment", () => {
  it("lets any signed-in user report once, records the author, bumps openReports, and resolves", async () => {
    const e = await makePublishedBookingEvent("rp1");
    const fan = await signUpTestUser(`rp1f-${Date.now()}@test.com`);
    const reporter = await signUpTestUser(`rp1r-${Date.now()}@test.com`);
    const { commentId } = await callFn<Record<string, unknown>, { commentId: string }>(
      "postComment", { eventId: e.eventId, text: "rude thing" }, fan.user);

    const res = await callFn<Record<string, unknown>, { reportId: string }>("reportComment",
      { eventId: e.eventId, commentId, reason: "harassment" }, reporter.user);
    expect(res.reportId).toBe(`comment:${e.eventId}:${commentId}:${reporter.uid}`);
    expect(await report(res.reportId)).toMatchObject({
      kind: "comment", targetPath: `events/${e.eventId}/comments/${commentId}`,
      reporterUid: reporter.uid, reporterProfileId: null, status: "open",
      // Spec 3.3: the admin panel adds an admin note on the OFFENDER through
      // flagAccount, so a comment report has to carry the author's uid.
      offenderUid: fan.uid,
    });
    const commentDoc = async () =>
      (await adb.doc(`events/${e.eventId}/comments/${commentId}`).get()).data() as EventCommentDoc;
    expect((await commentDoc()).openReports).toBe(1);

    await expect(callFn("reportComment",
      { eventId: e.eventId, commentId, reason: "harassment again" }, reporter.user))
      .rejects.toMatchObject({ code: "functions/already-exists", message: REPORT_DUPLICATE_MESSAGE });
    expect((await commentDoc()).openReports).toBe(1);

    const admin = await makeAdminUser("rp1a");
    await callFn("resolveReport", { reportId: res.reportId }, admin.user);
    expect((await commentDoc()).openReports).toBe(0);

    // A report whose comment is gone still resolves: the row must leave the
    // panel either way. Deleted through the admin SDK because deleteComment
    // itself refuses while a comment is reported (spec 5).
    const { commentId: gone } = await callFn<Record<string, unknown>, { commentId: string }>(
      "postComment", { eventId: e.eventId, text: "delete me" }, fan.user);
    const goneReport = await callFn<Record<string, unknown>, { reportId: string }>("reportComment",
      { eventId: e.eventId, commentId: gone, reason: "spam" }, reporter.user);
    await adb.doc(`events/${e.eventId}/comments/${gone}`).delete();
    await callFn("resolveReport", { reportId: goneReport.reportId }, admin.user);
    expect(await report(goneReport.reportId)).toMatchObject({ status: "resolved" });

    await expect(callFn("reportComment",
      { eventId: e.eventId, commentId: "nosuch", reason: "spam" }, reporter.user))
      .rejects.toMatchObject({ code: "functions/not-found" });
    await expect(callFn("reportComment", { eventId: e.eventId, commentId, reason: "spam" }))
      .rejects.toMatchObject({ code: "functions/unauthenticated" });
    await expect(callFn("resolveReport", { reportId: "nosuchreport" }, admin.user))
      .rejects.toMatchObject({ code: "functions/not-found" });
  });
});
