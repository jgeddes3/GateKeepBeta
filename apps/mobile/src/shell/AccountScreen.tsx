import { View, Text, Pressable, Alert } from "react-native";
import { httpsCallable } from "firebase/functions";
import { useAuth } from "../auth/AuthProvider";
import { getFirebase } from "../lib/firebase";
import { NotificationsList } from "./NotificationsList";

// Shared by all three role account screens (fan/musician/curator) — the
// screen is identical across roles, so each `app/(role)/account.tsx` is a
// thin wrapper around this component (SP2 deferred dedup item).
export function AccountScreen() {
  const { user, signOutUser } = useAuth();
  const deleteAccount = () => {
    Alert.alert("Delete account", "This permanently deletes your account and data. Continue?",
      [{ text: "Cancel", style: "cancel" },
       { text: "Delete", style: "destructive", onPress: async () => {
          try {
            await httpsCallable(getFirebase().functions, "deleteAccount")({});
            // The callable already deleted the auth user server-side; sign
            // out locally too so client state (and the Gate redirect) don't
            // depend on onAuthStateChanged noticing the now-invalid token.
            await signOutUser();
          } catch (e: any) { Alert.alert("Can't delete yet", e?.message ?? ""); }
       } }]);
  };
  return (
    <View style={{ flex: 1, padding: 24, gap: 16 }}>
      <Text style={{ fontSize: 20 }}>{user?.email}</Text>
      <Pressable onPress={signOutUser}><Text style={{ color: "#dc2626" }}>Sign out</Text></Pressable>
      <Pressable onPress={deleteAccount}><Text style={{ color: "#dc2626" }}>Delete account</Text></Pressable>
      <NotificationsList />
    </View>
  );
}
