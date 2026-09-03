import { useCallback, useEffect, useState } from "react";
import { View, Pressable, KeyboardAvoidingView, Platform } from "react-native";
import { collection, getDocs, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import {
  SHOW_POST_MAX_CHARS, SHOW_POST_LIMIT_MESSAGE, SHOW_POST_RATE_MESSAGE, SHOW_POST_EVENT_CLOSED_MESSAGE,
  type ShowPostDoc,
} from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { useProfileContext } from "../shell/ProfileContext";
import { Text, Card, Button, TextArea, Sheet, ErrorBanner, IconTrash } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// SP7 Task 13: RN twin of apps/web/src/discover/ShowPosts.tsx (Task 9). A
// musician's "show note" thread on one event, plus its one-line preview.
// Split into three exports rather than web's two, because Sheet is a modal
// (unlike web's inline <details>/Textarea), so the composer can't render
// in place under a lineup row: ShowPostsForAct is the read-only list (up to
// 3 live posts, Delete on the caller's own), PostComposerSheet is the modal
// compose form on its own, and LatestPostLine is the quiet one-line preview.
// event/[eventId].tsx mounts ShowPostsForAct (with its own "Post about this
// show" trigger) directly under each lineup row with a profile, matching
// web's EventPageClient.tsx (no disclosure there, the Lineup section is
// already the "more detail" surface). artist/[handle].tsx's own Upcoming
// events rows mount LatestPostLine plus a same-label trigger straight into
// PostComposerSheet instead, per that section's own controller ruling: a
// quiet preview line and a compose action, not a second full list under
// every row.

type PostRow = { id: string } & ShowPostDoc;

// events/{eventId}/posts, status=="live" AND musicianProfileId==id. Two
// equality clauses and no orderBy, so Firestore serves this from the
// single-field indexes it builds automatically: no composite needed, and the
// status pin the rules require is still right there in the query. Ordering
// and the 3-post cut happen client-side, over a result set the server caps
// at 3 anyway (createShowPost enforces a 3-live-posts-per-act-per-event
// limit). The earlier shape asked for the event's newest 3 live posts across
// ALL acts and filtered afterward, which hid an act's own posts entirely
// once another act on the same bill had posted three times. Byte-for-byte
// the web twin's own fetchLivePosts.
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

// Shared composer-visibility gate: a "Post about this show" trigger only
// ever shows for a signed-in member of musicianProfileId whose show hasn't
// ended. Extracted so ShowPostsForAct and the artist page's own
// UpcomingEventRow (apps/mobile/app/artist/[handle].tsx) compute it
// identically instead of each re-deriving isMember/eventEnded on its own.
// `now` is captured once per mount (React Compiler purity rule: no bare
// Date.now() call in the render body), same idiom event/[eventId].tsx's own
// useNow and this file's `now` used to duplicate before this extraction.
export function useShowPostComposerGate(musicianProfileId: string, endsAt: number): {
  isMember: boolean; eventEnded: boolean;
} {
  const { myProfiles } = useProfileContext();
  const isMember = myProfiles.some((p) => p.profileId === musicianProfileId);
  const [now] = useState(() => Date.now());
  const eventEnded = endsAt <= now;
  return { isMember, eventEnded };
}

function PostRowItem({ post, canRemove, onRemoved }: {
  post: PostRow; canRemove: boolean; onRemoved: (postId: string) => void;
}) {
  const t = useTokens();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await httpsCallable(getFirebase().functions, "removeShowPost")({ eventId: post.eventId, postId: post.id });
      onRemoved(post.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove. Try again.");
      setBusy(false);
    }
  };

  return (
    <Card style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: tokens.space.sm }}>
        <Text style={{ flex: 1 }}>{post.text}</Text>
        {canRemove && (
          <Pressable
            onPress={() => void remove()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Delete this post"
            style={{ opacity: busy ? 0.5 : 1, padding: 4 }}
          >
            <IconTrash size={16} color={t.muted} />
          </Pressable>
        )}
      </View>
      <Text variant="meta" muted>{new Date(post.createdAt).toLocaleString()}</Text>
      {error && <ErrorBanner message={error} />}
    </Card>
  );
}

