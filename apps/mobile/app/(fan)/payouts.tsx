import { ScrollView, View } from "react-native";
import { MemberPayoutsPanel } from "../../src/payments/MemberPayoutsPanel";
import { PageBackground } from "../../src/ui";
import { tokens } from "../../src/theme/tokens";

// SP5c Task 12: the fan's hidden "Payouts" tab, reachable via
// router.push("/(fan)/payouts") from AccountScreen's own "Payouts" row and
// from a tapped share_paid/share_held/share_released/member_payout_failed
// push (push.ts's pushHref -> notificationHref), same hidden-tab shape as
// `following`/`saved-searches` in this same layout (href: null keeps it out
// of the tab bar itself).
export default function Screen() {
  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ScrollView contentContainerStyle={{ padding: tokens.space.lg, paddingBottom: tokens.space.xl }}>
        <MemberPayoutsPanel />
      </ScrollView>
    </View>
  );
}
