"use client";
import { useCallback, useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../../../src/ui/dialog";
import { Button } from "../../../src/ui/button";
import { IconCaretLeft, IconCaretRight, IconImages } from "../../../src/ui/icons";
import { cn } from "../../../src/lib/utils";

// Sub-project 9A task 10: the venue page's collage-header lightbox (spec
// section 6.6, docs/superpowers/mocks/sp9a/venue-page.html option A's
// "Open gallery" bubble). A client component (Dialog needs open/close and
// current-index state) rendered from CuratorProfile.tsx, a Server
// Component: that crossing is safe (a Server Component may render a "use
// client" component with plain serializable props), unlike importing a
// VALUE out of a client module into server code, which is the actual
// hazard this route family already got bitten by once (see
// CuratorProfile.tsx's own note on Task 9's RSC-boundary bug).
//
// The trigger uses the existing `variant="secondary"` Button as-is (this
// task's own hard rule: five button variants, no sixth invented for this
// one moment) with `bg-gk-surface` layered on top via className: the
// variant's own transparent fill would otherwise blend into whatever photo
// sits behind it. That's a token override (gk-surface), not a new color.

export function GalleryLightbox({ photos, name, triggerClassName }: {
  photos: string[]; name: string; triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  const showPrev = useCallback(() => setIndex((i) => (i - 1 + photos.length) % photos.length), [photos.length]);
  const showNext = useCallback(() => setIndex((i) => (i + 1) % photos.length), [photos.length]);

  // Nothing to open: no trigger, no dialog. Matches R-26 (no dead control)
  // rather than shipping a button that opens an empty gallery.
  if (photos.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setIndex(0); }}>
      <DialogTrigger asChild>
        <Button type="button" variant="secondary" size="sm" className={cn("bg-gk-surface", triggerClassName)}>
          <IconImages size={16} aria-hidden="true" />
          Open gallery
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-3xl"
        // Arrow-key navigation on top of the visible prev/next buttons
        // below (both satisfy R-32 independently: a keyboard user can Tab
        // to the buttons and press Enter/Space, or use the arrow keys once
        // focus is inside the dialog). Escape-to-close is Radix Dialog's
        // own default behavior, not reimplemented here.
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); showPrev(); }
          if (e.key === "ArrowRight") { e.preventDefault(); showNext(); }
        }}
      >
        <DialogTitle className="sr-only">{name} photo gallery</DialogTitle>
        <div className="relative overflow-hidden rounded-gk bg-gk-bg-0">
          <img
            src={photos[index]}
            alt={`${name} photo ${index + 1} of ${photos.length}`}
            className="max-h-[70vh] w-full object-contain"
          />
          {photos.length > 1 && (
            <>
              <button
                type="button"
                onClick={showPrev}
                aria-label="Previous photo"
                className="absolute left-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-gk-bg-0/70 text-gk-text outline-none transition-colors hover:bg-gk-bg-0/90 focus-visible:ring-2 focus-visible:ring-gk-focus"
              >
                <IconCaretLeft size={18} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={showNext}
                aria-label="Next photo"
                className="absolute right-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-gk-bg-0/70 text-gk-text outline-none transition-colors hover:bg-gk-bg-0/90 focus-visible:ring-2 focus-visible:ring-gk-focus"
              >
                <IconCaretRight size={18} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
        {photos.length > 1 && (
          <p aria-live="polite" className="text-center font-sora text-xs text-gk-muted">
            {index + 1} / {photos.length}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
