# GateKeep Sub-project 2 (Musician Portfolio), Rulings & Handoff

Durable record from sub-project 2, executed subagent-driven with two-stage reviews and merged to
`main` on 2026-08-26 (merge `8a4b0d3`). Travels with the repo so any device/session can plan
sub-project 3 without this machine's context.

Spec: `docs/superpowers/specs/2026-08-25-musician-portfolio-design.md`
Plan (as-built, snippets synced to shipped code): `docs/superpowers/plans/2026-08-25-musician-portfolio.md`
Foundation record: `docs/superpowers/foundation-rulings.md`

## Rulings made during execution

1. **Track gate semantics are two distinct sets**, `ACTIVE_TRACK_STATUSES` (processing/pending/approved)
   is slot-occupancy for the 10-track cap; `LISTENABLE_TRACK_STATUSES` (pending/approved) is the
   submit-gate's "actually uploaded" set. A `processing` doc can be an abandoned upload and never
   satisfies the gate. Both are commented at their definition sites.
2. **Submit minimum content** (server + both clients mirror it exactly): bio, ≥1 genre, avatar
   photo, ≥1 listenable track. Genres were added to spec §6's list to match (ruling: spec updated,
   not the gate).
3. **Content takedown is a deliberate two-step**: `reviewProfile` reject-from-approved (or the
   admin "Unpublish profile" button) instantly removes discovery (page 404s, rules hide profile +
   tracks); it deliberately does NOT scrub `public/` objects because the same path is the routine
   revise-and-resubmit flow. Full scrub for abuse = follow with `deleteProfile` (unblocked once
   rejected). Documented in README + `functions/src/review.ts`.
4. **`deleteProfile` is server-gated to draft/rejected**, closes the co-admin
   delete-live-profile + instant handle-takeover hole found in the security audit. README's
   earlier "conscious ruling" wording now reflects reality.
5. **Title edits on approved tracks stay instant** (spec §6 "edits live instantly"), balanced by
   `reviewTrack` supporting retroactive reject of approved tracks (which DOES delete the public
   object, unlike profile unpublish, a track takedown is always a takedown).
6. **Mobile-only 25 MB audio cap** (`MOBILE_MAX_AUDIO_BYTES`), `fetch().blob()` materializes the
   file in memory; server cap stays 50 MB. Follow-up recorded: expo-file-system `uploadAsync`
   native streaming, then lift.
7. **`uploaderUid` is world-readable on approved tracks**, accepted, consistent with member-doc
   visibility on approved profiles. Any field the pipeline writes to an approved track becomes
   public (no field projection in rules).
8. **`processing`-track slots + `staging/` cleanup rely on two not-yet-built backstops**, the
   24h GCS lifecycle rule on `staging/` (LAUNCH BLOCKER, emulator can't test it) and a scheduled
   reaper for abandoned `processing` tracks. Both in README's manual follow-ups.
9. **Emulator quirk on Windows dev machines**: `FUNCTIONS_DISCOVERY_TIMEOUT=60` is required or
   callables 404 (native deps slow the discovery `require()`). Documented in README
   troubleshooting.
10. **Plan-doc convention**: every quality-review fix pass is folded back into the plan's task
    snippets byte-for-byte ("Final code" / "Quality-review hardening" notes). The plan is the
    as-built record, not the original sketch.

## Obligations sub-project 3 MUST pick up (recorded commitments)

- **Explicitly review the deferred admin/internal list** (user directive, recorded in SP2 spec §1
  "Out"): admin name search, orphaned-invite cleanup, `deleteProfile` status-restriction product
  confirmation, mobile account-screen dedup, `requireAuth`/`requireVerifiedEmail` consolidation
  (three local copies exist, see `functions/src/guards.ts`'s comment). Plus the EAS production
  build + native App Check launch-prep track (blocked on external accounts).
  **RESOLVED (SP3), except the launch track:** every deferred item is annotated resolved in `foundation-rulings.md` (SP3, SP2, and SP10 spec 5.6 for the orphaned invites); the EAS production build and native App Check remain owner-owed (HANDOFF table rows 3, 4, 8).
- **Widen `profiles/{id}/private/booking` read access** to members of approved curator profiles
  (spec §4/§5, the rules comment in `firestore.rules` marks the spot). Until then only profile
  members + admins can read rates.
  **SUPERSEDED (SP4 Task 2):** SP3 widened the read, then SP4 removed the blanket disjunct and replaced it with the server-built `profiles/{id}/private/curatorBooking` projection (`firestore.rules`, `functions/src/bookingVisibility.ts`); see the M-12/M-13 annotations in `sp3-rulings.md`.
- **Curator profiles get the wizard/portfolio treatment**, reuse the SP2 component/guard
  patterns; the mobile DO-NOT-COPY checklists in plan Tasks 13/14 apply to any new screens.
  **RESOLVED (SP3):** `functions/src/curator.ts`, `apps/web/src/curator/CuratorForms.tsx`, `apps/mobile/src/curator/`.
- **If profile suspension (as distinct from reject) is ever added**: it must sweep the `public/`
  prefixes the way `deleteProfile` does, or approved objects survive world-readable by path
  (rules-audit note).

## Binding contracts for later sub-projects

- **Sub-4 (booking)**: musicians declare up to three rate structures, per-hour / per-song /
  per-set, any combination (`BookingRates` in `@gatekeep/shared`); the booking flow picks one.
- **Sub-5 (payments)**: settlement math per structure (overtime for hourly, song-count for
  per-song).
- **Sub-4/6 (events)**: the public portfolio's Shows section renders ONLY platform
  events/bookings (never manual entries), the section is shipped hidden-while-empty on both
  public pages; wire real data to it.
- **Web launch checklist additions from SP2**: set `NEXT_PUBLIC_SITE_URL` (canonical/OG base),
  swap `PUBLIC_PROFILE_HOST` in mobile portfolio.tsx, plus everything under README's "Manual
  follow-ups" and "Sub-project 2 polish follow-ups".

## Environment (fresh clone, any machine)

`pnpm install` → `pnpm --filter @gatekeep/web exec next typegen` → Java 11+ on PATH for
emulators → `FUNCTIONS_DISCOVERY_TIMEOUT=60` if callables 404. Windows without admin rights:
`corepack enable --install-directory "$env:LOCALAPPDATA\Microsoft\WindowsApps"`. Full detail in
README Prerequisites/Troubleshooting. Test suites: `pnpm typecheck`, shared `pnpm --filter
@gatekeep/shared test` (44), `pnpm emu:test` (104), `pnpm emu:rules` (39), both lints, web build.
