import { useEffect, useState } from "react";
import { View, Text, Pressable, TextInput, Alert } from "react-native";
import { doc, onSnapshot, getDoc, collection, query, where, orderBy } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { formatGigDateTime, formatCents, BUDGET_STRUCTURE_LABEL, Badge } from "../gigs/GigForms";
import { formatDuration, ErrorBox, type OfferPayload } from "./BookingForms";
import { bookingHistoryLabel, depositLine } from "./BookingInbox";
import { OfferForm } from "./OfferForm";
import { CancelDialog } from "./CancelDialog";
import { GatePrompt } from "../payments/GatePrompt";
import {
  computeExpectedTotalCents, computeDepositCents, MAX_BOOKING_THREAD_ENTRIES, MAX_CANCEL_REASON_LENGTH,
  NO_SHOW_REPORT_WINDOW_DAYS,
  type BookingRequestDoc, type BookingSide, type GigDoc,
} from "@gatekeep/shared";

// RN port of ../../../web/src/bookings/BookingThread.tsx (SP4 Task 12) —
// the booking thread screen's content, mounted by
// apps/mobile/app/booking/[bookingId].tsx (the shared thread route for
// BOTH role tabs' inbox rows and notification deep-links). Behavior mirrors
// web's as-built (Task 10, incl. every review fix) exactly; only the
// rendering is RN.

type Role = "musician" | "curator" | "both" | "none" | "loading";
type Occurrence = { id: string; startsAt: number; durationMinutes: number };

// Render-safe "now", ticking on mount and every 30s afterward (Task 10
// review) — a "now" frozen at mount would never grow, so e.g. the
// completed-view no-show report window could stay hidden past the moment
// it should appear, or a per-date cancel button could stay visible past a
// date's start, for as long as this screen stays open. Both reads happen
// inside a setTimeout/setInterval callback, not synchronously in the
// effect body, matching web's react-hooks/set-state-in-effect-safe shape
// (this codebase's mobile files follow the identical pattern — see e.g.
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

// Resolves which side(s) `uid` belongs to for this booking's two profiles —
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
// src/bookings/BookingThread.tsx) — a second hand-rolled copy of this on
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

// The booking's initiating gig — permission-tolerant (a stale gig can leave
// every publicly-readable disjunct for a viewer only on the musician side —
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

