import { ScrollView, View } from "react-native";
import { useAuth } from "../../src/auth/AuthProvider";
import { useProfileContext } from "../../src/shell/ProfileContext";
import { EarningsPanel } from "../../src/payments/EarningsPanel";
import { Text, PageBackground } from "../../src/ui";
import { tokens } from "../../src/theme/tokens";

// Musician "Dashboard" tab. Was a "Coming in a later phase" placeholder
// through SP4; SP5 Task 16 gave it its first real content, a read-only
// earnings summary for the ACTIVE musician profile. SP5b Task 7 replaces
// that with the full EarningsPanel (Stripe Express onboarding + cash-out,
// natively, no more "manage payouts on the web").
//
// Gated on the active profile context exactly like the sibling
// (musician)/bookings.tsx and (musician)/portfolio.tsx tabs: earnings are a
// per-profile fact (getStripeStatus takes a profileId and requires
// membership of it), and one account can hold several musician profiles.
// Unlike those two, no ProfileDoc subscription is needed here, nothing on
// this screen depends on the profile's name or approval status, and
// getStripeStatus itself only requires membership, so fetching the doc just
// to gate on it would add a listener for no behavior.
//
// EarningsPanel is keyed by profileId so a context switch REMOUNTS it (back
// to its own "Loading…") instead of leaving the previous profile's balance
// on screen while the new request is in flight, the same `key={profileId}`
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
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.sm }}>
          <Text variant="title">No musician profile</Text>
          <Text muted style={{ textAlign: "center" }}>
            Switch to a musician profile to see its earnings.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.lg }}>
        <Text variant="heading">Dashboard</Text>
        <EarningsPanel key={profileId} profileId={profileId} type="musician" />
      </ScrollView>
    </View>
  );
}
