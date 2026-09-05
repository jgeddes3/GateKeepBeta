"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { collection, doc, getDoc, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import {
  MESSAGE_MAX_CHARS, MESSAGE_SEND_LABEL, MESSAGE_COMPOSER_PLACEHOLDER, CONVERSATION_BLOCKED_MESSAGE,
  UNBLOCK_LABEL, BLOCK_LABEL, REPORT_LABEL, CONVERSATION_EMPTY_MESSAGE, REPORT_SENT_MESSAGE,
  REPORT_REASON_PROMPT, REPORT_REASON_MAX_CHARS, REPORT_DUPLICATE_MESSAGE,
  type ConversationRefDoc, type MessageDoc, type ProfileDoc,
} from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { useAuth } from "../auth/AuthProvider";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Skeleton } from "../ui/skeleton";
import { ErrorBox } from "../ui/ErrorBox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { IconDotsVertical } from "../ui/icons";
import { parsePairId, type OtherProfileSummary } from "./useConversations";

type MessageRow = { id: string } & MessageDoc;

function ThreadSkeleton() {
  return (
    <div className="grid gap-4" role="status" aria-label="Loading conversation">
      <Skeleton className="h-7 w-40" />
      <div className="grid gap-3">
        <div className="flex justify-start"><Skeleton className="h-16 w-2/3 max-w-sm" /></div>
        <div className="flex justify-end"><Skeleton className="h-16 w-2/3 max-w-sm" /></div>
      </div>
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

// Live messages, oldest first, capped at 200 (spec 3.1's own query shape).
// Own hook, not exported: the loading/error/retry shape here is specific to
// this one subscription, unlike useConversations.ts's exports which other
// surfaces (the nav badge, Task 11's mobile twin) also need.
//
// No render-time reset on `conversationId`/`reloadKey` change, unlike
// useConversations.ts's own list hook: the page mounts ConversationThread
// keyed by `${conversationId}-${profileId}` (page.tsx), so a different
// conversation is always a FRESH instance whose initial state is already
// "loading"; only `retry`'s own event handler ever needs to reset it back.
//
// `enabled` (fix round, Critical finding #1): the caller only flips this to
// true once the viewer's own mirror doc (useMirror below) has been
// CONFIRMED to exist. For a pair that has never been messaged, the parent
// conversations/{pairId} doc this query's own security rule get()s does not
// exist either, so firestore.rules denies the listen outright and this
// component used to render "Couldn't load messages." with no way to
// recover short of Retry, even on the very first visit. Staying disabled
// (never subscribing at all, rather than subscribing and swallowing the
// expected denial) means `messages` simply stays at its initial "loading"
// value the whole time the caller is showing its own empty-state copy
// instead; the moment the mirror doc appears (sendMessage's own transaction
// writes the mirror and the first message together), `enabled` flips true
// and this effect subscribes for the first time, delivering that first
// bubble immediately rather than needing a manual Retry.
function useMessages(conversationId: string, enabled: boolean): { messages: MessageRow[] | "loading" | "error"; retry: () => void } {
  const [messages, setMessages] = useState<MessageRow[] | "loading" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const { db } = getFirebase();
    const unsub = onSnapshot(
      query(collection(db, `conversations/${conversationId}/messages`), orderBy("at", "asc"), limit(200)),
      (snap) => setMessages(snap.docs.map((d) => ({ id: d.id, ...(d.data() as MessageDoc) }))),
      () => setMessages("error"),
    );
    return () => { unsub(); };
  }, [conversationId, enabled, reloadKey]);
  return { messages, retry: () => { setMessages("loading"); setReloadKey((k) => k + 1); } };
}