// The full read-only thread for one act on one event, plus (for a signed-in
// member of musicianProfileId) a "Post about this show" trigger into
// PostComposerSheet. Membership comes from useProfileContext().myProfiles
// (already loaded app-wide, unlike web's own per-mount membership getDoc):
// never for curators or strangers, and hidden until myProfiles itself has
// resolved.
export function ShowPostsForAct({ eventId, musicianProfileId, artistName, endsAt }: {
  eventId: string; musicianProfileId: string; artistName: string; endsAt: number;
}) {
  const [posts, setPosts] = useState<PostRow[] | "loading">("loading");
  const [composerOpen, setComposerOpen] = useState(false);

  const refresh = useCallback(() => {
    fetchLivePosts(eventId, musicianProfileId)
      .then((rows) => setPosts(rows))
      .catch(() => setPosts([]));
  }, [eventId, musicianProfileId]);

  useEffect(() => { refresh(); }, [refresh]);

  // A client-side pre-check only; the server's own SHOW_POST_EVENT_CLOSED_MESSAGE
  // stays the real authority on a real attempt.
  const { isMember, eventEnded } = useShowPostComposerGate(musicianProfileId, endsAt);
  const showComposerTrigger = isMember && !eventEnded;

  return (
    <View style={{ gap: tokens.space.sm }}>
      {posts === "loading" && <Text variant="meta" muted>Loading posts…</Text>}
      {posts !== "loading" && posts.length > 0 && (
        <View style={{ gap: tokens.space.xs }}>
          {posts.map((p) => (
            <PostRowItem key={p.id} post={p} canRemove={isMember} onRemoved={refresh} />
          ))}
        </View>
      )}
      {posts !== "loading" && posts.length === 0 && !showComposerTrigger && (
        <Text variant="meta" muted>No posts yet about this show.</Text>
      )}
      {isMember && eventEnded && (
        <Text variant="meta" muted>This show has ended, so posting is closed.</Text>
      )}
      {showComposerTrigger && (
        <Button
          variant="secondary" title="Post about this show" onPress={() => setComposerOpen(true)}
          style={{ alignSelf: "flex-start" }}
        />
      )}
      <PostComposerSheet
        visible={composerOpen}
        onClose={() => setComposerOpen(false)}
        eventId={eventId}
        musicianProfileId={musicianProfileId}
        artistName={artistName}
        onPosted={() => { setComposerOpen(false); refresh(); }}
      />
    </View>
  );
}

// The compose form on its own: a Sheet (TextArea + counter + Button
// title="Post"), reused by ShowPostsForAct's own trigger and by the artist
// page's Upcoming events rows. Copy byte-matched to the web twin's own
// placeholder, counter, and button label.
export function PostComposerSheet({ visible, onClose, eventId, musicianProfileId, artistName, onPosted }: {
  visible: boolean; onClose: () => void; eventId: string; musicianProfileId: string; artistName: string;
  onPosted: () => void;
}) {
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = async () => {
    const trimmed = text.trim();
    if (trimmed.length < 1) return;
    setPosting(true);
    setError(null);
    try {
      await httpsCallable(getFirebase().functions, "createShowPost")({ eventId, musicianProfileId, text: trimmed });
      setText("");
      onPosted();
    } catch (e) {
      setError(showPostErrorMessage(e));
    } finally {
      setPosting(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={() => { if (!posting) onClose(); }}>
      {/* Sheet itself takes no stance on keyboard avoidance (its own header
          comment: "a caller putting a form inside a Sheet is responsible for
          its own KeyboardAvoidingView"); without this, the keyboard covers
          the TextArea/counter/Post row on device. iOS needs an explicit
          "padding" behavior to shift the sheet's own content up; Android's
          own default resize behavior already handles this without one, so
          `behavior` is left undefined there rather than forcing a second,
          redundant shift. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={{ gap: tokens.space.md }}>
          <Text variant="title">Post about this show</Text>
          <TextArea
            value={text} onChangeText={(v) => setText(v.slice(0, SHOW_POST_MAX_CHARS))}
            maxLength={SHOW_POST_MAX_CHARS} placeholder="What should fans know about this show?"
            accessibilityLabel={`Post as ${artistName} about this show`} editable={!posting}
          />
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: tokens.space.sm }}>
            <Text variant="meta" muted>{text.length} / {SHOW_POST_MAX_CHARS}</Text>
            <Button
              title={posting ? "Posting…" : "Post"} onPress={() => void post()}
              disabled={posting || text.trim().length === 0}
            />
          </View>
          {error && <ErrorBanner message={error} />}
        </View>
      </KeyboardAvoidingView>
    </Sheet>
  );
}

// One quoted line, the newest live post by this act on this event: a quiet
// signal on a row that otherwise carries no hint that a post exists at all.
// Renders nothing while loading or when there is none, matching this app's
// own hidden-while-empty contract for optional row content.
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
  return (
    <Text variant="meta" muted numberOfLines={1} style={{ fontStyle: "italic" }}>
      &quot;{post.text}&quot;
    </Text>
  );
}
