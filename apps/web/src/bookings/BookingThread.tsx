"use client";
import { useEffect, useState } from "react";
import { collection, doc, getDoc, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { formatGigDateTime, formatCents, BUDGET_STRUCTURE_LABEL } from "../gigs/GigForms";
import { formatDuration, type OfferPayload } from "./BookingForms";
import { bookingHistoryLabel, depositLine, CounterpartyLine } from "./BookingInbox";
import { OfferForm } from "./OfferForm";
import { CancelDialog } from "./CancelDialog";
import { GatePrompt } from "../payments/GatePrompt";
import {
  computeExpectedTotalCents, computeDepositCents, MAX_BOOKING_THREAD_ENTRIES, MAX_CANCEL_REASON_LENGTH,
  NO_SHOW_REPORT_WINDOW_DAYS, CURATOR_FORFEIT_WINDOW_HOURS, MUSICIAN_MARK_WINDOW_HOURS,
  DEPOSIT_PERCENT, CANCEL_GRACE_MS, THREAD_FULL_MESSAGE, depositChargePreviewCents,
  type BookingRequestDoc, type BookingSide, type GigDoc,
} from "@gatekeep/shared";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Card, CardContent } from "../ui/card";
import { Textarea } from "../ui/textarea";
import { Skeleton } from "../ui/skeleton";
import { IconWarning } from "../ui/icons";

export type Role = "musician" | "curator" | "both" | "none" | "loading";
export type Occurrence = { id: string; startsAt: number; durationMinutes: number };

function ErrorBox({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
    >
      <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}

// Loading skeleton (task 11 addition): this screen's own initial "loading"
// state used to render a bare "Loading…" paragraph; every other async
// surface in the app gets a content-shaped skeleton instead (spec section
// 4). Shape mirrors the chat thread this becomes below it: a header line
// plus a couple of alternating bubbles, without claiming any real data.
function ThreadSkeleton() {
  return (
    <div className="grid gap-6" role="status" aria-label="Loading booking">
      <div className="grid gap-2">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
      </div>
      <div className="grid gap-3">
        <div className="flex justify-start">
          <Skeleton className="h-20 w-2/3 max-w-sm" />
        </div>
        <div className="flex justify-end">
          <Skeleton className="h-20 w-2/3 max-w-sm" />
        </div>
      </div>
    </div>
  );
}

// A render-safe "now": eslint-config-next's React Compiler rules
// (react-hooks/purity) forbid calling the impure `Date.now()` directly
// inside a component's render body ("can produce unstable results that
// update unpredictably when the component happens to re-render"); the fix
// is the same shape as any other async-derived state: defer the actual
// read to an effect (which runs AFTER render, not during it). Every
// render-time "is this occurrence in the future" / "how many hours until
// the gig" / "how many days since the gig" computation in this file and
// CancelDialog.tsx goes through this rather than a bare `Date.now()` call.
// Not a field-group (BookingForms.tsx) or inbox concern (BookingInbox.tsx):
// lives here, its originating/primary consumer; CancelDialog imports it
// from here too (Task 10 review).
//
// Ticks on mount AND every 30s afterward (Task 10 review): a "now" frozen
// at mount time would otherwise never grow, so e.g. the completed-view
// no-show report button could stay hidden past the moment it should appear
// (a report window boundary crossed) or a per-date cancel button could stay
// visible past a date's start, for as long as this screen is left open.
// Both the initial and periodic reads happen inside a setTimeout/setInterval
// CALLBACK, not synchronously at the top of the effect body: the latter is
// what eslint-config-next's react-hooks/set-state-in-effect rule flags
// ("calling setState synchronously within an effect can trigger cascading
// renders"; its own message names the fix as calling setState "in a
// callback function when external state changes").
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

// Resolves which side(s) `uid` belongs to for this booking's two profiles:
// mirrors bookings.ts's requireBookingSide (musician-first on a dual
// member) for DISPLAY purposes only; the server independently re-derives
// and enforces the real authorization on every callable. Each membership
// GET is resolved independently (own .catch -> false) rather than a single
// Promise.all().catch(): a permission-denied on the side you're NOT a
// member of is a legitimate, expected outcome (see firestore.rules'
// members `allow get` rule), and must not swallow the OTHER side's
// successful result.
// Exported (Task 15) so PaymentsPanel.tsx can resolve the same viewer-side
// role for the SAME booking without a second, subtly-divergent copy of this
// membership-resolution logic.
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

// The booking's initiating gig: permission-tolerant (see BookingInbox.tsx's
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

// Every currently-linked, still-"filled" occurrence of this booking: see
// BookingInbox.tsx's useNextOccurrence for why status=="filled" is pinned
// in addition to bookingId (rules list-provability, not just a display
// filter) and why this reuses the (bookingId,status,startsAt) index rather
// than needing a new one. Populated for BOTH single-gig and whole-run
// bookings (a single-gig booking's own gig also carries bookingId while
// filled); the render below only shows the full per-date list once
// seriesId != null, but the single-gig "next date" summary reuses the same
// query rather than a second, separate fetch. Past FILLED gigs deliberately
// stay "filled" forever (Task 8's review), so this list, and its LAST
// entry in particular, is also what the completed-view no-show report
// window below is computed from.
// Exported (Task 15): PaymentsPanel.tsx/TrueUpForm.tsx need an occurrence's
// OWN durationMinutes for the settlement/true-up preview math, and this is
// the one query that already resolves it correctly (see the comment above).
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

// Open dates of a whole-run series, live (sp4 audit findings 2 and 8): the
// count both the run notice and the accept preview render. Public-provable
// (seriesId and status are equality pins; "open" is the public disjunct of
// the gigs read rule), no membership needed, so either side can read it.
// Null while loading or when the query fails; the accept confirm stays
// disabled on null so a whole-run charge is never confirmed blind.
export function useOpenRunDates(seriesId: string | null): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!seriesId) return;
    const { db } = getFirebase();
    const unsub = onSnapshot(
      query(collection(db, "gigs"), where("seriesId", "==", seriesId), where("status", "==", "open")),
      (snap) => setCount(snap.size),
      () => setCount(null));
    return () => { unsub(); };
  }, [seriesId]);
  return seriesId ? count : null;
}

