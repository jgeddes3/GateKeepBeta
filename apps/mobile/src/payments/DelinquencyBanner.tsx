import { useEffect, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { fetchDelinquentBookingIds } from "./delinquentBookings";
import type { StripeStatusResult } from "@gatekeep/shared";

// SP5 Task 6 — mounted on the curator dashboard. One-shot getStripeStatus
// on mount (no need for a live subscription here — a curator opening this
// page is exactly when a fresh read is worth it) plus, only when delinquent,
// the shared delinquentBookings.ts query (also used by GatePrompt's
// CuratorDelinquentGate — one copy of the query, review round 1 low #14).
export function DelinquencyBanner({ profileId }: { profileId: string }) {
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
    <View style={{ backgroundColor: "#fee2e2", borderWidth: 1, borderColor: "#fca5a5", borderRadius: 8, padding: 12, gap: 6 }}>
      <Text style={{ margin: 0, fontWeight: "600", color: "#991b1b" }}>
        This profile has an overdue payment — you can&apos;t book new musicians until it&apos;s settled.
      </Text>
      {affected === "loading" ? (
        <Text style={{ margin: 0, color: "#991b1b" }}>Checking which booking is affected…</Text>
      ) : affected.length > 0 ? (
        <Text style={{ margin: 0, color: "#991b1b" }}>
          Settle it from{" "}
          {affected.map((id, i) => (
            <Text key={id}>
              <Pressable onPress={() => router.push({ pathname: "/booking/[bookingId]", params: { bookingId: id } } as any)}>
                <Text style={{ color: "#991b1b", textDecorationLine: "underline" }}>
                  this booking{affected.length > 1 ? ` (${i + 1})` : ""}
                </Text>
              </Pressable>
              {i < affected.length - 1 ? ", " : ""}
            </Text>
          ))}
          .
        </Text>
      ) : (
        <Text style={{ margin: 0, color: "#991b1b" }}>Check your bookings tab to find and settle the overdue date.</Text>
      )}
    </View>
  );
}
