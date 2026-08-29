// Shared Tabs.screenOptions for all three role tab groups (curator/musician/
// fan): the tab bar theming AND the tab group's own native header (title +
// ContextSwitcher, shown on every tab screen except one that opts out with
// its own headerShown:false, e.g. curator's "events" folder, which owns its
// own inner Stack headers instead). One hook keeps all three role tab bars
// visually identical and removes what was a 3x copy of the same object;
// each _layout.tsx still declares its own per-screen Tabs.Screen icons and
// titles, only the screenOptions object itself moved here.
//
// .tsx (not .ts) because headerRight returns JSX.
import { useTokens, useThemeChoice } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";
import { ContextSwitcher } from "./ContextSwitcher";

export function useShellScreenOptions() {
  const t = useTokens();
  const { active } = useThemeChoice();
  // AA: ember (t.accent) on the white light-theme surface tab bar/header
  // risks failing AA contrast at small sizes. Light theme branches to
  // t.focus (#BF5038, an AA-safe rust), the same rule the web wordmark
  // uses in light mode. Dark theme keeps the brand ember. Owner verifies
  // contrast at the next build.
  const activeTint = active === "light" ? t.focus : t.accent;
  return {
    headerRight: () => <ContextSwitcher />,
    // Border separates, shadow does not (DESIGN.md): same rule as the
    // Stack header in app/_layout.tsx, kept equivalent here so the tab
    // group's own header and the pushed-screen Stack header match.
    headerShadowVisible: false,
    headerStyle: { backgroundColor: t.surface, borderBottomWidth: 1, borderBottomColor: t.border },
    headerTintColor: t.text,
    headerTitleStyle: { fontFamily: tokens.font.syne[700] },
    tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border, borderTopWidth: 1,
      elevation: 0, shadowOpacity: 0 },
    tabBarActiveTintColor: activeTint,
    tabBarInactiveTintColor: t.muted,
    tabBarLabelStyle: { fontFamily: tokens.font.sora[500], fontSize: 11 },
  };
}
