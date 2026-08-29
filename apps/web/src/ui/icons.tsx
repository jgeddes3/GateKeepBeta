import {
  AppleLogo,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bell,
  Buildings,
  CalendarCheck,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  ChatCircle,
  Check,
  Circle,
  DotsThreeVertical,
  FunnelSimple,
  Globe,
  GoogleLogo,
  House,
  Image,
  Info,
  InstagramLogo,
  LinkSimple,
  List,
  MagnifyingGlass,
  MapPin,
  Monitor,
  Moon,
  MusicNotes,
  Pause,
  PencilSimple,
  Play,
  Plus,
  SpotifyLogo,
  Sun,
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

// Radio-item indicator: a solid dot marker, not a content icon, so it uses
// Phosphor's "fill" weight directly rather than the pinned ICON_WEIGHT. At
// the ~8px size a selection dot renders at, duotone and regular both draw
// a thin ring, illegible as a filled bullet. This is the one deliberate
// exception to "everything goes through pin()"; every content icon above
// still resolves to exactly one weight.
export function IconRadioDot(props: Omit<IconProps, "weight">) {
  return <Circle {...props} weight="fill" />;
}
