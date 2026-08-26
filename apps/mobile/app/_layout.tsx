import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import * as Sentry from "@sentry/react-native";
import { setAudioModeAsync } from "expo-audio";
import { AuthProvider, useAuth } from "../src/auth/AuthProvider";
import { ProfileProvider } from "../src/shell/ProfileContext";

// Crash reporting: no-op in dev, and a no-op in production too until
// EXPO_PUBLIC_SENTRY_DSN is set (see README manual follow-ups).
Sentry.init({ dsn: process.env.EXPO_PUBLIC_SENTRY_DSN ?? "", enabled: !__DEV__ });

// Silent preview on iOS: without this, TrimUploader's clip preview and
// /artist/[handle]'s track playback are silent on a device with the ringer
// switch off, which looks like a broken player rather than an unset audio
// mode. Set once at app start, not per-screen — expo-audio's audio mode is
// process-global.
void setAudioModeAsync({ playsInSilentMode: true });

function Gate() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === "(auth)";
    if (!user && !inAuthGroup) router.replace("/(auth)/sign-in");
    if (user && inAuthGroup) router.replace("/");
  }, [user, loading, segments]);
  return <Stack screenOptions={{ headerShown: false }} />;
}

export default function RootLayout() {
  return <AuthProvider><ProfileProvider><Gate /></ProfileProvider></AuthProvider>;
}
