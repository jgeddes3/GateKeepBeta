"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { conversationPairId, MESSAGE_ACTION_LABEL, type ProfileType } from "@gatekeep/shared";
import { useAuth } from "../auth/AuthProvider";
import { useMyProfiles } from "../shell/useMyProfiles";
import { Button } from "../ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet";

// SP12 (spec 3.1). The one "Message" affordance on web. It is HIDDEN, never
// disabled, when the viewer has no eligible profile of the opposite type:
// the same R-26 posture OfferGigButton already takes. Where OfferGigButton
// also hides for a viewer with two or more matching profiles, this one asks:
// the spec is explicit that "a viewer with several picks one in a sheet".
//
// The conversation id is computed client-side (conversationPairId) purely to
// pre-select the thread; the conversation itself is created server-side on
// the first send, so linking to a pair that has never been messaged is safe
// and simply shows the empty state.
export function MessageButton({ targetProfileId, targetProfileType, targetName, actingProfileId, className }: {
  targetProfileId: string; targetProfileType: ProfileType; targetName: string;
  actingProfileId?: string; className?: string;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const profiles = useMyProfiles(user?.uid ?? null);
  const [picking, setPicking] = useState(false);

  const wantedType: ProfileType = targetProfileType === "musician" ? "curator" : "musician";
  const eligible = actingProfileId
    ? profiles.filter((p) => p.profileId === actingProfileId)
    : profiles.filter((p) => p.type === wantedType && p.status === "approved");
  if (eligible.length === 0) return null;

  const open = (actingId: string) => {
    const pairId = targetProfileType === "musician"
      ? conversationPairId(targetProfileId, actingId)
      : conversationPairId(actingId, targetProfileId);
    router.push(`/dashboard/messages?c=${pairId}`);
  };

  return (
    <>
      <Button
        type="button" variant="secondary" className={className}
        onClick={() => (eligible.length === 1 ? open(eligible[0].profileId) : setPicking(true))}
      >
        {MESSAGE_ACTION_LABEL}
      </Button>
      <Sheet open={picking} onOpenChange={setPicking}>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>Message {targetName} as</SheetTitle>
          </SheetHeader>
          <ul className="grid gap-2 p-4">
            {eligible.map((p) => (
              <li key={p.profileId}>
                <Button
                  type="button" variant="secondary" className="w-full justify-start"
                  onClick={() => { setPicking(false); open(p.profileId); }}
                >
                  {p.name}
                </Button>
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
}
