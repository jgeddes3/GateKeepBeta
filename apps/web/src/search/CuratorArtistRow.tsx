"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { doc, getDoc } from "firebase/firestore";
import { distanceLabel, type CuratorBookingDoc, type SearchResult } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { formatChipLabel } from "../portfolio/PortfolioForms";
import { formatReliabilityLine } from "../bookings/BookingForms";
import { OfferComposer } from "../bookings/OfferComposer";
import { Button } from "../ui/button";
import { ACT_SIZE_LABEL } from "./ResultRows";

// The curator search result row: a private/curatorBooking per-row read
// (controller ruling 2), n+1 accepted at v1, tolerating a summary-only
// projection with reliability but no preferences (rebuild can seed the doc
// from a reliability event alone, before the musician has ever saved
// booking info). Availability and reliability only, never a rate: rates are
// private by SP4 rule and the locked musician-card spec is explicit that a
// price never renders on this surface, and this row keeps that same rule.
// "Offer a gig" opens the same OfferComposer instance per row.
export function CuratorArtistRow({ curatorProfileId, r }: { curatorProfileId: string; r: SearchResult }) {
  const [booking, setBooking] = useState<CuratorBookingDoc | null | "loading">("loading");
  const [offering, setOffering] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    getDoc(doc(db, `profiles/${r.id}/private/curatorBooking`))
      .then((s) => { if (!cancelled) setBooking(s.exists() ? (s.data() as CuratorBookingDoc) : null); })
      .catch(() => { if (!cancelled) setBooking(null); });
    return () => { cancelled = true; };
  }, [r.id]);

  const availabilityLabel = booking && booking !== "loading" && booking.preferences?.availabilityPattern
    ? formatChipLabel(booking.preferences.availabilityPattern)
    : null;
  const reliabilityLine = booking && booking !== "loading" ? formatReliabilityLine(booking.reliability) : null;

  const meta = [
    r.actSize ? ACT_SIZE_LABEL[r.actSize] : null,
    r.hasAudio ? "Has audio" : null,
    r.distanceMeters != null ? distanceLabel(r.distanceMeters) : null,
  ].filter((p): p is string => !!p).join(" · ");

  return (
    <div className="grid gap-2 border-b border-gk-border py-3 last:border-b-0">
      <Link
        href={`/u/${r.handle}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 rounded-gk-sm px-2 py-1 outline-none transition-colors hover:bg-gk-border/25 focus-visible:ring-2 focus-visible:ring-gk-focus"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-syne text-sm font-semibold text-gk-text">{r.title}</p>
          {r.genres.length > 0 && <p className="truncate font-sora text-xs text-gk-muted">{r.genres.map(formatChipLabel).join(", ")}</p>}
          {meta && <p className="truncate font-sora text-xs text-gk-muted">{meta}</p>}
          {availabilityLabel && <p className="mt-1 font-sora text-xs text-gk-muted">{availabilityLabel}</p>}
          {reliabilityLine && <p className="font-sora text-xs text-gk-muted">{reliabilityLine}</p>}
        </div>
      </Link>
      <Button type="button" variant="secondary" size="sm" className="justify-self-start" onClick={() => setOffering((v) => !v)}>
        {offering ? "Cancel" : "Offer a gig"}
      </Button>
      {offering && (
        <OfferComposer
          key={`${curatorProfileId}-${r.id}`}
          curatorProfileId={curatorProfileId}
          musicianProfileId={r.id}
          musicianName={r.title}
          onClose={() => setOffering(false)}
        />
      )}
    </div>
  );
}
