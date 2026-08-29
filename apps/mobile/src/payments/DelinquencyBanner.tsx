import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { fetchDelinquentBookingIds } from "./delinquentBookings";
import type { StripeStatusResult } from "@gatekeep/shared";
import { Text } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// SP5b Task 6: mounted on the curator dashboard. One-shot getStripeStatus
// on mount (no need for a live subscription here, a curator opening this
// page is exactly when a fresh read is worth it) plus, only when delinquent,
// the shared delinquentBookings.ts query (also used by GatePrompt's
// CuratorDelinquentGate, one copy of the query, review round 1 low #14).
export function DelinquencyBanner({ profileId }: { profileId: string }) {
  const t = useTokens();
  const router = useRouter();
  const [status, setStatus] = useState<StripeStatusResult | null>(null);
  const [affected, setAffected] = useState<string[] | "loading">("loading");

  useEffect(() => {
    let cancelled = false;
    httpsCallable<{ profileId: string }, StripeStatusResult>(getFirebase().functions, "getStripeStatus")({ profileId })
      .then((res) => { if (!cancelled) setStatus(res.data); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, [profileId]);

  useEffect(() => {
    if (status?.delinquent !== true) return;
    let cancelled = false;
    fetchDelinquentBookingIds(profileId)
      .then((ids) => { if (!cancelled) setAffected(ids); })
      .catch(() => { if (!cancelled) setAffected([]); });
    return () => { cancelled = true; };
  }, [status?.delinquent, profileId]);

  if (status?.delinquent !== true) return null;

  return (
    <View style={{ backgroundColor: t.destructive + "24", borderWidth: 1, borderColor: t.destructive,
      borderRadius: tokens.radius.card, padding: tokens.space.md, gap: tokens.space.sm }}>
      <Text variant="label" color={t.destructive}>
        This profile has an overdue payment, you can&apos;t book new musicians until it&apos;s settled.
      </Text>
      {affected === "loading" ? (
        <Text color={t.destructive}>Checking which booking is affected…</Text>
      ) : affected.length > 0 ? (
        <Text color={t.destructive}>
          Settle it from{" "}
          {affected.map((id, i) => (
            <Text key={id} color={t.destructive}>
              <Text color={t.destructive} style={{ textDecorationLine: "underline" }}
                onPress={() => router.push({ pathname: "/booking/[bookingId]", params: { bookingId: id } })}>
                this booking{affected.length > 1 ? ` (${i + 1})` : ""}
              </Text>
              {i < affected.length - 1 ? ", " : ""}
            </Text>
          ))}
          .
        </Text>
      ) : (
        <Text color={t.destructive}>Check your bookings tab to find and settle the overdue date.</Text>
      )}
    </View>
  );
}
