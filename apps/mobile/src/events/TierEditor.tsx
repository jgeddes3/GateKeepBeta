import { useEffect, useState } from "react";
import { View } from "react-native";
import { collection, getDocs, onSnapshot, orderBy, query } from "firebase/firestore";
import type { EventStatus, TicketTierDoc } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import {
  OneOffDateTimeFields, oneOffDateTimeToMs, oneOffDateTimeFrom, emptyOneOffDateTime,
  type OneOffDateTimeState,
} from "../gigs/GigForms";
import { formatCents } from "./eventDisplay";
import { Text, Button, Input, Card, ErrorBanner, IconPlus, IconTrash } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// RN port of apps/web/src/events/EventEditor.tsx's TierEditor (SP6 task 10),
// pulled into its own file per Task 12's file list. Same callable, same
// gates, same "seeded once from initialTiers, never re-synced" discipline as
// the web twin (this form's own save echoes right back through the parent's
// tiers read, and a sale happening mid-edit moving soldCount must not wipe
// an in-progress edit): the caller remounts this with a fresh `key` only
// when switching to a genuinely different event.
//
// apps/mobile never depends on functions/src types (same boundary GigForms.tsx's
// own CreateGigPayload/UpdateGigPayload document): setEventTiers' real input
// interface lives in functions/src/events.ts and is hand-mirrored below.
interface SetEventTiersPayload {
  curatorProfileId: string; eventId: string;
  tiers: {
    tierId?: string; name: string; priceCents: number; capacity: number;
    saleStartsAt: number | null; saleEndsAt: number | null;
  }[];
}

export interface TierRowState {
  key: string; tierId?: string; name: string; priceDollars: string; capacity: string;
  saleStarts: OneOffDateTimeState; saleEnds: OneOffDateTimeState; soldCount: number;
}
// RN has no crypto.randomUUID (see EarningsPanel.tsx's mintRequestId, same
// timestamp+random nonce idiom): uniqueness for a local list key, not
// secrecy, is all this needs.
export const blankTierRow = (): TierRowState => ({
  key: `new-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9)}`, name: "General admission",
  priceDollars: "", capacity: "", saleStarts: emptyOneOffDateTime(), saleEnds: emptyOneOffDateTime(), soldCount: 0,
});
export const tierRowFrom = (id: string, t: TicketTierDoc): TierRowState => ({
  key: id, tierId: id, name: t.name, priceDollars: (t.priceCents / 100).toString(), capacity: String(t.capacity),
  saleStarts: t.saleStartsAt != null ? oneOffDateTimeFrom(t.saleStartsAt) : emptyOneOffDateTime(),
  saleEnds: t.saleEndsAt != null ? oneOffDateTimeFrom(t.saleEndsAt) : emptyOneOffDateTime(),
  soldCount: t.soldCount,
});

