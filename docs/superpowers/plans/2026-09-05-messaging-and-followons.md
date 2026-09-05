# Sub-project 12: Messaging, Fan Comments, and the Follow-ons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give musician and curator profiles a direct chat outside the terms-only booking thread, let fans comment and react on public show pages with a curator and artist moderation path plus an admin Reports panel, and close the 2026-09-01 audit's accessibility and state-coverage findings (antislop #10 to #29) along with ledger rows L64, L68, L70, and L79.

**Architecture:** One conversation doc per musician-curator pair (`conversations/{musicianProfileId}__{curatorProfileId}`) owns the participants, the unread counters, the block list, the report counter, and the send-rate window, so `sendMessage` needs exactly one transactional read and write; messages live in its subcollection. Fan comments and reactions hang off the event (`events/{id}/comments`, `events/{id}/reactions/{uid}`, `events/{id}/posts/{postId}/hearts/{uid}`) with counters denormalized onto `EventDoc` and `ShowPostDoc`, and the comment role (fan, curator, artist) is derived server-side from the event's `curatorProfileId` and `lineupMusicianProfileIds` through the existing `isLinkableAct` projection. Every write is callable-only; rules grant reads only. The follow-ons are mechanical edits grouped by platform and by audit item, plus two new web dialog primitives that retire the last ten `window.prompt`, `window.confirm`, and `window.alert` sites.

**Tech Stack:** pnpm monorepo; `packages/shared` (TypeScript, vitest); `functions` (Firebase Functions v2, firebase-admin 12, Node 22, vitest against the emulator suite); `apps/web` (Next.js 16, React 19, Tailwind 4, Radix primitives, Phosphor `/ssr` icons); `apps/mobile` (Expo SDK 57, expo-router typed routes, React Compiler, `phosphor-react-native`); `tests-rules` (`@firebase/rules-unit-testing`). No new dependencies on either client.

**Spec:** `docs/superpowers/specs/2026-09-05-messaging-and-followons-design.md` (binding authority; every ruling below argues from it).

## Global Constraints

- **No em dashes anywhere** (U+2014): code, comments, copy, docs, tests, commit messages, reports. CI's last step fails a push containing one. Use commas, colons, or parentheses.
- `DESIGN.md` (repo root) binds every visual decision; the antislop, antislop-ui, and antislop-copywriting skills bind UI and copy work. No lucide icons, no Inter/Geist/Space Grotesk, no bento grids, **no invented numbers**, no fake testimonials, no emoji in UI.
- Icons: web imports only through `apps/web/src/ui/icons.tsx` (Phosphor `/ssr`, duotone); mobile only through `apps/mobile/src/ui/icons.tsx` (`phosphor-react-native`, duotone). Add new icons there, never import Phosphor elsewhere.
- **Copy is exactly the spec's section 6 strings**, no paraphrase. Chat: "Message"; "Send"; "Write a message"; "You blocked this profile. Unblock to message again."; "Unblock"; "Block"; "Report"; "This conversation is closed."; "No messages yet. Say hello."; "Messages are 1 to 1000 characters."; "You are sending too fast. Try again in a few minutes."; "Only approved profiles can message."; "Report sent. Thanks."; "Why are you reporting this?"; notification title "{senderProfile} messaged {recipientProfile}". Comments: "Going"; "Add a comment"; "Reply"; "Hide"; "Delete"; "Comments are closed."; "No comments yet."; "Comments are 1 to 500 characters."; "Hidden by {who}"; "Comment deleted"; notification title "{name} replied to your comment". Admin: "Reports"; "Resolve"; "Open conversation"; "Hide comment"; "No open reports." Follow-ons: "Whole numbers only."; "No tickets on sale yet."; "New"; "Show more"; dialog primitives "Confirm", "Cancel".
- **Money paths are not touched by this sub-project.** Nothing here calls Stripe, writes `ledger`, `payments`, `orders`, `heldShares`, or `distributions`, or changes settlement, refunds, or payouts. Task 21's L64 change is client-side input validation on `TrueUpForm` only, and never touches `confirmOccurrenceActuals`. If a task looks like it needs a money file, stop and escalate.
- Two sweeps exist, so never write a bare "step N": always `dailySweep step N` (nine steps) or `paymentsSweep step N` (eleven steps). This sub-project adds **no** sweep step to either.
- Every Firestore write from a client goes through a callable. Both clients call callables through `callFn` (`src/lib/callable.ts`), which retries once on a stale verify-email claim.
- Shared code is imported as `@gatekeep/shared`; inside `packages/shared` use relative `./x.js` imports. `functions` imports its own modules with `.js` extensions.
- Notification fan-out stays post-commit and best-effort inside `try { } catch (e) { console.error(...) }` (`sp7-rulings.md` ruling 3), and every dedupe key is create-if-absent through `notifyUser`'s third argument (ruling 2).
- Firestore transactions read before they write (`sp7-rulings.md` ruling 4).
- `isLinkableAct` (booking, or tagged and accepted) is the one predicate for treating a lineup act as a linked artist; never `kind === "booking"` alone (`sp11-rulings.md` ruling 12, HANDOFF tripwire 8).
- Commit after every task with a conventional message (`feat:`, `fix:`, `test:`, `docs:`) plus the session's attribution trailer.
- Emulator runs: one file at a time, from the worktree root, as
  `pnpm --filter functions build && firebase emulators:exec --only auth,firestore,functions,storage "pnpm --filter functions exec vitest run --no-file-parallelism test/<file>"`,
  with Java on PATH (`C:\Users\LeoArkos\.jre\jdk-21.0.12.1+1-jre\bin`) and `FUNCTIONS_DISCOVERY_TIMEOUT=60`. Check port 8080 is free first (`netstat -ano | findstr :8080`); never kill another session's run and never start `firebase emulators:start` by hand. A full `pnpm emu:test` exceeds the tool's 600 s foreground limit; the controller runs it through the detached runner. Never pipe the Firebase CLI to `head` (EPIPE orphans the Firestore emulator).
- A fresh worktree needs an untracked `functions/.secret.local` (copy from the main checkout) and `pnpm --filter @gatekeep/web exec next typegen` before web typecheck.
- Tests import shared fixtures from `functions/test/helpers.ts`, `functions/test/discoverFixtures.ts`, `functions/test/payoutFixtures.ts`, and `functions/test/ticketFixtures.ts`, never from another test file. A missing helper is created in a fixtures file by the task that needs it (this plan adds `functions/test/messagingFixtures.ts`), and a fixture never calls `expect` itself.
- Client tasks carry no browser or device tests (owner-owed). Their gates are typecheck, lint, build (web) or `expo export --no-bytecode` (mobile).
- Gates before merge: `pnpm typecheck` (5/5), shared tests, web tests, `pnpm emu:test`, `pnpm emu:rules`, web lint (0 errors) + build, mobile lint (0 new warnings) + `expo export --no-bytecode`.

---

## File structure

**Shared (`packages/shared/src`)**
- `types.ts`: `ConversationDoc`, `MessageDoc`, `ReportDoc`, `ReportKind`, `ReportStatus`, `EventCommentDoc`, `CommentRole`, `EventReactionDoc`, `PostHeartDoc`, the messaging and comment constants, `EventDoc.goingCount`/`commentCount`, `ShowPostDoc.heartCount`, `NotificationDoc.kind` gains `message` and `comment_reply`, `NotificationDoc.refKind` gains `musician` and `curator`.
- `validation.ts`: `conversationPairId`, `validateMessageText`, `validateCommentText`, `validateReportReason`.
- `messages.ts`: the sub-12 message block. `notificationHref.ts`: the `message` and `comment_reply` branches.

**Backend (`functions/src`)**
- `messaging.ts` (new): `sendMessage`, `markConversationRead`, `setConversationBlock`.
- `comments.ts` (new): `postComment`, `hideComment`, `deleteComment`, `setGoing`, `setPostHeart`, `deriveCommentRole`.
- `reports.ts` (new): `reportConversation`, `reportComment`, `resolveReport`.
- `notifications.ts`: `notifyProfileMembers` gains an optional dedupe key. `index.ts`: exports.

**Rules and indexes**: `firestore.rules`, `firestore.indexes.json`, `tests-rules/messaging.rules.test.ts`.

**Web (`apps/web`)**
- `src/messaging/useConversations.ts`, `ConversationList.tsx`, `ConversationThread.tsx`, `MessageButton.tsx`, `messageCopy.ts`; `app/dashboard/messages/page.tsx`; `src/shell/AppShell.tsx`.
- `src/events/EventComments.tsx`, `src/events/GoingButton.tsx`, `src/discover/ShowPosts.tsx`, `app/e/[eventId]/EventPageClient.tsx`.
- `app/admin/page.tsx` (Reports panel).
- `src/ui/confirm-dialog.tsx`, `src/ui/prompt-dialog.tsx`, `src/ui/button.tsx`, `app/globals.css`, and the follow-on files named per task.

**Mobile (`apps/mobile`)**
- `src/messaging/useConversations.ts`, `ConversationList.tsx`, `ConversationThread.tsx`, `MessageButton.tsx`; `app/(musician)/messages/{_layout,index,[conversationId]}.tsx`; `app/(curator)/messages/{_layout,index,[conversationId]}.tsx`; `app/(musician)/_layout.tsx`, `app/(curator)/_layout.tsx`; `src/notifications/push.ts`.
- `src/events/EventComments.tsx`, `src/events/GoingButton.tsx`, `src/discover/ShowPosts.tsx`, `app/event/[eventId].tsx`.
- `src/ui/Chip.tsx`, `src/theme/useReducedMotion.ts`, and the follow-on files named per task.

**Docs**: `README.md`, `docs/superpowers/HANDOFF.md`, `anti-slop/audit-001-2026-09-01.md`, `docs/superpowers/audit/inheritance-sp7-sp8-5c.md`.

---

### Task 1: Shared types, messages, validators, and notification routes

**Files:**
- Modify: `packages/shared/src/types.ts`, `packages/shared/src/validation.ts`, `packages/shared/src/messages.ts`, `packages/shared/src/notificationHref.ts`
- Test: `packages/shared/test/validation.test.ts` (append), `packages/shared/test/notificationHref.test.ts` (append)

**Interfaces:**
- Produces (every later task imports these from `@gatekeep/shared`): `ConversationDoc`, `MessageDoc`, `MessageWindowDoc`, `ReportDoc`, `ReportKind`, `ReportStatus`, `EventCommentDoc`, `CommentRole`, `EventReactionDoc`, `PostHeartDoc`, `EventDoc.goingCount`, `EventDoc.commentCount`, `ShowPostDoc.heartCount`, `MESSAGE_MAX_CHARS`, `MESSAGE_RATE_MAX`, `MESSAGE_RATE_WINDOW_MS`, `MESSAGE_PREVIEW_CHARS`, `MESSAGE_NOTIFY_BUCKET_MS`, `COMMENT_MAX_CHARS`, `COMMENT_RATE_MAX`, `COMMENT_RATE_WINDOW_MS`, `COMMENT_PAGE_SIZE`, `REPORT_REASON_MAX_CHARS`, `conversationPairId(musicianProfileId, curatorProfileId): string`, `validateMessageText(text: unknown)`, `validateCommentText(text: unknown)`, `validateReportReason(reason: unknown)`, the twenty-nine `messages.ts` constants listed in Step 5, `notificationHref("message", conversationId, platform, refKind)`, `notificationHref("comment_reply", eventId, platform)`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/test/validation.test.ts` (add `conversationPairId`, `validateMessageText`, `validateCommentText`, `validateReportReason`, `MESSAGE_MAX_CHARS`, `COMMENT_MAX_CHARS`, `REPORT_REASON_MAX_CHARS` to the import list at the top of the file):

```ts
describe("sub-12 messaging and comment validators", () => {
  it("builds a stable pair id from the two profile ids, musician first", () => {
    expect(conversationPairId("mus1", "cur1")).toBe("mus1__cur1");
    // The id is positional, not sorted: the musician side always leads, so
    // the same pair resolves to the same doc from either caller.
    expect(conversationPairId("zzz", "aaa")).toBe("zzz__aaa");
  });
  it("accepts 1 to 1000 characters after trim and refuses everything else", () => {
    expect(validateMessageText("  hello  ")).toEqual({ ok: true });
    expect(validateMessageText("x".repeat(MESSAGE_MAX_CHARS))).toEqual({ ok: true });
    for (const bad of ["", "   ", "x".repeat(MESSAGE_MAX_CHARS + 1), 5, null, undefined, {}]) {
      const r = validateMessageText(bad);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toBe("Messages are 1 to 1000 characters.");
    }
  });
  it("accepts 1 to 500 characters for a comment and refuses everything else", () => {
    expect(validateCommentText(" nice set ")).toEqual({ ok: true });
    expect(validateCommentText("x".repeat(COMMENT_MAX_CHARS))).toEqual({ ok: true });
    for (const bad of ["", "  ", "x".repeat(COMMENT_MAX_CHARS + 1), 5, null]) {
      const r = validateCommentText(bad);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toBe("Comments are 1 to 500 characters.");
    }
  });
  it("accepts 1 to 300 characters for a report reason", () => {
    expect(validateReportReason("spam")).toEqual({ ok: true });
    expect(validateReportReason("x".repeat(REPORT_REASON_MAX_CHARS))).toEqual({ ok: true });
    expect(validateReportReason("x".repeat(REPORT_REASON_MAX_CHARS + 1)).ok).toBe(false);
    expect(validateReportReason("   ").ok).toBe(false);
    expect(validateReportReason(7).ok).toBe(false);
  });
});
```

Append to `packages/shared/test/notificationHref.test.ts`:

```ts
  it("routes message rows to the conversation, picking the tab group from refKind on mobile", () => {
    expect(notificationHref("message", "mus1__cur1", "web")).toBe("/dashboard/messages?c=mus1__cur1");
    expect(notificationHref("message", "mus1__cur1", "mobile", "musician")).toBe("/(musician)/messages/mus1__cur1");
    expect(notificationHref("message", "mus1__cur1", "mobile", "curator")).toBe("/(curator)/messages/mus1__cur1");
    // A legacy push with no refKind falls back to the musician group rather
    // than dropping the tap on the floor.
    expect(notificationHref("message", "mus1__cur1", "mobile")).toBe("/(musician)/messages/mus1__cur1");
    expect(notificationHref("message", null, "web")).toBeNull();
  });
  it("routes comment_reply to the event page on both platforms", () => {
    expect(notificationHref("comment_reply", "ev1", "web")).toBe("/e/ev1");
    expect(notificationHref("comment_reply", "ev1", "mobile")).toBe("/event/ev1");
    expect(notificationHref("comment_reply", null, "mobile")).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @gatekeep/shared test`
Expected: FAIL on the four missing validation exports and on `notificationHref` returning null for `message` and `comment_reply`.

- [ ] **Step 3: Types**

Append to `packages/shared/src/types.ts`, after the sub-project 11 block:

```ts
// ---------- Sub-project 12: messaging, fan comments, reactions ----------

// conversations/{pairId}, pairId = "{musicianProfileId}__{curatorProfileId}".
// One doc per musician-curator pair, created by sendMessage on the first
// send. Every field below is server-owned: firestore.rules grants reads to
// members of either participant profile (and to an admin doing a single get
// on a REPORTED conversation) and no writes at all.
export interface ConversationDoc {
  musicianProfileId: string;
  curatorProfileId: string;
  // [musicianProfileId, curatorProfileId], the array-contains field the
  // conversation list query pins. Duplicates the two ids above on purpose:
  // Firestore cannot array-contains across two separate string fields.
  participants: string[];
  lastMessage: { text: string; senderProfileId: string; at: number } | null;
  lastMessageAt: number;
  // profileId -> unread count for THAT profile. Incremented for the
  // recipient on every send, zeroed by markConversationRead.
  unread: Record<string, number>;
  // Profile ids that have blocked this pair. Either side's admins may add
  // their own id. A non-empty array closes sends in BOTH directions
  // (spec 3.1: the blocked side sees no difference and its sends are
  // refused with CONVERSATION_CLOSED_MESSAGE).
  blockedBy: string[];
  // Count of OPEN reports against this conversation. > 0 is what opens the
  // admin read disjunct in firestore.rules, and resolveReport decrements it.
  openReports: number;
  createdAt: number;
  updatedAt: number;
}

// messageWindows/{profileId}: the rolling send-rate window for ONE sender
// profile, across every conversation it takes part in. It is a separate
// server-only doc, not a field on the conversation, because the cap is per
// sender profile and spans threads: a window kept on the conversation would
// let one profile send MESSAGE_RATE_MAX to every venue in town. Read and
// trimmed inside sendMessage's own transaction (one extra tx.get and one
// extra tx.set), same posture and rules stance as commentWindows/{uid} and
// geocodeBudgets/{uid}. Absent for a profile that has never sent.
export interface MessageWindowDoc { at: number[]; }

// conversations/{pairId}/messages/{messageId}
export interface MessageDoc {
  senderProfileId: string;
  // The human who pressed Send, kept alongside the profile so a thread can
  // name the member under the bubble and so abuse review can reach a person.
  senderUid: string;
  text: string;                            // 1 to MESSAGE_MAX_CHARS after trim
  at: number;
}

export const MESSAGE_MAX_CHARS = 1000;
// 30 sends per 10 minutes per SENDER PROFILE, across every conversation that
// profile takes part in (spec 5). Not per conversation: a per-thread window
// would let one profile send 30 messages to every venue in town inside the
// same window. The window lives in messageWindows/{profileId} above.
export const MESSAGE_RATE_MAX = 30;
export const MESSAGE_RATE_WINDOW_MS = 10 * 60 * 1000;
// The notification body is the first MESSAGE_PREVIEW_CHARS characters of the
// message, and at most one message notification per conversation per
// recipient profile per MESSAGE_NOTIFY_BUCKET_MS (the dedupe key carries the
// bucket index).
export const MESSAGE_PREVIEW_CHARS = 120;
export const MESSAGE_NOTIFY_BUCKET_MS = 10 * 60 * 1000;

export type ReportKind = "conversation" | "comment";
export type ReportStatus = "open" | "resolved";
// reports/{reportId}: admin-read, callable-write. targetPath is the
// conversation id for kind "conversation" and "events/{eventId}/comments/
// {commentId}" for kind "comment", so one panel can render both.
export interface ReportDoc {
  kind: ReportKind;
  targetPath: string;
  reporterUid: string;
  // The profile the reporter was acting as, when there is one (a
  // conversation report always has one; a fan reporting a comment does not).
  reporterProfileId: string | null;
  reason: string;                          // 1 to REPORT_REASON_MAX_CHARS after trim
  status: ReportStatus;
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
}
export const REPORT_REASON_MAX_CHARS = 300;

// Server-derived at post time and never re-derived: a fan who later joins the
// curator profile does not retroactively become a "curator" on old comments.
export type CommentRole = "fan" | "curator" | "artist";
// events/{eventId}/comments/{commentId}
export interface EventCommentDoc {
  authorUid: string;
  // Snapshotted from users/{uid}.displayName at post time, the same
  // snapshot discipline tickets and attendees already use.
  authorName: string;
  authorRole: CommentRole;
  // The curator or artist profile the author posted through, null for a fan.
  authorProfileId: string | null;
  // One level only (spec 3.2). A reply's parentId always names a top-level
  // comment; postComment refuses a parentId whose own parentId is set.
  parentId: string | null;
  text: string;                            // 1 to COMMENT_MAX_CHARS after trim
  hidden: boolean;
  hiddenBy: { uid: string; role: CommentRole | "admin" } | null;
  openReports: number;
  at: number;
}
export const COMMENT_MAX_CHARS = 500;
// 10 comments per 10 minutes per USER, across every event (spec 5). Kept in
// commentWindows/{uid} rather than on the event doc: the cap is per user and
// spans events, so no single doc the write already touches can hold it.
export const COMMENT_RATE_MAX = 10;
export const COMMENT_RATE_WINDOW_MS = 10 * 60 * 1000;
export const COMMENT_PAGE_SIZE = 20;

// events/{eventId}/reactions/{uid}: the "Going" toggle, one doc per user.
export interface EventReactionDoc { going: boolean; at: number; }
// events/{eventId}/posts/{postId}/hearts/{uid}: the lineup-post heart.
// Presence IS the heart, so there is no boolean to read.
export interface PostHeartDoc { at: number; }
```

In the same file, `EventDoc` gains, after `hasFreeTier`:

```ts
  // SP12: server-maintained reaction and comment counters. Absent on every
  // pre-SP12 event doc and read as 0 everywhere.
  goingCount?: number;
  commentCount?: number;
```

`ShowPostDoc` gains, after `status`:

```ts
  // SP12: server-maintained heart count for this lineup post. Absent on
  // pre-SP12 posts and read as 0.
  heartCount?: number;
```

`NotificationDoc.kind` gains `| "message" | "comment_reply"`, with the comment line added above the union:

```ts
  // SP12: "message" is a chat message to a profile the recipient belongs to;
  // refId is the conversation id and refKind is the RECIPIENT profile's type
  // ("musician" or "curator"), which is what picks the mobile tab group.
  // "comment_reply" is a curator or artist member answering a fan's comment;
  // refId is the eventId and it opens the public event page.
```

`NotificationDoc.refKind` becomes `refKind?: "event" | "gig" | "profile" | "payouts" | "musician" | "curator";` with the line:

```ts
  // SP12: "musician" / "curator" say which tab group a message notification
  // opens on mobile (the recipient profile's own type).
```

- [ ] **Step 4: Validators**

In `packages/shared/src/validation.ts`, add the import of the three messages (the file already imports from `./messages.js`? it does not: add `import { MESSAGE_LENGTH_MESSAGE, COMMENT_LENGTH_MESSAGE, REPORT_REASON_MESSAGE } from "./messages.js";` at the top) and append at the end of the file:

```ts
// SP12: the conversation doc id for a pair. Positional, not sorted: the
// musician profile id always leads, so both sides compute the same id and
// firestore.rules can read musicianProfileId/curatorProfileId off the doc
// without parsing the id.
export function conversationPairId(musicianProfileId: string, curatorProfileId: string): string {
  return `${musicianProfileId}__${curatorProfileId}`;
}

function lengthCheck(value: unknown, max: number, reason: string): Result {
  if (typeof value !== "string") return { ok: false, reason };
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) return { ok: false, reason };
  return { ok: true };
}

// One sentence per field for every failure shape (not a string, empty, too
// long): each of these backs a single-field composer, so splitting the
// reasons would only make both clients match several strings.
export function validateMessageText(text: unknown): Result {
  return lengthCheck(text, MESSAGE_MAX_CHARS, MESSAGE_LENGTH_MESSAGE);
}
export function validateCommentText(text: unknown): Result {
  return lengthCheck(text, COMMENT_MAX_CHARS, COMMENT_LENGTH_MESSAGE);
}
export function validateReportReason(reason: unknown): Result {
  return lengthCheck(reason, REPORT_REASON_MAX_CHARS, REPORT_REASON_MESSAGE);
}
```

Add `MESSAGE_MAX_CHARS`, `COMMENT_MAX_CHARS`, and `REPORT_REASON_MAX_CHARS` to this file's existing `./types.js` import list.

- [ ] **Step 5: Messages**

Append to `packages/shared/src/messages.ts`:

```ts
// ---------- Sub-project 12 messaging, comments, follow-ons ----------
export const MESSAGE_ACTION_LABEL = "Message";
export const MESSAGE_SEND_LABEL = "Send";
export const MESSAGE_COMPOSER_PLACEHOLDER = "Write a message";
export const CONVERSATION_BLOCKED_MESSAGE = "You blocked this profile. Unblock to message again.";
export const UNBLOCK_LABEL = "Unblock";
export const BLOCK_LABEL = "Block";
export const REPORT_LABEL = "Report";
// The refusal BOTH blocked directions get: the side that was blocked must not
// learn that it was (spec 3.1), so this is deliberately neutral.
export const CONVERSATION_CLOSED_MESSAGE = "This conversation is closed.";
export const CONVERSATION_EMPTY_MESSAGE = "No messages yet. Say hello.";
export const MESSAGE_LENGTH_MESSAGE = "Messages are 1 to 1000 characters.";
// Also the refusal for the comment cap: section 6 carries one rate sentence
// and it reads correctly for both surfaces.
export const MESSAGE_RATE_MESSAGE = "You are sending too fast. Try again in a few minutes.";
export const MESSAGE_UNAPPROVED_MESSAGE = "Only approved profiles can message.";
export const REPORT_SENT_MESSAGE = "Report sent. Thanks.";
export const REPORT_REASON_PROMPT = "Why are you reporting this?";
export const REPORT_REASON_MESSAGE = "Give a reason of 1 to 300 characters.";
export const messageNotificationTitle = (senderProfile: string, recipientProfile: string): string =>
  `${senderProfile} messaged ${recipientProfile}`;

export const GOING_LABEL = "Going";
export const COMMENT_COMPOSER_PLACEHOLDER = "Add a comment";
export const COMMENT_REPLY_LABEL = "Reply";
export const COMMENT_HIDE_LABEL = "Hide";
export const COMMENT_DELETE_LABEL = "Delete";
export const COMMENTS_CLOSED_MESSAGE = "Comments are closed.";
export const COMMENTS_EMPTY_MESSAGE = "No comments yet.";
export const COMMENT_LENGTH_MESSAGE = "Comments are 1 to 500 characters.";
export const commentHiddenLine = (who: string): string => `Hidden by ${who}`;
// The quoted parent of a reply whose parent the author deleted.
export const COMMENT_DELETED_LINE = "Comment deleted";
export const commentReplyNotificationTitle = (name: string): string => `${name} replied to your comment`;
export const COMMENT_EVENT_CLOSED_MESSAGE = "Comments are closed.";

export const REPORTS_PANEL_TITLE = "Reports";
export const REPORT_RESOLVE_LABEL = "Resolve";
export const REPORT_OPEN_CONVERSATION_LABEL = "Open conversation";
export const REPORT_HIDE_COMMENT_LABEL = "Hide comment";
export const REPORTS_EMPTY_MESSAGE = "No open reports.";

export const TRUE_UP_WHOLE_NUMBERS_MESSAGE = "Whole numbers only.";
export const NO_TICKETS_YET_MESSAGE = "No tickets on sale yet.";
export const UNREAD_MARKER_LABEL = "New";
export const SHOW_MORE_LABEL = "Show more";
export const DIALOG_CONFIRM_LABEL = "Confirm";
export const DIALOG_CANCEL_LABEL = "Cancel";
```

- [ ] **Step 6: Notification routes**

In `packages/shared/src/notificationHref.ts`, add `"comment_reply"` to the existing event-kinds branch and add the message branch immediately after it:

```ts
  // SP12: comment_reply carries the eventId and opens the public event page,
  // where the fan's own comment thread lives.
  if (kind === "show_announced" || kind === "show_rescheduled" || kind === "show_post"
      || kind === "artist_tag" || kind === "comment_reply") {
    return refId ? (platform === "web" ? `/e/${refId}` : `/event/${refId}`) : null;
  }
  // SP12: message carries the conversation id. Web has one Messages page and
  // selects the thread from the query string; mobile has one Messages stack
  // per tab group, so refKind (the RECIPIENT profile's type) picks the group.
  // A push written before refKind existed falls back to the musician group
  // rather than dropping the tap.
  if (kind === "message") {
    if (!refId) return null;
    if (platform === "web") return `/dashboard/messages?c=${refId}`;
    return refKind === "curator" ? `/(curator)/messages/${refId}` : `/(musician)/messages/${refId}`;
  }
```

- [ ] **Step 7: Run, typecheck, build, commit**

Run: `pnpm --filter @gatekeep/shared test` (PASS, every prior case too), then `pnpm typecheck` and `pnpm --filter @gatekeep/shared build`.

```bash
git add packages/shared
git commit -m "feat(shared): conversation, message, report, and comment types, validators, copy, and notification routes"
```

---

### Task 2: Rules, indexes, and the rules matrix

**Files:**
- Modify: `firestore.rules`, `firestore.indexes.json`
- Test: `tests-rules/messaging.rules.test.ts` (new)

**Interfaces:**
- Consumes: nothing (rules are text; the doc shapes come from Task 1's types).
- Produces: the read matrix every client task depends on. Conversations and their messages readable by members of either participant profile; an admin may `get` (never `list`) a conversation whose `openReports > 0`; `reports` admin-read; `events/{id}/comments` readable by any signed-in caller when `hidden == false`, and by an admin regardless; `events/{id}/reactions/{uid}` and `events/{id}/posts/{postId}/hearts/{uid}` readable by any signed-in caller; `commentWindows/{uid}` and `messageWindows/{profileId}` invisible to every client, members and admins included. Three composite indexes: `conversations (participants array-contains, lastMessageAt desc)`, `comments (hidden asc, at desc)`, `reports (status asc, createdAt desc)`.

- [ ] **Step 1: Write the failing rules test**

Create `tests-rules/messaging.rules.test.ts`:

```ts
import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { collection, doc, getDoc, getDocs, orderBy, query, setDoc, updateDoc, where } from "firebase/firestore";

// Sub-project 12 rules matrix. Everything below is read-only for clients:
// sendMessage, postComment, the report callables, and resolveReport own
// every write, so each block also proves the client cannot write.

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
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), path), data); });
};

