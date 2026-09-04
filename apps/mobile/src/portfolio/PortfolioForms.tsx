import { useEffect, useState } from "react";
import { View, Pressable, Alert } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { ref as storageRef, uploadBytes } from "firebase/storage";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import {
  GENRES, GIG_TYPES, MAX_PHOTO_UPLOAD_BYTES, stagingPhotoPath, validatePortfolioUpdate, validateBookingUpdate,
  type PortfolioData, type BookingDoc, type BookingPreferences, type BookingRates, type BookingVisibility,
  type ExternalLink, type ExternalLinkKind, type RateAmount, type PhotoKind,
} from "@gatekeep/shared";
import { Text, Button, Input, TextArea, Chip } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// RN ports of the web portfolio forms: same callables, same validation,
// same field set. Expo Router's stack navigator reuses screen instances
// across param changes exactly like Next's App Router does: each of these
// components seeds its local state from `initial` ONLY ONCE, on mount
// (`useState(initial?.x ?? default)`). Whoever wires these into a screen
// (the wizard/dashboard tab) MUST re-key each instance by `profileId`
// (`key={profileId}`) when switching the active profile context, or a
// remount won't happen and the PREVIOUS profile's bio/links/rates will leak
// into the new one.
const callOrAlert = async (name: string, data: object): Promise<boolean> => {
  try { await callFn(name, data); return true; }
  catch (e) { Alert.alert("Save failed", e instanceof Error ? e.message : "Try again."); return false; }
};

export function BioGenresForm({ profileId, initial, onSaved }:
  { profileId: string; initial: PortfolioData | undefined; onSaved?: () => void }) {
  const [bio, setBio] = useState(initial?.bio ?? "");
  const [genres, setGenres] = useState<string[]>(initial?.genres ?? []);
  // Tracks what the SERVER currently holds, not just the mount-time value:
  // select 2 -> save -> deselect all -> save must hit the guard below even
  // though `initial` still says zero.
  const [savedGenres, setSavedGenres] = useState<string[]>(initial?.genres ?? []);
  // SP8: home city, mirroring web's own BioGenresForm. Tracks what the
  // SERVER currently holds (same reason as savedGenres above): the payload
  // only sends `city` when the trimmed value actually differs from it, and
  // it's the value the skip-if-unchanged check compares against, not the
  // mount-time `initial` alone.
  const [city, setCity] = useState(initial?.location?.city ?? "");
  const [savedCity, setSavedCity] = useState(initial?.location?.city ?? "");
  const [busy, setBusy] = useState(false);
  const toggle = (g: string) => setGenres((cur) =>
    cur.includes(g) ? cur.filter((x) => x !== g) : cur.length < 3 ? [...cur, g] : cur);

  const save = async () => {
    if (genres.length === 0 && savedGenres.length > 0) {
      // Genres were saved before and the musician has now deselected all of
      // them. The omit-when-empty branch below exists for the never-set-yet
      // case (a bio-only save while onboarding); reusing it here would
      // silently no-op: validatePortfolioUpdate rejects an explicit [], so
      // omitting the key just leaves the OLD genres in place server-side,
      // which looks to the musician like their change was saved (the chips
      // show empty) when it wasn't. Block it with an explicit message
      // instead.
      Alert.alert("Keep at least one genre", "It's required for review.");
      return;
    }
    // Omit genres entirely (rather than sending []) when none are picked
    // yet: a bio-only save has to work while a musician is still filling
    // in the rest of the form; validatePortfolioUpdate (and the server)
    // both treat an omitted field as "leave it alone", but an explicit []
    // fails the 1-3-genres check.
    const payload = genres.length > 0 ? { profileId, bio, genres } : { profileId, bio };
    // Same rule as web: `city` is sent only when it actually changed, `null`
    // clears it, and an unchanged field is omitted entirely so a bio/genres-
    // only save never touches the geocoded city.
    const trimmedCity = city.trim();
    if (trimmedCity !== savedCity) Object.assign(payload, { city: trimmedCity === "" ? null : trimmedCity });
    const v = validatePortfolioUpdate(payload);
    if (!v.ok) { Alert.alert("Check your info", v.reason); return; }
    setBusy(true);
    if (await callOrAlert("updatePortfolio", payload)) {
      if (genres.length > 0) setSavedGenres(genres);
      setSavedCity(trimmedCity);
      onSaved?.();
    }
    setBusy(false);
  };

  return (
    <View style={{ gap: 8 }}>
      <Text variant="title">Bio & genres</Text>
      <TextArea numberOfLines={5} maxLength={2000} value={bio} onChangeText={setBio}
        placeholder="Tell curators and fans who you are…"
        style={{ minHeight: 100 }} />
      <Text variant="label">Home city</Text>
      <Input value={city} onChangeText={setCity} placeholder="Where you're based" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {GENRES.map((g) => <Chip key={g} label={g} active={genres.includes(g)} onPress={() => toggle(g)} />)}
      </View>
      <Button onPress={() => void save()} disabled={busy} title={busy ? "Saving…" : "Save bio, city & genres"} />
    </View>
  );
}

