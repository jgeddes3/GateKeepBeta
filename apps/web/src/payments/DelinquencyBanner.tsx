"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../lib/firebase";
import { fetchDelinquentBookingIds } from "./delinquentBookings";
import type { StripeStatusResult } from "@gatekeep/shared";

// SP5 Task 15 — mounted on the curator profile editor (the closest thing
// this app has to a "curator dashboard shell": it's where a curator's own
// bookings already render below, via BookingInbox). One-shot getStripeStatus
// on mount (no need for a live subscription here — a curator opening this
// page is exactly when a fresh read is worth it) plus, only when delinquent,
// the shared delinquentBookings.ts query (also used by GatePrompt's
// CuratorDelinquentGate — one copy of the query, review round 1 low #14).
export function DelinquencyBanner({ profileId }: { profileId: string }) {
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
    <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 8, padding: 12, display: "grid", gap: 6 }}>
      <p style={{ margin: 0, fontWeight: 600, color: "#991b1b" }}>
        This profile has an overdue payment — you can&apos;t book new musicians until it&apos;s settled.
      </p>
      {affected === "loading" ? (
        <p style={{ margin: 0, color: "#991b1b" }}>Checking which booking is affected…</p>
      ) : affected.length > 0 ? (
        <p style={{ margin: 0, color: "#991b1b" }}>
          Settle it from{" "}
          {affected.map((id, i) => (
            <span key={id}>
              <Link href={`/dashboard/bookings/${id}`} style={{ color: "#991b1b", textDecoration: "underline" }}>
                this booking{affected.length > 1 ? ` (${i + 1})` : ""}
              </Link>
              {i < affected.length - 1 ? ", " : ""}
            </span>
          ))}
          .
        </p>
      ) : (
        <p style={{ margin: 0, color: "#991b1b" }}>See your bookings below to find and settle the overdue date.</p>
      )}
    </div>
  );
}
