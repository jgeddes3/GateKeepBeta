import { TextInput, type TextInputProps } from "react-native";
import { useState } from "react";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";

export function Input({ style, error, ...rest }: TextInputProps & { error?: boolean }) {
  const t = useTokens();
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      {...rest}
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
          // `error` overrides the focus/border logic: validation styling
          // lives in one place.
          borderColor: error ? t.destructive : focused ? t.focus : t.border,
          borderRadius: tokens.radius.card,
          paddingHorizontal: 12,
          paddingVertical: 10,
          minHeight: 44,
        },
        style,
      ]}
    />
  );
}