export function LinksForm({ profileId, initial }:
  { profileId: string; initial: PortfolioData | undefined }) {
  const t = useTokens();
  const [links, setLinks] = useState<ExternalLink[]>(initial?.externalLinks ?? []);
  const [kind, setKind] = useState<ExternalLinkKind>("spotify");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (next: ExternalLink[]): Promise<boolean> => {
    const v = validatePortfolioUpdate({ profileId, externalLinks: next });
    if (!v.ok) { Alert.alert("Check the link", v.reason); return false; }
    setBusy(true);
    const ok = await callOrAlert("updatePortfolio", { profileId, externalLinks: next });
    if (ok) setLinks(next);
    setBusy(false);
    return ok;
  };

  return (
    <View style={{ gap: 8 }}>
      <Text variant="title">Links</Text>
      {links.map((l, i) => (
        <View key={`${l.kind}-${l.url}-${i}`} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Text style={{ flex: 1 }} numberOfLines={1}>{l.kind}: {l.url}</Text>
          <Pressable disabled={busy} onPress={() => void save(links.filter((_, j) => j !== i))}>
            <Text color={t.destructive}>Remove</Text>
          </Pressable>
        </View>
      ))}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {(["spotify", "youtube", "instagram", "website"] as const).map((k) =>
          <Chip key={k} label={k} active={kind === k} onPress={() => setKind(k)} />)}
      </View>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Input placeholder="https://…" autoCapitalize="none" editable={!busy} value={url} onChangeText={setUrl}
          style={{ flex: 1 }} />
        <Button variant="secondary" disabled={busy} title="Add"
          onPress={async () => {
            if (!url) return;
            // Clear the input only once the save actually succeeds:
            // clearing unconditionally would silently throw away what the
            // musician typed on a validation failure or a network error.
            if (await save([...links, { kind, url }])) setUrl("");
          }} />
      </View>
    </View>
  );
}

