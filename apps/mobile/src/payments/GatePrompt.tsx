import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { SaveCardSheet } from "./SaveCardSheet";
import { fetchDelinquentBookingIds } from "./delinquentBookings";
import {
  CURATOR_CARD_REQUIRED_MESSAGE, CURATOR_DELINQUENT_MESSAGE, MUSICIAN_PAYOUTS_REQUIRED_MESSAGE,
  DEPOSIT_PROCESSING_MESSAGE,
} from "@gatekeep/shared";
import { Text, Button, Callout } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// SP5 Task 15: renders the RIGHT inline recovery UI for one of the SP5
// gate/outcome messages the apply/offer/accept callables can throw VERBATIM
// (see @gatekeep/shared/messages.ts's header for the full accounting of
// which message means what and why the strings live there). Every caller in
// this app that surfaces a server error from applyToGig/offerGig/
// acceptBooking should render THIS instead of a plain error box, for a
// message this component doesn't specifically recognize (any other server
// error, including BOOKING_NOT_CONFIRMABLE_MESSAGE, CARD_DECLINED_MESSAGE,
// and ACCEPT_ABORTED_REFUNDED_MESSAGE, all of which are already
// self-explanatory server copy with no useful interactive follow-up) it
// falls through to a plain warning line, styled identically to the
// ErrorBox/friendly-wrapper convention every composer in this app already
// uses, so swapping it in is never a visual regression for an
// unrecognized message.
//
// RN port of apps/web/src/payments/GatePrompt.tsx (SP5b), branch-for-branch
// identical; only the rendering primitives and navigation differ (Link href
// -> expo-router's useRouter().push, SaveCardModal -> SaveCardSheet). See
// this file's task brief for the full, exhaustive list of sanctioned
// differences from web.

function WarnBox({ children }: { children: React.ReactNode }) {
  return <Callout tone="warning" style={{ gap: tokens.space.sm }}>{children}</Callout>;
}

// CURATOR_CARD_REQUIRED_MESSAGE: opens SaveCardSheet INLINE (no navigation,
// the caller is mid-action) and retries the original action once the card is
// saved, per the plan's exact prescription.
function CuratorCardGate({ message, curatorProfileId, onRetry }: {
  message: string; curatorProfileId: string; onRetry: () => void;
}) {
  const t = useTokens();
  const [showSaveCard, setShowSaveCard] = useState(false);
  if (showSaveCard) {
    return (
      <SaveCardSheet profileId={curatorProfileId}
        onSaved={() => { setShowSaveCard(false); onRetry(); }}
        onClose={() => setShowSaveCard(false)} />
    );
  }
  return (
    <WarnBox>
      <Text color={t.warning}>{message}</Text>
      <Button title="Save a card" variant="secondary" onPress={() => setShowSaveCard(true)}
        style={{ alignSelf: "flex-start" }} />
    </WarnBox>
  );
}

// CURATOR_DELINQUENT_MESSAGE: links to the affected booking(s), a client
// query pinned to curatorProfileId == <this profile>, provable under
// firestore.rules' bookings read rule (isMember(resource.data.
// curatorProfileId) evaluates over a query-wide constant, same shape as
// BookingInbox's own curator-side queries). No orderBy, an equality-only
// compound query needs no extra composite index. Falls back to a link to the
// dashboard when the delinquent booking hasn't shown up in this query yet
// (a brief lag between the sweep flagging delinquency and this read, or,
// defensively, a delinquent flag with no single booking to blame).
function CuratorDelinquentGate({ message, curatorProfileId }: { message: string; curatorProfileId: string }) {
  const t = useTokens();
  const router = useRouter();
  const [affected, setAffected] = useState<string[] | "loading">("loading");
  useEffect(() => {
    let cancelled = false;
    fetchDelinquentBookingIds(curatorProfileId)
      .then((ids) => { if (!cancelled) setAffected(ids); })
      .catch(() => { if (!cancelled) setAffected([]); });
    return () => { cancelled = true; };
  }, [curatorProfileId]);
  // Intentional web-parity tone split: this in-flow gate reads amber
  // (warning), while the standalone DelinquencyBanner / EarningsPanel notices
  // read red (destructive). Web draws the same distinction (its WarnBox here
  // is gk-warning; its banner is gk-destructive), so mobile keeps it.
  return (
    <WarnBox>
      <Text color={t.warning}>{message}</Text>
      {affected === "loading" ? null : affected.length > 0 ? (
        <Text>
          {affected.map((id, i) => (
            <Text key={id}>
              <Text style={{ textDecorationLine: "underline" }}
                onPress={() => router.push({ pathname: "/booking/[bookingId]", params: { bookingId: id } })}>
                Go to the overdue booking{affected.length > 1 ? ` (${i + 1})` : ""}
              </Text>
              {i < affected.length - 1 ? ", " : ""}
            </Text>
          ))}
        </Text>
      ) : (
        <Text style={{ textDecorationLine: "underline" }} onPress={() => router.push("/(curator)/bookings")}>
          Go to your bookings
        </Text>
      )}
    </WarnBox>
  );
}

