import { useEffect, useState } from "react";
import { ScrollView, View, Image, Pressable, Linking } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { doc, getDoc, getDocs, collection, query, where, orderBy } from "firebase/firestore";
import { ref as storageRef, getDownloadURL } from "firebase/storage";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { getFirebase } from "../../src/lib/firebase";
import { formatGigDateTime } from "../../src/gigs/GigForms";
import { gigLocationLabel } from "../../src/bookings/BookingForms";
import type { ProfileDoc, TrackDoc, GigDoc, GigPublicLocation, ActSize, AvailabilityPattern } from "@gatekeep/shared";
import {
  Text, Card, PageBackground, PhotoScrim, PhotoPlaceholder, Skeleton, SkeletonCard,
  IconPlay, IconPause, IconUserCircle,
} from "../../src/ui";
import { useTokens } from "../../src/theme/ThemeProvider";
import { tokens } from "../../src/theme/tokens";

type LoadedTrack = { id: string; title: string; durationSec: number | null; url: string };

// SP4 Task 12. Shows entry: one filled/closed-booked gig, plus the booking
// curator's resolved display name. Mirrors web's app/u/[handle]/page.tsx
// ShowEntry, minus `otherProfileHandle`, mobile has no public
// curator-profile route to link to (see ShowRow's comment below), so the
// name is plain text here and there's nothing to resolve a handle for.
type ShowEntry = {
  gigId: string; title: string; startsAtMs: number; location: GigPublicLocation; curatorName: string;
};

const ACT_SIZE_LABEL: Record<ActSize, string> = { solo: "Solo", duo: "Duo", band: "Band" };
const AVAILABILITY_LABEL: Record<AvailabilityPattern, string> = {
  weekends: "Weekends", weeknights: "Weeknights", anytime: "Anytime", limited: "Limited",
};

// Musician-page Shows query (Task 11/12): a single `status in [...]` query
// is list-provable here because bookedMusicianProfileId is pinned by
// EQUALITY to one specific non-null profileId, see firestore.rules' gigs
// read rule comment. No `.limit()` at the query level (the ascending order
// would bias toward the OLDEST rows); the 20/20 upcoming/past caps are
// applied in JS below, after the (bounded-in-practice) full result is in
// hand, mirrors web's loadMusicianShows exactly, just client-SDK instead
// of admin-SDK (mobile has no SSR path to prefer).
async function loadShows(profileId: string): Promise<{ upcoming: ShowEntry[]; past: ShowEntry[] }> {
  try {
    const { db } = getFirebase();
    const snap = await getDocs(query(
      collection(db, "gigs"),
      where("bookedMusicianProfileId", "==", profileId),
      where("status", "in", ["filled", "closed"]),
      orderBy("startsAt")));
    const gigs = snap.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) }));
    // Batched cross-reference curator-name lookup: one Promise.all over the
    // UNIQUE curator ids in the result, not one sequential getDoc per row
    // (n+1-avoidance, bounded). A single id's lookup failing
    // (permission-denied, that curator has since gone unapproved/deleted,
    // or any other read error) doesn't fail the whole Shows section; falls
    // back to a placeholder name for that one row.
    const uniqueCuratorIds = Array.from(new Set(gigs.map((g) => g.curatorProfileId)));
    const names = new Map<string, string>();
    await Promise.all(uniqueCuratorIds.map(async (id) => {
      try {
        const p = await getDoc(doc(db, "profiles", id));
        names.set(id, p.exists() ? (p.data() as ProfileDoc).name : "Unknown");
      } catch {
        names.set(id, "Unknown");
      }
    }));
    const now = Date.now();
    const entries: ShowEntry[] = gigs.map((g) => (
      { gigId: g.id, title: g.title, startsAtMs: g.startsAt, location: g.location, curatorName: names.get(g.curatorProfileId) ?? "Unknown" }
    ));
    return {
      upcoming: entries.filter((e) => e.startsAtMs > now).slice(0, 20), // already ascending -> soonest first
      past: entries.filter((e) => e.startsAtMs <= now).slice(-20).reverse(), // newest first
    };
  } catch (e) {
    // Same "auxiliary content shouldn't take down the whole page" tradeoff
    // as the track/photo loads below, an empty Shows section
    // (indistinguishable from the legitimate no-shows-yet case, per its own
    // hidden-while-empty contract) beats crashing this screen.
    console.error("loadShows failed", profileId, e);
    return { upcoming: [], past: [] };
  }
}

