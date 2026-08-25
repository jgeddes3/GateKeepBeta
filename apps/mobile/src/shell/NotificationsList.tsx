import { Text, Pressable, FlatList } from "react-native";
import { useEffect, useState } from "react";
import { collection, query, orderBy, limit, onSnapshot, doc, updateDoc } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { useAuth } from "../auth/AuthProvider";
import type { NotificationDoc } from "@gatekeep/shared";

export function NotificationsList() {
  const { user } = useAuth();
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
  return (
    <FlatList data={notes} keyExtractor={(n) => n.id}
      ListHeaderComponent={<Text style={{ fontSize: 18, fontWeight: "600" }}>Notifications</Text>}
      renderItem={({ item }) => (
        <Pressable onPress={() => markRead(item.id)}
          style={{ padding: 12, opacity: item.read ? 0.5 : 1 }}>
          <Text style={{ fontWeight: "600" }}>{item.title}</Text>
          <Text>{item.body}</Text>
        </Pressable>
      )} />
  );
}
