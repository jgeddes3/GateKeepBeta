import { useCallback, useEffect, useRef, useState } from "react";
import { View, FlatList, Image, Pressable, RefreshControl, ScrollView, StyleSheet, type ViewToken } from "react-native";
import { useRouter } from "expo-router";
import {
  DECK_MAX_EXCLUDE_IDS,
  type DeckCard,
  type EventDoc,
  type GetDiscoverDeckInput,
  type GetDiscoverDeckResult,
} from "@gatekeep/shared";
import { callFn } from "../lib/callable";
import { useAuth } from "../auth/AuthProvider";
import { useNow } from "../bookings/BookingThread";
import { gigLocationLabel } from "../bookings/BookingForms";
import { formatEventFullDate, formatEventTimeRange, posterPublicUrl } from "../events/eventDisplay";
import { useEventCache, useMyTickets } from "../tickets/TicketList";
import { DeckCardView } from "./DeckCards";
import { ShowsList } from "./ShowsList";
import { ArtistsList } from "./ArtistsList";
import { GenrePickerSheet, useGenrePickerGate } from "./GenrePickerSheet";
import { LocationPromptSheet } from "./LocationPromptSheet";
import { useDeckAudio } from "./useDeckAudio";
import { useDeckLocation, type DeckLocation } from "./useDeckLocation";
import {
  Text, Card, Chip, Button, ErrorBanner, SkeletonCard, PageBackground, PhotoPlaceholder,
  IconCompass, IconListBullets, IconMusicNotes, IconSpeakerHigh, IconSpeakerSlash, IconTicket,
} from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// SP7 Task 12: the Discover tab. A full-screen vertical deck of server-ranked
// show, artist, and venue cards, each with audio, and a List view one tap
// away (design spec section 6).
//
// State machine, in one place so the reading order matches the runtime order:
//
//   location resolving -> first page -> ready -> (paging | refresh | error)
//
//   1. useDeckLocation settles first: it reads the stored prompt flag and
//      the current permission, and if it opens the sheet, waits for the
//      answer. The first fetch is held until then so the opening page is
//      ranked with the fan's position instead of being fetched twice.
//   2. First page: getDiscoverDeck with no excludeIds and no seed; the
//      server picks the seed and every later page passes it back.
//   3. Paging: onViewableItemsChanged binds the visible card's audio, pushes
//      its id onto shownIds (capped at DECK_MAX_EXCLUDE_IDS, oldest dropped)
//      and, once the visible index is within 5 of the end, asks for the next
//      page. A page that comes back empty sets `exhausted` so the deck stops
//      asking; pull-to-refresh clears it along with the seed and the cards.
//   4. Error: the fetch that failed leaves whatever cards are already on
//      screen alone and shows a banner with Retry (an empty deck shows the
//      banner on its own).
//
// The one-page-per-request guard, the seed, the shown ids and the exhausted
// flag all live in refs rather than state: the viewability callback is
// registered once (FlatList treats a changing onViewableItemsChanged as a
// fatal error) and has to read the current values, not the ones captured on
// the render that created it.

const NEAR_END_CARDS = 5;
// Module scope, because FlatList treats a changing viewabilityConfig (or
// onViewableItemsChanged) as a fatal error.
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 50 };

