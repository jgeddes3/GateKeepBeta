# GateKeep Sub-project 12 (Messaging, fan comments, follow-ons) - Rulings & Handoff

Durable record from sub-project 12, the final sub-project, executed subagent-driven with per-task
reviews (spec compliance then code quality), scoped re-reviews of every fix round, and a
whole-branch final review on the most capable model followed by one fix wave. Mirrors the earlier
rulings docs. This document, like all sub-12 output, contains no em dashes.

Spec: `docs/superpowers/specs/2026-09-05-messaging-and-followons-design.md` (binding authority,
amended five times during execution; the amendments are recorded below)
Plan: `docs/superpowers/plans/2026-09-05-messaging-and-followons.md` (21 tasks)
Gates at merge: see the gates line in `docs/superpowers/HANDOFF.md` (measured on the final tree).

## What shipped

- **Messaging**: a conversation between one musician profile and one curator profile, opened from
  either side, readable and answerable by every member of either profile. The document id is the
  pair, `{musicianProfileId}__{curatorProfileId}`, built only by `conversationPairId`. Callables:
  `sendMessage` (approved profiles, verified email, 1000 characters, 30 per 10 minutes per sender
  profile in `messageWindows/{profileId}`), `markConversationRead`, `setConversationBlock`
  (profile admins; returns `{ ok, blockedByMe }`), `reportConversation`. A blocked pair refuses
  sends with `CONVERSATION_CLOSED_MESSAGE` and the blocked side sees nothing different. Entry
  points: "Message" on the venue and artist pages, curator search rows, and the booking thread on
  both platforms (hidden with no eligible acting profile, straight through with one, a picker with
  several). Web: `/dashboard/messages` split pane with a nav unread badge. Mobile: real Messages
  tabs in both groups with an unread tab badge, `messages/[conversationId]` thread screens, and
  `message` pushes routed by `refKind` (`musician` or `curator`).
- **Fan comments and reactions** on the public show page (`events/{id}/comments`): fans comment
  and reply one level deep (`postComment`, verified email, 500 characters, 10 per 10 minutes per
  user in `commentWindows/{uid}`), curator and artist members reply with a Curator or Artist tag
  and hide (`hideComment`; admins unhide with `hidden: false`), authors delete their own
  (`deleteComment`, refused while hidden or reported with `COMMENT_UNDER_REVIEW_MESSAGE`), fans
  report (`reportComment`). "Going" (`setGoing`, `events/{id}/reactions/{uid}`) and hearts on
  lineup posts (`setPostHeart`, `events/{id}/posts/{postId}/hearts/{uid}`) share a 60 per 10
  minute cap. Counts live on the parent docs (`goingCount`, visible `commentCount`, `heartCount`).
  A reply notifies a fan parent once (`comment_reply`).
- **Admin Reports panel** on `/admin`: open reports newest first, a read-only conversation view
  (readable only while `openReports > 0`), "Hide comment", "Add a note", "Resolve"
  (`resolveReport`, tolerant of a gone target, writes a `report_resolved` audit row). Reports are
  capped at 10 per 10 minutes per user (`reportWindows/{uid}`), deduplicated per reporter and
  target (`already-exists`, shown as `REPORT_DUPLICATE_MESSAGE`), and a resolved report reopened by
  a new reporter keeps its resolution history (`reopenCount`, `lastResolvedBy`, `lastResolvedAt`).
