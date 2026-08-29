import type { Metadata } from "next";
import { LegalPage, LegalSection } from "../../src/marketing/LegalPage";
import { Footer } from "../../src/shell/Footer";

export const metadata: Metadata = {
  title: "Privacy Policy | GateKeep",
  robots: { index: false, follow: false },
};

// Placeholder legal text (spec section 6.9 / section 5 item 6): real,
// counsel-reviewed language replaces this before launch. See README's
// sub-project 9A launch checklist.
export default function PrivacyPage() {
  return (
    <>
      <LegalPage title="Privacy Policy" bannerNoun="privacy policy">
        <LegalSection heading="What this covers">
          <p>
            This policy covers the personal information GateKeep collects through gatekeep.app and
            the GateKeep mobile app, and how we use it.
          </p>
        </LegalSection>
        <LegalSection heading="Information we collect">
          <p>
            Account details you give us (name, email, handle), profile content you choose to add
            (bio, photos, audio tracks, venue details), booking activity (offers, gigs, messages
            inside a booking thread), and payment and payout information handled by our payment
            processor, Stripe. We don&apos;t see or store your full card number ourselves; Stripe
            does.
          </p>
        </LegalSection>
        <LegalSection heading="How we use it">
          <p>
            To run the marketplace: match musicians and curators, process bookings and payouts,
            show your profile to the people it&apos;s meant for, and send the notifications a
            booking actually requires. We don&apos;t sell your information.
          </p>
        </LegalSection>
        <LegalSection heading="Who we share it with">
          <p>
            The other side of a booking sees what a booking requires (your profile, your offer
            terms). Stripe processes payments and payouts on our behalf. We share information when
            the law requires it.
          </p>
        </LegalSection>
        <LegalSection heading="Your controls">
          <p>
            You can edit your profile at any time. You can delete your account and its data from
            your dashboard; that action is permanent.
          </p>
        </LegalSection>
        <LegalSection heading="Children">
          <p>
            GateKeep isn&apos;t directed at children, and we don&apos;t knowingly collect
            information from them.
          </p>
        </LegalSection>
        <LegalSection heading="Security">
          <p>
            We take reasonable measures to protect your information, but no system is perfectly
            secure and we can&apos;t guarantee one.
          </p>
        </LegalSection>
        <LegalSection heading="Changes to this policy">
          <p>We&apos;ll post an update here and change the date at the top when this policy changes.</p>
        </LegalSection>
        <LegalSection heading="Contact">
          <p>Reach us at the address in the footer below.</p>
        </LegalSection>
      </LegalPage>
      <Footer />
    </>
  );
}
