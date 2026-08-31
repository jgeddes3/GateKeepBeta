"use client";
import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";

// Sub-project 6 task 10 (controller ruling 8): extracted verbatim from
// app/e/[eventId]/EventPageClient.tsx's own useTicketHolderAddress (Task 9),
// which needed the identical "does a ticket exist right now, and if so
// what's the door address" read for its own signed-in ticket-holder reveal.
// The fan tickets page (app/tickets/TicketsClient.tsx) needs the exact same
// per-event reveal for every ticket card that carries one, so this moved
// here rather than being duplicated a second time: a plain "use client"
// module (not a component), importable from any client component on either
// side without crossing a server/client boundary.

export interface EventPrivateAddress { address: string; geo: { lat: number; lng: number } | null }

export function mapUrl(address: EventPrivateAddress): string {
  const q = address.geo ? `${address.geo.lat},${address.geo.lng}` : address.address;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

// A one-shot getDoc pair, not a live onSnapshot: this only needs to answer
// "does a ticket exist right now", the same one-shot idiom
// app/gigs/[gigId]/page.tsx's useSeriesFillMode uses for an analogous
// "reveal more if the viewer can prove it" read. `"hidden"` covers both "no
// uid yet" and "signed in but no ticket for this event", indistinguishable
// on purpose (SP3's own "hidden while empty" contract: no ticket means no
// address block, not an empty-state message).
export function useTicketHolderAddress(eventId: string, uid: string | null): EventPrivateAddress | "hidden" {
  const [state, setState] = useState<EventPrivateAddress | "hidden">("hidden");
  useEffect(() => {
    // No synchronous setState for the "!uid" case (eslint-config-next's
    // react-hooks/set-state-in-effect rule: "avoid calling setState()
    // directly within an effect"): the effect simply does nothing when
    // there's no uid to look up, and the hook's own return expression below
    // derives "hidden" straight from `uid` for that case instead, the exact
    // shape app/gigs/[gigId]/page.tsx's useSeriesFillMode already
    // establishes for this pattern (see that hook's own comment).
    if (!uid) return;
    let cancelled = false;
    const { db } = getFirebase();
    (async () => {
      try {
        const idx = await getDoc(doc(db, `users/${uid}/ticketIndex/${eventId}`));
        if (!idx.exists()) { if (!cancelled) setState("hidden"); return; }
        const addr = await getDoc(doc(db, `events/${eventId}/private/address`));
        if (!cancelled) setState(addr.exists() ? (addr.data() as EventPrivateAddress) : "hidden");
      } catch (e) {
        // permission-denied is the expected case for every non-ticket-holder
        // (firestore.rules' private/address rule); anything else still falls
        // back to the same hidden state (a public page has no 500 to fall
        // back to), logged so a real backend fault isn't silently invisible.
        const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
        if (code !== "permission-denied") console.warn("ticket-holder address read failed", eventId, e);
        if (!cancelled) setState("hidden");
      }
    })();
    return () => { cancelled = true; };
  }, [eventId, uid]);
  return uid ? state : "hidden";
}
