import { useEffect, useState } from "react";
import { ScrollView, View, Image, Pressable } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { doc, getDoc, getDocs, collection, query, orderBy } from "firebase/firestore";
import {
  DEFAULT_TICKET_FEE_POLICY, ticketOrderTotals, SALES_FINAL_LINE,
  EVENT_SOLD_OUT_MESSAGE, EVENT_SALE_CLOSED_MESSAGE, EVENT_BUYER_CAP_MESSAGE, EVENT_NOT_ON_SALE_MESSAGE,
  type EventAct, type EventDoc, type ProfileDoc, type TicketOrderStatus, type TicketTierDoc,
} from "@gatekeep/shared";
import { getFirebase } from "../../src/lib/firebase";
import { callFn } from "../../src/lib/callable";
import { useNow } from "../../src/bookings/BookingThread";
import { gigLocationLabel } from "../../src/bookings/BookingForms";
import {
  formatCents, formatEventFullDate, formatEventTimeRange, formatTierPrice, tierFeeLine, tierAvailability,
  TIER_AVAILABILITY_LABEL, eventSalesClosedReason, posterPublicUrl,
} from "../../src/events/eventDisplay";
import { stripeEnabled, runPaymentSheet, sheetAppearanceFromTokens } from "../../src/payments/stripe";
import { PostPurchaseGenrePrompt } from "../../src/discover/GenrePickerSheet";
import { ShowPostsForAct } from "../../src/discover/ShowPosts";
import { ShareButton } from "../../src/share/ShareButton";
import {
  Text, Button, Card, Callout, ErrorBanner, PageBackground, PhotoPlaceholder, Skeleton, SkeletonCard,
  IconTicket, IconMapPin, IconMinus, IconPlus,
} from "../../src/ui";
import { useTokens } from "../../src/theme/ThemeProvider";
import { tokens } from "../../src/theme/tokens";

// Sub-project 6 task 11: the fan event detail + buy screen, RN twin of
// apps/web/app/e/[eventId]/EventPageClient.tsx + src/events/BuyTicketsFlow.tsx
// combined into one screen (mobile has no server/client split to keep them
// apart). Every screen in this app requires sign-in already (app/_layout.tsx's
// Gate() redirects a signed-out user to (auth)/sign-in before any route
// outside that group ever mounts), so unlike the web flow this never needs
// its own "sign in to buy tickets" branch or state.
//
// Tier picker anatomy (brief, binding): "Cards with radio selection", not
// web's per-tier quantity stepper cart. A fan picks exactly ONE tier, then a
// quantity stepper appears for it, producing a single-line-item
// createTicketOrder call. Simpler than web's multi-line-item cart and a
// better fit for a phone screen; the callable itself is unchanged (items is
// still an array, just always length 1 here).
//
// Money invariant: totals are computed via the SAME shared
// ticketOrderTotals/DEFAULT_TICKET_FEE_POLICY the server and web both use,
// never hand-rolled, so a fee-policy change can't silently drift the preview
// shown here from what createTicketOrder actually charges.

const MAX_QTY_PER_LINE_ITEM = 10;

type TierRow = { id: string } & TicketTierDoc;
// profileId (SP7 Task 13, additive): a booking act's own musicianProfileId,
// carried through so the Lineup section below can mount ShowPostsForAct per
// row without a second lookup. null for an external act (no profile to post
// through).
type LineupEntry = { name: string; handle: string | null; profileId: string | null };
type Loaded = { event: EventDoc; posterUrl: string | null; curatorName: string; tiers: TierRow[]; lineup: LineupEntry[] };

interface CreateTicketOrderResult { orderId: string; clientSecret: string | null; }
interface FinalizeTicketOrderResult { orderStatus: TicketOrderStatus; }

type Phase = "idle" | "creating" | "confirm" | "finalizing" | "done";