// This profile's own mirror, live: the ONLY place `blockedByMe` is visible
// to a client at all (the shared conversations/{pairId} doc carries no
// block field, and the private block-list doc is server-only; see
// packages/shared/src/types.ts's own comments on ConversationDoc/
// ConversationStateDoc/ConversationRefDoc). Same "no reset needed" reasoning
// as useMessages above: a fresh conversationId is always a fresh mount.
//
// `pairValid` (fix round, Critical finding #1): a `?c=` value the router
// handed straight through can carry a "/" or other character outside
// isValidDocId's allowlist, which throws SYNCHRONOUSLY inside doc() before
// this component's own "conversation isn't available" render path ever
// gets a chance to bail out. The caller computes this once via
// useConversations.ts's own parsePairId (the exact check
// useOtherProfileForConversation already uses to decide the very same
// thing) and this effect simply never subscribes when it's false; `mirror`
// then stays at its initial "loading", which is harmless because the
// render below already returns the "conversation isn't available" state
// for an invalid pair BEFORE it ever looks at `mirror` (see the reordered
// checks below).
//
// The three-way return (loading / null-for-missing / a real doc / "error")
// is deliberately NOT collapsed: a mirror that doesn't exist yet (this pair
// has never been messaged) is not a failure, it's the normal state for
// every "Message" deep link's first visit, and must never be confused with
// a genuine read failure.
function useMirror(profileId: string, conversationId: string, pairValid: boolean): {
  mirror: ConversationRefDoc | null | "loading" | "error"; retryMirror: () => void;
} {
  const [mirror, setMirror] = useState<ConversationRefDoc | null | "loading" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!pairValid) return;
    const { db } = getFirebase();
    const unsub = onSnapshot(doc(db, `profiles/${profileId}/conversations/${conversationId}`),
      (s) => setMirror(s.exists() ? (s.data() as ConversationRefDoc) : null),
      () => setMirror("error"));
    return () => { unsub(); };
  }, [profileId, conversationId, pairValid, reloadKey]);
  return { mirror, retryMirror: () => { setMirror("loading"); setReloadKey((k) => k + 1); } };
}

