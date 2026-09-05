import { useEffect, useState } from "react";
import { View } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { doc, getDoc } from "firebase/firestore";
import type { ProfileDoc } from "@gatekeep/shared";
import { getFirebase } from "../../src/lib/firebase";
import { Text, PageBackground, Skeleton } from "../../src/ui";

// SP11 (spec section 3.1): the incoming-link resolver for /u/{handle}. Reads
// handles/{handle} then profiles/{id}, the same lookup shape
// app/artist/[handle].tsx and app/venue/[handle].tsx already use, and
// replaces itself with whichever of those two screens matches the profile's
// type. This screen never renders content of its own beyond a loading
// skeleton and the shared not-found treatment; it exists only to route.
export default function HandleLink() {
  const { handle: rawHandle } = useLocalSearchParams<{ handle: string }>();
  const handle = (rawHandle ?? "").toLowerCase();
  const [state, setState] = useState<"loading" | "notfound" | { type: "musician" | "curator" }>("loading");

  // Render-time reset, mirroring artist/[handle].tsx's and venue/[handle].tsx's
  // own lastHandle idiom: without it a reused screen instance would resolve
  // (or briefly render the not-found state for) the PREVIOUS handle under a
  // new one for a frame.
  const [lastHandle, setLastHandle] = useState(handle);
  if (handle !== lastHandle) {
    setLastHandle(handle);
    setState("loading");
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { db } = getFirebase();
        const h = await getDoc(doc(db, "handles", handle));
        if (!h.exists()) { if (!cancelled) setState("notfound"); return; }
        const profileId = h.data().profileId as string;
        const p = await getDoc(doc(db, "profiles", profileId)); // rules deny unless approved/member/admin
        const type = p.exists() ? (p.data() as ProfileDoc).type : null;
        if (type !== "musician" && type !== "curator") {
          if (!cancelled) setState("notfound"); return;
        }
        if (!cancelled) setState({ type });
      } catch (e) {
        // permission-denied means "not approved", a legitimate not-found
        // from the public's point of view, mirroring the sibling screens'
        // own comment.
        const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
        if (code !== "permission-denied") console.error("handle link resolve failed", handle, e);
        if (!cancelled) setState("notfound");
      }
    })();
    return () => { cancelled = true; };
  }, [handle]);

  if (state === "loading") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ padding: 16, gap: 12 }}>
          <Skeleton height={26} width="55%" />
          <Skeleton height={16} width="40%" />
        </View>
      </View>
    );
  }
  if (state === "notfound") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 6 }}>
          <Text variant="title">Profile not found</Text>
          <Text muted style={{ textAlign: "center" }}>No profile at @{handle}.</Text>
        </View>
      </View>
    );
  }

  return state.type === "musician"
    ? <Redirect href={{ pathname: "/artist/[handle]", params: { handle } }} />
    : <Redirect href={{ pathname: "/venue/[handle]", params: { handle } }} />;
}
