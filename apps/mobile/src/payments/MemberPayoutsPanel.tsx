import { useEffect, useRef, useState } from "react";
import { View, Pressable, AppState } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { callFn } from "../lib/callable";
import { formatCents } from "../gigs/GigForms";
import { PayoutHistoryList } from "./PayoutHistoryList";
import {
  PAYOUT_INSTANT_INELIGIBLE_MESSAGE, PAYOUT_INSTANT_MIN_MESSAGE, INSTANT_PAYOUT_MIN_CENTS,
  instantFeePreviewCents,
} from "@gatekeep/shared";
import { Text, Button, Input, Callout, Skeleton } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// SP5c Task 12: mobile's twin of apps/web/src/payments/MemberPayoutsCard.tsx
// (itself the person-scoped twin of EarningsPanel.tsx), for the fan's own
// "Payouts" screen (band members cash out their own share of a booking/
// ticket split here, not through a musician profile). Same house idiom
// (callFn(...), inline styles, verbatim server-error surfacing, busy/error
// local state) and the same two EarningsPanel differences from its web
// counterpart named in that file's own header comment: mintRequestId (RN has
// no crypto.randomUUID) and the WebBrowser.openBrowserAsync + AppState
// foreground resync in place of window.location.assign + a sessionStorage
// bridge (this card needs no bridge either, same as MemberPayoutsCard: the
// return page has no id to recover, it just re-checks the signed-in caller's
// own status). Unlike EarningsPanel there is no admin/role gate here (every
// signed-in account owns its own payout setup and cash-out, requestMemberPayout/
// getMemberPayoutStatus/createMemberOnboardingLink carry no admin check of
// their own either).

interface MemberPayoutStatus {
  hasAccount: boolean;
  transfersEnabled: boolean;
  payoutsEnabled: boolean;
  instantEligible: boolean;
  availableBalanceCents: number | null;
  instantAvailableBalanceCents: number | null;
  heldCents: number;
}
interface RequestMemberPayoutResult { payoutId: string; feeCents: number; netCents: number; replayed: boolean; }

// Mirrors EarningsPanel.tsx's own MAX_PREVIEW_CENTS: keeps an absurd/
// malformed typed amount from reaching instantFeePreviewCents's own
// assertCents and throwing mid-render. The server independently re-enforces
// this; this bound is only to keep the CLIENT from crashing on a bad preview.
const MAX_PREVIEW_CENTS = 2 ** 45;

