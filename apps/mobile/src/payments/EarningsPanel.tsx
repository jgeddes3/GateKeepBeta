import { useEffect, useRef, useState } from "react";
import { View, Pressable, AppState } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { collection, getDocs, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { formatCents, formatGigDateTime } from "../gigs/GigForms";
import {
  PAYOUT_INSTANT_INELIGIBLE_MESSAGE, PAYOUT_INSTANT_MIN_MESSAGE, INSTANT_PAYOUT_MIN_CENTS,
  instantFeePreviewCents,
  type PaymentDoc, type StripeStatusResult,
} from "@gatekeep/shared";
import { Text, Button, Input, Callout } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// SP5b Task 7: the musician's payouts surface, mobile's full-featured
// counterpart to apps/web/src/payments/EarningsPanel.tsx (which this is a
// direct port of, every helper below travels, comments included). House
// idiom throughout (see src/bookings/CancelDialog.tsx): callFn(...)
// (lib/callable.ts, Task 27) + inline styles, verbatim server-error
// surfacing, busy/error local state.
// Replaces the read-only EarningsCard (SP5 Task 16) that used to sit here,
// mobile now does onboarding and cash-outs natively instead of punting to
// the web app.
//
// Differences from web, and ONLY these (spec §4 binds all four):
//  1. requestId minting, RN has no crypto.randomUUID (see mintRequestId).
//  2. Onboarding: the in-app browser (expo-web-browser) + AppState
//     re-foreground re-sync replaces window.location.assign + the
//     sessionStorage bridge (rememberOnboardingProfileId is NOT ported,
//     that bridge is for web's own return page).
//  3. HTML elements become RN primitives (View/Text/TextInput/Pressable);
//     RN has no `title` attribute, so the Instant button's two tooltip
//     messages render as a small Text hint under the button row instead.
//  4. NO client-side admin gating (spec §4): the buttons render for any
//     member of the profile; a non-admin's press surfaces the server's
//     permission refusal verbatim, exactly web's posture.

interface RequestPayoutResult { payoutId: string; feeCents: number; netCents: number; replayed: boolean; }

// Mirrors money.ts's assertCents ceiling, keeps an absurd/malformed typed
// amount from reaching instantFeePreviewCents's own assertCents and throwing
// mid-render (the server independently re-enforces this; this bound is only
// to keep the CLIENT from crashing on a bad preview input).
const MAX_PREVIEW_CENTS = 2 ** 45;

// dollars-string input -> whole cents, or null when not a usable amount.
// UI-only validation, the server is the actual authority (invariant #1: no
// client-supplied amounts drive what's charged/paid; this only shapes what
// the client SENDS as amountCents, which requestPayout independently checks
// against the live balance). The 100-cent floor mirrors requestPayout's own
// ("Cash out at least $1, as a whole number of cents."), a naive `n > 0`
// check let a value that rounds to well under $1 (or even to 0, for a tiny
// fractional-cent typo) sail through as "valid" for both the fee preview and
// the button-enabled state.
function parseDollarsToCents(s: string): number | null {
  const n = Number(s.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return cents < 100 || cents > MAX_PREVIEW_CENTS ? null : cents;
}

// RN has no crypto.randomUUID, timestamp+random nonce is fine (uniqueness,
// not secrecy; requestPayout's REQUEST_ID_RE accepts 8-64 [A-Za-z0-9_-]).
const mintRequestId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;

type PaymentRow = PaymentDoc & { id: string; bookingId: string };

// The profile's payment docs across its 50 most-recently-updated bookings as
// the musician side, one onSnapshot on the bookings list (rules-provable:
// musicianProfileId pinned, same shape as BookingInbox's own query), ordered
// by updatedAt desc via the (musicianProfileId ASC, updatedAt DESC)
// composite index that ALREADY EXISTS (SP4 Task 11, see
// firestore.indexes.json), then an n+1 one-shot getDocs per booking's
// payments subcollection (same acceptable n+1 idiom as BookingInbox's
// useRowGigTitle/useNextOccurrence, inbox/earnings scale, not a paginated
// list).
function usePaymentRows(profileId: string): PaymentRow[] {
  const [rows, setRows] = useState<PaymentRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    // Bumped on every onSnapshot fire so a late-resolving OLDER fan-out (the
    // Promise.all over a booking's payments subcollections) can never
    // clobber a NEWER one's result, onSnapshot can fire again (a booking
    // updated) before the previous fire's n+1 getDocs calls have all
    // settled, and network timing gives no guarantee the older fire resolves
    // first.
    let generation = 0;
    const { db } = getFirebase();
    const unsubscribe = onSnapshot(
      query(collection(db, "bookings"), where("musicianProfileId", "==", profileId),
        orderBy("updatedAt", "desc"), limit(50)),
      async (snap) => {
        const myGeneration = ++generation;
        const perBooking = await Promise.all(snap.docs.map(async (b) => {
          try {
            const paySnap = await getDocs(collection(db, `bookings/${b.id}/payments`));
            // Spread first, id/bookingId set AFTER (last-one-wins, no
            // duplicate-key error), PaymentDoc already carries its own
            // `bookingId` field (== b.id here); overriding it with the
            // known-good b.id means the row's key (below) never depends on
            // trusting a server-written field to match its own parent path.
            return paySnap.docs.map((d) => ({ ...(d.data() as PaymentDoc), id: d.id, bookingId: b.id }));
          } catch {
            return []; // permission-denied/offline on one booking's subcollection, drop it, not the whole panel
          }
        }));
        if (!cancelled && myGeneration === generation) setRows(perBooking.flat());
      },
      () => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; unsubscribe(); };
  }, [profileId]);
  return rows;
}

