"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../src/lib/firebase";
import { useAuth } from "../../src/auth/AuthProvider";
import { validateProfileDraft, type ProfileDraftInput } from "@gatekeep/shared";

// Step 1 of the musician wizard: identity → creates the draft, then hands off
// to the portfolio editor which owns bio/photos/tracks/rates and the submit
// button (its gate messaging comes from the server). Musician-only — curator
// onboarding is sub-project 3. Deliberately does NOT auto-submit: the editor
// is where the required minimums (bio, genre, avatar, a listenable track) get
// filled in, and its submit button is locked until the server's gate is
// satisfied.
export default function Join() {
  const { user, loading } = useAuth();
  const router = useRouter();
  // Mirrors the editor page's auth guard exactly: the redirect is a side
  // effect, not something to trigger during render (calling router.replace
  // directly in the render body — as this page used to do — updates router
  // state while a different component is rendering, which React Strict Mode
  // and React 19 both flag).
  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  const [subtype, setSubtype] = useState<"solo" | "band">("solo");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return <main><p>Loading…</p></main>;
  if (!user) return null; // redirecting via the effect above

  const createDraft = async () => {
    const input: ProfileDraftInput = { type: "musician", subtype, name, handle: handle.toLowerCase() };
    const v = validateProfileDraft(input);
    if (!v.ok) { setError(v.reason); return; }
    setBusy(true); setError(null);
    try {
      const { data } = await httpsCallable<ProfileDraftInput, { profileId: string }>(
        getFirebase().functions, "createProfileDraft")(input);
      router.push(`/dashboard/portfolio/${data.profileId}`);
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
      <h1>Join as a musician</h1>
      <p>Create your act. You&apos;ll add your bio, photos, and a first track next —
        those are required before you can submit for review.</p>
      <div style={{ display: "flex", gap: 8 }}>
        {(["solo", "band"] as const).map((s) => (
          <button key={s} type="button" onClick={() => setSubtype(s)}
            style={{ padding: 10, borderRadius: 8, border: "1px solid #bbb",
              background: subtype === s ? "#111" : "#fff", color: subtype === s ? "#fff" : "#111" }}>
            {s === "solo" ? "Solo act" : "Band"}
          </button>
        ))}
      </div>
      <input placeholder="Stage or band name" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="handle (lowercase, no spaces)" autoCapitalize="none" value={handle}
        onChange={(e) => setHandle(e.target.value)} />
      {error && <p style={{ color: "#dc2626", margin: 0 }}>{error}</p>}
      <button onClick={createDraft} disabled={busy}>{busy ? "Creating…" : "Create my profile"}</button>
    </main>
  );
}
