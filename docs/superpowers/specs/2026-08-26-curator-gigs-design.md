# GateKeep — Sub-project 3: Curator Profiles & Gig Postings — Design Spec

**Date:** 2026-08-26
**Status:** Approved design, pending user review of this document
**Scope:** Curator portfolio content + wizard, gig postings (one-off + recurring series), admin gig moderation, inherited-obligation settlements
**Builds on:** Foundation (`2026-08-24-foundation-design.md`), Musician Portfolio (`2026-08-25-musician-portfolio-design.md`), obligations in `sp2-rulings.md`

---

## 1. Scope boundary

**In:** curator profile content and wizard (venue / planner / individual_host), gig posting creation and management (one-off and recurring series with materialized occurrences), public curator pages with open-gig listings, admin gig moderation and curator-queue upgrades, anti-spam controls, geocoding groundwork for the future map, the SP2-inherited admin/internal cleanup settlements.

**Out (later sub-projects):** musician-facing gig browse/search/apply and curator talent-browsing (sub-4), booking states on gigs (`filled` etc., sub-4), payments (sub-5), events/ticketing wiring of the Upcoming Events sections (sub-6), the fan-facing map UI (sub-7 — SP3 only *stores* the geodata it needs), advertising use of the interest flag (later phase).

## 2. Decisions (approved in brainstorm)

1. **Gig shapes:** one-off gigs AND recurring series. Series fill mode is the curator's choice per posting: `per_occurrence` (each date bookable separately) or `whole_run` (one act takes the series).
2. **Money on gigs:** budget range `{min, max}` + structure (`per_hour` | `per_song` | `per_set`) — the SP2 `BookingRates` vocabulary. Shown to musicians up front; negotiation is sub-4.
3. **Location & privacy:** every gig carries its own location, geocoded at write time. Established-venue gigs show venue name + full address publicly by default. Non-venue gigs default to neighborhood precision publicly (coarsened pin: neighborhood centroid) with the exact address in a private subdoc — but **address visibility is a per-gig curator choice**: any gig can be flipped to fully public (block party, rented hall). Ticket-holders always get the address via event pages later (sub-6).
4. **Trust model:** approved curators publish gigs instantly, no per-gig review. Admin takedown tooling exists, with moderation attention focused on **non-venue** gigs (hosts/planners); established venues are the trusted tier.
5. **Curator pages are public** like musician portfolios — photos, about, amenities, what-we-look-for, open gigs — at the existing `@handle` SSR route. Venue locations render publicly.
6. **Map groundwork:** gigs and venue profiles store geocoded coordinates from day one; the map UI itself is sub-7.
7. **Required preferences:** curators MUST declare musician preferences (≥1 genre + act type) before submitting for review.
8. **Architecture for series:** template + materialized occurrences (Approach A) — a daily scheduled function materializes occurrence docs on a rolling 8-week window.

## 3. Data model

### Curator profile content (extends `profiles/{profileId}`, SP2 pattern)
- `about` (text), photo gallery (SP2 storage pipeline + paths), `lookingFor` — **required, structured**: `{ genres: string[] (≥1), actTypes: ("solo"|"band"|"dj")[] (≥1), notes?: string }`, amenities/details `{ capacity?, hasPA?, hasBackline?, indoorOutdoor?, notes? }`, `advertisingInterest: boolean` (stored, unused until ads phase).
- Location: venues — full street address, public, geocoded; planners/hosts — home-base city only (no precise public location).

### `gigSeries/{seriesId}`
`curatorProfileId`, recurrence `{ weekday, timeOfDay, cadence: weekly|biweekly|monthly, endDate? }`, `fillMode: per_occurrence|whole_run`, template content (same shape as gig content), `status: active|paused|ended`, `materializedThrough` (date watermark), timestamps.

### `gigs/{gigId}`
One doc per bookable occurrence; one-offs have `seriesId: null`.
- Content: `title`, `description`, wants `{ genres[], actTypes[] }` (prefilled from profile preferences, editable per gig), `budget { min, max, structure }`, `startsAt`, `durationMinutes`, provisions `{ hasPA?, hasBackline?, notes? }`.
- Location (public doc): `venueName?` (venues), `neighborhood`, `city`, `geo` (exact for public-address gigs; **coarsened to neighborhood centroid** otherwise), `addressVisibility: public|neighborhood`, and `address` (present only when visibility is public).
- `gigs/{gigId}/private/location`: exact `address` + exact `geo`, always. Readable by profile members + admins; the booked musician gains read in sub-4.
- `status: draft → open → closed | cancelled | taken_down` (+ automatic close of past unfilled gigs; `filled` joins in sub-4). `curatorProfileId`, `seriesId?`, `detachedFromTemplate?: boolean`, timestamps.

