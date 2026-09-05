import { Pressable, FlatList, View } from "react-native";
import { useEffect, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { collection, query, orderBy, limit, onSnapshot, doc, getDoc, updateDoc } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { useAuth } from "../auth/AuthProvider";
import { Badge, Text } from "../ui";
import { tokens } from "../theme/tokens";
import { notificationHref, UNREAD_MARKER_LABEL, type NotificationDoc, type ProfileDoc } from "@gatekeep/shared";

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
  // Task 29: booking/ticket/event-kind hrefs come from the shared href map
  // (notificationHref, also used by web's dashboard NotificationsList and by
  // this app's own push tap handler), cast `as Href` because the helper
  // returns a plain string and expo-router's typed routes accept the two
  // shapes it produces. SP8 Task 17: `item.refKind` is passed through so
  // notificationHref can route a saved_search_match to the event or gig
  // page; a profile match (or new_music, which has no refKind at all) still
  // resolves locally below. new_music/profile-kind matches resolve their
  // handle client-side: their refId is the artist's profileId, not a route
  // (NotificationDoc has no room for a denormalized handle), so this keeps
  // the one getDoc lookup resolveLineup/loadShows elsewhere in this app make
  // for the same profileId -> handle need. A resolve failure (profile since
  // deleted/unapproved, or any other read error) just marks the
  // notification read with nowhere to go, rather than surfacing a broken
  // navigation.
  const onPress = (item: { id: string } & NotificationDoc) => {
    void markRead(item.id);
    if ((item.kind === "new_music" || (item.kind === "saved_search_match" && item.refKind === "profile")) && item.refId) {
      const refId = item.refId;
      getDoc(doc(getFirebase().db, "profiles", refId))
        .then((snap) => {
          const handle = snap.exists() ? (snap.data() as ProfileDoc).handle : null;
          if (handle) router.push({ pathname: "/artist/[handle]", params: { handle } });
        })
        .catch((e) => console.warn("NotificationsList: new_music profile lookup failed", refId, e));
      return;
    }
    const href = notificationHref(item.kind, item.refId, "mobile", item.refKind);
    if (href) router.push(href as Href);
  };
  return (
    <FlatList data={notes} keyExtractor={(n) => n.id}
      ListHeaderComponent={<Text variant="title">Notifications</Text>}
      ListEmptyComponent={<Text variant="body" muted style={{ padding: tokens.space.md }}>No notifications yet.</Text>}
      renderItem={({ item }) => (
        // SP12 follow-on (audit #26): read no longer relies on opacity
        // alone. An unread row carries a "New" Badge (a real text channel,
        // not just weight/colour) and the accessibilityLabel repeats it so
        // VoiceOver/TalkBack announce it too; a read row's title just goes
        // muted, matching the web twin.
        <Pressable onPress={() => onPress(item)}
          accessibilityLabel={item.read ? item.title : `${UNREAD_MARKER_LABEL}, ${item.title}`}
          style={{ padding: tokens.space.md }}>
          {!item.read && (
            <View style={{ marginBottom: tokens.space.xs, alignSelf: "flex-start" }}>
              <Badge label={UNREAD_MARKER_LABEL} />
            </View>
          )}
          <Text variant="label" muted={item.read}>{item.title}</Text>
          <Text variant="body" muted>{item.body}</Text>
        </Pressable>
      )} />
  );
}