function DeckControl({ icon, label, onPress, accessibilityLabel }: {
  icon: React.ReactNode; label?: string; onPress: () => void; accessibilityLabel: string;
}) {
  const t = useTokens();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => ({
        minHeight: 44,
        minWidth: 44,
        paddingHorizontal: label ? tokens.space.md : 0,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        borderRadius: tokens.radius.pill,
        // Solid surface, not glass: DESIGN.md's glass cap spends both of its
        // allowed uses on web (the landing nav and the mini-player).
        backgroundColor: t.surface,
        borderWidth: 1,
        borderColor: t.border,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {icon}
      {label && <Text variant="label">{label}</Text>}
    </Pressable>
  );
}

// Moved here from app/(fan)/index.tsx, which the deck now owns: the fan's
// own ticketed shows are the first thing in the List view's Shows tab, so
// nothing that screen used to show is lost. Derived from the same
// users/{uid}/tickets + event cache the Tickets tab already maintains, one
// row per event, live tickets only (a refunded or transferred-away ticket is
// no longer this fan's show to attend).
type UpcomingEvent = { eventId: string; event: EventDoc };

function useUpcomingTicketedEvents(uid: string | null): UpcomingEvent[] {
  const rows = useMyTickets(uid);
  const liveRows = rows === "loading" ? [] : rows.filter((t) => t.status === "valid" || t.status === "checked_in");
  const eventIds = [...new Set(liveRows.map((t) => t.eventId))];
  const eventCache = useEventCache(eventIds);
  const now = useNow();

  if (rows === "loading" || now == null) return [];
  const seen = new Set<string>();
  const out: UpcomingEvent[] = [];
  for (const t of liveRows) {
    if (seen.has(t.eventId)) continue;
    const load = eventCache[t.eventId];
    if (!load || load.kind !== "ok") continue;
    if (load.event.startsAt <= now) continue;
    seen.add(t.eventId);
    out.push({ eventId: t.eventId, event: load.event });
  }
  return out.sort((a, b) => a.event.startsAt - b.event.startsAt);
}

function UpcomingEventRow({ item, onPress }: { item: UpcomingEvent; onPress: () => void }) {
  const t = useTokens();
  const posterUrl = posterPublicUrl(item.event.posterPath);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={item.event.title}>
      <Card style={{ flexDirection: "row", gap: tokens.space.sm }}>
        <View style={{ width: 48, height: 48, borderRadius: tokens.radius.sm, overflow: "hidden", borderWidth: 1, borderColor: t.border }}>
          {posterUrl
            ? <Image source={{ uri: posterUrl }} style={{ width: "100%", height: "100%" }} />
            : <PhotoPlaceholder icon={<IconTicket size={18} color={t.muted} />} />}
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label" numberOfLines={1}>{item.event.title}</Text>
          <Text variant="meta" muted numberOfLines={1}>
            {formatEventFullDate(item.event.startsAt)} · {formatEventTimeRange(item.event.startsAt, item.event.endsAt)}
          </Text>
          <Text variant="meta" muted numberOfLines={1}>{gigLocationLabel(item.event.location)}</Text>
        </View>
      </Card>
    </Pressable>
  );
}

function UpcomingShows() {
  const { user } = useAuth();
  const router = useRouter();
  const upcoming = useUpcomingTicketedEvents(user?.uid ?? null);
  if (upcoming.length === 0) return null;
  return (
    <View style={{ gap: tokens.space.sm }}>
      <Text variant="title">Your upcoming shows</Text>
      {upcoming.map((item) => (
        <UpcomingEventRow
          key={item.eventId}
          item={item}
          onPress={() => router.push({ pathname: "/event/[eventId]", params: { eventId: item.eventId } })}
        />
      ))}
    </View>
  );
}

