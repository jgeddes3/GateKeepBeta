"use client";
import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { formatCents } from "../gigs/GigForms";
import {
  MAX_TRUE_UP_EXTRA_MINUTES, MAX_TRUE_UP_EXTRA_SONGS, TRUE_UP_SHAPE_MESSAGE, trueUpOverCapMessage,
  TRUE_UP_INCREASE_ONLY_MESSAGE, trueUpDeltaPreviewCents,
  type BudgetStructure, type FeePolicy,
} from "@gatekeep/shared";

function ErrorBox({ message }: { message: string }) {
  return (
    <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
      {message}
    </p>
  );
}

// SP5 Task 15 — the curator's increase-only true-up of one occurrence's
// actuals, reported during its settlement window (PaymentsPanel only ever
// mounts this while settlement.status === "pending" — see its rowKind).
// Structure-aware: perHour bookings report extra MINUTES, perSong bookings
// report extra SONGS, and perSet is flat — the caller never mounts this for
// a perSet booking at all, and the guard below is a defensive second line,
// mirroring confirmOccurrenceActuals's own server-side refusal for the same
// case.
export function TrueUpForm({
  bookingId, gigId, structure, amountCents, feePolicy, durationMinutes, songCount, current, onDone, onCancel,
}: {
  bookingId: string; gigId: string; structure: BudgetStructure; amountCents: number;
  feePolicy: FeePolicy; durationMinutes: number; songCount: number | null;
  current: { extraMinutes: number; extraSongs: number } | null;
  onDone: () => void; onCancel: () => void;
}) {
  const isPerHour = structure === "perHour";
  // Review round 1 (low #7): empty by default, never "0" — a booking with no
  // prior report has current == null, and confirmOccurrenceActuals' own
  // SHAPE check refuses extraMinutes===0 && extraSongs===0 outright. A "0"
  // pre-fill would let a curator submit the empty state UNCHANGED straight
  // into a guaranteed server refusal; a blank field makes clear a real
  // number is expected. Once a report exists, current's axis value is
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
  // Review round 1 (low #7): mirrors confirmOccurrenceActuals' own SHAPE
  // check exactly — server-side this is folded into ONE
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
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 10, display: "grid", gap: 8 }}>
      <p style={{ margin: 0, fontWeight: 600 }}>Report actuals</p>
      <label>
        {isPerHour ? "Extra minutes played" : "Extra songs played"}:{" "}
        <input type="number" min={0} max={cap} step={1} disabled={busy} style={{ width: 90 }}
          value={rawInput} onChange={(e) => setRawInput(e.target.value)}
          placeholder="0" aria-label={isPerHour ? "Extra minutes played" : "Extra songs played"} />
      </label>
      <p style={{ margin: 0, fontSize: 12, color: "#666" }}>
        Actuals can only increase — this replaces any previous report for this date.
      </p>
      {preview && preview.deltaBaseCents > 0 && (
        <p style={{ margin: 0, fontSize: 13, color: "#166534" }}>
          The musician will receive an extra {formatCents(preview.musicianDeltaCents)}
          {" "}— you&apos;ll be charged an extra {formatCents(preview.deltaBaseCents + preview.curatorFeeDeltaCents)} at settlement.
        </p>
      )}
      {error && <ErrorBox message={error} />}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save actuals"}</button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}
