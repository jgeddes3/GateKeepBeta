"use client";
import { useEffect, useState, type CSSProperties } from "react";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadBytes } from "firebase/storage";
import { getFirebase } from "../lib/firebase";
import {
  GENRES, GIG_TYPES, MAX_PHOTO_UPLOAD_BYTES, stagingPhotoPath, validatePortfolioUpdate, validateBookingUpdate,
  type PortfolioData, type BookingDoc, type ExternalLink, type ExternalLinkKind, type RateAmount,
} from "@gatekeep/shared";

const callOrAlert = async (name: string, data: object): Promise<boolean> => {
  try { await httpsCallable(getFirebase().functions, name)(data); return true; }
  catch (e) { window.alert(e instanceof Error ? e.message : "Save failed — try again."); return false; }
};

export function BioGenresForm({ profileId, initial, onSaved }:
  { profileId: string; initial: PortfolioData | undefined; onSaved?: () => void }) {
  const [bio, setBio] = useState(initial?.bio ?? "");
  const [genres, setGenres] = useState<string[]>(initial?.genres ?? []);
  const [busy, setBusy] = useState(false);
  const toggleGenre = (g: string) => setGenres((cur) =>
    cur.includes(g) ? cur.filter((x) => x !== g) : cur.length < 3 ? [...cur, g] : cur);
  const save = async () => {
    if (genres.length === 0 && (initial?.genres?.length ?? 0) > 0) {
      // Genres were saved before and the musician has now deselected all of
      // them. The omit-when-empty branch below exists for the never-set-yet
      // case (a bio-only save while onboarding); reusing it here would
      // silently no-op — validatePortfolioUpdate rejects an explicit [], so
      // omitting the key just leaves the OLD genres in place server-side —
      // which looks to the musician like their change was saved (the chips
      // show empty) when it wasn't. Block it with an explicit message
      // instead.
      window.alert("Keep at least one genre — it's required for review.");
      return;
    }
    // Omit genres entirely (rather than sending []) when none are picked
    // yet — a bio-only save has to work while a musician is still filling
    // in the rest of the form; validatePortfolioUpdate (and the server)
    // both treat an omitted field as "leave it alone", but an explicit []
    // fails the 1-3-genres check.
    const payload = genres.length > 0 ? { profileId, bio, genres } : { profileId, bio };
    const v = validatePortfolioUpdate(payload);
    if (!v.ok) { window.alert(v.reason); return; }
    setBusy(true);
    if (await callOrAlert("updatePortfolio", payload)) onSaved?.();
    setBusy(false);
  };
  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h2>Bio & genres</h2>
      <textarea rows={6} maxLength={2000} value={bio} placeholder="Tell curators and fans who you are…"
        onChange={(e) => setBio(e.target.value)} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {GENRES.map((g) => (
          <button key={g} type="button" onClick={() => toggleGenre(g)}
            style={{ padding: "4px 10px", borderRadius: 12, border: "1px solid #bbb",
              background: genres.includes(g) ? "#111" : "#fff", color: genres.includes(g) ? "#fff" : "#111" }}>
            {g}
          </button>
        ))}
      </div>
      <button onClick={save} disabled={busy}>Save bio & genres</button>
    </section>
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
    <section style={{ display: "grid", gap: 8 }}>
      <h2>Links</h2>
      {links.map((l, i) => (
        <p key={`${l.kind}-${l.url}-${i}`} style={{ margin: 0 }}>
          {l.kind}: {l.url}{" "}
          <button disabled={busy} onClick={() => void save(links.filter((_, j) => j !== i))}>Remove</button>
        </p>
      ))}
      <div style={{ display: "flex", gap: 6 }}>
        <select value={kind} disabled={busy} onChange={(e) => setKind(e.target.value as ExternalLinkKind)}>
          <option value="spotify">Spotify</option><option value="youtube">YouTube</option>
          <option value="instagram">Instagram</option><option value="website">Website</option>
        </select>
        <input placeholder="https://…" value={url} disabled={busy} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} />
        <button disabled={busy} onClick={async () => {
          if (!url) return;
          // Clear the input only once the save actually succeeds — clearing
          // unconditionally (as before) silently threw away what the
          // musician typed on a validation failure or a network error.
          if (await save([...links, { kind, url }])) setUrl("");
        }}>Add</button>
      </div>
    </section>
  );
}

// Off-screen but still in the layout/tab order (unlike display:none, which
// pulls the element out of tab order entirely) — the visible label text
// stays clickable via <label>/<input> association, but keyboard users can
// still Tab to and activate the file input directly.
const VISUALLY_HIDDEN_INPUT: CSSProperties = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
  overflow: "hidden", whiteSpace: "nowrap", border: 0, opacity: 0,
};

export function PhotoUploader({ profileId, uid, kind, currentPath }:
  { profileId: string; uid: string; kind: "avatar" | "cover"; currentPath: string | null }) {
  const [busy, setBusy] = useState(false);
  // The pipeline rewrites the profile doc's avatar/coverPhotoPath a few
  // seconds after the storage upload lands — we don't know its eventual
  // value client-side, so instead we keep showing "Processing…" until the
  // `currentPath` PROP itself moves. `baseline` tracks the last path we've
  // actually seen; when it disagrees with the incoming prop we're mid-render
  // with fresh data, so we adjust state right here (not in a useEffect —
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
  // and `awaiting` — and the disabled input — would otherwise deadlock
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
  return (
    <>
      <label style={{ display: "inline-block" }}>
        {busy ? "Uploading…" : processing ? "Processing…" : `Upload ${kind === "avatar" ? "profile photo" : "cover photo"}`}
        {currentPath && !processing && <span style={{ color: "#16a34a" }}> ✓</span>}
        <input type="file" accept="image/jpeg,image/png,image/webp" style={VISUALLY_HIDDEN_INPUT} disabled={busy || processing}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ""; // allows re-picking the same file (e.g. after a failed upload)
            if (f) void upload(f);
          }} />
      </label>
      {timedOut && (
        <span style={{ display: "block", color: "#92400e", fontSize: 12 }}>
          Still processing — if your photo doesn&apos;t appear, try a smaller one.
        </span>
      )}
    </>
  );
}

