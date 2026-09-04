"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import type { GigBudget, GigDoc } from "@gatekeep/shared";
import { formatCents, BUDGET_STRUCTURE_LABEL } from "../gigs/GigForms";
import { formatGigDateTime, gigLocationLabel } from "../../app/u/[handle]/gigDisplay";
import { formatChipLabel } from "../portfolio/PortfolioForms";
import { Badge } from "../ui/badge";
import { IconGigs } from "../ui/icons";
import { cn } from "../lib/utils";

// Sub-project 9A task 8: the signature gig card, owner-locked in full
// (spec section 4 + docs/superpowers/mocks/sp9a/gigcard-anatomy.html option
// A, the "photo-forward" anatomy the owner picked). This is a pure
// presentational component: every page that renders one hands it exactly
// the fields it already has (no new Firestore reads or Storage lookups
// happen here or at any call site added by this task) and picks its own
// `badgeLabel` from data it can already prove is true: see CuratorProfile.tsx's
// own gigBadgeLabel for why the public gig grid can never claim a series'
// exact cadence ("Weekly") the way a member-scoped context eventually could.

export type GigCardGig = Pick<GigDoc, "title" | "startsAt" | "budget" | "wants" | "location"> & { id: string };

// Reuses formatCents + BUDGET_STRUCTURE_LABEL exactly as every other gig
// surface does (the gig detail page, the curator gigs list):
// the only new behavior is collapsing an exact min==max budget (the common
// case: a curator posts one flat number, not a real range) down to a single
// figure, closer to the locked mock's "$600 / set" example than the
// existing min-dash-max phrasing is for that case, while a genuine range
// still renders as one.
export function formatGigCardPrice(budget: GigBudget): string {
  const label = BUDGET_STRUCTURE_LABEL[budget.structure];
  return budget.minCents === budget.maxCents
    ? `${formatCents(budget.minCents)} ${label}`
    : `${formatCents(budget.minCents)}–${formatCents(budget.maxCents)} ${label}`;
}

// Shared by GigCard and every other card/hero that needs a no-photo-yet
// slot (event and ticket surfaces, the artist hero): a placeholder built
// from surface/border tokens only (never the page-level bg-0/1/2 gradient:
// DESIGN.md's harsh-gradient rule reserves that one for the page itself),
// topped with the same --gk-scrim every real photo gets, so a card with no
// photo yet still reads as "this card's photo slot" rather than a blank
// hole. The centered icon names what's missing (a gig vs. an artist), not a
// generic "no image" glyph (antislop R-04).
function PhotoPlaceholder({ icon }: { icon: ReactNode }) {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 flex items-center justify-center text-gk-muted/40"
      style={{ background: "linear-gradient(155deg, var(--gk-surface) 0%, var(--gk-border) 100%)" }}
    >
      {icon}
    </div>
  );
}

export { PhotoPlaceholder };

export function GigCard({ gig, badgeLabel, photoUrl, href, className }: {
  gig: GigCardGig;
  // Caller-supplied, not computed from gig.status/seriesId in here: what
  // counts as provable truth differs per page (a public browse grid can
  // never read a series' cadence; a curator managing their own gigs can).
  // Keeping GigCard a dumb presentational component lets each call site
  // pick a label it can actually stand behind instead of this component
  // guessing at data it doesn't have.
  badgeLabel: string;
  photoUrl?: string | null;
  href?: string;
  className?: string;
}) {
  const genres = gig.wants.genres.slice(0, 2);
  return (
    <Link
      href={href ?? `/gigs/${gig.id}`}
      className={cn(
        "group block overflow-hidden rounded-gk border border-gk-border bg-gk-surface outline-none transition-colors",
        // Hover: border warms + scrim lightens ONLY (locked spec, section 4).
        // No lift, no zoom, no shadow: DESIGN.md's elevation rule keeps
        // cards flat; this hover state deliberately does not touch
        // transform or box-shadow.
        "hover:border-gk-accent/50",
        // The whole-card focus ring every other interactive src/ui
        // component gets (Button/Input/Select's own focus-visible:ring-2
        // focus-visible:ring-gk-focus). No extra ring-offset/rounding
        // needed beyond that: a CSS box-shadow ring already follows the
        // element's own border-radius, so it hugs this card's rounded-gk
        // shape automatically.
        "focus-visible:ring-2 focus-visible:ring-gk-focus",
        className,
      )}
    >
      <div className="relative h-36 overflow-hidden sm:h-40">
        {photoUrl ? (
          // Plain <img>, same as CuratorForms.tsx's GalleryPhoto: a Storage
          // download URL, not a static asset next/image would optimize.
          <img src={photoUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <PhotoPlaceholder icon={<IconGigs size={28} aria-hidden="true" />} />
        )}
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-100 transition-opacity duration-200 group-hover:opacity-70"
          style={{ background: "var(--gk-scrim)" }}
        />
        <Badge variant="accent" className="absolute bottom-2.5 left-3">{badgeLabel}</Badge>
      </div>
      <div className="p-3.5">
        <h3 className="truncate font-syne text-base font-bold text-gk-text">{gig.title || "Untitled gig"}</h3>
        <p className="mt-0.5 truncate font-sora text-sm text-gk-muted">{gigLocationLabel(gig.location)}</p>
        {genres.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {genres.map((g) => (
              <Badge key={g} variant="secondary">{formatChipLabel(g)}</Badge>
            ))}
          </div>
        )}
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate font-sora text-sm text-gk-muted">{formatGigDateTime(gig.startsAt)}</span>
          {/* Filled pill, not bare ember text: DESIGN.md's accessibility
              note measures text-gk-accent at ~2.6-2.8:1 on a light-theme
              gk-surface (this card's own background), under AA, and names
              exactly this "price on a light surface" case with its
              prescribed fix, a filled chip/pill (ember fill + on-accent
              text) instead of bare accent-colored text. Badge's "default"
              variant already is that pairing; only the type scale is
              bumped up here so the price still reads as the card's one
              money moment, not a routine status label. */}
          <Badge variant="default" className="shrink-0 font-syne text-sm font-semibold">
            {formatGigCardPrice(gig.budget)}
          </Badge>
        </div>
      </div>
    </Link>
  );
}
