"use client";
import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { useMyProfiles } from "../shell/useMyProfiles";
import { OfferComposer } from "./OfferComposer";
import { Button } from "../ui/button";

// Sub-project 9A task 9: the artist page hero's "Offer a gig" CTA (spec
// section 6.4). This is new WIRING, not a new callable/query/data shape:
// it surfaces the SAME curator-only offer flow CuratorArtistRow.tsx already
// ships (OfferComposer, unchanged) on a page that never had it before.
// "Preserving the existing curator-gated behavior
// exactly" means this reuses that gate as-is rather than inventing a new
// one:
// - Gate: useMyProfiles(uid), the SAME "my profiles" read every other
//   identity-aware surface on web already performs (ContextSwitcher,
//   AppShell), filtered to approved curator profiles.
// - Ambiguity: AppShell.tsx's resolveContext already establishes this
//   product's one answer to "the viewer has more than one profile of the
//   same type": fall back to the generic/hidden case rather than inventing
//   a picker UI this task doesn't otherwise need. Mirrored here: the button
//   only renders when exactly one approved curator profile resolves
//   unambiguously. A signed-out visitor, a non-curator, an unapproved
//   curator, or an account with 2+ curator profiles simply doesn't see it
//   (R-26: no dead control rather than a disabled one with nowhere to go).
export function OfferGigButton({ musicianProfileId, musicianName, className }: {
  musicianProfileId: string; musicianName: string; className?: string;
}) {
  const { user } = useAuth();
  const profiles = useMyProfiles(user?.uid ?? null);
  const [offering, setOffering] = useState(false);
  const curators = profiles.filter((p) => p.type === "curator" && p.status === "approved");

  if (curators.length !== 1) return null;
  const curatorProfileId = curators[0].profileId;

  // Two separate top-level children (a Fragment, not a wrapping <div>): the
  // hero renders this inline in a flex button row alongside the instant-play
  // and Shows controls, and the composer below (a full form, once opened)
  // needs to break onto its own full-width line rather than being squeezed
  // into that row as if it were a fourth button.
  return (
    <>
      <Button type="button" onClick={() => setOffering((v) => !v)} className={className}>
        {offering ? "Cancel" : "Offer a gig"}
      </Button>
      {offering && (
        <div className="mt-3 w-full basis-full">
          <OfferComposer
            key={`${curatorProfileId}-${musicianProfileId}`}
            curatorProfileId={curatorProfileId}
            musicianProfileId={musicianProfileId}
            musicianName={musicianName}
            onClose={() => setOffering(false)}
          />
        </div>
      )}
    </>
  );
}
