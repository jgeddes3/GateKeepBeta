import { useEffect, useRef, useState } from "react";
import { ScrollView, View, Text, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { doc, onSnapshot, collection, query, where } from "firebase/firestore";
import { getFirebase } from "../../../src/lib/firebase";
import { useAuth } from "../../../src/auth/AuthProvider";
import { useProfileContext } from "../../../src/shell/ProfileContext";
import {
  GIG_STATUS_LABEL, SERIES_STATUS_LABEL, BUDGET_STRUCTURE_LABEL, WEEKDAY_LABELS, STATUS_BG, STATUS_FG,
  Badge, formatGigDateTime, formatCents,
} from "../../../src/gigs/GigForms";
import type { ProfileDoc, GigDoc, GigSeriesDoc } from "@gatekeep/shared";

type GigRow = GigDoc & { id: string };
type SeriesRow = GigSeriesDoc & { id: string };

// Sorted ascending (soonest first) for open/drafts — "what's coming up" is
// the useful question there — and descending (most recent first) for the
// past group, where "what just happened" matters more. Mirrors web's
// dashboard/curator/[profileId]/gigs/page.tsx exactly.
const byStartsAtAsc = (a: GigRow, b: GigRow) => a.startsAt - b.startsAt;
const byStartsAtDesc = (a: GigRow, b: GigRow) => b.startsAt - a.startsAt;

function GigListItem({ gig, onPress, onSeriesPress }: {
  gig: GigRow; onPress: () => void; onSeriesPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 10, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ fontWeight: "700", flex: 1 }}>{gig.title || "Untitled gig"}</Text>
        <Badge label={GIG_STATUS_LABEL[gig.status]} bg={STATUS_BG[gig.status]} fg={STATUS_FG[gig.status]} />
      </View>
      <Text style={{ color: "#666", fontSize: 13 }}>
        {formatGigDateTime(gig.startsAt)}
        {" · "}{formatCents(gig.budget.minCents)}–{formatCents(gig.budget.maxCents)} {BUDGET_STRUCTURE_LABEL[gig.budget.structure]}
      </Text>
      {gig.seriesId && (
        <Pressable onPress={onSeriesPress} hitSlop={8}>
          <Text style={{ color: "#2563eb", fontSize: 13 }}>series{gig.detachedFromTemplate ? " (detached)" : ""} →</Text>
        </Pressable>
      )}
    </Pressable>
  );
}

