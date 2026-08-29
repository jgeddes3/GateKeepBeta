import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { CURATOR_FEE_PCT, MUSICIAN_FEE_PCT, DEPOSIT_PERCENT } from "@gatekeep/shared";
import { Button } from "@/src/ui/button";
import { cn } from "@/src/lib/utils";

// Below-fold landing sections, spec section 5 items 2-6. Each section has
// its own composition (two-column alternating stories, a numbered list, a
// prose block with inline chips, a centered statement, a centered closer)
// rather than repeating one card-grid template: DESIGN.md's RHYTHM 2 dial
// calls for page anatomies that vary deliberately, and the landing page is
// its own named example ("the landing page alternates section alignment").

// Task 12: real captures of the redesigned app, replacing Task 4's honest
// placeholder frame. Both public/marketing/*.jpg files are dark-theme
// screenshots of the actual running app (public/, unauthenticated surfaces
// only: signing in was not available to capture the signed-in dashboards
// the spec originally named), taken at the seeded test account's real
// state, not staged or fabricated content. Dimensions are read from the
// files themselves (next/image requires width/height for a non-fill
// image), not hardcoded to a round number.
function AudienceSection({
  heading, paragraphs, ctaLabel, reverse, imageSrc, imageAlt, imageWidth, imageHeight,
}: {
  heading: string;
  paragraphs: string[];
  ctaLabel: string;
  reverse?: boolean;
  imageSrc: string;
  imageAlt: string;
  imageWidth: number;
  imageHeight: number;
}) {
  return (
    <section className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-2 lg:items-center lg:gap-16">
      <div className={cn(reverse && "lg:order-2")}>
        <h2 className="font-syne text-3xl font-extrabold leading-tight text-gk-text sm:text-4xl">{heading}</h2>
        <div className="mt-4 space-y-4 font-sora text-base leading-relaxed text-gk-muted">
          {paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
        <Button asChild variant="secondary" className="mt-6">
          <Link href="/sign-in">{ctaLabel}</Link>
        </Button>
      </div>
      <div className={cn("overflow-hidden rounded-gk border border-gk-border bg-gk-surface", reverse && "lg:order-1")}>
        <Image
          src={imageSrc}
          alt={imageAlt}
          width={imageWidth}
          height={imageHeight}
          className="aspect-[4/3] w-full object-cover object-top sm:aspect-video"
          sizes="(min-width: 1024px) 50vw, 100vw"
        />
      </div>
    </section>
  );
}

export function MusicianStorySection() {
  return (
    <AudienceSection
      heading="Your act, findable."
      paragraphs={[
        "Build a portfolio once: bio, photos, a few tracks. Curators browsing for a Friday night find you there, or invite you straight from a gig they're staffing.",
        "When an offer comes in, you negotiate the details right in the thread until the terms are right. Then it's booked.",
      ]}
      ctaLabel="Start your musician profile"
      imageSrc="/marketing/artist-page.jpg"
      imageAlt="A musician's public artist page on GateKeep, showing the Syne name, genre and act-size chips, and the about section on the dark night-scrim background."
      imageWidth={1568}
      imageHeight={340}
    />
  );
}

export function CuratorStorySection() {
  return (
    <AudienceSection
      heading="Fill the calendar, not your inbox."
      paragraphs={[
        "Post a gig and let musicians apply, or go straight to a profile you like and send an offer. Either way you're looking at real portfolios, bios, photos, tracks, not a stack of files in your inbox.",
        "A deposit locks in the moment you both agree on terms, so the night doesn't fall apart on a handshake.",
      ]}
      ctaLabel="Start booking talent"
      imageSrc="/marketing/find-gigs-browse.jpg"
      imageAlt="The Find gigs browse page on GateKeep, showing city and genre filters above the open-gigs list."
      imageWidth={1568}
      imageHeight={380}
      reverse
    />
  );
}

// Spec 5.3: the true four-step flow, numbered plainly. Deliberately not a
// round-icon-plus-number template (the AI-default "How It Works" shape) and
// deliberately four steps, not the default three, because that's what the
// actual flow is.
export function HowItWorksSection() {
  const steps = [
    {
      n: "01",
      title: "Browse, or get found",
      body: "Musicians look through open gigs. Curators look through profiles, or post a gig and let musicians apply.",
    },
    {
      n: "02",
      title: "Negotiate",
      body: "Offers and counters happen in one thread until the price and details are set on both sides.",
    },
    {
      n: "03",
      title: "Play the gig",
      body: "Show up, load in, play the set.",
    },
    {
      n: "04",
      title: "Money settles automatically",
      body: "The deposit is already in escrow. The rest moves once the gig wraps, no invoices to chase.",
    },
  ];
  return (
    <section className="border-t border-gk-border">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
        <h2 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">How it actually works</h2>
        <ol className="mt-10 grid gap-x-10 gap-y-10 sm:grid-cols-2">
          {steps.map((step) => (
            <li key={step.n}>
              {/* Post-launch review fix: this section sits below the fold on
                  the normal page background (not the always-dark hero
                  scrim), so it follows whatever theme the visitor has
                  chosen. Bare ember text fails AA on a light-theme surface
                  (DESIGN.md's accessibility note, ~2.6-2.8:1); text-gk-focus
                  is the branch's established AA-safe substitute, ember
                  itself in dark theme and the same-hue #BF5038 in light. */}
              <span className="font-syne text-2xl font-extrabold text-gk-focus">{step.n}</span>
              <h3 className="mt-2 font-syne text-lg font-semibold text-gk-text">{step.title}</h3>
              <p className="mt-1 font-sora text-sm leading-relaxed text-gk-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// Ember as bare text fails AA on a light-theme surface (DESIGN.md's own
// accessibility note measures it at ~2.6-2.8:1), and this section is on the
// normal page background, not the always-dark hero scrim, so it follows
// whatever theme the visitor has chosen. DESIGN.md's prescribed fix for a
// "price in ember" moment on a surface like this is a filled chip, not bare
// colored text: ember background, on-accent foreground, which is exactly
// what this section's numbers are (real prices/fees, one of the accent's
// named sanctioned uses).
function MoneyChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-gk-accent px-2 py-0.5 font-syne font-bold text-gk-on-accent">
      {children}
    </span>
  );
}

// Spec 5.4: the real fees, imported from @gatekeep/shared (never
// hardcoded), as transparency prose rather than a pricing-tier layout.
export function MoneySection() {
  const musicianKeepsPct = 100 - MUSICIAN_FEE_PCT;
  return (
    <section className="border-t border-gk-border bg-gk-surface/40">
      <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6 sm:py-24">
        <h2 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">The money, stated plainly</h2>
        <div className="mt-6 space-y-5 font-sora text-base leading-relaxed text-gk-muted">
          <p>
            Curators pay a <MoneyChip>{CURATOR_FEE_PCT}%</MoneyChip> booking fee on top of what
            they offer. Musicians keep <MoneyChip>{musicianKeepsPct}%</MoneyChip> of that offer.
          </p>
          <p>
            When a booking is confirmed, a <MoneyChip>{DEPOSIT_PERCENT}%</MoneyChip> deposit moves
            into escrow right away, so both sides know the money is real before load-in.
          </p>
        </div>
      </div>
    </section>
  );
}

// Spec 5.5: the launch-metro story. No specific city is named here: the
// real launch metro hasn't been decided yet (see LAUNCH_TIMEZONE's own
// placeholder in @gatekeep/shared and its README launch-checklist entry),
// and naming one would be inventing a fact rather than reporting one. The
// "one city" framing itself is real, from the foundation spec's own
// "launching in a single metro area."
export function CityStorySection() {
  return (
    <section className="border-t border-gk-border">
      <div className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6 sm:py-24">
        <h2 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">One city, every stage</h2>
        <p className="mt-6 font-sora text-base leading-relaxed text-gk-muted">
          GateKeep is starting in one city. Every gig, every profile, every payout happens there
          first, dive bars and wedding venues and backyard shows alike, before the map gets any
          bigger.
        </p>
      </div>
    </section>
  );
}

// Spec 5.6: role-split closing CTA. Footer renders separately at the page
// level (the existing shell Footer component, not duplicated here).
export function ClosingCtaSection() {
  return (
    <section className="border-t border-gk-border bg-gk-surface/40">
      <div className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6 sm:py-24">
        <h2 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">
          Ready to book, or get booked?
        </h2>
        <p className="mt-4 font-sora text-base text-gk-muted">
          Pick a side to start. One account can hold both later.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg">
            <Link href="/sign-in">I&apos;m a musician</Link>
          </Button>
          <Button asChild variant="secondary" size="lg">
            <Link href="/sign-in">I book talent</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
