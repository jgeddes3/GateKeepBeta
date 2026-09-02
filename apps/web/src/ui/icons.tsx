import {
  AppleLogo,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bell,
  Buildings,
  CalendarBlank,
  CalendarCheck,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  ChatCircle,
  Check,
  Circle,
  Compass,
  DotsThreeVertical,
  FunnelSimple,
  Globe,
  GoogleLogo,
  House,
  Image,
  Images,
  Info,
  InstagramLogo,
  LinkSimple,
  List,
  MagnifyingGlass,
  MapPin,
  Minus,
  Monitor,
  Moon,
  MusicNotes,
  Pause,
  PencilSimple,
  Play,
  Plus,
  SpotifyLogo,
  Sun,
  Ticket,
  Trash,
  UploadSimple,
  UserCircle,
  Wallet,
  Warning,
  X,
  YoutubeLogo,
} from "@phosphor-icons/react/ssr";
import type { ComponentProps, ComponentType } from "react";

// Single pinned Phosphor weight for the whole product. Every icon used in
// app code (including inside src/ui components) imports from this module,
// never straight from @phosphor-icons/react, so no file can accidentally
// mix weights. See DESIGN.md > Icons for the duotone-vs-regular decision
// and the rationale behind it.
//
// Imported from the "/ssr" subpath (Phosphor's server-render-safe entry)
// rather than the default one, so icons stay usable from React Server
// Components; presentational src/ui components (Badge, Card, Skeleton,
// Button) do not need "use client" just because they render an icon.
const ICON_WEIGHT: ComponentProps<typeof House>["weight"] = "duotone";

type PhosphorIconComponent = typeof House;
export type IconProps = Omit<ComponentProps<PhosphorIconComponent>, "weight">;

function pin(PhosphorIcon: PhosphorIconComponent): ComponentType<IconProps> {
  function Pinned(props: IconProps) {
    return <PhosphorIcon {...props} weight={ICON_WEIGHT} />;
  }
  Pinned.displayName = `Pinned(${PhosphorIcon.displayName ?? "PhosphorIcon"})`;
  return Pinned;
}

// Component chrome (dialog/sheet close, select/dropdown indicators).
export const IconClose = pin(X);
export const IconCheck = pin(Check);
export const IconCircle = pin(Circle);
export const IconCaretDown = pin(CaretDown);
export const IconCaretUp = pin(CaretUp);
export const IconCaretRight = pin(CaretRight);
export const IconCaretLeft = pin(CaretLeft);
export const IconDotsVertical = pin(DotsThreeVertical);

// Shell, nav, and app icons.
export const IconHouse = pin(House);
export const IconGigs = pin(MusicNotes);
export const IconBookings = pin(CalendarCheck);
export const IconEarnings = pin(Wallet);
export const IconMessages = pin(ChatCircle);
export const IconUser = pin(UserCircle);
export const IconMenu = pin(List);
export const IconSearch = pin(MagnifyingGlass);
export const IconFilter = pin(FunnelSimple);
export const IconMapPin = pin(MapPin);
export const IconArrowRight = pin(ArrowRight);
export const IconInfo = pin(Info);
export const IconWarning = pin(Warning);
export const IconPlay = pin(Play);
export const IconPause = pin(Pause);
export const IconMonitor = pin(Monitor);
export const IconMoon = pin(Moon);
export const IconSun = pin(Sun);

// Sub-project 9A task 5: sign-in/sign-up's provider buttons ("Continue with
// Google"/"Continue with Apple") need an icon that genuinely identifies the
// provider, not a generic glyph (antislop R-04). Phosphor ships both as
// real logo marks with duotone paths, so they go through the same pin()
// pipeline as every other content icon rather than a one-off import.
export const IconGoogle = pin(GoogleLogo);
export const IconApple = pin(AppleLogo);