// Chat-style thread (sub-project 9A task 11, owner-locked per spec 6.7):
// every offer/counter in the thread renders as a message bubble, own side
// right and ember-tinted, other side left and solid, exactly the same
// entries and data the plain-list version rendered before this restyle:
// only the shape changed.
function ThreadHistory({ thread, structure, mySide, lastEntryTotalCents }: {
  thread: BookingRequestDoc["thread"];
  structure: BookingRequestDoc["structure"];
  // null in the "none"-role (observer) branch below: there's no "my side"
  // to distinguish for a viewer who's a member of neither profile, so every
  // bubble renders on the left as a neutral, solid surface there.
  mySide: BookingSide | null;
  // The CURRENT (last) entry's real expected total, when one is known: see
  // this file's own derivation next to `preview` below (booking.acceptedTerms
  // once the booking has been accepted, a real, already-frozen number, or
  // else the same live accept-preview math this screen already computes for
  // the accept-confirm block). Every earlier, superseded entry's bubble
  // shows structure + amount only, exactly like the plain-list version did.
  lastEntryTotalCents: number | null;
}) {
  return (
    <section className="grid gap-3">
      <h2 className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-syne text-lg font-semibold text-gk-text">
        Offer history
        <span className="font-sora text-xs font-normal text-gk-muted">
          thread {thread.length}/{MAX_BOOKING_THREAD_ENTRIES}
        </span>
      </h2>
      <div className="grid gap-3">
        {thread.map((entry, i) => {
          const isCurrent = i === thread.length - 1;
          const isMine = mySide != null && entry.by === mySide;
          return (
            <div key={`${i}-${entry.at}`} className={cn("flex", isMine ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "grid max-w-[85%] gap-2 rounded-gk border p-3.5 sm:max-w-[70%]",
                  // Review round 1: /50 border opacity, not a new /30 value.
                  // This is the SAME accent-border opacity GigCard's hover,
                  // BookingInbox's SolidRow hover, and DateBlockRow's
                  // ConfirmedRow override already established product-wide,
                  // rather than a fourth, unexplained opacity figure.
                  isMine ? "border-gk-accent/50 bg-gk-accent/14" : "border-gk-border bg-gk-surface",
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-sora text-xs font-medium text-gk-muted">
                    {entry.by === "musician" ? "Musician" : "Curator"}
                  </span>
                  {/* Review round 1 (accent dosage): variant="secondary", not
                      "default" (ember). DESIGN.md's "one deliberate accent"
                      rule reserves the fill for the single most important
                      thing on screen, and on this screen that's the Accept
                      button below, not a marker on a bubble that can appear
                      on EITHER side (including "mine", which is already
                      ember-tinted): a second, unrelated ember use here
                      would dose the accent past its budget. */}
                  {isCurrent && <Badge variant="secondary">current offer</Badge>}
                </div>
                {/* Structured money-term card (spec 6.7): structure + amount
                    (+ song count for perSong), and, only on the current
                    entry, the expected total: see lastEntryTotalCents'
                    own comment above for exactly where that number comes
                    from. */}
                {/* bg-gk-page is a gradient token (flat only in light theme)
                    and is excluded from Tailwind's color mapping per
                    DESIGN.md, so `bg-gk-page/*` compiles to no background at
                    all. bg-gk-border/25 is the same neutral wash this file's
                    own DateBlockRow hover override and AppShell's row hovers
                    already use, and it reads as a recessed nested surface
                    against BOTH bubble backgrounds (the ember tint and the
                    plain gk-surface). */}
                <div className="grid gap-0.5 rounded-gk-sm border border-gk-border/60 bg-gk-border/25 px-3 py-2">
                  <p className="font-syne text-base font-bold text-gk-text">
                    {formatCents(entry.amountCents)}{" "}
                    <span className="font-sora text-sm font-normal text-gk-muted">{BUDGET_STRUCTURE_LABEL[structure]}</span>
                    {structure === "perSong" && entry.expectedQuantity != null ? ` × ${entry.expectedQuantity} songs` : ""}
                  </p>
                  {isCurrent && lastEntryTotalCents != null && (
                    <p className="font-sora text-xs text-gk-muted">Expected total: {formatCents(lastEntryTotalCents)}</p>
                  )}
                </div>
                {entry.note && <p className="font-sora text-sm text-gk-text">{entry.note}</p>}
                <p className="font-sora text-xs text-gk-muted">{formatGigDateTime(entry.at)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// The booking thread screen's content: mounted by
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
  // Hooks run unconditionally, every render, in the same order; the early
  // returns below happen AFTER all four are called.
  const role = useRole(musicianProfileId, curatorProfileId, uid);
  const gig = useGig(gigId);
  const occurrences = useOccurrences(bookingId);
  // Render-safe "now": see useNow's comment above.
  const now = useNow();
  const openRunDates = useOpenRunDates(booking !== "loading" && booking !== "unavailable" && booking ? booking.seriesId : null);

  if (booking === "loading" || role === "loading") return <ThreadSkeleton />;
  if (booking === "unavailable" || !booking) {
    return (
      <p className="flex items-start gap-2 font-sora text-sm text-gk-muted">
        <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        You don&apos;t have access to this booking, or it doesn&apos;t exist.
      </p>
    );
  }
  if (role === "none") {
    // Reachable only for an admin (bookings/{id}'s own read rule also
    // allows isAdmin()): a stranger to both profiles can't read the
    // booking doc at all, so `booking` would already be "unavailable".
    return (
      <div className="grid gap-4">
        <p className="font-sora text-sm text-gk-muted">
          Viewing as an observer. You&apos;re not a member of either side, so actions here are unavailable.
        </p>
        <ThreadHistory
          thread={booking.thread} structure={booking.structure} mySide={null}
          lastEntryTotalCents={booking.acceptedTerms?.expectedTotalCents ?? null}
        />
      </div>
    );
  }

  const bothSides = role === "both";
  // The server resolves an ambiguous (both-sides) actor as "musician" for
  // every NEGOTIATION callable (bookings.ts's requireBookingSide checks
  // musician first): mirrored here so the action bar reflects what will
  // actually happen server-side. cancelBooking/cancelOccurrence/
  // reportNoShow instead REFUSE outright for a dual member
  // (resolveBookingSideStrict); those actions are disabled below instead,
  // per the recorded ruling (Task 4/6).
  const mySide: BookingSide = bothSides ? "musician" : (role as BookingSide);
  // Distinct from `mySide` on purpose: `mySide` force-resolves a both-sides
  // member to "musician" for the NEGOTIATION action bar (matching what the
  // server will actually do), which would wrongly HIDE the curator-only
  // cancel/report controls for a both-sides member entirely (rather than
  // showing them disabled, as the banner below promises) if used to gate
  // their visibility too. `isCuratorSide` answers "is this profile
  // genuinely on the curator side at all": true for both "curator" and
  // "both", and is what the report-a-no-show visibility checks use;
  // `bothSides` alone still gates whether the button is actually clickable.
  const isCuratorSide = role === "curator" || bothSides;

  const lastEntry = booking.thread[booking.thread.length - 1];
  // sp4 audit finding 16: counterBooking refuses at the cap with
  // resource-exhausted; the button is disabled with the reason shown, while
  // accept, decline, and withdraw stay available exactly as the server allows.
  const threadFull = booking.thread.length >= MAX_BOOKING_THREAD_ENTRIES;
  // Accept-preview total/deposit: pure derivation, recomputed every render
  // from the CURRENT last thread entry + the live gig's durationMinutes,
  // exactly mirroring acceptBooking's own freeze-from-last-entry math
  // (bookings.ts). null while the gig hasn't loaded (or is unavailable):
  // the confirm button stays disabled in that case rather than showing a
  // wrong number.
  const preview = (gig === "loading" || gig === "unavailable" || gig === null) ? null : (() => {
    const expectedTotalCents = computeExpectedTotalCents(booking.structure, lastEntry.amountCents, {
      durationMinutes: gig.durationMinutes, songCount: lastEntry.expectedQuantity ?? undefined,
    });
    return {
      expectedTotalCents, depositAmountCents: computeDepositCents(expectedTotalCents),
      // SP5 Task 15: "Due now" fee transparency, the same preview math the
      // Earnings page's other fee previews use (fees.ts), never the server's
      // source of truth (invariant #1: acceptBooking recomputes every cent
      // independently from the frozen thread entry it commits).
      chargePreview: depositChargePreviewCents(expectedTotalCents),
    };
  })();
  // Chat-bubble money card (task 11, spec 6.7): the CURRENT (last) thread
  // entry's real expected total, when one is known: booking.acceptedTerms
  // once accepted (an already-frozen number), otherwise the same live
  // accept-preview total computed above. Neither value is new math: this
  // only hands an already-derived number down to ThreadHistory for display.
  //
  // Controller ruling (review round 1): gated to `booking.status === "open"`
  // (still negotiating, so `preview` above is a legitimate CURRENT figure)
  // OR a real `acceptedTerms` (a frozen, authoritative number). A declined/
  // withdrawn/superseded/expired booking has neither: negotiation is dead,
  // and `preview` would still recompute a number off the CURRENT gig's
  // durationMinutes, which can have drifted since that dead negotiation
  // ended, so showing it there would be a stale figure presented as live.
  // Display-only gate: does not touch `preview`'s own derivation, any
  // handler, callable, or query, only which of its outputs this screen is
  // willing to show on the bubble.
  const lastEntryTotalCents = (booking.status === "open" || booking.acceptedTerms != null)
    ? (booking.acceptedTerms?.expectedTotalCents ?? preview?.expectedTotalCents ?? null)
    : null;
  // SP5 Task 15 review round 1: "1-hour" derived from the actual shared
  // constant rather than a hardcoded literal that could drift from it if
  // CANCEL_GRACE_MS ever changes. CANCEL_GRACE_MS is exactly 3_600_000 today,
  // so this is "1": the arithmetic (not the literal) is what's load-bearing.
  const graceHours = CANCEL_GRACE_MS / 3_600_000;
  // SP5 Task 15 review round 1: side-appropriate flash window. A CURATOR
  // accepting within their own 72h forfeit window is warned about forfeiture
  // risk; a MUSICIAN accepting within their own 24h no-show-mark window
  // (MUSICIAN_MARK_WINDOW_HOURS, same constant CancelDialog's own warning
  // uses) is warned about that instead. Computed off the live gig's own
  // startsAt (occurrences[] is empty pre-accept: no "filled" gig exists yet
  // for THIS booking until acceptBooking materializes one).
  const flashWindowHours = mySide === "curator" ? CURATOR_FORFEIT_WINDOW_HOURS : MUSICIAN_MARK_WINDOW_HOURS;
  const startsSoonFlash = now != null && gig !== "loading" && gig !== "unavailable" && gig != null
    && (gig.startsAt - now) < flashWindowHours * 3_600_000;

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
  const decline = async () => {
    if (!window.confirm("Decline this booking request?")) return;
    setActionBusy("decline"); setActionError(null);
    try {
      await callFn("declineBooking", { bookingId });
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
      await callFn("withdrawBooking", { bookingId });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not withdraw.");
    } finally {
      setActionBusy(null);
    }
  };
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
      // verbatim, server copy: "A no-show has already been reported for
      // this booking." No client-side "already reported" special-case
      // needed; the friendly-wrapper pattern this whole app uses already
      // reads correctly as-is.
      await callFn("reportNoShow", { bookingId, reason: trimmed });
      setShowReportForm(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not report a no-show.");
    } finally {
      setActionBusy(null);
    }
  };

  const gigTitle = gig !== "loading" && gig !== "unavailable" && gig ? (gig.title || "Untitled gig") : "This gig";
  // Earliest occurrence overall (past or future): used only for the
  // single-gig "confirmed" summary's date display.
  const displayOccurrence = occurrences.length > 0 ? occurrences[0] : null;
  // Latest occurrence overall: the one a COMPLETED booking's report window
  // is computed against (mirrors reportNoShow's own server-side "most
  // recent past occurrence", see bookingLifecycle.ts's pastSnap query;
  // every occurrence here is already in the past by the time a booking has
  // reached "completed", so the latest IS the most recent past one).
  const lastOccurrence = occurrences.length > 0 ? occurrences[occurrences.length - 1] : null;
  // Earliest FUTURE occurrence: the one cancelBooking's window math is
  // computed against server-side (executeCancellation's "next affected
  // occurrence"); the top-level Cancel button is hidden without one (there's
  // nothing left to cancel, matches the server's own NO_UPCOMING_DATES/
  // ALREADY_STARTED refusals rather than surfacing them as a clicked error).
  const cancelTarget = now == null ? null : (occurrences.find((o) => o.startsAt > now) ?? null);
  const hasStartedOccurrence = now != null && occurrences.some((o) => o.startsAt <= now);
  // Completed-view "report a no-show": the PRIMARY real-world flow. The
  // daily sweep (scheduled.ts step 7) completes a booking once its last
  // occurrence ends, typically well before the curator gets a chance to
  // report anything while the booking is still "confirmed". Client-computed
  // from the same occurrence query already run above and the same
  // NO_SHOW_REPORT_WINDOW_DAYS constant reportNoShow's own server-side
  // window check uses: the server independently re-validates this at
  // submit time regardless.
  const daysSinceLastOccurrence = (now != null && lastOccurrence != null) ? (now - lastOccurrence.startsAt) / (24 * 3_600_000) : null;
  const canReportInCompleted = daysSinceLastOccurrence != null && daysSinceLastOccurrence <= NO_SHOW_REPORT_WINDOW_DAYS;

  // Shared by the "confirmed" (post-start, run still ongoing) and
  // "completed" (the primary flow, see canReportInCompleted's comment)
  // report-a-no-show surfaces: same form, same busy/error state, just a
  // different visibility gate per status. Visible but DISABLED for a
  // both-sides member (not hidden): matches the ambiguity banner's own
  // promise ("cancellation and no-show reporting are disabled here").
  const reportNoShowBlock = (
    <div className="grid gap-2.5 border-t border-gk-border pt-4">
      {showReportForm ? (
        <div className="grid gap-2.5">
          <Textarea rows={3} maxLength={MAX_CANCEL_REASON_LENGTH} value={reportReason}
            onChange={(e) => setReportReason(e.target.value)} placeholder="What happened?" disabled={actionBusy !== null}
            aria-label="No-show report reason" />
          <p className="font-sora text-xs text-gk-muted">{reportReason.length}/{MAX_CANCEL_REASON_LENGTH}</p>
          {actionError && <ErrorBox message={actionError} />}
          <div className="flex gap-2">
            <Button onClick={reportNoShow} disabled={actionBusy !== null} variant="destructive">
              {actionBusy === "reportNoShow" ? "Reporting…" : "Submit report"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => { setShowReportForm(false); setActionError(null); }} disabled={actionBusy !== null}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => setShowReportForm(true)} disabled={bothSides}
          title={bothSides ? "Disabled: you're on both sides of this booking" : undefined}
          variant="secondary" className="w-fit text-gk-destructive">
          Report a no-show
        </Button>
      )}
    </div>
  );

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="font-syne text-2xl font-extrabold text-gk-text sm:text-3xl">{gigTitle}</h1>
        <p className="font-sora text-sm text-gk-muted">
          {BUDGET_STRUCTURE_LABEL[booking.structure]} · Status: {booking.status.replace(/_/g, " ")}
        </p>
        <CounterpartyLine musicianProfileId={booking.musicianProfileId} curatorProfileId={booking.curatorProfileId} mySide={mySide} />
      </div>

      {bothSides && (
        <p className="rounded-gk border border-gk-border bg-gk-surface px-3.5 py-2.5 font-sora text-sm text-gk-text">
          You&apos;re on both sides of this booking. Negotiation actions (accept/counter/decline/withdraw) still work (the
          server treats you as the musician side), but cancellation and no-show reporting are disabled here to avoid an
          ambiguous, self-favoring choice.
        </p>
      )}

      <ThreadHistory
        thread={booking.thread} structure={booking.structure} mySide={mySide}
        lastEntryTotalCents={lastEntryTotalCents}
      />

      {booking.status === "open" && (
        <section className="grid gap-3 border-t border-gk-border pt-5">
          <h2 className="font-syne text-lg font-semibold text-gk-text">Respond</h2>
          {booking.seriesId != null && (
            <p className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
              <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                Books as a run: accepting covers every open date of this series
                {openRunDates != null ? ` (${openRunDates} open right now)` : ""} plus any date added later.
                Deposits, settlement, and cancellations are per date.
              </span>
            </p>
          )}
          {showCounterForm ? (
            <OfferForm structure={booking.structure} busy={actionBusy === "counter"} error={actionError}
              onSubmit={counter} onCancel={() => { setShowCounterForm(false); setActionError(null); }} />
          ) : booking.awaitingSide !== mySide ? (
            <div className="grid gap-2.5">
              <p className="font-sora text-sm text-gk-muted">Waiting on the other side to respond.</p>
              <Button onClick={withdraw} disabled={actionBusy !== null} variant="secondary" className="w-fit">
                {actionBusy === "withdraw" ? "Withdrawing…" : "Withdraw"}
              </Button>
              {actionError && <ErrorBox message={actionError} />}
            </div>
          ) : (
            <div className="grid gap-3">
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setShowAcceptConfirm(true)} disabled={actionBusy !== null}>
                  Accept {formatCents(lastEntry.amountCents)}
                </Button>
                <Button onClick={() => setShowCounterForm(true)} disabled={actionBusy !== null || threadFull}
                  title={threadFull ? THREAD_FULL_MESSAGE : undefined} variant="secondary">Counter…</Button>
                <Button onClick={decline} disabled={actionBusy !== null} variant="ghost">
                  {actionBusy === "decline" ? "Declining…" : "Decline"}
                </Button>
              </div>
              {threadFull && <p className="font-sora text-xs text-gk-muted">{THREAD_FULL_MESSAGE}</p>}
              {actionError && (
                <GatePrompt message={actionError} curatorProfileId={booking.curatorProfileId}
                  viewerIsMusician={mySide === "musician"} onRetry={accept} />
              )}
              {showAcceptConfirm && (
                // Accept-confirm block restyled as a solid card (spec 6.7):
                // gk-surface + gk-border, the same flat elevation every other
                // card in the system uses, not a colored/ember callout.
                <Card className="p-4">
                  <CardContent className="grid gap-2.5 p-0">
                    <p className="font-syne text-base font-semibold text-gk-text">Confirm accept</p>
                    {preview ? (
                      <>
                        <p className="font-sora text-sm text-gk-text">Total: {formatCents(preview.expectedTotalCents)}</p>
                        {/* SP5 Task 15 review round 1 (medium #4): the "Due now"
                            breakdown is CURATOR money, only the curator side
                            sees the actual figures; a musician-side accepter
                            gets a neutral line instead (the charge lands on the
                            CURATOR's card regardless of who clicks accept). */}
                        {mySide === "curator" ? (
                          <>
                            <p className="font-sora text-sm text-gk-muted">
                              {booking.seriesId != null ? "Per date: " : "Due now: "}{formatCents(preview.chargePreview.totalCents)}{" "}
                              ({formatCents(preview.chargePreview.sliceCents)} deposit{" + "}
                              {formatCents(preview.chargePreview.feeCents)} service fee)
                            </p>
                            {/* sp4 audit finding 8: the run total comes from the
                                live open-dates query, not occurrences[] (which
                                is empty pre-accept). Confirm stays disabled
                                until the count is known. */}
                            {booking.seriesId != null && (openRunDates == null ? (
                              <p className="font-sora text-sm text-gk-muted">Counting the run&apos;s open dates…</p>
                            ) : (
                              <p className="font-sora text-sm font-medium text-gk-text">
                                {openRunDates} date{openRunDates === 1 ? "" : "s"}, {formatCents(preview.chargePreview.totalCents * openRunDates)} due now.
                              </p>
                            ))}
                            <p className="font-sora text-sm text-gk-muted">
                              Remaining {100 - DEPOSIT_PERCENT}% + fee auto-charges after each date.
                            </p>
                          </>
                        ) : (
                          <p className="font-sora text-sm text-gk-muted">
                            The curator&apos;s card is charged the deposit{booking.seriesId != null ? " for every open date" : ""} when you accept.
                          </p>
                        )}
                        {startsSoonFlash && (
                          <p className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
                            <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                            {mySide === "curator"
                              ? `This booking starts soon. Once accepted it's final after a ${graceHours}-hour grace period (cancelling later forfeits your deposit).`
                              : `This booking starts soon. Once accepted it's final after a ${graceHours}-hour grace period (cancelling less than ${MUSICIAN_MARK_WINDOW_HOURS}h out adds a reliability mark).`}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="flex items-start gap-2 font-sora text-sm text-gk-warning">
                        <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                        Couldn&apos;t load this gig&apos;s details to preview the total right now. Try again shortly.
                      </p>
                    )}
                    <div className="flex gap-2">
                      <Button onClick={accept} disabled={actionBusy !== null || !preview || (booking.seriesId != null && openRunDates == null)}>
                        {actionBusy === "accept" ? "Accepting…" : "Confirm accept"}
                      </Button>
                      <Button type="button" variant="secondary" onClick={() => setShowAcceptConfirm(false)} disabled={actionBusy !== null}>Back</Button>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </section>
      )}

      {booking.status === "confirmed" && (
        <section className="grid gap-3 border-t border-gk-border pt-5">
          <h2 className="font-syne text-lg font-semibold text-gk-text">Confirmed</h2>
          {booking.acceptedTerms && (
            <p className="font-sora text-sm text-gk-text">
              Terms: {formatCents(booking.acceptedTerms.amountCents)} {BUDGET_STRUCTURE_LABEL[booking.structure]}
              {", total "}{formatCents(booking.acceptedTerms.expectedTotalCents)}
            </p>
          )}
          {booking.deposit && <p className="font-sora text-sm text-gk-muted">{depositLine(booking.deposit.amountCents)}</p>}
          {booking.seriesId == null && displayOccurrence && (
            <p className="font-sora text-sm text-gk-text">
              {formatGigDateTime(displayOccurrence.startsAt)} ({formatDuration(displayOccurrence.durationMinutes)})
            </p>
          )}

          {booking.seriesId != null && (
            <div className="grid gap-2">
              <h3 className="font-syne text-sm font-semibold text-gk-text">Dates</h3>
              {occurrences.length === 0 ? (
                <p className="font-sora text-sm text-gk-muted">No dates of this run remain booked.</p>
              ) : (
                <ul className="grid gap-2">
                  {occurrences.map((o) => {
                    const isFuture = now != null && o.startsAt > now;
                    return (
                      <li
                        key={o.id}
                        className="flex items-center gap-2 rounded-gk-sm border border-gk-border bg-gk-surface px-3 py-2"
                      >
                        <span className="font-sora text-sm text-gk-text">
                          {formatGigDateTime(o.startsAt)} ({formatDuration(o.durationMinutes)})
                        </span>
                        {isFuture && (
                          // Visible but disabled for a both-sides member (not hidden): the
                          // ambiguity notice above already explains why; per-action disabling
                          // is the binding shape for cancel/report, unlike negotiation actions.
                          <Button
                            onClick={() => setShowCancelFor({ mode: "occurrence", gigId: o.id, startsAt: o.startsAt })}
                            disabled={bothSides || actionBusy !== null} title={bothSides ? "Disabled: you're on both sides of this booking" : undefined}
                            variant="link" size="sm" className="ml-auto h-auto p-0 text-gk-destructive">
                            Cancel this date
                          </Button>
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
              depositAmountCents={booking.deposit?.amountCents} confirmedAt={booking.confirmedAt} mode={showCancelFor.mode}
              onClose={() => setShowCancelFor(null)} onDone={() => setShowCancelFor(null)} />
          ) : (
            cancelTarget && (
              <Button onClick={() => setShowCancelFor({ mode: "booking", startsAt: cancelTarget.startsAt })}
                disabled={bothSides || actionBusy !== null} title={bothSides ? "Disabled: you're on both sides of this booking" : undefined}
                variant="secondary" className="w-fit text-gk-destructive">
                Cancel this booking
              </Button>
            )
          )}

          {isCuratorSide && hasStartedOccurrence && reportNoShowBlock}
        </section>
      )}

      {booking.status !== "open" && booking.status !== "confirmed" && (
        <section className="grid gap-3 border-t border-gk-border pt-5">
          <h2 className="font-syne text-lg font-semibold text-gk-text">{bookingHistoryLabel(booking)}</h2>
          {(booking.status === "cancelled_by_curator" || booking.status === "cancelled_by_musician") && booking.cancellation && (
            <Card className="p-4">
              <CardContent className="grid gap-1.5 p-0">
                <p className="font-sora text-sm text-gk-text">
                  Cancelled by the {booking.cancellation.by} side on {formatGigDateTime(booking.cancellation.at)}.
                </p>
                <p className="font-sora text-sm text-gk-muted">Reason: {booking.cancellation.reason}</p>
                <p className="font-sora text-sm text-gk-muted">
                  {booking.cancellation.outcome === "deposit_forfeited" ? "Deposit forfeited to the musician." : "Deposit refunded."}
                  {booking.cancellation.markApplied ? (
                    // reportNoShow always produces hoursBeforeStart <= 0 (the
                    // occurrence had already started when reported); a
                    // genuine LATE-but-before-start cancellation (cancelBooking
                    // /cancelOccurrence's musician-side <24h path) always has
                    // hoursBeforeStart > 0: the sign reliably tells the two
                    // apart without a dedicated field, since only one of these
                    // two callables can ever produce a negative value.
                    <> {booking.cancellation.hoursBeforeStart <= 0 ? "A reliability mark was recorded." : "A late-cancellation mark was recorded."}</>
                  ) : ""}
                </p>
              </CardContent>
            </Card>
          )}
          {booking.status === "completed" && (
            <>
              <p className="font-sora text-sm text-gk-muted">This booking is complete.</p>
              {isCuratorSide && canReportInCompleted && reportNoShowBlock}
            </>
          )}
        </section>
      )}
    </div>
  );
}