export function TierEditor({ curatorProfileId, eventId, eventStatus, initialTiers }: {
  curatorProfileId: string; eventId: string; eventStatus: EventStatus; initialTiers: TierRowState[];
}) {
  const t = useTokens();
  const [rows, setRows] = useState<TierRowState[]>(initialTiers.length > 0 ? initialTiers : [blankTierRow()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const isDraft = eventStatus === "draft";

  const update = (key: string, patch: Partial<TierRowState>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key));
  const add = () => setRows((prev) => [...prev, blankTierRow()]);

  const save = async () => {
    setError(null);
    setSaved(false);
    const tiers: SetEventTiersPayload["tiers"] = [];
    for (const r of rows) {
      const name = r.name.trim();
      if (!name) { setError("Every tier needs a name."); return; }
      const priceDollars = Number(r.priceDollars);
      if (r.priceDollars.trim() === "" || !Number.isFinite(priceDollars) || priceDollars < 0) {
        setError(`Enter a price for "${name}" (0 for free).`);
        return;
      }
      const capacity = Number(r.capacity);
      if (r.capacity.trim() === "" || !Number.isInteger(capacity) || capacity < 1) {
        setError(`Enter a whole-number capacity for "${name}".`);
        return;
      }
      tiers.push({
        tierId: r.tierId, name, priceCents: Math.round(priceDollars * 100), capacity,
        saleStartsAt: oneOffDateTimeToMs(r.saleStarts), saleEndsAt: oneOffDateTimeToMs(r.saleEnds),
      });
    }
    setBusy(true);
    try {
      await callFn<SetEventTiersPayload, { ok: true }>("setEventTiers", 
        { curatorProfileId, eventId, tiers });
      setSaved(true);
      // Refetch (one-shot, same idiom the web twin uses): picks up
      // server-assigned tier ids for brand-new rows plus the fresh
      // sortOrder/soldCount, so a second save in the same sitting upserts
      // against real ids instead of minting duplicate tiers.
      const snap = await getDocs(query(collection(getFirebase().db, `events/${eventId}/tiers`), orderBy("sortOrder")));
      setRows(snap.docs.map((d) => tierRowFrom(d.id, d.data() as TicketTierDoc)));
    } catch (e) {
      // Surfaced verbatim: setEventTiers' own rejections (deletion while
      // published, a capacity drop below soldCount, the 1-N tier count
      // bound) are already self-explanatory, specific server copy naming
      // the exact tier at fault (functions/src/events.ts).
      setError(e instanceof Error ? e.message : "Could not save ticket tiers.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: tokens.space.md }}>
      {rows.map((r) => (
        <Card key={r.key} style={{ gap: tokens.space.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
            <Input
              value={r.name} onChangeText={(v) => update(r.key, { name: v })}
              placeholder="Tier name" maxLength={40} accessibilityLabel="Tier name" style={{ flex: 1 }}
            />
            {/* Removal is unconditional for a NEW row (no tierId yet: nothing
                on the server to protect), and for an EXISTING row only while
                the event is still a draft, mirroring setEventTiers' own
                "tiers can only be removed while draft" gate exactly. */}
            {(!r.tierId || isDraft) && (
              <Button variant="ghost" onPress={() => remove(r.key)} accessibilityLabel={`Remove tier ${r.name || ""}`}>
                <IconTrash size={18} color={t.muted} />
              </Button>
            )}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm, flexWrap: "wrap" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text muted>$</Text>
              <Input
                keyboardType="decimal-pad" value={r.priceDollars} onChangeText={(v) => update(r.key, { priceDollars: v })}
                accessibilityLabel="Price" style={{ width: 90 }}
              />
            </View>
            <Input
              keyboardType="number-pad" value={r.capacity} onChangeText={(v) => update(r.key, { capacity: v })}
              placeholder="Capacity" accessibilityLabel="Capacity" style={{ width: 100 }}
            />
            {r.tierId && r.soldCount > 0 && <Text variant="meta" muted>{r.soldCount} sold</Text>}
          </View>
          <View style={{ gap: 4 }}>
            <Text variant="meta" muted>Sale starts (optional)</Text>
            <OneOffDateTimeFields value={r.saleStarts} onChange={(v) => update(r.key, { saleStarts: v })} />
          </View>
          <View style={{ gap: 4 }}>
            <Text variant="meta" muted>Sale ends (optional)</Text>
            <OneOffDateTimeFields value={r.saleEnds} onChange={(v) => update(r.key, { saleEnds: v })} />
          </View>
        </Card>
      ))}
      <Button variant="secondary" onPress={add}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.xs }}>
          <IconPlus size={16} color={t.text} />
          <Text variant="label">Add tier</Text>
        </View>
      </Button>
      <ErrorBanner message={error} />
      {saved && !error && <Text color={t.success}>Ticket tiers saved.</Text>}
      <Button title={busy ? "Saving…" : "Save ticket tiers"} disabled={busy} onPress={() => void save()} />
    </View>
  );
}

// ---------- Live sales stats (Task 12 anatomy: per-tier sold/capacity bars
// + a face-value total). Independent of TierEditor's own one-shot edit
// buffer above (which deliberately never re-syncs mid-edit, see its own
// header comment): this is a plain read-only projection, always fresh, so a
// sale landing while the curator is mid-edit still moves the numbers here.
// Mirrors web's EventsManager.tsx TierBars, extended with the money total
// the mobile brief asks for that web's list-row version doesn't show. ----------

type LiveTier = { id: string } & TicketTierDoc;

function useLiveTiers(eventId: string): LiveTier[] | "loading" {
  const [tiers, setTiers] = useState<LiveTier[] | "loading">("loading");
  useEffect(() => {
    const { db } = getFirebase();
    return onSnapshot(query(collection(db, `events/${eventId}/tiers`), orderBy("sortOrder")),
      (snap) => setTiers(snap.docs.map((d) => ({ id: d.id, ...(d.data() as TicketTierDoc) }))));
  }, [eventId]);
  return tiers;
}

// Bare per-tier sold/capacity bar rows, no wrapper: shared by TierBars
// (compact list row, mirrors web's EventsManager.tsx TierBars exactly) and
// TierSalesStats (the fuller management-screen version with a money total)
// below, so the two don't drift on the bar-rendering math.
function TierBarRows({ tiers }: { tiers: LiveTier[] }) {
  const t = useTokens();
  return (
    <View style={{ gap: tokens.space.xs }}>
      {tiers.map((tier) => {
        const pct = tier.capacity > 0 ? Math.min(100, Math.round((tier.soldCount / tier.capacity) * 100)) : 0;
        return (
          <View key={tier.id} style={{ gap: 2 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text variant="meta" muted numberOfLines={1} style={{ flex: 1 }}>{tier.name}</Text>
              <Text variant="meta" muted>{tier.soldCount}/{tier.capacity}</Text>
            </View>
            <View style={{ height: 6, borderRadius: tokens.radius.sm, backgroundColor: t.border, overflow: "hidden" }}>
              <View style={{ height: "100%", width: `${pct}%`, backgroundColor: t.accent }} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

// Compact, wrapper-less bars for the events index list row (Task 12: events
// index.tsx gains ticketed-event rows). RN twin of web's EventsManager.tsx
// TierBars.
export function TierBars({ eventId }: { eventId: string }) {
  const tiers = useLiveTiers(eventId);
  if (tiers === "loading" || tiers.length === 0) return null;
  return <TierBarRows tiers={tiers} />;
}

// The management screen's fuller version (Task 12 anatomy: per-tier
// sold/capacity bars + a face-value total, display only).
export function TierSalesStats({ eventId }: { eventId: string }) {
  const tiers = useLiveTiers(eventId);
  if (tiers === "loading" || tiers.length === 0) return null;
  const totalCents = tiers.reduce((sum, tier) => sum + tier.soldCount * tier.priceCents, 0);
  return (
    <Card style={{ gap: tokens.space.sm }}>
      <Text variant="label">Sales</Text>
      <TierBarRows tiers={tiers} />
      <Text variant="label">Total sold: {formatCents(totalCents)}</Text>
    </Card>
  );
}
