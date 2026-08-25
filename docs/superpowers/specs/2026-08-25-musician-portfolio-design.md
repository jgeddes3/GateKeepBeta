# GateKeep — Sub-project 2: Musician Portfolio — Design Spec

Approved 2026-08-25. Builds on `2026-08-24-foundation-design.md` (product context, architecture, and sub-project order live there). Foundation rulings: `docs/superpowers/foundation-rulings.md`.

---

## 1. Scope

**In:** musician portfolio content (bio, photos, genres, external links, shows section), audio snippet upload/hosting/streaming, gig preferences, payment structures, the full musician onboarding wizard, portfolio editor on **both** mobile and web, server-rendered public portfolio pages with `@handle` vanity URLs, per-track admin review, rejected-profile revise+resubmit UI, and mobile lint green.

**Out (explicitly):**

- Admin/internal foundation-deferred items (admin name search, orphaned-invite cleanup, `deleteProfile` status restriction, mobile account-screen dedup, `requireAuth` consolidation). **Ruling: these MUST be explicitly reviewed at sub-project 3 planning — do not let them rot.**
- EAS production build + native App Check client code. Blocked on external accounts (Apple/Google/EAS) that don't exist yet. Joins the same must-review list; supersedes the README note that native App Check lands in sub-project 2.
- Video hosting (YouTube links cover it), messaging, booking, payments, events (sub-projects 4–6).

## 2. Portfolio content model

An approved musician profile carries:

- **Bio** — ≤2000 chars.
- **Photos** — avatar + cover photo.
- **Genres** — 1–3 from a fixed shared list.
- **External links** — typed (`spotify | youtube | instagram | website`), ≤8, URL-validated per type against domain allowlists (e.g. spotify links must be `open.spotify.com`).
- **Tracks** — up to **10 audio snippets, ≤30 seconds each** (see §3).
- **Shows** — **platform events only, never manually entered.** SP2 ships the section's data contract (query: past/future events for a `profileId`) and UI; it renders empty and stays hidden until sub-projects 4/6 create real bookings/events.
- **Booking info** (curator-gated, see §4–5): rates + preferences.

## 3. Audio: snippets, pipeline, review

**Product rules:** portfolios hold *snapshots*, not catalogs — max 10 tracks, 30s each. The musician uploads a full track and **picks the 30-second window with a scrubber** (the hook matters; first-30s auto-trim was rejected). Originals are never retained. **Every track is admin-reviewed before going live** — the team screens for AI-generated music. This is a human policy judgment, not a system verification; the system's job is the gate, queue, and audit trail.

**Pipeline (server-side, approved approach):**

1. Client (either app): pick local file (`mp3/wav/m4a/flac`, ≤50MB), local playback, drag 30s window.
2. `createTrack` callable: validates profile membership, verified email, 10-track cap (transactional, counting non-rejected docs), size/type, title → creates track doc `status: processing`, returns staging path.
3. Client uploads the original to `uploads/{uid}/{trackId}` (owner-write-only staging; 24h lifecycle auto-delete).
4. Storage `onObjectFinalized` trigger runs ffmpeg (`ffmpeg-static`, v2 function, memory-tuned): trims the window, transcodes to 128kbps AAC `.m4a`, writes clip to `review/{profileId}/{trackId}.m4a`, **deletes the original**, sets doc `pending_review` + measured `durationSec`. On error: `failed` + reason; musician retries.
5. Admin reviews the exact transcoded clip: `reviewTrack` approve/reject (reason ≤500 chars), audit-logged like `reviewProfile`, musician notified via existing plumbing.
6. Approve → clip copied to `portfolios/{profileId}/tracks/{trackId}.m4a` (public-read); reject → clip deleted, doc keeps reason.

**Invariant:** the public Storage path only ever contains approved clips. Playback is plain HTTPS via HTML5 `<audio>` (web) / `expo-av` (mobile) — no custom streaming.

**Photos** use a mini-pipeline (staging → sharp resize + EXIF strip → public path) with **no review gate**.

## 4. Preferences & payment structures

**Preferences** (feed sub-4 matching; designed extensible — new fields must not require migration): gig types (weddings, bars/clubs, festivals, private events, …), travel radius from home city, act size (solo/duo/band), typical set length, brings-own-PA, general availability pattern (weekends/weeknights/…).

**Payment structures — binding for sub-projects 4 & 5:** a musician declares any combination of three optional rate structures:

