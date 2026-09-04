import { useEffect, useState } from "react";
import { View, Alert } from "react-native";
import { doc, onSnapshot, getDoc, collection, query, where, orderBy } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { formatGigDateTime, formatCents, BUDGET_STRUCTURE_LABEL } from "../gigs/GigForms";
import { formatDuration, ErrorBox, type OfferPayload } from "./BookingForms";
import { bookingHistoryLabel, depositLine } from "./BookingInbox";
import { OfferForm } from "./OfferForm";
import { CancelDialog } from "./CancelDialog";
import { GatePrompt } from "../payments/GatePrompt";
import {
  computeExpectedTotalCents, computeDepositCents, MAX_BOOKING_THREAD_ENTRIES, MAX_CANCEL_REASON_LENGTH,
  NO_SHOW_REPORT_WINDOW_DAYS, DEPOSIT_PERCENT, depositChargePreviewCents,
  type BookingRequestDoc, type BookingSide, type GigDoc,
} from "@gatekeep/shared";
import { Text, Button, Card, TextArea, StatusBadge, Callout } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// RN port of ../../../web/src/bookings/BookingThread.tsx (SP4 Task 12),
// the booking thread screen's content, mounted by
// apps/mobile/app/booking/[bookingId].tsx (the shared thread route for
// BOTH role tabs' inbox rows and notification deep-links). Behavior mirrors
// web's as-built (Task 10, incl. every review fix) exactly; only the
// rendering is RN.

type Role = "musician" | "curator" | "both" | "none" | "loading";
type Occurrence = { id: string; startsAt: number; durationMinutes: number };

// Render-safe "now", ticking on mount and every 30s afterward (Task 10
// review), a "now" frozen at mount would never grow, so e.g. the
// completed-view no-show report window could stay hidden past the moment
// it should appear, or a per-date cancel button could stay visible past a
// date's start, for as long as this screen stays open. Both reads happen
// inside a setTimeout/setInterval callback, not synchronously in the
// effect body, matching web's react-hooks/set-state-in-effect-safe shape
// (this codebase's mobile files follow the identical pattern, see e.g.
// (curator)/dashboard.tsx's render-time-reset comments for the same class
// of concern). Exported: CancelDialog.tsx imports it from here (its
// primary/originating consumer), same same-directory sibling import as web.
export function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const initial = setTimeout(tick, 0);
    const interval = setInterval(tick, 30_000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, []);
  return now;
}

// Resolves which side(s) `uid` belongs to for this booking's two profiles,
// mirrors bookings.ts's requireBookingSide (musician-first on a dual
// member) for DISPLAY purposes only; the server independently re-derives
// and enforces the real authorization on every callable. Each membership
// GET is resolved independently (own .catch -> false), not a single
// Promise.all().catch(): a permission-denied on the side you're NOT a
// member of is a legitimate, expected outcome.
//
// Exported (SP5 Task 16): PaymentStatus.tsx needs the SAME musician/curator
// side resolution to frame its payment chips, and web already exports its
// identical hook from the equivalent file for the equivalent consumer
// (apps/web/src/payments/PaymentsPanel.tsx imports useRole from
// src/bookings/BookingThread.tsx), a second hand-rolled copy of this on
// mobile would be free to drift from the server's own musician-first
// tie-break.
export function useRole(musicianProfileId: string | undefined, curatorProfileId: string | undefined, uid: string): Role {
  const [role, setRole] = useState<Role>("loading");
  useEffect(() => {
    if (!musicianProfileId || !curatorProfileId) return;
    let cancelled = false;
    const { db } = getFirebase();
    Promise.all([
      getDoc(doc(db, `profiles/${musicianProfileId}/members/${uid}`)).then((s) => s.exists()).catch(() => false),
      getDoc(doc(db, `profiles/${curatorProfileId}/members/${uid}`)).then((s) => s.exists()).catch(() => false),
    ]).then(([isMusician, isCurator]) => {
      if (cancelled) return;
      setRole(isMusician && isCurator ? "both" : isMusician ? "musician" : isCurator ? "curator" : "none");
    });
    return () => { cancelled = true; };
  }, [musicianProfileId, curatorProfileId, uid]);
  return role;
}

