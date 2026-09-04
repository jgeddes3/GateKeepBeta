import { describe, it, expect } from "vitest";
import { musicianJsonLd, curatorJsonLd, eventJsonLd } from "./jsonLd";

const musician = { type: "musician", subtype: "band", name: "Night Owls", handle: "nightowls", status: "approved",
  portfolio: { bio: "", genres: ["rock", "indie"], externalLinks: [], avatarPhotoPath: null, coverPhotoPath: null } } as never;
const venue = { type: "curator", subtype: "venue", name: "Mohawk", handle: "mohawk", status: "approved",
  curator: { location: { address: "912 Red River St", city: "Austin", neighborhood: "Red River", geo: null, geocodedFrom: "x" }, lookingFor: { genres: [], actSizes: [], notes: null } } } as never;
const planner = { ...(venue as object), subtype: "planner", curator: { location: { address: null, city: "Austin", neighborhood: null, geo: null, geocodedFrom: "x" } } } as never;
const event = { title: "Owls Live", description: "", status: "published", startsAt: 1_800_000_000_000, endsAt: 1_800_010_000_000,
  location: { venueName: "Mohawk", neighborhood: "Red River", city: "Austin", geo: null, addressVisibility: "neighborhood", address: null },
  lineup: [{ kind: "external", name: "Night Owls" }], lineupMusicianProfileIds: [], curatorProfileId: "c", posterPath: null } as never;

describe("jsonLd builders", () => {
  it("builds a MusicGroup with genres and no empty fields", () => {
    const ld = musicianJsonLd(musician, "https://x.test/@nightowls", null);
    expect(ld).toMatchObject({ "@context": "https://schema.org", "@type": "MusicGroup", name: "Night Owls", url: "https://x.test/@nightowls", genre: ["rock", "indie"] });
    expect(ld).not.toHaveProperty("image");
  });
  it("builds MusicVenue for venues and Organization otherwise", () => {
    expect(curatorJsonLd(venue, "https://x.test/@mohawk", "https://img")).toMatchObject({ "@type": "MusicVenue", address: { "@type": "PostalAddress", addressLocality: "Austin", streetAddress: "912 Red River St" }, image: "https://img" });
    expect(curatorJsonLd(planner, "https://x.test/@mohawk", null)).toMatchObject({ "@type": "Organization", address: { addressLocality: "Austin" } });
  });
  it("builds a MusicEvent with offers, performers, and cancelled status", () => {
    const ld = eventJsonLd(event, "e1", "https://x.test/e/e1", [{ name: "GA", priceCents: 1500, capacity: 100, soldCount: 100 }, { name: "Free", priceCents: 0, capacity: 10, soldCount: 0 }], null, ["Night Owls"]);
    expect(ld).toMatchObject({ "@type": "MusicEvent", name: "Owls Live", startDate: new Date(1_800_000_000_000).toISOString(), eventStatus: "https://schema.org/EventScheduled",
      location: { "@type": "Place", name: "Mohawk", address: { addressLocality: "Austin" } }, performer: [{ "@type": "MusicGroup", name: "Night Owls" }] });
    expect(ld.offers).toEqual([
      { "@type": "Offer", name: "GA", price: "15.00", priceCurrency: "USD", availability: "https://schema.org/SoldOut", url: "https://x.test/e/e1" },
      { "@type": "Offer", name: "Free", price: "0.00", priceCurrency: "USD", availability: "https://schema.org/InStock", url: "https://x.test/e/e1" },
    ]);
    expect(eventJsonLd({ ...(event as object), status: "cancelled" } as never, "e1", "u", [], null, []).eventStatus).toBe("https://schema.org/EventCancelled");
  });
});
