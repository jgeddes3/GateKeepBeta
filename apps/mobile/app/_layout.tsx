import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import type { ReactElement, ReactNode } from "react";
import * as Sentry from "@sentry/react-native";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { setAudioModeAsync } from "expo-audio";
import { AuthProvider, useAuth } from "../src/auth/AuthProvider";
import { ProfileProvider } from "../src/shell/ProfileContext";
import { FollowsProvider } from "../src/discover/useFollows";
import { stripeEnabled, publishableKey, MERCHANT_IDENTIFIER } from "../src/payments/stripe";
import { ThemeProvider, useTokens, useThemeChoice } from "../src/theme/ThemeProvider";
import { tokens } from "../src/theme/tokens";
import { useAppFonts } from "../src/theme/fonts";

// Crash reporting: no-op in dev, and a no-op in production too until
// EXPO_PUBLIC_SENTRY_DSN is set (see README manual follow-ups).
Sentry.init({ dsn: process.env.EXPO_PUBLIC_SENTRY_DSN ?? "", enabled: !__DEV__ });

// Held until useAppFonts() resolves below, so Syne/Sora are loaded before the
// first paint (avoids a flash of the system font on brand-forward screens).
SplashScreen.preventAutoHideAsync().catch(() => {});

// Renders children bare when keyless: the provider (and the native module
// behind it) never loads in emulator dev or on a dev client from before this
// module existed. Lazy require for the same reason stripe.ts documents.
function MaybeStripeProvider({ children }: { children: ReactNode }) {
  if (!stripeEnabled) return <>{children}</>;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { StripeProvider } = require("@stripe/stripe-react-native") as
    typeof import("@stripe/stripe-react-native");
  return (
    <StripeProvider publishableKey={publishableKey} urlScheme="gatekeep"
      merchantIdentifier={MERCHANT_IDENTIFIER}>
      {children as ReactElement}
    </StripeProvider>
  );
}

function Gate() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const t = useTokens();
  const { active } = useThemeChoice();
  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === "(auth)";
    if (!user && !inAuthGroup) router.replace("/(auth)/sign-in");
    if (user && inAuthGroup) router.replace("/");
  }, [user, loading, segments, router]);
  return (
    <>
      <StatusBar style={active === "light" ? "dark" : "light"} />
      <Stack screenOptions={{
        headerShown: false,
        // Border separates, shadow does not (DESIGN.md), but this Stack's
        // header is expo-router's native (OS-chrome) header, not the
        // JS-rendered one Tabs uses: its headerStyle type only supports
        // backgroundColor, no border. The would-be fix, a headerBackground
        // render prop drawing a themed bottom hairline, was tried and
        // reverted: expo-router's native-stack sets translucent:true
        // whenever headerBackground is non-null, which floats the header
        // over the screen content instead of pushing it down, and neither
        // join.tsx nor artist/[handle].tsx pads for header height. A
        // borderless themed header (surface-color change is still the
        // separator) is far cheaper than an occluded screen on these two
        // auxiliary routes. The JS-rendered TAB-group headers keep their
        // border via useShellScreenOptions, a different render path, not
        // affected by this native-stack constraint.
        headerShadowVisible: false,
        headerStyle: { backgroundColor: t.surface },
        headerTintColor: t.text,
        headerTitleStyle: { fontFamily: tokens.font.syne[700] },
      }}>
        {/* Detail screens pushed over the tab groups get a native header whose
            automatic back arrow is the back affordance. booking/[bookingId]
            keeps its own custom back control instead: it also handles the
            no-history deep-link case (canGoBack ? back : replace("/")), which
            a native header's auto-hidden back arrow would not. */}
        <Stack.Screen name="join" options={{ headerShown: true, title: "Create a profile" }} />
        <Stack.Screen name="artist/[handle]" options={{ headerShown: true, title: "Artist" }} />
        {/* Sub-project 6 task 11: the fan event detail + buy screen, pushed
            from Home's upcoming list, the Tickets tab, and (later, sub-7)
            discovery. Same themed native header as artist/[handle] above. */}
        <Stack.Screen name="event/[eventId]" options={{ headerShown: true, title: "Event" }} />
        {/* Sub-project 7 task 11: the fan-facing curator public page, pushed
            from the Following screen and notification deep links. Same
            themed native header as artist/[handle] above. */}
        <Stack.Screen name="venue/[handle]" options={{ headerShown: true, title: "Venue" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  // Silent preview on iOS: without this, TrimUploader's clip preview and
  // /artist/[handle]'s track playback are silent on a device with the
  // ringer switch off, which looks like a broken player rather than an
  // unset audio mode. Set once at app start, not per-screen: expo-audio's
  // audio mode is process-global. Run from an effect, not module scope: a
  // dev client built before Task 13's native modules were linked in (or any
  // environment missing expo-audio's native module) throws here, and doing
  // that at module-evaluation time crashed the whole app at launch with an
  // error pointing at the JS bundle instead of the actual cause. try/catch
  // + a warning keeps a missing/broken native module from taking down
  // everything else: the rest of the app still works, just silently.
  useEffect(() => {
    (async () => {
      try {
        await setAudioModeAsync({ playsInSilentMode: true });
      } catch (e) {
        console.warn("setAudioModeAsync failed, rebuild the dev client if this is a fresh install", e);
      }
    })();
  }, []);

  // Render gate only, not the splash trigger: hiding the splash here as soon
  // as fonts load could still show a blank frame if ThemeProvider (mounted
  // below) has not finished reading the stored theme choice yet. ThemeProvider
  // itself calls SplashScreen.hideAsync() once its own readiness resolves, so
  // the splash covers both fonts AND theme resolution, not just fonts.
  const fontsLoaded = useAppFonts();
  if (!fontsLoaded) return null;

  return (
    <ThemeProvider>
      {/* SP7 Task 11 fix round 1 (review, Important): FollowsProvider owns
          the ONE follows/{uid} listener the whole app needs, mounted here
          (inside ProfileProvider, so it can read useAuth) rather than per
          screen. Before this, ArtistsList's up to 60 FollowButton rows each
          opened an independent onSnapshot on the identical query. Every
          screen that can render a FollowButton or read follow state
          (Discover, Following, the event screen, the artist page, the venue
          screen) sits inside this provider now, reading the shared
          subscription via useFollowsContext instead. */}
      <AuthProvider><ProfileProvider><FollowsProvider><MaybeStripeProvider><Gate /></MaybeStripeProvider></FollowsProvider></ProfileProvider></AuthProvider>
    </ThemeProvider>
  );
}
