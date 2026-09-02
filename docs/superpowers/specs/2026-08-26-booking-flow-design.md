# GateKeep, Sub-project 4: Booking Flow, Design Spec

**Date:** 2026-08-26
**Status:** Approved design, pending user review of this document
**Scope:** Curator↔musician booking (both doors), negotiation threads, deposit/cancellation policy as data, musician-controlled booking visibility, `filled` status + `fillMode` consumption, reliability (no-show) records, basic discovery directories
**Builds on:** Foundation, Musician Portfolio (`sp2-rulings.md`), Curator Gigs (`sp3-rulings.md`, including the M-13 user decision of 2026-08-26)

---

## 1. Scope boundary

**In:** booking requests from either door (musician applies to an open gig / curator offers a gig to a musician), full counter-offer negotiation threads (terms only, no chat), accept → gig `filled` with frozen terms, deposit + cancellation policy recorded and enforced **as data** (no money moves), no-show reliability records, musician-controlled visibility split for booking data (retires M-12/M-13), whole-run series booking (consumes `fillMode`), Shows-section wiring on public portfolios (fulfills the SP2 "platform events only" contract), basic "Find gigs" / "Find musicians" directories, admin reliability + bookings tooling, notifications throughout.

**Out (later sub-projects):** actual payment processing, deposits, refunds, forfeitures, settlement math (sub-5, computing from `acceptedTerms`); events/ticketing (sub-6); fan map UI (sub-7); **full search experience, sub-8 (user directive this brainstorm): text search, ranking, maps, saved searches/alerts replace the directories' query internals; the directory pages here are deliberately placeholder-grade**; general messaging/chat (unscheduled); `resumeSeries` (pause stays one-way, ruling 19's tripwire carries forward untouched).

## 2. Decisions (approved in brainstorm)

1. **Both doors, one model:** musicians apply to open gigs with a quote; curators offer their open gigs to musicians. Either creates the same `bookings/{id}` doc with `initiatedBy`.
2. **Full counter thread:** unlimited alternating counters until someone accepts, declines, or withdraws. Thread entries are structured offers only, amount, expected quantity, ≤280-char note. No free chat.
3. **Amount only is negotiable:** the rate structure is fixed to the gig's `budget.structure`. A musician who won't work that structure doesn't engage.
4. **Visibility (implements the M-13 user decision):** per-part, two tiers. Each rate structure: `curators` | `private`, **rates are never public**. Preferences block: `public` | `curators`. Reliability summary: always curator-tier, never public.
5. **Deposit policy (terms in sub-4, money in sub-5):** curator owes a 35% deposit of the expected total, recorded at confirmation with `status: "unpaid"`. Windows measure against **gig start**: curator cancels <72h before start → deposit forfeited **to the musician**; ≥72h → refunded. Musician cancels → deposit returns to curator; <24h before start → automatic **no-show mark**. Sub-5 wires `unpaid → held → refunded | forfeited` to real money.
6. **No-show marks:** two sources, automatic (<24h musician cancellation) and curator-reported after a no-show (flips `completed` → `cancelled_by_musician` + mark). Curator-visible as a summary count; admins view and can remove disputed marks.
7. **Whole-run booking (consumes `fillMode`):** one run-scoped booking negotiates per-occurrence terms; accept fills all current open occurrences and future ones materialize pre-filled. Deposits are **35% per occurrence**. `per_occurrence` series book date-by-date.
8. **Cancellation:** either side, any time before start, reason required; future gig reopens. Run cancellations evaluate windows only against the **next upcoming occurrence** (one forfeiture / one mark max).
9. **Discovery:** two directories with basic filters (plain Firestore queries + composite indexes). Sub-8 replaces their internals.
10. **Architecture:** Approach 1, single `bookings` collection, thread embedded (capped array), tiered projection docs for visibility, everything mutated via callables.

## 3. Data model

