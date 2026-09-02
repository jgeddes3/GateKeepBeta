import { useEffect, useRef, useState } from "react";
import { View, ScrollView, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { doc, getDoc } from "firebase/firestore";
import { genreTargetId, parseGenreTarget, type ProfileDoc } from "@gatekeep/shared";
import { getFirebase } from "../../src/lib/firebase";
import { useFollowsContext, unfollow } from "../../src/discover/useFollows";
import { formatChipLabel } from "../../src/discover/discoverQueries";
import { GenrePickerSheet } from "../../src/discover/GenrePickerSheet";
import {
  Text, Button, Card, ErrorBanner, Skeleton, PageBackground, IconHeart,
} from "../../src/ui";
import { useTokens } from "../../src/theme/ThemeProvider";
import { tokens } from "../../src/theme/tokens";

// SP7 Task 11: the fan's own follows management screen. No direct web twin
// exists yet (Tasks 8/9 shipped the discover lists and genre picker, not a
// "manage your follows" page); this screen groups the three FollowTargetType
// kinds useFollows' own `targets`/`genres` return, resolving each non-genre
// target's display name and type via a cached getDoc(profiles/{id}) lookup
// (a FollowDoc's own targetId alone doesn't say whether it's a musician or a
// curator; the profile doc does), the same fetch-and-cache shape
// src/tickets/TicketList.tsx's useEventCache already establishes for events.

type ProfileLoad = { kind: "ok"; profile: ProfileDoc } | { kind: "unavailable" };

// One-shot fetch-and-cache for every distinct profile-shaped targetId
// useFollows reports. `requested` is a ref (not state) for the same reason
// useEventCache's own header comment gives: this effect's dependency is the
// joined id list, and reading a STATE `requested` from inside it would need
// `requested` in the dependency array too, re-running the effect (and
// briefly re-requesting every id) on every one of this same effect's own
// updates to it.
function useProfileCache(ids: string[]): Record<string, ProfileLoad> {
  const [cache, setCache] = useState<Record<string, ProfileLoad>>({});
  const requested = useRef(new Set<string>());
  useEffect(() => {
    const missing = ids.filter((id) => !requested.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) requested.current.add(id);
    let cancelled = false;
    const { db } = getFirebase();
    void Promise.all(missing.map(async (id) => {
      try {
        const snap = await getDoc(doc(db, "profiles", id));
        return [id, snap.exists() ? { kind: "ok" as const, profile: snap.data() as ProfileDoc } : { kind: "unavailable" as const }] as const;
      } catch (e) {
        const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
        if (code !== "permission-denied") console.warn("useProfileCache: profile load failed", id, e);
        return [id, { kind: "unavailable" as const }] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      setCache((prev) => {
        const next = { ...prev };
        for (const [id, load] of entries) next[id] = load;
        return next;
      });
    });
    return () => { cancelled = true; };
    // Deliberately keyed on the joined id list, not the `ids` array
    // reference: this component recomputes that array's identity on every
    // render even when its contents are unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(",")]);
  return cache;
}

function FollowRow({ title, subtitle, onPress, onUnfollow, pending, error }: {
  title: string; subtitle?: string; onPress?: () => void; onUnfollow: () => void; pending: boolean; error: string | null;
}) {
  const content = (
    <Card style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="label" numberOfLines={1}>{title}</Text>
        {subtitle && <Text variant="meta" muted numberOfLines={1}>{subtitle}</Text>}
        {error && <ErrorBanner message={error} />}
      </View>
      <Button title="Unfollow" variant="ghost" onPress={onUnfollow} disabled={pending}
        style={{ minHeight: 36, paddingHorizontal: tokens.space.sm }} />
    </Card>
  );
  if (!onPress) return content;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>
      {content}
    </Pressable>
  );
}

function useUnfollowRow(targetId: string) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await unfollow(targetId);
      // The onSnapshot inside useFollows drops this row itself once its
      // targetId leaves `targets`; nothing else to set on success.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update. Try again.");
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run };
}

function ProfileFollowRow({ targetId, profile, onPress }: { targetId: string; profile: ProfileDoc; onPress: () => void }) {
  const { pending, error, run } = useUnfollowRow(targetId);
  return (
    <FollowRow
      title={profile.name}
      subtitle={`@${profile.handle}`}
      onPress={onPress}
      onUnfollow={() => void run()}
      pending={pending}
      error={error}
    />
  );
}

function GenreFollowRow({ genre }: { genre: string }) {
  const { pending, error, run } = useUnfollowRow(genreTargetId(genre));
  return <FollowRow title={formatChipLabel(genre)} onUnfollow={() => void run()} pending={pending} error={error} />;
}

function SectionEmpty({ text }: { text: string }) {
  return <Text muted>{text}</Text>;
}

export default function Following() {
  const router = useRouter();
  const t = useTokens();
  // useAuth() no longer needed directly here: useFollowsContext reads the
  // shared FollowsProvider subscription (app/_layout.tsx) rather than this
  // screen resolving its own uid and opening a second listener.
  const { targets, genres, loading } = useFollowsContext();
  const [pickerOpen, setPickerOpen] = useState(false);

  const profileTargetIds = [...targets].filter((id) => parseGenreTarget(id) === null);
  const profileCache = useProfileCache(profileTargetIds);

  const musicians = profileTargetIds
    .map((id) => ({ id, load: profileCache[id] }))
    .filter((r): r is { id: string; load: ProfileLoad } => !!r.load && r.load.kind === "ok" && r.load.profile.type === "musician");
  const curators = profileTargetIds
    .map((id) => ({ id, load: profileCache[id] }))
    .filter((r): r is { id: string; load: ProfileLoad } => !!r.load && r.load.kind === "ok" && r.load.profile.type === "curator");
  const stillResolving = profileTargetIds.filter((id) => !profileCache[id]);

  const totalFollows = targets.size;

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.xl, paddingBottom: tokens.space.xl }}>
        {loading && (
          <View style={{ gap: tokens.space.sm }}>
            <Skeleton height={64} />
            <Skeleton height={64} />
          </View>
        )}

        {!loading && totalFollows === 0 && (
          <View style={{ alignItems: "center", gap: tokens.space.sm, paddingVertical: tokens.space.xl }}>
            <IconHeart size={48} color={t.muted} />
            <Text variant="heading" style={{ textAlign: "center" }}>Not following anyone yet</Text>
            <Text muted style={{ textAlign: "center" }}>
              Follow artists, venues, and genres from Discover to see them here.
            </Text>
          </View>
        )}

        {!loading && totalFollows > 0 && (
          <>
            {stillResolving.length > 0 && (
              <View style={{ gap: tokens.space.sm }}>
                <Skeleton height={64} /><Skeleton height={64} />
              </View>
            )}

            {stillResolving.length === 0 && musicians.length > 0 && (
              <View style={{ gap: tokens.space.sm }}>
                <Text variant="title">Artists</Text>
                {musicians.map(({ id, load }) => load.kind === "ok" && (
                  <ProfileFollowRow
                    key={id} targetId={id} profile={load.profile}
                    onPress={() => router.push({ pathname: "/artist/[handle]", params: { handle: load.profile.handle } })}
                  />
                ))}
              </View>
            )}

            {stillResolving.length === 0 && curators.length > 0 && (
              <View style={{ gap: tokens.space.sm }}>
                <Text variant="title">Venues</Text>
                {curators.map(({ id, load }) => load.kind === "ok" && (
                  <ProfileFollowRow
                    key={id} targetId={id} profile={load.profile}
                    onPress={() => router.push({ pathname: "/venue/[handle]", params: { handle: load.profile.handle } })}
                  />
                ))}
              </View>
            )}

            <View style={{ gap: tokens.space.sm }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: tokens.space.sm }}>
                <Text variant="title">Genres</Text>
                <Button title="Edit genres" variant="secondary" onPress={() => setPickerOpen(true)}
                  style={{ minHeight: 36, paddingHorizontal: tokens.space.sm }} />
              </View>
              {genres.length === 0
                ? <SectionEmpty text="Not following any genres yet." />
                : genres.map((g) => <GenreFollowRow key={g} genre={g} />)}
            </View>
          </>
        )}
      </ScrollView>
      {/* Keyed on open/closed (not just `visible`): GenrePickerSheet seeds
          its own `selected` state from `preselected` ONCE, on mount. This
          screen keeps one persistent instance across repeated opens
          (unlike the web twin's per-purchase mount in BuyTicketsFlow), so
          without a key change on each open, a genre unfollowed via its own
          row below would still show pre-checked here on the NEXT open,
          reflecting a stale snapshot instead of the current `genres`. */}
      <GenrePickerSheet key={pickerOpen ? "open" : "closed"} visible={pickerOpen} onClose={() => setPickerOpen(false)} preselected={genres} />
    </View>
  );
}
