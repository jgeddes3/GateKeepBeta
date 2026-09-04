import { useEffect, useState } from "react";
import { View, Pressable } from "react-native";
import { callFn } from "../lib/callable";
import { formatCents, formatGigDateTime } from "../gigs/GigForms";
import type { HistoryRow, LedgerKind, PayoutHistoryScope } from "@gatekeep/shared";
import { Text, Button, Callout, Skeleton } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// SP5c Task 9/11: the one ledger-history renderer both the profile scope
// (EarningsPanel) and a future "my earnings" user scope share, mobile's
// direct port of apps/web/src/payments/PayoutHistoryList.tsx onto the mobile
// primitives. Short labels for every LedgerKind (@gatekeep/shared) a
// getPayoutHistory page can return: a Record, not a switch, so a kind added
// to the shared union and missed here is a compile error, not a silent blank
// label. The nine strings named in the brief (Settlement, Share paid, Share
// held, Share released, Payout, Instant payout, Payout failed, Ticket
// settlement, Fee) are exact; every other kind gets a plain, house-voice
// label of its own since a profile's shared ledger can carry curator-side and
// ticketing rows too (deposit/refund/dispute/etc.), not just the
// musician-earnings rows the brief calls out by name.
const KIND_LABELS: Record<LedgerKind, string> = {
  deposit_charged: "Deposit",
  settlement_charged: "Settlement",
  refund: "Refund",
  forfeit_transfer: "Deposit forfeited",
  earnings_transfer: "Settlement",
  late_fee: "Fee",
  payout_standard: "Payout",
  payout_instant: "Instant payout",
  transfer_reversal: "Transfer reversed",
  account_debit: "Account debit",
  payout_failed: "Payout failed",
  ticket_sale: "Ticket sale",
  ticket_cancel_refund: "Refund",
  ticket_grace_refund: "Refund",
  ticket_settlement: "Ticket settlement",
  dispute_opened: "Dispute opened",
  dispute_lost: "Dispute lost",
  dispute_won: "Dispute won",
  external_refund: "Refund",
  share_transfer: "Share paid",
  share_held: "Share held",
  share_released: "Share released",
  share_voided: "Share voided",
  member_payout_standard: "Payout",
  member_payout_instant: "Instant payout",
  member_payout_failed: "Payout failed",
};

const SHARE_KINDS = new Set<LedgerKind>(["share_transfer", "share_held", "share_released"]);

// The only two kinds distributeEarnings (functions/src/payoutShares.ts) is
// ever called from (paymentsSettlement.ts's booking settlement, and
// paymentsSweep.ts's ticket settlement): these are the only rows a share_*
// row can be split from, so only these are eligible parents. Fix round 1
// (web): an earlier version keyed parents off ANY non-share_* row sharing a
// ref, which let a forfeit_transfer row (same bookingId+gigId, never routed
// through distributeEarnings) wrongly claim a settlement's share_* children
// as its own.
const SETTLEMENT_PARENT_KINDS = new Set<LedgerKind>(["earnings_transfer", "ticket_settlement"]);

// The ref key a settlement row and the share_* rows split from it always
// share: distributeEarnings (functions/src/payoutShares.ts) writes every leg
// of one payout with the SAME `ref` (bookingId+gigId for a booking
// settlement, eventId+orderId for a ticket settlement) as the parent
// earnings_transfer/ticket_settlement row it was split from. Rows with
// neither pair (a payout, a fee, a dispute) group with nothing and render
// standalone.
function refKey(row: HistoryRow): string | null {
  if (row.ref.bookingId && row.ref.gigId) return `b:${row.ref.bookingId}:${row.ref.gigId}`;
  if (row.ref.eventId && row.ref.orderId) return `t:${row.ref.eventId}:${row.ref.orderId}`;
  return null;
}

function HistoryRowLine({ row }: { row: HistoryRow }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: tokens.space.sm }}>
      <View style={{ flexShrink: 1 }}>
        <Text>
          {KIND_LABELS[row.kind]}
          {row.label && <Text muted> · {row.label}</Text>}
        </Text>
        <Text variant="meta" muted>{formatGigDateTime(row.at)}</Text>
      </View>
      <Text variant="label">{formatCents(row.amountCents)}</Text>
    </View>
  );
}

