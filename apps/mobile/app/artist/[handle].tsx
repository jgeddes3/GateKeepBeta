import { useEffect, useState } from "react";
import { ScrollView, View, Text, Image, Pressable, Linking } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { doc, getDoc, getDocs, collection, query, where, orderBy } from "firebase/firestore";
import { ref as storageRef, getDownloadURL } from "firebase/storage";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { getFirebase } from "../../src/lib/firebase";
import type { ProfileDoc, TrackDoc } from "@gatekeep/shared";

type LoadedTrack = { id: string; title: string; durationSec: number | null; url: string };

const fmtDuration = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function TrackRow({ t, playingId, onPlay }:
  { t: LoadedTrack; playingId: string | null; onPlay: (t: LoadedTrack) => void }) {
  return (
    <Pressable onPress={() => onPlay(t)} accessibilityRole="button" accessibilityLabel={`Play ${t.title}`}
      style={{ flexDirection: "row", gap: 10, alignItems: "center", borderWidth: 1,
        borderColor: "#ddd", borderRadius: 8, padding: 12 }}>
      <Text>{playingId === t.id ? "❚❚" : "▶"}</Text>
      <Text style={{ flex: 1 }}>{t.title}</Text>
      <Text style={{ color: "#888" }}>{t.durationSec ? fmtDuration(t.durationSec) : ""}</Text>
    </Pressable>
  );
}

export default function Artist() {
  const { handle: rawHandle } = useLocalSearchParams<{ handle: string }>();
  // Handles are stored lowercase (functions/src/profiles.ts); the route
  // param can arrive in any case a user typed or shared a link with —
  // normalize before every lookup, mirroring web's app/u/[handle]/page.tsx
  // fix (a mismatched-case lookup there used to silently 404).
  const handle = (rawHandle ?? "").toLowerCase();
  const [state, setState] = useState<"loading" | "notfound" | {
    profile: ProfileDoc; tracks: LoadedTrack[]; avatarUrl: string | null; coverUrl: string | null;
  }>("loading");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);

  // Clears the "now playing" row highlight when a clip ends on its own.
  // play()'s manual toggle-off branch below already clears playingId itself
  // synchronously, so this only needs to cover the case that branch
  // doesn't: reaching the end of the clip unattended. Deliberately keyed on
  // `didJustFinish` alone, not a broader "status.playing went false" check —
  // replace() (switching straight from one track to another while one is
  // still playing, in the same branch below) can report a transient
  // playing:false while the new source loads, before play() resumes it; a
  // generic playing-went-false clear would race that reload and wrongly
  // un-highlight the row for the track that's actually about to play.
  // didJustFinish is the native "actually reached the end" signal and isn't
  // subject to that reload blip.
  useEffect(() => {
    if (status.didJustFinish) setPlayingId(null);
  }, [status.didJustFinish]);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
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
        const [tracks, avatarUrl, coverUrl] = await Promise.all([
          Promise.all(trackSnap.docs.map(async (t) => {
            const d = t.data() as TrackDoc;
            const u = await url(d.storagePath);
            return u ? { id: t.id, title: d.title, durationSec: d.durationSec, url: u } : null;
          })).then((rows) => rows.filter((x): x is LoadedTrack => x !== null)),
          url(profile.portfolio?.avatarPhotoPath),
          url(profile.portfolio?.coverPhotoPath),
        ]);
        if (!cancelled) setState({ profile, tracks, avatarUrl, coverUrl });
      } catch (e) {
        // permission-denied (a draft/pending/rejected profile's Firestore
        // rules deny the read) means "not approved" — from the public's
        // point of view that's a legitimate not-found, not a leak of
        // whether a handle exists behind the scenes. Anything else (offline,
        // a missing index, a real backend outage) still lands on the same
        // "not found" screen here — mobile has no separate error route to
        // send it to — but gets logged so a real outage doesn't vanish
        // silently the way web's loadProfile explicitly distinguishes.
        console.error("artist page load failed", handle, e);
        if (!cancelled) setState("notfound");
      }
    })();
    return () => { cancelled = true; };
  }, [handle]);

  if (state === "loading") {
    return <View style={{ flex: 1, justifyContent: "center" }}><Text style={{ textAlign: "center" }}>Loading…</Text></View>;
  }
  if (state === "notfound") {
    return <View style={{ flex: 1, justifyContent: "center" }}><Text style={{ textAlign: "center" }}>No profile at @{handle}.</Text></View>;
  }

  const { profile, tracks, avatarUrl, coverUrl } = state;
  const pf = profile.portfolio;
  const play = (t: LoadedTrack) => {
    if (playingId === t.id) { player.pause(); setPlayingId(null); return; }
    // Single active player: replace() swaps whatever was loaded (including a
    // still-playing previous track) with the new source before playing it.
    player.replace({ uri: t.url });
    player.play();
    setPlayingId(t.id);
  };

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
      {coverUrl && <Image source={{ uri: coverUrl }} style={{ width: "100%", height: 180 }} />}
      <View style={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
          {avatarUrl && <Image source={{ uri: avatarUrl }}
            style={{ width: 72, height: 72, borderRadius: 36, marginTop: coverUrl ? -40 : 0,
              borderWidth: 3, borderColor: "#fff" }} />}
          <View>
            <Text style={{ fontSize: 24, fontWeight: "700" }}>{profile.name}</Text>
            <Text style={{ color: "#666" }}>@{profile.handle}{pf?.genres?.length ? ` · ${pf.genres.join(" · ")}` : ""}</Text>
          </View>
        </View>
        {tracks.length > 0 && (
          <View style={{ gap: 6 }}>
            <Text style={{ fontSize: 18, fontWeight: "700" }}>Listen</Text>
            {tracks.map((t) => <TrackRow key={t.id} t={t} playingId={playingId} onPlay={play} />)}
          </View>
        )}
        {pf?.bio ? (
          <>
            <Text style={{ fontSize: 18, fontWeight: "700" }}>About</Text>
            <Text style={{ lineHeight: 21 }}>{pf.bio}</Text>
          </>
        ) : null}
        {pf?.externalLinks && pf.externalLinks.length > 0 && (
          <View style={{ flexDirection: "row", gap: 14, flexWrap: "wrap" }}>
            {pf.externalLinks.map((l) => (
              <Pressable key={`${l.kind}:${l.url}`} onPress={() => void Linking.openURL(l.url)}>
                <Text style={{ textDecorationLine: "underline" }}>{l.kind}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {tracks.length === 0 && !pf?.bio && (
          <Text style={{ color: "#888" }}>This artist hasn&#39;t added content yet.</Text>
        )}
        {/* Shows: platform events only — section appears when sub-4/6 data exists. */}
      </View>
    </ScrollView>
  );
}