type RateKey = "perHour" | "perSong" | "perSet";
type RateInput = { amount: string; note: string | null };
const rateInputFrom = (r: RateAmount | null | undefined): RateInput =>
  r ? { amount: (r.amountCents / 100).toString(), note: r.note ?? null } : { amount: "", note: null };

export function BookingForm({ profileId, initial }:
  { profileId: string; initial: BookingDoc | null }) {
  // Raw strings, not derived cents: converting dollars -> cents -> back to a
  // display string on every keystroke (the old approach) fights the user
  // mid-entry — e.g. typing "1.50" round-trips through 150 cents and
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
  const [busy, setBusy] = useState(false);

  const rateField = (key: RateKey, label: string) => (
    <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ width: 120 }}>{label}</span>
      $<input type="number" min={0} step="0.01" style={{ width: 100 }}
        value={rateInputs[key].amount}
        onChange={(e) => setRateInputs((r) => ({ ...r, [key]: { ...r[key], amount: e.target.value } }))} />
      <input placeholder="note (optional)" maxLength={200} style={{ flex: 1 }}
        value={rateInputs[key].note ?? ""} disabled={rateInputs[key].amount.trim() === ""}
        onChange={(e) => setRateInputs((r) => ({ ...r, [key]: { ...r[key], note: e.target.value || null } }))} />
    </label>
  );

  const save = async () => {
    const rates: { perHour: RateAmount | null; perSong: RateAmount | null; perSet: RateAmount | null } =
      { perHour: null, perSong: null, perSet: null };
    for (const key of ["perHour", "perSong", "perSet"] as const) {
      const raw = rateInputs[key].amount.trim();
      if (raw === "") continue; // stays null — field left blank on purpose
      const dollars = Number(raw);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        window.alert("Rates must be more than $0, or leave the field blank.");
        return;
      }
      rates[key] = { amountCents: Math.round(dollars * 100), note: rateInputs[key].note || null };
    }
    const input = { profileId, rates, preferences: prefs };
    const v = validateBookingUpdate(input);
    if (!v.ok) { window.alert(v.reason); return; }
    setBusy(true);
    await callOrAlert("updateBookingInfo", input);
    setBusy(false);
  };

  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h2>Rates & preferences</h2>
      <p style={{ color: "#666", margin: 0 }}>
        Visible to curators only — never on your public page. Offer any mix of the three.
      </p>
      {rateField("perHour", "Per hour")}
      {rateField("perSong", "Per song")}
      {rateField("perSet", "Per set (flat)")}
      <h3 style={{ marginBottom: 0 }}>Gig preferences</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {GIG_TYPES.map((g) => (
          <button key={g} type="button"
            onClick={() => setPrefs((p) => ({ ...p, gigTypes: p.gigTypes.includes(g)
              ? p.gigTypes.filter((x) => x !== g) : [...p.gigTypes, g] }))}
            style={{ padding: "4px 10px", borderRadius: 12, border: "1px solid #bbb",
              background: prefs.gigTypes.includes(g) ? "#111" : "#fff",
              color: prefs.gigTypes.includes(g) ? "#fff" : "#111" }}>
            {g.replace("_", " ")}
          </button>
        ))}
      </div>
      <label>Travel radius (km): <input type="number" min={0} max={3000} step={1} style={{ width: 90 }}
        value={prefs.travelRadiusKm ?? ""}
        onChange={(e) => setPrefs((p) => ({ ...p,
          travelRadiusKm: e.target.value === "" ? null : Math.round(Number(e.target.value)) }))} />
        <span style={{ color: "#666", fontSize: 12 }}> (whole numbers only)</span></label>
      <label>Act size:{" "}
        <select value={prefs.actSize ?? ""} onChange={(e) => setPrefs((p) => ({ ...p,
          actSize: (e.target.value || null) as typeof p.actSize }))}>
          <option value="">—</option><option value="solo">Solo</option>
          <option value="duo">Duo</option><option value="band">Band</option>
        </select></label>
      <label>Typical set (minutes): <input type="number" min={15} max={480} step={1} style={{ width: 90 }}
        value={prefs.typicalSetMinutes ?? ""}
        onChange={(e) => setPrefs((p) => ({ ...p,
          typicalSetMinutes: e.target.value === "" ? null : Math.round(Number(e.target.value)) }))} />
        <span style={{ color: "#666", fontSize: 12 }}> (whole numbers only)</span></label>
      <label>Bring own PA:{" "}
        <select value={prefs.bringsOwnPA === null ? "" : String(prefs.bringsOwnPA)}
          onChange={(e) => setPrefs((p) => ({ ...p,
            bringsOwnPA: e.target.value === "" ? null : e.target.value === "true" }))}>
          <option value="">—</option><option value="true">Yes</option><option value="false">No</option>
        </select></label>
      <label>Availability:{" "}
        <select value={prefs.availabilityPattern ?? ""}
          onChange={(e) => setPrefs((p) => ({ ...p,
            availabilityPattern: (e.target.value || null) as typeof p.availabilityPattern }))}>
          <option value="">—</option><option value="weekends">Weekends</option>
          <option value="weeknights">Weeknights</option><option value="anytime">Anytime</option>
          <option value="limited">Limited</option>
        </select></label>
      <button onClick={save} disabled={busy}>Save rates & preferences</button>
    </section>
  );
}