export function PayoutHistoryList({ scope }: { scope: PayoutHistoryScope }) {
  const t = useTokens();
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);

  // Called only from click handlers (Retry, Show more), never from the
  // mount effect below: it sets loading state SYNCHRONOUSLY as its first
  // step, which is the right thing for a user-initiated fetch but is exactly
  // what an effect body must not do (react-hooks/set-state-in-effect) since
  // it can cascade an extra render. The initial page load below is its own,
  // effect-safe copy of this same fetch instead of a shared call into this
  // function.
  const load = async (after: string | null, replace: boolean) => {
    if (replace) setStatus("loading"); else setLoadingMore(true);
    try {
      const res = await callFn<{ scope: PayoutHistoryScope; cursor?: string | null }, { rows: HistoryRow[]; nextCursor: string | null }>(
        "getPayoutHistory", { scope, cursor: after });
      setRows((prev) => (replace ? res.data.rows : [...prev, ...res.data.rows]));
      setCursor(res.data.nextCursor);
      setStatus("ready");
    } catch {
      if (replace) setStatus("error");
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await callFn<{ scope: PayoutHistoryScope; cursor?: string | null }, { rows: HistoryRow[]; nextCursor: string | null }>(
          "getPayoutHistory", { scope, cursor: null });
        if (cancelled) return;
        setRows(res.data.rows);
        setCursor(res.data.nextCursor);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => { cancelled = true; };
    // scope is a small plain object built fresh by the caller on every
    // render; keying off its serialized identity (rather than the object
    // reference) is what keeps this effect from refetching every render
    // while still refetching when the profileId it names actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(scope)]);

  if (status === "loading") {
    return (
      <View style={{ gap: tokens.space.sm }}>
        <Skeleton height={36} width="100%" />
        <Skeleton height={36} width="100%" />
      </View>
    );
  }
  if (status === "error") {
    return (
      <View style={{ gap: tokens.space.sm }}>
        <Callout tone="warning"><Text color={t.warning}>Couldn&apos;t load payout history.</Text></Callout>
        <Pressable onPress={() => void load(null, true)} style={{ alignSelf: "flex-start" }}>
          <Text color={t.warning} style={{ textDecorationLine: "underline" }}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  if (rows.length === 0) {
    return <Text muted>No payouts yet.</Text>;
  }

  // Group share_* rows under the settlement/ticket-settlement row they were
  // split from when both are on the currently-loaded page(s); a share row
  // with no matching parent loaded yet renders standalone rather than
  // vanishing.
  const parentByKey = new Map<string, HistoryRow>();
  for (const row of rows) {
    if (!SETTLEMENT_PARENT_KINDS.has(row.kind)) continue;
    const key = refKey(row);
    if (key) parentByKey.set(key, row);
  }
  const childrenByParentId = new Map<string, HistoryRow[]>();
  const claimed = new Set<string>();
  for (const row of rows) {
    if (!SHARE_KINDS.has(row.kind)) continue;
    const key = refKey(row);
    const parent = key ? parentByKey.get(key) : undefined;
    if (!parent) continue;
    claimed.add(row.id);
    const list = childrenByParentId.get(parent.id) ?? [];
    list.push(row);
    childrenByParentId.set(parent.id, list);
  }

  return (
    <View style={{ gap: tokens.space.sm }}>
      <View style={{ gap: tokens.space.sm }}>
        {rows.filter((r) => !claimed.has(r.id)).map((row) => {
          const children = childrenByParentId.get(row.id);
          return (
            <View key={row.id} style={{ gap: tokens.space.xs }}>
              <HistoryRowLine row={row} />
              {children && children.length > 0 && (
                <View style={{
                  gap: tokens.space.xs, marginLeft: tokens.space.md,
                  borderLeftWidth: 1, borderLeftColor: t.border, paddingLeft: tokens.space.sm,
                }}
                >
                  {children.map((child) => <HistoryRowLine key={child.id} row={child} />)}
                </View>
              )}
            </View>
          );
        })}
      </View>
      {cursor && (
        <Button
          title={loadingMore ? "Loading…" : "Show more"}
          variant="secondary"
          onPress={() => void load(cursor, false)}
          disabled={loadingMore}
          style={{ alignSelf: "flex-start" }}
        />
      )}
    </View>
  );
}
