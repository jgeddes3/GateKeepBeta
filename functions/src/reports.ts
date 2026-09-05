import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, type Transaction } from "firebase-admin/firestore";
import {
  validateReportReason, isValidDocId, conversationPairId,
  REPORT_DUPLICATE_MESSAGE, MESSAGE_RATE_MESSAGE, REPORT_RATE_MAX, REPORT_RATE_WINDOW_MS,
  type ConversationDoc, type ConversationStateDoc, type EventCommentDoc,
  type ProfileDoc, type ReportDoc, type ReportWindowDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import { requireAdmin, writeAudit } from "./review.js";
import {
  CONVERSATION_DENIED_MESSAGE, requireConversationParticipant, writeConversationMirrors,
} from "./messaging.js";

// SP12 (spec sections 3.3 and 5). Abuse reports for both surfaces land in one
// admin-read collection, `reports`.
//
// The report id is DETERMINISTIC per reporter per target
// (`conv:{conversationId}:{uid}` and `comment:{eventId}:{commentId}:{uid}`),
// which is what enforces "one open report per reporter per target" without a
// query and without an index: the doc either already exists and is open, in
// which case the second attempt is refused, or it does not, in which case the
// target's openReports counter moves exactly once. A resolved report can be
// opened again on the same id, so a repeat offender is reportable twice, and
// the counter moves again with it.
//
// openReports is the ONLY thing a report writes onto its target, and it is a
// plain count: firestore.rules opens the admin read disjunct on
// `openReports > 0`, and the reporter's identity never leaves this collection.
// That matters most for a conversation, where the counter also lands on both
// participants' mirrors: each side can see that the thread has been reported,
// and neither can see by whom.

// A conversation report has no single offender (two profiles, many members
// each), so `offenderUid` is null there and spec 3.3 sends the operator to
// User lookup; a comment has exactly one author, and the panel flags them
// straight from the row.
type NewReport = Omit<ReportDoc,
  "status" | "resolvedBy" | "resolvedAt" | "reopenCount" | "lastResolvedBy" | "lastResolvedAt" | "createdAt">;

// The doc an open (or re-open) writes. A reopen does NOT erase the resolution
// it followed: the id is deterministic, so this row is the whole history of
// one reporter against one target, and an admin who cleared it deserves to
// see that it came back rather than find their own resolution overwritten.
// createdAt is refreshed because the panel sorts open reports by it.
function openedReport(prior: ReportDoc | null, doc: NewReport, now: number): ReportDoc {
  return {
    ...doc,
    status: "open", resolvedBy: null, resolvedAt: null,
    reopenCount: prior ? (prior.reopenCount ?? 0) + 1 : 0,
    // A prior can only be a RESOLVED one here (an open one is refused above),
    // so resolvedBy is the resolution being archived; the lastResolved
    // fallback keeps a chain of reopens from losing the earliest one.
    lastResolvedBy: prior?.resolvedBy ?? prior?.lastResolvedBy ?? null,
    lastResolvedAt: prior?.resolvedAt ?? prior?.lastResolvedAt ?? null,
    createdAt: now,
  };
}

// The rolling report cap, read and trimmed INSIDE the report transaction:
// 10 per 10 minutes per user, across both surfaces and every target. Filing a
// report is not a free action, because an open report on a comment blocks its
// author from deleting it, so an uncapped reporter could freeze every
// author's delete one call at a time. Any refusal aborts the whole
// transaction, so a refused report never spends budget.
//
// Returns the write half, for the same reads-before-writes reason as
// stageConversationReports.
async function stageReportWindow(tx: Transaction, uid: string, now: number): Promise<() => void> {
  const windowRef = getFirestore().doc(`reportWindows/${uid}`);
  const prior = (await tx.get(windowRef)).data() as ReportWindowDoc | undefined;
  const recent = (prior?.at ?? []).filter((t) => now - t < REPORT_RATE_WINDOW_MS);
  if (recent.length >= REPORT_RATE_MAX) throw new HttpsError("resource-exhausted", MESSAGE_RATE_MESSAGE);
  recent.push(now);
  // slice keeps the array bounded at REPORT_RATE_MAX entries forever, so a
  // busy reporter never grows an unbounded field.
  return () => tx.set(windowRef, { at: recent.slice(-REPORT_RATE_MAX) } satisfies ReportWindowDoc);
}

// Report ids carry colons, so they are not isValidDocId shaped. They are
// server-minted and only ever handed back to the caller, so the check on the
// way into resolveReport is a length and slash check: a slash would let a
// crafted id address some other collection through db.doc().
function requireReportId(reportId: unknown): string {
  if (typeof reportId !== "string" || reportId.length === 0 || reportId.length > 1500
    || reportId.includes("/")) {
    throw new HttpsError("invalid-argument", "A report id is required.");
  }
  return reportId;
}

// Display names for both sides of a pair, plus the ids whose profile doc is
// GONE, read BEFORE the transaction (a non-transactional read of two public
// docs, neither of which the transaction writes).
//
// Names, because writeConversationMirrors refuses to create a nameless
// mirror, so a counter bump has to arrive holding them in case a side's
// mirror is somehow missing. `gone`, because a participant profile can be
// deleted by its own owner (deleteProfile, on a draft or retroactively
// rejected profile), which takes the profile doc AND that profile's
// conversations mirror subcollection with it. Such a side has no name and no
// row, and demanding one made every report on the surviving side fail with
// `internal`: the abusive party could delete its profile and leave the other
// side unable to file, while an already-filed report could not be resolved,
// so it sat in the admin panel forever and its openReports > 0 kept the
// thread admin-readable. Skipping the vanished side's mirror is the fix.
interface PairProfiles { names: Record<string, string | undefined>; gone: string[] }

async function pairProfiles(conversationId: string): Promise<PairProfiles> {
  const db = getFirestore();
  const ids = conversationId.split("__").filter((id) => isValidDocId(id));
  const snaps = await Promise.all(ids.map((id) => db.doc(`profiles/${id}`).get()));
  const names: Record<string, string | undefined> = {};
  const gone: string[] = [];
  ids.forEach((id, i) => {
    names[id] = (snaps[i].data() as ProfileDoc | undefined)?.name;
    if (!snaps[i].exists) gone.push(id);
  });
  return { names, gone };
}

// The read half of a conversation counter change, inside the caller's
// transaction: reads the conversation, its private block state, and both
// mirrors, and hands back the write half as a closure. Split in two because
// Firestore requires every read in a transaction to precede every write, and
// the callers below have their own report-doc read and write to interleave.
//
// Null means there is no conversation to move. reportConversation treats that
// as a refusal; resolveReport tolerates it, because a report must still be
// resolvable after its target has gone.
async function stageConversationReports(
  tx: Transaction, conversationId: string, profiles: PairProfiles,
): Promise<((delta: 1 | -1) => void) | null> {
  const db = getFirestore();
  const convRef = db.doc(`conversations/${conversationId}`);
  const stateRef = convRef.collection("private").doc("state");
  const [snap, stateSnap] = await Promise.all([tx.get(convRef), tx.get(stateRef)]);
  if (!snap.exists) return null;
  const conv = snap.data() as ConversationDoc;
  const pairId = conversationPairId(conv.musicianProfileId, conv.curatorProfileId);
  const sides = [conv.musicianProfileId, conv.curatorProfileId];
  const mirrorSnaps = await Promise.all(
    sides.map((id) => tx.get(db.doc(`profiles/${id}/conversations/${pairId}`))));
  const mirrorExists: Record<string, boolean> = {};
  sides.forEach((id, i) => { mirrorExists[id] = mirrorSnaps[i].exists; });
  // The block list comes from the server-only state doc and goes back out
  // through writeConversationMirrors, which only ever tells a side about its
  // OWN block. A report must not become the one place a blocked profile can
  // read that it was blocked.
  const blockedBy = (stateSnap.data() as ConversationStateDoc | undefined)?.blockedBy ?? [];

  return (delta) => {
    const openReports = Math.max(0, (conv.openReports ?? 0) + delta);
    // updatedAt deliberately does NOT move: it is on both mirrors, and a
    // touched timestamp on the other side's row is a signal that something
    // just happened to this thread. The count is all either side gets.
    const next: ConversationDoc = { ...conv, openReports };
    tx.update(convRef, { openReports });
    // A deleted participant's mirror is skipped, never conjured back: the
    // count on the shared doc still moves, so the report is filable and the
    // resolve still clears the panel row and drops openReports back to zero.
    writeConversationMirrors(tx, next, blockedBy, profiles.names,
      { mirrorExists, skipProfileIds: profiles.gone });
  };
}

export const reportConversation = onCall<{ profileId: string; conversationId: string; reason: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId, conversationId } = req.data ?? {};
    if (!isValidDocId(profileId) || !isValidDocId(conversationId)) {
      throw new HttpsError("invalid-argument", "A profile and a conversation are required.");
    }
    const check = validateReportReason(req.data?.reason);
    if (!check.ok) throw new HttpsError("invalid-argument", check.reason);
    const reason = (req.data.reason as string).trim();

    // Any MEMBER of a participant profile may report (spec 3.1's posture: the
    // whole profile shares the thread, so the whole profile can flag it).
    // Authorized off the pair id before any read, and every refusal is the
    // same sentence, so a stranger probing a constructed pairId learns
    // nothing about who talks to whom.
    await requireConversationParticipant(profileId, conversationId, uid, "member");

    const profiles = await pairProfiles(conversationId);
    const db = getFirestore();
    const reportId = `conv:${conversationId}:${uid}`;
    const reportRef = db.doc(`reports/${reportId}`);
    const now = Date.now();
    const doc: NewReport = {
      kind: "conversation", targetPath: conversationId,
      reporterUid: uid, reporterProfileId: profileId, offenderUid: null, reason,
    };
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(reportRef);
      const prior = existing.exists ? (existing.data() as ReportDoc) : null;
      if (prior?.status === "open") throw new HttpsError("already-exists", REPORT_DUPLICATE_MESSAGE);
      const spend = await stageReportWindow(tx, uid, now);
      const apply = await stageConversationReports(tx, conversationId, profiles);
      // A conversation that does not exist answers with the same refusal as a
      // missing membership: no not-found anywhere on this path either.
      if (!apply) throw new HttpsError("permission-denied", CONVERSATION_DENIED_MESSAGE);
      tx.set(reportRef, openedReport(prior, doc, now));
      apply(1);
      spend();
    });
    return { reportId };
  });

