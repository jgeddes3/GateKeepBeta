import { LAUNCH_TIMEZONE, type GigPublicLocation } from "@gatekeep/shared";

// Plain (non-"use client") display helpers shared by this route's two server
// components (CuratorProfile.tsx's existing "Open gigs" list, and both
// components' Task 11 "Shows" section). Deliberately NOT sourced from
// ../../../src/gigs/GigForms.tsx / ../../../src/bookings/BookingForms.tsx:
// those files are "use client" (form components with hooks), and this route
// has no client boundary of its own to spend on importing them — same
// tradeoff those files' own mirrored server-side soft caps already accept.
// This module used to be duplicated inline in CuratorProfile.tsx alone;
// Task 11 needs the exact same two functions in MusicianProfile.tsx too, so
// a second copy-paste became a shared sibling module instead (both
// consuming files live in this same route directory — no client boundary is
// crossed by importing a plain .ts file with no "use client" of its own).
//
// SP4 (Task 13 item 9): this module is now the ONE canonical copy of both
// functions app-wide — ../../src/gigs/GigForms.tsx's formatGigDateTime and
// ../../src/bookings/BookingForms.tsx's gigLocationLabel used to be
// independent, byte-identical copies; both files now import and re-export
// from here instead. The import direction only ever runs ONE way (those
// "use client" files import this plain module, never the reverse) — the
// rationale above for why THIS file doesn't import THEM still holds.

export function formatGigDateTime(startsAtMs: number): string {
  const date = new Date(startsAtMs);
  const formatted = date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: LAUNCH_TIMEZONE });
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
    return location.venueName ? `${location.venueName} — ${location.address}` : (location.address ?? location.city);
  }
  return location.neighborhood ? `${location.neighborhood}, ${location.city}` : location.city;
}
