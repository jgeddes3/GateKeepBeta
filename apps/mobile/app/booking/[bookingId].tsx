import { ScrollView, View, Text, Pressable } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAuth } from "../../src/auth/AuthProvider";
import { BookingThread } from "../../src/bookings/BookingThread";
import { PaymentStatus } from "../../src/bookings/PaymentStatus";
import { useTokens } from "../../src/theme/ThemeProvider";

// Shared booking thread route (SP4 Task 12) — deep-linked from both role
// tabs' inbox rows (BookingInbox.tsx) and from notification rows
// (kind:"booking" rows in NotificationsList.tsx, via NotificationDoc.refId).
// A top-level route (sibling of app/artist/[handle].tsx), reachable from
// either the (musician) or (curator) tab group.
//
// No local auth-redirect effect here (unlike web's equivalent page): the
// root layout's Gate() already forces sign-in for every route outside
// (auth), so by the time this screen renders `user` is already set except
// for a brief loading window — mirrored by the guard below, the same shape
// every other post-auth mobile screen in this app uses.
export default function BookingThreadPage() {
  const { bookingId: rawBookingId } = useLocalSearchParams<{ bookingId: string }>();
  const bookingId = rawBookingId ?? "";
  const { user, loading } = useAuth();
  const router = useRouter();
  const t = useTokens();

  if (loading || !user) {
    return <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Text>Loading…</Text></View>;
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}>
        <Text style={{ color: t.muted }}>← Back</Text>
      </Pressable>
      {/* Keyed by bookingId+uid: forces a fresh BookingThread instance (all
          its per-action busy/error/dialog state resets to defaults) on
          either a route change to a different booking or a signed-in
          identity switch — Expo Router reuses this same screen instance
          across client-side navigations to the same route with different
          params, mirroring web's identical key rationale. */}
      <BookingThread key={`${bookingId}-${user.uid}`} bookingId={bookingId} uid={user.uid} />
      {/* SP5 Task 16 — the read-only money surface, keyed the same way and
          for the same reason. It renders nothing at all until the booking
          has payment docs (an accepted booking), so an open/negotiating
          thread looks exactly as it did before. Mirrors web, where
          PaymentsPanel sits directly beneath BookingThread on the booking
          detail page. */}
      <PaymentStatus key={`payments-${bookingId}-${user.uid}`} bookingId={bookingId} uid={user.uid} />
    </ScrollView>
  );
}
