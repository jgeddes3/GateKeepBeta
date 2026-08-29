"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { SaveCardModal } from "./SaveCardModal";
import { fetchDelinquentBookingIds } from "./delinquentBookings";
import {
  CURATOR_CARD_REQUIRED_MESSAGE, CURATOR_DELINQUENT_MESSAGE, MUSICIAN_PAYOUTS_REQUIRED_MESSAGE,
  DEPOSIT_PROCESSING_MESSAGE,
} from "@gatekeep/shared";
import { Button } from "../ui/button";
import { IconInfo, IconWarning } from "../ui/icons";

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

function WarnBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-3">
      {children}
    </div>
  );
}

function WarnLine({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
      <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

// CURATOR_CARD_REQUIRED_MESSAGE: opens SaveCardModal INLINE (no navigation:
// the caller is mid-action) and retries the original action once the card is
// saved, per the plan's exact prescription.
function CuratorCardGate({ message, curatorProfileId, onRetry }: {
  message: string; curatorProfileId: string; onRetry: () => void;
}) {
  const [showSaveCard, setShowSaveCard] = useState(false);
  if (showSaveCard) {
    return (
      <SaveCardModal profileId={curatorProfileId}
        onSaved={() => { setShowSaveCard(false); onRetry(); }}
        onClose={() => setShowSaveCard(false)} />
    );
  }
  return (
    <WarnBox>
      <p className="flex items-start gap-2 font-sora text-sm text-gk-warning">
        <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        {message}
      </p>
      <Button onClick={() => setShowSaveCard(true)} size="sm" className="w-fit">Save a card</Button>
    </WarnBox>
  );
}

// CURATOR_DELINQUENT_MESSAGE: links to the affected booking(s): a client
// query pinned to curatorProfileId == <this profile>, provable under
// firestore.rules' bookings read rule (isMember(resource.data.
// curatorProfileId) evaluates over a query-wide constant, same shape as
// BookingInbox's own curator-side queries). No orderBy: an equality-only
// compound query needs no extra composite index. Falls back to a link to the
// dashboard when the delinquent booking hasn't shown up in this query yet
// (a brief lag between the sweep flagging delinquency and this read, or,
// defensively, a delinquent flag with no single booking to blame).
function CuratorDelinquentGate({ message, curatorProfileId }: { message: string; curatorProfileId: string }) {
  const [affected, setAffected] = useState<string[] | "loading">("loading");
  useEffect(() => {
    let cancelled = false;
    fetchDelinquentBookingIds(curatorProfileId)
      .then((ids) => { if (!cancelled) setAffected(ids); })
      .catch(() => { if (!cancelled) setAffected([]); });
    return () => { cancelled = true; };
  }, [curatorProfileId]);
  return (
    <WarnBox>
      <p className="flex items-start gap-2 font-sora text-sm text-gk-warning">
        <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        {message}
      </p>
      {affected === "loading" ? null : affected.length > 0 ? (
        <p className="font-sora text-sm text-gk-text">
          {affected.map((id, i) => (
            <span key={id}>
              <Link href={`/dashboard/bookings/${id}`} className="text-gk-text underline underline-offset-4 hover:text-gk-accent">
                Go to the overdue booking{affected.length > 1 ? ` (${i + 1})` : ""}
              </Link>
              {i < affected.length - 1 ? ", " : ""}
            </span>
          ))}
        </p>
      ) : (
        <p className="font-sora text-sm text-gk-text">
          <Link href="/dashboard" className="text-gk-text underline underline-offset-4 hover:text-gk-accent">Go to your bookings</Link>
        </p>
      )}
    </WarnBox>
  );
}

export function GatePrompt({ message, curatorProfileId, viewerIsMusician, onRetry }: {
  message: string;
  // Known only at curator-authored call sites (OfferComposer, BookingThread's
  // accept). Omitted at a musician-only call site (the apply flow): the two
  // curator-keyed messages below simply never fire there, so this being
  // undefined never hides a prompt that should have shown.
  curatorProfileId?: string;
  // Review round 1 (low #9): acceptBooking's requireMusicianPayoutReady check
  // is unconditional: it fires the SAME MUSICIAN_PAYOUTS_REQUIRED_MESSAGE
  // whichever side clicks accept. A musician caller (or the apply flow,
  // which is ALWAYS the musician) can act on it: Finish payout setup is
  // THEIR page. A curator caller cannot: the blocked profile isn't theirs,
  // so the link would be actionable-looking but pointless. Defaults to false
  // (curator-authored call sites that never actually hit this message don't
  // need to think about it).
  viewerIsMusician?: boolean;
  // Re-runs the original action after the user fixes the gate (saves a
  // card). Only ever actually invoked from the card-gate's onSaved: every
  // other branch below is read-only.
  onRetry: () => void;
}) {
  // L11 (branch audit): the curator-card and delinquent recovery UIs are the
  // CURATOR side's to act on: CuratorCardGate fires createSetupIntent against
  // curatorProfileId, and the delinquent-booking links go to the curator's own
  // bookings. But acceptBooking checks the curator's card/delinquency WHICHEVER
  // side clicks accept, so a MUSICIAN-side accepter can trip these exact
  // messages. Showing them a live "Save a card" button on a profile they are not
  // a member of is a dead action (the createSetupIntent call would fail on the
  // curator's profileId): the same confused-deputy shape the payouts branch
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
    // curator's recovery UI (mirrors the non-musician branch of
    // MUSICIAN_PAYOUTS_REQUIRED_MESSAGE below).
    return (
      <WarnLine>
        {message === CURATOR_DELINQUENT_MESSAGE
          ? "The curator has an overdue payment to resolve before this booking can be confirmed. They've been notified."
          : "The curator needs to finish payment setup before this booking can be confirmed. They've been notified."}
      </WarnLine>
    );
  }
  if (message === MUSICIAN_PAYOUTS_REQUIRED_MESSAGE) {
    return viewerIsMusician ? (
      <WarnBox>
        <p className="flex items-start gap-2 font-sora text-sm text-gk-warning">
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {message}
        </p>
        <Button asChild variant="link" className="h-auto w-fit p-0">
          <Link href="/dashboard/earnings">Finish payout setup →</Link>
        </Button>
      </WarnBox>
    ) : (
      <WarnLine>The musician hasn&apos;t finished payout setup yet. They&apos;ve been notified.</WarnLine>
    );
  }
  // DEPOSIT_PROCESSING_MESSAGE is NOT a failure (the booking confirms
  // automatically once the charge clears): info-styled, not the warning
  // treatment every other branch uses. No gk token names an "info" status
  // (DESIGN.md's "Status tints" names exactly three: success/warning/
  // destructive), so this reuses gk-muted/gk-border/gk-surface, the
  // system's own neutral-informational combination, rather than inventing a
  // fourth status color DESIGN.md doesn't define.
  if (message === DEPOSIT_PROCESSING_MESSAGE) {
    return (
      <p className="flex items-start gap-2 rounded-gk border border-gk-border bg-gk-surface px-3.5 py-2.5 font-sora text-sm text-gk-text">
        <IconInfo size={16} className="mt-0.5 shrink-0 text-gk-muted" aria-hidden="true" />
        {message}
      </p>
    );
  }
  // Everything else (BOOKING_NOT_CONFIRMABLE_MESSAGE, the musician-side
  // neutral notice, CARD_DECLINED_MESSAGE, ACCEPT_ABORTED_REFUNDED_MESSAGE,
  // and any unrelated server error) is already actionable/informative
  // server copy on its own; same visual treatment this app's ErrorBox
  // convention has always used.
  return <WarnLine>{message}</WarnLine>;
}
