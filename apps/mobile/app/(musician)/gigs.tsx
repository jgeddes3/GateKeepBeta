import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { doc, getDoc } from "firebase/firestore";
import type { SavedSearchDoc, SearchFilters } from "@gatekeep/shared";
import { getFirebase } from "../../src/lib/firebase";
import { MusicianFace } from "../../src/search/MusicianFace";
import { PageBackground } from "../../src/ui";

// Musician "Find gigs" tab (SP8 Task 15/17): the Gigs | Venues search face,
// replacing the earlier browse placeholder. Browsing is public the same
// way that screen's was; the Apply flow gates on an approved musician profile
// internally (GigDetailSheet's own ApplyPanel). `gigId` opens that sheet on
// mount (Task 17's deep link). `saved` resolves through one owner-read
// getDoc before MusicianFace ever mounts (its `initial` and `initialSegment`
// props only take effect at mount); an explicit `segment` param always wins,
// otherwise the saved doc's own face picks the starting tab. A missing or
// permission-denied doc just renders the empty face, no alert.
export default function Gigs() {
  const { gigId, segment, saved } = useLocalSearchParams<{ gigId?: string; saved?: string; segment?: string }>();
  const [ready, setReady] = useState(!saved);
  const [initial, setInitial] = useState<{ q: string; filters: SearchFilters } | undefined>(undefined);
  const [savedSegment, setSavedSegment] = useState<"gigs" | "venues" | null>(null);
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
          setSavedSegment(d.face === "musician_venues" ? "venues" : "gigs");
        }
        setReady(true);
      })
      .catch(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [saved]);

  const initialSegment = segment !== undefined
    ? (segment === "venues" ? "venues" : "gigs")
    : (savedSegment ?? "gigs");

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      {ready && (
        <MusicianFace preselectGigId={gigId ?? null} initialSegment={initialSegment} initial={initial} />
      )}
    </View>
  );
}
