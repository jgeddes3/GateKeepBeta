"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { SaveCardModal } from "./SaveCardModal";
import { fetchDelinquentBookingIds } from "./delinquentBookings";
import {
  CURATOR_CARD_REQUIRED_MESSAGE, CURATOR_DELINQUENT_MESSAGE, MUSICIAN_PAYOUTS_REQUIRED_MESSAGE,
  DEPOSIT_PROCESSING_MESSAGE,
} from "@gatekeep/shared";

// SP5 Task 15 — renders the RIGHT inline recovery UI for one of the SP5
// gate/outcome messages the apply/offer/accept callables can throw VERBATIM
// (see @gatekeep/shared/messages.ts's header for the full accounting of
// which message means what and why the strings live there). Every caller in
// this app that surfaces a server error from applyToGig/offerGig/
// acceptBooking should render THIS instead of a plain error box — for a
// message this component doesn't specifically recognize (any other server
// error, including BOOKING_NOT_CONFIRMABLE_MESSAGE, CARD_DECLINED_MESSAGE,
// and ACCEPT_ABORTED_REFUNDED_MESSAGE — all of which are already
// self-explanatory server copy with no useful interactive follow-up) it
// falls through to a plain warning line, styled identically to the
// ErrorBox/friendly-wrapper convention every composer in this app already
// uses — so swapping it in is never a visual regression for an
// unrecognized message.

function WarnBox({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
      {children}
    </div>
  );
}

// CURATOR_CARD_REQUIRED_MESSAGE: opens SaveCardModal INLINE (no navigation —
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
      <p style={{ margin: 0, color: "#92400e" }}>{message}</p>
      <button onClick={() => setShowSaveCard(true)} style={{ width: "fit-content" }}>Save a card</button>
    </WarnBox>
  );
}

// CURATOR_DELINQUENT_MESSAGE: links to the affected booking(s) — a client
// query pinned to curatorProfileId == <this profile>, provable under
// firestore.rules' bookings read rule (isMember(resource.data.
// curatorProfileId) evaluates over a query-wide constant, same shape as
// BookingInbox's own curator-side queries). No orderBy — an equality-only
// compound query needs no extra composite index. Falls back to a link to the
// dashboard when the delinquent booking hasn't shown up in this query yet
// (a brief lag between the sweep flagging delinquency and this read, or —
// defensively — a delinquent flag with no single booking to blame).
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
      <p style={{ margin: 0, color: "#92400e" }}>{message}</p>
      {affected === "loading" ? null : affected.length > 0 ? (
        <p style={{ margin: 0 }}>
          {affected.map((id, i) => (
            <span key={id}>
              <Link href={`/dashboard/bookings/${id}`}>
                Go to the overdue booking{affected.length > 1 ? ` (${i + 1})` : ""}
              </Link>
              {i < affected.length - 1 ? ", " : ""}
            </span>
          ))}
        </p>
      ) : (
        <p style={{ margin: 0 }}><Link href="/dashboard">Go to your bookings</Link></p>
      )}
    </WarnBox>
  );
}

export function GatePrompt({ message, curatorProfileId, viewerIsMusician, onRetry }: {
  message: string;
  // Known only at curator-authored call sites (OfferComposer, BookingThread's
  // accept). Omitted at a musician-only call site (the apply flow) — the two
  // curator-keyed messages below simply never fire there, so this being
  // undefined never hides a prompt that should have shown.
  curatorProfileId?: string;
  // Review round 1 (low #9): acceptBooking's requireMusicianPayoutReady check
  // is unconditional — it fires the SAME MUSICIAN_PAYOUTS_REQUIRED_MESSAGE
  // whichever side clicks accept. A musician caller (or the apply flow,
  // which is ALWAYS the musician) can act on it — Finish payout setup is
  // THEIR page. A curator caller cannot: the blocked profile isn't theirs,
  // so the link would be actionable-looking but pointless. Defaults to false
  // (curator-authored call sites that never actually hit this message don't
  // need to think about it).
  viewerIsMusician?: boolean;
  // Re-runs the original action after the user fixes the gate (saves a
  // card). Only ever actually invoked from the card-gate's onSaved — every
  // other branch below is read-only.
  onRetry: () => void;
}) {
  if (message === CURATOR_CARD_REQUIRED_MESSAGE && curatorProfileId) {
    return <CuratorCardGate message={message} curatorProfileId={curatorProfileId} onRetry={onRetry} />;
  }
  if (message === CURATOR_DELINQUENT_MESSAGE && curatorProfileId) {
    return <CuratorDelinquentGate message={message} curatorProfileId={curatorProfileId} />;
  }
  if (message === MUSICIAN_PAYOUTS_REQUIRED_MESSAGE) {
    return viewerIsMusician ? (
      <WarnBox>
        <p style={{ margin: 0, color: "#92400e" }}>{message}</p>
        <p style={{ margin: 0 }}><Link href="/dashboard/earnings">Finish payout setup →</Link></p>
      </WarnBox>
    ) : (
      <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
        The musician hasn&apos;t finished payout setup yet — they&apos;ve been notified.
      </p>
    );
  }
  // DEPOSIT_PROCESSING_MESSAGE is NOT a failure (the booking confirms
  // automatically once the charge clears) — info-styled (blue), not the
  // warning amber every other branch uses.
  if (message === DEPOSIT_PROCESSING_MESSAGE) {
    return (
      <p style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, padding: 12, color: "#1e40af", margin: 0 }}>
        {message}
      </p>
    );
  }
  // Everything else — BOOKING_NOT_CONFIRMABLE_MESSAGE (the musician-side
  // neutral notice), CARD_DECLINED_MESSAGE, ACCEPT_ABORTED_REFUNDED_MESSAGE,
  // and any unrelated server error — is already actionable/informative
  // server copy on its own; same visual treatment this app's ErrorBox
  // convention has always used.
  return (
    <p style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8, padding: 12, color: "#92400e", margin: 0 }}>
      {message}
    </p>
  );
}