// Batched lineup-handle lookup, mirrors app/e/[eventId]/page.tsx's own
// resolveLineup exactly (n+1-avoidance over the UNIQUE booking
// musicianProfileIds; only the handle is resolved, a "booking" act already
// carries its own name snapshot).
async function resolveLineup(
  db: ReturnType<typeof getFirebase>["db"], lineup: EventAct[],
): Promise<LineupEntry[]> {
  const bookingIds = [...new Set(
    lineup.filter((a): a is Extract<EventAct, { kind: "booking" }> => a.kind === "booking")
      .map((a) => a.musicianProfileId))];
  const handles = new Map<string, string | null>();
  await Promise.all(bookingIds.map(async (id) => {
    try {
      const snap = await getDoc(doc(db, "profiles", id));
      handles.set(id, snap.exists() ? ((snap.data() as ProfileDoc).handle ?? null) : null);
    } catch (e) {
      const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
      if (code !== "permission-denied" && code !== "not-found") console.warn("resolveLineup failed", id, e);
      handles.set(id, null);
    }
  }));
  return lineup.map((act) => act.kind === "booking"
    ? { name: act.name, handle: handles.get(act.musicianProfileId) ?? null, profileId: act.musicianProfileId }
    : { name: act.name, handle: null, profileId: null });
}

function TierCard({ tier, now, selected, quantity, onSelect, onQuantityChange, disabled }: {
  tier: TierRow; now: number; selected: boolean; quantity: number;
  onSelect: () => void; onQuantityChange: (qty: number) => void; disabled: boolean;
}) {
  const t = useTokens();
  const availability = tierAvailability(tier, now);
  const remaining = tier.capacity - tier.soldCount;
  const max = Math.min(MAX_QTY_PER_LINE_ITEM, Math.max(remaining, 0));
  const canPick = availability === "on_sale" && !disabled;
  const feeLine = tierFeeLine(tier.priceCents, DEFAULT_TICKET_FEE_POLICY);

  return (
    <Pressable
      onPress={canPick ? onSelect : undefined}
      disabled={!canPick}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: !canPick }}
      accessibilityLabel={tier.name}
      style={{ opacity: canPick ? 1 : 0.55 }}
    >
      <Card style={{ gap: tokens.space.sm, borderColor: selected ? t.accent : t.border, borderWidth: selected ? 2 : 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
          <View style={{ flex: 1 }}>
            <Text variant="label">{tier.name}</Text>
            <Text variant="meta" muted>
              {formatTierPrice(tier.priceCents)}{feeLine ? ` · ${feeLine}` : ""}
            </Text>
            {availability !== "on_sale" && (
              <Text variant="meta" muted style={{ marginTop: 4 }}>{TIER_AVAILABILITY_LABEL[availability]}</Text>
            )}
          </View>
          <View style={{
            width: 22, height: 22, borderRadius: 11, borderWidth: 2,
            borderColor: selected ? t.accent : t.border, alignItems: "center", justifyContent: "center",
          }}>
            {selected && <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: t.accent }} />}
          </View>
        </View>
        {selected && canPick && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.sm }}>
            {/* Floor of 1 while a tier is selected (fix round 1, review
                finding): the minus button used to let quantity reach 0 with
                the tier still visually selected and the stepper still
                shown, a dead-end the radio dot's own on/off semantics don't
                explain. Deselecting is the radio's job (tap another tier,
                or this one again reselects nothing since selectTier only
                switches tiers); the stepper stays within the 1..10 framing
                its own max clamp already documents. */}
            <Pressable
              onPress={() => onQuantityChange(Math.max(1, quantity - 1))}
              disabled={quantity <= 1}
              accessibilityRole="button"
              accessibilityLabel={`Fewer ${tier.name} tickets`}
              style={{
                width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: t.border,
                alignItems: "center", justifyContent: "center", opacity: quantity <= 1 ? 0.4 : 1,
              }}
            >
              <IconMinus size={16} color={t.text} />
            </Pressable>
            <Text variant="label" style={{ width: 24, textAlign: "center" }}>{quantity}</Text>
            <Pressable
              onPress={() => onQuantityChange(Math.min(max, quantity + 1))}
              disabled={quantity >= max}
              accessibilityRole="button"
              accessibilityLabel={`More ${tier.name} tickets`}
              style={{
                width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: t.border,
                alignItems: "center", justifyContent: "center", opacity: quantity >= max ? 0.4 : 1,
              }}
            >
              <IconPlus size={16} color={t.text} />
            </Pressable>
          </View>
        )}
      </Card>
    </Pressable>
  );
}

