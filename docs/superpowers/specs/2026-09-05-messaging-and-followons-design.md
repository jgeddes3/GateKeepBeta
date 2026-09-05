# Sub-project 12: Messaging, fan comments, and the follow-ons

Design spec, 2026-09-05. Binding over the plan. No em dashes anywhere in this sub-project's output.
This is the final planned sub-project.

## 1. Goal

Give musicians and curators a direct line to each other before, during, and after a booking; let
fans talk on the public show pages; and close the accessibility and state-coverage findings from
the 2026-09-01 audit plus the user-visible hardening rows, so the app is complete for the metro
launch.

## 2. Owner decisions (2026-09-05)

- Conversations are between a musician profile and a curator profile, either side may start,
  every member of either profile can read and reply; fans are not part of chat.
- Chat is separate from the terms-only booking thread; the booking screen links into the pair's
  conversation.
- Abuse posture: block (per pair, either profile's admins), report to admins, server caps, an
  admin Reports panel that can read only reported conversations. No profanity filter.
- Fans comment and react on public show pages (the event page and its lineup posts); the curator
  and the booked or accepted-tagged artists can reply and hide; fans can report.
- Follow-ons: antislop #10 to #29 in full; ledger rows L64, L68, L70, L79, and a check of L63.
  L62, L65 to L67, L69, L71 to L78, and L80 stay recorded as accepted.
- Messaging plus these follow-ons is the final sub-project.

## 3. Surfaces

### 3.1 Conversations

- **Web** `/dashboard/messages`: left, the conversation list for the acting profile (the existing
  profile switcher chooses which of the user's profiles is speaking; a user with one profile sees
  no switcher); right, the thread. Each row: the other profile's name and type, the last message
  preview, the time, an unread count. The thread shows messages as bubbles (own side right in the
  accent, other side left, the same shape `BookingThread` uses), the sender's profile name under
  each bubble (plus the member's display name on the viewer's own sends; other accounts' user
  docs are not readable), a composer with a 1000-character counter and a
  Send button, and a header menu with "Block" (admins of the acting profile), "Report", and a
  link to the other profile's public page. Blocked threads show "You blocked this profile.
  Unblock to message again." with an Unblock action for admins; a thread the other side blocked
  shows nothing different and refuses sends with the generic "This conversation is closed."
- **Mobile**: the two coming-soon Messages tabs become real: a list screen (same rows) and a
  thread screen (same bubbles, composer, and header menu) under `(musician)/messages` and
  `(curator)/messages`; the acting profile is the tab group's active profile. The tab shows an
  unread badge (sum across the user's profiles of that type).
- **Entry points** ("Message" buttons, hidden when the viewer has no eligible profile of the
  opposite type; a viewer with several picks one in a sheet): the web venue page and curator
  profile page and the mobile venue screen (musician side); the curator search results and the
  artist page on both platforms (curator side); the booking screen on both platforms (either
  side, the pair is known). The button opens the conversation, creating it on first send.
- **Notifications**: a new kind `message` with `refId` the conversation id, sent to the recipient
  profile's members, title "{senderProfile} messaged {recipientProfile}", body the message
  preview (first 120 characters), one notification per conversation per recipient profile per
  10 minutes; `notificationHref` routes to `/dashboard/messages?c={id}` on web and
  `/(musician)/messages/{id}` or `/(curator)/messages/{id}` on mobile (the recipient profile's
  type decides).

### 3.2 Fan comments and reactions

- **Where**: the public event page on both platforms, under the lineup and above the tickets
  block: a reaction row for the show ("Going" toggle with a count) and a comment list (newest
  first, 20 a page, "Show more"); each lineup post from SP7 gains a heart reaction with a count.
- **Who**: any signed-in user with a verified email can comment or react once per target;
  the event's curator members and the members of any booking or accepted-tagged artist profile
  can reply (their comments carry a "Curator" or "Artist" tag) and can hide any comment;
  the author can delete their own comment; any signed-in user can report a comment.
- **Rendering**: display name, relative time, text (500 characters), a Reply link that quotes
  the parent (one level, no deeper threading), Hide for curator and artist members, Delete for
  the author, Report for others. Hidden comments vanish for everyone except admins, who see
  "Hidden by {who}". Comments close when the event is cancelled or taken down (the list stays
  readable, the composer disappears with "Comments are closed.").
- **Notifications**: a curator member or artist member reply to a fan's comment sends the fan a
  `comment_reply` notification that opens the event page; no notification for fan-to-fan
  replies; reactions never notify.

### 3.3 Admin

- `/admin` gains a "Reports" panel listing open reports (conversation and comment) with the
  reporter, the reason, the target, and the time; an admin can open the reported conversation
  (read-only, the whole thread) or comment, hide the comment, add an admin note on the offending
  user through the existing `flagAccount` tool (comment reports carry the author's uid;
  conversation reports point the operator at User lookup instead), or resolve the report. Resolved reports leave the
  list.

### 3.4 Follow-ons

- **Listeners and states (#10, #11, #12, #13, #15, #16)**: every `onSnapshot` on both platforms
  gets an error callback that renders the platform's error state with a retry; the mobile
  "null means loading" sentinel becomes an explicit `loading | error | notFound | ready` state
  on the screens the audit names; the mobile inbox, ticket list, and fan home distinguish an
  error from an empty result; the remaining bare "Loading" text and spinners become skeletons;
  sign-in buttons gain a busy state; mobile empty-state copy matches the web twins.
- **Empty state (#14)**: the web event page shows "No tickets on sale yet." when an event has no
  tiers, matching mobile.
- **Contrast and targets (#17, #18, #19, #20, #28)**: ember text on the mobile light theme meets
  AA (the sign-in link, the series link); disabled ticket tiers dim the price and control but
  not the tier name; every mobile Pressable meets 44px (bare-text links, chips, steppers); web
  button variants meet 44px on touch through a minimum height on the touch media query; the
  curator events header no longer clips at 360px.
- **Forms and accessibility (#21, #22, #23, #24, #25, #27)**: web sign-in, join, and every
  composer submit on Enter through a real form; every web input has an associated label (admin,
  curator forms, portfolio forms, event editor); every mobile Pressable carries a role and a
  label; the two bespoke modals set `accessibilityViewIsModal`; sheets and modals respect
  reduced motion; disabled reasons on web render as visible helper text, not a tooltip.
- **Unread (#26)**: unread notifications carry a text marker ("New") plus the existing dot.
- **Overflow (#29)**: the html-level `overflow-x: hidden` is removed after the pages that relied
  on it are fixed (the build and a manual scroll check on the audit's pages).
- **Ledger**: L64 the true-up form refuses a fractional value with "Whole numbers only." instead
  of rounding; L68 the booking inbox pages past 50 with "Show more"; L70 the ten
  `window.prompt`, `confirm`, and `alert` sites use the shared dialog primitive (a confirm
  dialog and a prompt sheet in `apps/web/src/ui`); L79 the events index series badge uses
  `SERIES_STATUS_TONE`; L63 verified closed and its ledger row updated.

## 4. Data model

- `conversations/{pairId}` with `pairId = "{musicianProfileId}__{curatorProfileId}"` holds only
  what both sides may see: `musicianProfileId`, `curatorProfileId`,
  `participants: [musicianProfileId, curatorProfileId]`,
  `lastMessage: { text: string; senderProfileId: string; at: number } | null`,
  `lastMessageAt: number`, `openReports: number`, `createdAt`, `updatedAt`.
  Per-side state never sits on it: each side's unread count lives only on its mirror, and the
  block list lives in the server-only `conversations/{pairId}/private/state` doc
  (`blockedBy: string[]`), so a blocked side cannot read who blocked it and neither side can
  read the other's read activity.
- `conversations/{pairId}/messages/{messageId}`: `senderProfileId`, `senderUid`, `text` (1 to
  1000 characters after trim), `at`.
- `reports/{reportId}`: `kind: "conversation" | "comment"`, `targetPath` (the conversation id or
  `events/{id}/comments/{id}`), `reporterUid`, `reporterProfileId | null`, `reason` (1 to 300
  characters), `status: "open" | "resolved"`, `resolvedBy`, `resolvedAt`, `createdAt`.
- `events/{eventId}/comments/{commentId}`: `authorUid`, `authorName` (snapshot),
  `authorRole: "fan" | "curator" | "artist"`, `authorProfileId | null`, `parentId | null`,
  `text` (1 to 500), `hidden: boolean`, `hiddenBy: { uid, role } | null`, `openReports`, `at`.
- `events/{eventId}/reactions/{uid}`: `going: boolean`, `at`; `events/{eventId}/posts/{postId}`
  gains `heartCount` and `events/{eventId}/posts/{postId}/hearts/{uid}`; `EventDoc` gains
  `goingCount`, `commentCount`.
- `NotificationDoc.kind` gains `message` and `comment_reply`; `notificationHref` branches for
  both. A `message` notification carries `refKind: "musician" | "curator"` (the recipient
  profile's type) so the mobile href can pick the tab group, the way `saved_search_match`
  already branches on `refKind`.
- Per-profile mirrors for listing: `profiles/{profileId}/conversations/{pairId}` with
  `otherProfileId`, `otherProfileName`, `otherProfileType`, `lastMessage`, `lastMessageAt`,
  `unread` (this profile's count), `blockedByMe`, and `openReports`, written by the messaging
  callables in the same transaction as the top-level doc. Clients list a profile's conversations
  from its mirror (readable by that profile's members, ordered by `lastMessageAt`) and open the
  top-level doc by id; a security rule cannot prove membership for a top-level
  `participants array-contains` query, and mirrors avoid syncing member uids onto every
  conversation.
- Server-only rate windows: `messageWindows/{profileId}` and `commentWindows/{uid}` hold the
  recent timestamps for the rolling caps (client-unreadable, same posture as `geocodeBudgets`).
- Rules: `conversations` and their `messages` readable by members of either participant profile
  or admins when `openReports > 0`; `reports` admin-read; `comments` readable by anyone signed in
  when not hidden (admins see hidden); a `reactions` or `hearts` doc readable only by its owner
  (never listable; the counts on the parent docs are the public face);
  every write callable-only; the per-profile conversation mirrors readable by that profile's
  members only. Indexes: `comments (hidden, at desc)` if the query needs it; `reports (status,
  createdAt desc)`; the mirrors order by a single field and need no composite.

## 5. Backend

- `sendMessage({ fromProfileId, toProfileId, text })`: verified email; caller is a member of
  `fromProfileId`; the two profiles are one musician and one curator, both `approved`; the pair
  is not blocked by either side; 30 messages per 10 minutes per sender profile across all conversations (a rolling window in
  the server-only `messageWindows/{profileId}` doc, read and trimmed inside the send
  transaction); creates the conversation on first send; writes the message,
  `lastMessage`, `lastMessageAt`, and increments the recipient's unread count in one
  transaction; notifies the recipient profile's members under `message:{pairId}:{10-minute
  bucket}`.
- `markConversationRead({ profileId, conversationId })`: member of the profile; zeroes that
  profile's unread count.
- `setConversationBlock({ profileId, conversationId, blocked })`: admin of the profile; adds or
  removes the profile id in `blockedBy`.
- `reportConversation({ profileId, conversationId, reason })` and `reportComment({ eventId,
  commentId, reason })`: any signed-in participant (conversation) or any signed-in user
  (comment); one open report per reporter per target; increments `openReports`; creates the
  `reports` doc.
- `resolveReport({ reportId })`: admin; sets resolved and decrements the target's `openReports`.
- `postComment({ eventId, text, parentId? })`: verified email; the event is published (or
  completed); role derived server-side (curator member, artist member of a booking or accepted
  tagged act, else fan); 10 comments per 10 minutes per user; writes the comment, increments
  `commentCount`; a curator or artist reply to a fan's comment notifies the fan under
  `comment_reply:{commentId}`.
- `hideComment({ eventId, commentId, hidden? })`: curator member or artist member of the event
  (or admin) hides; only an admin may pass `hidden: false` to unhide (clearing `hiddenBy`).
  `commentCount` counts visible comments: hide decrements, unhide increments.
  `deleteComment({ eventId, commentId })`: the author; refused while the comment is hidden or
  has an open report ("This comment cannot be deleted while it is hidden or reported."); deletes
  the doc and decrements the count (replies to it stay, rendered with "Comment deleted" as the
  quoted parent). A reply to a hidden parent is refused.
- `setGoing({ eventId, going })` and `setPostHeart({ eventId, postId, hearted })`: verified
  email; the event open (published or completed) and, for hearts, the post `live`; 60 toggles
  per 10 minutes per user (a second array on `commentWindows/{uid}`); toggles the per-user doc
  and adjusts the count in one transaction.
- The event cascade on cancel or takedown does not delete comments; the composer closes on the
  client by event status.

## 6. Messages (final copy)

- Chat: "Message"; "Send"; "Write a message"; "You blocked this profile. Unblock to message
  again."; "Unblock"; "Block"; "Report"; "This conversation is closed."; "No messages yet. Say
  hello."; "Messages are 1 to 1000 characters."; "You are sending too fast. Try again in a few
  minutes."; "Only approved profiles can message."; "Report sent. Thanks."; "Why are you reporting
  this?"; notification title "{senderProfile} messaged {recipientProfile}".
- Comments: "Going"; "Add a comment"; "Reply"; "Hide"; "Delete"; "Comments are closed."; "No
  comments yet."; "Comments are 1 to 500 characters."; "Hidden by {who}"; "Comment deleted";
  notification title "{name} replied to your comment".
- Admin: "Reports"; "Resolve"; "Open conversation"; "Hide comment"; "Unhide"; "No open reports."
- Comment refusals: "This comment cannot be deleted while it is hidden or reported."
- Follow-ons: "Whole numbers only."; "No tickets on sale yet."; "New"; "Show more"; dialog
  primitives "Confirm", "Cancel".

## 7. Testing

- Emulator (functions): `sendMessage` (member and approval gates, pair validity, first send
  creates the doc, unread increments, rate cap, block in both directions, notification dedupe
  within a bucket), `markConversationRead`, `setConversationBlock` (admin only), reports (one
  open per reporter per target, admin resolve), `postComment` (role derivation for curator,
  booking artist, accepted tagged artist, fan; rate cap; closed events), `hideComment` and
  `deleteComment` authority, `setGoing` and `setPostHeart` idempotent toggles and counts,
  `comment_reply` notification.
- Rules: participants read conversations and messages, strangers cannot, admins can read only
  reported ones; comments hidden to non-admins; reports admin-only; no client writes anywhere
  new.
- Shared: validators and `notificationHref` branches.
- Clients: typecheck, lint, build, export; every follow-on item is checked by reading the diff
  against the audit's list; device and browser checks are owner-smoked.

## 8. Out of scope (deliberate)

Attachments and images in chat or comments; typing indicators; read receipts beyond unread
counts; fan-to-profile direct messages; editing messages; message search; profanity filtering;
email digests; comment threads deeper than one reply level; ledger rows L62, L65 to L67, L69,
L71 to L78, L80.

## 9. Owner-owed after merge

- Device and browser smoke: send and receive across two accounts, block and unblock, report and
  resolve from `/admin`, comment and reply on a show, hide as the curator, react and heart, the
  unread badges, and the accessibility pass (a screen reader on each platform, keyboard-only on
  web, 360px width, reduced motion on).
- No new EAS build is needed unless the reduced-motion work adds a native module (it should not).
