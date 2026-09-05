import { FlatList, Pressable, View } from "react-native";
import { Text, Badge, SkeletonCard, ErrorBanner, Button } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";
import { useConversations, unreadFor, formatConversationTime, type ConversationRow } from "./useConversations";

// Screen-specific copy, not a shared constant (section 6 of the spec lists
// no "no conversations" string): the list's own empty state.
const CONVERSATIONS_EMPTY_MESSAGE = "No conversations yet. Message a venue or an artist from their page.";

function ConversationRowItem({
  row, profileId, onOpen,
}: { row: ConversationRow; profileId: string; onOpen: (conversationId: string) => void }) {
  const t = useTokens();
  const unread = unreadFor(row, profileId);
  const preview = row.lastMessage?.text ?? "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.otherProfileName}, ${unread} unread`}
      onPress={() => onOpen(row.pairId)}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        gap: tokens.space.md,
        paddingVertical: tokens.space.md,
        paddingHorizontal: tokens.space.lg,
        borderBottomWidth: 1,
        borderBottomColor: t.border,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="label">{row.otherProfileName}</Text>
        <Text variant="meta" muted>{row.otherProfileType === "musician" ? "Musician" : "Curator"}</Text>
        {preview.length > 0 && <Text muted numberOfLines={1}>{preview}</Text>}
      </View>
      <View style={{ alignItems: "flex-end", gap: 4 }}>
        <Text variant="meta" muted>{formatConversationTime(row.lastMessageAt)}</Text>
        <Badge label={String(unread)} />
      </View>
    </Pressable>
  );
}

// The list screen's content, mounted by app/(musician)/messages/index.tsx
// and app/(curator)/messages/index.tsx with `key={profileId}` so a profile
// switch always remounts fresh (see useConversations.ts's own comment).
export function ConversationList({
  profileId, onOpen,
}: { profileId: string; onOpen: (conversationId: string) => void }) {
  const { rows, retry } = useConversations(profileId);

  if (rows === "loading") {
    return (
      <View style={{ padding: tokens.space.lg, gap: tokens.space.md }}>
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </View>
    );
  }
  if (rows === "error") {
    return (
      <View style={{ padding: tokens.space.lg, gap: tokens.space.md }}>
        <ErrorBanner message="Couldn't load your conversations." />
        <Button title="Retry" onPress={retry} style={{ alignSelf: "flex-start" }} />
      </View>
    );
  }
  if (rows.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl }}>
        <Text muted style={{ textAlign: "center" }}>{CONVERSATIONS_EMPTY_MESSAGE}</Text>
      </View>
    );
  }
  return (
    <FlatList
      style={{ flex: 1 }}
      data={rows}
      keyExtractor={(row) => row.pairId}
      renderItem={({ item }) => <ConversationRowItem row={item} profileId={profileId} onOpen={onOpen} />}
    />
  );
}
