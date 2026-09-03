# GateKeep Firebase rules and index audit

Date: 2026-09-01. Scope: `firestore.rules` (362 lines), `storage.rules`, `firestore.indexes.json`,
the four suites under `tests-rules/`, and `packages/shared/src/types.ts` as the field authority,
cross-referenced against every `where`/`orderBy`/`collectionGroup` call in `apps/web`,
`apps/mobile`, `functions/src`, and `scripts`. Read-only: no repo file was modified.

Method: the `firebase-security-rules-auditor` red-team checklist (update bypass, authority source,
business logic vs rules, storage abuse, type safety, field-level vs identity-level) plus the
`firebase-firestore` standard-edition rules and index references. The repo's rules are
Standard-edition syntax (`match` blocks, `resource.data`), so the standard references apply;
`firestore:databases:list` was not run (network call, not needed for a file audit).

One framing fact that shapes several findings: `apps/web/src/lib/firebase-server.ts` does SSR
with the anonymous client SDK, not the Admin SDK. Every public page read (artist page, curator
page, event page, Shows section) must therefore be provable for a signed-out caller, and every
world-readable field is reachable by anyone holding the (public) web API key.

---

## A. Score and per-collection matrix

### Auditor rubric result

```json
{
  "score": 4,
  "summary": "Default-deny, server-only writes, strict ownership on the three client-writable surfaces, and status-pinned public reads that are list-provable for the anonymous SSR path. No unauthorized access to private data, no privilege escalation, and no update bypass were found. Deductions are for over-broad world-readable fields on gig and event docs (pay ranges, ops stamps, sales counts), a push-token rule that cannot be deleted by its owner (a shared-device notification leak the mobile app cannot fix while the rule stands), missing type checks on two owner-writable fields, and a field-override in firestore.indexes.json that likely removes a single-field index a money path still queries (an emulator-invisible launch risk).",
  "findings": "see section B; the highest severities are F1 (High, index), F2/F3/F4 (Medium)"
}
```

Score note: the rubric's level 3 is for PII exposure such as public emails. No email, phone,
address-beyond-design, Stripe secret, QR secret, moderation note, or reliability record is
readable outside its intended audience. Level 4 fits: minor type gaps, size caps missing on a
few owner-writable values, and over-permissive reads on fields that are sensitive to the
business rather than to a person.

### Roles used below

- Anon: signed-out (includes the SSR server).
- Fan: signed in, member of no profile, no curatorAccess marker.
- M: member of the profile in question (musician or curator side, as the row says).
- CA: signed-in holder of `curatorAccess/{uid}` (member of at least one approved curator profile).
- Admin: `admin` custom claim.
- Server: Cloud Functions via Admin SDK (bypasses rules; the only writer for everything not listed as client-writable).

### Matrix

