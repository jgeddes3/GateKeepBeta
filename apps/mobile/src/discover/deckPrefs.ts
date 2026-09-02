import AsyncStorage from "@react-native-async-storage/async-storage";

// SP7 Task 12: the swipe deck's two device-local preferences, and the ONLY
// two keys this feature is allowed to write.
//
// Binding rule (design spec section 2.9, "the fan's position is
// request-scoped and never stored"): the position expo-location hands back
// lives in useDeckLocation's component state for the length of one deck
// session and goes nowhere else. It is never written here, never written to
// Firestore, and never logged. `locationPromptSeen` records only that the
// sheet was shown once, not the answer and not a coordinate.
//
// Every read and write below swallows its own failure: AsyncStorage is a
// convenience here, and a device that cannot read it should still get a
// working deck (unmuted, prompt shown once more) rather than an error.

const MUTE_KEY = "gk.deck.mute";
const LOCATION_PROMPT_SEEN_KEY = "gk.deck.locationPromptSeen";

export async function readDeckMute(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(MUTE_KEY)) === "1";
  } catch {
    return false;
  }
}

export async function writeDeckMute(muted: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // A dropped preference costs the fan one tap next launch, nothing more.
  }
}

export async function readLocationPromptSeen(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(LOCATION_PROMPT_SEEN_KEY)) === "1";
  } catch {
    return false;
  }
}

export async function markLocationPromptSeen(): Promise<void> {
  try {
    await AsyncStorage.setItem(LOCATION_PROMPT_SEEN_KEY, "1");
  } catch {
    // Same tradeoff as writeDeckMute: the sheet may appear once more.
  }
}
