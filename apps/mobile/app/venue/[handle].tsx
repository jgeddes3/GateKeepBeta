import { useEffect, useState } from "react";
import { ScrollView, View, Image, Pressable } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { doc, getDoc, getDocs, collection, query, where, orderBy } from "firebase/firestore";
import type { CuratorSubtype, EventDoc, ProfileDoc } from "@gatekeep/shared";
import { publicStorageUrl } from "../../src/discover/storageUrl";
import { FollowButton } from "../../src/discover/FollowButton";
import { getFirebase } from "../../src/lib/firebase";
import { gigLocationLabel } from "../../src/bookings/BookingForms";
import { formatEventFullDate, formatEventTimeRange } from "../../src/events/eventDisplay";
import {
  Text, Card, Badge, PageBackground, PhotoScrim, PhotoPlaceholder, Skeleton, SkeletonCard,
  IconImages,
} from "../../src/ui";
import { useTokens } from "../../src/theme/ThemeProvider";
import { tokens } from "../../src/theme/tokens";

// SP7 Task 11: the fan-facing curator public page. RN twin of the lookup
// shape apps/mobile/app/artist/[handle].tsx already established (handles/
// {handle} -> profiles/{id}, a "loading" | "notfound" | loaded state
// machine), widened to curator profiles: type must be "curator" (every
// subtype: venue, planner, individual_host), never musician. Named "venue"
// (not "curator") to match this task's own FollowButton copy ("Follow
// venue") and the route the Following screen and NotificationsList's
// show_announced/show_rescheduled/show_post deep links already assume for a
// curator target.

type EventRow = { id: string } & EventDoc;

const SUBTYPE_LABEL: Record<CuratorSubtype, string> = {
  venue: "Venue", planner: "Planner", individual_host: "Individual host",
};

function locationLine(location: { neighborhood: string | null; city: string }): string {
  return location.neighborhood ? `${location.neighborhood}, ${location.city}` : location.city;
}

function UpcomingEventRow({ event, onPress }: { event: EventRow; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={event.title || "Untitled event"}>
      <Card style={{ gap: 4 }}>
        <Text variant="label" numberOfLines={1}>{event.title || "Untitled event"}</Text>
        <Text variant="meta" muted numberOfLines={1}>
          {formatEventFullDate(event.startsAt)} · {formatEventTimeRange(event.startsAt, event.endsAt)}
        </Text>
        <Text variant="meta" muted numberOfLines={1}>{gigLocationLabel(event.location)}</Text>
      </Card>
    </Pressable>
  );
}

// Upcoming, published events for this curator: `curatorProfileId ==` and
// `status == "published"` are both equality pins, `startsAt >=` a range
// clause ordered by the same field, matching the composite index sub-6
// already created (curatorProfileId, status, startsAt).
async function loadUpcomingEvents(curatorProfileId: string): Promise<EventRow[]> {
  const { db } = getFirebase();
  const snap = await getDocs(query(
    collection(db, "events"),
    where("curatorProfileId", "==", curatorProfileId),
    where("status", "==", "published"),
    where("startsAt", ">=", Date.now()),
    orderBy("startsAt")));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as EventDoc) }));
}

export default function Venue() {
  const { handle: rawHandle } = useLocalSearchParams<{ handle: string }>();
  const handle = (rawHandle ?? "").toLowerCase();
  const router = useRouter();
  const t = useTokens();
  const [state, setState] = useState<"loading" | "notfound" | {
    profileId: string; profile: ProfileDoc; photoUrls: string[]; upcomingEvents: EventRow[];
  }>("loading");

  // Render-time reset, mirroring artist/[handle].tsx's own lastHandle idiom:
  // without it a reused screen instance would flash the PREVIOUS venue's
  // already-loaded content under a new handle for a frame.
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
        if (!p.exists() || (p.data() as ProfileDoc).type !== "curator") {
          if (!cancelled) setState("notfound"); return;
        }
        const profile = p.data() as ProfileDoc;
        const photoUrls = (profile.curator?.photoPaths ?? []).map((path) => publicStorageUrl(path));
        const upcomingEvents = await loadUpcomingEvents(profileId).catch((e) => {
          // Auxiliary content shouldn't take down the whole page (same
          // tradeoff artist/[handle].tsx's own loadShows makes): an empty
          // Shows section beats crashing this screen.
          console.error("venue upcoming events load failed", profileId, e);
          return [] as EventRow[];
        });
        if (!cancelled) setState({ profileId, profile, photoUrls, upcomingEvents });
      } catch (e) {
        // permission-denied means "not approved", a legitimate not-found
        // from the public's point of view, mirroring artist/[handle].tsx's
        // own comment.
        const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
        if (code !== "permission-denied") console.error("venue page load failed", handle, e);
        if (!cancelled) setState("notfound");
      }
    })();
    return () => { cancelled = true; };
  }, [handle]);

  if (state === "loading") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
          <Skeleton height={210} radius={0} />
          <View style={{ padding: 16, gap: 12 }}>
            <Skeleton height={26} width="55%" />
            <Skeleton height={16} width="40%" />
            <Skeleton height={16} width="90%" />
            <SkeletonCard />
          </View>
        </ScrollView>
      </View>
    );
  }
  if (state === "notfound") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 6 }}>
          <Text variant="title">Venue not found</Text>
          <Text muted style={{ textAlign: "center" }}>No profile at @{handle}.</Text>
        </View>
      </View>
    );
  }

  const { profileId, profile, photoUrls, upcomingEvents } = state;
  const c = profile.curator;
  const subtype = profile.subtype as CuratorSubtype;
  const isVenue = subtype === "venue";
  const heroUrl = photoUrls[0] ?? null;

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ height: 210 }}>
          {heroUrl ? (
            <Image source={{ uri: heroUrl }} style={{ position: "absolute", inset: 0 }} />
          ) : (
            <PhotoPlaceholder icon={<IconImages size={40} color={t.muted} />} />
          )}
          <PhotoScrim />
          <View style={{ position: "absolute", left: 16, right: 16, bottom: 12 }}>
            <Text variant="heading" color={tokens.dark.text} numberOfLines={2}>{profile.name}</Text>
          </View>
        </View>

        <View style={{ padding: 16, gap: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <Badge label={SUBTYPE_LABEL[subtype]} />
            {c?.location?.neighborhood && <Badge label={c.location.neighborhood} />}
            <FollowButton targetId={profileId} targetType="curator" label={isVenue ? "Follow venue" : undefined} />
          </View>

          {photoUrls.length > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {photoUrls.slice(1).map((url) => (
                <Image key={url} source={{ uri: url }}
                  style={{ width: 96, height: 96, borderRadius: tokens.radius.sm, borderWidth: 1, borderColor: t.border }} />
              ))}
            </ScrollView>
          )}

          {c?.about ? (
            <View style={{ gap: 6 }}>
              <Text variant="title">About</Text>
              <Text style={{ lineHeight: 21 }}>{c.about}</Text>
            </View>
          ) : null}

          {c?.location?.city && (
            <Text muted>{locationLine(c.location)}</Text>
          )}

          {!c?.about && photoUrls.length === 0 && (
            <Text muted>This venue hasn&#39;t added content yet.</Text>
          )}

          {upcomingEvents.length > 0 && (
            <View style={{ gap: 8 }}>
              <Text variant="title">Upcoming events</Text>
              {upcomingEvents.map((event) => (
                <UpcomingEventRow
                  key={event.id} event={event}
                  onPress={() => router.push({ pathname: "/event/[eventId]", params: { eventId: event.id } })}
                />
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