function PendingSettlementsList({ rows }: { rows: PaymentRow[] }) {
  const pending = rows
    .filter((r) => r.settlement.status === "pending" || r.settlement.status === "past_due")
    .sort((a, b) => a.occurrenceStartsAt - b.occurrenceStartsAt);
  if (pending.length === 0) return <Text muted>Nothing pending.</Text>;
  return (
    <View style={{ gap: tokens.space.sm }}>
      {pending.map((r) => (
        <Text key={`${r.bookingId}:${r.id}`}>
          {formatGigDateTime(r.occurrenceStartsAt)}
          {": "}
          {r.settlement.status === "past_due"
            ? "curator payment delayed"
            : `pays out ~${r.settlement.settleAfter != null ? formatGigDateTime(r.settlement.settleAfter) : "after the gig"}`}
        </Text>
      ))}
    </View>
  );
}

// History caps at 20, same as BookingInbox's own history list (SP4 Task 10),
// a generous soft cap so an unusually busy profile's Earnings page stays
// bounded without pagination UI yet.
const HISTORY_LIMIT = 20;

function HistoryList({ rows }: { rows: PaymentRow[] }) {
  const history = rows
    .filter((r) => r.transfer.status === "transferred" || r.deposit.status === "forfeited")
    .sort((a, b) => (b.transfer.transferredAt ?? b.updatedAt) - (a.transfer.transferredAt ?? a.updatedAt))
    .slice(0, HISTORY_LIMIT);
  if (history.length === 0) return <Text muted>No payout history yet.</Text>;
  return (
    <View style={{ gap: tokens.space.sm }}>
      {history.map((r) => (
        <Text key={`${r.bookingId}:${r.id}`}>
          {formatGigDateTime(r.occurrenceStartsAt)}
          {": "}
          {r.deposit.status === "forfeited" && `Forfeited deposit: received 100% (${formatCents(r.deposit.sliceCents)})`}
          {r.deposit.status === "forfeited" && r.transfer.status === "transferred" && "; "}
          {r.transfer.status === "transferred" && r.transfer.amountCents != null
            && `Paid ${formatCents(r.transfer.amountCents)}`}
        </Text>
      ))}
    </View>
  );
}

