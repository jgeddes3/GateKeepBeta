import { useEffect, useState } from "react";
import { Image, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { doc, onSnapshot } from "firebase/firestore";
import { ref as storageRef, uploadBytes } from "firebase/storage";
import { MAX_PHOTO_UPLOAD_BYTES, stagingPhotoPath, type PosterUploadDoc } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { useAuth } from "../auth/AuthProvider";
import { posterPublicUrl } from "./eventDisplay";
import { Text, Button, ErrorBanner, PhotoPlaceholder, IconImage, IconUploadSimple, IconTrash } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// RN twin of apps/web/src/events/PosterField.tsx (Task 28). Same picker and
// staging mechanics as src/portfolio/PortfolioForms.tsx's PhotoUploader
// (expo-document-picker, a timestamp nonce, uploadBytes to the "poster"
// staging path), completion observed on posterUploads/{uid}/uploads/{nonce}. The
// mobile event screen has no content form (that stays web-only, see its own
// header), so onChange here is the save: the parent calls updateEvent with the
// event's current fields plus the new posterPath the moment the pipeline
// reports the processed path.
type Phase =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "processing"; nonce: string }
  | { kind: "error"; message: string };

export function PosterField({ curatorProfileId, value, onChange, saving, saveError }: {
  curatorProfileId: string;
  value: string | null;
  onChange: (path: string | null) => void;
  saving: boolean;
  saveError: string | null;
}) {
  const { user } = useAuth();
  const t = useTokens();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const previewUrl = posterPublicUrl(value);

  useEffect(() => {
    if (phase.kind !== "processing" || !user) return;
    const nonce = phase.nonce;
    const { db } = getFirebase();
    const timer = setTimeout(
      () => setPhase({ kind: "error", message: "Still processing. If the poster doesn't appear, try a smaller image." }),
      60_000,
    );
    const unsub = onSnapshot(doc(db, `posterUploads/${user.uid}/uploads/${nonce}`),
      (s) => {
        if (!s.exists()) return;
        onChange((s.data() as PosterUploadDoc).path);
        setPhase({ kind: "idle" });
      },
      (e) => setPhase({ kind: "error", message: e.message }));
    return () => { clearTimeout(timer); unsub(); };
  }, [phase, user, onChange]);

  const upload = async () => {
    if (!user) return;
    const res = await DocumentPicker.getDocumentAsync({ type: "image/*", copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    if ((a.size ?? 0) > MAX_PHOTO_UPLOAD_BYTES) { setPhase({ kind: "error", message: "Posters must be under 10 MB." }); return; }
    setPhase({ kind: "uploading" });
    try {
      // RN has no crypto.randomUUID: timestamp plus random, same as PhotoUploader.
      const nonce = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      const blob = await (await fetch(a.uri)).blob();
      await uploadBytes(storageRef(getFirebase().storage, stagingPhotoPath(user.uid, curatorProfileId, "poster", nonce)), blob,
        { contentType: a.mimeType ?? "image/jpeg" });
      setPhase({ kind: "processing", nonce });
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : "Upload failed." });
    }
  };

  const locked = saving || phase.kind === "uploading" || phase.kind === "processing";
  const label = saving ? "Saving…"
    : phase.kind === "uploading" ? "Uploading…"
    : phase.kind === "processing" ? "Processing…"
    : value ? "Replace poster" : "Upload poster";

  return (
    <View style={{ gap: tokens.space.sm }}>
      <View style={{ height: 160, borderRadius: tokens.radius.card, overflow: "hidden", borderWidth: 1, borderColor: t.border }}>
        {previewUrl
          ? <Image source={{ uri: previewUrl }} style={{ width: "100%", height: "100%" }} accessibilityIgnoresInvertColors />
          : <PhotoPlaceholder icon={<IconImage size={32} color={t.muted} />} />}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: tokens.space.sm }}>
        <Button variant="secondary" onPress={() => void upload()} disabled={locked} accessibilityLabel={label}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.xs }}>
            <IconUploadSimple size={16} color={t.text} />
            <Text variant="label">{label}</Text>
          </View>
        </Button>
        {value && !locked && (
          <Button variant="ghost" onPress={() => onChange(null)} accessibilityLabel="Remove poster">
            <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.xs }}>
              <IconTrash size={16} color={t.destructive} />
              <Text variant="label" color={t.destructive}>Remove poster</Text>
            </View>
          </Button>
        )}
      </View>
      <Text variant="meta" muted>
        JPEG, PNG, or WebP up to 10 MB. Shown at the top of the event page and as the preview when the link is shared.
      </Text>
      <ErrorBanner message={phase.kind === "error" ? phase.message : saveError} />
    </View>
  );
}
