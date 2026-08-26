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
16. **Task 14 — processPhoto corrupt-upload hardening**: a pre-existing SP2 bug found live during
    Task 9's walkthrough — a corrupt/undecodable image buffer made `sharp(...).metadata()` (or the
    subsequent resize/encode) throw, escaping `processPhoto` unhandled instead of being discarded
    the way every OTHER rejection path in that function already is (disallowed format, non-member,
    wrong profile type, gallery cap reached — log + return, staging cleanup left to the shared
    `finally`). Fixed by wrapping the whole decode/resize/encode step in its own try/catch that
    follows the same discard-with-log pattern; there is no per-photo "failed" status doc the way
    `processAudio`'s tracks have one, so silent discard-with-log IS this pipeline's existing failure
    style, not a divergence from it.
17. **Task 14 — admin flag-checkbox hint over hard gating**: the "also flag this account" checkbox
    (Task 12) sits next to both Approve and Reject but only ever takes effect on Reject (silent-drop
    ambiguity flagged as a Task 12 minor). Task 14 chose an inline hint (`(Reject only)` label text
    + a `title` tooltip) over disabling/hiding the control outside a "reject flow," since the
    existing architecture has no persistent reject-flow UI state to gate against (the reject reason
    is captured synchronously via `window.prompt` on click, not a multi-step form) — hiding it would
    have required a more invasive state-machine change for a cosmetic ambiguity.

## Obligations sub-project 4 MUST pick up (recorded commitments)

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
  search test" was never added — worth adding alongside any UX pass).
- **`processPhoto` 3-read optimization** — every avatar/cover/gallery upload currently does 3
  separate profile reads (membership check, profile-type check, and — for avatar/cover — the
  previous-photo-path read before overwrite). Acceptable today (human-triggered, low volume); worth
  collapsing if upload volume grows.
- **Task 5/6/7 deferred minors worth carrying forward** (none block anything today, listed for
  triage if ever touched):
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
