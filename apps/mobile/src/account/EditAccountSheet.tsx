import { useEffect, useState } from "react";
import { View, KeyboardAvoidingView, Platform } from "react-native";
import { doc, getDoc } from "firebase/firestore";
import {
  ACCOUNT_NAME_HELP, ACCOUNT_CITY_HELP, ACCOUNT_SAVED_MESSAGE, ACCOUNT_GEOCODE_MISS_MESSAGE,
  type UpdateAccountInput, type UpdateAccountResult, type UserDoc,
} from "@gatekeep/shared";
import { useAuth } from "../auth/AuthProvider";
import { callFn } from "../lib/callable";
import { getFirebase } from "../lib/firebase";
import { Text, Button, Input, Sheet, ErrorBanner } from "../ui";
import { tokens } from "../theme/tokens";

// SP11 Task 13 (spec section 3.3): the mobile twin of apps/web/src/account/
// AccountCard.tsx (SP11 Task 9). Same payload shape, same five copy
// constants, same "success re-reads the doc" behaviour so a geocoder miss
// (city text kept, homeGeo null) is reflected exactly as the server left it.
// The one platform difference beyond shape (a Sheet instead of a page card)
// is that this component is mounted once at the end of AccountScreen and
// toggled by `visible`, so the seed read below keys off `visible` (each
// open re-reads the doc) rather than mount, and the sheet only closes on the
// fan's own dismiss (the Sheet's scrim/back handling, or the Close button
// here) so a just-shown "Saved." message stays on screen to be read instead
// of vanishing with an auto-close.
export function EditAccountSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [savedName, setSavedName] = useState("");
  const [savedCity, setSavedCity] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // The closed-to-open transition, tracked during render (same pattern
  // useHomeGeo.ts uses for its own trackedUid guard) rather than as a
  // synchronous setState at the top of the effect below: this is what
  // clears a stale error/status/loaded flag from a previous open before the
  // fresh getDoc lands, without scheduling an extra render from inside the
  // effect (fix round 1, finding 3).
  const [trackedOpen, setTrackedOpen] = useState(false);
  if (visible && !trackedOpen) {
    setTrackedOpen(true);
    setLoaded(false);
    setError(null);
    setStatus(null);
  } else if (!visible && trackedOpen) {
    setTrackedOpen(false);
  }

  useEffect(() => {
    if (!visible || !uid) return;
    let cancelled = false;
    (async () => {
      const snap = await getDoc(doc(getFirebase().db, "users", uid));
      if (cancelled) return;
      const d = snap.data() as UserDoc | undefined;
      const n = d?.displayName ?? "";
      const c = d?.homeCity ?? "";
      setName(n);
      setCity(c);
      setSavedName(n);
      setSavedCity(c);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [visible, uid]);

  const dirty = name !== savedName || city !== savedCity;

  const save = async () => {
    if (!uid) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const { data } = await callFn<UpdateAccountInput, UpdateAccountResult>("updateAccount", {
        displayName: name.trim(), homeCity: city.trim() === "" ? null : city.trim(),
      });
      setStatus(data.geocoded === false ? ACCOUNT_GEOCODE_MISS_MESSAGE : ACCOUNT_SAVED_MESSAGE);
      const snap = await getDoc(doc(getFirebase().db, "users", uid));
      const d = snap.data() as UserDoc | undefined;
      const n = d?.displayName ?? "";
      const c = d?.homeCity ?? "";
      setName(n);
      setCity(c);
      setSavedName(n);
      setSavedCity(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your account.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      {/* Sheet itself takes no stance on keyboard avoidance (its own header
          comment: "a caller putting a form inside a Sheet is responsible for
          its own KeyboardAvoidingView"); without this, the keyboard covers
          the Home city field and the Save/Close row on device, same pattern
          ShowPosts.tsx's PostComposerSheet and GigDetailSheet.tsx already
          use for their own Sheet-hosted forms. iOS needs an explicit
          "padding" behavior to shift the sheet's own content up; Android's
          own default resize behavior already handles this without one, so
          `behavior` is left undefined there rather than forcing a second,
          redundant shift. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={{ gap: tokens.space.md }}>
          <Text variant="title">Edit account</Text>
          <View style={{ gap: 4 }}>
            <Text variant="label">Display name</Text>
            <Input
              value={name}
              onChangeText={(v) => { setName(v); setStatus(null); }}
              maxLength={80}
              editable={!busy && loaded}
            />
            <Text variant="meta" muted>{ACCOUNT_NAME_HELP}</Text>
          </View>
          <View style={{ gap: 4 }}>
            <Text variant="label">Home city</Text>
            <Input
              value={city}
              onChangeText={(v) => { setCity(v); setStatus(null); }}
              maxLength={80}
              editable={!busy && loaded}
            />
            <Text variant="meta" muted>{ACCOUNT_CITY_HELP}</Text>
          </View>
          <ErrorBanner message={error} />
          {status && <Text variant="meta" muted>{status}</Text>}
          <View style={{ flexDirection: "row", gap: tokens.space.sm }}>
            <Button title={busy ? "Saving…" : "Save"} onPress={() => void save()} disabled={busy || !loaded || !dirty} style={{ flex: 1 }} />
            <Button title="Close" variant="secondary" onPress={onClose} disabled={busy} style={{ flex: 1 }} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Sheet>
  );
}
