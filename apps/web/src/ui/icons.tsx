import {
  AppleLogo,
  ArrowRight,
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
  GoogleLogo,
  House,
  Info,
  List,
  MagnifyingGlass,
  MapPin,
  Monitor,
  Moon,
  MusicNotes,
  Pause,
  Play,
  Sun,
  UserCircle,
  Wallet,
  Warning,
  X,
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

// Radio-item indicator: a solid dot marker, not a content icon, so it uses
// Phosphor's "fill" weight directly rather than the pinned ICON_WEIGHT. At
// the ~8px size a selection dot renders at, duotone and regular both draw
// a thin ring, illegible as a filled bullet. This is the one deliberate
// exception to "everything goes through pin()"; every content icon above
// still resolves to exactly one weight.
export function IconRadioDot(props: Omit<IconProps, "weight">) {
  return <Circle {...props} weight="fill" />;
}
