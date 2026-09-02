import { useEffect, useState } from "react";
import { View, ScrollView, Pressable, Image } from "react-native";
import { useRouter } from "expo-router";
import { getDocs } from "firebase/firestore";
import { GENRES, type MusicianSubtype, type ProfileDoc } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { artistsQuery, formatChipLabel, type ArtistRow } from "./discoverQueries";
import { publicStorageUrl } from "./storageUrl";
import { FollowButton } from "./FollowButton";
import { Text, Badge, Chip, ErrorBanner, Skeleton, IconUser } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// SP7 Task 11: RN twin of apps/web/src/discover/ArtistsList.tsx. Genre
// filtering is a horizontally scrollable Chip row (see ShowsList.tsx's own
// comment on why, no <Select> primitive exists on mobile). Avatars resolve
// through publicStorageUrl (no getDownloadURL round trip) rather than the
// usePosterUrl hook the rest of this app's poster images use, since a list
// of up to 60 rows shouldn't each open its own async download-URL fetch.

const ACT_SIZE_LABEL: Record<MusicianSubtype, string> = { solo: "Solo", band: "Band" };
const ALL_GENRES_LABEL = "All genres";

function ArtistRowItem({ artist, onPress }: { artist: ArtistRow; onPress: () => void }) {
  const t = useTokens();
  const avatarUrl = artist.portfolio?.avatarPhotoPath ? publicStorageUrl(artist.portfolio.avatarPhotoPath) : null;
  const genres = (artist.portfolio?.genres ?? []).slice(0, 3);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={artist.name}
        style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}
      >
        <View style={{
          width: 44, height: 44, borderRadius: 22, overflow: "hidden", alignItems: "center", justifyContent: "center",
          borderWidth: 1, borderColor: t.border, backgroundColor: t.surface,
        }}>
          {avatarUrl
            ? <Image source={{ uri: avatarUrl }} style={{ width: "100%", height: "100%" }} />
            : <IconUser size={20} color={t.muted} />}
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text variant="label" numberOfLines={1}>{artist.name}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Badge label={ACT_SIZE_LABEL[artist.subtype as MusicianSubtype]} />
            {genres.map((g) => <Badge key={g} label={formatChipLabel(g)} />)}
          </View>
        </View>
      </Pressable>
      <FollowButton targetId={artist.id} targetType="musician" compact />
    </View>
  );
}

function ArtistRowSkeleton() {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
      <Skeleton width={44} height={44} radius={22} />
      <View style={{ flex: 1, gap: 6 }}>
        <Skeleton height={16} width="50%" />
        <Skeleton height={12} width="30%" />
      </View>
    </View>
  );
}

// The Artists tab: approved musician profiles, filtered by genre.
export function ArtistsList() {
  const router = useRouter();
  const t = useTokens();
  const [rows, setRows] = useState<ArtistRow[] | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const [genre, setGenre] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    getDocs(artistsQuery(db, { genre }))
      .then((snap) => {
        if (cancelled) return;
        setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as ProfileDoc) })));
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setRows([]);
        setError(e instanceof Error ? e.message : "Could not load artists.");
      });
    return () => { cancelled = true; };
  }, [genre]);

  return (
    <View style={{ gap: tokens.space.md }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        <Chip label={ALL_GENRES_LABEL} active={genre === null} onPress={() => setGenre(null)} />
        {GENRES.map((g) => (
          <Chip key={g} label={formatChipLabel(g)} active={genre === g} onPress={() => setGenre(g)} />
        ))}
      </ScrollView>

      {error && <ErrorBanner message={`Could not load artists: ${error}`} />}

      {rows === "loading" && (
        <View style={{ gap: tokens.space.md }}>
          {[0, 1, 2].map((i) => <ArtistRowSkeleton key={i} />)}
        </View>
      )}

      {rows !== "loading" && rows.length === 0 && !error && (
        <View style={{ alignItems: "center", gap: tokens.space.sm, paddingVertical: tokens.space.xl }}>
          <IconUser size={48} color={t.muted} />
          <Text variant="heading" style={{ textAlign: "center" }}>No artists match this genre</Text>
          <Text muted style={{ textAlign: "center" }}>Clear the genre filter to see every approved act on GateKeep.</Text>
        </View>
      )}

      {rows !== "loading" && rows.length > 0 && (
        <View style={{ gap: tokens.space.md }}>
          {rows.map((artist) => (
            <ArtistRowItem
              key={artist.id}
              artist={artist}
              onPress={() => router.push({ pathname: "/artist/[handle]", params: { handle: artist.handle } })}
            />
          ))}
        </View>
      )}
    </View>
  );
}
