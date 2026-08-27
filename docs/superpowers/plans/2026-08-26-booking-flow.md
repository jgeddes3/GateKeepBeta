# Booking Flow Implementation Plan (Sub-project 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Curators and musicians book each other through either door (apply / offer) with full counter-offer threads; accepting fills the gig with frozen terms + a recorded 35% deposit obligation; cancellation windows, no-show reliability records, musician-controlled booking visibility, and whole-run series booking all land as data sub-5 can settle against.

**Architecture:** One `bookings` collection (thread embedded as a capped array, callables-only writes), tiered projection docs for booking visibility (source of truth tightens to members; curators read a server-built projection), `filled` joins the gig lifecycle, the SP3 daily sweep gains booking steps, and the materializer births pre-filled occurrences for booked runs. UI reuses SP2/3 shipped patterns on web + mobile.

**Tech Stack:** unchanged — TypeScript strict, pnpm monorepo, Firebase (Functions v2 + scheduler, Firestore, Storage, emulators), Next.js 16 web, Expo mobile, vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-booking-flow-design.md`
**Prior art the implementer MUST mirror:** SP3 plan `docs/superpowers/plans/2026-08-26-curator-gigs.md` (+ SP2 plan's Tasks 13/14 DO-NOT-COPY mobile checklists, which bind every new mobile screen), `functions/src/{gigs,gigSeries,scheduled,curator,review,portfolio,guards}.ts`, `apps/web/app/{dashboard,admin,u/[handle]}/**`, `apps/mobile/app/(curator)/**`.

## Global Constraints

- Project id `gatekeep-dev-jg`; region us-central1; Java on PATH; `FUNCTIONS_DISCOVERY_TIMEOUT=60` on Windows. Build functions before `pnpm emu:test` (root script does it).
- Baselines that must never regress: shared 93 · functions 277 · rules 61 (47+14) · both lints · web build · mobile export. TDD (RED before GREEN, evidence in reports).
- Clients NEVER write `bookings`, projections, reliability, gigs, series, or profiles — callables only. Every rules change passes the controller-run rules audit before its task completes.
- Callable conventions: guards from `functions/src/guards.ts`, ordering requireAuthUid → requireVerifiedEmail → input validation (incl. `isValidDocId` on every id) → authz guards → caps → writes; `HttpsError` codes asserted via `.rejects.toMatchObject({ code: "functions/<code>" })`; `vi.setConfig({ testTimeout: 15_000 })`; poll never sleep.
- Money: integer cents everywhere; `Math.ceil` on derived totals and the 35% deposit. Windows: `hoursBeforeStart = (gig.startsAt - now) / 3_600_000`, forfeiture/mark applies iff **strictly** `< 72` / `< 24`. All gig times render via `LAUNCH_TIMEZONE` (SP3 idiom).
- **Pause stays one-way.** Nothing in this sub-project may add `resumeSeries` or flip a series `paused → active` (sp3-rulings ruling 19 — the tripwire carries forward).
- Notifications via existing `notifyProfileMembers`; no new notification infrastructure.
- Commit at the end of every task; checkpoint commits at green welcome.

## File Structure

```
packages/shared/src/types.ts          # + BookingDoc, OfferEntry, AcceptedTerms, deposit/cancellation, visibility, reliability, caps; GIG_STATUSES + "filled"; GigDoc.bookingId/bookedMusicianProfileId; series booking linkage
packages/shared/src/validation.ts     # + validateOfferInput, validateBookingVisibility, computeExpectedTotalCents, computeDepositCents
functions/src/bookings.ts             # applyToGig, offerGig, counterBooking, declineBooking, withdrawBooking, acceptBooking
functions/src/bookingLifecycle.ts     # cancelBooking, reportNoShow, removeReliabilityMark, recomputeReliability
functions/src/bookingVisibility.ts    # rebuildBookingProjections, backfillBookingVisibility
functions/src/portfolio.ts            # modify: updateBookingInfo gains visibility + projection writes
functions/src/{gigs,gigSeries,review,profiles,scheduled,members}.ts  # modify: collisions, cascades, sweep steps, hardening
firestore.rules / firestore.indexes.json / tests-rules/rules.test.ts
apps/web/app/gigs/**                  # Find gigs + public gig detail + apply composer
apps/web/app/dashboard/**             # per-profile booking inboxes, thread screen, offer composer, Find musicians
apps/web/app/u/[handle]/**            # Shows wiring + public preferences
apps/web/app/admin/**                 # reliability panel + per-profile bookings list
apps/web/src/bookings/**  apps/mobile/src/bookings/**  apps/mobile/app/**   # shared booking components + mobile parity
```

---

### Task 1: Shared types, constants, math, validation

**Files:** Modify `packages/shared/src/types.ts`, `packages/shared/src/validation.ts`; Test `packages/shared/test/validation.test.ts` (extend).

**Interfaces — Produces (later tasks import these exact names):**
```typescript
// types.ts — booking domain
export const BOOKING_STATUSES = ["open", "confirmed", "completed", "declined", "withdrawn",
  "superseded", "expired", "cancelled_by_curator", "cancelled_by_musician"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export type BookingSide = "musician" | "curator";

export interface OfferEntry {
  by: BookingSide; amountCents: number;
  expectedQuantity: number | null;  // perSong: song count (required int ≥1); perHour: hours derived from gig duration (server-set); perSet: null
  note: string | null; at: number;
}
export interface AcceptedTerms { amountCents: number; expectedQuantity: number | null; expectedTotalCents: number; }
export interface BookingDeposit {
  amountCents: number; status: "unpaid";               // sub-5 adds "held" | "refunded" | "forfeited"
  forfeitedTo: "musician" | null;                       // set by cancellation outcome; money moves in sub-5
  policy: { percent: number; curatorForfeitHours: number; musicianMarkHours: number }; // snapshot, never re-read from constants
}
export interface BookingCancellation {
  by: BookingSide; reason: string; at: number; hoursBeforeStart: number;
  outcome: "deposit_forfeited" | "deposit_refunded"; markApplied: boolean;
}
// NOTE: named BookingRequestDoc because SP2's `BookingDoc` (the rates+prefs
// subdoc at profiles/{id}/private/booking) already owns the obvious name.
export interface BookingRequestDoc {
  gigId: string; seriesId: string | null;               // seriesId set ⇔ whole-run booking
  curatorProfileId: string; musicianProfileId: string;
  initiatedBy: BookingSide; structure: BudgetStructure; // copied from gig budget, immutable
  thread: OfferEntry[]; awaitingSide: BookingSide;
  status: BookingStatus;
  acceptedTerms: AcceptedTerms | null; deposit: BookingDeposit | null;
  cancellation: BookingCancellation | null;
  createdAt: number; updatedAt: number; confirmedAt: number | null; resolvedAt: number | null;
}

// visibility + projections + reliability
export type RateVisibility = "curators" | "private";    // rates are NEVER public (spec decision 4)
export type PrefsVisibility = "public" | "curators";
export interface BookingVisibility { perHour: RateVisibility; perSong: RateVisibility; perSet: RateVisibility; preferences: PrefsVisibility; }
export interface ReliabilitySummary { noShowCount: number; completedCount: number; }
export interface CuratorBookingDoc {                     // profiles/{id}/private/curatorBooking
  rates: BookingRates;                                   // structures marked "private" are null here even if set in the source
  preferences: BookingPreferences; reliability: ReliabilitySummary; updatedAt: number;
}
export interface ReliabilityMark {
  bookingId: string; gigId: string; kind: "late_cancel" | "reported_no_show";
  at: number; reportedByProfileId: string | null; removedByAdmin: boolean;
}
export interface ReliabilityDoc { marks: ReliabilityMark[]; completedCount: number; updatedAt: number; } // profiles/{id}/private/reliability

export const MAX_BOOKING_THREAD_ENTRIES = 50;
export const MAX_OFFER_NOTE_LENGTH = 280;
export const MAX_CANCEL_REASON_LENGTH = 500;
export const MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE = 25;
export const MAX_OFFER_AMOUNT_CENTS = 10_000_000;       // $100k
export const DEPOSIT_PERCENT = 35;
export const CURATOR_FORFEIT_WINDOW_HOURS = 72;
export const MUSICIAN_MARK_WINDOW_HOURS = 24;
export const MAX_RELIABILITY_MARKS = 200;
export const NO_SHOW_REPORT_WINDOW_DAYS = 14;
export const MAX_OFFER_SONG_COUNT = 500;                // quality-review hardening: named, was an inline literal
```
Gig/series/profile extensions: `GIG_STATUSES` gains `"filled"` (insert between `"open"` and `"closed"`); `GigDoc` gains `bookingId: string | null` and `bookedMusicianProfileId: string | null` (**public queryable linkage — the Shows section and the private/location rule both need it**; it names the booked act, which the curator page displays anyway; no terms leak); `GigSeriesDoc` gains `activeBookingId: string | null`, `bookedMusicianProfileId: string | null`; SP2's `BookingDoc` (the rates+prefs subdoc at `profiles/{id}/private/booking`) stays as-is and gains `visibility: BookingVisibility`; the new top-level interface is `BookingRequestDoc` (see NOTE above) — use that name everywhere in later tasks. `ProfileDoc` gains `publicBooking?: BookingPreferences | null` (**optional — as-built**: absent on pre-SP4 docs, readers use `?? null`, server writers stamp it; mirrors `BookingDoc.visibility?`'s migration strategy). SP2's `BookingDoc` visibility is likewise optional (`visibility?:`); Task 3's backfill converges real data. `validateBookingUpdate` delegates to `validateBookingVisibility` (quality-review hardening). `BookingUpdateInput` gains `visibility: BookingVisibility`. Extend `NotificationDoc["kind"]` with `"booking"`; `AuditLogDoc["action"]` with `"reliability_mark_removed" | "booking_visibility_backfilled"`.

```typescript
// validation.ts — pure, no Date.now() inside shared code
export function computeExpectedTotalCents(structure: BudgetStructure, amountCents: number,
  opts: { durationMinutes?: number; songCount?: number }): number {
  if (structure === "perSet") return amountCents;
  if (structure === "perHour") return Math.ceil(amountCents * (opts.durationMinutes ?? 0) / 60);
  return amountCents * (opts.songCount ?? 0);
}
export function computeDepositCents(expectedTotalCents: number): number {
  return Math.ceil(expectedTotalCents * DEPOSIT_PERCENT / 100);
}
export function validateOfferInput(structure: BudgetStructure,
  input: { amountCents: unknown; expectedQuantity: unknown; note: unknown }): string | null; // returns error string or null
export function validateBookingVisibility(v: unknown): v is BookingVisibility;
```
`validateOfferInput` rules: `amountCents` integer, `0 < x ≤ MAX_OFFER_AMOUNT_CENTS`; `note` null or string ≤ MAX_OFFER_NOTE_LENGTH; `expectedQuantity` — perSong: integer 1..500 required; perHour/perSet: must be null/undefined (server derives or ignores). `validateBookingVisibility`: exact four keys, each value from its legal set, prototype-safe (`Object.prototype.hasOwnProperty.call` — SP2 idiom), reject extra keys.

**Steps:** (1) failing tests — every validator branch incl. malformed types (string amounts, float cents, negative, note 281 chars, perSet with quantity, visibility with extra key / `"public"` on a rate / missing key); math: perHour 90min × $60/h = ceil(9000×90/60)=13500; perSong 12 × 800 = 9600; deposit ceil(13500×0.35)=4725; deposit rounding on odd cents (ceil(101×35/100)=36). (2) RED. (3) Implement (+ type extensions compile everywhere — expect `GIG_STATUSES` narrowing fallout in functions; fix with exhaustive switches, not casts). (4) GREEN + `pnpm typecheck`. (5) Commit.

---

### Task 2: Rules + indexes

**Files:** Modify `firestore.rules`, `firestore.indexes.json`; Test `tests-rules/rules.test.ts` (extend).

Rules changes (exact):
```
    // TIGHTEN (spec §6 / M-13 resolution): remove isApprovedCuratorMember() disjunct.
    // Curators now read the server-built projection below instead.
    match /private/booking { allow read: if isMember(profileId) || isAdmin(); allow write: if false; }
    match /private/curatorBooking {
      allow read: if exists(/databases/$(database)/documents/curatorAccess/$(request.auth.uid))
        || isMember(profileId) || isAdmin();
      allow write: if false;
    }
    match /private/reliability { allow read: if isMember(profileId) || isAdmin(); allow write: if false; }
```
(all three inside the existing `profiles/{profileId}` block; keep the file's cost idiom — cheap `isAdmin()` disjunct ordering per SP3 Task 14.)
```
    match /bookings/{bookingId} {
      allow read: if isMember(resource.data.curatorProfileId)
        || isMember(resource.data.musicianProfileId) || isAdmin();
      allow write: if false;
    }
```
Gig read widens for Shows + filled visibility — replace the `gigs` read rule with:
```
      allow read: if resource.data.status == 'open' || resource.data.status == 'filled'
        || (resource.data.status == 'closed' && resource.data.bookedMusicianProfileId != null)
        || isMember(resource.data.curatorProfileId) || isAdmin();
```
`gigs/{id}/private/location` read gains the booked musician (spec §6, SP3's promised reveal):
```
        allow read: if isAdmin()
          || isMember(get(/databases/$(database)/documents/gigs/$(gigId)).data.curatorProfileId)
          || (get(/databases/$(database)/documents/gigs/$(gigId)).data.bookedMusicianProfileId != null
              && isMember(get(/databases/$(database)/documents/gigs/$(gigId)).data.bookedMusicianProfileId));
```
Indexes: `bookings` composites (gigId ASC, status ASC), (musicianProfileId ASC, status ASC, updatedAt DESC), (curatorProfileId ASC, status ASC, updatedAt DESC), (seriesId ASC, status ASC); `gigs` composites (bookedMusicianProfileId ASC, startsAt ASC), **(bookedMusicianProfileId ASC, status ASC, startsAt ASC)** — the musician-page Shows query (rules force status to be pinned; explicit index, not zig-zag merge), and **(curatorProfileId ASC, status ASC, bookedMusicianProfileId ASC)** — the curator-page Shows query's closed-leg; keep SP3's existing entries. (Audit hardening: the `curatorBooking` exists() disjunct carries a `signedIn() &&` guard per the isAdmin idiom; the Shows queries MUST split per Task 11's note below.)

**Steps:** (1) failing rules tests — **curatorAccess-holder DENIED on `private/booking`** (the tighten; seeded marker, non-member), member still ✓, admin ✓; `curatorBooking`: curatorAccess ✓ / stranger ✗ / member ✓ / write ✗; `reliability`: member ✓ / curatorAccess ✗ / admin ✓; `bookings`: musician-side member ✓, curator-side member ✓, stranger ✗, admin ✓, writes ✗ both sides; gigs: anon reads `filled` ✓, `closed`+booked ✓, `closed` unbooked ✗; private/location: booked musician's member ✓, unbooked musician ✗. (2) RED (3) rules (4) GREEN, full rules suite (5) controller rules-audit (6) commit.

---

### Task 3: Visibility split — updateBookingInfo, projections, backfill

**Files:** Create `functions/src/bookingVisibility.ts`; Modify `functions/src/portfolio.ts` (updateBookingInfo), `functions/src/index.ts`; Test `functions/test/bookingVisibility.test.ts`, extend `functions/test/portfolio.test.ts` (file exists as part of emu suite — extend wherever updateBookingInfo's tests live).

**Interfaces — Produces:**
- `rebuildBookingProjections(profileId: string, source?: BookingDoc): Promise<void>` (exported helper, `bookingVisibility.ts`; **as-built after quality review**): with `source` passed, `batch.set` of the source doc joins the SAME batch as both projections (atomic triple — no crash-window staleness, no cross-call interleave); without it, reads `private/booking`. Also reads `private/reliability`; writes (a) `private/curatorBooking` — rates with `"private"` structures nulled out, full preferences, reliability summary (marks where `removedByAdmin == false` counted), `updatedAt`; (b) `profiles/{id}.publicBooking` — the preferences object iff `visibility.preferences == "public"`, else null. Missing booking doc (read path only) → both cleared (projection deleted, publicBooking null). Legacy docs without `visibility` project via the all-"curators" `DEFAULT_BOOKING_VISIBILITY` fallback — pinned by a direct test.
- `updateBookingInfo` (modify): input gains required `visibility` (`validateBookingVisibility`, else `invalid-argument`); builds docData and calls `rebuildBookingProjections(profileId, docData)` — the helper's batch commits source + projections together (it does NOT write the source doc itself).
- `backfillBookingVisibility()` (admin-gated onCall): pages musician profiles (SP3 `backfillDisplayNameLower` idiom, `set({...},{merge:true})` resilience); for each with a `private/booking` doc missing `visibility`: **rebuild projections FIRST, then merge-write the `visibility` marker as the per-profile commit point** (a mid-run crash self-heals on re-run in either order), default **all rates `"curators"`, preferences `"curators"`**. Per-doc try/catch (isolate-log-continue, sweep philosophy) with a `failed` counter. Audit `booking_visibility_backfilled`, detail `"N converged, M failed"`. Idempotent — second run converges 0.

**Steps:** failing tests — update with visibility writes source + projection (private perHour nulled in projection while set in source; prefs "public" populates `publicBooking`, "curators" nulls it); every-toggle matrix (8 combos via loop); non-member ✗; invalid visibility ✗; backfill converges seeded legacy docs, idempotent second run, non-admin ✗ → RED → implement → GREEN → commit.

---

### Task 4: Booking creation + negotiation callables

**Files:** Create `functions/src/bookings.ts`; Modify `functions/src/guards.ts` (add `requireApprovedMusicianProfile` mirroring the curator variant), `functions/src/index.ts`; Test `functions/test/bookings.test.ts`.

**Interfaces — Produces (exact export names):**
- `applyToGig({ gigId, musicianProfileId, offer: { amountCents, expectedQuantity?, note? } })` → `{ bookingId }`: caller is member of APPROVED musician profile; gig exists + `status == "open"`; curator profile approved (re-read); structure := gig.budget.structure; `validateOfferInput`; perHour `expectedQuantity` server-derived = `gig.durationMinutes / 60`; dedupe — no existing `open` booking for (gigId, musicianProfileId) (`already-exists`); cap — caller profile's `open` initiated bookings < MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE (count query, soft tier) else `resource-exhausted`; **whole-run detection**: if `gig.seriesId != null` and the series' `fillMode == "whole_run"` and `status == "active"`, set `seriesId` on the booking (else null); write BookingRequestDoc (`status:"open"`, `initiatedBy:"musician"`, `awaitingSide:"curator"`, thread=[entry]); notify curator profile members (kind `"booking"`).
- `offerGig({ gigId, musicianProfileId, offer })` → `{ bookingId }`: mirror image — caller is member of the gig's APPROVED curator profile; target musician profile approved; same validation/dedupe/cap (cap counts the CURATOR profile's open initiated bookings); `initiatedBy:"curator"`, `awaitingSide:"musician"`; notify musician profile members.
- `counterBooking({ bookingId, offer })`: caller is member of the `awaitingSide` profile (turn enforcement — `failed-precondition` otherwise); booking `open`; thread length < MAX_BOOKING_THREAD_ENTRIES else `resource-exhausted`; append entry (`by` = awaitingSide), flip `awaitingSide`, bump `updatedAt`; notify other side.
- `declineBooking({ bookingId })`: member of awaitingSide profile; `open → declined`, `resolvedAt`; notify.
- `withdrawBooking({ bookingId })`: member of the NON-awaiting side (you can withdraw only while the other side is deciding); `open → withdrawn`, `resolvedAt`; notify.
All five: full guard ordering per Global Constraints; every id `isValidDocId`.

**As-built (quality-review hardening):** counter/decline/withdraw run their turn/status/thread-cap checks against `tx.get(bookingRef)` inside `db.runTransaction` (a concurrently lost counter is impossible; membership resolution via `requireBookingSide` stays outside — profile-id fields are immutable — and it resolves a both-sides member to "musician" deterministically; the ambiguity REFUSAL is cancelBooking-only, Task 6). applyToGig's non-open-gig error is generic (no status echo to non-members); offerGig's keeps the status (caller is the gig's own member). `OfferEntry.expectedQuantity` is documented display-only — money math always goes through `computeExpectedTotalCents(durationMinutes)`. Extra indexes: bookings (gigId, musicianProfileId, status), (musicianProfileId, initiatedBy, status), (curatorProfileId, initiatedBy, status). Test-infra note: bookings tests must never leave `status:"active"` gigSeries fixtures behind (the shared emulator's later sweep tests scan them) — end them after use.

**Steps:** failing tests — apply happy path (doc shape incl. server-derived perHour quantity, whole-run seriesId set on whole_run occurrence / null on per_occurrence one); apply ✗: unapproved musician, unapproved curator, non-open gig, duplicate open pair, cap at 25 (seed via admin SDK), bad offer (float cents / long note / perSet-with-quantity); offer mirror happy + ✗ non-member-of-curator; counter: turn-enforced (wrong side ✗), flips awaitingSide, cap 50 (seed 50-entry thread); decline by awaiting side ✓ / wrong side ✗; withdraw by non-awaiting ✓ / awaiting side ✗; notifications asserted (poll notification docs) → RED → implement → GREEN → commit.

---

### Task 5: acceptBooking — the fill transaction

**Files:** Modify `functions/src/bookings.ts`, `functions/src/index.ts`; Test extend `functions/test/bookings.test.ts`.

**Interfaces — Produces:** `acceptBooking({ bookingId })` — caller is member of awaitingSide profile; booking `open`. Transaction:
1. Re-read booking (still `open`), gig (still `"open"` else `failed-precondition` "gig is no longer available"); whole-run: re-read series (`status == "active"` else same error) + query the run's other occurrences inside the txn window (bounded: series occurrences are ≤ the 8-week window).
2. Freeze `acceptedTerms` from the LAST thread entry: `{ amountCents, expectedQuantity, expectedTotalCents: computeExpectedTotalCents(structure, amountCents, { durationMinutes: gig.durationMinutes, songCount: expectedQuantity ?? undefined }) }` (whole-run: per-occurrence values — each occurrence uses its own durationMinutes for perHour; store the INITIATING gig's terms, sub-5 recomputes per occurrence from `acceptedTerms.amountCents`).
3. `deposit = { amountCents: computeDepositCents(expectedTotalCents), status: "unpaid", forfeitedTo: null, policy: { percent: DEPOSIT_PERCENT, curatorForfeitHours: CURATOR_FORFEIT_WINDOW_HOURS, musicianMarkHours: MUSICIAN_MARK_WINDOW_HOURS } }` (whole-run: per-occurrence amount).
4. Booking → `confirmed` (+`confirmedAt`); gig(s) → `filled` + `bookingId` + `bookedMusicianProfileId` (whole-run: every currently-`open` occurrence of the series); whole-run: series gains `activeBookingId` + `bookedMusicianProfileId`.
5. Post-transaction (not in txn — fan-out): flip sibling `open` bookings to `superseded` (`resolvedAt`) — same gigId; whole-run: also any booking whose `seriesId` == this series OR whose gigId is any of the run's filled occurrences — and notify each superseded musician profile + both winners. Supersede fan-out is idempotent + failure-logged (`logDeleteFailure`-style pattern: log and continue, the sweep's expiry step is the backstop for missed ones).

**Steps:** failing tests — accept happy path (gig filled + linkage, terms frozen from last counter not first offer, deposit math incl. ceil, awaitingSide enforcement, confirmedAt); race: gig flipped `closed` before accept → `failed-precondition`, booking untouched; supersede: two rival open bookings → both `superseded` + notified, winner `confirmed`; whole-run: 3 seeded open occurrences all filled + series stamped, rival booking on a DIFFERENT occurrence of the run superseded; whole-run ✗ when series paused mid-thread → RED → implement → GREEN → commit.

**As-built (quality hardening):** zero-`expectedTotalCents` tripwire (failed-precondition before any write); supersede uses a REAL optimistic precondition (`update(..., { lastUpdateTime: doc.updateTime })`, per-booking catch absorbs lost races and skips the notification); acceptBooking's post-commit winner-notification tail is try/catch-isolated so `{ ok: true }` is reliable once the txn commits (decline/withdraw deliberately keep the codebase-wide convention); a perSong accept test pins amount×songCount + deposit ceil (6531/2286); extra index `gigs (seriesId, status)` for the in-txn occurrence query; bookings.test.ts testTimeout 20s (function-count dispatch overhead, bookingVisibility precedent).

---

### Task 6: Cancellation, no-show reporting, reliability

**Files:** Create `functions/src/bookingLifecycle.ts`; Modify `functions/src/index.ts`; Test `functions/test/bookingLifecycle.test.ts`.

**Interfaces — Produces:**
- `recomputeReliability(musicianProfileId)` (exported helper): recounts non-removed marks + completedCount from `private/reliability`, rewrites the summary inside `private/curatorBooking` (merge — projection may not exist yet if no booking doc; create summary-only doc then).
- `cancelBooking({ bookingId, reason })`: member of EITHER side (side inferred from membership; member of both → `failed-precondition` ambiguous, tests pin it); booking `confirmed`; `now < startsAt` of the next affected occurrence (whole-run: earliest future `filled` occurrence of the run; single: the gig) else `failed-precondition` "already started — report instead"; reason 1..MAX_CANCEL_REASON_LENGTH. Effects: `hoursBeforeStart` computed vs that next occurrence; curator side → outcome `deposit_forfeited` iff `< CURATOR_FORFEIT_WINDOW_HOURS` (set `deposit.forfeitedTo:"musician"`) else `deposit_refunded`; musician side → always `deposit_refunded`, `markApplied` iff `< MUSICIAN_MARK_WINDOW_HOURS` (append `late_cancel` mark, cap MAX_RELIABILITY_MARKS drop-oldest — SP3 flagAccount idiom — then `recomputeReliability`); status → `cancelled_by_curator|_musician`; reopen every future affected gig (`filled → open`, clear both linkage fields); whole-run: clear series `activeBookingId`/`bookedMusicianProfileId`; started/past occurrences keep status; notify both sides with outcome copy.
- `cancelOccurrence({ bookingId, gigId, reason })`: whole-run only (`failed-precondition` on single-gig bookings); same window/outcome math **for that occurrence only** (curator <72h forfeits that occurrence's deposit — record appended to a `occurrenceCancellations: { gigId, by, at, hoursBeforeStart, outcome, markApplied }[]` array on the booking, capped 100; musician <24h → one mark); that gig reopens; booking stays `confirmed`; run continues.
- `reportNoShow({ bookingId, reason })`: member of the curator side; booking `confirmed` (start passed) or `completed`; within NO_SHOW_REPORT_WINDOW_DAYS after the (relevant occurrence's) start; once per booking (`already-exists` if a `reported_no_show` mark exists for it); flips to `cancelled_by_musician` (cancellation record: outcome `deposit_refunded`, markApplied true, hoursBeforeStart negative actual); append `reported_no_show` mark (+ `reportedByProfileId`); `recomputeReliability`; notify musician side. **PLAN AMENDMENT (Task 6 execution):** on a whole-run booking, flipping the run to `cancelled_by_musician` must ALSO reopen the run's FUTURE `filled` occurrences (filled → open, clear `bookingId`/`bookedMusicianProfileId`) and clear the series' `activeBookingId`/`bookedMusicianProfileId` — mirroring cancelBooking's unwind — otherwise future filled occurrences stay linked to a dead booking forever (the materializer only self-heals occurrences it hasn't birthed yet, and no sweep step reopens filled gigs of a cancelled booking). Single-gig bookings need no gig-side change (the gig is past by definition; the sweep closes it).
- `removeReliabilityMark({ musicianProfileId, bookingId, kind })`: ADMIN (`requireAdmin`); sets `removedByAdmin: true` on the matching mark (audit-preserving — never splices); `recomputeReliability`; audit `reliability_mark_removed`; notify musician profile members.

**Steps:** failing tests — curator cancel at 80h (refund) / 71.9h (forfeit → forfeitedTo musician, gig reopens + linkage cleared); boundary exactly 72.0h → refund (strict `<`); musician cancel 30h (refund, no mark) / 20h (mark applied, projection count 1); whole-run cancel mid-run (future reopen, past untouched, series cleared, ONE mark); cancelOccurrence (run survives, one date reopens); reportNoShow (completed → cancelled_by_musician + mark; double-report ✗; day-15 ✗; stranger-curator ✗); removeReliabilityMark (flag set, count drops, audit, non-admin ✗); already-started cancel ✗ → RED → implement → GREEN → commit.

**As-built (quality hardening, binding on later tasks):** all occurrence selection/unwind is BOOKING-scoped — reportNoShow's relevant occurrence = `gigs where bookingId ==, startsAt <= now, desc, limit 1` (new index `gigs (bookingId, startsAt)`); `getFutureFilledOccurrences(bookingId)` post-filters to the booking; `reopenSeriesOccurrences` clears series linkage only when `activeBookingId === bookingId` (series read in-txn). Late-cancel marks append IN the main transaction (reliability doc read unconditionally in the read phase — crash cannot orphan `markApplied:true`); recomputeReliability stays post-txn. Ambiguity refusal (both-sides member) lives ONLY in bookingLifecycle's `resolveBookingSideStrict`. `now` captured once per invocation (decision + record always consistent). Extra shared additions: `OccurrenceCancellation`, `BookingRequestDoc.occurrenceCancellations?` (cap `MAX_OCCURRENCE_CANCELLATIONS=100`), index `gigs (seriesId, status, startsAt)`.

**Carried to Task 7 (from Task 6's review):** (a) **the rebooking door**: a `cancelOccurrence`-reopened date on a still-active whole_run series accepts a fresh whole-run applyToGig, and `acceptBooking` never guards `series.activeBookingId === null` — Task 7 must add that in-txn guard (refuse accept on a series already linked to another confirmed booking); (b) **zombie-run advice**: after cancelling the run's last future date (or when all remaining dates were re-filled by a later booking), `cancelBooking` refuses with "already started — report instead", which is wrong advice — reconcile the message or the state. **Sub-5 handoff note (record in Task 14's README step):** `occurrenceCancellations` entries are settlement inputs — sub-5 must treat a full (100-entry) array as a tripwire, and drop-oldest as unacceptable there if runs ever get that long.

---

### Task 7: Series/lifecycle collisions + cascades

**Files:** Modify `functions/src/gigSeries.ts` (pauseSeries/endSeries), `functions/src/gigs.ts` (takedownGig, cancelGig), `functions/src/review.ts` (reject-from-approved cascade), `functions/src/profiles.ts` (deleteProfile cascade); Test extend `functions/test/{gigSeries,gigs,review,profiles}.test.ts`.

**Interfaces — Produces (one shared helper in `bookingLifecycle.ts`):** `unwindBookingsForModeration(opts: { gigIds?: string[]; seriesId?: string; profileId?: string })` — finds affected `open` bookings → `expired`; `confirmed` bookings → `expired` with NO cancellation record, NO forfeiture, NO marks (moderation is nobody's fault; deposits refund — comment: sub-5 reads `expired`+`deposit` as refund); reopens nothing (the gigs are being taken down/cancelled by the caller); clears series linkage when seriesId given; notifies affected musician sides. Callers:
- `takedownGig` (occurrence + series scopes) → unwind for the affected gig(s)/series.
- `cancelGig` (curator cancels a still-`open` gig) → open bookings on it expire ("gig was cancelled" copy). A `filled` gig is NOT cancellable via cancelGig (`failed-precondition` — "cancel the booking instead"); tests pin this.
- `pauseSeries`/`endSeries` with `activeBookingId` → **curator-side run cancellation semantics** (spec §4): call into `cancelBooking`'s window logic with a synthetic reason `"Series paused by curator" / "Series ended by curator"` (refactor `cancelBooking`'s core into an internal `executeCancellation(booking, side, reason, now)` both paths share), then proceed with the SP3 pause/end behavior.
- `reviewProfile` reject-from-approved cascade (either profile type) + `deleteProfile` cascade → `unwindBookingsForModeration({ profileId })` (bookings where the profile is either side), added to the existing cascades; deleteProfile additionally leaves the OTHER side's docs intact (bookings are top-level — they survive as `expired` records referencing a dead profile id; comment says sub-5 must tolerate that). **PLAN AMENDMENT (Task 7 execution):** the curator reject cascade must ALSO handle `filled` gigs — future-dated: flip to `closed` + clear `bookingId`/`bookedMusicianProfileId` (else the gig stays publicly readable via the `filled` read-allow and renders as a phantom upcoming Show on the musician's page); past: leave untouched (linkage kept forever — the show happened; musician Shows history retains it; full scrub = the deliberate two-step reject → deleteProfile).

**Steps:** failing tests — takedown occurrence with confirmed booking (booking expired, no mark/forfeit, musician notified); takedown series scope (run booking expired, series cleared); cancelGig on filled ✗; pauseSeries with active run booking at 71h before next occurrence → curator forfeit recorded on that occurrence + run unwound + series paused; reject-from-approved musician profile with confirmed booking → expired; deleteProfile cascade → RED → implement → GREEN (SP3 cascade regressions watched) → commit.

**As-built (review fixes, binding):** series-scope takedown sweeps BOTH open and filled siblings to `taken_down` (P11 resolved); occurrence-scope unwind SKIPS confirmed whole-run bookings (`gigId`-net only — series/profile nets still expire them; admin tool for removing a booked run = series scope; the occurrence path notifies the run's musician side "one date is no longer available", no reason leak); pauseSeries/endSeries tolerate the no-cancellable-dates family via `cancelActiveRunBookingTolerant` (exact-match on the two exported message constants; booking + linkage left for Task 8's sweep resolver); takedown audit precedes the unwind fan; the unwind's series-linkage clear is a separate best-effort `{ lastUpdateTime }`-preconditioned write. Nit for the next bookingLifecycle/gigSeries commit: add the one-line "upgrade path: coded HttpsError details instead of message identity" comment on the tolerant catch.

---

### Task 8: Sweep additions + run-aware materializer

**Files:** Modify `functions/src/scheduled.ts`; Test extend `functions/test/scheduled.test.ts`.

**Interfaces — Produces:** `SweepReport` gains `{ bookingsExpired, bookingsCompleted, occurrencesBornFilled }`. New steps (after the existing 5, same per-step try/catch isolation):
6. **Expire:** `open` bookings whose gig `startsAt < now` OR gig status ∉ {open} → `expired` (+notify) — the backstop for missed supersedes/unwinds. Paginated like SP3's steps.
7. **Complete:** `confirmed` bookings whose (whole-run: LAST) affected occurrence `startsAt + durationMinutes` passed → `completed`; increment `completedCount` in `private/reliability` (create-if-missing) + `recomputeReliability`. **AMENDMENT (Task 7 review):** occurrence linkage is booking-scoped — "affected occurrences" = gigs where `bookingId == <booking>`; additionally, a `confirmed` whole-run booking with ZERO future linked filled occurrences (zombie run — all dates per-occurrence-cancelled or taken down) resolves here: → `completed` if any past linked occurrence exists, else `expired`; clear the series' `activeBookingId`/`bookedMusicianProfileId` ownership-gated. This is the committed resolver for the pause/end tolerance path (pauseSeries/endSeries skip cancellation on the no-cancellable-dates case and leave the booking for this step). **Sub-5 handoff note (fold into Task 14 README): a booking-linked `taken_down` occurrence settles as not-performed.**
Materializer change (step 1): when a series has `activeBookingId` (and the booking re-read is still `confirmed`), birth occurrences as `status:"filled"` + `bookingId` + `bookedMusicianProfileId`; **skip the MAX_OPEN_GIGS_PER_PROFILE precheck for filled births** (committed work — spec §4); the SP3 per-series status re-read and watermark logic unchanged; if the booking re-read is NOT confirmed (race), birth `open` and clear the series linkage (self-heal, counted in report).

**Steps:** failing tests with injected clock — expiry of stale open booking; completion (single: after end; whole-run: only after the LAST occurrence ends; completedCount + projection bumped); materializer births filled with linkage for booked run; races: series linkage present but booking cancelled → births open + clears linkage; double-run idempotency across all new steps → RED → implement → GREEN → commit.

**As-built (review + ruling):** step 7's last-linked query filters `status=="filled"` (ruling — no completedCount credit for taken-down dates; index `gigs (bookingId, status, startsAt)`); step 7 flips each booking with a DIRECT await update before side effects (crash re-run = at-most-one lost increment, never unbounded overcount; no chunked writer in step 7); step 6's expire condition includes missing gig docs (deleteProfile cascade); split notify try/catches; counter named `wholeRunResolutions` (counts natural run-course too); past FILLED gigs deliberately stay `filled` forever (step 2 closes open only; Shows splits on startsAt); the ms-conversion boundary (`durationMinutes * 60_000`) is pinned by a started-not-ended test. Net-new indexes this task: (bookingId, status, startsAt) only — (bookingId, startsAt) landed in Task 6.

---

## UI tasks (9–12) — shared rules

Backend contracts above are the source of truth. Every screen: busy locks per action, explicit failure states, cancellation guards on async effects, keyed remounts on identity switches, shared validators mirrored client-side, server error messages surfaced verbatim in friendly wrappers. **Mobile screens run the SP2 plan Tasks 13/14 DO-NOT-COPY checklists before task close.** Money inputs in dollars converted to integer cents (SP3 composer idiom); all gig times via `LAUNCH_TIMEZONE`. Deposit honesty line everywhere a deposit is shown: "35% deposit ($X) will be collected when payments launch." Verification per task: typecheck + lint + live-emulator walkthrough described in the report (web dev server / mobile programmatic script).

### Task 9: Web — Find gigs, gig detail, apply composer; Find musicians, offer composer

**Files:** Create `apps/web/app/gigs/page.tsx` (+ `apps/web/src/bookings/GigBrowse.tsx`), `apps/web/app/gigs/[gigId]/page.tsx`, `apps/web/src/bookings/OfferComposer.tsx`; Create `apps/web/app/dashboard/curator/[profileId]/musicians/page.tsx` (+ `apps/web/src/bookings/MusicianBrowse.tsx`).
**Consumes:** `applyToGig`, `offerGig`, gigs/profiles/curatorBooking reads.
**Requirements:** Find gigs — public page, `status=="open"` query ordered `startsAt`, client-side filter controls for city (text match on `location.city`), genre, structure, date range mapped to indexed queries where indexes exist (city+genre combos filter client-side over the date-window result — placeholder-grade per spec §1, sub-8 replaces); cards show title/date(TZ)/duration/budget+structure/wants/public-precision location + series badge (**as-built**: gigSeries is member-only readable, so the PUBLIC browse page derives a softer "Part of a recurring series" badge from `seriesId != null` alone — no series fetch; exact fill semantics render only on the gig DETAIL page via a permission-denied-tolerant fillMode fetch). Sub-8 note: the musicians directory page's gate mirrors the sanctioned dashboard shape and does not pin membership of THAT profile — any approved-curator member can load a foreign /musicians URL (reads prove via their own curatorAccess; offerGig refuses server-side) — fold into sub-8's directory rework. Gig detail — full public doc + Apply panel: musician-profile picker (caller's approved musician profiles), offer form (amount in dollars, song count when perSong, note), disabled states + "already applied" from dedupe error. Find musicians — curator-context page (member-gated client-side like other dashboard pages): approved musician profiles query, genre/actSize filters, per-card `private/curatorBooking` fetch (rates summary + reliability — copy counts BOOKINGS not dates, an 8-date completed run is +1: "N no-shows / M bookings"), links to portfolio + "Offer a gig" → OfferComposer: picks one of YOUR open gigs (query), terms form, submits `offerGig`.

### Task 10: Web — booking inboxes + thread screen

**Files:** Create `apps/web/app/dashboard/bookings/[bookingId]/page.tsx` (+ `apps/web/src/bookings/{BookingThread,OfferForm,CancelDialog}.tsx`); Modify `apps/web/app/dashboard/portfolio/[profileId]/page.tsx` and `apps/web/app/dashboard/curator/[profileId]/page.tsx` (inbox sections).
**Consumes:** `counterBooking`, `acceptBooking`, `declineBooking`, `withdrawBooking`, `cancelBooking`, `cancelOccurrence`, `reportNoShow`, bookings reads.
**Requirements (Task 8 review carry-forwards):** `NotificationDoc` has NO reference-id field, so booking notifications can't deep-link — this task ADDS optional `refId?: string` to `NotificationDoc` (shared types, backward-compatible) and sets it (bookingId) at every booking notify call site (bookings.ts, bookingLifecycle.ts, scheduled.ts steps 6/7), then deep-links notification rows to the thread screen. History/thread rendering must handle `expired` bookings that WERE confirmed runs (`acceptedTerms`/`confirmedAt` set) — copy must not read like a declined application. Inbox per profile (both dashboards): three lists via the (profileId,status) indexes — open threads (badge "your turn" from awaitingSide vs my side), upcoming confirmed (next date, deposit line), history (terminal statuses + completed). Thread screen: role derived from which profile the user belongs to (query both memberships; member of both → an informational "you're on both sides" notice, with only the CANCEL/report actions disabled — the server's ambiguity refusal is cancelBooking-only per the Task 4 ruling; negotiation actions stay enabled and the server resolves the actor side musician-first); offer history with current-offer highlight + "thread N/50"; turn-aware action bar (Accept [amount] / Counter… / Decline for awaiting side; Withdraw for the other); confirmed view: terms, deposit honesty line, cancel button → CancelDialog with live window warning ("Cancelling now forfeits your deposit — the gig is in 68h" / "This will add a no-show mark to your record") computed client-side from the same constants; whole-run view lists occurrences with per-date cancelOccurrence; post-start curator view offers "Report a no-show" (reason, once). Notifications deep-link here (existing notification list renders kind `"booking"` with a link).

### Task 11: Web — Shows wiring, public preferences, admin panels

**Files:** Modify `apps/web/app/u/[handle]/MusicianProfile.tsx` + `CuratorProfile.tsx` (Shows section, publicBooking prefs), `apps/web/app/u/[handle]/page.tsx` (data), `apps/web/app/admin/page.tsx` (reliability panel + bookings list).
**Consumes:** gigs Shows query, `ProfileDoc.publicBooking`, `removeReliabilityMark`, admin bookings/reliability reads.
**Requirements:** Shows (SP2's hidden-while-empty contract, now real). **Rules-provability constraint (Task 2 audit, verified in emulator):** the musician page queries `bookedMusicianProfileId == profileId` + `status in ["filled","closed"]` + orderBy startsAt (status MUST be pinned in the query — client-side status filtering is rules-DENIED); the curator page MUST split into two queries — `(curatorProfileId==X, status=="filled")` and `(curatorProfileId==X, status=="closed", bookedMusicianProfileId > "")` — a combined `status in` query cannot prove the closed-leg's booked constraint. Musician page — split upcoming (`startsAt > now`, "Upcoming shows") / past ("Past shows", newest first, cap 20 each) rendering date(TZ)/venue-or-city at public precision/curator name link; curator page — same for its own filled/closed-booked gigs ("featuring <musician link>"). SSR path reuses the existing server-side Firestore machinery + `revalidate` (indexes from Task 2 make it provable). Public preferences: `publicBooking != null` → "Booking preferences" section (act size, set length, PA, availability) — NEVER rates. Admin: profile lookup gains reliability panel (marks table w/ kind/date/source booking, Remove button → callable, busy per-row) + bookings list (by profile id, any status, admin read) with links; both behind the existing admin gate UI.

### Task 12: Mobile parity

**Files:** Create `apps/mobile/src/bookings/{GigBrowse,MusicianBrowse,BookingThread,OfferForm,CancelDialog,BookingInbox}.tsx`; Create `apps/mobile/app/(musician)/gigs.tsx` + `bookings.tsx` tabs, `apps/mobile/app/(curator)/musicians.tsx` + `bookings.tsx` tabs, `apps/mobile/app/booking/[bookingId].tsx` (shared thread route); Modify `apps/mobile/app/artist/[handle].tsx` (Shows + public prefs), tab layouts.
**Requirements:** feature parity with Tasks 9–10 web behavior (filters may be simpler chip-toggles — SP3 ruling 14 precedent); thread screen parity incl. window-warning cancel dialog and run occurrence list; inbox badges on both role tabs; artist page Shows + publicBooking sections match web rendering rules; RN money/date inputs follow SP3 GigForms idioms (no silent date rollover — SP3's fix applies); DO-NOT-COPY checklists run per screen; mobile lint stays green; `npx expo export --platform ios` passes.

---

### Task 13: Inherited hardening (sp3-rulings post-gate list)

**Files:** Modify `functions/src/scheduled.ts`, `functions/src/gigs.ts`, `functions/src/members.ts`, `functions/src/profiles.ts`, `functions/src/curator.ts`; Test extend the matching test files.

All seven items from sp3-rulings "Post-gate follow-ups" (each with a pinning test where noted):
1. Sweep step 5 curatorAccess-retry drain: per-doc try/catch so one poisoned uid can't starve the queue (test: seeded failing uid first in queue, second uid still drains — force failure via an invalid uid the sync helper rejects).
2. `gigs.ts` updateGig neighborhood→public branch: `.data() as GigPrivateLocation | undefined` + explicit `internal` HttpsError when missing (test: delete the subdoc via admin SDK, assert HttpsError not TypeError).
3. `removeMember`: add `isValidDocId` guards + `requireVerifiedEmail` (tests: bad ids → `invalid-argument`; unverified → `failed-precondition`).
4. S4 test gap: removing a member from an already-REJECTED curator profile holding a stale curatorAccess marker recomputes to deletion.
5. `deleteProfile`: move the `handles/{handle}` delete AFTER the gig/series/booking cascade (test asserts handle still resolvable mid-failure is not directly testable — restructure + existing cascade tests stay green; comment records the ordering rationale).
6. Invite-accept fast path: after the membership transaction, re-read profile status (or call `syncCuratorAccess`) instead of trusting the pre-transaction snapshot (test: flip profile to rejected between snapshot and accept via the test's own sequencing where feasible; at minimum the post-accept recompute path is asserted).
7. `syncCuratorAccess`: page the memberships collection-group query (limit 100 + cursor loop) — behavior-preserving, existing tests must stay green.
8. **(Added by Task 4's review)** Materializer step 1: per-SERIES try/catch inside the loop (isolate-log-continue, count in `SweepReport`) — today one poisoned series (malformed template reaching Firestore write) aborts the whole materialization step for every series, every run, until manually fixed. Pre-existing SP3 tier, unreachable via normal writes (createSeries validates), but the failure mode is nasty and the fix matches the sweep's own philosophy. Test: seed one poisoned + one healthy active series, assert the healthy one still materializes.

**Steps:** per item — failing test where the list specifies one → RED → fix → GREEN; items 5/7 are refactors guarded by the existing suites → full functions suite green → commit (one commit per item or one for the task, implementer's call).

---

### Task 14: Cleanup, docs, backfill note, gates

**Files:** Modify `README.md`, `docs/superpowers/sp3-rulings.md` (mark M-12/M-13 + booking-widening obligations RESOLVED with a pointer to this sub-project), verify `firestore.indexes.json` deployed-shape.
**Steps:**
1. README: booking-flow concepts blurb (both doors, thread, deposit-as-data, windows, no-show marks, visibility tiers), `backfillBookingVisibility` one-shot deploy instruction (alongside the SP3 backfill note), launch checklist additions (run the visibility backfill before curators lose the old read — order matters: deploy rules AND backfill in the same release), sub-5 handoff pointers (deposit statuses, `acceptedTerms`, `occurrenceCancellations` full-array tripwire, linked-`taken_down`-occurrence-settles-as-not-performed, per-occurrence settlement basis = step 7's filled-linked-gigs set), sub-8 note (directories are placeholder-grade). **Scale/hardening follow-ups to record (Task 8 review):** materializer birth-decision race — a cancelBooking landing between step 1's per-series read and its end-of-step commit yields filled gigs linked to a non-confirmed booking with NO reconciling sweep step (accepted at v1 daily-sweep-window probability; fix menu: filled-linkage sanity-check step, or per-series batches with lastUpdateTime precondition); step 6 could batch gig reads via `db.getAll` per page.
2. sp3-rulings.md: annotate rulings 23/24 + the M-13/M-12 obligation bullets as resolved by SP4 (edit in place with "RESOLVED (SP4):" prefixes — the doc stays the historical record, the annotations stop future planners re-litigating).
3. Full sweep: `pnpm typecheck` · shared tests · `pnpm emu:test` · `pnpm emu:rules` · both lints · web build · mobile export — all green, outputs captured.
4. Controller gates: whole-branch rules audit, full security review, final whole-branch review — per the established process.
5. Commit.

## Done means

All 14 tasks committed and review-gated; suites green (expect shared ≈110+, functions ≈340+, rules ≈75+); `fillMode` consumed, `filled` live, Shows wired (SP2 contract discharged), M-12/M-13 structurally resolved, sp3 post-gate list settled, pause still one-way; branch merged per finishing-a-development-branch after the final review.