const PAIR = "mus1__cur1";

async function seedPair() {
  await seed("profiles/mus1", { type: "musician", status: "approved", name: "The Act" });
  await seed("profiles/cur1", { type: "curator", status: "approved", name: "The Room" });
  await seed("profiles/mus1/members/mo", { uid: "mo", role: "admin", label: "", joinedAt: 1 });
  await seed("profiles/cur1/members/co", { uid: "co", role: "admin", label: "", joinedAt: 1 });
  await seed(`conversations/${PAIR}`, {
    musicianProfileId: "mus1", curatorProfileId: "cur1", participants: ["mus1", "cur1"],
    lastMessage: { text: "hi", senderProfileId: "mus1", at: 2 }, lastMessageAt: 2,
    unread: { cur1: 1 }, blockedBy: [], openReports: 0, createdAt: 1, updatedAt: 2,
  });
  await seed(`conversations/${PAIR}/messages/m1`, { senderProfileId: "mus1", senderUid: "mo", text: "hi", at: 2 });
}

describe("conversations and messages", () => {
  it("lets members of either side read the doc, the message, and their own list", async () => {
    await seedPair();
    for (const uid of ["mo", "co"]) {
      const db = env.authenticatedContext(uid).firestore();
      await assertSucceeds(getDoc(doc(db, `conversations/${PAIR}`)));
      await assertSucceeds(getDoc(doc(db, `conversations/${PAIR}/messages/m1`)));
      await assertSucceeds(getDocs(query(collection(db, `conversations/${PAIR}/messages`), orderBy("at", "asc"))));
    }
    const mine = env.authenticatedContext("mo").firestore();
    await assertSucceeds(getDocs(query(
      collection(mine, "conversations"),
      where("participants", "array-contains", "mus1"), orderBy("lastMessageAt", "desc"))));
  });

  it("refuses strangers, anonymous callers, and every client write", async () => {
    await seedPair();
    const stranger = env.authenticatedContext("zz").firestore();
    await assertFails(getDoc(doc(stranger, `conversations/${PAIR}`)));
    await assertFails(getDoc(doc(stranger, `conversations/${PAIR}/messages/m1`)));
    await assertFails(getDocs(query(
      collection(stranger, "conversations"),
      where("participants", "array-contains", "mus1"), orderBy("lastMessageAt", "desc"))));
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, `conversations/${PAIR}`)));
    const member = env.authenticatedContext("mo").firestore();
    await assertFails(updateDoc(doc(member, `conversations/${PAIR}`), { unread: { cur1: 0 } }));
    await assertFails(setDoc(doc(member, `conversations/${PAIR}/messages/m2`),
      { senderProfileId: "mus1", senderUid: "mo", text: "sneak", at: 3 }));
  });

  it("lets an admin get a REPORTED conversation only", async () => {
    await seedPair();
    const admin = env.authenticatedContext("ad", { admin: true }).firestore();
    await assertFails(getDoc(doc(admin, `conversations/${PAIR}`)));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `conversations/${PAIR}`), { openReports: 1 });
    });
    await assertSucceeds(getDoc(doc(admin, `conversations/${PAIR}`)));
    await assertSucceeds(getDoc(doc(admin, `conversations/${PAIR}/messages/m1`)));
    // Still no bulk sweep of every conversation, reported or not.
    await assertFails(getDocs(collection(admin, "conversations")));
  });
});

describe("reports", () => {
  it("is admin-read and client-unwritable", async () => {
    await seed("reports/r1", {
      kind: "comment", targetPath: "events/ev1/comments/c1", reporterUid: "fan1",
      reporterProfileId: null, reason: "spam", status: "open",
      resolvedBy: null, resolvedAt: null, createdAt: 1,
    });
    const admin = env.authenticatedContext("ad", { admin: true }).firestore();
    await assertSucceeds(getDoc(doc(admin, "reports/r1")));
    await assertSucceeds(getDocs(query(
      collection(admin, "reports"), where("status", "==", "open"), orderBy("createdAt", "desc"))));
    const fan = env.authenticatedContext("fan1").firestore();
    await assertFails(getDoc(doc(fan, "reports/r1")));
    await assertFails(setDoc(doc(fan, "reports/r2"), { kind: "comment", status: "open" }));
    await assertFails(updateDoc(doc(admin, "reports/r1"), { status: "resolved" }));
  });
});

describe("event comments, reactions, and post hearts", () => {
  const seedEvent = async () => {
    await seed("events/ev1", {
      curatorProfileId: "cur1", title: "Night", status: "published",
      lineup: [], lineupMusicianProfileIds: [], startsAt: 10, endsAt: 20,
    });
    await seed("events/ev1/comments/c1", {
      authorUid: "fan1", authorName: "Fan", authorRole: "fan", authorProfileId: null,
      parentId: null, text: "great", hidden: false, hiddenBy: null, openReports: 0, at: 5,
    });
    await seed("events/ev1/comments/c2", {
      authorUid: "fan2", authorName: "Other", authorRole: "fan", authorProfileId: null,
      parentId: null, text: "bad", hidden: true, hiddenBy: { uid: "co", role: "curator" }, openReports: 1, at: 6,
    });
    await seed("events/ev1/reactions/fan1", { going: true, at: 5 });
    await seed("events/ev1/posts/p1", {
      eventId: "ev1", musicianProfileId: "mus1", authorUid: "mo", text: "see you",
      createdAt: 4, status: "live", heartCount: 1,
    });
    await seed("events/ev1/posts/p1/hearts/fan1", { at: 5 });
  };

  it("shows visible comments to any signed-in caller and hides hidden ones from non-admins", async () => {
    await seedEvent();
    const fan = env.authenticatedContext("fan1").firestore();
    await assertSucceeds(getDoc(doc(fan, "events/ev1/comments/c1")));
    await assertFails(getDoc(doc(fan, "events/ev1/comments/c2")));
    await assertSucceeds(getDocs(query(
      collection(fan, "events/ev1/comments"), where("hidden", "==", false), orderBy("at", "desc"))));
    // An unpinned list would include the hidden doc, so it must fail.
    await assertFails(getDocs(query(collection(fan, "events/ev1/comments"), orderBy("at", "desc"))));
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "events/ev1/comments/c1")));
    const admin = env.authenticatedContext("ad", { admin: true }).firestore();
    await assertSucceeds(getDoc(doc(admin, "events/ev1/comments/c2")));
    await assertSucceeds(getDocs(query(collection(admin, "events/ev1/comments"), orderBy("at", "desc"))));
  });

  it("shows reactions and hearts to any signed-in caller and refuses every client write", async () => {
    await seedEvent();
    const fan = env.authenticatedContext("fan1").firestore();
    await assertSucceeds(getDoc(doc(fan, "events/ev1/reactions/fan1")));
    await assertSucceeds(getDoc(doc(fan, "events/ev1/posts/p1/hearts/fan1")));
    await assertFails(setDoc(doc(fan, "events/ev1/reactions/fan1"), { going: false, at: 9 }));
    await assertFails(setDoc(doc(fan, "events/ev1/posts/p1/hearts/fan1"), { at: 9 }));
    await assertFails(setDoc(doc(fan, "events/ev1/comments/c3"),
      { authorUid: "fan1", text: "sneak", hidden: false, at: 9 }));
    await assertFails(updateDoc(doc(fan, "events/ev1/comments/c1"), { hidden: true }));
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "events/ev1/reactions/fan1")));
  });
});

describe("the rate-limit windows", () => {
  it("keeps commentWindows and messageWindows invisible to owners, members, and admins", async () => {
    await seedPair();
    await seed("commentWindows/fan1", { at: [1, 2, 3] });
    await seed("messageWindows/mus1", { at: [1, 2, 3] });
    const fan = env.authenticatedContext("fan1").firestore();
    await assertFails(getDoc(doc(fan, "commentWindows/fan1")));
    await assertFails(setDoc(doc(fan, "commentWindows/fan1"), { at: [] }));
    // A member of the very profile the window belongs to still cannot read
    // it: the window is server bookkeeping, not a user-facing quota display.
    const member = env.authenticatedContext("mo").firestore();
    await assertFails(getDoc(doc(member, "messageWindows/mus1")));
    await assertFails(setDoc(doc(member, "messageWindows/mus1"), { at: [] }));
    const admin = env.authenticatedContext("ad", { admin: true }).firestore();
    await assertFails(getDoc(doc(admin, "commentWindows/fan1")));
    await assertFails(getDoc(doc(admin, "messageWindows/mus1")));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm emu:rules`
Expected: FAIL, every read in the new file is denied by the catch-all `match /{document=**}` rule because none of these collections exist in `firestore.rules` yet.

- [ ] **Step 3: Add the rules**

In `firestore.rules`, insert immediately before the `// ---------- Sub-project 10: hardening ----------` banner:

```
    // ---------- Sub-project 12: messaging, comments, reactions ----------
    // conversations/{pairId}, pairId = "{musicianProfileId}__{curatorProfileId}".
    // Members of EITHER participant profile read the doc and its messages;
    // an admin may read one only while it carries an open report (the
    // Reports panel opens exactly one conversation by id, so this is a get,
    // never a list: an unfiltered admin list over the collection still
    // fails, which is the point of scoping abuse review to what was
    // reported). Every write is a callable (messaging.ts, reports.ts).
    //
    // The participants array-contains list query is provable per document:
    // the two isMember() lookups are evaluated per result doc, exactly the
    // shape bookings/{bookingId} above already uses.
    match /conversations/{pairId} {
      allow read: if isMember(resource.data.musicianProfileId)
        || isMember(resource.data.curatorProfileId)
        || (isAdmin() && resource.data.openReports > 0);
      allow write: if false; // Cloud Functions only

      match /messages/{messageId} {
        // A message doc carries no participant ids of its own, so the
        // audience is proven with a get() on the parent, the same idiom
        // events/{id}/tiers and gigs/private/location already use.
        allow read: if isMember(get(/databases/$(database)/documents/conversations/$(pairId)).data.musicianProfileId)
          || isMember(get(/databases/$(database)/documents/conversations/$(pairId)).data.curatorProfileId)
          || (isAdmin() && get(/databases/$(database)/documents/conversations/$(pairId)).data.openReports > 0);
        allow write: if false;
      }
    }

    // Abuse reports for both surfaces. Admin-read, server-write, the same
    // posture as adminAlerts and disputes above; resolveReport is the only
    // thing that flips status.
    match /reports/{reportId} { allow read: if isAdmin(); allow write: if false; }

    // events/{eventId}/comments/{commentId}: any signed-in caller reads a
    // visible comment, admins read hidden ones too (spec 3.2: "Hidden
    // comments vanish for everyone except admins"). Signed-in and not
    // public, because commenting itself needs an account: an anonymous
    // visitor sees the show, not the room's conversation. A non-admin list
    // MUST pin hidden == false for the rule to hold over every result.
    match /events/{eventId}/comments/{commentId} {
      allow read: if isAdmin() || (signedIn() && resource.data.hidden == false);
      allow write: if false; // Cloud Functions only
    }
    // The "Going" toggle and the lineup-post heart: signed-in read (the
    // counts themselves live on the parent event and post docs, which are
    // already public), callable-only write.
    match /events/{eventId}/reactions/{uid} {
      allow read: if signedIn();
      allow write: if false;
    }
    match /events/{eventId}/posts/{postId}/hearts/{uid} {
      allow read: if signedIn();
      allow write: if false;
    }
    // Per-user rolling comment-rate window (comments.ts) and per-profile
    // rolling send-rate window (messaging.ts). Internal bookkeeping only,
    // never read by any client (not even the owner or a member of the
    // profile, and not an admin), same posture as geocodeBudgets and
    // searchBudgets above.
    match /commentWindows/{uid} { allow read, write: if false; }
    match /messageWindows/{profileId} { allow read, write: if false; }

```

- [ ] **Step 4: Add the indexes**

In `firestore.indexes.json`, append three entries to the `indexes` array (after the last `heldShares` entry, before the closing `]`):

```json
  { "collectionGroup": "conversations", "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "participants", "arrayConfig": "CONTAINS" },
      { "fieldPath": "lastMessageAt", "order": "DESCENDING" }
    ] },
  { "collectionGroup": "comments", "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "hidden", "order": "ASCENDING" },
      { "fieldPath": "at", "order": "DESCENDING" }
    ] },
  { "collectionGroup": "reports", "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "status", "order": "ASCENDING" },
      { "fieldPath": "createdAt", "order": "DESCENDING" }
    ] }
```

The admin comment list (no `hidden` pin, one `orderBy("at","desc")`) needs no composite; the conversation message list (one `orderBy("at","asc")` inside one parent) needs none either.

- [ ] **Step 5: Run and commit**

Run: `pnpm emu:rules`
Expected: PASS, the previous total plus 7.

```bash
git add firestore.rules firestore.indexes.json tests-rules/messaging.rules.test.ts
git commit -m "feat: conversation, report, comment, and reaction rules plus three composite indexes"
```

---

### Task 3: `sendMessage`, `markConversationRead`, `setConversationBlock`

**Files:**
- Create: `functions/src/messaging.ts`, `functions/test/messagingFixtures.ts`
- Modify: `functions/src/notifications.ts`, `functions/src/index.ts`
- Test: `functions/test/messaging.test.ts` (new)

**Interfaces:**
- Consumes: `requireAuthUid`, `requireVerifiedEmail`, `requireProfileMember` from `./guards.js`; `requireProfileAdmin` from `./profiles.js`; `notifyProfileMembers` from `./notifications.js`; `conversationPairId`, `validateMessageText`, `ConversationDoc`, `MessageDoc`, `MessageWindowDoc`, `ProfileDoc`, `MESSAGE_RATE_MAX`, `MESSAGE_RATE_WINDOW_MS`, `MESSAGE_PREVIEW_CHARS`, `MESSAGE_NOTIFY_BUCKET_MS`, `MESSAGE_RATE_MESSAGE`, `MESSAGE_UNAPPROVED_MESSAGE`, `CONVERSATION_CLOSED_MESSAGE`, `messageNotificationTitle`, `isValidDocId` from shared (Task 1).
- Produces: `sendMessage({ fromProfileId, toProfileId, text }): { conversationId: string; messageId: string }`, `markConversationRead({ profileId, conversationId }): { ok: true }`, `setConversationBlock({ profileId, conversationId, blocked }): { ok: true; blockedBy: string[] }`, all exported from `functions/src/index.ts`; `sendMessage` is the only writer of `messageWindows/{profileId}` (Task 2 made it client-unreadable); `notifyProfileMembers(profileId, note, dedupeKey?)`; and the fixtures `makeMessagingPair(prefix)`, `sendAs(user, fromProfileId, toProfileId, text)` in `functions/test/messagingFixtures.ts`, which Tasks 5 reuses.

- [ ] **Step 1: Write the fixtures**

Create `functions/test/messagingFixtures.ts`:

```ts
import type { User } from "firebase/auth";
import { callFn } from "./helpers";
import { adb, makeApprovedCuratorProfile, makeApprovedMusicianProfile } from "./discoverFixtures";
import { conversationPairId, type ConversationDoc, type MessageDoc } from "@gatekeep/shared";

// An approved musician profile and an approved curator profile plus their
// owners and the pair id they resolve to. No expect() here (fixtures never
// assert); the tests that use it do the asserting.
export async function makeMessagingPair(prefix: string) {
  const musician = await makeApprovedMusicianProfile(`${prefix}m`);
  const curator = await makeApprovedCuratorProfile(`${prefix}c`, "venue");
  return {
    musician, curator,
    musicianProfileId: musician.profileId, curatorProfileId: curator.profileId,
    pairId: conversationPairId(musician.profileId, curator.profileId),
  };
}

export function sendAs(user: User, fromProfileId: string, toProfileId: string, text: string) {
  return callFn<{ fromProfileId: string; toProfileId: string; text: string },
    { conversationId: string; messageId: string }>(
    "sendMessage", { fromProfileId, toProfileId, text }, user);
}

export async function conversation(pairId: string): Promise<ConversationDoc | undefined> {
  return (await adb.doc(`conversations/${pairId}`).get()).data() as ConversationDoc | undefined;
}

export async function messages(pairId: string): Promise<MessageDoc[]> {
  const snap = await adb.collection(`conversations/${pairId}/messages`).orderBy("at", "asc").get();
  return snap.docs.map((d) => d.data() as MessageDoc);
}

export async function notesOfKind(uid: string, kind: string) {
  const snap = await adb.collection(`users/${uid}/notifications`).where("kind", "==", kind).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
```

Confirm `makeApprovedMusicianProfile` and `makeApprovedCuratorProfile` return `{ owner, uid, profileId }` before relying on the shape (`functions/test/discoverFixtures.ts:17` and `:32`); `owner` carries `.user` and `.uid`.

- [ ] **Step 2: Write the failing test**

Create `functions/test/messaging.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import { adb, makeApprovedCuratorProfile } from "./discoverFixtures";
import { addMember } from "./payoutFixtures";
import { makeMessagingPair, sendAs, conversation, messages, notesOfKind } from "./messagingFixtures";
import { MESSAGE_RATE_MAX } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 90_000 });

describe("sendMessage", () => {
  it("creates the conversation on first send, increments the other side's unread, and notifies once per bucket", async () => {
    const p = await makeMessagingPair("sm1");
    const first = await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "  hello there  ");
    expect(first.conversationId).toBe(p.pairId);

    const conv = await conversation(p.pairId);
    expect(conv).toMatchObject({
      musicianProfileId: p.musicianProfileId, curatorProfileId: p.curatorProfileId,
      blockedBy: [], openReports: 0,
    });
    expect(conv!.participants.sort()).toEqual([p.curatorProfileId, p.musicianProfileId].sort());
    expect(conv!.unread[p.curatorProfileId]).toBe(1);
    expect(conv!.unread[p.musicianProfileId] ?? 0).toBe(0);
    expect(conv!.lastMessage).toMatchObject({ text: "hello there", senderProfileId: p.musicianProfileId });
    expect(conv!.lastMessageAt).toBe(conv!.lastMessage!.at);

    const rows = await messages(p.pairId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      senderProfileId: p.musicianProfileId, senderUid: p.musician.owner.uid, text: "hello there",
    });

    const notes = await notesOfKind(p.curator.owner.uid, "message");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ refId: p.pairId, refKind: "curator" });
    expect((notes[0] as { title: string }).title).toContain("messaged");
    expect((notes[0] as { body: string }).body).toBe("hello there");
    // The sender's own members are never notified.
    expect(await notesOfKind(p.musician.owner.uid, "message")).toHaveLength(0);

    // A second send inside the same 10-minute bucket adds a message but no
    // second notification (create-if-absent on the bucketed dedupe key).
    await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "still there?");
    expect(await messages(p.pairId)).toHaveLength(2);
    expect((await conversation(p.pairId))!.unread[p.curatorProfileId]).toBe(2);
    expect(await notesOfKind(p.curator.owner.uid, "message")).toHaveLength(1);
  });

  it("lets the curator side start the same conversation, and notifies every member", async () => {
    const p = await makeMessagingPair("sm2");
    const extra = await addMember(p.curatorProfileId, "sm2x");
    const res = await sendAs(p.curator.owner.user, p.curatorProfileId, p.musicianProfileId, "we have a Friday");
    expect(res.conversationId).toBe(p.pairId);
    const conv = await conversation(p.pairId);
    expect(conv!.unread[p.musicianProfileId]).toBe(1);
    expect(await notesOfKind(p.musician.owner.uid, "message")).toHaveLength(1);
    // A second curator-side member sending later notifies the musician side,
    // and the extra member is a valid sender.
    await sendAs(extra.user, p.curatorProfileId, p.musicianProfileId, "from the other manager");
    expect((await messages(p.pairId))[1].senderUid).toBe(extra.uid);
  });

  it("refuses non-members, bad pairs, unapproved profiles, and bad text", async () => {
    const p = await makeMessagingPair("sm3");
    const stranger = await signUpTestUser(`sm3s-${Date.now()}@test.com`);
    await expect(sendAs(stranger.user, p.musicianProfileId, p.curatorProfileId, "hi"))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    await expect(callFn("sendMessage",
      { fromProfileId: p.musicianProfileId, toProfileId: p.curatorProfileId, text: "hi" }))
      .rejects.toMatchObject({ code: "functions/unauthenticated" });

    // Two musicians, or two curators, are not a valid pair.
    const other = await makeMessagingPair("sm3b");
    await expect(sendAs(p.musician.owner.user, p.musicianProfileId, other.musicianProfileId, "hi"))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });

    for (const text of ["", "   ", "x".repeat(1001), 5, null]) {
      await expect(callFn("sendMessage",
        { fromProfileId: p.musicianProfileId, toProfileId: p.curatorProfileId, text }, p.musician.owner.user))
        .rejects.toMatchObject({
          code: "functions/invalid-argument", message: "Messages are 1 to 1000 characters.",
        });
    }

    await adb.doc(`profiles/${p.curatorProfileId}`).update({ status: "pending_review" });
    await expect(sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "hi"))
      .rejects.toMatchObject({
        code: "functions/failed-precondition", message: "Only approved profiles can message.",
      });
  });

  it("caps a sender profile at MESSAGE_RATE_MAX per window ACROSS conversations, and keeps the window bounded", async () => {
    const p = await makeMessagingPair("sm4");
    // A second curator profile the same musician can also message: the cap
    // must span both threads, so a spammer cannot buy a fresh 30 by opening
    // a new conversation with the next venue in town.
    const second = await makeApprovedCuratorProfile("sm4b", "venue");

    const half = MESSAGE_RATE_MAX / 2;
    for (let i = 0; i < half; i += 1) {
      await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, `first thread ${i}`);
    }
    for (let i = 0; i < MESSAGE_RATE_MAX - half; i += 1) {
      await sendAs(p.musician.owner.user, p.musicianProfileId, second.profileId, `second thread ${i}`);
    }
    // The 31st send fails in EITHER conversation, including the one that has
    // only ever seen half the burst.
    for (const target of [p.curatorProfileId, second.profileId]) {
      await expect(sendAs(p.musician.owner.user, p.musicianProfileId, target, "one too many"))
        .rejects.toMatchObject({
          code: "functions/resource-exhausted",
          message: "You are sending too fast. Try again in a few minutes.",
        });
    }
    const window = (await adb.doc(`messageWindows/${p.musicianProfileId}`).get()).data() as { at: number[] };
    expect(window.at).toHaveLength(MESSAGE_RATE_MAX);
    // Nothing rate-related is left on the conversation doc.
    expect((await conversation(p.pairId)) as Record<string, unknown>).not.toHaveProperty("sendWindow");
    // The other side is unaffected: the window is per SENDER profile.
    await expect(sendAs(p.curator.owner.user, p.curatorProfileId, p.musicianProfileId, "still fine"))
      .resolves.toMatchObject({ conversationId: p.pairId });

    // Ageing every timestamp out of the window reopens sending everywhere.
    await adb.doc(`messageWindows/${p.musicianProfileId}`).set({ at: [Date.now() - 11 * 60 * 1000] });
    await expect(sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "back"))
      .resolves.toMatchObject({ conversationId: p.pairId });
  });
});

describe("setConversationBlock and markConversationRead", () => {
  it("blocks in both directions from either side's admin, and unblocks", async () => {
    const p = await makeMessagingPair("bk1");
    await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "hello");

    const plain = await addMember(p.curatorProfileId, "bk1p");
    await expect(callFn("setConversationBlock",
      { profileId: p.curatorProfileId, conversationId: p.pairId, blocked: true }, plain.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });

    await callFn("setConversationBlock",
      { profileId: p.curatorProfileId, conversationId: p.pairId, blocked: true }, p.curator.owner.user);
    expect((await conversation(p.pairId))!.blockedBy).toEqual([p.curatorProfileId]);

    // Both directions refuse with the SAME neutral sentence.
    for (const [user, from, to] of [
      [p.musician.owner.user, p.musicianProfileId, p.curatorProfileId],
      [p.curator.owner.user, p.curatorProfileId, p.musicianProfileId],
    ] as const) {
      await expect(sendAs(user, from, to, "anyone there"))
        .rejects.toMatchObject({
          code: "functions/failed-precondition", message: "This conversation is closed.",
        });
    }
    // A profile cannot lift another profile's block.
    await callFn("setConversationBlock",
      { profileId: p.musicianProfileId, conversationId: p.pairId, blocked: false }, p.musician.owner.user);
    expect((await conversation(p.pairId))!.blockedBy).toEqual([p.curatorProfileId]);

    await callFn("setConversationBlock",
      { profileId: p.curatorProfileId, conversationId: p.pairId, blocked: false }, p.curator.owner.user);
    expect((await conversation(p.pairId))!.blockedBy).toEqual([]);
    await expect(sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "back on"))
      .resolves.toMatchObject({ conversationId: p.pairId });
  });

  it("zeroes only the reader's own unread count, and refuses a non-member", async () => {
    const p = await makeMessagingPair("mr1");
    await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "one");
    await sendAs(p.curator.owner.user, p.curatorProfileId, p.musicianProfileId, "two");
    expect((await conversation(p.pairId))!.unread).toMatchObject({
      [p.curatorProfileId]: 1, [p.musicianProfileId]: 1,
    });
    await callFn("markConversationRead",
      { profileId: p.curatorProfileId, conversationId: p.pairId }, p.curator.owner.user);
    const conv = await conversation(p.pairId);
    expect(conv!.unread[p.curatorProfileId]).toBe(0);
    expect(conv!.unread[p.musicianProfileId]).toBe(1);
    // Idempotent.
    await callFn("markConversationRead",
      { profileId: p.curatorProfileId, conversationId: p.pairId }, p.curator.owner.user);
    expect((await conversation(p.pairId))!.unread[p.curatorProfileId]).toBe(0);

    const stranger = await signUpTestUser(`mr1s-${Date.now()}@test.com`);
    await expect(callFn("markConversationRead",
      { profileId: p.curatorProfileId, conversationId: p.pairId }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter functions build && firebase emulators:exec --only auth,firestore,functions,storage "pnpm --filter functions exec vitest run --no-file-parallelism test/messaging.test.ts"`
Expected: FAIL with "not-found" for the three callables.

- [ ] **Step 4: Widen `notifyProfileMembers`**

In `functions/src/notifications.ts`, replace `notifyProfileMembers` with:

```ts
// SP12 widens this with an optional dedupeKey the same way SP11 widened
// notifyProfileAdmins below: every pre-SP12 caller passes two arguments and
// is unaffected. messaging.ts passes a per-conversation, per-10-minute key so
// a burst of messages surfaces once in each recipient member's inbox.
export async function notifyProfileMembers(
  profileId: string, note: Omit<NotificationDoc, "read" | "createdAt">, dedupeKey?: string,
) {
  const members = await getFirestore().collection(`profiles/${profileId}/members`).get();
  await Promise.all(members.docs.map((m) => notifyUser(m.id, note, dedupeKey)));
}
```

- [ ] **Step 5: Implement `functions/src/messaging.ts`**

```ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import {
  conversationPairId, validateMessageText, isValidDocId,
  MESSAGE_RATE_MAX, MESSAGE_RATE_WINDOW_MS, MESSAGE_PREVIEW_CHARS, MESSAGE_NOTIFY_BUCKET_MS,
  MESSAGE_RATE_MESSAGE, MESSAGE_UNAPPROVED_MESSAGE, CONVERSATION_CLOSED_MESSAGE,
  messageNotificationTitle,
  type ConversationDoc, type MessageDoc, type MessageWindowDoc, type ProfileDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember } from "./guards.js";
import { requireProfileAdmin } from "./profiles.js";
import { notifyProfileMembers } from "./notifications.js";

// SP12 (spec sections 3.1 and 5). Conversations are between exactly one
// musician profile and one curator profile; either side may start one and
// every member of either side can read and reply. Fans are not part of chat
// at all, which is why every entry point here is a profile id, never a uid.

interface SendMessageInput { fromProfileId: string; toProfileId: string; text: string }

// The pair, in canonical order, plus both profile docs. Throws the spec's own
// refusals: a pair that is not one musician and one curator is a
// failed-precondition, and an unapproved profile on either side gets
// MESSAGE_UNAPPROVED_MESSAGE (a curator whose approval was pulled must not be
// reachable, and an unapproved musician has no public act yet).
async function resolvePair(fromProfileId: string, toProfileId: string) {
  const db = getFirestore();
  const [from, to] = await Promise.all([
    db.doc(`profiles/${fromProfileId}`).get(), db.doc(`profiles/${toProfileId}`).get(),
  ]);
  if (!from.exists || !to.exists) throw new HttpsError("not-found", "Profile not found.");
  const fromDoc = from.data() as ProfileDoc;
  const toDoc = to.data() as ProfileDoc;
  const musician = fromDoc.type === "musician" ? fromProfileId : toProfileId;
  const curator = fromDoc.type === "curator" ? fromProfileId : toProfileId;
  if (fromDoc.type === toDoc.type) {
    throw new HttpsError("failed-precondition", "Chat is between a musician profile and a curator profile.");
  }
  if (fromDoc.status !== "approved" || toDoc.status !== "approved") {
    throw new HttpsError("failed-precondition", MESSAGE_UNAPPROVED_MESSAGE);
  }
  return { musicianProfileId: musician, curatorProfileId: curator, fromDoc, toDoc };
}

export const sendMessage = onCall<SendMessageInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuthUid(req);
  requireVerifiedEmail(req);
  const { fromProfileId, toProfileId } = req.data ?? {};
  if (!isValidDocId(fromProfileId) || !isValidDocId(toProfileId) || fromProfileId === toProfileId) {
    throw new HttpsError("invalid-argument", "Two profiles are required.");
  }
  const check = validateMessageText(req.data?.text);
  if (!check.ok) throw new HttpsError("invalid-argument", check.reason);
  const text = (req.data.text as string).trim();

  await requireProfileMember(fromProfileId, uid);
  const { musicianProfileId, curatorProfileId, fromDoc, toDoc } = await resolvePair(fromProfileId, toProfileId);
  const pairId = conversationPairId(musicianProfileId, curatorProfileId);

  const db = getFirestore();
  const convRef = db.doc(`conversations/${pairId}`);
  // The rate window belongs to the SENDER PROFILE, not to this pair: the cap
  // is 30 per 10 minutes per sender profile across every conversation it
  // takes part in (spec 5). A window kept on the conversation doc would have
  // been one read cheaper and completely wrong: a spammer would simply open a
  // new thread with the next venue and get another 30. Same posture and rules
  // stance as commentWindows/{uid} and geocodeBudgets/{uid}.
  const windowRef = db.doc(`messageWindows/${fromProfileId}`);
  const now = Date.now();

  // One transaction does the whole write: read the conversation (or decide it
  // is new) AND the sender's window, check the block list and the cap, append
  // the message, roll lastMessage/lastMessageAt, increment the RECIPIENT's
  // unread counter, and trim the window. Both reads precede every write
  // (sp7 ruling 4), which is why they are issued together up top.
  const messageId = await db.runTransaction(async (tx) => {
    const [snap, windowSnap] = await Promise.all([tx.get(convRef), tx.get(windowRef)]);
    const existing = snap.exists ? (snap.data() as ConversationDoc) : null;
    if (existing && existing.blockedBy.length > 0) {
      // Neutral in BOTH directions: the blocked side must not learn it was
      // blocked, and the blocking side sees its own banner client-side.
      throw new HttpsError("failed-precondition", CONVERSATION_CLOSED_MESSAGE);
    }
    const prior = (windowSnap.data() as MessageWindowDoc | undefined)?.at ?? [];
    const recent = prior.filter((t) => now - t < MESSAGE_RATE_WINDOW_MS);
    if (recent.length >= MESSAGE_RATE_MAX) throw new HttpsError("resource-exhausted", MESSAGE_RATE_MESSAGE);
    recent.push(now);

    const msgRef = convRef.collection("messages").doc();
    const message: MessageDoc = { senderProfileId: fromProfileId, senderUid: uid, text, at: now };
    tx.set(msgRef, message);
    // slice keeps the array bounded at MESSAGE_RATE_MAX entries forever, so a
    // busy profile never grows an unbounded field.
    tx.set(windowRef, { at: recent.slice(-MESSAGE_RATE_MAX) } satisfies MessageWindowDoc);

    if (!existing) {
      const conversation: ConversationDoc = {
        musicianProfileId, curatorProfileId,
        participants: [musicianProfileId, curatorProfileId],
        lastMessage: { text, senderProfileId: fromProfileId, at: now },
        lastMessageAt: now,
        unread: { [musicianProfileId]: 0, [curatorProfileId]: 0, [toProfileId]: 1 },
        blockedBy: [], openReports: 0,
        createdAt: now, updatedAt: now,
      };
      tx.set(convRef, conversation);
    } else {
      tx.update(convRef, {
        lastMessage: { text, senderProfileId: fromProfileId, at: now },
        lastMessageAt: now,
        [`unread.${toProfileId}`]: (existing.unread?.[toProfileId] ?? 0) + 1,
        updatedAt: now,
      });
    }
    return msgRef.id;
  });

  // Post-commit, best-effort fan-out (sp7 ruling 3). One notification per
  // conversation per recipient profile per MESSAGE_NOTIFY_BUCKET_MS: the
  // dedupe key carries the bucket index and notifyUser creates if absent, so
  // a burst does not flood every member's inbox.
  try {
    const bucket = Math.floor(now / MESSAGE_NOTIFY_BUCKET_MS);
    await notifyProfileMembers(toProfileId, {
      kind: "message", refId: pairId,
      refKind: toDoc.type === "curator" ? "curator" : "musician",
      title: messageNotificationTitle(fromDoc.name, toDoc.name),
      body: text.length > MESSAGE_PREVIEW_CHARS ? `${text.slice(0, MESSAGE_PREVIEW_CHARS - 3)}...` : text,
    }, `message:${pairId}:${bucket}`);
  } catch (e) {
    console.error("sendMessage: fan-out failed", pairId, e);
  }

  return { conversationId: pairId, messageId };
});

export const markConversationRead = onCall<{ profileId: string; conversationId: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { profileId, conversationId } = req.data ?? {};
    if (!isValidDocId(profileId) || !isValidDocId(conversationId)) {
      throw new HttpsError("invalid-argument", "A profile and a conversation are required.");
    }
    await requireProfileMember(profileId, uid);
    const ref = getFirestore().doc(`conversations/${conversationId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Conversation not found.");
    const conv = snap.data() as ConversationDoc;
    if (!conv.participants.includes(profileId)) {
      throw new HttpsError("permission-denied", "That profile is not in this conversation.");
    }
    // Zeroes only this profile's own counter; a plain update, not a
    // transaction: a concurrent send incrementing the OTHER profile's key
    // does not collide with this one, and a send to THIS profile racing the
    // read simply lands as a new unread the next snapshot shows.
    await ref.update({ [`unread.${profileId}`]: 0, updatedAt: Date.now() });
    return { ok: true as const };
  });

export const setConversationBlock = onCall<{ profileId: string; conversationId: string; blocked: boolean }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { profileId, conversationId, blocked } = req.data ?? {};
    if (!isValidDocId(profileId) || !isValidDocId(conversationId) || typeof blocked !== "boolean") {
      throw new HttpsError("invalid-argument", "A profile, a conversation, and a blocked flag are required.");
    }
    // Admin, not member (spec 3.1): blocking closes the pair for every member
    // of both profiles, so it is a profile-level decision.
    await requireProfileAdmin(profileId, uid);
    const db = getFirestore();
    const ref = db.doc(`conversations/${conversationId}`);
    const blockedBy = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "Conversation not found.");
      const conv = snap.data() as ConversationDoc;
      if (!conv.participants.includes(profileId)) {
        throw new HttpsError("permission-denied", "That profile is not in this conversation.");
      }
      // A profile only ever adds or removes its OWN id, so one side cannot
      // lift the other side's block.
      const next = blocked
        ? [...new Set([...conv.blockedBy, profileId])]
        : conv.blockedBy.filter((id) => id !== profileId);
      tx.update(ref, { blockedBy: next, updatedAt: Date.now() });
      return next;
    });
    return { ok: true as const, blockedBy };
  });
