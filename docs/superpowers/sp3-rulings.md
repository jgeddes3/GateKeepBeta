# GateKeep Sub-project 3 (Curator Profiles & Gig Postings) — Rulings & Handoff

Durable record from sub-project 3, executed subagent-driven with two-stage reviews on
`worktree-curator-gigs`. Travels with the repo so any device/session can plan sub-project 4
without this machine's context. Mirrors `sp2-rulings.md`'s structure.

Spec: `docs/superpowers/specs/2026-08-26-curator-gigs-design.md`
Plan: `docs/superpowers/plans/2026-08-26-curator-gigs.md`
Ledger (full task-by-task detail this doc distills): `.superpowers/sdd/2026-08-26-curator-gigs/progress.md`
Prior sub-project's record: `docs/superpowers/sp2-rulings.md`

## Rulings made during execution

1. **Task 1 — strictly-future `endDate` validation stands**: a series `endDate <= now` is
   rejected at creation time. Cost if wrong: a curator can't set an end date of "today" — trivial.
2. **Task 2 — read-rule read-boundary ordering deferred, not a security gap**: between Task 2
   landing and Task 6's takedown cascade landing, the emulator-only dev environment has no live
   unpublish traffic, so the temporary ordering carried zero real cost. (Task 14 also reordered the
   three SP3 read rules to check free `isAdmin()` before billed `isMember(...)`/`get()` calls, per
   the file's established cost idiom — see `firestore.rules`.)
3. **`lastRejectedAt` live-stamp ownership moved from Task 6 to Task 4** (one-line `review.ts`
   addition, sanctioned in the Task 4 dispatch) — supersedes the pre-flight scan's Task 4↔Task 8
   gap ruling. Task 4's test asserts the live stamp directly.
4. **PLAN AMENDMENT — Task 4b inserted** (curator photo ingestion): `media.ts` branches for
   curator gallery photos (append to `curator.photoPaths`, cap `MAX_CURATOR_PHOTOS`=12),
   `storage.rules` gallery filename pattern (+ rules audit), `removeCuratorPhoto` callable. Cost if
   wrong: ~1 task of effort; without it curators could not onboard end-to-end.
5. **Task 5 — `cancelGig` stays membership-only** (no approval-profile gate), narrower exposure
   than `publishGig`/`updateGig`: cancelling is a strictly access-reducing action (an `open` gig
   becomes `cancelled`), so gating it on approval status only serves to block a legitimate member
   from taking a gig down, with no corresponding security benefit. `publishGig`/`updateGig` DO gate
   on approval (fix round 1: a rejected-profile member could otherwise edit/publish a live gig).
6. **Task 6 — series mutators accepted at membership-only scope**: verified in code that the
   status chain can't be abused to elevate privilege (series mutators can't flip a profile's
   approval status), the takedown cascade closes ALL open gigs on unpublish (not just some), and
   publish/update stay approval-gated per ruling 5's asymmetry.
