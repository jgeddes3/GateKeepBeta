import Link from "next/link";
import type { ReactNode } from "react";
import { LAUNCH_TIMEZONE } from "@gatekeep/shared";
import { cn } from "../lib/utils";

// Sub-project 9A task 9: the date-block row, locked in spec section 4 for
// every schedule context product-wide (artist Shows box, the new past-shows
// page, and future calendar work): a 46px date chip (ember month, Syne day
// numeral) + title + muted venue/time line + right-aligned detail. This is
// the FIRST implementation of the pattern (it didn't exist before this
// task). GigCard/MusicianCard are its sibling locked skeletons, so this
// lives alongside them.

// Post-launch review fix: DateChip is aria-hidden (it's a purely visual
// month/day glyph, no year), so a screen-reader visitor got no date at all
// on any DateBlockRow row, only whatever the caller's own subtitle happens
// to spell out (frequently just a time, per each call site below). This
// full date, WITH the year, also resolves the sibling "multi-year
// ambiguity" minor: DateChip's own month/day-only display can't distinguish
// two shows that share a month and day across different years.
function fullDateForScreenReaders(dateMs: number): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: LAUNCH_TIMEZONE }).format(new Date(dateMs));
}

function DateChip({ dateMs }: { dateMs: number }) {
  const date = new Date(dateMs);
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: LAUNCH_TIMEZONE }).format(date).toUpperCase();
  const day = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: LAUNCH_TIMEZONE }).format(date);
  return (
    <div
      aria-hidden="true"
      className="flex h-[46px] w-[46px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-gk-sm border border-gk-border bg-gk-surface"
    >
      {/* text-gk-focus, not text-gk-accent: bare ember text fails WCAG AA
          against a light-theme gk-surface (DESIGN.md's accessibility note,
          ~2.6-2.8:1) at this small a size. --gk-focus is DESIGN.md's own
          fix for exactly this "ember-as-text on a surface" problem (the
          shell wordmark and active-nav-item cases reuse it the same way):
          ember itself in dark theme, the same-hue AA-safe #BF5038 in light. */}
      <span className="font-sora text-[10px] font-semibold uppercase leading-none tracking-wide text-gk-focus">
        {month}
      </span>
      <span className="font-syne text-base font-bold leading-none text-gk-text">{day}</span>
    </div>
  );
}

export function DateBlockRow({ dateMs, title, subtitle, detail, href, className, subtitleHasDate }: {
  dateMs: number;
  title: string;
  subtitle: string;
  detail?: ReactNode;
  href?: string;
  className?: string;
  // Post-launch review fix: set true only when `subtitle` itself already
  // spells out a full date (BookingInbox's ConfirmedRow passes
  // formatGigDateTime as its subtitle), so the row's own sr-only date below
  // doesn't announce the same date twice. Every other call site's subtitle
  // is time/location only, so this defaults to false (render the sr-only
  // date) everywhere else.
  subtitleHasDate?: boolean;
}) {
  const body = (
    <>
      <DateChip dateMs={dateMs} />
      <div className="min-w-0 flex-1">
        {!subtitleHasDate && <span className="sr-only">{fullDateForScreenReaders(dateMs)}. </span>}
        <p className="truncate font-syne text-sm font-semibold text-gk-text">{title}</p>
        <p className="truncate font-sora text-xs text-gk-muted">{subtitle}</p>
      </div>
      {detail != null && (
        <div className="shrink-0 text-right font-sora text-xs text-gk-muted">{detail}</div>
      )}
    </>
  );
  const rowClassName = cn(
    "flex w-full items-center gap-3 rounded-gk-sm px-2 py-2 text-left outline-none transition-colors",
    href && "hover:bg-gk-border/25 focus-visible:ring-2 focus-visible:ring-gk-focus",
    className,
  );
  if (href) {
    return (
      <Link href={href} className={rowClassName}>
        {body}
      </Link>
    );
  }
  return <div className={rowClassName}>{body}</div>;
}
