import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser, makeAdminUser } from "./helpers";
import { adb, makePublishedBookingEvent } from "./discoverFixtures";
import { makeMessagingPair, sendAs, conversation, mirror } from "./messagingFixtures";
import {
  REPORT_DUPLICATE_MESSAGE, MESSAGE_RATE_MESSAGE, REPORT_RATE_MAX,
  type AuditLogDoc, type EventCommentDoc, type ReportDoc,
} from "@gatekeep/shared";
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

// Every requireAdmin callable leaves a trail; resolveReport is no exception.
async function auditRows(reportId: string): Promise<AuditLogDoc[]> {
  const snap = await adb.collection("auditLogs").where("targetId", "==", reportId).get();
  return snap.docs.map((d) => d.data() as AuditLogDoc);
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
      reopenCount: 0, lastResolvedBy: null, lastResolvedAt: null,
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
    const cleared = (await report(res.reportId))!;
    expect(cleared).toMatchObject({ status: "resolved", resolvedBy: admin.uid });
    expect(cleared.resolvedAt).toBeTypeOf("number");
    expect(await openReportsEverywhere(p)).toEqual([1, 1, 1]);
    expect(await auditRows(res.reportId)).toMatchObject([
      { actorUid: admin.uid, action: "report_resolved", detail: `conversation ${p.pairId}` },
    ]);
    // Resolving twice never drives openReports below zero, and never writes a
    // second audit row for one resolution.
    await callFn("resolveReport", { reportId: res.reportId }, admin.user);
    expect(await openReportsEverywhere(p)).toEqual([1, 1, 1]);
    expect(await auditRows(res.reportId)).toHaveLength(1);
    await callFn("resolveReport", { reportId: second.reportId }, admin.user);
    expect(await openReportsEverywhere(p)).toEqual([0, 0, 0]);

    // A resolved report is not a life sentence: the same reporter may open it
    // again, on the same deterministic id, and the counter moves again. The
    // resolution it followed is kept, not overwritten.
    await callFn("reportConversation",
      { profileId: p.curatorProfileId, conversationId: p.pairId, reason: "it started again" },
      p.curator.owner.user);
    const reopened = (await report(res.reportId))!;
    expect(reopened).toMatchObject({
      status: "open", reason: "it started again", resolvedBy: null, resolvedAt: null,
      reopenCount: 1, lastResolvedBy: admin.uid, lastResolvedAt: cleared.resolvedAt,
    });
    // The panel sorts open reports by createdAt, so a reopen is new work.
    expect(reopened.createdAt).toBeGreaterThan(cleared.createdAt);
    expect(await openReportsEverywhere(p)).toEqual([1, 1, 1]);
  });

  it("refuses a member of a real pair whose conversation was never started, and resolves a report whose conversation is gone", async () => {
    // The pair id is derivable from two PUBLIC profile ids, so a member can
    // name a thread that does not exist. That answers with the same sentence
    // as every other refusal here rather than a not-found, which would make a
    // constructed pair id an existence oracle.
    const quiet = await makeMessagingPair("rc3");
    await expect(callFn("reportConversation",
      { profileId: quiet.curatorProfileId, conversationId: quiet.pairId, reason: "nothing here" },
      quiet.curator.owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    expect(await report(`conv:${quiet.pairId}:${quiet.curator.owner.uid}`)).toBeUndefined();

    // And the other end of the same story: a report whose conversation has
    // since gone still resolves, because the row has to leave the panel.
    const p = await makeMessagingPair("rc4");
    await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "hello");
    const res = await callFn<Record<string, unknown>, { reportId: string }>("reportConversation",
      { profileId: p.curatorProfileId, conversationId: p.pairId, reason: "abusive" },
      p.curator.owner.user);
    await adb.doc(`conversations/${p.pairId}`).delete();
    const admin = await makeAdminUser("rc4a");
    await callFn("resolveReport", { reportId: res.reportId }, admin.user);
    expect(await report(res.reportId)).toMatchObject({ status: "resolved", resolvedBy: admin.uid });
    expect(await auditRows(res.reportId)).toHaveLength(1);
  });

  // deleteProfile recursively deletes the profile doc together with its
  // subcollections, the `conversations` mirror rows among them. Reproduced
  // through the admin SDK because the callable itself only runs on a
  // draft/rejected profile, and a profile that has been messaging is
  // approved until an admin retroactively rejects it.
  async function deleteProfileAsOwnerWould(profileId: string) {
    const mirrors = await adb.collection(`profiles/${profileId}/conversations`).get();
    await Promise.all(mirrors.docs.map((d) => d.ref.delete()));
    await adb.doc(`profiles/${profileId}`).delete();
  }

  it("still files a report when the other participant's profile has been deleted", async () => {
    // The abuse case this exists for: the offending profile is deleted by its
    // own owner, and the side that was on the receiving end still has to be
    // able to flag the thread. A vanished profile has no name and no mirror
    // row, and insisting on one used to fail the whole call with `internal`.
    const p = await makeMessagingPair("rc5");
    await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "hello");
    await deleteProfileAsOwnerWould(p.musicianProfileId);

    const res = await callFn<Record<string, unknown>, { reportId: string }>("reportConversation",
      { profileId: p.curatorProfileId, conversationId: p.pairId, reason: "abusive" },
      p.curator.owner.user);
    expect(await report(res.reportId)).toMatchObject({
      kind: "conversation", targetPath: p.pairId, status: "open", reason: "abusive",
    });
    // The shared doc and the SURVIVING mirror both carry the count; the
    // deleted side gains no ghost row.
    expect((await conversation(p.pairId))!.openReports).toBe(1);
    expect((await mirror(p.curatorProfileId, p.pairId))!.openReports).toBe(1);
    expect(await mirror(p.musicianProfileId, p.pairId)).toBeUndefined();
    // The surviving row keeps the name it already had rather than being
    // merged into a blank one.
    expect((await mirror(p.curatorProfileId, p.pairId))!.otherProfileName).toBe("The Act");
  });

  it("still resolves a conversation report when a participant's profile has been deleted", async () => {
    // The other half of the same story, and the worse one: a report that
    // cannot be resolved never leaves the admin panel, and its openReports > 0
    // keeps the thread admin-readable forever.
    const p = await makeMessagingPair("rc6");
    await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "hello");
    const res = await callFn<Record<string, unknown>, { reportId: string }>("reportConversation",
      { profileId: p.curatorProfileId, conversationId: p.pairId, reason: "abusive" },
      p.curator.owner.user);
    expect((await conversation(p.pairId))!.openReports).toBe(1);
    await deleteProfileAsOwnerWould(p.musicianProfileId);

    const admin = await makeAdminUser("rc6a");
    await callFn("resolveReport", { reportId: res.reportId }, admin.user);
    expect(await report(res.reportId)).toMatchObject({ status: "resolved", resolvedBy: admin.uid });
    expect((await conversation(p.pairId))!.openReports).toBe(0);
    expect((await mirror(p.curatorProfileId, p.pairId))!.openReports).toBe(0);
    expect(await mirror(p.musicianProfileId, p.pairId)).toBeUndefined();
    expect(await auditRows(res.reportId)).toMatchObject([
      { actorUid: admin.uid, action: "report_resolved", detail: `conversation ${p.pairId}` },
    ]);
  });

  it("still resolves a conversation report when BOTH participant profiles have been deleted", async () => {
    // The sharpest form of the same defect. With one side gone the surviving
    // mirror still carries a name, so the old code merely resurrected a row
    // under the deleted profile; with both gone neither side has a name or a
    // mirror, the write refused outright, and resolveReport failed with
    // `internal`. The report then never left the admin panel, and its
    // openReports > 0 kept the thread admin-readable for good.
    const p = await makeMessagingPair("rc7");
    await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "hello");
    const res = await callFn<Record<string, unknown>, { reportId: string }>("reportConversation",
      { profileId: p.curatorProfileId, conversationId: p.pairId, reason: "abusive" },
      p.curator.owner.user);
    await deleteProfileAsOwnerWould(p.musicianProfileId);
    await deleteProfileAsOwnerWould(p.curatorProfileId);

    const admin = await makeAdminUser("rc7a");
    await callFn("resolveReport", { reportId: res.reportId }, admin.user);
    expect(await report(res.reportId)).toMatchObject({ status: "resolved", resolvedBy: admin.uid });
    expect((await conversation(p.pairId))!.openReports).toBe(0);
    expect(await mirror(p.musicianProfileId, p.pairId)).toBeUndefined();
    expect(await mirror(p.curatorProfileId, p.pairId)).toBeUndefined();
    expect(await auditRows(res.reportId)).toHaveLength(1);
  });

  it("caps one user at REPORT_RATE_MAX reports per window, across targets and across both surfaces", async () => {
    const e = await makePublishedBookingEvent("rl1");
    const p = await makeMessagingPair("rl1p");
    await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "hello");
    const fan = await signUpTestUser(`rl1f-${Date.now()}@test.com`);
    const reporter = p.curator.owner;

    const commentIds: string[] = [];
    for (let i = 0; i < REPORT_RATE_MAX; i++) {
      const { commentId } = await callFn<Record<string, unknown>, { commentId: string }>(
        "postComment", { eventId: e.eventId, text: `noise ${i}` }, fan.user);
      commentIds.push(commentId);
    }
    // Ten DIFFERENT targets: the window is per user, not per target, so a
    // reporter cannot spend it ten times over by moving to the next comment.
    for (const commentId of commentIds) {
      await callFn("reportComment", { eventId: e.eventId, commentId, reason: "spam" }, reporter.user);
    }
    // The eleventh is a conversation, on a thread this reporter really is in:
    // one window covers both surfaces, so the refusal is the rate sentence.
    await expect(callFn("reportConversation",
      { profileId: p.curatorProfileId, conversationId: p.pairId, reason: "abusive" }, reporter.user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted", message: MESSAGE_RATE_MESSAGE });
    // A refused report spends nothing and leaves nothing behind.
    expect(await report(`conv:${p.pairId}:${reporter.uid}`)).toBeUndefined();
    expect(await openReportsEverywhere(p)).toEqual([0, 0, 0]);
    // Another user is unaffected: the window is per reporter.
    const other = await signUpTestUser(`rl1o-${Date.now()}@test.com`);
    await callFn("reportComment",
      { eventId: e.eventId, commentId: commentIds[0], reason: "spam" }, other.user);
    const target = (await adb.doc(`events/${e.eventId}/comments/${commentIds[0]}`).get())
      .data() as EventCommentDoc;
    expect(target.openReports).toBe(2);
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