export const reportComment = onCall<{ eventId: string; commentId: string; reason: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { eventId, commentId } = req.data ?? {};
    if (!isValidDocId(eventId) || !isValidDocId(commentId)) {
      throw new HttpsError("invalid-argument", "An event and a comment are required.");
    }
    const check = validateReportReason(req.data?.reason);
    if (!check.ok) throw new HttpsError("invalid-argument", check.reason);
    const reason = (req.data.reason as string).trim();

    // Any signed-in user with a verified email may report a comment
    // (spec 3.2): a fan reading the public page is exactly who notices abuse,
    // and there is no profile to prove membership of.
    const db = getFirestore();
    const targetPath = `events/${eventId}/comments/${commentId}`;
    const commentRef = db.doc(targetPath);
    const reportId = `comment:${eventId}:${commentId}:${uid}`;
    const reportRef = db.doc(`reports/${reportId}`);
    const now = Date.now();
    await db.runTransaction(async (tx) => {
      const [existing, commentSnap] = await Promise.all([tx.get(reportRef), tx.get(commentRef)]);
      if (!commentSnap.exists) throw new HttpsError("not-found", "That comment is gone.");
      const comment = commentSnap.data() as EventCommentDoc;
      const prior = existing.exists ? (existing.data() as ReportDoc) : null;
      if (prior?.status === "open") throw new HttpsError("already-exists", REPORT_DUPLICATE_MESSAGE);
      const spend = await stageReportWindow(tx, uid, now);
      const doc: NewReport = {
        kind: "comment", targetPath, reporterUid: uid, reporterProfileId: null,
        offenderUid: comment.authorUid, reason,
      };
      tx.set(reportRef, openedReport(prior, doc, now));
      spend();
      // Read and rewritten rather than FieldValue.increment because the same
      // transaction already holds the doc: one source for the number, and the
      // decrement in resolveReport can clamp at zero the same way.
      tx.update(commentRef, { openReports: (comment.openReports ?? 0) + 1 });
    });
    return { reportId };
  });

