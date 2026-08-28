# Sub-project 9A: Web UI/UX Redesign (design spec)

Date: 2026-08-28. Owner-driven design cycle: every visual decision below was picked by the owner
from rendered alternatives (visual companion session, `.superpowers/brainstorm/`). 9B (mobile app)
follows this spec's design language in a separate sub-project.

## 0. Charter and hard rules

- **UI only.** Markup, styling, copy, and purely presentational components change. Every callable,
  query, data shape, security rule, and behavior stays byte-identical. Two additive exceptions,
  both UI-over-existing-data: the viewer-aware past-shows page (section 6.5) and placeholder
  legal pages (section 6.9).
- **The antislop skills are binding** (`~/.claude/skills/antislop`, `antislop-ui`,
  `antislop-copywriting`): load the core + UI skill for every implementation task, the copywriting
  skill for every copy task. The owner's 30-item "vibecoded" blocklist applies on top. Highlights
  that bite here: no em dashes anywhere (copy, comments, docs), no lucide icons, no
  Inter/Geist/Space Grotesk, no glassmorphism-by-default, no bento grids, no three-feature-card
  rows, no fake testimonials or invented numbers, no sparkle icons or decorative arrows, no
  hover-everything. Required presences: real product screenshots, skeleton loaders, Terms of
  Service and Privacy Policy pages, honest empty/loading/error states that name the cause and
  the next action.
- **Accessibility floor**: WCAG AA contrast in both themes, full keyboard operability, visible
  focus states, reduced-motion respected.

## 1. Stack

- **Tailwind CSS v4** on apps/web.
- **shadcn/ui** components copied into the repo (CLI, not a dependency) and themed to this spec.
  Never ship a shadcn default look.
- **Design tokens** as CSS variables in `globals.css`, dark and light sets, mirrored in a
  `DESIGN.md` at repo root that future tasks (and 9B) read.
- **Fonts via next/font** (self-hosted at build): Syne (headings/brand, 600 to 800) and Sora
  (body, 400 to 600).
- **Phosphor icons** (`@phosphor-icons/react`), ONE weight product-wide: duotone. If duotone
  reads too busy at small sizes during the foundation task, fall back to regular; either way a
  single weight everywhere, chosen once.
- **Motion** (`motion` package) for choreographed transitions only. Motion dial: low. Hover
  states and deliberate moments (sheet/dialog entrances, the hero carousel, the mini-player
  reveal). No endless loops, no scroll-triggered animation stacking.

## 2. Design language: Ember, Deeper Night

Owner-picked from rendered alternatives; the plum is a deliberate choice, kept over the
"purple and black" caution.

### Dark (default)

- Background: gradient `#0E0B13 -> #150F20 -> #1D1229` (165deg), applied at the page level;
  sections never restack their own gradients (harsh-gradient rule).
- Surface (cards, panels): solid `#1A1424`, border `#2C2438`. Cards are SOLID elevated surfaces.
  Glass/backdrop-blur is capped at two uses product-wide: the landing nav over hero photos, and
  the sticky mini-player. Nowhere else.
- Text: `#F5F1F8` primary; muted at 62% opacity.
- Accent: ember `#FF6B4A`, foreground-on-accent `#2A0F0A`. Dosage: the accent belongs to the
  primary action and money/brand moments (brand mark, primary CTA, price, active nav item,
  status-badge tint). Never on borders, body links, icons, and backgrounds simultaneously.
- Status tints: success `#7BC48A`, warning `#E8B15C`, destructive `#E5484D`, each with dark
  foregrounds and 14% background tints, AA-checked.

### Light ("before doors open")

- Background: warm paper `#FAF7F2` (flat, no gradient). Surface: `#FFFFFF`, border `#E4DDD2`.
- Text: plum ink `#1C1524`. Accent: the same ember `#FF6B4A` (foreground `#2A0F0A`).
- Same status roles re-derived for AA on light.
- Toggle: three-state (system default, light, dark) in the account menu; dark is the brand
  default for signed-out marketing pages.

### Shape, elevation, motion

- Radius tiers, deliberate: 999px pills ONLY for primary CTAs and chips; 10px for cards and
  inputs; 6px for small controls and badges. Nothing else is rounded "because default".
- Elevation: borders do the separating; shadows are reserved for overlays (dialogs, popovers,
  mini-player). No floating-everything.
- Signature token: `--gk-scrim`, the bottom-up night gradient used over photography
  (hero, gig cards, cover heroes). It is the one recurring visual fingerprint.

## 3. App shell (owner pick: slim top bar)

One shell for all signed-in pages: slim top bar with the Syne brand mark left (ember), nav row
center-left (Dashboard, Gigs, Bookings, Earnings, Messages as roles warrant), and the context
switcher right (a compact control showing the active identity, e.g. "Mara (musician)", opening
the fan/musician/curator profile switcher). Active nav item is ember. Signed-out pages use the
landing variant (brand + Sign in). Mobile web collapses the nav row into a bottom-sheet menu.

## 4. Core components

- **Gig card (photo-forward, owner-locked in full)**: venue photo top with `--gk-scrim`, status
  badge ON the photo (ember-tinted pill: "Open for applications", "Filled", "Weekly" on series),
  Syne title, muted venue + neighborhood line, up to 2 small genre chips, date/time muted left,
  price in ember right ("$600 / set" from the budget structure). Whole card clickable; hover
  warms the border and lightens the scrim slightly. No lift, no zoom.
- **Musician card**: same skeleton adapted. Artist photo + scrim, Syne name, genre and act-size
  chips, availability line. NEVER a price (rates are private by SP4 rule). A reliability line
  (e.g. "12 shows played") replaces price for curator viewers where the data is readable.
