"use client";
import { useEffect, useMemo, useState } from "react";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { GENRES, type ProfileDoc, type MusicianSubtype, type CuratorBookingDoc } from "@gatekeep/shared";
import { Chip, formatChipLabel } from "../portfolio/PortfolioForms";
import { MusicianCard, type MusicianCardProfile } from "../components/MusicianCard";
import { OfferComposer } from "./OfferComposer";
import { formatReliabilityLine } from "./BookingForms";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { IconUser, IconWarning } from "../ui/icons";

type MusicianRow = ProfileDoc & { id: string };

// MusicianSubtype ("solo"|"band") is the only act-size-shaped field actually
// present on a musician's own profile doc without an extra per-card read:
// BookingPreferences.actSize (the richer solo/duo/band value) only exists
// inside the per-card curatorBooking projection fetched below, and gating
// the FILTER on that would force every card's private read before the list
// could even render. Placeholder-grade per spec §1, same as GigBrowse's
// filters; sub-8 replaces the internals.
const ACT_SIZE_OPTIONS: MusicianSubtype[] = ["solo", "band"];
const ACT_SIZE_LABEL: Record<MusicianSubtype, string> = { solo: "Solo", band: "Band" };

function MusicianCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-gk border border-gk-border bg-gk-surface">
      <Skeleton className="h-36 w-full rounded-none sm:h-40" />
      <div className="grid gap-2 p-3.5">
        <Skeleton className="h-4 w-2/3" />
        <div className="flex gap-1.5">
          <Skeleton className="h-4 w-14 rounded-gk-sm" />
          <Skeleton className="h-4 w-16 rounded-gk-sm" />
        </div>
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

// One grid item: the card itself (whole-card-clickable, opens the public
// portfolio in a new tab so a curator comparing several acts doesn't lose
// their place in this grid) plus the "Offer a gig" action, which stays a
// sibling control rather than moving inside the card's own <a> (nesting an
// interactive control inside an anchor is invalid HTML, and GigCard/
// MusicianCard's locked spec is "whole card clickable" as ONE link).
function MusicianGridItem({ curatorProfileId, musician }: { curatorProfileId: string; musician: MusicianRow }) {
  const [booking, setBooking] = useState<CuratorBookingDoc | null | "loading">("loading");
  const [offering, setOffering] = useState(false);

  // Per-card private/curatorBooking read: the caller has curatorAccess via
  // their own approved curator profile membership (firestore.rules'
  // curatorBooking read rule), regardless of curatorProfileId; n+1 over the
  // list is accepted at v1 (spec §1 placeholder grade), same tradeoff as
  // GigBrowse's series-badge decision. No synchronous setBooking("loading")
  // reset here (set-state-in-effect): musician.id never changes for an
  // already-mounted card (each card is keyed by musician.id one level up in
  // MusicianBrowse, so a different musician is always a fresh mount), and
  // the initial useState("loading") above already covers first render.
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    getDoc(doc(db, `profiles/${musician.id}/private/curatorBooking`))
      .then((s) => { if (!cancelled) setBooking(s.exists() ? (s.data() as CuratorBookingDoc) : null); })
      .catch(() => { if (!cancelled) setBooking(null); });
    return () => { cancelled = true; };
  }, [musician.id]);

  // Availability + reliability: rendered only from data this card already
  // fetched above, never a price (rates are private by SP4 rule and the
  // locked card spec is explicit: NEVER a price on this card).
  //
  // Both reads tolerate a PARTIAL projection, in two different places:
  // `preferences?` is optional-chained here, while reliability's own absence
  // is handled inside formatReliabilityLine (which takes the field as
  // possibly-undefined and returns its no-history copy). That matters because
  // recomputeReliability can create this projection with reliability alone
  // (no rates, no preferences) for a musician who never opened the
  // booking-info editor, and rebuildBookingProjections used to delete the doc
  // outright (sp4 audit finding 1).
  const availabilityLabel = booking && booking !== "loading" && booking.preferences?.availabilityPattern
    ? formatChipLabel(booking.preferences.availabilityPattern)
    : null;
  const reliabilityLine = booking && booking !== "loading"
    ? formatReliabilityLine(booking.reliability)
    : null;

  // ProfileDoc.subtype is the MusicianSubtype|CuratorSubtype union; this
  // list is already filtered to type=="musician" by the query below, the
  // same narrowing cast the curator gig/series composer pages use for their
  // own `subtype as CuratorSubtype`.
  const cardProfile: MusicianCardProfile = { ...musician, subtype: musician.subtype as MusicianSubtype };

  return (
    <li className="grid gap-2">
      <MusicianCard
        musician={cardProfile}
        href={`/@${musician.handle}`}
        newTab
        availabilityLabel={availabilityLabel}
        reliabilityLine={reliabilityLine}
      />
      <Button type="button" variant="secondary" size="sm" className="justify-self-start"
        onClick={() => setOffering((v) => !v)}>
        {offering ? "Cancel" : "Offer a gig"}
      </Button>
      {offering && (
        <OfferComposer key={`${curatorProfileId}-${musician.id}`} curatorProfileId={curatorProfileId}
          musicianProfileId={musician.id} musicianName={musician.name} onClose={() => setOffering(false)} />
      )}
    </li>
  );
}

