// Hero carousel image list (spec section 5.1 / section 9). The three files
// below (public/hero/hero-1.jpg, hero-2.jpg, hero-3.jpg) are placeholder
// gradient/color-field stand-ins generated with ffmpeg's lavfi "gradients"
// source filter at 2560x1440, not real concert photography (see the task 4
// report for the exact commands). Any count from 1 to N works here:
// HeroCarousel renders a single image statically with no progress dots for
// one entry, and auto-advances through N.
//
// SWAP PATH: once the owner's real photo folder arrives (2560x1440 JPG,
// 16:9, minimum 1920x1080, subject in the middle 60%, per spec section 9),
// drop the real files into public/hero/, point this list at them, and
// delete the placeholder JPGs. Tracked in README's sub-project 9A launch
// checklist.
export type HeroImage = { src: string; alt: string };

// alt="" on every entry: these are decorative background photography, not
// informational images. The headline, sub-line, and CTAs that actually
// carry the page's content render as real text over the scrim (see
// LandingHero), so a screen reader loses nothing by skipping the photo.
export const HERO_IMAGES: HeroImage[] = [
  { src: "/hero/hero-1.jpg", alt: "" },
  { src: "/hero/hero-2.jpg", alt: "" },
  { src: "/hero/hero-3.jpg", alt: "" },
];
