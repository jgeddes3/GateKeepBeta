import { View, Text, Pressable, Modal } from "react-native";
import { useState } from "react";
import { useRouter } from "expo-router";
import { useProfileContext } from "./ProfileContext";

export function ContextSwitcher() {
  const { activeContext, myProfiles, switchTo } = useProfileContext();
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const label = activeContext === "fan" ? "Me (fan)" : activeContext.name;
  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={{ padding: 8 }}>
        <Text style={{ fontWeight: "600" }}>{label} ▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: "#0006" }} onPress={() => setOpen(false)}>
          <View style={{ marginTop: 80, marginHorizontal: 24, backgroundColor: "#fff", borderRadius: 12, padding: 8 }}>
            <Pressable onPress={() => { switchTo("fan"); setOpen(false); router.replace("/(fan)"); }} style={{ padding: 12 }}>
              <Text>Me (fan)</Text>
            </Pressable>
            {myProfiles.map((p) => (
              <Pressable key={p.profileId} style={{ padding: 12 }}
                onPress={() => { switchTo(p); setOpen(false);
                  router.replace(p.type === "musician" ? "/(musician)/dashboard" : "/(curator)/dashboard"); }}>
                <Text>{p.name} ({p.type}){p.status !== "approved" ? ` — ${p.status.replace("_", " ")}` : ""}</Text>
              </Pressable>
            ))}
            <Pressable onPress={() => { setOpen(false); router.push("/join"); }} style={{ padding: 12 }}>
              <Text style={{ color: "#2563eb" }}>+ Join as musician or curator</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
