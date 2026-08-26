import { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, Alert, Image } from "react-native";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, getDownloadURL } from "firebase/storage";
import { getFirebase } from "../lib/firebase";
import { PhotoUploader } from "../portfolio/PortfolioForms";
import {
  GENRES, ACT_SIZES, MAX_CURATOR_PHOTOS, validateLookingFor,
  type LookingFor, type ActSize, type CuratorDetails, type CuratorSubtype,
} from "@gatekeep/shared";

// RN port of ../../web/src/curator/CuratorForms.tsx — sub-project 3's curator
// equivalent of ./../portfolio/PortfolioForms.tsx (SP2-owned), applied to
// CuratorDetails' fields instead of PortfolioData's. Kept in its own file for
// the same reason the web version is: functions/src/curator.ts is split from
// portfolio.ts server-side. Only PhotoUploader is reused as-is from
// PortfolioForms.tsx (its `kind` was widened there to accept "gallery" — see
// that file's comment).
//
// DO-NOT-COPY checklist (SP2 plan Tasks 13/14) applied here:
// - every save is busy-locked and alert-on-failure (callOrAlert below).
// - no crypto.randomUUID anywhere in this file (PhotoUploader owns the only
//   upload nonce, already using the Date.now()+Math.random() pattern).
// - no Intl.ListFormat (this file has no missing-items sentence — that lives
//   in the editor screen, which uses a plain join(", ") per the same note).
// - every form here is meant to be mounted with `key={\`<section>-${profileId}\`}`
//   by its caller (the curator dashboard tab) so switching the active
//   curator profile remounts these instead of leaking stale state — same
//   contract as BioGenresForm/LinksForm/BookingForm.

const callOrAlert = async (name: string, data: object): Promise<boolean> => {
  try { await httpsCallable(getFirebase().functions, name)(data); return true; }
  catch (e) { Alert.alert("Save failed", e instanceof Error ? e.message : "Try again."); return false; }
};

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12,
      borderWidth: 1, borderColor: "#bbb", backgroundColor: active ? "#111" : "#fff" }}>
      <Text style={{ color: active ? "#fff" : "#111" }}>{label}</Text>
    </Pressable>
  );
}

// Mirrors functions/src/curator.ts's MAX_ABOUT_LENGTH — not exported to
// shared, so this is a UX-only soft cap; the server remains the actual gate.
const MAX_ABOUT_LENGTH = 2000;

export function AboutForm({ profileId, initial }: { profileId: string; initial: string | undefined }) {
  const [about, setAbout] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    await callOrAlert("updateCuratorProfile", { profileId, about });
    setBusy(false);
  };
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>About</Text>
      <TextInput multiline numberOfLines={6} maxLength={MAX_ABOUT_LENGTH} value={about} onChangeText={setAbout}
        placeholder="Tell musicians what makes this a good gig — the room, the crowd, what you're building…"
        style={{ borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 120, textAlignVertical: "top" }} />
      <Pressable onPress={() => void save()} disabled={busy} style={{ backgroundColor: "#111", padding: 12, borderRadius: 8 }}>
        <Text style={{ color: "#fff", textAlign: "center" }}>{busy ? "Saving…" : "Save about"}</Text>
      </Pressable>
    </View>
  );
}

// Mirrors functions/src/curator.ts's MAX_CITY_LENGTH / MAX_ADDRESS_LENGTH —
// neither exported to shared, so these are UX-only soft caps; the server
// remains authoritative (including the venue-only address rule, which this
// form never even offers non-venues a field to violate).
const MAX_CITY_LENGTH = 120;
const MAX_ADDRESS_LENGTH = 300;