### `bookings/{bookingId}` (top-level)
- Identity: `gigId`, `seriesId` (`null` unless a whole-run booking), `curatorProfileId`, `musicianProfileId`, `initiatedBy: "musician" | "curator"`.
- `structure: BudgetStructure`, copied from the gig's budget at creation, immutable.
- `thread: OfferEntry[]`, capped at 50. `OfferEntry = { by: "musician" | "curator", amountCents: int > 0, expectedQuantity: number | null, note: string | null (≤280), at: number }`. `expectedQuantity` is required for `perSong` (song count) and derived-from-duration for `perHour` (hours, from the gig's `durationMinutes`); `null` for `perSet`. For whole-run bookings, amounts are **per occurrence**.
- `awaitingSide: "musician" | "curator"`, turn tracking; only the awaiting side may accept/counter/decline.
- `status: "open" | "confirmed" | "completed" | "declined" | "withdrawn" | "superseded" | "expired" | "cancelled_by_curator" | "cancelled_by_musician"`.
- `acceptedTerms: { amountCents, expectedQuantity, expectedTotalCents } | null`, frozen on confirm; what sub-5 trusts. Expected total: `perSet` = amount; `perHour` = amount × durationMinutes/60 (round up to cent); `perSong` = amount × expectedQuantity. Whole-run: per-occurrence values.
- `deposit: { amountCents (ceil(0.35 × expectedTotalCents)), status: "unpaid", forfeitedTo: null | "musician", policy: { percent: 35, curatorForfeitHours: 72, musicianMarkHours: 24 } } | null`, set on confirm; policy snapshot so later policy changes never retro-apply. Whole-run: per-occurrence amount.
- `cancellation: { by, reason (required, ≤500), at, hoursBeforeStart, outcome: "deposit_forfeited" | "deposit_refunded", markApplied: boolean } | null`.
- Timestamps: `createdAt`, `updatedAt`, `confirmedAt`, `resolvedAt`.

### Gig & series changes (`@gatekeep/shared`)
- `GIG_STATUSES` gains `"filled"`. Transitions: `open → filled` (confirm), `filled → open` (pre-start cancellation), `filled → closed` (date passes; sweep), takedown/cancel paths unchanged.
- `GigDoc` gains `bookingId: string | null` (doc-id linkage only, no terms on the public doc).
- `GigSeriesDoc` gains `activeBookingId: string | null`, `bookedMusicianProfileId: string | null`.

### Visibility split (implements decision 4)
- `profiles/{id}/private/booking` (source of truth, **member + admin read only**, SP3's `isApprovedCuratorMember()` disjunct is REMOVED): existing `rates` + `preferences`, plus `visibility: { perHour: "curators"|"private", perSong: …, perSet: …, preferences: "public"|"curators" }`.
- `profiles/{id}/private/curatorBooking` (server-maintained projection; read: curatorAccess holders + members + admins; write: nobody client-side): rates marked `curators`, the preferences block, `reliability: { noShowCount, completedCount }`, `updatedAt`. Maintained by `updateBookingInfo` and by reliability/booking callables in the same write as their source mutation.
- `ProfileDoc` gains `publicBooking: BookingPreferences | null`, set iff preferences are marked `public`; rendered on the public portfolio page.
- Migration: one-time admin backfill callable (SP3 `backfillDisplayNameLower` idiom) builds `visibility` defaults (**all rates `curators`, preferences `curators`**, preserves current behavior, exposes nothing new) + projections for existing musician profiles.

### `profiles/{musicianProfileId}/private/reliability`
- Read: members + admins (musicians always see their own record). Write: callables only.
- `marks: Mark[]` capped at 200 (SP3 `flagAccount` idiom). `Mark = { bookingId, gigId, kind: "late_cancel" | "reported_no_show", at, reportedByProfileId: string | null, removedByAdmin: false }`, admin "removal" sets the flag (audit-preserving); counters exclude removed marks.
- `completedCount: number`, incremented by the sweep on booking completion.

## 4. Flows

### Creating a request (either door)
Guards on both callables (`applyToGig` / `offerGig`): auth + verified email + `isValidDocId`s + membership of the acting profile + **both profiles approved** + gig `status == "open"` + structure-appropriate first offer. One open booking per (gig, musician) pair (dedupe check). Anti-spam: ≤25 `open` bookings initiated per profile (soft cap, SP3 tier). Creates the booking with `thread[0]`, `awaitingSide` = other side, notifies the recipient profile's members.

### Negotiating
`counterBooking` (append entry, flip `awaitingSide`, cap 50), `declineBooking` (recipient), `withdrawBooking` (initiator side, the side that did NOT just receive; concretely: allowed when it's not your turn). All turn-enforced server-side; every action notifies the other side.

### Accepting → confirmed
`acceptBooking`, transactional: caller is the awaiting side's member; gig re-read must still be `open` (whole-run: series still `active`, occurrences re-read); freeze `acceptedTerms` from the last offer; compute deposit; flip gig(s) `open → filled` + `bookingId`; whole-run: stamp series `activeBookingId`/`bookedMusicianProfileId`; auto-flip sibling `open` bookings on the gig (whole-run: on any of the run's gigs) to `superseded`; notify everyone (winner both sides, superseded musicians). UI shows the honesty line: "35% deposit ($X) will be collected when payments launch."

### Cancelling (post-confirmation)
`cancelBooking` (either side, reason required, before start only): compute `hoursBeforeStart` against the next affected occurrence; set outcome per decision 5/8 (deposit forfeit/refund as **data**); apply late-cancel mark if musician <24h; reopen future gig(s) (`filled → open`, clear `bookingId`) unless already started; whole-run: clear series linkage. `reportNoShow` (curator, within 14 days after start, once per booking): `completed | confirmed`-past → `cancelled_by_musician` + `reported_no_show` mark; deposit outcome per decision 5. `removeReliabilityMark` (admin): sets `removedByAdmin`, recomputes projection count, audit-logged.

### Series lifecycle collisions
Curator `pauseSeries`/`endSeries` with an active run booking → treated as curator-side run cancellation (windows vs next occurrence). Admin `takedownGig` (occurrence or series scope) or profile unpublish cascade → affected bookings `expired` with **no forfeiture either way** (moderation, not a party's choice; deposits refund, sub-5 note). `deleteProfile` cascade extends to that profile's bookings (terminal statuses; draft/rejected profiles rarely have any).

### Daily sweep additions (existing `runDailySweep`)
1. Expire: `open` bookings whose gig started (or died) → `expired`.
2. Complete: past `confirmed` bookings → `completed`; increment `completedCount` + projection.
3. Whole-run materialization: series with `activeBookingId` birth occurrences as `filled` + `bookingId` (skips the open-gig cap; window/cadence/status guards from SP3 unchanged, including the per-series status re-read).

### Discovery directories (placeholder-grade; sub-8 replaces internals)
- **Find gigs** (musician side, web + mobile): `gigs` where `status == "open"`, filters city / genre / structure / date, ordered by `startsAt`. Composite indexes as needed. Cards link to gig detail → Apply composer.
- **Find musicians** (curator side): approved musician profiles, filters genre / act size; cards show curator-tier rates + reliability from `curatorBooking` (client fetches the subdoc per card; acceptable at v1 scale). Links to portfolio → Offer composer (pick one of your open gigs → terms).

### Client surfaces (web + mobile parity, SP2/3 guard checklists apply)
Directories; booking thread screen (offer history, current-offer highlight, turn indicator, Accept/Counter/Decline/Withdraw with per-action busy states); apply/offer composers; musician + curator dashboard booking inboxes (open threads, upcoming confirmed, history); public portfolio: `publicBooking` preferences section + **Shows section wired** (upcoming confirmed + completed bookings for the profile, musician and curator pages both); cancellation dialog with window warning ("Cancelling now forfeits your deposit" / "This will add a no-show mark").

### Admin
Profile lookup gains: bookings list (by profile, any status) + reliability panel (marks with source booking, remove button → `removeReliabilityMark`). Existing queues untouched.

## 5. Notifications
Existing `notifyProfileMembers` + push pipeline: request received, counter received, accepted (both sides), declined / withdrawn / superseded, cancellation with outcome ("deposit forfeited to you" / "no-show recorded"), no-show reported / mark removed, run unwound, booking expired. No new notification infrastructure.

## 6. Security & abuse
- **Rules:** `bookings` read = member of either profile or admin; all writes `false` (callables only). `private/booking` read **tightens** to members + admins. `private/curatorBooking` read = curatorAccess ∪ members ∪ admins. `private/reliability` read = members + admins. `gigs/{id}/private/location` read **widens** to the booked musician's profile members while `bookingId` links them (the SP3-promised address reveal). Public gig docs leak no terms (only `status: "filled"` + a bare `bookingId`).
- **Server enforcement:** turn checks, structure immutability, amount bounds (0 < cents ≤ $100k), note/reason length caps, thread cap 50, one open booking per (gig, musician), ≤25 open initiated per profile, all money integers in cents (ceil on the 35%), policy snapshots on the booking. Every callable: guards.ts + `isValidDocId` + App Check posture unchanged (enforce at launch).
- **Process gates:** rules auditor on every rules change; full branch security review before merge (SP2/3 standard).

## 7. Testing
TDD, emulator-only. Callables: both doors' creation guards (approval, open-gig, dedupe, caps), turn enforcement, counter/decline/withdraw, accept transaction (fill, freeze, deposit math per structure incl. rounding, supersede fan-out, gig-no-longer-open race), cancellation windows (72h/24h boundaries, exactly-at-boundary pinned: `<` means strictly less), no-show report + admin removal + projection recompute, whole-run accept/cancel/materialize-pre-filled (injected clock), sweep expiry/completion, visibility projections (each toggle combination), backfill convergence + idempotency. Rules: tightened `private/booking` (curatorAccess holder now DENIED), `curatorBooking`/`reliability`/`bookings` matrices, booked-musician `private/location` read, filled-gig public read. Shared: validation for every new input shape. Both lints, web build, mobile export, all green before merge.

## 8. Obligations recorded for later sub-projects
- **Sub-5:** wire deposit money (`unpaid → held → refunded/forfeited`) from `deposit` + `cancellation.outcome`; settlement from `acceptedTerms` (overtime for perHour, count-true-up for perSong); decide platform fee carve-out of forfeited deposits; admin-takedown refunds.
- **Sub-6:** events build on completed bookings / wired Shows section.
- **Sub-8 (NEW):** full search experience, replaces both directories' query internals (text search, ranking, maps, saved searches/alerts).
- **Carried forward unchanged:** `resumeSeries` tripwire (sp3-rulings ruling 19), EAS + native App Check launch prep, and sp3-rulings' post-gate hardening list.
