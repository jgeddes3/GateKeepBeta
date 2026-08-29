// Themed error/callout row: the one error surface across the auth screens
// (sign-in, sign-up, join), replacing the native Alert.alert popup those
// screens used for errors before. accessibilityRole="alert" +
// accessibilityLiveRegion="polite" restore the VoiceOver/TalkBack
// announcement the native Alert gave for free; a plain inline View would
// otherwise render silently to a screen reader.
import { View } from "react-native";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";
import { Text } from "./Text";

export function ErrorBanner({ message, testID }: { message: string | null; testID?: string }) {
  const t = useTokens();
  if (!message) return null;
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        borderWidth: 1,
        borderColor: t.destructive,
        borderRadius: tokens.radius.card,
        padding: tokens.space.md,
        backgroundColor: t.surface,
      }}
    >
      <Text color={t.destructive}>{message}</Text>
    </View>
  );
}
