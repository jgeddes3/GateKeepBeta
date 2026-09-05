"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  collection, doc, getDoc, getDocs, limit, orderBy, query, startAfter, where,
  type DocumentData, type QueryDocumentSnapshot,
} from "firebase/firestore";
import {
  COMMENT_MAX_CHARS, COMMENT_PAGE_SIZE, COMMENT_COMPOSER_PLACEHOLDER, COMMENT_REPLY_LABEL,
  COMMENT_HIDE_LABEL, COMMENT_DELETE_LABEL, COMMENTS_CLOSED_MESSAGE, COMMENTS_EMPTY_MESSAGE,
  commentHiddenLine, COMMENT_DELETED_LINE, REPORT_LABEL, REPORT_REASON_PROMPT,
  REPORT_REASON_MAX_CHARS, REPORT_SENT_MESSAGE, REPORT_DUPLICATE_MESSAGE, SHOW_MORE_LABEL,
  type EventCommentDoc, type EventStatus,
} from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { useAuth } from "../auth/AuthProvider";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";
import { ErrorBox } from "../ui/ErrorBox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { IconEyeSlash, IconTrash, IconWarning } from "../ui/icons";

// SP12 (spec 3.2 and 5). Fan comments on the public event page: a paged,
// newest-first list plus a top composer, with reply, hide, delete, and
// report wired to the callables comments.ts and reports.ts already ship.
// Task 12's mobile twin mirrors every exported name here.

export type CommentAuthority = "loading" | "curator" | "artist" | "fan" | "signedOut";

// One getDoc on the curator's own membership doc, plus one per lineup act,
// all inside a single Promise.all(...).then(...): no synchronous setState in
// the effect body (eslint-config-next's React Compiler rule), the same
// reason ShowPostsForAct.tsx's own membership lookup routes even its
// signed-out "nothing to check" case through Promise.resolve(...).then(...)
// rather than a direct call. A client hint ONLY: postComment, hideComment,
// and deleteComment each re-derive authority server-side.
export function useCommentAuthority(
  curatorProfileId: string, lineupMusicianProfileIds: string[], uid: string | undefined,
): CommentAuthority {
  const [authority, setAuthority] = useState<CommentAuthority>("loading");
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const lookup: Promise<CommentAuthority> = uid
      ? Promise.all([
        getDoc(doc(db, `profiles/${curatorProfileId}/members/${uid}`)).then((s) => s.exists()).catch(() => false),
        ...lineupMusicianProfileIds.map((id) =>
          getDoc(doc(db, `profiles/${id}/members/${uid}`)).then((s) => s.exists()).catch(() => false)),
      ]).then(([isCurator, ...isArtist]): CommentAuthority => (
        isCurator ? "curator" : isArtist.some(Boolean) ? "artist" : "fan"
      ))
      : Promise.resolve<CommentAuthority>("signedOut");
    lookup.then((result) => { if (!cancelled) setAuthority(result); });
    return () => { cancelled = true; };
    // lineupMusicianProfileIds is a fresh array every render (EventPageClient
    // reads it straight off the event doc); keying on its serialized
    // identity avoids refetching every render while still refetching when
    // the lineup itself actually changes, the same idiom
    // PayoutHistoryList.tsx uses for its own object-shaped dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curatorProfileId, JSON.stringify(lineupMusicianProfileIds), uid]);
  return authority;
}

// Platform-admin claim: EventComments needs to know this before it can even
// pick a query shape (Step 3's own comment: the admin and non-admin queries
// are not interchangeable, firestore.rules refuses the unpinned one to
// anybody else). Not forced (unlike AdminGate.tsx's own admin-only-route
// check): almost every visitor here is a fan, and forcing a token refresh
// for each of them just to answer "no" would be real, needless cost.
function useIsAdmin(uid: string | undefined): boolean {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const lookup = user ? user.getIdTokenResult().then((t) => t.claims.admin === true).catch(() => false) : Promise.resolve(false);
    lookup.then((result) => { if (!cancelled) setIsAdmin(result); });
    return () => { cancelled = true; };
  }, [user, uid]);
  return isAdmin;
}

type Row = { id: string } & EventCommentDoc;
type Cursor = QueryDocumentSnapshot<DocumentData> | null;

