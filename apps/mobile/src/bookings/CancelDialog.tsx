import { useState } from "react";
import { View, Text, TextInput, Pressable } from "react-native";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { formatCents } from "../gigs/GigForms";
import { ErrorBox } from "./BookingForms";
// useNow lives in BookingThread.tsx (its primary/originating consumer) —
// same-directory sibling import, not a package boundary; useNow is only
// ever CALLED from within a component body, so the resulting circular
// import (BookingThread -> CancelDialog -> BookingThread) resolves cleanly,
// mirroring web's identical CancelDialog.tsx/BookingThread.tsx split.
import { useNow } from "./BookingThread";
import {
  CURATOR_FORFEIT_WINDOW_HOURS, MUSICIAN_MARK_WINDOW_HOURS, MAX_CANCEL_REASON_LENGTH,
  type BookingSide,
} from "@gatekeep/shared";

// RN port of ../../../web/src/bookings/CancelDialog.tsx (SP4 Task 12) —
// shared cancel UI for both cancelBooking (mode "booking" — the whole
// booking/run) and cancelOccurrence (mode "occurrence" — one date of a
// whole-run booking). The live window warning is computed CLIENT-SIDE from
// the same shared constants the server's executeCancellation/
// cancelOccurrence windows use — it's advisory only (the server
// independently recomputes hoursBeforeStart at commit time from ITS OWN
// `now`, which is authoritative).
export function CancelDialog({ bookingId, gigId, side, startsAt, depositAmountCents, mode, onClose, onDone }: {
  bookingId: string;
  gigId?: string; // required when mode === "occurrence" (cancelOccurrence's target date)
  side: BookingSide; // caller's resolved side — musician-first when a viewer is on both (see BookingThread)
  startsAt: number; // the relevant occurrence's startsAt, for the window math below
  depositAmountCents?: number; // known only once a booking is confirmed
  mode: "booking" | "occurrence";
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      // Verbatim server error in a friendly wrapper — same pattern used
      // throughout this app's other composers.
      setError(e instanceof Error ? e.message : "Could not cancel.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ borderWidth: 1, borderColor: "#fca5a5", borderRadius: 8, padding: 12, gap: 10, backgroundColor: "#fef2f2" }}>
      <Text style={{ fontWeight: "700" }}>{mode === "booking" ? "Cancel this booking" : "Cancel this date"}</Text>
      <Text style={{ color: "#92400e" }}>{warning}</Text>
      <View style={{ gap: 4 }}>
        <TextInput multiline numberOfLines={3} maxLength={MAX_CANCEL_REASON_LENGTH} value={reason} editable={!busy}
          onChangeText={setReason} placeholder="Reason (required)"
          accessibilityLabel="Cancellation reason"
          style={{ borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 64, textAlignVertical: "top" }} />
        <Text style={{ fontSize: 12, color: "#666" }}>{reason.length}/{MAX_CANCEL_REASON_LENGTH}</Text>
      </View>
      {error && <ErrorBox message={error} />}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable onPress={() => void submit()} disabled={busy}
          style={{ backgroundColor: "#dc2626", paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, opacity: busy ? 0.6 : 1 }}>
          <Text style={{ color: "#fff" }}>{busy ? "Cancelling…" : "Confirm cancellation"}</Text>
        </Pressable>
        <Pressable onPress={onClose} disabled={busy}
          style={{ borderWidth: 1, borderColor: "#bbb", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16 }}>
          <Text>Back</Text>
        </Pressable>
      </View>
    </View>
  );
}
