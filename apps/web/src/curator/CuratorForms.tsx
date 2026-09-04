"use client";
import { useEffect, useState } from "react";
import { ref as storageRef, getDownloadURL } from "firebase/storage";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { Chip, formatChipLabel, PhotoUploader } from "../portfolio/PortfolioForms";
import {
  GENRES, ACT_SIZES, MAX_CURATOR_PHOTOS, validateLookingFor,
  MAX_ABOUT_LENGTH, MAX_ADDRESS_LENGTH, MAX_CITY_LENGTH, MAX_AMENITY_NOTES_LENGTH, MAX_CAPACITY,
  type LookingFor, type ActSize, type CuratorDetails, type CuratorSubtype,
} from "@gatekeep/shared";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import { IconTrash } from "../ui/icons";

// Sub-project 3's curator equivalent of ../portfolio/PortfolioForms.tsx:
// same shapes (busy-locked save, alert-on-failure, seed-once-from-`initial`
// local state) applied to CuratorDetails' fields instead of PortfolioData's.
// Kept in its own file (mirrors functions/src/curator.ts being split from
// portfolio.ts server-side) rather than folded into PortfolioForms.tsx,
// which is SP2-owned and shared verbatim (only PhotoUploader's `kind` type
// was widened there, plus the Chip/formatChipLabel restyle helpers this
// file now reuses too, see their comments).

const callOrAlert = async (name: string, data: object): Promise<boolean> => {
  try { await callFn(name, data); return true; }
  catch (e) { window.alert(e instanceof Error ? e.message : "Save failed. Try again."); return false; }
};

