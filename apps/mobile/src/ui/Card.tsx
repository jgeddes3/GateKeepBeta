import { View, type ViewProps } from "react-native";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";

export function Card({ style, ...rest }: ViewProps) {
  const t = useTokens();
  return (
    <View
      {...rest}
      style={[
        {
          backgroundColor: t.surface,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: tokens.radius.card,
          padding: tokens.space.lg,
        },
        style,
      ]}
    />
  );
}
