# GateKeep, Sub-project 1: Foundation, Design Spec

**Date:** 2026-08-24
**Status:** Approved design, pending user review of this document
**Scope:** Accounts, profiles, auth, app shell, admin dashboard v1, notification plumbing

---

## 1. Product context (applies to all sub-projects)

GateKeep is a three-sided platform launching in a single metro area:

- **Musicians** (solo acts and bands) host their music on our platform in sleek portfolio profiles they are proud to share, with preferences and payment structures.
- **Event curators** (venues, wedding/event planners, individual hosts) post gigs and browse talent.
- **Fans** buy tickets, discover events, and follow artists.

Matching runs both directions: curators post gigs musicians apply to, and curators browse/invite musicians directly. Booking and ticketing both work at launch. Gig planning happens in-app via musician ↔ curator messaging (fans do not get messaging).

**Revenue (v1):** service charge on ticket sales and on booking fees. Later: advertising, featured-placement subscriptions.

**Success criteria for first release:** real bookings from the founding partner's lined-up musicians and curators, plus real fan ticket purchases.

### Sub-project build order

1. **Foundation** (this spec), auth, accounts/profiles, app shell, admin v1, notification plumbing
2. Musician portfolio, profiles, audio upload/hosting/streaming, preferences, payment structures
3. Curator profiles & gig postings
4. Matching & booking (including musician ↔ curator messaging)
5. Payments, Stripe Connect (booking payouts + platform cut; reused by ticketing)
6. Events & ticketing, public event pages, ticket sales, QR tickets
7. Fan discovery, search, follow artists, performance notifications

Later phases (no v1 spec): advertising, subscriptions, two-step verification, sign-in method linking.

---

## 2. Architecture & repository

**Stack decision (approved):** Expo mobile app + Next.js web app + shared Firebase backend, in one monorepo.

```
GateKeepBeta/
├── apps/
│   ├── mobile/     # Expo, iOS + Android
│   └── web/        # Next.js, public pages, fan web, curator dashboard, /admin
├── packages/
│   └── shared/     # TypeScript types, data models, validation, used by both apps + functions
├── functions/      # Firebase Cloud Functions
└── firebase config + Firestore security rules at root
```

- Apps deploy independently: EAS (mobile), Vercel or Firebase Hosting (web).
- Firebase provides Auth, Firestore, Storage, Cloud Functions, App Check, and push messaging.
- Firestore instance: create new at build time (Enterprise edition per current Firebase defaults; confirm edition and location during implementation).
- Rationale for the split (vs. one Expo universal app): best-in-class web for SEO-relevant public pages (`@handle` profiles, event pages) and big-screen curator/admin dashboards, accepted cost of a second UI codebase.

---

## 3. Data model (Firestore)

### `users/{uid}`
One document per signed-in person, created at signup. Display name, photo, email, home city, createdAt. Every user is a fan by default; tickets attach here in sub-project 6. No role field, roles derive from profile membership. Email is never publicly readable.

### `profiles/{profileId}`
One document per musician act or curator organization.

| Field | Values |
|---|---|
| `type` | `musician` \| `curator` |
| `subtype` | musician: `solo` \| `band`; curator: `venue` \| `planner` \| `individual_host` |
| `name` | display name |
| `handle` | unique, server-enforced; powers public URLs (`gatekeep.app/@handle`) |
| `status` | `draft` → `pending_review` → `approved` \| `rejected` (with reason) |

Only `approved` profiles are publicly visible and bookable. Portfolio content, venue details, preferences, and payment structures are defined in sub-projects 2–3.

### `profiles/{profileId}/members/{uid}`
Links accounts to profiles: `role` (`admin` | `member`), `label` (e.g. "drummer", "venue manager"), joinedAt. One person may belong to many profiles (solo act + band + curator org). "All my profiles" = collection-group query on `members`. Every profile must have ≥ 1 admin at all times.

**Membership changes go through Cloud Functions only** (see §7): invites are offers the invited user must accept; no client-side member writes.

### Admin (team) access
Firebase Auth custom claim `admin: true`, set server-side only. First admins seeded at deploy; thereafter only existing admins can grant the claim. Approval queue = `profiles where status == pending_review`.

---

## 4. Auth & onboarding