export function AboutForm({ profileId, initial }: { profileId: string; initial: string | undefined }) {
  const [about, setAbout] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    await callOrAlert("updateCuratorProfile", { profileId, about });
    setBusy(false);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>About</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Textarea
          rows={6}
          maxLength={MAX_ABOUT_LENGTH}
          value={about}
          placeholder="Tell musicians what makes this a good gig: the room, the crowd, what you're building…"
          onChange={(e) => setAbout(e.target.value)}
        />
        <Button type="button" onClick={save} disabled={busy} className="justify-self-start">
          {busy ? "Saving…" : "Save about"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function LocationForm({ profileId, subtype, initial }:
  { profileId: string; subtype: CuratorSubtype; initial: CuratorDetails["location"] | undefined }) {
  const isVenue = subtype === "venue";
  const [address, setAddress] = useState(initial?.address ?? "");
  const [city, setCity] = useState(initial?.city ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const trimmedCity = city.trim();
    if (trimmedCity.length < 1 || trimmedCity.length > MAX_CITY_LENGTH) {
      window.alert(`City is required (1-${MAX_CITY_LENGTH} characters).`);
      return;
    }
    if (isVenue && address.trim().length > MAX_ADDRESS_LENGTH) {
      window.alert(`Address must be at most ${MAX_ADDRESS_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    // Planners/hosts must NOT send an address: updateCuratorProfile rejects
    // a non-empty one from a non-venue with "Only venues can set a street
    // address." This form never renders the address input for them, so
    // there's nothing typed to accidentally send, but the payload is built
    // explicitly (not just "whatever's in the address input") as a second
    // line of defense against that server error.
    await callOrAlert("updateCuratorProfile",
      { profileId, location: { city: trimmedCity, address: isVenue ? (address.trim() || null) : null } });
    setBusy(false);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Location</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {isVenue ? (
          <div className="grid gap-1.5">
            <p className="font-sora text-sm text-gk-muted">Venues show a full street address publicly.</p>
            <Input
              placeholder="Street address"
              maxLength={MAX_ADDRESS_LENGTH}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
        ) : (
          <p className="font-sora text-sm text-gk-muted">Only your city is shown publicly, never a precise address.</p>
        )}
        <div className="grid gap-1.5">
          <label htmlFor="curator-city" className="font-sora text-sm font-medium text-gk-text">City</label>
          <Input id="curator-city" placeholder="City" maxLength={MAX_CITY_LENGTH} value={city}
            onChange={(e) => setCity(e.target.value)} />
        </div>
        {/* Reflects the SERVER's resolved value (post-geocode, which can
            normalize what was typed, e.g. "nyc" -> "New York") rather than
            local state, so it stays live across saves without fighting this
            form's seed-once-on-mount convention (see PortfolioEditor's
            identical BioGenresForm/LinksForm comment for why that convention
            exists). */}
        <p className="font-sora text-xs text-gk-muted">
          Currently saved: {initial?.city || "none yet"}{initial?.neighborhood ? ` (${initial.neighborhood})` : ""}
        </p>
        <Button type="button" onClick={save} disabled={busy} className="justify-self-start">
          {busy ? "Saving…" : "Save location"}
        </Button>
      </CardContent>
    </Card>
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
    // The one shared validator this task's brief calls out by name: same
    // rule the server enforces (>=1 genre, >=1 act size, notes <=500 chars),
    // run here first so a curator gets the exact server-worded reason
    // (e.g. "Pick at least one genre.") without a round-trip.
    const v = validateLookingFor(input);
    if (!v.ok) { window.alert(v.reason); return; }
    setBusy(true);
    await callOrAlert("updateCuratorProfile", { profileId, lookingFor: input });
    setBusy(false);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>What you&apos;re looking for</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <span className="font-sora text-sm font-medium text-gk-text">Genres</span>
          <div className="flex flex-wrap gap-2">
            {GENRES.map((g) => (
              <Chip key={g} active={genres.includes(g)} onClick={() => toggleGenre(g)}>
                {formatChipLabel(g)}
              </Chip>
            ))}
          </div>
        </div>
        <div className="grid gap-2">
          <span className="font-sora text-sm font-medium text-gk-text">Act sizes</span>
          <div className="flex flex-wrap gap-2">
            {ACT_SIZES.map((a) => (
              <Chip key={a} active={actSizes.includes(a)} onClick={() => toggleActSize(a)}>
                {formatChipLabel(a)}
              </Chip>
            ))}
          </div>
        </div>
        <Textarea
          rows={3}
          maxLength={500}
          value={notes}
          placeholder="Anything else musicians should know (optional)"
          onChange={(e) => setNotes(e.target.value)}
        />
        <Button type="button" onClick={save} disabled={busy} className="justify-self-start">
          {busy ? "Saving…" : "Save preferences"}
        </Button>
      </CardContent>
    </Card>
  );
}

// Mirrors functions/src/curator.ts's INDOOR_OUTDOOR_VALUES: an enum, not a
// soft-cap constant, so it stays a local UX mirror; the server remains
// authoritative. MAX_CAPACITY / MAX_AMENITY_NOTES_LENGTH come from shared
// (see import above).
const INDOOR_OUTDOOR_VALUES = ["indoor", "outdoor", "both"] as const;
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
        window.alert(`Capacity must be a whole number from 0 to ${MAX_CAPACITY}.`);
        return;
      }
      capacityNum = n;
    }
    if (notes.length > MAX_AMENITY_NOTES_LENGTH) {
      window.alert(`Amenity notes must be at most ${MAX_AMENITY_NOTES_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    // Both fields land in one updateCuratorProfile call: the brief groups
    // "amenities + advertising toggle" as a single section/save, and the
    // callable already accepts them as independent partial-update keys.
    await callOrAlert("updateCuratorProfile", {
      profileId,
      amenities: { capacity: capacityNum, hasPA, hasBackline, indoorOutdoor, notes: notes.trim() || null },
      advertisingInterest,
    });
    setBusy(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Amenities</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <label className="grid max-w-40 gap-1.5">
          <span className="font-sora text-sm font-medium text-gk-text">Capacity</span>
          <Input type="number" min={0} max={MAX_CAPACITY} step={1} value={capacity}
            onChange={(e) => setCapacity(e.target.value)} />
        </label>
        <div className="grid gap-2">
          <span className="font-sora text-sm font-medium text-gk-text">Has a PA system</span>
          <div className="flex gap-2">
            {/* Reclicking the active chip clears it back to "not set", the
                same null the old blank select option produced. */}
            <Chip active={hasPA === true} onClick={() => setHasPA((cur) => (cur === true ? null : true))}>Yes</Chip>
            <Chip active={hasPA === false} onClick={() => setHasPA((cur) => (cur === false ? null : false))}>No</Chip>
          </div>
        </div>
        <div className="grid gap-2">
          <span className="font-sora text-sm font-medium text-gk-text">Has backline</span>
          <div className="flex gap-2">
            <Chip active={hasBackline === true} onClick={() => setHasBackline((cur) => (cur === true ? null : true))}>
              Yes
            </Chip>
            <Chip active={hasBackline === false} onClick={() => setHasBackline((cur) => (cur === false ? null : false))}>
              No
            </Chip>
          </div>
        </div>
        <div className="grid gap-2">
          <span className="font-sora text-sm font-medium text-gk-text">Indoor / outdoor</span>
          <div className="flex flex-wrap gap-2">
            {INDOOR_OUTDOOR_VALUES.map((v) => (
              <Chip key={v} active={indoorOutdoor === v} onClick={() => setIndoorOutdoor((cur) => (cur === v ? null : v))}>
                {formatChipLabel(v)}
              </Chip>
            ))}
          </div>
        </div>
        <Textarea
          rows={3}
          maxLength={MAX_AMENITY_NOTES_LENGTH}
          value={notes}
          placeholder="Other amenities (optional)"
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="flex items-center gap-3">
          <Switch id="curator-advertising" checked={advertisingInterest} onCheckedChange={setAdvertisingInterest} />
          <label htmlFor="curator-advertising" className="font-sora text-sm text-gk-text">
            Interested in advertising opportunities on GateKeep
          </label>
        </div>
        <Button type="button" onClick={save} disabled={busy} className="justify-self-start">
          {busy ? "Saving…" : "Save amenities"}
        </Button>
      </CardContent>
    </Card>
  );
}

// One gallery tile: fetches its own display URL (public/photos/... objects
// are publicly gettable per storage.rules, no auth needed) and owns its own
// remove action independently of its siblings. Unlike TrackManager's shared
// busy lock (justified there because reorderTracks touches TWO rows at
// once), removeCuratorPhoto only ever affects the ONE path it's called
// with, so per-tile busy state is both simpler and doesn't over-lock unrelated
// rows.
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
  const remove = async () => {
    if (!window.confirm("Remove this photo?")) return;
    setBusy(true);
    try {
      await callFn("removeCuratorPhoto", { profileId, path });
      // No local state update needed on success: the parent editor's
      // profile subscription delivers the shrunk photoPaths array, which
      // drops this path from the list and unmounts this tile (keyed by
      // path) on its own.
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Could not remove photo.");
      setBusy(false);
    }
  };
  return (
    <div className="grid w-28 gap-1.5">
      {url
        ? <img src={url} alt="" className="size-28 rounded-gk object-cover" />
        : <div className="size-28 rounded-gk bg-gk-border" aria-hidden="true" />}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        className="justify-start px-2 text-gk-destructive hover:bg-gk-destructive/14"
        onClick={remove}
      >
        <IconTrash size={14} aria-hidden="true" />
        {busy ? "Removing…" : "Remove"}
      </Button>
    </div>
  );
}

// Curator equivalent of PhotoUploader's avatar/cover slots, but for the
// append-only curator.photoPaths list (cap MAX_CURATOR_PHOTOS). Reuses
// PhotoUploader as-is (kind="gallery"), see its comment in PortfolioForms.tsx
// for how a list is threaded through the single-slot `currentPath` prop via
// a length fingerprint instead of a real path.
export function GalleryPhotosSection({ profileId, uid, photoPaths }:
  { profileId: string; uid: string; photoPaths: string[] }) {
  const atCap = photoPaths.length >= MAX_CURATOR_PHOTOS;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Photos ({photoPaths.length}/{MAX_CURATOR_PHOTOS})</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {photoPaths.length > 0 && (
          <div className="flex flex-wrap gap-4">
            {photoPaths.map((path) => <GalleryPhoto key={path} path={path} profileId={profileId} />)}
          </div>
        )}
        {atCap
          ? <p className="font-sora text-sm text-gk-warning">Gallery is full. Remove a photo to add another.</p>
          : <PhotoUploader profileId={profileId} uid={uid} kind="gallery" currentPath={String(photoPaths.length)} />}
        <p className="font-sora text-sm text-gk-muted">New photos appear here a few seconds after upload.</p>
      </CardContent>
    </Card>
  );
}
