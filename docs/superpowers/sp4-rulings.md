# GateKeep Sub-project 4 (Booking Flow), Rulings & Handoff

Durable record from sub-project 4, executed subagent-driven with two-stage reviews on
`worktree-sp4-booking-flow` and merged to `main` on 2026-08-27. Travels with the repo so any
device/session can plan sub-project 5 without this machine's context. Mirrors
`sp2-rulings.md`/`sp3-rulings.md`'s structure.

Spec: `docs/superpowers/specs/2026-08-26-booking-flow-design.md`
Plan (as-built, every quality/security fix folded into per-task "as-built" blocks): `docs/superpowers/plans/2026-08-26-booking-flow.md`
Prior records: `docs/superpowers/sp2-rulings.md`, `docs/superpowers/sp3-rulings.md` (SP4 annotated its resolved items in place)

## Rulings made during execution

1. **`BookingRequestDoc` naming**, SP2's `BookingDoc` (the rates+prefs subdoc at
   `profiles/{id}/private/booking`) keeps the plain name; the top-level booking record is
   `BookingRequestDoc`.
2. **Visibility split is physical, not field-level** (M-13 mechanics): rules can't hide fields, so
   the data splits by tier, source of truth in `private/booking` (members+admins ONLY; SP3's
   `isApprovedCuratorMember()` disjunct and helper are REMOVED), a server-built
   `private/curatorBooking` projection (curatorAccess ∪ members ∪ admins) with private-marked rates
   nulled, and `profiles/{id}.publicBooking` carrying preferences only when marked public. Rates
   have NO public tier by design (user decision). `rebuildBookingProjections(profileId, source?)`
   commits source + both projections in ONE batch when the source is passed (atomic; no
   projection-staleness window). Legacy docs without `visibility` project as all-"curators"
   (never MORE exposed pre-backfill).
3. **Deploy-order launch rule (CRITICAL)**: the rules tighten and `backfillBookingVisibility` must
   ship in the SAME release, rules without backfill leaves curators reading nothing. README
   launch checklist records it.
4. **Negotiation is transactional at every write**: counter/decline/withdraw/accept all check turn +
   status against `tx.get(bookingRef)`. `requireBookingSide` (bookings.ts) resolves a both-sides
   member musician-first and PERMITS negotiation; the ambiguity REFUSAL lives only in
   `resolveBookingSideStrict` (bookingLifecycle.ts) for side-dependent outcomes (cancel, report).
   UI shows both-sides members an informational notice with only cancel/report disabled.
5. **Money math**: `OfferEntry.expectedQuantity` is DISPLAY-ONLY for perHour,
   `computeExpectedTotalCents(structure, amountCents, {durationMinutes, songCount})` is the single
   money path (single `Math.ceil`, integer cents, overflow-safe ≤ 2^53). Deposit =
   `ceil(35%)`. acceptBooking freezes `acceptedTerms` from the LAST thread entry and refuses a
   zero `expectedTotalCents` (tripwire) and a gig edited after the last offer
   (`gig.updatedAt > lastEntry.at`).
6. **Filled/closed gigs are edit-locked** (security F2): `updateGig` refuses them;
   `updateSeries` template propagation skips them. Prevents forfeit-window dodging, retroactive
   no-show fabrication, and unilateral settlement shrinking.
7. **Cancellation windows are strict-`<`** (72h curator forfeit → musician; 24h musician mark),
   measured against gig start, evaluated from the booking's `deposit.policy` SNAPSHOT (constants
   are only the fallback, F6). `now` is captured once per invocation so decision and record always
   agree. Late-cancel marks append IN the main transaction (a crash cannot orphan
   `markApplied:true`).
8. **All occurrence selection/unwind is BOOKING-scoped**, reportNoShow's relevant occurrence,
   `getFutureFilledOccurrences`, and sweep completion all query `bookingId ==` (+`status=="filled"`
   where completion credit is at stake, no completedCount for taken-down dates); series-linkage
   clears are ownership-gated (`activeBookingId === bookingId`) and `{lastUpdateTime}`-preconditioned.
9. **Moderation unwind semantics** (`unwindBookingsForModeration`): open→expired,
   confirmed→expired with NO cancellation record/forfeiture/marks (nobody's fault; sub-5 reads
   `expired` + non-null deposit as refund). Curator-side causes retire the gigs via their own
   cascades; MUSICIAN-side causes (musician reject/delete) additionally reopen the innocent
   curator's future-dated linked gigs and notify the curator (security F1). Occurrence-scope
   takedown SKIPS confirmed whole-run bookings (series scope is the tool for removing a booked
   run); series-scope takedown sweeps open AND filled siblings.