export default function GigsList() {
  const { user } = useAuth();
  const router = useRouter();
  const { activeContext } = useProfileContext();
  const profileId = typeof activeContext === "object" && activeContext.type === "curator"
    ? activeContext.profileId : null;
  const [profile, setProfile] = useState<ProfileDoc | null>(null);
  const [gigs, setGigs] = useState<GigRow[]>([]);
  const [series, setSeries] = useState<SeriesRow[]>([]);

  // Same render-time-reset + late-callback guard as (curator)/dashboard.tsx:
  // this tab's landing screen stays mounted across a profile-context switch
  // (the outer Tabs navigator keeps a tab's nested Stack mounted in the
  // background by default), so without both of these, switching curator
  // profiles could leave the PREVIOUS profile's gigs/series on screen — the
  // render-time reset alone still has a narrow post-commit window where a
  // still-in-flight onSnapshot callback for the OLD profileId can resolve
  // after the reset but before its own effect cleanup unsubscribes it (React
  // runs effect cleanup at the passive-effect flush, after commit+paint, not
  // synchronously during the render-time reset below).
  const activeIdRef = useRef(profileId);
  const [lastProfileId, setLastProfileId] = useState(profileId);
  if (profileId !== lastProfileId) {
    setLastProfileId(profileId);
    // eslint-disable-next-line react-hooks/refs
    activeIdRef.current = profileId;
    setProfile(null); setGigs([]); setSeries([]);
  }

  useEffect(() => {
    if (!profileId) return;
    const forId = profileId;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "profiles", profileId),
      (s) => { if (activeIdRef.current !== forId) return; setProfile(s.exists() ? (s.data() as ProfileDoc) : null); },
      () => { if (activeIdRef.current !== forId) return; setProfile(null); });
  }, [profileId]);
  // where(curatorProfileId=='X') with NO status filter — rules-provable for a
  // member via the member disjunct alone (see firestore.rules' comment on
  // gigs' read rule + tests-rules/rules.test.ts's "curator dashboard" test),
  // and needs no composite index (single equality field). Every status comes
  // back in one listener; the open/drafts/past grouping below is purely
  // client-side. Mirrors web's identical query exactly.
  useEffect(() => {
    if (!profileId) return;
    const forId = profileId;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "gigs"), where("curatorProfileId", "==", profileId)),
      (s) => { if (activeIdRef.current !== forId) return; setGigs(s.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) }))); });
  }, [profileId]);
  // Same shape for gigSeries — its read rule (isMember(curatorProfileId) ||
  // isAdmin(), no public disjunct) is provable the identical way.
  useEffect(() => {
    if (!profileId) return;
    const forId = profileId;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "gigSeries"), where("curatorProfileId", "==", profileId)),
      (s) => { if (activeIdRef.current !== forId) return; setSeries(s.docs.map((d) => ({ id: d.id, ...(d.data() as GigSeriesDoc) }))); });
  }, [profileId]);

  if (!user || !profileId || !profile) {
    return <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text>{!user || !profileId ? "Switch to a curator profile to see its gigs." : "Loading…"}</Text></View>;
  }

  const open = gigs.filter((g) => g.status === "open").sort(byStartsAtAsc);
  const drafts = gigs.filter((g) => g.status === "draft").sort(byStartsAtAsc);
  const past = gigs.filter((g) => g.status === "closed" || g.status === "cancelled" || g.status === "taken_down").sort(byStartsAtDesc);

  const openGig = (gigId: string) => router.push({ pathname: "/(curator)/events/[gigId]", params: { gigId } });
  const openSeries = (seriesId: string) => router.push({ pathname: "/(curator)/events/series/[seriesId]", params: { seriesId } });

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 20 }} keyboardShouldPersistTaps="handled">
      {profile.status === "approved" ? (
        <Pressable onPress={() => router.push("/(curator)/events/new")}
          style={{ backgroundColor: "#111", padding: 14, borderRadius: 8 }}>
          <Text style={{ color: "#fff", textAlign: "center" }}>+ Post a new gig</Text>
        </Pressable>
      ) : (
        <Text style={{ color: "#666" }}>Your curator profile must be approved before you can post gigs.</Text>
      )}

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 18, fontWeight: "700" }}>Open ({open.length})</Text>
        {open.length === 0 && <Text style={{ color: "#666" }}>No open gigs.</Text>}
        {open.map((g) => <GigListItem key={g.id} gig={g} onPress={() => openGig(g.id)} onSeriesPress={() => g.seriesId && openSeries(g.seriesId)} />)}
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 18, fontWeight: "700" }}>Drafts ({drafts.length})</Text>
        {drafts.length === 0 && <Text style={{ color: "#666" }}>No drafts.</Text>}
        {drafts.map((g) => <GigListItem key={g.id} gig={g} onPress={() => openGig(g.id)} onSeriesPress={() => g.seriesId && openSeries(g.seriesId)} />)}
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 18, fontWeight: "700" }}>Past & closed ({past.length})</Text>
        {past.length === 0 && <Text style={{ color: "#666" }}>Nothing here yet.</Text>}
        {past.map((g) => <GigListItem key={g.id} gig={g} onPress={() => openGig(g.id)} onSeriesPress={() => g.seriesId && openSeries(g.seriesId)} />)}
      </View>

      <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: "#eee", paddingTop: 16 }}>
        <Text style={{ fontSize: 18, fontWeight: "700" }}>Series ({series.length})</Text>
        {series.length === 0 && <Text style={{ color: "#666" }}>No recurring series yet.</Text>}
        {series.map((s) => (
          <Pressable key={s.id} onPress={() => openSeries(s.id)}
            style={{ borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 10, gap: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ fontWeight: "700", flex: 1 }}>{s.template.title || "Untitled series"}</Text>
              <Badge label={SERIES_STATUS_LABEL[s.status]} bg="#e0e7ff" />
            </View>
            <Text style={{ color: "#666", fontSize: 13 }}>
              {WEEKDAY_LABELS[s.recurrence.weekday]}s, {String(s.recurrence.hour).padStart(2, "0")}:{String(s.recurrence.minute).padStart(2, "0")}, {s.recurrence.cadence}
            </Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}
