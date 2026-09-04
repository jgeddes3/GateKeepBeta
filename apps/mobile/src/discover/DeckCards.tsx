import { memo, type ReactNode } from "react";
import { View, Pressable, Image } from "react-native";
import { useRouter } from "expo-router";
import { distanceLabel, type DeckCard, type DeckNextShow, type DeckPreview } from "@gatekeep/shared";
import { publicStorageUrl } from "./storageUrl";
import { FollowButton } from "./FollowButton";
import { formatChipLabel } from "./discoverQueries";
import {
  formatCents, formatEventFullDate, formatEventShortDate, formatEventTimeRange, posterPublicUrl,
} from "../events/eventDisplay";
import {
  Text, Card, Badge, Button, PhotoScrim, PhotoPlaceholder,
  IconMapPin, IconMusicNotes, IconSpeakerSlash, IconTicket, IconUserCircle, IconImages,
} from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// SP7 Task 12: the three faces of the swipe deck. One anatomy, three fills
// (DESIGN.md dial RHYTHM 2: one component system, deliberate variation
// inside it):
//
//   photo region, flexing to fill whatever the text block leaves
//     - poster / cover / venue photo, or the branded PhotoPlaceholder
//     - PhotoScrim over the photo ONLY, never over the card surface
//     - the preview line, bottom-left, over the scrim: the one motif every
//       card repeats, naming the act the fan is currently hearing (or
//       saying plainly that this card is silent)
//   text block on the solid card surface (never glass, DESIGN.md's glass cap)
//     - title, the lines that card kind actually has, then one action row
//
// Accent dosage (DESIGN.md): exactly one ember element per card, always the
// primary action, always the ticket. Follow is the bordered secondary
// treatment FollowButton already ships, badges and icons stay neutral.
//
// Photos resolve through publicStorageUrl, never getDownloadURL: a deck
// page is about 20 cards and each getDownloadURL is a network round trip
// for an object storage.rules already serves unauthenticated.

// The photo's floor, not its size: it takes every point the text block does
// not want and gives space back before the text does. On a short screen at a
// large accessibility text size it can go all the way down to this, and the
// text block clips a line rather than pushing the action row off the card.
const PHOTO_MIN_HEIGHT = 88;

function PreviewLine({ preview }: { preview: DeckPreview }) {
  // Always on the scrim, so both themes use the dark-theme foreground here
  // (the scrim is the night gradient in light mode too, per tokens.ts).
  const color = tokens.dark.text;
  if (!preview) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <IconSpeakerSlash size={16} color={color} />
        <Text variant="meta" color={color}>No preview yet</Text>
      </View>
    );
  }
  return (
    <View
      accessible
      accessibilityLabel={`Preview track by ${preview.artistName}`}
      style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
    >
      <IconMusicNotes size={16} color={color} />
      <Text variant="meta" color={color} numberOfLines={1} style={{ flex: 1 }}>{preview.artistName}</Text>
    </View>
  );
}

// One node carries the photo's flex, its floor, and its clipping, so a
// squeezed card can never paint the image over the text block underneath.
// It is also the card's large tap target onto the subject's own screen.
//
// Takes an already-resolved `url`, not a raw path: a show card's photo is an
// event POSTER (posterPublicUrl, Task 28's single canonical poster-url
// builder), while an artist/venue card's is a profile photo (publicStorageUrl,
// SP7 Task 11's own path-to-URL builder for those); each caller below picks
// the resolver that matches what it's actually showing, this component just
// renders whatever URL it's handed.
function DeckPhoto({ url, fallback, preview, onPress, label }: {
  url: string | null; fallback: ReactNode; preview: DeckPreview; onPress: () => void; label: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ flex: 1, minHeight: PHOTO_MIN_HEIGHT, overflow: "hidden" }}
    >
      {url
        ? <Image source={{ uri: url }} resizeMode="cover" style={{ position: "absolute", inset: 0 }} />
        : <PhotoPlaceholder icon={fallback} />}
      <PhotoScrim />
      <View style={{ position: "absolute", left: tokens.space.lg, right: tokens.space.lg, bottom: tokens.space.md }}>
        <PreviewLine preview={preview} />
      </View>
    </Pressable>
  );
}