export function LocationForm({ profileId, subtype, initial }:
  { profileId: string; subtype: CuratorSubtype; initial: CuratorDetails["location"] | undefined }) {
  const isVenue = subtype === "venue";
  const [address, setAddress] = useState(initial?.address ?? "");
  const [city, setCity] = useState(initial?.city ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const trimmedCity = city.trim();
    if (trimmedCity.length < 1 || trimmedCity.length > MAX_CITY_LENGTH) {
      Alert.alert("Check your info", `City is required (1-${MAX_CITY_LENGTH} characters).`);
      return;
    }
    if (isVenue && address.trim().length > MAX_ADDRESS_LENGTH) {
      Alert.alert("Check your info", `Address must be at most ${MAX_ADDRESS_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    // Planners/hosts must NOT send an address — updateCuratorProfile rejects
    // a non-empty one from a non-venue. This form never renders the address
    // field for them, but the payload is built explicitly (not "whatever's
    // in the address state") as a second line of defense.
    await callOrAlert("updateCuratorProfile",
      { profileId, location: { city: trimmedCity, address: isVenue ? (address.trim() || null) : null } });
    setBusy(false);
  };
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>Location</Text>
      {isVenue ? (
        <>
          <Text style={{ color: "#666" }}>Venues show a full street address publicly.</Text>
          <TextInput placeholder="Street address" maxLength={MAX_ADDRESS_LENGTH} value={address} onChangeText={setAddress}
            style={{ borderWidth: 1, borderRadius: 8, padding: 10 }} />
        </>
      ) : (
        <Text style={{ color: "#666" }}>Only your city is shown publicly — never a precise address.</Text>
      )}
      <TextInput placeholder="City" maxLength={MAX_CITY_LENGTH} value={city} onChangeText={setCity}
        style={{ borderWidth: 1, borderRadius: 8, padding: 10 }} />
      {/* Reflects the SERVER's resolved value (post-geocode, which can
          normalize what was typed) rather than local state, so it stays live
          across saves without fighting this form's seed-once-on-mount
          convention. */}
      <Text style={{ color: "#666", fontSize: 13 }}>
        Currently saved: {initial?.city || "none yet"}{initial?.neighborhood ? ` (${initial.neighborhood})` : ""}
      </Text>
      <Pressable onPress={() => void save()} disabled={busy} style={{ backgroundColor: "#111", padding: 12, borderRadius: 8 }}>
        <Text style={{ color: "#fff", textAlign: "center" }}>{busy ? "Saving…" : "Save location"}</Text>
      </Pressable>
    </View>
  );
}

export function LookingForForm({ profileId, initial }: { profileId: string; initial: LookingFor | undefined }) {
  const [genres, setGenres] = useState<string[]>(initial?.genres ?? []);
  const [actSizes, setActSizes] = useState<ActSize[]>(initial?.actSizes ?? []);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const toggleGenre = (g: string) => setGenres((cur) => cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]);
  const toggleActSize = (a: ActSize) => setActSizes((cur) => cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]);
  const save = async () => {
    const input: LookingFor = { genres, actSizes, notes: notes.trim() || null };
    // The one shared validator the task's brief calls out by name — same
    // rule the server enforces, run here first so a curator gets the exact
    // server-worded reason without a round-trip.
    const v = validateLookingFor(input);
    if (!v.ok) { Alert.alert("Check your info", v.reason); return; }
    setBusy(true);
    await callOrAlert("updateCuratorProfile", { profileId, lookingFor: input });
    setBusy(false);
  };
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>What you&#39;re looking for</Text>
      <Text style={{ color: "#666" }}>Genres</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {GENRES.map((g) => <Chip key={g} label={g} active={genres.includes(g)} onPress={() => toggleGenre(g)} />)}
      </View>
      <Text style={{ color: "#666" }}>Act sizes</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {ACT_SIZES.map((a) => <Chip key={a} label={a} active={actSizes.includes(a)} onPress={() => toggleActSize(a)} />)}
      </View>
      <TextInput multiline numberOfLines={3} maxLength={500} value={notes} onChangeText={setNotes}
        placeholder="Anything else musicians should know (optional)"
        style={{ borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 70, textAlignVertical: "top" }} />
      <Pressable onPress={() => void save()} disabled={busy} style={{ backgroundColor: "#111", padding: 12, borderRadius: 8 }}>
        <Text style={{ color: "#fff", textAlign: "center" }}>{busy ? "Saving…" : "Save preferences"}</Text>
      </Pressable>
    </View>
  );
}

// Mirrors functions/src/curator.ts's INDOOR_OUTDOOR_VALUES / MAX_CAPACITY /
// MAX_AMENITY_NOTES_LENGTH — none exported to shared, so these are local UX
// mirrors; the server remains authoritative.
const INDOOR_OUTDOOR_VALUES = ["indoor", "outdoor", "both"] as const;
const MAX_CAPACITY = 100_000;
const MAX_AMENITY_NOTES_LENGTH = 500;
type IndoorOutdoor = (typeof INDOOR_OUTDOOR_VALUES)[number];
type Tri = boolean | null;

export function AmenitiesForm({ profileId, initial, initialAdvertising }:
  { profileId: string; initial: CuratorDetails["amenities"] | undefined; initialAdvertising: boolean | undefined }) {
  const [capacity, setCapacity] = useState(initial?.capacity != null ? String(initial.capacity) : "");
  const [hasPA, setHasPA] = useState<Tri>(initial?.hasPA ?? null);
  const [hasBackline, setHasBackline] = useState<Tri>(initial?.hasBackline ?? null);
  const [indoorOutdoor, setIndoorOutdoor] = useState<IndoorOutdoor | null>(initial?.indoorOutdoor ?? null);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [advertisingInterest, setAdvertisingInterest] = useState(initialAdvertising ?? false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    let capacityNum: number | null = null;
    const raw = capacity.trim();
    if (raw !== "") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > MAX_CAPACITY) {
        Alert.alert("Check your info", `Capacity must be a whole number from 0 to ${MAX_CAPACITY}.`);
        return;
      }
      capacityNum = n;
    }
    if (notes.length > MAX_AMENITY_NOTES_LENGTH) {
      Alert.alert("Check your info", `Amenity notes must be at most ${MAX_AMENITY_NOTES_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    // Both fields land in one updateCuratorProfile call — the brief groups
    // "amenities + advertising toggle" as a single section/save.
    await callOrAlert("updateCuratorProfile", {
      profileId,
      amenities: { capacity: capacityNum, hasPA, hasBackline, indoorOutdoor, notes: notes.trim() || null },
      advertisingInterest,
    });
    setBusy(false);
  };

  const triRow = (label: string, value: Tri, set: (v: Tri) => void) => (
    <View style={{ gap: 4 }}>
      <Text>{label}</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Chip label="Yes" active={value === true} onPress={() => set(value === true ? null : true)} />
        <Chip label="No" active={value === false} onPress={() => set(value === false ? null : false)} />
      </View>
    </View>
  );

  return (
    <View style={{ gap: 10 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>Amenities</Text>
      <View style={{ gap: 4 }}>
        <Text>Capacity</Text>
        <TextInput keyboardType="number-pad" placeholder="—" value={capacity} onChangeText={setCapacity}
          style={{ borderWidth: 1, borderRadius: 8, padding: 8, width: 100 }} />
      </View>
      {triRow("Has a PA system", hasPA, setHasPA)}
      {triRow("Has backline", hasBackline, setHasBackline)}
      <View style={{ gap: 4 }}>
        <Text>Indoor/outdoor</Text>
        <View style={{ flexDirection: "row", gap: 6 }}>
          {INDOOR_OUTDOOR_VALUES.map((v) => (
            <Chip key={v} label={v[0]!.toUpperCase() + v.slice(1)} active={indoorOutdoor === v}
              onPress={() => setIndoorOutdoor(indoorOutdoor === v ? null : v)} />
          ))}
        </View>
      </View>
      <TextInput multiline numberOfLines={3} maxLength={MAX_AMENITY_NOTES_LENGTH} value={notes} onChangeText={setNotes}
        placeholder="Other amenities (optional)"
        style={{ borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 70, textAlignVertical: "top" }} />
      <Pressable onPress={() => setAdvertisingInterest((v) => !v)}
        accessibilityRole="checkbox" accessibilityState={{ checked: advertisingInterest }}
        style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <View style={{ width: 20, height: 20, borderWidth: 1, borderColor: "#111", borderRadius: 4,
          backgroundColor: advertisingInterest ? "#111" : "#fff", alignItems: "center", justifyContent: "center" }}>
          {advertisingInterest && <Text style={{ color: "#fff", fontSize: 14 }}>✓</Text>}
        </View>
        <Text style={{ flex: 1 }}>Interested in advertising opportunities on GateKeep</Text>
      </Pressable>
      <Pressable onPress={() => void save()} disabled={busy} style={{ backgroundColor: "#111", padding: 12, borderRadius: 8 }}>
        <Text style={{ color: "#fff", textAlign: "center" }}>{busy ? "Saving…" : "Save amenities"}</Text>
      </Pressable>
    </View>
  );
}

// One gallery tile: fetches its own display URL (public/photos/... objects
// are publicly gettable per storage.rules — no auth needed) and owns its own
// remove action independently of its siblings — removeCuratorPhoto only ever
// affects the ONE path it's called with, so per-tile busy state (not a
// shared lock) is correct here, matching web's identical reasoning.
function GalleryPhoto({ path, profileId }: { path: string; profileId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getDownloadURL(storageRef(getFirebase().storage, path))
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; };
  }, [path]);
  const doRemove = async () => {
    setBusy(true);
    try {
      await httpsCallable(getFirebase().functions, "removeCuratorPhoto")({ profileId, path });
      // No local state update needed on success — the parent screen's
      // profile subscription delivers the shrunk photoPaths array, which
      // drops this path from the list and unmounts this tile (keyed by
      // path) on its own.
    } catch (e) {
      Alert.alert("Could not remove photo", e instanceof Error ? e.message : "Try again.");
      setBusy(false);
    }
  };
  const remove = () => {
    Alert.alert("Remove this photo?", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void doRemove() },
    ]);
  };
  return (
    <View style={{ gap: 4, width: 110 }}>
      {url
        ? <Image source={{ uri: url }} style={{ width: 110, height: 110, borderRadius: 8 }} />
        : <View style={{ width: 110, height: 110, borderRadius: 8, backgroundColor: "#eee" }} />}
      <Pressable onPress={remove} disabled={busy}>
        <Text style={{ color: "#dc2626" }}>{busy ? "Removing…" : "Remove"}</Text>
      </Pressable>
    </View>
  );
}

// Curator equivalent of PhotoUploader's avatar/cover slots, but for the
// append-only curator.photoPaths list (cap MAX_CURATOR_PHOTOS). Reuses
// PhotoUploader as-is (kind="gallery") — see PortfolioForms.tsx's comment
// for how a list is threaded through the single-slot `currentPath` prop via
// a length fingerprint instead of a real path.
export function GalleryPhotosSection({ profileId, uid, photoPaths }:
  { profileId: string; uid: string; photoPaths: string[] }) {
  const atCap = photoPaths.length >= MAX_CURATOR_PHOTOS;
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>Photos ({photoPaths.length}/{MAX_CURATOR_PHOTOS})</Text>
      {photoPaths.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {photoPaths.map((path) => <GalleryPhoto key={path} path={path} profileId={profileId} />)}
        </View>
      )}
      {atCap
        ? <Text style={{ color: "#92400e" }}>Gallery is full — remove a photo to add another.</Text>
        : <PhotoUploader profileId={profileId} uid={uid} kind="gallery" currentPath={String(photoPaths.length)} />}
      <Text style={{ color: "#666" }}>New photos appear here a few seconds after upload.</Text>
    </View>
  );
}