async function fetchCommentsPage(
  eventId: string, isAdmin: boolean, after: Cursor,
): Promise<{ rows: Row[]; cursor: Cursor; done: boolean }> {
  const base = collection(getFirebase().db, `events/${eventId}/comments`);
  // Admins see hidden comments too (spec 3.2), which needs a query WITHOUT
  // the hidden pin; firestore.rules allows exactly that for an admin and
  // refuses it for everyone else. The pinned shape is what the
  // (hidden, at desc) composite index serves.
  const q = isAdmin
    ? (after
      ? query(base, orderBy("at", "desc"), startAfter(after), limit(COMMENT_PAGE_SIZE))
      : query(base, orderBy("at", "desc"), limit(COMMENT_PAGE_SIZE)))
    : (after
      ? query(base, where("hidden", "==", false), orderBy("at", "desc"), startAfter(after), limit(COMMENT_PAGE_SIZE))
      : query(base, where("hidden", "==", false), orderBy("at", "desc"), limit(COMMENT_PAGE_SIZE)));
  const snap = await getDocs(q);
  const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as EventCommentDoc) }));
  const last = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : after;
  return { rows, cursor: last, done: snap.docs.length < COMMENT_PAGE_SIZE };
}

function commentErrorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

// One composer shape for both the top-level "Add a comment" box and every
// reply box: a real <form> (Enter-to-submit, audit item #21) with a counter,
// an optional Cancel, and the server refusal (the rate sentence, the length
// sentence) surfaced verbatim.
function CommentComposer({ eventId, parentId, ariaLabel, submitLabel, onCancel, onPosted }: {
  eventId: string; parentId?: string; ariaLabel: string; submitLabel: string;
  onCancel?: () => void; onPosted: () => void;
}) {
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (trimmed.length === 0 || posting) return;
    setPosting(true);
    setError(null);
    try {
      await callFn("postComment", parentId ? { eventId, text: trimmed, parentId } : { eventId, text: trimmed });
      setText("");
      onPosted();
    } catch (e) {
      setError(commentErrorMessage(e, "Could not post. Try again."));
    } finally {
      setPosting(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-2">
      <Textarea
        aria-label={ariaLabel} placeholder={ariaLabel} maxLength={COMMENT_MAX_CHARS}
        value={text} onChange={(e) => setText(e.target.value)} disabled={posting} rows={parentId ? 2 : 3}
      />
      <div className="flex items-center justify-between gap-3">
        <span className="font-sora text-xs text-gk-muted">{text.length} / {COMMENT_MAX_CHARS}</span>
        <div className="flex gap-2">
          {onCancel && (
            <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={posting}>Cancel</Button>
          )}
          <Button type="submit" size="sm" disabled={posting || text.trim().length === 0}>
            {posting ? "Posting…" : submitLabel}
          </Button>
        </div>
      </div>
      {error && <ErrorBox message={error} />}
    </form>
  );
}

function CommentRow({ eventId, row, uid, authority, replies, parentMissing, onOptimisticRemove, onRowActionError, reconcile }: {
  eventId: string; row: Row; uid: string | undefined; authority: CommentAuthority; replies: Row[]; parentMissing: boolean;
  onOptimisticRemove: (commentId: string) => void; onRowActionError: (message: string) => void; reconcile: () => void;
}) {
  const isReply = row.parentId !== null;
  const [replyOpen, setReplyOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportResult, setReportResult] = useState<string | null>(null);

  // Reply is offered only on a top-level comment (a reply to a reply is
  // refused server-side); Hide follows authority alone, independent of
  // authorship; Delete is author-only; Report is the fallback for everyone
  // else, exactly the priority spec 3.2 and this task's brief lay out.
  const canReply = !isReply && !!uid;
  const canHide = !!uid && (authority === "curator" || authority === "artist");
  const canDelete = !!uid && row.authorUid === uid;
  const canReport = !!uid && !canHide && !canDelete;

  // Optimistic (Step 3: "Hide and Delete act optimistically and reconcile by
  // refetching page one"): the row vanishes from this list the instant it's
  // pressed, before the callable even resolves. reconcile() then re-fetches
  // page one in the background, silently, with no loading flash, so a
  // rejected call (or a row an admin viewer should still see, hidden and
  // annotated) puts it right back rather than leaving a stale gap.
  const hide = async () => {
    setBusy(true);
    onOptimisticRemove(row.id);
    try {
      await callFn("hideComment", { eventId, commentId: row.id });
    } catch (e) {
      // The row is already gone from view (removed above), so a failure is
      // surfaced up at the list level rather than on this soon-to-unmount
      // instance; reconcile() below puts the row right back regardless.
      onRowActionError(commentErrorMessage(e, "Could not hide this comment."));
    } finally {
      setBusy(false);
      reconcile();
    }
  };

  const remove = async () => {
    setBusy(true);
    onOptimisticRemove(row.id);
    try {
      await callFn("deleteComment", { eventId, commentId: row.id });
    } catch (e) {
      onRowActionError(commentErrorMessage(e, "Could not delete this comment."));
    } finally {
      setBusy(false);
      reconcile();
    }
  };

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
      await callFn("reportComment", { eventId, commentId: row.id, reason: trimmed });
      setReportResult(REPORT_SENT_MESSAGE);
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      // A duplicate report is not a failure (spec: a reporter cannot read
      // the reports collection, so this is the only way to learn a first
      // attempt already landed): rendered as the same calm line as success,
      // never inside an ErrorBox.
      if (message === REPORT_DUPLICATE_MESSAGE) setReportResult(REPORT_DUPLICATE_MESSAGE);
      else setReportError(message || "Could not send this report.");
    } finally {
      setReportBusy(false);
    }
  };

  // Shared between the hidden and the normal render below: an admin's query
  // includes hidden top-level comments (fetchCommentsPage above), so a
  // hidden row still needs its own nested replies rendered, exactly like a
  // visible one. Non-admins never reach this branch with a hidden parent,
  // since their own query excludes hidden rows entirely.
  const repliesList = replies.length > 0 && (
    <ul className="mt-1 grid gap-2 border-l border-gk-border pl-3">
      {replies.map((reply) => (
        <CommentRow
          key={reply.id} eventId={eventId} row={reply} uid={uid} authority={authority} replies={[]} parentMissing={false}
          onOptimisticRemove={onOptimisticRemove} onRowActionError={onRowActionError} reconcile={reconcile}
        />
      ))}
    </ul>
  );

  if (row.hidden) {
    const who = row.hiddenBy?.role === "admin" ? "an admin" : row.hiddenBy?.role === "curator" ? "the curator" : "an artist";
    return (
      <li className="grid gap-1 rounded-gk-sm border border-gk-border bg-gk-surface p-3">
        <span className="font-syne text-sm font-semibold text-gk-text">{row.authorName}</span>
        <p className="font-sora text-xs text-gk-muted">{commentHiddenLine(who)}</p>
        <p className="whitespace-pre-wrap font-sora text-sm text-gk-muted">{row.text}</p>
        {repliesList}
      </li>
    );
  }

  return (
    <li className="grid gap-1.5 rounded-gk-sm border border-gk-border bg-gk-surface p-3">
      {/* A reply whose real parent is not on this loaded page (hidden from
          this query, or deleted) has nowhere to nest, so it renders at the
          top level with this quoted line standing in for the parent it
          can't show. A reply nested under its rendered parent (below) never
          shows this line, regardless of isReply. */}
      {parentMissing && <p className="font-sora text-xs italic text-gk-muted">{COMMENT_DELETED_LINE}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-syne text-sm font-semibold text-gk-text">{row.authorName}</span>
        {row.authorRole !== "fan" && (
          <Badge variant="secondary">{row.authorRole === "curator" ? "Curator" : "Artist"}</Badge>
        )}
      </div>
      <p className="font-sora text-xs text-gk-muted">{new Date(row.at).toLocaleString()}</p>
      <p className="whitespace-pre-wrap font-sora text-sm text-gk-text">{row.text}</p>

      <div className="flex flex-wrap gap-3">
        {canReply && (
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setReplyOpen((o) => !o)}>
            {COMMENT_REPLY_LABEL}
          </Button>
        )}
        {canHide && (
          <Button type="button" variant="link" size="sm" className="h-auto gap-1 p-0" disabled={busy} onClick={() => void hide()}>
            <IconEyeSlash size={14} aria-hidden="true" />{COMMENT_HIDE_LABEL}
          </Button>
        )}
        {canDelete && (
          <Button type="button" variant="link" size="sm" className="h-auto gap-1 p-0 text-gk-destructive" disabled={busy} onClick={() => void remove()}>
            <IconTrash size={14} aria-hidden="true" />{COMMENT_DELETE_LABEL}
          </Button>
        )}
        {canReport && (
          <Button type="button" variant="link" size="sm" className="h-auto gap-1 p-0" onClick={() => setReportOpen(true)}>
            <IconWarning size={14} aria-hidden="true" />{REPORT_LABEL}
          </Button>
        )}
      </div>

      {replyOpen && (
        <CommentComposer
          eventId={eventId} parentId={row.id} ariaLabel={`Reply to ${row.authorName}`} submitLabel={COMMENT_REPLY_LABEL}
          onCancel={() => setReplyOpen(false)}
          onPosted={() => { setReplyOpen(false); reconcile(); }}
        />
      )}

      {repliesList}

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
                aria-label={REPORT_REASON_PROMPT} maxLength={REPORT_REASON_MAX_CHARS}
                value={reportReason} onChange={(e) => setReportReason(e.target.value)} disabled={reportBusy} rows={4}
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
                <Button type="button" onClick={() => void submitReport()} disabled={reportBusy || reportReason.trim().length === 0}>
                  {reportBusy ? "Sending…" : REPORT_LABEL}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

function CommentsSkeleton() {
  return (
    <div className="grid gap-2" role="status" aria-label="Loading comments">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

export function EventComments({ eventId, eventStatus, curatorProfileId, lineupMusicianProfileIds, commentCount }: {
  eventId: string; eventStatus: EventStatus; curatorProfileId: string;
  lineupMusicianProfileIds: string[]; commentCount: number;
}) {
  const { user } = useAuth();
  const uid = user?.uid;
  const authority = useCommentAuthority(curatorProfileId, lineupMusicianProfileIds, uid);
  const isAdmin = useIsAdmin(uid);

  const [rows, setRows] = useState<Row[] | "loading" | "error">("loading");
  const [cursor, setCursor] = useState<Cursor>(null);
  const [done, setDone] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [rowActionError, setRowActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Page one, fetched fresh on mount, whenever isAdmin resolves (it starts
  // false, so an admin's own broader query kicks in the moment their claim
  // is known), and on every explicit retry() bump. No setState call runs
  // synchronously in the effect body itself (react-hooks/set-state-in-effect):
  // retry() below is what flips rows to "loading", from a click handler,
  // never this effect; rows starts "loading" via its own useState default,
  // which covers the very first run.
  useEffect(() => {
    let cancelled = false;
    fetchCommentsPage(eventId, isAdmin, null)
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows);
        setCursor(res.cursor);
        setDone(res.done);
      })
      .catch(() => { if (!cancelled) setRows("error"); });
    return () => { cancelled = true; };
  }, [eventId, isAdmin, reloadKey]);

  // The error-state Retry button: a full reload, loading skeleton and all.
  const retry = () => {
    setRows("loading");
    setLoadMoreError(null);
    setRowActionError(null);
    setReloadKey((k) => k + 1);
  };

  // Silent background refetch of page one: used to reconcile a new
  // comment/reply, a hide, or a delete against server truth, without
  // discarding the already-rendered list in the meantime (Step 3: "Hide and
  // Delete act optimistically and reconcile by refetching page one"). A
  // failure here just leaves whatever the optimistic update already showed.
  const reconcile = () => {
    fetchCommentsPage(eventId, isAdmin, null)
      .then((res) => {
        setRows(res.rows);
        setCursor(res.cursor);
        setDone(res.done);
      })
      .catch(() => {});
  };

  // The instant, pre-network-call half of "optimistic": drop the row from
  // view the moment Hide or Delete is pressed. reconcile() (above) is what
  // actually confirms the outcome, whether that means the row stays gone or
  // (a failed call, or a hidden row an admin viewer is still owed) comes
  // back.
  const removeRowLocally = (commentId: string) => {
    setRows((prev) => (prev === "loading" || prev === "error" ? prev : prev.filter((r) => r.id !== commentId)));
  };

  const loadMore = async () => {
    if (rows === "loading" || rows === "error" || done || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const res = await fetchCommentsPage(eventId, isAdmin, cursor);
      setRows((prev) => (prev === "loading" || prev === "error" ? res.rows : [...prev, ...res.rows]));
      setCursor(res.cursor);
      setDone(res.done);
    } catch {
      setLoadMoreError("Couldn't load more comments.");
    } finally {
      setLoadingMore(false);
    }
  };

  const commentsOpen = eventStatus === "published" || eventStatus === "completed";
  const list = rows === "loading" || rows === "error" ? [] : rows;

  // Top-level comments render at the top level; a reply nests under its
  // parent WHEN that parent is loaded on this same page, grouped client-side
  // (Step 3). A reply whose parent isn't loaded (hidden from this query, or
  // deleted) has no row to nest under, so it falls into the top-level list
  // too; parentMissingById flags exactly those rows so CommentRow renders
  // its quoted COMMENT_DELETED_LINE only for them, not for every reply
  // (spec 3.2: a reply nested under a rendered parent never shows the line).
  const byId = new Map(list.map((r) => [r.id, r]));
  const childrenOf = new Map<string, Row[]>();
  const displayRows: Row[] = [];
  const parentMissingById = new Map<string, boolean>();
  for (const r of list) {
    if (r.parentId && byId.has(r.parentId)) {
      const siblings = childrenOf.get(r.parentId) ?? [];
      siblings.push(r);
      childrenOf.set(r.parentId, siblings);
    } else {
      displayRows.push(r);
      parentMissingById.set(r.id, r.parentId !== null);
    }
  }
  for (const siblings of childrenOf.values()) siblings.sort((a, b) => a.at - b.at);

  return (
    <div className="mt-6 grid gap-4">
      <h2 className="font-syne text-lg font-semibold text-gk-text">
        Comments{commentCount > 0 ? ` (${commentCount})` : ""}
      </h2>

      {commentsOpen ? (
        user ? (
          <CommentComposer
            eventId={eventId} ariaLabel={COMMENT_COMPOSER_PLACEHOLDER} submitLabel="Post"
            onPosted={reconcile}
          />
        ) : (
          <Button asChild variant="secondary" className="w-fit">
            <Link href={`/sign-in?next=${encodeURIComponent(`/e/${eventId}`)}`}>Sign in to comment</Link>
          </Button>
        )
      ) : (
        <p className="font-sora text-sm text-gk-muted">{COMMENTS_CLOSED_MESSAGE}</p>
      )}

      {rows === "loading" && <CommentsSkeleton />}
      {rows === "error" && (
        <div className="grid gap-2">
          <ErrorBox message="Couldn't load comments." />
          <Button type="button" variant="secondary" onClick={retry} className="w-fit">Retry</Button>
        </div>
      )}
      {rows !== "loading" && rows !== "error" && displayRows.length === 0 && (
        <p className="font-sora text-sm text-gk-muted">{COMMENTS_EMPTY_MESSAGE}</p>
      )}
      {rowActionError && <ErrorBox message={rowActionError} />}
      {rows !== "loading" && rows !== "error" && displayRows.length > 0 && (
        <ul className="grid gap-2">
          {displayRows.map((row) => (
            <CommentRow
              key={row.id} eventId={eventId} row={row} uid={uid} authority={authority}
              replies={childrenOf.get(row.id) ?? []} parentMissing={parentMissingById.get(row.id) ?? false}
              onOptimisticRemove={removeRowLocally} onRowActionError={setRowActionError} reconcile={reconcile}
            />
          ))}
        </ul>
      )}
      {rows !== "loading" && rows !== "error" && !done && (
        <div className="grid gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => void loadMore()} disabled={loadingMore} className="w-fit">
            {loadingMore ? "Loading…" : SHOW_MORE_LABEL}
          </Button>
          {loadMoreError && <ErrorBox message={loadMoreError} />}
        </div>
      )}
    </div>
  );
}