// Find musicians (apps/web/app/dashboard/curator/[profileId]/musicians/page.tsx):
// the curator-context browse of approved musician acts. type=="musician" &&
// status=="approved" is two pure-equality filters with no orderBy: provable
// under firestore.rules' profiles read rule (which only ever inspects
// `status`) via Firestore's automatic per-field indexing, no composite index
// needed (mirrors the SSR public pages' single-equality approved-profile
// reads, widened by one more equality clause).
export function MusicianBrowse({ curatorProfileId }: { curatorProfileId: string }) {
  const [musicians, setMusicians] = useState<MusicianRow[] | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const [genre, setGenre] = useState<string | null>(null);
  const [actSize, setActSize] = useState<MusicianSubtype | null>(null);

  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    getDocs(query(collection(db, "profiles"), where("type", "==", "musician"), where("status", "==", "approved")))
      .then((snap) => {
        if (cancelled) return;
        setMusicians(snap.docs.map((d) => ({ id: d.id, ...(d.data() as ProfileDoc) })));
      })
      .catch((e) => {
        if (cancelled) return;
        setMusicians([]);
        setError(e instanceof Error ? e.message : "Could not load musicians.");
      });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (musicians === "loading") return [];
    return musicians.filter((m) =>
      (genre === null || (m.portfolio?.genres ?? []).includes(genre))
      && (actSize === null || m.subtype === actSize));
  }, [musicians, genre, actSize]);

  return (
    <div className="grid gap-6">
      <div className="grid gap-4">
        <div className="grid gap-2">
          <span className="font-sora text-sm font-medium text-gk-text">Genre</span>
          <div className="flex flex-wrap gap-2">
            <Chip active={genre === null} onClick={() => setGenre(null)}>All genres</Chip>
            {GENRES.map((g) => (
              <Chip key={g} active={genre === g} onClick={() => setGenre(genre === g ? null : g)}>
                {formatChipLabel(g)}
              </Chip>
            ))}
          </div>
        </div>
        <div className="grid gap-2">
          <span className="font-sora text-sm font-medium text-gk-text">Act size</span>
          <div className="flex flex-wrap gap-2">
            <Chip active={actSize === null} onClick={() => setActSize(null)}>Any act size</Chip>
            {ACT_SIZE_OPTIONS.map((a) => (
              <Chip key={a} active={actSize === a} onClick={() => setActSize(actSize === a ? null : a)}>
                {ACT_SIZE_LABEL[a]}
              </Chip>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
        >
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          Could not load musicians: {error}
        </p>
      )}

      {musicians === "loading" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-label="Loading approved musicians">
          {[0, 1, 2, 3, 4, 5].map((i) => <MusicianCardSkeleton key={i} />)}
        </div>
      )}

      {musicians !== "loading" && filtered.length === 0 && !error && (
        <div className="rounded-gk border border-gk-border bg-gk-surface px-6 py-10 text-center">
          <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-gk-border/50 text-gk-muted">
            <IconUser size={20} aria-hidden="true" />
          </span>
          <p className="mt-3 font-syne text-base font-semibold text-gk-text">No musicians match these filters</p>
          <p className="mx-auto mt-1 max-w-sm font-sora text-sm text-gk-muted">
            Try a different genre or act size, or clear a filter to see every approved act.
          </p>
        </div>
      )}

      {musicians !== "loading" && filtered.length > 0 && (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((m) => <MusicianGridItem key={m.id} curatorProfileId={curatorProfileId} musician={m} />)}
        </ul>
      )}
    </div>
  );
}
