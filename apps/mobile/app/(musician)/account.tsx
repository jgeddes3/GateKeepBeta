import { View, Text, Pressable, Alert } from "react-native";
import { httpsCallable } from "firebase/functions";
import { useAuth } from "../../src/auth/AuthProvider";
import { getFirebase } from "../../src/lib/firebase";
import { NotificationsList } from "../../src/shell/NotificationsList";
export default function Account() {
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
