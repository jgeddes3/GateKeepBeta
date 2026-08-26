import { useState } from "react";
import { View, Text, TextInput, Pressable, Alert, ScrollView } from "react-native";
import { httpsCallable } from "firebase/functions";
import { useRouter } from "expo-router";
import { getFirebase } from "../src/lib/firebase";
import { useProfileContext } from "../src/shell/ProfileContext";
import { validateProfileDraft, type ProfileType } from "@gatekeep/shared";

const SUBTYPES: Record<ProfileType, { value: string; label: string }[]> = {
  musician: [{ value: "solo", label: "Solo act" }, { value: "band", label: "Band" }],
  curator: [{ value: "venue", label: "Venue" }, { value: "planner", label: "Event planner" },
            { value: "individual_host", label: "Individual host" }],
};

export default function Join() {
  const [type, setType] = useState<ProfileType>("musician");
  const [subtype, setSubtype] = useState("solo");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const router = useRouter();
  const { switchTo } = useProfileContext();

  const submit = async () => {
    const input = { type, subtype, name, handle: handle.toLowerCase() };
    const v = validateProfileDraft(input);
    if (!v.ok) { Alert.alert("Check your info", v.reason); return; }
    try {
      const { functions } = getFirebase();
      const { data } = await httpsCallable<typeof input, { profileId: string }>(
        functions, "createProfileDraft")(input);
      if (type === "musician") {
        // MUST FIX (Task 14): do NOT auto-submit a musician draft. Task 9's
        // minimum-content gate (bio, >=1 genre, avatar, >=1 listenable
        // track) means a brand-new draft can NEVER pass
        // submitProfileForReview — every auto-submit here would always fail
        // with failed-precondition. Route into the portfolio tab to collect
        // that content instead, mirroring web's join/page.tsx createDraft ->
        // router.push handoff. Curator joins (below) are unaffected — there's
        // no gate for them — and keep the old create-then-submit behavior.
        switchTo({ profileId: data.profileId, type: "musician", name: name.trim(), status: "draft" });
        Alert.alert("Draft created", "Add a bio, photo, and a track next, then submit for review.");
        router.replace("/(musician)/portfolio");
        return;
      }
      await httpsCallable(functions, "submitProfileForReview")({ profileId: data.profileId });
      Alert.alert("Submitted!", "Our team will review your profile. We'll notify you.");
      router.back();
    } catch (e: any) {
      Alert.alert("Couldn't submit", e?.message ?? "Try again.");
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 12 }} keyboardShouldPersistTaps="handled">
      <Text style={{ fontSize: 24, fontWeight: "700" }}>Join GateKeep</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {(["musician", "curator"] as const).map((t) => (
          <Pressable key={t} onPress={() => { setType(t); setSubtype(SUBTYPES[t][0].value); }}
            style={{ borderWidth: 1, padding: 10, borderRadius: 8, backgroundColor: type === t ? "#111" : "#fff" }}>
            <Text style={{ color: type === t ? "#fff" : "#111" }}>{t}</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {SUBTYPES[type].map((s) => (
          <Pressable key={s.value} onPress={() => setSubtype(s.value)}
            style={{ borderWidth: 1, padding: 10, borderRadius: 8, backgroundColor: subtype === s.value ? "#111" : "#fff" }}>
            <Text style={{ color: subtype === s.value ? "#fff" : "#111" }}>{s.label}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput placeholder="Name (band, venue, or your stage name)" value={name} onChangeText={setName}
        style={{ borderWidth: 1, padding: 12, borderRadius: 8 }} />
      <TextInput placeholder="Handle (yourname — lowercase, no spaces)" autoCapitalize="none"
        value={handle} onChangeText={setHandle} style={{ borderWidth: 1, padding: 12, borderRadius: 8 }} />
      <Pressable onPress={submit} style={{ backgroundColor: "#111", padding: 14, borderRadius: 8 }}>
        {/* Musician: create-only now (see the MUST FIX comment above) —
            "Submit for review" would be a lie until the portfolio tab's own
            gated button actually does that. Curator: unchanged, still
            submits immediately. */}
        <Text style={{ color: "#fff", textAlign: "center" }}>{type === "musician" ? "Create my profile" : "Submit for review"}</Text>
      </Pressable>
    </ScrollView>
  );
}