```

Confirm `requireProfileAdmin`'s exact export and signature in `functions/src/profiles.ts` before wiring (`grep -n "export async function requireProfileAdmin" functions/src/profiles.ts`); it takes `(profileId, uid)`.

- [ ] **Step 6: Export**

In `functions/src/index.ts`, add after the `showPosts.js` export line:

```ts
export { sendMessage, markConversationRead, setConversationBlock } from "./messaging.js";
```

- [ ] **Step 7: Run the new file and its neighbour**

Run the Step 3 command again: PASS.
Then run `test/notifications.test.ts` with the same command shape (the `notifyProfileMembers` signature changed): PASS, unchanged.

- [ ] **Step 8: Commit**

```bash
git add functions/src/messaging.ts functions/src/notifications.ts functions/src/index.ts functions/test/messaging.test.ts functions/test/messagingFixtures.ts
git commit -m "feat(functions): musician to curator chat with unread counts, blocks, and a bucketed notification"
```

---

### Task 4: `postComment`, `hideComment`, `deleteComment`, `setGoing`, `setPostHeart`

**Files:**
- Create: `functions/src/comments.ts`
- Modify: `functions/src/index.ts`
- Test: `functions/test/comments.test.ts` (new)

**Interfaces:**
- Consumes: `requireAuthUid`, `requireVerifiedEmail` from `./guards.js`; `deriveLineupMusicianProfileIds` from `./eventArtistTags.js`; `notifyUser` from `./notifications.js`; `validateCommentText`, `isValidDocId`, `COMMENT_RATE_MAX`, `COMMENT_RATE_WINDOW_MS`, `COMMENTS_CLOSED_MESSAGE`, `MESSAGE_RATE_MESSAGE`, `commentReplyNotificationTitle`, `EventDoc`, `EventCommentDoc`, `CommentRole`, `UserDoc`, `ShowPostDoc` from shared (Task 1).
- Produces: `postComment({ eventId, text, parentId? }): { commentId: string; role: CommentRole }`, `hideComment({ eventId, commentId }): { ok: true }`, `deleteComment({ eventId, commentId }): { ok: true }`, `setGoing({ eventId, going }): { going: boolean; goingCount: number }`, `setPostHeart({ eventId, postId, hearted }): { hearted: boolean; heartCount: number }`, and the exported helper `deriveCommentRole(db, uid, event): Promise<{ role: CommentRole; profileId: string | null }>`, which Task 5's `hideComment` authority check reuses. All five callables exported from `functions/src/index.ts`.

- [ ] **Step 1: Write the failing test**

Create `functions/test/comments.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser } from "./helpers";
import {
  adb, makeApprovedMusicianProfile, makeDraftEvent, addTiersAndPublish, makePublishedBookingEvent,
} from "./discoverFixtures";
import { addMember } from "./payoutFixtures";
import type { EventCommentDoc, EventDoc, ShowPostDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 90_000 });

const FREE_TIER = [{ name: "GA", priceCents: 0, capacity: 20, saleStartsAt: null, saleEndsAt: null }];
const event = async (eventId: string) => (await adb.doc(`events/${eventId}`).get()).data() as EventDoc;
const comment = async (eventId: string, commentId: string) =>
  (await adb.doc(`events/${eventId}/comments/${commentId}`).get()).data() as EventCommentDoc | undefined;
const post = async (eventId: string, postId: string) =>
  (await adb.doc(`events/${eventId}/posts/${postId}`).get()).data() as ShowPostDoc;

type PostRes = { commentId: string; role: "fan" | "curator" | "artist" };
const say = (eventId: string, text: string, user: import("firebase/auth").User, parentId?: string) =>
  callFn<{ eventId: string; text: string; parentId?: string }, PostRes>(
    "postComment", { eventId, text, ...(parentId ? { parentId } : {}) }, user);

describe("postComment role derivation", () => {
  it("derives fan, curator, and artist, and refuses a closed event", async () => {
    // makePublishedBookingEvent gives a published event with a booking act,
    // so the musician side is a real lineup artist.
    const e = await makePublishedBookingEvent("cm1");
    const fan = await signUpTestUser(`cm1f-${Date.now()}@test.com`);

    const asFan = await say(e.eventId, "  can't wait  ", fan.user);
    expect(asFan.role).toBe("fan");
    const fanDoc = await comment(e.eventId, asFan.commentId);
    expect(fanDoc).toMatchObject({
      authorUid: fan.uid, authorRole: "fan", authorProfileId: null,
      parentId: null, text: "can't wait", hidden: false, hiddenBy: null, openReports: 0,
    });
    expect(fanDoc!.authorName.length).toBeGreaterThan(0);
    expect((await event(e.eventId)).commentCount).toBe(1);

    const asCurator = await say(e.eventId, "doors at 8", e.owner.user);
    expect(asCurator.role).toBe("curator");
    expect(await comment(e.eventId, asCurator.commentId))
      .toMatchObject({ authorRole: "curator", authorProfileId: e.profileId });

    const asArtist = await say(e.eventId, "bringing the new set", e.musician.owner.user);
    expect(asArtist.role).toBe("artist");
    expect(await comment(e.eventId, asArtist.commentId))
      .toMatchObject({ authorRole: "artist", authorProfileId: e.musicianProfileId });
    expect((await event(e.eventId)).commentCount).toBe(3);

    await adb.doc(`events/${e.eventId}`).update({ status: "cancelled" });
    await expect(say(e.eventId, "still on?", fan.user))
      .rejects.toMatchObject({ code: "functions/failed-precondition", message: "Comments are closed." });
  });

  it("treats an ACCEPTED tagged act as an artist and a pending one as a fan", async () => {
    const { owner, profileId, eventId } = await makeDraftEvent("cm2");
    const artist = await makeApprovedMusicianProfile("cm2a");
    await callFn("tagEventArtist",
      { curatorProfileId: profileId, eventId, musicianProfileId: artist.profileId }, owner.user);
    await addTiersAndPublish(profileId, eventId, owner.user, FREE_TIER);

    // Pending: not on lineupMusicianProfileIds yet, so this member is a fan.
    const whilePending = await say(eventId, "pending here", artist.owner.user);
    expect(whilePending.role).toBe("fan");

    await callFn("respondToArtistTag",
      { eventId, musicianProfileId: artist.profileId, accept: true }, artist.owner.user);
    const afterAccept = await say(eventId, "accepted here", artist.owner.user);
    expect(afterAccept.role).toBe("artist");
    expect(await comment(eventId, afterAccept.commentId))
      .toMatchObject({ authorRole: "artist", authorProfileId: artist.profileId });
  });
});

describe("replies, hiding, deleting", () => {
  it("notifies the fan on a curator reply, never on a fan reply, and refuses two levels", async () => {
    const e = await makePublishedBookingEvent("cm3");
    const fan = await signUpTestUser(`cm3f-${Date.now()}@test.com`);
    const other = await signUpTestUser(`cm3o-${Date.now()}@test.com`);
    const root = await say(e.eventId, "who opens?", fan.user);

    await say(e.eventId, "no idea", other.user, root.commentId);
    const afterFanReply = await adb.collection(`users/${fan.uid}/notifications`)
      .where("kind", "==", "comment_reply").get();
    expect(afterFanReply.size).toBe(0);

    const curatorReply = await say(e.eventId, "The Act opens", e.owner.user, root.commentId);
    const notes = await adb.collection(`users/${fan.uid}/notifications`)
      .where("kind", "==", "comment_reply").get();
    expect(notes.size).toBe(1);
    expect(notes.docs[0].data()).toMatchObject({ refId: e.eventId });
    expect(notes.docs[0].data().title).toContain("replied to your comment");
    expect(notes.docs[0].id).toBe(`comment_reply:${curatorReply.commentId}`);

    // A curator answering their OWN comment notifies nobody.
    const curatorRoot = await say(e.eventId, "reminder", e.owner.user);
    await say(e.eventId, "again", e.owner.user, curatorRoot.commentId);
    expect((await adb.collection(`users/${e.owner.uid}/notifications`)
      .where("kind", "==", "comment_reply").get()).size).toBe(0);

    await expect(say(e.eventId, "third level", fan.user, curatorReply.commentId))
      .rejects.toMatchObject({ code: "functions/failed-precondition" });
    await expect(say(e.eventId, "nowhere", fan.user, "nosuchcomment"))
      .rejects.toMatchObject({ code: "functions/not-found" });
  });

  it("lets curator and artist members hide, the author delete, and nobody else", async () => {
    const e = await makePublishedBookingEvent("cm4");
    const fan = await signUpTestUser(`cm4f-${Date.now()}@test.com`);
    const stranger = await signUpTestUser(`cm4s-${Date.now()}@test.com`);
    const a = await say(e.eventId, "hide me", fan.user);
    const b = await say(e.eventId, "delete me", fan.user);

    await expect(callFn("hideComment", { eventId: e.eventId, commentId: a.commentId }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    await expect(callFn("hideComment", { eventId: e.eventId, commentId: a.commentId }, fan.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });

    await callFn("hideComment", { eventId: e.eventId, commentId: a.commentId }, e.owner.user);
    expect(await comment(e.eventId, a.commentId)).toMatchObject({
      hidden: true, hiddenBy: { uid: e.owner.uid, role: "curator" },
    });
    // Idempotent, and the artist side can hide too.
    await callFn("hideComment", { eventId: e.eventId, commentId: a.commentId }, e.owner.user);
    const c = await say(e.eventId, "artist hides this", fan.user);
    await callFn("hideComment", { eventId: e.eventId, commentId: c.commentId }, e.musician.owner.user);
    expect((await comment(e.eventId, c.commentId))!.hiddenBy).toMatchObject({ role: "artist" });

    await expect(callFn("deleteComment", { eventId: e.eventId, commentId: b.commentId }, e.owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    const before = (await event(e.eventId)).commentCount ?? 0;
    await callFn("deleteComment", { eventId: e.eventId, commentId: b.commentId }, fan.user);
    expect(await comment(e.eventId, b.commentId)).toBeUndefined();
    expect((await event(e.eventId)).commentCount).toBe(before - 1);
    // Deleting again is a no-op, not a crash, and never drives the count negative.
    await callFn("deleteComment", { eventId: e.eventId, commentId: b.commentId }, fan.user);
    expect((await event(e.eventId)).commentCount).toBe(before - 1);
  });

  it("caps a user at COMMENT_RATE_MAX comments per window across events", async () => {
    const e1 = await makePublishedBookingEvent("cm5a");
    const e2 = await makePublishedBookingEvent("cm5b");
    const fan = await signUpTestUser(`cm5f-${Date.now()}@test.com`);
    for (let i = 0; i < 6; i += 1) await say(e1.eventId, `one ${i}`, fan.user);
    for (let i = 0; i < 4; i += 1) await say(e2.eventId, `two ${i}`, fan.user);
    await expect(say(e2.eventId, "eleventh", fan.user)).rejects.toMatchObject({
      code: "functions/resource-exhausted",
      message: "You are sending too fast. Try again in a few minutes.",
    });
    await adb.doc(`commentWindows/${fan.uid}`).set({ at: [Date.now() - 11 * 60 * 1000] });
    await expect(say(e2.eventId, "back", fan.user)).resolves.toMatchObject({ role: "fan" });
  });
});

describe("setGoing and setPostHeart", () => {
  it("toggles idempotently and keeps the counters right", async () => {
    const e = await makePublishedBookingEvent("cm6");
    const fan = await signUpTestUser(`cm6f-${Date.now()}@test.com`);
    const other = await signUpTestUser(`cm6o-${Date.now()}@test.com`);

    expect(await callFn("setGoing", { eventId: e.eventId, going: true }, fan.user))
      .toMatchObject({ going: true, goingCount: 1 });
    // Setting the same value again does not double-count.
    expect(await callFn("setGoing", { eventId: e.eventId, going: true }, fan.user))
      .toMatchObject({ going: true, goingCount: 1 });
    expect(await callFn("setGoing", { eventId: e.eventId, going: true }, other.user))
      .toMatchObject({ going: true, goingCount: 2 });
    expect(await callFn("setGoing", { eventId: e.eventId, going: false }, fan.user))
      .toMatchObject({ going: false, goingCount: 1 });
    // Un-going twice never drives the count below zero.
    expect(await callFn("setGoing", { eventId: e.eventId, going: false }, fan.user))
      .toMatchObject({ going: false, goingCount: 1 });
    expect((await event(e.eventId)).goingCount).toBe(1);

    const { postId } = await callFn<Record<string, unknown>, { postId: string }>(
      "createShowPost",
      { eventId: e.eventId, musicianProfileId: e.musicianProfileId, text: "see you Friday" },
      e.musician.owner.user);
    expect(await callFn("setPostHeart", { eventId: e.eventId, postId, hearted: true }, fan.user))
      .toMatchObject({ hearted: true, heartCount: 1 });
    expect(await callFn("setPostHeart", { eventId: e.eventId, postId, hearted: true }, fan.user))
      .toMatchObject({ hearted: true, heartCount: 1 });
    expect(await callFn("setPostHeart", { eventId: e.eventId, postId, hearted: false }, fan.user))
      .toMatchObject({ hearted: false, heartCount: 0 });
    expect((await post(e.eventId, postId)).heartCount).toBe(0);

    await expect(callFn("setGoing", { eventId: e.eventId, going: true }))
      .rejects.toMatchObject({ code: "functions/unauthenticated" });
    await expect(callFn("setPostHeart", { eventId: e.eventId, postId: "nope", hearted: true }, fan.user))
      .rejects.toMatchObject({ code: "functions/not-found" });
  });
});
```

`makePublishedBookingEvent` currently returns the published event plus its curator (`functions/test/discoverFixtures.ts:128`). Before writing the test, read that fixture and, if it does not already return `owner`, `uid`, `profileId`, `eventId`, `musicianProfileId`, and `musician`, widen its return object to include them (a fixtures file may grow; it must not call `expect`). Add a comment on the widened return saying SP12's comment tests need the musician side too.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter functions build && firebase emulators:exec --only auth,firestore,functions,storage "pnpm --filter functions exec vitest run --no-file-parallelism test/comments.test.ts"`
Expected: FAIL with "not-found" for the five callables.

- [ ] **Step 3: Implement `functions/src/comments.ts`**

```ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  validateCommentText, isValidDocId,
  COMMENT_RATE_MAX, COMMENT_RATE_WINDOW_MS, COMMENTS_CLOSED_MESSAGE, MESSAGE_RATE_MESSAGE,
  commentReplyNotificationTitle,
  type CommentRole, type EventCommentDoc, type EventDoc, type ShowPostDoc, type UserDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail } from "./guards.js";
import { notifyUser } from "./notifications.js";

// SP12 (spec sections 3.2 and 5). Fan comments and reactions on the PUBLIC
// event page. Everything here is per-event and per-user; nothing touches
// money, tickets, or the event's own lifecycle.

// An event is open for comments while it is published or completed. Cancel
// and takedown both land on "cancelled" (cancelEventCore), which closes the
// composer; the comments themselves are never deleted by the event cascade
// (spec section 5), so the thread stays readable.
function requireOpenEvent(event: EventDoc): void {
  if (event.status !== "published" && event.status !== "completed") {
    throw new HttpsError("failed-precondition", COMMENTS_CLOSED_MESSAGE);
  }
}

// Curator member > artist member > fan. "Artist" means a member of a profile
// on lineupMusicianProfileIds, which is the projection isLinkableAct already
// maintains (booking acts plus ACCEPTED tagged acts, sp11 ruling 12): a
// pending tag is not yet on the bill, so its members comment as fans.
export async function deriveCommentRole(
  db: Firestore, uid: string, event: EventDoc,
): Promise<{ role: CommentRole; profileId: string | null }> {
  const curatorMember = await db.doc(`profiles/${event.curatorProfileId}/members/${uid}`).get();
  if (curatorMember.exists) return { role: "curator", profileId: event.curatorProfileId };
  const ids = event.lineupMusicianProfileIds ?? [];
  const snaps = await Promise.all(ids.map((id) => db.doc(`profiles/${id}/members/${uid}`).get()));
  const hit = snaps.findIndex((s) => s.exists);
  if (hit >= 0) return { role: "artist", profileId: ids[hit] };
  return { role: "fan", profileId: null };
}

// Rolling 10-minute window in commentWindows/{uid}. A per-user counter doc,
// not a field on the event: the cap is per USER and spans every event, so
// there is no single doc the write already touches that could hold it. Same
// posture and rules stance as geocodeBudgets and searchBudgets.
async function consumeCommentBudget(db: Firestore, uid: string, now: number): Promise<void> {
  const ref = db.doc(`commentWindows/${uid}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prior = (snap.data()?.at as number[] | undefined) ?? [];
    const recent = prior.filter((t) => now - t < COMMENT_RATE_WINDOW_MS);
    if (recent.length >= COMMENT_RATE_MAX) throw new HttpsError("resource-exhausted", MESSAGE_RATE_MESSAGE);
    recent.push(now);
    tx.set(ref, { at: recent.slice(-COMMENT_RATE_MAX) });
  });
}

export const postComment = onCall<{ eventId: string; text: string; parentId?: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { eventId, parentId } = req.data ?? {};
    if (!isValidDocId(eventId)) throw new HttpsError("invalid-argument", "An event is required.");
    if (parentId !== undefined && !isValidDocId(parentId)) {
      throw new HttpsError("invalid-argument", "A parent comment id is required.");
    }
    const check = validateCommentText(req.data?.text);
    if (!check.ok) throw new HttpsError("invalid-argument", check.reason);
    const text = (req.data.text as string).trim();

    const db = getFirestore();
    const eventRef = db.doc(`events/${eventId}`);
    const eventSnap = await eventRef.get();
    if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const event = eventSnap.data() as EventDoc;
    requireOpenEvent(event);

    // One level only (spec 3.2): a reply's parent must itself be top-level.
    let parent: EventCommentDoc | null = null;
    if (parentId) {
      const parentSnap = await eventRef.collection("comments").doc(parentId).get();
      if (!parentSnap.exists) throw new HttpsError("not-found", "That comment is gone.");
      parent = parentSnap.data() as EventCommentDoc;
      if (parent.parentId !== null) {
        throw new HttpsError("failed-precondition", "Replies go on the top comment, not on another reply.");
      }
    }

    const { role, profileId } = await deriveCommentRole(db, uid, event);
    const now = Date.now();
    await consumeCommentBudget(db, uid, now);

    const user = (await db.doc(`users/${uid}`).get()).data() as UserDoc | undefined;
    const commentRef = eventRef.collection("comments").doc();
    const comment: EventCommentDoc = {
      authorUid: uid,
      // Snapshotted, like ticket and attendee names: an old comment keeps the
      // name it was posted under.
      authorName: user?.displayName?.trim() || "A GateKeep fan",
      authorRole: role, authorProfileId: profileId,
      parentId: parentId ?? null, text,
      hidden: false, hiddenBy: null, openReports: 0, at: now,
    };
    const batch = db.batch();
    batch.set(commentRef, comment);
    batch.update(eventRef, { commentCount: FieldValue.increment(1) });
    await batch.commit();

    // Post-commit, best-effort (sp7 ruling 3). Only a curator or artist reply
    // to somebody ELSE's comment notifies; fan-to-fan replies never do
    // (spec 3.2), and reactions never do at all.
    if (parent && role !== "fan" && parent.authorUid !== uid) {
      try {
        await notifyUser(parent.authorUid, {
          kind: "comment_reply", refId: eventId, refKind: "event",
          title: commentReplyNotificationTitle(comment.authorName),
          body: text.length > 120 ? `${text.slice(0, 117)}...` : text,
        }, `comment_reply:${commentRef.id}`);
      } catch (e) {
        console.error("postComment: reply fan-out failed", commentRef.id, e);
      }
    }
    return { commentId: commentRef.id, role };
  });