7. **Task 7 REVIEW CHECKPOINT (load-bearing, re-verified through Task 7's own review)**: the daily
   sweep's materializer must serve `status == "active"` series ONLY — enforced structurally by the
   query filter itself (`gigSeries.where("status","==","active")`), not a post-filter, so a
   paused/ended series is never even fetched. The membership-only acceptance in ruling 6 depends on
   this holding.
8. **Task 7 — monthly cadence is `+28d` in v1**; true calendar-monthly recurrence (same day-of-month
   each month) is explicitly deferred — see sub-4 obligations below. The daily sweep's UTC anchor
   math (a series' `weekday`/`hour`/`minute`/`endDate` are interpreted in a fixed UTC anchor, not
   any local timezone) is a related, separately-tracked launch caveat — see README's "Sub-project 3
   launch checklist."
9. **Task 7 fix — clamp watermark to `max(watermark, now)`**: Task 7's initial materializer had a
   disprovable self-heal claim (a shared deferred-batch write path left a 24h world-readable window
   for past-dated occurrences under a specific race). Fixed via a shared `skipAheadTo` clamp,
   preserving the original watermark off-by-one behavior TDD had caught; new test pins `now >
   anchor`.
10. **Task 9 — sectioned editor accepted over literal wizard steps**: the curator editor mirrors
    SP2's musician editor structure (section-by-section save, gate-status summary) rather than a
    literal multi-step wizard walkthrough — reviewed and verified substance-complete against the
    plan's step list (every required gate still present, gate-failure strings character-identical
    to the server's).
11. **Task 11 — `LAUNCH_TIMEZONE` shared constant (single-metro v1)**: every rendered gig time
    (public curator page + dashboard gigs/series lists, web AND mobile) is pinned to one IANA zone
    (`@gatekeep/shared`'s `LAUNCH_TIMEZONE`, currently `"America/New_York"`) rather than each
    renderer's own clock, so a curator and a fan looking at the same gig always see the same wall
    time. Per-venue timezone support stays schema-deferred to sub-4 (see obligations below); the
    constant MUST be set to the real launch metro before launch (README launch checklist).
12. **Task 12 — two judgment calls accepted**: the admin "also flag this account" affordance
    applies at the account level to every queue row (not per-content-type), and prompt-gated flows
    (`window.prompt`/`confirm`) are verified via their resulting callable invocation rather than by
    mocking the browser dialog itself.
13. **Task 13 — FOUND + FIXED a pre-existing foundation-era bug**: the curator join flow was
    calling `createProfileDraft` then `submitProfileForReview` back-to-back, auto-submitting with
    no content — which would always fail sub-project 3's new curator content gate. Fixed in Task 13
    without regressing the musician join path (verified byte-level).
14. **Task 13 — chip-picker UX accepted as a dependency-scope constraint** (not a design
    preference): the mobile genre/act-size picker uses a simple chip-toggle UI rather than a richer
    multi-select component, because no such component exists in this dependency set yet.
15. **`adminNotes/{uid}` rules wildcard naming is CORRECT as `uid`** (SETTLED, was briefly flagged
    as a possible `profileId` mismatch during Task 2's review): plan Task 8's `flagAccount` keys
    `adminNotes/{uid}` by the USER's uid, not a profile id — Task 2's reviewer's `profileId` reading
    was the error, not the rule.
16. **Task 14 — `MAX_CAPACITY` included in the shared constants export (controller adjudication)**:
    the dispatch's item 3 named only the literal `MAX_*_LENGTH` constants ("MAX_ABOUT_LENGTH etc."),
    but `MAX_CAPACITY` is the identical duplicated-soft-cap pattern — a numeric bound re-declared
    verbatim in `functions/src/curator.ts`, `apps/web/src/curator/CuratorForms.tsx`, and
    `apps/mobile/src/curator/CuratorForms.tsx`, one line away from the others. Task review
    adjudicated including it: **accepted — strictly better than the literal `MAX_*_LENGTH` list**,
    since leaving it out would have left one soft cap still able to drift while the other four
    couldn't. `INDOOR_OUTDOOR_VALUES` (an enum, not a numeric cap) was deliberately left as a local
    per-file mirror — out of scope for the same reason `MAX_CAPACITY` was in scope: it isn't a
    "soft cap." Separately (noted here since it's adjacent context to this same export): the
    curator `MAX_ADDRESS_LENGTH` now in `@gatekeep/shared` (300) and `functions/src/gigs.ts`'s own
    module-private `MAX_ADDRESS_LENGTH` (300, mirrored in both `GigForms.tsx` clients) share a name
    and value by coincidence, not by a real shared invariant — a gig's location and a curator's
    profile location are different domains with independent validators, so the two constants were
    deliberately left un-unified rather than force-coupled just because they currently agree.
17. **Task 14 — processPhoto corrupt-upload hardening**: a pre-existing SP2 bug found live during
    Task 9's walkthrough — a corrupt/undecodable image buffer made `sharp(...).metadata()` (or the
    subsequent resize/encode) throw, escaping `processPhoto` unhandled instead of being discarded
    the way every OTHER rejection path in that function already is (disallowed format, non-member,
    wrong profile type, gallery cap reached — log + return, staging cleanup left to the shared
    `finally`). Fixed by wrapping the whole decode/resize/encode step in its own try/catch that
    follows the same discard-with-log pattern; there is no per-photo "failed" status doc the way
    `processAudio`'s tracks have one, so silent discard-with-log IS this pipeline's existing failure
    style, not a divergence from it.
18. **Task 14 — admin flag-checkbox hint over hard gating**: the "also flag this account" checkbox
    (Task 12) sits next to both Approve and Reject but only ever takes effect on Reject (silent-drop
    ambiguity flagged as a Task 12 minor). Task 14 chose an inline hint (`(Reject only)` label text
    + a `title` tooltip) over disabling/hiding the control outside a "reject flow," since the
    existing architecture has no persistent reject-flow UI state to gate against (the reject reason
    is captured synchronously via `window.prompt` on click, not a multi-step form) — hiding it would
    have required a more invasive state-machine change for a cosmetic ambiguity.

19. **Final pre-merge fix wave — pause is one-way in v1 (LOAD-BEARING ruling)**: nothing in this
    sub-project ever flips a `gigSeries` doc back from `"paused"` to `"active"` — not a curator
    action (`pauseSeries` exists; there is no `resumeSeries`), not an admin action, not the sweep.
    This is an undocumented spec deviation the final whole-branch review flagged as load-bearing, not
    cosmetic, because TWO other invariants quietly depend on it:
    - **Takedown durability** (`gigs.ts`'s `takedownGig`, scope `"series"`): pausing the series is
      how a series-scope takedown durably stops new occurrences from being materialized. If a
      curator (or anyone) could flip the series back to `"active"`, the very next daily sweep would
      resume materializing occurrences for a series an admin just took down — the takedown would
      silently un-happen within 24h.
    - **The materializer's active-only invariant** (ruling 7 / the Task 7 review checkpoint): the
      membership-only acceptance for series mutators (ruling 6) reasons that a series mutator "can't
      elevate a profile's approval status" — but it implicitly also relies on pause being a one-way,
      admin-and-curator-both-safe operation. A `resumeSeries` that a mere profile MEMBER (not admin)
      could call would reopen that reasoning: a member could un-pause a series an admin paused via
      `reviewProfile`'s reject-from-approved cascade or `takedownGig`, resurrecting content an admin
      moderation action specifically stopped.
    - **Sub-4 MUST, when it adds `resumeSeries` (or any status-reversing series action)**:
      (a) gate it on `requireApprovedCuratorProfile`, matching `updateSeries`'s P3 fix in this same
      wave — a rejected/unpublished profile's member must not be able to resurrect a series; AND
      (b) distinguish an ADMIN-initiated pause (via `takedownGig`'s series-scope cascade, or any
      future admin unpublish path) from a CURATOR-initiated pause (`pauseSeries`) — only the latter
      should ever be resumable by a plain member; an admin-paused series should require an admin (or
      a fresh review) to reactivate, or takedown durability silently regresses. The current schema
      has no field distinguishing WHO/WHY a series was paused (`gigSeries.status` is a bare enum) —
      sub-4 will need to add one (e.g. a `pausedBy: "curator" | "admin"` field, or a separate
      `takenDown: boolean` flag orthogonal to `status`) before `resumeSeries` can be implemented
      safely. Cost if a naive `resumeSeries` ships without this: takedown durability breaks silently
      (Critical-severity regression, not caught by any existing test since none exist for a feature
      that doesn't exist yet).

20. **Final pre-merge fix wave — materializer cap guard, and the ~130 composition bound it closes**:
    before this wave, the daily sweep's materializer (`scheduled.ts`) had NO cap check of its own —
    `createGig`/`publishGig` enforce `MAX_OPEN_GIGS_PER_PROFILE` (50) at request time, but the
    materializer is the OTHER writer of `"open"` gigs and could blow past that cap in a single run.
    Worst case: a profile with `MAX_OPEN_GIGS_PER_PROFILE` (50) manually-published one-off gigs PLUS
    `MAX_ACTIVE_SERIES_PER_PROFILE` (10) active weekly series, each materializing a full
    `SERIES_MATERIALIZE_WEEKS`-wide (8) window on its first run (8 occurrences each) — 50 + 10×8 =
    **130** open gigs for one profile in one sweep run, 2.6x the intended cap. Closed by a per-series
    precheck (skip + count in `SweepReport.seriesSkippedCapped` when the profile's open-gig count is
    already ≥ `MAX_OPEN_GIGS_PER_PROFILE` before materializing that series' occurrences) — a soft,
    non-transactional guard at the same established tier as `createGig`/`createSeries`'s own
    non-transactional `.count().get()` checks (see the Task 5 minor below), not a hard global
    enforcement: two series for the SAME profile processed in the same run can each independently
    read a below-cap count and both proceed, so the true worst case is narrowed but not eliminated
    to exactly 50. Accepted at that tier rather than a full transactional rewrite, consistent with
    every other cap in this sub-project.

21. **Final pre-merge fix wave — M-10 TOCTOU re-read before materializing**: the materializer's
    initial series scan (`where("status","==","active")`) is a snapshot at the START of the sweep
    run: a series can be paused (curator `pauseSeries`, or an admin `takedownGig` scope `"series"`)
    or ended in the window between that scan and the moment this specific series' occurrences are
    about to be written, especially now that steps are paginated and a run can span many series.
    Fixed by a second, per-series `status` re-read immediately before writing — cheap with per-step
    chunked writers (one extra `get()` per series that's actually about to be written, not per
    occurrence) — so a series paused mid-run is skipped (`SweepReport.seriesSkippedRace`) rather than
    gaining occurrences an admin/curator just tried to stop.

22. **Final pre-merge fix wave — geocoder budget + secret handling**: `GEOCODER_API_KEY` moved from a
    bare `process.env` read to a `defineSecret()`-backed param (`functions/src/geocode.ts`'s
    `geocoderApiKey`), declared via `secrets: [geocoderApiKey]` on every onCall that can trigger a
    geocode (`updateCuratorProfile`, `createGig`/`updateGig`, `createSeries`/`updateSeries`) — the
    modern v2 mechanism for Cloud Functions to actually fetch a production secret from Secret
    Manager and inject it at invocation time; a bare unmanaged env var never worked that way in
    production regardless of how `getGeocoder()` read it. A per-uid daily budget
    (`geocodeBudgets/{uid}`, 50/day, transactionally incremented, `resource-exhausted` on the
    ceiling) closes a reachable-from-unapproved-drafts abuse path the security gate flagged
    (I-2): every address-resolving onCall was previously an unlimited, free geocode oracle for any
    signed-in, email-verified caller with a draft profile — no approval, no rate limit. A
    same-input-skips-the-geocode optimization (`CuratorDetails.location.geocodedFrom` /
    `GigPrivateLocation.geocodedFrom`, both optional fields storing the exact last-geocoded query
    string) means re-saving unrelated fields alongside an unchanged location doesn't burn budget on
    a call that would just re-derive the same result.

23. **Final pre-merge fix wave — M-13 one-hop curator-access delegation: OPEN PRODUCT DECISION, not
    resolved by this wave.** `firestore.rules`'s `isApprovedCuratorMember()` (Task 2) grants ANY
    member — not just an admin — of ANY approved curator profile read access to `private/booking`
    on **every** musician profile platform-wide, the instant they accept a single `"member"`-role
    invite onto one approved venue/planner/host. This is a deliberate one-hop widening (Task 2's
    brief: curators "shopping for acts" need to see rates broadly, not just profiles they belong
    to), but the security gate flagged it as worth a second look at merge time: is "any member of any
    approved curator profile" the intended blast radius for platform-wide rate/preference visibility,
    or should this be narrower (e.g. curator-profile ADMINS only, or a scoped/audited lookup instead
    of a blanket rule)? **This needs a human product decision, not an engineering one** — surfaced
    explicitly at this handoff rather than adjudicated unilaterally. If tightened, the natural
    trigger point is sub-4 (M-12 below — booking has no real writers yet, so no live traffic depends
    on the current shape today).

24. **Final pre-merge fix wave — M-12 booking-read tightening deferred to sub-4**: related to ruling
    23 but narrower — `profiles/{id}/private/booking` currently has no real WRITERS in this
    sub-project (booking rates/preferences are sub-2 musician self-service data; nothing here
    creates booking relationships), so the widened read boundary (ruling 23) is exercised by no live
    product flow yet. Revisit whether/how to tighten `isApprovedCuratorMember()`'s scope once sub-4
    actually adds booking writers (offers, requests, confirmed bookings) and the read boundary starts
    mattering for real traffic instead of just being reachable in principle.

25. **Final pre-merge fix wave — sub-4 obligations addendum**: on top of the pre-existing sub-4
    obligations below, sub-4 must also: (a) be aware of `curatorAccessRetries/{uid}` (S4) when
    touching `curator.ts`/`review.ts`/`scheduled.ts` — any new code path that can cause a
    `syncCuratorAccess` call to fail should follow the same "record to curatorAccessRetries, let the
    sweep's 5th step retry" pattern rather than silently dropping the failure; (b) M-16 note: when
    next touching `review.ts`'s reject-from-approved cascade or `scheduled.ts`'s sweep steps, verify
    every in-file comment describing failure-handling behavior still matches the code — this wave
    found and corrected one stale "self-healing" claim (ruling text above / `review.ts`) that had
    silently gone false as the surrounding code evolved; nothing suggests another exists today, but
    it's the kind of drift that isn't caught by tests.

## Obligations sub-project 4 MUST pick up (recorded commitments)

- **`resumeSeries` MUST be approval-gated + admin-pause-aware (LOAD-BEARING — see ruling 19)** —
  pause is one-way in v1: no `resumeSeries` exists anywhere in this sub-project. When sub-4 adds one,
  it MUST (a) call `requireApprovedCuratorProfile` (matching `updateSeries`'s P3 fix), and (b)
  distinguish an admin-initiated pause (`takedownGig` scope `"series"`, or any future admin
  unpublish path) from a curator-initiated one (`pauseSeries`) — only the latter should be
  resumable by a plain member. The schema has no such distinction today (`gigSeries.status` is a
  bare enum); sub-4 needs to add one (e.g. `pausedBy: "curator" | "admin"`) before `resumeSeries`
  can ship safely. Getting this wrong silently breaks takedown durability.
- **`curatorAccessRetries/{uid}` awareness** — any new code path that can cause a `syncCuratorAccess`
  call to fail (S4) should record the uid to `curatorAccessRetries/{uid}` (write:false in rules) so
  the daily sweep's retry step picks it up, rather than silently dropping the failure the way
  `review.ts`'s reject-from-approved cascade used to (fixed this wave).
- **M-13 one-hop curator-access delegation — OPEN PRODUCT DECISION (ruling 23)**: confirm with
  product whether "any member of any approved curator profile can read every musician's private
  booking rates/preferences platform-wide" (the current `isApprovedCuratorMember()` shape) is the
  intended scope, or whether it should narrow to curator-profile ADMINS or a scoped/audited lookup —
  before sub-4 builds real booking flows on top of the current wide-open read boundary.
- **M-12 booking-read tightening** (ruling 24) — `private/booking` has no real writers yet; revisit
  the read boundary (ruling 23) once sub-4 adds them and it starts mattering for live traffic.
- **Geocoder budget + secret note** — `GEOCODER_API_KEY` is a `defineSecret()` param now (ruling 22);
  any NEW onCall sub-4 adds that can trigger a geocode must declare `secrets: [geocoderApiKey]`
  (`functions/src/geocode.ts`) or it will silently fail to resolve the key in production. Any new
  address-resolving write path should also call `consumeGeocodeBudget(uid)` before geocoding.
- **Widen `gigs/{id}/private/location` read access to the booked musician** — currently
  member/admin-only (see `firestore.rules`'s comment: "booked musician joins in sub-4"). Booking
  doesn't exist yet as a concept in this sub-project.
- **Wire the `filled` gig status** — `GIG_STATUSES` and the gig lifecycle don't yet have a status
  representing "booked/filled" distinct from `open`/`closed`/`cancelled`/`taken_down`; sub-4's
  booking flow needs to both introduce and consume it.
- **Consume `fillMode`** (`"per_occurrence" | "whole_run"` on `GigSeriesDoc`) — the field is
  written today but nothing reads it yet; a series' fill semantics (book each occurrence
  independently vs. book the whole run at once) are sub-4's to implement.
- **Invite-UI client surface** — `functions/src/scheduled.ts`'s daily sweep now revokes expired
  `pending` invites server-side, but there's still no dedicated client UI for the invite lifecycle
  beyond what sub-1 shipped; revisit once booking invites (if any) need a real surface.
- **Per-venue timezone schema refinement** — `LAUNCH_TIMEZONE` (ruling 11) is a deliberate v1
  single-metro simplification. A real multi-metro launch needs per-venue (or per-curator-profile)
  timezone data and gig-time rendering that uses it instead of one hardcoded IANA zone.
- **Calendar-monthly recurrence** — ruling 8's `+28d` monthly cadence is not true
  same-day-of-month recurrence; implement the calendar-correct version if/when curators need it.
- **Name-search UX iteration** — `searchUsersByName` (Task 8) is a working prefix-match callable
  (case-insensitive, limit 10) with a plain admin-UI text input consuming it; there's room for
  debounce, pagination past 10, and a zero-results empty state (Task 8's minor: "zero-results
  search test" was never added — worth adding alongside any UX pass). Two further Task 8 minors,
  not UX but worth the same triage pass: `backfillDisplayNameLower` uses `batch.update`, which
  throws if a legacy user doc is ever deleted mid-backfill — a `set({...}, {merge:true})` would be
  more resilient to that race; and the backfill's actual Firestore write path has no test isolating
  it from the rest of the callable (today it's only exercised end-to-end via the "converges legacy
  users" test).
- **`processPhoto` 3-read optimization** — every avatar/cover/gallery upload currently does 3
  separate profile reads (membership check, profile-type check, and — for avatar/cover — the
  previous-photo-path read before overwrite). Acceptable today (human-triggered, low volume); worth
  collapsing if upload volume grows.
- **Task 3/5/6/7 deferred minors worth carrying forward** (none block anything today, listed for
  triage if ever touched):
  - Task 3: `StubGeocoder`'s deterministic hash bounds its fake lat/lng to a US-centric bounding box
    (25–50°N, 66–125°W) — fine for dev/test (never used once `GEOCODER_PROVIDER=google` is set for
    a real deploy, see README) but worth documenting loudly if the stub is ever reused outside dev.
    Separately, `parseGoogleResponse` throws when it can't extract a city from
    `address_components` — real Google Geocoding responses for plus-codes and some other
    city-less results hit this; noted as a real-traffic hardening item (return a partial result or
    a typed "no city" error instead of throwing) rather than something dev/test traffic would ever
    surface.
  - Task 4b: the one-line path-prefix assertion in `removeCuratorPhoto` — deferred at Task 4b's
    close as "fold into Task 6's `curator.ts` touch" — **landed as planned**, in Task 6 (commit
    `efde194`; see the "Defense-in-depth path-prefix assertion" comment in
    `functions/src/curator.ts`). Recorded here only to close the loop — nothing outstanding.
  - Task 5: non-transactional cap reads on gig/series creation (established tier — `tracks.ts` has
    the stricter transactional precedent if ever needed); an empty `location: {}` patch is a
    no-op rewrite rather than a rejected/ignored input; the Google-provider geocoder's null-branch
    (no results) is untested (pre-existing gap, not new to sub-3).
  - Task 6: the approve-path `curatorAccess` marker recompute batches writes unchunked (the
    500-write Firestore batch ceiling is unlikely to be hit at current scale);
    `syncCuratorAccess` reads member profiles sequentially rather than in parallel;
    `updateGig`/`updateSeries` duplicate their address-visibility-resolution logic (self-flagged
    extraction candidate if a third caller ever needs the same logic).
  - Task 7: series chunk-rotation past 400 materialized occurrences in one run is untested
    (defensive-only code path); `endDate` exact-boundary-alignment semantics (does an occurrence
    landing exactly ON `endDate` get created?) are unpinned by a test; the reaper and invite sweeps
    both fetch-all-then-filter rather than querying narrowly (fine at v1 scale, revisit if the
    `tracks`/`invites` collections grow large).
- **Status-palette duplication** (Task 12 minor, "third-consumer rule" — deferred until an actual
  third consumer exists): the admin gigs/queue rows and profile-review rows each define their own
  small status→color mapping; not worth extracting until a third UI needs the same mapping.

## Environment (fresh clone, any machine)

Same base environment as sub-project 2 (see `sp2-rulings.md`), plus:

- `GEOCODER_PROVIDER` / `GEOCODER_API_KEY` — unset in dev (falls back to the deterministic
  `StubGeocoder`); set both for a real deploy. See README's Environment variables table.
- `LAUNCH_TIMEZONE` (`@gatekeep/shared`) — code constant, not an env var; must be edited to the
  real launch metro's IANA zone before a production deploy (README launch checklist).
- The daily scheduled job (`dailySweep`) has no emulator equivalent — its logic
  (`runDailySweep(now)`) is exercised directly by functions tests with an injected clock; it only
  runs on a real timer once `firebase deploy` provisions the underlying Cloud Scheduler job in
  production.
- Test suites, final counts after Task 14's cleanup (all green): `pnpm typecheck` (5/5
  workspaces), shared `pnpm --filter @gatekeep/shared test` (88/88, unchanged), `pnpm emu:test`
  (functions, 256/256 — 255 baseline + 1 new corrupt-photo-upload test), `pnpm emu:rules` (rules
  45/45 — 43 baseline + 2 new tests + storage 14/14, unchanged), both lints (0 errors, pre-existing
  warnings only), web build, mobile `npx expo export --platform ios`. Full evidence in Task 14's
  report (`.superpowers/sdd/2026-08-26-curator-gigs/task-14-report.md`).

## Post-gate follow-ups (from the fix-wave re-review — file with sub-4)

- Sweep step 5 (curatorAccess retries): add a per-doc try/catch inside the drain loop — a
  deterministically-failing uid at a fixed queue position would otherwise starve every uid after it
  indefinitely (the step-level catch only bounds it per-run today).
- `gigs.ts` updateGig neighborhood→public branch: `.data() as GigPrivateLocation` lacks
  `| undefined` — a fully missing private/location subdoc would raw-TypeError instead of the
  intended internal HttpsError (unreachable today; every writer creates the subdoc).
- `removeMember`: add `isValidDocId` guards on profileId/uid (P2's hardening pattern) and
  `requireVerifiedEmail` (only sibling mutator without it).
- S4 test gap: add a case removing a member from an already-REJECTED curator profile holding a
  stale marker — current tests would not fail if the old status=="approved" recompute gate were
  restored.
- `deleteProfile`: move the handles/{handle} delete AFTER the (now potentially long) gig/series
  cascade — a mid-cascade failure currently frees the handle while the profile doc still carries
  it (idempotent retry recovers; low impact, draft/rejected only).
- Invite-accept fast path (`members.ts`): decides the curatorAccess set from a profile snapshot
  read before the membership transaction — a ~100ms race with reject-from-approved can set a
  stale-TRUE marker (self-healing via S4's unconditional recompute on later removal; harden by
  re-reading status post-transaction or calling syncCuratorAccess instead).
- `syncCuratorAccess`: unbounded sequential N+1 over a uid's memberships — cap/paginate if
  membership counts grow.