// The booking's initiating gig, permission-tolerant (a stale gig can leave
// every publicly-readable disjunct for a viewer only on the musician side,
// that's an expected outcome here, not a bug). Live (onSnapshot): status can
// change while the thread is open (a rival accept, a takedown), and
// durationMinutes feeds the accept-preview total below.
function useGig(gigId: string | undefined): GigDoc | null | "loading" | "unavailable" {
  const [gig, setGig] = useState<GigDoc | null | "loading" | "unavailable">("loading");
  useEffect(() => {
    if (!gigId) return;
    let cancelled = false;
    const unsub = onSnapshot(doc(getFirebase().db, "gigs", gigId),
      (s) => { if (!cancelled) setGig(s.exists() ? (s.data() as GigDoc) : "unavailable"); },
      () => { if (!cancelled) setGig("unavailable"); });
    return () => { cancelled = true; unsub(); };
  }, [gigId]);
  return gig;
}

// Every currently-linked, still-"filled" occurrence of this booking, same
// rules-provability rationale as BookingInbox.tsx's useNextOccurrence
// (status=="filled" pinned alongside bookingId). Populated for both
// single-gig and whole-run bookings; only the whole-run view renders the
// full per-date list, but the single-gig "next date" summary reuses the
// same query. Past FILLED gigs stay "filled" forever (Task 8's review), so
// this list's LAST entry is what the completed-view no-show report window
// is computed from.
//
// Exported (SP5b Task 5): PaymentStatus's true-up mount needs per-occurrence
// durationMinutes, same reason web's BookingThread exports useOccurrences
// for its PaymentsPanel.
export function useOccurrences(bookingId: string): Occurrence[] {
  const [rows, setRows] = useState<Occurrence[]>([]);
  useEffect(() => {
    const { db } = getFirebase();
    const unsub = onSnapshot(
      query(collection(db, "gigs"), where("bookingId", "==", bookingId), where("status", "==", "filled"), orderBy("startsAt", "asc")),
      (snap) => setRows(snap.docs.map((d) => {
        const data = d.data() as GigDoc;
        return { id: d.id, startsAt: data.startsAt, durationMinutes: data.durationMinutes };
      })),
      () => setRows([]));
    return () => { unsub(); };
  }, [bookingId]);
  return rows;
}

