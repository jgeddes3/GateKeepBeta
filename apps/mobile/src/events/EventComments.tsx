import { useCallback, useEffect, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, View } from "react-native";
import { useRouter } from "expo-router";
import {
  collection, doc, getDoc, getDocs, limit, orderBy, query, startAfter, where,
  type DocumentData, type QueryDocumentSnapshot,
} from "firebase/firestore";
import {
  COMMENT_MAX_CHARS, COMMENT_PAGE_SIZE, COMMENT_REPLY_LABEL, COMMENT_HIDE_LABEL, COMMENT_DELETE_LABEL,
  COMMENT_COMPOSER_PLACEHOLDER, COMMENTS_CLOSED_MESSAGE, COMMENTS_EMPTY_MESSAGE, COMMENT_DELETED_LINE,
  COMMENT_UNDER_REVIEW_MESSAGE, REPORT_LABEL, REPORT_REASON_PROMPT, REPORT_REASON_MAX_CHARS, REPORT_REASON_MESSAGE,
  REPORT_SENT_MESSAGE, REPORT_DUPLICATE_MESSAGE, SHOW_MORE_LABEL, commentHiddenLine,
  type CommentRole, type EventCommentDoc, type EventStatus,
} from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { useAuth } from "../auth/AuthProvider";
import { useProfileContext } from "../shell/ProfileContext";
import { Text, Button, Card, Badge, TextArea, Sheet, ErrorBanner, Callout, SkeletonCard } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// SP12 (spec sections 3.2 and 5). RN twin of Task 8's web EventComments (same
// name, same contract): the public event page's fan comment thread, one
// level of replies, curator/artist moderation, and reporting. Task 8's own
// `useCommentAuthority` sibling lives here too (EventComments is its only
// consumer on this platform).

type CommentRow = { id: string } & EventCommentDoc;

// A viewer's standing on THIS event: "curator" or "artist" if they are a
// member of the curator profile or of a lineup act's profile (the exact set
// deriveCommentRole, functions/src/comments.ts, would derive server-side for
// a post from this uid), else "fan". Read off useProfileContext().myProfiles
// (already loaded app-wide and live) rather than a fresh per-profile getDoc,
// the same membership source ShowPosts.tsx's own useShowPostComposerGate
// leans on for this exact screen.
export type CommentAuthority = "fan" | "curator" | "artist";

export function useCommentAuthority(
  curatorProfileId: string, lineupMusicianProfileIds: string[],
): CommentAuthority {
  const { myProfiles } = useProfileContext();
  if (myProfiles.some((p) => p.profileId === curatorProfileId)) return "curator";
  if (myProfiles.some((p) => lineupMusicianProfileIds.includes(p.profileId))) return "artist";
  return "fan";
}

// The `admin` custom claim, read the same way apps/web/app/admin/AdminGate.tsx
// does (a forced token refresh on mount): the ONE mobile surface that needs
// it, since an admin browsing the public event page sees hidden comments the
// same way the web twin does (spec 3.2's "Hidden by {who}").
function useIsAdmin(): boolean {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    // Sync with `user` itself changing (sign-out/sign-in), same shape as
    // ProfileContext.tsx's own guard clause.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!user) { setIsAdmin(false); return; }
    let cancelled = false;
    user.getIdTokenResult(true)
      .then((t) => { if (!cancelled) setIsAdmin(t.claims.admin === true); })
      .catch(() => { if (!cancelled) setIsAdmin(false); });
    return () => { cancelled = true; };
  }, [user]);
  return isAdmin;
}

