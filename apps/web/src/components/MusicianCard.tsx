"use client";
import Link from "next/link";
import type { MusicianSubtype } from "@gatekeep/shared";
import { formatChipLabel } from "../portfolio/PortfolioForms";
import { Badge } from "../ui/badge";
import { IconUser } from "../ui/icons";
import { cn } from "../lib/utils";
import { PhotoPlaceholder } from "./GigCard";

// Sub-project 9A task 8: the musician card, the same locked skeleton as
// GigCard (spec section 4: "same skeleton adapted"): photo + scrim, Syne
// name, genre/act-size chips, an availability line. Deliberately NEVER a
// price: rates are private by SP4 rule, so unlike GigCard there is no
// bottom-right money slot at all. No status badge either (the locked spec
// gives GigCard's photo a badge; it says nothing of the sort for this
// card), so the photo area is photo/placeholder + scrim only.

const ACT_SIZE_LABEL: Record<MusicianSubtype, string> = { solo: "Solo", band: "Band" };

export type MusicianCardProfile = {
  id: string;
  handle: string;
  name: string;
  subtype: MusicianSubtype;
  portfolio?: { genres?: string[] };
};

export function MusicianCard({
  musician, href, photoUrl, availabilityLabel, reliabilityLine, newTab, className,
}: {
  musician: MusicianCardProfile;
  href?: string;
  photoUrl?: string | null;
  // Only ever populated from data the calling page ALREADY fetched for this
  // card (e.g. MusicianBrowse's existing per-card private/curatorBooking
  // read): never a reason for this component to fetch anything itself.
  availabilityLabel?: string | null;
  reliabilityLine?: string | null;
  // MusicianBrowse's existing behavior: opening a candidate's portfolio in
  // a new tab so a curator comparing several acts doesn't lose their place
  // in the browse grid. Preserved here as an explicit opt-in rather than
  // silently dropped by the restyle.
  newTab?: boolean;
  className?: string;
}) {
  const genres = musician.portfolio?.genres ?? [];
  return (
    <Link
      href={href ?? `/@${musician.handle}`}
      target={newTab ? "_blank" : undefined}
      rel={newTab ? "noopener noreferrer" : undefined}
      className={cn(
        "group block overflow-hidden rounded-gk border border-gk-border bg-gk-surface transition-colors",
        // Same hover contract as GigCard: border warms + scrim lightens
        // only, no lift, no zoom, no shadow.
        "hover:border-gk-accent/50",
        className,
      )}
    >
      <div className="relative h-36 overflow-hidden sm:h-40">
        {photoUrl ? (
          <img src={photoUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <PhotoPlaceholder icon={<IconUser size={28} aria-hidden="true" />} />
        )}
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-100 transition-opacity duration-200 group-hover:opacity-70"
          style={{ background: "var(--gk-scrim)" }}
        />
      </div>
      <div className="p-3.5">
        <h3 className="truncate font-syne text-base font-bold text-gk-text">{musician.name}</h3>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Badge variant="secondary">{ACT_SIZE_LABEL[musician.subtype]}</Badge>
          {genres.map((g) => <Badge key={g} variant="secondary">{formatChipLabel(g)}</Badge>)}
        </div>
        {availabilityLabel && <p className="mt-2 font-sora text-sm text-gk-muted">{availabilityLabel}</p>}
        {reliabilityLine && <p className="mt-1 font-sora text-xs text-gk-muted">{reliabilityLine}</p>}
      </div>
    </Link>
  );
}