export const resolveReport = onCall<{ reportId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAdmin(req);
  const reportId = requireReportId(req.data?.reportId);
  const db = getFirestore();
  const reportRef = db.doc(`reports/${reportId}`);
  // One read outside the transaction, only to learn which target shape this
  // is: a conversation resolve needs both profile names in hand before the
  // transaction opens (mirrors again), and needs to know which of the two
  // profiles has since been deleted, so the resolve skips that side's mirror
  // instead of failing on it. The transaction re-reads the report and decides
  // on that copy, so a concurrent resolve still cannot double-count.
  const pre = await reportRef.get();
  if (!pre.exists) throw new HttpsError("not-found", "Report not found.");
  const preReport = pre.data() as ReportDoc;
  const profiles: PairProfiles = preReport.kind === "conversation"
    ? await pairProfiles(preReport.targetPath) : { names: {}, gone: [] };

  const now = Date.now();
  const resolved = await db.runTransaction(async (tx) => {
    const snap = await tx.get(reportRef);
    if (!snap.exists) throw new HttpsError("not-found", "Report not found.");
    const report = snap.data() as ReportDoc;
    // Idempotent: the counter moved once, on the first resolve. False here
    // also keeps the audit log honest, one row per real resolution.
    if (report.status === "resolved") return null;
    if (report.kind === "conversation") {
      const apply = await stageConversationReports(tx, report.targetPath, profiles);
      tx.update(reportRef, { status: "resolved", resolvedBy: uid, resolvedAt: now });
      // A vanished conversation is not an error: the row still has to leave
      // the panel.
      if (apply) apply(-1);
      return report;
    }
    // A comment target is a stored path. It is server-minted, but a doc path
    // with an odd number of segments would make db.doc() throw inside the
    // transaction, so a malformed one is treated as gone.
    const segments = report.targetPath.split("/");
    const target = segments.length % 2 === 0 ? await tx.get(db.doc(report.targetPath)) : null;
    tx.update(reportRef, { status: "resolved", resolvedBy: uid, resolvedAt: now });
    if (target?.exists) {
      const current = (target.data() as { openReports?: number }).openReports ?? 0;
      tx.update(target.ref, { openReports: Math.max(0, current - 1) });
    }
    return report;
  });
  // Post-commit, like every other requireAdmin callable: moderation actions
  // leave a trail naming the operator, and the report id alone would not say
  // what was cleared once the report row itself is filtered out of the panel.
  if (resolved) {
    await writeAudit({
      actorUid: uid, action: "report_resolved", targetId: reportId,
      detail: `${resolved.kind} ${resolved.targetPath}`,
    });
  }
  return { ok: true as const };
});
