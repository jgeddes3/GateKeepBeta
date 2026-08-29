// The ONLY file importing phosphor-react-native. Weight is fixed to "duotone"
// product-wide (DESIGN.md) and cannot be overridden by a caller. No Lucide,
// ever (binding rule 4).
//
// Export-name note: phosphor-react-native@3.0.6 deprecates the bare glyph
// names used in the plan draft (e.g. `House`) in favor of an `*Icon`-suffixed
// alias (`HouseIcon`) that points at the same component. Both resolve; this
// file uses the non-deprecated `*Icon` exports so new code does not start
// life against an already-deprecated API. The curated set and the wrapped
// `IconX` export names below are unchanged from the plan.
import * as Ph from "phosphor-react-native";
import { useTokens } from "../theme/ThemeProvider";

type Props = { size?: number; color?: string };

function wrap(Comp: Ph.Icon) {
  return function Icon({ size = 20, color }: Props) {
    const t = useTokens();
    return <Comp size={size} color={color ?? t.text} weight="duotone" />;
  };
}

export const IconHouse = wrap(Ph.HouseIcon);
export const IconMagnifyingGlass = wrap(Ph.MagnifyingGlassIcon);
export const IconCalendarCheck = wrap(Ph.CalendarCheckIcon);
export const IconChatCircle = wrap(Ph.ChatCircleIcon);
export const IconUserCircle = wrap(Ph.UserCircleIcon);
export const IconWallet = wrap(Ph.WalletIcon);
export const IconMusicNotes = wrap(Ph.MusicNotesIcon);
export const IconTicket = wrap(Ph.TicketIcon);
export const IconPlay = wrap(Ph.PlayIcon);
export const IconPause = wrap(Ph.PauseIcon);
export const IconCheck = wrap(Ph.CheckIcon);
export const IconX = wrap(Ph.XIcon);
export const IconCaretLeft = wrap(Ph.CaretLeftIcon);
export const IconCaretRight = wrap(Ph.CaretRightIcon);
export const IconCaretDown = wrap(Ph.CaretDownIcon);
export const IconWarningCircle = wrap(Ph.WarningCircleIcon);
export const IconInfo = wrap(Ph.InfoIcon);
export const IconGear = wrap(Ph.GearIcon);
export const IconSun = wrap(Ph.SunIcon);
export const IconMoon = wrap(Ph.MoonIcon);
// Add more as screen tasks need them; every addition goes HERE, wrapped.
