"use client";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadBytes } from "firebase/storage";
import { getFirebase } from "../lib/firebase";
import { cn } from "../lib/utils";
import {
  GENRES, GIG_TYPES, MAX_PHOTO_UPLOAD_BYTES, stagingPhotoPath, validatePortfolioUpdate, validateBookingUpdate,
  type PortfolioData, type BookingDoc, type BookingVisibility,
  type ExternalLink, type ExternalLinkKind, type RateAmount, type PhotoKind,
} from "@gatekeep/shared";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { IconCheck, IconLink, IconPlus, IconTrash, IconUpload } from "../ui/icons";
// Task 9 review fix: moved to a plain (non-"use client") module so a Server
// Component (app/u/[handle]/MusicianProfile.tsx) can call it directly
// without hitting the client-reference stub a Server Component gets when it
// imports a plain value from a "use client" file. Imported (for this file's
// own use below) AND re-exported (a plain `export {x} from "mod"` re-export
// does NOT create a local binding, so both are needed) so every existing
// "use client" importer of this name (GigCard.tsx, MusicianCard.tsx,
// MusicianBrowse.tsx) keeps working unchanged.
import { formatChipLabel } from "../../app/u/[handle]/chipLabel";
export { formatChipLabel };

const callOrAlert = async (name: string, data: object): Promise<boolean> => {
  try { await httpsCallable(getFirebase().functions, name)(data); return true; }
  catch (e) { window.alert(e instanceof Error ? e.message : "Save failed. Try again."); return false; }
};

// Restyle-only chip button (Task 5 join-wizard precedent: secondary variant
// at rest, ember "default" variant when active, forced to the pill radius
// since DESIGN.md only gives Button's "default" variant the 999px pill by
// default and a chip is the radius table's other named pill use).
export function Chip({ active, onClick, disabled, children }:
  { active: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "secondary"}
      size="sm"
      disabled={disabled}
      className="rounded-full"
      onClick={onClick}
      aria-pressed={active}
    >
      {children}
    </Button>
  );
}