- **Sign-in methods:** email/password, Google, or Apple, user picks exactly one; no linking of multiple methods to one account in v1. If they attempt another method later, the app tells them which method they signed up with.
- Email signups require verification email; standard password reset included.
- **After signup:** `users/{uid}` doc auto-created; user lands directly in the fan experience. Buying tickets never requires approval.
- **Becoming a musician/curator:** account menu → "Join as a musician/curator" → creates `draft` profile → guided required-info flow (full wizards are sub-projects 2–3; foundation builds draft → submit mechanics) → submit sets `pending_review` → team approves (notify, go live) or rejects (show reason, allow revise + resubmit).
- **Sessions:** Firebase persistent sessions on mobile and web. Sign-out in account menu.
- **Account deletion:** in-app self-service deletion (App Store requirement). Deletes auth account + `users` doc; personal data removed. If the user is sole admin of a profile, they must first transfer admin or delete the profile; the flow enforces this.

---

## 5. App shell & navigation

**Context switcher pattern** (Instagram/Facebook-pages style): everyone starts in the fan view; the avatar menu lists "Me (fan)" plus every profile they belong to; selecting one swaps the entire navigation into that context.

**Mobile (Expo) tabs per context:**

| Context | Tabs |
|---|---|
| Fan | Home/Discover · Tickets · Search · Account |
| Musician profile | Dashboard · Gigs · Portfolio · Messages · Account |
| Curator profile | Dashboard · My Events · Find Talent · Messages · Account |

Messages tabs are confirmed scope (musician ↔ curator, built in sub-project 4); foundation ships them as inert placeholders.

**Web (Next.js):**
- Public, no login: landing page, `@handle` profile pages, event pages (SEO surface)
- Logged-in fan: discover/tickets parity with mobile
- `/dashboard`: musician/curator workspace with the same context switcher
- `/admin`: team-only (admin claim required); invisible otherwise

**Foundation deliverable:** running app on iOS, Android, and web, sign-in, profile creation → pending → approval loop, context switching, notifications inbox, with placeholder content in feature tabs.

---

## 6. Admin dashboard (v1)

Web-only at `/admin`, gated by admin claim.

- **Approvals queue:** pending profiles with submitted info; Approve / Reject-with-reason.
  Review checklist includes an explicit impersonation check ("is this really them?").
- **User lookup:** find account by email/name; see profiles and statuses.
- **Audit log:** every approve/reject/claim-grant recorded (actor, action, target, timestamp).
- **Grows per sub-project:** content moderation (2), gig/event oversight (3–6), payment/refund tooling (5–6), stats when there is data.

---

## 7. Notifications (plumbing)

- Push permission prompts, device token registration (tokens stored per-user, writable only by owner), and an in-app notifications inbox, built in foundation.
- Delivery: Expo push (mobile) + web push/FCM (web).
- Triggers ship with their features: approval results (this sub-project), booking requests (4), ticket confirmations (6), artist announcements (7).

---

## 8. Security & threat model

**Stance:** default-deny Firestore rules; allow narrowly.

| Threat | Mitigation |
|---|---|
| Privilege escalation via memberships | Membership changes only via Cloud Functions; invites require invitee acceptance; only profile admins initiate |
| Approval bypass | `status` transitions only via Cloud Functions; clients can never write `approved` |
| Admin claim escalation | Claim set server-side; only admins grant; first admins seeded at deploy; all grants audit-logged |
| Impersonation / handle squatting | Server-enforced handle uniqueness; reserved-handles list (admin, gatekeep, well-known artist names); impersonation check in approval checklist |
| Bots / direct API scraping | Firebase App Check on all clients from day one |
| Data exposure | `users` docs readable only by owner; drafts/pending profiles visible only to members + admins; emails never public |
| Account takeover (no 2FA in v1) | Accepted risk for users; admin accounts must use Google sign-in (inherits Google 2FA); 2FA planned post-v1 |
| Notification token theft | Tokens writable only by their owner |

**Process gates (every sub-project):** `security-review` skill on the branch before merge; `firebase-security-rules-auditor` skill on any security-rules change before deploy.

---

## 9. Error handling & testing

- **Errors:** Firestore offline caching on mobile; human-friendly auth errors; global crash reporting (Sentry or Crashlytics, pick at implementation).
- **Testing:** security rules tested against the Firebase emulator; `packages/shared` validation unit-tested once, reused everywhere; auth + profile-lifecycle integration tests on the emulator.

---

## 10. Out of scope for foundation

Portfolio/venue content and wizards (2–3), matching/booking/messaging (4), payments (5), events/ticketing (6), fan discovery (7), advertising, subscriptions, 2FA, SMS anything, sign-in method linking, moderation tooling beyond approvals.
