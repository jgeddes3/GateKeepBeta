import { Share } from "react-native";
import { Button } from "../ui/Button";

// SP11 (spec section 3.1): the one shared mobile share affordance, mounted
// on the event, artist, and venue screens. Web's twin lives at
// apps/web/src/share/ShareButton.tsx; mobile uses React Native's own
// Share.share sheet instead of navigator.share/clipboard, so there's no
// "Link copied" fallback state here, the OS sheet is always available.
const SITE_URL = process.env.EXPO_PUBLIC_SITE_URL ?? "";

export function ShareButton({ path, title }: { path: string; title: string }) {
  // No env, no button: a share sheet carrying a relative path or a
  // localhost URL is worse than no share affordance at all (spec 3.1).
  if (!SITE_URL) return null;
  const onPress = async () => {
    try {
      await Share.share({ message: title, url: `${SITE_URL}${path}` });
    } catch (e) {
      console.warn("share failed", e);
    }
  };
  return <Button title="Share" variant="secondary" onPress={() => void onPress()} />;
}
