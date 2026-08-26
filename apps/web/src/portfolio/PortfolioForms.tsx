"use client";
import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadBytes } from "firebase/storage";
import { getFirebase } from "../lib/firebase";
import {
  GENRES, GIG_TYPES, stagingPhotoPath, validatePortfolioUpdate, validateBookingUpdate,
  type PortfolioData, type BookingDoc, type ExternalLink, type ExternalLinkKind,
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
    const v = validatePortfolioUpdate({ profileId, bio, genres });
    if (!v.ok) { window.alert(v.reason); return; }
    setBusy(true);
    if (await callOrAlert("updatePortfolio", { profileId, bio, genres })) onSaved?.();
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
  const save = async (next: ExternalLink[]) => {
    const v = validatePortfolioUpdate({ profileId, externalLinks: next });
    if (!v.ok) { window.alert(v.reason); return; }
    if (await callOrAlert("updatePortfolio", { profileId, externalLinks: next })) setLinks(next);
  };
  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h2>Links</h2>
      {links.map((l, i) => (
        <p key={`${l.kind}-${l.url}-${i}`} style={{ margin: 0 }}>
          {l.kind}: {l.url}{" "}
          <button onClick={() => void save(links.filter((_, j) => j !== i))}>Remove</button>
        </p>
      ))}
      <div style={{ display: "flex", gap: 6 }}>
        <select value={kind} onChange={(e) => setKind(e.target.value as ExternalLinkKind)}>
          <option value="spotify">Spotify</option><option value="youtube">YouTube</option>
          <option value="instagram">Instagram</option><option value="website">Website</option>
        </select>
        <input placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} />
        <button onClick={() => { if (url) { void save([...links, { kind, url }]); setUrl(""); } }}>Add</button>
      </div>
    </section>
  );
}

export function PhotoUploader({ profileId, uid, kind, hasPhoto }:
  { profileId: string; uid: string; kind: "avatar" | "cover"; hasPhoto?: boolean }) {
  const [busy, setBusy] = useState(false);
  const upload = async (f: File) => {
    setBusy(true);
    try {
      const { storage } = getFirebase();
      const path = stagingPhotoPath(uid, profileId, kind, crypto.randomUUID());
      await uploadBytes(storageRef(storage, path), f, { contentType: f.type });
      // The photo pipeline resizes/strips and updates the profile doc; the
      // parent page's snapshot listener picks the new path up automatically.
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Upload failed.");
    } finally { setBusy(false); }
  };
  return (
    <label style={{ display: "inline-block" }}>
      {busy ? "Uploading…" : `Upload ${kind === "avatar" ? "profile photo" : "cover photo"}`}
      {hasPhoto && <span style={{ color: "#16a34a" }}> ✓</span>}
      <input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: "none" }} disabled={busy}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
    </label>
  );
}

export function BookingForm({ profileId, initial }:
  { profileId: string; initial: BookingDoc | null }) {
  const [rates, setRates] = useState(initial?.rates ??
    { perHour: null, perSong: null, perSet: null });
  const [prefs, setPrefs] = useState(initial?.preferences ??
    { gigTypes: [], travelRadiusKm: null, actSize: null, typicalSetMinutes: null,
      bringsOwnPA: null, availabilityPattern: null });
  const [busy, setBusy] = useState(false);

  const rateField = (key: "perHour" | "perSong" | "perSet", label: string) => (
    <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ width: 120 }}>{label}</span>
      $<input type="number" min={0} step="0.01" style={{ width: 100 }}
        value={rates[key] ? (rates[key]!.amountCents / 100).toString() : ""}
        onChange={(e) => {
          const dollars = e.target.value;
          setRates((r) => ({ ...r, [key]: dollars === "" ? null
            : { amountCents: Math.round(Number(dollars) * 100), note: r[key]?.note ?? null } }));
        }} />
      <input placeholder="note (optional)" maxLength={200} style={{ flex: 1 }}
        value={rates[key]?.note ?? ""} disabled={!rates[key]}
        onChange={(e) => setRates((r) => ({ ...r,
          [key]: r[key] ? { ...r[key]!, note: e.target.value || null } : null }))} />
    </label>
  );

  const save = async () => {
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
      <label>Travel radius (km): <input type="number" min={0} max={3000} style={{ width: 90 }}
        value={prefs.travelRadiusKm ?? ""}
        onChange={(e) => setPrefs((p) => ({ ...p,
          travelRadiusKm: e.target.value === "" ? null : Number(e.target.value) }))} /></label>
      <label>Act size:{" "}
        <select value={prefs.actSize ?? ""} onChange={(e) => setPrefs((p) => ({ ...p,
          actSize: (e.target.value || null) as typeof p.actSize }))}>
          <option value="">—</option><option value="solo">Solo</option>
          <option value="duo">Duo</option><option value="band">Band</option>
        </select></label>
      <label>Typical set (minutes): <input type="number" min={15} max={480} style={{ width: 90 }}
        value={prefs.typicalSetMinutes ?? ""}
        onChange={(e) => setPrefs((p) => ({ ...p,
          typicalSetMinutes: e.target.value === "" ? null : Number(e.target.value) }))} /></label>
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
