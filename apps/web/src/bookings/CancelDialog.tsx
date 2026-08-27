"use client";
import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { formatCents } from "../gigs/GigForms";
import { useNow } from "./BookingForms";
import {
  CURATOR_FORFEIT_WINDOW_HOURS, MUSICIAN_MARK_WINDOW_HOURS, MAX_CANCEL_REASON_LENGTH,
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
export function CancelDialog({ bookingId, gigId, side, startsAt, depositAmountCents, mode, onClose, onDone }: {
  bookingId: string;
  gigId?: string; // required when mode === "occurrence" (cancelOccurrence's target date)
  side: BookingSide; // caller's resolved side — musician-first when a viewer is on both (see BookingThread)
  startsAt: number; // the relevant occurrence's startsAt, for the window math below
  depositAmountCents?: number; // known only once a booking is confirmed — omitted shows the neutral copy without a $ figure
  mode: "booking" | "occurrence";
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Render-safe "now" — see BookingForms.tsx's useNow comment (the React
  // Compiler's purity rule forbids a bare Date.now() call during render).
  const now = useNow();

  const hoursBeforeStart = now == null ? null : (startsAt - now) / 3_600_000;
  const hoursLabel = hoursBeforeStart == null ? null : Math.max(0, Math.round(hoursBeforeStart));
  const depositRef = depositAmountCents != null ? ` (${formatCents(depositAmountCents)})` : "";
  const warning = hoursBeforeStart == null ? "Checking the cancellation window…" : side === "curator"
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