export function EarningsPanel({ profileId }: { profileId: string }) {
  const t = useTokens();
  const [status, setStatus] = useState<StripeStatusResult | "loading" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [onboardBusy, setOnboardBusy] = useState(false);
  const [onboardError, setOnboardError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutError, setPayoutError] = useState<string | null>(null);
  const [payoutMessage, setPayoutMessage] = useState<string | null>(null);
  // ONE id per cash-out press (as-built contract #1 in the payments plan,
  // Task 13's correction): a RETRY of the same press (same method+amount)
  // reuses this id so requestPayout replays rather than double-pays; a
  // changed amount/method, or a press after a completed one, is a NEW
  // cash-out and mints its own id.
  const requestRef = useRef<{ id: string; method: "standard" | "instant"; amountCents: number } | null>(null);
  // True while the Stripe-hosted onboarding browser is open, see
  // setupPayouts/the AppState listener below.
  const onboardingInFlight = useRef(false);
  const rows = usePaymentRows(profileId);
  // Hoisted once per render (not recomputed inline at each use site) so the
  // fee preview label and the Instant-button gating logic below can never
  // disagree about what "the typed amount" currently parses to.
  const previewCents = parseDollarsToCents(amount);
  const previewFeeCents = previewCents != null ? instantFeePreviewCents(previewCents) : null;
  // Owner ruling (M4): the $10 instant minimum, mirrored client-side so the
  // Instant button disables (with an explaining hint) below it rather than
  // letting the server bounce it. requestPayout is the actual authority; this
  // only pre-empts the round trip. A standard payout stays available below $10.
  const belowInstantMin = previewCents != null && previewCents < INSTANT_PAYOUT_MIN_CENTS;
  // RN's Pressable has no automatic "greyed out" look the way an HTML
  // `<button disabled>` gets for free, hoisted here (once) so the button's
  // `disabled` prop and its disabled styling read the SAME computed value
  // instead of two copies of this condition drifting apart.
  const instantDisabled = typeof status === "object" && (
    payoutBusy || !status.instantEligible || belowInstantMin
    || (previewCents != null && previewFeeCents != null && previewFeeCents >= previewCents));
  const instantHint = typeof status === "object"
    ? (!status.instantEligible ? PAYOUT_INSTANT_INELIGIBLE_MESSAGE : belowInstantMin ? PAYOUT_INSTANT_MIN_MESSAGE : null)
    : null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await callFn<{ profileId: string }, StripeStatusResult>("getStripeStatus", { profileId });
        if (cancelled) return;
        setStatus(res.data);
        // Default the amount field to the full available balance, but only
        // when the field is still empty (first load, or right after a
        // completed payout cleared it), never clobbering something the user
        // is mid-typing.
        setAmount((prev) => (prev === "" && res.data.availableBalanceCents != null)
          ? (res.data.availableBalanceCents / 100).toString() : prev);
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, [profileId, reloadKey]);

  // Stripe-hosted Express onboarding opens in the in-app browser. The return/
  // refresh URLs are the server-built APP_ORIGIN web pages (fail-closed, never
  // client-supplied, createOnboardingLink's contract); mobile doesn't need to
  // land on them: getStripeStatus re-syncs the gate flags live (it re-reads the
  // account from Stripe), so re-polling on browser dismiss AND on app
  // re-foreground covers both the in-app-browser path and a user who bounced
  // out to Safari/Chrome mid-flow.
  const setupPayouts = async () => {
    setOnboardBusy(true);
    setOnboardError(null);
    try {
      const res = await callFn<{ profileId: string }, { url: string }>("createOnboardingLink", { profileId });
      onboardingInFlight.current = true;
      // expo-web-browser's openBrowserAsync resolves at a DIFFERENT moment per
      // platform (see the installed package's own source comments): iOS
      // resolves with {type: 'dismiss'} only once the user closes the in-app
      // browser, but Android resolves with {type: 'opened'} as soon as the
      // Custom Tab is on screen, the await returns while the user is still
      // mid-flow inside Stripe's hosted form. Only clear-and-reload on a REAL
      // dismissal; on 'opened' (Android) the flag stays ARMED so the AppState
      // 'active' listener below re-polls once the user actually backgrounds/
      // foregrounds out of the Custom Tab instead of re-polling too early.
      // Any future in-app-browser flow in this app will hit this same
      // platform asymmetry.
      const result = await WebBrowser.openBrowserAsync(res.data.url);
      if (result.type !== "opened") {
        // A real dismissal (iOS always; Android when the tab was closed
        // without ever fully opening), whatever happened in there, re-read
        // the truth now.
        onboardingInFlight.current = false;
        setReloadKey((k) => k + 1);
      }
    } catch (e) {
      setOnboardError(e instanceof Error ? e.message : "Could not start payout setup.");
    } finally {
      setOnboardBusy(false);
    }
  };

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && onboardingInFlight.current) {
        onboardingInFlight.current = false;
        setReloadKey((k) => k + 1);
      }
    });
    return () => sub.remove();
  }, []);

  const submitPayout = async (method: "standard" | "instant") => {
    if (typeof status !== "object") return;
    const amountCents = parseDollarsToCents(amount);
    if (amountCents == null) {
      setPayoutError("Enter at least $1.00.");
      return;
    }
    setPayoutBusy(true);
    setPayoutError(null);
    setPayoutMessage(null);
    try {
      if (!requestRef.current || requestRef.current.method !== method || requestRef.current.amountCents !== amountCents) {
        requestRef.current = { id: mintRequestId(), method, amountCents };
      }
      const res = await callFn<
        { profileId: string; amountCents: number; method: "standard" | "instant"; requestId: string },
        RequestPayoutResult
      >("requestPayout",
        { profileId, amountCents, method, requestId: requestRef.current.id });
      const verb = res.data.replayed ? "Already sent" : "Sent";
      setPayoutMessage(res.data.feeCents > 0
        ? `${verb}: ${formatCents(res.data.netCents)} (fee ${formatCents(res.data.feeCents)}).`
        : `${verb}: ${formatCents(res.data.netCents)}${method === "standard" ? ", arrives in 1-3 business days." : "."}`);
      requestRef.current = null; // done, a later press is a NEW cash-out
      setAmount(""); // re-defaults to the fresh balance once status reloads
      setReloadKey((k) => k + 1);
    } catch (e) {
      setPayoutError(e instanceof Error ? e.message : "Could not send the payout.");
    } finally {
      setPayoutBusy(false);
    }
  };

  return (
    <View style={{ gap: tokens.space.lg }}>
      {status === "loading" && <Text muted>Loading…</Text>}
      {status === "error" && (
        <View style={{ gap: tokens.space.sm }}>
          <Callout tone="warning"><Text color={t.warning}>Couldn&apos;t load payout status.</Text></Callout>
          <Pressable onPress={() => setReloadKey((k) => k + 1)} style={{ alignSelf: "flex-start" }}>
            <Text color={t.warning} style={{ textDecorationLine: "underline" }}>Retry</Text>
          </Pressable>
        </View>
      )}
      {typeof status === "object" && (
        <>
          {status.delinquent && (
            <Callout tone="destructive">
              <Text color={t.destructive}>A booking you&apos;re part of has an overdue curator payment.</Text>
            </Callout>
          )}
          {!(status.hasAccount && status.payoutsEnabled) ? (
            <View style={{ gap: tokens.space.sm }}>
              <Text>Set up payouts to get paid for your bookings.</Text>
              <Button title={onboardBusy ? "Opening Stripe…" : "Set up payouts"}
                onPress={() => void setupPayouts()} disabled={onboardBusy} style={{ alignSelf: "flex-start" }} />
              {onboardError && (
                <Callout tone="warning"><Text color={t.warning}>{onboardError}</Text></Callout>
              )}
              <Text variant="meta" muted>
                Your first payout may be held for about 7 days while Stripe verifies your account.
              </Text>
            </View>
          ) : (
            <View style={{ gap: tokens.space.md }}>
              <View style={{ gap: tokens.space.xs }}>
                <Text variant="meta" muted>Available balance</Text>
                <Text variant="display">
                  {status.availableBalanceCents == null ? "Balance unavailable: try again shortly" : formatCents(status.availableBalanceCents)}
                </Text>
                {status.availableBalanceCents != null && status.instantAvailableBalanceCents != null
                  && status.instantAvailableBalanceCents !== status.availableBalanceCents && (
                  <Text variant="meta" muted>
                    Instant available: {formatCents(status.instantAvailableBalanceCents)}
                  </Text>
                )}
              </View>
              <View style={{ gap: tokens.space.xs }}>
                <Text>Amount to cash out</Text>
                <Input
                  keyboardType="decimal-pad"
                  value={amount}
                  onChangeText={(v) => { setAmount(v); setPayoutError(null); }}
                  editable={!(payoutBusy || status.availableBalanceCents == null)}
                  accessibilityLabel="Amount to cash out (dollars)"
                  style={{ width: 110 }}
                />
              </View>
              <View style={{ flexDirection: "row", gap: tokens.space.sm, flexWrap: "wrap" }}>
                <Button title="Standard (free, 1–3 business days)" variant="secondary"
                  onPress={() => void submitPayout("standard")} disabled={payoutBusy} />
                <Button title={`Instant${previewCents != null && previewFeeCents != null ? ` (fee ${formatCents(previewFeeCents)})` : ""}`}
                  variant="secondary" onPress={() => void submitPayout("instant")} disabled={instantDisabled} />
              </View>
              {instantHint && <Text variant="meta" muted>{instantHint}</Text>}
              {payoutError && (
                <Callout tone="warning"><Text color={t.warning}>{payoutError}</Text></Callout>
              )}
              {payoutMessage && (
                <Callout tone="success"><Text color={t.success}>{payoutMessage}</Text></Callout>
              )}
            </View>
          )}
          <View style={{ gap: tokens.space.sm }}>
            <Text variant="title">Pending settlements</Text>
            <PendingSettlementsList rows={rows} />
          </View>
          <View style={{ gap: tokens.space.sm }}>
            <Text variant="title">History</Text>
            <HistoryList rows={rows} />
          </View>
        </>
      )}
    </View>
  );
}
