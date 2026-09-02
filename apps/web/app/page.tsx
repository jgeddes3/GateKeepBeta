import type { Metadata } from "next";
import { LandingHero } from "../src/marketing/LandingHero";
import {
  MusicianStorySection, CuratorStorySection, FanStorySection, HowItWorksSection, MoneySection,
  CityStorySection, ClosingCtaSection,
} from "../src/marketing/LandingSections";
import { SignedInRedirect } from "../src/marketing/SignedInRedirect";
import { Footer } from "../src/shell/Footer";

export const metadata: Metadata = {
  title: "GateKeep: Find the music. Book the night.",
  description: "Where this city's musicians and venues find each other.",
};

// The advertising page (spec section 5). AppShell (src/shell/AppShell.tsx)
// deliberately does not wrap "/": this route builds its own glass nav
// variant inside LandingHero instead of the signed-in slim top bar.
export default function Home() {
  return (
    <>
      <SignedInRedirect />
      <LandingHero />
      <main>
        <MusicianStorySection />
        <CuratorStorySection />
        <FanStorySection />
        <HowItWorksSection />
        <MoneySection />
        <CityStorySection />
        <ClosingCtaSection />
      </main>
      <Footer />
    </>
  );
}
