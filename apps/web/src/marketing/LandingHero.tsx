import Link from "next/link";
import { Button } from "@/src/ui/button";
import { HeroCarousel } from "./HeroCarousel";

// The glass nav (brand + Sign in) is one of exactly two product-wide glass
// uses (DESIGN.md "Glass cap"): a translucent, blurred bar over the hero
// photo is the one place this reads as intentional rather than a default,
// because it needs to stay legible over shifting photography rather than
// sitting on a flat surface. bg-gk-bg-0/35 (not an arbitrary black) keeps
// it a real token even translucent.
function LandingNav() {
  return (
    <header className="absolute inset-x-0 top-0 z-20 border-b border-gk-text/10 bg-gk-bg-0/35 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="font-syne text-lg font-extrabold text-gk-accent">
          GateKeep
        </Link>
        {/* Ghost pill, not the standard 10px-radius "secondary" button:
            DESIGN.md's own component roster defines secondary as an
            outlined ghost at the card/input radius tier, but the
            owner-approved hero mock (docs/superpowers/mocks/sp9a/
            landing-hero.html, option A) locks BOTH hero-area buttons to a
            pill shape, reading here as two co-equal actions floating over
            a photo rather than a primary/secondary pair on a surface. The
            border color is overridden too: gk-border is tuned for
            surface-on-surface separation and is too low-contrast over a
            photo, where the mock's own border is a white-based
            translucency instead. Scoped to this hero context only, not a
            change to the shared button variant. */}
        <Button
          asChild
          variant="secondary"
          size="sm"
          className="rounded-full border-gk-text/40 bg-transparent text-gk-text hover:border-gk-text/60 hover:bg-gk-text/10"
        >
          <Link href="/sign-in">Sign in</Link>
        </Button>
      </div>
    </header>
  );
}

function HeroCopy() {
  return (
    <div className="absolute inset-x-0 bottom-20 z-10 px-4 sm:bottom-24 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <h1 className="max-w-md font-syne text-4xl font-extrabold leading-[1.05] text-gk-text sm:max-w-lg sm:text-5xl">
          Find the music.
          <br />
          Book the night.
        </h1>
        <p className="mt-3 max-w-sm font-sora text-sm text-gk-text/75 sm:text-base">
          Where this city&apos;s musicians and venues find each other.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button asChild size="lg">
            <Link href="/sign-in">I&apos;m a musician</Link>
          </Button>
          <Button
            asChild
            variant="secondary"
            size="lg"
            className="rounded-full border-gk-text/40 bg-transparent text-gk-text hover:border-gk-text/60 hover:bg-gk-text/10"
          >
            <Link href="/sign-in">I book talent</Link>
          </Button>
          <Button asChild variant="link" size="lg" className="text-gk-text">
            <Link href="/discover">Find a show</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

// The landing page's hero: HeroCarousel's photos/scrim/dots, with the glass
// nav and bottom-left copy block (spec section 5.1, mock option A) laid on
// top as children. The musician and curator buttons point at /sign-in:
// there is no separate sign-up route today (the toggle on that page itself
// is "New here? Create an account"), so this is the real, working
// destination for both paths. Task 10 adds a third, lower-emphasis path for
// fans: a link-style button to /discover, the real browse destination.
export function LandingHero() {
  return (
    <HeroCarousel>
      <LandingNav />
      <HeroCopy />
    </HeroCarousel>
  );
}