function CardFrame({ height, children }: { height: number; children: ReactNode }) {
  return (
    <View style={{ height, padding: tokens.space.md }}>
      <Card style={{ flex: 1, padding: 0, overflow: "hidden" }}>{children}</Card>
    </View>
  );
}

// The text block splits in two on purpose. The lines shrink (and clip, they
// are all numberOfLines-capped) when the card runs out of room; the action
// row underneath never shrinks, so Tickets and Follow stay on the card at
// every screen size and text size. Every card ends the same way: the ticket,
// the one ember element, beside Follow. A card whose subject has no upcoming
// show has no ticket to offer and renders Follow alone.
function TextBlock({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  return (
    <>
      <View style={{
        flexShrink: 1, minHeight: 0, overflow: "hidden",
        paddingHorizontal: tokens.space.lg, paddingTop: tokens.space.lg, gap: tokens.space.sm,
      }}>
        {children}
      </View>
      <View style={{
        flexShrink: 0, flexDirection: "row", alignItems: "flex-start", gap: tokens.space.sm,
        paddingHorizontal: tokens.space.lg, paddingTop: tokens.space.sm, paddingBottom: tokens.space.lg,
      }}>
        {actions}
      </View>
    </>
  );
}

function MetaRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {icon}
      {children}
    </View>
  );
}

function TicketsButton({ eventId }: { eventId: string }) {
  const router = useRouter();
  return (
    <Button
      title="Tickets"
      onPress={() => router.push({ pathname: "/event/[eventId]", params: { eventId } })}
    />
  );
}

function showPriceLabel(card: Extract<DeckCard, { kind: "show" }>): string | null {
  if (card.hasFreeTier) return "Free";
  if (card.priceFromCents == null) return null;
  return `from ${formatCents(card.priceFromCents)}`;
}

// "The Ivy Room, Sat, Sep 5" for an artist card, "Nightjar, Sat, Sep 5" for
// a venue card: the venue is the news on one and the show title on the other.
function nextShowLine(next: NonNullable<DeckNextShow>, kind: "artist" | "venue"): string {
  const lead = kind === "artist" ? next.venueName : next.title;
  return `${lead}, ${formatEventShortDate(next.startsAt)}`;
}

export function ShowCard({ card, height }: { card: Extract<DeckCard, { kind: "show" }>; height: number }) {
  const router = useRouter();
  const t = useTokens();
  const price = showPriceLabel(card);
  const venueLine = card.neighborhood ? `${card.venueName}, ${card.neighborhood}` : card.venueName;
  const distance = card.distanceMeters != null ? distanceLabel(card.distanceMeters) : null;
  const openEvent = () => router.push({ pathname: "/event/[eventId]", params: { eventId: card.eventId } });

  return (
    <CardFrame height={height}>
      <DeckPhoto
        url={posterPublicUrl(card.posterPath)}
        fallback={<IconTicket size={40} color={t.muted} />}
        preview={card.preview}
        onPress={openEvent}
        label={card.title || "Untitled event"}
      />
      <TextBlock actions={<>
        <TicketsButton eventId={card.eventId} />
        <FollowButton targetId={card.curatorProfileId} targetType="curator" label="Follow venue" compact />
      </>}>
        <Pressable onPress={openEvent} accessibilityRole="button" accessibilityLabel={card.title || "Untitled event"}>
          <Text variant="display" numberOfLines={2}>{card.title || "Untitled event"}</Text>
        </Pressable>
        <Text variant="meta" muted numberOfLines={1}>
          {formatEventFullDate(card.startsAt)} · {formatEventTimeRange(card.startsAt, card.endsAt)}
        </Text>
        <MetaRow icon={<IconMapPin size={14} color={t.muted} />}>
          <Text variant="meta" muted numberOfLines={1} style={{ flex: 1 }}>
            {distance ? `${venueLine} · ${distance}` : venueLine}
          </Text>
        </MetaRow>
        {card.lineupNames.length > 0 && (
          <Text variant="label" numberOfLines={1}>{card.lineupNames.join(", ")}</Text>
        )}
        {card.latestPost && (
          <View style={{ gap: 2 }}>
            <Text numberOfLines={2}>{`"${card.latestPost.text}"`}</Text>
            <Text variant="meta" muted numberOfLines={1}>{card.latestPost.artistName}</Text>
          </View>
        )}
        {price && <Badge label={price} />}
      </TextBlock>
    </CardFrame>
  );
}

