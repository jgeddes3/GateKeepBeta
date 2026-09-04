import { View } from "react-native";
import {
  validateOfferInput, LAUNCH_TIMEZONE, MAX_OFFER_NOTE_LENGTH, MAX_OFFER_SONG_COUNT, DEPOSIT_PERCENT,
  type BudgetStructure, type GigPublicLocation, type ReliabilitySummary,
} from "@gatekeep/shared";
import { Text, Input, TextArea, Callout } from "../ui";
import { useTokens } from "../theme/ThemeProvider";

// RN port of ../../../web/src/bookings/BookingForms.tsx (SP4 Task 12):
// booking-domain field-groups + pure formatters shared by GigBrowse's Apply
// flow, MusicianBrowse's inline offer composer, and BookingThread's counter
// form (OfferForm.tsx). Mirrors ../gigs/GigForms.tsx's split: dumb
// value/onChange RN components + pure functions, no save button of their
// own. Booking-status DISPLAY helpers (bookingHistoryLabel/depositLine) and
// the inbox lists live in BookingInbox.tsx; the render-safe `useNow` hook
// lives in BookingThread.tsx, same file split web settled on after its
// Task 10 review.

// Exact copy web uses for the pre-acceptance surfaces (Apply / Offer a gig),
// no computed dollar amount exists yet at this point.
// Final-review fix wave, mirrors web's SP5 Task 15 review round 1 fix
// (medium #6): payments are LIVE as of that sub-project, "will be
// collected... when payments launch" was accurate pre-SP5 and is now simply
// false (acceptBooking fires a real Stripe charge the moment it commits).
// DEPOSIT_PERCENT templated in rather than a hardcoded "35%" literal, so
// this can never drift from the actual constant.
export const DEPOSIT_HONESTY_LINE =
  `If accepted, a ${DEPOSIT_PERCENT}% deposit is charged to the curator's card at accept.`;

// The whole-run twin (sp4 audit finding 2): on a whole_run series the deposit
// is charged PER DATE, for every open date of the run, at accept. Rendered
// wherever DEPOSIT_HONESTY_LINE is, whenever the gig's own fillMode says so.
export const DEPOSIT_HONESTY_RUN_LINE =
  `If accepted, a ${DEPOSIT_PERCENT}% deposit is charged to the curator's card per date, for every open date of the run.`;

// The curator-facing reliability sentence, one definition for every surface
// that renders it (Find musicians cards today; Task 32 adds the inbox rows and
// the thread header). Counts BOOKINGS, not dates: an 8-date completed
// whole-run booking is +1 (ReliabilitySummary.completedCount is
// booking-scoped, see functions/src/bookingLifecycle.ts's
// recomputeReliability). Tolerates a projection with no reliability block:
// pre-section-B3 recomputeReliability wrote summary-only docs, and
// rebuildBookingProjections used to delete and recreate without one.
export function formatReliabilityLine(r: ReliabilitySummary | undefined): string {
  const completed = r?.completedCount ?? 0;
  const noShows = r?.noShowCount ?? 0;
  return `${completed} show${completed === 1 ? "" : "s"} played · ${noShows} no-show${noShows === 1 ? "" : "s"}`;
}

export interface OfferState { amount: string; quantity: string; note: string; }
export const emptyOffer = (): OfferState => ({ amount: "", quantity: "", note: "" });

export interface OfferPayload { amountCents: number; expectedQuantity: number | null; note: string | null; }

// Converts the dollar-string UI state into the integer-cents callable
// payload and runs the SAME validator applyToGig/offerGig/counterBooking run
// server-side (validateOfferInput), a malformed offer is caught here, with
// the identical error copy the server would otherwise return.
export function buildOfferPayload(
  structure: BudgetStructure, state: OfferState,
): { payload: OfferPayload | null; error: string | null } {
  const amountDollars = Number(state.amount);
  if (state.amount.trim() === "" || !Number.isFinite(amountDollars)) {
    return { payload: null, error: "Enter an amount." };
  }
  const amountCents = Math.round(amountDollars * 100);
  let expectedQuantity: number | null = null;
  if (structure === "perSong") {
    const q = Number(state.quantity);
    if (state.quantity.trim() === "" || !Number.isFinite(q)) {
      return { payload: null, error: "Enter a song count." };
    }
    // Not Math.trunc'd, a fractional entry (e.g. "3.5") passes through
    // as-is so validateOfferInput's own integer check catches it and
    // returns its real error, rather than silently rounding down to a
    // value the musician never actually typed.
    expectedQuantity = q;
  }
  const note = state.note.trim() === "" ? null : state.note.trim();
  const err = validateOfferInput(structure, { amountCents, expectedQuantity, note });
  if (err) return { payload: null, error: err };
  return { payload: { amountCents, expectedQuantity, note }, error: null };
}