| Match block | Lines | get | list | create / update / delete (client) | Verdict |
|---|---|---|---|---|---|
| `users/{uid}` | 22-41 | owner, Admin | Admin only (owner cannot list; `isOwner(uid)` is unprovable over a collection) | update by owner limited to `displayName`, `photoUrl`, `homeCity` with type and size checks; no create/delete | Correct. See F7 (displayName can be removed or emptied). |
| `users/{uid}/notifications/{id}` | 43-48 | owner | owner | update by owner, `read` only; no create/delete | Correct. See F8 (`read` untyped). |
| `users/{uid}/pushTokens/{tokenId}` | 49-58 | owner | owner | create/update by owner with token-id regex and `createdAt`-only payload; delete effectively denied (`request.resource` is null on delete, so `.data.keys()` throws) | Defective for the product: see F3. |
| `profiles/{id}` | 61-63 | world if `status == approved`; else M, Admin | same, list must pin `status` (or `curatorProfileId`-style member pin does not exist here; a member cannot list "my profiles" from this collection, the members collection-group serves that) | none | Correct. See F12 (advertisingInterest world-readable). |
| `profiles/{id}/members/{uid}` | 65-77 plus wildcard 337-339 | Admin, M, self, and anyone if the profile is approved | M, Admin; plus a self-filtered list via the wildcard rule | none | Mostly correct. The world-get disjunct is a uid-to-profile oracle no surface needs: F6. |
| `profiles/{id}/tracks/{trackId}` | 79-88 plus wildcard 343-345 | Admin, M, world if profile approved and track approved | same; list must pin `status == approved`; collectionGroup admin only | none | Correct. `uploaderUid` world-readable is an accepted sp2 ruling. |
| `profiles/{id}/private/booking` | 90-98 | M, Admin | n/a (single doc) | none | Correct. |
| `profiles/{id}/private/stripe` | 100-105 | M, Admin | n/a | none | Correct. |
| `profiles/{id}/private/curatorBooking` | 107-128 | Admin, M, CA (any signed-in curator member reads any profile's projection) | n/a | none | Correct by SP4 ruling; anon short-circuits before `exists()`. |
| `profiles/{id}/private/reliability` | 130-136 | M, Admin | n/a | none | Correct. |
| `gigs/{id}` | 140-168 | world if `open`, `filled`, or `closed` with `bookedMusicianProfileId != null`; curator M; Admin | same, list must pin status (or `curatorProfileId` for a member; Admin unfiltered) | none | Access shape correct; field breadth is the issue: F2. |
| `gigs/{id}/private/location` | 169-180 | Admin, curator M, booked musician M | n/a | none | Correct; the three `get()`s hit one cached doc. |
| `gigSeries/{id}` | 182-189 | curator M, Admin | same, member must pin `curatorProfileId` | none | Correct. |
| `bookings/{id}` | 192-206 | either side M, Admin | same, must pin `curatorProfileId` or `musicianProfileId` | none | Correct. |
| `bookings/{id}/payments/{gigId}` | 209-223 | Admin, either side M (via parent get) | per-booking list provable; collectionGroup denied to everyone incl. Admin | none | Correct. |
| `stripeEvents`, `ledger`, `adminAlerts`, `adminNotes`, `auditLogs` | 225, 226, 235, 237, 359 | Admin | Admin | none | Correct. |
| `stripeFake/**`, `geocodeBudgets`, `curatorAccessRetries` | 229, 242, 247 | nobody | nobody | none | Correct. |
| `curatorAccess/{uid}` | 238 | owner, Admin | Admin | none | Correct (presence marker; no oracle for strangers). |
| `events/{id}` | 254-260 | world if `published` or `completed`; curator M; Admin | same, must pin status or `curatorProfileId` | none | Access shape correct; see F10 (ops stamps public) and F16 (ticket holders lose a cancelled event). |
| `events/{id}/tiers/{tierId}` | 262-269 | same audience as parent, via `get()` | same (parent get pins to the path) | none | Correct; `isAdmin()` is last (F14). `soldCount` public (F10). |
| `events/{id}/private/address` | 271-286 | Admin, curator M, signed-in holder of `users/{me}/ticketIndex/{eventId}` | n/a | none | Correct. |
| `events/{id}/attendees/{ticketId}` | 288-294 | curator M, Admin | same | none | Correct; attendee cannot read the roster. `isAdmin()` last (F14). |
| `orders/{id}` | 297-304 | buyer, curator M, Admin (signed-in only) | buyer must pin `buyerUid == me`; curator must pin `curatorProfileId` | none | Correct. Curator sees `paymentIntentId` (F11). |
| `users/{uid}/tickets/{ticketId}` | 306-309 | owner only (Admin denied, deliberate) | owner | none | Correct; `qrSecret` stays owner-only. |
| `users/{uid}/ticketIndex/{eventId}` | 315-318 | owner only | owner | none | Correct. |
| `transfers/{id}` | 320-327 | `fromUid`, `toUid`, Admin | party must pin own uid | none | Correct. See F13 (sender-side email oracle). |
| `invites/{id}` | 347-352 | `invitedUid`, `invitedByUid` | invitee/inviter must pin own uid | none | No Admin read (F15). |
| `handles/{handle}` | 358 | world | denied | none | Correct by design; the get is an existence oracle for unpublished handles (F17, accepted). |
| `{document=**}` | 360 | nobody | nobody | none | Correct. |

Cross-cutting checks from the rubric, all clean:

- Update bypass: the only client updates are `users` (three whitelisted keys, typed and sized), `notifications` (`read` only), and `pushTokens` (doc id regex, one key). No create path exists that an update could later corrupt into a privileged state; no role, ownerId, status, or money field is client-writable anywhere.
- Authority source: identity comes from `request.auth.uid` and the `admin` claim; membership from server-written `profiles/{id}/members/{uid}` docs; curator shopping access from the server-maintained `curatorAccess/{uid}` marker; ticket possession from the server-maintained `ticketIndex`. No rule trusts a client-supplied `uid`, `role`, or `ownerUid`.
- Storage abuse: sized on `users`; unbounded on `notifications.read` (F8) and `pushTokens.createdAt` and token-id length (F9).
- Type safety: present on `users`; missing on `notifications.read` and `pushTokens.createdAt`.
- Identity vs field level: every `hasOnly` is paired with `isOwner(uid)` on the path. Clean.
- Admin bootstrap: single custom claim, granted by `scripts/seed-admin.ts` / the admin-grant callable; rules never let a client set it. Clean.

---

## B. Findings

Severity: Critical / High / Medium / Low. Category: security | leak | provability | dos | test-gap | index.
Owner: fix-now | SP7 | SP8 | launch-checklist.

### F1. `tickets.orderId` field override likely drops the single-field index a money path queries

- Severity: High. Category: index. Owner: fix-now.
- Evidence: `firestore.indexes.json:225-226` (override lists only `COLLECTION_GROUP ASCENDING`); `functions/src/ticketing.ts:864-865` runs `db.collection('users/{uid}/tickets').where('orderId','==',...)` (collection scope) inside the refund convergence transaction; `functions/src/ticketing.ts:422` runs the collection-group form.
- Defect: a `fieldOverrides` entry replaces Firestore's automatic single-field indexes for that field with exactly the entries listed, so `orderId` on `tickets` retains a collection-group index only, and a collection-scoped equality on it is not guaranteed to be served (the console's own export of a field with a collection-group index lists the two `COLLECTION` orders alongside it, which is the shape `tracks.status` at lines 227-231 already uses).
- Failure scenario: a curator grace-refunds a ticket that has since been transferred. The Stripe refund succeeds, then the descendant lookup at line 865 throws `FAILED_PRECONDITION: The query requires an index`; the callable raises `ticket_refund_convergence_failed` and rethrows. Money has moved, the live descendant ticket is still `valid`, and the emulator never showed it because it does not enforce indexes.
- Fix: in the `tickets`/`orderId` override add `{ "queryScope": "COLLECTION", "order": "ASCENDING" }` and the `DESCENDING` twin; do the same for `members`/`uid` (no collection-scoped query exists on it today, but the symmetry costs nothing and the rules tests do issue one). Deploy indexes, then confirm in the console that the single-field entries show for both fields. Add a README launch-checklist line naming these two fields.

