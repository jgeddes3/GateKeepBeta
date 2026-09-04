"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import {
  SHOW_POST_MAX_CHARS, SHOW_POST_LIMIT_MESSAGE, SHOW_POST_RATE_MESSAGE, SHOW_POST_EVENT_CLOSED_MESSAGE,
  type ShowPostDoc,
} from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { useAuth } from "../auth/AuthProvider";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { IconTrash, IconWarning } from "../ui/icons";

// Task 9: a musician's "show note" thread on one event, and its one-line
// preview. Two exports because the two call sites (MusicianProfile.tsx's
// upcoming-events rows) need different weights: LatestPostLine is a quiet
// always-visible line, ShowPostsForAct is the full list + composer, mounted
// inside a collapsible so the public page stays quiet by default (see
// ShowPostsDisclosure below). EventPageClient.tsx mounts ShowPostsForAct
// directly (no collapsible there: the event page's own Lineup section is
// already the "more detail" surface).

type PostRow = { id: string } & ShowPostDoc;

// events/{eventId}/posts, status=="live" AND musicianProfileId==id. Two
// equality clauses and no orderBy, so Firestore serves this from the
// single-field indexes it builds automatically: no composite needed, and the
// status pin the rules require is still right there in the query. Ordering
// and the 3-post cut happen client-side, over a result set the server caps
// at 3 anyway (createShowPost enforces a 3-live-posts-per-act-per-event
// limit). The earlier shape asked for the event's newest 3 live posts across
// ALL acts and filtered afterward, which hid an act's own posts entirely
// once another act on the same bill had posted three times.
async function fetchLivePosts(eventId: string, musicianProfileId: string): Promise<PostRow[]> {
  const snap = await getDocs(query(
    collection(getFirebase().db, `events/${eventId}/posts`),
    where("status", "==", "live"), where("musicianProfileId", "==", musicianProfileId),
  ));
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as ShowPostDoc) }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 3);
}

function showPostErrorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : "";
  if (message === SHOW_POST_LIMIT_MESSAGE || message === SHOW_POST_RATE_MESSAGE || message === SHOW_POST_EVENT_CLOSED_MESSAGE) {
    return message;
  }
  return "Could not post. Try again.";
}

