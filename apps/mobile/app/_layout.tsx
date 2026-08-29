import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import type { ReactElement, ReactNode } from "react";
import * as Sentry from "@sentry/react-native";
import * as SplashScreen from "expo-splash-screen";
import { setAudioModeAsync } from "expo-audio";
import { AuthProvider, useAuth } from "../src/auth/AuthProvider";
import { ProfileProvider } from "../src/shell/ProfileContext";
import { stripeEnabled, publishableKey, MERCHANT_IDENTIFIER } from "../src/payments/stripe";
import { ThemeProvider } from "../src/theme/ThemeProvider";
import { useAppFonts } from "../src/theme/fonts";

// Crash reporting: no-op in dev, and a no-op in production too until
// EXPO_PUBLIC_SENTRY_DSN is set (see README manual follow-ups).
Sentry.init({ dsn: process.env.EXPO_PUBLIC_SENTRY_DSN ?? "", enabled: !__DEV__ });

// Held until useAppFonts() resolves below, so Syne/Sora are loaded before the
// first paint (avoids a flash of the system font on brand-forward screens).
SplashScreen.preventAutoHideAsync().catch(() => {});

// Renders children bare when keyless — the provider (and the native module
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
  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === "(auth)";
    if (!user && !inAuthGroup) router.replace("/(auth)/sign-in");
    if (user && inAuthGroup) router.replace("/");
  }, [user, loading, segments, router]);
  return (
    <Stack screenOptions={{ headerShown: false }}>
      {/* Detail screens pushed over the tab groups get a native header whose
          automatic back arrow is the back affordance. booking/[bookingId]
          keeps its own custom back control instead — it also handles the
          no-history deep-link case (canGoBack ? back : replace("/")), which
          a native header's auto-hidden back arrow would not. */}
      <Stack.Screen name="join" options={{ headerShown: true, title: "Create a profile" }} />
      <Stack.Screen name="artist/[handle]" options={{ headerShown: true, title: "Artist" }} />
    </Stack>
  );
}

export default function RootLayout() {
  // Silent preview on iOS: without this, TrimUploader's clip preview and
  // /artist/[handle]'s track playback are silent on a device with the
  // ringer switch off, which looks like a broken player rather than an
  // unset audio mode. Set once at app start, not per-screen — expo-audio's
  // audio mode is process-global. Run from an effect, not module scope: a
  // dev client built before Task 13's native modules were linked in (or any
  // environment missing expo-audio's native module) throws here, and doing
  // that at module-evaluation time crashed the whole app at launch with an
  // error pointing at the JS bundle instead of the actual cause. try/catch
  // + a warning keeps a missing/broken native module from taking down
  // everything else — the rest of the app still works, just silently.
  useEffect(() => {
    (async () => {
      try {
        await setAudioModeAsync({ playsInSilentMode: true });
      } catch (e) {
        console.warn("setAudioModeAsync failed, rebuild the dev client if this is a fresh install", e);
      }
    })();
  }, []);

  const fontsLoaded = useAppFonts();
  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded]);
  if (!fontsLoaded) return null;

  return (
    <ThemeProvider>
      <AuthProvider><ProfileProvider><MaybeStripeProvider><Gate /></MaybeStripeProvider></ProfileProvider></AuthProvider>
    </ThemeProvider>
  );
}