// Identical to EarningsPanel.tsx's parseDollarsToCents: dollars-string input
// -> whole cents, or null when not a usable amount. UI-only validation, the
// server (requestMemberPayout) is the actual authority.
function parseDollarsToCents(s: string): number | null {
  const n = Number(s.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return cents < 100 || cents > MAX_PREVIEW_CENTS ? null : cents;
}

// RN has no crypto.randomUUID, timestamp+random nonce is fine (uniqueness,
// not secrecy; requestMemberPayout's REQUEST_ID_RE accepts 8-64
// [A-Za-z0-9_-]), identical to EarningsPanel.tsx's own mintRequestId.
const mintRequestId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;

export function MemberPayoutsPanel() {
  const t = useTokens();
  const [status, setStatus] = useState<MemberPayoutStatus | "loading" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [onboardBusy, setOnboardBusy] = useState(false);
  const [onboardError, setOnboardError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutError, setPayoutError] = useState<string | null>(null);
  const [payoutMessage, setPayoutMessage] = useState<string | null>(null);
  // ONE id per cash-out press, same as-built contract EarningsPanel's own
  // requestRef documents: a RETRY of the same press (same method+amount)
  // reuses this id so requestMemberPayout replays rather than double-pays; a
  // changed amount/method (or a press after a completed one) mints a new one.
  const requestRef = useRef<{ id: string; method: "standard" | "instant"; amountCents: number } | null>(null);
  // True while the Stripe-hosted onboarding browser is open, see
  // setupPayouts/the AppState listener below (tripwire 2, copied verbatim
  // from EarningsPanel.tsx).
  const onboardingInFlight = useRef(false);
  // Hoisted once per render, same as EarningsPanel/MemberPayoutsCard, so the
  // fee preview label and the Instant-button gating logic can never disagree
  // about what "the typed amount" currently parses to.
  const previewCents = parseDollarsToCents(amount);
  const previewFeeCents = previewCents != null ? instantFeePreviewCents(previewCents) : null;
  const belowInstantMin = previewCents != null && previewCents < INSTANT_PAYOUT_MIN_CENTS;
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
        const res = await callFn<object, MemberPayoutStatus>("getMemberPayoutStatus", {});
        if (cancelled) return;
        setStatus(res.data);
        // Default the amount field to the full available balance, but only
        // when the field is still empty (first load, or right after a
        // completed payout cleared it), never clobbering something the user
        // is mid-typing. Same as EarningsPanel/MemberPayoutsCard.
        setAmount((prev) => (prev === "" && res.data.availableBalanceCents != null)
          ? (res.data.availableBalanceCents / 100).toString() : prev);
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  // Tripwire 2 (EarningsPanel.tsx's own header comment): Stripe-hosted
  // Express onboarding opens in the in-app browser. The return/refresh URLs
  // are the server-built APP_ORIGIN web pages (fail-closed, never
  // client-supplied, createMemberOnboardingLink's contract); mobile doesn't
  // need to land on them, getMemberPayoutStatus re-syncs the gate flags live,
  // so re-polling on browser dismiss AND on app re-foreground covers both the
  // in-app-browser path and a user who bounced out to Safari/Chrome mid-flow.
  const setupPayouts = async () => {
    setOnboardBusy(true);
    setOnboardError(null);
    try {
      const res = await callFn<object, { url: string }>("createMemberOnboardingLink", {});
      onboardingInFlight.current = true;
      // Same platform asymmetry EarningsPanel.tsx documents: iOS resolves
      // openBrowserAsync only on a real dismissal, Android resolves with
      // {type:'opened'} as soon as the Custom Tab is on screen (the user is
      // still mid-flow). Only clear-and-reload on a real dismissal; on
      // 'opened' the flag stays armed so the AppState listener below
      // re-polls once the user actually backgrounds/foregrounds out.
      const result = await WebBrowser.openBrowserAsync(res.data.url);
      if (result.type !== "opened") {
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
        { amountCents: number; method: "standard" | "instant"; requestId: string },
        RequestMemberPayoutResult
      >("requestMemberPayout", { amountCents, method, requestId: requestRef.current.id });
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
      <View style={{ gap: tokens.space.xs }}>
        <Text variant="heading">Your payouts</Text>
        <Text muted>Money bands pay you lands here.</Text>
      </View>
      {status === "loading" && (
        <View style={{ gap: tokens.space.sm }}>
          <Skeleton height={16} width={128} />
          <Skeleton height={36} width={160} />
        </View>
      )}
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
          {!status.hasAccount ? (
            <View style={{ gap: tokens.space.sm }}>
              <Button title={onboardBusy ? "Opening Stripe…" : "Set up payouts"}
                onPress={() => void setupPayouts()} disabled={onboardBusy} style={{ alignSelf: "flex-start" }} />
              {onboardError && (
                <Callout tone="warning"><Text color={t.warning}>{onboardError}</Text></Callout>
              )}
            </View>
          ) : !status.payoutsEnabled ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm, flexWrap: "wrap" }}>
              <Text>Verifying your account</Text>
              <Pressable onPress={() => setReloadKey((k) => k + 1)}>
                <Text style={{ textDecorationLine: "underline" }}>Retry</Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ gap: tokens.space.md }}>
              <View style={{ gap: tokens.space.xs }}>
                <Text variant="meta" muted>Available balance</Text>
                {/* availableBalanceCents null renders "unavailable", never
                    $0.00, same reasoning as EarningsPanel's own comment: a
                    real 0 balance and "we don't know yet" must never look
                    the same. */}
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
          {status.heldCents > 0 && (
            <View style={{ gap: 2 }}>
              <Text>Waiting for you: {formatCents(status.heldCents)}</Text>
              <Text variant="meta" muted>
                It moves to your balance as soon as your account is verified.
              </Text>
            </View>
          )}
          <View style={{ gap: tokens.space.sm }}>
            <Text variant="title">History</Text>
            <PayoutHistoryList scope={{ kind: "user" }} />
          </View>
        </>
      )}
    </View>
  );
}
