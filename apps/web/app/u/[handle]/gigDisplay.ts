import { LAUNCH_TIMEZONE, type GigPublicLocation } from "@gatekeep/shared";

// Plain (non-"use client") display helpers shared by this route's two server
// components (CuratorProfile.tsx's existing "Open gigs" list, and both
// components' Task 11 "Shows" section). Deliberately NOT sourced from
// ../../../src/gigs/GigForms.tsx / ../../../src/bookings/BookingForms.tsx:
// those files are "use client" (form components with hooks), and this route
// has no client boundary of its own to spend on importing them: same
// tradeoff those files' own mirrored server-side soft caps already accept.
// This module used to be duplicated inline in CuratorProfile.tsx alone;
// Task 11 needs the exact same two functions in MusicianProfile.tsx too, so
// a second copy-paste became a shared sibling module instead (both
// consuming files live in this same route directory: no client boundary is
// crossed by importing a plain .ts file with no "use client" of its own).
//
// SP4 (Task 13 item 9): this module is now the ONE canonical copy of both
// functions app-wide: ../../src/gigs/GigForms.tsx's formatGigDateTime and
// ../../src/bookings/BookingForms.tsx's gigLocationLabel used to be
// independent, byte-identical copies; both files now import and re-export
// from here instead. The import direction only ever runs ONE way (those
// "use client" files import this plain module, never the reverse): the
// rationale above for why THIS file doesn't import THEM still holds.

export function formatGigDateTime(startsAtMs: number): string {
  const date = new Date(startsAtMs);
  const formatted = date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: LAUNCH_TIMEZONE });
  const tzName = new Intl.DateTimeFormat("en-US", { timeZone: LAUNCH_TIMEZONE, timeZoneName: "short" })
    .formatToParts(date).find((p) => p.type === "timeZoneName")?.value;
  return tzName ? `${formatted} ${tzName}` : formatted;
}

// Sub-project 9A task 9: DateBlockRow's own locked anatomy (spec section 4)
// puts the DAY in a dedicated date chip, so a Shows-box row's muted
// venue/time line only needs the TIME, not a second copy of the date
// formatGigDateTime already renders redundantly in the chip beside it.
export function formatGigTime(startsAtMs: number): string {
  const date = new Date(startsAtMs);
  const formatted = date.toLocaleString("en-US", { timeStyle: "short", timeZone: LAUNCH_TIMEZONE });
  const tzName = new Intl.DateTimeFormat("en-US", { timeZone: LAUNCH_TIMEZONE, timeZoneName: "short" })
    .formatToParts(date).find((p) => p.type === "timeZoneName")?.value;
  return tzName ? `${formatted} ${tzName}` : formatted;
}

// Public precision per gig, matching GigPublicLocation's own shape: `address`
// is present on the doc ONLY when addressVisibility=='public' (the write
// path in functions/src/gigs.ts nulls it out otherwise), so this never needs
// to branch on anything the client couldn't already see.
export function gigLocationLabel(location: GigPublicLocation): string {
  if (location.addressVisibility === "public") {
    // Middot separator (not an em dash: antislop R-02 / DESIGN.md's hard
    // rule bans it everywhere, this helper's output included), matching the
    // " · " convention every other multi-part gig line in the product
    // already uses (date/duration, "looking for" lines, GigCard's own
    // rows). Sub-project 9A task 8 fix, controller-sanctioned: this file
    // predates that task (SP4) but its output now renders on GigCard, the
    // flagship restyled surface, so the stray em dash had to go. No test
    // compares this function's exact return value (verified: nothing under
    // functions/test, packages/*/test, or tests-rules imports or calls
    // gigLocationLabel; the venueName assertions in functions/test/gigs.test.ts
    // and gigSeries.test.ts check the raw GigPublicLocation field, not this
    // display string).
    return location.venueName ? `${location.venueName} · ${location.address}` : (location.address ?? location.city);
  }
  return location.neighborhood ? `${location.neighborhood}, ${location.city}` : location.city;
}
