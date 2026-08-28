import { useState } from "react";
import { View, Text, TextInput, Pressable } from "react-native";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { formatCents } from "../gigs/GigForms";
import {
  MAX_TRUE_UP_EXTRA_MINUTES, MAX_TRUE_UP_EXTRA_SONGS, TRUE_UP_SHAPE_MESSAGE, trueUpOverCapMessage,
  TRUE_UP_INCREASE_ONLY_MESSAGE, trueUpDeltaPreviewCents,
  type BudgetStructure, type FeePolicy,
} from "@gatekeep/shared";

// RN port of apps/web/src/payments/TrueUpForm.tsx (SP5b Task 5) — the
// curator's increase-only true-up of one occurrence's actuals, reported
// during its settlement window (PaymentStatus only ever mounts this while
// settlement.status === "pending" — see its rowKind, mirroring web's
// PaymentsPanel). Structure-aware: perHour bookings report extra MINUTES,
// perSong bookings report extra SONGS, and perSet is flat — the caller
// never mounts this for a perSet booking at all, and the guard below is a
// defensive second line, mirroring confirmOccurrenceActuals's own
// server-side refusal for the same case.
export function TrueUpForm({
  bookingId, gigId, structure, amountCents, feePolicy, durationMinutes, songCount, current, onDone, onCancel,
}: {
  bookingId: string; gigId: string; structure: BudgetStructure; amountCents: number;
  feePolicy: FeePolicy; durationMinutes: number; songCount: number | null;
  current: { extraMinutes: number; extraSongs: number } | null;
  onDone: () => void; onCancel: () => void;
}) {
  const isPerHour = structure === "perHour";
  // Review round 1 (low #7): empty by default, never "0" — a booking
  // with no prior report has current == null, and confirmOccurrenceActuals'
  // own SHAPE check refuses extraMinutes===0 && extraSongs===0 outright. A
  // "0" pre-fill would let a curator submit the empty state UNCHANGED
  // straight into a guaranteed server refusal; a blank field makes clear a
  // real number is expected. Once a report exists, current's axis value is
  // always > 0 (0/0 is never a value the server would have accepted), so
  // this only ever pre-fills a genuine positive number.
  const currentAxisValue = isPerHour ? current?.extraMinutes : current?.extraSongs;
  const [rawInput, setRawInput] = useState(currentAxisValue != null && currentAxisValue > 0 ? String(currentAxisValue) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (structure === "perSet") return null; // flat — nothing to report

  const trimmed = rawInput.trim();
  const parsedValue = Math.round(Number(trimmed));
  const inputShapeOk = trimmed !== "" && Number.isFinite(Number(trimmed)) && Number.isInteger(parsedValue) && parsedValue >= 0;
  const cap = isPerHour ? MAX_TRUE_UP_EXTRA_MINUTES : MAX_TRUE_UP_EXTRA_SONGS;
  const overCap = inputShapeOk && parsedValue > cap;
  const belowCurrent = inputShapeOk && parsedValue < (currentAxisValue ?? 0);

  const nextExtraMinutes = isPerHour ? (inputShapeOk ? parsedValue : (currentAxisValue ?? 0)) : (current?.extraMinutes ?? 0);
  const nextExtraSongs = isPerHour ? (current?.extraSongs ?? 0) : (inputShapeOk ? parsedValue : (currentAxisValue ?? 0));
  // Review round 1 (low #7): mirrors confirmOccurrenceActuals' own
  // SHAPE check exactly — server-side this is folded into ONE
  // `(extraMinutes===0 && extraSongs===0)` clause alongside the integer/
  // non-negative checks, not a separate rule. A booking that's never had
  // actuals reported has BOTH extras at 0 by default, and 0/0 is refused
  // outright as malformed, not accepted as "no change".
  const bothZero = nextExtraMinutes === 0 && nextExtraSongs === 0;
  const shapeOk = inputShapeOk && !bothZero;

  const preview = shapeOk && !overCap && !belowCurrent
    ? trueUpDeltaPreviewCents(structure, amountCents, feePolicy, durationMinutes, songCount,
        { extraMinutes: current?.extraMinutes ?? 0, extraSongs: current?.extraSongs ?? 0 },
        { extraMinutes: nextExtraMinutes, extraSongs: nextExtraSongs })
    : null;

  const submit = async () => {
    setError(null);
    // Client-side mirror of confirmOccurrenceActuals' own SHAPE -> CAP ->
    // increase-only ordering (different complaints, different fixes — see
    // messages.ts's header) — the server independently re-validates all
    // three regardless.
    if (!shapeOk) { setError(TRUE_UP_SHAPE_MESSAGE); return; }
    if (overCap) { setError(trueUpOverCapMessage(isPerHour ? "minutes" : "songs", cap)); return; }
    if (belowCurrent) { setError(TRUE_UP_INCREASE_ONLY_MESSAGE); return; }
    setBusy(true);
    try {
      await httpsCallable(getFirebase().functions, "confirmOccurrenceActuals")({
        bookingId, gigId, extraMinutes: nextExtraMinutes, extraSongs: nextExtraSongs,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not report actuals.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 10, gap: 8 }}>
      <Text style={{ fontWeight: "600" }}>Report actuals</Text>
      <View style={{ gap: 4 }}>
        <Text>{isPerHour ? "Extra minutes played" : "Extra songs played"}</Text>
        <TextInput keyboardType="number-pad" editable={!busy} value={rawInput} onChangeText={setRawInput}
          placeholder="0" accessibilityLabel={isPerHour ? "Extra minutes played" : "Extra songs played"}
          style={{ borderWidth: 1, borderRadius: 8, padding: 8, width: 90 }} />
      </View>
      <Text style={{ fontSize: 12, color: "#666" }}>
        Actuals can only increase — this replaces any previous report for this date.
      </Text>
      {preview && preview.deltaBaseCents > 0 && (
        <Text style={{ fontSize: 13, color: "#166534" }}>
          The musician will receive an extra {formatCents(preview.musicianDeltaCents)}
          {" "}— you&apos;ll be charged an extra {formatCents(preview.deltaBaseCents + preview.curatorFeeDeltaCents)} at settlement.
        </Text>
      )}
      {error && (
        <Text style={{ backgroundColor: "#fef3c7", borderWidth: 1, borderColor: "#fde68a",
          borderRadius: 8, padding: 12, color: "#92400e" }}>{error}</Text>
      )}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable onPress={() => void submit()} disabled={busy}
          style={{ backgroundColor: "#111", paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, opacity: busy ? 0.6 : 1 }}>
          <Text style={{ color: "#fff" }}>{busy ? "Saving…" : "Save actuals"}</Text>
        </Pressable>
        <Pressable onPress={onCancel} disabled={busy}
          style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, opacity: busy ? 0.6 : 1 }}>
          <Text>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}
