"use client";
import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { ref as storageRef, uploadBytes } from "firebase/storage";
import { MAX_PHOTO_UPLOAD_BYTES, stagingPhotoPath, type PosterUploadDoc } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { useAuth } from "../auth/AuthProvider";
import { cn } from "../lib/utils";
import { posterPublicUrl } from "./posterUrl";
import { Button } from "../ui/button";
import { IconImage, IconTrash, IconUpload, IconWarning } from "../ui/icons";

// The event poster picker (Task 28). Same staging mechanics as
// PortfolioForms.tsx's PhotoUploader (upload to staging/photos with the
// "poster" kind, the pipeline resizes and strips it), with one difference: a
// poster has no profile field for the pipeline to write back to
// (functions/src/media.ts's poster branch), so completion is observed on
// posterUploads/{uid}/uploads/{nonce}, the doc processPhoto writes for this kind,
// owner-readable only. The processed public path reaches the parent through
// onChange; the parent's Save sends it as updateEvent's posterPath, which
// the server checks against the curator profile prefix (resolvePosterPath).
type Phase =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "processing"; nonce: string }
  | { kind: "error"; message: string };

export function PosterField({ curatorProfileId, value, onChange, disabled }: {
  curatorProfileId: string;
  value: string | null;
  onChange: (path: string | null) => void;
  disabled?: boolean;
}) {
  const { user } = useAuth();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const previewUrl = posterPublicUrl(value);

  // Watch the pipeline's completion doc for the nonce in flight. Bounded to
  // 60 s like PhotoUploader: a rejected image (corrupt, oversized after
  // decode) never produces the doc, and the picker must not lock forever.
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

  const upload = async (f: File) => {
    if (!user) return;
    if (f.size > MAX_PHOTO_UPLOAD_BYTES) { setPhase({ kind: "error", message: "Posters must be under 10 MB." }); return; }
    setPhase({ kind: "uploading" });
    try {
      const nonce = crypto.randomUUID();
      const path = stagingPhotoPath(user.uid, curatorProfileId, "poster", nonce);
      await uploadBytes(storageRef(getFirebase().storage, path), f, { contentType: f.type });
      setPhase({ kind: "processing", nonce });
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : "Upload failed." });
    }
  };

  const locked = Boolean(disabled) || phase.kind === "uploading" || phase.kind === "processing";
  const buttonLabel = phase.kind === "uploading" ? "Uploading…"
    : phase.kind === "processing" ? "Processing…"
    : value ? "Replace poster" : "Upload poster";

  return (
    <div className="grid gap-2">
      <div className="relative h-40 w-full max-w-sm overflow-hidden rounded-gk border border-gk-border bg-gk-surface">
        {previewUrl ? (
          <img src={previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div
            aria-hidden="true"
            className="absolute inset-0 flex items-center justify-center text-gk-muted/40"
            style={{ background: "linear-gradient(155deg, var(--gk-surface) 0%, var(--gk-border) 100%)" }}
          >
            <IconImage size={32} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* A label wrapping a visually hidden file input: keyboard reachable
            (sr-only keeps it in the tab order, unlike display:none), 44px
            tall, secondary-button styling from the same tokens button.tsx's
            "secondary" variant uses. */}
        <label
          className={cn(
            "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-gk border border-gk-border px-4 font-sora text-sm font-medium text-gk-text transition-colors hover:bg-gk-border/40 focus-within:ring-2 focus-within:ring-gk-focus",
            locked && "cursor-not-allowed opacity-50",
          )}
        >
          <IconUpload size={16} aria-hidden="true" />
          {buttonLabel}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            disabled={locked}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = ""; // allows re-picking the same file after a failure
              if (f) void upload(f);
            }}
          />
        </label>
        {value && !locked && (
          <Button type="button" variant="ghost" size="sm" className="min-h-11 text-gk-destructive" onClick={() => onChange(null)}>
            <IconTrash size={16} aria-hidden="true" />
            Remove poster
          </Button>
        )}
      </div>
      <p className="font-sora text-xs text-gk-muted">
        JPEG, PNG, or WebP up to 10 MB. Shown at the top of the event page and as the preview when the link is shared.
        Saved with the rest of the event when you press Save changes.
      </p>
      {phase.kind === "error" && (
        <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {phase.message}
        </p>
      )}
    </div>
  );
}