- **Follow-ons** (antislop audit #10 to #29, ledger rows L64, L68, L70, L79): every Firestore
  listener the audit named, and every screen-level listener found since, has an error callback
  and an explicit loading, error, empty, and not-found state, with Retry resetting to loading
  before it resubscribes (the deferred list names the few card-level readers that still fold an
  error into an empty state); a `ListError` line with Retry on web; tap targets at 44px on touch; form labels
  and visible disabled reasons; screen-reader roles, modal focus, and reduced motion on mobile;
  ember text on light surfaces uses the focus token; the 360px header; a text "New" marker beside
  the unread dot; the global overflow-x mask dropped; web confirm and prompt dialogs replace the
  last native dialogs; the true-up form refuses fractional values; the booking inbox pages; the
  series badge uses `SERIES_STATUS_TONE`.

## Load-bearing rulings (read before touching the named area)

1. **A shared conversation doc carries only mutually visible data.** `conversations/{pairId}`
   holds participants, names, the last message preview, and `openReports`. Per-side unread counts
   and `blockedByMe` live on the per-profile mirrors `profiles/{profileId}/conversations/{pairId}`
   (`ConversationRefDoc`), written by the callables in the same transaction
   (`writeConversationMirrors`). Who blocked lives in the server-only
   `conversations/{pairId}/private/state`. The pattern held through three review rounds: every
   attempt to put per-side state on the shared doc leaked read activity or the blocker's identity.
2. **Clients list mirrors, never the top-level collection.** Firestore rules cannot authorize a
   `participants array-contains` list without leaking (resource fields are unbound during list
   evaluation), so the top-level `conversations` list is `if false` for everyone, admins
   included; a client gets the doc by id and lists its own mirror. New readers use
   `conversationPairId`; nobody string-concatenates the id.
3. **Existence oracles are closed.** `markConversationRead`, `setConversationBlock`,
   `sendMessage`, and `reportConversation` parse the pair id before any read, so a missing pair
   and a non-participant both answer `permission-denied`; `resolvePair` checks approval before
   type and folds "missing" into "unapproved". A malformed or foreign deep link on either platform
   (including an id carrying a slash) is validated before any Firestore path is built and renders
   the unavailable state, never a skeleton, a crash, or a stranger's profile.
3a. **The messages listener attaches only once the viewer's mirror exists.** The messages rule
   reads the parent conversation doc, so a listen on a pair that has never been messaged is
   denied (a rules test records this as the intended posture). Both threads therefore render the
   empty state with a live composer until `profiles/{me}/conversations/{pairId}` appears, which
   happens in the same transaction as the first message; `markConversationRead` is not called
   while the mirror is missing. The whole-branch review found this seam after every per-task
   review had passed: the first contact on every pair showed an error and swallowed the first
   bubble.
3b. **The acting profile follows the pair.** With no explicit choice (web "Messaging as") or
   `acting` route param (mobile), a thread opened from a notification or link resolves the acting
   profile to the member profile the pair names, so a dual-role user can open any message
   notification.
4. **Reactions and hearts are never listable.** `reactions/{uid}` and `hearts/{uid}` allow
   `get` by the owner or an admin and no `list`, so nobody can read an attendance graph; counts
   come from the parent docs only. Both need a verified email, refuse closed events and non-live
   posts, and share the 60 per 10 minute cap.
5. **Hidden comments vanish for everyone except admins.** Non-admin queries pin
   `hidden == false` (the `(hidden, at desc)` composite); admins query unpinned and see "Hidden by
   the curator" or "the artist" (the canonical wording on both platforms). `commentCount` counts
   visible comments (hide decrements, delete is guarded). Only admins unhide.
6. **Admins moderate on the Reports panel, not on the show page.** Row-level Hide belongs to
   curator and artist members (`useCommentAuthority`); an admin who is not a member sees Report
   like any fan. Artist members can hide the curator's comments by spec.
7. **Reply threading differs by platform on purpose.** Web nests replies under a parent loaded on
   the same page and shows `COMMENT_DELETED_LINE` when the parent is absent; mobile renders one
   newest-first list and quotes the parent through a single `get`. Both are spec-compliant
   ("quotes the parent"); neither is to be reworked to match the other.
8. **Reports are capped, deduplicated, and reopenable.** The window read sits after the
   duplicate and target-gone checks, so a refused report costs no budget; a reopened report
   refreshes `createdAt` (the panel sorts by it) and archives the prior resolution; `resolveReport`
   writes its audit row after the transaction like every other admin callable. The report path
   tolerates a missing participant profile (a deleted profile has no mirror): filing and
   resolving skip that side's mirror and still update `openReports` on the conversation, so an
   abusive profile deleted by its owner cannot leave a report stuck open or a thread
   admin-readable forever.
9. **Rate windows are server-only documents.** `messageWindows`, `commentWindows`, and
   `reportWindows` have `allow read, write: if false` and are trimmed inside the transaction.
   The per-profile message cap multiplies with a member's profile count (accepted).
10. **Messaging never changes the active identity on mobile.** The thread screens take an
    optional `acting` route param and prefer it over `activeContext`; `MessageButton` passes it
    instead of calling `switchTo`, matching web's page-local "Messaging as".
11. **The search index guard.** `onEventWrittenSearch` skips a rebuild when the projected fields
    and artist inputs are unchanged, so reaction toggles no longer amplify into index writes; a
    stale show doc on an ended event expires through the daily sweep instead.
12. **`GoingButton` renders nothing on a draft or cancelled event** on both platforms; comments
    close with `COMMENTS_CLOSED_MESSAGE` when the event is not `published` or `completed`.

## Spec amendments during execution

- f63d81a: per-profile mirror docs replace the participants composite (Task 2).
- b03e2cf: reactions and hearts owner-only `get`, no `list`; admin top-level conversation list
  `if false` (Task 2 review).
- b300882: block state moves to `private/state`; unread lives only on the mirrors (Task 3 review).
- 9f469ea: reactions need a verified email and share the 60 per 10 minute cap; `setPostHeart`
  refuses non-live posts and closed events; delete refused while hidden or reported; visible
  `commentCount`; admin unhide (Task 4 review).
- 2a41228: the duplicate-report line, the report cap, reopen history, the audit row (Task 5
  review).

## Deferred (recorded, not fixed)

- A web reply whose parent sits on a later page shows `COMMENT_DELETED_LINE` though the parent is
  live (a fallback `get` like mobile's would fix it).
- Web's Reply button is not gated on the event being open (the server refuses the post); mobile
  hides it.
- `otherProfileName` on a mirror is a snapshot that self-heals on the next message; the mobile
  list row does not re-resolve it live (web does).
- The mobile `acting` route param is truthiness-checked only before it becomes a Firestore path
  segment.
- A heart toggled while another row's `refresh()` runs flickers once and settles from the
  callable's return.
- Post-commit `writeAudit` throws to the client after a successful resolve (inherited convention
  across every admin callable).
- The hidden-comment existence oracle behind an unguessable id (accepted).
- `COMMENTS_CLOSED_MESSAGE` and `COMMENT_EVENT_CLOSED_MESSAGE` hold the same string.
- `MessageButton` beside "Offer a gig" in the web `CuratorArtistRow` is a different height.
- The web unread "New" pill and the title are adjacent inline nodes with only a margin between
  them (mobile builds "New, {title}").
- Card-level readers that still fold an error into an empty state: the booking thread's
  occurrence rows and series count (both platforms), web `PaymentsPanel` ("Nothing pending"
  on a failed read), mobile `PaymentStatus`, and the held-shares listener in `SharesCard`.
- The admin conversation view labels bubbles with the raw sender profile id and shows no uid, so
  "Add a note" on a conversation row has nothing to look up beyond the User lookup panel.
- `markConversationRead` also fires after the viewer's own send (one extra callable per send);
  `useUnreadTotal` listens to the whole mirror collection with no limit.
- Account deletion leaves `reactions/{uid}` and `hearts/{uid}` docs and comments with a dangling
  `authorUid` (counts stay correct).
- Web `SearchFaces` stays on its skeleton after a members-read failure (`useMyProfiles` keeps
  `loaded` false on error so no surface silently shows a curator as a fan; only the Messages
  page renders the error with Retry).
- Web `useFollows` exposes an error that no consumer renders (no host UI), so a failed follows
  read shows every artist as not followed for that mount; on the first send into an empty
  thread the mirror lands one round trip before the messages snapshot, so the thread shows the
  skeleton once between the empty state and the first bubble.
- Web `useIsAdmin` does not force a token refresh, so a newly granted admin sees the pinned
  comment query until the token rotates (mobile forces one).
- `PAYOUT_INSTANT_FEE_MESSAGE` lacks the "Use a standard payout" clause its siblings carry; the
  web heart control meets 44px in height only; GatePrompt's "Save a card" button has no explicit
  type; one `useConfirm` per attendee row; `[gigId]`'s three mobile retries share one key; the
  mobile promote picker's loading branch has no Back button.
- `t.focus` measures 4.45:1 on the light page background (the sign-in link; DESIGN.md token);
  ember activity indicators and the transfer icon sit under the 3:1 non-text floor on light;
  ProfileContext and useFollows failures on mobile are silent (fail safe: fan view, "Follow" on
  a followed artist).

## Execution lessons (SDD)

- Parallel implementers in one worktree must commit by pathspec (`git commit -- <own paths>`);
  a plain `git commit` from one implementer swept another's staged fix into its commit (5f19cad
  carries the Task 10 fix under Task 18's message). History was left as is.
- `next dev` and `next build` append a generated "nextjs-agent-rules" block to
  `apps/web/CLAUDE.md` that contains an em dash; revert it before every commit and before the
  merge (CI fails a push with U+2014).
- Privacy reviews on the shared conversation doc paid for themselves three times over; the rule
  "shared docs carry only mutually visible data" should be the first check on any new
  multi-party document.
- Reviewers asked to compare a mobile task against its landed web twin found every copy and
  gating divergence the implementers missed when the two landed concurrently.
- Per-task reviews check a feature against its own brief; the whole-branch review is where the
  rule, the callable, and the client are read as one path. The pre-creation conversation (no
  parent doc yet) passed four task reviews and a rules matrix of ten cases because no single
  task owned "the first message on a new pair"; add a "first use, empty state" case to every
  rules matrix for a new collection.
- The follow-on listener tasks needed two or three fix rounds each: the reviewer's lens
  ("does Retry visibly retry", "is loading distinct from empty") should be in the brief, not
  discovered in review.

## Owner-owed after merge

- Confirm the two new composites deployed: `comments (hidden asc, at desc)` and
  `reports (status asc, createdAt desc)` (`firebase deploy --only firestore:indexes`).
- Device smoke (README "Sub-project 12 smoke checklist"): send a message from each entry point
  and from both roles, block and unblock, report a conversation and resolve it on `/admin`, post
  a comment and a reply on a show from a fan account, hide as the curator, tap Going and a heart,
  confirm the inline comment composer clears the keyboard on a phone, and confirm the unread tab
  badge clears on refocus.