// A short, relative "2h"/"3d" stamp. Deliberately NOT imported from
// src/messaging/useConversations.ts's own formatConversationTime: that file
// is Task 10's, active in this same tree, and this component must not take a
// dependency on it.
function formatCommentTime(atMs: number): string {
  const diff = Date.now() - atMs;
  const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`;
  return new Date(atMs).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function hiddenByLabel(role: CommentRole | "admin"): string {
  return role === "admin" ? "an admin" : role === "curator" ? "the curator" : "the artist";
}

// One page of the public feed, newest first: the identical query shape
// (brief step 1), the admin branch included even though no mobile screen
// ever flips isAdmin true today besides this component's own claim check.
async function fetchCommentsPage(
  eventId: string, isAdmin: boolean, after: QueryDocumentSnapshot<DocumentData> | null,
): Promise<{ rows: CommentRow[]; last: QueryDocumentSnapshot<DocumentData> | null; hasMore: boolean }> {
  const base = collection(getFirebase().db, `events/${eventId}/comments`);
  const q = isAdmin
    ? query(base, orderBy("at", "desc"), limit(COMMENT_PAGE_SIZE), ...(after ? [startAfter(after)] : []))
    : query(base, where("hidden", "==", false), orderBy("at", "desc"), limit(COMMENT_PAGE_SIZE), ...(after ? [startAfter(after)] : []));
  const snap = await getDocs(q);
  const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as EventCommentDoc) }));
  return { rows, last: snap.docs[snap.docs.length - 1] ?? null, hasMore: snap.docs.length === COMMENT_PAGE_SIZE };
}

// The quoted parent line on a reply row. Checked first against the rows
// already on screen (the common case: a reply usually loads on the same page
// as its parent); only a parent that scrolled off an earlier page falls back
// to its own getDoc. A hidden or deleted parent both read as COMMENT_DELETED_LINE:
// a hidden parent 404s a non-admin reader the same way postComment itself
// treats one as gone (functions/src/comments.ts), so there is no honest way
// to tell the two apart from here either.
function ParentQuote({ eventId, parentId, rows }: { eventId: string; parentId: string; rows: CommentRow[] }) {
  const known = rows.find((r) => r.id === parentId) ?? null;
  const [parent, setParent] = useState<EventCommentDoc | "loading" | "gone">(known ?? "loading");

  useEffect(() => {
    // Sync with `known` itself changing (a later page load surfaces the
    // parent that a fetch had to fill in for), same guard-clause shape as
    // ProfileContext.tsx's own.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (known) { setParent(known); return; }
    let cancelled = false;
    getDoc(doc(getFirebase().db, `events/${eventId}/comments/${parentId}`))
      .then((s) => { if (!cancelled) setParent(s.exists() ? (s.data() as EventCommentDoc) : "gone"); })
      .catch(() => { if (!cancelled) setParent("gone"); });
    return () => { cancelled = true; };
  }, [eventId, parentId, known]);

  if (parent === "loading") return null;
  if (parent === "gone") {
    return <Text variant="meta" muted style={{ fontStyle: "italic" }}>{COMMENT_DELETED_LINE}</Text>;
  }
  return (
    <Text variant="meta" muted numberOfLines={2} style={{ fontStyle: "italic" }}>
      {parent.authorName}: {parent.text}
    </Text>
  );
}

// One row's report form, a Sheet (with its own KeyboardAvoidingView) rather
// than the web Dialog this ports from (brief step 1), same shape as
// ConversationThread's own report sheet.
function ReportCommentSheet({ visible, onClose, eventId, commentId }: {
  visible: boolean; onClose: () => void; eventId: string; commentId: string | null;
}) {
  const t = useTokens();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<"sent" | "duplicate" | null>(null);

  const close = () => {
    if (busy) return;
    onClose();
    setReason(""); setError(null); setResult(null);
  };

  const submit = async () => {
    if (!commentId) return;
    const trimmed = reason.trim();
    if (trimmed.length < 1 || trimmed.length > REPORT_REASON_MAX_CHARS) {
      setError(REPORT_REASON_MESSAGE);
      return;
    }
    setBusy(true); setError(null);
    try {
      await callFn("reportComment", { eventId, commentId, reason: trimmed });
      setResult("sent");
    } catch (e) {
      if (e instanceof Error && e.message === REPORT_DUPLICATE_MESSAGE) setResult("duplicate");
      else setError(e instanceof Error ? e.message : "Could not send this report.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
        <View style={{ gap: tokens.space.sm }}>
          <Text variant="title">{REPORT_REASON_PROMPT}</Text>
          {result ? (
            <>
              <Callout tone="success">
                <Text color={t.success}>{result === "sent" ? REPORT_SENT_MESSAGE : REPORT_DUPLICATE_MESSAGE}</Text>
              </Callout>
              <Button variant="secondary" title="Close" onPress={close} style={{ alignSelf: "flex-start" }} />
            </>
          ) : (
            <>
              <TextArea
                value={reason}
                onChangeText={(v) => setReason(v.slice(0, REPORT_REASON_MAX_CHARS))}
                maxLength={REPORT_REASON_MAX_CHARS}
                placeholder={REPORT_REASON_PROMPT}
                accessibilityLabel={REPORT_REASON_PROMPT}
                editable={!busy}
              />
              <Text variant="meta" muted>{reason.length} / {REPORT_REASON_MAX_CHARS}</Text>
              {error && <ErrorBanner message={error} />}
              <Button title={REPORT_LABEL} loading={busy} disabled={reason.trim().length === 0}
                onPress={() => void submit()} accessibilityLabel={REPORT_LABEL} />
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Sheet>
  );
}

// The reply composer, also a Sheet: quotes the top-level comment being
// replied to and posts with parentId set. Reply only ever targets a
// TOP-LEVEL comment (spec 3.2, one level of threading), so the row that
// opens this always has the full parent in hand already, no lookup needed.
function ReplySheet({ visible, onClose, eventId, parent, onPosted }: {
  visible: boolean; onClose: () => void; eventId: string; parent: CommentRow | null; onPosted: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (busy) return;
    onClose();
    setText(""); setError(null);
  };

  const submit = async () => {
    if (!parent) return;
    const trimmed = text.trim();
    if (trimmed.length < 1) return;
    setBusy(true); setError(null);
    try {
      await callFn("postComment", { eventId, text: trimmed, parentId: parent.id });
      setText("");
      onPosted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not post this reply.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
        <View style={{ gap: tokens.space.sm }}>
          <Text variant="title">{COMMENT_REPLY_LABEL}</Text>
          {parent && (
            <Text variant="meta" muted numberOfLines={2} style={{ fontStyle: "italic" }}>
              {parent.authorName}: {parent.text}
            </Text>
          )}
          <TextArea
            value={text} onChangeText={(v) => setText(v.slice(0, COMMENT_MAX_CHARS))}
            maxLength={COMMENT_MAX_CHARS} placeholder={COMMENT_COMPOSER_PLACEHOLDER}
            accessibilityLabel={COMMENT_COMPOSER_PLACEHOLDER} editable={!busy}
          />
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text variant="meta" muted>{text.length} / {COMMENT_MAX_CHARS}</Text>
            <Button title={busy ? "Posting…" : "Post"} loading={busy} disabled={text.trim().length === 0}
              onPress={() => void submit()} />
          </View>
          {error && <ErrorBanner message={error} />}
        </View>
      </KeyboardAvoidingView>
    </Sheet>
  );
}

function CommentItem({ eventId, comment, rows, uid, authority, isAdmin, isOpen, onChanged, onReply }: {
  eventId: string; comment: CommentRow; rows: CommentRow[]; uid: string | undefined;
  authority: CommentAuthority; isAdmin: boolean; isOpen: boolean;
  onChanged: () => void; onReply: (comment: CommentRow) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  const isAuthor = uid != null && comment.authorUid === uid;
  const canModerate = authority !== "fan" || isAdmin;

  const hide = async () => {
    setBusy(true); setError(null);
    try {
      await callFn("hideComment", { eventId, commentId: comment.id });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not hide this comment.");
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true); setError(null);
    try {
      await callFn("deleteComment", { eventId, commentId: comment.id });
      onChanged();
    } catch (e) {
      setError(e instanceof Error
        ? (e.message === COMMENT_UNDER_REVIEW_MESSAGE ? COMMENT_UNDER_REVIEW_MESSAGE : e.message)
        : "Could not delete this comment.");
      setBusy(false);
    }
  };

  return (
    <Card style={{ gap: tokens.space.xs }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: tokens.space.xs }}>
        <Text variant="label">{comment.authorName}</Text>
        {comment.authorRole === "curator" && <Badge label="Curator" />}
        {comment.authorRole === "artist" && <Badge label="Artist" />}
        <Text variant="meta" muted>{formatCommentTime(comment.at)}</Text>
      </View>
      {comment.hidden && <Text variant="meta" muted>{commentHiddenLine(hiddenByLabel(comment.hiddenBy?.role ?? "admin"))}</Text>}
      {comment.parentId && <ParentQuote eventId={eventId} parentId={comment.parentId} rows={rows} />}
      <Text>{comment.text}</Text>
      <View style={{ flexDirection: "row", gap: tokens.space.sm, flexWrap: "wrap" }}>
        {isOpen && comment.parentId === null && (
          <Button variant="ghost" title={COMMENT_REPLY_LABEL} accessibilityLabel={COMMENT_REPLY_LABEL}
            onPress={() => onReply(comment)} style={{ paddingHorizontal: 0 }} />
        )}
        {isAuthor ? (
          <Button variant="ghost" title={COMMENT_DELETE_LABEL} accessibilityLabel={COMMENT_DELETE_LABEL}
            loading={busy} onPress={() => void remove()} style={{ paddingHorizontal: 0 }} />
        ) : !comment.hidden && canModerate ? (
          <Button variant="ghost" title={COMMENT_HIDE_LABEL} accessibilityLabel={COMMENT_HIDE_LABEL}
            loading={busy} onPress={() => void hide()} style={{ paddingHorizontal: 0 }} />
        ) : !comment.hidden ? (
          <Button variant="ghost" title={REPORT_LABEL} accessibilityLabel={REPORT_LABEL}
            onPress={() => setReportOpen(true)} style={{ paddingHorizontal: 0 }} />
        ) : null}
      </View>
      {error && <ErrorBanner message={error} />}
      <ReportCommentSheet visible={reportOpen} onClose={() => setReportOpen(false)} eventId={eventId} commentId={comment.id} />
    </Card>
  );
}

export function EventComments({ eventId, eventStatus, curatorProfileId, lineupMusicianProfileIds }: {
  eventId: string; eventStatus: EventStatus; curatorProfileId: string; lineupMusicianProfileIds: string[];
}) {
  const router = useRouter();
  const { user } = useAuth();
  const authority = useCommentAuthority(curatorProfileId, lineupMusicianProfileIds);
  const isAdmin = useIsAdmin();
  const isOpen = eventStatus === "published" || eventStatus === "completed";

  const [rows, setRows] = useState<CommentRow[]>([]);
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [replyTarget, setReplyTarget] = useState<CommentRow | null>(null);

  // User-triggered fetch (Retry, Show more, and every post-mutation
  // refresh); never called from the mount effect below, mirroring
  // PayoutHistoryList.tsx's own load/mount split (react-hooks/set-state-in-effect).
  const load = useCallback(async (after: QueryDocumentSnapshot<DocumentData> | null, replace: boolean) => {
    if (replace) setStatus("loading"); else setLoadingMore(true);
    try {
      const page = await fetchCommentsPage(eventId, isAdmin, after);
      setRows((prev) => (replace ? page.rows : [...prev, ...page.rows]));
      setCursor(page.last);
      setHasMore(page.hasMore);
      setStatus("ready");
    } catch {
      if (replace) setStatus("error");
    } finally {
      setLoadingMore(false);
    }
  }, [eventId, isAdmin]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus("loading");
      try {
        const page = await fetchCommentsPage(eventId, isAdmin, null);
        if (cancelled) return;
        setRows(page.rows);
        setCursor(page.last);
        setHasMore(page.hasMore);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, [eventId, isAdmin]);

  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const post = async () => {
    const trimmed = text.trim();
    if (trimmed.length < 1) return;
    setPosting(true); setPostError(null);
    try {
      await callFn("postComment", { eventId, text: trimmed });
      setText("");
      void load(null, true);
    } catch (e) {
      setPostError(e instanceof Error ? e.message : "Could not post this comment.");
    } finally {
      setPosting(false);
    }
  };

  return (
    <View style={{ gap: tokens.space.md }}>
      <Text variant="title">Comments</Text>

      {!isOpen ? (
        <Text muted>{COMMENTS_CLOSED_MESSAGE}</Text>
      ) : !user ? (
        <Button title="Sign in to comment" onPress={() => router.push("/(auth)/sign-in")} style={{ alignSelf: "flex-start" }} />
      ) : (
        <View style={{ gap: tokens.space.sm }}>
          <TextArea
            value={text} onChangeText={(v) => setText(v.slice(0, COMMENT_MAX_CHARS))}
            maxLength={COMMENT_MAX_CHARS} placeholder={COMMENT_COMPOSER_PLACEHOLDER}
            accessibilityLabel={COMMENT_COMPOSER_PLACEHOLDER} editable={!posting}
          />
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text variant="meta" muted>{text.length} / {COMMENT_MAX_CHARS}</Text>
            <Button title={posting ? "Posting…" : "Post"} loading={posting} disabled={text.trim().length === 0}
              onPress={() => void post()} />
          </View>
          {postError && <ErrorBanner message={postError} />}
        </View>
      )}

      {status === "loading" ? (
        <View style={{ gap: tokens.space.sm }}>
          <SkeletonCard />
          <SkeletonCard />
        </View>
      ) : status === "error" ? (
        <View style={{ gap: tokens.space.sm }}>
          <ErrorBanner message="Couldn't load comments." />
          <Button title="Retry" onPress={() => void load(null, true)} style={{ alignSelf: "flex-start" }} />
        </View>
      ) : (
        <FlatList
          // Nested inside the event screen's own ScrollView (brief step 3):
          // scrollEnabled off so this list contributes its own height to the
          // page instead of fighting the outer scroll for gesture ownership,
          // the same trade-off a 20-row page (never more before "Show more"
          // grows it) makes with no real virtualization loss.
          scrollEnabled={false}
          data={rows}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => (
            <View style={{ paddingVertical: tokens.space.xs }}>
              <CommentItem
                eventId={eventId} comment={item} rows={rows} uid={user?.uid} authority={authority}
                isAdmin={isAdmin} isOpen={isOpen} onChanged={() => void load(null, true)} onReply={setReplyTarget}
              />
            </View>
          )}
          ListEmptyComponent={<Text muted>{COMMENTS_EMPTY_MESSAGE}</Text>}
          ListFooterComponent={hasMore ? (
            <Button title={loadingMore ? "Loading…" : SHOW_MORE_LABEL} variant="secondary"
              onPress={() => void load(cursor, false)} disabled={loadingMore}
              style={{ alignSelf: "flex-start", marginTop: tokens.space.xs }} />
          ) : null}
        />
      )}

      <ReplySheet
        visible={replyTarget !== null} onClose={() => setReplyTarget(null)} eventId={eventId}
        parent={replyTarget} onPosted={() => { setReplyTarget(null); void load(null, true); }}
      />
    </View>
  );
}