// The curator name is plain text here, not a link: mobile has no public
// curator-profile route (app/artist/[handle].tsx renders musicians only,
// see the type!=="musician" guard below), unlike web's /@handle, which
// resolves either profile type. Nothing to navigate to on this platform.
function ShowRow({ show }: { show: ShowEntry }) {
  return (
    <Card style={{ gap: 4 }}>
      <Text variant="label">{show.title || "Untitled gig"}</Text>
      <Text variant="meta" muted>{formatGigDateTime(show.startsAtMs)} · {gigLocationLabel(show.location)}</Text>
      <Text variant="meta" muted>{show.curatorName}</Text>
    </Card>
  );
}

const fmtDuration = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function TrackRow({ t, playingId, onPlay }:
  { t: LoadedTrack; playingId: string | null; onPlay: (t: LoadedTrack) => void }) {
  const tk = useTokens();
  const active = playingId === t.id;
  return (
    <Pressable onPress={() => onPlay(t)} accessibilityRole="button" accessibilityLabel={`Play ${t.title}`}
      style={{ flexDirection: "row", gap: 12, alignItems: "center", borderWidth: 1,
        borderColor: tk.border, borderRadius: tokens.radius.card, padding: 12, backgroundColor: tk.surface }}>
      <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center",
        backgroundColor: active ? tk.accent : tk.bg0, borderWidth: 1, borderColor: active ? tk.accent : tk.border }}>
        {active ? <IconPause size={18} color={tk.onAccent} /> : <IconPlay size={18} color={tk.text} />}
      </View>
      <Text style={{ flex: 1 }}>{t.title}</Text>
      <Text variant="meta" muted>{t.durationSec ? fmtDuration(t.durationSec) : ""}</Text>
    </Pressable>
  );
}