export function ArtistCard({ card, height }: { card: Extract<DeckCard, { kind: "artist" }>; height: number }) {
  const router = useRouter();
  const t = useTokens();
  const openArtist = () => router.push({ pathname: "/artist/[handle]", params: { handle: card.handle } });
  const genres = card.genres.slice(0, 3);
  // A const, not `card.nextShow` inline: TypeScript keeps a const's
  // narrowing inside the callbacks below, a property's narrowing it does not.
  const next = card.nextShow;
  const photoPath = card.coverPhotoPath ?? card.avatarPhotoPath;

  return (
    <CardFrame height={height}>
      <DeckPhoto
        url={photoPath ? publicStorageUrl(photoPath) : null}
        fallback={<IconUserCircle size={44} color={t.muted} />}
        preview={card.preview}
        onPress={openArtist}
        label={card.name}
      />
      <TextBlock actions={<>
        {next && <TicketsButton eventId={next.eventId} />}
        <FollowButton targetId={card.profileId} targetType="musician" compact />
      </>}>
        <Pressable onPress={openArtist} accessibilityRole="button" accessibilityLabel={card.name}>
          <Text variant="display" numberOfLines={2}>{card.name}</Text>
        </Pressable>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Badge label={card.subtype === "band" ? "Band" : "Solo"} />
          {genres.map((g) => <Badge key={g} label={formatChipLabel(g)} />)}
        </View>
        {next && (
          <MetaRow icon={<IconTicket size={14} color={t.muted} />}>
            <Text variant="meta" muted numberOfLines={1} style={{ flex: 1 }}>
              Next: {nextShowLine(next, "artist")}
            </Text>
          </MetaRow>
        )}
      </TextBlock>
    </CardFrame>
  );
}

export function VenueCard({ card, height }: { card: Extract<DeckCard, { kind: "venue" }>; height: number }) {
  const router = useRouter();
  const t = useTokens();
  const openVenue = () => router.push({ pathname: "/venue/[handle]", params: { handle: card.handle } });
  const distance = card.distanceMeters != null ? distanceLabel(card.distanceMeters) : null;
  const place = [card.neighborhood, distance].filter(Boolean).join(" · ");
  const next = card.nextShow;

  return (
    <CardFrame height={height}>
      <DeckPhoto
        url={card.photoPath ? publicStorageUrl(card.photoPath) : null}
        fallback={<IconImages size={40} color={t.muted} />}
        preview={card.preview}
        onPress={openVenue}
        label={card.name}
      />
      <TextBlock actions={<>
        {next && <TicketsButton eventId={next.eventId} />}
        <FollowButton targetId={card.profileId} targetType="curator" label="Follow venue" compact />
      </>}>
        <Pressable onPress={openVenue} accessibilityRole="button" accessibilityLabel={card.name}>
          <Text variant="display" numberOfLines={2}>{card.name}</Text>
        </Pressable>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <Badge label="Venue" />
          {place.length > 0 && (
            <MetaRow icon={<IconMapPin size={14} color={t.muted} />}>
              <Text variant="meta" muted numberOfLines={1}>{place}</Text>
            </MetaRow>
          )}
        </View>
        {next && (
          <MetaRow icon={<IconTicket size={14} color={t.muted} />}>
            <Text variant="meta" muted numberOfLines={1} style={{ flex: 1 }}>
              Next up: {nextShowLine(next, "venue")}
            </Text>
          </MetaRow>
        )}
      </TextBlock>
    </CardFrame>
  );
}

// memo, because FlatList re-renders every mounted row whenever the deck's own
// state changes (a fetch, a mute toggle) and a deck row is a full-screen card
// with an image in it.
export const DeckCardView = memo(function DeckCardView({ card, height }: { card: DeckCard; height: number }) {
  if (card.kind === "show") return <ShowCard card={card} height={height} />;
  if (card.kind === "artist") return <ArtistCard card={card} height={height} />;
  return <VenueCard card={card} height={height} />;
});
