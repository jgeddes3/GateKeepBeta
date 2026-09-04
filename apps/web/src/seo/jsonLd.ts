import type { EventDoc } from "@gatekeep/shared";

// Plain module, no "use client": these builders run only on the server (the
// public profile and event pages call them and serialize the result into a
// <script type="application/ld+json"> tag themselves). Every function omits
// a key whose source value is null, undefined, or an empty string/array
// rather than emitting a schema.org property with a useless empty value.

type JsonLd = Record<string, unknown>;

// Shared by every page that renders a <script type="application/ld+json">
// with dangerouslySetInnerHTML: escapes "<" so a title/name/description
// containing the literal text "</script>" can't close the tag early and
// inject markup into the page.
export function serializeJsonLd(ld: JsonLd): string {
  return JSON.stringify(ld).replace(/</g, "\\u003c");
}

function withoutEmpty(obj: JsonLd): JsonLd {
  const out: JsonLd = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

function postalAddress(location: { address: string | null; city: string }): JsonLd {
  return withoutEmpty({
    "@type": "PostalAddress",
    addressLocality: location.city,
    streetAddress: location.address,
  });
}

// Structural, not ProfileDoc itself: only the fields this builder actually
// reads, so both a real ProfileDoc (extra fields ignored) and the test's
// minimal literal fixtures (which omit fields like advertisingInterest/
// amenities that a real CuratorDetails carries) type-check without a cast on
// either side.
type CuratorishProfile = {
  subtype: string;
  name: string;
  curator?: { location: { address: string | null; city: string } } | undefined;
};

type MusicianishProfile = {
  name: string;
  portfolio?: { bio: string; genres: string[] } | undefined;
};

export function musicianJsonLd(profile: MusicianishProfile, url: string, imageUrl: string | null): JsonLd {
  return withoutEmpty({
    "@context": "https://schema.org",
    "@type": "MusicGroup",
    name: profile.name,
    url,
    description: profile.portfolio?.bio ?? null,
    genre: profile.portfolio?.genres ?? [],
    image: imageUrl,
  });
}

export function curatorJsonLd(profile: CuratorishProfile, url: string, imageUrl: string | null): JsonLd {
  const location = profile.curator?.location ?? null;
  return withoutEmpty({
    "@context": "https://schema.org",
    "@type": profile.subtype === "venue" ? "MusicVenue" : "Organization",
    name: profile.name,
    url,
    address: location ? postalAddress(location) : null,
    image: imageUrl,
  });
}

// Structural tier shape (not TierPickerTier/EventPageTier): the extra fields
// a real ticket tier carries (id, saleStartsAt, saleEndsAt) aren't needed to
// build an Offer, and keeping this minimal lets the test's literal tier
// objects type-check without a cast, per the Task 13 ruling.
export type JsonLdEventTier = { name: string; priceCents: number; capacity: number; soldCount: number };

export function eventJsonLd(
  event: Pick<EventDoc, "title" | "description" | "status" | "startsAt" | "endsAt" | "location">,
  eventId: string,
  url: string,
  tiers: JsonLdEventTier[],
  imageUrl: string | null,
  performerNames: string[],
): JsonLd {
  const offers = tiers.map((t) => ({
    "@type": "Offer",
    name: t.name,
    price: (t.priceCents / 100).toFixed(2),
    priceCurrency: "USD",
    availability: t.soldCount >= t.capacity ? "https://schema.org/SoldOut" : "https://schema.org/InStock",
    url,
  }));
  return withoutEmpty({
    "@context": "https://schema.org",
    "@type": "MusicEvent",
    identifier: eventId,
    name: event.title,
    description: event.description,
    url,
    startDate: new Date(event.startsAt).toISOString(),
    endDate: new Date(event.endsAt).toISOString(),
    eventStatus: event.status === "cancelled" ? "https://schema.org/EventCancelled" : "https://schema.org/EventScheduled",
    location: withoutEmpty({
      "@type": "Place",
      name: event.location.venueName,
      address: postalAddress(event.location),
    }),
    performer: performerNames.map((name) => ({ "@type": "MusicGroup", name })),
    offers: offers.length > 0 ? offers : null,
    image: imageUrl,
  });
}