export default function Artist() {
  const { handle: rawHandle } = useLocalSearchParams<{ handle: string }>();
  // Handles are stored lowercase (functions/src/profiles.ts); the route
  // param can arrive in any case a user typed or shared a link with,
  // normalize before every lookup, mirroring web's app/u/[handle]/page.tsx
  // fix (a mismatched-case lookup there used to silently 404).
  const handle = (rawHandle ?? "").toLowerCase();
  const [state, setState] = useState<"loading" | "notfound" | {
    profile: ProfileDoc; tracks: LoadedTrack[]; avatarUrl: string | null; coverUrl: string | null;
    upcomingShows: ShowEntry[]; pastShows: ShowEntry[];
  }>("loading");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const t = useTokens();

  // Render-time reset, mirroring (musician)/portfolio.tsx's `lastProfileId`
  // pattern: if this screen instance is ever reused across a handle change
  // (e.g. a replace-style navigation from one artist page straight to
  // another instead of a fresh push/mount) the fetch effect below, keyed
  // on `handle`, wouldn't reset `state` to "loading" until it runs, which
  // is after commit+paint. Without this, that gap paints the PREVIOUS
  // artist's already-loaded content under the new handle for a frame.
  // Adjusted synchronously during render (React's documented "adjust state
  // while rendering" pattern) so React re-renders with "loading" before
  // committing.
  const [lastHandle, setLastHandle] = useState(handle);
  if (handle !== lastHandle) {
    setLastHandle(handle);
    setState("loading");
  }

  // Clears the "now playing" row highlight when a clip ends on its own.
  // play()'s manual toggle-off branch below already clears playingId itself
  // synchronously, so this only needs to cover the case that branch
  // doesn't: reaching the end of the clip unattended. Deliberately keyed on
  // `didJustFinish` alone, not a broader "status.playing went false" check:
  // replace() (switching straight from one track to another while one is
  // still playing, in the same branch below) can report a transient
  // playing:false while the new source loads, before play() resumes it; a
  // generic playing-went-false clear would race that reload and wrongly
  // un-highlight the row for the track that's actually about to play.
  // didJustFinish is the native "actually reached the end" signal and isn't
  // subject to that reload blip.
  useEffect(() => {
    // Reacting to an edge (native player status transitioning to
    // didJustFinish=true) is exactly the "subscribe to an external
    // system, setState in response" case react-hooks/set-state-in-effect's
    // own docs carve out, there's no prop/state this is purely derived
    // from that render-time logic could substitute for, and the comment
    // above explains exactly why the dependency is `didJustFinish` alone.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (status.didJustFinish) setPlayingId(null);
  }, [status.didJustFinish]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { db, storage } = getFirebase();
        const h = await getDoc(doc(db, "handles", handle));
        if (!h.exists()) { if (!cancelled) setState("notfound"); return; }
        const profileId = h.data().profileId as string;
        const p = await getDoc(doc(db, "profiles", profileId)); // rules deny unless approved/member/admin
        if (!p.exists() || (p.data() as ProfileDoc).type !== "musician") {
          if (!cancelled) setState("notfound"); return;
        }
        const profile = p.data() as ProfileDoc;
        const url = async (path: string | null | undefined) => {
          if (!path) return null;
          try { return await getDownloadURL(storageRef(storage, path)); } catch { return null; }
        };
        const trackSnap = await getDocs(query(collection(db, `profiles/${profileId}/tracks`),
          where("status", "==", "approved"), orderBy("order")));
        const [tracks, avatarUrl, coverUrl, shows] = await Promise.all([
          Promise.all(trackSnap.docs.map(async (t) => {
            const d = t.data() as TrackDoc;
            const u = await url(d.storagePath);
            return u ? { id: t.id, title: d.title, durationSec: d.durationSec, url: u } : null;
          })).then((rows) => rows.filter((x): x is LoadedTrack => x !== null)),
          url(profile.portfolio?.avatarPhotoPath),
          url(profile.portfolio?.coverPhotoPath),
          loadShows(profileId),
        ]);
        if (!cancelled) setState({ profile, tracks, avatarUrl, coverUrl, upcomingShows: shows.upcoming, pastShows: shows.past });
      } catch (e) {
        // permission-denied (a draft/pending/rejected profile's Firestore
        // rules deny the read) means "not approved", from the public's
        // point of view that's a legitimate not-found, not a leak of
        // whether a handle exists behind the scenes. Anything else (offline,
        // a missing index, a real backend outage) still lands on the same
        // "not found" screen here, mobile has no separate error route to
        // send it to, but gets logged so a real outage doesn't vanish
        // silently the way web's loadProfile explicitly distinguishes.
        console.error("artist page load failed", handle, e);
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
            <Skeleton height={16} width="80%" />
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
          <Text variant="title">Artist not found</Text>
          <Text muted style={{ textAlign: "center" }}>No profile at @{handle}.</Text>
        </View>
      </View>
    );
  }

  const { profile, tracks, avatarUrl, coverUrl, upcomingShows, pastShows } = state;
  const pf = profile.portfolio;
  // Optional (not `publicBooking:`) on ProfileDoc, legacy pre-SP4 docs lack
  // the field entirely; `?? null` treats "absent" identically to "present
  // and explicitly null" (never public), per the field's own migration
  // comment in packages/shared/src/types.ts. NEVER rates, publicBooking's
  // type (BookingPreferences) has no rate fields, so this section literally
  // cannot render them.
  const publicBooking = profile.publicBooking ?? null;
  const hasAnyBookingPref = publicBooking != null && (
    publicBooking.actSize != null || publicBooking.typicalSetMinutes != null
    || publicBooking.bringsOwnPA != null || publicBooking.availabilityPattern != null);
  // Finding 8: validatePortfolioUpdate already requires https:// at save
  // time, but a link saved before that validation existed (or one on an
  // already-approved profile) could still carry a non-https scheme.
  // Android's Linking.openURL will happily dispatch those (tel:, intent:,
  // custom app schemes...) with no interstitial warning. Filter before
  // rendering, matching web's app/u/[handle]/page.tsx.
  const links = (pf?.externalLinks ?? []).filter((l) => l.url.startsWith("https://"));
  const play = (t: LoadedTrack) => {
    if (playingId === t.id) { player.pause(); setPlayingId(null); return; }
    // Single active player: replace() swaps whatever was loaded (including a
    // still-playing previous track) with the new source before playing it.
    player.replace({ uri: t.url });
    player.play();
    setPlayingId(t.id);
  };

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ height: 210 }}>
          {coverUrl ? (
            <Image source={{ uri: coverUrl }} style={{ position: "absolute", inset: 0 }} />
          ) : (
            <PhotoPlaceholder icon={<IconUserCircle size={44} color={t.muted} />} />
          )}
          <PhotoScrim />
          <View style={{ position: "absolute", left: 16, right: 16, bottom: 12,
            flexDirection: "row", alignItems: "flex-end", gap: 12 }}>
            {avatarUrl && <Image source={{ uri: avatarUrl }}
              style={{ width: 64, height: 64, borderRadius: 32, borderWidth: 3, borderColor: t.bg0 }} />}
            <Text variant="heading" color={tokens.dark.text} numberOfLines={2} style={{ flex: 1 }}>{profile.name}</Text>
          </View>
        </View>
        <View style={{ padding: 16, gap: 12 }}>
          <Text muted>@{profile.handle}{pf?.genres?.length ? ` · ${pf.genres.join(" · ")}` : ""}</Text>
          {tracks.length > 0 && (
            <View style={{ gap: 8 }}>
              <Text variant="title">Listen</Text>
              {tracks.map((t) => <TrackRow key={t.id} t={t} playingId={playingId} onPlay={play} />)}
            </View>
          )}
          {pf?.bio ? (
            <View style={{ gap: 6 }}>
              <Text variant="title">About</Text>
              <Text style={{ lineHeight: 21 }}>{pf.bio}</Text>
            </View>
          ) : null}
          {links.length > 0 && (
            <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
              {links.map((l) => (
                <Pressable key={`${l.kind}:${l.url}`} onPress={() => void Linking.openURL(l.url)}
                  style={{ borderWidth: 1, borderColor: t.border, borderRadius: tokens.radius.pill,
                    paddingHorizontal: 14, paddingVertical: 8 }}>
                  <Text variant="label">{l.kind}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {tracks.length === 0 && !pf?.bio && (
            <Text muted>This artist hasn&#39;t added content yet.</Text>
          )}
          {/* Booking preferences (SP4 Task 12): rendered only when this
              musician opted their preferences public (BookingVisibility.
              preferences == "public") AND at least one field is actually
              set, an all-null publicBooking (every field explicitly opted
              out, or a projection written before any field was filled in)
              would otherwise render a bare "Booking preferences" heading
              with nothing under it. */}
          {hasAnyBookingPref && publicBooking && (
            <View style={{ gap: 6 }}>
              <Text variant="title">Booking preferences</Text>
              {publicBooking.actSize != null && <Text>Act size: {ACT_SIZE_LABEL[publicBooking.actSize]}</Text>}
              {publicBooking.typicalSetMinutes != null && <Text>Typical set: {publicBooking.typicalSetMinutes} min</Text>}
              {publicBooking.bringsOwnPA != null && <Text>Brings own PA: {publicBooking.bringsOwnPA ? "Yes" : "No"}</Text>}
              {publicBooking.availabilityPattern != null && (
                <Text>Availability: {AVAILABILITY_LABEL[publicBooking.availabilityPattern]}</Text>
              )}
            </View>
          )}
          {/* Shows (SP4 Task 12): this musician's own filled/closed-booked
              gigs, the SP2 hidden-while-empty contract, now real (was
              platform-events-only in SP2; SP4's booking flow is what
              actually populates it). Hidden entirely (not an empty-state
              message) when there are none, matching the section above. */}
          {(upcomingShows.length > 0 || pastShows.length > 0) && (
            <View style={{ gap: 8 }}>
              <Text variant="title">Shows</Text>
              {upcomingShows.length > 0 && (
                <View style={{ gap: 6 }}>
                  <Text variant="label" muted>Upcoming shows</Text>
                  {upcomingShows.map((s) => <ShowRow key={s.gigId} show={s} />)}
                </View>
              )}
              {pastShows.length > 0 && (
                <View style={{ gap: 6 }}>
                  <Text variant="label" muted>Past shows</Text>
                  {pastShows.map((s) => <ShowRow key={s.gigId} show={s} />)}
                </View>
              )}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
