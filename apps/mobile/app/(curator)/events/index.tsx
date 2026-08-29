import { useEffect, useRef, useState } from "react";
import { ScrollView, View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { doc, onSnapshot, collection, query, where } from "firebase/firestore";
import { getFirebase } from "../../../src/lib/firebase";
import { useAuth } from "../../../src/auth/AuthProvider";
import { useProfileContext } from "../../../src/shell/ProfileContext";
import {
  GIG_STATUS_LABEL, SERIES_STATUS_LABEL, BUDGET_STRUCTURE_LABEL, WEEKDAY_LABELS, GIG_STATUS_TONE,
  formatGigDateTime, formatCents,
} from "../../../src/gigs/GigForms";
import type { ProfileDoc, GigDoc, GigSeriesDoc } from "@gatekeep/shared";
import { Text, Button, Card, StatusBadge, PageBackground, Skeleton, SkeletonCard } from "../../../src/ui";
import { useTokens } from "../../../src/theme/ThemeProvider";
import { tokens } from "../../../src/theme/tokens";

type GigRow = GigDoc & { id: string };
type SeriesRow = GigSeriesDoc & { id: string };

// Sorted ascending (soonest first) for open/drafts, "what's coming up" is
// the useful question there, and descending (most recent first) for the
// past group, where "what just happened" matters more. Mirrors web's
// dashboard/curator/[profileId]/gigs/page.tsx exactly.
const byStartsAtAsc = (a: GigRow, b: GigRow) => a.startsAt - b.startsAt;
const byStartsAtDesc = (a: GigRow, b: GigRow) => b.startsAt - a.startsAt;

function GigListItem({ gig, onPress, onSeriesPress }: {
  gig: GigRow; onPress: () => void; onSeriesPress: () => void;
}) {
  const t = useTokens();
  return (
    <Pressable onPress={onPress}>
      <Card style={{ padding: tokens.space.md, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>{gig.title || "Untitled gig"}</Text>
          <StatusBadge label={GIG_STATUS_LABEL[gig.status]} status={GIG_STATUS_TONE[gig.status]} />
        </View>
        <Text variant="meta" muted>
          {formatGigDateTime(gig.startsAt)}
          {" · "}{formatCents(gig.budget.minCents)}–{formatCents(gig.budget.maxCents)} {BUDGET_STRUCTURE_LABEL[gig.budget.structure]}
        </Text>
        {gig.seriesId && (
          <Pressable onPress={onSeriesPress} hitSlop={8}>
            <Text variant="meta" color={t.accent}>series{gig.detachedFromTemplate ? " (detached)" : ""} →</Text>
          </Pressable>
        )}
      </Card>
    </Pressable>
  );
}

export default function GigsList() {
  const { user } = useAuth();
  const router = useRouter();
  const t = useTokens();
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
  // profiles could leave the PREVIOUS profile's gigs/series on screen, the
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
  // where(curatorProfileId=='X') with NO status filter, rules-provable for a
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
  // Same shape for gigSeries, its read rule (isMember(curatorProfileId) ||
  // isAdmin(), no public disjunct) is provable the identical way.
  useEffect(() => {
    if (!profileId) return;
    const forId = profileId;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "gigSeries"), where("curatorProfileId", "==", profileId)),
      (s) => { if (activeIdRef.current !== forId) return; setSeries(s.docs.map((d) => ({ id: d.id, ...(d.data() as GigSeriesDoc) }))); });
  }, [profileId]);

  if (!user || !profileId) {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.sm }}>
          <Text variant="title">No curator profile</Text>
          <Text muted style={{ textAlign: "center" }}>Switch to a curator profile to see its gigs.</Text>
        </View>
      </View>
    );
  }
  if (!profile) {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ padding: tokens.space.lg, gap: tokens.space.lg }}>
          <Skeleton height={44} />
          <SkeletonCard />
          <SkeletonCard />
        </View>
      </View>
    );
  }

  const open = gigs.filter((g) => g.status === "open").sort(byStartsAtAsc);
  const drafts = gigs.filter((g) => g.status === "draft").sort(byStartsAtAsc);
  const past = gigs.filter((g) => g.status === "closed" || g.status === "cancelled" || g.status === "taken_down").sort(byStartsAtDesc);

  const openGig = (gigId: string) => router.push({ pathname: "/(curator)/events/[gigId]", params: { gigId } });
  const openSeries = (seriesId: string) => router.push({ pathname: "/(curator)/events/series/[seriesId]", params: { seriesId } });

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.xl }} keyboardShouldPersistTaps="handled">
        {profile.status === "approved" ? (
          <Button title="+ Post a new gig" onPress={() => router.push("/(curator)/events/new")} />
        ) : (
          <Text muted>Your curator profile must be approved before you can post gigs.</Text>
        )}

        <View style={{ gap: 8 }}>
          <Text variant="title">Open ({open.length})</Text>
          {open.length === 0 && <Text muted>No open gigs.</Text>}
          {open.map((g) => <GigListItem key={g.id} gig={g} onPress={() => openGig(g.id)} onSeriesPress={() => g.seriesId && openSeries(g.seriesId)} />)}
        </View>

        <View style={{ gap: 8 }}>
          <Text variant="title">Drafts ({drafts.length})</Text>
          {drafts.length === 0 && <Text muted>No drafts.</Text>}
          {drafts.map((g) => <GigListItem key={g.id} gig={g} onPress={() => openGig(g.id)} onSeriesPress={() => g.seriesId && openSeries(g.seriesId)} />)}
        </View>

        <View style={{ gap: 8 }}>
          <Text variant="title">Past & closed ({past.length})</Text>
          {past.length === 0 && <Text muted>Nothing here yet.</Text>}
          {past.map((g) => <GigListItem key={g.id} gig={g} onPress={() => openGig(g.id)} onSeriesPress={() => g.seriesId && openSeries(g.seriesId)} />)}
        </View>

        <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: t.border, paddingTop: 16 }}>
          <Text variant="title">Series ({series.length})</Text>
          {series.length === 0 && <Text muted>No recurring series yet.</Text>}
          {series.map((s) => (
            <Pressable key={s.id} onPress={() => openSeries(s.id)}>
              <Card style={{ padding: tokens.space.md, gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>{s.template.title || "Untitled series"}</Text>
                  <StatusBadge label={SERIES_STATUS_LABEL[s.status]} status="neutral" />
                </View>
                <Text variant="meta" muted>
                  {WEEKDAY_LABELS[s.recurrence.weekday]}s, {String(s.recurrence.hour).padStart(2, "0")}:{String(s.recurrence.minute).padStart(2, "0")}, {s.recurrence.cadence}
                </Text>
              </Card>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