function PostRowItem({ post, canRemove, onRemoved }: {
  post: PostRow; canRemove: boolean; onRemoved: (postId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await callFn("removeShowPost", { eventId: post.eventId, postId: post.id });
      onRemoved(post.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove. Try again.");
      setBusy(false);
    }
  };

  return (
    <li className="grid gap-1 rounded-gk-sm border border-gk-border bg-gk-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 whitespace-pre-wrap font-sora text-sm text-gk-text">{post.text}</p>
        {canRemove && (
          <button
            type="button" aria-label="Delete this post" disabled={busy} onClick={() => void remove()}
            className="shrink-0 rounded-gk-sm p-1 text-gk-muted outline-none hover:text-gk-destructive focus-visible:ring-2 focus-visible:ring-gk-focus disabled:opacity-50"
          >
            <IconTrash size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <p className="font-sora text-xs text-gk-muted">{new Date(post.createdAt).toLocaleString()}</p>
      {error && <p role="alert" className="font-sora text-xs text-gk-destructive">{error}</p>}
    </li>
  );
}

// The full thread for one act on one event: its up-to-3 live posts, and, for
// a signed-in member of musicianProfileId (one getDoc on its own membership
// doc, the same profiles/{id}/members/{uid} shape every other member-gated
// control on this page already reads), a composer to add another.
export function ShowPostsForAct({ eventId, musicianProfileId, artistName, endsAt }: {
  eventId: string; musicianProfileId: string; artistName: string; endsAt: number;
}) {
  const { user } = useAuth();
  const [posts, setPosts] = useState<PostRow[] | "loading">("loading");
  const [isMember, setIsMember] = useState(false);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchLivePosts(eventId, musicianProfileId)
      .then((rows) => setPosts(rows))
      .catch(() => setPosts([]));
  }, [eventId, musicianProfileId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    // Every setIsMember call below runs inside a .then()/.catch() callback,
    // never synchronously in the effect body (eslint-config-next's React
    // Compiler rules flag the latter): a signed-out visitor resolves through
    // Promise.resolve(false).then(...) rather than a direct call, so this
    // stays consistent even for the "nothing to check" case.
    let cancelled = false;
    const lookup = user
      ? getDoc(doc(getFirebase().db, "profiles", musicianProfileId, "members", user.uid))
        .then((snap) => snap.exists())
        .catch(() => false)
      : Promise.resolve(false);
    lookup.then((isMemberNow) => { if (!cancelled) setIsMember(isMemberNow); });
    return () => { cancelled = true; };
  }, [user, musicianProfileId]);

  const post = async () => {
    const trimmed = text.trim();
    if (trimmed.length < 1) return;
    setPosting(true);
    setPostError(null);
    try {
      await callFn("createShowPost", { eventId, musicianProfileId, text: trimmed });
      setText("");
      refresh();
    } catch (e) {
      setPostError(showPostErrorMessage(e));
    } finally {
      setPosting(false);
    }
  };

  // Captured once per mount, not a bare Date.now() call in the render body
  // (eslint-config-next's React Compiler purity rule forbids that; same
  // idiom ShowsList.tsx's own `now` state uses, for the identical reason).
  // A client-side pre-check only, not the server's own authority (which
  // stays SHOW_POST_EVENT_CLOSED_MESSAGE, surfaced verbatim on a real
  // attempt): a member past the show's end time sees a plain "closed" note
  // instead of a composer that would only ever be rejected.
  const [now] = useState(() => Date.now());
  const eventEnded = endsAt <= now;
  const showComposer = isMember && !eventEnded;

  return (
    <div className="grid gap-3">
      {posts === "loading" && <p className="font-sora text-sm text-gk-muted">Loading posts…</p>}
      {posts !== "loading" && posts.length > 0 && (
        <ul className="grid gap-2">
          {posts.map((p) => (
            <PostRowItem key={p.id} post={p} canRemove={isMember} onRemoved={refresh} />
          ))}
        </ul>
      )}
      {posts !== "loading" && posts.length === 0 && !showComposer && (
        <p className="font-sora text-sm text-gk-muted">No posts yet about this show.</p>
      )}
      {isMember && eventEnded && (
        <p className="font-sora text-sm text-gk-muted">This show has ended, so posting is closed.</p>
      )}
      {showComposer && (
        <div className="grid gap-2">
          <Textarea
            value={text} onChange={(e) => setText(e.target.value.slice(0, SHOW_POST_MAX_CHARS))}
            maxLength={SHOW_POST_MAX_CHARS} rows={2} placeholder="What should fans know about this show?"
            aria-label={`Post as ${artistName} about this show`} disabled={posting}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="font-sora text-xs text-gk-muted">{text.length} / {SHOW_POST_MAX_CHARS}</span>
            <Button type="button" size="sm" onClick={() => void post()} disabled={posting || text.trim().length === 0}>
              {posting ? "Posting…" : "Post"}
            </Button>
          </div>
          {postError && (
            <p role="alert" className="flex items-start gap-2 font-sora text-sm text-gk-destructive">
              <IconWarning size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              {postError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// One quoted line, the newest live post by this act on this event: a quiet
// signal on the profile page's own upcoming-events row (which otherwise
// carries no hint that a post exists at all). Renders nothing while loading
// or when there is none, matching this page's own "hidden while empty"
// contract for every other optional bit of row content.
export function LatestPostLine({ eventId, musicianProfileId }: { eventId: string; musicianProfileId: string }) {
  const [post, setPost] = useState<PostRow | null | "loading">("loading");

  useEffect(() => {
    let cancelled = false;
    fetchLivePosts(eventId, musicianProfileId)
      .then((rows) => { if (!cancelled) setPost(rows[0] ?? null); })
      .catch(() => { if (!cancelled) setPost(null); });
    return () => { cancelled = true; };
  }, [eventId, musicianProfileId]);

  if (post === "loading" || post === null) return null;
  return <p className="mt-1 truncate font-sora text-xs italic text-gk-muted">&quot;{post.text}&quot;</p>;
}

// Fix round 1 (review, Important): MusicianProfile.tsx's own <details> used
// to wrap ShowPostsForAct directly, but a plain <details> mounts its
// children into the DOM regardless of the open/closed state (only their
// visual rendering is hidden), so ShowPostsForAct's two effects (the posts
// fetch, duplicating LatestPostLine's own fetch on the row right above it,
// and, when signed in, a membership getDoc) fired on every profile-page
// visit for every upcoming-events row, collapsed or not. This client
// wrapper lazy-mounts its children instead: nothing renders inside until
// the first time the <details> is opened, and it stays mounted afterward
// (closing again doesn't re-fetch on next open). MusicianProfile.tsx stays
// a Server Component with no client state of its own; this is the one
// small "use client" boundary that gates it.
export function ShowPostsDisclosure({ summary, children }: { summary: string; children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  return (
    <details
      className="ml-2 rounded-gk-sm"
      onToggle={(e) => { if (e.currentTarget.open) setOpened(true); }}
    >
      <summary className="cursor-pointer list-none font-sora text-xs font-medium text-gk-muted outline-none [&::-webkit-details-marker]:hidden hover:text-gk-text focus-visible:ring-2 focus-visible:ring-gk-focus">
        {summary}
      </summary>
      <div className="mt-2">{opened && children}</div>
    </details>
  );
}
