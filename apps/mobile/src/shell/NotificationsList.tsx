import { Pressable, FlatList } from "react-native";
import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { collection, query, orderBy, limit, onSnapshot, doc, getDoc, updateDoc } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { useAuth } from "../auth/AuthProvider";
import { Text } from "../ui";
import { tokens } from "../theme/tokens";
import type { NotificationDoc, ProfileDoc } from "@gatekeep/shared";

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
  //
  // SP7 Task 11: four more kinds carry a deep-linkable refId (see
  // NotificationDoc.refId's own comment). show_announced/show_rescheduled/
  // show_post name the eventId directly, matching web's own dashboard
  // NotificationsList; new_music names the artist's profileId instead of a
  // handle (NotificationDoc has no room for a denormalized handle), so this
  // resolves it via one getDoc before pushing, same tradeoff
  // resolveLineup/loadShows elsewhere in this app make for a profileId ->
  // handle lookup. A resolve failure (profile since deleted/unapproved, or
  // any other read error) just marks the notification read with nowhere to
  // go, rather than surfacing a broken navigation.
  const onPress = (item: { id: string } & NotificationDoc) => {
    void markRead(item.id);
    if (item.kind === "booking" && item.refId) {
      router.push({ pathname: "/booking/[bookingId]", params: { bookingId: item.refId } });
      return;
    }
    if ((item.kind === "show_announced" || item.kind === "show_rescheduled" || item.kind === "show_post") && item.refId) {
      router.push({ pathname: "/event/[eventId]", params: { eventId: item.refId } });
      return;
    }
    if (item.kind === "new_music" && item.refId) {
      const refId = item.refId;
      getDoc(doc(getFirebase().db, "profiles", refId))
        .then((snap) => {
          const handle = snap.exists() ? (snap.data() as ProfileDoc).handle : null;
          if (handle) router.push({ pathname: "/artist/[handle]", params: { handle } });
        })
        .catch((e) => console.warn("NotificationsList: new_music profile lookup failed", refId, e));
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