- **Per hour** — extra time played bills at the rate.
- **Per song** — pay scales with songs requested (e.g. curated wedding playlists).
- **Per set** — flat rate for a defined set.

Each is `{amountCents, note?}`. Curators see all offered structures; the **booking flow (sub-4) picks one**, and **settlement math (sub-5) implements overtime/song-count per structure**. SP2 only declares and displays.

**Visibility:** rates (and preferences) are visible to **signed-in curators only** — never public, never fan-visible. Curator profiles arrive in sub-3, so SP2 ships the gate (profile members + admins can read; sub-3 widens to members of approved curator profiles) and in practice only admins see rates until then.

## 5. Data model

All shapes defined in `@gatekeep/shared`; no local redefinitions.

- **`profiles/{profileId}`** — gains `portfolio` map: `bio`, `coverPhotoPath`, `genres[]`, `externalLinks[]`. Public-readable for approved profiles (as today).
- **`profiles/{profileId}/tracks/{trackId}`** — `title`, `durationSec` (≤30), `storagePath`, `status: processing → pending_review → approved | rejected | failed`, `rejectionReason?`, `order`, timestamps. Public `get`/`list` only when profile approved **and** track approved; members read own at any status; **writes via Functions only**.
- **`profiles/{profileId}/private/booking`** — single subdoc: `rates {perHour?, perSong?, perSet?}`, `preferences {gigTypes[], travelRadiusKm, actSize, typicalSetMinutes, bringsOwnPA, availabilityPattern}`. Read: profile members + admins (sub-3 adds approved curators). No client writes.
- **Storage** — `uploads/{uid}/…` (staging), `review/…` (pending clips, no client access), `portfolios/{profileId}/…` (serving, public read, Functions/admin-SDK write only).

## 6. Client surfaces

- **Wizard (both apps):** identity → bio + photos → first track upload/trim → optional rates/preferences → submit. Resumable. Submit locked until minimum content: **bio, avatar photo, ≥1 track** (plus foundation's identity fields). Track review can happen in the same admin pass as profile review.
- **Editor (both apps):** Portfolio tab edits everything post-approval. **Edits go live instantly except tracks** (per-track review); admins can retroactively unpublish anything. Track manager shows per-track status chips (processing / in review / live / rejected+reason / failed+retry) with reorder/retitle/delete.
- **Public page:** Next.js `/u/[handle]` becomes **server-rendered** (SEO + OG meta). **Layout: hero-first on mobile, EPK split (identity card left, content right) on desktop.** `@handle` vanity rewrite lands; `/u/[handle]` redirects to it. Mobile app renders hero-first natively. Shows section hidden while empty.
- **Rejected-profile resubmit (both apps):** show reason, revise via wizard, resubmit (server complete since foundation).
- **Admin (web):** review queue gains a **Tracks** tab — inline player, artist context, approve/reject with reason. Existing audit + impersonation-checklist patterns apply.

## 7. Functions & security

**New callables:** `createTrack`, `updateTrack`, `deleteTrack`, `reviewTrack` (admin), `updatePortfolio`, `updateBookingInfo`, photo-upload finalization. All follow foundation conventions (App Check-ready options, email-verified for mutations, shared validation). `submitProfileForReview` gains the minimum-content check. `deleteProfile` cascade-deletes track Storage objects.

**Rules:** Firestore rules extend the default-deny posture with the tracks visibility matrix and `private/booking` access above (get/list split maintained). **New Storage rules file** — staging owner-write with type/size limits and no reads; `portfolios/**` public read only; `review/**` no client access; plus the 24h staging lifecycle rule.

**Invariants:** originals never persist past transcode · public Storage path ⊆ approved content · track cap enforced transactionally · rates never publicly readable · every review action audit-logged.

**Process gates:** security review of the branch pre-merge; independent rules audit of **both** rules files.

## 8. Testing & definition of done

- Shared validation unit tests (rates, links, genres, caps).
- Functions emulator tests: every new callable + the transcode trigger with a real small audio fixture (assert clip duration/format, original deleted, status transitions).
- Rules tests: tracks visibility matrix, booking-subdoc access, Storage rules.
- Manual E2E on device + web: wizard → upload/trim → admin review → public page plays clip → reject → resubmit.

**Done means:** all tasks committed; typecheck + lint green everywhere (**including mobile — clears the 2 pre-existing lint errors**); all suites green; E2E verified on mobile + web against emulators; security gates passed; public page renders correct server-side meta tags.