// Sub-project 3 widened `kind` to accept "gallery" (curator profiles): the
// upload/staging/awaiting-pipeline mechanics below are unchanged and work
// identically for it: a caller managing a LIST rather than a single slot
// (curator's photoPaths array) passes a `currentPath` that's really a
// fingerprint of the list (e.g. its length) instead of one path, so the same
// "baseline moved -> awaiting cleared" logic still detects completion, see
// src/curator/CuratorForms.tsx's GalleryPhotosSection. Mirrors web's Task 9
// widening of ../../web/src/portfolio/PortfolioForms.tsx's PhotoUploader.
export function PhotoUploader({ profileId, uid, kind, currentPath, disabled }:
  { profileId: string; uid: string; kind: PhotoKind; currentPath: string | null; disabled?: boolean }) {
  const tok = useTokens();
  const [busy, setBusy] = useState(false);
  // The pipeline rewrites the profile doc's avatar/coverPhotoPath a few
  // seconds after the storage upload lands: we don't know its eventual
  // value client-side, so instead we keep showing "Processing…" until the
  // `currentPath` PROP itself moves. `baseline` tracks the last path we've
  // actually seen; when it disagrees with the incoming prop we're mid-render
  // with fresh data, so we adjust state right here (not in a useEffect,
  // this is React's documented "adjust state while rendering" escape hatch
  // for resetting state when a prop changes: since it runs synchronously
  // before commit, React just re-renders once more with the corrected
  // state instead of committing a stale frame first). This also closes the
  // double-upload race: while awaiting, the button is disabled instead of
  // sitting idle and inviting a second upload before the first has landed.
  const [awaiting, setAwaiting] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [baseline, setBaseline] = useState(currentPath);
  if (currentPath !== baseline) {
    setBaseline(currentPath);
    if (awaiting) setAwaiting(false);
    if (timedOut) setTimedOut(false);
  }
  // Bounds the wait: some failures never write ANYTHING back to the profile
  // doc (an oversized/corrupt image the resize step rejects outright before
  // ever reaching a write, for instance), so `currentPath` would never move
  // and `awaiting` (and the disabled button) would otherwise deadlock
  // permanently. This is a legitimate useEffect (subscribing to an external
  // timer and calling setState from ITS callback, not synchronously in the
  // effect body), unlike the render-time adjustment above.
  useEffect(() => {
    if (!awaiting) return;
    const t = setTimeout(() => { setAwaiting(false); setTimedOut(true); }, 60_000);
    return () => clearTimeout(t);
  }, [awaiting]);

  const upload = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: "image/*", copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    if ((a.size ?? 0) > MAX_PHOTO_UPLOAD_BYTES) { Alert.alert("Too big", "Photos must be under 10 MB."); return; }
    setBusy(true);
    setTimedOut(false); // a fresh attempt supersedes any earlier timeout hint
    try {
      const { storage } = getFirebase();
      // RN has no crypto.randomUUID: timestamp+random nonce is fine (uniqueness, not secrecy of THIS value).
      const nonce = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      const blob = await (await fetch(a.uri)).blob();
      await uploadBytes(storageRef(storage, stagingPhotoPath(uid, profileId, kind, nonce)), blob,
        { contentType: a.mimeType ?? "image/jpeg" });
      setAwaiting(true);
      // The photo pipeline resizes/strips and updates the profile doc; the
      // parent screen's snapshot listener feeds the new path back in as
      // `currentPath`, which the render-time check above picks up and
      // flips `awaiting` back to false.
    } catch (e) {
      Alert.alert("Upload failed", e instanceof Error ? e.message : "Try again.");
    } finally {
      setBusy(false);
    }
  };
  const processing = awaiting;
  const photoLabel = kind === "avatar" ? "profile photo" : kind === "cover" ? "cover photo" : "photo";
  const label = busy ? "Uploading…" : processing ? "Processing…" : `Upload ${photoLabel}`;
  return (
    <View style={{ gap: 4 }}>
      <Pressable onPress={() => void upload()} disabled={busy || processing || disabled}
        accessibilityRole="button" accessibilityLabel={`Upload ${photoLabel}`}
        style={{ borderWidth: 1, borderColor: tok.border, borderRadius: 8, padding: 10, alignSelf: "flex-start", opacity: disabled ? 0.5 : 1 }}>
        {/* The checkmark reads as "this slot is filled", meaningful for
            avatar/cover's single-slot model, misleading for gallery (where
            currentPath is a length fingerprint, not a real path, and the
            gallery grid already renders its own thumbnails). */}
        <Text>{label}{currentPath && !processing && kind !== "gallery" ? " ✓" : ""}</Text>
      </Pressable>
      {timedOut && (
        <Text variant="meta" color={tok.warning}>
          Still processing, if your photo doesn&#39;t appear, try a smaller one.
        </Text>
      )}
    </View>
  );
}

