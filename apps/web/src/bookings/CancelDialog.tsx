"use client";
import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { formatCents } from "../gigs/GigForms";
// useNow lives in BookingThread.tsx (its primary/originating consumer, and
// not a field-group — see BookingForms.tsx's Task 10 review comment); this
// is a same-directory sibling import, not a package boundary, and useNow is
// only ever CALLED from within a component body (never referenced at
// either module's top level), so the resulting circular import (BookingThread
// -> CancelDialog -> BookingThread) resolves cleanly the same way any two
// mutually-referencing function declarations do.
import { useNow } from "./BookingThread";
import {
  CURATOR_FORFEIT_WINDOW_HOURS, MUSICIAN_MARK_WINDOW_HOURS, MAX_CANCEL_REASON_LENGTH, CANCEL_GRACE_MS,
  type BookingSide,
} from "@gatekeep/shared";

// Shared cancel UI for both cancelBooking (mode "booking" — the whole
// booking/run) and cancelOccurrence (mode "occurrence" — one date of a
// whole-run booking; "same dialog semantics per-date" per the task brief).
// The live window warning is computed CLIENT-SIDE from the same shared
// constants the server's executeCancellation/cancelOccurrence windows use
// (CURATOR_FORFEIT_WINDOW_HOURS/MUSICIAN_MARK_WINDOW_HOURS) — it's advisory
// only (the server independently recomputes hoursBeforeStart at commit time
// from ITS OWN `now`, which is authoritative; a few seconds of client/server
// clock drift near the exact boundary is accepted, same as the server's own
// "captured once" `now` rationale in bookingLifecycle.ts).
export function CancelDialog({ bookingId, gigId, side, startsAt, depositAmountCents, confirmedAt, mode, onClose, onDone }: {
  bookingId: string;
  gigId?: string; // required when mode === "occurrence" (cancelOccurrence's target date)
  side: BookingSide; // caller's resolved side — musician-first when a viewer is on both (see BookingThread)
  startsAt: number; // the relevant occurrence's startsAt, for the window math below
  depositAmountCents?: number; // known only once a booking is confirmed — omitted shows the neutral copy without a $ figure
  // SP5 Task 15 (Task 7 review carry-forward): the booking's accept timestamp
  // — when set and within CANCEL_GRACE_MS of "now", the 1h post-accept grace
  // neutralizes EITHER side's penalty regardless of the window math below.
  // Omitted/null shows the ordinary window-based warning (pre-SP5 bookings,
  // or a caller that hasn't loaded it yet).
  confirmedAt?: number | null;
  mode: "booking" | "occurrence";
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Render-safe "now" — see BookingThread.tsx's useNow comment (the React
  // Compiler's purity rule forbids a bare Date.now() call during render).
  const now = useNow();

  const hoursBeforeStart = now == null ? null : (startsAt - now) / 3_600_000;
  const hoursLabel = hoursBeforeStart == null ? null : Math.max(0, Math.round(hoursBeforeStart));
  const depositRef = depositAmountCents != null ? ` (${formatCents(depositAmountCents)})` : "";
  // Advisory only — the server independently recomputes the grace window (and
  // hoursBeforeStart) at commit time from ITS OWN `now`, which is
  // authoritative; a few seconds of client/server clock drift near either
  // boundary is accepted, same as the window warning below already does.
  const inGracePeriod = now != null && confirmedAt != null && (now - confirmedAt) < CANCEL_GRACE_MS;
  // SP5 Task 15 review round 1: derived from the actual constant (not a
  // hardcoded "1-hour" literal) — see BookingThread.tsx's identical graceHours
  // derivation for the same rationale.
  const graceHours = CANCEL_GRACE_MS / 3_600_000;
  const warning = hoursBeforeStart == null ? "Checking the cancellation window…"
    : inGracePeriod
      // Review round 1 fix: the branch below (the ONLY other warning text
      // this dialog ever shows) never renders alongside this one — there is
      // no "window below" for this sentence to dangle a reference to.
      ? `You're within the ${graceHours}-hour grace period after accepting — cancelling now is penalty-free, regardless of the usual cancellation window.`
      : side === "curator"
    ? (hoursBeforeStart < CURATOR_FORFEIT_WINDOW_HOURS
        ? `Cancelling now forfeits your deposit${depositRef} — the gig is in ${hoursLabel}h.`
        : `Cancelling now refunds your deposit${depositRef} — this is outside the ${CURATOR_FORFEIT_WINDOW_HOURS}h forfeiture window.`)
    : (hoursBeforeStart < MUSICIAN_MARK_WINDOW_HOURS
        ? "This will add a no-show mark to your reliability record — the gig is less than 24 hours away."
        : "Cancelling now — the curator's deposit will be refunded, and no reliability mark will be applied.");

  const submit = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_CANCEL_REASON_LENGTH) {
      setError(`Reason must be 1-${MAX_CANCEL_REASON_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "booking") {
        await httpsCallable(getFirebase().functions, "cancelBooking")({ bookingId, reason: trimmed });
      } else {
        await httpsCallable(getFirebase().functions, "cancelOccurrence")({ bookingId, gigId, reason: trimmed });
      }
      onDone();
    } catch (e) {
      // Verbatim server error in a friendly wrapper — the same pattern used
      // throughout the app's other composers (ApplyPanel, OfferComposer).
      setError(e instanceof Error ? e.message : "Could not cancel.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ border: "1px solid #fca5a5", borderRadius: 8, padding: 12, display: "grid", gap: 10, background: "#fef2f2" }}>
      <p style={{ margin: 0, fontWeight: 600 }}>{mode === "booking" ? "Cancel this booking" : "Cancel this date"}</p>
      <p style={{ margin: 0, color: "#92400e" }}>{warning}</p>
      <div>
        <textarea rows={3} maxLength={MAX_CANCEL_REASON_LENGTH} value={reason} disabled={busy}
          onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" aria-label="Cancellation reason"
          style={{ width: "100%" }} />
        <p style={{ margin: "2px 0 0", fontSize: 12, color: "#666" }}>{reason.length}/{MAX_CANCEL_REASON_LENGTH}</p>
      </div>
      {error && (
        <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={submit} disabled={busy} style={{ color: "#dc2626" }}>
          {busy ? "Cancelling…" : "Confirm cancellation"}
        </button>
        <button type="button" onClick={onClose} disabled={busy}>Back</button>
      </div>
    </div>
  );
}