- **Date-block row** (schedule contexts: artist Shows, series dates, future calendar work):
  46px date chip (ember month, Syne day numeral) + title + muted venue/time line + right-aligned
  detail. Owner has earmarked this pattern for all schedule views.
- **Buttons**: primary = ember pill; secondary = outlined ghost; destructive = status red.
  Arrows on buttons only when direction genuinely helps (one per page, max).
- **Forms**: shadcn inputs on solid surfaces, 10px radius, ember focus ring, inline validation
  with named causes.
- **Badges**: 6px radius tints, always carrying real state, never decorative.
- **Mini-player**: slim bottom-stuck bar (one of the two glass uses) with track, artist,
  play/pause, progress. Appears when audio starts anywhere.
- **Skeleton loaders**: every async surface gets a content-shaped skeleton, not a spinner.
- **Empty/error states**: named cause + one action, in a playful night-life voice (e.g. "No
  gigs on the books. The night is young: browse open gigs."). antislop-copywriting governs;
  no emoji, no em dashes.

## 5. Landing page (the advertising page)

1. **Hero carousel (owner-locked)**: full-bleed concert photos, auto-advance LEFT roughly every
   15s (slow slide with soft cross-dim; pauses on hover/reduced-motion), night scrim treatment
   (photos keep true color; dark gradient rises from the bottom and melts into the page), copy
   bottom-left: Syne headline "Find the music. Book the night.", one-line sub, dual CTAs
   ("I'm a musician" ember pill, "I book talent" ghost). Slim glass nav on top (glass use 1 of 2).
   Progress dots bottom-center. Photos: owner-supplied folder, 2560x1440 (16:9, min 1920x1080),
   subject in the middle 60%, JPG, compressed at build. Logged-in visitors are redirected to
   their dashboard (existing behavior, unchanged).
2. **Two audiences, told separately**: one full-width musician story, one curator story,
   alternating alignment, each with a REAL screenshot of the redesigned app.
3. **How it actually works**: the true four-step flow (browse or get found, negotiate, play,
   money settles automatically). Numbered plainly, no icon-circle template.
4. **The money, stated plainly**: real fees (11% curator booking fee, 2% musician commission,
   35% escrowed deposit) as transparency prose, not pricing tiers.
5. **One city, every stage**: the launch-metro story. No testimonials/logo bars until real ones
   exist.
6. **Closing CTA + footer**: role-split signup, footer with Terms, Privacy, contact. Footer is
   sized to the links that actually exist.

## 6. Page-by-page scope (everything user-facing + admin)

1. **Auth (sign-in/sign-up)** and **Join wizard**: shell variant, solid-card forms, provider
   buttons restyled.
2. **Dashboards** (fan / musician / curator): built around each screen's real decisions (the
   antislop app rule), using the locked cards. No stat-card rows with invented numbers.
3. **Browse**: Find gigs (photo-forward grid + filters) and Find musicians (musician cards).
   Venue-defined filterable chips are sub-8; only existing filters get restyled.
4. **Artist page (owner-locked anatomy)**: full-bleed cover hero + small avatar beside the Syne
   name + genre/act-size chips; instant-play button (plays first track, reveals mini-player);
   "Offer a gig" ember CTA; then bio, Shows (fixed-height scrollable date-block box, each row
   linking to its gig page), tracks player, external links, closing Offer-a-gig CTA.
5. **Past-shows page (new, viewer-aware)**: linked from the artist page Shows box. Public
   viewers: the full past-shows list (date, venue, gig title) from public gig data. Curator
   viewers: adds the reliability summary they can already read. The musician's own members:
   adds per-show private stats (earned, duration, true-ups) from their booking data. No new
   backend; three render depths over existing readable data, permission-denied tolerant.
6. **Venue (curator public) page (owner-locked)**: Airbnb-style collage header from the gallery
   (anchor photo + grid) with an "Open gallery" bubble button opening the full gallery; Syne
   name + venue chips; B-style facts card (capacity, PA, backline, indoor/outdoor, address);
   about, open gigs as photo-forward cards, location. CTA: "See open gigs (N)".
7. **Booking surfaces**: inbox (list rows), thread as CHAT-STYLE conversation (offers/counters
   as message bubbles with structured money-term cards inline), payments panel, cancel/report
   dialogs, gate prompts, all restyled on the same components.
8. **Payments/earnings**: earnings page, payout controls, save-card and pay-past-due flows,
   delinquency banner, all restyled; Stripe Elements themed to the tokens.
9. **Legal pages (new)**: /terms and /privacy with clearly-labeled placeholder legal text and a
   "have a lawyer review before launch" README note. Footer links them.
10. **Admin dashboard (owner call: full polish)**: review queue, user lookup, audit log, alerts,
    designed around the reviewer's actual decisions.
11. **Fan surfaces**: fan home/search/tickets tabs get the shell and styled "coming soon" states
    where features are future sub-projects (honest copy, no dead controls).

## 7. Out of scope

Map view of gigs (sub-8, geo data already present), ticket UI (sub-6), venue filter chips
(sub-8), the mobile app (9B), any backend/rules/functions change, real legal text.

## 8. Verification

Existing gates unchanged and green (typecheck, shared tests, emu suites untouched by definition,
web lint + build). Per-task visual review: implementers capture screenshots of changed pages
(dark AND light) for the task reviewer. The antislop UI checklist runs as part of each task
review. Manual pass at 360px, 768px, 1280px, 1920px widths.

## 9. Assets

Owner supplies the hero photo folder (2560x1440 JPG). Until it arrives, the carousel ships
behind a config listing local `/public/hero/*` files with any count from 1 (static) to N.