### Geocoding
Server-side only (Cloud Function), behind a `geocode(address) → { lat, lng, neighborhood, city }` interface; provider chosen at implementation (API key in functions config, never clients; emulator uses a stub adapter).

## 4. Flows

### Curator wizard & editing
Full wizard (web primary, mobile parity): about, photos, location, amenities, required preferences, advertising flag. SP2 guard patterns mandatory on every screen (busy locks, failure states, the plan Tasks 13/14 DO-NOT-COPY checklists). **Submit gate** (server + both clients): about + ≥1 photo + location (venues: street address) + preferences (≥1 genre, ≥1 act type). Post-approval edits live instantly (SP2 ruling), balanced by admin unpublish.

### Gig composer & series management
One composer, first fork one-off vs series. Publishes instantly (`draft → open`). Series page lists occurrences; curator can pause (stop materializing), end (stop + close future unbooked occurrences), or edit the template — template edits apply to occurrences not individually edited; an individually edited occurrence sets `detachedFromTemplate` and stops receiving template updates. Occurrences edit/cancel independently.

### Scheduled function (one daily job, shared)
1. Materialize: for each `active` series, create occurrences to `today + 8 weeks`, advance `materializedThrough` (idempotent via watermark).
2. Sweep past gigs: date passed + still `open` → `closed`.
3. SP2 debt: reap abandoned `processing` tracks.
4. Sweep expired/orphaned invites (SP2 deferred item).

### Public curator page
SSR at `@handle` (SP2 machinery): photos, about, amenities, lookingFor, **Open gigs** (status `open` only, location at its public precision), Upcoming Events section hidden-while-empty (wired in sub-6).

## 5. Admin

- **Gig list:** filter by status/subtype, default view = non-venue gigs. Takedown → `taken_down` + audit log + member notification (SP2 takedown-integrity pattern). Series takedown offers occurrence-only or whole-series.
- **Curator queue:** displays the new gate fields; **reject-with-flag** adds a private admin note to the account (repeat-spam visibility); resubmit count shown.
- **Settlements of the SP2-inherited list (approved):** admin **name search** built now (lowercase-name prefix index on users); orphaned-invite cleanup joins the scheduled sweep; `deleteProfile` stays restricted to draft/rejected (unpublish-then-delete is the takedown path — confirmed product call); guard consolidation (`requireAuth`/`requireVerifiedEmail` → `functions/src/guards.ts`) and mobile account-screen dedup are SP3 cleanup tasks; EAS + native App Check remain parked for launch prep.
- **Booking-rates read widening** (SP2 obligation): `profiles/{id}/private/booking` read extends to members of approved curator profiles.

## 6. Security & abuse

- **Rules:** clients never write gigs/gigSeries (callables only). `gigs` world-readable iff `status == "open"` — safe without a per-read profile check because only approved profiles can post AND profile unpublish/reject cascades: closes its open gigs + pauses its series. List queries filter `status == "open"` (provable). `private/location` members+admins. `gigSeries` members+admins.
- **Anti-spam (curator requests):** manual review remains the wall; plus (new) one `pending_review` curator profile per account at a time, 24h resubmit cooldown after rejection, reject-with-flag notes. Existing: email verification to create drafts, 3-draft cap, App Check (enforce at launch).
- **Caps on vetted accounts:** ≤50 open gigs and ≤10 active series per profile (`resource-exhausted`).
- **Geocode key** server-side only. Gigs carry no storage objects — no scrub step in gig takedown.
- **Process gates:** rules auditor on every rules change; full security review before merge.

## 7. Testing

TDD throughout, emulator-only. Callable tests: gig/series CRUD + publish, caps, cooldown, takedown cascade (profile unpublish → gigs closed/series paused), materializer invoked directly with a frozen/injected clock (idempotency across double runs), name-search index, booking-rates widened read. Rules tests: open-read boundary (draft/cancelled/taken_down denied), private-subdoc access, list provability, series privacy. Storage tests: curator photo paths. Geocode stubbed.

## 8. Out of scope (restated)

Musician browse/apply and talent search (4), booking states + address reveal to booked musicians (4), payments (5), event/ticket wiring (6), map UI (7), advertising usage of the interest flag (later), phone/IP-level anti-abuse (until real abuse).