// Every currently-linked, still-"filled" occurrence of this booking — same
// rules-provability rationale as BookingInbox.tsx's useNextOccurrence
// (status=="filled" pinned alongside bookingId). Populated for both
// single-gig and whole-run bookings; only the whole-run view renders the
// full per-date list, but the single-gig "next date" summary reuses the
// same query. Past FILLED gigs stay "filled" forever (Task 8's review), so
// this list's LAST entry is what the completed-view no-show report window
// is computed from.
//
// Exported (SP5b Task 5): PaymentStatus.tsx needs the SAME per-occurrence
// durationMinutes true-up previews key off, and web already exports its
// identical hook from the equivalent file for the equivalent consumer
// (apps/web/src/payments/PaymentsPanel.tsx imports useOccurrences from
// src/bookings/BookingThread.tsx) — a second hand-rolled copy of this on
// mobile would be free to drift from the server's own "filled" query.
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
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>
        Offer history <Text style={{ color: "#666", fontSize: 13, fontWeight: "400" }}>thread {thread.length}/{MAX_BOOKING_THREAD_ENTRIES}</Text>
      </Text>
      <View style={{ gap: 8 }}>
        {thread.map((entry, i) => {
          const isCurrent = i === thread.length - 1;
          return (
            <View key={`${i}-${entry.at}`} style={{
              borderWidth: 1, borderColor: isCurrent ? "#111" : "#eee", borderRadius: 8, padding: 10,
              backgroundColor: isCurrent ? "#f9fafb" : "#fff", gap: 4,
            }}>
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                <Text style={{ fontWeight: isCurrent ? "700" : "400", flexShrink: 1 }}>
                  {entry.by === "musician" ? "Musician" : "Curator"} offered {formatCents(entry.amountCents)} {BUDGET_STRUCTURE_LABEL[structure]}
                  {structure === "perSong" && entry.expectedQuantity != null ? ` × ${entry.expectedQuantity} songs` : ""}
                </Text>
                {isCurrent && <Badge label="current offer" bg="#e0e7ff" />}
              </View>
              {entry.note && <Text style={{ color: "#666" }}>{entry.note}</Text>}
              <Text style={{ color: "#999", fontSize: 12 }}>{formatGigDateTime(entry.at)}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const primaryBtn = { backgroundColor: "#111", paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 };
const secondaryBtn = { borderWidth: 1 as const, borderColor: "#bbb", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16 };
const dangerText = { color: "#dc2626" };

// The booking thread screen's content — mounted by
// apps/mobile/app/booking/[bookingId].tsx, keyed by `${bookingId}-${uid}`
// there so an identity or route switch always gets a fresh instance rather
// than reusing stale per-action state under new params.
export function BookingThread({ bookingId, uid }: { bookingId: string; uid: string }) {
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
  // Hooks run unconditionally, every render — the early returns below
  // happen AFTER all four are called.
  const role = useRole(musicianProfileId, curatorProfileId, uid);
  const gig = useGig(gigId);
  const occurrences = useOccurrences(bookingId);
  const now = useNow();

  if (booking === "loading" || role === "loading") return <Text>Loading…</Text>;
  if (booking === "unavailable" || !booking) {
    return <Text>You don&apos;t have access to this booking, or it doesn&apos;t exist.</Text>;
  }
  if (role === "none") {
    // Reachable only for an admin (bookings/{id}'s own read rule also
    // allows isAdmin()) — a stranger to both profiles can't read the
    // booking doc at all, so `booking` would already be "unavailable".
    return (
      <View style={{ gap: 16 }}>
        <Text style={{ color: "#666" }}>Viewing as an observer — you&apos;re not a member of either side, so actions here are unavailable.</Text>
        <ThreadHistory thread={booking.thread} structure={booking.structure} />
      </View>
    );
  }

  const bothSides = role === "both";
  // The server resolves an ambiguous (both-sides) actor as "musician" for
  // every NEGOTIATION callable — mirrored here so the action bar reflects
  // what will actually happen server-side. cancelBooking/cancelOccurrence/
  // reportNoShow instead REFUSE outright for a dual member — those actions
  // are disabled below instead, per the recorded ruling (Task 4/6).
  const mySide: BookingSide = bothSides ? "musician" : (role as BookingSide);
  // Distinct from `mySide` on purpose: `isCuratorSide` answers "is this
  // profile genuinely on the curator side at all" (true for both "curator"
  // and "both") and gates report-a-no-show VISIBILITY — visible but
  // disabled for a both-sides member, never hidden.
  const isCuratorSide = role === "curator" || bothSides;

  const lastEntry = booking.thread[booking.thread.length - 1];
  // Accept-preview total/deposit — pure derivation from the CURRENT last
  // thread entry + the live gig's durationMinutes, exactly mirroring
  // acceptBooking's own freeze-from-last-entry math.
  const preview = (gig === "loading" || gig === "unavailable" || gig === null) ? null : (() => {
    const expectedTotalCents = computeExpectedTotalCents(booking.structure, lastEntry.amountCents, {
      durationMinutes: gig.durationMinutes, songCount: lastEntry.expectedQuantity ?? undefined,
    });
    return { expectedTotalCents, depositAmountCents: computeDepositCents(expectedTotalCents) };
  })();

  const counter = async (payload: OfferPayload) => {
    setActionBusy("counter"); setActionError(null);
    try {
      await httpsCallable(getFirebase().functions, "counterBooking")({ bookingId, offer: payload });
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
      await httpsCallable(getFirebase().functions, "declineBooking")({ bookingId });
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
      await httpsCallable(getFirebase().functions, "withdrawBooking")({ bookingId });
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
      await httpsCallable(getFirebase().functions, "acceptBooking")({ bookingId });
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
      // verbatim — server copy reads correctly as-is, no special-case
      // needed.
      await httpsCallable(getFirebase().functions, "reportNoShow")({ bookingId, reason: trimmed });
      setShowReportForm(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not report a no-show.");
    } finally {
      setActionBusy(null);
    }
  };

  const gigTitle = gig !== "loading" && gig !== "unavailable" && gig ? (gig.title || "Untitled gig") : "This gig";
  // Earliest occurrence overall (past or future) — the single-gig
  // "confirmed" summary's date display.
  const displayOccurrence = occurrences.length > 0 ? occurrences[0] : null;
  // Latest occurrence overall — the one a COMPLETED booking's report window
  // is computed against (every occurrence is already in the past by the
  // time a booking has reached "completed", so the latest IS the most
  // recent past one — mirrors bookingLifecycle.ts's reportNoShow query).
  const lastOccurrence = occurrences.length > 0 ? occurrences[occurrences.length - 1] : null;
  // Earliest FUTURE occurrence — cancelBooking's window math target;
  // the top-level Cancel button is hidden without one.
  const cancelTarget = now == null ? null : (occurrences.find((o) => o.startsAt > now) ?? null);
  const hasStartedOccurrence = now != null && occurrences.some((o) => o.startsAt <= now);
  // Completed-view "report a no-show" — the PRIMARY real-world flow: the
  // daily sweep completes a booking once its last occurrence ends,
  // typically before the curator gets a chance to report anything while
  // still "confirmed". Client-computed from the same NO_SHOW_REPORT_WINDOW_DAYS
  // constant reportNoShow's own server-side window check uses.
  const daysSinceLastOccurrence = (now != null && lastOccurrence != null) ? (now - lastOccurrence.startsAt) / (24 * 3_600_000) : null;
  const canReportInCompleted = daysSinceLastOccurrence != null && daysSinceLastOccurrence <= NO_SHOW_REPORT_WINDOW_DAYS;

  // Shared by the "confirmed" (post-start, run still ongoing) and
  // "completed" (the primary flow — see canReportInCompleted's comment)
  // report-a-no-show surfaces. Visible but DISABLED for a both-sides
  // member (not hidden) — matches the ambiguity banner's own promise.
  const reportNoShowBlock = (
    <View style={{ borderTopWidth: 1, borderTopColor: "#eee", paddingTop: 12, gap: 8 }}>
      {showReportForm ? (
        <View style={{ gap: 8 }}>
          <TextInput multiline numberOfLines={3} maxLength={MAX_CANCEL_REASON_LENGTH} value={reportReason}
            onChangeText={setReportReason} placeholder="What happened?" editable={actionBusy === null}
            accessibilityLabel="No-show report reason"
            style={{ borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 64, textAlignVertical: "top" }} />
          <Text style={{ fontSize: 12, color: "#666" }}>{reportReason.length}/{MAX_CANCEL_REASON_LENGTH}</Text>
          {actionError && <ErrorBox message={actionError} />}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable onPress={() => void reportNoShow()} disabled={actionBusy !== null} style={primaryBtn}>
              <Text style={{ color: "#fff" }}>{actionBusy === "reportNoShow" ? "Reporting…" : "Submit report"}</Text>
            </Pressable>
            <Pressable onPress={() => { setShowReportForm(false); setActionError(null); }} disabled={actionBusy !== null} style={secondaryBtn}>
              <Text>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable onPress={() => setShowReportForm(true)} disabled={bothSides} style={{ alignSelf: "flex-start", opacity: bothSides ? 0.5 : 1 }}>
          <Text style={dangerText}>Report a no-show{bothSides ? " (disabled — you're on both sides)" : ""}</Text>
        </Pressable>
      )}
    </View>
  );

  return (
    <View style={{ gap: 20 }}>
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: 22, fontWeight: "700" }}>{gigTitle}</Text>
        <Text style={{ color: "#666" }}>
          {BUDGET_STRUCTURE_LABEL[booking.structure]} · Status: {booking.status.replace(/_/g, " ")}
        </Text>
      </View>

      {bothSides && (
        <Text style={{ backgroundColor: "#e0e7ff", borderWidth: 1, borderColor: "#c7d2fe", borderRadius: 8, padding: 12 }}>
          You&apos;re on both sides of this booking. Negotiation actions (accept/counter/decline/withdraw) still work — the
          server treats you as the musician side — but cancellation and no-show reporting are disabled here to avoid an
          ambiguous, self-favoring choice.
        </Text>
      )}

      <ThreadHistory thread={booking.thread} structure={booking.structure} />

      {booking.status === "open" && (
        <View style={{ gap: 10 }}>
          <Text style={{ fontSize: 18, fontWeight: "700" }}>Respond</Text>
          {showCounterForm ? (
            <OfferForm structure={booking.structure} busy={actionBusy === "counter"} error={actionError}
              onSubmit={(p) => void counter(p)} onCancel={() => { setShowCounterForm(false); setActionError(null); }} />
          ) : booking.awaitingSide !== mySide ? (
            <View style={{ gap: 8 }}>
              <Text style={{ color: "#666" }}>Waiting on the other side to respond.</Text>
              <Pressable onPress={withdraw} disabled={actionBusy !== null} style={[secondaryBtn, { alignSelf: "flex-start" }]}>
                <Text>{actionBusy === "withdraw" ? "Withdrawing…" : "Withdraw"}</Text>
              </Pressable>
              {actionError && <ErrorBox message={actionError} />}
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <Pressable onPress={() => setShowAcceptConfirm(true)} disabled={actionBusy !== null} style={primaryBtn}>
                  <Text style={{ color: "#fff" }}>Accept {formatCents(lastEntry.amountCents)}</Text>
                </Pressable>
                <Pressable onPress={() => setShowCounterForm(true)} disabled={actionBusy !== null} style={secondaryBtn}>
                  <Text>Counter…</Text>
                </Pressable>
                <Pressable onPress={decline} disabled={actionBusy !== null} style={secondaryBtn}>
                  <Text style={dangerText}>{actionBusy === "decline" ? "Declining…" : "Decline"}</Text>
                </Pressable>
              </View>
              {actionError && (
                <GatePrompt message={actionError} curatorProfileId={booking.curatorProfileId}
                  viewerIsMusician={mySide === "musician"} onRetry={() => void accept()} />
              )}
              {showAcceptConfirm && (
                <View style={{ borderWidth: 1, borderColor: "#111", borderRadius: 8, padding: 12, gap: 8 }}>
                  <Text style={{ fontWeight: "700" }}>Confirm accept</Text>
                  {preview ? (
                    <>
                      <Text>Total: {formatCents(preview.expectedTotalCents)}</Text>
                      <Text style={{ color: "#666" }}>{depositLine(preview.depositAmountCents)}</Text>
                    </>
                  ) : (
                    <Text style={{ color: "#92400e" }}>
                      Couldn&apos;t load this gig&apos;s details to preview the total right now — try again shortly.
                    </Text>
                  )}
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Pressable onPress={() => void accept()} disabled={actionBusy !== null || !preview} style={primaryBtn}>
                      <Text style={{ color: "#fff" }}>{actionBusy === "accept" ? "Accepting…" : "Confirm accept"}</Text>
                    </Pressable>
                    <Pressable onPress={() => setShowAcceptConfirm(false)} disabled={actionBusy !== null} style={secondaryBtn}>
                      <Text>Back</Text>
                    </Pressable>
                  </View>
                </View>
              )}
            </View>
          )}
        </View>
      )}

      {booking.status === "confirmed" && (
        <View style={{ gap: 12 }}>
          <Text style={{ fontSize: 18, fontWeight: "700" }}>Confirmed</Text>
          {booking.acceptedTerms && (
            <Text>
              Terms: {formatCents(booking.acceptedTerms.amountCents)} {BUDGET_STRUCTURE_LABEL[booking.structure]}
              {" "}— total {formatCents(booking.acceptedTerms.expectedTotalCents)}
            </Text>
          )}
          {booking.deposit && <Text style={{ color: "#666" }}>{depositLine(booking.deposit.amountCents)}</Text>}
          {booking.seriesId == null && displayOccurrence && (
            <Text>{formatGigDateTime(displayOccurrence.startsAt)} ({formatDuration(displayOccurrence.durationMinutes)})</Text>
          )}

          {booking.seriesId != null && (
            <View style={{ gap: 8 }}>
              <Text style={{ fontSize: 16, fontWeight: "700" }}>Dates</Text>
              {occurrences.length === 0 ? (
                <Text style={{ color: "#666" }}>No dates of this run remain booked.</Text>
              ) : (
                occurrences.map((o) => {
                  const isFuture = now != null && o.startsAt > now;
                  return (
                    <View key={o.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: "#eee", borderRadius: 6, padding: 8 }}>
                      <Text style={{ flex: 1 }}>{formatGigDateTime(o.startsAt)} ({formatDuration(o.durationMinutes)})</Text>
                      {isFuture && (
                        // Visible but disabled for a both-sides member (not hidden).
                        <Pressable onPress={() => setShowCancelFor({ mode: "occurrence", gigId: o.id, startsAt: o.startsAt })}
                          disabled={bothSides || actionBusy !== null}>
                          <Text style={{ fontSize: 13, color: bothSides ? "#999" : "#dc2626" }}>Cancel this date</Text>
                        </Pressable>
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
              <Pressable onPress={() => setShowCancelFor({ mode: "booking", startsAt: cancelTarget.startsAt })}
                disabled={bothSides || actionBusy !== null} style={{ alignSelf: "flex-start" }}>
                <Text style={{ color: bothSides ? "#999" : "#dc2626" }}>
                  Cancel this booking{bothSides ? " (disabled — you're on both sides)" : ""}
                </Text>
              </Pressable>
            )
          )}

          {isCuratorSide && hasStartedOccurrence && reportNoShowBlock}
        </View>
      )}

      {booking.status !== "open" && booking.status !== "confirmed" && (
        <View style={{ gap: 10 }}>
          <Text style={{ fontSize: 18, fontWeight: "700" }}>{bookingHistoryLabel(booking)}</Text>
          {(booking.status === "cancelled_by_curator" || booking.status === "cancelled_by_musician") && booking.cancellation && (
            <View style={{ borderWidth: 1, borderColor: "#eee", borderRadius: 8, padding: 12, gap: 4 }}>
              <Text>Cancelled by the {booking.cancellation.by} side on {formatGigDateTime(booking.cancellation.at)}.</Text>
              <Text style={{ color: "#666" }}>Reason: {booking.cancellation.reason}</Text>
              <Text style={{ color: "#666" }}>
                {booking.cancellation.outcome === "deposit_forfeited" ? "Deposit forfeited to the musician." : "Deposit refunded."}
                {booking.cancellation.markApplied
                  // reportNoShow always produces hoursBeforeStart <= 0 (the
                  // occurrence had already started when reported); a
                  // genuine late-but-before-start cancellation always has
                  // hoursBeforeStart > 0 — the sign reliably tells the two
                  // apart.
                  ? (booking.cancellation.hoursBeforeStart <= 0 ? " A reliability mark was recorded." : " A late-cancellation mark was recorded.")
                  : ""}
              </Text>
            </View>
          )}
          {booking.status === "completed" && (
            <>
              <Text style={{ color: "#666" }}>This booking is complete.</Text>
              {isCuratorSide && canReportInCompleted && reportNoShowBlock}
            </>
          )}
        </View>
      )}
    </View>
  );
}