function ThreadHistory({ thread, structure }: { thread: BookingRequestDoc["thread"]; structure: BookingRequestDoc["structure"] }) {
  const t = useTokens();
  return (
    <View style={{ gap: tokens.space.sm }}>
      <Text variant="title">
        Offer history <Text variant="meta" muted>thread {thread.length}/{MAX_BOOKING_THREAD_ENTRIES}</Text>
      </Text>
      <View style={{ gap: tokens.space.sm }}>
        {thread.map((entry, i) => {
          const isCurrent = i === thread.length - 1;
          return (
            <View key={`${i}-${entry.at}`} style={{
              borderWidth: 1, borderColor: isCurrent ? t.accent : t.border, borderRadius: tokens.radius.card, padding: tokens.space.md,
              backgroundColor: t.surface, gap: tokens.space.xs,
            }}>
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: tokens.space.xs }}>
                <Text variant={isCurrent ? "label" : "body"} style={{ flexShrink: 1 }}>
                  {entry.by === "musician" ? "Musician" : "Curator"} offered {formatCents(entry.amountCents)} {BUDGET_STRUCTURE_LABEL[structure]}
                  {structure === "perSong" && entry.expectedQuantity != null ? ` × ${entry.expectedQuantity} songs` : ""}
                </Text>
                {isCurrent && <StatusBadge status="neutral" label="current offer" />}
              </View>
              {entry.note && <Text muted>{entry.note}</Text>}
              <Text variant="meta" muted>{formatGigDateTime(entry.at)}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// The booking thread screen's content, mounted by
// apps/mobile/app/booking/[bookingId].tsx, keyed by `${bookingId}-${uid}`
// there so an identity or route switch always gets a fresh instance rather
// than reusing stale per-action state under new params.
export function BookingThread({ bookingId, uid }: { bookingId: string; uid: string }) {
  const t = useTokens();
  const [booking, setBooking] = useState<BookingRequestDoc | null | "loading" | "unavailable">("loading");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCounterForm, setShowCounterForm] = useState(false);
  const [showAcceptConfirm, setShowAcceptConfirm] = useState(false);
  const [showCancelFor, setShowCancelFor] = useState<{ mode: "booking" | "occurrence"; gigId?: string; startsAt: number } | null>(null);
  const [showReportForm, setShowReportForm] = useState(false);
  const [reportReason, setReportReason] = useState("");

  useEffect(() => {
    const unsub = onSnapshot(doc(getFirebase().db, "bookings", bookingId),
      (s) => setBooking(s.exists() ? (s.data() as BookingRequestDoc) : "unavailable"),
      () => setBooking("unavailable"));
    return unsub;
  }, [bookingId]);

  const musicianProfileId = booking !== "loading" && booking !== "unavailable" && booking ? booking.musicianProfileId : undefined;
  const curatorProfileId = booking !== "loading" && booking !== "unavailable" && booking ? booking.curatorProfileId : undefined;
  const gigId = booking !== "loading" && booking !== "unavailable" && booking ? booking.gigId : undefined;
  // Hooks run unconditionally, every render, the early returns below
  // happen AFTER all four are called.
  const role = useRole(musicianProfileId, curatorProfileId, uid);
  const gig = useGig(gigId);
  const occurrences = useOccurrences(bookingId);
  const now = useNow();

  if (booking === "loading" || role === "loading") return <Text muted>Loading…</Text>;
  if (booking === "unavailable" || !booking) {
    return <Text>You don&apos;t have access to this booking, or it doesn&apos;t exist.</Text>;
  }
  if (role === "none") {
    // Reachable only for an admin (bookings/{id}'s own read rule also
    // allows isAdmin()), a stranger to both profiles can't read the
    // booking doc at all, so `booking` would already be "unavailable".
    return (
      <View style={{ gap: tokens.space.lg }}>
        <Text muted>Viewing as an observer, you&apos;re not a member of either side, so actions here are unavailable.</Text>
        <ThreadHistory thread={booking.thread} structure={booking.structure} />
      </View>
    );
  }

  const bothSides = role === "both";
  // The server resolves an ambiguous (both-sides) actor as "musician" for
  // every NEGOTIATION callable, mirrored here so the action bar reflects
  // what will actually happen server-side. cancelBooking/cancelOccurrence/
  // reportNoShow instead REFUSE outright for a dual member, those actions
  // are disabled below instead, per the recorded ruling (Task 4/6).
  const mySide: BookingSide = bothSides ? "musician" : (role as BookingSide);
  // Distinct from `mySide` on purpose: `isCuratorSide` answers "is this
  // profile genuinely on the curator side at all" (true for both "curator"
  // and "both") and gates report-a-no-show VISIBILITY, visible but
  // disabled for a both-sides member, never hidden.
  const isCuratorSide = role === "curator" || bothSides;

  const lastEntry = booking.thread[booking.thread.length - 1];
  // Accept-preview total/deposit, pure derivation from the CURRENT last
  // thread entry + the live gig's durationMinutes, exactly mirroring
  // acceptBooking's own freeze-from-last-entry math.
  const preview = (gig === "loading" || gig === "unavailable" || gig === null) ? null : (() => {
    const expectedTotalCents = computeExpectedTotalCents(booking.structure, lastEntry.amountCents, {
      durationMinutes: gig.durationMinutes, songCount: lastEntry.expectedQuantity ?? undefined,
    });
    return {
      expectedTotalCents, depositAmountCents: computeDepositCents(expectedTotalCents),
      // Money-copy parity with web (SP5 Task 15), the same fee-inclusive
      // "Due now" preview web's BookingThread renders, never the server's
      // source of truth (invariant #1, acceptBooking recomputes every cent
      // independently from the frozen thread entry it commits).
      chargePreview: depositChargePreviewCents(expectedTotalCents),
    };
  })();

  const counter = async (payload: OfferPayload) => {
    setActionBusy("counter"); setActionError(null);
    try {
      await callFn("counterBooking", { bookingId, offer: payload });
      setShowCounterForm(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not send this counter-offer.");
    } finally {
      setActionBusy(null);
    }
  };
  const doDecline = async () => {
    setActionBusy("decline"); setActionError(null);
    try {
      await callFn("declineBooking", { bookingId });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not decline.");
    } finally {
      setActionBusy(null);
    }
  };
  const decline = () => Alert.alert("Decline this booking request?", undefined, [
    { text: "Cancel", style: "cancel" },
    { text: "Decline", style: "destructive", onPress: () => void doDecline() },
  ]);
  const doWithdraw = async () => {
    setActionBusy("withdraw"); setActionError(null);
    try {
      await callFn("withdrawBooking", { bookingId });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not withdraw.");
    } finally {
      setActionBusy(null);
    }
  };
  const withdraw = () => Alert.alert("Withdraw this booking request?", undefined, [
    { text: "Cancel", style: "cancel" },
    { text: "Withdraw", style: "destructive", onPress: () => void doWithdraw() },
  ]);
  const accept = async () => {
    setActionBusy("accept"); setActionError(null);
    try {
      await callFn("acceptBooking", { bookingId });
      setShowAcceptConfirm(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not accept.");
    } finally {
      setActionBusy(null);
    }
  };
  const reportNoShow = async () => {
    const trimmed = reportReason.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_CANCEL_REASON_LENGTH) {
      setActionError(`Reason must be 1-${MAX_CANCEL_REASON_LENGTH} characters.`);
      return;
    }
    setActionBusy("reportNoShow"); setActionError(null);
    try {
      // already-exists (a second report on the same booking) surfaces here
      // verbatim, server copy reads correctly as-is, no special-case
      // needed.
      await callFn("reportNoShow", { bookingId, reason: trimmed });
      setShowReportForm(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not report a no-show.");
    } finally {
      setActionBusy(null);
    }
  };

  const gigTitle = gig !== "loading" && gig !== "unavailable" && gig ? (gig.title || "Untitled gig") : "This gig";
  // Earliest occurrence overall (past or future), the single-gig
  // "confirmed" summary's date display.
  const displayOccurrence = occurrences.length > 0 ? occurrences[0] : null;
  // Latest occurrence overall, the one a COMPLETED booking's report window
  // is computed against (every occurrence is already in the past by the
  // time a booking has reached "completed", so the latest IS the most
  // recent past one, mirrors bookingLifecycle.ts's reportNoShow query).
  const lastOccurrence = occurrences.length > 0 ? occurrences[occurrences.length - 1] : null;
  // Earliest FUTURE occurrence, cancelBooking's window math target;
  // the top-level Cancel button is hidden without one.
  const cancelTarget = now == null ? null : (occurrences.find((o) => o.startsAt > now) ?? null);
  const hasStartedOccurrence = now != null && occurrences.some((o) => o.startsAt <= now);
  // Completed-view "report a no-show", the PRIMARY real-world flow: the
  // daily sweep completes a booking once its last occurrence ends,
  // typically before the curator gets a chance to report anything while
  // still "confirmed". Client-computed from the same NO_SHOW_REPORT_WINDOW_DAYS
  // constant reportNoShow's own server-side window check uses.
  const daysSinceLastOccurrence = (now != null && lastOccurrence != null) ? (now - lastOccurrence.startsAt) / (24 * 3_600_000) : null;
  const canReportInCompleted = daysSinceLastOccurrence != null && daysSinceLastOccurrence <= NO_SHOW_REPORT_WINDOW_DAYS;

  // Shared by the "confirmed" (post-start, run still ongoing) and
  // "completed" (the primary flow, see canReportInCompleted's comment)
  // report-a-no-show surfaces. Visible but DISABLED for a both-sides
  // member (not hidden), matches the ambiguity banner's own promise.
  const reportNoShowBlock = (
    <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: tokens.space.md, gap: tokens.space.sm }}>
      {showReportForm ? (
        <View style={{ gap: tokens.space.sm }}>
          <TextArea numberOfLines={3} maxLength={MAX_CANCEL_REASON_LENGTH} value={reportReason}
            onChangeText={setReportReason} placeholder="What happened?" editable={actionBusy === null}
            accessibilityLabel="No-show report reason"
            style={{ minHeight: 64 }} />
          <Text variant="meta" muted>{reportReason.length}/{MAX_CANCEL_REASON_LENGTH}</Text>
          {actionError && <ErrorBox message={actionError} />}
          <View style={{ flexDirection: "row", gap: tokens.space.sm }}>
            <Button title={actionBusy === "reportNoShow" ? "Reporting…" : "Submit report"}
              onPress={() => void reportNoShow()} disabled={actionBusy !== null} />
            <Button variant="secondary" title="Cancel"
              onPress={() => { setShowReportForm(false); setActionError(null); }} disabled={actionBusy !== null} />
          </View>
        </View>
      ) : (
        <Button variant="ghost" onPress={() => setShowReportForm(true)} disabled={bothSides}
          style={{ alignSelf: "flex-start", paddingHorizontal: 0 }}>
          <Text color={t.destructive}>Report a no-show{bothSides ? " (disabled, you're on both sides)" : ""}</Text>
        </Button>
      )}
    </View>
  );

  return (
    <View style={{ gap: tokens.space.xl }}>
      <View style={{ gap: tokens.space.xs }}>
        <Text variant="heading">{gigTitle}</Text>
        <Text muted>
          {BUDGET_STRUCTURE_LABEL[booking.structure]} · Status: {booking.status.replace(/_/g, " ")}
        </Text>
      </View>

      {bothSides && (
        // Left accent rule (ember) distinguishes this neutral info banner
        // from the Cards below; ember is in-palette (no 4th color added).
        <Callout tone="neutral" style={{ borderLeftWidth: 3, borderLeftColor: t.accent }}>
          <Text>
            You&apos;re on both sides of this booking. Negotiation actions (accept/counter/decline/withdraw) still work, the
            server treats you as the musician side, but cancellation and no-show reporting are disabled here to avoid an
            ambiguous, self-favoring choice.
          </Text>
        </Callout>
      )}

      <ThreadHistory thread={booking.thread} structure={booking.structure} />

      {booking.status === "open" && (
        <View style={{ gap: tokens.space.md }}>
          <Text variant="title">Respond</Text>
          {showCounterForm ? (
            <OfferForm structure={booking.structure} busy={actionBusy === "counter"} error={actionError}
              onSubmit={(p) => void counter(p)} onCancel={() => { setShowCounterForm(false); setActionError(null); }} />
          ) : booking.awaitingSide !== mySide ? (
            <View style={{ gap: tokens.space.sm }}>
              <Text muted>Waiting on the other side to respond.</Text>
              <Button variant="secondary" title={actionBusy === "withdraw" ? "Withdrawing…" : "Withdraw"}
                onPress={withdraw} disabled={actionBusy !== null} style={{ alignSelf: "flex-start" }} />
              {actionError && <ErrorBox message={actionError} />}
            </View>
          ) : (
            <View style={{ gap: tokens.space.md }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: tokens.space.sm }}>
                <Button title={`Accept ${formatCents(lastEntry.amountCents)}`}
                  onPress={() => setShowAcceptConfirm(true)} disabled={actionBusy !== null} />
                <Button variant="secondary" title="Counter…"
                  onPress={() => setShowCounterForm(true)} disabled={actionBusy !== null} />
                <Button variant="secondary" onPress={decline} disabled={actionBusy !== null}>
                  <Text variant="label" color={t.destructive}>{actionBusy === "decline" ? "Declining…" : "Decline"}</Text>
                </Button>
              </View>
              {actionError && (
                <GatePrompt message={actionError} curatorProfileId={booking.curatorProfileId}
                  viewerIsMusician={mySide === "musician"} onRetry={() => void accept()} />
              )}
              {showAcceptConfirm && (
                <Card style={{ gap: tokens.space.sm }}>
                  <Text variant="label">Confirm accept</Text>
                  {preview ? (
                    <>
                      <Text>Total: {formatCents(preview.expectedTotalCents)}</Text>
                      {/* Web parity (SP5 Task 15 review round 1, medium #4):
                          the "Due now" breakdown is CURATOR money, only the
                          curator side sees the actual figures; a
                          musician-side accepter gets a neutral line instead
                          (the charge lands on the CURATOR's card regardless
                          of who clicks accept). */}
                      {mySide === "curator" ? (
                        <>
                          <Text muted>
                            Due now: {formatCents(preview.chargePreview.totalCents)}{" "}
                            ({formatCents(preview.chargePreview.sliceCents)} deposit{" + "}
                            {formatCents(preview.chargePreview.feeCents)} service fee)
                            {/* A whole-run booking's deposit is charged PER
                                DATE, not once, occurrences[] only ever holds
                                "filled" gigs, so it's empty at this
                                pre-accept point in practice; the count branch
                                below is a cheap-if-available upgrade, not
                                something this screen can currently reach,
                                but stays correct if that ever changes (web
                                parity). */}
                            {booking.seriesId != null && occurrences.length === 0
                              ? " × each of the run's upcoming dates" : ""}
                          </Text>
                          {booking.seriesId != null && occurrences.length > 0 && (
                            <Text muted>
                              ≈ {occurrences.length} dates, {formatCents(preview.chargePreview.totalCents * occurrences.length)} total due now.
                            </Text>
                          )}
                          <Text muted>
                            Remaining {100 - DEPOSIT_PERCENT}% + fee auto-charges after each date.
                          </Text>
                        </>
                      ) : (
                        <Text muted>
                          The curator&apos;s card is charged the deposit when you accept.
                        </Text>
                      )}
                    </>
                  ) : (
                    <Text color={t.warning}>
                      Couldn&apos;t load this gig&apos;s details to preview the total right now, try again shortly.
                    </Text>
                  )}
                  <View style={{ flexDirection: "row", gap: tokens.space.sm }}>
                    <Button title={actionBusy === "accept" ? "Accepting…" : "Confirm accept"}
                      onPress={() => void accept()} disabled={actionBusy !== null || !preview} />
                    <Button variant="secondary" title="Back"
                      onPress={() => setShowAcceptConfirm(false)} disabled={actionBusy !== null} />
                  </View>
                </Card>
              )}
            </View>
          )}
        </View>
      )}

      {booking.status === "confirmed" && (
        <View style={{ gap: tokens.space.md }}>
          <Text variant="title">Confirmed</Text>
          {booking.acceptedTerms && (
            <Text>
              Terms: {formatCents(booking.acceptedTerms.amountCents)} {BUDGET_STRUCTURE_LABEL[booking.structure]}
              {", "}total {formatCents(booking.acceptedTerms.expectedTotalCents)}
            </Text>
          )}
          {booking.deposit && <Text muted>{depositLine(booking.deposit.amountCents)}</Text>}
          {booking.seriesId == null && displayOccurrence && (
            <Text>{formatGigDateTime(displayOccurrence.startsAt)} ({formatDuration(displayOccurrence.durationMinutes)})</Text>
          )}

          {booking.seriesId != null && (
            <View style={{ gap: tokens.space.sm }}>
              <Text variant="title">Dates</Text>
              {occurrences.length === 0 ? (
                <Text muted>No dates of this run remain booked.</Text>
              ) : (
                occurrences.map((o) => {
                  const isFuture = now != null && o.startsAt > now;
                  return (
                    <View key={o.id} style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm, borderWidth: 1, borderColor: t.border, borderRadius: tokens.radius.sm, padding: tokens.space.sm }}>
                      <Text style={{ flex: 1 }}>{formatGigDateTime(o.startsAt)} ({formatDuration(o.durationMinutes)})</Text>
                      {isFuture && (
                        // Visible but disabled for a both-sides member (not hidden).
                        <Button variant="ghost" onPress={() => setShowCancelFor({ mode: "occurrence", gigId: o.id, startsAt: o.startsAt })}
                          disabled={bothSides || actionBusy !== null} style={{ paddingHorizontal: 0 }}>
                          <Text variant="meta" color={bothSides ? t.muted : t.destructive}>Cancel this date</Text>
                        </Button>
                      )}
                    </View>
                  );
                })
              )}
            </View>
          )}

          {showCancelFor ? (
            <CancelDialog bookingId={bookingId} gigId={showCancelFor.gigId} side={mySide} startsAt={showCancelFor.startsAt}
              depositAmountCents={booking.deposit?.amountCents} mode={showCancelFor.mode}
              onClose={() => setShowCancelFor(null)} onDone={() => setShowCancelFor(null)} />
          ) : (
            cancelTarget && (
              <Button variant="ghost" onPress={() => setShowCancelFor({ mode: "booking", startsAt: cancelTarget.startsAt })}
                disabled={bothSides || actionBusy !== null} style={{ alignSelf: "flex-start", paddingHorizontal: 0 }}>
                <Text color={bothSides ? t.muted : t.destructive}>
                  Cancel this booking{bothSides ? " (disabled, you're on both sides)" : ""}
                </Text>
              </Button>
            )
          )}

          {isCuratorSide && hasStartedOccurrence && reportNoShowBlock}
        </View>
      )}

      {booking.status !== "open" && booking.status !== "confirmed" && (
        <View style={{ gap: tokens.space.md }}>
          <Text variant="title">{bookingHistoryLabel(booking)}</Text>
          {(booking.status === "cancelled_by_curator" || booking.status === "cancelled_by_musician") && booking.cancellation && (
            <Card style={{ padding: tokens.space.md, gap: tokens.space.xs }}>
              <Text>Cancelled by the {booking.cancellation.by} side on {formatGigDateTime(booking.cancellation.at)}.</Text>
              <Text muted>Reason: {booking.cancellation.reason}</Text>
              <Text muted>
                {booking.cancellation.outcome === "deposit_forfeited" ? "Deposit forfeited to the musician." : "Deposit refunded."}
                {booking.cancellation.markApplied
                  // reportNoShow always produces hoursBeforeStart <= 0 (the
                  // occurrence had already started when reported); a
                  // genuine late-but-before-start cancellation always has
                  // hoursBeforeStart > 0, the sign reliably tells the two
                  // apart.
                  ? (booking.cancellation.hoursBeforeStart <= 0 ? " A reliability mark was recorded." : " A late-cancellation mark was recorded.")
                  : ""}
              </Text>
            </Card>
          )}
          {booking.status === "completed" && (
            <>
              <Text muted>This booking is complete.</Text>
              {isCuratorSide && canReportInCompleted && reportNoShowBlock}
            </>
          )}
        </View>
      )}
    </View>
  );
}
