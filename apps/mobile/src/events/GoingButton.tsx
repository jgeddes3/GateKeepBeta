import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { doc, getDoc } from "firebase/firestore";
import { GOING_LABEL, type EventReactionDoc, type EventStatus } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { useAuth } from "../auth/AuthProvider";
import { Text, Button, ErrorBanner } from "../ui";
import { tokens } from "../theme/tokens";

// SP12 (spec 3.2 and 5). RN twin of Task 8's web GoingButton (same name, same
// contract): a signed-in-and-verified toggle on one public event's
// events/{eventId}/reactions/{uid} doc, seeded from EventDoc.goingCount (the
// caller's own already-loaded event doc, so this never runs its own count
// query) and adjusted optimistically on every tap.
//
// The viewer's own reaction doc is read ONCE (a plain getDoc, not a live
// onSnapshot): setGoing's own response is the thing this button reconciles
// against on every subsequent tap, so a live listener would only ever matter
// for a second device toggling the same event mid-visit, a case this app
// does not chase anywhere else either (ShowPosts' own membership/gate reads
// are one-shot the same way).
export function GoingButton({ eventId, eventStatus, initialCount }: {
  eventId: string; eventStatus: EventStatus; initialCount: number;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const isOpen = eventStatus === "published" || eventStatus === "completed";

  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const [going, setGoing] = useState(false);
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Sync with `user` itself changing (sign-out/sign-in), same guard-clause
    // shape as ProfileContext.tsx's own.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!user) { setGoing(false); setState("ready"); return; }
    let cancelled = false;
    getDoc(doc(getFirebase().db, `events/${eventId}/reactions/${user.uid}`))
      .then((s) => {
        if (cancelled) return;
        setGoing(s.exists() ? Boolean((s.data() as EventReactionDoc).going) : false);
        setState("ready");
      })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, [eventId, user]);

  const toggle = async () => {
    if (!user) { router.push("/(auth)/sign-in"); return; }
    if (!isOpen || busy || state !== "ready") return;
    const prevGoing = going;
    const prevCount = count;
    const next = !going;
    // Optimistic: flip immediately, then reconcile against setGoing's own
    // returned {going, goingCount}, and revert both on a refusal (a stale
    // rate cap, a race with the event closing underneath the tap).
    setGoing(next);
    setCount((c) => Math.max(0, c + (next ? 1 : -1)));
    setBusy(true);
    setError(null);
    try {
      const res = await callFn<{ eventId: string; going: boolean }, { going: boolean; goingCount: number }>(
        "setGoing", { eventId, going: next });
      setGoing(res.data.going);
      setCount(res.data.goingCount);
    } catch (e) {
      setGoing(prevGoing);
      setCount(prevCount);
      setError(e instanceof Error ? e.message : "Could not update this. Try again.");
    } finally {
      setBusy(false);
    }
  };

  // Ruling: matches web's GoingButton exactly. A draft or cancelled event
  // has nothing to react to, so this renders nothing rather than a
  // disabled-but-visible button.
  if (!isOpen) return null;

  return (
    <View style={{ gap: tokens.space.xs }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
        <Button
          title={GOING_LABEL}
          variant={going ? "default" : "secondary"}
          loading={busy || state === "loading"}
          onPress={() => void toggle()}
          accessibilityState={{ selected: going }}
          accessibilityLabel={`${GOING_LABEL}, ${count} going`}
          style={{ alignSelf: "flex-start" }}
        />
        <Text variant="meta" muted>{count} going</Text>
      </View>
      {state === "error" && <ErrorBanner message="Couldn't load your RSVP status." />}
      {error && <ErrorBanner message={error} />}
    </View>
  );
}
