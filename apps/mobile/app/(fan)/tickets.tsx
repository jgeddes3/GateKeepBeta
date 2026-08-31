import { View } from "react-native";
import { useAuth } from "../../src/auth/AuthProvider";
import { TicketList } from "../../src/tickets/TicketList";
import { PageBackground } from "../../src/ui";

// Sub-project 6 task 11: the fan "Tickets" tab, real content. Was a branded
// "coming soon" placeholder through 9B; TicketList.tsx (wallet: upcoming/
// past/cancelled sections, incoming transfer offers, ticket detail with QR)
// now owns the actual screen. `user` is guaranteed non-null by the time this
// tab is reachable (app/_layout.tsx's Gate() redirects any signed-out
// session to (auth)/sign-in first), the `!user` branch below only covers
// the one-frame gap before that redirect effect fires.
export default function Screen() {
  const { user } = useAuth();
  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      {user && <TicketList uid={user.uid} />}
    </View>
  );
}