### F2. Full `GigDoc` is world-readable, including pay ranges and booking history

- Severity: Medium. Category: leak. Owner: SP7 (decision needed before fan-facing gig or show surfaces expand).
- Evidence: `firestore.rules:165-167`; `GigDoc` in `packages/shared/src/types.ts` (`budget.minCents/maxCents/structure`, `wants`, `provisions.notes`, `description`, `seriesId`, `detachedFromTemplate`, `bookingId`, `bookedMusicianProfileId`, `location.address` when `addressVisibility == public`).
- Defect: the read rule gates by status only, so every field of an open, filled, or closed-and-booked gig is readable by a signed-out caller, and list queries on `status == 'open'`, `status == 'filled'`, and `status == 'closed'` + `bookedMusicianProfileId > ''` are provable platform-wide with no `curatorProfileId` pin.
- Exploit: three unauthenticated queries dump every venue's posted budget range, what each venue paid for in the past (closed-and-booked), which act took each slot, and each venue's private provisions notes. That is the curators' negotiating position and the musicians' booking history, exposed to competitors and to scrapers before SP7 even ships a fan surface. The SSR Shows section already reads these full docs for fans.
- Fix options, in order of preference: (a) split the gig into a public projection (title, startsAt, durationMinutes, public location, curatorProfileId, bookedMusicianProfileId, status) and a `gigs/{id}/private/terms` doc (budget, wants, provisions, description) readable by `signedIn()` musicians (or a `musicianAccess/{uid}` marker mirroring `curatorAccess`), curator members, and Admin; the anonymous SSR pages need only the projection. (b) If the owner rules that budget ranges are public by design, record it in the SP7 rulings doc and drop `provisions.notes` and `description` from what a `closed` gig exposes (they have no fan purpose once the show happened). Either way, keep `open`-gig browsing for musicians behind `signedIn()` if the SSR curator page's open-gigs section can move client-side.

### F3. Push token docs can never be deleted by their owner; the mobile app never unregisters on sign-out

- Severity: Medium. Category: security (privacy). Owner: fix-now (rule change plus mobile sign-out).
- Evidence: `firestore.rules:55-57` (`allow write` with `request.resource.data.keys()`); `apps/mobile/src/notifications/push.ts:16` (`setDoc` on sign-in, no delete anywhere); `apps/mobile/src/shell/AccountScreen.tsx:25` (`signOutUser` without token cleanup); `functions/src/notifications.ts:11-14` (fans out to the first 20 token docs).
- Defect: on a delete request `request.resource` is null, so `request.resource.data.keys()` throws and the rule denies; the combined `allow write` therefore grants create and update only. The client cannot clean up, and today it does not try.
- Scenario: a band's shared iPad. Alice signs in, her Expo token is stored under `users/alice/pushTokens`; she signs out, Bob signs in. Every booking, payment, and ticket notification for Alice (title and body, e.g. "Offer accepted: $1,200 for Friday") keeps arriving on the device Bob is holding, indefinitely.
- Fix: split the rule into `allow create, update: if isOwner(uid) && tokenId.matches('^ExponentPushToken\\[[A-Za-z0-9_-]{1,200}\\]$') && request.resource.data.keys().hasOnly(['createdAt']) && request.resource.data.createdAt is int;` and `allow delete: if isOwner(uid);`. Mobile: delete `users/{uid}/pushTokens/{token}` before `signOut()`. Server: prune tokens Expo reports as `DeviceNotRegistered` in the push response. Add a rules test for owner delete succeeding and stranger delete failing.

### F4. Events collection has no list-provability tests; the SSR public pages run five untested query shapes