type RateKey = "perHour" | "perSong" | "perSet";
type RateInput = { amount: string; note: string | null };
const rateInputFrom = (r: RateAmount | null | undefined): RateInput =>
  r ? { amount: (r.amountCents / 100).toString(), note: r.note ?? null } : { amount: "", note: null };

const DEFAULT_PREFS: BookingPreferences = {
  gigTypes: [], travelRadiusKm: null, actSize: null, typicalSetMinutes: null,
  bringsOwnPA: null, availabilityPattern: null,
};

// A two-state pill for the visibility controls below: the "default" (ember
// pill) Button variant when active, "secondary" (outlined) when not, forced
// to the pill radius, exactly the web Chip's Button-based construction.
function TogglePill({ label, active, onPress, disabled }: {
  label: string; active: boolean; onPress: () => void; disabled?: boolean;
}) {
  return (
    <Button
      title={label}
      variant={active ? "default" : "secondary"}
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ selected: active, disabled: Boolean(disabled) }}
      style={{ borderRadius: tokens.radius.pill, paddingHorizontal: 14 }}
    />
  );
}

export function BookingForm({ profileId, initial }:
  { profileId: string; initial: BookingDoc | null }) {
  // Raw strings, not derived cents: converting dollars -> cents -> back to a
  // display string on every keystroke (the naive approach) fights the user
  // mid-entry, e.g. typing "1.50" round-trips through 150 cents and
  // re-renders as "1.5", dropping the trailing zero and disrupting the
  // cursor. Conversion now happens exactly once, in save().
  const [rateInputs, setRateInputs] = useState<Record<RateKey, RateInput>>({
    perHour: rateInputFrom(initial?.rates.perHour),
    perSong: rateInputFrom(initial?.rates.perSong),
    perSet: rateInputFrom(initial?.rates.perSet),
  });
  const [prefs, setPrefs] = useState<BookingPreferences>(initial?.preferences ?? DEFAULT_PREFS);
  // Same seed rule as web (see that file's comment): a doc with no visibility
  // block is the backfill default, all curators.
  const [visibility, setVisibility] = useState<BookingVisibility>(initial?.visibility ?? {
    perHour: "curators", perSong: "curators", perSet: "curators", preferences: "curators",
  });
  const [busy, setBusy] = useState(false);

  const numField = (value: number | null, set: (n: number | null) => void, placeholder: string) => (
    <Input keyboardType="number-pad" placeholder={placeholder}
      value={value === null ? "" : String(value)}
      onChangeText={(t) => set(t === "" ? null : Math.round(Number(t)))}
      style={{ width: 100 }} />
  );
  const rateRow = (key: RateKey, label: string) => {
    const blank = rateInputs[key].amount.trim() === "";
    return (
      <View key={key} style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <Text style={{ width: 100 }}>{label}</Text>
          <Text>$</Text>
          <Input keyboardType="decimal-pad" placeholder="-"
            value={rateInputs[key].amount}
            onChangeText={(t) => setRateInputs((r) => ({ ...r, [key]: { ...r[key], amount: t } }))}
            style={{ width: 90 }} />
          <Input placeholder="note (optional)" maxLength={200} editable={!blank}
            value={rateInputs[key].note ?? ""}
            onChangeText={(t) => setRateInputs((r) => ({ ...r, [key]: { ...r[key], note: t || null } }))}
            style={{ flex: 1 }} />
        </View>
        <View style={{ flexDirection: "row", gap: 6, marginLeft: 108 }}>
          <TogglePill label="Visible to curators" active={visibility[key] === "curators"} disabled={blank}
            onPress={() => setVisibility((v) => ({ ...v, [key]: "curators" }))} />
          <TogglePill label="Private" active={visibility[key] === "private"} disabled={blank}
            onPress={() => setVisibility((v) => ({ ...v, [key]: "private" }))} />
        </View>
      </View>
    );
  };
  const save = async () => {
    const rates: BookingRates = { perHour: null, perSong: null, perSet: null };
    for (const key of ["perHour", "perSong", "perSet"] as const) {
      const raw = rateInputs[key].amount.trim();
      if (raw === "") continue; // stays null: field left blank on purpose
      const dollars = Number(raw);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        Alert.alert("Check your rates", "Rates must be more than $0, or leave the field blank.");
        return;
      }
      rates[key] = { amountCents: Math.round(dollars * 100), note: rateInputs[key].note || null };
    }
    const input = { profileId, rates, preferences: prefs, visibility };
    const v = validateBookingUpdate(input);
    if (!v.ok) { Alert.alert("Check your info", v.reason); return; }
    setBusy(true);
    await callOrAlert("updateBookingInfo", input);
    setBusy(false);
  };

  return (
    <View style={{ gap: 10 }}>
      <Text variant="title">Rates & preferences</Text>
      <Text muted>
        Rates never appear on your public page: each one is visible to curators or private.
        Preferences can be public or curators only. Offer any mix of the three.
      </Text>
      {rateRow("perHour", "Per hour")}
      {rateRow("perSong", "Per song")}
      {rateRow("perSet", "Per set (flat)")}
      <Text variant="label">Gig types</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {GIG_TYPES.map((g) => <Chip key={g} label={g.replace("_", " ")} active={prefs.gigTypes.includes(g)}
          onPress={() => setPrefs((p) => ({ ...p, gigTypes: p.gigTypes.includes(g)
            ? p.gigTypes.filter((x) => x !== g) : [...p.gigTypes, g] }))} />)}
      </View>
      <Text variant="label">Who sees your preferences</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <TogglePill label="Public" active={visibility.preferences === "public"}
          onPress={() => setVisibility((v) => ({ ...v, preferences: "public" }))} />
        <TogglePill label="Curators only" active={visibility.preferences === "curators"}
          onPress={() => setVisibility((v) => ({ ...v, preferences: "curators" }))} />
      </View>
      <Text variant="meta" muted>
        Public puts gig types, act size, and availability on your public page. Curators only keeps them inside Find musicians.
      </Text>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Text>Travel radius (km)</Text>
        {numField(prefs.travelRadiusKm, (n) => setPrefs((p) => ({ ...p, travelRadiusKm: n })), "-")}
      </View>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Text>Typical set (min)</Text>
        {numField(prefs.typicalSetMinutes, (n) => setPrefs((p) => ({ ...p, typicalSetMinutes: n })), "-")}
      </View>
      <Text variant="label">Act size</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {(["solo", "duo", "band"] as const).map((s) => <Chip key={s} label={s} active={prefs.actSize === s}
          onPress={() => setPrefs((p) => ({ ...p, actSize: p.actSize === s ? null : s }))} />)}
      </View>
      <Text variant="label">Bring own PA</Text>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Chip label="Yes" active={prefs.bringsOwnPA === true}
          onPress={() => setPrefs((p) => ({ ...p, bringsOwnPA: p.bringsOwnPA === true ? null : true }))} />
        <Chip label="No" active={prefs.bringsOwnPA === false}
          onPress={() => setPrefs((p) => ({ ...p, bringsOwnPA: p.bringsOwnPA === false ? null : false }))} />
      </View>
      <Text variant="label">Availability</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {(["weekends", "weeknights", "anytime", "limited"] as const).map((a) =>
          <Chip key={a} label={a} active={prefs.availabilityPattern === a}
            onPress={() => setPrefs((p) => ({ ...p, availabilityPattern: p.availabilityPattern === a ? null : a }))} />)}
      </View>
      <Button onPress={() => void save()} disabled={busy} title={busy ? "Saving…" : "Save rates & preferences"} />
    </View>
  );
}
