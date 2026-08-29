import { Pressable, FlatList } from "react-native";
import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { collection, query, orderBy, limit, onSnapshot, doc, updateDoc } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { useAuth } from "../auth/AuthProvider";
import { Text } from "../ui";
import { tokens } from "../theme/tokens";
import type { NotificationDoc } from "@gatekeep/shared";

export function NotificationsList() {
  const { user } = useAuth();
  const router = useRouter();
  const [notes, setNotes] = useState<({ id: string } & NotificationDoc)[]>([]);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const { db } = getFirebase();
    const unsubscribe = onSnapshot(
      query(collection(db, `users/${user.uid}/notifications`), orderBy("createdAt", "desc"), limit(30)),
      (s) => {
        if (cancelled) return;
        setNotes(s.docs.map((d) => ({ id: d.id, ...(d.data() as NotificationDoc) })));
      });
    return () => { cancelled = true; unsubscribe(); };
  }, [user?.uid]);
  const markRead = (id: string) =>
    updateDoc(doc(getFirebase().db, `users/${user!.uid}/notifications/${id}`), { read: true });
  // SP4 Task 12: a "booking" notification carries refId (the bookingId, see
  // functions/src/{bookings,bookingLifecycle,scheduled}.ts's notify call
  // sites and NotificationDoc.refId). Tap deep-links straight to the thread
  // route, mirroring web's dashboard NotificationsList. A booking-kind row
  // written before refId existed (or, defensively, any other kind) has no
  // refId and just marks read, same as before.
  const onPress = (item: { id: string } & NotificationDoc) => {
    void markRead(item.id);
    if (item.kind === "booking" && item.refId) {
      router.push({ pathname: "/booking/[bookingId]", params: { bookingId: item.refId } });
    }
  };
  return (
    <FlatList data={notes} keyExtractor={(n) => n.id}
      ListHeaderComponent={<Text variant="title">Notifications</Text>}
      ListEmptyComponent={<Text variant="body" muted style={{ padding: tokens.space.md }}>No notifications yet.</Text>}
      renderItem={({ item }) => (
        <Pressable onPress={() => onPress(item)}
          style={{ padding: tokens.space.md, opacity: item.read ? 0.5 : 1 }}>
          <Text variant="label">{item.title}</Text>
          <Text variant="body" muted>{item.body}</Text>
        </Pressable>
      )} />
  );
}