// Sub-project 9A task 6: the dashboard home's profile cards need a type
// marker distinguishing a musician profile from a curator one at a glance.
// Musicians reuse IconGigs (MusicNotes already means "music" everywhere
// else it appears, the Gigs nav item included, so this is the same glyph
// carrying the same real meaning, not a second unrelated icon). Buildings
// stands in for "curator" (venues are the marketplace's primary curator
// subtype, and planner/individual-host profiles still represent an
// organizing entity rather than a performer), paired with the profile's own
// type label so the icon is never the sole signal. Bell marks the
// notifications section, which previously had no icon at all.
export const IconBuildings = pin(Buildings);
export const IconBell = pin(Bell);

// Sub-project 9A task 7: profile editors (musician portfolio, curator
// profile). Upload zones (photos, tracks) get a real "drop a file here"
// glyph rather than a bare file input; track/link rows get functional row
// actions (reorder, rename, remove); the photo slot itself gets a filled
// placeholder icon instead of an empty grey box.
export const IconUpload = pin(UploadSimple);
export const IconImage = pin(Image);
export const IconTrash = pin(Trash);
export const IconPencil = pin(PencilSimple);
export const IconPlus = pin(Plus);
export const IconArrowUp = pin(ArrowUp);
export const IconArrowDown = pin(ArrowDown);
export const IconLink = pin(LinkSimple);

// Sub-project 9A task 10: the venue page's collage-header "Open gallery"
// bubble (spec section 6.6, docs/superpowers/mocks/sp9a/venue-page.html
// option A). Images (a stacked-photos glyph), not the singular Image above
// (already spoken for as the photo-upload placeholder icon): this button
// opens a multi-photo lightbox, so the plural glyph is the one that is
// actually relevant to what it represents (antislop R-04).
export const IconImages = pin(Images);

// Sub-project 9A task 9: the artist page's External links section names
// which platform each link points to (spotify/youtube/instagram/website,
// ExternalLinkKind's full union), so each gets a real, brand-relevant mark
// rather than IconLink's generic chain glyph for every row (antislop R-04).
// "website" has no single platform logo; Globe is the closest genuinely
// relevant glyph for "leaves the product to an external site" of that kind.
export const IconSpotify = pin(SpotifyLogo);
export const IconYoutube = pin(YoutubeLogo);
export const IconInstagram = pin(InstagramLogo);
export const IconWebsite = pin(Globe);

// Sub-project 6 task 9: the public event page. Ticket names the poster
// placeholder (a real event has a physical or admission-token association,
// same "genuinely relevant to the content" bar GigCard's IconGigs/
// MusicianProfile's IconUser placeholders already set, antislop R-04) and
// the buy flow's per-tier quantity stepper's decrement control (paired with
// the existing IconPlus for increment).
export const IconTicket = pin(Ticket);
export const IconMinus = pin(Minus);

// Sub-project 6 task 10: the curator events manager's own nav destination
// and list-view heading need an icon distinct from IconTicket (which stays
// pinned to "a ticket itself" everywhere it already appears: the buy flow's
// poster placeholder, the fan tickets page's QR/empty-state icon), since the
// curator nav shows Events and Tickets as two separate items in the same
// bar (antislop R-04: two different destinations should never share one
// glyph). CalendarCheck is already spoken for by Bookings in that same nav,
// so this is the plain calendar mark, "a scheduled thing" rather than
// "a booking already confirmed."
export const IconEvents = pin(CalendarBlank);

// Sub-project 7 task 8: the signed-in shell's new "Discover" nav
// destination (/discover, the fan-facing shows/artists browse). A compass
// is the literal "find your way to things" glyph, distinct from IconSearch
// (MagnifyingGlass, already spoken for by text-search affordances
// elsewhere) the same way antislop R-04 asks every icon choice to be.
export const IconCompass = pin(Compass);

// Radio-item indicator: a solid dot marker, not a content icon, so it uses
// Phosphor's "fill" weight directly rather than the pinned ICON_WEIGHT. At
// the ~8px size a selection dot renders at, duotone and regular both draw
// a thin ring, illegible as a filled bullet. This is the one deliberate
// exception to "everything goes through pin()"; every content icon above
// still resolves to exactly one weight.
export function IconRadioDot(props: Omit<IconProps, "weight">) {
  return <Circle {...props} weight="fill" />;
}