export function ConversationThread({ profileId, conversationId, otherProfile, isAdminOfProfile }: {
  profileId: string;
  conversationId: string;
  otherProfile: OtherProfileSummary | "loading" | "error" | null;
  isAdminOfProfile: boolean;
}) {
  const { user } = useAuth();
  // Fix round, Critical finding #1: computed fresh every render, same as
  // useOtherProfileForConversation's own `pair`/`invalid` derivation (this
  // IS that same check, reused via useConversations.ts's exported
  // parsePairId) rather than trusted blindly off the prop. A malformed
  // `?c=` value (a "/" in it, say) must never reach collection()/doc() in
  // either hook below.
  const pairValid = parsePairId(conversationId) !== null;
  const { mirror, retryMirror } = useMirror(profileId, conversationId, pairValid);
  // The messages listener only ever attaches once the viewer's own mirror
  // doc is CONFIRMED to exist (mirror is a real ConversationRefDoc, not
  // "loading", not "error", and not null-for-missing): see useMessages' own
  // comment above for why. `mirrorMissing` is exported to the render below
  // as its own named state (never folded into `messages`) so "no messages
  // yet" and "couldn't load messages" stay two visibly different things.
  const mirrorReady = pairValid && mirror !== "loading" && mirror !== "error" && mirror !== null;
  const mirrorMissing = pairValid && mirror === null;
  const { messages, retry: retryMessages } = useMessages(conversationId, mirrorReady);

  // The acting profile's OWN name, for its own bubbles: not something either
  // prop already carries (`otherProfile` only ever names the OTHER side).
  // One-shot getDoc, same idiom as useRole/ArtistTagBanner's own per-profile
  // membership reads elsewhere in this app.
  const [myProfileName, setMyProfileName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getDoc(doc(getFirebase().db, "profiles", profileId))
      .then((snap) => { if (!cancelled && snap.exists()) setMyProfileName((snap.data() as ProfileDoc).name); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [profileId]);

  // Read receipt: fires on mount (a fresh conversationId, since the page
  // mounts this component keyed by `${conversationId}-${profileId}`) and
  // again whenever the live message COUNT grows while the thread stays
  // open, so a message that arrives while this screen is already open also
  // clears the badge rather than waiting for the next visit. Failures are
  // swallowed: a read receipt is not worth an error banner.
  //
  // `mirrorReady` (fix round, Critical finding #1): belt-and-suspenders
  // alongside `messages` never resolving out of "loading" while the mirror
  // is missing (useMessages stays disabled the whole time, so
  // `messageCount` alone already stays null) - there is nothing to mark
  // read for a conversation that has never received a first message, and
  // this makes that explicit rather than relying only on the other hook's
  // own gating.
  const messageCount = messages === "loading" || messages === "error" ? null : messages.length;
  useEffect(() => {
    if (messageCount === null || !mirrorReady) return;
    callFn("markConversationRead", { profileId, conversationId }).catch(() => {});
  }, [profileId, conversationId, messageCount, mirrorReady]);

  const [blockOverride, setBlockOverride] = useState<boolean | null>(null);
  const [blockBusy, setBlockBusy] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);
  const blockedByMe = blockOverride ?? (mirror !== "loading" && mirror !== "error" && mirror ? mirror.blockedByMe : false);

  const toggleBlock = async () => {
    setBlockBusy(true);
    setBlockError(null);
    try {
      // Deliberately NOT the whole block list back from the server: only
      // `blockedByMe` (setConversationBlock's own comment on why), which is
      // also all this screen needs, applied optimistically here so the
      // banner flips the instant the call resolves rather than waiting on
      // the mirror's own onSnapshot round trip.
      const res = await callFn<{ profileId: string; conversationId: string; blocked: boolean }, { ok: true; blockedByMe: boolean }>(
        "setConversationBlock", { profileId, conversationId, blocked: !blockedByMe },
      );
      setBlockOverride(res.data.blockedByMe);
    } catch (e) {
      setBlockError(e instanceof Error ? e.message : "Could not update this block.");
    } finally {
      setBlockBusy(false);
    }
  };

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending || otherProfile === "loading" || otherProfile === "error" || otherProfile === null) return;
    setSending(true);
    setSendError(null);
    try {
      await callFn("sendMessage", { fromProfileId: profileId, toProfileId: otherProfile.profileId, text: trimmed });
      setText("");
    } catch (e) {
      // Both blocked directions land here verbatim off the server
      // (CONVERSATION_CLOSED_MESSAGE), same as every other callable
      // rejection this app surfaces as-is.
      setSendError(e instanceof Error ? e.message : "Could not send this message.");
    } finally {
      setSending(false);
    }
  };

  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  // Fix round, Important finding #3: a single calm-text result, not a bare
  // `reportDone` boolean, so a duplicate report (already-exists) can share
  // this exact same "rendered as text here, never a failure state" branch as
  // a genuine first-time success, matching EventComments.tsx's own
  // `reportResult` pattern for the identical situation.
  const [reportResult, setReportResult] = useState<string | null>(null);

  const closeReport = (open: boolean) => {
    setReportOpen(open);
    if (!open) {
      setReportReason("");
      setReportError(null);
      setReportResult(null);
    }
  };

  const submitReport = async () => {
    const trimmed = reportReason.trim();
    setReportBusy(true);
    setReportError(null);
    try {
      // reportConversation is Task 5's callable and may not exist yet at
      // this task's own gate time; if it is absent this simply surfaces the
      // callable's own error text below, unstubbed.
      await callFn("reportConversation", { profileId, conversationId, reason: trimmed });
      setReportResult(REPORT_SENT_MESSAGE);
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      // A duplicate report (reporters cannot read reports, so there is no
      // other way to learn a first attempt already landed) is a statement
      // of fact, not a failure: rendered in the same calm `role="status"`
      // line as success, never inside an ErrorBox.
      if (message === REPORT_DUPLICATE_MESSAGE) setReportResult(REPORT_DUPLICATE_MESSAGE);
      else setReportError(message || "Could not send this report.");
    } finally {
      setReportBusy(false);
    }
  };

  // Reordered (fix round, Critical finding #1): the "conversation isn't
  // available" case (an invalid `?c=` pair, or one naming neither of this
  // profile's own two ids) is checked FIRST, before `mirror === "loading"`.
  // `mirror` never resolves out of "loading" for an invalid pair (its own
  // hook stays disabled via `pairValid`), so checking it first used to hang
  // this branch in ThreadSkeleton forever instead of ever reaching this
  // "isn't available" message.
  if (otherProfile === "error" || otherProfile === null) {
    return <ErrorBox message="This conversation isn't available." />;
  }
  if (otherProfile === "loading" || mirror === "loading") return <ThreadSkeleton />;

  const typeLabel = otherProfile.type === "curator" ? "Curator" : "Musician";

  return (
    <div className="grid gap-4">
      <header className="flex items-start justify-between gap-3 border-b border-gk-border pb-3">
        <div className="grid gap-0.5">
          <Link href={`/u/${otherProfile.handle}`} className="w-fit font-syne text-lg font-semibold text-gk-text hover:underline">
            {otherProfile.name}
          </Link>
          <p className="font-sora text-xs text-gk-muted">{typeLabel}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label="Conversation actions">
              <IconDotsVertical size={18} aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {isAdminOfProfile && (
              <DropdownMenuItem disabled={blockBusy} onSelect={() => { void toggleBlock(); }}>
                {blockedByMe ? UNBLOCK_LABEL : BLOCK_LABEL}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setReportOpen(true); }}>
              {REPORT_LABEL}
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/u/${otherProfile.handle}`}>View profile</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {blockError && <ErrorBox message={blockError} />}

      <div className="grid gap-3">
        {/* Fix round, Critical finding #1: `mirrorMissing`/`mirror === "error"`
            are checked before ever looking at `messages` at all, since the
            messages listener never even attaches (stays disabled via
            `mirrorReady`) in either of those two states. A pair never
            messaged before renders the plain empty-state line here, same
            copy and same composer as an ordinary empty thread, with no
            "Couldn't load" flash and nothing to retry; a genuine mirror read
            failure gets its own ErrorBox + Retry, distinct from "no
            messages yet" so the two can never be confused. */}
        {mirrorMissing ? (
          <p className="font-sora text-sm text-gk-muted">{CONVERSATION_EMPTY_MESSAGE}</p>
        ) : mirror === "error" ? (
          <div className="grid gap-2">
            <ErrorBox message="Couldn't load this conversation." />
            <Button type="button" variant="secondary" onClick={retryMirror} className="w-fit">Retry</Button>
          </div>
        ) : (
          <>
            {messages === "loading" && (
              <div className="grid gap-3" role="status" aria-label="Loading messages">
                <div className="flex justify-start"><Skeleton className="h-16 w-2/3 max-w-sm" /></div>
                <div className="flex justify-end"><Skeleton className="h-16 w-2/3 max-w-sm" /></div>
              </div>
            )}
            {messages === "error" && (
              <div className="grid gap-2">
                <ErrorBox message="Couldn't load messages." />
                <Button type="button" variant="secondary" onClick={retryMessages} className="w-fit">Retry</Button>
              </div>
            )}
            {messages !== "loading" && messages !== "error" && messages.length === 0 && (
              <p className="font-sora text-sm text-gk-muted">{CONVERSATION_EMPTY_MESSAGE}</p>
            )}
            {messages !== "loading" && messages !== "error" && messages.map((m) => {
              const isMine = m.senderProfileId === profileId;
              // The spec asks for the sender's profile name plus the
              // member's display name; a users/{uid} read is owner-only
              // (firestore.rules), so that display name is only ever known
              // for the VIEWER'S OWN sends (useAuth()'s own displayName).
              // Any other sender, own side or the other side, renders the
              // profile name alone.
              const isViewerSend = isMine && m.senderUid === user?.uid;
              const senderProfileName = isMine ? (myProfileName ?? "You") : otherProfile.name;
              const label = isViewerSend && user?.displayName ? `${senderProfileName} · ${user.displayName}` : senderProfileName;
              return (
                <div key={m.id} className={cn("flex", isMine ? "justify-end" : "justify-start")}>
                  <div
                    className={cn(
                      "grid max-w-[85%] gap-2 rounded-gk border p-3.5 sm:max-w-[70%]",
                      isMine ? "border-gk-accent/50 bg-gk-accent/14" : "border-gk-border bg-gk-surface",
                    )}
                  >
                    <p className="whitespace-pre-wrap font-sora text-sm text-gk-text">{m.text}</p>
                    <p className="font-sora text-xs text-gk-muted">{label} · {new Date(m.at).toLocaleString()}</p>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>

      {blockedByMe ? (
        <div className="grid gap-2 border-t border-gk-border pt-3">
          <p className="font-sora text-sm text-gk-text">{CONVERSATION_BLOCKED_MESSAGE}</p>
          {isAdminOfProfile && (
            <Button type="button" variant="secondary" onClick={() => { void toggleBlock(); }} disabled={blockBusy} className="w-fit">
              {blockBusy ? "Unblocking…" : UNBLOCK_LABEL}
            </Button>
          )}
        </div>
      ) : (
        // A real <form onSubmit>, not a keydown handler: Enter submits
        // because it's a real form (audit item #21's rule, applied here
        // from the start). The other side's own block never changes this
        // form's shape at all (spec 3.1: it "shows nothing different"); a
        // refused send just surfaces CONVERSATION_CLOSED_MESSAGE below,
        // verbatim from the server.
        <form onSubmit={send} className="grid gap-2 border-t border-gk-border pt-3">
          <Textarea
            aria-label={MESSAGE_COMPOSER_PLACEHOLDER}
            placeholder={MESSAGE_COMPOSER_PLACEHOLDER}
            maxLength={MESSAGE_MAX_CHARS}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={sending}
            rows={3}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="font-sora text-xs text-gk-muted">{text.length} / {MESSAGE_MAX_CHARS}</span>
            <Button type="submit" disabled={sending || text.trim().length === 0}>
              {sending ? "Sending…" : MESSAGE_SEND_LABEL}
            </Button>
          </div>
          {sendError && <ErrorBox message={sendError} />}
        </form>
      )}

      <Dialog open={reportOpen} onOpenChange={closeReport}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{REPORT_REASON_PROMPT}</DialogTitle>
          </DialogHeader>
          {reportResult ? (
            <p role="status" className="font-sora text-sm text-gk-text">{reportResult}</p>
          ) : (
            <div className="grid gap-2">
              <Textarea
                aria-label={REPORT_REASON_PROMPT}
                maxLength={REPORT_REASON_MAX_CHARS}
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                disabled={reportBusy}
                rows={4}
              />
              <p className="font-sora text-xs text-gk-muted">{reportReason.length} / {REPORT_REASON_MAX_CHARS}</p>
              {reportError && <ErrorBox message={reportError} />}
            </div>
          )}
          <DialogFooter>
            {reportResult ? (
              <Button type="button" onClick={() => closeReport(false)}>Close</Button>
            ) : (
              <>
                <Button type="button" variant="secondary" onClick={() => closeReport(false)} disabled={reportBusy}>Cancel</Button>
                <Button type="button" onClick={() => { void submitReport(); }} disabled={reportBusy || reportReason.trim().length === 0}>
                  {reportBusy ? "Sending…" : REPORT_LABEL}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