export function BioGenresForm({ profileId, initial, onSaved }:
  { profileId: string; initial: PortfolioData | undefined; onSaved?: () => void }) {
  const [bio, setBio] = useState(initial?.bio ?? "");
  const [genres, setGenres] = useState<string[]>(initial?.genres ?? []);
  // Tracks what the SERVER currently holds, not just the mount-time value:
  // select 2, save, deselect all, save must hit the guard below even
  // though `initial` still says zero.
  const [savedGenres, setSavedGenres] = useState<string[]>(initial?.genres ?? []);
  const [busy, setBusy] = useState(false);
  const toggleGenre = (g: string) => setGenres((cur) =>
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
      window.alert("Keep at least one genre. It's required for review.");
      return;
    }
    // Omit genres entirely (rather than sending []) when none are picked
    // yet: a bio-only save has to work while a musician is still filling
    // in the rest of the form. validatePortfolioUpdate (and the server)
    // both treat an omitted field as "leave it alone", but an explicit []
    // fails the 1-3-genres check.
    const payload = genres.length > 0 ? { profileId, bio, genres } : { profileId, bio };
    const v = validatePortfolioUpdate(payload);
    if (!v.ok) { window.alert(v.reason); return; }
    setBusy(true);
    if (await callOrAlert("updatePortfolio", payload)) {
      if (genres.length > 0) setSavedGenres(genres);
      onSaved?.();
    }
    setBusy(false);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bio &amp; genres</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Textarea
          rows={6}
          maxLength={2000}
          value={bio}
          placeholder="Tell curators and fans who you are…"
          onChange={(e) => setBio(e.target.value)}
        />
        <div className="grid gap-2">
          <span className="font-sora text-sm font-medium text-gk-text">Genres (up to 3)</span>
          <div className="flex flex-wrap gap-2">
            {GENRES.map((g) => (
              <Chip key={g} active={genres.includes(g)} onClick={() => toggleGenre(g)}>
                {formatChipLabel(g)}
              </Chip>
            ))}
          </div>
        </div>
        <Button type="button" onClick={save} disabled={busy} className="justify-self-start">
          {busy ? "Saving…" : "Save bio & genres"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function LinksForm({ profileId, initial }:
  { profileId: string; initial: PortfolioData | undefined }) {
  const [links, setLinks] = useState<ExternalLink[]>(initial?.externalLinks ?? []);
  const [kind, setKind] = useState<ExternalLinkKind>("spotify");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (next: ExternalLink[]): Promise<boolean> => {
    const v = validatePortfolioUpdate({ profileId, externalLinks: next });
    if (!v.ok) { window.alert(v.reason); return false; }
    setBusy(true);
    const ok = await callOrAlert("updatePortfolio", { profileId, externalLinks: next });
    if (ok) setLinks(next);
    setBusy(false);
    return ok;
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Links</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {links.length > 0 && (
          <ul className="grid gap-2">
            {links.map((l, i) => (
              <li
                key={`${l.kind}-${l.url}-${i}`}
                className="flex items-center gap-2 rounded-gk-sm border border-gk-border px-3 py-2"
              >
                <IconLink size={16} className="shrink-0 text-gk-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-sora text-sm text-gk-text">
                  <span className="font-medium capitalize">{l.kind}</span>
                  <span className="text-gk-muted"> &middot; </span>
                  {l.url}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  aria-label={`Remove ${l.kind} link`}
                  onClick={() => void save(links.filter((_, j) => j !== i))}
                >
                  <IconTrash size={16} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Select value={kind} disabled={busy} onValueChange={(v) => setKind(v as ExternalLinkKind)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="spotify">Spotify</SelectItem>
              <SelectItem value="youtube">YouTube</SelectItem>
              <SelectItem value="instagram">Instagram</SelectItem>
              <SelectItem value="website">Website</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="https://…"
            value={url}
            disabled={busy}
            onChange={(e) => setUrl(e.target.value)}
            className="min-w-[200px] flex-1"
          />
          <Button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!url) return;
              // Clear the input only once the save actually succeeds:
              // clearing unconditionally (as before this component existed)
              // silently threw away what the musician typed on a validation
              // failure or a network error.
              if (await save([...links, { kind, url }])) setUrl("");
            }}
          >
            <IconPlus size={16} aria-hidden="true" />
            Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Off-screen but still in the layout/tab order (unlike display:none, which
// pulls the element out of tab order entirely): the visible label text
// stays clickable via <label>/<input> association, but keyboard users can
// still Tab to and activate the file input directly.
const VISUALLY_HIDDEN_INPUT: CSSProperties = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
  overflow: "hidden", whiteSpace: "nowrap", border: 0, opacity: 0,
};

// Sub-project 3 widened `kind` to accept "gallery" (curator profiles): the
// upload/staging/awaiting-pipeline mechanics below are unchanged and work
// identically for it. A caller managing a LIST rather than a single slot
// (curator's photoPaths array) passes a `currentPath` that's really a
// fingerprint of the list (e.g. its length) instead of one path, so the
// exact same "baseline moved, awaiting cleared" logic still detects
// completion, see CuratorForms.tsx's GalleryPhotosSection.
export function PhotoUploader({ profileId, uid, kind, currentPath, disabled }:
  { profileId: string; uid: string; kind: PhotoKind; currentPath: string | null; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  // The pipeline rewrites the profile doc's avatar/coverPhotoPath a few
  // seconds after the storage upload lands. We don't know its eventual
  // value client-side, so instead we keep showing "Processing..." until the
  // `currentPath` PROP itself moves. `baseline` tracks the last path we've
  // actually seen; when it disagrees with the incoming prop we're mid-render
  // with fresh data, so we adjust state right here (not in a useEffect:
  // this is React's documented "adjust state while rendering" escape hatch
  // for resetting state when a prop changes: since it runs synchronously
  // before commit, React just re-renders once more with the corrected
  // state instead of committing a stale frame first). This also closes the
  // double-upload race: while awaiting, the input is disabled instead of
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
  // and `awaiting`, and the disabled input, would otherwise deadlock
  // permanently. This is a legitimate useEffect (subscribing to an external
  // timer and calling setState from ITS callback, not synchronously in the
  // effect body), unlike the render-time adjustment above.
  useEffect(() => {
    if (!awaiting) return;
    const t = setTimeout(() => { setAwaiting(false); setTimedOut(true); }, 60_000);
    return () => clearTimeout(t);
  }, [awaiting]);

  const upload = async (f: File) => {
    if (f.size > MAX_PHOTO_UPLOAD_BYTES) { window.alert("Photos must be under 10 MB."); return; }
    setBusy(true);
    setTimedOut(false); // a fresh attempt supersedes any earlier timeout hint
    try {
      const { storage } = getFirebase();
      const path = stagingPhotoPath(uid, profileId, kind, crypto.randomUUID());
      await uploadBytes(storageRef(storage, path), f, { contentType: f.type });
      setAwaiting(true);
      // The photo pipeline resizes/strips and updates the profile doc; the
      // parent page's snapshot listener feeds the new path back in as
      // `currentPath`, which the render-time check above picks up and
      // flips `awaiting` back to false.
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Upload failed.");
    } finally { setBusy(false); }
  };
  const processing = awaiting;
  const label = kind === "avatar" ? "profile photo" : kind === "cover" ? "cover photo" : "photo";
  const locked = busy || processing || disabled;
  return (
    <div className="grid gap-1.5">
      <label
        className={cn(
          "group relative flex size-28 flex-col items-center justify-center gap-1.5 rounded-gk border border-dashed border-gk-border bg-gk-surface px-2 text-center transition-colors",
          locked ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:border-gk-focus",
        )}
      >
        <IconUpload size={20} className="text-gk-muted" aria-hidden="true" />
        <span className="font-sora text-xs font-medium leading-tight text-gk-text">
          {busy ? "Uploading…" : processing ? "Processing…" : `Upload ${label}`}
        </span>
        {/* The checkmark reads as "this slot is filled": meaningful for
            avatar/cover's single-slot model, misleading for gallery (where
            currentPath is a length fingerprint, not a real path, and the
            list already renders its own thumbnails). */}
        {currentPath && !processing && kind !== "gallery" && (
          <span className="absolute right-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-gk-success/14 text-gk-success">
            <IconCheck size={11} aria-hidden="true" />
          </span>
        )}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={VISUALLY_HIDDEN_INPUT}
          disabled={locked}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ""; // allows re-picking the same file (e.g. after a failed upload)
            if (f) void upload(f);
          }}
        />
      </label>
      {timedOut && (
        <span className="w-28 font-sora text-xs text-gk-warning">
          Still processing. If your photo doesn&apos;t appear, try a smaller one.
        </span>
      )}
    </div>
  );
}

type RateKey = "perHour" | "perSong" | "perSet";
type RateInput = { amount: string; note: string | null };
const rateInputFrom = (r: RateAmount | null | undefined): RateInput =>
  r ? { amount: (r.amountCents / 100).toString(), note: r.note ?? null } : { amount: "", note: null };

// Radix's Select requires every item's value to be a non-empty string, so
// each "no selection yet" field below is threaded through this sentinel
// rather than "", mapped back to `null` (the field's real empty value) on
// the way out, so the state this form saves is unaffected.
const UNSET = "unset";

export function BookingForm({ profileId, initial }:
  { profileId: string; initial: BookingDoc | null }) {
  // Raw strings, not derived cents: converting dollars -> cents -> back to a
  // display string on every keystroke (the old approach) fights the user
  // mid-entry, e.g. typing "1.50" round-trips through 150 cents and
  // re-renders as "1.5", dropping the trailing zero and disrupting the
  // cursor. Conversion now happens exactly once, in save().
  const [rateInputs, setRateInputs] = useState<Record<RateKey, RateInput>>({
    perHour: rateInputFrom(initial?.rates.perHour),
    perSong: rateInputFrom(initial?.rates.perSong),
    perSet: rateInputFrom(initial?.rates.perSet),
  });
  const [prefs, setPrefs] = useState(initial?.preferences ??
    { gigTypes: [], travelRadiusKm: null, actSize: null, typicalSetMinutes: null,
      bringsOwnPA: null, availabilityPattern: null });
  // Seeded once from the stored doc. A doc with no visibility block is a
  // pre-SP4 doc the backfill has not converged yet; BookingDoc.visibility's
  // own comment defines that case as "every rate curators, preferences
  // curators", which is the literal below. Rates can never be public (spec
  // decision 4: RateVisibility has no "public" member), so each rate gets a
  // curators/private switch and only preferences gets a public option.
  const [visibility, setVisibility] = useState<BookingVisibility>(initial?.visibility ?? {
    perHour: "curators", perSong: "curators", perSet: "curators", preferences: "curators",
  });
  const [busy, setBusy] = useState(false);

  const rateField = (key: RateKey, label: string) => {
    const blank = rateInputs[key].amount.trim() === "";
    const visibleToCurators = visibility[key] === "curators";
    return (
      <div key={key} className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-28 shrink-0 font-sora text-sm font-medium text-gk-text">{label}</span>
          <div className="flex items-center gap-1.5">
            <span className="font-sora text-sm text-gk-muted">$</span>
            <Input
              type="number"
              min={0}
              step="0.01"
              className="w-24"
              value={rateInputs[key].amount}
              onChange={(e) => setRateInputs((r) => ({ ...r, [key]: { ...r[key], amount: e.target.value } }))}
            />
          </div>
          <Input
            placeholder="Note (optional)"
            maxLength={200}
            className="min-w-[160px] flex-1"
            value={rateInputs[key].note ?? ""}
            disabled={blank}
            onChange={(e) => setRateInputs((r) => ({ ...r, [key]: { ...r[key], note: e.target.value || null } }))}
          />
        </div>
        {/* min-h-11 (44px) on the label, not on the 24px switch: the label is
            the click target (label/button association), so the target meets
            the accessibility floor without inflating the control's drawing.
            Disabled while the rate is blank: an unset rate has nothing to
            show or hide. ml-31 = the w-28 label plus the gap-3 (7.75rem), so
            the switch sits under the dollar input, not under the row label. */}
        <label className="ml-31 flex min-h-11 w-fit cursor-pointer items-center gap-2 font-sora text-xs text-gk-muted">
          <Switch
            checked={visibleToCurators}
            disabled={blank}
            aria-label={`${label} rate visibility`}
            onCheckedChange={(on) => setVisibility((v) => ({ ...v, [key]: on ? "curators" : "private" }))}
          />
          {visibleToCurators ? "Visible to curators" : "Private"}
        </label>
      </div>
    );
  };

  const save = async () => {
    const rates: { perHour: RateAmount | null; perSong: RateAmount | null; perSet: RateAmount | null } =
      { perHour: null, perSong: null, perSet: null };
    for (const key of ["perHour", "perSong", "perSet"] as const) {
      const raw = rateInputs[key].amount.trim();
      if (raw === "") continue; // stays null: field left blank on purpose
      const dollars = Number(raw);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        window.alert("Rates must be more than $0, or leave the field blank.");
        return;
      }
      rates[key] = { amountCents: Math.round(dollars * 100), note: rateInputs[key].note || null };
    }
    const input = { profileId, rates, preferences: prefs, visibility };
    const v = validateBookingUpdate(input);
    if (!v.ok) { window.alert(v.reason); return; }
    setBusy(true);
    await callOrAlert("updateBookingInfo", input);
    setBusy(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rates &amp; preferences</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <p className="font-sora text-sm text-gk-muted">
          Rates never appear on your public page: each one is visible to curators or private.
          Preferences can be public or curators only. Offer any mix of the three.
        </p>
        <div className="grid gap-3">
          {rateField("perHour", "Per hour")}
          {rateField("perSong", "Per song")}
          {rateField("perSet", "Per set (flat)")}
        </div>

        <div className="grid gap-2">
          <span className="font-sora text-sm font-medium text-gk-text">Gig preferences</span>
          <div className="flex flex-wrap gap-2">
            {GIG_TYPES.map((g) => (
              <Chip
                key={g}
                active={prefs.gigTypes.includes(g)}
                onClick={() => setPrefs((p) => ({ ...p, gigTypes: p.gigTypes.includes(g)
                  ? p.gigTypes.filter((x) => x !== g) : [...p.gigTypes, g] }))}
              >
                {formatChipLabel(g)}
              </Chip>
            ))}
          </div>
        </div>

        <div className="grid gap-2">
          <span className="font-sora text-sm font-medium text-gk-text">Who sees your preferences</span>
          <div className="flex flex-wrap gap-2">
            <Chip active={visibility.preferences === "public"}
              onClick={() => setVisibility((v) => ({ ...v, preferences: "public" }))}>
              Public
            </Chip>
            <Chip active={visibility.preferences === "curators"}
              onClick={() => setVisibility((v) => ({ ...v, preferences: "curators" }))}>
              Curators only
            </Chip>
          </div>
          <span className="font-sora text-xs text-gk-muted">
            Public puts gig types, act size, and availability on your public page. Curators only keeps them inside Find musicians.
          </span>
        </div>

        <div className="grid gap-2">
          <span className="font-sora text-sm font-medium text-gk-text">Act size</span>
          <div className="flex flex-wrap gap-2">
            {(["solo", "duo", "band"] as const).map((s) => (
              <Chip
                key={s}
                active={prefs.actSize === s}
                // Reclicking the active chip clears it back to "not set",
                // the same null the old blank select option produced.
                onClick={() => setPrefs((p) => ({ ...p, actSize: p.actSize === s ? null : s }))}
              >
                {formatChipLabel(s)}
              </Chip>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5">
            <span className="font-sora text-sm font-medium text-gk-text">Travel radius (km)</span>
            <Input
              type="number"
              min={0}
              max={3000}
              step={1}
              value={prefs.travelRadiusKm ?? ""}
              onChange={(e) => setPrefs((p) => ({ ...p,
                travelRadiusKm: e.target.value === "" ? null : Math.round(Number(e.target.value)) }))}
            />
            <span className="font-sora text-xs text-gk-muted">Whole numbers only</span>
          </label>
          <label className="grid gap-1.5">
            <span className="font-sora text-sm font-medium text-gk-text">Typical set (minutes)</span>
            <Input
              type="number"
              min={15}
              max={480}
              step={1}
              value={prefs.typicalSetMinutes ?? ""}
              onChange={(e) => setPrefs((p) => ({ ...p,
                typicalSetMinutes: e.target.value === "" ? null : Math.round(Number(e.target.value)) }))}
            />
            <span className="font-sora text-xs text-gk-muted">Whole numbers only</span>
          </label>
          <label className="grid gap-1.5">
            <span className="font-sora text-sm font-medium text-gk-text">Brings own PA</span>
            <Select
              value={prefs.bringsOwnPA === null ? UNSET : String(prefs.bringsOwnPA)}
              onValueChange={(v) => setPrefs((p) => ({ ...p, bringsOwnPA: v === UNSET ? null : v === "true" }))}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>Not set</SelectItem>
                <SelectItem value="true">Yes</SelectItem>
                <SelectItem value="false">No</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1.5">
            <span className="font-sora text-sm font-medium text-gk-text">Availability</span>
            <Select
              value={prefs.availabilityPattern ?? UNSET}
              onValueChange={(v) => setPrefs((p) => ({ ...p,
                availabilityPattern: (v === UNSET ? null : v) as typeof p.availabilityPattern }))}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>Not set</SelectItem>
                <SelectItem value="weekends">Weekends</SelectItem>
                <SelectItem value="weeknights">Weeknights</SelectItem>
                <SelectItem value="anytime">Anytime</SelectItem>
                <SelectItem value="limited">Limited</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>

        <Button type="button" onClick={save} disabled={busy} className="justify-self-start">
          {busy ? "Saving…" : "Save rates & preferences"}
        </Button>
      </CardContent>
    </Card>
  );
}
