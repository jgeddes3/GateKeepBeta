import type { ReactNode } from "react";
import { Image, Pressable, View } from "react-native";
import { distanceLabel, type SearchResult } from "@gatekeep/shared";
import { formatChipLabel } from "../discover/discoverQueries";
import { publicStorageUrl } from "../discover/storageUrl";
import { formatCents } from "../events/eventDisplay";
import { formatGigDateTime } from "../gigs/GigForms";
import { Card, IconMusicNotes, IconTicket, IconUser, PhotoPlaceholder, Text } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// Mobile twin of apps/web/src/search/ResultRows.tsx: one Card row per
// SearchResult kind, built on the row-card shape ShowsList.tsx/ArtistsList
// .tsx already established (thumbnail + title + meta lines) rather than
// web's link-styled DateBlockRow, since the mobile primitive kit has no
// link component of its own.

const ACT_SIZE_LABEL: Record<string, string> = { solo: "Solo", duo: "Duo", band: "Band" };

function joinDetail(parts: (string | null | undefined)[]): string | undefined {
  const filtered = parts.filter((p): p is string => !!p);
  return filtered.length > 0 ? filtered.join(" · ") : undefined;
}

function distancePart(r: SearchResult): string | null {
  return r.distanceMeters != null ? distanceLabel(r.distanceMeters) : null;
}

function Thumbnail({ imagePath, size, radius, icon }: {
  imagePath: string | null; size: number; radius: number; icon: ReactNode;
}) {
  const t = useTokens();
  const uri = imagePath ? publicStorageUrl(imagePath) : null;
  return (
    <View style={{
      width: size, height: size, borderRadius: radius, overflow: "hidden",
      borderWidth: 1, borderColor: t.border, backgroundColor: t.surface,
      alignItems: "center", justifyContent: "center",
    }}>
      {uri ? <Image source={{ uri }} style={{ width: "100%", height: "100%" }} /> : <PhotoPlaceholder icon={icon} />}
    </View>
  );
}

export function ShowRow({ r, onPress }: { r: SearchResult; onPress: () => void }) {
  const t = useTokens();
  const price = r.hasFreeTier ? "Free" : r.priceFromCents != null ? `from ${formatCents(r.priceFromCents)}` : null;
  const meta = joinDetail([price, distancePart(r)]);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={r.title}>
      <Card style={{ flexDirection: "row", gap: tokens.space.sm }}>
        <Thumbnail imagePath={r.imagePath} size={56} radius={tokens.radius.sm} icon={<IconTicket size={22} color={t.muted} />} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label" numberOfLines={1}>{r.title}</Text>
          {r.startsAt != null && <Text variant="meta" muted numberOfLines={1}>{formatGigDateTime(r.startsAt)}</Text>}
          <Text variant="meta" muted numberOfLines={1}>{[r.subtitle, r.neighborhood].filter(Boolean).join(" · ")}</Text>
          {meta && <Text variant="meta" muted numberOfLines={1}>{meta}</Text>}
        </View>
      </Card>
    </Pressable>
  );
}

export function GigRow({ r, onPress }: { r: SearchResult; onPress: () => void }) {
  const t = useTokens();
  const budget = r.budgetMinCents != null && r.budgetMaxCents != null
    ? `${formatCents(r.budgetMinCents)} to ${formatCents(r.budgetMaxCents)}`
    : null;
  const meta = joinDetail([budget, distancePart(r)]);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={r.title}>
      <Card style={{ flexDirection: "row", gap: tokens.space.sm }}>
        <Thumbnail imagePath={r.imagePath} size={56} radius={tokens.radius.sm} icon={<IconMusicNotes size={22} color={t.muted} />} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label" numberOfLines={1}>{r.title}</Text>
          {r.startsAt != null && <Text variant="meta" muted numberOfLines={1}>{formatGigDateTime(r.startsAt)}</Text>}
          <Text variant="meta" muted numberOfLines={1}>{[r.subtitle, r.neighborhood].filter(Boolean).join(" · ")}</Text>
          {meta && <Text variant="meta" muted numberOfLines={1}>{meta}</Text>}
        </View>
      </Card>
    </Pressable>
  );
}

export function ProfileRow({ r, onPress }: { r: SearchResult; onPress: () => void }) {
  const t = useTokens();
  const subtitle = r.kind === "venue" ? (r.city ?? "") : r.genres.map(formatChipLabel).join(", ");
  const meta = joinDetail([
    r.hasAudio ? "Has audio" : null,
    r.actSize ? ACT_SIZE_LABEL[r.actSize] : null,
    r.followerCount > 0 ? `${r.followerCount} follower${r.followerCount === 1 ? "" : "s"}` : null,
    distancePart(r),
  ]);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={r.title}>
      <Card style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
        <Thumbnail imagePath={r.imagePath} size={44} radius={22} icon={<IconUser size={18} color={t.muted} />} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label" numberOfLines={1}>{r.title}</Text>
          {subtitle && <Text variant="meta" muted numberOfLines={1}>{subtitle}</Text>}
          {meta && <Text variant="meta" muted numberOfLines={1}>{meta}</Text>}
        </View>
      </Card>
    </Pressable>
  );
}
