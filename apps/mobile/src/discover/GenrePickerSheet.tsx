import { useEffect, useState } from "react";
import { View } from "react-native";
import { doc, getDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { GENRES, genreTargetId, type UserDoc } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { useAuth } from "../auth/AuthProvider";
import { follow, useFollows } from "./useFollows";
import { formatChipLabel } from "./discoverQueries";
import { Text, Button, Chip, Sheet, ErrorBanner } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// SP7 Task 11: RN twin of apps/web/src/discover/GenrePicker.tsx, folded into
// one file per this task's own file map (web splits GenrePicker/
// useGenrePickerGate/PostPurchaseGenrePrompt across one module too, so this
// mirrors that grouping exactly, just as a Sheet instead of a Dialog).

async function callMarkGenrePickerSeen(): Promise<void> {
  await httpsCallable(getFirebase().functions, "markGenrePickerSeen")({});
}

// Whether the genre picker should open for this account: it hasn't been
// shown before (users/{uid}.genrePickerSeenAt unset) AND the fan doesn't
// already follow any genre. genrePickerSeenAt is read once (getDoc, not a
// live subscription: it only ever needs to reflect "has this been shown",
// which this hook's own markSeen already updates optimistically for
// same-session callers), while the genre-follow check reuses useFollows'
// live subscription. Byte-for-byte the web twin's own useGenrePickerGate.
export function useGenrePickerGate(uid: string | null): { shouldShow: boolean; markSeen: () => Promise<void> } {
  const { genres, loading: followsLoading } = useFollows(uid);
  const [seenAt, setSeenAt] = useState<number | null>(null);
  const [seenLoaded, setSeenLoaded] = useState(false);
  const [trackedUid, setTrackedUid] = useState(uid);
  if (uid !== trackedUid) {
    setTrackedUid(uid);
    setSeenAt(null);
    setSeenLoaded(false);
  }

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    getDoc(doc(getFirebase().db, "users", uid))
      .then((snap) => {
        if (cancelled) return;
        const data = snap.exists() ? (snap.data() as UserDoc) : undefined;
        setSeenAt(data?.genrePickerSeenAt ?? null);
        setSeenLoaded(true);
      })
      .catch(() => { if (!cancelled) setSeenLoaded(true); });
    return () => { cancelled = true; };
  }, [uid]);

  const markSeen = async () => {
    setSeenAt(Date.now()); // optimistic: avoids a re-open flash before the callable round-trips
    await callMarkGenrePickerSeen();
  };

  const shouldShow = uid != null && !followsLoading && seenLoaded && seenAt === null && genres.length === 0;
  return { shouldShow, markSeen };
}

// A sheet offering the GENRES list as toggle chips. "Done" follows every
// selected genre, then marks the picker seen; "Skip" only marks it seen. Any
// other dismissal (scrim tap, hardware back) routes through the identical
// `dismiss` handler via Sheet's own onClose, so it counts as a skip rather
// than leaving the picker eligible to reopen next load. Copy is byte-matched
// to the web twin.
export function GenrePickerSheet({ visible, onClose, preselected }: {
  visible: boolean; onClose: () => void; preselected?: string[];
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preselected ?? []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(genre: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(genre)) next.delete(genre); else next.add(genre);
      return next;
    });
  }

  async function dismiss(withFollows: boolean) {
    setSaving(true);
    setError(null);
    try {
      if (withFollows) {
        for (const genre of selected) await follow(genreTargetId(genre), "genre");
      }
      await callMarkGenrePickerSeen();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet visible={visible} onClose={() => { if (!saving) void dismiss(false); }}>
      <View style={{ gap: tokens.space.md }}>
        <View style={{ gap: 4 }}>
          <Text variant="title">What do you listen to?</Text>
          <Text muted>Pick a few and the feed leans that way. You can change this any time.</Text>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {GENRES.map((g) => (
            <Chip key={g} label={formatChipLabel(g)} active={selected.has(g)} onPress={() => toggle(g)} disabled={saving} />
          ))}
        </View>
        {error && <ErrorBanner message={error} />}
        <View style={{ flexDirection: "row", gap: tokens.space.sm }}>
          <Button title="Skip" variant="ghost" onPress={() => void dismiss(false)} disabled={saving} style={{ flex: 1 }} />
          <Button title="Done" onPress={() => void dismiss(true)} disabled={saving} style={{ flex: 1 }} />
        </View>
      </View>
    </Sheet>
  );
}

// The post-purchase nudge on the event screen's own "You're in." state
// (event/[eventId].tsx's paid-done branch, the ONLY place that mounts this;
// never in the buy flow itself). A quiet inline banner, not an
// auto-opened sheet: a fan who just finished checkout gets to look at their
// confirmation first and opens the picker on their own terms. Reads
// useGenrePickerGate itself (rather than taking `shouldShow` as a prop) so
// the banner and the sheet share one gate; onClose below calls this
// instance's own `markSeen` too (an extra, harmless call to the same
// idempotent callable) so `shouldShow` flips false immediately and the
// banner disappears with the sheet, matching the web twin's own comment.
export function PostPurchaseGenrePrompt({ eventGenres }: { eventGenres: string[] }) {
  const t = useTokens();
  const { user } = useAuth();
  const { shouldShow, markSeen } = useGenrePickerGate(user?.uid ?? null);
  const [open, setOpen] = useState(false);

  if (!shouldShow) return null;

  return (
    <View style={{
      // `t.success` + a "24" alpha byte (~14%) is the same soft-tint figure
      // Callout.tsx's own `tint()` helper uses for a status-colored surface;
      // reused here for a status-colored divider instead, inside the same
      // Callout tone="success" this component always mounts within.
      marginTop: tokens.space.md, borderTopWidth: 1, borderTopColor: `${t.success}24`,
      paddingTop: tokens.space.md, gap: tokens.space.sm,
    }}>
      <View style={{ gap: 2 }}>
        <Text variant="label">Want more shows like this?</Text>
        <Text muted>Pick a few genres and Discover leans that way. You can change this any time.</Text>
      </View>
      <Button title="Pick genres" variant="secondary" onPress={() => setOpen(true)} style={{ alignSelf: "flex-start" }} />
      <GenrePickerSheet
        visible={open}
        onClose={() => { setOpen(false); void markSeen(); }}
        preselected={eventGenres}
      />
    </View>
  );
}
