import { View, Text, Pressable } from "react-native";
import { useAuth } from "../../src/auth/AuthProvider";
import { NotificationsList } from "../../src/shell/NotificationsList";
export default function Account() {
  const { user, signOutUser } = useAuth();
  return (
    <View style={{ flex: 1, padding: 24, gap: 16 }}>
      <Text style={{ fontSize: 20 }}>{user?.email}</Text>
      <Pressable onPress={signOutUser}><Text style={{ color: "#dc2626" }}>Sign out</Text></Pressable>
      <NotificationsList />
    </View>
  );
}