- Severity: Medium. Category: test-gap (provability). Owner: SP7 (before adding fan list queries, since regressions here 404 public pages silently).
- Evidence: `tests-rules/events.rules.test.ts` tests `events` and `tiers` by `getDoc` only; `apps/web/app/u/[handle]/page.tsx:147-149` (`bookedMusicianProfileId == X`, `status in ['filled','closed']`, `orderBy startsAt`), `:209-212` (curator closed leg with `bookedMusicianProfileId > ''`), `:254-256` (`lineupMusicianProfileIds array-contains`, `status == published`), `:282-284` (`curatorProfileId`, `status == published`, `orderBy startsAt`); `apps/web/src/events/EventsManager.tsx:152` (member, `curatorProfileId` only).
- Defect: the `in` and `>` shapes rely on the rules engine evaluating each `in` value and the inequality against `bookedMusicianProfileId != null`; both work today (the pages render in dev) but nothing pins them, and the tracks suite's only `in` test asserts a denial, so a future edit to the gigs or events rule could break the artist page's Shows section and every public event list without a red test.
- Fix: add to `events.rules.test.ts`: anon `status == published orderBy startsAt` succeeds; anon unfiltered denied; anon `status in ['published','completed']` succeeds; anon `status in ['published','draft']` denied; anon `lineupMusicianProfileIds array-contains X` + `status == published` succeeds; member `curatorProfileId == mine` (no status) succeeds and stranger denied; anon tiers `orderBy sortOrder` list under published succeeds and under draft denied; `collectionGroup('tiers')` and `collectionGroup('attendees')` denied for Admin. Add to `rules.test.ts` gigs: the exact Shows query, the curator closed leg, anon `status == filled` list, and `where bookingId == X, status == filled` for an anon caller (BookingInbox's shape).

### F5. `handles` get plus permanent download URLs make "unpublish" weaker than the admin UI implies

- Severity: Low. Category: leak (accepted design, needs to be recorded where operators see it). Owner: launch-checklist.
- Evidence: `firestore.rules:358` (`handles` get world-readable, doc is `{ profileId }` per `functions/src/profiles.ts:125`); `storage.rules:22-25` (public objects readable by path regardless of profile status); `docs/superpowers/sp2-rulings.md:20-24` (the deliberate two-step).
- Defect: after reject-from-approved or "Unpublish", the handle doc still resolves to the profileId, and every `public/tracks/{profileId}/...` and `public/photos/{profileId}/...` object (and every `getDownloadURL` token already issued, which never expires) keeps serving until `deleteProfile` runs.
- Scenario: a takedown for abusive audio: the page 404s within the 60 s ISR window, but anyone who captured the track URL (or a scraper that followed the SSR page) can keep playing and sharing it until an admin performs the second step.
- Fix: keep the design, but (a) make the admin "Unpublish profile" confirmation copy say that hosted audio and photos stay reachable by direct link until the profile is deleted, and (b) add a launch-checklist item that abuse takedowns are always the two-step. Optional hardening later: have `reviewProfile` reject-from-approved move `public/` objects to `review/` (the pipeline already has both paths) and move them back on re-approval.

### F6. World-readable member get under approved profiles is a uid-to-profile oracle no surface needs

- Severity: Low. Category: leak / dos. Owner: SP7.
- Evidence: `firestore.rules:70-71` (`|| profileApproved(profileId)` on `allow get`); the only client member-doc gets are self checks at `apps/web/src/bookings/BookingThread.tsx:119-120` and `apps/mobile/src/bookings/BookingThread.tsx:75-76`, which the self clause already serves.
- Defect: for an approved profile the get is allowed for any caller, so a nonexistent member returns "not found" and a real one returns `{uid, role, label, joinedAt}`; anyone holding a uid (a curator holding `orders.buyerUid` or `attendees.ownerUid`, a transfer counterpart holding `fromUid`, anyone reading `tracks.uploaderUid`) can test that uid against every approved profile. Each stranger get also bills an `exists()` and a `get()` before deciding.
- Fix: drop the `profileApproved(profileId)` disjunct from `allow get`; keep Admin, member, and self. Re-run the rules suite: the test at `rules.test.ts` "members are get-readable by anyone for approved profiles" pins the current behavior and would need its first assertion flipped, which is the intended change. If a future public "band members" surface needs the roster, serve it from a server-built projection on the profile doc (names and labels only, no uids).

### F7. Owner can remove or blank `users.displayName`

- Severity: Low. Category: security (validation). Owner: fix-now.
- Evidence: `firestore.rules:29-33`.
- Defect: `affectedKeys().hasOnly([...])` admits a `FieldValue.delete()` of `displayName`, and `.get('displayName','')` then passes the type and size checks; a plain `''` also passes (no minimum). `UserDoc.displayName` is required by the type and is copied into `attendees.ownerName`, notification copy, and the admin name search.
- Scenario: a fan blanks their name; the door roster shows an empty row; `displayNameLower` sync writes `''`; the admin search cannot find the account.
- Fix: add `&& 'displayName' in request.resource.data && request.resource.data.displayName.size() >= 1` (keep the 80 cap). Consider `.trim()` semantics server-side; rules cannot trim.

### F8. `notifications.read` is untyped and unsized

- Severity: Low. Category: security (validation, dos). Owner: fix-now.
- Evidence: `firestore.rules:45-46`.
- Defect: only the key set is constrained; the owner can set `read` to a 1 MiB string or a map, corrupting any server-side unread query and bloating their own doc.
- Fix: `&& request.resource.data.read is bool`.

### F9. Push token id length and `createdAt` type are unbounded

- Severity: Low. Category: dos. Owner: fix-now (fold into F3).
- Evidence: `firestore.rules:56-57`; fan-out cap at `functions/src/notifications.ts:11`.
- Defect: the token-id character class has no length bound (Firestore's own 1,500-byte id cap is the only limit), the count of token docs is unbounded, and `createdAt` may be any value. The server's `limit(20)` bounds the push fan-out, so the blast radius is storage growth plus 20 junk tokens posted to Expo per notification for that user only.
- Fix: as in F3; add a server-side prune that keeps the newest N token docs per user.

### F10. Event and tier docs expose ops stamps and sales figures to the world

- Severity: Low. Category: leak. Owner: SP7 (when the event doc is next touched).
- Evidence: `firestore.rules:258-259`, `266-267`; `EventDoc.settlementStartedAt`, `reminderSentAt`, `completedAt`, `maxTicketsPerBuyer`, `gigId`, `lineup[].bookingId`; `TicketTierDoc.soldCount`, `capacity`.
- Defect: anyone can read when a venue's ticket money was settled, whether a reminder went out, the internal booking ids behind the lineup, and exact tickets sold per tier. `soldCount` is a competitor-visible sales figure for every published and completed event.
- Fix: move `settlementStartedAt` and `reminderSentAt` to a server-only `events/{id}/private/ops` doc (they are read only by the sweeps); decide whether `soldCount` should be public or replaced by a server-maintained `soldOut: boolean` plus a coarse `remainingBucket` on the tier or event doc for the fan UI. `lineup[].bookingId` can be dropped from the public shape (the projection `lineupMusicianProfileIds` already serves the query).

### F11. Curator-side members read the buyer's Stripe PaymentIntent id and the platform fee split

- Severity: Low. Category: leak. Owner: SP8 or accept.
- Evidence: `firestore.rules:301-302`; `TicketOrderDoc.paymentIntentId`, `serviceFeeCents`, `feePolicy`.
- Defect: the order doc is read whole by the event's curator members. A PaymentIntent id is not a secret, but it is a support-fraud handle, and the fee policy snapshot is platform-internal.
- Fix: if curators need only quantities and totals for the door and refunds, serve them a projection (`attendees` already covers the door); otherwise accept and record.

### F12. `advertisingInterest` is world-readable on approved curator profiles

- Severity: Low. Category: leak. Owner: SP7.
- Evidence: `firestore.rules:62`; `CuratorDetails.advertisingInterest`; only the curator's own dashboard reads it (`apps/web/app/dashboard/curator/[profileId]/page.tsx:219`).
- Defect: an internal sales-lead flag ("interested in advertising with us") is public on every approved venue. `location.geocodedFrom` was checked and is not a leak: `functions/src/curator.ts:113` sets it to the address only for venues (whose address is public by design) and to the city for planners and hosts.
- Fix: move `advertisingInterest` into `profiles/{id}/private/booking` (member/Admin) or accept.

### F13. Transfer docs let a sender confirm which emails have accounts, bypassing the callable's anti-enumeration

- Severity: Low (throughput-bound). Category: leak. Owner: SP8 or accept.
- Evidence: `functions/src/ticketing.ts:1093-1099` (unknown email returns the generic "offer sent" and writes nothing; known email creates a transfer doc with `toUid`); `firestore.rules:324-325` allows the sender to list `transfers where fromUid == me`.
- Defect: the side effect is rules-readable, so the sender learns whether an email resolved (and its uid) by reading back their outgoing transfers. Throughput is one probe per held ticket per offer cycle, so this is a slow oracle, not a bulk one.
- Fix: keep as is and record, or add a per-sender offer cooldown in the callable. Hiding the doc from the sender would break the "pending offer" UI, so a rules change is not recommended.

### F14. Parent `get()` ordered before `isAdmin()` on tiers and attendees; per-query tier `get()` will multiply on SP7 list cards

- Severity: Low. Category: dos (cost). Owner: SP7.
- Evidence: `firestore.rules:266-267`, `292`; every other block in the file puts `isAdmin()` first.
- Defect: an admin read pays a billed `get()` and `exists()` before the free claim check; more importantly, every fan tiers query costs one rule `get()` on the parent, which is fine per event page but becomes N extra reads for an SP7 "events near you" list that wants a "from $X" price on each card.
- Fix: reorder to `isAdmin() || get(...).status in [...] || isMember(get(...).curatorProfileId)`; for SP7, denormalize `tierSummary: { minPriceCents, maxPriceCents, soldOut }` onto the event doc (server-maintained wherever `soldCount` is written) so list cards need no tier reads.

### F15. Admins cannot read invites

- Severity: Low. Category: security (business logic). Owner: SP7 or accept.
- Evidence: `firestore.rules:347-351`.
- Defect: the only block with a per-user audience and no Admin disjunct. Support cannot inspect "I never got the invite" or "who invited this person" without the Admin SDK.
- Fix: add `|| isAdmin()`.

### F16. Ticket holders lose read access to a cancelled event; clients infer "cancelled" from permission-denied

- Severity: Low. Category: security (business logic, fragile). Owner: SP7.
- Evidence: `firestore.rules:258-259` (no `cancelled` disjunct for holders); `apps/web/app/tickets/TicketsClient.tsx:84-89` and `apps/mobile/src/tickets/TicketList.tsx:79-83` treat any `permission-denied` as "this event was cancelled".
- Defect: after an event cancels, buyers cannot read its title, date, or poster; the client fills in a cancellation message on any denial, which also fires on a rules regression, an unpublished draft, or a deleted event, and would silently mislabel those.
- Fix: add `|| (resource.data.status == 'cancelled' && signedIn() && exists(/databases/$(database)/documents/users/$(request.auth.uid)/ticketIndex/$(eventId)))` (the same proof `private/address` uses; note the index doc must survive cancellation, or use a `cancelledTicketIndex` variant), and have the client key the "cancelled" copy on `status`.

### F17. `handles` get is an existence oracle for unpublished profiles

- Severity: Low. Category: leak (accepted). Owner: launch-checklist (record).
- Evidence: `firestore.rules:354-358`; handle doc is `{ profileId }`.
- Defect: any caller can learn that a handle is taken by a draft, pending, or rejected profile and obtain its profileId. The profileId alone unlocks nothing else (profile, tracks, members all deny; storage paths need an unguessable nonce). Needed for the availability check on profile creation, so accept.

### F18. Storage: staging accepts any `audio/*` and any number of objects; lifecycle rule is the only backstop

- Severity: Low. Category: dos. Owner: launch-checklist (already recorded as a launch blocker in README lines 554-558; keep it).
- Evidence: `storage.rules:46-56`, `57-74`.
- Defect: `contentType.matches('audio/.*')` is broader than `AUDIO_CONTENT_TYPES`; the processUpload trigger is the real gate (fine). No rule can cap object count per uid, so a hostile account can park unlimited 50 MB objects under `staging/audio/{uid}/...` for up to 24 h. `update` is allowed on staging, so a re-upload to the same path during processing is a client-triggerable double-finalize; the trigger must stay idempotent on that path.
- Fix: none in rules beyond what exists; keep the 24 h lifecycle rule as a launch blocker and consider a per-uid daily upload budget in the trigger (the geocode budget pattern already exists).

### F19. Anonymous SSR means every public rule is reachable without App Check

- Severity: Low today, Medium once SP7 ships lists. Category: dos. Owner: SP7.
- Evidence: `apps/web/src/lib/firebase-server.ts:5-8`; `apps/web/app/u/[handle]/page.tsx:13-18` (ISR 60 s as the only cap).
- Defect: not a rules bug, but a constraint: any list the rules make anon-provable is scrapable at Firestore speed by anyone with the public API key; rules cannot enforce `limit`. SP7 discovery lists (approved musicians by genre, events by city) will be full-dataset dumps by construction.
- Fix: for SP7, prefer server-built discovery projections (see D) with a single doc or a small number of docs per city, keep `limit` in every client query, enable App Check on the client SDK reads (SSR stays anonymous), and consider moving fan-only surfaces that do not need SEO behind `signedIn()`.

### F20. Rules and storage test gaps (beyond F4)

- Severity: Low. Category: test-gap. Owner: SP7 (rules) and launch-checklist (storage).
- Missing Firestore cases:
  - `profiles`: anon list `type == musician, status == approved` (MusicianBrowse, the hot fan path) and `type == curator, status == approved`; anon get on a nonexistent profile id (denied, not "not found").
  - `members`: get for a nonexistent member uid under an approved profile (the F6 oracle); fail-closed when the profile doc is missing.
  - `private/curatorBooking`: anon denied (the `signedIn()` guard has no test).
  - `gigs`: anon `status == filled` list; anon `status == closed` + `bookedMusicianProfileId > ''` (platform-wide, by design); the Shows `in` query; `bookingId == X, status == filled` by a stranger; GigBrowse's `status == open` plus `startsAt` range.
  - `users`: delete `displayName` (F7); `photoUrl` over 500 chars; `homeCity: null`; Admin update denied; owner delete denied; Admin `where email ==` list.
  - `notifications`: non-bool `read` (F8); owner list `orderBy createdAt`; owner delete denied.
  - `pushTokens`: owner delete (pin the intended behavior after F3); over-long token id; non-int `createdAt`.
  - `invites`: `invitedByUid` read; `where invitedUid == me` list; Admin currently denied (F15).
  - `handles`: get on a nonexistent handle returns not-found for anon.
  - Collection groups: `tickets`, `ticketIndex`, `tiers`, `attendees`, `private`, `payments` all denied for Admin and members.
  - Catch-all: an unknown collection denied to Admin.
- Missing Storage cases: 10 MB photo and 50 MB audio caps (boundary and over); wrong-uid photo staging; `public/{other kind}/...` get denied; `review/` list by Admin; `staging/photos` profileId regex; filename over 80 chars; `getMetadata` on a public object (allowed, confirm it exposes only contentType).

### F21. Unused composite index

- Severity: Low. Category: index. Owner: SP7 (bundle with the SP7 index deploy).
- Evidence: `firestore.indexes.json:60-64` `gigs (bookedMusicianProfileId ASC, startsAt ASC)`.
- Defect: no query in apps, functions, or scripts filters on `bookedMusicianProfileId` without also pinning `status`; all three call sites use the `(bookedMusicianProfileId, status, startsAt)` index at lines 71-76. The dead index costs one extra index write per gig write.
- Fix: delete it, or leave a comment naming the query that will use it.

---

## C. Index coverage table

"Served by" lists the composite (file line) or notes a single-field or merge-join path. Every
composite except one maps to a live query. The emulator enforces none of this; the README
already carries a "verify indexes build on first deploy" line per sub-project, and F1 adds the
field-override case those lines do not cover.

| # | Index (file line) | Query sites | Status |
|---|---|---|---|
| 1 | `invites (profileId, status)` (2) | `functions/src/members.ts:40` | used (server) |
| 2 | `tracks (status, order)` collection (7) | `apps/web/app/admin/page.tsx:1164`, `apps/web/app/u/[handle]/page.tsx:299`, `apps/mobile/app/artist/[handle].tsx:194` | used (anon SSR, client) |
| 3 | `gigs (curatorProfileId, status)` (12) | `u/[handle]/page.tsx:209`, `review.ts:117,155`, `gigs.ts:208`, `scheduled.ts:370` | used |
| 4 | `gigs (curatorProfileId, status, startsAt)` (17) | `OfferComposer.tsx:43`, `apps/mobile/src/bookings/MusicianBrowse.tsx:69`, `u/[handle]/page.tsx:332` | used |
| 5 | `gigs (seriesId, startsAt)` (23) | `gigSeries.ts:252,396` | used (server) |
| 6 | `gigs (seriesId, status)` (28) | `bookings.ts:618`, `gigs.ts:456` | used (server) |
| 7 | `gigs (seriesId, status, startsAt)` (33) | `bookingLifecycle.ts:157,1214` | used (server) |
| 8 | `gigs (status, startsAt)` (39) | `GigBrowse.tsx:70-81` (web and mobile), `scheduled.ts:573` | used |
| 9 | `gigs (bookingId, startsAt)` (44) | `bookingLifecycle.ts:308,729` (orderBy desc, served by reverse scan) | used (server) |
| 10 | `gigs (bookingId, status, startsAt)` (49) | `BookingInbox.tsx:114` (web, mobile), `BookingThread.tsx:170` (web, mobile), `scheduled.ts:805` | used |
| 11 | `gigSeries (curatorProfileId, status)` (55) | `gigSeries.ts:99`, `review.ts:167` | used (server) |
| 12 | `gigs (bookedMusicianProfileId, startsAt)` (60) | none | unused (F21) |
| 13 | `gigs (curatorProfileId, status, bookedMusicianProfileId)` (65) | `u/[handle]/page.tsx:211-212` | used (anon SSR) |
| 14 | `gigs (bookedMusicianProfileId, status, startsAt)` (71) | `u/[handle]/page.tsx:147-149`, `apps/mobile/app/artist/[handle].tsx:47-49` | used (anon SSR, client) |
| 15 | `bookings (gigId, status)` (77) | `bookings.ts:1108` | used (server) |
| 16 | `bookings (musicianProfileId, status, updatedAt desc)` (82) | `BookingInbox.tsx:255-275` (web, mobile), `bookingLifecycle.ts:1263` (prefix) | used |
| 17 | `bookings (curatorProfileId, status, updatedAt desc)` (88) | same call sites, curator side | used |
| 18 | `bookings (seriesId, status)` (94) | `bookings.ts:1111` | used (server) |
| 19 | `bookings (gigId, musicianProfileId, status)` (99) | `bookings.ts:104` | used (server) |
| 20 | `bookings (musicianProfileId, initiatedBy, status)` (105) | `bookings.ts:120` | used (server) |
| 21 | `bookings (curatorProfileId, initiatedBy, status)` (111) | `bookings.ts:120` | used (server) |
| 22 | `bookings (musicianProfileId, updatedAt desc)` (117) | `EarningsPanel.tsx:71` (web, mobile), `admin/page.tsx:984`, `PastShowsList.tsx:68` | used |
| 23 | `bookings (curatorProfileId, updatedAt desc)` (122) | `admin/page.tsx:982` | used |
| 24 | `bookings (status, resolvedAt)` (127) | `paymentsSweep.ts:1170` | used (server) |
| 25 | `payments CG (deposit.status, occurrenceStartsAt)` (132) | `paymentsSweep.ts:556,876` | used (server) |
| 26 | `payments CG (settlement.status, occurrenceStartsAt)` (137) | `paymentsSweep.ts:997` | used (server) |
| 27 | `payments CG (settlement.status, settlement.settleAfter)` (142) | `paymentsSweep.ts:1032` (dueField) | used (server) |
| 28 | `payments CG (settlement.status, settlement.nextRetryAt)` (147) | `paymentsSweep.ts:1032` (dueField) | used (server) |
| 29 | `payments CG (curatorProfileId, settlement.status)` (152) | `paymentsCore.ts:716` | used (server) |
| 30 | `payments CG (curatorProfileId, deposit.status, deposit.depositAttempts)` (157) | `paymentsCore.ts:723` | used (server) |
| 31 | `orders (status, expiresAt)` (163) | `paymentsSweep.ts:1280` | used (server) |
| 32 | `orders (buyerUid, eventId, status)` (168) | `ticketing.ts:100` | used (server) |
| 33 | `orders (eventId, status)` (174) | `paymentsSweep.ts:1421`, `ticketing.ts:588,608` | used (server) |
| 34 | `events (status, cancelledAt)` (179) | `paymentsSweep.ts:1317` | used (server) |
| 35 | `events (status, endsAt)` (184) | `paymentsSweep.ts:1517` | used (server) |
| 36 | `events (status, startsAt)` (189) | `scheduled.ts:914` | used (server); SP7's "published events by date" list can reuse it |
| 37 | `events (curatorProfileId, status, startsAt)` (194) | `u/[handle]/page.tsx:282-284` | used (anon SSR) |
| 38 | `events (lineupMusicianProfileIds contains, status, startsAt)` (200) | `u/[handle]/page.tsx:254-256` | used (anon SSR) |
| 39 | `transfers (ticketId, status)` (206) | `ticketing.ts:743,1086` | used (server) |
| 40 | `transfers (toUid, eventId, status)` (211) | `ticketing.ts:1112` | used (server) |
| 41 | `transfers (status, expiresAt)` (217) | `paymentsSweep.ts:1562` | used (server) |

Field overrides:

| Override (line) | Query sites | Status |
|---|---|---|
| `members.uid`: CG ASC only (223) | `collectionGroup('members').where('uid')` in `useMyProfiles.ts:36`, `ProfileContext.tsx:34`, `dashboard/page.tsx:41`, `earnings/page.tsx:26`, `gigs/[gigId]/page.tsx:64`, `admin/page.tsx:1292`, `account.ts:19`, `curator.ts:245`, `profiles.ts:79,156` | CG index used; collection-scope entries dropped (no production query needs them today; add for symmetry, F1) |
| `tickets.orderId`: CG ASC only (225) | CG: `ticketing.ts:422`; collection scope: `ticketing.ts:865` | collection-scope index dropped, likely breaks line 865 (F1) |
| `tracks.status`: COLLECTION ASC/DESC plus CG ASC/DESC (227) | `collectionGroup('tracks')` in `admin/page.tsx:601`, `scheduled.ts:597`; collection-scope `status in [...]` in `profiles.ts:186`, `tracks.ts:31` | correct shape (this is the model F1 asks the other two to copy) |

Queries that need no composite (single-field or equality merge-join), verified: `profiles (type, status)` in MusicianBrowse (web 127, mobile 221); `gigs (curatorProfileId, seriesId)` on the series pages; `bookings (curatorProfileId, paymentSummary.state)` in `delinquentBookings.ts:16`; `users where email ==` and `displayNameLower` range (admin); every `orderBy` on a single field under a path-scoped subcollection (tiers `sortOrder`, tickets and notifications `createdAt`, tracks `order`, payments `occurrenceStartsAt`, auditLogs `at`, adminAlerts `lastSeenAt`); every `where(x) orderBy(__name__)` sweep pagination.

---

## D. What SP7 and SP8 must know

1. **The SSR path is anonymous.** Every discovery read that renders server-side must be provable for `request.auth == null`: pin `status` to a single public value (or an `in` list whose every value is public) on every list, never rely on `!=` or `not-in`, and never add a disjunct that needs `request.auth` on a query the SSR issues. If a new surface can be client-only, it can require `signedIn()` and gain App Check.

2. **What the current rules already allow for fans, with the index status:**
   - Published events by date: `events where status == published, startsAt >= now orderBy startsAt`: rules OK, index 36 exists. Adding `location.city == X` needs a new composite `(status, location.city, startsAt)`; the equality merge-join will not serve a range plus orderBy.
   - Events for one venue: `curatorProfileId == X, status == published orderBy startsAt`: rules OK, index 37 exists.
   - Events by lineup act: rules OK, index 38 exists.
   - Approved musicians: `profiles where type == musician, status == approved`: rules OK today with no orderBy. Adding `portfolio.genres array-contains G` plus `orderBy name` needs `(status, type, portfolio.genres CONTAINS, name)`. **Musician profiles have no city field** (`CuratorDetails.location` is curator-only), so "musicians near me" needs a new server-written `portfolio.homeCity` (or `users.homeCity` rolled up onto the profile) before any index exists to build.
   - Approved venues by city: `type == curator, status == approved, curator.location.city == X`: rules OK, needs `(status, type, curator.location.city)` if ordered.
   - Open gigs: rules OK, index 8 exists, but see F2 before pointing fans at it.
   - Tiers per event card: rules OK but cost one `get()` per query (F14); denormalize a tier summary onto the event.

3. **What the rules would deny or make unprovable:**
   - Any cross-status list ("upcoming or past" in one query) unless every status in the `in` list is public; `published` plus `completed` is fine, anything touching `draft` or `cancelled` fails the whole query.
   - Listing `handles` (denied by design) for handle-prefix search; use a projection.
   - Listing `profiles` by anything not pinned to `status == approved`.
   - Full-text search of any kind: Firestore has none; prefix on a lowercased field is the ceiling.
   - Reading `soldCount` without also exposing it to competitors (F10): choose a public shape deliberately.

4. **Follows and favorites (the first fan writes):** two shapes are consistent with "Cloud Functions are the only privileged writer":
   - Direct client write, owner-scoped: `match /users/{uid}/follows/{profileId} { allow read: if isOwner(uid); allow create, delete: if isOwner(uid) && profileId.matches('[A-Za-z0-9_-]{1,64}') && get(/databases/$(database)/documents/profiles/$(profileId)).data.status == 'approved' && request.resource.data.keys().hasOnly(['createdAt']) && request.resource.data.createdAt is int; allow update: if false; }`. One billed `get()` per follow; no way to maintain a follower count without an `onWrite` trigger; unbounded count per user (a trigger can enforce a cap by deleting).
   - Callable `toggleFollow`: server validates the target, writes both `users/{uid}/follows/{profileId}` and a private counter, and can rate-limit. Fewer rules, one more function, and it keeps the "no client writes outside users/{uid}" invariant the whole file expresses. Recommended.
   - Either way, keep follower lists private (`profiles/{id}/followers` should never be world-readable; a count on the profile doc is enough) and never let a follow doc carry anything but `createdAt`.

5. **The shape the rules push toward: server-built discovery projections.** Three forces, all visible in this file: (a) provability requires a status pin on every query, which is fragile as soon as a list spans statuses or needs `not-in`; (b) full source docs leak business-internal fields (F2, F10, F12) that a projection would simply omit; (c) hot-path rules that `get()` a parent (tiers, tracks) multiply on list cards. A `discovery/{kind}/{id}` collection written by the existing triggers (profile approve/unpublish, event publish/cancel/complete, tier sold-count writes) containing only the public fields plus flattened search keys (`city`, `genres`, `nameLower`, `searchTokens`, `startsAt`, `tierSummary`) gets one rule (`allow read: if true`, list included), zero `get()`s, no cross-status provability puzzles, and a single place to reason about what the world can see. SP8 search then runs prefix queries on that collection (or feeds it to an external index) without widening any source-collection rule. The current `publicBooking` mirror on the profile doc and `lineupMusicianProfileIds` on the event doc are already this pattern in miniature.

6. **Indexes:** every SP7 composite must be added to `firestore.indexes.json` and confirmed built on the real project; the emulator will pass with none of them. Bundle F1's override fix and F21's deletion into the same deploy.

7. **Tests:** add the F4 and F20 cases before SP7 changes any public rule, so the artist, curator, and event pages have a red test standing between them and a silent 404.

8. **Copy and product rulings to record in the SP7 rulings doc:** whether gig budgets are public (F2), whether tier sales counts are public (F10), and the unpublish two-step wording (F5).