export function DeckScreen() {
  const t = useTokens();
  const { user } = useAuth();
  const audio = useDeckAudio();
  const location = useDeckLocation();
  const genreGate = useGenrePickerGate(user?.uid ?? null);

  const [cards, setCards] = useState<DeckCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"deck" | "list">("deck");
  const [listTab, setListTab] = useState<"shows" | "artists">("shows");
  const [cardHeight, setCardHeight] = useState(0);

  const seed = useRef<number | null>(null);
  const shownIds = useRef<string[]>([]);
  const knownIds = useRef<Set<string>>(new Set());
  const inFlight = useRef(false);
  const exhausted = useRef(false);
  const started = useRef(false);
  const visibleCard = useRef<DeckCard | null>(null);
  // One slot, consumed by the in-flight fetch's `finally`. A refresh (or the
  // re-rank when a position arrives) that lands mid-fetch used to be dropped
  // on the floor with the spinner still turning.
  const pendingReset = useRef(false);
  // Declared before loadPage because loadPage's own `finally` reaches for it
  // to run a queued reset; kept fresh, along with the audio handle and the
  // card count, by the effect below, for the viewability callback that is
  // registered once and can never see a later render's values.
  const loadPageRef = useRef<((reset: boolean) => Promise<void>) | null>(null);
  // Declared here, above loadPage, for the same reason loadPageRef is: the
  // reset branch below reaches for it to clear the audio hook's silent set.
  const audioRef = useRef(audio);

  const loadPage = useCallback(async (reset: boolean) => {
    if (inFlight.current) {
      if (reset) pendingReset.current = true;
      return;
    }
    if (!reset && exhausted.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      // `location: null` is rejected by the callable's own validation, so the
      // key is omitted entirely when there is no position. A reset asks for a
      // fresh deck: no exclusions, no seed, so the server picks a new one.
      const input: GetDiscoverDeckInput = {};
      if (location.location) input.location = location.location;
      if (!reset) {
        if (shownIds.current.length > 0) input.excludeIds = shownIds.current;
        if (seed.current != null) input.seed = seed.current;
      }
      const { data } = await callFn<GetDiscoverDeckInput, GetDiscoverDeckResult>("getDiscoverDeck", input);
      // Nothing above is cleared before the await: a refresh that fails
      // leaves the deck the fan was already swiping exactly as it was.
      seed.current = data.seed;
      if (reset) {
        shownIds.current = [];
        exhausted.current = false;
        visibleCard.current = null;
        // A fresh deck deserves a fresh try at every preview: a track that
        // failed once for a transient reason should not stay silent across a
        // refresh the fan asked for.
        audioRef.current.clearSilent();
        knownIds.current = new Set(data.cards.map((c) => c.id));
        setCards(data.cards);
        if (data.cards.length === 0) exhausted.current = true;
      } else {
        // The server only excludes ids the fan has actually seen, so a card
        // still sitting unseen in the list can come back in the next page.
        // Dropping the repeat here also keeps FlatList keys unique, and a
        // page that adds nothing new means the deck has run out.
        const fresh = data.cards.filter((c) => !knownIds.current.has(c.id));
        if (fresh.length === 0) exhausted.current = true;
        else {
          for (const c of fresh) knownIds.current.add(c.id);
          setCards((prev) => [...prev, ...fresh]);
        }
      }
      setError(null);
    } catch (e) {
      // Never the raw callable message: it is a server string, and the fan
      // can do nothing with "internal".
      console.warn("deck: getDiscoverDeck failed", e);
      setError(reset ? "Could not load the deck. Try again." : "Could not load more shows. Try again.");
    } finally {
      inFlight.current = false;
      setLoading(false);
      if (pendingReset.current) {
        pendingReset.current = false;
        // The spinner keeps turning through the queued reset, hence no
        // setRefreshing(false) on this branch.
        void loadPageRef.current?.(true);
      } else {
        setRefreshing(false);
      }
    }
  }, [location.location]);

  const cardCount = useRef(0);
  useEffect(() => {
    loadPageRef.current = loadPage;
    audioRef.current = audio;
    cardCount.current = cards.length;
  });

  // The first page, and one more if a position arrives later: the fan can
  // still grant location from the empty state's "Turn on location", and the
  // deck that was ranked without distances has to be re-ranked with them.
  // useDeckLocation only ever builds one object per fix, so identity is a
  // fair "same position" test.
  const rankedFor = useRef<DeckLocation | null>(null);
  useEffect(() => {
    if (location.resolving) return;
    if (started.current && rankedFor.current === location.location) return;
    started.current = true;
    rankedFor.current = location.location;
    void loadPage(true);
  }, [location.resolving, location.location, loadPage]);

  const onViewableItemsChanged = useCallback((info: { viewableItems: ViewToken[] }) => {
    const first = info.viewableItems.find((v) => v.isViewable);
    if (!first) return;
    const card = first.item as DeckCard;
    visibleCard.current = card;
    audioRef.current.bind(card);
    if (!shownIds.current.includes(card.id)) {
      shownIds.current.push(card.id);
      if (shownIds.current.length > DECK_MAX_EXCLUDE_IDS) {
        shownIds.current = shownIds.current.slice(-DECK_MAX_EXCLUDE_IDS);
      }
    }
    if ((first.index ?? 0) >= cardCount.current - NEAR_END_CARDS) void loadPageRef.current?.(false);
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void loadPage(true);
  }, [loadPage]);

  // One element for both scrollers below (only ever one of them is mounted),
  // and a memoized row so a deck-level state change does not rebuild every
  // full-screen card.
  const refreshControl = (
    <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.muted} colors={[t.accent]} />
  );
  const renderItem = useCallback(
    ({ item }: { item: DeckCard }) => <DeckCardView card={item} height={cardHeight} />,
    [cardHeight],
  );

  const openList = () => {
    audio.stop();
    setView("list");
  };

  const openDeck = () => {
    setView("deck");
    audio.bind(visibleCard.current);
  };

  // The location sheet and the genre picker never share the screen: the
  // picker waits until the location answer is in (design spec section 6).
  const genrePickerVisible = !location.promptVisible && !location.resolving && genreGate.shouldShow;
  const listHidden = view === "list";

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />

      <View
        style={{ flex: 1 }}
        accessibilityElementsHidden={listHidden}
        importantForAccessibility={listHidden ? "no-hide-descendants" : "auto"}
        onLayout={(e) => setCardHeight(e.nativeEvent.layout.height)}
      >
        {cardHeight > 0 && cards.length > 0 && (
          <FlatList
            data={cards}
            keyExtractor={(card) => card.id}
            renderItem={renderItem}
            getItemLayout={(_, index) => ({ length: cardHeight, offset: cardHeight * index, index })}
            pagingEnabled
            snapToInterval={cardHeight}
            decelerationRate="fast"
            showsVerticalScrollIndicator={false}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={VIEWABILITY_CONFIG}
            initialNumToRender={2}
            maxToRenderPerBatch={3}
            windowSize={3}
            refreshControl={refreshControl}
          />
        )}

        {cards.length === 0 && (
          <ScrollView
            contentContainerStyle={{ flexGrow: 1, padding: tokens.space.lg, justifyContent: "center", gap: tokens.space.lg }}
            refreshControl={refreshControl}
          >
            {loading && !error && (
              <View style={{ gap: tokens.space.md }}>
                <SkeletonCard />
                <Text variant="meta" muted style={{ textAlign: "center" }}>
                  {location.location ? "Finding shows near you" : "Finding shows"}
                </Text>
              </View>
            )}
            {error && (
              <View style={{ gap: tokens.space.md }}>
                <ErrorBanner message={error} />
                <Button title="Retry" variant="secondary" onPress={() => void loadPage(true)} style={{ alignSelf: "flex-start" }} />
              </View>
            )}
            {!loading && !error && (
              <View style={{ alignItems: "center", gap: tokens.space.md }}>
                <IconMusicNotes size={48} color={t.muted} />
                <Text variant="heading" style={{ textAlign: "center" }}>Nothing to show yet</Text>
                <Text muted style={{ textAlign: "center" }}>
                  {location.location
                    ? "Follow a few genres and check back."
                    : "Follow a few genres and check back, or turn on location."}
                </Text>
                {!location.location && (
                  <Button title="Turn on location" variant="secondary" onPress={() => void location.enable()} />
                )}
              </View>
            )}
          </ScrollView>
        )}

        {/* A fetch that failed with cards already on screen keeps the deck
            swipeable and puts the banner over the bottom of the card. */}
        {error && cards.length > 0 && (
          <View style={{ position: "absolute", left: tokens.space.lg, right: tokens.space.lg, bottom: tokens.space.lg, gap: tokens.space.sm }}>
            <ErrorBanner message={error} />
            <Button title="Retry" variant="secondary" onPress={() => void loadPage(false)} style={{ alignSelf: "flex-start" }} />
          </View>
        )}

        <View style={{
          position: "absolute", top: tokens.space.lg, left: tokens.space.lg, right: tokens.space.lg,
          flexDirection: "row", justifyContent: "space-between",
        }}>
          <DeckControl
            icon={<IconListBullets size={18} color={t.text} />}
            label="List"
            onPress={openList}
            accessibilityLabel="Switch to the shows and artists lists"
          />
          <DeckControl
            icon={audio.muted
              ? <IconSpeakerSlash size={18} color={t.text} />
              : <IconSpeakerHigh size={18} color={t.text} />}
            onPress={audio.toggleMute}
            accessibilityLabel={audio.muted ? "Unmute previews" : "Mute previews"}
          />
        </View>
      </View>

      {view === "list" && (
        <View style={StyleSheet.absoluteFill}>
          <PageBackground />
          <View style={{
            flexDirection: "row", alignItems: "center", justifyContent: "space-between",
            paddingHorizontal: tokens.space.lg, paddingTop: tokens.space.lg, paddingBottom: tokens.space.sm,
          }}>
            <View style={{ flexDirection: "row", gap: tokens.space.sm }}>
              <Chip label="Shows" active={listTab === "shows"} onPress={() => setListTab("shows")} />
              <Chip label="Artists" active={listTab === "artists"} onPress={() => setListTab("artists")} />
            </View>
            <DeckControl
              icon={<IconCompass size={18} color={t.text} />}
              label="Deck"
              onPress={openDeck}
              accessibilityLabel="Back to the deck"
            />
          </View>
          <ScrollView contentContainerStyle={{ padding: tokens.space.lg, gap: tokens.space.lg }}>
            {listTab === "shows" ? <><UpcomingShows /><ShowsList /></> : <ArtistsList />}
          </ScrollView>
        </View>
      )}

      <LocationPromptSheet state={location} />

      <GenrePickerSheet visible={genrePickerVisible} onClose={() => void genreGate.markSeen()} />
    </View>
  );
}
