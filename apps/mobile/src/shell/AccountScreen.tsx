import { useState } from "react";
import { View, Pressable, Alert } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../auth/AuthProvider";
import { callFn } from "../lib/callable";
import { NotificationsList } from "./NotificationsList";
import { Text, Button, Card, ThemeToggle, PageBackground, IconCaretRight, ErrorBanner } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// Shared by all three role account screens (fan/musician/curator), the
// screen is identical across roles, so each `app/(role)/account.tsx` is a
// thin wrapper around this component (SP2 deferred dedup item). Restyling it
// here retints all three at once and mounts the Appearance/ThemeToggle row in
// each, exactly as the per-role account.tsx wrappers render it.
export function AccountScreen() {
  const { user, signOutUser } = useAuth();
  const router = useRouter();
  const t = useTokens();
  // SP10 Task 13: a deletion refusal (tickets, transfers, orders, sole admin)
  // renders inline under the button instead of a native alert, so the user
  // can act on it with the rest of the screen still in view.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteAccount = () => {
    Alert.alert("Delete account", "This permanently deletes your account and data. Continue?",
      [{ text: "Cancel", style: "cancel" },
       { text: "Delete", style: "destructive", onPress: async () => {
          setDeleteError(null);
          try {
            await callFn("deleteAccount", {});
            // The callable already deleted the auth user server-side; sign
            // out locally too so client state (and the Gate redirect) don't
            // depend on onAuthStateChanged noticing the now-invalid token.
            await signOutUser();
          } catch (e) {
            setDeleteError(e instanceof Error ? e.message : "Couldn't delete your account. Try again.");
          }
       } }]);
  };
  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <View style={{ flex: 1, padding: tokens.space.xl, gap: tokens.space.lg }}>
        <Text variant="title">{user?.email}</Text>
        <Card style={{ gap: tokens.space.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: tokens.space.md }}>
            <Text variant="label">Appearance</Text>
            <ThemeToggle />
          </View>
          {/* SP7 Task 11: every account (fan, musician, curator) can follow
              artists, venues, and genres, so this row is unconditional here
              rather than gated to a fan-only wrapper. */}
          <Pressable
            onPress={() => router.push("/(fan)/following")}
            accessibilityRole="button"
            accessibilityLabel="Following"
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: tokens.space.md,
              borderTopWidth: 1, borderTopColor: t.border, paddingTop: tokens.space.md }}
          >
            <Text variant="label">Following</Text>
            <IconCaretRight size={16} color={t.muted} />
          </Pressable>
          {/* SP8 Task 17: every account can save a search from any face's
              header and get alerted when a new match appears, so this row
              is unconditional here too. */}
          <Pressable
            onPress={() => router.push("/(fan)/saved-searches")}
            accessibilityRole="button"
            accessibilityLabel="Saved searches"
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: tokens.space.md,
              borderTopWidth: 1, borderTopColor: t.border, paddingTop: tokens.space.md }}
          >
            <Text variant="label">Saved searches</Text>
            <IconCaretRight size={16} color={t.muted} />
          </Pressable>
        </Card>
        <Button title="Sign out" variant="secondary" onPress={signOutUser} />
        <Button title="Delete account" variant="destructive" onPress={deleteAccount} />
        <ErrorBanner message={deleteError} />
        <NotificationsList />
      </View>
    </View>
  );
}