10. **reportNoShow works on confirmed AND completed bookings** (14-day window from the last
    booking-linked occurrence), the primary flow is post-sweep-completion. Reporting an
    already-completed booking DECREMENTS completedCount (R1) so the admin-reversal path
    (`removeReliabilityMark` restoring a falsely-reported booking to `completed`, +1, F4) nets to
    exactly one credit. Restore skips the credit for selfDeal bookings (R2).
11. **Self-dealing ruling (F5)**: a user on both sides of a booking (member of both profiles) MAY
    book, legit venue-owner-performer exists, but the booking is stamped `selfDeal: true` at
    accept and earns no `completedCount` credit. Sub-5 must decide whether selfDeal bookings settle
    normally.

    **RESOLVED (SP5):** selfDeal bookings **settle normally, with fees fully applying**, the 11%
    curator fee, the 2% musician commission and (if it comes to it) the late fee all behave exactly
    as on any other booking. Rationale, ruled during brainstorming and recorded in the payments spec
    §1: paying real fees to move your own money removes any farming incentive, so no exclusion
    carve-out is needed and the money path stays single. The reliability side of this ruling is
    unchanged, selfDeal still earns no `completedCount` credit.
12. **`occurrenceCancellations` is reject-when-full** (cap 100, `resource-exhausted`, F7):
    settlement records are never silently discarded (unlike reliability marks, which stay
    drop-oldest-200 rolling history).
13. **Zombie runs resolve in the sweep**: pauseSeries/endSeries tolerate the no-cancellable-dates
    family (exact-match on exported message constants; upgrade path = coded HttpsError details)
    and leave the booking for sweep step 7, which resolves a confirmed whole-run booking with zero
    future FILLED linked occurrences → completed (if any past filled linked) else expired,
    clearing series linkage ownership-gated.
14. **Sweep step 7 flips each booking with a DIRECT write before side effects**, a crash re-run
    loses at most one completedCount increment, never over-counts. Step 6 expires open bookings
    whose gig started, died, OR was deleted outright.
15. **Materializer stages each series' payloads** (local array + eager throwaway-batch validation)
    before touching the shared writer, one poisoned series can neither block others (per-series
    catch) nor half-commit an orphan public gig. Filled births (booked runs) skip the open-gig cap
    and re-verify the booking is still confirmed (stale linkage self-heals to open + clears).
