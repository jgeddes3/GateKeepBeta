"use client";
import { useEffect, useState, type ReactNode } from "react";
import Image from "next/image";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/src/lib/utils";
import { HERO_IMAGES } from "./heroImages";

const ADVANCE_MS = 15_000;
const TRANSITION_S = 1.2;

// Full-viewport hero carousel (spec section 5.1). Images come from
// heroImages.ts (any count from 1 to N: a single image renders statically
// with no progress dots). Auto-advances LEFT every 15s with a slow slide
// plus a soft cross-dim, pauses on hover OR keyboard focus (WCAG 2.2.2:
// hover alone isn't a pause control a keyboard-only visitor can reach; see
// hovered/focused below), and collapses to the static first image under
// prefers-reduced-motion (no interval, no dots, no transition).
//
// data-theme="dark" is forced on this section deliberately, not a stray
// override: DESIGN.md documents --gk-scrim as the one token that never
// flips for the light theme, because it always sits over a dark photo.
// Everything drawn on top of that scrim here (the progress dots, plus
// LandingHero's nav/copy passed in as children) needs the same "always
// dark" foreground colors. CSS custom properties cascade from data-theme
// scoping on a subtree exactly like they do from the root toggle, so
// gk-text/gk-muted/gk-accent all resolve correctly here regardless of the
// visitor's chosen site theme, with no new token and no hardcoded hex.
export function HeroCarousel({ children }: { children?: ReactNode }) {
  const images = HERO_IMAGES;
  const hasMultiple = images.length > 1;
  const [index, setIndex] = useState(0);
  // Two separate booleans, not one shared "paused" flag: a mouse-and-
  // keyboard visitor can hover away from the hero while focus is still
  // inside it (or vice versa), and either one alone must keep it paused.
  // React's onFocus/onBlur are synthetic events that bubble (unlike native
  // DOM focus/blur), so a single pair of handlers on the section catches
  // focus moving to or away from any descendant, including the nav link,
  // both CTAs, and every dot below.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!hasMultiple || reducedMotion || paused) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % images.length), ADVANCE_MS);
    return () => clearInterval(id);
  }, [hasMultiple, reducedMotion, paused, images.length]);

  // Reduced motion always shows the first image, never advances.
  const activeIndex = reducedMotion ? 0 : index;
  const active = images[activeIndex];
  const animated = hasMultiple && !reducedMotion;

  return (
    <section
      data-theme="dark"
      className="relative h-dvh min-h-[560px] w-full overflow-hidden"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <div className="absolute inset-0">
        {animated ? (
          <AnimatePresence initial={false}>
            <motion.div
              key={active.src}
              className="absolute inset-0"
              initial={{ opacity: 0, x: "3%" }}
              animate={{ opacity: 1, x: "0%" }}
              exit={{ opacity: 0, x: "-3%" }}
              transition={{ duration: TRANSITION_S, ease: "easeInOut" }}
            >
              <Image
                src={active.src}
                alt={active.alt}
                fill
                priority={activeIndex === 0}
                sizes="100vw"
                className="object-cover"
              />
            </motion.div>
          </AnimatePresence>
        ) : (
          <Image src={active.src} alt={active.alt} fill priority sizes="100vw" className="object-cover" />
        )}
      </div>
      {/* Bottom-up night scrim (DESIGN.md's one recurring photo treatment):
          photos keep true color, the words below always sit on solid
          night. aria-hidden: purely decorative wash, not content. */}
      <div className="absolute inset-0" style={{ background: "var(--gk-scrim)" }} aria-hidden="true" />
      {children}
      {hasMultiple && !reducedMotion && (
        // Plain buttons in a labeled role="group", not the ARIA tablist/tab
        // pattern: that pattern requires roving tabindex, arrow-key
        // navigation, and aria-controls pointing at a real per-tab panel,
        // none of which fit a set of photo-picker dots (there's one shared
        // image layer, not N separate panels). A partial tablist (the
        // previous version here) is worse than no tablist: it tells
        // assistive tech to expect behavior that isn't there. Plain
        // Tab-reachable buttons, aria-current marking the visible photo,
        // and a descriptive aria-label per button is the simplest pattern
        // that's fully and honestly supported.
        <div
          role="group"
          aria-label="Hero photos"
          className="absolute inset-x-0 bottom-6 z-10 flex justify-center gap-1.5"
        >
          {images.map((img, i) => (
            <button
              key={img.src}
              type="button"
              aria-current={i === index}
              aria-label={`Show photo ${i + 1} of ${images.length}`}
              onClick={() => setIndex(i)}
              className={cn(
                "h-1.5 rounded-full outline-none transition-[width,background-color] duration-300",
                "focus-visible:ring-2 focus-visible:ring-gk-focus focus-visible:ring-offset-2 focus-visible:ring-offset-gk-bg-0",
                i === index ? "w-4 bg-gk-accent" : "w-1.5 bg-gk-text/35 hover:bg-gk-text/55",
              )}
            />
          ))}
        </div>
      )}
    </section>
  );
}
