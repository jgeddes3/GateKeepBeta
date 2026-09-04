import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { doc, getDoc } from "firebase/firestore";
import type { SavedSearchDoc, SearchFilters } from "@gatekeep/shared";
import { getFirebase } from "../../src/lib/firebase";
import { PageBackground } from "../../src/ui";
import { FanFace } from "../../src/search/FanFace";

// SP8 Task 14/17: the fan Search tab. `saved` (set by SavedSearchesScreen's
// own row navigation) resolves through one owner-read getDoc before FanFace
// ever mounts, so its `initial` prop (which useSearch only reads at mount)
// carries the saved search's actual q/filters rather than racing an
// already-mounted empty face. A missing or permission-denied doc (deleted,
// or someone else's link) just renders the empty face, no alert.
export default function Screen() {
  const { saved } = useLocalSearchParams<{ saved?: string }>();
  const [ready, setReady] = useState(!saved);
  const [initial, setInitial] = useState<{ q: string; filters: SearchFilters } | undefined>(undefined);
  const resolvedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!saved || resolvedRef.current === saved) return;
    resolvedRef.current = saved;
    setReady(false);
    let cancelled = false;
    getDoc(doc(getFirebase().db, "savedSearches", saved))
      .then((snap) => {
        if (cancelled) return;
        if (snap.exists()) {
          const d = snap.data() as SavedSearchDoc;
          setInitial({ q: d.q, filters: d.filters });
        }
        setReady(true);
      })
      .catch(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [saved]);

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      {ready && <FanFace initial={initial} />}
    </View>
  );
}
