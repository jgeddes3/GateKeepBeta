"use client";
import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { formatCents } from "../gigs/GigForms";
import { trueUpDeltaPreviewCents } from "./fees";
import {
  MAX_TRUE_UP_EXTRA_MINUTES, MAX_TRUE_UP_EXTRA_SONGS, TRUE_UP_SHAPE_MESSAGE, trueUpOverCapMessage,
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
  const [minutesInput, setMinutesInput] = useState(String(current?.extraMinutes ?? 0));
  const [songsInput, setSongsInput] = useState(String(current?.extraSongs ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (structure === "perSet") return null; // flat — nothing to report

  const isPerHour = structure === "perHour";
  const rawInput = isPerHour ? minutesInput : songsInput;
  const parsedValue = Math.round(Number(rawInput));
  const shapeOk = rawInput.trim() !== "" && Number.isFinite(Number(rawInput)) && Number.isInteger(parsedValue) && parsedValue >= 0;
  const cap = isPerHour ? MAX_TRUE_UP_EXTRA_MINUTES : MAX_TRUE_UP_EXTRA_SONGS;
  const overCap = shapeOk && parsedValue > cap;
  const currentValue = isPerHour ? (current?.extraMinutes ?? 0) : (current?.extraSongs ?? 0);
  const belowCurrent = shapeOk && parsedValue < currentValue;

  const nextExtraMinutes = isPerHour ? parsedValue : (current?.extraMinutes ?? 0);
  const nextExtraSongs = isPerHour ? (current?.extraSongs ?? 0) : parsedValue;

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
    if (belowCurrent) { setError("Reported actuals can only increase."); return; }
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
          value={isPerHour ? minutesInput : songsInput}
          onChange={(e) => (isPerHour ? setMinutesInput(e.target.value) : setSongsInput(e.target.value))}
          aria-label={isPerHour ? "Extra minutes played" : "Extra songs played"} />
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
