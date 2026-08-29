import { View } from "react-native";
import { Chip } from "./Chip";
import { useThemeChoice } from "../theme/ThemeProvider";

export function ThemeToggle() {
  const { choice, setChoice } = useThemeChoice();
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {(["light", "dark", "system"] as const).map((c) => (
        <Chip
          key={c}
          label={c[0].toUpperCase() + c.slice(1)}
          active={choice === c}
          onPress={() => setChoice(c)}
        />
      ))}
    </View>
  );
}