export const hideComment = onCall<{ eventId: string; commentId: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { eventId, commentId } = req.data ?? {};
    if (!isValidDocId(eventId) || !isValidDocId(commentId)) {
      throw new HttpsError("invalid-argument", "An event and a comment are required.");
    }
    const db = getFirestore();
    const eventSnap = await db.doc(`events/${eventId}`).get();
    if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const event = eventSnap.data() as EventDoc;

    // Admins moderate anything (the Reports panel's "Hide comment" runs this
    // same callable); otherwise the caller must be a curator or artist member
    // of THIS event. Hiding is allowed on a closed event: moderation must
    // outlive the show.
    const isAdmin = req.auth?.token?.admin === true;
    const { role } = isAdmin
      ? { role: "admin" as const }
      : await deriveCommentRole(db, uid, event);
    if (role === "fan") throw new HttpsError("permission-denied", "Only the organizer or the artists can hide a comment.");

    const ref = db.doc(`events/${eventId}/comments/${commentId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "That comment is gone.");
    if ((snap.data() as EventCommentDoc).hidden) return { ok: true as const }; // idempotent
    await ref.update({ hidden: true, hiddenBy: { uid, role } });
    return { ok: true as const };
  });

export const deleteComment = onCall<{ eventId: string; commentId: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { eventId, commentId } = req.data ?? {};
    if (!isValidDocId(eventId) || !isValidDocId(commentId)) {
      throw new HttpsError("invalid-argument", "An event and a comment are required.");
    }
    const db = getFirestore();
    const ref = db.doc(`events/${eventId}/comments/${commentId}`);
    const eventRef = db.doc(`events/${eventId}`);
    // Author only (spec 3.2): a curator or artist who wants it gone hides it,
    // which leaves the moderation trail hideComment writes. Replies to a
    // deleted comment stay and render COMMENT_DELETED_LINE as their quoted
    // parent, so nothing cascades here.
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return; // idempotent: a second delete is a no-op
      const comment = snap.data() as EventCommentDoc;
      if (comment.authorUid !== uid) {
        throw new HttpsError("permission-denied", "Only the author can delete a comment.");
      }
      tx.delete(ref);
      tx.update(eventRef, { commentCount: FieldValue.increment(-1) });
    });
    return { ok: true as const };
  });

export const setGoing = onCall<{ eventId: string; going: boolean }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { eventId, going } = req.data ?? {};
    if (!isValidDocId(eventId) || typeof going !== "boolean") {
      throw new HttpsError("invalid-argument", "An event and a going flag are required.");
    }
    const db = getFirestore();
    const eventRef = db.doc(`events/${eventId}`);
    const reactionRef = eventRef.collection("reactions").doc(uid);
    // One transaction reads the current per-user doc and adjusts the counter
    // only on a real transition, so a double tap (or a retried call) is
    // idempotent and the count can never drift or go negative.
    const goingCount = await db.runTransaction(async (tx) => {
      const [eventSnap, reactionSnap] = await Promise.all([tx.get(eventRef), tx.get(reactionRef)]);
      if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
      const event = eventSnap.data() as EventDoc;
      requireOpenEvent(event);
      const was = (reactionSnap.data() as { going?: boolean } | undefined)?.going === true;
      const current = event.goingCount ?? 0;
      if (was === going) return current;
      const next = Math.max(0, current + (going ? 1 : -1));
      tx.set(reactionRef, { going, at: Date.now() });
      tx.update(eventRef, { goingCount: next });
      return next;
    });
    return { going, goingCount };
  });

export const setPostHeart = onCall<{ eventId: string; postId: string; hearted: boolean }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    const { eventId, postId, hearted } = req.data ?? {};
    if (!isValidDocId(eventId) || !isValidDocId(postId) || typeof hearted !== "boolean") {
      throw new HttpsError("invalid-argument", "An event, a post, and a hearted flag are required.");
    }
    const db = getFirestore();
    const postRef = db.doc(`events/${eventId}/posts/${postId}`);
    const heartRef = postRef.collection("hearts").doc(uid);
    // Presence of the heart doc IS the heart, so the transition test is
    // exists() rather than a stored boolean; same idempotence as setGoing.
    const heartCount = await db.runTransaction(async (tx) => {
      const [postSnap, heartSnap] = await Promise.all([tx.get(postRef), tx.get(heartRef)]);
      if (!postSnap.exists) throw new HttpsError("not-found", "Post not found.");
      const post = postSnap.data() as ShowPostDoc;
      const current = post.heartCount ?? 0;
      if (heartSnap.exists === hearted) return current;
      const next = Math.max(0, current + (hearted ? 1 : -1));
      if (hearted) tx.set(heartRef, { at: Date.now() }); else tx.delete(heartRef);
      tx.update(postRef, { heartCount: next });
      return next;
    });
    return { hearted, heartCount };
  });
```

- [ ] **Step 4: Export**

In `functions/src/index.ts`, add after the messaging export line:

```ts
export { postComment, hideComment, deleteComment, setGoing, setPostHeart } from "./comments.js";
```

- [ ] **Step 5: Run the new file and its neighbours**

Run the Step 2 command again: PASS.
Then run `test/showPosts.test.ts` and `test/eventCascade.test.ts` one at a time with the same command shape (both read event and post docs this task now adds counters to): PASS, unchanged.

- [ ] **Step 6: Commit**

```bash
git add functions/src/comments.ts functions/src/index.ts functions/test/comments.test.ts functions/test/discoverFixtures.ts
git commit -m "feat(functions): fan comments with server-derived roles, hide and delete, going and post hearts"
```

---

### Task 5: `reportConversation`, `reportComment`, `resolveReport`

**Files:**
- Create: `functions/src/reports.ts`
- Modify: `functions/src/index.ts`
- Test: `functions/test/reports.test.ts` (new)

**Interfaces:**
- Consumes: `requireAuthUid`, `requireVerifiedEmail`, `requireProfileMember` from `./guards.js`; `validateReportReason`, `isValidDocId`, `REPORT_SENT_MESSAGE`, `ConversationDoc`, `EventCommentDoc`, `ReportDoc` from shared (Task 1); `makeMessagingPair`, `sendAs` from `functions/test/messagingFixtures.ts` (Task 3) in the test only.
- Produces: `reportConversation({ profileId, conversationId, reason }): { reportId: string }`, `reportComment({ eventId, commentId, reason }): { reportId: string }`, `resolveReport({ reportId }): { ok: true }`, exported from `functions/src/index.ts`. The deterministic report id (`conv:{conversationId}:{reporterUid}` and `comment:{eventId}:{commentId}:{reporterUid}`) is what Task 9's admin panel and the "one open report per reporter per target" rule both turn on.

- [ ] **Step 1: Write the failing test**

Create `functions/test/reports.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { callFn, signUpTestUser, makeAdminUser } from "./helpers";
import { adb, makePublishedBookingEvent } from "./discoverFixtures";
import { makeMessagingPair, sendAs, conversation } from "./messagingFixtures";
import type { ReportDoc } from "@gatekeep/shared";
vi.setConfig({ testTimeout: 90_000 });

const report = async (reportId: string) =>
  (await adb.doc(`reports/${reportId}`).get()).data() as ReportDoc | undefined;

describe("reportConversation", () => {
  it("opens one report per reporter, bumps openReports, and resolving clears it", async () => {
    const p = await makeMessagingPair("rc1");
    await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "hello");

    const res = await callFn<Record<string, unknown>, { reportId: string }>("reportConversation",
      { profileId: p.curatorProfileId, conversationId: p.pairId, reason: "  abusive  " },
      p.curator.owner.user);
    expect(res.reportId).toBe(`conv:${p.pairId}:${p.curator.owner.uid}`);
    expect(await report(res.reportId)).toMatchObject({
      kind: "conversation", targetPath: p.pairId, reporterUid: p.curator.owner.uid,
      reporterProfileId: p.curatorProfileId, reason: "abusive", status: "open",
      resolvedBy: null, resolvedAt: null,
    });
    expect((await conversation(p.pairId))!.openReports).toBe(1);

    // Same reporter, same target: replaces the reason, never a second open row.
    await callFn("reportConversation",
      { profileId: p.curatorProfileId, conversationId: p.pairId, reason: "still abusive" },
      p.curator.owner.user);
    expect((await report(res.reportId))!.reason).toBe("still abusive");
    expect((await conversation(p.pairId))!.openReports).toBe(1);

    // The other side reporting the same conversation is a second row.
    const second = await callFn<Record<string, unknown>, { reportId: string }>("reportConversation",
      { profileId: p.musicianProfileId, conversationId: p.pairId, reason: "them too" },
      p.musician.owner.user);
    expect((await conversation(p.pairId))!.openReports).toBe(2);

    const admin = await makeAdminUser("rc1a");
    await expect(callFn("resolveReport", { reportId: res.reportId }, p.curator.owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    await callFn("resolveReport", { reportId: res.reportId }, admin.user);
    expect(await report(res.reportId)).toMatchObject({ status: "resolved", resolvedBy: admin.uid });
    expect((await report(res.reportId))!.resolvedAt).toBeTypeOf("number");
    expect((await conversation(p.pairId))!.openReports).toBe(1);
    // Resolving twice never drives openReports below zero.
    await callFn("resolveReport", { reportId: res.reportId }, admin.user);
    expect((await conversation(p.pairId))!.openReports).toBe(1);
    await callFn("resolveReport", { reportId: second.reportId }, admin.user);
    expect((await conversation(p.pairId))!.openReports).toBe(0);
  });

  it("refuses a non-participant, a stranger, and a bad reason", async () => {
    const p = await makeMessagingPair("rc2");
    await sendAs(p.musician.owner.user, p.musicianProfileId, p.curatorProfileId, "hello");
    const stranger = await signUpTestUser(`rc2s-${Date.now()}@test.com`);
    await expect(callFn("reportConversation",
      { profileId: p.curatorProfileId, conversationId: p.pairId, reason: "nope" }, stranger.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    const other = await makeMessagingPair("rc2b");
    await expect(callFn("reportConversation",
      { profileId: other.curatorProfileId, conversationId: p.pairId, reason: "nope" },
      other.curator.owner.user))
      .rejects.toMatchObject({ code: "functions/permission-denied" });
    for (const reason of ["", "   ", "x".repeat(301), 5, null]) {
      await expect(callFn("reportConversation",
        { profileId: p.curatorProfileId, conversationId: p.pairId, reason }, p.curator.owner.user))
        .rejects.toMatchObject({ code: "functions/invalid-argument" });
    }
  });
});

describe("reportComment", () => {
  it("lets any signed-in user report once, bumps the comment's openReports, and resolves", async () => {
    const e = await makePublishedBookingEvent("rp1");
    const fan = await signUpTestUser(`rp1f-${Date.now()}@test.com`);
    const reporter = await signUpTestUser(`rp1r-${Date.now()}@test.com`);
    const { commentId } = await callFn<Record<string, unknown>, { commentId: string }>(
      "postComment", { eventId: e.eventId, text: "rude thing" }, fan.user);

    const res = await callFn<Record<string, unknown>, { reportId: string }>("reportComment",
      { eventId: e.eventId, commentId, reason: "harassment" }, reporter.user);
    expect(res.reportId).toBe(`comment:${e.eventId}:${commentId}:${reporter.uid}`);
    expect(await report(res.reportId)).toMatchObject({
      kind: "comment", targetPath: `events/${e.eventId}/comments/${commentId}`,
      reporterUid: reporter.uid, reporterProfileId: null, status: "open",
    });
    const commentDoc = async () =>
      (await adb.doc(`events/${e.eventId}/comments/${commentId}`).get()).data() as { openReports: number };
    expect((await commentDoc()).openReports).toBe(1);

    await callFn("reportComment", { eventId: e.eventId, commentId, reason: "harassment again" }, reporter.user);
    expect((await commentDoc()).openReports).toBe(1);

    const admin = await makeAdminUser("rp1a");
    await callFn("resolveReport", { reportId: res.reportId }, admin.user);
    expect((await commentDoc()).openReports).toBe(0);
    // A report whose comment the author has since deleted still resolves.
    const { commentId: gone } = await callFn<Record<string, unknown>, { commentId: string }>(
      "postComment", { eventId: e.eventId, text: "delete me" }, fan.user);
    const goneReport = await callFn<Record<string, unknown>, { reportId: string }>("reportComment",
      { eventId: e.eventId, commentId: gone, reason: "spam" }, reporter.user);
    await callFn("deleteComment", { eventId: e.eventId, commentId: gone }, fan.user);
    await callFn("resolveReport", { reportId: goneReport.reportId }, admin.user);
    expect(await report(goneReport.reportId)).toMatchObject({ status: "resolved" });

    await expect(callFn("reportComment",
      { eventId: e.eventId, commentId: "nosuch", reason: "spam" }, reporter.user))
      .rejects.toMatchObject({ code: "functions/not-found" });
    await expect(callFn("reportComment", { eventId: e.eventId, commentId, reason: "spam" }))
      .rejects.toMatchObject({ code: "functions/unauthenticated" });
    await expect(callFn("resolveReport", { reportId: "nosuchreport" }, admin.user))
      .rejects.toMatchObject({ code: "functions/not-found" });
  });
});
```

Confirm `makeAdminUser`'s return shape (`functions/test/helpers.ts:54`) supplies `{ user, uid }` before use.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter functions build && firebase emulators:exec --only auth,firestore,functions,storage "pnpm --filter functions exec vitest run --no-file-parallelism test/reports.test.ts"`
Expected: FAIL with "not-found" for the three callables.

- [ ] **Step 3: Implement `functions/src/reports.ts`**

```ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  validateReportReason, isValidDocId,
  type ConversationDoc, type ReportDoc,
} from "@gatekeep/shared";
import { requireAuthUid, requireVerifiedEmail, requireProfileMember } from "./guards.js";

// SP12 (spec sections 3.3 and 5). Abuse reports for both surfaces land in one
// admin-read collection. The report id is DETERMINISTIC per reporter per
// target, which is how "one open report per reporter per target" is enforced
// without a query: a repeat report overwrites the reason on the same doc, and
// the target's openReports counter only moves when the doc is newly created
// or newly resolved.

function requireAdminReq(req: { auth?: { uid?: string; token?: Record<string, unknown> } }): string {
  const uid = requireAuthUid(req);
  if (req.auth?.token?.admin !== true) throw new HttpsError("permission-denied", "Admins only.");
  return uid;
}

// Shared by both report callables: create-or-refresh the report doc and bump
// the target's openReports exactly once, in one transaction so a double
// submit cannot double-count.
async function openReport(
  reportId: string, targetPath: string, doc: Omit<ReportDoc, "status" | "resolvedBy" | "resolvedAt" | "createdAt">,
): Promise<void> {
  const db = getFirestore();
  const reportRef = db.doc(`reports/${reportId}`);
  const targetRef = db.doc(targetPath);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const [existing, target] = await Promise.all([tx.get(reportRef), tx.get(targetRef)]);
    if (!target.exists) throw new HttpsError("not-found", "That is already gone.");
    const prior = existing.exists ? (existing.data() as ReportDoc) : null;
    tx.set(reportRef, {
      ...doc,
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      createdAt: prior?.createdAt ?? now,
    } satisfies ReportDoc);
    // Only a report that was NOT already open adds to the counter: a repeat
    // submit refreshes the reason, and a re-report after a resolve reopens.
    if (prior?.status !== "open") tx.update(targetRef, { openReports: FieldValue.increment(1) });
  });
}

export const reportConversation = onCall<{ profileId: string; conversationId: string; reason: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { profileId, conversationId } = req.data ?? {};
    if (!isValidDocId(profileId) || !isValidDocId(conversationId)) {
      throw new HttpsError("invalid-argument", "A profile and a conversation are required.");
    }
    const check = validateReportReason(req.data?.reason);
    if (!check.ok) throw new HttpsError("invalid-argument", check.reason);
    const reason = (req.data.reason as string).trim();

    await requireProfileMember(profileId, uid);
    const snap = await getFirestore().doc(`conversations/${conversationId}`).get();
    if (!snap.exists) throw new HttpsError("not-found", "Conversation not found.");
    if (!(snap.data() as ConversationDoc).participants.includes(profileId)) {
      throw new HttpsError("permission-denied", "That profile is not in this conversation.");
    }

    const reportId = `conv:${conversationId}:${uid}`;
    await openReport(reportId, `conversations/${conversationId}`, {
      kind: "conversation", targetPath: conversationId,
      reporterUid: uid, reporterProfileId: profileId, reason,
    });
    return { reportId };
  });

export const reportComment = onCall<{ eventId: string; commentId: string; reason: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuthUid(req);
    requireVerifiedEmail(req);
    const { eventId, commentId } = req.data ?? {};
    if (!isValidDocId(eventId) || !isValidDocId(commentId)) {
      throw new HttpsError("invalid-argument", "An event and a comment are required.");
    }
    const check = validateReportReason(req.data?.reason);
    if (!check.ok) throw new HttpsError("invalid-argument", check.reason);
    const reason = (req.data.reason as string).trim();

    // Any signed-in user may report a comment (spec 3.2): a fan reading the
    // public page is exactly who notices abuse, and there is no profile to
    // prove membership of. openReport's own target read is the existence check.
    const targetPath = `events/${eventId}/comments/${commentId}`;
    const reportId = `comment:${eventId}:${commentId}:${uid}`;
    await openReport(reportId, targetPath, {
      kind: "comment", targetPath, reporterUid: uid, reporterProfileId: null, reason,
    });
    return { reportId };
  });

export const resolveReport = onCall<{ reportId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAdminReq(req);
  const { reportId } = req.data ?? {};
  if (typeof reportId !== "string" || reportId.length === 0 || reportId.length > 1500) {
    throw new HttpsError("invalid-argument", "A report id is required.");
  }
  const db = getFirestore();
  const reportRef = db.doc(`reports/${reportId}`);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(reportRef);
    if (!snap.exists) throw new HttpsError("not-found", "Report not found.");
    const report = snap.data() as ReportDoc;
    if (report.status === "resolved") return; // idempotent
    const targetRef = db.doc(
      report.kind === "conversation" ? `conversations/${report.targetPath}` : report.targetPath);
    const target = await tx.get(targetRef);
    tx.update(reportRef, { status: "resolved", resolvedBy: uid, resolvedAt: now });
    // The target can be gone (an author deleted the comment). Resolving still
    // has to work: the row must leave the panel either way.
    if (target.exists) {
      const current = (target.data() as { openReports?: number }).openReports ?? 0;
      tx.update(targetRef, { openReports: Math.max(0, current - 1) });
    }
  });
  return { ok: true as const };
});
```

Note: the report id is not a `isValidDocId` shape (it carries colons), so `resolveReport` length-checks it instead; Firestore doc ids allow colons and the ids are server-minted, never client-composed.

- [ ] **Step 4: Export**

In `functions/src/index.ts`, add after the comments export line:

```ts
export { reportConversation, reportComment, resolveReport } from "./reports.js";
```

- [ ] **Step 5: Run and commit**

Run the Step 2 command again: PASS. Then re-run `test/messaging.test.ts` and `test/comments.test.ts` one at a time: PASS, unchanged.

```bash
git add functions/src/reports.ts functions/src/index.ts functions/test/reports.test.ts
git commit -m "feat(functions): conversation and comment reports with a deterministic id and admin resolve"
```

---

## Client tasks

UI tasks are contracts plus load-bearing snippets. Reuse each platform's existing primitives and page shapes; every list carries a loading, an empty, and an error state in the house style; copy is exactly the spec's section 6 strings. No browser or device tests (owner-owed); gates are typecheck, lint, and build or export.

### Task 6: Web Messages page: conversation list, thread, composer

**Files:**
- Create: `apps/web/src/messaging/useConversations.ts`, `apps/web/src/messaging/ConversationList.tsx`, `apps/web/src/messaging/ConversationThread.tsx`, `apps/web/app/dashboard/messages/page.tsx`
- Modify: `apps/web/src/shell/AppShell.tsx`

**Interfaces:**
- Consumes: `sendMessage`, `markConversationRead`, `setConversationBlock`, `reportConversation` through `callFn` (`src/lib/callable.ts`); `useMyProfiles`/`useMyProfilesState` (`src/shell/useMyProfiles.ts`); `ConversationDoc`, `MessageDoc`, `MESSAGE_MAX_CHARS`, and the chat copy constants from `@gatekeep/shared`.
- Produces: `useConversations(profileId: string | null): { rows: ConversationRow[] | "loading" | "error"; retry: () => void }` where `ConversationRow = { id: string } & ConversationDoc`; `useUnreadTotal(profileIds: string[]): number` (exported from the same file, used by Task 11's mobile twin only for its contract, and by the web nav badge here); `ConversationList({ profileId, selectedId, onSelect })`; `ConversationThread({ profileId, conversationId, otherProfile })`. Task 7 mounts `MessageButton` which deep-links into this page with `?c={id}`.

- [ ] **Step 1: The subscription hook**

`apps/web/src/messaging/useConversations.ts` subscribes to
`query(collection(db, "conversations"), where("participants", "array-contains", profileId), orderBy("lastMessageAt", "desc"), limit(50))`
with **an error callback** (`() => setRows("error")`, the audit item #10 shape this sub-project is also fixing everywhere else) and a `retry` that bumps a `reloadKey` in the dependency array, mirroring `apps/web/src/payments/EarningsPanel.tsx`'s own Retry. It returns `"loading"` before the first snapshot, `"error"` on failure, and the rows otherwise. Export `unreadFor(row, profileId)` as `row.unread?.[profileId] ?? 0` so the list and the nav badge cannot drift. A second exported hook `useOtherProfiles(rows, profileId)` resolves each row's other participant to `{ name, type, handle }` with one `getDoc` per distinct id into a `Map`, cached in a ref exactly like `TicketsClient.tsx`'s event cache, and returns `null` for a profile it cannot read.

- [ ] **Step 2: The list**

`ConversationList({ profileId, selectedId, onSelect })` renders each row as a `<button type="button">` (not a link: the page owns selection through the query string, and the button lets a keyboard user move without a navigation) inside a `<ul>`, with:
- the other profile's name in Syne semibold and its type ("Musician" / "Curator") as a muted line, both from `useOtherProfiles`;
- `row.lastMessage?.text` truncated to one line, muted;
- `new Date(row.lastMessageAt).toLocaleString()` in `text-xs text-gk-muted`;
- an unread count as `<Badge>{n}</Badge>` when `unreadFor(row, profileId) > 0`, with a visually hidden `{n} unread` span beside it so the count is not conveyed by the badge alone (this is the same rule Task 19 applies to the notification dot);
- selected state as `bg-gk-border/25` plus `aria-current="true"`, never an ember border (DESIGN.md: ember never on borders).
States: `Skeleton` rows while `"loading"`; on `"error"` an `ErrorBox` plus a `Button variant="secondary"` Retry calling `retry()`; when empty, a muted line "No conversations yet. Message a venue or an artist from their page."

- [ ] **Step 3: The thread**

`ConversationThread({ profileId, conversationId, otherProfile, isAdminOfProfile })` subscribes to
`query(collection(db, \`conversations/${conversationId}/messages\`), orderBy("at", "asc"), limit(200))` with an error callback, and to the conversation doc itself (for `blockedBy`). On mount and whenever `conversationId` changes it fires `callFn("markConversationRead", { profileId, conversationId })` once, ignoring failures (a read receipt is not worth an error banner).

Bubbles reuse `BookingThread.tsx`'s exact shape (`apps/web/src/bookings/BookingThread.tsx:230-245`): `flex` with `justify-end` for own side, `grid max-w-[85%] gap-2 rounded-gk border p-3.5 sm:max-w-[70%]`, `border-gk-accent/50 bg-gk-accent/14` for own side and `border-gk-border bg-gk-surface` for the other. Under each bubble, the sender's profile name and, resolved from `users/{senderUid}`? No: a `users/{uid}` read is owner-only, so render the sender's PROFILE name plus the member's display name only when the viewer already has it (the viewer's own sends show their own `displayName` from `useAuth()`); for the other side show the profile name alone. Record that narrowing in a comment: the spec asks for the member's display name, and rules make it unavailable for another account, so the profile name is what ships.

Header: the other profile's name linked to `/u/{handle}` when a handle resolved, plus a `DropdownMenu` (`src/ui/dropdown-menu.tsx`) holding "Block" (only when `isAdminOfProfile`), "Report", and "View profile". "Block" and "Unblock" call `setConversationBlock`; "Report" opens a `Dialog` (`src/ui/dialog.tsx`) whose label is `REPORT_REASON_PROMPT`, with a `Textarea` capped at 300 characters, a Cancel and a submit calling `reportConversation`, and `REPORT_SENT_MESSAGE` shown in a `role="status"` line on success.

Block states: when `blockedBy.includes(profileId)`, replace the composer with `CONVERSATION_BLOCKED_MESSAGE` plus an `UNBLOCK_LABEL` button for admins. When `blockedBy` is non-empty but does not include `profileId`, render the composer unchanged (the spec is explicit: the blocked side sees nothing different) and surface the server's `CONVERSATION_CLOSED_MESSAGE` in an `ErrorBox` on the failed send.

Composer: a real `<form onSubmit>` with a `Textarea` (`aria-label={MESSAGE_COMPOSER_PLACEHOLDER}`, `placeholder={MESSAGE_COMPOSER_PLACEHOLDER}`, `maxLength={MESSAGE_MAX_CHARS}`), a `{text.length} / {MESSAGE_MAX_CHARS}` counter, and a `type="submit"` `Button` labelled `MESSAGE_SEND_LABEL`, disabled while sending or empty. Enter submits because it is a real form (this is audit item #21's rule applied to a new surface from the start). The empty state above the composer is `CONVERSATION_EMPTY_MESSAGE`.

- [ ] **Step 4: The page**

`apps/web/app/dashboard/messages/page.tsx` is a client page. It reads the acting profile from `useMyProfilesState(user?.uid ?? null)`: a user with exactly one approved profile uses it with no switcher; a user with several renders a `Select` (`src/ui/select.tsx`) labelled "Messaging as" above the list, defaulting to the first approved profile and stored in component state only. A user with no approved profile sees a muted card: "Messages are for musician and curator profiles. Set one up from your dashboard." Layout is `grid gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]`: list left, thread right; below `md` the thread replaces the list once a conversation is selected, with a "Back to conversations" `Button variant="ghost"` above it. Selection comes from `useSearchParams().get("c")` and is written back with `router.replace(\`/dashboard/messages?c=${id}\`, { scroll: false })`, which is what makes `notificationHref("message", ...)` land on the right thread. Wrap the `useSearchParams` consumer in a `<Suspense>` boundary, the same shape `app/sign-in/page.tsx` already uses for its `next` param.

- [ ] **Step 5: Nav**

In `apps/web/src/shell/AppShell.tsx`, add `const messages: NavItem = { label: "Messages", href: "/dashboard/messages", icon: IconChatCircle };` and place it after `search` in the `musician` and `curator` context arrays only (a profile-less account has nothing to message as, so the generic context does not get it, matching how Events is curator-only). Add `IconChatCircle` to `apps/web/src/ui/icons.tsx` if it is not already exported there. Replace the header comment's sentence "\"Messages\" isn't included anywhere: there's no messaging surface on web (or mobile, where its own Messages tab is still a \"coming in a later phase\" placeholder), so no context has a real destination for it." with a sentence saying SP12 added `/dashboard/messages` and it appears in the two profile contexts.

- [ ] **Step 6: Verify and commit**

Run `pnpm --filter @gatekeep/web exec next typegen`, then `pnpm --filter @gatekeep/web typecheck`, `lint` (0 errors, no new warnings), `build` (the new route appears in the route table).

```bash
git add apps/web/src/messaging apps/web/app/dashboard/messages apps/web/src/shell/AppShell.tsx apps/web/src/ui/icons.tsx
git commit -m "feat(web): the Messages page, conversation list, thread, and composer"
```

---

### Task 7: Web message entry points and notification routing

**Files:**
- Create: `apps/web/src/messaging/MessageButton.tsx`
- Modify: `apps/web/app/u/[handle]/CuratorProfile.tsx`, `apps/web/app/u/[handle]/MusicianProfile.tsx`, `apps/web/src/search/CuratorArtistRow.tsx`, `apps/web/src/bookings/BookingThread.tsx`

**Interfaces:**
- Consumes: `useMyProfiles` (`src/shell/useMyProfiles.ts`), `useAuth`, `MESSAGE_ACTION_LABEL`, the `Sheet` primitive (`src/ui/sheet.tsx`), `conversationPairId` from `@gatekeep/shared`.
- Produces: `MessageButton({ targetProfileId, targetProfileType, targetName, actingProfileId? , className? })`. When `actingProfileId` is given (the booking thread and the curator search row already know which profile is speaking) the button navigates straight to `/dashboard/messages?c={pairId}`; otherwise it resolves the viewer's eligible profiles and, with more than one, opens a picker sheet.

- [ ] **Step 1: The button**

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { conversationPairId, MESSAGE_ACTION_LABEL, type ProfileType } from "@gatekeep/shared";
import { useAuth } from "../auth/AuthProvider";
import { useMyProfiles } from "../shell/useMyProfiles";
import { Button } from "../ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet";

// SP12 (spec 3.1). The one "Message" affordance on web. It is HIDDEN, never
// disabled, when the viewer has no eligible profile of the opposite type:
// the same R-26 posture OfferGigButton already takes. Where OfferGigButton
// also hides for a viewer with two or more matching profiles, this one asks:
// the spec is explicit that "a viewer with several picks one in a sheet".
//
// The conversation id is computed client-side (conversationPairId) purely to
// pre-select the thread; the conversation itself is created server-side on
// the first send, so linking to a pair that has never been messaged is safe
// and simply shows the empty state.
export function MessageButton({ targetProfileId, targetProfileType, targetName, actingProfileId, className }: {
  targetProfileId: string; targetProfileType: ProfileType; targetName: string;
  actingProfileId?: string; className?: string;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const profiles = useMyProfiles(user?.uid ?? null);
  const [picking, setPicking] = useState(false);

  const wantedType: ProfileType = targetProfileType === "musician" ? "curator" : "musician";
  const eligible = actingProfileId
    ? profiles.filter((p) => p.profileId === actingProfileId)
    : profiles.filter((p) => p.type === wantedType && p.status === "approved");
  if (eligible.length === 0) return null;

  const open = (actingId: string) => {
    const pairId = targetProfileType === "musician"
      ? conversationPairId(targetProfileId, actingId)
      : conversationPairId(actingId, targetProfileId);
    router.push(`/dashboard/messages?c=${pairId}`);
  };

  return (
    <>
      <Button
        type="button" variant="secondary" className={className}
        onClick={() => (eligible.length === 1 ? open(eligible[0].profileId) : setPicking(true))}
      >
        {MESSAGE_ACTION_LABEL}
      </Button>
      <Sheet open={picking} onOpenChange={setPicking}>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>Message {targetName} as</SheetTitle>
          </SheetHeader>
          <ul className="grid gap-2 p-4">
            {eligible.map((p) => (
              <li key={p.profileId}>
                <Button
                  type="button" variant="secondary" className="w-full justify-start"
                  onClick={() => { setPicking(false); open(p.profileId); }}
                >
                  {p.name}
                </Button>
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
}
```

- [ ] **Step 2: Mount it on the four surfaces**

- `apps/web/app/u/[handle]/CuratorProfile.tsx:245-249`: add `<MessageButton targetProfileId={profileId} targetProfileType="curator" targetName={profile.name} />` in the same action row as `ShareButton` and `FollowButton` (musician-side viewers only, which the button's own gate enforces).
- `apps/web/app/u/[handle]/MusicianProfile.tsx:184-193`: add the same with `targetProfileType="musician"` beside `OfferGigButton`.
- `apps/web/src/search/CuratorArtistRow.tsx:61`: add `<MessageButton targetProfileId={r.id} targetProfileType="musician" targetName={r.title} actingProfileId={curatorProfileId} />` next to the "Offer a gig" button, wrapped in a `flex flex-wrap gap-2` row so both fit at 360px.
- `apps/web/src/bookings/BookingThread.tsx`: in the header area beside the existing thread title, add `<MessageButton targetProfileId={mySide === "musician" ? booking.curatorProfileId : booking.musicianProfileId} targetProfileType={mySide === "musician" ? "curator" : "musician"} targetName={otherName} actingProfileId={mySide === "musician" ? booking.musicianProfileId : booking.curatorProfileId} />` with a comment saying the pair is known here so no picker is needed, and that this is a link into free chat, deliberately separate from the terms-only offer thread. Use the existing `otherName` derivation if the file has one; otherwise pass the booking's stored profile name field, and if neither exists render the generic label by passing `targetName="this profile"`.

Both `CuratorProfile.tsx` and `MusicianProfile.tsx` are Server Components; `MessageButton` is `"use client"`, so importing the component (a value from a client module into a server module) is the allowed direction. Do not import anything from these pages back into the button (HANDOFF tripwire 4).

- [ ] **Step 3: Verify and commit**

`pnpm --filter @gatekeep/web typecheck`, `lint`, `build`. Live-load `/u/{handle}` for a venue and an artist and `/search` (HANDOFF tripwire 4 requires a real page load, not only a build, for changed web routes).

```bash
git add apps/web/src/messaging/MessageButton.tsx apps/web/app/u apps/web/src/search/CuratorArtistRow.tsx apps/web/src/bookings/BookingThread.tsx
git commit -m "feat(web): Message entry points on profile pages, curator search results, and the booking thread"
```

---

### Task 8: Web fan comments and reactions on the event page

**Files:**
- Create: `apps/web/src/events/EventComments.tsx`, `apps/web/src/events/GoingButton.tsx`
- Modify: `apps/web/src/discover/ShowPosts.tsx`, `apps/web/app/e/[eventId]/EventPageClient.tsx`

**Interfaces:**
- Consumes: `postComment`, `hideComment`, `deleteComment`, `reportComment`, `setGoing`, `setPostHeart` through `callFn`; `EventCommentDoc`, `CommentRole`, `COMMENT_MAX_CHARS`, `COMMENT_PAGE_SIZE`, and the comment copy constants from `@gatekeep/shared`; the existing `Textarea`, `Button`, `Badge`, `ErrorBox`, `Skeleton`, `Dialog` primitives and `IconHeart`, `IconWarning`, `IconEyeSlash`, `IconTrash` from `src/ui/icons.tsx`.
- Produces: `EventComments({ eventId, eventStatus, curatorProfileId, lineupMusicianProfileIds, goingCount, commentCount })`, `GoingButton({ eventId, eventStatus, initialCount })`, and `useCommentAuthority(curatorProfileId, lineupMusicianProfileIds, uid): "loading" | "curator" | "artist" | "fan" | "signedOut"` exported from `EventComments.tsx`. Task 12's mobile twin mirrors every name.

- [ ] **Step 1: The authority hook**

`useCommentAuthority` runs one `getDoc` on `profiles/{curatorProfileId}/members/{uid}` and one per id in `lineupMusicianProfileIds`, all inside a single effect that resolves through `Promise.all(...).then(...)` (never a synchronous `setState` in the effect body: eslint-config-next's React Compiler rules flag that, which is why `ShowPostsForAct` already routes its signed-out case through `Promise.resolve(false).then(...)`). Returns `"signedOut"` with no `uid`, `"curator"` on a curator hit, `"artist"` on any lineup hit, else `"fan"`. It is a client hint only: `postComment`, `hideComment`, and `deleteComment` each re-derive authority server-side, and a comment written for its `hidden` badge or its Hide button never trusts this value for anything but rendering.

- [ ] **Step 2: The Going button**

`GoingButton({ eventId, eventStatus, initialCount })` reads `events/{eventId}/reactions/{uid}` once with `getDoc` (rules allow any signed-in read), holds `{ going, count, busy }`, and on press calls `setGoing`, optimistically flipping and reconciling from the callable's `{ going, goingCount }` return. Renders a `Button variant={going ? "default" : "secondary"}` with the label `GOING_LABEL` and the count as a plain trailing number, plus a visually hidden `{count} going` span so the count is not carried by the number alone at small sizes. Signed out: renders the same button, which routes to `/sign-in?next=/e/{eventId}`, matching the buy flow's own sign-in gate. Hidden entirely when `eventStatus` is neither `"published"` nor `"completed"`.

- [ ] **Step 3: The comment list**

`EventComments` holds `{ rows: Row[] | "loading" | "error"; cursor: QueryDocumentSnapshot | null; done: boolean }` and pages with `getDocs`, newest first, `COMMENT_PAGE_SIZE` at a time:

```ts
// Admins see hidden comments too (spec 3.2), which needs a query WITHOUT the
// hidden pin; firestore.rules allows exactly that for an admin and refuses it
// for everyone else, so the two shapes are not interchangeable. The pinned
// shape is what the (hidden, at desc) composite index serves.
const base = collection(getFirebase().db, `events/${eventId}/comments`);
const q = isAdmin
  ? query(base, orderBy("at", "desc"), limit(COMMENT_PAGE_SIZE))
  : query(base, where("hidden", "==", false), orderBy("at", "desc"), limit(COMMENT_PAGE_SIZE));
```

`startAfter(cursor)` on each "Show more" press (label `SHOW_MORE_LABEL`, hidden once a page returns fewer than `COMMENT_PAGE_SIZE`). Rows render top-level comments with their replies nested one level under them, grouped client-side by `parentId` over the loaded page; a reply whose parent is not on the page (or was deleted) renders `COMMENT_DELETED_LINE` as its quoted parent line.

Each row: `authorName` in Sora semibold; a `<Badge variant="secondary">` reading "Curator" or "Artist" when `authorRole` is not `"fan"`; a relative time (`new Date(at).toLocaleString()` in `text-xs text-gk-muted`, the same formatting `PostRowItem` uses, so no new date helper is introduced); the text in `whitespace-pre-wrap`. Actions in a `flex flex-wrap gap-3` row of `Button variant="link" size="sm"` controls: `COMMENT_REPLY_LABEL` for any signed-in viewer, `COMMENT_HIDE_LABEL` when authority is `"curator"` or `"artist"`, `COMMENT_DELETE_LABEL` when `authorUid === uid`, and `REPORT_LABEL` otherwise. Report opens the same `Dialog` shape Task 6 built for conversations (title `REPORT_REASON_PROMPT`, a 300-character `Textarea`, success line `REPORT_SENT_MESSAGE`) calling `reportComment`. Hide and Delete act optimistically and reconcile by refetching page one. A hidden row (admins only) renders `commentHiddenLine(who)` where `who` is `hiddenBy.role === "admin" ? "an admin" : hiddenBy.role === "curator" ? "the organizer" : "an artist"`, and dims the text with `text-gk-muted`, never opacity alone.

Reply composer: a real `<form>` under the parent with a `Textarea` capped at `COMMENT_MAX_CHARS`, a counter, Cancel and a submit calling `postComment({ eventId, text, parentId })`.

Top composer: the same form with no `parentId`, `aria-label` and `placeholder` both `COMMENT_COMPOSER_PLACEHOLDER`. It is replaced by a muted `COMMENTS_CLOSED_MESSAGE` line whenever `eventStatus` is neither `"published"` nor `"completed"`, and by a "Sign in to comment" `Button` linking to `/sign-in?next=/e/{eventId}` for a signed-out visitor. Server refusals are surfaced verbatim in an `ErrorBox` (the rate sentence and the length sentence both come back as the exact shared strings).

States: `Skeleton` rows while `"loading"`; `ErrorBox` plus Retry on `"error"`; `COMMENTS_EMPTY_MESSAGE` when the first page is empty.

- [ ] **Step 4: Post hearts**

In `apps/web/src/discover/ShowPosts.tsx`, `PostRowItem` gains a heart control beside the existing delete button:

```tsx
// SP12 (spec 3.2): one heart per signed-in user per lineup post. The count
// comes off the post doc (server-maintained by setPostHeart), the "did I
// heart it" flag from a single getDoc on the per-user heart doc, which the
// rules allow any signed-in caller to read.
<button
  type="button"
  aria-label={hearted ? `Remove your heart from this post (${count})` : `Heart this post (${count})`}
  aria-pressed={hearted}
  disabled={!user || hearting}
  onClick={() => void toggleHeart()}
  className="flex shrink-0 items-center gap-1 rounded-gk-sm px-1.5 py-1 font-sora text-xs text-gk-muted outline-none hover:text-gk-text focus-visible:ring-2 focus-visible:ring-gk-focus disabled:opacity-50"
>
  <IconHeart size={14} aria-hidden="true" className={hearted ? "text-gk-accent" : undefined} />
  {count}
</button>
```

`toggleHeart` calls `setPostHeart({ eventId, postId, hearted: !hearted })` and reconciles from `{ hearted, heartCount }`. Add `IconHeart` to `apps/web/src/ui/icons.tsx` (Phosphor `/ssr`, duotone) if it is not already exported. `PostRow` gains `heartCount` from the doc (defaulting to 0), so `fetchLivePosts` needs no query change. The heart is the post's ONE ember touch; it is the only accent on the row, so no other element in `PostRowItem` gains a color.

- [ ] **Step 5: Mount on the event page**

In `apps/web/app/e/[eventId]/EventPageClient.tsx`, between the description `<section>` (line 190 to 197) and the Tickets `<section>` (line 200), insert:

```tsx
          {/* SP12 (spec 3.2): the show's reaction row and its fan comments,
              under the lineup and above the tickets block. */}
          <section className="mt-6 border-t border-gk-border pt-6">
            <GoingButton eventId={eventId} eventStatus={event.status} initialCount={event.goingCount ?? 0} />
            <EventComments
              eventId={eventId}
              eventStatus={event.status}
              curatorProfileId={event.curatorProfileId}
              lineupMusicianProfileIds={event.lineupMusicianProfileIds}
              commentCount={event.commentCount ?? 0}
            />
          </section>
```

- [ ] **Step 6: Verify and commit**

`pnpm --filter @gatekeep/web typecheck`, `lint`, `build`, then a live load of `/e/{eventId}` for a published event (HANDOFF tripwire 4).

```bash
git add apps/web/src/events/EventComments.tsx apps/web/src/events/GoingButton.tsx apps/web/src/discover/ShowPosts.tsx apps/web/app/e apps/web/src/ui/icons.tsx
git commit -m "feat(web): fan comments, replies, moderation, the Going toggle, and lineup-post hearts"
```

---

### Task 9: Web admin Reports panel

**Files:**
- Modify: `apps/web/app/admin/page.tsx`

**Interfaces:**
- Consumes: `resolveReport`, `hideComment` through `callFn`; `ReportDoc`, `ConversationDoc`, `MessageDoc`, `EventCommentDoc`, and the admin copy constants from `@gatekeep/shared`.
- Produces: the `ReportsPanel` component mounted in `AdminPage`. No new callable and no new query anywhere else.

- [ ] **Step 1: The panel**

Add `ReportsPanel` next to `ShowPostsPanel` (`apps/web/app/admin/page.tsx:1464`), copying that component's exact shape: an inline async IIFE effect with a `cancelled` guard and a single `setRows`/`setError` at the end, a `<section className="grid gap-3">` with a Syne `h2` reading `REPORTS_PANEL_TITLE`, a muted subtitle, a `role="alert"` warning line for errors, a `Skeleton` block while loading (not the bare "Loading…" text `ShowPostsPanel` still uses; Task 13 fixes that one and this new panel must not add another), and `REPORTS_EMPTY_MESSAGE` when there is nothing open.

The query is
`query(collection(db, "reports"), where("status", "==", "open"), orderBy("createdAt", "desc"), limit(50))`,
served by Task 2's `(status, createdAt desc)` composite.

Each row is a `Card` carrying: the kind ("Conversation" or "Comment"), the reporter uid, the reason in `whitespace-pre-wrap`, `new Date(createdAt).toLocaleString()`, and the target. For a comment report it also does one `getDoc` on `targetPath` and shows the comment's `authorName` and text, or "This comment has been deleted." when the doc is gone.

Actions per row:
- `REPORT_OPEN_CONVERSATION_LABEL` (conversation reports only): toggles an inline `ReportedConversation` block that reads `conversations/{id}` and its `messages` ordered by `at` ascending with `getDocs`, read-only, every bubble left-aligned and neutral (there is no "own side" for a moderator), each labelled with its `senderProfileId`. The read succeeds only because `openReports > 0` (Task 2's admin disjunct), so a failure renders "This conversation is no longer open for review." rather than a raw permission error.
- `REPORT_HIDE_COMMENT_LABEL` (comment reports only, and only while the comment still exists): calls `hideComment({ eventId, commentId })` with the ids parsed from `targetPath` (`events/{eventId}/comments/{commentId}`), then marks the row's local state hidden.
- An "Add a note" control reusing the existing admin `ReasonCard` (`apps/web/app/admin/page.tsx:119`) and calling the existing `flagAccount({ uid: report.reporterUid ... })`? No: the note belongs on the OFFENDING user, so it targets the reported comment's `authorUid` for a comment report and, for a conversation report, the `senderProfileId` cannot be resolved to a uid from the report alone. Ship the note only for comment reports, targeting the comment's `authorUid` through the existing `flagAccount` callable, and render a muted line on conversation rows saying "Open the conversation to find the account, then use User lookup to add a note." Record that narrowing in a code comment (the spec asks for the note on both; the data model gives a uid only on the comment side).
- `REPORT_RESOLVE_LABEL`: calls `resolveReport({ reportId })` and removes the row from local state (resolved reports leave the list, spec 3.3).

- [ ] **Step 2: Mount it**

In `AdminPage` (`apps/web/app/admin/page.tsx:2017`), add `<ReportsPanel />` immediately after `<AdminAlerts />` and before `<TakedownsPanel />`: an open abuse report is closer in urgency to an alert than to a takedown, and it needs the operator's eye before the queues below.

- [ ] **Step 3: Verify and commit**

`pnpm --filter @gatekeep/web typecheck`, `lint`, `build`, plus a live load of `/admin` as an admin account (HANDOFF tripwire 4).

```bash
git add apps/web/app/admin/page.tsx
git commit -m "feat(web): admin Reports panel with a read-only conversation view, hide, note, and resolve"
```

---

### Task 10: Mobile Messages tabs become real (list and thread screens)

**Files:**
- Create: `apps/mobile/src/messaging/useConversations.ts`, `apps/mobile/src/messaging/ConversationList.tsx`, `apps/mobile/src/messaging/ConversationThread.tsx`, `apps/mobile/app/(musician)/messages/_layout.tsx`, `apps/mobile/app/(musician)/messages/index.tsx`, `apps/mobile/app/(musician)/messages/[conversationId].tsx`, `apps/mobile/app/(curator)/messages/_layout.tsx`, `apps/mobile/app/(curator)/messages/index.tsx`, `apps/mobile/app/(curator)/messages/[conversationId].tsx`
- Delete: `apps/mobile/app/(musician)/messages.tsx`, `apps/mobile/app/(curator)/messages.tsx`
- Modify: `apps/mobile/app/(musician)/_layout.tsx`, `apps/mobile/app/(curator)/_layout.tsx`

**Interfaces:**
- Consumes: `useProfileContext` (`src/shell/ProfileContext.tsx`) for the acting profile; `callFn` (`src/lib/callable.ts`); the `Text`, `Button`, `Card`, `Badge`, `TextArea`, `Sheet`, `Skeleton`, `SkeletonCard`, `ErrorBanner`, `PageBackground` primitives from `src/ui`; `ConversationDoc`, `MessageDoc`, `MESSAGE_MAX_CHARS`, and the chat copy from `@gatekeep/shared`.
- Produces: `useConversations(profileId: string | null): { rows: ConversationRow[] | "loading" | "error"; retry: () => void }` and `unreadFor(row, profileId)` (same names and shapes as Task 6's web hook, deliberately: the two clients keep one vocabulary); `useUnreadTotal(profileIds: string[]): number` for Task 11's tab badge; `ConversationList({ profileId, onOpen })`; `ConversationThread({ profileId, conversationId })`.

- [ ] **Step 1: Convert each Messages tab into a stack**

Delete `app/(musician)/messages.tsx` and `app/(curator)/messages.tsx` and create a `messages/` folder in each group. Each `_layout.tsx` is a `Stack` with `screenOptions` from `useShellScreenOptions()` and two screens: `index` titled "Messages" and `[conversationId]` with its title set per screen from the other profile's name. In both tab layouts, `<Tabs.Screen name="messages" ...>` gains `headerShown: false`, exactly the comment and reasoning `(curator)/_layout.tsx` already records for the `events` folder (the inner Stack owns its own headers, so the Tabs header must not double up). Both files' `messages` entries also lose nothing else; the `IconChatCircle` tab icon stays.

- [ ] **Step 2: The subscription hook**

`apps/mobile/src/messaging/useConversations.ts` is the mobile twin of Task 6 Step 1: the same query
(`where("participants", "array-contains", profileId)`, `orderBy("lastMessageAt", "desc")`, `limit(50)`),
the same `"loading" | "error" | rows` sentinel, the same error callback and `retry`, and the same `unreadFor` export. `useUnreadTotal(profileIds)` opens one listener per profile id (a user rarely holds more than a couple of profiles of one type) and returns the summed `unreadFor` across every row, which is what the tab badge shows.

- [ ] **Step 3: The list screen**

`ConversationList({ profileId, onOpen })` renders a `FlatList` of `Pressable` rows, each `accessibilityRole="button"` with `accessibilityLabel={\`${otherName}, ${unread} unread\`}` and `minHeight: 44` (this sub-project's own 44px rule from item #19 applies to new code from the start). Row content mirrors web: `Text variant="label"` name, `Text variant="meta" muted` type, one-line `numberOfLines={1}` preview, the time, and a `Badge` count. States: `SkeletonCard` rows while loading, `ErrorBanner` plus a `Button title="Retry"` on error, and `Text muted` "No conversations yet. Message a venue or an artist from their page." when empty.

`app/(musician)/messages/index.tsx` reads `activeContext` from `useProfileContext()`, takes `activeContext !== "fan" ? activeContext.profileId : null`, and renders `PageBackground` plus the list, pushing `/(musician)/messages/[conversationId]` on open. The curator copy is identical with the curator route. When the active context is `"fan"` (or an unapproved profile), the screen renders a `Card` reading "Switch to a musician profile to see its messages." (curator wording on the curator side), which is the same posture the other profile-scoped tabs already take.

- [ ] **Step 4: The thread screen**

`ConversationThread({ profileId, conversationId })` subscribes to the conversation doc and its `messages` (`orderBy("at","asc")`, `limit(200)`), both with error callbacks, calls `markConversationRead` once per `conversationId`, and renders an inverted `FlatList` of bubbles matching `apps/mobile/src/bookings/BookingThread.tsx`'s own bubble styling: own side right, `backgroundColor: t.accent + "24"` with `borderColor: t.accent + "80"`, other side left on `t.surface` with `t.border`. No ember on a plain border elsewhere on the screen (DESIGN.md accent dosage, audit item #42's rule).

Header actions live in a `Sheet` opened by a header `Button variant="ghost"` labelled "More" with `accessibilityLabel="Conversation actions"`: `BLOCK_LABEL` (admins of the acting profile only, resolved with one `getDoc` on `profiles/{profileId}/members/{uid}` and checking `role === "admin"`), `REPORT_LABEL`, and "View profile" pushing `/artist/[handle]` or `/venue/[handle]`. Report opens a second `Sheet` with `REPORT_REASON_PROMPT` as its title, a `TextArea` capped at 300, and a submit calling `reportConversation`; success shows `REPORT_SENT_MESSAGE` in a `Callout tone="success"`. Both sheets need their own `KeyboardAvoidingView` around the form content (the `Sheet` primitive's header comment says the caller owns keyboard avoidance, and `sp11-rulings.md`'s execution lessons name two Sheet forms that shipped without it).

Composer: a `TextArea` with `placeholder={MESSAGE_COMPOSER_PLACEHOLDER}`, `accessibilityLabel={MESSAGE_COMPOSER_PLACEHOLDER}`, `maxLength={MESSAGE_MAX_CHARS}`, a `{text.length} / {MESSAGE_MAX_CHARS}` counter, and a `Button title={MESSAGE_SEND_LABEL} loading={sending}` (the primitive already has a `loading` prop and a 44px minimum). Blocked-by-me replaces it with `CONVERSATION_BLOCKED_MESSAGE` plus an `UNBLOCK_LABEL` button for admins; a send refused by the server surfaces the message verbatim in an `ErrorBanner`. Empty thread renders `CONVERSATION_EMPTY_MESSAGE`.

- [ ] **Step 5: Verify and commit**

`pnpm --filter @gatekeep/mobile typecheck`, `lint` (0 errors, no new warnings), `expo export --no-bytecode` (the four new routes appear).

```bash
git add apps/mobile/src/messaging "apps/mobile/app/(musician)" "apps/mobile/app/(curator)"
git commit -m "feat(mobile): real Messages tabs with a conversation list, thread, composer, and moderation sheet"
```

---

### Task 11: Mobile message entry points, unread badge, push routing

**Files:**
- Create: `apps/mobile/src/messaging/MessageButton.tsx`
- Modify: `apps/mobile/app/venue/[handle].tsx`, `apps/mobile/app/artist/[handle].tsx`, `apps/mobile/src/search/CuratorArtistRow.tsx`, `apps/mobile/src/bookings/BookingThread.tsx`, `apps/mobile/app/(musician)/_layout.tsx`, `apps/mobile/app/(curator)/_layout.tsx`, `apps/mobile/src/notifications/push.ts`

**Interfaces:**
- Consumes: `useProfileContext` and the `myProfiles` list it already exposes; `conversationPairId`, `MESSAGE_ACTION_LABEL` from `@gatekeep/shared`; `useUnreadTotal` from Task 10; the `Sheet` and `Button` primitives.
- Produces: `MessageButton({ targetProfileId, targetProfileType, targetName, actingProfileId? })`, the two tab badges, and `pushHref` widened to carry the `message` refKinds.

- [ ] **Step 1: The button**

The mobile twin of Task 7's component, with `myProfiles` from `useProfileContext()` in place of `useMyProfiles`, `router.push({ pathname: "/(musician)/messages/[conversationId]", params: { conversationId: pairId } })` (or the curator route, chosen by the ACTING profile's type, not the target's) in place of the web push, and the `Sheet` primitive for the multi-profile picker. Same gate: hidden when no eligible approved profile of the opposite type exists, straight through when exactly one does, sheet when several. Same comment recording that the conversation id is computed only to pre-select the thread and that the server creates the doc on the first send.

- [ ] **Step 2: Mount it on the four surfaces**

- `apps/mobile/app/venue/[handle].tsx:171-178`: add `<MessageButton targetProfileId={profileId} targetProfileType="curator" targetName={profile.name} />` into the same wrapping action row as `FollowButton` and `ShareButton` (the row already sets `flexWrap: "wrap"`, so 360px is safe).
- `apps/mobile/app/artist/[handle].tsx:390-394`: add the same with `targetProfileType="musician"`; that row is `flexDirection: "row"` with `justifyContent: "space-between"` and no wrap today, so also give it `flexWrap: "wrap"` and `rowGap: tokens.space.sm`.
- `apps/mobile/src/search/CuratorArtistRow.tsx`: add it beside the row's existing "Offer a gig" control, passing `actingProfileId={curatorProfileId}`.
- `apps/mobile/src/bookings/BookingThread.tsx`: add it near the top of the screen with `actingProfileId` set to the viewer's own side, and the same comment Task 7 uses about the pair being known and chat being deliberately separate from the terms-only thread.

- [ ] **Step 3: Tab badges**

In both tab layouts, the Messages `<Tabs.Screen>` gains a badge computed from `useUnreadTotal`:

```tsx
// SP12 (spec 3.1): the badge sums unread across every profile of THIS tab
// group's type, because the group's own screens can switch between them.
const unread = useUnreadTotal(
  myProfiles.filter((p) => p.type === "musician" && p.status === "approved").map((p) => p.profileId));
...
<Tabs.Screen name="messages" options={{
  title: "Messages", headerShown: false,
  tabBarBadge: unread > 0 ? unread : undefined,
  tabBarBadgeStyle: { backgroundColor: t.accent, color: t.onAccent },
  tabBarAccessibilityLabel: unread > 0 ? `Messages, ${unread} unread` : "Messages",
  tabBarIcon: ({ color }) => <IconChatCircle color={color} size={22} />,
}} />
```

with `"curator"` on the curator side. `t` comes from `useTokens()`; the layout components are already function components, so both hooks are legal there.

- [ ] **Step 4: Push routing**

In `apps/mobile/src/notifications/push.ts`, widen the `refKind` narrowing in `pushHref`:

```ts
  const refKind = data.refKind === "event" || data.refKind === "gig" || data.refKind === "profile"
    || data.refKind === "payouts" || data.refKind === "musician" || data.refKind === "curator"
    ? data.refKind : undefined;
```

and extend the header comment: SP12 adds `"musician"` and `"curator"`, which is what lets a `message` push open the right tab group's thread; `notificationHref` falls back to the musician group when the value is missing. `NotificationsList` needs no change (it already passes `item.refKind` straight through).

- [ ] **Step 5: Verify and commit**

`pnpm --filter @gatekeep/mobile typecheck`, `lint`, `expo export --no-bytecode`.

```bash
git add apps/mobile/src/messaging/MessageButton.tsx apps/mobile/app apps/mobile/src/search/CuratorArtistRow.tsx apps/mobile/src/bookings/BookingThread.tsx apps/mobile/src/notifications/push.ts
git commit -m "feat(mobile): Message entry points, the unread tab badge, and message push routing"
```

---

### Task 12: Mobile fan comments and reactions on the event screen

**Files:**
- Create: `apps/mobile/src/events/EventComments.tsx`, `apps/mobile/src/events/GoingButton.tsx`
- Modify: `apps/mobile/src/discover/ShowPosts.tsx`, `apps/mobile/app/event/[eventId].tsx`

**Interfaces:**
- Consumes: exactly the callables and shared constants Task 8 lists; the `Text`, `Button`, `Card`, `Badge`, `TextArea`, `Skeleton`, `SkeletonCard`, `ErrorBanner`, `Callout`, `Sheet` primitives; `IconHeart` from `src/ui/icons.tsx`.
- Produces: `EventComments({ eventId, eventStatus, curatorProfileId, lineupMusicianProfileIds })`, `GoingButton({ eventId, eventStatus, initialCount })`, and `useCommentAuthority(...)` with the identical signature and return union Task 8 defines. Nothing is imported across platforms; the names match so a reviewer reads one contract twice.

- [ ] **Step 1: Port the three pieces**

`useCommentAuthority`, `GoingButton`, and `EventComments` mirror Task 8 step by step on mobile primitives: `Button` for Going (`variant={going ? "default" : "secondary"}`, `accessibilityRole="button"`, `accessibilityState={{ selected: going }}`, `accessibilityLabel={\`${GOING_LABEL}, ${count} going\`}`), a `FlatList` for the comment page with a `Button title={SHOW_MORE_LABEL}` footer, `Badge` for the Curator and Artist tags, and a `Sheet` (with its own `KeyboardAvoidingView`) for the report form instead of a `Dialog`. Every row action is a `Button variant="ghost"` rather than a bare `Pressable`, so the 44px minimum and the `accessibilityRole` come from the primitive rather than being added per site.

The paging query is identical, including the admin branch:

```ts
const base = collection(getFirebase().db, `events/${eventId}/comments`);
const q = isAdmin
  ? query(base, orderBy("at", "desc"), limit(COMMENT_PAGE_SIZE))
  : query(base, where("hidden", "==", false), orderBy("at", "desc"), limit(COMMENT_PAGE_SIZE));
```

Closed events replace the composer with `Text muted` `COMMENTS_CLOSED_MESSAGE`; a signed-out viewer gets a `Button title="Sign in to comment"` pushing `/(auth)/sign-in`.

- [ ] **Step 2: Post hearts**

`apps/mobile/src/discover/ShowPosts.tsx`'s post row gains the heart control as a `Pressable` with `accessibilityRole="button"`, `accessibilityState={{ selected: hearted }}`, `accessibilityLabel={hearted ? \`Remove your heart from this post, ${count}\` : \`Heart this post, ${count}\`}`, `hitSlop={12}`, and `minHeight: 44` on its style, rendering `IconHeart` (add it to `apps/mobile/src/ui/icons.tsx` if absent) tinted `t.accent` when hearted and `t.muted` otherwise, with the count beside it in `Text variant="meta"`. Same `setPostHeart` call and reconciliation as web.

- [ ] **Step 3: Mount on the event screen**

In `apps/mobile/app/event/[eventId].tsx`, insert the reaction row and the comments block between the About section (around line 653) and the Tickets section (around line 659), inside the same scroll container, with a `borderTopWidth: 1, borderTopColor: t.border, paddingTop: 16` separator matching the web page's own `border-t` treatment. Confirm the current line numbers before editing; the anchors are the `<Text variant="title">About</Text>` and `<Text variant="title">Tickets</Text>` headings.

- [ ] **Step 4: Verify and commit**

`pnpm --filter @gatekeep/mobile typecheck`, `lint`, `expo export --no-bytecode`.

```bash
git add apps/mobile/src/events/EventComments.tsx apps/mobile/src/events/GoingButton.tsx apps/mobile/src/discover/ShowPosts.tsx "apps/mobile/app/event/[eventId].tsx" apps/mobile/src/ui/icons.tsx
git commit -m "feat(mobile): fan comments, replies, moderation, the Going toggle, and lineup-post hearts"
```

---

## Follow-on tasks

Each item below carries its audit number. Every claim was re-verified against this tree on 2026-09-05; the items the audit named that are already closed are listed in the Self-review, not here, and no task should re-open them.

### Task 13: Web listeners, states, and the missing empty state (#10, #13, #14, #15)

**Files:**
- Create: `apps/web/src/ui/ListError.tsx`
- Modify: `apps/web/src/events/AttendeeList.tsx`, `apps/web/app/tickets/TicketsClient.tsx`, `apps/web/src/events/EventsManager.tsx`, `apps/web/app/admin/page.tsx`, `apps/web/app/dashboard/page.tsx`, `apps/web/src/portfolio/TrackManager.tsx`, `apps/web/app/dashboard/portfolio/[profileId]/page.tsx`, `apps/web/app/dashboard/curator/[profileId]/gigs/page.tsx`, `apps/web/app/dashboard/curator/[profileId]/series/[seriesId]/page.tsx`, `apps/web/src/bookings/BookingInbox.tsx`, `apps/web/src/events/BuyTicketsFlow.tsx`, `apps/web/app/join/page.tsx`, `apps/web/app/gigs/[gigId]/page.tsx`, `apps/web/src/bookings/OfferComposer.tsx`

**Interfaces:**
- Consumes: the existing `ErrorBox` (`src/ui/ErrorBox.tsx`), `Skeleton` (`src/ui/skeleton.tsx`), `Button`; `NO_TICKETS_YET_MESSAGE` from `@gatekeep/shared` (Task 1).
- Produces: `ListError({ message, onRetry })`, one warning line plus a Retry button, which every listener below renders on its error sentinel. Task 14 does not import it (mobile has `ErrorBanner`); the two stay separate components with the same job.

- [ ] **Step 1: The shared error line**

`apps/web/src/ui/ListError.tsx`:

```tsx
"use client";
import { Button } from "./button";
import { IconWarning } from "./icons";

// SP12 follow-on (audit #10). The house shape for "this list failed to
// load": the branded warning line plus one Retry, modelled on
// src/payments/EarningsPanel.tsx's own precedent. Every onSnapshot in
// apps/web now has an error callback that sets an "error" sentinel, and
// every one of those sentinels renders THIS, so the failure state cannot
// drift into a dozen shapes.
export function ListError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
    >
      <IconWarning size={16} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && <Button type="button" size="sm" variant="secondary" onClick={onRetry}>Retry</Button>}
    </div>
  );
}
```

- [ ] **Step 2: Error callbacks on every web listener (#10)**

The pattern, applied identically at each site: the state becomes `T[] | "loading" | "error"` (or `T | null | "loading" | "error"` for a single doc), the `onSnapshot` call gains a third argument `(e) => { console.error("<what> onSnapshot failed", e); setX("error"); }`, and the render gains a `ListError` branch with an `onRetry` that increments a `reloadKey` held in the component and listed in the effect's dependency array. Sites, all verified present with no error handler today:

- `apps/web/src/events/AttendeeList.tsx:38` (attendees)
- `apps/web/app/tickets/TicketsClient.tsx:49` (the fan's tickets)
- `apps/web/src/events/EventsManager.tsx:52` (tiers), `:142` (profile), `:152` (events), `:157` (filled gigs); `:200`'s bare `return null` on a profile error becomes the `ListError` line, so a failed profile read stops rendering a blank section
- `apps/web/app/admin/page.tsx:430`, `:599`, `:782`, `:1838`, `:1996` (queue, tracks, gigs, audit log, admin alerts), plus the two loaders with no `catch` at all: `UserProfiles` (`:1628`) and `AdminNotes` (`:1670`)
- `apps/web/app/dashboard/page.tsx:52` (my profiles), `:256` (notifications)
- `apps/web/src/portfolio/TrackManager.tsx:38` (tracks)
- `apps/web/app/dashboard/portfolio/[profileId]/page.tsx:134` (the portfolio's second listener)
- `apps/web/app/dashboard/curator/[profileId]/gigs/page.tsx:101`, `:110` (gigs, series)
- `apps/web/app/dashboard/curator/[profileId]/series/[seriesId]/page.tsx:194` (occurrences)

Re-grep before editing (`grep -rn "onSnapshot(" apps/web`) and treat the grep as the list of record: the line numbers above were read on 2026-09-05 and shift as this task edits files above them. Sites that ALREADY carry an error callback (`src/payments/EarningsPanel.tsx:75`, `src/discover/useFollows.tsx:48`, `src/search/SavedSearches.tsx:37`, `src/events/PosterField.tsx:49`, the four in `src/bookings/BookingThread.tsx`, `src/payments/PaymentsPanel.tsx`, `src/payments/SharesCard.tsx`, `src/shell/useMyProfiles.ts` handles it through its own `cancelled` path) are left alone except where Step 3 names them.

- [ ] **Step 3: An error is not an empty result (#13)**

Three web listeners currently set `[]` on failure, so a permission or offline error renders the empty state. Replace each `() => setX([])` with the `"error"` sentinel and the `ListError` branch:

- `apps/web/src/bookings/BookingInbox.tsx:331` (`() => setOpen([])`), `:340` (`() => setConfirmed([])`), `:349` (`() => setHistory([])`).

Each of the three sections keeps its own existing `InboxEmpty` copy for a genuinely empty result and gains `ListError` with the message "Couldn't load your bookings. Retry." for the error case.

- [ ] **Step 4: The web event page's zero-tier state (#14)**

In `apps/web/src/events/BuyTicketsFlow.tsx`, immediately before the final `return (<div className="grid gap-4 pb-24">` (around line 388, after the terminal-phase branches), add:

```tsx
  // SP12 follow-on (audit #14): a published event with no tiers used to
  // render an empty picker under the "Tickets" heading and no sticky bar.
  // Mobile has said this since SP6; web now matches, and names the next
  // action rather than leaving the fan on a dead heading.
  if (liveTiers.length === 0) {
    return (
      <div className="grid gap-2">
        <p className="font-sora text-sm text-gk-text">{NO_TICKETS_YET_MESSAGE}</p>
        <p className="font-sora text-sm text-gk-muted">Check back soon, or follow the venue to hear when they go on sale.</p>
      </div>
    );
  }
```

Import `NO_TICKETS_YET_MESSAGE` from `@gatekeep/shared`. Also update the mobile side's existing sentence in Task 16? No: mobile already carries its own zero-tier state (`apps/mobile/app/event/[eventId].tsx`, "No ticket tiers are set up for this event yet."). Leave it; the spec asks only for web to gain the state, and the shared constant is what a later parity pass would unify.

- [ ] **Step 5: Skeletons instead of bare loading text (#15, web half)**

Replace each bare loading paragraph with a content-shaped `Skeleton` block wrapped in `role="status"` with an `aria-label`, the shape `apps/web/app/dashboard/page.tsx:76` already uses:

- `apps/web/app/dashboard/page.tsx:342` ("Loading…") becomes a two-line skeleton labelled "Loading your account"
- `apps/web/app/join/page.tsx:73` ("Loading…") becomes a form-shaped skeleton labelled "Loading the join form"
- `apps/web/app/admin/page.tsx:1535` ("Loading…" in `ShowPostsPanel`) becomes `CardRowsSkeleton` (already defined at `:174`) with `label="Loading show posts"`; re-grep `apps/web/app/admin/page.tsx` for any other bare `Loading…` paragraph and convert it the same way
- `apps/web/app/gigs/[gigId]/page.tsx:65` ("Loading your musician profiles…") becomes a one-line skeleton labelled "Loading your musician profiles"
- `apps/web/src/bookings/OfferComposer.tsx:92` ("Loading your open gigs…") becomes a two-row skeleton labelled "Loading your open gigs"

`ShowPostsForAct`'s "Loading posts…" (`src/discover/ShowPosts.tsx:158`) becomes a one-line `Skeleton` too, so Task 8's new comment list is not the only content-shaped loader on the event page.

- [ ] **Step 6: Verify and commit**

`pnpm --filter @gatekeep/web typecheck`, `lint`, `build`, and live-load `/dashboard`, `/tickets`, `/admin`, and `/e/{eventId}` (HANDOFF tripwire 4). Confirm with `grep -rn -A6 "onSnapshot(" apps/web | grep -c "onSnapshot"` that the count of listeners matches the count of files touched plus the pre-existing handled ones.

```bash
git add apps/web/src/ui/ListError.tsx apps/web/src apps/web/app
git commit -m "fix(web): error callbacks and retry on every listener, an error-not-empty split, the zero-tier state, and skeletons"
```

---

### Task 14: Mobile listeners, states, and empty-state parity (#11, #12, #13, #15, #16)

**Files:**
- Modify: `apps/mobile/app/(curator)/dashboard.tsx`, `apps/mobile/app/(curator)/bookings.tsx`, `apps/mobile/app/(curator)/musicians.tsx`, `apps/mobile/app/(curator)/events/index.tsx`, `apps/mobile/app/(curator)/events/new.tsx`, `apps/mobile/app/(curator)/events/[gigId].tsx`, `apps/mobile/app/(curator)/events/series/[seriesId].tsx`, `apps/mobile/app/(curator)/events/event/[eventId].tsx`, `apps/mobile/app/(curator)/events/scan/[eventId].tsx`, `apps/mobile/app/(musician)/portfolio.tsx`, `apps/mobile/src/events/AttendeeListScreen.tsx`, `apps/mobile/src/events/TierEditor.tsx`, `apps/mobile/src/shell/NotificationsList.tsx`, `apps/mobile/src/portfolio/TrackManager.tsx`, `apps/mobile/src/tickets/TicketList.tsx`, `apps/mobile/src/bookings/BookingInbox.tsx`, `apps/mobile/src/bookings/BookingThread.tsx`, `apps/mobile/src/payments/EarningsPanel.tsx`, `apps/mobile/src/bookings/PaymentStatus.tsx`, `apps/mobile/app/event/[eventId].tsx`, `apps/mobile/src/events/ScannerScreen.tsx`, `apps/mobile/app/(auth)/sign-in.tsx`

**Interfaces:**
- Consumes: the existing `ErrorBanner`, `Skeleton`, `SkeletonCard`, `Button` primitives from `src/ui`.
- Produces: no new exports. The contract this task establishes is the four-way screen state `"loading" | "error" | null | Doc`, which `apps/mobile/app/(musician)/portfolio.tsx:72` already uses for its booking doc and which every screen below adopts.

- [ ] **Step 1: The four-way sentinel (#11)**

Today every screen listed models a doc read as `useState<Doc | null>(null)` and renders the skeleton while `!doc`, and its error callback also sets `null`, so a failed read and a deleted document are both a permanent skeleton. Change each to `useState<Doc | "loading" | "error" | null>("loading")` with:

```ts
    return onSnapshot(doc(db, "profiles", profileId),
      (s) => setProfile(s.exists() ? (s.data() as ProfileDoc) : null),
      (e) => { console.error("profile onSnapshot failed", e); setProfile("error"); });
```

and a render that branches: `"loading"` renders the existing skeleton; `"error"` renders `<ErrorBanner message="Couldn't load this. Retry." />` plus a `Button title="Retry"` bumping a `reloadKey`; `null` renders the not-found copy. Sites, verified today:

- `apps/mobile/app/(curator)/dashboard.tsx:99-102,119` (profile)
- `apps/mobile/app/(curator)/bookings.tsx:37,39`
- `apps/mobile/app/(curator)/musicians.tsx:39,42`
- `apps/mobile/app/(curator)/events/index.tsx:298,348`
- `apps/mobile/app/(curator)/events/new.tsx:69,83`
- `apps/mobile/app/(curator)/events/[gigId].tsx:128,147,162`, whose `null` branch gains the "Gig not found" copy its web twin already carries at `apps/web/app/dashboard/curator/[profileId]/gigs/[gigId]/page.tsx:208-215`
- `apps/mobile/app/(curator)/events/series/[seriesId].tsx:134-136,154-157,166` (both `() => setX(null)` callbacks become `"error"`)
- `apps/mobile/app/(curator)/events/event/[eventId].tsx:98,118`
- `apps/mobile/app/(curator)/events/scan/[eventId].tsx:37,40`
- `apps/mobile/app/(musician)/portfolio.tsx:151-153,195`

- [ ] **Step 2: Error callbacks where there are none (#12)**

Add the same third argument (log plus `"error"` sentinel plus a Retry in the render) at:

- `apps/mobile/src/events/AttendeeListScreen.tsx:43`
- `apps/mobile/src/events/TierEditor.tsx:182` (`useLiveTiers`)
- `apps/mobile/app/(curator)/events/index.tsx:311,321,333` (gigs, series, events)
- `apps/mobile/app/(curator)/events/series/[seriesId].tsx:161` (occurrences)
- `apps/mobile/src/shell/NotificationsList.tsx:19`
- `apps/mobile/src/portfolio/TrackManager.tsx:39-42` and `apps/mobile/app/(musician)/portfolio.tsx:189-192`, which log only and never surface anything

- [ ] **Step 3: An error is not an empty result (#13, mobile half)**

- `apps/mobile/src/tickets/TicketList.tsx:51` (`() => setRows([])`) becomes the `"error"` sentinel; the wallet renders `ErrorBanner` with "Couldn't load your tickets. Retry." plus a Retry, and `EmptyTickets` stays for a genuinely empty wallet.
- `apps/mobile/src/bookings/BookingInbox.tsx:176,185,195` (the three `() => setX([])` callbacks) get the same treatment with "Couldn't load your bookings. Retry."

The audit also named `apps/mobile/app/(fan)/index.tsx:26-33` here; that file is now a one-line `DeckScreen` wrapper (SP7 Task 12) and has no listener, so there is nothing to fix. Do not add one.

- [ ] **Step 4: Skeletons and busy states (#15, mobile half)**

- `apps/mobile/src/bookings/BookingThread.tsx:218` (`<Text muted>Loading…</Text>`) becomes a `SkeletonCard` block
- `apps/mobile/src/payments/EarningsPanel.tsx:299` (`Loading…`) becomes a `SkeletonCard`
- `apps/mobile/src/bookings/PaymentStatus.tsx:226` ("Loading card status…") becomes a two-line `Skeleton`
- `apps/mobile/app/event/[eventId].tsx:544` ("Confirming your order…") and `:560` ("Opening the payment sheet…") keep their sentences (they name a live operation, not a load) but gain an `ActivityIndicator` sibling inside a `View` with `accessibilityRole="progressbar"` and the sentence as the `accessibilityLabel`
- `apps/mobile/src/events/ScannerScreen.tsx:172` (a bare `ActivityIndicator`) gains a visible "Checking camera access" line and the same `accessibilityRole="progressbar"`
- `apps/mobile/app/(auth)/sign-in.tsx:111-117`: the three `Button`s gain `loading={busy}` (the primitive already renders a spinner and disables itself), driven by a single `busy` state set around each of `emailSignIn`, `googleSignIn`, and `appleSignIn`, so a double tap cannot fire twice
- `apps/mobile/src/discover/ShowPosts.tsx:148` ("Loading posts…") becomes a one-line `Skeleton`, matching Task 13's web change

- [ ] **Step 5: Empty-state copy parity (#16)**

Port the web sentences verbatim (they are role-neutral):

- `apps/mobile/src/bookings/BookingInbox.tsx:279` becomes "No open threads yet. Offers and counters will show up here." (web `:364`), `:285` becomes "Nothing confirmed yet. Accept an offer in Open threads above and it lands here as a date." (web `:374`), `:291` becomes "No history yet. Completed and closed bookings will land here." (web `:382`)
- `apps/mobile/src/payments/EarningsPanel.tsx:131` becomes "Nothing pending right now. A confirmed date shows up here once it's played and waiting to settle." (web `:108`)
- `apps/mobile/src/shell/NotificationsList.tsx:62` becomes the web dashboard's own empty card (`apps/web/app/dashboard/page.tsx:286-300`): a bell icon, "All caught up" as a `Text variant="label"`, the muted sentence "Review updates and booking activity will land here the moment they happen. In the meantime, go see what's playing.", and a `Button variant="ghost" title="Browse gigs"` pushing `/(musician)/gigs`
- `apps/mobile/app/(curator)/events/index.tsx:475` ("No open gigs.") becomes "No open gigs yet. Post one and musicians can apply."; `:487` ("Nothing here yet.") becomes "No past gigs yet. Closed and cancelled gigs land here."; `:541` ("No recurring series yet.") gains a second muted line "Create a series when the same night repeats."

The audit's `GigBrowse.tsx` and `MusicianBrowse.tsx` entries under #16 name files SP8 deleted; there is nothing to port there.

- [ ] **Step 6: Verify and commit**

`pnpm --filter @gatekeep/mobile typecheck`, `lint` (0 errors, no new warnings), `expo export --no-bytecode`. Confirm with `grep -rn -A6 "onSnapshot(" apps/mobile` that no listener is left without a third argument.

```bash
git add apps/mobile/app apps/mobile/src
git commit -m "fix(mobile): explicit loading, error, and not-found states on every screen, plus web empty-state parity"
```

---

### Task 15: Mobile contrast, tap targets, and the 360px header (#17, #18, #19, #28)

**Files:**
- Modify: `apps/mobile/app/(auth)/sign-in.tsx`, `apps/mobile/app/(curator)/events/index.tsx`, `apps/mobile/app/event/[eventId].tsx`, `apps/mobile/src/ui/Chip.tsx`, `apps/mobile/src/bookings/PaymentStatus.tsx`, `apps/mobile/src/portfolio/TrackManager.tsx`, `apps/mobile/src/portfolio/PortfolioForms.tsx`, `apps/mobile/src/portfolio/TrimUploader.tsx`, `apps/mobile/src/curator/CuratorForms.tsx`, `apps/mobile/src/payments/EarningsPanel.tsx`, `apps/mobile/src/payments/GatePrompt.tsx`, `apps/mobile/src/payments/DelinquencyBanner.tsx`, `apps/mobile/src/tickets/TicketDetail.tsx`, `apps/mobile/app/artist/[handle].tsx`, `apps/mobile/src/shell/ContextSwitcher.tsx`

**Interfaces:**
- Consumes: `useTokens()` (`src/theme/ThemeProvider.tsx`), which already exposes `t.focus` (the light-theme ember substitute the shell uses at `src/shell/ContextSwitcher.tsx:17`), and the `Button` primitive (already `minHeight: 44` with `accessibilityRole="button"`).
- Produces: `Chip` gains `minHeight: 44`. No other exported shape changes.

- [ ] **Step 1: Ember text on light surfaces (#17)**

Bare `t.accent` text measures roughly 2.6 to 2.8:1 on the light theme (DESIGN.md's own figure), under the 4.5:1 floor. Two sites:
- `apps/mobile/app/(auth)/sign-in.tsx:126`: `<Text color={t.accent}>New here? Create an account</Text>` becomes `color={t.focus}`.
- `apps/mobile/app/(curator)/events/index.tsx:56`: the 13px "series" meta link becomes `color={t.focus}`.

`t.focus` is the documented light-theme substitute and resolves to the same ember in dark, so both themes stay right with one token. Do not introduce a new color. While in `events/index.tsx:56`, drop the trailing arrow glyph from the label per DESIGN.md's one-arrow-per-page rule; the word "series" already names the destination.

- [ ] **Step 2: Disabled tier rows (#18)**

`apps/mobile/app/event/[eventId].tsx:210` sets `opacity: canPick ? 1 : 0.55` on the whole `TierCard`, which drags the "Sold out" / "Not yet on sale" / "Sale ended" label (13px muted) to roughly 2.7:1 in light. Move the dimming off the card and onto the radio control only, and render the reason as a `StatusBadge` at full opacity, matching what web's `TierPicker.tsx:67` already does. The tier name and the price also stay at full opacity: they are the information a buyer needs in order to understand what is unavailable.

- [ ] **Step 3: 44px tap targets (#19)**

`apps/mobile/src/ui/Chip.tsx` gains `minHeight: 44` and `justifyContent: "center"` on its `Pressable` style (it is `paddingVertical: 6` plus a 14px label today, about 30px, and Chip is the app's filter and picker control everywhere). Then, for each bare-text `Pressable` below, either swap it for the `Button` primitive (preferred, it carries the height and the role) or add `hitSlop={12}` plus `minHeight: 44` and `justifyContent: "center"`:

- `apps/mobile/src/bookings/PaymentStatus.tsx:230` (Retry), `:241` (Update card / Add a card), `:275` (Report actuals), `:302` (Manage payouts): all four become `Button variant="ghost"`
- `apps/mobile/src/portfolio/TrackManager.tsx:101,104,116,119` (Save, Cancel, Rename, Delete) become `Button variant="ghost"`; `:110,113` (the reorder arrows) keep their `Pressable` but gain `hitSlop={12}` and `minHeight: 44`
- `apps/mobile/src/portfolio/PortfolioForms.tsx:124` (Remove link) becomes `Button variant="ghost"`
- `apps/mobile/src/curator/CuratorForms.tsx:275` (Remove photo) becomes `Button variant="ghost"`
- `apps/mobile/src/payments/EarningsPanel.tsx:303` (Retry) becomes `Button variant="ghost"`
- the inline `Text onPress` pseudo-links at `apps/mobile/src/payments/GatePrompt.tsx:94,102,171`, `apps/mobile/src/payments/DelinquencyBanner.tsx:55`, `apps/mobile/src/tickets/TicketDetail.tsx:98`, and `apps/mobile/app/event/[eventId].tsx` (the lineup names) get wrapped in a `Pressable` with `hitSlop={12}` and `minHeight: 44`
- `apps/mobile/app/event/[eventId].tsx:247,260` (the quantity steppers, 36px) go to 44
- `apps/mobile/app/artist/[handle].tsx:314-316` (the link pills, about 36px) go to 44
- `apps/mobile/src/shell/ContextSwitcher.tsx:22` (the trigger, padding 8) gains `minHeight: 44`
- `apps/mobile/src/portfolio/TrimUploader.tsx:303,306,310` (the transport controls) gain `minHeight: 44`

Re-grep each file before editing; the line numbers were read on 2026-09-05 and Task 14 edits several of these same files.

- [ ] **Step 4: The 360px curator events header (#28)**

`apps/mobile/app/(curator)/events/index.tsx:491-494`: the "Ticketed events" header is a non-wrapping `flexDirection: "row"` holding an 18px Syne title and two 44px buttons, and the title `Text` has no `flex`. Add `flexWrap: "wrap"` and `rowGap: tokens.space.sm` to the row and `style={{ flexShrink: 1 }}` to the title, so at 360px the buttons drop to their own line instead of pushing the title off the edge. Do the same to the "Past & closed" and "Series" header rows if they carry the same non-wrapping shape.

- [ ] **Step 5: Verify and commit**

`pnpm --filter @gatekeep/mobile typecheck`, `lint`, `expo export --no-bytecode`. Contrast and 360px are owner-smoked on a device (spec section 9); the gate here is that nothing regressed in the bundle.

```bash
git add apps/mobile/src apps/mobile/app
git commit -m "fix(mobile): AA-safe ember text, undimmed disabled-tier reasons, 44px targets, and a wrapping events header"
```

---

### Task 16: Web tap targets, forms, labels, and visible disabled reasons (#20, #21, #22, #27)

**Files:**
- Modify: `apps/web/src/ui/button.tsx`, `apps/web/app/sign-in/SignInForm.tsx`, `apps/web/app/join/page.tsx`, `apps/web/app/admin/page.tsx`, `apps/web/src/curator/CuratorForms.tsx`, `apps/web/src/portfolio/PortfolioForms.tsx`, `apps/web/src/portfolio/TrimUploader.tsx`, `apps/web/src/gigs/GigForms.tsx`, `apps/web/src/events/EventEditor.tsx`, `apps/web/src/payments/EarningsPanel.tsx`, `apps/web/src/bookings/BookingThread.tsx`

**Interfaces:**
- Consumes: nothing new. `PAYOUT_INSTANT_INELIGIBLE_MESSAGE` and the other payout sentences are already imported where Step 4 needs them.
- Produces: `buttonVariants` sizes gain a coarse-pointer minimum height, which every `Button` on both touch and mouse inherits. Nothing else changes shape.

- [ ] **Step 1: 44px on touch (#20)**

`apps/web/src/ui/button.tsx`: `default` is `h-10` (40px), `sm` is `h-9` (36px), `icon` is `size-10` (40px); only `lg` reaches 44. Add a coarse-pointer bump to the base class string rather than changing the desktop heights (a 44px default on a mouse pointer would make every dense admin row taller):

```ts
const buttonVariants = cva(
  // SP12 follow-on (audit #20, R-03). The coarse-pointer variant lifts every
  // size to the 44px minimum on touch while leaving the mouse heights alone:
  // a phone or tablet gets the target, a desktop keeps the density. Tailwind
  // 4's `pointer-coarse:` variant maps to @media (pointer: coarse).
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-sora text-sm font-medium outline-none transition-colors pointer-coarse:min-h-11 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 focus-visible:ring-2 focus-visible:ring-gk-focus",
```

and give the `icon` size `pointer-coarse:size-11` so an icon-only control stays square at 44. Verify the `pointer-coarse:` variant exists in this Tailwind 4 install (`grep -rn "pointer-coarse" apps/web` and, if it does not resolve, add the equivalent `@media (pointer: coarse)` rule in `apps/web/app/globals.css` scoped to `[data-slot="button"]`, which `Button` already sets). The `TierPicker` steppers (`src/events/TierPicker.tsx:72-90`, `size="icon"`) and every `size="sm"` chip inherit this with no per-site edit.

- [ ] **Step 2: Real forms so Enter submits (#21)**

There is no `<form>` element anywhere in `apps/web` today (grep confirmed). Wrap:

- `apps/web/app/sign-in/SignInForm.tsx:131-243`: the email and password inputs plus the primary action become `<form onSubmit={(e) => { e.preventDefault(); if (!busy) void emailAuth(); }}>` with the primary `Button` changed from `type="button"` to `type="submit"`. The Google and Apple buttons and the two `variant="link"` toggles stay `type="button"` inside the form so they never submit it.
- `apps/web/app/join/page.tsx:159-190`: the same treatment around its own fields and primary action.
- `apps/web/src/bookings/OfferComposer.tsx`: its composer fields become a form with a `type="submit"` primary.

Task 6's messaging composer and Task 8's comment composers already ship as real forms, so this item is closed across the app once these three land.

- [ ] **Step 3: Every input gets an associated label (#22)**

Each site below is an `Input` or `Textarea` whose only label is a placeholder, or a `<label>` with no `htmlFor`. Fix with `id` plus `htmlFor` (the pattern `EventEditor.tsx:399-414` already uses) where a visible label is wanted, and `aria-label` where the surrounding heading already names the field:

- `apps/web/app/admin/page.tsx:1378` (the `@handle` takedown lookup) and the user-lookup email/name input: `aria-label="Profile handle"` and `aria-label="Email or name"`
- `apps/web/src/curator/CuratorForms.tsx:47` (About textarea), `:98` (Street address), `:175` (looking-for notes), `:276` (amenity notes): visible `<label htmlFor>` on each, matching the "City" field at `:109-110` that already does it right
- `apps/web/src/portfolio/PortfolioForms.tsx` (bio, link URL, rate amount, rate note): the rate fields' label is a sibling `<span>` today, so give it `htmlFor` and the input an `id`
- `apps/web/src/gigs/GigForms.tsx` (provisions notes)
- `apps/web/src/portfolio/TrimUploader.tsx` (Track title)
- `apps/web/src/events/EventEditor.tsx` (Act name; the two sale-window inputs whose `<label>` carries no `htmlFor`; the cancel-reason textarea)

Re-grep each file for `placeholder=` on an `Input`/`Textarea` and confirm every remaining one also has an `id` with a matching `htmlFor`, or an `aria-label`, before calling this done.

- [ ] **Step 4: Disabled reasons as visible text (#27)**

A reason living only in a `title` attribute is unreachable by keyboard on a disabled control and by touch anywhere. Mobile already renders the same reasons as visible lines (`apps/mobile/src/payments/EarningsPanel.tsx:371`, `apps/mobile/src/bookings/BookingThread.tsx:358,525`). Match it:

- `apps/web/src/payments/EarningsPanel.tsx:340` (why Instant is disabled): drop the `title` and render the same sentence as an adjacent `<p className="font-sora text-xs text-gk-muted">` under the button whenever it is disabled
- `apps/web/src/bookings/BookingThread.tsx:552`, `:614`, `:734`, `:754`: drop each `title` and render its text ("Disabled: you're on both sides of this booking", and `THREAD_FULL_MESSAGE` at `:614`) as a muted line beside the control, once per action group rather than once per button so the same sentence does not repeat three times in a row

- [ ] **Step 5: Verify and commit**

`pnpm --filter @gatekeep/web typecheck`, `lint`, `build`, and live-load `/sign-in`, `/join`, `/admin`, and a booking thread (HANDOFF tripwire 4). Confirm `grep -rn "title={" apps/web/src | grep -v "SheetTitle\|DialogTitle\|CardTitle"` returns nothing that carries a user-facing explanation.

```bash
git add apps/web/src apps/web/app
git commit -m "fix(web): 44px touch targets, real forms so Enter submits, labelled inputs, and visible disabled reasons"
```

---

### Task 17: Mobile screen-reader roles, modal focus, and reduced motion (#23, #24, #25)

**Files:**
- Create: `apps/mobile/src/theme/useReducedMotion.ts`
- Modify: `apps/mobile/src/ui/Skeleton.tsx`, `apps/mobile/src/ui/Sheet.tsx`, `apps/mobile/src/bookings/GigBrowse.tsx` (if present) or its successor, `apps/mobile/src/shell/ContextSwitcher.tsx`, `apps/mobile/app/(curator)/events/index.tsx`, `apps/mobile/app/(curator)/events/series/[seriesId].tsx`, `apps/mobile/src/bookings/BookingInbox.tsx`, `apps/mobile/src/bookings/PaymentStatus.tsx`, `apps/mobile/src/shell/NotificationsList.tsx`, `apps/mobile/src/curator/CuratorForms.tsx`, `apps/mobile/src/portfolio/PortfolioForms.tsx`, `apps/mobile/src/portfolio/TrackManager.tsx`, `apps/mobile/src/portfolio/TrimUploader.tsx`, `apps/mobile/app/artist/[handle].tsx`, `apps/mobile/src/payments/GatePrompt.tsx`, `apps/mobile/src/payments/DelinquencyBanner.tsx`, `apps/mobile/src/tickets/TicketDetail.tsx`, `apps/mobile/app/event/[eventId].tsx`

**Interfaces:**
- Consumes: `AccessibilityInfo` from `react-native`.
- Produces: `useReducedMotion(): boolean` exported from `apps/mobile/src/theme/useReducedMotion.ts`, hoisted out of `Skeleton.tsx` so every overlay can consult it.

- [ ] **Step 1: Hoist the reduced-motion hook (#25)**

`apps/mobile/src/ui/Skeleton.tsx:17-32` already implements `useReducedMotion` privately (react-native 0.86.2 does not export one, which that file's own comment records). Move it verbatim to `apps/mobile/src/theme/useReducedMotion.ts`, export it, and have `Skeleton.tsx` import it instead of defining it. Keep the existing comment about the missing upstream export.

- [ ] **Step 2: Modals respect reduced motion and trap focus (#24, #25)**

- `apps/mobile/src/ui/Sheet.tsx:29`: `animationType={reduced ? "none" : "slide"}` using the hoisted hook. It already sets `accessibilityViewIsModal`, so nothing else changes there.
- `apps/mobile/src/shell/ContextSwitcher.tsx:26`: `animationType={reduced ? "none" : "fade"}`, and the inner content `View` gains `accessibilityViewIsModal` plus `accessible={false}` so VoiceOver stops wandering behind it; the backdrop `Pressable` at `:30` gains `accessibilityRole="button"` and `accessibilityLabel="Close"`, matching `Sheet`'s own backdrop.
- The bespoke `GigDetailModal` the audit names at `apps/mobile/src/bookings/GigBrowse.tsx:108` lives in a file SP8 replaced. Re-grep for `<Modal` across `apps/mobile` and apply the same three changes (reduced-motion `animationType`, `accessibilityViewIsModal` on the content, a labelled backdrop) to every hit that is not already `src/ui/Sheet.tsx`. If a hit turns out to be gone, record it in the commit message rather than inventing a replacement.

- [ ] **Step 3: A role and a label on every Pressable (#23)**

Every site below is a bare `Pressable` (or an inline `Text onPress`) with no `accessibilityRole` and no `accessibilityLabel`, so a screen reader announces its raw text with no hint that it is operable. Add `accessibilityRole="button"` (or `"link"` for a navigation pseudo-link) plus a label that names the row, or swap the control for the `Button`/`Chip` primitives, which already set both:

- `apps/mobile/app/(curator)/events/index.tsx:43,72,147,501` (gig row, event row, promote, series row)
- `apps/mobile/app/(curator)/events/series/[seriesId].tsx:241`
- `apps/mobile/src/bookings/BookingInbox.tsx:115,133,149`
- `apps/mobile/src/bookings/PaymentStatus.tsx:230,241,275,302` (already becoming `Button`s in Task 15, so verify rather than re-edit)
- `apps/mobile/src/shell/ContextSwitcher.tsx:21,30,32,36,42`
- `apps/mobile/src/shell/NotificationsList.tsx:65`, whose label also carries the unread marker Task 19 adds
- `apps/mobile/src/curator/CuratorForms.tsx:275`, `apps/mobile/src/portfolio/PortfolioForms.tsx:124`, `apps/mobile/src/portfolio/TrackManager.tsx:101,104,116,119`, `apps/mobile/src/portfolio/TrimUploader.tsx:303,306,309`
- `apps/mobile/app/artist/[handle].tsx:314`
- the inline `Text onPress` pseudo-links at `apps/mobile/src/payments/GatePrompt.tsx:94,102,171`, `apps/mobile/src/payments/DelinquencyBanner.tsx:55`, `apps/mobile/src/tickets/TicketDetail.tsx:98`, and the lineup names in `apps/mobile/app/event/[eventId].tsx`, all of which get `accessibilityRole="link"`

Tasks 15 and 17 touch several of the same lines; run them in this order (15 first) or, if they run in parallel, treat the `Button` swaps as Task 15's and the roles on what remains as Task 17's, and re-grep before each edit.

- [ ] **Step 4: Verify and commit**

`pnpm --filter @gatekeep/mobile typecheck`, `lint`, `expo export --no-bytecode`. Confirm `grep -rn "<Pressable" apps/mobile/src apps/mobile/app | wc -l` matches the count of `accessibilityRole` occurrences in the same files, allowing for the primitives that set it internally.

```bash
git add apps/mobile/src apps/mobile/app
git commit -m "fix(mobile): roles and labels on every Pressable, modal focus containment, and reduced-motion overlays"
```

---

### Task 18: The unread marker and the overflow hygiene fix (#26, #29)

**Files:**
- Modify: `apps/web/app/dashboard/page.tsx`, `apps/mobile/src/shell/NotificationsList.tsx`, `apps/web/app/globals.css`

**Interfaces:**
- Consumes: `UNREAD_MARKER_LABEL` from `@gatekeep/shared` (Task 1).
- Produces: nothing exported. Both platforms carry a text unread marker beside the existing visual one.

- [ ] **Step 1: The web marker (#26)**

`apps/web/app/dashboard/page.tsx:207-211` marks an unread notification with an `aria-hidden` ember dot plus a font-weight change, both visual-only channels. Keep the dot and add the text marker the spec asks for:

```tsx
      <span
        className={cn("mt-1.5 size-2 shrink-0 rounded-full bg-gk-accent", n.read && "invisible")}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className={cn("block font-sora text-sm font-semibold", n.read ? "text-gk-muted" : "text-gk-text")}>
          {/* SP12 follow-on (audit #26): "New" is a real text channel beside
              the dot and the weight change, so unread is not carried by
              colour and opacity alone. Rendered for screen readers and on
              screen: a small muted-accent pill reads at a glance and does
              not add a second ember to the row (the dot already is one, and
              the pill reuses it rather than introducing another). */}
        {!n.read && (
          <span className="mr-2 rounded-gk-sm bg-gk-accent/14 px-1.5 py-0.5 align-middle font-sora text-[11px] font-medium text-gk-focus">
            {UNREAD_MARKER_LABEL}
          </span>
        )}
        {n.title}
        </span>
```

Import `UNREAD_MARKER_LABEL` and `cn` where the file already does.

- [ ] **Step 2: The mobile marker (#26)**

`apps/mobile/src/shell/NotificationsList.tsx:65` marks read rows with `opacity: 0.5` only. Drop the opacity in favour of `Text muted` on a read row's title, and for an unread row render a `Badge label={UNREAD_MARKER_LABEL}` before the title plus `accessibilityLabel={\`${UNREAD_MARKER_LABEL}, ${item.title}\`}` on the `Pressable` (Task 17 is adding the role and label to this same `Pressable`, so this step supplies the label's text and that task supplies the role). A read row's `accessibilityLabel` is just the title.

- [ ] **Step 3: Remove the overflow mask (#29)**

`apps/web/app/globals.css:93` carries `html { overflow-x: hidden }`, which masks real horizontal overflow instead of surfacing it (the 9A ledger already recorded it as hygiene). Remove the declaration and the "No overflow-x here" comment on `body` at `:97` that only exists to explain it.

Then walk the pages the audit's responsiveness section names, at 360px, and fix anything that now scrolls sideways by making the offending row wrap or by putting the wide content in its own `overflow-x-auto` container (the treatment `apps/web/app/admin/page.tsx:912-913` already uses for its tables). The audit's own verified-clean list says admin tables, money badges, the sticky buy bar, the mini-player, chat bubbles, and the mobile sheet are already handled, so the likely finds are new: Task 8's comment action rows and Task 6's message list, both of which this plan already specifies as wrapping. Record in the commit message which pages were checked. If a page cannot be made to fit without a redesign, restore the declaration scoped to that one route's wrapper (never on `html`) and say so in the commit message rather than leaving a global mask.

- [ ] **Step 4: Verify and commit**

`pnpm --filter @gatekeep/web typecheck`, `lint`, `build`; `pnpm --filter @gatekeep/mobile typecheck`, `lint`, `expo export --no-bytecode`. The 360px pass is a manual browser check at that width on `/`, `/dashboard`, `/gigs`, `/e/{eventId}`, `/tickets`, `/search`, `/discover`, `/admin`, and `/dashboard/messages`.

```bash
git add apps/web/app/dashboard/page.tsx apps/web/app/globals.css apps/mobile/src/shell/NotificationsList.tsx
git commit -m "fix: text unread markers on both inboxes, and drop the global overflow-x mask"
```

---

### Task 19: Web dialog primitives replace the last native dialogs (L70)

**Files:**
- Create: `apps/web/src/ui/confirm-dialog.tsx`, `apps/web/src/ui/prompt-dialog.tsx`
- Modify: `apps/web/app/admin/page.tsx`, `apps/web/app/dashboard/page.tsx`, `apps/web/app/dashboard/curator/[profileId]/page.tsx`, `apps/web/app/dashboard/curator/[profileId]/gigs/[gigId]/page.tsx`, `apps/web/app/dashboard/curator/[profileId]/series/[seriesId]/page.tsx`, `apps/web/app/dashboard/portfolio/[profileId]/page.tsx`, `apps/web/src/bookings/BookingThread.tsx`, `apps/web/src/curator/CuratorForms.tsx`, `apps/web/src/portfolio/PortfolioForms.tsx`, `apps/web/src/portfolio/TrackManager.tsx`, `apps/web/src/events/AttendeeList.tsx`

**Interfaces:**
- Consumes: `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter` (`src/ui/dialog.tsx`, Radix, so Escape and the focus trap come free); `Input`, `Button`, `ErrorBox`; `DIALOG_CONFIRM_LABEL`, `DIALOG_CANCEL_LABEL` from `@gatekeep/shared` (Task 1).
- Produces: `useConfirm(): { confirm: (opts: ConfirmOptions) => Promise<boolean>; dialog: ReactNode }` and `usePrompt(): { prompt: (opts: PromptOptions) => Promise<string | null>; dialog: ReactNode }`, where `ConfirmOptions = { title: string; body?: string; confirmLabel?: string; destructive?: boolean }` and `PromptOptions = { title: string; label: string; initialValue?: string; maxLength?: number }`. A caller renders `{dialog}` once and awaits the function, so every `if (!window.confirm(x)) return;` becomes `if (!(await confirm({ title: x }))) return;` with the same control flow.

- [ ] **Step 1: The confirm dialog**

`apps/web/src/ui/confirm-dialog.tsx` holds a `useState` for the pending options plus a `useRef` for the resolve function. `confirm(opts)` sets the options and returns a promise; the dialog's confirm button resolves `true` and closes, Cancel and `onOpenChange(false)` resolve `false`. Content: `DialogTitle` from `opts.title`, `DialogDescription` from `opts.body` when given, a `DialogFooter` with `Button variant="secondary"` labelled `DIALOG_CANCEL_LABEL` and a primary labelled `opts.confirmLabel ?? DIALOG_CONFIRM_LABEL`, with `variant="destructive"` when `opts.destructive`. A comment records why this is a hook rather than a component with an `onConfirm` prop: every call site today is an imperative `if (!window.confirm(...)) return;` inside an async handler, and a promise-returning hook keeps that control flow identical, so the conversion is mechanical and cannot silently change which branch runs.

- [ ] **Step 2: The prompt dialog**

`apps/web/src/ui/prompt-dialog.tsx` is the same shape with an `Input` (`id` plus a real `<label htmlFor>`, per Task 16's rule) seeded from `opts.initialValue`, wrapped in a `<form onSubmit>` so Enter confirms, resolving the trimmed value or `null` on cancel or an empty submit.

- [ ] **Step 3: Convert every native dialog site**

There are eleven files. For each, add the hook, render `{dialog}` once in the component's JSX, and convert:

- `apps/web/app/admin/page.tsx:279` (`window.alert`) becomes an `ErrorBox` line in the panel's existing error state (the file already has one at `:154`), not a dialog: an alert is a message, not a decision
- `apps/web/app/dashboard/curator/[profileId]/gigs/[gigId]/page.tsx:271` (confirm) and `:276` (alert): confirm becomes `useConfirm` with `destructive: true`; the alert becomes an `ErrorBox`
- `apps/web/app/dashboard/curator/[profileId]/page.tsx:137` (confirm) and its neighbouring alert path
- `apps/web/app/dashboard/curator/[profileId]/series/[seriesId]/page.tsx:226`, `:237` (two confirms) and `:231`, `:242` (two alerts)
- `apps/web/app/dashboard/page.tsx:349` (the delete-account confirm, `destructive: true`)
- `apps/web/app/dashboard/portfolio/[profileId]/page.tsx:181` (alert), `:188` (confirm)
- `apps/web/src/bookings/BookingThread.tsx:444`, `:455` (decline, withdraw)
- `apps/web/src/curator/CuratorForms.tsx:30,71,75,144,214,220,324` (alerts, all of which become the file's own inline error line) and `:315` (the remove-photo confirm)
- `apps/web/src/portfolio/PortfolioForms.tsx:32,79,91,147,280,293,432,439` (alerts, same treatment)
- `apps/web/src/portfolio/TrackManager.tsx:46` (alert), `:110` (the rename `window.prompt`, which becomes `usePrompt` with `label="New title"` and `initialValue={t.title}`), `:124` (the delete confirm)
- `apps/web/src/events/AttendeeList.tsx:73` (the grace-refund confirm, `destructive: true`; this one is money-adjacent UI, so the dialog's body must keep the existing sentence verbatim, including "This can't be undone.")

Every converted alert keeps its exact existing sentence; no copy changes in this task except the two new dialog button labels.

- [ ] **Step 4: Verify and commit**

`grep -rn "window.confirm\|window.alert\|window.prompt" apps/web --include=*.tsx --include=*.ts` returns only comment lines (`apps/web/app/admin/page.tsx:35,115` describe the historical flow and stay). Then `pnpm --filter @gatekeep/web typecheck`, `lint`, `build`, and live-load one page per converted file group (HANDOFF tripwire 4).

```bash
git add apps/web/src/ui/confirm-dialog.tsx apps/web/src/ui/prompt-dialog.tsx apps/web/src apps/web/app
git commit -m "fix(web): shared confirm and prompt dialogs replace the last native browser dialogs (L70)"
```

---

### Task 20: Ledger rows L64, L68, L79

**Files:**
- Modify: `apps/web/src/payments/TrueUpForm.tsx`, `apps/mobile/src/payments/TrueUpForm.tsx`, `apps/web/src/bookings/BookingInbox.tsx`, `apps/mobile/src/bookings/BookingInbox.tsx`, `apps/mobile/app/(curator)/events/index.tsx`

**Interfaces:**
- Consumes: `TRUE_UP_WHOLE_NUMBERS_MESSAGE`, `SHOW_MORE_LABEL` from `@gatekeep/shared` (Task 1); `SERIES_STATUS_TONE` from `apps/mobile/src/gigs/GigForms.tsx`.
- Produces: nothing exported. Three recorded ledger rows close.

- [ ] **Step 1: L64, the true-up form stops rounding**

Both platforms compute `const parsedValue = Math.round(Number(trimmed));` and then check `Number.isInteger(parsedValue)`, which is always true, so "3.5" silently becomes 4 (`apps/web/src/payments/TrueUpForm.tsx:60-61`, `apps/mobile/src/payments/TrueUpForm.tsx:49-50`). Replace both with:

```ts
  // L64: parse without rounding, so a fractional entry is REFUSED rather
  // than silently changed into a different number of minutes or songs. The
  // server (confirmOccurrenceActuals) has always required an integer; this
  // only stops the client from quietly inventing one on the user's behalf.
  const parsedValue = Number(trimmed);
  const isWholeNumber = trimmed !== "" && Number.isFinite(parsedValue) && Number.isInteger(parsedValue);
  const inputShapeOk = isWholeNumber && parsedValue >= 0;
```

and add, in each file's validation-message chain (beside the existing over-cap and below-current messages), a branch rendering `TRUE_UP_WHOLE_NUMBERS_MESSAGE` when `trimmed !== "" && Number.isFinite(parsedValue) && !Number.isInteger(parsedValue)`. Nothing else in either file changes; no callable, no money math, no server path.

- [ ] **Step 2: L68, the booking inbox pages past 50**

`apps/web/src/bookings/BookingInbox.tsx:333`, `:342`, `:352` cap the three lists at `limit(50)`, `limit(50)`, and `limit(20)` with no way past them; the mobile twin does the same at `:176`, `:185`, `:195`. Add paging to each of the three sections on both platforms: hold a `pageSize` state seeded at the current cap, render a `Button variant="secondary"` labelled `SHOW_MORE_LABEL` under a section whose row count equals its current `pageSize`, and on press add the same increment again, which re-runs the listener's effect with the larger `limit`. Growing the live listener's limit (rather than a separate `startAfter` fetch) keeps every row live, which is what an inbox needs, and it is the same approach the sections already imply by using `onSnapshot` at all. Record that reasoning in a comment on the web file and reference it from the mobile one.

- [ ] **Step 3: L79, the series badge tone**

`apps/mobile/app/(curator)/events/index.tsx:547` renders `<StatusBadge label={SERIES_STATUS_LABEL[s.status]} status="neutral" />`, while the series detail screen already uses the real map (`apps/mobile/app/(curator)/events/series/[seriesId].tsx:221`). Change it to `status={SERIES_STATUS_TONE[s.status]}` and add `SERIES_STATUS_TONE` to this file's import from `../../../src/gigs/GigForms` (confirm the relative path from this file before editing).

- [ ] **Step 4: Verify and commit**

`pnpm --filter @gatekeep/web typecheck`, `lint`, `build`; `pnpm --filter @gatekeep/mobile typecheck`, `lint`, `expo export --no-bytecode`.

```bash
git add apps/web/src/payments/TrueUpForm.tsx apps/mobile/src/payments/TrueUpForm.tsx apps/web/src/bookings/BookingInbox.tsx apps/mobile/src/bookings/BookingInbox.tsx "apps/mobile/app/(curator)/events/index.tsx"
git commit -m "fix: refuse fractional true-up values, page the booking inbox, and tone the series badge (L64, L68, L79)"
```

---

### Task 21: README, HANDOFF, ledger updates, and the gate counts

**Files:**
- Modify: `README.md`, `docs/superpowers/HANDOFF.md`, `anti-slop/audit-001-2026-09-01.md`, `docs/superpowers/audit/inheritance-sp7-sp8-5c.md`

- [ ] **Step 1: README**

Add a "Sub-project 12 launch checklist (messaging and comments)" after the sub-5c one: deploy the three composite indexes (`conversations (participants array-contains, lastMessageAt desc)`, `comments (hidden, at desc)`, `reports (status, createdAt desc)`) and confirm each reads "Enabled" on the real project; confirm the two new push kinds (`message`, `comment_reply`) route on a real device; decide and record the abuse-response runbook (who watches `/admin` Reports and how fast). Add a "Sub-project 12 smoke checklist": send and receive across two accounts on both platforms, block and unblock from each side, report and resolve from `/admin`, comment and reply on a published show, hide as the curator and as an artist, delete as the author, react with Going and heart a lineup post, the mobile unread badge, and the accessibility pass (a screen reader on each platform, keyboard-only on web, 360px width, reduced motion on). Add the two new collections (`conversations`, `reports`) and the three new subcollections to whatever collection inventory the README keeps.

- [ ] **Step 2: HANDOFF**

- Add "12. Messaging, fan comments, and the follow-ons (`sp12-rulings.md`): ..." to the merged list.
- Replace the Roadmap's **Messaging** bullet and the **Follow-on if wanted** bullet with a line saying both shipped in sub-project 12 and that the mobile Messages tabs are real screens.
- Add standing tripwires: 11, "`conversations/{pairId}` is `{musicianProfileId}__{curatorProfileId}` and every write goes through `messaging.ts`; a new reader must use `conversationPairId`, never string-concatenate the id"; 12, "an admin can read a conversation only while `openReports > 0`, so any new admin surface over chat must go through a report, not a direct query".
- Update the Owner-owed table with the three index confirmations and the sub-12 device smoke.
- Update the gates line with the measured counts (today: `pnpm typecheck` 5/5, shared tests 212, web tests 14, `pnpm emu:test` 936 across 58 files, `pnpm emu:rules` 140 across 9 files; this sub-project adds three functions test files, one rules test file, and shared cases).

- [ ] **Step 3: Close the audit and ledger rows**

- In `anti-slop/audit-001-2026-09-01.md`, add a short "Status after sub-project 12" line under each of findings 10 to 29 saying which task closed it, and for the parts this plan found already closed (finding 13's `(fan)/index.tsx` half, finding 16's `GigBrowse`/`MusicianBrowse` half) say so explicitly with the reason.
- In `docs/superpowers/audit/inheritance-sp7-sp8-5c.md`, mark L64, L68, L70, and L79 resolved with the sub-12 task that closed each, and change L63's status from "open" to "resolved in code": `startsSoonFlash` exists on mobile today (`apps/mobile/src/bookings/BookingThread.tsx:258`, rendered at `:499`), so the row was stale.

- [ ] **Step 4: Run every gate and record the counts**

`pnpm typecheck`, `pnpm --filter @gatekeep/shared test`, the web test suite, `pnpm emu:test` through the detached runner, `pnpm emu:rules`, web lint and build, mobile lint and `expo export --no-bytecode`. Write the measured numbers into the HANDOFF gates line.

```bash
git add README.md docs/superpowers/HANDOFF.md anti-slop/audit-001-2026-09-01.md docs/superpowers/audit/inheritance-sp7-sp8-5c.md
git commit -m "docs: sub-project 12 launch and smoke checklists, handoff update, audit and ledger closures"
```

---

## Self-review

### 1. Spec coverage

| Spec section | Requirement | Task |
|---|---|---|
| 2 | Conversations between a musician and a curator profile, either side starts, every member reads and replies, fans excluded | 3 (server), 6, 10 (clients) |
| 2 | Chat separate from the terms-only booking thread; the booking screen links into it | 7 (web), 11 (mobile) |
| 2 | Abuse posture: per-pair block by either side's admins, report, server caps, admin Reports panel scoped to reported conversations | 3 (block, cap), 5 (reports), 2 (the admin read disjunct), 9 (panel) |
| 2 | Fans comment and react on public show pages; curator and booked or accepted-tagged artists reply and hide; fans report | 4 (server), 8, 12 (clients), 5 (report) |
| 3.1 | Web `/dashboard/messages`: list left, thread right, switcher, bubbles, composer with a 1000-character counter, header menu, blocked states | 6 |
| 3.1 | Mobile: the two coming-soon tabs become a list and a thread screen; the tab shows an unread badge | 10 (screens), 11 (badge) |
| 3.1 | Entry points on the web venue and curator pages, the mobile venue screen, curator search results, the artist page on both, and the booking screen on both; hidden with no eligible profile; a sheet with several | 7 (web), 11 (mobile) |
| 3.1 | `message` notification kind, `refId` the conversation, preview body, one per conversation per recipient profile per 10 minutes, `notificationHref` routing | 1 (types, route), 3 (fan-out and dedupe), 11 (push narrowing) |
| 3.2 | Reaction row and comment list on the public event page, under the lineup and above tickets; hearts on lineup posts | 8 (web), 12 (mobile) |
| 3.2 | Who may comment, reply, hide, delete, report; the Curator and Artist tags | 4 (server role derivation and authority), 8, 12 (rendering) |
| 3.2 | Rendering: name, time, text, one-level Reply quoting the parent, "Hidden by {who}" for admins, closed composer on a cancelled or taken-down event, 20 a page with Show more | 8, 12 |
| 3.2 | `comment_reply` notification on a curator or artist reply to a fan; none for fan-to-fan; reactions never notify | 1 (route), 4 (fan-out) |
| 3.3 | `/admin` Reports panel: open reports, reporter, reason, target, time; open the reported conversation read-only; hide the comment; an admin note through `flagAccount`; resolve, and resolved rows leave | 9 |
| 3.4 listeners and states | #10 to #16 | 13 (web), 14 (mobile) |
| 3.4 empty state | #14 | 13 |
| 3.4 contrast and targets | #17, #18, #19, #20, #28 | 15 (mobile), 16 (web #20) |
| 3.4 forms and accessibility | #21, #22, #23, #24, #25, #27 | 16 (web), 17 (mobile) |
| 3.4 unread | #26 | 18 |
| 3.4 overflow | #29 | 18 |
| 3.4 ledger | L64, L68, L70, L79, L63 check | 20 (L64, L68, L79), 19 (L70), 21 (L63 row update) |
| 4 | Data model: conversations, messages, reports, comments, reactions, post hearts, the two `EventDoc` counters, `NotificationDoc.kind`, `notificationHref` | 1 |
| 4 | Rules and the three indexes | 2 |
| 5 | `sendMessage`, `markConversationRead`, `setConversationBlock` | 3 |
| 5 | `reportConversation`, `reportComment`, `resolveReport` | 5 |
| 5 | `postComment`, `hideComment`, `deleteComment`, `setGoing`, `setPostHeart` | 4 |
| 5 | The event cascade does not delete comments; the composer closes on the client by event status | 4 (no cascade change), 8, 12 (client close) |
| 6 | Final copy, every string | 1 (constants), consumed verbatim by 6 to 12 and 16 to 20 |
| 7 | Emulator, rules, shared, and client gates | 3, 4, 5 (emulator), 2 (rules), 1 (shared), every client task |
| 9 | Owner-owed smoke list | 21 |

**Gaps found and closed inline:** none of the spec's numbered requirements is unowned. Two narrowings are recorded in code comments rather than dropped: the message bubble shows the sender's profile name and only the viewer's own member display name (rules make another account's `users/{uid}` unreadable), and the admin note action ships for comment reports only (a conversation report carries no offender uid). Both are named in Tasks 6 and 9 and belong in the rulings doc.

**Spec ambiguities resolved:**
- Section 5 both names the send cap "per sender profile" and suggests keeping the rolling window on the conversation doc. The two cannot both hold, and the cap wins (controller ruling, 2026-09-05): 30 per 10 minutes per sender profile **across every conversation**, stored in a server-only `messageWindows/{profileId}` doc read and trimmed inside `sendMessage`'s own transaction. Keeping it on the conversation would have cost one read fewer and let a spammer buy a fresh 30 from every venue in town. Task 3 owns the code, Task 2 the rules, and this belongs in the rulings doc.
- The comment cap needs a store the spec does not name: `commentWindows/{uid}`, server-only, the same shape and posture as `messageWindows` and `geocodeBudgets`, because the cap is per user across events and no doc the write already touches spans events.
- Section 6 carries one rate sentence, so the comment cap reuses `MESSAGE_RATE_MESSAGE` verbatim rather than inventing a second.
- `notificationHref` cannot learn the recipient profile's type from `(kind, refId, platform)` alone, so `NotificationDoc.refKind` gains `"musician" | "curator"` to pick the mobile tab group, matching how `saved_search_match` already branches on `refKind`.

### 2. Audit and ledger item to task, with verified-closed rows

Every claim below was re-read against this tree on 2026-09-05.

| Item | Status today | Task |
|---|---|---|
| #10 web listeners with no error callback | open, all named sites still bare (`AttendeeList.tsx:38`, `TicketsClient.tsx:49`, `TrackManager.tsx:38`, plus the admin, dashboard, events, gigs, series, portfolio sites) | 13 |
| #11 mobile "null means loading" sentinel | open, every named screen still `useState(null)` with a `null`-setting error callback | 14 |
| #12 mobile listeners with no error callback | open, all six named sites bare; `TrackManager.tsx:42` and `portfolio.tsx:189` log only | 14 |
| #13 error reads as empty | partly open: `TicketList.tsx:51` and the six `BookingInbox` callbacks still set `[]`. **Verified closed, no task: the `(fan)/index.tsx:26-33` half.** SP7 Task 12 replaced that file with a one-line `DeckScreen` wrapper; there is no listener left to fix | 13, 14 |
| #14 web zero-tier empty state | open, no such string in `BuyTicketsFlow.tsx` | 13 |
| #15 bare loading text and sign-in busy state | partly open: `dashboard/page.tsx:342`, `join/page.tsx:73`, `admin/page.tsx:1535`, `gigs/[gigId]/page.tsx:65`, `OfferComposer.tsx:92`, `BookingThread.tsx:218` (mobile), `EarningsPanel.tsx:299` (mobile), `PaymentStatus.tsx:226`, `event/[eventId].tsx:544,560`, `ScannerScreen.tsx:172`, and the three sign-in buttons with no `loading`. **Several web loaders the audit named are already skeletons with `role="status"`** (`dashboard/page.tsx:76`, `TicketsClient.tsx:208`, `curator/[profileId]/page.tsx:51`, `portfolio/[profileId]/page.tsx:66`) and are not re-opened | 13, 14 |
| #16 mobile empty-state copy parity | partly open: `BookingInbox` (3), `EarningsPanel:131`, `NotificationsList:62`, `events/index.tsx` (3) still terse. **Verified closed, no task: the `GigBrowse.tsx` and `MusicianBrowse.tsx` halves.** SP8 deleted both files on both platforms | 14 |
| #17 ember text on mobile light surfaces | open, `sign-in.tsx:126` and `events/index.tsx:56` still `t.accent` | 15 |
| #18 disabled tier rows dim the reason | open, `event/[eventId].tsx:210` still `opacity: canPick ? 1 : 0.55` on the whole card | 15 |
| #19 mobile 44px targets | open, `Chip.tsx` still `paddingVertical: 6`; every named bare `Pressable` still bare | 15 |
| #20 web 44px on touch | open, `button.tsx` sizes are still `h-10`, `h-9`, `size-10`, `h-11` | 16 |
| #21 web sign-in has no form | open, `grep -rn "<form" apps/web` returns nothing | 16 |
| #22 web unassociated labels | open, `CuratorForms.tsx:47,98,175,276`, `admin/page.tsx:1378`, and the portfolio, gig, uploader, and event-editor sites still placeholder-only | 16 |
| #23 mobile Pressables without a role or label | open across every named file | 17 |
| #24 bespoke modals without `accessibilityViewIsModal` | open; only `src/ui/Sheet.tsx:39` sets it. `GigBrowse.tsx`'s modal is in a file SP8 removed, so Task 17 re-greps for `<Modal` rather than trusting the path | 17 |
| #25 mobile modals ignore reduced motion | open; `AccessibilityInfo` appears only in `Skeleton.tsx` | 17 |
| #26 unread by one visual channel | open on both platforms (`dashboard/page.tsx:209` dot only, `NotificationsList.tsx:65` opacity only) | 18 |
| #27 disabled reasons only in `title` | open, `BookingThread.tsx:552,614,734,754` and `EarningsPanel.tsx:340` | 16 |
| #28 curator events header clips at 360px | open, the row at `events/index.tsx:491` still has no `flexWrap` and the title no `flexShrink` | 15 |
| #29 `html { overflow-x: hidden }` | open, `globals.css:93` | 18 |
| L63 mobile grace-period flash warning | **verified closed, no task.** `startsSoonFlash` is on mobile today (`apps/mobile/src/bookings/BookingThread.tsx:258`, rendered `:499`), matching web `:429`. The ledger row is stale and Task 21 updates it | 21 (doc only) |
| L64 TrueUpForm silently rounds | open on both platforms (`Math.round(Number(trimmed))`) | 20 |
| L68 BookingInbox pagination | open, three `limit()` caps per platform with no Show more | 20 |
| L70 native dialogs in ten web files | open, 35 `window.*` call sites across eleven files (the audit said ten; `AttendeeList.tsx` is the eleventh, added by SP6) | 19 |
| L79 series badge fixed neutral tone | open, `events/index.tsx:547` still `status="neutral"` | 20 |

### 3. Placeholder scan

No "TBD", no "similar to Task N", no "add appropriate handling". Tasks 10, 12, and 11 name their web twin for the CONTRACT (the exported names and the state union) and then restate every load-bearing snippet that differs on mobile primitives, rather than pointing at the other task for the code. Tasks 13 to 17 list every file and the exact change per audit item with the item number beside it, and each instructs a re-grep before editing because several of those tasks touch the same files. The two follow-on tasks that could not verify a path (the `GigBrowse` modal in #24, the `GigBrowse`/`MusicianBrowse` empties in #16) say what to do when the path is gone instead of leaving a dangling instruction.

### 4. Type consistency

- `conversationPairId(musicianProfileId, curatorProfileId)` is defined in Task 1 and called with the musician id first in Tasks 3, 7, and 11; `MessageButton` in both clients orders its two arguments by the TARGET's type, which is the only place the order could invert.
- `ConversationDoc.unread` is `Record<string, number>` in Task 1, written as `unread.{profileId}` in Task 3, and read through `unreadFor(row, profileId)` in Tasks 6, 10, and 11. No caller indexes it directly.
- `MessageWindowDoc` is `{ at: number[] }` in `messageWindows/{profileId}`, written only by `sendMessage`; `commentWindows/{uid}` carries the same `{ at: number[] }` shape and is written only by `consumeCommentBudget`. Neither is readable by any client, and `ConversationDoc` carries no rate field at all.
- The screen-state union is `"loading" | "error" | rows` for lists (Tasks 6, 8, 10, 12, 13) and `Doc | "loading" | "error" | null` for single docs (Task 14). Two unions, each used consistently, and Task 14's is the one `apps/mobile/app/(musician)/portfolio.tsx:72` already established.
- `CommentRole` is `"fan" | "curator" | "artist"` everywhere; `EventCommentDoc.hiddenBy.role` widens it to `CommentRole | "admin"`, which Tasks 8 and 12 both render through the same three-way `who` mapping.
- `deriveCommentRole` returns `{ role, profileId }` in Task 4 and is consumed by `postComment` and `hideComment` in the same file; the clients' `useCommentAuthority` returns the string union plus `"signedOut"` and is never mistaken for the server helper (different name, different module, both documented as hint-only on the client).
- `setGoing` returns `{ going, goingCount }` and `setPostHeart` returns `{ hearted, heartCount }` in Task 4; Tasks 8 and 12 destructure exactly those names.
- `refKind` is widened once, in Task 1, to include `"musician" | "curator"`; Task 3 writes it, `notificationHref` reads it, and Task 11's `pushHref` narrowing lists the same two strings.
- `ListError` (web, Task 13) and `ErrorBanner` (mobile, pre-existing) are deliberately different components with the same job; neither is imported across platforms.
- `SHOW_MORE_LABEL` is defined in Task 1 and used by Tasks 8, 12, and 20; the existing web and mobile `PayoutHistoryList` components already render a literal "Show more" and are left alone (changing them is not in scope and the strings match).

### 5. Sequencing for the controller

**Strictly sequential:** Task 1, then Task 2, then Tasks 3, 4, 5 (each adds callables the clients call; 4 and 5 both read Task 1's types and Task 2's rules, and Task 5's test imports Task 3's `messagingFixtures.ts`). Task 4 must land before Task 5 (the reports test posts a comment); Task 3 must land before Task 5 (the reports test sends a message).

**Parallel after Task 5, on disjoint files:**
- Web messaging: Task 6, then Task 7 (Task 7 imports nothing from Task 6 except the route it links to, so they can also run together if Task 7's implementer is told the route exists).
- Web comments: Task 8. Independent of 6 and 7 (different directories: `src/events`, `src/discover`, `app/e`).
- Web admin: Task 9. Independent of 6, 7, 8 (only `app/admin/page.tsx`).
- Mobile messaging: Task 10, then Task 11 (Task 11 imports `useUnreadTotal` from Task 10, so this pair IS ordered).
- Mobile comments: Task 12. Independent of 10 and 11.

Tasks 6 to 9 (web) and 10 to 12 (mobile) touch no shared file, so the two platform tracks run fully in parallel.

**Follow-ons, after the client tasks that touch the same files:**
- Task 13 (web states) collides with Tasks 6, 8, 9 on `apps/web/app/admin/page.tsx`, `apps/web/app/dashboard/page.tsx`, and `apps/web/src/discover/ShowPosts.tsx`. Run it after all three.
- Task 14 (mobile states) collides with Tasks 10, 11, 12 on `apps/mobile/src/bookings/BookingThread.tsx`, `apps/mobile/src/shell/NotificationsList.tsx`, `apps/mobile/src/discover/ShowPosts.tsx`, and `apps/mobile/app/event/[eventId].tsx`. Run it after all three.
- Tasks 13 and 14 are independent of each other (different apps) and can run in parallel.
- Task 15 (mobile contrast and targets) and Task 17 (mobile roles and motion) overlap on several files. Run 15 first, then 17, and have 17's implementer re-grep: several of its `Pressable` sites become `Button`s in 15 and then need only verification.
- Task 16 (web targets, forms, labels) is independent of 15 and 17 and can run alongside either.
- Task 18 (unread and overflow) touches `apps/web/app/dashboard/page.tsx` (Task 13 also does) and `apps/mobile/src/shell/NotificationsList.tsx` (Tasks 14 and 17 also do). Run it after 13, 14, and 17.
- Task 19 (L70 dialogs) touches eleven web files, several of which Tasks 13 and 16 edit. Run it after both.
- Task 20 (L64, L68, L79) touches `BookingInbox` on both platforms, which Tasks 13 and 14 also edit. Run it after both; it is independent of 19.
- Task 21 last, after every gate has run.

**Pre-flight before dispatch:** copy `functions/.secret.local` into the worktree; run `pnpm --filter @gatekeep/web exec next typegen`; confirm `makePublishedBookingEvent`'s current return shape in `functions/test/discoverFixtures.ts:128` (Task 4 widens it) and `requireProfileAdmin`'s signature in `functions/src/profiles.ts` (Task 3 calls it); confirm `IconChatCircle` and `IconHeart` exist in both `icons.tsx` modules or add them in the first task that needs each.

