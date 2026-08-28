import { ScrollView, View, Text } from "react-native";
import { useAuth } from "../../src/auth/AuthProvider";
import { useProfileContext } from "../../src/shell/ProfileContext";
import { EarningsCard } from "../../src/bookings/PaymentStatus";

// Musician "Dashboard" tab. Was a "Coming in a later phase" placeholder
// through SP4; SP5 Task 16 gives it its first real content — the read-only
// earnings summary for the ACTIVE musician profile.
//
// Gated on the active profile context exactly like the sibling
// (musician)/bookings.tsx and (musician)/portfolio.tsx tabs: earnings are a
// per-profile fact (getStripeStatus takes a profileId and requires
// membership of it), and one account can hold several musician profiles.
// Unlike those two, no ProfileDoc subscription is needed here — nothing on
// this screen depends on the profile's name or approval status, and
// getStripeStatus itself only requires membership, so fetching the doc just
// to gate on it would add a listener for no behavior.
//
// EarningsCard is keyed by profileId so a context switch REMOUNTS it (back
// to its own "Loading…") instead of leaving the previous profile's balance
// on screen while the new request is in flight — the same `key={profileId}`
// remount idiom (musician)/bookings.tsx uses for BookingInbox, and the
// reason this screen needs none of the sibling screens' activeIdRef/
// render-time-reset bookkeeping.
export default function MusicianDashboard() {
  const { user } = useAuth();
  const { activeContext } = useProfileContext();
  const profileId = typeof activeContext === "object" && activeContext.type === "musician"
    ? activeContext.profileId : null;

  if (!user || !profileId) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ textAlign: "center", color: "#666" }}>
          Switch to a musician profile to see its earnings.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <Text style={{ fontSize: 22, fontWeight: "700" }}>Dashboard</Text>
      <EarningsCard key={profileId} profileId={profileId} />
    </ScrollView>
  );
}