export default function EventScreen() {
  const { eventId: rawEventId } = useLocalSearchParams<{ eventId: string }>();
  const eventId = rawEventId ?? "";
  const router = useRouter();
  const t = useTokens();
  const now = useNow();

  const [state, setState] = useState<"loading" | "notfound" | Loaded>("loading");
  // Render-time reset (React's documented "adjust state while rendering"
  // pattern, same idiom app/artist/[handle].tsx's own lastHandle uses): if
  // this screen instance is ever reused across an eventId change, the fetch
  // effect below (keyed on eventId) wouldn't reset `state` until it runs,
  // after paint, which would flash the PREVIOUS event's content under the
  // new id for a frame.
  const [lastEventId, setLastEventId] = useState(eventId);
  if (eventId !== lastEventId) {
    setLastEventId(eventId);
    setState("loading");
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { db } = getFirebase();
        const eventSnap = await getDoc(doc(db, "events", eventId)); // rules deny unless published/completed (or member/admin)
        if (!eventSnap.exists()) { if (!cancelled) setState("notfound"); return; }
        const event = eventSnap.data() as EventDoc;
        const [curatorSnap, tiersSnap, lineup] = await Promise.all([
          getDoc(doc(db, "profiles", event.curatorProfileId)),
          getDocs(query(collection(db, `events/${eventId}/tiers`), orderBy("sortOrder"))),
          resolveLineup(db, event.lineup),
        ]);
        const posterUrl = posterPublicUrl(event.posterPath);
        const curator = curatorSnap.exists() ? (curatorSnap.data() as ProfileDoc) : null;
        const tiers: TierRow[] = tiersSnap.docs.map((d) => ({ id: d.id, ...(d.data() as TicketTierDoc) }));
        if (!cancelled) setState({ event, posterUrl, curatorName: curator?.name ?? "Unknown", tiers, lineup });
      } catch (e) {
        // permission-denied = the event isn't published/completed (and this
        // fan isn't a member/admin): a legitimate not-found, matching web's
        // loadEvent. Anything else still lands on the same not-found screen
        // (this app has no separate error route), but is logged.
        const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
        if (code !== "permission-denied") console.error("event screen load failed", eventId, e);
        if (!cancelled) setState("notfound");
      }
    })();
    return () => { cancelled = true; };
  }, [eventId]);

  // Live tier snapshot, seeded once from the initial load then refreshed in
  // place after a sold-out/sale-closed rejection (refetchTiers below),
  // mirroring BuyTicketsFlow.tsx's own liveTiers/refetchTiers split.
  const [liveTiers, setLiveTiers] = useState<TierRow[] | null>(null);
  if (state !== "loading" && state !== "notfound" && liveTiers === null) {
    setLiveTiers(state.tiers);
  }

  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [orderId, setOrderId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [orderStatus, setOrderStatus] = useState<TicketOrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [purchasedQty, setPurchasedQty] = useState(0);
  const [paymentConfirmed, setPaymentConfirmed] = useState(false);
  const [keylessBlocked, setKeylessBlocked] = useState(false);

  if (state === "loading" || now == null) {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.md }}>
          <Skeleton height={220} radius={tokens.radius.card} />
          <Skeleton height={26} width="70%" />
          <Skeleton height={16} width="50%" />
          <SkeletonCard />
        </ScrollView>
      </View>
    );
  }
  if (state === "notfound") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: 6 }}>
          <Text variant="title">Event not found</Text>
          <Text muted style={{ textAlign: "center" }}>This event isn&apos;t available anymore.</Text>
        </View>
      </View>
    );
  }

  const { event, posterUrl, curatorName, lineup } = state;
  const tiers = liveTiers ?? state.tiers;
  const feePolicy = DEFAULT_TICKET_FEE_POLICY;
  const selectedTier = tiers.find((tr) => tr.id === selectedTierId) ?? null;
  const totals = selectedTier && quantity > 0
    ? ticketOrderTotals([{ tierId: selectedTier.id, quantity, unitPriceCents: selectedTier.priceCents, tierName: selectedTier.name }], feePolicy)
    : { faceTotalCents: 0, serviceFeeCents: 0 };
  const totalCents = totals.faceTotalCents + totals.serviceFeeCents;
  const unavailable = eventSalesClosedReason(event.status, event.startsAt, now);

  const selectTier = (tierId: string) => {
    if (selectedTierId !== tierId) { setSelectedTierId(tierId); setQuantity(1); }
  };

  // Fix-round-1-equivalent guard (mirrors BuyTicketsFlow.tsx's own
  // refetchTiers): a one-shot live read of the tier docs after a
  // sold-out/sale-closed rejection, so the picker's own badges catch up to
  // what the server just proved, and clamps the selected quantity down to
  // fresh remaining capacity so the very next attempt doesn't draw the same
  // rejection.
  const refetchTiers = async () => {
    try {
      const snap = await getDocs(query(collection(getFirebase().db, `events/${eventId}/tiers`), orderBy("sortOrder")));
      const fresh: TierRow[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as TicketTierDoc) }));
      setLiveTiers(fresh);
      const tier = fresh.find((tr) => tr.id === selectedTierId);
      if (tier) {
        const max = Math.min(MAX_QTY_PER_LINE_ITEM, Math.max(tier.capacity - tier.soldCount, 0));
        setQuantity((q) => Math.min(q, max));
      }
    } catch (e) {
      console.error("refetchTiers failed", eventId, e);
    }
  };

  const resetPurchase = () => {
    setPhase("idle"); setOrderId(null); setClientSecret(null); setError(null);
    setPaymentConfirmed(false); setKeylessBlocked(false);
  };

  // Buyer-side release (sp6 audit finding 2), same best-effort shape as web's
  // cancelOrder: the local reset happens regardless of the call's outcome.
  const cancelOrder = async (orderIdArg: string | null) => {
    try {
      if (orderIdArg) await callFn("cancelTicketOrder", { orderId: orderIdArg });
    } catch (e) {
      console.warn("cancelTicketOrder failed, the expiry job releases the hold", orderIdArg, e);
    } finally {
      resetPurchase();
    }
  };

  const finalize = async (orderIdArg: string) => {
    setPhase("finalizing");
    try {
      const res = await callFn<{ orderId: string }, FinalizeTicketOrderResult>("finalizeTicketOrder", { orderId: orderIdArg });
      setOrderStatus(res.data.orderStatus);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not confirm your order.");
      setPhase("confirm");
    }
  };

  // The native PaymentSheet IS the interactive confirm step (unlike web's
  // inline Elements mount, no separate "tap to pay" screen is needed here):
  // presenting it, waiting on the result, and finalizing all happen in one
  // call chain.
  const runSheetFlow = async (secret: string, orderIdArg: string) => {
    const outcome = await runPaymentSheet(secret, sheetAppearanceFromTokens(t));
    if (outcome.ok) {
      setPaymentConfirmed(true);
      await finalize(orderIdArg);
      return;
    }
    if (outcome.cancelled) {
      // A swiped-away sheet used to leave the hold in place for the TTL
      // sweep to find; now it is released immediately (sp6 audit finding 2).
      await cancelOrder(orderIdArg);
      return;
    }
    setError(outcome.message ?? "Could not complete the payment.");
    // Stays on "confirm" so the buyer can retry the SAME order/PaymentIntent.
  };

  const startPurchase = async () => {
    if (phase !== "idle") return;
    if (!selectedTier || quantity <= 0) return;
    setError(null);
    setPhase("creating");
    try {
      const res = await callFn<{ eventId: string; items: { tierId: string; quantity: number }[] }, CreateTicketOrderResult>("createTicketOrder", { eventId, items: [{ tierId: selectedTier.id, quantity }] });
      setOrderId(res.data.orderId);
      setPurchasedQty(quantity);
      if (!res.data.clientSecret) {
        setOrderStatus("paid");
        setPhase("done");
        return;
      }
      setClientSecret(res.data.clientSecret);
      // Keyless emulator dev: a paid tier's clientSecret is a real FakeStripe
      // secret (createTicketOrder does NOT auto-complete a nonzero order the
      // way createSetupIntent/payPastDue do), but no working sheet can run
      // without a publishable key. Mirrors PayPastDueButton.tsx's own
      // defensive branch rather than calling runPaymentSheet blind.
      if (!stripeEnabled) {
        setKeylessBlocked(true);
        setPhase("confirm");
        return;
      }
      setPhase("confirm");
      await runSheetFlow(res.data.clientSecret, res.data.orderId);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not start checkout.";
      setError(message);
      setPhase("idle");
      // Branch on the exact shared-message strings clients are meant to
      // compare with === (packages/shared/src/messages.ts's own header).
      if (message === EVENT_SOLD_OUT_MESSAGE || message === EVENT_SALE_CLOSED_MESSAGE) {
        void refetchTiers();
      } else if (message === EVENT_BUYER_CAP_MESSAGE || message === EVENT_NOT_ON_SALE_MESSAGE) {
        console.info("createTicketOrder rejected", message);
      }
    }
  };

  if (phase === "done") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, padding: tokens.space.lg, justifyContent: "center", gap: tokens.space.md }}>
          {orderStatus === "paid" && (
            <Callout tone="success">
              <Text variant="label">You&apos;re in.</Text>
              <Text>{purchasedQty} ticket{purchasedQty === 1 ? "" : "s"} confirmed.</Text>
              <Button title="View your tickets" onPress={() => router.push("/(fan)/tickets")} style={{ marginTop: tokens.space.sm, alignSelf: "flex-start" }} />
              {/* SP7 Task 11: the genre-picker nudge lives ONLY inside this
                  paid-done branch, never in the buy flow itself (binding
                  rule). event.genres is optional on pre-SP7 docs; `?? []`
                  treats an absent projection the same as "no preselection". */}
              <PostPurchaseGenrePrompt eventGenres={event.genres ?? []} />
            </Callout>
          )}
          {orderStatus === "pending" && (
            <Callout tone="warning">
              <Text variant="label">Still processing</Text>
              <Text>Your payment is still processing. Check the Tickets tab in a moment.</Text>
              <Button variant="secondary" title="Go to your tickets" onPress={() => router.push("/(fan)/tickets")} style={{ marginTop: tokens.space.sm, alignSelf: "flex-start" }} />
            </Callout>
          )}
          {orderStatus !== "paid" && orderStatus !== "pending" && (
            <View style={{ gap: tokens.space.sm }}>
              <ErrorBanner message="This order could not be completed. Try again." />
              <Button variant="secondary" title="Try again" onPress={resetPurchase} style={{ alignSelf: "flex-start" }} />
            </View>
          )}
        </View>
      </View>
    );
  }

  if (phase === "confirm" || phase === "finalizing") {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, padding: tokens.space.lg, justifyContent: "center", gap: tokens.space.md }}>
          {keylessBlocked ? (
            <>
              <Callout tone="neutral">
                <Text>
                  This build has no live payment key set, so a paid ticket can&apos;t finish here. Free tiers still
                  work end to end.
                </Text>
              </Callout>
              <Button variant="secondary" title="Back" onPress={resetPurchase} style={{ alignSelf: "flex-start" }} />
            </>
          ) : phase === "finalizing" ? (
            <Text muted>Confirming your order…</Text>
          ) : paymentConfirmed ? (
            <>
              {error && <ErrorBanner message={error} />}
              <Text muted>Your payment went through. We just need to confirm the order.</Text>
              <Button title="Try again" onPress={() => void finalize(orderId!)} style={{ alignSelf: "flex-start" }} />
            </>
          ) : (
            <>
              {error ? (
                <>
                  <ErrorBanner message={error} />
                  <Button title="Try payment again" onPress={() => void runSheetFlow(clientSecret!, orderId!)} style={{ alignSelf: "flex-start" }} />
                  <Button variant="secondary" title="Cancel" onPress={() => void cancelOrder(orderId)} style={{ alignSelf: "flex-start" }} />
                </>
              ) : (
                <Text muted>Opening the payment sheet…</Text>
              )}
            </>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.lg, paddingBottom: tokens.space.xl }}>
        <View style={{ height: 200, borderRadius: tokens.radius.card, overflow: "hidden", borderWidth: 1, borderColor: t.border }}>
          {posterUrl ? (
            <Image source={{ uri: posterUrl }} style={{ width: "100%", height: "100%" }} />
          ) : (
            <PhotoPlaceholder icon={<IconTicket size={36} color={t.muted} />} />
          )}
        </View>

        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: tokens.space.sm }}>
          <View style={{ gap: 4, flex: 1 }}>
            <Text variant="heading">{event.title}</Text>
            <Text variant="label">{formatEventTimeRange(event.startsAt, event.endsAt)}</Text>
            <Text muted>{formatEventFullDate(event.startsAt)}</Text>
          </View>
          {/* SP11 (spec 3.1): the shared share affordance, hidden when
              EXPO_PUBLIC_SITE_URL is unset. */}
          <ShareButton path={`/e/${eventId}`} title={event.title} />
        </View>

        <Card style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", gap: tokens.space.xs, alignItems: "center" }}>
            <IconMapPin size={18} color={t.muted} />
            <View style={{ flex: 1 }}>
              <Text variant="label">{curatorName}</Text>
              <Text muted>{gigLocationLabel(event.location)}</Text>
            </View>
          </View>
        </Card>

        {lineup.length > 0 && (
          <View style={{ gap: tokens.space.md }}>
            <Text variant="title">Lineup</Text>
            {lineup.map((act, i) => (
              <View key={`${act.name}-${i}`} style={{ gap: tokens.space.xs }}>
                {act.handle ? (
                  <Text
                    style={{ textDecorationLine: "underline" }}
                    onPress={() => router.push({ pathname: "/artist/[handle]", params: { handle: act.handle! } })}
                  >
                    {act.name}
                  </Text>
                ) : (
                  <Text>{act.name}</Text>
                )}
                {/* SP7 Task 13: a booking act (one with a real profileId) also
                    gets its own show-post thread; an external act (no
                    profile to post through) stays plain text. */}
                {act.profileId && (
                  <ShowPostsForAct
                    eventId={eventId} musicianProfileId={act.profileId} artistName={act.name} endsAt={event.endsAt}
                  />
                )}
              </View>
            ))}
          </View>
        )}

        {event.description ? (
          <View style={{ gap: tokens.space.xs }}>
            <Text variant="title">About</Text>
            <Text style={{ lineHeight: 21 }}>{event.description}</Text>
          </View>
        ) : null}

        <View style={{ gap: tokens.space.sm, borderTopWidth: 1, borderTopColor: t.border, paddingTop: tokens.space.md }}>
          <Text variant="title">Tickets</Text>
          {unavailable && <Callout tone="warning"><Text color={t.warning}>{unavailable}</Text></Callout>}
          {error && <ErrorBanner message={error} />}
          {tiers.length === 0 ? (
            <Text muted>No ticket tiers are set up for this event yet.</Text>
          ) : (
            <View style={{ gap: tokens.space.sm }}>
              {tiers.map((tier) => (
                <TierCard
                  key={tier.id}
                  tier={tier}
                  now={now}
                  selected={selectedTierId === tier.id}
                  quantity={selectedTierId === tier.id ? quantity : 0}
                  onSelect={() => selectTier(tier.id)}
                  onQuantityChange={setQuantity}
                  disabled={!!unavailable || phase !== "idle"}
                />
              ))}
            </View>
          )}
          {quantity > 0 && (
            <View style={{ gap: 2 }}>
              <Text variant="meta" muted>{quantity} ticket{quantity === 1 ? "" : "s"}</Text>
              <Text variant="label">Order total: {formatCents(totalCents)}</Text>
            </View>
          )}
          {/* The native PaymentSheet is the Pay step, so the sales-final line
              sits above the button that opens it; a free tier never opens a
              sheet and never charges, so it gets no money sentence. */}
          {selectedTier && selectedTier.priceCents > 0 && quantity > 0 && (
            <Text variant="meta" muted>{SALES_FINAL_LINE}</Text>
          )}
          <Button
            onPress={() => void startPurchase()}
            disabled={!selectedTier || quantity <= 0 || !!unavailable || phase !== "idle"}
          >
            <Text variant="label" color={t.onAccent}>
              {phase === "creating" ? "Starting…" : selectedTier?.priceCents === 0 ? "RSVP" : "Buy tickets"}
            </Text>
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}
