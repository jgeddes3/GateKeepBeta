> **Historical execution record.** This plan was executed and reviewed task by task; its snippets may predate the review fixes that shipped.
> Where the plan and the code disagree, the code and this sub-project's rulings doc win (`docs/superpowers/HANDOFF.md` lists them).

# Sub-project 10, Branch B: Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every money, lifecycle, and product defect the 2026-09-01 audit marked as a blocker or fix-now, so the platform is safe to take live and sub-project 7 rebases onto a stable base.

**Architecture:** One worktree branch `worktree-sp10-hardening` off `main` after Branch A (the sweep) has merged. Money first (transfer sourcing, dual webhook secrets, disputes, races, claims), then lifecycle (events follow the profile, admin takedown, deletion refusals, Auth onDelete, push tokens), then server-side product fixes, then client-side product fixes, then docs, security audit, and merge. Every server change is additive beside the functions sub-project 7 hooks into; FakeStripe learns each live Stripe rule so the emulator suite can fail where production would.

**Tech Stack:** Firebase (Firestore, Functions on Node 22, emulator suite with Java 21), Stripe platform charges and Connect transfers, Next.js 16 (App Router, RSC discipline), Expo SDK 57 (expo-notifications, expo-image-picker), `@gatekeep/shared` types and message constants, vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-hardening-design.md` (the binding authority; conflicts resolve against it). Audit evidence: `docs/superpowers/audit-2026-09-01.md` and `docs/superpowers/audit/*.md`.

## Global Constraints

- **No em dashes anywhere**: code, comments, copy, docs, commit messages. Branch A added a CI step that fails the build on U+2014; tests that need the character use the `"\u2014"` escape.
- Branch B starts from `main` AFTER Branch A merged: Node 22 runtime, repaired index overrides, `.claude/` ignored, CI present. Verify with `git log --oneline -1` showing the Branch A merge before creating the worktree.
- `DESIGN.md` is binding on every client change; antislop, antislop-ui, antislop-copywriting bind UI and copy. Icons: Phosphor duotone ONLY via `apps/web/src/ui/icons.tsx` and `apps/mobile/src/ui/icons.tsx`. Tokens only, no hex. Every data-bearing surface you touch keeps loading, empty, and error states. New tap targets are 44px.
- **Owner-ruled policies (spec section 2), binding:** unpublish cancels and refunds published future events automatically; disputes record, alert, gate, and reverse on loss; deletion refuses with a named blocker and never unwinds money.
- **Sub-project 7 coexistence:** never rewrite `publishEvent`, `updateEvent`, `setEventTiers`, or `reviewTrack` bodies; add beside them. SP7's spec is `docs/superpowers/specs/2026-09-02-fan-discovery-design.md`; nothing in this plan touches its surfaces (Discover, follows, posts).
- No client-supplied amount ever reaches Stripe. Stripe calls never run inside Firestore transactions. Every function that can reach `getStripe()` declares `secrets: [stripeSecretKey]`; the webhook also declares both webhook secrets. `functions/test/stripeSecrets.test.ts` pins the set and must be updated whenever a handler is added.
- Every user-facing string clients branch on lives in `packages/shared/src/messages.ts` and is compared with `===`.
- Firestore stays default-deny; every shipped client query is rules-provable with equality pins; every new rules block gets a test in `tests-rules/`.
- Web RSC boundary rule: server files never import VALUES from `"use client"` modules. Verify every changed web route with a live page load, not only the build.
- Emulator suites: Java on PATH (`C:\Users\LeoArkos\.jre\jdk-21.0.12.1+1-jre\bin` on the dev box), `FUNCTIONS_DISCOVERY_TIMEOUT=60`, one blocking foreground call with a 600000 ms timeout, never backgrounded. `pnpm emu:test` from the repo root runs everything (about 10 minutes); there is no single-file emulator script, so run the whole suite at each task's gate.
- Byte-safe tools only on Windows (PowerShell 5.1 corrupts UTF-8 pipelines): Node scripts or Git Bash for file rewrites.
- Gates at the end and per task where named: `pnpm typecheck` 5/5, shared tests (164 after Task 1, strictly higher after), `pnpm emu:test` (strictly above 704), `pnpm emu:rules` (strictly above 103), web lint 0 errors plus `pnpm --filter @gatekeep/web build`, mobile lint 0 errors plus `pnpm --filter @gatekeep/mobile exec expo export --platform ios`.
- Commit messages end with the session attribution lines the harness prescribes.

## How to read line numbers and overlapping edits

Every `Files:` block cites line ranges from `main` at the start of Branch B. Later tasks edit files earlier tasks already changed; their snippets show only their own delta. When a cited range no longer matches, locate the edit by the quoted code, never by the number. Files touched by more than one task, in task order:

- `functions/src/paymentsSweep.ts`: Tasks 8 (order-expiry deferred branch), 9 (settleOneEvent claim and transfer region), 10 (settleOneEvent signature and approval check, settleTicketRevenue), 21 (`runTicketOrderExpiry` wrapper and the 5-minute scheduler around the step Task 8 changed), 24 (scheduler options).
- `functions/src/stripeClient.ts`: Tasks 3 (FakeStripe source cap), 4 (Connect secret and dual verification), 5 (`retrieveIntent`), 6 (partial `reverseTransfer`), 21 (`receiptEmail` on `createIntent`).
- `functions/src/paymentsWebhook.ts`: Tasks 4, 5, 6, 7 (registry, dispatch, handlers).
- `functions/src/ticketing.ts`: Tasks 10 (approval gate in `createTicketOrder`), 20 (`undoCheckIn`, early gate), 21 (`cancelTicketOrder`, pending cap, `releasePendingOrder`, receipt email).
- `functions/src/events.ts`: Tasks 10 (`cancelAndRefundEventForModeration`, `EventCascadeRetryDoc`), 11 (`takedownEvent` lives in `functions/src/eventsAdmin.ts` but imports from here), 21 (promotion uniqueness in `createEvent`).
- `functions/src/scheduled.ts`: Tasks 10 (step 9), 19 (step 3 poster reap), 20 (reminder copy), 22 (step 6 skip and curator notify, `fillMode` in step 1), 23 (step 1 auto-end and end-date edge), 24 (scheduler options).
- `functions/src/profiles.ts`: Tasks 12 (money gate), 16 (invite revoke, submit guards, draft cap, cooldown).
- `functions/src/account.ts`: Tasks 13 (refusals, audit), 14 (`cascadeDeleteUser` extraction).
- `functions/src/notifications.ts`: Tasks 15 (token order and pruning), 29 (push `data` payload).
- `functions/src/index.ts`: every task that adds a callable, trigger, or scheduler exports it (Tasks 11, 14, 20, 21).
- `packages/shared/src/types.ts` and `messages.ts`: Task 1 owns the shared block; Task 21 adds `"cancelled"` to `TicketOrderStatus` and Task 18 makes `CuratorBookingDoc.preferences` nullable, both noted in those tasks.
- `apps/web/app/admin/page.tsx`: Tasks 9 (alert-kind labels), 11 (Events block), 27 (`getIdTokenResult(true)`).
- `apps/web/app/dashboard/page.tsx` and `apps/mobile/src/shell/AccountScreen.tsx`: Tasks 13 (deletion refusal copy), 27 (banner mount), 29 (inbox hrefs).
- `apps/mobile/app/_layout.tsx`: Tasks 27 (banner mount) and 29 (notification handler, channel, response listener).
- `tests-rules/`: Task 2 creates `hardening.rules.test.ts`; later rules tasks (none) would append there.

Names introduced by individual tasks beyond the Task 1 shared block, so cross-task readers know where they come from: `StripeLike.retrieveIntent`, `reverseTransfer` `amountCents` option, `WebhookScope`, `VerifiedWebhookEvent` (Task 4); `functions/src/paymentsDisputes.ts` with `disputeCreated`, `disputeClosed`, `chargeRefunded` handlers, `disputeAlertId`, `disputeReversalAlertId`, `externalRefundAlertId` (Tasks 5, 6); `ticketOrderStuckAlertId`, `SweepReport.ticketOrdersReconciled`, `ticketOrdersStuck` (Task 8); `ORGANIZER_INACTIVE_REASON`, `ModerationActor`, `ModerationCancelResult`, `EventCascadeRetryDoc`, `drainEventCascadeRetries` (Task 10); `functions/src/eventsAdmin.ts`, `EventsTakedown`, `loadEventCounts` (Task 11); `loadPushTokenIds`, `deadTokenIdsFromExpoResponse`, `unregisterPush` (Task 15); `EMPTY_BOOKING_RATES` (Task 18); `GOOGLE_GEOCODE_TIMEOUT_MS` (Task 17); `formatEventReminder` (Task 20); `releasePendingOrder`, `runTicketOrderExpiry`, `TicketOrderExpiryReport` (Task 21); `SweepReport.posterUploadsReaped`, `seriesEnded` (Tasks 19, 23); `scripts/projectId.ts` (Task 24); on the clients `callFn`, `isStaleVerificationError` (`lib/callable.ts`), `NULL_RATES`, `DEPOSIT_HONESTY_RUN_LINE`, `posterPublicUrl`, `PosterField`, `ensureAndroidChannel`, `pushHref`, `useCounterparty`, `useCounterpartyReliability`, `CounterpartyLine`, `useOpenRunDates`, `endDateInputToLaunchTzEndMs`, `launchTzDateInput`, `TogglePill`, `BookedActLine`, `BookedActCard` (Tasks 25 to 32). The poster pointer document path is `posterUploads/{uid}/uploads/{nonce}` everywhere (four segments; the spec's shorthand `posterUploads/{uid}/{nonce}` is not a valid Firestore document path).

A second composite index beyond the spec's list, `payments (musicianProfileId, deposit.status)` collection group, is added by Task 12 for the musician-side deposit clause of the deletion gate.

---

## File map (who owns what)

- Task 1: `packages/shared/src/{types,messages,notificationHref,index}.ts` and their tests.
- Task 2: `firestore.rules`, `tests-rules/hardening.rules.test.ts`.
- Tasks 3 to 9 (money): `functions/src/{paymentsSettlement,stripeClient,paymentsWebhook,paymentsDisputes,paymentsSweep,paymentsCore,bookings,eventsCore}.ts`, `apps/web/app/admin/page.tsx` (alert labels), tests `functions/test/{paymentsSettlement,stripeClient,stripeSecrets,paymentsWebhook,paymentsDisputes,paymentsSweep,eventsSettlement}.test.ts`.
- Tasks 10 to 16 (lifecycle): `functions/src/{review,events,eventsAdmin,ticketing,paymentsSweep,scheduled,profiles,account,authTriggers,members,notifications,index}.ts`, `firestore.indexes.json`, `apps/web/app/admin/page.tsx` (Events block), the four profile pages and both account screens (refusal copy), `apps/mobile/src/notifications/push.ts`, both `AuthProvider.tsx`, tests `functions/test/{eventCascade,review,profiles,account,members,notifications,authTriggers}.test.ts`.
- Tasks 17 to 24 (server product): `functions/src/{geocode,bookingLifecycle,bookingVisibility,media,ticketing,events,paymentsSweep,scheduled,bookings,gigs,gigSeries,stripeClient,paymentsWebhook}.ts`, `scripts/*.ts`, both apps' `src/lib/firebase*.ts`, `.env.example` files, tests in the matching `functions/test/*.test.ts` plus `functionOptions.test.ts`.
- Tasks 25 to 32 (client product): `apps/web/src/{bookings,portfolio,auth,events,lib,components}/**`, `apps/web/app/{sign-in,admin,dashboard,tickets,e,gigs}/**`, `apps/mobile/src/{bookings,portfolio,auth,events,tickets,notifications,shell,lib,ui}/**`, `apps/mobile/app/**`.
- Tasks 33 to 35 (docs, audit, merge): `README.md`, `docs/superpowers/HANDOFF.md`, `docs/superpowers/{foundation,sp2,sp3,sp10}-rulings.md`, `docs/superpowers/plans/*.md` banners.

---

### Task 0: Worktree

- [ ] **Step 1: Confirm Branch A has merged, then create the worktree**

```bash
cd /c/Users/LeoArkos/GateKeepBeta
git log --oneline -3 | grep -i "branch A" || echo "STOP: Branch A (the sweep) has not merged yet"
git worktree add -b worktree-sp10-hardening .worktrees/sp10-hardening main
cd .worktrees/sp10-hardening
pnpm install
pnpm --filter @gatekeep/web exec next typegen
```

- [ ] **Step 2: Record the baseline counts** (typecheck 5/5, shared 158, `emu:rules` 103, `emu:test` 704; the commands are in Branch A's plan Task 0 Step 2). Every later gate must be strictly higher on the three test counts.

---

### Task 1: Shared foundations (types, messages, constants, notification href)

**Files:**
- Modify: `packages/shared/src/types.ts` (UserDoc :7-20, AuditLogDoc :72-83, NotificationDoc :85-96, GigDoc :255-270, DepositState :546-560, AdminAlertKind :740-828, LedgerKind :853-885, LedgerEntry :886-897, EventDoc :904-935, TicketOrderDoc :946-960), `packages/shared/src/messages.ts` (append after `TICKET_REFUND_WINDOW_CLOSED_MESSAGE`), `packages/shared/src/index.ts` (add the new module export).
- Create: `packages/shared/src/notificationHref.ts`.
- Test: `packages/shared/test/notificationHref.test.ts` (new), `packages/shared/test/messages.test.ts` (new).

**Interfaces (Produces, consumed by every later task):**

```ts
// messages.ts additions (exact strings; clients === on them)
export const EMAIL_NOT_VERIFIED_MESSAGE = "Please verify your email address first.";
export const DELETE_PROFILE_BALANCE_MESSAGE = "This profile still has a Stripe balance. Pay it out before deleting.";
export const DELETE_PROFILE_DELINQUENT_MESSAGE = "This profile has an overdue payment. Settle it before deleting.";
export const DELETE_PROFILE_PAYMENTS_MESSAGE = "This profile has bookings with money still moving. Wait for them to settle before deleting.";
export const DELETE_PROFILE_EVENTS_MESSAGE = "This profile has a published or unsettled event. Cancel or settle it before deleting.";
export const DELETE_ACCOUNT_TICKETS_MESSAGE = "You hold tickets to an upcoming event. Transfer them or wait until the event ends before deleting your account.";
export const DELETE_ACCOUNT_TRANSFERS_MESSAGE = "You have a ticket transfer in progress. Resolve it before deleting your account.";
export const DELETE_ACCOUNT_ORDERS_MESSAGE = "You have a ticket order in progress. Let it finish or cancel it before deleting your account.";
export const CHECK_IN_TOO_EARLY_MESSAGE = "Check-in opens 12 hours before the event starts.";
export const GIG_ALREADY_PROMOTED_MESSAGE = "This gig already has an event.";
export const PENDING_ORDERS_CAP_MESSAGE = "You have too many ticket orders in progress. Finish or cancel one first.";
export const THREAD_FULL_MESSAGE = "Thread is full: accept, decline or withdraw.";
export const SCANNER_OFFLINE_MESSAGE = "Couldn't reach GateKeep. Try again.";
export const SALES_FINAL_LINE = "All sales are final unless the event is cancelled or the organizer refunds you. Service fee included in the total.";
```

```ts
// types.ts additions
export const CHECK_IN_OPENS_BEFORE_MS = 12 * 3600 * 1000;
export const PENDING_ORDERS_PER_USER_CAP = 3;
export const SETTLEMENT_CLAIM_STALE_MS = 24 * 3600 * 1000;
export const WEBHOOK_SYNC_OWNER_WINDOW_MS = 15 * 60 * 1000;
export const TICKET_ORDER_STUCK_AFTER_MS = 2 * 3600 * 1000;
export const POSTER_UPLOAD_TTL_MS = 24 * 3600 * 1000;
export type NotificationKind = NotificationDoc["kind"];
export interface DisputeRecord {
  chargeId: string; intentId: string;
  purpose: "deposit" | "settlement" | "paydue" | "paydue_deposit" | "tickets";
  bookingId?: string; gigId?: string; orderId?: string;
  curatorProfileId: string | null;      // null for a ticket order (the fan paid)
  amountCents: number; feeCents: number; reason: string;
  status: "open" | "won" | "lost";
  reversalTransferId?: string;
  openedAt: number; closedAt?: number;
}
export interface PosterUploadDoc { path: string; createdAt: number; }
```

(`EventCascadeRetryDoc` is declared by Task 10 in `functions/src/events.ts`, not here: it is server-internal.)

Field additions to existing interfaces (all optional, so every existing write site keeps compiling):
`UserDoc.lastProfileRejectedAt?: number`; `DepositState.chargeAmountCents?: number`;
`LedgerEntry.sourced?: boolean`; `EventDoc.settlementClaimedAt?: number`;
`TicketOrderDoc.disputeId?: string; disputeStatus?: "open" | "won" | "lost"`;
`GigDoc.fillMode?: "whole_run" | "per_occurrence" | null`.
Union additions: `LedgerKind` gains `"dispute_opened" | "dispute_lost" | "dispute_won" | "external_refund"`;
`AdminAlertKind` gains `"dispute_opened" | "dispute_reversal_failed" | "external_refund" | "ticket_order_stuck"`;
`AuditLogDoc.action` gains `"event_taken_down" | "account_deleted" | "profile_deleted_stripe_ids"`.

```ts
// notificationHref.ts (new; both inbox renderers and the mobile push tap handler call this)
import type { NotificationKind } from "./types.js";
export type NotificationPlatform = "web" | "mobile";
export function notificationHref(kind: NotificationKind, refId: string | null | undefined, platform: NotificationPlatform): string | null {
  if (kind === "booking") return refId ? (platform === "web" ? `/dashboard/bookings/${refId}` : `/booking/${refId}`) : null;
  if (kind === "ticket") return platform === "web" ? "/tickets" : "/(fan)/tickets";
  return null;
}
```

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/notificationHref.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { notificationHref } from "../src/index.js";

describe("notificationHref", () => {
  it("routes booking rows to the thread on each platform", () => {
    expect(notificationHref("booking", "b1", "web")).toBe("/dashboard/bookings/b1");
    expect(notificationHref("booking", "b1", "mobile")).toBe("/booking/b1");
  });
  it("routes ticket rows to the wallet regardless of refId", () => {
    expect(notificationHref("ticket", "e1", "web")).toBe("/tickets");
    expect(notificationHref("ticket", null, "mobile")).toBe("/(fan)/tickets");
  });
  it("returns null for kinds with no destination and for booking rows without a refId", () => {
    expect(notificationHref("system", null, "web")).toBeNull();
    expect(notificationHref("booking", undefined, "mobile")).toBeNull();
  });
});
```

`packages/shared/test/messages.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as shared from "../src/index.js";

describe("shared message constants", () => {
  it("every exported *_MESSAGE and *_LINE string is em-dash free", () => {
    const offenders = Object.entries(shared)
      .filter(([k, v]) => typeof v === "string" && /_(MESSAGE|LINE)$/.test(k) && v.includes("\u2014"))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });
  it("exports the sub-project 10 constants", () => {
    expect(shared.THREAD_FULL_MESSAGE).toBe("Thread is full: accept, decline or withdraw.");
    expect(shared.CHECK_IN_OPENS_BEFORE_MS).toBe(43_200_000);
    expect(shared.PENDING_ORDERS_PER_USER_CAP).toBe(3);
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `pnpm --filter @gatekeep/shared test -- notificationHref messages`
Expected: FAIL, `notificationHref` is not exported and `THREAD_FULL_MESSAGE` is undefined.

- [ ] **Step 3: Add the constants, types, and the href module exactly as listed in Interfaces**

Append the message block to `packages/shared/src/messages.ts` under a `// ---------- Sub-project 10 hardening ----------` header. In `types.ts`, add the six numeric constants and `NotificationKind` after the `NotificationDoc` interface, `DisputeRecord` and `PosterUploadDoc` after `LedgerEntry`, and the optional fields and union members at the lines listed in Files. Create `notificationHref.ts` with the code above and add `export * from "./notificationHref.js";` to `index.ts`.

- [ ] **Step 4: Run the shared suite and typecheck**

Run: `pnpm --filter @gatekeep/shared test && pnpm typecheck`
Expected: `164 passed` (158 plus 6 new) and 5/5 workspaces (the optional fields compile everywhere unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): sub-project 10 message constants, dispute and poster types, notificationHref"
```

---

### Task 2: Firestore rules for the hardening surfaces

**Files:**
- Modify: `firestore.rules` (users update 29-41, notifications 43-48, pushTokens 49-58, invites 347-352, new blocks after auditLogs at 359)
- Create: `tests-rules/hardening.rules.test.ts` (same harness as `tests-rules/events.rules.test.ts` lines 1-40)

**Interfaces:**
- Consumes: `PosterUploadDoc`, `DisputeRecord` shapes (Task 1); `eventCascadeRetries/{eventId}` shape from the shared block.
- Produces: the rules contract Task 15 (owner token delete), Task 11 (admin reads), and B3's poster watcher and dispute panel are provable against.

Path note for the poster doc: the shared block writes it as `posterUploads/{uid}/uploads/{nonce}`, which is
a three-segment path, and Firestore rules only ever match documents (even segment count). The block
below matches `/posterUploads/{uid}/uploads/{nonce}` so the doc is `posterUploads/{uid}/uploads/{nonce}`;
B3's `processPhoto` writer and the client watcher must use the same four-segment path (flagged to
the controller in this section's summary).

**Steps:**

- [ ] **Step 1:** Create `tests-rules/hardening.rules.test.ts`:

```ts
import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, deleteField } from "firebase/firestore";

// SP10 hardening rules matrix (spec section 5.5, rules F3/F7/F8/F9/F15, and
// the three new server-only or admin-only collections in spec section 7).
// Own file, same reasoning as events.rules.test.ts.

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "gatekeep-dev-jg",
    firestore: { rules: readFileSync("../firestore.rules", "utf8"), host: "localhost", port: 8080 },
  });
});
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const seed = async (path: string, data: object) => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
};

const TOKEN = "ExponentPushToken[abc123]";

describe("pushTokens (F3, F9)", () => {
  it("owner may delete their own token doc; a stranger may not", async () => {
    await seed("users/alice", { displayName: "Alice" });
    await seed(`users/alice/pushTokens/${TOKEN}`, { createdAt: 1 });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(deleteDoc(doc(bob, `users/alice/pushTokens/${TOKEN}`)));
    await assertSucceeds(deleteDoc(doc(alice, `users/alice/pushTokens/${TOKEN}`)));
  });
  it("token id is bounded to 200 characters inside the brackets", async () => {
    await seed("users/alice", { displayName: "Alice" });
    const alice = env.authenticatedContext("alice").firestore();
    const ok = `ExponentPushToken[${"a".repeat(200)}]`;
    const tooLong = `ExponentPushToken[${"a".repeat(201)}]`;
    await assertSucceeds(setDoc(doc(alice, `users/alice/pushTokens/${ok}`), { createdAt: Date.now() }));
    await assertFails(setDoc(doc(alice, `users/alice/pushTokens/${tooLong}`), { createdAt: Date.now() }));
  });
  it("createdAt must be an int", async () => {
    await seed("users/alice", { displayName: "Alice" });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(setDoc(doc(alice, `users/alice/pushTokens/${TOKEN}`), { createdAt: "now" }));
    await assertFails(setDoc(doc(alice, `users/alice/pushTokens/${TOKEN}`), { createdAt: 1.5 }));
    await assertSucceeds(setDoc(doc(alice, `users/alice/pushTokens/${TOKEN}`), { createdAt: 1700000000000 }));
  });
});

describe("notifications.read (F8)", () => {
  it("read must be a bool", async () => {
    await seed("users/alice", { displayName: "Alice" });
    await seed("users/alice/notifications/n1", { title: "Approved!", body: "", kind: "system", read: false, createdAt: 1 });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(updateDoc(doc(alice, "users/alice/notifications/n1"), { read: "yes" }));
    await assertFails(updateDoc(doc(alice, "users/alice/notifications/n1"), { read: 1 }));
    await assertSucceeds(updateDoc(doc(alice, "users/alice/notifications/n1"), { read: true }));
  });
});

describe("users.displayName (F7)", () => {
  it("owner cannot delete or blank displayName; 1 to 80 characters stays allowed", async () => {
    await seed("users/alice", { displayName: "Alice", email: "a@x.com" });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(updateDoc(doc(alice, "users/alice"), { displayName: deleteField() }));
    await assertFails(updateDoc(doc(alice, "users/alice"), { displayName: "" }));
    await assertFails(updateDoc(doc(alice, "users/alice"), { displayName: 42 }));
    await assertSucceeds(updateDoc(doc(alice, "users/alice"), { displayName: "A" }));
    await assertSucceeds(updateDoc(doc(alice, "users/alice"), { displayName: "x".repeat(80) }));
    // A homeCity-only update must still pass: displayName stays present in the resulting doc.
    await assertSucceeds(updateDoc(doc(alice, "users/alice"), { homeCity: "Austin" }));
  });
});

describe("invites admin read (F15)", () => {
  it("admin reads any invite; an uninvolved signed-in user still cannot", async () => {
    await seed("invites/i1", { invitedUid: "bob", invitedByUid: "alice", profileId: "p1", status: "pending" });
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    const carol = env.authenticatedContext("carol").firestore();
    await assertSucceeds(getDoc(doc(admin, "invites/i1")));
    await assertSucceeds(getDocs(collection(admin, "invites")));
    await assertFails(getDoc(doc(carol, "invites/i1")));
    await assertFails(setDoc(doc(admin, "invites/i2"), { invitedUid: "bob" }));
  });
});

describe("posterUploads/{uid}/uploads/{nonce}", () => {
  it("owner gets and lists; stranger and anon denied; nobody writes", async () => {
    await seed("posterUploads/alice/uploads/n1", { path: "public/photos/p1/poster-n1.jpg", createdAt: 1 });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(alice, "posterUploads/alice/uploads/n1")));
    await assertSucceeds(getDocs(collection(alice, "posterUploads/alice/uploads")));
    await assertFails(getDoc(doc(bob, "posterUploads/alice/uploads/n1")));
    await assertFails(getDocs(collection(bob, "posterUploads/alice/uploads")));
    await assertFails(getDoc(doc(anon, "posterUploads/alice/uploads/n1")));
    await assertFails(setDoc(doc(alice, "posterUploads/alice/uploads/n2"), { path: "x", createdAt: 2 }));
    await assertFails(deleteDoc(doc(alice, "posterUploads/alice/uploads/n1")));
  });
});

describe("disputes", () => {
  it("admin reads; owner-shaped users cannot; nobody writes", async () => {
    await seed("disputes/dp1", {
      chargeId: "ch_1", intentId: "pi_1", purpose: "tickets", orderId: "o1",
      amountCents: 2000, feeCents: 239, reason: "fraudulent", status: "open", openedAt: 1,
    });
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    const alice = env.authenticatedContext("alice").firestore();
    await assertSucceeds(getDoc(doc(admin, "disputes/dp1")));
    await assertSucceeds(getDocs(collection(admin, "disputes")));
    await assertFails(getDoc(doc(alice, "disputes/dp1")));
    await assertFails(setDoc(doc(admin, "disputes/dp2"), { status: "open" }));
  });
});

describe("eventCascadeRetries", () => {
  it("nobody reads or writes, not even an admin", async () => {
    await seed("eventCascadeRetries/ev1", { profileId: "p1", reason: "r", attempts: 1, lastError: "x", createdAt: 1 });
    const admin = env.authenticatedContext("root", { admin: true }).firestore();
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(getDoc(doc(admin, "eventCascadeRetries/ev1")));
    await assertFails(getDoc(doc(alice, "eventCascadeRetries/ev1")));
    await assertFails(setDoc(doc(admin, "eventCascadeRetries/ev1"), { attempts: 2 }));
    await assertFails(deleteDoc(doc(admin, "eventCascadeRetries/ev1")));
  });
});
```

- [ ] **Step 2:** `pnpm emu:rules`. Expected: the new file fails on the owner delete (pushTokens `allow write` throws on `request.resource.data.keys()` for a delete), `createdAt: "now"` (accepted today), `read: "yes"` (accepted today), `displayName: deleteField()` and `""` (accepted today), the admin invite read (denied today), and every posterUploads and disputes read (catch-all deny). The eventCascadeRetries case already passes via the catch-all.

- [ ] **Step 3:** Edit `firestore.rules`. Replace lines 29-33 (users update, first four clauses) with:

```
      allow update: if isOwner(uid)
        && request.resource.data.diff(resource.data).affectedKeys()
             .hasOnly(['displayName', 'photoUrl', 'homeCity'])
        // F7: displayName is required by UserDoc and copied into attendee
        // rows and notification copy, so the owner may neither delete it
        // (affectedKeys admits a FieldValue.delete) nor blank it.
        && 'displayName' in request.resource.data
        && request.resource.data.displayName is string
        && request.resource.data.displayName.size() >= 1
        && request.resource.data.displayName.size() <= 80
```

Replace lines 45-46 (notifications update) with:

```
        allow update: if isOwner(uid)
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['read'])
          && request.resource.data.read is bool;
```

Replace lines 49-58 (the whole pushTokens block) with:

```
      match /pushTokens/{tokenId} {
        allow read: if isOwner(uid);
        // Doc id must be a well-formed Expo push token (bounded, F9), and the
        // payload may only ever contain an int createdAt (push.ts's write
        // shape; notifyUser orders by it). Split from a single `allow write`
        // (F3): request.resource is null on a delete, so a keys() check
        // there threw and the owner could never unregister a device.
        allow create, update: if isOwner(uid)
          && tokenId.matches('^ExponentPushToken\\[[A-Za-z0-9_-]{1,200}\\]$')
          && request.resource.data.keys().hasOnly(['createdAt'])
          && request.resource.data.createdAt is int;
        allow delete: if isOwner(uid);
      }
```

Replace lines 347-352 (invites) with:

```
    match /invites/{inviteId} {
      // F15: admins read invites too (support: "I never got the invite").
      allow read: if signedIn()
        && (request.auth.uid == resource.data.invitedUid
            || request.auth.uid == resource.data.invitedByUid
            || isAdmin());
      allow write: if false; // Cloud Functions only
    }
```

Insert after line 359 (`match /auditLogs/{logId} ...`), before the catch-all:

```
    // ---------- Sub-project 10: hardening ----------
    // Poster upload receipts: processPhoto writes one doc per upload nonce
    // under the uploader's uid; the client watches it to learn the final
    // processed path. Owner get/list only, server write only.
    match /posterUploads/{uid}/uploads/{nonce} {
      allow get, list: if isOwner(uid);
      allow write: if false;
    }
    // Stripe dispute records (DisputeRecord): admin-read, server-write, like
    // ledger and adminAlerts above.
    match /disputes/{disputeId} { allow read: if isAdmin(); allow write: if false; }
    // Events whose moderation cascade (cancel + refund) failed at the
    // reject-from-approved touchpoint, queued for dailySweep step 9. Same
    // internal-only shape as curatorAccessRetries.
    match /eventCascadeRetries/{eventId} { allow read, write: if false; }
```

- [ ] **Step 4:** `pnpm emu:rules`: every pre-existing file still passes (the users test at rules.test.ts:94-103 sets `displayName: "x".repeat(80)`, which stays allowed; the pushTokens tests at 117-138 exercise create only), and the new file passes. Count strictly above 103.

- [ ] **Step 5:** Load the `firebase-security-rules-auditor` skill against the changed blocks (spec section 9 requires the re-run). Commit: `feat(rules): push token delete, typed read flag, displayName floor, admin invite read, poster/dispute/cascade blocks`

---


---

### Task 3: Transfer sourcing (sp5 #1)

**Files:**
- Modify: `functions/src/bookings.ts` (commitAcceptAfterCharge writes, lines 854-858)
- Modify: `functions/src/paymentsSweep.ts` (chargeOneBirthDeposit held write 807-811 and raced write 824-826)
- Modify: `functions/src/paymentsSettlement.ts` (finalizeDepositPayDue writes 1624-1632 and 1640-1648; finalizeSettlementSuccess sourcing 701-719; earnings ledger row 816-821)
- Modify: `functions/src/paymentsCore.ts` (resolveDepositPending forfeit ledger row 491-494)
- Modify: `functions/src/stripeClient.ts` (FakeStripe.reconstructError 287-292; FakeStripe.transferToAccount 557-576; the StripeLike `transferToAccount` doc comment 182-189)
- Test: `functions/test/paymentsSettlement.test.ts` (new describe block appended after line 918, before the dunning describe at 920), `functions/test/stripeClient.test.ts` (new case inside the existing `describe("FakeStripe")`)

**Interfaces (Consumes):** `DepositState.chargeAmountCents?: number`, `LedgerEntry.sourced?: boolean` (Task 1). `settlementMath(p, booking, gig): SettlementMath` with `math.earnings` and `math.chargeTotal` (`paymentsSettlement.ts:172`). `FakeStripe.idem`, `objRef`, `newId` (`stripeClient.ts:322, 267, 386`).

**Interfaces (Produces):**
```ts
// stripeClient.ts: unchanged signature, new behavior. A sourced transfer whose amount, plus every
// earlier NON-reversed sourced transfer against the same charge, exceeds that charge's amount throws
//   Object.assign(new Error("FakeStripe: transfer exceeds source charge (balance_insufficient)"), { code: "balance_insufficient" })
// which idem() caches (message starts with "FakeStripe:"), and reconstructError now reattaches `code` on replay.
transferToAccount(params: { accountId; amountCents; idempotencyKey; meta; sourceChargeId? }): Promise<{ id: string }>;
```

- [ ] **Step 1: Write the failing FakeStripe cap test** in `functions/test/stripeClient.test.ts`, inside `describe("FakeStripe", ...)` after the last existing `it`:

```ts
  it("SP10 Task 3: a sourced transfer is capped at the source charge, cumulatively across transfers", async () => {
    const customer = await fake.createCustomer({});
    await fake.markCardSaved(customer.id);
    const charge = await fake.chargeOffSession({
      customerId: customer.id, amountCents: 10_000, idempotencyKey: `cap:charge:${Date.now()}`, meta: {},
    });
    expect(charge.chargeId).toBeTruthy();
    const acct = await fake.createExpressAccount({});

    await fake.transferToAccount({
      accountId: acct.id, amountCents: 6_000, idempotencyKey: `cap:t1:${Date.now()}`, meta: {},
      sourceChargeId: charge.chargeId!,
    });
    // 6,000 already drawn; another 5,000 against the same charge would exceed its 10,000.
    const key2 = `cap:t2:${Date.now()}`;
    await expect(fake.transferToAccount({
      accountId: acct.id, amountCents: 5_000, idempotencyKey: key2, meta: {}, sourceChargeId: charge.chargeId!,
    })).rejects.toMatchObject({ code: "balance_insufficient" });
    // Same key, same modeled error, replayed WITH its code (real Stripe replays the 400 verbatim).
    await expect(fake.transferToAccount({
      accountId: acct.id, amountCents: 5_000, idempotencyKey: key2, meta: {}, sourceChargeId: charge.chargeId!,
    })).rejects.toMatchObject({ code: "balance_insufficient" });
    // 4,000 fits exactly; an UNSOURCED transfer is never capped by a charge.
    await fake.transferToAccount({
      accountId: acct.id, amountCents: 4_000, idempotencyKey: `cap:t3:${Date.now()}`, meta: {}, sourceChargeId: charge.chargeId!,
    });
    await fake.transferToAccount({
      accountId: acct.id, amountCents: 50_000, idempotencyKey: `cap:t4:${Date.now()}`, meta: {},
    });
    expect(await balanceOf(acct.id)).toBe(60_000);
    // An unknown source charge is refused outright (real Stripe 400s on an unknown source_transaction).
    await expect(fake.transferToAccount({
      accountId: acct.id, amountCents: 1, idempotencyKey: `cap:t5:${Date.now()}`, meta: {}, sourceChargeId: "ch_nope",
    })).rejects.toThrow(/unknown source charge/);
  });
```

- [ ] **Step 2: Write the failing sourcing tests** in `functions/test/paymentsSettlement.test.ts`. Insert after line 918 (the closing `});` of the first describe, the one titled "the full T+3 pipeline"; it ends right before the describe titled "a declined charge (Task 11 owns the ladder from here)" at line 920):

```ts
// ---------------------------------------------------------------------------
// SP10 Task 3: transfer sourcing (sp5 #1). A transfer may draw on a charge only
// when it fits inside that charge; otherwise it draws on the platform balance
// and says so in its ledger row.
// ---------------------------------------------------------------------------
const FLAT_SET_CENTS = 100_000; // the audit's $1,000 gig
const SET_DEPOSIT_CENTS = computeDepositCents(FLAT_SET_CENTS);
const SET_DEPOSIT_CHARGE_CENTS = SET_DEPOSIT_CENTS + computeFeeShareCents(SET_DEPOSIT_CENTS, FEE.curatorFeePct);
const SET_DUE_CENTS = FLAT_SET_CENTS - SET_DEPOSIT_CENTS;
const SET_CHARGE_CENTS = SET_DUE_CENTS + computeFeeShareCents(SET_DUE_CENTS, FEE.curatorFeePct);
const SET_EARNINGS_CENTS = computeEarningsCents(FLAT_SET_CENTS, FEE.musicianFeePct);

describe("SP10 Task 3: transfer sourcing", () => {
  it("the standard $1,000 settlement is NOT sourced from its $721.50 charge and still pays $980", async () => {
    expect(SET_EARNINGS_CENTS).toBe(98_000);
    expect(SET_EARNINGS_CENTS).toBeGreaterThan(SET_CHARGE_CENTS);
    const { musician, gigId, bookingId } = await makeEndedBooking("src1", {
      gig: { budget: { minCents: 50_000, maxCents: 150_000, structure: "perSet" } },
      offer: offerPayload({ amountCents: FLAT_SET_CENTS }),
    });
    const accountId = await musicianAccountId(musician.profileId);
    const held = await getPayment(bookingId, gigId);
    // Every deposit charge site now records the charge amount beside the charge id.
    expect(held?.deposit.chargeAmountCents).toBe(SET_DEPOSIT_CHARGE_CENTS);

    await scheduleSettlement(bookingId, gigId);
    await makeSettlementDue(bookingId, gigId);
    await runPaymentsSweep(Date.now());

    const paid = await getPayment(bookingId, gigId);
    expect(paid?.settlement.status).toBe("paid");
    expect(await fakeObject(paid!.settlement.intentId!).then((i) => i?.amountCents)).toBe(SET_CHARGE_CENTS);
    expect(paid?.transfer.amountCents).toBe(SET_EARNINGS_CENTS);
    expect(await accountBalanceCents(accountId)).toBe(SET_EARNINGS_CENTS);
    // Unsourced: the transfer object carries no source charge, and the row says so.
    expect(await fakeObject(paid!.transfer.id!).then((t) => t?.sourceChargeId)).toBeNull();
    const earnRow = (await ledgerRows(bookingId)).find((r) => r.kind === "earnings_transfer");
    expect(earnRow?.sourced).toBe(false);
  });

  it("a forfeit transfer stays sourced from the deposit charge", async () => {
    const curator = await makeApprovedCuratorProfile("src2c");
    const musician = await makeApprovedMusicianProfile("src2m");
    await makeMoneyReady(curator, musician);
    const gigId = await createOpenGig(curator.profileId, curator.owner.user);
    const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
      "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: offerPayload() }, musician.owner.user);
    await callFn("acceptBooking", { bookingId }, curator.owner.user);
    const held = (await getPayment(bookingId, gigId))!;
    expect(held.deposit.chargeAmountCents).toBe(DEPOSIT_CHARGE_CENTS);

    await setGigStartsAt(gigId, 10); // inside CURATOR_FORFEIT_WINDOW_HOURS
    await ageConfirmedAt(bookingId);
    await callFn("cancelBooking", { bookingId, reason: "Venue flooded." }, curator.owner.user);

    const p = (await getPayment(bookingId, gigId))!;
    expect(p.deposit.status).toBe("forfeited");
    expect(await fakeObject(p.deposit.forfeitTransferId!).then((t) => t?.sourceChargeId)).toBe(held.deposit.chargeId);
    const row = (await ledgerRows(bookingId)).find((r) => r.kind === "forfeit_transfer");
    expect(row?.sourced).toBe(true);
  });

  it("a zero-charge settlement is sourced from the deposit charge", async () => {
    const zero = await makeEndedBooking("src3");
    await scheduleSettlement(zero.bookingId, zero.gigId);
    const deposit = (await getPayment(zero.bookingId, zero.gigId))!;
    await adb.doc(`bookings/${zero.bookingId}/payments/${zero.gigId}`).update({ "deposit.sliceCents": BASE_CENTS });
    expect(await chargeSettlement({ bookingId: zero.bookingId, gigId: zero.gigId, now: Date.now() }))
      .toEqual({ outcome: "charged", transferred: true });
    const paid = (await getPayment(zero.bookingId, zero.gigId))!;
    expect(await fakeObject(paid.transfer.id!).then((t) => t?.sourceChargeId)).toBe(deposit.deposit.chargeId);
    const row = (await ledgerRows(zero.bookingId)).find((r) => r.kind === "earnings_transfer");
    expect(row?.sourced).toBe(true);
  });

  it("a legacy deposit doc with no chargeAmountCents falls back to an unsourced zero-charge transfer", async () => {
    const zero = await makeEndedBooking("src4");
    await scheduleSettlement(zero.bookingId, zero.gigId);
    await adb.doc(`bookings/${zero.bookingId}/payments/${zero.gigId}`).update({
      "deposit.sliceCents": BASE_CENTS, "deposit.chargeAmountCents": FieldValue.delete(),
    });
    expect(await chargeSettlement({ bookingId: zero.bookingId, gigId: zero.gigId, now: Date.now() }))
      .toEqual({ outcome: "charged", transferred: true });
    const paid = (await getPayment(zero.bookingId, zero.gigId))!;
    expect(await fakeObject(paid.transfer.id!).then((t) => t?.sourceChargeId)).toBeNull();
    expect((await ledgerRows(zero.bookingId)).find((r) => r.kind === "earnings_transfer")?.sourced).toBe(false);
  });
});
```

`ageConfirmedAt` is added to the file's `./helpers` import (line 3), `makeApprovedCuratorProfile` and `makeApprovedMusicianProfile` already exist at lines 81 and 94.

- [ ] **Step 3: Run the two files and confirm the failures.** `pnpm emu:test` (single blocking call). Expected: the cap test fails at the first `rejects.toMatchObject({ code: "balance_insufficient" })` because the fake never throws; "standard $1,000 settlement" fails at `expect(held?.deposit.chargeAmountCents).toBe(...)` (field never written); "forfeit" and "zero-charge" fail on `row?.sourced` being `undefined`; the legacy case fails because the transfer is still sourced. The sweep chain in the $1,000 case does not fail on its own under the fake without the cap; the cap test is what would have caught the audit's live-mode failure.

- [ ] **Step 4: Record `chargeAmountCents` at every deposit charge site.**

`functions/src/bookings.ts` lines 854-858 (commitAcceptAfterCharge's per-doc write), replace the `tx.update(doc.ref, {...})` block with:

```ts
    for (const doc of stagedDocs) {
      tx.update(doc.ref, {
        "deposit.status": "held", "deposit.intentId": intentId, "deposit.chargeId": chargeId,
        // SP10 Task 3: the amount of the CHARGE (the whole accept batch, shared
        // by every doc it paid for), not this doc's slice. finalizeSettlementSuccess
        // decides whether a transfer fits inside it.
        ...(intentId ? { "deposit.chargeAmountCents": expectedChargeCents } : {}),
        "deposit.chargedAt": now, updatedAt: now,
      });
    }
```

`functions/src/paymentsSweep.ts` lines 807-811 (chargeOneBirthDeposit's held write):

```ts
      await doc.ref.update({
        "deposit.status": "held", "deposit.intentId": r.id, "deposit.chargeId": r.chargeId,
        "deposit.chargeAmountCents": amountCents,
        "deposit.chargedAt": now, "deposit.depositNextRetryAt": null, updatedAt: now,
      }, { lastUpdateTime: chargeBaseline });
```

and lines 824-826 (the raced write):

```ts
        await doc.ref.update({
          "deposit.intentId": r.id, "deposit.chargeId": r.chargeId, "deposit.chargeAmountCents": amountCents,
          "deposit.chargedAt": now, updatedAt: now,
        });
```

`functions/src/paymentsSettlement.ts` finalizeDepositPayDue, lines 1624-1632: add `"deposit.chargeAmountCents": amountCents,` directly after the `"deposit.chargeId": ...` line (1626); lines 1640-1648: add the same line after the `"deposit.chargeId": ...` line (1646). `amountCents` is already computed at line 1621, above both writes.

- [ ] **Step 5: The sourcing decision in finalizeSettlementSuccess.** Replace lines 701-719 of `functions/src/paymentsSettlement.ts` (from the `// As-built contract #3:` comment through the `: null;` that ends the `const transfer = ...` expression) with:

```ts
  // SP10 Task 3 (sp5 #1): a transfer may draw on a charge (source_transaction)
  // ONLY when it fits inside that charge. Stripe caps a sourced transfer at the
  // source charge's amount, cumulatively with every earlier transfer sourced
  // from it. The earnings transfer (98% of the FULL base) never fits inside the
  // settlement charge (65% of the base plus its fee share), so the standard
  // settlement draws on the platform balance; the deposit charge is days old
  // and available by T+3, which is what makes the unsourced transfer safe. A
  // zero-charge settlement (the deposit covered the whole date) draws on the
  // deposit's charge when the doc knows that charge's amount; a legacy doc
  // that does not falls back to the unsourced transfer.
  const sourceCandidate: { id: string; amountCents: number } | null = args.chargeId
    ? { id: args.chargeId, amountCents: args.chargedCents ?? math.chargeTotal }
    : (math.chargeTotal === 0 && p.deposit.chargeId && p.deposit.chargeAmountCents != null)
      ? { id: p.deposit.chargeId, amountCents: p.deposit.chargeAmountCents }
      : null;
  const sourceChargeId = sourceCandidate && math.earnings <= sourceCandidate.amountCents ? sourceCandidate.id : null;
  const transfer = math.earnings > 0
    ? await getStripe().transferToAccount({
      accountId: musicianStripe!.accountId!, amountCents: math.earnings,
      // Attempt-scoped like the charge key: Task 12's restore re-run bumps
      // `settlement.attempts` when it re-opens a clawed-back settlement, and
      // without that the transfer key would silently replay the consumed
      // original and no money would move.
      idempotencyKey: `${bookingId}:${gigId}:earn:${p.settlement.attempts}`,
      meta: { bookingId, gigId, purpose: "earnings" },
      ...(sourceChargeId ? { sourceChargeId } : {}),
    })
    : null;
```

Then the earnings ledger row at lines 816-821 gains the flag:

```ts
  if (transfer) {
    await writeLedger({
      kind: "earnings_transfer", amountCents: math.earnings, bookingId, gigId,
      profileId: p.musicianProfileId, stripeId: transfer.id,
      sourced: sourceChargeId != null,
      detail: sourceChargeId
        ? "earnings transfer (net of the musician fee, incl. any late-fee share), sourced from the charge"
        : "earnings transfer (net of the musician fee, incl. any late-fee share), drawn on the platform balance",
    }).catch((e) => console.error(`finalizeSettlementSuccess: earnings_transfer ledger row failed for ${bookingId}/${gigId}`, e));
```

- [ ] **Step 6: The forfeit row says it is sourced.** `functions/src/paymentsCore.ts` lines 491-494, resolveDepositPending's forfeit ledger row:

```ts
    await writeLedger({
      kind: "forfeit_transfer", amountCents: p.deposit.sliceCents, bookingId, gigId,
      profileId: p.musicianProfileId, stripeId: t.id, sourced: p.deposit.chargeId != null,
      detail: "deposit forfeited to musician (100%)",
    }).catch((e) => console.error(`resolveDepositPending: ledger write failed for forfeit ${bookingId}/${gigId}`, e));
```

(The slice is always inside the deposit charge, so no decision is needed here; the row records the fact.)

- [ ] **Step 7: FakeStripe models the cap.** `functions/src/stripeClient.ts`:

Replace `reconstructError` (lines 287-292) so a stored `code` survives replay:

```ts
  private reconstructError(stored: StoredError): Error {
    if (stored.name === "StripeCardDeclinedError") return new StripeCardDeclinedError(stored.message, stored.code);
    if (stored.name === "StripePaymentPendingError") return new StripePaymentPendingError(stored.intentId ?? "", stored.message);
    const err = new Error(stored.message) as Error & { code?: string };
    err.name = stored.name;
    if (stored.code) err.code = stored.code;
    return err;
  }
```

Replace `transferToAccount` (lines 557-576):

```ts
  async transferToAccount(p: { accountId: string; amountCents: number; idempotencyKey: string; meta: Record<string, string>; sourceChargeId?: string }) {
    return this.idem(p.idempotencyKey, async () => {
      const id = this.newId("tr");
      const acct = this.objRef(p.accountId);
      const objects = this.db.collection("stripeFake/state/objects");
      // Both writes (the transfer object AND the running balance it depends
      // on) happen in one transaction: no world where the object exists but
      // the balance never moved (or vice versa), including if idem() decides
      // NOT to cache a later failure and this whole make() reruns.
      await this.db.runTransaction(async (tx) => {
        if (p.sourceChargeId) {
          // SP10 Task 3 (sp5 #1): Stripe caps a source_transaction transfer at
          // the source charge's amount, cumulatively across every transfer
          // sourced from it. Modeled here so the suite fails the way live mode
          // would. The charge lives on its payment_intent object (chargeId).
          const intentSnap = await tx.get(objects.where("chargeId", "==", p.sourceChargeId).limit(1));
          if (intentSnap.empty) throw new Error(`FakeStripe: unknown source charge ${p.sourceChargeId}`);
          const chargeAmount = intentSnap.docs[0].data().amountCents as number;
          const priorSnap = await tx.get(objects.where("kind", "==", "transfer").where("sourceChargeId", "==", p.sourceChargeId));
          const drawn = priorSnap.docs
            .filter((d) => d.data().reversed !== true)
            .reduce((sum, d) => sum + ((d.data().amountCents as number) - ((d.data().reversedCents as number | undefined) ?? 0)), 0);
          if (drawn + p.amountCents > chargeAmount) {
            throw Object.assign(
              new Error(`FakeStripe: transfer exceeds source charge (balance_insufficient): ${drawn} already drawn + ${p.amountCents} > ${chargeAmount}`),
              { code: "balance_insufficient" });
          }
        }
        const s = await tx.get(acct);
        tx.set(acct, { balanceCents: ((s.data()?.balanceCents as number | undefined) ?? 0) + p.amountCents }, { merge: true });
        tx.set(this.objRef(id), {
          kind: "transfer", accountId: p.accountId, amountCents: p.amountCents, meta: p.meta,
          sourceChargeId: p.sourceChargeId ?? null, reversed: false, reversedCents: 0,
        });
      });
      return { id };
    }, `${p.accountId}:${p.amountCents}:${p.sourceChargeId ?? ""}`);
  }
```

(`reversedCents` is read by Task 6's partial reversal; writing it from day one keeps the object shape stable.) Update the `StripeLike.transferToAccount` doc comment (lines 184-188) to say: "Forwarded to Stripe as source_transaction so the transfer draws against that charge's funds. Stripe caps a sourced transfer at the charge's amount, cumulatively with earlier sourced transfers; callers pass it only when the transfer fits (SP10 Task 3), and FakeStripe refuses the same way live Stripe does."

- [ ] **Step 8: Run, expect pass.** `pnpm emu:test`. The four sourcing cases and the cap case pass; every pre-existing `sourceChargeId` assertion still holds: the perHour standard fixture at line 393 asserts the earnings transfer is sourced from the settlement charge, and with `EARNINGS_CENTS` (98% of $262.50 base with true-up) greater than `SETTLE_CHARGE_CENTS`, that assertion now fails. Change line 393 to `expect(transferObj?.sourceChargeId).toBeNull();` with the comment "SP10 Task 3: the earnings transfer does not fit inside the settlement charge, so it draws on the platform balance", and the zero-charge case at 651-652 stays as is (sourced from the deposit charge, now via `chargeAmountCents`). `pnpm typecheck` 5/5.

- [ ] **Step 9: Commit.** `git commit -m "fix(payments): source a transfer from a charge only when it fits; FakeStripe models the source_transaction cap (sp5 #1)"`

---

### Task 4: Two webhook secrets (sp5 #3)

**Files:**
- Modify: `functions/src/stripeClient.ts` (secrets 32-33; `StripeWebhookSecretMissingError` 103-108; StripeLike `constructWebhookEvent` 219; FakeStripe.constructWebhookEvent 640-652; RealStripe.constructWebhookEvent 904-926)
- Modify: `functions/src/paymentsWebhook.ts` (import line 4; options line 170; event type 178; the catch 181-194; new scope check after the shape check at 199-202)
- Modify: `functions/test/stripeSecrets.test.ts` (new describe appended), `functions/test/paymentsWebhook.test.ts` (new cases), `functions/test/payments.test.ts` (postWebhook 89-96), `functions/test/paymentsPayouts.test.ts` (postWebhook 115-121)
- Modify: `README.md` lines 659-671 (the "Register the webhook endpoint" bullet)

**Interfaces (Produces):**
```ts
// stripeClient.ts
export const stripeConnectWebhookSecret = defineSecret("STRIPE_CONNECT_WEBHOOK_SECRET"); // Task 1 fixed name
export type WebhookScope = "platform" | "connect";
export class StripeWebhookSecretMissingError extends Error {
  secretName: "STRIPE_WEBHOOK_SECRET" | "STRIPE_CONNECT_WEBHOOK_SECRET";
  constructor(secretName: "STRIPE_WEBHOOK_SECRET" | "STRIPE_CONNECT_WEBHOOK_SECRET");
}
export interface VerifiedWebhookEvent {
  id: string; type: string; account?: string; scope: WebhookScope; data: { object: Record<string, unknown> };
}
// StripeLike
constructWebhookEvent(rawBody: string | Buffer, signature: string): VerifiedWebhookEvent;
// FakeStripe accepts the header values "fake" and "fake:platform" (platform scope) and "fake:connect"
// (connect scope); anything else throws Error("FakeStripe: bad signature").
```

- [ ] **Step 1: Failing secrets tripwire.** Append to `functions/test/stripeSecrets.test.ts`:

```ts
// SP10 Task 4 (sp5 #3): the webhook verifies against TWO signing secrets, one
// per Stripe endpoint scope ("Your account" and "Connected accounts"). Both
// must be declared on stripeWebhook or a deployed function cannot resolve them.
describe("SP10 Task 4: stripeWebhook declares both webhook signing secrets", () => {
  it("stripeWebhook lists stripeWebhookSecret AND stripeConnectWebhookSecret", () => {
    const src = readFileSync(path.join(SRC_DIR, "paymentsWebhook.ts"), "utf8");
    const decl = src.search(/export const stripeWebhook\s*=\s*onRequest\b/);
    expect(decl).toBeGreaterThanOrEqual(0);
    const opts = optionsSlice(src, decl);
    expect(opts).not.toBeNull();
    expect(/\bstripeWebhookSecret\b/.test(opts!)).toBe(true);
    expect(/\bstripeConnectWebhookSecret\b/.test(opts!)).toBe(true);
  });

  it("stripeClient.ts defines the Connect secret with the fixed name", () => {
    const src = readFileSync(path.join(SRC_DIR, "stripeClient.ts"), "utf8");
    expect(src).toContain('export const stripeConnectWebhookSecret = defineSecret("STRIPE_CONNECT_WEBHOOK_SECRET")');
  });
});
```

- [ ] **Step 2: Failing scope tests** in `functions/test/paymentsWebhook.test.ts`, appended inside `describe("stripeWebhook")`:

```ts
  // SP10 Task 4 (sp5 #3): two endpoints, two secrets, and an event may only be
  // acted on under the scope its secret belongs to.
  it("a Connect-signed event that carries no account is refused (400) and never recorded", async () => {
    const evt = fakeEvent("some.unknown.type", {});
    const res = await post(evt, { "stripe-signature": "fake:connect" });
    expect(res.status).toBe(400);
    expect((await adb.doc(`stripeEvents/${evt.id}`).get()).exists).toBe(false);
  });

  it("a platform-signed event that carries an account is refused (400) and never recorded", async () => {
    const evt = { ...fakeEvent("some.unknown.type", {}), account: "acct_fake_1" };
    const res = await post(evt, { "stripe-signature": "fake" });
    expect(res.status).toBe(400);
    expect((await adb.doc(`stripeEvents/${evt.id}`).get()).exists).toBe(false);
  });

  it("a Connect-signed event WITH an account is accepted and recorded", async () => {
    const evt = { ...fakeEvent("some.unknown.type", {}), account: "acct_fake_2" };
    const res = await post(evt, { "stripe-signature": "fake:connect" });
    expect(res.status).toBe(200);
    expect((await adb.doc(`stripeEvents/${evt.id}`).get()).data()?.processed).toBe(true);
  });

  it("a signature that matches neither secret is a flat 400", async () => {
    expect((await post(fakeEvent("some.unknown.type", {}), { "stripe-signature": "forged" })).status).toBe(400);
  });
```

- [ ] **Step 3: Run, confirm failures.** The tripwire's first case fails on `stripeConnectWebhookSecret` absent from the options; the second on the missing definition. "Connect-signed without account" fails with status 200 (the fake accepts any header today); "platform-signed with account" likewise 200; "neither secret" 200.

- [ ] **Step 4: stripeClient.ts.** After line 33 add:

```ts
// SP10 Task 4 (sp5 #3): a Stripe endpoint listens EITHER to events on your own
// account OR to events on Connected accounts, and the two are separate
// endpoint objects with separate signing secrets. payment_intent.* and
// transfer.reversed are platform events; account.updated and payout.* are
// connected-account events. The webhook verifies against both.
export const stripeConnectWebhookSecret = defineSecret("STRIPE_CONNECT_WEBHOOK_SECRET");
export type WebhookScope = "platform" | "connect";
export interface VerifiedWebhookEvent {
  id: string; type: string; account?: string; scope: WebhookScope; data: { object: Record<string, unknown> };
}
```

Replace the `StripeWebhookSecretMissingError` class (lines 103-108) with:

```ts
export class StripeWebhookSecretMissingError extends Error {
  secretName: "STRIPE_WEBHOOK_SECRET" | "STRIPE_CONNECT_WEBHOOK_SECRET";
  constructor(secretName: "STRIPE_WEBHOOK_SECRET" | "STRIPE_CONNECT_WEBHOOK_SECRET" = "STRIPE_WEBHOOK_SECRET") {
    super(`${secretName} is not configured: refusing to verify webhook signatures.`);
    this.name = "StripeWebhookSecretMissingError";
    this.secretName = secretName;
  }
}
```

Change the StripeLike member at line 219 to `constructWebhookEvent(rawBody: string | Buffer, signature: string): VerifiedWebhookEvent;` and extend its doc comment (206-218) with: "`scope` says which secret verified the delivery; the dispatcher refuses a platform-scoped event that carries `account` and a connect-scoped event that does not."

Replace `FakeStripe.constructWebhookEvent` (lines 640-652):

```ts
  constructWebhookEvent(rawBody: string | Buffer, signature: string): VerifiedWebhookEvent {
    // The fake models the TWO endpoint secrets as two header values. "fake"
    // stays the platform alias so every existing test keeps posting platform
    // events unchanged; a test posting a connected-account event signs it
    // "fake:connect". Anything else is a bad signature, as it would be live.
    let scope: WebhookScope;
    if (signature === "fake" || signature === "fake:platform") scope = "platform";
    else if (signature === "fake:connect") scope = "connect";
    else throw new Error("FakeStripe: bad signature");
    const evt = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")) as
      { id: string; type: string; account?: unknown; data: { object: Record<string, unknown> } };
    // M1 (branch audit): mirror the real SDK's top-level connected-account
    // marker. A fake event with no `account` is a PLATFORM event (undefined),
    // exactly as a platform delivery arrives from Stripe; a test that needs a
    // connected-account event sets `account` on the event JSON it posts.
    return {
      id: evt.id, type: evt.type, data: evt.data, scope,
      account: typeof evt.account === "string" ? evt.account : undefined,
    };
  }
```

Replace `RealStripe.constructWebhookEvent` (lines 904-926):

```ts
  constructWebhookEvent(rawBody: string | Buffer, signature: string): VerifiedWebhookEvent {
    // H3 (branch audit): resolve BOTH signing secrets and FAIL CLOSED when
    // either is absent. A missing secret is a misconfigured endpoint, not a bad
    // signature, and must throw its own configuration error BEFORE
    // constructEvent is ever called; the webhook handler turns it into a loud
    // 500 rather than the flat 400 a forged signature gets.
    const platformSecret = stripeWebhookSecret.value() || process.env.STRIPE_WEBHOOK_SECRET;
    if (!platformSecret) throw new StripeWebhookSecretMissingError("STRIPE_WEBHOOK_SECRET");
    const connectSecret = stripeConnectWebhookSecret.value() || process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    if (!connectSecret) throw new StripeWebhookSecretMissingError("STRIPE_CONNECT_WEBHOOK_SECRET");
    // SP10 Task 4 (sp5 #3): the event's `account` cannot be read before
    // verification, so try the platform secret first, then the Connect secret.
    // The FIRST failure is what surfaces when both refuse: a genuine forgery
    // fails both identically, and the platform endpoint is the busier one.
    let evt: Stripe.Event;
    let scope: WebhookScope;
    try {
      evt = this.s.webhooks.constructEvent(rawBody, signature, platformSecret);
      scope = "platform";
    } catch (platformError) {
      try {
        evt = this.s.webhooks.constructEvent(rawBody, signature, connectSecret);
        scope = "connect";
      } catch {
        throw platformError;
      }
    }
    // M1 (branch audit): carry the event's top-level connected-account marker
    // (`evt.account`) through to the dispatcher, present on a Connect event and
    // absent on a platform event.
    const e = evt as unknown as { id: string; type: string; account?: unknown; data: { object: Record<string, unknown> } };
    return {
      id: e.id, type: e.type, data: e.data, scope,
      account: typeof e.account === "string" ? e.account : undefined,
    };
  }
```

- [ ] **Step 5: paymentsWebhook.ts.** Line 4 becomes:

```ts
import {
  getStripe, stripeSecretKey, stripeWebhookSecret, stripeConnectWebhookSecret, StripeWebhookSecretMissingError,
  type VerifiedWebhookEvent,
} from "./stripeClient.js";
```

Line 170: `{ region: "us-central1", secrets: [stripeSecretKey, stripeWebhookSecret, stripeConnectWebhookSecret] },`

Line 178: `let event: VerifiedWebhookEvent;`

Lines 187-191 (inside the catch), the misconfiguration branch:

```ts
      if (e instanceof StripeWebhookSecretMissingError) {
        console.error(`stripeWebhook: ${e.secretName} is not configured, cannot verify signatures; refusing`, e);
        res.status(500).send("webhook misconfigured");
        return;
      }
```

After the shape check (the `if (!isValidDocId(event?.id) ...) { res.status(400).send("bad event"); return; }` block ending at line 202), add:

```ts
    // SP10 Task 4 (sp5 #3): the scope the SIGNATURE proved must match the scope
    // the EVENT claims. A platform-secret delivery carrying a connected-account
    // marker, or a Connect-secret delivery without one, is either a
    // misregistered endpoint or a forgery, and either way nothing downstream
    // may act on it. Refused at the boundary, before the claim machine records
    // anything, with the same flat 400 a bad signature gets; the per-handler
    // M1 guard below stays as defense in depth.
    if (event.scope === "platform" && event.account) {
      console.warn(`stripeWebhook: platform-signed event ${event.id} (${event.type}) carries account ${event.account}; refusing`);
      res.status(400).send("scope mismatch");
      return;
    }
    if (event.scope === "connect" && !event.account) {
      console.warn(`stripeWebhook: connect-signed event ${event.id} (${event.type}) carries no account; refusing`);
      res.status(400).send("scope mismatch");
      return;
    }
```

- [ ] **Step 6: Tests that post connected-account events sign them as such.** `functions/test/payments.test.ts` lines 89-96 and `functions/test/paymentsPayouts.test.ts` lines 115-121, replace `postWebhook` in both with:

```ts
async function postWebhook(body: unknown): Promise<{ status: number; text: string }> {
  // SP10 Task 4: a connected-account event (top-level `account`) is signed by
  // the Connect endpoint's secret; FakeStripe models that as "fake:connect".
  const isConnect = typeof (body as { account?: unknown } | null)?.account === "string";
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": isConnect ? "fake:connect" : "fake" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}
```

The forged-account case at `payments.test.ts:276-298` keeps its 200 expectation: it now arrives Connect-signed with a foreign account, passes the boundary, and is dropped by the handler's account pin exactly as before. The mismatch case at 266-273 posts no `account`, stays platform-signed, and is still a 200 no-op.

- [ ] **Step 7: README launch checklist.** Replace the bullet at lines 659-671 with:

```md
- **Register TWO webhook endpoints in the Stripe dashboard** (Developers, Webhooks, Add endpoint),
  both pointing at the deployed `stripeWebhook` function's HTTPS trigger URL (`firebase deploy`
  prints it; it also appears in the Firebase console under Functions):
  1. scope **"Events on your account"**, subscribed to `payment_intent.succeeded`,
     `payment_intent.payment_failed`, `transfer.reversed`, `charge.dispute.created`,
     `charge.dispute.closed` and `charge.refunded`; store its signing secret with
     `firebase functions:secrets:set STRIPE_WEBHOOK_SECRET`;
  2. scope **"Events on Connected accounts"**, subscribed to `account.updated`, `payout.paid` and
     `payout.failed`; store its signing secret with
     `firebase functions:secrets:set STRIPE_CONNECT_WEBHOOK_SECRET`.
  `stripeWebhook` verifies every delivery against the platform secret first, then the Connect secret,
  and refuses a delivery whose proven scope does not match the event (a platform-signed event carrying
  `account`, or a Connect-signed event without one). **Both secrets must be set**: the endpoint fails
  closed (HTTP 500, which Stripe retries) until they are. `transfer.reversed` is the only way the
  platform learns about an earnings transfer reversed from the dashboard; the two dispute events and
  `charge.refunded` are what record chargebacks and dashboard refunds (sub-project 10). Register a
  separate pair of endpoints with their own secrets when flipping to live mode.
```

- [ ] **Step 8: Run, expect pass.** `pnpm emu:test`: the tripwire, the four scope cases, and every existing webhook case pass. `pnpm typecheck` 5/5.

- [ ] **Step 9: Commit.** `git commit -m "feat(payments): verify webhooks against the platform and Connect secrets and refuse cross-scope events (sp5 #3)"`

---

### Task 5: Dispute records and `charge.dispute.created` (sp5 #2)

**Files:**
- Create: `functions/src/paymentsDisputes.ts`
- Create: `functions/test/paymentsDisputes.test.ts`
- Modify: `functions/src/stripeClient.ts` (StripeLike after `retrieveIntentStatus` at 161; FakeStripe after 505-511; RealStripe after 844-847)
- Modify: `functions/src/paymentsCore.ts` (alert ids after `payoutFeeAlertId` 826-828; `clearDelinquencyIfSettled` 711-731)
- Modify: `functions/src/paymentsWebhook.ts` (import 8; registrations after line 84; the registry comment 19-34)

**Interfaces (Consumes):** `DisputeRecord` (Task 1) with the extra `curatorProfileId?: string`; `writeLedger`, `recordAdminAlert`, `declareCuratorDelinquent`, `getStripeProfileDoc` (`paymentsCore.ts:247, 842, 669, 45`); `notifyProfileMembers` (`notifications.ts:27`); `WebhookHandler` (`paymentsWebhook.ts:40`); `disputes/{id}` rules block (Task 2, admin read only).

**Interfaces (Produces):**
```ts
// stripeClient.ts (StripeLike)
retrieveIntent(intentId: string): Promise<{
  status: string; amountCents: number; chargeId: string | null; metadata: Record<string, string>;
} | null>;                                             // null when Stripe has no such intent

// paymentsCore.ts
export function disputeAlertId(disputeId: string): string;          // `dispute:${disputeId}`
export function disputeReversalAlertId(disputeId: string): string;  // `dispute-reversal:${disputeId}`
export function externalRefundAlertId(refundId: string): string;    // `external-refund:${refundId}`

// paymentsDisputes.ts
export type DisputePurpose = DisputeRecord["purpose"];
export interface ChargeTarget {
  purpose: DisputePurpose; intentId: string; chargeId: string | null; amountCents: number;
  bookingId?: string; gigId?: string; orderId?: string;
  curatorProfileId: string | null;   // null for a ticket order (the fan paid)
}
export async function resolveChargeTarget(intentId: string): Promise<ChargeTarget | null>;
export const disputeCreatedHandler: WebhookHandler;
export const disputeClosedHandler: WebhookHandler;   // Task 6
export const chargeRefundedHandler: WebhookHandler;  // Task 6
```

- [ ] **Step 1: Failing tests.** Create `functions/test/paymentsDisputes.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn, makeMoneyReady, setGigStartsAt, ageConfirmedAt,
} from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import {
  computeDepositCents, computeExpectedTotalCents, computeFeeShareCents, DEFAULT_FEE_POLICY,
  type AdminAlertDoc, type DisputeRecord, type LedgerEntry, type NotificationDoc, type PaymentDoc,
  type ProfileDraftInput, type StripeProfileDoc, type TicketOrderDoc, type EventDoc,
} from "@gatekeep/shared";
import { runPaymentsSweep } from "../src/paymentsSweep.js";
import { disputeAlertId, disputeReversalAlertId, externalRefundAlertId } from "../src/paymentsCore.js";
import { EVENT_SETTLE_DELAY_MS } from "../src/eventsCore.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
const WEBHOOK_URL = "http://localhost:5001/gatekeep-dev-jg/us-central1/stripeWebhook";
vi.setConfig({ testTimeout: 60_000 });

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const FEE = DEFAULT_FEE_POLICY;
const RATE_CENTS = 15_000;
const DURATION_MINUTES = 90;
const BASE_CENTS = computeExpectedTotalCents("perHour", RATE_CENTS, { durationMinutes: DURATION_MINUTES });
const SLICE_CENTS = computeDepositCents(BASE_CENTS);
const DEPOSIT_CHARGE_CENTS = SLICE_CENTS + computeFeeShareCents(SLICE_CENTS, FEE.curatorFeePct);

// ---------- fixtures (the paymentsSettlement.test.ts and eventsSettlement.test.ts shapes) ----------

async function makeApprovedCuratorProfile(emailPrefix: string) {
  const owner = await signUpTestUser(`${emailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "curator", subtype: "venue", name: "The Green Room", handle: `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    owner.user);
  await seedCuratorGateContent(adb, profileId);
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const reviewer = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, reviewer.user);
  return { owner, profileId };
}

async function makeApprovedMusicianProfile(emailPrefix: string) {
  const owner = await signUpTestUser(`${emailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "musician", subtype: "solo", name: "The Act", handle: `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    owner.user);
  await adb.doc(`profiles/${profileId}`).update({
    "portfolio.bio": "A great live act.", "portfolio.genres": ["rock"],
    "portfolio.avatarPhotoPath": "public/photos/seed/avatar-seed.jpg",
  });
  await adb.doc(`profiles/${profileId}/tracks/seed-track`).set({
    title: "Demo", status: "approved", uploaderUid: owner.uid, startSec: 0, durationSec: 20,
    storagePath: "public/tracks/seed/demo.m4a", rejectionReason: null, failureReason: null, order: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const reviewer = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, reviewer.user);
  return { owner, profileId };
}

function gigContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Friday Night Jazz", description: "A cozy weekly set in the back room.",
    wants: { genres: ["rock"], actSizes: ["band"] }, durationMinutes: DURATION_MINUTES,
    provisions: { hasPA: null, hasBackline: null, notes: null },
    budget: { minCents: 10_000, maxCents: 20_000, structure: "perHour" },
    startsAt: Date.now() + 7 * DAY_MS, ...overrides,
  };
}

async function createOpenGig(profileId: string, user: import("firebase/auth").User): Promise<string> {
  const { gigId } = await callFn<Record<string, unknown>, { gigId: string }>("createGig", { profileId, ...gigContent() }, user);
  await callFn("publishGig", { gigId }, user);
  return gigId;
}

async function makeConfirmedBooking(prefix: string, opts: { pastStartHours?: number } = {}) {
  const curator = await makeApprovedCuratorProfile(`${prefix}c`);
  const musician = await makeApprovedMusicianProfile(`${prefix}m`);
  await makeMoneyReady(curator, musician);
  const gigId = await createOpenGig(curator.profileId, curator.owner.user);
  if (opts.pastStartHours != null) await setGigStartsAt(gigId, -opts.pastStartHours);
  const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
    "applyToGig", { gigId, musicianProfileId: musician.profileId, offer: { amountCents: RATE_CENTS, note: "Hi" } }, musician.owner.user);
  await callFn("acceptBooking", { bookingId }, curator.owner.user);
  return { curator, musician, gigId, bookingId };
}

async function settleBooking(bookingId: string, gigId: string): Promise<PaymentDoc> {
  await runPaymentsSweep(Date.now()); // step 4 schedules
  await adb.doc(`bookings/${bookingId}/payments/${gigId}`).update({ "settlement.settleAfter": Date.now() - 1000 });
  await runPaymentsSweep(Date.now()); // step 5 charges and transfers
  const p = (await adb.doc(`bookings/${bookingId}/payments/${gigId}`).get()).data() as PaymentDoc;
  expect(p.settlement.status).toBe("paid");
  return p;
}

async function getPayment(bookingId: string, gigId: string): Promise<PaymentDoc> {
  return (await adb.doc(`bookings/${bookingId}/payments/${gigId}`).get()).data() as PaymentDoc;
}
async function getStripeDoc(profileId: string): Promise<StripeProfileDoc | undefined> {
  return (await adb.doc(`profiles/${profileId}/private/stripe`).get()).data() as StripeProfileDoc | undefined;
}
async function fakeObject(id: string): Promise<Record<string, unknown> | undefined> {
  return (await adb.doc(`stripeFake/state/objects/${id}`).get()).data();
}
async function accountBalanceCents(accountId: string): Promise<number> {
  return ((await fakeObject(accountId))?.balanceCents as number | undefined) ?? 0;
}
async function ledgerRow(id: string): Promise<LedgerEntry | undefined> {
  return (await adb.doc(`ledger/${id}`).get()).data() as LedgerEntry | undefined;
}
async function adminAlert(alertId: string): Promise<AdminAlertDoc | undefined> {
  return (await adb.doc(`adminAlerts/${alertId}`).get()).data() as AdminAlertDoc | undefined;
}
async function disputeDoc(disputeId: string): Promise<DisputeRecord | undefined> {
  return (await adb.doc(`disputes/${disputeId}`).get()).data() as DisputeRecord | undefined;
}
async function notificationsFor(uid: string): Promise<NotificationDoc[]> {
  return (await adb.collection(`users/${uid}/notifications`).get()).docs.map((d) => d.data() as NotificationDoc);
}

function fakeEvent(type: string, object: Record<string, unknown>, id = `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`) {
  return { id, type, data: { object } };
}
async function postWebhook(body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": "fake" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

// A Stripe Dispute object as the webhook delivers it (the fields the handlers read).
function disputeObject(p: {
  id: string; intentId: string; chargeId: string | null; amountCents: number; status: string; feeCents?: number;
}): Record<string, unknown> {
  return {
    id: p.id, object: "dispute", amount: p.amountCents, charge: p.chargeId, payment_intent: p.intentId,
    reason: "fraudulent", status: p.status, currency: "usd",
    balance_transactions: [{ id: `txn_${p.id}`, fee: p.feeCents ?? 1500, amount: -p.amountCents }],
  };
}
function newDisputeId(): string { return `dp_fake_${Date.now()}_${Math.floor(Math.random() * 1e6)}`; }

// ---------- ticket fixtures ----------
function eventContent(): Record<string, unknown> {
  const startsAt = Date.now() + 7 * DAY_MS;
  return {
    title: "Friday Night Jazz Showcase", description: "An evening of live jazz.",
    startsAt, endsAt: startsAt + 3 * HOUR_MS, lineup: [{ kind: "external", name: "The Quartet" }],
  };
}
async function makePublishedEvent(prefix: string, priceCents: number) {
  const { owner, profileId } = await makeApprovedCuratorProfile(prefix);
  const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>(
    "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent() }, owner.user);
  await callFn("setEventTiers", { curatorProfileId: profileId, eventId,
    tiers: [{ name: "General", priceCents, capacity: 50, saleStartsAt: null, saleEndsAt: null }] }, owner.user);
  await callFn("publishEvent", { curatorProfileId: profileId, eventId }, owner.user);
  const tiers = await adb.collection(`events/${eventId}/tiers`).get();
  return { owner, profileId, eventId, tierId: tiers.docs[0].id };
}
async function payOrder(eventId: string, tierId: string, quantity: number, prefix: string) {
  const buyer = await signUpTestUser(`${prefix}-${Date.now()}@test.com`);
  const { orderId, clientSecret } = await callFn<Record<string, unknown>, { orderId: string; clientSecret: string | null }>(
    "createTicketOrder", { eventId, items: [{ tierId, quantity }] }, buyer.user);
  const intentId = clientSecret!.replace(/_secret_fake$/, "");
  await adb.doc(`stripeFake/state/objects/${intentId}`).update({ status: "succeeded", chargeId: `ch_${intentId}` });
  await callFn("finalizeTicketOrder", { orderId }, buyer.user);
  return { buyer, orderId, intentId, chargeId: `ch_${intentId}` };
}
async function makeCuratorPayoutReady(profileId: string, ownerUser: import("firebase/auth").User): Promise<string> {
  await callFn("createOnboardingLink", { profileId }, ownerUser);
  const sp = (await adb.doc(`profiles/${profileId}/private/stripe`).get()).data();
  await adb.doc(`stripeFake/state/objects/${sp!.accountId}`).set(
    { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });
  await adb.doc(`profiles/${profileId}/private/stripe`).set(
    { transfersEnabled: true, payoutsEnabled: true, instantEligible: true }, { merge: true });
  return sp!.accountId as string;
}

describe("SP10 Task 5: charge.dispute.created", () => {
  it("deposit charge: ledger row, alert, delinquency, notification, dispute record", async () => {
    const { curator, gigId, bookingId } = await makeConfirmedBooking("dc1");
    const p = await getPayment(bookingId, gigId);
    expect(p.deposit.status).toBe("held");
    const disputeId = newDisputeId();
    const evt = fakeEvent("charge.dispute.created", disputeObject({
      id: disputeId, intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: DEPOSIT_CHARGE_CENTS, status: "needs_response",
    }));
    expect((await postWebhook(evt)).status).toBe(200);

    const row = await ledgerRow(`dispute_opened:${disputeId}`);
    expect(row?.kind).toBe("dispute_opened");
    expect(row?.amountCents).toBe(DEPOSIT_CHARGE_CENTS);
    expect(row?.bookingId).toBe(bookingId);
    expect(row?.profileId).toBe(curator.profileId);
    expect(row?.detail).toContain("fee 1500c");
    expect(row?.detail).toContain("fraudulent");

    const alert = await adminAlert(disputeAlertId(disputeId));
    expect(alert?.kind).toBe("dispute_opened");
    expect(alert?.bookingId).toBe(bookingId);
    expect(alert?.resolvedAt).toBeNull();

    expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(true);
    expect((await notificationsFor(curator.owner.uid)).some((n) => n.title === "A payment was disputed")).toBe(true);

    const rec = await disputeDoc(disputeId);
    expect(rec).toMatchObject({
      chargeId: p.deposit.chargeId, intentId: p.deposit.intentId, purpose: "deposit", bookingId,
      amountCents: DEPOSIT_CHARGE_CENTS, feeCents: 1500, reason: "fraudulent", status: "open",
      curatorProfileId: curator.profileId,
    });
    expect(typeof rec?.openedAt).toBe("number");

    // A settlement paid for another date must NOT lift the dispute gate: the
    // open dispute is a debt clearDelinquencyIfSettled now sees.
    await adb.doc(`profiles/${curator.profileId}/private/stripe`).set({ delinquent: true }, { merge: true });
    const { clearDelinquencyIfSettled } = await import("../src/paymentsCore.js");
    await clearDelinquencyIfSettled(curator.profileId, Date.now());
    expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(true);

    // A fresh event id for the same dispute: the ledger row dedupes, the alert counts a recurrence.
    expect((await postWebhook(fakeEvent("charge.dispute.created", evt.data.object))).status).toBe(200);
    expect((await adminAlert(disputeAlertId(disputeId)))?.runCount).toBe(2);
    expect((await adb.collection("ledger").where("stripeId", "==", disputeId).get()).size).toBe(1);
  });

  it("settlement charge: the dispute record names the occurrence and the curator", async () => {
    const { curator, gigId, bookingId } = await makeConfirmedBooking("dc2", { pastStartHours: 5 });
    const paid = await settleBooking(bookingId, gigId);
    const chargeId = (await fakeObject(paid.settlement.intentId!))?.chargeId as string;
    const disputeId = newDisputeId();
    expect((await postWebhook(fakeEvent("charge.dispute.created", disputeObject({
      id: disputeId, intentId: paid.settlement.intentId!, chargeId, amountCents: 1000, status: "needs_response",
    })))).status).toBe(200);
    expect(await disputeDoc(disputeId)).toMatchObject({ purpose: "settlement", bookingId, gigId, curatorProfileId: curator.profileId, status: "open" });
    expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(true);
  });

  it("ticket order: the order is stamped open and no curator is flagged", async () => {
    const { profileId, eventId, tierId } = await makePublishedEvent("dc3", 1000);
    const { orderId, intentId, chargeId } = await payOrder(eventId, tierId, 2, "dc3buyer");
    const disputeId = newDisputeId();
    expect((await postWebhook(fakeEvent("charge.dispute.created", disputeObject({
      id: disputeId, intentId, chargeId, amountCents: 2000, status: "needs_response",
    })))).status).toBe(200);

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.disputeId).toBe(disputeId);
    expect(order.disputeStatus).toBe("open");
    expect(await disputeDoc(disputeId)).toMatchObject({ purpose: "tickets", orderId, status: "open", curatorProfileId: null });
    expect((await getStripeDoc(profileId))?.delinquent).not.toBe(true);
    expect((await adminAlert(disputeAlertId(disputeId)))?.kind).toBe("dispute_opened");
  });

  it("a dispute on an intent Stripe does not know is recorded (200) and escalated, never thrown", async () => {
    const disputeId = newDisputeId();
    const evt = fakeEvent("charge.dispute.created", disputeObject({
      id: disputeId, intentId: "pi_unknown_1", chargeId: "ch_unknown_1", amountCents: 500, status: "needs_response",
    }));
    expect((await postWebhook(evt)).status).toBe(200);
    expect((await adb.doc(`stripeEvents/${evt.id}`).get()).data()?.processed).toBe(true);
    const alert = await adminAlert(disputeAlertId(disputeId));
    expect(alert?.kind).toBe("dispute_opened");
    expect(alert?.detail).toContain("could not be resolved");
    expect(await disputeDoc(disputeId)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, confirm failures.** The four cases fail on `status` being 200 with nothing written: `charge.dispute.created` has no handler, so `ledgerRow(...)` is undefined and `expect(row?.kind).toBe("dispute_opened")` fails first; the ticket case fails on `order.disputeId` undefined; the unknown-intent case fails on the missing alert.

- [ ] **Step 3: `retrieveIntent` on StripeLike.** `functions/src/stripeClient.ts`, after `retrieveIntentStatus` in the interface (line 161):

```ts
  // SP10 Task 5: the whole PaymentIntent a dispute or refund event points at,
  // metadata included. The dispute handlers resolve a charge to its intent and
  // then to a payment doc or ticket order through `metadata.purpose`, exactly
  // the vocabulary paymentsWebhook.ts dispatches on. null when Stripe has no
  // such intent (a dispute on a charge this platform never created).
  retrieveIntent(intentId: string): Promise<{
    status: string; amountCents: number; chargeId: string | null; metadata: Record<string, string>;
  } | null>;
```

FakeStripe, after `retrieveIntentStatus` (line 511):

```ts
  async retrieveIntent(intentId: string) {
    const snap = await this.objRef(intentId).get();
    if (!snap.exists || snap.data()?.kind !== "payment_intent") return null;
    const d = snap.data()!;
    return {
      status: d.status as string, amountCents: d.amountCents as number,
      chargeId: typeof d.chargeId === "string" ? d.chargeId : null,
      metadata: (d.meta as Record<string, string> | undefined) ?? {},
    };
  }
```

RealStripe, after `retrieveIntentStatus` (line 847):

```ts
  async retrieveIntent(intentId: string) {
    let pi: Stripe.PaymentIntent;
    try {
      pi = await this.s.paymentIntents.retrieve(intentId);
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === "resource_missing") return null;
      throw e;
    }
    const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : (pi.latest_charge?.id ?? null);
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(pi.metadata ?? {})) if (typeof v === "string") metadata[k] = v;
    return { status: pi.status, amountCents: pi.amount, chargeId, metadata };
  }
```

- [ ] **Step 4: Alert ids and the delinquency gate.** `functions/src/paymentsCore.ts`, after `payoutFeeAlertId` (line 828):

```ts
// SP10 Task 5 (sp5 #2): a chargeback. Scoped to the DISPUTE, not the
// occurrence: one dispute is one operator conversation with Stripe, whatever
// it lands on, and `closed` updates the same row `created` opened.
export function disputeAlertId(disputeId: string): string { return `dispute:${disputeId}`; }
// SP10 Task 6: a lost dispute whose matching transfer could not be reversed
// (the reversal threw, or no transfer exists to reverse). Its own row: the
// dispute row records the chargeback, this one records the unfinished unwind.
export function disputeReversalAlertId(disputeId: string): string { return `dispute-reversal:${disputeId}`; }
// SP10 Task 6: a refund issued from the Stripe dashboard against a charge the
// system still reads as paid. Scoped to the refund.
export function externalRefundAlertId(refundId: string): string { return `external-refund:${refundId}`; }
```

In `clearDelinquencyIfSettled` (lines 711-731), before the final `set(...)`, add a third question:

```ts
  // SP10 Task 5 (sp5 #2): an OPEN dispute on one of this curator's charges is
  // a debt too. Without this, the next ordinary settlement would lift the gate
  // the dispute handler just closed. Two equality filters on `disputes`, served
  // by merged single-field indexes; no composite needed.
  const openDispute = await db.collection("disputes")
    .where("curatorProfileId", "==", curatorProfileId)
    .where("status", "==", "open")
    .limit(1).get();
  if (!openDispute.empty) return;
```

and extend the function's header comment list of questions with "3. DISPUTE debt: any `disputes` record naming this profile still `open`."

- [ ] **Step 5: The module.** Create `functions/src/paymentsDisputes.ts`:

```ts
/**
 * SP10 Task 5 and 6 (sp5 #2): chargebacks and dashboard refunds.
 *
 * Three webhook handlers, registered from paymentsWebhook.ts (that file's
 * registry, not this one, so this module never imports it back and no cycle
 * forms), each resolving the charge to its PaymentIntent (through Stripe, whose
 * metadata is the same `purpose` vocabulary the succeeded-intent dispatcher
 * uses) and then to a payment doc or a ticket order:
 *  - charge.dispute.created: record (ledger, DisputeRecord), alert, gate the
 *    curator (deposit / settlement / paydue purposes), stamp the order (tickets).
 *  - charge.dispute.closed: lost reverses the matching transfer; won clears.
 *  - charge.refunded: a refund the ledger does not know is a dashboard refund.
 *
 * Owner decision 4 (spec section 2): record, alert and gate on open; reverse
 * on lost; clear on won. Evidence submission stays manual in Stripe.
 *
 * Every handler tolerates redelivery: ledger rows key on the dispute or refund
 * id, DisputeRecord writes are merge-sets, reversals carry their own
 * idempotency key, and an already-closed record is a no-op.
 */

import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { isValidDocId } from "@gatekeep/shared";
import type {
  BookingRequestDoc, DisputeRecord, EventDoc, PaymentDoc, TicketOrderDoc,
} from "@gatekeep/shared";
import { getStripe } from "./stripeClient.js";
import { notifyProfileMembers } from "./notifications.js";
import type { WebhookHandler } from "./paymentsWebhook.js";
import {
  clearDelinquencyIfSettled, declareCuratorDelinquent, disputeAlertId, disputeReversalAlertId,
  externalRefundAlertId, recomputePaymentSummary, recordAdminAlert, writeLedger,
} from "./paymentsCore.js";

export type DisputePurpose = DisputeRecord["purpose"];

export interface ChargeTarget {
  purpose: DisputePurpose; intentId: string; chargeId: string | null; amountCents: number;
  bookingId?: string; gigId?: string; orderId?: string;
  curatorProfileId: string | null;
}

const CURATOR_PURPOSES: ReadonlySet<string> = new Set(["deposit", "settlement", "paydue", "paydue_deposit"]);

// The charge -> intent -> doc resolution every handler starts with. null when
// the intent is unknown to Stripe, carries no purpose we stamp, or names ids
// that do not validate (metadata is signature-verified, never shape-validated).
export async function resolveChargeTarget(intentId: string): Promise<ChargeTarget | null> {
  const intent = await getStripe().retrieveIntent(intentId);
  if (!intent) return null;
  const purpose = intent.metadata.purpose;
  const base = { intentId, chargeId: intent.chargeId, amountCents: intent.amountCents };
  if (purpose === "tickets") {
    const orderId = intent.metadata.orderId;
    if (!orderId || !isValidDocId(orderId)) return null;
    return { ...base, purpose: "tickets", orderId, curatorProfileId: null };
  }
  if (!purpose || !CURATOR_PURPOSES.has(purpose)) return null;
  const bookingId = intent.metadata.bookingId;
  if (!bookingId || !isValidDocId(bookingId)) return null;
  const gigId = intent.metadata.gigId;
  if (gigId != null && !isValidDocId(gigId)) return null;
  const booking = (await getFirestore().doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc | undefined;
  if (!booking) return null;
  return {
    ...base, purpose: purpose as DisputePurpose, bookingId, ...(gigId ? { gigId } : {}),
    curatorProfileId: booking.curatorProfileId,
  };
}

interface DisputePayload {
  disputeId: string; intentId: string | null; chargeId: string | null;
  amountCents: number; feeCents: number; reason: string; status: string;
}

// The fields the handlers read off a Stripe Dispute object. `payment_intent`
// and `charge` arrive as ids on a webhook delivery (never expanded).
function readDispute(object: Record<string, unknown>): DisputePayload | null {
  const disputeId = typeof object.id === "string" ? object.id : null;
  if (!disputeId || !isValidDocId(disputeId)) return null;
  const txns = Array.isArray(object.balance_transactions) ? object.balance_transactions as Array<{ fee?: unknown }> : [];
  const feeCents = txns.reduce((sum, t) => sum + (typeof t.fee === "number" ? t.fee : 0), 0);
  return {
    disputeId,
    intentId: typeof object.payment_intent === "string" ? object.payment_intent : null,
    chargeId: typeof object.charge === "string" ? object.charge : null,
    amountCents: typeof object.amount === "number" ? object.amount : 0,
    feeCents,
    reason: typeof object.reason === "string" ? object.reason : "unknown",
    status: typeof object.status === "string" ? object.status : "unknown",
  };
}

async function escalateUnresolvedDispute(d: DisputePayload, eventId: string, now: number): Promise<void> {
  const detail = `dispute ${d.disputeId} (${d.amountCents}c, reason ${d.reason}) on charge ${String(d.chargeId)} / intent`
    + ` ${String(d.intentId)} could not be resolved to a payment doc or ticket order; look it up in Stripe`;
  const alertId = disputeAlertId(d.disputeId);
  const shouldLog = await recordAdminAlert({ alertId, kind: "dispute_opened", detail, bookingId: null, gigId: null, now });
  if (shouldLog) console.error(`charge.dispute (event ${eventId}): ${detail} (see adminAlerts/${alertId})`);
}

export const disputeCreatedHandler: WebhookHandler = async (object, eventId) => {
  const d = readDispute(object);
  if (!d) {
    console.warn(`charge.dispute.created: payload carries no usable dispute id (event ${eventId})`);
    return;
  }
  const now = Date.now();
  const target = d.intentId ? await resolveChargeTarget(d.intentId) : null;
  if (!target) {
    await escalateUnresolvedDispute(d, eventId, now);
    return;
  }
  const db = getFirestore();
  const scope = target.purpose === "tickets"
    ? `ticket order ${target.orderId}`
    : `${target.purpose} for booking ${target.bookingId}${target.gigId ? `/${target.gigId}` : ""}`;

  // 1. The ledger row, keyed on the dispute id: what Stripe took, and why.
  await writeLedger({
    kind: "dispute_opened", amountCents: d.amountCents, bookingId: target.bookingId ?? null,
    gigId: target.gigId ?? null, profileId: target.curatorProfileId, stripeId: d.disputeId,
    detail: `dispute opened on ${scope}: ${d.amountCents}c withdrawn plus fee ${d.feeCents}c, reason ${d.reason}`,
    ...(target.purpose === "tickets" ? { eventId: null, buyerUid: null } : {}),
  }).catch((e) => console.error(`charge.dispute.created: ledger row failed for ${d.disputeId}`, e));

  // 2. The resolution state `closed` reads back. Merge-set, so a redelivery
  // after `closed` already ran cannot reopen a decided dispute.
  const existing = (await db.doc(`disputes/${d.disputeId}`).get()).data() as DisputeRecord | undefined;
  if (!existing) {
    const record: DisputeRecord & { curatorProfileId: string | null } = {
      chargeId: d.chargeId ?? target.chargeId ?? "", intentId: target.intentId, purpose: target.purpose,
      ...(target.bookingId ? { bookingId: target.bookingId } : {}),
      ...(target.gigId ? { gigId: target.gigId } : {}),
      ...(target.orderId ? { orderId: target.orderId } : {}),
      amountCents: d.amountCents, feeCents: d.feeCents, reason: d.reason, status: "open", openedAt: now,
      curatorProfileId: target.curatorProfileId,
    };
    await db.doc(`disputes/${d.disputeId}`).set(record, { merge: true });
  }

  // 3. The durable escalation. Evidence is submitted by hand in Stripe; the
  // ledger and the booking thread are the evidence, and this row is what tells
  // an operator to go and assemble it.
  const alertId = disputeAlertId(d.disputeId);
  const shouldLog = await recordAdminAlert({
    alertId, kind: "dispute_opened",
    detail: `dispute ${d.disputeId} opened on ${scope}: ${d.amountCents}c plus fee ${d.feeCents}c, reason ${d.reason};`
      + " submit evidence in the Stripe dashboard (the ledger and the booking thread are the record)",
    bookingId: target.bookingId ?? null, gigId: target.gigId ?? null, now,
  });
  if (shouldLog) console.error(`charge.dispute.created: ${scope} disputed (see adminAlerts/${alertId})`);

  // 4. The gate and the word to the curator, for a curator charge.
  if (target.curatorProfileId) {
    await declareCuratorDelinquent(target.curatorProfileId, now)
      .catch((e) => console.error(`charge.dispute.created: delinquency flag failed for ${target.curatorProfileId}`, e));
    if (target.bookingId) {
      await recomputePaymentSummary(target.bookingId)
        .catch((e) => console.error(`charge.dispute.created: summary recompute failed for ${target.bookingId}`, e));
    }
    await notifyProfileMembers(target.curatorProfileId, {
      kind: "booking", refId: target.bookingId, title: "A payment was disputed",
      body: "Your bank has disputed a GateKeep charge. Booking is paused until the dispute is resolved.",
    }).catch((e) => console.error(`charge.dispute.created: notification failed for ${target.curatorProfileId}`, e));
  }

  // 5. The order stamp, for a ticket charge.
  if (target.purpose === "tickets" && target.orderId) {
    await db.doc(`orders/${target.orderId}`).update({ disputeId: d.disputeId, disputeStatus: "open" })
      .catch((e) => console.error(`charge.dispute.created: order stamp failed for ${target.orderId}`, e));
  }
};
```

(`disputeClosedHandler` and `chargeRefundedHandler` are added to this file in Task 6; export placeholders are not written now, Task 6 appends the real code.)

- [ ] **Step 6: Register.** `functions/src/paymentsWebhook.ts`: after the ticketing import at line 8 add `import { disputeCreatedHandler } from "./paymentsDisputes.js";` and after line 84 add:

```ts
// SP10 Task 5 (sp5 #2): chargebacks. Registered here for the same reason the
// tickets purpose is: this file stays the one place the full registry lives.
webhookHandlers["charge.dispute.created"] = disputeCreatedHandler;
```

Extend the header registry comment (lines 19-34) with the line `//  - charge.dispute.created / charge.dispute.closed / charge.refunded -> paymentsDisputes.ts (SP10)`.

- [ ] **Step 7: Run, expect pass.** `pnpm emu:test`: the four created cases pass. `pnpm typecheck` 5/5 (the `disputes` rules block from Task 2 is what makes the admin-read shape hold; the emulator test writes through the Admin SDK).

- [ ] **Step 8: Commit.** `git commit -m "feat(payments): record, alert on, and gate curator charges for an opened dispute (sp5 #2)"`

---

### Task 6: `charge.dispute.closed` and `charge.refunded` (sp5 #2)

**Files:**
- Modify: `functions/src/paymentsDisputes.ts` (append the two handlers)
- Modify: `functions/src/stripeClient.ts` (StripeLike `reverseTransfer` 190; FakeStripe.reverseTransfer 577-599; RealStripe.reverseTransfer 867-870)
- Modify: `functions/src/paymentsWebhook.ts` (two registrations after the Task 5 one)
- Modify: `functions/test/paymentsDisputes.test.ts` (two new describes)

**Interfaces (Produces):**
```ts
// StripeLike
reverseTransfer(params: { transferId: string; idempotencyKey: string; amountCents?: number }): Promise<{ id: string }>;
// FakeStripe: a partial reversal accumulates `reversedCents` on the transfer object and refuses one
// that would exceed the transfer; `reversed: true` only once fully reversed (the existing full
// reversal keeps its "already been reversed" refusal).
```

- [ ] **Step 1: Failing tests.** Append to `functions/test/paymentsDisputes.test.ts`:

```ts
async function openDispute(p: { intentId: string; chargeId: string | null; amountCents: number }): Promise<string> {
  const disputeId = newDisputeId();
  expect((await postWebhook(fakeEvent("charge.dispute.created", disputeObject({
    id: disputeId, intentId: p.intentId, chargeId: p.chargeId, amountCents: p.amountCents, status: "needs_response",
  })))).status).toBe(200);
  return disputeId;
}
async function closeDispute(p: { disputeId: string; intentId: string; chargeId: string | null; amountCents: number; status: "won" | "lost" }) {
  return postWebhook(fakeEvent("charge.dispute.closed", disputeObject({
    id: p.disputeId, intentId: p.intentId, chargeId: p.chargeId, amountCents: p.amountCents, status: p.status,
  })));
}

describe("SP10 Task 6: charge.dispute.closed", () => {
  it("lost settlement: the earnings transfer is reversed, the doc says so, the record closes", async () => {
    const { musician, gigId, bookingId } = await makeConfirmedBooking("dl1", { pastStartHours: 5 });
    const paid = await settleBooking(bookingId, gigId);
    const accountId = (await getStripeDoc(musician.profileId))!.accountId!;
    const before = await accountBalanceCents(accountId);
    expect(before).toBe(paid.transfer.amountCents);
    const chargeId = (await fakeObject(paid.settlement.intentId!))?.chargeId as string;
    const disputeId = await openDispute({ intentId: paid.settlement.intentId!, chargeId, amountCents: 5000 });

    const res = await closeDispute({ disputeId, intentId: paid.settlement.intentId!, chargeId, amountCents: 5000, status: "lost" });
    expect(res.status).toBe(200);

    expect(await accountBalanceCents(accountId)).toBe(0);
    expect(await fakeObject(paid.transfer.id!).then((t) => t?.reversed)).toBe(true);
    const after = await getPayment(bookingId, gigId);
    expect(after.transfer.status).toBe("reversed");
    const rec = await disputeDoc(disputeId);
    expect(rec?.status).toBe("lost");
    expect(rec?.reversalTransferId).toBeTruthy();
    expect(typeof rec?.closedAt).toBe("number");
    const row = await ledgerRow(`dispute_lost:${disputeId}`);
    expect(row?.amountCents).toBe(5000);
    expect(row?.detail).toContain(rec!.reversalTransferId!);
    expect(await adb.doc(`stripeFake/state/idem/${encodeURIComponent(`dispute_reverse:${disputeId}`)}`).get().then((s) => s.exists)).toBe(true);
    // Redelivery: nothing moves twice.
    expect((await closeDispute({ disputeId, intentId: paid.settlement.intentId!, chargeId, amountCents: 5000, status: "lost" })).status).toBe(200);
    expect(await accountBalanceCents(accountId)).toBe(0);
  });

  it("lost deposit with a forfeit: the forfeit transfer is reversed", async () => {
    const { curator, musician, gigId, bookingId } = await makeConfirmedBooking("dl2");
    await setGigStartsAt(gigId, 10);
    await ageConfirmedAt(bookingId);
    await callFn("cancelBooking", { bookingId, reason: "Venue flooded." }, curator.owner.user);
    const p = await getPayment(bookingId, gigId);
    expect(p.deposit.status).toBe("forfeited");
    const accountId = (await getStripeDoc(musician.profileId))!.accountId!;
    expect(await accountBalanceCents(accountId)).toBe(SLICE_CENTS);

    const disputeId = await openDispute({ intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: DEPOSIT_CHARGE_CENTS });
    expect((await closeDispute({ disputeId, intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: DEPOSIT_CHARGE_CENTS, status: "lost" })).status).toBe(200);
    expect(await accountBalanceCents(accountId)).toBe(0);
    expect(await fakeObject(p.deposit.forfeitTransferId!).then((t) => t?.reversed)).toBe(true);
    expect((await disputeDoc(disputeId))?.status).toBe("lost");
  });

  it("lost deposit with NO transfer (still held): dispute_reversal_failed, nothing moves", async () => {
    const { gigId, bookingId } = await makeConfirmedBooking("dl3");
    const p = await getPayment(bookingId, gigId);
    const disputeId = await openDispute({ intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: DEPOSIT_CHARGE_CENTS });
    expect((await closeDispute({ disputeId, intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: DEPOSIT_CHARGE_CENTS, status: "lost" })).status).toBe(200);
    const alert = await adminAlert(disputeReversalAlertId(disputeId));
    expect(alert?.kind).toBe("dispute_reversal_failed");
    expect(alert?.detail).toContain("no transfer");
    expect((await disputeDoc(disputeId))?.status).toBe("lost");
    expect((await ledgerRow(`dispute_lost:${disputeId}`))?.kind).toBe("dispute_lost");
  });

  it("lost settlement whose reversal Stripe refuses: dispute_reversal_failed", async () => {
    const { gigId, bookingId } = await makeConfirmedBooking("dl4", { pastStartHours: 5 });
    const paid = await settleBooking(bookingId, gigId);
    const chargeId = (await fakeObject(paid.settlement.intentId!))?.chargeId as string;
    // Reverse it first by hand (a dashboard reversal): the dispute's reversal then throws "already reversed".
    await adb.doc(`stripeFake/state/objects/${paid.transfer.id}`).update({ reversed: true });
    const disputeId = await openDispute({ intentId: paid.settlement.intentId!, chargeId, amountCents: 1000 });
    expect((await closeDispute({ disputeId, intentId: paid.settlement.intentId!, chargeId, amountCents: 1000, status: "lost" })).status).toBe(200);
    const alert = await adminAlert(disputeReversalAlertId(disputeId));
    expect(alert?.kind).toBe("dispute_reversal_failed");
    expect(alert?.detail).toContain("already been reversed");
  });

  it("lost ticket dispute AFTER settlement: a partial reversal of the ticket_settlement transfer for the order's face value", async () => {
    const { owner, profileId, eventId, tierId } = await makePublishedEvent("dl5", 1000);
    const a = await payOrder(eventId, tierId, 2, "dl5a");
    await payOrder(eventId, tierId, 3, "dl5b");
    const accountId = await makeCuratorPayoutReady(profileId, owner.user);
    await adb.doc(`events/${eventId}`).update({ endsAt: Date.now() - EVENT_SETTLE_DELAY_MS - HOUR_MS });
    await runPaymentsSweep(Date.now());
    expect(((await adb.doc(`events/${eventId}`).get()).data() as EventDoc).status).toBe("completed");
    expect(await accountBalanceCents(accountId)).toBe(5000);

    const disputeId = await openDispute({ intentId: a.intentId, chargeId: a.chargeId, amountCents: 2000 + 2 * 169 });
    expect((await closeDispute({ disputeId, intentId: a.intentId, chargeId: a.chargeId, amountCents: 2000 + 2 * 169, status: "lost" })).status).toBe(200);
    expect(await accountBalanceCents(accountId)).toBe(3000); // 5000 minus this order's 2000 face
    const order = (await adb.doc(`orders/${a.orderId}`).get()).data() as TicketOrderDoc;
    expect(order.disputeStatus).toBe("lost");
    expect((await disputeDoc(disputeId))?.reversalTransferId).toBeTruthy();
  });

  it("lost ticket dispute BEFORE settlement: the pending settlement basis shrinks by the order's face value", async () => {
    const { owner, profileId, eventId, tierId } = await makePublishedEvent("dl6", 1000);
    const a = await payOrder(eventId, tierId, 2, "dl6a");
    await payOrder(eventId, tierId, 3, "dl6b");
    const disputeId = await openDispute({ intentId: a.intentId, chargeId: a.chargeId, amountCents: 2338 });
    expect((await closeDispute({ disputeId, intentId: a.intentId, chargeId: a.chargeId, amountCents: 2338, status: "lost" })).status).toBe(200);
    const order = (await adb.doc(`orders/${a.orderId}`).get()).data() as TicketOrderDoc;
    expect(order.refundedFaceCents).toBe(2000);
    expect(order.disputeStatus).toBe("lost");
    expect((await disputeDoc(disputeId))?.reversalTransferId).toBeUndefined();

    const accountId = await makeCuratorPayoutReady(profileId, owner.user);
    await adb.doc(`events/${eventId}`).update({ endsAt: Date.now() - EVENT_SETTLE_DELAY_MS - HOUR_MS });
    await runPaymentsSweep(Date.now());
    expect(await accountBalanceCents(accountId)).toBe(3000); // only the undisputed order settles
  });

  it("won: ledger dispute_won, record closed, curator gate lifted, order stamped won", async () => {
    const { curator, gigId, bookingId } = await makeConfirmedBooking("dw1");
    const p = await getPayment(bookingId, gigId);
    const disputeId = await openDispute({ intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: DEPOSIT_CHARGE_CENTS });
    expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(true);
    expect((await closeDispute({ disputeId, intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: DEPOSIT_CHARGE_CENTS, status: "won" })).status).toBe(200);
    expect((await ledgerRow(`dispute_won:${disputeId}`))?.kind).toBe("dispute_won");
    expect((await disputeDoc(disputeId))?.status).toBe("won");
    expect((await getStripeDoc(curator.profileId))?.delinquent).toBe(false);

    const { eventId, tierId } = await makePublishedEvent("dw2", 1000);
    const t = await payOrder(eventId, tierId, 1, "dw2a");
    const ticketDispute = await openDispute({ intentId: t.intentId, chargeId: t.chargeId, amountCents: 1169 });
    expect((await closeDispute({ disputeId: ticketDispute, intentId: t.intentId, chargeId: t.chargeId, amountCents: 1169, status: "won" })).status).toBe(200);
    expect(((await adb.doc(`orders/${t.orderId}`).get()).data() as TicketOrderDoc).disputeStatus).toBe("won");
  });

  it("closed for a dispute `created` never saw resolves the target itself", async () => {
    const { gigId, bookingId } = await makeConfirmedBooking("dw3");
    const p = await getPayment(bookingId, gigId);
    const disputeId = newDisputeId();
    expect((await closeDispute({ disputeId, intentId: p.deposit.intentId!, chargeId: p.deposit.chargeId, amountCents: 100, status: "won" })).status).toBe(200);
    expect((await disputeDoc(disputeId))).toMatchObject({ purpose: "deposit", bookingId, status: "won" });
  });
});

describe("SP10 Task 6: charge.refunded", () => {
  function chargeObject(p: { chargeId: string; intentId: string; refunds: Array<{ id: string; amount: number; metadata?: Record<string, string> }> }) {
    return {
      id: p.chargeId, object: "charge", payment_intent: p.intentId,
      amount_refunded: p.refunds.reduce((s, r) => s + r.amount, 0),
      refunds: { object: "list", data: p.refunds.map((r) => ({ id: r.id, object: "refund", amount: r.amount, metadata: r.metadata ?? {} })) },
    };
  }

  it("a dashboard refund on a held deposit: external_refund ledger row and alert", async () => {
    const { gigId, bookingId } = await makeConfirmedBooking("xr1");
    const p = await getPayment(bookingId, gigId);
    const refundId = `re_dash_${Date.now()}`;
    expect((await postWebhook(fakeEvent("charge.refunded", chargeObject({
      chargeId: p.deposit.chargeId!, intentId: p.deposit.intentId!, refunds: [{ id: refundId, amount: DEPOSIT_CHARGE_CENTS }],
    })))).status).toBe(200);
    const row = await ledgerRow(`external_refund:${refundId}`);
    expect(row?.kind).toBe("external_refund");
    expect(row?.amountCents).toBe(DEPOSIT_CHARGE_CENTS);
    expect(row?.bookingId).toBe(bookingId);
    const alert = await adminAlert(externalRefundAlertId(refundId));
    expect(alert?.kind).toBe("external_refund");
    expect(alert?.detail).toContain("still reads held");
  });

  it("our own refund (metadata.purpose set, ledger row present) is not an external refund", async () => {
    const { curator, gigId, bookingId } = await makeConfirmedBooking("xr2");
    await setGigStartsAt(gigId, 200);
    await ageConfirmedAt(bookingId);
    await callFn("cancelBooking", { bookingId, reason: "Plans changed." }, curator.owner.user);
    const p = await getPayment(bookingId, gigId);
    expect(p.deposit.status).toBe("refunded");
    const refundRow = (await adb.collection("ledger").where("bookingId", "==", bookingId).get()).docs
      .map((d) => d.data() as LedgerEntry).find((r) => r.kind === "refund")!;
    expect((await postWebhook(fakeEvent("charge.refunded", chargeObject({
      chargeId: p.deposit.chargeId!, intentId: p.deposit.intentId!,
      refunds: [{ id: refundRow.stripeId!, amount: refundRow.amountCents, metadata: { bookingId, gigId, purpose: "deposit_refund" } }],
    })))).status).toBe(200);
    expect(await ledgerRow(`external_refund:${refundRow.stripeId}`)).toBeUndefined();
    expect(await adminAlert(externalRefundAlertId(refundRow.stripeId!))).toBeUndefined();
  });

  it("a dashboard refund on a paid ticket order alerts; on an already refunded order it only records", async () => {
    const { eventId, tierId } = await makePublishedEvent("xr3", 1000);
    const t = await payOrder(eventId, tierId, 1, "xr3a");
    const refundId = `re_dash_${Date.now()}`;
    expect((await postWebhook(fakeEvent("charge.refunded", chargeObject({
      chargeId: t.chargeId, intentId: t.intentId, refunds: [{ id: refundId, amount: 1169 }],
    })))).status).toBe(200);
    expect((await ledgerRow(`external_refund:${refundId}`))?.buyerUid).toBe(t.buyer.uid);
    expect((await adminAlert(externalRefundAlertId(refundId)))?.detail).toContain("still reads paid");

    await adb.doc(`orders/${t.orderId}`).update({ status: "cancelled_refunded" });
    const refund2 = `re_dash2_${Date.now()}`;
    expect((await postWebhook(fakeEvent("charge.refunded", chargeObject({
      chargeId: t.chargeId, intentId: t.intentId, refunds: [{ id: refund2, amount: 1169 }],
    })))).status).toBe(200);
    expect((await ledgerRow(`external_refund:${refund2}`))?.kind).toBe("external_refund");
    expect(await adminAlert(externalRefundAlertId(refund2))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, confirm failures.** Every `closed` case fails at its first post-close assertion (no handler: balance unchanged, record still `open`); the `refunded` cases fail on the missing ledger row.

- [ ] **Step 3: Partial reversal on StripeLike.** `functions/src/stripeClient.ts` line 190 becomes:

```ts
  // `amountCents` (SP10 Task 6): a PARTIAL reversal. Omitted means the whole
  // transfer, exactly as before. FakeStripe accumulates `reversedCents` and
  // refuses a reversal that would exceed the transfer, as Stripe does.
  reverseTransfer(params: { transferId: string; idempotencyKey: string; amountCents?: number }): Promise<{ id: string }>;
```

Replace `FakeStripe.reverseTransfer` (lines 577-599):

```ts
  async reverseTransfer(p: { transferId: string; idempotencyKey: string; amountCents?: number }) {
    return this.idem(p.idempotencyKey, async () => {
      const tRef = this.objRef(p.transferId);
      const id = this.newId("trr");
      await this.db.runTransaction(async (tx) => {
        const tSnap = await tx.get(tRef);
        if (!tSnap.exists) throw new Error(`FakeStripe: reversal of unknown transfer ${p.transferId}`);
        const t = tSnap.data()!;
        if (t.kind !== "transfer") {
          throw new Error(`FakeStripe: reversal target ${p.transferId} is not a transfer (kind=${String(t.kind)})`);
        }
        if (t.reversed === true) {
          throw new Error(`FakeStripe: transfer ${p.transferId} has already been reversed`);
        }
        const total = t.amountCents as number;
        const already = (t.reversedCents as number | undefined) ?? 0;
        const amount = p.amountCents ?? (total - already);
        if (amount <= 0 || already + amount > total) {
          throw new Error(`FakeStripe: reversal of ${amount} exceeds what remains of transfer ${p.transferId} (${total - already})`);
        }
        const acct = this.objRef(t.accountId as string);
        const s = await tx.get(acct);
        tx.set(acct, { balanceCents: ((s.data()?.balanceCents as number | undefined) ?? 0) - amount }, { merge: true });
        tx.update(tRef, { reversedCents: already + amount, reversed: already + amount === total });
        tx.set(this.objRef(id), { kind: "transfer_reversal", transferId: p.transferId, amountCents: amount });
      });
      return { id };
    }, `${p.transferId}:${p.amountCents ?? "full"}`);
  }
```

Replace `RealStripe.reverseTransfer` (lines 867-870):

```ts
  async reverseTransfer(p: { transferId: string; idempotencyKey: string; amountCents?: number }) {
    const r = await this.s.transfers.createReversal(
      p.transferId, p.amountCents != null ? { amount: p.amountCents } : {}, { idempotencyKey: p.idempotencyKey });
    return { id: r.id };
  }
```

The clawback's existing full reversal (`paymentsSettlement.ts:1346-1348`) is unchanged: its fingerprint becomes `${transferId}:full`, and no persisted fake key from before this change survives an emulator restart.

- [ ] **Step 4: The handlers.** Append to `functions/src/paymentsDisputes.ts`:

```ts
// Reverses what a LOST dispute took back: the earnings transfer of a settled
// occurrence, the forfeit transfer(s) of a deposit, or the order's share of an
// event's ticket settlement. Returns the reversal id(s) joined by "," (one in
// every ordinary case), or null when there was nothing to reverse; throws when
// Stripe refuses. `reason` explains a null.
async function reverseForLostDispute(
  target: ChargeTarget, disputeId: string, now: number,
): Promise<{ reversalIds: string[]; reason: string | null }> {
  const db = getFirestore();
  const stripe = getStripe();
  if (target.purpose === "tickets") {
    const orderRef = db.doc(`orders/${target.orderId}`);
    const order = (await orderRef.get()).data() as TicketOrderDoc | undefined;
    if (!order) return { reversalIds: [], reason: "order missing" };
    const faceCents = order.faceTotalCents - order.refundedFaceCents;
    if (faceCents <= 0) return { reversalIds: [], reason: "order has no unrefunded face value" };
    const event = (await db.doc(`events/${order.eventId}`).get()).data() as EventDoc | undefined;
    if (event?.settlementStartedAt == null) {
      // Not settled yet: shrink the basis settleOneEvent will sum. No transfer
      // exists to reverse, and none is needed.
      await orderRef.update({ refundedFaceCents: FieldValue.increment(faceCents) });
      return { reversalIds: [], reason: null };
    }
    const settled = await db.collection("ledger")
      .where("kind", "==", "ticket_settlement").where("eventId", "==", order.eventId).limit(1).get();
    const transferId = settled.empty ? null : (settled.docs[0].data().stripeId as string | null);
    if (!transferId) return { reversalIds: [], reason: "no transfer: the event is marked settled but no ticket_settlement row names its transfer" };
    const r = await stripe.reverseTransfer({
      transferId, amountCents: faceCents, idempotencyKey: `dispute_reverse:${disputeId}`,
    });
    return { reversalIds: [r.id], reason: null };
  }

  const paymentsSnap = await db.collection(`bookings/${target.bookingId}/payments`).get();
  const docs = paymentsSnap.docs
    .map((d) => ({ ref: d.ref, gigId: d.id, p: d.data() as PaymentDoc }))
    .filter(({ gigId, p }) => target.gigId ? gigId === target.gigId : p.deposit.intentId === target.intentId);
  if (target.purpose === "settlement" || target.purpose === "paydue") {
    const hit = docs.find(({ p }) => p.settlement.intentId === target.intentId && p.transfer.status === "transferred" && p.transfer.id);
    if (!hit) return { reversalIds: [], reason: "no transfer: the settlement has no live earnings transfer to reverse" };
    const r = await stripe.reverseTransfer({ transferId: hit.p.transfer.id!, idempotencyKey: `dispute_reverse:${disputeId}` });
    await hit.ref.update({ "transfer.status": "reversed", updatedAt: now })
      .catch((e) => console.error(`charge.dispute.closed: transfer.status write failed for ${target.bookingId}/${hit.gigId}`, e));
    await recomputePaymentSummary(target.bookingId!)
      .catch((e) => console.error(`charge.dispute.closed: summary recompute failed for ${target.bookingId}`, e));
    return { reversalIds: [r.id], reason: null };
  }
  // deposit / paydue_deposit: every forfeit funded by this charge.
  const forfeits = docs.filter(({ p }) => p.deposit.status === "forfeited" && p.deposit.forfeitTransferId);
  if (forfeits.length === 0) return { reversalIds: [], reason: "no transfer: the deposit was never forfeited to the musician" };
  const ids: string[] = [];
  for (const f of forfeits) {
    const key = forfeits.length === 1 ? `dispute_reverse:${disputeId}` : `dispute_reverse:${disputeId}:${f.gigId}`;
    const r = await stripe.reverseTransfer({ transferId: f.p.deposit.forfeitTransferId!, idempotencyKey: key });
    ids.push(r.id);
  }
  await recomputePaymentSummary(target.bookingId!)
    .catch((e) => console.error(`charge.dispute.closed: summary recompute failed for ${target.bookingId}`, e));
  return { reversalIds: ids, reason: null };
}

export const disputeClosedHandler: WebhookHandler = async (object, eventId) => {
  const d = readDispute(object);
  if (!d) {
    console.warn(`charge.dispute.closed: payload carries no usable dispute id (event ${eventId})`);
    return;
  }
  if (d.status !== "won" && d.status !== "lost") {
    // Stripe also closes disputes as warning_closed etc. Nothing moved; recorded by the claim machine only.
    console.info(`charge.dispute.closed: ${d.disputeId} closed as ${d.status}, nothing to do (event ${eventId})`);
    return;
  }
  const now = Date.now();
  const db = getFirestore();
  const recRef = db.doc(`disputes/${d.disputeId}`);
  const existing = (await recRef.get()).data() as (DisputeRecord & { curatorProfileId?: string | null }) | undefined;
  if (existing && existing.status !== "open") {
    console.info(`charge.dispute.closed: ${d.disputeId} already ${existing.status}, replay ignored (event ${eventId})`);
    return;
  }
  // `created` may never have run (an endpoint registered mid-dispute); resolve
  // the target ourselves in that case, from the same intent.
  const target = existing
    ? {
      purpose: existing.purpose, intentId: existing.intentId, chargeId: existing.chargeId, amountCents: existing.amountCents,
      bookingId: existing.bookingId, gigId: existing.gigId, orderId: existing.orderId,
      curatorProfileId: existing.curatorProfileId ?? null,
    } satisfies ChargeTarget
    : (d.intentId ? await resolveChargeTarget(d.intentId) : null);
  if (!target) {
    await escalateUnresolvedDispute(d, eventId, now);
    return;
  }
  const scope = target.purpose === "tickets"
    ? `ticket order ${target.orderId}`
    : `${target.purpose} for booking ${target.bookingId}${target.gigId ? `/${target.gigId}` : ""}`;
  const baseRecord = {
    chargeId: d.chargeId ?? target.chargeId ?? "", intentId: target.intentId, purpose: target.purpose,
    ...(target.bookingId ? { bookingId: target.bookingId } : {}),
    ...(target.gigId ? { gigId: target.gigId } : {}),
    ...(target.orderId ? { orderId: target.orderId } : {}),
    amountCents: d.amountCents, feeCents: d.feeCents, reason: d.reason,
    openedAt: existing?.openedAt ?? now, curatorProfileId: target.curatorProfileId,
  };

  if (d.status === "won") {
    await writeLedger({
      kind: "dispute_won", amountCents: d.amountCents, bookingId: target.bookingId ?? null, gigId: target.gigId ?? null,
      profileId: target.curatorProfileId, stripeId: d.disputeId, detail: `dispute won on ${scope}: ${d.amountCents}c returned`,
    }).catch((e) => console.error(`charge.dispute.closed: dispute_won ledger row failed for ${d.disputeId}`, e));
    await recRef.set({ ...baseRecord, status: "won", closedAt: now }, { merge: true });
    if (target.purpose === "tickets" && target.orderId) {
      await db.doc(`orders/${target.orderId}`).update({ disputeId: d.disputeId, disputeStatus: "won" })
        .catch((e) => console.error(`charge.dispute.closed: order stamp failed for ${target.orderId}`, e));
    }
    if (target.curatorProfileId) {
      // The record now reads `won`, so the open-dispute question in
      // clearDelinquencyIfSettled no longer holds the gate; the other two
      // questions still can.
      await clearDelinquencyIfSettled(target.curatorProfileId, now)
        .catch((e) => console.error(`charge.dispute.closed: delinquency clear failed for ${target.curatorProfileId}`, e));
    }
    const alertId = disputeAlertId(d.disputeId);
    await db.doc(`adminAlerts/${alertId}`).set({ resolvedAt: now, detail: `dispute ${d.disputeId} on ${scope} was WON; nothing further to do` }, { merge: true })
      .catch((e) => console.error(`charge.dispute.closed: could not resolve alert ${alertId}`, e));
    return;
  }

  // LOST. Stripe already debited the platform; reverse the matching transfer
  // so the loss lands where the money went (owner decision 4).
  let reversalIds: string[] = [];
  let failure: string | null = null;
  try {
    const r = await reverseForLostDispute(target, d.disputeId, now);
    reversalIds = r.reversalIds;
    failure = r.reason;
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  await writeLedger({
    kind: "dispute_lost", amountCents: d.amountCents, bookingId: target.bookingId ?? null, gigId: target.gigId ?? null,
    profileId: target.curatorProfileId, stripeId: d.disputeId,
    detail: reversalIds.length > 0
      ? `dispute lost on ${scope}: ${d.amountCents}c plus fee ${d.feeCents}c; transfer reversed (${reversalIds.join(", ")})`
      : `dispute lost on ${scope}: ${d.amountCents}c plus fee ${d.feeCents}c; ${failure ?? "settlement basis reduced, no transfer to reverse"}`,
  }).catch((e) => console.error(`charge.dispute.closed: dispute_lost ledger row failed for ${d.disputeId}`, e));
  await recRef.set({
    ...baseRecord, status: "lost", closedAt: now,
    ...(reversalIds.length > 0 ? { reversalTransferId: reversalIds.join(",") } : {}),
  }, { merge: true });
  if (target.purpose === "tickets" && target.orderId) {
    await db.doc(`orders/${target.orderId}`).update({ disputeId: d.disputeId, disputeStatus: "lost" })
      .catch((e) => console.error(`charge.dispute.closed: order stamp failed for ${target.orderId}`, e));
  }
  if (failure) {
    const alertId = disputeReversalAlertId(d.disputeId);
    const shouldLog = await recordAdminAlert({
      alertId, kind: "dispute_reversal_failed",
      detail: `dispute ${d.disputeId} on ${scope} was LOST (${d.amountCents}c plus fee ${d.feeCents}c) and the matching transfer`
        + ` could not be reversed: ${failure}; finish the unwind in Stripe`,
      bookingId: target.bookingId ?? null, gigId: target.gigId ?? null, now,
    });
    if (shouldLog) console.error(`charge.dispute.closed: reversal failed for ${d.disputeId} (see adminAlerts/${alertId})`);
  }
  const alertId = disputeAlertId(d.disputeId);
  await db.doc(`adminAlerts/${alertId}`).set({
    resolvedAt: now, detail: `dispute ${d.disputeId} on ${scope} was LOST; see the dispute_lost ledger row${failure ? ` and adminAlerts/${disputeReversalAlertId(d.disputeId)}` : ""}`,
  }, { merge: true }).catch((e) => console.error(`charge.dispute.closed: could not resolve alert ${alertId}`, e));
};

// A refund the ledger does not know about is a DASHBOARD refund. Every refund
// this codebase issues carries `metadata.purpose` (RealStripe.refund forwards
// `meta`), and most also have a ledger row keyed on the refund id; a refund
// with neither was issued by hand.
export const chargeRefundedHandler: WebhookHandler = async (object, eventId) => {
  const chargeId = typeof object.id === "string" ? object.id : null;
  const intentId = typeof object.payment_intent === "string" ? object.payment_intent : null;
  const list = (object.refunds as { data?: unknown } | undefined)?.data;
  const refunds = Array.isArray(list)
    ? list.filter((r): r is { id: string; amount?: unknown; metadata?: unknown } => typeof (r as { id?: unknown }).id === "string")
    : [];
  if (!chargeId || refunds.length === 0) {
    console.info(`charge.refunded: no refund list on charge ${String(chargeId)} (event ${eventId})`);
    return;
  }
  const now = Date.now();
  const db = getFirestore();
  const target = intentId ? await resolveChargeTarget(intentId) : null;
  for (const refund of refunds) {
    if (!isValidDocId(refund.id)) continue;
    const purpose = (refund.metadata as Record<string, unknown> | undefined)?.purpose;
    if (typeof purpose === "string" && purpose.length > 0) continue; // ours
    const known = await db.collection("ledger").where("stripeId", "==", refund.id).limit(1).get();
    if (!known.empty) continue; // ours, keyed on the refund id
    const amountCents = typeof refund.amount === "number" ? refund.amount : 0;

    let stillPaid = false;
    let stateWord = "unknown";
    let buyerUid: string | null = null;
    if (target?.purpose === "tickets" && target.orderId) {
      const order = (await db.doc(`orders/${target.orderId}`).get()).data() as TicketOrderDoc | undefined;
      buyerUid = order?.buyerUid ?? null;
      stillPaid = order?.status === "paid";
      stateWord = order?.status ?? "missing";
    } else if (target?.bookingId) {
      const snap = await db.collection(`bookings/${target.bookingId}/payments`).get();
      const docs = snap.docs.map((d) => d.data() as PaymentDoc)
        .filter((p) => target.gigId ? p.gigId === target.gigId : (p.deposit.intentId === intentId || p.settlement.intentId === intentId));
      const isSettlementCharge = target.purpose === "settlement" || target.purpose === "paydue";
      stillPaid = docs.some((p) => isSettlementCharge
        ? p.settlement.status === "paid"
        : (p.deposit.status === "held" || p.deposit.status === "applied" || p.deposit.status === "forfeited"));
      stateWord = docs.map((p) => isSettlementCharge ? p.settlement.status : p.deposit.status).join(",") || "missing";
    }
    const scope = target
      ? (target.purpose === "tickets" ? `ticket order ${target.orderId}` : `${target.purpose} for booking ${target.bookingId}${target.gigId ? `/${target.gigId}` : ""}`)
      : `charge ${chargeId}`;
    await writeLedger({
      kind: "external_refund", amountCents, bookingId: target?.bookingId ?? null, gigId: target?.gigId ?? null,
      profileId: target?.curatorProfileId ?? null, stripeId: refund.id,
      detail: `refund ${refund.id} of ${amountCents}c on ${scope} was issued outside GateKeep (dashboard); doc state ${stateWord}`,
      ...(target?.purpose === "tickets" ? { eventId: null, buyerUid } : {}),
    }).catch((e) => console.error(`charge.refunded: external_refund ledger row failed for ${refund.id}`, e));
    if (stillPaid) {
      const alertId = externalRefundAlertId(refund.id);
      const shouldLog = await recordAdminAlert({
        alertId, kind: "external_refund",
        detail: `refund ${refund.id} of ${amountCents}c on ${scope} came from the Stripe dashboard, but the record still reads ${stateWord};`
          + " decide what the refund means for this record and finish the unwind by hand",
        bookingId: target?.bookingId ?? null, gigId: target?.gigId ?? null, now,
      });
      if (shouldLog) console.error(`charge.refunded: external refund ${refund.id} on ${scope} (see adminAlerts/${alertId})`);
    }
  }
};
```

- [ ] **Step 5: Register.** `functions/src/paymentsWebhook.ts`: the import becomes `import { disputeCreatedHandler, disputeClosedHandler, chargeRefundedHandler } from "./paymentsDisputes.js";` and below the Task 5 registration:

```ts
webhookHandlers["charge.dispute.closed"] = disputeClosedHandler;
webhookHandlers["charge.refunded"] = chargeRefundedHandler;
```

- [ ] **Step 6: Run, expect pass.** `pnpm emu:test`. In the `xr2` case the deposit refund row is keyed on the fake refund id and carries `purpose: "deposit_refund"` in the posted metadata, so neither an `external_refund` row nor an alert is written. `pnpm typecheck` 5/5.

- [ ] **Step 7: Commit.** `git commit -m "feat(payments): reverse the matching transfer on a lost dispute, clear on won, record dashboard refunds (sp5 #2)"`

---

### Task 7: Settlement webhook race window (sp5 #5)

**Files:**
- Modify: `functions/src/paymentsSettlement.ts` (settlementIntentSucceeded, the block at 1690-1701 and the imports 54-57)
- Modify: `functions/src/bookings.ts` (the deposit handler's mismatch branch, lines 1442-1446)
- Test: `functions/test/paymentsSettlement.test.ts` (new case inside the first describe, after the M2 stale case that ends at line 917), `functions/test/bookings.test.ts` (one log-level case is not asserted; the handler's return path is already covered, so no new test there)

**Interfaces (Consumes):** `WEBHOOK_SYNC_OWNER_WINDOW_MS` (Task 1, 15 minutes).

- [ ] **Step 1: Failing test.** Insert after line 917 of `functions/test/paymentsSettlement.test.ts` (inside the first describe, right after the M2 case):

```ts
  it("SP10 Task 7 (sp5 #5): a settlement webhook landing inside the synchronous charge window throws (Stripe redelivers) and raises NO settlement_raced alert", async () => {
    const { musician, gigId, bookingId } = await makeEndedBooking("race1");
    const accountId = await musicianAccountId(musician.profileId);
    await scheduleSettlement(bookingId, gigId);
    await makeSettlementDue(bookingId, gigId);

    // The synchronous path's state between its claim write and its terminal
    // write: chargingSince fresh, intentId still null, the card charged.
    const paymentRef = adb.doc(`bookings/${bookingId}/payments/${gigId}`);
    await paymentRef.update({ "settlement.chargingSince": Date.now() });
    const intentId = `pi_race_${Date.now()}`;
    const evt = fakeEvent("payment_intent.succeeded", {
      id: intentId, amount: FLAT_CHARGE_CENTS, amount_received: FLAT_CHARGE_CENTS,
      metadata: { bookingId, gigId, purpose: "settlement" },
    });
    const res = await postWebhook(evt);
    expect(res.status).toBe(500); // the handler threw; the claim machine stamped failedAt
    expect((await adb.doc(`stripeEvents/${evt.id}`).get()).data()?.failedAt).toBeTypeOf("number");

    const untouched = await getPayment(bookingId, gigId);
    expect(untouched?.settlement.status).toBe("pending");
    expect(untouched?.settlement.intentId).toBeNull();
    expect(untouched?.settlement.chargingSince).toBeTypeOf("number"); // the sync path still owns it
    expect(untouched?.transfer.status).toBe("none");
    expect(await accountBalanceCents(accountId)).toBe(0);
    expect(await adminAlert(`settlement-raced:${bookingId}:${gigId}`)).toBeUndefined();

    // The sync path finishes (here: the sweep, on a clean claim), then the
    // redelivery lands on a paid doc and is the existing no-op.
    await paymentRef.update({ "settlement.chargingSince": null });
    await runPaymentsSweep(Date.now());
    const paid = await getPayment(bookingId, gigId);
    expect(paid?.settlement.status).toBe("paid");
    const redelivery = await postWebhook({ ...evt, data: { object: { ...evt.data.object, id: paid!.settlement.intentId } } });
    expect(redelivery.status).toBe(200);
    expect(await accountBalanceCents(accountId)).toBe(FLAT_EARNINGS_CENTS);
    expect((await getPayment(bookingId, gigId))?.transfer.transferredAt).toBe(paid!.transfer.transferredAt);
    expect(await adminAlert(`settlement-raced:${bookingId}:${gigId}`)).toBeUndefined();
  });
```

- [ ] **Step 2: Run, confirm failure.** Today the webhook's `finalizeSettlementSuccess` proceeds under the fresh claim (the "chargingSince set but still within the window" branch at 654-656), transfers on the `earn:0` key, and its terminal write succeeds because the test's claim write IS the baseline it reads; the case fails at `expect(res.status).toBe(500)` with 200, and would then fail on the balance being `FLAT_EARNINGS_CENTS`.

- [ ] **Step 3: The window.** `functions/src/paymentsSettlement.ts`: add `WEBHOOK_SYNC_OWNER_WINDOW_MS` to the `@gatekeep/shared` value import at lines 54-57. Then, in `settlementIntentSucceeded`, directly after the mismatch check that ends at line 1701 (`return;` inside the `if (p.settlement.intentId != null && p.settlement.intentId !== intentId)` block), add:

```ts
  // SP10 Task 7 (sp5 #5): NO intent recorded yet and a FRESH pre-charge claim
  // means chargeSettlement's synchronous path is between its Stripe call and
  // its terminal write right now (live Stripe delivers this event within about
  // a second). Finalizing here would transfer on the same earn:{attempts} key
  // the sync path is using and then lose the terminal write's precondition,
  // which is exactly the false settlement_raced alert the audit found. Throw
  // instead: the claim machine stamps failedAt, Stripe redelivers, and the
  // redelivery lands on a paid doc and takes the already_paid no-op below. A
  // claim older than the window is an instance that died mid-charge, and the
  // finalize path's own terminators handle that case.
  const claimedAt = p.settlement.chargingSince;
  if (p.settlement.intentId == null && claimedAt != null && Date.now() - claimedAt < WEBHOOK_SYNC_OWNER_WINDOW_MS) {
    throw new Error(
      `payment_intent.succeeded (${purpose}): ${bookingId}/${gigId} is owned by a synchronous settlement claim from `
      + `${new Date(claimedAt).toISOString()}; deferring to redelivery`);
  }
```

- [ ] **Step 4: The deposit handler log downgrade.** `functions/src/bookings.ts` lines 1442-1446 (the `if (booking.depositChargeIntentId !== intentId) { console.error(...); return; }` block) become:

```ts
  if (booking.depositChargeIntentId !== intentId) {
    if (booking.depositChargeIntentId == null) {
      // SP10 Task 7 (sp5 #5): the synchronous accept saga never records an
      // intent id on the booking (only the `processing` route does), so on
      // every ordinary accept whose webhook beats transaction B this branch is
      // the expected shape, not an anomaly: the sync path owns this intent and
      // its transaction B will commit (or refund) it.
      console.info(
        `payment_intent.succeeded (deposit): ${bookingId} is mid-accept with no recorded intent; the synchronous saga owns ${intentId}`);
      return;
    }
    // An accept IS in flight on a DIFFERENT intent, and THIS intent just
    // succeeded: two live charges exist for one booking, and this one will
    // never be consumed. The stuck-money signal step 1's reconciliation (and an
    // operator) needs.
    console.error(
      `payment_intent.succeeded (deposit): ${bookingId} is awaiting intent ${booking.depositChargeIntentId} but ${intentId} succeeded; unconsumed charge, needs reconciliation`);
    return;
  }
```

- [ ] **Step 5: Run, expect pass.** `pnpm emu:test`. The existing "persists the intent and finalizes via payment_intent.succeeded" case (698-796) still passes: its doc carries `settlement.intentId` (the `processing` route records it), so the new guard does not fire. The M2 stale case (865-917) still passes: its claim is older than 24h, far outside the 15 minute window.

- [ ] **Step 6: Commit.** `git commit -m "fix(payments): let the synchronous settlement own its intent for 15 minutes before the webhook finalizes (sp5 #5)"`

---

### Task 8: Captured order reconciliation and the stuck alert (sp6 #5)

**Files:**
- Modify: `functions/src/paymentsSweep.ts` (report fields 186-192 and 234; `expireOneTicketOrder` 1216-1274; `expireTicketOrders` 1276-1293; the import from `./ticketing.js` at 76 and from `./eventsCore.js` at 77-79; the `@gatekeep/shared` import 53-56)
- Modify: `functions/src/eventsCore.ts` (new alert id after `ticketSettlementFailedAlertId` at 47)
- Modify: `functions/src/stripeClient.ts` (FakeStripe.cancelIntent 512-535)
- Test: `functions/test/ticketing.test.ts` (two cases appended to the expiry describe that ends at line 447)

**Interfaces (Consumes):** `completeOrderTx(orderId)` (`ticketing.ts:222`), `TICKET_ORDER_STUCK_AFTER_MS` (Task 1). The shared block's B3 wrapper `runTicketOrderExpiry(now)` calls `expireTicketOrders(db, now, report)`; this task changes only the per-order function.

**Interfaces (Produces):**
```ts
// eventsCore.ts
export function ticketOrderStuckAlertId(orderId: string): string;   // `ticket-order-stuck:${orderId}`
// paymentsSweep.ts (PaymentsSweepReport)
ticketOrdersReconciled: number;   // pending order whose intent had succeeded: completed by the sweep
ticketOrdersStuck: number;        // pending, intent neither canceled nor succeeded, older than 2h: alerted
```

- [ ] **Step 1: Failing tests.** Append inside the expiry `describe` of `functions/test/ticketing.test.ts` (after the "money always wins" case at 423-446):

```ts
  it("SP10 Task 8 (sp6 #5): an expired order whose intent already succeeded is COMPLETED by the sweep: ticket minted, buyer notified", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("rec1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("rec1buyer");
    const { orderId, clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 2 }] }, buyer.user);
    await confirmFakeIntent(clientSecret!);
    await adb.doc(`orders/${orderId}`).update({ expiresAt: Date.now() - 1000 });

    const report = await runPaymentsSweep(Date.now());
    expect(report.ticketOrdersReconciled).toBeGreaterThanOrEqual(1);

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.status).toBe("paid");
    const tickets = await adb.collection(`users/${buyer.uid}/tickets`).where("orderId", "==", orderId).get();
    expect(tickets.size).toBe(2);
    const notes = await adb.collection(`users/${buyer.uid}/notifications`).get();
    expect(notes.docs.some((d) => d.data().title === "Tickets confirmed")).toBe(true);
    expect((await adb.doc(`ledger/ticket_sale:${orderId}`).get()).exists).toBe(true);
    // A later finalize is the ordinary no-op.
    const { orderStatus } = await callFn<Record<string, unknown>, FinalizeResult>("finalizeTicketOrder", { orderId }, buyer.user);
    expect(orderStatus).toBe("paid");
    expect((await adb.collection(`users/${buyer.uid}/tickets`).where("orderId", "==", orderId).get()).size).toBe(2);
  });

  it("SP10 Task 8 (sp6 #5): a pending order whose intent is neither canceled nor succeeded, older than two hours, raises ticket_order_stuck", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("stk1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("stk1buyer");
    const { orderId, clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user);
    const intentId = clientSecret!.replace(/_secret_fake$/, "");
    // An intent Stripe cannot cancel and has not settled: `processing`.
    await adb.doc(`stripeFake/state/objects/${intentId}`).update({ status: "processing" });

    // Fresh: deferred, no alert yet.
    await adb.doc(`orders/${orderId}`).update({ expiresAt: Date.now() - 1000 });
    const first = await runPaymentsSweep(Date.now());
    expect(first.ticketOrdersExpiryDeferred).toBeGreaterThanOrEqual(1);
    expect((await adb.doc(`adminAlerts/ticket-order-stuck:${orderId}`).get()).exists).toBe(false);

    // Two hours old: still deferred, and now escalated.
    await adb.doc(`orders/${orderId}`).update({ createdAt: Date.now() - TICKET_ORDER_STUCK_AFTER_MS - 60_000 });
    const second = await runPaymentsSweep(Date.now());
    expect(second.ticketOrdersStuck).toBeGreaterThanOrEqual(1);
    const alert = (await adb.doc(`adminAlerts/ticket-order-stuck:${orderId}`).get()).data() as AdminAlertDoc;
    expect(alert.kind).toBe("ticket_order_stuck");
    expect(alert.bookingId).toBeNull();
    expect(alert.detail).toContain(orderId);
    expect(alert.detail).toContain("processing");
    expect(((await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc).status).toBe("pending");
  });
```

Add `TICKET_ORDER_STUCK_AFTER_MS` and `type AdminAlertDoc` to the file's `@gatekeep/shared` import.

- [ ] **Step 2: Run, confirm failures.** The first case fails at `report.ticketOrdersReconciled` (undefined, and the order is still `pending`). The second fails earlier than intended: today `FakeStripe.cancelIntent` cancels a `processing` intent, so the order is expired and `ticketOrdersExpiryDeferred` is 0.

- [ ] **Step 3: FakeStripe refuses to cancel `processing`.** `functions/src/stripeClient.ts`, in `cancelIntent` (lines 512-535), after the `if (status === "canceled") { ... }` block add:

```ts
      if (status === "processing") {
        // Real Stripe cannot cancel an intent that is settling (only in rare
        // payment-method cases). The sweep must defer, not expire, such an order.
        throw new Error(`FakeStripe: cannot cancel payment intent ${intentId}, it is processing`);
      }
```

- [ ] **Step 4: The alert id.** `functions/src/eventsCore.ts`, after `ticketSettlementFailedAlertId` (line 47 onward):

```ts
// SP10 Task 8 (sp6 #5): a pending ticket order past its TTL whose PaymentIntent
// is neither canceled nor succeeded (typically `processing`, or a status read
// that keeps failing) for longer than TICKET_ORDER_STUCK_AFTER_MS. Scoped to
// the order: the fan's money may be in flight and nothing else will say so.
export function ticketOrderStuckAlertId(orderId: string): string {
  return `ticket-order-stuck:${orderId}`;
}
```

- [ ] **Step 5: The sweep.** `functions/src/paymentsSweep.ts`:

Imports: add `TICKET_ORDER_STUCK_AFTER_MS` to the `@gatekeep/shared` value import (53-56); line 76 becomes `import { completeOrderTx, refundOrdersForCancelledEvent } from "./ticketing.js";`; add `ticketOrderStuckAlertId` to the `./eventsCore.js` import (77-79).

Report: after line 192 (`ticketOrdersExpiryDeferred: number;`) add:

```ts
  // SP10 Task 8 (sp6 #5): the deferred branch's two resolutions. Reconciled: the
  // intent had SUCCEEDED, so the sweep ran completeOrderTx itself (the fan was
  // charged; they get their tickets from this pass instead of from a finalize
  // call that never came). Stuck: neither canceled nor succeeded for longer
  // than TICKET_ORDER_STUCK_AFTER_MS, escalated to adminAlerts.
  ticketOrdersReconciled: number;
  ticketOrdersStuck: number;
```

and in `emptyReport()` line 234: `ticketOrdersExpired: 0, ticketOrdersExpiryDeferred: 0, ticketOrdersReconciled: 0, ticketOrdersStuck: 0,`.

`expireOneTicketOrder` gains `now`: signature becomes

```ts
async function expireOneTicketOrder(
  db: FirebaseFirestore.Firestore, doc: FirebaseFirestore.QueryDocumentSnapshot,
  now: number, report: PaymentsSweepReport,
): Promise<void> {
```

and the deferred branch (lines 1246-1251, the `if (status !== "canceled") { ... return; }` block) becomes:

```ts
      if (status === "succeeded") {
        // SP10 Task 8 (sp6 #5): money moved and nobody finished the order (the
        // app was killed before finalizeTicketOrder, the webhook never landed).
        // completeOrderTx is the same idempotent transaction finalize and the
        // webhook run; the order flips to paid, the tickets are minted, the
        // buyer is told. A throw here propagates to the per-order catch below.
        await completeOrderTx(doc.id);
        report.ticketOrdersReconciled++;
        return;
      }
      if (status !== "canceled") {
        console.info(
          `paymentsSweep: ticket order ${doc.id} expiry deferred, intent ${order.paymentIntentId} could not be confirmed cancelable (status=${status ?? "unknown"}), left pending for finalize/webhook`, e);
        report.ticketOrdersExpiryDeferred++;
        if (order.createdAt < now - TICKET_ORDER_STUCK_AFTER_MS) {
          // Deferred for hours, not minutes: a human has to look at the intent.
          const alertId = ticketOrderStuckAlertId(doc.id);
          const shouldLog = await recordAdminAlert({
            alertId, kind: "ticket_order_stuck",
            detail: `ticket order ${doc.id} (event ${order.eventId}, buyer ${order.buyerUid}) has been pending since `
              + `${new Date(order.createdAt).toISOString()} with intent ${order.paymentIntentId} in status ${status ?? "unknown"};`
              + " neither cancelable nor succeeded, so it can be neither expired nor completed; resolve the intent in Stripe",
            bookingId: null, gigId: null, now,
          });
          if (shouldLog) console.error(`paymentsSweep: ticket order ${doc.id} is stuck (see adminAlerts/${alertId})`);
          report.ticketOrdersStuck++;
        }
        return;
      }
```

`expireTicketOrders` (1276-1293) passes the clock: `await expireOneTicketOrder(db, doc, now, report);`.

- [ ] **Step 6: Run, expect pass.** `pnpm emu:test`. The existing "money always wins" case (423-446) changes meaning: the sweep now completes the order, so change its assertions to `expect(report.ticketOrdersReconciled).toBeGreaterThanOrEqual(1)`, `expect(order.status).toBe("paid")`, keep the inventory assertion (`soldCount` 1), and keep the finalize call asserting `orderStatus === "paid"` (the no-op path). Rename it "money always wins over expiry: an already-succeeded PaymentIntent is completed by the sweep, never expired, and finalize is then a no-op". `pnpm typecheck` 5/5.

- [ ] **Step 7: Commit.** `git commit -m "fix(ticketing): the expiry sweep completes a captured order and alerts on one stuck past two hours (sp6 #5)"`

---

### Task 9: Settlement claim, wedge recovery, and the admin alert rows (sp6 #14)

**Files:**
- Modify: `functions/src/paymentsSweep.ts` (`claimSettlementStart` 1396-1408; `settleOneEvent` 1458-1497; the `@gatekeep/shared` import 53-56)
- Modify: `functions/src/events.ts` (`cancelEventCore` 458-474; the `@gatekeep/shared` import 21-25)
- Modify: `functions/src/stripeClient.ts` (FakeStripe.transferToAccount from Task 3; `chargeKnobs` 377-384 gets a sibling; the config comment 254-256)
- Modify: `apps/web/app/admin/page.tsx` (`ALERT_KIND_LABEL` 1548-1564)
- Test: `functions/test/eventsSettlement.test.ts` (new describe appended after line 394)

**Interfaces (Consumes):** `SETTLEMENT_CLAIM_STALE_MS` (Task 1, 24h), `EventDoc.settlementClaimedAt?: number` (Task 1), `ticketSettlementFailedAlertId` (`eventsCore.ts:47`).

**Interfaces (Produces):**
```ts
// paymentsSweep.ts
type SettlementClaim = "claimed" | "already_started" | "not_published";
async function claimSettlementStart(db, eventRef, now): Promise<SettlementClaim>;
// stripeClient.ts (FakeStripe test knob, stripeFake/config)
//   failTransferAccountIds?: string[]   transferToAccount to a listed account throws
//   Object.assign(new Error("balance_insufficient"), { code: "balance_insufficient" }), NOT cached by idem()
//   (message does not start with "FakeStripe:"), so a retry after the knob is cleared re-executes; real
//   Stripe would replay the refusal for 24h under the same key, which the launch checklist's platform-float
//   decision addresses.
// events.ts: cancelEventCore refuses with HttpsError("failed-precondition",
//   "This event's ticket settlement is in progress and it cannot be cancelled right now.") on a claim
//   younger than SETTLEMENT_CLAIM_STALE_MS with no settlementStartedAt.
```

- [ ] **Step 1: Failing tests.** Append to `functions/test/eventsSettlement.test.ts` after line 394:

```ts
async function setTransferKnob(accountId: string, on: boolean): Promise<void> {
  await adb.doc("stripeFake/config").set(
    { failTransferAccountIds: on ? FieldValue.arrayUnion(accountId) : FieldValue.arrayRemove(accountId) }, { merge: true });
}

describe("SP10 Task 9 (sp6 #14): settlement claim and wedge recovery", () => {
  it("a refused transfer leaves settlementClaimedAt set, settlementStartedAt unset, alerts, and the next pass settles once Stripe accepts", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("wdg1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("wdg1buyer");
    await payOrder(eventId, tierId, 2, buyer.user);
    const accountId = await makeCuratorPayoutReady(profileId, owner.user);
    await pushEventPastSettleWindow(eventId);

    let report;
    try {
      await setTransferKnob(accountId, true);
      report = await runPaymentsSweep(Date.now());
    } finally {
      await setTransferKnob(accountId, false);
    }
    expect(report.errors.ticketSettlementTransfer).toBeGreaterThanOrEqual(1);
    const wedged = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(wedged.status).toBe("published");
    expect(wedged.settlementStartedAt).toBeUndefined();
    expect(wedged.settlementClaimedAt).toBeUndefined(); // a definite refusal releases the claim
    expect((await adb.doc(`adminAlerts/${ticketSettlementFailedAlertId(eventId)}`).get()).data()?.kind).toBe("ticket_settlement_failed");
    expect((await adb.doc(`stripeFake/state/objects/${accountId}`).get()).data()?.balanceCents ?? 0).toBe(0);

    // Stripe accepts on the next pass: claimed, transferred, started, completed.
    await runPaymentsSweep(Date.now());
    const settled = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(settled.status).toBe("completed");
    expect(settled.settlementStartedAt).toBeTypeOf("number");
    expect(settled.settlementClaimedAt).toBeTypeOf("number");
    expect(settled.settlementStartedAt).toBeGreaterThanOrEqual(settled.settlementClaimedAt!);
    expect((await adb.doc(`stripeFake/state/objects/${accountId}`).get()).data()?.balanceCents).toBe(2000);
    expect(await ledgerRowsForEvent(eventId, "ticket_settlement")).toHaveLength(1);
  });

  it("cancelEvent is refused on a fresh claim and allowed again once the claim is stale", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("wdg2");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("wdg2buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    await adb.doc(`events/${eventId}`).update({ endsAt: Date.now() - HOUR_MS });

    // The shape between the claim write and the transfer returning (an
    // ambiguous failure leaves it this way too): claimed, not started.
    await adb.doc(`events/${eventId}`).update({ settlementClaimedAt: Date.now() });
    await expect(callFn("cancelEvent", { curatorProfileId: profileId, eventId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    expect(((await adb.doc(`events/${eventId}`).get()).data() as EventDoc).status).toBe("published");

    await adb.doc(`events/${eventId}`).update({ settlementClaimedAt: Date.now() - SETTLEMENT_CLAIM_STALE_MS - 1000 });
    const result = await callFn<Record<string, unknown>, { ok: boolean }>(
      "cancelEvent", { curatorProfileId: profileId, eventId }, owner.user);
    expect(result.ok).toBe(true);
    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.status).toBe("cancelled");
    expect(((await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc).status).toBe("cancelled_refunded");
  });

  it("an ambiguous transfer failure keeps the claim (cancel refused) and a stale claim is re-claimable by the sweep", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("wdg3");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("wdg3buyer");
    await payOrder(eventId, tierId, 1, buyer.user);
    const accountId = await makeCuratorPayoutReady(profileId, owner.user);
    await pushEventPastSettleWindow(eventId);

    // Seed a stale claim from a pass whose transfer call died without an answer.
    const staleClaim = Date.now() - SETTLEMENT_CLAIM_STALE_MS - 1000;
    await adb.doc(`events/${eventId}`).update({ settlementClaimedAt: staleClaim });
    await runPaymentsSweep(Date.now());
    const settled = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(settled.status).toBe("completed");
    expect(settled.settlementClaimedAt).toBeGreaterThan(staleClaim); // re-claimed
    expect((await adb.doc(`stripeFake/state/objects/${accountId}`).get()).data()?.balanceCents).toBe(1000);
  });
});
```

Add `FieldValue` to the `firebase-admin/firestore` import (line 4), `SETTLEMENT_CLAIM_STALE_MS` to the `@gatekeep/shared` import (5-8), and `ticketSettlementFailedAlertId` to the `../src/eventsCore.js` import (11).

- [ ] **Step 2: Run, confirm failures.** The first case fails at `report.errors.ticketSettlementTransfer` (no knob: the transfer succeeds); the second at the `rejects.toMatchObject` (cancel is allowed under a bare `settlementClaimedAt` today); the third passes trivially today (the field is unread), which is acceptable for a case whose purpose is to pin the re-claim once the field is read.

- [ ] **Step 3: The FakeStripe knob.** `functions/src/stripeClient.ts`: in `FakeStripe.transferToAccount` (the Task 3 version), as the first statement inside `idem`'s `make`:

```ts
      // SP10 Task 9 test knob (stripeFake/config.failTransferAccountIds): Stripe
      // refuses the transfer. Shaped like a live balance_insufficient (a string
      // `code`), and deliberately NOT a "FakeStripe:" message so idem() does not
      // cache it: the retry the sweep makes after the condition clears must
      // re-execute. Real Stripe replays a refusal under the same key for 24h;
      // the launch checklist's platform-float decision is what shortens that.
      const cfg = (await this.db.doc("stripeFake/config").get()).data();
      if (((cfg?.failTransferAccountIds as string[] | undefined) ?? []).includes(p.accountId)) {
        throw Object.assign(new Error("balance_insufficient"), { code: "balance_insufficient" });
      }
```

and add `failTransferAccountIds?` to the config layout comment at lines 254-256.

- [ ] **Step 4: The claim.** `functions/src/paymentsSweep.ts`: add `SETTLEMENT_CLAIM_STALE_MS` to the `@gatekeep/shared` import. Replace `claimSettlementStart` (1396-1408) with:

```ts
type SettlementClaim = "claimed" | "already_started" | "not_published";

// SP10 Task 9 (sp6 #14). Two fields, two jobs:
//  - `settlementClaimedAt` is stamped HERE, before the Stripe call, and is the
//    cancel guard while a transfer may be in flight (24h stale window, the
//    chargingSince idiom). A fresh claim from an earlier pass is left alone
//    (the ticket_settlement:{id} key replays inside Stripe's window); a stale
//    one is re-stamped, a genuine re-claim.
//  - `settlementStartedAt` is stamped by settleOneEvent ONLY after the
//    transfer succeeds, and is the permanent cancel refusal: money reached the
//    curator, so a cancel can never refund buyers on top of it.
// Returns already_started when the transfer succeeded on an earlier pass whose
// completion write then failed: the caller replays the same key (a no-op) and
// goes straight to the completion write.
async function claimSettlementStart(
  db: FirebaseFirestore.Firestore, eventRef: FirebaseFirestore.DocumentReference, now: number,
): Promise<SettlementClaim> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(eventRef);
    const event = snap.data() as EventDoc | undefined;
    if (!event || event.status !== "published") return "not_published";
    if (event.settlementStartedAt != null) return "already_started";
    const claimedAt = event.settlementClaimedAt;
    if (claimedAt == null || now - claimedAt >= SETTLEMENT_CLAIM_STALE_MS) {
      tx.update(eventRef, { settlementClaimedAt: now, updatedAt: now });
    }
    return "claimed";
  });
}

// A refusal Stripe answered with a code (balance_insufficient, an invalid
// destination) moved no money, so the claim can be released at once and cancel
// stays possible between passes. An error WITHOUT a code (a timeout, a dropped
// connection) is ambiguous: the transfer may have gone through, so the claim
// stands until it goes stale.
function isDefiniteStripeRefusal(e: unknown): boolean {
  return typeof (e as { code?: unknown } | null)?.code === "string";
}
```

In `settleOneEvent`, replace lines 1458-1488 (from `const claimed = await claimSettlementStart(...)` through the end of the transfer `catch` block's `return;`) with:

```ts
    const claim = await claimSettlementStart(db, doc.ref, now);
    if (claim === "not_published") return; // raced (cancelled, or resolved) since the read above

    let transfer: { id: string };
    try {
      transfer = await getStripe().transferToAccount({
        accountId: curatorStripe.accountId, amountCents: faceCents,
        idempotencyKey: `ticket_settlement:${doc.id}`,
        meta: { purpose: "ticket_settlement", eventId: doc.id },
      });
    } catch (e) {
      // NOT wedged any more (SP10 Task 9): settlementStartedAt was never
      // stamped, so cancelEventCore can still refund buyers once the claim is
      // stale (or at once, on a definite refusal). Every hourly pass retries
      // the same key. Escalated durably (Critical 1d) rather than left as a
      // bare error count; the per-event try/catch in settleTicketRevenue still
      // lets every OTHER due event settle this run.
      if (isDefiniteStripeRefusal(e)) {
        await doc.ref.update({ settlementClaimedAt: FieldValue.delete(), updatedAt: now })
          .catch((we) => console.error(`paymentsSweep: failed to release the settlement claim on event ${doc.id}`, we));
      }
      const alertId = ticketSettlementFailedAlertId(doc.id);
      const shouldLog = await recordAdminAlert({
        alertId, kind: "ticket_settlement_failed",
        detail: `event ${doc.id} ("${event.title}") ticket settlement transfer of ${faceCents}c to curator `
          + `${event.curatorProfileId} failed: ${e instanceof Error ? e.message : String(e)}; retried hourly, `
          + `cancel ${isDefiniteStripeRefusal(e) ? "stays possible" : "reopens once the claim is 24h old"}`,
        bookingId: null, gigId: null, now,
      });
      if (shouldLog) {
        console.error(
          `paymentsSweep: event ${doc.id} ticket settlement transfer failed (see adminAlerts/${alertId})`, e);
      }
      bumpError(report, "ticketSettlementTransfer");
      return;
    }

    if (claim === "claimed") {
      // The transfer succeeded: from here a cancel can never be allowed.
      await doc.ref.update({ settlementStartedAt: now, updatedAt: now });
    }
```

(The `already_started` branch skips the stamp: the field is already set from the pass whose transfer succeeded; the key replay above returned that same transfer.) The ledger write and the completion transaction that follow (1490-1510) are unchanged. Update the step header comment (1361-1384) so its description of `settlementStartedAt` reads "stamped only after the transfer succeeds; `settlementClaimedAt` is the pre-transfer claim, see claimSettlementStart".

- [ ] **Step 5: cancelEventCore.** `functions/src/events.ts`: add `SETTLEMENT_CLAIM_STALE_MS` to the `@gatekeep/shared` import (21-25). In `cancelEventCore` (458-474), after the `settlementStartedAt` refusal (468-471) add:

```ts
    // SP10 Task 9 (sp6 #14): a FRESH settlement claim means a transfer may be
    // in flight right now (or an ambiguous failure left its fate unknown); a
    // cancel that refunded buyers under it could double-spend against a
    // transfer that then lands. A stale claim (24h with no settlementStartedAt)
    // is a settlement that keeps failing, and the show is cancellable again.
    const claimedAt = event.settlementClaimedAt;
    if (claimedAt != null && now - claimedAt < SETTLEMENT_CLAIM_STALE_MS) {
      throw new HttpsError("failed-precondition",
        "This event's ticket settlement is in progress and it cannot be cancelled right now.");
    }
```

and extend the function's header comment (447-457) with one sentence: "Also refused on a fresh `settlementClaimedAt` (SP10 Task 9); see paymentsSweep.ts's claimSettlementStart."

- [ ] **Step 6: The admin display rows.** `apps/web/app/admin/page.tsx`, `ALERT_KIND_LABEL` (1548-1564) gains four entries before the closing brace (the `Record<AdminAlertKind, string>` type makes `pnpm typecheck` fail until they exist):

```ts
  dispute_opened: "Chargeback opened",
  dispute_reversal_failed: "Lost dispute, transfer not reversed",
  external_refund: "Refund issued from the Stripe dashboard",
  ticket_order_stuck: "Ticket order stuck with a pending charge",
```

Display only: `RELEASABLE_KINDS` (1574) is unchanged, so none of the four gets a button; the existing row renders `detail`, `firstSeenAt`, `runCount`, and the booking link when `bookingId` is set (dispute rows on a booking charge carry it).

- [ ] **Step 7: Run, expect pass.** `pnpm emu:test`: the three new cases pass; the existing eventsSettlement cases at 135-173 (`settlementStartedAt` typeof number after a successful settlement), 288-345 (no double transfer on a retried completion write: the second pass takes the `already_started` branch and replays the key), and 347-375 (cancel refused on `settlementStartedAt`) all still hold. `pnpm typecheck` 5/5, `pnpm --filter @gatekeep/web lint` 0 errors, `pnpm --filter @gatekeep/web build`, then a live load of `/admin` with at least one unresolved `adminAlerts` row of a new kind seeded through the Admin SDK to see the label render.

- [ ] **Step 8: Commit.** `git commit -m "fix(ticketing): claim ticket settlement before the transfer, start it after; cancel stays possible on failure; admin labels for the new alert kinds (sp6 #14)"`

---

### Task 10: Events follow the profile

**Files:**
- Modify: `functions/src/events.ts` (append after `cancelEvent`, which ends at line 533)
- Modify: `functions/src/review.ts` (imports 1-7, options line 23, cascade after line 183, audit detail 229-235)
- Modify: `functions/src/ticketing.ts` (createTicketOrder 82-85)
- Modify: `functions/src/paymentsSweep.ts` (settleOneEvent 1410-1418, settleTicketRevenue 1513-1528, report 214-222 unchanged)
- Modify: `functions/src/scheduled.ts` (imports 1-12, SweepReport 236-293, report init 310-320, new step 9 before `return report` at 950, dailySweep options 965-968)
- Create: `functions/test/eventCascade.test.ts`
- Modify: `functions/test/ticketing.test.ts` (one new case), `functions/test/eventsSettlement.test.ts` (one new case)

**Interfaces:**
- Consumes: `cancelEventCore(eventId, now)` (events.ts:458), `refundOrdersForCancelledEvent(eventId, title, now, reason?)` returning `CancelledEventOrdersResult` (ticketing.ts:581), `recordAdminAlert` (paymentsCore.ts:842), `ticketSettlementBlockedAlertId` (eventsCore.ts:37), `paginate` and `SWEEP_PAGE_SIZE` (scheduled.ts:207, 223).
- Produces (events.ts):

```ts
export const ORGANIZER_INACTIVE_REASON = "The organizer's account is no longer active";
export type ModerationActor = { kind: "admin"; uid: string } | { kind: "system"; cause: "profile_unpublished" };
export interface ModerationCancelResult {
  outcome: "cancelled" | "already_cancelled" | "skipped_completed";
  orders: CancelledEventOrdersResult;
}
export interface EventCascadeRetryDoc { profileId: string; reason: string; attempts: number; lastError: string; createdAt: number; }
export async function cancelAndRefundEventForModeration(eventId: string, reason: string, actor: ModerationActor): Promise<ModerationCancelResult>;
```

- Produces (scheduled.ts): `SweepReport.eventCascadeRetried: number`, `SweepReport.errors.eventCascadeRetries: number`, step 9 `drainEventCascadeRetries(db, report)`.

**Steps:**

- [ ] **Step 1:** Create `functions/test/eventCascade.test.ts` with the ticket fixtures copied from `functions/test/ticketingRefunds.test.ts` lines 15-88 (`makeApprovedCuratorProfile`, `eventContent`, `makeDraftEvent`, `addTiersAndPublish`, `tierIdByName`, `makeBuyer`, `confirmFakeIntent`, `payOrder`) and these cases:

```ts
import { describe, it, expect, vi } from "vitest";
import { signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn, wait } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import type { TicketOrderDoc, EventDoc } from "@gatekeep/shared";
import { runDailySweep } from "../src/scheduled.js";
import { ORGANIZER_INACTIVE_REASON, type EventCascadeRetryDoc } from "../src/events.js";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
const adb = adminFirestore(admin);
vi.setConfig({ testTimeout: 30_000 });

// ... fixtures copied from ticketingRefunds.test.ts lines 15-88 go here ...

async function pollNotifications(uid: string, predicate: (d: FirebaseFirestore.DocumentData) => boolean) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const notes = await adb.collection(`users/${uid}/notifications`).get();
    const hit = notes.docs.find((d) => predicate(d.data()));
    if (hit || Date.now() > deadline) return hit;
    await wait(250);
  }
}

describe("reviewProfile reject-from-approved: events cascade", () => {
  it("cancels and refunds a published future event, cancels a draft, leaves a completed event alone, and queues a poisoned event", async () => {
    const { owner, profileId, eventId: liveId } = await makeDraftEvent("evc1");
    await addTiersAndPublish(profileId, liveId, owner.user,
      [{ name: "General", priceCents: 2000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(liveId, "General");
    const buyer = await makeBuyer("evc1buyer");
    const orderId = await payOrder(liveId, tierId, 1, buyer.user);

    const { eventId: draftId } = await callFn<Record<string, unknown>, { eventId: string }>(
      "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent({ title: "Draft night" }) }, owner.user);
    const { eventId: doneId } = await callFn<Record<string, unknown>, { eventId: string }>(
      "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent({ title: "Done night" }) }, owner.user);
    await adb.doc(`events/${doneId}`).update({ status: "completed", completedAt: Date.now() });
    // Poisoned: published, future, but settlement already claimed, so
    // cancelEventCore refuses (events.ts:469-472). Seeded via the admin SDK;
    // unreachable through the callables for a future-dated event.
    const { eventId: poisonId } = await callFn<Record<string, unknown>, { eventId: string }>(
      "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent({ title: "Poisoned night" }) }, owner.user);
    await adb.doc(`events/${poisonId}`).update({ status: "published", settlementStartedAt: Date.now() });

    const reviewer = await makeAdminUser("evc1r");
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "Policy violation." }, reviewer.user);

    expect((await adb.doc(`events/${liveId}`).get()).data()?.status).toBe("cancelled");
    expect((await adb.doc(`events/${draftId}`).get()).data()?.status).toBe("cancelled");
    expect((await adb.doc(`events/${doneId}`).get()).data()?.status).toBe("completed");
    expect((await adb.doc(`events/${poisonId}`).get()).data()?.status).toBe("published");

    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.status).toBe("cancelled_refunded");
    expect(order.refundedCents).toBe(order.faceTotalCents + order.serviceFeeCents);

    const note = await pollNotifications(buyer.uid, (d) => d.kind === "ticket" && d.title === "Event cancelled");
    expect(note).toBeDefined();
    expect(note!.data().body).toContain(ORGANIZER_INACTIVE_REASON);

    const retry = (await adb.doc(`eventCascadeRetries/${poisonId}`).get()).data() as EventCascadeRetryDoc | undefined;
    expect(retry).toBeDefined();
    expect(retry!.profileId).toBe(profileId);
    expect(retry!.reason).toBe(ORGANIZER_INACTIVE_REASON);
    expect(retry!.attempts).toBe(1);
    expect(retry!.lastError).toMatch(/settlement/i);

    const logs = await adb.collection("auditLogs")
      .where("targetId", "==", profileId).where("action", "==", "profile_rejected").get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data().detail).toContain("cancelled 2 events");
    expect(logs.docs[0].data().detail).toContain("1 events queued for retry");
  });
});

describe("dailySweep step 9: drainEventCascadeRetries", () => {
  it("cancels a queued event and deletes its retry doc; a still-poisoned event stays queued with attempts bumped", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("evc2");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const { eventId: poisonId } = await callFn<Record<string, unknown>, { eventId: string }>(
      "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent({ title: "Still poisoned" }) }, owner.user);
    await adb.doc(`events/${poisonId}`).update({ status: "published", settlementStartedAt: Date.now() });
    const seed: EventCascadeRetryDoc = { profileId, reason: ORGANIZER_INACTIVE_REASON, attempts: 1, lastError: "seeded", createdAt: Date.now() };
    await adb.doc(`eventCascadeRetries/${eventId}`).set(seed);
    await adb.doc(`eventCascadeRetries/${poisonId}`).set(seed);

    const report = await runDailySweep(Date.now());
    expect(report.eventCascadeRetried).toBeGreaterThanOrEqual(1);
    expect(report.errors.eventCascadeRetries).toBeGreaterThanOrEqual(1);

    expect((await adb.doc(`events/${eventId}`).get()).data()?.status).toBe("cancelled");
    expect((await adb.doc(`eventCascadeRetries/${eventId}`).get()).exists).toBe(false);
    const stuck = (await adb.doc(`eventCascadeRetries/${poisonId}`).get()).data() as EventCascadeRetryDoc;
    expect(stuck.attempts).toBe(2);
    expect(stuck.lastError).toMatch(/settlement/i);
  });
});
```

Add to `functions/test/ticketing.test.ts` (inside its `createTicketOrder` describe, using that file's own `makeDraftEvent`, `addTiersAndPublish`, `tierIdByName`, `makeBuyer`):

```ts
  it("refuses to sell when the curator profile is no longer approved (EVENT_NOT_ON_SALE_MESSAGE)", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("cto-unapproved");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    // Flipped directly: the reviewProfile cascade would cancel the event, and
    // this test's subject is the sale-time gate for an event the cascade missed.
    await adb.doc(`profiles/${profileId}`).update({ status: "rejected" });
    const buyer = await makeBuyer("cto-unapproved-buyer");
    await expect(callFn("createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: EVENT_NOT_ON_SALE_MESSAGE });
  });
```

Add to `functions/test/eventsSettlement.test.ts` (inside "paymentsSweep: post-event ticket settlement"):

```ts
  it("withholds settlement and completion when the curator profile is not approved, raising ticket_settlement_blocked", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("set-unapproved");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("set-unapproved-buyer");
    await payOrder(eventId, tierId, 1, buyer.user);
    const accountId = await makeCuratorPayoutReady(profileId, owner.user);
    await adb.doc(`profiles/${profileId}`).update({ status: "rejected" });
    await pushEventPastSettleWindow(eventId);

    const report = await runPaymentsSweep(Date.now());
    expect(report.ticketSettlementsBlocked).toBeGreaterThanOrEqual(1);

    const event = (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
    expect(event.status).toBe("published");
    expect(event.settlementStartedAt).toBeUndefined();
    const acct = (await adb.doc(`stripeFake/state/objects/${accountId}`).get()).data();
    expect(acct?.balanceCents ?? 0).toBe(0);
    const alert = (await adb.doc(`adminAlerts/${ticketSettlementBlockedAlertId(eventId)}`).get()).data() as AdminAlertDoc;
    expect(alert.kind).toBe("ticket_settlement_blocked");
    expect(alert.detail).toMatch(/not approved/);
  });
```

- [ ] **Step 2:** Run the three files. Expected failures: `eventCascade.test.ts` cannot import `ORGANIZER_INACTIVE_REASON` (undefined export) and, once stubbed, the live event stays `published`; `ticketing.test.ts` new case resolves an order instead of rejecting; `eventsSettlement.test.ts` new case sees `ticketSettlementsTransferred` move money to the rejected curator and `status === "completed"`.

- [ ] **Step 3:** Append to `functions/src/events.ts` after line 533:

```ts
// ---------------------------------------------------------------------------
// SP10 Task 10: moderation cancel + refund (events follow the profile)
// ---------------------------------------------------------------------------
// Copy holders see in the cancellation notification when a curator is
// unpublished (spec section 5.1). Fixed here so review.ts's cascade and
// scheduled.ts's retry step send the same words.
export const ORGANIZER_INACTIVE_REASON = "The organizer's account is no longer active";

export type ModerationActor =
  | { kind: "admin"; uid: string }
  | { kind: "system"; cause: "profile_unpublished" };

export interface ModerationCancelResult {
  outcome: "cancelled" | "already_cancelled" | "skipped_completed";
  orders: CancelledEventOrdersResult;
}

// eventCascadeRetries/{eventId}: written by review.ts when one event of the
// cascade throws, drained by dailySweep step 9. Server-only (firestore.rules).
export interface EventCascadeRetryDoc {
  profileId: string; reason: string; attempts: number; lastError: string; createdAt: number;
}

// The moderation twin of cancelEvent: no guard chain (the caller is an admin
// callable, the reject cascade, or the daily sweep), no curator-approval
// requirement (the whole point is that the curator is no longer approved),
// same two helpers in the same order. A completed event is untouched: its
// settlement has run and the show happened. Idempotent at the event level
// exactly like cancelEvent: an already-cancelled event skips the status flip
// and re-drives the refund loop. Per-order failures are escalated to
// adminAlerts inside refundOrdersForCancelledEvent and retried hourly by
// paymentsSweep's retryCancelledEventRefunds, so they do NOT throw here;
// only cancelEventCore's own refusal (settlement claimed, malformed doc)
// propagates, which is what lands an event in eventCascadeRetries.
export async function cancelAndRefundEventForModeration(
  eventId: string, reason: string, actor: ModerationActor,
): Promise<ModerationCancelResult> {
  const db = getFirestore();
  const snap = await db.doc(`events/${eventId}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "Event not found.");
  const event = snap.data() as EventDoc;
  const now = Date.now();
  const empty: CancelledEventOrdersResult = { ordersRefunded: 0, pendingExpired: 0, pendingDeferred: 0, errors: 0 };
  if (event.status === "completed") return { outcome: "skipped_completed", orders: empty };

  let outcome: ModerationCancelResult["outcome"] = "already_cancelled";
  if (event.status !== "cancelled") {
    await cancelEventCore(eventId, now);
    outcome = "cancelled";
  }
  const by = actor.kind === "admin" ? `admin ${actor.uid}` : actor.cause;
  console.info(`cancelAndRefundEventForModeration: event ${eventId} ${outcome} (${by})`);
  const orders = await refundOrdersForCancelledEvent(eventId, event.title, now, reason);
  return { outcome, orders };
}
```

Extend the ticketing import at events.ts:33 to `import { refundOrdersForCancelledEvent, type CancelledEventOrdersResult } from "./ticketing.js";`.

- [ ] **Step 4:** Edit `functions/src/review.ts`. Imports (after line 7):

```ts
import { cancelAndRefundEventForModeration, ORGANIZER_INACTIVE_REASON, type EventCascadeRetryDoc } from "./events.js";
import { stripeSecretKey } from "./stripeClient.js";
```

Line 23 options become `{ region: "us-central1", secrets: [stripeSecretKey] }`.

Insert after the `unwindBookingsForModeration` block (after line 183):

```ts
    // SP10 Task 10 (spec section 5.1): events follow the profile. Every
    // published future event is cancelled and refunded in full, drafts are
    // cancelled, completed and already-cancelled events are untouched. Each
    // event is its own try/catch: one poisoned event lands in
    // eventCascadeRetries for the daily sweep's step 9, never blocks the rest.
    let eventsCancelled = 0;
    let eventsQueued = 0;
    if (isCurator && decision === "rejected" && wasApproved) {
      const cascade = await cascadeEventsForUnpublishedProfile(db, profileId, now);
      eventsCancelled = cascade.cancelled;
      eventsQueued = cascade.queued;
    }
```

Add the helper above `reviewProfile` (after `writeAudit`, line 20):

```ts
async function cascadeEventsForUnpublishedProfile(
  db: FirebaseFirestore.Firestore, profileId: string, now: number,
): Promise<{ cancelled: number; queued: number }> {
  // Served by the existing events (curatorProfileId, status, startsAt) composite.
  const [publishedSnap, draftSnap] = await Promise.all([
    db.collection("events").where("curatorProfileId", "==", profileId)
      .where("status", "==", "published").where("startsAt", ">", now).get(),
    db.collection("events").where("curatorProfileId", "==", profileId).where("status", "==", "draft").get(),
  ]);
  let cancelled = 0;
  let queued = 0;
  for (const doc of [...publishedSnap.docs, ...draftSnap.docs]) {
    try {
      const result = await cancelAndRefundEventForModeration(
        doc.id, ORGANIZER_INACTIVE_REASON, { kind: "system", cause: "profile_unpublished" });
      if (result.outcome === "cancelled") cancelled++;
    } catch (e) {
      queued++;
      console.error("event cascade failed; queued for dailySweep step 9", { profileId, eventId: doc.id }, e);
      const retry: EventCascadeRetryDoc = {
        profileId, reason: ORGANIZER_INACTIVE_REASON, attempts: 1,
        lastError: e instanceof Error ? e.message : String(e), createdAt: now,
      };
      try {
        await db.doc(`eventCascadeRetries/${doc.id}`).set(retry);
      } catch (writeError) {
        console.error("eventCascadeRetries write failed", { eventId: doc.id }, writeError);
      }
    }
  }
  return { cancelled, queued };
}
```

Replace the audit `detail` expression (lines 229-235) with:

```ts
      detail: decision === "rejected"
        ? (wasApproved
            ? `[was approved] ${reason!.trim()}${cascadeSummary(isCurator, closedGigs, pausedSeries, eventsCancelled, eventsQueued)}`
            : reason!.trim())
        : snap.data()?.name ?? "",
```

and add beside the helper above:

```ts
// The pre-SP10 "(closed N gigs, paused M series)" suffix is preserved
// byte-for-byte when no events were touched (review.test.ts:307 asserts it);
// event counts are appended only when the cascade actually cancelled or
// queued something.
function cascadeSummary(isCurator: boolean, closedGigs: number, pausedSeries: number, eventsCancelled: number, eventsQueued: number): string {
  if (!isCurator) return "";
  const parts: string[] = [];
  if (closedGigs > 0 || pausedSeries > 0) parts.push(`closed ${closedGigs} gigs, paused ${pausedSeries} series`);
  if (eventsCancelled > 0) parts.push(`cancelled ${eventsCancelled} events`);
  if (eventsQueued > 0) parts.push(`${eventsQueued} events queued for retry`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}
```

- [ ] **Step 5:** Edit `functions/src/ticketing.ts` createTicketOrder. After line 85 (`}` closing the `event.status` check) insert:

```ts
    // SP10 Task 10: the curator must still be approved. Closes the window
    // between a reject-from-approved and its cascade (and any event the
    // cascade missed): the public event page may still render, but nothing
    // sells. One get per invocation; same message the client already keys on.
    const curatorSnap = await db.doc(`profiles/${event.curatorProfileId}`).get();
    if (curatorSnap.data()?.status !== "approved") {
      throw new HttpsError("failed-precondition", EVENT_NOT_ON_SALE_MESSAGE);
    }
```

- [ ] **Step 6:** Edit `functions/src/paymentsSweep.ts`. Change the `settleOneEvent` signature (1410-1413) to:

```ts
async function settleOneEvent(
  db: FirebaseFirestore.Firestore, doc: FirebaseFirestore.QueryDocumentSnapshot,
  now: number, report: PaymentsSweepReport, curatorStatusCache: Map<string, string>,
): Promise<void> {
```

Insert after the fresh-read guard (after line 1417, `if (!event || event.status !== "published") return;`):

```ts
  // SP10 Task 10: never pay a curator who is no longer approved. Cached per
  // sweep run (one get per curator, not per event); the alert reuses the
  // blocked-settlement id so an operator sees one row per event, and the
  // remedy is takedownEvent (cancel + refund), which cancelEventCore still
  // permits because settlementStartedAt is not claimed on this path.
  let curatorStatus = curatorStatusCache.get(event.curatorProfileId);
  if (curatorStatus === undefined) {
    const profileSnap = await db.doc(`profiles/${event.curatorProfileId}`).get();
    curatorStatus = (profileSnap.data()?.status as string | undefined) ?? "missing";
    curatorStatusCache.set(event.curatorProfileId, curatorStatus);
  }
  if (curatorStatus !== "approved") {
    const alertId = ticketSettlementBlockedAlertId(doc.id);
    const shouldLog = await recordAdminAlert({
      alertId, kind: "ticket_settlement_blocked",
      detail: `event ${doc.id} ("${event.title}") is due for ticket settlement, but curator `
        + `${event.curatorProfileId} is "${curatorStatus}", not approved; settlement withheld, use takedownEvent to refund`,
      bookingId: null, gigId: null, now,
    });
    if (shouldLog) {
      console.error(`paymentsSweep: event ${doc.id} ticket settlement withheld, curator not approved (see adminAlerts/${alertId})`);
    }
    report.ticketSettlementsBlocked++;
    return;
  }
```

In `settleTicketRevenue` (1513-1528) create the cache once and pass it: add `const curatorStatusCache = new Map<string, string>();` before the `for await`, and change the call to `await settleOneEvent(db, doc, now, report, curatorStatusCache);`.

- [ ] **Step 7:** Edit `functions/src/scheduled.ts`. Imports: change line 2 to `import { getFirestore, FieldPath, FieldValue } from "firebase-admin/firestore";` and add after line 12:

```ts
import { cancelAndRefundEventForModeration, type EventCascadeRetryDoc } from "./events.js";
import { stripeSecretKey } from "./stripeClient.js";
```

SweepReport: after `eventRemindersSent: number;` (line 273) add:

```ts
  // SP10 Task 10, step 9: eventCascadeRetries entries whose cancel + refund
  // succeeded this run (retry doc deleted).
  eventCascadeRetried: number;
```

and in `errors` after `eventReminders: number;` (line 292) add `eventCascadeRetries: number;`. Report init (lines 315 and 318): add `eventCascadeRetried: 0,` after `eventRemindersSent: 0,` and `eventCascadeRetries: 0,` after `eventReminders: 0,`.

Insert before `return report;` (line 950):

```ts
  // 9) Event cascade retry (SP10 Task 10): re-runs cancel + refund for any
  // event review.ts's reject-from-approved cascade could not resolve (see
  // eventCascadeRetries). Mirrors step 5's per-doc isolate-log-continue.
  await drainEventCascadeRetries(db, report);
```

and add the function after `runDailySweep` (after line 951):

```ts
async function drainEventCascadeRetries(db: FirebaseFirestore.Firestore, report: SweepReport): Promise<void> {
  try {
    const retryQuery = db.collection("eventCascadeRetries").orderBy(FieldPath.documentId());
    for await (const page of paginate(retryQuery, SWEEP_PAGE_SIZE)) {
      for (const doc of page) {
        const retry = doc.data() as EventCascadeRetryDoc;
        try {
          await cancelAndRefundEventForModeration(doc.id, retry.reason, { kind: "system", cause: "profile_unpublished" });
          await doc.ref.delete();
          report.eventCascadeRetried++;
        } catch (e) {
          console.error(`dailySweep: event cascade retry failed for event ${doc.id}`, e);
          report.errors.eventCascadeRetries++;
          await doc.ref.update({
            attempts: FieldValue.increment(1), lastError: e instanceof Error ? e.message : String(e),
          }).catch((writeError) => console.error(`dailySweep: eventCascadeRetries update failed for ${doc.id}`, writeError));
        }
      }
    }
  } catch (e) {
    console.error("dailySweep: event cascade retry step failed", e);
    report.errors.eventCascadeRetries++;
  }
}
```

dailySweep options (line 966) become:

```ts
  { schedule: "every day 09:00", region: "us-central1", timeoutSeconds: 540, memory: "512MiB", secrets: [stripeSecretKey] },
```

- [ ] **Step 8:** `pnpm typecheck` 5/5, then run the three test files: all pass. Then `pnpm emu:test` in full: review.test.ts:267 still asserts the exact `(closed 2 gigs, paused 1 series)` detail (no events on that profile).

- [ ] **Step 9:** Commit: `feat(functions): events follow the profile: moderation cancel+refund, reject cascade, sale and settlement gates, sweep retry`

---

### Task 11: Admin `takedownEvent` and the Events block in Takedowns

**Files:**
- Create: `functions/src/eventsAdmin.ts`
- Modify: `functions/src/index.ts` (line 29)
- Modify: `apps/web/app/admin/page.tsx` (imports 23-28; TakedownsPanel render 1198-1276: insert the Events block before the closing `</section>` at 1276)
- Modify: `functions/test/eventCascade.test.ts` (new describe)

**Interfaces:**
- Consumes: `requireAdmin`, `writeAudit` (review.ts:9, 17), `cancelAndRefundEventForModeration` (Task 10), `notifyProfileMembers` (notifications.ts:27), `ReasonCard` (admin/page.tsx:128), `AuditLogDoc.action` `"event_taken_down"` (Task 1).
- Produces:

```ts
export interface TakedownEventInput { eventId: string; reason: string; }
export interface TakedownEventResult { ok: true; outcome: ModerationCancelResult["outcome"]; ordersRefunded: number; }
export const takedownEvent: CallableFunction<TakedownEventInput, Promise<TakedownEventResult>>;
```

**Steps:**

- [ ] **Step 1:** Add to `functions/test/eventCascade.test.ts`:

```ts
describe("takedownEvent (admin)", () => {
  it("cancels and refunds one event regardless of curator status, audits it, and notifies the curator", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("tde1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1500, capacity: 20, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("tde1buyer");
    const orderId = await payOrder(eventId, tierId, 2, buyer.user);
    // The curator is already unpublished: cancelEvent would refuse them
    // (requireApprovedCuratorProfile); the admin path must not care.
    await adb.doc(`profiles/${profileId}`).update({ status: "rejected" });

    const reviewer = await makeAdminUser("tde1r");
    const result = await callFn<Record<string, unknown>, { ok: boolean; outcome: string; ordersRefunded: number }>(
      "takedownEvent", { eventId, reason: "Fraudulent listing." }, reviewer.user);
    expect(result.outcome).toBe("cancelled");
    expect(result.ordersRefunded).toBe(1);

    expect((await adb.doc(`events/${eventId}`).get()).data()?.status).toBe("cancelled");
    const order = (await adb.doc(`orders/${orderId}`).get()).data() as TicketOrderDoc;
    expect(order.status).toBe("cancelled_refunded");

    const logs = await adb.collection("auditLogs")
      .where("targetId", "==", eventId).where("action", "==", "event_taken_down").get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data().actorUid).toBe(reviewer.uid);
    expect(logs.docs[0].data().detail).toBe("[was published] Fraudulent listing. (refunded 1 orders, expired 0 pending)");

    const note = await pollNotifications(owner.uid, (d) => d.kind === "gig_moderation" && /taken down/.test(d.title));
    expect(note).toBeDefined();
    expect(note!.data().body).toContain("Fraudulent listing.");
  });

  it("non-admin is denied; a completed event, a missing reason, and a bad id are refused", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("tde2");
    await expect(callFn("takedownEvent", { eventId, reason: "x" }, owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    const reviewer = await makeAdminUser("tde2r");
    await expect(callFn("takedownEvent", { eventId, reason: "   " }, reviewer.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await expect(callFn("takedownEvent", { eventId: "../x", reason: "r" }, reviewer.user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
    await adb.doc(`events/${eventId}`).update({ status: "completed", completedAt: Date.now() });
    await expect(callFn("takedownEvent", { eventId, reason: "Too late." }, reviewer.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    expect(profileId).toBeTruthy();
  });
});
```

- [ ] **Step 2:** Run `eventCascade.test.ts`: the new describe fails with `functions/not-found` (no callable named takedownEvent).

- [ ] **Step 3:** Create `functions/src/eventsAdmin.ts`:

```ts
/**
 * SP10 Task 11: admin-side event moderation. Kept out of events.ts so the
 * event lifecycle module never imports review.ts (requireAdmin/writeAudit)
 * directly; see the section header note on the review -> events -> gigs ->
 * review cycle.
 */
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { isValidDocId, type EventDoc } from "@gatekeep/shared";
import { requireAdmin, writeAudit } from "./review.js";
import { notifyProfileMembers } from "./notifications.js";
import { stripeSecretKey } from "./stripeClient.js";
import { cancelAndRefundEventForModeration, type ModerationCancelResult } from "./events.js";

export interface TakedownEventInput { eventId: string; reason: string; }
export interface TakedownEventResult {
  ok: true; outcome: ModerationCancelResult["outcome"]; ordersRefunded: number;
}

// requireAdmin, then the same 1..500 reason contract reviewProfile and
// takedownGig enforce. Cancels and refunds regardless of the curator's
// status (the curator's own cancelEvent is gated on approval, which is the
// whole reason this exists: sp1 #1, cross #1). A completed event is refused
// outright rather than silently skipped: its settlement already ran, and an
// admin asking to refund it needs to know that is a Stripe-dashboard job.
export const takedownEvent = onCall<TakedownEventInput>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req): Promise<TakedownEventResult> => {
    const actorUid = requireAdmin(req);
    const { eventId, reason } = req.data ?? ({} as TakedownEventInput);
    if (!isValidDocId(eventId)) throw new HttpsError("invalid-argument", "An event id is required.");
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new HttpsError("invalid-argument", "A takedown reason is required.");
    }
    const trimmedReason = reason.trim();
    if (trimmedReason.length > 500) {
      throw new HttpsError("invalid-argument", "Takedown reason must be 500 characters or fewer.");
    }

    const snap = await getFirestore().doc(`events/${eventId}`).get();
    if (!snap.exists) throw new HttpsError("not-found", "Event not found.");
    const event = snap.data() as EventDoc;
    if (event.status === "completed") {
      throw new HttpsError("failed-precondition",
        "This event has completed and its ticket revenue has settled. Refunds for it are a Stripe dashboard action.");
    }

    const result = await cancelAndRefundEventForModeration(eventId, trimmedReason, { kind: "admin", uid: actorUid });

    await writeAudit({
      actorUid, action: "event_taken_down", targetId: eventId,
      detail: `[was ${event.status}] ${trimmedReason} (refunded ${result.orders.ordersRefunded} orders, expired ${result.orders.pendingExpired} pending)`,
    });
    await notifyProfileMembers(event.curatorProfileId, {
      kind: "gig_moderation", refId: eventId,
      title: `Your event "${event.title}" was taken down`,
      body: `Reviewer note: ${trimmedReason} Ticket holders have been refunded in full.`,
    });
    return { ok: true, outcome: result.outcome, ordersRefunded: result.orders.ordersRefunded };
  });
```

Add to `functions/src/index.ts` after line 29: `export { takedownEvent } from "./eventsAdmin.js";`

- [ ] **Step 4:** Run `eventCascade.test.ts`: passes. `pnpm typecheck`.

- [ ] **Step 5:** Admin UI. In `apps/web/app/admin/page.tsx` extend the shared import (lines 23-28) with `type EventDoc, type EventStatus, type TicketOrderDoc`. Add these definitions above `TakedownsPanel` (before line 1122):

```tsx
const EVENT_STATUS_BADGE: Record<EventStatus, { variant: BadgeVariant; label: string }> = {
  draft: { variant: "secondary", label: "Draft" },
  published: { variant: "success", label: "Published" },
  completed: { variant: "outline", label: "Completed" },
  cancelled: { variant: "destructive", label: "Cancelled" },
};

type EventCounts = { tiers: number; paidOrders: number; validTickets: number; refundedTickets: number };

// Read-only figures for the takedown decision. Every query is admin-provable
// under firestore.rules (tiers and attendees via isAdmin(), orders via the
// signedIn() && isAdmin() disjunct) and served by single-field indexes.
async function loadEventCounts(eventId: string): Promise<EventCounts> {
  const { db } = getFirebase();
  const [tiers, orders, valid] = await Promise.all([
    getDocs(collection(db, `events/${eventId}/tiers`)),
    getDocs(query(collection(db, "orders"), where("eventId", "==", eventId))),
    getDocs(query(collection(db, `events/${eventId}/attendees`), where("status", "==", "valid"))),
  ]);
  let paidOrders = 0;
  let refundedTickets = 0;
  for (const o of orders.docs) {
    const order = o.data() as TicketOrderDoc;
    if (order.status === "paid") paidOrders++;
    refundedTickets += order.refundedTicketIds.length;
  }
  return { tiers: tiers.size, paidOrders, validTickets: valid.size, refundedTickets };
}

// SP10 Task 11: the Events block of the Takedowns panel. Lookup by event id
// or @handle (up to 50 of that curator's events, newest first, sorted
// client-side: the events index that pins curatorProfileId also pins status,
// and this list deliberately spans statuses). Cancel-and-refund goes through
// the takedownEvent callable via ReasonCard, the same control the profile
// unpublish above uses.
function EventsTakedown() {
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<Row<EventDoc>[]>([]);
  const [counts, setCounts] = useState<Record<string, EventCounts>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [takedownBusy, setTakedownBusy] = useState(false);
  const [takedownError, setTakedownError] = useState<string | null>(null);
  const seq = useRef(0);

  const lookup = async () => {
    const raw = term.trim();
    if (!raw) return;
    const mySeq = ++seq.current;
    setBusy(true); setError(null); setEvents([]); setCounts({}); setOpenId(null);
    try {
      const { db } = getFirebase();
      let rows: Row<EventDoc>[] = [];
      if (raw.startsWith("@")) {
        const handleDoc = await getDoc(doc(db, "handles", raw.slice(1).toLowerCase()));
        if (mySeq !== seq.current) return;
        if (!handleDoc.exists()) { setError("No profile with that handle."); return; }
        const pid = (handleDoc.data() as { profileId: string }).profileId;
        const snap = await getDocs(query(collection(db, "events"), where("curatorProfileId", "==", pid), limit(50)));
        rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as EventDoc) }))
          .sort((a, b) => b.startsAt - a.startsAt);
      } else {
        const eventDoc = await getDoc(doc(db, "events", raw));
        if (mySeq !== seq.current) return;
        if (!eventDoc.exists()) { setError("No event with that id."); return; }
        rows = [{ id: eventDoc.id, ...(eventDoc.data() as EventDoc) }];
      }
      const entries = await Promise.all(rows.map(async (ev) => [ev.id, await loadEventCounts(ev.id)] as const));
      if (mySeq !== seq.current) return;
      setEvents(rows);
      setCounts(Object.fromEntries(entries));
      if (rows.length === 0) setError("That curator has no events.");
    } catch (e) {
      if (mySeq === seq.current) setError(e instanceof Error ? e.message : "Could not look up events, try again.");
    } finally {
      if (mySeq === seq.current) setBusy(false);
    }
  };

  const takedown = async (eventId: string) => {
    const trimmed = reason.trim();
    if (trimmed.length < 1 || trimmed.length > 500) { setTakedownError("Reason must be 1-500 characters."); return; }
    setTakedownBusy(true); setTakedownError(null);
    try {
      await httpsCallable(getFirebase().functions, "takedownEvent")({ eventId, reason: trimmed });
      const fresh = await loadEventCounts(eventId);
      setEvents((rows) => rows.map((r) => (r.id === eventId ? { ...r, status: "cancelled" } : r)));
      setCounts((c) => ({ ...c, [eventId]: fresh }));
      setOpenId(null); setReason("");
    } catch (e) {
      setTakedownError(e instanceof Error ? e.message : "Could not take down the event, try again.");
    } finally {
      setTakedownBusy(false);
    }
  };

  return (
    <div className="grid gap-3">
      <h3 className="font-syne text-base font-semibold text-gk-text">Events</h3>
      <p className="font-sora text-sm text-gk-muted">Cancel and refund one event, whatever the curator&apos;s status.</p>
      <div className="flex flex-wrap gap-2">
        <Input
          placeholder="Event id or @handle"
          value={term}
          className="w-72"
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !busy) void lookup(); }}
        />
        <Button variant="secondary" disabled={busy} onClick={lookup}>{busy ? "Looking up…" : "Look up"}</Button>
      </div>
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
      {events.map((ev) => {
        const c = counts[ev.id];
        const canTakeDown = ev.status === "published" || ev.status === "draft";
        return (
          <Card key={ev.id}>
            <CardContent className="grid gap-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-syne text-base font-semibold text-gk-text">{ev.title}</p>
                <Badge variant={EVENT_STATUS_BADGE[ev.status].variant}>{EVENT_STATUS_BADGE[ev.status].label}</Badge>
                <span className="font-sora text-sm text-gk-muted">{formatGigDateTime(ev.startsAt)}</span>
              </div>
              <p className="font-mono text-xs text-gk-muted">{ev.id}</p>
              {c && (
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1 font-sora text-sm sm:grid-cols-4">
                  <div><dt className="text-gk-muted">Tiers</dt><dd className="text-gk-text">{c.tiers}</dd></div>
                  <div><dt className="text-gk-muted">Paid orders</dt><dd className="text-gk-text">{c.paidOrders}</dd></div>
                  <div><dt className="text-gk-muted">Valid tickets</dt><dd className="text-gk-text">{c.validTickets}</dd></div>
                  <div><dt className="text-gk-muted">Refunded tickets</dt><dd className="text-gk-text">{c.refundedTickets}</dd></div>
                </dl>
              )}
              {canTakeDown ? (
                <div>
                  <Button size="sm" variant="secondary" className="text-gk-destructive" disabled={takedownBusy}
                    onClick={() => { setOpenId((id) => (id === ev.id ? null : ev.id)); setTakedownError(null); setReason(""); }}>
                    Cancel and refund
                  </Button>
                </div>
              ) : (
                <p className="font-sora text-sm text-gk-muted">
                  {ev.status === "completed" ? "Completed and settled. Refunds for it are a Stripe dashboard action." : "Already cancelled."}
                </p>
              )}
              {openId === ev.id && (
                <ReasonCard
                  title="Cancel and refund this event"
                  warning="Every paid order is refunded in full, including the service fee, and ticket holders are told why."
                  placeholder="Takedown reason (shown to the curator and to ticket holders)"
                  reason={reason} onReasonChange={setReason}
                  busy={takedownBusy} error={takedownError}
                  onSubmit={() => void takedown(ev.id)} onCancel={() => { setOpenId(null); setTakedownError(null); }}
                  submitLabel="Confirm cancel and refund" busyLabel="Cancelling…"
                />
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
```

Inside `TakedownsPanel`'s JSX, insert `<EventsTakedown />` immediately before the closing `</section>` (line 1276, after the "No approved tracks." line). Update the panel intro at line 1200 to `Retroactively remove a live profile, track, or event (spec section 6).`

- [ ] **Step 6:** `pnpm --filter @gatekeep/web lint` 0 errors, `pnpm --filter @gatekeep/web build`, then a live `/admin` load: look up an event by id and by `@handle`, confirm the counts render and Cancel-and-refund flips the badge.

- [ ] **Step 7:** Commit: `feat(admin): takedownEvent callable and the Events block in Takedowns`

---

### Task 12: `deleteProfile` money gate, Stripe ids in the audit entry, client refusal rendering

**Files:**
- Modify: `functions/src/profiles.ts` (imports 1-13, options 229, gate insertion after 240, audit before 327)
- Modify: `firestore.indexes.json` (two payments collection-group composites)
- Modify: `apps/web/app/dashboard/curator/[profileId]/page.tsx` (state 73-74, deleteDraft 135-146, button 275-283), `apps/web/app/dashboard/portfolio/[profileId]/page.tsx` (state 90, deleteDraft 186-197, button 298-306)
- Modify: `apps/mobile/app/(curator)/dashboard.tsx` (doDelete 156-168, button 245-252), `apps/mobile/app/(musician)/portfolio.tsx` (state 79, doDelete 242-254, button 329-335)
- Modify: `functions/test/profiles.test.ts` (new describe)

**Interfaces:**
- Consumes: `getStripeProfileDoc` (paymentsCore.ts:45), `getStripe().getBalances(accountId)` returning `{ availableCents, instantAvailableCents }` (stripeClient.ts:197), `DELETE_PROFILE_*` constants (Task 1), `AuditLogDoc.action` `"profile_deleted_stripe_ids"` (Task 1), `PaymentDoc`, `EventDoc`.
- Produces (profiles.ts, module-private): `assertNoMoneyOutstanding(db, profileId, isCurator): Promise<StripeProfileDoc | null>`.

Index plan for the payments queries (spec section 7 names only the musician settlement twin; the
deposit twin is added here, reported as an addition): curator settlement rides the existing
`(curatorProfileId, settlement.status)` composite; curator deposit rides the existing
`(curatorProfileId, deposit.status, deposit.depositAttempts)` composite as an equality prefix;
musician settlement and musician deposit get `(musicianProfileId, settlement.status)` and
`(musicianProfileId, deposit.status)`.

**Steps:**

- [ ] **Step 1:** Add to `functions/test/profiles.test.ts` (imports: add `DELETE_PROFILE_BALANCE_MESSAGE, DELETE_PROFILE_DELINQUENT_MESSAGE, DELETE_PROFILE_PAYMENTS_MESSAGE, DELETE_PROFILE_EVENTS_MESSAGE, type PaymentDoc, type StripeProfileDoc` to the `@gatekeep/shared` import at lines 9-11):

```ts
// SP10 Task 12 fixtures: the money gate reads private/stripe, the payments
// collection group, and the profile's events. All seeded directly via the
// admin SDK: the subject is the gate, not the Stripe onboarding or booking
// flows that ordinarily produce these docs.
function stripeDoc(overrides: Partial<StripeProfileDoc> = {}): StripeProfileDoc {
  return {
    customerId: null, defaultPaymentMethodId: null, cardBrand: null, cardLast4: null,
    accountId: null, transfersEnabled: false, payoutsEnabled: false, instantEligible: false,
    onboardingStartedAt: null, onboardedAt: null, delinquent: false, delinquentSince: null,
    updatedAt: Date.now(), ...overrides,
  };
}

function paymentDoc(curatorProfileId: string, musicianProfileId: string, overrides: {
  depositStatus?: PaymentDoc["deposit"]["status"]; depositAttempts?: number;
  settlementStatus?: PaymentDoc["settlement"]["status"];
} = {}): PaymentDoc {
  const now = Date.now();
  return {
    bookingId: "seed-booking", gigId: "seed-gig", occurrenceStartsAt: now + 86_400_000,
    curatorProfileId, musicianProfileId, selfDeal: false, baseCents: 10_000,
    deposit: {
      sliceCents: 2_500, feeShareCents: 250, intentId: "pi_seed", chargeId: null,
      status: overrides.depositStatus ?? "applied", chargedAt: now, resolvedAt: null, forfeitTransferId: null,
      depositAttempts: overrides.depositAttempts ?? 0,
    },
    settlement: {
      status: overrides.settlementStatus ?? "not_due", settleAfter: null, computedCents: null, feeShareCents: null,
      trueUp: null, intentId: null, attempts: 0, nextRetryAt: null,
      lateFeeCents: null, lateFeeMusicianCents: null, delinquentAt: null,
    },
    transfer: { status: "none", id: null, amountCents: null, transferredAt: null },
    createdAt: now, updatedAt: now,
  };
}

async function draftMusician(prefix: string) {
  const { user, uid } = await signUpTestUser(`${prefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft", draft(`${prefix}_${Date.now()}`), user);
  return { user, uid, profileId };
}

describe("deleteProfile money gate (SP10)", () => {
  it("refuses while the connected account holds a balance, and allows once it is zero", async () => {
    const { user, profileId } = await draftMusician("gate1");
    await adb.doc(`profiles/${profileId}/private/stripe`).set(stripeDoc({ accountId: "acct_gate1" }));
    await adb.doc(`stripeFake/state/objects/acct_gate1`).set({ balanceCents: 500 }, { merge: true });
    await expect(callFn("deleteProfile", { profileId }, user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: DELETE_PROFILE_BALANCE_MESSAGE });
    expect((await adb.doc(`profiles/${profileId}`).get()).exists).toBe(true);
    await adb.doc(`stripeFake/state/objects/acct_gate1`).set({ balanceCents: 0 }, { merge: true });
    await callFn("deleteProfile", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).exists).toBe(false);
  });

  it("refuses a delinquent profile; balance is checked first when both apply", async () => {
    const { user, profileId } = await draftMusician("gate2");
    await adb.doc(`profiles/${profileId}/private/stripe`).set(stripeDoc({ delinquent: true, delinquentSince: Date.now() }));
    await expect(callFn("deleteProfile", { profileId }, user))
      .rejects.toMatchObject({ message: DELETE_PROFILE_DELINQUENT_MESSAGE });
    await adb.doc(`profiles/${profileId}/private/stripe`).set(
      stripeDoc({ accountId: "acct_gate2", delinquent: true, delinquentSince: Date.now() }));
    await adb.doc(`stripeFake/state/objects/acct_gate2`).set({ balanceCents: 100 }, { merge: true });
    await expect(callFn("deleteProfile", { profileId }, user))
      .rejects.toMatchObject({ message: DELETE_PROFILE_BALANCE_MESSAGE });
  });

  it("refuses while a payments doc names the profile on either side with money moving", async () => {
    const { user, profileId } = await draftMusician("gate3");
    const paymentRef = adb.doc(`bookings/gate3-${Date.now()}/payments/seed-gig`);
    // Musician side, deposit held.
    await paymentRef.set(paymentDoc("some-curator", profileId, { depositStatus: "held" }));
    await expect(callFn("deleteProfile", { profileId }, user))
      .rejects.toMatchObject({ message: DELETE_PROFILE_PAYMENTS_MESSAGE });
    // Unpaid with an attempt IS moving (dunning in flight).
    await paymentRef.set(paymentDoc("some-curator", profileId, { depositStatus: "unpaid", depositAttempts: 1 }));
    await expect(callFn("deleteProfile", { profileId }, user))
      .rejects.toMatchObject({ message: DELETE_PROFILE_PAYMENTS_MESSAGE });
    // Curator side, settlement past_due.
    await paymentRef.set(paymentDoc(profileId, "some-musician", { settlementStatus: "past_due" }));
    await expect(callFn("deleteProfile", { profileId }, user))
      .rejects.toMatchObject({ message: DELETE_PROFILE_PAYMENTS_MESSAGE });
    // Unpaid with no attempts (never charged, never dunned) is not "moving": allowed.
    await paymentRef.set(paymentDoc(profileId, "some-musician", { depositStatus: "unpaid", depositAttempts: 0, settlementStatus: "not_due" }));
    await callFn("deleteProfile", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).exists).toBe(false);
  });

  it("refuses a curator with a published event, or a cancelled event still holding a paid order; allows once settled", async () => {
    const { user } = await signUpTestUser(`gate4-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", curatorDraft(`gate4_${Date.now()}`), user);
    // Seeded directly (a draft curator cannot publish through the callables).
    const eventRef = adb.collection("events").doc();
    const now = Date.now();
    await eventRef.set({
      curatorProfileId: profileId, title: "Seeded", description: "", status: "published",
      location: { venueName: null, neighborhood: null, city: "Austin", geo: null, addressVisibility: "neighborhood", address: null },
      startsAt: now + 86_400_000, endsAt: now + 90_000_000, posterPath: null, maxTicketsPerBuyer: 8,
      lineup: [], lineupMusicianProfileIds: [], gigId: null, createdAt: now, updatedAt: now,
    });
    await expect(callFn("deleteProfile", { profileId }, user))
      .rejects.toMatchObject({ message: DELETE_PROFILE_EVENTS_MESSAGE });

    await eventRef.update({ status: "cancelled", cancelledAt: now });
    const orderRef = adb.collection("orders").doc();
    await orderRef.set({
      buyerUid: "someone", eventId: eventRef.id, curatorProfileId: profileId,
      items: [{ tierId: "t", quantity: 1, unitPriceCents: 1000, tierName: "General" }],
      faceTotalCents: 1000, serviceFeeCents: 169, feePolicy: { ticketFeePct: 7, ticketFeeFixedCents: 99, ticketFeeCapCents: 399 },
      paymentIntentId: "pi_x", status: "paid", refundedTicketIds: [], refundedCents: 0, refundedFaceCents: 0,
      createdAt: now, expiresAt: now + 600_000, paidAt: now,
    });
    await expect(callFn("deleteProfile", { profileId }, user))
      .rejects.toMatchObject({ message: DELETE_PROFILE_EVENTS_MESSAGE });

    await orderRef.update({ status: "cancelled_refunded" });
    await callFn("deleteProfile", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).exists).toBe(false);
  });

  it("records the Stripe customer and account ids in an audit entry before the private/stripe doc is deleted", async () => {
    const { user, uid, profileId } = await draftMusician("gate5");
    await adb.doc(`profiles/${profileId}/private/stripe`).set(stripeDoc({ customerId: "cus_gate5", accountId: "acct_gate5" }));
    await callFn("deleteProfile", { profileId }, user);
    const logs = await adb.collection("auditLogs")
      .where("targetId", "==", profileId).where("action", "==", "profile_deleted_stripe_ids").get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data().actorUid).toBe(uid);
    expect(logs.docs[0].data().detail).toBe("customerId=cus_gate5 accountId=acct_gate5");
  });
});
```

- [ ] **Step 2:** Run `profiles.test.ts`: every new case fails (the delete succeeds where a refusal is expected; no `profile_deleted_stripe_ids` entry).

- [ ] **Step 3:** Edit `functions/src/profiles.ts`. Imports: extend the `@gatekeep/shared` import (lines 3-8) with `DELETE_PROFILE_BALANCE_MESSAGE, DELETE_PROFILE_DELINQUENT_MESSAGE, DELETE_PROFILE_PAYMENTS_MESSAGE, DELETE_PROFILE_EVENTS_MESSAGE, type PaymentDoc, type EventDoc, type StripeProfileDoc`; add after line 13:

```ts
import { getStripe, stripeSecretKey } from "./stripeClient.js";
import { getStripeProfileDoc } from "./paymentsCore.js";
```

Add the gate helpers after `deleteSeriesForProfile` (after line 63):

```ts
// SP10 Task 12 (spec section 5.3): deleteProfile refuses while money is
// outstanding, in this order, each with its own client-keyed message.
const OPEN_DEPOSIT_STATUSES: PaymentDoc["deposit"]["status"][] = ["held", "refund_pending", "forfeit_pending", "unpaid"];
const OPEN_SETTLEMENT_STATUSES: PaymentDoc["settlement"]["status"][] = ["pending", "past_due"];

// Any payments doc naming the profile on either side with a deposit still
// held or resolving, an unpaid deposit that dunning has already attempted,
// or a settlement pending or past due. Indexes: curator side rides the SP5
// (curatorProfileId, settlement.status) and (curatorProfileId,
// deposit.status, deposit.depositAttempts) composites; musician side uses
// the two (musicianProfileId, ...) twins added with this task.
async function hasPaymentsInFlight(db: FirebaseFirestore.Firestore, profileId: string): Promise<boolean> {
  for (const side of ["curatorProfileId", "musicianProfileId"] as const) {
    const settlements = await db.collectionGroup("payments")
      .where(side, "==", profileId).where("settlement.status", "in", OPEN_SETTLEMENT_STATUSES).limit(1).get();
    if (!settlements.empty) return true;
    const deposits = await db.collectionGroup("payments")
      .where(side, "==", profileId).where("deposit.status", "in", OPEN_DEPOSIT_STATUSES).get();
    for (const doc of deposits.docs) {
      const p = doc.data() as PaymentDoc;
      if (p.deposit.status !== "unpaid" || (p.deposit.depositAttempts ?? 0) > 0) return true;
    }
  }
  return false;
}

// Any event still published, or any event (cancelled or draft included)
// with a paid order and no settlement started: a cancelled event whose
// refund loop has not converged still holds buyer money.
async function hasEventsOutstanding(db: FirebaseFirestore.Firestore, profileId: string): Promise<boolean> {
  const events = await db.collection("events").where("curatorProfileId", "==", profileId).get();
  for (const doc of events.docs) {
    const event = doc.data() as EventDoc;
    if (event.status === "published") return true;
    if (event.status === "completed" || event.settlementStartedAt != null) continue;
    const paid = await db.collection("orders")
      .where("eventId", "==", doc.id).where("status", "==", "paid").limit(1).get();
    if (!paid.empty) return true;
  }
  return false;
}

// Returns the private/stripe doc (or null) so the caller can record its ids
// in the audit trail before recursiveDelete removes the only copy.
async function assertNoMoneyOutstanding(
  db: FirebaseFirestore.Firestore, profileId: string, isCurator: boolean,
): Promise<StripeProfileDoc | null> {
  const stripe = await getStripeProfileDoc(profileId);
  if (stripe?.accountId) {
    // Live read, never the cached doc: the balance changes without any
    // Firestore write (a payout landing, a transfer arriving).
    const balances = await getStripe().getBalances(stripe.accountId);
    if (balances.availableCents !== 0) {
      throw new HttpsError("failed-precondition", DELETE_PROFILE_BALANCE_MESSAGE);
    }
  }
  if (stripe?.delinquent === true) {
    throw new HttpsError("failed-precondition", DELETE_PROFILE_DELINQUENT_MESSAGE);
  }
  if (await hasPaymentsInFlight(db, profileId)) {
    throw new HttpsError("failed-precondition", DELETE_PROFILE_PAYMENTS_MESSAGE);
  }
  if (isCurator && await hasEventsOutstanding(db, profileId)) {
    throw new HttpsError("failed-precondition", DELETE_PROFILE_EVENTS_MESSAGE);
  }
  return stripe;
}
```

In `deleteProfile`: line 229 options become `{ region: "us-central1", secrets: [stripeSecretKey] }`. Move line 254 (`const isCurator = ...`) up to directly after the not-found check (line 240) and insert the gate before the status gate:

```ts
  const isCurator = snap.data()?.type === "curator";
  // SP10 Task 12: the money gate runs BEFORE the status gate, so a rejected
  // profile with money outstanding hears about the money, not the status.
  const stripe = await assertNoMoneyOutstanding(db, profileId, isCurator);
```

(and delete the original line 254). Insert before `await db.recursiveDelete(profileRef);` (line 327):

```ts
  // SP10 Task 12 (cross #23): private/stripe is the only Firestore record of
  // the Stripe customer and connected account; recursiveDelete is about to
  // remove it, so the ids go into the audit trail first.
  if (stripe) {
    await writeAudit({
      actorUid: uid, action: "profile_deleted_stripe_ids", targetId: profileId,
      detail: `customerId=${stripe.customerId ?? "none"} accountId=${stripe.accountId ?? "none"}`,
    });
  }
```

- [ ] **Step 4:** Add to `firestore.indexes.json` after the `payments (curatorProfileId, deposit.status, deposit.depositAttempts)` entry:

```json
  { "collectionGroup": "payments", "queryScope": "COLLECTION_GROUP",
    "fields": [
      { "fieldPath": "musicianProfileId", "order": "ASCENDING" },
      { "fieldPath": "settlement.status", "order": "ASCENDING" }
    ] },
  { "collectionGroup": "payments", "queryScope": "COLLECTION_GROUP",
    "fields": [
      { "fieldPath": "musicianProfileId", "order": "ASCENDING" },
      { "fieldPath": "deposit.status", "order": "ASCENDING" }
    ] },
```

- [ ] **Step 5:** Run `profiles.test.ts`: the new describe passes; the pre-existing `deleteProfile` describes (137-417) still pass (their profiles have no private/stripe doc, no payments, no events). `pnpm typecheck`.

- [ ] **Step 6:** Clients. Web `dashboard/curator/[profileId]/page.tsx`: add `const [deleteError, setDeleteError] = useState<string | null>(null);` after line 74; in `deleteDraft` replace `window.alert(e instanceof Error ? e.message : "Could not delete this profile.");` with `setDeleteError(e instanceof Error ? e.message : "Could not delete this profile.");` and add `setDeleteError(null);` right after `setDeleteBusy(true);`. After the delete Button (line 283) add:

```tsx
            {deleteError && (
              <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
                <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                {deleteError}
              </p>
            )}
```

Same three edits in `dashboard/portfolio/[profileId]/page.tsx` (state after line 90, `deleteDraft` at 186-197, block after the Button at 306). Both pages already import `IconWarning` (used for the rejected banner).

Mobile `(curator)/dashboard.tsx`: add `const [deleteError, setDeleteError] = useState<string | null>(null);` beside `deleteBusy`; in `doDelete` replace `Alert.alert("Could not delete", e instanceof Error ? e.message : "Try again.");` with `setDeleteError(e instanceof Error ? e.message : "Couldn't delete this profile. Try again.");` and add `setDeleteError(null);` after `setDeleteBusy(true);`; after the delete `<Button ... />` at 246-252 add `<ErrorBanner message={deleteError} />`. Same in `(musician)/portfolio.tsx` (state beside line 79, `doDelete` at 242-254, banner after the Button at 329-335; `ErrorBanner` is already imported there at line 12).

- [ ] **Step 7:** `pnpm --filter @gatekeep/web lint`, `pnpm --filter @gatekeep/web build`, `pnpm --filter @gatekeep/mobile lint`. Live load `/dashboard/curator/<id>` and trigger a refusal (seed a `private/stripe` delinquent flag in the emulator UI) to see the inline banner.

- [ ] **Step 8:** Commit: `feat(functions,web,mobile): deleteProfile money gate with named refusals, Stripe ids audited, inline refusal banners`

---

### Task 13: `deleteAccount` refusals, `account_deleted` audit, client rendering

**Files:**
- Modify: `functions/src/account.ts` (whole file; Task 14 extracts the cascade from what this task writes)
- Modify: `apps/web/app/dashboard/page.tsx` (imports 15, state in `Dashboard` 262-265, `deleteAccount` 275-289, delete card 334-347)
- Modify: `apps/mobile/src/shell/AccountScreen.tsx` (whole component)
- Modify: `functions/test/account.test.ts` (new describe)

**Interfaces:**
- Consumes: `DELETE_ACCOUNT_TICKETS_MESSAGE`, `DELETE_ACCOUNT_TRANSFERS_MESSAGE`, `DELETE_ACCOUNT_ORDERS_MESSAGE`, `AuditLogDoc.action` `"account_deleted"` (Task 1), `writeAudit` (review.ts:17), `TicketDoc`, `EventDoc`, `TicketTransferDoc`, `TicketOrderDoc`.
- Produces (account.ts, module-private until Task 14 exports the cascade): `assertNothingOutstanding(db, uid, now): Promise<void>`.

**Steps:**

- [ ] **Step 1:** Add to `functions/test/account.test.ts` (extend the shared import at line 6 with `DELETE_ACCOUNT_TICKETS_MESSAGE, DELETE_ACCOUNT_TRANSFERS_MESSAGE, DELETE_ACCOUNT_ORDERS_MESSAGE`):

```ts
// SP10 Task 13: every refusal is seeded directly via the admin SDK. The
// subject is the gate, not the checkout/transfer flows that ordinarily
// produce these docs (ticketing.test.ts covers those).
async function seedFutureEvent(): Promise<string> {
  const ref = adb.collection("events").doc();
  const now = Date.now();
  await ref.set({
    curatorProfileId: "seed-curator", title: "Seeded show", description: "", status: "published",
    location: { venueName: null, neighborhood: null, city: "Austin", geo: null, addressVisibility: "neighborhood", address: null },
    startsAt: now + 86_400_000, endsAt: now + 90_000_000, posterPath: null, maxTicketsPerBuyer: 8,
    lineup: [], lineupMusicianProfileIds: [], gigId: null, createdAt: now, updatedAt: now,
  });
  return ref.id;
}

describe("deleteAccount refusals (SP10)", () => {
  it("refuses while the user holds a valid ticket to an event that has not ended; allows once it has", async () => {
    const fan = await signUpTestUser(`da1-${Date.now()}@test.com`);
    const eventId = await seedFutureEvent();
    await adb.doc(`users/${fan.uid}/tickets/t1`).set({
      eventId, tierId: "t", tierName: "General", orderId: "o1", curatorProfileId: "seed-curator",
      qrSecret: "x", status: "checked_in", createdAt: Date.now(),
    });
    await expect(callFn("deleteAccount", {}, fan.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: DELETE_ACCOUNT_TICKETS_MESSAGE });
    await adb.doc(`events/${eventId}`).update({ endsAt: Date.now() - 1000 });
    await callFn("deleteAccount", {}, fan.user);
    expect((await adb.doc(`users/${fan.uid}`).get()).exists).toBe(false);
  });

  it("refuses while a transfer is offered on either side", async () => {
    const fan = await signUpTestUser(`da2-${Date.now()}@test.com`);
    const now = Date.now();
    const ref = adb.collection("transfers").doc();
    await ref.set({ ticketId: "t", eventId: "e", fromUid: fan.uid, toUid: "other", status: "offered", createdAt: now, expiresAt: now + 86_400_000 });
    await expect(callFn("deleteAccount", {}, fan.user))
      .rejects.toMatchObject({ message: DELETE_ACCOUNT_TRANSFERS_MESSAGE });
    await ref.set({ ticketId: "t", eventId: "e", fromUid: "other", toUid: fan.uid, status: "offered", createdAt: now, expiresAt: now + 86_400_000 });
    await expect(callFn("deleteAccount", {}, fan.user))
      .rejects.toMatchObject({ message: DELETE_ACCOUNT_TRANSFERS_MESSAGE });
    await ref.update({ status: "declined", resolvedAt: now });
    await callFn("deleteAccount", {}, fan.user);
  });

  it("refuses while a ticket order is pending", async () => {
    const fan = await signUpTestUser(`da3-${Date.now()}@test.com`);
    const now = Date.now();
    const ref = adb.collection("orders").doc();
    await ref.set({
      buyerUid: fan.uid, eventId: "e", curatorProfileId: "c", items: [], faceTotalCents: 0, serviceFeeCents: 0,
      feePolicy: { ticketFeePct: 7, ticketFeeFixedCents: 99, ticketFeeCapCents: 399 }, paymentIntentId: null,
      status: "pending", refundedTicketIds: [], refundedCents: 0, refundedFaceCents: 0, createdAt: now, expiresAt: now + 600_000,
    });
    await expect(callFn("deleteAccount", {}, fan.user))
      .rejects.toMatchObject({ message: DELETE_ACCOUNT_ORDERS_MESSAGE });
    await ref.update({ status: "expired" });
    await callFn("deleteAccount", {}, fan.user);
  });

  it("writes an account_deleted audit entry on success", async () => {
    const fan = await signUpTestUser(`da4-${Date.now()}@test.com`);
    await callFn("deleteAccount", {}, fan.user);
    const logs = await adb.collection("auditLogs")
      .where("targetId", "==", fan.uid).where("action", "==", "account_deleted").get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data().actorUid).toBe(fan.uid);
  });
});
```

- [ ] **Step 2:** Run `account.test.ts`: the three refusal cases resolve instead of rejecting; the audit case finds 0 entries.

- [ ] **Step 3:** Rewrite `functions/src/account.ts`:

```ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import {
  DELETE_ACCOUNT_TICKETS_MESSAGE, DELETE_ACCOUNT_TRANSFERS_MESSAGE, DELETE_ACCOUNT_ORDERS_MESSAGE,
  type TicketDoc, type EventDoc, type TicketTransferDoc, type TicketOrderDoc,
} from "@gatekeep/shared";
import { writeAudit } from "./review.js";

// Consumes membership invariants (Task 8: never-zero-admins per profile) and
// the users/{uid} tree created by onUserCreated (Task 5).
//
// Known limitation (v1, accepted per task dispatch): the sole-admin check
// below is a plain read, not transactional like removeMember's (Task 8).
// Account deletion is a rare, user-initiated action, so a race between two
// concurrent deletions/removals is an acceptable risk for now rather than a
// reason to add transactional complexity here.

const RETRY_SAFE_MESSAGE = "Account deletion did not complete. It is safe to try again.";

// SP10 Task 13 (spec section 5.3, cross #2): nothing is unwound by
// deletion. Tickets, then transfers, then orders, each with its own
// client-keyed message. The transfer and order scans filter status in
// memory off a single-field query: both are bounded by one user's own
// history, and neither has a (uid, status) composite today.
async function assertNothingOutstanding(db: FirebaseFirestore.Firestore, uid: string, now: number): Promise<void> {
  const tickets = await db.collection(`users/${uid}/tickets`).where("status", "in", ["valid", "checked_in"]).get();
  const eventIds = [...new Set(tickets.docs.map((d) => (d.data() as TicketDoc).eventId))];
  for (const eventId of eventIds) {
    const event = (await db.doc(`events/${eventId}`).get()).data() as EventDoc | undefined;
    if (event && event.endsAt > now) throw new HttpsError("failed-precondition", DELETE_ACCOUNT_TICKETS_MESSAGE);
  }

  const [fromSnap, toSnap] = await Promise.all([
    db.collection("transfers").where("fromUid", "==", uid).get(),
    db.collection("transfers").where("toUid", "==", uid).get(),
  ]);
  const offered = [...fromSnap.docs, ...toSnap.docs].some((d) => (d.data() as TicketTransferDoc).status === "offered");
  if (offered) throw new HttpsError("failed-precondition", DELETE_ACCOUNT_TRANSFERS_MESSAGE);

  const orders = await db.collection("orders").where("buyerUid", "==", uid).get();
  if (orders.docs.some((d) => (d.data() as TicketOrderDoc).status === "pending")) {
    throw new HttpsError("failed-precondition", DELETE_ACCOUNT_ORDERS_MESSAGE);
  }
}

export const deleteAccount = onCall({ region: "us-central1" }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const db = getFirestore();
  const now = Date.now();

  await assertNothingOutstanding(db, uid, now);

  // Block deletion while sole admin anywhere (spec section 4).
  const memberships = await db.collectionGroup("members").where("uid", "==", uid).get();
  const soleAdminOf: string[] = [];
  for (const m of memberships.docs) {
    if (m.data().role !== "admin") continue;
    const profileRef = m.ref.parent.parent!;
    const admins = await profileRef.collection("members").where("role", "==", "admin").get();
    if (admins.size <= 1) {
      const p = await profileRef.get();
      soleAdminOf.push(p.data()?.name ?? profileRef.id);
    }
  }
  if (soleAdminOf.length > 0) {
    throw new HttpsError("failed-precondition",
      `You are the only admin of: ${soleAdminOf.join(", ")}. Transfer admin or delete those profiles first.`);
  }

  // Phases are independently retry-idempotent; see the file header. S5:
  // curatorAccess/{uid} goes first so a stale marker never outlives the
  // account it describes.
  try {
    await Promise.all([
      db.doc(`curatorAccess/${uid}`).delete(),
      db.doc(`curatorAccessRetries/${uid}`).delete(),
    ]);
  } catch (e) {
    console.error("deleteAccount phase failed", { uid, phase: "curatorAccess" }, e);
    throw new HttpsError("internal", RETRY_SAFE_MESSAGE);
  }
  try {
    await Promise.all(memberships.docs.map((m) => m.ref.delete()));
  } catch (e) {
    console.error("deleteAccount phase failed", { uid, phase: "memberships" }, e);
    throw new HttpsError("internal", RETRY_SAFE_MESSAGE);
  }
  try {
    await db.recursiveDelete(db.doc(`users/${uid}`));
  } catch (e) {
    console.error("deleteAccount phase failed", { uid, phase: "firestore" }, e);
    throw new HttpsError("internal", RETRY_SAFE_MESSAGE);
  }
  try {
    await getAuth().deleteUser(uid);
  } catch (e) {
    console.error("deleteAccount phase failed", { uid, phase: "auth" }, e);
    throw new HttpsError("internal", RETRY_SAFE_MESSAGE);
  }
  // Written after the auth user is gone: the trail records what happened,
  // never a deletion that then failed.
  await writeAudit({ actorUid: uid, action: "account_deleted", targetId: uid, detail: `memberships removed: ${memberships.size}` });
  return { ok: true };
});
```

- [ ] **Step 4:** Run `account.test.ts`: all pass, including the five pre-existing cases.

- [ ] **Step 5:** Web `apps/web/app/dashboard/page.tsx`. Add `IconWarning` to the icons import (line 15). In `Dashboard` add `const [deleteError, setDeleteError] = useState<string | null>(null);` after `const router = useRouter();` (line 264, before the early returns). Replace the `deleteAccount` body's catch (lines 287-289):

```ts
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Couldn't delete your account. Try again.");
    }
```

and add `setDeleteError(null);` as the first line inside the `try`. Replace the delete card (lines 334-347) with:

```tsx
      <div className="mt-6 border-t border-gk-border pt-6">
        <p className="font-sora text-sm text-gk-muted">
          Deleting your account permanently removes it and everything tied to it. There&apos;s no undo.
          Tickets to upcoming events, open transfers, and orders in progress block deletion until they resolve.
        </p>
        <Button
          type="button"
          variant="link"
          className="mt-2 h-auto p-0 text-gk-destructive"
          onClick={deleteAccount}
        >
          Delete account
        </Button>
        {deleteError && (
          <p role="alert" className="mt-3 flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
            <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {deleteError}
          </p>
        )}
      </div>
```

Mobile `apps/mobile/src/shell/AccountScreen.tsx`:

```tsx
import { useState } from "react";
import { View, Alert } from "react-native";
import { httpsCallable } from "firebase/functions";
import { useAuth } from "../auth/AuthProvider";
import { getFirebase } from "../lib/firebase";
import { NotificationsList } from "./NotificationsList";
import { Text, Button, Card, ThemeToggle, PageBackground, ErrorBanner } from "../ui";
import { tokens } from "../theme/tokens";

// Shared by all three role account screens (fan/musician/curator), the
// screen is identical across roles, so each `app/(role)/account.tsx` is a
// thin wrapper around this component (SP2 deferred dedup item). Restyling it
// here retints all three at once and mounts the Appearance/ThemeToggle row in
// each, exactly as the per-role account.tsx wrappers render it.
export function AccountScreen() {
  const { user, signOutUser } = useAuth();
  // SP10 Task 13: a deletion refusal (tickets, transfers, orders, sole admin)
  // renders inline under the button instead of a native alert, so the user
  // can act on it with the rest of the screen still in view.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteAccount = () => {
    Alert.alert("Delete account", "This permanently deletes your account and data. Continue?",
      [{ text: "Cancel", style: "cancel" },
       { text: "Delete", style: "destructive", onPress: async () => {
          setDeleteError(null);
          try {
            await httpsCallable(getFirebase().functions, "deleteAccount")({});
            // The callable already deleted the auth user server-side; sign
            // out locally too so client state (and the Gate redirect) don't
            // depend on onAuthStateChanged noticing the now-invalid token.
            await signOutUser();
          } catch (e) {
            setDeleteError(e instanceof Error ? e.message : "Couldn't delete your account. Try again.");
          }
       } }]);
  };
  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <View style={{ flex: 1, padding: tokens.space.xl, gap: tokens.space.lg }}>
        <Text variant="title">{user?.email}</Text>
        <Card style={{ gap: tokens.space.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: tokens.space.md }}>
            <Text variant="label">Appearance</Text>
            <ThemeToggle />
          </View>
        </Card>
        <Button title="Sign out" variant="secondary" onPress={signOutUser} />
        <Button title="Delete account" variant="destructive" onPress={deleteAccount} />
        <ErrorBanner message={deleteError} />
        <NotificationsList />
      </View>
    </View>
  );
}
```

- [ ] **Step 6:** Web lint and build, mobile lint. Live `/dashboard` load; seed a pending order for the signed-in uid in the emulator UI and confirm the refusal renders inline.

- [ ] **Step 7:** Commit: `feat(functions,web,mobile): deleteAccount refuses on tickets, transfers, orders; account_deleted audit; inline refusal`

---

### Task 14: `cascadeDeleteUser` extraction and the `onUserDeleted` trigger

**Files:**
- Modify: `functions/src/account.ts` (extract the phases written in Task 13 into the exported cascade)
- Modify: `functions/src/authTriggers.ts` (import 1-4, new trigger after line 21)
- Modify: `functions/src/index.ts` (line 4)
- Modify: `functions/test/account.test.ts` (new describe), `functions/test/authTriggers.test.ts` (new describe)

**Interfaces:**
- Produces (account.ts): `export async function cascadeDeleteUser(uid: string, opts: { allowSoleAdmin: boolean }): Promise<void>` and `export class CascadePhaseError extends Error { readonly phase: string }`.
- Produces (authTriggers.ts): `export const onUserDeleted` (`functionsV1.auth.user().onDelete`).
- Consumes: `InviteDoc`, `TicketTransferDoc`; the Task 13 phases.

**Steps:**

- [ ] **Step 1:** Add to `functions/test/account.test.ts`:

```ts
describe("cascadeDeleteUser via deleteAccount (SP10)", () => {
  it("revokes pending invites naming the uid", async () => {
    const fan = await signUpTestUser(`cd1-${Date.now()}@test.com`);
    const now = Date.now();
    const ref = adb.collection("invites").doc();
    await ref.set({
      profileId: "p1", profileName: "Band", invitedUid: fan.uid, role: "member", label: "sax",
      invitedByUid: "owner", status: "pending", createdAt: now,
    });
    await callFn("deleteAccount", {}, fan.user);
    expect((await ref.get()).data()?.status).toBe("revoked");
  });
});
```

Add to `functions/test/authTriggers.test.ts` (imports: add `callFn` to the helpers import at line 6, `getAuth as adminAuth` from `firebase-admin/auth`, and `type ProfileDraftInput` from `@gatekeep/shared`):

```ts
async function waitForUserDocGone(uid: string, deadline = Date.now() + 15_000) {
  let snap = await adminFirestore(admin).doc(`users/${uid}`).get();
  while (snap.exists && Date.now() < deadline) {
    await wait(250);
    snap = await adminFirestore(admin).doc(`users/${uid}`).get();
  }
  return snap;
}

describe("onUserDeleted", () => {
  it("a console/Admin SDK deletion cascades: users tree, memberships, curatorAccess, pending invites revoked, offered transfers voided", async () => {
    const { uid } = await signUpTestUser(`od1-${Date.now()}@test.com`);
    await waitForUserDoc(uid);
    const adb = adminFirestore(admin);
    const now = Date.now();
    await adb.doc(`curatorAccess/${uid}`).set({});
    await adb.doc(`profiles/od1-profile-${now}/members/${uid}`).set({ uid, role: "member", label: "sax", joinedAt: now });
    const inviteRef = adb.collection("invites").doc();
    await inviteRef.set({
      profileId: "p1", profileName: "Band", invitedUid: uid, role: "member", label: "sax",
      invitedByUid: "owner", status: "pending", createdAt: now,
    });
    const transferRef = adb.collection("transfers").doc();
    await transferRef.set({ ticketId: "t", eventId: "e", fromUid: "other", toUid: uid, status: "offered", createdAt: now, expiresAt: now + 86_400_000 });

    await adminAuth(admin).deleteUser(uid);

    const gone = await waitForUserDocGone(uid);
    expect(gone.exists).toBe(false);
    expect((await adb.doc(`curatorAccess/${uid}`).get()).exists).toBe(false);
    expect((await adb.doc(`profiles/od1-profile-${now}/members/${uid}`).get()).exists).toBe(false);
    expect((await inviteRef.get()).data()?.status).toBe("revoked");
    const transfer = (await transferRef.get()).data();
    expect(transfer?.status).toBe("voided");
    expect(typeof transfer?.resolvedAt).toBe("number");
  }, 30_000);

  it("a sole admin deleted from the console is logged, not refused: the membership goes, the profile stays", async () => {
    const owner = await signUpTestUser(`od2-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", { type: "musician", subtype: "solo", name: "Solo", handle: `od2_${Date.now()}` }, owner.user);
    await adminAuth(admin).deleteUser(owner.uid);
    const gone = await waitForUserDocGone(owner.uid);
    expect(gone.exists).toBe(false);
    const adb = adminFirestore(admin);
    expect((await adb.doc(`profiles/${profileId}/members/${owner.uid}`).get()).exists).toBe(false);
    expect((await adb.doc(`profiles/${profileId}`).get()).exists).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 2:** Run both files: the invite stays `pending` after `deleteAccount`; the `onUserDeleted` cases time out with the users doc still present (no trigger registered).

- [ ] **Step 3:** In `functions/src/account.ts` add the shared-type import `type InviteDoc` to the `@gatekeep/shared` import and replace everything from `const RETRY_SAFE_MESSAGE` through the end of `deleteAccount` with:

```ts
const RETRY_SAFE_MESSAGE = "Account deletion did not complete. It is safe to try again.";

export class CascadePhaseError extends Error {
  readonly phase: string;
  constructor(phase: string) {
    super(`cascadeDeleteUser phase failed: ${phase}`);
    this.phase = phase;
  }
}

async function runPhase(uid: string, phase: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (e) {
    console.error("cascadeDeleteUser phase failed", { uid, phase }, e);
    throw new CascadePhaseError(phase);
  }
}

// (Task 13's assertNothingOutstanding stays above, unchanged.)

// SP10 Task 14 (spec section 5.4, cross #3): everything the account
// callable used to do between its guards and the auth deletion, shared with
// the onUserDeleted trigger so a console or Admin SDK deletion cascades
// identically. Idempotent per phase (re-deleting a deleted doc is a no-op),
// which also makes the trigger's second pass after deleteAccount harmless.
// The sole-admin case is a refusal for the callable and a logged fact for
// the trigger: the auth user is already gone by the time onDelete runs.
export async function cascadeDeleteUser(uid: string, opts: { allowSoleAdmin: boolean }): Promise<void> {
  const db = getFirestore();
  const memberships = await db.collectionGroup("members").where("uid", "==", uid).get();
  const soleAdminOf: string[] = [];
  for (const m of memberships.docs) {
    if (m.data().role !== "admin") continue;
    const profileRef = m.ref.parent.parent!;
    const admins = await profileRef.collection("members").where("role", "==", "admin").get();
    if (admins.size <= 1) {
      const p = await profileRef.get();
      soleAdminOf.push(p.data()?.name ?? profileRef.id);
    }
  }
  if (soleAdminOf.length > 0) {
    if (!opts.allowSoleAdmin) {
      throw new HttpsError("failed-precondition",
        `You are the only admin of: ${soleAdminOf.join(", ")}. Transfer admin or delete those profiles first.`);
    }
    console.error("cascadeDeleteUser: removing the sole admin; these profiles now have no admin", { uid, soleAdminOf });
  }

  // S5: curatorAccess/{uid} first, so a stale marker never outlives the account.
  await runPhase(uid, "curatorAccess", () => Promise.all([
    db.doc(`curatorAccess/${uid}`).delete(),
    db.doc(`curatorAccessRetries/${uid}`).delete(),
  ]));
  await runPhase(uid, "memberships", () => Promise.all(memberships.docs.map((m) => m.ref.delete())));
  // Pending invites naming the uid are revoked (sp1 #10 e). Single-field
  // query plus an in-memory status filter, same shape as helpers.ts's
  // fetchPendingInviteId; bounded by MAX_PENDING_INVITES_PER_PROFILE per profile.
  await runPhase(uid, "invites", async () => {
    const snap = await db.collection("invites").where("invitedUid", "==", uid).get();
    const batch = db.batch();
    let n = 0;
    for (const d of snap.docs) {
      if ((d.data() as InviteDoc).status !== "pending") continue;
      batch.update(d.ref, { status: "revoked" });
      n++;
    }
    if (n > 0) await batch.commit();
  });
  // Offered transfers naming the uid on either side are voided (sp1 #10 f),
  // inventory untouched: the ticket itself never moved for an offer.
  await runPhase(uid, "transfers", async () => {
    const [fromSnap, toSnap] = await Promise.all([
      db.collection("transfers").where("fromUid", "==", uid).get(),
      db.collection("transfers").where("toUid", "==", uid).get(),
    ]);
    const now = Date.now();
    const batch = db.batch();
    let n = 0;
    for (const d of [...fromSnap.docs, ...toSnap.docs]) {
      if ((d.data() as TicketTransferDoc).status !== "offered") continue;
      batch.update(d.ref, { status: "voided", resolvedAt: now });
      n++;
    }
    if (n > 0) await batch.commit();
  });
  await runPhase(uid, "firestore", () => db.recursiveDelete(db.doc(`users/${uid}`)));
}

export const deleteAccount = onCall({ region: "us-central1" }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const db = getFirestore();
  await assertNothingOutstanding(db, uid, Date.now());
  try {
    await cascadeDeleteUser(uid, { allowSoleAdmin: false });
  } catch (e) {
    if (e instanceof HttpsError) throw e; // the sole-admin refusal
    throw new HttpsError("internal", RETRY_SAFE_MESSAGE);
  }
  try {
    await getAuth().deleteUser(uid);
  } catch (e) {
    console.error("deleteAccount phase failed", { uid, phase: "auth" }, e);
    throw new HttpsError("internal", RETRY_SAFE_MESSAGE);
  }
  await writeAudit({ actorUid: uid, action: "account_deleted", targetId: uid, detail: "self-service deleteAccount" });
  return { ok: true };
});
```

Note the audit detail changed from Task 13's `memberships removed: N` to a fixed string, since the membership count now lives inside the cascade; the Task 13 test asserts only `actorUid`.

- [ ] **Step 4:** In `functions/src/authTriggers.ts` add `import { cascadeDeleteUser } from "./account.js";` after line 4 and, after `onUserCreated` (line 21):

```ts
// SP10 Task 14 (cross #3): the console and the Admin SDK are a second
// deletion path; without this only deleteAccount cascaded. Sole-admin is
// logged inside cascadeDeleteUser rather than refused (nothing here can
// refuse: the auth user is already gone). A thrown phase error is rethrown
// so the trigger's own retry policy re-runs the idempotent cascade.
export const onUserDeleted = functionsV1.auth.user().onDelete(async (user) => {
  await cascadeDeleteUser(user.uid, { allowSoleAdmin: true });
});
```

Change `functions/src/index.ts` line 4 to `export { onUserCreated, onUserDeleted, onUserDocWritten } from "./authTriggers.js";`.

- [ ] **Step 5:** Run `account.test.ts` and `authTriggers.test.ts`: all pass. `pnpm typecheck`.

- [ ] **Step 6:** Commit: `feat(functions): cascadeDeleteUser shared by deleteAccount and the new onUserDeleted trigger`

---

### Task 15: Push tokens: unregister on sign-out, newest-first fan-out, dead-token pruning

**Files:**
- Modify: `apps/mobile/src/notifications/push.ts` (whole file)
- Modify: `apps/mobile/src/auth/AuthProvider.tsx` (line 3 import, line 15 signOutUser)
- Modify: `functions/src/notifications.ts` (whole file)
- Modify: `functions/test/notifications.test.ts` (new describe)

Web's `AuthProvider.tsx` is unchanged: the web client never writes a push token (cross #10 evidence
names it only as the sign-out shape), so there is nothing to delete there.

**Interfaces:**
- Produces (push.ts): `export async function unregisterPush(uid: string): Promise<void>`.
- Produces (notifications.ts): `export async function loadPushTokenIds(uid: string): Promise<string[]>` (newest first, at most 20) and `export function deadTokenIdsFromExpoResponse(tokenIds: string[], body: unknown): string[]`.
- Consumes: the Task 2 owner-delete rule; Expo's push send response shape `{ data: Array<{ status: "ok" | "error"; message?: string; details?: { error?: string } }> }`, one ticket per message in request order (today the response is never read: notifications.ts:15-21 awaits `fetch` and discards it).

**Steps:**

- [ ] **Step 1:** Add to `functions/test/notifications.test.ts` (import `loadPushTokenIds, deadTokenIdsFromExpoResponse` from `"../src/notifications.js"`):

```ts
describe("push token selection and pruning (SP10 Task 15)", () => {
  it("loadPushTokenIds returns the 20 newest tokens by createdAt, newest first", async () => {
    const { uid } = await signUpTestUser(`pt1-${Date.now()}@test.com`);
    const batch = adb.batch();
    for (let i = 1; i <= 22; i++) {
      batch.set(adb.doc(`users/${uid}/pushTokens/ExponentPushToken[tok${i}]`), { createdAt: i });
    }
    await batch.commit();
    const ids = await loadPushTokenIds(uid);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe("ExponentPushToken[tok22]");
    expect(ids[19]).toBe("ExponentPushToken[tok3]");
    expect(ids).not.toContain("ExponentPushToken[tok1]");
    expect(ids).not.toContain("ExponentPushToken[tok2]");
  });

  it("deadTokenIdsFromExpoResponse picks only DeviceNotRegistered tickets, aligned by index", () => {
    const tokens = ["ExponentPushToken[a]", "ExponentPushToken[b]", "ExponentPushToken[c]"];
    const body = { data: [
      { status: "ok", id: "x" },
      { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
      { status: "error", message: "big", details: { error: "MessageTooBig" } },
    ] };
    expect(deadTokenIdsFromExpoResponse(tokens, body)).toEqual(["ExponentPushToken[b]"]);
    expect(deadTokenIdsFromExpoResponse(tokens, null)).toEqual([]);
    expect(deadTokenIdsFromExpoResponse(tokens, { data: "nope" })).toEqual([]);
    expect(deadTokenIdsFromExpoResponse(tokens, { errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS" }] })).toEqual([]);
  });
});
```

The end-to-end prune (a real `DeviceNotRegistered` from exp.host) is not reachable from the emulator
without network; the pure parser plus the owner-delete rule test (Task 2) cover the two halves.

- [ ] **Step 2:** Run `notifications.test.ts`: import fails (`loadPushTokenIds` is not exported).

- [ ] **Step 3:** Rewrite `functions/src/notifications.ts`:

```ts
import { getFirestore } from "firebase-admin/firestore";
import type { NotificationDoc } from "@gatekeep/shared";

// Capped so a user with an unbounded number of stale/duplicate push token
// docs can't make a single notification hold this function open forever.
const PUSH_TOKEN_FANOUT_CAP = 20;
const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";

// One Expo push ticket per message, in request order.
interface ExpoPushTicket { status: "ok" | "error"; message?: string; details?: { error?: string } }

// SP10 Task 15 (sp1 #6, rules F9): newest device first, so the cap never
// drops the phone the user is holding in favour of 20 dead installs.
// createdAt is required and typed int by firestore.rules, so every token doc
// participates in the order.
export async function loadPushTokenIds(uid: string): Promise<string[]> {
  const tokens = await getFirestore().collection(`users/${uid}/pushTokens`)
    .orderBy("createdAt", "desc").limit(PUSH_TOKEN_FANOUT_CAP).get();
  return tokens.docs.map((t) => t.id);
}

// Pure: which of the tokens we just posted did Expo mark as unregistered.
// Anything that is not the documented { data: ticket[] } shape yields [] so
// a malformed or error-envelope response never deletes a live token.
export function deadTokenIdsFromExpoResponse(tokenIds: string[], body: unknown): string[] {
  const data = (body as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(data)) return [];
  const dead: string[] = [];
  data.forEach((ticket, i) => {
    const t = ticket as ExpoPushTicket | null | undefined;
    if (t?.status === "error" && t.details?.error === "DeviceNotRegistered" && tokenIds[i]) dead.push(tokenIds[i]);
  });
  return dead;
}

export async function notifyUser(uid: string, note: Omit<NotificationDoc, "read" | "createdAt">): Promise<void> {
  const db = getFirestore();
  const full: NotificationDoc = { ...note, read: false, createdAt: Date.now() };
  await db.collection(`users/${uid}/notifications`).add(full);

  const tokenIds = await loadPushTokenIds(uid);
  if (tokenIds.length === 0) return;
  const messages = tokenIds.map((to) => ({ to, title: note.title, body: note.body }));
  let body: unknown = null;
  try {
    const res = await fetch(EXPO_PUSH_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
      // A hung exp.host endpoint must not hold this function open indefinitely.
      signal: AbortSignal.timeout(5_000),
    });
    body = await res.json();
  } catch (e) {
    console.error("expo push failed", e); // inbox write already succeeded; push is best-effort
    return;
  }
  // Prune tokens Expo says are dead so they stop consuming the fan-out cap
  // and stop reaching a device that has since signed into another account.
  const dead = deadTokenIdsFromExpoResponse(tokenIds, body);
  if (dead.length === 0) return;
  const results = await Promise.allSettled(dead.map((id) => db.doc(`users/${uid}/pushTokens/${id}`).delete()));
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error("push token prune failed", { uid, token: dead[i] }, r.reason);
  });
}

export async function notifyProfileMembers(profileId: string, note: Omit<NotificationDoc, "read" | "createdAt">) {
  const members = await getFirestore().collection(`profiles/${profileId}/members`).get();
  await Promise.all(members.docs.map((m) => notifyUser(m.id, note)));
}
```

- [ ] **Step 4:** Run `notifications.test.ts`: passes (the three pre-existing review-notification cases unchanged).

- [ ] **Step 5:** Mobile. `apps/mobile/src/notifications/push.ts`:

```ts
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { doc, setDoc, deleteDoc } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";

// The token registered by this app session, so sign-out can delete exactly
// the doc it wrote without asking Expo for the token again (which can prompt).
let registeredToken: string | null = null;

export async function registerForPush(uid: string): Promise<void> {
  if (!Device.isDevice) return; // simulators can't receive push
  const { status: existing } = await Notifications.getPermissionsAsync();
  const status = existing === "granted"
    ? existing
    : (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await setDoc(doc(getFirebase().db, `users/${uid}/pushTokens/${token}`), { createdAt: Date.now() });
  registeredToken = token;
}

// SP10 Task 15 (sp1 #6, cross #10): the Expo token identifies the device,
// not the person. Deleting the doc before signOut keeps the next account on
// this phone from receiving the previous one's pushes. Best-effort: a
// failed delete must never block signing out; notifyUser's
// DeviceNotRegistered pruning is the server-side backstop.
export async function unregisterPush(uid: string): Promise<void> {
  const token = registeredToken;
  if (!token) return;
  registeredToken = null;
  try {
    await deleteDoc(doc(getFirebase().db, `users/${uid}/pushTokens/${token}`));
  } catch (e) {
    console.warn("push token cleanup failed", e);
  }
}
```

`apps/mobile/src/auth/AuthProvider.tsx`: add `import { unregisterPush } from "../notifications/push";` after line 3 and replace line 15 with:

```tsx
  const signOutUser = async () => {
    const { auth } = getFirebase();
    const uid = auth.currentUser?.uid;
    if (uid) await unregisterPush(uid); // must run while the token is still valid for the rules' isOwner check
    await signOut(auth);
  };
```

- [ ] **Step 6:** `pnpm --filter @gatekeep/mobile lint` 0 errors; `pnpm --filter @gatekeep/mobile exec expo export --platform ios` bundles. On the next EAS dev build (owner-owed, spec section 11): sign in on a device, confirm the token doc, sign out, confirm the doc is gone.

- [ ] **Step 7:** Commit: `feat(mobile,functions): unregister push token on sign-out; newest-first fan-out with DeviceNotRegistered pruning`

---

### Task 16: Lifecycle leftovers

**Files:**
- Modify: `functions/src/profiles.ts` (createProfileDraft 72-127, submitProfileForReview 131-149, deleteProfile after the unwind at 297)
- Modify: `functions/src/review.ts` (reject branch, before `await batch.commit()` at 175)
- Modify: `functions/src/members.ts` (inviteMember 15-61)
- Modify: `functions/test/profiles.test.ts` (new cases; the cooldown test at 604-611 and the resubmit test at 629 gain a user-doc stamp), `functions/test/members.test.ts` (test at 92-107 seeds its second invite directly; new cases)

**Interfaces:**
- Consumes: `UserDoc.lastProfileRejectedAt` (Task 1, server-only: outside the users update rule's `hasOnly` set), `requireVerifiedEmail`, `isValidDocId`, `InviteDoc`, `MAX_UNSUBMITTED_PROFILES` (profiles.ts:15), `RESUBMIT_COOLDOWN_MS`.
- Produces: no new exports; `inviteMember`'s response stays `{ ok: true }` on every non-error path.

**Steps:**

- [ ] **Step 1:** Tests. In `functions/test/profiles.test.ts`:

(a) The cooldown test (lines 604-611): the cooldown now also reads the user doc, so each admin-SDK backdate touches both. Replace the two `update` lines with:

```ts
    await adb.doc(`profiles/${profileId}`).update({ lastRejectedAt: Date.now() - 60 * 60 * 1000 });
    await adb.doc(`users/${user.uid}`).update({ lastProfileRejectedAt: Date.now() - 60 * 60 * 1000 });
```
and
```ts
    await adb.doc(`profiles/${profileId}`).update({ lastRejectedAt: Date.now() - 25 * 60 * 60 * 1000 });
    await adb.doc(`users/${user.uid}`).update({ lastProfileRejectedAt: Date.now() - 25 * 60 * 60 * 1000 });
```
(`user` there is the `signUpTestUser` result's `.user`; use `const { user, uid } = await signUpTestUser(...)` and `users/${uid}`). Apply the same paired backdate at line 629 in the resubmitCount test.

(b) New cases in the `submitProfileForReview anti-spam` describe:

```ts
  it("reject, delete, recreate: the 24h cooldown follows the uid, not the profile doc", async () => {
    const { user, uid } = await signUpTestUser(`cuid-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "curator", subtype: "venue", name: "Squat Room", handle: `cuid_${Date.now()}` }, user);
    await seedCuratorGateContent(adb, profileId);
    await callFn("submitProfileForReview", { profileId }, user);
    const adminUser = await makeAdminUser("cuidadmin");
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "Impersonation" }, adminUser.user);
    expect(typeof (await adb.doc(`users/${uid}`).get()).data()?.lastProfileRejectedAt).toBe("number");

    await callFn("deleteProfile", { profileId }, user);
    const { profileId: again } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      { type: "curator", subtype: "venue", name: "Squat Room", handle: `cuid2_${Date.now()}` }, user);
    await seedCuratorGateContent(adb, again);
    await expect(callFn("submitProfileForReview", { profileId: again }, user))
      .rejects.toThrow(/24 hours/i);
    await adb.doc(`users/${uid}`).update({ lastProfileRejectedAt: Date.now() - 25 * 60 * 60 * 1000 });
    await callFn("submitProfileForReview", { profileId: again }, user);
    expect((await adb.doc(`profiles/${again}`).get()).data()?.status).toBe("pending_review");
  });

  it("submitProfileForReview requires a verified email and a well-formed profile id", async () => {
    const { user } = await signUpTestUser(`csub-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft",
      curatorDraft(`csub_${Date.now()}`), user);
    const { user: unverified } = await signUpUnverifiedTestUser(`csubu-${Date.now()}@test.com`);
    await expect(callFn("submitProfileForReview", { profileId }, unverified))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    await expect(callFn("submitProfileForReview", { profileId: "a/b" }, user))
      .rejects.toMatchObject({ code: "functions/invalid-argument" });
  });
```

(c) New case in the `createProfileDraft` describe:

```ts
  it("draft cap holds under concurrent creates: three parallel calls at two drafts yield exactly one success", async () => {
    const { user } = await signUpTestUser(`ccon-${Date.now()}@test.com`);
    await callFn("createProfileDraft", draft(`ccon1_${Date.now()}`), user);
    await callFn("createProfileDraft", draft(`ccon2_${Date.now()}`), user);
    const results = await Promise.allSettled([3, 4, 5].map((n) =>
      callFn("createProfileDraft", draft(`ccon${n}_${Date.now()}`), user)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "functions/resource-exhausted" });
    }
  });
```

(d) New case in the `deleteProfile` describe:

```ts
  it("revokes the profile's pending invites", async () => {
    const { user } = await signUpTestUser(`delinv-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", draft(`delinv_${Date.now()}`), user);
    const now = Date.now();
    const ref = adb.collection("invites").doc();
    await ref.set({
      profileId, profileName: "The Midnight Owls", invitedUid: "someone", role: "member", label: "sax",
      invitedByUid: user.uid, status: "pending", createdAt: now,
    });
    await callFn("deleteProfile", { profileId }, user);
    expect((await ref.get()).data()?.status).toBe("revoked");
  });
```

In `functions/test/members.test.ts`, change the test at 92-107 so the second invite is seeded directly (inviteMember now refuses an already-member invitee with the uniform response): replace lines 100-102 with

```ts
    // A second invite to the same (now-member) uid can no longer be minted by
    // inviteMember (SP10 Task 16 refuses it uniformly), so it is seeded
    // directly: the subject here is respondToInvite's own transaction guard.
    const secondRef = adb.collection("invites").doc();
    await secondRef.set({
      profileId, profileName: "Band", invitedUid: invitee.uid, role: "admin", label: "sax2",
      invitedByUid: owner.uid, status: "pending", createdAt: Date.now(),
    } satisfies InviteDoc);
    const second = secondRef.id;
```

and add to the `invites` describe:

```ts
  it("trims and lowercases the invitee email", async () => {
    const { owner, profileId } = await bandWithOwner("inv-case");
    const email = `case-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email: `  ${email.toUpperCase()}  `, role: "member", label: "keys" }, owner.user);
    const inviteId = await fetchPendingInviteId(adb, profileId, invitee.uid);
    expect(inviteId).toBeTruthy();
  });

  it("a duplicate pending invite and an already-member invitee both get the uniform { ok: true } and create nothing", async () => {
    const { owner, profileId } = await bandWithOwner("inv-dup");
    const email = `dup-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    await callFn("inviteMember", { profileId, email, role: "member", label: "bass" }, owner.user);
    const dup = await callFn<Record<string, unknown>, { ok: boolean }>(
      "inviteMember", { profileId, email, role: "member", label: "bass again" }, owner.user);
    expect(dup.ok).toBe(true);
    const pending = await adb.collection("invites").where("invitedUid", "==", invitee.uid).get();
    expect(pending.docs.filter((d) => d.data().profileId === profileId && d.data().status === "pending")).toHaveLength(1);

    const inviteId = await fetchPendingInviteId(adb, profileId, invitee.uid);
    await callFn("respondToInvite", { inviteId, accept: true }, invitee.user);
    const again = await callFn<Record<string, unknown>, { ok: boolean }>(
      "inviteMember", { profileId, email, role: "admin", label: "bass" }, owner.user);
    expect(again.ok).toBe(true);
    const after = await adb.collection("invites").where("invitedUid", "==", invitee.uid).get();
    expect(after.docs.filter((d) => d.data().profileId === profileId && d.data().status === "pending")).toHaveLength(0);
  });
```

- [ ] **Step 2:** Run `profiles.test.ts` and `members.test.ts`. Expected: the uid-cooldown case resubmits successfully (no user-doc stamp); the unverified submit succeeds; the malformed id surfaces as `functions/internal`; the concurrent-creates case yields more than one success; the invites stay pending after deleteProfile; the duplicate-invite case finds 2 pending; the uppercase email case throws inside `fetchPendingInviteId` (no invite was created because `getUserByEmail` got the untrimmed string).

- [ ] **Step 3:** `functions/src/profiles.ts`.

(a) `createProfileDraft`: delete lines 74-91 (the pre-transaction cap scan) and replace the transaction (96-127) with:

```ts
  await db.runTransaction(async (tx) => {
    // Cap unsubmitted (draft/rejected) profiles per admin to prevent unlimited
    // handle squatting via never-submitted drafts. SP10 Task 16 (sp1 #19):
    // counted INSIDE the transaction, so two concurrent creates cannot both
    // read "2 drafts" and both commit a third and fourth. All reads precede
    // the writes below, as Firestore transactions require.
    const myMemberships = await tx.get(db.collectionGroup("members").where("uid", "==", uid));
    let unsubmittedCount = 0;
    for (const m of myMemberships.docs) {
      if (m.data().role !== "admin") continue;
      const memberProfileRef = m.ref.parent.parent;
      if (!memberProfileRef) continue;
      const p = await tx.get(memberProfileRef);
      if (UNSUBMITTED_STATUSES.has(p.data()?.status)) unsubmittedCount++;
    }
    if (unsubmittedCount >= MAX_UNSUBMITTED_PROFILES) {
      throw new HttpsError("resource-exhausted",
        "Too many unsubmitted profiles. Finish or delete an existing draft first.");
    }
    if ((await tx.get(handleRef)).exists) {
      throw new HttpsError("already-exists", "That handle is taken.");
    }
    const now = Date.now();
    const profile: ProfileDoc = {
      type: input.type, subtype: input.subtype as ProfileDoc["subtype"],
      name: input.name.trim(), handle: input.handle,
      status: "draft", rejectionReason: null, createdAt: now, updatedAt: now,
      publicBooking: null,
      ...(input.type === "musician"
        ? { portfolio: { bio: "", genres: [], externalLinks: [], avatarPhotoPath: null, coverPhotoPath: null } }
        : input.type === "curator"
        ? { curator: {
            about: "",
            lookingFor: { genres: [], actSizes: [], notes: null },
            amenities: { capacity: null, hasPA: null, hasBackline: null, indoorOutdoor: null, notes: null },
            advertisingInterest: false,
            location: { address: null, city: "", neighborhood: null, geo: null },
            photoPaths: [],
          } as CuratorDetails }
        : {}),
    };
    const member: MemberDoc = { uid, role: "admin", label: "owner", joinedAt: now };
    tx.set(profileRef, profile);
    tx.set(handleRef, { profileId: profileRef.id });
    tx.set(profileRef.collection("members").doc(uid), member);
  });
```

(the `publicBooking` comment block at 105-108 is kept verbatim above that field; elided here for length only).

(b) `submitProfileForReview` (131-149): replace the opening and the cooldown with:

```ts
export const submitProfileForReview = onCall<{ profileId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  // SP10 Task 16 (sp1 #13): file-wide ordering, requireAuthUid ->
  // requireVerifiedEmail -> input validation -> authz.
  requireVerifiedEmail(req);
  const { profileId } = req.data;
  if (!isValidDocId(profileId)) {
    throw new HttpsError("invalid-argument", "A profile id is required.");
  }
  await requireProfileAdmin(profileId, uid);
  const ref = getFirestore().doc(`profiles/${profileId}`);
  const snap = await ref.get();
  const data = snap.data();
  const status = data?.status;
  if (status !== "draft" && status !== "rejected") {
    throw new HttpsError("failed-precondition", `Cannot submit a profile in status "${status}".`);
  }

  // Anti-spam: resubmitting too soon after a rejection is blocked regardless
  // of profile type. reviewProfile stamps lastRejectedAt on the profile AND
  // lastProfileRejectedAt on every admin's user doc (SP10 Task 16, sp1 #7):
  // the profile field can be destroyed by deleteProfile, the user field
  // cannot, so delete-and-recreate no longer resets the clock. The later of
  // the two governs.
  const userSnap = await getFirestore().doc(`users/${uid}`).get();
  const lastRejectedAt = Math.max(
    (data?.lastRejectedAt as number | undefined) ?? 0,
    ((userSnap.data() as UserDoc | undefined)?.lastProfileRejectedAt) ?? 0,
  );
  if (lastRejectedAt > 0 && Date.now() - lastRejectedAt < RESUBMIT_COOLDOWN_MS) {
    throw new HttpsError("failed-precondition", "You can resubmit 24 hours after a rejection.");
  }
```

(add `type UserDoc` to the `@gatekeep/shared` import).

(c) `deleteProfile`: after `await unwindBookingsForModeration({ profileId });` (line 297) insert:

```ts
  // SP10 Task 16 (sp1 #15): pending invites to this profile are revoked
  // now, not left for the 14-day sweep. Served by the (profileId, status)
  // composite; bounded by MAX_PENDING_INVITES_PER_PROFILE.
  const pendingInvites = await db.collection("invites")
    .where("profileId", "==", profileId).where("status", "==", "pending").get();
  if (!pendingInvites.empty) {
    const inviteBatch = db.batch();
    for (const inviteDoc of pendingInvites.docs) inviteBatch.update(inviteDoc.ref, { status: "revoked" });
    await inviteBatch.commit();
  }
```

- [ ] **Step 4:** `functions/src/review.ts`: before `await batch.commit();` (line 175) insert:

```ts
    // SP10 Task 16 (sp1 #7): the resubmit cooldown also lives on each admin's
    // user doc, which deleteProfile cannot destroy. Merge-set: the user doc
    // always exists (onUserCreated), and this field is outside the client's
    // updatable key set, so it is server-only by construction.
    if (decision === "rejected") {
      const adminsSnap = await db.collection(`profiles/${profileId}/members`).where("role", "==", "admin").get();
      for (const m of adminsSnap.docs) {
        batch.set(db.doc(`users/${m.id}`), { lastProfileRejectedAt: now }, { merge: true });
      }
    }
```

- [ ] **Step 5:** `functions/src/members.ts` inviteMember (15-61): replace lines 19-21 and 49-54 so the body reads:

```ts
    const { profileId, email, role, label } = req.data;
    if (!isValidDocId(profileId)) throw new HttpsError("invalid-argument", "A profile id is required.");
    if (typeof email !== "string" || email.trim().length === 0) {
      throw new HttpsError("invalid-argument", "A valid email is required.");
    }
    // SP10 Task 16 (sp1 #16): a leading space from a mobile keyboard used to
    // make getUserByEmail miss and the anti-enumeration branch report
    // success for an invite that never existed.
    const normalizedEmail = email.trim().toLowerCase();
    if (role !== "admin" && role !== "member") {
      throw new HttpsError("invalid-argument", "Role must be \"admin\" or \"member\".");
    }
    if (typeof label !== "string") {
      throw new HttpsError("invalid-argument", "Label must be a string.");
    }
    const trimmedLabel = label.trim().slice(0, 60);
    await requireProfileAdmin(profileId, uid);
    const db = getFirestore();
    const pending = await db.collection("invites")
      .where("profileId", "==", profileId).where("status", "==", "pending").get();
    if (pending.size >= MAX_PENDING_INVITES_PER_PROFILE) {
      throw new HttpsError("resource-exhausted", "Too many pending invites for this profile.");
    }
    let invited;
    try { invited = await getAuth().getUserByEmail(normalizedEmail); }
    catch { return { ok: true as const }; }
    if (invited.uid === uid) {
      throw new HttpsError("failed-precondition", "You're already on this profile.");
    }
    // Uniform { ok: true } (never an error) for an invitee who is already a
    // member or already has a pending invite here: an error would reveal
    // that the email resolves, the same oracle the catch above closes. The
    // pending snapshot already fetched for the cap check answers the second
    // question without another query.
    const existingMember = await db.doc(`profiles/${profileId}/members/${invited.uid}`).get();
    if (existingMember.exists) return { ok: true as const };
    if (pending.docs.some((d) => (d.data() as InviteDoc).invitedUid === invited.uid)) {
      return { ok: true as const };
    }
    const profile = await db.doc(`profiles/${profileId}`).get();
    const invite: InviteDoc = {
      profileId, profileName: profile.data()?.name ?? "", invitedUid: invited.uid,
      role, label: trimmedLabel, invitedByUid: uid, status: "pending", createdAt: Date.now(),
    };
    await db.collection("invites").add(invite);
    return { ok: true as const };
```

(The cap-ordering comment at lines 31-38 and the anti-enumeration comment at 44-48 stay in place above their statements.)

- [ ] **Step 6:** Run `profiles.test.ts`, `members.test.ts`, `review.test.ts` (the reject path now also writes user docs; its assertions are unaffected): all pass. `pnpm typecheck`.

- [ ] **Step 7:** Full gates for the section: `pnpm emu:test` count strictly above 704, `pnpm emu:rules` above 103, `pnpm typecheck` 5/5, both lints, web build. Commit: `fix(functions): invite revoke on deleteProfile, submit guards, transactional draft cap, uid-scoped resubmit cooldown, invite normalization`

---

### Task 17: Geocoder fails closed outside the emulator, city-less results return null, 10 s fetch timeout

**Files:**
- Modify: `functions/src/geocode.ts` (`GoogleGeocoder` 65-83, `parseGoogleResponse` city fallback 157-159, `getGeocoder` 169-189)
- Modify: `functions/test/geocode.test.ts` (`getGeocoder` describe 116-147; add a `GoogleGeocoder` describe and one `parseGoogleResponse` case)

**Interfaces:**
- Consumes: `HttpsError` (already imported at `geocode.ts:9`), `geocoderApiKey` (line 20), `process.env.FUNCTIONS_EMULATOR` (set to `"true"` by the Functions emulator runtime, never by the vitest process).
- Produces: `export const GOOGLE_GEOCODE_TIMEOUT_MS = 10_000;` and `GoogleGeocoder`'s constructor gains an optional second argument `timeoutMs = GOOGLE_GEOCODE_TIMEOUT_MS` (tests inject a short one). `getGeocoder()` throws `HttpsError("failed-precondition", "Geocoder is not configured.")` when `process.env.FUNCTIONS_EMULATOR !== "true"` and `GEOCODER_PROVIDER !== "google"`. `parseGoogleResponse` returns `null` instead of throwing when no `locality` or `administrative_area_level_1` component exists.

- [ ] **Step 1: Replace the `getGeocoder` describe and add the two new describes in `functions/test/geocode.test.ts`**

Replace lines 116-147 with:

```ts
describe("getGeocoder", () => {
  it("returns StubGeocoder inside the emulator when GEOCODER_PROVIDER is unset", () => {
    vi.stubEnv("FUNCTIONS_EMULATOR", "true");
    vi.stubEnv("GEOCODER_PROVIDER", undefined);
    try {
      expect(getGeocoder()).toBeInstanceOf(StubGeocoder);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed outside the emulator when GEOCODER_PROVIDER is unset", () => {
    vi.stubEnv("FUNCTIONS_EMULATOR", undefined);
    vi.stubEnv("GEOCODER_PROVIDER", undefined);
    try {
      expect(() => getGeocoder()).toThrow("Geocoder is not configured.");
      let code: string | undefined;
      try { getGeocoder(); } catch (e) { code = (e as HttpsError).code; }
      expect(code).toBe("failed-precondition");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed outside the emulator when GEOCODER_PROVIDER names anything other than google", () => {
    vi.stubEnv("FUNCTIONS_EMULATOR", "false");
    vi.stubEnv("GEOCODER_PROVIDER", "stub");
    try {
      expect(() => getGeocoder()).toThrow("Geocoder is not configured.");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns GoogleGeocoder when GEOCODER_PROVIDER=google, in or out of the emulator", () => {
    vi.stubEnv("FUNCTIONS_EMULATOR", undefined);
    vi.stubEnv("GEOCODER_PROVIDER", "google");
    vi.stubEnv("GEOCODER_API_KEY", "test-key");
    try {
      expect(getGeocoder()).toBeInstanceOf(GoogleGeocoder);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("throws when GEOCODER_PROVIDER=google without GEOCODER_API_KEY", () => {
    vi.stubEnv("GEOCODER_PROVIDER", "google");
    vi.stubEnv("GEOCODER_API_KEY", undefined);
    try {
      expect(() => getGeocoder()).toThrow("GEOCODER_PROVIDER=google requires GEOCODER_API_KEY");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("GoogleGeocoder", () => {
  const okBody = {
    status: "OK",
    results: [{
      geometry: { location: { lat: 30.2672, lng: -97.7431 } },
      address_components: [
        { long_name: "Downtown", types: ["neighborhood"] },
        { long_name: "Austin", types: ["locality"] },
      ],
    }],
  };

  it("passes a timeout AbortSignal to fetch and parses the body", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify(okBody), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await new GoogleGeocoder("test-key").geocode("1 Main St, Austin, TX");
      expect(result?.city).toBe("Austin");
      expect(result?.neighborhood).toBe("Downtown");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("turns a hung upstream into a timeout Error after timeoutMs", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(new GoogleGeocoder("test-key", 20).geocode("1 Main St, Austin, TX"))
        .rejects.toThrow("Google Geocoding API timed out after 20ms");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("exposes the production timeout as 10 seconds", () => {
    expect(GOOGLE_GEOCODE_TIMEOUT_MS).toBe(10_000);
  });
});
```

Add to the `parseGoogleResponse` describe (after the existing "returns null neighborhood" case):

```ts
  it("returns null (not a throw) when no locality or administrative_area_level_1 is present, e.g. a plus code", () => {
    const response = {
      status: "OK",
      results: [{
        geometry: { location: { lat: 30.2672, lng: -97.7431 } },
        address_components: [{ long_name: "8FW4V75V+8Q", types: ["plus_code"] }],
      }],
    };
    expect(parseGoogleResponse(response)).toBeNull();
  });
```

Extend the import block at the top of the file:

```ts
import { HttpsError } from "firebase-functions/v2/https";
import {
  StubGeocoder,
  GoogleGeocoder,
  getGeocoder,
  coarsen,
  parseGoogleResponse,
  GOOGLE_GEOCODE_TIMEOUT_MS,
  type GeocodeResult,
} from "../src/geocode.js";
```

- [ ] **Step 2: Run `pnpm --filter functions exec vitest run test/geocode.test.ts`**

Expected: the file fails to compile on the missing `GOOGLE_GEOCODE_TIMEOUT_MS` export. Temporarily comment that import and the "exposes the production timeout" case to see the behavioral failures: "fails closed outside the emulator when GEOCODER_PROVIDER is unset" fails (returns a `StubGeocoder`, no throw), "fails closed ... anything other than google" fails the same way, "turns a hung upstream into a timeout Error" hangs then fails (no signal is passed, the promise never settles; vitest's 5 s timeout ends it), and the plus-code case fails with `parseGoogleResponse: could not extract city from address_components`.

- [ ] **Step 3: Implement in `functions/src/geocode.ts`**

Replace the `GoogleGeocoder` class (lines 65-83) with:

```ts
// SP10 Task 17: a hung upstream must not hold a callable open to its own 60 s
// limit. AbortSignal.timeout is native on Node 22 (branch A's runtime).
export const GOOGLE_GEOCODE_TIMEOUT_MS = 10_000;

/**
 * Google Geocoding API adapter.
 * Requires GEOCODER_API_KEY (Secret Manager in production, env locally).
 */
export class GoogleGeocoder implements Geocoder {
  private apiKey: string;
  private timeoutMs: number;

  constructor(apiKey: string, timeoutMs: number = GOOGLE_GEOCODE_TIMEOUT_MS) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async geocode(address: string): Promise<GeocodeResult | null> {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("key", this.apiKey);

    let response: Response;
    try {
      response = await fetch(url.toString(), { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error(`Google Geocoding API timed out after ${this.timeoutMs}ms`);
      }
      throw e;
    }
    if (!response.ok) {
      throw new Error(`Google Geocoding API returned ${response.status}: ${response.statusText}`);
    }

    const json = await response.json() as unknown;
    return parseGoogleResponse(json);
  }
}
```

Replace lines 157-159 (the `if (!city)` throw at the end of `parseGoogleResponse`) with:

```ts
  // SP10 Task 17 (sp3 #3): plus codes, rural and some non-US results carry
  // neither a locality nor a level-1 area. Every caller already handles null
  // as "could not locate" (GEOCODE_FAILURE_MESSAGE); a throw here surfaced as
  // an opaque internal error instead.
  if (!city) {
    return null;
  }
```

Replace `getGeocoder` (lines 169-189) with:

```ts
/**
 * Returns a Geocoder instance based on environment configuration.
 * GEOCODER_PROVIDER=google + GEOCODER_API_KEY selects GoogleGeocoder.
 * Anything else selects the deterministic stub, but ONLY inside the
 * Functions emulator (SP10 Task 17, sp3 #2): a production deploy that
 * forgets the provider must fail loudly rather than write hash-derived
 * coordinates onto world-readable profile and gig docs.
 */
export function getGeocoder(): Geocoder {
  if (process.env.GEOCODER_PROVIDER === "google") {
    const apiKey = geocoderApiKey.value() || process.env.GEOCODER_API_KEY;
    if (!apiKey) {
      throw new Error("GEOCODER_PROVIDER=google requires GEOCODER_API_KEY");
    }
    return new GoogleGeocoder(apiKey);
  }
  if (process.env.FUNCTIONS_EMULATOR !== "true") {
    throw new HttpsError("failed-precondition", "Geocoder is not configured.");
  }
  return new StubGeocoder();
}

// Logged once per cold start so a misconfigured deploy is visible in Cloud
// Logging before the first geocode call fails.
console.info(
  `geocode: provider=${process.env.GEOCODER_PROVIDER === "google" ? "google" : "stub"} emulator=${process.env.FUNCTIONS_EMULATOR === "true"}`);
```

Keep the existing explanatory comment about `geocoderApiKey.value()` and the env fallback above the `apiKey` line (it is unchanged in meaning); rewrite it without the em dashes if the sweep left any.

- [ ] **Step 4: Run `pnpm --filter functions exec vitest run test/geocode.test.ts`**

Expected: all cases pass, including the untouched `StubGeocoder`, `coarsen`, and existing `parseGoogleResponse` cases.

- [ ] **Step 5: Commit**

```
fix(functions): geocoder fails closed outside the emulator, null on city-less results, 10s fetch timeout
```

---

### Task 18: `recomputeReliability` seeds a full projection; missing-source rebuild keeps reliability

**Files:**
- Modify: `packages/shared/src/types.ts` (`CuratorBookingDoc` 425-428)
- Modify: `functions/src/bookingVisibility.ts` (imports 3-7, add `EMPTY_BOOKING_RATES` beside `DEFAULT_BOOKING_VISIBILITY` 15-17, missing-source branch 59-66)
- Modify: `functions/src/bookingLifecycle.ts` (shared import 3-8, `recomputeReliability` 115-131)
- Modify: `apps/web/src/bookings/MusicianBrowse.tsx` (line 73-74, the only client read of `preferences` that the type change breaks; B4 owns the fuller UI guard set)
- Modify: `functions/test/scheduled.test.ts` (imports 4-7, step 7 describe at 676)
- Modify: `functions/test/bookingVisibility.test.ts` (imports 1-6, new describe at the end)

**Interfaces:**
- Consumes: `ReliabilityDoc`, `CuratorBookingDoc`, `BookingRates` from `@gatekeep/shared`; `runDailySweep` step 7 (`scheduled.ts:717` onward) which calls `recomputeReliability` after a completion.
- Produces:
  - `CuratorBookingDoc.preferences: BookingPreferences | null` (null when the projection was seeded by a reliability event before any booking info was saved).
  - `export const EMPTY_BOOKING_RATES: BookingRates = { perHour: null, perSong: null, perSet: null };` in `bookingVisibility.ts`.
  - `recomputeReliability(musicianProfileId)` creates `{ rates: EMPTY_BOOKING_RATES, preferences: null, reliability, updatedAt }` when the projection does not exist, and merge-writes `reliability` + `updatedAt` when it does.
  - `rebuildBookingProjections(profileId)` with no `private/booking` doc merge-sets the same seeded shape (reliability recomputed from `private/reliability`) instead of deleting the doc.

- [ ] **Step 1: Add the completion-without-booking-info test to `functions/test/scheduled.test.ts`**

Extend the shared import (lines 4-7) with `type CuratorBookingDoc`. Add inside the step 7 describe (`runDailySweep ... booking completion sweep (step 7)`, line 676), after its first case:

```ts
  it("SP10 Task 18: completing a booking for a musician with NO private/booking doc seeds a full-shape projection (null rates, null preferences, live reliability)", async () => {
    const now = Date.now();
    const curatorProfileId = fakeProfileId();
    const musicianProfileId = fakeProfileId();
    const { bookingId } = await seedBooking({
      gigId: "pending", seriesId: null, curatorProfileId, musicianProfileId, status: "confirmed",
    });
    const gigId = await seedOccurrence("not-a-real-series", curatorProfileId, {
      status: "filled", startsAt: now - 2 * 3600_000, durationMinutes: 60,
      bookingId, bookedMusicianProfileId: musicianProfileId,
    });
    await adb.doc(`bookings/${bookingId}`).update({ gigId });
    expect((await adb.doc(`profiles/${musicianProfileId}/private/booking`).get()).exists).toBe(false);

    await runDailySweep(now);

    const projection = (await adb.doc(`profiles/${musicianProfileId}/private/curatorBooking`).get()).data() as CuratorBookingDoc;
    expect(projection.rates).toEqual({ perHour: null, perSong: null, perSet: null });
    expect(projection.preferences).toBeNull();
    expect(projection.reliability).toEqual({ noShowCount: 0, completedCount: 1 });
    expect(typeof projection.updatedAt).toBe("number");
  });
```

- [ ] **Step 2: Add the missing-source rebuild test to `functions/test/bookingVisibility.test.ts`**

Extend the imports:

```ts
import { rebuildBookingProjections } from "../src/bookingVisibility.js";
import { recomputeReliability } from "../src/bookingLifecycle.js";
import type { ProfileDraftInput, BookingVisibility, RateVisibility, CuratorBookingDoc } from "@gatekeep/shared";
```

Append at the end of the file:

```ts
describe("rebuildBookingProjections with no source doc (SP10 Task 18)", () => {
  it("seeds a full-shape projection and keeps the reliability summary instead of deleting the doc", async () => {
    const { profileId } = await makeMusicianProfile("rbpnosrc");
    await adb.doc(`profiles/${profileId}/private/reliability`).set({
      marks: [{ bookingId: "b1", gigId: "g1", kind: "late_cancel", at: Date.now(), reportedByProfileId: null, removedByAdmin: false }],
      completedCount: 2, updatedAt: Date.now(),
    });
    await recomputeReliability(profileId); // the projection a sweep completion or a mark would have created
    const seeded = (await adb.doc(`profiles/${profileId}/private/curatorBooking`).get()).data() as CuratorBookingDoc;
    expect(seeded.rates).toEqual({ perHour: null, perSong: null, perSet: null });
    expect(seeded.preferences).toBeNull();

    await rebuildBookingProjections(profileId); // still no private/booking doc

    const projection = (await adb.doc(`profiles/${profileId}/private/curatorBooking`).get()).data() as CuratorBookingDoc;
    expect(projection.rates).toEqual({ perHour: null, perSong: null, perSet: null });
    expect(projection.preferences).toBeNull();
    expect(projection.reliability).toEqual({ noShowCount: 1, completedCount: 2 });
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.publicBooking).toBeNull();
  });
});
```

- [ ] **Step 3: Run `test/scheduled.test.ts` and `test/bookingVisibility.test.ts` (emulator command from the preamble)**

Expected: the step 7 case fails at `expect(projection.rates).toEqual(...)` (received `undefined`: today's projection is `{ reliability, updatedAt }` only). The rebuild case fails at `seeded.rates` first (same cause); once seeding lands it would fail at `projection.rates` with a `TypeError` because `rebuildBookingProjections` deleted the doc.

- [ ] **Step 4: Change the shared type**

In `packages/shared/src/types.ts` lines 425-428 replace the `preferences` line:

```ts
export interface CuratorBookingDoc {                     // profiles/{id}/private/curatorBooking
  rates: BookingRates;                                   // structures marked "private" are null here even if set in the source
  // null when the projection was seeded by a reliability event (a completion
  // or a mark) before the musician ever saved booking info (SP10 Task 18).
  preferences: BookingPreferences | null;
  reliability: ReliabilitySummary; updatedAt: number;
}
```

Run `pnpm --filter @gatekeep/shared build`.

- [ ] **Step 5: Implement in `functions/src/bookingVisibility.ts`**

Extend the shared import (lines 3-6) with `type ReliabilityDoc` if not already there (it is: keep) and nothing else. Add after `DEFAULT_BOOKING_VISIBILITY` (line 17):

```ts
// SP10 Task 18: the rates block of a projection that exists only because a
// reliability event (sweep completion, late-cancel mark) needed somewhere to
// live. Every client renders these as "No public rates." (sp4 #1).
export const EMPTY_BOOKING_RATES: BookingRates = { perHour: null, perSong: null, perSet: null };
```

Replace the missing-source branch (lines 59-66, starting `if (!bookingSnap.exists) {`) with:

```ts
    if (!bookingSnap.exists) {
      // No source doc (never set, or deleted out from under a stale caller).
      // SP10 Task 18 (sp4 #20): merge-set a seeded projection rather than
      // deleting the doc, so a reliability summary recomputeReliability has
      // already written for a musician with no booking info survives.
      const rel = relSnap.data() as ReliabilityDoc | undefined;
      const relMarks = rel?.marks ?? [];
      const seeded: CuratorBookingDoc = {
        rates: EMPTY_BOOKING_RATES, preferences: null,
        reliability: {
          noShowCount: relMarks.filter((m) => !m.removedByAdmin).length,
          completedCount: rel?.completedCount ?? 0,
        },
        updatedAt: Date.now(),
      };
      batch.set(curatorBookingRef, seeded, { merge: true });
      batch.set(profileRef, { publicBooking: null }, { merge: true });
      await batch.commit();
      return;
    }
```

- [ ] **Step 6: Implement in `functions/src/bookingLifecycle.ts`**

Add `type CuratorBookingDoc` to the shared type import (lines 3-8) and add:

```ts
import { EMPTY_BOOKING_RATES } from "./bookingVisibility.js";
```

Replace `recomputeReliability` (lines 115-131) with:

```ts
export async function recomputeReliability(musicianProfileId: string): Promise<void> {
  const db = getFirestore();
  const reliabilityRef = db.doc(`profiles/${musicianProfileId}/private/reliability`);
  const curatorBookingRef = db.doc(`profiles/${musicianProfileId}/private/curatorBooking`);
  await db.runTransaction(async (tx) => {
    const [reliabilitySnap, projectionSnap] = await Promise.all([tx.get(reliabilityRef), tx.get(curatorBookingRef)]);
    const reliability = reliabilitySnap.data() as ReliabilityDoc | undefined;
    const marks = reliability?.marks ?? [];
    const summary = {
      noShowCount: marks.filter((m) => !m.removedByAdmin).length,
      completedCount: reliability?.completedCount ?? 0,
    };
    if (projectionSnap.exists) {
      // Existing projection: touch ONLY reliability + updatedAt, never the
      // rates/preferences rebuildBookingProjections owns.
      tx.set(curatorBookingRef, { reliability: summary, updatedAt: Date.now() }, { merge: true });
      return;
    }
    // SP10 Task 18 (sp4 #1): no booking info was ever saved for this profile.
    // Seed the full doc shape so browse grids never meet a summary-only doc.
    const seeded: CuratorBookingDoc = {
      rates: EMPTY_BOOKING_RATES, preferences: null, reliability: summary, updatedAt: Date.now(),
    };
    tx.set(curatorBookingRef, seeded);
  });
}
```

Keep the function's existing doc comment; update its last sentence to say it seeds rates/preferences when the doc is absent.

- [ ] **Step 7: Guard the one client read the type change breaks**

`apps/web/src/bookings/MusicianBrowse.tsx` lines 73-74:

```tsx
  const availabilityLabel = booking && booking !== "loading" && booking.preferences?.availabilityPattern
    ? formatChipLabel(booking.preferences.availabilityPattern)
    : null;
```

(B4 Task 25 adds the `rates ?? nullRates` guard on mobile and any further preference reads; this line alone keeps `pnpm typecheck` green at this commit.)

- [ ] **Step 8: Run `pnpm typecheck`, then `test/scheduled.test.ts` and `test/bookingVisibility.test.ts`**

Expected: typecheck 5/5; both new cases pass; the existing bookingVisibility cases still pass (their projections are built from a real source doc and are unaffected).

- [ ] **Step 9: Commit**

```
fix(functions): seed the curatorBooking projection with null rates and preferences instead of a summary-only doc
```

---

### Task 19: Poster persistence: `posterUploads` doc from `processPhoto`, reaped by the daily sweep

**Files:**
- Modify: `functions/src/media.ts` (shared import 12-14, `PHOTO_FILENAME_RE` 225, kind extraction 239, poster branch 360-368)
- Modify: `functions/src/scheduled.ts` (shared import 3-7, `SweepReport` 225-306, report init 310-320, new step after the track reaper 586-611)
- Modify: `functions/test/media.test.ts` (poster describe 456-490)
- Modify: `functions/test/scheduled.test.ts` (new describe after the track reaper describe, 355-372)

**Interfaces:**
- Consumes: `PosterUploadDoc { path: string; createdAt: number }` and `POSTER_UPLOAD_TTL_MS` from `@gatekeep/shared` (Task 1); `publicPhotoPath` (`storagePaths.ts:18`); `createChunkedWriter` (`scheduled.ts:150`).
- Produces:
  - Document path `posterUploads/{uid}/uploads/{nonce}` (INVENTED HERE: the shared block writes `posterUploads/{uid}/uploads/{nonce}`, which has three segments and cannot be a Firestore document; `uploads` is the fixed subcollection segment. B2's rules block and B4's client watcher must use this exact path). `{nonce}` is the client's nonce from the staging filename `poster-{nonce}`.
  - `SweepReport.posterUploadsReaped: number` and `SweepReport.errors.posterUploads: number`.

- [ ] **Step 1: Extend the poster upload test in `functions/test/media.test.ts`**

Replace the first case of the `processUpload: curator poster photos` describe (lines 462-476) with:

```ts
  it("processes a poster into public/photos, writes posterUploads/{uid}/uploads/{nonce}, and touches no profile field", async () => {
    const { user, uid, profileId } = await makeCurator("p1");
    const nonce = `${Date.now()}`;
    const path = `staging/photos/${uid}/${profileId}/poster-${nonce}`;
    await uploadTestAudio(path, tinyJpeg(), "image/jpeg", user);
    const deadline = Date.now() + 30_000;
    let files: { name: string }[] = [];
    while (Date.now() < deadline && files.length === 0) {
      [files] = await abucket.getFiles({ prefix: `public/photos/${profileId}/poster-` });
      if (files.length === 0) await new Promise((r) => setTimeout(r, 500));
    }
    expect(files).toHaveLength(1);

    // SP10 Task 19: the processed path is handed to the client through a
    // doc it can watch (rules: owner read only).
    const uploadRef = adb.doc(`posterUploads/${uid}/uploads/${nonce}`);
    let uploadDoc = (await uploadRef.get()).data();
    while (Date.now() < deadline && !uploadDoc) {
      await new Promise((r) => setTimeout(r, 500));
      uploadDoc = (await uploadRef.get()).data();
    }
    expect(uploadDoc?.path).toBe(files[0].name);
    expect(uploadDoc?.createdAt).toBeTypeOf("number");

    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.curator?.photoPaths ?? []).toHaveLength(0);
    expect(p.data()?.portfolio?.avatarPhotoPath ?? null).toBeNull();
  });
```

- [ ] **Step 2: Add the reaper test to `functions/test/scheduled.test.ts`**

Extend the shared import (lines 4-7) with `POSTER_UPLOAD_TTL_MS`. Add after the track reaper describe (ends line 372):

```ts
describe("runDailySweep, poster upload reaper (SP10 Task 19)", () => {
  it("deletes a posterUploads doc older than POSTER_UPLOAD_TTL_MS and leaves a fresh one", async () => {
    const now = Date.now();
    const uid = fakeUid();
    await adb.doc(`posterUploads/${uid}/uploads/stale`).set({
      path: "public/photos/seed/poster-stale.jpg", createdAt: now - POSTER_UPLOAD_TTL_MS - 60_000,
    });
    await adb.doc(`posterUploads/${uid}/uploads/fresh`).set({
      path: "public/photos/seed/poster-fresh.jpg", createdAt: now - 60_000,
    });

    const report = await runDailySweep(now);

    expect(report.posterUploadsReaped).toBeGreaterThanOrEqual(1);
    expect((await adb.doc(`posterUploads/${uid}/uploads/stale`).get()).exists).toBe(false);
    expect((await adb.doc(`posterUploads/${uid}/uploads/fresh`).get()).exists).toBe(true);
  });
});
```

(`fakeUid` is defined at line 123 of this file, below the fixtures block; the describe is placed after it in file order, which vitest requires only at call time, so this works.)

- [ ] **Step 3: Run `test/media.test.ts` and `test/scheduled.test.ts`**

Expected: the poster case times out at the `uploadDoc` poll (30 s) and fails on `expect(uploadDoc?.path).toBe(...)` with `undefined`. The reaper case fails to compile on `report.posterUploadsReaped` (not on `SweepReport`); if run with the assertion cast away, the stale doc still exists.

- [ ] **Step 4: Implement in `functions/src/media.ts`**

Extend the shared import (lines 12-14):

```ts
import {
  reviewTrackPath, publicPhotoPath, isValidDocId, MAX_CLIP_SECONDS, MAX_CURATOR_PHOTOS,
  type PosterUploadDoc,
} from "@gatekeep/shared";
```

Line 225, capture the nonce:

```ts
const PHOTO_FILENAME_RE = /^(avatar|cover|gallery|poster)-([A-Za-z0-9-]{1,80})$/;
```

Line 239, after `const kind = nameMatch[1] as ...;` add:

```ts
  const nonce = nameMatch[2];
```

Replace the poster branch (lines 360-368) with:

```ts
    if (kind === "poster") {
      // SP10 Task 19 (sp6 #16): the profile doc has no poster field, so the
      // processed path is published to a per-owner doc the uploading client
      // watches (posterUploads/{uid}/uploads/{nonce}, owner read only). The
      // client then saves it as posterPath through createEvent/updateEvent,
      // which re-check the public/photos/{profileId}/poster- prefix. The
      // daily sweep deletes these docs after POSTER_UPLOAD_TTL_MS.
      const uploadDoc: PosterUploadDoc = { path: destPath, createdAt: Date.now() };
      try {
        await db.doc(`posterUploads/${uid}/uploads/${nonce}`).set(uploadDoc);
      } catch (err) {
        // Nothing can ever reach this object if the pointer never landed.
        await bucket().file(destPath).delete()
          .catch(logDeleteFailure("processUpload", "orphaned poster (posterUploads write failed)", destPath));
        console.error("processUpload: posterUploads write failed", objectName, err);
      }
      return;
    }
```

- [ ] **Step 5: Implement the reaper in `functions/src/scheduled.ts`**

Extend the shared import (lines 3-7) with `POSTER_UPLOAD_TTL_MS`. In `SweepReport` (line 225 onward) add after `eventRemindersSent: number;`:

```ts
  // SP10 Task 19, step 3b: posterUploads/{uid}/uploads/{nonce} docs older
  // than POSTER_UPLOAD_TTL_MS deleted this run.
  posterUploadsReaped: number;
```

and in `errors` add `posterUploads: number;`. In the report initializer inside `runDailySweep` (lines 310-320) add `posterUploadsReaped: 0,` beside `eventRemindersSent: 0,` and `posterUploads: 0,` inside `errors`.

Add after the track reaper's `catch` block (line 611, before the `// 4) Invite sweep` comment):

```ts
  // 3b) Poster upload reaper (SP10 Task 19): a posterUploads doc is a
  // pointer the client consumes within seconds of the upload; one older than
  // POSTER_UPLOAD_TTL_MS belongs to an abandoned picker. Only the doc goes:
  // the processed object may already be an event's posterPath. Owner docs
  // (posterUploads/{uid}) are never written, so listDocuments() is the only
  // way to enumerate them; each owner's stale set is tiny, so a plain get per
  // owner replaces pagination here.
  try {
    const writer = createChunkedWriter(db);
    const posterCutoff = now - POSTER_UPLOAD_TTL_MS;
    const ownerRefs = await db.collection("posterUploads").listDocuments();
    for (const ownerRef of ownerRefs) {
      const staleSnap = await ownerRef.collection("uploads").where("createdAt", "<", posterCutoff).get();
      for (const doc of staleSnap.docs) {
        await writer.delete(doc.ref);
        report.posterUploadsReaped++;
      }
    }
    await writer.commit();
  } catch (e) {
    console.error("dailySweep: poster upload reaper step failed", e);
    report.errors.posterUploads++;
  }
```

- [ ] **Step 6: Run `test/media.test.ts` and `test/scheduled.test.ts`**

Expected: both new cases pass; the "rejects a poster upload aimed at a musician profile" case still passes (the type gate at line 268 returns before the poster branch, so no doc is written).

- [ ] **Step 7: Commit**

```
feat(functions): publish processed poster paths to posterUploads and reap them daily
```

---

### Task 20: Door and reminder: `undoCheckIn`, the 12 h check-in gate, launch-zone reminder copy

**Files:**
- Modify: `functions/src/ticketing.ts` (shared import 32-39, `checkInTicket` 973-1040, new `undoCheckIn` inserted before `OfferTransferInput` at 1042)
- Modify: `functions/src/index.ts` (ticketing export, lines 30-32)
- Modify: `functions/src/scheduled.ts` (shared import 3-7, lines 22-41 `EVENT_REMINDER_WINDOW_MS` / `REMINDER_MONTHS` / `formatEventReminderDate`, step 8 lines 928-931)
- Modify: `functions/test/ticketingDoor.test.ts` (add `openDoors` after `openOfferIdFor` at 107; call it before every `checkInTicket` call at lines 122, 147, 149, 167, 185, 205, 228, 300, 305, 666, 703; new cases)
- Modify: `functions/test/scheduled.test.ts` (new pure describe for the formatter)
- Modify: `functions/test/eventsSettlement.test.ts` (reminder describe 418-500: title filters at 445, 454, 477 and one body pin)

**Interfaces:**
- Consumes: `CHECK_IN_OPENS_BEFORE_MS`, `CHECK_IN_TOO_EARLY_MESSAGE`, `LAUNCH_TIMEZONE` from `@gatekeep/shared`; `FieldValue` (already imported in `ticketing.ts:30`); `requireProfileMember`, `requireApprovedCuratorProfile` (`guards.ts`).
- Produces:
  - `undoCheckIn({ eventId, ticketId })` callable, curator member of `event.curatorProfileId`, flips `checked_in` to `valid` on `users/{owner}/tickets/{ticketId}` and `events/{eventId}/attendees/{ticketId}` and deletes `checkedInAt` on both; returns `{ ok: true }`. Local message constant `TICKET_NOT_CHECKED_IN_MESSAGE = "This ticket is not checked in."` (ticketing.ts only; clients do not branch on it).
  - `checkInTicket` throws `HttpsError("failed-precondition", CHECK_IN_TOO_EARLY_MESSAGE)` when `event.startsAt - Date.now() > CHECK_IN_OPENS_BEFORE_MS`, checked after the published-status gate and before any attendee read.
  - `export function formatEventReminder(title: string, startsAt: number, now: number): { title: "Tonight" | "Tomorrow"; body: string }` in `scheduled.ts`. Body shape: `"<title>" starts <Weekday>, <Month> <day> at <h>:<mm> <AM|PM> <EDT|EST>.` rendered in `LAUNCH_TIMEZONE`; the title is `Tonight` when `startsAt` and `now` fall on the same launch-zone calendar day, otherwise `Tomorrow`.

- [ ] **Step 1: Pin the reminder copy with a pure test in `functions/test/scheduled.test.ts`**

Extend the sweep import: `import { runDailySweep, formatEventReminder } from "../src/scheduled.js";`. Append:

```ts
describe("formatEventReminder (SP10 Task 20)", () => {
  // Friday, September 4, 2026, 8:00 PM EDT (00:00 UTC on September 5).
  const startsAt = Date.UTC(2026, 8, 5, 0, 0, 0);

  it("renders the launch-zone weekday, date, time and zone, and titles a same-day event Tonight", () => {
    const copy = formatEventReminder("Friday Night Jazz Showcase", startsAt, Date.UTC(2026, 8, 4, 13, 0, 0)); // 9:00 AM EDT that day
    expect(copy.title).toBe("Tonight");
    expect(copy.body).toBe("\"Friday Night Jazz Showcase\" starts Friday, September 4 at 8:00 PM EDT.");
  });

  it("uses the launch-zone calendar day, not UTC: 7:00 PM EDT on the day of the show is still Tonight", () => {
    const copy = formatEventReminder("Friday Night Jazz Showcase", startsAt, Date.UTC(2026, 8, 4, 23, 0, 0));
    expect(copy.title).toBe("Tonight"); // UTC already says September 4 vs September 5
  });

  it("titles a next-day event Tomorrow", () => {
    const copy = formatEventReminder("Friday Night Jazz Showcase", startsAt, Date.UTC(2026, 8, 4, 2, 0, 0)); // 10:00 PM EDT on September 3
    expect(copy.title).toBe("Tomorrow");
  });

  it("renders standard time in winter", () => {
    const copy = formatEventReminder("Winter Set", Date.UTC(2027, 0, 16, 1, 0, 0), Date.UTC(2027, 0, 15, 15, 0, 0));
    expect(copy.body).toBe("\"Winter Set\" starts Friday, January 15 at 8:00 PM EST.");
  });
});
```

- [ ] **Step 2: Update the reminder integration test in `functions/test/eventsSettlement.test.ts`**

Add `import { formatEventReminder } from "../src/scheduled.js";` beside the existing `runDailySweep` import (line 10). In the first case (line 419) capture the start: replace the `makeDraftEvent("rem1", {...})` call with

```ts
    const startsAt = Date.now() + 20 * HOUR_MS;
    const { owner, profileId, eventId } = await makeDraftEvent("rem1", { startsAt, endsAt: startsAt + 3 * HOUR_MS });
```

Replace every `&& d.data().title === "Event tomorrow"` filter (lines 445, 454) with `&& (d.data().title === "Tonight" || d.data().title === "Tomorrow")`, and line 477's `d.data().title === "Event tomorrow"` with `(d.data().title === "Tonight" || d.data().title === "Tomorrow")`. After the first `expect(reminders).toHaveLength(1);` inside the loop at 446 add:

```ts
      expect(reminders[0].data().body).toBe(formatEventReminder("Friday Night Jazz Showcase", startsAt, 0).body);
```

- [ ] **Step 3: Add `openDoors` and the door tests to `functions/test/ticketingDoor.test.ts`**

Extend the shared import (lines 5-9) with `CHECK_IN_TOO_EARLY_MESSAGE`. Add after `openOfferIdFor` (line 107):

```ts
// SP10 Task 20: checkInTicket refuses a scan more than CHECK_IN_OPENS_BEFORE_MS
// (12h) before startsAt. Every fixture event starts 7 days out (eventContent),
// so a door test moves the event to 6h out right before scanning. Admin-SDK
// flip, same precedent as the "flip status directly" cases below.
async function openDoors(eventId: string): Promise<void> {
  const startsAt = Date.now() + 6 * 3_600_000;
  await adb.doc(`events/${eventId}`).update({ startsAt, endsAt: startsAt + 3 * 3_600_000, updatedAt: Date.now() });
}
```

Insert `await openDoors(eventId);` immediately before the first `checkInTicket` call in each of these cases: happy path (line 122), duplicate scan (147), wrong secret (167), override (185), non-member (205), non-published (228; call it before the status flip), transfer lifecycle (300), the refund-vs-transfer race case at 666, and the strict-override case at 703.

Add inside the `checkInTicket` describe:

```ts
  it("SP10 Task 20: refuses a scan more than 12h before startsAt with CHECK_IN_TOO_EARLY_MESSAGE and leaves the ticket valid", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("ci7");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("ci7buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const tickets = await ticketsForOrder(buyer.uid, orderId);
    const ticketId = tickets[0].id;
    const qrSecret = tickets[0].data.qrSecret;

    // No openDoors: the event still starts 7 days out.
    await expect(callFn("checkInTicket", { curatorProfileId: profileId, eventId, ticketId, qrSecret }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: expect.stringContaining(CHECK_IN_TOO_EARLY_MESSAGE) });
    const ticket = (await adb.doc(`users/${buyer.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(ticket.status).toBe("valid");
  });
```

Add a new describe after the `checkInTicket` describe:

```ts
describe("undoCheckIn (SP10 Task 20)", () => {
  it("flips a checked-in ticket back to valid on both docs, clears checkedInAt, and the ticket scans again", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("uc1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("uc1buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const tickets = await ticketsForOrder(buyer.uid, orderId);
    const ticketId = tickets[0].id;
    const qrSecret = tickets[0].data.qrSecret;
    await openDoors(eventId);
    await callFn("checkInTicket", { curatorProfileId: profileId, eventId, ticketId, qrSecret }, owner.user);

    const result = await callFn<Record<string, unknown>, { ok: true }>("undoCheckIn", { eventId, ticketId }, owner.user);
    expect(result.ok).toBe(true);

    const ticket = (await adb.doc(`users/${buyer.uid}/tickets/${ticketId}`).get()).data() as TicketDoc;
    expect(ticket.status).toBe("valid");
    expect(ticket.checkedInAt).toBeUndefined();
    const attendee = (await adb.doc(`events/${eventId}/attendees/${ticketId}`).get()).data() as AttendeeDoc;
    expect(attendee.status).toBe("valid");
    expect(attendee.checkedInAt).toBeUndefined();

    const again = await callFn<Record<string, unknown>, { checkedInAt: number }>(
      "checkInTicket", { curatorProfileId: profileId, eventId, ticketId, qrSecret }, owner.user);
    expect(again.checkedInAt).toBeTypeOf("number");
  });

  it("refuses a ticket that is not checked in", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("uc2");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("uc2buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const ticketId = (await ticketsForOrder(buyer.uid, orderId))[0].id;
    await expect(callFn("undoCheckIn", { eventId, ticketId }, owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
  });

  it("denies a caller who is not a member of the event's curator profile", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("uc3");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("uc3buyer");
    const orderId = await payOrder(eventId, tierId, 1, buyer.user);
    const ticketId = (await ticketsForOrder(buyer.uid, orderId))[0].id;
    const stranger = await makeBuyer("uc3stranger");
    await expect(callFn("undoCheckIn", { eventId, ticketId }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});
```

- [ ] **Step 4: Run `test/scheduled.test.ts`, `test/eventsSettlement.test.ts`, `test/ticketingDoor.test.ts`**

Expected: `formatEventReminder` is not exported (compile failure in two files); the reminder integration case fails on title (still `Event tomorrow`); the too-early case fails because the scan succeeds (`checkedInAt` returned); every `undoCheckIn` case fails with `functions/not-found` (callable does not exist in the emulator).

- [ ] **Step 5: Implement the reminder formatter in `functions/src/scheduled.ts`**

Extend the shared import (lines 3-7) with `LAUNCH_TIMEZONE`. Replace lines 22-41 (keep `EVENT_REMINDER_WINDOW_MS`, drop `REMINDER_MONTHS` and `formatEventReminderDate`) with:

```ts
// SP6 Task 7: the "starts within" window for the event reminder step below.
const EVENT_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

// SP10 Task 20 (sp6 #4): the reminder renders in LAUNCH_TIMEZONE like every
// client surface (eventDisplay.ts on both platforms), and its title comes
// from the launch-zone calendar day. Parts are assembled by hand from
// formatToParts so the rendered string is fixed regardless of ICU's own
// joiner choices ("at", comma placement), which tests pin exactly.
const REMINDER_DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: LAUNCH_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
});
const REMINDER_WHEN_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: LAUNCH_TIMEZONE, weekday: "long", month: "long", day: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

export interface EventReminderCopy { title: "Tonight" | "Tomorrow"; body: string; }

export function formatEventReminder(title: string, startsAt: number, now: number): EventReminderCopy {
  const p: Record<string, string> = {};
  for (const part of REMINDER_WHEN_FORMAT.formatToParts(new Date(startsAt))) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  const when = `${p.weekday}, ${p.month} ${p.day} at ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName}`;
  const sameDay = REMINDER_DAY_FORMAT.format(new Date(startsAt)) === REMINDER_DAY_FORMAT.format(new Date(now));
  return { title: sameDay ? "Tonight" : "Tomorrow", body: `"${title}" starts ${when}.` };
}
```

In step 8 replace lines 928-931 (`const body = ...` through the `notifyUser` call) with:

```ts
          const copy = formatEventReminder(event.title, event.startsAt, now);
          for (const uid of ownerUids) {
            try {
              await notifyUser(uid, { kind: "ticket", refId: doc.id, title: copy.title, body: copy.body });
```

- [ ] **Step 6: Implement the gate and `undoCheckIn` in `functions/src/ticketing.ts`**

Extend the shared import (lines 32-39) with `CHECK_IN_OPENS_BEFORE_MS, CHECK_IN_TOO_EARLY_MESSAGE`. After the published-status gate in `checkInTicket` (lines 1001-1003) add:

```ts
    // SP10 Task 20 (sp6 #12): a curator browsing the attendee list days early
    // must not be able to mark someone in by a mistaken tap. 12h covers a
    // matinee-to-late-show door and an early soundcheck.
    if (event.startsAt - Date.now() > CHECK_IN_OPENS_BEFORE_MS) {
      throw new HttpsError("failed-precondition", CHECK_IN_TOO_EARLY_MESSAGE);
    }
```

Insert before `export interface OfferTransferInput` (line 1042):

```ts
const TICKET_NOT_CHECKED_IN_MESSAGE = "This ticket is not checked in.";

export interface UndoCheckInInput { eventId: string; ticketId: string; }

// SP10 Task 20 (sp6 #12): the door's undo. Same attendee -> ownerUid ->
// ticket resolution as checkInTicket, no qrSecret (the curator already has
// the ticket in front of them on the list); the only state it accepts is
// "checked_in", and it puts both docs back exactly as a fresh ticket looks
// (status "valid", no checkedInAt) so a re-scan behaves like a first scan.
export const undoCheckIn = onCall<UndoCheckInInput>(
  { region: "us-central1" }, async (req): Promise<{ ok: true }> => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const input = req.data;
    if (!isValidDocId(input?.eventId)) throw new HttpsError("invalid-argument", "An event id is required.");
    if (!isValidDocId(input?.ticketId)) throw new HttpsError("invalid-argument", "A ticket id is required.");

    const db = getFirestore();
    const eventRef = db.doc(`events/${input.eventId}`);
    const eventSnap = await eventRef.get();
    if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const event = eventSnap.data() as EventDoc;
    await requireProfileMember(event.curatorProfileId, uid);
    await requireApprovedCuratorProfile(event.curatorProfileId);
    if (event.status !== "published") {
      throw new HttpsError("failed-precondition", CHECK_IN_NOT_PUBLISHED_MESSAGE);
    }

    const attendeeRef = eventRef.collection("attendees").doc(input.ticketId);
    const attendeeSnap = await attendeeRef.get();
    if (!attendeeSnap.exists) throw new HttpsError("not-found", "Ticket not found.");
    const attendee = attendeeSnap.data() as AttendeeDoc;
    const ticketRef = db.doc(`users/${attendee.ownerUid}/tickets/${input.ticketId}`);

    await db.runTransaction(async (tx) => {
      const ticketSnap = await tx.get(ticketRef);
      const ticket = ticketSnap.data() as TicketDoc | undefined;
      if (!ticket || ticket.eventId !== input.eventId || ticket.curatorProfileId !== event.curatorProfileId) {
        throw new HttpsError("not-found", "Ticket not found.");
      }
      if (ticket.status !== "checked_in") {
        throw new HttpsError("failed-precondition", TICKET_NOT_CHECKED_IN_MESSAGE);
      }
      tx.update(ticketRef, { status: "valid", checkedInAt: FieldValue.delete() });
      tx.update(attendeeRef, { status: "valid", checkedInAt: FieldValue.delete() });
    });
    return { ok: true };
  });
```

In `functions/src/index.ts` lines 30-32:

```ts
export {
  createTicketOrder, finalizeTicketOrder, refundTicket, checkInTicket, undoCheckIn, offerTransfer, respondToTransfer,
} from "./ticketing.js";
```

- [ ] **Step 7: Run the three files again**

Expected: all pass, including every pre-existing door case now preceded by `openDoors`.

- [ ] **Step 8: Commit**

```
feat(functions): undoCheckIn, 12h check-in gate, launch-zone reminder copy with Tonight/Tomorrow titles
```

---

### Task 21: Order holds: `cancelTicketOrder`, five-minute expiry scheduler, per-user pending cap, receipts, one event per gig

**Files:**
- Modify: `packages/shared/src/types.ts` (`TicketOrderStatus` line 944)
- Modify: `functions/src/stripeClient.ts` (`StripeLike.createIntent` 155-157, `FakeStripe.createIntent` 495-504, `RealStripe.createIntent` 837-843)
- Modify: `functions/src/ticketing.ts` (shared import 32-39, `createTicketOrder` 58-172, `cancelPendingOrderForCancelledEvent` 525-566, new `cancelTicketOrder` before `CancelledEventOrdersResult` at 568)
- Modify: `functions/src/paymentsSweep.ts` (`expireTicketOrders` 1276-1291, step list entry at 1608, scheduler exports 1631-1634)
- Modify: `functions/src/events.ts` (shared import 21-25, gig branch of `createEvent` 215-225)
- Modify: `functions/src/index.ts` (ticketing and paymentsSweep exports)
- Modify: `functions/test/stripeClient.test.ts` (after the `createIntent` case at 121-125)
- Modify: `functions/test/ticketing.test.ts` (new describes after "ticket order expiry sweep")
- Modify: `functions/test/events.test.ts` (`createEvent` describe, after the "rejects promoting a gig that isn't filled" case at 245)
- Modify: `functions/test/stripeSecrets.test.ts` (`STRIPE_REACHING` list 40-54)

**Interfaces:**
- Consumes: `PENDING_ORDERS_PER_USER_CAP`, `PENDING_ORDERS_CAP_MESSAGE`, `GIG_ALREADY_PROMOTED_MESSAGE` from `@gatekeep/shared`; `emptyReport()` (`paymentsSweep.ts:224`); `getStripe().cancelIntent` / `retrieveIntentStatus`.
- Produces:
  - `TicketOrderStatus` adds `"cancelled"` (INVENTED HERE beyond the shared block; the spec names the status. B4's web `BuyTicketsFlow.tsx:46` comment and any status switch must accept it).
  - `StripeLike.createIntent(params: { amountCents; idempotencyKey; meta; receiptEmail?: string })`; FakeStripe stores `receiptEmail: string | null` on the intent object doc; RealStripe passes `receipt_email`.
  - `cancelTicketOrder({ orderId })` callable, buyer only, `secrets: [stripeSecretKey]`; returns `{ orderStatus: TicketOrderStatus }`. Pending orders are released (intent cancelled when one exists, inventory returned, status `cancelled`); a non-pending order returns its current status untouched; an intent that already succeeded throws `failed-precondition` with local constant `ORDER_ALREADY_PAID_MESSAGE = "This order has already been paid. Check your tickets."`.
  - `async function releasePendingOrder(db, orderRef, finalStatus: "expired" | "cancelled"): Promise<"released" | "deferred" | "skipped">` in `ticketing.ts` (module-private), the extracted release transaction both `cancelPendingOrderForCancelledEvent` and `cancelTicketOrder` call.
  - `export interface TicketOrderExpiryReport { ticketOrdersExpired: number; ticketOrdersExpiryDeferred: number; errors: number }` and `export async function runTicketOrderExpiry(now: number): Promise<TicketOrderExpiryReport>` in `paymentsSweep.ts`; step 8 of the hourly sweep calls it and folds the counters into its own report.
  - `export const ticketOrderExpiry = onSchedule({ schedule: "every 5 minutes", region: "us-central1", timeoutSeconds: 240, memory: "256MiB", retryCount: 3, secrets: [stripeSecretKey] }, ...)`.
  - `createTicketOrder` refuses with `resource-exhausted` + `PENDING_ORDERS_CAP_MESSAGE` when the buyer already has `PENDING_ORDERS_PER_USER_CAP` pending orders across all events, and passes the buyer's verified email as `receiptEmail`.
  - `createEvent` with `source.kind === "gig"` refuses with `failed-precondition` + `GIG_ALREADY_PROMOTED_MESSAGE` when any non-cancelled event already has that `gigId`.

- [ ] **Step 1: FakeStripe receipt test in `functions/test/stripeClient.test.ts`**

After the "createIntent produces a customer-less intent" case (line 125):

```ts
  it("createIntent records receiptEmail on the fake intent, null when omitted (SP10 Task 21)", async () => {
    const withEmail = await fake.createIntent({
      amountCents: 1500, idempotencyKey: `cir-${Date.now()}`, meta: {}, receiptEmail: "fan@test.com",
    });
    expect((await adb.doc(`stripeFake/state/objects/${withEmail.id}`).get()).data()?.receiptEmail).toBe("fan@test.com");
    const without = await fake.createIntent({ amountCents: 1500, idempotencyKey: `cin-${Date.now()}`, meta: {} });
    expect((await adb.doc(`stripeFake/state/objects/${without.id}`).get()).data()?.receiptEmail).toBeNull();
  });
```

- [ ] **Step 2: Ticketing tests in `functions/test/ticketing.test.ts`**

Extend the shared import (line 5) with `PENDING_ORDERS_PER_USER_CAP, PENDING_ORDERS_CAP_MESSAGE` and the sweep import (line 6) with `runTicketOrderExpiry`:

```ts
import { runPaymentsSweep, runTicketOrderExpiry } from "../src/paymentsSweep.js";
```

Append after the "ticket order expiry sweep" describe:

```ts
describe("cancelTicketOrder (SP10 Task 21)", () => {
  it("releases a pending paid order: intent canceled, inventory returned, status cancelled, and the same seats can be held again", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("cto1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 2, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("cto1buyer");

    const { orderId, clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 2 }] }, buyer.user);
    const intentId = clientSecret!.replace(/_secret_fake$/, "");
    expect((await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data()?.soldCount).toBe(2);

    const result = await callFn<Record<string, unknown>, { orderStatus: string }>("cancelTicketOrder", { orderId }, buyer.user);
    expect(result.orderStatus).toBe("cancelled");
    expect((await adb.doc(`orders/${orderId}`).get()).data()?.status).toBe("cancelled");
    expect((await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data()?.soldCount).toBe(0);
    expect((await adb.doc(`stripeFake/state/objects/${intentId}`).get()).data()?.status).toBe("canceled");

    // The hold is gone: the buyer can take the last two seats again.
    const again = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 2 }] }, buyer.user);
    expect(again.orderId).not.toBe(orderId);
  });

  it("is idempotent on a paid order: returns the current status and touches nothing", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("cto2");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("cto2buyer");
    const { orderId, clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user);
    await confirmFakeIntent(clientSecret!);
    await callFn("finalizeTicketOrder", { orderId }, buyer.user);

    const result = await callFn<Record<string, unknown>, { orderStatus: string }>("cancelTicketOrder", { orderId }, buyer.user);
    expect(result.orderStatus).toBe("paid");
    expect((await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data()?.soldCount).toBe(1);
  });

  it("another account cannot cancel the buyer's order (not-found, no leak)", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("cto3");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("cto3buyer");
    const { orderId } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user);
    const other = await makeBuyer("cto3other");
    await expect(callFn("cancelTicketOrder", { orderId }, other.user))
      .rejects.toMatchObject({ code: "functions/not-found" });
    expect((await adb.doc(`orders/${orderId}`).get()).data()?.status).toBe("pending");
  });
});

describe("createTicketOrder holds and receipts (SP10 Task 21)", () => {
  it("caps a buyer at PENDING_ORDERS_PER_USER_CAP concurrent pending orders, and a cancel frees a slot", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("cap1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 50, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("cap1buyer");

    const orderIds: string[] = [];
    for (let i = 0; i < PENDING_ORDERS_PER_USER_CAP; i++) {
      const { orderId } = await callFn<Record<string, unknown>, CreateOrderResult>(
        "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user);
      orderIds.push(orderId);
    }
    await expect(callFn("createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted", message: expect.stringContaining(PENDING_ORDERS_CAP_MESSAGE) });

    await callFn("cancelTicketOrder", { orderId: orderIds[0] }, buyer.user);
    const { orderId: fourth } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user);
    expect(fourth).toBeTruthy();
  });

  it("stamps the buyer's verified email as receiptEmail on the PaymentIntent", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("rcpt1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("rcpt1buyer");
    const { clientSecret } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, buyer.user);
    const intentId = clientSecret!.replace(/_secret_fake$/, "");
    expect((await adb.doc(`stripeFake/state/objects/${intentId}`).get()).data()?.receiptEmail).toBe(buyer.user.email);
  });
});

describe("runTicketOrderExpiry (SP10 Task 21)", () => {
  it("expires a stale pending order on its own, without the hourly sweep", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("toe1");
    await addTiersAndPublish(profileId, eventId, owner.user,
      [{ name: "General", priceCents: 1000, capacity: 10, saleStartsAt: null, saleEndsAt: null }]);
    const tierId = await tierIdByName(eventId, "General");
    const buyer = await makeBuyer("toe1buyer");
    const { orderId } = await callFn<Record<string, unknown>, CreateOrderResult>(
      "createTicketOrder", { eventId, items: [{ tierId, quantity: 2 }] }, buyer.user);
    await adb.doc(`orders/${orderId}`).update({ expiresAt: Date.now() - 1000 });

    const report = await runTicketOrderExpiry(Date.now());

    expect(report.ticketOrdersExpired).toBeGreaterThanOrEqual(1);
    expect(report.errors).toBe(0);
    expect((await adb.doc(`orders/${orderId}`).get()).data()?.status).toBe("expired");
    expect((await adb.doc(`events/${eventId}/tiers/${tierId}`).get()).data()?.soldCount).toBe(0);
  });
});
```

- [ ] **Step 3: Promotion test in `functions/test/events.test.ts`**

Extend the shared import with `GIG_ALREADY_PROMOTED_MESSAGE`. After the "rejects promoting a gig that isn't filled" case (line 245):

```ts
  it("SP10 Task 21: refuses a second event for the same gig with GIG_ALREADY_PROMOTED_MESSAGE", async () => {
    const { curator, gigId } = await makeFilledGig("ce2b");
    await callFn("createEvent",
      { curatorProfileId: curator.profileId, source: { kind: "gig", gigId }, ...eventContent() }, curator.owner.user);
    await expect(callFn("createEvent",
      { curatorProfileId: curator.profileId, source: { kind: "gig", gigId }, ...eventContent() }, curator.owner.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: expect.stringContaining(GIG_ALREADY_PROMOTED_MESSAGE) });
  });
```

- [ ] **Step 4: Extend the secret census in `functions/test/stripeSecrets.test.ts`**

Add to `STRIPE_REACHING` (after the `refundTicket` entry at line 53):

```ts
  { name: "cancelTicketOrder", file: "ticketing.ts", why: "SP10 Task 21: releasePendingOrder -> getStripe().cancelIntent / retrieveIntentStatus" },
  { name: "ticketOrderExpiry", file: "paymentsSweep.ts", why: "SP10 Task 21: onSchedule every 5 minutes, runTicketOrderExpiry -> getStripe().cancelIntent" },
];
```

- [ ] **Step 5: Run `test/stripeClient.test.ts`, `test/ticketing.test.ts`, `test/events.test.ts`, `test/stripeSecrets.test.ts`**

Expected: stripeClient's receipt case fails on `receiptEmail` (`undefined`, and TypeScript rejects the extra param); `runTicketOrderExpiry` is not exported (compile failure in ticketing.test.ts; comment it out to see `cancelTicketOrder` fail with `functions/not-found`, the cap case fail because the fourth order succeeds, and the receipt case fail on `undefined`); events' promotion case fails because the second `createEvent` succeeds; stripeSecrets fails clause 1 for both new names (no such exported handlers yet).

- [ ] **Step 6: Shared type**

`packages/shared/src/types.ts` line 944:

```ts
// "cancelled": released by the buyer through cancelTicketOrder (SP10 Task 21);
// nothing was charged. "expired": released by the expiry sweep.
export type TicketOrderStatus = "pending" | "paid" | "expired" | "cancelled" | "cancelled_refunded";
```

Run `pnpm --filter @gatekeep/shared build`.

- [ ] **Step 7: Stripe client**

`functions/src/stripeClient.ts` lines 155-157 (the `StripeLike.createIntent` signature):

```ts
  createIntent(params: {
    amountCents: number; idempotencyKey: string; meta: Record<string, string>;
    // SP10 Task 21: Stripe emails a receipt in live mode when set. The buyer's
    // verified account email, never client-supplied.
    receiptEmail?: string;
  }): Promise<{ id: string; clientSecret: string }>;
```

`FakeStripe.createIntent` (lines 495-504):

```ts
  async createIntent(p: { amountCents: number; idempotencyKey: string; meta: Record<string, string>; receiptEmail?: string }) {
    return this.idem(p.idempotencyKey, async () => {
      const id = this.newId("pi");
      await this.objRef(id).set({
        kind: "payment_intent", amountCents: p.amountCents, customerId: null,
        meta: p.meta, refundedCents: 0, status: "requires_confirmation",
        receiptEmail: p.receiptEmail ?? null,
      });
      return { id, clientSecret: `${id}_secret_fake` };
    }, `${p.amountCents}`);
  }
```

`RealStripe.createIntent` (lines 837-843):

```ts
  async createIntent(p: { amountCents: number; idempotencyKey: string; meta: Record<string, string>; receiptEmail?: string }) {
    const pi = await this.s.paymentIntents.create({
      amount: p.amountCents, currency: "usd", metadata: p.meta,
      automatic_payment_methods: { enabled: true },
      ...(p.receiptEmail ? { receipt_email: p.receiptEmail } : {}),
    }, { idempotencyKey: p.idempotencyKey });
    return { id: pi.id, clientSecret: pi.client_secret! };
  }
```

- [ ] **Step 8: `createTicketOrder` cap and receipt in `functions/src/ticketing.ts`**

Extend the shared import (lines 32-39) with `PENDING_ORDERS_PER_USER_CAP, PENDING_ORDERS_CAP_MESSAGE`. After the `pendingOrdersQuery` declaration (line 99-100) add:

```ts
    // SP10 Task 21 (sp6 #15): a buyer may hold at most PENDING_ORDERS_PER_USER_CAP
    // unpaid reservations across ALL events. Equality-only query, served by
    // merged single-field indexes; limit() keeps the transactional read tiny.
    const allPendingQuery = db.collection("orders")
      .where("buyerUid", "==", uid).where("status", "==", "pending").limit(PENDING_ORDERS_PER_USER_CAP);
```

Change the transactional read (lines 106-108) to:

```ts
      const [tierSnaps, ticketIndexSnap, pendingOrdersSnap, allPendingSnap] = await Promise.all([
        Promise.all(tierRefs.map((ref) => tx.get(ref))), tx.get(ticketIndexRef), tx.get(pendingOrdersQuery),
        tx.get(allPendingQuery),
      ]);
      if (allPendingSnap.size >= PENDING_ORDERS_PER_USER_CAP) {
        throw new HttpsError("resource-exhausted", PENDING_ORDERS_CAP_MESSAGE);
      }
```

Replace the intent creation (lines 165-169) with:

```ts
    // SP10 Task 21 (sp6 #7): the account email is verified (requireVerifiedEmail
    // above), so it is safe to hand Stripe as the receipt address.
    const receiptEmail = typeof req.auth?.token?.email === "string" ? req.auth.token.email : undefined;
    const intent = await getStripe().createIntent({
      amountCents: faceTotalCents + serviceFeeCents,
      idempotencyKey: `tickets:${orderRef.id}`,
      meta: { purpose: "tickets", orderId: orderRef.id },
      receiptEmail,
    });
```

- [ ] **Step 9: Extract `releasePendingOrder` and add `cancelTicketOrder`**

Replace `cancelPendingOrderForCancelledEvent` (lines 525-566, from its doc comment through the closing `return "expired";` and `}`) with:

```ts
// Cancels ONE "pending" order's PaymentIntent (if any) and releases its
// held tier inventory, landing the order in `finalStatus`. Reuses the SP6
// Task 5 expiry sweep's money-wins pattern (paymentsSweep.ts's
// expireOneTicketOrder) rather than importing it: that step is keyed off
// expiresAt and carries its own report counters. SP10 Task 21 lifted this
// out of cancelPendingOrderForCancelledEvent so the buyer's own
// cancelTicketOrder shares exactly one release transaction.
//
// "deferred" means the intent could not be confirmed cancelable (most
// commonly: it already succeeded, money moved); the order is left pending
// for finalizeTicketOrder / the webhook / refundOrderForCancelledEvent.
async function releasePendingOrder(
  db: Firestore, orderRef: FirebaseFirestore.DocumentReference, finalStatus: "expired" | "cancelled",
): Promise<"released" | "deferred" | "skipped"> {
  const freshSnap = await orderRef.get();
  const order = freshSnap.data() as TicketOrderDoc | undefined;
  if (!order || order.status !== "pending") return "skipped"; // resolved since the caller's read

  if (order.paymentIntentId) {
    try {
      await getStripe().cancelIntent(order.paymentIntentId);
    } catch (e) {
      // Ambiguous throw (cancelIntent's own doc comment): either the intent
      // already succeeded, or it was already canceled by a prior pass whose
      // Firestore transaction below never committed. Only the second case
      // is safe to proceed on.
      let status: string | undefined;
      try {
        status = (await getStripe().retrieveIntentStatus(order.paymentIntentId)).status;
      } catch (statusError) {
        console.error(
          `releasePendingOrder: could not confirm intent ${order.paymentIntentId}'s status after a failed cancel for order ${orderRef.id}`, statusError);
      }
      if (status !== "canceled") {
        console.info(
          `releasePendingOrder: order ${orderRef.id} left pending, intent ${order.paymentIntentId} could not be confirmed cancelable (status=${status ?? "unknown"})`, e);
        return "deferred";
      }
    }
  }

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    const o = snap.data() as TicketOrderDoc | undefined;
    if (!o || o.status !== "pending") return; // raced since the fresh read above
    for (const item of o.items) {
      tx.update(db.doc(`events/${o.eventId}/tiers/${item.tierId}`), { soldCount: FieldValue.increment(-item.quantity) });
    }
    tx.update(orderRef, { status: finalStatus });
  });
  return "released";
}

async function cancelPendingOrderForCancelledEvent(
  db: Firestore, orderRef: FirebaseFirestore.DocumentReference,
): Promise<"expired" | "deferred" | "skipped"> {
  const outcome = await releasePendingOrder(db, orderRef, "expired");
  return outcome === "released" ? "expired" : outcome;
}

const ORDER_ALREADY_PAID_MESSAGE = "This order has already been paid. Check your tickets.";

export interface CancelTicketOrderInput { orderId: string; }
export interface CancelTicketOrderResult { orderStatus: TicketOrderStatus; }

// SP10 Task 21 (sp6 #2): the buyer's own release. A dismissed PaymentSheet or
// a web Cancel used to leave a 10 to 70 minute hold the fan could not undo,
// which read as "Sold out" to them for their own seats. Pending only; a
// resolved order just echoes its status (the client can call this freely
// from any cancel path). Nothing here refunds: a pending order has never
// been charged, and an intent that turns out to have succeeded is left for
// finalizeTicketOrder, with a message that says so.
export const cancelTicketOrder = onCall<CancelTicketOrderInput>(
  { region: "us-central1", secrets: [stripeSecretKey] }, async (req): Promise<CancelTicketOrderResult> => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { orderId } = req.data ?? ({} as CancelTicketOrderInput);
    if (!isValidDocId(orderId)) throw new HttpsError("invalid-argument", "An order id is required.");

    const db = getFirestore();
    const orderRef = db.doc(`orders/${orderId}`);
    const order = (await orderRef.get()).data() as TicketOrderDoc | undefined;
    // Same not-found for "no such order" and "someone else's order": an order
    // id must never be an oracle for another buyer's activity.
    if (!order || order.buyerUid !== uid) throw new HttpsError("not-found", "Order not found.");
    if (order.status !== "pending") return { orderStatus: order.status };

    const outcome = await releasePendingOrder(db, orderRef, "cancelled");
    if (outcome === "deferred") throw new HttpsError("failed-precondition", ORDER_ALREADY_PAID_MESSAGE);
    const fresh = (await orderRef.get()).data() as TicketOrderDoc;
    return { orderStatus: fresh.status };
  });
```

- [ ] **Step 10: The expiry runner and scheduler in `functions/src/paymentsSweep.ts`**

After `expireTicketOrders` (ends line 1291) add:

```ts
export interface TicketOrderExpiryReport {
  ticketOrdersExpired: number; ticketOrdersExpiryDeferred: number; errors: number;
}

// SP10 Task 21 (sp6 #2, #15): the expiry step on its own clock. Called every
// 5 minutes by `ticketOrderExpiry` below so an abandoned hold lasts about
// ORDER_TTL_MS + 5 min instead of up to 70 min, and by the hourly sweep's
// step 8 as the backstop. Runs against a fresh PaymentsSweepReport so
// expireOneTicketOrder's counters keep their shape.
export async function runTicketOrderExpiry(now: number): Promise<TicketOrderExpiryReport> {
  const db = getFirestore();
  const report = emptyReport();
  await expireTicketOrders(db, now, report);
  return {
    ticketOrdersExpired: report.ticketOrdersExpired,
    ticketOrdersExpiryDeferred: report.ticketOrdersExpiryDeferred,
    errors: report.errors.ticketOrderExpire ?? 0,
  };
}
```

Replace the step entry at line 1608 (`{ name: "ticketOrderExpiry", run: () => expireTicketOrders(db, now, report) },`) with:

```ts
    {
      name: "ticketOrderExpiry",
      run: async () => {
        const r = await runTicketOrderExpiry(now);
        report.ticketOrdersExpired += r.ticketOrdersExpired;
        report.ticketOrdersExpiryDeferred += r.ticketOrdersExpiryDeferred;
        if (r.errors > 0) report.errors.ticketOrderExpire = (report.errors.ticketOrderExpire ?? 0) + r.errors;
      },
    },
```

After the `paymentsSweep` export (line 1634) add:

```ts
// SP10 Task 21: the five-minute order-expiry clock. retryCount 3 per the
// scheduler ruling in Task 24 (a transient Firestore/Stripe failure must not
// hold every stale reservation for another five minutes plus). Secrets are
// mandatory: cancelIntent reaches getStripe(), which fails closed without it.
export const ticketOrderExpiry = onSchedule(
  {
    schedule: "every 5 minutes", region: "us-central1", timeoutSeconds: 240, memory: "256MiB",
    retryCount: 3, secrets: [stripeSecretKey],
  },
  async () => { await runTicketOrderExpiry(Date.now()); },
);
```

- [ ] **Step 11: One event per gig in `functions/src/events.ts`**

Extend the shared import (lines 21-25) with `GIG_ALREADY_PROMOTED_MESSAGE`. In the gig branch, after the `gig.status !== "filled"` check (lines 222-224) add:

```ts
      // SP10 Task 21: a gig promotes to at most one live event. A cancelled
      // event does not block a fresh promotion (the curator may be re-running
      // the show); anything draft, published or completed does.
      const priorEvents = await db.collection("events").where("gigId", "==", gigId).get();
      if (priorEvents.docs.some((d) => (d.data() as EventDoc).status !== "cancelled")) {
        throw new HttpsError("failed-precondition", GIG_ALREADY_PROMOTED_MESSAGE);
      }
```

- [ ] **Step 12: Exports in `functions/src/index.ts`**

```ts
export { paymentsSweep, ticketOrderExpiry } from "./paymentsSweep.js";
...
export {
  createTicketOrder, finalizeTicketOrder, cancelTicketOrder, refundTicket, checkInTicket, undoCheckIn,
  offerTransfer, respondToTransfer,
} from "./ticketing.js";
```

- [ ] **Step 13: Run `pnpm typecheck`, then `test/stripeClient.test.ts`, `test/ticketing.test.ts`, `test/events.test.ts`, `test/stripeSecrets.test.ts`, `test/ticketingRefunds.test.ts`**

Expected: all pass. `ticketingRefunds.test.ts` still passes because `cancelPendingOrderForCancelledEvent` keeps its `"expired" | "deferred" | "skipped"` contract through the wrapper.

- [ ] **Step 14: Commit**

```
feat(functions): cancelTicketOrder, five-minute ticketOrderExpiry scheduler, per-user pending cap, receipt emails, one event per gig
```

---

### Task 22: Booking server changes: `fillMode` stamp, reopened-date single booking, past-date guards, thread-full message, sweep step 6 fixes

**Files:**
- Modify: `functions/src/scheduled.ts` (materializer gig doc 452-463; step 6 body 691-712)
- Modify: `functions/src/gigs.ts` (`createGig` gig doc 158-167)
- Modify: `functions/src/bookings.ts` (shared import 3-9, `finalizeBookingRequest` whole-run detection 129-138, `applyToGig` status gate 184-190, `offerGig` status gate 224-229, `counterBooking` thread cap 302-305)
- Modify: `functions/test/bookings.test.ts` (shared import 5-9, `applyToGig` and `offerGig` describes, thread-cap case 418-440)
- Modify: `functions/test/bookingLifecycle.test.ts` (`cancelOccurrence` describe, after the first case at 527-571)
- Modify: `functions/test/scheduled.test.ts` (materialization describe 173; step 6 describe 604)
- Modify: `functions/test/gigs.test.ts` (createGig first case, assertions at 105-112)

**Interfaces:**
- Consumes: `GigDoc.fillMode?: "whole_run" | "per_occurrence" | null` (Task 1); `THREAD_FULL_MESSAGE` from `@gatekeep/shared`; `GigSeriesDoc.activeBookingId`.
- Produces:
  - Materialized occurrences carry `fillMode: series.fillMode`; `createGig` writes `fillMode: null`.
  - `finalizeBookingRequest` sets `seriesId` only when the series is `whole_run`, `active`, AND `activeBookingId == null`; a date reopened by `cancelOccurrence` on a booked run therefore gets a single-occurrence booking.
  - `applyToGig` refuses a started gig with the existing generic message `"This gig is not open for applications."`; `offerGig` refuses with `"This gig's date has already passed."` (publishGig's own P1 wording at `gigs.ts:204`).
  - `counterBooking` at the cap throws `HttpsError("resource-exhausted", THREAD_FULL_MESSAGE)`.
  - Sweep step 6 skips a booking with `depositChargePending === true`, and notifies the curator side (title `"Your offer expired"`, body `"The gig is no longer available, so this offer has expired."`) when `booking.initiatedBy === "curator"`, in addition to the existing musician notification.

- [ ] **Step 1: `fillMode` tests**

`functions/test/gigs.test.ts`, inside the first `createGig` case after `expect(pub.detachedFromTemplate).toBe(false);` (line 112):

```ts
    expect(pub.fillMode).toBeNull(); // SP10 Task 22: a one-off gig books one date
```

`functions/test/scheduled.test.ts`, inside the materialization describe (line 173), after the first weekly case:

```ts
  it("SP10 Task 22: stamps the series' fillMode on every materialized occurrence", async () => {
    const createdAt = Date.now();
    const anchor = expectedAnchor(createdAt, 5, 20, 0);
    const { seriesId } = await seedSeries({ createdAt, updatedAt: createdAt, fillMode: "whole_run" });
    await runDailySweep(anchor);
    const occs = await occurrencesFor(seriesId);
    expect(occs.length).toBeGreaterThan(0);
    for (const occ of occs) expect(occ.data().fillMode).toBe("whole_run");
  });
```

- [ ] **Step 2: Reopened-date test in `functions/test/bookingLifecycle.test.ts`**

Add inside the `cancelOccurrence` describe after its first case (ends line 571):

```ts
  it("SP10 Task 22 (sp4 #4): a date reopened on a booked run takes a SINGLE-occurrence booking, which can be accepted while the run keeps its own booking", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("reopc");
    const { owner: musicianA, profileId: musicianAId } = await makeApprovedMusicianProfile("reopa");
    const { owner: musicianB, profileId: musicianBId } = await makeApprovedMusicianProfile("reopb");
    await makeMoneyReady({ owner: curator, profileId: curatorProfileId }, { owner: musicianA, profileId: musicianAId });
    await makeMoneyReady({ owner: curator, profileId: curatorProfileId }, { owner: musicianB, profileId: musicianBId });
    const series = await seedSeries(curatorProfileId);
    try {
      const gigId1 = await createOpenGig(curatorProfileId, curator.user, { startsAt: Date.now() + 100 * 3_600_000 });
      const gigId2 = await createOpenGig(curatorProfileId, curator.user, { startsAt: Date.now() + 268 * 3_600_000 });
      await Promise.all([gigId1, gigId2].map((id) => adb.doc(`gigs/${id}`).update({ seriesId: series.id })));

      const { bookingId: runBookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
        "applyToGig", { gigId: gigId1, musicianProfileId: musicianAId, offer: offerPayload() }, musicianA.user);
      await callFn("acceptBooking", { bookingId: runBookingId }, curator.user);
      await ageConfirmedAt(runBookingId);
      await callFn("cancelOccurrence", { bookingId: runBookingId, gigId: gigId1, reason: "Private event that night." }, curator.user);
      expect((await adb.doc(`gigs/${gigId1}`).get()).data()?.status).toBe("open");

      // Musician B applies to the reopened date: single-occurrence, not a run.
      const { bookingId: dateBookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
        "applyToGig", { gigId: gigId1, musicianProfileId: musicianBId, offer: offerPayload() }, musicianB.user);
      const dateBooking = (await adb.doc(`bookings/${dateBookingId}`).get()).data() as BookingRequestDoc;
      expect(dateBooking.seriesId).toBeNull();

      // Accept goes through (no "This series is already booked."): the date
      // fills for B, the run's other date and the series linkage stay A's.
      await callFn("acceptBooking", { bookingId: dateBookingId }, curator.user);
      const gig1 = (await adb.doc(`gigs/${gigId1}`).get()).data();
      expect(gig1?.status).toBe("filled");
      expect(gig1?.bookingId).toBe(dateBookingId);
      expect(gig1?.bookedMusicianProfileId).toBe(musicianBId);
      const gig2 = (await adb.doc(`gigs/${gigId2}`).get()).data();
      expect(gig2?.status).toBe("filled");
      expect(gig2?.bookingId).toBe(runBookingId);
      expect((await adb.doc(`gigSeries/${series.id}`).get()).data()?.activeBookingId).toBe(runBookingId);
      expect((await adb.doc(`bookings/${runBookingId}`).get()).data()?.status).toBe("confirmed");
    } finally {
      await adb.doc(`gigSeries/${series.id}`).update({ status: "ended" });
    }
  });
```

(`makeMoneyReady` twice against the same curator is fine: `createSetupIntent` re-reads the cached customer and mints a second SetupIntent; payments.ts lines 95-109.)

- [ ] **Step 3: Guard and message tests in `functions/test/bookings.test.ts`**

Extend the shared import (lines 5-9) with `THREAD_FULL_MESSAGE`. Add inside the `applyToGig` describe:

```ts
  it("SP10 Task 22 (sp4 #24): refuses an open gig whose startsAt has elapsed", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("atpastc");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("atpastm");
    await makeMoneyReady({ owner: curator, profileId: curatorProfileId }, { owner: musician, profileId: musicianProfileId });
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    await adb.doc(`gigs/${gigId}`).update({ startsAt: Date.now() - 3_600_000 }); // still "open": the sweep has not run
    await expect(callFn("applyToGig", { gigId, musicianProfileId, offer: offerPayload() }, musician.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: expect.stringContaining("not open for applications") });
  });
```

Inside the `offerGig` describe:

```ts
  it("SP10 Task 22 (sp4 #24): refuses an open gig whose startsAt has elapsed", async () => {
    const { owner: curator, profileId: curatorProfileId } = await makeApprovedCuratorProfile("ogpastc");
    const { owner: musician, profileId: musicianProfileId } = await makeApprovedMusicianProfile("ogpastm");
    await makeMoneyReady({ owner: curator, profileId: curatorProfileId }, { owner: musician, profileId: musicianProfileId });
    const gigId = await createOpenGig(curatorProfileId, curator.user);
    await adb.doc(`gigs/${gigId}`).update({ startsAt: Date.now() - 3_600_000 });
    await expect(callFn("offerGig", { gigId, musicianProfileId, offer: offerPayload() }, curator.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: expect.stringContaining("already passed") });
  });
```

In the thread-cap case (line 438-439) change the final expectation to:

```ts
    await expect(callFn("counterBooking", { bookingId: bookingRef.id, offer: offerPayload() }, curator.user))
      .rejects.toMatchObject({ code: "functions/resource-exhausted", message: expect.stringContaining(THREAD_FULL_MESSAGE) });
```

- [ ] **Step 4: Step 6 tests in `functions/test/scheduled.test.ts`**

Add inside the step 6 describe (line 604):

```ts
  it("SP10 Task 22 (sp4 #14): leaves an open booking with depositChargePending untouched even though its gig has started", async () => {
    const now = Date.now();
    const curatorProfileId = fakeProfileId();
    const musicianProfileId = fakeProfileId();
    const gigId = await seedOccurrence("not-a-real-series", curatorProfileId, { status: "open", startsAt: now - 3600_000 });
    const { bookingId } = await seedBooking({
      gigId, seriesId: null, curatorProfileId, musicianProfileId, status: "open", depositChargePending: true,
    });

    await runDailySweep(now);

    const booking = (await adb.doc(`bookings/${bookingId}`).get()).data() as BookingRequestDoc;
    expect(booking.status).toBe("open"); // the payments sweep's saga step owns this booking
  });

  it("SP10 Task 22 (sp4 #23): notifies the curator side when a curator-initiated offer expires", async () => {
    const now = Date.now();
    const curatorProfileId = fakeProfileId();
    const musicianProfileId = fakeProfileId();
    const curatorUid = fakeUid();
    await seedMember(curatorProfileId, curatorUid);
    const gigId = await seedOccurrence("not-a-real-series", curatorProfileId, { status: "cancelled", startsAt: now + 3600_000 });
    const { bookingId } = await seedBooking({
      gigId, seriesId: null, curatorProfileId, musicianProfileId, status: "open",
      initiatedBy: "curator", awaitingSide: "musician",
      thread: [{ by: "curator", amountCents: 10_000, expectedQuantity: 1, note: null, at: now }],
    });

    await runDailySweep(now);

    expect((await adb.doc(`bookings/${bookingId}`).get()).data()?.status).toBe("expired");
    const notes = await pollNotifications(curatorUid);
    expect(notes.docs.some((d) => d.data().refId === bookingId && d.data().title === "Your offer expired")).toBe(true);
  });
```

- [ ] **Step 5: Run `test/gigs.test.ts`, `test/scheduled.test.ts`, `test/bookingLifecycle.test.ts`, `test/bookings.test.ts`**

Expected: `fillMode` assertions fail (`undefined`); the reopened-date case fails at `expect(dateBooking.seriesId).toBeNull()` (received the series id) and, past that, `acceptBooking` would throw "This series is already booked."; both past-date cases fail because the booking is created; the thread-cap case fails on the message; step 6's pending-saga case fails (`expired`), the curator-notify case fails (no notification for `curatorUid`).

- [ ] **Step 6: Stamp `fillMode`**

`functions/src/scheduled.ts` lines 456-463, inside the `const gig: GigDoc = {` literal add after `curatorProfileId: series.curatorProfileId, seriesId: seriesDoc.id, detachedFromTemplate: false,`:

```ts
              // SP10 Task 22 (sp4 #2): public, so browse and detail can say
              // "Books as a run" without a member-only gigSeries read.
              fillMode: series.fillMode,
```

`functions/src/gigs.ts` line 158, after `curatorProfileId: input.profileId, seriesId: null, detachedFromTemplate: false,`:

```ts
    fillMode: null,
```

- [ ] **Step 7: `functions/src/bookings.ts`**

Extend the shared import (lines 3-9) with `THREAD_FULL_MESSAGE`. Replace the whole-run detection (lines 129-138) with:

```ts
  // Whole-run detection: this booking targets the entire series' run only
  // when the gig belongs to an ACTIVE series whose fillMode is "whole_run"
  // AND that series is not already booked. SP10 Task 22 (sp4 #4): a date
  // reopened by cancelOccurrence on a booked run used to spawn a whole-run
  // booking that acceptBooking's rebooking-door guard could never accept;
  // with activeBookingId set, the reopened date books on its own
  // (seriesId null), and every run-scoped unwind already filters on
  // bookingId so the two bookings never touch each other's dates.
  let seriesId: string | null = null;
  if (gig.seriesId) {
    const seriesSnap = await db.doc(`gigSeries/${gig.seriesId}`).get();
    const series = seriesSnap.data() as GigSeriesDoc | undefined;
    if (series?.fillMode === "whole_run" && series.status === "active" && series.activeBookingId == null) {
      seriesId = gig.seriesId;
    }
  }
```

`applyToGig`: after the `gig.status !== "open"` block (ends line 190) add:

```ts
  // SP10 Task 22 (sp4 #24): an open gig whose date already passed is still
  // listed until the daily sweep closes it. Same generic message as above,
  // for the same enumeration reason.
  if (gig.startsAt <= Date.now()) {
    throw new HttpsError("failed-precondition", "This gig is not open for applications.");
  }
```

`offerGig`: after the `gig.status !== "open"` block (ends line 229) add:

```ts
  // SP10 Task 22 (sp4 #24): mirrors publishGig's own past-date guard.
  if (gig.startsAt <= Date.now()) {
    throw new HttpsError("failed-precondition", "This gig's date has already passed.");
  }
```

`counterBooking` lines 302-305:

```ts
    if (freshBooking.thread.length >= MAX_BOOKING_THREAD_ENTRIES) {
      throw new HttpsError("resource-exhausted", THREAD_FULL_MESSAGE);
    }
```

- [ ] **Step 8: Sweep step 6 in `functions/src/scheduled.ts`**

Replace lines 693-709 (from `const booking = doc.data() as BookingRequestDoc;` through the musician notify's `catch` block) with:

```ts
        const booking = doc.data() as BookingRequestDoc;
        // SP10 Task 22 (sp4 #14): an accept saga is mid-flight on this
        // booking; the payments sweep's step 1 owns it (its rule 3). Expiring
        // it here would turn a recoverable saga into an admin alert.
        if (booking.depositChargePending === true) continue;
        const gigSnap = await db.doc(`gigs/${booking.gigId}`).get();
        const gig = gigSnap.data() as GigDoc | undefined;
        if (!gig || gig.startsAt < now || gig.status !== "open") {
          await writer.update(doc.ref, { status: "expired", resolvedAt: now, updatedAt: now });
          report.bookingsExpired++;
          // Per-item try/catch (S3 sweep philosophy): one failed notify
          // must never abort the rest of this step.
          try {
            await notifyProfileMembers(booking.musicianProfileId, {
              kind: "booking", refId: doc.id, title: "Booking no longer available", body: "This gig is no longer available.",
            });
          } catch (e) {
            console.error(`dailySweep: failed to notify expired booking ${doc.id}`, e);
          }
          // SP10 Task 22 (sp4 #23): a curator who sent the offer learns it
          // lapsed, like every other resolution notifies both sides.
          if (booking.initiatedBy === "curator") {
            try {
              await notifyProfileMembers(booking.curatorProfileId, {
                kind: "booking", refId: doc.id, title: "Your offer expired",
                body: "The gig is no longer available, so this offer has expired.",
              });
            } catch (e) {
              console.error(`dailySweep: failed to notify curator of expired offer ${doc.id}`, e);
            }
          }
        }
```

- [ ] **Step 9: Run `pnpm typecheck` and the four test files again**

Expected: all pass, including the existing `bookings.test.ts` "sets seriesId for a whole_run series occurrence" case (its seeded series has `activeBookingId: null`).

- [ ] **Step 10: Commit**

```
fix(functions): stamp fillMode, single booking on reopened run dates, past-date guards, thread-full message, sweep step 6 saga skip and curator notify
```

---

### Task 23: Series: auto-end past `endDate`, propagation skips moderated and cancelled dates, inclusive end date

**Files:**
- Modify: `functions/src/scheduled.ts` (`computeOccurrences` comment and `windowEnd` 93-104; `SweepReport` 225-306 and its initializer 310-320; step 1 loop right after `const series = seriesDoc.data() as GigSeriesDoc;` at 336)
- Modify: `functions/src/gigSeries.ts` (propagation loop 262-269)
- Modify: `functions/test/scheduled.test.ts` (materialization describe: endDate case 237-250 updated, two new cases)
- Modify: `functions/test/gigSeries.test.ts` (`updateSeries` describe, after the F2 case at 264-274)

**Interfaces:**
- Consumes: `GigSeriesDoc.recurrence.endDate: number | null`, `GigStatus`, `GigSeriesDoc.fillMode`.
- Produces:
  - END DATE CONTRACT (server side, binding for B4): `recurrence.endDate` is the LAST INSTANT (epoch ms, inclusive) at which an occurrence may start. The materializer's exclusive window edge is `endDate + 1`. B4's forms submit the end-of-day instant (23:59:59.999 in `LAUNCH_TIMEZONE`) of the chosen calendar date, so every occurrence on that day is created, and a legacy series whose `endDate` sits exactly on a grid point still gets that occurrence. When the cap applies, `materializedThrough` advances to `endDate + 1`.
  - Step 1 flips an active series with `endDate <= now` to `status: "ended"` (transactional re-check of `status === "active"`, `updatedAt: now`), counted in the new `SweepReport.seriesEnded`. `endSeries` remains the only curator-driven writer of `"ended"`; the pause-is-one-way invariant is untouched.
  - `updateSeries` propagates only to `open` and `draft` future, non-detached occurrences, and restamps `fillMode: input.fillMode` on them.

- [ ] **Step 1: Series tests in `functions/test/scheduled.test.ts`**

In the existing endDate case (lines 237-250) change the last expectation to:

```ts
    expect(series.materializedThrough).toBe(endDate + 1); // inclusive endDate: the exclusive edge is one ms past it
```

Add after it:

```ts
  it("SP10 Task 23 (sp3 #11): an occurrence landing EXACTLY on endDate is created (endDate is inclusive)", async () => {
    const createdAt = Date.now();
    const anchor = expectedAnchor(createdAt, 5, 20, 0);
    const endDate = anchor + 14 * DAY_MS; // on-grid: the third weekly slot
    const { seriesId } = await seedSeries({
      createdAt, updatedAt: createdAt, recurrence: { weekday: 5, hour: 20, minute: 0, cadence: "weekly", endDate },
    });

    await runDailySweep(anchor);
    const occs = await occurrencesFor(seriesId);
    expect(occs.map((d) => d.data().startsAt)).toEqual([anchor, anchor + 7 * DAY_MS, anchor + 14 * DAY_MS]);
    const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
    expect(series.materializedThrough).toBe(endDate + 1);
    expect(series.status).toBe("active"); // endDate is still ahead of `now`

    // A later run past the end date creates nothing more and ends the series.
    const report = await runDailySweep(endDate + DAY_MS);
    expect((await occurrencesFor(seriesId)).length).toBe(3);
    expect((await adb.doc(`gigSeries/${seriesId}`).get()).data()?.status).toBe("ended");
    expect(report.seriesEnded).toBeGreaterThanOrEqual(1);
  });

  it("SP10 Task 23 (sp3 #5): an active series whose endDate has passed is flipped to ended and materializes nothing", async () => {
    const now = Date.now();
    const createdAt = now - 70 * DAY_MS;
    const { seriesId } = await seedSeries({
      createdAt, updatedAt: createdAt, materializedThrough: now - 8 * DAY_MS,
      recurrence: { weekday: 5, hour: 20, minute: 0, cadence: "weekly", endDate: now - 3 * DAY_MS },
    });

    const report = await runDailySweep(now);

    const series = (await adb.doc(`gigSeries/${seriesId}`).get()).data() as GigSeriesDoc;
    expect(series.status).toBe("ended");
    expect(series.updatedAt).toBe(now);
    expect(await occurrencesFor(seriesId)).toHaveLength(0);
    expect(report.seriesEnded).toBeGreaterThanOrEqual(1);
  });
```

- [ ] **Step 2: Propagation tests in `functions/test/gigSeries.test.ts`**

After the F2 case (line 274):

```ts
  it("SP10 Task 23 (sp3 #10): propagation SKIPS taken_down and cancelled occurrences; a draft sibling still updates", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("usmod", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    const takenDownId = await seedOccurrence(seriesId, profileId, { status: "taken_down", title: "Taken down original" });
    const cancelledId = await seedOccurrence(seriesId, profileId, { status: "cancelled", title: "Cancelled original" });
    const draftId = await seedOccurrence(seriesId, profileId, { status: "draft", title: "Draft original" });
    await callFn("updateSeries", { seriesId, ...seriesContent({ title: "Propagated Title" }) }, owner.user);
    expect((await adb.doc(`gigs/${takenDownId}`).get()).data()?.title).toBe("Taken down original");
    expect((await adb.doc(`gigs/${cancelledId}`).get()).data()?.title).toBe("Cancelled original");
    expect((await adb.doc(`gigs/${draftId}`).get()).data()?.title).toBe("Propagated Title");
  });

  it("SP10 Task 23: propagation restamps fillMode on an open occurrence", async () => {
    const { owner, profileId } = await makeApprovedCuratorProfile("usfill", "venue");
    const seriesId = await createSeries(profileId, owner.user);
    const openId = await seedOccurrence(seriesId, profileId);
    await callFn("updateSeries", { seriesId, ...seriesContent({ fillMode: "whole_run" }) }, owner.user);
    expect((await adb.doc(`gigs/${openId}`).get()).data()?.fillMode).toBe("whole_run");
  });
```

- [ ] **Step 3: Run `test/scheduled.test.ts` and `test/gigSeries.test.ts`**

Expected: the updated endDate case fails (`materializedThrough` is `endDate`); the on-grid case fails with only two occurrences; the past-endDate case fails on `status` (`active`) and compiles only after `seriesEnded` exists on `SweepReport` (cast to see the behavioral failure first); the moderation case fails on the taken-down and cancelled titles being overwritten; the fillMode case fails with `undefined`.

- [ ] **Step 4: Materializer changes in `functions/src/scheduled.ts`**

Replace the comment block at lines 93-98 and the `windowEnd` computation (lines 101-104) inside `computeOccurrences`:

```ts
// Pure planning function (no I/O): computes which occurrence startsAt
// values fall newly inside the [materializedThrough, windowEnd) slice, plus
// the watermark to advance to. The rolling window end is exclusive: an
// occurrence exactly AT now+SERIES_MATERIALIZE_WEEKS is left for the
// following day's run. recurrence.endDate is INCLUSIVE (SP10 Task 23, sp3
// #11): it is the last instant an occurrence may start, so the exclusive
// edge it imposes is endDate + 1. Both forms submit the end-of-day instant
// in LAUNCH_TIMEZONE for the chosen calendar date.
function computeOccurrences(series: GigSeriesDoc, now: number): MaterializePlan {
  const step = CADENCE_STEP_MS[series.recurrence.cadence];
  const rawWindowEnd = now + SERIES_MATERIALIZE_WEEKS * 7 * DAY_MS;
  const windowEnd = series.recurrence.endDate != null
    ? Math.min(rawWindowEnd, series.recurrence.endDate + 1)
    : rawWindowEnd;
```

In `SweepReport` add after `seriesSelfHealed: number;`:

```ts
  // SP10 Task 23, step 1: active series whose recurrence.endDate had passed
  // at this run's `now`, flipped to "ended" (sp3 #5).
  seriesEnded: number;
```

and `seriesEnded: 0,` in the initializer beside `seriesSelfHealed: 0,`.

In step 1, right after `const series = seriesDoc.data() as GigSeriesDoc;` (line 336) and before the `computeOccurrences` call, add:

```ts
          // SP10 Task 23 (sp3 #5): a series past its inclusive endDate has no
          // date left to create; it stops counting against
          // MAX_ACTIVE_SERIES_PER_PROFILE and stops costing a scan. The flip
          // re-checks status transactionally (same TOCTOU concern as the
          // freshSnap re-read below) so it never overwrites a curator's own
          // pause/end that landed between the page scan and this write. Any
          // still-linked run booking resolves through step 7 as usual: every
          // one of its dates has already started.
          if (series.recurrence.endDate != null && series.recurrence.endDate <= now) {
            const ended = await db.runTransaction(async (tx) => {
              const fresh = (await tx.get(seriesDoc.ref)).data() as GigSeriesDoc | undefined;
              if (fresh?.status !== "active") return false;
              tx.update(seriesDoc.ref, { status: "ended", updatedAt: now });
              return true;
            });
            if (ended) report.seriesEnded++; else report.seriesSkippedRace++;
            continue;
          }
```

- [ ] **Step 5: Propagation in `functions/src/gigSeries.ts`**

Replace lines 262-269 (the `occStatus` check and the `batch.update` call) with:

```ts
    // F2 (security audit wave): a FILLED or CLOSED occurrence is a booked,
    // contract-locked date. SP10 Task 23 (sp3 #10): a TAKEN_DOWN or
    // CANCELLED one is moderation/curator history and must not be rewritten
    // either. Only a still-fillable occurrence follows the template.
    const occStatus = doc.data().status as GigStatus;
    if (occStatus !== "open" && occStatus !== "draft") continue;
    batch.update(doc.ref, {
      title: template.title, description: template.description, wants: template.wants,
      budget: template.budget, durationMinutes: template.durationMinutes, provisions: template.provisions,
      location: template.location, fillMode: input.fillMode, updatedAt: now,
    });
```

- [ ] **Step 6: Run `pnpm typecheck`, then `test/scheduled.test.ts` and `test/gigSeries.test.ts`**

Expected: all pass. The pre-existing materialization cases are unaffected: with `endDate: null` nothing changes, and the weekly/biweekly/monthly counts use the rolling window only.

- [ ] **Step 7: Commit**

```
fix(functions): auto-end series past endDate, inclusive end date, propagation skips taken_down and cancelled dates
```

---

### Task 24: Config and ops: env-driven Firebase config, `.env.example`, seed scripts take a project id, scheduler retries and time zone, webhook timeout

**Files:**
- Create: `apps/web/src/lib/firebaseConfig.ts`
- Modify: `apps/web/src/lib/firebase.ts` (lines 8-16), `apps/web/src/lib/firebase-server.ts` (lines 5-14)
- Modify: `apps/mobile/src/lib/firebase.ts` (lines 18-26)
- Create: `apps/web/.env.example`, `apps/mobile/.env.example`
- Modify: `.gitignore` (the `.env*` line)
- Create: `scripts/projectId.ts`
- Modify: `scripts/seed-admin.ts` (lines 1-11), `scripts/seed-test-accounts.ts` (lines 28-33 and the usage comment 7-11)
- Modify: `functions/src/scheduled.ts` (`dailySweep` export 965-968), `functions/src/paymentsSweep.ts` (`paymentsSweep` export 1631-1634), `functions/src/paymentsWebhook.ts` (`stripeWebhook` options 169-170)
- Create: `functions/test/functionOptions.test.ts`

**Interfaces:**
- Consumes: `LAUNCH_TIMEZONE` from `@gatekeep/shared` (`types.ts:316`); firebase-functions 6.6.0 `ScheduleOptions.retryCount` / `timeZone` and the `__endpoint` manifest every v2 function exposes (`scheduleTrigger.retryConfig.retryCount`, `scheduleTrigger.timeZone`, `timeoutSeconds`).
- Produces:
  - Web: `firebaseConfig` read from `NEXT_PUBLIC_FIREBASE_API_KEY`, `_AUTH_DOMAIN`, `_PROJECT_ID`, `_STORAGE_BUCKET`, `_MESSAGING_SENDER_ID`, `_APP_ID`, each falling back to today's dev value when unset or empty. Mobile: the same six as `EXPO_PUBLIC_FIREBASE_*`.
  - `scripts/projectId.ts`: `resolveProjectId(argv: string[]): string` (order: `--project <id>` argument, `GCLOUD_PROJECT`, `project_id` in the `GOOGLE_APPLICATION_CREDENTIALS` file, then `gatekeep-dev-jg` only when an emulator host is set; otherwise print an explanation and exit 1) and `stripProjectFlag(argv: string[]): string[]`.
  - `dailySweep`: `{ schedule: "every day 09:00", timeZone: LAUNCH_TIMEZONE, retryCount: 3, ... }`; `paymentsSweep`: `retryCount: 3`; `stripeWebhook`: `timeoutSeconds: 120`.

- [ ] **Step 1: Write `functions/test/functionOptions.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { LAUNCH_TIMEZONE } from "@gatekeep/shared";
import { dailySweep } from "../src/scheduled.js";
import { paymentsSweep, ticketOrderExpiry } from "../src/paymentsSweep.js";
import { stripeWebhook } from "../src/paymentsWebhook.js";

// SP10 Task 24 (cross-cutting #17): deploy options are data on the function
// object (firebase-functions' __endpoint manifest), so the rulings are
// pinned here instead of trusted to a code-review glance. Pure: no emulator.
describe("deployed function options (SP10 Task 24)", () => {
  it("dailySweep retries 3 times and runs its 09:00 slot in LAUNCH_TIMEZONE", () => {
    const trigger = dailySweep.__endpoint.scheduleTrigger;
    expect(trigger?.schedule).toBe("every day 09:00");
    expect(trigger?.timeZone).toBe(LAUNCH_TIMEZONE);
    expect(trigger?.retryConfig?.retryCount).toBe(3);
  });

  it("paymentsSweep and ticketOrderExpiry retry 3 times", () => {
    expect(paymentsSweep.__endpoint.scheduleTrigger?.retryConfig?.retryCount).toBe(3);
    expect(ticketOrderExpiry.__endpoint.scheduleTrigger?.schedule).toBe("every 5 minutes");
    expect(ticketOrderExpiry.__endpoint.scheduleTrigger?.retryConfig?.retryCount).toBe(3);
  });

  it("stripeWebhook has a 120 s timeout", () => {
    expect(stripeWebhook.__endpoint.timeoutSeconds).toBe(120);
  });
});
```

- [ ] **Step 2: Run `pnpm --filter functions exec vitest run test/functionOptions.test.ts`**

Expected: the dailySweep case fails (`timeZone` undefined, `retryCount` undefined); the paymentsSweep case fails on its `retryCount`; the webhook case fails (`timeoutSeconds` undefined, the 60 s platform default is not written into the manifest).

- [ ] **Step 3: Function options**

`functions/src/scheduled.ts` lines 965-968 (extend the shared import with `LAUNCH_TIMEZONE` if Task 20 has not already):

```ts
// SP10 Task 24 (cross-cutting #17): 09:00 in LAUNCH_TIMEZONE is the launch
// metro's morning, not 09:00 UTC; retryCount 3 means a transient failure
// no longer costs a whole materialization day.
export const dailySweep = onSchedule(
  {
    schedule: "every day 09:00", timeZone: LAUNCH_TIMEZONE, region: "us-central1",
    timeoutSeconds: 540, memory: "512MiB", retryCount: 3,
  },
  async () => { await runDailySweep(Date.now()); },
);
```

`functions/src/paymentsSweep.ts` lines 1631-1634:

```ts
export const paymentsSweep = onSchedule(
  {
    schedule: "every 1 hours", region: "us-central1", timeoutSeconds: 540, memory: "512MiB",
    retryCount: 3, secrets: [stripeSecretKey],
  },
  async () => { await runPaymentsSweep(Date.now()); },
);
```

`functions/src/paymentsWebhook.ts` lines 169-170:

```ts
export const stripeWebhook = onRequest(
  // SP10 Task 24: a webhook delivery that finalizes a ticket order or a
  // settlement can wait on several Firestore transactions; 60 s was the
  // platform default, not a decision.
  { region: "us-central1", timeoutSeconds: 120, secrets: [stripeSecretKey, stripeWebhookSecret] },
```

- [ ] **Step 4: Run the options test again**

Expected: all three pass.

- [ ] **Step 5: Web config**

Create `apps/web/src/lib/firebaseConfig.ts`:

```ts
// Public web-app config from Firebase console, Project settings, Your apps.
// These values are NOT secrets; security comes from rules + App Check.
//
// SP10 Task 24 (cross-cutting #7): every value reads NEXT_PUBLIC_FIREBASE_*
// first so a production build can target another project without a code
// change; the dev project is the documented default (apps/web/.env.example).
// An empty string counts as unset so a blank line in .env cannot blank a
// field. No "use client" here: plain constants, safe for RSC imports.
const pick = (value: string | undefined, fallback: string): string =>
  value !== undefined && value.length > 0 ? value : fallback;

export const firebaseConfig = {
  apiKey: pick(process.env.NEXT_PUBLIC_FIREBASE_API_KEY, "AIzaSyCj3Q8__Tmu4B-UCE1fTMZxK31L9Cq_NqU"),
  authDomain: pick(process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, "gatekeep-dev-jg.firebaseapp.com"),
  projectId: pick(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID, "gatekeep-dev-jg"),
  storageBucket: pick(process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET, "gatekeep-dev-jg.firebasestorage.app"),
  messagingSenderId: pick(process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID, "894446689930"),
  appId: pick(process.env.NEXT_PUBLIC_FIREBASE_APP_ID, "1:894446689930:web:20531390a23a3804b05773"),
};
```

In `apps/web/src/lib/firebase.ts` delete lines 8-16 (the comment and the `firebaseConfig` literal) and add `import { firebaseConfig } from "./firebaseConfig";` after the existing imports. In `apps/web/src/lib/firebase-server.ts` delete lines 8-14 (the literal only; keep the RSC comment at 5-7) and add the same import.

Create `apps/web/.env.example`:

```
# Firebase web app (public values; security comes from rules and App Check).
# Unset or empty means the dev project gatekeep-dev-jg (src/lib/firebaseConfig.ts).
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=

# App Check (reCAPTCHA v3 site key); production only, unset disables App Check.
NEXT_PUBLIC_RECAPTCHA_SITE_KEY=
# Stripe publishable key; unset runs the keyless emulator checkout.
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
# Canonical site origin for metadata and share links.
NEXT_PUBLIC_SITE_URL=
# Set to 1 to point a production build (next start) at the local emulators.
FIREBASE_EMULATORS=
```

- [ ] **Step 6: Mobile config**

`apps/mobile/src/lib/firebase.ts` lines 18-26:

```ts
// Public web-app config from Firebase console, Project settings, Your apps.
// These values are NOT secrets; security comes from rules + App Check.
// SP10 Task 24 (cross-cutting #7): EXPO_PUBLIC_FIREBASE_* overrides each
// value at bundle time; the dev project is the default (.env.example).
// Literal process.env.EXPO_PUBLIC_* accesses only: Metro inlines those.
const pick = (value: string | undefined, fallback: string): string =>
  value !== undefined && value.length > 0 ? value : fallback;

const firebaseConfig = {
  apiKey: pick(process.env.EXPO_PUBLIC_FIREBASE_API_KEY, "AIzaSyCj3Q8__Tmu4B-UCE1fTMZxK31L9Cq_NqU"),
  authDomain: pick(process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN, "gatekeep-dev-jg.firebaseapp.com"),
  projectId: pick(process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID, "gatekeep-dev-jg"),
  storageBucket: pick(process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET, "gatekeep-dev-jg.firebasestorage.app"),
  messagingSenderId: pick(process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID, "894446689930"),
  appId: pick(process.env.EXPO_PUBLIC_FIREBASE_APP_ID, "1:894446689930:web:20531390a23a3804b05773"),
};
```

Create `apps/mobile/.env.example`:

```
# Firebase app (public values; security comes from rules and App Check).
# Unset or empty means the dev project gatekeep-dev-jg (src/lib/firebase.ts).
EXPO_PUBLIC_FIREBASE_API_KEY=
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=
EXPO_PUBLIC_FIREBASE_PROJECT_ID=
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
EXPO_PUBLIC_FIREBASE_APP_ID=

# Stripe publishable key; unset runs the keyless emulator PaymentSheet.
EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY=
# Sentry DSN; unset disables Sentry.
EXPO_PUBLIC_SENTRY_DSN=
```

`.gitignore`: replace the `.env*` line with:

```
.env*
!.env.example
```

- [ ] **Step 7: Seed scripts**

Create `scripts/projectId.ts`:

```ts
// SP10 Task 24 (cross-cutting #7, #27): the seed scripts used to hardcode the
// dev project id. Resolution order: an explicit --project argument, then
// GCLOUD_PROJECT, then the project_id inside the GOOGLE_APPLICATION_CREDENTIALS
// file, then the dev project ONLY when an emulator host is set (the emulator
// project id must match firebase.json). Anything else refuses, so a real
// project is never written to by accident.
import { readFileSync } from "node:fs";

const DEV_PROJECT_ID = "gatekeep-dev-jg";

export function stripProjectFlag(argv: string[]): string[] {
  const i = argv.indexOf("--project");
  if (i < 0) return argv;
  return [...argv.slice(0, i), ...argv.slice(i + 2)];
}

export function resolveProjectId(argv: string[]): string {
  const i = argv.indexOf("--project");
  const fromArg = i >= 0 ? argv[i + 1] : undefined;
  if (fromArg) return fromArg;
  if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credsPath) {
    const creds = JSON.parse(readFileSync(credsPath, "utf8")) as { project_id?: unknown };
    if (typeof creds.project_id === "string" && creds.project_id.length > 0) return creds.project_id;
  }
  const inEmulator = !!process.env.FIREBASE_AUTH_EMULATOR_HOST || !!process.env.FIRESTORE_EMULATOR_HOST;
  if (inEmulator) return DEV_PROJECT_ID;
  console.error(
    "Refusing: no project id. Pass --project <id>, set GCLOUD_PROJECT, or point GOOGLE_APPLICATION_CREDENTIALS at a service-account file.");
  process.exit(1);
}
```

`scripts/seed-admin.ts` lines 1-11 become:

```ts
// Usage: pnpm tsx scripts/seed-admin.ts someone@example.com [--project <id>]
// Spec section 8: admin accounts must be Google sign-in accounts (inherits Google 2FA).
// Only seed emails that signed up with "Continue with Google".
// Against emulator: FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 pnpm tsx scripts/seed-admin.ts ...
// Against a real project: GOOGLE_APPLICATION_CREDENTIALS=<service-account.json> pnpm tsx scripts/seed-admin.ts ...
//   (the project id comes from --project, GCLOUD_PROJECT, or the credentials file, in that order)
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { resolveProjectId, stripProjectFlag } from "./projectId.js";

const args = stripProjectFlag(process.argv.slice(2));
const email = args[0];
if (!email) { console.error("Usage: seed-admin.ts <email> [--project <id>]"); process.exit(1); }
const projectId = resolveProjectId(process.argv);
console.log(`project: ${projectId}`);
const app = getApps()[0] ?? initializeApp({ projectId });
```

(The rest of the file is unchanged. Check how `scripts/` resolves sibling imports under `tsx`: if the existing scripts import each other with a `.js` suffix keep it, otherwise use `"./projectId"`; today no script imports another, so follow `functions/`' NodeNext convention with `.js`.)

`scripts/seed-test-accounts.ts` lines 28-33 become:

```ts
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth, type UserRecord } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { resolveProjectId } from "./projectId.js";

const PASSWORD = "GateKeep-Test1";
const projectId = resolveProjectId(process.argv);
console.log(`project: ${projectId}`);
const app = getApps()[0] ?? initializeApp({ projectId });
const auth = getAuth(app);
const db = getFirestore(app);
```

and line 10's usage comment becomes `// Usage (a real project; id from --project, GCLOUD_PROJECT, or the credentials file):`.

- [ ] **Step 8: Gate**

Run, from the repo root:

- `pnpm typecheck` (5/5)
- `pnpm --filter @gatekeep/web lint` and `pnpm --filter @gatekeep/web build`
- `pnpm --filter @gatekeep/mobile lint`
- `FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm tsx scripts/seed-test-accounts.ts` against a running `pnpm emu` (expect the first line `project: gatekeep-dev-jg`), and `pnpm tsx scripts/seed-admin.ts nobody@example.com` with no env set (expect the refusal line and exit 1)
- `pnpm emu:test` (full functions suite, including every file touched in Tasks 17 to 24)
- `pnpm --filter @gatekeep/shared test`

Expected: all green; the web `build` confirms `NEXT_PUBLIC_FIREBASE_*` inlining compiles with no env file present.

- [ ] **Step 9: Commit**

```
chore: env-driven Firebase config with dev defaults, .env.example files, seed scripts take a project id, scheduler retries and time zone, webhook timeout
```

---

### Task 25: Find-musicians guards on both grids

**Files:**
- Modify: `apps/web/src/bookings/BookingForms.tsx` (lines 3 to 6 import, after line 41: add `formatReliabilityLine`)
- Modify: `apps/mobile/src/bookings/BookingForms.tsx` (lines 2 to 5 import, after line 27: add `formatReliabilityLine`)
- Modify: `apps/web/src/bookings/MusicianBrowse.tsx` (line 6 import, lines 69 to 82 guarded reads)
- Modify: `apps/mobile/src/bookings/MusicianBrowse.tsx` (lines 7 and 9 imports, 32 to 40 `RatesSummary`, 179 to 190 card body)
- Test: web live load of `/dashboard/curator/[profileId]/musicians` against a summary-only projection
  doc; mobile typecheck, lint, export

**Interfaces:**
- Consumes: `CuratorBookingDoc`, `BookingRates`, `ReliabilitySummary` from `@gatekeep/shared` (unchanged
  shapes; the seeding fix in section B3 makes new docs complete, this task makes the clients
  tolerate the old ones).
- Produces: `formatReliabilityLine(r: ReliabilitySummary | undefined): string` exported from both
  `BookingForms.tsx` files (Task 32's inbox rows and thread headers reuse it), and
  `NULL_RATES: BookingRates` exported from the mobile browse.

**Steps:**

- [ ] **Step 1: Reproduce the crash.** With the emulators running and `test-curator` signed in on web,
  write a summary-only projection for an approved musician profile id `<mid>` through the Firestore
  emulator REST surface (the `owner` bearer bypasses rules):

```bash
curl -s -X PATCH \
  "http://localhost:8080/v1/projects/gatekeep-dev-jg/databases/(default)/documents/profiles/<mid>/private/curatorBooking" \
  -H "Authorization: Bearer owner" -H "Content-Type: application/json" \
  -d '{"fields":{"reliability":{"mapValue":{"fields":{"noShowCount":{"integerValue":"0"},"completedCount":{"integerValue":"1"}}}},"updatedAt":{"integerValue":"1756800000000"}}}'
```

  Load `/dashboard/curator/<curatorProfileId>/musicians`. Expected before the fix: the route falls to
  the Next error boundary with `TypeError: Cannot read properties of undefined (reading
  'availabilityPattern')` from web `MusicianBrowse.tsx:73`. On mobile the Find musicians tab
  red-boxes inside `RatesSummary` (`rates[k]` on undefined, `MusicianBrowse.tsx:36`).

- [ ] **Step 2: Shared reliability formatter (web).** In `apps/web/src/bookings/BookingForms.tsx`
  extend the shared import (lines 3 to 6):

```ts
import {
  validateOfferInput, LAUNCH_TIMEZONE, MAX_OFFER_NOTE_LENGTH, MAX_OFFER_SONG_COUNT, DEPOSIT_PERCENT,
  type BudgetStructure, type ReliabilitySummary,
} from "@gatekeep/shared";
```

  and add after the `DEPOSIT_HONESTY_LINE` block (line 41):

```ts
// The curator-facing reliability sentence, one definition for every surface
// that renders it (Find musicians cards today; Task 32 adds the inbox rows and
// the thread header). Counts BOOKINGS, not dates: an 8-date completed
// whole-run booking is +1 (ReliabilitySummary.completedCount is
// booking-scoped, see functions/src/bookingLifecycle.ts's
// recomputeReliability). Tolerates a projection with no reliability block:
// pre-section-B3 recomputeReliability wrote summary-only docs, and
// rebuildBookingProjections used to delete and recreate without one.
export function formatReliabilityLine(r: ReliabilitySummary | undefined): string {
  const completed = r?.completedCount ?? 0;
  const noShows = r?.noShowCount ?? 0;
  return `${completed} show${completed === 1 ? "" : "s"} played · ${noShows} no-show${noShows === 1 ? "" : "s"}`;
}
```

- [ ] **Step 3: Same formatter on mobile.** In `apps/mobile/src/bookings/BookingForms.tsx` add
  `type ReliabilitySummary` to the shared import (lines 2 to 5) and the identical function after
  `DEPOSIT_HONESTY_LINE` (line 27). Mobile's card wording today is `"{n} no-shows / {m} bookings"`;
  it moves to the `"N shows played · M no-shows"` sentence web already renders, so both platforms
  read the metric identically.

- [ ] **Step 4: Guard the web grid.** In `apps/web/src/bookings/MusicianBrowse.tsx` add at line 6:

```ts
import { formatReliabilityLine } from "./BookingForms";
```

  and replace lines 69 to 82 with:

```tsx
  // Availability + reliability: rendered only from data this card already
  // fetched above, never a price (rates are private by SP4 rule and the
  // locked card spec is explicit: NEVER a price on this card). Both reads are
  // optional-chained: recomputeReliability can create this projection with
  // reliability alone (no rates, no preferences) for a musician who never
  // opened the booking-info editor, and rebuildBookingProjections used to
  // delete the doc outright (sp4 audit finding 1).
  const availabilityLabel = booking && booking !== "loading" && booking.preferences?.availabilityPattern
    ? formatChipLabel(booking.preferences.availabilityPattern)
    : null;
  const reliabilityLine = booking && booking !== "loading"
    ? formatReliabilityLine(booking.reliability)
    : null;
```

- [ ] **Step 5: Guard the mobile grid.** In `apps/mobile/src/bookings/MusicianBrowse.tsx`:
  - line 7: add `type BookingRates` to the shared import;
  - line 9: add `formatReliabilityLine` to the `./BookingForms` import;
  - replace lines 32 to 40 with:

```tsx
const RATE_STRUCTURES: BudgetStructure[] = ["perHour", "perSong", "perSet"];
// A projection with no rates block at all (summary-only doc, sp4 audit
// finding 1) renders exactly like a musician who set none: "No public rates."
export const NULL_RATES: BookingRates = { perHour: null, perSong: null, perSet: null };

function RatesSummary({ rates }: { rates: BookingRates }) {
  const parts = RATE_STRUCTURES
    .map((k) => (rates[k] ? `${formatCents(rates[k]!.amountCents)} ${BUDGET_STRUCTURE_LABEL[k]}` : null))
    .filter((p): p is string => p !== null);
  if (parts.length === 0) return <Text variant="meta" muted>No public rates.</Text>;
  return <Text variant="meta">{parts.join(" · ")}</Text>;
}
```

  - replace lines 179 to 190 (the loaded branch of the card body) with:

```tsx
        {booking === "loading" ? (
          <Skeleton height={14} width="55%" />
        ) : booking ? (
          <>
            <RatesSummary rates={booking.rates ?? NULL_RATES} />
            {booking.preferences?.availabilityPattern && (
              <Text variant="meta" muted>{booking.preferences.availabilityPattern}</Text>
            )}
            <Text variant="meta" muted>{formatReliabilityLine(booking.reliability)}</Text>
          </>
        ) : (
          <Text variant="meta" muted>No booking info shared yet.</Text>
        )}
```

- [ ] **Step 6: Gates.** `pnpm typecheck` (5/5), `pnpm --filter @gatekeep/web lint`,
  `pnpm --filter @gatekeep/web build`, `pnpm --filter @gatekeep/mobile lint`,
  `pnpm --filter @gatekeep/mobile exec expo export --platform ios`. Live: reload
  `/dashboard/curator/<curatorProfileId>/musicians` with the Step 1 doc still in place. Expected:
  the grid renders, the seeded card shows "1 show played · 0 no-shows" and no availability line.
  Delete the seeded doc afterwards (`curl -X DELETE` on the same URL with the same header).

- [ ] **Step 7: Commit.** `fix(clients): tolerate summary-only curatorBooking projections on Find musicians`

---

### Task 26: Booking visibility toggle on both portfolio editors

**Files:**
- Modify: `apps/web/src/portfolio/PortfolioForms.tsx` (line 12 import, 332 to 339 stopgap block,
  after 361 state, 364 to 387 rate row, 402 to 405 save input, 419 to 421 copy, after 442 preferences
  visibility block)
- Modify: `apps/mobile/src/portfolio/PortfolioForms.tsx` (line 13 import, 231 to 238 stopgap block,
  after 243 `TogglePill`, after 257 state, 266 to 279 rate row, 292 to 295 save input, 306 copy,
  after 315 preferences visibility block)
- Test: web live load of `/dashboard/portfolio/[profileId]` then `/@[handle]`; mobile typecheck,
  lint, export

**Interfaces:**
- Consumes: `BookingVisibility` from `@gatekeep/shared`, `validateBookingUpdate` (already validates
  `visibility` at `packages/shared/src/validation.ts:203`), the existing `updateBookingInfo`
  callable's `visibility` field (unchanged), `Switch` from `apps/web/src/ui/switch.tsx`, `Button`
  from `apps/mobile/src/ui/Button.tsx`.
- Produces: four controls per editor (three rate switches or pills, one preferences pair). Saves
  send `visibility` from state. `DEFAULT_BOOKING_VISIBILITY` and the "SP4 Task 1 stopgap" comments
  are gone from both files.

**Steps:**

- [ ] **Step 1: Web state and imports.** In `apps/web/src/portfolio/PortfolioForms.tsx`:
  - line 12: add `import { Switch } from "../ui/switch";`
  - delete lines 332 to 339 (the stopgap comment and `DEFAULT_BOOKING_VISIBILITY`).
  - after the `prefs` state (line 361) add:

```ts
  // Seeded once from the stored doc. A doc with no visibility block is a
  // pre-SP4 doc the backfill has not converged yet; BookingDoc.visibility's
  // own comment defines that case as "every rate curators, preferences
  // curators", which is the literal below. Rates can never be public (spec
  // decision 4: RateVisibility has no "public" member), so each rate gets a
  // curators/private switch and only preferences gets a public option.
  const [visibility, setVisibility] = useState<BookingVisibility>(initial?.visibility ?? {
    perHour: "curators", perSong: "curators", perSet: "curators", preferences: "curators",
  });
```

- [ ] **Step 2: Web rate row gets a visibility switch.** Replace `rateField` (lines 364 to 387) with:

```tsx
  const rateField = (key: RateKey, label: string) => {
    const blank = rateInputs[key].amount.trim() === "";
    const visibleToCurators = visibility[key] === "curators";
    return (
      <div key={key} className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-28 shrink-0 font-sora text-sm font-medium text-gk-text">{label}</span>
          <div className="flex items-center gap-1.5">
            <span className="font-sora text-sm text-gk-muted">$</span>
            <Input
              type="number"
              min={0}
              step="0.01"
              className="w-24"
              value={rateInputs[key].amount}
              onChange={(e) => setRateInputs((r) => ({ ...r, [key]: { ...r[key], amount: e.target.value } }))}
            />
          </div>
          <Input
            placeholder="Note (optional)"
            maxLength={200}
            className="min-w-[160px] flex-1"
            value={rateInputs[key].note ?? ""}
            disabled={blank}
            onChange={(e) => setRateInputs((r) => ({ ...r, [key]: { ...r[key], note: e.target.value || null } }))}
          />
        </div>
        {/* min-h-11 (44px) on the label, not on the 24px switch: the label is
            the click target (label/button association), so the target meets
            the accessibility floor without inflating the control's drawing.
            Disabled while the rate is blank: an unset rate has nothing to
            show or hide. ml-31 = the w-28 label plus the gap-3 (7.75rem), so
            the switch sits under the dollar input, not under the row label. */}
        <label className="ml-31 flex min-h-11 w-fit cursor-pointer items-center gap-2 font-sora text-xs text-gk-muted">
          <Switch
            checked={visibleToCurators}
            disabled={blank}
            aria-label={`${label} rate visibility`}
            onCheckedChange={(on) => setVisibility((v) => ({ ...v, [key]: on ? "curators" : "private" }))}
          />
          {visibleToCurators ? "Visible to curators" : "Private"}
        </label>
      </div>
    );
  };
```

- [ ] **Step 3: Web preferences control, copy, and save.** Replace lines 419 to 421 with:

```tsx
        <p className="font-sora text-sm text-gk-muted">
          Rates never appear on your public page: each one is visible to curators or private.
          Preferences can be public or curators only. Offer any mix of the three.
        </p>
```

  Insert directly after the "Gig preferences" chips block (after line 442):

```tsx
        <div className="grid gap-2">
          <span className="font-sora text-sm font-medium text-gk-text">Who sees your preferences</span>
          <div className="flex flex-wrap gap-2">
            <Chip active={visibility.preferences === "public"}
              onClick={() => setVisibility((v) => ({ ...v, preferences: "public" }))}>
              Public
            </Chip>
            <Chip active={visibility.preferences === "curators"}
              onClick={() => setVisibility((v) => ({ ...v, preferences: "curators" }))}>
              Curators only
            </Chip>
          </div>
          <span className="font-sora text-xs text-gk-muted">
            Public puts gig types, act size, and availability on your public page. Curators only keeps them inside Find musicians.
          </span>
        </div>
```

  and change the save input (lines 402 to 405) to:

```ts
    const input = { profileId, rates, preferences: prefs, visibility };
```

- [ ] **Step 4: Mobile.** In `apps/mobile/src/portfolio/PortfolioForms.tsx`:
  - line 13: add `import { tokens } from "../theme/tokens";`
  - delete lines 231 to 238 (stopgap comment and `DEFAULT_BOOKING_VISIBILITY`);
  - after `DEFAULT_PREFS` (line 243) add a 44px toggle pill built on the Button primitive (mobile
    has no Switch, and `Chip`'s 32px height is a recorded out-of-scope antislop finding, so the new
    control is built on `Button`, whose `minHeight: 44` is the floor):

```tsx
// A two-state pill for the visibility controls below: the "default" (ember
// pill) Button variant when active, "secondary" (outlined) when not, forced
// to the pill radius, exactly the web Chip's Button-based construction.
function TogglePill({ label, active, onPress, disabled }: {
  label: string; active: boolean; onPress: () => void; disabled?: boolean;
}) {
  return (
    <Button
      title={label}
      variant={active ? "default" : "secondary"}
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ selected: active, disabled: Boolean(disabled) }}
      style={{ borderRadius: tokens.radius.pill, paddingHorizontal: 14 }}
    />
  );
}
```

  - after the `prefs` state (line 257) add:

```ts
  // Same seed rule as web (see that file's comment): a doc with no visibility
  // block is the backfill default, all curators.
  const [visibility, setVisibility] = useState<BookingVisibility>(initial?.visibility ?? {
    perHour: "curators", perSong: "curators", perSet: "curators", preferences: "curators",
  });
```

  - replace `rateRow` (lines 266 to 279) with:

```tsx
  const rateRow = (key: RateKey, label: string) => {
    const blank = rateInputs[key].amount.trim() === "";
    return (
      <View key={key} style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Text style={{ width: 100 }}>{label}</Text>
          <Text>$</Text>
          <Input keyboardType="decimal-pad" placeholder="-"
            value={rateInputs[key].amount}
            onChangeText={(t) => setRateInputs((r) => ({ ...r, [key]: { ...r[key], amount: t } }))}
            style={{ width: 90 }} />
          <Input placeholder="note (optional)" maxLength={200} editable={!blank}
            value={rateInputs[key].note ?? ""}
            onChangeText={(t) => setRateInputs((r) => ({ ...r, [key]: { ...r[key], note: t || null } }))}
            style={{ flex: 1 }} />
        </View>
        <View style={{ flexDirection: "row", gap: 6, marginLeft: 108 }}>
          <TogglePill label="Visible to curators" active={visibility[key] === "curators"} disabled={blank}
            onPress={() => setVisibility((v) => ({ ...v, [key]: "curators" }))} />
          <TogglePill label="Private" active={visibility[key] === "private"} disabled={blank}
            onPress={() => setVisibility((v) => ({ ...v, [key]: "private" }))} />
        </View>
      </View>
    );
  };
```

  - change the save input (lines 292 to 295) to `const input = { profileId, rates, preferences: prefs, visibility };`
  - replace the intro copy (line 306) with:

```tsx
      <Text muted>
        Rates never appear on your public page: each one is visible to curators or private.
        Preferences can be public or curators only. Offer any mix of the three.
      </Text>
```

  - after the "Gig types" chip row (line 315) add:

```tsx
      <Text variant="label">Who sees your preferences</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <TogglePill label="Public" active={visibility.preferences === "public"}
          onPress={() => setVisibility((v) => ({ ...v, preferences: "public" }))} />
        <TogglePill label="Curators only" active={visibility.preferences === "curators"}
          onPress={() => setVisibility((v) => ({ ...v, preferences: "curators" }))} />
      </View>
      <Text variant="meta" muted>
        Public puts gig types, act size, and availability on your public page. Curators only keeps them inside Find musicians.
      </Text>
```

- [ ] **Step 5: Gates and live check.** Typecheck, both lints, web build, mobile export. Live (web):
  sign in as `test-musician`, open `/dashboard/portfolio/<profileId>`, set "Per set" to Private and
  preferences to Public, save. In the emulator UI confirm `profiles/<id>/private/booking` carries
  `visibility.perSet == "private"` and `visibility.preferences == "public"`, and that
  `profiles/<id>.publicBooking` is now populated by the projection sync. Load `/@<handle>`: the
  "Booking preferences" section renders for the first time. Grep gate:
  `grep -rn "DEFAULT_BOOKING_VISIBILITY\|Task 1 stopgap" apps/` returns nothing.

- [ ] **Step 6: Commit.** `feat(clients): per-field booking visibility controls on both portfolio editors`

---
### Task 27: VerifyEmailBanner, callable wrapper with a verified-email retry, forced claim refresh

**Files:**
- Create: `apps/web/src/lib/callable.ts`, `apps/mobile/src/lib/callable.ts`
- Create: `apps/web/src/auth/VerifyEmailBanner.tsx`, `apps/mobile/src/auth/VerifyEmailBanner.tsx`
- Create (one-shot, deleted before the commit): `scripts/codemod-callfn.mjs`
- Modify: `apps/web/app/layout.tsx` (lines 4 to 6 imports, 75 to 77 mount)
- Modify: `apps/mobile/app/_layout.tsx` (lines 1 to 13 imports, 39 to 50 Gate hooks, 51 to 87 Gate render)
- Modify: `apps/web/app/admin/AdminGate.tsx` (line 28), `apps/web/app/dashboard/page.tsx` (line 250)
- Modify: every client file with a direct `httpsCallable(...)(...)` call (68 call sites across 56 files,
  listed by `git grep -n "httpsCallable(" -- apps/web/src apps/web/app apps/mobile/src apps/mobile/app`),
  rewritten by the codemod to `callFn`
- Test: web live loads of `/dashboard` (banner), `/gigs/[gigId]` (wrapper retry), `/admin` (claim
  refresh); mobile typecheck, lint, export

**Interfaces:**
- Consumes: `EMAIL_NOT_VERIFIED_MESSAGE` from `@gatekeep/shared` (the exact string
  `functions/src/guards.ts`'s `requireVerifiedEmail` throws under `failed-precondition`);
  `FunctionsError`, `httpsCallable`, `HttpsCallableResult` from `firebase/functions`;
  `sendEmailVerification` from `firebase/auth`; `useAuth` from each client's `AuthProvider`.
- Produces:
  - `callFn<Req, Res>(name: string, data: Req): Promise<HttpsCallableResult<Res>>` and
    `isStaleVerificationError(e: unknown): boolean` from both `lib/callable.ts` files. Same return
    shape as `httpsCallable(...)(data)`, so `const { data } = await callFn(...)` and `res.data` call
    sites do not change.
  - `VerifyEmailBanner()` on both clients: renders nothing when signed out or verified; otherwise a
    warning-tinted row with "Resend link" (60 second client cooldown) and "I've verified"
    (`user.reload()` then `user.getIdToken(true)`).

**Steps:**

- [ ] **Step 1: The web wrapper.** Create `apps/web/src/lib/callable.ts`:

```ts
import { httpsCallable, FunctionsError, type HttpsCallableResult } from "firebase/functions";
import { EMAIL_NOT_VERIFIED_MESSAGE } from "@gatekeep/shared";
import { getFirebase } from "./firebase";

// One door for every callable on this client (Task 27). Same return shape as
// httpsCallable(...)(data), so `const { data } = await callFn(...)` and
// `res.data` call sites read exactly as before the codemod rewrote them.
//
// The one behavior added: a stale email_verified claim. Every sensitive
// callable runs requireVerifiedEmail (functions/src/guards.ts), which reads
// the ID token's claim; the client's cached token only rotates hourly, so a
// user who clicked the verification link a minute ago still sends a token
// that says unverified (sp1 audit finding 5). When the server answers
// failed-precondition with exactly EMAIL_NOT_VERIFIED_MESSAGE, force a token
// refresh and retry once. Any other error, and the retry's own error, are
// rethrown untouched so every existing catch branch (=== on shared messages,
// FunctionsError.details on the scanner, GatePrompt's message matching)
// keeps working.
export function isStaleVerificationError(e: unknown): boolean {
  return e instanceof FunctionsError
    && e.code === "functions/failed-precondition"
    && e.message === EMAIL_NOT_VERIFIED_MESSAGE;
}

export async function callFn<Req = unknown, Res = unknown>(name: string, data: Req): Promise<HttpsCallableResult<Res>> {
  const { functions, auth } = getFirebase();
  const fn = httpsCallable<Req, Res>(functions, name);
  try {
    return await fn(data);
  } catch (e) {
    if (!isStaleVerificationError(e) || !auth.currentUser) throw e;
    await auth.currentUser.getIdToken(true);
    return await fn(data);
  }
}
```

- [ ] **Step 2: The mobile wrapper.** Create `apps/mobile/src/lib/callable.ts` with the identical body
  (same imports; `getFirebase` from `./firebase` returns the same `{ functions, auth }` pair, see
  `apps/mobile/src/lib/firebase.ts:53`).

- [ ] **Step 3: Sweep every direct call onto the wrapper.** Create `scripts/codemod-callfn.mjs`:

```js
// One-shot codemod (Task 27): httpsCallable<A, B>(getFirebase().functions, "name")(payload)
// becomes callFn<A, B>("name", payload); the firebase/functions import loses
// httpsCallable (other names such as FunctionsError stay); a callFn import is
// added beside the file's existing lib/firebase import. Deleted after it runs.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const files = execSync(
  'git grep -l "httpsCallable(" -- apps/web/src apps/web/app apps/mobile/src apps/mobile/app',
  { encoding: "utf8" },
).split("\n").filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith("/lib/callable.ts"));

// Generic args are optional and may span lines (BuyTicketsFlow, EarningsPanel);
// the functions instance is either getFirebase().functions or a local
// `functions` binding (app/admin/page.tsx); the name is a string literal or an
// identifier (PortfolioForms' callOrAlert passes `name`).
const CALL = /httpsCallable(<[\s\S]*?>)?\(\s*(?:getFirebase\(\)\.functions|functions),\s*("[A-Za-z]+"|[A-Za-z_$][\w$]*)\s*\)\(/g;

for (const file of files) {
  const before = readFileSync(file, "utf8");
  let src = before.replace(CALL, (_m, generics, name) => `callFn${generics ?? ""}(${name}, `);
  if (src === before) continue;
  const app = file.startsWith("apps/web/") ? "apps/web" : "apps/mobile";
  const rel = path.relative(path.dirname(file), path.join(app, "src/lib/callable")).replace(/\\/g, "/");
  const spec = rel.startsWith(".") ? rel : `./${rel}`;
  src = src.replace(/import \{([^}]*)\} from "firebase\/functions";\n/, (_m, names) => {
    const kept = names.split(",").map((s) => s.trim()).filter((s) => s && s !== "httpsCallable");
    return kept.length > 0 ? `import { ${kept.join(", ")} } from "firebase/functions";\n` : "";
  });
  src = src.replace(/(import [^\n]*from "[^"]*lib\/firebase";\n)/, `$1import { callFn } from "${spec}";\n`);
  writeFileSync(file, src);
  console.log("rewrote", file);
}
```

  Run it from the repo root: `node scripts/codemod-callfn.mjs`. Then the gate that proves the sweep
  is complete:

```bash
git grep -n "httpsCallable(" -- apps/web/src apps/web/app apps/mobile/src apps/mobile/app | grep -v "lib/callable.ts"
```

  Expected: no output. If a line remains (a call shape the regex did not cover), rewrite it by hand to
  the same `callFn(name, payload)` form. Then `pnpm typecheck` and both lints: a file whose
  `getFirebase()` destructuring became unused (`app/admin/page.tsx`'s local `functions`) is reported
  by lint; remove the dead binding. Delete `scripts/codemod-callfn.mjs` before committing.

- [ ] **Step 4: Web banner.** Create `apps/web/src/auth/VerifyEmailBanner.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { sendEmailVerification } from "firebase/auth";
import { useAuth } from "./AuthProvider";
import { Button } from "../ui/button";
import { IconWarning } from "../ui/icons";

// Shown whenever the signed-in user's email is unverified (sp1 audit
// finding 5): every booking, ticket, and gig callable refuses until it is,
// and before this banner nothing on the web client said so or offered a
// resend. Mounted once in app/layout.tsx above AppShell so it appears on
// the shell routes AND on the bare public event page, where a fan who just
// signed up from a Buy button is most likely to hit the refusal.
const RESEND_COOLDOWN_S = 60;

export function VerifyEmailBanner() {
  const { user } = useAuth();
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState<"resend" | "check" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // user.reload() mutates the Firebase User in place; AuthProvider still
  // holds the same reference, so nothing re-renders on its own. Bumped after
  // every reload so `user.emailVerified` below is re-read.
  const [, setReloadCount] = useState(0);

  // Client-side resend cooldown. The countdown runs in a timeout callback,
  // never synchronously in the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  if (!user || user.emailVerified) return null;

  const resend = async () => {
    setBusy("resend");
    setNote(null);
    try {
      await sendEmailVerification(user);
      setSecondsLeft(RESEND_COOLDOWN_S);
      setNote(`Link sent to ${user.email}.`);
    } catch (e) {
      const code = (e as { code?: string }).code;
      setNote(code === "auth/too-many-requests"
        ? "Too many tries. Wait a minute and try again."
        : "Couldn't send the link. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    setNote(null);
    try {
      await user.reload();
      // Force the ID token, not just the User: the callables read the
      // token's email_verified claim, which the hourly rotation would
      // otherwise leave stale for up to an hour after the link was clicked.
      await user.getIdToken(true);
      setReloadCount((n) => n + 1);
      if (!user.emailVerified) setNote("Still unverified. Open the link in the email first.");
    } catch {
      setNote("Couldn't check right now. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div role="status" className="border-b border-gk-warning/40 bg-gk-warning/14">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
        <p className="flex min-w-0 flex-1 items-start gap-2 font-sora text-sm text-gk-warning">
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Verify your email to book, buy tickets, or post gigs.{" "}
            {note ?? `We sent a link to ${user.email}.`}
          </span>
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="secondary" size="sm" className="min-h-11"
            onClick={resend} disabled={busy !== null || secondsLeft > 0}>
            {busy === "resend" ? "Sending…" : secondsLeft > 0 ? `Resend in ${secondsLeft}s` : "Resend link"}
          </Button>
          <Button type="button" size="sm" className="min-h-11" onClick={check} disabled={busy !== null}>
            {busy === "check" ? "Checking…" : "I've verified"}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

  Mount it in `apps/web/app/layout.tsx`: add `import { VerifyEmailBanner } from "../src/auth/VerifyEmailBanner";`
  after line 6 and change lines 75 to 77 to:

```tsx
        <AuthProvider>
          <VerifyEmailBanner />
          <AppShell>{children}</AppShell>
        </AuthProvider>
```

- [ ] **Step 5: Mobile banner.** Create `apps/mobile/src/auth/VerifyEmailBanner.tsx`:

```tsx
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sendEmailVerification } from "firebase/auth";
import { useAuth } from "./AuthProvider";
import { Text, Button, IconWarningCircle } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// RN twin of apps/web/src/auth/VerifyEmailBanner.tsx (sp1 audit finding 5).
// Mounted above the root Stack in app/_layout.tsx's Gate, so it sits over
// every signed-in screen; the top safe-area inset is applied here because
// nothing above this view pads for the status bar. 14% warning tint over the
// warning border, the same soft-tint figure Callout and StatusBadge use.
const RESEND_COOLDOWN_S = 60;

export function VerifyEmailBanner() {
  const { user } = useAuth();
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState<"resend" | "check" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [, setReloadCount] = useState(0);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  if (!user || user.emailVerified) return null;

  const resend = async () => {
    setBusy("resend");
    setNote(null);
    try {
      await sendEmailVerification(user);
      setSecondsLeft(RESEND_COOLDOWN_S);
      setNote(`Link sent to ${user.email}.`);
    } catch (e) {
      const code = (e as { code?: string }).code;
      setNote(code === "auth/too-many-requests"
        ? "Too many tries. Wait a minute and try again."
        : "Couldn't send the link. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    setNote(null);
    try {
      await user.reload();
      await user.getIdToken(true);
      setReloadCount((n) => n + 1);
      if (!user.emailVerified) setNote("Still unverified. Open the link in the email first.");
    } catch {
      setNote("Couldn't check right now. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        paddingTop: insets.top + tokens.space.sm, paddingBottom: tokens.space.sm,
        paddingHorizontal: tokens.space.lg, gap: tokens.space.sm,
        backgroundColor: t.warning + "24", borderBottomWidth: 1, borderBottomColor: t.warning,
      }}
    >
      <View style={{ flexDirection: "row", gap: tokens.space.xs, alignItems: "flex-start" }}>
        <IconWarningCircle size={18} color={t.warning} />
        <Text style={{ flex: 1 }} color={t.warning}>
          Verify your email to book, buy tickets, or post gigs. {note ?? `We sent a link to ${user.email}.`}
        </Text>
      </View>
      <View style={{ flexDirection: "row", gap: tokens.space.sm }}>
        <Button variant="secondary" onPress={() => void resend()} disabled={busy !== null || secondsLeft > 0}
          title={busy === "resend" ? "Sending…" : secondsLeft > 0 ? `Resend in ${secondsLeft}s` : "Resend link"} />
        <Button onPress={() => void check()} disabled={busy !== null}
          title={busy === "check" ? "Checking…" : "I've verified"} />
      </View>
    </View>
  );
}
```

  In `apps/mobile/app/_layout.tsx` add `import { View } from "react-native";` and
  `import { VerifyEmailBanner } from "../src/auth/VerifyEmailBanner";` to the import block (lines 1
  to 13), and wrap the Stack (lines 51 to 87) so the banner sits above it:

```tsx
  return (
    <View style={{ flex: 1 }}>
      <StatusBar style={active === "light" ? "dark" : "light"} />
      <VerifyEmailBanner />
      <Stack screenOptions={{
```

  closing the `<Stack>` with `</View>` in place of the fragment's `</>`. The banner is the only thing
  that can precede the Stack in that column, and it renders null for every verified account, so the
  verified path is pixel-identical to today. The native-stack headers derive their own top inset from
  their view's frame, not the window, so a visible banner pushes the header down without a double
  status-bar gap; confirm on the next EAS build (spec section 11 already lists the verify banner on
  the owner's smoke list).

- [ ] **Step 6: Force the claim refresh on the two admin mounts.** `apps/web/app/admin/AdminGate.tsx`
  line 28:

```ts
    user?.getIdTokenResult(true).then((t) => { if (!cancelled) setIsAdmin(t.claims.admin === true); });
```

  `apps/web/app/dashboard/page.tsx` line 250:

```ts
    user?.getIdTokenResult(true).then((t) => { if (!cancelled) setIsAdmin(t.claims.admin === true); });
```

  (sp1 audit finding 20: a freshly granted admin claim was invisible for up to an hour.)

- [ ] **Step 7: Gates and live checks.** `pnpm typecheck`, both lints, web build, mobile export. Live
  (web, emulators):
  1. Create a new account from `/sign-in`. On `/dashboard` the banner shows "Verify your email…";
     press "Resend link": the button reads "Resend in 59s" and counts down, and the emulator log prints
     a second verification link.
  2. Open that link. Without pressing "I've verified", open `/gigs/<openGigId>` and apply as an
     approved musician profile on this account (or run any verified-gated callable from the console:
     `callFn("applyToGig", ...)`). Expected: the first attempt is refused with
     `EMAIL_NOT_VERIFIED_MESSAGE`, the wrapper refreshes the token, the retry succeeds, and the UI shows
     "Application sent!". Network tab: two `applyToGig` requests, the second with a new token.
  3. Back on `/dashboard`, press "I've verified": the banner disappears with no reload.
  4. Grant the admin claim to a signed-in test account with `scripts/seed-admin.ts`, reload `/admin`:
     the page renders on the first load.

- [ ] **Step 8: Commit.** `feat(clients): verify-email banner, callable wrapper with claim-refresh retry, forced admin claim reads`

---
### Task 28: Poster picker, public poster URLs built from the path

**Files:**
- Modify: `apps/web/src/events/posterUrl.ts` (whole file, 38 lines: the `usePosterUrl` hook becomes
  the plain `posterPublicUrl` function)
- Create: `apps/web/src/events/PosterField.tsx`
- Modify: `apps/web/src/events/EventEditor.tsx` (line 14 icons import, lines 447 to 456 state,
  473 to 487 payload, after 525 a Poster card)
- Modify: `apps/web/app/e/[eventId]/page.tsx` (line 5 import, 38 to 49 `storageUrl`, 97 to 102 the
  `Promise.all`)
- Modify: `apps/web/src/events/EventsManager.tsx` (lines 10 and 75), `apps/web/app/tickets/TicketsClient.tsx` (lines 12 and 136)
- Modify: `apps/mobile/src/lib/firebase.ts` (lines 20 to 26 `STORAGE_BUCKET`, 36 `EMU_HOST` exported)
- Modify: `apps/mobile/src/events/eventDisplay.ts` (lines 1 to 5 imports, 173 to 195 poster helper)
- Modify: `apps/mobile/src/ui/icons.tsx` (two new wrapped glyphs after line 64)
- Create: `apps/mobile/src/events/PosterField.tsx`
- Modify: `apps/mobile/app/(curator)/events/event/[eventId].tsx` (lines 13 to 16 imports, after 85
  state, after 143 `savePoster`, after 168 the Poster card)
- Modify: `apps/mobile/src/tickets/TicketList.tsx` (lines 10 and 226), `apps/mobile/app/(fan)/index.tsx`
  (lines 7 and 49), `apps/mobile/app/event/[eventId].tsx` (lines 5, 188, 192 to 199)
- Test: web live loads of `/dashboard/events` (upload) and `/e/[eventId]` (render plus the `og:image`
  tag); mobile typecheck, lint, export

**Interfaces:**
- Consumes: `stagingPhotoPath(uid, profileId, "poster", nonce)` and `MAX_PHOTO_UPLOAD_BYTES` from
  `@gatekeep/shared`; `PosterUploadDoc { path, createdAt }` at `posterUploads/{uid}/uploads/{nonce}`
  (section B3's `processPhoto` writes it once the processed file lands at
  `public/photos/{curatorProfileId}/poster-{nonce}.jpg`; Task 2's rules allow the owner's get);
  `updateEvent`'s existing `posterPath` field (`resolvePosterPath` in `functions/src/events.ts:177`
  checks the `public/photos/{curatorProfileId}/poster-` prefix); `callFn` from Task 27.
- Produces: `posterPublicUrl(path: string | null | undefined): string | null` on both clients (web:
  a plain module a Server Component may import; mobile: in `eventDisplay.ts`), `PosterField` on both
  clients, `EMU_HOST` and `STORAGE_BUCKET` exported from the mobile `lib/firebase.ts`, and two mobile
  icons `IconImage`, `IconUploadSimple`. No caller anywhere on either client resolves a poster with
  `getDownloadURL` any more (the grep gate in Step 8). SP7's cards consume the same helper.

**Steps:**

- [ ] **Step 1: Web public URL helper.** Replace `apps/web/src/events/posterUrl.ts` with (no
  `"use client"`: `app/e/[eventId]/page.tsx`, a Server Component, imports it for the OG image):

```ts
// Public poster URLs are BUILT from the path, never resolved with
// getDownloadURL (sp6 audit finding 16, spec 6.5). storage.rules'
// public/{kind}/{profileId}/{fileName} match already grants an unauthenticated
// read, and this REST form is exactly what Storage serves for a rules-allowed
// object with no token. The per-poster round trip disappears from every card,
// the server page can put the URL straight into og:image, and SP7's feed cards
// adopt this one helper.
//
// Plain module by design (no "use client", no hooks): the RSC boundary rule
// (server files never import values from "use client" modules) is what let
// the old hook-shaped file be client-only, and what forces this one to stay
// plain. Bucket and emulator posture mirror src/lib/firebase.ts: the same env
// name with the same dev default, so the two can never disagree; in dev the
// Storage emulator serves the identical /v0/b/{bucket}/o/{object} shape on
// 9199, on the page's own hostname (the LAN-phone case firebase.ts documents)
// or localhost during SSR.
const STORAGE_BUCKET = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "gatekeep-dev-jg.firebasestorage.app";
const USE_EMULATOR = process.env.NODE_ENV !== "production" || process.env.FIREBASE_EMULATORS === "1";

export function posterPublicUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
  const base = USE_EMULATOR ? `http://${host}:9199` : "https://firebasestorage.googleapis.com";
  return `${base}/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media`;
}
```

  Consumers: `apps/web/src/events/EventsManager.tsx` line 10 becomes
  `import { posterPublicUrl } from "./posterUrl";` and line 75
  `const posterUrl = posterPublicUrl(event.posterPath);`; `apps/web/app/tickets/TicketsClient.tsx`
  line 12 becomes `import { posterPublicUrl } from "../../src/events/posterUrl";` and line 136
  `const posterUrl = posterPublicUrl(event.posterPath);`. Both were hook calls at the top of a
  component body; a plain call in the same position is a no-op change for the React Compiler.

- [ ] **Step 2: The server page stops calling Storage.** In `apps/web/app/e/[eventId]/page.tsx` replace
  line 5 with `import { posterPublicUrl } from "../../../src/events/posterUrl";`, delete `storageUrl`
  (lines 38 to 49), and replace lines 97 to 102 with:

```ts
    const [curatorSnap, tiersSnap, lineup] = await Promise.all([
      getDoc(doc(db, "profiles", event.curatorProfileId)),
      getDocs(query(collection(db, `events/${eventId}/tiers`), orderBy("sortOrder"))),
      resolveLineup(db, event.lineup),
    ]);
    // Built, not fetched (posterUrl.ts's own header): the OG image and the
    // poster block both read this string, and no Storage call runs per render.
    const posterUrl = posterPublicUrl(event.posterPath);
```

  `generateMetadata` (lines 131 to 146) already spreads `posterUrl` into `openGraph.images`, so the
  `/e/[eventId]` OG image now follows.

- [ ] **Step 3: Web poster picker.** Create `apps/web/src/events/PosterField.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { ref as storageRef, uploadBytes } from "firebase/storage";
import { MAX_PHOTO_UPLOAD_BYTES, stagingPhotoPath, type PosterUploadDoc } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { useAuth } from "../auth/AuthProvider";
import { cn } from "../lib/utils";
import { posterPublicUrl } from "./posterUrl";
import { Button } from "../ui/button";
import { IconImage, IconTrash, IconUpload, IconWarning } from "../ui/icons";

// The event poster picker (Task 28). Same staging mechanics as
// PortfolioForms.tsx's PhotoUploader (upload to staging/photos with the
// "poster" kind, the pipeline resizes and strips it), with one difference: a
// poster has no profile field for the pipeline to write back to
// (functions/src/media.ts's poster branch), so completion is observed on
// posterUploads/{uid}/uploads/{nonce}, the doc processPhoto writes for this kind,
// owner-readable only. The processed public path reaches the parent through
// onChange; the parent's Save sends it as updateEvent's posterPath, which
// the server checks against the curator profile prefix (resolvePosterPath).
type Phase =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "processing"; nonce: string }
  | { kind: "error"; message: string };

export function PosterField({ curatorProfileId, value, onChange, disabled }: {
  curatorProfileId: string;
  value: string | null;
  onChange: (path: string | null) => void;
  disabled?: boolean;
}) {
  const { user } = useAuth();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const previewUrl = posterPublicUrl(value);

  // Watch the pipeline's completion doc for the nonce in flight. Bounded to
  // 60 s like PhotoUploader: a rejected image (corrupt, oversized after
  // decode) never produces the doc, and the picker must not lock forever.
  useEffect(() => {
    if (phase.kind !== "processing" || !user) return;
    const nonce = phase.nonce;
    const { db } = getFirebase();
    const timer = setTimeout(
      () => setPhase({ kind: "error", message: "Still processing. If the poster doesn't appear, try a smaller image." }),
      60_000,
    );
    const unsub = onSnapshot(doc(db, `posterUploads/${user.uid}/uploads/${nonce}`),
      (s) => {
        if (!s.exists()) return;
        onChange((s.data() as PosterUploadDoc).path);
        setPhase({ kind: "idle" });
      },
      (e) => setPhase({ kind: "error", message: e.message }));
    return () => { clearTimeout(timer); unsub(); };
  }, [phase, user, onChange]);

  const upload = async (f: File) => {
    if (!user) return;
    if (f.size > MAX_PHOTO_UPLOAD_BYTES) { setPhase({ kind: "error", message: "Posters must be under 10 MB." }); return; }
    setPhase({ kind: "uploading" });
    try {
      const nonce = crypto.randomUUID();
      const path = stagingPhotoPath(user.uid, curatorProfileId, "poster", nonce);
      await uploadBytes(storageRef(getFirebase().storage, path), f, { contentType: f.type });
      setPhase({ kind: "processing", nonce });
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : "Upload failed." });
    }
  };

  const locked = Boolean(disabled) || phase.kind === "uploading" || phase.kind === "processing";
  const buttonLabel = phase.kind === "uploading" ? "Uploading…"
    : phase.kind === "processing" ? "Processing…"
    : value ? "Replace poster" : "Upload poster";

  return (
    <div className="grid gap-2">
      <div className="relative h-40 w-full max-w-sm overflow-hidden rounded-gk border border-gk-border bg-gk-surface">
        {previewUrl ? (
          <img src={previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div
            aria-hidden="true"
            className="absolute inset-0 flex items-center justify-center text-gk-muted/40"
            style={{ background: "linear-gradient(155deg, var(--gk-surface) 0%, var(--gk-border) 100%)" }}
          >
            <IconImage size={32} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* A label wrapping a visually hidden file input: keyboard reachable
            (sr-only keeps it in the tab order, unlike display:none), 44px
            tall, secondary-button styling from the same tokens button.tsx's
            "secondary" variant uses. */}
        <label
          className={cn(
            "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-gk border border-gk-border px-4 font-sora text-sm font-medium text-gk-text transition-colors hover:bg-gk-border/40 focus-within:ring-2 focus-within:ring-gk-focus",
            locked && "cursor-not-allowed opacity-50",
          )}
        >
          <IconUpload size={16} aria-hidden="true" />
          {buttonLabel}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            disabled={locked}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = ""; // allows re-picking the same file after a failure
              if (f) void upload(f);
            }}
          />
        </label>
        {value && !locked && (
          <Button type="button" variant="ghost" size="sm" className="min-h-11 text-gk-destructive" onClick={() => onChange(null)}>
            <IconTrash size={16} aria-hidden="true" />
            Remove poster
          </Button>
        )}
      </div>
      <p className="font-sora text-xs text-gk-muted">
        JPEG, PNG, or WebP up to 10 MB. Shown at the top of the event page and as the preview when the link is shared.
        Saved with the rest of the event when you press Save changes.
      </p>
      {phase.kind === "error" && (
        <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {phase.message}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire it into the web edit form.** In `apps/web/src/events/EventEditor.tsx`:
  - after line 14 add `import { PosterField } from "./PosterField";`
  - in `EventEditContentForm` after the `lineup` state (line 453) add:

```ts
  // Seeded once from the event like every other field here; PosterField
  // hands back the processed public path (or null on Remove) and Save below
  // carries it in the same full-replace payload as the rest.
  const [posterPath, setPosterPath] = useState<string | null>(event.posterPath ?? null);
```

  - replace the payload block at lines 473 to 487 with:

```ts
      const payload: UpdateEventPayload = {
        curatorProfileId: profileId, eventId: event.id, title: trimmedTitle, description: description.trim(),
        startsAt, endsAt, maxTicketsPerBuyer: maxTix, lineup,
        // updateEvent's full-replace convention treats an absent posterPath
        // as "clear it" (resolvePosterPath returns null for undefined and
        // null alike), so the current value is always sent explicitly: the
        // one PosterField picked, or the event's own when it was untouched.
        posterPath,
      };
```

  - after the Details card (closing `</Card>` at line 525) insert:

```tsx
      <Card>
        <CardHeader><CardTitle>Poster</CardTitle></CardHeader>
        <CardContent>
          <PosterField curatorProfileId={profileId} value={posterPath} onChange={setPosterPath} disabled={busy} />
        </CardContent>
      </Card>
```

  The file's header note about "poster-less creation" (lines 476 to 486 of the old payload comment)
  is the block replaced above; no other stale reference remains (`grep -n "poster" EventEditor.tsx`).

- [ ] **Step 5: Mobile public URL helper.** In `apps/mobile/src/lib/firebase.ts` export the two values
  the helper needs: line 36 becomes `export const EMU_HOST = metroHost ?? (Platform.OS === "android" ? "10.0.2.2" : "localhost");`
  and after the config object (line 26) add:

```ts
// Exported for src/events/eventDisplay.ts's posterPublicUrl: a poster URL is
// built from the bucket name, never resolved through the SDK.
export const STORAGE_BUCKET = firebaseConfig.storageBucket;
```

  In `apps/mobile/src/events/eventDisplay.ts` delete line 3 (`ref as storageRef, getDownloadURL`,
  the poster hook was its only consumer), change line 5 to
  `import { getFirebase, EMU_HOST, STORAGE_BUCKET } from "../lib/firebase";`, and replace lines 173
  to 195 with:

```ts
// ---------- Poster URL ----------
// Built from the path, never resolved with getDownloadURL (sp6 audit finding
// 16, spec 6.5): storage.rules' public/{kind}/{profileId}/{fileName} match
// grants an unauthenticated read, and this REST form is what Storage serves
// for a rules-allowed object with no token. RN twin of web's posterUrl.ts;
// SP7's cards adopt the same helper. Dev builds point at the Storage emulator
// on the host lib/firebase.ts already resolved for the other emulators.
export function posterPublicUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = __DEV__ ? `http://${EMU_HOST}:9199` : "https://firebasestorage.googleapis.com";
  return `${base}/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(path)}?alt=media`;
}
```

  Consumers: `apps/mobile/src/tickets/TicketList.tsx` line 10 imports `posterPublicUrl` in place of
  `usePosterUrl` and line 226 becomes `const posterUrl = posterPublicUrl(event.posterPath);`;
  `apps/mobile/app/(fan)/index.tsx` line 7 and line 49 the same way. In
  `apps/mobile/app/event/[eventId].tsx` delete line 5, change line 188 to
  `const { db } = getFirebase();`, and replace lines 192 to 199 with:

```ts
        const [curatorSnap, tiersSnap, lineup] = await Promise.all([
          getDoc(doc(db, "profiles", event.curatorProfileId)),
          getDocs(query(collection(db, `events/${eventId}/tiers`), orderBy("sortOrder"))),
          resolveLineup(db, event.lineup),
        ]);
        const posterUrl = posterPublicUrl(event.posterPath);
```

  adding `posterPublicUrl` to the `../../src/events/eventDisplay` import (lines 15 to 18).

- [ ] **Step 6: Mobile icons and picker.** In `apps/mobile/src/ui/icons.tsx` add after line 64:

```ts
// Task 28 (poster picker): the placeholder glyph and the upload action.
export const IconImage = wrap(Ph.ImageIcon);
export const IconUploadSimple = wrap(Ph.UploadSimpleIcon);
```

  Create `apps/mobile/src/events/PosterField.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Image, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { doc, onSnapshot } from "firebase/firestore";
import { ref as storageRef, uploadBytes } from "firebase/storage";
import { MAX_PHOTO_UPLOAD_BYTES, stagingPhotoPath, type PosterUploadDoc } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { useAuth } from "../auth/AuthProvider";
import { posterPublicUrl } from "./eventDisplay";
import { Text, Button, ErrorBanner, PhotoPlaceholder, IconImage, IconUploadSimple, IconTrash } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// RN twin of apps/web/src/events/PosterField.tsx (Task 28). Same picker and
// staging mechanics as src/portfolio/PortfolioForms.tsx's PhotoUploader
// (expo-document-picker, a timestamp nonce, uploadBytes to the "poster"
// staging path), completion observed on posterUploads/{uid}/uploads/{nonce}. The
// mobile event screen has no content form (that stays web-only, see its own
// header), so onChange here is the save: the parent calls updateEvent with the
// event's current fields plus the new posterPath the moment the pipeline
// reports the processed path.
type Phase =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "processing"; nonce: string }
  | { kind: "error"; message: string };

export function PosterField({ curatorProfileId, value, onChange, saving, saveError }: {
  curatorProfileId: string;
  value: string | null;
  onChange: (path: string | null) => void;
  saving: boolean;
  saveError: string | null;
}) {
  const { user } = useAuth();
  const t = useTokens();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const previewUrl = posterPublicUrl(value);

  useEffect(() => {
    if (phase.kind !== "processing" || !user) return;
    const nonce = phase.nonce;
    const { db } = getFirebase();
    const timer = setTimeout(
      () => setPhase({ kind: "error", message: "Still processing. If the poster doesn't appear, try a smaller image." }),
      60_000,
    );
    const unsub = onSnapshot(doc(db, `posterUploads/${user.uid}/uploads/${nonce}`),
      (s) => {
        if (!s.exists()) return;
        onChange((s.data() as PosterUploadDoc).path);
        setPhase({ kind: "idle" });
      },
      (e) => setPhase({ kind: "error", message: e.message }));
    return () => { clearTimeout(timer); unsub(); };
  }, [phase, user, onChange]);

  const upload = async () => {
    if (!user) return;
    const res = await DocumentPicker.getDocumentAsync({ type: "image/*", copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    if ((a.size ?? 0) > MAX_PHOTO_UPLOAD_BYTES) { setPhase({ kind: "error", message: "Posters must be under 10 MB." }); return; }
    setPhase({ kind: "uploading" });
    try {
      // RN has no crypto.randomUUID: timestamp plus random, same as PhotoUploader.
      const nonce = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      const blob = await (await fetch(a.uri)).blob();
      await uploadBytes(storageRef(getFirebase().storage, stagingPhotoPath(user.uid, curatorProfileId, "poster", nonce)), blob,
        { contentType: a.mimeType ?? "image/jpeg" });
      setPhase({ kind: "processing", nonce });
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : "Upload failed." });
    }
  };

  const locked = saving || phase.kind === "uploading" || phase.kind === "processing";
  const label = saving ? "Saving…"
    : phase.kind === "uploading" ? "Uploading…"
    : phase.kind === "processing" ? "Processing…"
    : value ? "Replace poster" : "Upload poster";

  return (
    <View style={{ gap: tokens.space.sm }}>
      <View style={{ height: 160, borderRadius: tokens.radius.card, overflow: "hidden", borderWidth: 1, borderColor: t.border }}>
        {previewUrl
          ? <Image source={{ uri: previewUrl }} style={{ width: "100%", height: "100%" }} accessibilityIgnoresInvertColors />
          : <PhotoPlaceholder icon={<IconImage size={32} color={t.muted} />} />}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: tokens.space.sm }}>
        <Button variant="secondary" onPress={() => void upload()} disabled={locked} accessibilityLabel={label}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.xs }}>
            <IconUploadSimple size={16} color={t.text} />
            <Text variant="label">{label}</Text>
          </View>
        </Button>
        {value && !locked && (
          <Button variant="ghost" onPress={() => onChange(null)} accessibilityLabel="Remove poster">
            <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.xs }}>
              <IconTrash size={16} color={t.destructive} />
              <Text variant="label" color={t.destructive}>Remove poster</Text>
            </View>
          </Button>
        )}
      </View>
      <Text variant="meta" muted>
        JPEG, PNG, or WebP up to 10 MB. Shown at the top of the event page and as the preview when the link is shared.
      </Text>
      <ErrorBanner message={phase.kind === "error" ? phase.message : saveError} />
    </View>
  );
}
```

- [ ] **Step 7: Wire it into the mobile event management screen.** In
  `apps/mobile/app/(curator)/events/event/[eventId].tsx`:
  - add `import { PosterField } from "../../../../src/events/PosterField";` after line 13;
  - after `publishError` (line 85) add:

```ts
  const [posterBusy, setPosterBusy] = useState(false);
  const [posterError, setPosterError] = useState<string | null>(null);
```

  - after `publish` (line 143) add:

```ts
  // The mobile screen has no content editor, so the poster saves on its own
  // through updateEvent's full-replace payload: every current field of the
  // live event doc plus the new posterPath. Content stays web-edit-only
  // (this file's own header), this is the one field mobile writes.
  const savePoster = async (path: string | null) => {
    setPosterBusy(true);
    setPosterError(null);
    try {
      await callFn("updateEvent", {
        curatorProfileId: event.curatorProfileId, eventId,
        title: event.title, description: event.description, startsAt: event.startsAt, endsAt: event.endsAt,
        maxTicketsPerBuyer: event.maxTicketsPerBuyer, lineup: event.lineup, posterPath: path,
      });
    } catch (e) {
      setPosterError(e instanceof Error ? e.message : "Could not save the poster.");
    } finally {
      setPosterBusy(false);
    }
  };
```

  - after the Lineup card (closing at line 168) insert, gated the same way the tier editor's edits
    are (updateEvent refuses a completed or cancelled event):

```tsx
        {editable && (
          <Card style={{ gap: tokens.space.sm }}>
            <Text variant="label">Poster</Text>
            <PosterField
              curatorProfileId={event.curatorProfileId} value={event.posterPath}
              onChange={(path) => void savePoster(path)} saving={posterBusy} saveError={posterError}
            />
          </Card>
        )}
```

  `event.posterPath` is the live snapshot, so the preview updates the moment updateEvent commits.

- [ ] **Step 8: Gates and live checks.** `pnpm typecheck`, both lints, web build, mobile export. Grep
  gate: `git grep -n "getDownloadURL" -- apps/web/src/events apps/web/app/e apps/web/app/tickets apps/mobile/src/events apps/mobile/src/tickets apps/mobile/app` returns nothing (the profile-photo
  readers under `app/u/[handle]` and the portfolio editors are out of this task's scope and keep
  theirs). Live (web, emulators): as `test-curator` on `/dashboard/events`, manage a draft event,
  upload a JPEG, watch the label go Uploading, Processing, then the preview appear; press Save
  changes; publish. Then:

```bash
curl -s http://localhost:3000/e/<eventId> | grep -o '<meta property="og:image"[^>]*>'
curl -sI "$(curl -s http://localhost:3000/e/<eventId> | grep -o 'http://localhost:9199/v0/b/[^"]*' | head -1)" | head -1
```

  Expected: the meta tag carries `http://localhost:9199/v0/b/gatekeep-dev-jg.firebasestorage.app/o/public%2Fphotos%2F<profileId>%2Fposter-<nonce>.jpg?alt=media`
  and the second command prints `HTTP/1.1 200 OK`. The page's poster block renders the image; the
  RSC rule holds (`posterUrl.ts` has no `"use client"`, the build's server bundle imports it).

- [ ] **Step 9: Commit.** `feat(clients): event poster picker on web and mobile, poster URLs built from the path`

---
### Task 29: Notification links, ticket detail event link, push tap handling

**Files:**
- Modify: `apps/web/app/dashboard/page.tsx` (line 10 import, 189 to 194 href)
- Modify: `apps/mobile/src/shell/NotificationsList.tsx` (lines 3 and 9 imports, 29 to 40 `onPress`)
- Modify: `apps/mobile/src/tickets/TicketDetail.tsx` (lines 1 to 12 imports, 32 to 37 hook, after 102 the event link)
- Modify: `apps/mobile/src/notifications/push.ts` (whole file, 17 lines: handler, channel, href map, unchanged `registerForPush`)
- Modify: `apps/mobile/app/_layout.tsx` (imports at lines 1 to 13, Gate effect after line 50)
- Test: web live load of `/dashboard` with a ticket-kind notification; mobile typecheck, lint, export

**Interfaces:**
- Consumes: `notificationHref(kind, refId, platform)` and `NotificationKind` from
  `@gatekeep/shared` (Task 1: booking to `/dashboard/bookings/{refId}` on web and `/booking/{refId}`
  on mobile, ticket to `/tickets` and `/(fan)/tickets`, everything else null); the
  `data: { kind, refId }` payload `notifyUser` now attaches to every Expo push (section B3);
  `expo-notifications` (`setNotificationHandler`, `setNotificationChannelAsync`,
  `addNotificationResponseReceivedListener`, `getLastNotificationResponseAsync`, already a dependency
  and plugin, `apps/mobile/package.json:27`, `app.json` plugins).
- Produces: `ensureAndroidChannel(): Promise<void>` and
  `pushHref(response: Notifications.NotificationResponse | null | undefined): Href | null` from
  `apps/mobile/src/notifications/push.ts`; the module-scope `setNotificationHandler` registration
  (importing `push.ts` anywhere registers it, and `ProfileContext.tsx:5` already does).

**Steps:**

- [ ] **Step 1: Web inbox rows.** In `apps/web/app/dashboard/page.tsx` change line 10 to:

```ts
import { notificationHref, type ProfileType, type ProfileStatus, type ProfileDoc, type NotificationDoc } from "@gatekeep/shared";
```

  and lines 189 to 194 to:

```ts
        // One href map for both clients (Task 29): booking rows deep-link to
        // the thread as before, ticket rows (purchase confirmations, transfer
        // offers, reminders, cancellations: refId is the eventId on every one)
        // land on /tickets, where all of those live. Kinds with no destination,
        // and legacy rows written before refId existed, stay plain text.
        const href = notificationHref(n.kind, n.refId, "web");
```

- [ ] **Step 2: Mobile inbox rows.** In `apps/mobile/src/shell/NotificationsList.tsx` change line 3 to
  `import { useRouter, type Href } from "expo-router";`, line 9 to
  `import { notificationHref, type NotificationDoc } from "@gatekeep/shared";`, and lines 29 to 40 to:

```ts
  // The shared href map (Task 29): booking rows open the thread, ticket rows
  // open the Tickets tab (where purchases, transfer offers, and cancellations
  // all live), every other kind and every legacy row without refId just
  // marks read. `as Href` because notificationHref returns a plain string;
  // expo-router's typed routes accept the two shapes it produces.
  const onPress = (item: { id: string } & NotificationDoc) => {
    void markRead(item.id);
    const href = notificationHref(item.kind, item.refId, "mobile");
    if (href) router.push(href as Href);
  };
```

- [ ] **Step 3: "Event details" on the mobile ticket.** In `apps/mobile/src/tickets/TicketDetail.tsx`
  add `import { useRouter } from "expo-router";` after line 2 and `IconTicket` to the `../ui` import
  (line 10). Inside the component (after line 36) add `const router = useRouter();`. After the
  ticket-holder address block (closing at line 102) and before the transfer/close buttons, add:

```tsx
        {/* sp6 audit finding 10: a ticket had no path back to its event. Closes
            the sheet first so the pushed event screen is not stacked under a
            Modal that would otherwise stay presented above it. */}
        <Button variant="secondary" onPress={() => {
          onClose();
          router.push({ pathname: "/event/[eventId]", params: { eventId: ticket.eventId } });
        }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.xs }}>
            <IconTicket size={16} color={t.text} />
            <Text variant="label">Event details</Text>
          </View>
        </Button>
```

- [ ] **Step 4: Push plumbing.** Replace `apps/mobile/src/notifications/push.ts` with:

```ts
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import type { Href } from "expo-router";
import { doc, setDoc } from "firebase/firestore";
import { notificationHref, type NotificationKind } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";

// Foreground presentation (sp1 audit finding 8): without a handler,
// expo-notifications shows nothing while the app is open. Registered at
// module scope, per the expo-notifications docs, so it exists before any
// push can arrive; ProfileContext imports this module on every launch.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false,
  }),
});

// Android displays nothing without a channel (iOS ignores this call).
export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("default", {
    name: "GateKeep", importance: Notifications.AndroidImportance.DEFAULT,
  });
}

// The route a tapped push opens: the same map the in-app inbox rows use, read
// off the data: { kind, refId } payload notifyUser attaches (section B3).
// Null for a kind with no destination or a legacy push without data, in
// which case the tap just foregrounds the app, exactly as before.
export function pushHref(response: Notifications.NotificationResponse | null | undefined): Href | null {
  const data = response?.notification.request.content.data as { kind?: unknown; refId?: unknown } | undefined;
  if (!data || typeof data.kind !== "string") return null;
  const refId = typeof data.refId === "string" ? data.refId : null;
  return notificationHref(data.kind as NotificationKind, refId, "mobile") as Href | null;
}

export async function registerForPush(uid: string): Promise<void> {
  if (!Device.isDevice) return; // simulators can't receive push
  const { status: existing } = await Notifications.getPermissionsAsync();
  const status = existing === "granted"
    ? existing
    : (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await setDoc(doc(getFirebase().db, `users/${uid}/pushTokens/${token}`), { createdAt: Date.now() });
}
```

- [ ] **Step 5: Tap routing in the root layout.** In `apps/mobile/app/_layout.tsx` change line 2 to
  `import { useEffect, useRef } from "react";` and add to the import block:

```ts
import * as Notifications from "expo-notifications";
import { ensureAndroidChannel, pushHref } from "../src/notifications/push";
```

  Inside `Gate()` after the redirect effect (line 50) add:

```tsx
  // Push taps (sp1 audit finding 8, sp4 finding 5, sp6 finding 10). A tap
  // while the app is running arrives through the response listener; a tap
  // that cold-starts the app is read once from getLastNotificationResponseAsync.
  // Both wait for a signed-in user: every destination sits behind the auth
  // redirect above, and routing first would bounce to sign-in and lose the
  // href. The ref keeps the cold-start read from firing again on a later
  // user change (sign-out, sign-in), which would re-open a stale destination.
  const coldStartHandled = useRef(false);
  useEffect(() => {
    if (loading || !user) return;
    let cancelled = false;
    void ensureAndroidChannel();
    if (!coldStartHandled.current) {
      coldStartHandled.current = true;
      Notifications.getLastNotificationResponseAsync()
        .then((response) => {
          if (cancelled) return;
          const href = pushHref(response);
          if (href) router.push(href);
        })
        .catch((e) => console.warn("getLastNotificationResponseAsync failed", e));
    }
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const href = pushHref(response);
      if (href) router.push(href);
    });
    return () => { cancelled = true; sub.remove(); };
  }, [user, loading, router]);
```

- [ ] **Step 6: Gates and live checks.** `pnpm typecheck`, both lints, web build, mobile export. Live
  (web): as `test-fan` buy a free ticket on `/e/<eventId>`, open `/dashboard`: the "Tickets
  confirmed" row is a link to `/tickets`. A device check of the tap routing needs the new EAS build
  (spec section 11); until then the export bundling and typecheck are the gate.

- [ ] **Step 7: Commit.** `feat(clients): shared notification hrefs, ticket event link, push foreground handler and tap routing`

---

### Task 30: Scanner transport-error panel, sticky verdicts, attendee Undo

**Files:**
- Modify: `apps/mobile/src/events/ScannerScreen.tsx` (line 5 import, 45 to 48 `ScanResult`, 61 to 99
  `ResultPanel`, 122 to 133 auto-clear effect, 139 to 166 `handleScan`, 202 result render)
- Modify: `apps/mobile/src/events/AttendeeListScreen.tsx` (lines 32 to 36 types, 113 to 139 row, 149
  to 162 state, after 188 `doUndo`, 224 to 229 renderItem)
- Modify: `apps/web/src/events/AttendeeList.tsx` (lines 49 to 105 row)
- Test: mobile typecheck, lint, export; web typecheck, lint, build, live load of `/dashboard/events`
  (manage view, Attendees) after a list check-in

**Interfaces:**
- Consumes: `SCANNER_OFFLINE_MESSAGE` from `@gatekeep/shared`; `FunctionsError.code` from
  `firebase/functions` (`checkInTicket` throws `failed-precondition` for every ticket verdict,
  `not-found` for a missing event or ticket, `permission-denied` for another curator's event,
  `functions/src/ticketing.ts:993-1032`); `undoCheckIn({ eventId, ticketId })` (section B3, curator
  member, `checked_in` to `valid`); `callFn` from Task 27.
- Produces: a fourth `ScanResult` kind `offline`; success auto-clears after 1.5 s, duplicate,
  invalid, and offline stay until tapped and re-arm the scan lock on tap; an "Undo check-in" control
  on every `checked_in` attendee row on both platforms.

**Steps:**

- [ ] **Step 1: Result model.** In `apps/mobile/src/events/ScannerScreen.tsx` change line 5 to:

```ts
import { TICKET_ALREADY_CHECKED_IN_MESSAGE, SCANNER_OFFLINE_MESSAGE } from "@gatekeep/shared";
```

  and lines 45 to 48 to:

```ts
type ScanResult =
  | { kind: "success"; ownerName: string; tierName: string }
  | { kind: "duplicate"; checkedInAt: number | undefined }
  | { kind: "invalid"; message: string }
  // Transport or server failure, NOT a ticket verdict (sp6 audit finding 3):
  // the door must never turn a fan away over venue Wi-Fi.
  | { kind: "offline" };

// The three codes checkInTicket uses for a verdict ABOUT THE TICKET (or the
// caller's right to scan it). Everything else, unavailable, deadline-exceeded,
// internal, a plain fetch failure that is not even a FunctionsError, is the
// network or the server, and renders the neutral offline panel.
const VERDICT_CODES = new Set(["functions/failed-precondition", "functions/not-found", "functions/permission-denied"]);
```

- [ ] **Step 2: Result panel with a tap-to-dismiss.** Replace `ResultPanel` (lines 61 to 99) with:

```tsx
function ResultPanel({ result, onDismiss }: { result: ScanResult; onDismiss: () => void }) {
  const t = useTokens();
  const tone = result.kind === "success" ? "success" : result.kind === "offline" ? "neutral" : "destructive";
  const toneColor = result.kind === "offline" ? t.muted : t[tone];
  // Success clears itself; the other three wait for a tap so the staffer
  // can actually read the verdict (the old 1.5 s clear on "Not valid" was
  // gone before anyone could).
  const sticky = result.kind !== "success";
  return (
    <Pressable
      onPress={sticky ? onDismiss : undefined}
      disabled={!sticky}
      accessibilityRole={sticky ? "button" : undefined}
      accessibilityLabel={sticky ? "Scan the next ticket" : undefined}
      style={{ flex: 1 }}
    >
      <PageBackground />
      <View style={{ flex: 1, padding: tokens.space.lg }}>
        <Callout tone={tone} style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: tokens.space.md }}>
          {result.kind === "success"
            ? <IconCheckCircle size={56} color={toneColor} />
            : <IconWarningCircle size={56} color={toneColor} />}
          {result.kind === "success" && (
            <View style={{ alignItems: "center", gap: 4 }}>
              <Text variant="heading" color={toneColor} style={{ textAlign: "center" }}>{result.ownerName}</Text>
              <Text variant="title" muted>{result.tierName}</Text>
            </View>
          )}
          {result.kind === "duplicate" && (
            <View style={{ alignItems: "center", gap: 4 }}>
              <Text variant="heading" color={toneColor}>Already checked in</Text>
              <Text muted style={{ textAlign: "center" }}>
                {result.checkedInAt != null
                  ? `Originally checked in at ${formatGigTime(result.checkedInAt)}.`
                  : "This ticket was already checked in."}
              </Text>
            </View>
          )}
          {result.kind === "invalid" && (
            <View style={{ alignItems: "center", gap: 4 }}>
              <Text variant="heading" color={toneColor}>Not valid</Text>
              <Text muted style={{ textAlign: "center" }}>{result.message}</Text>
            </View>
          )}
          {result.kind === "offline" && (
            <View style={{ alignItems: "center", gap: 4 }}>
              <Text variant="heading" style={{ textAlign: "center" }}>{SCANNER_OFFLINE_MESSAGE}</Text>
              <Text muted style={{ textAlign: "center" }}>
                This is a connection problem, not a verdict on the ticket. Check the venue Wi-Fi and scan it again.
              </Text>
            </View>
          )}
          {sticky && <Text variant="meta" muted style={{ marginTop: tokens.space.md }}>Tap anywhere to scan the next ticket</Text>}
        </Callout>
      </View>
    </Pressable>
  );
}
```

  and add `Pressable` to the `react-native` import on line 2.

- [ ] **Step 3: Auto-clear for success only, classify errors.** Replace the effect at lines 122 to 133:

```ts
  // Auto-ready for the next scan 1.5 s after a SUCCESS (brief's own anatomy).
  // Duplicate, invalid, and offline stay until the staffer taps the panel
  // (dismiss below), which is also where the scan lock re-arms for them.
  useEffect(() => {
    if (!result || result.kind !== "success") return;
    const timer = setTimeout(() => {
      setResult(null);
      scanLockRef.current = false;
    }, 1500);
    return () => clearTimeout(timer);
  }, [result]);
  const dismiss = () => {
    setResult(null);
    scanLockRef.current = false;
  };
```

  and the `.catch` at lines 152 to 164 with:

```ts
      .catch((e: unknown) => {
        // A verdict is one of three codes checkInTicket throws about the
        // ticket itself; anything else is the network or the server and gets
        // the neutral offline panel, never the destructive "Not valid" one.
        if (!(e instanceof FunctionsError) || !VERDICT_CODES.has(e.code)) {
          setResult({ kind: "offline" });
          return;
        }
        if (e.message === TICKET_ALREADY_CHECKED_IN_MESSAGE) {
          setResult({ kind: "duplicate", checkedInAt: errorDetails(e)?.checkedInAt });
        } else {
          setResult({ kind: "invalid", message: e.message });
        }
      })
```

  Line 148's `httpsCallable<CheckInTicketInput, CheckInTicketResult>(getFirebase().functions, "checkInTicket")({...})`
  already reads `callFn<CheckInTicketInput, CheckInTicketResult>("checkInTicket", {...})` after Task 27's
  sweep. Line 202 becomes `if (result) return <ResultPanel result={result} onDismiss={dismiss} />;`.

- [ ] **Step 4: Undo on the mobile attendee list.** In `apps/mobile/src/events/AttendeeListScreen.tsx`
  add after line 36:

```ts
interface UndoCheckInInput { eventId: string; ticketId: string }
```

  Replace `AttendeeRowView` (lines 113 to 139) with:

```tsx
function AttendeeRowView({ row, refundable, refundBusy, undoBusy, onPress, onRefund, onUndo }: {
  row: AttendeeRow; refundable: boolean; refundBusy: boolean; undoBusy: boolean;
  onPress: () => void; onRefund: () => void; onUndo: () => void;
}) {
  const canRefund = refundable && (row.status === "valid" || row.status === "checked_in");
  const label = checkedInLabel(row.checkedInAt);
  const busy = refundBusy || undoBusy;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Check in ${row.ownerName}, ${row.tierName}`}>
      <Card style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: tokens.space.sm }}>
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.xs }}>
              <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>{row.ownerName}</Text>
              <StatusBadge label={TICKET_STATUS_LABEL[row.status]} status={TICKET_STATUS_TONE[row.status]} />
            </View>
            <Text variant="meta" muted>
              {row.tierName}{label ? ` · Checked in ${label}` : ""}
            </Text>
          </View>
        </View>
        {(canRefund || row.status === "checked_in") && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: tokens.space.sm }}>
            {/* sp6 audit finding 12: a mis-scan (wrong person, wrong door)
                had no way back. undoCheckIn flips checked_in to valid on both
                the ticket and the attendee row; the live list re-renders. */}
            {row.status === "checked_in" && (
              <Button variant="secondary" title={undoBusy ? "Undoing…" : "Undo check-in"} onPress={onUndo} disabled={busy} />
            )}
            {canRefund && (
              <Button variant="destructive" title={refundBusy ? "Refunding…" : "Refund"} onPress={onRefund} disabled={busy} />
            )}
          </View>
        )}
      </Card>
    </Pressable>
  );
}
```

  In `AttendeeListScreen` add beside `refundBusyId` (line 157):

```ts
  const [undoBusyId, setUndoBusyId] = useState<string | null>(null);
```

  after `confirmRefund` (line 188):

```ts
  const doUndo = async (row: AttendeeRow) => {
    setUndoBusyId(row.id);
    setError(null);
    try {
      await callFn<UndoCheckInInput, { ok: true }>("undoCheckIn", { eventId, ticketId: row.id });
    } catch (e) {
      // Verbatim server copy ("This ticket is not checked in.", the
      // published-event gate), same convention as the refund branch above.
      setError(e instanceof Error ? e.message : "Could not undo this check-in.");
    } finally {
      setUndoBusyId(null);
    }
  };
```

  and the `renderItem` (lines 224 to 229) gains the two props:

```tsx
            <AttendeeRowView
              row={item} refundable={refundable} refundBusy={refundBusyId === item.id} undoBusy={undoBusyId === item.id}
              onPress={() => setCheckInRow(item)} onRefund={() => confirmRefund(item)} onUndo={() => void doUndo(item)}
            />
```

  `callFn` is imported from `../lib/callable` (Task 27's sweep already added the import to this file
  for the refund and check-in calls).

- [ ] **Step 5: Undo on the web attendee list.** In `apps/web/src/events/AttendeeList.tsx`
  `AttendeeRowView` (lines 49 to 105): add a second busy flag and handler after `refund`:

```ts
  const [undoBusy, setUndoBusy] = useState(false);
  const undo = async () => {
    setUndoBusy(true);
    try {
      await callFn("undoCheckIn", { eventId, ticketId: row.id });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not undo this check-in.");
    } finally {
      setUndoBusy(false);
    }
  };
```

  and replace the row's action block (lines 98 to 102) with:

```tsx
      <div className="flex shrink-0 flex-wrap gap-2">
        {row.status === "checked_in" && (
          <Button type="button" variant="secondary" size="sm" className="min-h-11" onClick={undo} disabled={busy || undoBusy}>
            {undoBusy ? "Undoing…" : "Undo check-in"}
          </Button>
        )}
        {canRefund && (
          <Button type="button" variant="destructive" size="sm" className="min-h-11" onClick={refund} disabled={busy || undoBusy}>
            {busy ? "Refunding…" : "Refund"}
          </Button>
        )}
      </div>
```

- [ ] **Step 6: Gates and live checks.** Mobile: typecheck, lint, export. Web: typecheck, lint, build;
  live on `/dashboard/events` as `test-curator`: manage a published event with a sold ticket, check
  the attendee in from the mobile list (or by calling `checkInTicket` with `override: true` from the
  console), see the row flip to "Checked in", press "Undo check-in": the badge returns to "Valid"
  and `users/{uid}/tickets/{ticketId}.checkedInAt` is gone in the emulator UI. The offline panel is
  a device check (kill Wi-Fi mid-scan on the EAS build): the export bundling and the typecheck on
  `VERDICT_CODES` are the gate here.

- [ ] **Step 7: Commit.** `fix(clients): scanner offline panel with sticky verdicts, attendee undo check-in`

---

### Task 31: Checkout copy, buyer-side order cancel, RSVP label

**Files:**
- Modify: `apps/web/src/events/BuyTicketsFlow.tsx` (lines 8 to 12 import, 134 to 163 `PayConfirmForm`,
  after 189 state, after 205 `allFree`, after 310 `cancelOrder`, 360 to 367 mount, 380 to 388 label)
- Modify: `apps/mobile/app/event/[eventId].tsx` (lines 7 to 11 import, 295 to 298 and after,
  324 to 329 cancelled outcome, 435 error-state Cancel, 523 to 534 buy block)
- Test: web live load of `/e/[eventId]`; mobile typecheck, lint, export

**Interfaces:**
- Consumes: `SALES_FINAL_LINE` from `@gatekeep/shared`; `cancelTicketOrder({ orderId })` (section B3:
  buyer-owned, pending orders only, cancels the intent when one exists, releases inventory and the
  buyer-cap count, status `cancelled`); `callFn` from Task 27.
- Produces: the sales-final sentence above Pay on both platforms; web Cancel and the mobile sheet's
  cancelled outcome release the hold; the primary CTA reads "RSVP" when every selected tier is free.

**Steps:**

- [ ] **Step 1: Web.** In `apps/web/src/events/BuyTicketsFlow.tsx` add `SALES_FINAL_LINE` to the
  shared import (lines 8 to 12). Replace `PayConfirmForm` (lines 134 to 163) with:

```tsx
function PayConfirmForm({ onConfirmed, onCancel, cancelling }: {
  onConfirmed: () => void; onCancel: () => void; cancelling: boolean;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    const { error: confirmError } = await stripe.confirmPayment({ elements, redirect: "if_required" });
    if (confirmError) {
      setError(confirmError.message ?? "Could not complete the payment.");
      setBusy(false);
      return;
    }
    onConfirmed();
  };

  return (
    <div className="grid gap-3 rounded-gk border border-gk-border bg-gk-surface p-4">
      <PaymentElement />
      {error && <ErrorBox message={error} />}
      {/* sp6 audit finding 7: the one sentence a fan reads before money moves.
          Shared constant so mobile renders it byte-identically. */}
      <p className="font-sora text-xs text-gk-muted">{SALES_FINAL_LINE}</p>
      <div className="flex gap-2">
        <Button onClick={confirm} disabled={busy || cancelling || !stripe || !elements}>{busy ? "Paying…" : "Pay now"}</Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy || cancelling}>
          {cancelling ? "Cancelling…" : "Cancel"}
        </Button>
      </div>
    </div>
  );
}
```

  In `BuyTicketsFlow` add after the `purchasedQty` state (line 189):

```ts
  const [cancelling, setCancelling] = useState(false);
```

  after `totalCents` (line 205):

```ts
  // Every selected tier free: createTicketOrder completes the order inline
  // with no PaymentIntent, so the one primary CTA says what will actually
  // happen. "RSVP", not "Buy tickets".
  const allFree = items.length > 0
    && items.every((it) => liveTiers.find((t) => t.id === it.tierId)?.priceCents === 0);
```

  after `finalize` (line 310):

```ts
  // Buyer-side release (sp6 audit finding 2): a pending order holds inventory
  // and the buyer's own cap count until it is cancelled or expires (five
  // minutes now, section B3's ticketOrderExpiry). Best effort: if the release
  // call fails the expiry job still frees the hold, so the local reset happens
  // regardless and the failure is only logged.
  const cancelOrder = async () => {
    setCancelling(true);
    try {
      if (orderId) await callFn("cancelTicketOrder", { orderId });
    } catch (e) {
      console.warn("cancelTicketOrder failed, the expiry job releases the hold", orderId, e);
    } finally {
      setCancelling(false);
      setPhase("idle"); setClientSecret(null); setOrderId(null);
    }
  };
```

  change the mount (lines 362 to 365) to:

```tsx
          <PayConfirmForm onConfirmed={finalize} onCancel={cancelOrder} cancelling={cancelling} />
```

  and the sticky-bar label (line 384) to:

```tsx
          label={!user
            ? (allFree ? "Sign in to RSVP" : "Sign in to buy tickets")
            : phase === "creating" ? "Starting…" : allFree ? "RSVP" : "Buy tickets"}
```

- [ ] **Step 2: Mobile.** In `apps/mobile/app/event/[eventId].tsx` add `SALES_FINAL_LINE` to the shared
  import (lines 7 to 11). After `resetPurchase` (lines 295 to 298) add:

```ts
  // Buyer-side release (sp6 audit finding 2), same best-effort shape as web's
  // cancelOrder: the local reset happens regardless of the call's outcome.
  const cancelOrder = async (orderIdArg: string | null) => {
    try {
      if (orderIdArg) await callFn("cancelTicketOrder", { orderId: orderIdArg });
    } catch (e) {
      console.warn("cancelTicketOrder failed, the expiry job releases the hold", orderIdArg, e);
    } finally {
      resetPurchase();
    }
  };
```

  Replace the cancelled outcome (lines 324 to 329) with:

```ts
    if (outcome.cancelled) {
      // A swiped-away sheet used to leave the hold in place for the TTL
      // sweep to find; now it is released immediately (sp6 audit finding 2).
      await cancelOrder(orderIdArg);
      return;
    }
```

  Line 435's error-state Cancel becomes:

```tsx
                  <Button variant="secondary" title="Cancel" onPress={() => void cancelOrder(orderId)} style={{ alignSelf: "flex-start" }} />
```

  and the buy block (lines 523 to 534) becomes:

```tsx
          {quantity > 0 && (
            <View style={{ gap: 2 }}>
              <Text variant="meta" muted>{quantity} ticket{quantity === 1 ? "" : "s"}</Text>
              <Text variant="label">Order total: {formatCents(totalCents)}</Text>
            </View>
          )}
          {/* The native PaymentSheet is the Pay step, so the sales-final line
              sits above the button that opens it; a free tier never opens a
              sheet and never charges, so it gets no money sentence. */}
          {selectedTier && selectedTier.priceCents > 0 && quantity > 0 && (
            <Text variant="meta" muted>{SALES_FINAL_LINE}</Text>
          )}
          <Button
            onPress={() => void startPurchase()}
            disabled={!selectedTier || quantity <= 0 || !!unavailable || phase !== "idle"}
          >
            <Text variant="label" color={t.onAccent}>
              {phase === "creating" ? "Starting…" : selectedTier?.priceCents === 0 ? "RSVP" : "Buy tickets"}
            </Text>
          </Button>
```

- [ ] **Step 3: Gates and live check.** Mobile: typecheck, lint, export. Web: typecheck, lint, build;
  live on `/e/<eventId>` as `test-fan`: pick only a free tier, the bar reads "RSVP"; add a paid tier,
  it reads "Buy tickets"; start a paid order (keyless emulator: the Pay form mounts with the
  sales-final sentence above the disabled Pay button), press Cancel, then in the emulator UI the
  order doc is `status: "cancelled"` and the tier's `soldCount` is back down. Retrying the same
  quantity immediately succeeds (the hold was released, not left for the sweep).

- [ ] **Step 4: Commit.** `feat(clients): sales-final line, buyer-side ticket order cancel, RSVP label for free orders`

---
### Task 32: Booking clarity UI (runs, counterparties, previews, caps, grace, series copy and end dates)

**Files:**
- Modify: `apps/web/src/bookings/BookingForms.tsx` (after `DEPOSIT_HONESTY_LINE`, line 41: run variant)
- Modify: `apps/mobile/src/bookings/BookingForms.tsx` (after `DEPOSIT_HONESTY_LINE`, line 27: run variant)
- Modify: `apps/web/src/bookings/GigBrowse.tsx` (lines 16 to 25 badge label)
- Modify: `apps/web/app/gigs/[gigId]/page.tsx` (line 15 types, 24 to 46 `useSeriesFillMode` removed,
  line 149 honesty line, 173 fill mode, 239 to 241 series line, 266 to 268 badge block)
- Modify: `apps/mobile/src/bookings/GigBrowse.tsx` (line 9 import, 100 honesty line, 128 and 175 badges)
- Modify: `apps/web/src/bookings/OfferComposer.tsx` (line 7 import, 130 honesty line)
- Modify: `apps/mobile/src/bookings/MusicianBrowse.tsx` (line 9 import, 131 honesty line)
- Modify: `apps/web/src/bookings/BookingInbox.tsx` (lines 2 to 12 imports, 129 to 144 `SolidRow`,
  146 to 217 rows, new `useCounterparty`, `useCounterpartyReliability`, `CounterpartyLine`)
- Modify: `apps/mobile/src/bookings/BookingInbox.tsx` (lines 3 to 11 imports, 109 to 154 rows, new hooks
  and `CounterpartyLine`)
- Modify: `apps/web/src/bookings/BookingThread.tsx` (lines 8 and 12 to 17 imports, after 179
  `useOpenRunDates`, after 352 `threadFull`, 537 to 541 header, 557 to 559 run notice, 574 to 581
  buttons and cap reason, 601 to 627 preview, 649 confirm gate)
- Modify: `apps/mobile/src/bookings/BookingThread.tsx` (lines 8 and 12 to 16 imports, after 130
  `useOpenRunDates`, after 225 `threadFull` and flash, 366 to 371 header, 387 to 389 run notice,
  402 to 410 buttons and cap reason, 427 to 452 preview and flash, 466 confirm gate, 517 to 519
  `confirmedAt`)
- Modify: `apps/mobile/src/bookings/CancelDialog.tsx` (lines 13 to 16 import, 29 to 38 props, 45 to 54 warning)
- Modify: `apps/web/app/dashboard/curator/[profileId]/gigs/[gigId]/page.tsx` (lines 7 to 23 imports,
  new `BookedActLine`, after 281 the mount)
- Modify: `apps/mobile/app/(curator)/events/[gigId].tsx` (lines 6 to 18 imports, new `BookedActCard`,
  after 232 the mount)
- Modify: `apps/web/app/dashboard/curator/[profileId]/gigs/page.tsx` (lines 188 to 191),
  `apps/web/app/dashboard/curator/[profileId]/series/[seriesId]/page.tsx` (lines 221 to 223),
  `apps/mobile/app/(curator)/events/index.tsx` (lines 506 to 508),
  `apps/mobile/app/(curator)/events/series/[seriesId].tsx` (lines 181 to 183)
- Modify: `apps/web/src/gigs/GigForms.tsx` (lines 2 to 6 imports, 103 to 106 `recurrenceFrom`, 309 to 311
  helper copy, 326 to 359 `endDateInputToUtcMs` replaced), `apps/mobile/src/gigs/GigForms.tsx`
  (lines 2 to 6 imports, 147 to 150 `recurrenceFrom`, 387 to 389 helper copy, 401 to 426 replaced)
- Modify: the four series-form callers: `apps/web/app/dashboard/curator/[profileId]/gigs/new/page.tsx`
  (lines 11 and 130), `apps/web/app/dashboard/curator/[profileId]/series/[seriesId]/page.tsx` (lines 11
  and 73), `apps/mobile/app/(curator)/events/new.tsx` (lines 11 and 148),
  `apps/mobile/app/(curator)/events/series/[seriesId].tsx` (lines 10 and 62)
- Test: web live loads of `/gigs`, `/gigs/[gigId]`, `/dashboard/bookings/[bookingId]` (both sides),
  `/dashboard/curator/[profileId]/gigs/[gigId]`, `/dashboard/curator/[profileId]/gigs`; mobile
  typecheck, lint, export

**Interfaces:**
- Consumes: `GigDoc.fillMode` (`"whole_run" | "per_occurrence" | null`, stamped by the materializer
  and `createGig` in section B3), `THREAD_FULL_MESSAGE`, `MAX_BOOKING_THREAD_ENTRIES`,
  `CANCEL_GRACE_MS`, `CURATOR_FORFEIT_WINDOW_HOURS`, `MUSICIAN_MARK_WINDOW_HOURS`, `LAUNCH_TIMEZONE`,
  `DEPOSIT_PERCENT` from `@gatekeep/shared`; the public-provable open-dates query
  `gigs where seriesId == X and status == "open"` (both fields are equality pins, `status == "open"` is
  the public disjunct of the gigs read rule); `profiles/{id}` public gets for approved profiles;
  `profiles/{id}/private/curatorBooking` under `curatorAccess`; `formatReliabilityLine` from Task 25;
  `launchTzNextDayStartMs` from both `BookingForms.tsx` files; `callFn` from Task 27.
- Produces:
  - `DEPOSIT_HONESTY_RUN_LINE` in both `BookingForms.tsx`.
  - `useCounterparty(profileId)`, `useCounterpartyReliability(musicianProfileId)`, and
    `CounterpartyLine({ musicianProfileId, curatorProfileId, mySide })` exported from both
    `BookingInbox.tsx` (thread headers and the curator gig pages reuse them).
  - `useOpenRunDates(seriesId): number | null` exported from both `BookingThread.tsx`.
  - `endDateInputToLaunchTzEndMs(value)` and `launchTzDateInput(ms)` in both `GigForms.tsx`;
    `endDateInputToUtcMs` is removed from both.

**Steps:**

- [ ] **Step 1: Run variant of the deposit honesty line.** In `apps/web/src/bookings/BookingForms.tsx`
  after line 41 add:

```ts
// The whole-run twin (sp4 audit finding 2): on a whole_run series the deposit
// is charged PER DATE, for every open date of the run, at accept. Rendered
// wherever DEPOSIT_HONESTY_LINE is, whenever the gig's own fillMode says so.
export const DEPOSIT_HONESTY_RUN_LINE =
  `If accepted, a ${DEPOSIT_PERCENT}% deposit is charged to the curator's card per date, for every open date of the run.`;
```

  and the identical constant in `apps/mobile/src/bookings/BookingForms.tsx` after line 27.

- [ ] **Step 2: "Books as a run" on browse cards and gig detail.** Web `apps/web/src/bookings/GigBrowse.tsx`
  lines 16 to 25 become:

```ts
// The badge names only what the public gig doc itself proves: real status,
// and, since section B3 stamps fillMode onto every occurrence doc, whether
// the gig books as a run. A cadence ("Weekly") still needs the member-only
// gigSeries doc and stays off this public grid.
function gigBadgeLabel(gig: GigRow): string {
  if (gig.fillMode === "whole_run") return "Books as a run";
  return gig.seriesId != null ? "Recurring series" : "Open for applications";
}
```

  Web `apps/web/app/gigs/[gigId]/page.tsx`: delete `useSeriesFillMode` (lines 24 to 46) and the
  `GigSeriesDoc`, `FillMode` names from the type import at line 15 (`getDoc` stays: the curator-name
  lookup uses it); delete line 173. Replace lines 239 to 241 with:

```ts
  const seriesLine = gig.fillMode === "whole_run" ? "Books as a run: one act plays every open date"
    : gig.fillMode === "per_occurrence" ? "Part of a recurring series: each date booked separately"
    : "Part of a recurring series";
```

  and lines 266 to 268 with:

```tsx
      {gig.seriesId != null && (
        <div className="mt-4 grid gap-1.5">
          <Badge variant="outline" className="w-fit">{seriesLine}</Badge>
          {gig.fillMode === "whole_run" && (
            <p className="font-sora text-sm text-gk-muted">
              Applying here applies to every open date of this run, plus dates added later, under one booking.
            </p>
          )}
        </div>
      )}
```

  Line 149 (the ApplyPanel honesty line) becomes:

```tsx
      <p className="font-sora text-xs text-gk-muted">{gig.fillMode === "whole_run" ? DEPOSIT_HONESTY_RUN_LINE : DEPOSIT_HONESTY_LINE}</p>
```

  with `DEPOSIT_HONESTY_RUN_LINE` added to the `BookingForms` import (lines 10 to 13). Mobile
  `apps/mobile/src/bookings/GigBrowse.tsx`: add `DEPOSIT_HONESTY_RUN_LINE` to line 9's import; line
  100 becomes `<Text variant="meta" muted>{gig.fillMode === "whole_run" ? DEPOSIT_HONESTY_RUN_LINE : DEPOSIT_HONESTY_LINE}</Text>`;
  lines 128 and 175 both become:

```tsx
                {gig.seriesId != null && (
                  <StatusBadge label={gig.fillMode === "whole_run" ? "Books as a run" : "Part of a recurring series"} status="neutral" />
                )}
```

  and under line 128's badge in the detail modal add:

```tsx
                {gig.fillMode === "whole_run" && (
                  <Text muted>Applying here applies to every open date of this run, plus dates added later, under one booking.</Text>
                )}
```

  The offer composers pick the line from the selected gig: web `apps/web/src/bookings/OfferComposer.tsx`
  line 130 becomes
  `<p className="font-sora text-xs text-gk-muted">{selectedGig?.fillMode === "whole_run" ? DEPOSIT_HONESTY_RUN_LINE : DEPOSIT_HONESTY_LINE}</p>`
  (import at line 7); mobile `apps/mobile/src/bookings/MusicianBrowse.tsx` line 131 becomes
  `<Text variant="meta" muted>{selectedGig?.fillMode === "whole_run" ? DEPOSIT_HONESTY_RUN_LINE : DEPOSIT_HONESTY_LINE}</Text>`
  (import at line 9).

- [ ] **Step 3: Counterparty hooks and line (web inbox).** In `apps/web/src/bookings/BookingInbox.tsx`
  add `import Link from "next/link";` and `import { Skeleton } from "../ui/skeleton";`, add
  `formatReliabilityLine` to the `BookingForms` import and `type CuratorBookingDoc, type ProfileDoc`
  to the shared import (lines 6 to 9). After `useNextOccurrence` (line 121) add:

```tsx
// The other party's name and handle (sp4 audit finding 3). A booking only
// exists between two approved profiles, so profiles/{id} is a public get;
// a profile rejected since the booking was made reads permission-denied,
// which renders as "unavailable" rather than an error. n+1 per row, same
// sanction as useRowGigTitle above.
export type Counterparty = { name: string; handle: string | null } | null | "loading";
export function useCounterparty(profileId: string | undefined): Counterparty {
  const [state, setState] = useState<Counterparty>("loading");
  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    getDoc(doc(getFirebase().db, "profiles", profileId))
      .then((s) => {
        if (cancelled) return;
        if (!s.exists()) { setState(null); return; }
        const p = s.data() as ProfileDoc;
        setState({ name: p.name, handle: p.handle ?? null });
      })
      .catch(() => { if (!cancelled) setState(null); });
    return () => { cancelled = true; };
  }, [profileId]);
  return profileId ? state : null;
}

// Curator side only: the same reliability line Find musicians renders, read
// from the projection curatorAccess already grants (firestore.rules'
// curatorBooking read rule). Undefined musicianProfileId (a musician-side
// viewer) skips the read entirely.
export function useCounterpartyReliability(musicianProfileId: string | undefined): string | null {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    if (!musicianProfileId) return;
    let cancelled = false;
    getDoc(doc(getFirebase().db, `profiles/${musicianProfileId}/private/curatorBooking`))
      .then((s) => { if (!cancelled) setLine(s.exists() ? formatReliabilityLine((s.data() as CuratorBookingDoc).reliability) : null); })
      .catch(() => { if (!cancelled) setLine(null); });
    return () => { cancelled = true; };
  }, [musicianProfileId]);
  return musicianProfileId ? line : null;
}

// "with {name}" plus, for a curator viewer, the act's reliability. A real
// <Link> to the public page: /@handle serves both profile types
// (app/u/[handle]). Rendered as a SIBLING of the row's own anchor (SolidRow's
// `aside` slot), never inside it: an anchor nested in an anchor is invalid
// HTML and browsers split it unpredictably.
export function CounterpartyLine({ musicianProfileId, curatorProfileId, mySide }: {
  musicianProfileId: string; curatorProfileId: string; mySide: BookingSide;
}) {
  const otherId = mySide === "curator" ? musicianProfileId : curatorProfileId;
  const other = useCounterparty(otherId);
  const reliability = useCounterpartyReliability(mySide === "curator" ? musicianProfileId : undefined);
  if (other === "loading") return <Skeleton className="h-3 w-40" />;
  if (!other) return <span className="font-sora text-xs text-gk-muted">with a profile that is no longer available</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 font-sora text-xs text-gk-muted">
      with{" "}
      {other.handle ? (
        <Link href={`/@${other.handle}`} className="font-medium text-gk-text underline underline-offset-4 hover:text-gk-focus">
          {other.name}
        </Link>
      ) : (
        <span className="font-medium text-gk-text">{other.name}</span>
      )}
      {reliability && <span>· {reliability}</span>}
    </span>
  );
}
```

  Replace `SolidRow` (lines 129 to 144) so the counterparty renders beside the row's anchor:

```tsx
function SolidRow({ href, children, aside, className }: {
  href: string; children: ReactNode; aside?: ReactNode; className?: string;
}) {
  return (
    <li
      className={cn(
        "grid gap-1 rounded-gk border border-gk-border bg-gk-surface px-4 py-3 transition-colors hover:border-gk-accent/50",
        className,
      )}
    >
      <a href={href} className="flex min-w-0 items-center justify-between gap-3 outline-none focus-visible:ring-2 focus-visible:ring-gk-focus">
        {children}
      </a>
      {aside}
    </li>
  );
}
```

  and thread `mySide` into every row (lines 146 to 217): `OpenThreadRow` passes
  `aside={<CounterpartyLine musicianProfileId={row.musicianProfileId} curatorProfileId={row.curatorProfileId} mySide={mySide} />}`
  to `SolidRow`; `ConfirmedRow` and `HistoryRow` gain a `mySide: BookingSide` prop and pass the same
  `aside` (the `ConfirmedRow` `DateBlockRow` branch renders the line as a sibling `<div className="mt-1 px-3">` inside its `<li>`, after the `DateBlockRow`); the three `map` calls at lines 289, 299,
  and 307 pass `mySide={role}`.

- [ ] **Step 4: Counterparty on mobile inbox rows.** In `apps/mobile/src/bookings/BookingInbox.tsx`
  add the same two hooks (identical bodies; `Skeleton` from `../ui`, `type CuratorBookingDoc, type ProfileDoc`
  from shared, `formatReliabilityLine` from `./BookingForms`) after `useNextOccurrence` (line 107),
  and this line component (mobile links only to `/artist/[handle]`: there is no curator public route on
  mobile yet, so a curator counterparty renders as a plain name):

```tsx
export function CounterpartyLine({ musicianProfileId, curatorProfileId, mySide }: {
  musicianProfileId: string; curatorProfileId: string; mySide: BookingSide;
}) {
  const router = useRouter();
  const otherId = mySide === "curator" ? musicianProfileId : curatorProfileId;
  const other = useCounterparty(otherId);
  const reliability = useCounterpartyReliability(mySide === "curator" ? musicianProfileId : undefined);
  if (other === "loading") return <Skeleton height={12} width="55%" />;
  if (!other) return <Text variant="meta" muted>with a profile that is no longer available</Text>;
  const linkable = mySide === "curator" && other.handle;
  return (
    <Text variant="meta" muted>
      with{" "}
      <Text
        variant="meta"
        style={linkable ? { textDecorationLine: "underline" } : undefined}
        onPress={linkable ? () => router.push({ pathname: "/artist/[handle]", params: { handle: other.handle! } }) : undefined}
        accessibilityRole={linkable ? "link" : undefined}
      >
        {other.name}
      </Text>
      {reliability ? ` · ${reliability}` : ""}
    </Text>
  );
}
```

  Each of `OpenThreadRow`, `ConfirmedRow`, `HistoryRow` (lines 109 to 154) gains `mySide: BookingSide`
  and renders `<CounterpartyLine musicianProfileId={row.musicianProfileId} curatorProfileId={row.curatorProfileId} mySide={mySide} />`
  after its title `Text`; the three `map` calls (lines 206, 212, 218) pass `mySide={role}`.

- [ ] **Step 5: Web thread: run notice, preview, cap, header.** In `apps/web/src/bookings/BookingThread.tsx`:
  - line 8: `import { bookingHistoryLabel, depositLine, CounterpartyLine } from "./BookingInbox";`
  - lines 12 to 17: add `THREAD_FULL_MESSAGE` to the shared import.
  - after `useOccurrences` (line 179) add:

```ts
// Open dates of a whole-run series, live (sp4 audit findings 2 and 8): the
// count both the run notice and the accept preview render. Public-provable
// (seriesId and status are equality pins; "open" is the public disjunct of
// the gigs read rule), no membership needed, so either side can read it.
// Null while loading or when the query fails; the accept confirm stays
// disabled on null so a whole-run charge is never confirmed blind.
export function useOpenRunDates(seriesId: string | null): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!seriesId) return;
    const { db } = getFirebase();
    const unsub = onSnapshot(
      query(collection(db, "gigs"), where("seriesId", "==", seriesId), where("status", "==", "open")),
      (snap) => setCount(snap.size),
      () => setCount(null));
    return () => { unsub(); };
  }, [seriesId]);
  return seriesId ? count : null;
}
```

  - after `const now = useNow();` (line 304) add `const openRunDates = useOpenRunDates(booking !== "loading" && booking !== "unavailable" && booking ? booking.seriesId : null);`
    (hooks stay unconditional; the early returns come after).
  - after `lastEntry` (line 352) add:

```ts
  // sp4 audit finding 16: counterBooking refuses at the cap with
  // resource-exhausted; the button is disabled with the reason shown, while
  // accept, decline, and withdraw stay available exactly as the server allows.
  const threadFull = booking.thread.length >= MAX_BOOKING_THREAD_ENTRIES;
```

  - replace the header (lines 537 to 541) with:

```tsx
      <div className="grid gap-1">
        <h1 className="font-syne text-2xl font-extrabold text-gk-text sm:text-3xl">{gigTitle}</h1>
        <p className="font-sora text-sm text-gk-muted">
          {BUDGET_STRUCTURE_LABEL[booking.structure]} · Status: {booking.status.replace(/_/g, " ")}
        </p>
        <CounterpartyLine musicianProfileId={booking.musicianProfileId} curatorProfileId={booking.curatorProfileId} mySide={mySide} />
      </div>
```

  - directly after the `<h2 ...>Respond</h2>` line (559) add the run notice, shown to both sides:

```tsx
          {booking.seriesId != null && (
            <p className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
              <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                Books as a run: accepting covers every open date of this series
                {openRunDates != null ? ` (${openRunDates} open right now)` : ""} plus any date added later.
                Deposits, settlement, and cancellations are per date.
              </span>
            </p>
          )}
```

  - replace the Counter button (line 577) and add the visible reason after the button row (line 581):

```tsx
                <Button onClick={() => setShowCounterForm(true)} disabled={actionBusy !== null || threadFull}
                  title={threadFull ? THREAD_FULL_MESSAGE : undefined} variant="secondary">Counter…</Button>
```

```tsx
              {threadFull && <p className="font-sora text-xs text-gk-muted">{THREAD_FULL_MESSAGE}</p>}
```

  - replace the curator-side preview (lines 601 to 627) with:

```tsx
                        {mySide === "curator" ? (
                          <>
                            <p className="font-sora text-sm text-gk-muted">
                              {booking.seriesId != null ? "Per date: " : "Due now: "}{formatCents(preview.chargePreview.totalCents)}{" "}
                              ({formatCents(preview.chargePreview.sliceCents)} deposit{" + "}
                              {formatCents(preview.chargePreview.feeCents)} service fee)
                            </p>
                            {/* sp4 audit finding 8: the run total comes from the
                                live open-dates query, not occurrences[] (which
                                is empty pre-accept). Confirm stays disabled
                                until the count is known. */}
                            {booking.seriesId != null && (openRunDates == null ? (
                              <p className="font-sora text-sm text-gk-muted">Counting the run&apos;s open dates…</p>
                            ) : (
                              <p className="font-sora text-sm font-medium text-gk-text">
                                {openRunDates} date{openRunDates === 1 ? "" : "s"}, {formatCents(preview.chargePreview.totalCents * openRunDates)} due now.
                              </p>
                            ))}
                            <p className="font-sora text-sm text-gk-muted">
                              Remaining {100 - DEPOSIT_PERCENT}% + fee auto-charges after each date.
                            </p>
                          </>
                        ) : (
                          <p className="font-sora text-sm text-gk-muted">
                            The curator&apos;s card is charged the deposit{booking.seriesId != null ? " for every open date" : ""} when you accept.
                          </p>
                        )}
```

  - the Confirm accept button (line 649) becomes:

```tsx
                      <Button onClick={accept} disabled={actionBusy !== null || !preview || (booking.seriesId != null && openRunDates == null)}>
```

- [ ] **Step 6: Mobile thread: the same, plus the ported grace flash.** In
  `apps/mobile/src/bookings/BookingThread.tsx`:
  - line 8: `import { bookingHistoryLabel, depositLine, CounterpartyLine } from "./BookingInbox";`
  - lines 12 to 16: add `THREAD_FULL_MESSAGE, CANCEL_GRACE_MS, CURATOR_FORFEIT_WINDOW_HOURS, MUSICIAN_MARK_WINDOW_HOURS`
    to the shared import; add `IconWarningCircle` to the `../ui` import (line 17).
  - after `useOccurrences` (line 130) add `useOpenRunDates` with the identical body to web's Step 5.
  - after `const now = useNow();` (line 194) add the same `openRunDates` line as web.
  - after `lastEntry` (line 225) add `threadFull` (same as web) and the flash the web thread has at
    lines 391 to 405 (sp4 audit finding 6, the recorded half):

```ts
  // Ported from web (SP5 Task 15 review round 1): side-appropriate
  // starts-soon flash inside the accept confirm. "1-hour" derives from
  // CANCEL_GRACE_MS so the copy can never drift from the constant.
  const graceHours = CANCEL_GRACE_MS / 3_600_000;
  const flashWindowHours = mySide === "curator" ? CURATOR_FORFEIT_WINDOW_HOURS : MUSICIAN_MARK_WINDOW_HOURS;
  const startsSoonFlash = now != null && gig !== "loading" && gig !== "unavailable" && gig != null
    && (gig.startsAt - now) < flashWindowHours * 3_600_000;
```

  - replace the header (lines 366 to 371) with:

```tsx
      <View style={{ gap: tokens.space.xs }}>
        <Text variant="heading">{gigTitle}</Text>
        <Text muted>
          {BUDGET_STRUCTURE_LABEL[booking.structure]} · Status: {booking.status.replace(/_/g, " ")}
        </Text>
        <CounterpartyLine musicianProfileId={booking.musicianProfileId} curatorProfileId={booking.curatorProfileId} mySide={mySide} />
      </View>
```

  - after `<Text variant="title">Respond</Text>` (line 389) add:

```tsx
          {booking.seriesId != null && (
            <Callout tone="warning">
              <Text color={t.warning}>
                Books as a run: accepting covers every open date of this series
                {openRunDates != null ? ` (${openRunDates} open right now)` : ""} plus any date added later.
                Deposits, settlement, and cancellations are per date.
              </Text>
            </Callout>
          )}
```

  - the Counter button (lines 405 to 406) becomes
    `<Button variant="secondary" title="Counter…" onPress={() => setShowCounterForm(true)} disabled={actionBusy !== null || threadFull} />`
    and after the button row (line 410) add `{threadFull && <Text variant="meta" muted>{THREAD_FULL_MESSAGE}</Text>}`.
  - replace the curator-side preview (lines 427 to 452) with the mobile rendering of web's Step 5
    block (`Text muted` for the per-date line, `Text variant="label"` for the "N dates, $X due now"
    line, `Text muted` for "Counting the run's open dates…", and the neutral musician line with
    " for every open date" appended when `booking.seriesId != null`), then, still inside the
    `preview ?` branch and after the side-specific block, the ported flash:

```tsx
                      {startsSoonFlash && (
                        <Callout tone="warning" style={{ flexDirection: "row", gap: tokens.space.xs, alignItems: "flex-start" }}>
                          <IconWarningCircle size={16} color={t.warning} />
                          <Text style={{ flex: 1 }} color={t.warning}>
                            {mySide === "curator"
                              ? `This booking starts soon. Once accepted it's final after a ${graceHours}-hour grace period (cancelling later forfeits your deposit).`
                              : `This booking starts soon. Once accepted it's final after a ${graceHours}-hour grace period (cancelling less than ${MUSICIAN_MARK_WINDOW_HOURS}h out adds a reliability mark).`}
                          </Text>
                        </Callout>
                      )}
```

  - the Confirm accept button (line 466) gains `|| (booking.seriesId != null && openRunDates == null)` in its `disabled`.
  - lines 517 to 519 pass the accept timestamp: add `confirmedAt={booking.confirmedAt}` to the `CancelDialog` props.

- [ ] **Step 7: Mobile CancelDialog grace notice (the unrecorded half of sp4 finding 6).** In
  `apps/mobile/src/bookings/CancelDialog.tsx` add `CANCEL_GRACE_MS` to the shared import (lines 13 to
  16), add the prop to the signature (lines 29 to 38):

```ts
  // The booking's accept timestamp (web parity, SP5 Task 15): within
  // CANCEL_GRACE_MS of now the post-accept grace neutralizes EITHER side's
  // penalty regardless of the window math below. Omitted or null shows the
  // ordinary window warning.
  confirmedAt?: number | null;
```

  and replace the warning derivation (lines 45 to 54) with:

```ts
  const hoursBeforeStart = now == null ? null : (startsAt - now) / 3_600_000;
  const hoursLabel = hoursBeforeStart == null ? null : Math.max(0, Math.round(hoursBeforeStart));
  const depositRef = depositAmountCents != null ? ` (${formatCents(depositAmountCents)})` : "";
  // Advisory only: the server recomputes the grace window from ITS OWN now at
  // commit time (bookingLifecycle.ts's executeCancellation); a few seconds of
  // clock drift at the boundary is accepted, same as the window math below.
  const inGracePeriod = now != null && confirmedAt != null && (now - confirmedAt) < CANCEL_GRACE_MS;
  const graceHours = CANCEL_GRACE_MS / 3_600_000;
  const warning = hoursBeforeStart == null ? "Checking the cancellation window…"
    : inGracePeriod
      ? `You're within the ${graceHours}-hour grace period after accepting. Cancelling now is penalty-free, regardless of the usual cancellation window.`
      : side === "curator"
    ? (hoursBeforeStart < CURATOR_FORFEIT_WINDOW_HOURS
        ? `Cancelling now forfeits your deposit${depositRef}. The gig is in ${hoursLabel}h.`
        : `Cancelling now refunds your deposit${depositRef}. This is outside the ${CURATOR_FORFEIT_WINDOW_HOURS}h forfeiture window.`)
    : (hoursBeforeStart < MUSICIAN_MARK_WINDOW_HOURS
        ? "This will add a no-show mark to your reliability record. The gig is less than 24 hours away."
        : "Cancelling now: the curator's deposit will be refunded, and no reliability mark will be applied.");
```

  (`confirmedAt` joins the destructured props on line 29.)

- [ ] **Step 8: The curator's gig page names the booked act (sp4 finding 7).** Web
  `apps/web/app/dashboard/curator/[profileId]/gigs/[gigId]/page.tsx`: add
  `import { useCounterparty } from "../../../../../../src/bookings/BookingInbox";` beside the other
  `src/` imports (lines 7 to 23) and this component above `GigEditor`:

```tsx
// A filled gig used to show "Filled" and nothing else: cancelGig then refuses
// with "cancel the booking instead" and there was no path to it. The act's
// name links to its public page, the row links to the booking thread.
function BookedActLine({ bookingId, musicianProfileId }: { bookingId: string; musicianProfileId: string | null }) {
  const act = useCounterparty(musicianProfileId ?? undefined);
  return (
    <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-gk border border-gk-border bg-gk-surface px-3.5 py-2.5 font-sora text-sm text-gk-text">
      <span>Booked act:</span>
      {act === "loading" ? (
        <Skeleton className="h-4 w-32" />
      ) : act ? (
        act.handle
          ? <Link href={`/@${act.handle}`} className="font-medium underline underline-offset-4 hover:text-gk-focus">{act.name}</Link>
          : <span className="font-medium">{act.name}</span>
      ) : (
        <span className="text-gk-muted">unavailable</span>
      )}
      <Link href={`/dashboard/bookings/${bookingId}`} className="ml-auto text-gk-muted underline underline-offset-4 hover:text-gk-text">
        Open the booking
      </Link>
    </p>
  );
}
```

  Mount it after the series notice block (closing at line 281):

```tsx
      {gig.bookingId && <BookedActLine bookingId={gig.bookingId} musicianProfileId={gig.bookedMusicianProfileId} />}
```

  Mobile `apps/mobile/app/(curator)/events/[gigId].tsx`: add
  `import { useCounterparty } from "../../../src/bookings/BookingInbox";` (imports at lines 6 to 18)
  and above `GigEditor`:

```tsx
function BookedActCard({ bookingId, musicianProfileId }: { bookingId: string; musicianProfileId: string | null }) {
  const router = useRouter();
  const act = useCounterparty(musicianProfileId ?? undefined);
  return (
    <Card style={{ gap: 8 }}>
      <Text variant="label">Booked act</Text>
      {act === "loading" ? <Skeleton height={16} width="50%" />
        : act ? (
          <Text
            style={act.handle ? { textDecorationLine: "underline" } : undefined}
            onPress={act.handle ? () => router.push({ pathname: "/artist/[handle]", params: { handle: act.handle! } }) : undefined}
          >
            {act.name}
          </Text>
        ) : <Text muted>Profile no longer available.</Text>}
      <Button title="Open the booking →" variant="secondary"
        onPress={() => router.push({ pathname: "/booking/[bookingId]", params: { bookingId } })} />
    </Card>
  );
}
```

  mounted after the series card (closing at line 232):

```tsx
        {gig.bookingId && <BookedActCard bookingId={gig.bookingId} musicianProfileId={gig.bookedMusicianProfileId} />}
```

- [ ] **Step 9: "(UTC)" on the series summaries (spec 6.10).** The recurrence hour and minute are
  UTC-interpreted (the materializer's `Date.UTC` anchor) while every other time in the product renders
  in `LAUNCH_TIMEZONE`, so the summaries say so:
  - `apps/web/app/dashboard/curator/[profileId]/gigs/page.tsx` lines 188 to 191:

```tsx
                  <p className="mt-1 font-sora text-sm text-gk-muted">
                    {WEEKDAY_LABELS[s.recurrence.weekday]}s, {String(s.recurrence.hour).padStart(2, "0")}:
                    {String(s.recurrence.minute).padStart(2, "0")} (UTC), {formatChipLabel(s.recurrence.cadence)}
                  </p>
```

  - `apps/web/app/dashboard/curator/[profileId]/series/[seriesId]/page.tsx` lines 221 to 223:

```ts
  const cadenceSummary =
    `${WEEKDAY_LABELS[series.recurrence.weekday]}s, ` +
    `${String(series.recurrence.hour).padStart(2, "0")}:${String(series.recurrence.minute).padStart(2, "0")} (UTC), ${formatChipLabel(series.recurrence.cadence)}`;
```

  - `apps/mobile/app/(curator)/events/index.tsx` lines 506 to 508:

```tsx
                <Text variant="meta" muted>
                  {WEEKDAY_LABELS[s.recurrence.weekday]}s, {String(s.recurrence.hour).padStart(2, "0")}:{String(s.recurrence.minute).padStart(2, "0")} (UTC), {s.recurrence.cadence}
                </Text>
```

  - `apps/mobile/app/(curator)/events/series/[seriesId].tsx` lines 181 to 183:

```ts
  const cadenceSummary =
    `${WEEKDAY_LABELS[series.recurrence.weekday]}s, ` +
    `${String(series.recurrence.hour).padStart(2, "0")}:${String(series.recurrence.minute).padStart(2, "0")} (UTC), ${series.recurrence.cadence}`;
```

- [ ] **Step 10: Series end date submitted as end-of-day in LAUNCH_TIMEZONE.** In
  `apps/web/src/gigs/GigForms.tsx` add `LAUNCH_TIMEZONE` to the shared import (lines 2 to 6) and
  `import { launchTzNextDayStartMs } from "../bookings/BookingForms";` beside the other `../` imports
  (BookingForms imports only `gigDisplay` and `src/ui`, so no cycle). Replace `endDateInputToUtcMs`
  (lines 326 to 359) with:

```ts
// Spec 6.10: the series end date is INCLUSIVE of that calendar day in
// LAUNCH_TIMEZONE. Submitted as the last millisecond of that day (the launch
// zone's next-day midnight minus one, DST-correct because
// launchTzNextDayStartMs derives the boundary from the actual next calendar
// date), so an occurrence whose recurrence time lands anywhere on the end
// date is still materialized. The old UTC-midnight parse silently dropped
// the final date for every recurrence time after 00:00 UTC. Returns null for
// an empty or malformed input (same contract as before; the callers pass
// null through as "no end date").
export function endDateInputToLaunchTzEndMs(value: string): number | null {
  const nextStart = launchTzNextDayStartMs(value);
  return nextStart == null ? null : nextStart - 1;
}

// The reverse mapping for the editors: the Y-M-D a stored endDate falls on
// in LAUNCH_TIMEZONE. A legacy UTC-midnight endDate reads back as the
// previous launch-zone day; re-saving it moves the bound LATER (to the end
// of that day), never earlier, so no already-promised date disappears.
export function launchTzDateInput(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LAUNCH_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
```

  `recurrenceFrom` (lines 103 to 106) becomes:

```ts
export const recurrenceFrom = (r: GigRecurrence, fillMode: FillMode): RecurrenceState => ({
  weekday: r.weekday, time: `${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}`,
  cadence: r.cadence, endDate: r.endDate ? launchTzDateInput(r.endDate) : "", fillMode,
});
```

  and the helper copy (lines 309 to 311):

```tsx
      <p className="font-sora text-xs text-gk-muted">
        The time above is UTC for now, local-timezone support is coming. The end date is inclusive: the series runs through the end of that day.
      </p>
```

  Mobile `apps/mobile/src/gigs/GigForms.tsx`: `LAUNCH_TIMEZONE` is already imported (line 3); add
  `import { launchTzNextDayStartMs } from "../bookings/BookingForms";` after line 8, replace lines
  401 to 426 with the identical two functions, `recurrenceFrom` (lines 147 to 150) uses
  `launchTzDateInput(r.endDate)`, and the helper copy (lines 387 to 389) becomes the same sentence
  as web in a `UiText variant="meta" color={tok.warning}`.

  The four callers swap the import name and the call: web `gigs/new/page.tsx` line 11 and line 130
  (`endDate: endDateInputToLaunchTzEndMs(recurrence.endDate)`), web `series/[seriesId]/page.tsx`
  lines 11 and 73, mobile `events/new.tsx` lines 11 and 148, mobile `events/series/[seriesId].tsx`
  lines 10 and 62. Grep gate: `git grep -n "endDateInputToUtcMs" -- apps` returns nothing.

- [ ] **Step 11: Gates and live checks.** `pnpm typecheck`, both lints, web build, mobile export. Live
  (web, emulators), with a whole-run series that has three open dates and one application on it:
  1. `/gigs`: the run's cards carry the "Books as a run" badge; `/gigs/<gigId>` shows the run badge,
     the "Applying here applies to every open date…" line, and the per-date deposit sentence.
  2. `/dashboard/bookings/<bookingId>` as the musician: header shows "with <venue name>" linked to
     `/@<handle>`; the run notice reads "(3 open right now)". As the curator: the header line adds
     "· 0 shows played · 0 no-shows"; Confirm accept shows "Per date: $X" and "3 dates, $3X due now."
     and is disabled until that line appears.
  3. Counter a thread up to 50 entries with the emulator (or set `thread` to a 50-entry array through
     the REST surface as in Task 25): "Counter…" is disabled and "Thread is full: accept, decline or
     withdraw." shows under the buttons; Accept still works.
  4. `/dashboard/curator/<profileId>/gigs/<filledGigId>`: "Booked act: <name>" links to `/@<handle>`
     and "Open the booking" lands on the thread. `/dashboard/curator/<profileId>/gigs`: the series
     summary reads "Fridays, 20:00 (UTC), Weekly".
  5. Create a series ending on a date whose UTC recurrence time is after 00:00 UTC: the emulator
     `gigSeries` doc's `recurrence.endDate` is `03:59:59.999Z` of the following day (Eastern end of
     day), and the materializer creates the occurrence on the end date itself.
  Mobile: the export bundles; the grace notice, run notice, and counterparty rows are on the owner's
  EAS smoke list (spec section 11).

- [ ] **Step 12: Commit.** `feat(clients): run consent copy and counts, counterparty names, cap reason, mobile grace warnings, series UTC label and inclusive end date`

---

### Task 33: README rewrite

**Files:**
- Modify: `README.md`, lines 1-23 (intro), 25-79 (monorepo map), 104-121 (key commands), 166-187 (dailySweep paragraphs), 278-282 (invite-guard bullet), 304-308 (fee table), 341-345 (payouts paragraph), 385-392 (paymentsSweep paragraph and "Not in sub-project 5"), 394-414 (env table), 510-527 (EAS bullets), 657-671 (webhook registration bullet), 702-707 (payout decision bullet), 869-892 (SP6 launch checklist), 972-998 (design docs). Two new sections are inserted: "Scripts" before line 143 (`## Gigs & series (sub-project 3)`) and "Events and ticketing (sub-project 6)" before line 394 (`## Environment variables`).
- Create: nothing.

**Interfaces:**
- Consumes: `docs/superpowers/audit/docs-consistency.md` findings A1, A2, A3, A8, A9, A10, A11, A12, A24, A26 (the edits), `docs/superpowers/sp6-rulings.md` "What shipped" and "Load-bearing rulings" (the SP6 section), spec sections 4.2, 4.3, 4.6, 8 and 11 (the go-live additions), `functions/src/scheduled.ts` and `functions/src/paymentsSweep.ts` step comments (the step lists), `git ls-files` (the map).
- Produces: README section headings that Task 34's HANDOFF table cites by name: "Scripts", "Events and ticketing (sub-project 6)", "Environment variables", "Manual follow-ups", "Sub-project 5 launch checklist (payments)", "Design docs".

**Steps:**

- [ ] **Step 1: confirm the baseline and every anchor.**

```bash
grep -c $'\xe2\x80\x94' README.md                                       # 0 (branch A swept it)
grep -n "This repo now spans three sub-projects" README.md            # 8
grep -n "first run scaffolds apps/mobile/eslint.config.js" README.md  # 120
grep -n "does five things in one" README.md                           # 167
grep -n "guard gaps" README.md                                        # 280
grep -n "| Instant cash-out |" README.md                              # 306
grep -n "Any member of a profile can trigger its payouts" README.md   # 344 and 702
grep -n "^| \`STRIPE_WEBHOOK_SECRET\`" README.md                      # 408
grep -n "EAS \`projectId\`" README.md                                 # 510
grep -n "Register the webhook endpoint in the Stripe dashboard" README.md   # 659
grep -n "Poster upload is not wired end to end" README.md             # 882
grep -n "^## Design docs" README.md                                   # 972
```

Every grep must hit exactly the line named (or one line, if numbers drifted). If any anchor is missing, stop: the README on this branch differs from the audited one and the edit list must be re-derived, not applied blind.

- [ ] **Step 2: replace the intro (lines 1-23, from `# GateKeep` through the paragraph ending "exact filenames under Design docs below).").**

```markdown
# GateKeep

GateKeep connects musicians, event curators (venues, planners, hosts), and fans in a single
metro area: team-approved musician and curator profiles, gig booking with escrowed payments, and
fan ticketing, built on a shared Firebase backend behind default-deny Firestore rules with every
privileged write in Cloud Functions.

The repo spans ten sub-projects, merged in this order: 1, 2, 3, 4, 5, 5b, 9A, 9B, 6, 10.
Sub-project 7 is in flight. Each merged sub-project has a rulings doc under `docs/superpowers/`
that is the authority for its area (the table under "Design docs" at the end lists them all), and
`docs/superpowers/HANDOFF.md` is the fresh-session entry point.

**Sub-project 1: Foundation.** Accounts (email, Google, Apple), group profiles with members and
admins, the draft, review, approve lifecycle, the admin approval dashboard, notification plumbing
(in-app inbox plus Expo push), and the mobile and web app shells.

**Sub-project 2: Musician portfolio.** Bio, photos, genres, links, up to ten 30-second reviewed
audio snippets with server-side trim and transcode, curator-gated booking rates and preferences,
and server-rendered public pages at `/@handle` on web with a native twin on mobile.

**Sub-project 3: Curator profiles and gig postings.** Venues, planners, and hosts get the same
wizard, photos, and public-page treatment; one-off and recurring gig postings with budget and
location privacy; the `dailySweep` scheduled job that materializes series and pays down earlier
cleanup debt; admin gig moderation and name search. See "Gigs & series" below.

**Sub-project 4: Booking flow.** Either side opens a booking (apply to an open gig, or offer a
gig directly), negotiates over a capped counter-offer thread, and accepting freezes the terms and
records a 35% deposit; cancellation windows, no-show reliability records, musician-controlled rate
visibility, and whole-run series booking. See "Booking flow" below.

**Sub-project 5: Payments.** Stripe Connect Express on the separate charges and transfers model:
the deposit is charged at accept, the remainder settles T+3 after each date ends, the musician's
share transfers to their connected account, a declined settlement duns and then flags the curator
delinquent, and profile admins cash out (standard or instant). **5b** carries the full action set
to mobile through the native PaymentSheet. See "Payments" below.

**Sub-project 9A: Web UI/UX.** The "Ember, Deeper Night" design language (repo-root `DESIGN.md`,
binding on all UI work), both themes, every web surface restyled. **9B** carries it to mobile: a
token theme layer, owned `src/ui` primitives, every screen restyled with branded loading, empty,
and error states.

**Sub-project 6: Events and ticketing.** Curator-published events (standalone or promoted from a
filled gig), multi-tier paid and free tickets with a fan-paid service fee on the sub-project 5
rails, T+1 settlement to the curator, QR door check-in, grace refunds, cancel with full
auto-refund, and email-targeted in-app transfers (mobile only). See "Events and ticketing" below.

**Sub-project 10: Hardening.** No new features. The whole-project audit's money, lifecycle, and
copy defects closed: transfer sourcing rules, two Stripe webhook scopes, dispute handling, the
settlement webhook race, events cancelled and refunded when their curator is unpublished, an admin
`takedownEvent`, deletion refusals with named blockers, an auth `onDelete` cascade, push-token
hygiene, a fail-closed geocoder, poster upload end to end, notification deep links, the door
scanner's offline panel, buyer order cancel with a five-minute expiry job, Node 22, CI, and the
repo-wide em-dash sweep that CI now enforces. Rulings: `docs/superpowers/sp10-rulings.md`.

**Sub-project 7: Fan discovery (in flight).** Follow artists, performance notifications, the fan
home and discover feeds, posters on cards, share links. It rebases onto 10 and adds its own
paragraph here at its merge.
```

- [ ] **Step 3: regenerate the monorepo map (lines 25-79, from `## Monorepo map` through the paragraph ending "call callables.").**

Generate the raw shape, then hand-annotate it into the target below (the command is the source of truth for names; the comments are yours):

```bash
git ls-files | cut -d/ -f1-3 | sort -u                      # every top-level, second-level, third-level path
git ls-files functions/src packages/shared/src scripts       # full listings for the three fully-enumerated dirs
grep -n "^export const [A-Za-z]* = " functions/src/*.ts | sed 's/ = .*//'   # which callable lives in which file
```

Target shape (every path must exist in `git ls-files`; the check in Step 17 enforces it):

```markdown
## Monorepo map

```
GateKeepBeta/
├── package.json                  # workspace root: typecheck, emu, emu:test, emu:rules scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json            # shared strict TS config
├── .nvmrc                        # Node 22 (sub-project 10)
├── .github/workflows/ci.yml      # every gate on every push and PR, then the em-dash grep (sub-project 10)
├── .github/dependabot.yml        # weekly npm updates for root, functions, apps/web, apps/mobile
├── firebase.json                 # emulators (auth, firestore, functions, storage :9199), functions runtime nodejs22
├── .firebaserc                   # default Firebase project id (gatekeep-dev-jg)
├── firestore.rules               # default-deny + narrow allows
├── firestore.indexes.json        # composite indexes + field overrides
├── storage.rules                 # staging/review/public paths
├── CLAUDE.md                     # session pointer to docs/superpowers/HANDOFF.md
├── DESIGN.md                     # binding brand contract for all UI work (sub-project 9A)
├── docs/superpowers/             # HANDOFF.md, specs/, plans/, one rulings doc per sub-project, audit/, mocks/
├── scripts/                      # seed-admin.ts, seed-test-accounts.ts, seed-test-event.ts (see Scripts)
├── packages/shared/              # @gatekeep/shared: the single source of truth for every cross-boundary shape
│   └── src/{types,validation,storagePaths,money,messages,paymentDisplay,feePreviews,index}.ts
├── functions/                    # Cloud Functions: v2 callables, triggers, schedulers, one HTTPS webhook
│   ├── src/index.ts              # exports every function
│   ├── src/guards.ts             # requireAuthUid, requireVerifiedEmail, requireProfileMember, requireMusicianProfile, requireCuratorProfile, requireApprovedCuratorProfile, requireApprovedMusicianProfile
│   ├── src/authTriggers.ts       # onUserCreated (users doc), onUserDocWritten, onUserDeleted (cascade, sub-project 10)
│   ├── src/profiles.ts           # createProfileDraft, submitProfileForReview, deleteProfile (money and events gates, sub-project 10)
│   ├── src/review.ts             # reviewProfile (unpublish cascade, events included since sub-project 10), grantAdmin, audit log
│   ├── src/members.ts            # inviteMember, respondToInvite, revokeInvite, removeMember, transferAdmin
│   ├── src/account.ts            # deleteAccount, cascadeDeleteUser (sub-project 10)
│   ├── src/notifications.ts      # notifyUser (inbox + Expo push, token pruning), approval trigger
│   ├── src/portfolio.ts          # updatePortfolio, updateBookingInfo (sub-project 2)
│   ├── src/tracks.ts             # createTrack, updateTrack, deleteTrack, reorderTracks, reviewTrack (sub-project 2)
│   ├── src/media.ts              # processUpload: ffmpeg transcode, sharp resize, posterUploads docs (sub-projects 2, 3, 6, 10)
│   ├── src/curator.ts            # updateCuratorProfile, removeCuratorPhoto, syncCuratorAccess (sub-project 3)
│   ├── src/geocode.ts            # Stub and Google geocoders; fails closed outside the emulator (sub-projects 3, 10)
│   ├── src/gigs.ts               # createGig, publishGig, updateGig, cancelGig, takedownGig (sub-project 3)
│   ├── src/gigSeries.ts          # createSeries, updateSeries, pauseSeries, endSeries (sub-project 3)
│   ├── src/scheduled.ts          # runDailySweep + dailySweep, nine steps (sub-projects 3, 4, 6, 10)
│   ├── src/adminTools.ts         # searchUsersByName, backfillDisplayNameLower, flagAccount (sub-project 3)
│   ├── src/storage.ts            # bucket helper + STORAGE_BUCKET
│   ├── src/bookings.ts           # applyToGig, offerGig, counterBooking, declineBooking, withdrawBooking, acceptBooking (sub-project 4)
│   ├── src/bookingLifecycle.ts   # cancelBooking, cancelOccurrence, reportNoShow, removeReliabilityMark (sub-project 4)
│   ├── src/bookingVisibility.ts  # rebuildBookingProjections, backfillBookingVisibility (sub-project 4)
│   ├── src/stripeClient.ts       # RealStripe and FakeStripe, both secrets, both webhook signing secrets (sub-projects 5, 10)
│   ├── src/payments.ts           # createSetupIntent, refreshPaymentMethod, createOnboardingLink, getStripeStatus, releaseStuckSaga, confirmOccurrenceActuals, payPastDue (sub-project 5)
│   ├── src/paymentsCore.ts       # deposit saga, ledger, admin alerts (sub-project 5)
│   ├── src/paymentsSettlement.ts # settlement math, true-ups, finalizeSettlementSuccess (sub-project 5)
│   ├── src/paymentsSweep.ts      # runPaymentsSweep + paymentsSweep, eleven steps; ticketOrderExpiry (sub-projects 5, 6, 10)
│   ├── src/paymentsPayouts.ts    # requestPayout (profile admins only), payout webhooks (sub-project 5)
│   ├── src/paymentsWebhook.ts    # stripeWebhook: claim machine, handler registry, disputes (sub-projects 5, 6, 10)
│   ├── src/eventsCore.ts         # pure event and order helpers (sub-project 6)
│   ├── src/events.ts             # createEvent, updateEvent, setEventTiers, publishEvent, cancelEvent, takedownEvent (sub-projects 6, 10)
│   ├── src/ticketing.ts          # createTicketOrder, finalizeTicketOrder, cancelTicketOrder, refundTicket, checkInTicket, undoCheckIn, offerTransfer, respondToTransfer (sub-projects 6, 10)
│   └── test/*.test.ts            # emulator integration tests (vitest)
├── apps/mobile/                  # Expo SDK 57 + expo-router
│   ├── app/(auth)/               # sign-in, sign-up; app/join.tsx is the wizard
│   ├── app/(fan)/                # index (upcoming events), search, tickets (QR wallet), account
│   ├── app/(musician)/           # dashboard, portfolio, gigs, bookings, messages, account
│   ├── app/(curator)/            # dashboard, events (gigs, series, event/[eventId], scan/[eventId]), bookings, musicians, messages, account
│   ├── app/artist/[handle].tsx   # native public artist page
│   ├── app/booking/[bookingId].tsx, app/event/[eventId].tsx
│   └── src/{auth,shell,ui,theme,portfolio,curator,gigs,bookings,payments,events,tickets,notifications,lib,types}/
├── apps/web/                     # Next.js 16 App Router
│   ├── app/u/[handle]/           # SSR public page, served as /@handle (rewrite in next.config.ts), plus shows/
│   ├── app/e/[eventId]/          # public event page + buy flow
│   ├── app/join/, app/sign-in/   # onboarding wizard, auth
│   ├── app/dashboard/            # page.tsx (account, delete), portfolio/, curator/, bookings/, earnings/, events/
│   ├── app/tickets/, app/gigs/   # fan wallet, gig directory (placeholder-grade until sub-project 8)
│   ├── app/admin/                # claim-gated admin: review queue, gigs, events takedowns, alerts
│   ├── app/design/, app/terms/, app/privacy/
│   └── src/{auth,shell,ui,components,marketing,portfolio,curator,gigs,bookings,payments,events,lib}/
└── tests-rules/                  # Firestore + Storage rules tests: rules, payments, events, storage
```

`packages/shared` owns every cross-boundary type, validation rule, money formula, and user-facing
message constant; functions and both apps import from it and nothing redefines a shape locally.
`functions` owns every privileged mutation. Apps own UI and only ever read Firestore directly or
call callables.
```

- [ ] **Step 4: key commands (lines 119-120).** Replace the two mobile-lint lines with:

```
pnpm --filter @gatekeep/shared test   # vitest for packages/shared (money math, validation, message constants)
pnpm --filter @gatekeep/mobile lint   # ESLint (apps/mobile), flat config at apps/mobile/eslint.config.js (tracked)
```

- [ ] **Step 5: dailySweep, nine steps (lines 166-187, the two paragraphs starting "**The daily scheduled job**" and "Each of the five steps").** Replace both with:

```markdown
**The daily scheduled job** (`functions/src/scheduled.ts`'s `dailySweep`, wrapping the plain
`runDailySweep(now)` that tests call directly) runs once a day at 09:00 in `LAUNCH_TIMEZONE` with
`retryCount: 3` and does nine things in one pass. Naming convention, binding in every doc from
sub-project 10 on: two sweeps exist, so a bare "step N" is ambiguous. Always write "dailySweep
step N" or "paymentsSweep step N".

1. dailySweep step 1: materializes new occurrences for every `active` gigSeries up to the 8-week
   horizon, births them `filled` on a whole-run booking, and flips a series whose `endDate` has
   passed to `ended` in the same batch as its watermark (sub-project 10).
2. dailySweep step 2: closes `open` gigs whose `startsAt` has passed.
3. dailySweep step 3: fails abandoned `processing` tracks older than 24h and deletes
   `posterUploads` docs older than 24h (sub-project 10).
4. dailySweep step 4: revokes `pending` invites past their 14-day expiry.
5. dailySweep step 5: retries `curatorAccessRetries/{uid}` entries left by a failed
   `syncCuratorAccess`.
6. dailySweep step 6: expires `open` bookings whose target gig is gone or no longer open, skipping
   a booking flagged `depositChargePending` (sub-project 10).
7. dailySweep step 7: resolves `confirmed` bookings whose committed dates are all done to
   `completed`.
8. dailySweep step 8: reminds ticket holders of `published` events starting within 24h, titled
   "Tonight" or "Tomorrow" from the launch-zone calendar day.
9. dailySweep step 9: drains `eventCascadeRetries/{eventId}`, the retry queue for events the
   unpublish cascade could not cancel and refund on the first pass (sub-project 10).

**This only runs in production after `firebase deploy` provisions the Cloud Scheduler job**: the
emulator has no scheduler component, so `runDailySweep` is exercised directly by tests locally,
never on a timer. See the launch checklist below for the UTC-recurrence caveat that affects
exactly when a series' occurrences land.

Each step runs in its own try/catch with its own chunked batch writer: a poisoned doc in one step
(a malformed series, say) is logged and counted in `SweepReport.errors` and never prevents the
other steps from running, and a step's own writes are lost only if that step's own commit never
happens. Steps 1 and 3 to 5 page through their collections (100 series per page, 500 docs per
page for the rest) rather than issuing one unbounded `.get()`, and step 1 additionally skips (and
counts) a series whose profile is already at the `MAX_OPEN_GIGS_PER_PROFILE` cap, or whose status
changed between the initial scan and that series' write. `dailySweep`'s `onSchedule` options set
`timeoutSeconds: 540` and `memory: "512MiB"` to give this real headroom at scale.
```

- [ ] **Step 6: invite-guard bullet (lines 278-282).** Replace with:

```markdown
- **`inviteMember`/`respondToInvite` guard gaps**: RESOLVED in sub-project 5 (Task 3). Both carry
  `isValidDocId` guards and `requireVerifiedEmail` (`functions/src/members.ts`), and sub-project 10
  added the trimmed, lowercased email plus the duplicate-pending-invite and existing-member
  refusals (uniform response) to `inviteMember`.
```

- [ ] **Step 7: the $10 instant minimum and the payout authority (lines 306 and 341-345).** Line 306 becomes:

```markdown
| Instant cash-out | **-4%** of the payout (min $1), on cash-outs of **$10.00 or more** (`INSTANT_PAYOUT_MIN_CENTS`) | musician; standard payouts are free (1 to 3 business days) and have no minimum |
```

The "**Payouts.**" paragraph (341-345) becomes:

```markdown
**Payouts.** Musicians onboard through a Stripe-hosted Express flow (`createOnboardingLink`) and
cash out from the Earnings page on either platform: standard (free, 1 to 3 business days) or
instant (4%, min $1, debit-card-backed accounts only, and only for $10.00 or more; below that the
callable refuses with `PAYOUT_INSTANT_MIN_MESSAGE`). **Payout authority is profile admins only**:
`createOnboardingLink` and `requestPayout` call `requireProfileAdmin` (sub-project 5 security
ruling H2, `docs/superpowers/sp5-rulings.md` ruling 7), because onboarding sets the bank
destination and a payout drains the balance. Members see balance and status through
`getStripeStatus`; on mobile they see the buttons and receive the server's refusal.
```

- [ ] **Step 8: paymentsSweep, eleven steps, and disputes (lines 385-392).** Replace the "**`paymentsSweep`**" paragraph and the "**Not in sub-project 5**" paragraph with:

```markdown
**`paymentsSweep`** runs hourly (`retryCount: 3`) and owns everything time-based. Its eleven
steps, in run order (`functions/src/paymentsSweep.ts`, the `steps` array at the bottom of the
file; the name in parentheses is the step's key in the sweep report):

1. paymentsSweep step 1 (`reconcile`): finishes or unstages accept sagas left flagged
   `depositChargePending`.
2. paymentsSweep step 2 (`pendingDeposits`): completes `refund_pending` and `forfeit_pending`
   deposits whose post-commit executor never ran.
3. paymentsSweep step 3 (`birthDeposits`): charges the deposit for occurrences the materializer
   birthed onto an already-booked run.
4. paymentsSweep step 4 (`dueOccurrences`): schedules the settlement for each occurrence that has
   ended, or waives it when the linkage broke (taken down, reopened, re-owned, gig gone).
5. paymentsSweep step 5 (`chargeSettlements`): charges due `pending` settlements off-session and
   transfers the musician's share (sourced from the charge only when it fits; see
   `sp10-rulings.md`).
6. paymentsSweep step 6 (`retrySettlements`): runs the +1d, +2d, +2d dunning schedule on
   `past_due` settlements, then adds the late fee and declares the curator delinquent.
7. paymentsSweep step 7 (`expiredRefunds`): refunds future-dated deposits off bookings that
   resolved to `expired` (moderation cascades).
8. paymentsSweep step 8 (`ticketOrderExpiry`): expires stale pending ticket orders and releases
   inventory; completes an order whose intent already succeeded, and raises a
   `ticket_order_stuck` alert after two hours (sub-project 10). The same function runs alone every
   five minutes as the `ticketOrderExpiry` scheduler; the hourly run is the backstop.
9. paymentsSweep step 9 (`cancelledEventRefunds`): retries refunds a cancelled event could not
   complete.
10. paymentsSweep step 10 (`ticketSettlement`): transfers face value to the curator T+1 after
    `endsAt`, claiming the event with `settlementClaimedAt` before the transfer and stamping
    `settlementStartedAt` only after it succeeds (sub-project 10).
11. paymentsSweep step 11 (`ticketTransferExpiry`): expires ticket transfer offers past their 24h
    TTL.

Every step is isolated (a step-level and a per-doc try/catch), and states the sweep refuses to act
on are escalated into `adminAlerts` for a human (`releaseStuckSaga` is the admin callable that
resolves one).

**Not in sub-project 5** (and still open): tax forms beyond the Connect 1099 delivery setting,
statements and exports, multi-currency, and platform payout accounting. Dispute handling landed in
sub-project 10 (`charge.dispute.created`, `charge.dispute.closed`, `charge.refunded` in
`functions/src/paymentsWebhook.ts`): an open dispute writes a ledger row and an `adminAlert`,
flags a curator delinquent for a booking charge or stamps `disputeStatus: "open"` on a ticket
order, and `disputes/{disputeId}` (admin-read) holds the resolution state; a lost dispute reverses
the matching transfer; a won one clears the gate; evidence submission stays manual in the Stripe
dashboard. Live-mode activation is an owner launch item.
```

- [ ] **Step 9: environment table (lines 394-414).** Replace line 408 (the `STRIPE_WEBHOOK_SECRET` row) with:

```markdown
| `STRIPE_WEBHOOK_SECRET` | functions | signing secret of the first Stripe endpoint ("Your account" scope), a `defineSecret()` param declared on `stripeWebhook`; every request is verified against it first, then against the Connect secret | outside the emulator a missing secret is a **500** from `stripeWebhook` ("webhook misconfigured", `StripeWebhookSecretMissingError` in `functions/src/stripeClient.ts`), never a signature check against an empty string; Stripe retries a 500, so a genuine delivery is not lost once the secret lands. Inside the emulator FakeStripe's webhook calls are same-process and need no secret |
```

Append these rows after the `APP_ORIGIN` row (line 412):

```markdown
| `STRIPE_CONNECT_WEBHOOK_SECRET` | functions | signing secret of the second Stripe endpoint ("Connected accounts" scope: `account.updated`, `payout.paid`, `payout.failed`), a `defineSecret()` param declared on `stripeWebhook`; `constructWebhookEvent` returns which secret verified, and an event whose scope does not match that secret is refused | outside the emulator a missing secret is the same fail-closed 500 as `STRIPE_WEBHOOK_SECRET`; inside the emulator nothing needs it |
| `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` | mobile | Stripe publishable key for the native PaymentSheet (`apps/mobile/src/payments/stripe.ts`); set as an EAS environment variable, and in `apps/mobile/.env` for local dev-client runs | keyless mode: the native sheets are skipped and the emulator loop runs with zero Stripe keys |
| `FIREBASE_EMULATORS` | web | set to `1` so a production build (`next build && next start`) still targets the local emulators (`apps/web/src/lib/firebase-server.ts`) | a production build talks to real Firebase; `next dev` always targets the emulators |
| `STORAGE_BUCKET` | functions | the bucket every server-side Storage read and cleanup targets (`functions/src/storage.ts`); **must be set on the production deploy** or the functions read the dev bucket | `gatekeep-dev-jg.firebasestorage.app` |
| `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID` | web | the Firebase web config (`apps/web/src/lib/firebase.ts`); the set is documented in `apps/web/.env.example` | the `gatekeep-dev-jg` dev values compiled into the module |
| `EXPO_PUBLIC_FIREBASE_API_KEY`, `EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN`, `EXPO_PUBLIC_FIREBASE_PROJECT_ID`, `EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET`, `EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `EXPO_PUBLIC_FIREBASE_APP_ID` | mobile | the Firebase mobile config (`apps/mobile/src/lib/firebase.ts`); the set is documented in `apps/mobile/.env.example` | the `gatekeep-dev-jg` dev values compiled into the module |
| `WEB_PORT` | scripts | the web dev-server port `scripts/seed-test-event.ts` prints its `/e/[eventId]` URL against | `3000` |
| `GOOGLE_APPLICATION_CREDENTIALS` | scripts | service-account JSON path that lets `scripts/seed-admin.ts` and `scripts/seed-test-accounts.ts` run against a real project instead of the emulator | the scripts refuse to run when neither this nor the emulator hosts are set |
| `GCLOUD_PROJECT` | scripts | the project id `scripts/seed-admin.ts` and `scripts/seed-test-accounts.ts` write to (read before the credentials file and the argument; printed before any write) | the credentials file's project, else the first argument, else `gatekeep-dev-jg` |
```

- [ ] **Step 10: insert the Scripts section** immediately before line 143 (`## Gigs & series (sub-project 3)`):

```markdown
## Scripts

Three operator scripts live in `scripts/`, run with `pnpm tsx` from the repo root. Each refuses
to run unless it can tell where it is writing (the emulator, when the auth and Firestore emulator
hosts are set, or a real project, when `GOOGLE_APPLICATION_CREDENTIALS` is set), and the two
account seeds print the project id they resolved (`GCLOUD_PROJECT`, then the credentials file,
then the first argument) before writing anything.

```bash
# The three test accounts (password GateKeep-Test1 for all): test-fan@gatekeep.dev (no profile),
# test-musician@gatekeep.dev (admin of the approved @testmusician), test-curator@gatekeep.dev
# (admin of the approved @testvenue). Idempotent. The emulator wipes them on every restart.
FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm tsx scripts/seed-test-accounts.ts

# One published event (a free tier and a paid tier) owned by @testvenue; prints its /e/[eventId]
# URL (WEB_PORT overrides the port). Emulator only; run the accounts seed first. Every run
# creates another event.
FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm tsx scripts/seed-test-event.ts

# Grant the admin claim to a Google sign-in account (refuses every other provider; see
# docs/superpowers/foundation-rulings.md).
FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 pnpm tsx scripts/seed-admin.ts someone@example.com
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json pnpm tsx scripts/seed-admin.ts someone@example.com
```
```

- [ ] **Step 11: insert the Events and ticketing section** immediately before line 394 (`## Environment variables`):

```markdown
## Events and ticketing (sub-project 6)

**Concepts.** An `events/{eventId}` doc is a curator-published show, standalone or promoted from a
`filled` gig (at most one event per `gigId`; a second promotion is refused with
`GIG_ALREADY_PROMOTED_MESSAGE`), with `status` in `draft`, `published`, `completed`, `cancelled`,
a lineup of booking acts or external names, a public-precision location, and an optional poster.
A booking act is verified server-side (`verifyLineupBookingActs`): the booking must exist, belong
to the calling curator, match the musician, and be `confirmed`, so a curator cannot fabricate an
association on a musician's public page. Tiers live at `events/{eventId}/tiers/{tierId}`
(`priceCents`, `capacity`, server-maintained `soldCount`, an optional sale window); inventory truth
is a transactional `soldCount <= capacity` check, and after publish a capacity can only go up.
Orders (`orders/{orderId}`), tickets (`users/{uid}/tickets/{ticketId}`), the attendee projection
(`events/{eventId}/attendees/{ticketId}`), transfers, and `users/{uid}/ticketIndex/{eventId}` (the
valid-ticket proof the address gate and the buyer cap read) are all server-written. Clients never
write any of them; every event mutation is a callable (`createEvent`, `updateEvent`,
`setEventTiers`, `publishEvent`, `cancelEvent`, and the admin `takedownEvent`). Published and
completed events are publicly readable; an event past its start cannot be edited; the exact
address reveals only to a valid ticket holder.

**Money.** The fan pays a service fee on top of face value, per ticket
`min(round(price * 7%) + 99c, 399c)`, zero on free tickets, snapshotted per order as `feePolicy`
so a later tuning never rewrites history. Checkout (`createTicketOrder`) holds inventory in a
10-minute pending order, capped at eight tickets per buyer per event (held tickets plus other
pending orders) and three pending orders per buyer across events; the buyer can
`cancelTicketOrder`, and `ticketOrderExpiry` reclaims the rest every five minutes. The
PaymentIntent carries `metadata.purpose: "tickets"` and the buyer's `receipt_email`, and either
`finalizeTicketOrder` or the `payment_intent.succeeded` webhook completes the order exactly once
and mints the tickets. Both checkouts show, above Pay: "All sales are final unless the event is
cancelled or the organizer refunds you. Service fee included in the total." The curator receives
100% of face value of paid, non-refunded tickets, transferred T+1 after `endsAt` (paymentsSweep
step 10, idempotency key `ticket_settlement:{eventId}`, ledger id `ticket_settlement:{transferId}`),
and only while the curator profile is `approved`. Curator grace refunds (`refundTicket`, per
ticket, fee included) close at `endsAt`, which freezes the settlement basis a full day before any
transfer. Cancelling an event (curator `cancelEvent`, admin `takedownEvent`, or the unpublish
cascade when an approved curator is rejected) refunds every paid order in full, fee included, and
notifies holders; `cancelEventCore` refuses once settlement has started or been freshly claimed. A
lost dispute on a ticket charge reverses that order's face value out of the event's settlement
transfer, or reduces the pending basis when the event has not settled.

**Door.** A ticket's QR is possession of a server-minted `qrSecret` (payload
`{ticketId, eventId, qrSecret}`) compared `===` against the live ticket doc; a transfer mints a
fresh secret, so old QRs die at the scanner. `checkInTicket` requires membership of the event's
profile, opens 12 hours before `startsAt` (`CHECK_IN_TOO_EARLY_MESSAGE`), and has a name-list
fallback (`override: true`); `undoCheckIn` reverts one. The mobile scanner branches on the
callable's error code: `failed-precondition`, `not-found`, and `permission-denied` are ticket
verdicts; anything else renders a neutral "Couldn't reach GateKeep. Try again." panel that stays
until tapped.

**Transfers.** Email-targeted only (handles denote group profiles, not people) and mobile only.
`offerTransfer` always answers "If that account exists, the ticket offer is on its way." (no
account enumeration), offers expire after 24h, and the recipient's buyer cap is re-checked on
accept.

**Surfaces.** Web: the public SSR page `/e/[eventId]` with the Elements buy flow and the poster as
its OG image, Upcoming Events on `/@handle`, curator management under `/dashboard/events` (tiers,
poster, publish, cancel, attendee list with grace refunds and undo check-in), and the fan wallet at
`/tickets`. Mobile: the fan event screen with the PaymentSheet, the Tickets tab (QR wallet,
address reveal, transfers, incoming offers), curator management with the poster picker, and the
expo-camera door scanner. Ticket notifications deep-link to the wallet on both platforms
(`notificationHref` in `packages/shared`).

**Data and boundaries.** `tests-rules/events.rules.test.ts` proves the matrix: every client write
to these collections is denied; `orders` read to the buyer and the curator's members; `tickets`
to their owner; `attendees` to the event's curator members; `transfers` to either party;
`posterUploads/{uid}/uploads/{nonce}` to its owner; `disputes` to admins; `eventCascadeRetries` to nobody.
```

- [ ] **Step 12: EAS bullets (lines 510-527).** Replace the "**EAS `projectId`**" bullet (510-513) with:

```markdown
- **EAS `projectId`**: DONE. `apps/mobile/app.json` carries `expo.extra.eas.projectId`
  (`0731d32c-00c5-4fdb-9d1c-78d6be4bf1c6`), which `apps/mobile/src/notifications/push.ts` reads
  for push-token registration.
```

In the next bullet, replace the heading phrase `**EAS build setup (in progress, 2026-08-27)**:` with `**EAS build setup (still owed; the owner table in `docs/superpowers/HANDOFF.md` is the tracker)**:` and replace the clause "Still manual: `eas login` + `eas init` against the org account; Firebase console" with "Still manual: `eas login` on each build machine; Firebase console".

- [ ] **Step 13: Stripe go-live additions (SP5 launch checklist, lines 657-716).** Replace the first bullet (659-671, "**Register the webhook endpoint in the Stripe dashboard**" through "when flipping to live mode.") with:

```markdown
- **Register two webhook endpoints in the Stripe dashboard** (Developers, Webhooks, Add endpoint),
  both pointing at the deployed `stripeWebhook` HTTPS URL (`firebase deploy` prints it; it also
  appears in the Firebase console under Functions). Stripe delivers platform-account events and
  connected-account events under two different scopes, each with its own signing secret, and
  `stripeWebhook` verifies against both (`STRIPE_WEBHOOK_SECRET` first, then
  `STRIPE_CONNECT_WEBHOOK_SECRET`) and refuses an event whose scope does not match the secret that
  verified it.
  1. Endpoint A, scope **"Your account"**: `payment_intent.succeeded`,
     `payment_intent.payment_failed`, `transfer.reversed`, `charge.dispute.created`,
     `charge.dispute.closed`, `charge.refunded`. Store its signing secret with
     `firebase functions:secrets:set STRIPE_WEBHOOK_SECRET`.
  2. Endpoint B, scope **"Connected accounts"**: `account.updated`, `payout.paid`,
     `payout.failed`. Store its signing secret with
     `firebase functions:secrets:set STRIPE_CONNECT_WEBHOOK_SECRET`.

  Until both secrets are set the function answers 500 to every delivery (fail-closed; Stripe
  retries), which also parks the recovery path for charges Stripe leaves `processing` (they are
  finalized by `payment_intent.succeeded`, not by the callable that started them).
  `transfer.reversed` is the only way the platform learns about a transfer reversed from the
  dashboard. Register a fresh pair with new secrets when flipping to live mode, then re-run the
  manual smoke walkthrough below with both endpoints attached.
```

Insert these four bullets immediately after the "**Enable a Firestore TTL policy on `stripeEvents.expireAt`**" bullet:

```markdown
- **Radar and dispute liability (before live mode).** Turn on Stripe Radar's default rules on the
  platform account (every charge is a platform charge, so Radar runs there), and read the Connect
  dispute-liability setting: on the separate charges and transfers model the platform is liable
  for disputes, which is what the `charge.dispute.*` handlers assume (alert, delinquency flag on a
  booking charge, reversal of the matching transfer on a lost outcome, `disputes/{disputeId}` for
  the admin). Evidence submission stays manual in the Stripe dashboard.
- **Simulate a dispute in test mode.** Charge Stripe's dispute test card **4000 0000 0000 0259**
  once as a booking deposit and once as a ticket order. Expect: a `dispute_opened` ledger row and
  `adminAlert`, the curator flagged delinquent (deposit) or the order stamped
  `disputeStatus: "open"` (ticket), and, after closing the dispute as lost from the dashboard, a
  `dispute_lost` row plus the reversal, or a `dispute_reversal_failed` alert when no transfer
  exists yet.
- **Platform float for ticket settlement (decision owed).** Ticket settlement is one transfer per
  event (paymentsSweep step 10) that is not sourced from a specific charge, so it draws on the
  platform's available balance; on Stripe's standard payout timing the platform needs enough
  float to cover an event's face value on T+1, or the transfer fails with `balance_insufficient`
  and retries hourly (cancel stays possible because `settlementStartedAt` is stamped only after
  success). Decide before launch: hold a float, delay platform payouts, or move to per-order
  sourced transfers (sub-project 5c).
- **1099 delivery.** Enable tax form delivery for Express accounts in the Connect settings for the
  tax year; nothing in code depends on it.
```

- [ ] **Step 14: payout decision bullet (lines 702-707).** Replace with:

```markdown
- **Product decision recorded: payouts are profile ADMINS only** (`requestPayout` and
  `createOnboardingLink` call `requireProfileAdmin`, sub-project 5 security ruling H2,
  `docs/superpowers/sp5-rulings.md` ruling 7). Onboarding sets the bank destination and a payout
  drains the balance, so both are gated like `removeMember` and `transferAdmin`. Members keep
  read-only balance and status through `getStripeStatus`; the mobile Earnings card shows the
  buttons to any member and surfaces the server's refusal. Sub-project 5c (admin-initiated member
  payout splits) is the recorded follow-up.
```

- [ ] **Step 15: SP6 launch checklist (lines 869-892).** Append to the end of the first bullet ("**No new Stripe secrets or webhook registration needed.**"): ` Sub-project 10 later added `STRIPE_CONNECT_WEBHOOK_SECRET` for the Connect scope; see the sub-project 5 checklist.` Replace the "**Poster upload is not wired end to end.**" bullet (882-887) with:

```markdown
- **Poster upload: DONE in sub-project 10.** `processPhoto` writes `posterUploads/{uid}/uploads/{nonce}`
  for kind `poster`; the web `EventEditor` and the mobile event management screen watch that doc
  and save `posterPath` through `updateEvent`; `/e/[eventId]` renders it and uses it as the OG
  image. Abandoned poster docs older than 24h are reaped by dailySweep step 3.
```

- [ ] **Step 16: design docs table (lines 972-998, from `## Design docs` to the end of the file).** Replace with:

```markdown
## Design docs

Each sub-project has a spec (binding over its plan), a plan (a historical execution record; its
snippets may predate review fixes), and a rulings doc that is the authority for its area.
`docs/superpowers/HANDOFF.md` is the fresh-session entry point, `DESIGN.md` at the repo root is the
brand contract binding on all UI work, and `docs/superpowers/foundation-rulings.md` holds the
sub-project 1 rulings.

| Sub-project | Spec | Plan | Rulings | Merged |
|---|---|---|---|---|
| 1 Foundation | `docs/superpowers/specs/2026-08-24-foundation-design.md` | `docs/superpowers/plans/2026-08-24-foundation.md` | `docs/superpowers/foundation-rulings.md` | 2026-08-25 |
| 2 Musician portfolio | `docs/superpowers/specs/2026-08-25-musician-portfolio-design.md` | `docs/superpowers/plans/2026-08-25-musician-portfolio.md` | `docs/superpowers/sp2-rulings.md` | 2026-08-26 |
| 3 Curator profiles and gigs | `docs/superpowers/specs/2026-08-26-curator-gigs-design.md` | `docs/superpowers/plans/2026-08-26-curator-gigs.md` | `docs/superpowers/sp3-rulings.md` | 2026-08-26 |
| 4 Booking flow | `docs/superpowers/specs/2026-08-26-booking-flow-design.md` | `docs/superpowers/plans/2026-08-26-booking-flow.md` | `docs/superpowers/sp4-rulings.md` | 2026-08-27 |
| 5 Payments | `docs/superpowers/specs/2026-08-27-payments-design.md` | `docs/superpowers/plans/2026-08-27-payments.md` | `docs/superpowers/sp5-rulings.md` | 2026-08-28 |
| 5b Mobile payments | `docs/superpowers/specs/2026-08-28-mobile-payments-design.md` | `docs/superpowers/plans/2026-08-28-mobile-payments.md` | `docs/superpowers/sp5b-rulings.md` | 2026-08-28 |
| 9A Web UI/UX | `docs/superpowers/specs/2026-08-28-web-uiux-design.md` | `docs/superpowers/plans/2026-08-28-web-uiux.md` | `docs/superpowers/sp9a-rulings.md` (mocks in `docs/superpowers/mocks/sp9a/`) | 2026-08-29 |
| 9B Mobile UI/UX | `docs/superpowers/specs/2026-08-29-mobile-uiux-design.md` | `docs/superpowers/plans/2026-08-29-mobile-uiux.md` | `docs/superpowers/sp9b-rulings.md` | 2026-08-29 |
| 6 Events and ticketing | `docs/superpowers/specs/2026-08-30-events-ticketing-design.md` | `docs/superpowers/plans/2026-08-30-events-ticketing.md` | `docs/superpowers/sp6-rulings.md` | 2026-08-31 |
| 10 Hardening | `docs/superpowers/specs/2026-09-02-hardening-design.md` | `docs/superpowers/plans/2026-09-02-hardening-sweep.md` (branch A) and `docs/superpowers/plans/2026-09-02-hardening.md` (branch B) | `docs/superpowers/sp10-rulings.md` | 2026-09-09 |

The whole-project audit that sourced sub-project 10: `docs/superpowers/audit-2026-09-01.md`, with
the detail reports in `docs/superpowers/audit/`.
```

Two cells in row 10 are written from this plan's assumptions and must match reality on the day: the branch B plan cell must be the actual filename (`ls docs/superpowers/plans/2026-09-02-*`; the path check in Step 17 fails on a wrong one), and the Merged cell must be the calendar date of the Task 35 merge (`date +%F` on that day), overwriting the date shown.

- [ ] **Step 17: verify.**

```bash
# 1. No em dash anywhere in the README (exit status 1 from grep is the pass).
grep -c $'\xe2\x80\x94' README.md     # prints 0

# 2. Every repo path the README names exists. Backticked tokens with at least one slash, not
#    starting with "/" (routes) or "http", not containing {, *, $ or a space, are checked with a
#    literal pathspec (so [eventId] is not a glob). Directories pass because ls-files lists
#    their contents.
grep -o '`[^`]*`' README.md | tr -d '`' | sort -u \
  | grep '/' | grep -v '^/' | grep -v '^http' | grep -v '[{*$ ]' \
  | while read -r p; do
      q="${p%/}"
      if [ -z "$(git ls-files -- ":(literal)$q" | head -1)" ]; then echo "MISSING: $p"; fi
    done
```

The MISSING list must be empty except for tokens that are not repo files by design, each of which must be one of: a Storage prefix (`public/tracks`, `review/tracks`, `public/photos`, `staging/`), a Firestore path written without braces (none should exist; braces are the convention), a gitignored env file (`functions/.env`, `apps/web/.env.local`, `apps/mobile/.env`), or the `./service-account.json` example argument. Anything else is a broken pointer: fix it. Paste the final MISSING list into the commit body.

```bash
# 3. The two new section headings and the convention line are present.
grep -n "^## Scripts$\|^## Events and ticketing (sub-project 6)$\|dailySweep step N" README.md
```

- [ ] **Step 18: commit.**

```
docs(readme): sub-project 10 rewrite

Intro through sub-project 10 (7 in flight), monorepo map regenerated from git ls-files,
dailySweep nine steps and paymentsSweep eleven steps with the "dailySweep step N" convention,
payout authority corrected to profile admins, $10 instant minimum, env table (Connect secret,
EXPO key, FIREBASE_EMULATORS, STORAGE_BUCKET, both Firebase config sets, script vars),
webhook secret fail-closed, Scripts section, Events and ticketing section, EAS and invite-guard
and lint lines un-staled, Stripe go-live: two endpoints, Radar and dispute liability, platform
float, dispute test card, 1099 delivery. Design docs table through 10.

Path check MISSING list: <paste>
```

(End every commit in this section with the attribution trailer the session prescribes.)

---

### Task 34: HANDOFF, rulings annotations, plan banners, sp10-rulings skeleton

**Files:**
- Modify: `docs/superpowers/HANDOFF.md` lines 3-4 (date line), 31-39 (sub-project list tail and NEXT line), 46-56 (binding rules), 60-72 (quickstart seeds and gate counts), 77-end (owner-owed section, replaced).
- Modify: `docs/superpowers/foundation-rulings.md` lines 34-40; `docs/superpowers/sp2-rulings.md` lines 49-58; `docs/superpowers/sp3-rulings.md` lines 380-399.
- Modify: the nine plans `docs/superpowers/plans/2026-08-*.md` (banner prepended, content untouched).
- Create: `docs/superpowers/sp10-rulings.md`.

**Interfaces:**
- Consumes: `docs/superpowers/audit/docs-consistency.md` section B (47 rows), findings A5, A6, A7, A15, A16, A20, A27; spec sections 2 (owner decisions 3 to 6), 4.1, 4.2, 8, 11; the README headings Task 33 produced.
- Produces: `docs/superpowers/sp10-rulings.md` with the six fixed rulings and an "Execution rulings" section Task 35 appends to; HANDOFF's "Standing tripwires" list and the owner table that the spec's section 11 and README point at.

**Steps:**

- [ ] **Step 1: HANDOFF header and build status.** Line 3-4: replace "Last updated 2026-08-31, after the 6 merge." with "Last updated 2026-09-09, after the 10 merge." (overwrite the day with the real merge date in Task 35). After the sub-project 6 entry (line 37) insert:

```markdown
10. Hardening (`sp10-rulings.md`): no new features. The audit's money, lifecycle, and copy defects
   closed: transfer sourcing, two Stripe webhook scopes, disputes, the settlement webhook race,
   events cancelled and refunded when a curator is unpublished, admin `takedownEvent`, deletion
   refusals with named blockers, auth `onDelete` cascade, push-token hygiene, fail-closed
   geocoder, poster upload, notification deep links, scanner offline panel, buyer order cancel
   with a five-minute expiry job, series end handling, env-driven Firebase config, Node 22, CI,
   and the repo-wide em-dash sweep. Owner smoke owed: the second Stripe endpoint and a simulated
   dispute, the new EAS dev build, then the 9A, 9B, and 6 lists plus the sub-10 additions (table
   below, rows 48 to 59).
```

Replace line 39 (`NEXT: **7 Fan discovery**, then 8 Search. Deferred: 5c band payout splits.`) with:

```markdown
## Roadmap

- **7 Fan discovery (in flight)**: follow artists, performance notifications, the fan home and
  discover feeds, posters on cards, new notification kinds, fan onboarding, share links. Branch
  `sp7-fan-discovery`; it rebases onto 10 and adds its own entry above at its merge.
- **8 Search**: text search, ranking, the map view, venue filter chips, saved searches and alerts,
  sitemap, handle redirects, reserved handles, a rate-limit helper, and the internals of both
  placeholder directories (`apps/web/app/gigs/`, the curator musicians directory, and their
  mobile twins).
- **5c Band payout splits**: admin-initiated member payout splits, per-order ticket settlement
  transfers (`source_transaction`), payout history, member roles on payout buttons.
- **Messaging**: general musician to curator chat beyond the terms-only booking thread.
  Unscheduled; the mobile Messages tabs stay coming-soon until it gets a number.
- **Follow-on if wanted**: the accessibility and state-coverage findings (antislop #10 to #29)
  and the hardening ledger rows L62 to L80.
- Unscheduled by design: advertising, subscriptions, 2FA beyond Google-only admins, SMS, video
  hosting, guest checkout, seat maps, promo codes, resale.
```

- [ ] **Step 2: HANDOFF binding rules (lines 46-56).** Replace line 51 (`- **No em dashes anywhere**: code, comments, copy, docs, commit messages.`) with:

```markdown
- **No em dashes anywhere**: code, comments, copy, docs, commit messages. Enforced repo-wide by
  CI since sub-project 10 (2026-09): the workflow's last step fails on any U+2014 under
  `apps/**`, `functions/**`, `packages/**`, `tests-rules/**`, `scripts/**`, `docs/**`,
  `README.md`, `DESIGN.md`, and every rules file (DESIGN.md names the character instead of
  printing it).
- Two sweeps exist, so never write a bare "step N": always `dailySweep step N` (nine steps) or
  `paymentsSweep step N` (eleven steps). README lists both.
- Specs are binding over plans. Plans are historical execution records whose snippets may
  predate review fixes; code and the rulings doc win over both.
- Emulator suites run as one blocking foreground call (`pnpm emu:test` takes about ten minutes;
  use a 600000 ms timeout). A backgrounded run that then waits on itself stalls forever.
- `README.md` holds the env-var table, the launch checklists, and the smoke walkthroughs.
```

Then insert, immediately after the binding-rules list (before `## Dev environment quickstart`):

```markdown
## Standing tripwires (read before touching the named area)

1. `resumeSeries` does not exist and pause is one-way. A resume must add `pausedBy` (`"curator"`
   or `"admin"`) and an approval gate so a curator cannot resume a series an admin paused; a
   naive resume is a Critical regression (`sp3-rulings.md` ruling 19).
2. Android `openBrowserAsync` resolves when the browser opens, not when it closes. Any
   in-app-browser flow must re-sync on app foreground and browser dismissal, never on the
   promise (`sp5b-rulings.md` ruling 4).
3. Stripe caches an idempotency key's response for 24 hours. A same-key retry replays the cached
   result, so a retry that must charge again needs an attempt-scoped key, and a
   grace-versus-cancel race can delay a buyer remainder up to a day (`sp5-rulings.md`,
   `sp6-rulings.md`).
4. Web RSC boundary: a server file never imports a VALUE from a `"use client"` module (types are
   fine). Verify every changed web route with a live page load, not only `next build`
   (`sp9a-rulings.md`).
5. `source_transaction` cap: Stripe (and FakeStripe) refuse a transfer sourced from a charge once
   the sourced transfers against that charge exceed its amount. `finalizeSettlementSuccess`
   sources only when `earnings <= chargeAmountCents` and records `sourced: false` otherwise; a
   new transfer path must make the same decision (`sp10-rulings.md` ruling 5).
6. Two Stripe webhook scopes: "Your account" events verify with `STRIPE_WEBHOOK_SECRET`,
   "Connected accounts" events (`account.updated`, `payout.*`) with
   `STRIPE_CONNECT_WEBHOOK_SECRET`. An event whose scope does not match the secret that verified
   it is refused, so a new handler must be registered on the endpoint of the scope it belongs to
   (`sp10-rulings.md` ruling 6).
```

- [ ] **Step 3: HANDOFF quickstart (lines 60-72).** After the accounts-seed line (ends "pnpm tsx scripts/seed-test-accounts.ts`") add:

```markdown
  then, for a published event to load `/e/[eventId]` against:
  `FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm tsx scripts/seed-test-event.ts`
```

Replace the gates line (71-72) with the counts Task 35 records; until Task 35 runs, leave the line reading `shared tests (158), pnpm emu:test (704, single blocking call), pnpm emu:rules (103)` and let Task 35 Step 7 overwrite the three numbers. Add to the machine-quirks bullet: "Node 22 is the functions runtime since sub-project 10 (`.nvmrc`)."

- [ ] **Step 4: HANDOFF owner-owed table.** Replace everything from line 77 (`## Owner-owed items (not code)`) to the end of the file with:

```markdown
## Owner-owed (not code): the consolidated launch table

Consolidated from the docs audit (`docs/superpowers/audit/docs-consistency.md` section B, rows 1
to 47, verified against code on 2026-09-01) plus sub-project 10's additions (rows 48 to 59).
Blocking: Launch = before real traffic; Live = before the live-mode Stripe flip; Device = before
on-device testing; Runbook = a procedure, not a config; Optional = revisit on evidence. README
section names refer to the README as rewritten in sub-project 10.

| # | Item | Blocking | Where documented |
|---|---|---|---|
| 1 | Create the PROD Firebase project under the business Google account; keep `gatekeep-dev-jg` as DEV | Launch | `foundation-rulings.md` |
| 2 | Enable Email/Password, Google, Apple sign-in providers (dev and prod) | Launch | README "Manual follow-ups" |
| 3 | App Check: register web (reCAPTCHA v3 site key) and mobile (Play Integrity / App Attest); monitor mode until native mobile App Check ships; do not enforce Storage before it | Launch | README "Manual follow-ups" |
| 4 | App Check enforcement is two changes: the console flip plus `enforceAppCheck: true` per onCall in the same change (absent today), with the SSR exception documented | Launch | README "Manual follow-ups"; audit cross-cutting #6 |
| 5 | Never App-Check-enforce over `stripeWebhook` | Launch | README "Sub-project 5 launch checklist" |
| 6 | Set the real `GOOGLE_WEB_CLIENT_ID` (`apps/mobile/src/auth/config.ts` is a placeholder) | Device | README "Manual follow-ups" |
| 7 | Sentry projects, then `NEXT_PUBLIC_SENTRY_DSN` and `EXPO_PUBLIC_SENTRY_DSN` | Launch | README "Environment variables" |
| 8 | EAS: `eas login`, Firebase Android and iOS apps, `google-services.json` / `GoogleService-Info.plist` plus the keystore SHA-1, `googleServicesFile` in `app.json`; Apple Developer Program for store publication | Device | README "Manual follow-ups" |
| 9 | Verify `firebase deploy --only functions` resolves `workspace:*` for `@gatekeep/shared` | Launch | README "Manual follow-ups" |
| 10 | Confirm Email Enumeration Protection is on (dev and prod) | Launch | README "Manual follow-ups" |
| 11 | `staging/` 24h GCS lifecycle rule on the production bucket, kept as a versioned `lifecycle.json` (LAUNCH BLOCKER; the Storage emulator cannot test it) | Launch | README "Manual follow-ups"; `sp2-rulings.md` |
| 12 | `PUBLIC_PROFILE_HOST` real domain (the mobile "View public page" link stays hidden until then) | Launch | README "Manual follow-ups" |
| 13 | `NEXT_PUBLIC_SITE_URL` (canonical and OG base) | Launch | README "Environment variables" |
| 14 | `STORAGE_BUCKET` on the production functions deploy, plus the production `NEXT_PUBLIC_FIREBASE_*` and `EXPO_PUBLIC_FIREBASE_*` sets | Launch | README "Environment variables" |
| 15 | `GEOCODER_PROVIDER=google` and `firebase functions:secrets:set GEOCODER_API_KEY` (the geocoder fails closed without them since sub-project 10) | Launch | README "Sub-project 3 launch checklist" |
| 16 | Revisit the 50/day geocode budget constant if usage needs it | Optional | README "Sub-project 3 launch checklist" |
| 17 | After first deploy: the Cloud Scheduler jobs for `dailySweep`, `paymentsSweep`, and `ticketOrderExpiry` exist with `retryCount: 3` and sane next-run times | Launch | README "Gigs & series", "Payments" |
| 18 | Monitor `adminAlerts` (the sweeps' escalation queue) from day one | Runbook | README "Payments" |
| 19 | Confirm every composite index and field override in `firestore.indexes.json` shows Enabled after the first deploy (the emulator enforces none of them) | Launch | README launch checklists (3, 4, 5, 6) |
| 20 | Set `LAUNCH_TIMEZONE` to the launch metro (`packages/shared/src/types.ts` is `America/New_York`) | Launch | README "Sub-project 3 launch checklist" |
| 21 | UTC recurrence caveat: disclosure in the series forms, no fix pending | Informational | README "Sub-project 3 launch checklist" |
| 22 | Run `backfillDisplayNameLower` once after deploy | Launch | README "Sub-project 3 launch checklist" |
| 23 | Deploy the tightened rules and run `backfillBookingVisibility` in the SAME release (CRITICAL ordering) | Launch | README "Sub-project 4 launch checklist"; `sp4-rulings.md` ruling 3 |
| 24 | Device pass: Hermes ICU date formatting, nested events Stack headers, native Google and Apple sign-in on a dev-client build | Device | README "Sub-project 3 launch checklist" |
| 25 | Register both Stripe webhook endpoints ("Your account" and "Connected accounts") and set `STRIPE_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET`; a fresh pair for live mode | Launch | README "Sub-project 5 launch checklist" |
| 26 | Firestore TTL policy on `stripeEvents.expireAt` | Launch | README "Sub-project 5 launch checklist" |
| 27 | `firebase functions:secrets:set STRIPE_SECRET_KEY`; `APP_ORIGIN` on functions; `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` then REBUILD web | Launch | README "Stripe key setup" |
| 28 | Re-verify `RealStripe.debitConnectedAccount` (legacy `charges.create({source})`) against current Connect docs | Live | README "Sub-project 5 launch checklist" |
| 29 | Re-verify the 4% instant-payout retail fee against Stripe's current cost | Live | README "Sub-project 5 launch checklist" |
| 30 | Activate Stripe Connect under the business entity and swap live keys; never live under the personal entity | Live | README "Sub-project 5 launch checklist" |
| 31 | Manual real-test-mode smoke walkthrough steps 1 to 8 (web), with both endpoints attached | Launch | README "Manual smoke walkthrough" |
| 32 | Apple merchant id `merchant.app.gatekeep.mobile` and the Apple Pay certificate; Google Pay enabled in Stripe | Device | README "Sub-project 5b launch checklist" |
| 33 | `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` as an EAS env var (and `apps/mobile/.env` locally) | Device | README "Sub-project 5b launch checklist" |
| 34 | New EAS dev-client build, both platforms (native deps changed in 5b, 9B, 6, and 10) | Device | README "Sub-project 5b launch checklist" |
| 35 | Mobile smoke walkthrough steps 9 to 15 (sheets, 3DS, past-due, wallets, onboarding, payouts, true-up) | Device | README "Manual smoke walkthrough" |
| 36 | 9A signed-in web visual smoke, both themes, full coverage list | Launch (hard gate) | `sp9a-rulings.md` |
| 37 | Eyeball `--gk-focus` light `#BF5038` and `--gk-on-destructive` white on `/design` | Launch | `sp9a-rulings.md` |
| 38 | Real concert photos into `apps/web/public/hero/` and `apps/web/src/marketing/heroImages.ts` | Launch | README "Sub-project 9A launch checklist" |
| 39 | Counsel review of the `/terms` and `/privacy` placeholder text | Launch | README "Sub-project 9A launch checklist" |
| 40 | Footer `CONTACT_EMAIL` (`hello@gatekeep.app`): own the mailbox or change it | Launch | README "Sub-project 9A launch checklist" |
| 41 | 9B mobile visual smoke on the next EAS build, both themes, coverage list | Device (hard gate) | README "Sub-project 9B smoke checklist" |
| 42 | Confirm the token PaymentSheet `appearance` on the owner's build | Device | `sp9b-rulings.md` |
| 43 | SP6 web smoke (create, promote, tiers, publish, public page, free RSVP, PAID with real test keys, wallet QR, attendees, grace refund, cancel), both themes | Launch | README "Sub-project 6 smoke checklist" |
| 44 | SP6 mobile smoke including the DOOR SCANNER on a real camera, a two-account transfer, tap check-in | Device (top priority) | README "Sub-project 6 smoke checklist" |
| 45 | Poster upload end to end on a device (shipped in sub-project 10; unverified on a real camera roll) | Device | README "Sub-project 6 launch checklist" |
| 46 | Content takedown two-step (unpublish, then `deleteProfile` for a scrub); the admin confirm dialog names both steps | Runbook | README "Manual follow-ups" |
| 47 | Seed the first admins (Google accounts) with `scripts/seed-admin.ts` against the prod project id | Launch | README "Scripts" |
| 48 | Register the second Stripe webhook endpoint ("Connected accounts") and set `STRIPE_CONNECT_WEBHOOK_SECRET`; re-run the README test-mode walkthrough with both endpoints | Launch | README "Sub-project 5 launch checklist" |
| 49 | Simulate a dispute with card 4000 0000 0000 0259 on a deposit and on a ticket order; confirm the alert, the delinquency flag, and the reversal on a lost outcome | Launch | README "Sub-project 5 launch checklist" |
| 50 | Stripe Radar default rules on; read the Connect dispute-liability setting | Live | README "Sub-project 5 launch checklist" |
| 51 | Decide the platform float for ticket settlement (or move to per-order sourced transfers in 5c) | Launch | README "Sub-project 5 launch checklist" |
| 52 | Enable 1099 delivery for Express accounts | Live | README "Sub-project 5 launch checklist" |
| 53 | Cloud Monitoring alert policies: function error rate, and a log-based metric on `adminAlerts` document creation | Launch | audit cross-cutting #15 |
| 54 | Firestore PITR on, a daily scheduled export bucket, and a GCP budget alert (the `ledger` has no off-Firestore copy otherwise) | Launch | audit cross-cutting #30 |
| 55 | Web security headers and a CSP in `apps/web/next.config.ts` | Launch | audit cross-cutting #20 |
| 56 | Mobile store-review permissions: drop the microphone permission (`expo-audio` plugin options) and add `iosUrlScheme` to the Google sign-in plugin in `apps/mobile/app.json` | Device | audit cross-cutting #19 |
| 57 | New EAS dev build (notification handler and poster picker changed native config), then the unchanged 9A, 9B, and 6 smoke lists plus: scanner offline panel, reminder copy, verify-email banner, deletion refusals, poster upload | Device | spec 10 section 11 |
| 58 | Deploy and confirm the new composite index `payments (musicianProfileId, settlement.status)` and the repaired `tickets.orderId` and `members.uid` overrides show Enabled | Launch | spec 10 section 11 |
| 59 | Confirm the deployed functions run Node 22 (`firebase.json` runtime `nodejs22`) | Launch | `plans/2026-09-02-hardening-sweep.md` |
```

- [ ] **Step 5: foundation-rulings annotations (lines 34-40).** Under each bullet, add one indented line in the house style. The bullets and their annotations:

Line 34 (Admin user-lookup name search):
```markdown
  **RESOLVED (SP3):** `searchUsersByName` in `functions/src/adminTools.ts`, backed by `displayNameLower` and the one-shot `backfillDisplayNameLower`.
```
Line 35 (Join-wizard in-flight guard / orphaned-draft cleanup):
```markdown
  **RESOLVED (SP2; SP10 spec 5.6):** the draft cap is checked inside `createProfileDraft`'s transaction (`functions/src/profiles.ts`) and `deleteProfile` is the cleanup path.
```
Line 36 (orphaned pending invites; status restriction):
```markdown
  **RESOLVED (SP2 ruling 4; SP10 spec 5.6):** `deleteProfile` is draft/rejected-only server-side (`functions/src/profiles.ts`, status gate after `requireProfileAdmin`; confirmed product intent), and since sub-project 10 it batch-revokes the profile's `pending` invites in the same cascade.
```
Line 37 (mobile account-screen dedup; requireAuth consolidation):
```markdown
  **RESOLVED (SP2, SP3):** one shared `apps/mobile/src/shell/AccountScreen.tsx` behind three thin wrappers; `requireVerifiedEmail` has a single definition in `functions/src/guards.ts`.
```
Line 38 (`@handle` vanity URL):
```markdown
  **RESOLVED (SP2):** `apps/web/next.config.ts` rewrites `/@:handle` and `/@:handle/shows` to `app/u/[handle]` and 301s the old `/u/` form.
```
Line 39 (rejected-profile revise and resubmit UI):
```markdown
  **RESOLVED (SP2; SP10 spec 5.6):** the editors render "Resubmit for review" for a `rejected` profile (`apps/web/app/dashboard/portfolio/[profileId]/page.tsx` and the curator and mobile twins); sub-project 10 moved the resubmit cooldown to the server-only `users/{uid}.lastProfileRejectedAt` so delete-and-recreate cannot bypass it.
```
Line 40 (mobile lint):
```markdown
  **RESOLVED (SP2 Task 15):** `apps/mobile/eslint.config.js` is tracked and mobile lint 0 errors is a merge gate.
```

- [ ] **Step 6: sp2-rulings annotations (lines 49-58).** Under the bullet at 49-53 (review the deferred admin/internal list, plus the EAS and App Check track):
```markdown
  **RESOLVED (SP3), except the launch track:** every deferred item is annotated resolved in `foundation-rulings.md` (SP3, SP2, and SP10 spec 5.6 for the orphaned invites); the EAS production build and native App Check remain owner-owed (HANDOFF table rows 3, 4, 8).
```
Under the bullet at 54-56 (widen `private/booking` read):
```markdown
  **SUPERSEDED (SP4 Task 2):** SP3 widened the read, then SP4 removed the blanket disjunct and replaced it with the server-built `profiles/{id}/private/curatorBooking` projection (`firestore.rules`, `functions/src/bookingVisibility.ts`); see the M-12/M-13 annotations in `sp3-rulings.md`.
```
Under the bullet at 57-58 (curator wizard treatment):
```markdown
  **RESOLVED (SP3):** `functions/src/curator.ts`, `apps/web/src/curator/CuratorForms.tsx`, `apps/mobile/src/curator/`.
```
Lines 59-62 (the suspension conditional) stay as written; no suspension status exists.

- [ ] **Step 7: sp3-rulings annotations (lines 380-399, the seven post-gate follow-ups).** Under each bullet:

Sweep step 5 per-doc try/catch:
```markdown
  **RESOLVED (SP4 Task 13 item 1):** per-doc try/catch inside the drain loop, `functions/src/scheduled.ts` dailySweep step 5.
```
`gigs.ts` updateGig `| undefined`:
```markdown
  **RESOLVED (SP4 Task 13):** `.data() as GigPrivateLocation | undefined` with the intended internal HttpsError, `functions/src/gigs.ts` updateGig.
```
`removeMember` guards:
```markdown
  **RESOLVED (SP4 Task 13 item 3):** `isValidDocId` on both ids plus `requireVerifiedEmail`, `functions/src/members.ts` removeMember.
```
S4 test gap:
```markdown
  **RESOLVED (SP4 Task 13):** `functions/test/members.test.ts` covers removal from an already-rejected curator profile holding a stale marker.
```
`deleteProfile` handle delete ordering:
```markdown
  **RESOLVED (SP4 Task 13 item 5):** the `handles/{handle}` delete runs after the gig and series cascade behind a precondition, `functions/src/profiles.ts` deleteProfile.
```
Invite-accept fast path:
```markdown
  **RESOLVED (SP4 Task 13 item 6):** `respondToInvite` re-reads profile status after the membership transaction, `functions/src/members.ts`.
```
`syncCuratorAccess` N+1:
```markdown
  **PARTIALLY RESOLVED (SP4):** paginated at 100 memberships per page (`functions/src/curator.ts` syncCuratorAccess), still sequential within a page; the page cap is the recorded mitigation.
```

- [ ] **Step 8: plan banners.** The banner is exactly two lines, followed by one blank line:

```markdown
> **Historical execution record.** This plan was executed and reviewed task by task; its snippets may predate the review fixes that shipped.
> Where the plan and the code disagree, the code and this sub-project's rulings doc win (`docs/superpowers/HANDOFF.md` lists them).
```

Prepend it to the nine plans without touching their content. Run from the Bash tool (Git Bash), never PowerShell 5.1, which corrupts UTF-8 pipelines:

```bash
cd /c/Users/LeoArkos/GateKeepBeta
for f in docs/superpowers/plans/2026-08-*.md; do
  printf '%s\n%s\n\n' \
    '> **Historical execution record.** This plan was executed and reviewed task by task; its snippets may predate the review fixes that shipped.' \
    '> Where the plan and the code disagree, the code and this sub-project'"'"'s rulings doc win (`docs/superpowers/HANDOFF.md` lists them).' \
    | cat - "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done
git diff --numstat -- docs/superpowers/plans/   # nine lines, each "3 0 <file>": three added, zero removed
```

The two `2026-09-02-hardening-*` plans get the same banner in Task 35 Step 7, once they are history.

- [ ] **Step 9: create `docs/superpowers/sp10-rulings.md`.** The skeleton, with the six rulings the spec fixes written in full; the implementer appends execution rulings under the marked heading as they are made during Tasks 1 to 32, and Task 35 fills the gates line and the audit paragraph.

```markdown
# GateKeep Sub-project 10 (Hardening) - Rulings & Handoff

Durable record from sub-project 10, executed on two branches (A: the mechanical sweep, Node 22,
index overrides, CI; B: the hardening proper), subagent-driven with per-task reviews, a
whole-branch security audit, a rules audit on the changed blocks, and a merge to `main`. Mirrors
the sp2 to sp9b rulings docs. This document, like all sub-10 output, contains no em dashes, and
CI now refuses one anywhere in the repo.

Spec: `docs/superpowers/specs/2026-09-02-hardening-design.md` (binding authority)
Plans: `docs/superpowers/plans/2026-09-02-hardening-sweep.md` (branch A, 5 tasks) and the branch B
plan (35 tasks)
Gates at merge: filled in by Task 35 Step 7.

## What shipped

No fan-facing feature. Every item traces to the 2026-09-01 audit (`docs/superpowers/audit-2026-09-01.md`).

- **Branch A**: em-dash sweep (zero U+2014 across apps, functions, packages, tests-rules,
  scripts, docs, README, DESIGN.md, rules), Node 22 (`engines`, `firebase.json`, `.nvmrc`), the
  `tickets.orderId` and `members.uid` override shapes repaired and the unused
  `gigs (bookedMusicianProfileId, startsAt)` composite deleted, `.gitignore` additions, CI with
  the em-dash grep as its last step, dependabot.
- **Money** (`functions/src`): transfer sourcing only when the earnings fit the source charge
  (`sourced: false` otherwise); `STRIPE_CONNECT_WEBHOOK_SECRET` and scope-checked dual
  verification; `charge.dispute.created`, `charge.dispute.closed`, `charge.refunded` handlers
  with `disputes/{disputeId}`; the settlement webhook race closed by a 15-minute owner window;
  captured pending orders completed and stuck ones alerted; `settlementClaimedAt` before the
  ticket transfer.
- **Lifecycle**: events follow the profile (unpublish cancels and refunds future published
  events, drafts flip to cancelled, failures retry via `eventCascadeRetries` and dailySweep step
  9); admin `takedownEvent`; deletion refusals with named blockers on `deleteProfile` and
  `deleteAccount`; `onUserDeleted` calling `cascadeDeleteUser`; push-token rules split and
  pruning; the small lifecycle leftovers of spec 5.6.
- **Product fix-nows**: fail-closed geocoder; browse projections seeded and preserved; the
  booking visibility toggle; the verify-email banner and `EMAIL_NOT_VERIFIED_MESSAGE` retry;
  poster upload via `posterUploads/{uid}/uploads/{nonce}`; `notificationHref` and the mobile notification
  handler; scanner offline panel, launch-zone reminder copy, `undoCheckIn`, the 12-hour check-in
  window; `cancelTicketOrder`, the 5-minute `ticketOrderExpiry`, the sales-final line,
  `receipt_email`, the gig re-promotion refusal, the pending-orders cap; the booking clarity set
  (`fillMode`, run notices, party links, reliability line, reopened-date bookings, past-start
  guards, counter cap reason, offer-expiry notice, grace warnings, step 6 skip); series auto-end,
  propagation skip, inclusive end date, "(UTC)" summaries; env-driven Firebase config,
  project-aware seed scripts, scheduler `retryCount`, `timeZone`, webhook `timeoutSeconds`.

## Load-bearing rulings

1. **Unpublish policy** (owner decision 3). Rejecting an approved curator cancels and refunds
   every future `published` event automatically, full refund including the fan-paid fee, holders
   notified with the existing cancellation notification and the reason "The organizer's account
   is no longer active"; `draft` events flip to `cancelled`; completed and already cancelled
   events are untouched. Each event is its own try/catch; a failure lands in
   `eventCascadeRetries/{eventId}` and dailySweep step 9 drains it. `createTicketOrder` and
   `settleOneEvent` also require the curator profile to be `approved`, closing the ISR window and
   any path the cascade misses. The public events read rule is unchanged.
2. **Dispute policy** (owner decision 4). Record, alert, and gate on open: ledger
   `dispute_opened:{disputeId}`, alert kind `dispute_opened`, `declareCuratorDelinquent` plus a
   member notification for a curator charge, `disputeId` and `disputeStatus: "open"` on a ticket
   order. On a lost dispute reverse the matching transfer (earnings or forfeit, idempotency key
   `dispute_reverse:{disputeId}`; for a ticket order, a partial reversal of the event's
   settlement transfer or a reduction of the pending basis); alert `dispute_reversal_failed` when
   the reversal throws or no transfer exists. On a won dispute clear the gate
   (`clearDelinquencyIfSettled`). Evidence submission stays manual in Stripe. A dashboard refund
   the ledger does not know is `external_refund:{refundId}` plus an alert.
3. **Deletion policy** (owner decision 5). `deleteProfile` refuses, in this order, with
   `DELETE_PROFILE_BALANCE_MESSAGE` (live Stripe balance non-zero),
   `DELETE_PROFILE_DELINQUENT_MESSAGE`, `DELETE_PROFILE_PAYMENTS_MESSAGE` (a payment doc naming
   the profile on either side with a deposit in `held`, `refund_pending`, `forfeit_pending`, or
   attempted `unpaid`, or a settlement in `pending` or `past_due`), and
   `DELETE_PROFILE_EVENTS_MESSAGE` (a `published` event, or a paid order with no
   `settlementStartedAt`). `deleteAccount` refuses with `DELETE_ACCOUNT_TICKETS_MESSAGE` (a
   `valid` or `checked_in` ticket to an event whose `endsAt` is in the future),
   `DELETE_ACCOUNT_TRANSFERS_MESSAGE` (an `offered` transfer on either side), or
   `DELETE_ACCOUNT_ORDERS_MESSAGE` (a `pending` order). Nothing is unwound automatically by
   deletion. The allowed path writes the Stripe customer and account ids into the audit entry
   (`profile_deleted_stripe_ids`) before `recursiveDelete`; account deletion writes
   `account_deleted`. Both clients render the refusal inline, never a bare alert.
4. **Em-dash sweep policy** (owner decision 6). One mechanical sweep of the whole repo, replacement
   chosen by context (colon, comma, period, parentheses), test assertions and README quotes
   updated to match, `apps/web/AGENTS.md` gitignored instead of edited, DESIGN.md's statement of
   the rule names the character instead of printing it. Enforced afterwards by CI's last step
   (`git grep -I` for U+2014 over the swept paths). En dashes in ranges and middots stay.
5. **`source_transaction` cap** (spec 4.1). A transfer is sourced from a charge only when
   `math.earnings <= sourceChargeAmountCents` (`math.chargeTotal` for a settlement,
   `deposit.chargeAmountCents` for a deposit; legacy docs without the field fall back to
   unsourced). An unsourced transfer records `sourced: false`. The forfeit transfer is always
   within the deposit charge and stays sourced. `FakeStripe.transferToAccount` refuses a sourced
   transfer whose amount plus every earlier sourced transfer against the same charge exceeds the
   charge amount, with the same error shape as a live `balance_insufficient`. The standard $1,000
   settlement is therefore unsourced and pays $980.
6. **Two webhook scopes** (spec 4.2). `constructWebhookEvent` verifies against
   `STRIPE_WEBHOOK_SECRET`, then `STRIPE_CONNECT_WEBHOOK_SECRET`, and returns which secret
   verified. An event verified by the platform secret that carries `account` is refused (the SP5
   M1 guard); an event verified by the Connect secret without `account` is refused. Either secret
   missing outside the emulator is a 500 (fail-closed). Endpoint A ("Your account") carries the
   payment-intent, transfer, dispute, and refund events; endpoint B ("Connected accounts")
   carries `account.updated` and `payout.*`.

## Execution rulings (appended by the implementer, one entry per deviation or decision made during Tasks 1 to 32)

Numbering continues from 7. Each entry names the task, the decision, the reason, and the code path.

## Accepted exceptions and deferred (conscious, not oversights)

- Everything in spec section 10: the SP7, SP8, and 5c assignments, the launch checklist's
  console and dashboard work, App Check enforcement, security headers, backups, the accessibility
  and state-coverage findings, messaging, admin tooling beyond the Events block, email delivery
  beyond Stripe receipts, `firebase-admin` 13, ledger rows L62 to L80.

## Audits at merge

Filled in by Task 35 Step 5 and Step 6 (security audit verdict and fix wave, rules audit verdict).

## Owner smoke (the hard pre-launch gate for sub-10)

The consolidated table in `docs/superpowers/HANDOFF.md`, rows 48 to 59: both Stripe endpoints,
the simulated dispute, the new EAS dev build and the smoke additions, the new index and the
repaired overrides, the platform float decision.

## Environment notes

Windows, `corepack pnpm`, Node 22 (`.nvmrc`). Emulator suites need the Java PATH prepend and
`FUNCTIONS_DISCOVERY_TIMEOUT=60`. `pnpm emu:test` is one blocking foreground call of about ten
minutes with a 600000 ms timeout. PowerShell 5.1 corrupts UTF-8 pipelines: docs edits and the
em-dash census run in Git Bash.
```

- [ ] **Step 10: verify and commit.**

```bash
git grep -I -n $'\xe2\x80\x94' -- docs/superpowers README.md     # nothing (exit 1)
grep -c "RESOLVED\|SUPERSEDED\|PARTIALLY RESOLVED" docs/superpowers/foundation-rulings.md   # at least 7
grep -c "RESOLVED\|SUPERSEDED" docs/superpowers/sp2-rulings.md                              # at least 3
grep -c "RESOLVED (SP4 Task 13\|PARTIALLY RESOLVED (SP4)" docs/superpowers/sp3-rulings.md   # at least 7
grep -c "^> \*\*Historical execution record" docs/superpowers/plans/2026-08-*.md            # 1 in each of nine files
grep -n "^## Standing tripwires\|^## Roadmap\|^## Owner-owed" docs/superpowers/HANDOFF.md   # three hits
grep -c "^| [0-9]* |" docs/superpowers/HANDOFF.md                                          # 59
```

Commit: `docs: sub-project 10 handoff, roadmap, tripwires, owner table; rulings annotations; plan banners; sp10-rulings skeleton`

---

### Task 35: final gates, whole-branch security audit, rules audit, merge

**Files:**
- Modify: `docs/superpowers/sp10-rulings.md` (gates line, "Audits at merge", execution rulings closed out), `docs/superpowers/HANDOFF.md` (gate counts, merge date), the two `docs/superpowers/plans/2026-09-02-hardening-*.md` (banner).
- Create: nothing. Code changes only as fix-wave commits the security audit demands.

**Interfaces:**
- Consumes: every commit of Tasks 1 to 34 on `worktree-sp10-hardening`; the SP5 security checklist (`docs/superpowers/plans/2026-08-27-payments.md` line 2374 and `docs/superpowers/sp5-rulings.md` "Audits at merge"); the seeded emulator (`scripts/seed-test-accounts.ts`, `scripts/seed-test-event.ts`).
- Produces: a merge commit on `main`, the branch and worktree removed, the SP7 rebase note delivered.

**Steps:**

- [ ] **Step 1: pre-flight.** In the worktree (`.claude/worktrees/sp10-hardening`, branch `worktree-sp10-hardening`):

```bash
git status --porcelain                         # empty
git fetch origin
git merge-base --is-ancestor origin/main HEAD && echo "main is in" || git merge --no-edit origin/main
git log --oneline origin/main..HEAD | wc -l    # at least 35 (one per task, plus fix commits)
node --version                                 # v22.x (.nvmrc)
export PATH="$HOME/.jre/jdk-21.0.12.1+1-jre/bin:$PATH"; export FUNCTIONS_DISCOVERY_TIMEOUT=60
```

- [ ] **Step 2: gates, each a single foreground call.** Expected results are strict: every count must exceed the sub-project 6 baseline (158 / 704 / 103), because every task in this plan added named tests.

```bash
pnpm typecheck                                        # exit 0, five workspaces reported
pnpm --filter @gatekeep/shared test                   # "Tests  N passed", N > 158
pnpm emu:test                                         # 600000 ms timeout; "Tests  N passed", N > 704, exit 0
pnpm emu:rules                                        # "Tests  N passed", N > 103
pnpm --filter @gatekeep/web lint                      # 0 errors
pnpm --filter @gatekeep/web build                     # exit 0
pnpm --filter @gatekeep/mobile lint                   # 0 errors
pnpm --filter @gatekeep/mobile exec expo export --platform ios --no-bytecode   # bundles (hermesc is App-Control-blocked locally)
git grep -I -n $'\xe2\x80\x94' -- apps functions packages tests-rules scripts docs README.md DESIGN.md firestore.rules storage.rules   # nothing, exit 1
```

Write the four numbers (shared, emu:test, emu:rules, plus the typecheck 5/5) down; Step 7 puts them in three docs. A count equal to the baseline means a task's tests never registered: find the file (`cd functions && npx vitest list | wc -l`) before going further.

- [ ] **Step 3: live page loads against the emulator (RSC discipline).**

```bash
# terminal A (background): emulators
pnpm emu
# terminal B: seed, then capture the event id the event seed prints
FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm tsx scripts/seed-test-accounts.ts
FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm tsx scripts/seed-test-event.ts | tee /tmp/seed-event.log
EVENT_ID=$(grep -o 'e/[A-Za-z0-9]*' /tmp/seed-event.log | head -1 | cut -d/ -f2)
# terminal C (background): web dev server, log captured
pnpm --filter @gatekeep/web dev > /tmp/web-dev.log 2>&1
# signed-out loads: every route answers 200 (or 307 to sign-in for the gated two) and no RSC error
for r in "/@testvenue" "/@testmusician" "/@testvenue/shows" "/e/$EVENT_ID" "/admin" "/dashboard" "/tickets"; do
  printf '%s ' "$r"; curl -s -o /tmp/page.html -w '%{http_code}\n' "http://localhost:3000$r"
  grep -c "Application error\|Unhandled Runtime Error" /tmp/page.html   # 0
done
grep -n "Error:\|only be used in\|Server Components\|use client" /tmp/web-dev.log   # nothing RSC-shaped
```

Then the signed-in pass in a browser (Chrome tooling if available, otherwise by hand): sign in as `test-curator@gatekeep.dev` / `GateKeep-Test1`, load `/dashboard`, `/dashboard/events` (open the seeded event, the poster picker and attendee list render), and the profile's own `/@testvenue`; sign in as `test-fan@gatekeep.dev` and load `/e/$EVENT_ID` and `/tickets` (the verify-email banner must not show, the seed sets `emailVerified`). `/admin` signed in as a non-admin renders the gate, not a crash. Stop both background processes when done.

- [ ] **Step 4: whole-branch security audit.** Dispatch one reviewer on the most capable model (opus) with this brief, verbatim:

> You are auditing branch `worktree-sp10-hardening` of GateKeep (`git diff origin/main...HEAD`, plus the unchanged code those changes call into) before it merges. Output PASS or FAIL first, then findings as `SEVERITY (HIGH/MEDIUM/LOW): file:line, what, why it matters, the fix`. No praise, no summary of what the branch does. The bar is the sub-project 5 audit (`docs/superpowers/sp5-rulings.md` "Audits at merge"): that audit failed on missing `secrets` declarations, a fail-open webhook, and connected-account confusion, and it went to PASS only after a fix wave.
>
> Checklist, from SP5, applied to every changed file:
> 1. The webhook is the only non-callable HTTPS entry: signature verified before any parse, idempotent via `stripeEvents`, App-Check-exempt, and every new handler (`charge.dispute.created`, `charge.dispute.closed`, `charge.refunded`) resolves its charge to a doc our metadata wrote, never to a client-supplied id.
> 2. Saga crash windows: every new money write (dispute reversal, captured-order completion, `settlementClaimedAt`, the events cascade refunds) is either transactional or leaves a doc a sweep step will find and finish; name the step.
> 3. Amount provenance: no client-supplied number reaches a Stripe amount; the sourcing decision (`earnings <= chargeAmountCents`) reads server-written fields only.
> 4. Delinquency and approval gate bypass: `createTicketOrder` and `settleOneEvent` require the approved curator; the dispute gate cannot be cleared by anything but `clearDelinquencyIfSettled`; a rejected curator cannot reach a refund or settlement path through a stale ISR page.
> 5. Clawback abuse: the dispute reversal is keyed `dispute_reverse:{disputeId}` and cannot run twice or against the wrong transfer; `undoCheckIn` cannot be used to double-admit.
> 6. FakeStripe unreachable outside the emulator; every function that touches Stripe declares `secrets: [stripeSecretKey]` and the webhook declares both webhook secrets (`functions/test/stripeSecrets.test.ts` is the proof; read it).
>
> New in this branch, each its own section of your report:
> 7. Disputes: the four purposes (deposit, settlement, paydue, paydue_deposit) and tickets; a `closed` event arriving before `created`; an unknown charge; a Connect-scoped event delivered to the platform endpoint and vice versa.
> 8. The events cascade: `reviewProfile` reject-from-approved, `takedownEvent`, and `cancelAndRefundEventForModeration` with the `system` actor; a poisoned event; the retry queue; refunds to the order's buyer while transferred tickets are torn down for the current owner.
> 9. Deletion: every refusal reason in `deleteProfile` and `deleteAccount`; the order of the gates; that the allowed path cannot orphan a Stripe balance or an offered transfer; `onUserDeleted` with a sole admin; `cascadeDeleteUser` idempotency when the callable and the trigger both run.
> 10. Dual secrets: `constructWebhookEvent` tries the platform secret then the Connect secret; the two cross-scope refusals; a missing secret is a 500 not a 400; no secret value is logged.
> 11. Rules: `pushTokens` split, `notifications.read is bool`, `users.displayName`, `invites` admin read, `posterUploads`, `disputes`, `eventCascadeRetries`; and that no pre-existing rule was weakened (`git diff origin/main -- firestore.rules` shows only additions and the pushTokens split).
> 12. Clients: the verify-email retry cannot loop; `cancelTicketOrder` cannot cancel another buyer's order; the scanner's offline panel cannot be mistaken for a verdict; no Stripe secret under `apps/`.
>
> Cite file and line for everything. If a claim in `docs/superpowers/sp10-rulings.md` is not supported by code, that is a finding.

On FAIL: one commit per finding (`fix(security): <finding>`), each with a test where the finding was testable; re-run the gates of Step 2 that the fixes touch (`emu:test` in full if any function changed; `emu:rules` if rules changed); then re-dispatch the same reviewer scoped to the fix commits (`git diff <first-fix>^..HEAD`) with the instruction "confirm each finding is closed and nothing regressed; PASS or FAIL". Repeat until PASS. Record the verdict, the finding counts by severity, and the number of fix rounds for Step 7.

- [ ] **Step 5: rules audit on the changed blocks.** Run the `firebase-security-rules-auditor` skill with `git diff origin/main -- firestore.rules` as its input and the seven changed blocks named (pushTokens, notifications.read, users.displayName, invites, posterUploads, disputes, eventCascadeRetries), plus the two query-shape matrices Task 2 added (`bookings` list provability, the five `events` SSR shapes). Expected verdict: SECURE, every access-meaningful mutation caught by `tests-rules`, no pre-existing rule weakened. A finding is a fix commit (`fix(rules): ...`) plus a `tests-rules` case, then `pnpm emu:rules` again.

- [ ] **Step 6: close out the rulings doc.** In `docs/superpowers/sp10-rulings.md`: replace `Gates at merge: filled in by Task 35 Step 7.` with `Gates at merge: typecheck 5/5, shared N, emu:test N, emu:rules N, web lint 0 + build, mobile lint 0 + expo export bundles.` using the Step 2 numbers; replace the "## Audits at merge" body with the Step 4 and Step 5 verdicts in the SP5 form (`Whole-branch security audit: <verdict on first pass>, <H/M/L counts>, <rounds>, PASS. Rules audit on the changed blocks: SECURE, <n> blocks, purely additive.`); confirm every execution ruling made during Tasks 1 to 32 is present under "Execution rulings" (walk `git log origin/main..HEAD --format=%B | grep -i "ruling"` for the ones recorded only in commit bodies).

- [ ] **Step 7: HANDOFF counts and date, plan banners for the hardening plans.** In `docs/superpowers/HANDOFF.md` overwrite the three gate counts (line 71-72) with the Step 2 numbers and the "Last updated" day with today's date; in `README.md` "Design docs" overwrite row 10's Merged cell with today's date. Prepend the Task 34 Step 8 banner to `docs/superpowers/plans/2026-09-02-hardening-sweep.md` and the branch B plan (same `printf | cat -` command, two files). Then:

```bash
git grep -I -n $'\xe2\x80\x94' -- docs README.md    # nothing
git add -A && git commit -m "docs: sub-project 10 rulings, handoff counts, plan banners"
```

- [ ] **Step 8: merge.** From the main checkout, not the worktree:

```bash
cd /c/Users/LeoArkos/GateKeepBeta
git checkout main && git pull --ff-only origin main
git merge --no-ff worktree-sp10-hardening -m "Merge sub-project 10: hardening" -m "<the attribution trailer the session prescribes>"
pnpm install --frozen-lockfile && pnpm typecheck        # the merged tree still typechecks (5/5)
git push origin main
gh run watch --exit-status                              # CI (branch A) green on the merge commit, em-dash step included
git worktree remove .claude/worktrees/sp10-hardening
git branch -d worktree-sp10-hardening
git worktree prune && git worktree list                 # only main and the SP7 worktree remain
```

If `gh run watch` fails on the em-dash step, the offending line is in its log; fix on main in a direct commit (small fixes on main between sub-projects are allowed) and push again.

- [ ] **Step 9: the SP7 rebase note.** Deliver this to the SP7 controller (the `sp7-fan-discovery` branch in `.claude/worktrees/sp6-events-ticketing`), verbatim:

> Sub-project 10 merged to main at `<merge sha>`. Rebase now: `git rebase main` (expect conflicts only in `functions/src/index.ts` exports, `packages/shared/src/messages.ts` and `types.ts` additions, `firestore.rules` new blocks, `firestore.indexes.json`, and `docs/superpowers/HANDOFF.md`; keep both sides in each). Adopt before writing more code: (1) no em dash anywhere, CI fails the push; (2) extend `notificationHref` in `packages/shared` for your kinds instead of a second map; (3) build public poster and photo URLs from the path (`apps/web/src/events/posterUrl.ts`), never `getDownloadURL`; (4) any new callable on a curator's events uses `requireApprovedCuratorProfile`; (5) write "dailySweep step N" or "paymentsSweep step N", never a bare step; (6) `notifyUser` now sends `data: { kind, refId }`, and the mobile handler routes through `notificationHref`; (7) `.env.example` sets exist in both apps; add your variables there; (8) `publishEvent`, `updateEvent`, `setEventTiers`, and `reviewTrack` were not rewritten, your hooks into them are safe; (9) HANDOFF's build list and roadmap expect SP7 to add its own entry at its merge, and the owner table is where owner-owed items go now. Gate counts on main after the merge: shared N, emu:test N, emu:rules N (from `sp10-rulings.md`); your counts must exceed them.

The note's `<merge sha>` and the three counts are the real values from Steps 2 and 8.
