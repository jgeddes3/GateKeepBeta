"use client";
import { useEffect, useState } from "react";
import { collection, doc, getDoc, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { formatGigDateTime, formatCents, BUDGET_STRUCTURE_LABEL, badge } from "../gigs/GigForms";
import { formatDuration, bookingHistoryLabel, depositLine, useNow, type OfferPayload } from "./BookingForms";
import { OfferForm } from "./OfferForm";
import { CancelDialog } from "./CancelDialog";
import {
  computeExpectedTotalCents, computeDepositCents, MAX_BOOKING_THREAD_ENTRIES, MAX_CANCEL_REASON_LENGTH,
  type BookingRequestDoc, type BookingSide, type GigDoc,
} from "@gatekeep/shared";

type Role = "musician" | "curator" | "both" | "none" | "loading";
type Occurrence = { id: string; startsAt: number; durationMinutes: number };

function ErrorBox({ message }: { message: string }) {
  return (
    <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
      {message}
    </p>
  );
}

// Resolves which side(s) `uid` belongs to for this booking's two profiles —
// mirrors bookings.ts's requireBookingSide (musician-first on a dual
// member) for DISPLAY purposes only; the server independently re-derives
// and enforces the real authorization on every callable. Each membership
// GET is resolved independently (own .catch -> false) rather than a single
// Promise.all().catch(): a permission-denied on the side you're NOT a
// member of is a legitimate, expected outcome (see firestore.rules'
// members `allow get` rule), and must not swallow the OTHER side's
// successful result.
function useRole(musicianProfileId: string | undefined, curatorProfileId: string | undefined, uid: string): Role {
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

// The booking's initiating gig — permission-tolerant (see BookingForms.tsx's
// useRowGigTitle comment for the identical rationale: a direct GET is
// evaluated per-document, but a stale gig can leave every publicly-readable
// disjunct for a viewer who's only on the musician side). Live (onSnapshot,
// not a one-shot get) since its status can change while the thread is open
// (a rival accept, a takedown) and durationMinutes feeds the accept-preview
// total below.
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

// Every currently-linked, still-"filled" occurrence of this booking — see
// BookingForms.tsx's useNextOccurrence for why status=="filled" is pinned
// in addition to bookingId (rules list-provability, not just a display
// filter) and why this reuses the (bookingId,status,startsAt) index rather
// than needing a new one. Populated for BOTH single-gig and whole-run
// bookings (a single-gig booking's own gig also carries bookingId while
// filled) — the render below only shows the full per-date list once
// seriesId != null, but the single-gig "next date" summary reuses the same
// query rather than a second, separate fetch.
function useOccurrences(bookingId: string): Occurrence[] {
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
    <section>
      <h2>
        Offer history{" "}
        <span style={{ color: "#666", fontSize: 14, fontWeight: 400 }}>thread {thread.length}/{MAX_BOOKING_THREAD_ENTRIES}</span>
      </h2>
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
        {thread.map((entry, i) => {
          const isCurrent = i === thread.length - 1;
          return (
            <li key={`${i}-${entry.at}`} style={{
              border: `1px solid ${isCurrent ? "#111" : "#eee"}`, borderRadius: 8, padding: 10, background: isCurrent ? "#f9fafb" : "#fff",
            }}>
              <p style={{ margin: 0, fontWeight: isCurrent ? 600 : 400 }}>
                {entry.by === "musician" ? "Musician" : "Curator"} offered {formatCents(entry.amountCents)} {BUDGET_STRUCTURE_LABEL[structure]}
                {structure === "perSong" && entry.expectedQuantity != null ? ` × ${entry.expectedQuantity} songs` : ""}
                {isCurrent && <span style={{ ...badge("#e0e7ff"), marginLeft: 8 }}>current offer</span>}
              </p>
              {entry.note && <p style={{ margin: "4px 0 0", color: "#666" }}>{entry.note}</p>}
              <p style={{ margin: "4px 0 0", color: "#999", fontSize: 12 }}>{formatGigDateTime(entry.at)}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// The booking thread screen's content — mounted by
// app/dashboard/bookings/[bookingId]/page.tsx, keyed by `${bookingId}-${uid}`
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
  // Hooks run unconditionally, every render, in the same order — the early
  // returns below happen AFTER all four are called.
  const role = useRole(musicianProfileId, curatorProfileId, uid);
  const gig = useGig(gigId);
  const occurrences = useOccurrences(bookingId);
  // Render-safe "now" — see BookingForms.tsx's useNow comment (the React
  // Compiler's purity rule forbids a bare Date.now() call during render).
  const now = useNow();

  if (booking === "loading" || role === "loading") return <p>Loading…</p>;
  if (booking === "unavailable" || !booking) {
    return <p>You don&apos;t have access to this booking, or it doesn&apos;t exist.</p>;
  }
  if (role === "none") {
    // Reachable only for an admin (bookings/{id}'s own read rule also
    // allows isAdmin()) — a stranger to both profiles can't read the
    // booking doc at all, so `booking` would already be "unavailable".
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <p style={{ color: "#666" }}>Viewing as an observer — you&apos;re not a member of either side, so actions here are unavailable.</p>
        <ThreadHistory thread={booking.thread} structure={booking.structure} />
      </div>
    );
  }

  const bothSides = role === "both";
  // The server resolves an ambiguous (both-sides) actor as "musician" for
  // every NEGOTIATION callable (bookings.ts's requireBookingSide checks
  // musician first) — mirrored here so the action bar reflects what will
  // actually happen server-side. cancelBooking/cancelOccurrence/
  // reportNoShow instead REFUSE outright for a dual member
  // (resolveBookingSideStrict) — those actions are disabled below instead,
  // per the recorded ruling (Task 4/6).
  const mySide: BookingSide = bothSides ? "musician" : (role as BookingSide);

  const lastEntry = booking.thread[booking.thread.length - 1];
  // Accept-preview total/deposit — pure derivation, recomputed every render
  // from the CURRENT last thread entry + the live gig's durationMinutes,
  // exactly mirroring acceptBooking's own freeze-from-last-entry math
  // (bookings.ts). null while the gig hasn't loaded (or is unavailable) —
  // the confirm button stays disabled in that case rather than showing a
  // wrong number.
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
  const decline = async () => {
    if (!window.confirm("Decline this booking request?")) return;
    setActionBusy("decline"); setActionError(null);
    try {
      await httpsCallable(getFirebase().functions, "declineBooking")({ bookingId });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not decline.");
    } finally {
      setActionBusy(null);
    }
  };
  const withdraw = async () => {
    if (!window.confirm("Withdraw this booking request?")) return;
    setActionBusy("withdraw"); setActionError(null);
    try {
      await httpsCallable(getFirebase().functions, "withdrawBooking")({ bookingId });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not withdraw.");
    } finally {
      setActionBusy(null);
    }
  };
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
      await httpsCallable(getFirebase().functions, "reportNoShow")({ bookingId, reason: trimmed });
      setShowReportForm(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not report a no-show.");
    } finally {
      setActionBusy(null);
    }
  };

  const gigTitle = gig !== "loading" && gig !== "unavailable" && gig ? (gig.title || "Untitled gig") : "This gig";
  // Earliest occurrence overall (past or future) — used only for the
  // single-gig "confirmed" summary's date display.
  const displayOccurrence = occurrences.length > 0 ? occurrences[0] : null;
  // Earliest FUTURE occurrence — the one cancelBooking's window math is
  // computed against server-side (executeCancellation's "next affected
  // occurrence"); the top-level Cancel button is hidden without one (there's
  // nothing left to cancel — matches the server's own NO_UPCOMING_DATES/
  // ALREADY_STARTED refusals rather than surfacing them as a clicked error).
  const cancelTarget = now == null ? null : (occurrences.find((o) => o.startsAt > now) ?? null);
  const hasStartedOccurrence = now != null && occurrences.some((o) => o.startsAt <= now);

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div>
        <h1 style={{ margin: 0 }}>{gigTitle}</h1>
        <p style={{ margin: "4px 0 0", color: "#666" }}>
          {BUDGET_STRUCTURE_LABEL[booking.structure]} · Status: {booking.status.replace(/_/g, " ")}
        </p>
      </div>

      {bothSides && (
        <p style={{ background: "#e0e7ff", border: "1px solid #c7d2fe", borderRadius: 8, padding: 12, margin: 0 }}>
          You&apos;re on both sides of this booking. Negotiation actions (accept/counter/decline/withdraw) still work — the
          server treats you as the musician side — but cancellation and no-show reporting are disabled here to avoid an
          ambiguous, self-favoring choice.
        </p>
      )}

      <ThreadHistory thread={booking.thread} structure={booking.structure} />

      {booking.status === "open" && (
        <section style={{ display: "grid", gap: 10 }}>
          <h2>Respond</h2>
          {showCounterForm ? (
            <OfferForm structure={booking.structure} busy={actionBusy === "counter"} error={actionError}
              onSubmit={counter} onCancel={() => { setShowCounterForm(false); setActionError(null); }} />
          ) : booking.awaitingSide !== mySide ? (
            <div style={{ display: "grid", gap: 8 }}>
              <p style={{ margin: 0, color: "#666" }}>Waiting on the other side to respond.</p>
              <button onClick={withdraw} disabled={actionBusy !== null} style={{ width: "fit-content" }}>
                {actionBusy === "withdraw" ? "Withdrawing…" : "Withdraw"}
              </button>
              {actionError && <ErrorBox message={actionError} />}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => setShowAcceptConfirm(true)} disabled={actionBusy !== null}>
                  Accept {formatCents(lastEntry.amountCents)}
                </button>
                <button onClick={() => setShowCounterForm(true)} disabled={actionBusy !== null}>Counter…</button>
                <button onClick={decline} disabled={actionBusy !== null}>
                  {actionBusy === "decline" ? "Declining…" : "Decline"}
                </button>
              </div>
              {actionError && <ErrorBox message={actionError} />}
              {showAcceptConfirm && (
                <div style={{ border: "1px solid #111", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
                  <p style={{ margin: 0, fontWeight: 600 }}>Confirm accept</p>
                  {preview ? (
                    <>
                      <p style={{ margin: 0 }}>Total: {formatCents(preview.expectedTotalCents)}</p>
                      <p style={{ margin: 0, color: "#666" }}>{depositLine(preview.depositAmountCents)}</p>
                    </>
                  ) : (
                    <p style={{ margin: 0, color: "#92400e" }}>
                      Couldn&apos;t load this gig&apos;s details to preview the total right now — try again shortly.
                    </p>
                  )}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={accept} disabled={actionBusy !== null || !preview}>
                      {actionBusy === "accept" ? "Accepting…" : "Confirm accept"}
                    </button>
                    <button type="button" onClick={() => setShowAcceptConfirm(false)} disabled={actionBusy !== null}>Back</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {booking.status === "confirmed" && (
        <section style={{ display: "grid", gap: 12 }}>
          <h2>Confirmed</h2>
          {booking.acceptedTerms && (
            <p style={{ margin: 0 }}>
              Terms: {formatCents(booking.acceptedTerms.amountCents)} {BUDGET_STRUCTURE_LABEL[booking.structure]}
              {" "}— total {formatCents(booking.acceptedTerms.expectedTotalCents)}
            </p>
          )}
          {booking.deposit && <p style={{ margin: 0, color: "#666" }}>{depositLine(booking.deposit.amountCents)}</p>}
          {booking.seriesId == null && displayOccurrence && (
            <p style={{ margin: 0 }}>{formatGigDateTime(displayOccurrence.startsAt)} ({formatDuration(displayOccurrence.durationMinutes)})</p>
          )}

          {booking.seriesId != null && (
            <div>
              <h3>Dates</h3>
              {occurrences.length === 0 ? (
                <p style={{ color: "#666" }}>No dates of this run remain booked.</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 6 }}>
                  {occurrences.map((o) => {
                    const isFuture = now != null && o.startsAt > now;
                    return (
                      <li key={o.id} style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid #eee", borderRadius: 6, padding: 8 }}>
                        <span>{formatGigDateTime(o.startsAt)} ({formatDuration(o.durationMinutes)})</span>
                        {isFuture && (
                          // Visible but disabled for a both-sides member (not hidden) — the
                          // ambiguity notice above already explains why; per-action disabling
                          // is the binding shape for cancel/report, unlike negotiation actions.
                          <button
                            onClick={() => setShowCancelFor({ mode: "occurrence", gigId: o.id, startsAt: o.startsAt })}
                            disabled={bothSides || actionBusy !== null} title={bothSides ? "Disabled — you're on both sides of this booking" : undefined}
                            style={{ marginLeft: "auto", fontSize: 13 }}>
                            Cancel this date
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {showCancelFor ? (
            <CancelDialog bookingId={bookingId} gigId={showCancelFor.gigId} side={mySide} startsAt={showCancelFor.startsAt}
              depositAmountCents={booking.deposit?.amountCents} mode={showCancelFor.mode}
              onClose={() => setShowCancelFor(null)} onDone={() => setShowCancelFor(null)} />
          ) : (
            cancelTarget && (
              <button onClick={() => setShowCancelFor({ mode: "booking", startsAt: cancelTarget.startsAt })}
                disabled={bothSides} title={bothSides ? "Disabled — you're on both sides of this booking" : undefined}
                style={{ width: "fit-content", color: "#dc2626" }}>
                Cancel this booking
              </button>
            )
          )}

          {mySide === "curator" && hasStartedOccurrence && (
            <div style={{ borderTop: "1px solid #eee", paddingTop: 12, display: "grid", gap: 8 }}>
              {showReportForm ? (
                <div style={{ display: "grid", gap: 8 }}>
                  <textarea rows={3} maxLength={MAX_CANCEL_REASON_LENGTH} value={reportReason}
                    onChange={(e) => setReportReason(e.target.value)} placeholder="What happened?" disabled={actionBusy !== null}
                    aria-label="No-show report reason" style={{ width: "100%" }} />
                  <p style={{ margin: 0, fontSize: 12, color: "#666" }}>{reportReason.length}/{MAX_CANCEL_REASON_LENGTH}</p>
                  {actionError && <ErrorBox message={actionError} />}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={reportNoShow} disabled={actionBusy !== null} style={{ color: "#dc2626" }}>
                      {actionBusy === "reportNoShow" ? "Reporting…" : "Submit report"}
                    </button>
                    <button type="button" onClick={() => { setShowReportForm(false); setActionError(null); }} disabled={actionBusy !== null}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setShowReportForm(true)} disabled={bothSides}
                  title={bothSides ? "Disabled — you're on both sides of this booking" : undefined}
                  style={{ width: "fit-content", color: "#dc2626" }}>
                  Report a no-show
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {booking.status !== "open" && booking.status !== "confirmed" && (
        <section style={{ display: "grid", gap: 10 }}>
          <h2>{bookingHistoryLabel(booking)}</h2>
          {(booking.status === "cancelled_by_curator" || booking.status === "cancelled_by_musician") && booking.cancellation && (
            <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, display: "grid", gap: 4 }}>
              <p style={{ margin: 0 }}>
                Cancelled by the {booking.cancellation.by} side on {formatGigDateTime(booking.cancellation.at)}.
              </p>
              <p style={{ margin: 0, color: "#666" }}>Reason: {booking.cancellation.reason}</p>
              <p style={{ margin: 0, color: "#666" }}>
                {booking.cancellation.outcome === "deposit_forfeited" ? "Deposit forfeited to the musician." : "Deposit refunded."}
                {booking.cancellation.markApplied ? " A late-cancellation mark was recorded." : ""}
              </p>
            </div>
          )}
          {booking.status === "completed" && <p style={{ color: "#666" }}>This booking is complete.</p>}
        </section>
      )}
    </div>
  );
}