// Amount + (perSong only) song count + note-with-counter, the exact input
// set applyToGig/offerGig/counterBooking accept. RN TextInputs replace
// web's <input type=number>/<textarea> (mirrors ../gigs/GigForms.tsx's
// BudgetFields keyboardType idiom).
export function OfferFields({ structure, value, onChange, disabled }: {
  structure: BudgetStructure; value: OfferState; onChange: (v: OfferState) => void; disabled?: boolean;
}) {
  const unitLabel = structure === "perHour" ? "per hour" : structure === "perSong" ? "per song" : "flat, per set";
  return (
    <View style={{ gap: 8 }}>
      <Text>Your offer ({unitLabel})</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text>$</Text>
        <Input keyboardType="decimal-pad" editable={!disabled} value={value.amount}
          onChangeText={(t) => onChange({ ...value, amount: t })}
          style={{ width: 100 }} />
      </View>
      {structure === "perSong" && (
        <View style={{ gap: 4 }}>
          <Text>Song count</Text>
          <Input keyboardType="number-pad" editable={!disabled} value={value.quantity}
            placeholder={`1-${MAX_OFFER_SONG_COUNT}`}
            onChangeText={(t) => onChange({ ...value, quantity: t.replace(/[^0-9.]/g, "") })}
            style={{ width: 90 }} />
        </View>
      )}
      <View style={{ gap: 4 }}>
        <TextArea numberOfLines={3} maxLength={MAX_OFFER_NOTE_LENGTH} editable={!disabled}
          placeholder="Note (optional)" value={value.note} onChangeText={(t) => onChange({ ...value, note: t })}
          style={{ minHeight: 64 }} />
        <Text variant="meta" muted>{value.note.length}/{MAX_OFFER_NOTE_LENGTH}</Text>
      </View>
    </View>
  );
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

// Offset (in ms) between UTC and `timeZone`'s wall clock AT a given UTC
// instant, derived per-instant (not a constant) so it's correct on both
// sides of a DST transition. Byte-identical math to web's tzOffsetMs, but
// wrapped in try/catch: unlike web's browser guarantee, Hermes's
// Intl.DateTimeFormat timeZone/formatToParts support on Expo 57 is not
// independently verified on-device in this (Windows, no simulator)
// environment, see ../gigs/GigForms.tsx's formatGigDateTime for the same
// defensive pattern already established here. A failure here degrades to
// "no date-range filter applied" (launchTzDayStartMs below returns null),
// never a crash.
function tzOffsetMs(timeZone: string, utcMs: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return Number.isFinite(asUtc) ? asUtc - utcMs : null;
  } catch {
    return null;
  }
}

// GigBrowse's date-filter boundary computation: every gig time on this app
// displays in LAUNCH_TIMEZONE (formatGigDateTime), so a "From"/"To" day
// typed in the filter must be bucketed by LAUNCH_TIMEZONE midnight, not UTC
// midnight. Byte-identical technique to web's launchTzDayStartMs (round-trip
// validated, DST-aware via tzOffsetMs above); returns null for an
// empty/malformed input OR an Intl failure, both treated identically by
// GigBrowse (no date constraint applied), never a thrown error.
export function launchTzDayStartMs(dateInput: string): number | null {
  if (!dateInput) return null;
  const [year, month, day] = dateInput.split("-").map(Number);
  if (!year || !month || !day) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  const guessUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offset = tzOffsetMs(LAUNCH_TIMEZONE, guessUtcMs);
  if (offset == null) return null;
  const candidateMs = guessUtcMs - offset;

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: LAUNCH_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(candidateMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
    if (get("year") !== year || get("month") !== month || get("day") !== day) return null;
    return candidateMs;
  } catch {
    return null;
  }
}

// The exclusive upper bound for a "To" date filter: LAUNCH_TIMEZONE
// midnight that STARTS the day after `dateInput`, derived from the actual
// next calendar date (timezone-agnostic Y-M-D arithmetic) rather than a
// fixed +24h, which would be wrong by an hour across LAUNCH_TIMEZONE's own
// DST transition days. Mirrors web's launchTzNextDayStartMs exactly.
export function launchTzNextDayStartMs(dateInput: string): number | null {
  if (!dateInput) return null;
  const [year, month, day] = dateInput.split("-").map(Number);
  if (!year || !month || !day) return null;
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const nextInput = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
  return launchTzDayStartMs(nextInput);
}

// Public-precision location label, byte-identical logic to web's
// gigLocationLabel (BookingForms.tsx): `address` is present on the doc ONLY
// when addressVisibility=='public' (functions/src/gigs.ts nulls it out
// otherwise), so this never branches on anything the client couldn't
// already see.
export function gigLocationLabel(location: GigPublicLocation): string {
  if (location.addressVisibility === "public") {
    return location.venueName ? `${location.venueName} · ${location.address}` : (location.address ?? location.city);
  }
  return location.neighborhood ? `${location.neighborhood}, ${location.city}` : location.city;
}

// Shared error-message box style, every busy composer/dialog in this
// directory (GigBrowse's Apply panel, MusicianBrowse's offer composer,
// OfferForm, CancelDialog, BookingThread) surfaces the server's verbatim
// error the same way, matching the amber warning-box color already
// established by ../gigs/GigForms.tsx and ../curator/CuratorForms.tsx.
export function ErrorBox({ message }: { message: string }) {
  const t = useTokens();
  return (
    <Callout tone="warning">
      <Text color={t.warning}>{message}</Text>
    </Callout>
  );
}

// Duck-typed Firebase callable error code extraction, mirrors web's
// `typeof (e as { code?: unknown }).code === "string" ? ... : undefined`
// idiom used at every "already-exists" special-case (applyToGig/offerGig
// dedupe) across this directory.
export function errorCode(e: unknown): string | undefined {
  return typeof (e as { code?: unknown } | null)?.code === "string" ? (e as { code: string }).code : undefined;
}
