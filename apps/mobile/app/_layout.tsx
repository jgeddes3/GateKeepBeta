import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import * as Sentry from "@sentry/react-native";
import { AuthProvider, useAuth } from "../src/auth/AuthProvider";
import { ProfileProvider } from "../src/shell/ProfileContext";

// Crash reporting: no-op in dev, and a no-op in production too until
// EXPO_PUBLIC_SENTRY_DSN is set (see README manual follow-ups).
Sentry.init({ dsn: process.env.EXPO_PUBLIC_SENTRY_DSN ?? "", enabled: !__DEV__ });

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
