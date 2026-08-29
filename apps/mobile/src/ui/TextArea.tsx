// Same surface/border/focus treatment as Input.tsx, sized and configured for
// multiline entry (taller minHeight, top-aligned text, multiline forced on).
import { TextInput, type TextInputProps } from "react-native";
import { useState } from "react";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";

export function TextArea({ style, ...rest }: TextInputProps) {
  const t = useTokens();
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      {...rest}
      multiline
      textAlignVertical="top"
      placeholderTextColor={t.muted}
      onFocus={(e) => {
        setFocused(true);
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        rest.onBlur?.(e);
      }}
      style={[
        {
          backgroundColor: t.surface,
          color: t.text,
          borderWidth: 1,
          borderColor: focused ? t.focus : t.border,
          borderRadius: tokens.radius.card,
          paddingHorizontal: 12,
          paddingVertical: 10,
          minHeight: 96,
        },
        style,
      ]}
    />
  );
}