export function GatePrompt({ message, curatorProfileId, viewerIsMusician, onRetry }: {
  message: string;
  // Known only at curator-authored call sites (OfferComposer, BookingThread's
  // accept). Omitted at a musician-only call site (the apply flow), the two
  // curator-keyed messages below simply never fire there, so this being
  // undefined never hides a prompt that should have shown.
  curatorProfileId?: string;
  // Review round 1 (low #9): acceptBooking's requireMusicianPayoutReady check
  // is unconditional, it fires the SAME MUSICIAN_PAYOUTS_REQUIRED_MESSAGE
  // whichever side clicks accept. A musician caller (or the apply flow,
  // which is ALWAYS the musician) can act on it, Finish payout setup is
  // THEIR page. A curator caller cannot: the blocked profile isn't theirs,
  // so the link would be actionable-looking but pointless. Defaults to false
  // (curator-authored call sites that never actually hit this message don't
  // need to think about it).
  viewerIsMusician?: boolean;
  // Re-runs the original action after the user fixes the gate (saves a
  // card). Only ever actually invoked from the card-gate's onSaved, every
  // other branch below is read-only.
  onRetry: () => void;
}) {
  const t = useTokens();
  const router = useRouter();
  // L11 (branch audit): the curator-card and delinquent recovery UIs are the
  // CURATOR side's to act on, CuratorCardGate fires createSetupIntent against
  // curatorProfileId, and the delinquent-booking links go to the curator's own
  // bookings. But acceptBooking checks the curator's card/delinquency WHICHEVER
  // side clicks accept, so a MUSICIAN-side accepter can trip these exact
  // messages. Showing them a live "Save a card" button on a profile they are not
  // a member of is a dead action (the createSetupIntent call would fail on the
  // curator's profileId), the same confused-deputy shape the payouts branch
  // below already guards with viewerIsMusician. So gate these two on the viewer
  // being the curator side; a musician-side accepter gets a neutral, informative
  // notice instead (BOOKING_NOT_CONFIRMABLE-style), never the curator's own
  // recovery action.
  const viewerIsCurator = !viewerIsMusician;
  if (message === CURATOR_CARD_REQUIRED_MESSAGE && curatorProfileId && viewerIsCurator) {
    return <CuratorCardGate message={message} curatorProfileId={curatorProfileId} onRetry={onRetry} />;
  }
  if (message === CURATOR_DELINQUENT_MESSAGE && curatorProfileId && viewerIsCurator) {
    return <CuratorDelinquentGate message={message} curatorProfileId={curatorProfileId} />;
  }
  if (message === CURATOR_CARD_REQUIRED_MESSAGE || message === CURATOR_DELINQUENT_MESSAGE) {
    // Reached only by a musician-side accepter (viewerIsMusician), or a call
    // site with no curatorProfileId to act on. Neutral notice, never the
    // curator's recovery UI, mirrors the non-musician branch of
    // MUSICIAN_PAYOUTS_REQUIRED_MESSAGE below.
    return (
      <Callout tone="warning">
        <Text color={t.warning}>
          {message === CURATOR_DELINQUENT_MESSAGE
            ? "The curator has an overdue payment to resolve before this booking can be confirmed, they've been notified."
            : "The curator needs to finish payment setup before this booking can be confirmed, they've been notified."}
        </Text>
      </Callout>
    );
  }
  if (message === MUSICIAN_PAYOUTS_REQUIRED_MESSAGE) {
    return viewerIsMusician ? (
      <WarnBox>
        <Text color={t.warning}>{message}</Text>
        <Text style={{ textDecorationLine: "underline" }} onPress={() => router.push("/(musician)/dashboard")}>
          Finish payout setup →
        </Text>
      </WarnBox>
    ) : (
      <Callout tone="warning">
        <Text color={t.warning}>The musician hasn&apos;t finished payout setup yet, they&apos;ve been notified.</Text>
      </Callout>
    );
  }
  // DEPOSIT_PROCESSING_MESSAGE is NOT a failure (the booking confirms
  // automatically once the charge clears), a neutral/informational surface,
  // not the warning amber every other branch uses.
  if (message === DEPOSIT_PROCESSING_MESSAGE) {
    return (
      <Callout tone="neutral">
        <Text>{message}</Text>
      </Callout>
    );
  }
  // Everything else: BOOKING_NOT_CONFIRMABLE_MESSAGE (the musician-side
  // neutral notice), CARD_DECLINED_MESSAGE, ACCEPT_ABORTED_REFUNDED_MESSAGE,
  // and any unrelated server error, is already actionable/informative
  // server copy on its own; same visual treatment this app's ErrorBox
  // convention has always used.
  return (
    <Callout tone="warning">
      <Text color={t.warning}>{message}</Text>
    </Callout>
  );
}
