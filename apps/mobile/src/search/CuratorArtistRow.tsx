import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { doc, getDoc } from "firebase/firestore";
import { type CuratorBookingDoc, type SearchResult } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { formatChipLabel } from "../discover/discoverQueries";
import { formatReliabilityLine } from "../bookings/BookingForms";
import { NULL_RATES, OfferComposer, RatesSummary } from "../bookings/OfferComposer";
import { Button, Card, IconUser, Sheet, Skeleton, Text } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";
import { ACT_SIZE_LABEL, distancePart, Thumbnail } from "./ResultRows";

// SP8 Task 15, ruling 2: the curator face keeps the placeholder's per-row
// profiles/{id}/private/curatorBooking read (rates line + reliability
// line, byte-identical copy to the old curator browse screen's card,
// deleted this task) rather than the plain ProfileRow the deck's other
// profile-kind faces use, plus an "Offer a gig" action that opens
// OfferComposer in a Sheet. Not folded into ResultRows.tsx: a curator
// result needs this extra read and action, no other face does.
export function CuratorArtistRow({ curatorProfileId, r }: { curatorProfileId: string; r: SearchResult }) {
  const router = useRouter();
  const t = useTokens();
  const [booking, setBooking] = useState<CuratorBookingDoc | null | "loading">("loading");
  const [offering, setOffering] = useState(false);

  // Per-row private/curatorBooking read, the caller has curatorAccess via
  // their own approved curator profile membership (firestore.rules); n+1
  // over the result list accepted at v1, same tradeoff the old curator
  // browse screen's own card made.
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    getDoc(doc(db, `profiles/${r.id}/private/curatorBooking`))
      .then((s) => { if (!cancelled) setBooking(s.exists() ? (s.data() as CuratorBookingDoc) : null); })
      .catch(() => { if (!cancelled) setBooking(null); });
    return () => { cancelled = true; };
  }, [r.id]);

  const meta = [
    r.actSize ? ACT_SIZE_LABEL[r.actSize] : null,
    r.hasAudio ? "Has audio" : null,
    distancePart(r),
  ].filter((p): p is string => !!p).join(" · ");

  return (
    <Card style={{ gap: tokens.space.sm }}>
      <Pressable
        onPress={() => router.push({ pathname: "/artist/[handle]", params: { handle: r.handle ?? "" } })}
        accessibilityRole="button"
        accessibilityLabel={r.title}
        style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}
      >
        <Thumbnail imagePath={r.imagePath} size={44} radius={22} icon={<IconUser size={18} color={t.muted} />} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label" numberOfLines={1}>{r.title}</Text>
          {r.genres.length > 0 && <Text variant="meta" muted numberOfLines={1}>{r.genres.map(formatChipLabel).join(", ")}</Text>}
          {meta && <Text variant="meta" muted numberOfLines={1}>{meta}</Text>}
        </View>
      </Pressable>
      {booking === "loading" ? (
        <Skeleton height={14} width="55%" />
      ) : (
        <View style={{ gap: 2 }}>
          <RatesSummary rates={booking?.rates ?? NULL_RATES} />
          <Text variant="meta" muted>{formatReliabilityLine(booking?.reliability)}</Text>
        </View>
      )}
      <Button title={offering ? "Cancel" : "Offer a gig"} variant="secondary" onPress={() => setOffering((v) => !v)} style={{ alignSelf: "flex-start" }} />
      <Sheet visible={offering} onClose={() => setOffering(false)}>
        {/* Sheet takes no stance on keyboard avoidance; the offer's
            amount/note fields need one, same pattern as GigDetailSheet's own
            Apply flow. A ScrollView (same maxHeight/keyboardShouldPersistTaps
            shape GigDetailSheet uses) keeps "Send offer" reachable when a
            curator with several open gigs has the keyboard up on a small
            device: the gig-chip list plus the offer fields can run past the
            sheet's own height without one. */}
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
          <ScrollView style={{ maxHeight: "85%" }} keyboardShouldPersistTaps="handled">
            <OfferComposer
              key={`${curatorProfileId}-${r.id}`}
              curatorProfileId={curatorProfileId}
              musicianProfileId={r.id}
              musicianName={r.title}
              onClose={() => setOffering(false)}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </Sheet>
    </Card>
  );
}
