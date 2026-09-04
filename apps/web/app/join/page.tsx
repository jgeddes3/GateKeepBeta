"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { callFn } from "../../src/lib/callable";
import { useAuth } from "../../src/auth/AuthProvider";
import { validateProfileDraft, type ProfileDraftInput, type MusicianSubtype, type CuratorSubtype } from "@gatekeep/shared";
import { Button } from "../../src/ui/button";
import { Input } from "../../src/ui/input";
import { Card, CardContent } from "../../src/ui/card";
import { IconWarning } from "../../src/ui/icons";

const CURATOR_SUBTYPES: { value: CuratorSubtype; label: string }[] = [
  { value: "venue", label: "Venue" },
  { value: "planner", label: "Event planner" },
  { value: "individual_host", label: "Individual host" },
];

// Restyle-only chip button (task 5 brief: "type/subtype pickers become
// styled chip-buttons, secondary variant, ember active state per accent
// dosage"). rounded-full is an explicit override, not the default: DESIGN.md
// only gives Button's "default" (primary/ember) variant the 999px pill by
// default, and "secondary" normally uses the 10px card/input tier for its
// usual bordered-ghost-action role. Here both states are genuine chips (the
// radius table's other named pill use), so the override applies to the
// inactive "secondary" state too, matching the precedent already set for
// LandingHero's hero CTAs.
function Chip({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "secondary"}
      size="sm"
      className="rounded-full"
      onClick={onClick}
      aria-pressed={active}
    >
      {children}
    </Button>
  );
}

// Step 1 of both wizards: identity → creates the draft, then hands off to
// the type-specific editor which owns the rest of the required content and
// the submit button (its gate messaging comes from the server). Deliberately
// does NOT auto-submit: the editor is where the required minimums get
// filled in, and its submit button is locked until the server's gate is
// satisfied. Sub-project 3 added the curator branch, same draft-creation
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

  if (loading) {
    return (
      <main className="flex flex-1 items-center justify-center px-4 py-16">
        <p className="font-sora text-sm text-gk-muted">Loading…</p>
      </main>
    );
  }
  if (!user) return null; // redirecting via the effect above

  const createDraft = async () => {
    const subtype = type === "musician" ? musicianSubtype : curatorSubtype;
    const input: ProfileDraftInput = { type, subtype, name, handle: handle.toLowerCase() };
    const v = validateProfileDraft(input);
    if (!v.ok) { setError(v.reason); return; }
    setBusy(true); setError(null);
    try {
      const { data } = await callFn<ProfileDraftInput, { profileId: string }>("createProfileDraft", input);
      router.push(type === "musician" ? `/dashboard/portfolio/${data.profileId}` : `/dashboard/curator/${data.profileId}`);
    } catch (e) {
      // Server errors are user-ready here too, e.g. "That handle is taken."
      // or the unsubmitted-drafts cap ("finish or delete an existing draft
      // first"), which points a stuck user at the editor's delete-draft
      // affordance.
      setError(e instanceof Error ? e.message : "Could not create your profile.");
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <Link href="/dashboard" className="font-sora text-sm text-gk-muted hover:text-gk-text">
        &larr; Dashboard
      </Link>
      <h1 className="mt-4 font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Join GateKeep</h1>
      <p className="mt-2 font-sora text-sm text-gk-muted">
        Pick a lane to start. You can add the other profile from your account later.
      </p>

      <Card className="mt-6">
        <CardContent className="grid gap-5">
          <div className="grid gap-2">
            <span className="font-sora text-sm font-medium text-gk-text">Profile type</span>
            <div className="flex flex-wrap gap-2">
              {(["musician", "curator"] as const).map((t) => (
                <Chip key={t} active={type === t} onClick={() => setType(t)}>
                  {t === "musician" ? "Musician" : "Curator"}
                </Chip>
              ))}
            </div>
          </div>

          {type === "musician" ? (
            <>
              <p className="font-sora text-sm text-gk-muted">
                Create your act. You&apos;ll add your bio, photos, and a first track next: those are
                required before you can submit for review.
              </p>
              <div className="grid gap-2">
                <span className="font-sora text-sm font-medium text-gk-text">Act type</span>
                <div className="flex flex-wrap gap-2">
                  {(["solo", "band"] as const).map((s) => (
                    <Chip key={s} active={musicianSubtype === s} onClick={() => setMusicianSubtype(s)}>
                      {s === "solo" ? "Solo act" : "Band"}
                    </Chip>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <p className="font-sora text-sm text-gk-muted">
                Create your curator profile. You&apos;ll add an about section, photos, a location, and
                what you&apos;re looking for next: those are required before you can submit for review.
              </p>
              <div className="grid gap-2">
                <span className="font-sora text-sm font-medium text-gk-text">Curator type</span>
                <div className="flex flex-wrap gap-2">
                  {CURATOR_SUBTYPES.map(({ value, label }) => (
                    <Chip key={value} active={curatorSubtype === value} onClick={() => setCuratorSubtype(value)}>
                      {label}
                    </Chip>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="grid gap-1.5">
            <label htmlFor="join-name" className="font-sora text-sm font-medium text-gk-text">
              {type === "musician" ? "Stage or band name" : "Venue or organization name"}
            </label>
            <Input id="join-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="join-handle" className="font-sora text-sm font-medium text-gk-text">
              Handle
            </label>
            <Input
              id="join-handle"
              placeholder="lowercase, no spaces"
              autoCapitalize="none"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
            />
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-gk border border-gk-destructive/40 bg-gk-destructive/14 px-3.5 py-2.5 font-sora text-sm text-gk-destructive"
            >
              <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <p>{error}</p>
            </div>
          )}

          <Button type="button" onClick={createDraft} disabled={busy}>
            {busy ? "Creating…" : "Create my profile"}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
