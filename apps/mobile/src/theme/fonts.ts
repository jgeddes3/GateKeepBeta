import { useFonts } from "expo-font";

export function useAppFonts(): boolean {
  const [loaded] = useFonts({
    "Syne-SemiBold": require("../../assets/fonts/Syne-SemiBold.ttf"),
    "Syne-Bold": require("../../assets/fonts/Syne-Bold.ttf"),
    "Syne-ExtraBold": require("../../assets/fonts/Syne-ExtraBold.ttf"),
    "Sora-Regular": require("../../assets/fonts/Sora-Regular.ttf"),
    "Sora-Medium": require("../../assets/fonts/Sora-Medium.ttf"),
    "Sora-SemiBold": require("../../assets/fonts/Sora-SemiBold.ttf"),
  });
  return loaded;
}