16. **Past performed gigs stay `status:"filled"` forever**, the spec's `filled → closed (date
    passes)` transition was deliberately NOT implemented (linkage-kept-forever; public readability
    is equivalent; Shows splits upcoming/past on `startsAt`). Sub-5 must NOT trust the spec's
    transition table here; the settlement basis is the sweep's filled-linked-gigs set.
17. **Rules-provability discipline for shipped queries** (verified by audit with a full matrix):
    the musician Shows query pins `bookedMusicianProfileId == X` + `status in [filled, closed]`
    (equality pin proves the closed disjunct's non-null); the CURATOR Shows query MUST split into
    two queries (filled leg + closed-with-`bookedMusicianProfileId > ""` leg); occurrence lists
    pin `status=="filled"` (bare bookingId queries are rules-denied); a client "applicants for
    this gig" list must also pin `curatorProfileId` (recorded in a rules comment).
18. **Public browse pages never fetch `gigSeries`** (member-only): the browse badge derives from
    `seriesId != null` with softer copy; exact fill semantics render only on the gig detail page
    behind a permission-denied-tolerant fetch.
19. **`NotificationDoc.refId`** (optional, backward-compatible) carries the bookingId on all
    booking-kind notifications for deep-linking; legacy rows render unlinked.
20. **Launch-TZ day boundaries**: browse date filters use per-date Intl-derived LAUNCH_TIMEZONE
    day starts (DST-verified against both 2026 US transitions); mobile wraps in try/catch and
    degrades to no-filter if Hermes ICU lacks support (unverifiable without a device, GigForms
    precedent).

## Obligations sub-project 5 MUST pick up (recorded commitments)

- **Deposit money movement**: `deposit.status` machine gains `held | refunded | forfeited`;
  wire from `deposit` + `cancellation.outcome` + `deposit.forfeitedTo` ("musician" is the only
  forfeit target; platform-fee carve-out of forfeited deposits is sub-5's product decision).
  `expired` + non-null deposit = refund. Admin-takedown unwinds = refund (no forfeiture either way).

  **RESOLVED (SP5):** the deposit is real money now. `DepositStatus` (`packages/shared/src/types.ts`)
  runs `unpaid → held → applied` with `refund_pending`/`forfeit_pending` as the transactional
  intent-to-move-money, written in the SAME transaction as the cancellation, so a crash before the
  money moves always leaves a doc `paymentsSweep` can find and finish. Every edge this bullet named
  is wired: `expired` + non-null deposit refunds, admin-takedown unwinds refund, and a curator
  cancel inside 72h forfeits **to the musician**. The carve-out question is answered: **no platform
  carve-out on forfeits**, the musician receives 100% of the deposit base (no 2% commission), and
  the platform keeps only the curator's 11% fee share that was charged on that deposit either way.
  Refunds always include the curator's fee share; we eat Stripe's processing cost. One addition
  this bullet did not anticipate: `unpaid` is a DEBT-QUERY ANSWER, not a resting state, no path may
  leave a doc there once the obligation is discharged, or the curator is permanently gated (see
  `DepositStatus`'s closing-invariant comment).
- **Settlement math from `acceptedTerms`**: perHour overtime, perSong count-true-up, perSet flat;
  per-occurrence basis for whole-run = the booking-linked FILLED gigs set (each occurrence's own
  `durationMinutes` × frozen `amountCents` for perHour). A booking-linked `taken_down` occurrence
  settles as NOT-performed. `occurrenceCancellations` entries are per-date settlement inputs; a
  full 100-entry array is a tripwire (the callable now refuses further per-date cancels).

  **RESOLVED (SP5):** settlement runs **T+3 after each occurrence ENDS**, off-session, on the
  frozen `acceptedTerms` exactly as specified, per-occurrence for whole runs, over the sweep's
  filled-linked-gigs set (ruling 16's basis, not the spec's unimplemented `filled → closed`
  transition), each occurrence using its OWN `durationMinutes` for `perHour`. Overtime/count
  true-ups are a curator-reported, **increase-only** `confirmOccurrenceActuals` whose window closes
  the moment a charge starts. A booking-linked `taken_down` date settles as not-performed. The
  `occurrenceCancellations` tripwire held as recorded, SP5 consumes those entries as settlement
  inputs and never needed the cap raised.
- **selfDeal settlement decision** (ruling 11): decide whether `selfDeal: true` bookings settle
  normally, at a fee, or are excluded.

  **RESOLVED (SP5):** normally, **at full fees**, see ruling 11's annotation above.
- **`resumeSeries` tripwire, STILL OPEN, carried from sp3-rulings ruling 19 unchanged**: SP4
  deliberately did not add it; pause remains one-way. The requirements (approval-gate +
  `pausedBy` distinction) bind whoever adds it.

  **STILL OPEN after SP5**, carried forward unchanged for the third sub-project running. SP5 was
  a money sub-project and deliberately touched no series lifecycle; pause is still one-way, and the
  requirements above still bind whoever adds it.
- **Deferred guard cleanup**: `inviteMember` lacks `isValidDocId(profileId)`; `respondToInvite`
  validates inviteId by existence only.

  **RESOLVED (SP5, Task 3):** both landed (`functions/src/members.ts`), `inviteMember` guards
  `profileId` with `isValidDocId`, and `respondToInvite` validates `inviteId`'s SHAPE before
  building a doc path from it. The same review pass extended the fix past the two items recorded
  here: `revokeInvite`, `removeMember` and `transferAdmin` were missing the identical guards and
  got them too.
- **Scale/hardening follow-ups** (README records them): materializer birth-decision race (filled
  gigs linked to a non-confirmed booking have no reconciling sweep step, accepted at
  daily-sweep-window probability; fix menu recorded), sweep step-6 `db.getAll` batching,
  functions test-helper dedup, sweep step-7 crash posture (at-most-one lost increment, accepted),
  BookingInbox pagination past the soft 50 cap.
- **Sub-6 (events)**: build on completed bookings; the Shows sections are live and render
  platform bookings only (the SP2 contract, discharged this sub-project).
- **Sub-8 (search)**: both directories ("Find gigs", "Find musicians") are placeholder-grade by
  design, sub-8 replaces their query internals; also fold in: the musicians-page gate doesn't pin
  membership of the profile in the URL (any approved-curator member can load a foreign /musicians
  URL, reads prove via their own curatorAccess, offerGig refuses server-side), and the unused
  `gigs (bookedMusicianProfileId, startsAt)` index can be dropped or kept as headroom.

## Environment (fresh clone, any machine)

Same as sp2/sp3-rulings (corepack pnpm shim, Java for emulators, `FUNCTIONS_DISCOVERY_TIMEOUT=60`
on Windows, `next typegen` after clone). Final SP4 gate counts (all green at merge): `pnpm
typecheck` 5/5 · shared 123 · `pnpm emu:test` 393 · `pnpm emu:rules` 66 (52+14) · web+mobile
lint 0 errors · web build · `npx expo export --platform ios`. Whole-branch security audit PASS
(after a 7-finding fix wave + 2 residuals, all closed), rules audit SECURE 6/6 (5/5
access-meaningful mutations caught; full shipped-query provability matrix in the audit record).
