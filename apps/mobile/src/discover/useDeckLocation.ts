import { useCallback, useEffect, useState } from "react";
import { Linking } from "react-native";
import * as Location from "expo-location";
import { markLocationPromptSeen, readLocationPromptSeen } from "./deckPrefs";

// SP7 Task 12: the deck's one-shot position, and the skippable sheet that
// asks for it (design spec section 6, "Location").
//
// The position lives in this hook's state for the length of one deck
// session and nowhere else: not AsyncStorage (deckPrefs.ts stores only
// `mute` and `locationPromptSeen`), not Firestore, not a log line. It is
// read once per mount and handed to getDiscoverDeck as a call argument.
//
// Coordinates are rounded to three decimals (roughly 110 m) before they
// leave the device. The server labels every distance "about" (shared
// distanceLabel) and coarsens venue geo for neighborhood-visibility
// addresses anyway, so full GPS precision would buy the ranking nothing
// and send more than the feature needs.
//
// A location failure never blocks the deck: every branch below ends with
// `location` still null, which is exactly the "no distances" fallback the
// spec asks for.

export type DeckLocation = { lat: number; lng: number };

export interface DeckLocationState {
  location: DeckLocation | null;
  // True until the answer is known: the stored prompt flag and the current
  // permission have been read, and if the sheet opened, the fan has
  // answered it. DeckScreen holds its first fetch until this clears so the
  // opening page is ranked with the position rather than fetched twice.
  resolving: boolean;
  promptVisible: boolean;
  allow: () => Promise<void>;
  dismiss: () => Promise<void>;
  enable: () => Promise<void>;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function useDeckLocation(): DeckLocationState {
  const [location, setLocation] = useState<DeckLocation | null>(null);
  const [resolving, setResolving] = useState(true);
  const [promptVisible, setPromptVisible] = useState(false);

  const readPosition = useCallback(async () => {
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setLocation({ lat: round(pos.coords.latitude), lng: round(pos.coords.longitude) });
    } catch {
      // No fix available (airplane mode, a simulator with no location set,
      // a hardware timeout). The deck ranks without distances.
      setLocation(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Permission granted in an earlier session needs no sheet: read the
        // position straight away and leave the prompt flag alone.
        const current = await Location.getForegroundPermissionsAsync();
        if (cancelled) return;
        if (current.granted) {
          await readPosition();
          if (!cancelled) setResolving(false);
          return;
        }
        const seen = await readLocationPromptSeen();
        if (cancelled) return;
        if (seen) {
          setResolving(false);
          return;
        }
        setPromptVisible(true);
      } catch {
        if (!cancelled) setResolving(false);
      }
    })();
    return () => { cancelled = true; };
  }, [readPosition]);

  const allow = useCallback(async () => {
    setPromptVisible(false);
    void markLocationPromptSeen();
    try {
      const result = await Location.requestForegroundPermissionsAsync();
      if (result.granted) await readPosition();
    } catch {
      // Swallowed on purpose: see the header note.
    } finally {
      setResolving(false);
    }
  }, [readPosition]);

  const dismiss = useCallback(async () => {
    setPromptVisible(false);
    setResolving(false);
    await markLocationPromptSeen();
  }, []);

  // The "Turn on location" path out of the empty state. Once canAskAgain is
  // false the OS dialog is gone for good and requestForegroundPermissions
  // resolves denied without showing anything, so this falls through to the
  // Settings app instead, the same fallback ScannerScreen.tsx uses for the
  // camera.
  const enable = useCallback(async () => {
    setPromptVisible(false);
    void markLocationPromptSeen();
    try {
      const result = await Location.requestForegroundPermissionsAsync();
      if (result.granted) await readPosition();
      else if (!result.canAskAgain) await Linking.openSettings();
    } catch {
      // Same as above: a failed request leaves the deck without distances.
    } finally {
      setResolving(false);
    }
  }, [readPosition]);

  return { location, resolving, promptVisible, allow, dismiss, enable };
}
