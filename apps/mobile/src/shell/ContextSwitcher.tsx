import { View, Pressable, Modal } from "react-native";
import { useState } from "react";
import { useRouter } from "expo-router";
import { Text, IconCaretDown } from "../ui";
import { useProfileContext } from "./ProfileContext";
import { useTokens, useThemeChoice } from "../theme/ThemeProvider";

export function ContextSwitcher() {
  const { activeContext, myProfiles, switchTo } = useProfileContext();
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const t = useTokens();
  const { active } = useThemeChoice();
  // AA: same light-mode branch as the tab bar/header active tint
  // (useShellScreenOptions): ember reads AA-unsafe at small sizes on the
  // white light-theme surface, so light mode uses the darker t.focus rust.
  const linkTint = active === "light" ? t.focus : t.accent;
  const label = activeContext === "fan" ? "Me (fan)" : activeContext.name;
  return (
    <>
      <Pressable onPress={() => setOpen(true)}
        style={{ padding: 8, flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Text variant="label" color={t.text}>{label}</Text>
        <IconCaretDown size={14} color={t.text} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        {/* rgba(0,0,0,0.5): the one sanctioned universal black modal
            backdrop (matches src/ui/Sheet.tsx), a neutral overlay behind
            the surface, not a brand token. */}
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)" }} onPress={() => setOpen(false)}>
          <View style={{ marginTop: 80, marginHorizontal: 24, backgroundColor: t.surface, borderRadius: 12, padding: 8 }}>
            <Pressable onPress={() => { switchTo("fan"); setOpen(false); router.replace("/(fan)"); }} style={{ padding: 12 }}>
              <Text color={t.text}>Me (fan)</Text>
            </Pressable>
            {myProfiles.map((p) => (
              <Pressable key={p.profileId} style={{ padding: 12 }}
                onPress={() => { switchTo(p); setOpen(false);
                  router.replace(p.type === "musician" ? "/(musician)/dashboard" : "/(curator)/dashboard"); }}>
                <Text color={t.text}>{p.name} ({p.type}){p.status !== "approved" ? ` (${p.status.replace("_", " ")})` : ""}</Text>
              </Pressable>
            ))}
            <Pressable onPress={() => { setOpen(false); router.push("/join"); }} style={{ padding: 12 }}>
              <Text variant="label" color={linkTint}>+ Join as musician or curator</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
