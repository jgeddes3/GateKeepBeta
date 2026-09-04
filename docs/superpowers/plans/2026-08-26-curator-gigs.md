> **Historical execution record.** This plan was executed and reviewed task by task; its snippets may predate the review fixes that shipped.
> Where the plan and the code disagree, the code and this sub-project's rulings doc win (`docs/superpowers/HANDOFF.md` lists them).

# Curator Profiles & Gig Postings Implementation Plan (Sub-project 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Curators get the full portfolio treatment (wizard, required preferences, photos, public SSR page) and can post one-off + recurring gigs with budget/location privacy semantics; admins get gig moderation, queue upgrades, and name search; the shared scheduled job materializes series and pays down SP2's reaper debt.

**Architecture:** Extends the SP2 codebase in place: new `gigs` + `gigSeries` collections (callable-written, template + materialized occurrences), curator content on `profiles/{id}`, one daily scheduled function (materialize + sweeps), takedown cascade inside `reviewProfile`'s reject-from-approved path, geocoding behind a server-side adapter interface. UI reuses SP2's shipped component/guard patterns on web and mobile.

**Tech Stack:** unchanged, TypeScript strict, pnpm monorepo, Firebase (Functions v2 + **v2 scheduler**, Firestore, Storage, emulators), Next.js 16 web, Expo mobile, vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-curator-gigs-design.md`
**Prior art the implementer MUST mirror:** SP2 plan `docs/superpowers/plans/2026-08-25-musician-portfolio.md` (as-built snippets; its Tasks 13/14 DO-NOT-COPY checklists bind every new mobile screen), `functions/src/{tracks,portfolio,media,review}.ts`, `apps/web/app/u/[handle]/`, `apps/web/app/dashboard/`, `apps/web/app/admin/`, `apps/web/app/join/`.

## Global Constraints

- Project id `gatekeep-dev-jg`; region us-central1. Java on PATH for emulators (see README); `FUNCTIONS_DISCOVERY_TIMEOUT=60` on Windows. Always build functions before `pnpm emu:test` (root script does it).
- Baseline suites that must never regress: shared 44 · functions 104 · rules 39 · both lints · web build. TDD for every functions/rules task (RED before GREEN, evidence in reports).
- **Vocabulary reconciliation (binding):** curator wants reuse SP2's exact enums, `genres: GENRES[]`, `actSizes: ACT_SIZES[]` ("dj" from the spec is expressed via genres electronic/dance, record in spec review). Budget structure literals are the `BookingRates` keys: `"perHour" | "perSong" | "perSet"`; money in `amountCents` integers.
- Clients NEVER write `gigs`, `gigSeries`, `adminNotes`, or profile docs, callables only. Every rules change passes the security-rules audit (controller-run) before the task completes.
- Callable conventions from SP1/2: guards from `functions/src/guards.ts` (this plan consolidates the stragglers), `HttpsError` codes asserted in tests via `.rejects.toMatchObject({ code: "functions/<code>" })`, `vi.setConfig({ testTimeout: 15_000 })`, poll never sleep.
- Caps (server-enforced, `resource-exhausted`): ≤50 `open` gigs and ≤10 `active` series per profile; 1 curator profile in `pending_review` per account; 24h resubmit cooldown after rejection (`failed-precondition`).
- Scheduled job runs daily; all its logic lives in an exported plain function `runDailySweep(now: number)` so tests invoke it directly with an injected clock, the schedule wrapper is a thin shell.
- Location privacy: non-venue gigs default `addressVisibility: "neighborhood"` with coarsened public `geo`; exact address+geo ALWAYS in `gigs/{id}/private/location`. Venue-profile gigs default `"public"`.
- Commit at the end of every task; checkpoint commits at green tests welcome.

## File Structure

```
packages/shared/src/types.ts          # + GigDoc, GigSeriesDoc, CuratorDetails, LookingFor, GigLocation, caps
packages/shared/src/validation.ts     # + validateLookingFor, validateGigContent, validateBudget, validateRecurrence
functions/src/guards.ts               # + requireCuratorProfile, requireApprovedCuratorProfile (consolidation target)
functions/src/geocode.ts              # geocode(address) interface + stub adapter + provider slot
functions/src/curator.ts              # updateCuratorProfile (content), submit-gate additions live in profiles.ts
functions/src/gigs.ts                 # createGig, updateGig, publishGig, cancelGig, takedownGig
functions/src/gigSeries.ts            # createSeries, updateSeries, pauseSeries, endSeries
functions/src/scheduled.ts            # runDailySweep + onSchedule wrapper (materialize, past-sweep, track reaper, invite sweep)
functions/src/adminTools.ts           # flagAccount; users displayNameLower trigger + search support
functions/src/{profiles,review}.ts    # modify: curator gate, pending-cap, cooldown; takedown cascade
firestore.rules / firestore.indexes.json / tests-rules/rules.test.ts
apps/web/app/join/** apps/web/app/dashboard/** (curator editor + gig composer)  apps/web/app/u/[handle]/** (curator SSR)
apps/web/app/admin/** (gig list, queue upgrades, name search)
apps/mobile/app/(curator)/** apps/mobile/src/** (wizard/editor/composer parity)
```

---

### Task 1: Shared types, constants, validation

**Files:** Modify `packages/shared/src/types.ts`, `packages/shared/src/validation.ts`; Test `packages/shared/test/validation.test.ts` (extend).

**Interfaces, Produces (later tasks import these exact names):**
```typescript
// types.ts additions
export const GIG_STATUSES = ["draft", "open", "closed", "cancelled", "taken_down"] as const;
export type GigStatus = (typeof GIG_STATUSES)[number];
export const SERIES_STATUSES = ["active", "paused", "ended"] as const;
export type SeriesStatus = (typeof SERIES_STATUSES)[number];
export const SERIES_CADENCES = ["weekly", "biweekly", "monthly"] as const;
export type SeriesCadence = (typeof SERIES_CADENCES)[number];
export const FILL_MODES = ["per_occurrence", "whole_run"] as const;
export type FillMode = (typeof FILL_MODES)[number];
export type BudgetStructure = "perHour" | "perSong" | "perSet"; // BookingRates keys
export type AddressVisibility = "public" | "neighborhood";

export interface LookingFor { genres: string[]; actSizes: ActSize[]; notes: string | null; }
export interface CuratorDetails {
  about: string;
  lookingFor: LookingFor;
  amenities: { capacity: number | null; hasPA: boolean | null; hasBackline: boolean | null;
               indoorOutdoor: "indoor" | "outdoor" | "both" | null; notes: string | null };
  advertisingInterest: boolean;
  // venues: full street address (public). planners/hosts: city only.
  location: { address: string | null; city: string; neighborhood: string | null;
              geo: { lat: number; lng: number } | null };
  photoPaths: string[];          // public/photos/... (SP2 photo pipeline)
}
// lives on ProfileDoc as `curator?: CuratorDetails` (curators only; seeded by createProfileDraft)

export interface GigBudget { minCents: number; maxCents: number; structure: BudgetStructure; }
export interface GigWants { genres: string[]; actSizes: ActSize[]; }
export interface GigPublicLocation {
  venueName: string | null; neighborhood: string | null; city: string;
  geo: { lat: number; lng: number } | null;   // coarsened when visibility=neighborhood
  addressVisibility: AddressVisibility;
  address: string | null;                      // present ONLY when visibility=public
}
export interface GigDoc {
  curatorProfileId: string; seriesId: string | null; detachedFromTemplate: boolean;
  title: string; description: string; wants: GigWants; budget: GigBudget;
  startsAt: number; durationMinutes: number;
  provisions: { hasPA: boolean | null; hasBackline: boolean | null; notes: string | null };
  location: GigPublicLocation;
  status: GigStatus; createdAt: number; updatedAt: number;
}
// gigs/{id}/private/location:
export interface GigPrivateLocation { address: string; geo: { lat: number; lng: number } | null; }
export interface GigSeriesDoc {
  curatorProfileId: string;
  recurrence: { weekday: number; hour: number; minute: number; cadence: SeriesCadence; endDate: number | null };
  fillMode: FillMode; template: Omit<GigDoc, "curatorProfileId"|"seriesId"|"detachedFromTemplate"|"status"|"startsAt"|"createdAt"|"updatedAt">;
  status: SeriesStatus; materializedThrough: number; createdAt: number; updatedAt: number;
}
export interface AdminNoteDoc { notes: { byUid: string; at: number; text: string }[]; }

export const MAX_OPEN_GIGS_PER_PROFILE = 50;
export const MAX_ACTIVE_SERIES_PER_PROFILE = 10;
export const MAX_PENDING_CURATOR_PROFILES = 1;
export const RESUBMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const SERIES_MATERIALIZE_WEEKS = 8;
```
Extend `AuditLogDoc["action"]` with `"gig_taken_down" | "account_flagged"`. Extend `NotificationDoc["kind"]` with `"gig_moderation"`.

**Steps:** (1) failing unit tests for the new validators, `validateLookingFor` (≥1 genre from GENRES, ≥1 actSize from ACT_SIZES, notes ≤500, runtime typeof guards per SP-sweep convention), `validateGigContent` (title 1-80, description ≤2000, wants via validateLookingFor's element rules, duration 15-720 min, provisions notes ≤500), `validateBudget` (ints, 0 ≤ min ≤ max ≤ 5_000_000 cents, structure in the three literals), `validateRecurrence` (weekday 0-6, hour/minute valid, cadence enum, endDate null or future-of-reference, validator takes a `now` param, no Date.now() inside shared code); include malformed-type cases (arrays, numbers, null). (2) RED. (3) Implement. (4) GREEN + typecheck. (5) Commit.

---

### Task 2: Firestore rules + indexes for gigs/series/adminNotes + booking widening

**Files:** Modify `firestore.rules`, `firestore.indexes.json`; Test `tests-rules/rules.test.ts` (extend).

**Interfaces, Produces:** the read boundaries every later task relies on. Clients never write any new collection.

Rules additions (exact):
```
    match /gigs/{gigId} {
      // Only callables write, and only approved curator profiles can post;
      // profile unpublish cascades close open gigs (review.ts), so a bare
      // status check is sufficient, no per-read profile get().
      // List queries MUST filter status == 'open' (unfiltered lists fail).
      allow read: if resource.data.status == 'open'
        || isMember(resource.data.curatorProfileId) || isAdmin();
      allow write: if false;
      match /private/location {
        allow read: if isMember(get(/databases/$(database)/documents/gigs/$(gigId)).data.curatorProfileId)
          || isAdmin();   // booked musician joins in sub-4
        allow write: if false;
      }
    }
    match /gigSeries/{seriesId} {
      allow read: if isMember(resource.data.curatorProfileId) || isAdmin();
      allow write: if false;
    }
    match /adminNotes/{uid} { allow read: if isAdmin(); allow write: if false; }
```
Booking widening, replace the `/private/booking` read rule with:
```
        allow read: if isMember(profileId) || isAdmin() || isApprovedCuratorMember();
```
where `isApprovedCuratorMember()` is a new helper: signed-in AND the caller belongs to ≥1 approved curator profile. Rules can't query, so implement via a **custom claim is wrong** and a **lookup doc is right**: maintain `curatorAccess/{uid}` marker docs (written by functions when a curator profile is approved/unpublished, for every member; membership changes on approved curator profiles keep it in sync) and check `exists(/databases/$(database)/documents/curatorAccess/$(request.auth.uid))`. Add `match /curatorAccess/{uid} { allow read: if isOwner(uid) || isAdmin(); allow write: if false; }`. (Maintenance logic is Task 6's cascade + Task 4's approval path; THIS task lands rules + seeded-doc tests.)

Indexes: `gigs` composite (curatorProfileId ASC, status ASC), (seriesId ASC, startsAt ASC), (status ASC, startsAt ASC), the open-gigs-by-date queries; `gigSeries` (curatorProfileId ASC, status ASC).

**Steps:** (1) failing rules tests: anon reads open gig ✓ / draft ✗ / taken_down ✗; unfiltered gigs list ✗, `status=='open'` list ✓; member reads own draft ✓; private/location member ✓ stranger ✗ admin ✓; series stranger ✗ member ✓; adminNotes non-admin ✗; booking read via seeded `curatorAccess/{uid}` ✓, without ✗, member-as-before ✓. (2) RED (3) rules (4) GREEN, suites stay green (5) note controller rules-audit (6) commit.

---

### Task 3: Geocode module

**Files:** Create `functions/src/geocode.ts`; Test `functions/test/geocode.test.ts` (unit-style, no emulator needed).

**Interfaces, Produces:**
```typescript
export interface GeocodeResult { lat: number; lng: number; neighborhood: string | null; city: string; }
export interface Geocoder { geocode(address: string): Promise<GeocodeResult | null>; } // null = not found
export function getGeocoder(): Geocoder;   // env-selected: stub unless GEOCODER_PROVIDER is set
export function coarsen(r: GeocodeResult): { lat: number; lng: number };  // neighborhood-centroid stand-in
```
- `StubGeocoder`: deterministic, hashes the address into a stable lat/lng inside a city bounding box, `city` parsed from the last comma segment, `neighborhood` from the second-to-last (null if absent). Good enough for tests and the emulator; documented as dev-only.
- `coarsen`: rounds lat/lng to 2 decimal places (~1.1 km cell), an honest neighborhood-level pin without needing polygon data; comment says a real centroid source can replace it later without schema change.
- Provider slot: a `GoogleGeocoder` class skeleton behind `GEOCODER_PROVIDER=google` + `GEOCODER_API_KEY` env config, implemented as a straightforward fetch to the Geocoding API, compiled and typed but NOT exercised by tests (no key in dev); README launch item covers configuring it.

**Steps:** failing unit tests (stub determinism, same address twice ⇒ identical result; city/neighborhood parsing; coarsen cell-rounding; getGeocoder returns stub without env) → RED → implement → GREEN → commit.

---

### Task 4: Curator profile content + submit gate + anti-spam

**Files:** Create `functions/src/curator.ts`; Modify `functions/src/profiles.ts` (gate, caps, cooldown, curator seeding), `functions/src/guards.ts` (consolidation + curator guards), `functions/src/members.ts` + `functions/src/index.ts` (guard imports/export); Test `functions/test/curator.test.ts`, extend `functions/test/profiles.test.ts`.

**Interfaces, Consumes:** Task 1 types/validators, Task 3 geocoder. **Produces:**
- `updateCuratorProfile(input: { profileId: string } & Partial<Pick<CuratorDetails,"about"|"lookingFor"|"amenities"|"advertisingInterest">> & { location?: { address: string | null; city: string } })`, member-gated (`requireProfileMember`), curator-type-gated (new `requireCuratorProfile(profileId)` guard mirroring `requireMusicianProfile`), validates via Task 1 validators, geocodes on location change (venues store full address; planners/hosts store city only, reject an `address` for non-venue subtypes), merges into `profiles/{id}.curator`, bumps `updatedAt`.
- `createProfileDraft` seeds `curator: CuratorDetails` (empty shape) for curator types, exactly as SP2 seeds `portfolio` for musicians.
- **Submit gate for curators** in `submitProfileForReview`: about non-empty, ≥1 photo in `curator.photoPaths`, location present (venues: non-null address), `validateLookingFor` passes. (Musician gate untouched.)
- **Anti-spam in `submitProfileForReview`:** at most `MAX_PENDING_CURATOR_PROFILES` curator profiles in `pending_review` per calling uid (collection-group members scan, same pattern as the draft cap) → `resource-exhausted`; resubmit within `RESUBMIT_COOLDOWN_MS` of the last rejection → `failed-precondition` mentioning "24 hours" (needs `lastRejectedAt` stamped by `reviewProfile`, add the field write there; applies to ALL profile types).
- **Guard consolidation (SP2 obligation):** `profiles.ts` and `members.ts` drop their local `requireAuth`/`requireVerifiedEmail` copies and import from `guards.ts` (`requireAuthUid`, `requireVerifiedEmail`); delete the guards.ts comment saying it's deferred.
- Photos: curator photo uploads reuse the SP2 photo pipeline unchanged (`processUpload` + storagePaths), confirm `media.ts` is profile-type-agnostic; if it hard-checks musician type, widen to any profile type with a one-line change (report it).

**Steps:** failing tests (update rejects non-member / non-curator / bad lookingFor / address-on-planner; gate blocks submit missing each requirement one at a time then passes complete; pending-cap fires; cooldown fires at +1h and clears at +25h, stamp `lastRejectedAt` via admin SDK in the test) → RED → implement → GREEN (full suite incl. musician-gate regression) → commit.

---

### Task 5: Gig CRUD callables

**Files:** Create `functions/src/gigs.ts`; Modify `functions/src/index.ts`, `functions/src/guards.ts` (add `requireApprovedCuratorProfile`); Test `functions/test/gigs.test.ts`.

**Interfaces, Consumes:** Tasks 1-4. **Produces (exact export names):**
- `createGig(input)` → `{ gigId }`: member of an APPROVED curator profile (new guard `requireApprovedCuratorProfile`, approved-status check on top of requireCuratorProfile); validates content/budget; resolves location: venue subtype defaults to the profile's stored address + `addressVisibility:"public"` unless input overrides; non-venue requires an address input, defaults `"neighborhood"`; geocodes; writes public GigDoc (`status:"draft"`, coarsened geo when neighborhood) + `private/location` (exact) in one batch.
- `publishGig({ gigId })`: member-gated via the gig's profile; draft→open; enforces `MAX_OPEN_GIGS_PER_PROFILE` (count query) → `resource-exhausted`.
- `updateGig(input)`: member-gated; same validation; re-geocodes on address change; sets `detachedFromTemplate: true` when the gig has a `seriesId`; recomputes public/private location split when visibility flips either way.
- `cancelGig({ gigId })`: member-gated; open|draft → cancelled.
- `takedownGig({ gigId, scope: "occurrence" | "series", reason })`: ADMIN-gated (`requireAdmin` from review.ts); occurrence → `taken_down`; series scope additionally pauses the series and takes down its other open occurrences; audit `gig_taken_down` (detail carries reason + scope); notifies the curator profile's members (`kind:"gig_moderation"`, body includes the reason).
**Ordering convention inside each callable:** requireAuthUid → requireVerifiedEmail → input validation → profile/authz guards → caps → writes (matches the SP-sweep uniform-cap precedent).

**Steps:** failing tests, create (venue defaults public+exact geo; planner requires address, gets coarsened public geo, exact private doc; non-member ✗; unapproved profile ✗; bad budget ✗), publish (draft→open; 50-cap seeded via admin SDK batch → resource-exhausted), update (visibility flip public→neighborhood re-coarsens and strips address; sets detached flag on series gigs), cancel, takedown (admin-only; series scope sweeps siblings + pauses; audit + notification asserted, SP2 takedown-integrity pattern) → RED → implement → GREEN → commit.

---

### Task 6: Series callables + curatorAccess maintenance + takedown cascade

**Files:** Create `functions/src/gigSeries.ts`; Modify `functions/src/review.ts` (cascade + curatorAccess + lastRejectedAt), `functions/src/members.ts` (curatorAccess on membership change), `functions/src/curator.ts` (add `syncCuratorAccess`), `functions/src/index.ts`; Test `functions/test/gigSeries.test.ts`, extend `functions/test/review.test.ts`.

**Interfaces, Produces:**
- `createSeries(input)` → `{ seriesId }`: approved-curator-member; validates recurrence + template (Task 1 validators); enforces `MAX_ACTIVE_SERIES_PER_PROFILE`; writes GigSeriesDoc (`status:"active"`, `materializedThrough: 0`, Task 7's job materializes on its next run; no occurrences created inline).
- `updateSeries(input)`: member-gated; template edits propagate, batch-update future occurrences (`startsAt > now`) where `detachedFromTemplate == false`; recurrence edits apply to occurrences not yet materialized only (comment explains).
- `pauseSeries` / `endSeries`: member-gated; end additionally cancels future occurrences still `open|draft`.
- **Cascade in `reviewProfile`** (reject-from-approved, extending the existing block): close (`closed`) all the profile's `open` gigs, pause its `active` series, batched, before the notification; audit detail notes the counts.
- **`curatorAccess/{uid}` maintenance:** on curator-profile approval → set marker for every member; on reject-from-approved → recompute each member's marker (delete unless they belong to another approved curator profile); `respondToInvite` accept + `removeMember` on approved curator profiles maintain the member's marker the same way. One shared helper `syncCuratorAccess(uid)` in `functions/src/curator.ts` (recomputes from a collection-group members query), call it from every touchpoint; also stamp `lastRejectedAt` on rejects (Task 4's cooldown input).

**Steps:** failing tests, create/caps/validation; update propagates to future non-detached occurrences only (seed occurrences via admin SDK); end cancels future opens; cascade test: approve profile → open gigs + active series seeded → reject-from-approved → gigs closed, series paused, curatorAccess markers recomputed (member of ONLY this profile loses marker; member also on another approved curator profile keeps it); invite-accept/removeMember marker sync → RED → implement → GREEN → commit.

---

### Task 7: Daily scheduled job

**Files:** Create `functions/src/scheduled.ts`; Modify `functions/src/index.ts`, `functions/package.json` if the scheduler import needs it; Test `functions/test/scheduled.test.ts`.

**Interfaces, Produces:** `runDailySweep(now: number): Promise<SweepReport>` (exported plain function; `SweepReport` counts per action) and `dailySweep = onSchedule({ schedule: "every day 09:00", region: "us-central1" }, () => runDailySweep(Date.now()))`.
1. **Materialize:** each `active` series → create occurrence gig docs (`status:"open"`, template content, computed `startsAt` per cadence from the series anchor, public/private location copied from template, template stores the resolved split) up to `now + SERIES_MATERIALIZE_WEEKS`, respecting `recurrence.endDate`; advance `materializedThrough`; idempotent via watermark (double-run creates nothing new).
2. **Past sweep:** `open` gigs with `startsAt < now` → `closed`.
3. **Track reaper (SP2 debt):** `processing` tracks older than 24h → `failed` with `failureReason: "Upload abandoned"` (frees the slot per SP2's ACTIVE_TRACK_STATUSES rule).
4. **Invite sweep (SP2 debt):** `pending` invites older than the 14-day expiry → `revoked`.

**Steps:** failing tests invoking `runDailySweep(fixedNow)` directly against emulator-seeded data, weekly series materializes exactly ⌈8w/cadence⌉ occurrences with correct startsAt sequence; biweekly/monthly cadence math; endDate respected; double-run idempotent; past-open closed; stale processing track failed; stale invite revoked; fresh ones untouched → RED → implement → GREEN → commit.

---

### Task 8: Admin backend, name search, flagAccount, resubmit visibility

**Files:** Create `functions/src/adminTools.ts`; Modify `functions/src/authTriggers.ts` (or add a users trigger), `functions/src/index.ts`, `firestore.indexes.json` if needed; Test `functions/test/adminTools.test.ts`.

**Interfaces, Produces:**
- `users/{uid}.displayNameLower`: written by `onUserCreated` and kept in sync by a new `onUserDocWritten` Firestore trigger (`onDocumentWritten("users/{uid}")`, syncs when displayName changed; guards against self-retrigger by no-op when already consistent). NOT client-writable (outside the update rule's hasOnly, already true).
- `searchUsersByName({ q })` → `{ results }`: admin-gated callable; lowercases q; prefix range query `where displayNameLower >= q && < q + ""` limit 10; returns uid/displayName/email.
- `backfillDisplayNameLower()`: admin-gated one-shot callable paging existing users (needed once on deploy; also used by tests).
- `flagAccount({ uid, text })`: admin-gated; appends `{ byUid, at, text }` (text 1-500) to `adminNotes/{uid}` (arrayUnion or transaction); audit `account_flagged`.
- `submitProfileForReview` stamps `resubmitCount` increment on the profile (Task 4 file if cleaner, implementer's call, note it) so the queue can render "resubmitted Nth time".

**Steps:** failing tests, trigger syncs on displayName update (poll); search prefix semantics incl. case-insensitivity + limit; non-admin denied on all three callables; flag appends + audit; backfill fills seeded legacy users → RED → implement → GREEN → commit.

---

## UI tasks (9-13), shared rules

The backend contracts above are the source of truth; the UI mirrors SP2's shipped components rather than inventing new patterns. For every screen: busy locks around every callable, explicit failure states, cancellation guards on async effects, keyed remounts for identity switches, no setState-in-effect literals, typed shared imports (no `as any`). **Mobile screens must run the SP2 plan's Tasks 13/14 DO-NOT-COPY checklists** (in `docs/superpowers/plans/2026-08-25-musician-portfolio.md`) before their task is complete. Client-side validation mirrors (never replaces) the server gates, using the same shared validators. Verification per task: typecheck + lint clean, plus a live-emulator walkthrough of the flows via dev server (web) / a temporary programmatic script exercising the same callables (mobile), described in the report.

### Task 9: Web, curator wizard + editor

**Files:** Extend `apps/web/app/join/**` (curator branch of the wizard) and `apps/web/app/dashboard/**` (curator editor, mirroring the musician portfolio editor's structure); reuse the SP2 photo-upload components as-is.
**Consumes:** `updateCuratorProfile`, `submitProfileForReview` (new gate errors), photo pipeline.
**Requirements:** wizard steps, basics (from foundation) → about → photos (≥1, pipeline states per SP2) → location (subtype-aware: venues get full address fields; planners/hosts city only) → **preferences (required: genres multi-select from GENRES, act sizes from ACT_SIZES, notes)** → amenities + advertising toggle → review/submit showing gate status per requirement (exact strings from server errors); editor = same sections, edit-in-place post-approval (live instantly). Cooldown and pending-cap server errors surface verbatim with a friendly wrapper.

### Task 10: Web, gig composer + series management

**Files:** New dashboard sections under `apps/web/app/dashboard/**` (gigs list + composer + series page).
**Consumes:** `createGig`, `publishGig`, `updateGig`, `cancelGig`, `createSeries`, `updateSeries`, `pauseSeries`, `endSeries`.
**Requirements:** composer with the one-off/series fork; budget input as min/max dollars converted to cents + structure select (labels: "per hour" / "per song" / "per set"); date/time + duration; provisions; location per subtype with the address-visibility toggle (copy explains the neighborhood default for non-venue); draft→publish flow with cap errors surfaced. Gigs list grouped: open / drafts / past+closed; series page lists occurrences (from a `seriesId` query), template edit form with a "applies to future, unedited dates" note, pause/end with confirm. Occurrence edit routes to the gig editor and flags detachment in copy.

### Task 11: Web, public curator page + open gigs

**Files:** Extend `apps/web/app/u/[handle]/**`, branch on profile type; curators get their own SSR layout (reuse the musician page's SSR/ISR/canonical machinery and photo rendering).
**Requirements:** photos, about, amenities, what-we're-looking-for (rendered from structured LookingFor), venue address+map-link line (venues only), **Open gigs** section, `gigs` query (curatorProfileId + status=="open", ordered startsAt) rendered with title/date/budget/wants/location AT ITS PUBLIC PRECISION (venueName+address when public, neighborhood+city otherwise); Upcoming Events section hidden-while-empty (sub-6 wires it); correct 404/SSR behavior for non-approved profiles (existing machinery).

### Task 12: Web, admin gig moderation + queue upgrades + name search

**Files:** Extend `apps/web/app/admin/**`.
**Consumes:** `takedownGig`, `flagAccount`, `searchUsersByName`, `reviewProfile` (unchanged API).
**Requirements:** new **Gigs** admin section, status filter, subtype filter DEFAULTING to non-venue, rows with title/curator/date/status and takedown (reason prompt, occurrence-vs-series choice for series gigs, busy state + error surfacing per SP2's hardened queue patterns). Curator queue rows render the new gate fields (preferences, photo count, location) + `resubmitCount` badge; reject flow gains an optional "flag account" checkbox+note calling `flagAccount` after the reject succeeds; adminNotes shown on the user-lookup results. User lookup upgraded to name search (`searchUsersByName`) with the email-exact path kept.

### Task 13: Mobile, curator wizard/editor + composer parity

**Files:** Extend `apps/mobile/app/(curator)/**` + `apps/mobile/src/**`, reusing SP2's mobile portfolio components (photo uploader, form patterns).
**Requirements:** curator wizard (same steps/gates as web), editor on the curator dashboard tab, gig composer + list + series management with mobile-appropriate pickers; the SP2 mobile checklists apply to every screen; public-address toggle copy matches web. Mobile lint stays green (SP2 got it green, keep it).

---

### Task 14: Cleanup, docs, sweep, gates

**Files:** Modify mobile account screens (dedup into one shared component, SP2 deferred item), `README.md`, `docs/superpowers/foundation-rulings.md` cross-refs if stale; verify indexes deployed-shape.
**Steps:**
1. Account-screen dedup: extract `apps/mobile/src/shell/AccountScreen.tsx`, three role screens become thin wrappers; typecheck + lint green.
2. README: gig/series commands & concepts blurb, geocoder env config (`GEOCODER_PROVIDER`, `GEOCODER_API_KEY`) as a launch item, scheduled-job note (deploy enables Cloud Scheduler, launch checklist), name-search backfill one-shot instruction, updated manual-follow-ups.
3. Full sweep: `pnpm typecheck` · shared tests · `pnpm emu:test` · `pnpm emu:rules` · both lints · web build, all green, outputs captured.
4. Controller gates: rules audit (any task that touched rules re-audited as a whole), full security review of the branch, final whole-branch review, per the established process.
5. Commit.

## Done means

All 14 tasks committed and review-gated; suites green (expect functions ≈130+, rules ≈50+, shared ≈55+); the SP2 obligations ledger fully settled (guards consolidated, reaper live, invite sweep live, booking read widened, name search live, account screens deduped); spec's §5 settlements all shipped; branch merged per finishing-a-development-branch after the final review.

