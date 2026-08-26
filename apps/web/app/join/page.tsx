"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../src/lib/firebase";
import { useAuth } from "../../src/auth/AuthProvider";
import { validateProfileDraft, type ProfileDraftInput, type MusicianSubtype, type CuratorSubtype } from "@gatekeep/shared";

const CURATOR_SUBTYPES: { value: CuratorSubtype; label: string }[] = [
  { value: "venue", label: "Venue" },
  { value: "planner", label: "Event planner" },
  { value: "individual_host", label: "Individual host" },
];

// Step 1 of both wizards: identity → creates the draft, then hands off to
// the type-specific editor which owns the rest of the required content and
// the submit button (its gate messaging comes from the server). Deliberately
// does NOT auto-submit: the editor is where the required minimums get
// filled in, and its submit button is locked until the server's gate is
// satisfied. Sub-project 3 added the curator branch — same draft-creation
// flow (createProfileDraft, same validateProfileDraft gate, same
// unsubmitted-drafts-cap error surfaced verbatim), routed to
// /dashboard/curator/[profileId] instead of the musician portfolio editor.
export default function Join() {
  const { user, loading } = useAuth();
  const router = useRouter();
  // Mirrors the editor pages' auth guard exactly: the redirect is a side
  // effect, not something to trigger during render (calling router.replace
  // directly in the render body updates router state while a different
  // component is rendering, which React Strict Mode and React 19 both flag).
  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  const [type, setType] = useState<"musician" | "curator">("musician");
  const [musicianSubtype, setMusicianSubtype] = useState<MusicianSubtype>("solo");
  const [curatorSubtype, setCuratorSubtype] = useState<CuratorSubtype>("venue");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return <main><p>Loading…</p></main>;
  if (!user) return null; // redirecting via the effect above

  const createDraft = async () => {
    const subtype = type === "musician" ? musicianSubtype : curatorSubtype;
    const input: ProfileDraftInput = { type, subtype, name, handle: handle.toLowerCase() };
    const v = validateProfileDraft(input);
    if (!v.ok) { setError(v.reason); return; }
    setBusy(true); setError(null);
    try {
      const { data } = await httpsCallable<ProfileDraftInput, { profileId: string }>(
        getFirebase().functions, "createProfileDraft")(input);
      router.push(type === "musician" ? `/dashboard/portfolio/${data.profileId}` : `/dashboard/curator/${data.profileId}`);
    } catch (e) {
      // Server errors are user-ready here too — e.g. "That handle is taken."
      // or the unsubmitted-drafts cap ("finish or delete an existing draft
      // first"), which points a stuck user at the editor's delete-draft
      // affordance.
      setError(e instanceof Error ? e.message : "Could not create your profile.");
      setBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: 480, margin: "40px auto", display: "grid", gap: 12 }}>
      <a href="/dashboard" style={{ color: "#666", fontSize: 14 }}>← Dashboard</a>
      <h1>Join GateKeep</h1>
      <div style={{ display: "flex", gap: 8 }}>
        {(["musician", "curator"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setType(t)}
            style={{ padding: 10, borderRadius: 8, border: "1px solid #bbb",
              background: type === t ? "#111" : "#fff", color: type === t ? "#fff" : "#111" }}>
            {t === "musician" ? "Musician" : "Curator"}
          </button>
        ))}
      </div>
      {type === "musician" ? (
        <>
          <p>Create your act. You&apos;ll add your bio, photos, and a first track next —
            those are required before you can submit for review.</p>
          <div style={{ display: "flex", gap: 8 }}>
            {(["solo", "band"] as const).map((s) => (
              <button key={s} type="button" onClick={() => setMusicianSubtype(s)}
                style={{ padding: 10, borderRadius: 8, border: "1px solid #bbb",
                  background: musicianSubtype === s ? "#111" : "#fff", color: musicianSubtype === s ? "#fff" : "#111" }}>
                {s === "solo" ? "Solo act" : "Band"}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <p>Create your curator profile. You&apos;ll add an about section, photos, a location,
            and what you&apos;re looking for next — those are required before you can submit for review.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {CURATOR_SUBTYPES.map(({ value, label }) => (
              <button key={value} type="button" onClick={() => setCuratorSubtype(value)}
                style={{ padding: 10, borderRadius: 8, border: "1px solid #bbb",
                  background: curatorSubtype === value ? "#111" : "#fff", color: curatorSubtype === value ? "#fff" : "#111" }}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      <input placeholder={type === "musician" ? "Stage or band name" : "Venue or organization name"}
        value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="handle (lowercase, no spaces)" autoCapitalize="none" value={handle}
        onChange={(e) => setHandle(e.target.value)} />
      {error && <p style={{ color: "#dc2626", margin: 0 }}>{error}</p>}
      <button onClick={createDraft} disabled={busy}>{busy ? "Creating…" : "Create my profile"}</button>
    </main>
  );
}
