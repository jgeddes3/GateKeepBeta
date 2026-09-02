# GateKeep documentation audit (2026-09-01, pre sub-project 7)

Read-only audit of CLAUDE.md, README.md, DESIGN.md, docs/superpowers/HANDOFF.md, the nine
rulings docs, the nine specs (headers, scope, out-of-scope), and grep-level checks of the nine
plans, all verified against the code on `main` at 4dab485. No repo file was modified. This
report contains no em dashes; where a quoted doc line contains one it is written as `(em dash)`.

Severity key: High = misleads a fresh session into a wrong decision. Medium = stale but
harmless if the reader also checks code. Low = cosmetic.

Totals: 7 High, 14 Medium, 8 Low (29 findings).

Verification baseline (all confirmed this session):
- `pnpm --filter @gatekeep/shared test`: 158 passed (validation.test.ts registers 126, 10 of
  them loop-generated at test/validation.test.ts:292 and :575).
- `vitest list` in functions/: 704 registered tests. `vitest list` in tests-rules/: 103.
  (Emulator ports 5001/8080/9099/9199 were already occupied on this machine, so the suite was
  not re-run against the owner's live emulator state; collect-only counts are exact.)
- `pnpm typecheck` workspaces: apps/mobile, apps/web, functions, packages/shared, tests-rules
  (pnpm-workspace.yaml), matching "5/5".
- firestore.indexes.json: 41 composite indexes (invites 1, tracks 1, gigs 11, gigSeries 1,
  bookings 10, payments 6 CG, orders 3, events 5, transfers 3) plus 3 fieldOverrides
  (members.uid CG, tickets.orderId CG, tracks.status).
- functions/src/index.ts exports 51 functions across 31 source files.

---

## A. Numbered findings

### High

**A1. README says any member can trigger payouts; code and sp5 rulings say admin only.**
- Where: README.md:343-344 ("Any member of a profile can trigger its payouts (em dash) that is a
  deliberate product decision") and README.md:702-707 ("Product decision recorded: ANY member of
  a profile can trigger its payouts (`requestPayout` calls `requireProfileMember`...)").
- Truth: functions/src/paymentsPayouts.ts:194-199 has the owner ruling comment "(H2): ADMIN-only"
  and calls `requireProfileAdmin(profileId, uid)`; the file imports only `requireProfileAdmin`
  (line 38). sp5-rulings.md:55-59 ruling 7 records "Payout authority = profile ADMINS only";
  sp5b-rulings.md:44-46 ruling 6 confirms mobile renders the buttons for any member and lets the
  `requireProfileAdmin` refusal surface. `createOnboardingLink` is admin-gated too.
- Root cause: README was written from the SP5 plan snippet (plans/2026-08-27-payments.md:2188,
  `requireProfileMember`) which the security fix wave superseded; the plan's own as-built block
  (:2236-2244) never recorded the H2 change.
- Fix: rewrite both README passages to "profile ADMINS only (`requireProfileAdmin`); members see
  balance/status via `getStripeStatus`". Add the H2 note to the payments plan as-built block.

**A2. README intro is five sub-projects stale.**
- Where: README.md:4 "(later) ticketing"; README.md:8 "This repo now spans three sub-projects";
  README.md:19 "records a 35% deposit as data (no money moves yet)".
- Truth: nine sub-projects merged (1, 2, 3, 4, 5, 5b, 9A, 9B, 6 per HANDOFF.md:16-38). Deposits
  are real money (functions/src/paymentsCore.ts, DepositStatus in packages/shared/src/types.ts;
  sp4-rulings.md:118-128 RESOLVED (SP5)). Ticketing shipped (functions/src/ticketing.ts,
  apps/web/app/e/[eventId], apps/web/app/tickets, apps/mobile/app/(fan)/tickets.tsx).
- Fix: replace README.md:3-23 with a one-paragraph-per-sub-project summary that includes 5, 5b,
  6, 9A, 9B, or cut the intro to a pointer at HANDOFF.md "Where the build stands".

**A3. README describes dailySweep as five steps; it has eight. Sweep step numbering is
ambiguous across two sweeps.**
- Where: README.md:167-169 "does five things in one pass", README.md:179 "Each of the five
  steps", README.md:182 "Steps 1 and 3-5 also page". README itself contradicts this at :259
  ("completion sweep (step 7)") and :278 ("Sweep step 6").
- Truth: functions/src/scheduled.ts step comments: 1 materialize (:322), 2 past-gig close
  (:568), 3 track reaper (:586), 4 invite sweep (:613), 5 curatorAccess retries (:638),
  6 booking expiry (:674, SP4), 7 booking completion (:717, SP4), 8 event-tomorrow reminders
  (:896, SP6). Separately functions/src/paymentsSweep.ts has 11 steps (1-7 SP5; 8 ticket order
  expiry :1186, 9 cancelled-event refund retry :1296, 10 T+1 ticket settlement :1341, 11 stale
  transfer expiry :1533). README.md:385-388 describes paymentsSweep without steps 8-11.
- Cross-doc ambiguity: sp6-rulings.md:21 "additive sweep steps 8-11" means paymentsSweep, while
  sp6-rulings.md:24 "event reminders" is dailySweep step 8. Both sweeps now have a "step 8".
  sp3-rulings.md:230 "let the sweep's 5th step retry" and sp3-rulings.md:380 "Sweep step 5" mean
  dailySweep. A fresh session cannot tell which sweep a bare "step N" refers to.
- Fix: README "The daily scheduled job" paragraph lists all 8 steps; README Payments section
  lists paymentsSweep steps 1-11; adopt the convention "dailySweep step N" / "paymentsSweep step
  N" in every doc going forward (one-line note in HANDOFF "Binding rules").

**A4. Shared message constants (user-facing copy) contain em dashes, contradicting the hard
rule as stated.**
- Where the rule is stated: DESIGN.md:14-15 ("not in copy, not in code comments, not in code
  strings, not in documentation"); HANDOFF.md:46 ("No em dashes anywhere: code, comments, copy,
  docs, commit messages"); specs/2026-08-30-events-ticketing-design.md:170 ("Copy obeys the
  no-em-dash rule").
- Truth: packages/shared/src/messages.ts has 17 string-literal em dashes in exported constants
  that both clients render verbatim and compare with `===` (e.g. :33 CURATOR_DELINQUENT_MESSAGE,
  :47 CARD_DECLINED_MESSAGE, :74, :79, :86-96, :108, :117, :121). README.md:802-803 and :829-830
  quote them as expected UI output. functions/src has a further ~200 string-literal em dashes in
  HttpsError messages (paymentsSettlement.ts 52, paymentsSweep.ts 28, bookingLifecycle.ts 17,
  bookings.ts 17, payments.ts 16, paymentsPayouts.ts 9, tracks.ts 6, ...). sp9b-rulings.md:81
  explicitly left shared strings untouched because 9B was presentation-only.
- Why High: a session writing SP7 copy that reads messages.ts as the house style will copy the
  pattern; a session told the rule is absolute will find the most visible copy violating it.
- Fix: one coordinated sweep of messages.ts plus the functions error strings and the tests that
  assert them (clients import the constants, so the client side is zero-touch). Then re-state the
  rule in HANDOFF with the date the copy was made compliant. See section D for the census.

**A5. HANDOFF "Owner-owed items" omits the two CRITICAL deploy-order items and the one
LAUNCH BLOCKER.**
- Where: HANDOFF.md:72-82 lists 5 bullets (web smoke, mobile smoke, two colors, hero photos,
  "Stripe go-live checklist ... Firebase console items and legal-page review (README launch
  checklist)").
- Missing (each recorded elsewhere as blocking): staging/ 24h GCS lifecycle rule
  (README.md:554 "LAUNCH BLOCKER"; sp2-rulings.md:37-39; sp5-rulings.md:138); the
  `backfillBookingVisibility` same-release rule (README.md:632 "CRITICAL ordering";
  sp4-rulings.md:27-29 ruling 3); `LAUNCH_TIMEZONE` still "America/New_York"
  (packages/shared/src/types.ts:316; README.md:595-600); the sub-6 owner smoke (mentioned at
  HANDOFF.md:34-37 in the build-status list but not in the owner-owed section); composite index
  verification (41 indexes, 3 overrides); the two Cloud Scheduler existence checks; the
  stripeEvents TTL policy; the PROD Firebase project creation (foundation-rulings.md:14).
- Fix: replace HANDOFF.md:72-82 with section B of this report (or a pointer to a new README
  "Consolidated launch checklist" that section B seeds).

**A6. SP7/SP8 ownership is contested across specs, and messaging has no owner at all.**
- Map UI: specs/2026-08-26-curator-gigs-design.md:15 "fan-facing map UI (sub-7)";
  specs/2026-08-26-booking-flow-design.md:14 says both "fan map UI (sub-7)" and "sub-8: ...
  maps"; specs/2026-08-28-web-uiux-design.md:166 "Map view of gigs (sub-8)".
- Search: specs/2026-08-24-foundation-design.md:33 puts search inside 7; booking-flow spec :14
  moves "full search experience" to a new sub-8 by owner directive; HANDOFF.md:39 "7 Fan
  discovery, then 8 Search".
- Event discovery feeds: specs/2026-08-30-events-ticketing-design.md:161 "sub-7/sub-8".
- Messaging: specs/2026-08-24-foundation-design.md:19 promises "Gig planning happens in-app via
  musician <-> curator messaging" and build-order item 4 (:30) includes it; SP4 shipped
  terms-only threads and its spec :14 marks "general messaging/chat (unscheduled)"; mobile ships
  coming-soon Messages tabs (apps/mobile/app/(curator)/messages.tsx:15,
  apps/mobile/app/(musician)/messages.tsx). No later doc assigns it.
- Fix: before the SP7 brainstorm, add a "Roadmap" block to HANDOFF that assigns: follow artists
  + performance notifications + fan home/discover feed (7); text search + ranking + map + saved
  searches/alerts + directory internals (8); messaging (explicitly unscheduled or given a number);
  5c band splits (deferred). See section E.

**A7. `resumeSeries` load-bearing tripwire is carried only through sp5-rulings and has
dropped out of every later doc, including HANDOFF.**
- Where recorded: sp3-rulings.md:110-139 ruling 19 (Critical-severity regression if a naive
  resume ships), sp3-rulings.md:240-251, sp4-rulings.md:147-153, sp5-rulings.md:148-149.
  Not mentioned in sp5b, sp6, sp9a, sp9b, or HANDOFF.md.
- Truth: no `resumeSeries` or `pausedBy` exists anywhere (grep of functions/src, packages/shared,
  apps, firestore.rules is empty), so pause is still one-way and the tripwire is still armed.
- Fix: add a "Standing tripwires" list to HANDOFF (resumeSeries approval-gate + pausedBy;
  Android openBrowserAsync asymmetry from sp5b-rulings.md:34-38 for any future in-app-browser
  flow; the 24h idempotency-key hazard from sp5-rulings.md:76-80; RSC boundary rule
  sp9a-rulings.md:38-42).

### Medium

**A8. README monorepo map is three sub-projects stale.**
- Where: README.md:25-75.
- functions/src (:39-58) omits 13 of 31 files: bookings.ts, bookingLifecycle.ts,
  bookingVisibility.ts, payments.ts, paymentsCore.ts, paymentsSettlement.ts, paymentsSweep.ts,
  paymentsPayouts.ts, paymentsWebhook.ts, stripeClient.ts, events.ts, eventsCore.ts,
  ticketing.ts. guards.ts line (:42) omits `requireApprovedCuratorProfile` and
  `requireApprovedMusicianProfile` (functions/src/guards.ts:47, :59). scheduled.ts line (:55)
  says "(sub-project 3)" only.
- packages/shared/src (:38) lists 4 files; actual 8 (adds money.ts, messages.ts,
  paymentDisplay.ts, feePreviews.ts).
- apps/mobile (:59-66) omits src/{bookings,payments,events,tickets,theme,ui,notifications,types},
  app/(fan)/*, app/booking/[bookingId].tsx, app/event/[eventId].tsx,
  app/(curator)/events/{event/[eventId],scan/[eventId]}.tsx, app/(curator)/{bookings,
  musicians,messages}.tsx.
- apps/web (:67-73) omits app/{dashboard/bookings, dashboard/earnings(+onboarding),
  dashboard/events, e/[eventId], tickets, gigs/[gigId], design, terms, privacy, sign-in,
  u/[handle]/shows} and src/{auth,bookings,components,events,marketing,payments,shell,ui}.
- scripts/ is absent from the map entirely (3 scripts exist).
- Fix: regenerate the map from `git ls-files` and annotate by sub-project.

**A9. README "Design docs" list stops at SP5.**
- Where: README.md:972-998. Missing: 5b (spec 2026-08-28-mobile-payments-design.md, plan,
  sp5b-rulings.md), 6 (2026-08-30-events-ticketing-design.md, plan, sp6-rulings.md), 9A
  (2026-08-28-web-uiux-design.md, plan, sp9a-rulings.md, mocks/sp9a/), 9B
  (2026-08-29-mobile-uiux-design.md, plan, sp9b-rulings.md). Also missing pointers to
  foundation-rulings.md, sp2-rulings.md, sp5-rulings.md, HANDOFF.md, and DESIGN.md.
- Fix: one table (sub-project, spec, plan, rulings, merge date) and a line saying rulings are the
  authority for each area (HANDOFF.md:16).

**A10. README has no "Events & ticketing (sub-project 6)" concept section.**
- Where: README has concept sections for SP3 (:143), SP4 (:189), SP5 (:289) but SP6 appears
  only as launch/smoke checklists (:869-936). The ticket fee (sp6-rulings.md:37-40, 7% + 99c
  capped at 399c, fan-paid), T+1 settlement, buyer cap, QR secret model, and the six new
  collections (firestore.rules:254-335) are undocumented in README.
- Fix: add a section mirroring the SP5 one, sourced from sp6-rulings "What shipped" and "Load-
  bearing rulings".

**A11. README environment-variable table omits variables the code reads.**
- Where: README.md:399-410 lists 10 variables.
- Missing rows: `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` (apps/mobile, referenced in prose at :367
  and :724 but not in the table), `FIREBASE_EMULATORS` (apps/web/src/lib/firebase-server.ts:27,
  prose at :478), `STORAGE_BUCKET` (functions/src/storage.ts:8, default
  gatekeep-dev-jg.firebasestorage.app, a production must-set), `WEB_PORT`
  (scripts/seed-test-event.ts:41), `GOOGLE_APPLICATION_CREDENTIALS`
  (scripts/seed-test-accounts.ts:37).
- Fix: add the five rows; `STORAGE_BUCKET` also belongs on the launch checklist.

**A12. scripts/ is undocumented in README; `seed-test-event.ts` is undocumented anywhere.**
- Where: README.md has zero references to scripts/ (only :286 mentions a test helper named
  `seedSeries`). `scripts/seed-admin.ts` is named only in foundation-rulings.md:26 and :63;
  `scripts/seed-test-accounts.ts` only in HANDOFF.md:60 and sp9a-rulings.md:60;
  `scripts/seed-test-event.ts` (SP6, usage in its own header :21-24) nowhere.
- Fix: a README "Scripts" section with the three usage lines; add seed-test-event to HANDOFF's
  quickstart after the accounts seed.

**A13. sp9a ruling 10 (seed-script em dashes, "fix post-merge") is not done, and its
description is inaccurate.**
- Where: sp9a-rulings.md:60-61 says the bios contain em dashes.
- Truth: scripts/seed-test-accounts.ts still has 10 em dashes at :3, :4, :5, :7, :19, :25, :54,
  :109, :127, :146, all in comments and console.log output; the one bio (:119) is clean.
- Fix: sweep the file (code rule), annotate the ruling RESOLVED with the commit.

**A14. sp9b-rulings claims all 9B output is em-dash-free; the 9B spec and plan are not.**
- Where: sp9b-rulings.md:6 "this document, like all 9B output, contains no em dashes".
- Truth: specs/2026-08-29-mobile-uiux-design.md has 22 (title :1, :5, :29, :32, :40 ...) and
  plans/2026-08-29-mobile-uiux.md has 34 (:11, :18, :26, :38 ...). Both post-date the rule
  (the spec restates it at :9). The rulings doc itself is clean. 9A's spec/plan (0/0) and 6's
  (0/0) are clean.
- Fix: sweep those two files; narrow the claim to "this document and all 9B code".

**A15. sp3-rulings post-gate follow-ups are all resolved in code but none is annotated.**
- Where: sp3-rulings.md:378-399 (six bullets, "file with sub-4").
- Truth: sweep step 5 per-doc try/catch DONE (functions/src/scheduled.ts:645-668, comment
  "SP4 (Task 13 item 1)"); updateGig `| undefined` DONE (functions/src/gigs.ts:272, :300);
  removeMember `isValidDocId` + `requireVerifiedEmail` DONE (functions/src/members.ts:155-164,
  "SP4 (Task 13 item 3)"); deleteProfile handle-delete moved after the cascade and precondition-
  guarded DONE (functions/src/profiles.ts:299-323, "SP4 (Task 13 item 5)"); invite-accept fast
  path repaired DONE (functions/src/members.ts:106-122, "SP4 Task 13 item 6");
  syncCuratorAccess paginated at 100 (functions/src/curator.ts:244; booking plan :322), still
  sequential per page (partial). S4 test-gap: members.test.ts:434-448 covers the race
  reasoning; treat as addressed.
- Fix: annotate each bullet "RESOLVED (SP4 Task 13)" the way sp3 rulings 23/24 were.

**A16. Foundation deferred list and sp2 obligations were resolved but never annotated.**
- foundation-rulings.md:34-41: name search DONE (functions/src/adminTools.ts, SP3);
  `deleteProfile` status restriction DONE (sp2 ruling 4); mobile account-screen dedup DONE
  (apps/mobile/src/shell/AccountScreen.tsx); `requireAuth` consolidation DONE (single
  `requireVerifiedEmail` at functions/src/guards.ts:13, no other definition);
  `@handle` rewrite DONE (apps/web/next.config.ts:14-22); revise+resubmit UI DONE
  (apps/web/app/dashboard/portfolio/[profileId]/page.tsx:296 and three siblings); mobile lint
  green DONE (SP2). Still open: orphaned `pending` invites on `deleteProfile`
  (functions/src/profiles.ts has no invite handling; only dailySweep step 4 expires them after
  14 days).
- sp2-rulings.md:49-53 same list; :54-56 booking-read widening superseded by SP4 (annotated in
  sp3 only); :57-58 curator wizard DONE (SP3); :59-61 suspension note still a valid conditional.
- Fix: annotate in place; move the one live item (orphaned invites) to HANDOFF's tripwire list
  or a "Known small gaps" list.

**A17. Deferred items that remain open and are recorded only in one older rulings doc.**
- sp5b-rulings.md:66-69 mobile `startsSoonFlash` grace-window warning: still web-only
  (apps/web/src/bookings/BookingThread.tsx:404; no mobile occurrence). 9B and SP6 both touched
  the mobile booking UI and did not port it.
- sp5b-rulings.md:70-71 TrueUpForm "3.5" silently rounds: still true on both
  (apps/mobile/src/payments/TrueUpForm.tsx:50-51, apps/web/src/payments/TrueUpForm.tsx:61-62).
- sp5-rulings.md:152-153 `getStripeStatus` TTL cache (M7) and `revokeAdmin`/`checkRevoked`
  (L9): not built (grep empty).
- sp4-rulings.md:173-174 unused `gigs (bookedMusicianProfileId, startsAt)` index: still present
  (firestore.indexes.json entry 12) and still unused (both Shows queries pin `status in [...]`
  and use the 3-field index: apps/web/app/u/[handle]/page.tsx:145-149,
  apps/mobile/app/artist/[handle].tsx:45-49).
- sp9a-rulings.md:73-76 riding minors: "Forfeited deposit:" wording still shipped
  (apps/web/src/payments/EarningsPanel.tsx:170, PaymentsPanel.tsx:66); footer mailto still
  placeholder (apps/web/src/shell/Footer.tsx:9).
- sp9b-rulings.md:110-112 events list badge still fixed `neutral`
  (apps/mobile/app/(curator)/events/index.tsx:504).
- sp6-rulings.md:84-97 all still open as described (poster: functions/src/media.ts:360-367
  returns without persisting; the comment there describes a client pass-back that the client
  cannot perform because the trigger is asynchronous).
- Fix: a single "Open follow-ups" ledger in HANDOFF (or a docs/superpowers/OPEN-ITEMS.md)
  with source pointers, so items stop being rediscovered by grep.

**A18. Docs point at gitignored or non-existent artifacts.**
- sp3-rulings.md:9 ledger `.superpowers/sdd/2026-08-26-curator-gigs/progress.md` and :365
  `task-14-report.md`: `.superpowers/sdd/` does not exist locally and `.superpowers/` is
  gitignored (.gitignore:8). DESIGN.md:28 `.superpowers/brainstorm/` exists locally only.
  sp9a-rulings.md:33 "The matrix is in the Task 4 report" (no path; not in repo).
  functions/src/stripeClient.ts references `superpowers/plans` in a comment.
- Fix: either copy the referenced matrices into the rulings docs or mark the pointers
  "(local-only, not in repo)".

**A19. `.claude/` is untracked and unignored; a locked SP6 worktree lives inside it.**
- Where: `git status` shows `?? .claude/`. Contents: `.claude/settings.local.json` (31 bytes,
  `{"outputStyle": "Concise"}`, a personal preference) and `.claude/worktrees/sp6-events-
  ticketing/` (a git worktree on branch `worktree-sp6-events-ticketing` at 4dab485, which is
  main's HEAD; `git worktree list` marks it locked; `git status` inside it is clean; `git
  branch --merged main` lists the branch; the only byte difference vs main is CRLF line
  endings on CLAUDE.md).
- .gitignore:9 ignores `.worktrees/` (the sp5-era location, now empty/absent) but not
  `.claude/worktrees/`.
- Recommendation: add `.claude/settings.local.json` and `.claude/worktrees/` to .gitignore
  (Claude Code's own convention keeps `settings.local.json` untracked; commit a shared
  `.claude/settings.json` only if the team wants shared permissions). The worktree is safe to
  remove (not removed by this audit): `git worktree unlock .claude/worktrees/sp6-events-
  ticketing && git worktree remove .claude/worktrees/sp6-events-ticketing && git branch -d
  worktree-sp6-events-ticketing`.

**A20. Plans are not byte-for-byte as-built for SP5 and SP6; nothing depends on them, but
their snippets are copy hazards.**
- Claim: sp2-rulings.md:43-45 ruling 10 ("plan is the as-built record"); sp4-rulings.md:9 and
  sp5-rulings.md:9-10 repeat it.
- Spot checks: (1) plans/2026-08-27-payments.md:2178-2188 `requestPayout` uses
  `requireProfileMember`; code uses `requireProfileAdmin` (paymentsPayouts.ts:199); the as-built
  block :2236-2244 is silent on it. STALE, and it is the exact snippet README copied (A1).
  (2) plans/2026-08-30-events-ticketing.md:367 ledger id `ticket_settlement:${eventId}` vs code
  `ticket_settlement:{transferId}` (sp6-rulings.md:76-77 ruling 12); :299 says
  `finalizeTicketOrder` "returns shared-message status string" vs code `{ orderStatus }`
  (functions/src/ticketing.ts:175, sp6 ruling 13). STALE. (3) plans/2026-08-24-foundation.md:716
  rules snippet lacks the `/{path=**}/members` collection-group rule that firestore.rules:337
  has (foundation-rulings.md:17 records the override). STALE by design. (4) plans/2026-08-26-
  booking-flow.md:183 `rebuildBookingProjections(profileId, source?)` matches
  bookingVisibility.ts:43. OK. (5) plans/2026-08-25-musician-portfolio.md:5449
  `MOBILE_MAX_AUDIO_BYTES` matches apps/mobile/src/portfolio/TrimUploader.tsx:27. OK.
  (6) plans/2026-08-29-mobile-uiux.md:30-31 tokens match apps/mobile/src/theme/tokens.ts:25,
  :34. OK.
- Dependency check: no code, config, or script references docs/superpowers/plans (only rulings,
  README, and one comment in stripeClient.ts). Nothing relies on the convention.
- Fix: add a two-line banner at the top of each plan: "Historical execution plan. Snippets may
  predate review fixes. Code and the rulings doc win." Drop the "as-built" wording from
  sp2/sp4/sp5 rulings headers or scope it to those two sub-projects.

**A21. README 9B smoke checklist "Coming-soon states" is partly stale after SP6.**
- Where: README.md:774-775 "the fan tabs (discover, search, tickets)".
- Truth: tickets is the real wallet (apps/mobile/app/(fan)/tickets.tsx:7 comment; TicketList);
  discover carries the upcoming-events list with a residual "Live music near you, coming soon"
  line ((fan)/index.tsx:100); only search ((fan)/search.tsx:15) and the two messages tabs remain
  coming-soon.
- Fix: edit the bullet to "search tab and the curator/musician messages tabs".

### Low

**A22. HANDOFF sub-project list reads "5, 5b, 9A, 9B, 6".**
- HANDOFF.md:16-38 is in merge order (9A/9B merged 08-29, 6 merged 08-31) but numbered by id,
  so the list appears out of order. Add merge dates per line or reorder by id with a date column.

**A23. DESIGN.md header scopes itself to 9A/9B; HANDOFF makes it binding on all work.**
- DESIGN.md:3-6 vs HANDOFF.md:25 and :43. Update DESIGN.md:3-6 to "binding for all UI work".
  DESIGN.md:57 mentions `components.json` without its path (apps/web/components.json).

**A24. README:119-120 says the first mobile lint run scaffolds eslint.config.js.**
- The file is tracked (`git ls-files apps/mobile/eslint.config.js`). Drop the clause.

**A25. Index-verification caveat is repeated four times with per-SP counts and no total.**
- README.md:587, :647, :708, :875. Per-SP counts (5 + 16 + 7 + 11 = 39) plus invites (1,
  foundation-rulings.md:71) and tracks (1, SP2) = 41, matching firestore.indexes.json. Collapse
  to one launch item: "confirm all 41 composite indexes and 3 field overrides show Enabled".

**A26. README:514 "EAS build setup (in progress, 2026-08-27)".**
- Status marker is five days old with no resolution recorded; either it is done (then annotate)
  or still owed (then it belongs in section B, where it is listed).

**A27. CLAUDE.md is adequate as a six-line pointer, with two gaps.**
- It points at HANDOFF (project state, rules, quickstart, rulings authority) and DESIGN.md.
  HANDOFF in turn covers antislop (:44-45), gates (:66-67), test logins (:61-63), and the
  rulings list (:16-38). Gaps: neither file names README as the operational reference (env
  vars, launch checklists, smoke walkthroughs) except via the owner-owed pointer; neither states
  the "spec beats plan" rule (foundation-rulings.md:16) or the emulator foreground-run rule
  (sp6-rulings.md:115-117); the PS 5.1 byte-safety note is present (HANDOFF.md:68-69).
  Suggested CLAUDE.md addition: one line "README.md holds env vars, launch checklists, and smoke
  walkthroughs; specs are binding over plans; run the emulator suites as a single blocking
  foreground call".

**A28. apps/web/AGENTS.md is tracked and regenerated by `next dev`.**
- It carries 2 em dashes (Next.js's own text) and is rewritten on every dev run (its own
  header says so). Decide: keep tracked (accept the glyphs as third-party) or gitignore it.

**A29. sp4-rulings:168-169 says sub-6 builds on "completed" bookings; SP6 verifies
"confirmed".**
- sp6-rulings.md:67-69 ruling 9: the lineup booking must be `confirmed`. Not wrong (events are
  created before the show), but the SP4 wording will confuse. Annotate.

---

## B. Consolidated owner-owed launch table (deduplicated)

Status column: Open = verified still outstanding in code or unverifiable from the repo.
"HANDOFF?" = whether HANDOFF.md:72-82 names it (directly or by pointer).

| # | Item | Blocking? | Sources | Code evidence | HANDOFF? |
|---|---|---|---|---|---|
| 1 | Create the PROD Firebase project under the business Google account; keep `gatekeep-dev-jg` as DEV | Launch | foundation-rulings.md:14 | .firebaserc | No |
| 2 | Enable Email/Password, Google, Apple sign-in providers (dev and prod) | Launch | README.md:488-490; foundation-rulings.md:63 | n/a (console) | Pointer only |
| 3 | App Check: register web (reCAPTCHA v3 site key) and mobile (Play Integrity / App Attest); monitor mode until native mobile App Check ships; do NOT enforce Storage before it | Launch | README.md:491-501, :533-539 | apps/web/src/lib/firebase.ts (init gated on prod + key) | Pointer only |
| 4 | App Check enforcement is two changes: console flip plus `enforceAppCheck: true` per onCall (absent today) | Launch | README.md:533-539; foundation-rulings.md:63 | grep `enforceAppCheck` in functions/src: none | No |
| 5 | Never App-Check-enforce over `stripeWebhook` | Launch | README.md:714-716; sp5-rulings.md:134 | functions/src/paymentsWebhook.ts | No |
| 6 | Set real `GOOGLE_WEB_CLIENT_ID` | Device testing | README.md:502-505 | apps/mobile/src/auth/config.ts:5 still placeholder | Pointer only |
| 7 | Sentry projects + `NEXT_PUBLIC_SENTRY_DSN` / `EXPO_PUBLIC_SENTRY_DSN` | Launch | README.md:506-509 | README env table | Pointer only |
| 8 | EAS: `eas login` + `eas init` (projectId), Firebase Android/iOS apps, google-services.json / GoogleService-Info.plist + SHA-1, `googleServicesFile` in app.json; Apple Developer Program for store publication | Device testing | README.md:510-527; sp2-rulings.md:52-53 | apps/mobile/eas.json tracked, key-free | Partially ("dev build") |
| 9 | Verify `firebase deploy --only functions` resolves `workspace:*` for @gatekeep/shared | Launch | README.md:528-532; foundation-rulings.md:63 | functions/package.json | No |
| 10 | Confirm Email Enumeration Protection is on (dev and prod) | Launch | README.md:549-553; foundation-rulings.md:63 | n/a (console) | No |
| 11 | staging/ 24h GCS lifecycle rule on the production bucket (LAUNCH BLOCKER) | Launch blocker | README.md:554-561; sp2-rulings.md:37-39; sp5-rulings.md:138 | emulator cannot test; functions/src/profiles.ts comment | No |
| 12 | `PUBLIC_PROFILE_HOST` real domain (mobile "View public page" link hidden until then) | Launch | README.md:566-569; sp2-rulings.md:73 | apps/mobile/app/(musician)/portfolio.tsx:20-24 placeholder | No |
| 13 | `NEXT_PUBLIC_SITE_URL` (canonical/OG base) | Launch | README.md:404; sp2-rulings.md:72 | apps/web/app/layout.tsx metadataBase | No |
| 14 | `STORAGE_BUCKET` for prod functions (defaults to the dev bucket) | Launch | not in any checklist (A11) | functions/src/storage.ts:8 | No |
| 15 | `GEOCODER_PROVIDER=google` + `firebase functions:secrets:set GEOCODER_API_KEY` | Launch | README.md:573-577, :416-429; sp3-rulings.md:352-353 | functions/src/geocode.ts | No |
| 16 | Revisit 50/day geocode budget constant if needed | Optional | README.md:578-581 | functions/src/geocode.ts GEOCODE_DAILY_BUDGET | No |
| 17 | After first deploy: Cloud Scheduler job for `dailySweep` exists and next run looks right | Launch | README.md:582-586 | functions/src/scheduled.ts | No |
| 18 | After first deploy: Cloud Scheduler job for hourly `paymentsSweep` exists (money-critical); monitor `adminAlerts` | Launch | README.md:695-701; sp5-rulings.md:133 | functions/src/paymentsSweep.ts | Pointer only (Stripe checklist) |
| 19 | Confirm all 41 composite indexes + 3 field overrides build Enabled (SP3 5, SP4 16, SP5 7, SP6 11 + tickets.orderId CG, foundation invites 1, SP2 tracks 1) | Launch | README.md:587-594, :647-655, :708-713, :875-881; sp5-rulings.md:126; sp6-rulings.md:109 | firestore.indexes.json (41) | No |
| 20 | Set `LAUNCH_TIMEZONE` to the launch metro | Launch | README.md:595-600; sp3-rulings.md:57-62, :354-355 | packages/shared/src/types.ts:316 = "America/New_York" | No |
| 21 | UTC recurrence caveat (disclosure only; no fix pending) | Informational | README.md:601-608; sp3-rulings.md:42-46 | GigForms.tsx in-form copy | No |
| 22 | Run `backfillDisplayNameLower` once after deploy | Launch | README.md:609-616 | functions/src/adminTools.ts | No |
| 23 | Deploy tightened rules and run `backfillBookingVisibility` in the SAME release (CRITICAL ordering) | Launch (critical) | README.md:632-646; sp4-rulings.md:27-29 | functions/src/bookingVisibility.ts | No |
| 24 | Device pass: Hermes ICU date formatting, nested events Stack headers, native Google/Apple sign-in on a dev-client build | Device testing | README.md:617-628; sp4-rulings.md:105-108 | GigForms.tsx try/catch | Partially (mobile smoke) |
| 25 | Register `stripeWebhook` in Stripe dashboard (6 event types); `firebase functions:secrets:set STRIPE_WEBHOOK_SECRET`; separate endpoint for live | Launch | README.md:659-671; sp5-rulings.md:118-121 | functions/src/paymentsWebhook.ts | Pointer ("Stripe go-live checklist") |
| 26 | Firestore TTL policy on `stripeEvents.expireAt` | Launch | README.md:672-676; sp5-rulings.md:122-123 | functions/src/paymentsWebhook.ts stamps expireAt | Pointer |
| 27 | `firebase functions:secrets:set STRIPE_SECRET_KEY`; `APP_ORIGIN` on functions; `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` then REBUILD web | Launch | README.md:465-471, :689-694; sp5-rulings.md:124-125 | functions/src/stripeClient.ts fail-closed | Pointer |
| 28 | Re-verify `RealStripe.debitConnectedAccount` (legacy `charges.create({source})`) against current Connect docs before live | Live mode | README.md:677-683; sp5-rulings.md:129-130 | functions/src/stripeClient.ts | Pointer |
| 29 | Re-verify the 4% instant-payout retail fee vs Stripe's current cost | Live mode | README.md:684-688; sp5-rulings.md:131 | packages/shared/src/types.ts INSTANT_FEE_PCT | Pointer |
| 30 | Activate Stripe Connect (business entity), swap live keys; never live under the personal entity | Live mode | README.md:524-527, :689-694; sp5-rulings.md:132 | n/a | Pointer |
| 31 | Manual real-test-mode smoke walkthrough steps 1-8 (web) | Pre-launch | README.md:779-832; sp5-rulings.md:135-136 | n/a | Pointer |
| 32 | Apple merchant id `merchant.app.gatekeep.mobile` + Apple Pay cert; Google Pay enabled in Stripe | Device testing | README.md:720-723; sp5b-rulings.md:92-94; spec 5b :166-177 | n/a | Yes ("merchant id") |
| 33 | `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` as EAS env var (+ apps/mobile/.env locally) | Device testing | README.md:724-726; sp5b-rulings.md:94 | apps/mobile/src/payments/stripe.ts keyless mode | Yes ("EAS env key") |
| 34 | New EAS dev-client build, both platforms (Stripe native module, then phosphor/svg for 9B, then expo-camera + qrcode-svg for SP6) | Device testing | README.md:727-729, :922-925; sp5b-rulings.md:92; sp9b-rulings.md:98-100; sp6-rulings.md:104-105 | apps/mobile/package.json | Yes |
| 35 | Mobile smoke walkthrough steps 9-15 (sheets, 3DS, past-due, wallets, onboarding, payouts, true-up) | Device testing | README.md:834-867; sp5b-rulings.md:95-97 | n/a | Pointer |
| 36 | 9A signed-in web visual smoke, both themes (full coverage list) | Hard pre-launch gate | sp9a-rulings.md:65-70; HANDOFF.md:74-75 | n/a | Yes |
| 37 | Eyeball `--gk-focus` light #BF5038 and `--gk-on-destructive` white on /design | Pre-launch | sp9a-rulings.md:37, :71-72; HANDOFF.md:79 | apps/web/app/design | Yes |
| 38 | Real concert photos into apps/web/public/hero/ + heroImages.ts | Launch | README.md:735-739; sp9a-rulings.md:72; HANDOFF.md:80 | apps/web/src/marketing/heroImages.ts placeholders | Yes |
| 39 | Counsel review of /terms and /privacy placeholder text | Launch | README.md:740-743; spec 9A :168 | apps/web/app/terms, privacy | Pointer ("legal-page review") |
| 40 | Footer `CONTACT_EMAIL` hello@gatekeep.app: own it or change it | Launch | README.md:744-746; sp9a-rulings.md:76 | apps/web/src/shell/Footer.tsx:9 | No |
| 41 | 9B mobile visual smoke on the next EAS build, both themes (coverage list) | Hard mobile gate | README.md:748-777; sp9b-rulings.md:98-105; HANDOFF.md:76-78 | n/a | Yes |
| 42 | Confirm the token PaymentSheet `appearance` on the owner's build | Device testing | sp9b-rulings.md:106-107 | apps/mobile/src/payments/stripe.ts | No |
| 43 | SP6 web smoke (create/promote/tiers/publish/public page/free RSVP/PAID with real test keys/wallet QR/attendees/grace refund/cancel), both themes | Pre-launch | README.md:906-920; sp6-rulings.md:99-103 | n/a | Yes (build-status section only) |
| 44 | SP6 mobile smoke incl. DOOR SCANNER on a real camera (top on-device priority), two-account transfer, tap check-in | Pre-launch | README.md:922-936; sp6-rulings.md:104-108 | apps/mobile/src/events/ScannerScreen.tsx | Yes (build-status section only) |
| 45 | Poster upload end-to-end (small functions change, follow-up) | Post-launch | README.md:882-887; sp6-rulings.md:84-87 | functions/src/media.ts:360-367 | No |
| 46 | Content takedown two-step procedure (operator runbook, not a config) | Runbook | README.md:540-548; sp2-rulings.md:20-24 | functions/src/review.ts, profiles.ts | No |
| 47 | Seed first admins (Google accounts) via scripts/seed-admin.ts | Launch | foundation-rulings.md:63 | scripts/seed-admin.ts | No |

Items 1, 4, 5, 9-23, 40, 42, 45-47 (24 of 47) have no direct or pointer mention in HANDOFF's
owner-owed section. Items 11, 20, 23 are the three explicitly marked blocking/critical elsewhere.

---

## C. Obligations cross-reference (foundation -> sp2 -> sp3 -> sp4 -> sp5 -> sp5b -> sp6, plus 9A/9B)

Legend: DONE-annotated = resolved in code and annotated in the source doc. DONE-unannotated =
resolved in code, no annotation (stale-open). OPEN = still outstanding in code. SUPERSEDED =
replaced by a later decision.

| Source | Item | Picked up by | Code evidence | Status |
|---|---|---|---|---|
| foundation-rulings:34 | Admin name search | SP3 | functions/src/adminTools.ts searchUsersByName | DONE-unannotated |
| foundation-rulings:35 | Join-wizard in-flight guard / orphaned-draft cleanup | SP2/SP3 (draft cap, deleteProfile) | functions/src/profiles.ts | DONE-unannotated |
| foundation-rulings:36 | deleteProfile leaves orphaned pending invites | nobody | profiles.ts has no invite handling; scheduled.ts:613 step 4 expires after 14d | OPEN (mitigated) |
| foundation-rulings:36 | deleteProfile status restriction | SP2 ruling 4 | profiles.ts draft/rejected gate | DONE-unannotated (in foundation doc) |
| foundation-rulings:37 | Mobile account-screen dedup | SP2 | apps/mobile/src/shell/AccountScreen.tsx | DONE-unannotated |
| foundation-rulings:37 | requireAuth helper consolidation | SP3 | functions/src/guards.ts:13 sole definition | DONE-unannotated |
| foundation-rulings:38 | @handle vanity URL | SP2 | apps/web/next.config.ts:14-22 | DONE-unannotated |
| foundation-rulings:39 | Rejected-profile revise+resubmit UI | SP2 | dashboard/portfolio/[profileId]/page.tsx:296 | DONE-unannotated |
| foundation-rulings:40 | Mobile lint green | SP2 | apps/mobile/eslint.config.js tracked | DONE-unannotated |
| foundation-rulings:14 | Separate PROD Firebase project | owner | .firebaserc dev only | OPEN (launch) |
| sp2-rulings:49-53 | Review the deferred admin/internal list at SP3 | SP3 | see rows above | DONE-unannotated |
| sp2-rulings:52-53 | EAS production build + native App Check track | owner | no enforceAppCheck; eas.json committed only | OPEN (launch) |
| sp2-rulings:54-56 | Widen private/booking read to approved curator members | SP3 (widened) then SP4 (replaced by curatorBooking projection) | firestore.rules:90-128 | SUPERSEDED, annotated only in sp3 |
| sp2-rulings:57-58 | Curator profiles get wizard treatment | SP3 | functions/src/curator.ts, apps/*/src/curator | DONE-unannotated |
| sp2-rulings:59-61 | If suspension is added, sweep public/ | conditional | no "suspend" in code | N/A (still valid) |
| sp2-rulings:65-66 | Sub-4 three rate structures | SP4 | packages/shared BookingRates | DONE-unannotated |
| sp2-rulings:67-68 | Sub-5 settlement math per structure | SP5 | functions/src/paymentsSettlement.ts settlementMath | DONE-unannotated |
| sp2-rulings:69-71 | Shows section renders platform bookings only | SP4 | apps/web/app/u/[handle]/page.tsx:143-149 | DONE (sp4-rulings:167-169 says discharged; sp2 not annotated) |
| sp2-rulings:72-74 | NEXT_PUBLIC_SITE_URL, PUBLIC_PROFILE_HOST | owner | placeholders remain | OPEN (launch) |
| sp2 ruling 6 / README:959-963 | TrimUploader native streaming, lift 25MB cap | nobody | TrimUploader.tsx:27 still 25MB, fetch().blob() | OPEN |
| sp2 ruling 8 | staging/ lifecycle + processing reaper | reaper DONE (SP3, README:562 annotated); lifecycle OPEN | scheduled.ts:586 | Half done, annotated |
| sp3-rulings:240-251 | resumeSeries approval-gate + pausedBy | SP4 declined, SP5 declined, then silence | grep empty | OPEN (tripwire, A7) |
| sp3-rulings:252-255 | curatorAccessRetries awareness | SP4 | members.ts:202-213, scheduled.ts:638 | DONE (implicitly) |
| sp3-rulings:256-268 | M-13 product decision | SP4 | firestore.rules curatorBooking | DONE-annotated |
| sp3-rulings:269-275 | M-12 booking-read tightening | SP4 | firestore.rules:90 | DONE-annotated |
| sp3-rulings:276-279 | Geocoder secret on new onCalls | SP4+ (no new geocoding callables) | events.ts does not geocode | N/A |
| sp3-rulings:280-288 | private/location read to booked musician | SP4 | firestore.rules:169-181 | DONE-annotated |
| sp3-rulings:289-291 | filled gig status | SP4 | GIG_STATUSES | DONE-unannotated |
| sp3-rulings:292-294 | Consume fillMode | SP4 | bookings.ts whole-run | DONE-unannotated |
| sp3-rulings:295-297 | Invite-UI client surface | nobody | no invite lifecycle UI beyond sub-1 | OPEN (low) |
| sp3-rulings:298-300 | Per-venue timezone schema | nobody | LAUNCH_TIMEZONE constant only | OPEN |
| sp3-rulings:301-302 | Calendar-monthly recurrence | nobody | scheduled.ts +28d | OPEN |
| sp3-rulings:303-311 | Name-search UX + backfill hardening | nobody | adminTools.ts batch.update | OPEN (low) |
| sp3-rulings:312-315 | processPhoto 3-read optimization | nobody | media.ts | OPEN (low) |
| sp3-rulings:316-346 | Task 3/5/6/7 minors, status-palette duplication | nobody | various | OPEN (low) |
| sp3-rulings:378-399 | Six post-gate follow-ups | SP4 Task 13 | see A15 | DONE-unannotated (5 of 6), syncCuratorAccess partial |
| sp4-rulings:112-128 | Deposit money movement | SP5 | paymentsCore.ts | DONE-annotated |
| sp4-rulings:129-142 | Settlement math | SP5 | paymentsSettlement.ts | DONE-annotated |
| sp4-rulings:143-146 | selfDeal settlement | SP5 | sp5 decision 5 | DONE-annotated |
| sp4-rulings:147-153 | resumeSeries | none | grep empty | OPEN (annotated STILL OPEN through SP5 only) |
| sp4-rulings:154-161 | inviteMember/respondToInvite guards | SP5 Task 3 | members.ts | DONE-annotated |
| sp4-rulings:162-166 | Scale follow-ups (materializer race, step-6 getAll, helper dedup, inbox pagination) | nobody | scheduled.ts:674 per-doc get(); test helpers still duplicated | OPEN (recorded in README:270-287) |
| sp4-rulings:167-168 | Sub-6 builds on bookings / Shows live | SP6 | events.ts verifyLineupBookingActs (confirmed) | DONE (wording drift, A29) |
| sp4-rulings:169-173 | Sub-8 directories placeholder, musicians-page gate, unused index | SP8 (future) | index still present | OPEN (owned by 8) |
| sp5-rulings:143-144 | sub-5b native sheets | SP5b | apps/mobile/src/payments | DONE-unannotated |
| sp5-rulings:145-147 | sub-5c band splits | deferred | paymentsPayouts.ts:198 marker | OPEN (deferred, in HANDOFF:39) |
| sp5-rulings:152-153 | getStripeStatus TTL cache (M7), revokeAdmin/checkRevoked (L9) | nobody | grep empty | OPEN |
| sp5-rulings:154-155 | sub-6 events, sub-8 search | SP6 done; SP8 future | events.ts | Half |
| sp5b-rulings:66-69 | Mobile startsSoonFlash port | nobody (9B and SP6 both touched mobile booking UI) | web only BookingThread.tsx:404 | OPEN |
| sp5b-rulings:70-71 | TrueUpForm "3.5" rounding | nobody | both TrueUpForm.tsx | OPEN |
| sp5b-rulings:72-73 | runSheet "Canceled" literal on SDK bump | conditional | stripe.ts:73, SDK 0.64.0 unchanged | N/A (still valid) |
| sp5b-rulings:74-75 | feePreviews fractional-cents test | nobody | 4 tests | OPEN (low) |
| sp5b ruling 4 | Android openBrowserAsync asymmetry must be handled by any future in-app-browser flow | SP6 (no in-app browser added) | n/a | Tripwire, not in HANDOFF |
| sp9a-rulings:56-57 | 9B must recolonize mobile money sentences | 9B | sp9b ruling 7 | DONE-annotated (in 9B) |
| sp9a-rulings:58-59 | Fan surfaces are a 9B concern | 9B then SP6 | (fan)/* screens | DONE |
| sp9a-rulings:60-61 | Seed-script em dashes, fix post-merge | nobody | seed-test-accounts.ts 10 remain | OPEN (A13) |
| sp9a-rulings:65-70 | Owner web visual smoke | owner | n/a | OPEN (HANDOFF yes) |
| sp9a-rulings:71-72 | Eyeball queue, hero photos | owner | placeholders remain | OPEN (HANDOFF yes) |
| sp9a-rulings:73-76 | Riding minors | nobody | "Forfeited deposit:" still shipped; Footer.tsx:9 | OPEN (low) |
| sp9b-rulings:98-105 | Owner mobile visual smoke on next EAS build | owner | n/a | OPEN (HANDOFF yes) |
| sp9b-rulings:106-107 | PaymentSheet appearance on owner's build | owner | n/a | OPEN (not in HANDOFF) |
| sp9b-rulings:108-109 | emu:test/rules not re-run at 9B merge | SP6 re-ran (704/103) | verified this session | DONE (moot) |
| sp9b-rulings:110-112 | events/index series badge neutral | nobody | events/index.tsx:504 | OPEN (low) |
| sp6-rulings:84-87 | Poster upload end to end | nobody | media.ts:360-367 | OPEN |
| sp6-rulings:88-89 | Gig re-promotion server check | nobody | client-side only | OPEN (low) |
| sp6-rulings:90-94 | /tickets pagination, duplicate listeners, order TTL, races, re-notify on reschedule | nobody | as described | OPEN (accepted) |
| sp6-rulings:99-110 | Owner smoke (paid ticket, EAS build, scanner, transfer, indexes) | owner | n/a | OPEN (HANDOFF build-status only) |

Marked resolved but not supported by code: none found. Every RESOLVED annotation (sp3 rulings
23/24 and the three sp3 obligation bullets; sp4 rulings 11 and the four sp4 obligation bullets)
matches code.

---

## D. Em-dash census

Method: `grep -o $'\xe2\x80\x94' | wc -l` (U+2014 only; en dashes and middots are excluded and are
sanctioned as range/separator glyphs per sp6-rulings.md:97 and sp9b-rulings.md:90-91).

### Docs (1,608 glyphs)

| File | Count | Self-claim |
|---|---|---|
| README.md | 141 | sp9b-rulings.md:93-94 acknowledges pre-existing em dashes outside the 9B section |
| DESIGN.md | 1 | The rule itself quotes the glyph at :14; otherwise clean, and :14-15 forbids em dashes "in documentation" |
| CLAUDE.md | 0 | |
| docs/superpowers/HANDOFF.md | 0 | states the rule at :46 |
| foundation-rulings.md | 23 | predates rule |
| sp2-rulings.md | 12 | predates rule |
| sp3-rulings.md | 111 | predates rule |
| sp4-rulings.md | 32 | predates rule |
| sp5-rulings.md | 20 | predates rule |
| sp5b-rulings.md | 16 | predates rule |
| sp6-rulings.md | 0 | claims clean at :6 (true) |
| sp9a-rulings.md | 0 | claims clean at :5 (true) |
| sp9b-rulings.md | 0 | claims clean at :6 (true for itself; false for "all 9B output", A14) |
| specs: foundation 16, musician-portfolio 26, booking-flow 27, curator-gigs 15, payments 39, mobile-payments 28, web-uiux 0, mobile-uiux 22, events-ticketing 0 | 173 | mobile-uiux violates its own :9 |
| plans: foundation 66, musician-portfolio 524, booking-flow 119, curator-gigs 56, payments 203, mobile-payments 77, web-uiux 0, mobile-uiux 34, events-ticketing 0 | 1,079 | mobile-uiux violates its own :18 |

### Code (1,534 glyphs, excluding tests and build output)

functions/src ~1,300 (paymentsSettlement.ts 206, bookingLifecycle.ts 167, bookings.ts 130,
paymentsSweep.ts 105, scheduled.ts 98, paymentsCore.ts 94, payments.ts 90, stripeClient.ts 61,
paymentsPayouts.ts 42, profiles.ts 36, media.ts 34, gigs.ts 34, paymentsWebhook.ts 32,
gigSeries.ts 30, tracks.ts 29, review.ts 19, curator.ts 18, members.ts 17, bookingVisibility.ts
16, portfolio.ts 9, geocode.ts 7, authTriggers/adminTools/account.ts 6 each, storage/guards.ts
3 each); packages/shared/src 146 (types.ts 73, messages.ts 28, validation.ts 16,
paymentDisplay.ts 11, money.ts 9, feePreviews.ts 7, storagePaths.ts 2); firestore.rules 30;
storage.rules 8; scripts/seed-test-accounts.ts 10; apps/web/src + app 10 (stripeLoader.ts 3,
delinquentBookings.ts 2, firebase-server.ts 2, onboardingRedirect.ts 1, firebase.ts 1,
instrumentation-client.ts 1); apps/mobile 0 (sp9b-rulings.md:17 claim verified). Of the code
total, roughly 215 are inside string literals (user-facing or HttpsError copy): messages.ts 17,
paymentsSettlement.ts 52, paymentsSweep.ts 28, bookingLifecycle.ts 17, bookings.ts 17,
payments.ts 16, paymentsPayouts.ts 9, tracks.ts 6, account/paymentsCore/profiles 4 each, and
smaller counts elsewhere. Tests carry a further 675 (comments and assertion strings).

### Contradiction and recommended policy

DESIGN.md:14-15 and HANDOFF.md:46 state an absolute rule covering documentation and code
strings; 1,608 doc glyphs and ~215 shipped copy strings violate it, all written before the rule
was adopted at 9A (sp9a-rulings.md:5). Two coherent options:

1. **Grandfather, with a dated line.** Add to HANDOFF and DESIGN.md: "Rule adopted 2026-08-28
   (9A). Files written before that date (README pre-9B sections, foundation/sp2-sp5b rulings,
   the first six specs and plans, functions/src and packages/shared comments) are grandfathered;
   any line you touch must be converted; no new em dash anywhere." Cost: zero now; the
   contradiction stays visible and any grep-based enforcement must exclude those paths.
2. **Sweep.** A mechanical replacement is safe for comments and docs (1,608 doc + ~1,320
   comment glyphs) but every replacement in a string literal changes user-visible copy and
   the tests that assert it, and any doc quote of that copy. Quantified: ~215 literal glyphs
   across ~13 files, plus ~30 test assertions and ~6 README quotes (README:802, :829, :848-849
   and the sp5b-rulings.md:96 walkthrough summary). The sweep is one PR with gates typecheck,
   shared 158, emu:test 704, emu:rules 103 unchanged in count.

Recommendation: do option 2 for **shipped copy** (messages.ts, functions HttpsError strings,
scripts) before SP7 because that is the part users see and the part a new session will
imitate, and option 1 (grandfather with a dated line) for the six pre-9A rulings docs, the
first six specs, and the plans, which are historical records. README gets a targeted sweep
because it is a living doc. Then add a CI or pre-commit grep restricted to: README.md,
DESIGN.md, HANDOFF.md, docs/superpowers/sp6*/sp9*/future rulings, specs and plans dated
2026-08-28 or later, packages/shared/src, apps/**, scripts/**, and string literals in
functions/src.

---

## E. Spec out-of-scope table

| Spec | Declared out of scope / later | Picked up by | Status |
|---|---|---|---|
| Foundation :168-170 | Portfolio/venue wizards (2-3) | SP2, SP3 | Done |
| Foundation | Matching/booking/messaging (4) | SP4 (booking, terms-only threads) | Booking done; **messaging unowned** (sp4 spec :14 "unscheduled") |
| Foundation | Payments (5) | SP5, SP5b | Done; 5c deferred |
| Foundation | Events/ticketing (6) | SP6 | Done |
| Foundation | Fan discovery (7): search, follow artists, performance notifications | SP7 (next); search moved to SP8 by sp4 spec :14 | Open; ownership of search split |
| Foundation | Advertising, subscriptions, 2FA, SMS, sign-in method linking, moderation beyond approvals | none | Unscheduled (2FA compensated by Google-only admins, foundation ruling 6) |
| Foundation ruling 3 | Expo web target | none | Still broken (README:123-125) |
| SP2 :11-14 | Admin/internal deferred list (name search, orphaned-invite cleanup, deleteProfile restriction, account-screen dedup, requireAuth consolidation) | SP3 (all but orphaned invites) | Done except orphaned invites (A16) |
| SP2 | EAS production build + native App Check | owner launch track | Open (B8, B3-4) |
| SP2 | Video hosting (YouTube links) | none | Unscheduled, by design |
| SP2 | Messaging, booking, payments, events (4-6) | SP4/5/6 | Done except messaging |
| SP3 :15, :82-84 | Musician browse/apply, talent search (4) | SP4 (placeholder directories) then SP8 | Placeholder shipped; internals owed to 8 |
| SP3 | Booking states + address reveal (4) | SP4 | Done (firestore.rules:169-181) |
| SP3 | Payments (5) | SP5 | Done |
| SP3 | Upcoming Events wiring (6) | SP6 | Done (venue/artist pages) |
| SP3 | Fan-facing map UI (sub-7) | contested: sp4 spec says 7 and 8; 9A spec says 8 | **Fuzzy (A6)** |
| SP3 | Advertising use of interest flag; phone/IP anti-abuse | none | Unscheduled |
| SP3 | Per-venue timezone, calendar-monthly recurrence, resumeSeries (rulings) | none | Open (C) |
| SP4 :14 | Payment processing (5) | SP5 | Done |
| SP4 | Events/ticketing (6) | SP6 | Done |
| SP4 | Fan map UI (sub-7) | see SP3 row | Fuzzy |
| SP4 | Full search: text, ranking, maps, saved searches/alerts, directory internals (sub-8, NEW) | SP8 | Open |
| SP4 | General messaging/chat | none | **Unscheduled, unowned** |
| SP4 | resumeSeries | none | Open tripwire (A7) |
| SP5 :271-277 | Mobile read-only; native sheets (5b) | SP5b | Done |
| SP5 :295-301 | Disputes/chargebacks, tax/1099, statements/exports, multi-currency, live-mode activation, platform payout accounting | none (live-mode is an owner launch item) | Unscheduled |
| SP5 (rulings) | 5c band payout splits | deferred | Open, in HANDOFF:39 |
| SP5b :160-165 | 5c splits, disputes, statements, multi-currency, live mode, non-payments mobile UI | 9B (mobile UI) | Mobile UI done; rest unscheduled |
| SP5b :166-177 | Operator checklist (merchant id, Google Pay, EXPO key, EAS build, APP_ORIGIN) | owner | Open (B32-35) |
| 9A :164-168 | Map view (sub-8), ticket UI (sub-6), venue filter chips (sub-8), mobile (9B), backend changes, real legal text | SP6 (ticket UI), 9B (mobile) | Ticket UI and mobile done; map/chips owed to 8; legal text owner (B39) |
| 9B :194-200 | Behavior/navigation/fetch changes; functions/shared changes; theming library; live device verification | SP6 added the fan behavior; owner does device smoke | Open: device smoke (B41) |
| 9B :12-26 | 9A eyeball queue stays web | owner | Open (B37-38) |
| SP6 :157-164 | Guest checkout, fan self-serve refunds, seat maps, promo codes, ticket emails/PDFs, offline scan queue, resale marketplace, per-musician ticket splits (5c) | none | Unscheduled |
| SP6 | Event discovery feeds and search (sub-7/sub-8) | SP7/SP8 | **Fuzzy: which of 7 or 8 owns the event feed** |
| SP6 rulings :84-97 | Poster upload, gig re-promotion server check, /tickets pagination, order TTL, reschedule re-notify | none | Open |

SP7/SP8 ownership summary for the upcoming brainstorm: SP7 has an uncontested claim on
"follow artists" and "performance notifications" (foundation only) and a shared claim with SP8
on fan search, the map, and event discovery feeds. Messaging has no claim at all. The venue
filter chips are SP8 (9A spec). Recommend HANDOFF states the split in one line before the SP7
brainstorm starts.

---

## Repo hygiene summary (check 6)

| Item | State | Evidence |
|---|---|---|
| firebase-debug.log, firestore-debug.log at root | Ignored | .gitignore:4 `*.log`; `git check-ignore -v` confirms |
| .superpowers/ | Ignored; only brainstorm/ exists locally; sdd/ pointers dangle (A18) | .gitignore:8 |
| .worktrees/ | Ignored; directory no longer exists | .gitignore:9 |
| .claude/ | Untracked, NOT ignored (A19) | `git status`: `?? .claude/` |
| apps/web/components.json | Tracked, consistent with DESIGN.md:57 | `git ls-files` |
| apps/mobile/eas.json | Tracked, key-free, consistent with README:514 | `git ls-files` |
| .env files | None tracked; `.env*` ignored | .gitignore:3 |
| apps/web/AGENTS.md | Tracked, auto-regenerated by `next dev` (A28) | file header |
| scripts/ | 3 scripts; undocumented in README (A12) | `ls scripts` |
| functions/dist, packages/shared/dist, .next, .expo | Ignored | .gitignore:2,6,7 |
