"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { collection, doc, getDoc, getDocs, limit, orderBy, query, where } from "firebase/firestore";
import { getFirebase } from "../../../../src/lib/firebase";
import { formatCents } from "../../../../src/gigs/GigForms";
import { formatGigTime, gigLocationLabel } from "../gigDisplay";
import { DateBlockRow } from "../../../../src/components/DateBlockRow";
import { Skeleton } from "../../../../src/ui/skeleton";
import { IconBookings } from "../../../../src/ui/icons";
import type { ShowEntry } from "../page";
import type { CuratorBookingDoc, PaymentDoc, ReliabilitySummary } from "@gatekeep/shared";

// Sub-project 9A task 9, spec section 6.5: three render depths over data the
// app already reads elsewhere, permission-denied tolerant at every extra
// depth (the SP4 idiom app/gigs/[gigId]/page.tsx's useSeriesFillMode
// establishes: always attempt the read, treat a denial as "this depth just
// doesn't apply to this viewer" rather than an error). No depth here adds a
// new query SHAPE: both reads below are byte-identical in structure to ones
// MusicianBrowse.tsx (curatorBooking) and EarningsPanel.tsx (bookings +
// payments) already perform, just pointed at ONE profile's already-known
// gigIds instead of a browse grid or a payouts summary.

type Reliability = ReliabilitySummary | null | "loading";

// Curator depth: the exact profiles/{id}/private/curatorBooking read
// MusicianBrowse.tsx's MusicianGridItem already performs per card (that
// read's own comment: "the caller has curatorAccess via their own approved
// curator profile membership, regardless of curatorProfileId"). A signed-
// out visitor, a fan, a musician, or an unapproved curator all get
// permission-denied here, which resolves to `null` (nothing shown), the
// same as a doc that never existed.
function useReliabilitySummary(profileId: string): Reliability {
  const [state, setState] = useState<Reliability>("loading");
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    getDoc(doc(db, `profiles/${profileId}/private/curatorBooking`))
      .then((s) => { if (!cancelled) setState(s.exists() ? (s.data() as CuratorBookingDoc).reliability : null); })
      .catch(() => { if (!cancelled) setState(null); });
    return () => { cancelled = true; };
  }, [profileId]);
  return state;
}

type ShowStats = {
  earnedCents: number | null;
  trueUp: { extraMinutes: number; extraSongs: number } | null;
};

// Member depth: the SAME query EarningsPanel.tsx's usePaymentRows already
// runs (bookings where musicianProfileId==profileId, newest-updated 50,
// then an n+1 getDocs over each booking's payments subcollection),
// re-keyed by gigId instead of flattened into a payout list. A viewer who
// isn't a member of THIS profile gets permission-denied on the top-level
// bookings query and sees nothing extra, same as EarningsPanel's own
// error handling; a permission-denied on any ONE booking's payments
// subcollection just drops that booking rather than the whole page.
function useMemberShowStats(profileId: string): Map<string, ShowStats> | "loading" {
  const [rows, setRows] = useState<Map<string, ShowStats> | "loading">("loading");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const map = new Map<string, ShowStats>();
      try {
        const { db } = getFirebase();
        const bookingsSnap = await getDocs(query(
          collection(db, "bookings"), where("musicianProfileId", "==", profileId),
          orderBy("updatedAt", "desc"), limit(50)));
        const perBooking = await Promise.all(bookingsSnap.docs.map(async (b) => {
          try {
            const paySnap = await getDocs(collection(db, `bookings/${b.id}/payments`));
            return paySnap.docs.map((d) => d.data() as PaymentDoc);
          } catch {
            return []; // permission-denied/offline on one booking's subcollection: drop it, not the whole list
          }
        }));
        for (const payment of perBooking.flat()) {
          map.set(payment.gigId, {
            earnedCents: payment.transfer.status === "transferred" ? payment.transfer.amountCents : null,
            trueUp: payment.settlement.trueUp
              ? { extraMinutes: payment.settlement.trueUp.extraMinutes, extraSongs: payment.settlement.trueUp.extraSongs }
              : null,
          });
        }
      } catch {
        // permission-denied on the top-level query (viewer isn't a member of
        // this profile at all): the empty map below already renders nothing.
      }
      if (!cancelled) setRows(map);
    })();
    return () => { cancelled = true; };
  }, [profileId]);
  return rows;
}

function MemberStatsLine({ show, stats }: { show: ShowEntry; stats: ShowStats }) {
  const parts = [
    stats.earnedCents != null ? `${formatCents(stats.earnedCents)} earned` : null,
    `${show.durationMinutes} min`,
    stats.trueUp ? `true-up: +${stats.trueUp.extraMinutes} min, +${stats.trueUp.extraSongs} songs` : null,
  ].filter((p): p is string => p != null);
  return <p className="pb-2 pl-[58px] pr-2 font-sora text-xs text-gk-muted">{parts.join(" · ")}</p>;
}

export function PastShowsList({ profileId, handle, name, shows }: {
  profileId: string; handle: string; name: string; shows: ShowEntry[];
}) {
  const reliability = useReliabilitySummary(profileId);
  const memberStats = useMemberShowStats(profileId);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <Link href={`/@${handle}`} className="font-sora text-sm text-gk-muted hover:text-gk-text">
        &larr; {name}
      </Link>
      <h1 className="mt-4 font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Past shows</h1>

      {/* Curator depth: an aggregate summary above the list, not per-row
          (ReliabilitySummary is profile-scoped, not show-scoped). */}
      {reliability === "loading" ? (
        <Skeleton className="mt-6 h-11 w-64" />
      ) : reliability ? (
        <div className="mt-6 flex w-fit items-center gap-2 rounded-gk border border-gk-border bg-gk-surface px-3.5 py-2.5">
          <IconBookings size={18} className="text-gk-muted" aria-hidden="true" />
          <p className="font-sora text-sm text-gk-text">
            {reliability.completedCount} show{reliability.completedCount === 1 ? "" : "s"} played
            {" · "}{reliability.noShowCount} no-show{reliability.noShowCount === 1 ? "" : "s"}
          </p>
        </div>
      ) : null}

      {shows.length === 0 ? (
        <div className="mt-8 rounded-gk border border-gk-border bg-gk-surface px-6 py-10 text-center">
          <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-gk-border/50 text-gk-muted">
            <IconBookings size={20} aria-hidden="true" />
          </span>
          <p className="mt-3 font-syne text-base font-semibold text-gk-text">No past shows yet</p>
          <p className="mx-auto mt-1 max-w-sm font-sora text-sm text-gk-muted">
            Shows appear here once a booking with {name} wraps.
          </p>
        </div>
      ) : (
        <ul className="mt-8 divide-y divide-gk-border/60">
          {shows.map((show) => {
            const stats = memberStats !== "loading" ? memberStats.get(show.gigId) : undefined;
            return (
              <li key={show.gigId}>
                <DateBlockRow
                  dateMs={show.startsAtMs}
                  title={show.title || "Untitled gig"}
                  subtitle={`${gigLocationLabel(show.location)} · ${formatGigTime(show.startsAtMs)}`}
                  href={`/gigs/${show.gigId}`}
                  detail={show.otherProfileName}
                />
                {stats && <MemberStatsLine show={show} stats={stats} />}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
